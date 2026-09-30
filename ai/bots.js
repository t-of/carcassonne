'use strict';
// 学習した CPU の強さを測る相手（ランダム・貪欲）。engine.js の legalMoves()/applyMove()/clone() だけを使う。
// ブラウザには配らない（sw.js の SHELL に入れない）ので、ここでは import ではなく相対パスの ESM のまま。

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
  const player = game.currentPlayer;
  let best = null, bestValue = -Infinity;
  for (const move of moves) {
    const after = game.clone();
    const before = after.players[player].score;
    after.applyMove(move);
    const gained = after.players[player].score - before;
    const value = gained + estimatePotential(after, player) + rng() * 1e-6; // 同点は僅かな乱数で割る
    if (value > bestValue) { bestValue = value; best = move; }
  }
  return best;
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

export const BOTS = { random: randomBot, greedy: greedyBot };
