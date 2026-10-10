import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { SERIES_SLOT, volumeSlot, type CoverSlot } from '../cover-slot.js';
import { Db } from '../db.js';
import { writeCover } from './covers.js';
import { seriesSettled } from './enrich.js';
import { seriesKeyOf } from '../volume.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinax-enrich-'));
const db = new Db(dir);

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seed(title: string, completed: boolean, volumes: [number, number][]): number {
  const { row } = db.upsertSeries({
    rootId: 'test', folder: title, seriesKey: seriesKeyOf(title), title, author: null, completed,
  });
  for (const [from, to] of volumes) {
    db.upsertVolume({ seriesId: row.id, volumeFrom: from, volumeTo: to, unit: '巻', completed });
  }
  return row.id;
}

const paste = (id: number, slot: CoverSlot) =>
  writeCover(db, {
    seriesId: id, slot, provider: 'ndl', sourceUrl: null, isbn: null,
    burned: { file: `${id}-${JSON.stringify(slot)}.jpg`, bytes: 1, contentType: 'image/jpeg' },
  });

test('完結していて持っている巻の表紙が全部あれば、巡回から外す', () => {
  const id = seed('揃った完結', true, [[1, 1], [2, 2]]);
  paste(id, volumeSlot(1));
  assert.equal(seriesSettled(db, id), false, '第02巻の表紙がまだ無い');
  paste(id, volumeSlot(2));
  assert.equal(seriesSettled(db, id), true);
});

test('完結していなければ、表紙が揃っていても回り続ける (新刊の書誌を取るため)', () => {
  // 代表表紙があるだけで外していた頃は、ここで「第2巻まで確認」が止まっていた
  const id = seed('続いている', false, [[1, 1], [2, 2]]);
  paste(id, volumeSlot(1));
  paste(id, volumeSlot(2));
  paste(id, SERIES_SLOT);
  assert.equal(seriesSettled(db, id), false);
});

test('合本は覆う巻を 1 巻ずつ見る', () => {
  const id = seed('合本だけ', true, [[1, 3]]);
  paste(id, volumeSlot(1));
  paste(id, SERIES_SLOT);
  assert.equal(seriesSettled(db, id), false, '第02・03巻の絵がまだ無い');
  paste(id, volumeSlot(2));
  paste(id, volumeSlot(3));
  assert.equal(seriesSettled(db, id), true);
});

test('巻を持たない作品 (単巻もの) は、代表表紙があれば外す', () => {
  const id = seed('単巻もの', false, []);
  assert.equal(seriesSettled(db, id), false);
  paste(id, SERIES_SLOT);
  assert.equal(seriesSettled(db, id), true);
});
