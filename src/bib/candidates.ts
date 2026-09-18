import { yearOf } from '../published.js';
import { seriesKeyOf } from '../volume.js';
import { type GoogleRecord } from './google.js';
import { ndlThumbnailUrl, type NdlRecord } from './ndl.js';
import { rakutenImageUrl, type RakutenRecord } from './rakuten.js';

/**
 * 「書影の候補」を提供元によらない 1 つの形に揃え、**シリーズの束**にまとめる。
 *
 * ここが要る理由は 1 つ — **同じ作者・同じ書名で別のシリーズが並走している**。
 * 血界戦線がそれで、NDL に `title=血界戦線 creator=内藤泰弘` を投げると
 * 3 つのシリーズが 1 つの答えに混ざって返る (2026-09-15 に実測):
 *
 *   血界戦線             1〜10巻   2010-2015
 *   血界戦線Back 2 Back   1〜10巻   2016-2022
 *   血界戦線Beat 3 Peat    1〜4巻   2023-
 *
 * `byVolume` はこれを 1 本の数直線に畳むので、**第3巻の椅子を Back 2 Back が取る**。
 * 手元の蔵書は無印なのに棚には Back 2 Back の表紙が並ぶ、という壊れ方をする。
 *
 * **機械にはどれが正しいか分からない。** フォルダ名が `血界戦線` である以上は無印だろうと
 * 当たりを付けられるが、`血界戦線 Back 2 Back` というフォルダを作っている人もいる。
 * だから pinax は**束ねて見せるところまで**をやり、「これ」と決めるのは人に渡す
 * (catalog.ts の SeriesIssues と同じ立場)。
 */

export type CandidateProvider = 'ndl' | 'rakuten' | 'google';

/** 書影の候補 1 冊。提供元が違っても画面からは同じ形に見える */
export interface Candidate {
  provider: CandidateProvider;
  /** 提供元が返した生の書名 */
  title: string;
  /** 巻の印と副題を落とした書名。束ねる時の見出しになる */
  baseTitle: string;
  volume: number | null;
  author: string | null;
  publisher: string | null;
  /** 発行時期。「2017.9」「2017年09月04日」など提供元の表記のまま */
  date: string | null;
  year: number | null;
  isbn: string | null;
  /** 書影の元 URL。**焼く前**のもので、画面へは /api/bib/thumb 経由で出す */
  imageUrl: string | null;
  link: string | null;
}

/** 同じシリーズとして束ねた候補 */
export interface CandidateGroup {
  /** 人の選択を残す鍵。`seriesKeyOf(baseTitle)` */
  key: string;
  /**
   * この束に実を出した提供元。**1 つとは限らない。**
   *
   * 同じシリーズを NDL も楽天も知っているのが普通で、それを別々の束に割ると
   * 人は同じものを 2 回見せられた上にどちらかを選ばされる。片方にしか無い巻もある
   * (血界戦線の第3巻は NDL の `dcndl:volume` が「3 (震撃の血槌(ブラッドハンマー))」で
   * 読めず、楽天の `血界戦線（3）` でしか拾えない) ので、**混ぜたまま束ねる**。
   */
  providers: CandidateProvider[];
  /** 見出しに使う書名 */
  title: string;
  /**
   * 束の著者。**提供元の表記のまま**出す (NDL は「内藤, 泰弘」、楽天は「内藤泰弘」)。
   * 著者だけで検索した時に、同じ書名の別作品を見分ける手がかりになる
   */
  author: string | null;
  /**
   * 同じ著者を**棚のフォルダ名に書く形**へ寄せたもの (tidyAuthorName)。
   * `author` が提供元の表記そのままなのに対し、こちらは `[藤田和日郎] …` と
   * 書くための形。名前を組み立てる画面 (/api/names) の既定値になる
   */
  authorName: string | null;
  count: number;
  /** 巻として読めたもの (昇順) */
  volumes: number[];
  volumeMax: number | null;
  firstYear: number | null;
  lastYear: number | null;
  publisher: string | null;
  /** 束の顔になる書影 (一番若い巻のもの) */
  coverUrl: string | null;
  /** 巻順 → 古い順 */
  items: Candidate[];
}

/**
 * 書名の末尾に付く副題を落とす。楽天がこの形で書いてくる:
 *
 *   血界戦線 Back 2 Back 3 -深夜大戦ーDead of night warfare
 *   血界戦線 8 ─幻界病棟ライゼズ─
 *   血界戦線 Beat 3 Peat 4 -Ignite the Rumble!!-
 *
 * **区切りの前に空白を要求する。** 要求しないと `ONE PIECE-ワンピース` のように
 * 区切りが書名の一部になっている作品を削ってしまう。
 */
function stripSubtitle(s: string): string {
  const cut = s.replace(/[\s　]+[-‐–—ー─―].*$/u, '').trim();
  return cut || s;
}

/** 全角数字を半角にして、素の数字だけ読む */
function toNumber(body: string): number | null {
  const half = body.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  return /^\d{1,4}$/.test(half) ? Number(half) : null;
}

/**
 * 提供元の著者表記を、棚のフォルダ名に書く形へ寄せる。
 *
 * NDL は典拠の形で書く — **姓と名がコンマで割れていて、生没年まで付く**:
 *
 *   藤田, 和日郎, 1964-       → 藤田和日郎
 *   三浦, 建太郎, 1966-2021   → 三浦建太郎
 *   Christensen, Troy         → Troy Christensen
 *
 * 棚は `[藤田和日郎]` と詰めて書いているのでそこへ寄せる。欧文だけは詰めずに
 * 「名 姓」へ戻す — SmithJohn にしてしまうと直しようがない。
 *
 * **空白には触らない。** 楽天の `広江 礼威` は姓と名の間の空白だが、棚にある
 * `[西尾維新 暁月あきら]` `[村田雄介 ONE]` は人と人の間の空白で、機械には
 * 見分けが付かない。詰めると 2 人の名前が 1 人に繋がる。ここは寄せるだけにして、
 * 最後は直せる欄に出して人に決めさせる (NDL が `大, 暮維人` と切り違えている
 * 大暮維人のような記録もある)。
 */
export function tidyAuthorName(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  // 生没年は名前ではない。`1964-` `1966-2021`
  const parts = s
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p && !/^\d{3,4}\s*-\s*\d{0,4}$/.test(p));
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  // 仮名も漢字も無ければ欧文。姓が先に来ているので入れ替える
  const latin = !/[\u3040-\u30ff\u3400-\u9fff]/u.test(s);
  return latin ? [...parts].reverse().join(' ') : parts.join('');
}

/**
 * 書名から巻の印を落とし、巻数も取れれば返す。
 *
 * 楽天は巻をこの 3 通りで書く: `血界戦線（10）` `血界戦線Back　2　Back（1）`
 * `血界戦線 8 ─幻界病棟ライゼズ─`。NDL は `dcndl:volume` を別に持っているので、
 * そちらがあればこの結果より優先する。
 *
 * **裸の数字は前に空白がある時だけ巻と読む。** `ゾン100` を巻数扱いしないため。
 */
export function splitCandidateTitle(raw: string): { base: string; volume: number | null } {
  const s = String(raw ?? '').trim();
  if (!s) return { base: '', volume: null };

  // 副題を落とす前に括弧の巻を見る。`血界戦線（10）` は副題を持たない
  const paren = s.match(/^(.*?)[\s　]*[(（][\s　]*([0-9０-９]{1,4})[\s　]*[)）][\s　]*$/);
  if (paren) {
    const n = toNumber(paren[2]);
    if (n !== null) return { base: paren[1].trim(), volume: n };
  }

  const body = stripSubtitle(s);

  const kan = body.match(/^(.*?)[\s　]*第?[\s　]*([0-9０-９]{1,4})[\s　]*巻[\s　]*$/);
  if (kan) {
    const n = toNumber(kan[2]);
    if (n !== null) return { base: kan[1].trim(), volume: n };
  }

  const bare = body.match(/^(.*\S)[\s　]+([0-9０-９]{1,3})$/);
  if (bare) {
    const n = toNumber(bare[2]);
    if (n !== null) return { base: bare[1].trim(), volume: n };
  }

  return { base: body, volume: null };
}

export function ndlCandidate(r: NdlRecord): Candidate {
  const split = splitCandidateTitle(r.title);
  return {
    provider: 'ndl',
    title: r.title,
    baseTitle: split.base || r.title,
    // dcndl:volume が正。書名から読んだ巻は、それが取れなかった時の当て
    volume: r.volume ?? split.volume,
    author: r.creator,
    publisher: r.publisher,
    date: r.date,
    year: yearOf(r.date),
    isbn: r.isbn,
    imageUrl: r.isbn ? ndlThumbnailUrl(r.isbn) : null,
    link: r.link,
  };
}

/**
 * Google の候補。**書影 URL は記録の中で既に決まっている** (bib/google.ts の googleImageUrl) —
 * 絵を持っている記録には 575px、書誌だけの記録には 128px のサムネイルが入る。
 */
export function googleCandidate(r: GoogleRecord): Candidate {
  const split = splitCandidateTitle(r.title);
  return {
    provider: 'google',
    title: r.title,
    baseTitle: split.base || r.title,
    volume: split.volume,
    author: r.author,
    publisher: r.publisher,
    date: r.publishedDate,
    year: yearOf(r.publishedDate),
    isbn: r.isbn,
    imageUrl: r.imageUrl,
    link: r.link,
  };
}

export function rakutenCandidate(r: RakutenRecord, imageSize: number): Candidate {
  const split = splitCandidateTitle(r.title);
  return {
    provider: 'rakuten',
    title: r.title,
    baseTitle: split.base || r.title,
    volume: split.volume,
    author: r.author,
    publisher: r.publisher,
    date: r.salesDate,
    year: yearOf(r.salesDate),
    isbn: r.isbn,
    imageUrl: rakutenImageUrl(r.imageUrl, imageSize),
    link: r.itemUrl,
  };
}

/**
 * 発行時期を比べられる数にする。提供元で書き方が違うので、そのまま比べてはいけない:
 *
 *   NDL   2011.5        2015
 *   楽天  2011年05月02日  2019年12月04日頃
 *
 * 文字列のまま比べると `2011.` と `2011年` の並びで**たまたま** NDL が先に来るだけの、
 * 理由の説明できない順になる。年月まで揃えてから比べる。
 */
function dateKeyOf(date: string | null): number {
  const s = String(date ?? '');
  const y = s.match(/(?:19|20)\d{2}/);
  if (!y) return 999_912;
  const rest = s.slice((y.index ?? 0) + 4);
  const m = rest.match(/\d{1,2}/);
  return Number(y[0]) * 100 + Math.min(Math.max(m ? Number(m[0]) : 1, 1), 12);
}

/**
 * 提供元の優先。**書誌は NDL の方が信頼できる** (巻ごとの ISBN が素直に取れる)。
 * Google を最後に置くのは、絵を持っている記録が電子版に偏っていて
 * ISBN を持たないものが多いため (bib/google.ts)。
 */
const PROVIDER_RANK: Record<CandidateProvider, number> = { ndl: 0, rakuten: 1, google: 2 };

/** 巻順 → 古い順 → NDL 優先。巻の読めないものは後ろへ回す */
function byVolumeThenDate(a: Candidate, b: Candidate): number {
  if (a.volume !== b.volume) {
    if (a.volume === null) return 1;
    if (b.volume === null) return -1;
    return a.volume - b.volume;
  }
  return dateKeyOf(a.date) - dateKeyOf(b.date) || PROVIDER_RANK[a.provider] - PROVIDER_RANK[b.provider];
}

/** 一番多く現れた書き方を採る。同数なら短い方 (余計な飾りの付いていない方) */
function majority(values: (string | null)[]): string | null {
  const tally = new Map<string, number>();
  for (const v of values) {
    const s = String(v ?? '').trim();
    if (s) tally.set(s, (tally.get(s) ?? 0) + 1);
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] ?? null;
}

function toGroup(key: string, items: Candidate[]): CandidateGroup {
  const sorted = [...items].sort(byVolumeThenDate);
  const volumes = [...new Set(sorted.map((x) => x.volume).filter((v): v is number => v !== null))]
    .sort((a, b) => a - b);
  const years = sorted.map((x) => x.year).filter((y): y is number => y !== null).sort((a, b) => a - b);

  // 見出しは**一番多く現れた書き方**を採る。`血界戦線Back 2 Back` と `血界戦線back 2 back`
  // のように大小や空白だけ違う版が混ざるので、多数決で落ち着かせる
  const title = majority(sorted.map((x) => x.baseTitle)) ?? '';
  // 著者も同じく多数決。巻によって「原作」「作画」の片方しか載らないことがある
  const author = majority(sorted.map((x) => x.author));

  return {
    key,
    providers: [...new Set(sorted.map((x) => x.provider))].sort(
      (a, b) => PROVIDER_RANK[a] - PROVIDER_RANK[b]
    ),
    title,
    author,
    authorName: tidyAuthorName(author),
    count: sorted.length,
    volumes,
    volumeMax: volumes.length ? volumes[volumes.length - 1] : null,
    firstYear: years[0] ?? null,
    lastYear: years[years.length - 1] ?? null,
    publisher: sorted.find((x) => x.publisher)?.publisher ?? null,
    coverUrl: sorted.find((x) => x.imageUrl)?.imageUrl ?? null,
    items: sorted,
  };
}

/**
 * 候補をシリーズの束にまとめる。
 *
 * 束ねる鍵は `seriesKeyOf(baseTitle)`。副題は**落とさない** —
 * `ふしぎ遊戯 玄武開伝` のように副題が本当に別シリーズであることがあるため。
 *
 * ただしそれだけだと、NDL が巻ごとの副題を書名へ差し込む癖
 * (`血界戦線 : 魔封街結社` = 無印の第1巻) でシリーズが 1 冊ずつに割れる。
 * そこで最後に **1 件しかない束を、書名がその頭に乗っている束へ畳む**:
 *
 *   血界戦線魔封街結社 (1件)   → 血界戦線 (11件) へ畳む   巻ごとの副題だった
 *   血界戦線back2back (11件)   → 畳まない                 別シリーズ
 *
 * **巻ごとの副題は 1 冊にしか現れない。別シリーズなら何冊も並ぶ。** この差で切る。
 */
export function groupCandidates(items: Candidate[]): CandidateGroup[] {
  const buckets = new Map<string, Candidate[]>();
  for (const c of items) {
    const key = seriesKeyOf(c.baseTitle);
    if (!key) continue;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(c);
    else buckets.set(key, [c]);
  }

  // 畳み先は「2 件以上ある束」だけ。長い鍵から見て、一番近い親へ寄せる
  const parents = [...buckets.entries()]
    .filter(([, v]) => v.length >= 2)
    .map(([k]) => k)
    .sort((a, b) => b.length - a.length);

  for (const [key, list] of [...buckets.entries()]) {
    if (list.length !== 1) continue;
    const parent = parents.find((p) => p !== key && key.startsWith(p));
    if (!parent) continue;
    buckets.get(parent)!.push(...list);
    buckets.delete(key);
  }

  return [...buckets.entries()]
    .map(([key, list]) => toGroup(key, list))
    // 巻の揃っている束を上に出す。人が最初に見るのは「10巻ぶん並んでいる方」
    .sort((a, b) => b.volumes.length - a.volumes.length || b.count - a.count);
}

/**
 * 束の中から「この巻」の 1 冊を選ぶ。
 * 同じ巻に版が複数あれば**古い方**を採る (初版が原則その作品の顔。byVolume と同じ判断)。
 */
export function pickVolume(group: CandidateGroup, volume: number): Candidate | null {
  const mine = group.items.filter((x) => x.volume === volume);
  if (!mine.length) return null;
  // items は既に byVolumeThenDate で並んでいる。先頭が「一番古い版、同じなら NDL」
  return mine[0];
}

/**
 * 束の中で**この巻の絵を持っている候補**を、画面に並んでいるのと同じ順で返す。
 *
 * `pickVolume` の 1 冊とは用途が違う。あちらが選ぶのは**書誌の正**なので初版を採るが、
 * **古い版ほど書影を持っていない。** NDL の候補は ISBN さえあれば書影 URL が付くものの、
 * 実際にサムネイルがあるのは半分ほどで、URL の有無では持っているかどうかが分からない
 * (2026-09-17 に ARMS で実測: 1997年の初版は全巻 404、2007年と2014年の新装版は全部あった)。
 *
 * だから絵は**1 冊に賭けず、束が出せる分を順に試す**。これが無いと、
 * 「表紙を選ぶ」画面には新装版の書影が並んで見えているのに、選んだ途端に
 * 初版の 404 だけを試して束の外へ落ちていく — 画面に一度も出なかった絵が棚に載る。
 *
 * `volume` に null を渡すと束の全部 (作品の代表表紙を探す時に使う)。
 */
export function imageCandidatesOf(group: CandidateGroup, volume: number | null): Candidate[] {
  return group.items.filter((c) => c.imageUrl && (volume === null || c.volume === volume));
}

/**
 * 束を「巻 → 1 冊」の対応表にする。
 * 巻として読めなかったものは落ちる (数直線に乗せられないため)。
 */
export function byVolumeOf(group: CandidateGroup): Map<number, Candidate> {
  const map = new Map<number, Candidate>();
  for (const v of group.volumes) {
    const c = pickVolume(group, v);
    if (c) map.set(v, c);
  }
  return map;
}
