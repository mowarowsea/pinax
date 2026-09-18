import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Db } from './db.js';
import { checkOwned, getSeriesDetail, holdingsOf, issuesOf, listSeries } from './catalog.js';
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

// ---- 完結の指定 -----------------------------------------------------------

test('完結の指定は人が勝つ。フォルダの印は書き換えない', () => {
  const id = seed('[人] 継続中の作品', '継続中の作品', '人', [[1, 1, '巻']]);
  assert.equal(db.getSeries(id)!.completed, false);

  db.setCompletedOverride(id, true);
  const after = db.getSeries(id)!;
  assert.equal(after.completed, true);
  assert.equal(after.completedBy, 'user');
  // フォルダ由来は触っていない。ここを書き換えると次のスキャンで指定が消える
  assert.equal(after.folderCompleted, false);
});

test('完結の指定はスキャンで踏み潰されない', () => {
  const id = seed('[人] 指定を守る作品', '指定を守る作品', '人', [[1, 1, '巻']]);
  db.setCompletedOverride(id, true);
  // 同じフォルダをもう一度読む (印は付いていないまま)
  db.upsertSeries({
    rootId: 'test', folder: '[人] 指定を守る作品', seriesKey: seriesKeyOf('指定を守る作品'),
    title: '指定を守る作品', author: '人', completed: false,
  });
  assert.equal(db.getSeries(id)!.completed, true);
});

test('フォルダに (完) がある作品を「継続中」に倒せる', () => {
  // 新装版が出た作品など。フォルダの印を消して回るより、人が言い直せる方を上に置く
  const { row } = db.upsertSeries({
    rootId: 'test', folder: '[人] 完結していた作品(完)', seriesKey: seriesKeyOf('完結していた作品'),
    title: '完結していた作品', author: '人', completed: true,
  });
  assert.equal(row.completed, true);
  db.setCompletedOverride(row.id, false);
  const after = db.getSeries(row.id)!;
  assert.equal(after.completed, false);
  assert.equal(after.completedBy, null);
  assert.equal(after.folderCompleted, true);

  // null で指定を外せばフォルダの答えへ戻る
  db.setCompletedOverride(row.id, null);
  assert.equal(db.getSeries(row.id)!.completed, true);
  assert.equal(db.getSeries(row.id)!.completedBy, 'folder');
});

test('完結の絞り込みは指定を見る (生の completed ではない)', () => {
  const { row } = db.upsertSeries({
    rootId: 'issue', folder: '[人] 手で完結にした作品', seriesKey: seriesKeyOf('手で完結にした作品'),
    title: '手で完結にした作品', author: '人', completed: false,
  });
  db.upsertVolume({ seriesId: row.id, volumeFrom: 1, volumeTo: 1, unit: '巻', completed: false });
  db.setCompletedOverride(row.id, true);

  const done = listSeries(db, { rootId: 'issue', completed: true, limit: 100 });
  assert.ok(done.items.some((i) => i.id === row.id), '完結の絞り込みに出てこない');
  const ongoing = listSeries(db, { rootId: 'issue', completed: false, limit: 100 });
  assert.ok(!ongoing.items.some((i) => i.id === row.id), '継続中の絞り込みに出てしまう');
});

// ---- 棚の整合性 (巻の重複・巻数不明) --------------------------------------

/**
 * 蔵書の 1 ファイルを置く。相対パスは実物と同じ `フォルダ\ファイル名` の形にする。
 * 別巻の呼び名は実際にはスキャンが naming.ts から書くが、ここでは直に渡す
 */
function file(
  seriesId: number, volumeId: number | null, name: string,
  part = '', partNo: number | null = null, sideLabel: string | null = null
): void {
  const folder = db.getSeries(seriesId)!.folder;
  const relPath = `${folder}${path.sep}${name}`;
  db.upsertFile({
    rootId: 'issue', relPath, seriesId, volumeId, size: 1, mtime: null,
    ext: name.slice(name.lastIndexOf('.')), part, partNo, sideLabel, tags: [],
  });
}

test('同じ巻に別々のファイルがあれば重複として数える', () => {
  const { row: s } = db.upsertSeries({
    rootId: 'issue', folder: '[人] 重複作品', seriesKey: seriesKeyOf('重複作品'),
    title: '重複作品', author: '人', completed: false,
  });
  const { row: v } = db.upsertVolume({ seriesId: s.id, volumeFrom: 1, volumeTo: 1, unit: '巻', completed: false });
  file(s.id, v.id, '[人] 重複作品 第01巻.rar');
  file(s.id, v.id, '[人] 重複作品 副題つき 第01巻.zip');

  const is = issuesOf(db, s.id);
  assert.equal(is.duplicateVolumes, 1);
  assert.equal(is.duplicateFiles, 1);
  assert.equal(is.any, true);
});

test('分割書庫の続きは重複ではない', () => {
  // .part1 / .part2 も .rar + .r00 も 1 巻 1 本。ここを重複と言うと本物が埋もれる
  const { row: s } = db.upsertSeries({
    rootId: 'issue', folder: '[人] 分割作品', seriesKey: seriesKeyOf('分割作品'),
    title: '分割作品', author: '人', completed: false,
  });
  const { row: v1 } = db.upsertVolume({ seriesId: s.id, volumeFrom: 1, volumeTo: 1, unit: '巻', completed: false });
  file(s.id, v1.id, '[人] 分割作品 第01巻.part1.rar', '.part1', 1);
  file(s.id, v1.id, '[人] 分割作品 第01巻.part2.rar', '.part2', 2);

  const { row: v2 } = db.upsertVolume({ seriesId: s.id, volumeFrom: 2, volumeTo: 2, unit: '巻', completed: false });
  file(s.id, v2.id, '[人] 分割作品 第02巻.rar');
  file(s.id, v2.id, '[人] 分割作品 第02巻.r00', '', 0);
  file(s.id, v2.id, '[人] 分割作品 第02巻.r01', '', 1);

  const is = issuesOf(db, s.id);
  assert.equal(is.duplicateVolumes, 0);
  assert.equal(is.any, false);
});

test('巻数を読めなかったファイルは要確認に上がる', () => {
  const { row: s } = db.upsertSeries({
    rootId: 'issue', folder: '[人] 読めない作品', seriesKey: seriesKeyOf('読めない作品'),
    title: '読めない作品', author: '人', completed: false,
  });
  const { row: v } = db.upsertVolume({ seriesId: s.id, volumeFrom: 1, volumeTo: 1, unit: '巻', completed: false });
  file(s.id, v.id, '[人] 読めない作品 第01巻.rar');
  file(s.id, null, 'おまけ.rar');

  const is = issuesOf(db, s.id);
  assert.equal(is.unreadableFiles, 1);
  assert.equal(is.duplicateVolumes, 0);
  assert.equal(is.any, true);
});

test('別巻 (外伝) は要確認に上げない', () => {
  // 鬼滅の刃 外伝 に巻数が無いのは正しい。ここを要確認にすると 19 作品の印が
  // 一生下りず、要確認そのものが読み飛ばされる目印になる
  const { row: s } = db.upsertSeries({
    rootId: 'issue', folder: '[人] 外伝のある作品', seriesKey: seriesKeyOf('外伝のある作品'),
    title: '外伝のある作品', author: '人', completed: false,
  });
  const { row: v } = db.upsertVolume({ seriesId: s.id, volumeFrom: 1, volumeTo: 1, unit: '巻', completed: false });
  file(s.id, v.id, '[人] 外伝のある作品 第01巻.rar');
  file(s.id, null, '[人] 外伝のある作品 外伝.rar', '', null, '外伝');

  const is = issuesOf(db, s.id);
  assert.equal(is.unreadableFiles, 0);
  assert.equal(is.any, false);
  // 一覧の数え方も同じであること。SQL が 2 箇所あるので両方を踏む
  const listed = listSeries(db, { rootId: 'issue', limit: 200 }).items.find((i) => i.id === s.id)!;
  assert.equal(listed.looseFiles, 0);
  assert.equal(listed.issues.any, false);
});

test('別巻は呼び名でまとめて出す。分割書庫があっても 1 行', () => {
  const { row: s } = db.upsertSeries({
    rootId: 'issue', folder: '[人] 別巻の多い作品', seriesKey: seriesKeyOf('別巻の多い作品'),
    title: '別巻の多い作品', author: '人', completed: false,
  });
  const { row: v } = db.upsertVolume({ seriesId: s.id, volumeFrom: 1, volumeTo: 1, unit: '巻', completed: false });
  file(s.id, v.id, '[人] 別巻の多い作品 第01巻.rar');
  file(s.id, null, '[人] 別巻の多い作品 外伝.part1.rar', '.part1', 1, '外伝');
  file(s.id, null, '[人] 別巻の多い作品 外伝.part2.rar', '.part2', 2, '外伝');
  file(s.id, null, '[人] 別巻の多い作品.rar', '', null, '');
  file(s.id, null, 'なにもわからない.rar');

  const d = getSeriesDetail(db, s.id)!;
  // 作品そのもの (呼び名が空) が先頭、その後に呼び名つき
  assert.deepEqual(d.side.map((x) => x.label), ['', '外伝']);
  assert.equal(d.side[1].files.length, 2);
  // 欠番には効かせない。第01巻しか持っていないまま
  assert.deepEqual(d.holdings[0].owned, [1]);
  // 読めなかったものだけが loose に残る
  assert.equal(d.loose.length, 1);
  assert.ok(d.loose[0].relPath.endsWith('なにもわからない.rar'));
});

test('要確認の絞り込みは総数にも効く', () => {
  // gapsOnly のように後から篩うと「49 件」と出して 60 件並ぶ、という食い違いになる
  const any = listSeries(db, { rootId: 'issue', issues: 'any', limit: 100 });
  assert.equal(any.total, any.items.length);
  assert.ok(any.items.every((i) => i.issues.any));

  const dup = listSeries(db, { rootId: 'issue', issues: 'dup', limit: 100 });
  assert.ok(dup.items.every((i) => i.issues.duplicateVolumes > 0));
  const loose = listSeries(db, { rootId: 'issue', issues: 'loose', limit: 100 });
  assert.ok(loose.items.every((i) => i.issues.unreadableFiles > 0));
  assert.ok(dup.total < any.total && loose.total < any.total, '重複と巻数不明が同じ集合になっている');
});

// ---- 並び ------------------------------------------------------------------

test('更新が新しい順は「最後に巻が増えた日」で並ぶ', () => {
  /**
   * **「登録が新しい順」とは別物。** 何年も前から棚にある作品でも、
   * 続きを買い足した日が新しければこちらでは上に来る。
   * この 2 つが同じ並びになるなら、片方は要らない
   */
  const early = seed('[あ] 昔から棚にある作品', '昔から棚にある作品', 'あ', [[1, 1, '巻'], [2, 2, '巻']]);
  const late = seed('[い] 昨日入れた作品', '昨日入れた作品', 'い', [[1, 1, '巻']]);
  const at = (t: string, id: number) =>
    db.raw.prepare('UPDATE series SET first_seen_at = ? WHERE id = ?').run(t, id);
  const volAt = (t: string, id: number, from: number) =>
    db.raw.prepare('UPDATE volumes SET first_seen_at = ? WHERE series_id = ? AND volume_from = ?').run(t, id, from);

  at('2020-01-01T00:00:00.000Z', early);
  at('2026-09-01T00:00:00.000Z', late);
  volAt('2020-01-01T00:00:00.000Z', early, 1);
  volAt('2026-09-14T00:00:00.000Z', early, 2); // 昨日、続きが出て買い足した
  volAt('2026-09-01T00:00:00.000Z', late, 1);

  const pos = (r: ReturnType<typeof listSeries>, id: number) => r.items.findIndex((i) => i.id === id);

  const added = listSeries(db, { sort: 'added', limit: 500 });
  assert.ok(pos(added, late) < pos(added, early), '登録順で新しく登録した方が下にいる');

  const updated = listSeries(db, { sort: 'updated', limit: 500 });
  assert.ok(pos(updated, early) < pos(updated, late), '巻を足した方が上に来ていない');
  assert.equal(updated.items[pos(updated, early)].volumeAddedAt, '2026-09-14T00:00:00.000Z');
});

test('巻を 1 つも読めない作品は作品の登録日で並ぶ', () => {
  // **null のまま並べると SQLite では一番後ろに沈む。** 巻数の読めないファイルしか
  // 持っていない作品が、この並びから消えたように見えてしまう
  const loose = seed('[う] 巻の読めない作品', '巻の読めない作品', 'う', []);
  // 他の作品は「今」で登録されているので、確実に新しい日付を置く
  db.raw.prepare('UPDATE series SET first_seen_at = ? WHERE id = ?').run('2099-01-01T00:00:00.000Z', loose);

  const updated = listSeries(db, { sort: 'updated', limit: 500 });
  assert.equal(updated.items[0].id, loose);
  assert.equal(updated.items[0].volumeAddedAt, '2099-01-01T00:00:00.000Z');
});

test('合本の板には、覆う巻のうち一番若い巻の表紙を出す', () => {
  // 第01-06巻 は 1 つの板に畳まれるので、置ける絵は 1 枚。第01巻の絵が素直。
  // 単巻 (from = to) に限っていた頃は、合本でしか持っていない巻が絵無しで残った
  const id = seed('[武論尊×原哲夫] 北斗の拳', '北斗の拳', '武論尊×原哲夫', [[1, 6, '巻']]);
  db.raw.prepare(
    `INSERT INTO covers (series_id, volume_no, provider, file, bytes, pinned, created_at)
     VALUES (?, 2, 'rakuten', 'v2.jpg', 1, 1, '2026-01-01')`
  ).run(id);

  const d = getSeriesDetail(db, id)!;
  const bundle = d.volumes.find((v) => v.volumeFrom === 1 && v.volumeTo === 6)!;
  assert.ok(bundle.coverUrl, '合本にも絵が付く');
  assert.equal(bundle.coverPinned, false, '「選」の印は立てない — 合本からは選び直せない');

  // 第01巻の絵が入ったら、そちらが勝つ (一番若い巻)
  db.raw.prepare(
    `INSERT INTO covers (series_id, volume_no, provider, file, bytes, created_at)
     VALUES (?, 1, 'rakuten', 'v1.jpg', 1, '2026-01-01')`
  ).run(id);
  const first = db.raw.prepare('SELECT id FROM covers WHERE series_id = ? AND volume_no = 1').get(id) as { id: number };
  const d2 = getSeriesDetail(db, id)!;
  const bundle2 = d2.volumes.find((v) => v.volumeFrom === 1 && v.volumeTo === 6)!;
  assert.equal(bundle2.coverUrl, `/api/covers/${first.id}`);
});
