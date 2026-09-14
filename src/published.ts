import type { Db } from './db.js';
import type { Holding } from './catalog.js';

/**
 * 「世の中に何巻出ているか」の軸。
 *
 * **`holdings` (棚に何があるか) とは別物として扱う。** 混ぜてはいけない:
 *
 *   holdings  … ファイルを見て分かること。**事実**
 *   published … 外の書誌に聞いて分かること。**下限の推定**
 *
 * 外が知らない巻は「出ていない」ではなく「こちらが知らない」。だから
 * `max` は「全 N 巻」ではなく「**少なくとも N 巻までは出ている**」と読む。
 * ここを取り違えると、まだ続いている作品を「揃っている」と表示して
 * 続きを買い逃す — 蔵書管理として一番やってはいけない間違え方になる。
 *
 * 素は `bib` 表。enrichSeries が NDL の答えを**持っていない巻も含めて**書いている。
 */

export interface PublishedInfo {
  /** 外の書誌が確かに知っている巻 (昇順)。ここに無い = 出ていない、ではない */
  known: number[];
  /** 確認できた一番大きい巻。**下限**であって「全何巻」ではない */
  max: number | null;
  /** 出ているのに手元に無い巻 */
  missing: number[];
  /** 手元の最大巻より先に出ている巻。「続きが出ている」がこれ */
  ahead: number[];
  /** 一番大きい巻の発行時期 (書誌が持っていれば) */
  latestDate: string | null;
  /** 根拠にした提供元 */
  providers: string[];
  /** まだ外に聞いていない */
  unchecked: boolean;
}

/** 「2003.9」「2024-08-01」「2024」いずれの形でも年を取り出す */
export function yearOf(pubdate: string | null | undefined): number | null {
  const m = String(pubdate ?? '').match(/(?:19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

/**
 * **完結しているかは、外の書誌からは分からない。**
 *
 * 3 通り測って、どれも使い物にならなかった (2026-09-14):
 *
 *   書名の「(完)」の印  … NDL 627 応答中 8 件 / 楽天 1592 応答中 2 件。稀すぎる
 *   最終巻からの経過年  … 手元で `(完)` を付けた 90 作品と、付けていない 364 作品で
 *                        分布が重なる (10 年超が 33% 対 63%)。切り分けられない
 *   楽天の完結表示      … そもそも古い作品が在庫に無く、10 作品中 2 件しか引けない
 *
 * **なので推測しない。** 代わりに、嘘をつかずに言えることだけを返す:
 *
 *   `owner`  … フォルダに `(完)` が付いている。**人が下した判断なので、これだけは確か**
 *   `ahead`  … 手元の最大巻より先が出ている。「続きがある」は事実として言える
 *   `caughtUp` … 外が知っている巻は全部持っている。完結したのか、単に外が
 *                最新を知らないだけなのかは**区別できない**
 *
 * 画面には「たぶん完結」ではなく「最新刊 2015年、以降の巻は確認できず」と出す。
 * 判断は人がする。機械が断定すると、外れた時に買い逃しになって取り返しがつかない。
 */
export type ShelfStatus = 'owner-completed' | 'behind' | 'caught-up' | 'unknown';

export interface ShelfState {
  status: ShelfStatus;
  /** 外の書誌が知っている一番大きい巻。**下限** */
  publishedMax: number | null;
  /** 手元に持っている一番大きい巻 */
  ownedMax: number;
  /** 手元に無いと分かっている巻の数 */
  missingCount: number;
  /** 手元の最大巻より先に出ている巻の数 */
  aheadCount: number;
  /** 画面にそのまま出してよい一行。**断定しない言い方にしてある** */
  label: string;
  /** 一番新しいと分かっている巻の年 */
  latestYear: number | null;
}

/**
 * 作品 1 つぶんの「出ている巻」を組み立てる。
 *
 * `bib` に**巻として読めた行**だけを使う。`volume_no` が null の行は
 * 作品そのものの書誌 (単巻ものや映画版) なので、巻の数直線には乗せない。
 */
export function publishedOf(db: Db, seriesId: number, holdings: Holding[], enrichedAt: string | null): PublishedInfo {
  const rows = db.raw
    .prepare(
      `SELECT volume_no, provider, pubdate FROM bib
        WHERE series_id = ? AND volume_no IS NOT NULL
        ORDER BY volume_no`
    )
    .all(seriesId) as { volume_no: number; provider: string; pubdate: string | null }[];

  // 巻の数直線は「巻」だけを見る。話で出ている作品と混ぜない (catalog.ts の Holding と同じ理由)
  const byVolume = holdings.find((h) => h.unit === '巻') ?? null;
  const owned = new Set(byVolume?.owned ?? []);
  const ownedMax = byVolume?.max ?? 0;

  const known = [...new Set(rows.map((r) => Number(r.volume_no)))].sort((a, b) => a - b);
  const providers = [...new Set(rows.map((r) => String(r.provider)))];

  const latest = known.length ? known[known.length - 1] : null;
  const latestDate = latest === null
    ? null
    : rows.filter((r) => Number(r.volume_no) === latest).map((r) => r.pubdate).find((d) => d) ?? null;

  return {
    known,
    max: latest,
    missing: known.filter((v) => !owned.has(v)),
    ahead: known.filter((v) => v > ownedMax),
    latestDate,
    providers,
    unchecked: enrichedAt === null,
  };
}

/** 画面と API にそのまま出せる形にまとめる。**断定しない言い方を守る** */
export function shelfStateOf(
  pub: PublishedInfo,
  ownerCompleted: boolean,
  holdings: Holding[]
): ShelfState {
  const latestYear = yearOf(pub.latestDate);
  const byVolume = holdings.find((h) => h.unit === '巻') ?? null;
  const ownedMax = byVolume?.max ?? 0;

  const base = {
    publishedMax: pub.max,
    ownedMax,
    missingCount: pub.missing.length,
    aheadCount: pub.ahead.length,
    latestYear,
  };

  // フォルダの `(完)` は人が下した判断。外の書誌より強い
  if (ownerCompleted) {
    return {
      ...base,
      status: 'owner-completed',
      label: pub.missing.length ? `完結 — 未所持 ${pub.missing.length}巻` : '完結 — 揃っている',
    };
  }
  if (pub.unchecked || pub.max === null) {
    return { ...base, status: 'unknown', label: '発行状況は未確認' };
  }
  if (pub.ahead.length) {
    return {
      ...base,
      status: 'behind',
      label: `続きが出ている — ${ownedMax + 1}〜${pub.max}巻が未所持`,
    };
  }
  return {
    ...base,
    status: 'caught-up',
    // **「完結」と言わない。** 外が最新を知らないだけかもしれない
    label: latestYear
      ? `${latestYear}年の第${pub.max}巻まで確認 — それ以降は不明`
      : `第${pub.max}巻まで確認 — それ以降は不明`,
  };
}
