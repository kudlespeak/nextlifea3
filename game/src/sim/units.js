// Симуляция отрядов: типы, бойцы, приказы, построение, движение,
// действия в траншеях (занять, зачистить), рытьё окопов.
// Время — игровые секунды. Без DOM: пригодно для сервера.

import { NavGrid, MOVE, T } from './nav.js';
import { TrenchGraph } from './trenchgraph.js';
import { digTrench } from '../forts.js';
import { Rng } from '../rng.js';
import { resample } from '../geom.js';

export const SIDES = {
  blue: { name: 'Синие', color: '#4f8dff', fill: '#80b4ff', enemy: [1, 0] },
  red: { name: 'Красные', color: '#e5483f', fill: '#ff8f85', enemy: [-1, 0] },
};

// dig — скорость рытья полнопрофильной траншеи, м/ч (вручную отделением / машиной)
export const UNIT_TYPES = {
  inf:   { name: 'Пехотное отделение', short: 'Пехота', move: 'foot', symbol: 'inf', men: 9, spacing: 55, accel: 1.5, turn: 3, dig: 12 },
  eng:   { name: 'Инженерно-сапёрное отделение', short: 'Сапёры', move: 'foot', symbol: 'eng', men: 8, spacing: 55, accel: 1.5, turn: 3, dig: 30 },
  btm:   { name: 'Траншейная машина (БТМ)', short: 'БТМ', move: 'tracked', symbol: 'engmech', men: 2, spacing: 50, accel: 1.4, turn: 1.0, dig: 350 },
  ifv:   { name: 'БМП', short: 'БМП', move: 'tracked', symbol: 'mech', men: 9, spacing: 50, accel: 2.0, turn: 1.4 },
  apc:   { name: 'БТР', short: 'БТР', move: 'wheeled', symbol: 'motor', men: 10, spacing: 50, accel: 2.2, turn: 1.0 },
  tank:  { name: 'Танк', short: 'Танк', move: 'tracked', symbol: 'armor', men: 3, spacing: 55, accel: 1.8, turn: 1.2 },
  arty:  { name: 'Гаубица (буксир.)', short: 'Гаубица', move: 'wheeled', symbol: 'arty', men: 7, spacing: 60, accel: 1.2, turn: 0.8 },
  truck: { name: 'Грузовик снабжения', short: 'Грузовик', move: 'wheeled', symbol: 'supply', men: 2, spacing: 45, accel: 1.6, turn: 0.9 },
};

const ROLES = {
  inf: ['Командир', 'Пулемётчик', 'Гранатомётчик', 'Стрелок', 'Стрелок', 'Снайпер', 'Помощник пулемётчика', 'Медик', 'Стрелок'],
  eng: ['Командир', 'Сапёр', 'Сапёр', 'Сапёр', 'Пулемётчик', 'Сапёр', 'Сапёр', 'Медик'],
};
// Кто идёт первым при зачистке (штурмовая «двойка», командир третьим)
const CLEAR_ORDER = ['Стрелок', 'Гранатомётчик', 'Командир', 'Пулемётчик', 'Помощник пулемётчика', 'Сапёр', 'Снайпер', 'Медик'];

const DIG_PIECE = 8; // траншея появляется кусками по 8 м

let nextId = 1;

export class Unit {
  constructor(side, type, x, y, label) {
    this.id = nextId++;
    this.side = side;
    this.type = type;
    this.def = UNIT_TYPES[type];
    this.x = x;
    this.y = y;
    this.heading = side === 'blue' ? 0 : Math.PI;
    this.speed = 0;
    this.path = null;
    this.pathIdx = 0;
    this.state = 'idle'; // idle | planning | moving
    this.mode = 'field'; // field — строем; trench — бойцы действуют по отдельности
    this.task = null; // { type: 'occupy' | 'clear' | 'dig' | 'manual', ... }
    this.pending = null; // приказ, который выполнится по прибытии
    this.label = label;
    this.strength = 1;
    this.eta = 0;
    this.stealth = false;
    this.soldiers = null;
    if (ROLES[type]) {
      this.soldiers = ROLES[type].map((role, i) => {
        const [ox, oy] = formationOffset(i);
        const c = Math.cos(this.heading), s = Math.sin(this.heading);
        return {
          idx: i, role, x: x + ox * c - oy * s, y: y + ox * s + oy * c, heading: this.heading,
          mode: 'follow', path: null, pathIdx: 0, speed: 1.4, under: false, startAt: 0, waitUntil: 0, face: null,
        };
      });
    }
  }
  get moveClass() {
    return this.def.move;
  }
}

// Строй «клин» относительно направления движения
function formationOffset(i) {
  if (i === 0) return [0, 0];
  const row = Math.ceil(i / 2);
  return [-row * 4.5, (i % 2 ? -1 : 1) * row * 3.8];
}

export class Sim {
  constructor(world) {
    this.world = world;
    const t0 = performance.now();
    this.nav = new NavGrid(world);
    this.navTime = performance.now() - t0;
    this.trenches = new TrenchGraph(world);
    this.units = [];
    this.time = 5 * 3600 + 30 * 60; // 05:30, первый день
    this.queue = [];
    this.digJobs = [];
    this.cleared = []; // зачищенные участки траншей { side, line, t }
    this.events = []; // для интерфейса: { type: 'forts', bbox } | { type: 'msg', text }
    this.rng = new Rng((world.seed ^ 0x5151) >>> 0);
  }

  spawn(side, type, x, y, label) {
    const p = this.nav.nearestPassable(x, y, UNIT_TYPES[type].move) || [x, y];
    const u = new Unit(side, type, p[0], p[1], label);
    this.units.push(u);
    return u;
  }

  msg(text) {
    this.events.push({ type: 'msg', text, t: this.time });
  }

  // ================= Приказы =================

  // Движение группе строем. Отменяет текущие задачи.
  orderMove(units, tx, ty, { stealth = false } = {}) {
    if (!units.length) return;
    for (const u of units) this.resetTask(u);
    let cx = 0, cy = 0;
    for (const u of units) { cx += u.x; cy += u.y; }
    cx /= units.length; cy /= units.length;
    let dx = tx - cx, dy = ty - cy;
    const L = Math.hypot(dx, dy) || 1;
    dx /= L; dy /= L;
    if (L < 1) { dx = Math.cos(units[0].heading); dy = Math.sin(units[0].heading); }
    const px = -dy, py = dx;
    const n = units.length;
    const cols = Math.min(n, Math.max(1, Math.ceil(Math.sqrt(n * 2.5))));
    const spacing = Math.max(...units.map((u) => u.def.spacing));
    const sorted = [...units].sort((a, b) => (a.x * px + a.y * py) - (b.x * px + b.y * py));
    sorted.forEach((u, i) => {
      const row = Math.floor(i / cols);
      const inRow = Math.min(cols, n - row * cols);
      const off = ((i % cols) - (inRow - 1) / 2) * spacing;
      u.stealth = stealth;
      this.moveSingle(u, tx + px * off - dx * row * spacing, ty + py * off - dy * row * spacing);
    });
  }

  // Движение одного отряда без сброса задачи (внутреннее)
  moveSingle(u, x, y) {
    if (u.soldiers && u.mode !== 'field') this.regroup(u);
    if (u.soldiers) for (const s of u.soldiers) if (s.mode === 'dig' || s.mode === 'hold') s.mode = 'follow';
    u.state = 'planning';
    this.queue = this.queue.filter((q) => q.unit !== u);
    this.queue.push({ unit: u, x, y });
  }

  // Бойцы выходят из траншей и снова идут строем за отрядом
  regroup(u) {
    this.centroid(u);
    u.mode = 'field';
    for (const s of u.soldiers) {
      s.mode = 'follow';
      s.path = null;
      s.under = false;
    }
  }

  resetTask(u) {
    if (u.task?.type === 'dig') u.task.job.workers = u.task.job.workers.filter((w) => w !== u);
    u.task = null;
    u.pending = null;
  }

  stop(units) {
    for (const u of units) {
      this.resetTask(u);
      u.path = null;
      u.state = 'idle';
      this.queue = this.queue.filter((q) => q.unit !== u);
      if (u.soldiers) for (const s of u.soldiers) if (s.mode === 'path') { s.path = null; s.mode = u.mode === 'field' ? 'follow' : 'hold'; }
    }
  }

  // Занять траншею у точки: бойцы расходятся по ячейкам лицом к противнику
  orderOccupy(u, x, y) {
    if (!u.soldiers) return false;
    this.trenches.ensure();
    const node = this.trenches.nearest(x, y, 10, true);
    if (node < 0) return false;
    this.resetTask(u);
    const n = this.trenches.nodes[node];
    if (Math.hypot(u.x - n.x, u.y - n.y) > 90) {
      u.pending = { type: 'occupy', x: n.x, y: n.y };
      this.moveSingle(u, n.x, n.y);
      return true;
    }
    this.doOccupy(u, node);
    return true;
  }

  doOccupy(u, node) {
    const g = this.trenches;
    const men = u.soldiers.length;
    const dmap = g.around(node, 14 + men * 4);
    const cand = [...dmap.entries()]
      .map(([id, d]) => ({ id, score: d - (g.nodes[id].kind === 'cell' ? 8 : g.nodes[id].kind === 'fire' ? 2 : 0) }))
      .sort((a, b) => a.score - b.score);
    const slots = [];
    for (const c of cand) {
      const nd = g.nodes[c.id];
      if (slots.every((s) => Math.hypot(g.nodes[s].x - nd.x, g.nodes[s].y - nd.y) >= 4.5)) slots.push(c.id);
      if (slots.length >= men) break;
    }
    while (slots.length < men) slots.push(slots[slots.length % Math.max(1, slots.length)] ?? node);
    const free = [...slots];
    u.mode = 'trench';
    u.task = { type: 'occupy' };
    u.state = 'moving';
    const enemy = SIDES[u.side].enemy;
    for (const s of u.soldiers) {
      // Ближайшее свободное место
      let bi = 0, bd = Infinity;
      free.forEach((id, i) => {
        const d = Math.hypot(g.nodes[id].x - s.x, g.nodes[id].y - s.y);
        if (d < bd) { bd = d; bi = i; }
      });
      const slot = free.splice(bi, 1)[0];
      const item = g.nodes[slot].item;
      const e = item?.enemy || enemy;
      this.soldierTo(u, s, slot, { speed: 1.6, face: Math.atan2(e[1], e[0]) });
    }
  }

  // Путь бойца к узлу графа траншей: по земле до ближайшего входа, дальше по траншеям
  soldierTo(u, s, targetNode, { speed = 1.5, face = null, startAt = 0 } = {}) {
    const g = this.trenches;
    const from = g.nearest(s.x, s.y, 3) >= 0 ? g.nearest(s.x, s.y, 3) : g.nearest(s.x, s.y, 80, true);
    const pts = [{ x: s.x, y: s.y, under: s.under }];
    const nodes = from >= 0 ? g.path(from, targetNode) : null;
    if (nodes) for (const id of nodes) pts.push({ x: g.nodes[id].x, y: g.nodes[id].y, under: g.nodes[id].under });
    else pts.push({ x: g.nodes[targetNode].x, y: g.nodes[targetNode].y, under: g.nodes[targetNode].under });
    s.path = pts;
    s.pathIdx = 1;
    s.mode = 'path';
    s.speed = speed;
    s.face = face;
    s.startAt = startAt;
  }

  // Зачистить траншею до точки: колонной, с остановками на поворотах и развилках
  orderClear(u, x, y) {
    if (!u.soldiers) return false;
    this.trenches.ensure();
    const target = this.trenches.nearest(x, y, 12, true);
    if (target < 0) return false;
    this.resetTask(u);
    this.centroid(u);
    const entry = this.trenches.nearest(u.x, u.y, 90, true);
    if (entry < 0) {
      // Далеко от траншей — сначала подойти к ближайшей точке маршрута
      const t = this.trenches.nodes[target];
      u.pending = { type: 'clear', x, y };
      this.moveSingle(u, t.x, t.y);
      return true;
    }
    return this.doClear(u, entry, target);
  }

  doClear(u, entry, target) {
    const g = this.trenches;
    const nodes = g.path(entry, target);
    if (!nodes || nodes.length < 2) {
      this.msg(`${u.label}: нет пути по траншеям`);
      return false;
    }
    const pts = nodes.map((id) => ({ x: g.nodes[id].x, y: g.nodes[id].y, under: g.nodes[id].under, wait: 0 }));
    for (let i = 1; i + 1 < pts.length; i++) {
      const a = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
      const b = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x);
      const turn = Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
      if (turn > 0.7) pts[i].wait = 2.5; // заглянуть за излом
      if (g.adj[nodes[i]].length > 2) pts[i].wait = Math.max(pts[i].wait, 4); // развилка — проверить отвилок
    }
    const order = [...u.soldiers].sort((a, b) => CLEAR_ORDER.indexOf(a.role) - CLEAR_ORDER.indexOf(b.role));
    order.forEach((s, k) => {
      s.path = [{ x: s.x, y: s.y, under: s.under }, ...pts.map((p) => ({ ...p }))];
      s.pathIdx = 1;
      s.mode = 'path';
      s.speed = 1.0;
      s.startAt = this.time + k * 2.4;
      s.face = null;
    });
    u.mode = 'trench';
    u.state = 'moving';
    u.task = { type: 'clear', line: pts, leader: order[0], progress: 0 };
    return true;
  }

  // Ручное управление одним бойцом
  orderSoldier(u, idx, x, y) {
    const s = u.soldiers?.[idx];
    if (!s) return;
    const g = this.trenches;
    g.ensure();
    if (u.mode === 'field') {
      u.mode = 'trench';
      for (const o of u.soldiers) if (o.mode === 'follow') o.mode = 'hold';
    }
    this.resetTask(u);
    u.task = { type: 'manual' };
    const a = g.nearest(s.x, s.y, 3);
    const b = g.nearest(x, y, 5);
    if (a >= 0 && b >= 0) this.soldierTo(u, s, b, { speed: 1.5 });
    else {
      s.path = [{ x: s.x, y: s.y, under: s.under }, { x, y, under: false }];
      s.pathIdx = 1;
      s.mode = 'path';
      s.speed = 1.5;
      s.face = null;
      s.startAt = 0;
    }
    u.state = 'moving';
  }

  // Рыть траншею по точкам — пехота, сапёры или траншейная машина
  orderDig(units, points) {
    const diggers = units.filter((u) => u.def.dig);
    if (!diggers.length || points.length < 2) return null;
    const line = resample(points, 2);
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
    const job = { id: this.digJobs.length + 1, line, cum, total: cum[cum.length - 1], done: 0, built: 0, side: diggers[0].side, workers: [] };
    this.digJobs.push(job);
    for (const u of diggers) {
      this.resetTask(u);
      u.task = { type: 'dig', job };
      job.workers.push(u);
      const p = this.pointAt(job, 0);
      this.moveSingle(u, p[0], p[1]);
    }
    return job;
  }

  pointAt(job, d) {
    const { line, cum } = job;
    d = Math.max(0, Math.min(job.total, d));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const t = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
    return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
  }

  // ================= Маршруты =================

  processQueue(budgetMs = 8) {
    const t0 = performance.now();
    while (this.queue.length && performance.now() - t0 < budgetMs) {
      const { unit: u, x, y } = this.queue.shift();
      const r = this.nav.findPath(u.x, u.y, x, y, u.moveClass, u.stealth);
      if (!r || r.path.length < 2) {
        u.state = 'idle';
        u.path = null;
        u.noRoute = this.time;
        this.onArrive(u);
        continue;
      }
      u.path = r.path;
      u.pathIdx = 1;
      u.eta = r.time;
      u.state = 'moving';
    }
  }

  onArrive(u) {
    const p = u.pending;
    if (!p) return;
    u.pending = null;
    if (p.type === 'occupy') {
      this.trenches.ensure();
      const node = this.trenches.nearest(p.x, p.y, 12, true);
      if (node >= 0) this.doOccupy(u, node);
    } else if (p.type === 'clear') this.orderClear(u, p.x, p.y);
  }

  // ================= Шаг симуляции =================

  update(dt) {
    this.time += dt;
    this.trenches.ensure();
    for (const u of this.units) {
      if (u.mode === 'field' && u.state === 'moving') this.moveUnit(u, dt);
      if (u.task?.type === 'dig') this.updateDig(u, dt);
      if (u.soldiers) this.updateSoldiers(u, dt);
    }
    this.separate(dt);
  }

  updateSoldiers(u, dt) {
    const c = Math.cos(u.heading), sn = Math.sin(u.heading);
    let anyPath = false;
    for (const s of u.soldiers) {
      if (s.mode === 'follow') {
        const [ox, oy] = formationOffset(s.idx);
        const tx = u.x + ox * c - oy * sn, ty = u.y + ox * sn + oy * c;
        const dx = tx - s.x, dy = ty - s.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.2) {
          const v = Math.min(2.8, d * 1.2 + (u.state === 'moving' ? u.speed : 0));
          const step = Math.min(d, v * dt);
          s.x += (dx / d) * step;
          s.y += (dy / d) * step;
          s.heading = Math.atan2(dy, dx);
        } else if (u.state !== 'moving') s.heading = u.heading;
      } else if (s.mode === 'dig') {
        const dx = s.tx - s.x, dy = s.ty - s.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.3) {
          const step = Math.min(d, 1.4 * dt);
          s.x += (dx / d) * step;
          s.y += (dy / d) * step;
          s.heading = Math.atan2(dy, dx);
        }
      } else if (s.mode === 'path') {
        anyPath = true;
        this.followPath(s, dt);
      }
    }
    if (u.mode !== 'field') {
      this.centroid(u);
      if (!anyPath && u.state === 'moving' && u.task?.type !== 'dig') this.finishTrenchTask(u);
      // Отметка прохода при зачистке
      if (u.task?.type === 'clear') u.task.progress = Math.max(u.task.progress, u.task.leader.pathIdx - 1);
    }
  }

  followPath(s, dt) {
    let remaining = dt;
    while (remaining > 1e-4 && s.path) {
      const now = this.time - remaining;
      if (s.startAt > now) { remaining -= Math.min(remaining, s.startAt - now); continue; }
      if (s.waitUntil > now) { remaining -= Math.min(remaining, s.waitUntil - now); continue; }
      const wp = s.path[s.pathIdx];
      const dx = wp.x - s.x, dy = wp.y - s.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.01) s.heading = Math.atan2(dy, dx);
      const step = s.speed * remaining;
      if (step >= d) {
        s.x = wp.x;
        s.y = wp.y;
        s.under = !!wp.under;
        remaining -= d / s.speed;
        if (wp.wait) s.waitUntil = this.time - remaining + wp.wait;
        s.pathIdx++;
        if (s.pathIdx >= s.path.length) {
          s.path = null;
          s.mode = 'hold';
          if (s.face !== null) s.heading = s.face;
        }
      } else {
        s.x += (dx / d) * step;
        s.y += (dy / d) * step;
        remaining = 0;
      }
    }
  }

  finishTrenchTask(u) {
    u.state = 'idle';
    const t = u.task;
    if (t?.type === 'clear') {
      this.cleared.push({ side: u.side, line: t.line, t: this.time });
      this.msg(`${u.label}: траншея зачищена (${Math.round(lineLen(t.line))} м)`);
    } else if (t?.type === 'occupy') this.msg(`${u.label}: позиция занята`);
    u.task = null;
  }

  centroid(u) {
    if (!u.soldiers) return;
    let x = 0, y = 0;
    for (const s of u.soldiers) { x += s.x; y += s.y; }
    u.x = x / u.soldiers.length;
    u.y = y / u.soldiers.length;
  }

  updateDig(u, dt) {
    const job = u.task.job;
    if (u.state !== 'idle') return; // ещё идут к месту работ
    const front = this.pointAt(job, job.done);
    const reach = u.def.move === 'foot' ? 25 : 10;
    if (Math.hypot(u.x - front[0], u.y - front[1]) > reach + 20) {
      this.moveSingle(u, front[0], front[1]);
      return;
    }
    // Темп: у отделения зависит от числа людей
    const crew = u.soldiers ? u.soldiers.length / u.def.men : 1;
    job.done = Math.min(job.total, job.done + (u.def.dig * crew * dt) / 3600);
    if (u.soldiers) {
      // Бойцы расходятся вдоль участка работ
      u.soldiers.forEach((s, i) => {
        const p = this.pointAt(job, job.done - 1 - (i / u.soldiers.length) * 10);
        const q = this.pointAt(job, job.done + 1);
        const a = Math.atan2(q[1] - p[1], q[0] - p[0]);
        s.mode = 'dig';
        s.tx = p[0] + Math.cos(a + Math.PI / 2) * 1.5;
        s.ty = p[1] + Math.sin(a + Math.PI / 2) * 1.5;
      });
      u.x = front[0]; u.y = front[1];
    } else {
      // Машина идёт по линии со скоростью рытья
      const p = this.pointAt(job, Math.max(0, job.done - 2));
      const q = this.pointAt(job, job.done + 1);
      u.x = p[0]; u.y = p[1];
      u.heading = Math.atan2(q[1] - p[1], q[0] - p[0]);
    }
    // Готовые куски траншеи появляются на карте
    while (job.built * DIG_PIECE < job.total && ((job.built + 1) * DIG_PIECE <= job.done || job.done >= job.total)) {
      const a = this.pointAt(job, job.built * DIG_PIECE);
      const b = this.pointAt(job, Math.min(job.total, (job.built + 1) * DIG_PIECE));
      const items = digTrench(this.world, this.rng, [a, b], job.side, SIDES[job.side].enemy);
      for (const it of items) this.events.push({ type: 'forts', bbox: it.bbox });
      job.built++;
    }
    if (job.done >= job.total) {
      job.finished = true;
      for (const w of job.workers) {
        w.task = null;
        if (w.soldiers) for (const s of w.soldiers) s.mode = 'follow';
      }
      this.digJobs = this.digJobs.filter((j) => j !== job);
      this.msg(`${u.label}: траншея выкопана (${Math.round(job.total)} м)`);
    }
  }

  moveUnit(u, dt) {
    const def = u.def;
    let remaining = dt;
    while (remaining > 1e-4 && u.path) {
      const wp = u.path[u.pathIdx];
      const dx = wp[0] - u.x, dy = wp[1] - u.y;
      const d = Math.hypot(dx, dy);
      const want = Math.atan2(dy, dx);
      let da = want - u.heading;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      const maxTurn = def.turn * remaining;
      u.heading += Math.max(-maxTurn, Math.min(maxTurn, da));

      const terrain = MOVE[def.move][this.nav.classAt(u.x, u.y)] || MOVE[def.move][T.OPEN] * 0.3;
      const turnPenalty = def.move === 'foot' ? 1 : Math.max(0.25, Math.cos(Math.min(Math.abs(da), 1.5)));
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
          this.onArrive(u);
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

  // Мягкое расталкивание отрядов в поле (в траншеях бойцы стоят где поставили)
  separate(dt) {
    const us = this.units.filter((u) => u.mode === 'field' && u.task?.type !== 'dig');
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
    const east = villages.filter((v) => v.x > city.x).sort((a, b) => a.y - b.y);
    const blue = [
      ['tank', 'Т-1'], ['tank', 'Т-2'], ['ifv', '1-я БМП'], ['ifv', '2-я БМП'],
      ['inf', '1-е отд.'], ['inf', '2-е отд.'], ['inf', '3-е отд.'], ['apc', 'БТР-1'],
      ['eng', 'Сапёры-1'], ['btm', 'БТМ-1'],
      ['arty', 'Батарея-1'], ['truck', 'Снабж.-1'], ['truck', 'Снабж.-2'],
    ];
    const red = [
      ['tank', 'Т-71'], ['ifv', '71-я БМП'], ['ifv', '72-я БМП'], ['inf', '71-е отд.'],
      ['inf', '72-е отд.'], ['eng', 'Сапёры-7'], ['apc', 'БТР-71'], ['btm', 'БТМ-7'], ['arty', 'Батарея-7'], ['truck', 'Снабж.-7'],
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
    place(red.slice(0, 5), 'red', rv.x, rv.y, Math.PI, 160);
    place(red.slice(5), 'red', rv2.x, rv2.y, Math.PI, 160);

    // Дежурные отделения в траншеях первой линии — уже на позициях
    for (const side of ['blue', 'red']) {
      const sq = this.units.filter((u) => u.side === side && u.type === 'inf');
      const fire = world.forts.items.filter((f) => f.kind === 'trench' && f.sub === 'fire' && f.side === side);
      if (!sq.length || !fire.length) continue;
      const home = sq[sq.length - 1];
      // Первая линия — ближайшая к серой зоне
      const fx = world.frontX;
      fire.sort((a, b) => Math.abs(a.line[0][0] - fx) - Math.abs(b.line[0][0] - fx) + (Math.abs(a.line[0][1] - home.y) - Math.abs(b.line[0][1] - home.y)) * 0.3);
      const f = fire[0];
      const p = f.line[Math.floor(f.line.length / 2)];
      // Ставим сразу на место и занимаем
      home.x = p[0]; home.y = p[1];
      for (const s of home.soldiers) { s.x = p[0]; s.y = p[1]; }
      this.trenches.ensure();
      const node = this.trenches.nearest(p[0], p[1], 10, true);
      if (node >= 0) this.doOccupy(home, node);
      home.label += ' (на позиции)';
    }
  }
}

function lineLen(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return L;
}
