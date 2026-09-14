import fs from 'node:fs';
import path from 'node:path';

/**
 * `.env` があれば先に読む。**鍵はここにしか置かない。**
 *
 * config.json にも書けるようにしてあるが、鍵だけは環境変数を優先する。
 * config.json は「棚の場所」「間隔」など人が眺めて直す設定の場所で、
 * そこに鍵が混ざると、設定を貼って見せるだけで漏れる。
 * (`.env` / `.env.*` は .gitignore 済み)
 */
try {
  process.loadEnvFile(path.resolve('.env'));
} catch {
  // 無くてよい。鍵の要らない提供元 (NDL) だけで動く
}

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
    providers: ('ndl' | 'openbd' | 'rakuten')[];
    /**
     * 楽天ブックス。**鍵は `.env` から入る** (RAKUTEN_APPLICATION_ID / RAKUTEN_ACCESS_KEY)。
     * 空なら楽天には一切問い合わせない — 未設定でも NDL だけで普通に動く。
     */
    rakuten: {
      applicationId: string;
      accessKey: string;
      /** アフィリエイト ID。空でよい。付けると画像 URL がアフィリンク経由になる */
      affiliateId: string;
      /**
       * 焼く書影の一辺 (px)。楽天の画像 URL は `?_ex=200x200` を差し替えると
       * その場で大きいものが返る (2026-09-14 に実測: 200→15KB / 600→102KB / 1200→325KB)。
       * 600 は棚に並べた時に粗く見えず、1 枚 100KB に収まる線
       */
      imageSize: number;
    };
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
  scan: { onStart: true, intervalMinutes: 180 },
  bib: {
    ttlDays: 90,
    minIntervalMs: 1200,
    providers: ['ndl', 'rakuten', 'openbd'],
    rakuten: { applicationId: '', accessKey: '', affiliateId: '', imageSize: 600 },
  },
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
    bib: {
      ...DEFAULTS.bib,
      ...(user.bib ?? {}),
      rakuten: {
        ...DEFAULTS.bib.rakuten,
        ...(user.bib?.rakuten ?? {}),
        // **環境変数が最後に勝つ。** config.json に古い鍵が残っていても、
        // .env を差し替えれば必ずそちらが使われる
        applicationId: process.env.RAKUTEN_APPLICATION_ID ?? user.bib?.rakuten?.applicationId ?? '',
        accessKey: process.env.RAKUTEN_ACCESS_KEY ?? user.bib?.rakuten?.accessKey ?? '',
        // 綴りは手元の .env に合わせて両方受ける
        affiliateId:
          process.env.RAKUTEN_AFFILIATE_ID ??
          process.env.RAKUTEN_AFFLIATE_ID ??
          user.bib?.rakuten?.affiliateId ??
          '',
      },
    },
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
