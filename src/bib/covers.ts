import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { fetchBinary } from './cache.js';
import {
  findGoogleByIsbn, findGoogleByTitle, googleReady, GOOGLE_PLACEHOLDER_COVERS, type GoogleRecord,
} from './google.js';
import { ndlThumbnailUrl } from './ndl.js';
import { findOpenbdCover, openbdReady } from './openbd.js';
import { findRakutenByIsbn, findRakutenByTitle, rakutenImageUrl, rakutenReady } from './rakuten.js';

/**
 * 書影を**焼いて置く**ところ。外から取った画像がカタログに載る道はここ 1 本だけ。
 *
 * enrich.ts (自動で埋める) と pick.ts (人が選ぶ) の両方から使う。
 * 片方に置くともう片方が import し返して輪になるので、共有の土台として切ってある。
 */

/** 画像として成立している最低の大きさ。エラーページや 1x1 を掴まないための足切り */
export const MIN_COVER_BYTES = 2000;

/**
 * 書影を取りに行ってよい相手。**ここに無いホストへは中継しない。**
 * /api/bib/thumb を任意の URL に開くと、pinax が外へ何でも取りに行く踏み台になる。
 */
const IMAGE_HOSTS = [
  'https://ndlsearch.ndl.go.jp/thumbnail/',
  'https://thumbnail.image.rakuten.co.jp/',
  'https://image.rakuten.co.jp/',
  'https://books.rakuten.co.jp/',
  'https://shop.r10s.jp/',
  'https://books.google.com/books/content',
  'https://books.google.co.jp/books/content',
  'https://cover.openbd.jp/',
];

export function imageHostAllowed(url: string): boolean {
  return IMAGE_HOSTS.some((h) => String(url ?? '').startsWith(h));
}

/**
 * その URL を取りに行く時に添える Referer。NDL は無いと 403 で弾く (cache.ts の fetchBinary)。
 *
 * **その置き場の元のサイトを名乗る。** 余所の名前を出す理由が無いし、
 * 画像の置き場が Referer を見るようになった時に、素直に通るのはこの形。
 */
export function refererFor(url: string): string {
  if (url.startsWith('https://ndlsearch.ndl.go.jp/')) return 'https://ndlsearch.ndl.go.jp/';
  if (url.startsWith('https://cover.openbd.jp/')) return 'https://openbd.jp/';
  if (/^https:\/\/books\.google\.(com|co\.jp)\//.test(url)) return 'https://books.google.com/';
  return 'https://books.rakuten.co.jp/';
}

export interface BurnedCover {
  file: string;
  bytes: number;
  contentType: string | null;
}

/** 中身の SHA-256 (先頭 32 桁)。焼いたファイルの名前であり、同じ絵かどうかの判定でもある */
function hashOf(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

/**
 * **「画像がありません」の板を掴んでいないか。**
 *
 * Google Books は絵を持っていない巻にも 200 で灰色の板を返す (bib/google.ts)。
 * 大きさの足切りでは落ちない (9KB〜82KB ある) ので、中身そのもので弾く。
 * ここを抜かすと、棚に「image not available」が並ぶ。
 */
export function isPlaceholderImage(bytes: Buffer): boolean {
  return GOOGLE_PLACEHOLDER_COVERS.has(hashOf(bytes));
}

/** 画像をファイルとして焼く。名前は中身の SHA-256 なので、同じ絵は 1 つで済む */
export async function burnCover(
  cfg: Config,
  bytes: Buffer,
  contentType: string | null
): Promise<BurnedCover> {
  const ext = contentType?.includes('png') ? '.png' : contentType?.includes('webp') ? '.webp' : '.jpg';
  const name = hashOf(bytes) + ext;
  const abs = path.join(cfg.dataDir, 'covers', name);
  // 同じ画像なら書き直さない (別の巻が同じ表紙ということはある)
  try {
    await fs.access(abs);
  } catch {
    await fs.writeFile(abs, bytes);
  }
  return { file: name, bytes: bytes.length, contentType };
}

/** 1 枚取って焼く。画像として成立していなければ null */
export async function fetchAndBurn(cfg: Config, provider: string, url: string): Promise<BurnedCover | null> {
  const res = await fetchBinary(cfg, provider, url, { referer: refererFor(url) });
  if (res.status !== 200 || res.bytes.length < MIN_COVER_BYTES) return null;
  if (isPlaceholderImage(res.bytes)) return null;
  return burnCover(cfg, res.bytes, res.contentType);
}

export interface WriteCoverInput {
  seriesId: number;
  volumeNo: number | null;
  provider: string;
  sourceUrl: string | null;
  isbn: string | null;
  burned: BurnedCover;
  /**
   * 人が選んだ表紙か。
   *
   * **立った行を自動の巡回は二度と上書きしない。** 完結の `completed_user` と同じ立場で、
   * 機械の当てずっぽうより人の判断を上に置く。立てずに上書きを許すと、
   * せっかく選び直した表紙が次の巡回で元の取り違えへ戻る。
   */
  pinned?: boolean;
}

/** covers に 1 行置く。画像は既に焼いてある前提 */
export function writeCover(db: Db, input: WriteCoverInput): void {
  const pinned = input.pinned ? 1 : 0;
  db.raw
    .prepare(
      `INSERT INTO covers (series_id, volume_no, provider, source_url, isbn, file, bytes, content_type, pinned, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(series_id, volume_no) DO UPDATE SET
         provider = excluded.provider, source_url = excluded.source_url, isbn = excluded.isbn,
         file = excluded.file, bytes = excluded.bytes, content_type = excluded.content_type,
         pinned = excluded.pinned, created_at = excluded.created_at
       WHERE covers.pinned = 0 OR excluded.pinned = 1`
    )
    .run(
      input.seriesId, input.volumeNo, input.provider, input.sourceUrl, input.isbn,
      input.burned.file, input.burned.bytes, input.burned.contentType, pinned, new Date().toISOString()
    );
}

/**
 * 1 巻ぶんの表紙を取って焼く。取れた提供元の名前を返す。取れなければ null。
 *
 * 聞く順番は **ISBN で当たる道 → 書名で拾い直す道**。この 2 段が一番大事で、
 * 提供元の並びはその中の話:
 *
 *   ISBN … NDL → 楽天 → openBD → Google     手元の本と**同じ版**の絵が付く
 *   書名 … 楽天 → Google                     別の版の絵が付きうる (provider を分けて残す)
 *
 * ISBN の中の並びは「鍵が要らない順」ではなく**実測の当たりやすさ順**:
 * NDL が半分、楽天が ISBN 直引きの本命、openBD は漫画ではまず当たらない (0.3%)、
 * Google は ISBN 直引きだと 14% しか絵が付かない。
 * ただし Google は**書名で引くと電子版の書影が出てくる**ので、最後の受け皿として効く。
 *
 * **`ProviderStopError` はここで握り潰さない。** 鍵や IP の間違い、1 日の上限は
 * 黙って諦めてよい失敗ではなく、残りを回しても全部同じところで落ちるもの。
 * 呼び出し側まで上げて、その回を打ち切らせる。
 */
export async function fetchCover(
  db: Db,
  cfg: Config,
  seriesId: number,
  volumeNo: number | null,
  isbn: string,
  opts: {
    skipNdl?: boolean;
    /**
     * ISBN で当たらなかった時に楽天を書名で引き直す際の書名。
     * 既定は蔵書のフォルダ名から取った作品名。
     *
     * **人がシリーズを選んでいる作品では、選んだ側の書名を渡すこと。**
     * フォルダ名が `血界戦線` のまま Back 2 Back を選んだ作品に既定を使うと、
     * 取り違えを直したそばから無印の表紙を引き当てて元へ戻る。
     */
    titleForFallback?: string;
  } = {}
): Promise<string | null> {
  /**
   * 書影 URL を 1 つ焼いて covers に 1 行置く。焼けたら true。
   *
   * `provider` は covers に残す名前 (後から「どこの絵か」を見分けるため)、
   * `bucket` は間引きの単位 (cache.ts の throttle)。**同じ置き場から取るものは
   * 同じ bucket にまとめる** — `rakuten` と `rakuten-title` は同じ画像置き場なので分けない。
   */
  const burn = async (
    imageUrl: string | null,
    provider: string,
    bucket: string,
    recIsbn?: string | null
  ): Promise<boolean> => {
    if (!imageUrl) return false;
    const burned = await fetchAndBurn(cfg, bucket, imageUrl);
    if (!burned) return false;
    writeCover(db, {
      seriesId, volumeNo, provider, sourceUrl: imageUrl, isbn: recIsbn ?? isbn, burned,
    });
    return true;
  };

  // ---- ISBN で当てる道。**手元の本と同じ版**の絵が付く ----------------------

  if (!opts.skipNdl && (await burn(ndlThumbnailUrl(isbn), 'ndl', 'ndl-thumbnail'))) return 'ndl';

  if (rakutenReady(cfg)) {
    const rec = await findRakutenByIsbn(db, cfg, isbn);
    const url = rakutenImageUrl(rec?.imageUrl, cfg.bib.rakuten.imageSize);
    if (await burn(url, 'rakuten', 'rakuten-image', rec?.isbn)) return 'rakuten';
  }

  if (openbdReady(cfg)) {
    if (await burn(await findOpenbdCover(db, cfg, isbn), 'openbd', 'openbd-image')) return 'openbd';
  }

  /**
   * Google の ISBN 直引きで返るのは紙の版の書誌で、**128px のサムネイルしか持たない**
   * ことが多い (bib/google.ts)。楽天の 600px と並ぶと目に見えて粗いので、
   * 小さい絵は**取っておいて最後に回す** — 先に書名で大きい絵を探す。
   */
  let googleSmall: GoogleRecord | null = null;
  if (googleReady(cfg)) {
    const rec = await findGoogleByIsbn(db, cfg, isbn);
    if (rec?.imageUrl && rec.large) {
      if (await burn(rec.imageUrl, 'google', 'google-image', rec.isbn)) return 'google';
    } else if (rec?.imageUrl) {
      googleSmall = rec;
    }
  }

  // ---- 書名で拾い直す道。**別の版の絵が付きうる** --------------------------

  /**
   * **古い巻は楽天の在庫から消えている** し、Google で絵を持っているのは電子版の方。
   * どちらも刷り直した版・電子版の書影が付くことがあるので、手元の本と絵が違いうる。
   * provider を分けて後から見分けられるようにしておく。
   */
  const s = volumeNo === null ? null : db.getSeries(seriesId);
  if (s && volumeNo !== null) {
    const title = opts.titleForFallback ?? s.title;

    if (rakutenReady(cfg)) {
      const alt = await findRakutenByTitle(db, cfg, { title, author: s.author, volume: volumeNo });
      const url = rakutenImageUrl(alt?.imageUrl, cfg.bib.rakuten.imageSize);
      if (await burn(url, 'rakuten-title', 'rakuten-image', alt?.isbn)) return 'rakuten-title';
    }

    if (googleReady(cfg)) {
      const alt = await findGoogleByTitle(db, cfg, { title, author: s.author, volume: volumeNo });
      if (await burn(alt?.imageUrl ?? null, 'google-title', 'google-image', alt?.isbn)) return 'google-title';
    }
  }

  // ---- 最後の 1 枚。**粗くても、無いよりは棚が埋まる** ----------------------
  if (googleSmall?.imageUrl && (await burn(googleSmall.imageUrl, 'google', 'google-image', googleSmall.isbn))) {
    return 'google';
  }

  return null;
}

/**
 * 表紙を選ぶ画面に出す**下見**の画像を取って置く。
 *
 * ブラウザから直接は引けない。NDL のサムネイルは
 * `Referer: https://ndlsearch.ndl.go.jp/` でないと 403 で弾くが
 * (2026-09-15 に実測。`http://localhost:3838/` でも 403)、Referer は
 * ブラウザが自分で決めるヘッダなので画面側からは名乗れない。**pinax が中継する。**
 *
 * 置き場は `data/thumbs/`。名前は **URL の SHA-256** にする — covers と違って
 * 中身のハッシュにできない (取る前に名前が要る) が、そのおかげで
 * 「この URL は取りに行ったか」を DB を引かずに判定できる。
 * **一度取った下見は二度と外に聞かない** ("Never burn." はここにも効く)。
 *
 * 選ばれなかった候補の画像も残るが、1 枚 100KB 前後で、
 * 同じ作品を開き直した時にすぐ出る方が値打ちが大きい。
 */
export async function cacheThumbnail(
  cfg: Config,
  url: string
): Promise<{ abs: string; contentType: string } | null> {
  if (!imageHostAllowed(url)) return null;

  const dir = path.join(cfg.dataDir, 'thumbs');
  const name = crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
  const types: [string, string][] = [['.jpg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp']];
  for (const [ext, type] of types) {
    const abs = path.join(dir, name + ext);
    try {
      await fs.access(abs);
      return { abs, contentType: type };
    } catch {
      // 無い。次の拡張子を見る
    }
  }

  // **人が画面の前で待っている。** 候補は数枚まとめて出るので、巡回と同じ間引きでは遅すぎる
  const res = await fetchBinary(cfg, 'thumbnail', url, { referer: refererFor(url), minIntervalMs: 300 });
  if (res.status !== 200 || res.bytes.length < MIN_COVER_BYTES) return null;
  if (!String(res.contentType ?? '').startsWith('image/')) return null;
  // 「画像がありません」の板は下見にも出さない。**書名の板が出た方がまし** —
  // 灰色の板が並ぶと、絵のある候補と無い候補が見分けられなくなる
  if (isPlaceholderImage(res.bytes)) return null;

  const [ext, type] =
    types.find(([, t]) => res.contentType?.includes(t.slice('image/'.length))) ?? types[0];
  const abs = path.join(dir, name + ext);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(abs, res.bytes);
  return { abs, contentType: type };
}

/**
 * 作品の代表表紙を「持っている中で一番若い巻」に貼り直す。
 *
 * 画像は焼き直さない — covers の行だけ増やして同じ file を指す。
 * 後から若い巻の表紙が埋まった時にここを呼ばないと、棚には**ずっと 6 巻の表紙**が
 * 並んだままになる。
 *
 * **人が代表表紙そのものを選んでいたら触らない** (pinned)。
 */
export function refreshSeriesCover(db: Db, seriesId: number): void {
  const pinned = db.raw
    .prepare('SELECT 1 FROM covers WHERE series_id = ? AND volume_no IS NULL AND pinned = 1')
    .get(seriesId);
  if (pinned) return;

  const first = db.raw
    .prepare('SELECT * FROM covers WHERE series_id = ? AND volume_no IS NOT NULL ORDER BY volume_no LIMIT 1')
    .get(seriesId) as Record<string, unknown> | undefined;
  if (!first) return;

  writeCover(db, {
    seriesId,
    volumeNo: null,
    provider: String(first.provider),
    sourceUrl: (first.source_url as string | null) ?? null,
    isbn: (first.isbn as string | null) ?? null,
    burned: {
      file: String(first.file),
      bytes: Number(first.bytes),
      contentType: (first.content_type as string | null) ?? null,
    },
  });
}
