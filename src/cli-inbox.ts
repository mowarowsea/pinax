import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import {
  applyMoves, bucketOf, bucketize, foldInbox, formatPlan, inboxRootOf, matchByYomi,
  planMoves, readAnswers, shelfRootOf, shelfWithYomi, suspectAnswers, type Plan,
} from './inbox.js';

/**
 * 受け入れトレイを棚へ入れる道具。
 *
 *   npm run inbox                    畳んだ結果を見る (何件を外に聞く必要があるか)
 *   npm run inbox -- ask ask.tsv     外に聞く分を TSV で書き出す
 *   npm run inbox -- plan ans.tsv    答えを当てて計画を見る (**動かさない**)
 *   npm run inbox -- sort ans.tsv    トレイの中でフォルダ分けする (棚には出さない)
 *   npm run inbox -- apply ans.tsv   棚へ移す (移動ログを残す)
 *
 * **plan を見てから動かす。** 3000 件を機械が黙って動かして間違えると、
 * どれが元どこにあったか分からなくなる。
 *
 * sort と apply の違いは行き先だけ。sort はトレイの中に作品フォルダを掘って
 * そこへ入れる — **人が中を見てから手で棚へ移すため**で、名前の付け方は
 * どちらも同じ。
 */
const [cmd = 'look', file] = process.argv.slice(2);

const cfg = loadConfig();
const inboxRoot = inboxRootOf(cfg.roots);
const shelfRoot = shelfRootOf(cfg.roots);

if (!inboxRoot) {
  console.error('config.json の roots に kind: "inbox" の根がありません');
  process.exit(1);
}
if (!shelfRoot) {
  console.error('config.json の roots に kind: "shelf" の根がありません');
  process.exit(1);
}

const db = new Db(cfg.dataDir);
const works = foldInbox(inboxRoot.path);
const matched = matchByYomi(works, shelfWithYomi(db));
const known = matched.filter((m) => m.shelf);
const unknown = matched.filter((m) => !m.shelf);
const fileCount = works.reduce((n, w) => n + w.files.length, 0);

console.log(`トレイ: ${inboxRoot.path}`);
console.log(`  ${fileCount} ファイル → ${works.length} 作品`);
console.log(`  棚の読みで当たった: ${known.length} 作品`);
console.log(`  外に聞く必要がある: ${unknown.length} 作品`);

if (cmd === 'look') {
  console.log('\n次にやること: npm run inbox -- ask ask.tsv');
  process.exit(0);
}

if (cmd === 'ask') {
  const out = file ?? 'ask.tsv';
  const rows = unknown
    .sort((a, b) => b.work.files.length - a.work.files.length)
    .map(({ work }) => {
      const vols = work.files.map((f) => f.from).filter((v): v is number => v !== null);
      const range = vols.length ? `${Math.min(...vols)}-${Math.max(...vols)}` : '';
      return [work.key, work.label, range, work.files.length].join('\t');
    });
  fs.writeFileSync(out, `key\tromaji\tvolumes\tfiles\n${rows.join('\n')}\n`);
  console.log(`\n書き出し: ${out} (${rows.length} 作品)`);
  console.log('この TSV を渡して、key はそのままに「作品名」と「著者」を埋めてもらう。');
  console.log('**分からないものは空のままにしてもらうこと。** 推測で埋まると別作品のフォルダへ散る。');
  process.exit(0);
}

if (cmd !== 'plan' && cmd !== 'sort' && cmd !== 'apply') {
  console.error(`知らないコマンド: ${cmd} (look / ask / plan / sort / apply)`);
  process.exit(1);
}
if (!file || !fs.existsSync(file)) {
  console.error(`答えの TSV を渡してください: npm run inbox -- ${cmd} <answers.tsv>`);
  process.exit(1);
}

const answers = readAnswers(file);
console.log(`  答えが埋まっていたもの: ${answers.size} 作品`);

// **同じ答えを使い回した間違いをここで落とす。** 通すと別作品が 1 つのフォルダへ流れ込む
// ファイル名から直接読めた作品は答えを使わないので、疑いの数にも入れない
// (日本語キーとローマ字キーは必ず「似ていない」ので、入れると正しい答えまで外れる)
const needAnswer = new Set(matched.filter((m) => !m.work.parsed).map((m) => m.work.key));
const suspects = suspectAnswers(answers, needAnswer);
if (suspects.size > 0) {
  console.log(`\n  ⚠ 答えが怪しいので外したもの: ${suspects.size} 作品`);
  const shown = new Set<string>();
  for (const [key, why] of suspects) {
    if (shown.has(why)) continue;
    shown.add(why);
    console.log(`      ${why}`);
    if (shown.size >= 6) { console.log(`      ... 他 ${new Set([...suspects.values()]).size - 6} 件`); break; }
  }
  for (const key of suspects.keys()) answers.delete(key);
}

const shelf = shelfWithYomi(db);
const plan = planMoves(matched, answers, shelfRoot.path, shelf);
console.log('');
console.log(formatPlan(plan));

if (cmd === 'plan') {
  const out = path.join(cfg.dataDir, 'inbox-plan.json');
  fs.writeFileSync(out, JSON.stringify(plan, null, 1));
  console.log(`\n計画を書き出し: ${out}`);
  console.log(`中身を見て良ければ:`);
  console.log(`  npm run inbox -- sort ${file}    トレイの中でフォルダ分けする`);
  console.log(`  npm run inbox -- apply ${file}   棚へ移す`);
  process.exit(0);
}

/** 仕分けの箱ごとに、何作品 / 何本になるかを数える */
function countBuckets(p: Plan): string[] {
  const boxes = new Map<string, { files: number; folders: Set<string> }>();
  for (const m of p.moves) {
    const b = bucketOf(m);
    if (!boxes.has(b)) boxes.set(b, { files: 0, folders: new Set() });
    const box = boxes.get(b)!;
    box.files++;
    box.folders.add(path.dirname(m.to));
  }
  return [...boxes].map(([b, v]) => `  ${b.padEnd(8)} ${String(v.folders.size).padStart(4)} フォルダ / ${v.files} 本`);
}

const dest = cmd === 'sort' ? inboxRoot.path : shelfRoot.path;
const moving = cmd === 'sort' ? bucketize(plan) : plan;

if (cmd === 'sort') {
  console.log('\nトレイの中でフォルダ分けします。棚には出しません。');
  console.log(countBuckets(plan).join('\n'));
}

console.log(`\n${moving.moves.length} ファイルを ${dest} へ移します...`);
const result = applyMoves(moving, inboxRoot.path, dest, cfg.dataDir);
console.log(`移動: ${result.moved} 件`);
if (result.failed.length) {
  console.log(`失敗: ${result.failed.length} 件`);
  for (const f of result.failed.slice(0, 10)) console.log(`  ${f.from} — ${f.error}`);
}
console.log(`移動ログ: ${result.logPath}`);
console.log(
  cmd === 'sort'
    ? '\n中を見て、フォルダごと棚へ移してください。棚に載るのは移した後のスキャンから。'
    : '\n棚に載せるには画面の「棚を読み直す」か POST /api/scan。'
);
