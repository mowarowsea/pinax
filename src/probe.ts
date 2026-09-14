/**
 * 蔵書の実物にパーサを当てて、読めたもの・読めなかったものを数える物差し。
 *
 * 命名の解釈を直した時は必ずこれを通すこと。読めない件数が増えていたら、
 * その差分が「手元にあるのに持っていないと言われる本」になる。
 *
 *   npm run probe -- "\\\\192.168.3.30\\disk1_pt1\\manga"
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONTENT_EXT, SPLIT_EXT, parseFilename, parseLibraryEntry } from './naming.js';
import { seriesKeyOf } from './volume.js';

const root = process.argv[2];
if (!root) {
  console.error('usage: probe.ts <蔵書ルート>');
  process.exit(2);
}

async function walk(dir: string, base: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    console.error(`読めないフォルダ: ${dir} (${(e as Error).message})`);
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, base, out);
    else if (CONTENT_EXT.test(e.name) || SPLIT_EXT.test(e.name)) out.push(path.relative(base, full));
  }
}

const files: string[] = [];
await walk(root, root, files);

interface Agg {
  title: string;
  author: string | null;
  completed: boolean;
  folders: Set<string>;
  /** 単位ごとの所持巻。巻と話を混ぜると欠番が嘘になる */
  owned: Map<string, Set<number>>;
  noVolume: number;
}

const series = new Map<string, Agg>();
const noVolume: string[] = [];
const subtitleDrift: string[] = [];

for (const rel of files) {
  const e = parseLibraryEntry(rel);
  const key = seriesKeyOf(e.series.title);
  if (!key) continue;

  // フォルダ名とファイル名で作品名が食い違うもの。フォルダを正にしたので
  // 実害は無いが、どれだけ揺れているかは見ておく
  const fileKey = seriesKeyOf(e.fileTitle);
  if (e.folder && fileKey && fileKey !== key) {
    subtitleDrift.push(`${rel}\n      フォルダ→${key} / ファイル→${fileKey}`);
  }

  const s = series.get(key) ?? {
    title: e.series.title, author: e.series.author, completed: false,
    folders: new Set<string>(), owned: new Map<string, Set<number>>(), noVolume: 0,
  };
  if (e.series.author && !s.author) s.author = e.series.author;
  if (e.series.completed) s.completed = true;
  if (e.folder) s.folders.add(e.folder);
  if (e.volumeFrom === null) {
    noVolume.push(rel);
    s.noVolume++;
  } else {
    const set = s.owned.get(e.unit) ?? new Set<number>();
    for (let v = e.volumeFrom; v <= (e.volumeTo ?? e.volumeFrom); v++) set.add(v);
    s.owned.set(e.unit, set);
  }
  series.set(key, s);
}

const show = (label: string, list: string[], n = 12): void => {
  console.log(`\n## ${label} (${list.length} 件)`);
  for (const x of list.slice(0, n)) console.log('   ', x);
  if (list.length > n) console.log(`    … 他 ${list.length - n} 件`);
};

console.log(`対象ファイル : ${files.length}`);
console.log(`作品数       : ${series.size}`);
console.log(`完結作品     : ${[...series.values()].filter((s) => s.completed).length}`);
console.log(`巻数を読めた : ${files.length - noVolume.length} / ${files.length}`);

show('巻数を読めなかったファイル', noVolume);
show('フォルダとファイルで作品名が揺れているもの', subtitleDrift, 8);

// 同じキーに複数のフォルダがぶら下がっている = 蔵書に同じ作品が 2 つある疑い
const collisions = [...series.entries()]
  .filter(([, s]) => s.folders.size > 1)
  .map(([k, s]) => `${k}\n      ${[...s.folders].join('\n      ')}`);
show('同じ作品が複数フォルダに散っている', collisions);

// 欠番。単位ごとに別々に見る
const gaps: string[] = [];
for (const s of series.values()) {
  for (const [unit, owned] of s.owned) {
    if (owned.size === 0) continue;
    const max = Math.max(...owned);
    const missing: number[] = [];
    for (let i = 1; i <= max; i++) if (!owned.has(i)) missing.push(i);
    if (!missing.length) continue;
    const label = `${s.author ? `[${s.author}] ` : ''}${s.title}`;
    const list = missing.length > 12 ? `${missing.slice(0, 12).join(',')}… 計${missing.length}` : missing.join(',');
    gaps.push(`${label} — 欠番 ${list} (最大 ${max}${unit})`);
  }
}
show('欠番のある作品', gaps, 40);
