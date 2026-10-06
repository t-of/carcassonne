'use strict';
// 小さな網（全結合・ReLU）。入力は features.js のベクトル、出力は「いまの点差から最後までに動く点差」を 30 で割った 1 つの数。
// 重みは JSON { sizes, w: [層ごとの配列（[入力×出力] の行ごと）], b: [...] }。Node でもブラウザでも import できる（依存なし）。
import { features, FEATURE_DIM } from './features.js';

export const SCALE = 30;
export const HIDDEN = [64, 32];

// 初期値は He 初期化、最後の層だけ小さく（最初は「点差が今のまま動かない」と読む）
export function createNet(rng = Math.random, hidden = HIDDEN) {
  const sizes = [FEATURE_DIM, ...hidden, 1];
  const w = [], b = [];
  for (let l = 0; l + 1 < sizes.length; l++) {
    const [n, m] = [sizes[l], sizes[l + 1]];
    const s = Math.sqrt(2 / n) * (l + 2 === sizes.length ? 0.1 : 1);
    const a = new Float32Array(n * m);
    for (let i = 0; i < a.length; i++) a[i] = (rng() + rng() + rng() - 1.5) * 2 * s;
    w.push(a); b.push(new Float32Array(m));
  }
  return { sizes, w, b };
}

// 入力 x → 出力（各層の値 acts も要るときは acts を渡す。学習用）
export function forward(net, x, acts) {
  let h = x;
  const L = net.sizes.length - 1;
  for (let l = 0; l < L; l++) {
    const n = net.sizes[l], m = net.sizes[l + 1], w = net.w[l];
    const o = Float32Array.from(net.b[l]);
    for (let i = 0; i < n; i++) {
      const v = h[i];
      if (!v) continue;
      const off = i * m;
      for (let j = 0; j < m; j++) o[j] += w[off + j] * v;
    }
    if (l + 1 < L) for (let j = 0; j < m; j++) if (o[j] < 0) o[j] = 0;
    if (acts) acts[l] = o;
    h = o;
  }
  return h[0];
}

export function toJSON(net) {
  return { sizes: net.sizes, w: net.w.map((a) => Array.from(a, (v) => +v.toPrecision(6))), b: net.b.map((a) => Array.from(a, (v) => +v.toPrecision(6))) };
}
export function fromJSON(j) {
  return { sizes: j.sizes, w: j.w.map((a) => Float32Array.from(a)), b: j.b.map((a) => Float32Array.from(a)) };
}
export const cloneNet = (net) => fromJSON(toJSON(net));

// searchBot の evaluate に差し込む。me から見た「今の点差 ＋ 網が読む先の動き」。
export function netEvaluate(net) {
  const buf = new Float32Array(FEATURE_DIM);
  return (game, me) => {
    features(game, me, buf);
    return buf[0] * 30 + forward(net, buf) * SCALE;
  };
}
