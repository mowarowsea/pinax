import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import {
  applyMoves, foldInbox, formatPlan, inboxRootOf, matchByYomi, planMoves,
  readAnswers, shelfRootOf, shelfWithYomi, suspectAnswers,
} from './inbox.js';

/**
 * 受け入れトレイを棚へ入れる道具。
 *
 *   npm run inbox                    畳んだ結果を見る (何件を外に聞く必要があるか)
 *   npm run inbox -- ask ask.tsv     外に聞く分を TSV で書き出す
 *   npm run inbox -- plan ans.tsv    答えを当てて計画を見る (**動かさない**)
 *   npm run inbox -- apply ans.tsv   計画を実行する (移動ログを残す)
 *
 * **plan を見てから apply する。** 3000 件を機械が黙って動かして間違えると、
 * どれが元どこにあったか分からなくなる。
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

if (cmd !== 'plan' && cmd !== 'apply') {
  console.error(`知らないコマンド: ${cmd} (look / ask / plan / apply)`);
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
  console.log('中身を見て良ければ: npm run inbox -- apply ' + file);
  process.exit(0);
}

console.log(`\n${plan.moves.length} ファイルを ${shelfRoot.path} へ移します...`);
const result = applyMoves(plan, inboxRoot.path, shelfRoot.path, cfg.dataDir);
console.log(`移動: ${result.moved} 件`);
if (result.failed.length) {
  console.log(`失敗: ${result.failed.length} 件`);
  for (const f of result.failed.slice(0, 10)) console.log(`  ${f.from} — ${f.error}`);
}
console.log(`移動ログ: ${result.logPath}`);
console.log('\n棚に載せるには画面の「棚を読み直す」か POST /api/scan。');
