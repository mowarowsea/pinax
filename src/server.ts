import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { checkOwned, getSeriesDetail, listSeries, type OwnQuery } from './catalog.js';
import { fillVolumeCovers } from './bib/enrich.js';
import { applyPick, coverSlotOf, searchCandidates, setVolumeCover } from './bib/pick.js';
import { slotKey, slotLabel } from './cover-slot.js';
import { cacheThumbnail, imageHostAllowed } from './bib/covers.js';
import type { CandidateProvider } from './bib/candidates.js';
import { searchNdl } from './bib/ndl.js';
import { cachedFetch } from './bib/cache.js';
import { scanAll, scanFolder, scanRoot, type ScanResult } from './scan/scanner.js';
import {
  ArchiveError,
  contentTypeOf,
  isReadableArchive,
  readPage,
  readPageIndex,
  type PageIndex,
} from './archive.js';
import { openInExplorer, resolveInsideRoot, revealAbility } from './reveal.js';
import { applyRename, planRename, RenameError } from './rename.js';
import { planSplit, SplitError } from './split.js';
import { SplitJobs } from './split-job.js';
import { planFolderName, planVolumeName } from './naming.js';
import { shelfBusy } from './lock.js';

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * HTTP の口。
 *
 * 認証は 2 段:
 *  - 画面と読み出しは素通し (LAN / Tailscale の中でしか開かない前提)
 *  - **他のサービスから叩く口 (`/api/own`) だけ共有トークンを要求する。**
 *    PowerDowner や DryEyes がここに「持ってる?」と聞きに来るので、
 *    誰でも蔵書の中身を列挙できる状態にはしない
 */
export function buildServer(db: Db, cfg: Config, opts: { onScan?: () => void } = {}): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  app.setErrorHandler((err: unknown, _req, reply) => {
    const status = err instanceof HttpError ? err.status : 500;
    reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
  });

  const requireToken = (req: { headers: Record<string, unknown> }): void => {
    if (!cfg.apiToken) return;
    const auth = String(req.headers.authorization ?? '');
    if (auth !== `Bearer ${cfg.apiToken}`) throw new HttpError(401, 'トークンが違います');
  };

  const rootById = (id: string): Config['roots'][number] => {
    const r = cfg.roots.find((x) => x.id === id);
    if (!r) throw new HttpError(404, `そんな蔵書ルートはありません: ${id}`);
    return r;
  };

  // ---- 死活監視 (LocalLauncher がここを見る) ------------------------------

  app.get('/api/health', async () => {
    const counts = db.raw
      .prepare(
        `SELECT (SELECT COUNT(*) FROM series WHERE present = 1) AS series,
                (SELECT COUNT(*) FROM volumes WHERE present = 1) AS volumes,
                (SELECT COUNT(*) FROM files WHERE present = 1) AS files,
                (SELECT COUNT(*) FROM covers) AS covers,
                (SELECT COUNT(*) FROM events WHERE read_at IS NULL) AS unread`
      )
      .get() as Record<string, number>;
    return {
      ok: true,
      name: 'pinax',
      roots: cfg.roots.map((r) => ({ id: r.id, label: r.label, kind: r.kind, path: r.path })),
      // エクスプローラを開けるか。**ここは pinax 自身の話** (Windows で動いているか) で、
      // 見ている端末が PC かどうかは画面側がメディアクエリで決める (reveal.ts の頭)
      reveal: revealAbility(),
      counts,
      lastScans: db.lastScans(cfg.roots.length || 1),
      cache: db.cacheStats(),
    };
  });

  // ---- 蔵書 ---------------------------------------------------------------

  app.get<{
    Querystring: {
      q?: string; gaps?: string; completed?: string; root?: string; needsCover?: string;
      behind?: string; missing?: string; issues?: string; care?: string;
      sort?: string; limit?: string; offset?: string;
    };
  }>('/api/series', async (req) => {
    const qs = req.query;
    const bool = (v: string | undefined): boolean | undefined =>
      v === undefined || v === '' ? undefined : v === '1' || v === 'true';
    return listSeries(db, {
      q: qs.q?.trim() || undefined,
      gapsOnly: bool(qs.gaps) ?? false,
      completed: bool(qs.completed),
      rootId: qs.root || undefined,
      needsCover: bool(qs.needsCover) ?? false,
      // 「続きが出ている」= 手元の最大巻より先が出ている。買い逃しに効くのはこちら
      behindOnly: bool(qs.behind) ?? false,
      missingOnly: bool(qs.missing) ?? false,
      // 棚の整合性 (巻の重複 / 巻数不明)。`1` は「どちらか」
      issues: qs.issues === 'dup' || qs.issues === 'loose'
        ? qs.issues
        : qs.issues === '1' || qs.issues === 'any' || qs.issues === 'true'
          ? 'any'
          : undefined,
      // 人が「ケアが必要」と印を付けたファイルを抱えている作品だけ
      care: bool(qs.care) ?? false,
      sort: (qs.sort as 'title' | 'author' | 'added' | 'volumes' | 'updated' | undefined) ?? 'title',
      limit: qs.limit ? Number(qs.limit) : undefined,
      offset: qs.offset ? Number(qs.offset) : undefined,
    });
  });

  app.get<{ Params: { id: string } }>('/api/series/:id', async (req) => {
    const detail = getSeriesDetail(db, Number(req.params.id));
    if (!detail) throw new HttpError(404, 'その作品はありません');
    return detail;
  });

  /**
   * 完結を人の手で決める。`completed: null` で指定を外し、フォルダの `(完)` に従う状態へ戻す。
   *
   * **フォルダ側は書き換えない。** 外の書誌から完結が分からないことは実測済み
   * (published.ts の頭) なので、ここは「人がそう言った」を記録する場所であって、
   * ファイル名を正とする土台を動かす場所ではない。
   */
  app.post<{ Params: { id: string }; Body: { completed?: boolean | null } }>(
    '/api/series/:id/completed',
    async (req) => {
      const id = Number(req.params.id);
      if (!db.getSeries(id)) throw new HttpError(404, 'その作品はありません');
      const v = req.body?.completed;
      if (v !== true && v !== false && v !== null && v !== undefined) {
        throw new HttpError(400, 'completed は true / false / null のどれかです');
      }
      const row = db.setCompletedOverride(id, v ?? null)!;
      return {
        ok: true,
        completed: row.completed,
        completedUser: row.completedUser,
        folderCompleted: row.folderCompleted,
        completedBy: row.completedBy,
      };
    }
  );

  /**
   * 作品フォルダの名前を付け替える。**pinax がファイルを書く数少ない場所** (rename.ts)。
   *
   * `apply` を付けない限り**計画を返すだけ**でファイルには触らない。画面は
   * 計画を見せて確かめてから `apply: true` で押し直す。注意書き (warnings) が
   * 立っている計画は `confirm: true` が無いと通らない — 巻数を読めなくなる
   * ファイルが出る付け替えを、黙って実行させないため。
   */
  app.post<{
    Params: { id: string };
    Body: { title?: string; author?: string | null; completed?: boolean; apply?: boolean; confirm?: boolean };
  }>('/api/series/:id/rename', async (req) => {
    const id = Number(req.params.id);
    const series = db.getSeries(id);
    if (!series) throw new HttpError(404, 'その作品はありません');
    const root = rootById(series.rootId);
    if (root.kind === 'inbox') throw new HttpError(400, '受け入れトレイの中は npm run inbox の仕事です');

    const body = req.body ?? {};
    if (typeof body.completed !== 'boolean') throw new HttpError(400, 'completed は true / false です');

    let plan;
    try {
      plan = planRename(db, root, id, {
        title: String(body.title ?? ''),
        author: body.author ?? null,
        completed: body.completed,
      });
    } catch (e) {
      throw e instanceof RenameError ? new HttpError(400, e.message) : e;
    }

    if (body.apply !== true) return { plan, applied: false };
    if (plan.warnings.length && body.confirm !== true) {
      throw new HttpError(409, plan.warnings.join(' / '));
    }

    try {
      const result = await applyRename(db, root, plan, cfg.dataDir);
      return { plan, applied: true, result, series: db.getSeries(id) };
    } catch (e) {
      throw e instanceof RenameError ? new HttpError(409, e.message) : e;
    }
  });

  /**
   * 作品のフォルダをエクスプローラで開く。開くのは **pinax が動いている PC** の側。
   * 見ている端末が PC かどうかは画面がメディアクエリで決める (reveal.ts の頭)。
   * `fileId` を添えるとそのファイルを選択した状態で開くので、
   * 重複や巻数不明のファイルをそのまま手で片付けられる。
   */
  app.post<{ Params: { id: string }; Body: { fileId?: number } }>('/api/series/:id/reveal', async (req) => {
    const can = revealAbility();
    if (!can.available) throw new HttpError(501, can.reason ?? 'この操作はできません');

    const id = Number(req.params.id);
    const series = db.getSeries(id);
    if (!series) throw new HttpError(404, 'その作品はありません');
    const root = rootById(series.rootId);

    const fileId = Number(req.body?.fileId ?? 0);
    if (fileId) {
      const f = db.raw
        .prepare('SELECT rel_path, series_id FROM files WHERE id = ?')
        .get(fileId) as { rel_path: string; series_id: number } | undefined;
      // 別の作品のファイル id を渡して棚の外を開かせない
      if (!f || Number(f.series_id) !== id) throw new HttpError(404, 'そのファイルはこの作品にありません');
      const abs = resolveInsideRoot(root.path, String(f.rel_path));
      if (!fs.existsSync(abs)) throw new HttpError(404, `実ファイルが見当たりません: ${f.rel_path}`);
      await openInExplorer(abs, { select: true });
      return { ok: true, opened: abs, selected: true };
    }

    const abs = resolveInsideRoot(root.path, series.folder);
    if (!fs.existsSync(abs)) throw new HttpError(404, `フォルダが見当たりません: ${series.folder}`);
    await openInExplorer(abs);
    return { ok: true, opened: abs, selected: false };
  });

  /**
   * **持っていない巻の一覧。** 棚をまたいで「次に何を探せばいいか」を出す。
   *
   * `ahead` (手元の最大巻より先) と `gap` (持っている範囲の中の穴) を分けて返す。
   * 前者は買い逃し、後者は取りこぼしで、対処が違う。
   */
  app.get<{ Querystring: { kind?: string; limit?: string } }>('/api/missing', async (req) => {
    const kind = req.query.kind === 'gap' ? 'gap' : req.query.kind === 'all' ? 'all' : 'ahead';
    const limit = Math.min(Number(req.query.limit ?? 200), 1000);
    const { items } = listSeries(db, { limit: 500 });

    const out = items
      .map((it) => {
        const gaps = it.holdings.find((h) => h.unit === '巻')?.missing ?? [];
        return {
          id: it.id,
          label: it.label,
          title: it.title,
          author: it.author,
          completed: it.completed,
          ownedMax: it.shelf.ownedMax,
          publishedMax: it.shelf.publishedMax,
          latestYear: it.shelf.latestYear,
          status: it.shelf.status,
          note: it.shelf.label,
          aheadCount: it.shelf.aheadCount,
          gapVolumes: gaps,
          coverUrl: it.coverUrl,
        };
      })
      .filter((x) => (kind === 'gap' ? x.gapVolumes.length > 0 : kind === 'ahead' ? x.aheadCount > 0 : x.gapVolumes.length > 0 || x.aheadCount > 0))
      .slice(0, limit);

    return { kind, count: out.length, items: out };
  });

  // ---- 所持の問い合わせ (PowerDowner / DryEyes 向け) ----------------------

  app.post<{ Body: { items?: OwnQuery[] } & OwnQuery }>('/api/own', async (req) => {
    requireToken(req as unknown as { headers: Record<string, unknown> });
    /**
     * **ファイルを動かしている最中は答えない。** フォルダの付け替えの途中は
     * ファイルが「消えた」に倒れて見える瞬間があり、そこで答えると
     * 持っている巻に「持っていない」と言ってしまう — その巻が落とし直される。
     * 503 なら向こうが後で聞き直せる (PowerDowner のリトライに乗る)。
     *
     * **スキャン中は答える。** スキャンは 1 トランザクションで書くので途中が見えない
     * (lock.ts)。3 時間ごとに 50 秒ずつ他のサービスを止める方が高くつく。
     */
    const busy = shelfBusy();
    if (busy) throw new HttpError(503, `棚を触っています (${busy})。後でもう一度聞いてください`);
    const body = req.body ?? {};
    const queries = Array.isArray(body.items) ? body.items : [body];
    if (!queries.length) throw new HttpError(400, 'items が空です');
    if (queries.length > 200) throw new HttpError(400, '一度に聞けるのは 200 件までです');
    return { answers: queries.map((q) => checkOwned(db, q)) };
  });

  // ---- お知らせ -----------------------------------------------------------

  app.get<{ Querystring: { unread?: string; limit?: string } }>('/api/events', async (req) => {
    return {
      events: db.listEvents({
        unreadOnly: req.query.unread === '1',
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    };
  });

  app.post<{ Body: { ids?: number[] } }>('/api/events/read', async (req) => {
    const ids = (req.body?.ids ?? []).map(Number).filter(Number.isInteger);
    db.markEventsRead(ids);
    return { ok: true, marked: ids.length };
  });

  // ---- スキャン -----------------------------------------------------------

  app.post<{ Body: { root?: string } }>('/api/scan', async (req) => {
    const rootId = req.body?.root;
    const results = rootId ? [await scanRoot(db, rootById(rootId))] : await scanAll(db, cfg.roots);
    opts.onScan?.();
    return { results };
  });

  /**
   * **その作品のフォルダだけ**読み直す。合本を割った直後のように、今さわった 1 作品を
   * すぐ棚へ載せ直したい時の道 (全根スキャンは NAS だと数十秒かかる)。
   *
   * 歩く場所は**持っているファイルから引く** — `series.folder` は親フォルダの名前だけで、
   * 根からの道ではない。根直置きの作品はフォルダに絞れないので断る。
   */
  app.post<{ Params: { id: string } }>('/api/series/:id/rescan', async (req) => {
    const id = Number(req.params.id);
    const series = db.getSeries(id);
    if (!series) throw new HttpError(404, 'そんな作品はありません');
    const root = rootById(series.rootId);

    const dirs = db.seriesDirs(id);
    if (!dirs.length) throw new HttpError(409, '棚にファイルが残っていません。棚ごと読み直してください');
    if (dirs.includes('.')) throw new HttpError(409, 'ルート直置きの作品です。棚ごと読み直してください');

    const results: ScanResult[] = [];
    for (const dir of dirs) results.push(await scanFolder(db, root, dir));
    opts.onScan?.();
    return { results };
  });

  // ---- 書誌・表紙 ---------------------------------------------------------

  /**
   * 作品の中で抜けている巻の表紙を埋める。
   * 巡回の fillMissingCovers が「表紙の無い作品」を見るのに対し、こちらは
   * **ISBN は分かっているのに表紙が無い巻**を見る (楽天の鍵が要る)。
   */
  app.post<{ Body: { limit?: number } }>('/api/covers/fill-volumes', async (req) => {
    return fillVolumeCovers(db, cfg, { limit: req.body?.limit ?? 20 });
  });

  // ---- 表紙を人が選ぶ -----------------------------------------------------

  /**
   * 書影の候補を外に聞いて、**シリーズの束**にまとめて返す。
   *
   * 検索語は既定で蔵書の作品名と著者だが、人が打ち直せる。
   * 血界戦線のように並走するシリーズがある作品では、どの束が手元の棚なのかは
   * 機械には分からない (bib/candidates.ts の頭) ので、ここは**見せるだけ**にして
   * 決めるのは /cover-pick に渡す。
   */
  app.get<{
    Params: { id: string };
    Querystring: { q?: string; author?: string; provider?: string; refresh?: string };
  }>('/api/series/:id/cover-search', async (req) => {
    const id = Number(req.params.id);
    const series = db.getSeries(id);
    if (!series) throw new HttpError(404, 'その作品はありません');

    const p = req.query.provider;
    const provider: CandidateProvider | 'all' =
      p === 'ndl' || p === 'rakuten' || p === 'google' ? p : 'all';
    // **空文字は「その欄なし」として通す。** 書名を消して著者だけで引きたい時も、
    // 著者を消して書名だけで引きたい時もあるので、未指定 (undefined) と区別する。
    // 未指定の時だけ棚の値を当てる
    const title = req.query.q === undefined ? series.title : req.query.q.trim();
    const author = req.query.author === undefined ? series.author : req.query.author.trim() || null;
    if (!title && !author) throw new HttpError(400, '作品名か著者のどちらかを入れてください');

    const found = await searchCandidates(db, cfg, {
      title,
      author,
      provider,
      refresh: req.query.refresh === '1',
    });
    return { ...found, pick: db.getSeriesPick(id) };
  });

  /**
   * 「これ！」を記録して、書誌と表紙をその束で貼り直す。
   *
   * 記録は `series_pick` に残り、**次からの自動の取り直しもこの束だけを見る**
   * (bib/enrich.ts の頭)。人が下した判断を機械が黙って覆さない、という点で
   * 完結の指定 (`completed_user`) と同じ扱い。
   */
  app.post<{
    Params: { id: string };
    Body: {
      scope?: string; groupKey?: string; title?: string; author?: string | null;
      queryTitle?: string; queryAuthor?: string | null;
    };
  }>('/api/series/:id/cover-pick', async (req) => {
    const id = Number(req.params.id);
    const series = db.getSeries(id);
    if (!series) throw new HttpError(404, 'その作品はありません');

    const scope = req.body?.scope ?? 'all';
    if (scope !== 'all' && scope !== 'ndl' && scope !== 'rakuten' && scope !== 'google') {
      throw new HttpError(400, 'scope は all / ndl / rakuten / google のどれかです');
    }
    const groupKey = String(req.body?.groupKey ?? '').trim();
    if (!groupKey) throw new HttpError(400, 'groupKey が要ります');

    const pick = db.setSeriesPick({
      seriesId: id,
      scope,
      groupKey,
      title: String(req.body?.title ?? '').trim() || series.title,
      // 束の著者。**棚の著者では埋めない** — 空で残しておけば「選んだ時には
      // 分からなかった」と分かるが、棚の値を写すと、間違っている棚の著者が
      // 「選んだシリーズの著者」の顔をして名前を直す欄の既定値に出る
      author: String(req.body?.author ?? '').trim() || null,
      // 選んだ時の検索語をそのまま残す。作品名から組み立て直すと、
      // 人が打ち直した検索語で当てた束を次から引けなくなる
      queryTitle: String(req.body?.queryTitle ?? '').trim() || series.title,
      queryAuthor: req.body?.queryAuthor === undefined ? series.author : (req.body.queryAuthor || null),
    });

    const result = await applyPick(db, cfg, id, { pick });
    // 貼り直せなかったら指定も残さない。**「選んだのに何も起きない」状態を作らない**
    if (result.error) {
      db.clearSeriesPick(id);
      throw new HttpError(502, result.error);
    }
    return { ok: true, pick, result };
  });

  /** 指定を外して自動へ戻す。**表紙は消さない** — 次の取り直しで貼り替わる */
  app.delete<{ Params: { id: string } }>('/api/series/:id/cover-pick', async (req) => {
    const id = Number(req.params.id);
    if (!db.getSeries(id)) throw new HttpError(404, 'その作品はありません');
    db.clearSeriesPick(id);
    return { ok: true };
  });

  /**
   * 板 1 枚の絵だけを人の指定で差し替える。**単巻も合本も別巻も代表も同じ口。**
   * 焼いた行に印が立ち、**自動の巡回では二度と上書きされない**。
   *
   * 宛先の渡し方は 2 通りで、**どちらか一方だけ**を送る:
   *
   *   slot   … 棚の板を押して来た時。詳細が返した宛先をそのまま送り返す
   *   volume … 候補の一覧から直接貼る時 (数字なら第n巻、null なら代表表紙)
   *
   * 候補の側に宛先を組み立てさせないのは、**綴り方を画面にも持たせないため**
   * (bib/pick.ts の coverSlotOf)。
   */
  app.post<{
    Params: { id: string };
    Body: {
      slot?: string | null; volume?: number | null;
      provider?: string; imageUrl?: string; isbn?: string | null;
    };
  }>('/api/series/:id/cover', async (req) => {
    const id = Number(req.params.id);
    if (!db.getSeries(id)) throw new HttpError(404, 'その作品はありません');
    const imageUrl = String(req.body?.imageUrl ?? '').trim();
    if (!imageUrl) throw new HttpError(400, 'imageUrl が要ります');

    let slot;
    try {
      slot = coverSlotOf({ slot: req.body?.slot, volume: req.body?.volume });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }

    try {
      await setVolumeCover(db, cfg, {
        seriesId: id,
        slot,
        provider: String(req.body?.provider ?? 'manual'),
        imageUrl,
        isbn: req.body?.isbn ?? null,
      });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    return { ok: true, slot: slotKey(slot), label: slotLabel(slot) };
  });

  /**
   * 候補の**下見**の画像を中継する。
   *
   * ブラウザから直接は引けない — NDL のサムネイルは Referer を見て弾くが、
   * Referer はブラウザが決めるヘッダなので画面側からは名乗れない (bib/covers.ts)。
   * 行き先は許した書影の置き場だけ。任意の URL を取りに行く踏み台にはしない。
   */
  app.get<{ Querystring: { u?: string } }>('/api/bib/thumb', async (req, reply) => {
    const url = req.query.u;
    if (!url) throw new HttpError(400, 'u が要ります');
    // **弾いた理由を「書影がありません」に混ぜない。** 行き先を許していないのと
    // 相手が画像を持っていないのとでは、直しに行く先が違う
    if (!imageHostAllowed(url)) throw new HttpError(400, `この行き先からは取りません: ${url}`);
    let got;
    try {
      got = await cacheThumbnail(cfg, url);
    } catch (e) {
      throw new HttpError(502, (e as Error).message);
    }
    if (!got) throw new HttpError(404, '書影がありません');
    // 名前が URL のハッシュなので中身は変わりうる。1 日だけ持たせる
    reply.header('Cache-Control', 'public, max-age=86400');
    reply.type(got.contentType);
    return fs.createReadStream(got.abs);
  });

  app.get<{ Params: { id: string } }>('/api/covers/:id', async (req, reply) => {
    const row = db.raw
      .prepare('SELECT file, content_type FROM covers WHERE id = ?')
      .get(Number(req.params.id)) as { file: string; content_type: string | null } | undefined;
    if (!row) throw new HttpError(404, 'その表紙はありません');
    const abs = path.join(cfg.dataDir, 'covers', row.file);
    if (!fs.existsSync(abs)) throw new HttpError(404, '焼いた画像が見当たりません');
    // 焼いた画像は内容が変わらない (名前が中身のハッシュ) ので、長く持たせてよい
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.type(row.content_type ?? 'image/jpeg');
    return fs.createReadStream(abs);
  });

  /**
   * 書影選びと同じ検索を、**どの作品にも紐付けずに**開く。
   *
   * 棚にまだ無い作品の正しい書名と著者を知るための口。
   * `/api/series/:id/cover-search` との違いは、既定値に使う棚の作品が無いことだけ。
   */
  app.get<{
    Querystring: { q?: string; author?: string; provider?: string; refresh?: string };
  }>('/api/bib/candidates', async (req) => {
    const p = req.query.provider;
    const provider: CandidateProvider | 'all' =
      p === 'ndl' || p === 'rakuten' || p === 'google' ? p : 'all';
    const title = (req.query.q ?? '').trim();
    const author = (req.query.author ?? '').trim() || null;
    if (!title && !author) throw new HttpError(400, '作品名か著者のどちらかを入れてください');
    const found = await searchCandidates(db, cfg, { title, author, provider, refresh: req.query.refresh === '1' });
    // **名前は画面で組み立てない。** 使えない文字の倒し方も長い名前の詰め方も
    // naming.ts が持っていて、画面へ写した瞬間に書く側と読む側が別々の決まりを持ち始める。
    //
    // 返すのは**第01巻の 1 本だけ。** フォルダ名は末尾の「 第01巻」を削れば作れるし、
    // 第02巻から先は数字を打ち替えれば済む。全巻ぶん並べても人はどれか 1 本しか見ない。
    return {
      ...found,
      groups: found.groups.map((g) => ({
        ...g,
        name: planVolumeName(g.authorName ?? g.author, g.title, 1, 1, { unit: '巻' }),
      })),
    };
  });

  // ---- これから付ける名前 -------------------------------------------------

  /**
   * 棚の決まりどおりのフォルダ名とファイル名を組み立てて返す。**棚を見ない。**
   *
   * 手元にあるのに棚へ出てこないファイル — 名前が決まりから外れていて拾えない
   * ものを、人が付け替えるための紙。拾えないから棚からは直せず (あちらは
   * `/api/series/:id/rename`、既にある作品を動かす口)、直せないから拾えない、
   * という堂々巡りを切る。
   *
   * **名前を出すだけで、ファイルには一切触らない。**
   */
  app.get<{
    Querystring: {
      title?: string; author?: string; completed?: string;
      from?: string; to?: string; last?: string; unit?: string;
    };
  }>('/api/names', async (req) => {
    const title = (req.query.title ?? '').trim();
    if (!title) throw new HttpError(400, '作品名が要ります');
    const author = (req.query.author ?? '').trim() || null;
    const unit = req.query.unit === '話' ? '話' : '巻';

    const num = (v: string | undefined, fallback: number): number => {
      if (v === undefined || v.trim() === '') return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 9999) throw new HttpError(400, `巻数がおかしい: ${v}`);
      return n;
    };
    const from = num(req.query.from, 1);
    const to = Math.max(num(req.query.to, from), from);
    // 最終巻の印は**その巻だけ**に付く。手元に最後まで揃っていない作品でも
    // フォルダには (完) が付く (棚の実物がそうなっている) ので、指定は別々に取る
    const last = req.query.last === undefined || req.query.last.trim() === ''
      ? null
      : num(req.query.last, 0);

    // 出す本数に上限を置く。こち亀 (201 巻) が入る程度で足りる
    const MAX = 300;
    const count = to - from + 1;
    const stop = count > MAX ? from + MAX - 1 : to;

    const volumes = [];
    for (let v = from; v <= stop; v++) {
      const name = planVolumeName(author, title, v, v, { unit, completed: v === last });
      if (!name) throw new HttpError(400, 'その作品名では名前を作れません');
      volumes.push({ from: v, to: v, label: `第${String(v).padStart(2, '0')}${unit}`, name });
    }

    const notes: string[] = [];
    if (count > MAX) notes.push(`${MAX} 冊までにしました (${count} 冊ぶん指定されています)`);
    // **並びの外の (完) は黙って落とさない。** 別の作品から欄を引き継いだ時に、
    // どの巻にも印が付かない理由が画面から読めなくなる
    if (last !== null && (last < from || last > stop)) {
      notes.push(`(完) を付ける巻 (第${last}${unit}) が並びの外なので、どれにも付けていません`);
    }

    return {
      folder: planFolderName(author, title, req.query.completed === '1'),
      volumes,
      note: notes.length ? notes.join(' / ') : null,
    };
  });

  /**
   * 汎用キャッシュプロキシの窓口。外部 API の応答をそのまま返す。
   * 他のサービスが「表記ゆれを含む作品名の候補」を欲しがる時にここを叩く。
   */
  app.get<{ Querystring: { title?: string; author?: string; refresh?: string } }>('/api/bib/search', async (req) => {
    const title = req.query.title?.trim();
    if (!title) throw new HttpError(400, 'title が要ります');
    const found = await searchNdl(db, cfg, {
      title,
      creator: req.query.author ?? null,
      refresh: req.query.refresh === '1',
    });
    return found;
  });

  app.get<{ Querystring: { url?: string; provider?: string } }>('/api/bib/proxy', async (req) => {
    requireToken(req as unknown as { headers: Record<string, unknown> });
    const url = req.query.url;
    if (!url) throw new HttpError(400, 'url が要ります');
    // 行き先は設定で許した提供元だけ。任意の URL を中継する踏み台にしない
    const allowed = [
      'https://ndlsearch.ndl.go.jp/',
      'https://api.openbd.jp/',
      'https://www.googleapis.com/books/',
    ];
    if (!allowed.some((a) => url.startsWith(a))) {
      throw new HttpError(400, `この行き先は中継しません: ${url}`);
    }
    return cachedFetch(db, cfg, { provider: req.query.provider ?? 'proxy', url });
  });

  // ---- ケアが必要 ---------------------------------------------------------

  /**
   * 「ケアが必要」の印を立てる / 外す。**ファイル 1 本ずつが単位** — 壊れているのも
   * スキャンがひどいのも書庫 1 本の話で、巻や作品にまとめると直しようが無くなる。
   *
   * `note` を省いた呼びではメモに触らない (印だけの付け外し)。メモだけ書き直したい時は
   * `care` を今の値のまま添えて投げる。**外してもメモは消さない** (db.setCare の註)。
   */
  /**
   * 今の印を聞く。**読む画面が直接開かれた時のため** (`#/read/5`) — 作品の板を
   * 通っていないと、画面は印が立っているかどうかを知らないまま帯のボタンを描くことになる
   */
  app.get<{ Params: { id: string } }>('/api/files/:id/care', async (req) => {
    const row = db.getCare(Number(req.params.id));
    if (!row) throw new HttpError(404, 'そのファイルはありません');
    return row;
  });

  app.post<{ Params: { id: string }; Body: { care?: boolean; note?: string | null } }>(
    '/api/files/:id/care',
    async (req) => {
      const id = Number(req.params.id);
      if (!db.getCare(id)) throw new HttpError(404, 'そのファイルはありません');
      const v = req.body?.care;
      if (typeof v !== 'boolean') throw new HttpError(400, 'care は true / false です');
      const note = req.body && 'note' in req.body ? (req.body.note ?? null) : undefined;
      return { ok: true, ...db.setCare(id, v, note)! };
    }
  );

  // ---- ダウンロード -------------------------------------------------------

  app.get<{ Params: { id: string } }>('/api/files/:id/download', async (req, reply) => {
    const row = db.raw
      .prepare('SELECT * FROM files WHERE id = ?')
      .get(Number(req.params.id)) as Record<string, unknown> | undefined;
    if (!row) throw new HttpError(404, 'そのファイルはありません');

    const root = rootById(String(row.root_id));
    const rel = String(row.rel_path);

    // 相対パスが根の外を指していないか必ず確かめる。DB の値でも信用しない
    const abs = path.resolve(root.path, rel);
    const base = path.resolve(root.path);
    if (!abs.startsWith(base + path.sep)) throw new HttpError(400, '蔵書の外を指しています');

    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      throw new HttpError(404, `実ファイルが見当たりません: ${rel}`);
    }

    const name = path.basename(rel);
    reply.header('Content-Type', 'application/octet-stream');
    // 日本語のファイル名は RFC 5987 で渡す。ASCII 版も残さないと古い相手が名前を落とす
    reply.header(
      'Content-Disposition',
      `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`
    );

    /**
     * 途中から落とせるようにする。1 冊が 100MB を超えることは普通にあり、
     * Tailscale 越しに落としている最中に切れた時、頭からやり直しになると実用にならない。
     */
    reply.header('Accept-Ranges', 'bytes');
    const range = String(req.headers.range ?? '');
    const m = range.match(/^bytes=(\d*)-(\d*)$/);
    if (m && stat.size > 0) {
      const startRaw = m[1];
      const endRaw = m[2];
      // `bytes=-500` は末尾 500 バイト。`bytes=100-` は 100 から最後まで
      const start = startRaw === '' ? Math.max(0, stat.size - Number(endRaw)) : Number(startRaw);
      const end = startRaw === '' || endRaw === '' ? stat.size - 1 : Math.min(Number(endRaw), stat.size - 1);

      if (!Number.isFinite(start) || start > end || start >= stat.size) {
        reply.code(416).header('Content-Range', `bytes */${stat.size}`);
        return reply.send();
      }
      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      reply.header('Content-Length', String(end - start + 1));
      return fs.createReadStream(abs, { start, end });
    }

    reply.header('Content-Length', String(stat.size));
    return fs.createReadStream(abs);
  });

  // ---- 書庫の中を読む -----------------------------------------------------

  /**
   * ページを取り出すのに 1 か所だけ書き込みが要る (unrar がファイルへしか出せない)。
   * **書き先は必ず棚の外。** `data/` の下に置いて、組み立てる時に一度確かめておく。
   * ここを間違えると漫画ファイルの隣に書きに行くことになる。
   */
  const pageTmp = path.join(cfg.dataDir, 'pages');
  fs.mkdirSync(pageTmp, { recursive: true });
  for (const r of cfg.roots) {
    const base = path.resolve(r.path);
    if (path.resolve(pageTmp) === base || path.resolve(pageTmp).startsWith(base + path.sep)) {
      throw new Error(`ページの取り出し先が蔵書の中にあります: ${pageTmp}`);
    }
  }

  const fileAt = async (id: string): Promise<{ row: Record<string, unknown>; abs: string; stat: fs.Stats }> => {
    const row = db.raw.prepare('SELECT * FROM files WHERE id = ?').get(Number(id)) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new HttpError(404, 'そのファイルはありません');
    const root = rootById(String(row.root_id));
    let abs: string;
    try {
      abs = resolveInsideRoot(root.path, String(row.rel_path));
    } catch {
      throw new HttpError(400, '蔵書の外を指しています');
    }
    try {
      return { row, abs, stat: await fsp.stat(abs) };
    } catch {
      throw new HttpError(404, `実ファイルが見当たりません: ${String(row.rel_path)}`);
    }
  };

  /**
   * 書庫の索引を作るのは**一度に 1 冊だけ**にする。
   *
   * rar の一覧は SMB 越しにヘッダを追うので 1 冊 1 秒前後 (実測の中央値 1.3 秒、
   * 大きいもので 20 秒超) かかり、その間 wasm の同期読みでイベントループが止まる。
   * 何冊も同時に開かれると止まる時間が足し算になり、`/api/health` が返らなくなって
   * LocalLauncher に死んだと見なされる (docs/ARCHITECTURE.md 8.4 と同じ筋の話)。
   *
   * **一度作れば覚えるので、待つのは初回だけ。** 読む口が本式になったら
   * ここはワーカースレッドへ出す。今は直列にして被害を足し算にしないだけ。
   */
  let indexChain: Promise<unknown> = Promise.resolve();
  const inFlight = new Map<number, Promise<PageIndex>>();

  const pageIndexOf = async (
    id: string,
    opts: { refresh?: boolean } = {}
  ): Promise<{ fileId: number; row: Record<string, unknown>; abs: string; index: PageIndex; buildMs: number; cached: boolean }> => {
    const { row, abs, stat } = await fileAt(id);
    const fileId = Number(row.id);
    const ext = path.extname(abs).toLowerCase();
    if (!isReadableArchive(ext)) {
      throw new HttpError(415, `${ext || 'この形式'} は開けません (zip と rar だけです)`);
    }
    const mtime = stat.mtime.toISOString();

    if (!opts.refresh) {
      const hit = db.getPageIndex(fileId, stat.size, mtime);
      if (hit) return { fileId, row, abs, index: hit, buildMs: 0, cached: true };
    }

    const running = inFlight.get(fileId);
    if (running) {
      const index = await running;
      return { fileId, row, abs, index, buildMs: 0, cached: true };
    }

    const job = indexChain.then(async () => {
      const t0 = Date.now();
      let index: PageIndex;
      try {
        index = await readPageIndex(abs, pageTmp);
      } catch (e) {
        if (e instanceof ArchiveError) throw new HttpError(422, e.reason);
        throw new HttpError(422, `書庫を開けませんでした: ${e instanceof Error ? e.message : String(e)}`);
      }
      const buildMs = Date.now() - t0;
      db.putPageIndex({ fileId, size: stat.size, mtime, index, buildMs });
      return { index, buildMs };
    });
    indexChain = job.catch(() => undefined);
    inFlight.set(
      fileId,
      job.then((r) => r.index)
    );
    try {
      const { index, buildMs } = await job;
      return { fileId, row, abs, index, buildMs, cached: false };
    } finally {
      inFlight.delete(fileId);
    }
  };

  /**
   * 1 冊の中に何ページあって、どういう順に並んでいるか。
   *
   * **絵は返さない。** ここで返すのは名前と大きさだけで、実物は 1 枚ずつ
   * `/api/files/:id/page/:i` から取る。索引と実物を分けるのは、索引が
   * 1 冊 1 回で済むのに対し実物は 200 回要るため。
   */
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    '/api/files/:id/pages',
    async (req) => {
      const got = await pageIndexOf(req.params.id, { refresh: req.query.refresh === '1' });
      return {
        fileId: got.fileId,
        name: path.basename(String(got.row.rel_path)),
        format: got.index.format,
        count: got.index.pages.length,
        pages: got.index.pages.map((p, i) => ({ i, name: p.name, bytes: p.bytes })),
        // 画像でなかった中身。0 ページだった時に理由が画面から読めるように残す
        skipped: got.index.skipped,
        nested: got.index.nested,
        buildMs: got.buildMs,
        cached: got.cached,
      };
    }
  );

  /**
   * ページ 1 枚。
   *
   * **番号で指す。** 名前で指させると、書庫の中の名前がそのまま URL に出て、
   * 中身の名前を打ち替えただけで壊れる。並びは索引が決めたものが正。
   */
  app.get<{ Params: { id: string; i: string } }>('/api/files/:id/page/:i', async (req, reply) => {
    const got = await pageIndexOf(req.params.id);
    const i = Number(req.params.i);
    const page = Number.isInteger(i) ? got.index.pages[i] : undefined;
    if (!page) throw new HttpError(404, `そのページはありません: ${req.params.i}`);

    /**
     * **同じ絵は二度取りに来させない。** 1 ページ 350KB 前後 (中央値) で
     * 1 冊 190 ページ前後あるので、行きつ戻りつするだけで軽く数十 MB になる。
     * 中身が変われば mtime が動いて索引ごと作り直されるので、印は強く付けてよい。
     */
    const tag = `"${String(got.row.size)}-${String(got.row.mtime)}-${i}"`;
    if (String(req.headers['if-none-match'] ?? '') === tag) return reply.code(304).send();

    let buf: Buffer;
    try {
      buf = await readPage(got.abs, page.name, pageTmp);
    } catch (e) {
      if (e instanceof ArchiveError) throw new HttpError(422, e.reason);
      throw e;
    }
    reply.header('Content-Type', contentTypeOf(page.name));
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    reply.header('ETag', tag);
    reply.header('Content-Length', String(buf.length));
    return reply.send(buf);
  });


  // ---- 合本を分割する -----------------------------------------------------

  /**
   * 合本 (第01-02巻) を巻ごとのファイルに分ける。
   *
   * **下見と実行を分ける。** 中がどう並んでいるかは開けてみないと分からず、
   * 分割できない合本 (ページがベタ連番) が必ず混ざる。押した瞬間に走り出す作りだと、
   * 「押したのに何も起きない」としか画面から読めない。
   *
   * 実行は**子プロセスに出す** (split-job.ts)。rar の取り出しは同期呼び出しで
   * イベントループを止めるので、ここでやると `/api/health` が返らなくなる。
   */
  const splits = new SplitJobs();

  const splitFail = (e: unknown): never => {
    if (e instanceof SplitError) throw new HttpError(422, e.message);
    if (e instanceof ArchiveError) throw new HttpError(422, e.reason);
    throw e;
  };

  app.get<{ Params: { id: string } }>('/api/files/:id/split', async (req) => {
    try {
      return await planSplit(db, cfg, Number(req.params.id));
    } catch (e) {
      return splitFail(e);
    }
  });

  app.post<{ Params: { id: string } }>('/api/files/:id/split', async (req) => {
    const id = Number(req.params.id);
    // 分割は棚を書き換える。走っている間に別の分割やスキャンと噛み合わせない
    if (splits.busy) throw new HttpError(409, '別の分割が走っています');

    // 始める前にもう一度下見する。**分割できないものに子を起こさない**
    let plan;
    try {
      plan = await planSplit(db, cfg, id);
    } catch (e) {
      return splitFail(e);
    }
    if (!plan.ok) throw new HttpError(422, plan.reason ?? '分割できません');

    return { ok: true, job: splits.start(id), plan };
  });

  app.get<{ Params: { id: string } }>('/api/files/:id/split/status', async (req) => {
    const job = splits.get(Number(req.params.id));
    if (!job) throw new HttpError(404, 'その分割は走っていません');
    return job;
  });

  // ---- 画面 ---------------------------------------------------------------

  app.register(fastifyStatic, { root: path.resolve('public'), index: ['index.html'] });

  return app;
}
