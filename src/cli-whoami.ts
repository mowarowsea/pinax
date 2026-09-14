/**
 * 今このマシンから外へ出ていく時のグローバル IP を出す。
 *
 * 楽天は**登録した接続元 IP からの要求しか通さない**。回線の都合でここが変わると
 * ある日を境に表紙が 1 枚も増えなくなるので、その時に何を楽天の管理画面へ
 * 貼ればいいかを一発で出せるようにしておく。
 *
 * 登録できるのは 9 行まで。変わったら足す (古いものを消すのは埋まってからでよい)。
 */
const SOURCES = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];

let ip: string | null = null;
for (const url of SOURCES) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) continue;
    const t = (await res.text()).trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) {
      ip = t;
      break;
    }
  } catch {
    // 次の相手を試す
  }
}

if (!ip) {
  console.error('グローバル IP を確かめられませんでした (外に出られていない?)');
  process.exit(1);
}

console.log(ip);
console.error('');
console.error('楽天ウェブサービスの管理画面 https://webservice.rakuten.co.jp/ の');
console.error('アプリ設定「許可IPアドレス」にこれを入れる (9 行まで登録できる)。');
