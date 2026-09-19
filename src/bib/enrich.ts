import type { Config } from '../config.js';
import { SERIES_SLOT, volumeSlot } from '../cover-slot.js';
import type { Db } from '../db.js';
import { ProviderStopError } from './cache.js';
import { fetchCover, refreshSeriesCover } from './covers.js';
import { googleReady } from './google.js';
import { byVolume, searchNdl } from './ndl.js';
import { openbdReady } from './openbd.js';
import {
  bibOfNdl, ndlCandidates, pasteCovers, sideCoverTargets, writeBib, type CoverTarget,
} from './paste.js';
import { applyPick } from './pick.js';
import { rakutenReady } from './rakuten.js';

/**
 * 蔵書の 1 作品に、外から取った書誌と書影を貼る。
 *
 * 経路は 1 本だけ (2026-09-12 に実測して決めた。docs/ARCHITECTURE.md 5 章):
 *
 *   [著者] 作品名 ──▶ NDLサーチ (title + creator) ──▶ 巻ごとの ISBN
 *                 ──▶ NDL サムネイル /thumbnail/{ISBN}.jpg ──▶ ローカルへ焼く
 *
 * 書影は **NDL → 楽天 → openBD → Google Books** の順に試す (bib/covers.ts の fetchCover)。
 * NDL のサムネイルは ISBN のうち半分ほどしか画像を持っておらず、手元では
 * **ISBN は分かっているのに表紙が無い巻が 2703 件**残っていた。そこを楽天が
 * ISBN 直引きで埋める。**書誌は NDL のまま**で、後ろの 3 つには表紙だけ任せる —
 * 巻の区切りは NDL の `dcndl:volume` の方が素直に取れるため。
 * (楽天は書名に「日常（十二）」のように漢数字で巻を書くので、そこを読むのは分が悪い)
 *
 * openBD と Google Books は**楽天でも埋まらなかった巻の受け皿**。実測 (2026-09-15、
 * 手元で表紙の無い巻の ISBN で数えた) では openBD が 0/200、Google が ISBN 直引きで
 * 14/100。Google は**書名で引くと電子版の書影**が出てくるので、そちらが本命
 * (bib/google.ts / bib/openbd.ts の頭)。
 *
 * 焼いた画像は二度と外に聞かない。外部サービスが消えてもカタログは残る。
 */

export interface EnrichResult {
  seriesId: number;
  label: string;
  /** NDL が返した巻の数 */
  recordCount: number;
  /** 外の書誌が知っている一番大きい巻。**下限**であって「全何巻」ではない */
  publishedMax: number | null;
  bibWritten: number;
  coversWritten: number;
  /** 表紙を取れなかった板の名前 (`第03巻` / `外伝`) */
  coverMissed: string[];
  cached: boolean;
  stale: boolean;
  /** 人が選んだシリーズを使った時、その書名。null なら書名と著者から自動で当てた */
  picked: string | null;
  /**
   * **回しても無駄なので打ち切ったか** (`ProviderStopError` — 鍵の間違い、接続元 IP、1 日の上限)。
   *
   * `error` の文字を読んで判定してはいけない — 提供元が増えるたびに
   * 「どの言葉が入っていたら止めるか」を書き足すことになり、書き忘れた相手の分だけ
   * 静かに空振りし続ける。**止める理由そのものを持たせる。**
   */
  stopped: boolean;
  error: string | null;
}

export interface EnrichOptions {
  /** キャッシュを無視して外に聞き直す */
  refresh?: boolean;
  /** 1 作品あたり取りに行く表紙の上限。0 なら書誌だけ */
  coverBudget?: number;
}

/**
 * 作品 1 つを埋める。
 *
 * 表紙は**持っている巻の分だけ**取りに行く。持っていない巻の表紙を並べると
 * 「持っている」の意味が濁るし、無駄に外を叩くことになる。
 * 作品の代表表紙は、持っている中で一番若い巻のものを使う。
 */
export async function enrichSeries(db: Db, cfg: Config, seriesId: number, opts: EnrichOptions = {}): Promise<EnrichResult> {
  const s = db.getSeries(seriesId);
  const label = s ? `${s.author ? `[${s.author}] ` : ''}${s.title}` : `#${seriesId}`;
  const out: EnrichResult = {
    seriesId, label, recordCount: 0, publishedMax: null, bibWritten: 0, coversWritten: 0,
    coverMissed: [], cached: false, stale: false, picked: null, stopped: false, error: null,
  };
  if (!s) return { ...out, error: '作品がありません' };

  /**
   * **人がシリーズを選んでいたら、書名から当て直さない。**
   *
   * 血界戦線のように同じ書名で別のシリーズが並走している作品では、
   * ここで自動の道へ入った瞬間に取り違えが戻る (bib/candidates.ts の頭)。
   * 完結の `completed_user` と同じで、一度下した人の判断を機械が黙って覆さない。
   */
  const pick = db.getSeriesPick(seriesId);
  if (pick) {
    const r = await applyPick(db, cfg, seriesId, { pick, coverBudget: opts.coverBudget, refresh: opts.refresh });
    return {
      ...out,
      recordCount: r.recordCount, publishedMax: r.publishedMax, bibWritten: r.bibWritten,
      coversWritten: r.coversWritten, coverMissed: r.coverMissed, picked: r.title,
      stopped: r.stopped, error: r.error,
    };
  }

  // 外へ聞きに行った印は**先に**押す。表紙の取れない作品を巡回が何度も選び直して
  // 後ろの作品まで進まなくなるのを防ぐ (db.ts の enriched_at)
  db.markEnriched(seriesId);

  let found;
  try {
    found = await searchNdl(db, cfg, { title: s.title, creator: s.author, refresh: opts.refresh });
  } catch (e) {
    return { ...out, error: (e as Error).message };
  }
  out.recordCount = found.records.length;
  out.cached = found.cached;
  out.stale = found.stale;

  const byVol = byVolume(found.records, s.title);

  // 作品そのものの書誌 (巻なし)。単巻の作品はここにしか載らない
  const seriesRecord = found.records.find((r) => r.volume === null && r.isbn) ?? found.records[0];
  if (seriesRecord) {
    writeBib(db, seriesId, null, bibOfNdl(seriesRecord));
    out.bibWritten++;
  }

  /**
   * **持っていない巻の書誌も落とさずに書く。**
   *
   * ここを「持っている巻だけ」にしていると、外が知っている巻の一覧が手元に残らず、
   * 「トライガンは 14 巻まで出ているのに 3 巻しか持っていない」が永久に言えない。
   * NDL への問い合わせは既に済んでいて答えは手元にあるのだから、捨てる理由がない。
   *
   * 表紙は**持っている巻の分しか取りに行かない** (下のループ)。
   * 持っていない巻の表紙まで焼くと「持っている」の意味が濁るし、無駄に外を叩く。
   */
  for (const [vol, rec] of byVol) {
    writeBib(db, seriesId, vol, bibOfNdl(rec));
    out.bibWritten++;
  }
  out.publishedMax = byVol.size ? Math.max(...byVol.keys()) : null;

  /**
   * 絵を貼る板を並べる。**持っている単巻と、持っている別巻。**
   *
   * 合本 (第01-02巻) はここに入れない — 覆う巻の絵を借りて出す作りなので
   * (catalog.ts の coverFor)、板として別に取りに行くと同じ絵を二度焼くことになる。
   * 合本じしんの絵は人が「サムネ変更」で選んだ時にだけ載る。
   *
   * 別巻は NDL の答えを候補の形へ揃えてから突き合わせる。`鬼滅の刃外伝` のように
   * **作品名を前置きにした書名**で返ってくるので、棚のファイル名と同じ規則で
   * 呼び名を剥がせば繋がる (paste.ts の sideLabelOfTitle)。
   */
  const targets: CoverTarget[] = db.ownedVolumeNumbers(seriesId).map((vol) => {
    const rec = byVol.get(vol);
    return {
      slot: volumeSlot(vol),
      source: rec?.isbn ? { images: [], isbn: rec.isbn } : null,
    };
  });
  targets.push(...sideCoverTargets(db, seriesId, s.title, ndlCandidates(found.records)));

  const pasted = await pasteCovers(db, cfg, seriesId, targets, {
    budget: opts.coverBudget,
    overwrite: opts.refresh,
  });
  out.coversWritten += pasted.written;
  out.coverMissed.push(...pasted.missed);
  if (pasted.stopped) return { ...out, stopped: true, error: pasted.error };

  // 代表表紙は、持っている中で一番若い巻のものを流用する
  if (hasVolumeCover(db, seriesId)) {
    refreshSeriesCover(db, seriesId);
  } else if (seriesRecord?.isbn) {
    // 巻の表紙が 1 枚も取れなかった作品 (単巻もの) は、作品の ISBN で 1 枚だけ試す
    try {
      if (await fetchCover(db, cfg, seriesId, SERIES_SLOT, seriesRecord.isbn)) out.coversWritten++;
    } catch (e) {
      if (e instanceof ProviderStopError) return { ...out, stopped: true, error: `${e.message} (${e.detail})` };
      // 取れなくても致命的ではない。表紙の無い作品として並ぶ
    }
  }

  return out;
}

/**
 * 番号の付いた板 (単巻・合本) の絵が 1 枚でもあるか。
 * **代表表紙をそこから流用できるか**の判定で、別巻は数に入らない (covers.ts の
 * refreshSeriesCover と同じ切り方 — 外伝の絵が作品の顔になると棚で見分けられない)
 */
function hasVolumeCover(db: Db, seriesId: number): boolean {
  return Boolean(
    db.raw
      .prepare('SELECT 1 FROM covers WHERE series_id = ? AND volume_no IS NOT NULL LIMIT 1')
      .get(seriesId)
  );
}

/**
 * 表紙の無い作品を順に埋めていく背景仕事。
 *
 * **予算で必ず打ち切る。** 485 作品 5000 巻を一息に取りに行くと相手に迷惑がかかるし、
 * 途中で失敗した時にどこまで進んだか分からなくなる。呼ばれるたびに少しずつ進め、
 * 進み具合は covers 表そのものが持つ (別に進捗表を作らない)。
 */
export async function fillMissingCovers(
  db: Db,
  cfg: Config,
  opts: { seriesLimit?: number; coverBudgetPerSeries?: number; retryAfterDays?: number } = {}
): Promise<EnrichResult[]> {
  // 一度聞きに行った作品は当分選び直さない。NDL に書影が無い作品は何度やっても
  // 取れないので、そこで止まると後ろの作品が永久に埋まらない
  const retryBefore = new Date(Date.now() - (opts.retryAfterDays ?? 30) * 86_400_000).toISOString();
  const rows = db.raw
    .prepare(
      `SELECT id FROM series s
        WHERE s.present = 1
          AND NOT EXISTS (SELECT 1 FROM covers c WHERE c.series_id = s.id AND c.slot = '')
          AND (s.enriched_at IS NULL OR s.enriched_at < ?)
        ORDER BY s.enriched_at IS NOT NULL, s.enriched_at, s.id LIMIT ?`
    )
    .all(retryBefore, Math.min(opts.seriesLimit ?? 5, 100)) as { id: number }[];

  const out: EnrichResult[] = [];
  for (const r of rows) {
    out.push(await enrichSeries(db, cfg, Number(r.id), { coverBudget: opts.coverBudgetPerSeries ?? 30 }));
  }
  return out;
}

export interface VolumeCoverResult {
  /** 取りに行った巻の数 */
  tried: number;
  written: number;
  /** 提供元ごとの枚数 */
  byProvider: Record<string, number>;
  /** 表紙を貼り直した作品の数 */
  seriesTouched: number;
  /** 打ち切った時の理由 (鍵の間違い、接続元 IP、1 日の上限)。**誰に何をされたかは文面が名乗る** */
  stopError: string | null;
  /** DB がスキャンに掴まれていて打ち切った */
  dbBusy: boolean;
}

/**
 * **ISBN は分かっているのに表紙が無い巻**を埋める背景仕事。
 *
 * fillMissingCovers が見ているのは「代表表紙すら無い作品」で、作品の中の
 * 抜けている巻は拾えない。手元ではそれが 2703 巻あった — 棚の一覧は埋まって見えるのに、
 * 作品を開くと中身が歯抜け、という状態。ここがそれを埋める。
 *
 * **NDL は飛ばす。** これらの巻は enrichSeries が既に NDL のサムネイルを試して
 * 取れなかったものなので、もう一度聞いても答えは変わらない。楽天から先に行く。
 *
 * 進み具合は `bib.cover_tried_at` が持つ。**取れなかった時にも押す** —
 * 押さないと、どこにも書影の無い巻を毎回選び直して先へ進まなくなる。
 */
export async function fillVolumeCovers(
  db: Db,
  cfg: Config,
  opts: { limit?: number; retryAfterDays?: number } = {}
): Promise<VolumeCoverResult> {
  const out: VolumeCoverResult = {
    tried: 0, written: 0, byProvider: {}, seriesTouched: 0, stopError: null, dbBusy: false,
  };
  // ここに来る巻は NDL を試して駄目だったものなので、**NDL 以外に聞く先が無ければ何もしない**
  if (!rakutenReady(cfg) && !openbdReady(cfg) && !googleReady(cfg)) return out;

  const retryBefore = new Date(Date.now() - (opts.retryAfterDays ?? 60) * 86_400_000).toISOString();
  const rows = db.raw
    .prepare(
      `SELECT b.id AS bib_id, b.series_id, b.volume_no, b.isbn
         FROM bib b
         JOIN series s ON s.id = b.series_id
        WHERE s.present = 1
          AND b.isbn IS NOT NULL AND b.isbn <> ''
          AND b.volume_no IS NOT NULL
          -- 手元から消えた巻の表紙は要らない。
          -- **合本 (第01-06巻) が覆う巻も「手元にある」。** 単巻 (from = to) に限ると、
          -- 合本でしか持っていない巻の表紙が永久に埋まらない。手元ではそれが 799 冊で、
          -- うち 496 冊は ISBN 付きの書誌を既に持っていた (2026-09-18)
          AND EXISTS (SELECT 1 FROM volumes v
                       WHERE v.series_id = b.series_id AND v.present = 1
                         AND b.volume_no BETWEEN v.volume_from AND v.volume_to)
          -- **板の宛先で見る** (cover-slot.ts)。番号で見ると、合本 (第01-02巻) の板が
          -- 覆う中で一番若い巻を volume_no に名乗っているせいで、第01巻の絵が
          -- もう有ることにされて永久に埋まらない
          AND NOT EXISTS (SELECT 1 FROM covers c
                           WHERE c.series_id = b.series_id
                             AND c.slot = 'v:巻:' || b.volume_no)
          AND (b.cover_tried_at IS NULL OR b.cover_tried_at < ?)
        ORDER BY b.cover_tried_at IS NOT NULL, b.cover_tried_at, b.series_id, b.volume_no
        LIMIT ?`
    )
    .all(retryBefore, Math.min(opts.limit ?? 20, 500)) as {
    bib_id: number;
    series_id: number;
    volume_no: number;
    isbn: string;
  }[];

  const touched = new Set<number>();
  for (const r of rows) {
    out.tried++;
    try {
      // 印は**先に**押す。途中で落ちても同じ巻で足踏みしないため
      db.markCoverTried(Number(r.bib_id));
      const provider = await fetchCover(db, cfg, Number(r.series_id), volumeSlot(Number(r.volume_no)), String(r.isbn), {
        skipNdl: true,
      });
      if (provider) {
        out.written++;
        out.byProvider[provider] = (out.byProvider[provider] ?? 0) + 1;
        touched.add(Number(r.series_id));
      }
    } catch (e) {
      if (e instanceof ProviderStopError) {
        // ここで止める。残りを回しても全部同じ理由で落ちるだけで、
        // 無駄に印だけ進んで次の巡回で拾い直せなくなる
        out.stopError = `${e.message} (${e.detail})`;
        break;
      }
      // DB が掴めない = スキャンと噛み合った。この回は諦めて次の巡回に回す。
      // **回し続けない** — 印を押せていない巻を空回りで消費してしまう
      if (/locked|busy/i.test((e as Error).message)) {
        out.dbBusy = true;
        break;
      }
      // 1 巻ぶん取れなかっただけ。印は押してあるので次の巡回は先へ進む
    }
  }

  // 若い巻の表紙が埋まったら、作品の代表表紙も貼り直す
  for (const seriesId of touched) refreshSeriesCover(db, seriesId);
  out.seriesTouched = touched.size;
  return out;
}
