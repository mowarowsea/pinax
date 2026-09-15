import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenbd } from './openbd.js';

/**
 * 下の JSON は **openBD が実際に返してきたもの** (2026-09-15 に実測)。
 *
 * 見どころは `cover` が**空文字で入ってくる**こと。`null` でも欠けているのでもないので、
 * 素直に読むと「書影あり」と読み違える。手元の漫画ではこちらが普通で、
 * 200 件引いて書影が付いたのは 0 件だった。
 */

const WITH_COVER = JSON.stringify([
  {
    summary: {
      isbn: '9784434167034',
      title: 'ゲート　自衛隊　彼の地にて、斯く戦えり1',
      volume: '',
      series: 'アルファポリスCOMICS',
      publisher: 'アルファポリス',
      pubdate: '20120615',
      cover: 'https://cover.openbd.jp/9784434167034.jpg',
      author: '竿尾悟／漫画 柳内たくみ／原作',
    },
  },
]);

const WITHOUT_COVER = JSON.stringify([
  {
    summary: {
      isbn: '9784063144345',
      title: 'ラブやん 7',
      volume: '434',
      series: 'アフタヌーンKC',
      publisher: '講談社',
      pubdate: '200611',
      cover: '',
      author: '田丸,浩史',
    },
  },
]);

test('書影を持っている本', () => {
  const r = parseOpenbd(WITH_COVER);
  assert.equal(r?.cover, 'https://cover.openbd.jp/9784434167034.jpg');
  assert.equal(r?.isbn, '9784434167034');
  assert.equal(r?.pubdate, '20120615');
});

test('空文字の cover は「書影なし」', () => {
  assert.equal(parseOpenbd(WITHOUT_COVER)?.cover, null);
});

test('知らない ISBN には null が 1 つ返る', () => {
  assert.equal(parseOpenbd('[null]'), null);
  assert.equal(parseOpenbd('[]'), null);
});

test('壊れた応答を掴んでも落ちない', () => {
  assert.equal(parseOpenbd('<html>502 Bad Gateway</html>'), null);
  assert.equal(parseOpenbd(''), null);
});
