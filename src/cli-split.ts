/**
 * 合本を巻ごとに割る。
 *
 *   npm run split -- 1234          … 下見だけ。読むだけで、何も書かない
 *   npm run split -- 1234 --run    … 実際に割る
 *
 * **画面のボタンもここを呼ぶ** (src/split-job.ts が `--ipc` を足して fork する)。
 * 手で叩く道と画面から通る道を 2 本に分けない — 分けると片方だけ直る。
 *
 * 親 (常駐サーバー) が死んだら**この子も降りる**。IPC が切れた合図を 2 通りで拾う:
 * `disconnect` の報せと、重い処理の合間に見る `process.connected`。
 * 同期呼び出しの最中は報せが配られないので、後者が無いと取りこぼす。
 */
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { SplitError, planSplit, runSplit, type SplitProgress } from './split.js';

const args = process.argv.slice(2);
const ipc = args.includes('--ipc');
const run = args.includes('--run');
const fileId = Number(args.find((a) => /^\d+$/.test(a)));

if (!Number.isInteger(fileId)) {
  console.error('使い方: npm run split -- <ファイルid> [--run]');
  process.exit(2);
}

const cfg = loadConfig();
const db = new Db(cfg.dataDir);

/** 親が居なくなったか。IPC で繋がれている時だけ意味を持つ */
let orphaned = false;
if (ipc) process.on('disconnect', () => { orphaned = true; });
const stopped = (): boolean => (ipc ? orphaned || !process.connected : false);

/** 報せは**届いたのを見てから**進む。送りっぱなしで exit すると最後の 1 通が消える */
const send = (m: unknown): Promise<void> =>
  new Promise((resolve) => {
    if (!ipc || !process.connected) return resolve();
    process.send?.(m, () => resolve());
  });

const KIND: Record<string, string> = {
  nested: '中身が書庫', folders: '巻ごとのフォルダ', flat: 'ベタ連番',
};

const bye = (code: number): never => {
  db.close();
  process.exit(code);
};

try {
  const plan = await planSplit(db, cfg, fileId);

  if (!run) {
    console.log(plan.from);
    console.log(`  ${plan.format} / ${KIND[plan.kind]} / ${plan.pages} ページ`);
    if (!plan.ok) {
      console.log(`  分割しません: ${plan.reason}`);
      bye(1);
    }
    for (const p of plan.parts) console.log(`  → ${p.name}  ${p.pages} ページ`);
    bye(0);
  }

  if (!plan.ok) throw new SplitError(plan.reason ?? '分割できません');

  const result = await runSplit(db, cfg, fileId, {
    stopped,
    onProgress: (p) => {
      void send({ t: 'progress', progress: p });
      if (!ipc) console.log(`  ${p.phase} ${p.part}/${p.parts} ${p.label}${p.pages ? ` ${p.page}/${p.pages}` : ''}`);
    },
  });

  for (const n of result.made) console.log(`置きました: ${n}`);
  console.log(`原本を引きました: ${result.attic}`);
  await send({ t: 'done', result });
  bye(0);
} catch (e) {
  const message = e instanceof SplitError ? e.message : (e as Error).message;
  console.error(`分割できませんでした: ${message}`);
  await send({ t: 'error', message });
  bye(1);
}
