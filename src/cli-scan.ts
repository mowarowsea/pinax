/** スキャンだけ回す口。サーバーを立てずに棚卸しの結果を見たい時に使う */
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { scanAll } from './scan/scanner.js';

const cfg = loadConfig();
const db = new Db(cfg.dataDir);
for (const r of await scanAll(db, cfg.roots)) {
  if (r.error) { console.error(`${r.rootId}: ${r.error}`); continue; }
  console.log(
    `${r.rootId}: ${r.filesSeen} ファイル / 作品 +${r.seriesAdded} / 巻 +${r.volumesAdded}` +
    `${r.gone ? ` / 見当たらない ${r.gone}` : ''}${r.baseline ? ' (棚卸し)' : ''} ` +
    `${Math.round(r.elapsedMs / 100) / 10}秒`
  );
}
db.close();
