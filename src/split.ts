import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db.js';
import type { Config } from './config.js';
import {
  ArchiveError, extractEntryTo, isReadableArchive, readPage, readPageIndex,
  readZipEntries, readZipRaw, type PageIndex,
} from './archive.js';
import { parseFilename, planVolumeName } from './naming.js';
import { findVolumeIn, type VolumeUnit } from './volume.js';
import { resolveInsideRoot } from './reveal.js';
import { ZipWriter } from './zip-write.js';

/**
 * 合本 (第01-02巻) を巻ごとに割る。
 *
 * **pinax がファイルを書くもう 1 つの場所** (もう 1 つは rename.ts)。同じ立場で、
 * **人が板のボタンを押した 1 回だけ**が通る。自動の巡回からは決して生やさないこと。
 *
 * ## 割る動機
 *
 * 表紙も欠番も合本のままで正しく出るようになった (§8.4) ので、残っているのは
 * 実体の問題だけ:
 *
 *   1. **中身が書庫の合本は読めない。** 0 ページとして返る。読む道が無い
 *   2. 棚で巻が 1 枚の板に潰れて見える。数直線は正しいのに、並びが実物と合わない
 *   3. 第01-02巻と第02巻を両方持っている時、重複が目で見て分からない
 *
 * ## 何を守るか
 *
 * **境目に巻番号が書いてある時だけ割る。** 当てずっぽうで割ると「第03巻」を名乗る
 * 別物が棚に載る — 一番やってはいけない壊れ方で、しかも後から機械には気付けない。
 * だから読めた番号が `第01-02巻` と過不足なく一致しなければ、何もせずに断る。
 *
 * **原本は消さない。** 割り終わったら `data/attic/` へ引く。棚に置いたままにすると、
 * 次のスキャンが合本と単巻を両方拾って、まさに直したかった重複が増える
 * (scanner.ts に除外の仕組みは無い。棚にあるものは全部カタログに載る)。
 *
 * **棚には完成品しか置かない。** 作業中は `.pinax-tmp` を付けた名前で書く。
 * この拡張子はスキャンの対象外 (naming.ts の CONTENT_EXT / SPLIT_EXT) なので、
 * 途中で落ちても半端なファイルが蔵書として数えられることはない。
 */

/** 中がどう並んでいるか。**割れるのは前の 2 つだけ** */
export type SplitKind =
  /** 中身が書庫。取り出すだけで割れる (`天空の玉座 第01-08巻.rar` は中に rar が 8 つ) */
  | 'nested'
  /** 巻ごとのフォルダに分かれている。境目はフォルダ名に書いてある */
  | 'folders'
  /** ページがベタ連番。境目が機械には分からない */
  | 'flat';

/** 割った後に出来る 1 本 */
export interface SplitPart {
  volume: number;
  /** 出来上がるファイル名 */
  name: string;
  /** この巻に入る中身 (書庫の中の名前) */
  members: string[];
  /** 新しい書庫の中でどういう名前にするか。members と同じ並び */
  as: string[];
  /**
   * 出来上がる本のページ数。**中身が書庫の合本では 0 = 分からない。**
   *
   * あちらの members は「取り出す書庫 1 つ」なので数えると必ず 1 になり、
   * 画面に「1 ページ」と出る。中を開くまで本当のページ数は分からないのだから、
   * 嘘の数を出すより黙っている方がいい (`SplitPlan.pages` も同じ理由で 0)。
   */
  pages: number;
}

export interface SplitPlan {
  fileId: number;
  seriesId: number;
  /** 今のファイル名 */
  from: string;
  volumeFrom: number;
  volumeTo: number;
  unit: VolumeUnit;
  format: 'zip' | 'rar';
  kind: SplitKind;
  /** 原本のページ数。中身が書庫の合本では 0 */
  pages: number;
  /** 割れるか。false なら parts は空 */
  ok: boolean;
  /** 割れない理由。**画面にそのまま出す** */
  reason: string | null;
  parts: SplitPart[];
}

/** 作業中の名前に付ける印。スキャンの対象外の拡張子であることが要る */
const TMP_EXT = '.pinax-tmp';

/** 入れ子の書庫として認める形。**中を確かめられるものだけ** (zip と rar) */
const INNER_RE = /\.(rar|zip)$/i;

// ---- 見分ける --------------------------------------------------------------

/**
 * 書庫の中の名前を「巻ごとの束」に分ける。
 *
 * **フォルダでしか分けない。** `第09巻_001.jpg` のような名前での分け方も書けるが、
 * 手元の実物には無い上に、`ほげ_001.jpg` との区別が付かない。読めないものは読めないと言う。
 */
function groupByFolder(names: string[]): Map<string, string[]> | null {
  let segs = names.map((n) => n.split('/').filter(Boolean));
  if (segs.some((s) => s.length < 2)) return null;

  // 全体が 1 枚の入れ物に入っていることがある (`作品名 第09-11巻/第09巻/001.jpg`)。
  // 剥がさないと束が 1 つしか出来ない
  while (segs.every((s) => s.length > 2) && new Set(segs.map((s) => s[0])).size === 1) {
    segs = segs.map((s) => s.slice(1));
  }
  if (segs.some((s) => s.length < 2)) return null;

  const out = new Map<string, string[]>();
  for (let i = 0; i < names.length; i++) {
    const key = segs[i][0];
    const acc = out.get(key) ?? [];
    // 巻のフォルダから先だけを残す。`第09巻/章1/001.jpg` の章の階層は残す
    // (落とすと別々の章の `001.jpg` がぶつかる)
    acc.push(segs[i].slice(1).join('/'));
    out.set(key, acc);
  }
  return out;
}

/** 区切りの名前から巻番号を読む。**単巻として読めた時だけ** (範囲は束ねられない) */
function volumeOf(label: string): number | null {
  const { match } = findVolumeIn(label);
  if (!match || match.from !== match.to) return null;
  return match.from;
}

/**
 * 読めた番号が `第01-02巻` と過不足なく一致するか。
 * **ここが最後の歯止め**で、1 つでも合わなければ割らない。
 */
function covers(nums: number[], from: number, to: number): boolean {
  if (nums.length !== to - from + 1) return false;
  const seen = new Set(nums);
  if (seen.size !== nums.length) return false;
  for (let i = from; i <= to; i++) if (!seen.has(i)) return false;
  return true;
}

export interface Grouped {
  kind: SplitKind;
  /** 巻番号 → 中身の名前。割れない時は空 */
  parts: { volume: number; members: string[]; as: string[] }[];
  reason: string | null;
}

/**
 * 索引を見て、割れるかどうかを決める。**ファイルには触らない**ので単体で試せる。
 */
export function groupIndex(index: PageIndex, from: number, to: number): Grouped {
  // 1. 中身が書庫
  if (index.pages.length === 0 && index.nested) {
    const inner = index.skipped.filter((n) => INNER_RE.test(n));
    const other = index.skipped.filter((n) => !INNER_RE.test(n) && /\.(7z|tar|gz|cbz|cbr)$/i.test(n));
    if (other.length) {
      return { kind: 'nested', parts: [], reason: `中の書庫 (${path.extname(other[0])}) は開けません` };
    }
    const parts = inner.map((n) => ({ volume: volumeOf(path.basename(n)), members: [n], as: [n] }));
    if (parts.some((p) => p.volume === null)) {
      return { kind: 'nested', parts: [], reason: '中の書庫の名前から巻番号が読めません' };
    }
    const nums = parts.map((p) => p.volume as number);
    if (!covers(nums, from, to)) {
      return {
        kind: 'nested',
        parts: [],
        reason: `中の書庫は ${nums.sort((a, b) => a - b).join(', ')} 巻で、名前と合いません`,
      };
    }
    return {
      kind: 'nested',
      parts: parts
        .map((p) => ({ volume: p.volume as number, members: p.members, as: p.as }))
        .sort((a, b) => a.volume - b.volume),
      reason: null,
    };
  }

  // 2. 巻ごとのフォルダ
  const grouped = index.pages.length ? groupByFolder(index.pages.map((p) => p.name)) : null;
  if (!grouped || grouped.size < 2) {
    return { kind: 'flat', parts: [], reason: '内容はフォルダ分けされていないため、機械的に判断できません' };
  }

  const parts: { volume: number; members: string[]; as: string[] }[] = [];
  for (const [label, rest] of grouped) {
    const v = volumeOf(label);
    if (v === null) {
      return { kind: 'folders', parts: [], reason: `フォルダ名から巻番号が読めません: ${label}` };
    }
    parts.push({ volume: v, members: rest.map((r) => `${label}/${r}`), as: rest });
  }
  const nums = parts.map((p) => p.volume);
  if (!covers(nums, from, to)) {
    return {
      kind: 'folders',
      parts: [],
      reason: `中のフォルダは ${[...nums].sort((a, b) => a - b).join(', ')} 巻で、名前と合いません`,
    };
  }
  return { kind: 'folders', parts: parts.sort((a, b) => a.volume - b.volume), reason: null };
}

// ---- 下見 ------------------------------------------------------------------

interface Target {
  row: Record<string, unknown>;
  series: Record<string, unknown>;
  volume: Record<string, unknown>;
  abs: string;
  dir: string;
  base: string;
}

/** 1 件分の下ごしらえ。ここで断る理由は「割る以前の話」だけ */
function targetOf(db: Db, cfg: Config, fileId: number): Target {
  const row = db.raw.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as Record<string, unknown> | undefined;
  if (!row) throw new SplitError('そのファイルはありません');
  if (row.volume_id === null) throw new SplitError('巻として読めていないファイルです');

  const volume = db.raw.prepare('SELECT * FROM volumes WHERE id = ?').get(Number(row.volume_id)) as
    | Record<string, unknown>
    | undefined;
  if (!volume) throw new SplitError('巻の行が見当たりません');
  if (Number(volume.volume_from) >= Number(volume.volume_to)) throw new SplitError('合本ではありません');

  const series = db.raw.prepare('SELECT * FROM series WHERE id = ?').get(Number(row.series_id)) as
    | Record<string, unknown>
    | undefined;
  if (!series) throw new SplitError('作品の行が見当たりません');

  // 分割書庫 (.part2 / .r00) は 1 巻が複数ファイルにまたがる。1 本だけでは中を読めない
  if (row.part_no !== null) throw new SplitError('分割書庫 (.part2 / .r00) は対象外です');

  const ext = String(row.ext ?? '').toLowerCase();
  if (!isReadableArchive(ext)) throw new SplitError(`${ext || 'この形式'} の中は読めません`);

  const root = cfg.roots.find((r) => r.id === String(row.root_id));
  if (!root) throw new SplitError(`そんな蔵書ルートはありません: ${String(row.root_id)}`);
  const abs = resolveInsideRoot(root.path, String(row.rel_path));
  if (!fs.existsSync(abs)) throw new SplitError(`実ファイルが見当たりません: ${String(row.rel_path)}`);

  return { row, series, volume, abs, dir: path.dirname(abs), base: path.basename(abs) };
}

/** 割る以前のところで断る時の例外。理由はそのまま画面に出す */
export class SplitError extends Error {}

const tmpDirOf = (cfg: Config): string => {
  const d = path.join(cfg.dataDir, 'pages');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

/**
 * 割る計画を立てる。**読むだけ。** rar の索引は 1 冊 1 秒前後かかる。
 */
export async function planSplit(db: Db, cfg: Config, fileId: number): Promise<SplitPlan> {
  const t = targetOf(db, cfg, fileId);
  const from = Number(t.volume.volume_from);
  const to = Number(t.volume.volume_to);
  const unit = String(t.volume.unit) as VolumeUnit;

  let index: PageIndex;
  try {
    index = await readPageIndex(t.abs, tmpDirOf(cfg));
  } catch (e) {
    throw new SplitError(e instanceof ArchiveError ? e.reason : (e as Error).message);
  }

  const g = groupIndex(index, from, to);
  const base: Omit<SplitPlan, 'ok' | 'reason' | 'parts'> = {
    fileId,
    seriesId: Number(t.row.series_id),
    from: t.base,
    volumeFrom: from,
    volumeTo: to,
    unit,
    format: index.format,
    kind: g.kind,
    pages: index.pages.length,
  };
  if (g.reason) return { ...base, ok: false, reason: g.reason, parts: [] };

  // 名前は組み立て直さず、**巻数表現だけ**を書き換える (rename.ts と同じ原則)。
  // 版の印 (`第09巻w` の w、`[LQ]`) は読み戻した tail をそのまま戻す
  const parsed = parseFilename(t.base);
  const title = String(t.series.title);
  const author = t.series.author === null ? null : String(t.series.author);

  const parts: SplitPart[] = [];
  for (const p of g.parts) {
    const ext = g.kind === 'nested' ? path.extname(p.members[0]) : '.zip';
    const name = planVolumeName(author, title, p.volume, p.volume, {
      unit,
      // (完) は最後の巻にだけ残す。全部に付けると「第01巻(完)」が棚に並ぶ
      completed: parsed.completed && p.volume === to,
      tail: parsed.tail,
    });
    if (!name) return { ...base, ok: false, reason: '新しいファイル名を作れません', parts: [] };
    const full = `${name}${ext}`;
    if (fs.existsSync(path.join(t.dir, full))) {
      return { ...base, ok: false, reason: `同じ名前のファイルが既にあります: ${full}`, parts: [] };
    }
    parts.push({
      volume: p.volume, name: full, members: p.members, as: p.as,
      pages: g.kind === 'nested' ? 0 : p.members.length,
    });
  }

  return { ...base, ok: true, reason: null, parts };
}

// ---- 割る ------------------------------------------------------------------

export interface SplitProgress {
  phase: '分割' | '確認' | '仕上げ';
  /** 何本目か (1 始まり) */
  part: number;
  parts: number;
  page: number;
  pages: number;
  label: string;
}

export interface SplitResult {
  fileId: number;
  from: string;
  /** 棚に置いた名前 */
  made: string[];
  /** 原本を引いた先 */
  attic: string;
}

export interface RunOptions {
  onProgress?: (p: SplitProgress) => void;
  /** 途中でやめる合図。**親が死んだ時に子が走り続けないため** (split-job.ts) */
  stopped?: () => boolean;
}

/**
 * 実際に割る。
 *
 * 順番に意味がある。**棚に触るのは最後の最後**で、それまでは `.pinax-tmp` の中で
 * 作って確かめるだけ。途中で落ちても棚は割る前のまま残る。
 *
 *   1. もう一度下見する (画面が古い計画を握っていることがある)
 *   2. `.pinax-tmp` に全部書く
 *   3. 書いたものを**索引に通して数え直す** (ページ数が合わなければ全部捨てる)
 *   4. 名前を外して棚に載せる
 *   5. 原本を data/attic/ へ引く
 */
export async function runSplit(
  db: Db,
  cfg: Config,
  fileId: number,
  opts: RunOptions = {}
): Promise<SplitResult> {
  const t = targetOf(db, cfg, fileId);
  const plan = await planSplit(db, cfg, fileId);
  if (!plan.ok) throw new SplitError(plan.reason ?? '分割できません');

  const tmp = tmpDirOf(cfg);
  const halt = (): void => {
    if (opts.stopped?.()) throw new SplitError('途中でやめました');
  };
  const made: string[] = [];
  const temps = plan.parts.map((p) => path.join(t.dir, `${p.name}${TMP_EXT}`));
  // 前に落ちた時の書きかけが残っていることがある。名前がぶつかる前に掃く
  sweepTemps(t.dir);

  try {
    // 2. 書く
    for (let i = 0; i < plan.parts.length; i++) {
      const part = plan.parts[i];
      const dest = temps[i];
      const say = (page: number): void =>
        opts.onProgress?.({
          phase: '分割', part: i + 1, parts: plan.parts.length,
          page, pages: part.pages, label: part.name,
        });
      say(0);
      halt();

      if (plan.kind === 'nested') {
        await extractEntryTo(t.abs, part.members[0], dest, tmp);
        say(part.pages);
        continue;
      }

      const w = new ZipWriter(dest);
      try {
        if (plan.format === 'zip') {
          // zip → zip は**圧縮されたまま写す**。絵は 1 バイトも通らない
          const entries = new Map(readZipEntries(t.abs).map((e) => [e.name, e]));
          for (let k = 0; k < part.members.length; k++) {
            const e = entries.get(part.members[k]);
            if (!e) throw new SplitError(`中身が見当たりません: ${part.members[k]}`);
            w.addRaw(part.as[k], readZipRaw(t.abs, e), { method: e.method, crc: e.crc, bytes: e.bytes });
            if (k % 20 === 0) { say(k + 1); halt(); }
          }
        } else {
          // rar → zip は取り出して無圧縮で積む。ページのバイト列は同じで、容器だけ変わる
          for (let k = 0; k < part.members.length; k++) {
            w.addStored(part.as[k], await readPage(t.abs, part.members[k], tmp));
            if (k % 5 === 0) { say(k + 1); halt(); }
          }
        }
        w.close();
      } catch (e) {
        w.abort();
        throw e;
      }
      say(part.pages);
    }

    // 3. 確かめる。**ここを通らなかったものは棚に出さない**
    let total = 0;
    for (let i = 0; i < plan.parts.length; i++) {
      const part = plan.parts[i];
      opts.onProgress?.({
        phase: '確認', part: i + 1, parts: plan.parts.length,
        page: 0, pages: part.pages, label: part.name,
      });
      halt();
      const got = await readPageIndex(temps[i], tmp, { as: path.extname(part.name) });
      if (plan.kind === 'nested') {
        if (got.pages.length === 0) throw new SplitError(`${part.name} にページがありません`);
      } else if (got.pages.length !== part.pages) {
        throw new SplitError(`${part.name} のページ数が合いません (${got.pages.length} / ${part.pages})`);
      }
      total += got.pages.length;
    }
    // ベタ連番でない合本のページは、割った先に過不足なく行き渡っているはず
    if (plan.kind !== 'nested' && total !== plan.pages) {
      throw new SplitError(`ページ数が合いません (${total} / ${plan.pages})`);
    }

    // 4. 棚に載せる
    opts.onProgress?.({
      phase: '仕上げ', part: plan.parts.length, parts: plan.parts.length,
      page: 0, pages: 0, label: t.base,
    });
    for (let i = 0; i < plan.parts.length; i++) {
      fs.renameSync(temps[i], path.join(t.dir, plan.parts[i].name));
      made.push(plan.parts[i].name);
    }
  } catch (e) {
    // 途中で落ちたら**書きかけを残さない**。棚は割る前のまま
    for (const f of temps) fs.rmSync(f, { force: true });
    for (const n of made) fs.rmSync(path.join(t.dir, n), { force: true });
    throw e;
  }

  // 5. 原本を引く。**消さない** ("Never burn")
  const attic = moveToAttic(cfg, t.abs);
  return { fileId, from: t.base, made, attic };
}

/**
 * 原本を `data/attic/` へ引く。
 *
 * **棚から出すことが目的**で、捨てることではない。棚に残すと次のスキャンが
 * 合本と単巻を両方拾って、直したかった重複がそのまま増える。
 *
 * 棚は NAS で `data/` は手元なので、`rename` では済まず実コピーになる (EXDEV)。
 * **大きさを確かめてからでないと元を消さない。**
 */
function moveToAttic(cfg: Config, abs: string): string {
  const dir = path.join(cfg.dataDir, 'attic');
  fs.mkdirSync(dir, { recursive: true });

  let dest = path.join(dir, path.basename(abs));
  for (let i = 2; fs.existsSync(dest); i++) {
    const ext = path.extname(abs);
    dest = path.join(dir, `${path.basename(abs, ext)} (${i})${ext}`);
  }

  try {
    fs.renameSync(abs, dest);
    return dest;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
  }
  const size = fs.statSync(abs).size;
  fs.copyFileSync(abs, dest);
  if (fs.statSync(dest).size !== size) {
    fs.rmSync(dest, { force: true });
    throw new SplitError('原本を引く途中で大きさが合わなくなりました。棚はそのままにしてあります');
  }
  fs.rmSync(abs, { force: true });
  return dest;
}

/** 落ちた後に残った作業中のファイルを片付ける。棚を歩く時のついでに呼ぶ */
export function sweepTemps(dir: string): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(TMP_EXT)) {
      fs.rmSync(path.join(dir, e.name), { force: true });
      n++;
    }
  }
  return n;
}
