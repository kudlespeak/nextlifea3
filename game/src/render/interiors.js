// Интерьеры: при сильном приближении крыша «снимается» и видна планировка —
// комнаты, стены, двери, окна, лестницы, погреба и подвалы.
// Также всегда показываем здания, где сидят свои бойцы.

import { SIDES } from '../sim/units.js';
import { pointInPoly } from '../geom.js';

const FLOOR = {
  'прихожая': '#8c8476', 'кухня': '#a19d92', 'комната': '#8d7353', 'спальня': '#86704f',
  'подъезд': '#8a8883', 'кабинет': '#8f7a5a', 'класс': '#937c58', 'коридор': '#8a877f',
  'цех': '#7f7d77', 'бытовка': '#8d8779', 'коровник': '#7b7160', 'гараж': '#6e6c67',
  'сарай': '#7a6c55', 'теплица': '#6f7d52',
};

export function drawInteriors(ctx, world, sim, view, force, underground) {
  const { cam, canvas, dpr } = view;
  const z = cam.zoom;
  const zc = z / dpr;
  const auto = Math.max(0, Math.min(1, (zc - 3.5) / 2));
  if (zc < 1.2) return;
  const hw = canvas.width / 2 / z, hh = canvas.height / 2 / z;
  const list = world.buildings.query({ x0: cam.x - hw, y0: cam.y - hh, x1: cam.x + hw, y1: cam.y + hh });
  // Здания, где стоят свои бойцы
  const occupied = new Set();
  for (const u of sim.units) if (u.soldiers) for (const s of u.soldiers) if (s.building) occupied.add(s.building);
  const toS = (x, y) => [(x - cam.x) * z + canvas.width / 2, (y - cam.y) * z + canvas.height / 2];
  const poly = (pts) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      const [sx, sy] = toS(x, y);
      i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
    });
    ctx.closePath();
  };
  const line = (a, b) => {
    const [ax, ay] = toS(a[0], a[1]), [bx, by] = toS(b[0], b[1]);
    ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
  };
  for (const b of list) {
    const it = b.interior;
    if (!it) continue;
    const alpha = force ? 1 : occupied.has(b) ? Math.max(auto, zc > 1.8 ? 1 : 0) : auto;
    if (alpha <= 0.01) continue;
    ctx.globalAlpha = alpha;
    // Полы
    poly(b.poly);
    ctx.fillStyle = '#6f6b62';
    ctx.fill();
    for (const r of it.rooms) {
      poly(r.poly);
      ctx.fillStyle = FLOOR[r.kind] || '#857c6c';
      ctx.fill();
      if (zc > 4 && (r.kind === 'комната' || r.kind === 'спальня' || r.kind === 'кухня')) drawFurniture(ctx, r, toS, z);
    }
    if (it.columns && zc > 2.5) {
      ctx.fillStyle = '#4b4944';
      for (const [x, y] of it.columns) {
        const [sx, sy] = toS(x, y);
        ctx.fillRect(sx - 0.25 * z, sy - 0.25 * z, 0.5 * z, 0.5 * z);
      }
    }
    // Лестницы и лазы
    for (const st of it.stairs) {
      const [sx, sy] = toS(st.p[0], st.p[1]);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(it.angle);
      const w = st.w * z, h = st.h * z;
      ctx.fillStyle = st.hatch ? '#4d3f2e' : '#9b988f';
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = Math.max(0.7, 0.04 * z);
      ctx.beginPath();
      if (st.hatch) { ctx.moveTo(-w / 2, -h / 2); ctx.lineTo(w / 2, h / 2); ctx.moveTo(w / 2, -h / 2); ctx.lineTo(-w / 2, h / 2); }
      else for (let y = -h / 2; y < h / 2; y += 0.28 * z) { ctx.moveTo(-w / 2, y); ctx.lineTo(w / 2, y); }
      ctx.stroke();
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      ctx.restore();
    }
    // Стены
    ctx.beginPath();
    for (const w of it.walls) if (!w.outer) line(w.a, w.b);
    ctx.strokeStyle = '#2f2c28';
    ctx.lineWidth = Math.max(1.2 * dpr, 0.18 * z);
    ctx.lineCap = 'square';
    ctx.stroke();
    ctx.beginPath();
    for (const w of it.walls) if (w.outer) line(w.a, w.b);
    ctx.lineWidth = Math.max(1.8 * dpr, 0.4 * z);
    ctx.stroke();
    // Окна
    ctx.beginPath();
    for (const w of it.windows) {
      const tx = -w.n[1] * w.w / 2, ty = w.n[0] * w.w / 2;
      line([w.p[0] - tx, w.p[1] - ty], [w.p[0] + tx, w.p[1] + ty]);
    }
    ctx.strokeStyle = '#a8d2e4';
    ctx.lineWidth = Math.max(1 * dpr, 0.16 * z);
    ctx.lineCap = 'butt';
    ctx.stroke();
    // Двери: створка дугой
    for (const d of it.doors) {
      if (zc < 2.5) break;
      const [sx, sy] = toS(d.p[0], d.p[1]);
      ctx.beginPath();
      ctx.arc(sx, sy, d.w * 0.5 * z, 0, Math.PI * 2);
      ctx.strokeStyle = d.ext ? 'rgba(255,230,160,0.8)' : 'rgba(40,35,30,0.55)';
      ctx.lineWidth = Math.max(0.8, 0.05 * z);
      ctx.setLineDash([2 * dpr, 2 * dpr]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Подвал: пунктиром в подземном слое или когда там сидят
    const bs = it.basement;
    if (bs && (underground || zc > 4)) {
      poly(bs.poly);
      ctx.strokeStyle = underground ? '#5fe3ff' : 'rgba(95,227,255,0.6)';
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([5 * dpr, 3 * dpr]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (underground && zc > 1.5) {
        const c = bs.access[0];
        const [sx, sy] = toS(c[0], c[1]);
        ctx.font = `600 ${10 * dpr}px "PT Sans", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#bff3ff';
        ctx.fillText(`${bs.kind} · до ${bs.capacity} чел.`, sx, sy - 6 * dpr);
      }
    }
    // Этажность
    if (it.floors > 1 && zc > 2.5) {
      const [sx, sy] = toS(b.x, b.y);
      ctx.font = `700 ${11 * dpr}px "PT Sans", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(`${it.floors} эт.`, sx, sy);
      ctx.fillStyle = '#f2eee2';
      ctx.fillText(`${it.floors} эт.`, sx, sy);
    }
  }
  ctx.globalAlpha = 1;
}

function drawFurniture(ctx, r, toS, z) {
  const [a, b, c] = r.poly;
  const ux = (b[0] - a[0]), uy = (b[1] - a[1]);
  const vx = (c[0] - b[0]), vy = (c[1] - b[1]);
  const at = (u, v) => toS(a[0] + ux * u + vx * v, a[1] + uy * u + vy * v);
  ctx.fillStyle = r.kind === 'кухня' ? '#c9c4b6' : '#b7a88e';
  const box = (u0, v0, u1, v1) => {
    const p = [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
    ctx.beginPath();
    p.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
  };
  if (r.kind === 'кухня') { box(0.05, 0.05, 0.95, 0.2); box(0.4, 0.45, 0.65, 0.7); }
  else if (r.kind === 'спальня') { box(0.1, 0.55, 0.45, 0.95); }
  else { box(0.6, 0.08, 0.95, 0.3); box(0.08, 0.6, 0.3, 0.92); }
}

// Здание под курсором (для приказов)
export function buildingAtScreen(world, view, sx, sy) {
  const { cam, canvas } = view;
  const x = cam.x + (sx - canvas.width / 2) / cam.zoom, y = cam.y + (sy - canvas.height / 2) / cam.zoom;
  for (const b of world.buildings.query({ x0: x - 0.5, y0: y - 0.5, x1: x + 0.5, y1: y + 0.5 }))
    if (b.interior && pointInPoly(x, y, b.poly)) return b;
  return null;
}
export { SIDES };
