/**
 * 書庫の中を読む口の実験台。**読むだけで、書庫には何も書かない。**
 *
 *   npm run pages -- からくりサーカス      … 作品を探して、持っている巻を並べる
 *   npm run pages -- 1234                  … ファイル id の索引を出す (中身の名前)
 *   npm run pages -- 1234 10               … その 10 ページ目を data/pages へ出して見る
 *   npm run pages -- --bench 20            … 無作為 20 冊で索引と 1 ページの時間を測る
 *   npm run pages -- --bench 20 zip        … zip だけ / rar だけ
 *
 * ビューアを設計する前に**実物の手触りを数字で見る**ためのもの。
 * 「1 ページめくるのに何ミリ秒か」が分からないと、先読みが要るのか、
 * 縮小した絵を別に持つ必要があるのかが決められない。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { ArchiveError, isReadableArchive, readPage, readPageIndex } from './archive.js';
import { resolveInsideRoot } from './reveal.js';

const cfg = loadConfig();
const db = new Db(cfg.dataDir);
const tmp = path.join(cfg.dataDir, 'pages');
fs.mkdirSync(tmp, { recursive: true });

const args = process.argv.slice(2);
const kb = (n: number): string => `${(n / 1024).toFixed(0)}KB`;
const med = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

const absOf = (row: Record<string, unknown>): string => {
  const root = cfg.roots.find((r) => r.id === String(row.root_id));
  if (!root) throw new Error(`そんな蔵書ルートはありません: ${String(row.root_id)}`);
  return resolveInsideRoot(root.path, String(row.rel_path));
};

// ---- 測る -----------------------------------------------------------------

if (args[0] === '--bench') {
  const n = Number(args[1] ?? 10);
  const only = args[2] === 'zip' ? '.zip' : args[2] === 'rar' ? '.rar' : null;
  const rows = db.raw
    .prepare(
      `SELECT * FROM files WHERE present = 1 ${only ? 'AND ext = ?' : ''} ORDER BY RANDOM() LIMIT ?`
    )
    .all(...(only ? [only, n] : [n])) as Record<string, unknown>[];

  const idxMs: Record<string, number[]> = { '.zip': [], '.rar': [] };
  const pageMs: Record<string, number[]> = { '.zip': [], '.rar': [] };
  const counts: number[] = [];
  const sizes: number[] = [];

  for (const row of rows) {
    const ext = String(row.ext);
    if (!isReadableArchive(ext)) continue;
    let abs: string;
    try {
      abs = absOf(row);
    } catch {
      continue;
    }
    if (!fs.existsSync(abs)) {
      console.log(`  消えている: ${String(row.rel_path)}`);
      continue;
    }
    let t = Date.now();
    let index;
    try {
      index = await readPageIndex(abs, tmp);
    } catch (e) {
      console.log(`  開けない (${e instanceof ArchiveError ? e.reason : String(e)}): ${path.basename(abs)}`);
      continue;
    }
    idxMs[ext].push(Date.now() - t);
    if (!index.pages.length) {
      console.log(`  ページなし (中身 ${index.skipped.length} 件${index.nested ? ' / 中は書庫' : ''}): ${path.basename(abs)}`);
      continue;
    }
    counts.push(index.pages.length);

    // 続けて 5 枚。実際にめくる時に効くのは 1 枚目より 2 枚目以降
    const at = Math.min(9, index.pages.length - 1);
    const ms: number[] = [];
    for (let i = 0; i < 5 && at + i < index.pages.length; i++) {
      t = Date.now();
      const buf = await readPage(abs, index.pages[at + i].name, tmp);
      ms.push(Date.now() - t);
      sizes.push(buf.length);
    }
    pageMs[ext].push(...ms);
    console.log(
      `  ${ext} ${String(index.pages.length).padStart(3)}p  索引 ${String(idxMs[ext].at(-1)).padStart(5)}ms  ` +
        `1枚 ${String(med(ms)).padStart(3)}ms  ${path.basename(abs).slice(0, 44)}`
    );
  }

  console.log('');
  for (const ext of ['.zip', '.rar']) {
    if (!idxMs[ext].length) continue;
    console.log(
      `${ext}  索引 中央値 ${med(idxMs[ext])}ms / 最大 ${Math.max(...idxMs[ext])}ms   ` +
        `1ページ 中央値 ${med(pageMs[ext])}ms / 最大 ${Math.max(...pageMs[ext])}ms`
    );
  }
  if (counts.length) {
    console.log(`1 冊 ${med(counts)} ページ (中央値) / 1 ページ ${kb(med(sizes))} (中央値)`);
  }
  db.close();
  process.exit(0);
}

// ---- 1 ファイルを見る -----------------------------------------------------

const first = args[0] ?? '';
if (!first) {
  console.error('作品名か、ファイル id を渡してください (npm run pages -- からくりサーカス)');
  process.exit(1);
}

if (!/^\d+$/.test(first)) {
  // 作品を探して、持っている巻を並べるだけ。id はここから拾ってもらう
  const rows = db.raw
    .prepare(
      `SELECT f.id, f.rel_path, f.ext, f.size FROM files f
         JOIN series s ON s.id = f.series_id
        WHERE f.present = 1 AND (s.title LIKE ? OR s.folder LIKE ?)
        ORDER BY f.rel_path LIMIT 60`
    )
    .all(`%${first}%`, `%${first}%`) as Record<string, unknown>[];
  if (!rows.length) {
    console.error(`見つかりません: ${first}`);
    process.exit(1);
  }
  for (const r of rows) {
    console.log(`${String(r.id).padStart(6)}  ${kb(Number(r.size)).padStart(8)}  ${String(r.rel_path)}`);
  }
  console.log(`\n${rows.length} 件。id を渡すと中身が見られます: npm run pages -- ${String(rows[0].id)}`);
  db.close();
  process.exit(0);
}

const row = db.raw.prepare('SELECT * FROM files WHERE id = ?').get(Number(first)) as
  | Record<string, unknown>
  | undefined;
if (!row) {
  console.error(`そのファイルはありません: ${first}`);
  process.exit(1);
}
const abs = absOf(row);
console.log(abs);

const t0 = Date.now();
const index = await readPageIndex(abs, tmp);
console.log(
  `${index.format} / ${index.pages.length} ページ / 索引 ${Date.now() - t0}ms` +
    (index.skipped.length ? ` / 画像でないもの ${index.skipped.length} 件` : '') +
    (index.nested ? ' / **中身が書庫**' : '')
);
for (const s of index.skipped.slice(0, 5)) console.log(`   除外: ${s}`);

const want = args[1] === undefined ? null : Number(args[1]);
if (want === null) {
  for (const [i, p] of index.pages.entries()) {
    if (i < 5 || i > index.pages.length - 3) console.log(`  ${String(i).padStart(4)}  ${kb(p.bytes).padStart(8)}  ${p.name}`);
    else if (i === 5) console.log('   …');
  }
  db.close();
  process.exit(0);
}

const page = index.pages[want];
if (!page) {
  console.error(`そのページはありません: ${want} (0〜${index.pages.length - 1})`);
  process.exit(1);
}
const t1 = Date.now();
const buf = await readPage(abs, page.name, tmp);
const out = path.join(tmp, `sample-${row.id}-${want}${path.extname(page.name)}`);
fs.writeFileSync(out, buf);
console.log(`${want}: ${page.name}  ${kb(buf.length)}  ${Date.now() - t1}ms`);
console.log(`→ ${out}`);
db.close();
