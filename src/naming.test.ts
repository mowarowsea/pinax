import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFilename, parseLibraryEntry, planVolumeName, splitFilename } from './naming.js';
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

test('巻として読めなかったファイルは、フォルダ名を剥がした残りを別巻の呼び名として読む', () => {
  const a = parseLibraryEntry('[吾峠呼世晴] 鬼滅の刃(完)\\[吾峠呼世晴] 鬼滅の刃 外伝.rar');
  assert.equal(a.volumeFrom, null);
  assert.equal(a.sideLabel, '外伝');

  const b = parseLibraryEntry('[新川直司] 四月は君の嘘\\[新川直司] 四月は君の嘘 Coda.rar');
  assert.equal(b.sideLabel, 'Coda');

  const c = parseLibraryEntry('[緑のルーペ] 青春のアフター(完)\\[緑のルーペ] 青春のアフター IF.rar');
  assert.equal(c.sideLabel, 'IF');
});

test('別巻の呼び名は、区切りが _ でも著者が無くても読む', () => {
  // ファイル名の方に [著者] が付いていない。フォルダには付いている
  const a = parseLibraryEntry(
    '[殆ど死んでいる] 異世界おじさん\\異世界おじさん_「メガドライブ_ミニ」発売記念特別編.rar'
  );
  assert.equal(a.sideLabel, '「メガドライブ ミニ」発売記念特別編');

  const b = parseLibraryEntry('[宮原るり] 恋愛ラボ(完)\\[宮原るり]_恋愛ラボ_～恋愛研究レポート～.rar');
  assert.equal(b.sideLabel, '~恋愛研究レポート~');
});

test('別巻の呼び名は、空白の入れ方と大文字小文字が食い違っても読む', () => {
  const e = parseLibraryEntry('[広江礼威] BLACK LAGOON\\[広江礼威] Black Lagoon Phantom Bullet.rar');
  assert.equal(e.sideLabel, 'Phantom Bullet');
});

test('フォルダ名と同じ名前のファイルは、作品そのもの (呼び名は空)', () => {
  const e = parseLibraryEntry('[尾崎かおり] 神様がうそをつく。\\[尾崎かおり] 神様がうそをつく。.zip');
  assert.equal(e.volumeFrom, null);
  // null (読めなかった) ではなく空文字。1 冊で完結している作品なので要確認にしない
  assert.equal(e.sideLabel, '');
});

test('フォルダ名が前置きになっていなければ別巻にしない', () => {
  const e = parseLibraryEntry('[BETEMIUS (バシウス)] 同人誌\\[BETEMIUS (バシウス)] 夕立の手紙.rar');
  assert.equal(e.sideLabel, null);
});

test('残りに数字が混じるものは別巻に格上げしない', () => {
  // c48-49 は話数の読み落とし。別巻にすると要確認が下りて、直す機会まで消える
  const e = parseLibraryEntry(
    '[鳥羽徹xえむだ] そうだ、売国しよう～天才王子の赤字国家再生術～\\'
      + '[鳥羽徹×えむだ] そうだ、売国しよう ～天才王子の赤字国家再生術～c48-49.rar'
  );
  assert.equal(e.volumeFrom, null);
  assert.equal(e.sideLabel, null);
});

test('巻として読めたファイルに別巻の呼び名は付かない', () => {
  const e = parseLibraryEntry('[つくしあきひと] メイドインアビス\\[つくしあきひと] メイドインアビス 第01巻.rar');
  assert.equal(e.volumeFrom, 1);
  assert.equal(e.sideLabel, null);
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

/**
 * 棚にまだ無い作品へ渡す名前。**実物と一字一句同じ形が出ること**だけを見ている。
 * ここがずれた名前を渡すと、人がそのとおりに付け替えた後で棚が拾えない。
 */
test('これから付ける巻のファイル名', () => {
  // \\192.168.3.30\disk1_pt1\manga にある実物
  assert.equal(planVolumeName('ヤマシタトモコ', '違国日記', 1, 1), '[ヤマシタトモコ] 違国日記 第01巻');
  assert.equal(planVolumeName('ヤマシタトモコ', '違国日記', 11, 11, { completed: true }),
    '[ヤマシタトモコ] 違国日記 第11巻(完)');
  assert.equal(planVolumeName('小川麻衣子', 'ひとりぼっちの地球侵略', 1, 3),
    '[小川麻衣子] ひとりぼっちの地球侵略 第01-03巻');
  // 著者が無ければ [] も出さない (フォルダ名と同じ決まり)
  assert.equal(planVolumeName(null, '同人誌', 2, 2), '同人誌 第02巻');
  assert.equal(planVolumeName('あずまきよひこ', 'よつばと!', 15, 15, { unit: '話' }),
    '[あずまきよひこ] よつばと! 第15話');
});

test('完結マークは巻の後ろに 1 つだけ', () => {
  // 作品名に既に (完) が入っていても二重にしない。フォルダ名から写してくると起きる
  assert.equal(planVolumeName('あらゐけいいち', '日常(完)', 10, 10, { completed: true }),
    '[あらゐけいいち] 日常 第10巻(完)');
  // 付けた名前を読み戻せること。ここが噛み合わないと棚に入れた瞬間に別物になる
  const e = parseFilename(planVolumeName('藤田和日郎', 'からくりサーカス', 43, 43, { completed: true }) + '.rar');
  assert.equal(e.author, '藤田和日郎');
  assert.equal(e.title, 'からくりサーカス');
  assert.equal(e.volumeFrom, 43);
  assert.equal(e.completed, true);
});

test('使えない文字は倒す。作品名が無ければ名前も無い', () => {
  // Windows がファイル名に使えない文字は消さずに全角へ (情報を落とさない)
  assert.equal(planVolumeName('CLAMP', 'ちょびっツ?', 1, 1), '[CLAMP] ちょびっツ？ 第01巻');
  assert.equal(planVolumeName('誰か', '   ', 1, 1), null);
  assert.equal(planVolumeName('誰か', '(完)', 1, 1), null);
});
