/**
 * 今このマシンから外へ出ていく時のグローバル IP を確かめる。
 *
 * 楽天は**登録した接続元 IP からの要求しか通さない**。回線の都合でここが変わると
 * ある日を境に表紙が 1 枚も増えなくなるので、弾かれた時に何を楽天の管理画面へ
 * 貼ればいいかをその場で添えられるようにしておく。
 *
 * 書誌の問い合わせではないので cache.ts は通さない (焼いても意味が無い)。
 */
const SOURCES = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];

/** 確かめられなければ null (外に出られていない) */
export async function currentPublicIp(): Promise<string | null> {
  for (const url of SOURCES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const t = (await res.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return t;
    } catch {
      // 次の相手を試す
    }
  }
  return null;
}
