import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
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
    .prepare('SELECT file, pinned FROM covers WHERE series_id = ? AND volume_no IS NULL ORDER BY id')
    .all(id)
    .map((r) => ({ file: String(r.file), pinned: Number(r.pinned) }));

test('代表表紙は何度貼っても 1 行。最後に貼った絵が残る', () => {
  // UNIQUE(series_id, volume_no) は NULL を縛らない。部分索引で縛っていないと
  // ここで行が 3 本に増え、読む側 (catalog.ts) は一番古い a.jpg を拾い続ける
  const id = seed('代表が増えない');
  for (const f of ['a.jpg', 'b.jpg', 'c.jpg']) {
    writeCover(db, { seriesId: id, volumeNo: null, provider: 'ndl', sourceUrl: null, isbn: null, burned: burn(f) });
  }
  assert.deepEqual(reps(id), [{ file: 'c.jpg', pinned: 0 }]);
});

test('人が選んだ代表表紙は、後から来た自動の巡回に潰されない', () => {
  const id = seed('選んだ代表が残る');
  writeCover(db, { seriesId: id, volumeNo: null, provider: 'ndl', sourceUrl: null, isbn: null, burned: burn('auto.jpg') });
  writeCover(db, { seriesId: id, volumeNo: null, provider: 'rakuten', sourceUrl: null, isbn: null, burned: burn('mine.jpg'), pinned: true });
  writeCover(db, { seriesId: id, volumeNo: null, provider: 'google', sourceUrl: null, isbn: null, burned: burn('auto2.jpg') });
  assert.deepEqual(reps(id), [{ file: 'mine.jpg', pinned: 1 }], '衝突しないと pinned の守りも効かない');

  // 人が選び直す分には通る
  writeCover(db, { seriesId: id, volumeNo: null, provider: 'ndl', sourceUrl: null, isbn: null, burned: burn('mine2.jpg'), pinned: true });
  assert.deepEqual(reps(id), [{ file: 'mine2.jpg', pinned: 1 }]);
});

test('巻ごとの表紙は今まで通り巻ごとに 1 行', () => {
  const id = seed('巻ごとは変わらない');
  writeCover(db, { seriesId: id, volumeNo: 1, provider: 'ndl', sourceUrl: null, isbn: null, burned: burn('v1.jpg') });
  writeCover(db, { seriesId: id, volumeNo: 2, provider: 'ndl', sourceUrl: null, isbn: null, burned: burn('v2.jpg') });
  writeCover(db, { seriesId: id, volumeNo: 1, provider: 'ndl', sourceUrl: null, isbn: null, burned: burn('v1b.jpg') });
  const rows = db.raw
    .prepare('SELECT volume_no, file FROM covers WHERE series_id = ? AND volume_no IS NOT NULL ORDER BY volume_no')
    .all(id)
    .map((r) => ({ volume_no: Number(r.volume_no), file: String(r.file) }));
  assert.deepEqual(rows, [{ volume_no: 1, file: 'v1b.jpg' }, { volume_no: 2, file: 'v2.jpg' }]);
});

test('既に増えてしまった代表表紙は、開き直した時に 1 行へ畳まれる', () => {
  // 縛りの無かった頃の DB を再現する。畳んだ後に残るのは
  // 「人が選んだ行 → 新しい行」の順で 1 行だけ
  const id = seed('古い DB を畳む');
  db.raw.exec('DROP INDEX covers_series_cover');
  const ins = db.raw.prepare(
    `INSERT INTO covers (series_id, volume_no, provider, file, bytes, pinned, created_at)
     VALUES (?, NULL, 'ndl', ?, 1, ?, '2026-01-01')`
  );
  ins.run(id, 'old.jpg', 0);
  ins.run(id, 'picked.jpg', 1);
  ins.run(id, 'new.jpg', 0);
  assert.equal(reps(id).length, 3);

  db.close();
  db = new Db(dir);
  assert.deepEqual(reps(id), [{ file: 'picked.jpg', pinned: 1 }]);
  // 他の作品を巻き添えにしない
  assert.equal(reps(seed('巻ごとは変わらない')).length, 0);
});
