// Мини-3D: модели из примитивов (коробки, лофты, цилиндры, купола, сегменты) и программный
// растеризатор с z-буфером. Модель заранее рендерится в спрайт под 32 углами поворота в той же
// косоугольной проекции, что и фасады зданий (высота уходит вверх экрана на K·h), со светом
// солнца, самозатенением граней, «грязью» у земли, контурами и мягкой тенью на землю.
// В кадре — только drawImage нужного ракурса (+ доворот на остаток угла ±5.6°).

export const K3 = 0.42; // как FACADE_K у зданий
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
export const SUN = norm([-0.5, -0.55, 1.35]); // на солнце (с северо-запада, сверху)
const VIEW = norm([0, K3, 1]); // к зрителю
export const ANGLES = 32;

// ---------- Материалы ----------
export function hex(c) {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
// m(color, {fn, spec, flat, ao}) — fn(out, x, y, z, n) может перекрасить точку (камуфляж, решётки, знаки)
export function mat(c, o = {}) {
  return { c: typeof c === 'string' ? hex(c) : c, fn: o.fn || null, spec: o.spec || 0, ao: o.ao ?? true, glow: o.glow || 0 };
}

// ---------- Шум (для камуфляжа, грязи, потёртостей) ----------
function hash3(i, j, k) {
  let h = (i * 374761393 + j * 668265263 + k * 1440662683) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u), l(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u), v),
    l(l(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u), l(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}
export function fbm(x, y, z) {
  return vnoise(x, y, z) * 0.62 + vnoise(x * 2.1 + 17, y * 2.1, z * 2.1) * 0.28 + vnoise(x * 5.3, y * 5.3 + 9, z * 5.3) * 0.1;
}
export const mix = (out, c, t) => { out[0] += (c[0] - out[0]) * t; out[1] += (c[1] - out[1]) * t; out[2] += (c[2] - out[2]) * t; };

// ---------- Построитель модели ----------
export class Model {
  constructor() { this.parts = []; }

  // faces: массив многоугольников [[x,y,z],...] с материалами; нормали — наружу от центра детали
  part(faces, center) {
    if (!center) {
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (const f of faces) for (const p of f.v) { sx += p[0]; sy += p[1]; sz += p[2]; n++; }
      center = [sx / n, sy / n, sz / n];
    }
    for (const f of faces) {
      // нормаль по Ньюэллу
      let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
      const v = f.v;
      for (let i = 0; i < v.length; i++) {
        const a = v[i], b = v[(i + 1) % v.length];
        nx += (a[1] - b[1]) * (a[2] + b[2]);
        ny += (a[2] - b[2]) * (a[0] + b[0]);
        nz += (a[0] - b[0]) * (a[1] + b[1]);
        cx += a[0]; cy += a[1]; cz += a[2];
      }
      cx /= v.length; cy /= v.length; cz /= v.length;
      let n = norm([nx, ny, nz]);
      if (f.nHint) n = f.nHint;
      else if ((cx - center[0]) * n[0] + (cy - center[1]) * n[1] + (cz - center[2]) * n[2] < 0) n = [-n[0], -n[1], -n[2]];
      f.n = n;
    }
    this.parts.push(faces);
    return this;
  }

  box(x0, x1, y0, y1, z0, z1, m, top = m) {
    const P = (x, y, z) => [x, y, z];
    return this.part([
      { v: [P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], m: top },
      { v: [P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)], m },
      { v: [P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)], m },
      { v: [P(x0, y0, z0), P(x0, y1, z0), P(x0, y1, z1), P(x0, y0, z1)], m },
      { v: [P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)], m },
      { v: [P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0)], m },
    ]);
  }

  // Лофт по горизонтальным сечениям: rings = [[z, [[x,y],...]], ...] (одинаковое число вершин, выпуклые)
  loft(rings, m, top = m, bottom = true) {
    const faces = [];
    for (let r = 0; r < rings.length - 1; r++) {
      const [za, A] = rings[r], [zb, B] = rings[r + 1];
      for (let i = 0; i < A.length; i++) {
        const j = (i + 1) % A.length;
        faces.push({ v: [[A[i][0], A[i][1], za], [A[j][0], A[j][1], za], [B[j][0], B[j][1], zb], [B[i][0], B[i][1], zb]], m });
      }
    }
    const [zt, T] = rings[rings.length - 1];
    faces.push({ v: T.map(([x, y]) => [x, y, zt]), m: top, nHint: [0, 0, 1] });
    if (bottom) { const [z0, B0] = rings[0]; faces.push({ v: B0.map(([x, y]) => [x, y, z0]), m, nHint: [0, 0, -1] }); }
    return this.part(faces);
  }

  // Профиль в плоскости XZ, вытянутый по Y (борт танка, клин носа): prof = [[x,z],...] выпуклый
  extrudeY(prof, y0, y1, m, top = m) {
    const faces = [];
    const n = prof.length;
    for (let i = 0; i < n; i++) {
      const a = prof[i], b = prof[(i + 1) % n];
      faces.push({ v: [[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]], m });
    }
    faces.push({ v: prof.map(([x, z]) => [x, y0, z]), m, nHint: [0, -1, 0] });
    faces.push({ v: prof.map(([x, z]) => [x, y1, z]), m, nHint: [0, 1, 0] });
    this.part(faces);
    // верхние грани — отдельным материалом
    for (const f of faces) if (f.n && f.n[2] > 0.6) f.m = top;
    return this;
  }

  // Цилиндр вдоль Y (колесо): центр (cx, cz), радиус r
  cylY(cx, cz, r, y0, y1, m, n = 14, cap = m) {
    const faces = [];
    const ring = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; ring.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]); }
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      faces.push({ v: [[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]], m });
    }
    faces.push({ v: ring.map(([x, z]) => [x, y0, z]), m: cap, nHint: [0, -1, 0] });
    faces.push({ v: ring.map(([x, z]) => [x, y1, z]), m: cap, nHint: [0, 1, 0] });
    return this.part(faces, [cx, (y0 + y1) / 2, cz]);
  }

  // Труба вдоль X (ствол): по оси (cy, cz), радиусы r0 → r1
  cylX(cy, cz, r0, r1, x0, x1, m, n = 10, cap = m) {
    const faces = [];
    const A = [], B = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      A.push([cy + Math.cos(a) * r0, cz + Math.sin(a) * r0]);
      B.push([cy + Math.cos(a) * r1, cz + Math.sin(a) * r1]);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      faces.push({ v: [[x0, A[i][0], A[i][1]], [x0, A[j][0], A[j][1]], [x1, B[j][0], B[j][1]], [x1, B[i][0], B[i][1]]], m });
    }
    faces.push({ v: A.map(([y, z]) => [x0, y, z]), m: cap, nHint: [-1, 0, 0] });
    faces.push({ v: B.map(([y, z]) => [x1, y, z]), m: cap, nHint: [1, 0, 0] });
    return this.part(faces, [(x0 + x1) / 2, cy, cz]);
  }

  // Вертикальный цилиндр/конус (командирская башенка, бочка, мачта)
  cylZ(cx, cy, r0, r1, z0, z1, m, n = 12, top = m) {
    const A = [], B = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      A.push([cx + Math.cos(a) * r0, cy + Math.sin(a) * r0]);
      B.push([cx + Math.cos(a) * r1, cy + Math.sin(a) * r1]);
    }
    return this.loft([[z0, A], [z1, B]], m, top);
  }

  // Полуэллипсоид (купол башни Т-72, каска, голова)
  dome(cx, cy, z0, rx, ry, rz, m, rings = 4, n = 14, full = false) {
    const R = [];
    const k0 = full ? -rings : 0;
    for (let k = k0; k <= rings; k++) {
      const t = (k / rings) * (Math.PI / 2) * 0.999;
      const cr = Math.cos(t), z = z0 + Math.sin(t) * rz;
      const ring = [];
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; ring.push([cx + Math.cos(a) * rx * cr, cy + Math.sin(a) * ry * cr]); }
      R.push([z, ring]);
    }
    return this.loft(R, m, m, !full);
  }

  // Брус вдоль отрезка p0→p1 (ствол пулемёта, антенна, рука, нога): ширина w, толщина h
  seg(p0, p1, w, h, m, m2 = m) {
    const d = norm([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]);
    let up = Math.abs(d[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
    const s = norm([d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]]);
    up = [s[1] * d[2] - s[2] * d[1], s[2] * d[0] - s[0] * d[2], s[0] * d[1] - s[1] * d[0]];
    const c = (p, a, b) => [p[0] + s[0] * a + up[0] * b, p[1] + s[1] * a + up[1] * b, p[2] + s[2] * a + up[2] * b];
    const W = w / 2, H = h / 2;
    const q = [c(p0, -W, -H), c(p0, W, -H), c(p0, W, H), c(p0, -W, H), c(p1, -W, -H), c(p1, W, -H), c(p1, W, H), c(p1, -W, H)];
    return this.part([
      { v: [q[0], q[1], q[2], q[3]], m: m2 }, { v: [q[4], q[5], q[6], q[7]], m: m2 },
      { v: [q[0], q[1], q[5], q[4]], m }, { v: [q[1], q[2], q[6], q[5]], m },
      { v: [q[2], q[3], q[7], q[6]], m }, { v: [q[3], q[0], q[4], q[7]], m },
    ]);
  }

  // Плоская пластина (двусторонняя: нормаль к зрителю задаём явно)
  plate(pts, m, n = [0, 0, 1]) {
    return this.part([{ v: pts, m, nHint: norm(n) }]);
  }

  // Перенести/повернуть все детали (для сборки из узлов)
  static transform(model, dx, dy, dz, rot = 0) {
    const c = Math.cos(rot), s = Math.sin(rot);
    for (const faces of model.parts)
      for (const f of faces) {
        for (const p of f.v) {
          const x = p[0] * c - p[1] * s, y = p[0] * s + p[1] * c;
          p[0] = x + dx; p[1] = y + dy; p[2] += dz;
        }
        const n = f.n; const x = n[0] * c - n[1] * s, y = n[0] * s + n[1] * c;
        f.n = [x, y, n[2]];
      }
    return model;
  }
  merge(other) { for (const p of other.parts) this.parts.push(p); return this; }
}

// ---------- Растеризация ----------
const AMB = 0.5, DIF = 0.62, SKY = 0.12;
const SS = 2; // суперсэмплинг

// Рендер модели под углом angle (рад) с масштабом ppm (пикс/м итогового спрайта).
// opts.shadowZ — плоскость тени (0 — земля; для башни — крыша корпуса); opts.shadow=false — без тени
export function renderModel(model, angle, ppm, opts = {}) {
  const S = ppm * SS;
  const c = Math.cos(angle), s = Math.sin(angle);
  const shadowZ = opts.shadowZ ?? 0;
  const withShadow = opts.shadow !== false;
  const clipZ = opts.clipZ ?? -1e9; // ниже — не рисуем (боец в окопе)
  // 1) Преобразование вершин, границы
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  const faces = [];
  for (const part of model.parts)
    for (const f of part) {
      const pts = f.v.map((p) => {
        const xr = p[0] * c - p[1] * s, yr = p[0] * s + p[1] * c;
        const X = xr, Y = yr - p[2] * K3;
        if (X < minX) minX = X; if (X > maxX) maxX = X;
        if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
        return [X, Y, yr * K3 + p[2], p[0], p[1], p[2], xr, yr];
      });
      const n = f.n;
      const nw = [n[0] * c - n[1] * s, n[0] * s + n[1] * c, n[2]];
      faces.push({ pts, f, nw });
    }
  // Тень: проекция всех граней на плоскость shadowZ вдоль солнца
  const shadowPolys = [];
  if (withShadow) {
    for (const F of faces) {
      const poly = F.pts.map((q) => {
        const t = (Math.max(q[5], clipZ) - shadowZ) / SUN[2];
        const gx = q[6] - SUN[0] * t, gy = q[7] - SUN[1] * t;
        const X = gx, Y = gy - shadowZ * K3;
        if (X < minX) minX = X; if (X > maxX) maxX = X;
        if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
        return [X, Y];
      });
      shadowPolys.push(poly);
    }
  }
  const pad = 3 / ppm;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const W = Math.max(2, Math.ceil((maxX - minX) * S)), H = Math.max(2, Math.ceil((maxY - minY) * S));
  const col = new Uint8ClampedArray(W * H * 4);
  const zb = new Float32Array(W * H).fill(-1e9);
  const fid = new Int32Array(W * H).fill(-1);
  const out = [0, 0, 0];
  // 2) Грани
  for (let fi = 0; fi < faces.length; fi++) {
    const F = faces[fi];
    const nw = F.nw;
    if (nw[0] * VIEW[0] + nw[1] * VIEW[1] + nw[2] * VIEW[2] <= 0.002) continue; // тыльная
    const m = F.f.m;
    const lam = Math.max(0, nw[0] * SUN[0] + nw[1] * SUN[1] + nw[2] * SUN[2]);
    let shade = AMB + DIF * lam + SKY * Math.max(0, nw[2]);
    let spec = 0;
    if (m.spec) {
      // отражение солнца к зрителю
      const d = 2 * (nw[0] * SUN[0] + nw[1] * SUN[1] + nw[2] * SUN[2]);
      const r = [d * nw[0] - SUN[0], d * nw[1] - SUN[1], d * nw[2] - SUN[2]];
      spec = Math.pow(Math.max(0, r[0] * VIEW[0] + r[1] * VIEW[1] + r[2] * VIEW[2]), 12) * m.spec * 255;
    }
    const P = F.pts.map((q) => [(q[0] - minX) * S, (q[1] - minY) * S, q[2], q[3], q[4], q[5]]);
    for (let t = 1; t < P.length - 1; t++) raster(P[0], P[t], P[t + 1], W, H, col, zb, fid, fi, m, shade, spec, nw, out, clipZ);
  }
  // 3) Контуры: силуэт и перепады глубины
  const dark = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (fid[i] < 0) continue;
      let k = 1;
      for (const j of [x + 1 < W ? i + 1 : -1, x > 0 ? i - 1 : -1, y + 1 < H ? i + W : -1, y > 0 ? i - W : -1]) {
        if (j < 0 || fid[j] < 0) { k = Math.min(k, 0.5); continue; }
        if (fid[j] !== fid[i]) {
          if (zb[j] - zb[i] > 0.06) k = Math.min(k, 0.55); // мы дальше — контур окклюзии
          else k = Math.min(k, 0.9); // ребро
        }
      }
      dark[i] = k;
    }
  // 4) Сжатие SS×SS
  const w = Math.ceil(W / SS), h = Math.ceil(H / SS);
  const img = new ImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const X = x * SS + sx, Y = y * SS + sy;
          if (X >= W || Y >= H) continue;
          const i = Y * W + X;
          if (fid[i] < 0) continue;
          const k = dark[i];
          r += col[i * 4] * k; g += col[i * 4 + 1] * k; b += col[i * 4 + 2] * k; a++;
        }
      const o = (y * w + x) * 4;
      if (a) { d[o] = r / a; d[o + 1] = g / a; d[o + 2] = b / a; d[o + 3] = (a / (SS * SS)) * 255; }
    }
  const cnv = mkCanvas(w, h);
  const g2 = cnv.getContext('2d');
  if (withShadow && shadowPolys.length) {
    const sc = mkCanvas(w, h);
    const sg = sc.getContext('2d');
    sg.fillStyle = '#000';
    // каждую грань — отдельно: встречные контуры (оболочка градирни, полые формы) не вычитаются
    for (const poly of shadowPolys) {
      sg.beginPath();
      poly.forEach(([X, Y], i) => { const px = (X - minX) * ppm, py = (Y - minY) * ppm; i ? sg.lineTo(px, py) : sg.moveTo(px, py); });
      sg.closePath();
      sg.fill();
    }
    g2.globalAlpha = opts.shadowAlpha ?? 0.42;
    g2.filter = `blur(${Math.max(0.6, ppm * 0.05)}px)`;
    g2.drawImage(sc, 0, 0);
    g2.filter = 'none';
    g2.globalAlpha = 1;
  }
  const mc = mkCanvas(w, h);
  mc.getContext('2d').putImageData(img, 0, 0);
  g2.drawImage(mc, 0, 0);
  return { canvas: cnv, ox: -minX * ppm, oy: -minY * ppm, w, h, ppm };
}

function raster(a, b, c2, W, H, col, zb, fid, fi, m, shade, spec, nw, out, clipZ) {
  const area = (b[0] - a[0]) * (c2[1] - a[1]) - (b[1] - a[1]) * (c2[0] - a[0]);
  if (Math.abs(area) < 1e-6) return;
  const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c2[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c2[0])));
  const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c2[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c2[1])));
  const inv = 1 / area;
  const base = m.c;
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      let w0 = ((b[0] - px) * (c2[1] - py) - (b[1] - py) * (c2[0] - px)) * inv;
      let w1 = ((c2[0] - px) * (a[1] - py) - (c2[1] - py) * (a[0] - px)) * inv;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
      const D = w0 * a[2] + w1 * b[2] + w2 * c2[2];
      const i = y * W + x;
      if (D <= zb[i]) continue;
      const mz = w0 * a[5] + w1 * b[5] + w2 * c2[5];
      if (mz < clipZ) continue;
      zb[i] = D; fid[i] = fi;
      out[0] = base[0]; out[1] = base[1]; out[2] = base[2];
      if (m.fn) m.fn(out, w0 * a[3] + w1 * b[3] + w2 * c2[3], w0 * a[4] + w1 * b[4] + w2 * c2[4], mz, nw);
      let k = shade;
      if (m.ao) k *= 0.72 + 0.28 * Math.min(1, Math.max(0, mz) / 0.7); // затенение у земли
      const o = i * 4;
      col[o] = out[0] * k + spec + m.glow; col[o + 1] = out[1] * k + spec + m.glow; col[o + 2] = out[2] * k + spec + m.glow * 0.8;
    }
  }
}

function mkCanvas(w, h) {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return new OffscreenCanvas(w, h);
}

// ---------- Кэш спрайтов с бюджетом генерации ----------
const LODS = [7, 14, 28];
const cache = new Map();
const models = new Map();
let budgetMs = 0, budgetFrame = -1;

// build: () => Model; key — уникальное имя модели
export function getModel(key, build) {
  let m = models.get(key);
  if (!m) { m = build(); models.set(key, m); }
  return m;
}

export function lodFor(zoomPx) {
  for (const l of LODS) if (l >= zoomPx * 0.9) return l;
  return LODS[LODS.length - 1];
}

// Спрайт ракурса; если бюджет кадра исчерпан — ближайший готовый (или null)
export function spriteFor(key, build, angle, zoomPx, opts, frameNo) {
  if (frameNo !== budgetFrame) { budgetFrame = frameNo; budgetMs = 0; }
  const NA = opts?.angles || ANGLES;
  const step = (Math.PI * 2) / NA;
  let ai = Math.round(angle / step) % NA;
  if (ai < 0) ai += NA;
  const lod = Math.min(lodFor(zoomPx), opts?.maxLod || 99);
  const k = `${key}|${lod}|${ai}`;
  let s = cache.get(k);
  if (!s) {
    if (budgetMs < 7) {
      const t0 = performance.now();
      s = renderModel(getModel(key, build), ai * step, lod, opts);
      s.ai = ai;
      budgetMs += performance.now() - t0;
      cache.set(k, s);
    } else {
      // запасной: тот же угол другого LOD или соседний угол
      for (const l of LODS) { s = cache.get(`${key}|${l}|${ai}`); if (s) break; }
      for (let d = 1; !s && d <= NA / 2; d++)
        for (const l of [lod, ...LODS]) {
          s = cache.get(`${key}|${l}|${(ai + d) % NA}`) || cache.get(`${key}|${l}|${(ai - d + NA) % NA}`);
          if (s) break;
        }
      if (!s) return null;
    }
  }
  let res = angle - s.ai * step;
  res = Math.atan2(Math.sin(res), Math.cos(res));
  return { s, residual: res };
}

// Нарисовать спрайт: (sx, sy) — экранная точка начала координат модели (на земле), z — пикс/м
export function drawSprite(ctx, r, sx, sy, z, residual) {
  const s = r.s;
  const k = z / s.ppm;
  ctx.save();
  ctx.translate(sx, sy);
  if (residual) ctx.rotate(residual);
  ctx.drawImage(s.canvas, -s.ox * k, -s.oy * k, s.w * k, s.h * k);
  ctx.restore();
}
