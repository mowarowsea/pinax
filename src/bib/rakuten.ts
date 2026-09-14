import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { cachedFetch } from './cache.js';
import { normalizeIsbn } from './ndl.js';
import { seriesKeyOf } from '../volume.js';

/**
 * 楽天ブックス書籍検索 API のアダプタ。
 *
 * pinax における役割は 1 つだけ — **NDL が書影を持っていない巻を埋める。**
 * 書誌そのものは NDL の方が信頼できる (巻ごとの ISBN が素直に取れる) ので、
 * ここは表紙の供給源として使う。実測でそうなった:
 *
 *   NDL サムネイル  … ISBN のうち約半分しか画像が無い
 *   楽天ブックス    … ISBN 直引きで 3/3 命中、全部に画像 (2026-09-14)
 *
 * 手元の蔵書では **ISBN は分かっているのに表紙が無い巻が 2703 件**ある。
 * そこが楽天で埋まる。ISBN で引く限り書名の表記ゆれ (「日常（十二）」のように
 * 楽天は巻数を漢数字の全角括弧で書く) を相手にしなくて済むのも大きい。
 *
 * 外へ出るのは cache.ts の一本だけ、という原則はここでも変えない。
 */

/**
 * 2026 年の刷新で**ドメインもパスも認証も変わった**。
 * 旧 `app.rakuten.co.jp/services/api/…` は 2026-05-14 に止まっている。
 * 新しい口は applicationId と accessKey の**両方**をクエリに要求する
 * (2026-09-14 に実測。片方だけだと 400 `wrong_parameter` / 401 `invalid_token`)。
 */
const ENDPOINT = 'https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404';

export interface RakutenRecord {
  title: string;
  author: string | null;
  publisher: string | null;
  /** 発売日。「2024年08月30日」の形で来る */
  salesDate: string | null;
  isbn: string | null;
  seriesName: string | null;
  /** 一番大きい書影 (既定で 200x200)。大きさは rakutenImageUrl で差し替える */
  imageUrl: string | null;
  itemUrl: string | null;
}

/**
 * こちら側の設定が間違っている時の失敗。相手の不調とは**必ず分けて扱う**。
 *
 * 楽天は登録した接続元 IP からしか通さない。回線の都合でグローバル IP が変わると
 * ここに落ちるが、それは楽天が壊れているのではなく、楽天の管理画面に今の IP を
 * 足せば直る。呼び出し側はこれを見たら「楽天を今回は諦めて NDL で続ける」のではなく
 * **人に知らせる**のが正しい。
 */
export class RakutenAuthError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message);
    this.name = 'RakutenAuthError';
  }
}

export function rakutenReady(cfg: Config): boolean {
  const r = cfg.bib.rakuten;
  return Boolean(r.applicationId && r.accessKey) && cfg.bib.providers.includes('rakuten');
}

/**
 * 書影 URL の大きさを差し替える。
 * 楽天の画像は `...jpg?_ex=200x200` の形で、この数字を変えるとその場で大きいものが返る。
 */
export function rakutenImageUrl(url: string | null | undefined, size: number): string | null {
  const s = String(url ?? '').trim();
  if (!s) return null;
  const px = `${size}x${size}`;
  return /_ex=\d+x\d+/.test(s) ? s.replace(/_ex=\d+x\d+/, `_ex=${px}`) : `${s}${s.includes('?') ? '&' : '?'}_ex=${px}`;
}

interface RawItem {
  title?: string;
  author?: string;
  publisherName?: string;
  salesDate?: string;
  isbn?: string;
  seriesName?: string;
  largeImageUrl?: string;
  mediumImageUrl?: string;
  smallImageUrl?: string;
  itemUrl?: string;
}

function toRecord(it: RawItem): RakutenRecord {
  return {
    title: String(it.title ?? '').trim(),
    author: String(it.author ?? '').trim() || null,
    publisher: String(it.publisherName ?? '').trim() || null,
    salesDate: String(it.salesDate ?? '').trim() || null,
    isbn: normalizeIsbn(it.isbn),
    seriesName: String(it.seriesName ?? '').trim() || null,
    imageUrl: it.largeImageUrl || it.mediumImageUrl || it.smallImageUrl || null,
    itemUrl: it.itemUrl || null,
  };
}

/**
 * 楽天が返すエラーは 2 通りの形をしている。両方見る:
 *   {"error":"invalid_token","error_description":"specify valid access token"}
 *   {"errors":{"errorCode":400,"errorMessage":"accessKey must be present …"}}
 */
function errorOf(json: Record<string, unknown>): string | null {
  if (typeof json.error === 'string') {
    return `${json.error}: ${String(json.error_description ?? '')}`.trim();
  }
  const e = json.errors as Record<string, unknown> | undefined;
  if (e && (e.errorCode || e.errorMessage)) return `${String(e.errorCode ?? '')}: ${String(e.errorMessage ?? '')}`.trim();
  return null;
}

/** 鍵・接続元 IP の問題か。相手の不調 (一時的) と区別する印 */
function looksLikeAuthProblem(status: number, detail: string): boolean {
  if (status === 401 || status === 403) return true;
  return /applicationId|access.?token|access.?key|CLIENT_IP_NOT_ALLOWED|not.?allowed|forbidden/i.test(detail);
}

export interface RakutenQuery {
  isbn?: string;
  title?: string;
  author?: string;
  /** 返してほしい件数 (1-30) */
  hits?: number;
  refresh?: boolean;
}

export interface RakutenResult {
  records: RakutenRecord[];
  cached: boolean;
  stale: boolean;
  /** 楽天が言う総件数。records は hits で切られている */
  count: number;
}

export async function searchRakuten(db: Db, cfg: Config, q: RakutenQuery): Promise<RakutenResult> {
  const r = cfg.bib.rakuten;
  if (!r.applicationId || !r.accessKey) {
    throw new RakutenAuthError('楽天の鍵が設定されていません', '.env の RAKUTEN_APPLICATION_ID / RAKUTEN_ACCESS_KEY');
  }

  // 問い合わせの中身だけで見出しを作る。**鍵は見出しに混ぜない** (cache.ts の cacheUrl)
  const shelf = new URL(ENDPOINT);
  shelf.searchParams.set('format', 'json');
  shelf.searchParams.set('hits', String(Math.min(Math.max(q.hits ?? 30, 1), 30)));
  const isbn = normalizeIsbn(q.isbn);
  if (isbn) shelf.searchParams.set('isbn', isbn);
  if (q.title) shelf.searchParams.set('title', q.title);
  if (q.author) shelf.searchParams.set('author', q.author);
  if (!isbn && !q.title && !q.author) throw new Error('isbn か title か author のどれかが要ります');
  shelf.searchParams.sort(); // 並び順で見出しがぶれないように

  const real = new URL(shelf.toString());
  real.searchParams.set('applicationId', r.applicationId);
  real.searchParams.set('accessKey', r.accessKey);
  if (r.affiliateId) real.searchParams.set('affiliateId', r.affiliateId);

  const res = await cachedFetch(db, cfg, {
    provider: 'rakuten',
    url: real.toString(),
    cacheUrl: shelf.toString(),
    refresh: q.refresh,
    // 鍵や IP の間違いを焼かない。直した瞬間に通るようになるべきもの
    neverCacheStatuses: [400, 401, 403, 429, 500, 502, 503, 504],
  });

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    throw new Error(`楽天の応答を読めません (HTTP ${res.status})`);
  }

  const err = errorOf(json);
  if (err) {
    if (looksLikeAuthProblem(res.status, err)) {
      throw new RakutenAuthError(
        '楽天が受け付けません。鍵か、登録した接続元 IP を確かめてください',
        `HTTP ${res.status} ${err}`
      );
    }
    throw new Error(`楽天: ${err}`);
  }

  const items = Array.isArray(json.Items) ? (json.Items as { Item?: RawItem }[]) : [];
  return {
    records: items.map((w) => toRecord(w.Item ?? {})).filter((x) => x.title),
    cached: res.cached,
    stale: res.stale,
    count: Number(json.count ?? items.length),
  };
}

/** ISBN 1 本で引く。表記ゆれを相手にしなくて済むので、**使えるなら必ずこちらを使う** */
export async function findRakutenByIsbn(
  db: Db,
  cfg: Config,
  isbn: string,
  opts: { refresh?: boolean } = {}
): Promise<RakutenRecord | null> {
  const norm = normalizeIsbn(isbn);
  if (!norm) return null;
  const found = await searchRakuten(db, cfg, { isbn: norm, hits: 1, refresh: opts.refresh });
  return found.records[0] ?? null;
}

// ---------------------------------------------------------------------------
// 書名だけで引く道 (ISBN で外れた古い巻のため)
// ---------------------------------------------------------------------------

/**
 * **`author` を渡してはいけない。** 実測 (2026-09-14):
 *
 *   title=よつばと!  author=あずま きよひこ  →  0 件
 *   title=よつばと!  author 無し             →  16 件 (著者は「あずま　きよひこ」で入っている)
 *
 * 楽天の著者欄は全角スペース区切りの表記で入っていて、こちらの持っている
 * `あずまきよひこ` とも `あずま きよひこ` とも噛み合わない。渡すと必ず 0 件になる。
 * **書名だけで引いて、著者は取れた行を見て後から確かめる。**
 */

const KANJI_DIGITS: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 「十二」「二十三」「十」などを数にする。巻数なので 99 まで読めれば足りる */
function kanjiToNumber(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (!/^[〇零一二三四五六七八九十]+$/.test(s)) return null;
  const at = s.indexOf('十');
  if (at < 0) {
    let n = 0;
    for (const ch of s) {
      const d = KANJI_DIGITS[ch];
      if (d === undefined) return null;
      n = n * 10 + d;
    }
    return n;
  }
  const tens = at === 0 ? 1 : KANJI_DIGITS[s[at - 1]] ?? null;
  const ones = at === s.length - 1 ? 0 : KANJI_DIGITS[s[at + 1]] ?? null;
  if (tens === null || ones === null) return null;
  return tens * 10 + ones;
}

/**
 * 楽天の書名から巻数を取り出し、巻の印を落とした書名も返す。
 * 楽天はこの 3 通りで書いてくる:
 *   よつばと!(16)      半角括弧 + 算用数字
 *   日常（十二）        全角括弧 + 漢数字
 *   ◯◯ 第3巻          素直な形
 */
export function splitRakutenVolume(title: string): { title: string; volume: number | null } {
  const s = String(title ?? '').trim();

  const paren = s.match(/^(.*?)\s*[(（]\s*([0-9０-９〇零一二三四五六七八九十]+)\s*[)）]\s*$/);
  if (paren) {
    const body = paren[2].replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    const n = /^[0-9]+$/.test(body) ? Number(body) : kanjiToNumber(paren[2]);
    if (n !== null && n >= 0) return { title: paren[1].trim(), volume: n };
  }

  const kan = s.match(/^(.*?)\s*第?\s*([0-9０-９]{1,4}|[〇零一二三四五六七八九十]+)\s*巻\s*$/);
  if (kan) {
    const body = kan[2].replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    const n = /^[0-9]+$/.test(body) ? Number(body) : kanjiToNumber(kan[2]);
    if (n !== null && n >= 0) return { title: kan[1].trim(), volume: n };
  }

  return { title: s, volume: null };
}

/** 空白と全半角の揺れを潰して著者を突き合わせる。楽天は「あずま　きよひこ」と全角空白で入れてくる */
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
 * 書名 + 巻数で 1 冊を探す。**ISBN で当たらなかった時だけ使う最後の手。**
 *
 * 古い巻は楽天の在庫に無く、ISBN 直引きでは当たらない (手元の実測で、2000 年より前の巻は
 * 2 割も取れなかった)。ただし**版を刷り直したもの**は載っていることがあり、
 * そちらには書影が付いている。`封神演義` は原作コミックスでは当たらないが
 * 2015 年の文庫版で全巻当たる、という具合。
 *
 * **別の版の表紙が付きうることは承知の上で使う。** 手元の本と絵が違う可能性があるので、
 * covers.provider には `rakuten-title` と書いて ISBN 一致のものと区別できるようにする。
 *
 * 誤爆を防ぐため 3 つとも通った行しか採らない:
 *   1. 巻の印を落とした書名が、こちらの作品名と一致すること (seriesKeyOf で正規化)
 *   2. 巻数が一致すること
 *   3. 著者が食い違わないこと (どちらかが空なら判定しない)
 *
 * 3 を緩くしているのは、楽天の著者欄が原作/作画をまとめて書いていたり空だったりするため。
 * 1 と 2 が通っていれば、ほぼ取り違えない。
 */
export async function findRakutenByTitle(
  db: Db,
  cfg: Config,
  q: { title: string; author?: string | null; volume: number }
): Promise<RakutenRecord | null> {
  const want = seriesKeyOf(q.title);
  if (!want) return null;

  const found = await searchRakuten(db, cfg, { title: q.title, hits: 30 });
  for (const rec of found.records) {
    if (!rec.imageUrl) continue;
    const split = splitRakutenVolume(rec.title);
    if (split.volume !== q.volume) continue;
    if (seriesKeyOf(split.title) !== want) continue;
    if (!authorMatches(q.author, rec.author)) continue;
    return rec;
  }
  return null;
}
