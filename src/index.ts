import os from 'node:os';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { buildServer } from './server.js';
import { scanAll } from './scan/scanner.js';
import { pushPending } from './notify.js';
import { fillMissingCovers, fillVolumeCovers } from './bib/enrich.js';

/**
 * 起動。
 *
 * LocalLauncher から起動される前提なので:
 *  - **フォアグラウンドで走り続ける** (デーモン化しない。生死を見失わせない)
 *  - **対話的な入力を一切求めない** (設定は config.json だけで完結する)
 *  - `GET /api/health` が生きていれば 200 を返す
 */

const cfg = loadConfig();
const db = new Db(cfg.dataDir);

const log = (...a: unknown[]): void => console.log(`[pinax ${new Date().toLocaleTimeString('ja-JP')}]`, ...a);

function lanAddress(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

const appUrl = `http://${lanAddress()}:${cfg.port}`;

async function sweep(reason: string): Promise<void> {
  if (!cfg.roots.length) {
    log('蔵書ルートが未設定です。config.json の roots に棚を足してください');
    return;
  }
  log(`スキャン開始 (${reason})`);
  for (const r of await scanAll(db, cfg.roots)) {
    if (r.error) {
      log(`  ${r.rootId}: ${r.error}`);
      continue;
    }
    log(
      `  ${r.rootId}: ${r.filesSeen} ファイル / 作品 +${r.seriesAdded} / 巻 +${r.volumesAdded}` +
        `${r.gone ? ` / 見当たらない ${r.gone}` : ''}${r.baseline ? ' (棚卸し)' : ''} ${Math.round(r.elapsedMs / 100) / 10}秒`
    );
  }
  const pushed = await pushPending(db, cfg, appUrl);
  if (pushed) log(`  通知 ${pushed} 件`);
}

const server = buildServer(db, cfg);

await server.listen({ port: cfg.port, host: cfg.host });
log(`pinax — Never burn. Remember Alexandria.`);
log(`起動しました ${appUrl}  (蔵書ルート ${cfg.roots.length} 件)`);

if (cfg.scan.onStart) {
  // 起動そのものは待たせない。HTTP を開けてからスキャンに入る
  void sweep('起動時').catch((e) => log('スキャンに失敗:', (e as Error).message));
}

let timer: NodeJS.Timeout | null = null;
if (cfg.scan.intervalMinutes > 0) {
  timer = setInterval(() => {
    void sweep('定期').catch((e) => log('スキャンに失敗:', (e as Error).message));
  }, cfg.scan.intervalMinutes * 60_000);
}

/**
 * 表紙は少しずつ埋める。まとめて 500 作品ぶん取りに行くと相手に迷惑がかかるので、
 * 5 分ごとに少しだけ進める。**進み具合は covers 表そのものが持つ**ので、
 * 落ちても次の起動から続きになる。
 *
 * 2 段ある。順番に意味がある:
 *  1. まだ表紙の無い**作品**を埋める (棚の一覧の見た目に直結する)
 *  2. 作品の中で抜けている**巻**を埋める (作品を開いた時の歯抜けを埋める)
 *
 * 1 を先にするのは、棚に 1 枚も絵の無い作品が残っている状態の方が目に痛いから。
 */
async function fillCovers(): Promise<void> {
  const rs = await fillMissingCovers(db, cfg, { seriesLimit: 3, coverBudgetPerSeries: 20 });
  const done = rs.filter((r) => r.coversWritten > 0);
  if (done.length) log(`表紙(作品) ${done.map((r) => `${r.label}(${r.coversWritten}枚)`).join(', ')}`);

  const authFailed = rs.find((r) => r.error?.includes('楽天'));
  if (authFailed) {
    log(`楽天に弾かれました: ${authFailed.error}`);
    return;
  }

  const v = await fillVolumeCovers(db, cfg, { limit: 20 });
  if (v.written) {
    const by = Object.entries(v.byProvider).map(([k, n]) => `${k} ${n}`).join(' / ');
    log(`表紙(巻) ${v.written}/${v.tried}枚 (${by})  作品 ${v.seriesTouched} 件を貼り直し`);
  }
  // 鍵か接続元 IP の問題。**黙って止まらせない** — 放っておくと
  // 「なぜか表紙が増えない」とだけ見えて原因に辿り着けない
  if (v.authError) log(`楽天に弾かれました: ${v.authError}`);
}

const coverTimer = setInterval(() => {
  void fillCovers().catch((e) => log('表紙の取得に失敗:', (e as Error).message));
}, 5 * 60_000);

const shutdown = async (sig: string): Promise<void> => {
  log(`${sig} を受け取りました。終了します`);
  if (timer) clearInterval(timer);
  clearInterval(coverTimer);
  try {
    await server.close();
  } finally {
    db.close();
  }
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
