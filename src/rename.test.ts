import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Db } from './db.js';
import type { LibraryRoot } from './config.js';
import { parseLibraryEntry, planFolderName } from './naming.js';
import { planRename, applyRename, RenameError } from './rename.js';
import { seriesKeyOf } from './volume.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinax-rename-'));
fs.mkdirSync(path.join(dir, 'covers'), { recursive: true });
const shelf = path.join(dir, 'shelf');
fs.mkdirSync(shelf, { recursive: true });
const db = new Db(dir);
const root: LibraryRoot = { id: 'test', label: 'テスト棚', path: shelf, kind: 'shelf' };

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 棚に実物のフォルダとファイルを置き、カタログにも起こす */
function seed(folder: string, title: string, author: string | null, files: string[]): number {
  fs.mkdirSync(path.join(shelf, folder), { recursive: true });
  const { row } = db.upsertSeries({
    rootId: root.id, folder, seriesKey: seriesKeyOf(title), title, author, completed: false,
  });
  for (const name of files) {
    fs.writeFileSync(path.join(shelf, folder, name), 'x');
    const v = db.upsertVolume({ seriesId: row.id, volumeFrom: 1, volumeTo: 1, unit: '巻', completed: false });
    db.upsertFile({
      rootId: root.id, relPath: path.join(folder, name), seriesId: row.id, volumeId: v.row.id,
      size: 1, mtime: null, ext: '.rar', part: '', partNo: null, sideLabel: null, tags: [],
    });
  }
  return row.id;
}

test('完結を指定するとフォルダ名に (完) が付く', () => {
  assert.equal(planFolderName('岩原裕二', 'いばらの王', true), '[岩原裕二] いばらの王(完)');
  assert.equal(planFolderName('岩原裕二', 'いばらの王', false), '[岩原裕二] いばらの王');
  // 著者が無ければ [] は作らない
  assert.equal(planFolderName(null, '同人誌', false), '同人誌');
});

test('作品名に (完) が混ざっていても印は二重にならない', () => {
  // 完結を言うのは引数ひとつ。名前の中の印と二重になると (完)(完) が出来る
  assert.equal(planFolderName('CLAMP', 'カードキャプターさくら(完)', true), '[CLAMP] カードキャプターさくら(完)');
});

test('作品名を直すと series.id が変わらない — 表紙も選択も残る', async () => {
  const id = seed('[天空すふぃあ] ブルータル 異世界で邪神の力を手に入れた', 'ブルータル 異世界で邪神の力を手に入れた', '天空すふぃあ',
    ['[天空すふぃあ] ブルータル 異世界で邪神の力を手に入れた 第01巻.rar']);
  // 焼いた表紙と選んだ系列がぶら下がっている状態を作る
  db.raw.prepare(
    `INSERT INTO covers (series_id, volume_no, provider, file, bytes, created_at)
     VALUES (?, NULL, 'ndl', 'x.jpg', 1, '2026-01-01')`
  ).run(id);

  const plan = planRename(db, root, id, { title: 'ブルターニュ花嫁異聞', author: '天空すふぃあ', completed: false });
  assert.equal(plan.to, '[天空すふぃあ] ブルターニュ花嫁異聞');
  assert.equal(plan.noop, false);
  assert.deepEqual(plan.warnings, []);

  await applyRename(db, root, plan, dir);

  const s = db.getSeries(id)!;
  assert.equal(s.id, id, 'id が変わると表紙も選択も孤児になる');
  assert.equal(s.folder, '[天空すふぃあ] ブルターニュ花嫁異聞');
  assert.equal(s.title, 'ブルターニュ花嫁異聞');
  assert.equal(s.seriesKey, seriesKeyOf('ブルターニュ花嫁異聞'));
  const covers = db.raw.prepare('SELECT COUNT(*) AS n FROM covers WHERE series_id = ?').get(id) as { n: number };
  assert.equal(Number(covers.n), 1, '表紙は付いたまま');

  // 実物のフォルダも動いている
  assert.ok(fs.existsSync(path.join(shelf, '[天空すふぃあ] ブルターニュ花嫁異聞')));
  assert.ok(!fs.existsSync(path.join(shelf, '[天空すふぃあ] ブルータル 異世界で邪神の力を手に入れた')));
});

test('ファイル名も rel_path も一緒に付け替わる — 棚の実物が古い名前で残らない', () => {
  const folder = '[天空すふぃあ] ブルターニュ花嫁異聞';
  const file = '[天空すふぃあ] ブルターニュ花嫁異聞 第01巻.rar';
  const rows = db.raw
    .prepare("SELECT rel_path FROM files WHERE rel_path LIKE '%ブル%'")
    .all() as { rel_path: string }[];
  assert.equal(rows.length, 1);
  // 次のスキャンで「消えた + 増えた」に倒さないために rel_path が追う
  assert.equal(rows[0].rel_path, path.join(folder, file));
  // 実物も同じ名前になっている。ここを置き去りにすると棚と画面が食い違う
  assert.ok(fs.existsSync(path.join(shelf, folder, file)));
  assert.ok(!fs.existsSync(path.join(shelf, folder, '[天空すふぃあ] ブルータル 異世界で邪神の力を手に入れた 第01巻.rar')));
});

test('完結を書き出すと completed_user は外れる', async () => {
  const id = seed('[井上雄彦] スラムダンク', 'スラムダンク', '井上雄彦', ['[井上雄彦] スラムダンク 第01巻.rar']);
  db.setCompletedOverride(id, true);
  assert.equal(db.getSeries(id)!.completedUser, true);

  const plan = planRename(db, root, id, { title: 'スラムダンク', author: '井上雄彦', completed: true });
  assert.equal(plan.to, '[井上雄彦] スラムダンク(完)');
  await applyRename(db, root, plan, dir);

  const s = db.getSeries(id)!;
  assert.equal(s.folderCompleted, true, 'フォルダ由来の完結が立つ');
  assert.equal(s.completedUser, null, 'フォルダに書いた以上、逃げ道は要らない');
  assert.equal(s.completed, true);
  assert.equal(s.completedBy, 'folder');
});

test('完結を外す向きの付け替えも効く — スキャン任せでは倒れない', async () => {
  const id = seed('[x] 打ち切られた漫画(完)', '打ち切られた漫画', 'x', ['[x] 打ち切られた漫画 第01巻.rar']);
  db.raw.prepare('UPDATE series SET completed = 1 WHERE id = ?').run(id);

  const plan = planRename(db, root, id, { title: '打ち切られた漫画', author: 'x', completed: false });
  assert.equal(plan.to, '[x] 打ち切られた漫画');
  await applyRename(db, root, plan, dir);
  assert.equal(db.getSeries(id)!.completed, false, 'upsertSeries は倒さないので、ここで倒す');
});

test('同じ名前の作品が既にあれば断る', () => {
  seed('[A] かぶる名前', 'かぶる名前', 'A', []);
  const id = seed('[A] 別の名前', '別の名前', 'A', []);
  assert.throws(
    () => planRename(db, root, id, { title: 'かぶる名前', author: 'A', completed: false }),
    RenameError
  );
});

test('DB に入るのは、次のスキャンがそのフォルダを読んで出す答え', () => {
  // 打った字をそのまま series.title に入れてはいけない。Windows が使えない文字は
  // フォルダ名で全角へ倒れ (: → ：)、読み戻す側は NFKC で半角へ戻す。
  // 打った字を入れると、次のスキャンがフォルダを読んで黙って上書きし直す
  const id = seed('[B] ふつうの名前', 'ふつうの名前', 'B', []);
  const plan = planRename(db, root, id, { title: 'タイトル: 副題', author: 'B', completed: false });
  assert.equal(plan.to, '[B] タイトル： 副題', 'フォルダ名は全角へ倒す');
  assert.equal(
    plan.title,
    parseLibraryEntry(plan.to + '/x.rar').series.title,
    'DB にはスキャンと同じ答えを入れる'
  );
  assert.equal(plan.warnings.length, 1, '打った名前と違うことは人に見せる');
});

test('別巻の呼び名は付け替えに付いていく', async () => {
  // 呼び名はフォルダ名を前置きとして剥がして読んでいるので、フォルダが変われば答えも変わる。
  // 次のスキャンを待たずにここで読み直さないと、画面の「別巻」が古い名前のまま残る
  const folder = '[天空すふぃあ] まちがった名前';
  const id = seed(folder, 'まちがった名前', '天空すふぃあ', ['[天空すふぃあ] まちがった名前 第01巻.rar']);
  const side = '[天空すふぃあ] まちがった名前 外伝.rar';
  fs.writeFileSync(path.join(shelf, folder, side), 'x');
  db.upsertFile({
    rootId: root.id, relPath: path.join(folder, side), seriesId: id, volumeId: null,
    size: 1, mtime: null, ext: '.rar', part: '', partNo: null,
    sideLabel: parseLibraryEntry(path.join(folder, side)).sideLabel, tags: [],
  });
  const before = db.raw
    .prepare('SELECT side_label FROM files WHERE series_id = ? AND volume_id IS NULL')
    .get(id) as { side_label: string | null };
  assert.equal(before.side_label, '外伝');

  const plan = planRename(db, root, id, { title: 'ただしい名前', author: '天空すふぃあ', completed: false });
  // 前置きごと付け替えるので、呼び名は読めなくならない
  assert.equal(plan.losesSide, 0);
  assert.deepEqual(plan.warnings, []);
  await applyRename(db, root, plan, dir);

  const rows = db.raw
    .prepare('SELECT rel_path, side_label FROM files WHERE series_id = ? AND volume_id IS NULL')
    .all(id) as { rel_path: string; side_label: string | null }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rel_path, path.join('[天空すふぃあ] ただしい名前', '[天空すふぃあ] ただしい名前 外伝.rar'));
  assert.equal(rows[0].side_label, '外伝', '呼び名は一字も変えずに後ろへ回す');
  assert.ok(fs.existsSync(path.join(shelf, '[天空すふぃあ] ただしい名前', '[天空すふぃあ] ただしい名前 外伝.rar')));
});

test('作品名が空になる指定は断る', () => {
  const id = seed('[B2] ふつうの名前', 'ふつうの名前', 'B2', []);
  assert.throws(() => planRename(db, root, id, { title: '   ', author: 'B2', completed: false }), RenameError);
});

test('単位の無い巻数は棚の形に組み立て直す — 巻数を落とさない', () => {
  // [著者] ぐらんぶる/… ぐらんぶる 01.rar — 単位の無い巻数は、フォルダ名を
  // 剥がせた時だけ巻数として読んでいる。名前を追従させる時は DB の巻数から
  // 「第01巻」を組み立て直すので、前置きが剥がれなくなっても巻は落ちない
  const id = seed('[井上堅二×吉岡公威] ぐらんぶる', 'ぐらんぶる', '井上堅二×吉岡公威',
    ['[井上堅二×吉岡公威] ぐらんぶる 01.rar']);

  const plan = planRename(db, root, id, { title: 'グランブルー', author: '井上堅二×吉岡公威', completed: false });
  assert.equal(plan.losesVolume, 0);
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(plan.moves.map((m) => m.to), ['[井上堅二×吉岡公威] グランブルー 第01巻.rar']);

  // 完結の印を足すだけでも、ファイル名は決まり通りの形に直る
  const safe = planRename(db, root, id, { title: 'ぐらんぶる', author: '井上堅二×吉岡公威', completed: true });
  assert.equal(safe.losesVolume, 0);
  assert.deepEqual(safe.warnings, []);
  assert.deepEqual(safe.moves.map((m) => m.to), ['[井上堅二×吉岡公威] ぐらんぶる 第01巻.rar']);
});

test('フォルダもファイルも変わらない指定は noop で、何にも触らない', async () => {
  const id = seed('[C] そのまま', 'そのまま', 'C', ['[C] そのまま 第01巻.rar']);
  const plan = planRename(db, root, id, { title: 'そのまま', author: 'C', completed: false });
  assert.equal(plan.noop, true);
  assert.deepEqual(plan.moves, []);
  const r = await applyRename(db, root, plan, dir);
  assert.equal(r.files, 0);
  assert.ok(fs.existsSync(path.join(shelf, '[C] そのまま')));
});

test('フォルダ名が既に正しくてもファイル名だけ直せる — noop にしない', async () => {
  // エクスプローラでフォルダだけ直した後がこの形。フォルダが合っているからと
  // noop にすると、古い作品名のファイルを直す手段がどこにも無くなる
  const folder = '[D] あたらしい名前';
  const id = seed(folder, 'あたらしい名前', 'D', ['[D] ふるい名前 第01巻.rar']);
  const plan = planRename(db, root, id, { title: 'あたらしい名前', author: 'D', completed: false });
  assert.equal(plan.from, plan.to, 'フォルダ名は変わらない');
  assert.equal(plan.noop, false);
  assert.deepEqual(plan.moves.map((m) => m.to), ['[D] あたらしい名前 第01巻.rar']);

  await applyRename(db, root, plan, dir);
  assert.ok(fs.existsSync(path.join(shelf, folder, '[D] あたらしい名前 第01巻.rar')));
  assert.ok(!fs.existsSync(path.join(shelf, folder, '[D] ふるい名前 第01巻.rar')));
});

test('版の印と分割書庫の連番は写すだけ — 組み立て直さない', async () => {
  const folder = '[E] 印のある作品';
  fs.mkdirSync(path.join(shelf, folder), { recursive: true });
  const { row } = db.upsertSeries({
    rootId: root.id, folder, seriesKey: seriesKeyOf('印のある作品'), title: '印のある作品',
    author: 'E', completed: false,
  });
  const v = db.upsertVolume({ seriesId: row.id, volumeFrom: 4, volumeTo: 4, unit: '巻', completed: false });
  for (const name of ['[E] 印のある作品 第04巻 [LQ].part1.rar', '[E] 印のある作品 第04巻 [LQ].part2.rar']) {
    fs.writeFileSync(path.join(shelf, folder, name), 'x');
    db.upsertFile({
      rootId: root.id, relPath: path.join(folder, name), seriesId: row.id, volumeId: v.row.id,
      size: 1, mtime: null, ext: '.rar', part: name.includes('part1') ? '.part1' : '.part2',
      partNo: name.includes('part1') ? 1 : 2, sideLabel: null, tags: ['LQ'],
    });
  }

  const plan = planRename(db, root, row.id, { title: '印のある作品', author: 'E2', completed: false });
  assert.deepEqual(plan.moves.map((m) => m.to), [
    '[E2] 印のある作品 第04巻 [LQ].part1.rar',
    '[E2] 印のある作品 第04巻 [LQ].part2.rar',
  ], '版の印も連番も落とさない (落とすと片方が消える)');
  await applyRename(db, root, plan, dir);
  assert.ok(fs.existsSync(path.join(shelf, '[E2] 印のある作品', '[E2] 印のある作品 第04巻 [LQ].part2.rar')));
});

test('作品名が前置きになっていないファイルは触らない — 数えて人に見せる', async () => {
  const folder = '[BETEMIUS] 同人誌';
  fs.mkdirSync(path.join(shelf, folder), { recursive: true });
  const { row } = db.upsertSeries({
    rootId: root.id, folder, seriesKey: seriesKeyOf('同人誌'), title: '同人誌',
    author: 'BETEMIUS', completed: false,
  });
  const stray = '[BETEMIUS] 夕立の手紙.rar';
  fs.writeFileSync(path.join(shelf, folder, stray), 'x');
  db.upsertFile({
    rootId: root.id, relPath: path.join(folder, stray), seriesId: row.id, volumeId: null,
    size: 1, mtime: null, ext: '.rar', part: '', partNo: null, sideLabel: null, tags: [],
  });

  const plan = planRename(db, root, row.id, { title: '同人誌', author: 'BETEMIUS', completed: true });
  assert.deepEqual(plan.stuck, [stray], '何が追従できないかは押す前に見せる');
  assert.deepEqual(plan.moves, []);
  // 巻にも呼び名にも結び付いていないので、失うものは無い = 注意書きも立たない
  assert.deepEqual(plan.warnings, []);

  await applyRename(db, root, plan, dir);
  assert.ok(fs.existsSync(path.join(shelf, '[BETEMIUS] 同人誌(完)', stray)), '名前はそのまま残る');
});

test('完結を外すとファイル名の (完) も落ちる — 次のスキャンで戻らないように', async () => {
  const folder = '[F] 打ち切り(完)';
  const file = '[F] 打ち切り 第01巻(完).rar';
  fs.mkdirSync(path.join(shelf, folder), { recursive: true });
  fs.writeFileSync(path.join(shelf, folder, file), 'x');
  const { row } = db.upsertSeries({
    rootId: root.id, folder, seriesKey: seriesKeyOf('打ち切り'), title: '打ち切り',
    author: 'F', completed: true,
  });
  const v = db.upsertVolume({ seriesId: row.id, volumeFrom: 1, volumeTo: 1, unit: '巻', completed: true });
  db.upsertFile({
    rootId: root.id, relPath: path.join(folder, file), seriesId: row.id, volumeId: v.row.id,
    size: 1, mtime: null, ext: '.rar', part: '', partNo: null, sideLabel: null, tags: [],
  });

  const plan = planRename(db, root, row.id, { title: '打ち切り', author: 'F', completed: false });
  assert.equal(plan.to, '[F] 打ち切り');
  assert.deepEqual(plan.moves.map((m) => m.to), ['[F] 打ち切り 第01巻.rar']);
  await applyRename(db, root, plan, dir);

  // フォルダにもファイルにも印が無い。次のスキャンが完結へ戻せない形になった
  const after = parseLibraryEntry(path.join('[F] 打ち切り', '[F] 打ち切り 第01巻.rar'));
  assert.equal(after.series.completed, false);
});

test('同じ名前になる 2 本は (2) を付けて両方残す — 上書きしない', async () => {
  const folder = '[G] かぶる巻';
  fs.mkdirSync(path.join(shelf, folder), { recursive: true });
  const { row } = db.upsertSeries({
    rootId: root.id, folder, seriesKey: seriesKeyOf('かぶる巻'), title: 'かぶる巻',
    author: 'G', completed: false,
  });
  const v = db.upsertVolume({ seriesId: row.id, volumeFrom: 1, volumeTo: 1, unit: '巻', completed: false });
  // 片方は単位の無い巻数。組み立て直すと両方 `第01巻` になる
  for (const name of ['(一般コミック) [G] かぶる巻 第01巻.rar', '[G] かぶる巻 01.rar']) {
    fs.writeFileSync(path.join(shelf, folder, name), 'x');
    db.upsertFile({
      rootId: root.id, relPath: path.join(folder, name), seriesId: row.id, volumeId: v.row.id,
      size: 1, mtime: null, ext: '.rar', part: '', partNo: null, sideLabel: null, tags: [],
    });
  }

  const plan = planRename(db, root, row.id, { title: 'かぶる巻', author: 'G2', completed: false });
  const names = plan.moves.map((m) => m.to).sort();
  assert.deepEqual(names, ['[G2] かぶる巻 第01巻 (2).rar', '[G2] かぶる巻 第01巻.rar']);
  await applyRename(db, root, plan, dir);
  const left = fs.readdirSync(path.join(shelf, '[G2] かぶる巻')).sort();
  assert.equal(left.length, 2, '2 本あったものは 2 本のまま残す');
});

test('長い書名と合本が混ざった作品 — 画面から来る実際の形', async () => {
  const folder = '[月みりん] 実は妹でした。';
  fs.mkdirSync(path.join(shelf, folder), { recursive: true });
  const { row } = db.upsertSeries({
    rootId: root.id, folder, seriesKey: seriesKeyOf('実は妹でした。'), title: '実は妹でした。',
    author: '月みりん', completed: false,
  });
  const have: [string, number, number][] = [
    ['[月みりん] 実は妹でした。 第01巻.rar', 1, 1],
    ['[月みりん] 実は妹でした。 第01-02巻.rar', 1, 2],
    ['[月みりん] 実は妹でした。 第03巻.rar', 3, 3],
    ['[月みりん] 実は妹でした。 第04巻.rar', 4, 4],
  ];
  for (const [name, from, to] of have) {
    fs.writeFileSync(path.join(shelf, folder, name), 'x');
    const v = db.upsertVolume({ seriesId: row.id, volumeFrom: from, volumeTo: to, unit: '巻', completed: false });
    db.upsertFile({
      rootId: root.id, relPath: path.join(folder, name), seriesId: row.id, volumeId: v.row.id,
      size: 1, mtime: null, ext: '.rar', part: '', partNo: null, sideLabel: null, tags: [],
    });
  }

  const title = 'じつは義妹でした。~最近できた義理の弟の距離感がやたら近いわけ~';
  const plan = planRename(db, root, row.id, { title, author: '堺しょうきち', completed: false });
  assert.equal(plan.to, `[堺しょうきち] ${title}`);
  assert.deepEqual(plan.stuck, []);
  assert.deepEqual(plan.warnings, []);
  assert.equal(plan.moves.length, 4);
  // 合本は範囲のまま。1 冊ずつに割ったり第01巻へ均したりしない
  assert.ok(plan.moves.some((m) => m.to === `[堺しょうきち] ${title} 第01-02巻.rar`));

  await applyRename(db, root, plan, dir);
  assert.equal(fs.readdirSync(path.join(shelf, plan.to)).length, 4);

  // **この口の約束**: DB に入っているものと、次のスキャンが読んで出す答えが同じ
  const rows = db.raw
    .prepare('SELECT rel_path FROM files WHERE series_id = ? AND present = 1')
    .all(row.id) as { rel_path: string }[];
  assert.equal(rows.length, 4);
  for (const r of rows) {
    const read = parseLibraryEntry(r.rel_path);
    assert.equal(read.series.title, title);
    assert.equal(read.series.author, '堺しょうきち');
    assert.ok(read.volumeFrom !== null, r.rel_path);
  }
});

test('付け替えはジャーナルに残る — 間違えても戻せる', () => {
  const lines = fs.readFileSync(path.join(dir, 'renames.jsonl'), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 3);
  const first = JSON.parse(lines[0]) as { from: string; to: string };
  assert.equal(first.from, '[天空すふぃあ] ブルータル 異世界で邪神の力を手に入れた');
  assert.equal(first.to, '[天空すふぃあ] ブルターニュ花嫁異聞');
});
