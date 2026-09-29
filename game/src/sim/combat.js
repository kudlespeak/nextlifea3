// Стрелковый бой, подавление, медицина.
// Каждый боец раз в interval секунд даёт очередь по видимому противнику в пределах
// дальности оружия. Вероятность попадания:
//   p = p100 · fall^(d/100 − 1) · открытость цели · меткость стрелка · (ночь)
// Попадание — урон, промах рядом — подавление (боец прижимается к земле, хуже стреляет).
// Тяжелораненые теряют кровь; медик отделения идёт к ним и перевязывает.

import { WEAPONS, VEHICLE_WEAPON, FACTIONS } from './factions.js';
import { POSES } from './units.js';

// Открытость цели для пуль (траншея и окно укрывают сильнее, чем от осколков)
const BULLET_EXPOSE = { stand: 1, crouch: 0.7, prone: 0.35, trench: 0.12, window: 0.25, inside: 0.05, under: 0, dead: 0 };

export class Combat {
  constructor(sim) {
    this.sim = sim;
    this.tracers = []; // визуальные трассеры: { x0,y0,x1,y1,t, side, heavy }
    this.fires = sim.fires = []; // пожары (подбитая техника, дома) — свет и дым
  }

  update(dt) {
    const sim = this.sim;
    const dark = sim.vision.darkness();
    for (const u of sim.units) {
      if (u.dead) continue;
      if (u.soldiers) {
        for (const s of u.soldiers) {
          if (s.dead) continue;
          s.supp = Math.max(0, s.supp - dt * 0.8);
          this.medical(u, s, dt);
          if (s.wounded === 2 || s.under || s.evac) continue;
          if (sim.time >= s.nextShot) this.soldierFire(u, s, dark);
        }
      } else if (VEHICLE_WEAPON[u.type] && sim.time >= (u.nextShot || 0)) this.vehicleFire(u, dark);
    }
    // Пожары гаснут
    for (let i = this.fires.length - 1; i >= 0; i--) if (sim.time > this.fires[i].until) this.fires.splice(i, 1);
  }

  canFire(u) {
    if (u.roe === 'hold') return false;
    if (u.roe === 'return') return u.underFire && this.sim.time - u.underFire < 30;
    return true;
  }

  // Ближайшая видимая цель в радиусе; preferVehicles — для гранатомётов/пушек
  pickTarget(u, x, y, range, preferVehicles) {
    const sim = this.sim;
    const vis = sim.vision.now[u.side];
    let best = null, bd = Infinity;
    for (const t of sim.units) {
      if (t.side === u.side || t.dead || !vis.has(t.id)) continue;
      const d = Math.hypot(t.x - x, t.y - y);
      if (d > range) continue;
      let score = d;
      if (preferVehicles) score = t.soldiers ? d * 3 : d * 0.5;
      else if (!t.soldiers) score = d * 1.5;
      if (score < bd) { bd = score; best = t; }
    }
    return best;
  }

  soldierFire(u, s, dark) {
    const sim = this.sim;
    const w = WEAPONS[s.weapon] || WEAPONS.rifle;
    s.nextShot = sim.time + w.interval * (0.8 + sim.rng.next() * 0.4) * (s.moving ? 1.6 : 1);
    if (!this.canFire(u)) return;
    if (s.pose === 'inside') return; // из глубины комнаты не стреляют — только у окна
    const t = this.pickTarget(u, s.x, s.y, w.range, !!w.at);
    if (!t) return;
    u.firedAt = sim.time;
    const nightK = 1 - dark * (1 - FACTIONS[u.side].night) * 0.8;
    let shooter = (s.moving ? 0.35 : 1) * (s.pose === 'prone' || s.pose === 'trench' || s.pose === 'window' ? 1.15 : 1) * (1 - Math.min(0.7, s.supp / 10)) * nightK * (s.wounded ? 0.7 : 1);
    if (!t.soldiers) {
      // По технике — только противотанковым средством
      if (!w.at) return;
      const d = Math.hypot(t.x - s.x, t.y - s.y);
      const p = Math.min(0.9, w.p100 * Math.pow(w.fall, d / 100 - 1)) * shooter;
      const hit = sim.rng.chance(p);
      this.tracers.push({ x0: s.x, y0: s.y, x1: t.x + (hit ? 0 : sim.rng.float(-8, 8)), y1: t.y + (hit ? 0 : sim.rng.float(-8, 8)), t: sim.time, side: u.side, heavy: true });
      if (hit) this.hitVehicle(t, w.at, u);
      return;
    }
    // По пехоте: случайный открытый боец цели
    const targets = t.soldiers.filter((q) => !q.dead && !q.under);
    if (!targets.length) return;
    const ts = targets[Math.floor(sim.rng.next() * targets.length)];
    const d = Math.max(20, Math.hypot(ts.x - s.x, ts.y - s.y));
    let p = Math.min(0.9, w.p100 * Math.pow(w.fall, d / 100 - 1)) * shooter * (BULLET_EXPOSE[ts.pose] ?? 1);
    // Стена между — пуля не пройдёт
    if (ts.building && ts.pose === 'inside') p = 0;
    const rounds = w.rounds || 1;
    let hit = false;
    for (let k = 0; k < rounds; k++) if (sim.rng.chance(p / rounds * 1.4)) hit = true;
    this.tracers.push({ x0: s.x, y0: s.y, x1: ts.x + (hit ? 0 : sim.rng.float(-4, 4)), y1: ts.y + (hit ? 0 : sim.rng.float(-4, 4)), t: sim.time, side: u.side, heavy: s.weapon === 'mg' });
    t.underFire = sim.time;
    // Подавление: всем бойцам цели рядом с точкой попадания
    for (const q of t.soldiers) if (!q.dead && Math.hypot(q.x - ts.x, q.y - ts.y) < 10) q.supp = Math.min(12, q.supp + w.supp);
    if (w.blast && sim.rng.chance(0.5)) sim.art.explode(ts.x + sim.rng.float(-3, 3), ts.y + sim.rng.float(-3, 3), 'vog', 'ground', u.side, true);
    else if (hit) this.wound(t, ts, w.dmg * sim.rng.float(0.6, 1.3), `${u.label}`);
  }

  vehicleFire(u, dark) {
    const sim = this.sim;
    const w = WEAPONS[VEHICLE_WEAPON[u.type]];
    u.nextShot = sim.time + w.interval * (0.8 + sim.rng.next() * 0.4) * (u.state === 'moving' ? 1.5 : 1);
    if (!this.canFire(u)) return;
    const range = u.def.gun?.range || w.range;
    const t = this.pickTarget(u, u.x, u.y, range, !!w.at);
    if (!t) return;
    u.firedAt = sim.time;
    const d = Math.hypot(t.x - u.x, t.y - u.y);
    const nightK = 1 - dark * (1 - FACTIONS[u.side].night) * 0.6;
    const acc = (u.def.gun?.acc ?? 0.6) / 0.6;
    const p = Math.min(0.95, w.p100 * Math.pow(w.fall, d / 100 - 1)) * acc * nightK * (u.state === 'moving' ? 0.5 : 1);
    const hit = sim.rng.chance(p);
    u.heading = Math.atan2(t.y - u.y, t.x - u.x);
    sim.art.effects.push({ type: 'muzzle', x: u.x, y: u.y, h: u.heading, t: performance.now() });
    let tx = t.x, ty = t.y;
    if (t.soldiers) {
      const q = t.soldiers.filter((s) => !s.dead && !s.under);
      if (q.length) { const s = q[Math.floor(sim.rng.next() * q.length)]; tx = s.x; ty = s.y; }
    }
    if (!hit) { tx += sim.rng.float(-12, 12) * d / 500; ty += sim.rng.float(-12, 12) * d / 500; }
    this.tracers.push({ x0: u.x, y0: u.y, x1: tx, y1: ty, t: sim.time, side: u.side, heavy: true });
    t.underFire = sim.time;
    if (!t.soldiers) { if (hit) this.hitVehicle(t, w.at || 0.05, u); }
    else if (w.blast) sim.art.explode(tx, ty, u.type === 'tank' ? 'he125' : 'he30', 'ground', u.side, true);
    else {
      for (const s of t.soldiers) if (!s.dead && Math.hypot(s.x - tx, s.y - ty) < 12) s.supp = Math.min(12, s.supp + w.supp);
      if (hit) {
        const q = t.soldiers.filter((s) => !s.dead && !s.under);
        const s = q.reduce((a, b) => (Math.hypot(b.x - tx, b.y - ty) < Math.hypot(a.x - tx, a.y - ty) ? b : a), q[0]);
        if (s && sim.rng.chance(BULLET_EXPOSE[s.pose] ?? 1)) this.wound(t, s, w.dmg * sim.rng.float(0.7, 1.3), u.label);
      }
    }
  }

  hitVehicle(t, power, shooter) {
    const sim = this.sim;
    const armor = t.def.armor ?? 0.2;
    const dmg = power * (1 - armor * 0.75) * sim.rng.float(0.6, 1.4);
    t.hp = (t.hp ?? 1) - dmg;
    t.underFire = sim.time;
    if (t.hp <= 0) {
      sim.art.destroyVehicle(t);
      this.fires.push({ x: t.x, y: t.y, r: 25, until: sim.time + 1200 });
      sim.msg(`${shooter.label} поразил цель: ${t.def.short}`, shooter.side);
    }
  }

  wound(u, s, dmg, by) {
    const before = s.hp;
    s.hp -= dmg;
    if (s.hp <= 0) {
      s.hp = 0;
      s.dead = true;
      s.path = null;
      s.mode = 'dead';
      this.sim.checkUnit(u);
      return;
    }
    s.wounded = s.hp < 30 ? 2 : s.hp < 70 ? 1 : 0;
    if (s.wounded === 2) { s.path = null; s.mode = 'hold'; s.treated = false; }
    if (before >= 30 && s.hp < 30) this.sim.msg(`${u.label}: тяжело ранен ${s.role.toLowerCase()}`, u.side);
  }

  // Кровопотеря и работа медика
  medical(u, s, dt) {
    const sim = this.sim;
    if (s.wounded === 2 && !s.treated) {
      s.hp -= dt / 12; // ~6 минут без помощи
      if (s.hp <= 0) { s.hp = 0; s.dead = true; s.mode = 'dead'; sim.msg(`${u.label}: ${s.role.toLowerCase()} умер от ран`, u.side); sim.checkUnit(u); return; }
    }
    if (s.role !== 'Медик' || s.wounded === 2 || s.under) return;
    if (s.treating) {
      const pat = s.treating;
      if (pat.dead || Math.hypot(pat.x - s.x, pat.y - s.y) > 3) { s.treating = null; return; }
      s.treatLeft -= dt;
      if (s.treatLeft <= 0) {
        pat.treated = true;
        pat.hp = Math.max(pat.hp, 20);
        s.treating = null;
        sim.msg(`${u.label}: медик оказал помощь — ${pat.role.toLowerCase()} стабилен, нужна эвакуация`, u.side);
      }
      return;
    }
    if (s.mode === 'path') return;
    const pat = u.soldiers.find((q) => !q.dead && q.wounded === 2 && !q.treated && !q.evac && q !== s);
    if (!pat) return;
    const d = Math.hypot(pat.x - s.x, pat.y - s.y);
    if (d < 2) { s.treating = pat; s.treatLeft = 45; return; }
    s.path = [{ x: s.x, y: s.y, under: s.under }, { x: pat.x + 0.8, y: pat.y, under: pat.under }];
    s.pathIdx = 1;
    s.mode = 'path';
    s.speed = 1.6;
    s.afterPath = 'hold';
    s.face = null;
    s.startAt = 0;
  }
}

export { POSES };
