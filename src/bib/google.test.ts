import { test } from 'node:test';
import assert from 'node:assert/strict';
import { googleImageUrl, splitGoogleVolume, GOOGLE_PLACEHOLDER_COVERS } from './google.js';

/**
 * ここに並んでいるのは全部 **Google Books が実際に返してきた形** (2026-09-15 に実測)。
 * 書影 URL の直し方が崩れると、棚に 128px のサムネイルか、
 * 「image not available」の灰色の板が並ぶことになる。
 */

test('書影 URL は https に直し、めくれた端の飾りを落とす', () => {
  // API はこの形で返してくる (http、edge=curl 付き)
  const raw = 'http://books.google.com/books/content?id=VuPKCwAAQBAJ&printsec=frontcover&img=1&zoom=1&edge=curl&source=gbs_api';
  assert.equal(
    googleImageUrl(raw, true),
    'https://books.google.com/books/content?id=VuPKCwAAQBAJ&printsec=frontcover&img=1&zoom=3&source=gbs_api'
  );
  assert.equal(
    googleImageUrl(raw, false),
    'https://books.google.com/books/content?id=VuPKCwAAQBAJ&printsec=frontcover&img=1&zoom=1&source=gbs_api'
  );
});

test('zoom が無い URL にも付ける', () => {
  assert.equal(
    googleImageUrl('https://books.google.com/books/content?id=abc&img=1', true),
    'https://books.google.com/books/content?id=abc&img=1&zoom=3'
  );
  assert.equal(googleImageUrl(null, true), null);
  assert.equal(googleImageUrl('  ', true), null);
});

test('「画像がありません」の板のハッシュを持っている', () => {
  // zoom=0,3 / 2 / 4 / 6 で返る 4 通り。書名によらず同じ画像が来る
  assert.equal(GOOGLE_PLACEHOLDER_COVERS.size, 4);
  assert.ok(GOOGLE_PLACEHOLDER_COVERS.has('3efa8c43e5b4348f303a528c81adf435'));
});

test('末尾の裸の数字を巻として読む', () => {
  assert.deepEqual(splitGoogleVolume('血界戦線 Back 2 Back 5'), { title: '血界戦線 Back 2 Back', volume: 5 });
  assert.deepEqual(splitGoogleVolume('名探偵コナン 97'), { title: '名探偵コナン', volume: 97 });
  // 巻ごとの副題が書名に差し込まれている形。副題は落とさない
  // (落とすと別シリーズを同じ束に混ぜかねない。束ね直しは candidates.ts の仕事)
  assert.deepEqual(splitGoogleVolume('血界戦線―魔封街結社― 1'), { title: '血界戦線―魔封街結社―', volume: 1 });
});

test('括弧書きの巻', () => {
  assert.deepEqual(splitGoogleVolume('よつばと!(16)'), { title: 'よつばと!', volume: 16 });
});

test('同じ巻が二度書かれている形 (よつばと!(14) 14)', () => {
  assert.deepEqual(splitGoogleVolume('よつばと!(14) 14'), { title: 'よつばと!', volume: 14 });
  // 二つの数が食い違う時は、**末尾に書かれている方**を巻とみて括弧は書名に残す
  assert.deepEqual(splitGoogleVolume('よつばと!(14) 15'), { title: 'よつばと!(14)', volume: 15 });
});

test('巻の書かれていない書名はそのまま', () => {
  assert.deepEqual(splitGoogleVolume('ONE PIECE'), { title: 'ONE PIECE', volume: null });
  // **裸の数字は前に空白がある時だけ巻と読む。** `ゾン100` を第100巻にしない
  assert.deepEqual(splitGoogleVolume('ゾン100'), { title: 'ゾン100', volume: null });
});
