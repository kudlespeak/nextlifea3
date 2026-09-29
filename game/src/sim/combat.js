// Стрелковый бой, подавление, медицина.
// Каждый боец раз в interval секунд даёт очередь по видимому противнику в пределах
// дальности оружия. Вероятность попадания:
//   p = p100 · fall^(d/100 − 1) · открытость цели · меткость стрелка · (ночь)
// Попадание — урон, промах рядом — подавление (боец прижимается к земле, хуже стреляет).
// Тяжелораненые теряют кровь; медик отделения идёт к ним и перевязывает.

import { WEAPONS, VEHICLE_WEAPON, FACTIONS } from './factions.js';
import { POSES } from './units.js';
import { AMMO_USE } from './logistics.js';
import { hitSoldier, hitVehicle as vehicleHit, bleedTick, woundAim } from './wounds.js';

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
      if (u.dead || u.embarked) continue;
      if (u.soldiers) {
        for (const s of u.soldiers) {
          if (s.dead) continue;
          s.supp = Math.max(0, s.supp - dt * 0.8);
          this.medical(u, s, dt);
          if (s.wounded === 2 || s.under || s.evac || sim.game?.prep) continue;
          if (sim.time >= s.nextShot) this.soldierFire(u, s, dark);
        }
      } else if (VEHICLE_WEAPON[u.type] && sim.time >= (u.nextShot || 0) && !sim.game?.prep) this.vehicleFire(u, dark);
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
      if (t.side === u.side || t.dead || t.embarked || !vis.has(t.id)) continue;
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
    let w = WEAPONS[s.weapon] || WEAPONS.rifle;
    s.nextShot = sim.time + w.interval * (0.8 + sim.rng.next() * 0.4) * (s.moving ? 1.6 : 1);
    if (!this.canFire(u)) return;
    if (s.pose === 'inside') return; // из глубины комнаты не стреляют — только у окна
    if ((s.mag ?? 1) <= 0) return; // нет патронов
    const t = this.pickTarget(u, s.x, s.y, w.range, !!w.at);
    if (!t) return;
    // По технике из автомата не стреляют — не тратим патроны
    if (!t.soldiers && !w.at) return;
    // Оператор ПТУР по пехоте работает из автомата
    const wid = s.weapon === 'atgm' && t.soldiers ? 'rifle' : s.weapon;
    if (wid !== s.weapon) w = WEAPONS.rifle;
    if (wid !== s.weapon && Math.hypot(t.x - s.x, t.y - s.y) > WEAPONS.rifle.range) return;
    u.firedAt = sim.time;
    if (s.mag !== undefined) {
      s.mag = Math.max(0, s.mag - (AMMO_USE[wid] || 0.0125));
      if (s.mag <= 0 && !u.ammoWarned) { u.ammoWarned = sim.time; sim.msg(`${u.label}: у бойцов кончаются патроны — нужен подвоз`, u.side); }
      if (s.mag > 0.3) u.ammoWarned = 0;
    }
    const nightK = 1 - dark * (1 - FACTIONS[u.side].night) * 0.8;
    let shooter = (s.moving ? 0.35 : 1) * (s.pose === 'prone' || s.pose === 'trench' || s.pose === 'window' ? 1.15 : 1) * (1 - Math.min(0.7, s.supp / 10)) * nightK * woundAim(s);
    if (!t.soldiers && s.weapon === 'atgm') { this.missile(u, t, s.x, s.y, s); return; }
    if (!t.soldiers) {
      // По технике — только противотанковым средством
      if (!w.at) return;
      const d = Math.hypot(t.x - s.x, t.y - s.y);
      const p = Math.min(0.9, w.p100 * Math.pow(w.fall, d / 100 - 1)) * shooter;
      const hit = sim.rng.chance(p);
      this.tracers.push({ x0: s.x, y0: s.y, x1: t.x + (hit ? 0 : sim.rng.float(-8, 8)), y1: t.y + (hit ? 0 : sim.rng.float(-8, 8)), t: sim.time, side: u.side, heavy: true });
      s.shotAt = sim.time; s.aim = Math.atan2(t.y - s.y, t.x - s.x);
      if (hit) this.hitVehicle(t, w.at, u, s, { shaped: true });
      return;
    }
    // По пехоте: случайный открытый боец цели
    const targets = t.soldiers.filter((q) => !q.dead && !q.under);
    if (!targets.length) return;
    const ts = targets[Math.floor(sim.rng.next() * targets.length)];
    const dReal = Math.hypot(ts.x - s.x, ts.y - s.y);
    // Ближний бой: ручная граната (в траншею, за угол, в окно)
    if (dReal < 32 && (s.grenades ?? 0) > 0 && sim.rng.chance(0.35)) {
      s.grenades--;
      s.shotAt = sim.time; s.aim = Math.atan2(ts.y - s.y, ts.x - s.x);
      t.underFire = sim.time;
      const miss = Math.max(1, dReal * 0.12);
      sim.art.explode(ts.x + sim.rng.float(-miss, miss), ts.y + sim.rng.float(-miss, miss), 'grenade', 'ground', u.side, true);
      return;
    }
    const d = Math.max(20, dReal);
    let p = Math.min(0.9, w.p100 * Math.pow(w.fall, d / 100 - 1)) * shooter * (BULLET_EXPOSE[ts.pose] ?? 1) * (ts.inCover ? 0.45 : 1);
    // Стена между — пуля не пройдёт
    if (ts.building && ts.pose === 'inside') p = 0;
    const rounds = w.rounds || 1;
    let hit = false;
    for (let k = 0; k < rounds; k++) if (sim.rng.chance(p / rounds * 1.4)) hit = true;
    this.tracers.push({ x0: s.x, y0: s.y, x1: ts.x + (hit ? 0 : sim.rng.float(-4, 4)), y1: ts.y + (hit ? 0 : sim.rng.float(-4, 4)), t: sim.time, side: u.side, heavy: s.weapon === 'mg' });
    s.shotAt = sim.time; s.aim = Math.atan2(ts.y - s.y, ts.x - s.x);
    t.underFire = sim.time;
    // Подавление: всем бойцам цели рядом с точкой попадания
    for (const q of t.soldiers) if (!q.dead && Math.hypot(q.x - ts.x, q.y - ts.y) < 10) q.supp = Math.min(12, q.supp + w.supp);
    if (w.blast && sim.rng.chance(0.5)) sim.art.explode(ts.x + sim.rng.float(-3, 3), ts.y + sim.rng.float(-3, 3), 'vog', 'ground', u.side, true);
    else if (hit) this.wound(t, ts, w.dmg * sim.rng.float(0.8, 1.2), u.label, 'bullet');
  }

  vehicleFire(u, dark) {
    const sim = this.sim;
    const w = WEAPONS[VEHICLE_WEAPON[u.type]];
    u.nextShot = sim.time + w.interval * (0.8 + sim.rng.next() * 0.4) * (u.state === 'moving' ? 1.5 : 1);
    if (!this.canFire(u)) return;
    if (u.rounds !== undefined && u.rounds <= 0) return;
    if (u.gunOut) return; // орудие выведено из строя
    // БМП: по бронетехнике издалека — ПТУР с башни
    if (u.atgmLeft > 0) {
      const tv = this.pickTarget(u, u.x, u.y, 3000, true);
      if (tv && !tv.soldiers && (tv.def.armor ?? 0) >= 0.4 && Math.hypot(tv.x - u.x, tv.y - u.y) > 350) {
        u.atgmLeft--;
        this.missile(u, tv, u.x, u.y);
        u.nextShot = sim.time + 20;
        return;
      }
    }
    const range = u.def.gun?.range || w.range;
    const t = this.pickTarget(u, u.x, u.y, range, !!w.at);
    if (!t) return;
    u.firedAt = sim.time;
    if (u.rounds !== undefined) {
      u.rounds = Math.max(0, u.rounds - (AMMO_USE[VEHICLE_WEAPON[u.type]] || 0.02));
      if (u.rounds <= 0) sim.msg(`${u.label}: боекомплект израсходован`, u.side);
    }
    u.aim = Math.atan2(t.y - u.y, t.x - u.x); // башня на цель
    const d = Math.hypot(t.x - u.x, t.y - u.y);
    const nightK = 1 - dark * (1 - FACTIONS[u.side].night) * 0.6;
    const acc = (u.def.gun?.acc ?? 0.6) / 0.6 * (u.opticsHit ? 0.6 : 1) * (u.crew !== undefined && u.crew < u.def.men ? 0.75 : 1);
    const p = Math.min(0.95, w.p100 * Math.pow(w.fall, d / 100 - 1)) * acc * nightK * (u.state === 'moving' ? 0.5 : 1);
    const hit = sim.rng.chance(p);
    u.aimAt = sim.time;
    if (u.state !== 'moving' && u.type !== 'tank' && u.type !== 'ifv' && u.type !== 'apc') u.heading = u.aim;
    u.recoil = sim.time;
    sim.art.effects.push({ type: 'muzzle', x: u.x + Math.cos(u.aim) * 5, y: u.y + Math.sin(u.aim) * 5, h: u.aim, t: performance.now(), small: u.type !== 'tank' });
    let tx = t.x, ty = t.y;
    if (t.soldiers) {
      const q = t.soldiers.filter((s) => !s.dead && !s.under);
      if (q.length) { const s = q[Math.floor(sim.rng.next() * q.length)]; tx = s.x; ty = s.y; }
    }
    if (!hit) { tx += sim.rng.float(-12, 12) * d / 500; ty += sim.rng.float(-12, 12) * d / 500; }
    this.tracers.push({ x0: u.x, y0: u.y, x1: tx, y1: ty, t: sim.time, side: u.side, heavy: true });
    t.underFire = sim.time;
    if (!t.soldiers) { if (hit) this.hitVehicle(t, w.at || 0.05, u, u, { shaped: false }); }
    else if (w.blast) sim.art.explode(tx, ty, u.type === 'tank' ? 'he125' : 'he30', 'ground', u.side, true);
    else {
      for (const s of t.soldiers) if (!s.dead && Math.hypot(s.x - tx, s.y - ty) < 12) s.supp = Math.min(12, s.supp + w.supp);
      if (hit) {
        const q = t.soldiers.filter((s) => !s.dead && !s.under);
        const s = q.reduce((a, b) => (Math.hypot(b.x - tx, b.y - ty) < Math.hypot(a.x - tx, a.y - ty) ? b : a), q[0]);
        if (s && sim.rng.chance(BULLET_EXPOSE[s.pose] ?? 1)) this.wound(t, s, w.dmg * sim.rng.float(0.8, 1.2), u.label, 'bullet');
      }
    }
  }

  // Пуск ПТУР: высокая вероятность попадания, ночью — хуже
  missile(u, t, x, y, s = null) {
    const sim = this.sim;
    const w = WEAPONS.atgm;
    const d = Math.hypot(t.x - x, t.y - y);
    const dark = sim.vision.darkness();
    const p = Math.min(0.92, w.p100 * Math.pow(w.fall, d / 100 - 1)) * (1 - dark * (1 - FACTIONS[u.side].night) * 0.5) * (t.state === 'moving' ? 0.85 : 1);
    const hit = sim.rng.chance(p);
    this.tracers.push({ x0: x, y0: y, x1: t.x + (hit ? 0 : sim.rng.float(-15, 15)), y1: t.y + (hit ? 0 : sim.rng.float(-15, 15)), t: sim.time, side: u.side, heavy: true, missile: true });
    if (s) { s.shotAt = sim.time; s.aim = Math.atan2(t.y - y, t.x - x); }
    u.firedAt = sim.time;
    t.underFire = sim.time;
    sim.art.effects.push({ type: 'muzzle', x, y, h: Math.atan2(t.y - y, t.x - x), t: performance.now(), small: true });
    if (hit) { this.hitVehicle(t, w.at, u, { x, y }, { shaped: true }); if (!t.dead) sim.art.effects.push({ type: 'blast', x: t.x, y: t.y, caliber: 30, air: false, h: 0, t: performance.now(), rays: [] }); }
    sim.msg(`${u.label}: пуск ПТУР по ${t.def.short}${hit ? ' — попадание' : ' — промах'}`, u.side);
  }

  // Попадание по технике: ракурс, броня, пробитие, поражение узлов (см. wounds.js)
  hitVehicle(t, power, shooter, from = shooter, opts = {}) {
    const sim = this.sim;
    const res = vehicleHit(sim, t, power, { x: from.x, y: from.y }, opts);
    if (res) sim.msg(`${shooter.label}: ${res}`, shooter.side);
    if (res && t.side !== shooter.side) sim.msg(`По нам: ${res}`, t.side);
  }

  wound(u, s, dmg, by, kind = 'bullet') {
    hitSoldier(this.sim, u, s, kind, dmg, by);
  }

  // Кровопотеря и работа медика
  medical(u, s, dt) {
    const sim = this.sim;
    bleedTick(sim, u, s, dt);
    if (s.dead) return;
    if (s.role !== 'Медик' || s.wounded === 2 || s.under) return;
    if (s.treating) {
      const pat = s.treating;
      if (pat.dead || Math.hypot(pat.x - s.x, pat.y - s.y) > 3) { s.treating = null; return; }
      s.treatLeft -= dt;
      if (s.treatLeft <= 0) {
        pat.treated = true;
        pat.bleed = 0;
        pat.hp = Math.max(pat.hp, pat.wounded === 2 ? 20 : pat.hp);
        s.treating = null;
        sim.msg(`${u.label}: медик остановил кровотечение — ${pat.role.toLowerCase()}${pat.wounded === 2 ? ' стабилен, нужна эвакуация' : ' может воевать'}`, u.side);
      }
      return;
    }
    if (s.mode === 'path') return;
    // Сначала — с сильным кровотечением, потом остальные раненые
    const pats = u.soldiers.filter((q) => !q.dead && !q.evac && q !== s && !q.treated && (q.bleed > 0 || q.wounded === 2));
    const pat = pats.sort((a, b) => (b.bleed || 0) - (a.bleed || 0))[0];
    if (!pat) return;
    const d = Math.hypot(pat.x - s.x, pat.y - s.y);
    if (d < 2) { s.treating = pat; s.treatLeft = pat.wounded === 2 ? 45 : 25; return; }
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
