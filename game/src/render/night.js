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
  const k = cam.zoom > 3 * dpr ? 1 : 0.5; // вблизи — полное разрешение (иначе пятна света «дрожат» на полпикселя)
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
    const R = r * z;
    if (R < 1.6) return; // пятно меньше пикселя слоя незаметно, а таких тысячи
    g.globalAlpha = a;
    g.drawImage(sprite, sx - R, sy - R, R * 2, R * 2);
  };
  const p = world.power;
  if (p) {
    // Уличные фонари: пятно света на проезжей части рядом с опорой, сама лампа — маленькая точка
    const close = cam.zoom > 1.2 * dpr;
    const far = cam.zoom < (globalThis.GFX === 'low' ? 0.6 : 0.08) * dpr; // экономная графика — огни поселений целиком
    if (!far) for (const l of p.lamps) {
      if (!l.on || !inView(l.x, l.y, 30) || !tpPowered(world, l.tp)) continue;
      const px = l.x + (l.nx || 0) * 3.5, py = l.y + (l.ny || 0) * 3.5;
      if (cam.zoom >= 0.6 * dpr) hole(px, py, close ? 11 : 13, close ? 0.55 : 0.5); // издали светит поселение целиком
      if (close) glows.push([px, py, 9, 'rgba(255,190,110,0.10)', null, 0, 'pool']);
      glows.push([l.x + (l.nx || 0) * 1.2, l.y + (l.ny || 0) * 1.2, 0.35, 'rgba(255,214,150,0.9)', null, 0, 'lamp']);
    }
    // Совсем издали (вся карта на экране — десятки тысяч домов) каждый дом не рисуем: у поселения
    // одно пятно света и выборка огней, по доле запитанных домов
    if (far || cam.zoom < 0.6 * dpr) {
      if (!world._nightSets) {
        world._nightSets = world.settlements.map((s) => {
          const R = s.type === 'city' ? 1500 : 450;
          const bs = world.buildings.query({ x0: s.x - R, y0: s.y - R, x1: s.x + R, y1: s.y + R }).filter((b) => b.tp !== undefined);
          const step = Math.max(1, Math.floor(bs.length / 50));
          return { s, R, sample: bs.filter((_, i) => i % step === 0) };
        });
      }
      for (const { s, R, sample } of world._nightSets) {
        if (!inView(s.x, s.y, R) || !sample.length) continue;
        const lit = sample.filter((b) => !b.collapsed && tpPowered(world, b.tp));
        if (!lit.length) continue;
        hole(s.x, s.y, R * 0.8, (far ? 0.5 : 0.3) * (lit.length / sample.length));
        if (far) for (const b of lit) glows.push([b.x, b.y, 1.2, 'rgba(255,205,130,0.45)']);
      }
    }
    // Окна: вблизи — светящиеся проёмы вдоль стен (из планировки или по фасаду), издали — точка
    if (!far) for (const b of world.buildings.query({ x0: cam.x - hw, y0: cam.y - hh, x1: cam.x + hw, y1: cam.y + hh }, false)) {
      if (b.tp === undefined || b.collapsed || !tpPowered(world, b.tp)) continue;
      const seed = Math.floor(b.x * 3 + b.y * 7);
      if (cam.zoom > 2.5 * dpr && b.interior) {
        for (let i = 0; i < b.interior.windows.length; i++) {
          if (hash2(i, 9, seed) > 0.45) continue;
          const w = b.interior.windows[i];
          hole(w.p[0] + w.n[0] * 1.5, w.p[1] + w.n[1] * 1.5, 2.6, 0.55);
          glows.push([w.p[0] + w.n[0] * 0.2, w.p[1] + w.n[1] * 0.2, 0.6, 'rgba(255,214,140,0.8)', w.n, w.w || 1.1]);
        }
      } else if (cam.zoom > 1.2 * dpr && b.poly) {
        // нет планировки: окна по периметру, через 3.2 м, часть горит
        const P = b.poly, cx = b.x, cy = b.y;
        let lit = 0;
        for (let e = 0; e < P.length; e++) {
          const p0 = P[e], p1 = P[(e + 1) % P.length];
          const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
          const n = Math.min(8, Math.floor(L / 3.2));
          let nx = -(p1[1] - p0[1]) / L, ny = (p1[0] - p0[0]) / L;
          const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
          if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
          for (let k = 0; k < n; k++) {
            if (hash2(k, e, seed) > 0.32) continue;
            const t = (k + 0.5) / n;
            const wx = p0[0] + (p1[0] - p0[0]) * t, wy = p0[1] + (p1[1] - p0[1]) * t;
            hole(wx + nx * 1.6, wy + ny * 1.6, 2.4, 0.45);
            glows.push([wx + nx * 0.15, wy + ny * 0.15, 0.5, 'rgba(255,212,140,0.75)', [nx, ny], 1.2]);
            if (++lit > 10) break;
          }
        }
      } else if (hash2(1, 2, seed) < 0.6) {
        hole(b.x, b.y, Math.min(10, Math.max(b.w, b.h) * 0.6), 0.45);
        glows.push([b.x, b.y, 1.2, 'rgba(255,205,130,0.45)']);
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
  const dots = new Map();
  const dot = (c, x, y, R) => { let a = dots.get(c); if (!a) dots.set(c, (a = [])); a.push(x, y, R); };
  for (const [x, y, r, c, n, ww, kind] of glows) {
    const sx = (x - cam.x) * cam.zoom + canvas.width / 2, sy = (y - cam.y) * cam.zoom + canvas.height / 2;
    ctx.fillStyle = c;
    if (kind === 'pool') {
      // тёплое пятно натриевой лампы на асфальте
      const R = r * cam.zoom;
      const gr = ctx.createRadialGradient(sx, sy, 0, sx, sy, R);
      gr.addColorStop(0, c); gr.addColorStop(1, 'rgba(255,190,110,0)');
      ctx.fillStyle = gr;
      ctx.fillRect(sx - R, sy - R, R * 2, R * 2);
      continue;
    }
    if (kind === 'lamp') { dot(c, sx, sy, Math.min(Math.max(1 * dpr, r * cam.zoom), 2.6 * dpr)); continue; }
    if (n && cam.zoom > 2 * dpr) {
      // окно: полоска по ширине проёма
      const tx = -n[1], ty = n[0], L = ww * cam.zoom * 0.5, T = Math.max(0.8, 0.18 * cam.zoom);
      ctx.beginPath();
      ctx.moveTo(sx - tx * L - n[0] * T, sy - ty * L - n[1] * T); ctx.lineTo(sx + tx * L - n[0] * T, sy + ty * L - n[1] * T);
      ctx.lineTo(sx + tx * L + n[0] * T, sy + ty * L + n[1] * T); ctx.lineTo(sx - tx * L + n[0] * T, sy - ty * L + n[1] * T);
      ctx.fill();
      continue;
    }
    // точечные огни не раздуваются при приближении
    dot(c, sx, sy, Math.min(Math.max(1.2 * dpr, r * cam.zoom), (n ? 1.6 : 4) * dpr));
  }
  // точки одного цвета — одним путём (тысячи огней города — это тысячи fill() иначе);
  // мелкие (до 2.5 px) — квадратиками, их не отличить от кружков
  for (const [c, pts] of dots) {
    ctx.fillStyle = c;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i], y = pts[i + 1], R = pts[i + 2];
      if (x < -R || y < -R || x > canvas.width + R || y > canvas.height + R) continue;
      if (R < 2.5) ctx.rect(x - R, y - R, R * 2, R * 2);
      else { ctx.moveTo(x + R, y); ctx.arc(x, y, R, 0, Math.PI * 2); }
    }
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
