import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { cachedFetch } from './cache.js';
import { normalizeIsbn } from './ndl.js';

/**
 * openBD のアダプタ。**鍵が要らず、ISBN 1 本で引ける**一番軽い相手。
 *
 * ただし表紙の供給源としての実力は低い。2026-09-15 に手元の実物で数え直した:
 *
 *   表紙の無い巻の ISBN 200 件  … データは 171 件返るのに **書影は 0 件**
 *   既に表紙のある巻の ISBN 100 件 … 書影は 1 件だけ (版元ドットコム経由の書籍)
 *
 * ONIX の `CollateralDetail.SupportingResource` (表紙の画像) も 0 件だった。
 * 書影を持っているのは**版元ドットコムに登録している版元の本**で、漫画の大手はまず載らない。
 *
 * **それでも経路として繋いである。** 蔵書は漫画だけではないし、聞くのは 1 回の
 * ISBN 直引きで鍵も要らない。0.3% でも埋まる巻は埋まる。
 * 要らなければ `config.json` の `bib.providers` から `openbd` を外せば聞きに行かない。
 *
 * **書名では引けない。** openBD の口は ISBN 起点しかないので、表紙を選ぶ画面
 * (人が書名で探す道) には並ばない。
 */

const ENDPOINT = 'https://api.openbd.jp/v1/get';

export interface OpenbdRecord {
  isbn: string | null;
  title: string | null;
  author: string | null;
  publisher: string | null;
  /** 発行日。「20160104」の形で来る */
  pubdate: string | null;
  /** 書影 URL。`https://cover.openbd.jp/{ISBN13}.jpg` の形 */
  cover: string | null;
}

export function openbdReady(cfg: Config): boolean {
  return cfg.bib.providers.includes('openbd');
}

interface RawSummary {
  isbn?: string;
  title?: string;
  author?: string;
  publisher?: string;
  pubdate?: string;
  cover?: string;
}

/**
 * openBD は**問い合わせた ISBN と同じ並び**で答えを返し、持っていない ISBN の位置には
 * `null` が入る。ここでは 1 冊しか聞かないので先頭だけ見る。
 */
export function parseOpenbd(body: string): OpenbdRecord | null {
  let arr: unknown;
  try {
    arr = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const rec = arr[0] as { summary?: RawSummary } | null | undefined;
  const s = rec?.summary;
  if (!s) return null;
  return {
    isbn: normalizeIsbn(s.isbn),
    title: String(s.title ?? '').trim() || null,
    author: String(s.author ?? '').trim() || null,
    publisher: String(s.publisher ?? '').trim() || null,
    pubdate: String(s.pubdate ?? '').trim() || null,
    // **空文字で入っていることがある。** 「書影あり」と読み違えないよう落とす
    cover: String(s.cover ?? '').trim() || null,
  };
}

/** ISBN 1 本で引く。持っていなければ null (エラーにはしない — 無いのが普通) */
export async function findOpenbd(
  db: Db,
  cfg: Config,
  isbn: string,
  opts: { refresh?: boolean } = {}
): Promise<OpenbdRecord | null> {
  const norm = normalizeIsbn(isbn);
  if (!norm) return null;

  const url = new URL(ENDPOINT);
  url.searchParams.set('isbn', norm);
  const res = await cachedFetch(db, cfg, { provider: 'openbd', url: url.toString(), refresh: opts.refresh });
  if (res.status !== 200) return null;
  return parseOpenbd(res.body);
}

/** 書影 URL だけ欲しい時の近道 */
export async function findOpenbdCover(db: Db, cfg: Config, isbn: string): Promise<string | null> {
  const rec = await findOpenbd(db, cfg, isbn);
  return rec?.cover ?? null;
}
