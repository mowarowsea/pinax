import type { Config } from '../config.js';
import { sideSlot, slotLabel, type CoverSlot } from '../cover-slot.js';
import type { Db } from '../db.js';
import { restAfterFolderTitle } from '../naming.js';
import { seriesKeyOf } from '../volume.js';
import { ProviderStopError } from './cache.js';
import { ndlCandidate, type Candidate } from './candidates.js';
import {
  coverPinnedAt, fetchAndBurn, fetchCover, hasCoverAt, imageHostAllowed, writeCover,
} from './covers.js';
import { ndlThumbnailUrl, type NdlRecord } from './ndl.js';

/**
 * **書誌と表紙を棚へ貼る手順**を 1 本にまとめたところ。
 *
 * 貼りに来る道は 2 つある — 書名から自動で当てる道 (enrich.ts) と、人が選んだ束を
 * 正とする道 (pick.ts)。どちらも「外に聞く」ところは別物だが、**聞いた後にやること
 * (bib へ 1 行置く / 板ごとに絵を焼く) は同じ**で、以前はほぼ同じ形が 2 本あった。
 *
 * 別巻の表紙を足すとそれが 3 本になるので、ここへ寄せた。片方だけ直して
 * 「自動では埋まるのに選び直すと埋まらない」が起きるのが一番たちが悪い。
 */

// ---- 書誌 1 行 ----------------------------------------------------------

/**
 * bib の 1 行にするだけの形。NDL の記録 (NdlRecord) も候補 (Candidate) も
 * ここへ寄せてから書く。**提供元ごとの形を SQL の手前で吸収する**
 */
export interface BibEntry {
  provider: string;
  isbn: string | null;
  title: string | null;
  author: string | null;
  publisher: string | null;
  pubdate: string | null;
  coverUrl: string | null;
  /** 加工前のまま残す。解釈を後から直せるようにするため (db.ts の bib 表) */
  raw: unknown;
}

/** NDL の 1 件。書影 URL は ISBN から組み立てる (記録そのものには入っていない) */
export function bibOfNdl(r: NdlRecord): BibEntry {
  return {
    provider: 'ndl',
    isbn: r.isbn,
    title: r.title,
    author: r.creator,
    publisher: r.publisher,
    pubdate: r.date,
    coverUrl: r.isbn ? ndlThumbnailUrl(r.isbn) : null,
    raw: r,
  };
}

/** 束の 1 冊 */
export function bibOfCandidate(c: Candidate): BibEntry {
  return {
    provider: c.provider,
    isbn: c.isbn,
    title: c.title,
    author: c.author,
    publisher: c.publisher,
    pubdate: c.date,
    coverUrl: c.imageUrl,
    raw: c,
  };
}

/** bib に 1 行置く。`volumeNo` が null なら作品そのものの書誌 (巻なし) */
export function writeBib(db: Db, seriesId: number, volumeNo: number | null, e: BibEntry): void {
  db.raw
    .prepare(
      `INSERT INTO bib (series_id, volume_no, provider, isbn, title, author, publisher, pubdate, cover_url, raw, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(series_id, volume_no, provider) DO UPDATE SET
         isbn = excluded.isbn, title = excluded.title, author = excluded.author,
         publisher = excluded.publisher, pubdate = excluded.pubdate, cover_url = excluded.cover_url,
         raw = excluded.raw, fetched_at = excluded.fetched_at`
    )
    .run(
      seriesId, volumeNo, e.provider, e.isbn, e.title, e.author, e.publisher, e.pubdate,
      e.coverUrl, JSON.stringify(e.raw), new Date().toISOString()
    );
}

// ---- 表紙を板ごとに焼く --------------------------------------------------

/**
 * 1 枚の板に出せる絵の当て。**2 段構えなのは、どちらも外すことがあるから。**
 *
 *   images … 候補として画面に並んでいる絵。人が見たものと棚が食い違わない
 *   isbn   … 絵が 1 枚も焼けなかった時に、ISBN から提供元を渡り歩いて拾い直す
 */
export interface CoverSource {
  /** その板に出せる絵を、画面に並んでいるのと同じ順で。無ければ空 */
  images: Candidate[];
  isbn: string | null;
  /** その ISBN で NDL を既に試したか。試したならもう一度聞いても答えは変わらない */
  skipNdl?: boolean;
  /** ISBN で当たらなかった時に書名で引き直す際の書名 (covers.ts の fetchCover) */
  titleForFallback?: string;
}

/** 絵を貼る先 1 つ。当てが無い板 (`source` が null) は「取れなかった」として数える */
export interface CoverTarget {
  slot: CoverSlot;
  source: CoverSource | null;
}

export interface PasteCoversResult {
  written: number;
  /** 表紙を取れなかった板の名前 */
  missed: string[];
  /** 回しても無駄なので打ち切ったか (鍵の間違い、接続元 IP、1 日の上限) */
  stopped: boolean;
  error: string | null;
}

/** 候補 1 冊から絵を焼いて板に貼る。焼けたら true */
async function burnCandidate(
  db: Db,
  cfg: Config,
  seriesId: number,
  slot: CoverSlot,
  c: Candidate
): Promise<boolean> {
  if (!c.imageUrl || !imageHostAllowed(c.imageUrl)) return false;
  const burned = await fetchAndBurn(cfg, `${c.provider}-image`, c.imageUrl);
  if (!burned) return false;
  writeCover(db, {
    seriesId, slot, provider: c.provider, sourceUrl: c.imageUrl, isbn: c.isbn, burned,
  });
  return true;
}

/**
 * その板に出せる絵を、**画面に並んでいる順に試す**。1 冊で諦めない。
 *
 * 書影 URL があることと、その URL が絵を返すことは別
 * (candidates.ts の `imageCandidatesOf`)。初版で 404 を食らったところで打ち切ると、
 * 同じ巻の新装版が候補として画面に出ていても一度も試されないまま束の外へ落ちる。
 */
export async function burnFromCandidates(
  db: Db,
  cfg: Config,
  seriesId: number,
  slot: CoverSlot,
  cands: Candidate[]
): Promise<boolean> {
  for (const c of cands) {
    if (await burnCandidate(db, cfg, seriesId, slot, c)) return true;
  }
  return false;
}

/**
 * 板を順に埋めていく。**単巻も合本も別巻も代表も同じループを通る。**
 *
 * 守りは 2 つ:
 *
 *   人が選んだ絵 (pinned) には触らない … 完結の `completed_user` と同じ立場
 *   予算で必ず打ち切る                  … 5000 巻を一息に取りに行くと相手に迷惑がかかる
 *
 * `overwrite` は「既にある絵も取り直す」。自動の道 (enrich.ts) は普段 false で、
 * **「取り直す」を押した時だけ true** になる。人が選んだ束を貼り直す道 (pick.ts) は
 * 貼る前に pinned 以外の行を落としているので、どちらでも同じところに着く。
 */
export async function pasteCovers(
  db: Db,
  cfg: Config,
  seriesId: number,
  targets: CoverTarget[],
  opts: { budget?: number; overwrite?: boolean } = {}
): Promise<PasteCoversResult> {
  const out: PasteCoversResult = { written: 0, missed: [], stopped: false, error: null };
  const budget = opts.budget ?? 200;
  let spent = 0;

  for (const t of targets) {
    const name = slotLabel(t.slot);
    if (!t.source) {
      out.missed.push(name);
      continue;
    }
    if (spent >= budget) continue;
    // 人が選んだ 1 枚は取り直しでも触らない。「取り直す」は**外に聞き直す**であって
    // 「人の指定を捨てる」ではない
    if (coverPinnedAt(db, seriesId, t.slot)) continue;
    if (!opts.overwrite && hasCoverAt(db, seriesId, t.slot)) continue;

    spent++;
    try {
      // まず**候補で見せた絵そのもの**を焼く。人が選んだ画面と棚が食い違わないように
      if (await burnFromCandidates(db, cfg, seriesId, t.slot, t.source.images)) {
        out.written++;
        continue;
      }
      // NDL は ISBN の半分ほどしか書影を持たない。そこは楽天から先に回す
      const got = t.source.isbn
        ? await fetchCover(db, cfg, seriesId, t.slot, t.source.isbn, {
          skipNdl: t.source.skipNdl,
          titleForFallback: t.source.titleForFallback,
        })
        : null;
      if (got) out.written++;
      else out.missed.push(name);
    } catch (e) {
      // 鍵・IP の間違い、1 日の上限は黙って飲まない。残りを回しても全部同じ理由で落ちる
      if (e instanceof ProviderStopError) {
        return { ...out, stopped: true, error: `${e.message} (${e.detail})` };
      }
      out.missed.push(name);
    }
  }
  return out;
}

// ---- 別巻 ----------------------------------------------------------------

/**
 * 書誌の書名から別巻の呼び名を読む。**ファイル名から読むのと同じ規則**を通す。
 *
 *   ('鬼滅の刃外伝', '鬼滅の刃')         → '外伝'
 *   ('四月は君の嘘 Coda', '四月は君の嘘') → 'Coda'
 *   ('進撃の巨人', '鬼滅の刃')            → null
 *
 * 規則を 2 つ持たないことが要点 — 棚の側は naming.ts が
 * 「フォルダ名を前置きとして剥がし、残りを呼び名とする」で読んでいる。
 * 書誌の側だけ別の読み方をすると、同じ本が繋がらない。
 *
 * **数字の混じった残りをここでは落とさない。** 落とす意味があるのはファイル名の側で
 * (巻数の読み落としを別巻として黙らせないため)、こちらは棚にある呼び名と
 * 突き合わせるだけ。棚の呼び名に数字は入らないので、噛み合わなければ勝手に落ちる。
 */
export function sideLabelOfTitle(title: string, seriesTitle: string): string | null {
  return restAfterFolderTitle(String(title ?? ''), seriesTitle);
}

/**
 * 別巻の板に出せる候補を選ぶ。
 *
 * 突き合わせは `seriesKeyOf` で畳んでから — 棚の `Coda` と書誌の `coda`、
 * `外伝 ` と `外伝` を別物にしない。
 */
export function sideCandidates(cands: Candidate[], seriesTitle: string, label: string): Candidate[] {
  const want = seriesKeyOf(label);
  if (!want) return [];
  return cands.filter((c) => {
    const rest = sideLabelOfTitle(c.title, seriesTitle);
    return rest !== null && seriesKeyOf(rest) === want;
  });
}

/**
 * 別巻の板を組み立てる。
 *
 * **呼び名が空のものは外に聞かない。** それは「1 冊で完結している作品そのもの」で、
 * 作品の代表表紙がまさにその本の絵になる (catalog.ts が板へ借りて出す)。
 * ここで別に取りに行くと、同じ本の絵を二度焼くだけになる。
 *
 * 絵の当てが見つからない呼び名も**板としては返す** — 「取れなかった」と数えて
 * 人に見せるため。黙って落とすと、外伝の表紙が出ない理由が画面から分からない。
 */
export function sideCoverTargets(
  db: Db,
  seriesId: number,
  seriesTitle: string,
  cands: Candidate[]
): CoverTarget[] {
  const out: CoverTarget[] = [];
  for (const label of db.listSideLabels(seriesId)) {
    if (!label) continue;
    const mine = sideCandidates(cands, seriesTitle, label);
    const withIsbn = mine.find((c) => c.isbn);
    out.push({
      slot: sideSlot(label),
      source: mine.length
        ? { images: mine.filter((c) => c.imageUrl), isbn: withIsbn?.isbn ?? null }
        : null,
    });
  }
  return out;
}

/** NDL の記録を候補の形に揃える。別巻の突き合わせは候補の形だけを見る */
export function ndlCandidates(records: NdlRecord[]): Candidate[] {
  return records.map(ndlCandidate);
}
