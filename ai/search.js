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

// 軽いポリシーで 1 手進めた盤を返す（打てる手がなければ null）。
// ランダムに rollK 手だけ選び、その場の得点が一番大きいものを打つ（rollK=1 ならランダム）。
// 試しに打った複製がそのまま次の盤になるので、選んだ手をもう一度 applyMove し直さない。
function rolloutMove(game, rng, p) {
  const moves = game.legalMoves();
  if (!moves.length) return null;
  const player = game.currentPlayer;
  const k = Math.min(p.rollK, moves.length);
  if (k === 1) { game.applyMove(moves[Math.floor(rng() * moves.length)]); return game; }
  let best = -1, bv = -Infinity, bg = null;
  const gain = new Map(); // 同じ手を 2 度引いたら、打ち直さず得点を使い回す
  for (let i = 0; i < k; i++) {
    const mi = Math.floor(rng() * moves.length), m = moves[mi];
    let g = null, d = gain.get(mi);
    if (d === undefined && !game.mayScoreIfPlayed(m)) { d = 0; gain.set(mi, 0); } // 得点が入らないと分かる手は打ってみない
    if (d === undefined) {
      g = game.clone(); const before = g.players[player].score;
      g.applyMove(m);
      d = g.players[player].score - before; gain.set(mi, d);
    }
    const v = d + (m.meepleKey != null ? -p.meeplePenalty : 0) + rng() * 1e-3;
    if (v > bv) { bv = v; best = mi; bg = g; }
  }
  if (!bg) { bg = game.clone(); bg.applyMove(moves[best]); }
  return bg;
}

export function searchBot(game, opts = {}, rng = Math.random) {
  const p = { ...DEFAULTS, ...opts };
  let moves = game.legalMoves();
  if (moves.length <= 1) return moves[0] || null;
  const me = game.currentPlayer;
  // 差し替え口: opts.evaluate(game, me) → 自分から見た点差っぽい数（大きいほど良い）、
  // opts.iters を渡すと時間でなく読む回数（全候補を 1 巡 = 1 回）で打ち切る。マシンの速さに結果が左右されない。
  // opts.prior(game, moves) → 各手の事前の点数配列（大きいほど有望。省略は貪欲の 1 手評価）。学習した網はここへ。
  const evalFn = p.evaluate || defaultEvaluate;
  const prior = p.prior ? p.prior(game, moves) : greedyValues(game, moves);
  // 手数が多い（駒の置き方まで入れると 100 超）ので、事前の点数が上位 topK の手だけを読む。
  // candidates:'diverse' は、さらに種類（置かない・草原・都市・道・修道院）ごとの最良の 1 手を必ず入れる。
  if (moves.length > p.topK) {
    const idx = moves.map((_, i) => i).sort((i, j) => prior[j] - prior[i]);
    const order = idx.slice(0, p.topK);
    if (p.candidates === 'diverse') {
      const seen = new Set(order.map((i) => kindOf(moves[i])));
      for (const i of idx) { const t = kindOf(moves[i]); if (!seen.has(t)) { seen.add(t); order.push(i); } }
    }
    moves = order.map((i) => moves[i]);
  }
  const n = moves.length;
  const left = game.deckOrder.slice(game.deckPos); // 種類と枚数だけ使う（順は毎回 shuffle で捨てる）
  const sum = new Array(n).fill(0), cnt = new Array(n).fill(0);
  const t0 = now();
  const base = game.clone();
  const depth = p.depth === 'end' ? Infinity : p.depth;
  let steps = 0, samples = 0;
  // 候補 k を 1 回読んで評価値を足す（deck は呼び出し側が混ぜた山）
  const sample = (k, deck) => {
    let g = base.clone();
    g.deckOrder = deck; g.deckPos = 0;
    g.applyMove(moves[k]); steps++;
    for (let d = 0; d < depth && !g.gameOver; d++) {
      const next = rolloutMove(g, rng, p);
      if (!next) break;
      g = next; steps++;
    }
    sum[k] += p.evalMode === 'final' && g.gameOver && !p.evaluate ? finalDiff(g, me) : evalFn(g, me, p);
    cnt[k]++; samples++;
  };
  // 使った量の割合（0〜1）。budget は読みの手数、iters は 1 巡 = 全候補 1 回ずつ、なければ時間。
  const used = () => (p.budget ? steps / p.budget : p.iters ? samples / (p.iters * n) : (now() - t0) / p.timeMs);
  // 同じ山の並び（決定化）を候補に使い、候補どうしの比べを公平にする
  if (p.rootPolicy === 'ucb') {
    for (let k = 0; k < n; k++) sample(k, shuffle(left, rng));
    while (used() < 1) {
      const N = samples; let bk = 0, bv = -Infinity;
      for (let k = 0; k < n; k++) { const v = sum[k] / cnt[k] + p.c * Math.sqrt(Math.log(N) / cnt[k]); if (v > bv) { bv = v; bk = k; } }
      sample(bk, shuffle(left, rng));
    }
  } else {
    let alive = moves.map((_, k) => k);
    const stages = p.rootPolicy === 'halving' ? Math.max(1, Math.ceil(Math.log2(n))) : 1;
    for (let s = 1; s <= stages; s++) {
      do {
        const deck = shuffle(left, rng);
        for (const k of alive) sample(k, deck);
      } while (used() < s / stages);
      if (s < stages) {
        alive.sort((i, j) => sum[j] / cnt[j] - sum[i] / cnt[i]);
        alive = alive.slice(0, Math.ceil(alive.length / 2));
      }
    }
    if (alive.length < n) { // 半減で残った手の中から選ぶ
      let best = alive[0];
      for (const k of alive) if (sum[k] / cnt[k] > sum[best] / cnt[best]) best = k;
      return moves[best];
    }
  }
  let best = 0;
  if (p.rootPolicy === 'ucb') { for (let i = 1; i < n; i++) if (sum[i] / cnt[i] > sum[best] / cnt[best]) best = i; }
  else for (let i = 1; i < n; i++) if (sum[i] > sum[best]) best = i;
  return moves[best];
}

// 手の種類: 置かない 'N'、修道院 'M'、都市 'C'、道 'R'、草原 'F'
function kindOf(m) { return m.meepleKey == null ? 'N' : m.meepleKey === 'M' ? 'M' : m.meepleKey.match(/[CRF]/)[0]; }

// 最後まで読んだ局の最終の点差（ミープルの補正なし）
function finalDiff(g, me) {
  let opp = -Infinity;
  for (let i = 0; i < g.players.length; i++) if (i !== me && g.players[i].score > opp) opp = g.players[i].score;
  return g.players[me].score - opp;
}
