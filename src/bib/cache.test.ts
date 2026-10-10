import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Config } from '../config.js';
import { Db } from '../db.js';
import { cachedFetch } from './cache.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinax-cache-'));
const db = new Db(dir);
const cfg = { bib: { minIntervalMs: 0, ttlDays: 90 } } as unknown as Config;
const realFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = realFetch;
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 外の答えを差し替える。**このファイルの中でしか外へ出ない** */
function answer(status: number, body: string): void {
  globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
}

test('外が 503 を返しても、正しく取れていた古い値を上書きせずに返す', async () => {
  const url = 'https://ndlsearch.ndl.go.jp/api/opensearch?title=x';
  answer(200, '<rss>good</rss>');
  await cachedFetch(db, cfg, { provider: 'ndl', url });

  // 取り直そうとしたら相手がメンテ中だった
  answer(503, '<html>maintenance</html>');
  const r = await cachedFetch(db, cfg, { provider: 'ndl', url, refresh: true });
  assert.equal(r.status, 200);
  assert.equal(r.body, '<rss>good</rss>');
  assert.equal(r.stale, true);

  // 手元の答えも消えていない。繋がらない時にもまだ返せる
  globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  const offline = await cachedFetch(db, cfg, { provider: 'ndl', url, refresh: true });
  assert.equal(offline.body, '<rss>good</rss>');
});

test('古い値が無ければ断られた答えをそのまま返す', async () => {
  answer(503, 'maintenance');
  const r = await cachedFetch(db, cfg, { provider: 'ndl', url: 'https://ndlsearch.ndl.go.jp/api/opensearch?title=y' });
  assert.equal(r.status, 503);
  assert.equal(r.stale, false);
});
