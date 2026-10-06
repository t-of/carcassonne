'use strict';
// 学習した CPU の強さを測る相手（ランダム・貪欲）。engine.js の legalMoves()/applyMove()/clone() だけを使う。
// 画面の CPU（main.js）もここの greedyBot をそのまま使う。プレーンな ESM なので Node からも
// ブラウザからも同じファイルを import できる（sw.js の SHELL にも入れて offline で読めるようにしてある）。

// どれか 1 手をランダムに選ぶ。手がなければ null（呼び出し側は起きないはずだが念のため）。
export function randomBot(game, rng = Math.random) {
  const moves = game.legalMoves();
  if (!moves.length) return null;
  return moves[Math.floor(rng() * moves.length)];
}

// その手ですぐ入る点 ＋ 自分の駒が乗っている未完成の区画のざっくりした見込み点、が一番大きい手を選ぶ。
// 見込み点は「今のタイル数から計算した完成時の点」の半分（未完成の分を割り引く）。
export function greedyBot(game, rng = Math.random) {
  const moves = game.legalMoves();
  if (!moves.length) return null;
  const values = greedyValues(game, moves, rng);
  let best = 0;
  for (let i = 1; i < moves.length; i++) if (values[i] > values[best]) best = i;
  return moves[best];
}

// 各手の貪欲な点数（その手の得点 ＋ 見込み）。探索の事前の点数にも使う。
export function greedyValues(game, moves, rng = Math.random) {
  const player = game.currentPlayer;
  return moves.map((move) => {
    const after = game.clone();
    const before = after.players[player].score;
    after.applyMove(move);
    const gained = after.players[player].score - before;
    return gained + estimatePotential(after, player) + rng() * 1e-6; // 同点は僅かな乱数で割る
  });
}

function estimatePotential(game, player) {
  let total = 0;
  // dsu.meta のキーはつねに「今生きている根」だけ（union() が古い根の meta を消すため）なので、
  // allNodeKeys 経由で find() し直さなくても、直接なめれば道・都市の根に重複なく触れられる。
  for (const meta of game.dsu.meta.values()) {
    if (meta.awarded || !meta.meeples.some((m) => m.player === player)) continue;
    if (meta.type === 'city') total += meta.tiles.size * 2 + meta.pennants * 2;
    else if (meta.type === 'road') total += meta.tiles.size;
  }
  for (const c of game.cloisters.values()) {
    if (!c.awarded && c.meeple && c.meeple.player === player) total += 9;
  }
  return total * 0.5;
}

import { searchBot } from './search.js';
// search / search02 / search05: 1 手の考える時間（秒）違い。第 3 引数の rng は無視してよい。
export const BOTS = {
  random: randomBot, greedy: greedyBot,
  search: (g, rng) => searchBot(g, { timeMs: 1000 }, rng),
  search02: (g, rng) => searchBot(g, { timeMs: 200 }, rng),
  search05: (g, rng) => searchBot(g, { timeMs: 500 }, rng),
};
