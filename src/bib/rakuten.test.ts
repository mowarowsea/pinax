import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config.js';
import { Db } from '../db.js';
import { ProviderStopError } from './cache.js';
import { RakutenAuthError, searchRakuten, splitRakutenVolume, rakutenImageUrl } from './rakuten.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinax-rakuten-'));
const db = new Db(dir);
const realFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = realFetch;
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * 楽天が返してきた**実物の書名**を並べてある。
 * ここが崩れると、書名で拾い直す道で別の巻の表紙を貼ることになる。
 */

test('半角括弧 + 算用数字 (よつばと!(16))', () => {
  assert.deepEqual(splitRakutenVolume('よつばと!(16)'), { title: 'よつばと!', volume: 16 });
  assert.deepEqual(splitRakutenVolume('封神演義（2）'), { title: '封神演義', volume: 2 });
});

test('全角括弧 + 漢数字 (日常　（十二）)', () => {
  assert.deepEqual(splitRakutenVolume('日常　（十二）'), { title: '日常', volume: 12 });
  assert.deepEqual(splitRakutenVolume('日常（十）'), { title: '日常', volume: 10 });
  assert.deepEqual(splitRakutenVolume('日常（二十三）'), { title: '日常', volume: 23 });
  assert.deepEqual(splitRakutenVolume('日常（三）'), { title: '日常', volume: 3 });
});

test('素直に「第n巻」と書いてある形', () => {
  assert.deepEqual(splitRakutenVolume('ヒストリエ 第10巻'), { title: 'ヒストリエ', volume: 10 });
  assert.deepEqual(splitRakutenVolume('ヒストリエ 十巻'), { title: 'ヒストリエ', volume: 10 });
});

test('巻が書かれていない書名は巻なしで返す', () => {
  assert.deepEqual(splitRakutenVolume('よつばとスタジオ'), { title: 'よつばとスタジオ', volume: null });
  // **括弧の中が巻数とは限らない。** 数として読めないものは巻にしない
  assert.deepEqual(splitRakutenVolume('鋼の錬金術師（完全版）'), { title: '鋼の錬金術師（完全版）', volume: null });
});

test('書影 URL の大きさを差し替える', () => {
  assert.equal(
    rakutenImageUrl('https://thumbnail.image.rakuten.co.jp/@0_mall/book/cabinet/a/b.jpg?_ex=200x200', 600),
    'https://thumbnail.image.rakuten.co.jp/@0_mall/book/cabinet/a/b.jpg?_ex=600x600'
  );
  // _ex が無い URL にも付ける
  assert.equal(rakutenImageUrl('https://example.test/a.jpg', 600), 'https://example.test/a.jpg?_ex=600x600');
  assert.equal(rakutenImageUrl(null, 600), null);
});

/**
 * 止められている間に普通の失敗として流すと、試した巻に「駄目だった」の印だけが押されて
 * 60 日先送りになる。**巡回を打ち切らせる側の失敗** (ProviderStopError) で上げる
 */
test('問い合わせが多すぎると言われたら巡回を打ち切らせる — 鍵の間違いとは言わない', async () => {
  const cfg = {
    bib: { minIntervalMs: 0, ttlDays: 90, rakuten: { applicationId: 'id', accessKey: 'key', affiliateId: '' } },
  } as unknown as Config;
  globalThis.fetch = (async () => new Response(
    '{"error":"too_many_requests","error_description":"number of allowed requests has been exceeded"}',
    { status: 429 }
  )) as typeof fetch;

  await assert.rejects(searchRakuten(db, cfg, { isbn: '9784088725093' }), (e: unknown) => {
    assert.ok(e instanceof ProviderStopError);
    assert.ok(!(e instanceof RakutenAuthError), '鍵を見直させない');
    return true;
  });
});
