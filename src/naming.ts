import path from 'node:path';
import { findVolumeIn, stripCompletionMark, type VolumeUnit } from './volume.js';

/**
 * 蔵書のフォルダ名・ファイル名を読み戻す。
 *
 * 手元の蔵書が従っている命名は 1 つ (PowerDowner のリネームが書いている形と同じ):
 *
 *   [{著者}] {作品名}/[{著者}] {作品名} 第{nn}巻.{拡張子}
 *   [{著者}] {作品名}/[{著者}] {作品名} 第{nn}-{nn}巻.{拡張子}
 *   最終巻はどちらにも (完) が付く
 *
 * **読み戻しと組み立ての両方をここに置く。** 受け入れトレイを棚へ入れる段 (src/inbox.ts) で
 * PowerDowner から planName / fitPath / uniqueName を引き取った — 書く側と読む側が
 * 別々の規則を持った瞬間に、自分で置いたファイルを自分で見つけられなくなる。
 * **PowerDowner 側の同名関数と同一に保つこと。** あちらも同じ形で棚へ書く。
 */

/** 書庫・電子書籍としてありうる拡張子 */
export const CONTENT_EXT = /\.(rar|zip|7z|cbz|cbr|pdf|epub|mobi|azw3?)$/i;
/** 分割書庫のうち、拡張子の手前に入る連番。xxx.part1.rar */
const PART_SUFFIX = /\.part(\d+)$/i;
/** 分割書庫のうち、拡張子そのものが連番のもの。xxx.r00 / xxx.001 */
export const SPLIT_EXT = /\.(r\d{2}|\d{3})$/i;
/** 同名回避で付けた連番。読み戻す時は落とす */
const SEQ_SUFFIX = /\s*\((\d{1,3})\)$/;

/** Windows がファイル名に使えない文字。消さずに全角へ倒す (作品名の情報を残すため) */
const FORBIDDEN: Record<string, string> = {
  '\\': '＼', '/': '／', ':': '：', '*': '＊',
  '?': '？', '"': '”', '<': '＜', '>': '＞', '|': '｜',
};
/** 拡張子を付けても掴めなくなる予約名。CON.rar は作れない */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** 1 つのフォルダ名 / ファイル名の上限。NTFS は 255 だが、パス全体の余裕を残す */
const SEGMENT_MAX = 110;
/**
 * フルパスの上限。Windows の MAX_PATH は 260 だが、分割書庫の連番や
 * 同名回避の ` (2)` が後から伸びるぶんを引いてある。
 */
const PATH_MAX = 240;

/**
 * 巻数の後ろに付く版・品質の印。手元の蔵書にあるもの:
 *
 *   第04巻 [LQ]   … 低画質版
 *   第09巻w       … 裏で付けた 1 文字の印 (w / s など)
 *
 * **これは作品の同一性に関わらない**ので、巻としては同じものとして扱い、
 * 表示にだけ回す。ここを seriesKey や巻数に混ぜると、同じ巻が 2 つに割れる。
 */
const TRAILING_TAGS = /\[([^\]]{1,16})\]/g;

export interface SplitName {
  /** 拡張子・分割連番・同名回避の連番を落とした本体 */
  stem: string;
  /** 拡張子の手前に戻す分割連番 ('.part1')。無ければ空 */
  part: string;
  /** 分割書庫の何番目か。単一ファイルなら null */
  partNo: number | null;
  /** 元の拡張子 ('.rar')。無ければ空 */
  ext: string;
}

/**
 * ファイル名を「本体 / 分割連番 / 拡張子」に割る。
 *
 * 分割書庫の連番を本体から外して**そのまま戻す**のが肝。`xxx.part2.rar` を
 * `第01巻.rar` に均してしまうと part1 と同じ名前になって片方が消え、
 * `.r00` 系はベース名が `.rar` と揃わなくなって解凍できない。
 */
export function splitFilename(name: string): SplitName {
  let s = String(name ?? '');
  let ext = '';
  let part = '';
  let partNo: number | null = null;

  const content = s.match(CONTENT_EXT);
  const split = s.match(SPLIT_EXT);
  if (content) {
    ext = content[0];
    s = s.slice(0, -ext.length);
    const p = s.match(PART_SUFFIX);
    if (p) {
      part = p[0];
      partNo = Number(p[1]);
      s = s.slice(0, -part.length);
    }
  } else if (split) {
    // .r00 / .001 は拡張子そのものが連番。ここを part に回すと拡張子が消える
    ext = split[0];
    s = s.slice(0, -ext.length);
    const n = Number(ext.replace(/^\.r?/i, ''));
    partNo = Number.isInteger(n) ? n : null;
  }

  s = s.replace(SEQ_SUFFIX, '');
  return { stem: s.trim(), part, partNo, ext };
}

export interface ParsedName {
  /** 先頭の [...] から取った著者。無ければ null */
  author: string | null;
  /** 著者・巻数・完結マーク・版の印を落とした作品名 */
  title: string;
  volumeFrom: number | null;
  volumeTo: number | null;
  unit: VolumeUnit;
  /** 完結マーク (完) が付いていたか */
  completed: boolean;
  /** 巻数の後ろに付いていた版・品質の印 ([LQ] など) */
  tags: string[];
  part: string;
  partNo: number | null;
  ext: string;
}

/** 先頭の [著者] を切り出す。全角の［］も同じ扱いにする */
function takeAuthor(s: string): { author: string | null; rest: string } {
  const m = s.match(/^\s*[[［]([^\]］]*)[\]］]\s*/);
  if (!m) return { author: null, rest: s.trim() };
  const author = m[1].trim();
  return { author: author || null, rest: s.slice(m[0].length).trim() };
}

/**
 * `[著者] 作品名 第01巻(完).rar` を読み戻す。フォルダ名 (`[著者] 作品名(完)`) もこれで読む。
 *
 * **著者を作品名から外すのがここの仕事。** 外さないと seriesKeyOf が著者ごとキーに
 * 畳み込み、`title: "作品名"` で来た同じ巻と一生噛み合わない (手元にあるのに落とし直す)。
 */
export function parseFilename(name: string): ParsedName {
  const { stem, part, partNo, ext } = splitFilename(name);
  // 完結マークは著者を切る前に落とす。`日常(完)` の () を巻数解釈へ持ち込ませない
  const { text: unmarked, completed } = stripCompletionMark(stem);
  const { author, rest } = takeAuthor(unmarked);
  const { normalized, match } = findVolumeIn(rest);

  // 巻数より後ろは版・品質の印しか来ない。作品名には入れず、印だけ拾う
  const tail = match ? normalized.slice(match.end) : '';
  const tags: string[] = [];
  TRAILING_TAGS.lastIndex = 0;
  for (const m of tail.matchAll(TRAILING_TAGS)) tags.push(m[1].trim());

  const head = (match ? normalized.slice(0, match.start) : normalized).trim();
  return {
    author,
    // 巻数の手前が空なら、巻数表現しか書かれていない。作品名の代わりに全体を残す
    title: head || normalized.trim(),
    volumeFrom: match?.from ?? null,
    volumeTo: match?.to ?? null,
    unit: match?.unit ?? '巻',
    completed,
    tags,
    part,
    partNo,
    ext,
  };
}

/**
 * 比較のためだけに文字列を均す。表示には使わない。
 * NFKC + 完結マーク落とし + 小文字化 + 空白畳み。
 */
function flat(s: string): string {
  return stripCompletionMark(String(s ?? ''))
    .text.normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 作品フォルダ名を前置きとして剥がし、残りが裸の数字なら巻数として読む。
 *
 * 手元の蔵書には `[井上堅二×吉岡公威] ぐらんぶる 01.rar` のように**単位を伴わない**
 * 巻数が実在する。単体のファイル名としてはこれを巻数と断じられない (作品名の末尾が
 * 数字の作品があるため) が、**フォルダという文脈があれば話が別**になる —
 * 「作品名をそっくり除いた残りが数字だけ」なら、それは巻数以外ではありえない。
 *
 * 逆に、フォルダ名が前置きになっていないファイルには効かせない。
 * `[BETEMIUS] 同人誌/[BETEMIUS] あなたのヤミ鎮守府 1.rar` を「同人誌 第1巻」に
 * してしまわないための歯止めで、ここを緩めると別作品が 1 つに畳まれる。
 */
function bareVolumeAfterFolder(fileStem: string, folderName: string): { from: number; to: number } | null {
  const stem = flat(fileStem);
  const folder = flat(folderName);
  if (!folder || !stem.startsWith(folder)) return null;

  const rest = stem.slice(folder.length).replace(/^[\s._-]+/, '').trim();
  const range = rest.match(/^(\d{1,4})\s*[-‐–—~〜]\s*(\d{1,4})$/);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    return from <= to ? { from, to } : null;
  }
  const single = rest.match(/^(\d{1,4})$/);
  return single ? { from: Number(single[1]), to: Number(single[1]) } : null;
}

/** 作品フォルダ 1 つ分の素性 */
export interface SeriesIdentity {
  author: string | null;
  title: string;
  completed: boolean;
}

/** 蔵書の 1 ファイル。作品の素性と、その中の 1 巻としての素性を分けて持つ */
export interface LibraryEntry {
  /** 蔵書ルートからの相対パス */
  relPath: string;
  /** 作品フォルダ名。ルート直下に直置きされていれば null */
  folder: string | null;
  /** 作品としての素性。**フォルダがあればフォルダが正** (下記) */
  series: SeriesIdentity;
  /** ファイル名から読んだ作品名。フォルダと食い違う時に人へ見せるため残す */
  fileTitle: string;
  volumeFrom: number | null;
  volumeTo: number | null;
  unit: VolumeUnit;
  /** この巻に完結マークが付いていたか (作品の完結とは別に持つ) */
  volumeCompleted: boolean;
  tags: string[];
  part: string;
  partNo: number | null;
  ext: string;
}

/**
 * 蔵書の 1 ファイルを読む。
 *
 * **作品の素性はフォルダを正とする。** 蔵書は作品ごとにフォルダで分けてあるのだから、
 * 「同じフォルダに入っている = 同じ作品」は人が既に下した判断で、ファイル名より強い。
 * ファイル名を正にすると実物ではこう割れた (2026-09-12 に 4945 ファイルで確認):
 *
 *   [おがきちか] Landreaall/[おがきちか] Landreaall ランドリオール 第37巻.rar
 *     → 副題の有無で `landreaall` と `landreaallランドリオール` の 2 作品に割れる
 *   [ゆうきまさみ] 機動警察パトレイバー(完)/(一般コミック) [ゆうきまさみ] 機動警察パトレイバー 第06巻.rar
 *     → ファイル名の頭のゴミが作品名に入り、著者も取れない
 *
 * フォルダの無いファイル (ルート直置き) だけはファイル名を正にするしかない。
 */
export function parseLibraryEntry(relPath: string): LibraryEntry {
  const base = path.basename(relPath);
  const file = parseFilename(base);

  const parentName = path.basename(path.dirname(relPath));
  const hasParent = !!parentName && parentName !== '.' && parentName !== path.sep && parentName !== relPath;
  const folder = hasParent ? parseFilename(parentName) : null;

  const series: SeriesIdentity = folder && folder.title
    ? {
        author: folder.author ?? file.author,
        title: folder.title,
        // 完結はどちらかに印があれば完結。フォルダにだけ付いている作品が実際にある
        completed: folder.completed || file.completed,
      }
    : { author: file.author, title: file.title, completed: file.completed };

  let volumeFrom = file.volumeFrom;
  let volumeTo = file.volumeTo;
  if (volumeFrom === null && hasParent) {
    const bare = bareVolumeAfterFolder(splitFilename(base).stem, parentName);
    if (bare) {
      volumeFrom = bare.from;
      volumeTo = bare.to;
    }
  }

  return {
    relPath,
    folder: hasParent ? parentName : null,
    series,
    fileTitle: file.title,
    volumeFrom,
    volumeTo,
    unit: file.unit,
    volumeCompleted: file.completed,
    tags: file.tags,
    part: file.part,
    partNo: file.partNo,
    ext: file.ext,
  };
}

/** ファイル名として安全な 1 セグメントにする。中身が全部消えたら null */
export function sanitizeSegment(raw: string, max = SEGMENT_MAX): string | null {
  let s = String(raw ?? '').normalize('NFKC');
  s = s.replace(/[\u0000-\u001f\u007f]/g, '');
  s = s.replace(/[\\/:*?"<>|]/g, (c) => FORBIDDEN[c] ?? '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max).trim();
  // 末尾のピリオドと空白は Windows が黙って落とす。付けたまま作ると、
  // 作ったつもりの名前と実際の名前がずれて探せなくなる
  s = s.replace(/[.\s]+$/, '');
  if (!s) return null;
  if (RESERVED.test(s)) s = `${s}_`;
  return s;
}

/** 第01巻 / 第01-06巻。3 桁以上はそのまま伸ばす (こち亀 200 巻) */
export function formatVolume(from: number, to: number, unit: VolumeUnit = '巻'): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return from === to ? `第${pad(from)}${unit}` : `第${pad(from)}-${pad(to)}${unit}`;
}

/** `[著者] 作品名`。著者が無ければ作品名だけ (`[] 作品名` にはしない) */
export function seriesLabel(author: string | null | undefined, title: string): string {
  const a = (author ?? '').trim();
  return a ? `[${a}] ${title}` : title;
}

/**
 * 作品フォルダ名を組み立てる。`[著者] 作品名(完)`
 *
 * **完結マークは名前を詰めた後に足す。** 先に足してから詰めると `(完` のような
 * 欠けた印が残り、`stripCompletionMark` が読み戻せずに完結を見落とす。
 * 削るのは作品名の側で、印は必ず丸ごと残す。
 *
 * 渡された作品名に既に `(完)` が入っていても落とす。**完結を言うのは引数ひとつ**で、
 * 名前の中の印と二重になると `…(完)(完)` が出来る。
 */
export function planFolderName(
  author: string | null | undefined,
  title: string,
  completed: boolean
): string | null {
  const mark = completed ? '(完)' : '';
  const bareTitle = stripCompletionMark(String(title ?? '')).text.trim();
  const bareAuthor = stripCompletionMark(String(author ?? '')).text.trim() || null;
  if (!bareTitle) return null;
  const safe = sanitizeSegment(seriesLabel(bareAuthor, bareTitle), SEGMENT_MAX - mark.length);
  return safe ? `${safe}${mark}` : null;
}

// ---- 組み立て (PowerDowner から引き取り) -----------------------------------

export interface NameInput {
  /** 外から与える値。空なら元のファイル名から読んだものを使う */
  author?: string | null;
  title?: string | null;
  volumeFrom?: number | null;
  volumeTo?: number | null;
  unit?: VolumeUnit;
}

export interface NamePlan {
  /** 掘る作品フォルダ名。作品名が無ければ null (掘らない) */
  folder: string | null;
  /** 同名回避の連番を付ける前のファイル名 */
  file: string;
  /** 元の名前のままでよい (巻数か作品名が読めなかった) */
  keepName: boolean;
}

/**
 * ファイル 1 つを、どこへどの名前で置くか決める。
 *
 * 足りない値は**元のファイル名から補う**。受け入れトレイのローマ字名のように
 * 作品名を外から与える場合は input で渡す。
 *
 * 巻数がどうしても読めない時はファイル名を変えない。読めないまま `第01巻` と
 * 決め打ちすると、棚と手元が食い違って後から直しようがなくなる。
 */
export function planName(filename: string, input: NameInput = {}, opts: { folder?: boolean } = {}): NamePlan {
  const parsed = parseFilename(filename);
  const author = (input.author ?? '').trim() || parsed.author;
  const rawTitle = (input.title ?? '').trim() || parsed.title;
  const volFrom = input.volumeFrom ?? parsed.volumeFrom;
  const volTo = input.volumeTo ?? parsed.volumeTo;
  const unit = input.unit ?? parsed.unit;

  const title = sanitizeSegment(rawTitle);
  const safeAuthor = author ? sanitizeSegment(author) : null;

  // 作品名として信用できるのは、外から与えられたか、ファイル名が [著者] か
  // 巻数で区切られていた場合だけ。区切りの無い名前はダウンロード名がまるごと
  // 入っているだけなので、それでフォルダを掘ると rsdjf1me5yac のような
  // フォルダが棚に増えていく
  const trusted = !!(input.title ?? '').trim() || parsed.author !== null || parsed.volumeFrom !== null;

  // 作品名が無ければ手の出しようがない。掘りも変えもせず、そのまま置く
  if (!title || !trusted) return { folder: null, file: filename, keepName: true };

  const label = seriesLabel(safeAuthor, title);
  const folder = opts.folder === false ? null : sanitizeSegment(label);

  // 巻数が読めないものは名前を変えない。作品フォルダには入れる
  if (volFrom === null || volTo === null) {
    return { folder, file: filename, keepName: true };
  }

  const file = `${label} ${formatVolume(volFrom, volTo, unit)}${parsed.part}${parsed.ext}`;
  return { folder, file, keepName: false };
}

/**
 * パスが長すぎるなら作品名を削って収める。
 *
 * NAS (UNC) の下に `[著者] 作品名` を 2 回重ねると、日本語の長い作品名で
 * あっさり MAX_PATH に届く。届いた時に失敗させるのではなく、名前を詰めてでも置く。
 * それでも収まらなければ作品フォルダを諦める (パスが 1 段浅くなる)。
 */
export function fitPath(baseDir: string, plan: NamePlan, input: NameInput = {}): NamePlan {
  const lengthOf = (p: NamePlan): number => path.join(baseDir, p.folder ?? '', p.file).length;
  if (lengthOf(plan) <= PATH_MAX) return plan;
  // 元の名前を保つと決めたものは削らない。長さより「読み戻せること」を採る
  if (plan.keepName) {
    return plan.folder !== null && lengthOf({ ...plan, folder: null }) <= PATH_MAX
      ? { ...plan, folder: null }
      : plan;
  }

  const parsed = parseFilename(plan.file);
  const author = (input.author ?? '').trim() || parsed.author;
  let title = (input.title ?? '').trim() || parsed.title;

  let next = plan;
  // 作品名は 6 文字までしか削らない。それ以上は人が読めなくなる
  while (title.length > 6) {
    title = title.slice(0, -4).trim();
    next = planName(plan.file, { ...input, author, title, volumeFrom: parsed.volumeFrom, volumeTo: parsed.volumeTo, unit: parsed.unit },
      { folder: plan.folder !== null });
    if (lengthOf(next) <= PATH_MAX) return next;
  }
  return next.folder !== null ? { ...next, folder: null } : next;
}

/**
 * 同じ名前が既にあるなら末尾に連番を付ける。`... 第01巻 (2).rar`
 *
 * 連番は巻数表現の**後ろ**に付ける。`splitFilename` が読み戻す時に落とすので、
 * 同一性のキーにも巻数にも混ざらない。上書きしないのは、同じ巻でも中身が違う
 * (画質違い・修正版) ことがあるため。**どちらを捨てるかは人が決める** —
 * 2 本あることは棚の「要確認 (重複)」に出る。
 */
export function uniqueName(dir: string, file: string, exists: (p: string) => boolean): string {
  if (!exists(path.join(dir, file))) return file;
  const { stem, part, ext } = splitFilename(file);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} (${i})${part}${ext}`;
    if (!exists(path.join(dir, candidate))) return candidate;
  }
  return `${stem} (${Date.now()})${part}${ext}`;
}
