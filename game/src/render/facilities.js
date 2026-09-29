// Тыловые объекты игрока: полевой склад и медпункт — детальные «сверху», с объёмом и тенями.
// Картинка рисуется один раз (по виду, стороне и стадии) и кэшируется.

import { FACTIONS } from '../sim/factions.js';

const PPM = 16;
const cache = new Map();

function mk(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w); c.height = Math.ceil(h);
  return c;
}
function rnd(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (k >= 0) { r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k; } else { r *= 1 + k; g *= 1 + k; b *= 1 + k; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
// Прямоугольник «с объёмом»: тень, заливка с градиентом, блик кромки, контур
function block(g, x, y, w, h, color, hgt = 0.6) {
  g.fillStyle = 'rgba(10,12,6,0.45)';
  g.fillRect(x + hgt * 0.6, y + hgt * 0.6, w, h);
  const gr = g.createLinearGradient(x, y, x + w, y + h);
  gr.addColorStop(0, shade(color, 0.25)); gr.addColorStop(1, shade(color, -0.25));
  g.fillStyle = gr;
  g.fillRect(x, y, w, h);
  g.strokeStyle = 'rgba(15,15,10,0.7)'; g.lineWidth = 0.06;
  g.strokeRect(x, y, w, h);
  g.fillStyle = 'rgba(255,255,230,0.18)';
  g.fillRect(x, y, w, Math.min(0.12, h * 0.2));
}
// Вал из мешков с песком по контуру (с проёмом ворот)
function sandbagWall(g, pts, r, gate) {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    for (let t = 0; t < L; t += 0.55) {
      const x = a[0] + ((b[0] - a[0]) * t) / L, y = a[1] + ((b[1] - a[1]) * t) / L;
      if (gate && Math.hypot(x - gate[0], y - gate[1]) < gate[2]) continue;
      g.save(); g.translate(x, y); g.rotate(ang);
      g.fillStyle = 'rgba(20,16,10,0.4)'; g.beginPath(); g.roundRect(-0.28 + 0.1, -0.2 + 0.12, 0.56, 0.4, 0.12); g.fill();
      g.fillStyle = r() < 0.5 ? '#9e906b' : '#8f8260';
      g.beginPath(); g.roundRect(-0.28, -0.2, 0.56, 0.4, 0.12); g.fill();
      g.strokeStyle = 'rgba(60,50,30,0.55)'; g.lineWidth = 0.03; g.stroke();
      g.restore();
    }
  }
}
// Маскировочная сеть: полупрозрачное полотно с «листвой»
function camoNet(g, x, y, w, h, r) {
  g.fillStyle = 'rgba(70,82,46,0.55)';
  g.beginPath(); g.roundRect(x, y, w, h, 0.6); g.fill();
  for (let i = 0; i < w * h * 1.6; i++) {
    g.fillStyle = ['rgba(98,110,58,0.8)', 'rgba(62,72,38,0.8)', 'rgba(120,104,70,0.75)'][Math.floor(r() * 3)];
    g.beginPath(); g.ellipse(x + r() * w, y + r() * h, 0.35, 0.2, r() * 3, 0, Math.PI * 2); g.fill();
  }
  g.strokeStyle = 'rgba(30,34,20,0.35)'; g.lineWidth = 0.03;
  g.beginPath();
  for (let t = 0.5; t < w; t += 0.5) { g.moveTo(x + t, y); g.lineTo(x + t, y + h); }
  for (let t = 0.5; t < h; t += 0.5) { g.moveTo(x, y + t); g.lineTo(x + w, y + t); }
  g.stroke();
}
function crates(g, x, y, cols, rows, r) {
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const c = r() < 0.7 ? '#5d6a3f' : '#6b6446';
    block(g, x + i * 1.25, y + j * 0.8, 1.15, 0.7, c, 0.35);
    g.fillStyle = 'rgba(230,220,160,0.5)'; g.fillRect(x + i * 1.25 + 0.15, y + j * 0.8 + 0.28, 0.3, 0.12); // маркировка
  }
}
function tent(g, x, y, w, h, color, cross) {
  block(g, x, y, w, h, color, 0.9);
  g.strokeStyle = 'rgba(20,20,12,0.4)'; g.lineWidth = 0.08;
  g.beginPath(); g.moveTo(x, y + h / 2); g.lineTo(x + w, y + h / 2); g.stroke(); // конёк
  g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(x, y + h / 2, w, h / 2); // теневой скат
  g.strokeStyle = 'rgba(20,20,12,0.25)'; g.lineWidth = 0.04;
  g.beginPath(); for (let t = 1; t < w; t += 1.2) { g.moveTo(x + t, y); g.lineTo(x + t, y + h); } g.stroke();
  if (cross) {
    const cx = x + w / 2, cy = y + h / 2, s = Math.min(w, h) * 0.32;
    g.fillStyle = '#f2f0e8'; g.beginPath(); g.arc(cx, cy, s, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#c62b2b'; g.fillRect(cx - s * 0.2, cy - s * 0.75, s * 0.4, s * 1.5); g.fillRect(cx - s * 0.75, cy - s * 0.2, s * 1.5, s * 0.4);
  }
}

const SIZE = { depot: [46, 32], medpoint: [34, 26] };

function art(kind, side, stage) {
  const key = `${kind}:${side}:${stage}`;
  let c = cache.get(key);
  if (c) return c;
  const [W, H] = SIZE[kind];
  c = mk((W + 4) * PPM, (H + 4) * PPM);
  const g = c.getContext('2d');
  g.translate(c.width / 2, c.height / 2);
  g.scale(PPM, PPM);
  const r = rnd(kind.length * 977 + (side === 'blue' ? 3 : 7));
  const hw = W / 2, hh = H / 2;
  // Утоптанная площадка с колеями
  g.fillStyle = stage === 'dead' ? '#3b342c' : '#8b7c5c';
  g.beginPath(); g.roundRect(-hw, -hh, W, H, 2); g.fill();
  g.strokeStyle = 'rgba(70,58,40,0.45)'; g.lineWidth = 0.35;
  g.beginPath(); g.moveTo(hw + 2, -2.2); g.quadraticCurveTo(0, -3, -hw + 4, 0); g.moveTo(hw + 2, 2.2); g.quadraticCurveTo(0, 3, -hw + 4, 2); g.stroke();
  for (let i = 0; i < 60; i++) { g.fillStyle = r() < 0.5 ? 'rgba(60,50,35,0.25)' : 'rgba(200,185,150,0.18)'; g.beginPath(); g.arc((r() - 0.5) * W, (r() - 0.5) * H, 0.2 + r() * 0.5, 0, Math.PI * 2); g.fill(); }
  if (stage === 'dead') {
    // Сгоревшее: чёрные пятна, разбросанные ящики, воронки
    for (let i = 0; i < 24; i++) { g.fillStyle = r() < 0.5 ? 'rgba(15,12,10,0.7)' : 'rgba(90,70,50,0.8)'; g.beginPath(); g.ellipse((r() - 0.5) * W, (r() - 0.5) * H, 0.5 + r() * 2.5, 0.4 + r() * 1.5, r() * 3, 0, Math.PI * 2); g.fill(); }
    for (let i = 0; i < 10; i++) { g.save(); g.translate((r() - 0.5) * W, (r() - 0.5) * H); g.rotate(r() * 3); g.fillStyle = '#2d2a22'; g.fillRect(-0.5, -0.3, 1.1, 0.6); g.restore(); }
    cache.set(key, c);
    return c;
  }
  const outline = [[-hw + 1, -hh + 1], [hw - 1, -hh + 1], [hw - 1, hh - 1], [-hw + 1, hh - 1]];
  if (stage === 'build') {
    // Стройка: разметка, первые мешки, штабель, шнур
    g.setLineDash([0.8, 0.6]); g.strokeStyle = 'rgba(250,230,150,0.9)'; g.lineWidth = 0.15;
    g.strokeRect(-hw + 1, -hh + 1, W - 2, H - 2); g.setLineDash([]);
    sandbagWall(g, outline.slice(0, 2), r, null);
    crates(g, -hw + 4, -hh + 4, 3, 2, r);
    block(g, 2, 2, 4, 2.5, '#6b5d43', 0.4); // штабель мешков
    cache.set(key, c);
    return c;
  }
  sandbagWall(g, outline, r, [hw - 1, 0, 3.2]); // ворота к дороге (+x)
  if (kind === 'depot') {
    // Штабеля боеприпасов под сетками
    crates(g, -hw + 3, -hh + 3, 6, 4, r); crates(g, -hw + 3, 3, 6, 4, r);
    camoNet(g, -hw + 2.5, -hh + 2.5, 8.2, 4.2, r); camoNet(g, -hw + 2.5, 2.5, 8.2, 4.2, r);
    crates(g, -2, -hh + 3, 4, 3, r);
    // Топливо: мягкие ёмкости и бочки
    for (const [x, y] of [[-3, 4], [1.2, 4], [-3, 8.4]]) {
      g.fillStyle = 'rgba(10,10,6,0.45)'; g.beginPath(); g.roundRect(x + 0.4, y + 0.4, 3.6, 3.2, 1.4); g.fill();
      const gr = g.createRadialGradient(x + 1.2, y + 1, 0.2, x + 1.8, y + 1.6, 2.4);
      gr.addColorStop(0, '#4b5341'); gr.addColorStop(1, '#23271d');
      g.fillStyle = gr; g.beginPath(); g.roundRect(x, y, 3.6, 3.2, 1.4); g.fill();
    }
    for (let i = 0; i < 14; i++) {
      const x = 6 + (i % 5) * 0.75, y = 5 + Math.floor(i / 5) * 0.75;
      g.fillStyle = 'rgba(10,10,6,0.4)'; g.beginPath(); g.arc(x + 0.12, y + 0.12, 0.34, 0, Math.PI * 2); g.fill();
      g.fillStyle = i % 4 ? '#3e5b3a' : '#7a3a2a'; g.beginPath(); g.arc(x, y, 0.34, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,230,0.25)'; g.beginPath(); g.arc(x - 0.1, y - 0.1, 0.1, 0, Math.PI * 2); g.fill();
    }
    tent(g, 6, -hh + 3, 6, 4.5, side === 'blue' ? '#5e6848' : '#56603f', false);
    block(g, 13, -hh + 3.2, 3, 2.2, '#4d5439', 0.8); // КУНГ / контейнер
    // Поддоны у ворот
    for (let i = 0; i < 4; i++) block(g, hw - 8 + i * 1.3, hh - 5, 1.2, 1.0, '#8d7450', 0.15);
  } else {
    tent(g, -hw + 3, -hh + 3, 11, 6, '#6e7657', true);
    tent(g, -hw + 3, 2, 11, 6, '#6e7657', true);
    tent(g, 3, -hh + 3, 7, 5, '#7b8163', false);
    // Носилки
    for (let i = 0; i < 4; i++) { block(g, 3.5 + i * 1.3, 3.5, 0.7, 2.1, '#5b6247', 0.15); g.fillStyle = '#c8c4b6'; g.fillRect(3.62 + i * 1.3, 3.8, 0.46, 1.5); }
    block(g, 9.5, -hh + 3.5, 2, 1.4, '#4a5a3e', 0.5); // генератор
    g.fillStyle = '#2b3a44'; g.beginPath(); g.arc(12, -hh + 7, 1, 0, Math.PI * 2); g.fill(); // ёмкость воды
    // Площадка для санитарок
    g.strokeStyle = 'rgba(240,240,230,0.7)'; g.lineWidth = 0.15; g.strokeRect(4, 7, 7, 3.5);
    g.fillStyle = 'rgba(200,40,40,0.8)'; g.fillRect(7.2, 7.6, 0.6, 2.3); g.fillRect(6.35, 8.45, 2.3, 0.6);
  }
  // Флажок стороны на шесте у ворот
  const F = FACTIONS[side];
  g.fillStyle = '#222'; g.fillRect(hw - 2.2, -4.6, 0.12, 2.2);
  g.fillStyle = F.flag[0]; g.fillRect(hw - 2.08, -4.6, 1.3, 0.45);
  g.fillStyle = F.flag[1]; g.fillRect(hw - 2.08, -4.15, 1.3, 0.45);
  cache.set(key, c);
  return c;
}

export function drawFacilities(ctx, sim, view, fogSide) {
  const { cam, canvas, dpr } = view;
  const z = cam.zoom;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const list = [
    ...sim.log.depots.map((d) => ['depot', d]),
    ...sim.medpoints.blue.map((m) => ['medpoint', m]), ...sim.medpoints.red.map((m) => ['medpoint', m]),
  ];
  for (const [kind, f] of list) {
    if (fogSide && f.side !== fogSide && !f.spotted) continue;
    const x = (f.x - cam.x) * z + canvas.width / 2, y = (f.y - cam.y) * z + canvas.height / 2;
    if (x < -300 || y < -300 || x > canvas.width + 300 || y > canvas.height + 300) continue;
    const stage = !f.alive ? 'dead' : (f.built ?? 1) < 1 ? 'build' : 'ok';
    const [W, H] = SIZE[kind];
    if (z > 0.6 * dpr) {
      const img = art(kind, f.side, stage);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(f.angle || 0);
      ctx.drawImage(img, -(W + 4) / 2 * z, -(H + 4) / 2 * z, (W + 4) * z, (H + 4) * z);
      ctx.restore();
    }
    // Значок и подпись: видны на любом масштабе
    const s = 10 * dpr;
    const yy = z > 0.6 * dpr ? y - (H / 2 + 3) * z - 8 * dpr : y;
    const col = f.alive ? FACTIONS[f.side].fill : '#888';
    ctx.fillStyle = 'rgba(15,17,11,0.88)';
    ctx.strokeStyle = col; ctx.lineWidth = 1.8 * dpr;
    ctx.beginPath(); ctx.roundRect(x - s, yy - s, s * 2, s * 2, 4 * dpr); ctx.fill(); ctx.stroke();
    ctx.fillStyle = kind === 'medpoint' ? '#ff6b6b' : col;
    ctx.font = `700 ${12 * dpr}px "PT Sans", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(kind === 'medpoint' ? '✚' : '▦', x, yy + 0.5 * dpr);
    const own = !fogSide || f.side === fogSide;
    let t = f.name;
    if (!f.alive) t += ' (уничтожен)';
    else if (stage === 'build') t += ` · стройка ${Math.round((f.built || 0) * 100)}%`;
    else if (kind === 'depot' && own) t += ` · П ${Math.round(f.stock.ammo)} · С ${Math.round(f.stock.shells)} · Т ${Math.round(f.stock.fuel)}`;
    ctx.font = `700 ${11 * dpr}px "PT Sans Narrow", sans-serif`;
    ctx.textAlign = 'left';
    ctx.lineWidth = 3 * dpr; ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeText(t, x + s + 4 * dpr, yy);
    ctx.fillStyle = '#f2eee2';
    ctx.fillText(t, x + s + 4 * dpr, yy);
    if (stage === 'build') {
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x - s, yy + s + 3 * dpr, s * 2, 4 * dpr);
      ctx.fillStyle = '#f2c14e'; ctx.fillRect(x - s, yy + s + 3 * dpr, s * 2 * (f.built || 0), 4 * dpr);
    }
  }
}

// Призрак объекта у курсора в режиме постройки
export function drawPlacement(ctx, view, kind, side, x, y, ok) {
  const { cam, canvas } = view;
  const z = cam.zoom;
  const sx = (x - cam.x) * z + canvas.width / 2, sy = (y - cam.y) * z + canvas.height / 2;
  const [W, H] = SIZE[kind];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 0.6;
  ctx.drawImage(art(kind, side, 'ok'), sx - (W + 4) / 2 * z, sy - (H + 4) / 2 * z, (W + 4) * z, (H + 4) * z);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = ok ? '#7ddc6a' : '#ef5a4a';
  ctx.lineWidth = 2 * view.dpr;
  ctx.strokeRect(sx - W / 2 * z, sy - H / 2 * z, W * z, H * z);
}
