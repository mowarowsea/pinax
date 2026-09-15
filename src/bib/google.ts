import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { cachedFetch, ProviderStopError } from './cache.js';
import { normalizeIsbn } from './ndl.js';
import { seriesKeyOf } from '../volume.js';

/**
 * Google Books API のアダプタ。
 *
 * pinax における役割は **NDL でも楽天でも埋まらなかった巻の受け皿**。
 * 実測 (2026-09-15、手元で表紙の無い巻の ISBN 100 件):
 *
 *   ISBN 直引き … 書誌は 94/100 当たるのに、**画像が付くのは 14 件だけ**
 *   書名で引く  … 電子版の記録が並び、そちらには**ほぼ全部に画像が付く**
 *
 * 紙の版の記録 (ISBN 付き) は書誌だけで絵を持っておらず、絵を持っているのは
 * Google Play の電子版 (ISBN を持たず `PKEY:…` で並ぶ) の方、という偏りがある。
 * だから ISBN 直引きだけでは大して埋まらない。**書名で引く道の方が本命**で、
 * そちらは別の版の絵が付きうるので covers.provider を `google-title` と分けて残す。
 *
 * 書誌は NDL のまま。ここも楽天と同じで**表紙の供給源**として使う。
 */

const ENDPOINT = 'https://www.googleapis.com/books/v1/volumes';

/**
 * 問い合わせ元の国。**省かない。**
 * 省くと Google が接続元から推測するが、推測できなかった時に
 * 403 `Cannot determine user location` で全部弾かれる。
 */
const COUNTRY = 'JP';

export interface GoogleRecord {
  /** Google の巻 ID。書影 URL の素になる */
  id: string;
  title: string;
  subtitle: string | null;
  /** 著者。複数いれば「・」で繋ぐ */
  author: string | null;
  publisher: string | null;
  /** 発行日。「2016-01-04」「2012-06」「2003」と精度がまちまち */
  publishedDate: string | null;
  isbn: string | null;
  /** 焼くのに使う書影 URL。大きさは記録ごとに決まる (googleImageUrl) */
  imageUrl: string | null;
  /**
   * `imageUrl` が 575px の方か。false なら 128px のサムネイルしか無い記録。
   *
   * **棚に並べる時に効く。** 128px は楽天の 600px と並ぶと目に見えて粗いので、
   * 小さい絵しか無い記録は「他の道が全部駄目だった時の最後の 1 枚」に回す
   * (bib/covers.ts の fetchCover)。
   */
  large: boolean;
  link: string | null;
}

/** 鍵が間違っている時の失敗 (`ProviderStopError` の Google 版) */
export class GoogleAuthError extends ProviderStopError {
  constructor(message: string, detail: string) {
    super('google', message, detail);
    this.name = 'GoogleAuthError';
  }
}

/**
 * **1 日の上限に届いた。** 鍵の間違いとは必ず**別の言葉で**知らせる —
 * 鍵は人が直すものだが、上限は明日になれば戻る。混ぜて「鍵を確かめてください」と出すと、
 * 正しい鍵を何度も見直させることになる。
 *
 * 打ち切る扱いは同じ (`ProviderStopError`)。Google Books の既定の枠は 1 日 1000 回で、
 * 蔵書 1000 巻を一息に埋めようとすると**普通に届く**。届いた後も回し続けると、
 * 取れるはずだった巻に「駄目だった」の印だけが押されて進んでしまう。
 */
export class GoogleQuotaError extends ProviderStopError {
  constructor(detail: string) {
    super('google', 'Google Books の 1 日の上限に届きました。明日また埋まります', detail);
    this.name = 'GoogleQuotaError';
  }
}

/**
 * 鍵が無くても API は叩けるが、**実質は必須**。鍵無しの問い合わせは接続元 IP ごとの
 * 細い枠で数えられ、巡回の速さだとすぐ 429 で弾かれる。だから鍵が無ければ聞きに行かない。
 */
export function googleReady(cfg: Config): boolean {
  return Boolean(cfg.bib.google.apiKey) && cfg.bib.providers.includes('google');
}

// ---------------------------------------------------------------------------
// 書影 URL
// ---------------------------------------------------------------------------

/**
 * 書影の大きさは URL の `zoom` で決まる。2026-09-15 に実測した中身:
 *
 *   zoom=0  2376x3752 (1.3MB)   大きすぎる。棚に並べるには要らない
 *   zoom=1   128x175            **どの記録でも必ず本物が返る**
 *   zoom=2   300x474
 *   zoom=3   575x908 (130KB)    楽天の 600px と並ぶ大きさ。既定はこれ
 */
const BIG_ZOOM = 3;
const SMALL_ZOOM = 1;

/**
 * **絵を持っていない記録は、大きい方を頼むと「image not available」の板が返る。**
 *
 * 404 でもエラーでもなく、200 で灰色の板が返ってくる (2026-09-15 に実測)。
 * 大きさで足切りもできない — 9KB や 46KB あるので `MIN_COVER_BYTES` は素通りする。
 * そのまま焼くと棚に「image not available」が並ぶので、**中身の SHA-256 で弾く**。
 *
 * 板は書名によらず同じ画像なので、ハッシュは zoom ごとに 1 つしかない:
 *
 *   zoom=0,3   575x750    9103B
 *   zoom=2     300x391   15567B
 *   zoom=4     800x1043  46838B
 *   zoom=6    1280x1669  82451B
 */
export const GOOGLE_PLACEHOLDER_COVERS = new Set([
  '3efa8c43e5b4348f303a528c81adf435',
  '12557f8948b8bdc6af436e3a8b3adddd',
  '72c2ffbaccd2444186957aaa2f6fdc8d',
  '92fb4888ef5135122990d60f318d927d',
]);

/**
 * API が返した書影 URL を、焼くのに使える形へ直す。
 *
 * - `http://` で返ってくるので `https://` に直す
 * - `edge=curl` は**ページの端をめくった飾り**が付く。棚に並べる絵には要らない
 * - `zoom` を差し替えて大きさを決める
 */
export function googleImageUrl(url: string | null | undefined, large: boolean): string | null {
  const s = String(url ?? '').trim();
  if (!s) return null;
  const zoom = large ? BIG_ZOOM : SMALL_ZOOM;
  const bare = s.replace(/^http:\/\//, 'https://').replace(/&edge=curl\b/g, '');
  return /[?&]zoom=\d+/.test(bare)
    ? bare.replace(/([?&]zoom=)\d+/, `$1${zoom}`)
    : `${bare}${bare.includes('?') ? '&' : '?'}zoom=${zoom}`;
}

interface RawItem {
  id?: string;
  volumeInfo?: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    industryIdentifiers?: { type?: string; identifier?: string }[];
    imageLinks?: { thumbnail?: string; smallThumbnail?: string };
    infoLink?: string;
  };
  accessInfo?: { viewability?: string; epub?: { isAvailable?: boolean }; pdf?: { isAvailable?: boolean } };
}

/**
 * その記録が**大きい書影を持っているか**。
 *
 * 2026-09-15 に画像リンクのある 18 件で突き合わせたところ、完全に一致した:
 *
 *   epub あり / viewability≠NO_PAGES  → zoom=3 で本物が返る (16 件)
 *   epub なし / viewability=NO_PAGES  → zoom=3 は「image not available」(2 件)
 *
 * 電子版として売っている記録は大きい絵を持ち、書誌だけの記録は 128px の
 * サムネイルしか持たない、という切れ方。**当てが外れても板は焼かれない**
 * (GOOGLE_PLACEHOLDER_COVERS が受け止める) ので、ここは 1 回の取得で済ませるための当て。
 */
function hasLargeCover(it: RawItem): boolean {
  const a = it.accessInfo;
  return Boolean(a?.epub?.isAvailable || a?.pdf?.isAvailable || (a?.viewability && a.viewability !== 'NO_PAGES'));
}

function toRecord(it: RawItem): GoogleRecord {
  const v = it.volumeInfo ?? {};
  const large = hasLargeCover(it);
  const ids = v.industryIdentifiers ?? [];
  const isbn13 = ids.find((x) => x.type === 'ISBN_13')?.identifier;
  const isbn10 = ids.find((x) => x.type === 'ISBN_10')?.identifier;
  return {
    id: String(it.id ?? ''),
    title: String(v.title ?? '').trim(),
    subtitle: String(v.subtitle ?? '').trim() || null,
    author: (v.authors ?? []).map((a) => String(a).trim()).filter(Boolean).join('・') || null,
    publisher: String(v.publisher ?? '').trim() || null,
    publishedDate: String(v.publishedDate ?? '').trim() || null,
    isbn: normalizeIsbn(isbn13 ?? isbn10),
    imageUrl: googleImageUrl(v.imageLinks?.thumbnail ?? v.imageLinks?.smallThumbnail, large),
    large,
    link: v.infoLink ?? null,
  };
}

/**
 * Google のエラーはこの形で来る:
 *   {"error":{"code":403,"message":"…","errors":[{"reason":"keyInvalid", …}]}}
 */
function errorOf(json: Record<string, unknown>): string | null {
  const e = json.error as { code?: number; message?: string; errors?: { reason?: string }[] } | undefined;
  if (!e) return null;
  const reason = e.errors?.[0]?.reason ?? '';
  return `${e.code ?? ''} ${reason}: ${e.message ?? ''}`.replace(/\s+/g, ' ').trim();
}

/** 1 日の枠 (または秒あたりの枠) に届いたか。**鍵の間違いと混ぜない** */
function looksLikeQuotaProblem(status: number, detail: string): boolean {
  return status === 429 || /limitExceeded|quota|rateLimit/i.test(detail);
}

/** 鍵の問題か。上限は上で先に捌いてあるので、ここへは来ない */
function looksLikeAuthProblem(status: number, detail: string): boolean {
  if (status === 401 || status === 403) return true;
  return /keyInvalid|accessNotConfigured|API key|determine user location|forbidden/i.test(detail);
}

export interface GoogleQuery {
  isbn?: string;
  title?: string;
  author?: string;
  /** 返してほしい件数 (1-40)。実際に返るのは 20 件前後で頭打ちになる */
  hits?: number;
  refresh?: boolean;
}

export interface GoogleResult {
  records: GoogleRecord[];
  cached: boolean;
  stale: boolean;
  /** Google が言う総件数。records は hits で切られている */
  count: number;
}

/**
 * **検索語は必ず `intitle:"…"` で括る。** 実測 (2026-09-15):
 *
 *   intitle:"血界戦線 Back 2 Back" inauthor:"内藤泰弘"  →  16 件。全部その作品
 *   intitle:血界戦線 Back 2 Back inauthor:内藤泰弘      →  300 件。語がばらけて散る
 *
 * 括らないと空白で語が割れ、`intitle` に掛かるのは最初の 1 語だけになる。
 *
 * **書名があるうちは `inauthor` を添えてはいけない。** 楽天と同じ罠がある (2026-09-15 に実測):
 *
 *   intitle:"よつばと!" inauthor:"あずまきよひこ"   →  19 件
 *   intitle:"よつばと!" inauthor:"あずま きよひこ"  →   0 件 (空白が 1 つ入るだけ)
 *
 * 手元の著者は蔵書のフォルダ名から取ったもので、Google の表記と揃っている保証がない。
 * **書名だけで引いて、著者は返ってきた行を見て後から確かめる** (authorMatches)。
 */
function fieldQuery(field: string, value: string | null | undefined): string {
  // 引用符そのものは落とす。括りが壊れて語が散るのを防ぐ
  const s = String(value ?? '').replace(/["”“]/g, ' ').trim();
  return s ? `${field}:"${s}"` : '';
}

export async function searchGoogle(db: Db, cfg: Config, q: GoogleQuery): Promise<GoogleResult> {
  const apiKey = cfg.bib.google.apiKey;
  if (!apiKey) {
    throw new GoogleAuthError('Google Books の鍵が設定されていません', '.env の GOOGLE_BOOKS_API_KEY');
  }

  const isbn = normalizeIsbn(q.isbn);
  // ISBN が分かっているならそれ 1 本で引く。書名の表記ゆれを相手にしなくて済む
  const terms = isbn
    ? [`isbn:${isbn}`]
    : [fieldQuery('intitle', q.title), fieldQuery('inauthor', q.author)].filter(Boolean);
  if (!terms.length) throw new Error('isbn か title か author のどれかが要ります');

  // 問い合わせの中身だけで見出しを作る。**鍵は見出しに混ぜない** (cache.ts の cacheUrl)
  const shelf = new URL(ENDPOINT);
  shelf.searchParams.set('q', terms.join(' '));
  shelf.searchParams.set('maxResults', String(Math.min(Math.max(q.hits ?? 40, 1), 40)));
  // 図書だけに絞る。雑誌が混ざると巻数の線が狂う
  shelf.searchParams.set('printType', 'books');
  shelf.searchParams.set('country', COUNTRY);
  shelf.searchParams.sort(); // 並び順で見出しがぶれないように

  const real = new URL(shelf.toString());
  real.searchParams.set('key', apiKey);

  const res = await cachedFetch(db, cfg, {
    provider: 'google',
    url: real.toString(),
    cacheUrl: shelf.toString(),
    refresh: q.refresh,
    // 鍵の間違いと上限超過を焼かない。直った瞬間に通るようになるべきもの
    neverCacheStatuses: [400, 401, 403, 429, 500, 502, 503, 504],
  });

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    throw new Error(`Google Books の応答を読めません (HTTP ${res.status})`);
  }

  const err = errorOf(json);
  if (err) {
    const detail = `HTTP ${res.status} ${err}`;
    // **上限を先に見る。** Google は上限超過も 403 で返すので、
    // 状態コードだけで振り分けると「鍵を確かめてください」と言ってしまう
    if (looksLikeQuotaProblem(res.status, err)) throw new GoogleQuotaError(detail);
    if (looksLikeAuthProblem(res.status, err)) {
      throw new GoogleAuthError('Google Books が受け付けません。鍵を確かめてください', detail);
    }
    throw new Error(`Google Books: ${err}`);
  }

  const items = Array.isArray(json.items) ? (json.items as RawItem[]) : [];
  return {
    records: items.map(toRecord).filter((x) => x.title),
    cached: res.cached,
    stale: res.stale,
    count: Number(json.totalItems ?? items.length),
  };
}

/**
 * ISBN 1 本で引く。**当たれば手元の本と同じ版**だが、絵が付くのは 14% 前後。
 *
 * 1 件だけ貰うのではなく数件貰って、**絵を持っている行を選ぶ**。
 * 同じ ISBN に紙と電子で別の記録が立っていることがあり、絵を持っているのは
 * たいてい後ろの方に並ぶ電子版の側なので、先頭で決め打つと取り逃がす。
 */
export async function findGoogleByIsbn(
  db: Db,
  cfg: Config,
  isbn: string,
  opts: { refresh?: boolean } = {}
): Promise<GoogleRecord | null> {
  const norm = normalizeIsbn(isbn);
  if (!norm) return null;
  const found = await searchGoogle(db, cfg, { isbn: norm, hits: 5, refresh: opts.refresh });
  return (
    found.records.find((r) => r.imageUrl && r.large) ??
    found.records.find((r) => r.imageUrl) ??
    found.records[0] ??
    null
  );
}

// ---------------------------------------------------------------------------
// 書名で引く道 (絵を持っているのはこちら)
// ---------------------------------------------------------------------------

/** 全角数字を半角にして、素の数字だけ読む */
function toNumber(body: string): number | null {
  const half = body.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  return /^\d{1,4}$/.test(half) ? Number(half) : null;
}

function cutVolume(s: string): { title: string; volume: number | null } {
  const paren = s.match(/^(.*?)[\s　]*[(（][\s　]*([0-9０-９]{1,4})[\s　]*[)）]$/);
  if (paren) {
    const n = toNumber(paren[2]);
    if (n !== null) return { title: paren[1].trim(), volume: n };
  }
  // **裸の数字は前に空白がある時だけ巻と読む。** `ゾン100` を巻数扱いしないため
  const bare = s.match(/^(.*\S)[\s　]+([0-9０-９]{1,3})$/);
  if (bare) {
    const n = toNumber(bare[2]);
    if (n !== null) return { title: bare[1].trim(), volume: n };
  }
  return { title: s, volume: null };
}

/**
 * Google の書名から巻数を取り出し、巻の印を落とした書名も返す。
 * 実際に返ってくるのはこの 3 通り (2026-09-15 に実測):
 *
 *   血界戦線 Back 2 Back 5   末尾に裸の数字
 *   よつばと!(16)            括弧書き
 *   よつばと!(14) 14         **同じ巻が二度**書かれている
 */
export function splitGoogleVolume(raw: string): { title: string; volume: number | null } {
  const s = String(raw ?? '').trim();
  const first = cutVolume(s);
  if (first.volume === null) return { title: s, volume: null };
  // 二度書かれている形。落とせるならもう一度落とす
  const again = cutVolume(first.title);
  return again.volume === first.volume ? { title: again.title, volume: first.volume } : first;
}

/** 空白と全半角の揺れを潰して著者を突き合わせる (楽天と同じ扱い) */
function authorMatches(want: string | null | undefined, got: string | null | undefined): boolean {
  const norm = (x: string | null | undefined): string =>
    String(x ?? '').normalize('NFKC').replace(/[\s・,、／/]/g, '').toLowerCase();
  const a = norm(want);
  const b = norm(got);
  // こちらが著者を知らないなら判定しない (突き合わせる材料が無い)
  if (!a || !b) return true;
  return a === b || b.includes(a) || a.includes(b);
}

/**
 * 書名 + 巻数で 1 冊を探す。**絵を持っているのはこちらの道。**
 *
 * ISBN 直引きで当たるのは紙の版の書誌で、絵はたいてい付いていない。
 * 書名で引くと電子版の記録が並び、そちらには 575px の書影が付いている。
 *
 * **別の版の絵が付きうることは承知の上で使う** (楽天の `rakuten-title` と同じ立場)。
 * 電子版は紙と同じ表紙のことが多いが、モノクロ版・完全版のように別物のこともあるので、
 * covers.provider には `google-title` と書いて ISBN 一致のものと区別する。
 *
 * 誤爆を防ぐため 3 つとも通った行しか採らない (楽天と同じ):
 *   1. 巻の印を落とした書名が、こちらの作品名と一致すること (seriesKeyOf で正規化)
 *   2. 巻数が一致すること
 *   3. 著者が食い違わないこと (どちらかが空なら判定しない)
 *
 * 1 が効くので `ONE PIECE モノクロ版 99` は `ONE PIECE` の第99巻として採られない。
 */
export async function findGoogleByTitle(
  db: Db,
  cfg: Config,
  q: { title: string; author?: string | null; volume: number }
): Promise<GoogleRecord | null> {
  const want = seriesKeyOf(q.title);
  if (!want) return null;

  // **著者は渡さない** (fieldQuery の頭)。表記が 1 文字違うだけで 0 件になる
  const found = await searchGoogle(db, cfg, { title: q.title, hits: 40 });
  for (const rec of found.records) {
    if (!rec.imageUrl) continue;
    const split = splitGoogleVolume(rec.title);
    if (split.volume !== q.volume) continue;
    if (seriesKeyOf(split.title) !== want) continue;
    if (!authorMatches(q.author, rec.author)) continue;
    return rec;
  }
  return null;
}
