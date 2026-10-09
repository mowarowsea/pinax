/**
 * 今このマシンから外へ出ていく時のグローバル IP を出す。
 *
 * 楽天に弾かれた時は通知の文面にも IP が載るが、先に登録しておきたい時のために残す。
 * 登録できるのは 9 行まで。変わったら足す (古いものを消すのは埋まってからでよい)。
 */
import { currentPublicIp } from './public-ip.js';

const ip = await currentPublicIp();

if (!ip) {
  console.error('グローバル IP を確かめられませんでした (外に出られていない?)');
  process.exit(1);
}

console.log(ip);
console.error('');
console.error('https://webservice.rakuten.co.jp/app/list で 許可されたIP にこれを追加する (9 行まで登録できる)。');
