// Точная сетка для пеших (0.4 м): стены зданий с проёмами дверей, вода.
// Строится на лету вокруг нужного участка — для ближнего боя, зданий и дворов.

import { M } from '../spatial.js';
import { pointInPoly } from '../geom.js';

export const LOCAL_RES = 0.4;
const MAX_CELLS = 700;

export class LocalGrid {
  constructor(world, bbox) {
    const res = LOCAL_RES;
    const pad = 12;
    let x0 = bbox.x0 - pad, y0 = bbox.y0 - pad, x1 = bbox.x1 + pad, y1 = bbox.y1 + pad;
    // Ограничение размера (≈280 м)
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const half = (MAX_CELLS * res) / 2;
    x0 = Math.max(x0, cx - half); x1 = Math.min(x1, cx + half);
    y0 = Math.max(y0, cy - half); y1 = Math.min(y1, cy + half);
    this.x0 = x0; this.y0 = y0;
    this.w = Math.ceil((x1 - x0) / res);
    this.h = Math.ceil((y1 - y0) / res);
    this.res = res;
    this.blocked = new Uint8Array(this.w * this.h);
    this.world = world;
    this.rasterize({ x0, y0, x1, y1 });
  }

  rasterize(b) {
    const { world } = this;
    // Вода
    for (let iy = 0; iy < this.h; iy += 1) {
      const y = this.y0 + (iy + 0.5) * this.res;
      for (let ix = 0; ix < this.w; ix++) {
        const x = this.x0 + (ix + 0.5) * this.res;
        if (world.mask.has(x, y, M.WATER) && !world.mask.has(x, y, M.ROAD)) this.blocked[iy * this.w + ix] = 1;
      }
    }
    for (const bd of world.buildings.query(b)) {
      if (bd.interior) for (const w of bd.interior.walls) this.stampSeg(w.a, w.b);
      else if (bd.style === 'silo') this.stampPoly(circlePoly(bd.x, bd.y, bd.r));
      else this.stampPoly(bd.poly);
    }
  }

  cell(x, y) {
    const ix = Math.floor((x - this.x0) / this.res), iy = Math.floor((y - this.y0) / this.res);
    if (ix < 0 || iy < 0 || ix >= this.w || iy >= this.h) return -1;
    return iy * this.w + ix;
  }
  inside(x, y) {
    return this.cell(x, y) >= 0;
  }

  // Стена: помечаем все клетки вдоль отрезка
  stampSeg(a, b) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(L / (this.res * 0.25)));
    for (let k = 0; k <= n; k++) {
      const i = this.cell(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n);
      if (i >= 0) this.blocked[i] = 1;
    }
  }

  stampPoly(poly) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    for (let y = y0; y <= y1; y += this.res * 0.5)
      for (let x = x0; x <= x1; x += this.res * 0.5)
        if (pointInPoly(x, y, poly)) {
          const i = this.cell(x, y);
          if (i >= 0) this.blocked[i] = 1;
        }
    for (let i = 0; i < poly.length; i++) this.stampSeg(poly[i], poly[(i + 1) % poly.length]);
  }

  nearestFree(x, y) {
    const c = this.cell(x, y);
    if (c < 0) return -1;
    if (!this.blocked[c]) return c;
    const cx = c % this.w, cy = (c / this.w) | 0;
    for (let r = 1; r < 12; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const ix = cx + dx, iy = cy + dy;
          if (ix < 0 || iy < 0 || ix >= this.w || iy >= this.h) continue;
          if (!this.blocked[iy * this.w + ix]) return iy * this.w + ix;
        }
    return -1;
  }

  // A* по 8 направлениям без срезания углов; возвращает [[x,y],...]
  path(ax, ay, bx, by) {
    const s = this.nearestFree(ax, ay), t = this.nearestFree(bx, by);
    if (s < 0 || t < 0) return null;
    const W = this.w, H = this.h, N = W * H;
    // Рабочие массивы — одни на сетку (несколько бойцов по одной сетке), сброс «штампом»
    if (!this.g) { this.g = new Float32Array(N); this.prevA = new Int32Array(N); this.seenA = new Uint16Array(N); this.closedA = new Uint16Array(N); this.stamp = 0; }
    const st = ++this.stamp;
    const g = this.g, prev = this.prevA, seen = this.seenA, closedA = this.closedA;
    const tx = t % W, ty = (t / W) | 0;
    const heap = new MinHeap();
    const h = (i) => {
      const dx = Math.abs((i % W) - tx), dy = Math.abs(((i / W) | 0) - ty);
      return (Math.max(dx, dy) + 0.4142 * Math.min(dx, dy)) * 1.6; // «жадный» A*: в разы меньше перебора, путь почти тот же
    };
    g[s] = 0; seen[s] = st; prev[s] = -1;
    heap.push(s, h(s));
    const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1];
    const B = this.blocked;
    let found = false, expanded = 0;
    while (heap.size) {
      const cur = heap.pop();
      if (closedA[cur] === st) continue;
      closedA[cur] = st;
      if (cur === t) { found = true; break; }
      if (++expanded > 40000) break; // цель недостижима — не перебираем всю сетку
      const cx = cur % W, cy = (cur / W) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k], ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (B[ni] || closedA[ni] === st) continue;
        let step = 1;
        if (k >= 4) {
          if (B[cy * W + nx] || B[ny * W + cx]) continue;
          step = 1.4142;
        }
        const ng = g[cur] + step;
        if (seen[ni] !== st || ng < g[ni]) {
          seen[ni] = st;
          g[ni] = ng;
          prev[ni] = cur;
          heap.push(ni, ng + h(ni));
        }
      }
    }
    if (!found) return null;
    const cells = [];
    for (let i = t; i !== -1; i = prev[i]) cells.push(i);
    cells.reverse();
    const pts = cells.map((i) => [this.x0 + ((i % W) + 0.5) * this.res, this.y0 + (((i / W) | 0) + 0.5) * this.res]);
    pts[pts.length - 1] = [bx, by];
    if (this.blocked[this.cell(bx, by)]) pts[pts.length - 1] = [this.x0 + (tx + 0.5) * this.res, this.y0 + (ty + 0.5) * this.res];
    return this.smooth([[ax, ay], ...pts.slice(1)]);
  }

  // Спрямление по прямой видимости
  smooth(pts) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let best = i + 1;
      for (let j = Math.min(pts.length - 1, i + 120); j > i + 1; j--) {
        if (this.clear(pts[i], pts[j])) { best = j; break; }
      }
      out.push(pts[best]);
      i = best;
    }
    return out;
  }

  clear(a, b) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.ceil(L / (this.res * 0.35));
    for (let k = 1; k < n; k++) {
      const x = a[0] + ((b[0] - a[0]) * k) / n, y = a[1] + ((b[1] - a[1]) * k) / n;
      // «толстый» луч: проверяем и боковые точки, чтобы не тереться о косяки
      for (const [ox, oy] of [[0, 0], [0.18, 0.18], [-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18]]) {
        const c = this.cell(x + ox, y + oy);
        if (c < 0 || this.blocked[c]) return false;
      }
    }
    return true;
  }
}

function circlePoly(x, y, r) {
  const out = [];
  for (let i = 0; i < 16; i++) out.push([x + Math.cos((i / 16) * Math.PI * 2) * r, y + Math.sin((i / 16) * Math.PI * 2) * r]);
  return out;
}

class MinHeap {
  constructor() { this.a = []; this.p = []; this.size = 0; }
  push(v, pr) {
    let i = this.size++;
    this.a[i] = v; this.p[i] = pr;
    while (i > 0) {
      const q = (i - 1) >> 1;
      if (this.p[q] <= pr) break;
      this.a[i] = this.a[q]; this.p[i] = this.p[q];
      this.a[q] = v; this.p[q] = pr;
      i = q;
    }
  }
  pop() {
    const top = this.a[0];
    const n = --this.size;
    if (n > 0) {
      const v = this.a[n], pr = this.p[n];
      let i = 0;
      while (true) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && this.p[c + 1] < this.p[c]) c++;
        if (this.p[c] >= pr) break;
        this.a[i] = this.a[c]; this.p[i] = this.p[c];
        i = c;
      }
      this.a[i] = v; this.p[i] = pr;
    }
    return top;
  }
}
