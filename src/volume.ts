/**
 * 作品の同一性キー (seriesKey) と巻数範囲の解釈。
 *
 * 出自は PowerDowner の `src/volume.ts`。あちらの取得済み台帳を将来こちらへ引き取る
 * 以上、**同じ文字列から同じキーが出ること**が移行の前提になる。直す時は両方直すこと。
 * 片方だけ変えると、向こうが「持っている」と言った巻をこちらが「持っていない」と言い、
 * 静かに二重取得が始まる (docs/ARCHITECTURE.md 4 章)。
 *
 * pinax で足したのは「完結マーク」の扱いだけ (下の stripCompletionMark)。
 */

/** 台帳に載せる 1 件分。巻数が取れなければ from/to は null になり、範囲判定に参加しない */
export interface ParsedItem {
  seriesKey: string;
  volumeFrom: number | null;
  volumeTo: number | null;
}

/**
 * 巻数表現のパターン。前にあるものほど優先。
 *
 * どれも「最後に現れたもの」を採る — タイトル自体に数字とハイフンを含む作品があるため、
 * 前方から拾うとタイトルの一部を巻数と誤読する。
 *
 * 範囲の区切りに [-‐–—~〜] を並べているのは、NFKC が全角チルダ (U+FF5E) を ~ に畳む一方で
 * 波ダッシュ (U+301C) はそのまま残すため。見た目が同じで別文字なので両方要る。
 *
 * 数字を 4 桁までに絞り、巻・話・vol のいずれかを必ず伴わせているのは、
 * 解像度 (1920-1080) や年号を巻数と誤読しないため。
 */
const PATTERNS: { re: RegExp; pick: (m: RegExpMatchArray) => [number, number] }[] = [
  // 全6巻 / 完結6巻 → 1..6
  { re: /(?:全|完結)\s*(\d{1,4})\s*巻/g, pick: (m) => [1, Number(m[1])] },
  // 第1巻-第6巻 / 1巻〜6巻 — 単位が両方に付く形。下の後置パターンでは
  // 数字の直後が単位になってしまい区切りに届かないので、こちらを先に見る
  {
    re: /(?:第\s*)?(\d{1,4})\s*(?:巻|話)\s*[-‐–—~〜]\s*(?:第\s*)?(\d{1,4})\s*(?:巻|話)/g,
    pick: (m) => [Number(m[1]), Number(m[2])],
  },
  // 1-6巻 / 1〜6話 — 単位が後ろに 1 つだけ付く形
  {
    re: /(?:第\s*)?(\d{1,4})\s*[-‐–—~〜]\s*(?:第\s*)?(\d{1,4})\s*(?:巻|話|vol\.?)/g,
    pick: (m) => [Number(m[1]), Number(m[2])],
  },
  // vol.1-6
  { re: /vol\.?\s*(\d{1,4})\s*[-‐–—~〜]\s*(\d{1,4})/g, pick: (m) => [Number(m[1]), Number(m[2])] },
  // v01-02 / _v03-04 — vol の省略形。ファイル名でよく使われる。
  // 直前を [^a-z] に限るのは、単語の途中 (nov01 など) を拾わないため
  {
    re: /(?:^|[^a-z])v(\d{1,4})\s*[-‐–—~〜]\s*v?(\d{1,4})/g,
    pick: (m) => [Number(m[1]), Number(m[2])],
  },
  // 第3巻 / 3巻 / 第12話
  { re: /(?:第\s*)?(\d{1,4})\s*(?:巻|話)/g, pick: (m) => [Number(m[1]), Number(m[1])] },
  // vol.3 — 単位が数字の前に来る形。上の後置パターンでは拾えない
  { re: /vol\.?\s*(\d{1,4})/g, pick: (m) => [Number(m[1]), Number(m[1])] },
  // v03 — vol の省略形の単巻
  { re: /(?:^|[^a-z])v(\d{1,4})/g, pick: (m) => [Number(m[1]), Number(m[1])] },
];

// 範囲として認める幅。1-2024 のような明らかな誤読を弾く
const MAX_SPAN = 300;

function nfkc(s: unknown): string {
  return String(s ?? '').normalize('NFKC');
}

export type VolumeUnit = '巻' | '話';

/**
 * 完結マーク。手元の蔵書では**フォルダ名にもファイル名にも**付く:
 *
 *   [あらゐけいいち] 日常(完)/[あらゐけいいち] 日常 第10巻(完).rar
 *
 * NFKC が （完） を (完) に畳むので、正規化後は半角だけ見れば足りる。
 *
 * **これを落とさずに seriesKey を作ってはいけない。** 落とさないと、完結した作品だけ
 * フォルダ由来のキー (`日常完`) とファイル由来のキー (`日常`) に割れて、同じ作品が
 * 2 つに見える。手元の 488 作品のうち 103 作品が該当する。
 */
const COMPLETION_MARK = /[(（]\s*完\s*[)）]/g;

export interface CompletionInfo {
  /** 完結マークを落とした本文 */
  text: string;
  /** 完結マークが付いていたか */
  completed: boolean;
}

/** 完結マークを剥がす。正規化はしないので、呼び出し側の都合に合わせられる */
export function stripCompletionMark(raw: string): CompletionInfo {
  const s = String(raw ?? '');
  COMPLETION_MARK.lastIndex = 0;
  if (!COMPLETION_MARK.test(s)) return { text: s, completed: false };
  return { text: s.replace(COMPLETION_MARK, '').replace(/\s{2,}/g, ' ').trim(), completed: true };
}

/** 見つかった巻数表現。位置は NFKC 正規化した文字列に対するもの */
export interface VolumeMatch {
  from: number;
  to: number;
  /** 「第3話」を「第3巻」と書き換えてしまわないよう、単位も持ち回る */
  unit: VolumeUnit;
  start: number;
  end: number;
}

/** 巻数表現を探す。見つかった位置も返す (タイトルから削るため) */
function findVolume(text: string): VolumeMatch | null {
  const s = nfkc(text).toLowerCase();
  for (const { re, pick } of PATTERNS) {
    re.lastIndex = 0;
    const all = [...s.matchAll(re)];
    if (all.length === 0) continue;
    // 後ろから探す
    const m = all[all.length - 1];
    const [from, to] = pick(m);
    if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
    // マッチはしたが範囲として成立していない (逆順・幅が広すぎる)。
    // 次のパターンへ流すと「1-2024巻」から「2024巻」を、「6-1巻」から「1巻」を拾ってしまうので、
    // ここで「巻数は読めなかった」と確定させる
    if (from > to || to - from > MAX_SPAN) return null;
    // 単位はマッチした文字列そのものから見る。「話」で書かれていたものを
    // 「巻」と書き換えると、表示も名前も嘘になる
    const unit: VolumeUnit = m[0].includes('話') ? '話' : '巻';
    return { from, to, unit, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length };
  }
  return null;
}

/**
 * 巻数表現を、NFKC 正規化した文字列と一緒に返す。
 *
 * 位置 (start/end) は**正規化後の文字列に対するもの**なので、必ず normalized と組で使うこと。
 * 元の文字列に当てると、全角英数が半角に畳まれた分だけずれる。
 */
export function findVolumeIn(text: string): { normalized: string; match: VolumeMatch | null } {
  return { normalized: nfkc(text), match: findVolume(text) };
}

/**
 * 明示的に渡された volume を読む。
 * 巻数だと分かっている値なので、ここでは単位キーワードを要求しない ("3" "03" "(3)" "1-6" を許す)。
 */
function parseExplicitVolume(raw: string): { from: number; to: number } | null {
  const s = nfkc(raw).toLowerCase().trim();
  if (!s) return null;

  const range = s.match(/^\D*(\d{1,4})\s*[-‐–—~〜]\s*(\d{1,4})\D*$/);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (from <= to && to - from <= MAX_SPAN) return { from, to };
    return null;
  }

  const single = s.match(/^\D*(\d{1,4})\D*$/);
  if (single) {
    const n = Number(single[1]);
    return { from: n, to: n };
  }

  // 単位付きの表記 (「第03巻」など) はここに落ちてくる
  const found = findVolume(s);
  return found ? { from: found.from, to: found.to } : null;
}

/**
 * 同一性の判定に使う作品名キー。
 * 完結マークと巻数表現を落としてから記号と空白を全部削る — 落とさないと
 * 「作品名 第3巻」と「作品名 第4巻」が別シリーズになってしまう。
 *
 * サブタイトルは削らない。サイトによって付いたり付かなかったりするが、
 * 誤合流 (別物を「持っている」と誤判定する) より再ダウンロードの方が被害が小さい。
 */
export function seriesKeyOf(title: string): string {
  let s = nfkc(stripCompletionMark(String(title ?? '')).text);
  const found = findVolume(s);
  if (found) s = s.slice(0, found.start) + ' ' + s.slice(found.end);
  return s
    .toLowerCase()
    .replace(/[\s　_\-‐–—~〜・,.、。!?！？'"“”‘’()（）\[\]{}【】「」『』:：;；|\/\\]/g, '')
    .trim();
}

/**
 * 1 件を台帳の形に落とす。
 *
 * 巻数は volume → title → rawText の順に探す。volume は「巻数である」と分かっている
 * 値なので単位キーワード無しでも読むが、title / rawText からは単位を伴うものしか拾わない
 * (作品名に含まれる数字を巻数と誤読しないため)。
 */
export function parseItem(input: {
  title?: string | null;
  volume?: string | number | null;
  rawText?: string | null;
}): ParsedItem {
  const titleSource = String(input.title ?? '').trim() || String(input.rawText ?? '').trim();

  let range: { from: number; to: number } | null = null;
  if (input.volume !== undefined && input.volume !== null && String(input.volume).trim() !== '') {
    range = parseExplicitVolume(String(input.volume));
  }
  if (!range && titleSource) {
    const found = findVolume(titleSource);
    if (found) range = { from: found.from, to: found.to };
  }
  if (!range && input.rawText) {
    const found = findVolume(String(input.rawText));
    if (found) range = { from: found.from, to: found.to };
  }

  return {
    seriesKey: seriesKeyOf(titleSource),
    volumeFrom: range?.from ?? null,
    volumeTo: range?.to ?? null,
  };
}
