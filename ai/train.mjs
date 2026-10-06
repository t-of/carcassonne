#!/usr/bin/env node
// 学習する CPU を育てる道具。同じコマンドを打てば作業フォルダの続きから進む。
//   node ai/train.mjs --dir .train/run1 --minutes 480 --workers 4
// 持ち時間でなく読む回数で打つので、マシンの速さが違っても同じ条件になる（--self-iters / --arena-iters）。
// 1 世代 = 自己対局（いまの最良の網を使う searchBot と貪欲を混ぜる）で局面を集める → 網を学習
//        → 候補の網 vs 最良（なければ手書きの評価）を同じ読む回数（--arena-iters）で対局 → 勝ち越したら最良にして ai/model.json へ書く
//        → 最良の網 vs 手書きの探索を --ref-games 局打って勝率を log に出す。
// 作業フォルダ: state.json（世代・履歴） best.json cand.json（網） buffer.x / buffer.y（集めた局面。新しい方から --buffer 件まで残す）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { Game } from '../engine.js';
import { greedyBot } from './bots.js';
import { searchBot } from './search.js';
import { features, FEATURE_DIM } from './features.js';
import { createNet, forward, toJSON, fromJSON, cloneNet, netEvaluate, SCALE } from './net.js';

const SELF = fileURLToPath(import.meta.url);

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 1 局ぶんの仕事（ワーカー側） ----
const botOf = (net, iters) => (g, rng) => searchBot(g, net ? { iters, evaluate: netEvaluate(net) } : { iters }, rng);

// 自己対局: 各手番の局面を両者の向きで記録し、終局後に「最後の点差 − そのときの点差」を目標にする。
function selfplay({ net, seed, iters, greedyRate, randomRate }) {
  const rng = mulberry32(seed);
  const game = new Game(2, { seed });
  const bots = [0, 1].map(() => (rng() < greedyRate ? greedyBot : botOf(net, iters)));
  const xs = [], now = [];
  while (!game.gameOver) {
    for (let me = 0; me < 2; me++) { xs.push(features(game, me)); now.push(game.players[me].score - game.players[1 - me].score); }
    const moves = game.legalMoves();
    if (!moves.length) break;
    const m = rng() < randomRate ? moves[Math.floor(rng() * moves.length)] : bots[game.currentPlayer](game, rng);
    game.applyMove(m);
  }
  const fin = [game.players[0].score - game.players[1].score, game.players[1].score - game.players[0].score];
  const X = new Float32Array(xs.length * FEATURE_DIM), Y = new Float32Array(xs.length);
  xs.forEach((x, i) => { X.set(x, i * FEATURE_DIM); Y[i] = (fin[i % 2] - now[i]) / SCALE; });
  return { X, Y };
}

// 対局: a が先手か後手かを seatA で決める。a から見た点差を返す
function match({ a, b, seed, iters, seatA }) {
  const rng = mulberry32(seed);
  const game = new Game(2, { seed });
  const bots = seatA === 0 ? [botOf(a, iters), botOf(b, iters)] : [botOf(b, iters), botOf(a, iters)];
  while (!game.gameOver) {
    const m = bots[game.currentPlayer](game, rng);
    if (!m) break;
    game.applyMove(m);
  }
  const d = game.players[0].score - game.players[1].score;
  return { diff: seatA === 0 ? d : -d };
}

if (!isMainThread) {
  parentPort.on('message', (job) => {
    try {
      const r = job.kind === 'selfplay'
        ? selfplay({ ...job, net: job.net ? fromJSON(job.net) : null })
        : match({ ...job, a: job.a ? fromJSON(job.a) : null, b: job.b ? fromJSON(job.b) : null });
      parentPort.postMessage({ id: job.id, result: r });
    } catch (e) { parentPort.postMessage({ id: job.id, error: e.stack || String(e) }); }
  });
} else {
  main().catch((e) => { console.error(e); process.exit(1); });
}

// ---- ワーカーの束 ----
function makePool(n) {
  const workers = Array.from({ length: n }, () => new Worker(SELF));
  const pending = new Map();
  let nextId = 0;
  const idle = [...workers], queue = [];
  const pump = () => { while (idle.length && queue.length) { const w = idle.pop(); w.postMessage(queue.shift()); } };
  for (const w of workers) w.on('message', (m) => {
    const j = pending.get(m.id); pending.delete(m.id); idle.push(w); pump();
    m.error ? j.rej(new Error(m.error)) : j.res(m.result);
  });
  return {
    run: (job) => new Promise((res, rej) => { job.id = nextId++; pending.set(job.id, { res, rej }); queue.push(job); pump(); }),
    close: () => workers.forEach((w) => w.terminate()),
  };
}

// ---- 学習（Adam、損失は二乗誤差） ----
function fit(net, X, Y, { epochs, lr, batch = 128, l2 = 1e-5, log }) {
  const L = net.sizes.length - 1, n = Y.length, D = FEATURE_DIM;
  const idx = Int32Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const nVal = Math.floor(n * 0.05), val = idx.subarray(0, nVal), train = idx.subarray(nVal);
  const params = [...net.w, ...net.b];
  const M = params.map((p) => new Float32Array(p.length)), V = params.map((p) => new Float32Array(p.length));
  let step = 0;
  const acts = [];
  const evalSet = (set) => { let s = 0; for (const r of set) { const e = forward(net, X.subarray(r * D, r * D + D)) - Y[r]; s += e * e; } return s / Math.max(1, set.length); };
  const zeroLoss = (set) => { let s = 0; for (const r of set) s += Y[r] * Y[r]; return s / Math.max(1, set.length); };
  const first = { val: evalSet(val), base: zeroLoss(val) };
  log(`  検証損失 開始 ${first.val.toFixed(4)}（「動かない」と読む基準 ${first.base.toFixed(4)}）`);
  let last = first.val;
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = train.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = train[i]; train[i] = train[j]; train[j] = t; }
    for (let s0 = 0; s0 < train.length; s0 += batch) {
      const end = Math.min(train.length, s0 + batch), bs = end - s0;
      const G = params.map((p) => new Float32Array(p.length));
      for (let q = s0; q < end; q++) {
        const r = train[q], x = X.subarray(r * D, r * D + D);
        const out = forward(net, x, acts);
        let d = new Float32Array([2 * (out - Y[r])]);
        for (let l = L - 1; l >= 0; l--) {
          const n0 = net.sizes[l], m = net.sizes[l + 1];
          const inp = l === 0 ? x : acts[l - 1];
          const gw = G[l], gb = G[L + l];
          for (let j = 0; j < m; j++) gb[j] += d[j];
          const dPrev = l > 0 ? new Float32Array(n0) : null;
          for (let i = 0; i < n0; i++) {
            const v = inp[i];
            if (!v && !dPrev) continue;
            const off = i * m;
            let acc = 0;
            for (let j = 0; j < m; j++) { gw[off + j] += d[j] * v; if (dPrev) acc += d[j] * net.w[l][off + j]; }
            if (dPrev && v > 0) dPrev[i] = acc; // 手前の層が ReLU
          }
          d = dPrev;
        }
      }
      step++;
      const c1 = 1 - 0.9 ** step, c2 = 1 - 0.999 ** step;
      params.forEach((p, k) => {
        const g = G[k], m = M[k], v = V[k];
        for (let i = 0; i < p.length; i++) {
          const gi = g[i] / bs + l2 * p[i];
          m[i] = 0.9 * m[i] + 0.1 * gi; v[i] = 0.999 * v[i] + 0.001 * gi * gi;
          p[i] -= lr * (m[i] / c1) / (Math.sqrt(v[i] / c2) + 1e-8);
        }
      });
    }
    last = evalSet(val);
    log(`  エポック ${ep + 1}/${epochs} 検証損失 ${last.toFixed(4)}`);
  }
  return { start: first.val, end: last, base: first.base };
}

// ---- 本体 ----
async function main() {
  const arg = (name, def) => { const i = process.argv.lastIndexOf(`--${name}`); if (i < 0) return def; return typeof def === 'number' ? Number(process.argv[i + 1]) : process.argv[i + 1]; };
  const dir = path.resolve(arg('dir', '.train/run'));
  const minutes = arg('minutes', 60), workers = arg('workers', 4);
  const games = arg('games', 512), selfIters = arg('self-iters', 6), arenaIters = arg('arena-iters', 12), arenaGames = arg('arena-games', 400), refGames = arg('ref-games', 200);
  const adopt = arg('adopt', 0.55), epochs = arg('epochs', 4), lr = arg('lr', 1e-3), bufMax = arg('buffer', 150000);
  const greedyRate = arg('greedy-rate', 0.15), randomRate = arg('random-rate', 0.03);
  const out = path.resolve(arg('out', path.join(path.dirname(SELF), 'model.json')));
  fs.mkdirSync(dir, { recursive: true });
  const log = (s) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${s}`);
  const P = (f) => path.join(dir, f);
  const readJson = (f) => (fs.existsSync(P(f)) ? JSON.parse(fs.readFileSync(P(f), 'utf8')) : null);
  const writeJson = (f, o) => { fs.writeFileSync(P(f) + '.tmp', JSON.stringify(o)); fs.renameSync(P(f) + '.tmp', P(f)); };

  const state = readJson('state.json') || { gen: 0, adopted: 0, history: [] };
  let best = readJson('best.json'); best = best && fromJSON(best);
  let cand = readJson('cand.json'); cand = cand ? fromJSON(cand) : (best ? cloneNet(best) : createNet());
  let X = new Float32Array(0), Y = new Float32Array(0);
  if (fs.existsSync(P('buffer.x'))) {
    const bx = fs.readFileSync(P('buffer.x')), by = fs.readFileSync(P('buffer.y'));
    X = new Float32Array(bx.buffer, bx.byteOffset, bx.length / 4).slice(); Y = new Float32Array(by.buffer, by.byteOffset, by.length / 4).slice();
  }
  log(`続きから: 世代 ${state.gen}、採用 ${state.adopted} 回、局面 ${Y.length} 個、最良 ${best ? 'あり' : '手書き'}`);

  const pool = makePool(workers);
  const t0 = Date.now();
  let genMs = 0;
  while ((Date.now() - t0 + genMs) / 60000 < minutes) {
    const g0 = Date.now();
    const gen = ++state.gen;
    // 1. 自己対局
    const bj = best ? toJSON(best) : null;
    const rs = await Promise.all(Array.from({ length: games }, (_, i) => pool.run({ kind: 'selfplay', net: bj, seed: gen * 100000 + i, iters: selfIters, greedyRate, randomRate })));
    const addN = rs.reduce((s, r) => s + r.Y.length, 0);
    const nx = new Float32Array(X.length + addN * FEATURE_DIM), ny = new Float32Array(Y.length + addN);
    nx.set(X); ny.set(Y);
    let o = Y.length;
    for (const r of rs) { nx.set(r.X, o * FEATURE_DIM); ny.set(r.Y, o); o += r.Y.length; }
    const from = Math.max(0, ny.length - bufMax);
    X = nx.slice(from * FEATURE_DIM); Y = ny.slice(from);
    fs.writeFileSync(P('buffer.x'), Buffer.from(X.buffer)); fs.writeFileSync(P('buffer.y'), Buffer.from(Y.buffer));
    log(`世代 ${gen}: 自己対局 ${games} 局、局面 +${addN}（計 ${Y.length}）`);
    // 2. 学習（前の世代の続きから）
    const loss = fit(cand, X, Y, { epochs, lr, log });
    writeJson('cand.json', toJSON(cand));
    // 3. 対局（候補 vs 最良。同じ山で先後を入れ替える）
    const cj = toJSON(cand);
    const diffs = (await Promise.all(Array.from({ length: arenaGames }, (_, i) => pool.run({ kind: 'match', a: cj, b: bj, seed: 7000000 + gen * 1000 + (i >> 1), iters: arenaIters, seatA: i & 1 })))).map((r) => r.diff);
    const score = diffs.reduce((s, d) => s + (d > 0 ? 1 : d === 0 ? 0.5 : 0), 0) / diffs.length;
    const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
    const ok = score >= adopt;
    if (ok) {
      best = cloneNet(cand); state.adopted++;
      writeJson('best.json', toJSON(best));
      fs.writeFileSync(out, JSON.stringify(toJSON(best)));
    }
    // 4. 物差し: 最良の網 vs 手書きの探索（search）。強くなっているかを外から見る
    let ref = '';
    if (best && refGames > 0) {
      const rj = toJSON(best);
      const rd = (await Promise.all(Array.from({ length: refGames }, (_, i) => pool.run({ kind: 'match', a: rj, b: null, seed: 9000000 + gen * 1000 + (i >> 1), iters: arenaIters, seatA: i & 1 })))).map((r) => r.diff);
      ref = +(rd.reduce((s, d) => s + (d > 0 ? 1 : d === 0 ? 0.5 : 0), 0) / rd.length).toFixed(3);
      log(`世代 ${gen}: 最良の網 vs 手書きの探索 ${refGames} 局 勝率 ${(ref * 100).toFixed(0)}%`);
    }
    genMs = Date.now() - g0;
    state.history.push({ gen, loss: +loss.end.toFixed(4), base: +loss.base.toFixed(4), winRate: +score.toFixed(3), meanDiff: +mean.toFixed(2), adopted: ok, vsSearch: ref, sec: Math.round(genMs / 1000) });
    writeJson('state.json', state);
    log(`世代 ${gen}: 候補の勝率 ${(score * 100).toFixed(0)}%（平均点差 ${mean.toFixed(1)}）→ ${ok ? '採用（' + path.relative(process.cwd(), out) + ' に書いた）' : '見送り'}  ${Math.round(genMs / 1000)} 秒`);
  }
  pool.close();
  log('時間になったので止める。同じコマンドで続きから進む');
}
