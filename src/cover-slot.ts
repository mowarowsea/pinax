import { formatVolume } from './naming.js';
import type { VolumeUnit } from './volume.js';

/**
 * 表紙の宛先。**「どの板に絵が貼ってあるか」を 1 本のキーで言う。**
 *
 * 棚に並ぶ板は 4 種類ある:
 *
 *   代表   作品の顔。棚の一覧と詳細の頭に出る 1 枚
 *   単巻   第03巻
 *   合本   第01-02巻。1 本のファイルが複数の巻を覆っている
 *   別巻   外伝・特別編・1 冊で完結している作品。巻数を持たず、呼び名で呼ぶ
 *
 * 以前 covers が持っていた宛先は `volume_no` (null なら代表) だけで、名指しできるのは
 * 前の 2 つしか無かった。合本は第01巻の絵を借りて出し、別巻は絵の入る道そのものが無い。
 * **どちらも「人が選び直す先が無い」という同じ欠けから来ている** ので、宛先を 1 本に揃える。
 *
 *   ''            代表
 *   'v:巻:3'      第03巻
 *   'v:巻:1-2'    合本 第01-02巻
 *   's:外伝'      別巻「外伝」
 *   's:'          別巻のうち呼び名が空のもの = 作品そのもの (1 冊で完結している作品)
 *
 * 揃えると covers の一意制約もこれ 1 本になり、**「代表だけ ON CONFLICT の宛先が違う」**
 * という特例が消える (SQLite は一意制約の中で NULL 同士を別物として扱うので、
 * `UNIQUE(series_id, volume_no)` は代表を縛れず、部分索引で名指しする必要があった)。
 *
 * **単位をキーに入れる。** 巻で数える作品に「第224話」が 1 つだけ混ざることが実際にあり
 * (catalog.ts の数直線の註)、番号だけを宛先にすると第224巻と第224話が同じ板を取り合う。
 */
export type CoverSlot =
  | { kind: 'series' }
  | { kind: 'volume'; from: number; to: number; unit: string }
  | { kind: 'side'; label: string };

/** 作品の代表表紙。棚の一覧に並ぶ 1 枚 */
export const SERIES_SLOT: CoverSlot = { kind: 'series' };

/** 単巻 (from === to) と合本 (from < to) はどちらもこれ。**同じ形で扱う** */
export function volumeSlot(from: number, to: number = from, unit: string = '巻'): CoverSlot {
  return { kind: 'volume', from, to, unit };
}

/** 別巻。呼び名が空なら「作品そのもの」で、**呼び名が読めなかったもの (null) は板を持たない** */
export function sideSlot(label: string): CoverSlot {
  return { kind: 'side', label };
}

/** covers.slot に入れる文字列 */
export function slotKey(slot: CoverSlot): string {
  if (slot.kind === 'series') return '';
  if (slot.kind === 'side') return `s:${slot.label}`;
  const range = slot.from === slot.to ? String(slot.from) : `${slot.from}-${slot.to}`;
  return `v:${slot.unit}:${range}`;
}

/**
 * 画面から届いたキーを読み戻す。読めなければ null。
 *
 * **別巻の呼び名に `:` が入っていても割らない。** `s:` から後ろは丸ごと呼び名で、
 * 区切り直すと「Vol:Zero」のような呼び名の別巻が二度と名指しできなくなる。
 */
export function parseSlot(key: string): CoverSlot | null {
  const s = String(key ?? '');
  if (s === '') return SERIES_SLOT;
  if (s.startsWith('s:')) return sideSlot(s.slice(2));
  const m = s.match(/^v:([^:]+):(\d{1,4})(?:-(\d{1,4}))?$/);
  if (!m) return null;
  const from = Number(m[2]);
  const to = m[3] === undefined ? from : Number(m[3]);
  if (to < from) return null;
  return volumeSlot(from, to, m[1]);
}

/**
 * covers.volume_no に入れる番号。**宛先ではなく並べ替えの鍵。**
 *
 * 代表表紙を「持っている中で一番若い巻」の絵に合わせるために要る
 * (covers.ts の refreshSeriesCover)。合本は覆う中で一番若い巻を名乗り、
 * 数直線に乗らない代表と別巻は null。
 */
export function slotVolumeNo(slot: CoverSlot): number | null {
  return slot.kind === 'volume' ? slot.from : null;
}

/**
 * 板に書く名前。**別巻の呼び名が空なら「本編」**と書く —
 * 空は「1 冊で完結している作品そのもの」で、名前が無いわけではない。
 */
export function slotLabel(slot: CoverSlot): string {
  if (slot.kind === 'series') return '代表表紙';
  if (slot.kind === 'side') return slot.label || '本編';
  return formatVolume(slot.from, slot.to, slot.unit as VolumeUnit);
}
