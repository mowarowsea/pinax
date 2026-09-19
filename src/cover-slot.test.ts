import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseSlot, SERIES_SLOT, sideSlot, slotKey, slotLabel, slotVolumeNo, volumeSlot,
} from './cover-slot.js';

test('板の宛先は書いて読み戻せる', () => {
  // 画面へ出した宛先がそのまま返ってくる。**ここが崩れると、押しても別の板に貼る**
  const cases = [SERIES_SLOT, volumeSlot(3), volumeSlot(1, 2), volumeSlot(224, 224, '話'), sideSlot('外伝'), sideSlot('')];
  for (const slot of cases) {
    assert.deepEqual(parseSlot(slotKey(slot)), slot, slotKey(slot));
  }
});

test('宛先の綴り', () => {
  assert.equal(slotKey(SERIES_SLOT), '');
  assert.equal(slotKey(volumeSlot(3)), 'v:巻:3');
  assert.equal(slotKey(volumeSlot(1, 2)), 'v:巻:1-2');
  assert.equal(slotKey(sideSlot('外伝')), 's:外伝');
  assert.equal(slotKey(sideSlot('')), 's:');
});

test('別巻の呼び名に : が入っていても割らない', () => {
  // `s:` から後ろは丸ごと呼び名。区切り直すと、この形の別巻を二度と名指しできない
  assert.deepEqual(parseSlot('s:Vol:Zero'), sideSlot('Vol:Zero'));
});

test('読めない宛先は null。画面から来た文字をそのまま信じない', () => {
  for (const bad of ['v', 'v:巻', 'v:巻:', 'v:巻:abc', 'v:巻:5-2', 'x:1']) {
    assert.equal(parseSlot(bad), null, bad);
  }
});

test('並べ替えの鍵は、その板が覆う一番若い巻', () => {
  // 代表表紙を「持っている中で一番若い巻」の絵に合わせるために要る (covers.ts)。
  // 数直線に乗らない代表と別巻は持たない
  assert.equal(slotVolumeNo(volumeSlot(3)), 3);
  assert.equal(slotVolumeNo(volumeSlot(1, 6)), 1);
  assert.equal(slotVolumeNo(SERIES_SLOT), null);
  assert.equal(slotVolumeNo(sideSlot('外伝')), null);
});

test('板の名前。呼び名が空の別巻は「本編」', () => {
  assert.equal(slotLabel(SERIES_SLOT), '代表表紙');
  assert.equal(slotLabel(volumeSlot(3)), '第03巻');
  assert.equal(slotLabel(volumeSlot(1, 2)), '第01-02巻');
  assert.equal(slotLabel(sideSlot('外伝')), '外伝');
  assert.equal(slotLabel(sideSlot('')), '本編', '空は「名前が無い」ではなく「作品そのもの」');
});
