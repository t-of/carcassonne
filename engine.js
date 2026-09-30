'use strict';
// カルカソンヌ基本セットのルール・盤面・得点計算（画面・音・localStorage に触らない）。
// ブラウザ（main.js が import）と Node（ai/ の自己対局・学習）の両方から同じコードを使う。
// 得点や修道院の完成など「音を鳴らすべきこと」は、そのつど game.events に積む。
// 鳴らすかどうかは呼び出し側（main.js）が events を見て決める。

// ================================================================
// タイルの定義（RULES.md 相当。現行版のカルカソンヌ基本セット 72 枚）
// edges は [N, E, S, W]。'C' = 都市、'R' = 道、'F' = 草原
// ================================================================
const DIRS = ['N', 'E', 'S', 'W'];
const DI = { N: 0, E: 1, S: 2, W: 3 };
const OPP = [2, 3, 0, 1];
export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];

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
export const TILE_KINDS = buildKinds();

// 自己チェック（このロジックが壊れたら分かるように）
function selfCheckTileCounts() {
  const total = TILE_KINDS.reduce((s, k) => s + k.count, 0);
  console.assert(total === 72, `タイル合計が 72 でない: ${total}`);
  const starts = TILE_KINDS.filter((k) => k.start);
  console.assert(starts.length === 1, '開始タイルが 1 種類でない');
}
selfCheckTileCounts();

// kind・rot ごとに 1 回だけ計算する（isValidPlacement が候補ごとに同じ kind・rot で何度も呼ぶため）。
function absoluteEdges(kind, rot) {
  if (!kind._absCache) kind._absCache = [null, null, null, null];
  return kind._absCache[rot] || (kind._absCache[rot] = [0, 1, 2, 3].map((d) => kind.edges[(d - rot + 4) % 4]));
}
function groupAt(kind, rot, table, d) {
  return table[(d - rot + 4) % 4];
}
// neighborRequirements() が求めた「四方から必要な辺」を、この kind・rot がすべて満たすか。
function matchesRequirements(kind, rot, req) {
  const abs = absoluteEdges(kind, rot);
  for (let d = 0; d < 4; d++) if (req[d] != null && req[d] !== abs[d]) return false;
  return true;
}

// タイル内の 8 分割点（0=N左,1=N右,2=E上,3=E下,4=S右,5=S左,6=W下,7=W上）の座標（0..1）
const POINT_COORD = [
  [0.25, 0], [0.75, 0], [1, 0.25], [1, 0.75],
  [0.75, 1], [0.25, 1], [0, 0.75], [0, 0.25],
];
export const EDGE_MID = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
export const EDGE_CORNERS = [[[0, 0], [1, 0]], [[1, 0], [1, 1]], [[1, 1], [0, 1]], [[0, 1], [0, 0]]];

// 1 タイル分の見取り図を作る（都市・道・草原区画・修道院・つながりを計算）
export function analyzeTile(kind, rot) {
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
export class DSU {
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

// DSU の meta（道・都市・草原ごとの状態）を複製する。openEnds は delete で、meeples は push で
// その場を書き換えるので Set/配列は複製が必要。meeples の要素自体はあとで書き換わらないので参照共有でよい。
// tiles は数ではなく Set のまま持つ（道・都市が輪になって、同じタイルを2つの端から数えてしまう
// ことがあるので、タイル数のかわりに単なる足し算にはできない。ponytail で数に倒そうとして壊した）。
function cloneFeatureMeta(m) {
  const c = { type: m.type, meeples: m.meeples.slice(), awarded: m.awarded };
  if (m.tiles) c.tiles = new Set(m.tiles);
  if (m.openEnds) { c.openEnds = new Set(m.openEnds); c.pennants = m.pennants; c.done = m.done; }
  if (m.touches) c.touches = new Set(m.touches);
  return c;
}

export function tileKey(x, y) { return `${x},${y}`; }
function cityKey(x, y, gi) { return `${x},${y}C${gi}`; }
function roadKey(x, y, gi) { return `${x},${y}R${gi}`; }
function fieldKey(x, y, ri) { return `${x},${y}F${ri}`; }
function endKey(x, y, d) { return `${x},${y}:${DIRS[d]}`; }

// ================================================================
// ゲーム本体
// ================================================================
export const PLAYER_COLORS = ['#e0524f', '#4f8ef7', '#3fbf6f', '#f2b632', '#a985e8'];

export class Game {
  // opts.seed を渡すと、山札の並びがその種から決まる乱数になる（渡さなければ Math.random）。
  // 同じ種なら何度作っても同じゲームになる（学習の自己対局を再現するため）。
  constructor(playerCount, opts = {}) {
    this.playerCount = playerCount;
    this.players = Array.from({ length: playerCount }, (_, i) => ({ color: PLAYER_COLORS[i], score: 0, meeples: 7 }));
    this.currentPlayer = 0;
    this.board = new Map();       // tileKey -> { kindIndex, rot }
    this.frontierSet = new Map(); // 置ける可能性のある空きマスの key -> [x,y]（置くたびに増減を差分で更新する）
    this.cloisters = new Map();   // tileKey -> { meeple: {player}|null, awarded: bool }
    this.dsu = new DSU();
    this.gameOver = false;
    this.finalRanking = null;
    this.rngState = opts.seed != null ? ((opts.seed >>> 0) || 1) : null;

    // 開始タイル
    const startIdx = TILE_KINDS.findIndex((k) => k.start);
    const pool = [];
    TILE_KINDS.forEach((k, ki) => { for (let i = 0; i < k.count; i++) pool.push(ki); });
    const firstPos = pool.indexOf(startIdx);
    pool.splice(firstPos, 1);
    this.deckOrder = shuffle(pool, () => this.nextRandom());
    this.deckPos = 0;

    this.log = []; // { kindIndex, x, y, rot, meepleOptionIdx|null } の並び（保存・再生用）
    this.pendingTile = null;      // { kindIndex, rot }
    this.pendingOptions = null;   // 置いた直後の駒の選択肢
    this.message = '';
    this.events = [];             // この手番で入った点（呼び出し側が知らせ・音に使う）

    this.placeTileOnBoard(0, 0, 0, startIdx, { silent: true });
    this.drawNext();
  }

  // 種つきの乱数（xorshift32）。種を渡していなければ Math.random。
  nextRandom() {
    if (this.rngState == null) return Math.random();
    let s = this.rngState;
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    this.rngState = s;
    return s / 4294967296;
  }

  // 盤面を丸ごと複製する（探索で1手ごとに何千回も呼ぶ想定）。
  // structuredClone は汎用だが遅いので、この形（Map/Set/配列のどこが後で書き換わるか）を知った上で
  // 必要なところだけ new Map/new Set/slice で複製する（書き換わらない部分は参照を共有してよい）。
  clone() {
    const g = Object.create(Game.prototype);
    g.playerCount = this.playerCount;
    g.players = this.players.map((p) => ({ color: p.color, score: p.score, meeples: p.meeples }));
    g.currentPlayer = this.currentPlayer;
    g.board = new Map(this.board); // 値 {kindIndex,rot} は置いたあと書き換わらないので参照共有でよい
    g.frontierSet = new Map(this.frontierSet);
    g.cloisters = new Map();
    for (const [k, v] of this.cloisters) g.cloisters.set(k, { meeple: v.meeple, awarded: v.awarded });
    g.dsu = new DSU();
    g.dsu.parent = new Map(this.dsu.parent);
    for (const [k, v] of this.dsu.meta) g.dsu.meta.set(k, cloneFeatureMeta(v));
    g.gameOver = this.gameOver;
    g.finalRanking = this.finalRanking ? this.finalRanking.map((r) => ({ ...r })) : null;
    g.deckOrder = this.deckOrder; // 作った後は書き換わらない（deckPos が進むだけ）
    g.deckPos = this.deckPos;
    g.log = this.log.slice(); // push されるので配列は複製、要素は書き換わらないので参照共有でよい
    g.pendingTile = this.pendingTile ? { ...this.pendingTile } : null;
    g.pendingOptions = this.pendingOptions; // main.js だけが使い、丸ごと入れ替えるだけなので参照共有でよい
    g.message = this.message;
    g.rngState = this.rngState;
    g.events = [];
    return g;
  }

  // ---- 探索用: 今のタイルで打てる手を全部挙げる／1手（タイルを引く・置く・駒・得点・次の人まで）進める ----
  // 手の形: { x, y, rot, meepleKey } （meepleKey は駒を置く区画の key。置かないなら null）
  legalMoves() {
    if (!this.pendingTile || this.gameOver) return [];
    const kind = TILE_KINDS[this.pendingTile.kindIndex];
    const moves = [];
    for (const [x, y] of this.frontier()) {
      // 隣の4タイルは回転(rot)によらず同じなので、1マスにつき1回だけ調べる
      // （isValidPlacement を rot ごとに呼ぶと同じ盤面参照を4回繰り返すことになる）。
      const req = this.neighborRequirements(x, y);
      if (!req) continue;
      for (let rot = 0; rot < 4; rot++) {
        if (!matchesRequirements(kind, rot, req)) continue;
        moves.push({ x, y, rot, meepleKey: null });
        if (this.players[this.currentPlayer].meeples <= 0) continue;
        // 駒の置ける区画は、隣とつながって既に駒入りの区画になることがある（実際に置いてみないと
        // 分からない）ので、以前は仮に複製した盤へ置いて調べていた。手数が多いタイルほど clone() が
        // 積み重なって遅かったので、置かずに隣の区画だけたどって調べる（下の meepleOptionsIfPlaced）。
        for (const opt of this.meepleOptionsIfPlaced(x, y, rot, this.pendingTile.kindIndex)) {
          moves.push({ x, y, rot, meepleKey: opt.key });
        }
      }
    }
    return moves;
  }

  applyMove(move) {
    const { x, y, rot, meepleKey } = move;
    const kindIndex = this.pendingTile.kindIndex;
    this.placeTileOnBoard(x, y, rot, kindIndex);
    if (meepleKey != null) {
      const opt = this.meepleOptions(x, y).find((o) => o.key === meepleKey);
      if (opt) this.placeMeeple(x, y, opt);
    }
    this.log.push({ kindIndex, x, y, rot, meepleKey: meepleKey ?? null });
    this.events = [];
    this.scoreAround(x, y);
    const events = this.events;
    this.events = [];
    this.currentPlayer = (this.currentPlayer + 1) % this.playerCount;
    this.drawNext();
    return events;
  }

  // ---- 山札 ----
  drawNext() {
    while (this.deckPos < this.deckOrder.length) {
      const kindIndex = this.deckOrder[this.deckPos];
      const options = this.frontierOptions(kindIndex);
      if (options.some((o) => o.rotations.length)) {
        this.deckPos++;
        this.pendingTile = { kindIndex, rot: options.find((o) => o.rotations.length).rotations[0] };
        this.message = '「タイルを引く」を押してください';
        return;
      }
      // どこにも置けない → 捨てて引き直し
      this.deckPos++;
    }
    this.pendingTile = null;
    this.finishGame();
  }

  // frontierSet（置くたびに placeTileOnBoard が差分更新している）を並べ直すだけ。盤面全体は見ない。
  frontier() {
    return [...this.frontierSet.values()];
  }

  frontierOptions(kindIndex) {
    const kind = TILE_KINDS[kindIndex];
    return this.frontier().map(([x, y]) => {
      const req = this.neighborRequirements(x, y);
      const rotations = req ? [0, 1, 2, 3].filter((r) => matchesRequirements(kind, r, req)) : [];
      return { x, y, rotations };
    });
  }

  // (x,y) の四方にある既存タイルが、こちら向きの辺に求める種類（'C'/'R'/'F'）を1回だけ求める。
  // 隣が1つもなければ null（どの回転でも置けない）。isValidPlacement・legalMoves・frontierOptions が
  // 同じ盤面参照を rot ごとに繰り返さずに済むように、盤面を見る部分だけ切り出したもの。
  neighborRequirements(x, y) {
    const req = [null, null, null, null];
    let touched = false;
    for (let d = 0; d < 4; d++) {
      const nb = this.board.get(tileKey(x + DX[d], y + DY[d]));
      if (!nb) continue;
      touched = true;
      req[d] = absoluteEdges(TILE_KINDS[nb.kindIndex], nb.rot)[OPP[d]];
    }
    return touched ? req : null;
  }

  isValidPlacement(kind, rot, x, y) {
    if (this.board.has(tileKey(x, y))) return false;
    const req = this.neighborRequirements(x, y);
    return !!req && matchesRequirements(kind, rot, req);
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
    this.frontierSet.delete(key);
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      const nk = tileKey(nx, ny);
      if (!this.board.has(nk)) this.frontierSet.set(nk, [nx, ny]);
    }
    const info = analyzeTile(kind, rot);
    const dsu = this.dsu;

    // このタイル自身の道・都市の節を作る
    kind.cityGroups.forEach((g, gi) => {
      const ck = cityKey(x, y, gi);
      dsu.ensure(ck, () => ({ type: 'city', tiles: new Set([key]), openEnds: new Set(), pennants: g.pennant ? 1 : 0, meeples: [], done: false, awarded: false }));
      const absEdges = g.edges.map((localIdx) => (localIdx + rot) % 4);
      for (const d of absEdges) dsu.meta_(ck).openEnds.add(endKey(x, y, d));
    });
    kind.roadGroups.forEach((g, gi) => {
      const rk = roadKey(x, y, gi);
      dsu.ensure(rk, () => ({ type: 'road', tiles: new Set([key]), openEnds: new Set(), meeples: [], done: false, awarded: false }));
      const absEdges = g.edges.map((localIdx) => (localIdx + rot) % 4);
      for (const d of absEdges) dsu.meta_(rk).openEnds.add(endKey(x, y, d));
    });
    info.regions.forEach((region, ri) => {
      const fk = fieldKey(x, y, ri);
      dsu.ensure(fk, () => ({ type: 'field', tiles: new Set([key]), meeples: [], touches: new Set() }));
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

  }

  // 置いたタイルで完成した道・都市・修道院を採点する（駒を置くか決めたあとに呼ぶ）
  scoreAround(x, y) {
    const kind = TILE_KINDS[this.board.get(tileKey(x, y)).kindIndex];
    kind.cityGroups.forEach((g, gi) => this.checkFeatureComplete(cityKey(x, y, gi)));
    kind.roadGroups.forEach((g, gi) => this.checkFeatureComplete(roadKey(x, y, gi)));
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) this.checkCloisterComplete(x + dx, y + dy);
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

  // full なのに未採点の修道院を採点する。x,y を渡すのは (自分の周り) から呼ばれるのと、
  // 最終採点でぜんぶを見直すのと両方があるため。neighborCount は演出用の内訳（main.js の events）に積む。
  checkCloisterComplete(x, y) {
    const key = tileKey(x, y);
    const c = this.cloisters.get(key);
    if (!c || c.awarded) return;
    let full = true, n = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      if (this.board.has(tileKey(x + dx, y + dy))) n++; else full = false;
    }
    if (full && c.meeple) {
      c.awarded = true;
      const player = c.meeple.player;
      this.players[player].score += 9;
      if (this.events) this.events.push({ type: 'cloister', finished: true, players: [player], points: 9, tiles: [[x, y]], detail: { neighborCount: n } });
      this.players[player].meeples++;
      c.meeple = null;
    } else if (full) {
      c.awarded = true; // 駒がいなくても、完成済みとして扱う（最後の採点で二重にしない）
    }
  }

  awardIfNeeded(root) {
    const meta = this.dsu.meta.get(root);
    if (!meta || meta.awarded || meta.meeples.length === 0) { if (meta) meta.awarded = true; return; }
    const per = meta.type === 'city' ? (meta.tiles.size * 2 + meta.pennants * 2) : meta.tiles.size;
    this.awardToMajority(meta, per, meta.type, true);
    meta.awarded = true;
  }

  // meta の道・都市・草原に置かれた駒のうち一番多い人（同数なら全員）に points を渡す。
  // type/finished/extra は、main.js が採点の演出（内訳の文字・盤面のハイライト）に使う events の材料。
  // 得点そのもの（points・勝者）はここでは変えない。
  awardToMajority(meta, points, type, finished, extra = {}) {
    const counts = new Map();
    for (const m of meta.meeples) counts.set(m.player, (counts.get(m.player) || 0) + 1);
    if (counts.size) {
      const max = Math.max(...counts.values());
      const winners = [];
      for (const [player, c] of counts) if (c === max) { this.players[player].score += points; winners.push(player); }
      if (this.events) {
        const tiles = extra.tiles || (meta.tiles ? [...meta.tiles].map((k) => k.split(',').map(Number)) : []);
        const detail = extra.detail || (
          type === 'city' ? { tileCount: meta.tiles.size, pennants: meta.pennants || 0 }
          : type === 'road' ? { tileCount: meta.tiles.size } : undefined
        );
        this.events.push({ type, finished, players: winners, points, tiles, ...extra, detail });
      }
    }
    // 完成したときだけ駒を持ち主に返す（最後の採点では盤面に残す）
    if (!finished) return;
    for (const m of meta.meeples) this.players[m.player].meeples++;
    meta.meeples = [];
  }

  // ---- 駒 ----
  meepleOptions(x, y, all = false) { // all: 駒が埋まっている区画も含める（置いた駒の位置を出すとき）
    const nb = this.board.get(tileKey(x, y));
    const kind = TILE_KINDS[nb.kindIndex];
    const at = featureAnchors(nb.kindIndex, nb.rot);
    const options = [];
    const free = (key) => all || this.dsu.meta_(key).meeples.length === 0;
    kind.cityGroups.forEach((g, gi) => { const key = cityKey(x, y, gi); if (free(key)) options.push({ key, type: 'city', anchor: at.city[gi] }); });
    kind.roadGroups.forEach((g, gi) => { const key = roadKey(x, y, gi); if (free(key)) options.push({ key, type: 'road', anchor: at.road[gi] }); });
    if (kind.cloister) {
      const c = this.cloisters.get(tileKey(x, y));
      if (c && (all || !c.meeple)) options.push({ key: 'M', type: 'cloister', anchor: [0.5, 0.5] });
    }
    at.field.forEach((anchor, ri) => { const key = fieldKey(x, y, ri); if (free(key)) options.push({ key, type: 'field', anchor }); });
    return options;
  }

  // legalMoves() 用: (x,y,rot) にそのタイルを置いたら駒を置ける区画を、実際には置かずに求める。
  // 「置いたときに隣とつながる先の区画が既に駒入りかどうか」だけを見ればよい（新しく置く区画自身は
  // まだ誰も駒を置いていない）。meepleOptions(x, y) を実際の配置後に呼んだときと同じ並び・同じ結果になる。
  meepleOptionsIfPlaced(x, y, rot, kindIndex) {
    const kind = TILE_KINDS[kindIndex];
    const info = analyzeTile(kind, rot);
    const at = featureAnchors(kindIndex, rot);
    const neighborHasMeeple = (d, key) => {
      const nx = x + DX[d], ny = y + DY[d];
      const nb = this.board.get(tileKey(nx, ny));
      return nb ? { nb, nx, ny } : null;
    };
    const options = [];
    kind.cityGroups.forEach((g, gi) => {
      const occupied = g.edges.some((li) => {
        const d = (li + rot) % 4;
        const n = neighborHasMeeple(d);
        if (!n) return false;
        const nbKind = TILE_KINDS[n.nb.kindIndex];
        const nbGi = groupAt(nbKind, n.nb.rot, nbKind.cityGroupOfEdge, OPP[d]);
        return this.dsu.meta_(cityKey(n.nx, n.ny, nbGi)).meeples.length > 0;
      });
      if (!occupied) options.push({ key: cityKey(x, y, gi), type: 'city', anchor: at.city[gi] });
    });
    kind.roadGroups.forEach((g, gi) => {
      const occupied = g.edges.some((li) => {
        const d = (li + rot) % 4;
        const n = neighborHasMeeple(d);
        if (!n) return false;
        const nbKind = TILE_KINDS[n.nb.kindIndex];
        const nbGi = groupAt(nbKind, n.nb.rot, nbKind.roadGroupOfEdge, OPP[d]);
        return this.dsu.meta_(roadKey(n.nx, n.ny, nbGi)).meeples.length > 0;
      });
      if (!occupied) options.push({ key: roadKey(x, y, gi), type: 'road', anchor: at.road[gi] });
    });
    if (kind.cloister) options.push({ key: 'M', type: 'cloister', anchor: [0.5, 0.5] });
    // 新しく置くこのタイルの草原区画どうしが、同じ隣タイルの区画（＝同じ既存の根）を介して
    // つながることがある（例: 曲がり道で分かれた 2 区画が、両方とも隣の 1 つの草原に触れている）。
    // 見た目は別区画でも実は 1 つにつながるので、先に小さな Union-Find でまとめてから調べる。
    const regionRoot = info.regions.map((_, i) => i);
    const findRegion = (a) => (regionRoot[a] === a ? a : (regionRoot[a] = findRegion(regionRoot[a])));
    const touchedRoots = info.regions.map(() => new Set()); // 区画ごとに触れている隣の根（dsu の find 済みキー）
    for (let d = 0; d < 4; d++) {
      const n = neighborHasMeeple(d);
      if (!n) continue;
      const nbKind = TILE_KINDS[n.nb.kindIndex];
      const nbInfo = analyzeTile(nbKind, n.nb.rot);
      for (const ab of [0, 1]) {
        const ri = info.regions.findIndex((r) => r.points.includes(2 * d + ab));
        if (ri < 0) continue;
        const nbRegion = this.regionIndexOfPoint(nbInfo, 2 * OPP[d] + (1 - ab));
        if (nbRegion == null) continue;
        touchedRoots[ri].add(this.dsu.find(fieldKey(n.nx, n.ny, nbRegion)));
      }
    }
    for (let i = 0; i < info.regions.length; i++) {
      for (let j = i + 1; j < info.regions.length; j++) {
        let shared = false;
        for (const r of touchedRoots[i]) if (touchedRoots[j].has(r)) { shared = true; break; }
        if (shared) { const a = findRegion(i), b = findRegion(j); if (a !== b) regionRoot[a] = b; }
      }
    }
    info.regions.forEach((region, ri) => {
      const root = findRegion(ri);
      let occupied = false;
      for (let k = 0; k < info.regions.length && !occupied; k++) {
        if (findRegion(k) !== root) continue;
        for (const nbRoot of touchedRoots[k]) if (this.dsu.meta.get(nbRoot).meeples.length > 0) { occupied = true; break; }
      }
      if (!occupied) options.push({ key: fieldKey(x, y, ri), type: 'field', anchor: at.field[ri] });
    });
    return options;
  }

  placeMeeple(x, y, option) {
    const player = this.currentPlayer;
    if (this.players[player].meeples <= 0) return false;
    if (option.type === 'cloister') {
      this.cloisters.get(tileKey(x, y)).meeple = { player, x, y, key: option.key, anchor: option.anchor };
    } else {
      const meta = this.dsu.meta_(option.key);
      meta.meeples.push({ player, x, y, key: option.key, anchor: option.anchor });
    }
    this.players[player].meeples--;
    return true;
  }

  // ---- 最終採点 ----
  // DSU.union() は古い根の meta を必ず削除するので（下の union 参照）、dsu.meta のキーはつねに
  // 「今生きている根」だけになる。allNodeKeys を find() でたどり直さなくても、dsu.meta.values() を
  // なめれば道・都市・草原ぜんぶの根に、重複なく・1回ずつ触れられる。
  finishGame() {
    this.gameOver = true;
    for (const meta of this.dsu.meta.values()) {
      if (meta.awarded) continue;
      if (meta.type === 'city') { this.awardToMajority(meta, meta.tiles.size + meta.pennants, 'city', false); meta.awarded = true; }
      else if (meta.type === 'road') { this.awardToMajority(meta, meta.tiles.size, 'road', false); meta.awarded = true; }
    }
    for (const [key, c] of this.cloisters) {
      if (c.awarded) continue;
      c.awarded = true;
      if (!c.meeple) continue;
      const [x, y] = key.split(',').map(Number);
      let n = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { if (dx === 0 && dy === 0) continue; if (this.board.has(tileKey(x + dx, y + dy))) n++; }
      const player = c.meeple.player;
      const points = 1 + n;
      this.players[player].score += points;
      if (this.events) this.events.push({ type: 'cloister', finished: false, players: [player], points, tiles: [[x, y]], detail: { neighborCount: n } });
    }
    // 草原：接する「完成した都市」1 つにつき 3 点（草原の内訳には、数えた都市のタイルも付ける）
    for (const meta0 of this.dsu.meta.values()) {
      if (meta0.type !== 'field') continue;
      if (meta0.meeples.length === 0) continue;
      const completedCityRoots = new Set();
      for (const ck of meta0.touches) {
        const croot = this.dsu.find(ck);
        const cmeta = this.dsu.meta.get(croot);
        if (cmeta && cmeta.done) completedCityRoots.add(croot);
      }
      const cityTiles = [...completedCityRoots].flatMap((r) => [...this.dsu.meta.get(r).tiles].map((k) => k.split(',').map(Number)));
      this.awardToMajority(meta0, completedCityRoots.size * 3, 'field', false, {
        cityTiles, detail: { cityCount: completedCityRoots.size },
      });
    }
    this.finalRanking = this.players.map((p, i) => ({ i, color: p.color, score: p.score }))
      .sort((a, b) => b.score - a.score);
  }
}

// ---- 駒を置く位置 ----
// 道はその線の中点。都市・草原は、その区画の中で縁（ほかの区画・道・修道院・タイルの端）から一番遠い点。
// タイルを細かい升目に分けて求める。種類と向きごとに 1 回だけ計算する。
const ANCHOR_CACHE = new Map();
// ドット絵は曲がり道を角を中心にした弧で描くので（pixel-tiles.js の roadDist）、駒の点もそれに合わせる。
// main.js が見た目を切り替えるたびに setCurvedRoads() で更新する。
export let curvedRoads = false;
export function setCurvedRoads(v) { curvedRoads = v; }
function featureAnchors(kindIndex, rot, curved = curvedRoads) {
  const ck = (kindIndex * 4 + rot) * 2 + (curved ? 1 : 0);
  if (ANCHOR_CACHE.has(ck)) return ANCHOR_CACHE.get(ck);
  const kind = TILE_KINDS[kindIndex];
  const info = analyzeTile(kind, rot);
  const N = 49; // 奇数にして中心の升目が真ん中に来るように
  const segs = kind.roadGroups.map((g) => {
    const abs = g.edges.map((li) => (li + rot) % 4);
    return abs.length === 2 ? [EDGE_MID[abs[0]], EDGE_MID[abs[1]]] : [[0.5, 0.5], EDGE_MID[abs[0]]];
  });
  // 曲がり道の弧の中心（2 辺が隣どうしなら、その間の角）
  const arcCorner = ([[ax, ay], [bx, by]]) => (curved && ax !== bx && ay !== by ? [ax === 0.5 ? bx : ax, ay === 0.5 ? by : ay] : null);
  const segDist = (x, y, sg) => {
    const c = arcCorner(sg);
    if (c) return Math.abs(Math.hypot(x - c[0], y - c[1]) - 0.5);
    const [[ax, ay], [bx, by]] = sg;
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
  const pole = (L, exact) => {
    const cells = [], edge = [];
    for (let i = 0; i < N * N; i++) {
      if (lab[i] === L) { cells.push(i); continue; }
      const cx = i % N, cy = Math.floor(i / N);
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const nx = cx + dx, ny = cy + dy; return nx >= 0 && ny >= 0 && nx < N && ny < N && lab[ny * N + nx] === L; })) edge.push(cellXY(i));
    }
    if (!cells.length) return [0.5, 0.5];
    const pts = cells.map(cellXY);
    const [mx, my] = exact || [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    const ds = pts.map(([x, y]) => {
      let d = Math.min(x, y, 1 - x, 1 - y);
      for (const [ex, ey] of edge) d = Math.min(d, Math.hypot(x - ex, y - ey));
      return d;
    });
    // 重心が区画の中にあって縁から十分離れていれば、重心に置く（左右対称になる）
    let near = 0;
    pts.forEach(([x, y], k) => { if (Math.hypot(x - mx, y - my) < Math.hypot(pts[near][0] - mx, pts[near][1] - my)) near = k; });
    if (Math.hypot(pts[near][0] - mx, pts[near][1] - my) < 1 / N && ds[near] >= 0.1) return exact || pts[near];
    const maxD = Math.max(...ds);
    let best = null, bestC = Infinity;
    pts.forEach(([x, y], k) => {
      const c = Math.hypot(x - mx, y - my);
      if (ds[k] >= maxD * 0.85 - 1e-9 && c < bestC - 1e-9) { best = [x, y]; bestC = c; }
    });
    return best;
  };
  const res = {
    // 都市の重心は、辺ごとの三角形（同じ面積）の重心の平均で正確に出せる
    city: kind.cityGroups.map((g, gi) => {
      const abs = g.edges.map((li) => (li + rot) % 4);
      const cs = abs.map((d) => { const [[ax, ay], [bx, by]] = EDGE_CORNERS[d]; return [(0.5 + ax + bx) / 3, (0.5 + ay + by) / 3]; });
      return pole('c' + gi, [cs.reduce((t, c) => t + c[0], 0) / cs.length, cs.reduce((t, c) => t + c[1], 0) / cs.length]);
    }),
    road: segs.map((sg) => {
      const [[ax, ay], [bx, by]] = sg, c = arcCorner(sg);
      // 弧のまん中（角から中心へ半径 0.5 進んだ点）
      return c ? [c[0] + (0.5 - c[0]) * Math.SQRT1_2, c[1] + (0.5 - c[1]) * Math.SQRT1_2] : [(ax + bx) / 2, (ay + by) / 2];
    }),
    field: info.regions.map((r, ri) => pole('f' + ri)),
  };
  ANCHOR_CACHE.set(ck, res);
  return res;
}

export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
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
  g.scoreAround(-1, 0);
  console.assert(g.players[0].score === 3, `自己チェック: 道の得点が違う (${g.players[0].score})`);
  console.assert(g.players[0].meeples === 7, '自己チェック: 完成した道の駒が戻っていない');
}
try { selfCheckScoring(); } catch (e) { console.error('自己チェック失敗', e); }
