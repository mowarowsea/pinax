import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PageIndex } from './archive.js';
import { parseLibraryEntry } from './naming.js';

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

/**
 * 外から取った書影。**必ずローカルに焼いてから行を作る** ("Never burn")。
 *
 * 宛先は `slot` 1 本 (src/cover-slot.ts)。単巻も合本も別巻も代表も同じ形で名指しできる。
 * **表を作り直す移行がここを読み直す** ので、SCHEMA から切り出してある。
 */
const COVERS_TABLE = `
CREATE TABLE IF NOT EXISTS covers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  -- 表紙の宛先。'' が代表、'v:巻:3' が第03巻、'v:巻:1-2' が合本、's:外伝' が別巻。
  -- **一意の宛先はこれ 1 本**で、代表を部分索引で縛る特例は要らない
  slot TEXT NOT NULL DEFAULT '',
  -- この板が覆う一番若い巻。**宛先ではなく並べ替えの鍵**で、代表と別巻は null。
  -- 代表表紙を「持っている中で一番若い巻」の絵に合わせるために要る
  volume_no INTEGER,
  provider TEXT NOT NULL,
  source_url TEXT,
  isbn TEXT,
  file TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  content_type TEXT,
  -- 人が画面で選んだ表紙。**立っている行を自動の巡回は上書きしない。**
  -- series.completed_user と同じ立場 (機械の当てずっぽうより人の判断が上)
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(series_id, slot)
);
`;

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
-- 欠番の計算には参加しないが作品には属している。
-- そのうち外伝・特別編と読めたものは side_label に呼び名が入る (naming.ts
-- sideLabelAfterFolder)。**null と空文字を区別すること** — 空文字は「1 冊で完結して
-- いる作品」、null は「呼び名も読めなかった = 要確認」で、意味がまるで違う
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
  side_label TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  present INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(root_id, rel_path)
);
CREATE INDEX IF NOT EXISTS files_series_idx ON files(series_id);
CREATE INDEX IF NOT EXISTS files_volume_idx ON files(volume_id);

${COVERS_TABLE}

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

-- 人が「この作品の書誌はこのシリーズだ」と選んだ印。作品 1 つに 1 行。
--
-- **要るのは、同じ作者・同じ書名で別のシリーズが並走しているから。**
-- 血界戦線 / 血界戦線Back 2 Back / 血界戦線Beat 3 Peat は NDL を書名で引くと
-- 1 つの答えに混ざって返り、機械には手元のどれが正しいか分からない (bib/candidates.ts)。
--
-- series.completed_user と同じで、**スキャンも自動の巡回もこの表を書き換えない。**
-- 人が選び直すか、指定を外すまで残る。
CREATE TABLE IF NOT EXISTS series_pick (
  series_id INTEGER PRIMARY KEY REFERENCES series(id) ON DELETE CASCADE,
  -- 聞きに行く先。'all' | 'ndl' | 'rakuten'。
  -- **提供元ではなく「検索の範囲」。** 束は提供元をまたぐ (bib/candidates.ts) ので、
  -- ここに 1 つの提供元を書くと、選んだ時に見えていた候補と取り直しの候補がずれる
  scope TEXT NOT NULL,
  -- bib/candidates.ts の束の鍵 (seriesKeyOf された書名)。次に取り直す時もこれで束を選ぶ
  group_key TEXT NOT NULL,
  -- 見出しに出す書名と、外へ投げ直す問い合わせ。**選んだ時の問い合わせをそのまま残す** —
  -- 作品名から組み立て直すと、人が打ち直した検索語で当てた束を二度と引けない
  title TEXT NOT NULL,
  -- 束の著者を**棚のフォルダ名に書く形**へ寄せたもの (bib/candidates.ts の authorName)。
  -- 提供元の表記そのまま (NDL の「内藤, 泰弘」) ではフォルダ名にならないので、
  -- 寄せた方を選んだ時点で控えておく。**名前を直す時の既定値になる** —
  -- 書名だけ控えて著者を捨てると、人が毎回手で打ち直すことになる
  author TEXT,
  query_title TEXT NOT NULL,
  query_author TEXT,
  picked_at TEXT NOT NULL
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

-- 書庫の中のページの並び。**ページそのものは持たない。** ここにあるのは
-- 「何という名前のページが何番目か」だけで、絵は毎回書庫から読む (src/archive.ts の頭)。
--
-- 覚えておくのは rar の一覧が SMB 越しに 1 冊 1 秒前後かかるため (大きいもので 20 秒超)。
-- **size と mtime が変わったら作り直す** — 覚えた内容を信じ続けると、書庫を入れ替えた時に
-- 無いページを指したまま動く。ファイルが正、という土台はここでも崩さない。
-- 消えても困らない (もう一度読めば作れる)。
CREATE TABLE IF NOT EXISTS page_index (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  size INTEGER NOT NULL,
  mtime TEXT NOT NULL,
  format TEXT NOT NULL,
  pages TEXT NOT NULL,
  skipped TEXT NOT NULL,
  nested INTEGER NOT NULL DEFAULT 0,
  built_at TEXT NOT NULL,
  -- 作るのに掛かった時間。速さの話をする時に実測が要る
  build_ms INTEGER NOT NULL DEFAULT 0
);

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

/** 人が選んだ書誌シリーズ (series_pick 表の 1 行) */
export interface SeriesPick {
  seriesId: number;
  /** 聞きに行く先。'all' | 'ndl' | 'rakuten'。**提供元ではなく検索の範囲** */
  scope: string;
  /** bib/candidates.ts の束の鍵 */
  groupKey: string;
  /** 見出しに出す書名 */
  title: string;
  /** 束の著者を棚の形へ寄せたもの。選ぶ前に付いた指定では null */
  author: string | null;
  /** 選んだ時に外へ投げた問い合わせ。取り直す時もこれを使う */
  queryTitle: string;
  queryAuthor: string | null;
  pickedAt: string;
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
    // 人が画面で選んだ表紙。自動の巡回が上書きしないための印 (SCHEMA 側の註を参照)
    if (!cols('covers').has('pinned')) {
      this.raw.exec('ALTER TABLE covers ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
    }
    // 巻ではない収録物 (外伝・特別編) の呼び名。**機械が毎回書き直す列**で、
    // completed_user や covers.pinned のような「人の判断」ではない。
    // 足した直後は全行 null だが、次のスキャンが upsertFile で全ファイルを
    // 通るので放っておいても埋まる
    if (!cols('files').has('side_label')) {
      this.raw.exec('ALTER TABLE files ADD COLUMN side_label TEXT');
    }
    // 選んだ束の著者 (SCHEMA 側の註を参照)。足した直後は null で、
    // **次に選び直した時にだけ埋まる** — 過去の選択から後付けで当てようとすると、
    // 束を引き直すために外を叩くことになる (起動のたびに全作品ぶん、が起きる)
    if (!cols('series_pick').has('author')) {
      this.raw.exec('ALTER TABLE series_pick ADD COLUMN author TEXT');
    }
    /**
     * covers に**表紙の宛先** (slot) を入れる。src/cover-slot.ts の頭に形がある。
     *
     * 入れるまで名指しできたのは代表と単巻だけで、合本 (第01-02巻) は第01巻の絵を
     * 借りて出し、別巻 (外伝) には絵の入る道そのものが無かった。**どちらも
     * 「人が選び直す先が無い」という同じ欠け**なので、宛先を 1 本に揃えて塞ぐ。
     *
     * **表ごと作り直す。** ALTER では table 制約の `UNIQUE(series_id, volume_no)` を
     * 落とせず、残したままだと合本の板 (覆う中で一番若い巻を volume_no に名乗る) と
     * 第01巻の板が同じ番号を取り合って弾かれる。
     *
     * 移し替えは `volume_no → 'v:巻:n'`。**単位は巻と決め打つ** — 以前の covers は
     * 単位を持っておらず、混ざっていた「第224話」の表紙と見分けようが無い。
     * 取り違えても次の取り直しで正しい板へ貼り直るので、ここでは一番多い方に寄せる。
     */
    if (!cols('covers').has('slot')) {
      /**
       * 移す前に、増殖した代表表紙 (volume_no IS NULL) を作品ごとに 1 行へ畳む。
       *
       * `UNIQUE(series_id, volume_no)` は**代表には効いていなかった。** SQLite は
       * 一意制約の中で NULL 同士を別物として扱うので、writeCover の
       * `ON CONFLICT(series_id, volume_no)` が代表では一度も当たらず、
       * 取り直すたびに行が増えていた (手元の棚で 520 作品に 1637 行、
       * うち 149 作品は行によって**中身の違う絵**を指していた。2026-09-18 に実測)。
       *
       * 読む側 (catalog.ts) は並べ替えずに 1 行引くので、拾うのは**一番古い行**になる。
       * つまり最初に貼った絵が棚の顔に居座り、後から取り直しても変わらず、
       * **画面で「代表にする」を押しても効かない** (pinned を立てた行が新しい方に居るため)。
       *
       * 残すのは「人が選んだ行 → 新しい行」の順に 1 行だけ。焼いた画像には触らない
       * (同じ file を他の巻の行が指している)。以後は `UNIQUE(series_id, slot)` が
       * 増殖そのものを止めるので、**畳むのはこの 1 回きり**。
       */
      this.raw.exec(
        `DELETE FROM covers WHERE volume_no IS NULL AND id NOT IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (
               PARTITION BY series_id ORDER BY pinned DESC, id DESC
             ) AS rn FROM covers WHERE volume_no IS NULL
           ) WHERE rn = 1
         )`
      );
      this.raw.exec('ALTER TABLE covers RENAME TO covers_old');
      this.raw.exec(COVERS_TABLE);
      this.raw.exec(
        `INSERT INTO covers (series_id, slot, volume_no, provider, source_url, isbn,
                             file, bytes, content_type, pinned, created_at)
           SELECT series_id,
                  CASE WHEN volume_no IS NULL THEN '' ELSE 'v:巻:' || volume_no END,
                  volume_no, provider, source_url, isbn,
                  file, bytes, content_type, pinned, created_at
             FROM covers_old`
      );
      this.raw.exec('DROP TABLE covers_old');
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
   * 作品フォルダの名前を付け替える。**`series.id` を保ったまま**書き換えるのが肝。
   *
   * エクスプローラで名前を変えると、一意キーが `(root_id, folder)` なので
   * 次のスキャンは**別の作品として新しい行を作る**。焼いた表紙も、選んだ系列
   * (`series_pick`) も、完結の指定も古い行に取り残され、棚からは消えたように見える。
   * ここを通せば全部ぶら下がったまま残る。
   *
   * `completed` (フォルダ由来の列) もここで書く。`upsertSeries` は
   * 「一度立った完結は倒さない」ので、**印を外す向きの付け替えはスキャン任せにできない**。
   * 併せて `completed_user` を外す — フォルダに書き出した以上、逃げ道はもう要らない。
   *
   * `files.rel_path` も一緒に付け替える。**ここを落とすと次のスキャンで
   * 全ファイルが「消えた」に倒れ、同じ数だけ「増えた」が立つ。**
   * 区切りは Windows の `\` と POSIX の `/` の両方を見る (DB は歩いた OS の形で持つ)。
   *
   * `moves` は**ファイル名そのものの付け替え** (今の名前 → 新しい名前)。
   * 何をどう名付け直すかを決めるのは rename.ts で、ここは言われた通りに写すだけ —
   * 決める側と書く側を分けておかないと、計画で見せた名前と DB の中身がずれる。
   */
  renameSeriesFolder(input: {
    seriesId: number; folder: string; title: string; author: string | null;
    seriesKey: string; completed: boolean; moves?: Record<string, string>;
  }): SeriesRow {
    const t = now();
    const before = this.getSeries(input.seriesId);
    if (!before) throw new Error('その作品はありません');

    this.raw
      .prepare(
        `UPDATE series SET folder = ?, title = ?, author = ?, series_key = ?,
                           completed = ?, completed_user = NULL, updated_at = ?
          WHERE id = ?`
      )
      .run(input.folder, input.title, input.author, input.seriesKey,
        input.completed ? 1 : 0, t, input.seriesId);

    const rows = this.raw
      .prepare('SELECT id, rel_path, volume_id FROM files WHERE series_id = ?')
      .all(input.seriesId) as { id: number; rel_path: string; volume_id: number | null }[];
    const upd = this.raw.prepare('UPDATE files SET rel_path = ?, side_label = ? WHERE id = ?');
    /**
     * 行き先の道が塞がっていることがある。**消えた印の付いた行だけ**どかす。
     *
     * `UNIQUE(root_id, rel_path)` があるので、昔そこに居て今は消えている行が
     * 残っていると付け替えが丸ごと倒れる。名前を戻す向きの付け替えで必ず来る。
     * 生きている行は消さない — 当たったらそれは付け替えの計画が間違っている。
     */
    const clear = this.raw.prepare(
      'DELETE FROM files WHERE root_id = ? AND rel_path = ? AND id <> ? AND present = 0'
    );
    const moves = input.moves ?? {};
    for (const r of rows) {
      const rel = String(r.rel_path);
      const sep = rel.includes('\\') ? '\\' : '/';
      const head = before.folder + sep;
      // 作品フォルダの直下に無いファイル (根に平置き) は触らない
      if (!rel.startsWith(head)) continue;
      const base = rel.slice(head.length);
      const next = input.folder + sep + (moves[base] ?? base);
      clear.run(before.rootId, next, Number(r.id));
      // **別巻の呼び名も読み直す。** フォルダ名を前置きとして剥がして読んでいるので、
      // フォルダが変われば答えも変わる。ここを置き去りにすると次のスキャンまで
      // 「この作品の中の何なのか」が食い違う (この口の約束は、DB に入るのは次のスキャンが
      // 出す答えと同じであること)
      upd.run(next, r.volume_id === null ? parseLibraryEntry(next).sideLabel : null, Number(r.id));
    }

    return this.getSeries(input.seriesId)!;
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

  // ---- 人が選んだ書誌シリーズ ---------------------------------------------

  /** 作品 1 つの選択を読む。無ければ null (= 自動に任せる) */
  getSeriesPick(seriesId: number): SeriesPick | null {
    const r = this.raw
      .prepare('SELECT * FROM series_pick WHERE series_id = ?')
      .get(seriesId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      seriesId: Number(r.series_id),
      scope: String(r.scope),
      groupKey: String(r.group_key),
      title: String(r.title),
      author: (r.author as string | null) ?? null,
      queryTitle: String(r.query_title),
      queryAuthor: (r.query_author as string | null) ?? null,
      pickedAt: String(r.picked_at),
    };
  }

  /** 選び直しは上書き。**履歴は残さない** — 今どれを正としているかだけが要る */
  setSeriesPick(input: Omit<SeriesPick, 'pickedAt'>): SeriesPick {
    this.raw
      .prepare(
        `INSERT INTO series_pick (series_id, scope, group_key, title, author,
                                   query_title, query_author, picked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(series_id) DO UPDATE SET
           scope = excluded.scope, group_key = excluded.group_key, title = excluded.title,
           author = excluded.author,
           query_title = excluded.query_title, query_author = excluded.query_author,
           picked_at = excluded.picked_at`
      )
      .run(
        input.seriesId, input.scope, input.groupKey, input.title, input.author,
        input.queryTitle, input.queryAuthor, now()
      );
    return this.getSeriesPick(input.seriesId)!;
  }

  /** 指定を外して自動へ戻す。**表紙そのものは消さない** (次の取り直しで貼り替わる) */
  clearSeriesPick(seriesId: number): void {
    this.raw.prepare('DELETE FROM series_pick WHERE series_id = ?').run(seriesId);
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

  /**
   * 持っている**単巻**の番号 (昇順)。表紙を取りに行く先はこれ。
   *
   * 合本 (第01-02巻) も別の単位 (第224話) も入らない。合本の中の巻は
   * 「持ってはいる」が 1 冊ぶんの絵しか要らず、そちらは板として別に数える
   * (cover-slot.ts)。単位が違うものは外の書誌が巻として知らないので聞きようがない。
   */
  ownedVolumeNumbers(seriesId: number, unit = '巻'): number[] {
    const rs = this.raw
      .prepare(
        `SELECT volume_from FROM volumes
          WHERE series_id = ? AND present = 1 AND unit = ? AND volume_from = volume_to
          ORDER BY volume_from`
      )
      .all(seriesId, unit) as { volume_from: number }[];
    return rs.map((r) => Number(r.volume_from));
  }

  /**
   * 別巻の呼び名 (昇順)。**作品そのもの (空文字) を先頭に置く。**
   *
   * `side_label IS NULL` は「呼び名も読めなかったファイル」で、別巻ではない
   * (catalog.ts の SeriesIssues)。板を持たないので、ここには出さない。
   */
  listSideLabels(seriesId: number): string[] {
    const rs = this.raw
      .prepare(
        `SELECT DISTINCT side_label FROM files
          WHERE series_id = ? AND present = 1 AND volume_id IS NULL AND side_label IS NOT NULL`
      )
      .all(seriesId) as { side_label: string }[];
    return rs
      .map((r) => String(r.side_label))
      .sort((a, b) => (a ? 1 : 0) - (b ? 1 : 0) || a.localeCompare(b, 'ja'));
  }

  // ---- files -------------------------------------------------------------

  upsertFile(input: {
    rootId: string; relPath: string; seriesId: number; volumeId: number | null;
    size: number; mtime: string | null; ext: string; part: string; partNo: number | null;
    sideLabel: string | null; tags: string[];
  }): void {
    const t = now();
    this.raw
      .prepare(
        `INSERT INTO files (root_id, rel_path, series_id, volume_id, size, mtime, ext, part, part_no,
                            side_label, tags, present, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(root_id, rel_path) DO UPDATE SET
           series_id = excluded.series_id, volume_id = excluded.volume_id,
           size = excluded.size, mtime = excluded.mtime, tags = excluded.tags,
           side_label = excluded.side_label,
           present = 1, last_seen_at = excluded.last_seen_at`
      )
      .run(input.rootId, input.relPath, input.seriesId, input.volumeId, input.size, input.mtime,
        input.ext, input.part, input.partNo, input.sideLabel, JSON.stringify(input.tags), t, t);
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

  // ---- 書庫の索引 ---------------------------------------------------------

  /**
   * 覚えてある書庫の索引。**ファイルの姿が変わっていたら渡さない。**
   * 同じ名前のまま中身を入れ替えることは普通にある (画質違いを置き直す等) ので、
   * size か mtime が動いていたら黙って null を返して読み直させる。
   */
  getPageIndex(fileId: number, size: number, mtime: string): PageIndex | null {
    const r = this.raw.prepare('SELECT * FROM page_index WHERE file_id = ?').get(fileId) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    if (Number(r.size) !== size || String(r.mtime) !== mtime) return null;
    return {
      format: String(r.format) === 'rar' ? 'rar' : 'zip',
      pages: JSON.parse(String(r.pages)) as PageIndex['pages'],
      skipped: JSON.parse(String(r.skipped)) as string[],
      nested: Number(r.nested) === 1,
    };
  }

  putPageIndex(input: { fileId: number; size: number; mtime: string; index: PageIndex; buildMs: number }): void {
    this.raw
      .prepare(
        `INSERT INTO page_index (file_id, size, mtime, format, pages, skipped, nested, built_at, build_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_id) DO UPDATE SET
           size = excluded.size, mtime = excluded.mtime, format = excluded.format,
           pages = excluded.pages, skipped = excluded.skipped, nested = excluded.nested,
           built_at = excluded.built_at, build_ms = excluded.build_ms`
      )
      .run(
        input.fileId,
        input.size,
        input.mtime,
        input.index.format,
        JSON.stringify(input.index.pages),
        JSON.stringify(input.index.skipped),
        input.index.nested ? 1 : 0,
        now(),
        Math.round(input.buildMs)
      );
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
