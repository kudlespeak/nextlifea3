// Симуляция отрядов: типы, приказы, построение, движение.
// Время — игровые секунды. Без DOM: пригодно для сервера.

import { NavGrid, MOVE, T } from './nav.js';

export const SIDES = {
  blue: { name: 'Синие', color: '#4f8dff', fill: '#80b4ff' },
  red: { name: 'Красные', color: '#e5483f', fill: '#ff8f85' },
};

export const UNIT_TYPES = {
  inf:   { name: 'Пехотное отделение', short: 'Пехота', move: 'foot', symbol: 'inf', men: 9, spacing: 55, accel: 1.5, turn: 3 },
  ifv:   { name: 'БМП', short: 'БМП', move: 'tracked', symbol: 'mech', men: 9, spacing: 50, accel: 2.0, turn: 1.4 },
  apc:   { name: 'БТР', short: 'БТР', move: 'wheeled', symbol: 'motor', men: 10, spacing: 50, accel: 2.2, turn: 1.0 },
  tank:  { name: 'Танк', short: 'Танк', move: 'tracked', symbol: 'armor', men: 3, spacing: 55, accel: 1.8, turn: 1.2 },
  arty:  { name: 'Гаубица (буксир.)', short: 'Гаубица', move: 'wheeled', symbol: 'arty', men: 7, spacing: 60, accel: 1.2, turn: 0.8 },
  truck: { name: 'Грузовик снабжения', short: 'Грузовик', move: 'wheeled', symbol: 'supply', men: 2, spacing: 45, accel: 1.6, turn: 0.9 },
};

let nextId = 1;

export class Unit {
  constructor(side, type, x, y, label) {
    this.id = nextId++;
    this.side = side;
    this.type = type;
    this.def = UNIT_TYPES[type];
    this.x = x;
    this.y = y;
    this.heading = 0;
    this.speed = 0; // текущая, м/с
    this.path = null;
    this.pathIdx = 0;
    this.state = 'idle'; // idle | planning | moving
    this.label = label;
    this.strength = 1;
    this.eta = 0;
    this.stealth = false;
    this.facing = null; // куда смотреть после прибытия
  }
  get moveClass() {
    return this.def.move;
  }
}

export class Sim {
  constructor(world) {
    this.world = world;
    const t0 = performance.now();
    this.nav = new NavGrid(world);
    this.navTime = performance.now() - t0;
    this.units = [];
    this.time = 5 * 3600 + 30 * 60; // 05:30, первый день
    this.queue = []; // заявки на прокладку маршрута
  }

  spawn(side, type, x, y, label) {
    const p = this.nav.nearestPassable(x, y, UNIT_TYPES[type].move) || [x, y];
    const u = new Unit(side, type, p[0], p[1], label);
    this.units.push(u);
    return u;
  }

  // Приказ на движение группе: раскладываем точки назначения строем
  orderMove(units, tx, ty, { stealth = false } = {}) {
    if (!units.length) return;
    let cx = 0, cy = 0;
    for (const u of units) { cx += u.x; cy += u.y; }
    cx /= units.length; cy /= units.length;
    let dx = tx - cx, dy = ty - cy;
    const L = Math.hypot(dx, dy) || 1;
    dx /= L; dy /= L;
    if (L < 1) { dx = Math.cos(units[0].heading); dy = Math.sin(units[0].heading); }
    const px = -dy, py = dx; // фронт строя
    const n = units.length;
    const cols = Math.min(n, Math.max(1, Math.ceil(Math.sqrt(n * 2.5))));
    const spacing = Math.max(...units.map((u) => u.def.spacing));
    // Сортируем по проекции на фронт, чтобы маршруты не перекрещивались
    const sorted = [...units].sort((a, b) => (a.x * px + a.y * py) - (b.x * px + b.y * py));
    sorted.forEach((u, i) => {
      const row = Math.floor(i / cols);
      const inRow = Math.min(cols, n - row * cols);
      const col = i % cols;
      const off = (col - (inRow - 1) / 2) * spacing;
      const sx = tx + px * off - dx * row * spacing;
      const sy = ty + py * off - dy * row * spacing;
      u.state = 'planning';
      u.stealth = stealth;
      u.facing = Math.atan2(dy, dx);
      this.queue = this.queue.filter((q) => q.unit !== u);
      this.queue.push({ unit: u, x: sx, y: sy });
    });
  }

  stop(units) {
    for (const u of units) {
      u.path = null;
      u.state = 'idle';
      this.queue = this.queue.filter((q) => q.unit !== u);
    }
  }

  // Прокладка маршрутов в пределах бюджета времени (мс реального времени)
  processQueue(budgetMs = 8) {
    const t0 = performance.now();
    while (this.queue.length && performance.now() - t0 < budgetMs) {
      const { unit: u, x, y } = this.queue.shift();
      const r = this.nav.findPath(u.x, u.y, x, y, u.moveClass, u.stealth);
      if (!r || r.path.length < 2) {
        u.state = 'idle';
        u.path = null;
        u.noRoute = this.time;
        continue;
      }
      u.path = r.path;
      u.pathIdx = 1;
      u.eta = r.time;
      u.state = 'moving';
    }
  }

  update(dt) {
    this.time += dt;
    for (const u of this.units) if (u.state === 'moving') this.moveUnit(u, dt);
    this.separate(dt);
  }

  moveUnit(u, dt) {
    const def = u.def;
    let remaining = dt;
    while (remaining > 1e-4 && u.path) {
      const wp = u.path[u.pathIdx];
      const dx = wp[0] - u.x, dy = wp[1] - u.y;
      const d = Math.hypot(dx, dy);
      // Разворот корпуса
      const want = Math.atan2(dy, dx);
      let da = want - u.heading;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      const maxTurn = def.turn * remaining;
      u.heading += Math.max(-maxTurn, Math.min(maxTurn, da));

      // Скорость по местности; на крутом повороте техника притормаживает
      const terrain = MOVE[def.move][this.nav.classAt(u.x, u.y)] || MOVE[def.move][T.OPEN] * 0.3;
      const turnPenalty = def.move === 'foot' ? 1 : Math.max(0.25, Math.cos(Math.min(Math.abs(da), 1.5)));
      // Торможение перед финишем
      const left = d + this.pathLeft(u);
      const brake = Math.sqrt(2 * def.accel * Math.max(0, left));
      const target = Math.min(terrain * turnPenalty, brake + 0.3);
      if (u.speed < target) u.speed = Math.min(target, u.speed + def.accel * remaining);
      else u.speed = Math.max(target, u.speed - def.accel * 2 * remaining);

      const stepLen = u.speed * remaining;
      if (stepLen >= d) {
        u.x = wp[0];
        u.y = wp[1];
        remaining -= u.speed > 0 ? d / u.speed : remaining;
        u.pathIdx++;
        if (u.pathIdx >= u.path.length) {
          u.path = null;
          u.state = 'idle';
          u.speed = 0;
          break;
        }
      } else {
        u.x += (dx / d) * stepLen;
        u.y += (dy / d) * stepLen;
        remaining = 0;
      }
    }
    if (u.state === 'moving') u.eta = this.estimate(u);
  }

  pathLeft(u) {
    let L = 0;
    for (let i = u.pathIdx; i + 1 < u.path.length; i++)
      L += Math.hypot(u.path[i + 1][0] - u.path[i][0], u.path[i + 1][1] - u.path[i][1]);
    return L;
  }

  // Оценка оставшегося времени по местности вдоль маршрута
  estimate(u) {
    if (!u.path) return 0;
    const sp = MOVE[u.def.move];
    let t = 0;
    let px = u.x, py = u.y;
    for (let i = u.pathIdx; i < u.path.length; i++) {
      const [qx, qy] = u.path[i];
      const L = Math.hypot(qx - px, qy - py);
      const n = Math.max(1, Math.ceil(L / 16));
      for (let k = 0; k < n; k++) {
        const s = sp[this.nav.classAt(px + ((qx - px) * (k + 0.5)) / n, py + ((qy - py) * (k + 0.5)) / n)] || 1;
        t += L / n / s;
      }
      px = qx; py = qy;
    }
    return t;
  }

  // Мягкое расталкивание, чтобы отряды не стояли друг в друге
  separate(dt) {
    const us = this.units;
    for (let i = 0; i < us.length; i++)
      for (let j = i + 1; j < us.length; j++) {
        const a = us[i], b = us[j];
        const minD = a.def.move === 'foot' || b.def.move === 'foot' ? 14 : 11;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d >= minD || d === 0) continue;
        const push = Math.min(minD - d, 4 * dt) / 2;
        const nx = dx / d, ny = dy / d;
        const moveA = a.state !== 'moving' || b.state === 'moving';
        const moveB = b.state !== 'moving' || a.state === 'moving';
        if (moveA && this.canStand(a, a.x - nx * push, a.y - ny * push)) { a.x -= nx * push; a.y -= ny * push; }
        if (moveB && this.canStand(b, b.x + nx * push, b.y + ny * push)) { b.x += nx * push; b.y += ny * push; }
      }
  }

  canStand(u, x, y) {
    return MOVE[u.def.move][this.nav.classAt(x, y)] > 0;
  }

  // Начальная расстановка сторон
  deployDefault(rng) {
    const { world } = this;
    const [city, ...villages] = world.settlements;
    // Синие — город и его восточная окраина; Красные — восточные сёла
    const east = villages.filter((v) => v.x > city.x).sort((a, b) => a.y - b.y);
    const blue = [
      ['tank', 'Т-1'], ['tank', 'Т-2'], ['ifv', '1-я БМП'], ['ifv', '2-я БМП'],
      ['inf', '1-е отд.'], ['inf', '2-е отд.'], ['inf', '3-е отд.'], ['apc', 'БТР-1'],
      ['arty', 'Батарея-1'], ['truck', 'Снабж.-1'], ['truck', 'Снабж.-2'],
    ];
    const red = [
      ['tank', 'Т-71'], ['ifv', '71-я БМП'], ['ifv', '72-я БМП'], ['inf', '71-е отд.'],
      ['inf', '72-е отд.'], ['apc', 'БТР-71'], ['arty', 'Батарея-7'], ['truck', 'Снабж.-7'],
    ];
    const place = (list, side, cx, cy, ang, spread) => {
      list.forEach(([type, label], i) => {
        const a = ang + (i - list.length / 2) * 0.35;
        const r = spread * (0.4 + (i % 3) * 0.3) + rng.float(-20, 20);
        this.spawn(side, type, cx + Math.cos(a) * r, cy + Math.sin(a) * r, label);
      });
    };
    place(blue, 'blue', city.x + 350, city.y, 0, 180);
    const rv = east[0] || { x: world.W * 0.85, y: world.H * 0.3 };
    const rv2 = east[1] || rv;
    place(red.slice(0, 4), 'red', rv.x, rv.y, Math.PI, 160);
    place(red.slice(4), 'red', rv2.x, rv2.y, Math.PI, 160);
  }
}
