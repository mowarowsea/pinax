import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Db } from '../db.js';
import type { LibraryRoot } from '../config.js';
import { scanFolder, scanRoot } from './scanner.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinax-scan-'));
fs.mkdirSync(path.join(dir, 'covers'), { recursive: true });
const shelf = path.join(dir, 'shelf');
const db = new Db(dir);
const root: LibraryRoot = { id: 'test', label: '試し', path: shelf, kind: 'shelf' };

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const A = '[おがきちか] Landreaall';
const B = '[ゆうきまさみ] 鉄腕バーディー';

function put(folder: string, name: string): void {
  fs.mkdirSync(path.join(shelf, folder), { recursive: true });
  fs.writeFileSync(path.join(shelf, folder, name), 'x');
}

function files(folder: string): { rel: string; present: number }[] {
  const rows = db.raw
    .prepare('SELECT rel_path AS rel, present FROM files WHERE root_id = ? ORDER BY rel_path')
    .all('test') as { rel: string; present: number }[];
  return rows.filter((r) => String(r.rel).startsWith(folder));
}

test('フォルダ 1 つの読み直しは、そのフォルダの外を倒さない', async () => {
  put(A, `${A} 第01-03巻.rar`);
  put(B, `${B} 第01巻.rar`);
  const first = await scanRoot(db, root);
  assert.equal(first.error, null);
  assert.equal(first.filesSeen, 2);
  assert.equal(first.baseline, true);

  // A だけ棚の外で動かす (合本を割った後の形)。B には一切さわらない
  fs.rmSync(path.join(shelf, A, `${A} 第01-03巻.rar`));
  for (const n of ['01', '02', '03']) put(A, `${A} 第${n}巻.zip`);

  const r = await scanFolder(db, root, A);
  assert.equal(r.error, null);
  assert.equal(r.filesSeen, 3);
  assert.equal(r.volumesAdded, 3);
  assert.equal(r.gone, 1, '割る前の合本 1 本だけが消えたことになる');

  // **ここが肝。** 歩かなかった B が「消えた」に倒れていない
  assert.deepEqual(files(B).map((f) => f.present), [1]);
  const gone = files(A).filter((f) => f.present === 0);
  assert.equal(gone.length, 1);
  assert.match(gone[0].rel, /第01-03巻\.rar$/);
});

test('読み直す場所は持っているファイルから引く', () => {
  const series = db.raw.prepare('SELECT id FROM series WHERE folder = ?').get(A) as { id: number };
  assert.deepEqual(db.seriesDirs(series.id), [A]);
});

test('まだ一度も読んでいない棚では断る', async () => {
  const other = path.join(dir, 'shelf2');
  fs.mkdirSync(path.join(other, A), { recursive: true });
  fs.writeFileSync(path.join(other, A, `${A} 第01巻.rar`), 'x');
  const r = await scanFolder(db, { id: 'fresh', label: '新品', path: other, kind: 'shelf' }, A);
  assert.match(String(r.error), /まだこの棚を読んでいません/);
  assert.equal(r.filesSeen, 0);
});

test('読めないフォルダでは蔵書を倒さない', async () => {
  const r = await scanFolder(db, root, '在りもしないフォルダ');
  assert.match(String(r.error), /フォルダを読めません/);
  assert.deepEqual(files(B).map((f) => f.present), [1]);
  assert.equal(files(A).filter((f) => f.present === 1).length, 3);
});
