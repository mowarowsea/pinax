import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { foldInbox, inboxKeyOf, splitInboxName, suspectAnswers, type Answer } from './inbox.js';

/**
 * 受け入れトレイの読み方。**ここに並ぶのは全部、実物 3056 ファイルで踏んだ形**
 * (Z:\\90_新悟スペース\\JDownLoaderダウンロード、2026-09-15)。
 */

test('巻数の後ろに付く版・品質の印を落とす', () => {
  const work = (s: string) => splitInboxName(s).work;
  assert.equal(work('Oshinoko_03s+'), 'Oshinoko');
  assert.equal(work('Akatsuki_no_Yona_26v2'), 'Akatsuki_no_Yona');
  assert.equal(work('Aozakura_25s_fix'), 'Aozakura');
  assert.equal(work('One_Punch-man_15_LQ'), 'One_Punch-man');
  assert.equal(work('Land_07w'), 'Land');
  assert.equal(work('Yari_no_Yuusha_no_Yarinaoshi_10-11v2'), 'Yari_no_Yuusha_no_Yarinaoshi');
});

/** 印を単独で剥がすと作品名が壊れる。数字の直後にある時だけ印とみなす */
test('作品名の末尾の文字を印と間違えない', () => {
  assert.equal(splitInboxName('Kasane_12').work, 'Kasane');
  assert.equal(splitInboxName('Landreaall').work, 'Landreaall');
  assert.equal(splitInboxName('16bit_sensation_01-02').work, '16bit_sensation');
});

test('巻と範囲を読む', () => {
  assert.deepEqual(
    (({ from, to, unit }) => [from, to, unit])(splitInboxName('100man no Inochi no ue ni ore v15-16s')),
    [15, 16, '巻']
  );
  assert.deepEqual(
    (({ from, to, unit }) => [from, to, unit])(splitInboxName('Joshiman v01-02')),
    [1, 2, '巻']
  );
});

/**
 * 話を巻に倒すと「第103巻」が棚に並び、欠番の数直線が壊れる
 * (docs/ARCHITECTURE.md「巻と話は別々の数直線で数える」)。
 */
test('ch / c で書かれた話数は話のまま持つ', () => {
  const r = splitInboxName('[藤栄道彦]_最後のレストランch84-103');
  assert.equal(r.work, '[藤栄道彦]_最後のレストラン');
  assert.deepEqual([r.from, r.to, r.unit], [84, 103, '話']);
});

/**
 * 実際に踏んだ: 日本語の「第006-014話」を読めず、planName の中で parseFilename が
 * 読み直した 6-14 に「巻」が被さって `第06-14巻` になっていた。後ろの配信期間ごと
 * 落ちるように、日本語側は末尾に縛っていない。
 */
test('日本語で書かれた話数も話のまま持つ', () => {
  const r = splitInboxName('[芝村裕吏×橋本晴一]_遙か凍土のカナン_第006-014話_[2018-05-06～2019-04-03]');
  assert.equal(r.work, '[芝村裕吏×橋本晴一]_遙か凍土のカナン');
  assert.deepEqual([r.from, r.to, r.unit], [6, 14, '話']);
});

test('巻と話が両方あるなら巻を採る', () => {
  const r = splitInboxName('Busamen_Gachi_Fighter_01s ch05-07');
  assert.equal(r.work, 'Busamen_Gachi_Fighter');
  assert.deepEqual([r.from, r.to, r.unit], [1, 1, '巻']);
});

test('巻数を読めないものは null のまま (勝手に第01巻にしない)', () => {
  const r = splitInboxName('[山岸凉子]_艮');
  assert.equal(r.from, null);
  assert.equal(r.to, null);
});

test('年号を巻数と読まない', () => {
  assert.equal(splitInboxName('Series_1999-2024').from, null);
});

test('共著の × と x は同じキーになる', () => {
  assert.equal(inboxKeyOf('SPY×FAMILY'), inboxKeyOf('SPYxFAMILY'));
});

// ---- 畳む ------------------------------------------------------------------

/** 名前だけのファイルを並べたトレイを作る */
function tray(names: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinax-inbox-'));
  for (const n of names) fs.writeFileSync(path.join(dir, n), '');
  return dir;
}

/**
 * 実際に踏んだ (2026-09-15): 話数を剥がす前の名前を `parseFilename` に渡していて、
 * `最後のレストランch84-103` という作品フォルダが掘られる計画になっていた。
 */
test('日本語ファイル名の作品名に巻・話が残らない', () => {
  const works = foldInbox(tray([
    '[藤栄道彦]_最後のレストランch84-103.zip',
    '[あれっくす]_私の魔法の先生は魔法が使えない_第01-02巻.rar',
  ]));
  assert.deepEqual(
    works.map((w) => w.parsed?.title).sort(),
    ['最後のレストラン', '私の魔法の先生は魔法が使えない']
  );
});

/** 頭の宣伝を落とさないと、同じ作品を 2 つのキーで外へ聞くことになる */
test('アップローダの宣伝を落としてから畳む', () => {
  const works = foldInbox(tray(['MG-Zip.Com-One_Punch-man_15_LQ.rar', 'One_Punch-man_16.rar']));
  assert.equal(works.length, 1);
  assert.equal(works[0].files.length, 2);
});

// ---- 外へ聞いた答えの検算 --------------------------------------------------

const answer = (key: string, title: string): [string, Answer] => [key, { key, title, author: null }];

/**
 * 実際に踏んだ (2026-09-15): 外へ聞いた答えが `oshi` を含むキーを片っ端から
 * 「【推しの子】」にしてきた。そのまま適用すれば、槍の勇者も七都市物語も殺し愛も
 * 【推しの子】のフォルダへ流れ込んでいた。
 */
test('1 つの作品名が似ていないキーに付いていたら疑う', () => {
  const answers = new Map([
    answer('oshinoko', '【推しの子】'),
    answer('yarinoyuushanoyarinaoshi', '【推しの子】'),
    answer('nanatoshimonogatari', '【推しの子】'),
  ]);
  const suspects = suspectAnswers(answers);
  assert.equal(suspects.size, 3, '巻き添えを恐れず、その作品名の答えは全部外す');
});

test('表記ゆれで同じ作品が複数のキーになるのは通す', () => {
  const answers = new Map([
    answer('arte', 'アルテ'),
    answer('arte13w', 'アルテ'),
  ]);
  assert.equal(suspectAnswers(answers).size, 0);
});

test('1 つのキーにしか付いていない答えは疑わない', () => {
  const answers = new Map([answer('onepunchman', 'ワンパンマン'), answer('berserk', 'ベルセルク')]);
  assert.equal(suspectAnswers(answers).size, 0);
});

/**
 * 畳み方を直すと古い答えのキーが宙に浮く。数に入れると、生きている答えまで
 * 巻き添えで外れる (宣伝 `MG-Zip.Com-` を落とす前のキーで踏んだ)。
 */
test('今のトレイに無いキーは疑いの数に入れない', () => {
  const answers = new Map([
    answer('onepunchman', 'ワンパンマン'),
    answer('mgzipcomonepunchman', 'ワンパンマン'),
  ]);
  assert.equal(suspectAnswers(answers).size, 2, '両方生きていれば疑う');
  assert.equal(suspectAnswers(answers, new Set(['onepunchman'])).size, 0, '片方が宙に浮いていれば疑わない');
});
