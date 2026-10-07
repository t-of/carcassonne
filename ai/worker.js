// 「つよい」CPU を画面とは別のスレッドで考える Web Worker（module worker）。
// 受け取るのは保存と同じ形 { id, data: { playerCount, deckOrder, log } }。盤を組み直して探索し、{ id, stats } を返す。
// stats は候補ごとの合計と回数（search.js の mergeStats で、複数の Worker の分を合わせて手にする）。乱数は Worker ごとに別。
import { rebuildFromLog } from '../engine.js';
import { searchBot } from './search.js';

// 打ち比べで一番強かった設定（同じ 1 手 0.4 秒で既定の探索に 54.3% で勝った）。
export const STRONG = { candidates: 'diverse', rootPolicy: 'halving', depth: 8, timeMs: 1000 };

self.onmessage = (e) => {
  const { id, data } = e.data;
  try { self.postMessage({ id, stats: searchBot(rebuildFromLog(data), { ...STRONG, stats: true }) }); }
  catch (err) { self.postMessage({ id, error: String(err) }); }
};
