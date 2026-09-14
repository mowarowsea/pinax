import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { checkOwned, getSeriesDetail, listSeries, type OwnQuery } from './catalog.js';
import { enrichSeries, fillMissingCovers, fillVolumeCovers } from './bib/enrich.js';
import { searchNdl } from './bib/ndl.js';
import { cachedFetch } from './bib/cache.js';
import { scanAll, scanRoot } from './scan/scanner.js';
import { openInExplorer, resolveInsideRoot, revealAbility } from './reveal.js';

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
      behind?: string; missing?: string; issues?: string;
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
      sort: (qs.sort as 'title' | 'author' | 'added' | 'volumes' | undefined) ?? 'title',
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

  // ---- 書誌・表紙 ---------------------------------------------------------

  app.post<{ Params: { id: string }; Body: { refresh?: boolean } }>('/api/series/:id/enrich', async (req) => {
    return enrichSeries(db, cfg, Number(req.params.id), { refresh: req.body?.refresh === true });
  });

  app.post<{ Body: { seriesLimit?: number } }>('/api/covers/fill', async (req) => {
    const results = await fillMissingCovers(db, cfg, { seriesLimit: req.body?.seriesLimit ?? 5 });
    return { results };
  });

  /**
   * 作品の中で抜けている巻の表紙を埋める。
   * `/api/covers/fill` が「表紙の無い作品」を見るのに対し、こちらは
   * **ISBN は分かっているのに表紙が無い巻**を見る (楽天の鍵が要る)。
   */
  app.post<{ Body: { limit?: number } }>('/api/covers/fill-volumes', async (req) => {
    return fillVolumeCovers(db, cfg, { limit: req.body?.limit ?? 20 });
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
    const allowed = ['https://ndlsearch.ndl.go.jp/', 'https://api.openbd.jp/'];
    if (!allowed.some((a) => url.startsWith(a))) {
      throw new HttpError(400, `この行き先は中継しません: ${url}`);
    }
    return cachedFetch(db, cfg, { provider: req.query.provider ?? 'proxy', url });
  });

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

  // ---- 画面 ---------------------------------------------------------------

  app.register(fastifyStatic, { root: path.resolve('public'), index: ['index.html'] });

  return app;
}
