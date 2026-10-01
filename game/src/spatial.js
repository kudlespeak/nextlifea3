// Пространственный индекс (сетка корзин) и растровая маска занятости карты.

export class SpatialIndex {
  constructor(W, H, cell = 256) {
    this.cell = cell;
    this.cols = Math.ceil(W / cell) + 1;
    this.rows = Math.ceil(H / cell) + 1;
    this.bins = new Map();
    this.stamp = 0;
    this.items = [];
  }
  _range(b) {
    const c = this.cell;
    return [Math.floor(b.x0 / c), Math.floor(b.y0 / c), Math.floor(b.x1 / c), Math.floor(b.y1 / c)];
  }
  insert(item) {
    item._q = 0;
    item._order = this.items.length;
    this.items.push(item);
    const [cx0, cy0, cx1, cy1] = this._range(item.bbox);
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = cy * 100000 + cx;
        let bin = this.bins.get(k);
        if (!bin) this.bins.set(k, (bin = []));
        bin.push(item);
      }
  }
  // Возвращает объекты, чей bbox пересекает b, в порядке добавления (sorted=false — в любом
  // порядке, дешевле для больших выборок, где порядок не важен)
  query(b, sorted = true) {
    const stamp = ++this.stamp;
    const out = [];
    const [cx0, cy0, cx1, cy1] = this._range(b);
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const bin = this.bins.get(cy * 100000 + cx);
        if (!bin) continue;
        for (const it of bin) {
          if (it._q === stamp) continue;
          it._q = stamp;
          const bb = it.bbox;
          if (bb.x0 <= b.x1 && bb.x1 >= b.x0 && bb.y0 <= b.y1 && bb.y1 >= b.y0) out.push(it);
        }
      }
    if (sorted) out.sort((a, c) => a._order - c._order);
    return out;
  }
}

// Точечные объекты (деревья) в плоских массивах по корзинам — их десятки тысяч.
export class PointBins {
  constructor(W, H, cell = 128, stride = 4) {
    this.cell = cell;
    this.stride = stride;
    this.bins = new Map();
    this.count = 0;
  }
  add(...vals) {
    const k = Math.floor(vals[1] / this.cell) * 100000 + Math.floor(vals[0] / this.cell);
    let bin = this.bins.get(k);
    if (!bin) this.bins.set(k, (bin = []));
    else if (!Array.isArray(bin)) this.bins.set(k, (bin = Array.from(bin))); // упакованную корзину — обратно в массив
    bin.push(...vals);
    this.count++;
  }
  // Упаковать корзины в Float32Array: на большой карте деревьев миллионы — вдвое меньше памяти,
  // и копия мира для потоков отрисовки и кэша делается быстро
  pack() {
    for (const [k, bin] of this.bins) if (Array.isArray(bin)) this.bins.set(k, Float32Array.from(bin));
  }
  // Вызывает fn(массив, индекс) для каждой точки в прямоугольнике
  forEach(b, fn) {
    const c = this.cell;
    const cx0 = Math.floor(b.x0 / c), cy0 = Math.floor(b.y0 / c);
    const cx1 = Math.floor(b.x1 / c), cy1 = Math.floor(b.y1 / c);
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const bin = this.bins.get(cy * 100000 + cx);
        if (!bin) continue;
        for (let i = 0; i < bin.length; i += this.stride) {
          const x = bin[i], y = bin[i + 1];
          if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) fn(bin, i);
        }
      }
  }
}

// Флаги маски
export const M = {
  ROAD: 1,
  WATER: 2,
  BUILD: 4,
  SETTLE: 8,
  RAIL: 16,
  BALKA: 32,
  CITY: 64,
  VILLAGE: 128,
  CITYZONE: 256,
  FORT: 512, // рядом окопы — деревья вблизи становятся прозрачнее
  CANOPY: 1024, // кроны деревьев — закрывают обзор
  GREEN: 2048, // придорожная лесополоса — поля сюда не заходят
};

// Маска хранится плитками 128×128 ячеек: плитка заводится при первой записи. Большая карта с
// пустыми полями в тылу почти не занимает памяти (у каждого потока отрисовки своя копия мира)
const TB = 7, TS = 1 << TB, TM = TS - 1;
export class Mask {
  constructor(W, H, res = 4) {
    this.res = res;
    this.w = Math.ceil(W / res);
    this.h = Math.ceil(H / res);
    this.tw = Math.ceil(this.w / TS);
    this.tiles = new Array(this.tw * Math.ceil(this.h / TS)).fill(null);
  }
  cell(ix, iy) {
    const t = this.tiles[(iy >> TB) * this.tw + (ix >> TB)];
    return t ? t[((iy & TM) << TB) | (ix & TM)] : 0;
  }
  or(ix, iy, flag) {
    const k = (iy >> TB) * this.tw + (ix >> TB);
    const t = this.tiles[k] || (this.tiles[k] = new Uint16Array(TS * TS));
    t[((iy & TM) << TB) | (ix & TM)] |= flag;
  }
  and(ix, iy, keep) {
    const t = this.tiles[(iy >> TB) * this.tw + (ix >> TB)];
    if (t) t[((iy & TM) << TB) | (ix & TM)] &= keep;
  }
  get(x, y) {
    const ix = Math.floor(x / this.res), iy = Math.floor(y / this.res);
    if (ix < 0 || iy < 0 || ix >= this.w || iy >= this.h) return 0;
    return this.cell(ix, iy);
  }
  has(x, y, flags) {
    return (this.get(x, y) & flags) !== 0;
  }
  // Есть ли флаг в радиусе r (грубая проверка по 9 точкам)
  near(x, y, r, flags) {
    if (this.has(x, y, flags)) return true;
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      if (this.has(x + Math.cos(ang) * r, y + Math.sin(ang) * r, flags)) return true;
    }
    return false;
  }
  clearRect(b, flag) {
    const res = this.res;
    const ix0 = Math.max(0, Math.floor(b.x0 / res)), ix1 = Math.min(this.w - 1, Math.floor(b.x1 / res));
    const iy0 = Math.max(0, Math.floor(b.y0 / res)), iy1 = Math.min(this.h - 1, Math.floor(b.y1 / res));
    for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) this.and(ix, iy, ~flag);
  }
  stampDisc(x, y, r, flag) {
    const res = this.res;
    const ix0 = Math.max(0, Math.floor((x - r) / res)), ix1 = Math.min(this.w - 1, Math.floor((x + r) / res));
    const iy0 = Math.max(0, Math.floor((y - r) / res)), iy1 = Math.min(this.h - 1, Math.floor((y + r) / res));
    const r2 = r * r;
    for (let iy = iy0; iy <= iy1; iy++)
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = (ix + 0.5) * res - x, dy = (iy + 0.5) * res - y;
        if (dx * dx + dy * dy <= r2) this.or(ix, iy, flag);
      }
  }
  stampLine(line, width, flag) {
    const r = width / 2;
    const step = Math.max(1, this.res * 0.75);
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1], [bx, by] = line[i];
      const L = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.ceil(L / step));
      for (let k = 0; k <= n; k++) this.stampDisc(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, r, flag);
    }
  }
  stampPoly(poly, flag) {
    const res = this.res;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    const iy0 = Math.max(0, Math.floor(y0 / res)), iy1 = Math.min(this.h - 1, Math.floor(y1 / res));
    const ix0 = Math.max(0, Math.floor(x0 / res)), ix1 = Math.min(this.w - 1, Math.floor(x1 / res));
    // Сканлайн: пересечения рёбер с горизонталью
    for (let iy = iy0; iy <= iy1; iy++) {
      const y = (iy + 0.5) * res;
      const xs = [];
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if (yi > y !== yj > y) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = Math.max(ix0, Math.ceil(xs[k] / res - 0.5));
        const b = Math.min(ix1, Math.floor(xs[k + 1] / res - 0.5));
        for (let ix = a; ix <= b; ix++) this.or(ix, iy, flag);
      }
    }
  }
  // Свободен ли многоугольник: вершины + сетка точек внутри с шагом step
  polyFree(poly, flags, step = 5) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly) {
      if (this.has(x, y, flags)) return false;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    for (let y = y0 + step / 2; y < y1; y += step)
      for (let x = x0 + step / 2; x < x1; x += step) {
        if (!this.has(x, y, flags)) continue;
        if (pointInPolyLocal(x, y, poly)) return false;
      }
    return true;
  }
}

function pointInPolyLocal(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
