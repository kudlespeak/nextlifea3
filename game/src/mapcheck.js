// Проверка и починка карты «Войны дронов» после генерации: дома на дорогах и в воде, дома друг
// на друге, поля поперёк дорог и внахлёст, деревья на асфальте и в домах. Работает одинаково в
// основном потоке и в воркере рендера (оба строят мир из seed), поэтому индексы зданий совпадают.

import { SpatialIndex, M } from './spatial.js';
import { bboxOf, pointInPoly, distToLine } from './geom.js';

function convexOverlap(A, B) {
  for (const P of [A, B])
    for (let i = 0; i < P.length; i++) {
      const p = P[i], q = P[(i + 1) % P.length];
      const nx = q[1] - p[1], ny = p[0] - q[0];
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [x, y] of A) { const d = x * nx + y * ny; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
      for (const [x, y] of B) { const d = x * nx + y * ny; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
      if (a1 <= b0 + 0.5 || b1 <= a0 + 0.5) return false;
    }
  return true;
}

function rebuild(world, key, keep) {
  const old = world[key];
  const idx = new SpatialIndex(world.W, world.H, old.cell);
  for (const it of old.items) if (keep(it)) idx.insert(it);
  world[key] = idx;
}

// Дорога на отрезке: ближе половины ширины (с запасом)
function onRoad(world, x, y, pad) {
  if (!world.mask.has(x, y, M.ROAD)) return null;
  for (const r of world.roads.query({ x0: x - 30, y0: y - 30, x1: x + 30, y1: y + 30 }))
    if (nearLine(x, y, r.line, r.width / 2 + pad)) return r;
  return null;
}
// Ближе d к ломаной? (отрезки вне рамки пропускаем — дороги бывают длиной в десятки км)
function nearLine(x, y, line, d) {
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    if (Math.min(a[0], b[0]) - d > x || Math.max(a[0], b[0]) + d < x || Math.min(a[1], b[1]) - d > y || Math.max(a[1], b[1]) + d < y) continue;
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)) : 0;
    if (Math.hypot(a[0] + dx * t - x, a[1] + dy * t - y) < d) return true;
  }
  return false;
}

const ROUND = (b) => b.style === 'silo' || !b.w || !b.h;
// дворовая мелочь (поленница, колодец, будка) может стоять вплотную к сараю — это не ошибка
const SMALL = (b) => b.w * b.h < 30 || b.style === 'woodpile' || b.style === 'well';

// Находит проблемы; с fix=true — исправляет (убирает лишнее). Возвращает счётчики.
export function checkWorld(world, fix = false) {
  const out = { buildingRoad: 0, buildingWater: 0, buildingOverlap: 0, fieldRoad: 0, fieldOverlap: 0, treeRoad: 0, treeBuilding: 0 };
  const { mask } = world;
  // ---- здания ----
  const dropB = new Set();
  for (const b of world.buildings.items) {
    if (!b.poly) continue;
    const pts = [[b.x, b.y], ...b.poly];
    if (pts.some(([x, y]) => onRoad(world, x, y, -0.5))) { out.buildingRoad++; dropB.add(b); continue; }
    if (pts.filter(([x, y]) => mask.has(x, y, M.WATER)).length >= 3) { out.buildingWater++; dropB.add(b); continue; }
  }
  for (const b of world.buildings.items) {
    if (dropB.has(b) || !b.poly || ROUND(b)) continue;
    for (const o of world.buildings.query(b.bbox)) {
      if (o === b || o._order < b._order || dropB.has(o) || !o.poly || ROUND(o) || (SMALL(b) && SMALL(o))) continue;
      if (convexOverlap(b.poly, o.poly)) { out.buildingOverlap++; dropB.add(o.w * o.h <= b.w * b.h ? o : b); if (dropB.has(b)) break; }
    }
  }
  // ---- поля ----
  const dropF = new Set();
  const fields = world.fields.items.filter((f) => f.kind === 'field' && !f.crop?.match?.(/^(dry|green|bare)$/));
  // дороги проходим один раз: точки через 10 м, для каждой — поля под ней
  const hits = new Map();
  for (const r of world.roads.items) {
    for (let i = 1; i < r.line.length; i++) {
      const a = r.line[i - 1], c = r.line[i], L = Math.hypot(c[0] - a[0], c[1] - a[1]);
      for (let t = 0; t < L; t += 10) {
        const x = a[0] + ((c[0] - a[0]) * t) / L, y = a[1] + ((c[1] - a[1]) * t) / L;
        for (const f of world.fields.query({ x0: x, y0: y, x1: x, y1: y })) {
          if (f.kind !== 'field' || f.crop?.match?.(/^(dry|green|bare)$/) || !pointInPoly(x, y, f.poly)) continue;
          if (distToLine(x, y, [...f.poly, f.poly[0]]) > r.width / 2 + 2) hits.set(f, (hits.get(f) || 0) + 1);
        }
      }
    }
  }
  for (const [f, n] of hits) if (n >= 3) { out.fieldRoad++; dropF.add(f); }
  for (const f of fields) {
    if (dropF.has(f)) continue;
    for (const o of world.fields.query(f.bbox)) {
      if (o === f || o._order < f._order || dropF.has(o) || o.kind !== 'field' || o.crop?.match?.(/^(dry|green|bare)$/)) continue;
      // внахлёст: заметная часть одного поля внутри другого
      const bb = bboxOf(o.poly, 0);
      let inside = 0, n = 0;
      for (let y = bb.y0 + 15; y < bb.y1; y += 40) for (let x = bb.x0 + 15; x < bb.x1; x += 40) if (pointInPoly(x, y, o.poly)) { n++; if (pointInPoly(x, y, f.poly)) inside++; }
      if (n && inside / n > 0.08) { out.fieldOverlap++; dropF.add(o); }
    }
  }
  // ---- деревья (радиус 0 — не рисуются) ----
  const keepB = world.buildings.items.filter((b) => !dropB.has(b) && b.poly);
  world.trees.forEach({ x0: 0, y0: 0, x1: world.W, y1: world.H }, (arr, i) => {
    const x = arr[i], y = arr[i + 1];
    if (!arr[i + 2]) return;
    if (!mask.has(x, y, M.ROAD | M.BUILD)) return;
    if (mask.has(x, y, M.ROAD) && onRoad(world, x, y, 0.5)) { out.treeRoad++; if (fix) arr[i + 2] = 0; return; }
    if (mask.has(x, y, M.BUILD)) for (const b of world.buildings.query({ x0: x, y0: y, x1: x, y1: y })) if (!dropB.has(b) && b.poly && pointInPoly(x, y, b.poly)) { out.treeBuilding++; if (fix) arr[i + 2] = 0; return; }
  });
  void keepB;
  if (fix) {
    if (dropB.size) rebuild(world, 'buildings', (b) => !dropB.has(b));
    if (dropF.size) rebuild(world, 'fields', (f) => !dropF.has(f));
  }
  out.total = Object.values(out).reduce((a, b) => a + b, 0);
  return out;
}
