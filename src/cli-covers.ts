/**
 * 表紙をまとめて埋める口。
 *
 *   npm run covers                 … 巻の抜けを 200 巻ぶん埋める
 *   npm run covers -- 2000         … 2000 巻ぶん
 *   npm run covers -- 2000 series  … 表紙の無い「作品」の方を埋める
 *   npm run covers -- 2000 retry   … 一度試して駄目だった巻もやり直す
 *
 * `retry` は提供元を足した後に使う。普段は一度試した巻を 60 日は選び直さないので、
 * 新しい経路を足しても**古い「駄目だった」印に阻まれて何も起きない**。
 *
 * サーバーの巡回は 5 分ごとに 20 巻ずつしか進まない。1600 巻を待つと 7 時間かかるので、
 * 一気に詰めたい時はこちらを使う。サーバーは動かしたままでよい
 * (`PRAGMA busy_timeout` を入れてあるので、書き込みがかち合っても待つだけ)。
 */
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { fillMissingCovers, fillVolumeCovers } from './bib/enrich.js';
import { googleReady } from './bib/google.js';
import { openbdReady } from './bib/openbd.js';
import { rakutenReady } from './bib/rakuten.js';

const args = process.argv.slice(2);
const limit = Number(args.find((a) => /^\d+$/.test(a)) ?? 200);
const mode = args.includes('series') ? 'series' : 'volumes';
const retry = args.includes('retry');

const cfg = loadConfig();
const db = new Db(cfg.dataDir);
const started = Date.now();

/**
 * まだ表紙の無い巻を数える。
 *
 * **`volumes` を必ず噛ませること。** `bib` には**持っていない巻の書誌も入っている**
 * (「何巻まで出ているか」を出すため。published.ts 参照) ので、bib だけを数えると
 * 手元に無い巻まで「表紙が無い」に混ざって、実際に取りに行く数と食い違う。
 * fillVolumeCovers が選ぶ条件とここを揃えておく。
 */
const remaining = (): number =>
  (
    db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM bib b JOIN series s ON s.id = b.series_id
          WHERE s.present = 1 AND b.isbn IS NOT NULL AND b.isbn <> '' AND b.volume_no IS NOT NULL
            AND EXISTS (SELECT 1 FROM volumes v
                         WHERE v.series_id = b.series_id AND v.present = 1
                           AND b.volume_no BETWEEN v.volume_from AND v.volume_to)
            AND NOT EXISTS (SELECT 1 FROM covers c WHERE c.series_id = b.series_id
                             AND c.slot = 'v:巻:' || b.volume_no)`
      )
      .get() as { n: number }
  ).n;

/**
 * **どこに聞けるのかを先に出す。** 鍵が無いまま走らせると「0 枚」とだけ出て、
 * 相手が書影を持っていないのか、こちらが聞きに行けていないのかが見分けられない。
 */
const ready: [string, boolean][] = [
  ['楽天', rakutenReady(cfg)],
  ['openBD', openbdReady(cfg)],
  ['Google', googleReady(cfg)],
];
for (const [name, on] of ready) {
  console.log(`${name}: ${on ? '使えます' : '**使いません** (鍵が無いか providers に入っていない)'}`);
}

if (mode === 'series') {
  const rs = await fillMissingCovers(db, cfg, { seriesLimit: limit, coverBudgetPerSeries: 30 });
  const wrote = rs.reduce((a, r) => a + r.coversWritten, 0);
  console.log(`作品 ${rs.length} 件を見て 表紙 ${wrote} 枚`);
  for (const r of rs.filter((x) => x.error)) console.log(`  ${r.label}: ${r.error}`);
} else {
  console.log(`表紙の無い巻: ${remaining()} 巻${retry ? ' (一度駄目だった巻もやり直す)' : ''}`);

  // fillVolumeCovers は 1 回 500 巻で切る (背景仕事として呼ばれる時に長く居座らないため)。
  // ここは人が「全部やれ」と言う口なので、指定された数に届くまで回す
  const totals: Record<string, number> = {};
  let tried = 0;
  let written = 0;
  let touched = 0;
  while (tried < limit) {
    const r = await fillVolumeCovers(db, cfg, {
      limit: Math.min(500, limit - tried),
      ...(retry ? { retryAfterDays: 0 } : {}),
    });
    tried += r.tried;
    written += r.written;
    touched += r.seriesTouched;
    for (const [k, n] of Object.entries(r.byProvider)) totals[k] = (totals[k] ?? 0) + n;
    console.log(`  … ${tried} 巻まで / 焼けた ${written} 枚 / 残り ${remaining()} 巻`);
    if (r.stopError) {
      // 誰に何を言われたかは message の側が名乗る (ProviderStopError)
      console.error(`\n**打ち切りました**: ${r.stopError}`);
      break;
    }
    if (r.dbBusy) {
      console.error('\nDB がスキャンに掴まれています。もう一度走らせれば続きから進みます');
      break;
    }
    // もう取りに行く巻が無い
    if (r.tried === 0) break;
  }

  const by = Object.entries(totals).map(([k, n]) => `${k} ${n}枚`).join(' / ') || '-';
  console.log(`\n取りに行った ${tried} 巻 → 焼けた ${written} 枚 (${by})`);
  console.log(`代表表紙を貼り直した作品 ${touched} 件`);
  console.log(`残り ${remaining()} 巻`);
}

console.log(`${Math.round((Date.now() - started) / 1000)}秒`);
db.close();
