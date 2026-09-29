// Геометрические утилиты. Точки — массивы [x, y] в метрах.

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerp = (a, b, t) => a + (b - a) * t;

export function bboxOf(points, pad = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

export const bboxIntersects = (a, b) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;

// Сглаживание ломаной сплайном Катмулла — Рома
export function catmullRom(pts, samples = 8) {
  if (pts.length < 3) return pts.slice();
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let s = 0; s < samples; s++) {
      const t = s / samples;
      const t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(pts[pts.length - 1].slice());
  return out;
}

export function polyLength(line) {
  let L = 0;
  for (let i = 1; i < line.length; i++) L += dist(line[i - 1], line[i]);
  return L;
}

// Равномерная передискретизация ломаной с шагом step
export function resample(line, step) {
  const out = [line[0].slice()];
  let carry = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const seg = dist(a, b);
    let d = step - carry;
    while (d <= seg) {
      const t = d / seg;
      out.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t)]);
      d += step;
    }
    carry = seg - (d - step);
  }
  const last = line[line.length - 1];
  if (dist(out[out.length - 1], last) > step * 0.3) out.push(last.slice());
  return out;
}

// Касательные (единичные) в вершинах ломаной
export function tangents(line) {
  const t = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)];
    const b = line[Math.min(line.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    t.push([dx / L, dy / L]);
  }
  return t;
}

// Смещение ломаной вбок на d метров (влево по ходу — отрицательное)
export function offsetLine(line, d) {
  const tg = tangents(line);
  return line.map((p, i) => [p[0] - tg[i][1] * d, p[1] + tg[i][0] * d]);
}

export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function distToLine(px, py, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const d = distToSegment(px, py, line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]);
    if (d < best) best = d;
  }
  return best;
}

// Прямоугольник с поворотом → 4 угла
export function rectCorners(cx, cy, w, h, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const hw = w / 2, hh = h / 2;
  return [
    [cx + -hw * c - -hh * s, cy + -hw * s + -hh * c],
    [cx + hw * c - -hh * s, cy + hw * s + -hh * c],
    [cx + hw * c - hh * s, cy + hw * s + hh * c],
    [cx + -hw * c - hh * s, cy + -hw * s + hh * c],
  ];
}

// Замкнутый «пузырь» — эллипс с шумовым радиусом
export function blob(cx, cy, rx, ry, angle, rng, n = 48, wobble = 0.18) {
  const phases = [rng.float(0, 6.28), rng.float(0, 6.28), rng.float(0, 6.28)];
  const pts = [];
  const c = Math.cos(angle), s = Math.sin(angle);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + wobble * (0.5 * Math.sin(a * 2 + phases[0]) + 0.3 * Math.sin(a * 3 + phases[1]) + 0.2 * Math.sin(a * 5 + phases[2]));
    const x = Math.cos(a) * rx * k, y = Math.sin(a) * ry * k;
    pts.push([cx + x * c - y * s, cy + x * s + y * c]);
  }
  return pts;
}
