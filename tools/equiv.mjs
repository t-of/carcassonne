#!/usr/bin/env node
// 速くする前後で engine.js・ai/search.js・ai/bots.js の振る舞いが同じか確かめる。
//   node tools/equiv.mjs [基準にする git の版（既定: 高速化の直前の版 de8bda3]
// 基準の 3 ファイルを git から取り出して一時フォルダに置き、今のものと並べて動かす:
//  1) 種つきの乱数で、ランダムな手の対局 200 局。毎手、打てる手・盤・得点・ミープル・events・山札が一致する。
//  2) 対局の途中 30 局面で searchBot（iters 2。ucb も）に同じ種の乱数で打たせ、選んだ手が一致する。
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = process.argv[2] || 'de8bda3';
const dir = mkdtempSync(join(tmpdir(), 'carc-ref-'));
mkdirSync(join(dir, 'ai'));
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
for (const f of ['engine.js', 'ai/search.js', 'ai/bots.js']) {
  writeFileSync(join(dir, f), execSync(`git show ${REF}:${f}`, { cwd: root, maxBuffer: 1 << 26 }));
}
const load = async (base) => ({
  e: await import(pathToFileURL(join(base, 'engine.js'))),
  s: await import(pathToFileURL(join(base, 'ai/search.js'))),
});
const A = await load(dir), B = await load(root);

const mulberry = (a) => () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const sig = (g) => JSON.stringify([
  g.players, g.currentPlayer, [...g.board], [...g.frontierSet], [...g.cloisters],
  [...g.dsu.parent.keys()].map((k) => [k, g.dsu.find(k)]), [...g.dsu.meta].map(([k, m]) => [k, m.type, [...(m.tiles || [])], [...(m.openEnds || [])], m.pennants, m.done, m.awarded, m.meeples, [...(m.touches || [])]]),
  g.gameOver, g.finalRanking, g.deckPos, g.pendingTile, g.log,
]);

let moves = 0, preds = 0, mays = 0;
const positions = []; // [seed, 手数]: 探索を比べる局面
for (let seed = 1; seed <= 200; seed++) {
  const a = new A.e.Game(2 + (seed % 3), { seed }), b = new B.e.Game(2 + (seed % 3), { seed });
  const rng = mulberry(seed * 7919);
  assert.equal(sig(a), sig(b), `seed ${seed}: 初期状態が違う`);
  for (let n = 0; !a.gameOver; n++) {
    const ma = a.legalMoves(), mb = b.legalMoves();
    assert.deepEqual(mb, ma, `seed ${seed} 手 ${n}: legalMoves が違う`);
    if (!ma.length) break;
    if (seed <= 30 && n === 10 + seed) positions.push([seed, n]);
    // mayScoreIfPlayed が false の手は、本当に今の手番の得点を変えない（偽陰性がない）
    if (n % 2 === 0) for (let t = 0; t < 12; t++) {
      const m = mb[Math.floor(rng() * mb.length)], c = b.clone(), me = c.currentPlayer, before = c.players[me].score;
      const may = b.mayScoreIfPlayed(m);
      c.applyMove(m); preds++; if (may) mays++;
      assert.ok(may || c.players[me].score === before, `seed ${seed} 手 ${n}: 得点が入るのに mayScoreIfPlayed が false ${JSON.stringify(m)}`);
    }
    const i = Math.floor(rng() * ma.length);
    assert.deepEqual(b.applyMove(mb[i]), a.applyMove(ma[i]), `seed ${seed} 手 ${n}: events が違う`);
    assert.equal(sig(a), sig(b), `seed ${seed} 手 ${n}: 状態が違う`);
    moves++;
  }
  assert.equal(sig(a.clone()), sig(b.clone()), `seed ${seed}: clone が違う`);
}
console.log(`ランダム対局 200 局（${moves} 手）: 毎手一致。mayScoreIfPlayed ${preds} 手を確認（true は ${(100 * mays / preds).toFixed(0)}%）`);

for (const [seed, n] of positions) {
  const a = new A.e.Game(2 + (seed % 3), { seed }), b = new B.e.Game(2 + (seed % 3), { seed });
  const rng = mulberry(seed * 7919);
  for (let i = 0; i < n; i++) { const ma = a.legalMoves(), j = Math.floor(rng() * ma.length); a.applyMove(ma[j]); b.applyMove(b.legalMoves()[j]); }
  for (const opts of [{ iters: 2 }, { iters: 2, rootPolicy: 'ucb', topK: 4 }]) {
    // greedyValues の同点割りは既定の Math.random を使うので、同じ種の乱数に差し替えて比べる
    const realRandom = Math.random;
    Math.random = mulberry(seed + 1); const ra = A.s.searchBot(a, opts, mulberry(seed));
    Math.random = mulberry(seed + 1); const rb = B.s.searchBot(b, opts, mulberry(seed));
    Math.random = realRandom;
    assert.deepEqual(rb, ra, `seed ${seed} 手 ${n}: searchBot ${JSON.stringify(opts)} の選んだ手が違う`);
  }
  assert.equal(sig(a), sig(b), `seed ${seed}: 探索のあと元の盤が変わった`);
}
console.log(`searchBot ${positions.length} 局面（iters 2 / ucb）: 選んだ手が一致`);
