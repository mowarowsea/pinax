import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 蔵書カタログ。Node 内蔵の SQLite だけで動く (追加インストール不要)。
 *
 * 中心にあるのは 3 段:
 *
 *   series (作品)  ─┬─ volumes (巻)  ─── files (実ファイル)
 *                   └─ covers / bib (外から取った書影と書誌)
 *
 * **作品の単位はフォルダ** (root_id, folder) で、`series_key` は同一性の判定にだけ使う
 * 別軸。ここを 1 本にまとめてはいけない — `[BETEMIUS] 同人誌` と `[河内和泉] 同人誌` は
 * 同じ series_key になるが別の棚で、逆に外から `title: "作品名"` だけで所持を聞かれる時は
 * フォルダ名を知らない。用途が違うので列も分ける (docs/ARCHITECTURE.md 3 章)。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  series_key TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  -- フォルダ名の (完) から読んだ完結。**スキャンが書く列で、人は触らない**
  completed INTEGER NOT NULL DEFAULT 0,
  -- 人が画面で決めた完結。null = 未指定 (フォルダに従う) / 1 = 完結 / 0 = 継続中。
  -- **フォルダ由来と別の列にする。** 同じ列に上書きすると次のスキャンで踏み潰され、
  -- 逆に人の指定でフォルダ側を書き換えると「ファイルが正」という土台が崩れる
  completed_user INTEGER,

  present INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- 最後に外へ書誌を聞きに行った時刻。**取れなかった時にも必ず入れる。**
  -- 「表紙が無い作品」を選び直す作りにすると、NDL に書影が無い作品が先頭に居座って
  -- 後ろの作品まで一生進まない (2026-09-12 に実地で踏んだ)
  enriched_at TEXT,
  UNIQUE(root_id, folder)
);
CREATE INDEX IF NOT EXISTS series_key_idx ON series(series_key);

-- 論理的な 1 巻。同じ巻の別版 ([LQ] など) や分割書庫は files 側で複数になる
CREATE TABLE IF NOT EXISTS volumes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  volume_from INTEGER NOT NULL,
  volume_to INTEGER NOT NULL,
  unit TEXT NOT NULL DEFAULT '巻',
  completed INTEGER NOT NULL DEFAULT 0,
  present INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(series_id, unit, volume_from, volume_to)
);
CREATE INDEX IF NOT EXISTS volumes_series_idx ON volumes(series_id);

-- 実ファイル。volume_id が null なら「巻数を読めなかったファイル」で、
-- 欠番の計算には参加しないが作品には属している
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  series_id INTEGER REFERENCES series(id) ON DELETE CASCADE,
  volume_id INTEGER REFERENCES volumes(id) ON DELETE SET NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mtime TEXT,
  ext TEXT,
  part TEXT,
  part_no INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  present INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(root_id, rel_path)
);
CREATE INDEX IF NOT EXISTS files_series_idx ON files(series_id);
CREATE INDEX IF NOT EXISTS files_volume_idx ON files(volume_id);

-- 外から取った書影。**必ずローカルに焼いてから行を作る** ("Never burn")。
-- volume_no が null なら作品の代表表紙
CREATE TABLE IF NOT EXISTS covers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  volume_no INTEGER,
  provider TEXT NOT NULL,
  source_url TEXT,
  isbn TEXT,
  file TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  content_type TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(series_id, volume_no)
);

-- 外から取った書誌。raw は加工前のまま持つ — 解釈を後から直せるようにするため
CREATE TABLE IF NOT EXISTS bib (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  volume_no INTEGER,
  provider TEXT NOT NULL,
  isbn TEXT,
  title TEXT,
  author TEXT,
  publisher TEXT,
  pubdate TEXT,
  cover_url TEXT,
  raw TEXT NOT NULL DEFAULT '{}',
  fetched_at TEXT NOT NULL,
  UNIQUE(series_id, volume_no, provider)
);

-- 外部 API の汎用キャッシュ。pinax から外へ出る問い合わせは全部ここを通る。
-- **期限切れでも消さない。** 外が落ちている時に古い値を返せることが値打ち
CREATE TABLE IF NOT EXISTS http_cache (
  key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  url TEXT NOT NULL,
  status INTEGER NOT NULL,
  content_type TEXT,
  body TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS http_cache_provider_idx ON http_cache(provider, fetched_at DESC);

-- 画面トップの「お知らせ」。通知を出したかどうかとは別に、必ずここへ残す
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  series_id INTEGER,
  title TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT,
  notified_at TEXT
);
CREATE INDEX IF NOT EXISTS events_created_idx ON events(created_at DESC);

CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  files_seen INTEGER NOT NULL DEFAULT 0,
  series_added INTEGER NOT NULL DEFAULT 0,
  volumes_added INTEGER NOT NULL DEFAULT 0,
  gone INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
`;

export type EventKind = 'series_added' | 'volume_added' | 'volume_gone' | 'series_completed';

/**
 * 完結と言っているのは誰か。
 *
 * **外の書誌は入らない。** 完結が外から分からないことは実測済み (published.ts の頭)。
 * ここに載るのは人が下した判断だけで、`user` (画面で指定) が `folder` (フォルダの `(完)`) に勝つ。
 */
export type CompletedSource = 'folder' | 'user' | null;

export interface SeriesRow {
  id: number;
  rootId: string;
  folder: string;
  seriesKey: string;
  title: string;
  author: string | null;
  /** 実効値。人の指定があればそちら、無ければフォルダの `(完)` */
  completed: boolean;
  /** フォルダ名の `(完)`。スキャンが書く */
  folderCompleted: boolean;
  /** 人が画面で決めた値。null なら未指定 (フォルダに従う) */
  completedUser: boolean | null;
  /** 完結の根拠。画面で「誰がそう言ったか」を出すために持つ */
  completedBy: CompletedSource;
  present: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  /** 最後に外へ書誌を聞きに行った時刻。null なら一度も聞いていない */
  enrichedAt: string | null;
}

export interface VolumeRow {
  id: number;
  seriesId: number;
  volumeFrom: number;
  volumeTo: number;
  unit: string;
  completed: boolean;
  present: boolean;
  firstSeenAt: string;
}

const now = (): string => new Date().toISOString();

export class Db {
  readonly raw: DatabaseSync;

  constructor(dataDir: string) {
    this.raw = new DatabaseSync(path.join(dataDir, 'pinax.db'));
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    /**
     * **書き手が 2 人いる前提で待つ。**
     *
     * サーバーが動いたまま `npm run covers` や `npm run scan` を回すことは普通にある。
     * WAL は読みと書きは同時に通すが、書き手同士は直列で、既定では待たずに
     * その場で SQLITE_BUSY を投げる。表紙を 1600 巻ぶん埋めている最中に
     * スキャンの書き込みとかち合って落ちる、という壊れ方をする。待てば済む話なので待たせる。
     *
     * **スキャン 1 回ぶんより長く取ること。** scanner.ts は棚の突き合わせを
     * 丸ごと 1 トランザクションで書く (途中で倒れた時に蔵書が半端な姿で残らないように)。
     * 手元の 4945 ファイルでスキャンは 51 秒かかるので、15 秒では足りずに
     * 実際 `database is locked` で落ちた (2026-09-14)。
     */
    this.raw.exec('PRAGMA busy_timeout = 90000');
    this.raw.exec(SCHEMA);
    this.migrate();
  }

  /**
   * 既にある DB に後から足した列を埋める。
   * `CREATE TABLE IF NOT EXISTS` は既存の表を作り直さないので、列の追加はここで面倒を見る。
   */
  private migrate(): void {
    const cols = (table: string): Set<string> =>
      new Set(
        (this.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => String(c.name))
      );
    if (!cols('series').has('enriched_at')) {
      this.raw.exec('ALTER TABLE series ADD COLUMN enriched_at TEXT');
    }
    // 巻ごとの表紙を最後に取りに行った時刻。**取れなかった時にも必ず入れる。**
    // 入れないと、どこにも書影の無い巻を巡回が毎回選び直して先へ進まなくなる
    // (series.enriched_at と同じ理屈)
    if (!cols('bib').has('cover_tried_at')) {
      this.raw.exec('ALTER TABLE bib ADD COLUMN cover_tried_at TEXT');
    }
    // 人が画面で決めた完結。フォルダ由来の completed とは別列 (SCHEMA 側の註を参照)
    if (!cols('series').has('completed_user')) {
      this.raw.exec('ALTER TABLE series ADD COLUMN completed_user INTEGER');
    }
    // 列を足した後に張る。SCHEMA 側に置くと、既にある DB では列より先に走って失敗する
    this.raw.exec('CREATE INDEX IF NOT EXISTS series_enriched_idx ON series(enriched_at)');
    this.raw.exec('CREATE INDEX IF NOT EXISTS bib_cover_tried_idx ON bib(cover_tried_at)');
  }

  /** この bib 行の表紙を取りに行った印。**失敗した時こそ押す** */
  markCoverTried(bibId: number): void {
    this.raw.prepare('UPDATE bib SET cover_tried_at = ? WHERE id = ?').run(now(), bibId);
  }

  /** 外へ聞きに行った印。取れたかどうかに関わらず押す */
  markEnriched(seriesId: number): void {
    this.raw.prepare('UPDATE series SET enriched_at = ? WHERE id = ?').run(now(), seriesId);
  }

  close(): void {
    this.raw.close();
  }

  // ---- series ------------------------------------------------------------

  /** フォルダ 1 つ = 作品 1 つ。あれば更新して返す */
  upsertSeries(input: {
    rootId: string; folder: string; seriesKey: string;
    title: string; author: string | null; completed: boolean;
  }): { row: SeriesRow; created: boolean; newlyCompleted: boolean } {
    const t = now();
    const before = this.findSeriesByFolder(input.rootId, input.folder);
    if (!before) {
      this.raw
        .prepare(
          `INSERT INTO series (root_id, folder, series_key, title, author, completed, present,
                               first_seen_at, last_seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
        )
        .run(input.rootId, input.folder, input.seriesKey, input.title, input.author,
          input.completed ? 1 : 0, t, t, t);
      const row = this.findSeriesByFolder(input.rootId, input.folder)!;
      return { row, created: true, newlyCompleted: input.completed };
    }
    // 完結は一度立ったら倒さない。印を外して置き直すことはあっても、
    // 「完結でなくなる」ことは無いので、消えたように見えたら読み落としを疑う方が正しい。
    // **触るのはフォルダ由来の列だけ。** 人の指定 (completed_user) はスキャンでは動かさない
    const folderCompleted = before.folderCompleted || input.completed;
    this.raw
      .prepare(
        `UPDATE series SET series_key = ?, title = ?, author = ?, completed = ?, present = 1,
                           last_seen_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(input.seriesKey, input.title, input.author, folderCompleted ? 1 : 0, t, t, before.id);
    const row = this.getSeries(before.id)!;
    return {
      row,
      created: false,
      // お知らせは**実効値**で出す。人が「継続中」と指定した作品のフォルダに
      // 後から (完) が付いても、人の指定が勝っている間は完結を告げない
      newlyCompleted: !before.completed && row.completed,
    };
  }

  /**
   * 完結を人の手で決める。`null` で指定を外し、フォルダの `(完)` に従う状態へ戻す。
   *
   * **フォルダ側 (`completed`) は書き換えない。** 書き換えると次のスキャンが
   * ファイルを見て上書きし直すので、指定が黙って消える。
   */
  setCompletedOverride(seriesId: number, value: boolean | null): SeriesRow | null {
    this.raw
      .prepare('UPDATE series SET completed_user = ?, updated_at = ? WHERE id = ?')
      .run(value === null ? null : value ? 1 : 0, now(), seriesId);
    return this.getSeries(seriesId);
  }

  findSeriesByFolder(rootId: string, folder: string): SeriesRow | null {
    const r = this.raw
      .prepare('SELECT * FROM series WHERE root_id = ? AND folder = ?')
      .get(rootId, folder) as Record<string, unknown> | undefined;
    return r ? toSeries(r) : null;
  }

  getSeries(id: number): SeriesRow | null {
    const r = this.raw.prepare('SELECT * FROM series WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? toSeries(r) : null;
  }

  findSeriesByKey(seriesKey: string): SeriesRow[] {
    const rs = this.raw.prepare('SELECT * FROM series WHERE series_key = ?').all(seriesKey) as Record<string, unknown>[];
    return rs.map(toSeries);
  }

  // ---- volumes -----------------------------------------------------------

  upsertVolume(input: {
    seriesId: number; volumeFrom: number; volumeTo: number; unit: string; completed: boolean;
  }): { row: VolumeRow; created: boolean } {
    const t = now();
    const find = (): VolumeRow | null => {
      const r = this.raw
        .prepare('SELECT * FROM volumes WHERE series_id = ? AND unit = ? AND volume_from = ? AND volume_to = ?')
        .get(input.seriesId, input.unit, input.volumeFrom, input.volumeTo) as Record<string, unknown> | undefined;
      return r ? toVolume(r) : null;
    };
    const before = find();
    if (!before) {
      this.raw
        .prepare(
          `INSERT INTO volumes (series_id, volume_from, volume_to, unit, completed, present, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .run(input.seriesId, input.volumeFrom, input.volumeTo, input.unit, input.completed ? 1 : 0, t, t);
      return { row: find()!, created: true };
    }
    this.raw
      .prepare('UPDATE volumes SET completed = ?, present = 1, last_seen_at = ? WHERE id = ?')
      .run(before.completed || input.completed ? 1 : 0, t, before.id);
    return { row: find()!, created: false };
  }

  listVolumes(seriesId: number): VolumeRow[] {
    const rs = this.raw
      .prepare('SELECT * FROM volumes WHERE series_id = ? ORDER BY unit, volume_from')
      .all(seriesId) as Record<string, unknown>[];
    return rs.map(toVolume);
  }

  // ---- files -------------------------------------------------------------

  upsertFile(input: {
    rootId: string; relPath: string; seriesId: number; volumeId: number | null;
    size: number; mtime: string | null; ext: string; part: string; partNo: number | null; tags: string[];
  }): void {
    const t = now();
    this.raw
      .prepare(
        `INSERT INTO files (root_id, rel_path, series_id, volume_id, size, mtime, ext, part, part_no,
                            tags, present, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(root_id, rel_path) DO UPDATE SET
           series_id = excluded.series_id, volume_id = excluded.volume_id,
           size = excluded.size, mtime = excluded.mtime, tags = excluded.tags,
           present = 1, last_seen_at = excluded.last_seen_at`
      )
      .run(input.rootId, input.relPath, input.seriesId, input.volumeId, input.size, input.mtime,
        input.ext, input.part, input.partNo, JSON.stringify(input.tags), t, t);
  }

  /** 今回のスキャンで見なかったものを「消えた」に倒す。行は消さない (履歴を残すため) */
  markGone(rootId: string, scanStartedAt: string): number {
    const r = this.raw
      .prepare('UPDATE files SET present = 0 WHERE root_id = ? AND present = 1 AND last_seen_at < ?')
      .run(rootId, scanStartedAt);
    this.raw.exec(`
      UPDATE volumes SET present = 0
       WHERE present = 1
         AND NOT EXISTS (SELECT 1 FROM files f WHERE f.volume_id = volumes.id AND f.present = 1)`);
    this.raw.exec(`
      UPDATE series SET present = 0
       WHERE present = 1
         AND NOT EXISTS (SELECT 1 FROM files f WHERE f.series_id = series.id AND f.present = 1)`);
    return Number(r.changes ?? 0);
  }

  // ---- events ------------------------------------------------------------

  addEvent(kind: EventKind, title: string, detail: string | null, seriesId: number | null): number {
    const r = this.raw
      .prepare('INSERT INTO events (kind, series_id, title, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(kind, seriesId, title, detail, now());
    return Number(r.lastInsertRowid);
  }

  listEvents(opts: { unreadOnly?: boolean; limit?: number } = {}): Record<string, unknown>[] {
    const limit = Math.min(opts.limit ?? 50, 500);
    const where = opts.unreadOnly ? 'WHERE read_at IS NULL' : '';
    return this.raw
      .prepare(`SELECT * FROM events ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
  }

  markEventsRead(ids: number[]): void {
    if (!ids.length) return;
    const stmt = this.raw.prepare('UPDATE events SET read_at = ? WHERE id = ? AND read_at IS NULL');
    const t = now();
    for (const id of ids) stmt.run(t, id);
  }

  takeUnnotified(limit = 20): Record<string, unknown>[] {
    return this.raw
      .prepare('SELECT * FROM events WHERE notified_at IS NULL ORDER BY id LIMIT ?')
      .all(limit) as Record<string, unknown>[];
  }

  markNotified(ids: number[]): void {
    const stmt = this.raw.prepare('UPDATE events SET notified_at = ? WHERE id = ?');
    const t = now();
    for (const id of ids) stmt.run(t, id);
  }

  // ---- scans -------------------------------------------------------------

  startScan(rootId: string, startedAt: string): number {
    const r = this.raw
      .prepare('INSERT INTO scans (root_id, started_at) VALUES (?, ?)')
      .run(rootId, startedAt);
    return Number(r.lastInsertRowid);
  }

  finishScan(id: number, stat: {
    filesSeen: number; seriesAdded: number; volumesAdded: number; gone: number; error: string | null;
  }): void {
    this.raw
      .prepare(
        `UPDATE scans SET finished_at = ?, files_seen = ?, series_added = ?, volumes_added = ?,
                          gone = ?, error = ? WHERE id = ?`
      )
      .run(now(), stat.filesSeen, stat.seriesAdded, stat.volumesAdded, stat.gone, stat.error, id);
  }

  lastScans(limit = 10): Record<string, unknown>[] {
    return this.raw
      .prepare('SELECT * FROM scans ORDER BY id DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
  }

  // ---- http キャッシュ ----------------------------------------------------

  getCache(key: string): { status: number; body: string; contentType: string | null; fetchedAt: string; expiresAt: string } | null {
    const r = this.raw.prepare('SELECT * FROM http_cache WHERE key = ?').get(key) as Record<string, unknown> | undefined;
    if (!r) return null;
    this.raw.prepare('UPDATE http_cache SET hits = hits + 1 WHERE key = ?').run(key);
    return {
      status: Number(r.status),
      body: String(r.body),
      contentType: (r.content_type as string | null) ?? null,
      fetchedAt: String(r.fetched_at),
      expiresAt: String(r.expires_at),
    };
  }

  putCache(input: {
    key: string; provider: string; url: string; status: number;
    contentType: string | null; body: string; expiresAt: string;
  }): void {
    this.raw
      .prepare(
        `INSERT INTO http_cache (key, provider, url, status, content_type, body, fetched_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           status = excluded.status, content_type = excluded.content_type, body = excluded.body,
           fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`
      )
      .run(input.key, input.provider, input.url, input.status, input.contentType, input.body, now(), input.expiresAt);
  }

  cacheStats(): Record<string, unknown>[] {
    return this.raw
      .prepare('SELECT provider, COUNT(*) AS entries, SUM(hits) AS hits FROM http_cache GROUP BY provider')
      .all() as Record<string, unknown>[];
  }
}

function toSeries(r: Record<string, unknown>): SeriesRow {
  return {
    id: Number(r.id),
    rootId: String(r.root_id),
    folder: String(r.folder),
    seriesKey: String(r.series_key),
    title: String(r.title),
    author: (r.author as string | null) ?? null,
    ...completedOf(r),
    present: Number(r.present) === 1,
    firstSeenAt: String(r.first_seen_at),
    lastSeenAt: String(r.last_seen_at),
    enrichedAt: (r.enriched_at as string | null) ?? null,
  };
}

/**
 * フォルダ由来と人の指定を 1 つの答えにまとめる。
 *
 * **人の指定が勝つ。** フォルダに `(完)` を付け忘れている作品も、逆に `(完)` が
 * 付いているのに新装版が出てしまった作品も実在するので、後から人が言い直せる方を上に置く。
 * ただし**上書きはしない** — `completed_user` を null に戻せばフォルダの答えへ帰る。
 */
export function completedOf(r: Record<string, unknown>): {
  completed: boolean; folderCompleted: boolean; completedUser: boolean | null; completedBy: CompletedSource;
} {
  const folderCompleted = Number(r.completed) === 1;
  const completedUser = r.completed_user === null || r.completed_user === undefined
    ? null
    : Number(r.completed_user) === 1;
  const completed = completedUser ?? folderCompleted;
  return {
    completed,
    folderCompleted,
    completedUser,
    completedBy: !completed ? null : completedUser !== null ? 'user' : 'folder',
  };
}

function toVolume(r: Record<string, unknown>): VolumeRow {
  return {
    id: Number(r.id),
    seriesId: Number(r.series_id),
    volumeFrom: Number(r.volume_from),
    volumeTo: Number(r.volume_to),
    unit: String(r.unit),
    completed: Number(r.completed) === 1,
    present: Number(r.present) === 1,
    firstSeenAt: String(r.first_seen_at),
  };
}
