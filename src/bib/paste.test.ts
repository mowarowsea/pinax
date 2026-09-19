import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Db } from '../db.js';
import { seriesKeyOf } from '../volume.js';
import type { Candidate } from './candidates.js';
import { sideCandidates, sideCoverTargets, sideLabelOfTitle } from './paste.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinax-paste-'));
const db = new Db(dir);

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 候補 1 冊。突き合わせは書名しか見ないので、それ以外は形だけ揃える */
const cand = (title: string, opts: { isbn?: string | null; imageUrl?: string | null } = {}): Candidate => ({
  provider: 'ndl',
  title,
  baseTitle: title,
  volume: null,
  author: null,
  publisher: null,
  date: null,
  year: null,
  isbn: opts.isbn ?? null,
  imageUrl: opts.imageUrl ?? null,
  link: null,
});

test('書誌の書名からも、ファイル名と同じ規則で別巻の呼び名を読む', () => {
  assert.equal(sideLabelOfTitle('鬼滅の刃外伝', '鬼滅の刃'), '外伝');
  assert.equal(sideLabelOfTitle('四月は君の嘘 Coda', '四月は君の嘘'), 'Coda');
  assert.equal(sideLabelOfTitle('鬼滅の刃', '鬼滅の刃'), '', '作品そのもの');
  assert.equal(sideLabelOfTitle('進撃の巨人', '鬼滅の刃'), null, '前置きになっていない');
});

test('呼び名の一致は畳んでから見る。表記の揺れで繋がらなくならないように', () => {
  const items = [
    cand('鬼滅の刃 外伝', { imageUrl: 'https://example/a.jpg' }),
    cand('鬼滅の刃 公式ファンブック'),
    cand('進撃の巨人 外伝'),
  ];
  assert.deepEqual(
    sideCandidates(items, '鬼滅の刃', '外伝').map((c) => c.title),
    ['鬼滅の刃 外伝'],
    '空白の入れ方が違っても繋がる。別作品の外伝は混ざらない'
  );
  assert.deepEqual(sideCandidates(items, '鬼滅の刃', 'Coda'), []);
});

test('別巻の板を組み立てる。呼び名が空のものは外に聞かない', () => {
  const { row } = db.upsertSeries({
    rootId: 'test', folder: '鬼滅の刃', seriesKey: seriesKeyOf('鬼滅の刃'),
    title: '鬼滅の刃', author: null, completed: false,
  });
  const addSide = (relPath: string, label: string) =>
    db.upsertFile({
      rootId: 'test', relPath, seriesId: row.id, volumeId: null, size: 1, mtime: null,
      ext: '.rar', part: '', partNo: null, sideLabel: label, tags: [],
    });
  addSide('鬼滅の刃/鬼滅の刃.rar', '');
  addSide('鬼滅の刃/鬼滅の刃 外伝.rar', '外伝');
  addSide('鬼滅の刃/鬼滅の刃 中高一貫!!キメツ学園物語.rar', '中高一貫!!キメツ学園物語');

  const targets = sideCoverTargets(db, row.id, '鬼滅の刃', [
    cand('鬼滅の刃外伝', { isbn: '9784088820000', imageUrl: 'https://example/g.jpg' }),
  ]);

  const labelOf = (t: (typeof targets)[number]) => (t.slot.kind === 'side' ? t.slot.label : '');
  assert.deepEqual(
    targets.map(labelOf).sort(),
    ['中高一貫!!キメツ学園物語', '外伝'].sort(),
    '呼び名が空のものは板に出さない — 作品の代表表紙を借りるので聞く必要がない'
  );

  const gaiden = targets.find((t) => labelOf(t) === '外伝')!;
  assert.equal(gaiden.source?.isbn, '9784088820000');
  assert.deepEqual(gaiden.source?.images.map((c) => c.imageUrl), ['https://example/g.jpg']);

  // 当てが見つからない呼び名も板としては返す。「取れなかった」と数えて人に見せるため
  const gakuen = targets.find((t) => labelOf(t) !== '外伝')!;
  assert.equal(gakuen.source, null);
});
