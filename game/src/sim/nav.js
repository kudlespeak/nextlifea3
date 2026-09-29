// Навигационная сетка проходимости и поиск пути (A*).
// Не зависит от отрисовки: этот модуль можно запускать и на сервере.

// Классы местности
export const T = {
  OPEN: 0, CROP: 1, PLOWED: 2, TREES: 3, DIRT: 4, ROAD: 5,
  WATER: 6, BUILDING: 7, URBAN: 8, RAIL: 9, RAVINE: 10,
};
export const T_NAMES = ['степь', 'поле', 'пашня', 'посадка', 'грунтовка', 'асфальт', 'вода', 'здание', 'застройка', 'ж/д', 'балка'];

// Скорость (м/с) по классу местности для каждого типа движителя
export const MOVE = {
  //         OPEN CROP PLOW TREE DIRT ROAD WATR BLDG URBN RAIL RAVN
  foot:    [1.4, 1.25, 0.95, 0.9, 1.5, 1.55, 0, 0, 1.4, 1.2, 0.8],
  wheeled: [9, 7, 3.5, 1.2, 12, 20, 0, 0, 7, 2.5, 2.5],
  tracked: [10, 9, 6.5, 2.5, 11, 14, 0, 0, 6, 4, 4.5],
};

// Множитель «цены» клетки в скрытном режиме: открытое — дорого, укрытия — дёшево
const STEALTH = [2.6, 2.2, 2.6, 0.7, 2.2, 3.0, 1, 1, 1.1, 2.6, 0.9];

export class NavGrid {
  constructor(world, res = 8) {
    this.res = res;
    this.w = Math.ceil(world.W / res);
    this.h = Math.ceil(world.H / res);
    this.cls = new Uint8Array(this.w * this.h);
    const n = this.w * this.h;
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.stamp = 0;
    this.heap = new Heap(n);
    this.build(world);
  }

  // ---------- Растеризация карты ----------
  build(world) {
    this.cls.fill(T.OPEN);
    const all = (index) => index.items;
    for (const f of all(world.fields)) {
      const v = f.crop === 'plowed' || f.crop === 'harrowed' ? T.PLOWED : f.crop === 'fallow' ? T.OPEN : T.CROP;
      this.stampPoly(f.poly, v);
    }
    for (const a of all(world.areas)) {
      switch (a.kind) {
        case 'floodplain': case 'vground': this.stampLine(a.line, a.width, T.OPEN); break;
        case 'balka':
          for (let i = 1; i < a.line.length; i++) this.stampLine([a.line[i - 1], a.line[i]], a.widths[i] * 0.55, T.RAVINE);
          break;
        case 'urban': case 'industrial': case 'yard': case 'farmyard': case 'platform': this.stampPoly(a.poly, T.URBAN); break;
        case 'plot': case 'park': case 'stadium': this.stampPoly(a.poly, T.OPEN); break;
        case 'garden': this.stampPoly(a.poly, T.PLOWED); break;
      }
    }
    // Деревья: клетка с кроной — «посадка»
    for (const bin of world.trees.bins.values())
      for (let i = 0; i < bin.length; i += 4) {
        if (bin[i + 2] < 2.2) continue; // мелкие кусты не мешают
        this.set(bin[i], bin[i + 1], T.TREES);
      }
    for (const w of all(world.water)) {
      if (w.kind === 'river') this.stampLine(w.line, w.width, T.WATER);
      else this.stampPoly(w.poly, T.WATER);
    }
    for (const a of all(world.areas)) if (a.kind === 'dam') this.stampLine(a.line, a.width * 0.6, T.DIRT);
    for (const r of all(world.rails)) this.stampLine(r.line, Math.max(6, r.width * 0.6), T.RAIL);
    // Дороги последними — поверх воды получаются мосты
    for (const r of world.roadList) this.stampLine(r.line, Math.max(this.res, r.width), r.type === 'dirt' ? T.DIRT : T.ROAD);
    for (const b of all(world.buildings)) {
      if (b.style === 'silo') this.stampDisc(b.x, b.y, b.r, T.BUILDING);
      else if (b.w * b.h > 40) this.stampPoly(b.poly, T.BUILDING);
    }
  }

  idx(x, y) {
    const ix = Math.floor(x / this.res), iy = Math.floor(y / this.res);
    if (ix < 0 || iy < 0 || ix >= this.w || iy >= this.h) return -1;
    return iy * this.w + ix;
  }
  set(x, y, v) {
    const i = this.idx(x, y);
    if (i >= 0) this.cls[i] = v;
  }
  classAt(x, y) {
    const i = this.idx(x, y);
    return i < 0 ? T.WATER : this.cls[i];
  }
  speedAt(x, y, move) {
    return MOVE[move][this.classAt(x, y)];
  }
  stampDisc(x, y, r, v) {
    const res = this.res;
    const ix0 = Math.max(0, Math.floor((x - r) / res)), ix1 = Math.min(this.w - 1, Math.floor((x + r) / res));
    const iy0 = Math.max(0, Math.floor((y - r) / res)), iy1 = Math.min(this.h - 1, Math.floor((y + r) / res));
    const r2 = Math.max(r * r, (res * res) / 4);
    for (let iy = iy0; iy <= iy1; iy++)
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = (ix + 0.5) * res - x, dy = (iy + 0.5) * res - y;
        if (dx * dx + dy * dy <= r2) this.cls[iy * this.w + ix] = v;
      }
  }
  stampLine(line, width, v) {
    const r = width / 2;
    const step = this.res * 0.5;
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1], [bx, by] = line[i];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
      for (let k = 0; k <= n; k++) this.stampDisc(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, r, v);
    }
  }
  stampPoly(poly, v) {
    const res = this.res;
    let y0 = Infinity, y1 = -Infinity;
    for (const p of poly) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    const iy0 = Math.max(0, Math.floor(y0 / res)), iy1 = Math.min(this.h - 1, Math.floor(y1 / res));
    for (let iy = iy0; iy <= iy1; iy++) {
      const y = (iy + 0.5) * res;
      const xs = [];
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if (yi > y !== yj > y) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = Math.max(0, Math.ceil(xs[k] / res - 0.5));
        const b = Math.min(this.w - 1, Math.floor(xs[k + 1] / res - 0.5));
        for (let ix = a; ix <= b; ix++) this.cls[iy * this.w + ix] = v;
      }
    }
  }

  // Ближайшая проходимая клетка (поиск по кольцам)
  nearestPassable(x, y, move) {
    const sp = MOVE[move];
    const cx = Math.floor(x / this.res), cy = Math.floor(y / this.res);
    for (let r = 0; r < 40; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const ix = cx + dx, iy = cy + dy;
          if (ix < 0 || iy < 0 || ix >= this.w || iy >= this.h) continue;
          if (sp[this.cls[iy * this.w + ix]] > 0) return r === 0 ? [x, y] : [(ix + 0.5) * this.res, (iy + 0.5) * this.res];
        }
    return null;
  }

  // ---------- A* ----------
  // Цена клетки = время прохождения (с). Возвращает { path, time } или null.
  findPath(sx, sy, tx, ty, move, stealth = false) {
    const sp = MOVE[move];
    const res = this.res;
    const cost = sp.map((s, c) => (s > 0 ? (res / s) * (stealth ? STEALTH[c] : 1) : Infinity));
    let minCost = Infinity;
    for (const c of cost) minCost = Math.min(minCost, c);

    const s = this.nearestPassable(sx, sy, move);
    const t = this.nearestPassable(tx, ty, move);
    if (!s || !t) return null;
    const W = this.w, cls = this.cls;
    const start = this.idx(s[0], s[1]), goal = this.idx(t[0], t[1]);
    const gx = goal % W, gy = (goal / W) | 0;
    const H_WEIGHT = 1.25; // слегка «жадный» A*: быстрее, пути почти оптимальны
    const heur = (i) => {
      const dx = Math.abs((i % W) - gx), dy = Math.abs(((i / W) | 0) - gy);
      return (Math.max(dx, dy) + 0.4142 * Math.min(dx, dy)) * minCost * H_WEIGHT;
    };

    const stamp = ++this.stamp;
    const { g, parent, seen, closed, heap } = this;
    heap.clear();
    g[start] = 0;
    parent[start] = -1;
    seen[start] = stamp;
    heap.push(start, heur(start));
    const DX = [1, -1, 0, 0, 1, 1, -1, -1];
    const DY = [0, 0, 1, -1, 1, -1, 1, -1];
    let found = false;
    let expanded = 0;
    while (heap.size) {
      const cur = heap.pop();
      if (closed[cur] === stamp) continue;
      closed[cur] = stamp;
      if (cur === goal) { found = true; break; }
      if (++expanded > 250000) break;
      const cx = cur % W, cy = (cur / W) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k], ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= this.h) continue;
        const ni = ny * W + nx;
        const c = cost[cls[ni]];
        if (c === Infinity || closed[ni] === stamp) continue;
        let step = c;
        if (k >= 4) {
          // Диагональ: нельзя срезать угол через непроходимое
          if (cost[cls[cy * W + nx]] === Infinity || cost[cls[ny * W + cx]] === Infinity) continue;
          step = c * 1.4142;
        }
        const ng = g[cur] + step;
        if (seen[ni] !== stamp || ng < g[ni]) {
          seen[ni] = stamp;
          g[ni] = ng;
          parent[ni] = cur;
          heap.push(ni, ng + heur(ni));
        }
      }
    }
    if (!found) return null;

    const cells = [];
    for (let i = goal; i !== -1; i = parent[i]) cells.push(i);
    cells.reverse();
    const pts = cells.map((i) => [((i % W) + 0.5) * res, (((i / W) | 0) + 0.5) * res]);
    pts[0] = s;
    pts[pts.length - 1] = t;
    return { path: this.smooth(pts, cells, cost), time: g[goal] };
  }

  // Спрямление: пропускаем точки, если прямой отрезок идёт только по тем же
  // классам местности, что и исходный кусок пути (дорога остаётся дорогой)
  smooth(pts, cells, cost) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let best = i + 1;
      const classes = new Set([this.cls[cells[i]]]);
      for (let j = i + 1; j < Math.min(pts.length, i + 48); j++) {
        classes.add(this.cls[cells[j]]);
        if (this.segmentOk(pts[i], pts[j], classes, cost)) best = j;
      }
      out.push(pts[best]);
      i = best;
    }
    return out;
  }

  segmentOk(a, b, classes, cost) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.ceil(L / (this.res * 0.4));
    for (let k = 1; k < n; k++) {
      const c = this.classAt(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n);
      if (cost[c] === Infinity || !classes.has(c)) return false;
    }
    return true;
  }
}

// Двоичная куча по приоритету на типизированных массивах
class Heap {
  constructor(cap) {
    this.items = new Int32Array(cap * 2);
    this.prio = new Float32Array(cap * 2);
    this.size = 0;
  }
  clear() { this.size = 0; }
  push(item, p) {
    if (this.size >= this.items.length) this.grow();
    let i = this.size++;
    const { items, prio } = this;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (prio[par] <= p) break;
      items[i] = items[par];
      prio[i] = prio[par];
      i = par;
    }
    items[i] = item;
    prio[i] = p;
  }
  pop() {
    const { items, prio } = this;
    const top = items[0];
    const n = --this.size;
    if (n > 0) {
      const it = items[n], p = prio[n];
      let i = 0;
      while (true) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && prio[c + 1] < prio[c]) c++;
        if (prio[c] >= p) break;
        items[i] = items[c];
        prio[i] = prio[c];
        i = c;
      }
      items[i] = it;
      prio[i] = p;
    }
    return top;
  }
  grow() {
    const items = new Int32Array(this.items.length * 2);
    const prio = new Float32Array(this.prio.length * 2);
    items.set(this.items);
    prio.set(this.prio);
    this.items = items;
    this.prio = prio;
  }
}
