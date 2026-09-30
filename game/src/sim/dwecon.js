// Гражданская экономика «Войны дронов».
//
// Население и налоги: у каждого города и села есть жители; налоги зависят от света, товаров в
// магазинах и страха после ударов. Мобилизация (расчёты ПВО, бригады, стартовые позиции) забирает
// рабочие руки — налоги и промышленность проседают. Армия стоит денег: у каждой позиции ПВО и
// стартовой позиции — содержание в минуту; для дронов нужны комплектующие из импорта.
//
// Сельское хозяйство: вокруг каждого села — агрофирма со своими полями. Цикл: посев → рост → уборка
// → зябь. Тракторы и комбайны работают на солярке с ближайшей АЗС (нет топлива — поля стоят,
// урожай гибнет). Зерно везут зерновозы на элеватор, с элеватора — на экспорт через погранпереход.
//
// Стройка: магазины, АЗС, супермаркеты, ТЦ, логистические хабы, элеваторы, мехдворы, стартовые
// позиции. Объекты можно улучшать до 3-го уровня. Всё строится по клику у дороги на своей земле.

import { VEH, SALE } from './dwlogi.js';
import { infraLayout, addSite } from '../mapgen.js';
import { M } from '../spatial.js';
import { rectCorners, pointInPoly } from '../geom.js';

// ---------------------------------------------------------------- Параметры
export const CYCLE = 2160; // с: сельхозцикл целиком (36 мин)
const STAGES = [['sow', 0.16], ['grow', 0.56], ['harvest', 0.2], ['rest', 0.08]];
export const STAGE_NAME = { sow: 'посевная', grow: 'рост', harvest: 'уборка', rest: 'зябь (осенняя вспашка)' };
const YIELD = { wheat: 3.6, sunflower: 2.4 }; // т/га
const PRICE = 0.02; // оч. за тонну зерна на экспорте (× фаза)
const LOT = 2000; // т в зерновозе (партия)
const XLOT = 5000; // т в экспортном автопоезде (колонна зерновозов)
const RATE = { tractor: 2.2, combine: 1.9 }; // га/с на машину (игровой темп)
const FUEL_HA = 90; // га обработки на единицу топлива (своя ёмкость ГСМ агрофирмы)
const FARM_CAP = 6000; // т на току агрофирмы
const ELEV_CAP = 40000; // т на элеваторе (1-й уровень)
const TAX = 0.075; // оч/мин с 1000 жителей при полном довольстве
export const UPKEEP = { mog: 0.25, spaag: 0.9, sam: 1.8, radar: 0.5, ew: 0.4, ewd: 1.2, icpt: 0.35, acoustic: 0.04 };
const CREW_SIZE = { mog: 4, spaag: 4, sam: 12, radar: 6, ew: 3, ewd: 5, icpt: 5, acoustic: 2 };
const LAUNCH_UPKEEP = 0.8;
export const LAUNCH_PER = 6; // пусков на исправную пусковую за 5 минут
export const BUILD = {
  store: { name: 'Магазин', cost: 40, time: 120, desc: 'торговля в селе или районе: пока есть товар — выручка каждые 3 мин' },
  fuel: { name: 'АЗС', cost: 90, time: 180, desc: 'продаёт топливо: выручка каждую минуту, пока бензовозы подвозят' },
  market: { name: 'Супермаркет', cost: 130, time: 240, desc: 'больше выручки, чем у магазина; товар возят с распредцентра' },
  mall: { name: 'Торговый центр', cost: 280, time: 360, desc: 'самая большая выручка; нужен стабильный подвоз' },
  hub: { name: 'Логистический хаб', cost: 300, time: 360, desc: 'ещё один склад: развозные машины ближе к магазинам, импорт идёт чаще — больше рейсов и выручки' },
  elevator: { name: 'Элеватор', cost: 260, time: 300, desc: 'хранилище зерна (40 тыс. т): агрофирмы возят урожай ближе, экспорт не простаивает' },
  agro: { name: 'Мехдвор', cost: 100, time: 150, desc: '+1 трактор и +1 комбайн ближайшей агрофирме (за уровень)' },
  launch: { name: 'Стартовая позиция', cost: 240, time: 300, mil: true, desc: `+${LAUNCH_PER * 4} пусков за 5 мин; содержание ${LAUNCH_UPKEEP} оч/мин` },
  decoy: { name: 'Макет подстанции', cost: 70, time: 120, mil: true, desc: 'ложная цель: противник видит обычную ПС 110 кВ и тратит на неё дроны; удар по макету не бьёт по тылу' },
  // ----- развитие страны -----
  housing: { name: 'Жилой квартал', cost: 150, time: 360, near: 'city', desc: '+30 тыс. жителей ближайшему городу (налоги, рабочие руки); у города, не дальше 4 км' },
  hospital: { name: 'Больница', cost: 190, time: 300, near: 'city', desc: 'довольство +6% в радиусе 8 км, страх после ударов проходит вдвое быстрее' },
  school: { name: 'Школа и колледж', cost: 140, time: 240, near: 'city', desc: 'рабочие руки: мобилизация бьёт по экономике слабее; довольство +3% в радиусе 6 км' },
  mill: { name: 'Мелькомбинат', cost: 230, time: 300, desc: 'перерабатывает зерно с ближайшего элеватора в муку и хлеб: товар на склады и выручка (нужен свет)' },
  dairy: { name: 'Молочная ферма', cost: 110, time: 200, near: 'village', desc: 'молоко в магазины окрестных сёл и выручка; у села, не дальше 2,5 км' },
  solar: { name: 'Солнечная станция', cost: 280, time: 300, desc: 'до 22 МВт днём в сеть ближайшей ПС 110 кВ; распределённая генерация — её трудно выбить разом' },
  bess: { name: 'Накопитель энергии', cost: 250, time: 240, near: 'ps110', desc: 'у ПС 110 кВ: при дефиците 10 мин отдаёт 30 МВт в район (за уровень), потом заряжается' },
  pontoon: { name: 'Понтонная переправа', cost: 120, time: 150, near: 'bridge', desc: 'рядом с мостом: если мост разрушен, машины идут по понтонам (медленнее)' },
  autopark: { name: 'Автобаза', cost: 160, time: 200, desc: '+3 грузовика снабжения ПВО, +6 зерновозов, +1 бензовоз за раз' },
  reserve: { name: 'Госрезерв', cost: 200, time: 240, desc: '+2 резервных автотрансформатора; запас топлива, если нефтебаза разрушена' },
};
export const BUILD_GROUPS = [['Торговля и логистика', ['store', 'fuel', 'market', 'mall', 'hub', 'autopark']], ['Сельское хозяйство и производство', ['elevator', 'agro', 'mill', 'dairy']], ['Люди', ['housing', 'hospital', 'school']], ['Энергетика и резервы', ['solar', 'bess', 'reserve', 'pontoon']], ['Военное', ['launch', 'decoy']]];
const UPG = new Set(['store', 'fuel', 'market', 'mall', 'hub', 'elevator', 'agro', 'launch', 'housing', 'mill', 'dairy', 'solar', 'bess', 'autopark']);
export const upgradeCost = (o) => Math.round((BUILD[o.kind]?.cost || 100) * 0.6 * (o.level || 1));
export const levelK = (o, k = 0.5) => 1 + k * ((o.level || 1) - 1);

const hashStr = (s) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };
const areaOf = (poly) => { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; };

export class DWEconomy {
  constructor(g) {
    this.g = g;
    this.sim = g.sim;
    this.world = g.world;
    this.farms = [];
    this.nextBuilt = 100000;
    this.side = {};
    for (const side of ['blue', 'red']) this.side[side] = { launchLog: [], parts: 70, partsWarn: 0, lostGrain: 0, harvested: 0, exported: 0, taxAvg: 0 };
    this.setupPopulation();
    this.setupFarms();
    this.pendingCrop = [];
    this.farmT = 0;
    this.grainT = 0;
  }
  get logi() { return this.g.logi; }

  // ---------------------------------------------------------------- Население
  setupPopulation() {
    for (const s of this.world.settlements) {
      s.pop = s.type === 'city' ? (s.capital ? 180000 : 65000) : 700 + (hashStr(s.name) % 2300);
      s.fear = 0;
      s.happy = 0.85;
    }
  }
  settlementsOf(side) { return this.world.settlements.filter((s) => s.side === side); }
  nearestPS(side, x, y) {
    let best = null, bd = Infinity;
    for (const p of this.g.objs(side, 'ps110')) { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p; } }
    return best;
  }
  onImpact(x, y, wh = 50) {
    // удар по полю, где идёт работа: техника выбита на 10 минут (экономическая война)
    for (const f of this.farms) {
      if (!f.work || Math.hypot(f.x - x, f.y - y) > 4000) continue;
      const fl = this.world.fields.items[f.fields[f.work.fi]?.i];
      if (!fl || !pointInPoly(x, y, fl.poly) || !this.sim.rng.chance(wh >= 15 ? 0.6 : 0.35)) continue;
      (f.lost = f.lost || []).push({ kind: f.work.kind, until: this.sim.time + 600 });
      this.sim.msg(`${f.name}: ${f.work.kind === 'combine' ? 'комбайн' : 'трактор'} уничтожен ударом дрона — работы встали до замены техники`, f.side);
    }
    for (const s of this.world.settlements) {
      const d = Math.hypot(s.x - x, s.y - y), R = s.type === 'city' ? 4000 : 2500;
      if (d < R) s.fear = Math.min(1, s.fear + (0.12 + wh / 600) * (1 - d / R));
    }
  }
  // Мобилизация: люди в расчётах ПВО, ремонтных бригадах и на стартовых позициях не работают
  mobilized(side) {
    let n = 0;
    for (const a of this.g.ad) if (a.side === side && !a.dead) n += CREW_SIZE[a.type] || 3;
    n += this.g.sides[side].crews.length * 6;
    n += this.g.objs(side, 'launch').filter((o) => !o.build).length * 20;
    return n;
  }
  labor(side) {
    const pop = this.settlementsOf(side).reduce((a, s) => a + s.pop, 0);
    const schools = this.g.objs(side, 'school').filter((o) => this.ready(o)).length;
    const share = this.mobilized(side) / Math.max(1, pop * 0.005 * (1 + 0.15 * Math.min(4, schools)));
    return Math.max(0.5, (1 - 0.27 * Math.min(1.5, share)) * (this.g.state?.k(side, 'labor') ?? 1));
  }
  upkeep(side) {
    let u = 0;
    for (const a of this.g.ad) if (a.side === side && !a.dead) u += UPKEEP[a.type] || 0;
    u += this.g.objs(side, 'launch').filter((o) => !o.build).length * LAUNCH_UPKEEP;
    return u;
  }
  // Налоги (оч/мин) и довольство по поселениям
  taxes(side, dt) {
    const L = this.logi.side[side];
    const shops = [...L.markets, ...L.fuels].filter((m) => !m.build);
    const morale = (this.g.sides[side].morale ?? 100) / 100;
    let sum = 0;
    for (const s of this.settlementsOf(side)) {
      s.fear *= Math.exp((-dt / 300) * (this.g.state?.k(side, 'fearDecay') ?? 1));
      const ps = s._ps || (s._ps = this.nearestPS(side, s.x, s.y));
      const power = ps ? ps.supply ?? 1 : 1;
      let goods = 0.4;
      for (const m of shops) if (m.stock >= 1 && Math.hypot(m.x - s.x, m.y - s.y) < (s.type === 'city' ? 7000 : 6000)) { goods = 1; break; }
      let bonus = 0;
      for (const o of this.g.objs(side)) {
        if ((o.kind !== 'hospital' && o.kind !== 'school') || !this.ready(o)) continue;
        const d = Math.hypot(o.x - s.x, o.y - s.y);
        if (o.kind === 'hospital' && d < 8000) { bonus += 0.06; s.fear *= Math.exp(-dt / 300); }
        if (o.kind === 'school' && d < 6000) bonus += 0.03;
      }
      s.happy = Math.max(0, Math.min(1, (0.2 + 0.5 * power + 0.3 * goods) * (1 - 0.45 * s.fear) * (0.6 + 0.4 * morale) + Math.min(0.12, bonus) + (this.g.state?.happyAdd(side) ?? 0)));
      sum += (s.pop / 1000) * TAX * s.happy;
    }
    return sum;
  }

  // ---------------------------------------------------------------- Агрофирмы
  setupFarms() {
    const g = this.g, W = this.world;
    const frontX = g.frontX;
    const R = this.logi.roads;
    const vill = W.settlements.filter((s) => s.type === 'village');
    const farms = new Map();
    for (const v of vill) {
      const id = this.farms.length;
      const n = R.nearest(v.x, v.y, 1500);
      const f = { id, side: v.side, name: `Агрофирма «${v.name}»`, x: v.x, y: v.y, gate: n >= 0 ? [R.x[n], R.y[n]] : [v.x, v.y], fields: [], tractors: 1, combines: 1, grain: 0, off: (hashStr(v.name) % 1000) / 1000 * CYCLE, stage: null, work: null, fuel: 0, tank: 14, tanker: null, noFuel: false, truck: null, harvested: 0 };
      this.farms.push(f); farms.set(v, f);
    }
    W.fields.items.forEach((fl, i) => {
      if (fl.kind !== 'field' || !fl.poly || /^(dry|green|bare)$/.test(fl.crop)) return;
      let cx = 0, cy = 0; for (const [x, y] of fl.poly) { cx += x; cy += y; } cx /= fl.poly.length; cy /= fl.poly.length;
      if (Math.abs(cx - frontX) < 2500) return; // у фронта поля брошены
      const side = cx < frontX ? 'blue' : 'red';
      let best = null, bd = 3200;
      for (const v of vill) { if (v.side !== side) continue; const d = Math.hypot(v.x - cx, v.y - cy); if (d < bd) { bd = d; best = v; } }
      if (!best) return;
      const f = farms.get(best);
      f.fields.push({ i, ha: areaOf(fl.poly) / 10000, type: fl.crop === 'sunflower' || fl.crop === 'corn' ? 'sunflower' : 'wheat', x: cx, y: cy, d: bd, sown: true, done: false, look: fl.crop });
    });
    for (const f of this.farms) { f.fields.sort((a, b) => a.d - b.d); f.fields.length = Math.min(f.fields.length, 22); }
    this.farms = this.farms.filter((f) => f.fields.length);
    this.farms.forEach((f, i) => { f.id = i; });
  }
  stageOf(f, t) {
    let ph = ((t + f.off) % CYCLE) / CYCLE, acc = 0;
    for (const [name, len] of STAGES) { if (ph < acc + len) return { name, k: (ph - acc) / len }; acc += len; }
    return { name: 'rest', k: 1 };
  }
  look(f, fd, crop) {
    if (fd.look === crop) return;
    fd.look = crop;
    this.pendingCrop.push([fd.i, crop]);
  }
    // Солярка — из своей ёмкости ГСМ (её пополняют бензовозы с нефтебазы); с АЗС не берём
  takeFuel(f) {
    if (f.tank < 1) return false;
    f.tank -= 1; f.fuel += FUEL_HA;
    return true;
  }
  machines(f) {
    let k = 0;
    for (const o of this.g.objects) if (o.kind === 'agro' && o.side === f.side && !o.build && o.farm === f.id && o.comps.some((c) => c.state !== 'destroyed')) k += o.level || 1;
    const t = this.sim.time;
    f.lost = (f.lost || []).filter((q) => q.until > t);
    const lost = (kind) => f.lost.filter((q) => q.kind === kind).length;
    return { tractors: Math.max(0, f.tractors + k - lost('tractor')), combines: Math.max(0, f.combines + k - lost('combine')) };
  }
  updateFarms(dt) {
    const t = this.sim.time;
    for (const f of this.farms) {
      const st = this.stageOf(f, t);
      if (f.stage === null) {
        // начало партии: часть работ текущего этапа уже сделана
        f.stage = st.name;
        const n = Math.floor(f.fields.length * st.k);
        f.fields.forEach((fd, k) => { if (st.name === 'sow') fd.sown = k < n; if (st.name === 'harvest' || st.name === 'rest') fd.done = st.name === 'rest' || k < n; });
        continue;
      }
      if (st.name !== f.stage) {
        const prev = f.stage;
        f.stage = st.name;
        if (st.name === 'sow') for (const fd of f.fields) { fd.sown = false; fd.done = false; this.look(f, fd, 'plowed'); }
        else if (st.name === 'grow') for (const fd of f.fields) { if (fd.sown) this.look(f, fd, fd.type === 'sunflower' ? 'corn' : 'meadow'); }
        else if (st.name === 'rest' && prev === 'harvest') {
          // неубранное к зиме пропадает
          let lost = 0;
          for (const fd of f.fields) if (fd.sown && !fd.done) { lost += fd.ha * YIELD[fd.type] * 0.8; fd.done = true; this.look(f, fd, 'stubble'); }
          if (lost > 0) { this.side[f.side].lostGrain += lost; if (lost > 1500) this.sim.msg(`${f.name}: не успели убрать урожай — пропало ${Math.round(lost)} т зерна`, f.side); }
        }
        f.work = null;
      }
      if (st.name === 'grow' && st.k > 0.5) for (const fd of f.fields) if (fd.sown) this.look(f, fd, fd.type === 'sunflower' ? 'sunflower' : 'wheat');
      if (st.name === 'rest') { for (const fd of f.fields) if (fd.done && st.k > 0.3) this.look(f, fd, 'plowed'); continue; }
      if (st.name !== 'sow' && st.name !== 'harvest') { f.work = null; continue; }
      // работа: поле за полем
      const harvest = st.name === 'harvest';
      if (!f.work) {
        const fd = f.fields.find((q) => !this.world.fields.items[q.i]?.removed && (harvest ? q.sown && !q.done : !q.sown));
        if (!fd) continue;
        f.work = { fi: f.fields.indexOf(fd), prog: 0, kind: harvest ? 'combine' : 'tractor', t0: t };
      }
      const fd = f.fields[f.work.fi];
      const mc = this.machines(f);
      const n = harvest ? mc.combines : mc.tractors;
      if (n <= 0) { f.noMachines = true; continue; }
      f.noMachines = false;
      const ha = RATE[f.work.kind] * n * dt;
      if (f.fuel < ha && !this.takeFuel(f)) { f.noFuel = true; continue; }
      f.noFuel = false;
      f.fuel -= ha;
      f.work.prog += ha / Math.max(1, fd.ha);
      if (f.work.prog >= 1) {
        if (harvest) {
          fd.done = true;
          const tons = fd.ha * YIELD[fd.type] * (this.g.state?.k(f.side, 'yield') ?? 1);
          f.grain += tons; f.harvested += tons; this.side[f.side].harvested += tons;
          if (f.grain > FARM_CAP) { this.side[f.side].lostGrain += f.grain - FARM_CAP; f.grain = FARM_CAP; }
          this.look(f, fd, 'stubble');
        } else { fd.sown = true; this.look(f, fd, 'harrowed'); }
        f.work = null;
      }
    }
  }
  // Зерновозы: ток агрофирмы → элеватор; элеватор → погранпереход (экспорт)
  count(side, kind) { return this.g.objs(side, kind).filter((o) => this.ready(o)).length; }
  elevators(side) { return this.g.objs(side, 'elevator').filter((o) => !o.build && o.comps.some((c) => c.k === 'silo' && c.state !== 'destroyed')); }
  elevCap(o) { const s = o.comps.filter((c) => c.k === 'silo'); return ELEV_CAP * levelK(o) * (s.filter((c) => c.state !== 'destroyed').length / Math.max(1, s.length)); }
  updateGrain() {
    const g = this.g, logi = this.logi;
    for (const side of ['blue', 'red']) {
      const L = logi.side[side];
      const onRoad = (k) => logi.vehicles.filter((v) => !v.dead && v.side === side && v.kind === k).length;
      let trucks = onRoad('grain');
      const els = this.elevators(side);
      for (const e of g.objs(side, 'elevator')) {
        e.grain = e.grain || 0;
        const cap = this.elevCap(e);
        if (e.grain > cap) { const burnt = e.grain - cap; e.grain = cap; this.side[side].lostGrain += burnt; if (burnt > 500) this.sim.msg(`${e.name}: разрушены силосы — потеряно ${Math.round(burnt)} т зерна`, side); }
      }
      if (els.length) {
        for (const f of this.farms) {
          if (f.side !== side || trucks >= 16 + 6 * this.count(side, 'autopark') || f.truck) continue;
          if (f.grain < LOT && !(f.stage === 'rest' && f.grain > 300)) continue;
          const byDist = els.slice().sort((a, b) => Math.hypot(a.x - f.x, a.y - f.y) - Math.hypot(b.x - f.x, b.y - f.y));
          for (const e of byDist) {
            if ((e.grain + (e.coming || 0)) >= this.elevCap(e)) continue;
            const load = Math.min(LOT, f.grain);
            const v = logi.spawn(side, 'grain', f.gate, logi.gate(e), { type: 'grain', farm: f.id, to: e.id, load });
            if (v) { f.grain -= load; f.truck = v.id; e.coming = (e.coming || 0) + load; trucks++; break; }
          }
        }
      }
      // Бензовозы с нефтебазы на мехдворы агрофирм (солярка для тракторов и комбайнов)
      let depot = L.oilDepot;
      let depotOk = depot && depot.comps.some((c) => c.k === 'tank' && c.state !== 'destroyed') && depot.comps.some((c) => (c.k === 'pump' || c.k === 'rack') && c.state !== 'destroyed');
      if (!depotOk) { const r = this.g.objs(side, 'reserve').find((o) => this.ready(o) && o.comps.some((c) => c.k === 'tank' && c.state !== 'destroyed')); if (r) { depot = r; depotOk = true; } } // госрезерв
      if (depotOk) {
        const needF = this.farms.filter((f) => f.side === side && !f.tanker && f.tank < 10).sort((a, b) => a.tank - b.tank);
        let n = 0;
        for (const f of needF) {
          if (n >= (3 + this.count(side, 'autopark')) * (this.g.state?.k(side, 'farmFuel') ?? 1)) break;
          const v = logi.spawn(side, 'tanker', logi.gate(depot), f.gate, { type: 'farmfuel', farm: f.id, load: 10, home: depot.id });
          if (v) { f.tanker = v.id; n++; }
        }
      }
      // экспорт с элеваторов
      const borderOk = L.border.comps.some((c) => c.state !== 'destroyed');
      let xs = onRoad('grainx');
      if (borderOk) for (const e of els) {
        if (xs >= 10 || e.grain < XLOT) continue;
        const v = logi.spawn(side, 'grainx', logi.gate(e), logi.gate(L.border), { type: 'grainx', from: e.id, load: XLOT });
        if (v) { e.grain -= XLOT; xs++; }
      }
    }
  }
  // Прибытие зерновоза (вызывается логистикой); true — обработано
  arrive(v) {
    const T = v.task, logi = this.logi;
    if (T.type === 'farmfuel') {
      const f = this.farms[T.farm];
      if (v.state === 'back') { logi.home(v); return true; }
      if (f) { f.tank = Math.min(20, f.tank + T.load); if (f.tanker === v.id) f.tanker = null; }
      const home = this.g.obj(T.home);
      if (!home || !logi.send(v, logi.gate(home), 'back')) logi.home(v);
      return true;
    }
    if (T.type === 'grain') {
      const e = this.g.obj(T.to), f = this.farms[T.farm];
      if (v.state === 'back') { if (f && f.truck === v.id) f.truck = null; logi.home(v); return true; }
      if (e) { e.coming = Math.max(0, (e.coming || 0) - T.load); if (!e.build && e.comps.some((c) => c.k === 'silo' && c.state !== 'destroyed')) e.grain = (e.grain || 0) + T.load; else this.side[v.side].lostGrain += T.load; }
      if (f && f.truck === v.id) f.truck = null;
      if (!f || !logi.send(v, f.gate, 'back')) logi.home(v);
      return true;
    }
    if (T.type === 'grainx') {
      if (v.state === 'back') { logi.home(v); return true; }
      const L = logi.side[v.side];
      if (L.border.comps.some((c) => c.state !== 'destroyed')) {
        logi.earn(v.side, T.load * PRICE * (this.g.state?.grainPrice ?? 1), v.x, v.y, 'agro'); // фаза учитывается в earn
        this.side[v.side].exported += T.load;
      }
      const e = this.g.obj(T.from);
      if (!e || !logi.send(v, logi.gate(e), 'back')) logi.home(v);
      return true;
    }
    return false;
  }
  onLost(v) {
    if (v.task?.type === 'farmfuel') { const f = this.farms[v.task.farm]; if (f && f.tanker === v.id) f.tanker = null; }
    if (v.kind === 'grain') { const f = this.farms[v.task.farm]; if (f && f.truck === v.id) f.truck = null; const e = this.g.obj(v.task.to); if (e && v.state !== 'back') e.coming = Math.max(0, (e.coming || 0) - v.task.load); }
    if ((v.kind === 'grain' || v.kind === 'grainx') && v.state !== 'back') this.side[v.side].lostGrain += v.task.load || 0;
  }

  // ---------------------------------------------------------------- Комплектующие для дронов
  onImport(side) { const E = this.side[side]; E.parts = Math.min(150, E.parts + 3); }
  partsK(side) { return this.side[side].parts >= 10 ? 1 : 1.5; }
  useParts(side, cost) {
    const E = this.side[side];
    E.parts = Math.max(0, E.parts - (cost / 12) * (this.g.state?.k(side, 'parts') ?? 1));
    if (E.parts < 10 && this.sim.time - E.partsWarn > 120) { E.partsWarn = this.sim.time; this.sim.msg('Дефицит комплектующих для дронов: импорт не успевает — дроны в полтора раза дороже', side); }
  }

  // ---------------------------------------------------------------- Пропускная способность пусковых
  launchCap(side) {
    let cap = 0;
    for (const o of this.g.objs(side, 'launch')) if (!o.build) cap += o.comps.filter((c) => c.k === 'launcher' && this.g.compOk(c)).length * LAUNCH_PER * levelK(o);
    return Math.round(cap * (this.g.state?.k(side, 'launch') ?? 1));
  }
  launchUsed(side) {
    const E = this.side[side], t = this.sim.time;
    E.launchLog = E.launchLog.filter(([t0]) => t - t0 < 300);
    return E.launchLog.reduce((a, [, n]) => a + n, 0);
  }
  launchFree(side) { if (this.remote) return this.remote[side]?.[5] ?? 0; return Math.max(0, this.launchCap(side) - this.launchUsed(side)); }
  useLaunch(side, n) { this.side[side].launchLog.push([this.sim.time, n]); }

  // ---------------------------------------------------------------- Стройка
  territoryOk(side, x) { const fx = this.g.frontX; return side === 'blue' ? x < fx - 1500 : x > fx + 1500; }
  // Место под объект: своя земля, у дороги (не дальше 400 м), площадка свободна
  siteFor(side, kind, x, y) {
    const W = this.world, R = this.logi.roads;
    if (!BUILD[kind]) return { err: 'Такой объект не строится' };
    if (x < 300 || y < 300 || x > W.W - 300 || y > W.H - 300) return { err: 'За краем карты' };
    if (!this.territoryOk(side, x)) return { err: 'Только на своей территории, не ближе 1,5 км к фронту' };
    const B = BUILD[kind];
    if (B.near === 'city' && !this.world.settlements.some((q) => q.side === side && q.type === 'city' && Math.hypot(q.x - x, q.y - y) < 4000)) return { err: 'Только у города (не дальше 4 км от центра)' };
    if (B.near === 'village' && !this.world.settlements.some((q) => q.side === side && q.type === 'village' && Math.hypot(q.x - x, q.y - y) < 2500)) return { err: 'Только у села (не дальше 2,5 км)' };
    if (B.near === 'ps110' && !this.g.objs(side, 'ps110').some((q) => Math.hypot(q.x - x, q.y - y) < 1500)) return { err: 'Только рядом с ПС 110 кВ (до 1,5 км)' };
    if (kind === 'pontoon') {
      // у моста: понтоны наводят рядом, ниже по течению
      let br = null, bd = 600;
      for (const b of this.g.objs(side, 'bridge')) { if (b.btype === 'rail') continue; const d = Math.hypot(b.x - x, b.y - y); if (d < bd) { bd = d; br = b; } }
      if (!br) return { err: 'Кликните у автомобильного моста (до 600 м)' };
      if (this.g.objects.some((o) => o.kind === 'pontoon' && o.bridge === br.id)) return { err: 'У этого моста понтоны уже есть' };
      const nx = -Math.sin(br.angle), ny = Math.cos(br.angle), off = 45;
      return { x: br.x + nx * off, y: br.y + ny * off, angle: br.angle, gate: [br.x, br.y], gateQ: 0, drive: null, lay: infraLayout('pontoon', (br.L || 80) + 30), L: (br.L || 80) + 30, bridge: br.id };
    }
    const n = R.nearest(x, y, 400);
    if (n < 0) return { err: 'Нужна дорога рядом (до 400 м)' };
    const nb = R.adj[n][0]?.[0] ?? n;
    const rx = R.x[n], ry = R.y[n];
    let ang = Math.atan2(R.y[nb] - ry, R.x[nb] - rx);
    if (Math.abs(ang) > Math.PI / 2) ang += Math.PI;
    const lay = infraLayout(kind);
    const pad = lay.w >= 140 ? 45 : lay.w >= 60 ? 22 : 12;
    // площадка — не на самой дороге: отодвигаем от оси, если клик слишком близко
    const nx = -Math.sin(ang), ny = Math.cos(ang);
    let side2 = (x - rx) * nx + (y - ry) * ny >= 0 ? 1 : -1;
    const need = lay.h / 2 + pad + 10;
    let d = Math.abs((x - rx) * nx + (y - ry) * ny);
    if (d < need) { x += side2 * nx * (need - d); y += side2 * ny * (need - d); d = need; }
    const apron = rectCorners(x, y, lay.w + pad * 2, lay.h + pad * 2, ang);
    if (!W.mask.polyFree(apron, M.BUILD | M.ROAD | M.WATER | M.RAIL, 8)) return { err: 'Место занято (дома, дорога, вода или другой объект)' };
    // охранная зона ЛЭП: под проводами не строят
    const R0 = Math.max(lay.w, lay.h) / 2 + pad + 15;
    for (const ln of [...(W.power?.lines || []), ...(W.power?.mains || [])]) {
      const P = ln.pylons || [];
      for (let i = 1; i < P.length; i++) {
        const a = P[i - 1], b = P[i];
        if (Math.min(a.x, b.x) - R0 > x || Math.max(a.x, b.x) + R0 < x || Math.min(a.y, b.y) - R0 > y || Math.max(a.y, b.y) + R0 < y) continue;
        const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2));
        if (Math.hypot(a.x + dx * t - x, a.y + dy * t - y) < R0) return { err: 'Охранная зона ЛЭП — под проводами строить нельзя' };
      }
    }
    // ворота — сторона к дороге
    const gq = side2 > 0 ? -Math.PI / 2 : Math.PI / 2;
    const gate = [x + Math.cos(ang + gq) * (lay.h / 2 + 8), y + Math.sin(ang + gq) * (lay.h / 2 + 8)];
    const drive = [gate, [rx, ry]];
    const L = Math.hypot(rx - gate[0], ry - gate[1]);
    for (let t = 10; t < L - 10; t += 10) {
      const px = gate[0] + ((rx - gate[0]) * t) / L, py = gate[1] + ((ry - gate[1]) * t) / L;
      if (W.mask.has(px, py, M.WATER | M.RAIL) || (W.mask.has(px, py, M.BUILD) && !pointInPoly(px, py, apron))) return { err: 'Подъезд к дороге перекрыт' };
    }
    return { x, y, angle: ang, gate, gateQ: gq, drive, lay };
  }
  cost(side, kind) { return Math.round(BUILD[kind].cost * (this.g.state?.k(side, 'build') ?? 1)); }
  nearName(x, y, side) {
    let best = null, bd = Infinity;
    for (const s of this.world.settlements) { if (s.side !== side) continue; const d = Math.hypot(s.x - x, s.y - y); if (d < bd) { bd = d; best = s; } }
    return best?.name || '';
  }
  build(side, kind, x, y) {
    const g = this.g, S = g.sides[side], B = BUILD[kind];
    if (g.winner) return 'Партия окончена';
    const site = this.siteFor(side, kind, x, y);
    if (site.err) return site.err;
    const cost = this.cost(side, kind);
    if (S.points < cost) return `Не хватает очков: нужно ${cost}`;
    S.points -= cost; S.stats.spent += cost;
    const nm = this.nearName(site.x, site.y, side);
    const name = kind === 'decoy' ? `ПС 110 кВ «${nm}-${2 + (this.nextBuilt % 3)}»` : kind === 'store' ? `Магазин, ${nm}` : kind === 'fuel' ? `АЗС «${side === 'blue' ? 'Велойл' : 'Кардойл'}», ${nm}` : kind === 'pontoon' ? `Понтонная переправа у моста «${this.g.obj(site.bridge)?.name.replace(/^Мост через /, '')}»` : `${B.name} «${nm}»`;
    const o = this.addObject({ id: this.nextBuilt++, side, kind, name, mimic: kind === 'decoy' ? 'ps110' : undefined, x: site.x, y: site.y, angle: site.angle, w: site.lay.w, h: site.lay.h, gate: site.gate, gateQ: site.gateQ, drive: site.drive, L: site.L, bridge: site.bridge, level: 1, build: { until: this.sim.time + B.time, total: B.time }, built: true });
    this.sim.msg(`Стройка: ${name} — готово через ${Math.round(B.time / 60)} мин (−${cost} оч.)`, side);
    return o ? null : 'Не удалось';
  }
  // Объект по описанию (стройка у хоста, воссоздание у гостя по снимку)
  addObject(d, remote = false) {
    const g = this.g;
    const lay = infraLayout(d.kind, d.L);
    const c = Math.cos(d.angle), s = Math.sin(d.angle);
    const obj = { ...d, comps: [] };
    for (const q of lay.comps) {
      const comp = { id: `${d.id}:${obj.comps.length}`, oid: d.id, obj, k: q.k, name: q.n, u: q.u, v: q.v, w: q.w, h: q.h, x: d.x + q.u * c - q.v * s, y: d.y + q.u * s + q.v * c, angle: d.angle, hp: 1, state: 'ok', fire: 0, shelter: 0, repair: null, burned: false };
      obj.comps.push(comp);
      g.comps.set(comp.id, comp);
    }
    g.objects.push(obj);
    g.byId.set(obj.id, obj);
    const L = this.logi.side[d.side];
    if (d.kind === 'store' || d.kind === 'market' || d.kind === 'mall') { obj.stock = 0; obj.saleT = SALE[d.kind].every; obj.cut = false; L.markets.push(obj); }
    if (d.kind === 'fuel') { obj.stock = 0; obj.saleT = SALE.fuel.every; obj.cut = false; L.fuels.push(obj); }
    if (d.kind === 'hub') { obj.stock = 0; }
    if (d.kind === 'launch') L.depots.push(obj);
    if (d.kind === 'elevator') obj.grain = 0;
    if (d.kind === 'agro' && d.farm === undefined) { let best = null, bd = 6000; for (const f of this.farms) { if (f.side !== d.side) continue; const q = Math.hypot(f.x - d.x, f.y - d.y); if (q < bd) { bd = q; best = f; } } obj.farm = best ? best.id : -1; }
    for (const st of this.world.settlements) st._ps = null;
    if (remote) return obj; // у гостя площадку добавляет событие мира от хоста
    const bbox = addSite(this.world, { kind: d.kind, x: d.x, y: d.y, angle: d.angle, gateQ: d.gateQ, drive: d.drive, L: d.L });
    this.sim.events.push({ type: 'net', ev: { k: 'site', s: { kind: d.kind, x: d.x, y: d.y, angle: d.angle, gateQ: d.gateQ, drive: d.drive, L: d.L } } });
    this.sim.events.push({ type: 'forts', bbox });
    return obj;
  }
  upgrade(side, id) {
    const g = this.g, S = g.sides[side], o = g.obj(id);
    if (!o || o.side !== side) return 'Нет такого объекта';
    if (!UPG.has(o.kind)) return 'Этот объект не улучшается';
    if (o.build) return 'Идут работы';
    if ((o.level || 1) >= 3) return 'Уже максимальный уровень';
    if (o.comps.some((c) => c.state === 'destroyed')) return 'Сначала восстановите объект';
    const cost = Math.round(upgradeCost(o) * (this.g.state?.k(side, 'build') ?? 1));
    if (S.points < cost) return `Не хватает очков: нужно ${cost}`;
    S.points -= cost; S.stats.spent += cost;
    o.build = { until: this.sim.time + 150, total: 150, up: true };
    this.sim.msg(`${o.name}: реконструкция до ${(o.level || 1) + 1}-го уровня (−${cost} оч.)`, side);
    return null;
  }
  updateBuilds() {
    const t = this.sim.time;
    for (const o of this.g.objects) {
      if (!o.build || t < o.build.until) continue;
      const up = o.build.up;
      o.build = null;
      if (up) o.level = (o.level || 1) + 1;
      this.sim.msg(up ? `${o.name}: реконструкция завершена — ${o.level}-й уровень` : `${o.name}: построен и работает`, o.side);
      if (o.kind === 'hub' && !up) { o.stock = 10; }
      this.onReady(o, up);
    }
  }

  // Объект достроен (или реконструирован): разовые эффекты
  onReady(o, up) {
    const S = this.g.sides[o.side], L = this.logi.side[o.side];
    if (o.kind === 'housing') {
      const c = this.nearCity(o);
      if (c) { const add = up ? 15000 : 30000; c.pop += add; this.sim.msg(`${c.name}: заселён новый квартал — +${add / 1000} тыс. жителей`, o.side); }
    }
    if (o.kind === 'autopark') L.trucksFree += 3;
    if (o.kind === 'reserve' && !up) S.spare += 2;
    if (o.kind === 'bess') { o.charge = 1; o.ps = this.nearestPS(o.side, o.x, o.y)?.id; }
    if (o.kind === 'solar') o.ps = this.nearestPS(o.side, o.x, o.y)?.id;
  }
  nearCity(o) {
    let best = null, bd = Infinity;
    for (const q of this.world.settlements) { if (q.side !== o.side || q.type !== 'city') continue; const d = Math.hypot(q.x - o.x, q.y - o.y); if (d < bd) { bd = d; best = q; } }
    return best;
  }
  ready(o) { return !(o.build && !o.build.up) && o.comps.some((c) => c.state !== 'destroyed'); }
  // Производство: мелькомбинаты (зерно → мука и хлеб) и молочные фермы
  production() {
    const g = this.g, logi = this.logi;
    for (const o of g.objects) {
      if ((o.kind !== 'mill' && o.kind !== 'dairy') || !this.ready(o)) continue;
      const lv = o.level || 1, L = logi.side[o.side];
      if (o.kind === 'mill') {
        const ps = this.nearestPS(o.side, o.x, o.y);
        if ((ps?.supply ?? 1) < 0.5) { o.idle = 'нет света'; continue; }
        let el = null, bd = 20000;
        for (const e of g.objs(o.side, 'elevator')) { if ((e.grain || 0) < 200 * lv) continue; const d = Math.hypot(e.x - o.x, e.y - o.y); if (d < bd) { bd = d; el = e; } }
        if (!el) { o.idle = 'нет зерна на элеваторах'; continue; }
        o.idle = null;
        el.grain -= 200 * lv;
        const hub = g.objs(o.side, 'hub').filter((h) => this.ready(h)).sort((a, b) => Math.hypot(a.x - o.x, a.y - o.y) - Math.hypot(b.x - o.x, b.y - o.y))[0];
        if (hub) hub.stock = Math.min(logi.hubCap(hub), hub.stock + lv);
        logi.earn(o.side, 0.8 * lv, o.x, o.y, 'trade');
      } else {
        o.idle = null;
        const shop = L.markets.filter((m) => this.ready(m) && Math.hypot(m.x - o.x, m.y - o.y) < 6000 && m.stock < logi.sale(m).cap).sort((a, b) => a.stock - b.stock)[0];
        if (shop) shop.stock += 1;
        logi.earn(o.side, 0.4 * lv, o.x, o.y, 'trade');
      }
    }
  }
  // Население: рост при довольстве, отток при страхе (беженцы уезжают в другие места своей стороны)
  population(dtMin) {
    for (const side of ['blue', 'red']) {
      const ss = this.settlementsOf(side);
      let moved = 0;
      for (const q of ss) {
        q.pop *= 1 + 0.004 * (q.happy - 0.75) * dtMin;
        if (q.fear > 0.5 && q.type === 'city') { const m = q.pop * 0.003 * dtMin * q.fear; q.pop -= m; moved += m; }
      }
      if (moved > 0) { const calm = ss.filter((q) => q.fear < 0.3); const tot = calm.reduce((a, q) => a + q.pop, 0) || 1; for (const q of calm) q.pop += (moved * q.pop) / tot; }
      for (const q of ss) q.pop = Math.max(300, q.pop);
    }
  }
  // Частный бизнес, инвесторы, сборы на армию — когда в тылу спокойно
  society() {
    const g = this.g, t = this.sim.time, rng = this.sim.rng;
    for (const side of ['blue', 'red']) {
      const S = g.sides[side], E = this.side[side], sum = this.summary(side);
      E.invest = E.invest || 0;
      if (t > (E.bizT || 0) && sum.happy > 0.85 && (S.morale ?? 100) > 70) {
        E.bizT = t + 360 + rng.float(0, 240);
        // село без магазина рядом — открывается частный магазин
        const L = this.logi.side[side];
        const v = this.settlementsOf(side).filter((q) => q.type === 'village' && q.happy > 0.8 && !L.markets.some((m) => Math.hypot(m.x - q.x, m.y - q.y) < 1500 && m.comps.some((c) => c.state !== 'destroyed')));
        const q = v[rng.int(0, Math.max(0, v.length - 1))];
        if (q) for (let k = 0; k < 8; k++) {
          const x = q.x + rng.float(-600, 600), y = q.y + rng.float(-600, 600);
          const st = this.siteFor(side, 'store', x, y);
          if (st.err) continue;
          this.addObject({ id: this.nextBuilt++, side, kind: 'store', name: `Магазин (частный), ${q.name}`, x: st.x, y: st.y, angle: st.angle, w: st.lay.w, h: st.lay.h, gate: st.gate, gateQ: st.gateQ, drive: st.drive, level: 1, build: null, built: true, private: true });
          this.sim.msg(`Частный бизнес: в селе ${q.name} открылся магазин`, side);
          break;
        }
      }
      if (t > (E.invT || 0)) {
        E.invT = t + 600;
        if ((S.morale ?? 100) >= 80 && S.supply >= 0.9 && E.invest < 20) { E.invest += 2; this.sim.msg(`Инвесторы вложились в производство: промышленность +2 оч/мин (всего +${E.invest})`, side); }
      }
      E.donate = (S.morale ?? 100) >= 85 ? 2 + 2 * sum.happy : 0;
    }
  }
  // Прочий доход стороны (оч/мин): инвестиции и сборы на армию
  extraIncome(side) { const E = this.side[side]; return (E.invest || 0) + (E.donate || 0); }
  // Мощность накопителей и построенных станций для расчёта потока (вызывает энергосистема)
  gridExtras(side) {
    const out = [];
    for (const o of this.g.objs(side)) {
      if (!this.ready(o)) continue;
      if (o.kind === 'bess' && o.ps != null) {
        const ps = this.g.obj(o.ps);
        const deficit = ps && (ps.supply ?? 1) < 0.98;
        if (deficit && o.charge > 0.02) { out.push({ ps: o.ps, mw: 30 * (o.level || 1), kind: 'bess' }); o.charge = Math.max(0, o.charge - 2 / 600); }
        else o.charge = Math.min(1, (o.charge ?? 1) + 2 / 900);
      }
    }
    return out;
  }
  // ---------------------------------------------------------------- Главный цикл
  update(dt) {
    this.updateBuilds();
    this.farmT -= dt;
    if (this.farmT <= 0) { this.updateFarms(1 - this.farmT); this.farmT = 1; }
    this.grainT -= dt;
    if (this.grainT <= 0) { this.grainT = 3; this.updateGrain(); }
    this.prodT = (this.prodT ?? 30) - dt;
    if (this.prodT <= 0) { this.prodT = 30; this.production(); this.population(0.5); this.society(); }
    if (this.pendingCrop.length) {
      // смена вида полей — фоновой отрисовке карты (пачкой)
      const list = this.pendingCrop.splice(0);
      const W = this.world;
      let bb = null;
      for (const [i, crop] of list) {
        const f = W.fields.items[i];
        if (!f) continue;
        f.crop = crop;
        bb = bb ? { x0: Math.min(bb.x0, f.bbox.x0), y0: Math.min(bb.y0, f.bbox.y0), x1: Math.max(bb.x1, f.bbox.x1), y1: Math.max(bb.y1, f.bbox.y1) } : { ...f.bbox };
        this.sim.events.push({ type: 'forts', bbox: f.bbox });
      }
      this.sim.events.push({ type: 'net', ev: { k: 'crop', f: list } });
      void bb;
    }
  }
  // ---------------------------------------------------------------- Сеть: снимок для гостя
  snap() {
    const R1 = (v) => Math.round(v * 10) / 10;
    return {
      bo: this.g.objects.filter((o) => o.built).map((o) => [o.id, o.side, o.kind, o.name, R1(o.x), R1(o.y), o.angle, o.gate, o.gateQ, o.drive, o.farm ?? -1, o.L || 0, o.bridge ?? 0, o.mimic || 0]),
      lv: this.g.objects.map((o) => [o.level || 1, o.build ? [R1(o.build.until), o.build.total, o.build.up ? 1 : 0] : 0, o.grain === undefined ? -1 : Math.round(o.grain)]),
      fm: this.farms.map((f) => [Math.round(f.grain), STAGES.findIndex((q) => q[0] === f.stage), f.work ? [f.work.fi, Math.round(f.work.prog * 100) / 100, f.work.kind === 'combine' ? 1 : 0, R1(f.work.t0)] : 0, f.noFuel ? 1 : 0, Math.round(f.tank)]),
      sd: ['blue', 'red'].map((sd) => { const E = this.side[sd]; return [Math.round(E.parts), Math.round(E.lostGrain), Math.round(E.harvested), Math.round(E.exported), this.launchCap(sd), this.launchFree(sd)]; }),
      st: this.world.settlements.map((q) => [Math.round(q.happy * 100), Math.round(q.fear * 100)]),
    };
  }
  applySnap(e) {
    for (const q of e.bo) if (!this.g.byId.has(q[0])) this.addObject({ id: q[0], side: q[1], kind: q[2], name: q[3], x: q[4], y: q[5], angle: q[6], gate: q[7], gateQ: q[8], drive: q[9], farm: q[10], L: q[11] || undefined, bridge: q[12] || undefined, mimic: q[13] || undefined, level: 1, built: true, build: null }, true);
    this.g.objects.forEach((o, i) => { const q = e.lv[i]; if (!q) return; o.level = q[0]; o.build = q[1] ? { until: q[1][0], total: q[1][1], up: !!q[1][2] } : null; if (q[2] >= 0) o.grain = q[2]; });
    e.fm.forEach((q, i) => { const f = this.farms[i]; if (!f) return; f.grain = q[0]; f.stage = STAGES[q[1]]?.[0] ?? f.stage; f.work = q[2] ? { fi: q[2][0], prog: q[2][1], kind: q[2][2] ? 'combine' : 'tractor', t0: q[2][3] } : null; f.noFuel = !!q[3]; f.tank = q[4]; });
    this.remote = {};
    ['blue', 'red'].forEach((sd, i) => { const q = e.sd[i], E = this.side[sd]; [E.parts, E.lostGrain, E.harvested, E.exported] = q; this.remote[sd] = q; });
    e.st.forEach((q, i) => { const st = this.world.settlements[i]; if (st) { st.happy = q[0] / 100; st.fear = q[1] / 100; } });
  }
  // Сводка по стороне для интерфейса и ИИ
  summary(side) {
    const farms = this.farms.filter((f) => f.side === side);
    const els = this.g.objs(side, 'elevator');
    return {
      farms: farms.length,
      fields: farms.reduce((a, f) => a + f.fields.length, 0),
      working: farms.filter((f) => f.work && !f.noFuel).length,
      noFuel: farms.filter((f) => f.noFuel).length,
      farmGrain: farms.reduce((a, f) => a + f.grain, 0),
      elevGrain: els.reduce((a, e) => a + (e.grain || 0), 0),
      elevCap: els.reduce((a, e) => a + (e.build ? 0 : this.elevCap(e)), 0),
      pop: this.settlementsOf(side).reduce((a, s) => a + s.pop, 0),
      happy: (() => { const ss = this.settlementsOf(side); const p = ss.reduce((a, s) => a + s.pop, 0); return ss.reduce((a, s) => a + s.pop * s.happy, 0) / Math.max(1, p); })(),
      mobilized: this.mobilized(side),
      labor: this.labor(side),
      launchCap: this.launchCap(side), launchFree: this.launchFree(side),
      ...this.side[side],
    };
  }
}
export { VEH };
