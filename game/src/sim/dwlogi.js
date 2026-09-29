// Дорожная логистика «Войны дронов»: грубый дорожный граф (узлы через ~60 м), мосты как узлы,
// которые перекрываются при обрушении пролёта; машины едут по дорогам и видны на карте.
//   • фуры: погранпереход → распределительный центр (товар), обратно порожняком;
//   • развозные грузовики: распредцентр → ТЦ, супермаркеты, сельские магазины;
//   • военные грузовики: арсенал → позиции ПВО (патроны, снаряды, ракеты, перехватчики);
//   • ремонтные бригады: ремонтная база → повреждённый узел → работа → обратно;
//   • пожарные машины: пожарная часть → горящий узел → тушение → обратно.
// Машины — цели: их сжигают разрывы рядом и барражирующие боеприпасы.

import { M } from '../spatial.js';
import { resample } from '../geom.js';

const STEP = 60;
export const VEH = {
  fura: { name: 'Фура', speed: 20, cls: 'civil' },
  van: { name: 'Развозной грузовик', speed: 17, cls: 'civil' },
  supply: { name: 'Грузовик снабжения ПВО', speed: 16, cls: 'mil' },
  crew: { name: 'Ремонтная бригада', speed: 16, cls: 'crew' },
  fire: { name: 'Пожарная машина', speed: 19, cls: 'fire' },
};

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
    let len = 0;
    for (let i = 1; i < path.length; i++) len += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    return { path, len, bridges: [...new Set(ids.map((i) => this.br[i]).filter(Boolean))] };
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
const SALE = { mall: { value: 5, every: 60, load: 3, cap: 9 }, market: { value: 4, every: 90, load: 3, cap: 7 }, store: { value: 2, every: 180, load: 2, cap: 4 } };
const FLEET = { supply: 4, fire: 2 };
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
      for (const m of markets) { m.stock = m.kind === 'store' ? 2 : 4; m.saleT = this.sim.rng.float(0, SALE[m.kind].every); m.cut = false; }
      const hub = game.objects.find((o) => o.side === side && o.kind === 'hub');
      hub.stock = 18;
      this.side[side] = {
        hub, border: game.objects.find((o) => o.side === side && o.kind === 'border'),
        arsenal: game.objects.find((o) => o.side === side && o.kind === 'ammo'),
        base: game.objects.find((o) => o.side === side && o.kind === 'rembase'),
        stations: game.objects.filter((o) => o.side === side && o.kind === 'firest'),
        markets, importT: 5, deliverT: 3, stats: { imports: 0, deliveries: 0, sold: 0, lostTrucks: 0, trade: 0 },
      };
      for (const st of this.side[side].stations) st.engines = FLEET.fire;
      this.side[side].trucksFree = FLEET.supply;
    }
  }
  gate(o) { return o.gate || [o.x, o.y]; }
  bridgeVer() { let v = 0; for (const o of this.g.objects) if (o.kind === 'bridge') v = v * 3 + (this.g.bridgeCap(o) === 0 ? 0 : this.g.bridgeCap(o) < 1 ? 1 : 2), v %= 1e9; return v; }
  route(a, b) {
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
    const r = this.route(from, to);
    if (!r) return null;
    const v = { id: nextVeh++, side, kind, x: from[0], y: from[1], heading: 0, path: r.path, pi: 1, state: 'go', task, hp: 1, dead: false, spotted: {}, t0: this.sim.time };
    this.vehicles.push(v);
    return v;
  }
  send(v, to, state = 'go') {
    const r = this.route([v.x, v.y], to);
    if (!r) return false;
    v.path = r.path; v.pi = 1; v.state = state;
    return true;
  }
  // Сторона: снабжение магазина «отрезано», если к нему нет дороги от распредцентра
  reachable(side, o) { return !!this.route(this.gate(this.side[side].hub), this.gate(o)); }

  update(dt) {
    const g = this.g, sim = this.sim;
    for (const side of ['blue', 'red']) {
      const L = this.side[side];
      const S = g.sides[side];
      const hubOk = L.hub.comps.filter((c) => c.state === 'ok').length / L.hub.comps.length;
      const borderOk = L.border.comps.some((c) => c.state !== 'destroyed');
      // Импорт: фура с погранперехода в распредцентр
      L.importT -= dt;
      if (L.importT <= 0) {
        L.importT = 18 + sim.rng.float(0, 10);
        const inRoad = this.vehicles.filter((v) => !v.dead && v.side === side && v.kind === 'fura' && v.state === 'go').length;
        if (borderOk && L.hub.stock + inRoad * 3 < 45 && !g.prep) this.spawn(side, 'fura', this.gate(L.border), this.gate(L.hub), { type: 'import' });
      }
      // Развоз по магазинам: кому нужнее (и до кого есть дорога)
      L.deliverT -= dt;
      if (L.deliverT <= 0) {
        L.deliverT = 7 + sim.rng.float(0, 5);
        if (L.hub.stock >= 2 && hubOk > 0.2) {
          const cand = L.markets.filter((m) => m.comps.some((c) => c.state !== 'destroyed') && (m.stock + (m.coming || 0)) <= SALE[m.kind].cap - SALE[m.kind].load);
          cand.sort((a, b) => (a.stock + (a.coming || 0)) / SALE[a.kind].value - (b.stock + (b.coming || 0)) / SALE[b.kind].value);
          for (const m of cand.slice(0, 3)) {
            const load = Math.min(SALE[m.kind].load, L.hub.stock);
            const v = this.spawn(side, 'van', this.gate(L.hub), this.gate(m), { type: 'deliver', to: m.id, load });
            if (v) { L.hub.stock -= load; m.coming = (m.coming || 0) + load; m.cut = false; break; }
            m.cut = true;
          }
        }
      }
      // Продажи в магазинах: нужен товар и свет
      for (const m of L.markets) {
        const ok = m.comps.some((c) => c.state === 'ok');
        const sup = this.supplyAt(side, m);
        m.saleT -= dt * (0.25 + 0.75 * sup) * (ok ? 1 : 0);
        if (m.saleT <= 0) {
          m.saleT += SALE[m.kind].every;
          if (m.stock >= 1) { m.stock--; S.points += SALE[m.kind].value; L.stats.sold++; L.stats.trade += SALE[m.kind].value; }
        }
      }
      // Снабжение ПВО с арсенала
      const ars = L.arsenal;
      const arsOk = ars && ars.comps.some((c) => c.k === 'bunker' && c.state !== 'destroyed');
      if (arsOk && L.trucksFree > 0) {
        const need = g.ad.filter((a) => a.side === side && !a.dead && a.state === 'ready' && !a.supplyComing && this.needs(a));
        need.sort((a, b) => this.needs(b) - this.needs(a));
        const a = need[0];
        if (a) {
          const v = this.spawn(side, 'supply', this.gate(ars), [a.x, a.y], { type: 'resupply', ad: a.id });
          if (v) { L.trucksFree--; a.supplyComing = v.id; }
          else a.supplyCut = sim.time;
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
      let step = (VEH[v.kind].speed * dt);
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
    if (v.state === 'back') { this.home(v); return; }
    if (T.type === 'import') { L.hub.stock += 3; L.stats.imports++; v.state = 'back'; if (!this.send(v, this.gate(L.border), 'back')) this.home(v); return; }
    if (T.type === 'deliver') {
      const m = g.obj(T.to);
      if (m) { m.stock += T.load || 1; m.coming = Math.max(0, (m.coming || 0) - (T.load || 1)); }
      L.stats.deliveries++;
      if (!this.send(v, this.gate(L.hub), 'back')) this.home(v);
      return;
    }
    if (T.type === 'resupply') {
      const a = g.ad.find((q) => q.id === T.ad);
      if (a && !a.dead) {
        // Позиция могла уехать — догоняем
        if (Math.hypot(a.x - v.x, a.y - v.y) > 80) { if (this.send(v, [a.x, a.y])) return; }
        v.state = 'work'; v.workLeft = 25; return;
      }
      if (!this.send(v, this.gate(L.arsenal), 'back')) this.home(v);
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
      if (!this.send(v, this.gate(L.arsenal), 'back')) this.home(v);
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
    if (v.kind === 'van') { const m = this.g.obj(v.task.to); if (m) m.coming = Math.max(0, (m.coming || 0) - (v.task.load || 1)); }
    if (v.kind === 'crew') this.g.crewLost(v);
    this.sim.msg(`Потеря на дороге: ${VEH[v.kind].name.toLowerCase()} (${why})`, v.side);
  }
}
void M;
