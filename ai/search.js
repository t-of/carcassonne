'use strict';
// 最強 CPU: 決定化つきモンテカルロ探索（根の手を UCB で選び、毎回残りタイル山を混ぜ直して先を読む）。
// 山札の順（deckOrder の並び）は見ない。まだ引いていないタイルの「種類と枚数」だけを取り出して混ぜ直す。
// 先の読みは depth 手で打ち切り、最後の採点（未完成の区画・草原・修道院）まで含めた点差で評価する。
import { shuffle } from '../engine.js';
import { greedyValues } from './bots.js';

const DEFAULTS = { timeMs: 1000, depth: 14, meepleValue: 0.4, c: 6, rollEps: 0.3, topK: 8, rollK: 3, meeplePenalty: 0.5 };
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// 点差（自分 − 一番強い相手）。盤を複製して最後の採点を先に入れてみる。
export function defaultEvaluate(game, me, p = DEFAULTS) {
  let g = game;
  if (!g.gameOver) { g = game.clone(); g.finishGame(); }
  let opp = -Infinity;
  for (let i = 0; i < g.players.length; i++) if (i !== me && g.players[i].score > opp) opp = g.players[i].score;
  let v = g.players[me].score - opp;
  v += (game.players[me].meeples - Math.max(...game.players.filter((_, i) => i !== me).map((q) => q.meeples))) * p.meepleValue;
  return v;
}

function rolloutMove(game, rng, p) {
  const moves = game.legalMoves();
  if (!moves.length) return null;
  // 軽いポリシー: ランダムに rollK 手だけ選び、その場の得点が一番大きいものを打つ（rollK=1 ならランダム）
  const player = game.currentPlayer;
  let best = null, bv = -Infinity;
  const k = Math.min(p.rollK, moves.length);
  for (let i = 0; i < k; i++) {
    const m = moves[Math.floor(rng() * moves.length)];
    if (k === 1) return m;
    const g = game.clone(); const before = g.players[player].score;
    g.applyMove(m);
    const v = g.players[player].score - before + (m.meepleKey != null ? -p.meeplePenalty : 0) + rng() * 1e-3;
    if (v > bv) { bv = v; best = m; }
  }
  return best;
}

export function searchBot(game, opts = {}, rng = Math.random) {
  const p = { ...DEFAULTS, ...opts };
  let moves = game.legalMoves();
  if (moves.length <= 1) return moves[0] || null;
  const me = game.currentPlayer;
  // 差し替え口: opts.evaluate(game, me) → 自分から見た点差っぽい数（大きいほど良い）、
  // opts.prior(game, moves) → 各手の事前の点数配列（大きいほど有望。省略は貪欲の 1 手評価）。学習した網はここへ。
  const evalFn = p.evaluate || defaultEvaluate;
  const prior = p.prior ? p.prior(game, moves) : greedyValues(game, moves);
  // 手数が多い（駒の置き方まで入れると 100 超）ので、事前の点数が上位 topK の手だけを読む。
  if (moves.length > p.topK) {
    const order = moves.map((_, i) => i).sort((i, j) => prior[j] - prior[i]).slice(0, p.topK);
    moves = order.map((i) => moves[i]);
  }
  const n = moves.length;
  const left = game.deckOrder.slice(game.deckPos); // 種類と枚数だけ使う（順は毎回 shuffle で捨てる）
  const sum = new Array(n).fill(0);
  const deadline = now() + p.timeMs;
  const base = game.clone();
  let rounds = 0;
  // 同じ山の並び（決定化）を全候補に使い、候補どうしの比べを公平にする
  do {
    const deck = shuffle(left, rng);
    for (let k = 0; k < n; k++) {
      const g = base.clone();
      g.deckOrder = deck; g.deckPos = 0;
      g.applyMove(moves[k]);
      for (let d = 0; d < p.depth && !g.gameOver; d++) {
        const m = rolloutMove(g, rng, p);
        if (!m) break;
        g.applyMove(m);
      }
      sum[k] += evalFn(g, me, p);
    }
    rounds++;
  } while (now() < deadline);
  let best = 0;
  for (let i = 1; i < n; i++) if (sum[i] > sum[best]) best = i;
  return moves[best];
}
