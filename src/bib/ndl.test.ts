import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNdlVolume, normalizeIsbn, authorVariants } from './ndl.js';

/**
 * ここに並んでいるのは全部 **NDL が実際に返してきた形**。
 * キャッシュ 627 応答 13016 件を数えて拾った (2026-09-14)。
 */

test('素の数字', () => {
  assert.equal(parseNdlVolume('3'), 3);
  assert.equal(parseNdlVolume('２'), 2); // 全角
  assert.equal(parseNdlVolume(' 12 '), 12);
});

test('日本語の単位付き (第3巻が一番多い: 612件)', () => {
  assert.equal(parseNdlVolume('第3巻'), 3);
  assert.equal(parseNdlVolume('3巻'), 3);
  assert.equal(parseNdlVolume('第5集'), 5);
  assert.equal(parseNdlVolume('其ノ3'), 3);
});

test('英語の単位付き (vol. の揺れが大きい)', () => {
  for (const s of ['vol.2', 'VOL.2', 'Vol. 2', 'v.2', 'volume 2', 'Volume2', 'no.2', '#2', '[2]']) {
    assert.equal(parseNdlVolume(s), 2, `${s} が読めていない`);
  }
});

test('巻数のうしろに付く副題・装丁を落とす', () => {
  // 海街diary の実物: 「6 (四月になれば彼女は)」
  assert.equal(parseNdlVolume('6 (四月になれば彼女は)'), 6);
  assert.equal(parseNdlVolume('3 : pbk'), 3);
});

/**
 * **数として読めないものは null のままにする。**
 * 番号の体系が違うものを無理に数字へ倒すと、別の巻の表紙を貼ることになる。
 */
test('番号の線が違うものは巻にしない', () => {
  assert.equal(parseNdlVolume('上'), null);
  assert.equal(parseNdlVolume('下'), null);
  assert.equal(parseNdlVolume('第2部[3]'), null);
  assert.equal(parseNdlVolume('15-16'), null);
  // ツマヌダ格闘街は「fight 1」、カードキャプターさくらは「クリアカード編2」。
  // どちらも素の巻数と別の線なので混ぜない
  assert.equal(parseNdlVolume('fight 1'), null);
  assert.equal(parseNdlVolume('クリアカード編2'), null);
  assert.equal(parseNdlVolume(null), null);
  assert.equal(parseNdlVolume(''), null);
});

test('ISBN は 10 桁と 13 桁だけ採る', () => {
  assert.equal(normalizeIsbn('978-4-08-876529-7'), '9784088765297');
  assert.equal(normalizeIsbn('484023163X'), '484023163X');
  assert.equal(normalizeIsbn('123'), null);
  assert.equal(normalizeIsbn(null), null);
});

test('合作の著者は区切って 1 人ずつ試す', () => {
  const v = authorVariants('山川直輝×奈央晃徳');
  assert.ok(v.includes('山川直輝'), '原作者単独の候補が要る');
  assert.ok(v.length > 1, '丸ごとだけでは NDL が 0 件を返す');
});
