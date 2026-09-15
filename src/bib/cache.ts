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

/**
 * **次の 1 冊を試しても同じ理由で落ちる失敗。相手のその場の不調とは必ず分けて扱う。**
 *
 * 鍵の書き間違い、接続元 IP の未申告、1 日の上限 — どれも「たまたま今の 1 冊が駄目だった」
 * のではなく、**残りを回しても全部同じところで落ちる**もの。呼び出し側はこれを見たら
 * 巡回を続けるのではなく、**その回を打ち切って人に知らせる**のが正しい。
 * 黙って回し続けると、取れるはずだった巻にまで「駄目だった」の印 (`bib.cover_tried_at`)
 * だけが押されて進み、次の巡回からは選ばれなくなる。
 *
 * 提供元ごとに継ぎ足して名前を付ける (`RakutenAuthError` / `GoogleAuthError` /
 * `GoogleQuotaError`)。**受け止める側はこの親だけを見る** —
 * 提供元を足すたびに catch を書き足さずに済む。
 * 直し方は相手ごとに違うので、**何をすればよいかは message の側が名乗る**。
 */
export class ProviderStopError extends Error {
  constructor(readonly provider: string, message: string, readonly detail: string) {
    super(message);
    this.name = 'ProviderStopError';
  }
}

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
  /**
   * キャッシュの見出しに使う URL。省略すると `url` をそのまま使う。
   *
   * **鍵をクエリに載せる提供元 (楽天) では必ず渡すこと。** 理由は 2 つ:
   *  1. `http_cache.url` に鍵がそのまま残る。DB を覗いただけで鍵が読める状態にしない
   *  2. 鍵を入れ替えた瞬間に見出しが総入れ替えになり、**焼いたキャッシュが全部迷子になる**。
   *     答えの中身は鍵に依存しないのだから、見出しも依存させてはいけない
   */
  cacheUrl?: string;
  /** 既定は config の bib.ttlDays */
  ttlDays?: number;
  headers?: Record<string, string>;
  /** true なら期限内のキャッシュも無視して取り直す (取れなければ古い値のまま) */
  refresh?: boolean;
  /**
   * **この状態コードの応答は焼かない。**
   *
   * 鍵や接続元 IP の間違いを焼いてはいけない。楽天は登録外の IP から叩くと
   * `CLIENT_IP_NOT_ALLOWED` を返すが、これは相手の不調ではなく**こちら側の設定**で、
   * 直した瞬間に通るようになる。焼いてしまうと、正しく直した後も
   * キャッシュが切れるまで「駄目だ」と言い続ける。
   *
   * 「期限切れでも捨てない」はあくまで**正しく取れた答え**の話であって、
   * 自分の設定ミスの記録を抱え込む口実ではない。
   */
  neverCacheStatuses?: number[];
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
  const shelfUrl = opts.cacheUrl ?? opts.url;
  const key = keyOf(opts.provider, shelfUrl);
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
    if (!opts.neverCacheStatuses?.includes(res.status)) {
      db.putCache({
        key,
        provider: opts.provider,
        url: shelfUrl,
        status: res.status,
        contentType: res.headers.get('content-type'),
        body,
        expiresAt: new Date(Date.now() + keepMs).toISOString(),
      });
    }
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
 *
 * `minIntervalMs` は間引きの上書き。**人が画面の前で待っている時だけ短くする** —
 * 表紙を選ぶ画面は候補を数枚まとめて出すので、巡回と同じ 1.2 秒で刻むと
 * 一覧が出るまでに十数秒かかる。焼いた後は二度と聞かないので、回数は増えない。
 */
export async function fetchBinary(
  cfg: Config,
  provider: string,
  url: string,
  opts: { referer?: string; minIntervalMs?: number } = {}
): Promise<{ status: number; bytes: Buffer; contentType: string | null }> {
  await throttle(provider, opts.minIntervalMs ?? cfg.bib.minIntervalMs);
  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_UA,
    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  };
  if (opts.referer) headers.Referer = opts.referer;
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, bytes, contentType: res.headers.get('content-type') };
}
