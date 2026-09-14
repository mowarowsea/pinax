import type { Db } from '../db.js';
import type { Config } from '../config.js';
import { cachedFetch } from './cache.js';
import { findVolumeIn, seriesKeyOf } from '../volume.js';

/**
 * 国立国会図書館サーチ (NDLサーチ) の OpenSearch。
 *
 * **キー登録が要らず、巻ごとの ISBN まで返る**のでここを主軸にする。
 * 実測 (2026-09-12、手元の 6 作品 121 巻):
 *
 *   title だけ           … CD・DVD・アンソロジーが混ざって使い物にならない
 *   title + creator      … 巻ごとに 1 件ずつ並び、ISBN の取得率 121/121
 *   mediatype=books      … 図書だけに絞れる (これが無いと録音資料が混ざる)
 *
 * **著者を必ず添えること。** 蔵書のフォルダ名 `[著者] 作品名` が著者を持っているので、
 * pinax はこの条件を常に満たせる。著者無しで引くと精度が落ちる。
 *
 * XML を正規表現で読んでいるのは、依存を足さないため。NDL の RSS は 1 階層で
 * 入れ子が無く、item の中に同じタグが 2 度出るのは identifier だけなので、
 * これで足りる。崩れたら raw をそのまま持っているので後から直せる。
 */

const ENDPOINT = 'https://ndlsearch.ndl.go.jp/api/opensearch';

export interface NdlRecord {
  title: string;
  /** dcndl:volume。「3」「第2層」など、数字とは限らない */
  volumeRaw: string | null;
  /** volumeRaw が素の数字なら、その値 */
  volume: number | null;
  creator: string | null;
  publisher: string | null;
  /** 出版年。「2024」または「2024-08-01」 */
  date: string | null;
  isbn: string | null;
  link: string | null;
}

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1].trim()) : null;
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** ISBN からハイフンを落とす。NDL は `978-4-8124-8380-0` と `9784812483800` を混ぜて返す */
export function normalizeIsbn(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').replace(/[^0-9xX]/g, '').toUpperCase();
  return s.length === 10 || s.length === 13 ? s : null;
}

export function parseNdlXml(xml: string): NdlRecord[] {
  const out: NdlRecord[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1];
    // ISBN13 を優先。無ければ ISBN
    const isbn13 = item.match(/<dc:identifier xsi:type="dcndl:ISBN13">([^<]+)</);
    const isbn10 = item.match(/<dc:identifier xsi:type="dcndl:ISBN">([^<]+)</);
    const volumeRaw = tag(item, 'dcndl:volume');
    out.push({
      title: tag(item, 'dc:title') ?? tag(item, 'title') ?? '',
      volumeRaw,
      volume: volumeRaw && /^\d{1,4}$/.test(volumeRaw) ? Number(volumeRaw) : null,
      creator: tag(item, 'dc:creator'),
      publisher: tag(item, 'dc:publisher'),
      date: tag(item, 'dcterms:issued') ?? tag(item, 'dc:date'),
      isbn: normalizeIsbn(isbn13?.[1] ?? isbn10?.[1]),
      link: tag(item, 'link'),
    });
  }
  return out;
}

/**
 * 蔵書の著者欄から、NDL に投げる候補を作る。
 *
 * フォルダ名の著者は**合作をそのまま 1 つの文字列にしている**:
 *
 *   [山川直輝×奈央晃徳]  [岩明均×室井大資]   … 原作×作画
 *   [西尾維新 暁月あきら]  [村田雄介 ONE]      … 空白区切り
 *   [BETEMIUS (バシウス)]                      … 別名を括弧で
 *
 * この丸ごとを creator に渡すと NDL は 0 件を返す (2026-09-12 に実測。
 * 「100万の命の上に俺は立っている」が 0 件になったのがこれ)。区切って
 * **1 人ずつ試す**と当たる。順に試して、最初に実の取れた候補を採る。
 */
export function authorVariants(author: string | null | undefined): string[] {
  const raw = String(author ?? '').trim();
  if (!raw) return [];
  const out = [raw];
  // 括弧の中は別名。まず括弧を落とした形を試す
  const noParen = raw.replace(/[(（][^)）]*[)）]/g, '').trim();
  if (noParen && noParen !== raw) out.push(noParen);
  // 合作の区切り。作画だけ・原作だけでも当たれば十分
  for (const part of noParen.split(/[×✕x✖・,、\/／]|\s+/)) {
    const p = part.trim();
    if (p && p.length >= 2 && !out.includes(p)) out.push(p);
  }
  return out;
}

export interface NdlQuery {
  title: string;
  creator?: string | null;
  /** 取得件数。巻数の多い作品があるので既定を大きめに取る */
  count?: number;
  refresh?: boolean;
}

export interface NdlSearchResult {
  records: NdlRecord[];
  cached: boolean;
  stale: boolean;
  /** 実際に当たった creator。null なら著者無しで引いた */
  usedCreator: string | null;
  /** 試した回数。無駄打ちが増えていないか見るため */
  attempts: number;
}

async function once(
  db: Db, cfg: Config, title: string, creator: string | null, count: number, refresh?: boolean
): Promise<{ records: NdlRecord[]; cached: boolean; stale: boolean }> {
  const params = new URLSearchParams({ title, mediatype: 'books', cnt: String(Math.min(count, 500)) });
  // 著者は「あれば足す」。空文字を送ると 0 件になる
  if (creator) params.set('creator', creator);
  const res = await cachedFetch(db, cfg, { provider: 'ndl', url: `${ENDPOINT}?${params}`, refresh });
  if (res.status !== 200) return { records: [], cached: res.cached, stale: res.stale };
  return { records: parseNdlXml(res.body), cached: res.cached, stale: res.stale };
}

/**
 * 作品 1 つぶんを引く。応答は生の XML のままキャッシュに焼かれる。
 *
 * 著者の候補を順に試し、**巻と ISBN の揃った実が一番多かったもの**を採る。
 * 全部空振りなら最後に著者無しで引く — 著者無しは CD や別作品が混ざるので
 * 最後の手段だが、「何も出ない」よりは人が選べる材料がある方がよい。
 */
export async function searchNdl(db: Db, cfg: Config, q: NdlQuery): Promise<NdlSearchResult> {
  const count = q.count ?? 100;
  const variants = authorVariants(q.creator);
  let best: NdlSearchResult = { records: [], cached: false, stale: false, usedCreator: null, attempts: 0 };
  let bestScore = -1;

  for (const creator of variants) {
    const r = await once(db, cfg, q.title, creator, count, q.refresh);
    best.attempts++;
    const score = r.records.filter((x) => x.isbn && x.volume !== null).length;
    if (score > bestScore) {
      bestScore = score;
      best = { ...r, usedCreator: creator, attempts: best.attempts };
    }
    // 巻が 2 つ以上揃ったらそれ以上試さない。無駄に外を叩かない
    if (score >= 2) return best;
  }

  if (bestScore <= 0) {
    const r = await once(db, cfg, q.title, null, count, q.refresh);
    best.attempts++;
    if (r.records.length) best = { ...r, usedCreator: null, attempts: best.attempts };
  }
  return best;
}

/**
 * 書名を突き合わせるためのキー候補。
 *
 * NDL は**読みを括弧で書名に差し込む**ことがある (2026-09-12 に確認):
 *
 *   手元: 恋愛ラボ            NDL: 恋愛 (ラブ) ラボ
 *
 * seriesKeyOf は括弧を落とすが中身は残すので `恋愛ラブラボ` になり、
 * 素直に比べると一致しない。**括弧の中身ごと落とした形も候補に入れる。**
 * 逆に中身を常に落とすと、括弧が作品名の一部である作品を潰すので両方持つ。
 */
function titleKeys(title: string): string[] {
  const keys = new Set<string>();
  const raw = String(title ?? '');
  keys.add(seriesKeyOf(raw));
  const stripped = raw.replace(/[(（][^)）]*[)）]/g, '');
  keys.add(seriesKeyOf(stripped));
  // 「作品名 : 副題」「作品名 = 英題」は副題側を落とした形も見る
  keys.add(seriesKeyOf(stripped.split(/\s[:=]\s/)[0]));
  keys.delete('');
  return [...keys];
}

/** どちらかの候補どうしが前方一致すれば同じ作品とみなす */
function titlesMatch(want: string[], got: string[]): boolean {
  for (const w of want) {
    for (const g of got) {
      if (w.startsWith(g) || g.startsWith(w)) return true;
    }
  }
  return false;
}

/** NDL の書影。ISBN さえあれば引ける (キー不要) */
export function ndlThumbnailUrl(isbn: string): string {
  return `https://ndlsearch.ndl.go.jp/thumbnail/${isbn}.jpg`;
}

/**
 * 蔵書の 1 作品に対して「巻 → 書誌」の対応表を作る。
 *
 * - `dcndl:volume` が無い版があるので、**無ければ書名から巻数を読む**。
 *   解釈は volume.ts に任せる (蔵書のファイル名と同じ読み方をさせるため)
 * - 同じ巻が複数版 (新装版・文庫版) で返るので **古い方を採る** — 初版が原則
 *   その作品の顔で、後から出た版は表紙が差し替わっていることが多い
 * - `expectTitle` を渡すと、書名のキーがそれと噛み合わないものを落とす。
 *   著者無しで引いた時に別作品が紛れ込むのを止めるため
 */
export function byVolume(records: NdlRecord[], expectTitle?: string | null): Map<number, NdlRecord> {
  const want = expectTitle ? titleKeys(expectTitle) : null;
  const map = new Map<number, NdlRecord>();
  for (const r of records) {
    if (!r.isbn) continue;

    let volume = r.volume;
    if (volume === null) {
      const { match } = findVolumeIn(r.title);
      // 範囲物 (合本) は巻を 1 つに結び付けられないので採らない
      if (match && match.from === match.to) volume = match.from;
    }
    if (volume === null) continue;

    if (want && !titlesMatch(want, titleKeys(r.title))) continue;

    const cur = map.get(volume);
    if (!cur) {
      map.set(volume, r);
      continue;
    }
    if (String(r.date ?? '9999') < String(cur.date ?? '9999')) map.set(volume, r);
  }
  return map;
}
