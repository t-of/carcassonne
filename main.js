'use strict';

// localStorage はほかのアプリと共有される（同じ t-of.github.io のため）。
// キーは必ず 'carcassonne.' で始める。
const STORE = 'carcassonne.';

function load(key, fallback) {
  try {
    const v = localStorage.getItem(STORE + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* 保存できなくても遊べる */ }
}

WebAppKit.init({ title: 'carcassonne', text: 'カルカソンヌ基本セットを1台で交代して遊ぶ試作' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// 音を使うときは、鳴らす前と音の設定を切り替えたときにこれを呼ぶ（RULES.md §5「音」）。
function setAudioSession(soundOn) {
  try { if (navigator.audioSession) navigator.audioSession.type = soundOn ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}

// ---- 音（Web Audio で短いビープだけ。マナーモードでも鳴る） ----
let audioCtx = null;
let replaying = false; // 保存データの再生中は鳴らさない
function beep(freq, dur) {
  if (replaying) return;
  try {
    if (!audioCtx) { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); setAudioSession(true); }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  } catch { /* 音が出せなくても遊べる */ }
}
const soundPlace = () => beep(320, 0.12);
const soundMeeple = () => beep(520, 0.1);
const soundScore = () => beep(700, 0.2);

// ================================================================
// タイルの定義（RULES.md 相当。現行版のカルカソンヌ基本セット 72 枚）
// edges は [N, E, S, W]。'C' = 都市、'R' = 道、'F' = 草原
// ================================================================
const DIRS = ['N', 'E', 'S', 'W'];
const DI = { N: 0, E: 1, S: 2, W: 3 };
const OPP = [2, 3, 0, 1];
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

const RAW_KINDS = [
  { n: 4, edges: 'FFFF', cloister: true },
  { n: 2, edges: 'FFRF', cloister: true },
  { n: 1, edges: 'CCCC', cities: [{ e: 'NESW', shield: true }] },
  { n: 4, edges: 'CRFR', cities: [{ e: 'N' }], roads: [['E', 'W']], start: true },
  { n: 5, edges: 'CFFF', cities: [{ e: 'N' }] },
  { n: 2, edges: 'FCFC', cities: [{ e: 'EW', shield: true }] },
  { n: 1, edges: 'FCFC', cities: [{ e: 'EW' }] },
  { n: 3, edges: 'CFCF', cities: [{ e: 'N' }, { e: 'S' }] },
  { n: 2, edges: 'CCFF', cities: [{ e: 'N' }, { e: 'E' }] },
  { n: 3, edges: 'CRRF', cities: [{ e: 'N' }], roads: [['E', 'S']] },
  { n: 3, edges: 'CFRR', cities: [{ e: 'N' }], roads: [['W', 'S']] },
  { n: 3, edges: 'CRRR', cities: [{ e: 'N' }] },
  { n: 2, edges: 'CCFF', cities: [{ e: 'NE', shield: true }] },
  { n: 3, edges: 'CCFF', cities: [{ e: 'NE' }] },
  { n: 2, edges: 'CCRR', cities: [{ e: 'NE', shield: true }], roads: [['S', 'W']] },
  { n: 3, edges: 'CCRR', cities: [{ e: 'NE' }], roads: [['S', 'W']] },
  { n: 1, edges: 'CCCF', cities: [{ e: 'NES', shield: true }] },
  { n: 3, edges: 'CCCF', cities: [{ e: 'NES' }] },
  { n: 2, edges: 'CCCR', cities: [{ e: 'NES', shield: true }] },
  { n: 1, edges: 'CCCR', cities: [{ e: 'NES' }] },
  { n: 8, edges: 'FRFR', roads: [['E', 'W']] },
  { n: 9, edges: 'FFRR', roads: [['S', 'W']] },
  { n: 4, edges: 'FRRR' },
  { n: 1, edges: 'RRRR' },
];

function buildKinds() {
  const kinds = [];
  for (const raw of RAW_KINDS) {
    const edges = raw.edges.split('');
    const cityGroupOfEdge = [-1, -1, -1, -1];
    const roadGroupOfEdge = [-1, -1, -1, -1];
    const cityGroups = (raw.cities || []).map((c, gi) => {
      const idxs = c.e.split('').map((ch) => DI[ch]);
      idxs.forEach((i) => { cityGroupOfEdge[i] = gi; });
      return { edges: idxs, pennant: !!c.shield };
    });
    const roadPairs = raw.roads || [];
    const roadGroups = roadPairs.map((pair, gi) => {
      const idxs = pair.map((ch) => DI[ch]);
      idxs.forEach((i) => { roadGroupOfEdge[i] = gi; });
      return { edges: idxs };
    });
    // 対にならない道・都市（単独の辺）は自分だけの組にする
    edges.forEach((type, i) => {
      if (type === 'C' && cityGroupOfEdge[i] === -1) {
        cityGroupOfEdge[i] = cityGroups.length;
        cityGroups.push({ edges: [i], pennant: false });
      }
      if (type === 'R' && roadGroupOfEdge[i] === -1) {
        roadGroupOfEdge[i] = roadGroups.length;
        roadGroups.push({ edges: [i] });
      }
    });
    kinds.push({
      edges, cloister: !!raw.cloister, start: !!raw.start,
      cityGroups, roadGroups, cityGroupOfEdge, roadGroupOfEdge, count: raw.n,
    });
  }
  return kinds;
}
const TILE_KINDS = buildKinds();

// 自己チェック（このロジックが壊れたら分かるように）
function selfCheckTileCounts() {
  const total = TILE_KINDS.reduce((s, k) => s + k.count, 0);
  console.assert(total === 72, `タイル合計が 72 でない: ${total}`);
  const starts = TILE_KINDS.filter((k) => k.start);
  console.assert(starts.length === 1, '開始タイルが 1 種類でない');
}
selfCheckTileCounts();

function absoluteEdges(kind, rot) {
  return [0, 1, 2, 3].map((d) => kind.edges[(d - rot + 4) % 4]);
}
function groupAt(kind, rot, table, d) {
  return table[(d - rot + 4) % 4];
}

// タイル内の 8 分割点（0=N左,1=N右,2=E上,3=E下,4=S右,5=S左,6=W下,7=W上）の座標（0..1）
const POINT_COORD = [
  [0.25, 0], [0.75, 0], [1, 0.25], [1, 0.75],
  [0.75, 1], [0.25, 1], [0, 0.75], [0, 0.25],
];
const EDGE_MID = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
const EDGE_CORNERS = [[[0, 0], [1, 0]], [[1, 0], [1, 1]], [[1, 1], [0, 1]], [[0, 1], [0, 0]]];

// 1 タイル分の見取り図を作る（都市・道・草原区画・修道院・つながりを計算）
function analyzeTile(kind, rot) {
  const absEdges = absoluteEdges(kind, rot);
  const cityGroupAt = [0, 1, 2, 3].map((d) => groupAt(kind, rot, kind.cityGroupOfEdge, d));
  const roadGroupAt = [0, 1, 2, 3].map((d) => groupAt(kind, rot, kind.roadGroupOfEdge, d));

  const parent = [0, 1, 2, 3, 4, 5, 6, 7];
  const find = (a) => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const exists = (p) => absEdges[Math.floor(p / 2)] !== 'C';

  // 外周を時計回りに 16 等分した位置: 点 p は 2p+1、辺 d の中点は 4d+2
  const mid = (d) => 4 * d + 2;
  const chords = [];
  const pairs = (ds) => { for (let i = 0; i < ds.length; i++) for (let j = i + 1; j < ds.length; j++) chords.push([mid(ds[i]), mid(ds[j])]); };
  const roadEdges = (g) => g.edges.map((li) => (li + rot) % 4);
  const singles = [];
  for (const g of kind.roadGroups) {
    if (g.edges.length === 2) pairs(roadEdges(g)); else singles.push(roadEdges(g)[0]);
  }
  for (const g of kind.cityGroups) if (g.edges.length >= 2) pairs(roadEdges(g));
  if (singles.length >= 2) pairs(singles); // 交差点: 中央で道どうしがつながる
  else if (singles.length === 1 && !kind.cloister && kind.cityGroups.length) {
    chords.push([mid(singles[0]), mid(roadEdges(kind.cityGroups[0])[0])]); // 道が都市に入って止まる
  }
  // 修道院で止まる道は草原を分けない
  const splits = (p, q) => chords.some(([a, b]) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const inP = 2 * p + 1 > lo && 2 * p + 1 < hi, inQ = 2 * q + 1 > lo && 2 * q + 1 < hi;
    return inP !== inQ;
  });
  for (let p = 0; p < 8; p++) for (let q = p + 1; q < 8; q++) {
    if (exists(p) && exists(q) && !splits(p, q)) uni(p, q);
  }
  const corners = [[1, 2], [3, 4], [5, 6], [7, 0]];
  const touchEvents = []; // { point, cityGroupIdx }
  for (const [p, q] of corners) {
    const ep = exists(p), eq = exists(q);
    if (ep && !eq) touchEvents.push([p, cityGroupAt[Math.floor(q / 2)]]);
    else if (eq && !ep) touchEvents.push([q, cityGroupAt[Math.floor(p / 2)]]);
  }
  const rootToRegion = new Map();
  const regions = [];
  for (let p = 0; p < 8; p++) {
    if (!exists(p)) continue;
    const r = find(p);
    if (!rootToRegion.has(r)) { rootToRegion.set(r, regions.length); regions.push({ points: [], touches: new Set() }); }
    regions[rootToRegion.get(r)].points.push(p);
  }
  for (const [p, cg] of touchEvents) {
    const region = regions[rootToRegion.get(find(p))];
    if (region) region.touches.add(cg);
  }
  return { absEdges, cityGroupAt, roadGroupAt, regions };
}

// ================================================================
// 汎用 Union-Find（道・都市・草原のつながりを持つ）
// ================================================================
class DSU {
  constructor() { this.parent = new Map(); this.meta = new Map(); }
  ensure(key, makeMeta) {
    if (!this.parent.has(key)) { this.parent.set(key, key); this.meta.set(key, makeMeta()); }
    return key;
  }
  find(key) {
    let r = key;
    while (this.parent.get(r) !== r) r = this.parent.get(r);
    let k = key;
    while (this.parent.get(k) !== r) { const next = this.parent.get(k); this.parent.set(k, r); k = next; }
    return r;
  }
  meta_(key) { return this.meta.get(this.find(key)); }
  union(a, b, merge) {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return ra;
    const merged = merge(this.meta.get(ra), this.meta.get(rb));
    this.parent.set(ra, rb);
    this.meta.set(rb, merged);
    this.meta.delete(ra);
    return rb;
  }
}

function tileKey(x, y) { return `${x},${y}`; }
function cityKey(x, y, gi) { return `${x},${y}C${gi}`; }
function roadKey(x, y, gi) { return `${x},${y}R${gi}`; }
function fieldKey(x, y, ri) { return `${x},${y}F${ri}`; }
function endKey(x, y, d) { return `${x},${y}:${DIRS[d]}`; }

// ================================================================
// ゲーム本体
// ================================================================
const PLAYER_COLORS = ['#e0524f', '#4f8ef7', '#3fbf6f', '#f2b632', '#a985e8'];

class Game {
  constructor(playerCount) {
    this.playerCount = playerCount;
    this.players = Array.from({ length: playerCount }, (_, i) => ({ color: PLAYER_COLORS[i], score: 0, meeples: 7 }));
    this.currentPlayer = 0;
    this.board = new Map();       // tileKey -> { kindIndex, rot }
    this.cloisters = new Map();   // tileKey -> { meeple: {player}|null, awarded: bool }
    this.dsu = new DSU();
    this.allNodeKeys = new Set(); // 完了チェック・最終採点に使う全体の一覧
    this.gameOver = false;
    this.finalRanking = null;

    // 開始タイル
    const startIdx = TILE_KINDS.findIndex((k) => k.start);
    const pool = [];
    TILE_KINDS.forEach((k, ki) => { for (let i = 0; i < k.count; i++) pool.push(ki); });
    const firstPos = pool.indexOf(startIdx);
    pool.splice(firstPos, 1);
    this.deckOrder = shuffle(pool);
    this.deckPos = 0;

    this.log = []; // { kindIndex, x, y, rot, meepleOptionIdx|null } の並び（保存・再生用）
    this.pendingTile = null;      // { kindIndex, rot }
    this.pendingOptions = null;   // 置いた直後の駒の選択肢
    this.message = '';

    this.placeTileOnBoard(0, 0, 0, startIdx, { silent: true });
    this.drawNext();
  }

  // ---- 山札 ----
  drawNext() {
    while (this.deckPos < this.deckOrder.length) {
      const kindIndex = this.deckOrder[this.deckPos];
      const options = this.frontierOptions(kindIndex);
      if (options.some((o) => o.rotations.length)) {
        this.deckPos++;
        this.pendingTile = { kindIndex, rot: options.find((o) => o.rotations.length).rotations[0] };
        this.message = '光っているマスをタップ（もう一度タップで回る）→「ここに置く」';
        return;
      }
      // どこにも置けない → 捨てて引き直し
      this.deckPos++;
    }
    this.pendingTile = null;
    this.finishGame();
  }

  frontier() {
    const cells = new Set();
    for (const key of this.board.keys()) {
      const [x, y] = key.split(',').map(Number);
      for (let d = 0; d < 4; d++) {
        const nk = tileKey(x + DX[d], y + DY[d]);
        if (!this.board.has(nk)) cells.add(nk);
      }
    }
    return [...cells].map((k) => k.split(',').map(Number));
  }

  frontierOptions(kindIndex) {
    const kind = TILE_KINDS[kindIndex];
    return this.frontier().map(([x, y]) => {
      const rotations = [0, 1, 2, 3].filter((r) => this.isValidPlacement(kind, r, x, y));
      return { x, y, rotations };
    });
  }

  isValidPlacement(kind, rot, x, y) {
    if (this.board.has(tileKey(x, y))) return false;
    const abs = absoluteEdges(kind, rot);
    let touched = false;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      const nb = this.board.get(tileKey(nx, ny));
      if (!nb) continue;
      touched = true;
      const nbKind = TILE_KINDS[nb.kindIndex];
      const nbAbs = absoluteEdges(nbKind, nb.rot);
      if (nbAbs[OPP[d]] !== abs[d]) return false;
    }
    return touched;
  }

  currentValidCells(rot) {
    if (!this.pendingTile) return [];
    const kind = TILE_KINDS[this.pendingTile.kindIndex];
    return this.frontier().filter(([x, y]) => this.isValidPlacement(kind, rot, x, y));
  }

  // ---- タイルを置く ----
  placeTileOnBoard(x, y, rot, kindIndex, opts = {}) {
    const kind = TILE_KINDS[kindIndex];
    const key = tileKey(x, y);
    this.board.set(key, { kindIndex, rot });
    const info = analyzeTile(kind, rot);
    const dsu = this.dsu;

    // このタイル自身の道・都市の節を作る
    kind.cityGroups.forEach((g, gi) => {
      const ck = cityKey(x, y, gi);
      dsu.ensure(ck, () => ({ type: 'city', tiles: new Set([key]), openEnds: new Set(), pennants: g.pennant ? 1 : 0, meeples: [], done: false, awarded: false }));
      this.allNodeKeys.add(ck);
      const absEdges = g.edges.map((localIdx) => (localIdx + rot) % 4);
      for (const d of absEdges) dsu.meta_(ck).openEnds.add(endKey(x, y, d));
    });
    kind.roadGroups.forEach((g, gi) => {
      const rk = roadKey(x, y, gi);
      dsu.ensure(rk, () => ({ type: 'road', tiles: new Set([key]), openEnds: new Set(), meeples: [], done: false, awarded: false }));
      this.allNodeKeys.add(rk);
      const absEdges = g.edges.map((localIdx) => (localIdx + rot) % 4);
      for (const d of absEdges) dsu.meta_(rk).openEnds.add(endKey(x, y, d));
    });
    info.regions.forEach((region, ri) => {
      const fk = fieldKey(x, y, ri);
      dsu.ensure(fk, () => ({ type: 'field', tiles: new Set([key]), meeples: [], touches: new Set() }));
      this.allNodeKeys.add(fk);
      const meta = dsu.meta_(fk);
      for (const cg of region.touches) meta.touches.add(cityKey(x, y, cg));
    });
    if (kind.cloister) this.cloisters.set(key, { meeple: null, awarded: false });

    // 近くのタイルとつなげる
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      const nkey = tileKey(nx, ny);
      const nb = this.board.get(nkey);
      if (!nb) continue;
      const nbKind = TILE_KINDS[nb.kindIndex];
      const type = info.absEdges[d];
      if (type === 'C') {
        const myGi = info.cityGroupAt[d];
        const nbGi = groupAt(nbKind, nb.rot, nbKind.cityGroupOfEdge, OPP[d]);
        this.mergeFeature(cityKey(x, y, myGi), cityKey(nx, ny, nbGi), endKey(x, y, d), endKey(nx, ny, OPP[d]));
      } else if (type === 'R') {
        const myGi = info.roadGroupAt[d];
        const nbGi = groupAt(nbKind, nb.rot, nbKind.roadGroupOfEdge, OPP[d]);
        this.mergeFeature(roadKey(x, y, myGi), roadKey(nx, ny, nbGi), endKey(x, y, d), endKey(nx, ny, OPP[d]));
      }
      // 草原のつながり（辺の左右 2 点ずつ）
      for (const ab of [0, 1]) {
        const myPoint = 2 * d + ab;
        const nbPoint = 2 * OPP[d] + (1 - ab);
        const myRegion = this.regionIndexOfPoint(info, myPoint);
        if (myRegion == null) continue;
        const nbInfo = analyzeTile(nbKind, nb.rot);
        const nbRegion = this.regionIndexOfPoint(nbInfo, nbPoint);
        if (nbRegion == null) continue;
        this.mergeField(fieldKey(x, y, myRegion), fieldKey(nx, ny, nbRegion));
      }
    }

    if (!opts.silent) {
      // 完成した道・都市があれば採点
      kind.cityGroups.forEach((g, gi) => this.checkFeatureComplete(cityKey(x, y, gi)));
      kind.roadGroups.forEach((g, gi) => this.checkFeatureComplete(roadKey(x, y, gi)));
      // このタイル自身、および周りの修道院の完成をチェック
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) this.checkCloisterComplete(x + dx, y + dy);
    }
  }

  regionIndexOfPoint(info, point) {
    for (let i = 0; i < info.regions.length; i++) if (info.regions[i].points.includes(point)) return i;
    return null;
  }

  mergeFeature(keyA, keyB, endA, endB) {
    // すでに同じ地形（道が輪になる・都市が閉じる）なら、つないだ辺を開いた端から外すだけ
    if (this.dsu.find(keyA) === this.dsu.find(keyB)) {
      const m = this.dsu.meta_(keyA);
      m.openEnds.delete(endA); m.openEnds.delete(endB);
      return;
    }
    this.dsu.union(keyA, keyB, (a, b) => {
      a.openEnds.delete(endA); b.openEnds.delete(endB);
      return {
        type: a.type,
        tiles: new Set([...a.tiles, ...b.tiles]),
        openEnds: new Set([...a.openEnds, ...b.openEnds]),
        pennants: (a.pennants || 0) + (b.pennants || 0),
        meeples: [...a.meeples, ...b.meeples],
        done: false, awarded: a.awarded || b.awarded,
      };
    });
  }

  mergeField(keyA, keyB) {
    this.dsu.union(keyA, keyB, (a, b) => ({
      type: 'field',
      tiles: new Set([...a.tiles, ...b.tiles]),
      meeples: [...a.meeples, ...b.meeples],
      touches: new Set([...a.touches, ...b.touches]),
    }));
  }

  checkFeatureComplete(key) {
    const root = this.dsu.find(key);
    const meta = this.dsu.meta.get(root);
    if (!meta || meta.done) return;
    if (meta.openEnds.size === 0) {
      meta.done = true;
      this.awardIfNeeded(root);
    }
  }

  checkCloisterComplete(x, y) {
    const key = tileKey(x, y);
    const c = this.cloisters.get(key);
    if (!c || c.awarded) return;
    let full = true;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      if (!this.board.has(tileKey(x + dx, y + dy))) full = false;
    }
    if (full && c.meeple) {
      c.awarded = true;
      this.players[c.meeple.player].score += 9;
      this.players[c.meeple.player].meeples++;
      c.meeple = null;
      soundScore();
    } else if (full) {
      c.awarded = true; // 駒がいなくても、完成済みとして扱う（最後の採点で二重にしない）
    }
  }

  awardIfNeeded(root) {
    const meta = this.dsu.meta.get(root);
    if (!meta || meta.awarded || meta.meeples.length === 0) { if (meta) meta.awarded = true; return; }
    const per = meta.type === 'city' ? (meta.tiles.size * 2 + meta.pennants * 2) : meta.tiles.size;
    this.awardToMajority(meta, per);
    meta.awarded = true;
  }

  awardToMajority(meta, points) {
    const counts = new Map();
    for (const m of meta.meeples) counts.set(m.player, (counts.get(m.player) || 0) + 1);
    const max = Math.max(...counts.values());
    for (const [player, c] of counts) if (c === max) this.players[player].score += points;
    // 駒は持ち主に返す
    for (const m of meta.meeples) this.players[m.player].meeples++;
    meta.meeples = [];
    soundScore();
  }

  // ---- 駒 ----
  meepleOptions(x, y) {
    const nb = this.board.get(tileKey(x, y));
    const kind = TILE_KINDS[nb.kindIndex];
    const at = featureAnchors(nb.kindIndex, nb.rot);
    const options = [];
    const free = (key) => this.dsu.meta_(key).meeples.length === 0;
    kind.cityGroups.forEach((g, gi) => { const key = cityKey(x, y, gi); if (free(key)) options.push({ key, type: 'city', anchor: at.city[gi] }); });
    kind.roadGroups.forEach((g, gi) => { const key = roadKey(x, y, gi); if (free(key)) options.push({ key, type: 'road', anchor: at.road[gi] }); });
    if (kind.cloister) {
      const c = this.cloisters.get(tileKey(x, y));
      if (c && !c.meeple) options.push({ key: 'M', type: 'cloister', anchor: [0.5, 0.5] });
    }
    at.field.forEach((anchor, ri) => { const key = fieldKey(x, y, ri); if (free(key)) options.push({ key, type: 'field', anchor }); });
    return options;
  }

  placeMeeple(x, y, option) {
    const player = this.currentPlayer;
    if (this.players[player].meeples <= 0) return false;
    if (option.type === 'cloister') {
      this.cloisters.get(tileKey(x, y)).meeple = { player, x, y, anchor: option.anchor };
    } else {
      const meta = this.dsu.meta_(option.key);
      meta.meeples.push({ player, x, y, anchor: option.anchor });
    }
    this.players[player].meeples--;
    soundMeeple();
    return true;
  }

  // ---- 最終採点 ----
  finishGame() {
    this.gameOver = true;
    for (const key of this.allNodeKeys) {
      const root = this.dsu.find(key);
      const meta = this.dsu.meta.get(root);
      if (!meta || meta.awarded) continue;
      if (meta.type === 'city') { this.awardToMajority(meta, meta.tiles.size + meta.pennants); meta.awarded = true; }
      else if (meta.type === 'road') { this.awardToMajority(meta, meta.tiles.size); meta.awarded = true; }
    }
    for (const [key, c] of this.cloisters) {
      if (c.awarded) continue;
      c.awarded = true;
      if (!c.meeple) continue;
      const [x, y] = key.split(',').map(Number);
      let n = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { if (dx === 0 && dy === 0) continue; if (this.board.has(tileKey(x + dx, y + dy))) n++; }
      this.players[c.meeple.player].score += 1 + n;
    }
    // 草原：接する「完成した都市」1 つにつき 3 点
    const seenFieldRoots = new Set();
    for (const key of this.allNodeKeys) {
      const meta0 = this.dsu.meta.get(this.dsu.find(key));
      if (!meta0 || meta0.type !== 'field') continue;
      const root = this.dsu.find(key);
      if (seenFieldRoots.has(root)) continue;
      seenFieldRoots.add(root);
      if (meta0.meeples.length === 0) continue;
      const completedCities = new Set();
      for (const ck of meta0.touches) {
        const croot = this.dsu.find(ck);
        const cmeta = this.dsu.meta.get(croot);
        if (cmeta && cmeta.done) completedCities.add(croot);
      }
      this.awardToMajority(meta0, completedCities.size * 3);
    }
    this.finalRanking = this.players.map((p, i) => ({ i, color: p.color, score: p.score }))
      .sort((a, b) => b.score - a.score);
  }
}

// ---- 駒を置く位置 ----
// 道はその線の中点。都市・草原は、その区画の中で縁（ほかの区画・道・修道院・タイルの端）から一番遠い点。
// タイルを細かい升目に分けて求める。種類と向きごとに 1 回だけ計算する。
const ANCHOR_CACHE = new Map();
function featureAnchors(kindIndex, rot) {
  const ck = kindIndex * 4 + rot;
  if (ANCHOR_CACHE.has(ck)) return ANCHOR_CACHE.get(ck);
  const kind = TILE_KINDS[kindIndex];
  const info = analyzeTile(kind, rot);
  const N = 49; // 奇数にして中心の升目が真ん中に来るように
  const segs = kind.roadGroups.map((g) => {
    const abs = g.edges.map((li) => (li + rot) % 4);
    return abs.length === 2 ? [EDGE_MID[abs[0]], EDGE_MID[abs[1]]] : [[0.5, 0.5], EDGE_MID[abs[0]]];
  });
  const segDist = (x, y, [[ax, ay], [bx, by]]) => {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - ax - t * dx, y - ay - t * dy);
  };
  const side = (x, y, [ax, ay], [bx, by]) => (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  const CL = [[0.5, 0.28], [0.68, 0.62], [0.32, 0.62]]; // 修道院の三角形（描画と同じ）
  const inCloister = (x, y) => {
    const s1 = side(x, y, CL[0], CL[1]), s2 = side(x, y, CL[1], CL[2]), s3 = side(x, y, CL[2], CL[0]);
    return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  };
  // 升目ごとの区画: 'c<gi>'（都市）/ 'x'（道・修道院）/ 'f<ri>'（草原）
  const lab = new Array(N * N).fill(null);
  const cellXY = (i) => [((i % N) + 0.5) / N, (Math.floor(i / N) + 0.5) / N];
  for (let i = 0; i < N * N; i++) {
    const [x, y] = cellXY(i);
    // 都市は中心と辺の両端を結ぶ三角形（描画と同じ）。升目の四隅のどれかが都市なら都市にする
    // （三角形どうしが中心の 1 点で接するところを草原が通り抜けないように）
    const h = 0.5 / N;
    const d = [[x, y], [x - h, y - h], [x + h, y - h], [x - h, y + h], [x + h, y + h]]
      .map(([sx, sy]) => (sy <= sx && sy <= 1 - sx ? 0 : sx >= sy && sx >= 1 - sy ? 1 : sy >= sx && sy >= 1 - sx ? 2 : 3))
      .find((e) => info.absEdges[e] === 'C');
    if (d !== undefined) lab[i] = 'c' + info.cityGroupAt[d];
    else if (segs.some((sg) => segDist(x, y, sg) < 1.2 / N) || (kind.cloister && inCloister(x, y))) lab[i] = 'x';
  }
  // 草原: 空いた升目をつながりごとに分け、外周の 8 点からどの区画かを決める
  const comp = new Array(N * N).fill(-1);
  let nComp = 0;
  for (let i = 0; i < N * N; i++) {
    if (lab[i] !== null || comp[i] !== -1) continue;
    const stack = [i]; comp[i] = nComp;
    while (stack.length) {
      const c = stack.pop(), cx = c % N, cy = Math.floor(c / N);
      for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const n = ny * N + nx;
        if (lab[n] === null && comp[n] === -1) { comp[n] = nComp; stack.push(n); }
      }
    }
    nComp++;
  }
  const compRegion = new Array(nComp).fill(null);
  info.regions.forEach((region, ri) => {
    for (const p of region.points) {
      const [px, py] = POINT_COORD[p];
      const cx = Math.min(N - 1, Math.floor((px * 0.94 + 0.03) * N)), cy = Math.min(N - 1, Math.floor((py * 0.94 + 0.03) * N));
      const c = comp[cy * N + cx];
      if (c >= 0) compRegion[c] = ri;
    }
  });
  for (let i = 0; i < N * N; i++) if (lab[i] === null) lab[i] = compRegion[comp[i]] == null ? 'x' : 'f' + compRegion[comp[i]];
  // 区画ごとに、縁から十分遠い升目（一番遠い点の 85% 以上）のうち、区画の重心に一番近いもの（左右対称になりやすい）
  const pole = (L) => {
    const cells = [], edge = [];
    for (let i = 0; i < N * N; i++) {
      if (lab[i] === L) { cells.push(i); continue; }
      const cx = i % N, cy = Math.floor(i / N);
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const nx = cx + dx, ny = cy + dy; return nx >= 0 && ny >= 0 && nx < N && ny < N && lab[ny * N + nx] === L; })) edge.push(cellXY(i));
    }
    if (!cells.length) return [0.5, 0.5];
    const pts = cells.map(cellXY);
    const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length, my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const ds = pts.map(([x, y]) => {
      let d = Math.min(x, y, 1 - x, 1 - y);
      for (const [ex, ey] of edge) d = Math.min(d, Math.hypot(x - ex, y - ey));
      return d;
    });
    const maxD = Math.max(...ds);
    let best = null, bestC = Infinity;
    pts.forEach(([x, y], k) => {
      const c = Math.hypot(x - mx, y - my);
      if (ds[k] >= maxD * 0.85 - 1e-9 && c < bestC - 1e-9) { best = [x, y]; bestC = c; }
    });
    return best;
  };
  const res = {
    city: kind.cityGroups.map((g, gi) => pole('c' + gi)),
    road: segs.map(([[ax, ay], [bx, by]]) => [(ax + bx) / 2, (ay + by) / 2]),
    field: info.regions.map((r, ri) => pole('f' + ri)),
  };
  ANCHOR_CACHE.set(ck, res);
  return res;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 動作の自己チェック（道を東西からふさいで完成させ、駒が返って点が入るか見る）
function selfCheckScoring() {
  const g = new Game(2);
  // 開始タイル(0,0)は 城N・道E-W。T字路タイル(FRRR)の単独の1辺を両側からふさぐと、
  // 開始タイルの道（2枚)＋両ふさぎ(2枚)＝4枚がちょうど閉じる形になる。
  const capIdx = TILE_KINDS.findIndex((k) => k.edges.join('') === 'FRRR');
  console.assert(capIdx >= 0, '自己チェック: FRRR タイルが見つからない');

  g.placeTileOnBoard(1, 0, 0, capIdx); // 東をふさぐ（まだ西が開いている）
  const roadOpt = g.meepleOptions(0, 0).find((o) => o.type === 'road');
  console.assert(!!roadOpt, '自己チェック: 道の駒置き場所が見つからない');
  g.placeMeeple(0, 0, roadOpt);
  console.assert(g.players[0].meeples === 6, '自己チェック: 駒を置いたのに減っていない');

  g.placeTileOnBoard(-1, 0, 0, capIdx); // 西もふさぐ → 道が完成するはず
  console.assert(g.players[0].score === 3, `自己チェック: 道の得点が違う (${g.players[0].score})`);
  console.assert(g.players[0].meeples === 7, '自己チェック: 完成した道の駒が戻っていない');
}
try { selfCheckScoring(); } catch (e) { console.error('自己チェック失敗', e); }

// ================================================================
// 画面まわり
// ================================================================
const els = {
  setup: document.getElementById('setup'),
  playercount: document.getElementById('playercount'),
  continueBtn: document.getElementById('continueBtn'),
  game: document.getElementById('game'),
  scoreboard: document.getElementById('scoreboard'),
  board: document.getElementById('board'),
  preview: document.getElementById('previewCanvas'),
  rotateBtn: document.getElementById('rotateBtn'),
  message: document.getElementById('message'),
  deckCount: document.getElementById('deckCount'),
  skipBtn: document.getElementById('skipBtn'),
  placeBtn: document.getElementById('placeBtn'),
  listBtn: document.getElementById('listBtn'),
  track: document.getElementById('track'),
  listDialog: document.getElementById('listDialog'),
  listGrid: document.getElementById('listGrid'),
  result: document.getElementById('result'),
  ranking: document.getElementById('ranking'),
  restartBtn: document.getElementById('restartBtn'),
};

let game = null;
let previewRot = 0;
let ghost = null; // 仮に置いたマス { x, y }。決定するまで向きを変えられる
let view = { scale: 64, ox: 0, oy: 0 }; // scale = 1 タイルぶんの画面ピクセル数

function serializeGame(g) {
  return { v: 1, playerCount: g.playerCount, deckOrder: g.deckOrder, log: g.log };
}
function saveGame() { if (game) save('game', serializeGame(game)); }

// 保存データは「山札の並び」と「これまでの手」だけ。山札を同じ並びで引き直しながら
// 同じ手を再現すれば、盤面・得点・つながりはすべて元どおりに計算し直せる。
function rebuildFromSave(data) {
  replaying = true;
  const g = Object.create(Game.prototype);
  g.playerCount = data.playerCount;
  g.players = Array.from({ length: data.playerCount }, (_, i) => ({ color: PLAYER_COLORS[i], score: 0, meeples: 7 }));
  g.currentPlayer = 0;
  g.board = new Map();
  g.cloisters = new Map();
  g.dsu = new DSU();
  g.allNodeKeys = new Set();
  g.gameOver = false;
  g.finalRanking = null;
  g.deckOrder = data.deckOrder;
  g.deckPos = 0;
  g.log = [];
  g.pendingTile = null;
  g.pendingOptions = null;
  g.message = '';

  const startIdx = TILE_KINDS.findIndex((k) => k.start);
  g.placeTileOnBoard(0, 0, 0, startIdx, { silent: true });

  for (const entry of data.log) {
    g.drawNext(); // このタイミングで捨てられたタイルも同じ順で再現される
    if (!g.pendingTile) break; // 保存データがおかしいときの保険
    g.placeTileOnBoard(entry.x, entry.y, entry.rot, g.pendingTile.kindIndex);
    g.pendingTile = null;
    if (entry.meepleKey != null) {
      const options = g.meepleOptions(entry.x, entry.y);
      const opt = options.find((o) => o.key === entry.meepleKey);
      if (opt) g.placeMeeple(entry.x, entry.y, opt);
    }
    g.currentPlayer = (g.currentPlayer + 1) % g.playerCount;
    g.log.push(entry);
  }
  g.drawNext();
  replaying = false;
  return g;
}

function startNewGame(playerCount) {
  game = new Game(playerCount);
  previewRot = game.pendingTile ? game.pendingTile.rot : 0;
  saveGame();
  showGameScreen();
  renderAll();
}

function showGameScreen() {
  els.setup.hidden = true;
  els.result.hidden = true;
  els.game.hidden = false;
  resizeCanvas();
}

function showResultScreen() {
  els.game.hidden = true;
  els.result.hidden = false;
  els.ranking.innerHTML = '';
  game.finalRanking.forEach((r, rank) => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'rank-dot';
    dot.style.background = r.color;
    const label = document.createElement('span');
    label.textContent = `${rank + 1}位 プレイヤー${r.i + 1}`;
    const score = document.createElement('span');
    score.className = 'rank-score';
    score.textContent = `${r.score} 点`;
    li.append(dot, label, score);
    els.ranking.appendChild(li);
  });
}

// 残りの駒: 真ん中 1 つと周り 6 つの六角形。外側から減り、最後に真ん中が残る
function meepleHexes(color, n) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '-11 -11 22 22');
  svg.setAttribute('class', 'player-chip__hexes');
  svg.setAttribute('aria-label', `駒 残り ${n}`);
  const r = 3.6, gap = r * Math.sqrt(3) + 0.6;
  const centers = [[0, 0], ...[0, 1, 2, 3, 4, 5].map((k) => [gap * Math.cos((k * Math.PI) / 3), gap * Math.sin((k * Math.PI) / 3)])];
  centers.forEach(([cx, cy], k) => {
    const pts = [0, 1, 2, 3, 4, 5].map((i) => { const a = Math.PI / 2 + (i * Math.PI) / 3; return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`; }).join(' ');
    const poly = document.createElementNS(NS, 'polygon');
    poly.setAttribute('points', pts);
    const on = k === 0 ? n >= 1 : k <= n - 1;
    poly.setAttribute('fill', on ? color : 'none');
    poly.setAttribute('stroke', on ? 'none' : 'rgba(255,255,255,0.18)');
    poly.setAttribute('stroke-width', '0.6');
    svg.appendChild(poly);
  });
  return svg;
}

// 得点ボード: 0〜49 のマスを 10 列 × 5 段に蛇行して並べ、駒を点数のマスに置く（50 点ごとに一周）
function drawTrack() {
  const c = els.track, ctx = c.getContext('2d');
  const W = c.width, H = c.height, cols = 10, rows = 5;
  const cw = W / cols, chh = H / rows;
  const cellOf = (n) => { const r = Math.floor(n / cols), k = n % cols; return [r % 2 ? cols - 1 - k : k, r]; };
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#fbf8ef';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 1;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.font = `${Math.round(chh * 0.3)}px system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (let n = 0; n < 50; n++) {
    const [cx, cy] = cellOf(n);
    ctx.strokeRect(cx * cw + 0.5, cy * chh + 0.5, cw - 1, chh - 1);
    ctx.fillText(String(n), cx * cw + 3, cy * chh + 2);
  }
  // 同じマスに何人かいるときは少しずつずらす
  const byCell = new Map();
  game.players.forEach((p, i) => { const k = p.score % 50; if (!byCell.has(k)) byCell.set(k, []); byCell.get(k).push(i); });
  for (const [k, list] of byCell) {
    const [cx, cy] = cellOf(k);
    list.forEach((i, j) => {
      const off = (j - (list.length - 1) / 2) * cw * 0.16;
      ctx.fillStyle = PLAYER_COLORS[i];
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      hexPath(ctx, cx * cw + cw * 0.55 + off, cy * chh + chh * 0.6 + off * 0.3, Math.min(cw, chh) * 0.26);
      ctx.fill();
      ctx.stroke();
    });
  }
}

function renderScoreboard() {
  els.scoreboard.innerHTML = '';
  game.players.forEach((p, i) => {
    const chip = document.createElement('div');
    chip.className = 'player-chip' + (i === game.currentPlayer ? ' active' : '');
    chip.appendChild(meepleHexes(p.color, p.meeples));
    chip.appendChild(document.createTextNode(`${p.score}点`));
    els.scoreboard.appendChild(chip);
  });
}

function renderAll() {
  if (!game) return;
  renderScoreboard();
  els.deckCount.textContent = String(game.deckOrder.length - game.deckPos + (game.pendingTile ? 1 : 0));
  els.message.textContent = game.message;
  els.skipBtn.hidden = !game.pendingOptions;
  els.placeBtn.hidden = !ghost;
  drawPreview();
  drawTrack();
  drawBoard();
}

// ---- タイルの絵を描く（盤面・プレビュー共通） ----
function drawTileArt(ctx, kindIndex, rot, px, py, size, opts = {}) {
  const kind = TILE_KINDS[kindIndex];
  const info = analyzeTile(kind, rot);
  ctx.save();
  ctx.translate(px, py);
  // 下地（草原）
  ctx.fillStyle = '#fbf8ef';
  ctx.fillRect(0, 0, size, size);

  // 都市
  ctx.fillStyle = '#9aa0ab';
  kind.cityGroups.forEach((g, gi) => {
    const abs = g.edges.map((li) => (li + rot) % 4);
    ctx.beginPath();
    for (const d of abs) {
      const [c1, c2] = EDGE_CORNERS[d];
      ctx.moveTo(size * 0.5, size * 0.5);
      ctx.lineTo(c1[0] * size, c1[1] * size);
      ctx.lineTo(c2[0] * size, c2[1] * size);
      ctx.closePath();
    }
    ctx.fill();
  });
  // 紋章
  ctx.fillStyle = '#4a4f58';
  kind.cityGroups.forEach((g) => {
    if (!g.pennant) return;
    const abs = g.edges.map((li) => (li + rot) % 4);
    // 都市の隅（となりの辺も同じ都市ならその角）に、ひし形の 2 つの頂点がタイルの 2 辺に触れるように置く
    const d = abs[0];
    const [cx, cy] = EDGE_CORNERS[d][abs.includes((d + 1) % 4) ? 1 : 0];
    const r = size * 0.07;
    const ax = cx ? size - r : r, ay = cy ? size - r : r;
    ctx.beginPath();
    ctx.moveTo(ax, ay - r);
    ctx.lineTo(ax + r, ay);
    ctx.lineTo(ax, ay + r);
    ctx.lineTo(ax - r, ay);
    ctx.closePath();
    ctx.fill();
  });

  // 道
  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = Math.max(1, size * 0.015);
  ctx.lineCap = 'round';
  kind.roadGroups.forEach((g) => {
    const abs = g.edges.map((li) => (li + rot) % 4);
    // 2 辺をつなぐ道は辺の中点どうしを直線で（曲がり道は斜め線）、1 辺だけの道は中央まで
    const [a, b] = abs.length === 2 ? abs.map((d) => EDGE_MID[d]) : [[0.5, 0.5], EDGE_MID[abs[0]]];
    ctx.beginPath();
    ctx.moveTo(a[0] * size, a[1] * size);
    ctx.lineTo(b[0] * size, b[1] * size);
    ctx.stroke();
  });
  // 黒点は交差点だけ（都市・修道院で止まる道には描かない）
  if (kind.roadGroups.length >= 2) {
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(size * 0.43, size * 0.43, size * 0.14, size * 0.14);
  }

  // 修道院
  if (kind.cloister) {
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    ctx.moveTo(size * 0.5, size * 0.28);
    ctx.lineTo(size * 0.68, size * 0.62);
    ctx.lineTo(size * 0.32, size * 0.62);
    ctx.closePath();
    ctx.fill();
  }

  // 枠
  // 枠（opts.joined[d] が true の辺は、となりのタイルと接しているので描かない）
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 1;
  const j = opts.joined || [];
  const lo = 0.5, hi = size - 0.5;
  const sides = [[lo, lo, hi, lo], [hi, lo, hi, hi], [hi, hi, lo, hi], [lo, hi, lo, lo]];
  ctx.beginPath();
  sides.forEach(([x1, y1, x2, y2], d) => { if (!j[d]) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); } });
  ctx.stroke();

  if (opts.meeples) {
    for (const m of opts.meeples) {
      ctx.fillStyle = PLAYER_COLORS[m.player];
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 1.5;
      hexPath(ctx, m.anchor[0] * size, m.anchor[1] * size, size * 0.075);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

// 駒の形: 上と下に頂点が来る六角形
function hexPath(ctx, x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 3;
    ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
  }
  ctx.closePath();
}

function drawPreview() {
  const ctx = els.preview.getContext('2d');
  ctx.clearRect(0, 0, els.preview.width, els.preview.height);
  if (!game.pendingTile) return;
  drawTileArt(ctx, game.pendingTile.kindIndex, previewRot, 0, 0, els.preview.width);
}

function resizeCanvas() {
  const canvas = els.board;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  canvas.dataset.dpr = dpr;
}

// 置いたタイルと周りの余白が全部入るように縮めて中央に置く
function fitView() {
  const canvas = els.board;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const key of game.board.keys()) {
    const [x, y] = key.split(',').map(Number);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  x0--; x1++; y0 -= 2; y1 += 2; // 横は周り 1 マス、縦は上下 2 マスずつ余白
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const dpr = Number(canvas.dataset.dpr || 1);
  view.scale = Math.min(canvas.width / w, canvas.height / h, 96 * dpr);
  view.ox = (canvas.width - w * view.scale) / 2 - x0 * view.scale;
  view.oy = (canvas.height - h * view.scale) / 2 - y0 * view.scale;
}

function meepleInfoForRender() {
  // 置いた駒を、置いたタイルの上にだけ描く（tileKey -> [{anchor, player}]）
  const map = new Map();
  if (!game) return map;
  const add = (m) => { const k = tileKey(m.x, m.y); if (!map.has(k)) map.set(k, []); map.get(k).push(m); };
  const roots = new Set([...game.allNodeKeys].map((k) => game.dsu.find(k)));
  for (const r of roots) for (const m of game.dsu.meta.get(r).meeples) add(m);
  for (const c of game.cloisters.values()) if (c.meeple) add(c.meeple);
  return map;
}

function drawBoard() {
  const canvas = els.board;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#efe9da';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  fitView();

  const meeples = meepleInfoForRender();
  for (const [key, tile] of game.board) {
    const [x, y] = key.split(',').map(Number);
    const size = view.scale;
    const px = view.ox + x * size;
    const py = view.oy + y * size;
    if (px + size < 0 || py + size < 0 || px > canvas.width || py > canvas.height) continue;
    const joined = [0, 1, 2, 3].map((d) => game.board.has(tileKey(x + DX[d], y + DY[d])));
    drawTileArt(ctx, tile.kindIndex, tile.rot, px, py, size, { meeples: meeples.get(key), joined });
  }

  // 置ける場所のハイライト
  if (game.pendingTile && !game.pendingOptions) {
    const seen = new Set();
    const cells = [0, 1, 2, 3].flatMap((r) => game.currentValidCells(r))
      .filter(([x, y]) => !seen.has(x + ',' + y) && seen.add(x + ',' + y));
    // 点線の正方形で示す
    const dpr = Number(canvas.dataset.dpr || 1);
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    for (const [x, y] of cells) {
      const size = view.scale;
      const px = view.ox + x * size, py = view.oy + y * size;
      ctx.strokeRect(px + 3 * dpr, py + 3 * dpr, size - 6 * dpr, size - 6 * dpr);
    }
    ctx.setLineDash([]);
    if (ghost) {
      const size = view.scale;
      const px = view.ox + ghost.x * size, py = view.oy + ghost.y * size;
      drawTileArt(ctx, game.pendingTile.kindIndex, previewRot, px, py, size);
      ctx.strokeStyle = PLAYER_COLORS[game.currentPlayer];
      ctx.lineWidth = 3;
      ctx.strokeRect(px + 1.5, py + 1.5, size - 3, size - 3);
    }
  }

  // 駒の選択肢のハイライト
  if (game.pendingOptions) {
    const { x, y, options } = game.pendingOptions;
    const size = view.scale;
    const px = view.ox + x * size, py = view.oy + y * size;
    ctx.fillStyle = PLAYER_COLORS[game.currentPlayer];
    for (const opt of options) {
      ctx.beginPath();
      ctx.arc(px + opt.anchor[0] * size, py + opt.anchor[1] * size, Math.max(3, size * 0.04), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ---- 入力（盤は自動で全体が入るので、タップだけ） ----
els.board.addEventListener('click', (e) => {
  if (!game) return;
  const rect = els.board.getBoundingClientRect();
  const dpr = Number(els.board.dataset.dpr || 1);
  handleTap((e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr);
});

function handleTap(sx, sy) {
  const size = view.scale;
  const wx = (sx - view.ox) / size, wy = (sy - view.oy) / size;
  const cx = Math.floor(wx), cy = Math.floor(wy);

  if (game.pendingOptions) {
    const { x, y, options } = game.pendingOptions;
    if (cx === x && cy === y) {
      const lx = wx - x, ly = wy - y;
      let best = null, bestD = Infinity;
      for (const opt of options) {
        const d = Math.hypot(lx - opt.anchor[0], ly - opt.anchor[1]);
        if (d < bestD) { bestD = d; best = opt; }
      }
      if (best) commitMeeple(x, y, best);
    }
    return;
  }

  if (game.pendingTile) {
    const same = ghost && ghost.x === cx && ghost.y === cy;
    const rot = nextValidRot(cx, cy, same ? previewRot + 1 : previewRot);
    if (rot == null) return;
    ghost = { x: cx, y: cy };
    previewRot = rot;
    renderAll();
  }
}

// from から順に回して、そのマスに置ける最初の向き（なければ null）
function nextValidRot(x, y, from) {
  const kind = TILE_KINDS[game.pendingTile.kindIndex];
  for (let i = 0; i < 4; i++) {
    const r = (from + i) % 4;
    if (game.isValidPlacement(kind, r, x, y)) return r;
  }
  return null;
}

function rotatePending() {
  if (!game || !game.pendingTile || game.pendingOptions) return;
  previewRot = ghost ? nextValidRot(ghost.x, ghost.y, previewRot + 1) : (previewRot + 1) % 4;
  renderAll();
}

function commitPlacement(x, y, rot) {
  const kindIndex = game.pendingTile.kindIndex;
  game.placeTileOnBoard(x, y, rot, kindIndex);
  soundPlace();
  ghost = null;
  const canPlaceMeeple = game.players[game.currentPlayer].meeples > 0;
  const options = canPlaceMeeple ? game.meepleOptions(x, y) : [];
  game.pendingTile = null;
  game.log.push({ kindIndex, x, y, rot, meepleKey: null });
  if (options.length) {
    game.pendingOptions = { x, y, options };
    game.message = '駒を置きますか？（置かないなら「駒を置かない」）';
    renderAll(); // 保存はこの手番の駒を決めてから（finishTurn で）
  } else {
    finishTurn();
  }
}

function commitMeeple(x, y, option) {
  game.placeMeeple(x, y, option);
  game.log[game.log.length - 1].meepleKey = option.key;
  game.pendingOptions = null;
  finishTurn();
}

function skipMeeple() {
  if (!game.pendingOptions) return;
  game.pendingOptions = null;
  finishTurn();
}

function finishTurn() {
  game.currentPlayer = (game.currentPlayer + 1) % game.playerCount;
  game.drawNext();
  previewRot = game.pendingTile ? game.pendingTile.rot : 0;
  if (!game.pendingTile && game.gameOver) {
    saveGame();
    showResultScreen();
    return;
  }
  game.message = '光っているマスをタップ（もう一度タップで回る）→「ここに置く」';
  saveGame();
  renderAll();
}

els.rotateBtn.addEventListener('click', rotatePending);
els.preview.addEventListener('click', rotatePending);
els.placeBtn.addEventListener('click', () => {
  if (ghost && game.pendingTile) commitPlacement(ghost.x, ghost.y, previewRot);
});
els.skipBtn.addEventListener('click', skipMeeple);
els.listBtn.addEventListener('click', () => {
  if (!game) return;
  const left = TILE_KINDS.map(() => 0);
  for (const k of game.deckOrder.slice(game.deckPos)) left[k]++;
  els.listGrid.replaceChildren(...TILE_KINDS.map((kind, i) => {
    const item = document.createElement('div');
    item.className = 'tile-list__item' + (left[i] ? '' : ' empty');
    const c = document.createElement('canvas');
    c.width = c.height = 112;
    drawTileArt(c.getContext('2d'), i, 0, 0, 0, 112);
    const label = document.createElement('span');
    label.textContent = `${left[i]} / ${kind.count}`;
    item.append(c, label);
    return item;
  }));
  els.listDialog.showModal();
});
els.restartBtn.addEventListener('click', () => {
  try { localStorage.removeItem(STORE + 'game'); } catch { /* noop */ }
  els.result.hidden = true;
  els.setup.hidden = false;
  ghost = null;
});
els.playercount.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-n]');
  if (!btn) return;
  startNewGame(Number(btn.dataset.n));
});
window.addEventListener('resize', () => { if (!els.game.hidden) { resizeCanvas(); drawBoard(); } });

// ---- 起動時：保存があれば「つづきから」を出す ----
(function boot() {
  const saved = load('game', null);
  if (saved && saved.log) {
    els.continueBtn.hidden = false;
    els.continueBtn.addEventListener('click', () => {
      els.continueBtn.hidden = true; // 一度使ったら古い保存を指したままにしない
      game = rebuildFromSave(saved);
      previewRot = game.pendingTile ? game.pendingTile.rot : 0;
      showGameScreen();
      renderAll();
      if (game.pendingTile == null && game.gameOver) showResultScreen();
    });
  }
})();
