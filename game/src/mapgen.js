// Процедурная генерация карты: степь, поля с лесополосами, река, балка,
// трасса, железная дорога, город и сёла. Всё детерминировано по seed.

import { Rng, fbm } from './rng.js';
import {
  bboxOf, catmullRom, resample, offsetLine, tangents, pointInPoly,
  distToLine, rectCorners, blob, dist,
} from './geom.js';
import { SpatialIndex, PointBins, Mask, M } from './spatial.js';

export const WORLD_W = 6000;
export const WORLD_H = 4000;

const CITY_NAMES = ['Верхнеозёрск', 'Степногорск', 'Краснолиманск', 'Заречанск'];
const VILLAGE_NAMES = ['Сосновка', 'Дубровное', 'Каменный Брод', 'Весёлое', 'Лозовая', 'Старая Балка', 'Приволье'];

// Типы культур на полях (цвет — спутниковый вид конца лета)
export const CROPS = {
  wheat:     { color: '#c4ab72', furrow: 'rgba(120,95,50,0.20)', tram: true },
  stubble:   { color: '#cdbd8e', furrow: 'rgba(140,120,70,0.22)', tram: true },
  plowed:    { color: '#6f5a43', furrow: 'rgba(40,28,18,0.35)', tram: false },
  harrowed:  { color: '#85705a', furrow: 'rgba(60,45,30,0.22)', tram: false },
  sunflower: { color: '#5d6532', furrow: 'rgba(30,35,10,0.35)', tram: true, dots: '#a39030' },
  corn:      { color: '#56703a', furrow: 'rgba(25,40,15,0.35)', tram: true },
  fallow:    { color: '#858550', furrow: null, tram: false },
  meadow:    { color: '#707c46', furrow: null, tram: false },
};

export function generateWorld(seed) {
  const t0 = performance.now();
  const rng = new Rng(seed);
  const W = WORLD_W, H = WORLD_H;
  const world = {
    seed, W, H,
    mask: new Mask(W, H, 4),
    fields: new SpatialIndex(W, H),
    areas: new SpatialIndex(W, H),
    water: new SpatialIndex(W, H),
    roads: new SpatialIndex(W, H),
    rails: new SpatialIndex(W, H),
    buildings: new SpatialIndex(W, H, 128),
    belts: new SpatialIndex(W, H),
    scars: new SpatialIndex(W, H, 128),
    trees: new PointBins(W, H, 128, 4), // x, y, радиус, оттенок
    settlements: [],
    roadList: [],
  };
  const mask = world.mask;

  // ---------- Ключевые точки ----------
  const cityC = [W * 0.52 + rng.float(-150, 150), H * 0.52 + rng.float(-120, 120)];
  const villageSpots = [
    [W * 0.15, H * 0.2], [W * 0.18, H * 0.78], [W * 0.84, H * 0.72], [W * 0.82, H * 0.14],
  ].map(([x, y]) => [x + rng.float(-200, 200), y + rng.float(-150, 150)]);

  // ---------- Река ----------
  const riverLine = [];
  {
    const xTop = cityC[0] - 450 + rng.float(-200, 100);
    const xBot = cityC[0] + 200 + rng.float(-100, 250);
    const ph = rng.float(0, 6.28);
    for (let y = -150; y <= H + 150; y += 60) {
      const t = y / H;
      const x = xTop + (xBot - xTop) * t + Math.sin(y / 520 + ph) * 170 + (fbm(y / 900, 3.3, seed + 7) - 0.5) * 420;
      riverLine.push([x, y]);
    }
  }
  const river = resample(catmullRom(riverLine, 6), 12);
  const riverW = 34;
  addItem(world.water, { kind: 'river', line: river, width: riverW }, riverW + 200);
  mask.stampLine(river, riverW + 8, M.WATER);
  // Пойменный луг вдоль реки
  addItem(world.areas, { kind: 'floodplain', line: river, width: 260 }, 140);

  // ---------- Город: пятно застройки ----------
  const cityPoly = blob(cityC[0], cityC[1], 820, 600, rng.float(-0.3, 0.3), rng, 64, 0.2);
  world.settlements.push({ name: rng.pick(CITY_NAMES), x: cityC[0], y: cityC[1], type: 'city' });

  // ---------- Трасса (обходит город с севера) ----------
  const hwY = cityC[1] - 780;
  const highwayCtrl = [];
  for (let i = 0; i <= 8; i++) {
    const x = -200 + (i / 8) * (W + 400);
    const bend = Math.exp(-(((x - cityC[0]) / 1500) ** 2)) * -120;
    highwayCtrl.push([x, hwY + bend + rng.float(-90, 90) + (i / 8 - 0.5) * 300]);
  }
  const highway = resample(catmullRom(highwayCtrl, 10), 10);
  addRoad(world, highway, 'highway');

  // ---------- Железная дорога (через город, южнее центра) ----------
  const railCtrl = [
    [-200, H * 0.72 + rng.float(-150, 150)],
    [W * 0.25, H * 0.68 + rng.float(-100, 100)],
    [cityC[0] - 300, cityC[1] + 280],
    [cityC[0] + 400, cityC[1] + 230],
    [W * 0.78, H * 0.55 + rng.float(-100, 100)],
    [W + 200, H * 0.5 + rng.float(-150, 150)],
  ];
  const rail = resample(catmullRom(railCtrl, 12), 8);
  addItem(world.rails, { kind: 'rail', line: rail, width: 10 }, 20);
  mask.stampLine(rail, 16, M.RAIL);

  // ---------- Балка с прудом ----------
  buildBalka(world, rng, river, cityC);

  // ---------- Сёла: главная улица + дороги к городу ----------
  const villages = villageSpots.map((c, i) => {
    const angle = rng.float(0, Math.PI);
    const len = rng.float(900, 1400);
    const dir = [Math.cos(angle), Math.sin(angle)];
    const ctrl = [];
    for (let k = -2; k <= 2; k++) {
      const s = (k / 2) * (len / 2);
      ctrl.push([c[0] + dir[0] * s + rng.float(-40, 40) * -dir[1], c[1] + dir[1] * s + rng.float(-40, 40) * dir[0]]);
    }
    const street = resample(catmullRom(ctrl, 8), 8);
    addVillageGround(world, street);
    world.settlements.push({ name: VILLAGE_NAMES[(i + seed) % VILLAGE_NAMES.length], x: c[0], y: c[1], type: 'village' });
    return { c, street, angle };
  });

  // Дороги из сёл к городу и к трассе (асфальт)
  for (const v of villages) {
    const target = rng.chance(0.5) || Math.abs(v.c[1] - hwY) > 1200 ? cityEntry(cityPoly, cityC, v.c) : nearestPoint(highway, v.c);
    addRoad(world, wobblyRoad(rng, v.c, target, 3), 'local');
  }
  // Дорога между южными сёлами
  addRoad(world, wobblyRoad(rng, villages[1].c, villages[2].c, 4), 'local');

  for (const v of villages) addRoad(world, v.street, 'village');

  // ---------- Город ----------
  buildCity(world, rng, cityC, cityPoly, rail, river);

  // ---------- Сёла: дворы ----------
  for (const v of villages) {
    buildVillageStreet(world, rng, v.street, 1);
    // Поперечная улица
    const mid = v.street[Math.floor(v.street.length * rng.float(0.3, 0.7))];
    const a = v.angle + Math.PI / 2 + rng.float(-0.3, 0.3);
    const L = rng.float(350, 650);
    const cross = resample(catmullRom([
      [mid[0] - Math.cos(a) * L * 0.5, mid[1] - Math.sin(a) * L * 0.5],
      [mid[0] + rng.float(-20, 20), mid[1] + rng.float(-20, 20)],
      [mid[0] + Math.cos(a) * L * 0.5, mid[1] + Math.sin(a) * L * 0.5],
    ], 8), 8);
    addRoad(world, cross, 'dirt');
    addVillageGround(world, cross);
    buildVillageStreet(world, rng, cross, 0.85);
    buildFarm(world, rng, v);
  }

  // Кусты и одиночные деревья на выгонах вокруг сёл
  for (const line of world._vgroundLines) {
    for (let k = 0; k < line.length; k += 2) {
      if (!rng.chance(0.5)) continue;
      const [x0, y0] = line[k];
      const x = x0 + rng.gauss(0, 70), y = y0 + rng.gauss(0, 70);
      if (mask.has(x, y, M.ROAD | M.BUILD | M.SETTLE | M.WATER)) continue;
      const n = rng.int(1, 4);
      for (let t = 0; t < n; t++) world.trees.add(x + rng.float(-5, 5), y + rng.float(-5, 5), rng.float(1.5, 3.5), rng.int(0, 3));
    }
  }

  // ---------- Поля и лесополосы ----------
  buildFields(world, rng);

  // ---------- Ивы вдоль реки ----------
  for (let i = 0; i < river.length; i++) {
    const tg = tangents([river[Math.max(0, i - 1)], river[Math.min(river.length - 1, i + 1)]])[0];
    for (const side of [-1, 1]) {
      if (!rng.chance(0.55)) continue;
      const off = riverW / 2 + rng.float(3, 16);
      const x = river[i][0] - tg[1] * off * side + rng.float(-4, 4);
      const y = river[i][1] + tg[0] * off * side + rng.float(-4, 4);
      if (mask.has(x, y, M.ROAD | M.BUILD | M.RAIL | M.WATER)) continue;
      world.trees.add(x, y, rng.float(3, 6), rng.int(0, 3));
    }
  }

  // ---------- Следы войны: воронки и выгоревшие участки ----------
  seedWarScars(world, rng, cityC);

  world.genTime = performance.now() - t0;
  return world;
}

// ================================================================
// Вспомогательные
// ================================================================

function addItem(index, item, pad = 0) {
  item.bbox = bboxOf(item.poly || item.line || item.pts, pad);
  index.insert(item);
  return item;
}

export const ROAD_STYLE = {
  highway: { width: 26, stamp: 34 },
  local: { width: 8, stamp: 14 },
  village: { width: 6.5, stamp: 11 },
  street: { width: 10, stamp: 14 },
  avenue: { width: 16, stamp: 20 },
  dirt: { width: 4.5, stamp: 8 },
};

function addRoad(world, line, type) {
  const st = ROAD_STYLE[type];
  const road = addItem(world.roads, { kind: 'road', type, line, width: st.width }, st.width + 6);
  world.mask.stampLine(line, st.stamp, M.ROAD);
  world.roadList.push(road);
  return road;
}

// Выгон/пастбище вокруг сельских улиц — поля и посадки сюда не заходят
function addVillageGround(world, street) {
  addItem(world.areas, { kind: 'vground', line: street, width: 260 }, 160);
  world._vgroundLines = (world._vgroundLines || []).concat([street]);
  world.mask.stampLine(street, 280, M.VILLAGE);
}

function nearestPoint(line, p) {
  let best = line[0], bd = Infinity;
  for (const q of line) {
    const d = dist(p, q);
    if (d < bd) { bd = d; best = q; }
  }
  return best.slice();
}

// Точка въезда: край города в сторону села, чуть внутрь
function cityEntry(poly, C, from) {
  const e = nearestPoint(poly, from);
  const dx = C[0] - e[0], dy = C[1] - e[1];
  const L = Math.hypot(dx, dy);
  return [e[0] + (dx / L) * 60, e[1] + (dy / L) * 60];
}

function wobblyRoad(rng, a, b, n) {
  const pts = [a.slice()];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const off = rng.float(-0.08, 0.08) * L;
    pts.push([a[0] + dx * t - (dy / L) * off, a[1] + dy * t + (dx / L) * off]);
  }
  pts.push(b.slice());
  return resample(catmullRom(pts, 12), 10);
}

// ---------- Балка ----------
function buildBalka(world, rng, river, cityC) {
  const { mask } = world;
  // Точка на реке в южной или северной части, подальше от города
  const idx = Math.floor(river.length * (rng.chance(0.5) ? rng.float(0.78, 0.9) : rng.float(0.1, 0.22)));
  const start = river[idx];
  const dirX = start[0] < cityC[0] ? -1 : 1;
  const flip = rng.chance(0.5) ? 1 : -1;
  const ctrl = [start.slice()];
  let a = dirX > 0 ? 0 : Math.PI;
  let p = start.slice();
  for (let i = 0; i < 6; i++) {
    a += rng.float(-0.45, 0.45) + flip * 0.08;
    p = [p[0] + Math.cos(a) * 320, p[1] + Math.sin(a) * 320];
    ctrl.push(p);
  }
  const line = resample(catmullRom(ctrl, 8), 10);
  const widths = line.map((_, i) => 110 * (1 - i / line.length) + 45);
  addItem(world.areas, { kind: 'balka', line, widths }, 90);
  for (let i = 0; i < line.length; i++) mask.stampDisc(line[i][0], line[i][1], widths[i] * 0.5, M.BALKA);

  // Деревья по тальвегу (дну балки) — густо, с разрывами
  for (let i = 0; i < line.length; i++) {
    const w = widths[i];
    const n = rng.int(2, 6);
    if (rng.chance(0.12)) continue;
    for (let k = 0; k < n; k++) {
      const x = line[i][0] + rng.gauss(0, w * 0.18);
      const y = line[i][1] + rng.gauss(0, w * 0.18);
      if (mask.has(x, y, M.ROAD | M.WATER)) continue;
      world.trees.add(x, y, rng.float(2.5, 5.5), rng.int(0, 3));
    }
  }
  // Пруд с дамбой в середине балки
  const pi = Math.floor(line.length * rng.float(0.35, 0.55));
  const pc = line[pi];
  const tg = tangents(line)[pi];
  const pondAngle = Math.atan2(tg[1], tg[0]);
  const pond = blob(pc[0], pc[1], rng.float(110, 170), rng.float(35, 55), pondAngle, rng, 36, 0.25);
  addItem(world.water, { kind: 'pond', poly: pond }, 12);
  mask.stampPoly(pond, M.WATER);
  // Дамба — поперёк балки, с дорогой-грунтовкой
  const end = pc[0] + tg[0] * 150, endY = pc[1] + tg[1] * 150;
  const dam = [[end - tg[1] * 70, endY + tg[0] * 70], [end + tg[1] * 70, endY - tg[0] * 70]];
  addItem(world.areas, { kind: 'dam', line: dam, width: 16 }, 10);
}

// ---------- Поля и лесополосы ----------
function buildFields(world, rng) {
  const { mask, W, H } = world;
  const theta = rng.float(-0.18, 0.18);
  const c = Math.cos(theta), s = Math.sin(theta);
  const toW = (u, v) => [u * c - v * s, u * s + v * c];

  // Разметка сетки в повёрнутых координатах с запасом
  const us = [];
  for (let u = -900; u < W + 900; u += rng.float(480, 900)) us.push(u);
  const vs = [];
  for (let v = -900; v < H + 900; v += rng.float(300, 520)) vs.push(v);

  const avoid = M.SETTLE | M.CITY | M.WATER | M.BALKA | M.VILLAGE;
  const cropPairs = [
    ['wheat', 3], ['stubble', 4], ['plowed', 3], ['harrowed', 2], ['sunflower', 4], ['corn', 2], ['fallow', 1.2],
  ];

  // Грунтовки вдоль части лесополос
  const dirtLines = [];

  for (let i = 0; i + 1 < us.length; i++) {
    for (let j = 0; j + 1 < vs.length; j++) {
      const inset = 11;
      const u0 = us[i] + inset, u1 = us[i + 1] - inset, v0 = vs[j] + inset, v1 = vs[j + 1] - inset;
      const center = toW((u0 + u1) / 2, (v0 + v1) / 2);
      if (center[0] < -300 || center[1] < -300 || center[0] > W + 300 || center[1] > H + 300) continue;
      if (mask.has(center[0], center[1], M.CITY | M.VILLAGE)) continue;

      // Иногда поле делится на два без полосы
      const parts = [];
      if (rng.chance(0.3)) {
        const split = rng.float(0.35, 0.65);
        if (u1 - u0 > v1 - v0) {
          const us2 = u0 + (u1 - u0) * split;
          parts.push([u0, us2, v0, v1], [us2, u1, v0, v1]);
        } else {
          const vs2 = v0 + (v1 - v0) * split;
          parts.push([u0, u1, v0, vs2], [u0, u1, vs2, v1]);
        }
      } else parts.push([u0, u1, v0, v1]);

      for (const [a0, a1, b0, b1] of parts) {
        const poly = [toW(a0, b0), toW(a1, b0), toW(a1, b1), toW(a0, b1)];
        const crop = rng.weighted(cropPairs);
        const along = a1 - a0 > b1 - b0 ? theta : theta + Math.PI / 2;
        const field = {
          kind: 'field', poly, crop,
          angle: along + (rng.chance(0.15) ? Math.PI / 2 : 0),
          seed: rng.int(0, 1e9),
          patches: [],
        };
        // Пятна: сырые низины, другая влажность почвы
        const nP = rng.int(0, 4);
        for (let k = 0; k < nP; k++) {
          const pu = rng.float(a0, a1), pv = rng.float(b0, b1);
          const [px, py] = toW(pu, pv);
          field.patches.push({ x: px, y: py, rx: rng.float(20, 90), ry: rng.float(15, 60), a: rng.float(0, 3.14), dark: rng.chance(0.6) });
        }
        addItem(world.fields, field, 0);
      }
    }
  }

  // Лесополосы по линиям сетки: сегменты между пересечениями
  const segs = [];
  for (let i = 0; i < us.length; i++)
    for (let j = 0; j + 1 < vs.length; j++) segs.push([toW(us[i], vs[j]), toW(us[i], vs[j + 1])]);
  for (let j = 0; j < vs.length; j++)
    for (let i = 0; i + 1 < us.length; i++) segs.push([toW(us[i], vs[j]), toW(us[i + 1], vs[j])]);

  const beltSegs = [];
  for (const [a, b] of segs) {
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (mid[0] < -200 || mid[1] < -200 || mid[0] > W + 200 || mid[1] > H + 200) continue;
    // Иногда вдоль полосы идёт грунтовка
    if (rng.chance(0.22)) {
      const L = dist(a, b);
      const dx = (b[0] - a[0]) / L, dy = (b[1] - a[1]) / L;
      const side = rng.chance(0.5) ? 1 : -1;
      const off = 13 * side;
      // Грунтовка чуть выходит за перекрёсток полос, прорезая поперечную
      const line = resample([
        [a[0] - dy * off - dx * 20, a[1] + dx * off - dy * 20],
        [b[0] - dy * off + dx * 20, b[1] + dx * off + dy * 20],
      ], 10);
      // не тянем грунтовку через город и воду
      const ok = line.every(([x, y]) => !mask.has(x, y, M.CITY | M.WATER | M.BALKA | M.SETTLE | M.VILLAGE));
      if (ok) dirtLines.push(line);
    }
    if (rng.chance(0.82)) beltSegs.push([a, b]);
  }
  // Сначала дороги (чтобы в полосах остались проезды), потом деревья
  for (const line of dirtLines) addRoad(world, line, 'dirt');
  for (const [a, b] of beltSegs) segsBelt(world, rng, a, b, avoid);
}

function segsBelt(world, rng, a, b, avoid) {
  const { mask } = world;
  const L = dist(a, b);
  const dx = (b[0] - a[0]) / L, dy = (b[1] - a[1]) / L;
  const rows = rng.int(3, 5);
  const rowGap = rng.float(3.0, 3.8);
  const step = rng.float(3.6, 4.6);
  const kindShade = rng.int(0, 3);
  const pts = [];
  // Разрывы: участки без деревьев (вырубка, выгорело)
  const gaps = [];
  const nGaps = rng.int(0, 2);
  for (let k = 0; k < nGaps; k++) {
    const g0 = rng.float(0, L);
    gaps.push([g0, g0 + rng.float(15, 70)]);
  }
  for (let d = -6; d < L + 6; d += step) {
    if (gaps.some(([g0, g1]) => d > g0 && d < g1)) continue;
    for (let r = 0; r < rows; r++) {
      if (rng.chance(0.07)) continue;
      const off = (r - (rows - 1) / 2) * rowGap + rng.float(-0.9, 0.9);
      const x = a[0] + dx * (d + rng.float(-1, 1)) - dy * off;
      const y = a[1] + dy * (d + rng.float(-1, 1)) + dx * off;
      if (mask.has(x, y, avoid | M.ROAD | M.RAIL)) continue;
      // Пропуск у перекрёстков дорог
      if (mask.near(x, y, 6, M.ROAD)) continue;
      const rad = rng.float(2.4, 4.3) * (r === 0 || r === rows - 1 ? 0.92 : 1.08);
      world.trees.add(x, y, rad, (kindShade + rng.int(0, 1)) % 4);
      pts.push([x, y]);
    }
  }
  if (pts.length > 2) {
    // Упрощённая линия полосы для дальнего масштаба
    addItem(world.belts, { kind: 'belt', line: [a, b], width: rows * rowGap + 4, pts }, 12);
  }
}

// ---------- Сельская улица ----------
function buildVillageStreet(world, rng, street, density) {
  const { mask } = world;
  const tg = tangents(street);
  const roofs = [
    ['#8b4a38', 3], ['#96503b', 2], ['#7e7e79', 3], ['#6c7f86', 1.5], ['#5f7a5a', 1], ['#9a9890', 1.5], ['#7a5540', 1],
  ];
  let s = 0;
  let i = 0;
  const cum = [0];
  for (let k = 1; k < street.length; k++) cum.push(cum[k - 1] + dist(street[k - 1], street[k]));
  const total = cum[cum.length - 1];
  while (s < total - 10) {
    const plotW = rng.float(20, 28);
    s += plotW;
    while (i < street.length - 1 && cum[i + 1] < s - plotW / 2) i++;
    const p = street[i];
    const t = tg[i];
    const ang = Math.atan2(t[1], t[0]);
    for (const side of [-1, 1]) {
      if (!rng.chance(0.95 * density)) continue;
      const depth = rng.float(70, 130);
      const setback = 9;
      const nx = -t[1] * side, ny = t[0] * side;
      const cx = p[0] + nx * (setback + depth / 2), cy = p[1] + ny * (setback + depth / 2);
      const plot = rectCorners(cx, cy, plotW - 1.5, depth, ang);
      if (!mask.polyFree(plot, M.ROAD | M.WATER | M.BUILD | M.SETTLE | M.RAIL | M.CITY | M.BALKA)) continue;
      mask.stampPoly(plot, M.SETTLE);
      const yard = { kind: 'plot', poly: plot, fence: rng.chance(0.7) };
      addItem(world.areas, yard);

      // Огород в задней части — грядки полосами
      const gDepth = depth * rng.float(0.35, 0.55);
      const gcx = p[0] + nx * (setback + depth - gDepth / 2), gcy = p[1] + ny * (setback + depth - gDepth / 2);
      addItem(world.areas, {
        kind: 'garden',
        poly: rectCorners(gcx, gcy, plotW - 4, gDepth - 2, ang),
        angle: ang + Math.PI / 2,
        tone: rng.int(0, 2),
      });

      // Дом у улицы
      const hw = rng.float(8, 13), hd = rng.float(7, 10);
      const along = rng.float(-plotW * 0.18, plotW * 0.18);
      const hx = p[0] + nx * (setback + 4 + hd / 2) + t[0] * along;
      const hy = p[1] + ny * (setback + 4 + hd / 2) + t[1] * along;
      addBuilding(world, { x: hx, y: hy, w: hw, h: hd, angle: ang, roof: rng.weighted(roofs), style: 'gable', height: 5 });

      // Хозпостройки
      const nOut = rng.int(1, 3);
      for (let k = 0; k < nOut; k++) {
        const ow = rng.float(4, 9), od = rng.float(3.5, 6);
        const dd = setback + 4 + hd + rng.float(4, depth * 0.4);
        const ox = p[0] + nx * dd + t[0] * rng.float(-plotW * 0.3, plotW * 0.3);
        const oy = p[1] + ny * dd + t[1] * rng.float(-plotW * 0.3, plotW * 0.3);
        addBuilding(world, { x: ox, y: oy, w: ow, h: od, angle: ang + (rng.chance(0.5) ? Math.PI / 2 : 0), roof: rng.pick(['#7a7872', '#6d5a4a', '#8c8a84', '#6a6f72']), style: 'shed', height: 3 });
      }
      // Фруктовые деревья
      const nT = rng.int(3, 10);
      for (let k = 0; k < nT; k++) {
        const dd = setback + 10 + hd + rng.float(0, depth - gDepth - hd - 8);
        const x = p[0] + nx * dd + t[0] * rng.float(-plotW * 0.4, plotW * 0.4);
        const y = p[1] + ny * dd + t[1] * rng.float(-plotW * 0.4, plotW * 0.4);
        if (!mask.has(x, y, M.BUILD)) world.trees.add(x, y, rng.float(1.8, 3.4), rng.int(0, 3));
      }
    }
  }
}

function addBuilding(world, b) {
  b.kind = 'building';
  b.poly = rectCorners(b.x, b.y, b.w, b.h, b.angle);
  addItem(world.buildings, b, (b.height || 4) + 2);
  world.mask.stampPoly(b.poly, M.BUILD);
  return b;
}

// ---------- Ферма (коровники, мехдвор) у края села ----------
function buildFarm(world, rng, v) {
  const { mask } = world;
  const end = v.street[rng.chance(0.5) ? 0 : v.street.length - 1];
  for (let attempt = 0; attempt < 12; attempt++) {
    const a = rng.float(0, Math.PI * 2);
    const r = rng.float(220, 380);
    const cx = end[0] + Math.cos(a) * r, cy = end[1] + Math.sin(a) * r;
    const ang = v.angle + (rng.chance(0.5) ? Math.PI / 2 : 0);
    const yard = rectCorners(cx, cy, 190, 150, ang);
    if (!mask.polyFree(yard, M.ROAD | M.WATER | M.BUILD | M.SETTLE | M.CITY | M.RAIL | M.BALKA)) continue;
    mask.stampPoly(yard, M.SETTLE);
    addItem(world.areas, { kind: 'farmyard', poly: yard });
    const n = rng.int(3, 5);
    const c = Math.cos(ang), s = Math.sin(ang);
    for (let k = 0; k < n; k++) {
      const off = (k - (n - 1) / 2) * 30;
      addBuilding(world, {
        x: cx - s * off, y: cy + c * off, w: rng.float(90, 130), h: 16, angle: ang,
        roof: rng.pick(['#8e8b85', '#7c7a74', '#8a6a52', '#9c9a93']), style: 'barn', height: 7,
        ruined: rng.chance(0.25),
      });
    }
    // Подъездная грунтовка
    addRoad(world, resample([end.slice(), [cx, cy]], 10), 'dirt');
    return;
  }
}

// ---------- Город ----------
function buildCity(world, rng, C, cityPoly, rail, river) {
  const { mask } = world;
  addItem(world.areas, { kind: 'urban', poly: cityPoly });
  mask.stampPoly(cityPoly, M.CITY);

  const phi = rng.float(-0.25, 0.25);
  const c = Math.cos(phi), s = Math.sin(phi);
  const toW = (u, v) => [C[0] + u * c - v * s, C[1] + u * s + v * c];
  const R = 1000;
  const inCity = (p) => pointInPoly(p[0], p[1], cityPoly);

  const us = [], vs = [];
  for (let u = -R; u <= R; u += rng.float(105, 150)) us.push(u);
  for (let v = -R; v <= R; v += rng.float(95, 135)) vs.push(v);
  // Главные улицы — ближайшие к центру
  const mainU = us.reduce((b, u) => (Math.abs(u) < Math.abs(b) ? u : b), us[0]);
  const mainV = vs.reduce((b, v) => (Math.abs(v) < Math.abs(b) ? v : b), vs[0]);

  const streetRun = (pts, type, allowWater) => {
    let run = [];
    const flush = () => {
      if (run.length > 6) addRoad(world, run, type);
      run = [];
    };
    for (const p of pts) {
      const wet = mask.has(p[0], p[1], M.WATER);
      if (inCity(p) && (allowWater || !wet) && !mask.has(p[0], p[1], M.RAIL)) run.push(p);
      else if (inCity(p) && mask.has(p[0], p[1], M.RAIL) && run.length) run.push(p); // переезд
      else flush();
    }
    flush();
  };
  for (const u of us) {
    const pts = [];
    for (let v = -R; v <= R; v += 8) pts.push(toW(u, v));
    streetRun(pts, u === mainU ? 'avenue' : 'street', u === mainU);
  }
  for (const v of vs) {
    const pts = [];
    for (let u = -R; u <= R; u += 8) pts.push(toW(u, v));
    streetRun(pts, v === mainV ? 'avenue' : 'street', v === mainV);
  }

  // Кварталы
  const panelRoof = ['#a3a19b', '#96948e', '#8a8984', '#b0ada6', '#9d9a92'];
  const privRoofs = [['#8b4a38', 3], ['#7e7e79', 3], ['#6c7f86', 1.5], ['#9a9890', 1.5], ['#5f7a5a', 1]];
  let parkDone = false, stadiumDone = false, elevatorDone = false;
  const ellD = (p) => Math.hypot((p[0] - C[0]) / 820, (p[1] - C[1]) / 600);

  for (let i = 0; i + 1 < us.length; i++) {
    for (let j = 0; j + 1 < vs.length; j++) {
      const inset = 10;
      const u0 = us[i] + inset, u1 = us[i + 1] - inset, v0 = vs[j] + inset, v1 = vs[j + 1] - inset;
      const bw = u1 - u0, bh = v1 - v0;
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
      const center = toW(cu, cv);
      const corners = [toW(u0, v0), toW(u1, v0), toW(u1, v1), toW(u0, v1)];
      if (!corners.every(inCity)) continue;
      if (!mask.polyFree(corners, M.WATER, 10)) continue;
      const d = ellD(center);
      const railD = distToLine(center[0], center[1], rail);
      const blk = { u0, u1, v0, v1, toW, phi, center, d };

      if (railD < 200 && !elevatorDone) {
        elevatorDone = buildElevator(world, rng, blk);
        if (elevatorDone) continue;
      }
      if (railD < 260 && rng.chance(0.75)) { buildIndustrial(world, rng, blk); continue; }
      if (!parkDone && d < 0.35 && rng.chance(0.4)) { parkDone = true; buildPark(world, rng, blk); continue; }
      if (!stadiumDone && d > 0.3 && d < 0.6 && rng.chance(0.2)) { stadiumDone = true; buildStadium(world, rng, blk); continue; }
      if (d < 0.42 || (d < 0.62 && rng.chance(0.45))) buildPanelBlock(world, rng, blk, panelRoof, d);
      else buildPrivateBlock(world, rng, blk, privRoofs);
    }
  }
  buildStation(world, rng, rail, C);
}

function blockBuild(world, blk, u, v, w, h, props) {
  const [x, y] = blk.toW(u, v);
  const poly = rectCorners(x, y, w, h, blk.phi + (props.rot || 0));
  if (!world.mask.polyFree(poly, M.ROAD | M.WATER | M.RAIL | M.BUILD, 4)) return null;
  return addBuilding(world, { x, y, w, h, angle: blk.phi + (props.rot || 0), ...props });
}

function buildPanelBlock(world, rng, blk, roofs, d) {
  const { u0, u1, v0, v1 } = blk;
  addItem(world.areas, { kind: 'yard', poly: [blk.toW(u0, v0), blk.toW(u1, v0), blk.toW(u1, v1), blk.toW(u0, v1)] });
  const tall = d < 0.25 ? 9 : 5;
  const depth = tall === 9 ? 13 : 12;
  const bw = u1 - u0, bh = v1 - v0;
  // Дома вдоль краёв квартала — «коробка» со двором
  const layout = rng.int(0, 2);
  const roof = () => rng.pick(roofs);
  const edgeU = (v, len) => blockBuild(world, blk, (u0 + u1) / 2 + rng.float(-5, 5), v, len, depth, { roof: roof(), style: 'flat', height: tall * 3 });
  const edgeV = (u, len) => blockBuild(world, blk, u, (v0 + v1) / 2 + rng.float(-5, 5), depth, len, { roof: roof(), style: 'flat', height: tall * 3 });
  if (layout === 0) {
    edgeU(v0 + depth / 2 + 2, bw * rng.float(0.6, 0.85));
    edgeU(v1 - depth / 2 - 2, bw * rng.float(0.6, 0.85));
  } else if (layout === 1) {
    edgeV(u0 + depth / 2 + 2, bh * rng.float(0.6, 0.85));
    edgeV(u1 - depth / 2 - 2, bh * rng.float(0.6, 0.85));
    edgeU(v0 + depth / 2 + 2, bw * 0.45);
  } else {
    // Точечные башни
    const n = rng.int(2, 4);
    for (let k = 0; k < n; k++)
      blockBuild(world, blk, rng.float(u0 + 14, u1 - 14), rng.float(v0 + 14, v1 - 14), 18, 18, { roof: roof(), style: 'flat', height: 30 });
  }
  // Школа / садик в каждом третьем квартале
  if (rng.chance(0.3)) {
    blockBuild(world, blk, (u0 + u1) / 2, (v0 + v1) / 2, 40, 14, { roof: '#b8b2a4', style: 'flat', height: 9 });
  }
  // Гаражи
  if (rng.chance(0.4)) {
    const n = rng.int(5, 12);
    const gu = rng.float(u0 + 20, u1 - 20 - n * 3.5);
    for (let k = 0; k < n; k++)
      blockBuild(world, blk, gu + k * 3.6, (v0 + v1) / 2 + rng.float(-10, 10), 3.4, 6, { roof: rng.pick(['#6a6964', '#5d5c58', '#7d6452']), style: 'shed', height: 2.5 });
  }
  // Деревья во дворе
  const nT = rng.int(8, 22);
  for (let k = 0; k < nT; k++) {
    const [x, y] = blk.toW(rng.float(u0 + 4, u1 - 4), rng.float(v0 + 4, v1 - 4));
    if (!world.mask.has(x, y, M.BUILD | M.ROAD)) world.trees.add(x, y, rng.float(2.5, 5), rng.int(0, 3));
  }
}

function buildPrivateBlock(world, rng, blk, roofs) {
  const { u0, u1, v0, v1 } = blk;
  const bw = u1 - u0;
  const n = Math.max(2, Math.floor(bw / rng.float(20, 28)));
  const pw = bw / n;
  const pd = (v1 - v0) / 2;
  for (const half of [0, 1]) {
    for (let k = 0; k < n; k++) {
      const cu = u0 + pw * (k + 0.5);
      const cv = half === 0 ? v0 + pd / 2 : v1 - pd / 2;
      const [x, y] = blk.toW(cu, cv);
      const plot = rectCorners(x, y, pw - 1, pd - 1, blk.phi);
      addItem(world.areas, { kind: 'plot', poly: plot, fence: rng.chance(0.8) });
      // Огород у задней границы
      const gv = half === 0 ? v0 + pd * 0.8 : v1 - pd * 0.8;
      const [gx, gy] = blk.toW(cu, gv);
      addItem(world.areas, { kind: 'garden', poly: rectCorners(gx, gy, pw - 4, pd * 0.35, blk.phi), angle: blk.phi + Math.PI / 2, tone: rng.int(0, 2) });
      const hv = half === 0 ? v0 + 9 : v1 - 9;
      blockBuild(world, blk, cu + rng.float(-3, 3), hv, rng.float(8, 12), rng.float(7, 9.5), { roof: rng.weighted(roofs), style: 'gable', height: 5 });
      if (rng.chance(0.7))
        blockBuild(world, blk, cu + rng.float(-5, 5), half === 0 ? v0 + pd * 0.5 : v1 - pd * 0.5, rng.float(4, 7), rng.float(3.5, 5), { roof: rng.pick(['#7a7872', '#6d5a4a']), style: 'shed', height: 3 });
      const nT = rng.int(1, 4);
      for (let t = 0; t < nT; t++) {
        const [tx, ty] = blk.toW(cu + rng.float(-pw / 2 + 2, pw / 2 - 2), half === 0 ? rng.float(v0 + 18, v0 + pd * 0.6) : rng.float(v1 - pd * 0.6, v1 - 18));
        if (!world.mask.has(tx, ty, M.BUILD)) world.trees.add(tx, ty, rng.float(1.8, 3.2), rng.int(0, 3));
      }
    }
  }
}

function buildIndustrial(world, rng, blk) {
  const { u0, u1, v0, v1 } = blk;
  addItem(world.areas, { kind: 'industrial', poly: [blk.toW(u0, v0), blk.toW(u1, v0), blk.toW(u1, v1), blk.toW(u0, v1)] });
  const n = rng.int(2, 4);
  for (let k = 0; k < n; k++) {
    const w = rng.float(30, 80), h = rng.float(18, 40);
    blockBuild(world, blk, rng.float(u0 + w / 2 + 3, Math.max(u0 + w / 2 + 4, u1 - w / 2 - 3)), rng.float(v0 + h / 2 + 3, Math.max(v0 + h / 2 + 4, v1 - h / 2 - 3)), w, h,
      { roof: rng.pick(['#8f8d88', '#7b7974', '#8b6448', '#6f7b80', '#a09d96']), style: 'hangar', height: 9, ruined: rng.chance(0.15) });
  }
  // Складированный хлам, контейнеры
  const nc = rng.int(3, 10);
  for (let k = 0; k < nc; k++)
    blockBuild(world, blk, rng.float(u0 + 5, u1 - 5), rng.float(v0 + 5, v1 - 5), 6, 2.4, { roof: rng.pick(['#8a3b2e', '#2f5a7a', '#6b6b2e', '#9a9a95']), style: 'flat', height: 2.5, rot: rng.chance(0.5) ? Math.PI / 2 : 0 });
}

function buildElevator(world, rng, blk) {
  const { u0, u1, v0, v1 } = blk;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  addItem(world.areas, { kind: 'industrial', poly: [blk.toW(u0, v0), blk.toW(u1, v0), blk.toW(u1, v1), blk.toW(u0, v1)] });
  const n = 6;
  const siloR = 5.5;
  const pts = [];
  for (let row = 0; row < 2; row++)
    for (let k = 0; k < n; k++) {
      const [x, y] = blk.toW(cu - (n - 1) * siloR + k * siloR * 2, cv + (row - 0.5) * siloR * 2);
      pts.push([x, y]);
    }
  const box = pts.map(([x, y]) => [x, y]);
  if (!world.mask.polyFree(bboxPoly(box, siloR), M.ROAD | M.WATER | M.RAIL | M.BUILD, 4)) return false;
  for (const [x, y] of pts) {
    const silo = { kind: 'building', style: 'silo', x, y, r: siloR, roof: '#c9c6bd', height: 30, poly: rectCorners(x, y, siloR * 2, siloR * 2, 0) };
    addItem(world.buildings, silo, 34);
    world.mask.stampDisc(x, y, siloR, M.BUILD);
  }
  blockBuild(world, blk, cu + n * siloR + 6, cv, 10, 14, { roof: '#bdb9ae', style: 'flat', height: 45 });
  blockBuild(world, blk, cu, cv + siloR * 2 + 12, 60, 14, { roof: '#8f8d88', style: 'hangar', height: 8 });
  return true;
}

function bboxPoly(pts, pad) {
  const b = bboxOf(pts, pad);
  return [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];
}

function buildPark(world, rng, blk) {
  const { u0, u1, v0, v1 } = blk;
  addItem(world.areas, { kind: 'park', poly: [blk.toW(u0, v0), blk.toW(u1, v0), blk.toW(u1, v1), blk.toW(u0, v1)] });
  // Аллеи крест-накрест
  addItem(world.areas, { kind: 'path', line: [blk.toW(u0, v0), blk.toW(u1, v1)], width: 3 }, 3);
  addItem(world.areas, { kind: 'path', line: [blk.toW(u1, v0), blk.toW(u0, v1)], width: 3 }, 3);
  const nT = rng.int(60, 120);
  for (let k = 0; k < nT; k++) {
    const u = rng.float(u0 + 3, u1 - 3), v = rng.float(v0 + 3, v1 - 3);
    const [x, y] = blk.toW(u, v);
    const du = (u - u0) / (u1 - u0), dv = (v - v0) / (v1 - v0);
    if (Math.abs(du - dv) < 0.05 || Math.abs(du + dv - 1) < 0.05) continue;
    world.trees.add(x, y, rng.float(2.5, 5.5), rng.int(0, 3));
  }
}

function buildStadium(world, rng, blk) {
  const { u0, u1, v0, v1 } = blk;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  const [x, y] = blk.toW(cu, cv);
  addItem(world.areas, { kind: 'stadium', x, y, angle: blk.phi, poly: rectCorners(x, y, 105, 70, blk.phi) });
}

function buildStation(world, rng, rail, C) {
  // Ближайшая к центру точка ж/д — вокзал и платформы
  let bi = 0, bd = Infinity;
  rail.forEach((p, i) => {
    const d = dist(p, C);
    if (d < bd) { bd = d; bi = i; }
  });
  const tg = tangents(rail)[bi];
  const ang = Math.atan2(tg[1], tg[0]);
  const p = rail[bi];
  // Станционные пути
  const lo = Math.max(0, bi - 30), hi = Math.min(rail.length, bi + 30);
  for (const off of [-9, 9, 15]) {
    const side = offsetLine(rail.slice(lo, hi), off);
    addItem(world.rails, { kind: 'rail', line: side, width: 5, siding: true }, 8);
    world.mask.stampLine(side, 8, M.RAIL);
  }
  addItem(world.areas, { kind: 'platform', poly: rectCorners(p[0] - tg[1] * 4.5, p[1] + tg[0] * 4.5, 180, 4, ang) });
  const bx = p[0] - tg[1] * 26, by = p[1] + tg[0] * 26;
  addBuilding(world, { x: bx, y: by, w: 55, h: 16, angle: ang, roof: '#7d5a4a', style: 'gable', height: 10 });
}

// ---------- Следы войны ----------
function seedWarScars(world, rng, cityC) {
  // Условная «серая зона» — полоса к востоку от города
  const cx = cityC[0] + rng.float(1200, 1700);
  for (let k = 0; k < 14; k++) {
    const x = cx + rng.gauss(0, 350);
    const y = rng.float(300, world.H - 300);
    addCraterCluster(world, rng, x, y, rng.int(4, 18), rng.float(20, 60));
    if (rng.chance(0.4)) addBurn(world, rng, x + rng.float(-60, 60), y + rng.float(-60, 60), rng.float(30, 110));
  }
}

export function addCraterCluster(world, rng, x, y, n, spread) {
  const added = [];
  for (let i = 0; i < n; i++) {
    const r = rng.chance(0.15) ? rng.float(4, 7) : rng.float(1.2, 3.5);
    const c = { kind: 'crater', x: x + rng.gauss(0, spread), y: y + rng.gauss(0, spread), r, seed: rng.int(0, 1e9) };
    c.pts = [[c.x, c.y]];
    addItem(world.scars, c, r * 2.6);
    added.push(c);
  }
  return added;
}

export function addBurn(world, rng, x, y, size) {
  const poly = blob(x, y, size, size * rng.float(0.5, 0.9), rng.float(0, 3.14), rng, 28, 0.4);
  const b = { kind: 'burn', poly, x, y };
  addItem(world.scars, b, 4);
  return b;
}
