import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shelfBusy, withShelfLock } from './lock.js';

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('掴んでいる仕事は 1 つずつ順に走る', async () => {
  const order: string[] = [];
  const a = withShelfLock('A', async () => { order.push('a-in'); await tick(20); order.push('a-out'); });
  const b = withShelfLock('B', async () => { order.push('b-in'); });
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a-in', 'a-out', 'b-in'], 'B は A の途中に割り込まない');
});

test('ファイルを動かす仕事の間だけ、所持の問い合わせを断る', async () => {
  assert.equal(shelfBusy(), null);

  // スキャンは断らない。1 トランザクションで書くので途中が見えない
  const scan = withShelfLock('棚を読んでいます', async () => {
    assert.equal(shelfBusy(), null, 'スキャン中に 503 を返すと 3 時間ごとに他所を止める');
    await tick();
  });
  await scan;

  // 付け替えは断る。ファイルが「消えた」に倒れて見える瞬間がある
  const move = withShelfLock('付け替えています', async () => {
    assert.equal(shelfBusy(), '付け替えています');
    await tick();
  }, { mutates: true });
  await move;

  assert.equal(shelfBusy(), null, '終わったら必ず離す');
});

test('1 回の失敗で行列が止まらない', async () => {
  // catch を挟まないと、投げた仕事の後はスキャンが二度と走らなくなる
  await assert.rejects(withShelfLock('こける', async () => { throw new Error('どかん'); }));
  let ran = false;
  await withShelfLock('次', async () => { ran = true; });
  assert.equal(ran, true);
  assert.equal(shelfBusy(), null);
});
