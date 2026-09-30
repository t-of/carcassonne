'use strict';

// ルール・盤面・得点計算は engine.js（画面・音を持たない）。ここは見た目と入力だけ。
import {
  DSU, tileKey, TILE_KINDS, PLAYER_COLORS, Game, setCurvedRoads,
} from './engine.js';
// CPU の相手（学習の自己対局と同じ greedyBot）。ai/bots.js は Node からも import される、共通の 1 か所。
import { greedyBot } from './ai/bots.js';

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
const soundStep = () => beep(620, 0.05); // 得点ボードの駒が1マス進むごとの小さい音

// prefers-reduced-motion ならアニメーションを飛ばす（すぐ数字だけ合わせる）
const reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// ================================================================
// 画面まわり
// ================================================================
const els = {
  setup: document.getElementById('setup'),
  playercount: document.getElementById('playercount'),
  roles: document.getElementById('roles'),
  startBtn: document.getElementById('startBtn'),
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
  drawBtn: document.getElementById('drawBtn'),
  undoBtn: document.getElementById('undoBtn'),
  notice: document.getElementById('notice'),
  track: document.getElementById('track'),
  listDialog: document.getElementById('listDialog'),
  listGrid: document.getElementById('listGrid'),
  result: document.getElementById('result'),
  ranking: document.getElementById('ranking'),
  restartBtn: document.getElementById('restartBtn'),
  spectateBar: document.getElementById('spectateBar'),
  pauseBtn: document.getElementById('pauseBtn'),
  backToSetupBtn: document.getElementById('backToSetupBtn'),
  revealSkipBtn: document.getElementById('revealSkipBtn'),
  revealNextBtn: document.getElementById('revealNextBtn'),
  revealAutoBtn: document.getElementById('revealAutoBtn'),
};

let game = null;
let previewRot = 0;
let ghost = null; // 仮に置いたマス { x, y }。決定するまで向きを変えられる
let view = { scale: 64, ox: 0, oy: 0 }; // scale = 1 タイルぶんの画面ピクセル数

// ---- 得点ボードの駒を1マスずつ進める演出 ----
// displayScore は得点ボードに描く「見せかけの点」。実際の得点(game.players[i].score)は即座に増えるが、
// 駒はこちらを追いかけて1マスずつ進む（animateScoreStep が少しずつ追いつかせる）。
let displayScore = [];
function syncDisplayScore() { displayScore = game.players.map((p) => p.score); }
let animating = false;   // 演出中は操作を止める（renderAll がボタンを disabled/hidden にする）
let reveal = null;       // 最後の採点の演出中: { tiles: Set<tileKey>, cityTiles: Set<tileKey> }（盤面のハイライトに使う）
let revealSkip = false;  // 最後の採点の「とばす」が押されたか
let revealAuto = false;  // 最後の採点を「次へ」を待たずに進めるか
let revealNext = null;   // 「次へ」待ちのときの resolve
function locked() { return isCpuTurn() || animating; }

// ---- CPU（席ごとに 'human' | 'cpu'。既定は全員 human） ----
let gameRoles = [];
function normalizeRoles(saved, n) {
  return Array.from({ length: n }, (_, i) => (saved[i] === 'cpu' ? 'cpu' : 'human'));
}
const isCpu = (i) => gameRoles[i] === 'cpu';
const isCpuTurn = () => !!game && isCpu(game.currentPlayer);
const isSpectating = () => !!game && gameRoles.slice(0, game.playerCount).every((r) => r === 'cpu');
// CPU の手を決める関数はここ 1 か所だけ（あとで「弱い・普通・強い」を足すときも、ここを分けるだけでよい）。
function pickCpuMove(g) { return greedyBot(g); }

const SPEED_MS = { slow: 1400, normal: 700, fast: 250 };
let spectateSpeed = load('spectateSpeed', 'normal');
if (!SPEED_MS[spectateSpeed]) spectateSpeed = 'normal';
let spectatePaused = false;
let cpuTimer = null;
function clearCpuTimer() { if (cpuTimer != null) { clearTimeout(cpuTimer); cpuTimer = null; } }
function cpuDelay() { return SPEED_MS[spectateSpeed] || SPEED_MS.normal; }

function scheduleCpuTurn() {
  clearCpuTimer();
  if (!game || game.gameOver || !game.pendingTile || !isCpu(game.currentPlayer)) return;
  if (isSpectating() && spectatePaused) return;
  cpuTimer = setTimeout(runCpuTurn, cpuDelay());
}

// CPU の 1 手を、人が操作したときと同じ画面の流れ（ghost → commitPlacement → commitMeeple/skipMeeple）で進める。
// こうすると「タイルを置いた場所」「置いた駒」が、既にある描き方でそのまま見える。
function runCpuTurn() {
  cpuTimer = null;
  if (!game || game.gameOver || !game.pendingTile || !isCpu(game.currentPlayer)) return;
  if (!drawn) { drawn = true; game.message = MSG_PLACE; soundPlace(); }
  const move = pickCpuMove(game);
  if (!move) return; // 置ける手がないことは起きないはずだが、念のため
  ghost = { x: move.x, y: move.y };
  previewRot = move.rot;
  renderAll();
  cpuTimer = setTimeout(() => {
    cpuTimer = null;
    commitPlacement(move.x, move.y, move.rot);
    if (game.pendingOptions) {
      cpuTimer = setTimeout(() => {
        cpuTimer = null;
        const opt = move.meepleKey != null ? game.pendingOptions.options.find((o) => o.key === move.meepleKey) : null;
        if (opt) commitMeeple(move.x, move.y, opt); else skipMeeple();
      }, cpuDelay());
    }
  }, cpuDelay());
}

// ---- 見た目: RPG 風のドット絵（絵は pixel-tiles.js） ----
const PIXEL_FONT = "'DotGothic16', monospace";
const PX = { bg: '#1b1f3a', panel: '#1e2244', line: '#f4f0e0', gold: '#f2d45c', ink: '#2a2018', muted: '#9aa0c0' };
document.documentElement.dataset.theme = 'pixel';
setCurvedRoads(true);
document.querySelector('meta[name="theme-color"]').content = '#14162b';
function redrawAll() { if (game && !els.game.hidden) renderAll(); }
// ドット文字が読み込まれたら、キャンバスの文字を描き直す
if (document.fonts) document.fonts.load(`16px ${PIXEL_FONT}`).then(redrawAll, () => {});

// タイルの絵は種類 × 向きごとに 32×32 のキャンバスへ 1 回だけ描いておく
const PIXEL_TILES = new Map();
function pixelTileCanvas(kindIndex, rot) {
  const key = kindIndex * 4 + rot;
  if (PIXEL_TILES.has(key)) return PIXEL_TILES.get(key);
  const { N, PALETTE, build } = window.PixelTiles;
  const px = build(TILE_KINDS[kindIndex], rot, key);
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const cx = c.getContext('2d'), img = cx.createImageData(N, N);
  const rgb = PALETTE.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  px.forEach((v, i) => { img.data.set([...rgb[v], 255], i * 4); });
  cx.putImageData(img, 0, 0);
  PIXEL_TILES.set(key, c);
  return c;
}

// ドット絵の駒（人の形）。L 明るい色 C 色 D 暗い色 O ふち
const MEEPLE_SPRITE = [
  '...OOO...',
  '..OLCCO..',
  '..OCCDO..',
  '.OOCCCOO.',
  'OLCCCCCDO',
  'OCCCCCCDO',
  '.OOCCCOO.',
  '.OCDOCDO.',
  '.OOO.OOO.',
];
function shade(hex, t) { // t > 0 で白へ、t < 0 で黒へ寄せる
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const to = t > 0 ? 255 : 0, k = Math.abs(t);
  return `rgb(${c.map((v) => Math.round(v + (to - v) * k)).join(',')})`;
}
function meepleColors(color) { return { O: PX.ink, L: shade(color, 0.45), C: color, D: shade(color, -0.35) }; }
// (x, y) を中心に、高さ h の駒を描く
function drawPixelMeeple(ctx, x, y, h, color) {
  const cols = meepleColors(color), cell = h / 9, x0 = x - 4.5 * cell, y0 = y - 4.5 * cell;
  MEEPLE_SPRITE.forEach((row, r) => [...row].forEach((ch, c) => {
    if (ch === '.') return;
    ctx.fillStyle = cols[ch];
    const ax = Math.round(x0 + c * cell), ay = Math.round(y0 + r * cell);
    ctx.fillRect(ax, ay, Math.round(x0 + (c + 1) * cell) - ax, Math.round(y0 + (r + 1) * cell) - ay);
  }));
}
// 得点の欄の小さい駒（SVG）
function meepleIcon(color, label) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 9 9');
  svg.setAttribute('class', 'player-chip__meeple');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-label', label);
  const cols = meepleColors(color);
  MEEPLE_SPRITE.forEach((row, r) => [...row].forEach((ch, c) => {
    if (ch === '.') return;
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', c); rect.setAttribute('y', r);
    rect.setAttribute('width', 1); rect.setAttribute('height', 1);
    rect.setAttribute('fill', cols[ch]);
    svg.appendChild(rect);
  }));
  return svg;
}

// 2: 草原の区画の決め方を直し、手の途中（駒を決める前）も保存するようにした版。1 の保存は区画の番号が合わないので続きから遊べない
const SAVE_VERSION = 2;
function serializeGame(g) {
  return { v: SAVE_VERSION, playerCount: g.playerCount, deckOrder: g.deckOrder, log: g.log };
}
function saveGame() { if (game) { save('game', serializeGame(game)); save('roles', gameRoles); } }

// 保存データは「山札の並び」と「これまでの手」だけ。山札を同じ並びで引き直しながら
// 同じ手を再現すれば、盤面・得点・つながりはすべて元どおりに計算し直せる。
function rebuildFromSave(data) {
  replaying = true;
  const g = Object.create(Game.prototype);
  g.playerCount = data.playerCount;
  g.players = Array.from({ length: data.playerCount }, (_, i) => ({ color: PLAYER_COLORS[i], score: 0, meeples: 7 }));
  g.currentPlayer = 0;
  g.board = new Map();
  g.frontierSet = new Map();
  g.cloisters = new Map();
  g.dsu = new DSU();
  g.gameOver = false;
  g.finalRanking = null;
  g.deckOrder = data.deckOrder;
  g.deckPos = 0;
  g.log = [];
  g.pendingTile = null;
  g.pendingOptions = null;
  g.message = '';
  g.events = [];
  g.rngState = null; // 保存データの山札をそのまま使うので、以後の乱数は使わない

  const startIdx = TILE_KINDS.findIndex((k) => k.start);
  g.placeTileOnBoard(0, 0, 0, startIdx, { silent: true });

  for (const entry of data.log) {
    g.drawNext(); // このタイミングで捨てられたタイルも同じ順で再現される
    if (!g.pendingTile) break; // 保存データがおかしいときの保険
    g.placeTileOnBoard(entry.x, entry.y, entry.rot, g.pendingTile.kindIndex);
    g.pendingTile = null;
    g.log.push(entry);
    if (entry.pending) {
      // 駒を置くか決める前で止まっている手（最後の 1 手だけ）
      g.pendingOptions = { x: entry.x, y: entry.y, options: g.players[g.currentPlayer].meeples > 0 ? g.meepleOptions(entry.x, entry.y) : [] };
      g.message = MSG_MEEPLE;
      replaying = false;
      return g;
    }
    if (entry.meepleKey != null) {
      const opt = g.meepleOptions(entry.x, entry.y).find((o) => o.key === entry.meepleKey);
      if (opt) g.placeMeeple(entry.x, entry.y, opt);
    }
    g.scoreAround(entry.x, entry.y);
    g.currentPlayer = (g.currentPlayer + 1) % g.playerCount;
  }
  g.events = [];
  g.drawNext();
  replaying = false;
  return g;
}

function startNewGame(playerCount, roles) {
  game = new Game(playerCount);
  gameRoles = normalizeRoles(roles || [], playerCount);
  syncDisplayScore();
  previewRot = game.pendingTile ? game.pendingTile.rot : 0;
  drawn = false;
  notice = '';
  game.message = MSG_DRAW;
  saveGame();
  showGameScreen();
  renderAll();
  scheduleCpuTurn();
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

// 得点ボード: 0〜49 のマスを 10 列 × 5 段にすき間なく並べた輪（49 の次は 0 に戻る）
// 0 は左上。一番上の段を右へ進み、2〜5 段目を上下に折り返しながら左へ戻り、左の列を上って 0 に帰る
// 駒は点数を 50 で割った余りのマスに置き、50 点以上なら駒に +50・+100… と書く
const TRACK_COLS = 10, TRACK_ROWS = 5;
const TRACK_PATH = (() => {
  const path = [];
  for (let r = 0; r < TRACK_ROWS; r++) path.push([0, r]);
  for (let c = 1; c < TRACK_COLS; c++) {
    for (let k = 0; k < TRACK_ROWS - 1; k++) path.push([c, c % 2 ? TRACK_ROWS - 1 - k : k + 1]);
  }
  for (let c = TRACK_COLS - 1; c >= 1; c--) path.push([c, 0]);
  return [path[0], ...path.slice(1).reverse()]; // 上の組み立ては逆回りなので、0 を残して向きを反対にする
})();
function drawTrack() {
  const c = els.track, ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  // 縦長の枠では 5 列 × 10 段に向きを変える（行と列を入れ替えても輪のまま）
  const tall = H > W;
  const cols = tall ? TRACK_ROWS : TRACK_COLS, rows = tall ? TRACK_COLS : TRACK_ROWS;
  const trackCell = (n) => (tall ? [TRACK_PATH[n][1], TRACK_PATH[n][0]] : TRACK_PATH[n]);
  const cw = W / cols, chh = H / rows;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = PX.panel;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(244,240,224,0.16)';
  ctx.lineWidth = 1;
  ctx.font = `${Math.round(Math.min(cw, chh) * 0.34)}px ${PIXEL_FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (let n = 0; n < 50; n++) {
    const [cx, cy] = trackCell(n);
    ctx.strokeRect(cx * cw + 0.5, cy * chh + 0.5, cw - 1, chh - 1);
    // 5 の倍数だけ濃く
    ctx.fillStyle = n % 5 ? PX.muted : PX.gold;
    ctx.fillText(String(n), cx * cw + 3, cy * chh + 2);
  }
  // 道順が分かるように、マスの中心を順に結ぶ薄い線
  ctx.strokeStyle = 'rgba(242,212,92,0.22)';
  ctx.lineWidth = Math.max(2, Math.min(cw, chh) * 0.06);
  ctx.beginPath();
  TRACK_PATH.forEach((_, n) => { const [cx, cy] = trackCell(n); ctx.lineTo(cx * cw + cw / 2, cy * chh + chh / 2); });
  ctx.closePath();
  ctx.stroke();
  ctx.lineWidth = 1;
  // 同じマスに何人かいるときは少しずつずらす（駒の位置は displayScore。演出中は実際の点よりまだ手前）
  const byCell = new Map();
  game.players.forEach((_, i) => { const k = ((displayScore[i] % 50) + 50) % 50; if (!byCell.has(k)) byCell.set(k, []); byCell.get(k).push(i); });
  const r = Math.min(cw, chh) * 0.42;
  for (const [k, list] of byCell) {
    const [cx, cy] = trackCell(k);
    list.forEach((i, j) => {
      const off = (j - (list.length - 1) / 2) * r * 0.5;
      const x = cx * cw + cw / 2 + off, y = cy * chh + chh / 2 + off * 0.4;
      drawPixelMeeple(ctx, x, y, r * 2, PLAYER_COLORS[i]);
      const laps = Math.floor(displayScore[i] / 50);
      if (laps) {
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.round(r * 0.62)}px ${PIXEL_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = Math.max(2, r * 0.18); ctx.strokeStyle = PX.ink; ctx.strokeText(`+${laps * 50}`, x, y + r * 0.2);
        ctx.fillText(`+${laps * 50}`, x, y + r * 0.2);
      }
    });
  }
}

function renderScoreboard() {
  els.scoreboard.innerHTML = '';
  game.players.forEach((p, i) => {
    const chip = document.createElement('div');
    chip.className = 'player-chip' + (i === game.currentPlayer ? ' active' : '');
    const shownScore = displayScore[i] ?? p.score;
    chip.appendChild(meepleIcon(p.color, `駒 残り ${p.meeples}`));
    chip.appendChild(document.createTextNode(`×${p.meeples}　${shownScore}点`));
    els.scoreboard.appendChild(chip);
  });
}

// 得点の欄と得点ボードだけを描き直す（演出の1マスごとに呼ぶので、盤面全体より軽くする）
function renderScoreArea() {
  if (!game) return;
  renderScoreboard();
  drawTrack();
}

function renderAll() {
  if (!game) return;
  renderScoreboard();
  els.deckCount.textContent = String(game.deckOrder.length - game.deckPos + (game.pendingTile ? 1 : 0));
  els.message.textContent = game.message;
  els.notice.textContent = notice;
  els.notice.hidden = !notice;
  const locked_ = locked();
  els.skipBtn.hidden = !game.pendingOptions || locked_;
  els.placeBtn.hidden = !ghost || locked_;
  els.drawBtn.hidden = !(game.pendingTile && !drawn) || locked_;
  els.rotateBtn.disabled = !drawn || !!game.pendingOptions || locked_;
  els.undoBtn.disabled = (!ghost && !game.log.length) || animating;
  els.spectateBar.hidden = !isSpectating();
  if (isSpectating()) {
    els.pauseBtn.textContent = spectatePaused ? '再開' : '一時停止';
    for (const btn of els.spectateBar.querySelectorAll('button[data-speed]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.speed === spectateSpeed));
    }
  }
  drawPreview();
  drawTrack();
  drawBoard();
}

// ---- タイルの絵を描く（盤面・プレビュー共通） ----
function drawTileArt(ctx, kindIndex, rot, px, py, size, opts = {}) {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(pixelTileCanvas(kindIndex, rot), px, py, size, size);
  for (const m of opts.meeples || []) drawPixelMeeple(ctx, px + m.anchor[0] * size, py + m.anchor[1] * size, size * 0.3, PLAYER_COLORS[m.player]);
  ctx.restore();
}

function drawPreview() {
  const ctx = els.preview.getContext('2d');
  ctx.clearRect(0, 0, els.preview.width, els.preview.height);
  if (!game.pendingTile) return;
  if (!drawn) {
    // 伏せたタイル。裏面: 金の二重枠
    const w = els.preview.width;
    ctx.fillStyle = '#2a2e55';
    ctx.fillRect(0, 0, w, w);
    ctx.fillStyle = PX.gold;
    ctx.fillRect(w * 0.06, w * 0.06, w * 0.88, w * 0.88);
    ctx.fillStyle = '#2a2e55';
    ctx.fillRect(w * 0.1, w * 0.1, w * 0.8, w * 0.8);
    ctx.fillStyle = PX.gold;
    ctx.font = `bold ${Math.round(w * 0.4)}px ${PIXEL_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', w / 2, w / 2);
    return;
  }
  drawTileArt(ctx, game.pendingTile.kindIndex, previewRot, 0, 0, els.preview.width);
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (const canvas of [els.board, els.track]) {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    canvas.dataset.dpr = dpr;
  }
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
  // 整数のピクセルにそろえる（小数だとタイルの境目に薄い線が出る）
  view.scale = Math.floor(Math.min(canvas.width / w, canvas.height / h, 96 * dpr));
  view.ox = Math.round((canvas.width - w * view.scale) / 2 - x0 * view.scale);
  view.oy = Math.round((canvas.height - h * view.scale) / 2 - y0 * view.scale);
}

function meepleInfoForRender() {
  // 置いた駒を、置いたタイルの上にだけ描く（tileKey -> [{anchor, player}]）
  const map = new Map();
  if (!game) return map;
  // 位置は今の見た目で出し直す（見た目を切り替えても、描いた道・草原からずれないように）
  const add = (m) => {
    const k = tileKey(m.x, m.y);
    const opt = game.meepleOptions(m.x, m.y, true).find((o) => o.key === m.key);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(opt ? { ...m, anchor: opt.anchor } : m);
  };
  // dsu.meta のキーはつねに「今生きている根」だけ（union() が古い根の meta を消すため）なので、
  // 道・都市・草原ぜんぶの根を、重複なく直接なめられる。
  for (const meta of game.dsu.meta.values()) for (const m of meta.meeples) add(m);
  for (const c of game.cloisters.values()) if (c.meeple) add(c.meeple);
  return map;
}

function drawBoard() {
  const canvas = els.board;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = PX.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  fitView();

  const meeples = meepleInfoForRender();
  for (const [key, tile] of game.board) {
    const [x, y] = key.split(',').map(Number);
    const size = view.scale;
    const px = view.ox + x * size;
    const py = view.oy + y * size;
    if (px + size < 0 || py + size < 0 || px > canvas.width || py > canvas.height) continue;
    drawTileArt(ctx, tile.kindIndex, tile.rot, px, py, size, { meeples: meeples.get(key) });
  }

  // 最後の採点の演出中: 今数えている対象だけ目立たせ、ほかは暗くする
  if (reveal) {
    const size = view.scale;
    const dpr = Number(canvas.dataset.dpr || 1);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    for (const key of game.board.keys()) {
      if (reveal.tiles.has(key) || reveal.cityTiles.has(key)) continue;
      const [x, y] = key.split(',').map(Number);
      ctx.fillRect(view.ox + x * size, view.oy + y * size, size, size);
    }
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = PX.gold;
    for (const key of reveal.tiles) {
      const [x, y] = key.split(',').map(Number);
      const px = view.ox + x * size, py = view.oy + y * size;
      ctx.strokeRect(px + 1.5, py + 1.5, size - 3, size - 3);
    }
    ctx.strokeStyle = '#4f8ef7';
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    for (const key of reveal.cityTiles) {
      if (reveal.tiles.has(key)) continue;
      const [x, y] = key.split(',').map(Number);
      const px = view.ox + x * size, py = view.oy + y * size;
      ctx.strokeRect(px + 1.5, py + 1.5, size - 3, size - 3);
    }
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
  }

  // 置ける場所のハイライト
  if (game.pendingTile && !game.pendingOptions && drawn) {
    const seen = new Set();
    const cells = [0, 1, 2, 3].flatMap((r) => game.currentValidCells(r))
      .filter(([x, y]) => !seen.has(x + ',' + y) && seen.add(x + ',' + y));
    const dpr = Number(canvas.dataset.dpr || 1);
    // 点線の正方形で示す
    ctx.strokeStyle = PX.gold;
    ctx.lineWidth = 2 * dpr;
    ctx.setLineDash([4 * dpr, 4 * dpr]);
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
    for (const opt of options) {
      const ax = px + opt.anchor[0] * size, ay = py + opt.anchor[1] * size;
      // ふちつきの四角い点
      const r = Math.round(Math.max(3, size * 0.045));
      ctx.fillStyle = PX.ink;
      ctx.fillRect(Math.round(ax) - r - 2, Math.round(ay) - r - 2, 2 * r + 4, 2 * r + 4);
      ctx.fillStyle = PLAYER_COLORS[game.currentPlayer];
      ctx.fillRect(Math.round(ax) - r, Math.round(ay) - r, 2 * r, 2 * r);
    }
  }
}

// ---- 入力（盤は自動で全体が入るので、タップだけ） ----
els.board.addEventListener('click', (e) => {
  if (!game || locked()) return;
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
      if (best && bestD < 0.12) commitMeeple(x, y, best); // 点のすぐ近くを押したときだけ
    }
    return;
  }

  if (game.pendingTile && drawn) {
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
  if (!game || !game.pendingTile || game.pendingOptions || !drawn) return;
  previewRot = ghost ? nextValidRot(ghost.x, ghost.y, previewRot + 1) : (previewRot + 1) % 4;
  renderAll();
}

const PLAYER_NAMES = ['赤', '青', '緑', '黄', '紫'];
const TYPE_LABEL = { city: '都市', road: '道', cloister: '修道院', field: '草原' };
const playerNames = (list) => list.map((i) => PLAYER_NAMES[i]).join('・');

// 1件ぶんの得点(players に points 点)を、得点ボードの駒が1マスずつ進むように見せる。
// 1マスあたり 80〜120ms ほど。点が多いときは全体が長くなりすぎないよう1マスを縮める。
// 「とばす」が押されたら、その場で残りを一気に足して終わる。再生中・reduced-motion なら最初から一気に足す。
function stepDelayFor(points) {
  const base = 100, budgetMs = 1200;
  return Math.max(30, Math.min(base, budgetMs / Math.max(points, 1)));
}
async function animateScoreStep(players, points) {
  if (!players.length || points <= 0) return;
  const targets = players.map((p) => displayScore[p] + points);
  if (!(reducedMotion || replaying)) {
    const ms = stepDelayFor(points);
    for (let step = 0; step < points; step++) {
      if (revealSkip) break;
      for (const p of players) displayScore[p]++;
      soundStep();
      renderScoreArea();
      await wait(ms);
    }
  }
  players.forEach((p, i) => { displayScore[p] = targets[i]; }); // ずれなく、とばしたときも必ず合わせる
  renderScoreArea();
}

// 手番中の完成(道・都市・修道院)を、駒の歩みで1件ずつ見せる（複数同時完成なら順番に）
async function animateTurnEvents(events) {
  if (!events.length) return;
  animating = true;
  renderAll();
  for (const e of events) await animateScoreStep(e.players, e.points);
  animating = false;
  renderAll();
}

// 何をどう数えたか（最後の採点の1件ぶん）を文字にする
function revealText(e) {
  const who = playerNames(e.players);
  if (e.type === 'city') return `${who} 未完成の都市: タイル${e.detail.tileCount}枚 + 紋章${e.detail.pennants} = ${e.points}点`;
  if (e.type === 'road') return `${who} 未完成の道: タイル${e.detail.tileCount}枚 = ${e.points}点`;
  if (e.type === 'cloister') return `${who} 修道院: 自分1 + 周り${e.detail.neighborCount}枚 = ${e.points}点`;
  if (e.type === 'field') return `${who} 草原: 完成した都市${e.detail.cityCount}つ × 3 = ${e.points}点`;
  return `${who} +${e.points}点`;
}

// 山札が尽きたあとの最後の採点を、1件（1つの道・都市・修道院・草原）ずつ、盤面のハイライトと文字と
// 駒の歩みで見せる。1件ごとに「次へ」を待つ（「自動で進める」なら待たない）。
// 「とばす」が押されたら残りを一気に足して終わる。
function waitRevealNext() {
  if (revealAuto || revealSkip) return Promise.resolve();
  els.revealNextBtn.hidden = false;
  return new Promise((resolve) => { revealNext = resolve; });
}
function resolveRevealNext() {
  els.revealNextBtn.hidden = true;
  const r = revealNext;
  revealNext = null;
  if (r) r();
}
async function revealFinalScoring(events) {
  if (!events.length) return;
  animating = true;
  revealSkip = false;
  revealAuto = false;
  els.revealSkipBtn.hidden = false;
  els.revealAutoBtn.hidden = false;
  for (const e of events) {
    if (revealSkip) {
      const targets = e.players.map((p) => displayScore[p] + e.points);
      e.players.forEach((p, i) => { displayScore[p] = targets[i]; });
      continue;
    }
    reveal = {
      tiles: new Set(e.tiles.map(([x, y]) => tileKey(x, y))),
      cityTiles: new Set((e.cityTiles || []).map(([x, y]) => tileKey(x, y))),
    };
    notice = revealText(e);
    renderAll();
    await animateScoreStep(e.players, e.points);
    await waitRevealNext(); // 最後の1件のあとも待つので、結果画面の前に盤面を見られる
  }
  reveal = null;
  els.revealSkipBtn.hidden = true;
  els.revealAutoBtn.hidden = true;
  els.revealNextBtn.hidden = true;
  animating = false;
  notice = '';
}
const MSG_PLACE = '点線のマスをタップ（もう一度タップで回る）→「ここに置く」';
const MSG_MEEPLE = '駒を置く点をタップ（置かないなら「駒を置かない」）';
const MSG_DRAW = '「タイルを引く」を押してください';
let drawn = false; // この手番のタイルを引いたか（引くまでは絵を伏せる）
let notice = '';   // 前の手番で入った点の知らせ

function commitPlacement(x, y, rot) {
  const kindIndex = game.pendingTile.kindIndex;
  game.placeTileOnBoard(x, y, rot, kindIndex);
  soundPlace();
  ghost = null;
  const canPlaceMeeple = game.players[game.currentPlayer].meeples > 0;
  const options = canPlaceMeeple ? game.meepleOptions(x, y) : [];
  game.pendingTile = null;
  game.log.push({ kindIndex, x, y, rot, meepleKey: null, pending: true });
  if (options.length) {
    game.pendingOptions = { x, y, options };
    game.message = MSG_MEEPLE;
    saveGame(); // 駒を決める前に再読み込みしても、この手から続けられる
    renderAll();
  } else {
    finishTurn();
  }
}

function commitMeeple(x, y, option) {
  game.placeMeeple(x, y, option);
  soundMeeple();
  game.log[game.log.length - 1].meepleKey = option.key;
  finishTurn();
}

function skipMeeple() {
  if (!game.pendingOptions) return;
  finishTurn();
}

async function finishTurn() {
  const entry = game.log[game.log.length - 1];
  delete entry.pending;
  game.pendingOptions = null;
  game.events = [];
  game.scoreAround(entry.x, entry.y);
  const turnEvents = game.events;
  game.events = [];
  if (turnEvents.length) {
    notice = turnEvents.map((e) => `${playerNames(e.players)} +${e.points}点（${TYPE_LABEL[e.type]}が完成）`).join('\n');
    await animateTurnEvents(turnEvents);
  } else {
    notice = '';
  }
  game.currentPlayer = (game.currentPlayer + 1) % game.playerCount;
  game.drawNext();
  previewRot = game.pendingTile ? game.pendingTile.rot : 0;
  drawn = false;
  if (!game.pendingTile && game.gameOver) {
    const finalEvents = game.events;
    game.events = [];
    saveGame();
    await revealFinalScoring(finalEvents);
    showResultScreen();
    return;
  }
  game.message = MSG_DRAW;
  saveGame();
  renderAll();
  scheduleCpuTurn();
}

// 戻る: 仮置きを消す → 置いたタイルを手に戻す → 前の人の駒を決める前に戻す、の順に 1 段ずつ
function undo() {
  if (!game || game.gameOver || animating) return;
  clearCpuTimer(); // CPU が手を進めている途中でも、まずそこで止める
  if (ghost) { ghost = null; renderAll(); scheduleCpuTurn(); return; }
  const log = game.log.map((e) => ({ ...e }));
  if (!log.length) return;
  const last = log[log.length - 1];
  if (last.pending) log.pop();
  else { last.meepleKey = null; last.pending = true; }
  game = rebuildFromSave({ playerCount: game.playerCount, deckOrder: game.deckOrder, log });
  syncDisplayScore(); // 戻るときは演出なしですぐ合わせる
  previewRot = game.pendingTile ? game.pendingTile.rot : 0;
  drawn = !!game.pendingTile; // 手に戻したタイルは引いたまま
  if (game.pendingTile) game.message = MSG_PLACE;
  notice = '';
  saveGame();
  renderAll();
  scheduleCpuTurn();
}

els.rotateBtn.addEventListener('click', () => { if (!locked()) rotatePending(); });
els.preview.addEventListener('click', () => { if (!locked()) rotatePending(); });
els.placeBtn.addEventListener('click', () => {
  if (locked()) return;
  if (ghost && game.pendingTile) commitPlacement(ghost.x, ghost.y, previewRot);
});
els.skipBtn.addEventListener('click', () => { if (!locked()) skipMeeple(); });
els.undoBtn.addEventListener('click', undo);
els.drawBtn.addEventListener('click', () => {
  if (!game || !game.pendingTile || drawn || locked()) return;
  drawn = true;
  game.message = MSG_PLACE;
  soundPlace();
  renderAll();
});
els.revealSkipBtn.addEventListener('click', () => { revealSkip = true; resolveRevealNext(); });
els.revealNextBtn.addEventListener('click', resolveRevealNext);
els.revealAutoBtn.addEventListener('click', () => {
  revealAuto = true;
  els.revealAutoBtn.hidden = true;
  resolveRevealNext();
});
document.getElementById('rulesBtn').addEventListener('click', () => document.getElementById('rulesDialog').showModal());
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
  clearCpuTimer();
  try { localStorage.removeItem(STORE + 'game'); } catch { /* noop */ }
  els.result.hidden = true;
  els.setup.hidden = false;
  ghost = null;
});

// ---- 人数・席（人/CPU）選び ----
let pendingCount = null;
let pendingRoles = [];
function renderRolesPicker() {
  els.roles.replaceChildren(...pendingRoles.map((role, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.i = String(i);
    btn.textContent = `${PLAYER_NAMES[i]}: ${role === 'cpu' ? 'CPU' : '人'}`;
    return btn;
  }));
  els.roles.hidden = false;
  els.startBtn.hidden = false;
}
els.playercount.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-n]');
  if (!btn) return;
  pendingCount = Number(btn.dataset.n);
  pendingRoles = normalizeRoles(load('roles', []), pendingCount);
  renderRolesPicker();
});
els.roles.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-i]');
  if (!btn) return;
  const i = Number(btn.dataset.i);
  pendingRoles[i] = pendingRoles[i] === 'cpu' ? 'human' : 'cpu';
  save('roles', pendingRoles);
  renderRolesPicker();
});
els.startBtn.addEventListener('click', () => {
  if (pendingCount == null) return;
  startNewGame(pendingCount, pendingRoles);
});

// ---- 観戦（全員 CPU）の速さ・一時停止・設定に戻る ----
els.spectateBar.addEventListener('click', (e) => {
  const speedBtn = e.target.closest('button[data-speed]');
  if (speedBtn) {
    spectateSpeed = speedBtn.dataset.speed;
    save('spectateSpeed', spectateSpeed);
    renderAll();
    return;
  }
  if (e.target === els.pauseBtn) {
    spectatePaused = !spectatePaused;
    if (spectatePaused) clearCpuTimer(); else scheduleCpuTurn();
    renderAll();
    return;
  }
  if (e.target === els.backToSetupBtn) {
    clearCpuTimer();
    saveGame();
    els.game.hidden = true;
    els.setup.hidden = false;
    els.continueBtn.hidden = false;
  }
});

window.addEventListener('resize', () => { if (!els.game.hidden) { resizeCanvas(); drawTrack(); drawBoard(); } });

// ---- つづきから（起動時に保存があれば出す。観戦を「設定に戻る」で抜けたときも同じボタンで戻れる） ----
function continueSavedGame() {
  const saved = load('game', null);
  if (!saved || !saved.log || saved.v !== SAVE_VERSION) return;
  els.continueBtn.hidden = true; // 一度使ったら古い保存を指したままにしない
  gameRoles = normalizeRoles(load('roles', []), saved.playerCount);
  game = rebuildFromSave(saved);
  syncDisplayScore();
  previewRot = game.pendingTile ? game.pendingTile.rot : 0;
  drawn = false;
  notice = '';
  if (game.pendingTile) game.message = MSG_DRAW;
  showGameScreen();
  renderAll();
  if (game.pendingTile == null && game.gameOver) showResultScreen();
  else scheduleCpuTurn();
}
els.continueBtn.addEventListener('click', continueSavedGame);

(function boot() {
  const saved = load('game', null);
  if (saved && saved.log && saved.v === SAVE_VERSION) els.continueBtn.hidden = false;
})();
