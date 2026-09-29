// Ночь, освещение и туман войны (экранные слои поверх карты).

import { tpPowered } from '../power.js';
import { hash2 } from '../rng.js';

let lightCv = null, fogCv = null, sprite = null, hard = null;

function mkSprite(soft) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(0,0,0,1)');
  gr.addColorStop(soft ? 0.25 : 0.8, soft ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,1)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return c;
}

function layer(cv, w, h) {
  if (!cv) cv = document.createElement('canvas');
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return cv;
}

// darkness: 0 — день, 1 — ночь
export function drawNight(ctx, world, sim, view, darkness) {
  if (darkness < 0.02) return;
  const { cam, canvas, dpr } = view;
  const k = 0.5; // слой в половинном разрешении
  const W = Math.ceil(canvas.width * k), H = Math.ceil(canvas.height * k);
  lightCv = layer(lightCv, W, H);
  sprite = sprite || mkSprite(true);
  const g = lightCv.getContext('2d');
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, W, H);
  g.fillStyle = `rgba(6,10,26,${0.74 * darkness})`;
  g.fillRect(0, 0, W, H);
  const z = cam.zoom * k;
  const toS = (x, y) => [(x - cam.x) * z + W / 2, (y - cam.y) * z + H / 2];
  const hw = canvas.width / 2 / cam.zoom, hh = canvas.height / 2 / cam.zoom;
  const inView = (x, y, pad) => x > cam.x - hw - pad && x < cam.x + hw + pad && y > cam.y - hh - pad && y < cam.y + hh + pad;
  const glows = []; // тёплое свечение поверх
  g.globalCompositeOperation = 'destination-out';
  const hole = (x, y, r, a) => {
    const [sx, sy] = toS(x, y);
    const R = Math.max(2, r * z);
    g.globalAlpha = a;
    g.drawImage(sprite, sx - R, sy - R, R * 2, R * 2);
  };
  const p = world.power;
  if (p) {
    // Уличные фонари
    for (const l of p.lamps) {
      if (!l.on || !inView(l.x, l.y, 30) || !tpPowered(world, l.tp)) continue;
      hole(l.x, l.y, 12, 0.6);
      glows.push([l.x, l.y, 3.5, 'rgba(255,190,110,0.22)']);
    }
    // Окна жилых домов
    for (const b of world.buildings.query({ x0: cam.x - hw, y0: cam.y - hh, x1: cam.x + hw, y1: cam.y + hh })) {
      if (b.tp === undefined || b.collapsed || !tpPowered(world, b.tp)) continue;
      const seed = Math.floor(b.x * 3 + b.y * 7);
      if (cam.zoom > 2.5 * dpr && b.interior) {
        for (let i = 0; i < b.interior.windows.length; i++) {
          if (hash2(i, 9, seed) > 0.45) continue;
          const w = b.interior.windows[i];
          hole(w.p[0] + w.n[0] * 1.5, w.p[1] + w.n[1] * 1.5, 3.2, 0.7);
          glows.push([w.p[0] + w.n[0] * 0.5, w.p[1] + w.n[1] * 0.5, 1.4, 'rgba(255,215,140,0.55)']);
        }
      } else if (hash2(1, 2, seed) < 0.6) {
        hole(b.x, b.y, Math.max(b.w, b.h) * 0.9, 0.5);
        glows.push([b.x, b.y, 2.5, 'rgba(255,205,130,0.5)']);
      }
    }
    for (const m of p.mains) if (m.alive && !m.feedCut && inView(m.x, m.y, 60)) hole(m.x, m.y, 35, 0.6);
  }
  // Пожары
  const now = performance.now();
  for (const f of sim.fires || []) {
    if (!inView(f.x, f.y, f.r * 3)) continue;
    const fl = 0.8 + 0.2 * Math.sin(now / 90 + f.x);
    hole(f.x, f.y, f.r * 2.2 * fl, 0.95);
    glows.push([f.x, f.y, f.r * 0.8 * fl, 'rgba(255,120,40,0.35)']);
  }
  // Разрывы и выстрелы
  for (const e of sim.art.effects) {
    const t = (now - e.t) / 1000;
    if (e.type === 'blast' && t < 0.6) hole(e.x, e.y, 90 * (1 - t), 1);
    if (e.type === 'muzzle' && t < 0.15) hole(e.x, e.y, 30, 1);
  }
  for (const tr of sim.combat?.tracers || []) {
    if (sim.time - tr.t > 0.3) continue;
    hole(tr.x0, tr.y0, 8, 0.7);
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(lightCv, 0, 0, canvas.width, canvas.height);
  // Тёплое свечение
  ctx.globalCompositeOperation = 'lighter';
  for (const [x, y, r, c] of glows) {
    const sx = (x - cam.x) * cam.zoom + canvas.width / 2, sy = (y - cam.y) * cam.zoom + canvas.height / 2;
    const R = Math.max(1.5 * dpr, r * cam.zoom);
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(sx, sy, R, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

// Туман войны: всё вне обзора своих войск и дронов затемнено
export function drawFog(ctx, sim, view, side) {
  const { cam, canvas } = view;
  const k = 0.25;
  const W = Math.ceil(canvas.width * k), H = Math.ceil(canvas.height * k);
  fogCv = layer(fogCv, W, H);
  hard = hard || mkSprite(false);
  const g = fogCv.getContext('2d');
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(12,14,10,0.38)';
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'destination-out';
  const z = cam.zoom * k;
  for (const o of sim.vision.observers[side]) {
    const sx = (o.x - cam.x) * z + W / 2, sy = (o.y - cam.y) * z + H / 2;
    const R = o.r * z;
    if (sx + R < 0 || sy + R < 0 || sx - R > W || sy - R > H) continue;
    g.drawImage(hard, sx - R, sy - R, R * 2, R * 2);
  }
  g.globalCompositeOperation = 'source-over';
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(fogCv, 0, 0, canvas.width, canvas.height);
}
