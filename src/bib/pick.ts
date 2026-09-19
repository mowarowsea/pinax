import type { Config } from '../config.js';
import { parseSlot, SERIES_SLOT, slotLabel, volumeSlot, type CoverSlot } from '../cover-slot.js';
import type { Db, SeriesPick } from '../db.js';
import { ProviderStopError } from './cache.js';
import {
  byVolumeOf, googleCandidate, groupCandidates, imageCandidatesOf, ndlCandidate, rakutenCandidate,
  type Candidate, type CandidateGroup, type CandidateProvider,
} from './candidates.js';
import { fetchAndBurn, refreshSeriesCover, writeCover, imageHostAllowed } from './covers.js';
import { googleReady, searchGoogle } from './google.js';
import { searchNdl } from './ndl.js';
import {
  bibOfCandidate, burnFromCandidates, pasteCovers, sideCoverTargets, writeBib, type CoverTarget,
} from './paste.js';
import { rakutenReady, searchRakuten } from './rakuten.js';

/**
 * **人が「これ！」と選ぶ道。**
 *
 * 自動で埋める道 (enrich.ts) は、書名と著者を外へ投げて返ってきたものを素直に信じる。
 * それで 9 割方は当たるが、**同じ書名で別のシリーズが並走している作品では必ず外す** —
 * 血界戦線の棚に Back 2 Back の表紙が並ぶのがそれ (candidates.ts の頭)。
 *
 * 機械に正解は分からないので、ここでは 2 つだけ用意する:
 *
 *   searchCandidates … 外を検索して、シリーズの束にまとめて見せる
 *   applyPick        … 人が選んだ束を正として、書誌と表紙を貼り直す
 *
 * 選んだ結果は `series_pick` に残り、**次からの自動の取り直しもその束だけを見る**。
 * 完結の `completed_user` と同じ立場 — 一度下した人の判断を、機械が黙って覆さない。
 */

export interface SearchQuery {
  title: string;
  author?: string | null;
  /** 既定は両方 */
  provider?: CandidateProvider | 'all';
  refresh?: boolean;
}

export interface SearchResult {
  title: string;
  author: string | null;
  groups: CandidateGroup[];
  /** 聞きに行った提供元 */
  asked: CandidateProvider[];
  /**
   * 提供元ごとの失敗。**片方が落ちても残りは見せる** —
   * 楽天の鍵が切れている時に NDL の候補まで消えると、人は何も選べなくなる
   */
  errors: { provider: CandidateProvider; message: string }[];
}

/**
 * 書影の候補を外に聞く。
 *
 * NDL には著者を添える (ndl.ts の頭: 添えないと CD やアンソロジーが混ざる)。
 * **書名があるうちは楽天にも Google にも著者を渡さない** — どちらも表記が 1 文字違うだけで
 * 0 件になる (rakuten.ts / google.ts の頭)。
 *
 * **作品名を空にして著者だけで引ける。** 棚のフォルダ名が実際の書名と違っていて
 * 何を入れれば当たるのか分からない時に、作者の著作を並べて選ぶ道が要る。
 * この時は著者を渡す (渡さないと条件が 1 つも無くなる)。
 *
 * **openBD はここに並ばない。** ISBN 起点でしか引けないので、人が書名で探す道に出せない
 * (openbd.ts の頭)。
 */
export async function searchCandidates(db: Db, cfg: Config, q: SearchQuery): Promise<SearchResult> {
  const title = String(q.title ?? '').trim();
  const author = String(q.author ?? '').trim() || null;
  const want = q.provider ?? 'all';
  const asked: CandidateProvider[] = [];
  const errors: SearchResult['errors'] = [];
  const items: Candidate[] = [];

  // 条件が 1 つも無い問い合わせは外へ出さない。相手の全件が返ってくるだけ
  if (!title && !author) return { title, author, groups: [], asked, errors };

  if (want === 'all' || want === 'ndl') {
    asked.push('ndl');
    try {
      const found = await searchNdl(db, cfg, { title, creator: author, refresh: q.refresh });
      for (const r of found.records) items.push(ndlCandidate(r));
    } catch (e) {
      errors.push({ provider: 'ndl', message: (e as Error).message });
    }
  }

  if ((want === 'all' || want === 'rakuten') && rakutenReady(cfg)) {
    asked.push('rakuten');
    try {
      const found = await searchRakuten(db, cfg, {
        title: title || undefined,
        author: title ? undefined : author ?? undefined,
        hits: 30,
        refresh: q.refresh,
      });
      for (const r of found.records) items.push(rakutenCandidate(r, cfg.bib.rakuten.imageSize));
    } catch (e) {
      const msg = e instanceof ProviderStopError ? `${e.message} (${e.detail})` : (e as Error).message;
      errors.push({ provider: 'rakuten', message: msg });
    }
  }

  if ((want === 'all' || want === 'google') && googleReady(cfg)) {
    asked.push('google');
    try {
      const found = await searchGoogle(db, cfg, {
        title: title || undefined,
        author: title ? undefined : author ?? undefined,
        hits: 40,
        refresh: q.refresh,
      });
      for (const r of found.records) items.push(googleCandidate(r));
    } catch (e) {
      const msg = e instanceof ProviderStopError ? `${e.message} (${e.detail})` : (e as Error).message;
      errors.push({ provider: 'google', message: msg });
    }
  }

  return { title, author, groups: groupCandidates(items), asked, errors };
}

export interface PickResult {
  seriesId: number;
  label: string;
  /** 聞きに行った先 ('all' | 'ndl' | 'rakuten' | 'google') */
  scope: string;
  groupKey: string;
  /** 貼り直しの元にした束の書名 */
  title: string;
  /** 束に入っていた冊数 */
  recordCount: number;
  /** 束が知っている一番大きい巻。**下限**であって「全何巻」ではない */
  publishedMax: number | null;
  bibWritten: number;
  coversWritten: number;
  /** 表紙を取れなかった板の名前 (`第03巻` / `外伝`) */
  coverMissed: string[];
  /** 回しても無駄なので打ち切ったか (enrich.ts の EnrichResult と同じ) */
  stopped: boolean;
  error: string | null;
}

/**
 * 人が選んだ束を正として、作品の書誌と表紙を貼り直す。
 *
 * **古い書誌と表紙は先に落とす。** 取り違えたシリーズの行を残したまま上書きすると、
 * 新しい束に無い巻 (Back 2 Back にしか無い巻など) が居残って
 * 「出ている巻」の数直線が伸びたままになる。`published` は**下限の推定**なので、
 * 嘘の下限が残るのが一番まずい (published.ts の頭)。
 *
 * **人が選んだ表紙 (pinned) だけは落とさない。** 巻ごとに選び直した 1 枚は、
 * シリーズを選び直したくらいで消えてよいものではない。
 */
export async function applyPick(
  db: Db,
  cfg: Config,
  seriesId: number,
  opts: { pick?: SeriesPick; coverBudget?: number; refresh?: boolean } = {}
): Promise<PickResult> {
  const s = db.getSeries(seriesId);
  const pick = opts.pick ?? db.getSeriesPick(seriesId);
  const label = s ? `${s.author ? `[${s.author}] ` : ''}${s.title}` : `#${seriesId}`;
  const out: PickResult = {
    seriesId, label,
    scope: pick?.scope ?? '', groupKey: pick?.groupKey ?? '', title: pick?.title ?? '',
    recordCount: 0, publishedMax: null, bibWritten: 0, coversWritten: 0, coverMissed: [],
    stopped: false, error: null,
  };
  if (!s) return { ...out, error: '作品がありません' };
  if (!pick) return { ...out, error: 'この作品にはまだシリーズが選ばれていません' };

  // 外へ聞きに行った印は**先に**押す (enrich.ts と同じ理由)
  db.markEnriched(seriesId);

  let found: SearchResult;
  try {
    found = await searchCandidates(db, cfg, {
      title: pick.queryTitle,
      author: pick.queryAuthor,
      provider: pick.scope as CandidateProvider | 'all',
      refresh: opts.refresh,
    });
  } catch (e) {
    return { ...out, error: (e as Error).message };
  }

  const group = found.groups.find((g) => g.key === pick.groupKey);
  if (!group) {
    // **何も壊さずに返す。** 相手が落ちている時に棚の書誌を消してしまわない
    const why = found.errors.map((x) => x.message).join(' / ');
    return { ...out, error: why || `選んだシリーズ「${pick.title}」が見つかりませんでした` };
  }
  out.recordCount = group.count;

  db.raw.prepare('DELETE FROM bib WHERE series_id = ?').run(seriesId);
  db.raw.prepare('DELETE FROM covers WHERE series_id = ? AND pinned = 0').run(seriesId);

  const byVol = byVolumeOf(group);
  out.publishedMax = group.volumeMax;

  /**
   * **持っていない巻の書誌も書く。** 「何巻まで出ているか」の素はここにしか無い
   * (enrich.ts と同じ立場)。表紙は持っている巻の分しか取りに行かない。
   */
  for (const [vol, c] of byVol) {
    writeBib(db, seriesId, vol, bibOfCandidate(c));
    out.bibWritten++;
  }

  // 作品そのものの書誌 (巻なし)。**一番若い巻を顔にする** — 束の中の
  // ファンブックや小説版が作品の代表になると、出版社も ISBN も別物になる
  const head = (group.volumes.length ? byVol.get(group.volumes[0]) : null) ?? group.items[0];
  if (head) {
    writeBib(db, seriesId, null, bibOfCandidate(head));
    out.bibWritten++;
  }

  /**
   * 絵を貼る板を並べる。**持っている単巻と、持っている別巻** (enrich.ts と同じ切り方)。
   *
   * 巻の板には**この巻に出ている候補を全部渡す。** 束の先頭 1 冊 (= 書誌に採った初版)
   * だけを試して終わると、その版に書影が無いだけで束の外の道へ落ちていく。
   * ARMS がそれで、1997年の初版は NDL にサムネイルが無く、画面に並んでいた
   * 2007年・2014年の新装版は一度も試されないまま、Google の 128px の
   * 目次ページが棚に載っていた (2026-09-17)。
   */
  const targets: CoverTarget[] = db.ownedVolumeNumbers(seriesId).map((vol) => {
    const c = byVol.get(vol);
    return {
      slot: volumeSlot(vol),
      source: c
        ? {
          images: imageCandidatesOf(group, vol),
          isbn: c.isbn,
          // NDL は ISBN の半分ほどしか書影を持たない。そこは楽天に回す
          skipNdl: c.provider === 'ndl',
          titleForFallback: group.title,
        }
        : null,
    };
  });
  targets.push(...sideCoverTargets(db, seriesId, s.title, group.items));

  // pinned 以外の行は上で落としてあるので、残っているのは人が選んだ 1 枚だけ。
  // **貼り直しに来た以上、残りは全部取り直す**
  const pasted = await pasteCovers(db, cfg, seriesId, targets, {
    budget: opts.coverBudget,
    overwrite: true,
  });
  out.coversWritten += pasted.written;
  out.coverMissed.push(...pasted.missed);
  if (pasted.stopped) return { ...out, stopped: true, error: pasted.error };

  /**
   * 巻の表紙が 1 枚も焼けなかった作品 (単巻もの、全部が合本の作品) は、
   * 束の顔を代表表紙に使う。**ここが無いと棚に表紙無しで並ぶ** —
   * 候補の画面では絵が見えていたのに、選んだら何も出ない、という見え方になる。
   *
   * **頭から数枚だけ試す。** ここに来るのは (a) 巻の表紙を一度も取りに行っていない作品か、
   * (b) 巻の絵が全部駄目だった作品。(b) で束を丸ごと舐め直すと、さっき駄目だった絵を
   * 53 件ぶん叩き直すことになる。束が丸ごと外れている時に相手を何十回も叩かないよう頭で切る
   */
  const hasCover = db.raw.prepare('SELECT 1 FROM covers WHERE series_id = ? LIMIT 1').get(seriesId);
  if (!hasCover && head) {
    try {
      if (await burnFromCandidates(db, cfg, seriesId, SERIES_SLOT, imageCandidatesOf(group, null).slice(0, 6))) {
        out.coversWritten++;
      }
    } catch (e) {
      if (e instanceof ProviderStopError) return { ...out, stopped: true, error: `${e.message} (${e.detail})` };
      // 取れなくても致命的ではない。表紙の無い作品として並ぶ
    }
  }

  refreshSeriesCover(db, seriesId);
  return out;
}

export interface VolumeCoverInput {
  seriesId: number;
  /** 差し替える板。代表・単巻・合本・別巻のどれでもよい (src/cover-slot.ts) */
  slot: CoverSlot;
  provider: string;
  imageUrl: string;
  isbn?: string | null;
}

/**
 * 板 1 枚の表紙を人の指定で差し替える。**単巻も合本も別巻も代表も同じ道を通る。**
 *
 * 焼いた行に `pinned` を立てるので、**この 1 枚は自動の巡回で二度と上書きされない**。
 * 書誌 (bib) は触らない — 人が直したいのは絵であって、「何巻まで出ているか」ではない。
 */
export async function setVolumeCover(db: Db, cfg: Config, input: VolumeCoverInput): Promise<{ ok: true }> {
  if (!db.getSeries(input.seriesId)) throw new Error('その作品はありません');
  if (!imageHostAllowed(input.imageUrl)) throw new Error(`この行き先からは取りません: ${input.imageUrl}`);

  const burned = await fetchAndBurn(cfg, `${input.provider}-image`, input.imageUrl);
  if (!burned) throw new Error('書影を取れませんでした (相手が画像を持っていないようです)');

  writeCover(db, {
    seriesId: input.seriesId,
    slot: input.slot,
    provider: input.provider,
    sourceUrl: input.imageUrl,
    isbn: input.isbn ?? null,
    burned,
    pinned: true,
  });

  /**
   * 番号を持つ板 (単巻・合本) を差し替えたら代表表紙も追う
   * (代表そのものが pinned なら refreshSeriesCover が避ける)。
   *
   * **別巻では追わない。** 外伝の絵が作品の顔になると、棚で作品を見分けられなくなる
   * (covers.ts の refreshSeriesCover と同じ切り方)。
   */
  if (input.slot.kind === 'volume') refreshSeriesCover(db, input.seriesId);
  return { ok: true };
}

/**
 * 画面から届いた板の宛先を読む。**どちらか一方だけが来る** —
 * 棚の板を押した時は `slot` が、候補の一覧から直接貼る時は `volume` が来る。
 *
 * 候補の側に `slot` を組ませないのは、**宛先の綴り方を画面にも持たせないため**。
 * 書き方が 2 箇所に分かれた時点で、片方だけ直して二度と繋がらなくなる。
 */
export function coverSlotOf(input: { slot?: string | null; volume?: number | null }): CoverSlot {
  if (input.slot !== undefined && input.slot !== null) {
    const slot = parseSlot(input.slot);
    if (!slot) throw new Error(`表紙の宛先を読めません: ${input.slot}`);
    return slot;
  }
  const v = input.volume;
  if (v === null || v === undefined) return SERIES_SLOT;
  if (!Number.isInteger(v)) throw new Error('volume は整数か null です');
  return volumeSlot(v);
}

/** 差し替えた先を人に言う時の名前 (`第01-02巻の表紙にしました`) */
export { slotLabel };
