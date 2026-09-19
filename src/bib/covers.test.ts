import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { SERIES_SLOT, sideSlot, volumeSlot } from '../cover-slot.js';
import { Db } from '../db.js';
import { writeCover } from './covers.js';
import { seriesKeyOf } from '../volume.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinax-covers-'));
let db = new Db(dir);

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seed(title: string): number {
  const { row } = db.upsertSeries({
    rootId: 'test', folder: title, seriesKey: seriesKeyOf(title), title, author: null, completed: false,
  });
  return row.id;
}

/** 焼いた画像 1 枚ぶんの形。中身は見ないので名前だけ違えば足りる */
const burn = (file: string) => ({ file, bytes: 1, contentType: 'image/jpeg' });

const reps = (id: number) =>
  db.raw
    .prepare("SELECT file, pinned FROM covers WHERE series_id = ? AND slot = '' ORDER BY id")
    .all(id)
    .map((r) => ({ file: String(r.file), pinned: Number(r.pinned) }));

const slots = (id: number) =>
  db.raw
    .prepare('SELECT slot, volume_no, file FROM covers WHERE series_id = ? ORDER BY slot')
    .all(id)
    .map((r) => ({
      slot: String(r.slot),
      volumeNo: r.volume_no === null ? null : Number(r.volume_no),
      file: String(r.file),
    }));

test('代表表紙は何度貼っても 1 行。最後に貼った絵が残る', () => {
  // 宛先が縛られていないと行が 3 本に増え、読む側 (catalog.ts) は一番古い a.jpg を拾い続ける
  const id = seed('代表が増えない');
  for (const f of ['a.jpg', 'b.jpg', 'c.jpg']) {
    writeCover(db, { seriesId: id, slot: SERIES_SLOT, provider: 'ndl', sourceUrl: null, isbn: null, burned: burn(f) });
  }
  assert.deepEqual(reps(id), [{ file: 'c.jpg', pinned: 0 }]);
});

test('人が選んだ代表表紙は、後から来た自動の巡回に潰されない', () => {
  const id = seed('選んだ代表が残る');
  writeCover(db, { seriesId: id, slot: SERIES_SLOT, provider: 'ndl', sourceUrl: null, isbn: null, burned: burn('auto.jpg') });
  writeCover(db, { seriesId: id, slot: SERIES_SLOT, provider: 'rakuten', sourceUrl: null, isbn: null, burned: burn('mine.jpg'), pinned: true });
  writeCover(db, { seriesId: id, slot: SERIES_SLOT, provider: 'google', sourceUrl: null, isbn: null, burned: burn('auto2.jpg') });
  assert.deepEqual(reps(id), [{ file: 'mine.jpg', pinned: 1 }], '衝突しないと pinned の守りも効かない');

  // 人が選び直す分には通る
  writeCover(db, { seriesId: id, slot: SERIES_SLOT, provider: 'ndl', sourceUrl: null, isbn: null, burned: burn('mine2.jpg'), pinned: true });
  assert.deepEqual(reps(id), [{ file: 'mine2.jpg', pinned: 1 }]);
});

test('巻ごとの表紙は今まで通り巻ごとに 1 行', () => {
  const id = seed('巻ごとは変わらない');
  writeCover(db, { seriesId: id, slot: volumeSlot(1), provider: 'ndl', sourceUrl: null, isbn: null, burned: burn('v1.jpg') });
  writeCover(db, { seriesId: id, slot: volumeSlot(2), provider: 'ndl', sourceUrl: null, isbn: null, burned: burn('v2.jpg') });
  writeCover(db, { seriesId: id, slot: volumeSlot(1), provider: 'ndl', sourceUrl: null, isbn: null, burned: burn('v1b.jpg') });
  assert.deepEqual(slots(id), [
    { slot: 'v:巻:1', volumeNo: 1, file: 'v1b.jpg' },
    { slot: 'v:巻:2', volumeNo: 2, file: 'v2.jpg' },
  ]);
});

test('合本・別巻・単巻は別々の板。互いを踏まない', () => {
  // ここが踏み合うと、合本の表紙を選んだだけで第01巻の絵まで変わる
  const id = seed('板は踏み合わない');
  writeCover(db, { seriesId: id, slot: volumeSlot(1), provider: 'ndl', sourceUrl: null, isbn: null, burned: burn('single1.jpg') });
  writeCover(db, { seriesId: id, slot: volumeSlot(1, 2), provider: 'ndl', sourceUrl: null, isbn: null, burned: burn('omnibus.jpg') });
  writeCover(db, { seriesId: id, slot: sideSlot('外伝'), provider: 'ndl', sourceUrl: null, isbn: null, burned: burn('side.jpg') });
  writeCover(db, { seriesId: id, slot: sideSlot(''), provider: 'ndl', sourceUrl: null, isbn: null, burned: burn('honpen.jpg') });

  assert.deepEqual(slots(id), [
    // 別巻は数直線に乗らないので volume_no を持たない (代表表紙の流用先から外れる)
    { slot: 's:', volumeNo: null, file: 'honpen.jpg' },
    { slot: 's:外伝', volumeNo: null, file: 'side.jpg' },
    { slot: 'v:巻:1', volumeNo: 1, file: 'single1.jpg' },
    // 合本は覆う中で一番若い巻を名乗る。**並べ替えの鍵であって宛先ではない**
    { slot: 'v:巻:1-2', volumeNo: 1, file: 'omnibus.jpg' },
  ]);
});

test('同じ番号でも単位が違えば別の板', () => {
  // 巻で数える作品に「第224話」が 1 つ混ざることが実際にある。
  // 番号だけを宛先にすると、第224巻と第224話が同じ板を取り合う
  const id = seed('単位で分かれる');
  writeCover(db, { seriesId: id, slot: volumeSlot(224, 224, '巻'), provider: 'ndl', sourceUrl: null, isbn: null, burned: burn('kan.jpg') });
  writeCover(db, { seriesId: id, slot: volumeSlot(224, 224, '話'), provider: 'ndl', sourceUrl: null, isbn: null, burned: burn('wa.jpg') });
  assert.deepEqual(slots(id), [
    { slot: 'v:巻:224', volumeNo: 224, file: 'kan.jpg' },
    { slot: 'v:話:224', volumeNo: 224, file: 'wa.jpg' },
  ]);
});

test('宛先を持たなかった頃の DB は、開き直した時に板へ移し替えられる', () => {
  // 増えてしまった代表表紙はそこで 1 行へ畳む。残るのは
  // 「人が選んだ行 → 新しい行」の順で 1 行だけ
  const id = seed('古い DB を畳む');
  db.raw.exec('DROP TABLE covers');
  db.raw.exec(
    `CREATE TABLE covers (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
       volume_no INTEGER,
       provider TEXT NOT NULL,
       source_url TEXT,
       isbn TEXT,
       file TEXT NOT NULL,
       bytes INTEGER NOT NULL DEFAULT 0,
       content_type TEXT,
       pinned INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL,
       UNIQUE(series_id, volume_no)
     )`
  );
  const ins = db.raw.prepare(
    `INSERT INTO covers (series_id, volume_no, provider, file, bytes, pinned, created_at)
     VALUES (?, ?, 'ndl', ?, 1, ?, '2026-01-01')`
  );
  ins.run(id, null, 'old.jpg', 0);
  ins.run(id, null, 'picked.jpg', 1);
  ins.run(id, null, 'new.jpg', 0);
  ins.run(id, 3, 'v3.jpg', 0);

  db.close();
  db = new Db(dir);

  assert.deepEqual(slots(id), [
    { slot: '', volumeNo: null, file: 'picked.jpg' },
    { slot: 'v:巻:3', volumeNo: 3, file: 'v3.jpg' },
  ]);
});
