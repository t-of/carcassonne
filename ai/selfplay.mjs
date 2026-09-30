#!/usr/bin/env node
// CPU どうしを対局させて、勝率・平均得点・1局あたりの時間を出す。
//   node ai/selfplay.mjs --games 1000 --a greedy --b random --seed 1
// 先手を毎局入れ替えるので、勝率は先手有利を打ち消したもの。
'use strict';
import { Game } from '../engine.js';
import { BOTS } from './bots.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return typeof def === 'number' ? Number(v) : v;
};
const GAMES = arg('games', 200);
const A = arg('a', 'greedy');
const B = arg('b', 'random');
const SEED = arg('seed', 1);

if (!BOTS[A] || !BOTS[B]) {
  console.error(`知らない CPU: --a/--b は ${Object.keys(BOTS).join(', ')} のどれか`);
  process.exit(1);
}

// 決まった順の乱数（mulberry32）。手番の乱数（tie-break）にだけ使う。ゲームの山札は Game 自身の種で決まる。
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let winsA = 0, winsB = 0, draws = 0;
let scoreA = 0, scoreB = 0;
const started = Date.now();

for (let i = 0; i < GAMES; i++) {
  const swapped = i % 2 === 1; // 先手を交互に入れ替える
  const seatBots = swapped ? [BOTS[B], BOTS[A]] : [BOTS[A], BOTS[B]];
  const rng = mulberry32(SEED * 1_000_003 + i);
  const game = new Game(2, { seed: SEED * 1_000_003 + i });
  while (!game.gameOver) {
    const bot = seatBots[game.currentPlayer];
    const move = bot(game, rng);
    if (!move) break; // 起きないはずだが、保険で対局を打ち切る
    game.applyMove(move);
  }
  const scoreSeat0 = game.players[0].score, scoreSeat1 = game.players[1].score;
  const [sa, sb] = swapped ? [scoreSeat1, scoreSeat0] : [scoreSeat0, scoreSeat1];
  scoreA += sa; scoreB += sb;
  if (sa > sb) winsA++; else if (sb > sa) winsB++; else draws++;
}

const ms = Date.now() - started;
console.log(`${GAMES} 局（${A} vs ${B}、種 ${SEED}）`);
console.log(`勝ち: ${A} ${winsA}（${(winsA / GAMES * 100).toFixed(1)}%） / ${B} ${winsB}（${(winsB / GAMES * 100).toFixed(1)}%） / 引き分け ${draws}`);
console.log(`平均得点: ${A} ${(scoreA / GAMES).toFixed(1)} / ${B} ${(scoreB / GAMES).toFixed(1)}`);
console.log(`所要時間: ${ms}ms（1局あたり ${(ms / GAMES).toFixed(2)}ms）`);
