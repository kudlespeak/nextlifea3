// Симуляция отрядов: типы, бойцы, приказы, построение, движение,
// действия в траншеях (занять, зачистить), рытьё окопов.
// Время — игровые секунды. Без DOM: пригодно для сервера.

import { NavGrid, MOVE, T } from './nav.js';
import { TrenchGraph } from './trenchgraph.js';
import { digTrench } from '../forts.js';
import { Rng } from '../rng.js';
import { resample, pointInPoly } from '../geom.js';
import { LocalGrid } from './localnav.js';
import { Artillery } from './artillery.js';
import { Vision } from './vision.js';
import { Combat } from './combat.js';
import { Drones } from './drones.js';
import { GameMode } from './modes.js';
import { AI } from './ai.js';
import { RoadGraph } from './roads.js';
import { Logistics } from './logistics.js';
import { Autonomy } from './autonomy.js';
import { Construction } from './construct.js';

// Позы бойцов: скорость движения и «заметность» (доля открытого силуэта — для будущих попаданий)
export const POSES = {
  stand:  { name: 'стоя', speed: 1, exposure: 1 },
  crouch: { name: 'пригнувшись', speed: 0.6, exposure: 0.6 },
  prone:  { name: 'лёжа', speed: 0.2, exposure: 0.3 },
  trench: { name: 'в траншее', speed: 0.8, exposure: 0.12 },
  window: { name: 'у окна', speed: 1, exposure: 0.35 },
  inside: { name: 'в здании', speed: 1, exposure: 0.15 },
  under:  { name: 'в укрытии под землёй', speed: 0.7, exposure: 0 },
};

import { FACTIONS, ROLE_WEAPON } from './factions.js';

// Стороны: цвета и направление на противника (названия — из FACTIONS)
export const SIDES = {
  blue: { name: FACTIONS.blue.short, color: FACTIONS.blue.color, fill: FACTIONS.blue.fill, enemy: FACTIONS.blue.enemy },
  red: { name: FACTIONS.red.short, color: FACTIONS.red.color, fill: FACTIONS.red.fill, enemy: FACTIONS.red.enemy },
};

// dig — скорость рытья полнопрофильной траншеи, м/ч (вручную отделением / машиной)
export const UNIT_TYPES = {
  inf:   { name: 'Пехотное отделение', short: 'Пехота', move: 'foot', symbol: 'inf', men: 9, spacing: 55, accel: 1.5, turn: 3, dig: 12 },
  eng:   { name: 'Инженерно-сапёрное отделение', short: 'Сапёры', move: 'foot', symbol: 'eng', men: 8, spacing: 55, accel: 1.5, turn: 3, dig: 30 },
  btm:   { name: 'Траншейная машина (БТМ)', short: 'БТМ', move: 'tracked', symbol: 'engmech', men: 2, spacing: 50, accel: 1.4, turn: 1.0, dig: 350 },
  ifv:   { name: 'БМП', short: 'БМП', move: 'tracked', symbol: 'mech', men: 9, spacing: 50, accel: 2.0, turn: 1.4, seats: 9 },
  apc:   { name: 'БТР', short: 'БТР', move: 'wheeled', symbol: 'motor', men: 10, spacing: 50, accel: 2.2, turn: 1.0, seats: 10 },
  tank:  { name: 'Танк', short: 'Танк', move: 'tracked', symbol: 'armor', men: 3, spacing: 55, accel: 1.8, turn: 1.2 },
  arty:  { name: 'Гаубица 152 мм (буксир.)', short: 'Гаубица', move: 'wheeled', symbol: 'arty', men: 7, spacing: 60, accel: 1.2, turn: 0.8, caliber: 152, reload: 10, setup: 90, ammo: 40 },
  mortar: { name: 'Миномётный расчёт 82 мм', short: 'Миномёт', move: 'foot', symbol: 'mortar', men: 4, spacing: 50, accel: 1.5, turn: 3, caliber: 82, reload: 5, setup: 30, ammo: 60 },
  truck: { name: 'Грузовик снабжения', short: 'Грузовик', move: 'wheeled', symbol: 'supply', men: 2, spacing: 45, accel: 1.6, turn: 0.9, carry: 8, seats: 18 },
  uav:   { name: 'Расчёт БПЛА', short: 'БПЛА', move: 'foot', symbol: 'uav', men: 3, spacing: 50, accel: 1.5, turn: 3 },
  atgm:  { name: 'Расчёт ПТУР', short: 'ПТУР', move: 'foot', symbol: 'atgm', men: 3, spacing: 50, accel: 1.5, turn: 3 },
  spg:   { name: 'САУ', short: 'САУ', move: 'tracked', symbol: 'spg', men: 4, spacing: 60, accel: 1.6, turn: 1.1, caliber: 152, reload: 8, setup: 25, ammo: 40 },
  mlrs:  { name: 'РСЗО', short: 'РСЗО', move: 'wheeled', symbol: 'mlrs', men: 3, spacing: 60, accel: 1.4, turn: 0.9, caliber: 'r122', reload: 0.6, setup: 40, ammo: 40 },
  fuel:  { name: 'Топливозаправщик', short: 'Заправщик', move: 'wheeled', symbol: 'fuel', men: 2, spacing: 45, accel: 1.5, turn: 0.9 },
  armcar: { name: 'Бронеавтомобиль', short: 'Броневик', move: 'wheeled', symbol: 'recon', men: 4, spacing: 50, accel: 2.6, turn: 1.3, seats: 5 },
  sam:   { name: 'ЗРК', short: 'ЗРК', move: 'wheeled', symbol: 'sam', men: 3, spacing: 60, accel: 1.5, turn: 1.0 },
  medevac: { name: 'Санитарная машина', short: 'Санитарка', move: 'wheeled', symbol: 'medic', men: 2, spacing: 45, accel: 1.8, turn: 1.0, carry: 6 },
};

// Описание подразделения с учётом стороны (названия, калибры, броня)
export function unitDef(type, side) {
  const base = UNIT_TYPES[type];
  const f = FACTIONS[side]?.units[type] || {};
  return { ...base, ...f };
}

const ROLES = {
  inf: ['Командир', 'Пулемётчик', 'Гранатомётчик', 'Стрелок', 'Стрелок', 'Снайпер', 'Помощник пулемётчика', 'Медик', 'Стрелок'],
  eng: ['Командир', 'Сапёр', 'Сапёр', 'Сапёр', 'Пулемётчик', 'Сапёр', 'Сапёр', 'Медик'],
  mortar: ['Командир расчёта', 'Наводчик', 'Заряжающий', 'Подносчик'],
  uav: ['Командир расчёта', 'Оператор', 'Оператор'],
  atgm: ['Командир расчёта', 'Оператор ПТУР', 'Подносчик'],
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
    this.def = unitDef(type, side);
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
    this.ammo = this.def.ammo || 0;
    this.hp = 1;
    this.dead = false;
    this.fire = null;
    this.roe = 'free'; // free — огонь свободно, return — только в ответ, hold — не стрелять
    this.cargo = 0; // раненые на борту
    this.underFire = 0;
    this.firedAt = 0;
    this.auto = true; // автономные действия (укрытие, эвакуация, дым и т.п.)
    this.embarked = null; // машина, в которой едет отделение
    this.passengers = []; // десант (для машин)
    if (ROLES[type]) {
      this.soldiers = ROLES[type].map((role, i) => {
        const [ox, oy] = formationOffset(i);
        const c = Math.cos(this.heading), s = Math.sin(this.heading);
        return {
          idx: i, role, x: x + ox * c - oy * s, y: y + ox * s + oy * c, heading: this.heading,
          mode: 'follow', path: null, pathIdx: 0, speed: 1.4, under: false, startAt: 0, waitUntil: 0, face: null,
          stance: 'auto', pose: 'crouch', slot: null, building: null, afterPath: null, inTrench: false,
          hp: 100, dead: false, wounded: 0,
          weapon: ROLE_WEAPON[role] || 'rifle', supp: 0, nextShot: 0, bleed: 0, treated: false, evac: false,
        };
      });
    }
  }
  get moveClass() {
    return this.def.move;
  }
}

// Строй «клин» относительно направления движения; на дороге — колонна по двое
function formationOffset(i, column = false) {
  if (i === 0) return [0, 0];
  if (column) return [-Math.ceil(i / 2) * 3.2, (i % 2 ? -1 : 1) * 1.3];
  const row = Math.ceil(i / 2);
  return [-row * 4.5, (i % 2 ? -1 : 1) * row * 3.8];
}

export class Sim {
  constructor(world) {
    this.world = world;
    const t0 = performance.now();
    this.nav = new NavGrid(world);
    this.navTime = performance.now() - t0;
    this.roads = new RoadGraph(world);
    this.trenches = new TrenchGraph(world);
    this.units = [];
    this.time = 5 * 3600 + 30 * 60; // 05:30, первый день
    this.queue = [];
    this.digJobs = [];
    this.cleared = []; // зачищенные участки траншей { side, line, t }
    this.events = []; // для интерфейса: { type: 'forts', bbox } | { type: 'msg', text }
    this.rng = new Rng((world.seed ^ 0x5151) >>> 0);
    this.art = new Artillery(this);
    this.vision = new Vision(this);
    this.combat = new Combat(this);
    this.drones = new Drones(this);
    this.log = new Logistics(this);
    this.auto = new Autonomy(this);
    this.build = new Construction(this);
    this.medpoints = { blue: [], red: [] }; // медпункты, которые построил игрок / ИИ
    this.intel = { blue: [], red: [] }; // разведданные стороны: засечённые батареи и т.п.
    this.stats = { blue: { kia: 0, wia: 0, evac: 0, lostVeh: 0 }, red: { kia: 0, wia: 0, evac: 0, lostVeh: 0 } };
    this.puppet = false;
    this.unitTypes = UNIT_TYPES; // в сетевой игре у гостя симуляция только отображает присланное состояние
  }

  // Начало партии: время суток, расстановка, режим, ИИ
  setupGame(cfg) {
    this.cfg = cfg;
    this.time = (cfg.startHour ?? 5.5) * 3600;
    const rng = new Rng((this.world.seed ^ 0xa11) >>> 0);
    this.game = new GameMode(this, cfg);
    this.game.deploy(rng);
    this.ais = (cfg.aiSides || []).map((side) => new AI(this, side, cfg.mode, cfg.difficulty));
    this.vision.update(true);
  }

  // Проверка: подразделение уничтожено, если в нём не осталось живых
  checkUnit(u) {
    if (!u.soldiers || u.dead) return;
    const alive = u.soldiers.filter((q) => !q.dead);
    u.strength = alive.length / u.soldiers.length;
    if (!alive.length) {
      u.dead = true;
      this.msg(`${u.label}: подразделение уничтожено`);
    }
  }

  // Эвакуация тяжелораненых: товарищ выносит к санитарной машине / транспорту / в медпункт
  orderEvac(u) {
    if (!u.soldiers) return false;
    const pats = u.soldiers.filter((s) => !s.dead && s.wounded === 2 && !s.evacMove);
    if (!pats.length) { if (!u.soldiers.some((s) => s.evacMove)) this.msg(`${u.label}: тяжелораненых нет`, u.side); return false; }
    const dest = this.evacDest(u);
    if (!dest) { this.msg(`${u.label}: некуда эвакуировать — нет транспорта и медпункта`, u.side); return false; }
    const carriers = this.act(u).filter((s) => s.role !== 'Медик');
    pats.forEach((p, i) => {
      const c = carriers[i % Math.max(1, carriers.length)];
      const route = this.footRoute(p.x, p.y, dest.x, dest.y);
      const delay = c ? Math.hypot(c.x - p.x, c.y - p.y) / 2 + 2 : 0;
      p.path = [{ x: p.x, y: p.y, under: p.under }, ...route.map(([x, y]) => ({ x, y, under: false }))];
      p.pathIdx = 1; p.mode = 'path'; p.speed = 1.0; p.startAt = this.time + delay; p.face = null;
      p.evacMove = true; p.evacUnit = u; p.evacDest = { ...dest }; // своя копия: точку обновляем, если машина переехала
      if (c) {
        c.path = [{ x: c.x, y: c.y, under: c.under }, { x: p.x + 0.7, y: p.y, under: p.under }, ...route.map(([x, y]) => ({ x: x + 0.7, y, under: false }))];
        c.pathIdx = 1; c.mode = 'path'; c.speed = 1.6; c.startAt = 0; c.face = null; c.afterPath = 'follow';
        c.carrying = p;
        // Носильщик ждёт у раненого, чтобы идти вместе
        c.path[1].wait = Math.max(0, delay - Math.hypot(c.x - p.x, c.y - p.y) / 1.6);
      }
    });
    u.state = 'moving';
    this.msg(`${u.label}: эвакуация ${pats.length} раненых → ${dest.label}`, u.side);
    return true;
  }

  evacDest(u) {
    let best = null, bd = 900;
    for (const v of this.units) {
      if (v.side !== u.side || v.dead || v.soldiers || !v.def.carry) continue;
      const d = Math.hypot(v.x - u.x, v.y - u.y) * (v.type === 'medevac' ? 0.5 : 1);
      if (d < bd) { bd = d; best = v; }
    }
    if (best) return { x: best.x, y: best.y, vehicle: best, label: best.label };
    const m = this.nearestMed(u.side, u.x, u.y);
    return m ? { x: m.x, y: m.y, label: m.name } : null;
  }

  // Ближайший работающий медпункт; если своих нет — тыл (пункт сбора)
  nearestMed(side, x, y) {
    let best = null, bd = Infinity;
    for (const m of this.medpoints[side]) {
      if (!m.alive || m.built < 1) continue;
      const d = Math.hypot(m.x - x, m.y - y);
      if (d < bd) { bd = d; best = m; }
    }
    if (best) return best;
    const sp = this.game?.reserve?.[side]?.spawn;
    return sp ? { x: sp.x, y: sp.y, name: 'тыл (пункт сбора)', rear: true } : null;
  }

  // Пеший маршрут: вблизи — точная сетка, далеко — общая
  footRoute(ax, ay, bx, by) {
    const d = Math.hypot(bx - ax, by - ay);
    if (d < 220) {
      const fp = new LocalGrid(this.world, bboxPts([[ax, ay], [bx, by]], 8)).path(ax, ay, bx, by);
      if (fp) return fp.slice(1);
    }
    const r = this.nav.findPath(ax, ay, bx, by, 'foot');
    return r ? r.path.slice(1) : [[bx, by]];
  }

  evacArrive(s) {
    const u = s.evacUnit, dest = s.evacDest;
    // Носильщик возвращается к своим
    for (const c of u.soldiers) if (c.carrying === s) { c.carrying = null; c.path = null; c.mode = u.mode === 'field' ? 'follow' : 'hold'; }
    s.evacMove = false;
    s.evac = true;
    s.dead = true; // выбыл из подразделения (жив, но эвакуирован)
    s.mode = 'dead';
    if (dest.vehicle && !dest.vehicle.dead) dest.vehicle.cargo++;
    else this.stats[u.side].evac++;
    this.msg(`${u.label}: ${s.role.toLowerCase()} эвакуирован (${dest.label})`, u.side);
    this.checkUnit(u);
  }

  // Бойцы, способные выполнять приказы (живые и не тяжело раненые)
  act(u) {
    return u.soldiers ? u.soldiers.filter((s) => !s.dead && s.wounded < 2) : [];
  }

  spawn(side, type, x, y, label) {
    const p = this.nav.nearestPassable(x, y, UNIT_TYPES[type].move) || [x, y];
    const u = new Unit(side, type, p[0], p[1], label);
    this.log.init(u);
    this.units.push(u);
    return u;
  }

  msg(text, side = null) {
    this.events.push({ type: 'msg', text, t: this.time, side });
  }

  // ================= Приказы =================

  // Движение группе строем. Отменяет текущие задачи.
  orderMove(units, tx, ty, { stealth = false, direct = false } = {}) {
    // Отделение в машине по приказу «идти» спешивается и идёт само
    for (const u of units) if (u.embarked) this.disembark(u);
    if (!units.length) return;
    for (const u of units) this.resetTask(u);
    // Смешанная группа (пехота + техника) идёт вместе — техника не отрывается
    const mixed = units.some((u) => u.def.move === 'foot') && units.some((u) => u.def.move !== 'foot');
    for (const u of units) u.speedCap = mixed && u.def.move !== 'foot' ? MOVE.foot[T.ROAD] * 1.05 : 0;
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
      u.direct = direct;
      this.moveSingle(u, tx + px * off - dx * row * spacing, ty + py * off - dy * row * spacing);
    });
  }

  // Движение одного отряда без сброса задачи (внутреннее)
  // Во время подготовки — только своя половина карты
  prepBlocked(u, x) {
    const g = this.game;
    return !!g?.prep && g.clampPrep(u.side, x) !== x;
  }

  moveSingle(u, x, y) {
    if (this.game?.prep) x = this.game.clampPrep(u.side, x);
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
    for (const s of this.act(u)) {
      s.slot = null;
      const exit = this.exitPath(s);
      if (exit) {
        s.path = exit;
        s.pathIdx = 1;
        s.mode = 'path';
        s.speed = 2.2;
        s.face = null;
        s.startAt = 0;
        s.afterPath = 'follow';
      } else {
        s.mode = 'follow';
        s.path = null;
        s.under = false;
      }
      s.building = null;
    }
  }

  // Выход из подвала / здания / подземного хода на улицу
  exitPath(s) {
    const pts = [{ x: s.x, y: s.y, under: s.under }];
    let x = s.x, y = s.y;
    const b = s.building;
    if (s.under && b?.interior?.basement) {
      const acc = nearestPt(b.interior.basement.access, x, y);
      pts.push({ x: acc[0], y: acc[1], under: true }, { x: acc[0], y: acc[1], under: false });
      x = acc[0]; y = acc[1];
    } else if (s.under) {
      // Из блиндажа / подземного хода — по графу к ближайшему выходу на поверхность
      const g = this.trenches;
      const a = g.nearest(x, y, 6), t = g.nearest(x, y, 80, true);
      const nodes = a >= 0 && t >= 0 ? g.path(a, t) : null;
      if (nodes) for (const id of nodes) pts.push({ x: g.nodes[id].x, y: g.nodes[id].y, under: g.nodes[id].under });
      return pts.length > 1 ? pts : null;
    }
    if (b?.interior) {
      const doors = b.interior.doors.filter((d) => d.ext);
      if (!doors.length) return pts.length > 1 ? pts : null;
      const d = doors.reduce((best, q) => (Math.hypot(q.p[0] - x, q.p[1] - y) < Math.hypot(best.p[0] - x, best.p[1] - y) ? q : best));
      const out = [d.p[0] + d.n[0] * 2.5, d.p[1] + d.n[1] * 2.5];
      const grid = new LocalGrid(this.world, bboxPts([[x, y], out], 6));
      const fp = grid.path(x, y, out[0], out[1]);
      if (fp) for (const q of fp.slice(1)) pts.push({ x: q[0], y: q[1], under: false });
    }
    return pts.length > 1 ? pts : null;
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

  // ================= Десант =================
  seatsFree(v) {
    if (!v.def.seats || v.dead) return 0;
    const used = v.passengers.reduce((a, p) => a + this.act(p).length + p.soldiers.filter((q) => !q.dead && q.wounded === 2).length, 0);
    return v.def.seats - used;
  }

  // Посадка: отделение идёт к машине и садится; машина ждёт на месте
  orderBoard(u, v) {
    if (!u.soldiers || u.embarked || !v || v.dead || v.side !== u.side) return false;
    const need = u.soldiers.filter((q) => !q.dead).length;
    if (this.seatsFree(v) < need) { this.msg(`${v.label}: нет мест для ${u.label} (свободно ${this.seatsFree(v)})`, u.side); return false; }
    this.resetTask(u);
    if (Math.hypot(u.x - v.x, u.y - v.y) < 30) { this.embark(u, v); return true; }
    u.pending = { type: 'board', v };
    u.stealth = false; u.direct = false;
    this.moveSingle(u, v.x - Math.cos(v.heading) * 6, v.y - Math.sin(v.heading) * 6);
    return true;
  }

  embark(u, v) {
    if (v.dead || this.seatsFree(v) < u.soldiers.filter((q) => !q.dead).length) { this.msg(`${u.label}: посадка невозможна`, u.side); return; }
    if (u.mode !== 'field') { u.mode = 'field'; }
    u.embarked = v;
    v.passengers.push(u);
    u.path = null; u.state = 'idle'; u.speed = 0; u.task = null; u.pending = null;
    this.queue = this.queue.filter((q) => q.unit !== u);
    for (const s of u.soldiers) { s.path = null; if (!s.dead) s.mode = 'follow'; s.x = v.x; s.y = v.y; s.under = false; s.building = null; s.slot = null; }
    this.msg(`${u.label}: посадка в ${v.label}`, u.side);
  }

  // Высадка у кормы машины
  disembark(u, quiet = false) {
    const v = u.embarked;
    if (!v) return;
    v.passengers = v.passengers.filter((p) => p !== u);
    u.embarked = null;
    const bx = v.x - Math.cos(v.heading) * 7, by = v.y - Math.sin(v.heading) * 7;
    const p = this.nav.nearestPassable(bx, by, 'foot') || [bx, by];
    u.x = p[0]; u.y = p[1]; u.heading = v.heading; u.mode = 'field'; u.state = 'idle';
    u.soldiers.forEach((s, i) => {
      if (s.dead) return;
      const a = v.heading + Math.PI + (i - 4) * 0.35;
      s.x = u.x + Math.cos(a) * (1 + (i % 3)); s.y = u.y + Math.sin(a) * (1 + (i % 3));
      s.mode = 'follow'; s.heading = v.heading;
    });
    if (!quiet) this.msg(`${u.label}: высадка`, u.side);
  }

  orderUnload(v) {
    for (const p of [...v.passengers]) this.disembark(p);
  }

  // Занять траншею у точки: бойцы расходятся по ячейкам лицом к противнику
  orderOccupy(u, x, y) {
    if (!u.soldiers) return false;
    if (this.prepBlocked(u, x)) { this.msg('Подготовка: за линию разграничения выдвигаться нельзя', u.side); return true; }
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
    const men = Math.max(1, this.act(u).length);
    const dmap = g.around(node, 14 + men * 4);
    const cand = [...dmap.entries()]
      .map(([id, d]) => ({ id, score: d - (g.nodes[id].kind === 'cell' ? 8 : g.nodes[id].kind === 'fire' ? 2 : 0) }))
      .sort((a, b) => a.score - b.score);
    // Если связанный участок короткий — добавляем соседние траншеи поблизости
    const n0 = g.nodes[node];
    for (const id of g.near(n0.x, n0.y, 45)) {
      if (g.nodes[id].under || dmap.has(id)) continue;
      cand.push({ id, score: Math.hypot(g.nodes[id].x - n0.x, g.nodes[id].y - n0.y) * 1.4 + 5 });
    }
    cand.sort((a, b) => a.score - b.score);
    const slots = [];
    for (const c of cand) {
      const nd = g.nodes[c.id];
      if (slots.every((s) => Math.hypot(g.nodes[s].x - nd.x, g.nodes[s].y - nd.y) >= 4.5)) slots.push(c.id);
      if (slots.length >= men) break;
    }
    // Мест всё равно мало — допускаем более плотную расстановку, но не в одну точку
    for (const minD of [3, 2]) {
      if (slots.length >= men) break;
      for (const c of cand) {
        if (slots.length >= men) break;
        const nd = g.nodes[c.id];
        if (!slots.includes(c.id) && slots.every((s) => Math.hypot(g.nodes[s].x - nd.x, g.nodes[s].y - nd.y) >= minD)) slots.push(c.id);
      }
    }
    while (slots.length < men) slots.push(slots[slots.length % Math.max(1, slots.length)] ?? node);
    const free = [...slots];
    u.mode = 'trench';
    u.task = { type: 'occupy' };
    u.state = 'moving';
    const enemy = SIDES[u.side].enemy;
    for (const s of this.act(u)) {
      // Ближайшее свободное место
      let bi = 0, bd = Infinity;
      free.forEach((id, i) => {
        const d = Math.hypot(g.nodes[id].x - s.x, g.nodes[id].y - s.y);
        if (d < bd) { bd = d; bi = i; }
      });
      const slot = free.splice(bi, 1)[0];
      const item = g.nodes[slot].item;
      const e = item?.enemy || enemy;
      this.soldierTo(u, s, slot, { speed: 2.2, face: Math.atan2(e[1], e[0]) });
    }
  }

  // Путь бойца к узлу графа траншей: по земле до ближайшего входа, дальше по траншеям
  soldierTo(u, s, targetNode, { speed = 2.0, face = null, startAt = 0 } = {}) {
    const g = this.trenches;
    const from = g.nearest(s.x, s.y, 3) >= 0 ? g.nearest(s.x, s.y, 3) : g.nearest(s.x, s.y, 80, true);
    const pts = [{ x: s.x, y: s.y, under: s.under }];
    const nodes = from >= 0 ? g.path(from, targetNode) : null;
    // По земле до входа в траншею — с обходом домов и заборов
    if (nodes && !s.under) {
      const e = g.nodes[nodes[0]];
      if (Math.hypot(e.x - s.x, e.y - s.y) > 3) {
        const fp = new LocalGrid(this.world, bboxPts([[s.x, s.y], [e.x, e.y]], 6)).path(s.x, s.y, e.x, e.y);
        if (fp) for (const q of fp.slice(1, -1)) pts.push({ x: q[0], y: q[1], under: false });
      }
    }
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
    if (this.prepBlocked(u, x)) { this.msg('Подготовка: за линию разграничения выдвигаться нельзя', u.side); return false; }
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
    const order = this.act(u).sort((a, b) => CLEAR_ORDER.indexOf(a.role) - CLEAR_ORDER.indexOf(b.role));
    if (!order.length) return false;
    order.forEach((s, k) => {
      s.path = [{ x: s.x, y: s.y, under: s.under }, ...pts.map((p) => ({ ...p }))];
      s.pathIdx = 1;
      s.mode = 'path';
      s.speed = 1.3;
      s.startAt = this.time + k * 2.0;
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
    if (!s || s.dead || s.wounded === 2) { this.msg('Боец не может двигаться'); return; }
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
    const target = this.buildingAt(x, y);
    if (a >= 0 && b >= 0 && !target) this.soldierTo(u, s, b, { speed: 2.0 });
    else {
      // Сначала выбраться из подвала/траншейного укрытия, затем — точный путь с обходом стен
      const pre = s.under ? this.exitPath(s) || [{ x: s.x, y: s.y, under: s.under }] : [{ x: s.x, y: s.y, under: false }];
      const last = pre[pre.length - 1];
      const fp = new LocalGrid(this.world, bboxPts([[last.x, last.y], [x, y]], 8)).path(last.x, last.y, x, y);
      const pts = [...pre];
      if (fp) for (const q of fp.slice(1)) pts.push({ x: q[0], y: q[1], under: false });
      else pts.push({ x, y, under: false });
      s.path = pts;
      s.pathIdx = 1;
      s.mode = 'path';
      s.speed = 2.0;
      s.face = null;
      s.startAt = 0;
    }
    s.slot = null;
    s.building = target;
    u.state = 'moving';
  }

  // Здание под точкой (с планировкой)
  buildingAt(x, y) {
    for (const b of this.world.buildings.query({ x0: x - 0.5, y0: y - 0.5, x1: x + 0.5, y1: y + 0.5 }))
      if (b.interior && pointInPoly(x, y, b.poly)) return b;
    return null;
  }

  solidAt(x, y) {
    for (const b of this.world.buildings.query({ x0: x - 0.3, y0: y - 0.3, x1: x + 0.3, y1: y + 0.3 }))
      if (pointInPoly(x, y, b.poly)) return true;
    return false;
  }

  // Занять здание: бойцы у окон, в первую очередь — смотрящих на противника
  orderGarrison(u, b) {
    if (!u.soldiers || !b?.interior) return false;
    if (this.prepBlocked(u, b.x)) { this.msg('Подготовка: за линию разграничения выдвигаться нельзя', u.side); return false; }
    this.resetTask(u);
    if (Math.hypot(u.x - b.x, u.y - b.y) > 35 + Math.max(b.w, b.h) / 2) {
      u.pending = { type: 'garrison', b };
      const d = b.interior.doors.find((q) => q.ext) || { p: [b.x, b.y], n: [0, 0] };
      this.moveSingle(u, d.p[0] + d.n[0] * 6, d.p[1] + d.n[1] * 6);
      return true;
    }
    const enemy = SIDES[u.side].enemy;
    const slots = b.interior.windows
      .map((w) => ({ p: [w.p[0] - w.n[0] * 0.6, w.p[1] - w.n[1] * 0.6], face: Math.atan2(w.n[1], w.n[0]), score: w.n[0] * enemy[0] + w.n[1] * enemy[1], kind: 'window' }))
      .sort((a, c) => c.score - a.score);
    // Если окон меньше, чем людей, — остальные в комнатах
    for (const r of b.interior.rooms) slots.push({ p: r.c, face: null, score: -2, kind: 'inside' });
    // Разнесём по окнам: не ближе 1.5 м друг к другу
    const chosen = [];
    for (const sl of slots) {
      if (chosen.length >= this.act(u).length) break;
      if (chosen.every((c) => Math.hypot(c.p[0] - sl.p[0], c.p[1] - sl.p[1]) > 1.5 || sl.kind === 'inside')) chosen.push(sl);
    }
    this.sendToSlots(u, b, chosen, false);
    u.task = { type: 'garrison', b };
    return true;
  }

  // Укрыться в подвале / погребе
  orderBasement(u, b) {
    const bs = b?.interior?.basement;
    if (!u.soldiers || !bs) return false;
    this.resetTask(u);
    if (Math.hypot(u.x - b.x, u.y - b.y) > 35 + Math.max(b.w, b.h) / 2) {
      u.pending = { type: 'basement', b };
      const d = b.interior.doors.find((q) => q.ext) || { p: [b.x, b.y], n: [0, 0] };
      this.moveSingle(u, d.p[0] + d.n[0] * 6, d.p[1] + d.n[1] * 6);
      return true;
    }
    const chosen = this.act(u).map((_, i) => ({ p: bs.spots[i % bs.spots.length], face: null, kind: 'basement' }));
    this.sendToSlots(u, b, chosen, true);
    u.task = { type: 'basement', b };
    if (u.soldiers.length > bs.capacity) this.msg(`${u.label}: ${bs.kind} тесный — все не поместятся с удобством`);
    return true;
  }

  sendToSlots(u, b, slots, basement) {
    const bs = b.interior.basement;
    const grid = new LocalGrid(this.world, bboxPts([...this.act(u).map((q) => [q.x, q.y]), ...b.poly], 6));
    const free = [...slots];
    u.mode = 'trench';
    u.state = 'moving';
    for (const s of this.act(u)) {
      let bi = 0, bd = Infinity;
      free.forEach((sl, i) => {
        const d = Math.hypot(sl.p[0] - s.x, sl.p[1] - s.y);
        if (d < bd) { bd = d; bi = i; }
      });
      const sl = free.splice(bi, 1)[0] || slots[0];
      const pre = s.under && s.building !== b ? this.exitPath(s) || [{ x: s.x, y: s.y, under: s.under }] : [{ x: s.x, y: s.y, under: s.under }];
      const start = pre[pre.length - 1];
      const pts = [...pre];
      const goal = basement ? nearestPt(bs.access, start.x, start.y) : sl.p;
      if (!(s.under && s.building === b && basement)) {
        const fp = grid.path(start.x, start.y, goal[0], goal[1]);
        if (fp) for (const q of fp.slice(1)) pts.push({ x: q[0], y: q[1], under: false });
        else pts.push({ x: goal[0], y: goal[1], under: false });
      }
      if (basement) {
        pts.push({ x: goal[0], y: goal[1], under: true, wait: 1.5 }); // спуск по лестнице/в лаз
        pts.push({ x: sl.p[0], y: sl.p[1], under: true });
      }
      s.path = pts;
      s.pathIdx = 1;
      s.mode = 'path';
      s.speed = 2.0;
      s.face = sl.face;
      s.startAt = 0;
      s.slot = sl.kind;
      s.building = b;
    }
  }

  setStance(u, stance, idx = null) {
    if (!u.soldiers) return;
    for (const s of u.soldiers) if (idx === null || s.idx === idx) s.stance = stance;
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
      const r = this.route(u, x, y);
      if (!r || r.path.length < 2) {
        u.state = 'idle';
        u.path = null;
        u.noRoute = this.time;
        this.onArrive(u);
        continue;
      }
      this.setPath(u, r.path);
      u.eta = r.time;
      u.state = 'moving';
      u.onRoad = !!r.road;
    }
  }

  setPath(u, path) {
    u.path = path;
    u.pathIdx = 1;
    u.pathCum = [0];
    for (let i = 1; i < path.length; i++) u.pathCum.push(u.pathCum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  }

  // Выбор маршрута: по дорогам (если не сильно дольше), напрямик или скрытно — по местности
  route(u, x, y) {
    const move = u.moveClass;
    const grid = this.nav.findPath(u.x, u.y, x, y, move, u.stealth, u.direct);
    if (u.stealth || u.direct || Math.hypot(x - u.x, y - u.y) < 300) return grid;
    const rd = this.roads.route(u.x, u.y, x, y, move, (ax, ay, bx, by) => this.nav.findPath(ax, ay, bx, by, move));
    if (!rd) return grid;
    // Дороги предпочтительнее: техника — если не дольше чем на 35%, пехота — на 10%
    const k = move === 'foot' ? 1.1 : 1.35;
    if (!grid || rd.time < grid.time * k) return { ...rd, road: true };
    return grid;
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
    else if (p.type === 'garrison') this.orderGarrison(u, p.b);
    else if (p.type === 'board') this.orderBoard(u, p.v);
    else if (p.type === 'basement') this.orderBasement(u, p.b);
  }

  // ================= Шаг симуляции =================

  update(dt) {
    this.time += dt;
    this.trenches.ensure();
    this.vision.update();
    this.art.update();
    this.drones.update(dt);
    this.combat.update(dt);
    this.auto.update();
    this.log.update(dt);
    this.build.update(dt);
    this.game?.update(dt);
    for (const side of ['blue', 'red']) this.intel[side] = this.intel[side].filter((m) => m.until > this.time);
    for (const ai of this.ais || []) ai.update();
    // Санитарные машины и транспорт сдают раненых в медпункте
    for (const v of this.units) {
      if (v.dead || !v.cargo) continue;
      const m = this.nearestMed(v.side, v.x, v.y);
      if (m && Math.hypot(v.x - m.x, v.y - m.y) < 80) {
        this.stats[v.side].evac += v.cargo;
        this.msg(`${v.label}: доставлено раненых — ${v.cargo} (${m.name})`, v.side);
        v.cargo = 0;
      }
    }
    // Раненый рядом с машиной, в которую его несут, — грузим сразу (машина могла подъехать сама)
    for (const u of this.units) {
      if (!u.soldiers) continue;
      for (const s of u.soldiers) {
        const v = s.evacMove && s.evacDest?.vehicle;
        if (!v || v.dead) continue;
        if (Math.hypot(s.x - v.x, s.y - v.y) < 14) { this.evacArrive(s); continue; }
        // Машина переехала — несём к ней, а не к старой точке
        if (Math.hypot(v.x - s.evacDest.x, v.y - s.evacDest.y) > 20) {
          s.evacDest.x = v.x; s.evacDest.y = v.y;
          s.path = [{ x: s.x, y: s.y, under: false }, { x: v.x, y: v.y, under: false }];
          s.pathIdx = 1;
          for (const c of u.soldiers) if (c.carrying === s && c.mode === 'path') { c.path = [{ x: c.x, y: c.y, under: false }, { x: v.x + 0.7, y: v.y, under: false }]; c.pathIdx = 1; }
        }
      }
    }
    for (const u of this.units) {
      if (u.dead && !u.soldiers) continue;
      if (u.embarked) {
        // Десант едет в машине
        const v = u.embarked;
        u.x = v.x; u.y = v.y; u.heading = v.heading;
        for (const s of u.soldiers) if (!s.dead) { s.x = v.x; s.y = v.y; s.heading = v.heading; }
        continue;
      }
      // Идут на посадку: машина рядом — садимся, не дожидаясь конца маршрута
      if (u.pending?.type === 'board' && Math.hypot(u.x - u.pending.v.x, u.y - u.pending.v.y) < 25) {
        const v = u.pending.v;
        u.pending = null;
        this.embark(u, v);
        continue;
      }
      if (u.pending?.type === 'board' && u.state === 'idle' && !this.queue.some((q) => q.unit === u)) this.orderBoard(u, u.pending.v); // машина уехала — догоняем
      if (u.mode === 'field' && u.state === 'moving') this.moveUnit(u, dt);
      if (u.task?.type === 'dig') this.updateDig(u, dt);
      if (u.soldiers) this.updateSoldiers(u, dt);
    }
    this.separate(dt);
  }

  updateSoldiers(u, dt) {
    const c = Math.cos(u.heading), sn = Math.sin(u.heading);
    const cl = this.nav.classAt(u.x, u.y);
    const column = u.state === 'moving' && (cl === T.ROAD || cl === T.DIRT);
    let anyPath = false;
    for (const s of u.soldiers) {
      if (s.dead) { s.pose = 'dead'; continue; }
      if (s.wounded === 2 && !s.evacMove) { s.pose = 'prone'; s.moving = false; continue; }
      if (s.mode === 'follow') {
        this.followLoose(u, s, dt, column, c, sn);
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
      s.pose = this.poseOf(u, s);
      s.moving = false;
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
      s.moving = true;
      const speed = s.speed * (s.stance === 'auto' ? 1 : POSES[s.stance].speed) * (s.wounded ? 0.6 : 1);
      const step = speed * remaining;
      if (step >= d) {
        s.x = wp.x;
        s.y = wp.y;
        s.under = !!wp.under;
        remaining -= d / speed;
        if (wp.wait) s.waitUntil = this.time - remaining + wp.wait;
        s.pathIdx++;
        if (s.pathIdx >= s.path.length) {
          s.path = null;
          if (s.evacMove) { this.evacArrive(s); return; }
          s.mode = s.afterPath || 'hold';
          s.afterPath = null;
          if (s.face !== null) s.heading = s.face;
          s.inTrench = this.trenches.nearest(s.x, s.y, 1.3) >= 0;
        }
      } else {
        s.x += (dx / d) * step;
        s.y += (dy / d) * step;
        s.walk = (s.walk || 0) + step;
        remaining = 0;
      }
    }
  }

  // Боец идёт за отделением не «по линейке»: свободный строй с личным смещением и темпом,
  // под огнём — перебежки (половина бежит, половина лежит и прикрывает), на остановке —
  // каждый занимает ближайшее укрытие (воронка, дерево, угол дома).
  followLoose(u, s, dt, column, c, sn) {
    const t = this.time;
    if (s.pace === undefined) {
      const h = ((s.idx * 7919 + u.id * 104729) % 1000) / 1000;
      s.pace = 0.88 + h * 0.24;
      s.jx = s.jy = s.jtx = s.jty = 0; s.jt = 0; s.v = 0;
    }
    if (t > s.jt) {
      s.jt = t + 2 + this.rng.next() * 3;
      const k = column ? 0.6 : 2.2;
      s.jtx = (this.rng.next() - 0.5) * 2 * k; s.jty = (this.rng.next() - 0.5) * 2 * k;
    }
    const kj = Math.min(1, dt * 0.6);
    s.jx += (s.jtx - s.jx) * kj; s.jy += (s.jty - s.jy) * kj;
    const spread = column ? 1 : 1.35;
    const [ox0, oy0] = formationOffset(s.idx, column);
    const ox = ox0 * spread + s.jx, oy = oy0 * spread + s.jy;
    let tx = u.x + ox * c - oy * sn, ty = u.y + ox * sn + oy * c;
    const moving = u.state === 'moving';
    // Перебежки под огнём: чётные и нечётные меняются каждые ~6 с
    s.bounding = false;
    if (moving && !column && u.underFire && t - u.underFire < 15) {
      const phase = Math.floor(t / 6) % 2;
      if (s.idx % 2 === phase && s.idx !== 0) {
        s.bounding = true;
        // Лежит и прикрывает, пока не отстанет больше чем на 12 м
        if (Math.hypot(tx - s.x, ty - s.y) < 12) { tx = s.x; ty = s.y; }
      }
    }
    // Остановка в поле — к ближайшему укрытию
    if (!moving && u.mode === 'field') {
      if (!s.cover || t > (s.coverCheck || 0)) {
        s.coverCheck = t + 10;
        s.cover = this.findCover(u, s, tx, ty);
      }
      if (s.cover) { tx = s.cover[0]; ty = s.cover[1]; }
    } else s.cover = null;
    const dx = tx - s.x, dy = ty - s.y;
    const d = Math.hypot(dx, dy);
    s.inCover = !!s.cover && d < 1.2;
    if (d > 0.25) {
      const want = Math.min(4, d * 1.1 + (moving ? u.speed : 0)) * s.pace * (s.stance === 'auto' ? 1 : POSES[s.stance].speed) * (s.wounded ? 0.6 : 1) * (s.supp > 6 ? 0.5 : 1);
      // Разгон и торможение, а не мгновенная скорость
      s.v += Math.max(-4 * dt, Math.min(3 * dt, want - s.v));
      const step = Math.min(d, Math.max(0, s.v) * dt);
      const nx = s.x + (dx / d) * step, ny = s.y + (dy / d) * step;
      // Сквозь дома не ходим — скользим вдоль стены
      if (!this.solidAt(nx, ny) || this.solidAt(s.x, s.y)) { s.x = nx; s.y = ny; }
      else if (!this.solidAt(nx, s.y)) s.x = nx;
      else if (!this.solidAt(s.x, ny)) s.y = ny;
      const wantH = Math.atan2(dy, dx);
      s.heading += Math.atan2(Math.sin(wantH - s.heading), Math.cos(wantH - s.heading)) * Math.min(1, dt * 6);
      s.moving = step > 0.01;
      s.walk = (s.walk || 0) + step;
    } else {
      s.v = 0;
      // Стоит: осматривается — в сторону противника с небольшими поворотами головы
      const e = SIDES[u.side].enemy;
      const look = Math.atan2(e[1], e[0]) + Math.sin(t * 0.3 + s.idx * 1.7) * 0.9;
      s.heading += Math.atan2(Math.sin(look - s.heading), Math.cos(look - s.heading)) * Math.min(1, dt * 1.5);
    }
  }

  // Ближайшее свободное укрытие в 16 м: воронки, деревья, углы домов
  findCover(u, s, x, y) {
    const R = 16;
    const taken = u.soldiers.filter((q) => q !== s && q.cover).map((q) => q.cover);
    const free = (px, py) => taken.every((c) => Math.hypot(c[0] - px, c[1] - py) > 2.2);
    let best = null, bd = R;
    const e = SIDES[u.side].enemy;
    for (const c of this.world.scars.query({ x0: x - R, y0: y - R, x1: x + R, y1: y + R })) {
      if (c.kind !== 'crater' || c.r < 1.1) continue;
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bd && free(c.x, c.y)) { bd = d; best = [c.x, c.y]; }
    }
    this.world.trees.forEach({ x0: x - R, y0: y - R, x1: x + R, y1: y + R }, (arr, i) => {
      if (arr[i + 2] < 2) return;
      // За стволом — со стороны своих
      const px = arr[i] - e[0] * 1.2, py = arr[i + 1] - e[1] * 1.2;
      const d = Math.hypot(px - x, py - y) + 1.5; // воронка предпочтительнее
      if (d < bd && free(px, py) && !this.solidAt(px, py)) { bd = d; best = [px, py]; }
    });
    for (const b of this.world.buildings.query({ x0: x - R, y0: y - R, x1: x + R, y1: y + R })) {
      if (b.collapsed || !b.poly) continue;
      for (const p of b.poly) {
        const px = p[0] - e[0] * 1.3 + (p[0] - b.x) * 0.12, py = p[1] - e[1] * 1.3 + (p[1] - b.y) * 0.12;
        const d = Math.hypot(px - x, py - y) + 1;
        if (d < bd && free(px, py) && !this.solidAt(px, py)) { bd = d; best = [px, py]; }
      }
    }
    return best;
  }

  // Поза: ручная, либо по обстановке
  poseOf(u, s) {
    if (s.dead) return 'dead';
    if (s.wounded === 2) return 'prone';
    if (s.under) return 'under';
    // Под плотным огнём — прижимаются к земле (если не в укрытии)
    const covered = (s.mode === 'hold' && (s.inTrench || s.slot === 'window' || s.slot === 'inside'));
    if (!covered && s.supp > 4 && s.stance === 'auto') return 'prone';
    if (s.stance === 'auto' && s.mode === 'follow' && (s.bounding && !s.moving || s.inCover)) return 'prone';
    const moving = s.moving && !(s.waitUntil > this.time) && !(s.startAt > this.time);
    if (!moving && s.slot === 'window') return 'window';
    if (!moving && s.slot === 'inside') return 'inside';
    if (!moving && s.mode === 'hold' && s.inTrench) return 'trench';
    if (s.stance !== 'auto') return s.stance;
    if (u.task?.type === 'clear' || u.task?.type === 'garrison') return 'crouch';
    if (moving) return 'stand';
    if (s.mode === 'dig') return 'crouch';
    if (s.mode === 'hold') return s.building ? 'inside' : 'prone';
    return 'crouch';
  }

  finishTrenchTask(u) {
    u.state = 'idle';
    const t = u.task;
    if (t?.type === 'clear') {
      this.cleared.push({ side: u.side, line: t.line, t: this.time });
      this.msg(`${u.label}: траншея зачищена (${Math.round(lineLen(t.line))} м)`);
    } else if (t?.type === 'occupy') this.msg(`${u.label}: позиция занята`);
    else if (t?.type === 'garrison') this.msg(`${u.label}: здание занято, бойцы у окон`);
    else if (t?.type === 'basement') this.msg(`${u.label}: укрылись (${t.b.interior.basement.kind})`);
    u.task = null;
  }

  centroid(u) {
    if (!u.soldiers) return;
    const alive = u.soldiers.filter((s) => !s.dead);
    if (!alive.length) return;
    let x = 0, y = 0;
    for (const s of alive) { x += s.x; y += s.y; }
    u.x = x / alive.length;
    u.y = y / alive.length;
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
    const crew = u.soldiers ? this.act(u).length / u.def.men : 1;
    job.done = Math.min(job.total, job.done + (u.def.dig * crew * dt) / 3600);
    if (u.soldiers) {
      // Бойцы расходятся вдоль участка работ
      const crewS = this.act(u);
      crewS.forEach((s, i) => {
        const p = this.pointAt(job, job.done - 1 - (i / crewS.length) * 10);
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
      const seed = this.rng.int(0, 2 ** 30);
      const items = digTrench(this.world, new Rng(seed), [a, b], job.side, SIDES[job.side].enemy);
      this.events.push({ type: 'net', ev: { k: 'trench', pts: [a, b], side: job.side, s: seed } });
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

  // Движение по маршруту: «чистое преследование» точки впереди на пути.
  // Техника едет по своему курсу и поворачивает с ограниченной скоростью — плавные дуги,
  // без рывков от точки к точке. Пехота (центр отделения) — прямо к точке впереди.
  moveUnit(u, dt) {
    const def = u.def;
    const path = u.path;
    if (!path) { u.state = 'idle'; return; }
    const foot = def.move === 'foot';
    const last = path.length - 1;
    const end = path[last];
    const look = foot ? 5 : Math.max(8, Math.min(30, u.speed * 1.6));
    // Проходим точки, которые уже позади или рядом
    while (u.pathIdx < last) {
      const a = path[u.pathIdx - 1], b = path[u.pathIdx];
      const t = segT(u.x, u.y, a, b);
      if (t >= 1 || Math.hypot(b[0] - u.x, b[1] - u.y) < look * 0.5) u.pathIdx++;
      else break;
    }
    const left = Math.hypot(path[u.pathIdx][0] - u.x, path[u.pathIdx][1] - u.y) + (u.pathCum[last] - u.pathCum[u.pathIdx]);
    if (left < Math.max(1.2, u.speed * dt * 1.2)) {
      u.x = end[0]; u.y = end[1];
      u.path = null; u.state = 'idle'; u.speed = 0;
      this.onArrive(u);
      return;
    }
    // Точка впереди на расстоянии look по пути
    const tgt = lookAhead(u, path, look);
    const dx = tgt[0] - u.x, dy = tgt[1] - u.y;
    const want = Math.atan2(dy, dx);
    let da = Math.atan2(Math.sin(want - u.heading), Math.cos(want - u.heading));
    // Скорость: местность, поворот, торможение у цели, колонна, общий темп группы
    let terrain = MOVE[def.move][this.nav.classAt(u.x, u.y)] || MOVE[def.move][T.OPEN] * 0.3;
    if (u.soldiers) terrain *= Math.min(...u.soldiers.map((q) => (q.stance === 'auto' || q.dead ? 1 : POSES[q.stance].speed)));
    const turnK = foot ? 1 : Math.max(0.18, Math.cos(Math.min(Math.abs(da), 1.45)));
    const brake = Math.sqrt(2 * def.accel * Math.max(0, left)) + 0.4;
    let target = Math.min(terrain * turnK, brake);
    if (u.speedCap) target = Math.min(target, u.speedCap);
    if (u.fuel !== undefined && u.fuel <= 0) target = 0;
    const ahead = this.leaderAhead(u);
    if (ahead) target = Math.min(target, Math.max(0, ahead.speed * 0.95));
    if (u.speed < target) u.speed = Math.min(target, u.speed + def.accel * dt);
    else u.speed = Math.max(target, u.speed - def.accel * 2.5 * dt);
    if (foot) {
      u.heading += Math.max(-def.turn * dt, Math.min(def.turn * dt, da));
      const step = Math.min(u.speed * dt, Math.hypot(dx, dy));
      const L = Math.hypot(dx, dy) || 1;
      u.x += (dx / L) * step; u.y += (dy / L) * step;
    } else {
      // Поворот ограничен: у колёсной — ещё и радиусом (на месте не развернуться)
      let yaw = def.turn;
      if (def.move === 'wheeled') yaw = Math.min(yaw, Math.max(0.35, u.speed / 7));
      u.heading += Math.max(-yaw * dt, Math.min(yaw * dt, da));
      const step = u.speed * dt;
      let moved = false;
      // Прямо по курсу, иначе — объезд препятствия (скользим вдоль стены/берега)
      for (const off of [0, 0.5, -0.5, 1.0, -1.0]) {
        const a = u.heading + off;
        const nx = u.x + Math.cos(a) * step, ny = u.y + Math.sin(a) * step;
        if (this.canStand(u, nx, ny)) { u.x = nx; u.y = ny; moved = true; if (off) u.speed *= 0.85; break; }
      }
      if (!moved) u.speed *= 0.5;
    }
    // Застрял: долго почти не двигается — ищем новый маршрут от текущего места
    const prog = Math.hypot(u.x - (u.lastPos?.[0] ?? u.x), u.y - (u.lastPos?.[1] ?? u.y));
    u.lastPos = [u.x, u.y];
    u.stuckT = prog < 0.3 * dt ? (u.stuckT || 0) + dt : 0;
    if (u.stuckT > 6) {
      u.stuckT = 0;
      const p = this.nav.nearestPassable(u.x, u.y, def.move);
      if (p && (p[0] !== u.x || p[1] !== u.y) && !this.canStand(u, u.x, u.y)) { u.x = p[0]; u.y = p[1]; }
      else if (!this.canStand(u, u.x, u.y)) { u.x += Math.cos(u.heading) * -3; u.y += Math.sin(u.heading) * -3; }
      this.moveSingle(u, end[0], end[1]);
      return;
    }
    this.log.burn(u, u.speed * dt);
    u.odo = (u.odo || 0) + u.speed * dt; // пробег — для анимации гусениц и колёс
    u.eta = this.estimate(u);
  }

  // Своя движущаяся машина прямо впереди — держим дистанцию колонны
  leaderAhead(u) {
    const c = Math.cos(u.heading), s = Math.sin(u.heading);
    let best = null, bd = 22;
    for (const v of this.units) {
      if (v === u || v.dead || v.side !== u.side || v.embarked || v.mode !== 'field') continue;
      const dx = v.x - u.x, dy = v.y - u.y;
      const fwd = dx * c + dy * s;
      if (fwd <= 2 || fwd > bd || Math.abs(-dx * s + dy * c) > 5) continue;
      if (v.state !== 'moving') continue;
      bd = fwd; best = v;
    }
    return best && bd < 16 ? best : null;
  }

  pathLeft(u) {
    if (!u.path) return 0;
    return u.pathCum[u.path.length - 1] - u.pathCum[Math.min(u.pathIdx, u.path.length - 1)];
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
    const us = this.units.filter((u) => !u.dead && !u.embarked && u.mode === 'field' && u.task?.type !== 'dig');
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
    if (!(MOVE[u.def.move][this.nav.classAt(x, y)] > 0)) return false;
    // Технике не проехать сквозь дома и сараи
    return u.def.move === 'foot' || !this.solidAt(x, y);
  }

  // Начальная расстановка сторон
  deployDefault(rng) {
    const { world } = this;
    const [city, ...villages] = world.settlements;
    const east = villages.filter((v) => v.x > city.x).sort((a, b) => a.y - b.y);
    const blue = [
      ['tank', 'Т-1'], ['tank', 'Т-2'], ['ifv', '1-я БМП'], ['ifv', '2-я БМП'],
      ['inf', '1-е отд.'], ['inf', '2-е отд.'], ['inf', '3-е отд.'], ['apc', 'БТР-1'],
      ['eng', 'Сапёры-1'], ['btm', 'БТМ-1'], ['mortar', 'Миномёт-1'], ['mortar', 'Миномёт-2'],
      ['arty', 'Батарея-1'], ['truck', 'Снабж.-1'], ['truck', 'Снабж.-2'],
    ];
    const red = [
      ['tank', 'Т-71'], ['ifv', '71-я БМП'], ['ifv', '72-я БМП'], ['inf', '71-е отд.'],
      ['inf', '72-е отд.'], ['eng', 'Сапёры-7'], ['apc', 'БТР-71'], ['btm', 'БТМ-7'], ['mortar', 'Миномёт-7'], ['arty', 'Батарея-7'], ['truck', 'Снабж.-7'],
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

// Параметр проекции точки на отрезок a→b
function segT(x, y, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const L2 = vx * vx + vy * vy || 1;
  return ((x - a[0]) * vx + (y - a[1]) * vy) / L2;
}

// Точка на пути на расстоянии look вперёд от проекции текущего положения
function lookAhead(u, path, look) {
  let i = u.pathIdx;
  const a = path[i - 1], b = path[i];
  const t = Math.max(0, Math.min(1, segT(u.x, u.y, a, b)));
  let px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
  let rest = look;
  while (true) {
    const q = path[i];
    const d = Math.hypot(q[0] - px, q[1] - py);
    if (d >= rest || i === path.length - 1) {
      const k = Math.min(1, rest / (d || 1));
      return [px + (q[0] - px) * k, py + (q[1] - py) * k];
    }
    rest -= d;
    px = q[0]; py = q[1];
    i++;
  }
}

function lineLen(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return L;
}

function nearestPt(pts, x, y) {
  let best = pts[0], bd = Infinity;
  for (const p of pts) {
    const d = Math.hypot(p[0] - x, p[1] - y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function bboxPts(pts, pad) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}
