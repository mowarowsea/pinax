import { completedOf, type Db, type SeriesPick, type SeriesRow, type VolumeRow } from './db.js';
import { parseFilename, seriesLabel } from './naming.js';
import { parseItem, seriesKeyOf } from './volume.js';
import { publishedOf, shelfStateOf, type PublishedInfo, type ShelfState } from './published.js';

/**
 * カタログの読み出し。「何を持っていて、何を持っていないか」の答えはここで作る。
 *
 * 欠番は**単位ごとに別々に数える**。巻で出ているものと話で出ているものを同じ数直線に
 * 乗せると、第224話を持っている作品が「224巻まであるのに 40 巻しか無い」に化ける。
 */

/**
 * 棚の整合性。**機械が直さず、人に見せる。**
 *
 * ファイル名から巻を読む以上、読み違えも読めないものも必ず残る。実物にもある:
 *
 *   `本好きの下剋上 第04部 第01巻` … 部が違うのに全部「第01巻」に畳まれる (重複)
 *   `Landreaall 第01巻.rar` と `Landreaall ランドリオール 第01巻.zip` … 同じ巻が 2 本 (重複)
 *   巻数表現の無いファイル … 何巻か読めない (欠番の計算に参加しない)
 *
 * ただし**外伝・特別編は読み違えではない。** `鬼滅の刃 外伝` に巻数が無いのは正しく、
 * ここで数えると 19 作品の要確認が一生下りずに警告そのものが死ぬ (2026-09-18 に実測)。
 * 呼び名まで読めたもの (files.side_label) は別巻として数から外す。
 *
 * どれも**機械には正解が分からない**。別版として両方残したいのか、片方が捨て漏れなのかは
 * 中身を見た人しか決められないので、pinax は数えて並べるところまでをやる。
 */
export interface SeriesIssues {
  /** 同じ巻に別々のファイルが割り当たっている巻の数。分割書庫の続きは 1 つと数える */
  duplicateVolumes: number;
  /** そのうち、1 巻 1 本を超えている分のファイル数 */
  duplicateFiles: number;
  /** 何巻か読めなかったファイルの数。**別巻 (外伝・特別編) は含まない** */
  unreadableFiles: number;
  /** どれか 1 つでもあるか */
  any: boolean;
}

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
  /** 実効値。人の指定があればそちら、無ければフォルダの `(完)` */
  completed: boolean;
  /** フォルダ名の `(完)` */
  folderCompleted: boolean;
  /** 人が画面で決めた値。null なら未指定 */
  completedUser: boolean | null;
  present: boolean;
  fileCount: number;
  bytes: number;
  /** 巻数も呼び名も読めなかったファイルの数。欠番計算に参加していない */
  looseFiles: number;
  holdings: Holding[];
  /** 抜けが 1 つでもあるか (**持っている範囲の中の**抜け) */
  hasGap: boolean;
  /**
   * 外の書誌と突き合わせた棚の状態。
   * `hasGap` が「持っている 1〜10 巻の間の穴」なのに対し、こちらは
   * **「11 巻以降が出ている」** を見る。買い逃しに効くのは後者
   */
  shelf: ShelfState;
  /** 巻の重複・巻数不明。**絞り込みの対象** */
  issues: SeriesIssues;
  coverUrl: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /**
   * **最後に巻が 1 つ増えた時刻。** 作品が棚に載った時刻 (`firstSeenAt`) とは別物で、
   * 続きを買い足した作品が上に来るのはこちら。
   * 巻として読めたものが 1 つも無ければ作品の初出に落とす
   */
  volumeAddedAt: string;
}

/**
 * 分割書庫の連番を落としたファイルの素。`foo.part1.rar` も `foo.r00` も `foo` になる。
 *
 * **同じ巻に素が 2 つ以上あれば重複**で、分割書庫の続き (`.part2` / `.r01`) は重複ではない。
 * SQL 側 (`fileBaseSql`) と同じ切り方をすること — 片方だけ直すと、一覧では重複と出るのに
 * 開くとどこにも印が付いていない、という食い違いになる。
 */
function fileBaseOf(r: Record<string, unknown>): string {
  const rel = String(r.rel_path ?? '');
  const cut = String(r.part ?? '').length + String(r.ext ?? '').length;
  return cut > 0 ? rel.slice(0, Math.max(0, rel.length - cut)) : rel;
}

const fileBaseSql =
  "substr(f.rel_path, 1, length(f.rel_path) - length(COALESCE(f.part, '')) - length(COALESCE(f.ext, '')))";

/** 同じ巻に 2 本以上のファイルがぶら下がっている巻を数える */
const dupVolumesSql = (seriesRef: string): string => `(SELECT COUNT(*) FROM (
    SELECT 1 FROM volumes v JOIN files f ON f.volume_id = v.id AND f.present = 1
     WHERE v.series_id = ${seriesRef} AND v.present = 1
     GROUP BY v.id HAVING COUNT(DISTINCT ${fileBaseSql}) > 1))`;

/** 上の巻のうち、1 巻 1 本を超えている分のファイル数 */
const dupFilesSql = (seriesRef: string): string => `(SELECT COALESCE(SUM(n - 1), 0) FROM (
    SELECT COUNT(DISTINCT ${fileBaseSql}) AS n
      FROM volumes v JOIN files f ON f.volume_id = v.id AND f.present = 1
     WHERE v.series_id = ${seriesRef} AND v.present = 1
     GROUP BY v.id HAVING n > 1))`;

/**
 * 巻としても別巻としても読めなかったファイル。**要確認の数はこれ。**
 * `side_label IS NULL` を外すと外伝を抱えた作品が永久に要確認になる (SeriesIssues の註)
 */
const looseFilesSql = (seriesRef: string): string =>
  `(SELECT COUNT(*) FROM files f WHERE f.series_id = ${seriesRef} AND f.present = 1
      AND f.volume_id IS NULL AND f.side_label IS NULL)`;

/**
 * 最後に巻が 1 つ増えた時刻。
 *
 * 見るのは `volumes.first_seen_at` — **その巻が棚に初めて現れた時刻**。
 * ファイルの mtime ではない。古い巻を後から買い足しても mtime は昔の日付のままで、
 * 「続きを足した作品」を上に出すという目的に使えない。
 * 巻が 1 つも無ければ null になるので、呼ぶ側で作品の初出に落とす
 */
const volumeAddedAtSql = (seriesRef: string): string =>
  `(SELECT MAX(v.first_seen_at) FROM volumes v WHERE v.series_id = ${seriesRef} AND v.present = 1)`;

function toIssues(duplicateVolumes: number, duplicateFiles: number, unreadableFiles: number): SeriesIssues {
  return {
    duplicateVolumes,
    duplicateFiles,
    unreadableFiles,
    any: duplicateVolumes > 0 || unreadableFiles > 0,
  };
}

/** 作品 1 つぶんの整合性を数える (詳細画面と listSeriesOne 用) */
export function issuesOf(db: Db, seriesId: number): SeriesIssues {
  const r = db.raw
    .prepare(
      `SELECT ${dupVolumesSql('?')} AS dup_volumes, ${dupFilesSql('?')} AS dup_files, ${looseFilesSql('?')} AS loose`
    )
    .get(seriesId, seriesId, seriesId) as Record<string, unknown>;
  return toIssues(Number(r.dup_volumes ?? 0), Number(r.dup_files ?? 0), Number(r.loose ?? 0));
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
  /** 抜けのある作品だけ (持っている範囲の中の穴) */
  gapsOnly?: boolean;
  /** 続きが出ている作品だけ (手元の最大巻より先が出ている) */
  behindOnly?: boolean;
  /** 出ているのに持っていない巻が 1 つでもある作品だけ */
  missingOnly?: boolean;
  completed?: boolean;
  rootId?: string;
  /** 表紙がまだ無いものだけ */
  needsCover?: boolean;
  /**
   * 棚の整合性で絞る。**総数 (`total`) にも効く** ので、
   * 「要確認 12 件」と出たらその 12 件が全部そこに並ぶ
   *   dup   … 同じ巻に複数のファイルがある
   *   loose … 何巻か読めないファイルがある
   *   any   … どちらか
   */
  issues?: 'any' | 'dup' | 'loose';
  sort?: 'title' | 'author' | 'added' | 'volumes' | 'updated';
  limit?: number;
  offset?: number;
}

interface CountRow {
  series_id: number;
  file_count: number;
  bytes: number;
  loose: number;
}

/**
 * 棚に出す表紙の URL。**焼いた絵の名前を後ろに付ける。**
 *
 * covers の行は表紙を差し替えても id が変わらない (writeCover が 1 行を書き換える) ので、
 * `/api/covers/<id>` だけでは選び直しても URL が同じまま。あの道は「焼いた絵は中身が
 * 変わらない」前提で 1 年の immutable を返す (server.ts) ため、ブラウザは二度と取りに
 * 来ず、**選び直したのに古い絵が出続ける** — 「選」の印だけが立って表紙は小説版のまま、
 * という見え方になる (マージナル・オペレーションの第01-02巻、2026-09-19)。
 *
 * 焼いた絵の名前は中身のハッシュなので、絵が変われば名前も変わる。URL に混ぜておけば
 * 差し替えた時だけ URL が変わり、変わらない間は今まで通り 1 年効く。
 */
function coverUrlOf(id: number, file: unknown): string {
  const v = String(file ?? '').replace(/\.[^.]*$/, '').slice(0, 12);
  return v ? `/api/covers/${id}?v=${v}` : `/api/covers/${id}`;
}

export function listSeries(db: Db, opts: ListOptions = {}): { total: number; items: SeriesSummary[] } {
  const where: string[] = ['s.present = 1'];
  const params: (string | number)[] = [];

  if (opts.rootId) {
    where.push('s.root_id = ?');
    params.push(opts.rootId);
  }
  if (opts.completed !== undefined) {
    // 人の指定が勝つ (db.ts の completedOf と同じ順)。生の s.completed で絞ると、
    // 画面で「完結」にした作品が「完結」の絞り込みから漏れる
    where.push('COALESCE(s.completed_user, s.completed) = ?');
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
  if (opts.issues) {
    // **SQL 側で絞る。** gapsOnly のように後から篩うと total とページの中身が食い違う
    const dup = `${dupVolumesSql('s.id')} > 0`;
    const loose = `${looseFilesSql('s.id')} > 0`;
    where.push(opts.issues === 'dup' ? dup : opts.issues === 'loose' ? loose : `(${dup} OR ${loose})`);
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
    updated: 'volume_added_at DESC, s.id DESC',
  }[opts.sort ?? 'title'];

  const limit = Math.min(opts.limit ?? 60, 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  const rows = db.raw
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM files f WHERE f.series_id = s.id AND f.present = 1) AS file_count,
              (SELECT COALESCE(SUM(f.size), 0) FROM files f WHERE f.series_id = s.id AND f.present = 1) AS bytes,
              ${looseFilesSql('s.id')} AS loose,
              ${dupVolumesSql('s.id')} AS dup_volumes,
              ${dupFilesSql('s.id')} AS dup_files,
              (SELECT c.id FROM covers c WHERE c.series_id = s.id AND c.volume_no IS NULL) AS cover_id,
              (SELECT c.file FROM covers c WHERE c.series_id = s.id AND c.volume_no IS NULL) AS cover_file,
              COALESCE(${volumeAddedAtSql('s.id')}, s.first_seen_at) AS volume_added_at
         FROM series s ${clause}
        ORDER BY ${order} LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as Record<string, unknown>[];

  const items = rows.map((r) => {
    const volumes = db.listVolumes(Number(r.id));
    const holdings = holdingsOf(volumes);
    // 行に series.* が全部入っているので、完結はここで解く (getSeries を引き直さない)
    const done = completedOf(r);
    const pub = publishedOf(db, Number(r.id), holdings, (r.enriched_at as string | null) ?? null);
    return {
      id: Number(r.id),
      rootId: String(r.root_id),
      folder: String(r.folder),
      seriesKey: String(r.series_key),
      title: String(r.title),
      author: (r.author as string | null) ?? null,
      label: seriesLabel(r.author as string | null, String(r.title)),
      completed: done.completed,
      folderCompleted: done.folderCompleted,
      completedUser: done.completedUser,
      present: Number(r.present) === 1,
      fileCount: Number(r.file_count),
      bytes: Number(r.bytes),
      looseFiles: Number(r.loose),
      holdings,
      hasGap: holdings.some((h) => h.missing.length > 0),
      shelf: shelfStateOf(pub, done.completedBy, holdings),
      issues: toIssues(Number(r.dup_volumes ?? 0), Number(r.dup_files ?? 0), Number(r.loose ?? 0)),
      coverUrl: r.cover_id ? coverUrlOf(Number(r.cover_id), r.cover_file) : null,
      firstSeenAt: String(r.first_seen_at),
      lastSeenAt: String(r.last_seen_at),
      volumeAddedAt: String(r.volume_added_at ?? r.first_seen_at),
    } satisfies SeriesSummary;
  });

  let filtered = items;
  if (opts.gapsOnly) filtered = filtered.filter((i) => i.hasGap);
  if (opts.behindOnly) filtered = filtered.filter((i) => i.shelf.aheadCount > 0);
  if (opts.missingOnly) filtered = filtered.filter((i) => i.shelf.missingCount > 0);
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
  /** その表紙を人が選んだか。**自動の取り直しでは上書きされない** 印 */
  coverPinned: boolean;
  /**
   * この巻に別々のファイルが 2 本以上ぶら下がっている。分割書庫の続きは数えない。
   * **どちらが正しいかは言わない** — 別版として両方置いているのか捨て漏れなのかは人が決める
   */
  duplicate: boolean;
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
  /**
   * 外の書誌が知っている巻。**「全何巻」ではなく下限**として読むこと。
   * 詳しくは published.ts の頭
   */
  published: PublishedInfo;
  /**
   * 人が選んだ書誌シリーズ。null なら書名と著者から自動で当てている。
   * **画面はこれを出して「今どの系列を見ているか」を言えるようにする** —
   * 血界戦線のように並走するシリーズがある作品では、そこが分からないと直しようがない
   */
  pick: SeriesPick | null;
  volumes: VolumeDetail[];
  /** 巻ではない収録物 (外伝・特別編・単巻作品) */
  side: SideVolume[];
  /** 巻としても別巻としても読めなかったファイル。欠番には効かないが、持ってはいる */
  loose: VolumeDetail['files'];
  bib: Record<string, unknown> | null;
}

/**
 * 巻ではない収録物。`鬼滅の刃 外伝` や `四月は君の嘘 Coda`、それに 1 冊で完結している作品。
 *
 * **数直線には乗せない。** 外伝を第 n 巻として数えると、持っていない巻ができたり
 * 最新巻が動いたりする。持っていることだけを言う。
 * 分割書庫は呼び名でまとまるので、`.part1` `.part2` があっても 1 行になる。
 */
export interface SideVolume {
  /** 作品の中での呼び名。**空なら作品そのもの** (1 冊で完結している作品) */
  label: string;
  files: VolumeDetail['files'];
}

export function getSeriesDetail(db: Db, id: number): SeriesDetail | null {
  const s = db.getSeries(id);
  if (!s) return null;

  const summary = listSeriesOne(db, s);
  const volumes = db.listVolumes(id);

  /**
   * **棚から消えたファイルは詳細に出さない。** 行は履歴として残してある (scanner.ts の頭)
   * が、混ぜると押せる「保存」の付いた板として並ぶ。押した先にファイルは無い。
   * 分割書庫の本数 (保存 1/3) も大きさの合計も、消えた分まで数えてしまう。
   */
  const fileRows = db.raw
    .prepare('SELECT * FROM files WHERE series_id = ? AND present = 1 ORDER BY rel_path')
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
    .prepare('SELECT id, volume_no, pinned, file FROM covers WHERE series_id = ?')
    .all(id) as { id: number; volume_no: number | null; pinned: number; file: string }[];
  const coverByVol = new Map(
    covers.filter((c) => c.volume_no !== null).map((c) => [Number(c.volume_no), c])
  );

  /**
   * その巻の板に出す表紙。
   *
   * **合本 (第01-06巻) には、覆う巻のうちいちばん若い巻の絵を出す。** 板は 1 枚しか
   * 置けないので、第01-06巻なら第01巻の絵が素直。単巻に限って空にしていたが、
   * それだと合本でしか持っていない巻が棚でも中でも絵無しのまま残る (手元で 799 冊)。
   *
   * ただし「選」の印は合本には立てない。あれは**この巻の表紙を選び直した**印で、
   * 選び直せるのは単巻だけ (下の single)。合本に出すと外し方の無い印になる。
   */
  const coverFor = (
    v: { volumeFrom: number; volumeTo: number }
  ): { id: number; pinned: number; file: string } | undefined => {
    if (v.volumeFrom === v.volumeTo) return coverByVol.get(v.volumeFrom);
    for (let i = v.volumeFrom; i <= v.volumeTo; i++) {
      const c = coverByVol.get(i);
      if (c) return { ...c, pinned: 0 };
    }
    return undefined;
  };

  /**
   * **棚から消えた巻は板ごと落とす。** markGone は行を消さずに present を倒すだけなので、
   * 合本を解いた後の「第01-04巻」のような巻が volumes に残る。数直線 (holdingsOf) は
   * 既に present で切っているので、ここだけが消えた巻を出していた。
   */
  const details: VolumeDetail[] = volumes.filter((v) => v.present).map((v) => {
    const cover = coverFor(v);
    const mine = fileRows.filter((r) => Number(r.volume_id) === v.id);
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
      coverUrl: cover ? coverUrlOf(cover.id, cover.file) : null,
      coverPinned: Number(cover?.pinned ?? 0) === 1,
      duplicate: new Set(mine.map(fileBaseOf)).size > 1,
      files: mine.map(toFile),
    };
  });

  // 別巻は呼び名でまとめる。分割書庫の .part2 が別の外伝として並ばないように。
  // 作品そのもの (呼び名が空) を先頭に置く
  const sideBy = new Map<string, VolumeDetail['files']>();
  for (const r of fileRows) {
    if (r.volume_id !== null || r.side_label === null) continue;
    const key = String(r.side_label);
    const acc = sideBy.get(key) ?? [];
    acc.push(toFile(r));
    sideBy.set(key, acc);
  }
  const side: SideVolume[] = [...sideBy]
    .map(([label, files]) => ({ label, files }))
    .sort((a, b) => (a.label ? 1 : 0) - (b.label ? 1 : 0) || a.label.localeCompare(b.label, 'ja'));

  const bibRow = db.raw
    .prepare('SELECT * FROM bib WHERE series_id = ? AND volume_no IS NULL LIMIT 1')
    .get(id) as Record<string, unknown> | undefined;

  return {
    ...summary,
    published: publishedOf(db, id, summary.holdings, s.enrichedAt),
    pick: db.getSeriesPick(id),
    volumes: details,
    side,
    loose: fileRows.filter((r) => r.volume_id === null && r.side_label === null).map(toFile),
    bib: bibRow ? { ...bibRow, raw: JSON.parse(String(bibRow.raw ?? '{}')) } : null,
  };
}

function listSeriesOne(db: Db, s: SeriesRow): SeriesSummary {
  const agg = db.raw
    .prepare(
      `SELECT COUNT(*) AS file_count, COALESCE(SUM(size), 0) AS bytes,
              SUM(CASE WHEN volume_id IS NULL AND side_label IS NULL THEN 1 ELSE 0 END) AS loose
         FROM files WHERE series_id = ? AND present = 1`
    )
    .get(s.id) as unknown as CountRow;
  const cover = db.raw
    .prepare('SELECT id, file FROM covers WHERE series_id = ? AND volume_no IS NULL')
    .get(s.id) as { id: number; file: string } | undefined;
  const added = db.raw
    .prepare(`SELECT ${volumeAddedAtSql('?')} AS at`)
    .get(s.id) as { at: string | null };
  const holdings = holdingsOf(db.listVolumes(s.id));
  const pub = publishedOf(db, s.id, holdings, s.enrichedAt);
  return {
    id: s.id,
    rootId: s.rootId,
    folder: s.folder,
    seriesKey: s.seriesKey,
    title: s.title,
    author: s.author,
    label: seriesLabel(s.author, s.title),
    completed: s.completed,
    folderCompleted: s.folderCompleted,
    completedUser: s.completedUser,
    present: s.present,
    fileCount: Number(agg.file_count ?? 0),
    bytes: Number(agg.bytes ?? 0),
    looseFiles: Number(agg.loose ?? 0),
    holdings,
    hasGap: holdings.some((h) => h.missing.length > 0),
    shelf: shelfStateOf(pub, s.completedBy, holdings),
    issues: issuesOf(db, s.id),
    coverUrl: cover ? coverUrlOf(cover.id, cover.file) : null,
    firstSeenAt: s.firstSeenAt,
    lastSeenAt: s.lastSeenAt,
    volumeAddedAt: added.at ?? s.firstSeenAt,
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
