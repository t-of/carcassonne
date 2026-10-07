// 「つよい」CPU を画面とは別のスレッドで考える Web Worker（module worker）。
// 受け取るのは保存と同じ形 { id, data: { playerCount, deckOrder, log } }。盤を組み直して探索し、{ id, move } を返す。
import { rebuildFromLog } from '../engine.js';
import { searchBot } from './search.js';

// 打ち比べで一番強かった設定（同じ 1 手 0.4 秒で既定の探索に 54.3% で勝った）。
export const STRONG = { candidates: 'diverse', rootPolicy: 'halving', depth: 8, timeMs: 1000 };

self.onmessage = (e) => {
  const { id, data } = e.data;
  try { self.postMessage({ id, move: searchBot(rebuildFromLog(data), STRONG) }); }
  catch (err) { self.postMessage({ id, error: String(err) }); }
};
