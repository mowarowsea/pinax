import type { Config } from '../config.js';
import type { Db, SeriesPick } from '../db.js';
import {
  byVolumeOf, groupCandidates, ndlCandidate, rakutenCandidate,
  type Candidate, type CandidateGroup, type CandidateProvider,
} from './candidates.js';
import { fetchAndBurn, fetchCover, refreshSeriesCover, writeCover, imageHostAllowed } from './covers.js';
import { searchNdl } from './ndl.js';
import { RakutenAuthError, rakutenReady, searchRakuten } from './rakuten.js';

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
 * **書名があるうちは楽天に著者を渡さない** — 渡すと 0 件になる (rakuten.ts の頭)。
 *
 * **作品名を空にして著者だけで引ける。** 棚のフォルダ名が実際の書名と違っていて
 * 何を入れれば当たるのか分からない時に、作者の著作を並べて選ぶ道が要る。
 * この時は楽天にも著者を渡す (渡さないと条件が 1 つも無くなる)。
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
      const msg = e instanceof RakutenAuthError ? `${e.message} (${e.detail})` : (e as Error).message;
      errors.push({ provider: 'rakuten', message: msg });
    }
  }

  return { title, author, groups: groupCandidates(items), asked, errors };
}

export interface PickResult {
  seriesId: number;
  label: string;
  /** 聞きに行った先 ('all' | 'ndl' | 'rakuten') */
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
  /** 表紙を取れなかった巻 */
  coverMissed: number[];
  error: string | null;
}

/** 候補 1 冊を bib の 1 行にする。生の候補ごと raw に残す (解釈を後から直せるように) */
function writeBib(db: Db, seriesId: number, volumeNo: number | null, c: Candidate): void {
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
      seriesId, volumeNo, c.provider, c.isbn, c.title, c.author, c.publisher, c.date,
      c.imageUrl, JSON.stringify(c), new Date().toISOString()
    );
}

/** 人が選んだ束の 1 冊から表紙を焼く。ISBN 頼みの道より**確実**で、絵も候補で見たものと同じになる */
async function burnFromCandidate(
  db: Db,
  cfg: Config,
  seriesId: number,
  volumeNo: number | null,
  c: Candidate,
  opts: { pinned?: boolean } = {}
): Promise<boolean> {
  if (!c.imageUrl || !imageHostAllowed(c.imageUrl)) return false;
  const burned = await fetchAndBurn(cfg, `${c.provider}-image`, c.imageUrl);
  if (!burned) return false;
  writeCover(db, {
    seriesId, volumeNo, provider: c.provider, sourceUrl: c.imageUrl, isbn: c.isbn, burned,
    pinned: opts.pinned,
  });
  return true;
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
    recordCount: 0, publishedMax: null, bibWritten: 0, coversWritten: 0, coverMissed: [], error: null,
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
    writeBib(db, seriesId, vol, c);
    out.bibWritten++;
  }

  // 作品そのものの書誌 (巻なし)。**一番若い巻を顔にする** — 束の中の
  // ファンブックや小説版が作品の代表になると、出版社も ISBN も別物になる
  const head = (group.volumes.length ? byVol.get(group.volumes[0]) : null) ?? group.items[0];
  if (head) {
    writeBib(db, seriesId, null, head);
    out.bibWritten++;
  }

  const owned = db
    .listVolumes(seriesId)
    .filter((v) => v.present && v.unit === '巻' && v.volumeFrom === v.volumeTo)
    .map((v) => v.volumeFrom)
    .sort((a, b) => a - b);

  const budget = opts.coverBudget ?? 200;
  let spent = 0;

  for (const vol of owned) {
    const c = byVol.get(vol);
    if (!c) {
      out.coverMissed.push(vol);
      continue;
    }
    if (spent >= budget) continue;
    // 人が個別に選んだ巻は触らない
    const pinned = db.raw
      .prepare('SELECT 1 FROM covers WHERE series_id = ? AND volume_no = ? AND pinned = 1')
      .get(seriesId, vol);
    if (pinned) continue;

    spent++;
    try {
      // まず**候補で見せた絵そのもの**を焼く。人が選んだ画面と棚が食い違わないように
      if (await burnFromCandidate(db, cfg, seriesId, vol, c)) {
        out.coversWritten++;
        continue;
      }
      // NDL は ISBN の半分ほどしか書影を持たない。そこは楽天に回す
      const got = c.isbn
        ? await fetchCover(db, cfg, seriesId, vol, c.isbn, {
          skipNdl: c.provider === 'ndl',
          titleForFallback: group.title,
        })
        : null;
      if (got) out.coversWritten++;
      else out.coverMissed.push(vol);
    } catch (e) {
      if (e instanceof RakutenAuthError) return { ...out, error: `${e.message} (${e.detail})` };
      out.coverMissed.push(vol);
    }
  }

  /**
   * 巻の表紙が 1 枚も焼けなかった作品 (単巻もの、全部が合本の作品) は、
   * 束の顔を代表表紙に使う。**ここが無いと棚に表紙無しで並ぶ** —
   * 候補の画面では絵が見えていたのに、選んだら何も出ない、という見え方になる
   */
  const hasCover = db.raw.prepare('SELECT 1 FROM covers WHERE series_id = ? LIMIT 1').get(seriesId);
  if (!hasCover && head) {
    try {
      if (await burnFromCandidate(db, cfg, seriesId, null, head)) out.coversWritten++;
    } catch (e) {
      if (e instanceof RakutenAuthError) return { ...out, error: `${e.message} (${e.detail})` };
      // 取れなくても致命的ではない。表紙の無い作品として並ぶ
    }
  }

  refreshSeriesCover(db, seriesId);
  return out;
}

export interface VolumeCoverInput {
  seriesId: number;
  /** null なら作品の代表表紙そのものを差し替える */
  volume: number | null;
  provider: string;
  imageUrl: string;
  isbn?: string | null;
}

/**
 * 1 巻ぶんの表紙を人の指定で差し替える。
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
    volumeNo: input.volume,
    provider: input.provider,
    sourceUrl: input.imageUrl,
    isbn: input.isbn ?? null,
    burned,
    pinned: true,
  });

  // 巻を差し替えたら代表表紙も追う (代表そのものが pinned なら refreshSeriesCover が避ける)
  if (input.volume !== null) refreshSeriesCover(db, input.seriesId);
  return { ok: true };
}
