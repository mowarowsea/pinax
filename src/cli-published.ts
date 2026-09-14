/**
 * 「世の中に何巻出ているか」を書誌から取り直す口。
 *
 *   npm run published          … まだ聞いていない作品を埋める
 *   npm run published -- all   … 全作品をやり直す (キャッシュから読むので外へは出ない)
 *
 * 表紙は取りに行かない (`coverBudget: 0`)。NDL への問い合わせは既に焼いてあるので、
 * **ほとんど外に出ずに済む** — 未所持の巻の書誌を捨てていた頃のデータを埋め直す時に使う。
 */
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { enrichSeries } from './bib/enrich.js';
import { publishedOf, shelfStateOf } from './published.js';
import { holdingsOf } from './catalog.js';

const all = process.argv.includes('all');
const cfg = loadConfig();
const db = new Db(cfg.dataDir);
const started = Date.now();

const rows = db.raw
  .prepare(
    `SELECT id FROM series WHERE present = 1 ${all ? '' : 'AND enriched_at IS NULL'} ORDER BY id`
  )
  .all() as { id: number }[];

console.log(`${rows.length} 作品を見ます${all ? ' (全部やり直し)' : ''}`);

let behind = 0;
let done = 0;
for (const r of rows) {
  const res = await enrichSeries(db, cfg, Number(r.id), { coverBudget: 0 });
  done++;
  if (res.error) {
    console.log(`  ${res.label}: ${res.error}`);
    continue;
  }
  const s = db.getSeries(Number(r.id));
  if (!s) continue;
  const holdings = holdingsOf(db.listVolumes(s.id));
  const pub = publishedOf(db, s.id, holdings, s.enrichedAt);
  const st = shelfStateOf(pub, s.completedBy, holdings);
  if (st.status === 'behind') {
    behind++;
    console.log(`  ${s.title}  ${st.label}`);
  }
  if (done % 100 === 0) console.log(`  … ${done}/${rows.length}`);
}

console.log(`\n続きが出ている作品 ${behind} 件 / 見た ${done} 件  ${Math.round((Date.now() - started) / 1000)}秒`);
db.close();
