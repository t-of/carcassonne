// ドット絵のタイル（32×32 の升目）。タイルの種類（辺・都市・道・修道院）と向きから組み立てる。
// 絵ごとまわすと家が横倒しになるので、向きごとに描き分ける
(function (g) {
  const N = 32;
  const PALETTE = [
    '#5c9c3a', '#3f7a2e', '#7fbf4a', '#f2d45c', '#f4f0e0', // 0 草 1 草の影 2 草の明 3 黄花 4 白花
    '#d2a86a', '#8e6436', '#ead2a0',                       // 5 道 6 道のふち 7 小石
    '#e2d3a8', '#b8a57a', '#5a4a38',                       // 8 壁 9 壁の影 10 壁のふち
    '#c8503c', '#8a3028', '#e6785a',                       // 11 屋根 12 屋根の影 13 屋根の明
    '#a89880', '#857560',                                  // 14 石畳 15 石畳の影
    '#3a5cc8', '#f4f0e0', '#2a2018', '#3a2a20',            // 16 紋章 17 紋章の十字 18 ふち 19 戸・窓
    '#2e5e28', '#3f8a34', '#6a4a2a',                       // 20 木の影 21 木 22 幹
    '#efe8d8', '#5a6a8a', '#3e4a66', '#8494b4', '#e8b83a', // 23 白壁 24 青屋根 25 青屋根の影 26 青屋根の明 27 金
  ];
  const GRASS = 0, GRASS_D = 1, GRASS_L = 2, ROAD = 5, ROAD_E = 6, PEBBLE = 7;
  const WALL = 8, WALL_S = 9, WALL_O = 10, COBBLE = 14, COBBLE_D = 15, GATE = 19;
  const ROOFS = [[13, 11, 12], [26, 24, 25]]; // 明・中・影

  function hash(x, y, s) {
    let n = (x * 374761393 + y * 668265263 + s * 982451653) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  }
  // 辺の中央に向かってふくらむ弓形の深さ（t は辺に沿った位置 0..32）
  const cap = (t, depth, end) => end + (depth - end) * (1 - ((t - 16) / 16) ** 2) ** 2;
  // 点を反時計回りに k 回まわす（北向きの形で調べるため）
  function unrotate(x, y, k) {
    for (let i = 0; i < k; i++) [x, y] = [y, N - x];
    return [x, y];
  }
  // 都市の形。北（と東・南）を基準にした形を k 回まわして使う
  function cityTest(edges) {
    const s = [...edges].sort();
    let k = 0, f;
    if (s.length === 1) { k = s[0]; f = (x, y) => y < cap(x, 12, 3); }
    else if (s.length === 2 && (s[1] - s[0]) % 2 === 1) {
      k = s.includes((s[0] + 1) % 4) && !(s[0] === 0 && s[1] === 3) ? s[0] : 3;
      f = (x, y) => x - y > -4 * (1 - ((x + y - 32) / 32) ** 2);
    } else if (s.length === 2) { k = s[0]; f = (x, y) => x >= cap(y, 9, 2) && N - x >= cap(y, 9, 2); }
    else if (s.length === 3) { k = ([0, 1, 2, 3].find((d) => !s.includes(d)) + 1) % 4; f = (x, y) => x >= cap(y, 11, 3); }
    else f = () => true;
    return (x, y) => { const [ux, uy] = unrotate(x, y, k); return f(ux, uy); };
  }
  const MID = [[16, 0], [32, 16], [16, 32], [0, 16]];
  const CORNER = [[32, 0], [32, 32], [0, 32], [0, 0]]; // 辺 d と d+1 の間の角
  function segDist(x, y, [ax, ay], [bx, by]) {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - ax - t * dx, y - ay - t * dy);
  }
  // 道の中心線からの距離
  function roadDist(edges) {
    if (edges.length === 1) return (x, y) => segDist(x, y, MID[edges[0]], [16, 16]);
    const [a, b] = edges;
    if ((a + 2) % 4 === b) return (x, y) => segDist(x, y, MID[a], MID[b]);
    const c = CORNER[(a + 1) % 4 === b ? a : b];
    return (x, y) => Math.abs(Math.hypot(x - c[0], y - c[1]) - 16);
  }

  const SPRITES = {
    // . 透明  O ふち  W 白壁  S 壁の影  l/R/r 青屋根 明・中・影  D 戸  G 金
    chapel: [
      '......GG......',
      '.....GGGG.....',
      '......GG......',
      '.....OllO.....',
      '....OlRRrO....',
      '....OWDDSO....',
      '....OWWWSO....',
      '.OOOOWWWSOOOO.',
      'OllllllRRRRRrO',
      'OlRRRRRRRRRRrO',
      'OrrrrrrrrrrrrO',
      'OWWDWWWWWWDWSO',
      'OWWWWWDDWWWWSO',
      'OWWWWDDDDWWWSO',
      'OSSSSDDDDSSSSO',
      '.OOOOOOOOOOOO.',
    ],
    house: [
      '.OOOOOO.',
      'OllllllO',
      'OlRRRRrO',
      'OrrrrrrO',
      'OWDWWDSO',
      'OWWDDWSO',
      'OSSDDSSO',
      '.OOOOOO.',
    ],
    cottage: [
      '.OOOO.',
      'OlRRrO',
      'OrrrrO',
      'OWDDSO',
      '.OOOO.',
    ],
    shield: [
      'OOOOOOO',
      'OBBWBBO',
      'OBBWBBO',
      'OWWWWWO',
      'OBBWBBO',
      '.OBWBO.',
      '..OBO..',
      '...O...',
    ],
    tree: [
      '.OOO.',
      'OTLTO',
      'OLTTO',
      'OTTDO',
      '.OKO.',
      '..K..',
    ],
  };
  const SPRITE_COLORS = {
    chapel: { O: 18, W: 23, S: 9, l: 26, R: 24, r: 25, D: 19, G: 27 },
    house: { O: 18, W: 8, S: 9, l: 13, R: 11, r: 12, D: 19 },
    cottage: { O: 18, W: 8, S: 9, l: 13, R: 11, r: 12, D: 19 },
    shield: { O: 18, B: 16, W: 17 },
    tree: { O: 20, T: 21, L: 2, D: 20, K: 22 },
  };
  function stamp(px, name, ox, oy, colors = SPRITE_COLORS[name]) {
    SPRITES[name].forEach((row, y) => [...row].forEach((ch, x) => {
      const X = ox + x, Y = oy + y;
      if (ch !== '.' && X >= 0 && Y >= 0 && X < N && Y < N) px[Y * N + X] = colors[ch];
    }));
  }

  // kind: main.js の TILE_KINDS の 1 つ、rot: 時計回りに 90° × rot。seed で草や木の並びを変える
  function build(kind, rot = 0, seed = 0) {
    const turn = (gr) => gr.edges.map((e) => (e + rot) % 4);
    const px = new Uint8Array(N * N);
    const city = new Int8Array(N * N).fill(-1);
    const tests = kind.cityGroups.map((gr) => cityTest(turn(gr)));
    // ふちから RING 升の帯は形によらず、いちばん近い辺が都市かどうかだけで決め、となりのタイルとずれないようにする。
    // 角は斜めに分かれ、都市の辺が 4 枚集まっても穴があかない。同じ近さなら北・南の辺を優先。帯の外は undefined
    const groupOf = [-1, -1, -1, -1];
    kind.cityGroups.forEach((gr, gi) => turn(gr).forEach((e) => { groupOf[e] = gi; }));
    const RING = 3;
    const ringCity = (x, y) => {
      const d = [y, N - 1 - x, N - 1 - y, x], m = Math.min(...d);
      if (m >= RING) return undefined;
      const e = d[0] === m ? 0 : d[2] === m ? 2 : d.indexOf(m);
      return groupOf[e];
    };
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const r = ringCity(x, y);
      if (r !== undefined) { city[y * N + x] = r; continue; }
      const hits = tests.map((t, i) => (t(x + 0.5, y + 0.5) ? i : -1)).filter((i) => i >= 0);
      if (hits.length === 1) city[y * N + x] = hits[0];
    }
    // 別の都市どうしが接するところは草原にしてすき間をあける
    const sep = city.slice();
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const c = city[y * N + x];
      if (c < 0 || x === 0 || y === 0 || x === N - 1 || y === N - 1) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Y = y + dy;
        if (X >= 0 && Y >= 0 && X < N && Y < N && city[Y * N + X] >= 0 && city[Y * N + X] !== c) sep[y * N + x] = -1;
      }
    }
    city.set(sep);
    // 城壁からの距離（1 = ふち、2〜3 = 壁、4〜 = 中）。タイルの外は、またぐ辺が都市なら都市が続くとみなす
    const layer = new Uint8Array(N * N);
    let frontier = [];
    for (let i = 0; i < N * N; i++) {
      if (city[i] < 0) continue;
      const x = i % N, y = (i / N) | 0;
      const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const X = x + dx, Y = y + dy;
        if (Y < 0) return groupOf[0] < 0;
        if (X >= N) return groupOf[1] < 0;
        if (Y >= N) return groupOf[2] < 0;
        if (X < 0) return groupOf[3] < 0;
        return city[Y * N + X] < 0;
      });
      if (edge) { layer[i] = 1; frontier.push(i); }
    }
    for (let l = 2; frontier.length; l++) {
      const next = [];
      for (const i of frontier) {
        const x = i % N, y = (i / N) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const X = x + dx, Y = y + dy, j = Y * N + X;
          if (X >= 0 && Y >= 0 && X < N && Y < N && city[j] >= 0 && !layer[j]) { layer[j] = l; next.push(j); }
        }
      }
      frontier = next;
    }
    for (let i = 0; i < N * N; i++) if (city[i] >= 0 && !layer[i]) layer[i] = 99; // 壁のない都市（四方が都市）

    const roads = kind.roadGroups.map((gr) => roadDist(turn(gr)));
    const rd = (x, y) => Math.min(99, ...roads.map((f) => f(x + 0.5, y + 0.5)));
    const plain = new Uint8Array(N * N); // 木を置いてよい草原

    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x, h = hash(x, y, seed), d = rd(x, y);
      if (city[i] >= 0) {
        const l = layer[i];
        if (l <= 3 && d < 1.6) px[i] = GATE;
        else if (l === 1) px[i] = WALL_O;
        else if (l === 2 || l === 3) px[i] = WALL;
        else if (l === 4) px[i] = WALL_S;
        else px[i] = h < 0.25 ? COBBLE_D : COBBLE;
        continue;
      }
      if (d < 1.6) px[i] = h < 0.08 ? PEBBLE : ROAD;
      else if (d < 2.6) px[i] = h < 0.25 ? GRASS_D : ROAD_E;
      else {
        // 胸壁（城壁の外側に 2 升おきの出っぱり）と、右下に落ちる影
        const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const X = x + dx, Y = y + dy; return X >= 0 && Y >= 0 && X < N && Y < N && city[Y * N + X] >= 0; });
        const up = y > 0 && city[i - N] >= 0, left = x > 0 && city[i - 1] >= 0;
        if (nb && (x + y) % 4 < 2 && ringCity(x, y) === undefined) px[i] = WALL_O;
        else if (up || left) px[i] = GRASS_D;
        else {
          px[i] = h < 0.07 ? GRASS_L : h < 0.12 ? GRASS_D : h > 0.993 ? 3 : h > 0.987 ? 4 : GRASS;
          if (d > 4) plain[i] = 1;
        }
      }
    }

    // 家並み: 都市の広さに合わせた軒数を、紋章・ほかの家・城壁からいちばん離れたところへ順に建てる
    const used = new Uint8Array(N * N);
    const mark = (x, y, w, h) => {
      for (let yy = Math.max(0, y - 1); yy < Math.min(N, y + h + 1); yy++) used.fill(1, yy * N + Math.max(0, x - 1), yy * N + Math.min(N, x + w + 1));
    };
    const fits = (gi, ox, oy, w, h) => {
      for (let y = oy; y < oy + h; y++) for (let x = ox; x < ox + w; x++) {
        const i = y * N + x;
        if (x >= N || y >= N || city[i] !== gi || layer[i] < 4 || used[i] || rd(x, y) < 2.6 || ringCity(x, y) !== undefined) return false;
      }
      return true;
    };
    kind.cityGroups.forEach((gr, gi) => {
      let area = 0, sx = 0, sy = 0;
      for (let i = 0; i < N * N; i++) if (city[i] === gi && layer[i] >= 4) { area++; sx += i % N; sy += (i / N) | 0; }
      if (!area) return;
      const cx = sx / area + 0.5, cy = sy / area + 0.5, pts = [];
      if (gr.pennant) {
        const x0 = Math.round(cx) - 4, y0 = Math.round(cy) - 4;
        stamp(px, 'shield', x0, y0);
        mark(x0, y0, 7, 8);
        pts.push([cx, cy]);
      }
      const want = Math.max(1, Math.round(area / 150));
      for (let k = 0; k < want; k++) {
        let best = null;
        for (const [name, w, h, bonus] of [['house', 8, 8, 2], ['cottage', 6, 5, 0]]) {
          for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
            if (!fits(gi, x, y, w, h)) continue;
            const mx = x + w / 2, my = y + h / 2;
            const wall = 2 * Math.min(layer[Math.floor(my) * N + Math.floor(mx)], 12);
            const score = bonus + (pts.length
              ? Math.min(wall, ...pts.map(([qx, qy]) => Math.hypot(qx - mx, qy - my)))
              : -Math.hypot(cx - mx, cy - my));
            if (!best || score > best.score) best = { name, x, y, w, h, mx, my, score };
          }
        }
        if (!best) break;
        const [l, R, r] = ROOFS[hash(best.x, best.y, seed + 7) < 0.7 ? 0 : 1];
        stamp(px, best.name, best.x, best.y, { ...SPRITE_COLORS.house, l, R, r });
        mark(best.x, best.y, best.w, best.h);
        pts.push([best.mx, best.my]);
      }
    });
    // 道の交わるところ・修道院
    if (kind.roadGroups.length >= 2) stamp(px, 'house', 12, 12);
    if (kind.cloister) stamp(px, 'chapel', 9, 7);
    // 木: 道・都市・建物から離れた草原に 3 本まで
    const busy = (x, y) => x < 0 || y < 0 || x >= N || y >= N || !plain[y * N + x]
      || (kind.cloister && x >= 7 && x <= 24 && y >= 5 && y <= 24)
      || (kind.roadGroups.length >= 2 && x >= 10 && x <= 21 && y >= 10 && y <= 21);
    const spots = [];
    for (let y = 0; y < N - 5; y++) for (let x = 0; x < N - 4; x++) spots.push([hash(x, y, seed + 3), x, y]);
    spots.sort((a, b) => a[0] - b[0]);
    const trees = [];
    for (const [, x, y] of spots) {
      if (trees.length >= 3) break;
      let ok = true;
      for (let yy = y - 1; yy < y + 7 && ok; yy++) for (let xx = x - 1; xx < x + 6 && ok; xx++) ok = !busy(xx, yy);
      if (ok && trees.every(([tx, ty]) => Math.abs(tx - x) > 6 || Math.abs(ty - y) > 7)) trees.push([x, y]);
    }
    trees.forEach(([x, y]) => stamp(px, 'tree', x, y));
    return px;
  }

  g.PixelTiles = { N, PALETTE, build };
})(typeof window !== 'undefined' ? window : globalThis);
