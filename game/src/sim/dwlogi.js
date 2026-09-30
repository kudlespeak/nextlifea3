// Дорожная логистика «Войны дронов»: грубый дорожный граф (узлы через ~60 м), мосты как узлы,
// которые перекрываются при обрушении пролёта; машины едут по дорогам и видны на карте.
//   • фуры: погранпереход → распределительный центр (товар), обратно порожняком;
//   • развозные грузовики: распредцентр → ТЦ, супермаркеты, сельские магазины;
//   • военные грузовики: арсенал → позиции ПВО (патроны, снаряды, ракеты, перехватчики);
//   • ремонтные бригады: ремонтная база → повреждённый узел → работа → обратно;
//   • пожарные машины: пожарная часть → горящий узел → тушение → обратно;
//   • бензовозы: нефтебаза → АЗС (топливо продаётся на заправках).
// Доход: пошлина за ввоз (фура дошла до распредцентра), экспорт (обратный рейс дошёл до границы),
// продажи в магазинах и на АЗС (нужны товар/топливо и свет).
// Машины — цели: их сжигают разрывы рядом и барражирующие боеприпасы.

import { M } from '../spatial.js';
import { resample } from '../geom.js';

const PACE_V = 1.8; // тот же темп, что у дронов (см. PACE в dronewar.js)

const STEP = 60;
export const VEH = {
  fura: { name: 'Фура', speed: 20, cls: 'civil' },
  van: { name: 'Развозной грузовик', speed: 17, cls: 'civil' },
  supply: { name: 'Грузовик снабжения ПВО', speed: 16, cls: 'mil' },
  crew: { name: 'Ремонтная бригада', speed: 16, cls: 'crew' },
  fire: { name: 'Пожарная машина', speed: 19, cls: 'fire' },
  tanker: { name: 'Бензовоз', speed: 18, cls: 'civil' },
  grain: { name: 'Зерновоз', speed: 17, cls: 'civil' },
  grainx: { name: 'Зерновоз на экспорт', speed: 19, cls: 'civil' },
};
// Доход с фуры: пошлина при ввозе и выручка за экспорт на обратном рейсе
export const TRANSIT = { import: 2, export: 2 };

export class DWRoads {
  constructor(world, bridges) {
    this.x = []; this.y = []; this.adj = []; this.br = []; this.w = [];
    this.cell = 120;
    this.bins = new Map();
    const lines = world.roadList;
    lines.forEach((r) => {
      const pts = resample(r.line, STEP);
      let prev = -1;
      for (const [x, y] of pts) {
        const id = this.x.length;
        this.x.push(x); this.y.push(y); this.adj.push([]); this.br.push(0); this.w.push(r.width || 6);
        this.bin(x, y).push(id);
        if (prev >= 0) this.link(prev, id);
        prev = id;
      }
    });
    // Перекрёстки: узлы разных дорог ближе 45 м; концы дорог — к ближайшему узлу в 90 м (примыкания)
    const roadOf = [];
    let k0 = 0;
    lines.forEach((r, ri) => { const n = resample(r.line, STEP).length; for (let q = 0; q < n; q++) roadOf.push(ri); r._n0 = k0; r._n1 = k0 + n - 1; k0 += n; });
    for (let i = 0; i < this.x.length; i++)
      for (const j of this.near(this.x[i], this.y[i], 45)) if (j > i && roadOf[j] !== roadOf[i] && !this.adj[i].some(([k]) => k === j)) this.link(i, j);
    for (const r of lines)
      for (const e of [r._n0, r._n1]) {
        let best = -1, bd = 90;
        for (const j of this.near(this.x[e], this.y[e], 90)) { if (roadOf[j] === roadOf[e]) continue; const d = Math.hypot(this.x[j] - this.x[e], this.y[j] - this.y[e]); if (d < bd) { bd = d; best = j; } }
        if (best >= 0 && !this.adj[e].some(([k]) => k === best)) this.link(e, best);
      }
    // Острова дорожной сети (улицы, не доведённые до соседней дороги) сшиваем с ближайшим узлом
    // другого острова — но не через воду: реку пересекают только мосты
    const dry = (a, b) => {
      const L = Math.hypot(this.x[b] - this.x[a], this.y[b] - this.y[a]);
      for (let t = 0; t <= L; t += 8) { const k = t / (L || 1); if (world.mask.has(this.x[a] + (this.x[b] - this.x[a]) * k, this.y[a] + (this.y[b] - this.y[a]) * k, M.WATER)) return false; }
      return true;
    };
    for (let pass = 0; pass < 6; pass++) {
      this.components();
      const size = new Map();
      for (const c of this.comp) size.set(c, (size.get(c) || 0) + 1);
      let merged = 0;
      for (const [c] of [...size.entries()].sort((a, b) => a[1] - b[1])) {
        let best = null, bd = 700;
        for (let i = 0; i < this.x.length; i++) {
          if (this.comp[i] !== c) continue;
          for (const j of this.near(this.x[i], this.y[i], bd)) {
            if (this.comp[j] === c) continue;
            const d = Math.hypot(this.x[j] - this.x[i], this.y[j] - this.y[i]);
            if (d < bd && dry(i, j)) { bd = d; best = [i, j]; }
          }
        }
        if (best) { this.link(best[0], best[1]); merged++; }
      }
      if (!merged) break;
    }
    this.components();
    // Мосты: узлы на пролёте принадлежат мосту
    for (const b of bridges) {
      const c = Math.cos(b.angle), s = Math.sin(b.angle);
      for (const id of this.near(b.x, b.y, b.L / 2 + 30)) {
        const dx = this.x[id] - b.x, dy = this.y[id] - b.y;
        if (Math.abs(dx * c + dy * s) < b.L / 2 + 20 && Math.abs(-dx * s + dy * c) < 18) this.br[id] = b.id;
      }
    }
    const n = this.x.length;
    this.g = new Float64Array(n); this.par = new Int32Array(n); this.seen = new Uint32Array(n); this.stamp = 0;
  }
  components() {
    this.comp = new Int32Array(this.x.length).fill(-1);
    let cc = 0;
    for (let i = 0; i < this.x.length; i++) {
      if (this.comp[i] >= 0) continue;
      const st = [i]; this.comp[i] = cc;
      while (st.length) { const u = st.pop(); for (const [v] of this.adj[u]) if (this.comp[v] < 0) { this.comp[v] = cc; st.push(v); } }
      cc++;
    }
  }
  bin(x, y) {
    const k = Math.floor(x / this.cell) * 100003 + Math.floor(y / this.cell);
    let b = this.bins.get(k);
    if (!b) this.bins.set(k, (b = []));
    return b;
  }
  near(x, y, r) {
    const out = [], c = this.cell;
    for (let cx = Math.floor((x - r) / c); cx <= Math.floor((x + r) / c); cx++)
      for (let cy = Math.floor((y - r) / c); cy <= Math.floor((y + r) / c); cy++) {
        const b = this.bins.get(cx * 100003 + cy);
        if (b) for (const id of b) if (Math.hypot(this.x[id] - x, this.y[id] - y) <= r) out.push(id);
      }
    return out;
  }
  nearest(x, y, maxR = 3000) {
    for (let r = 150; r <= maxR; r *= 2) {
      let best = -1, bd = Infinity;
      for (const id of this.near(x, y, r)) { const d = Math.hypot(this.x[id] - x, this.y[id] - y); if (d < bd) { bd = d; best = id; } }
      if (best >= 0) return best;
    }
    return -1;
  }
  link(a, b) {
    const d = Math.hypot(this.x[a] - this.x[b], this.y[a] - this.y[b]);
    this.adj[a].push([b, d]); this.adj[b].push([a, d]);
  }
  // Маршрут A*; bridgeCap(id) → 0 (разрушен), 0.5, 1. Возвращает {path, len} или null
  route(ax, ay, bx, by, bridgeCap) {
    const s = this.nearest(ax, ay), t = this.nearest(bx, by);
    if (s < 0 || t < 0 || this.comp[s] !== this.comp[t]) return null;
    const stamp = ++this.stamp;
    const { g, par, seen } = this;
    const open = new Heap();
    g[s] = 0; par[s] = -1; seen[s] = stamp;
    open.push(s, 0);
    const done = new Set();
    let found = false;
    while (open.size) {
      const [cur] = open.pop();
      if (cur === t) { found = true; break; }
      if (done.has(cur)) continue;
      done.add(cur);
      for (const [nb, L] of this.adj[cur]) {
        let k = 1;
        if (this.br[nb]) { const cap = bridgeCap(this.br[nb]); if (cap <= 0) continue; if (cap < 1) k = 2.5; }
        const ng = g[cur] + L * k;
        if (seen[nb] !== stamp || ng < g[nb]) {
          seen[nb] = stamp; g[nb] = ng; par[nb] = cur;
          open.push(nb, ng + Math.hypot(this.x[nb] - bx, this.y[nb] - by));
        }
      }
    }
    if (!found) return null;
    const ids = [];
    for (let i = t; i !== -1; i = par[i]) ids.push(i);
    ids.reverse();
    // Правая полоса: смещение от оси дороги по ходу движения
    const lane = ids.map((i, k) => {
      const a = ids[Math.max(0, k - 1)], b = ids[Math.min(ids.length - 1, k + 1)];
      let dx = this.x[b] - this.x[a], dy = this.y[b] - this.y[a];
      const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      const off = Math.min(4, this.w[i] / 4);
      return [this.x[i] - dy * off, this.y[i] + dx * off];
    });
    const path = [[ax, ay], ...lane, [bx, by]];
    const ws = [this.w[ids[0]], ...ids.map((i) => this.w[i]), this.w[ids[ids.length - 1]]]; // ширина дороги у точек пути
    let len = 0;
    for (let i = 1; i < path.length; i++) len += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    return { path, len, ws, bridges: [...new Set(ids.map((i) => this.br[i]).filter(Boolean))] };
  }
}

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(v, p) { const a = this.a; a.push([v, p]); let i = a.length - 1; while (i > 0) { const j = (i - 1) >> 1; if (a[j][1] <= a[i][1]) break; [a[i], a[j]] = [a[j], a[i]]; i = j; } }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][1] < a[m][1]) m = l; if (r < a.length && a[r][1] < a[m][1]) m = r; if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m; } }
    return top;
  }
}

// ---------------------------------------------------------------- Логистика стороны
export const SALE = { mall: { value: 5, every: 60, load: 3, cap: 9 }, market: { value: 4, every: 90, load: 3, cap: 7 }, store: { value: 2, every: 180, load: 2, cap: 4 }, fuel: { value: 2.5, every: 60, load: 4, cap: 10 } };
const FLEET = { supply: 10, fire: 3 };
let nextVeh = 1;

export class DWLogistics {
  constructor(game) {
    this.g = game;
    this.sim = game.sim;
    this.roads = new DWRoads(game.world, game.objects.filter((o) => o.kind === 'bridge'));
    this.vehicles = [];
    this.routeCache = new Map();
    this.cacheVer = 0;
    this.side = {};
    for (const side of ['blue', 'red']) {
      const markets = game.objects.filter((o) => o.side === side && ['mall', 'market', 'store'].includes(o.kind));
      const fuels = game.objects.filter((o) => o.side === side && o.kind === 'fuel');
      for (const m of [...markets, ...fuels]) { m.stock = SALE[m.kind].cap; m.saleT = this.sim.rng.float(0, SALE[m.kind].every); m.cut = false; }
      const hub = game.objects.find((o) => o.side === side && o.kind === 'hub');
      hub.stock = 30;
      this.side[side] = {
        hub, border: game.objects.find((o) => o.side === side && o.kind === 'border'),
        arsenal: game.objects.find((o) => o.side === side && o.kind === 'ammo'),
        // пункты боепитания: арсенал и склады при стартовых позициях (запас везут с арсенала)
        depots: game.objects.filter((o) => o.side === side && (o.kind === 'ammo' || o.kind === 'launch')),
        bases: game.objects.filter((o) => o.side === side && o.kind === 'rembase'),
        stations: game.objects.filter((o) => o.side === side && o.kind === 'firest'),
        oilDepot: game.objects.find((o) => o.side === side && o.kind === 'oil'),
        markets, fuels, importT: 5, deliverT: 3, fuelT: 4, stats: { imports: 0, deliveries: 0, sold: 0, lostTrucks: 0, trade: 0, transit: 0, fuel: 0, exports: 0, agro: 0 },
      };
      for (const st of this.side[side].stations) st.engines = FLEET.fire;
      this.side[side].trucksFree = FLEET.supply;
    }
  }
  gate(o) { return o.gate || [o.x, o.y]; }
  // Торговля с учётом уровня объекта (реконструкция: больше выручки и места на складе)
  sale(m) { const S = SALE[m.kind], L = m.level || 1, reg = this.g.infra?.specAt(m.side, m.x, m.y) === 'trade' ? 1.12 : 1; return { value: S.value * (1 + 0.4 * (L - 1)) * reg, cap: Math.round(S.cap * (1 + 0.5 * (L - 1))), load: S.load, every: S.every }; }
  // Конкуренция: соседние магазины того же типа делят покупателей (продажи реже)
  crowd(m) {
    const n0 = this.g.objects.length;
    if (m._crowdN === n0) return m._crowd;
    const R = m.kind === 'fuel' ? 5000 : m.kind === 'store' ? 1500 : 3000;
    const same = m.kind === 'fuel' ? this.side[m.side].fuels : this.side[m.side].markets.filter((q) => (q.kind === 'store') === (m.kind === 'store'));
    const k = same.filter((q) => q !== m && Math.hypot(q.x - m.x, q.y - m.y) < R).length;
    m._crowdN = n0; m._crowd = 1 + 0.3 * k;
    return m._crowd;
  }
  hubCap(h) { return Math.round(45 * (1 + 0.5 * ((h.level || 1) - 1)) * (h === this.side[h.side]?.hub ? 1 : 0.7)); }
  // Ближайшая действующая ремонтная база (РЭС) к точке
  baseNear(side, x, y) {
    let best = null, bd = Infinity;
    for (const b of this.side[side].bases) {
      if (!b.comps.some((c) => c.state !== 'destroyed')) continue;
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }
  bridgeVer() { let v = 0; for (const o of this.g.objects) if (o.kind === 'bridge') v = v * 3 + (this.g.bridgeCap(o) === 0 ? 0 : this.g.bridgeCap(o) < 1 ? 1 : 2), v %= 1e9; return v; }
  // Служебные машины (бригады, пожарные, снабжение ПВО) при слишком длинном объезде едут
  // напрямик по полям (медленнее), но не через реку
  route(a, b, offroad = false) {
    const r = this.roadRoute(a, b);
    if (!offroad) return r;
    if (!r) return this.approach(a, b);
    const D = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (r && r.len < D * 1.8 + 1500) return r;
    const mask = this.g.world.mask;
    for (let t = 120; t <= D - 120; t += 10) if (mask.has(a[0] + ((b[0] - a[0]) * t) / D, a[1] + ((b[1] - a[1]) * t) / D, M.WATER)) return r;
    return { path: [[a[0], a[1]], [b[0], b[1]]], len: D, bridges: [], offroad: true };
  }
  // Цель за водой или у дороги, отрезанной от сети: доезжаем по дорогам до ближайшей доступной
  // точки (до 2,5 км), дальше — напрямую, если по пути нет воды
  approach(a, b) {
    const R = this.roads, s = R.nearest(a[0], a[1]);
    if (s < 0) return null;
    const mask = this.g.world.mask;
    const cands = R.near(b[0], b[1], 2500).filter((id) => R.comp[id] === R.comp[s]).map((id) => [id, Math.hypot(R.x[id] - b[0], R.y[id] - b[1])]).sort((p, q) => p[1] - q[1]);
    for (const [id, d] of cands.slice(0, 6)) {
      let wet = false;
      for (let t = 10; t < d - 10 && !wet; t += 10) wet = mask.has(R.x[id] + ((b[0] - R.x[id]) * t) / d, R.y[id] + ((b[1] - R.y[id]) * t) / d, M.WATER);
      if (wet) continue;
      const r = this.roadRoute(a, [R.x[id], R.y[id]]);
      if (r) return { path: [...r.path, [b[0], b[1]]], len: r.len + d, bridges: r.bridges, offroad: true };
    }
    return null;
  }
  // Ближайший действующий пункт боепитания
  depotNear(side, x, y) {
    let best = null, bd = Infinity;
    for (const o of this.side[side].depots) {
      if (!o.comps.some((c) => c.state !== 'destroyed')) continue;
      const d = Math.hypot(o.x - x, o.y - y);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }
  roadRoute(a, b) {
    const ver = this.bridgeVer();
    if (ver !== this.cacheVer) { this.routeCache.clear(); this.cacheVer = ver; }
    const key = `${Math.round(a[0] / 50)},${Math.round(a[1] / 50)}>${Math.round(b[0] / 50)},${Math.round(b[1] / 50)}`;
    if (this.routeCache.has(key)) return this.routeCache.get(key);
    const r = this.roads.route(a[0], a[1], b[0], b[1], (id) => this.g.bridgeCap(this.g.obj(id)));
    if (this.routeCache.size > 400) this.routeCache.clear();
    this.routeCache.set(key, r);
    return r;
  }
  spawn(side, kind, from, to, task) {
    const r = this.route(from, to, VEH[kind].cls !== 'civil');
    if (!r) return null;
    const v = { id: nextVeh++, side, kind, x: from[0], y: from[1], heading: 0, path: r.path, ws: r.ws, pi: 1, state: 'go', task, hp: 1, dead: false, spotted: {}, t0: this.sim.time, offroad: !!r.offroad };
    this.vehicles.push(v);
    return v;
  }
  send(v, to, state = 'go') {
    const r = this.route([v.x, v.y], to, VEH[v.kind].cls !== 'civil');
    if (!r) return false;
    v.path = r.path; v.ws = r.ws; v.pi = 1; v.state = state; v.offroad = !!r.offroad;
    return true;
  }
  // Сторона: снабжение магазина «отрезано», если к нему нет дороги от распредцентра
  reachable(side, o) { return !!this.route(this.gate(this.side[side].hub), this.gate(o)); }

  update(dt) {
    const g = this.g, sim = this.sim;
    for (const side of ['blue', 'red']) {
      const L = this.side[side];
      const S = g.sides[side];
      const borderOk = L.border.comps.some((c) => c.state !== 'destroyed');
      // Склады: главный распредцентр и построенные логистические хабы (уровень — вместимость)
      const hubs = g.objs(side, 'hub').filter((h) => !(h.build && !h.build.up) && h.comps.filter((c) => c.state === 'ok').length / h.comps.length > 0.2);
      const hubLv = hubs.reduce((a, h) => a + (h.level || 1), 0);
      // Импорт: фура с погранперехода на склад, где товара меньше всего
      L.importT -= dt;
      if (L.importT <= 0) {
        L.importT = (11 + sim.rng.float(0, 6)) / (1 + 0.25 * Math.min(2, Math.max(0, hubLv - 1))); // пропускная способность погранперехода — не больше ×1,5
        const to = hubs.slice().sort((a, b) => a.stock / this.hubCap(a) - b.stock / this.hubCap(b))[0] || L.hub;
        if (borderOk) this.spawn(side, 'fura', this.gate(L.border), this.gate(to), { type: 'import', hub: to.id });
      }
      // Развоз по магазинам: кому нужнее — с ближайшего склада, где есть товар
      L.deliverT -= dt;
      if (L.deliverT <= 0) {
        L.deliverT = (5 + sim.rng.float(0, 4)) / Math.max(1, hubs.length * 0.8);
        const cand = L.markets.filter((m) => !(m.build && !m.build.up) && m.comps.some((c) => c.state !== 'destroyed') && (m.stock + (m.coming || 0)) <= this.sale(m).cap - this.sale(m).load);
        cand.sort((a, b) => (a.stock + (a.coming || 0)) / this.sale(a).value - (b.stock + (b.coming || 0)) / this.sale(b).value);
        for (const m of cand.slice(0, 3)) {
          const from = hubs.filter((h) => h.stock >= 2).sort((a, b) => Math.hypot(a.x - m.x, a.y - m.y) - Math.hypot(b.x - m.x, b.y - m.y))[0];
          if (!from) break;
          const load = Math.min(this.sale(m).load, from.stock);
          const v = this.spawn(side, 'van', this.gate(from), this.gate(m), { type: 'deliver', to: m.id, load, home: from.id });
          if (v) { from.stock -= load; m.coming = (m.coming || 0) + load; m.cut = false; break; }
          m.cut = true;
        }
      }
      // Бензовозы: нефтебаза → АЗС (нужны целые резервуары)
      L.fuelT -= dt;
      if (L.fuelT <= 0) {
        L.fuelT = 6 + sim.rng.float(0, 4);
        let depot = L.oilDepot;
        const tankLeft = (o) => (o ? o.comps.filter((c) => c.k === 'tank' && c.state !== 'destroyed').length / Math.max(1, o.comps.filter((c) => c.k === 'tank').length) : 0);
        // нефтебаза разбита — бензовозы грузятся на своём НПЗ
        if (tankLeft(depot) === 0) { const nf = g.objs(side, 'refinery').find((o) => !(o.build && !o.build.up) && tankLeft(o) > 0); if (nf) depot = nf; }
        const oilLeft = tankLeft(depot);
        const pumpOk = depot?.comps.some((c) => (c.k === 'pump' || c.k === 'rack') && c.state !== 'destroyed');
        if (depot && oilLeft > 0 && pumpOk && sim.rng.chance(0.35 + 0.65 * oilLeft)) {
          const cand = L.fuels.filter((m) => !(m.build && !m.build.up) && m.comps.some((c) => c.state !== 'destroyed') && (m.stock + (m.coming || 0)) <= this.sale(m).cap - SALE.fuel.load);
          cand.sort((a, b) => a.stock + (a.coming || 0) - (b.stock + (b.coming || 0)));
          for (const m of cand.slice(0, 3)) {
            const v = this.spawn(side, 'tanker', this.gate(depot), this.gate(m), { type: 'deliver', to: m.id, load: SALE.fuel.load, home: depot.id });
            if (v) { m.coming = (m.coming || 0) + SALE.fuel.load; m.cut = false; break; }
            m.cut = true;
          }
        }
      }
      // Продажи в магазинах и на АЗС: нужен товар и свет
      for (const m of [...L.markets, ...L.fuels]) {
        if (m.build && !m.build.up) continue;
        const ok = m.comps.some((c) => c.state === 'ok');
        const sup = this.supplyAt(side, m);
        m.saleT -= dt * (0.25 + 0.75 * sup) * (ok ? 1 : 0);
        if (m.saleT <= 0) {
          m.saleT += SALE[m.kind].every * this.crowd(m);
          if (m.stock >= 1) {
            const val = this.sale(m).value * this.g.incomeK(side) * (this.g.state?.k(side, m.kind === 'fuel' ? 'fuel' : 'trade') ?? 1);
            m.stock--; S.points += val; L.stats.sold++;
            if (m.kind === 'fuel') L.stats.fuel += val; else L.stats.trade += val;
          }
        }
      }
      // Снабжение ПВО с арсенала
      const ars = L.arsenal;
      const arsOk = ars && ars.comps.some((c) => c.k === 'bunker' && c.state !== 'destroyed');
      if (arsOk && L.trucksFree > 0) {
        // недоступные (нет подъезда) пропускаем и пробуем снова через минуту, чтобы не держать очередь
        const need = g.ad.filter((a) => a.side === side && !a.dead && a.state === 'ready' && !a.supplyComing && this.needs(a) && !(sim.time - (a.supplyCut ?? -1e9) < 60));
        need.sort((a, b) => this.needs(b) - this.needs(a));
        for (const a of need.slice(0, 3)) {
          const dep = this.depotNear(side, a.x, a.y) || ars;
          const v = this.spawn(side, 'supply', this.gate(dep), [a.x, a.y], { type: 'resupply', ad: a.id, depot: dep.id });
          if (v) { L.trucksFree--; a.supplyComing = v.id; a.supplyCut = null; break; }
          a.supplyCut = sim.time;
        }
      }
      // Пожарные: к горящим узлам без расчёта
      for (const o of g.objects) {
        if (o.side !== side) continue;
        for (const c of o.comps) {
          if (c.fire <= 0 || c.fireEngine) continue;
          const st = L.stations.filter((q) => q.engines > 0 && q.comps.some((k) => k.state !== 'destroyed')).sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y))[0];
          if (!st) continue;
          const v = this.spawn(side, 'fire', this.gate(st), [c.x, c.y], { type: 'fire', comp: c.id, home: st.id });
          if (v) { st.engines--; c.fireEngine = v.id; }
        }
      }
    }
    // Движение
    for (const v of this.vehicles) {
      if (v.dead) continue;
      if (v.state === 'work') { this.work(v, dt); continue; }
      if (v.state === 'idle') continue;
      // по грунтовкам и узким сельским дорогам — медленнее (асфальт дорожников это исправляет)
      const narrow = !v.offroad && v.ws && (v.ws[v.pi] ?? 8) < 7 ? 0.7 : 1;
      let step = VEH[v.kind].speed * PACE_V * (v.offroad ? 0.75 : 1) * narrow * dt;
      while (step > 0 && v.pi < v.path.length) {
        const [tx, ty] = v.path[v.pi];
        const dx = tx - v.x, dy = ty - v.y, d = Math.hypot(dx, dy);
        if (d > 0.01) v.heading = Math.atan2(dy, dx);
        if (d <= step) { v.x = tx; v.y = ty; step -= d; v.pi++; }
        else { v.x += (dx / d) * step; v.y += (dy / d) * step; step = 0; }
      }
      if (v.pi >= v.path.length) this.arrive(v);
    }
    this.vehicles = this.vehicles.filter((v) => !v.dead || sim.time - v.deadAt < 240);
  }
  // Начисление с отметкой «+N» на карте
  earn(side, v, x, y, kind) {
    v *= this.g.state?.k(side, kind) ?? 1; // законы, курс, проекты
    const val = v * this.g.incomeK(side);
    this.g.sides[side].points += val;
    this.side[side].stats[kind] += val;
    this.g.fx.push({ t: 'money', x, y, v: Math.round(val), side, t0: this.sim.time });
  }
  supplyAt(side, o) {
    const ps = this.g.objs(side, 'ps110');
    let best = ps[0], bd = Infinity;
    for (const p of ps) { const d = Math.hypot(p.x - o.x, p.y - o.y); if (d < bd) { bd = d; best = p; } }
    return best?.supply ?? 1;
  }
  needs(a) {
    const T = this.g.adType(a);
    if (a.type === 'mog') return a.ammo < T.ammo * 0.5 ? 1 - a.ammo / T.ammo : 0;
    if (a.type === 'spaag') return a.ammo < T.ammo * 0.5 || (a.mMax && a.missiles < a.mMax / 2) ? 1 : 0;
    if (a.type === 'sam') return a.missiles <= a.mMax - 2 ? 1.5 - a.missiles / a.mMax : 0;
    if (a.type === 'icpt') return a.stock <= 4 ? 1 - a.stock / 8 : 0;
    return 0;
  }
  arrive(v) {
    const g = this.g, sim = this.sim, L = this.side[v.side];
    const T = v.task;
    if (g.econ?.arrive(v)) return;
    if (v.state === 'back') {
      if (v.kind === 'fura' && T.type === 'export' && T.loaded && L.border.comps.some((c) => c.state !== 'destroyed')) { this.earn(v.side, TRANSIT.export, v.x, v.y, 'transit'); L.stats.exports++; }
      this.home(v);
      return;
    }
    if (T.type === 'import') {
      const hub = g.obj(T.hub) || L.hub;
      hub.stock = Math.min(this.hubCap(hub), hub.stock + 4); // излишек уходит транзитом дальше
      g.econ?.onImport(v.side);
      L.stats.imports++;
      this.earn(v.side, TRANSIT.import, v.x, v.y, 'transit');
      // обратно — с экспортным грузом со складов распредцентра (если склад работает)
      const hubOk = L.hub.comps.some((c) => c.k === 'hall' && c.state === 'ok');
      v.task = { type: 'export', loaded: hubOk };
      if (!this.send(v, this.gate(L.border), 'back')) this.home(v);
      return;
    }
    if (T.type === 'deliver') {
      const m = g.obj(T.to);
      if (m) { m.stock += T.load || 1; m.coming = Math.max(0, (m.coming || 0) - (T.load || 1)); }
      L.stats.deliveries++;
      const home = T.home ? g.obj(T.home) : L.hub;
      if (!this.send(v, this.gate(home), 'back')) this.home(v);
      return;
    }
    if (T.type === 'resupply') {
      const a = g.ad.find((q) => q.id === T.ad);
      if (a && !a.dead) {
        // Позиция могла уехать — догоняем (не больше двух раз; не доехать — позиция без подъезда)
        const d = Math.hypot(a.x - v.x, a.y - v.y);
        if (d > 80 && (v.chase = (v.chase || 0) + 1) <= 2 && this.send(v, [a.x, a.y])) return;
        if (d <= 400) { v.state = 'work'; v.workLeft = 25; return; }
        a.supplyComing = null; a.supplyCut = sim.time;
      }
      if (!this.send(v, this.gate(g.obj(T.depot) || L.arsenal), 'back')) this.home(v);
      return;
    }
    if (T.type === 'fire' || T.type === 'repair') { v.state = 'work'; v.workLeft = 0; return; }
    this.home(v);
  }
  work(v, dt) {
    const g = this.g, L = this.side[v.side];
    const T = v.task;
    if (T.type === 'resupply') {
      v.workLeft -= dt;
      if (v.workLeft > 0) return;
      const a = g.ad.find((q) => q.id === T.ad);
      if (a) { g.restockAD(a); a.supplyComing = null; }
      // в кузове три комплекта: по пути развозим соседним позициям, которым нужно
      T.left = (T.left ?? 3) - 1;
      if (T.left > 0) {
        let nb = null, bd = 7000;
        for (const q of g.ad) {
          if (q.side !== v.side || q.dead || q.state !== 'ready' || q.supplyComing || !this.needs(q)) continue;
          const d = Math.hypot(q.x - v.x, q.y - v.y);
          if (d < bd) { bd = d; nb = q; }
        }
        if (nb && this.send(v, [nb.x, nb.y])) { T.ad = nb.id; v.chase = 0; nb.supplyComing = v.id; return; }
      }
      if (!this.send(v, this.gate(g.obj(T.depot) || L.arsenal), 'back')) this.home(v);
      return;
    }
    if (T.type === 'fire') {
      const c = g.comps.get(T.comp);
      if (!c || c.fire <= 0) {
        if (c) c.fireEngine = null;
        const st = g.obj(T.home);
        if (!this.send(v, this.gate(st), 'back')) this.home(v);
        return;
      }
      c.fire = Math.max(0, c.fire - dt * (c.k === 'tank' ? 4 : 10)); // тушение
      if (c.fire <= 0) { c.fire = 0; if (c.state !== 'ok') c.burned = true; }
      return;
    }
    if (T.type === 'repair') g.crewWork(v, dt);
  }
  home(v) {
    const L = this.side[v.side];
    v.dead = true; v.deadAt = -1e9; // вернулся — убираем с карты
    if (v.kind === 'supply') L.trucksFree++;
    if (v.kind === 'fire') { const st = this.g.obj(v.task.home); if (st) st.engines++; }
    if (v.kind === 'crew') this.g.crewHome(v);
  }
  // Машина уничтожена (разрыв рядом, барражирующий боеприпас)
  destroy(v, why) {
    if (v.dead) return;
    v.dead = true; v.deadAt = this.sim.time; v.wreck = true;
    const L = this.side[v.side];
    L.stats.lostTrucks++;
    if (v.kind === 'supply') { L.trucksFree++; const a = this.g.ad.find((q) => q.id === v.task.ad); if (a) a.supplyComing = null; }
    if (v.kind === 'fire') { const st = this.g.obj(v.task.home); if (st) st.engines++; const c = this.g.comps.get(v.task.comp); if (c) c.fireEngine = null; }
    if ((v.kind === 'van' || v.kind === 'tanker') && v.task.type === 'deliver') { const m = this.g.obj(v.task.to); if (m) m.coming = Math.max(0, (m.coming || 0) - (v.task.load || 1)); }
    if (v.kind === 'crew') this.g.crewLost(v);
    this.g.econ?.onLost(v);
    this.sim.msg(`Потеря на дороге: ${VEH[v.kind].name.toLowerCase()} (${why})`, v.side);
  }
}
