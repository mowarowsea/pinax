import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readPage, readPageIndex, type PageIndex } from './archive.js';
import { Db } from './db.js';
import type { Config } from './config.js';
import { seriesKeyOf } from './volume.js';
import { groupIndex, planSplit, runSplit } from './split.js';
import { ZipWriter, crc32 } from './zip-write.js';

/** 索引を手で組み立てる。**見分ける側はファイルを触らない**ので、これだけで試せる */
function index(names: string[], opts: { skipped?: string[]; nested?: boolean } = {}): PageIndex {
  return {
    format: 'zip',
    pages: names.map((name) => ({ name, bytes: 100 })),
    skipped: opts.skipped ?? [],
    nested: opts.nested ?? false,
  };
}

test('中身が書庫の合本は、中の名前から巻番号を読んで割る', () => {
  const g = groupIndex(
    index([], { skipped: ['天空の玉座 第01巻.rar', '天空の玉座 第02巻.rar'], nested: true }),
    1,
    2
  );
  assert.equal(g.kind, 'nested');
  assert.equal(g.reason, null);
  assert.deepEqual(g.parts.map((p) => p.volume), [1, 2]);
  assert.deepEqual(g.parts[0].members, ['天空の玉座 第01巻.rar']);
});

test('中の書庫の番号が名前と合わなければ割らない', () => {
  const g = groupIndex(
    index([], { skipped: ['第03巻.rar', '第04巻.rar'], nested: true }),
    1,
    2
  );
  assert.deepEqual(g.parts, []);
  assert.match(String(g.reason), /3, 4 巻/);
});

test('中の書庫から巻番号が読めなければ割らない', () => {
  const g = groupIndex(index([], { skipped: ['a.rar', 'b.rar'], nested: true }), 1, 2);
  assert.deepEqual(g.parts, []);
  assert.match(String(g.reason), /巻番号が読めません/);
});

test('巻ごとのフォルダは、フォルダ名から巻番号を読んで割る', () => {
  const g = groupIndex(index(['第09巻/001.jpg', '第09巻/002.jpg', '第10巻/001.jpg']), 9, 10);
  assert.equal(g.kind, 'folders');
  assert.equal(g.reason, null);
  assert.deepEqual(g.parts.map((p) => p.volume), [9, 10]);
  // 巻のフォルダから先だけを新しい書庫の中の名前にする
  assert.deepEqual(g.parts[0].as, ['001.jpg', '002.jpg']);
  assert.deepEqual(g.parts[0].members, ['第09巻/001.jpg', '第09巻/002.jpg']);
});

test('全体が 1 枚の入れ物に入っていても剥がして割る', () => {
  const g = groupIndex(
    index(['ぼくの輪廻 第09-10巻/第09巻/001.jpg', 'ぼくの輪廻 第09-10巻/第10巻/001.jpg']),
    9,
    10
  );
  assert.equal(g.reason, null);
  assert.deepEqual(g.parts.map((p) => p.volume), [9, 10]);
  // 取り出す時は入れ物ごとの元の名前で引く。落とすと書庫の中で見つからない
  assert.deepEqual(g.parts[0].members, ['ぼくの輪廻 第09-10巻/第09巻/001.jpg']);
  assert.deepEqual(g.parts[0].as, ['001.jpg']);
});

test('章の階層は潰さない。潰すと別の章の 001.jpg がぶつかる', () => {
  const g = groupIndex(
    index(['第01巻/章1/001.jpg', '第01巻/章2/001.jpg', '第02巻/001.jpg']),
    1,
    2
  );
  assert.deepEqual(g.parts[0].as, ['章1/001.jpg', '章2/001.jpg']);
});

test('ベタ連番は割らない', () => {
  const g = groupIndex(index(['0001.jpg', '0002.jpg', '0003.jpg']), 1, 2);
  assert.equal(g.kind, 'flat');
  assert.deepEqual(g.parts, []);
  assert.match(String(g.reason), /フォルダ分け/);
});

test('フォルダ名から巻番号が読めなければ割らない', () => {
  const g = groupIndex(index(['前半/001.jpg', '後半/001.jpg']), 1, 2);
  assert.deepEqual(g.parts, []);
  assert.match(String(g.reason), /フォルダ名から巻番号が読めません/);
});

test('フォルダの数が巻数と合わなければ割らない', () => {
  const g = groupIndex(index(['第01巻/001.jpg', '第02巻/001.jpg', '第03巻/001.jpg']), 1, 2);
  assert.deepEqual(g.parts, []);
  assert.match(String(g.reason), /1, 2, 3 巻/);
});

// ---- 書く側 ----------------------------------------------------------------

test('書いた zip を読む側がそのまま読める', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinax-zipw-'));
  try {
    const dest = path.join(dir, 'out.zip');
    const a = Buffer.from('ページ 1 の中身');
    const b = Buffer.from('ページ 2 の中身');
    const w = new ZipWriter(dest);
    w.addStored('001.jpg', a);
    w.addStored('章2/002.jpg', b);
    w.close();

    const got = await readPageIndex(dest, dir);
    assert.deepEqual(got.pages.map((p) => p.name), ['001.jpg', '章2/002.jpg']);
    assert.deepEqual(got.pages.map((p) => p.bytes), [a.length, b.length]);
    assert.deepEqual(await readPage(dest, '001.jpg', dir), a);
    assert.deepEqual(await readPage(dest, '章2/002.jpg', dir), b);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('やめた時は書きかけを残さない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinax-zipw-'));
  try {
    const dest = path.join(dir, 'out.zip');
    const w = new ZipWriter(dest);
    w.addStored('001.jpg', Buffer.from('x'));
    w.abort();
    assert.equal(fs.existsSync(dest), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CRC は zlib と同じ値になる', async () => {
  const zlib = await import('node:zlib');
  const body = Buffer.from('Never burn. Remember Alexandria.');
  assert.equal(crc32(body), zlib.default.crc32(body));
});

// ---- 実際に割ってみる ------------------------------------------------------

/**
 * 棚を丸ごと作って割る。**ファイルを書く側なので、書いた結果まで見る。**
 *
 * 見るのは 4 つ: 出来たファイルの名前、中のページ、原本が棚から居なくなったこと、
 * 原本が attic に残っていること。どれが欠けても「静かに壊れた」になる。
 */
async function shelf(build?: (dest: string) => void): Promise<{
  dir: string; cfg: Config; db: Db; fileId: number; series: string; name: string;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinax-split-'));
  const root = path.join(dir, 'shelf');
  const series = '[試作者] 試し作品';
  const folder = path.join(root, series);
  fs.mkdirSync(folder, { recursive: true });

  const name = '[試作者] 試し作品 第01-02巻.zip';
  if (build) build(path.join(folder, name));
  else {
    const w = new ZipWriter(path.join(folder, name));
    w.addStored('第01巻/001.jpg', Buffer.from('1-1'));
    w.addStored('第01巻/002.jpg', Buffer.from('1-2'));
    w.addStored('第02巻/001.jpg', Buffer.from('2-1'));
    w.close();
  }

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
  const v = db.upsertVolume({
    seriesId: s.row.id, volumeFrom: 1, volumeTo: 2, unit: '巻', completed: false,
  });
  db.upsertFile({
    rootId: 't', relPath: path.join(series, name), seriesId: s.row.id, volumeId: v.row.id,
    size: fs.statSync(path.join(folder, name)).size, mtime: null, ext: '.zip',
    part: '', partNo: null, sideLabel: null, tags: [],
  });
  const row = db.raw.prepare('SELECT id FROM files').get() as { id: number };
  return { dir, cfg, db, fileId: row.id, series, name };
}

test('巻ごとのフォルダの合本を、実際に 2 本へ割る', async () => {
  const t = await shelf();
  const folder = path.join(t.dir, 'shelf', t.series);
  try {
    const plan = await planSplit(t.db, t.cfg, t.fileId);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.parts.map((p) => p.name), [
      '[試作者] 試し作品 第01巻.zip',
      '[試作者] 試し作品 第02巻.zip',
    ]);
    assert.deepEqual(plan.parts.map((p) => p.pages), [2, 1]);

    const r = await runSplit(t.db, t.cfg, t.fileId);
    assert.deepEqual(r.made, plan.parts.map((p) => p.name));

    // 棚に出来ていて、中のページが読める
    const one = path.join(folder, r.made[0]);
    const idx = await readPageIndex(one, path.join(t.cfg.dataDir, 'pages'));
    assert.deepEqual(idx.pages.map((p) => p.name), ['001.jpg', '002.jpg']);
    assert.deepEqual(await readPage(one, '001.jpg', path.join(t.cfg.dataDir, 'pages')), Buffer.from('1-1'));

    // 原本は棚から居なくなり、attic に残っている ("Never burn")
    assert.equal(fs.existsSync(path.join(folder, t.name)), false);
    assert.equal(fs.existsSync(r.attic), true);
    assert.equal(path.basename(r.attic), t.name);

    // 作業中の名前を残さない
    assert.deepEqual(fs.readdirSync(folder).filter((n) => n.includes('pinax-tmp')), []);
  } finally {
    t.db.close();
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test('同じ名前が既にあれば、何もせずに断る', async () => {
  const t = await shelf();
  const folder = path.join(t.dir, 'shelf', t.series);
  try {
    fs.writeFileSync(path.join(folder, '[試作者] 試し作品 第01巻.zip'), 'x');
    const plan = await planSplit(t.db, t.cfg, t.fileId);
    assert.equal(plan.ok, false);
    assert.match(String(plan.reason), /既にあります/);
    await assert.rejects(() => runSplit(t.db, t.cfg, t.fileId), /既にあります/);
    // 断った後も原本はそのまま
    assert.equal(fs.existsSync(path.join(folder, t.name)), true);
  } finally {
    t.db.close();
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test('中身が書庫の合本は、取り出すだけで分割できる', async () => {
  // 中に書庫が 2 つ入った合本を組む。zip in zip なら手で作れる
  const inner = (pages: [string, string][]): Buffer => {
    const at = path.join(os.tmpdir(), `pinax-inner-${Math.random().toString(36).slice(2)}.zip`);
    const w = new ZipWriter(at);
    for (const [n, body] of pages) w.addStored(n, Buffer.from(body));
    w.close();
    const buf = fs.readFileSync(at);
    fs.rmSync(at, { force: true });
    return buf;
  };

  const t = await shelf((dest) => {
    const w = new ZipWriter(dest);
    w.addStored('試し作品 第01巻.zip', inner([['001.jpg', '1-1'], ['002.jpg', '1-2']]));
    w.addStored('試し作品 第02巻.zip', inner([['001.jpg', '2-1']]));
    w.close();
  });
  const folder = path.join(t.dir, 'shelf', t.series);
  try {
    const plan = await planSplit(t.db, t.cfg, t.fileId);
    assert.equal(plan.kind, 'nested');
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.parts.map((p) => p.name), [
      '[試作者] 試し作品 第01巻.zip',
      '[試作者] 試し作品 第02巻.zip',
    ]);
    /**
     * **ページ数は言わない。** 取り出す書庫 1 つを数えて「1 ページ」と出すと、
     * 4 巻ぶんの合本が「どれも 1 ページ」に見えて、壊れたように読める
     */
    assert.deepEqual(plan.parts.map((p) => p.pages), [0, 0]);
    assert.equal(plan.pages, 0);

    const r = await runSplit(t.db, t.cfg, t.fileId);
    const tmp = path.join(t.cfg.dataDir, 'pages');
    const one = path.join(folder, r.made[0]);
    const idx = await readPageIndex(one, tmp);
    assert.deepEqual(idx.pages.map((p) => p.name), ['001.jpg', '002.jpg']);
    assert.deepEqual(await readPage(one, '002.jpg', tmp), Buffer.from('1-2'));

    const two = await readPageIndex(path.join(folder, r.made[1]), tmp);
    assert.equal(two.pages.length, 1);

    assert.equal(fs.existsSync(path.join(folder, t.name)), false);
    assert.equal(fs.existsSync(r.attic), true);
  } finally {
    t.db.close();
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});
