import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db.js';
import type { Config } from './config.js';
import { splitFilename } from './naming.js';
import { resolveInsideRoot } from './reveal.js';
import { withShelfLock } from './lock.js';
import { moveToAttic } from './split.js';

/**
 * 同じ巻に 2 本以上ある時、**人が選んだ 1 本を残して、残りを `data/attic/` へ引く。**
 *
 * pinax がファイルを書く 3 つ目の場所 (rename.ts / split.ts と同じ立場)。
 * **人が「これを残す」を押した 1 回だけ**が通る。どちらが良いかは機械には決められない
 * (画質違い、ページの欠け、修正版) ので、画面で中を見比べてから押させる。
 *
 * 以前はエクスプローラで片方を消すしかなく、中身を見比べるには両方を解凍する
 * 必要があった。合本を割った時に単巻と当たるのが一番よく起きる形 (split.ts の clash)。
 *
 * **消さない。** 引いた先は割った原本と同じ `data/attic/`。間違えて選んでも戻せる。
 *
 * 残した方が ` (2)` 付きで、元の名前が空いたなら**元の名前に戻す。** `(2)` のまま
 * 棚に残すと、次に同じ巻が来た時にまた `(3)` が生えて、何が起きたのか読めなくなる。
 * 名前を変えても `files` の行は付け替えるだけにする (要ケアの印とページ索引を残すため)。
 */

export interface KeepResult {
  seriesId: number;
  /** 残したファイル (棚の上の名前。元の名前に戻したならそちら) */
  kept: string;
  /** 元の名前に戻したか */
  renamed: boolean;
  /** 引いた先 (attic の中の絶対パス) */
  attic: string[];
  /** 読み直すフォルダ (根からの相対)。呼ぶ側が scanFolder に渡す */
  dirs: string[];
}

export class KeepError extends Error {}

/** 分割書庫の続きは 1 本と数える (catalog.ts の fileBaseOf と同じ切り方) */
function baseOf(r: Record<string, unknown>): string {
  const rel = String(r.rel_path ?? '');
  const cut = String(r.part ?? '').length + String(r.ext ?? '').length;
  return cut > 0 ? rel.slice(0, Math.max(0, rel.length - cut)) : rel;
}

/**
 * `keepId` の 1 本 (分割書庫なら続きも) を残し、**同じ巻の他のファイルを全部**引く。
 * 棚は動かすが、DB は付け替え以外触らない — 引いた分は呼ぶ側の読み直しで消える。
 */
export async function keepOne(db: Db, cfg: Config, seriesId: number, keepId: number): Promise<KeepResult> {
  const keep = db.raw.prepare('SELECT * FROM files WHERE id = ?').get(keepId) as
    | Record<string, unknown>
    | undefined;
  // 別の作品のファイル id を渡して棚の外を触らせない
  if (!keep || Number(keep.series_id) !== seriesId) throw new KeepError('そのファイルはこの作品にありません');
  if (Number(keep.present) !== 1) throw new KeepError('そのファイルはもう棚にありません。読み直してください');
  if (keep.volume_id === null) throw new KeepError('巻として読めていないファイルです');

  const root = cfg.roots.find((r) => r.id === String(keep.root_id));
  if (!root) throw new KeepError(`そんな蔵書ルートはありません: ${String(keep.root_id)}`);

  const same = db.raw
    .prepare('SELECT * FROM files WHERE volume_id = ? AND present = 1')
    .all(Number(keep.volume_id)) as Record<string, unknown>[];
  const keepBase = baseOf(keep);
  const drop = same.filter((r) => baseOf(r) !== keepBase);
  if (!drop.length) throw new KeepError('この巻にほかのファイルはありません');

  const kept = same.filter((r) => baseOf(r) === keepBase);

  return withShelfLock(
    `同じ巻の 1 本を残しています (${path.basename(String(keep.rel_path))})`,
    async () => {
      // 先に全部あるか確かめる。**途中まで引いてから止まる**のが一番まずい
      const abs = (r: Record<string, unknown>): string => resolveInsideRoot(root.path, String(r.rel_path));
      for (const r of [...kept, ...drop]) {
        if (!fs.existsSync(abs(r))) throw new KeepError(`実ファイルが見当たりません: ${String(r.rel_path)}`);
      }

      const attic: string[] = [];
      const gone = db.raw.prepare('UPDATE files SET present = 0 WHERE id = ?');
      for (const r of drop) {
        attic.push(moveToAttic(cfg, abs(r)));
        // 棚から居なくなったことはすぐ書く。読み直しを待つ間も画面が 2 本と言わないように
        gone.run(Number(r.id));
      }
      const dirs = new Set([...kept, ...drop].map((r) => path.dirname(String(r.rel_path))));

      // 残した方の ` (2)` を外す。分割書庫は続きの名前も揃えて変えないといけないので触らない
      let keptRel = String(keep.rel_path);
      let renamed = false;
      if (kept.length === 1 && keep.part_no === null) {
        const name = path.basename(keptRel);
        const s = splitFilename(name);
        const plain = `${s.stem}${s.part}${s.ext}`;
        const bare = name.slice(0, name.length - s.ext.length);
        const to = path.join(path.dirname(keptRel), plain);
        if (plain !== name && /\s*\(\d{1,3}\)$/.test(bare) && !fs.existsSync(resolveInsideRoot(root.path, to))) {
          fs.renameSync(abs(keep), resolveInsideRoot(root.path, to));
          db.moveFile(keepId, to);
          keptRel = to;
          renamed = true;
        }
      }

      return {
        seriesId,
        kept: path.basename(keptRel),
        renamed,
        attic,
        dirs: [...dirs],
      };
    },
    { mutates: true }
  );
}
