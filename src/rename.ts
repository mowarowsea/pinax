import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db.js';
import type { LibraryRoot } from './config.js';
import {
  parseFilename, parseLibraryEntry, planFolderName, planSideName, planVolumeName,
  restAfterFolderTitle, seriesLabel, uniqueName,
} from './naming.js';
import type { VolumeUnit } from './volume.js';
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
 * **ファイル名も一緒に付け替える。** 作品の素性はフォルダを正とする (naming.ts) ので
 * カタログはフォルダだけでも正しくなるが、棚に並ぶ実物が古い作品名のまま残る。
 * 手で直せばエクスプローラで直したのと同じ危うさに戻るので、ここで面倒を見る。
 *
 * 歯止めは 3 つ:
 *
 *   1. **名前は組み立てず、写す。** 版の印 (`[LQ]` / 末尾の `w`) は
 *      `ParsedName.tail` を、分割書庫の連番と拡張子は `splitFilename` の結果を
 *      そのまま戻す。組み直すのは `[著者] 作品名` と巻数表現だけ
 *   2. **追従できないファイルには触らない。** 作品名が前置きになっていない
 *      ファイル (`[BETEMIUS] 同人誌/[BETEMIUS] 夕立の手紙.rar`) は、何を削って
 *      何を残せばいいのか機械には決められない。**数えて人に見せる** (RenamePlan.stuck)
 *   3. **同じ名前を作らない。** 既にある名前と当たったら ` (2)` を付ける
 *      (naming.ts uniqueName)。上書きは一度やると戻せない
 */

/** ファイル 1 本の付け替え。持つのは**フォルダの中の名前だけ** (置き場所は from/to が決める) */
export interface FileRename {
  id: number;
  /** 今のファイル名 */
  from: string;
  /** 付け替えた後のファイル名 */
  to: string;
}

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
  /** 名前まで付け替わるファイル。**実際に動かすのはこれで全部** */
  moves: FileRename[];
  /**
   * 名前を追従させられないファイル。作品名が前置きになっていないもので、
   * **今の名前のまま残る**。画面に並べて人に見せる (何を手で直せばいいか分かるように)
   */
  stuck: string[];
  /** フォルダもファイルも名前が変わらない。押しても何も起きない */
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

interface FileRow {
  id: number;
  rel_path: string;
  volume_id: number | null;
  side_label: string | null;
  volume_from: number | null;
  volume_to: number | null;
  unit: string | null;
}

/**
 * フォルダの中のファイル名を、新しい作品名へ追従させる計画を立てる。
 *
 * 見分けは 3 通りで、**上から順に当てる**:
 *
 *   巻として読めている … 棚の形へ組み立て直す (`[著者] 作品名 第01巻`)。
 *     巻数は **DB の値**を使う。ファイル名から読み直すと、フォルダ名を前置きにして
 *     読んでいた巻 (`… ぐらんぶる 01.rar`) が読めず、持っている巻を落としてしまう。
 *     頭にゴミの付いた名前 (`(一般コミック) [作者] …`) もここで決まり通りになる
 *   別巻・単巻       … 前置きだけ差し替える。呼び名 (`外伝`) は一字も変えない
 *   それ以外         … **触らない。** 作品名が前置きになっていないファイル
 *     (`[BETEMIUS] 同人誌/[BETEMIUS] 夕立の手紙.rar`) は、どこまでが作品名で
 *     どこからが残りなのかを機械が決められない。名付け直せば別作品のものを取り込む
 */
function planFileRenames(
  db: Db,
  seriesId: number,
  from: string,
  to: { author: string | null; title: string; completed: boolean }
): { moves: FileRename[]; stuck: string[] } {
  const rows = db.raw
    .prepare(
      `SELECT f.id, f.rel_path, f.volume_id, f.side_label, v.volume_from, v.volume_to, v.unit
         FROM files f LEFT JOIN volumes v ON v.id = f.volume_id
        WHERE f.series_id = ? AND f.present = 1
        ORDER BY f.rel_path`
    )
    .all(seriesId) as unknown as FileRow[];

  // 前置きとして剥がすのは**作品名だけ**。著者と (完) は parseFilename が落とす
  const folderTitle = parseFilename(from).title;

  const wants: { id: number; from: string; to: string | null }[] = [];
  for (const r of rows) {
    const rel = String(r.rel_path);
    const sep = rel.includes('\\') ? '\\' : '/';
    const head = from + sep;
    if (!rel.startsWith(head)) continue;
    const base = rel.slice(head.length);
    // 作品フォルダの直下だけを見る。下に掘られた階層は作品の形が違う
    if (base.includes('\\') || base.includes('/')) continue;

    const p = parseFilename(base);
    let want: string | null = null;
    if (r.volume_from !== null) {
      want = planVolumeName(to.author, to.title, Number(r.volume_from), Number(r.volume_to), {
        unit: (r.unit as VolumeUnit) ?? '巻',
        /**
         * 最終巻の印は**元から付いていたものだけ**残す。付いていない巻に足しはしない
         * (どれが最終巻かは人しか知らない) が、作品を継続中へ戻す時は落とす —
         * 残すと次のスキャンが「ファイルに印がある」と読んで完結へ戻してしまい、
         * 画面で外したはずの指定が黙って復活する (naming.ts parseLibraryEntry)
         */
        completed: to.completed && p.completed,
        // 版の印 (`[LQ]` / 末尾の `w`) はここでそのまま戻る
        tail: p.tail,
      });
    } else {
      // 呼び名は DB にあればそれを使う。無いものは前置きを剥がした残りをそのまま回す
      const rest = r.side_label !== null
        ? String(r.side_label)
        : restAfterFolderTitle(p.title, folderTitle);
      if (rest !== null) want = planSideName(to.author, to.title, rest);
    }
    // 分割書庫の連番と拡張子は読み戻したものをそのまま戻す。組み立て直さない
    wants.push({ id: Number(r.id), from: base, to: want === null ? null : want + p.part + p.ext });
  }

  /**
   * **今そこにある名前は全部埋まっているものとして避ける** (自分の名前だけは例外)。
   *
   * 避けないと「A を B の名前へ、B を C の名前へ」と回った時に、A が B を
   * 上書きして 1 本消える。当たった時は ` (2)` を付ける — 同じ巻が 2 本あることは
   * 棚の「要確認」に出るので、どちらを捨てるかは中身を見た人が決められる。
   */
  const taken = new Set(wants.map((w) => w.from));
  const moves: FileRename[] = [];
  const stuck: string[] = [];
  for (const w of wants) {
    if (w.to === null) {
      stuck.push(w.from);
      continue;
    }
    const name = uniqueName('', w.to, (x) => x !== w.from && taken.has(x));
    taken.add(name);
    if (name !== w.from) moves.push({ id: w.id, from: w.from, to: name });
  }
  return { moves, stuck };
}

/**
 * 付け替えた後の名前で、読めなくなるファイルを数える。
 *
 * **巻も呼び名もフォルダ名を前置きとして剥がして読んでいる**ので、名前を変えると
 * 読み方そのものが変わる:
 *
 *   volume … 単位を伴わない巻数 (`… ぐらんぶる 01.rar`。naming.ts の `bareVolumeAfterFolder`)。
 *            持っている巻が「巻数を読めなかったファイル」へ落ち、欠番の計算から抜け、
 *            所持の問い合わせにも「持っていない」と答えるようになる
 *   side  … 別巻の呼び名 (`… 鬼滅の刃 外伝.rar`。同 `sideLabelAfterFolder`)。
 *            要確認へ落ちる。害は巻より小さいが、黙って落とす筋合いも無い
 *
 * **ファイル名を追従させるようになって、ここはほとんど 0 で通る。** それでも
 * 残してあるのは、追従できなかったファイル (`stuck`) と、長すぎて詰められた名前が
 * 同じ落ち方をするため。**この口の約束は「DB に入るのは次のスキャンが出す答えと
 * 同じ」**で、それが崩れる時は押す前に言う。
 */
function countLosing(
  db: Db,
  seriesId: number,
  from: string,
  to: string,
  moves: FileRename[]
): { volume: number; side: number } {
  const renamed = new Map(moves.map((m) => [m.from, m.to]));
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
    const base = rel.slice(head.length);
    const after = parseLibraryEntry(to + sep + (renamed.get(base) ?? base));
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

  const sameFolder = to === s.folder;
  if (!sameFolder && db.findSeriesByFolder(root.id, to)) {
    throw new RenameError(`同じ名前の作品が既に棚にあります: ${to}`);
  }

  /**
   * ファイル名は**読み戻した方** (back) から組み立てる。打った文字から組むと、
   * フォルダだけが全角へ倒れてファイル名と食い違い、前置きが剥がれなくなる。
   */
  const { moves, stuck } = planFileRenames(db, seriesId, s.folder, {
    author: back.author ?? null, title: back.title, completed: input.completed,
  });

  const files = (
    db.raw.prepare('SELECT COUNT(*) AS n FROM files WHERE series_id = ?').get(seriesId) as { n: number }
  ).n;

  // フォルダ名が同じでも、ファイル名だけ直す付け替えはありうる
  // (エクスプローラでフォルダだけ直した後がこの形)。**両方動かない時だけ** noop
  const noop = sameFolder && moves.length === 0;

  const losing = noop ? { volume: 0, side: 0 } : countLosing(db, seriesId, s.folder, to, moves);
  const losesVolume = losing.volume;
  const losesSide = losing.side;
  const warnings: string[] = [];
  if (losesVolume) {
    warnings.push(
      `${losesVolume} 個のファイルが巻数を読めなくなります。` +
        '名前を追従させられなかったファイルです。' +
        '欠番の計算と所持の判定から外れるので、そのファイルは手で直してください'
    );
  }
  if (losesSide) {
    warnings.push(
      `${losesSide} 個の別巻が呼び名を読めなくなります (「… 外伝.rar」)。` +
        '要確認に落ちるだけで巻には影響しません'
    );
  }

  // 打った通りの名前が付かない時は先に言う。Windows が使えない文字は全角へ倒れ
  // (`:` → `：`)、長すぎる名前は切り詰められる。押してから気付くのでは遅い
  const asTyped = seriesLabel(author, title) + (input.completed ? '(完)' : '');
  if (to !== asTyped) warnings.push(`フォルダには「${to}」と書きます`);

  return {
    seriesId, rootId: root.id, from: s.folder, to,
    title: back.title, author: back.author ?? null, completed: input.completed,
    files: Number(files), moves, stuck, noop, losesVolume, losesSide, warnings,
  };
}

export interface RenameResult {
  ok: true;
  from: string;
  to: string;
  files: number;
  /** 名前を付け替えたファイルの本数 */
  renamed: number;
  /** DB にはあるのに棚から消えていたファイル。動かしようがないので飛ばした本数 */
  missing: number;
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
 *      どこへ何という名前で動かしたかの記録だけは必ず残す (手で戻せる)
 *   2. DB を先に書いて、その中で fs を動かし、成功したら COMMIT。
 *      fs が途中で転んだら**動かしたものを逆順に戻してから** ROLLBACK —
 *      フォルダ名だけ変わってファイル名が古いまま、という半端な姿を残さない
 */
export function applyRename(
  db: Db,
  root: LibraryRoot,
  plan: RenamePlan,
  dataDir: string
): Promise<RenameResult> {
  return withShelfLock(`「${plan.from}」の名前を付け替えています`, async () => {
    const blank = {
      ok: true as const, from: plan.from, to: plan.to,
      files: 0, renamed: 0, missing: 0, journal: '',
    };
    if (plan.noop) return blank;

    // DB の値でも信用しない。`..` を含む名前 1 つで棚の外へ出る
    const src = resolveInsideRoot(root.path, plan.from);
    const dst = resolveInsideRoot(root.path, plan.to);
    const movesFolder = plan.from !== plan.to;
    if (!fs.existsSync(src)) throw new RenameError(`フォルダが見当たりません: ${plan.from}`);
    if (movesFolder) {
      if (fs.existsSync(dst) && !sameNameIgnoringCase(plan.from, plan.to)) {
        throw new RenameError(`その名前のフォルダが既にあります: ${plan.to}`);
      }
      // 計画を立ててから押すまでの間に棚が動いていることがある
      if (db.findSeriesByFolder(root.id, plan.to)) {
        throw new RenameError(`同じ名前の作品が既に棚にあります: ${plan.to}`);
      }
    }

    const journal = path.join(dataDir, 'renames.jsonl');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(
      journal,
      JSON.stringify({
        at: new Date().toISOString(), seriesId: plan.seriesId, rootId: root.id,
        from: plan.from, to: plan.to, files: plan.files,
        // 手で戻せるように、ファイル 1 本ずつの新旧も残す
        moves: plan.moves.map((m) => [m.from, m.to]),
      }) + '\n'
    );

    // 動かしたものを控えて、転んだら逆順に戻す
    const undo: (() => void)[] = [];
    let renamed = 0;
    let missing = 0;

    db.raw.exec('BEGIN');
    try {
      db.renameSeriesFolder({
        seriesId: plan.seriesId,
        folder: plan.to,
        title: plan.title,
        author: plan.author,
        seriesKey: seriesKeyOf(plan.title),
        completed: plan.completed,
        moves: Object.fromEntries(plan.moves.map((m) => [m.from, m.to])),
      });
      if (movesFolder) {
        fs.renameSync(src, dst);
        undo.push(() => fs.renameSync(dst, src));
      }
      for (const m of plan.moves) {
        const a = resolveInsideRoot(dst, m.from);
        const b = resolveInsideRoot(dst, m.to);
        // 棚から消えているファイル 1 本で全体を倒さない。rel_path は付け替えておいて、
        // 消えたことは次のスキャンに言わせる (present を倒すのはあちらの仕事)
        if (!fs.existsSync(a)) {
          missing++;
          continue;
        }
        fs.renameSync(a, b);
        undo.push(() => fs.renameSync(b, a));
        renamed++;
      }
      db.raw.exec('COMMIT');
    } catch (e) {
      // **fs を先に戻す。** 戻し切れなかった分はジャーナルに残っている
      for (const back of undo.reverse()) {
        try {
          back();
        } catch {
          /* ここで投げると元の理由が消える。残りも戻しに行く */
        }
      }
      db.raw.exec('ROLLBACK');
      throw new RenameError(`付け替えに失敗しました: ${(e as Error).message}`);
    }

    return { ...blank, files: plan.files, renamed, missing, journal };
  }, { mutates: true });
}
