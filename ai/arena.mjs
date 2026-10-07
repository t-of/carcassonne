#!/usr/bin/env node
// 探索 CPU の変種 A 対 B の対戦場。同じ山を先後（席）入れ替えて 2 局ずつ打つ（ペア）。
//   node ai/arena.mjs --a '{"iters":12}' --b '{"candidates":"diverse","budget":20000}' --games 64 --seed 1 --out x.jsonl
//   node ai/arena.mjs --summary a.jsonl b.jsonl ...    （jsonl を読んで集計だけ）
// 変種は searchBot のオプションの JSON。--players 3 以上は A,B,A,B… と席に並べ、各陣営の最高点どうしを比べる。
import fs from 'node:fs';
import { Game } from '../engine.js';
import { searchBot } from './search.js';

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.lastIndexOf(`--${name}`); return i < 0 ? def : args[i + 1]; };

function rngOf(seed) { let a = seed >>> 0 || 1; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// 1 局。swap=0 なら A が席 0, 2, …、swap=1 なら B が席 0, 2, …
function play(A, B, seed, players, swap) {
  const game = new Game(players, { seed });
  const rng = rngOf(seed);
  const isA = (s) => (s % 2 === 0) === (swap === 0);
  const t = { A: { ms: 0, moves: 0 }, B: { ms: 0, moves: 0 } };
  while (!game.gameOver) {
    const key = isA(game.currentPlayer) ? 'A' : 'B';
    const t0 = performance.now();
    const m = searchBot(game, key === 'A' ? A : B, rng);
    t[key].ms += performance.now() - t0; t[key].moves++;
    if (!m) break;
    game.applyMove(m);
  }
  const best = (f) => Math.max(...game.players.map((q, i) => (f(i) ? q.score : -Infinity)));
  const a = best(isA), b = best((i) => !isA(i));
  return { seed, swap, a, b, diff: a - b, win: a > b ? 1 : a === b ? 0.5 : 0, msA: t.A.ms, movesA: t.A.moves, msB: t.B.ms, movesB: t.B.moves };
}

function summarize(rows) {
  const pairs = new Map();
  for (const r of rows) { if (!pairs.has(r.seed)) pairs.set(r.seed, []); pairs.get(r.seed).push(r); }
  const per = [...pairs.values()].map((g) => g.reduce((s, r) => s + r.win, 0) / g.length);
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const wr = mean(per);
  const sd = per.length > 1 ? Math.sqrt(per.reduce((s, x) => s + (x - wr) ** 2, 0) / (per.length - 1)) : 0;
  const ci = 1.96 * sd / Math.sqrt(per.length);
  const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
  return [
    `局数 ${rows.length}（ペア ${per.length}）`,
    `A の勝率 ${(wr * 100).toFixed(1)}%（95% 信頼区間 ${((wr - ci) * 100).toFixed(1)}〜${((wr + ci) * 100).toFixed(1)}%、ペア単位）`,
    `平均点差（A−B） ${mean(rows.map((r) => r.diff)).toFixed(2)}`,
    `1 手の平均時間 A ${(sum((r) => r.msA) / sum((r) => r.movesA)).toFixed(1)} ms / B ${(sum((r) => r.msB) / sum((r) => r.movesB)).toFixed(1)} ms`,
  ].join('\n');
}

if (args.includes('--summary')) {
  const files = args.slice(args.indexOf('--summary') + 1);
  const rows = files.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  console.log(summarize(rows));
} else {
  const A = JSON.parse(arg('a', '{}')), B = JSON.parse(arg('b', '{}'));
  const games = Number(arg('games', 2)), players = Number(arg('players', 2)), seed = Number(arg('seed', 1)), out = arg('out', '');
  if (out) fs.writeFileSync(out, '');
  const rows = [];
  for (let i = 0; i < games; i++) {
    const r = play(A, B, seed * 1000000 + (i >> 1), players, i & 1); // 2 局で 1 ペア
    rows.push(r);
    if (out) fs.appendFileSync(out, JSON.stringify(r) + '\n');
  }
  console.log(summarize(rows));
}
