// Дорожный граф для маршрутов: техника и колонны едут по осевой дороги,
// повторяя её изгибы, а не по ступенькам сетки проходимости.
// Узлы — точки дорог через ~16 м; перекрёстки — связи между близкими узлами разных дорог.

import { resample } from '../geom.js';
import { MOVE, T } from './nav.js';

const STEP = 16;
const PAVED = new Set(['highway', 'local', 'street', 'avenue', 'village']);

export class RoadGraph {
  constructor(world) {
    this.x = [];
    this.y = [];
    this.road = []; // индекс дороги
    this.adj = []; // [[сосед, длина], ...]
    this.roads = world.roadList;
    this.cell = 40;
    this.bins = new Map();
    world.roadList.forEach((r, ri) => {
      const pts = resample(r.line, STEP);
      let prev = -1;
      for (const [x, y] of pts) {
        const id = this.x.length;
        this.x.push(x); this.y.push(y); this.road.push(ri); this.adj.push([]);
        this.bin(x, y).push(id);
        if (prev >= 0) this.link(prev, id);
        prev = id;
      }
    });
    // Перекрёстки и примыкания: узлы разных дорог ближе полуширины + запас
    for (let i = 0; i < this.x.length; i++) {
      const ri = this.road[i];
      const wi = this.roads[ri].width;
      for (const j of this.near(this.x[i], this.y[i], 30)) {
        if (j <= i || this.road[j] === ri) continue;
        const d = Math.hypot(this.x[j] - this.x[i], this.y[j] - this.y[i]);
        if (d < Math.max(wi, this.roads[this.road[j]].width) / 2 + 11) this.link(i, j);
      }
    }
    // Работа A*
    const n = this.x.length;
    this.g = new Float64Array(n);
    this.par = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.stamp = 0;
  }

  bin(x, y) {
    const k = Math.floor(x / this.cell) * 100003 + Math.floor(y / this.cell);
    let b = this.bins.get(k);
    if (!b) this.bins.set(k, (b = []));
    return b;
  }
  near(x, y, r) {
    const out = [];
    const c = this.cell;
    for (let cx = Math.floor((x - r) / c); cx <= Math.floor((x + r) / c); cx++)
      for (let cy = Math.floor((y - r) / c); cy <= Math.floor((y + r) / c); cy++) {
        const b = this.bins.get(cx * 100003 + cy);
        if (b) for (const id of b) if (Math.hypot(this.x[id] - x, this.y[id] - y) <= r) out.push(id);
      }
    return out;
  }
  link(a, b) {
    const d = Math.hypot(this.x[a] - this.x[b], this.y[a] - this.y[b]);
    this.adj[a].push([b, d]);
    this.adj[b].push([a, d]);
  }
  speed(id, move) {
    const paved = PAVED.has(this.roads[this.road[id]].type);
    return MOVE[move][paved ? T.ROAD : T.DIRT];
  }

  // Маршрут по дорогам: подъезд к ближайшим узлам у старта, дороги, съезд у цели.
  // offroad(ax, ay, bx, by) → { path, time } — участок по местности (сетка).
  route(ax, ay, bx, by, move, offroad) {
    const R = 450;
    const starts = this.near(ax, ay, R).sort((a, b) => this.dist(a, ax, ay) - this.dist(b, ax, ay)).slice(0, 6);
    const goals = this.near(bx, by, R).sort((a, b) => this.dist(a, bx, by) - this.dist(b, bx, by)).slice(0, 6);
    if (!starts.length || !goals.length) return null;
    const fieldSpeed = MOVE[move][T.OPEN] * 0.8;
    const maxSpeed = MOVE[move][T.ROAD];
    // Много источников: цена старта — оценка подъезда по полю
    const stamp = ++this.stamp;
    const { g, par, seen } = this;
    const open = new MinHeap();
    for (const s of starts) {
      g[s] = this.dist(s, ax, ay) / fieldSpeed;
      par[s] = -1;
      seen[s] = stamp;
      open.push(s, g[s] + Math.hypot(this.x[s] - bx, this.y[s] - by) / maxSpeed);
    }
    const goalCost = new Map(goals.map((q) => [q, this.dist(q, bx, by) / fieldSpeed]));
    let best = -1, bestCost = Infinity;
    const done = new Set();
    let expanded = 0;
    while (open.size) {
      const [cur, f] = open.pop();
      if (f >= bestCost) break;
      if (done.has(cur)) continue;
      done.add(cur);
      if (++expanded > 60000) break;
      if (goalCost.has(cur)) {
        const c = g[cur] + goalCost.get(cur);
        if (c < bestCost) { bestCost = c; best = cur; }
      }
      const sp = this.speed(cur, move);
      for (const [nb, L] of this.adj[cur]) {
        const ng = g[cur] + L / Math.min(sp, this.speed(nb, move));
        if (seen[nb] !== stamp || ng < g[nb]) {
          seen[nb] = stamp; g[nb] = ng; par[nb] = cur;
          open.push(nb, ng + Math.hypot(this.x[nb] - bx, this.y[nb] - by) / maxSpeed);
        }
      }
    }
    if (best < 0) return null;
    const ids = [];
    for (let i = best; i !== -1; i = par[i]) ids.push(i);
    ids.reverse();
    // Уточняем подъезд и съезд по местности
    const first = ids[0], last = ids[ids.length - 1];
    const inLeg = offroad(ax, ay, this.x[first], this.y[first]);
    const outLeg = offroad(this.x[last], this.y[last], bx, by);
    if (!inLeg || !outLeg) return null;
    const roadPts = this.lane(ids);
    let roadTime = 0;
    for (let i = 1; i < ids.length; i++) {
      const a = ids[i - 1], b = ids[i];
      roadTime += Math.hypot(this.x[b] - this.x[a], this.y[b] - this.y[a]) / Math.min(this.speed(a, move), this.speed(b, move));
    }
    const path = [...inLeg.path.slice(0, -1), ...roadPts, ...outLeg.path.slice(1)];
    return { path: dedupe(path), time: inLeg.time + roadTime + outLeg.time, roadLen: ids.length * STEP };
  }

  dist(id, x, y) {
    return Math.hypot(this.x[id] - x, this.y[id] - y);
  }

  // Правая полоса: смещение от оси по ходу движения (двустороннее движение)
  lane(ids) {
    const out = [];
    for (let k = 0; k < ids.length; k++) {
      const i = ids[k];
      const a = ids[Math.max(0, k - 1)], b = ids[Math.min(ids.length - 1, k + 1)];
      let dx = this.x[b] - this.x[a], dy = this.y[b] - this.y[a];
      const L = Math.hypot(dx, dy) || 1;
      dx /= L; dy /= L;
      const off = Math.min(4, this.roads[this.road[i]].width / 4);
      out.push([this.x[i] - dy * off, this.y[i] + dx * off]);
    }
    return out;
  }
}

function dedupe(pts) {
  const out = [pts[0]];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 1.5) out.push(p);
  }
  return out;
}

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(v, p) {
    const a = this.a;
    a.push([v, p]);
    let i = a.length - 1;
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (a[j][1] <= a[i][1]) break;
      [a[i], a[j]] = [a[j], a[i]];
      i = j;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][1] < a[m][1]) m = l;
        if (r < a.length && a[r][1] < a[m][1]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}
