import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { renameNoClobber } from './move.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinax-move-'));

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('行き先に別のファイルがあれば動かさない — 置き換わった方は戻らない', () => {
  const a = path.join(dir, 'a.rar');
  const b = path.join(dir, 'b.rar');
  fs.writeFileSync(a, 'A');
  fs.writeFileSync(b, 'B');

  assert.throws(() => renameNoClobber(a, b), /同じ名前のファイルがあります/);
  assert.equal(fs.readFileSync(b, 'utf8'), 'B', '行き先は元のまま');
  assert.equal(fs.readFileSync(a, 'utf8'), 'A', '動かす側も元のまま');

  const c = path.join(dir, 'c.rar');
  renameNoClobber(a, c);
  assert.ok(!fs.existsSync(a));
  assert.equal(fs.readFileSync(c, 'utf8'), 'A');
});

test('大文字小文字だけの付け替えは通す (Windows では同じファイル)', { skip: process.platform !== 'win32' }, () => {
  const lower = path.join(dir, 'landreaall.rar');
  fs.writeFileSync(lower, 'L');
  renameNoClobber(lower, path.join(dir, 'Landreaall.rar'));
  assert.ok(fs.readdirSync(dir).includes('Landreaall.rar'));
});
