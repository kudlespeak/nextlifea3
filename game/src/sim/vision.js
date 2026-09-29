// Обнаружение и туман войны.
// Раз в секунду для каждой стороны: какие подразделения противника видны.
// Дальность наблюдателя: пехота 850 м, техника 1500 м (оптика), дрон 380 м сверху.
// Ночью — умножается на качество ночных приборов стороны; освещённые цели видны как днём.
// Цель: чем меньше открыт силуэт (поза, траншея, окно, подвал), тем ближе надо подойти;
// стрелявшие недавно — заметны (вспышки, звук); двигающиеся — заметнее.
// Прямая видимость: кроны посадок и здания на линии закрывают обзор.

import { M } from '../spatial.js';
import { FACTIONS } from './factions.js';
import { POSES } from './units.js';
import { daylight, tpPowered } from '../power.js';

const SIGHT = { foot: 850, vehicle: 1500, drone: 380 };

export class Vision {
  constructor(sim) {
    this.sim = sim;
    this.seen = { blue: new Map(), red: new Map() }; // id → { x, y, t, symbol, label, type }
    this.now = { blue: new Set(), red: new Set() }; // видны прямо сейчас
    this.observers = { blue: [], red: [] }; // для тумана войны: круги обзора
    this.next = 0;
    this.stamp = 0;
  }

  darkness() {
    return 1 - daylight(this.sim.time);
  }

  // Освещено ли место (фонари, окна, пожары) — ночью это демаскирует
  lit(x, y) {
    const w = this.sim.world;
    const p = w.power;
    if (p) {
      for (const l of p.lamps) if (l.on && Math.abs(l.x - x) < 20 && Math.abs(l.y - y) < 20 && tpPowered(w, l.tp)) return true;
    }
    for (const f of this.sim.fires || []) if (Math.hypot(f.x - x, f.y - y) < f.r) return true;
    return false;
  }

  update(force = false) {
    const sim = this.sim;
    if (!force && sim.time < this.next) return;
    this.next = sim.time + 1;
    this.stamp++;
    const dark = this.darkness();
    for (const side of ['blue', 'red']) {
      const enemy = side === 'blue' ? 'red' : 'blue';
      const nightK = 1 - dark * (1 - FACTIONS[side].night);
      const obs = [];
      for (const u of sim.units) {
        if (u.side !== side || u.dead) continue;
        if (u.soldiers && !u.soldiers.some((s) => !s.dead && !s.under)) continue;
        obs.push({ x: u.x, y: u.y, r: (u.soldiers ? SIGHT.foot : SIGHT.vehicle) * nightK, air: false, unit: u });
      }
      for (const d of sim.drones?.list || []) {
        if (d.side !== side || d.dead) continue;
        obs.push({ x: d.x, y: d.y, r: SIGHT.drone * (1 - dark * 0.1), air: true });
      }
      this.observers[side] = obs;
      const now = new Set();
      for (const t of sim.units) {
        if (t.side !== enemy || t.dead) continue;
        const k = this.conceal(t, dark, nightK);
        if (k <= 0) continue;
        const litT = dark > 0.3 && this.lit(t.x, t.y);
        for (const o of obs) {
          const d = Math.hypot(t.x - o.x, t.y - o.y);
          let r = o.r * k;
          // Освещённые цели ночью — как днём
          if (litT && !o.air) r = Math.max(r, (t.soldiers ? SIGHT.foot : SIGHT.vehicle) * k);
          if (d > r) continue;
          if (d > 40 && !this.los(o, t)) continue;
          now.add(t.id);
          const prev = this.seen[side].get(t.id);
          if ((!prev || sim.time - prev.t > 120) && !sim.puppet) sim.msg(`Обнаружен противник: ${t.def.short}${t.soldiers ? ` (${t.soldiers.filter((q) => !q.dead).length} чел.)` : ''}`, side);
          this.seen[side].set(t.id, { x: t.x, y: t.y, t: sim.time, symbol: t.def.symbol, label: t.def.short, side: enemy });
          break;
        }
      }
      this.now[side] = now;
      // Старые отметки забываем через 5 минут
      for (const [id, v] of this.seen[side]) if (sim.time - v.t > 300) this.seen[side].delete(id);
    }
  }

  // Множитель дальности обнаружения цели (0 — не видна)
  conceal(t, dark, nightK) {
    let k;
    if (t.soldiers) {
      const alive = t.soldiers.filter((s) => !s.dead);
      if (!alive.length) return 0;
      const up = alive.filter((s) => !s.under);
      if (!up.length) return 0.03; // все в подвале/блиндаже — только вплотную
      const exp = up.reduce((a, s) => a + (POSES[s.pose]?.exposure ?? 1), 0) / up.length;
      k = 0.22 + 0.78 * exp;
      if (up.some((s) => s.moving)) k += 0.15;
    } else {
      k = 1;
      if (t.state === 'moving') k += 0.2;
    }
    // Выстрелы демаскируют — ночью особенно (вспышки)
    if (t.firedAt && this.sim.time - t.firedAt < 8) k = Math.max(k, 1) * (1 + dark * 0.8);
    return Math.min(2, k);
  }

  // Прямая видимость: считаем клетки крон и зданий вдоль линии, не учитывая
  // первые/последние 18 м (из опушки и из окна видно наружу)
  los(o, t) {
    const mask = this.sim.world.mask;
    const dx = t.x - o.x, dy = t.y - o.y;
    const L = Math.hypot(dx, dy);
    const step = 4;
    let canopy = 0, build = 0;
    for (let s = 18; s < L - 18; s += step) {
      const v = mask.get(o.x + (dx * s) / L, o.y + (dy * s) / L);
      if (v & M.CANOPY) canopy++;
      if (v & M.BUILD) build++;
      if (!o.air && (canopy > 3 || build > 2)) return false;
    }
    // С дрона: цель под кронами видна хуже
    if (o.air && mask.has(t.x, t.y, M.CANOPY) && (this.stamp + t.id) % 2 === 0) return false;
    return true;
  }

  visible(side, unit) {
    return this.now[side].has(unit.id);
  }
}
