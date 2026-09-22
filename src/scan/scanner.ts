import fs from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db.js';
import type { LibraryRoot } from '../config.js';
import { CONTENT_EXT, SPLIT_EXT, parseLibraryEntry, seriesLabel } from '../naming.js';
import { seriesKeyOf } from '../volume.js';
import { withShelfLock } from '../lock.js';

/**
 * 蔵書フォルダを歩いてカタログに起こす。
 *
 * 守っていること:
 *
 * - **消えたファイルの行は消さない。** present を 0 に倒すだけ。NAS が一時的に
 *   見えないだけの時に蔵書がまるごと消えると、所持判定が「持っていない」に化けて
 *   全巻を落とし直すことになる。だから**根が丸ごと読めない時はスキャン自体を中止する**
 * - **初回は「お知らせ」を出さない。** 485 作品の登録が全部新着として流れてくると
 *   本物の新着が埋もれる。最初のスキャンは棚卸しとして静かに済ませる
 * - **ファイルを触るのと DB を書くのを分ける。** NAS への stat は 1 件ずつが遅いので、
 *   先に全部集めてから書き込みを 1 トランザクションで済ませる。DB を掴んだまま
 *   NAS を待つと、その間の読み取りが全部止まる
 */

export interface ScanResult {
  rootId: string;
  filesSeen: number;
  seriesAdded: number;
  volumesAdded: number;
  gone: number;
  /** 初回 (棚卸し) だったか。お知らせを出さない */
  baseline: boolean;
  error: string | null;
  elapsedMs: number;
}

interface FoundFile {
  rel: string;
  size: number;
  mtime: string | null;
}

/** 対象にする拡張子かどうか */
export function isContentFile(name: string): boolean {
  return CONTENT_EXT.test(name) || SPLIT_EXT.test(name);
}

/** ルートを歩いて対象ファイルを集める。読めないフォルダがあれば投げる */
export async function listFiles(root: string): Promise<FoundFile[]> {
  const out: FoundFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!isContentFile(e.name)) continue;
      let size = 0;
      let mtime: string | null = null;
      try {
        const st = await fs.stat(full);
        size = st.size;
        mtime = st.mtime.toISOString();
      } catch {
        // 走査中に消えることはある。大きさが取れなくても行は作る
      }
      out.push({ rel: path.relative(root, full), size, mtime });
    }
  };
  await walk(root);
  return out;
}

/**
 * 1 つの根を歩く。**棚を掴んでから歩く** (lock.ts) — リネームと同時に走ると、
 * 付け替えの途中のフォルダを読んで「消えた + 増えた」に見えてしまう。
 *
 * 掴むのは根ごと。scanAll で丸ごと掴むと、根の数だけ 50 秒が積み上がって
 * その間ずっと所持の問い合わせが止まる。
 */
export function scanRoot(db: Db, root: LibraryRoot): Promise<ScanResult> {
  return withShelfLock(`${root.label} を読んでいます`, () => scanLocked(db, root, null));
}

/**
 * 作品フォルダを 1 つだけ読み直す。**根は丸ごと歩かない。**
 *
 * 合本を割った直後のように「今さわった 1 作品」だけを棚に載せ直したい時のための道。
 * 全根スキャンは NAS だと数十秒かかるので、1 作品のためにそれを待たせない。
 *
 * **まだ一度も読んでいない根では断る。** 初回の全根スキャンはお知らせを出さない
 * 「棚卸し」として済ませる決まりなので (scanLocked の註)、その前に 1 フォルダだけ
 * 入れてしまうと棚卸しの印が消え、次の全根スキャンで蔵書ぜんぶが新着として流れる。
 */
export function scanFolder(db: Db, root: LibraryRoot, relDir: string): Promise<ScanResult> {
  return withShelfLock(`${root.label} の ${relDir} を読んでいます`, () => scanLocked(db, root, relDir));
}

async function scanLocked(db: Db, root: LibraryRoot, relDir: string | null): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const scanId = db.startScan(root.id, startedAt);
  const base: ScanResult = {
    rootId: root.id, filesSeen: 0, seriesAdded: 0, volumesAdded: 0,
    gone: 0, baseline: false, error: null, elapsedMs: 0,
  };

  // この根を前に見たことがあるか。無ければ今回が棚卸し
  const known = db.raw
    .prepare('SELECT COUNT(*) AS n FROM files WHERE root_id = ?')
    .get(root.id) as { n: number };
  const baseline = Number(known.n) === 0;
  base.baseline = baseline;

  if (relDir !== null && baseline) {
    const error = 'まだこの棚を読んでいません。先に棚ごと読み直してください';
    db.finishScan(scanId, { filesSeen: 0, seriesAdded: 0, volumesAdded: 0, gone: 0, error });
    return { ...base, baseline: false, error, elapsedMs: Date.now() - t0 };
  }

  const walkFrom = relDir === null ? root.path : path.join(root.path, relDir);
  let files: FoundFile[];
  try {
    files = await listFiles(walkFrom);
  } catch (e) {
    // 読めない = NAS が見えていない。**蔵書を倒さずに中止する**
    const error = relDir === null
      ? `蔵書ルートを読めません (${root.path}): ${(e as Error).message}`
      : `フォルダを読めません (${relDir}): ${(e as Error).message}`;
    db.finishScan(scanId, { filesSeen: 0, seriesAdded: 0, volumesAdded: 0, gone: 0, error });
    return { ...base, error, elapsedMs: Date.now() - t0 };
  }
  // listFiles は歩き始めた所からの相対を返す。行の同一性は**根からの相対**なので直す
  if (relDir !== null) for (const f of files) f.rel = path.join(relDir, f.rel);

  base.filesSeen = files.length;
  const newVolumesBySeries = new Map<number, { label: string; vols: string[] }>();

  db.raw.exec('BEGIN');
  try {
    for (const f of files) {
      const e = parseLibraryEntry(f.rel);
      const key = seriesKeyOf(e.series.title);
      if (!key) continue;

      // フォルダの無い直置きファイルは、作品名そのものを棚の名前として使う
      const folder = e.folder ?? seriesLabel(e.series.author, e.series.title);

      const s = db.upsertSeries({
        rootId: root.id,
        folder,
        seriesKey: key,
        title: e.series.title,
        author: e.series.author,
        completed: e.series.completed,
      });
      if (s.created) base.seriesAdded++;
      if (!baseline && s.created) {
        db.addEvent('series_added', seriesLabel(s.row.author, s.row.title), '新しい作品が棚に入りました', s.row.id);
      } else if (!baseline && s.newlyCompleted) {
        db.addEvent('series_completed', seriesLabel(s.row.author, s.row.title), '完結しました', s.row.id);
      }

      let volumeId: number | null = null;
      if (e.volumeFrom !== null && e.volumeTo !== null) {
        const v = db.upsertVolume({
          seriesId: s.row.id,
          volumeFrom: e.volumeFrom,
          volumeTo: e.volumeTo,
          unit: e.unit,
          completed: e.volumeCompleted,
        });
        volumeId = v.row.id;
        if (v.created) {
          base.volumesAdded++;
          // 新刊は作品ごとにまとめて 1 件にする。分割書庫で 5 通も飛ばさないため
          if (!baseline && !s.created) {
            const acc = newVolumesBySeries.get(s.row.id)
              ?? { label: seriesLabel(s.row.author, s.row.title), vols: [] };
            acc.vols.push(
              v.row.volumeFrom === v.row.volumeTo
                ? `第${v.row.volumeFrom}${v.row.unit}`
                : `第${v.row.volumeFrom}-${v.row.volumeTo}${v.row.unit}`
            );
            newVolumesBySeries.set(s.row.id, acc);
          }
        }
      }

      db.upsertFile({
        rootId: root.id,
        relPath: f.rel,
        seriesId: s.row.id,
        volumeId,
        size: f.size,
        mtime: f.mtime,
        ext: e.ext,
        part: e.part,
        partNo: e.partNo,
        sideLabel: e.sideLabel,
        tags: e.tags,
      });
    }

    // **倒すのは歩いた所の下だけ。** フォルダ 1 つを読み直しただけで根ごと倒すと、
    // 歩かなかった作品が全部「消えた」になる
    base.gone = relDir === null
      ? db.markGone(root.id, startedAt)
      : db.markGoneUnder(root.id, relDir + path.sep, startedAt);

    for (const [seriesId, acc] of newVolumesBySeries) {
      db.addEvent('volume_added', acc.label, `${acc.vols.sort().join(' / ')} が増えました`, seriesId);
    }

    db.raw.exec('COMMIT');
  } catch (e) {
    db.raw.exec('ROLLBACK');
    const error = `スキャンに失敗しました: ${(e as Error).message}`;
    db.finishScan(scanId, { filesSeen: files.length, seriesAdded: 0, volumesAdded: 0, gone: 0, error });
    return { ...base, seriesAdded: 0, volumesAdded: 0, gone: 0, error, elapsedMs: Date.now() - t0 };
  }

  db.finishScan(scanId, {
    filesSeen: base.filesSeen,
    seriesAdded: base.seriesAdded,
    volumesAdded: base.volumesAdded,
    gone: base.gone,
    error: null,
  });
  return { ...base, elapsedMs: Date.now() - t0 };
}

export async function scanAll(db: Db, roots: LibraryRoot[]): Promise<ScanResult[]> {
  const out: ScanResult[] = [];
  // 1 根ずつ直列に。NAS を並列に叩いても速くならず、失敗の原因だけ分かりにくくなる
  //
  // **受け入れトレイ (kind: 'inbox') は歩かない。** 落としたままの生ファイルが
  // 平置きされている場所なので、棚に載せると 1 ファイル 1 作品として 3000 件並び、
  // 本物の蔵書が埋もれる。トレイを読むのは src/inbox.ts (npm run inbox) の仕事。
  for (const r of roots) {
    if (r.kind === 'inbox') continue;
    out.push(await scanRoot(db, r));
  }
  return out;
}
