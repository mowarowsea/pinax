import fs from 'node:fs';
import path from 'node:path';

/**
 * 棚の中でファイルの名前を変える。**行き先に別のファイルがあれば投げる。**
 *
 * Node の `fs.rename` は、Windows では行き先を黙って置き換える (MoveFileEx の
 * REPLACE_EXISTING)。置き換わった方は二度と戻らないので、これが漫画ファイルを消す道になる。
 * 名前を変える側 (rename.ts / split.ts / inbox.ts) は計画の時点で空いた名前を選んでいるが、
 * それでも当たることはある:
 *
 *   - 前のスキャンの後に置かれたファイルは DB に載っておらず、計画からは見えない
 *   - 計画から実行までの間 (分割なら数分) に、PowerDowner が同じ名前を置く
 *   - トレイの仕分け (`inbox sort`) は棚を見て名前を選ぶが、置く先はトレイの中
 *
 * 大文字小文字だけ違う名前は Windows では同じファイルなので通す (`foo` → `Foo` は正しい付け替え)。
 * 確かめてから動かすまでの間は空くが、計画から実行までの隙と比べれば無いに等しい。
 */
export function renameNoClobber(src: string, dst: string): void {
  if (fs.existsSync(dst) && !sameEntry(src, dst)) {
    throw new Error(`行き先に同じ名前のファイルがあります: ${path.basename(dst)}`);
  }
  fs.renameSync(src, dst);
}

/** 同じ場所を指しているか。**Windows は大文字小文字を区別しない** */
export function sameEntry(a: string, b: string): boolean {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}
