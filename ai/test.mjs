#!/usr/bin/env node
// engine.js の動作を確かめる:  node ai/test.mjs
'use strict';
import assert from 'node:assert/strict';
import { Game, TILE_KINDS, distributeState, rebuildFromDistributed } from '../engine.js';
import { randomBot, greedyBot, greedyValues } from './bots.js';
import { mergeStats, searchBot } from './search.js';
import { features, FEATURE_DIM } from './features.js';
import { createNet, forward, netEvaluate, toJSON, fromJSON } from './net.js';

// 種を渡せば、何度作っても同じ山札になる
{
  const a = new Game(2, { seed: 42 });
  const b = new Game(2, { seed: 42 });
  assert.deepEqual(a.deckOrder, b.deckOrder, '同じ種なのに山札の並びが違う');
  const c = new Game(2, { seed: 43 });
  assert.notDeepEqual(a.deckOrder, c.deckOrder, '違う種なのに山札の並びが同じ（たまたまの一致でなければおかしい）');
}

// clone() したあとに進めても、元は変わらない
{
  const g = new Game(2, { seed: 1 });
  const snapshotBoardSize = g.board.size;
  const snapshotLog = g.log.length;
  const clone = g.clone();
  for (let i = 0; i < 10 && !clone.gameOver; i++) {
    const move = randomBot(clone);
    if (!move) break;
    clone.applyMove(move);
  }
  assert.equal(g.board.size, snapshotBoardSize, 'clone を進めたら元の盤面も変わった');
  assert.equal(g.log.length, snapshotLog, 'clone を進めたら元の手順も変わった');
  assert.ok(clone.board.size > snapshotBoardSize, 'clone 側が進んでいない');
}

// 得点チェック: 道を東西からふさいで完成させ、駒が返って点が入るか（main.js にあった自己チェックと同じ形）
{
  const g = new Game(2);
  const capIdx = TILE_KINDS.findIndex((k) => k.edges.join('') === 'FRRR');
  assert.ok(capIdx >= 0, 'FRRR タイルが見つからない');

  g.placeTileOnBoard(1, 0, 0, capIdx); // 東をふさぐ（まだ西が開いている）
  const roadOpt = g.meepleOptions(0, 0).find((o) => o.type === 'road');
  assert.ok(roadOpt, '道の駒置き場所が見つからない');
  g.placeMeeple(0, 0, roadOpt);
  assert.equal(g.players[0].meeples, 6, '駒を置いたのに減っていない');

  g.placeTileOnBoard(-1, 0, 0, capIdx); // 西もふさぐ → 道が完成するはず
  g.scoreAround(-1, 0);
  assert.equal(g.players[0].score, 3, '道の得点が違う');
  assert.equal(g.players[0].meeples, 7, '完成した道の駒が戻っていない');
}

// legalMoves() は今のタイルの置ける場所ぶんの手を返し、applyMove() は次の手番・山札まで進める
{
  const g = new Game(2, { seed: 7 });
  const moves = g.legalMoves();
  assert.ok(moves.length > 0, '最初の手が 1 つもない');
  for (const m of moves) assert.ok(g.isValidPlacement(TILE_KINDS[g.pendingTile.kindIndex], m.rot, m.x, m.y), '置けない手が混ざっている');
  const before = g.currentPlayer;
  g.applyMove(moves[0]);
  assert.equal(g.currentPlayer, (before + 1) % g.playerCount, '次の人に進んでいない');
  assert.equal(g.log.length, 1, '手が記録されていない');
}

// ランダム同士を最後まで打たせても、途中で例外を投げずに終わり、最終得点が並ぶ
{
  const g = new Game(2, { seed: 99 });
  let turns = 0;
  while (!g.gameOver && turns < 2000) {
    const move = randomBot(g);
    assert.ok(move, `${turns} 手目で置ける手が無い（本来は捨て札で回避されるはず）`);
    g.applyMove(move);
    turns++;
  }
  assert.ok(g.gameOver, '対局が終わらなかった');
  assert.equal(g.finalRanking.length, 2, '最終順位が人数ぶんない');
  assert.ok(g.players.every((p) => p.score >= 0), '負の得点がある');
}

// 貪欲 CPU も最後まで例外なく打てる
{
  const g = new Game(2, { seed: 3 });
  let turns = 0;
  while (!g.gameOver && turns < 2000) {
    const move = greedyBot(g);
    assert.ok(move, `${turns} 手目で置ける手が無い`);
    g.applyMove(move);
    turns++;
  }
  assert.ok(g.gameOver, '貪欲 CPU の対局が終わらなかった');
}

// 最後の採点の内訳(events): main.js が演出に使う events の合計が、実際に入った点とちょうど合うか
// （events は main.js が最後の採点を1件ずつ見せるための材料。得点そのものを変えていないことを確かめる）
for (const seed of [11, 22, 33, 44]) {
  const g = new Game(2, { seed });
  let turns = 0, totalBefore = 0;
  while (!g.gameOver && turns < 2000) {
    const move = greedyBot(g);
    assert.ok(move, `${turns} 手目で置ける手が無い`);
    totalBefore = g.players.reduce((s, p) => s + p.score, 0);
    g.applyMove(move);
    turns++;
  }
  assert.ok(g.gameOver, '対局が終わらなかった');
  const totalAfter = g.players.reduce((s, p) => s + p.score, 0);
  const gained = totalAfter - totalBefore;
  const fromEvents = g.events.reduce((s, e) => s + e.points * e.players.length, 0);
  assert.equal(fromEvents, gained, `seed=${seed}: 最後の採点の内訳(events)の合計が実際に入った点と合わない`);
  for (const e of g.events) {
    assert.ok(['city', 'road', 'cloister', 'field'].includes(e.type), `内訳の種類がおかしい: ${e.type}`);
    assert.ok(Array.isArray(e.tiles) && e.tiles.length > 0, '内訳にタイル位置がない');
    if (e.type === 'field') assert.ok(Array.isArray(e.cityTiles), '草原の内訳に数えた都市のタイルがない');
  }
}

// 通信対戦（準備段階）: 配る状態(distributeState) → JSON 往復 → 組み直し(rebuildFromDistributed) が、
// 毎手ホストの Game と同じ盤・得点・残り駒・手番・今のタイル・残り枚数になるか（最後まで、何局か）
function summarize(g) {
  return {
    board: [...g.board.entries()].sort(),
    scores: g.players.map((p) => p.score),
    meeples: g.players.map((p) => p.meeples),
    currentPlayer: g.currentPlayer,
    pendingKind: g.pendingTile ? g.pendingTile.kindIndex : null,
    deckLeft: g.deckOrder.length - g.deckPos + (g.pendingTile ? 1 : 0),
    gameOver: g.gameOver,
  };
}
for (const seed of [5, 6, 7]) {
  const g = new Game(2, { seed });
  let turns = 0;
  while (!g.gameOver && turns < 2000) {
    const move = greedyBot(g);
    assert.ok(move, `seed=${seed} ${turns}手目で置ける手が無い`);
    g.applyMove(move);
    turns++;
    const roundTripped = JSON.parse(JSON.stringify(distributeState(g)));
    const guest = rebuildFromDistributed(roundTripped);
    assert.deepEqual(summarize(guest), summarize(g), `seed=${seed} ${turns}手目でゲスト側の組み立て直しがホストと合わない`);
  }
  assert.ok(g.gameOver, `seed=${seed} 対局が終わらなかった`);
}

// 探索 CPU: 合法手だけを返し、決着まで打てる（短い持ち時間で 1 局。山札の順は見ない作りなので順を壊しても動く）
{
  const g = new Game(2, { seed: 9 });
  while (!g.gameOver) {
    const move = g.currentPlayer === 0 ? searchBot(g, { timeMs: 3, depth: 3, topK: 4 }) : greedyBot(g);
    const legal = g.legalMoves();
    assert.ok(legal.some((m) => m.x === move.x && m.y === move.y && m.rot === move.rot && m.meepleKey === move.meepleKey), '探索 CPU が合法でない手を返した');
    g.applyMove(move);
  }
  assert.ok(g.gameOver);
}

// 特徴: 長さが一定で有限、向きを入れ替えると点差の符号が逆になる。山札の並びを壊しても同じ値（順は見ない）
{
  const g = new Game(2, { seed: 5 });
  for (let i = 0; i < 20; i++) g.applyMove(greedyBot(g));
  const f0 = features(g, 0), f1 = features(g, 1);
  assert.equal(f0.length, FEATURE_DIM);
  assert.ok(f0.every(Number.isFinite), '特徴に有限でない値がある');
  assert.ok(Math.abs(f0[0] + f1[0]) < 1e-6, '向きを入れ替えても点差の符号が逆にならない');
  const h = g.clone();
  h.deckOrder = h.deckOrder.slice(0, h.deckPos).concat(h.deckOrder.slice(h.deckPos).reverse());
  assert.deepEqual(features(h, 0), f0, '山札の順で特徴が変わった');
}

// 網: JSON 往復で同じ出力。学習した網を入れた探索 CPU も合法手だけで決着まで打てる
{
  let s = 1;
  const net = createNet(() => ((s = (s * 16807) % 2147483647) / 2147483647));
  const x = features(new Game(2, { seed: 2 }), 0);
  assert.ok(Number.isFinite(forward(net, x)));
  assert.ok(Math.abs(forward(net, x) - forward(fromJSON(JSON.parse(JSON.stringify(toJSON(net)))), x)) < 1e-4, 'JSON 往復で出力が変わった');
  const evaluate = netEvaluate(net);
  const g = new Game(2, { seed: 4 });
  while (!g.gameOver) {
    const move = g.currentPlayer === 0 ? searchBot(g, { timeMs: 3, depth: 3, topK: 4, evaluate }) : greedyBot(g);
    assert.ok(g.legalMoves().some((m) => m.x === move.x && m.y === move.y && m.rot === move.rot && m.meepleKey === move.meepleKey), '学習 CPU が合法でない手を返した');
    g.applyMove(move);
  }
}

// 既定のオプションの探索は、読み回数（iters）が同じなら、種が同じで同じ手を返す（変種のオプションを足しても既定の動きは変わらない）
{
  const g = new Game(2, { seed: 11 });
  for (let i = 0; i < 6; i++) g.applyMove(greedyBot(g, () => 0.5));
  const run = (o) => { let r = 1; const rng = () => (r = (r * 16807) % 2147483647) / 2147483647; return JSON.stringify(searchBot(g, { iters: 3, prior: (gg, mv) => greedyValues(gg, mv, () => 0.5), ...o }, rng)); };
  assert.equal(run({}), run({}), '同じ種・同じ状態なのに探索の手が違う');
  assert.equal(run({}), run({ candidates: 'top', rootPolicy: 'flat', evalMode: 'now', depth: 14 }), '既定の明示指定で動きが変わった');
}

// stats を返す探索を 3 本ぶん合わせても、合法手が 1 つ返る
{
  const g = new Game(2, { seed: 12 });
  for (let i = 0; i < 6; i++) g.applyMove(greedyBot(g, () => 0.5));
  const o = { candidates: 'diverse', rootPolicy: 'halving', depth: 8, iters: 3, stats: true };
  const m = mergeStats([1, 2, 3].map(() => searchBot(g, o)));
  assert.ok(g.legalMoves().some((x) => x.x === m.x && x.y === m.y && x.rot === m.rot && x.meepleKey === m.meepleKey), 'mergeStats が合法でない手を返した');
}

console.log('ok: すべて通った');
