import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * 蔵書のフォルダをエクスプローラで開く。
 *
 * **これだけは画面を見ている相手ではなく、pinax が動いている PC の側で起きる。**
 * だから「誰に見せるか」は考える必要があるが、**接続元アドレスでは判定しない**。
 *
 * 一度そうしてみて外れた (2026-09-14)。手元は PC からも Tailscale の口
 * (`http://100.x.x.x:3838/`) を通して見ているので、接続元が pinax 自身の
 * アドレスになるとは限らず、**PC で見ているのにボタンが出ない**。
 * 「LAN の中か」でも同じで、経路の都合を機械が読み切れない。
 *
 * 代わりに 2 つで決める:
 *
 *   サーバー側 … Windows で動いているか (エクスプローラがあるか)。ここだけ
 *   画面側     … **指しか無いと分かった時だけ隠す** (CSS の `.pc-only`)。
 *                「マウスのある端末だと分かった時だけ出す」と書いて外した
 *                (2026-09-15) — 手元の Brave は hover / pointer を `any-` 込みで
 *                **全部 false** と答えるので、判定できない環境が丸ごと
 *                「PC ではない」側へ落ちる。分からなければ出す側へ倒す
 *
 * 判定を画面へ預けるので、スマホから叩けば口そのものは通る。LAN / Tailscale の中でしか
 * 開かないサービスで、起きることは「PC にウィンドウが 1 枚開く」だけなので、
 * ボタンが出ない不便の方が重いという判断 (本人の指定)。
 * **パスの検証 (`resolveInsideRoot`) は落とさない** — そちらは実害の話。
 */

export interface RevealAbility {
  available: boolean;
  /** 使えない時の理由。**黙って消さない** — ボタンが出ない理由が分からないのが一番困る */
  reason: string | null;
}

/** この pinax でエクスプローラを開けるか。相手ではなく**自分**の話 */
export function revealAbility(): RevealAbility {
  if (process.platform !== 'win32') {
    return { available: false, reason: 'pinax が Windows で動いていません' };
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
