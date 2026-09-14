import type { Db, SeriesRow, VolumeRow } from './db.js';
import { parseFilename, seriesLabel } from './naming.js';
import { parseItem, seriesKeyOf } from './volume.js';

/**
 * カタログの読み出し。「何を持っていて、何を持っていないか」の答えはここで作る。
 *
 * 欠番は**単位ごとに別々に数える**。巻で出ているものと話で出ているものを同じ数直線に
 * 乗せると、第224話を持っている作品が「224巻まであるのに 40 巻しか無い」に化ける。
 */

export interface Holding {
  unit: string;
  /** 持っている巻 (昇順) */
  owned: number[];
  /** 1 から最大巻までの間で抜けている番号 */
  missing: number[];
  max: number;
}

export interface SeriesSummary {
  id: number;
  rootId: string;
  folder: string;
  seriesKey: string;
  title: string;
  author: string | null;
  label: string;
  completed: boolean;
  present: boolean;
  fileCount: number;
  bytes: number;
  /** 巻数を読めなかったファイルの数。欠番計算に参加していない */
  looseFiles: number;
  holdings: Holding[];
  /** 抜けが 1 つでもあるか */
  hasGap: boolean;
  coverUrl: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** 持っている巻から穴を割り出す */
export function holdingsOf(volumes: VolumeRow[]): Holding[] {
  const byUnit = new Map<string, Set<number>>();
  for (const v of volumes) {
    if (!v.present) continue;
    const set = byUnit.get(v.unit) ?? new Set<number>();
    for (let i = v.volumeFrom; i <= v.volumeTo; i++) set.add(i);
    byUnit.set(v.unit, set);
  }
  const out: Holding[] = [];
  for (const [unit, set] of byUnit) {
    const owned = [...set].sort((a, b) => a - b);
    if (!owned.length) continue;
    const max = owned[owned.length - 1];
    const missing: number[] = [];
    for (let i = 1; i <= max; i++) if (!set.has(i)) missing.push(i);
    out.push({ unit, owned, missing, max });
  }
  // 巻を先に出す。話しか無い作品はそのまま
  return out.sort((a, b) => (a.unit === '巻' ? -1 : b.unit === '巻' ? 1 : 0));
}

export interface ListOptions {
  q?: string;
  /** 抜けのある作品だけ */
  gapsOnly?: boolean;
  completed?: boolean;
  rootId?: string;
  /** 表紙がまだ無いものだけ */
  needsCover?: boolean;
  sort?: 'title' | 'author' | 'added' | 'volumes';
  limit?: number;
  offset?: number;
}

interface CountRow {
  series_id: number;
  file_count: number;
  bytes: number;
  loose: number;
}

export function listSeries(db: Db, opts: ListOptions = {}): { total: number; items: SeriesSummary[] } {
  const where: string[] = ['s.present = 1'];
  const params: (string | number)[] = [];

  if (opts.rootId) {
    where.push('s.root_id = ?');
    params.push(opts.rootId);
  }
  if (opts.completed !== undefined) {
    where.push('s.completed = ?');
    params.push(opts.completed ? 1 : 0);
  }
  if (opts.q) {
    // 作品名は表記が揺れるので、生の LIKE と正規化キーの両方に当てる
    where.push('(s.title LIKE ? OR s.author LIKE ? OR s.series_key LIKE ?)');
    const like = `%${opts.q}%`;
    params.push(like, like, `%${seriesKeyOf(opts.q)}%`);
  }
  if (opts.needsCover) {
    where.push('NOT EXISTS (SELECT 1 FROM covers c WHERE c.series_id = s.id AND c.volume_no IS NULL)');
  }

  const clause = `WHERE ${where.join(' AND ')}`;
  const total = Number(
    (db.raw.prepare(`SELECT COUNT(*) AS n FROM series s ${clause}`).get(...params) as { n: number }).n
  );

  const order = {
    title: 's.title COLLATE NOCASE ASC',
    author: 's.author COLLATE NOCASE ASC, s.title COLLATE NOCASE ASC',
    added: 's.first_seen_at DESC, s.id DESC',
    volumes: 'file_count DESC',
  }[opts.sort ?? 'title'];

  const limit = Math.min(opts.limit ?? 60, 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  const rows = db.raw
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM files f WHERE f.series_id = s.id AND f.present = 1) AS file_count,
              (SELECT COALESCE(SUM(f.size), 0) FROM files f WHERE f.series_id = s.id AND f.present = 1) AS bytes,
              (SELECT COUNT(*) FROM files f WHERE f.series_id = s.id AND f.present = 1 AND f.volume_id IS NULL) AS loose,
              (SELECT c.id FROM covers c WHERE c.series_id = s.id AND c.volume_no IS NULL) AS cover_id
         FROM series s ${clause}
        ORDER BY ${order} LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as Record<string, unknown>[];

  const items = rows.map((r) => {
    const volumes = db.listVolumes(Number(r.id));
    const holdings = holdingsOf(volumes);
    return {
      id: Number(r.id),
      rootId: String(r.root_id),
      folder: String(r.folder),
      seriesKey: String(r.series_key),
      title: String(r.title),
      author: (r.author as string | null) ?? null,
      label: seriesLabel(r.author as string | null, String(r.title)),
      completed: Number(r.completed) === 1,
      present: Number(r.present) === 1,
      fileCount: Number(r.file_count),
      bytes: Number(r.bytes),
      looseFiles: Number(r.loose),
      holdings,
      hasGap: holdings.some((h) => h.missing.length > 0),
      coverUrl: r.cover_id ? `/api/covers/${Number(r.cover_id)}` : null,
      firstSeenAt: String(r.first_seen_at),
      lastSeenAt: String(r.last_seen_at),
    } satisfies SeriesSummary;
  });

  const filtered = opts.gapsOnly ? items.filter((i) => i.hasGap) : items;
  return { total, items: filtered };
}

export interface VolumeDetail {
  id: number;
  volumeFrom: number;
  volumeTo: number;
  unit: string;
  label: string;
  completed: boolean;
  present: boolean;
  coverUrl: string | null;
  files: {
    id: number;
    relPath: string;
    size: number;
    mtime: string | null;
    ext: string;
    partNo: number | null;
    tags: string[];
    present: boolean;
  }[];
}

export interface SeriesDetail extends SeriesSummary {
  volumes: VolumeDetail[];
  /** 巻数を読めなかったファイル。欠番には効かないが、持ってはいる */
  loose: VolumeDetail['files'];
  bib: Record<string, unknown> | null;
}

export function getSeriesDetail(db: Db, id: number): SeriesDetail | null {
  const s = db.getSeries(id);
  if (!s) return null;

  const summary = listSeriesOne(db, s);
  const volumes = db.listVolumes(id);

  const fileRows = db.raw
    .prepare('SELECT * FROM files WHERE series_id = ? ORDER BY rel_path')
    .all(id) as Record<string, unknown>[];

  const toFile = (r: Record<string, unknown>): VolumeDetail['files'][number] => ({
    id: Number(r.id),
    relPath: String(r.rel_path),
    size: Number(r.size),
    mtime: (r.mtime as string | null) ?? null,
    ext: String(r.ext ?? ''),
    partNo: r.part_no === null ? null : Number(r.part_no),
    tags: JSON.parse(String(r.tags ?? '[]')) as string[],
    present: Number(r.present) === 1,
  });

  const covers = db.raw
    .prepare('SELECT id, volume_no FROM covers WHERE series_id = ?')
    .all(id) as { id: number; volume_no: number | null }[];
  const coverByVol = new Map(covers.filter((c) => c.volume_no !== null).map((c) => [Number(c.volume_no), Number(c.id)]));

  const details: VolumeDetail[] = volumes.map((v) => {
    const coverId = v.volumeFrom === v.volumeTo ? coverByVol.get(v.volumeFrom) : undefined;
    return {
      id: v.id,
      volumeFrom: v.volumeFrom,
      volumeTo: v.volumeTo,
      unit: v.unit,
      label: v.volumeFrom === v.volumeTo
        ? `第${String(v.volumeFrom).padStart(2, '0')}${v.unit}`
        : `第${String(v.volumeFrom).padStart(2, '0')}-${String(v.volumeTo).padStart(2, '0')}${v.unit}`,
      completed: v.completed,
      present: v.present,
      coverUrl: coverId ? `/api/covers/${coverId}` : null,
      files: fileRows.filter((r) => Number(r.volume_id) === v.id).map(toFile),
    };
  });

  const bibRow = db.raw
    .prepare('SELECT * FROM bib WHERE series_id = ? AND volume_no IS NULL LIMIT 1')
    .get(id) as Record<string, unknown> | undefined;

  return {
    ...summary,
    volumes: details,
    loose: fileRows.filter((r) => r.volume_id === null).map(toFile),
    bib: bibRow ? { ...bibRow, raw: JSON.parse(String(bibRow.raw ?? '{}')) } : null,
  };
}

function listSeriesOne(db: Db, s: SeriesRow): SeriesSummary {
  const agg = db.raw
    .prepare(
      `SELECT COUNT(*) AS file_count, COALESCE(SUM(size), 0) AS bytes,
              SUM(CASE WHEN volume_id IS NULL THEN 1 ELSE 0 END) AS loose
         FROM files WHERE series_id = ? AND present = 1`
    )
    .get(s.id) as unknown as CountRow;
  const cover = db.raw
    .prepare('SELECT id FROM covers WHERE series_id = ? AND volume_no IS NULL')
    .get(s.id) as { id: number } | undefined;
  const holdings = holdingsOf(db.listVolumes(s.id));
  return {
    id: s.id,
    rootId: s.rootId,
    folder: s.folder,
    seriesKey: s.seriesKey,
    title: s.title,
    author: s.author,
    label: seriesLabel(s.author, s.title),
    completed: s.completed,
    present: s.present,
    fileCount: Number(agg.file_count ?? 0),
    bytes: Number(agg.bytes ?? 0),
    looseFiles: Number(agg.loose ?? 0),
    holdings,
    hasGap: holdings.some((h) => h.missing.length > 0),
    coverUrl: cover ? `/api/covers/${cover.id}` : null,
    firstSeenAt: s.firstSeenAt,
    lastSeenAt: s.lastSeenAt,
  };
}

// ---- 所持の問い合わせ (PowerDowner / DryEyes 向け) --------------------------

export interface OwnQuery {
  title?: string | null;
  author?: string | null;
  volume?: string | number | null;
  rawText?: string | null;
}

export interface OwnAnswer {
  /** 問い合わせをどう読んだか。向こうで食い違いを追えるように返す */
  parsed: { seriesKey: string; volumeFrom: number | null; volumeTo: number | null };
  owned: boolean;
  /** 所持のうち、問い合わせ範囲で埋まっていない巻。owned が false の時に見る */
  missing: number[] | null;
  /** 当たった作品 */
  series: { id: number; label: string; folder: string; completed: boolean }[];
  reason: string;
}

/**
 * 「この巻を持っているか」に答える。PowerDowner の `decideItem` と同じ判断を、
 * 手元のファイルを正として下す。
 *
 * **巻数を読めない問い合わせには「持っていない」と答える。** 黙って持っている
 * ことにすると、その巻が永久に落ちてこなくなる。もう一度落ちる方が被害が小さい
 * (PowerDowner README「台帳 (取得済みの記録)」と同じ立場)。
 */
export function checkOwned(db: Db, q: OwnQuery): OwnAnswer {
  const parsedItem = parseOwnQuery(q);
  const hits = db.findSeriesByKey(parsedItem.seriesKey).filter((s) => s.present);
  const series = hits.map((s) => ({
    id: s.id, label: seriesLabel(s.author, s.title), folder: s.folder, completed: s.completed,
  }));

  if (!parsedItem.seriesKey) {
    return { parsed: parsedItem, owned: false, missing: null, series, reason: '作品名を読めませんでした' };
  }
  if (!hits.length) {
    return { parsed: parsedItem, owned: false, missing: null, series, reason: '蔵書にこの作品がありません' };
  }
  if (parsedItem.volumeFrom === null || parsedItem.volumeTo === null) {
    return {
      parsed: parsedItem, owned: false, missing: null, series,
      reason: '巻数を読めないので重なりを判定できません (作品はあります)',
    };
  }

  const owned = new Set<number>();
  for (const s of hits) {
    for (const v of db.listVolumes(s.id)) {
      if (!v.present) continue;
      // 単位が違うものは同じ数直線に乗せない
      for (let i = v.volumeFrom; i <= v.volumeTo; i++) owned.add(i);
    }
  }
  const missing: number[] = [];
  for (let i = parsedItem.volumeFrom; i <= parsedItem.volumeTo; i++) if (!owned.has(i)) missing.push(i);

  const range = parsedItem.volumeFrom === parsedItem.volumeTo
    ? `第${parsedItem.volumeFrom}巻`
    : `第${parsedItem.volumeFrom}-${parsedItem.volumeTo}巻`;

  return {
    parsed: parsedItem,
    owned: missing.length === 0,
    missing,
    series,
    reason: missing.length === 0 ? `所持済み (${range})` : `未所持: ${missing.join(',')}`,
  };
}

/**
 * 問い合わせを蔵書と同じ読み方に揃える。
 *
 * **先頭の `[著者]` を落としてからキーにすること。** DryEyes は抽出前の生テキストを
 * `rawText` に入れて送ってくるので、`[つくしあきひと] メイドインアビス 第03巻` の形で
 * 届く。そのままキーにすると `つくしあきひとメイドインアビス` になり、蔵書側の
 * `メイドインアビス` と一生噛み合わない — 手元にあるのに落とし直す。
 *
 * 落とす仕事は naming.ts の parseFilename に任せる。蔵書のファイル名を読むのと
 * 同じ関数を通すことに意味がある (別々の規則を持つと必ずずれる)。
 * seriesKeyOf そのものは PowerDowner と同一なので、突き合わせの互換は保たれる。
 */
function parseOwnQuery(q: OwnQuery): OwnAnswer['parsed'] {
  const rawText = String(q.rawText ?? '').trim();
  let title = String(q.title ?? '').trim();

  if (!title && rawText) title = parseFilename(rawText).title;
  else if (/^\s*[[［]/.test(title)) title = parseFilename(title).title;

  const p = parseItem({ title, volume: q.volume ?? null, rawText: rawText || null });
  return { seriesKey: p.seriesKey, volumeFrom: p.volumeFrom, volumeTo: p.volumeTo };
}
