import type { Config } from './config.js';
import type { Db } from './db.js';

/**
 * 新着の通知。
 *
 * **画面のお知らせと通知は別物。** お知らせ (events 表) には必ず残し、通知は
 * 「出せたら出す」。ntfy が落ちていても新着が消えないようにするため。
 *
 * PowerDowner とは担当が違う: 「ダウンロードが終わった」は向こうが出す。
 * pinax が出すのは「棚に増えた」だけ。二重に鳴らさない。
 */

const KIND_LABEL: Record<string, string> = {
  series_added: '新しい作品',
  volume_added: '新刊',
  series_completed: '完結',
  volume_gone: '見当たらない',
};

export async function pushPending(db: Db, cfg: Config, appUrl: string): Promise<number> {
  const pending = db.takeUnnotified(20);
  if (!pending.length) return 0;

  // ntfy を設定していなければ、通知済みの印だけ付けて終わり。
  // 印を付けないと溜まり続け、後から設定した時に全部まとめて鳴る
  if (!cfg.notify.ntfyUrl) {
    db.markNotified(pending.map((e) => Number(e.id)));
    return 0;
  }

  const sent: number[] = [];
  for (const e of pending) {
    const kind = String(e.kind);
    const title = `${KIND_LABEL[kind] ?? kind}: ${String(e.title)}`;
    const body = String(e.detail ?? '');
    try {
      const res = await fetch(cfg.notify.ntfyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          Title: encodeRfc2047(title),
          Tags: kind === 'series_completed' ? 'checkered_flag' : 'books',
          Click: e.series_id ? `${appUrl}/#/series/${Number(e.series_id)}` : appUrl,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) sent.push(Number(e.id));
    } catch {
      // 届かなかったものは印を付けない。次の巡回でもう一度試す
    }
  }
  db.markNotified(sent);
  return sent.length;
}

/**
 * ヘッダに日本語を載せるための符号化。HTTP ヘッダは ASCII しか通らないので、
 * そのまま入れると ntfy 側で文字化けするか、fetch がヘッダを拒否する。
 */
function encodeRfc2047(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}
