import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createExtractorFromFile } from 'node-unrar-js';

/**
 * 書庫の中を覗いて、ページを 1 枚ずつ出す。**読むだけ。書庫には 1 バイトも書かない。**
 *
 * ## なぜ「展開して置いておく」ではないのか
 *
 * 棚の全数を測った (2026-09-19、5767 ファイル / 452GB):
 *
 * | 中身 | 件数 | 割合 |
 * |---|---|---|
 * | zip / deflate           | 2905 | 50.4% |
 * | rar / **無圧縮 (m0)**   | 2423 | 42.0% |
 * | rar / 圧縮 (m1,m3)      |  415 |  7.2% |
 * | zip / 無圧縮・混在      |   22 |  0.4% |
 *
 * **手元の書庫はほとんど「箱」で、「圧縮された塊」ではない。** rar の 85% は無圧縮、
 * zip の deflate も中身が JPEG なので実測の圧縮率は 93〜99.9% = ほぼ素通し。
 * しかもどれもソリッドではないので、**ページ 1 枚は 1 枚だけで取り出せる。**
 *
 * だから展開したものを別に持つ必要が無い。持てば 452GB と約 110 万ファイルが増えた上に、
 * **棚の正が 2 つになる** — 整理するたび展開済みの方も消して回ることになり、
 * 漫画ファイルの隣でファイルを消す処理が常時動くことになる。それは割に合わない。
 *
 * ## 何で読むか
 *
 * | | 索引 | 1 ページ | 書き込み |
 * |---|---|---|---|
 * | zip | 素の Node (末尾の中央ディレクトリを 1 回読む) | レンジ読み + inflate | **無し** |
 * | rar | wasm の unrar | unrar に取り出させる | 取り出し先へ 1 枚 |
 *
 * zip に外部の力は要らない。末尾に目次があるので索引は 1 読み (実測 8〜10ms) で、
 * ページはその位置を読んで inflate するだけ (実測 1〜11ms)。
 *
 * rar は自前でヘッダを追う版も書いて動かしたが**捨てた**。無圧縮の 42% は速く読めるが、
 * 残り 7.2% は本物の展開が要って結局 unrar を積むことになり、**同じことをする道が
 * 2 本**残る。しかも自前の方は索引が 1.5 秒かかって unrar と大差が無かった
 * (どちらも遅いのは SMB の往復であって、解析の速さではない)。
 * 1 ページ 27〜37ms なら読む分には足りる。**速さより、道が 1 本であること。**
 *
 * ## 書き込みについて
 *
 * unrar だけはファイルへ書き出す口しか持っていない。**書き先は必ず棚の外**
 * (`data/` の下) で、しかも `filenameTransform` で名前を固定して渡す。
 * 中身の名前をそのまま使うと `../` を含む書庫が書き先の外へ抜けられるため
 * (node-unrar-js は `path.join` するだけで遡りを見ていない)。
 */

export class ArchiveError extends Error {
  constructor(
    message: string,
    /** 画面にそのまま出せる理由。**黙って空にしない** */
    readonly reason: string
  ) {
    super(message);
  }
}

export interface PageEntry {
  /** 書庫の中での名前。取り出す時の鍵でもある */
  name: string;
  /** 展開後のバイト数 */
  bytes: number;
}

export interface PageIndex {
  format: 'zip' | 'rar';
  /** 並べ替えた後のページ。画像だけ */
  pages: PageEntry[];
  /**
   * 画像ではなかった中身。**捨てずに数えて返す。** 0 ページの時に
   * 「中身が空」なのか「中に書庫が入っていた」のかが画面から読めなくなる
   */
  skipped: string[];
  /** 中身が書庫だった (実物に有り: `[久米田康治] かくしごと 第09巻.rar` の中は rar が 2 つ) */
  nested: boolean;
}

const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const ARCHIVE_RE = /\.(rar|zip|7z|cbz|cbr|tar|gz)$/i;
const SJIS = new TextDecoder('shift_jis');

export function isReadableArchive(ext: string): boolean {
  return ext.toLowerCase() === '.zip' || ext.toLowerCase() === '.rar';
}

export function contentTypeOf(name: string): string {
  const e = path.extname(name).toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.webp') return 'image/webp';
  if (e === '.gif') return 'image/gif';
  if (e === '.bmp') return 'image/bmp';
  if (e === '.avif') return 'image/avif';
  return 'image/jpeg';
}

/**
 * ページの並び。**名前だけで決める。**
 *
 * 書庫の中の格納順は当てにならない (作った道具によって変わる) が、名前は
 * 人が読む前提で振られているので `001.jpg` `002.jpg` と並んでいる。
 * 章ごとのフォルダに分かれている実物もある (`149-155/0006.jpg`) ので
 * パスを丸ごと比べ、`2/` と `10/` が入れ替わらないよう数字は数として読む。
 */
function sortPages(a: PageEntry, b: PageEntry): number {
  const c = a.name.localeCompare(b.name, 'ja', { numeric: true, sensitivity: 'base' });
  return c !== 0 ? c : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function toIndex(format: 'zip' | 'rar', all: { name: string; bytes: number }[]): PageIndex {
  const pages = all.filter((e) => IMAGE_RE.test(e.name)).sort(sortPages);
  const skipped = all.filter((e) => !IMAGE_RE.test(e.name)).map((e) => e.name);
  return { format, pages, skipped, nested: skipped.some((n) => ARCHIVE_RE.test(n)) };
}

// ---- zip ------------------------------------------------------------------

export interface ZipEntry {
  name: string;
  bytes: number;
  packed: number;
  method: number;
  /** 中央ディレクトリに書いてある CRC。**圧縮されたまま写す時に要る** (split.ts) */
  crc: number;
  /** ローカルヘッダの位置。実データはこの先にある (可変長の後ろ) */
  localHeader: number;
  encrypted: boolean;
}

/**
 * zip の目次を読む。末尾から EOCD を探して中央ディレクトリを 1 回で読む。
 * **前から舐めない** — 100MB を頭から読むのと、末尾の数十 KB を読むのとでは
 * SMB 越しに桁が違う (実測 8〜10ms)。
 */
function zipEntries(file: string): ZipEntry[] {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557); // EOCD 22 + コメント最大 65535
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ArchiveError(`zip の目次が見つかりません: ${file}`, 'zip として読めませんでした');

    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOff = tail.readUInt32LE(eocd + 16);

    // 4GB / 65535 件を超える書庫は ZIP64 で、本当の値は別の記録に入っている
    if (cdOff === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
      for (let i = eocd - 20; i >= 0; i--) {
        if (tail.readUInt32LE(i) === 0x07064b50) {
          const at = Number(tail.readBigUInt64LE(i + 8));
          const h = Buffer.alloc(56);
          fs.readSync(fd, h, 0, 56, at);
          count = Number(h.readBigUInt64LE(32));
          cdSize = Number(h.readBigUInt64LE(40));
          cdOff = Number(h.readBigUInt64LE(48));
          break;
        }
      }
    }

    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);

    const out: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const flags = cd.readUInt16LE(p + 8);
      const nlen = cd.readUInt16LE(p + 28);
      const raw = cd.subarray(p + 46, p + 46 + nlen);
      // 0x800 が立っていれば UTF-8。立っていないものは作った PC の文字集合で、
      // 手元は日本語 Windows なので CP932 と読む (latin1 で読むと名前が化ける)
      const name = (flags & 0x800 ? raw.toString('utf8') : SJIS.decode(raw)).replace(/\\/g, '/');
      out.push({
        name,
        bytes: cd.readUInt32LE(p + 24),
        packed: cd.readUInt32LE(p + 20),
        method: cd.readUInt16LE(p + 10),
        crc: cd.readUInt32LE(p + 16),
        localHeader: cd.readUInt32LE(p + 42),
        encrypted: Boolean(flags & 1),
      });
      p += 46 + nlen + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
    }
    return out.filter((e) => !e.name.endsWith('/'));
  } finally {
    fs.closeSync(fd);
  }
}

function zipRead(file: string, entry: ZipEntry): Buffer {
  if (entry.encrypted) {
    throw new ArchiveError(`鍵の掛かった zip: ${entry.name}`, 'パスワードが掛かっていて開けません');
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ArchiveError(`未対応の圧縮方式 ${entry.method}: ${entry.name}`, `この zip の圧縮方式 (${entry.method}) は読めません`);
  }
  const fd = fs.openSync(file, 'r');
  try {
    // 実データの位置はローカルヘッダを見ないと分からない (名前と拡張領域の長さが
    // 中央ディレクトリ側と違うことがある)
    const h = Buffer.alloc(30);
    fs.readSync(fd, h, 0, 30, entry.localHeader);
    if (h.readUInt32LE(0) !== 0x04034b50) {
      throw new ArchiveError(`ローカルヘッダが壊れています: ${entry.name}`, '書庫が壊れているようです');
    }
    const at = entry.localHeader + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
    const buf = Buffer.alloc(entry.packed);
    fs.readSync(fd, buf, 0, entry.packed, at);
    return entry.method === 0 ? buf : zlib.inflateRawSync(buf);
  } finally {
    fs.closeSync(fd);
  }
}

// ---- rar ------------------------------------------------------------------

/** 取り出し先で使う固定の名前。書庫の中の名前は**絶対に使わない** (遡られる) */
const RAR_OUT = 'page.bin';

async function rarEntries(file: string, tmpDir: string): Promise<{ name: string; bytes: number }[]> {
  const ex = await createExtractorFromFile({ filepath: file, targetPath: tmpDir });
  const out: { name: string; bytes: number }[] = [];
  for (const h of ex.getFileList().fileHeaders) {
    if (h.flags.directory) continue;
    if (h.flags.encrypted) {
      throw new ArchiveError(`鍵の掛かった rar: ${h.name}`, 'パスワードが掛かっていて開けません');
    }
    out.push({ name: h.name.replace(/\\/g, '/'), bytes: h.unpSize });
  }
  return out;
}

async function rarRead(file: string, name: string, tmpDir: string): Promise<Buffer> {
  // 同じページを 2 人が同時に頼んでも踏み合わないよう、取り出し先は毎回別にする
  const dir = fs.mkdtempSync(path.join(tmpDir, 'p-'));
  try {
    const ex = await createExtractorFromFile({
      filepath: file,
      targetPath: dir,
      filenameTransform: () => RAR_OUT,
    });
    // unrar の中の名前は `\` 区切りなので、比べる前に揃える
    const want = name.replace(/\\/g, '/');
    const got = [...ex.extract({ files: (h) => h.name.replace(/\\/g, '/') === want }).files];
    if (!got.length) throw new ArchiveError(`そのページはありません: ${name}`, '書庫の中にそのページがありません');
    const at = path.join(dir, RAR_OUT);
    if (!fs.existsSync(at)) throw new ArchiveError(`取り出せませんでした: ${name}`, 'ページを取り出せませんでした');
    return fs.readFileSync(at);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 表 -------------------------------------------------------------------

/**
 * 書庫の中のページ一覧。
 *
 * **rar は 1 冊あたり 1 秒前後かかる** (SMB 越しにヘッダを追うため。実測の中央値
 * 1.3 秒、大きいもので 20 秒超)。中身は変わらないので**呼ぶ側が覚えておくこと**
 * — ここでは覚えない (ファイルが正、という土台を DB の都合で曲げないため)。
 */
export async function readPageIndex(
  file: string,
  tmpDir: string,
  /**
   * 形式を名前ではなく呼ぶ側が決める。**作業中のファイルを確かめる時に要る** —
   * 合本を割った直後の中身は `... 第01巻.zip.pinax-tmp` という名前で、
   * 拡張子からは形式が読めない (src/split.ts)
   */
  opts: { as?: string } = {}
): Promise<PageIndex> {
  const ext = String(opts.as ?? path.extname(file)).toLowerCase();
  if (ext === '.zip') return toIndex('zip', zipEntries(file));
  if (ext === '.rar') return toIndex('rar', await rarEntries(file, tmpDir));
  throw new ArchiveError(`読めない書庫: ${ext}`, `${ext || 'この形式'} は開けません`);
}

/** ページ 1 枚を取り出す。返るのは画像そのもののバイト列 */
export async function readPage(file: string, name: string, tmpDir: string): Promise<Buffer> {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.rar') return rarRead(file, name, tmpDir);
  if (ext === '.zip') {
    const want = name.replace(/\\/g, '/');
    const entry = zipEntries(file).find((e) => e.name === want);
    if (!entry) throw new ArchiveError(`そのページはありません: ${name}`, '書庫の中にそのページがありません');
    return zipRead(file, entry);
  }
  throw new ArchiveError(`読めない書庫: ${ext}`, `${ext || 'この形式'} は開けません`);
}

// ---- 割る側が使う口 --------------------------------------------------------

/**
 * 合本を割る時だけ使う口 (src/split.ts)。**ここも読むだけ**で、書くのは
 * 呼んだ側が指した `dest` — 棚の外か、棚の中でも `.tmp` の付いた作業中の名前だけ。
 *
 * 普段の読み (`readPageIndex` / `readPage`) と分けてあるのは、割る時に要るものが
 * 「画像 1 枚のバイト列」ではないため: zip なら**圧縮されたまま**写したいし
 * (絵に触らず、CRC も元のまま引き継げる)、入れ子の書庫は数百 MB あるので
 * メモリに載せずに流したい。
 */

/** zip の目次。圧縮されたまま写すのに要るものが全部入っている */
export function readZipEntries(file: string): ZipEntry[] {
  return zipEntries(file);
}

/** 実データの位置。ローカルヘッダを読まないと分からない (zipRead と同じ理屈) */
function zipDataAt(fd: number, entry: ZipEntry): number {
  const h = Buffer.alloc(30);
  fs.readSync(fd, h, 0, 30, entry.localHeader);
  if (h.readUInt32LE(0) !== 0x04034b50) {
    throw new ArchiveError(`ローカルヘッダが壊れています: ${entry.name}`, '書庫が壊れているようです');
  }
  return entry.localHeader + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
}

/**
 * zip の中身を**圧縮されたまま**取り出す。展開も再圧縮もしない。
 *
 * これで写した中身は元とビット単位で同じものになる。zip の合本を割る時に
 * 絵へ触らずに済むのはこのため。
 */
export function readZipRaw(file: string, entry: ZipEntry): Buffer {
  if (entry.encrypted) {
    throw new ArchiveError(`鍵の掛かった zip: ${entry.name}`, 'パスワードが掛かっていて開けません');
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ArchiveError(`未対応の圧縮方式 ${entry.method}: ${entry.name}`, `この zip の圧縮方式 (${entry.method}) は読めません`);
  }
  const fd = fs.openSync(file, 'r');
  try {
    const at = zipDataAt(fd, entry);
    const buf = Buffer.alloc(entry.packed);
    fs.readSync(fd, buf, 0, entry.packed, at);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 書庫の中身 1 つを**ファイルへ**出す。入れ子の書庫 (中に rar が 8 つ) を
 * 取り出すためのもので、1 つが数百 MB あるので**メモリに載せずに流す。**
 *
 * `dest` は呼んだ側の責任。unrar と同じで、書庫の中の名前は使わない。
 */
export async function extractEntryTo(
  file: string,
  name: string,
  dest: string,
  tmpDir: string
): Promise<void> {
  const ext = path.extname(file).toLowerCase();
  const want = name.replace(/\\/g, '/');

  if (ext === '.rar') {
    // unrar はファイルへしか出せない。固定名で出してから置き場所へ移す
    const dir = fs.mkdtempSync(path.join(tmpDir, 'x-'));
    try {
      const ex = await createExtractorFromFile({
        filepath: file,
        targetPath: dir,
        filenameTransform: () => RAR_OUT,
      });
      const got = [...ex.extract({ files: (h) => h.name.replace(/\\/g, '/') === want }).files];
      if (!got.length) throw new ArchiveError(`そんな中身はありません: ${name}`, '書庫の中にそれがありません');
      const at = path.join(dir, RAR_OUT);
      if (!fs.existsSync(at)) throw new ArchiveError(`取り出せませんでした: ${name}`, '中身を取り出せませんでした');
      await fs.promises.copyFile(at, dest);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return;
  }

  if (ext === '.zip') {
    const entry = zipEntries(file).find((e) => e.name === want);
    if (!entry) throw new ArchiveError(`そんな中身はありません: ${name}`, '書庫の中にそれがありません');
    if (entry.encrypted) {
      throw new ArchiveError(`鍵の掛かった zip: ${entry.name}`, 'パスワードが掛かっていて開けません');
    }
    if (entry.method !== 0 && entry.method !== 8) {
      throw new ArchiveError(`未対応の圧縮方式 ${entry.method}: ${entry.name}`, `この zip の圧縮方式 (${entry.method}) は読めません`);
    }
    const fd = fs.openSync(file, 'r');
    let at: number;
    try {
      at = zipDataAt(fd, entry);
    } finally {
      fs.closeSync(fd);
    }
    const src = fs.createReadStream(file, { start: at, end: at + entry.packed - 1 });
    const out = fs.createWriteStream(dest);
    await pipeline(entry.method === 0 ? [src, out] : [src, zlib.createInflateRaw(), out]);
    return;
  }

  throw new ArchiveError(`読めない書庫: ${ext}`, `${ext || 'この形式'} は開けません`);
}
