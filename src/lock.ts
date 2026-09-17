/**
 * 棚 (実ファイル) を触る仕事は 1 つずつ通す。
 *
 * スキャンとリネームがかち合うと、動かしている最中のフォルダを読むことになる。
 * `files` の同一性は `(root_id, rel_path)` なので、途中の姿を読むと同じファイルが
 * **「消えた」と「増えた」の両方**に見える。present が 0 に倒れた行が残り、
 * お知らせと ntfy が「新刊が増えました」と嘘を吐く。
 *
 * **ファイルを動かしている間は所持の問い合わせにも答えない** (server.ts が 503 を返す)。
 * 黙って「持っていない」と答えると、その巻が落とし直される。
 * 分からない時は「答えられない」と言う方が安い。
 *
 * **スキャン中は答えてよい。** スキャンは 1 トランザクション (`BEGIN` 〜 `COMMIT`) で
 * 書くので、読む側には前の姿か後の姿しか見えない。途中は見えないのだから断る理由が無い。
 * 3 時間ごとに 50 秒ずつ他のサービスへ 503 を返す方が高くつく。
 * だから掴む仕事は `mutates` で分け、**断るのは実際にファイルを動かす仕事だけ**にする。
 *
 * 待ち行列は Promise のチェーン 1 本。Node は 1 本なので、これで十分足りる。
 * **再入はできない** — 掴んでいる仕事の中でもう一度掴むと止まる。
 */

let chain: Promise<unknown> = Promise.resolve();
let holder: string | null = null;
let mutating = false;

/** 今なにかが**ファイルを動かして**いるか。動かしていればその仕事の名前 */
export function shelfBusy(): string | null {
  return mutating ? holder : null;
}

/**
 * 棚を掴んで `fn` を走らせる。前の仕事が終わるまで待つ。
 *
 * `what` は待たされた相手に見せる名前なので、日本語で「何をしているか」を書く。
 * `mutates` はファイルを動かす仕事に付ける — その間だけ所持の問い合わせを断る。
 */
export function withShelfLock<T>(
  what: string,
  fn: () => Promise<T>,
  opts: { mutates?: boolean } = {}
): Promise<T> {
  const run = chain.then(async () => {
    holder = what;
    mutating = opts.mutates === true;
    try {
      return await fn();
    } finally {
      holder = null;
      mutating = false;
    }
  });
  // 前の仕事が投げても行列は止めない。**ここで catch を挟まないと、
  // 1 回の失敗で以降のスキャンが二度と走らなくなる**
  chain = run.catch(() => undefined);
  return run;
}
