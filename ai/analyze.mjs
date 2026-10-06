#!/usr/bin/env node
// 対局のデータ集め。1 局 1 行の JSON Lines と、集計を出す。engine.js は読むだけ（得点の内訳は applyMove の events から取る）。
//   打つ:   node ai/analyze.mjs --bots search,greedy --games 100 --iters 12 --players 2 --start 0 --out a.jsonl
//   集計だけ: node ai/analyze.mjs --aggregate runs/analyze-x/part-*.jsonl
// --bots はプレーヤーごとの CPU（search / greedy / random）。局ごとに席を 1 つずつずらすので先手は偏らない。
// --start は通し番号の始め（種 = start + 局番号。分割して並べるときに使う）。
import fs from 'node:fs';
import { Game, tileKey } from '../engine.js';
import { greedyBot, randomBot } from './bots.js';
import { searchBot, defaultEvaluate } from './search.js';

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.lastIndexOf(`--${name}`); if (i < 0) return def; return typeof def === 'number' ? Number(args[i + 1]) : args[i + 1]; };

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES = ['city', 'road', 'cloister', 'field'];
const zero = () => ({ city: 0, road: 0, cloister: 0, field: 0 });
const keyType = (k) => (k === 'M' ? 'cloister' : { C: 'city', R: 'road', F: 'field' }[k.match(/([CRF])\d+$/)[1]]);

// ---- 1 局 ----
function playGame({ specs, players, iters, seed, rot }) {
  const rng = mulberry32(seed);
  const game = new Game(players, { seed });
  const botName = (s) => specs[(s + rot) % specs.length];
  const fn = { search: (g) => searchBot(g, { iters }, rng), greedy: (g) => greedyBot(g, rng), random: (g) => randomBot(g, rng) };
  // 最後の採点は applyMove の中（drawNext）で走り、その events は呼び出し側に返らないので、finishGame を包んで拾う（エンジンは変えない）
  let finalEvents = [];
  const orig = game.finishGame;
  game.finishGame = function () { orig.call(this); finalEvents = this.events.slice(); };

  const mid = Array.from({ length: players }, zero), fin = Array.from({ length: players }, zero);
  const add = (acc, evs) => { for (const e of evs) for (const p of e.players) acc[p][e.type] += e.points; };
  const meeples = [], alive = []; // alive: まだ盤にいる駒（返ってきた手を調べる）
  const ev = [];
  let t = 0;
  while (!game.gameOver) {
    ev.push(Math.round(defaultEvaluate(game, 0) * 10) / 10);
    const move = fn[botName(game.currentPlayer)](game);
    if (!move) break;
    const p = game.currentPlayer;
    const placed = move.meepleKey != null ? { t, p, k: keyType(move.meepleKey), ret: null, key: move.meepleKey, x: move.x, y: move.y } : null;
    add(mid, game.applyMove(move));
    if (placed) { meeples.push(placed); alive.push(placed); }
    for (let i = alive.length - 1; i >= 0; i--) {
      const a = alive[i];
      const still = a.k === 'cloister' ? !!game.cloisters.get(tileKey(a.x, a.y))?.meeple
        : game.dsu.meta_(a.key).meeples.some((m) => m.x === a.x && m.y === a.y && m.key === a.key);
      if (!still && !game.gameOver) { a.ret = t - a.t; alive.splice(i, 1); }
    }
    t++;
  }
  add(fin, finalEvents);
  const scores = game.players.map((q) => q.score);
  const checkOk = scores.every((s, i) => s === TYPES.reduce((a, k) => a + mid[i][k] + fin[i][k], 0));
  const max = Math.max(...scores);
  const winners = scores.flatMap((s, i) => (s === max ? [i] : []));
  const opp = Math.max(...scores.slice(1));
  return {
    seed, moves: t, bots: Array.from({ length: players }, (_, s) => botName(s)), scores, mid, fin, checkOk,
    winners, firstWon: winners.length === 1 && winners[0] === 0,
    meeples: meeples.map(({ t, p, k, ret }) => ({ t, p, k, ret })),
    ev, finalDiff: scores[0] - opp, // ev も finalDiff もプレーヤー 0（先手）から見た点差
  };
}

// ---- 集計 ----
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');
function corr(xs, ys) {
  const mx = mean(xs), my = mean(ys); let sxy = 0, sxx = 0, syy = 0;
  xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; syy += (ys[i] - my) ** 2; });
  return sxy / Math.sqrt(sxx * syy);
}
const row = (o) => TYPES.map((k) => `${k} ${f(o[k])}`).join(' / ');

function aggregate(games) {
  const out = [];
  const log = (s = '') => out.push(s);
  const N = games.length;
  log(`== 集計: ${N} 局、人数 ${games[0].scores.length}、平均手数 ${f(mean(games.map((g) => g.moves)))}、得点の内訳が合わなかった局 ${games.filter((g) => !g.checkOk).length} ==`);
  const combos = [...new Set(games.map((g) => g.bots.join(' vs ')))];
  log(`組み合わせ（席の並び）: ${combos.join(' / ')}`);

  // 得点の内訳（CPU の種類ごと）
  log('\n-- 得点の内訳（1 人 1 局の平均。完成=途中で完成した分、最後=最後の採点の分）--');
  const names = [...new Set(games.flatMap((g) => g.bots))];
  for (const name of names) {
    const rows = games.flatMap((g) => g.bots.flatMap((b, i) => (b === name ? [{ s: g.scores[i], m: g.mid[i], e: g.fin[i] }] : [])));
    const m = {}, e = {}, tot = {};
    for (const k of TYPES) { m[k] = mean(rows.map((r) => r.m[k])); e[k] = mean(rows.map((r) => r.e[k])); tot[k] = m[k] + e[k]; }
    const sum = TYPES.reduce((a, k) => a + tot[k], 0);
    log(`${name}（${rows.length} 人分）合計 ${f(mean(rows.map((r) => r.s)))} 点`);
    log(`  完成: ${row(m)}`);
    log(`  最後: ${row(e)}`);
    log(`  割合: ${TYPES.map((k) => `${k} ${f(tot[k] / sum * 100, 0)}%`).join(' / ')}  （完成のうち最後に回った割合 = 最後/合計: ${TYPES.map((k) => `${k} ${f(e[k] / tot[k] * 100, 0)}%`).join(' / ')}）`);
  }

  // 勝者と敗者（同点の局は除く）
  const dec = games.filter((g) => g.winners.length === 1);
  const W = zero(), L = zero(); let nl = 0;
  for (const g of dec) g.scores.forEach((_, i) => {
    const tgt = g.winners[0] === i ? W : L;
    for (const k of TYPES) tgt[k] += g.mid[i][k] + g.fin[i][k];
    if (g.winners[0] !== i) nl++;
  });
  for (const k of TYPES) { W[k] /= dec.length; L[k] /= nl; }
  const D = {}; for (const k of TYPES) D[k] = W[k] - L[k];
  const dsum = TYPES.reduce((a, k) => a + D[k], 0);
  log(`\n-- 勝者 − 敗者（${dec.length} 局、同点 ${N - dec.length} 局は除く）--`);
  log(`  勝者: ${row(W)}\n  敗者: ${row(L)}\n  差  : ${row(D)}`);
  log(`  差の割合（点差のうちどれが決めたか）: ${TYPES.map((k) => `${k} ${f(D[k] / dsum * 100, 0)}%`).join(' / ')}`);

  // ミープル
  log('\n-- ミープルの置き方（1 人 1 局あたり）--');
  const per = games.reduce((a, g) => a + g.scores.length, 0);
  const all = games.flatMap((g) => g.meeples.map((m) => ({ ...m, rel: m.t / g.moves })));
  for (const k of TYPES) {
    const ms = all.filter((m) => m.k === k), rets = ms.filter((m) => m.ret != null);
    log(`  ${k}: ${f(ms.length / per, 2)} 回  平均 ${f(mean(ms.map((m) => m.t)))} 手目  回収まで平均 ${f(mean(rets.map((m) => m.ret)))} 手（回収 ${f(rets.length / ms.length * 100, 0)}%、最後まで残る ${f(100 - rets.length / ms.length * 100, 0)}%）`);
  }
  log(`  置かない手の割合は ${f((1 - all.length / games.reduce((a, g) => a + g.moves, 0)) * 100, 0)}%（全手のうち）`);
  const ph = (r) => (r < 1 / 3 ? 0 : r < 2 / 3 ? 1 : 2);
  const PH = ['序盤', '中盤', '終盤'];
  log('  時期ごとの置いた数（1 人 1 局あたり、序盤/中盤/終盤＝手数の 3 分割）:');
  for (const k of TYPES) log(`    ${k}: ${[0, 1, 2].map((i) => `${PH[i]} ${f(all.filter((m) => m.k === k && ph(m.rel) === i).length / per, 2)}`).join(' / ')}`);
  const fl = all.filter((m) => m.k === 'field');
  log(`  草原: 平均 ${f(mean(fl.map((m) => m.rel * 100)), 0)}% 地点（0=最初 100=最後）、10 分割の分布 ${Array.from({ length: 10 }, (_, b) => fl.filter((m) => Math.min(9, Math.floor(m.rel * 10)) === b).length).join(' ')}`);

  // 先手
  const fw = games.filter((g) => g.firstWon).length, ties = N - dec.length;
  log(`\n-- 先手 --\n  先手の勝ち ${fw}/${N}（${f(fw / N * 100)}%）、同点 ${ties}、先手の負け ${N - fw - ties}。同点を半分とすると ${f((fw + ties / 2) / N * 100)}%。先手の平均点差 ${f(mean(games.map((g) => g.finalDiff)), 2)}`);
  if (combos.length > 1) for (const name of names) {
    const rows = games.flatMap((g) => g.bots.map((b, i) => ({ b, i, win: g.winners.length === 1 && g.winners[0] === i, tie: g.winners.length > 1 && g.winners.includes(i) })).filter((r) => r.b === name));
    log(`  ${name} の勝率 ${f(rows.filter((r) => r.win).length / rows.length * 100)}%（同点 ${rows.filter((r) => r.tie).length}）`);
  }

  // defaultEvaluate のずれ（先手＝プレーヤー 0 から見た評価と、最後の点差）
  log('\n-- defaultEvaluate と最後の点差（先手から見る。進み具合 = 手数 ÷ 総手数）--');
  const bin = (n, label) => {
    const xs = Array.from({ length: n }, () => ({ e: [], y: [] }));
    for (const g of games) g.ev.forEach((v, t) => { const b = xs[Math.min(n - 1, Math.floor(t / g.moves * n))]; b.e.push(v); b.y.push(g.finalDiff); });
    xs.forEach((b, i) => log(`  ${label(i)}: 相関 ${f(corr(b.e, b.y), 3)}  平均誤差 ${f(mean(b.e.map((v, j) => Math.abs(v - b.y[j]))), 2)}  偏り（評価−最終）${f(mean(b.e.map((v, j) => v - b.y[j])), 2)}  評価の平均 ${f(mean(b.e), 2)} / 最終の平均 ${f(mean(b.y), 2)}  (${b.e.length} 局面)`));
  };
  bin(3, (i) => PH[i]);
  log('  10 分割:');
  bin(10, (i) => `${i * 10}-${i * 10 + 10}%`);
  return out.join('\n');
}

// ---- main ----
if (args.includes('--aggregate')) {
  const files = args.slice(args.indexOf('--aggregate') + 1).filter((a) => !a.startsWith('--'));
  const games = files.flatMap((fn) => fs.readFileSync(fn, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  if (!games.length) { console.error('局がない'); process.exit(1); }
  console.log(aggregate(games));
} else {
  const specs = arg('bots', 'search,search').split(',');
  for (const s of specs) if (!['search', 'greedy', 'random'].includes(s)) { console.error(`知らない CPU: ${s}（search / greedy / random）`); process.exit(1); }
  const n = arg('games', 4), players = arg('players', 2), iters = arg('iters', 12), start = arg('start', 0), outFile = arg('out', '');
  const games = [];
  const fd = outFile ? fs.openSync(outFile, 'w') : null;
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const g = playGame({ specs, players, iters, seed: 7000000 + start + i, rot: (start + i) % specs.length });
    games.push(g);
    if (fd != null) fs.writeSync(fd, JSON.stringify(g) + '\n');
  }
  if (fd != null) fs.closeSync(fd);
  if (arg('quiet', '') !== '1') { console.log(aggregate(games)); }
  console.error(`${n} 局 ${((Date.now() - t0) / 1000).toFixed(1)} 秒（1 局 ${((Date.now() - t0) / n / 1000).toFixed(2)} 秒）`);
}
