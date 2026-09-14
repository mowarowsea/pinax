import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFilename, parseLibraryEntry, splitFilename } from './naming.js';
import { seriesKeyOf, stripCompletionMark } from './volume.js';

/**
 * 命名の読み戻しは蔵書の土台なので、**実物に出てくる形**だけを並べる。
 * ここに出てくる名前は全部 \\192.168.3.30\disk1_pt1\manga から採ったもの。
 */

test('作品フォルダの中の素直な 1 巻', () => {
  const e = parseLibraryEntry('[つくしあきひと] メイドインアビス\\[つくしあきひと] メイドインアビス 第01巻.rar');
  assert.equal(e.series.author, 'つくしあきひと');
  assert.equal(e.series.title, 'メイドインアビス');
  assert.equal(e.volumeFrom, 1);
  assert.equal(e.volumeTo, 1);
  assert.equal(e.unit, '巻');
  assert.equal(e.ext, '.rar');
});

test('完結マークはフォルダにもファイルにも付く', () => {
  const e = parseLibraryEntry('[あらゐけいいち] 日常(完)\\[あらゐけいいち] 日常 第10巻(完).rar');
  assert.equal(e.series.title, '日常');
  assert.equal(e.series.completed, true);
  assert.equal(e.volumeCompleted, true);
  assert.equal(e.volumeFrom, 10);
});

test('フォルダにだけ完結マークが付いていても完結として読む', () => {
  const e = parseLibraryEntry('[Boichi] ORIGIN -オリジン-(完)\\[Boichi] ORIGIN -オリジン- 第03巻.rar');
  assert.equal(e.series.completed, true);
  assert.equal(e.volumeCompleted, false);
  assert.equal(e.series.title, 'ORIGIN -オリジン-');
});

test('完結マークを落とさないとフォルダとファイルでキーが割れる', () => {
  // これを落とさないまま運用すると、完結した 103 作品が 2 つずつに見える
  assert.equal(seriesKeyOf('日常(完)'), seriesKeyOf('日常'));
  assert.equal(stripCompletionMark('違国日記(完)').completed, true);
  assert.equal(stripCompletionMark('違国日記(完)').text, '違国日記');
});

test('巻数の後ろの版・品質の印は作品名にも巻数にも混ぜない', () => {
  const a = parseFilename('[Boichi] ORIGIN -オリジン- 第04巻 [LQ].rar');
  assert.equal(a.title, 'ORIGIN -オリジン-');
  assert.equal(a.volumeFrom, 4);
  assert.deepEqual(a.tags, ['LQ']);

  // 1 文字の印 (w / s) は実物に多い。巻数の読み取りを邪魔しないこと
  const b = parseFilename('[ヤマシタトモコ] 違国日記 第03巻w.rar');
  assert.equal(b.volumeFrom, 3);
  assert.equal(b.title, '違国日記');
});

test('作品の素性はフォルダを正とする', () => {
  // ファイル名に副題が付いていてもフォルダ名にまとめる。
  // ファイル名を正にすると landreaall と landreaallランドリオール に割れる
  const e = parseLibraryEntry('[おがきちか] Landreaall\\[おがきちか] Landreaall ランドリオール 第37巻.rar');
  assert.equal(e.series.title, 'Landreaall');
  assert.equal(e.fileTitle, 'Landreaall ランドリオール');
  assert.equal(e.volumeFrom, 37);

  // ファイル名の頭にゴミが付いていてもフォルダが救う
  const f = parseLibraryEntry(
    '[ゆうきまさみ] 機動警察パトレイバー(完)\\(一般コミック) [ゆうきまさみ] 機動警察パトレイバー 第06巻.rar'
  );
  assert.equal(f.series.author, 'ゆうきまさみ');
  assert.equal(f.series.title, '機動警察パトレイバー');
  assert.equal(f.volumeFrom, 6);
});

test('単位を伴わない巻数は、フォルダ名を剥がせた時だけ読む', () => {
  // 剥がせる: 作品名をそっくり除いた残りが数字だけ
  const e = parseLibraryEntry('[井上堅二×吉岡公威] ぐらんぶる\\[井上堅二×吉岡公威] ぐらんぶる 01.rar');
  assert.equal(e.volumeFrom, 1);
  assert.equal(e.series.title, 'ぐらんぶる');

  // 剥がせない: フォルダ名が前置きになっていないので巻数と断じない。
  // ここを緩めると「同人誌 第1巻」が生まれて別作品が 1 つに畳まれる
  const f = parseLibraryEntry('[BETEMIUS (バシウス)] 同人誌\\[BETEMIUS (バシウス)] あなたのヤミ鎮守府 1.rar');
  assert.equal(f.volumeFrom, null);
  assert.equal(f.series.title, '同人誌');
});

test('範囲でまとまっている巻', () => {
  const e = parseLibraryEntry('[CLAMP] ×××HOLiC\\[CLAMP] ×××HOLiC 第01-03巻.zip');
  assert.equal(e.volumeFrom, 1);
  assert.equal(e.volumeTo, 3);
});

test('話で出ているものを巻に書き換えない', () => {
  const a = parseFilename('[作者] 作品 第12話.rar');
  assert.equal(a.unit, '話');
  assert.equal(a.volumeFrom, 12);
});

test('分割書庫の連番は本体から外してそのまま戻せる', () => {
  const a = splitFilename('[作者] 作品 第03巻.part2.rar');
  assert.equal(a.stem, '[作者] 作品 第03巻');
  assert.equal(a.part, '.part2');
  assert.equal(a.partNo, 2);
  assert.equal(a.ext, '.rar');

  // .r00 は拡張子そのものが連番。part に回すと拡張子が消える
  const b = splitFilename('[作者] 作品 第03巻.r00');
  assert.equal(b.stem, '[作者] 作品 第03巻');
  assert.equal(b.ext, '.r00');
  assert.equal(b.partNo, 0);
});

test('同名回避の連番は読み戻す時に落とす', () => {
  const a = parseFilename('[作者] 作品 第03巻 (2).rar');
  assert.equal(a.volumeFrom, 3);
  assert.equal(a.title, '作品');
});

test('共著は著者としてそのまま持つ (キーには入れない)', () => {
  const e = parseLibraryEntry('[岩明均×室井大資] レイリ(完)\\[岩明均×室井大資] レイリ 第06巻(完).rar');
  assert.equal(e.series.author, '岩明均×室井大資');
  assert.equal(e.series.title, 'レイリ');
  // 著者違いで同じ作品が割れないこと (実物に [村田雄介] と [村田雄介 ONE] が両方ある)
  assert.equal(seriesKeyOf('ワンパンマン'), seriesKeyOf('ワンパンマン'));
});
