import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  byVolumeOf, groupCandidates, imageCandidatesOf, ndlCandidate, splitCandidateTitle, type Candidate,
} from './candidates.js';
import type { NdlRecord } from './ndl.js';

/**
 * ここに並んでいるのは全部 **NDL と楽天が実際に返してきた形**。
 * `title=血界戦線 creator=内藤泰弘` の応答をそのまま写してある (2026-09-15 に実測)。
 *
 * この束ね方が崩れると、手元の蔵書が無印なのに棚へ Back 2 Back の表紙が並ぶ
 * — この機能が直しに来たまさにその壊れ方に戻る。
 */

test('楽天の書名から副題と巻を落とす', () => {
  assert.deepEqual(splitCandidateTitle('血界戦線 Back 2 Back 3 -深夜大戦ーDead of night warfare'), {
    base: '血界戦線 Back 2 Back',
    volume: 3,
  });
  assert.deepEqual(splitCandidateTitle('血界戦線 8 ─幻界病棟ライゼズ─'), { base: '血界戦線', volume: 8 });
  assert.deepEqual(splitCandidateTitle('血界戦線 Beat 3 Peat 1 -崩落都市2.99-'), {
    base: '血界戦線 Beat 3 Peat',
    volume: 1,
  });
});

test('括弧書きの巻。副題より先に見る', () => {
  assert.deepEqual(splitCandidateTitle('血界戦線（10）'), { base: '血界戦線', volume: 10 });
  // 全角空白でシリーズ名が区切られている実物。括弧の外は触らない
  assert.deepEqual(splitCandidateTitle('血界戦線Back　2　Back（1）'), {
    base: '血界戦線Back　2　Back',
    volume: 1,
  });
  assert.deepEqual(splitCandidateTitle('ヒストリエ 第10巻'), { base: 'ヒストリエ', volume: 10 });
});

test('巻の書かれていない書名はそのまま', () => {
  assert.deepEqual(splitCandidateTitle('血界戦線 : 魔封街結社'), {
    base: '血界戦線 : 魔封街結社',
    volume: null,
  });
  assert.deepEqual(splitCandidateTitle('よつばと!'), { base: 'よつばと!', volume: null });
});

test('裸の数字は前に空白がある時だけ巻と読む', () => {
  // **書名にくっついた数字を巻にしない。** ここを緩めると作品名が削れる
  assert.deepEqual(splitCandidateTitle('ゾン100'), { base: 'ゾン100', volume: null });
  assert.deepEqual(splitCandidateTitle('20世紀少年'), { base: '20世紀少年', volume: null });
});

/** NDL の item を 1 つ作る。書誌の他の欄はこの束ね方に効かない */
function ndl(title: string, volume: number | null, date: string, isbn: string | null): Candidate {
  return ndlCandidate({
    title,
    volumeRaw: volume === null ? null : String(volume),
    volume,
    creator: '内藤, 泰弘',
    publisher: '集英社',
    date,
    isbn,
    link: null,
  } satisfies NdlRecord);
}

/** 実測の応答から、束ね方に効く行だけを写したもの */
const KEKKAI: Candidate[] = [
  ndl('血界戦線 : オンリー・ア・ペイパームーン', null, '2015.6', '9784087033663'),
  ndl('血界戦線 : 魔封街結社', 1, '2010.1', '9784088747231'),
  ndl('血界戦線', 2, '2010.11', '9784088701097'),
  ndl('血界戦線', 4, '2011.12', '9784088703398'),
  ndl('血界戦線', 10, '2015.4', '9784088802336'),
  ndl('血界戦線Back 2 Back', 1, '2016.1', '9784088805429'),
  ndl('血界戦線Back 2 Back', 3, '2017.9', '9784088811741'),
  ndl('血界戦線Back 2 Back', 10, '2022.8', '9784088832029'),
  ndl('血界戦線back 2 back', 5, '2018.7', '9784089083161'),
  ndl('血界戦線Beat 3 Peat', 1, '2023.7', '9784088835716'),
  ndl('血界戦線Beat 3 Peat', 4, '2026.7', '9784088850818'),
];

test('提供元をまたいで 1 つの束にする', () => {
  // **NDL と楽天を別々の束に割らない。** 同じシリーズを 2 回見せられた上に
  // どちらかを選ばされることになるし、片方にしか無い巻がある
  const groups = groupCandidates([
    ...KEKKAI,
    { ...KEKKAI[2], provider: 'rakuten' as const, title: '血界戦線（2）', baseTitle: '血界戦線' },
  ]);
  const plain = groups.find((g) => g.title === '血界戦線')!;
  assert.deepEqual(plain.providers, ['ndl', 'rakuten']);
});

test('並走するシリーズを別々の束にする', () => {
  const groups = groupCandidates(KEKKAI);
  const titles = groups.map((g) => g.title);
  assert.ok(titles.includes('血界戦線'), '無印の束が無い');
  assert.ok(titles.includes('血界戦線Back 2 Back'), 'Back 2 Back の束が無い');
  assert.ok(titles.includes('血界戦線Beat 3 Peat'), 'Beat 3 Peat の束が無い');

  const b2b = groups.find((g) => g.title === '血界戦線Back 2 Back')!;
  // 大小の違うだけの版 (back 2 back) は同じ束に入る
  assert.deepEqual(b2b.volumes, [1, 3, 5, 10]);
});

test('巻ごとの副題は無印の束へ畳む', () => {
  const groups = groupCandidates(KEKKAI);
  const plain = groups.find((g) => g.title === '血界戦線')!;
  // 魔封街結社 = 無印の第1巻。NDL は巻ごとの副題を書名へ差し込むことがある
  assert.deepEqual(plain.volumes, [1, 2, 4, 10]);
  assert.equal(plain.items.find((x) => x.volume === 1)?.isbn, '9784088747231');
  // 巻を持たない愛蔵版も同じ束に入る (作品としては血界戦線なので)
  assert.ok(plain.items.some((x) => x.title.includes('オンリー・ア・ペイパームーン')));
});

test('第3巻を Back 2 Back に取られない', () => {
  // **この機能が直しに来た壊れ方そのもの。**
  // 束を分けないと、2011年の無印3巻の椅子を 2017年の Back 2 Back 3巻が取る
  const groups = groupCandidates(KEKKAI);
  const plain = groups.find((g) => g.title === '血界戦線')!;
  assert.ok(!plain.items.some((x) => x.title.includes('Back 2 Back')), '無印の束に Back 2 Back が混ざっている');
});

test('巻の揃っている束を先に出す', () => {
  const groups = groupCandidates(KEKKAI);
  // 人が最初に見るのは「一番冊数の並んでいる方」であってほしい
  assert.ok(groups[0].volumes.length >= groups[groups.length - 1].volumes.length);
});

test('副題が複数の冊に出るなら別シリーズとして残す', () => {
  // ふしぎ遊戯 玄武開伝のような本物のサブシリーズは畳まない。
  // **巻ごとの副題は 1 冊にしか出ない。別シリーズなら何冊も並ぶ** で切っている
  const items = [
    ndl('ふしぎ遊戯', 1, '1992.7', '9784091360212'),
    ndl('ふしぎ遊戯', 2, '1993.1', '9784091360229'),
    ndl('ふしぎ遊戯 : 玄武開伝', 1, '2004.5', '9784091380319'),
    ndl('ふしぎ遊戯 : 玄武開伝', 2, '2005.3', '9784091380326'),
  ];
  const groups = groupCandidates(items);
  assert.equal(groups.length, 2);
  assert.ok(groups.some((g) => g.title === 'ふしぎ遊戯 : 玄武開伝'));
});

test('束の著者は多数決で 1 つに決める', () => {
  // 巻によって著者の書き方が揺れる。**著者だけで引いた時の見分けに使う**ので、
  // 一番多く出てきた書き方に落ち着かせる
  const groups = groupCandidates([
    ...KEKKAI,
    { ...KEKKAI[2], provider: 'rakuten' as const, title: '血界戦線（2）', author: '内藤泰弘' },
  ]);
  const plain = groups.find((g) => g.title === '血界戦線')!;
  assert.equal(plain.author, '内藤, 泰弘');
});

/**
 * ARMS で実際に返ってきた形 (2026-09-17)。同じ巻に初版と新装版が 3 つ並ぶ。
 *
 * **初版には NDL のサムネイルが無い。** ISBN があるので書影 URL は付くが、
 * 取りに行くと 404 で、絵を持っているのは 2007年と2014年の新装版の方だった。
 */
const ARMS: Candidate[] = [
  ndl('Arms', 1, '1997.11', '4091248810'),
  ndl('Arms', 1, '2007.6', '9784091214126'),
  ndl('ARMS', 1, '2014.4', '9784091264831'),
  ndl('Arms', 2, '1998.2', '4091248829'),
  ndl('Arms', 16, '2001.4', '4091248969'),
];

test('巻の絵の候補は束にある版を全部出す', () => {
  // **1 冊で打ち切らない。** 書誌に採るのは初版 (pickVolume) だが、
  // 絵はその版が持っているとは限らない。打ち切ると束の外から知らない絵が焼かれる
  const group = groupCandidates(ARMS)[0];
  assert.deepEqual(imageCandidatesOf(group, 1).map((c) => c.date), ['1997.11', '2007.6', '2014.4']);
  // 書誌の正はあくまで初版のまま
  assert.equal(byVolumeOf(group).get(1)?.date, '1997.11');
});

test('巻の絵の候補は古い順。画面に並んでいるのと同じ順で試す', () => {
  const group = groupCandidates(ARMS)[0];
  // 画面 (pk-items) は group.items をそのまま並べる。焼く順もそれに合わせる
  const shown = group.items.filter((c) => c.volume === 1).map((c) => c.date);
  assert.deepEqual(imageCandidatesOf(group, 1).map((c) => c.date), shown);
});

test('書影 URL の無い候補は絵の候補に出さない', () => {
  // ISBN の無い記録には書影 URL が付かない。取りに行く先が無いので数えない
  const group = groupCandidates([...ARMS, ndl('Arms', 16, '2015.7', null)])[0];
  assert.deepEqual(imageCandidatesOf(group, 16).map((c) => c.date), ['2001.4']);
});

test('巻を指定しなければ束の絵を全部出す', () => {
  // 代表表紙を探す時の道。巻の絵が 1 枚も焼けなかった作品でここを使う
  const group = groupCandidates(ARMS)[0];
  assert.equal(imageCandidatesOf(group, null).length, ARMS.length);
});
