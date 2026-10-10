import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Config } from './config.js';
import { Db } from './db.js';
import { buildServer } from './server.js';
import { seriesKeyOf } from './volume.js';
import { ZipWriter } from './zip-write.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinax-server-'));
const dataDir = path.join(dir, 'data');
const shelf = path.join(dir, 'shelf');
fs.mkdirSync(path.join(dataDir, 'covers'), { recursive: true });
fs.mkdirSync(shelf, { recursive: true });

const db = new Db(dataDir);
const cfg = {
  port: 0, host: '127.0.0.1', dataDir, apiToken: '', dryeyesUrl: '', publicUrl: '',
  roots: [{ id: 't', label: '試し', path: shelf, kind: 'shelf' as const }],
  scan: { onStart: false, intervalMinutes: 0 },
  bib: { ttlDays: 90, minIntervalMs: 0, providers: [], rakuten: {}, google: {} },
  notify: { ntfyUrl: '' },
} as unknown as Config;
const app = buildServer(db, cfg);

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- よそのサイトからの書き込み ---------------------------------------------

test('よそのサイトからの POST は断る — 本文の無い POST は下見無しで届く', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/scan', headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(r.statusCode, 403);
});

test('出どころを名乗らない古いブラウザは Origin で見る', async () => {
  const r = await app.inject({
    method: 'POST', url: '/api/scan', headers: { origin: 'http://evil.example', host: 'localhost:3838' },
  });
  assert.equal(r.statusCode, 403);
});

test('自分の画面からと、他のサービスのサーバーからは通す', async () => {
  const own = await app.inject({ method: 'POST', url: '/api/scan', headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(own.statusCode, 200);
  const sameHost = await app.inject({
    method: 'POST', url: '/api/scan', headers: { origin: 'http://localhost:3838', host: 'localhost:3838' },
  });
  assert.equal(sameHost.statusCode, 200);
  // PowerDowner / DryEyes のサーバーはどちらも付けてこない
  const service = await app.inject({ method: 'POST', url: '/api/own', payload: { title: '無い作品', volume: '1' } });
  assert.equal(service.statusCode, 200);
});

// ---- ページの版の印 ---------------------------------------------------------

test('ページは今の印が付いた URL だけ 1 年持たせる — 差し替えた本の古い絵を出さない', async () => {
  const folder = '[試作者] 試し作品';
  const name = `${folder} 第01巻.zip`;
  fs.mkdirSync(path.join(shelf, folder), { recursive: true });
  const w = new ZipWriter(path.join(shelf, folder, name));
  w.addStored('001.jpg', Buffer.from('page-1'));
  w.close();
  const s = db.upsertSeries({
    rootId: 't', folder, seriesKey: seriesKeyOf('試し作品'), title: '試し作品', author: '試作者', completed: false,
  });
  db.upsertFile({
    rootId: 't', relPath: path.join(folder, name), seriesId: s.row.id, volumeId: null,
    size: 1, mtime: null, ext: '.zip', part: '', partNo: null, sideLabel: null, tags: [],
  });
  const id = (db.raw.prepare('SELECT id FROM files WHERE rel_path = ?').get(path.join(folder, name)) as { id: number }).id;

  const pages = (await app.inject({ method: 'GET', url: `/api/files/${id}/pages` })).json() as { v: string };
  assert.ok(pages.v);

  const pinned = await app.inject({ method: 'GET', url: `/api/files/${id}/page/0?v=${pages.v}` });
  assert.equal(pinned.statusCode, 200);
  assert.equal(pinned.body, 'page-1');
  assert.match(String(pinned.headers['cache-control']), /immutable/);

  // 印の無い URL (古い画面) は毎回確かめさせる
  const bare = await app.inject({ method: 'GET', url: `/api/files/${id}/page/0` });
  assert.doesNotMatch(String(bare.headers['cache-control']), /immutable/);

  // 中身を差し替えると印も変わる。古い印の URL はもう 1 年持たない
  const w2 = new ZipWriter(path.join(shelf, folder, name));
  w2.addStored('001.jpg', Buffer.from('page-1, もっときれいな版'));
  w2.close();
  const after2 = (await app.inject({ method: 'GET', url: `/api/files/${id}/pages` })).json() as { v: string };
  assert.notEqual(after2.v, pages.v);
  const stale = await app.inject({ method: 'GET', url: `/api/files/${id}/page/0?v=${pages.v}` });
  assert.doesNotMatch(String(stale.headers['cache-control']), /immutable/);
});

// ---- 棚の一覧 ---------------------------------------------------------------

test('limit=all は棚の全部を返す — 500 で切らない', async () => {
  for (let i = 0; i < 501; i++) {
    const t = `作品${String(i).padStart(3, '0')}`;
    db.upsertSeries({ rootId: 'many', folder: t, seriesKey: seriesKeyOf(t), title: t, author: null, completed: false });
  }
  const r = (await app.inject({ method: 'GET', url: '/api/series?root=many&limit=all' })).json() as {
    total: number; items: unknown[];
  };
  assert.equal(r.total, 501);
  assert.equal(r.items.length, 501);
});
