import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Db } from './db.js';
import { checkOwned, holdingsOf } from './catalog.js';
import { seriesKeyOf } from './volume.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinax-test-'));
fs.mkdirSync(path.join(dir, 'covers'), { recursive: true });
const db = new Db(dir);

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seed(folder: string, title: string, author: string | null, vols: [number, number, string][]): number {
  const { row } = db.upsertSeries({
    rootId: 'test', folder, seriesKey: seriesKeyOf(title), title, author, completed: false,
  });
  for (const [from, to, unit] of vols) {
    db.upsertVolume({ seriesId: row.id, volumeFrom: from, volumeTo: to, unit, completed: false });
  }
  return row.id;
}


test('欠番は 1 から最大巻までの穴として出る', () => {
  const h = holdingsOf([
    { id: 1, seriesId: 1, volumeFrom: 1, volumeTo: 3, unit: '巻', completed: false, present: true, firstSeenAt: '' },
    { id: 2, seriesId: 1, volumeFrom: 5, volumeTo: 5, unit: '巻', completed: false, present: true, firstSeenAt: '' },
  ]);
  assert.equal(h.length, 1);
  assert.deepEqual(h[0].owned, [1, 2, 3, 5]);
  assert.deepEqual(h[0].missing, [4]);
  assert.equal(h[0].max, 5);
});

test('巻と話は別々の数直線で数える', () => {
  // 混ぜると「第224話を持っている作品が 224 巻まである」ことになる
  const h = holdingsOf([
    { id: 1, seriesId: 1, volumeFrom: 1, volumeTo: 2, unit: '巻', completed: false, present: true, firstSeenAt: '' },
    { id: 2, seriesId: 1, volumeFrom: 224, volumeTo: 224, unit: '話', completed: false, present: true, firstSeenAt: '' },
  ]);
  assert.equal(h.length, 2);
  assert.equal(h[0].unit, '巻');
  assert.equal(h[0].max, 2);
  assert.deepEqual(h[0].missing, []);
  assert.equal(h[1].unit, '話');
});

test('消えたファイルの巻は所持に数えない', () => {
  const h = holdingsOf([
    { id: 1, seriesId: 1, volumeFrom: 1, volumeTo: 1, unit: '巻', completed: false, present: true, firstSeenAt: '' },
    { id: 2, seriesId: 1, volumeFrom: 2, volumeTo: 2, unit: '巻', completed: false, present: false, firstSeenAt: '' },
  ]);
  assert.deepEqual(h[0].owned, [1]);
});

test('所持の問い合わせ: 持っている巻はスキップと答える', () => {
  seed('[つくしあきひと] メイドインアビス', 'メイドインアビス', 'つくしあきひと',
    [[1, 1, '巻'], [2, 2, '巻'], [3, 3, '巻']]);

  const a = checkOwned(db, { title: 'メイドインアビス', volume: '2' });
  assert.equal(a.owned, true);
  assert.deepEqual(a.missing, []);
  assert.equal(a.series.length, 1);
});

test('所持の問い合わせ: 未所持の巻が 1 つでも残れば落とす', () => {
  // 1-3 を持っている状態で 2-5 が来たら 4,5 が残るので落とす
  const a = checkOwned(db, { title: 'メイドインアビス', volume: '2-5' });
  assert.equal(a.owned, false);
  assert.deepEqual(a.missing, [4, 5]);
});

test('所持の問い合わせ: 巻数を読めなければ「持っていない」と答える', () => {
  // 黙って持っていることにすると、その巻が永久に落ちてこない
  const a = checkOwned(db, { title: 'メイドインアビス' });
  assert.equal(a.owned, false);
  assert.equal(a.missing, null);
  assert.match(a.reason, /巻数を読めない/);
});

test('所持の問い合わせ: 蔵書に無い作品', () => {
  const a = checkOwned(db, { title: '存在しない作品', volume: '1' });
  assert.equal(a.owned, false);
  assert.equal(a.series.length, 0);
  assert.match(a.reason, /蔵書にこの作品がありません/);
});

test('所持の問い合わせ: 生テキストからでも巻数を読む', () => {
  const a = checkOwned(db, { title: null, rawText: '[つくしあきひと] メイドインアビス 第03巻' });
  assert.equal(a.owned, true);
});

test('所持の問い合わせ: 著者の違いで同じ作品が別物にならない', () => {
  // PowerDowner 側は title しか送ってこないことがある。著者をキーに含めると噛み合わなくなる
  const a = checkOwned(db, { title: 'メイドインアビス', author: '別の人', volume: '1' });
  assert.equal(a.owned, true);
});
