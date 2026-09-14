import fs from 'node:fs';
import path from 'node:path';

/**
 * 設定。対話的な入力は一切求めない (LocalLauncher から起動されるため)。
 * `config.json` が無ければ既定値で起動し、蔵書ルートだけ後から足せばよい。
 */

export interface LibraryRoot {
  /** 画面に出す名前 */
  id: string;
  label: string;
  /** 蔵書ルート。UNC 可 */
  path: string;
  /**
   * この棚の役割。
   *  shelf … 整理済みの蔵書。`[著者] 作品名/…` に並んでいる前提で読む
   *  inbox … 受け入れトレイ。落としたままの生ファイルが平置きされている
   *
   * **混ぜないこと。** inbox のファイル名は作品名の体をなしていないので、
   * 蔵書と同じ顔で並べると「持っている」の意味が壊れる。
   */
  kind: 'shelf' | 'inbox';
}

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  /** PowerDowner / DryEyes から所持を問い合わせる時の共有トークン。空なら認証なし */
  apiToken: string;
  roots: LibraryRoot[];
  scan: {
    /** 起動時に 1 回走らせるか */
    onStart: boolean;
    /** 定期スキャンの間隔 (分)。0 で止める */
    intervalMinutes: number;
  };
  bib: {
    /** 書誌キャッシュの寿命 (日)。切れても**捨てない** — 外が落ちていれば古い値を返す */
    ttlDays: number;
    /** 外部への問い合わせ間隔 (ミリ秒)。相手に迷惑をかけない最低限 */
    minIntervalMs: number;
    /** 使う提供元。上から順に試す */
    providers: ('ndl' | 'openbd')[];
  };
  notify: {
    /** ntfy のトピック URL。空なら通知しない (画面のお知らせには必ず残る) */
    ntfyUrl: string;
  };
}

const DEFAULTS: Config = {
  port: 3838,
  host: '0.0.0.0',
  dataDir: 'data',
  apiToken: '',
  roots: [],
  scan: { onStart: true, intervalMinutes: 60 },
  bib: { ttlDays: 90, minIntervalMs: 1200, providers: ['ndl', 'openbd'] },
  notify: { ntfyUrl: '' },
};

export function loadConfig(file = 'config.json'): Config {
  const abs = path.resolve(file);
  let user: Partial<Config> = {};
  if (fs.existsSync(abs)) {
    try {
      user = JSON.parse(fs.readFileSync(abs, 'utf8')) as Partial<Config>;
    } catch (e) {
      throw new Error(`${abs} を読めません: ${(e as Error).message}`);
    }
  }
  const cfg: Config = {
    ...DEFAULTS,
    ...user,
    scan: { ...DEFAULTS.scan, ...(user.scan ?? {}) },
    bib: { ...DEFAULTS.bib, ...(user.bib ?? {}) },
    notify: { ...DEFAULTS.notify, ...(user.notify ?? {}) },
    roots: (user.roots ?? DEFAULTS.roots).map((r, i) => ({
      id: r.id ?? `root${i + 1}`,
      label: r.label ?? r.path,
      path: r.path,
      kind: r.kind ?? 'shelf',
    })),
  };
  cfg.dataDir = path.resolve(cfg.dataDir);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.mkdirSync(path.join(cfg.dataDir, 'covers'), { recursive: true });
  return cfg;
}
