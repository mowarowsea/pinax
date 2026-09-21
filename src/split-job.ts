import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { withShelfLock } from './lock.js';
import type { SplitProgress, SplitResult } from './split.js';

/**
 * 合本を分割する仕事を**子プロセスで**走らせる。
 *
 * ## なぜ常駐サーバーの中でやらないか
 *
 * `node-unrar-js` は wasm の同期呼び出しで、ページを取り出している間イベントループを
 * 本当に止める。数 GB を 3838 番のプロセスでやると `/api/health` が返らなくなり、
 * **LocalLauncher に死んだと見なされる** (docs/ARCHITECTURE.md 8.4)。
 * 割っている間も棚は読めるべきなので、重い方を外に出す。
 *
 * ## 親が死んだら子も死ぬこと
 *
 * 落とした後に子だけ残ると、**誰も見ていないプロセスが棚のファイルを書き続ける。**
 * 3 重に止める:
 *
 *   1. `fork` の IPC を繋いだまま走らせる。親がどう死んでも (SIGKILL でも) パイプは
 *      閉じるので、子に `disconnect` が届く → 子はそこで降りる
 *   2. 子は重い処理の合間に `process.connected` を見る。同期呼び出しの最中は
 *      `disconnect` が配られないので、**合図を自分で拾いに行く**必要がある
 *   3. 親は自分が終わる時に子を kill する (SIGINT / SIGTERM / exit)
 *
 * `detached` は**付けない。** 付けると子が別のプロセスグループに行き、
 * 親の死に巻き込まれずに生き残る道が出来てしまう。
 */

export interface JobState {
  fileId: number;
  startedAt: string;
  running: boolean;
  progress: SplitProgress | null;
  result: SplitResult | null;
  error: string | null;
}

const CHILD = path.resolve('src/cli-split.ts');

export class SplitJobs {
  private readonly jobs = new Map<number, JobState>();
  private child: ChildProcess | null = null;

  constructor() {
    const bye = (): void => this.killChild();
    process.on('exit', bye);
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
  }

  get(fileId: number): JobState | undefined {
    return this.jobs.get(fileId);
  }

  /** 走っている仕事があるか。**同時には 1 本だけ**にする (棚の錠と同じ理屈) */
  get busy(): boolean {
    return this.child !== null;
  }

  /**
   * 始める。**呼んだ側を待たせない** — 棚の錠は取るが、取れるのを待つのも子の起動も
   * この関数の外 (返した後) で進む。画面は status を見に来る。
   */
  start(fileId: number): JobState {
    const running = this.jobs.get(fileId);
    if (running?.running) return running;

    const state: JobState = {
      fileId,
      startedAt: new Date().toISOString(),
      running: true,
      progress: null,
      result: null,
      error: null,
    };
    this.jobs.set(fileId, state);

    void withShelfLock(
      `合本を分割する (${fileId})`,
      () =>
        new Promise<void>((resolve) => {
          const child = fork(CHILD, [String(fileId), '--run', '--ipc'], {
            // tsx を引き継がないと .ts を起動できない。**--watch だけは外す** —
            // 付いたままだと、書いている最中にファイルが動いて子が再起動しかねない
            execArgv: process.execArgv.filter((a) => !a.startsWith('--watch')),
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          });
          this.child = child;

          child.on('message', (m: unknown) => {
            const msg = m as { t?: string; progress?: SplitProgress; result?: SplitResult; message?: string };
            if (msg.t === 'progress' && msg.progress) state.progress = msg.progress;
            else if (msg.t === 'done' && msg.result) state.result = msg.result;
            else if (msg.t === 'error') state.error = String(msg.message ?? '分割できませんでした');
          });

          // 子の言い分は握り潰さない。落ちた時にここだけが手がかりになる
          const tail: string[] = [];
          const keep = (b: Buffer): void => {
            tail.push(String(b));
            if (tail.length > 40) tail.shift();
          };
          child.stdout?.on('data', keep);
          child.stderr?.on('data', keep);

          const finish = (err: string | null): void => {
            if (this.child === child) this.child = null;
            if (!state.result && !state.error) {
              state.error = err ?? tail.join('').trim().split('\n').pop() ?? '分割できませんでした';
            }
            state.running = false;
            resolve();
          };

          child.on('error', (e) => finish(e.message));
          child.on('exit', (code, signal) => {
            if (code === 0) finish(null);
            else finish(signal ? `中断しました (${signal})` : null);
          });
        }),
      { mutates: true }
    );

    return state;
  }

  killChild(): void {
    if (!this.child) return;
    const c = this.child;
    this.child = null;
    try {
      c.kill();
    } catch {
      // 既に終わっていることがある。終わっているなら用は無い
    }
  }
}
