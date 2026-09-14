import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * 蔵書のフォルダをエクスプローラで開く。
 *
 * **これだけは画面を見ている相手ではなく、pinax が動いている PC の側で起きる。**
 * pinax は Tailscale 越しにスマホからも開くので、ここを無条件に許すと
 * 寝室から押したボタンで居間の PC にウィンドウが積み上がる。役に立たないどころか、
 * 押した本人には何が起きたのか見えない。だから 2 つ揃った時だけ通す:
 *
 *   1. pinax が Windows で動いている (エクスプローラがある)
 *   2. **同じ機械から見ている** — 画面と PC が同一なら、開いたウィンドウは押した人に見える
 *
 * 2 の判定は接続元アドレスでやる。ループバック (127.0.0.1 / ::1) か、
 * この機械自身が持っているアドレスなら同じ機械。Tailscale の IP で
 * `http://100.x.x.x:3838/` を自分の PC のブラウザから開いた場合も、
 * 接続元はその機械自身のアドレスになるのでちゃんと通る。
 */

export interface RevealAbility {
  available: boolean;
  /** 使えない時の理由。**黙って消さない** — ボタンが出ない理由が分からないのが一番困る */
  reason: string | null;
}

/** この機械が持っているアドレスを全部集める (IPv6 のゾーン ID は落とす) */
function ownAddresses(): Set<string> {
  const out = new Set<string>(['127.0.0.1', '::1']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) out.add(normalizeAddress(ni.address));
  }
  return out;
}

/** `::ffff:127.0.0.1` や `fe80::1%eth0` を素の形に均す */
export function normalizeAddress(raw: string | undefined | null): string {
  let a = String(raw ?? '').trim().toLowerCase();
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  // IPv4-mapped IPv6。Node は `::ffff:192.168.1.5` の形で渡してくる
  if (a.startsWith('::ffff:')) a = a.slice('::ffff:'.length);
  return a;
}

/** 画面を見ている相手と pinax が同じ機械にいるか */
export function isSameMachine(remoteAddress: string | undefined | null): boolean {
  const a = normalizeAddress(remoteAddress);
  if (!a) return false;
  return ownAddresses().has(a);
}

/** 今この相手にエクスプローラを開かせてよいか */
export function revealAbility(remoteAddress: string | undefined | null): RevealAbility {
  if (process.platform !== 'win32') {
    return { available: false, reason: 'pinax が Windows で動いていません' };
  }
  if (!isSameMachine(remoteAddress)) {
    return { available: false, reason: 'pinax が動いている PC 以外からは開けません' };
  }
  return { available: true, reason: null };
}

/**
 * 蔵書ルートの中に収まっているか確かめて絶対パスにする。
 *
 * **DB に入っている値でも信用しない** (`/api/files/:id/download` と同じ立場)。
 * ここを抜かすと `..` を含むフォルダ名 1 つで棚の外を開けるようになる。
 */
export function resolveInsideRoot(rootPath: string, rel: string): string {
  const base = path.resolve(rootPath);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error('蔵書の外を指しています');
  }
  return abs;
}

/**
 * エクスプローラで開く。`select` を渡すとそのファイルを選択した状態でフォルダが開く。
 *
 * **終了を待たない。** explorer.exe は開いた後すぐ終了して終了コード 1 を返すのが
 * 普通の振る舞いで (既に開いているウィンドウへ渡した時など)、これを失敗と読むと
 * 正しく開いているのに画面へ赤いトーストが出る。投げっぱなしにして、
 * 起動そのものに失敗した時だけ (ENOENT) 拾う。
 */
export function openInExplorer(target: string, opts: { select?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    /**
     * **コマンドラインを自分で組み立てる (`windowsVerbatimArguments`)。**
     *
     * explorer.exe が受けるのは `/select,"C:\...\file.rar"` という、
     * 引用符が**パスだけ**に掛かった形。Node に引数を並べさせると
     * `"/select,C:\...\file.rar"` と全体が括られ、explorer はこれを解せずに
     * 黙ってドキュメントフォルダを開く。蔵書のフォルダ名には `[著者]` の角括弧も
     * 空白も普通に入るので、引用符は必要で、位置を間違えると別の場所が開く。
     */
    const quoted = `"${target.replace(/\\+$/, '')}"`;
    const args = [opts.select ? `/select,${quoted}` : quoted];
    const child = spawn('explorer.exe', args, {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    });
    child.on('error', (e) => reject(new Error(`エクスプローラを起動できません: ${e.message}`)));
    child.unref();
    // 起動できたかどうかだけ見る。spawn が error を投げなければ渡せている
    setImmediate(resolve);
  });
}
