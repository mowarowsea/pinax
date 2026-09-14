import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { fetchBinary } from './cache.js';
import { byVolume, ndlThumbnailUrl, searchNdl, type NdlRecord } from './ndl.js';

/**
 * 蔵書の 1 作品に、外から取った書誌と書影を貼る。
 *
 * 経路は 1 本だけ (2026-09-12 に実測して決めた。docs/ARCHITECTURE.md 5 章):
 *
 *   [著者] 作品名 ──▶ NDLサーチ (title + creator) ──▶ 巻ごとの ISBN
 *                 ──▶ NDL サムネイル /thumbnail/{ISBN}.jpg ──▶ ローカルへ焼く
 *
 * **openBD は書影を持っていない。** 手元の漫画 100 冊ぶんの ISBN で試したところ、
 * データは 85 件返るのに `summary.cover` は 0 件だった。書誌の補完先としては使えるが、
 * 表紙の供給源にはならない。
 *
 * 焼いた画像は二度と外に聞かない。外部サービスが消えてもカタログは残る。
 */

export interface EnrichResult {
  seriesId: number;
  label: string;
  /** NDL が返した巻の数 */
  recordCount: number;
  bibWritten: number;
  coversWritten: number;
  /** 表紙を取れなかった巻 */
  coverMissed: number[];
  cached: boolean;
  stale: boolean;
  error: string | null;
}

/** 画像として成立している最低の大きさ。エラーページや 1x1 を掴まないための足切り */
const MIN_COVER_BYTES = 2000;

async function burnCover(
  cfg: Config,
  bytes: Buffer,
  contentType: string | null
): Promise<{ file: string; bytes: number }> {
  const ext = contentType?.includes('png') ? '.png' : contentType?.includes('webp') ? '.webp' : '.jpg';
  const name = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32) + ext;
  const abs = path.join(cfg.dataDir, 'covers', name);
  // 同じ画像なら書き直さない (別の巻が同じ表紙ということはある)
  try {
    await fs.access(abs);
  } catch {
    await fs.writeFile(abs, bytes);
  }
  return { file: name, bytes: bytes.length };
}

/** 1 巻ぶんの表紙を取って焼く。取れなければ null (行は作らない) */
async function fetchCover(
  db: Db,
  cfg: Config,
  seriesId: number,
  volumeNo: number | null,
  isbn: string
): Promise<boolean> {
  const url = ndlThumbnailUrl(isbn);
  // Referer が無いと 403。詳しくは bib/cache.ts の fetchBinary
  const res = await fetchBinary(cfg, 'ndl-thumbnail', url, { referer: 'https://ndlsearch.ndl.go.jp/' });
  if (res.status !== 200 || res.bytes.length < MIN_COVER_BYTES) return false;

  const burned = await burnCover(cfg, res.bytes, res.contentType);
  db.raw
    .prepare(
      `INSERT INTO covers (series_id, volume_no, provider, source_url, isbn, file, bytes, content_type, created_at)
       VALUES (?, ?, 'ndl', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(series_id, volume_no) DO UPDATE SET
         provider = excluded.provider, source_url = excluded.source_url, isbn = excluded.isbn,
         file = excluded.file, bytes = excluded.bytes, content_type = excluded.content_type`
    )
    .run(seriesId, volumeNo, url, isbn, burned.file, burned.bytes, res.contentType, new Date().toISOString());
  return true;
}

function writeBib(db: Db, seriesId: number, volumeNo: number | null, r: NdlRecord): void {
  db.raw
    .prepare(
      `INSERT INTO bib (series_id, volume_no, provider, isbn, title, author, publisher, pubdate, cover_url, raw, fetched_at)
       VALUES (?, ?, 'ndl', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(series_id, volume_no, provider) DO UPDATE SET
         isbn = excluded.isbn, title = excluded.title, author = excluded.author,
         publisher = excluded.publisher, pubdate = excluded.pubdate, cover_url = excluded.cover_url,
         raw = excluded.raw, fetched_at = excluded.fetched_at`
    )
    .run(
      seriesId, volumeNo, r.isbn, r.title, r.creator, r.publisher, r.date,
      r.isbn ? ndlThumbnailUrl(r.isbn) : null,
      JSON.stringify(r), new Date().toISOString()
    );
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
    seriesId, label, recordCount: 0, bibWritten: 0, coversWritten: 0,
    coverMissed: [], cached: false, stale: false, error: null,
  };
  if (!s) return { ...out, error: '作品がありません' };

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
    writeBib(db, seriesId, null, seriesRecord);
    out.bibWritten++;
  }

  // 持っている巻だけを対象にする
  const owned = db
    .listVolumes(seriesId)
    .filter((v) => v.present && v.unit === '巻' && v.volumeFrom === v.volumeTo)
    .map((v) => v.volumeFrom)
    .sort((a, b) => a - b);

  const budget = opts.coverBudget ?? 200;
  let spent = 0;

  for (const vol of owned) {
    const rec = byVol.get(vol);
    if (!rec?.isbn) {
      out.coverMissed.push(vol);
      continue;
    }
    writeBib(db, seriesId, vol, rec);
    out.bibWritten++;

    if (spent >= budget) continue;
    const already = db.raw
      .prepare('SELECT 1 FROM covers WHERE series_id = ? AND volume_no = ?')
      .get(seriesId, vol);
    if (already && !opts.refresh) continue;

    spent++;
    try {
      const ok = await fetchCover(db, cfg, seriesId, vol, rec.isbn);
      if (ok) out.coversWritten++;
      else out.coverMissed.push(vol);
    } catch {
      out.coverMissed.push(vol);
    }
  }

  // 代表表紙は、持っている中で一番若い巻のものを流用する。
  // 画像を焼き直さず covers の行だけ増やす
  const first = db.raw
    .prepare('SELECT * FROM covers WHERE series_id = ? AND volume_no IS NOT NULL ORDER BY volume_no LIMIT 1')
    .get(seriesId) as Record<string, unknown> | undefined;
  if (first) {
    db.raw
      .prepare(
        `INSERT INTO covers (series_id, volume_no, provider, source_url, isbn, file, bytes, content_type, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(series_id, volume_no) DO UPDATE SET file = excluded.file, isbn = excluded.isbn`
      )
      .run(seriesId, String(first.provider), first.source_url as string | null, first.isbn as string | null,
        String(first.file), Number(first.bytes), first.content_type as string | null, new Date().toISOString());
  } else if (seriesRecord?.isbn) {
    // 巻の表紙が 1 枚も取れなかった作品 (単巻もの) は、作品の ISBN で 1 枚だけ試す
    try {
      if (await fetchCover(db, cfg, seriesId, null, seriesRecord.isbn)) out.coversWritten++;
    } catch {
      // 取れなくても致命的ではない。表紙の無い作品として並ぶ
    }
  }

  return out;
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
          AND NOT EXISTS (SELECT 1 FROM covers c WHERE c.series_id = s.id AND c.volume_no IS NULL)
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
