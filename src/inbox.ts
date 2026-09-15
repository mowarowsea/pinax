import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db.js';
import type { LibraryRoot } from './config.js';
import { CONTENT_EXT, SPLIT_EXT, fitPath, parseFilename, planName, uniqueName } from './naming.js';
import { seriesKeyOf, type VolumeUnit } from './volume.js';

/**
 * 受け入れトレイを棚へ入れる。
 *
 * トレイには落としたままの生ファイルが平置きされている:
 *
 *   100man no Inochi no ue ni ore v15-16s.rar
 *   1nenAguminoMonster_01s.rar.rar
 *   [藤栄道彦]_最後のレストランch84-103.zip
 *
 * ローマ字・区切りばらばら・拡張子の二重付け・話数書き。**蔵書と同じ顔で並べては
 * いけない**ので、`roots[].kind = 'inbox'` として棚のスキャンからは外してある
 * (scan/scanner.ts)。
 *
 * ここがやるのは 3 つ:
 *
 *   1. ファイル名を作品単位に畳む (巻・話と版の印を落とす)
 *   2. 蔵書の**読み**と突き合わせて、既にある作品の続きを見つける
 *   3. 残りは外 (人・別の AI) に聞いた答えを受け取って、移動の計画を立てる
 *
 * **計画を自動で実行しない。** 3000 件を機械が黙って動かして間違えると、
 * どれが元どこにあったか分からなくなる。適用する時は移動ログを必ず残す。
 */

// ---- ファイル名を作品単位に畳む -------------------------------------------

/**
 * アップローダが名前の頭に付ける宣伝。実物にあるもの:
 *
 *   Raw-Zip.Com-… (132) / Cmczip.Com-… (61) / MG-Zip.Com-… (13)
 *
 * **落とさないと同じ作品が 2 つのキーに割れる** (`onepunchman` と
 * `mgzipcomonepunchman`)。割れたまま外へ聞くと、同じ作品を 2 回聞くことになり、
 * 答えが揃った時に「1 つの作品名が複数のキーに付いている」と疑われてしまう。
 */
const SITE_PREFIX = /^[A-Za-z0-9-]{2,20}\.(?:com|net|org)-/i;

/** 拡張子・分割連番・二重拡張子・宣伝を落とす。`1nenAguminoMonster_01s.rar.rar` が実在する */
function stripNoise(name: string): string {
  return name
    .replace(SITE_PREFIX, '')
    .replace(/\.(rar|zip|7z|cbz|cbr|pdf|epub|mobi|azw3?)(\.(rar|zip|7z))?$/i, '')
    .replace(/\.part\d+$/i, '')
    .replace(/\.r\d{2,3}$/i, '')
    .replace(/\.\d{3}$/, '');
}

/**
 * ch / c で書かれた話数。`Busamen_Gachi_Fighter_01s ch05-07` `…最後のレストランch84-103`。
 *
 * **これは巻の中の話を指すことがある**ので、剥がした後にもう一度巻を探す。
 */
const CHAPTER_EN = /[_\s.-]*(?:ch|c)(\d{1,4})(?:[-~_](\d{1,4}))?\s*$/i;

/**
 * 日本語で書かれた話数。`…遙か凍土のカナン_第006-014話_[2018-05-06～2019-04-03]`。
 *
 * **こちらが見つかったら話で確定し、巻を探しに行かない。** 探しに行くと
 * `幼女戦記_外伝1,_2_第61-63話_…` の「外伝1, 2」の `2` を第 2 巻と読んで、
 * `幼女戦記_外伝1,` というフォルダを掘る (2026-09-15 の計画で発見)。
 *
 * 末尾に縛っていないのは、後ろに配信期間や「雑誌寄せ集め」が付くから。
 * そこで切ると、そのごみも一緒に落ちる。
 *
 * **話を巻に倒さない。** 倒すと「第103巻」が棚に並び、欠番の数直線が壊れる
 * (docs/ARCHITECTURE.md「巻と話は別々の数直線で数える」)。
 */
const CHAPTER_JA = /[_\s.-]*第(\d{1,4})(?:[-~_](\d{1,4}))?話/;

/**
 * 巻数の後ろに付く版・品質の印。実物から拾ったもの:
 *
 *   _01s / _13s+ / _05w / _04A / _26v2 / _25s_fix / _15_LQ / _01-02e / _02w1
 *
 * **数字の直後にある時だけ印とみなす。** 単独で剥がすと `Kasane` の `e` や
 * `Land` の `d` まで落ちて、作品名が壊れる。
 */
const EDITION = String.raw`(?:[_\s.-]*(?:fix|lq|hq|raw|v\d{1,2}|[a-z]\d?|\+)){0,3}`;

const VOL_PATTERNS = [
  new RegExp(String.raw`[_\s.-]v(\d{1,3})(?:[-~_](\d{1,3}))?` + EDITION + '$', 'i'),
  new RegExp(String.raw`[_\s.-](\d{1,3})(?:[-~_](\d{1,3}))?` + EDITION + '$', 'i'),
  /第(\d{1,3})(?:[-~](\d{1,3}))?巻/,
];

export interface InboxName {
  work: string;
  from: number | null;
  to: number | null;
  unit: VolumeUnit;
}

/**
 * ファイル名から作品部分と巻 (または話) を割る。
 *
 * 範囲の幅を 60 までに絞っているのは、`Series_1999-2024` のような年号を
 * 巻数と読まないため。
 */
export function splitInboxName(stem: string): InboxName {
  let s = stem;
  let chapter: { from: number; to: number } | null = null;

  const ja = s.match(CHAPTER_JA);
  if (ja && ja.index !== undefined) {
    const from = Number(ja[1]);
    const to = ja[2] ? Number(ja[2]) : from;
    if (from >= 1 && to >= from) return { work: s.slice(0, ja.index), from, to, unit: '話' };
  }

  const ch = s.match(CHAPTER_EN);
  if (ch && ch.index !== undefined) {
    const from = Number(ch[1]);
    const to = ch[2] ? Number(ch[2]) : from;
    if (from >= 1 && to >= from) {
      chapter = { from, to };
      s = s.slice(0, ch.index);
    }
  }

  for (const re of VOL_PATTERNS) {
    const m = s.match(re);
    if (!m || m.index === undefined) continue;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (from >= 1 && from <= 999 && to >= from && to - from < 60) {
      return { work: s.slice(0, m.index), from, to, unit: '巻' };
    }
  }

  // 巻が書かれていないなら、話として持つ (単位を巻に倒さない)
  if (chapter) return { work: s, from: chapter.from, to: chapter.to, unit: '話' };
  return { work: s, from: null, to: null, unit: '巻' };
}

/** 突き合わせ用のキー。区切りと大小を潰す (seriesKeyOf のローマ字版) */
export const inboxKeyOf = (s: string): string =>
  // 共著の × は x に倒す。SPY×FAMILY と SPYxFAMILY が別キーになると同じ作品を 2 回聞く
  s.normalize('NFKC').toLowerCase().replace(/[×✕╳]/g, 'x').replace(/[\s_\-.,'!?()[\]~+&#]/g, '');

/** かな・漢字を含むか。含むなら作品名がそのまま書かれている */
const HAS_JAPANESE = /[ぁ-んァ-ヶ一-龠]/;

/** トレイの 1 作品分 */
export interface InboxWork {
  /** 突き合わせの鍵。外へ聞く時もこれを持たせて返してもらう */
  key: string;
  /** 人が読む用の名前 */
  label: string;
  /**
   * ファイル名が日本語で書かれていて、作品名と著者をその場で読めた場合。
   * **外へ聞かなくてよい** — 82 ファイルがこれに当たる (2026-09-15)。
   */
  parsed: { title: string; author: string | null } | null;
  files: { name: string; from: number | null; to: number | null; unit: VolumeUnit }[];
}

/**
 * 日本語で書かれたファイル名から作品名と著者を読む。読めなければ null。
 *
 * 蔵書を読むのと同じ `parseFilename` を通す。区切りが `_` のものがあるので、
 * 作品名の前後に残る区切りだけ落とす (`_私の魔法の先生は…_` → `私の魔法の先生は…`)。
 *
 * **渡すのは巻・話を剥がした後の名前。** 剥がす前を渡すと `parseFilename` が
 * 知らない書き方 (`ch84-103`) が作品名に残り、`最後のレストランch84-103` という
 * フォルダが掘られる (2026-09-15 の計画で 2 件)。
 */
function readJapaneseName(stem: string): { title: string; author: string | null } | null {
  if (!HAS_JAPANESE.test(stem)) return null;
  const p = parseFilename(stem);
  const title = p.title.replace(/^[\s_.-]+|[\s_.-]+$/g, '').trim();
  if (!title || !HAS_JAPANESE.test(title)) return null;
  return { title, author: p.author };
}

/**
 * トレイを歩いて作品単位に畳む。
 *
 * **畳むのは同じキーのファイルだけ。頭が一致するキーを寄せてはいけない。**
 * 表記ゆれ (`100man no Inochi no ue ni ore` と `100man_no_Inochi_no_Ue`) を
 * 前方一致で寄せたところ、`Oshinoko` に `Oshi_ga_Budoukan…` `Onna_no_Sono_no_Hoshi`
 * `Yari_no_Yuusha_no_Yarinaoshi` まで吸い込まれて **60 本が 1 作品になった**
 * (2026-09-15 に実測)。寄せて減る手間より、別作品が 1 つに畳まれる害が大きい。
 *
 * 表記ゆれは**外に聞いた答えの方で合流する** — 別々のキーでも作品名が同じなら
 * planMoves が同じフォルダへ入れる。外に聞く件数は増えるが、間違いは起きない。
 */
export function foldInbox(dir: string): InboxWork[] {
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && (CONTENT_EXT.test(e.name) || SPLIT_EXT.test(e.name)))
    .map((e) => e.name);

  const works = new Map<string, InboxWork>();
  for (const name of names) {
    const stem = stripNoise(name);
    const { work, from, to, unit } = splitInboxName(stem);
    const key = inboxKeyOf(work);
    if (!key) continue;
    if (!works.has(key)) {
      works.set(key, {
        key,
        label: work.replace(/[_\s.-]+$/, ''),
        parsed: readJapaneseName(work),
        files: [],
      });
    }
    works.get(key)!.files.push({ name, from, to, unit });
  }
  return [...works.values()];
}

// ---- 蔵書の「読み」と突き合わせる ------------------------------------------

/**
 * カタカナ → ローマ字。NDL の `dcndl:titleTranscription` を読むためだけの簡易版。
 *
 * **ここが精密である必要は無い。** 突き合わせ相手のファイル名も人間が適当に
 * ローマ字にしたものなので、どちらも同じくらい雑に均せば当たる。
 */
const KANA: Record<string, string> = {
  キャ:'kya',キュ:'kyu',キョ:'kyo',シャ:'sha',シュ:'shu',ショ:'sho',チャ:'cha',チュ:'chu',チョ:'cho',
  ニャ:'nya',ニュ:'nyu',ニョ:'nyo',ヒャ:'hya',ヒュ:'hyu',ヒョ:'hyo',ミャ:'mya',ミュ:'myu',ミョ:'myo',
  リャ:'rya',リュ:'ryu',リョ:'ryo',ギャ:'gya',ギュ:'gyu',ギョ:'gyo',ジャ:'ja',ジュ:'ju',ジョ:'jo',
  ビャ:'bya',ビュ:'byu',ビョ:'byo',ピャ:'pya',ピュ:'pyu',ピョ:'pyo',ヴァ:'va',ヴィ:'vi',ヴェ:'ve',ヴォ:'vo',
  ファ:'fa',フィ:'fi',フェ:'fe',フォ:'fo',ティ:'ti',ディ:'di',デュ:'dyu',トゥ:'tu',ドゥ:'du',
  シェ:'she',ジェ:'je',チェ:'che',ウィ:'wi',ウェ:'we',ウォ:'wo',
  ア:'a',イ:'i',ウ:'u',エ:'e',オ:'o',カ:'ka',キ:'ki',ク:'ku',ケ:'ke',コ:'ko',
  サ:'sa',シ:'shi',ス:'su',セ:'se',ソ:'so',タ:'ta',チ:'chi',ツ:'tsu',テ:'te',ト:'to',
  ナ:'na',ニ:'ni',ヌ:'nu',ネ:'ne',ノ:'no',ハ:'ha',ヒ:'hi',フ:'fu',ヘ:'he',ホ:'ho',
  マ:'ma',ミ:'mi',ム:'mu',メ:'me',モ:'mo',ヤ:'ya',ユ:'yu',ヨ:'yo',
  ラ:'ra',リ:'ri',ル:'ru',レ:'re',ロ:'ro',ワ:'wa',ヲ:'o',ン:'n',
  ガ:'ga',ギ:'gi',グ:'gu',ゲ:'ge',ゴ:'go',ザ:'za',ジ:'ji',ズ:'zu',ゼ:'ze',ゾ:'zo',
  ダ:'da',ヂ:'ji',ヅ:'zu',デ:'de',ド:'do',バ:'ba',ビ:'bi',ブ:'bu',ベ:'be',ボ:'bo',
  パ:'pa',ピ:'pi',プ:'pu',ペ:'pe',ポ:'po',ヴ:'vu',
  ァ:'a',ィ:'i',ゥ:'u',ェ:'e',ォ:'o',ャ:'ya',ュ:'yu',ョ:'yo',ー:'',
};

export function romaji(kana: string): string {
  let out = '';
  for (let i = 0; i < kana.length; i++) {
    const two = kana.slice(i, i + 2);
    if (KANA[two]) { out += KANA[two]; i++; continue; }
    const one = kana[i];
    if (one === 'ッ') {
      // 促音は次の子音を重ねる
      const next = KANA[kana.slice(i + 1, i + 3)] ?? KANA[kana[i + 1]] ?? '';
      if (next) out += next[0];
      continue;
    }
    out += KANA[one] ?? (/[ 　]/.test(one) ? '' : one);
  }
  return out.toLowerCase();
}

export interface ShelfSeries {
  id: number;
  title: string;
  author: string | null;
  folder: string;
  yomi: string | null;
}

/**
 * 蔵書の作品に読みを当てる。
 *
 * 読みの出どころは **NDL の生応答** (`http_cache`)。`bib` 表には焼いていないので、
 * ここで生 XML から拾う — 「応答は生のまま焼き付ける。解釈を後から直せるように」
 * (docs/ARCHITECTURE.md 5 章) が効いている場面で、後から要ると分かった値を
 * 外へ聞き直さずに取り出せている。
 */
export function shelfWithYomi(db: Db): ShelfSeries[] {
  const yomiByTitle = new Map<string, string>();
  const rows = db.raw.prepare("SELECT body FROM http_cache WHERE provider = 'ndl'").all() as { body: string }[];
  for (const row of rows) {
    const body = String(row.body ?? '');
    const re = /<dc:title>([\s\S]*?)<\/dc:title>[\s\S]{0,400}?<dcndl:titleTranscription>([^<]*)</g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const title = m[1].replace(/<[^>]+>/g, '').trim();
      const yomi = m[2].trim();
      if (title && yomi && !yomiByTitle.has(title)) yomiByTitle.set(title, yomi);
    }
  }

  const series = db.raw
    .prepare('SELECT id, title, author, folder FROM series WHERE present = 1')
    .all() as { id: number; title: string; author: string | null; folder: string }[];

  return series.map((s) => {
    let yomi = yomiByTitle.get(s.title) ?? null;
    if (!yomi) {
      // 書名は巻数付きで入っていることがあるので前方一致でも寄せる
      for (const [t, y] of yomiByTitle) {
        if (t.startsWith(s.title) || s.title.startsWith(t)) { yomi = y; break; }
      }
    }
    return { ...s, yomi };
  });
}

export interface Matched {
  work: InboxWork;
  /** 読みで当たった蔵書の作品。当たらなければ null */
  shelf: ShelfSeries | null;
}

/**
 * トレイの作品を蔵書の読みと突き合わせる。
 *
 * 前後一致を見るのは**どちらも 8 文字以上のときだけ**。短いキーで許すと
 * 別作品を掴む (`Land` が `Landreaall` を掴む類)。
 */
export function matchByYomi(works: InboxWork[], shelf: ShelfSeries[]): Matched[] {
  const byRoma = new Map<string, ShelfSeries>();
  for (const s of shelf) {
    if (!s.yomi) continue;
    const key = inboxKeyOf(romaji(s.yomi));
    if (key.length >= 4 && !byRoma.has(key)) byRoma.set(key, s);
  }
  return works.map((work) => {
    const exact = byRoma.get(work.key);
    if (exact) return { work, shelf: exact };
    if (work.key.length < 8) return { work, shelf: null };
    const near = [...byRoma.entries()]
      .find(([r]) => r.length >= 8 && (r.startsWith(work.key) || work.key.startsWith(r)))?.[1] ?? null;
    return { work, shelf: near };
  });
}

// ---- 移動の計画 -------------------------------------------------------------

/** 外へ聞いた答え。key は必ずこちらが出したものをそのまま返してもらう */
export interface Answer {
  key: string;
  title: string;
  author: string | null;
}

export interface Move {
  /** トレイの中の名前 */
  from: string;
  /** 蔵書ルートからの相対パス */
  to: string;
  work: string;
  author: string | null;
  volumeFrom: number | null;
  volumeTo: number | null;
  unit: VolumeUnit;
  /** 巻数を読めなかったので名前を変えずに置く */
  keepName: boolean;
  /**
   * 答えの出どころ。
   *   yomi   … 棚の読み (NDL の titleTranscription) で当てた
   *   title  … 外の答えの作品名が、棚に既にある作品と一致した
   *   answer … 棚に無い。新しい作品フォルダを掘る
   *   file   … ファイル名が日本語で、その場で読めた (外に聞いていない)
   */
  via: 'yomi' | 'title' | 'answer' | 'file';
}

export interface Plan {
  moves: Move[];
  /** 作品名が分からないので動かせないもの */
  unresolved: { key: string; label: string; files: number }[];
}

/**
 * 移動の計画を立てる。ファイルには触らない。
 *
 * 既にある作品フォルダへ入れる場合は**そのフォルダ名をそのまま使う** —
 * 蔵書側は `(完)` が付いていたり著者の表記が違ったりするので、
 * こちらで組み立て直すと同じ作品が 2 つのフォルダに割れる。
 */
export function planMoves(
  matched: Matched[],
  answers: Map<string, Answer>,
  shelfRoot: string,
  shelf: ShelfSeries[] = []
): Plan {
  const moves: Move[] = [];
  const unresolved: Plan['unresolved'] = [];
  // 計画の中での衝突も見る。実際に置く時まで気付かないと、同じ名前を 2 度作る
  const taken = new Set<string>();

  // **外の答えの作品名でも棚を引く。** 読みで当たらなくても日本語名が一致すれば
  // それは既にある作品で、別フォルダを掘ると同じ作品が 2 つに割れる
  // (probe が「同じ作品が複数フォルダに散っている」と言い出す状態を自分で作らない)。
  const byTitleKey = new Map<string, ShelfSeries>();
  for (const s of shelf) {
    const k = seriesKeyOf(s.title);
    if (k && !byTitleKey.has(k)) byTitleKey.set(k, s);
  }

  for (const { work, shelf: byYomi } of matched) {
    // ファイル名から読めたものは外の答えより信用する。**こちらは推測が入っていない**
    const own = work.parsed;
    const answer = answers.get(work.key);
    const named = own ?? (answer ? { title: answer.title, author: answer.author } : null);
    const byTitle = named?.title ? byTitleKey.get(seriesKeyOf(named.title)) ?? null : null;
    const found = byYomi ?? byTitle;

    const title = found?.title ?? named?.title ?? '';
    if (!title.trim()) {
      unresolved.push({ key: work.key, label: work.label, files: work.files.length });
      continue;
    }
    // 棚にある作品なら、棚の著者とフォルダ名を正とする
    const author = found?.author ?? named?.author ?? null;
    const via: Move['via'] = byYomi ? 'yomi' : byTitle ? 'title' : own ? 'file' : 'answer';

    for (const f of work.files) {
      // 巻も話も読めなかったなら**単位も渡さない**。渡すと planName の中で
      // parseFilename が読み直した数字に、こちらの「巻」が被さって化ける
      // (`第006-014話` が `第06-14巻` になっていた — 2026-09-15)。
      const unit = f.from === null ? undefined : f.unit;
      const plan = fitPath(
        shelfRoot,
        planName(f.name, { title, author, volumeFrom: f.from, volumeTo: f.to, unit }, { folder: true }),
        { title, author }
      );
      const folder = found?.folder ?? plan.folder ?? '';
      const file = uniqueName(
        path.join(shelfRoot, folder),
        plan.file,
        (p) => taken.has(p.toLowerCase()) || fs.existsSync(p)
      );
      const to = path.join(folder, file);
      taken.add(path.join(shelfRoot, to).toLowerCase());
      moves.push({
        from: f.name,
        to,
        work: title,
        author,
        volumeFrom: f.from,
        volumeTo: f.to,
        unit: f.unit,
        keepName: plan.keepName,
        via,
      });
    }
  }
  return { moves, unresolved };
}

// ---- トレイの中で仕分ける ---------------------------------------------------

/**
 * 仕分け先の箱。棚へ移す前に、トレイの中でフォルダ分けするための 1 段。
 *
 * **人が中を見てから手で棚へ移す**ための分け方なので、「そのまま移せるか」で
 * 分けている。棚に既にある作品はフォルダを合流させることになるので慎重に、
 * 新しい作品はフォルダごと放り込むだけで済む。
 */
export const BUCKETS = ['_棚にある', '_新しい作品', '_要確認', '_話'] as const;
export type Bucket = (typeof BUCKETS)[number];

export function bucketOf(m: Move): Bucket {
  // 話は巻と数直線が別なので、棚に並べる前に人が見る (保管しないことも多い)
  if (m.unit === '話' && m.volumeFrom !== null) return '_話';
  // 巻数を読めなかったもの。短編集・外伝・後日譚がここに来る
  if (m.keepName) return '_要確認';
  return m.via === 'yomi' || m.via === 'title' ? '_棚にある' : '_新しい作品';
}

/**
 * 移動先の頭に箱を足した計画を返す。**元の計画には触らない。**
 *
 * 置き場所が変わるだけで、フォルダ名もファイル名も棚に入れる時と同じにする。
 * ここで別の名前を付けると、人が手で棚へ移した後に pinax が読み戻せない。
 */
export function bucketize(plan: Plan): Plan {
  return { ...plan, moves: plan.moves.map((m) => ({ ...m, to: path.join(bucketOf(m), m.to) })) };
}

// ---- 適用 -------------------------------------------------------------------

export interface ApplyResult {
  moved: number;
  failed: { from: string; error: string }[];
  logPath: string;
}

/**
 * 計画を実行する。**移動ログを必ず残す。**
 *
 * 3000 件を動かした後で「元がどこだったか」を思い出せないと、間違いを戻せない。
 * ログは 1 行 1 移動で、実行した順に書く (途中で落ちてもそこまでは残る)。
 *
 * `destRoot` は棚とは限らない。トレイの中で仕分ける時 (`bucketize`) は
 * トレイ自身を渡す。どちらにせよ、その外へは 1 件も出さない。
 */
export function applyMoves(plan: Plan, inboxDir: string, destRoot: string, logDir: string): ApplyResult {
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `inbox-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  const log = fs.openSync(logPath, 'a');
  const failed: ApplyResult['failed'] = [];
  let moved = 0;

  try {
    for (const m of plan.moves) {
      const src = path.resolve(inboxDir, m.from);
      const dst = path.resolve(destRoot, m.to);
      // トレイの外・行き先の外へは絶対に触らせない。`..` を含む名前 1 つで外へ出る
      if (!src.startsWith(path.resolve(inboxDir) + path.sep) || !dst.startsWith(path.resolve(destRoot) + path.sep)) {
        failed.push({ from: m.from, error: 'トレイか行き先の外を指しています' });
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
        moved++;
        fs.writeSync(log, JSON.stringify({ at: new Date().toISOString(), from: src, to: dst }) + '\n');
      } catch (e) {
        failed.push({ from: m.from, error: (e as Error).message });
      }
    }
  } finally {
    fs.closeSync(log);
  }
  return { moved, failed, logPath };
}

/** 答えの TSV (key / 作品名 / 著者) を読む。BOM 付きで来ることがある */
export function readAnswers(file: string): Map<string, Answer> {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const out = new Map<string, Answer>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [key, title, author] = line.split('\t');
    if (!key || key === 'key') continue;
    if (!title?.trim()) continue; // 空欄は「分からない」。埋めずに残す
    out.set(key.trim(), { key: key.trim(), title: title.trim(), author: author?.trim() || null });
  }
  return out;
}

/**
 * 答えの中の怪しい行を見つける。返すのは key → 疑う理由。
 *
 * **1 つの作品名が、似ていない複数の key に付いていたら疑う。**
 * 実際に踏んだ (2026-09-15): 外へ聞いた答えが `oshi` を含むキーを片っ端から
 * 「【推しの子】」にしてきて、`yarinoyuushanoyarinaoshi` (槍の勇者のやり直し) も
 * `nanatoshimonogatari` (七都市物語) も `koroshiai` (殺し愛) も同じ作品にされた。
 * 31 件。そのまま適用すれば、別作品が 1 つのフォルダへ 61 本流れ込んでいた。
 *
 * 表記ゆれで同じ作品が複数の key になるのは**正当**なので (`arte` と `artev17`)、
 * key 同士が似ているなら通す。似ている = 共通の頭が短い方の 6 割以上。
 *
 * ここで拾えるのは「同じ答えを使い回した」種類の間違いだけで、
 * 1 対 1 で間違えられたものは機械には分からない。**最後は人が計画を見る。**
 */
export function suspectAnswers(answers: Map<string, Answer>, inUse?: Set<string>): Map<string, string> {
  const byTitle = new Map<string, string[]>();
  for (const a of answers.values()) {
    // **今のトレイに無いキーは数えない。** 畳み方を直すと古い答えのキーが宙に浮くが、
    // それは使われないので疑う意味が無い。数に入れると、生きている答えまで
    // 巻き添えで外れる (宣伝を落とす前の `mgzipcomonepunchman` で踏んだ)
    if (inUse && !inUse.has(a.key)) continue;
    const k = seriesKeyOf(a.title);
    if (!k) continue;
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k)!.push(a.key);
  }

  const commonHead = (a: string, b: string): number => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };

  const suspects = new Map<string, string>();
  for (const [, keys] of byTitle) {
    if (keys.length < 2) continue;
    const shortest = keys.reduce((s, k) => (k.length < s.length ? k : s));
    const alike = keys.every((k) => commonHead(k, shortest) >= Math.ceil(shortest.length * 0.6));
    if (alike) continue;
    const title = answers.get(keys[0])!.title;
    for (const k of keys) {
      suspects.set(k, `「${title}」が似ていない ${keys.length} 個のキーに付いています (${keys.slice(0, 4).join(', ')}…)`);
    }
  }
  return suspects;
}

/** config の roots から受け入れトレイを 1 つ選ぶ */
export function inboxRootOf(roots: LibraryRoot[]): LibraryRoot | null {
  return roots.find((r) => r.kind === 'inbox') ?? null;
}

/** config の roots から棚 (整理先) を 1 つ選ぶ */
export function shelfRootOf(roots: LibraryRoot[]): LibraryRoot | null {
  return roots.find((r) => r.kind === 'shelf') ?? null;
}

/** 計画を人が読める形にする */
export function formatPlan(plan: Plan, limit = 20): string {
  const lines: string[] = [];
  const byWork = new Map<string, Move[]>();
  for (const m of plan.moves) {
    if (!byWork.has(m.work)) byWork.set(m.work, []);
    byWork.get(m.work)!.push(m);
  }
  const count = (v: Move['via']): number => plan.moves.filter((m) => m.via === v).length;
  lines.push(`移動: ${plan.moves.length} ファイル / ${byWork.size} 作品`);
  lines.push(`  棚に既にある作品へ: ${count('yomi') + count('title')} ファイル (読みで一致 ${count('yomi')} / 作品名で一致 ${count('title')})`);
  lines.push(`  新しい作品として:   ${count('answer') + count('file')} ファイル` +
    ` (外の答え ${count('answer')} / ファイル名から直接読めた ${count('file')})`);
  lines.push(`  話として置くもの:   ${plan.moves.filter((m) => m.unit === '話').length} ファイル`);
  lines.push(`  巻数を読めず名前を変えないもの: ${plan.moves.filter((m) => m.keepName).length} ファイル`);
  lines.push(`動かせない (作品名が分からない): ${plan.unresolved.length} 作品 / ${plan.unresolved.reduce((n, u) => n + u.files, 0)} ファイル`);
  lines.push('');
  let n = 0;
  for (const [work, ms] of byWork) {
    if (n++ >= limit) { lines.push(`  ... 他 ${byWork.size - limit} 作品`); break; }
    const via =
      ms[0].via === 'yomi' ? '棚にある (読みで一致)'
      : ms[0].via === 'title' ? '棚にある (作品名で一致)'
      : ms[0].via === 'file' ? '新しい作品 (ファイル名から)'
      : '新しい作品 (外の答え)';
    lines.push(`  ${work} (${ms.length}本, ${via})`);
    for (const m of ms.slice(0, 3)) {
      lines.push(`      ${m.from}`);
      lines.push(`        → ${m.to}${m.keepName ? '   ※巻数を読めず名前はそのまま' : ''}`);
    }
    if (ms.length > 3) lines.push(`      ... 他 ${ms.length - 3} 本`);
  }
  return lines.join('\n');
}
