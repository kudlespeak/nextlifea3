// Фортификация: траншеи, стрелковые ячейки, «лисьи норы», блиндажи,
// перекрытые участки, подземные ходы, капониры для техники.
// Устроено по образцу реальных опорных пунктов в лесополосах:
//  • стрелковая траншея — ломаная, по передней опушке посадки (деревья маскируют);
//  • ячейки выдвинуты на 2–3 м вперёд к полю, в стенках — ниши («лисьи норы»);
//  • ходы сообщения идут поперёк посадки к тыловой траншее вдоль задней опушки;
//  • блиндажи — у тыловой опушки, заглублены на 2.5–3.5 м, перекрыты брёвнами
//    в 2–4 наката плюс грунт; вход Г-образный, чтобы осколки не залетали внутрь;
//  • часть траншей перекрыта брёвнами или сеткой — защита от сбросов с дронов;
//  • подземные ходы (галереи на 4–6 м) соединяют блиндажи и выводят к передней траншее.
// Модуль без DOM — пригоден для сервера.

import { bboxOf, dist, resample, catmullRom } from './geom.js';
import { addCraterCluster } from './mapgen.js';
import { M } from './spatial.js';

// Базовая защита элементов — пригодится для расчёта осколков и прямых попаданий
// (0 — нет защиты, 1 — полная). Значения ориентировочные, будут уточняться.
export const PROTECTION = {
  open:      { fragments: 0, airburst: 0, drone: 0 },
  trench:    { fragments: 0.85, airburst: 0.35, drone: 0.15 },
  covered:   { fragments: 0.95, airburst: 0.9, drone: 0.7 },
  net:       { fragments: 0.85, airburst: 0.4, drone: 0.6 },
  dugout:    { fragments: 1, airburst: 1, drone: 0.95 }, // + выдерживаемый калибр по накатам
  tunnel:    { fragments: 1, airburst: 1, drone: 1 },
};
// Какой калибр (мм) выдерживает блиндаж при близком разрыве в зависимости от накатов
export const DUGOUT_RESIST = { 1: 82, 2: 120, 3: 152, 4: 155 };

function add(world, item, pad = 3) {
  item.bbox = bboxOf(item.line || item.poly || [[item.x, item.y]], pad + (item.w ? Math.max(item.w, item.h) : 0));
  world.forts.insert(item);
  // Отметка «здесь позиция» — кроны над ней при приближении становятся прозрачнее
  if (item.kind === 'trench') world.mask.stampLine(item.line, 12, M.FORT);
  else if (item.kind === 'dugout' || item.kind === 'capon') world.mask.stampDisc(item.x, item.y, Math.max(item.w, item.h) + 4, M.FORT);
  world.fortsVersion = (world.fortsVersion || 0) + 1;
  return item;
}

// Точка в системе координат посадки: t — вдоль, o — поперёк (к противнику +)
const P = (belt, n, t, o) => [belt.line[0][0] + belt.dir[0] * t + n[0] * o, belt.line[0][1] + belt.dir[1] * t + n[1] * o];

// Ломаная траншея вдоль направления: «зубцы» с шагом step и выносом amp
function zigzag(rng, from, to, step, amp) {
  const L = dist(from, to);
  const dx = (to[0] - from[0]) / L, dy = (to[1] - from[1]) / L;
  const nx = -dy, ny = dx;
  const pts = [];
  let k = 0;
  for (let t = 0; t <= L; t += step * rng.float(0.8, 1.2), k++) {
    // первая точка — точно в начале, чтобы куски траншеи стыковались
    const o = k === 0 ? 0 : (k % 2 ? amp : -amp) * rng.float(0.6, 1);
    pts.push([from[0] + dx * t + nx * o, from[1] + dy * t + ny * o]);
  }
  pts.push(to.slice());
  return pts;
}

// Разбить линию на участки, часть — перекрытые
function splitCovered(rng, line, pCovered, pNet) {
  const out = [];
  let i = 0;
  while (i < line.length - 1) {
    const n = rng.int(3, 8);
    const seg = line.slice(i, Math.min(line.length, i + n + 1));
    const r = rng.next();
    out.push({ line: seg, covered: r < pCovered ? 'logs' : r < pCovered + pNet ? 'net' : null });
    i += n;
  }
  return out;
}

// Траншею нельзя вырыть через асфальт, воду, рельсы и дома — режем на куски
const NO_DIG = M.ROAD | M.WATER | M.RAIL | M.BUILD;
function trench(world, props) {
  const fine = resample(props.line, 1.2);
  const runs = [];
  let cur = [];
  for (const p of fine) {
    if (world.mask.has(p[0], p[1], NO_DIG)) {
      if (cur.length) runs.push(cur);
      cur = [];
    } else cur.push(p);
  }
  if (cur.length) runs.push(cur);
  const out = [];
  for (const run of runs) {
    if (run.length < 3) continue;
    // Прореживаем обратно, сохраняя изломы
    const line = simplify(run);
    out.push(add(world, { kind: 'trench', width: 1.0, depth: 1.8, age: 0.3, ...props, line }));
  }
  return out;
}

function simplify(pts) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(cross) > 0.15) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// ---------- Опорный пункт в лесополосе ----------
export function buildStrongpoint(world, rng, belt, side, enemy, opts = {}) {
  let n = belt.normal;
  if (n[0] * enemy[0] + n[1] * enemy[1] < 0) n = [-n[0], -n[1]];
  const half = belt.width / 2;
  const fo = half - 2.5; // передняя траншея под кронами опушки
  const ro = -(half - 3); // тыловая
  const t0 = belt.len * rng.float(0.05, 0.18);
  const t1 = belt.len * rng.float(0.82, 0.95);
  const age = rng.float(0.1, 0.9);
  const light = !!opts.light;
  const created = [];

  // Стрелковая траншея
  const front = zigzag(rng, P(belt, n, t0, fo), P(belt, n, t1, fo), rng.float(5, 8), rng.float(1.2, 2));
  for (const part of splitCovered(rng, front, light ? 0.05 : 0.15, light ? 0.05 : 0.12)) {
    const niches = [];
    for (let i = 1; i < part.line.length; i += 2) niches.push({ p: part.line[i], side: rng.chance(0.5) ? 1 : -1 });
    created.push(...trench(world, { sub: 'fire', line: part.line, side, covered: part.covered, enemy: n, niches, age }));
  }
  // Стрелковые ячейки — выносы вперёд
  for (let t = t0 + rng.float(5, 12); t < t1 - 5; t += rng.float(14, 24)) {
    const a = P(belt, n, t, fo), b = P(belt, n, t + rng.float(-1.5, 1.5), fo + rng.float(2.2, 3.4));
    created.push(...trench(world, { sub: 'cell', line: [a, b], side, pit: b, enemy: n, age }));
  }
  if (light) return created;

  // Тыловая траншея вдоль задней опушки
  const rear = resample(catmullRom([P(belt, n, t0 + 10, ro), P(belt, n, (t0 + t1) / 2, ro + rng.float(-1.5, 1.5)), P(belt, n, t1 - 10, ro)], 6), 6);
  created.push(...trench(world, { sub: 'comm', line: rear, side, covered: null, enemy: n, age }));

  // Ходы сообщения поперёк посадки
  for (let t = t0 + rng.float(20, 45); t < t1 - 15; t += rng.float(60, 110)) {
    const line = [P(belt, n, t, fo), P(belt, n, t + rng.float(-5, 5), (fo + ro) / 2 + rng.float(-2, 2)), P(belt, n, t + rng.float(-5, 5), ro)];
    created.push(...trench(world, { sub: 'comm', line: resample(line, 3), side, covered: rng.chance(0.55) ? 'logs' : null, enemy: n, age }));
  }

  // Блиндажи у тыловой опушки
  const dugouts = [];
  for (let t = t0 + rng.float(15, 35); t < t1 - 15; t += rng.float(45, 80)) {
    const w = rng.float(3.5, 5.5), h = rng.float(3.5, 5);
    const c = P(belt, n, t, ro + h / 2 + 2.2);
    if (world.mask.near(c[0], c[1], Math.max(w, h), NO_DIG)) continue;
    const layers = rng.int(2, 4);
    const d = add(world, {
      kind: 'dugout', x: c[0], y: c[1], w, h, angle: Math.atan2(belt.dir[1], belt.dir[0]),
      side, layers, depth: rng.float(2.5, 3.5), earth: rng.float(0.8, 1.5), net: rng.chance(0.4),
      capacity: rng.int(4, 10), resist: DUGOUT_RESIST[layers], age,
    });
    dugouts.push(d);
    created.push(d);
    // Г-образный вход: из блиндажа назад и вбок до тыловой траншеи
    const e0 = P(belt, n, t, ro + 2.2);
    const e1 = P(belt, n, t, ro + 0.8);
    const e2 = P(belt, n, t + (rng.chance(0.5) ? 2.5 : -2.5), ro + 0.8);
    const e3 = P(belt, n, t + (rng.chance(0.5) ? 2.5 : -2.5), ro);
    created.push(...trench(world, { sub: 'entrance', line: [e0, e1, e2, e3], side, covered: 'logs', enemy: n, age }));
    d.t = t;
  }

  // Подземные ходы: между блиндажами и к передней траншее
  for (let i = 0; i + 1 < dugouts.length; i++) {
    if (!rng.chance(0.6)) continue;
    const a = dugouts[i], b = dugouts[i + 1];
    const mid = P(belt, n, (a.t + b.t) / 2, (ro + fo) / 2 * 0.3 + rng.float(-3, 3));
    const line = resample(catmullRom([[a.x, a.y], mid, [b.x, b.y]], 6), 3);
    created.push(add(world, { kind: 'tunnel', line, side, depth: rng.float(4, 6), width: 1.2 }));
  }
  for (const d of dugouts) {
    if (!rng.chance(0.35)) continue;
    const exit = P(belt, n, d.t + rng.float(-6, 6), fo - 1);
    const line = resample(catmullRom([[d.x, d.y], P(belt, n, d.t + rng.float(-4, 4), 0), exit], 6), 3);
    created.push(add(world, { kind: 'tunnel', line, side, depth: rng.float(3.5, 5), width: 1, exitTo: 'fire' }));
  }

  // Капониры для техники за посадкой
  const nCap = rng.int(0, 2);
  for (let k = 0; k < nCap; k++) {
    const t = rng.float(t0 + 10, t1 - 10);
    const c = P(belt, n, t, -half - rng.float(12, 25));
    if (world.mask.near(c[0], c[1], 8, NO_DIG)) continue;
    created.push(add(world, { kind: 'capon', x: c[0], y: c[1], w: 5, h: 9, angle: Math.atan2(n[1], n[0]), side }));
  }

  // Следы обстрелов перед позицией
  if (opts.shelled) {
    const nc = rng.int(2, 5);
    for (let k = 0; k < nc; k++) {
      const t = rng.float(t0, t1);
      const c = P(belt, n, t, fo + rng.float(-5, 60));
      addCraterCluster(world, rng, c[0], c[1], rng.int(3, 9), rng.float(8, 25));
    }
  }
  return created;
}

// ---------- Оборонительные линии обеих сторон ----------
export function buildFortifications(world, rng, frontX) {
  world.frontX = frontX;
  const belts = world.belts.items;
  const margin = 150;
  const pick = (targetX, spreadX, maxN, minGap) => {
    const cand = belts
      .filter((b) => Math.abs(b.dir[1]) > 0.75 && b.len > 180 && Math.abs(b.mid[0] - targetX) < spreadX)
      .filter((b) => b.mid[1] > margin && b.mid[1] < world.H - margin && b.mid[0] > margin && b.mid[0] < world.W - margin)
      // только настоящие, сплошные посадки в поле — не обрывки в городе и сёлах
      .filter((b) => b.pts.length >= b.len / 2.5 && !world.mask.has(b.mid[0], b.mid[1], M.CITYZONE | M.VILLAGE | M.SETTLE | M.CITY))
      .sort((a, b) => Math.abs(a.mid[0] - targetX) - Math.abs(b.mid[0] - targetX));
    const out = [];
    for (const b of cand) {
      if (out.length >= maxN) break;
      if (out.some((o) => Math.abs(o.mid[1] - b.mid[1]) < minGap)) continue;
      out.push(b);
    }
    return out;
  };
  const sides = [
    { side: 'blue', enemy: [1, 0], dir: -1 },
    { side: 'red', enemy: [-1, 0], dir: 1 },
  ];
  for (const s of sides) {
    // Первая линия — ближе к серой зоне, с блиндажами и ходами
    for (const b of pick(frontX + s.dir * 550, 380, 6, 300)) buildStrongpoint(world, rng, b, s.side, s.enemy, { shelled: true });
    // Вторая линия — глубже, облегчённая
    for (const b of pick(frontX + s.dir * 1350, 350, 3, 500)) buildStrongpoint(world, rng, b, s.side, s.enemy, { light: rng.chance(0.5) });
  }
}

// ---------- Выкопать траншею по точкам (инструмент игрока) ----------
export function digTrench(world, rng, points, side, enemy) {
  if (points.length < 2) return [];
  const created = [];
  // Нормаль «к противнику» для бруствера
  const a = points[0], b = points[points.length - 1];
  const L = dist(a, b) || 1;
  let n = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
  if (n[0] * enemy[0] + n[1] * enemy[1] < 0) n = [-n[0], -n[1]];
  for (let i = 1; i < points.length; i++) {
    const line = zigzag(rng, points[i - 1], points[i], rng.float(5, 7), 1.3);
    const niches = [];
    for (let k = 1; k < line.length; k += 2) niches.push({ p: line[k], side: rng.chance(0.5) ? 1 : -1 });
    created.push(...trench(world, { sub: 'fire', line, side, covered: null, enemy: n, niches, age: 0 }));
  }
  return created;
}
