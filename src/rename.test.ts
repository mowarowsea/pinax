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
      size: 1, mtime: null, ext: '.rar', part: '', partNo: null, tags: [],
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

test('files.rel_path も一緒に付け替わる — 次のスキャンで「消えた」に倒さない', () => {
  const rows = db.raw
    .prepare("SELECT rel_path FROM files WHERE rel_path LIKE '%ブル%'")
    .all() as { rel_path: string }[];
  assert.equal(rows.length, 1);
  assert.ok(rows[0].rel_path.startsWith('[天空すふぃあ] ブルターニュ花嫁異聞'), rows[0].rel_path);
  // ファイル名の側は触らない。作品の素性はフォルダを正とするので、これで壊れない
  assert.ok(rows[0].rel_path.includes('ブルータル'), 'ファイル名は変えない');
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

test('作品名が空になる指定は断る', () => {
  const id = seed('[B2] ふつうの名前', 'ふつうの名前', 'B2', []);
  assert.throws(() => planRename(db, root, id, { title: '   ', author: 'B2', completed: false }), RenameError);
});

test('フォルダ名を前置きにして巻数を読んでいるファイルは注意書きが立つ', () => {
  // [著者] ぐらんぶる/… ぐらんぶる 01.rar — 単位の無い巻数は、フォルダ名を
  // 剥がせた時だけ巻数として読んでいる。フォルダを変えると読めなくなる
  const id = seed('[井上堅二×吉岡公威] ぐらんぶる', 'ぐらんぶる', '井上堅二×吉岡公威',
    ['[井上堅二×吉岡公威] ぐらんぶる 01.rar']);

  const risky = planRename(db, root, id, { title: 'グランブルー', author: '井上堅二×吉岡公威', completed: false });
  assert.equal(risky.losesVolume, 1);
  assert.equal(risky.warnings.length, 1);

  // 完結の印を足すだけなら前置きは剥がれたまま。注意書きは立たない
  const safe = planRename(db, root, id, { title: 'ぐらんぶる', author: '井上堅二×吉岡公威', completed: true });
  assert.equal(safe.losesVolume, 0);
  assert.deepEqual(safe.warnings, []);
});

test('名前が変わらない指定は noop で、ファイルに触らない', async () => {
  const id = seed('[C] そのまま', 'そのまま', 'C', []);
  const plan = planRename(db, root, id, { title: 'そのまま', author: 'C', completed: false });
  assert.equal(plan.noop, true);
  const r = await applyRename(db, root, plan, dir);
  assert.equal(r.files, 0);
  assert.ok(fs.existsSync(path.join(shelf, '[C] そのまま')));
});

test('付け替えはジャーナルに残る — 間違えても戻せる', () => {
  const lines = fs.readFileSync(path.join(dir, 'renames.jsonl'), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 3);
  const first = JSON.parse(lines[0]) as { from: string; to: string };
  assert.equal(first.from, '[天空すふぃあ] ブルータル 異世界で邪神の力を手に入れた');
  assert.equal(first.to, '[天空すふぃあ] ブルターニュ花嫁異聞');
});
