import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Db } from './db.js';
import type { Config } from './config.js';
import { seriesKeyOf } from './volume.js';
import { keepOne } from './keep.js';

/**
 * 第01巻が 2 本ある棚を組む。`第01巻.zip` と `第01巻 (2).zip` (合本を割った時に出来る形)
 */
function shelf(): { dir: string; folder: string; cfg: Config; db: Db; seriesId: number; ids: number[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinax-keep-'));
  const root = path.join(dir, 'shelf');
  const series = '[試作者] 試し作品';
  const folder = path.join(root, series);
  fs.mkdirSync(folder, { recursive: true });

  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Db(dataDir);
  const cfg = {
    port: 0, host: '127.0.0.1', dataDir, apiToken: '',
    roots: [{ id: 't', label: '試し', path: root, kind: 'shelf' as const }],
    scan: { onStart: false, intervalMinutes: 0 },
  } as unknown as Config;

  const s = db.upsertSeries({
    rootId: 't', folder: series, seriesKey: seriesKeyOf(series),
    title: '試し作品', author: '試作者', completed: false,
  });
  const v = db.upsertVolume({ seriesId: s.row.id, volumeFrom: 1, volumeTo: 1, unit: '巻', completed: false });
  const ids: number[] = [];
  for (const [name, body] of [['[試作者] 試し作品 第01巻.zip', 'old'], ['[試作者] 試し作品 第01巻 (2).zip', 'new']]) {
    fs.writeFileSync(path.join(folder, name), body);
    db.upsertFile({
      rootId: 't', relPath: path.join(series, name), seriesId: s.row.id, volumeId: v.row.id,
      size: body.length, mtime: null, ext: '.zip', part: '', partNo: null, sideLabel: null, tags: [],
    });
    ids.push((db.raw.prepare('SELECT id FROM files WHERE rel_path = ?').get(path.join(series, name)) as { id: number }).id);
  }
  return { dir, folder, cfg, db, seriesId: s.row.id, ids };
}

test('(2) の方を残すと、元の方を attic へ引いて (2) を外す', async () => {
  const t = shelf();
  try {
    t.db.setCare(t.ids[1], true, '見開きがずれている');
    const r = await keepOne(t.db, t.cfg, t.seriesId, t.ids[1]);
    assert.equal(r.kept, '[試作者] 試し作品 第01巻.zip');
    assert.equal(r.renamed, true);
    assert.deepEqual(fs.readdirSync(t.folder), ['[試作者] 試し作品 第01巻.zip']);
    assert.equal(fs.readFileSync(path.join(t.folder, r.kept), 'utf8'), 'new');

    // 消さずに attic に居る ("Never burn")
    assert.equal(r.attic.length, 1);
    assert.equal(fs.readFileSync(r.attic[0], 'utf8'), 'old');

    // 行は付け替えただけ。要ケアの印が残る
    const row = t.db.raw.prepare('SELECT rel_path, care, present FROM files WHERE id = ?').get(t.ids[1]) as
      Record<string, unknown>;
    assert.equal(path.basename(String(row.rel_path)), r.kept);
    assert.equal(Number(row.care), 1);
    assert.equal(Number(row.present), 1);
  } finally {
    t.db.close();
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test('元の方を残すと (2) だけを引き、名前は変えない', async () => {
  const t = shelf();
  try {
    const r = await keepOne(t.db, t.cfg, t.seriesId, t.ids[0]);
    assert.equal(r.renamed, false);
    assert.deepEqual(fs.readdirSync(t.folder), ['[試作者] 試し作品 第01巻.zip']);
    assert.equal(fs.readFileSync(path.join(t.folder, r.kept), 'utf8'), 'old');
    assert.equal(fs.readFileSync(r.attic[0], 'utf8'), 'new');
    const gone = t.db.raw.prepare('SELECT present FROM files WHERE id = ?').get(t.ids[1]) as { present: number };
    assert.equal(Number(gone.present), 0);
  } finally {
    t.db.close();
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test('ほかの作品のファイルは選べない / 1 本しか無い巻は断る', async () => {
  const t = shelf();
  try {
    await assert.rejects(() => keepOne(t.db, t.cfg, t.seriesId + 1, t.ids[0]), /この作品にありません/);
    await keepOne(t.db, t.cfg, t.seriesId, t.ids[0]);
    await assert.rejects(() => keepOne(t.db, t.cfg, t.seriesId, t.ids[0]), /ほかのファイルはありません/);
  } finally {
    t.db.close();
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});
