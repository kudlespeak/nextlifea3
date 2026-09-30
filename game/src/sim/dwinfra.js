// Инфраструктура и ресурсы «Войны дронов» (вторая очередь развития страны):
// сезоны (отопление зимой, солнце летом), водоснабжение городов (насосам нужен свет),
// области с губернаторами и специализацией, стройматериалы (цементный завод) и уголь (шахта),
// нефтепереработка, экспорт зерна поездами и баржами, асфальт на сельских дорогах,
// строительство новых ЛЭП 110 кВ и эвакуация завода БПЛА вглубь тыла.

import { CYCLE } from './dwecon.js';
import { portalOf, terminatePylons } from '../mapgen.js';

export const SEASONS = [
  { id: 'spring', name: 'весна', to: 0.2, eff: { demand: 1.03, solar: 1 } },
  { id: 'summer', name: 'лето', to: 0.6, eff: { demand: 0.97, solar: 1.2 } },
  { id: 'autumn', name: 'осень', to: 0.86, eff: { demand: 1.05, solar: 0.8 } },
  { id: 'winter', name: 'зима', to: 1, eff: { demand: 1.15, solar: 0.5 } },
];
export const REGION_SPEC = {
  none: { name: 'без специализации', desc: '' },
  agro: { name: 'аграрная', desc: 'урожайность полей области +15%' },
  industry: { name: 'промышленная', desc: 'промышленность стороны +8%' },
  trade: { name: 'торговая', desc: 'выручка магазинов и АЗС области +12%' },
  energy: { name: 'энергетическая', desc: 'ремонт энергообъектов в области на 20% быстрее' },
};
const TRAIN = { lot: 15000, speed: 22, bonus: 1.1 }; // т, м/с; поездом дешевле — выручка +10%
const BARGE = { lot: 20000, speed: 14, bonus: 1.15 };
const PAVE = { perKm: 60, time: 180 };
const LINE = { perKm: 25, time: 300, maxKm: 25 };
const EVAC = { cost: 300, time: 600, minFront: 14000 };
const MAT_USE = 0.2; // доля цены, которую покрывают стройматериалы (скидка 20%)

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export class DWInfra {
  constructor(g) {
    this.g = g;
    this.sim = g.sim;
    this.world = g.world;
    this.ships = [];
    this.paving = [];
    this.newLines = [];
    this.nextShip = 1;
    this.side = {};
    for (const side of ['blue', 'red']) this.side[side] = { mat: 20, spec: {}, specT: {}, noWater: 0 };
    this.tickT = 0;
    // области: поселение → ближайший город своей стороны
    for (const s of this.world.settlements) {
      let best = -1, bd = Infinity;
      this.cities(s.side).forEach((c, i) => { const d = Math.hypot(c.x - s.x, c.y - s.y); if (d < bd) { bd = d; best = i; } });
      s.region = best;
      s.water = true;
    }
    this.railPaths = new Map();
  }
  cities(side) { return this.world.settlements.filter((q) => q.side === side && q.type === 'city'); }
  ready(o) { return !(o.build && !o.build.up) && o.comps.some((c) => c.state !== 'destroyed'); }
  has(side, kind) { return this.g.objs(side, kind).some((o) => this.ready(o)); }
  regionOf(side, x, y) { let best = -1, bd = Infinity; this.cities(side).forEach((c, i) => { const d = Math.hypot(c.x - x, c.y - y); if (d < bd) { bd = d; best = i; } }); return best; }
  specAt(side, x, y) { return this.side[side].spec[this.regionOf(side, x, y)] || 'none'; }

  // ---------------------------------------------------------------- Сезоны
  seasonAt(t) { const ph = ((t % CYCLE) + CYCLE) % CYCLE / CYCLE; return SEASONS.find((q) => ph < q.to) || SEASONS[3]; }
  season() { return this.seasonAt(this.sim.time); }
  // множители для государства (k) — сезон и ресурсы
  k(side, key) {
    let k = this.season().eff[key] ?? 1;
    if (key === 'fuel' && this.has(side, 'refinery')) k *= 1.15;
    if (key === 'industry') k *= 1 + 0.08 * Object.values(this.side[side].spec).filter((v) => v === 'industry').length;
    return k;
  }
  // уголь своей шахты: ТЭС +10% и работает даже без угольного склада
  coalBonus(side) { return this.has(side, 'coalmine'); }

  // ---------------------------------------------------------------- Вода
  water() {
    for (const side of ['blue', 'red']) {
      let dry = 0, pop = 0;
      const towers = this.g.objs(side, 'watertower').filter((o) => this.ready(o));
      for (const s of this.world.settlements) {
        if (s.side !== side) continue;
        pop += s.pop;
        if (s.type !== 'city') { s.water = true; continue; } // в сёлах — колодцы и скважины
        const ps = s._ps;
        const power = ps ? ps.supply ?? 1 : 1;
        s.water = power >= 0.5 || towers.some((o) => Math.hypot(o.x - s.x, o.y - s.y) < 4000);
        if (!s.water) dry += s.pop;
      }
      const E = this.side[side];
      if (dry > 0 && !E.noWater) this.sim.msg('Водоснабжение: насосы без света — в городе нет воды (водонапорная станция с генератором решает проблему)', side);
      E.noWater = dry / Math.max(1, pop);
    }
  }

  // ---------------------------------------------------------------- Стройматериалы
  // скидка на стройку и ремонт, пока есть запас; возвращает итоговую цену и списывает материалы
  matPrice(side, cost, apply = false) {
    const E = this.side[side];
    const use = cost * MAT_USE;
    if (E.mat < use || use < 1) return cost;
    if (apply) E.mat -= use;
    return Math.round(cost - use);
  }
  onImport(side) { this.side[side].mat = Math.min(300, this.side[side].mat + 0.5); }
  produce(stepMin) {
    for (const o of this.g.objects) {
      if (o.kind !== 'cement' || !this.ready(o)) continue;
      const ps = this.g.econ.nearestPS(o.side, o.x, o.y);
      if ((ps?.supply ?? 1) < 0.5) { o.idle = 'нет света'; continue; }
      o.idle = null;
      this.side[o.side].mat = Math.min(300, this.side[o.side].mat + 3 * (o.level || 1) * stepMin);
    }
  }

  // ---------------------------------------------------------------- Области
  setRegion(side, i, spec) {
    const E = this.side[side], c = this.cities(side)[i];
    if (!c || !REGION_SPEC[spec]) return 'Нет такой области';
    if (this.sim.time < (E.specT[i] || 0)) return `Губернатора меняют не чаще раза в 10 минут (ещё ${Math.ceil((E.specT[i] - this.sim.time) / 60)} мин)`;
    const S = this.g.sides[side];
    if (S.points < 80) return 'Не хватает очков: нужно 80';
    S.points -= 80; S.stats.spent += 80;
    E.spec[i] = spec; E.specT[i] = this.sim.time + 600;
    this.g.state.cache = {};
    this.sim.msg(`Область «${c.name}»: ${REGION_SPEC[spec].name} специализация`, side);
    return null;
  }

  // ---------------------------------------------------------------- Экспорт поездами и баржами
  // путь по железной дороге от терминала к тыловому краю карты (через узел, если терминал на ветке)
  railPath(o) {
    if (this.railPaths.has(o.id)) return this.railPaths.get(o.id);
    const W = this.world, lines = W.rails.items.filter((r) => !r.siding);
    const nearestOn = (line, p) => { let bi = 0, bd = Infinity; line.forEach((q, i) => { const d = dist(q, p); if (d < bd) { bd = d; bi = i; } }); return [bi, bd]; };
    const edge = (q) => q[0] < 300 || q[0] > W.W - 300;
    let best = null, bd = Infinity;
    for (const r of lines) { const [i, d] = nearestOn(r.line, [o.x, o.y]); if (d < bd) { bd = d; best = { r, i }; } }
    if (!best || bd > 900) { this.railPaths.set(o.id, null); return null; }
    const L = best.r.line;
    let path;
    if (edge(L[0]) || edge(L[L.length - 1])) path = edge(L[0]) ? L.slice(0, best.i + 1).reverse() : L.slice(best.i);
    else {
      // ветка: до конца, ближнего к магистрали, дальше по магистрали к краю
      const end0 = L[0], end1 = L[L.length - 1];
      const main = lines.find((r) => r !== best.r && (edge(r.line[0]) || edge(r.line[r.line.length - 1])) && Math.min(nearestOn(r.line, end0)[1], nearestOn(r.line, end1)[1]) < 1500);
      if (!main) { this.railPaths.set(o.id, null); return null; }
      const [j0, d0] = nearestOn(main.line, end0), [j1, d1] = nearestOn(main.line, end1);
      const useStart = d0 <= d1;
      const part = useStart ? L.slice(0, best.i + 1).reverse() : L.slice(best.i);
      const j = useStart ? j0 : j1, M = main.line;
      path = [...part, ...(edge(M[0]) ? M.slice(0, j + 1).reverse() : M.slice(j))];
    }
    this.railPaths.set(o.id, path);
    return path;
  }
  riverPath(o) {
    const rv = this.world.water.items.filter((r) => r.kind === 'river');
    let best = null, bi = 0, bd = Infinity;
    for (const r of rv) r.line.forEach((q, i) => { const d = dist(q, [o.x, o.y]); if (d < bd) { bd = d; best = r; bi = i; } });
    if (!best || bd > 900) return null;
    const L = best.line;
    return L[0][1] > L[L.length - 1][1] ? L.slice(0, bi + 1).reverse() : L.slice(bi); // вниз по течению — на юг
  }
  // мосты на пути: ж/д мосты для поезда, любые обрушенные пролёты над рекой для баржи
  bridgesOn(side, path, rail) {
    const out = [];
    for (const b of this.g.objs(side, 'bridge')) {
      if (rail ? b.btype !== 'rail' : false) continue;
      for (let i = 0; i < path.length; i += 3) if (Math.hypot(path[i][0] - b.x, path[i][1] - b.y) < (rail ? 60 : 90)) { out.push({ b, i }); break; }
    }
    return out;
  }
  dispatch(side) {
    const E = this.g.econ;
    for (const kind of ['railterm', 'port']) {
      const P = kind === 'railterm' ? TRAIN : BARGE;
      for (const t of this.g.objs(side, kind)) {
        if (!this.ready(t) || this.ships.some((q) => q.from === t.id)) continue;
        const R = kind === 'railterm' ? 5000 : 6000;
        const el = E.elevators(side).filter((e) => Math.hypot(e.x - t.x, e.y - t.y) < R && (e.grain || 0) >= P.lot * 0.6).sort((a, b) => (b.grain || 0) - (a.grain || 0))[0];
        if (!el) continue;
        const path = kind === 'railterm' ? this.railPath(t) : this.riverPath(t);
        if (!path || path.length < 2) { t.idle = kind === 'railterm' ? 'нет выхода на магистраль' : 'нет фарватера'; continue; }
        t.idle = null;
        const load = Math.min(P.lot * (t.level ? 1 + 0.3 * (t.level - 1) : 1), el.grain);
        el.grain -= load;
        const cum = [0]; for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + dist(path[i], path[i - 1]));
        this.ships.push({ id: this.nextShip++, side, kind: kind === 'railterm' ? 'train' : 'barge', from: t.id, path, cum, s: 0, load, speed: P.speed, bonus: P.bonus, wait: null, bridges: this.bridgesOn(side, path, kind === 'railterm') });
        this.sim.msg(`${kind === 'railterm' ? 'Поезд' : 'Баржа'} с зерном (${Math.round(load / 1000)} тыс. т) отправлен${kind === 'railterm' ? '' : 'а'} на экспорт — ${t.name}`, side);
      }
    }
  }
  posOf(sh, s = sh.s) {
    const { path, cum } = sh;
    let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
    const a = path[i - 1], b = path[i], L = cum[i] - cum[i - 1] || 1, k = Math.max(0, Math.min(1, (s - cum[i - 1]) / L));
    return { x: a[0] + (b[0] - a[0]) * k, y: a[1] + (b[1] - a[1]) * k, h: Math.atan2(b[1] - a[1], b[0] - a[0]), i };
  }
  moveShips(dt) {
    const g = this.g;
    for (const sh of this.ships) {
      if (sh.dead) continue;
      const p = this.posOf(sh);
      // обрушенный мост впереди — стоим
      const block = sh.bridges.find(({ b, i }) => i >= p.i && i <= p.i + 4 && g.bridgeCap(b) === 0 && b.comps.some((c) => c.k === 'span' && c.state === 'destroyed'));
      if (block) { if (!sh.wait) { sh.wait = block.b.id; this.sim.msg(`${sh.kind === 'train' ? 'Поезд' : 'Баржа'} с зерном стоит: ${sh.kind === 'train' ? 'разрушен ж/д мост' : 'обрушенный пролёт перекрыл фарватер'} («${block.b.name}»)`, sh.side); } continue; }
      sh.wait = null;
      sh.s += sh.speed * dt;
      if (sh.s >= sh.cum[sh.cum.length - 1]) {
        sh.dead = true;
        const price = g.state?.grainPrice ?? 1;
        g.logi.earn(sh.side, sh.load * 0.02 * price * sh.bonus, p.x, p.y, 'agro');
        g.econ.side[sh.side].exported += sh.load;
        this.sim.msg(`${sh.kind === 'train' ? 'Поезд' : 'Баржа'} с зерном дошёл до границы: продано ${Math.round(sh.load / 1000)} тыс. т`, sh.side);
      }
    }
    this.ships = this.ships.filter((q) => !q.dead);
  }
  onImpact(x, y, wh) {
    for (const sh of this.ships) {
      const p = this.posOf(sh);
      if (Math.hypot(p.x - x, p.y - y) < 20 + wh * 0.3) {
        sh.dead = true;
        this.g.econ.side[sh.side].lostGrain += sh.load;
        this.sim.msg(`${sh.kind === 'train' ? 'Поезд' : 'Баржа'} с зерном уничтожен${sh.kind === 'train' ? '' : 'а'} ударом дрона — потеряно ${Math.round(sh.load / 1000)} тыс. т`, sh.side);
      }
    }
  }

  // ---------------------------------------------------------------- Асфальт на дорогах
  roadAt(side, x, y) {
    let best = null, bd = 80, bi = -1;
    this.world.roadList.forEach((r, i) => {
      if (r.type !== 'dirt' && r.type !== 'village') return;
      for (let k = 0; k < r.line.length; k += 2) { const d = Math.hypot(r.line[k][0] - x, r.line[k][1] - y); if (d < bd) { bd = d; best = r; bi = i; } }
    });
    if (!best) return { err: 'Кликните по грунтовке или сельской дороге' };
    const mid = best.line[Math.floor(best.line.length / 2)];
    if (!this.g.econ.territoryOk(side, mid[0])) return { err: 'Только на своей территории' };
    if (this.paving.some((q) => q.i === bi)) return { err: 'Здесь уже идут работы' };
    let L = 0; for (let k = 1; k < best.line.length; k++) L += dist(best.line[k], best.line[k - 1]);
    return { r: best, i: bi, len: L, cost: Math.max(20, Math.round((L / 1000) * PAVE.perKm * (this.g.state?.k(side, 'build') ?? 1))) };
  }
  pave(side, x, y) {
    const q = this.roadAt(side, x, y);
    if (q.err) return q.err;
    const S = this.g.sides[side];
    const cost = this.matPrice(side, q.cost);
    if (S.points < cost) return `Не хватает очков: нужно ${cost}`;
    this.matPrice(side, q.cost, true);
    S.points -= cost; S.stats.spent += cost;
    this.paving.push({ side, i: q.i, until: this.sim.time + PAVE.time, total: PAVE.time, x, y });
    this.sim.msg(`Дорожники асфальтируют ${(q.len / 1000).toFixed(1)} км дороги (−${cost} оч., ${Math.round(PAVE.time / 60)} мин)`, side);
    return null;
  }
  finishPaving() {
    const t = this.sim.time;
    for (const p of this.paving) {
      if (t < p.until) continue;
      p.done = true;
      const r = this.world.roadList[p.i];
      if (!r) continue;
      r.type = 'local'; r.width = 8;
      const R = this.g.logi.roads;
      for (let k = r._n0; k <= r._n1 && k < R.w.length; k++) R.w[k] = 8;
      this.g.logi.routeCache.clear();
      this.sim.events.push({ type: 'net', ev: { k: 'pave', i: p.i } });
      this.sim.events.push({ type: 'forts', bbox: { ...r.bbox } });
      this.sim.msg('Дорога заасфальтирована: машины идут по ней быстрее', p.side);
    }
    this.paving = this.paving.filter((p) => !p.done);
  }

  // ---------------------------------------------------------------- Новые ЛЭП 110 кВ
  lineEnds(side) { return this.g.objs(side).filter((o) => ['ps330', 'ps110', 'tpp', 'hpp', 'chp', 'wpp', 'spp', 'solar'].includes(o.kind) && !(o.build && !o.build.up)); }
  lineCheck(side, aId, bId) {
    const a = this.g.obj(aId), b = this.g.obj(bId);
    if (!a || !b || a === b || a.side !== side || b.side !== side) return { err: 'Выберите две свои подстанции или станции' };
    const L = Math.hypot(a.x - b.x, a.y - b.y);
    if (L > LINE.maxKm * 1000) return { err: `Слишком далеко: до ${LINE.maxKm} км` };
    if (this.g.lines.some((l) => l.kv === 110 && ((l.a === a.id && l.b === b.id) || (l.a === b.id && l.b === a.id)))) return { err: 'Эти объекты уже соединены ЛЭП 110 кВ' };
    return { a, b, L, cost: Math.round((L / 1000) * LINE.perKm * (this.g.state?.k(side, 'build') ?? 1)) };
  }
  buildLine(side, aId, bId) {
    const q = this.lineCheck(side, aId, bId);
    if (q.err) return q.err;
    const S = this.g.sides[side];
    const cost = this.matPrice(side, q.cost);
    if (S.points < cost) return `Не хватает очков: нужно ${cost}`;
    this.matPrice(side, q.cost, true);
    S.points -= cost; S.stats.spent += cost;
    // от портала ОРУ одного объекта к порталу другого, провода заходят на шины
    const pa = portalOf(q.a, 110, [q.b.x, q.b.y]), pb = portalOf(q.b, 110, [q.a.x, q.a.y]);
    const A = pa.pt, B = pb.pt, n = Math.max(2, Math.ceil(Math.hypot(B[0] - A[0], B[1] - A[1]) / 250));
    let pylons = [];
    for (let i = 0; i <= n; i++) pylons.push({ x: A[0] + ((B[0] - A[0]) * i) / n, y: A[1] + ((B[1] - A[1]) * i) / n });
    // концевые опоры напротив порталов — провода заходят на ОРУ вдоль ряда, а не через площадку
    pylons = terminatePylons(terminatePylons(pylons, q.a, pa, false, this.world.mask), q.b, pb, true, this.world.mask);
    pylons[0].portal = true; pylons[pylons.length - 1].portal = true;
    if (pa.h) pylons[0].ph = pa.h;
    if (pb.h) pylons[pylons.length - 1].ph = pb.h;
    this.newLines.push({ side, a: q.a.id, b: q.b.id, kv: 110, pylons, until: this.sim.time + LINE.time, total: LINE.time, name: `${q.a.name} — ${q.b.name}` });
    this.sim.msg(`Стройка ЛЭП 110 кВ «${q.a.name} — ${q.b.name}» (${(q.L / 1000).toFixed(1)} км, −${cost} оч., ${Math.round(LINE.time / 60)} мин)`, side);
    return null;
  }
  addLine(d) {
    const id = 1000 + this.g.lines.length;
    const ln = { id, kv: d.kv, a: d.a, b: d.b, side: d.side, pylons: d.pylons };
    this.world.power.lines.push(ln);
    this.g.lines.push({ ...ln, cut: null, repair: null, hp: 1, id: `L${id}` });
    this.world.power.version++;
    this.g.flowTimer = 0;
    return ln;
  }
  finishLines() {
    const t = this.sim.time;
    for (const d of this.newLines) {
      if (t < d.until) continue;
      d.done = true;
      const ln = this.addLine(d);
      this.sim.events.push({ type: 'net', ev: { k: 'line', ln } });
      const xs = d.pylons.map((p) => p.x), ys = d.pylons.map((p) => p.y);
      this.sim.events.push({ type: 'forts', bbox: { x0: Math.min(...xs) - 60, y0: Math.min(...ys) - 60, x1: Math.max(...xs) + 60, y1: Math.max(...ys) + 60 } });
      this.sim.msg(`ЛЭП 110 кВ «${d.name}» под напряжением`, d.side);
    }
    this.newLines = this.newLines.filter((d) => !d.done);
  }

  // ---------------------------------------------------------------- Эвакуация завода БПЛА
  evacCheck(side, id, x, y) {
    const o = this.g.obj(id);
    if (!o || o.side !== side || o.kind !== 'factory') return { err: 'Эвакуировать можно только свой завод БПЛА' };
    if (Math.abs(x - this.g.frontX) < EVAC.minFront) return { err: `Вглубь тыла: не ближе ${EVAC.minFront / 1000} км к фронту` };
    if (Math.abs(x - this.g.frontX) <= Math.abs(o.x - this.g.frontX)) return { err: 'Новое место должно быть дальше от фронта' };
    const site = this.g.econ.siteFor(side, 'factory', x, y);
    if (site.err) return { err: site.err };
    return { o, site };
  }
  evacuate(side, id, x, y) {
    const q = this.evacCheck(side, id, x, y);
    if (q.err) return q.err;
    const S = this.g.sides[side];
    const cost = Math.round(EVAC.cost * (this.g.state?.k(side, 'build') ?? 1));
    if (S.points < cost) return `Не хватает очков: нужно ${cost}`;
    S.points -= cost; S.stats.spent += cost;
    const E = this.g.econ, st = q.site;
    E.addObject({ id: E.nextBuilt++, side, kind: 'factory', name: `${q.o.name.replace(/ \(.*\)$/, '')} (эвакуирован)`, x: st.x, y: st.y, angle: st.angle, w: st.lay.w, h: st.lay.h, gate: st.gate, gateQ: st.gateQ, drive: st.drive, level: 1, build: { until: this.sim.time + EVAC.time, total: EVAC.time }, built: true });
    q.o.kind = 'oldfactory';
    q.o.name = `${q.o.name} (оборудование вывезено)`;
    this.sim.msg(`Эвакуация завода: оборудование вывозят вглубь тыла, производство возобновится через ${Math.round(EVAC.time / 60)} мин (−${cost} оч.)`, side);
    return null;
  }

  // ---------------------------------------------------------------- Цикл
  update(dt) {
    this.moveShips(dt);
    this.tickT -= dt;
    if (this.tickT > 0) return;
    const step = 5 - this.tickT; this.tickT = 5;
    this.finishPaving();
    this.finishLines();
    this.produce(step / 60);
    this.waterT = (this.waterT ?? 0) - step;
    if (this.waterT <= 0) { this.waterT = 30; this.water(); }
    for (const side of ['blue', 'red']) this.dispatch(side);
    const s = this.season();
    if (s !== this.lastSeason) { if (this.lastSeason) this.sim.msg(`Наступила ${s.name}${s.id === 'winter' ? ': отопление — потребление электроэнергии растёт, солнечные станции дают меньше' : s.id === 'summer' ? ': солнечные станции на пике' : ''}`); this.lastSeason = s; this.g.state.cache = {}; }
  }
  // ---------------------------------------------------------------- Сеть
  snap() {
    const R = (v) => Math.round(v);
    return {
      sh: this.ships.map((q) => [q.id, q.side, q.kind, q.from, R(q.s), q.wait ? 1 : 0, R(q.load)]),
      sp: this.ships.map((q) => q.id),
      pv: this.paving.map((q) => [q.side, q.i, R(q.until), q.total, R(q.x), R(q.y)]),
      nl: this.newLines.map((q) => [q.side, q.a, q.b, R(q.until), q.total, q.name]),
      sd: ['blue', 'red'].map((sd) => { const E = this.side[sd]; return [R(E.mat), E.spec, E.specT, Math.round(E.noWater * 100) / 100]; }),
      wt: this.world.settlements.map((q) => (q.water ? 1 : 0)).join(''),
    };
  }
  applySnap(q) {
    const old = new Map(this.ships.map((s) => [s.id, s]));
    this.ships = q.sh.map(([id, side, kind, from, s, wait, load]) => {
      let sh = old.get(id);
      if (!sh) {
        const t = this.g.obj(from);
        const path = t ? (kind === 'train' ? this.railPath(t) : this.riverPath(t)) : null;
        if (!path) return null;
        const cum = [0]; for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + dist(path[i], path[i - 1]));
        sh = { id, side, kind, from, path, cum, bridges: [] };
      }
      Object.assign(sh, { s, wait: wait ? 1 : null, load });
      return sh;
    }).filter(Boolean);
    this.paving = q.pv.map(([side, i, until, total, x, y]) => ({ side, i, until, total, x, y }));
    this.newLines = q.nl.map(([side, a, b, until, total, name]) => ({ side, a, b, until, total, name }));
    ['blue', 'red'].forEach((sd, i) => { const E = this.side[sd]; [E.mat, E.spec, E.specT, E.noWater] = q.sd[i]; });
    this.world.settlements.forEach((s, i) => { s.water = q.wt[i] === '1'; });
  }
}
