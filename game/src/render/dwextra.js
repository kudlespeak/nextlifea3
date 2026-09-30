// Живость карты «Войны дронов» (только вид, на игру не влияет): поезда по расписанию, люди у
// магазинов и остановок, пыль за машинами на грунтовках, фары ночью, пожары на полях, временные
// обходы перебитых ЛЭП на время ремонта.

import { K3 } from './mesh3d.js';

const lineLen = (l) => { let s = 0; for (let i = 1; i < l.length; i++) s += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]); return s; };
function at(line, cum, s) {
  let i = 1;
  while (i < line.length - 1 && cum[i] < s) i++;
  const a = line[i - 1], b = line[i], L = cum[i] - cum[i - 1] || 1, t = Math.max(0, Math.min(1, (s - cum[i - 1]) / L));
  return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, h: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}
const hash = (i) => { const s = Math.sin(i * 127.1) * 43758.5453; return s - Math.floor(s); };

// ---------- Поезда ----------
// На каждой ветке два состава ходят туда-обратно; у разрушенного ж/д моста состав стоит
function railLines(g) {
  if (g._rails) return g._rails;
  const W = g.world;
  g._rails = W.rails.items.map((r, i) => {
    const line = r.line, cum = [0];
    for (let k = 1; k < line.length; k++) cum.push(cum[k - 1] + Math.hypot(line[k][0] - line[k - 1][0], line[k][1] - line[k - 1][1]));
    const bridges = g.objects.filter((o) => o.kind === 'bridge' && o.btype === 'rail').map((o) => {
      let bs = 0, bd = Infinity;
      for (let k = 0; k < line.length; k++) { const d = Math.hypot(line[k][0] - o.x, line[k][1] - o.y); if (d < bd) { bd = d; bs = cum[k]; } }
      return bd < 40 ? { o, s: bs } : null;
    }).filter(Boolean);
    return { line, cum, L: cum[cum.length - 1], bridges, seed: i + 1 };
  });
  return g._rails;
}
function drawTrains(ctx, g, toS, inView, z, dpr, t) {
  if (z < 0.05) return;
  for (const R of railLines(g)) {
    if (R.L < 2000) continue;
    for (let k = 0; k < 2; k++) {
      const v = 16, per = (2 * R.L) / v, ph = hash(R.seed * 3 + k) * per;
      let u = ((t + ph) % per) * v, fwd = true;
      if (u > R.L) { u = 2 * R.L - u; fwd = false; }
      // перед разрушенным мостом — стоянка
      for (const b of R.bridges) {
        if (!b.o.comps.some((c) => c.state === 'destroyed')) continue;
        if (fwd && u > b.s - 80 && u < b.s + 600) u = b.s - 80;
        if (!fwd && u < b.s + 80 && u > b.s - 600) u = b.s + 80;
      }
      const head = at(R.line, R.cum, u);
      if (!inView(head.x, head.y, 400)) continue;
      const n = 20, len = 14;
      for (let w = n - 1; w >= 0; w--) {
        const s = fwd ? u - w * (len + 1) : u + w * (len + 1);
        if (s < 0 || s > R.L) continue;
        const p = at(R.line, R.cum, s), [sx, sy] = toS(p.x, p.y);
        const L = Math.max(1.5 * dpr, len * z), Wd = Math.max(1 * dpr, 3.2 * z);
        ctx.save(); ctx.translate(sx, sy); ctx.rotate(p.h + (fwd ? 0 : Math.PI));
        if (z > 0.4) { ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(-L / 2 + 1.2 * z, -Wd / 2 + 1.4 * z, L, Wd); }
        const kind = w === 0 ? 'loco' : hash(R.seed * 31 + k * 7 + w) < 0.55 ? 'hopper' : hash(R.seed + w) < 0.5 ? 'tank' : 'box';
        ctx.fillStyle = kind === 'loco' ? (head.x < g.world.W / 2 ? '#2f4f7a' : '#6a2a24') : kind === 'hopper' ? '#a8905a' : kind === 'tank' ? '#3a3a38' : '#6b4a32';
        ctx.fillRect(-L / 2, -Wd / 2, L, Wd);
        if (z > 1 && kind === 'hopper') { ctx.fillStyle = 'rgba(0,0,0,0.25)'; for (let q = 1; q < 4; q++) ctx.fillRect(-L / 2 + (L * q) / 4 - 0.2 * z, -Wd / 2, 0.4 * z, Wd); }
        if (z > 1 && kind === 'loco') { ctx.fillStyle = '#e8e4d8'; ctx.fillRect(L / 2 - 2 * z, -Wd / 2, 1.2 * z, Wd); }
        ctx.restore();
      }
    }
  }
}

// ---------- Люди у магазинов, АЗС, ТЦ и на остановках ----------
function drawPeople(ctx, g, toS, inView, z, dpr, t, day) {
  if (z < 2.2 || day < 0.25) return;
  const spots = [];
  for (const o of g.objects) {
    if (!['store', 'fuel', 'market', 'mall'].includes(o.kind) || o.comps.every((c) => c.state === 'destroyed')) continue;
    if (!inView(o.x, o.y, 60)) continue;
    const gp = o.gate || [o.x, o.y];
    spots.push({ x: (o.x + gp[0]) / 2, y: (o.y + gp[1]) / 2, n: o.kind === 'mall' ? 10 : o.kind === 'market' ? 6 : 3, r: o.kind === 'mall' ? 18 : 7, id: o.id });
  }
  for (const s of g.world.stops || []) if (inView(s.x, s.y, 30)) spots.push({ x: s.x - s.ty * s.side * (s.w + 5.5), y: s.y + s.tx * s.side * (s.w + 5.5), n: 2 + Math.floor(hash(s.x) * 3), r: 2.5, id: s.x | 0 });
  const cols = ['#3b4a6b', '#6b3b3b', '#2f5a3a', '#7a6a4a', '#4a4a4a', '#8a4f6a'];
  for (const s of spots)
    for (let k = 0; k < s.n; k++) {
      const hsh = hash(s.id * 17 + k), a = t * 0.05 * (hsh - 0.5) + hsh * 6.28;
      const x = s.x + Math.cos(a) * s.r * (0.3 + hsh * 0.7), y = s.y + Math.sin(a * 1.3) * s.r * 0.5;
      const [sx, sy] = toS(x, y), r = Math.max(0.9 * dpr, 0.28 * z);
      ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(sx + r * 1.2, sy + r * 0.6, r * 1.3, r * 0.6, 0.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = cols[Math.floor(hsh * cols.length)]; ctx.beginPath(); ctx.ellipse(sx, sy - r * 1.3, r, r * 1.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#d8b89a'; ctx.beginPath(); ctx.arc(sx, sy - r * 3.1, r * 0.7, 0, Math.PI * 2); ctx.fill();
    }
}

// ---------- Пыль за машинами на грунтовках и щебёнке ----------
const puffs = [];
const roadType = new Map();
function surfaceAt(world, v, t) {
  const c = roadType.get(v);
  if (c && t - c.t < 3) return c.dusty;
  let best = null, bd = 12;
  for (const r of world.roads.query({ x0: v.x - 12, y0: v.y - 12, x1: v.x + 12, y1: v.y + 12 }, false)) {
    for (let i = 1; i < r.line.length; i++) {
      const a = r.line[i - 1], b = r.line[i], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
      const u = Math.max(0, Math.min(1, ((v.x - a[0]) * dx + (v.y - a[1]) * dy) / L2)), d = Math.hypot(a[0] + dx * u - v.x, a[1] + dy * u - v.y);
      if (d < bd) { bd = d; best = r; }
    }
  }
  const dusty = !best || best.type === 'dirt' || (best.type === 'village' && !world.mask.has(v.x, v.y, 128 | 64));
  roadType.set(v, { t, dusty });
  return dusty;
}
function drawDust(ctx, g, vehicles, toS, inView, z, dpr, now, season) {
  if (z < 0.4 || season === 'winter') { puffs.length = 0; return; }
  for (const v of vehicles) {
    if (!inView(v.x, v.y, 30) || v.pause > 0 || v.state === 'work') continue;
    const last = v._dustT || 0;
    if (now - last < 180) continue;
    if (v._lx !== undefined && Math.hypot(v.x - v._lx, v.y - v._ly) < 0.5) { v._lx = v.x; v._ly = v.y; continue; }
    v._lx = v.x; v._ly = v.y; v._dustT = now;
    if (!surfaceAt(g.world, v, now / 1000)) continue;
    const h = v.heading || 0;
    puffs.push({ x: v.x - Math.cos(h) * 3, y: v.y - Math.sin(h) * 3, t: now });
  }
  while (puffs.length > 500) puffs.shift();
  for (let i = puffs.length - 1; i >= 0; i--) {
    const p = puffs[i], age = (now - p.t) / 3000;
    if (age >= 1) { puffs.splice(i, 1); continue; }
    if (!inView(p.x, p.y, 20)) continue;
    const [sx, sy] = toS(p.x, p.y);
    ctx.fillStyle = `rgba(176,158,120,${0.35 * (1 - age)})`;
    ctx.beginPath(); ctx.arc(sx, sy - age * 3 * z, Math.max(1.5 * dpr, (2 + age * 6) * z), 0, Math.PI * 2); ctx.fill();
  }
}

// ---------- Фары ----------
function drawHeadlights(ctx, vehicles, toS, inView, z, dpr, night) {
  if (night < 0.35 || z < 0.35) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const v of vehicles) {
    if (!inView(v.x, v.y, 40) || v.wreck || v.gone) continue;
    const h = v.heading || 0, c = Math.cos(h), s = Math.sin(h);
    const [ax, ay] = toS(v.x + c * 2.2, v.y + s * 2.2);
    const D = 26, Sp = 9;
    const [bx, by] = toS(v.x + c * D - s * Sp, v.y + s * D + c * Sp), [cx, cy] = toS(v.x + c * D + s * Sp, v.y + s * D - c * Sp);
    const gr = ctx.createRadialGradient(ax, ay, 0, ax, ay, D * z);
    gr.addColorStop(0, `rgba(255,240,200,${0.35 * night})`); gr.addColorStop(1, 'rgba(255,240,200,0)');
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fill();
    if (z > 0.8) { const [tx, ty] = toS(v.x - c * 2.3, v.y - s * 2.3); ctx.fillStyle = `rgba(255,60,40,${0.8 * night})`; ctx.beginPath(); ctx.arc(tx, ty, Math.max(1, 0.35 * z), 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}

// ---------- Пожары на полях ----------
function drawFieldFires(ctx, g, toS, inView, z, dpr, now, fireFn) {
  for (const f of g.fieldFires || []) {
    if (!inView(f.x, f.y, f.r * 2 + 100)) continue;
    const [sx, sy] = toS(f.x, f.y);
    // выгорающее пятно и кромка огня по кругу
    ctx.fillStyle = 'rgba(28,22,16,0.55)';
    ctx.beginPath(); ctx.ellipse(sx, sy, f.r * z, f.r * 0.8 * z, 0.3, 0, Math.PI * 2); ctx.fill();
    const n = Math.max(5, Math.round(f.r / 5));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + hash(f.x + k) * 0.4;
      fireFn(ctx, toS, f.x + Math.cos(a) * f.r, f.y + Math.sin(a) * f.r * 0.8, 3, z, now, false, hash(f.y + k));
    }
  }
}

// ---------- Временный обход перебитой ЛЭП на время ремонта ----------
// Бригада ставит лёгкие деревянные опоры в стороне от разрушенной, провода висят низко
function drawBypass(ctx, g, toS, inView, z, dpr) {
  if (z < 0.3) return;
  for (const l of g.lines) {
    if (!l.cut || !l.repair || !l.pylons) continue;
    if (!inView(l.cut.x, l.cut.y, 300)) continue;
    const P = l.pylons;
    let k = 0, bd = Infinity;
    P.forEach((p, i) => { const d = Math.hypot(p.x - l.cut.x, p.y - l.cut.y); if (d < bd) { bd = d; k = i; } });
    const a = P[Math.max(0, k - 1)], b = P[Math.min(P.length - 1, k + 1)];
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
    const pts = [a, { x: P[k].x + nx * 35, y: P[k].y + ny * 35 }, b];
    const H = 10;
    ctx.strokeStyle = 'rgba(40,40,38,0.85)'; ctx.lineWidth = Math.max(0.6, 0.25 * z);
    ctx.beginPath();
    pts.forEach((p, i) => { const [sx, sy] = toS(p.x, p.y); if (i) ctx.lineTo(sx, sy - H * K3 * z); else ctx.moveTo(sx, sy - H * K3 * z); });
    ctx.stroke();
    // временные опоры (деревянные «стойки»)
    ctx.strokeStyle = '#6b4f33'; ctx.lineWidth = Math.max(1, 0.5 * z);
    for (const p of [pts[1], { x: (a.x + pts[1].x) / 2, y: (a.y + pts[1].y) / 2 }, { x: (b.x + pts[1].x) / 2, y: (b.y + pts[1].y) / 2 }]) {
      const [sx, sy] = toS(p.x, p.y);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx, sy - H * K3 * z); ctx.stroke();
    }
  }
}

// ---------- Погода на экране: тени облаков, туман, дождь ----------
function drawWeather(ctx, g, view, toS, now, t) {
  const kind = g.weather?.kind || 'clear';
  const { canvas, cam, dpr } = view, W = canvas.width, H = canvas.height, z = cam.zoom;
  if (kind === 'cloud' || kind === 'rain') {
    // тени облаков плывут по ветру (в мировых координатах, 1,5 км)
    const dir = g.weather?.dir || 0, drift = t * 6, S = 1500;
    const ox = Math.cos(dir) * drift, oy = Math.sin(dir) * drift;
    const x0 = cam.x - W / 2 / z - S, y0 = cam.y - H / 2 / z - S, x1 = cam.x + W / 2 / z + S, y1 = cam.y + H / 2 / z + S;
    ctx.fillStyle = `rgba(20,24,30,${kind === 'rain' ? 0.16 : 0.1})`;
    for (let gx = Math.floor((x0 - ox) / S); gx <= (x1 - ox) / S; gx++)
      for (let gy = Math.floor((y0 - oy) / S); gy <= (y1 - oy) / S; gy++) {
        if (hash(gx * 131 + gy * 17) > 0.55) continue;
        const cx = gx * S + ox + hash(gx + gy * 7) * S * 0.5, cy = gy * S + oy + hash(gy + gx * 3) * S * 0.5;
        const [sx, sy] = toS(cx, cy), r = S * (0.35 + hash(gx * gy + 5) * 0.3) * z;
        ctx.beginPath(); ctx.ellipse(sx, sy, r, r * 0.6, hash(gx - gy) * 3, 0, Math.PI * 2); ctx.fill();
      }
  }
  if (kind === 'fog') {
    const gr = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.15, W / 2, H / 2, Math.max(W, H) * 0.7);
    gr.addColorStop(0, 'rgba(210,214,216,0.18)'); gr.addColorStop(1, 'rgba(210,214,216,0.5)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
  }
  if (kind === 'rain') {
    ctx.strokeStyle = 'rgba(200,210,225,0.28)'; ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    const n = Math.round((W * H) / (9000 * dpr * dpr));
    for (let k = 0; k < n; k++) {
      const x = (hash(k * 3.1) * W + now * 0.05) % W, y = (hash(k * 7.7) * H + now * 0.9) % H;
      ctx.moveTo(x, y); ctx.lineTo(x - 3 * dpr, y + 12 * dpr);
    }
    ctx.stroke();
  }
}

export function drawExtras(ctx, g, sim, view, side, toS, inView, now, t, night, fireFn) {
  const { cam, dpr } = view, z = cam.zoom;
  drawTrains(ctx, g, toS, inView, z, dpr, t);
  const vehicles = [...g.visibleVehicles(side).filter((v) => !v.wreck), ...(g._traffic?.cars || []).filter((c) => !c.gone)];
  drawDust(ctx, g, vehicles, toS, inView, z, dpr, now, g.world.season);
  drawPeople(ctx, g, toS, inView, z, dpr, t, 1 - night);
  drawFieldFires(ctx, g, toS, inView, z, dpr, now, fireFn);
  drawBypass(ctx, g, toS, inView, z, dpr);
  drawHeadlights(ctx, vehicles, toS, inView, z, dpr, night);
}
// погода — поверх всего кадра (вызывается в конце отрисовки)
export function drawWeatherLayer(ctx, g, view, now, t) {
  const { cam, canvas } = view, z = cam.zoom;
  const toS = (x, y) => [(x - cam.x) * z + canvas.width / 2, (y - cam.y) * z + canvas.height / 2];
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawWeather(ctx, g, view, toS, now, t);
  ctx.restore();
}
void lineLen;
