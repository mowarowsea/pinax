import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db.js';
import type { LibraryRoot } from './config.js';
import { parseLibraryEntry, planFolderName, seriesLabel } from './naming.js';
import { seriesKeyOf } from './volume.js';
import { resolveInsideRoot } from './reveal.js';
import { withShelfLock } from './lock.js';

/**
 * 作品フォルダの名前を付け替える。
 *
 * pinax が**ファイルを書く**数少ない場所。土台は「ファイルが正」のままで、
 * ここは**人が明示的に押した 1 回だけ**が通る道にしてある。
 * 自動の巡回 (スキャン / 表紙埋め / enrich) からは決して生やさないこと —
 * 生やした瞬間に「棚を読んで DB を作る」一方向が崩れる。
 *
 * これで片付くのは 2 つ:
 *
 *   1. 作品名を間違えているフォルダ。`ブルータル 異世界で…` が実は `ブルターニュ花嫁異聞`
 *   2. 画面で完結にしたのにフォルダに `(完)` が付かない作品 (`completed_user` が
 *      ファイルと食い違ったまま住み続けている状態)
 *
 * **エクスプローラで直すより安全**なのが肝。外で名前を変えると一意キー
 * `(root_id, folder)` が変わるので、次のスキャンが別の作品として新しい行を作り、
 * 焼いた表紙も選んだ系列も完結の指定も古い行に取り残される。
 * ここを通せば `series.id` が変わらないので全部残る (db.renameSeriesFolder)。
 *
 * **ファイル名は触らない。** 作品の素性はフォルダを正とする (naming.ts) ので、
 * フォルダさえ直ればカタログは正しくなる。ファイル名まで組み立て直すと
 * 版の印 (`[LQ]` / 末尾の `w`) と分割書庫の連番を落とす道が増えるだけで、
 * 落とした情報は戻らない。ここは別の段で、別の歯止めを付けてからやる。
 */

export interface RenamePlan {
  seriesId: number;
  rootId: string;
  /** 今のフォルダ名 */
  from: string;
  /** 付け替えた後のフォルダ名 */
  to: string;
  /** `to` を読み戻した作品名。**打った文字とは限らない** (使えない文字は倒される) */
  title: string;
  author: string | null;
  completed: boolean;
  /** 一緒に rel_path が付け替わるファイルの行数 */
  files: number;
  /** 名前が変わらない。押しても何も起きない */
  noop: boolean;
  /**
   * 付け替えると巻数を読めなくなるファイルの数。
   * **0 でない時は人に確かめる** (下記 countLosing)
   */
  losesVolume: number;
  /** 付け替えると別巻の呼び名を読めなくなるファイルの数 (同上) */
  losesSide: number;
  /**
   * 人に見せる注意書き。空なら黙って進めてよい。
   * **立っている計画は確かめてからでないと通さない** (server.ts が 409 を返す)
   */
  warnings: string[];
}

export class RenameError extends Error {}

/**
 * 付け替えた後のフォルダ名で、読めなくなるファイルを数える。
 *
 * **どちらもフォルダ名を前置きとして剥がして読んでいる**ので、フォルダを変えると
 * 前置きが外れて読めなくなる:
 *
 *   volume … 単位を伴わない巻数 (`… ぐらんぶる 01.rar`。naming.ts の `bareVolumeAfterFolder`)。
 *            持っている巻が「巻数を読めなかったファイル」へ落ち、欠番の計算から抜け、
 *            所持の問い合わせにも「持っていない」と答えるようになる
 *   side  … 別巻の呼び名 (`… 鬼滅の刃 外伝.rar`。同 `sideLabelAfterFolder`)。
 *            要確認へ落ちる。害は巻より小さいが、黙って落とす筋合いも無い
 *
 * 機械には直しようがない (直すならファイル名の側)。数えて人に見せる。
 */
function countLosing(db: Db, seriesId: number, from: string, to: string): { volume: number; side: number } {
  const rows = db.raw
    .prepare('SELECT rel_path, volume_id, side_label FROM files WHERE series_id = ? AND present = 1')
    .all(seriesId) as { rel_path: string; volume_id: number | null; side_label: string | null }[];

  let volume = 0;
  let side = 0;
  for (const r of rows) {
    // 今この行が何とも結び付いていないなら、これ以上失うものは無い
    if (r.volume_id === null && r.side_label === null) continue;
    const rel = String(r.rel_path);
    const sep = rel.includes('\\') ? '\\' : '/';
    const head = from + sep;
    if (!rel.startsWith(head)) continue;
    const after = parseLibraryEntry(to + sep + rel.slice(head.length));
    if (r.volume_id !== null) {
      if (after.volumeFrom === null) volume++;
    } else if (after.sideLabel === null) {
      side++;
    }
  }
  return { volume, side };
}

/**
 * 付け替えの計画を立てる。**ファイルには触らない。**
 *
 * 通らない指定はここで全部落とす。実行の側 (applyRename) に判断を持たせない —
 * 持たせると「計画で見せた内容」と「実際に起きたこと」がずれる。
 */
export function planRename(
  db: Db,
  root: LibraryRoot,
  seriesId: number,
  input: { title: string; author?: string | null; completed: boolean }
): RenamePlan {
  const s = db.getSeries(seriesId);
  if (!s) throw new RenameError('その作品はありません');
  if (s.rootId !== root.id) throw new RenameError('その作品はこの蔵書ルートにありません');

  const title = String(input.title ?? '').trim();
  const author = (input.author ?? '').trim() || null;
  if (!title) throw new RenameError('作品名が空です');

  const to = planFolderName(author, title, input.completed);
  if (!to) throw new RenameError('その作品名ではフォルダ名を作れません');

  /**
   * **組み立てた名前を読み戻し、読み戻せた方を DB に入れる。**
   *
   * 打った文字をそのまま `series.title` に入れてはいけない。フォルダ名は
   * Windows が使えない文字を全角へ倒す (`:` → `：`) ので、打った字と
   * フォルダ名がずれる。ずれたまま入れると、次のスキャンがフォルダを読んで
   * 上書きし直し、DB が黙って変わる。**ファイルが正**なのだから、
   * ファイルに書いた方を最初から入れておく。画面には `to` を見せて確かめさせる。
   *
   * 落とすのは構造が壊れた時だけ — 作品名が消える、完結の印が往復しない。
   */
  const back = parseLibraryEntry(to + '/dummy.rar').series;
  if (!back.title || back.completed !== input.completed) {
    throw new RenameError(`その作品名ではフォルダ名を作れません: 「${to}」`);
  }

  const noop = to === s.folder;
  if (!noop && db.findSeriesByFolder(root.id, to)) {
    throw new RenameError(`同じ名前の作品が既に棚にあります: ${to}`);
  }

  const files = (
    db.raw.prepare('SELECT COUNT(*) AS n FROM files WHERE series_id = ?').get(seriesId) as { n: number }
  ).n;

  const losing = noop ? { volume: 0, side: 0 } : countLosing(db, seriesId, s.folder, to);
  const losesVolume = losing.volume;
  const losesSide = losing.side;
  const warnings: string[] = [];
  if (losesVolume) {
    warnings.push(
      `${losesVolume} 個のファイルが巻数を読めなくなります。` +
        'フォルダ名を前置きにして巻数を読んでいるファイル (「… 01.rar」) です。' +
        '欠番の計算と所持の判定から外れるので、ファイル名の側も直してください'
    );
  }
  if (losesSide) {
    warnings.push(
      `${losesSide} 個の別巻が呼び名を読めなくなります (「… 外伝.rar」)。` +
        '要確認に落ちるだけで巻には影響しませんが、ファイル名の側も直すと消えます'
    );
  }

  // 打った通りの名前が付かない時は先に言う。Windows が使えない文字は全角へ倒れ
  // (`:` → `：`)、長すぎる名前は切り詰められる。押してから気付くのでは遅い
  const asTyped = seriesLabel(author, title) + (input.completed ? '(完)' : '');
  if (to !== asTyped) warnings.push(`フォルダには「${to}」と書きます`);

  return {
    seriesId, rootId: root.id, from: s.folder, to,
    title: back.title, author: back.author ?? null, completed: input.completed,
    files: Number(files), noop, losesVolume, losesSide, warnings,
  };
}

export interface RenameResult {
  ok: true;
  from: string;
  to: string;
  files: number;
  journal: string;
}

/** 大文字小文字だけの違いか。Windows では `foo` → `Foo` も正しい付け替え */
function sameNameIgnoringCase(a: string, b: string): boolean {
  return a !== b && a.toLowerCase() === b.toLowerCase();
}

/**
 * 計画を実行する。**棚を掴んでから触る** (lock.ts) — スキャンと同時に走ると、
 * 付け替えの途中の姿を読んで「消えた + 増えた」に見える。
 *
 * 順番を守ること:
 *
 *   1. ジャーナルに**先に**書く。fs が成功して DB が失敗した時、
 *      どこへ動かしたかの記録だけは必ず残す (手で戻せる)
 *   2. DB を先に書いて、その中で fs を動かし、成功したら COMMIT。
 *      fs が失敗したら ROLLBACK してフォルダも DB も元のまま
 */
export function applyRename(
  db: Db,
  root: LibraryRoot,
  plan: RenamePlan,
  dataDir: string
): Promise<RenameResult> {
  return withShelfLock(`「${plan.from}」の名前を付け替えています`, async () => {
    if (plan.noop) {
      return { ok: true as const, from: plan.from, to: plan.to, files: 0, journal: '' };
    }

    // DB の値でも信用しない。`..` を含む名前 1 つで棚の外へ出る
    const src = resolveInsideRoot(root.path, plan.from);
    const dst = resolveInsideRoot(root.path, plan.to);
    if (!fs.existsSync(src)) throw new RenameError(`フォルダが見当たりません: ${plan.from}`);
    if (fs.existsSync(dst) && !sameNameIgnoringCase(plan.from, plan.to)) {
      throw new RenameError(`その名前のフォルダが既にあります: ${plan.to}`);
    }
    // 計画を立ててから押すまでの間に棚が動いていることがある
    if (db.findSeriesByFolder(root.id, plan.to)) {
      throw new RenameError(`同じ名前の作品が既に棚にあります: ${plan.to}`);
    }

    const journal = path.join(dataDir, 'renames.jsonl');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(
      journal,
      JSON.stringify({
        at: new Date().toISOString(), seriesId: plan.seriesId, rootId: root.id,
        from: plan.from, to: plan.to, files: plan.files,
      }) + '\n'
    );

    db.raw.exec('BEGIN');
    try {
      db.renameSeriesFolder({
        seriesId: plan.seriesId,
        folder: plan.to,
        title: plan.title,
        author: plan.author,
        seriesKey: seriesKeyOf(plan.title),
        completed: plan.completed,
      });
      fs.renameSync(src, dst);
      db.raw.exec('COMMIT');
    } catch (e) {
      db.raw.exec('ROLLBACK');
      throw new RenameError(`付け替えに失敗しました: ${(e as Error).message}`);
    }

    return { ok: true as const, from: plan.from, to: plan.to, files: plan.files, journal };
  }, { mutates: true });
}
