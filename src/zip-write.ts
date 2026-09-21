import fs from 'node:fs';

/**
 * zip を書く。**合本を割る時にしか使わない** (src/split.ts)。
 *
 * ## なぜ zip で、なぜ無圧縮なのか
 *
 * 割った先を rar にはできない。rar を作れる実装は自由に積めないし、積めば
 * 「Node.js 24 以上だけあれば動く」という前提が崩れる。**足す必要も無い** —
 * 棚の実測 (2026-09-19) で中身はほとんど JPEG で、zip の deflate でも圧縮率は
 * 93〜99.9% = ほぼ素通しだった。無圧縮で積んでも大きさはほとんど変わらないのに、
 * 再圧縮の CPU と「絵を通した」という事実だけが増える。
 *
 * ## 2 つの積み方
 *
 * | 出どころ | 積み方 | 絵 |
 * |---|---|---|
 * | zip の合本 | `addRaw` — **圧縮されたまま写す** | 触らない (CRC も元のまま) |
 * | rar の合本 | `addStored` — 取り出したものを無圧縮で | バイト列は同じ。容器だけ変わる |
 *
 * `addRaw` が肝。zip から zip へ割る時、中身は 1 バイトも展開されない。
 * 元の deflate の塊と CRC をそのまま別の箱に移すだけなので、割る前と割った後で
 * ページは**ビット単位で同じ**になる。
 *
 * ## 書かないもの
 *
 * ZIP64 は書かない。4GB を超えるか 65535 件を超えたら**途中でやめて投げる。**
 * 黙って壊れた zip を棚に置くより、割れなかったと言う方がいい。
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS の日時 (2 秒刻み)。1980 年より前は表せないので下で止める */
function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const MAX = 0xffffffff;

interface Written {
  name: Buffer;
  method: number;
  crc: number;
  packed: number;
  bytes: number;
  at: number;
  time: number;
  date: number;
}

export class ZipWriter {
  private fd: number;
  private at = 0;
  private readonly entries: Written[] = [];
  private closed = false;

  constructor(readonly dest: string) {
    this.fd = fs.openSync(dest, 'w');
  }

  /** 圧縮されたまま写す。`method` と `crc` は出どころの zip のものをそのまま渡す */
  addRaw(name: string, raw: Buffer, src: { method: number; crc: number; bytes: number }): void {
    this.put(name, raw, src.method, src.crc, src.bytes);
  }

  /** 無圧縮で積む。CRC はここで数える */
  addStored(name: string, data: Buffer): void {
    this.put(name, data, 0, crc32(data), data.length);
  }

  private put(name: string, body: Buffer, method: number, crc: number, bytes: number): void {
    if (this.closed) throw new Error('閉じた後には積めません');
    const nm = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    if (this.at + 30 + nm.length + body.length > MAX) {
      throw new Error('4GB を超えるので zip にできません (ZIP64 は書きません)');
    }
    if (this.entries.length >= 0xffff) {
      throw new Error('65535 件を超えるので zip にできません (ZIP64 は書きません)');
    }
    const { time, date } = dosTime(new Date());

    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x800, 6); // 名前は UTF-8。日本語の中身の名前をそのまま残す
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(bytes, 22);
    h.writeUInt16LE(nm.length, 26);
    h.writeUInt16LE(0, 28);

    const at = this.at;
    this.write(h);
    this.write(nm);
    this.write(body);
    this.entries.push({ name: nm, method, crc, packed: body.length, bytes, at, time, date });
  }

  private write(b: Buffer): void {
    fs.writeSync(this.fd, b, 0, b.length, null);
    this.at += b.length;
  }

  /** 目次と末尾を書いて閉じる。**これを呼ぶまで zip として読めない** */
  close(): void {
    if (this.closed) return;
    const cdAt = this.at;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4); // 作った側: MS-DOS/FAT。棚は Windows なのでこれで素直に読める
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x800, 8);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(e.time, 12);
      c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.packed, 20);
      c.writeUInt32LE(e.bytes, 24);
      c.writeUInt16LE(e.name.length, 28);
      c.writeUInt32LE(e.at, 42);
      this.write(c);
      this.write(e.name);
    }
    const cdSize = this.at - cdAt;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdAt, 16);
    this.write(eocd);

    fs.closeSync(this.fd);
    this.closed = true;
  }

  /** 途中でやめる。**書きかけを残さない** */
  abort(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      fs.closeSync(this.fd);
    } catch {
      // 既に閉じていることがある。消す方が大事なので黙る
    }
    fs.rmSync(this.dest, { force: true });
  }

  get count(): number {
    return this.entries.length;
  }
}
