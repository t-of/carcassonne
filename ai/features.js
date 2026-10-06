'use strict';
// 局面 → 数値のベクトル（手番ではなく me から見た向き）。学習した網の入力。
// 山札の順は見ない（残りタイルは種類ごとの枚数だけ）。2 人用に作ってあり、3 人以上なら「相手」は全員まとめる。
import { TILE_KINDS } from '../engine.js';

const NK = TILE_KINDS.length;
// 並び: 点・駒など 8 ＋ 区画（都市・道 × 自分/相手/だれも × 3 値）18 ＋ 草原（自分/相手 × 3）6 ＋ 修道院（自分/相手 × 2）4 ＋ 残りタイル NK
export const FEATURE_DIM = 8 + 18 + 6 + 4 + NK;

// 点差のあとの値の大きさをそろえる（だいたい -1〜1 に収まる）ための割り算
export function features(game, me, out = new Float32Array(FEATURE_DIM)) {
  out.fill(0);
  const ps = game.players;
  let oppScore = -Infinity, oppMeeples = 0;
  ps.forEach((p, i) => { if (i === me) return; if (p.score > oppScore) oppScore = p.score; oppMeeples += p.meeples; });
  const left = game.deckOrder.length - game.deckPos;
  out[0] = (ps[me].score - oppScore) / 30;
  out[1] = ps[me].score / 60;
  out[2] = oppScore / 60;
  out[3] = ps[me].meeples / 7;
  out[4] = oppMeeples / 7 / (ps.length - 1);
  out[5] = left / 72;
  out[6] = game.frontierSet.size / 40;
  out[7] = game.currentPlayer === me ? 1 : 0;

  const dsu = game.dsu;
  // 区画ごとに持ち主を決める（多い方。同数なら両方）。未完成で未採点のものだけ
  for (const m of dsu.meta.values()) {
    if (m.type === 'field') continue;
    if (m.awarded || m.done) continue;
    let mine = 0, opp = 0;
    for (const k of m.meeples) { if (k.player === me) mine++; else opp++; }
    const pot = m.type === 'city' ? (m.tiles.size + m.pennants) / 10 : m.tiles.size / 6; // 終了時の点（未完成なので半分）
    const open = m.openEnds.size / 4;
    const base = 8 + (m.type === 'city' ? 0 : 9);
    if (mine >= opp && mine > 0) { out[base] += 1 / 3; out[base + 1] += pot; out[base + 2] += open; }
    if (opp >= mine && opp > 0) { out[base + 3] += 1 / 3; out[base + 4] += pot; out[base + 5] += open; }
    if (mine + opp === 0) { out[base + 6] += 1 / 3; out[base + 7] += pot; out[base + 8] += open; }
  }
  // 草原: 駒のある草原が接する都市の数（完成済みは確実な 3 点、未完成は見込み）
  for (const m of dsu.meta.values()) {
    if (m.type !== 'field' || m.meeples.length === 0) continue;
    let mine = 0, opp = 0;
    for (const k of m.meeples) { if (k.player === me) mine++; else opp++; }
    let done = 0, open = 0;
    const seen = new Set();
    for (const ck of m.touches) {
      const r = dsu.find(ck);
      if (seen.has(r)) continue;
      seen.add(r);
      if (dsu.meta.get(r).done) done++; else open++;
    }
    if (mine >= opp && mine > 0) { out[26] += 1 / 3; out[27] += done / 3; out[28] += open / 3; }
    if (opp >= mine && opp > 0) { out[29] += 1 / 3; out[30] += done / 3; out[31] += open / 3; }
  }
  // 修道院: 駒つきの未採点のもの（まわりが埋まった数が見込み点）
  for (const [key, c] of game.cloisters) {
    if (c.awarded || !c.meeple) continue;
    const [x, y] = key.split(',').map(Number);
    let n = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if ((dx || dy) && game.board.has(`${x + dx},${y + dy}`)) n++;
    const o = c.meeple.player === me ? 32 : 34;
    out[o] += 1 / 2; out[o + 1] += n / 8;
  }
  for (let i = game.deckPos; i < game.deckOrder.length; i++) out[36 + game.deckOrder[i]] += 1;
  for (let k = 0; k < NK; k++) out[36 + k] /= TILE_KINDS[k].count;
  return out;
}
