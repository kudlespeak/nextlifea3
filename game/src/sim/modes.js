// Режимы игры, расстановка сил, условия победы и линия фронта.
//  • zones  — захват зон интереса: удержание даёт очки;
//  • front  — активный фронт: обе стороны наступают, побеждает тот, кто занял больше территории;
//  • assault — наступление/оборона: атакующий должен взять опорные пункты обороны до конца времени.
// Линия фронта строится по «полю контроля» (сетка 60 м), которое смещается там, где стоят войска.

import { FACTIONS } from './factions.js';
import { Reserve } from './reserve.js';

export const MODES = {
  zones: { name: 'Захват зон интереса', desc: 'Удерживайте ключевые точки: город, сёла, перекрёстки. Удержание даёт очки; побеждает набравший 500 очков или лидер по окончании времени.' },
  front: { name: 'Активный фронт', desc: 'Обе стороны наступают. Линия фронта движется вместе с войсками. Побеждает тот, кто к концу времени контролирует больше территории.' },
  drones: { name: 'Война дронов', desc: 'Тыл против тыла: по три города у каждой стороны, ТЭС, подстанции 330/110 кВ, мосты, нефтебазы, арсеналы, заводы. Наземных войск нет — только ударные и разведывательные дроны (Герань-2/3, Гербера, Ланцет, Орлан / FP-1, FP-2, Лютый, Бобёр, Warmate, Лелека) и ПВО, которую вы расставляете сами. Ремонтируйте, ставьте сетки над мостами и дорогами, держите торговлю (фуры, магазины, АЗС). Партия 15–40 минут в три фазы эскалации, директивы штаба дают приоритетные цели. Проигрывает сторона, чей тыл (шкала устойчивости) рухнет; по времени — у кого тыл крепче.' },
  assault: { name: 'Наступление и оборона', desc: 'Оборона эшелонирована: четыре линии через всю карту. Атакующий прорывает их по очереди (большинство секторов линии), за каждую получает очки и время; обороняющийся за отход получает подкрепления. Оборона побеждает, если удержит хотя бы одну линию до конца.' },
};

// Плавный изгиб линии обороны по y (без внешних зависимостей)
function fbmLine(y, k, seed) {
  const t = y / 900 + k * 3.1 + (seed % 97);
  return 0.5 + 0.28 * Math.sin(t * 1.3) + 0.15 * Math.sin(t * 2.9 + 1.7) + 0.07 * Math.sin(t * 6.1 + 0.4);
}

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
    // Подготовка: бой не идёт, стороны выдвигаются и окапываются на своей половине
    this.prepEnd = sim.time + (cfg.prep ?? 300);
    this.prep = (cfg.prep ?? 300) > 0;
    this.ready = { blue: false, red: false };
    this.endAt = this.prepEnd + (cfg.duration || 3600);
  }

  // Граница своей половины на время подготовки (x), с запасом от серой зоны
  prepLimit(side) {
    if (this.limits) return this.limits[side];
    const fx = this.sim.world.frontX;
    return side === 'blue' ? fx - 400 : fx + 400;
  }
  clampPrep(side, x) {
    if (!this.prep) return x;
    const L = this.prepLimit(side);
    return side === 'blue' ? Math.min(x, L) : Math.max(x, L);
  }
  setReady(side) {
    if (!this.prep) return;
    this.ready[side] = true;
    const humans = ['blue', 'red'].filter((s) => !(this.cfg.aiSides || []).includes(s));
    if (humans.every((s) => this.ready[s])) this.startBattle('все готовы');
    else this.sim.msg(`${FACTIONS[side].short}: готовы к бою`);
  }
  startBattle(why) {
    if (!this.prep) return;
    this.prep = false;
    const left = Math.max(0, this.prepEnd - this.sim.time);
    this.endAt -= left; // время боя не сокращается
    this.prepEnd = this.sim.time;
    this.sim.msg(`Подготовка окончена${why ? ` (${why})` : ''} — бой начался!`);
  }

  // ---------- Расстановка ----------
  // На карте с начала только тылы: пункт сбора, склад, медпункт. Войска — из резерва.
  deploy(rng) {
    const sim = this.sim, world = sim.world;
    this.setupObjectives(rng);
    const fx = world.frontX;
    const cities = world.settlements.filter((s) => s.type === 'city');
    const cityOf = (side) => cities.reduce((best, c) => ((side === 'blue' ? c.x < best.x : c.x > best.x) ? c : best), cities[0]);
    // Рубежи на время подготовки. В обороне — перед первой линией; наступающий — далеко (≈1.5 км),
    // чтобы не подъехать вплотную до начала боя
    const e = { blue: 1, red: -1 }; // направление на противника
    if (this.mode === 'assault') {
      const att = this.cfg.attacker, def = att === 'blue' ? 'red' : 'blue';
      const line1 = this.lines?.[0];
      const front = line1 ? (e[def] > 0 ? Math.max(...line1.pts.map((p) => p[0])) : Math.min(...line1.pts.map((p) => p[0]))) : fx;
      this.limits = { [def]: front + e[def] * 120 };
      this.limits[att] = this.limits[def] + e[def] * 1000;
    } else this.limits = { blue: fx - 400, red: fx + 400 };
    this.reserve = {};
    for (const side of ['blue', 'red']) {
      const dir = e[side];
      // Пункт сбора — у дороги, ~0.9 км за рубежом подготовки
      const want = [Math.max(200, Math.min(world.W - 200, this.limits[side] - dir * 600)), cityOf(side).y + (side === 'blue' ? 250 : -250)];
      const node = sim.roads.near(want[0], want[1], 900).sort((a, c) => sim.roads.dist(a, want[0], want[1]) - sim.roads.dist(c, want[0], want[1]))[0];
      let p = node !== undefined ? [sim.roads.x[node], sim.roads.y[node]] : want;
      p = sim.nav.nearestPassable(p[0], p[1], 'wheeled') || p;
      const spawn = { x: p[0], y: p[1], dir };
      this.reserve[side] = new Reserve(sim, side, spawn);
      // Склады и медпункты строит сам игрок (вкладка «Резерв» → «Тыл»). Для старта —
      // бесплатно грузовик снабжения и санитарная машина
      this.reserve[side].gift('truck');
      this.reserve[side].gift('medevac');
    }
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
      // Четыре эшелона обороны: линии поперёк всей карты, каждая делится на сектора.
      // Линия взята, когда атакующий занял большинство её секторов; следующая открывается после этого.
      const def = this.cfg.attacker === 'blue' ? 'red' : 'blue';
      const e = def === 'blue' ? 1 : -1; // направление обороны на противника
      const room = e > 0 ? fx - 400 : world.W - 400 - fx;
      const step = Math.max(350, Math.min(650, (room - 200) / 3));
      const NAMES = ['1-я линия обороны', '2-я линия обороны', '3-я линия обороны', '4-я линия обороны'];
      const SECT = 5;
      this.lines = [];
      this.zones = [];
      for (let k = 0; k < 4; k++) {
        const base = fx - e * (200 + k * step);
        const pts = [];
        for (let y = 250; y <= world.H - 250; y += 120) pts.push([base + (fbmLine(y, k, world.seed) - 0.5) * 260, y]);
        const line = { k, name: NAMES[k], pts, owner: def, sectors: [] };
        const segLen = Math.ceil(pts.length / SECT);
        for (let j = 0; j < SECT; j++) {
          const seg = pts.slice(j * segLen, Math.min(pts.length, (j + 1) * segLen + 1));
          if (seg.length < 2) continue;
          const c = seg[seg.length >> 1];
          const z = { name: `${NAMES[k]}, сектор ${j + 1}`, x: c[0], y: c[1], r: 220, owner: def, prog: def === 'blue' ? -1 : 1, line: k, seg, locked: k > 0 };
          line.sectors.push(z);
          this.zones.push(z);
        }
        this.lines.push(line);
      }
      this.linesTaken = 0;
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
      if (u.dead || u.embarked) continue;
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
    for (const r of Object.values(this.reserve || {})) { r.income(dt); r.update(); }
    if (this.prep && sim.time >= this.prepEnd) this.startBattle('время вышло');
    if (this.prep) return;
    if (sim.time < this.nextTick) return;
    const step = 5;
    this.nextTick = sim.time + step;
    // Зоны
    for (const z of this.zones) {
      if (z.locked) continue;
      let b = 0, r = 0;
      for (const u of sim.units) {
        if (u.dead || u.embarked) continue;
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
    if (this.lines) this.checkLines();
    this.updateGrid(step);
    this.checkVictory();
  }

  // Эшелоны: большинство секторов у атакующего — линия взята; бонусы обеим сторонам
  checkLines() {
    const att = this.cfg.attacker, def = att === 'blue' ? 'red' : 'blue';
    const line = this.lines[this.linesTaken];
    if (!line) return;
    const own = line.sectors.filter((z) => z.owner === att).length;
    if (own * 2 <= line.sectors.length) return;
    line.owner = att;
    for (const z of line.sectors) { z.owner = att; z.prog = att === 'blue' ? -1 : 1; z.locked = true; }
    this.linesTaken++;
    const next = this.lines[this.linesTaken];
    if (next) for (const z of next.sectors) z.locked = false;
    // Бонусы: атакующему — очки и время на развитие успеха; обороне — очки за отход на новый рубеж
    this.reserve?.[att] && (this.reserve[att].points += 300);
    this.reserve?.[def] && (this.reserve[def].points += 250);
    if (next) this.endAt += 480;
    this.sim.msg(`${line.name} прорвана! ${FACTIONS[att].short}: +300 очков${next ? ', +8 мин' : ''}. ${FACTIONS[def].short}: отход на ${next ? next.name.toLowerCase() : 'последний рубеж'}, +250 очков`);
  }

  checkVictory() {
    const sim = this.sim;
    // Разгром: нет пехоты на карте, в пути и нечем её заказать
    const alive = (side) => sim.units.some((u) => u.side === side && !u.dead && u.soldiers) ||
      this.reserve?.[side]?.queue.some((q) => ['inf', 'eng'].includes(q.type)) || (this.reserve?.[side] && this.reserve[side].avail.inf > 0 && this.reserve[side].points >= 60);
    for (const side of ['blue', 'red']) if (!alive(side)) return this.finish(side === 'blue' ? 'red' : 'blue', 'у противника не осталось пехоты');
    if (this.mode === 'zones') {
      for (const side of ['blue', 'red']) if (this.score[side] >= 500) return this.finish(side, 'набрано 500 очков');
      if (sim.time >= this.endAt) return this.finish(this.score.blue === this.score.red ? null : this.score.blue > this.score.red ? 'blue' : 'red', 'время вышло');
    } else if (this.mode === 'assault') {
      const att = this.cfg.attacker, def = att === 'blue' ? 'red' : 'blue';
      if (this.lines && this.linesTaken >= this.lines.length) return this.finish(att, 'прорваны все четыре линии обороны');
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
