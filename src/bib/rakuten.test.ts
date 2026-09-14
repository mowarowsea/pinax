import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitRakutenVolume, rakutenImageUrl } from './rakuten.js';

/**
 * 楽天が返してきた**実物の書名**を並べてある。
 * ここが崩れると、書名で拾い直す道で別の巻の表紙を貼ることになる。
 */

test('半角括弧 + 算用数字 (よつばと!(16))', () => {
  assert.deepEqual(splitRakutenVolume('よつばと!(16)'), { title: 'よつばと!', volume: 16 });
  assert.deepEqual(splitRakutenVolume('封神演義（2）'), { title: '封神演義', volume: 2 });
});

test('全角括弧 + 漢数字 (日常　（十二）)', () => {
  assert.deepEqual(splitRakutenVolume('日常　（十二）'), { title: '日常', volume: 12 });
  assert.deepEqual(splitRakutenVolume('日常（十）'), { title: '日常', volume: 10 });
  assert.deepEqual(splitRakutenVolume('日常（二十三）'), { title: '日常', volume: 23 });
  assert.deepEqual(splitRakutenVolume('日常（三）'), { title: '日常', volume: 3 });
});

test('素直に「第n巻」と書いてある形', () => {
  assert.deepEqual(splitRakutenVolume('ヒストリエ 第10巻'), { title: 'ヒストリエ', volume: 10 });
  assert.deepEqual(splitRakutenVolume('ヒストリエ 十巻'), { title: 'ヒストリエ', volume: 10 });
});

test('巻が書かれていない書名は巻なしで返す', () => {
  assert.deepEqual(splitRakutenVolume('よつばとスタジオ'), { title: 'よつばとスタジオ', volume: null });
  // **括弧の中が巻数とは限らない。** 数として読めないものは巻にしない
  assert.deepEqual(splitRakutenVolume('鋼の錬金術師（完全版）'), { title: '鋼の錬金術師（完全版）', volume: null });
});

test('書影 URL の大きさを差し替える', () => {
  assert.equal(
    rakutenImageUrl('https://thumbnail.image.rakuten.co.jp/@0_mall/book/cabinet/a/b.jpg?_ex=200x200', 600),
    'https://thumbnail.image.rakuten.co.jp/@0_mall/book/cabinet/a/b.jpg?_ex=600x600'
  );
  // _ex が無い URL にも付ける
  assert.equal(rakutenImageUrl('https://example.test/a.jpg', 600), 'https://example.test/a.jpg?_ex=600x600');
  assert.equal(rakutenImageUrl(null, 600), null);
});
