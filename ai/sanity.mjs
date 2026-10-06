#!/usr/bin/env node
// 網の入れ方が悪くないかを見分ける道具。arena と同じ match（同じ山で先後を入れ替え、同じ読む回数）で、手書き（b: null）と打つ。
//   node ai/sanity.mjs --games 64 --workers 64 --net runs/run2/cand.json
// 条件: 重み 0（理屈では 50%）／作りたての網／学習済みの網／学習済みの最後の層を 1/4 と 0（残差を弱めたもの）
import fs from 'node:fs';
import { createNet, toJSON, fromJSON } from './net.js';
import { match, makePool } from './train.mjs';

const arg = (name, def) => { const i = process.argv.lastIndexOf(`--${name}`); if (i < 0) return def; return typeof def === 'number' ? Number(process.argv[i + 1]) : process.argv[i + 1]; };
const games = arg('games', 4), workers = arg('workers', 4), iters = arg('iters', 12), file = arg('net', '');

const zero = createNet(); [...zero.w, ...zero.b].forEach((a) => a.fill(0));
const conds = [['重み 0', toJSON(zero)], ['作りたて', toJSON(createNet())]];
if (file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const scaled = (k) => { const n = fromJSON(j); n.w[n.w.length - 1].forEach((v, i, a) => { a[i] = v * k; }); n.b[n.b.length - 1][0] *= k; return toJSON(n); };
  conds.push(['学習済み', j], ['学習済み 最後の層×0.25', scaled(0.25)], ['学習済み 最後の層×0', scaled(0)]);
}
const pool = makePool(workers);
for (const [name, a] of conds) {
  const diffs = (await Promise.all(Array.from({ length: games }, (_, i) => pool.run({ kind: 'match', a, b: null, seed: 5000000 + (i >> 1), iters, seatA: i & 1 })))).map((r) => r.diff);
  const win = diffs.reduce((s, d) => s + (d > 0 ? 1 : d === 0 ? 0.5 : 0), 0) / games;
  console.log(`${name}: 勝率 ${(win * 100).toFixed(0)}%（平均点差 ${(diffs.reduce((s, d) => s + d, 0) / games).toFixed(1)}、${games} 局、iters ${iters}）`);
}
pool.close();
