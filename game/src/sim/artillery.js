// Артиллерия и осколки.
// Снаряд летит (время полёта), падает с рассеянием, рвётся о землю или в воздухе.
// Поражение бойцов считается по ожидаемому числу попаданий осколков:
//   λ = N · A / (2π · d · h(d)), где A — открытая площадь силуэта (поза, укрытие),
//   h(d) — высота «пояса» разлёта; стены и деревья на пути гасят осколки.
// Число попаданий — по Пуассону, урон каждого падает с расстоянием.

import { pointInPoly } from '../geom.js';
import { addCraterCluster } from '../mapgen.js';
import { M } from '../spatial.js';
import { Rng } from '../rng.js';
import { refreshCanopy } from '../mapgen.js';
import { damagePower } from '../power.js';

export const CALIBERS = {
  81: { name: '81-мм мина', blast: 3, lethal: 12, danger: 45, frags: 430, crater: 1.1, speed: 240, sigma: 0.009, minR: 90, maxR: 5600, dmg: 1 },
  155: { name: '155-мм ОФС', blast: 7, lethal: 28, danger: 100, frags: 1650, crater: 3.3, speed: 600, sigma: 0.0045, minR: 1500, maxR: 24000, dmg: 3 },
  82: { name: '82-мм мина', blast: 3, lethal: 12, danger: 45, frags: 450, crater: 1.1, speed: 230, sigma: 0.011, minR: 90, maxR: 4100, dmg: 1 },
  122: { name: '122-мм ОФС', blast: 5, lethal: 20, danger: 75, frags: 1000, crater: 2.2, speed: 520, sigma: 0.007, minR: 1000, maxR: 15000, dmg: 2 },
  // малые заряды: граната ВОГ со сброса, FPV, осколочные 30 мм (БМП) и 125 мм (танк)
  vog: { name: 'ВОГ', blast: 1.2, lethal: 5, danger: 20, frags: 110, crater: 0.3, dmg: 0.1 },
  fpv: { name: 'FPV', blast: 2.2, lethal: 7, danger: 25, frags: 260, crater: 0.5, dmg: 0.3 },
  he30: { name: '30-мм ОФ', blast: 1.4, lethal: 5, danger: 18, frags: 70, crater: 0.3, dmg: 0.15 },
  he125: { name: '125-мм ОФС', blast: 4, lethal: 13, danger: 50, frags: 600, crater: 1.3, dmg: 1.2 },
  r122: { name: '122-мм реактивный снаряд', blast: 5, lethal: 20, danger: 75, frags: 900, crater: 2.0, speed: 700, sigma: 0.013, minR: 3000, maxR: 20000, dmg: 2 },
  grenade: { name: 'Ручная граната', blast: 1.5, lethal: 6, danger: 18, frags: 180, crater: 0.2, dmg: 0.05 },
  atgm: { name: 'ПТУР', blast: 2, lethal: 6, danger: 20, frags: 150, crater: 0.4, dmg: 0.6 },
  152: { name: '152-мм ОФС', blast: 7, lethal: 28, danger: 100, frags: 1700, crater: 3.2, speed: 560, sigma: 0.006, minR: 1500, maxR: 20000, dmg: 3 },
};

// Открытость силуэта по позе: [при разрыве на земле, при подрыве в воздухе (сверху)]
const EXPOSE = {
  stand: [1, 0.5], crouch: [0.6, 0.6], prone: [0.3, 1], trench: [0.1, 0.55],
  window: [0.35, 0.1], inside: [0.1, 0.08], under: [0, 0],
};

export class Artillery {
  constructor(sim) {
    this.sim = sim;
    this.shells = [];
    this.effects = []; // для отрисовки: разрывы, вспышки выстрелов
  }

  // Приказ на огонь: rounds выстрелов на орудие, fuse — 'ground' | 'air'
  orderFire(units, x, y, { rounds = 3, fuse = 'ground' } = {}) {
    const res = [];
    if (this.sim.game?.prep) return ['Идёт подготовка — огонь откроете после начала боя'];
    for (const u of units) {
      const cal = CALIBERS[u.def.caliber];
      if (!cal) continue;
      const d = Math.hypot(x - u.x, y - u.y);
      if (d < cal.minR || d > cal.maxR) {
        res.push(`${u.label}: цель вне досягаемости (${Math.round(d)} м, можно ${cal.minR}–${cal.maxR} м)`);
        continue;
      }
      if (u.ammo <= 0) { res.push(`${u.label}: нет боеприпасов`); continue; }
      this.sim.stop([u]);
      // Развёртывание после марша
      const setup = u.deployedAt && this.sim.time - u.deployedAt < 1 ? 0 : u.def.setup;
      u.fire = { x, y, rounds, fuse, next: this.sim.time + setup };
      u.deployedAt = this.sim.time + setup;
      res.push(`${u.label}: огонь ${rounds}× ${cal.name}${fuse === 'air' ? ', воздушный подрыв' : ''}, дальность ${(d / 1000).toFixed(1)} км${setup ? `, развёртывание ${Math.round(setup)} с` : ''}`);
    }
    return res;
  }

  update() {
    const sim = this.sim;
    for (const u of sim.units) {
      if (!u.fire || u.dead) continue;
      if (u.state === 'moving' || u.state === 'planning') { u.fire = null; u.deployedAt = 0; continue; }
      if (sim.time < u.fire.next) continue;
      if (u.fire.rounds <= 0 || u.ammo <= 0) {
        if (u.ammo <= 0) sim.msg(`${u.label}: боеприпасы израсходованы`);
        u.fire = null;
        continue;
      }
      this.launch(u);
    }
    // Разрывы
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      if (sim.time >= s.tImpact) {
        this.shells.splice(i, 1);
        this.explode(s.x, s.y, s.caliber, s.fuse, s.side);
      }
    }
  }

  launch(u) {
    const sim = this.sim;
    const cal = CALIBERS[u.def.caliber];
    const f = u.fire;
    const d = Math.hypot(f.x - u.x, f.y - u.y);
    const ax = (f.x - u.x) / d, ay = (f.y - u.y) / d;
    // Рассеяние: по дальности больше, по направлению меньше
    const er = gauss(sim.rng) * cal.sigma * d, ed = gauss(sim.rng) * cal.sigma * d * 0.45;
    const x = f.x + ax * er - ay * ed, y = f.y + ay * er + ax * ed;
    const tof = d / cal.speed + (u.def.caliber < 100 ? 8 : 4);
    this.shells.push({ x0: u.x, y0: u.y, x, y, tLaunch: sim.time, tImpact: sim.time + tof, caliber: u.def.caliber, fuse: f.fuse, side: u.side });
    // Орудие на прицепе стреляет назад по ходу тягача — поворачиваем «корму» к цели
    u.heading = Math.atan2(ay, ax) + (u.type === 'arty' ? Math.PI : 0);
    const bx = u.type === 'arty' ? -9 : 0;
    this.effects.push({ type: 'muzzle', x: u.x + Math.cos(u.heading) * bx, y: u.y + Math.sin(u.heading) * bx, h: Math.atan2(ay, ax), t: performance.now() });
    u.recoil = sim.time;
    u.ammo--;
    f.rounds--;
    f.next = sim.time + u.def.reload;
  }

  // ---------- Разрыв ----------
  explode(x, y, caliber, fuse = 'ground', side = null, quiet = false, seed = null) {
    const sim = this.sim, world = sim.world, rng = sim.rng;
    const cal = CALIBERS[caliber];
    if (seed === null) seed = rng.int(0, 2 ** 30);
    // Мировая часть разрыва детерминирована по seed — для сетевой игры
    sim.events.push({ type: 'net', ev: { k: 'boom', x, y, c: caliber, f: fuse, s: seed } });
    const { collapsedDugouts, h } = this.explodeWorld(x, y, caliber, fuse, seed);
    return this.explodePeople(x, y, caliber, fuse, h, collapsedDugouts, quiet);
  }

  // Воронка, деревья, здания, блиндажи, электросеть, эффекты (одинаково у всех игроков)
  explodeWorld(x, y, caliber, fuse, seed) {
    const sim = this.sim, world = sim.world;
    const rng = new Rng(seed >>> 0);
    const cal = CALIBERS[caliber];
    const air = fuse === 'air';
    const h = air ? rng.float(5, 10) : 0.3;
    const redraw = { x0: x - cal.danger * 0.3, y0: y - cal.danger * 0.3, x1: x + cal.danger * 0.3, y1: y + cal.danger * 0.3 };

    // Воронка (при подрыве в воздухе — только посечённая земля)
    if (!air) {
      const c = addCraterCluster(world, rng, x, y, 1, 0)[0];
      c.x = x; c.y = y; c.r = cal.crater * rng.float(0.85, 1.15);
      c.bbox = { x0: x - c.r * 2.6, y0: y - c.r * 2.6, x1: x + c.r * 2.6, y1: y + c.r * 2.6 };
    }
    // Деревья: ближние сломаны, дальше — посечены
    world.trees.forEach({ x0: x - cal.blast * 2.5, y0: y - cal.blast * 2.5, x1: x + cal.blast * 2.5, y1: y + cal.blast * 2.5 }, (arr, i) => {
      const d = Math.hypot(arr[i] - x, arr[i + 1] - y);
      if (d < cal.blast * (air ? 0.6 : 1)) arr[i + 2] = 0;
      else if (d < cal.blast * 2.5 && rng.chance(0.5)) { arr[i + 3] = 5; arr[i + 2] *= 0.75; }
    });
    // Здания
    for (const b of world.buildings.query({ x0: x - cal.blast * 2, y0: y - cal.blast * 2, x1: x + cal.blast * 2, y1: y + cal.blast * 2 })) {
      const inside = b.poly && pointInPoly(x, y, b.poly);
      const dd = inside ? 0 : Math.hypot(b.x - x, b.y - y) - Math.max(b.w || 2, b.h || 2) / 2;
      if (dd > cal.blast * 1.5) continue;
      b.damage = (b.damage || 0) + (inside ? cal.dmg : cal.dmg * 0.25) / Math.max(1, (b.w * b.h) / 150);
      if (b.damage >= 0.8) b.ruined = true;
      if (b.damage >= 2.5 && b.style !== 'silo' && !b.collapsed) {
        b.collapsed = true;
        if (b.w * b.h > 30) (sim.fires || []).push({ x: b.x, y: b.y, r: Math.max(15, Math.max(b.w, b.h)), until: sim.time + 900 });
      }
      redraw.x0 = Math.min(redraw.x0, b.bbox.x0); redraw.y0 = Math.min(redraw.y0, b.bbox.y0);
      redraw.x1 = Math.max(redraw.x1, b.bbox.x1); redraw.y1 = Math.max(redraw.y1, b.bbox.y1);
    }
    // Блиндажи: прямое попадание крупнее выдерживаемого калибра — обрушение
    const collapsedDugouts = [];
    for (const f of world.forts.query({ x0: x - 4, y0: y - 4, x1: x + 4, y1: y + 4 })) {
      if (f.kind !== 'dugout' || air) continue;
      if (Math.hypot(f.x - x, f.y - y) < Math.max(f.w, f.h) / 2 + 1 && caliber > f.resist) {
        f.collapsed = true;
        collapsedDugouts.push(f);
        sim.msg(`Прямое попадание ${caliber} мм: блиндаж обрушен`);
      }
    }
    for (const m of damagePower(world, x, y, cal.blast)) {
      sim.msg(m);
      const p = world.power;
      redraw.x0 = Math.min(redraw.x0, p.main.x - 40); redraw.y0 = Math.min(redraw.y0, p.main.y - 40);
      redraw.x1 = Math.max(redraw.x1, p.main.x + 40); redraw.y1 = Math.max(redraw.y1, p.main.y + 40);
      sim.events.push({ type: 'forts', bbox: { x0: -100, y0: -100, x1: world.W + 100, y1: world.H + 100 }, power: true });
    }
    refreshCanopy(world, { x0: x - cal.blast * 3, y0: y - cal.blast * 3, x1: x + cal.blast * 3, y1: y + cal.blast * 3 });
    sim.events.push({ type: 'forts', bbox: redraw });
    this.effects.push({ type: 'blast', x, y, caliber, air, h, t: performance.now(), rays: this.rays(x, y, cal, air, rng) });
    return { collapsedDugouts, h };
  }

  explodePeople(x, y, caliber, fuse, h, collapsedDugouts, quiet) {
    const sim = this.sim, rng = sim.rng;
    const cal = CALIBERS[caliber];
    const air = fuse === 'air';
    if (sim.puppet) return { killed: 0, wounded: 0 };
    for (const m of sim.log.hitDepot(x, y, cal.blast)) sim.msg(m);

    // ---------- Люди ----------
    let killed = 0, wounded = 0;
    const affected = new Set();
    for (const u of sim.units) {
      if (u.dead || u.embarked) continue;
      if (!u.soldiers) {
        // Техника: близкий разрыв — уничтожена, в радиусе — повреждена
        const d = Math.hypot(u.x - x, u.y - y);
        if (d < cal.blast * 0.7 || (d < cal.blast * 1.5 && rng.chance(0.3))) this.destroyVehicle(u);
        else if (d < cal.blast * 3) { u.hp = (u.hp ?? 1) - rng.float(0.1, 0.35) * (cal.blast * 3 - d) / (cal.blast * 3); if (u.hp <= 0) this.destroyVehicle(u); }
        continue;
      }
      for (const s of u.soldiers) {
        if (s.dead) continue;
        const d = Math.hypot(s.x - x, s.y - y);
        if (d > cal.danger) continue;
        let dmg = 0;
        if (s.under) {
          // Подвал рухнувшего дома или обрушенный блиндаж
          if (s.building?.collapsed && pointInPoly(x, y, s.building.poly) && caliber >= 122 && rng.chance(0.4)) dmg = rng.float(30, 120);
          if (collapsedDugouts.some((f) => Math.hypot(f.x - s.x, f.y - s.y) < 4)) dmg = 200;
          if (!dmg) continue;
        } else {
          const d3 = Math.hypot(d, h);
          // Фугасное действие
          if (d3 < cal.blast) dmg += rng.float(60, 140) * (1 - d3 / cal.blast) * (s.building && !air ? 0.4 : 1);
          // Осколки
          const expo = this.exposure(s, x, y, d, air);
          if (expo > 0) {
            const shield = air ? 1 : this.shielding(s.x, s.y, x, y);
            const A = 0.65 * expo * shield;
            const lambda = (cal.frags * A) / (2 * Math.PI * Math.max(1, d3) * (1.4 + d3 * 0.35));
            const hits = poisson(rng, lambda);
            for (let k = 0; k < hits; k++) dmg += rng.float(10, 55) * (0.35 + 0.65 * Math.exp(-d3 / cal.lethal));
          }
        }
        if (dmg <= 0) continue;
        affected.add(u);
        const before = s.hp;
        s.hp -= dmg;
        if (s.hp <= 0) { s.dead = true; s.hp = 0; s.path = null; s.mode = 'dead'; killed++; }
        else if (before >= 70 && s.hp < 70) wounded++;
        s.wounded = s.hp <= 0 ? 0 : s.hp < 30 ? 2 : s.hp < 70 ? 1 : 0;
        if (s.wounded === 2) { s.path = null; s.mode = 'hold'; }
      }
    }
    for (const u of affected) sim.checkUnit(u);
    if ((killed || wounded) && !quiet) sim.msg(`Разрыв ${cal.name}${air ? ' (в воздухе)' : ''}: убито ${killed}, ранено ${wounded}`);
    return { killed, wounded };
  }

  // Открытость бойца с учётом позы и укрытия
  exposure(s, x, y, d, air) {
    let e = EXPOSE[s.pose || 'stand'] ?? [1, 1];
    let v = air ? e[1] : e[0];
    if (s.pose === 'trench') {
      // Разрыв прямо в траншее — укрытие не спасает; перекрытие спасает от воздушного подрыва
      const tr = this.sim.world.forts.query({ x0: s.x - 1.5, y0: s.y - 1.5, x1: s.x + 1.5, y1: s.y + 1.5 }).find((f) => f.kind === 'trench');
      if (!air && d < 2) v = 1;
      if (air && tr?.covered === 'logs') v = 0.05;
      else if (air && tr?.covered === 'net') v = 0.35;
    }
    if ((s.pose === 'window' || s.pose === 'inside') && s.building && pointInPoly(x, y, s.building.poly)) v = 1; // попало в само здание
    return v;
  }

  // Стены и деревья между разрывом и бойцом
  shielding(sx, sy, x, y) {
    const world = this.sim.world;
    let k = 1;
    const bb = { x0: Math.min(sx, x), y0: Math.min(sy, y), x1: Math.max(sx, x), y1: Math.max(sy, y) };
    for (const b of world.buildings.query(bb)) {
      if (!b.interior) {
        if (segPoly(sx, sy, x, y, b.poly)) k *= 0.05;
        continue;
      }
      for (const w of b.interior.walls) if (segSeg(sx, sy, x, y, w.a[0], w.a[1], w.b[0], w.b[1])) k *= 0.06;
      if (k < 0.001) return 0;
    }
    // Деревья
    const L = Math.hypot(x - sx, y - sy);
    let trees = 0;
    world.trees.forEach(bb, (arr, i) => {
      if (arr[i + 2] <= 0.01) return;
      const t = ((arr[i] - sx) * (x - sx) + (arr[i + 1] - sy) * (y - sy)) / (L * L || 1);
      if (t <= 0 || t >= 1) return;
      const px = sx + (x - sx) * t, py = sy + (y - sy) * t;
      if (Math.hypot(arr[i] - px, arr[i + 1] - py) < arr[i + 2] * 0.5) trees++;
    });
    return k * Math.pow(0.75, trees);
  }

  // Лучи осколков для визуализации — обрываются на стенах
  rays(x, y, cal, air, rng) {
    const out = [];
    const n = cal.frags < 150 ? 16 : 42;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng.float(-0.06, 0.06);
      let L = cal.lethal * rng.float(0.6, 1.6);
      if (!air) {
        const ex = x + Math.cos(a) * L, ey = y + Math.sin(a) * L;
        const hit = this.firstWall(x, y, ex, ey);
        if (hit !== null) L *= hit;
      }
      out.push([a, L]);
    }
    return out;
  }

  firstWall(x0, y0, x1, y1) {
    let best = null;
    const bb = { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
    for (const b of this.sim.world.buildings.query(bb)) {
      const segs = b.interior ? b.interior.walls.map((w) => [w.a, w.b]) : b.poly.map((p, i) => [p, b.poly[(i + 1) % b.poly.length]]);
      for (const [a, c] of segs) {
        const t = segT(x0, y0, x1, y1, a[0], a[1], c[0], c[1]);
        if (t !== null && (best === null || t < best)) best = t;
      }
    }
    return best;
  }

  destroyVehicle(u) {
    if (u.dead) return;
    u.dead = true;
    u.state = 'idle';
    u.path = null;
    u.fire = null;
    const world = this.sim.world;
    const type = u.type === 'tank' ? 'tank' : u.type === 'truck' || u.type === 'arty' ? 'truck' : u.type === 'apc' ? 'apc' : 'ifv';
    const w = { kind: 'wreck', x: u.x, y: u.y, angle: u.heading, type, seed: u.id * 7919 };
    w.bbox = { x0: u.x - 10, y0: u.y - 10, x1: u.x + 10, y1: u.y + 10 };
    world.scars.insert(w);
    (this.sim.fires || []).push({ x: u.x, y: u.y, r: 25, until: this.sim.time + 1200 });
    this.sim.events.push({ type: 'forts', bbox: w.bbox });
    this.sim.events.push({ type: 'net', ev: { k: 'wreck', id: u.id, x: u.x, y: u.y, a: u.heading, t: type } });
    this.sim.msg(`${u.label}: уничтожен`);
    // Десант в подбитой машине: часть гибнет, остальные ранены и выбираются наружу
    for (const p of [...(u.passengers || [])]) {
      const rng = this.sim.rng;
      for (const s of p.soldiers) {
        if (s.dead) continue;
        const r = rng.next();
        if (r < 0.35) { s.dead = true; s.hp = 0; s.mode = 'dead'; }
        else if (r < 0.75) { s.hp = Math.min(s.hp, rng.float(8, 29)); s.wounded = 2; s.treated = false; }
        else { s.hp = Math.min(s.hp, 60); s.wounded = 1; }
      }
      this.sim.disembark(p, true);
      this.sim.checkUnit(p);
      this.sim.msg(`${p.label}: машина подбита, десант понёс потери`, p.side);
    }
  }
}

function gauss(rng) {
  const u = 1 - rng.next(), v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function poisson(rng, lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss(rng)));
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rng.next(); } while (p > L);
  return k - 1;
}

function segT(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  return t > 0.001 && t < 0.999 && u >= 0 && u <= 1 ? t : null;
}
const segSeg = (...a) => segT(...a) !== null;
function segPoly(ax, ay, bx, by, poly) {
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    if (segSeg(ax, ay, bx, by, p[0], p[1], q[0], q[1])) return true;
  }
  return false;
}
export { M };
