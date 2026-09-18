import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import test from 'node:test';
import { ArchiveError, contentTypeOf, isReadableArchive, readPage, readPageIndex } from './archive.js';

/**
 * zip を手で組み立てる。**実物の書庫をリポジトリに置きたくない**ので、
 * 中央ディレクトリを読む側を試すために最小の zip をその場で作る。
 *
 * 読む側が見るのは「末尾から EOCD を探して中央ディレクトリを読む」道なので、
 * ここで作る形が壊れていれば読む側も落ちる = 試験になっている。
 */
function makeZip(entries: { name: string; body: Buffer; deflate?: boolean; encrypted?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let at = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const packed = e.deflate ? zlib.deflateRawSync(e.body) : e.body;
    const crc = zlib.crc32(e.body);
    const flags = 0x800 | (e.encrypted ? 1 : 0); // 0x800 = 名前は UTF-8

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(packed.length, 18);
    lh.writeUInt32LE(e.body.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, packed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(e.deflate ? 8 : 0, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(packed.length, 20);
    cd.writeUInt32LE(e.body.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(at, 42);
    centrals.push(cd, name);

    at += lh.length + name.length + packed.length;
  }

  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(at, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinax-archive-'));
const write = (name: string, buf: Buffer): string => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
};
const img = (n: number): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(n, 0x41)]);

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

/**
 * 並びは名前だけで決まる。**格納順は当てにならない** (書庫を作った道具で変わる) ので、
 * わざと逆順で入れて、名前の順に直ることを見る。
 */
test('ページは名前の自然順に並ぶ', async () => {
  const file = write(
    'a.zip',
    makeZip([
      { name: '010.jpg', body: img(10) },
      { name: '2.jpg', body: img(10) },
      { name: '1.jpg', body: img(10) },
    ])
  );
  const idx = await readPageIndex(file, dir);
  assert.deepEqual(
    idx.pages.map((p) => p.name),
    ['1.jpg', '2.jpg', '010.jpg']
  );
  assert.equal(idx.format, 'zip');
});

/** 章ごとのフォルダに分かれている実物がある (`149-155/0006.jpg`)。フォルダも数として読む */
test('章のフォルダをまたいでも順番が崩れない', async () => {
  const file = write(
    'b.zip',
    makeZip([
      { name: 'ch10/001.jpg', body: img(10) },
      { name: 'ch2/002.jpg', body: img(10) },
      { name: 'ch2/001.jpg', body: img(10) },
    ])
  );
  const idx = await readPageIndex(file, dir);
  assert.deepEqual(
    idx.pages.map((p) => p.name),
    ['ch2/001.jpg', 'ch2/002.jpg', 'ch10/001.jpg']
  );
});

/**
 * 画像でないものを落とすだけでなく**数えて返す**。
 * 実物に中身が書庫の合本がある (`[青木朋] 天空の玉座 第01-08巻.rar`) ので、
 * 0 ページだった時に「空」なのか「中が書庫」なのかを画面が言い分けられないと困る。
 */
test('画像でないものはページにしない。中が書庫なら nested', async () => {
  const file = write(
    'c.zip',
    makeZip([
      { name: '001.jpg', body: img(10) },
      { name: 'Raw-Zip.Com.url', body: Buffer.from('x') },
      { name: '第01巻.rar', body: Buffer.from('x') },
    ])
  );
  const idx = await readPageIndex(file, dir);
  assert.deepEqual(
    idx.pages.map((p) => p.name),
    ['001.jpg']
  );
  assert.deepEqual(idx.skipped, ['Raw-Zip.Com.url', '第01巻.rar']);
  assert.equal(idx.nested, true);
});

/** 手元の zip は deflate と store が混ざっている (実測 22 件が混在)。どちらも同じ絵が出ること */
test('deflate でも store でも元のバイトが返る', async () => {
  const body = img(5000);
  const file = write(
    'd.zip',
    makeZip([
      { name: '001.jpg', body, deflate: true },
      { name: '002.jpg', body, deflate: false },
    ])
  );
  const idx = await readPageIndex(file, dir);
  assert.equal(idx.pages.length, 2);
  assert.deepEqual(await readPage(file, '001.jpg', dir), body);
  assert.deepEqual(await readPage(file, '002.jpg', dir), body);
  assert.equal(idx.pages[0].bytes, body.length);
});

/** **黙って空を返さない。** 開けない理由は画面にそのまま出せる形で持って上がる */
test('鍵の掛かった zip は理由を付けて断る', async () => {
  const file = write('e.zip', makeZip([{ name: '001.jpg', body: img(10), encrypted: true }]));
  await assert.rejects(
    () => readPage(file, '001.jpg', dir),
    (e: unknown) => e instanceof ArchiveError && e.reason.includes('パスワード')
  );
});

test('無いページを頼まれたら断る', async () => {
  const file = write('f.zip', makeZip([{ name: '001.jpg', body: img(10) }]));
  await assert.rejects(
    () => readPage(file, '999.jpg', dir),
    (e: unknown) => e instanceof ArchiveError
  );
});

test('開ける形かどうか / 中身の種類', () => {
  assert.equal(isReadableArchive('.zip'), true);
  assert.equal(isReadableArchive('.RAR'), true);
  assert.equal(isReadableArchive('.7z'), false);
  assert.equal(isReadableArchive('.pdf'), false);
  assert.equal(contentTypeOf('a/001.jpg'), 'image/jpeg');
  assert.equal(contentTypeOf('a/001.JPEG'), 'image/jpeg');
  assert.equal(contentTypeOf('a/001.png'), 'image/png');
  assert.equal(contentTypeOf('a/001.webp'), 'image/webp');
});
