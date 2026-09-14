import crypto from 'node:crypto';
import type { Db } from '../db.js';
import type { Config } from '../config.js';

/**
 * 外部 API の汎用キャッシュプロキシ。**pinax から外へ出る問い合わせは全部ここを通る。**
 *
 * これがこのプロジェクトの背骨 ("Never burn. Remember Alexandria."):
 *
 * - 一度取った応答は**生のまま**焼き付ける。解釈を後から直せるようにするため
 * - **期限切れでも捨てない。** 外が落ちている時に古い値を返せることが値打ちで、
 *   「新しくないから何も返さない」は一番やってはいけない振る舞い
 * - 相手には間を空けて聞く (provider ごとに直列 + 最低間隔)。
 *   500 作品ぶんを一息に叩いて締め出されたら、その時点で蔵書の表紙は永久に埋まらない
 *
 * DryEyes や PowerDowner から見た時も、ここが「外の世界の窓口」になる。
 */

export interface CachedResponse {
  status: number;
  body: string;
  contentType: string | null;
  /** キャッシュから返したか */
  cached: boolean;
  /** 期限は切れているが外に繋がらないので古い値を返した */
  stale: boolean;
  fetchedAt: string;
}

export interface FetchOptions {
  provider: string;
  url: string;
  /** 既定は config の bib.ttlDays */
  ttlDays?: number;
  headers?: Record<string, string>;
  /** true なら期限内のキャッシュも無視して取り直す (取れなければ古い値のまま) */
  refresh?: boolean;
}

/** 名乗り。API 本体 (OpenSearch・openBD) はこれで普通に応じてくれる */
const DEFAULT_UA = 'pinax/0.1 (personal library manager)';

/** provider ごとの「次にいつ叩いてよいか」。相手に迷惑をかけないための間引き */
const nextAllowedAt = new Map<string, number>();

async function throttle(provider: string, minIntervalMs: number): Promise<void> {
  const now = Date.now();
  const at = nextAllowedAt.get(provider) ?? 0;
  const wait = Math.max(0, at - now);
  nextAllowedAt.set(provider, Math.max(now, at) + minIntervalMs);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function keyOf(provider: string, url: string): string {
  return crypto.createHash('sha256').update(`${provider}\n${url}`).digest('hex');
}

export async function cachedFetch(db: Db, cfg: Config, opts: FetchOptions): Promise<CachedResponse> {
  const key = keyOf(opts.provider, opts.url);
  const hit = db.getCache(key);
  const fresh = hit && !opts.refresh && new Date(hit.expiresAt).getTime() > Date.now();
  if (hit && fresh) {
    return { status: hit.status, body: hit.body, contentType: hit.contentType, cached: true, stale: false, fetchedAt: hit.fetchedAt };
  }

  await throttle(opts.provider, cfg.bib.minIntervalMs);

  try {
    const res = await fetch(opts.url, {
      headers: { 'User-Agent': DEFAULT_UA, ...(opts.headers ?? {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.text();
    const ttl = (opts.ttlDays ?? cfg.bib.ttlDays) * 86_400_000;
    // 失敗応答は短く持つ。相手の一時的な不調を 90 日抱えないため
    const keepMs = res.ok ? ttl : Math.min(ttl, 3_600_000);
    db.putCache({
      key,
      provider: opts.provider,
      url: opts.url,
      status: res.status,
      contentType: res.headers.get('content-type'),
      body,
      expiresAt: new Date(Date.now() + keepMs).toISOString(),
    });
    return {
      status: res.status,
      body,
      contentType: res.headers.get('content-type'),
      cached: false,
      stale: false,
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    // 外に繋がらない。**古い値があるなら必ずそれを返す**
    if (hit) {
      return { status: hit.status, body: hit.body, contentType: hit.contentType, cached: true, stale: true, fetchedAt: hit.fetchedAt };
    }
    throw new Error(`${opts.provider} に問い合わせできません: ${(e as Error).message}`);
  }
}

/**
 * バイナリ (書影) を取る。中身はキャッシュ表に入れない — 画像はファイルとして焼くので、
 * DB に base64 で二重に抱えても意味がない。
 *
 * **`referer` を必ず渡すこと。** NDL のサムネイルは Referer の無い要求を 403 で弾く
 * (2026-09-12 に確認。UA は何を名乗っても関係なく、Referer だけで通る)。
 * ここを落とすと表紙が 1 枚も焼けないまま「取れなかった」とだけ記録されて、
 * 原因が見えないまま蔵書が表紙無しで並ぶ。
 */
export async function fetchBinary(
  cfg: Config,
  provider: string,
  url: string,
  opts: { referer?: string } = {}
): Promise<{ status: number; bytes: Buffer; contentType: string | null }> {
  await throttle(provider, cfg.bib.minIntervalMs);
  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_UA,
    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  };
  if (opts.referer) headers.Referer = opts.referer;
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, bytes, contentType: res.headers.get('content-type') };
}
