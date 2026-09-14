import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { fetchBinary } from './cache.js';
import { byVolume, ndlThumbnailUrl, searchNdl, type NdlRecord } from './ndl.js';
import {
  findRakutenByIsbn, findRakutenByTitle, rakutenImageUrl, rakutenReady,
  RakutenAuthError, type RakutenRecord,
} from './rakuten.js';

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
 * 書影は **NDL → 楽天ブックス** の順に試す (2026-09-14 に楽天の鍵が入って追加):
 * NDL のサムネイルは ISBN のうち半分ほどしか画像を持っておらず、手元では
 * **ISBN は分かっているのに表紙が無い巻が 2703 件**残っていた。そこを楽天が
 * ISBN 直引きで埋める。**書誌は NDL のまま**で、楽天には表紙だけ任せる —
 * 巻の区切りは NDL の `dcndl:volume` の方が素直に取れるため。
 * (楽天は書名に「日常（十二）」のように漢数字で巻を書くので、そこを読むのは分が悪い)
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

/** covers に 1 行置く。画像は既に焼いてある前提 */
function writeCover(
  db: Db,
  seriesId: number,
  volumeNo: number | null,
  provider: string,
  sourceUrl: string,
  isbn: string | null,
  burned: { file: string; bytes: number },
  contentType: string | null
): void {
  db.raw
    .prepare(
      `INSERT INTO covers (series_id, volume_no, provider, source_url, isbn, file, bytes, content_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(series_id, volume_no) DO UPDATE SET
         provider = excluded.provider, source_url = excluded.source_url, isbn = excluded.isbn,
         file = excluded.file, bytes = excluded.bytes, content_type = excluded.content_type`
    )
    .run(seriesId, volumeNo, provider, sourceUrl, isbn, burned.file, burned.bytes, contentType, new Date().toISOString());
}

/**
 * 1 巻ぶんの表紙を取って焼く。取れた提供元の名前を返す。取れなければ null。
 *
 * 順番は **NDL → 楽天**。NDL は鍵が要らず、こちらから見て一番壊れにくい相手なので先に聞く。
 * 楽天は鍵と接続元 IP の登録が要る (= 壊れうる) ので、埋まらなかった分の受け皿に置く。
 *
 * **RakutenAuthError はここで握り潰さない。** 鍵や IP の間違いは黙って諦めてよい失敗ではなく、
 * 人が楽天の管理画面を直せば全部埋まるもの。呼び出し側まで上げて知らせる。
 */
async function fetchCover(
  db: Db,
  cfg: Config,
  seriesId: number,
  volumeNo: number | null,
  isbn: string,
  opts: { skipNdl?: boolean } = {}
): Promise<string | null> {
  if (!opts.skipNdl) {
    const url = ndlThumbnailUrl(isbn);
    // Referer が無いと 403。詳しくは bib/cache.ts の fetchBinary
    const res = await fetchBinary(cfg, 'ndl-thumbnail', url, { referer: 'https://ndlsearch.ndl.go.jp/' });
    if (res.status === 200 && res.bytes.length >= MIN_COVER_BYTES) {
      const burned = await burnCover(cfg, res.bytes, res.contentType);
      writeCover(db, seriesId, volumeNo, 'ndl', url, isbn, burned, res.contentType);
      return 'ndl';
    }
  }

  if (!rakutenReady(cfg)) return null;

  // 楽天の 1 冊を書影として焼く。焼けたら true
  const burnFrom = async (rec: RakutenRecord | null, provider: string): Promise<boolean> => {
    const imageUrl = rakutenImageUrl(rec?.imageUrl, cfg.bib.rakuten.imageSize);
    if (!imageUrl) return false;
    const res = await fetchBinary(cfg, 'rakuten-image', imageUrl, { referer: 'https://books.rakuten.co.jp/' });
    if (res.status !== 200 || res.bytes.length < MIN_COVER_BYTES) return false;
    const burned = await burnCover(cfg, res.bytes, res.contentType);
    writeCover(db, seriesId, volumeNo, provider, imageUrl, rec?.isbn ?? isbn, burned, res.contentType);
    return true;
  };

  if (await burnFrom(await findRakutenByIsbn(db, cfg, isbn), 'rakuten')) return 'rakuten';

  /**
   * ISBN で当たらない。**古い巻は楽天の在庫から消えている** ので、書名で拾い直す。
   * 刷り直した版が載っていればそちらの書影が付く — 手元の本と絵が違いうるので、
   * provider を分けて後から見分けられるようにしておく。
   */
  if (volumeNo === null) return null;
  const s = db.getSeries(seriesId);
  if (!s) return null;
  const alt = await findRakutenByTitle(db, cfg, { title: s.title, author: s.author, volume: volumeNo });
  if (await burnFrom(alt, 'rakuten-title')) return 'rakuten-title';

  return null;
}

/**
 * 作品の代表表紙を「持っている中で一番若い巻」に貼り直す。
 *
 * 画像は焼き直さない — covers の行だけ増やして同じ file を指す。
 * 後から若い巻の表紙が埋まった時にここを呼ばないと、棚には**ずっと 6 巻の表紙**が
 * 並んだままになる。
 */
function refreshSeriesCover(db: Db, seriesId: number): void {
  const first = db.raw
    .prepare('SELECT * FROM covers WHERE series_id = ? AND volume_no IS NOT NULL ORDER BY volume_no LIMIT 1')
    .get(seriesId) as Record<string, unknown> | undefined;
  if (!first) return;
  db.raw
    .prepare(
      `INSERT INTO covers (series_id, volume_no, provider, source_url, isbn, file, bytes, content_type, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(series_id, volume_no) DO UPDATE SET
         provider = excluded.provider, source_url = excluded.source_url,
         isbn = excluded.isbn, file = excluded.file, bytes = excluded.bytes,
         content_type = excluded.content_type`
    )
    .run(
      seriesId, String(first.provider), first.source_url as string | null, first.isbn as string | null,
      String(first.file), Number(first.bytes), first.content_type as string | null, new Date().toISOString()
    );
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
    seriesId, label, recordCount: 0, publishedMax: null, bibWritten: 0, coversWritten: 0,
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
    writeBib(db, seriesId, vol, rec);
    out.bibWritten++;
  }
  out.publishedMax = byVol.size ? Math.max(...byVol.keys()) : null;

  // 表紙を取りに行くのは持っている巻だけ
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

    if (spent >= budget) continue;
    const already = db.raw
      .prepare('SELECT 1 FROM covers WHERE series_id = ? AND volume_no = ?')
      .get(seriesId, vol);
    if (already && !opts.refresh) continue;

    spent++;
    try {
      if (await fetchCover(db, cfg, seriesId, vol, rec.isbn)) out.coversWritten++;
      else out.coverMissed.push(vol);
    } catch (e) {
      // 鍵・IP の間違いは黙って飲まない。残りを回しても全部同じ理由で落ちる
      if (e instanceof RakutenAuthError) return { ...out, error: `${e.message} (${e.detail})` };
      out.coverMissed.push(vol);
    }
  }

  // 代表表紙は、持っている中で一番若い巻のものを流用する
  const hasVolumeCover = db.raw
    .prepare('SELECT 1 FROM covers WHERE series_id = ? AND volume_no IS NOT NULL LIMIT 1')
    .get(seriesId);
  if (hasVolumeCover) {
    refreshSeriesCover(db, seriesId);
  } else if (seriesRecord?.isbn) {
    // 巻の表紙が 1 枚も取れなかった作品 (単巻もの) は、作品の ISBN で 1 枚だけ試す
    try {
      if (await fetchCover(db, cfg, seriesId, null, seriesRecord.isbn)) out.coversWritten++;
    } catch (e) {
      if (e instanceof RakutenAuthError) return { ...out, error: `${e.message} (${e.detail})` };
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

export interface VolumeCoverResult {
  /** 取りに行った巻の数 */
  tried: number;
  written: number;
  /** 提供元ごとの枚数 */
  byProvider: Record<string, number>;
  /** 表紙を貼り直した作品の数 */
  seriesTouched: number;
  /** 鍵・接続元 IP の問題で打ち切った時の理由 */
  authError: string | null;
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
 * 取れなかったものなので、もう一度聞いても答えは変わらない。最初から楽天に行く。
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
    tried: 0, written: 0, byProvider: {}, seriesTouched: 0, authError: null, dbBusy: false,
  };
  if (!rakutenReady(cfg)) return out;

  const retryBefore = new Date(Date.now() - (opts.retryAfterDays ?? 60) * 86_400_000).toISOString();
  const rows = db.raw
    .prepare(
      `SELECT b.id AS bib_id, b.series_id, b.volume_no, b.isbn
         FROM bib b
         JOIN series s ON s.id = b.series_id
        WHERE s.present = 1
          AND b.isbn IS NOT NULL AND b.isbn <> ''
          AND b.volume_no IS NOT NULL
          -- 手元から消えた巻の表紙は要らない
          AND EXISTS (SELECT 1 FROM volumes v
                       WHERE v.series_id = b.series_id AND v.present = 1
                         AND v.volume_from = b.volume_no AND v.volume_to = b.volume_no)
          AND NOT EXISTS (SELECT 1 FROM covers c
                           WHERE c.series_id = b.series_id AND c.volume_no IS b.volume_no)
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
      const provider = await fetchCover(db, cfg, Number(r.series_id), Number(r.volume_no), String(r.isbn), {
        skipNdl: true,
      });
      if (provider) {
        out.written++;
        out.byProvider[provider] = (out.byProvider[provider] ?? 0) + 1;
        touched.add(Number(r.series_id));
      }
    } catch (e) {
      if (e instanceof RakutenAuthError) {
        // ここで止める。残りを回しても全部同じ理由で落ちるだけで、
        // 無駄に印だけ進んで次の巡回で拾い直せなくなる
        out.authError = `${e.message} (${e.detail})`;
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
