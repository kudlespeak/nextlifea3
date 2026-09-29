// Режимы игры, расстановка сил, условия победы и линия фронта.
//  • zones  — захват зон интереса: удержание даёт очки;
//  • front  — активный фронт: обе стороны наступают, побеждает тот, кто занял больше территории;
//  • assault — наступление/оборона: атакующий должен взять опорные пункты обороны до конца времени.
// Линия фронта строится по «полю контроля» (сетка 60 м), которое смещается там, где стоят войска.

import { FACTIONS } from './factions.js';

export const MODES = {
  zones: { name: 'Захват зон интереса', desc: 'Удерживайте ключевые точки: город, сёла, перекрёстки. Удержание даёт очки; побеждает набравший 500 очков или лидер по окончании времени.' },
  front: { name: 'Активный фронт', desc: 'Обе стороны наступают. Линия фронта движется вместе с войсками. Побеждает тот, кто к концу времени контролирует больше территории.' },
  assault: { name: 'Наступление и оборона', desc: 'Одна сторона штурмует укреплённую линию, другая удерживает. Атакующему нужно взять все опорные пункты до конца времени.' },
};

const FORCES = {
  // [тип, число]
  blue: [['inf', 4], ['eng', 1], ['btm', 1], ['tank', 2], ['ifv', 2], ['apc', 1], ['mortar', 2], ['arty', 1], ['uav', 2], ['medevac', 1], ['truck', 1]],
  red: [['inf', 5], ['eng', 1], ['btm', 1], ['tank', 3], ['ifv', 2], ['apc', 2], ['mortar', 2], ['arty', 2], ['uav', 1], ['medevac', 1], ['truck', 1]],
};
const LABEL = {
  inf: (i, s) => `${i}-е отд.`, eng: (i) => `Сапёры-${i}`, btm: (i, s) => `${FACTIONS[s].units.btm.short}-${i}`,
  tank: (i, s) => `${FACTIONS[s].units.tank.short} №${i}`, ifv: (i, s) => `${FACTIONS[s].units.ifv.short} №${i}`, apc: (i, s) => `${FACTIONS[s].units.apc.short} №${i}`,
  mortar: (i) => `Миномёт-${i}`, arty: (i) => `Батарея-${i}`, uav: (i) => `БПЛА-${i}`, medevac: (i) => `Санитарка-${i}`, truck: (i) => `Снабжение-${i}`,
};

export class GameMode {
  constructor(sim, cfg) {
    this.sim = sim;
    this.cfg = cfg; // { mode, attacker, duration (с), playerSide }
    this.mode = cfg.mode;
    this.zones = [];
    this.score = { blue: 0, red: 0 };
    this.endAt = sim.time + (cfg.duration || 3600);
    this.winner = null;
    this.reason = '';
    this.grid = null;
    this.nextTick = 0;
  }

  // ---------- Расстановка ----------
  deploy(rng) {
    const sim = this.sim, world = sim.world;
    const fx = world.frontX;
    const city = world.settlements.find((s) => s.type === 'city');
    const H = world.H;
    const base = {
      blue: { x: fx - 1300, y: city.y },
      red: { x: Math.min(world.W - 400, fx + 1300), y: city.y + rng.float(-500, 500) },
    };
    sim.medpoints.blue = { x: base.blue.x - 500, y: base.blue.y + 150 };
    sim.medpoints.red = { x: Math.min(world.W - 200, base.red.x + 500), y: base.red.y - 150 };
    for (const side of ['blue', 'red']) {
      const list = FORCES[side].map((x) => x.slice());
      // В режиме штурма: атакующему больше техники, обороне — пехоты
      if (this.mode === 'assault') {
        if (side === this.cfg.attacker) list.push(['tank', 1], ['ifv', 1], ['inf', 1]);
        else list.push(['inf', 2], ['eng', 1]);
      }
      const b = base[side];
      let n = 0;
      const counters = {};
      for (const [type, count] of list)
        for (let k = 0; k < count; k++) {
          counters[type] = (counters[type] || 0) + 1;
          const row = Math.floor(n / 6), col = n % 6;
          const dir = side === 'blue' ? -1 : 1;
          const x = b.x + dir * row * 90 + rng.float(-20, 20);
          const y = b.y + (col - 2.5) * 120 + rng.float(-20, 20);
          sim.spawn(side, type, Math.max(50, Math.min(world.W - 50, x)), Math.max(50, Math.min(H - 50, y)), LABEL[type](counters[type], side));
          n++;
        }
      // Дежурные отделения — в траншеях первой линии
      const duty = this.mode === 'assault' && side !== this.cfg.attacker ? 3 : 1;
      const squads = sim.units.filter((u) => u.side === side && u.type === 'inf').slice(-duty);
      const fire = world.forts.items.filter((f) => f.kind === 'trench' && f.sub === 'fire' && f.side === side && f.line.length > 4)
        .sort((a, c) => Math.abs(a.line[0][0] - fx) - Math.abs(c.line[0][0] - fx));
      squads.forEach((sq, i) => {
        const f = fire[Math.min(fire.length - 1, i * 3)];
        if (!f) return;
        const p = f.line[Math.floor(f.line.length / 2)];
        sq.x = p[0]; sq.y = p[1];
        for (const s of sq.soldiers) { s.x = p[0] + rng.float(-3, 3); s.y = p[1] + rng.float(-3, 3); }
        sim.trenches.ensure();
        const node = sim.trenches.nearest(p[0], p[1], 10, true);
        if (node >= 0) sim.doOccupy(sq, node);
        sq.label += ' (позиция)';
        sq.duty = true;
      });
    }
    this.setupObjectives(rng);
  }

  setupObjectives(rng) {
    const world = this.sim.world;
    const fx = world.frontX;
    if (this.mode === 'zones') {
      const cands = world.settlements.map((s) => ({ name: s.name, x: s.x, y: s.y, r: s.type === 'city' ? 260 : 190 }))
        .sort((a, b) => Math.abs(a.x - fx) - Math.abs(b.x - fx)).slice(0, 5);
      // Перекрёсток трассы и дороги у фронта
      const hw = world.roadList.find((r) => r.type === 'highway');
      if (hw) {
        const p = hw.line.reduce((best, q) => (Math.abs(q[0] - fx) < Math.abs(best[0] - fx) ? q : best), hw.line[0]);
        cands.push({ name: 'Развязка на трассе', x: p[0], y: p[1], r: 170 });
      }
      this.zones = cands.map((z) => ({ ...z, owner: null, prog: 0 }));
    } else if (this.mode === 'assault') {
      // Опорные пункты обороняющегося: по центрам траншей первой линии
      const def = this.cfg.attacker === 'blue' ? 'red' : 'blue';
      const fire = world.forts.items.filter((f) => f.kind === 'trench' && f.sub === 'fire' && f.side === def)
        .sort((a, b) => Math.abs(a.line[0][0] - fx) - Math.abs(b.line[0][0] - fx));
      const picked = [];
      for (const f of fire) {
        const p = f.line[Math.floor(f.line.length / 2)];
        if (picked.every((q) => Math.hypot(q.x - p[0], q.y - p[1]) > 500)) picked.push({ name: `Опорный пункт «${['Берёза', 'Высота', 'Ручей', 'Лесная'][picked.length]}»`, x: p[0], y: p[1], r: 150 });
        if (picked.length >= 3) break;
      }
      const sign = def === 'blue' ? -1 : 1;
      this.zones = picked.map((z) => ({ ...z, owner: def, prog: sign }));
    }
    if (this.mode !== 'zones') this.initGrid();
  }

  // ---------- Поле контроля для линии фронта ----------
  initGrid() {
    const world = this.sim.world;
    const cell = 60;
    const w = Math.ceil(world.W / cell), h = Math.ceil(world.H / cell);
    const c = new Float32Array(w * h);
    const fx = world.frontX;
    for (let iy = 0; iy < h; iy++)
      for (let ix = 0; ix < w; ix++) {
        const x = (ix + 0.5) * cell;
        // Исходно: запад — Велнария (−), восток — Кардагор (+), серая зона ±300 м
        c[iy * w + ix] = Math.max(-1, Math.min(1, (x - fx) / 300));
      }
    this.grid = { cell, w, h, c, version: 0 };
    this.initTerr = this.territory();
  }

  updateGrid(dt) {
    const g = this.grid;
    if (!g) return;
    const sim = this.sim;
    const infl = new Float32Array(g.w * g.h);
    for (const u of sim.units) {
      if (u.dead) continue;
      const power = u.soldiers ? u.soldiers.filter((s) => !s.dead && !s.under).length / 3 : u.type === 'tank' || u.type === 'ifv' ? 2 : 0.5;
      if (power <= 0) continue;
      const R = u.soldiers ? 220 : 280;
      const sign = u.side === 'blue' ? -1 : 1;
      const ix0 = Math.max(0, Math.floor((u.x - R) / g.cell)), ix1 = Math.min(g.w - 1, Math.floor((u.x + R) / g.cell));
      const iy0 = Math.max(0, Math.floor((u.y - R) / g.cell)), iy1 = Math.min(g.h - 1, Math.floor((u.y + R) / g.cell));
      for (let iy = iy0; iy <= iy1; iy++)
        for (let ix = ix0; ix <= ix1; ix++) {
          const d = Math.hypot((ix + 0.5) * g.cell - u.x, (iy + 0.5) * g.cell - u.y);
          if (d < R) infl[iy * g.w + ix] += sign * power * (1 - d / R);
        }
    }
    // Контроль медленно смещается туда, где сильнее присутствие
    const rate = dt / 90;
    for (let i = 0; i < infl.length; i++) {
      const f = infl[i];
      if (Math.abs(f) < 0.05) continue;
      g.c[i] = Math.max(-1, Math.min(1, g.c[i] + Math.sign(f) * Math.min(1.5, Math.abs(f)) * rate));
    }
    g.version++;
  }

  territory() {
    const g = this.grid;
    if (!g) return null;
    let b = 0, r = 0;
    for (const v of g.c) { if (v < -0.3) b++; else if (v > 0.3) r++; }
    return { blue: b / g.c.length, red: r / g.c.length };
  }

  // ---------- Шаг ----------
  update(dt) {
    const sim = this.sim;
    if (this.winner) return;
    if (sim.time < this.nextTick) return;
    const step = 5;
    this.nextTick = sim.time + step;
    // Зоны
    for (const z of this.zones) {
      let b = 0, r = 0;
      for (const u of sim.units) {
        if (u.dead) continue;
        const n = u.soldiers ? u.soldiers.filter((s) => !s.dead && !s.under && Math.hypot(s.x - z.x, s.y - z.y) < z.r).length : (Math.hypot(u.x - z.x, u.y - z.y) < z.r ? 2 : 0);
        if (u.side === 'blue') b += n; else r += n;
      }
      z.blue = b; z.red = r;
      if (b && r) z.contested = true;
      else {
        z.contested = false;
        const n = b || r;
        if (n) {
          const dir = b ? -1 : 1;
          z.prog = Math.max(-1, Math.min(1, z.prog + dir * (step / 60) * Math.min(2, 0.6 + n / 8)));
          const was = z.owner;
          if (z.prog <= -1) z.owner = 'blue';
          else if (z.prog >= 1) z.owner = 'red';
          else if (Math.abs(z.prog) < 0.05) z.owner = null;
          if (z.owner && z.owner !== was) sim.msg(`${z.name}: зона под контролем — ${FACTIONS[z.owner].short}`);
        }
      }
      if (this.mode === 'zones' && z.owner) this.score[z.owner] += step / 10;
    }
    this.updateGrid(step);
    this.checkVictory();
  }

  checkVictory() {
    const sim = this.sim;
    const alive = (side) => sim.units.some((u) => u.side === side && !u.dead && u.soldiers);
    for (const side of ['blue', 'red']) if (!alive(side)) return this.finish(side === 'blue' ? 'red' : 'blue', 'у противника не осталось пехоты');
    if (this.mode === 'zones') {
      for (const side of ['blue', 'red']) if (this.score[side] >= 500) return this.finish(side, 'набрано 500 очков');
      if (sim.time >= this.endAt) return this.finish(this.score.blue === this.score.red ? null : this.score.blue > this.score.red ? 'blue' : 'red', 'время вышло');
    } else if (this.mode === 'assault') {
      const att = this.cfg.attacker, def = att === 'blue' ? 'red' : 'blue';
      if (this.zones.length && this.zones.every((z) => z.owner === att)) return this.finish(att, 'все опорные пункты взяты');
      if (sim.time >= this.endAt) return this.finish(def, 'оборона выстояла до конца времени');
    } else if (sim.time >= this.endAt) {
      // Побеждает тот, кто больше продвинулся относительно начала
      const t = this.territory();
      const gain = (t.blue - this.initTerr.blue) - (t.red - this.initTerr.red);
      const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
      return this.finish(Math.abs(gain) < 0.005 ? null : gain > 0 ? 'blue' : 'red', `изменение территории: ${FACTIONS.blue.short} ${pct(t.blue - this.initTerr.blue)}, ${FACTIONS.red.short} ${pct(t.red - this.initTerr.red)}`);
    }
  }

  finish(winner, reason) {
    this.winner = winner || 'draw';
    this.reason = reason;
    this.sim.msg(winner ? `Победа: ${FACTIONS[winner].country} — ${reason}` : `Ничья — ${reason}`);
  }
}
