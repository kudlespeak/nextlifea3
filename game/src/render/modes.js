// Линия фронта, серая зона, зоны интереса.

import { FACTIONS } from '../sim/factions.js';

let tint = null, tintVer = -1, lines = [];

function buildTint(g) {
  tint = tint || document.createElement('canvas');
  tint.width = g.w; tint.height = g.h;
  const t = tint.getContext('2d');
  const img = t.createImageData(g.w, g.h);
  for (let i = 0; i < g.c.length; i++) {
    const v = g.c[i];
    const k = i * 4;
    if (Math.abs(v) < 0.3) { img.data[k] = 150; img.data[k + 1] = 150; img.data[k + 2] = 140; img.data[k + 3] = 55; }
    else if (v < 0) { img.data[k] = 80; img.data[k + 1] = 140; img.data[k + 2] = 255; img.data[k + 3] = 26; }
    else { img.data[k] = 255; img.data[k + 1] = 90; img.data[k + 2] = 80; img.data[k + 3] = 26; }
  }
  t.putImageData(img, 0, 0);
  // Линия фронта: изолиния c = 0 (марширующие квадраты)
  lines = [];
  const at = (ix, iy) => g.c[iy * g.w + ix];
  for (let iy = 0; iy < g.h - 1; iy++)
    for (let ix = 0; ix < g.w - 1; ix++) {
      const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix + 1, iy + 1), d = at(ix, iy + 1);
      const pts = [];
      const e = (v0, v1, x0, y0, x1, y1) => { const t2 = v0 / (v0 - v1); pts.push([(x0 + (x1 - x0) * t2 + 0.5) * g.cell, (y0 + (y1 - y0) * t2 + 0.5) * g.cell]); };
      if ((a < 0) !== (b < 0)) e(a, b, ix, iy, ix + 1, iy);
      if ((b < 0) !== (c < 0)) e(b, c, ix + 1, iy, ix + 1, iy + 1);
      if ((c < 0) !== (d < 0)) e(c, d, ix + 1, iy + 1, ix, iy + 1);
      if ((d < 0) !== (a < 0)) e(d, a, ix, iy + 1, ix, iy);
      if (pts.length >= 2) {
        // Нормаль к «красной» стороне — по градиенту поля
        const gx = (b + c - a - d) / 2, gy = (c + d - a - b) / 2;
        const L = Math.hypot(gx, gy) || 1;
        lines.push([pts[0], pts[1], gx / L, gy / L]);
        if (pts.length === 4) lines.push([pts[2], pts[3], gx / L, gy / L]);
      }
    }
  tintVer = g.version;
}

export function drawFront(ctx, game, view) {
  const g = game?.grid;
  if (!g) return;
  if (tintVer !== g.version || !tint) buildTint(g);
  const { cam, canvas, dpr } = view;
  const z = cam.zoom;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  const x0 = (0 - cam.x) * z + canvas.width / 2, y0 = (0 - cam.y) * z + canvas.height / 2;
  ctx.drawImage(tint, x0, y0, g.w * g.cell * z, g.h * g.cell * z);
  const toS = (x, y) => [(x - cam.x) * z + canvas.width / 2, (y - cam.y) * z + canvas.height / 2];
  const off = 2.2 * dpr;
  ctx.lineCap = 'round';
  for (const pass of [0, 1, 2]) {
    ctx.beginPath();
    for (const [a, b, nx, ny] of lines) {
      const [ax, ay] = toS(a[0], a[1]), [bx, by] = toS(b[0], b[1]);
      const o = pass === 1 ? -off : pass === 2 ? off : 0;
      ctx.moveTo(ax + nx * o, ay + ny * o);
      ctx.lineTo(bx + nx * o, by + ny * o);
    }
    if (pass === 0) { ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 7 * dpr; }
    else if (pass === 1) { ctx.strokeStyle = FACTIONS.blue.fill; ctx.lineWidth = 2.6 * dpr; }
    else { ctx.strokeStyle = FACTIONS.red.fill; ctx.lineWidth = 2.6 * dpr; }
    ctx.stroke();
  }
}

export function drawZones(ctx, game, view) {
  if (!game?.zones.length) return;
  const { cam, canvas, dpr } = view;
  const z = cam.zoom;
  const now = performance.now();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const zn of game.zones) {
    const x = (zn.x - cam.x) * z + canvas.width / 2, y = (zn.y - cam.y) * z + canvas.height / 2;
    const R = Math.max(14 * dpr, zn.r * z);
    const col = zn.owner ? FACTIONS[zn.owner].fill : '#e8e2cc';
    ctx.fillStyle = zn.owner ? (zn.owner === 'blue' ? 'rgba(80,140,255,0.1)' : 'rgba(255,90,80,0.1)') : 'rgba(230,225,200,0.08)';
    ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
    ctx.setLineDash([8 * dpr, 6 * dpr]);
    ctx.strokeStyle = zn.contested ? `rgba(255,170,60,${0.6 + 0.4 * Math.sin(now / 200)})` : col;
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();
    ctx.setLineDash([]);
    // Прогресс захвата
    if (Math.abs(zn.prog) > 0.02 && Math.abs(zn.prog) < 1) {
      ctx.strokeStyle = zn.prog < 0 ? FACTIONS.blue.fill : FACTIONS.red.fill;
      ctx.lineWidth = 5 * dpr;
      ctx.beginPath();
      ctx.arc(x, y, R + 5 * dpr, -Math.PI / 2, -Math.PI / 2 + Math.abs(zn.prog) * Math.PI * 2);
      ctx.stroke();
    }
    ctx.font = `700 ${13 * dpr}px "PT Sans Narrow", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = zn.name + (zn.contested ? ' · бой' : zn.blue || zn.red ? ` · ${zn.blue || zn.red} чел.` : '');
    ctx.lineWidth = 4 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(label, x, y - R - 12 * dpr);
    ctx.fillStyle = col;
    ctx.fillText(label, x, y - R - 12 * dpr);
  }
}

// Подготовка: линия разграничения и затенённая чужая половина
export function drawPrep(ctx, game, view, side) {
  if (!game?.prep) return;
  const { cam, canvas, dpr } = view;
  const z = cam.zoom;
  const L = game.prepLimit(side);
  const x = (L - cam.x) * z + canvas.width / 2;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = 'rgba(20,10,10,0.28)';
  if (side === 'blue') ctx.fillRect(x, 0, canvas.width - x, canvas.height);
  else ctx.fillRect(0, 0, x, canvas.height);
  ctx.setLineDash([14 * dpr, 8 * dpr]);
  ctx.strokeStyle = 'rgba(255,210,120,0.85)';
  ctx.lineWidth = 2.5 * dpr;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `700 ${13 * dpr}px "PT Sans", sans-serif`;
  ctx.textAlign = side === 'blue' ? 'right' : 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(255,220,150,0.95)';
  ctx.fillText('Линия разграничения — до начала боя дальше не выдвигаться', x + (side === 'blue' ? -8 : 8) * dpr, 70 * dpr);
}

// Склады снабжения
export function drawDepots(ctx, sim, view, fogSide) {
  const { cam, canvas, dpr } = view;
  const z = cam.zoom;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const d of sim.log.depots) {
    if (fogSide && d.side !== fogSide && !d.spotted) continue;
    const x = (d.x - cam.x) * z + canvas.width / 2, y = (d.y - cam.y) * z + canvas.height / 2;
    if (x < -80 || y < -80 || x > canvas.width + 80 || y > canvas.height + 80) continue;
    // Вблизи — штабеля ящиков и бочки
    if (z > 1.2 * dpr) {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(z, z);
      const rnd = (i) => ((Math.sin(i * 127.1 + d.id * 31.7) * 43758.5) % 1 + 1) % 1;
      for (let i = 0; i < 14; i++) {
        const bx = -14 + (i % 5) * 6.5, by = -9 + Math.floor(i / 5) * 7;
        ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(bx + 0.6, by + 0.6, 4.6, 3);
        ctx.fillStyle = d.alive ? (i % 3 ? '#6b6242' : '#5b6a44') : '#2b2622';
        ctx.fillRect(bx, by, 4.6, 3);
      }
      for (let i = 0; i < 8; i++) {
        ctx.fillStyle = d.alive ? '#3d4a3a' : '#1f1c1a';
        ctx.beginPath(); ctx.arc(10 + (i % 4) * 1.6, 12 + Math.floor(i / 4) * 1.6 + rnd(i) * 0.3, 0.7, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = 'rgba(40,40,30,0.8)'; ctx.lineWidth = 0.3;
      ctx.strokeRect(-18, -13, 36, 30);
      ctx.restore();
    }
    const s = 11 * dpr;
    ctx.fillStyle = d.alive ? FACTIONS[d.side].fill : '#777';
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.rect(x - s, y - s * 0.75 - (z > 1.2 * dpr ? 24 * z : 0), s * 2, s * 1.5); ctx.fill(); ctx.stroke();
    const yy = y - (z > 1.2 * dpr ? 24 * z : 0);
    ctx.beginPath(); ctx.moveTo(x - s, yy + s * 0.35); ctx.lineTo(x + s, yy + s * 0.35); ctx.stroke();
    ctx.font = `700 ${11 * dpr}px "PT Sans", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const own = !fogSide || d.side === fogSide;
    const t = d.alive ? (own ? `${d.name} · П ${Math.round(d.stock.ammo)} · С ${Math.round(d.stock.shells)} · Т ${Math.round(d.stock.fuel)}` : d.name) : `${d.name} (уничтожен)`;
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(t, x, yy + s);
    ctx.fillStyle = '#f2eee2';
    ctx.fillText(t, x, yy + s);
  }
}
