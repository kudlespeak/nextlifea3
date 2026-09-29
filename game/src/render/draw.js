// Отрисовка фрагмента карты (чанка) в «спутниковом» стиле.
// Всё рисуется в мировых координатах (метрах), масштаб ppm = пикселей на метр.

import { fbm, hash2 } from '../rng.js';
import { offsetLine, resample } from '../geom.js';
import { CROPS } from '../mapgen.js';
import { M } from '../spatial.js';

const GROUND = '#7b784e';

const AREA_ORDER = ['floodplain', 'vground', 'suburb', 'balka', 'urban', 'farmyard', 'industrial', 'yard', 'park', 'plot', 'garden', 'stadium', 'platform', 'dam', 'path'];
const AREA_COLORS = {
  floodplain: '#6c7843',
  urban: '#7d7c64',
  yard: '#7c7b5e',
  plot: '#7a7550',
  farmyard: '#8d8466',
  industrial: '#86837b',
  park: '#5c6b3b',
  platform: '#aaa69d',
  path: '#b0a78c',
  dam: '#8e8a6e',
};
const GARDEN_TONES = [['#6b5b43', '#5f6b3a'], ['#72603f', '#6a7440'], ['#5d5140', '#56663a']];
const TREE_COLORS = ['#2d3922', '#34422a', '#3c4a2c', '#434b2c', '#2a2622', '#5c564b']; // 4 — обугленные, 5 — сухие
const ROAD_RANK = { dirt: 0, village: 1, street: 2, local: 3, avenue: 4, highway: 5 };

// Холст и в основном потоке, и в фоновом (Web Worker рисует чанки без DOM)
export function mkCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

let grain = null;
function grainPattern(ctx) {
  if (grain) return grain;
  const c = mkCanvas(128, 128);
  const g = c.getContext('2d');
  const img = g.createImageData(128, 128);
  let s = 12345;
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const v = (s >> 16) & 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 22;
  }
  g.putImageData(img, 0, 0);
  grain = ctx.createPattern(c, 'repeat');
  return grain;
}

function pathPoly(ctx, poly) {
  ctx.moveTo(poly[0][0], poly[0][1]);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
  ctx.closePath();
}

function pathLine(ctx, line) {
  ctx.moveTo(line[0][0], line[0][1]);
  for (let i = 1; i < line.length; i++) ctx.lineTo(line[i][0], line[i][1]);
}

function strokeLine(ctx, line, width, color, dash) {
  ctx.beginPath();
  pathLine(ctx, line);
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  if (dash) ctx.setLineDash(dash);
  ctx.stroke();
  if (dash) ctx.setLineDash([]);
}

// Обрезать ломаную до окрестности прямоугольника — ускоряет длинные дороги/реки
function clipLine(line, b, pad) {
  const out = [];
  let cur = null;
  for (let i = 0; i < line.length; i++) {
    const [x, y] = line[i];
    const inside = x > b.x0 - pad && x < b.x1 + pad && y > b.y0 - pad && y < b.y1 + pad;
    if (inside) {
      if (!cur) {
        cur = [];
        if (i > 0) cur.push(line[i - 1]);
        out.push(cur);
      }
      cur.push(line[i]);
    } else if (cur) {
      cur.push(line[i]);
      cur = null;
    }
  }
  return out;
}

export function drawChunk(ctx, world, b, ppm) {
  const size = b.x1 - b.x0;
  ctx.setTransform(ppm, 0, 0, ppm, -b.x0 * ppm, -b.y0 * ppm);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.fillStyle = GROUND;
  ctx.fillRect(b.x0, b.y0, size, size);
  const q = { x0: b.x0 - 10, y0: b.y0 - 10, x1: b.x1 + 10, y1: b.y1 + 10 };

  drawSteppeTexture(ctx, world, b, ppm);
  for (const f of world.fields.query(q)) drawField(ctx, f, b, ppm);
  drawAreas(ctx, world, b, q, ppm);
  drawLowFreq(ctx, world, b, ppm);
  if (ppm >= 2) drawMicro(ctx, world, b, ppm);
  drawWater(ctx, world, b, q, ppm);
  const scars = world.scars.query(q);
  for (const s of scars) if (s.kind === 'burn') drawBurn(ctx, s);
  for (const s of scars) if (s.kind === 'tracks') drawTracks(ctx, s, ppm);
  drawRails(ctx, world, b, q, ppm);
  drawRoads(ctx, world, b, q, ppm);
  drawForts(ctx, world, q, ppm);
  for (const s of scars) if (s.kind === 'crater') drawCrater(ctx, s, ppm);
  for (const s of scars) if (s.kind === 'wreck') drawWreck(ctx, s, ppm);
  drawBuildings(ctx, world, q, ppm);
  drawPowerGround(ctx, world, q, ppm);
  drawTrees(ctx, world, b, ppm);
  drawPowerLines(ctx, world, q, ppm);

  // Зерно снимка — в пиксельных координатах, со сдвигом, чтобы чанки стыковались
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const pat = grainPattern(ctx);
  const ox = Math.round(b.x0 * ppm) % 128, oy = Math.round(b.y0 * ppm) % 128;
  pat.setTransform(new DOMMatrix([1, 0, 0, 1, -ox, -oy]));
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, size * ppm, size * ppm);
}

// ---------- Фон степи: пятна травы разной сухости ----------
function drawSteppeTexture(ctx, world, b, ppm) {
  const size = b.x1 - b.x0;
  const G = 48;
  const img = lowFreqImage(G, (wx, wy) => {
    const n = fbm(wx / 180, wy / 180, world.seed + 31, 4);
    const t = Math.min(1, Math.max(0, (n - 0.3) * 2.2));
    // от зелёно-оливкового к выгоревшему соломенному
    return [lerp(104, 150, t), lerp(112, 140, t), lerp(66, 90, t), 255];
  }, b);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, b.x0, b.y0, size, size);
}

const lerp = (a, b, t) => a + (b - a) * t;
const lfCanvas = mkCanvas(48, 48);

function lowFreqImage(G, fn, b) {
  lfCanvas.width = lfCanvas.height = G;
  const g = lfCanvas.getContext('2d');
  const img = g.createImageData(G, G);
  const size = b.x1 - b.x0;
  for (let j = 0; j < G; j++)
    for (let i = 0; i < G; i++) {
      const [r, gg, bb, a] = fn(b.x0 + ((i + 0.5) / G) * size, b.y0 + ((j + 0.5) / G) * size);
      const k = (j * G + i) * 4;
      img.data[k] = r; img.data[k + 1] = gg; img.data[k + 2] = bb; img.data[k + 3] = a;
    }
  g.putImageData(img, 0, 0);
  return lfCanvas;
}

// Мелкая фактура вблизи: пучки травы, стерня, комья земли (штрихи двух тонов одной заливкой)
function drawMicro(ctx, world, b, ppm) {
  const step = ppm >= 8 ? 0.3 : ppm >= 4 ? 0.5 : 0.9;
  const len = step * 0.9;
  const light = new Path2D(), dark = new Path2D(), dots = new Path2D();
  const mask = world.mask;
  const skip = M.ROAD | M.WATER | M.BUILD;
  const x0 = Math.floor(b.x0 / step) * step, y0 = Math.floor(b.y0 / step) * step;
  for (let y = y0; y < b.y1; y += step) {
    const iy = Math.round(y / step);
    for (let x = x0; x < b.x1; x += step) {
      const ix = Math.round(x / step);
      const h = hash2(ix, iy, 991);
      if (h < 0.35) continue;
      const px = x + hash2(ix, iy, 13) * step, py = y + hash2(ix, iy, 29) * step;
      if (mask.has(px, py, skip)) continue;
      if (h > 0.93) { dots.moveTo(px + len * 0.2, py); dots.arc(px, py, len * 0.2, 0, Math.PI * 2); continue; }
      const a = hash2(ix, iy, 7) * Math.PI;
      const dx = Math.cos(a) * len * 0.5, dy = Math.sin(a) * len * 0.5;
      const path = h < 0.64 ? dark : light;
      path.moveTo(px - dx, py - dy); path.lineTo(px + dx, py + dy);
    }
  }
  ctx.lineWidth = step * 0.16;
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(40,44,18,0.22)';
  ctx.stroke(dark);
  ctx.strokeStyle = 'rgba(214,206,150,0.2)';
  ctx.stroke(light);
  ctx.fillStyle = 'rgba(60,48,30,0.22)';
  ctx.fill(dots);
}

// Крупные светлые/тёмные разводы поверх полей (влажность, рельеф)
function drawLowFreq(ctx, world, b, ppm) {
  const size = b.x1 - b.x0;
  const img = lowFreqImage(40, (wx, wy) => {
    const n = fbm(wx / 420, wy / 420, world.seed + 77, 3) * 0.7 + fbm(wx / 90, wy / 90, world.seed + 13, 2) * 0.3;
    const d = n - 0.5;
    return d < 0 ? [30, 28, 10, Math.min(255, -d * 190)] : [255, 245, 215, Math.min(255, d * 110)];
  }, b);
  ctx.drawImage(img, b.x0, b.y0, size, size);
}

// ---------- Поле ----------
function drawField(ctx, f, b, ppm) {
  const crop = CROPS[f.crop];
  ctx.save();
  ctx.beginPath();
  pathPoly(ctx, f.poly);
  ctx.fillStyle = crop.color;
  ctx.fill();
  ctx.clip();

  const bb = {
    x0: Math.max(b.x0, f.bbox.x0), y0: Math.max(b.y0, f.bbox.y0),
    x1: Math.min(b.x1, f.bbox.x1), y1: Math.min(b.y1, f.bbox.y1),
  };
  const dx = Math.cos(f.angle), dy = Math.sin(f.angle);
  const nx = -dy, ny = dx;
  // Проекции углов прямоугольника на нормаль к бороздам
  const corners = [[bb.x0, bb.y0], [bb.x1, bb.y0], [bb.x1, bb.y1], [bb.x0, bb.y1]];
  let mn = Infinity, mx = -Infinity, amn = Infinity, amx = -Infinity;
  for (const [x, y] of corners) {
    const p = x * nx + y * ny, a = x * dx + y * dy;
    mn = Math.min(mn, p); mx = Math.max(mx, p);
    amn = Math.min(amn, a); amx = Math.max(amx, a);
  }
  const line = (off, width, color, dash) => {
    ctx.beginPath();
    ctx.moveTo(nx * off + dx * amn, ny * off + dy * amn);
    ctx.lineTo(nx * off + dx * amx, ny * off + dy * amx);
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    if (dash) ctx.setLineDash(dash);
    ctx.stroke();
    if (dash) ctx.setLineDash([]);
  };

  // Борозды / рядки
  if (crop.furrow && ppm >= 0.3) {
    const sp = ppm >= 2 ? 1.6 : ppm >= 1 ? 3 : ppm >= 0.5 ? 6 : 10;
    ctx.beginPath();
    const start = Math.floor(mn / sp) * sp;
    for (let off = start; off <= mx; off += sp) {
      ctx.moveTo(nx * off + dx * amn, ny * off + dy * amn);
      ctx.lineTo(nx * off + dx * amx, ny * off + dy * amx);
    }
    ctx.lineWidth = sp * 0.35;
    ctx.strokeStyle = crop.furrow;
    ctx.stroke();
  }
  // Технологическая колея (трамлайны) каждые 24 м
  if (crop.tram && ppm >= 0.4) {
    const phase = (f.seed % 24);
    const start = Math.floor((mn - phase) / 24) * 24 + phase;
    for (let off = start; off <= mx; off += 24) {
      line(off - 0.9, 0.5, 'rgba(80,65,40,0.35)');
      line(off + 0.9, 0.5, 'rgba(80,65,40,0.35)');
    }
  }
  // Подсолнух — жёлтые головки на крупном плане
  if (crop.dots && ppm >= 2) {
    ctx.fillStyle = 'rgba(165,145,50,0.45)';
    for (let y = Math.floor(bb.y0); y < bb.y1; y += 0.8)
      for (let x = Math.floor(bb.x0); x < bb.x1; x += 0.8)
        if (hash2(Math.round(x * 10), Math.round(y * 10), f.seed) < 0.28) ctx.fillRect(x, y, 0.35, 0.35);
  }
  // Пятна влажности
  for (const p of f.patches) {
    const r = Math.max(p.rx, p.ry);
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    g.addColorStop(0, p.dark ? 'rgba(40,32,15,0.22)' : 'rgba(255,245,210,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, p.rx, p.ry, p.a, 0, Math.PI * 2);
    ctx.fill();
  }
  // Разворотная полоса по краю поля
  ctx.beginPath();
  pathPoly(ctx, f.poly);
  ctx.lineWidth = 30;
  ctx.strokeStyle = 'rgba(70,60,30,0.10)';
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(95,90,55,0.55)';
  ctx.stroke();
  ctx.restore();
}

// Забор вокруг участка: штакетник / сетка / профлист, столбы
function fence(ctx, poly, h) {
  const kind = h < 0.4 ? 'picket' : h < 0.75 ? 'mesh' : 'sheet';
  ctx.beginPath();
  pathPoly(ctx, poly);
  if (kind === 'sheet') { ctx.lineWidth = 0.14; ctx.strokeStyle = h < 0.88 ? '#6f7a6a' : '#7a5a44'; ctx.stroke(); }
  else if (kind === 'picket') { ctx.lineWidth = 0.12; ctx.strokeStyle = '#8a7556'; ctx.setLineDash([0.08, 0.1]); ctx.stroke(); ctx.setLineDash([]); }
  else { ctx.lineWidth = 0.05; ctx.strokeStyle = 'rgba(160,165,160,0.8)'; ctx.stroke(); }
  // Столбы
  ctx.fillStyle = '#4a3c2c';
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    for (let t = 0; t < L; t += 2.5) ctx.fillRect(p[0] + ((q[0] - p[0]) * t) / L - 0.06, p[1] + ((q[1] - p[1]) * t) / L - 0.06, 0.12, 0.12);
  }
}

// ---------- Площадные объекты ----------
function drawAreas(ctx, world, b, q, ppm) {
  // Травяная кромка вдоль лесополос
  for (const belt of world.belts.query(q)) {
    strokeLine(ctx, belt.line, belt.width + 12, 'rgba(98,106,62,0.9)');
    if (ppm < 0.5) strokeLine(ctx, belt.line, belt.width * 0.8, 'rgba(46,58,34,0.55)');
  }
  const list = world.areas.query(q);
  const byKind = {};
  for (const a of list) (byKind[a.kind] ||= []).push(a);
  for (const kind of AREA_ORDER) {
    const items = byKind[kind];
    if (!items) continue;
    for (const a of items) drawArea(ctx, a, b, ppm);
  }
}

function drawArea(ctx, a, b, ppm) {
  switch (a.kind) {
    case 'floodplain':
      for (const part of clipLine(a.line, b, a.width)) {
        strokeLine(ctx, part, a.width, 'rgba(98,112,62,0.75)');
        strokeLine(ctx, part, a.width * 0.6, 'rgba(92,108,60,0.8)');
      }
      break;
    case 'balka': {
      ctx.strokeStyle = '#66703e';
      for (let i = 1; i < a.line.length; i++) {
        ctx.beginPath();
        ctx.moveTo(a.line[i - 1][0], a.line[i - 1][1]);
        ctx.lineTo(a.line[i][0], a.line[i][1]);
        ctx.lineWidth = a.widths[i];
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(60,72,38,0.9)';
      for (let i = 1; i < a.line.length; i++) {
        ctx.beginPath();
        ctx.moveTo(a.line[i - 1][0], a.line[i - 1][1]);
        ctx.lineTo(a.line[i][0], a.line[i][1]);
        ctx.lineWidth = a.widths[i] * 0.45;
        ctx.stroke();
      }
      break;
    }
    case 'vground':
      for (const part of clipLine(a.line, b, a.width)) {
        // Мягкий край: несколько полупрозрачных проходов
        strokeLine(ctx, part, a.width + 60, 'rgba(114,117,73,0.25)');
        strokeLine(ctx, part, a.width + 20, 'rgba(114,117,73,0.45)');
        strokeLine(ctx, part, a.width - 30, 'rgba(114,117,73,0.8)');
      }
      break;
    case 'suburb':
      // Пустыри, огороды и тропинки вокруг кварталов — мягкий переход к полям
      ctx.beginPath();
      pathPoly(ctx, a.poly);
      ctx.lineWidth = 60;
      ctx.strokeStyle = 'rgba(118,118,80,0.18)';
      ctx.stroke();
      ctx.lineWidth = 26;
      ctx.strokeStyle = 'rgba(118,118,80,0.3)';
      ctx.stroke();
      ctx.fillStyle = '#76764f';
      ctx.fill();
      break;
    case 'dam':
      strokeLine(ctx, a.line, a.width, '#8b8568');
      strokeLine(ctx, a.line, 3.5, '#a3977a');
      break;
    case 'path':
      strokeLine(ctx, a.line, a.width, AREA_COLORS.path);
      break;
    case 'garden': {
      const [soil, green] = GARDEN_TONES[a.tone];
      ctx.save();
      ctx.beginPath();
      pathPoly(ctx, a.poly);
      ctx.fillStyle = soil;
      ctx.fill();
      if (ppm >= 1) {
        ctx.clip();
        const dx = Math.cos(a.angle), dy = Math.sin(a.angle);
        const nx = -dy, ny = dx;
        const cx = (a.bbox.x0 + a.bbox.x1) / 2, cy = (a.bbox.y0 + a.bbox.y1) / 2;
        const R = Math.hypot(a.bbox.x1 - a.bbox.x0, a.bbox.y1 - a.bbox.y0) / 2;
        ctx.strokeStyle = green;
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        for (let o = -R; o < R; o += 1.4) {
          ctx.moveTo(cx + nx * o - dx * R, cy + ny * o - dy * R);
          ctx.lineTo(cx + nx * o + dx * R, cy + ny * o + dy * R);
        }
        ctx.stroke();
      }
      ctx.restore();
      break;
    }
    case 'stadium': {
      ctx.save();
      ctx.translate(a.x, a.y);
      ctx.rotate(a.angle);
      roundRect(ctx, -60, -40, 120, 80, 36);
      ctx.fillStyle = '#8a4e3d';
      ctx.fill();
      roundRect(ctx, -50, -31, 100, 62, 28);
      ctx.fillStyle = '#5b7d3e';
      ctx.fill();
      ctx.strokeStyle = 'rgba(235,235,225,0.7)';
      ctx.lineWidth = 0.3;
      ctx.strokeRect(-45, -25, 90, 50);
      ctx.beginPath();
      ctx.moveTo(0, -25); ctx.lineTo(0, 25);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, Math.PI * 2);
      ctx.stroke();
      // трибуна
      ctx.fillStyle = '#9e9b94';
      ctx.fillRect(-45, -48, 90, 7);
      ctx.restore();
      break;
    }
    default: {
      const color = AREA_COLORS[a.kind];
      if (!color) break;
      ctx.beginPath();
      pathPoly(ctx, a.poly);
      ctx.fillStyle = color;
      ctx.fill();
      if (a.kind === 'plot' && a.fence && ppm >= 1) {
        ctx.lineWidth = 0.25;
        ctx.strokeStyle = 'rgba(55,45,30,0.55)';
        ctx.stroke();
        if (ppm >= 3) fence(ctx, a.poly, hash2(Math.round(a.bbox.x0), Math.round(a.bbox.y0), 3));
      }
      if ((a.kind === 'yard' || a.kind === 'farmyard') && ppm >= 2) {
        // Утоптанная земля у построек, тропинки, забор
        ctx.save();
        ctx.clip();
        const cx = (a.bbox.x0 + a.bbox.x1) / 2, cy = (a.bbox.y0 + a.bbox.y1) / 2;
        const R = Math.hypot(a.bbox.x1 - a.bbox.x0, a.bbox.y1 - a.bbox.y0) * 0.35;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
        g.addColorStop(0, 'rgba(150,132,98,0.35)');
        g.addColorStop(1, 'rgba(150,132,98,0)');
        ctx.fillStyle = g;
        ctx.fillRect(a.bbox.x0, a.bbox.y0, a.bbox.x1 - a.bbox.x0, a.bbox.y1 - a.bbox.y0);
        ctx.restore();
        if (ppm >= 3) fence(ctx, a.poly, hash2(Math.round(a.bbox.x0), Math.round(a.bbox.y1), 5));
      }
      if (a.kind === 'urban') {
        ctx.lineWidth = 50;
        ctx.strokeStyle = 'rgba(125,124,100,0.35)';
        ctx.stroke();
      } else if (a.kind === 'industrial' || a.kind === 'farmyard') {
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(70,65,50,0.25)';
        ctx.stroke();
      }
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------- Вода ----------
function drawWater(ctx, world, b, q, ppm) {
  for (const w of world.water.query(q)) {
    if (w.kind === 'river') {
      for (const part of clipLine(w.line, b, w.width * 2)) {
        strokeLine(ctx, part, w.width + 22, 'rgba(78,92,48,0.85)'); // камыш
        strokeLine(ctx, part, w.width + 5, '#6d6a52'); // илистый берег
        strokeLine(ctx, part, w.width, '#2d4648');
        strokeLine(ctx, part, w.width * 0.55, '#304c50');
      }
    } else {
      ctx.beginPath();
      pathPoly(ctx, w.poly);
      ctx.lineWidth = 14;
      ctx.strokeStyle = 'rgba(78,92,48,0.85)';
      ctx.stroke();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#6d6a52';
      ctx.stroke();
      ctx.fillStyle = '#2e4749';
      ctx.fill();
    }
  }
}

// ---------- Следы войны ----------
function drawBurn(ctx, s) {
  ctx.beginPath();
  pathPoly(ctx, s.poly);
  ctx.fillStyle = 'rgba(38,34,26,0.45)';
  ctx.fill();
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.scale(0.7, 0.7);
  ctx.translate(-s.x, -s.y);
  ctx.beginPath();
  pathPoly(ctx, s.poly);
  ctx.fillStyle = 'rgba(18,16,12,0.35)';
  ctx.fill();
  ctx.restore();
}

function drawCrater(ctx, c, ppm) {
  const { x, y, r } = c;
  if (c.age > 0.5) {
    // Старая воронка: оплывшие края, заросла травой
    const k = 1 - (c.age - 0.5);
    ctx.fillStyle = `rgba(62,66,38,${0.55 * k})`;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(40,42,26,${0.5 * k})`;
    ctx.beginPath();
    ctx.arc(x + r * 0.1, y + r * 0.1, r * 0.6, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const g = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * 2.6);
  g.addColorStop(0, 'rgba(150,138,112,0.55)');
  g.addColorStop(1, 'rgba(150,138,112,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#4a4234';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(22,19,15,0.85)';
  ctx.beginPath();
  ctx.arc(x + r * 0.12, y + r * 0.12, r * 0.62, 0, Math.PI * 2);
  ctx.fill();
  // Освещённый край (солнце с северо-запада)
  ctx.strokeStyle = 'rgba(190,178,150,0.6)';
  ctx.lineWidth = r * 0.18;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.92, Math.PI * 0.1, Math.PI * 0.9);
  ctx.stroke();
  // Выброшенный грунт
  if (ppm >= 1.5) {
    ctx.fillStyle = 'rgba(95,85,65,0.7)';
    for (let i = 0; i < 14; i++) {
      const a = hash2(i, 1, c.seed) * Math.PI * 2;
      const d = r * (1.1 + hash2(i, 2, c.seed) * 1.4);
      ctx.fillRect(x + Math.cos(a) * d, y + Math.sin(a) * d, 0.35, 0.35);
    }
  }
}

// ---------- Железная дорога ----------
function drawRails(ctx, world, b, q, ppm) {
  const rails = world.rails.query(q);
  for (const r of rails) for (const part of clipLine(r.line, b, 20)) strokeLine(ctx, part, r.siding ? 5 : 8, '#8b8276');
  for (const r of rails) {
    for (const part of clipLine(r.line, b, 20)) {
      if (ppm >= 1) strokeLine(ctx, part, 3, '#5b4f43', [0.25, 0.45]); // шпалы
      if (ppm >= 0.5) {
        const L = offsetLine(part, -0.76), R = offsetLine(part, 0.76);
        const w = Math.max(0.18, 0.6 / ppm);
        strokeLine(ctx, L, w, '#3b3936');
        strokeLine(ctx, R, w, '#3b3936');
      } else strokeLine(ctx, part, 1.5, '#4d4a45');
    }
  }
  // Мосты — парапеты над водой
  for (const r of rails) for (const run of bridgeRuns(world, r)) drawParapets(ctx, run, 5.5);
}

// ---------- Дороги ----------
function bridgeRuns(world, road) {
  if (road._bridges) return road._bridges;
  const runs = [];
  let cur = null;
  for (let i = 0; i < road.line.length; i++) {
    const [x, y] = road.line[i];
    const wet = world.mask.has(x, y, M.WATER) && world.mask.near(x, y, 6, M.WATER);
    if (wet) {
      if (!cur) {
        cur = i > 0 ? [road.line[i - 1]] : [];
        runs.push(cur);
      }
      cur.push(road.line[i]);
    } else if (cur) {
      cur.push(road.line[i]);
      cur = null;
    }
  }
  road._bridges = runs.filter((r) => r.length > 1);
  return road._bridges;
}

function drawParapets(ctx, run, half) {
  strokeLine(ctx, offsetLine(run, half), 2.2, 'rgba(0,0,0,0.35)');
  strokeLine(ctx, offsetLine(run, -half), 1.2, '#b7b3a8');
  strokeLine(ctx, offsetLine(run, half), 1.2, '#a8a49a');
}

function drawRoads(ctx, world, b, q, ppm) {
  const roads = world.roads.query(q).sort((a, c) => ROAD_RANK[a.type] - ROAD_RANK[c.type]);
  const parts = roads.map((r) => ({ r, parts: clipLine(r.line, b, 40) }));

  // Тень мостов на воде
  for (const { r } of parts)
    for (const run of bridgeRuns(world, r)) {
      ctx.save();
      ctx.translate(3, 3);
      strokeLine(ctx, run, r.width + 4, 'rgba(0,0,0,0.35)');
      ctx.restore();
    }

  // 1) обочины
  for (const { r, parts: ps } of parts)
    for (const p of ps) {
      ctx.lineCap = r.type === 'street' || r.type === 'avenue' ? 'square' : 'round';
      if (r.type === 'dirt') strokeLine(ctx, p, r.width + 2, 'rgba(120,108,80,0.5)');
      else if (r.type === 'street' || r.type === 'avenue') strokeLine(ctx, p, r.width + 5, '#9b978c');
      else strokeLine(ctx, p, r.width + (r.type === 'highway' ? 6 : 4), '#9c9580');
    }
  // 2) покрытие
  for (const { r, parts: ps } of parts)
    for (const p of ps) {
      // Городские улицы — с прямыми углами на перекрёстках, остальное — скруглённо
      ctx.lineCap = r.type === 'street' || r.type === 'avenue' ? 'square' : 'round';
      switch (r.type) {
        case 'dirt':
          strokeLine(ctx, p, r.width, '#a0907a');
          if (ppm >= 1) {
            strokeLine(ctx, offsetLine(p, -1.05), 0.7, 'rgba(110,95,72,0.8)');
            strokeLine(ctx, offsetLine(p, 1.05), 0.7, 'rgba(110,95,72,0.8)');
          }
          break;
        case 'highway': {
          strokeLine(ctx, offsetLine(p, -6.8), 10.6, '#4c4d4b');
          strokeLine(ctx, offsetLine(p, 6.8), 10.6, '#4f504d');
          strokeLine(ctx, p, 2.6, '#6c7447'); // разделительный газон
          break;
        }
        case 'village':
          strokeLine(ctx, p, r.width, '#5f5e59');
          break;
        default:
          strokeLine(ctx, p, r.width, r.type === 'local' ? '#555653' : '#535350');
      }
    }
  ctx.lineCap = 'round';
  // Мосты: парапеты
  for (const { r } of parts)
    for (const run of bridgeRuns(world, r)) drawParapets(ctx, run, r.width / 2 + 0.8);

  // 3) разметка
  if (ppm >= 0.9) {
    const white = 'rgba(225,222,210,0.85)';
    for (const { r, parts: ps } of parts)
      for (const p of ps) {
        if (r.type === 'highway') {
          for (const s of [-1, 1]) {
            strokeLine(ctx, offsetLine(p, s * 6.8), 0.15, white, [3, 9]);
            strokeLine(ctx, offsetLine(p, s * 11.6), 0.18, white);
            strokeLine(ctx, offsetLine(p, s * 2), 0.18, white);
          }
        } else if (r.type === 'local' || r.type === 'avenue') {
          strokeLine(ctx, p, 0.15, white, [3, 6]);
        }
      }
  }
}

// ---------- Здания ----------
function drawBuildings(ctx, world, q, ppm) {
  const list = world.buildings.query(q);
  // Тени: одна общая заливка
  ctx.beginPath();
  for (const bd of list) {
    const s = (bd.height || 4) * 0.45;
    if (bd.style === 'silo') {
      ctx.moveTo(bd.x + s + bd.r, bd.y + s);
      ctx.arc(bd.x + s, bd.y + s, bd.r, 0, Math.PI * 2);
      continue;
    }
    // Тень = объединение «вытянутых» рёбер; все четырёхугольники в одной
    // ориентации, чтобы при nonzero-заливке они не вычитались друг из друга
    const p = bd.poly;
    for (let i = 0; i < 4; i++) {
      const a = p[i], c = p[(i + 1) % 4];
      const quad = [a, c, [c[0] + s, c[1] + s], [a[0] + s, a[1] + s]];
      let area = 0;
      for (let k = 0; k < 4; k++) {
        const u = quad[k], v = quad[(k + 1) % 4];
        area += u[0] * v[1] - v[0] * u[1];
      }
      if (area < 0) quad.reverse();
      ctx.moveTo(quad[0][0], quad[0][1]);
      for (let k = 1; k < 4; k++) ctx.lineTo(quad[k][0], quad[k][1]);
      ctx.closePath();
    }
  }
  ctx.fillStyle = 'rgba(18,18,12,0.42)';
  ctx.fill('nonzero');

  for (const bd of list) drawBuilding(ctx, bd, ppm);
}

// Освещение скатов: солнце с северо-запада
const SUN = [-0.7071, -0.7071];
function facet(ctx, pts, nx, ny, base = 0.22) {
  const k = nx * SUN[0] + ny * SUN[1]; // >0 — к солнцу
  ctx.beginPath();
  pathPoly(ctx, pts);
  ctx.fillStyle = k >= 0 ? `rgba(255,250,235,${(k * base * 0.8).toFixed(3)})` : `rgba(0,0,0,${(-k * base * 1.2).toFixed(3)})`;
  ctx.fill();
}

function drawBuilding(ctx, bd, ppm) {
  if (bd.style === 'silo') {
    const g = ctx.createRadialGradient(bd.x - bd.r * 0.35, bd.y - bd.r * 0.35, bd.r * 0.1, bd.x, bd.y, bd.r);
    g.addColorStop(0, '#e2dfd6');
    g.addColorStop(1, '#9e9b92');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(bd.x, bd.y, bd.r, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const p = bd.poly;
  const c = Math.cos(bd.angle), s = Math.sin(bd.angle);
  const W = (u, v) => [bd.x + u * c - v * s, bd.y + u * s + v * c];
  const hw = bd.w / 2, hh = bd.h / 2;

  if (bd.collapsed) {
    // Обрушено: груда кирпича и бетона, торчат остатки стен
    ctx.beginPath();
    pathPoly(ctx, p);
    ctx.fillStyle = '#7d756a';
    ctx.fill();
    const seed = Math.floor(bd.x * 13 + bd.y * 7);
    const n = Math.min(60, Math.floor(bd.w * bd.h / 6) + 6);
    for (let i = 0; i < n; i++) {
      const [x, y] = W((hash2(i, 1, seed) - 0.5) * bd.w * 1.1, (hash2(i, 2, seed) - 0.5) * bd.h * 1.1);
      const r = 0.4 + hash2(i, 3, seed) * 1.4;
      ctx.fillStyle = i % 3 === 0 ? '#5c5349' : i % 3 === 1 ? '#9a8f80' : '#6e4a3a';
      ctx.fillRect(x - r / 2, y - r / 2, r, r * 0.7);
    }
    ctx.lineWidth = 0.4;
    ctx.strokeStyle = 'rgba(40,36,30,0.8)';
    ctx.beginPath();
    ctx.moveTo(p[0][0], p[0][1]); ctx.lineTo(p[1][0], p[1][1]);
    ctx.stroke();
    return;
  }

  if (bd.style === 'car') {
    ctx.save();
    ctx.translate(bd.x, bd.y);
    ctx.rotate(bd.angle);
    ctx.fillStyle = bd.roof;
    ctx.beginPath();
    ctx.roundRect(-hw, -hh, bd.w, bd.h, 0.5);
    ctx.fill();
    ctx.fillStyle = 'rgba(30,40,45,0.8)';
    ctx.fillRect(-hw + 0.2, -hh + 0.9, bd.w - 0.4, 0.7); // лобовое
    ctx.fillRect(-hw + 0.2, hh - 1.0, bd.w - 0.4, 0.5); // заднее
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(-hw + 0.25, -hh + 1.7, bd.w - 0.5, 1.6); // крыша
    ctx.restore();
    return;
  }
  if (bd.style === 'well') {
    ctx.fillStyle = '#8f8a7e';
    ctx.beginPath(); ctx.arc(bd.x, bd.y, 0.8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1e2426';
    ctx.beginPath(); ctx.arc(bd.x, bd.y, 0.45, 0, Math.PI * 2); ctx.fill();
    if (ppm >= 3) strokeLine(ctx, [W(-0.9, 0), W(0.9, 0)], 0.12, '#5a4332'); // ворот
    return;
  }
  if (bd.style === 'woodpile') {
    ctx.beginPath();
    pathPoly(ctx, p);
    ctx.fillStyle = '#7a5a3a';
    ctx.fill();
    if (ppm >= 3) {
      ctx.fillStyle = '#b08a5e';
      for (let u = -hw + 0.15; u < hw; u += 0.3)
        for (let v = -hh + 0.15; v < hh; v += 0.3) {
          const [x, y] = W(u, v);
          ctx.beginPath(); ctx.arc(x, y, 0.1, 0, Math.PI * 2); ctx.fill();
        }
    }
    return;
  }
  if (bd.style === 'greenhouse') {
    ctx.beginPath();
    pathPoly(ctx, p);
    ctx.fillStyle = 'rgba(222,232,230,0.72)';
    ctx.fill();
    if (ppm >= 1.5) {
      ctx.beginPath();
      for (let v = -hh + 0.8; v < hh; v += 0.8) {
        const [ax, ay] = W(-hw, v), [bx, by] = W(hw, v);
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      }
      ctx.strokeStyle = 'rgba(120,130,125,0.6)';
      ctx.lineWidth = 0.08;
      ctx.stroke();
    }
    return;
  }

  ctx.beginPath();
  pathPoly(ctx, p);
  ctx.fillStyle = bd.roof;
  ctx.fill();

  const long = bd.w >= bd.h;
  if (bd.style === 'gable' || bd.style === 'barn') {
    // Скаты в локальных координатах: конёк вдоль длинной стороны
    const L = long ? hw : hh, S = long ? hh : hw;
    const LW = (a, b) => (long ? W(a, b) : W(b, a)); // a — вдоль конька, b — поперёк
    const n1 = long ? [-s, c] : [c, s]; // нормаль «+поперёк» в мире
    if (bd.hip) {
      const r = Math.max(0, L - S);
      facet(ctx, [LW(-L, -S), LW(L, -S), LW(r, 0), LW(-r, 0)], -n1[0], -n1[1]);
      facet(ctx, [LW(-L, S), LW(L, S), LW(r, 0), LW(-r, 0)], n1[0], n1[1]);
      const ax = long ? [c, s] : [-s, c];
      facet(ctx, [LW(L, -S), LW(L, S), LW(r, 0)], ax[0], ax[1]);
      facet(ctx, [LW(-L, -S), LW(-L, S), LW(-r, 0)], -ax[0], -ax[1]);
      if (ppm >= 0.8) {
        const e = 'rgba(255,255,240,0.22)';
        strokeLine(ctx, [LW(-r, 0), LW(r, 0)], 0.3, e);
        for (const [sa, sb] of [[-L, -S], [L, -S], [L, S], [-L, S]]) strokeLine(ctx, [LW(sa, sb), LW(Math.sign(sa) * r, 0)], 0.2, e);
      }
    } else {
      facet(ctx, [LW(-L, -S), LW(L, -S), LW(L, 0), LW(-L, 0)], -n1[0], -n1[1]);
      facet(ctx, [LW(-L, S), LW(L, S), LW(L, 0), LW(-L, 0)], n1[0], n1[1]);
      if (ppm >= 0.8) strokeLine(ctx, [LW(-L, 0), LW(L, 0)], 0.3, 'rgba(255,255,240,0.25)');
    }
    // Ряды черепицы / шифера
    if (ppm >= 3) {
      ctx.save();
      ctx.beginPath();
      pathPoly(ctx, p);
      ctx.clip();
      ctx.beginPath();
      for (let b2 = -S + 0.35; b2 < S; b2 += 0.35) {
        const [ax, ay] = LW(-L, b2), [bx, by] = LW(L, b2);
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.1)';
      ctx.lineWidth = 0.06;
      ctx.stroke();
      ctx.restore();
    }
    // Свесы крыши
    ctx.beginPath();
    pathPoly(ctx, p);
    ctx.lineWidth = 0.18;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    if (ppm >= 1) ctx.stroke();
    // Застеклённая веранда вдоль фасада — светлая лёгкая кровля
    if (bd.veranda && bd.interior?.front) {
      const f = bd.interior.front;
      const front = p.filter(([x, y]) => (x - bd.x) * f[0] + (y - bd.y) * f[1] > 0);
      if (front.length === 2) {
        const [a1, a2] = front;
        const q = [a1, a2, [a2[0] - f[0] * bd.veranda, a2[1] - f[1] * bd.veranda], [a1[0] - f[0] * bd.veranda, a1[1] - f[1] * bd.veranda]];
        ctx.beginPath();
        pathPoly(ctx, q);
        ctx.fillStyle = 'rgba(205,210,204,0.92)';
        ctx.fill();
        ctx.lineWidth = 0.15;
        ctx.strokeStyle = 'rgba(60,60,55,0.6)';
        ctx.stroke();
        if (ppm >= 2) {
          const L = Math.hypot(a2[0] - a1[0], a2[1] - a1[1]);
          const tx = (a2[0] - a1[0]) / L, ty = (a2[1] - a1[1]) / L;
          ctx.beginPath();
          for (let t2 = 0.6; t2 < L; t2 += 0.6) {
            ctx.moveTo(a1[0] + tx * t2, a1[1] + ty * t2);
            ctx.lineTo(a1[0] + tx * t2 - f[0] * bd.veranda, a1[1] + ty * t2 - f[1] * bd.veranda);
          }
          ctx.lineWidth = 0.06;
          ctx.stroke();
        }
      }
    }
    // Печная труба
    if (bd.chimney && ppm >= 1.2) {
      const [cx, cy] = W(bd.chimney[0], bd.chimney[1]);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(cx - 0.3 + 0.7, cy - 0.3 + 0.7, 0.6, 0.6);
      ctx.fillStyle = '#6e4f40';
      ctx.fillRect(cx - 0.3, cy - 0.3, 0.6, 0.6);
      ctx.fillStyle = '#1e1a16';
      ctx.fillRect(cx - 0.15, cy - 0.15, 0.3, 0.3);
    }
  } else if (bd.style === 'flat') {
    // Парапет: светлая кромка по периметру, тёмная мембрана внутри
    if (ppm >= 0.7) {
      ctx.lineWidth = 0.7;
      ctx.strokeStyle = 'rgba(235,232,222,0.35)';
      ctx.stroke();
      ctx.lineWidth = 0.25;
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.stroke();
    }
    const it = bd.interior;
    if (it && ppm >= 1.2 && bd.height > 6) {
      // Выходы на крышу / машинные отделения лифтов над каждой лестницей
      for (const st of it.stairs) {
        const [x, y] = st.p;
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(x - 1.4 + 1.2, y - 1.4 + 1.2, 2.8, 2.8);
        ctx.fillStyle = '#b3b0a8';
        ctx.fillRect(x - 1.4, y - 1.4, 2.8, 2.8);
      }
    }
    if (it && ppm >= 1.5) {
      // Козырьки над подъездами
      for (const d of it.doors) {
        if (!d.ext) continue;
        const [x, y] = d.p;
        const tx = -d.n[1], ty = d.n[0];
        const q = [[x - tx * 1.3, y - ty * 1.3], [x + tx * 1.3, y + ty * 1.3], [x + tx * 1.3 + d.n[0] * 1.4, y + ty * 1.3 + d.n[1] * 1.4], [x - tx * 1.3 + d.n[0] * 1.4, y - ty * 1.3 + d.n[1] * 1.4]];
        ctx.beginPath();
        pathPoly(ctx, q.map(([a, b2]) => [a + 0.4, b2 + 0.4]));
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fill();
        ctx.beginPath();
        pathPoly(ctx, q);
        ctx.fillStyle = '#9d9a92';
        ctx.fill();
      }
      // Балконы на тыльной стороне многоэтажек
      if (bd.height > 9 && ppm >= 2) {
        let k = 0;
        for (const w of it.windows) {
          const front = it.doors.some((d) => d.ext && d.n[0] * w.n[0] + d.n[1] * w.n[1] > 0.9);
          if (front || k++ % 2) continue;
          const [x, y] = w.p;
          const tx = -w.n[1], ty = w.n[0];
          const q = [[x - tx * 1.3, y - ty * 1.3], [x + tx * 1.3, y + ty * 1.3], [x + tx * 1.3 + w.n[0] * 1.1, y + ty * 1.3 + w.n[1] * 1.1], [x - tx * 1.3 + w.n[0] * 1.1, y - ty * 1.3 + w.n[1] * 1.1]];
          ctx.beginPath();
          pathPoly(ctx, q);
          ctx.fillStyle = hash2(Math.round(x), Math.round(y), 7) < 0.5 ? '#a9b5b8' : '#bcb8ae';
          ctx.fill();
          ctx.lineWidth = 0.08;
          ctx.strokeStyle = 'rgba(0,0,0,0.4)';
          ctx.stroke();
        }
      }
    } else if (ppm >= 1.5 && bd.height > 6) {
      const n = Math.floor(Math.max(bd.w, bd.h) / 14);
      ctx.fillStyle = 'rgba(60,58,52,0.55)';
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n - 0.5;
        const [x, y] = W(long ? t * bd.w : 0, long ? 0 : t * bd.h);
        ctx.fillRect(x - 1, y - 1, 2, 2);
      }
    }
  } else if ((bd.style === 'hangar' || bd.style === 'shed') && ppm >= 1) {
    // Профнастил
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = bd.style === 'shed' ? 0.12 : 0.3;
    ctx.beginPath();
    const step = bd.style === 'shed' ? 0.5 : 1.2;
    for (let u = -hw; u < hw; u += step) {
      const [ax, ay] = W(u, -hh), [bx, by] = W(u, hh);
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    }
    ctx.stroke();
    ctx.restore();
    facet(ctx, p, 0.3, 0.3, 0.12);
  }
  // Потёртости кровли: подтёки, мох, ржавчина, заплатки — вблизи
  if (ppm >= 2 && bd.w * bd.h > 12) {
    ctx.save();
    ctx.beginPath();
    pathPoly(ctx, p);
    ctx.clip();
    const seed = Math.floor(bd.x * 5 + bd.y * 11);
    const n = Math.min(14, 3 + Math.floor(bd.w * bd.h / 25));
    for (let i = 0; i < n; i++) {
      const u = (hash2(i, 11, seed) - 0.5) * bd.w, v = (hash2(i, 12, seed) - 0.5) * bd.h;
      const k = hash2(i, 13, seed);
      const [x, y] = W(u, v);
      ctx.fillStyle = k < 0.35 ? 'rgba(40,36,28,0.16)' : k < 0.6 ? 'rgba(96,110,60,0.18)' : k < 0.8 ? 'rgba(130,78,40,0.16)' : 'rgba(255,250,235,0.12)';
      if (k > 0.9) { // заплатка из другого листа
        ctx.save(); ctx.translate(x, y); ctx.rotate(bd.angle);
        ctx.fillStyle = 'rgba(170,172,168,0.45)'; ctx.fillRect(-0.8, -0.5, 1.6, 1.0);
        ctx.restore();
      } else { ctx.beginPath(); ctx.ellipse(x, y, 0.6 + k * 1.6, 0.4 + k * 0.9, bd.angle + k, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.restore();
    // Спутниковая тарелка / антенна на части домов
    if ((bd.style === 'gable' || bd.style === 'flat') && hash2(seed, 1, 99) < 0.35 && ppm >= 3) {
      const [x, y] = W(bd.w * 0.25, -bd.h * 0.3);
      ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.arc(x + 0.3, y + 0.3, 0.35, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#d9d8d2'; ctx.beginPath(); ctx.arc(x, y, 0.35, 0, Math.PI * 2); ctx.fill();
    }
  }
  // Разрушенная кровля
  if (bd.ruined) {
    ctx.save();
    ctx.beginPath();
    pathPoly(ctx, p);
    ctx.clip();
    const seed = Math.floor(bd.x * 7 + bd.y * 13);
    const c = Math.cos(bd.angle), sn = Math.sin(bd.angle);
    for (let i = 0; i < 7; i++) {
      const u = (hash2(i, 3, seed) - 0.5) * bd.w * 0.9;
      const v = (hash2(i, 4, seed) - 0.5) * bd.h * 0.9;
      ctx.fillStyle = i % 3 ? 'rgba(30,26,22,0.85)' : 'rgba(105,95,78,0.9)';
      ctx.beginPath();
      ctx.arc(bd.x + u * c - v * sn, bd.y + u * sn + v * c, 1 + hash2(i, 5, seed) * Math.min(bd.w, bd.h) * 0.22, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

// ---------- Деревья ----------
// Вблизи (ppm >= 2) кроны над окопами становятся полупрозрачными, чтобы было видно позиции.
// Породы для детальной отрисовки: [основной, светлый, тёмный], форма кроны
const SPECIES = [
  { c: ['#56642f', '#8a984c', '#303a1c'], lobes: 6, spread: 0.5 }, // акация — светлая, ажурная
  { c: ['#34452a', '#5b7443', '#1c2616'], lobes: 4, spread: 0.3 }, // тополь — тёмный, плотный
  { c: ['#465832', '#71864b', '#26321b'], lobes: 5, spread: 0.42 }, // дуб
  { c: ['#4d5d2c', '#7f8f46', '#2b3519'], lobes: 5, spread: 0.45 }, // клён / ясень
  { c: ['#3c4a2e', '#627049', '#222b19'], lobes: 3, spread: 0.25 }, // кустарник
];

function drawTreesDetailed(ctx, world, b, ppm) {
  const q = { x0: b.x0 - 12, y0: b.y0 - 12, x1: b.x1 + 12, y1: b.y1 + 12 };
  const mask = world.mask;
  const fine = ppm >= 4;
  const list = [];
  world.trees.forEach(q, (arr, i) => { if (arr[i + 2] > 0.01) list.push([arr[i], arr[i + 1], arr[i + 2], arr[i + 3]]); });
  // Подлесок и сухая трава под посадкой — мягкие пятна
  ctx.fillStyle = 'rgba(70,78,40,0.35)';
  ctx.beginPath();
  for (const [x, y, r] of list) { ctx.moveTo(x + r * 1.3, y); ctx.arc(x, y, r * 1.3, 0, Math.PI * 2); }
  ctx.fill();
  // Тени — одной заливкой
  ctx.fillStyle = 'rgba(14,18,8,0.5)';
  ctx.beginPath();
  for (const [x, y, r] of list) { const s2 = r * 0.8; ctx.moveTo(x + s2 + r, y + s2); ctx.ellipse(x + s2, y + s2, r, r * 0.9, 0, 0, Math.PI * 2); }
  ctx.fill();
  for (const [x, y, r, shade] of list) {
    const h = hash2(Math.round(x * 3), Math.round(y * 3), 17);
    const faded = ppm >= 2 && mask.has(x, y, M.FORT);
    ctx.globalAlpha = faded ? (ppm >= 4 ? 0.3 : 0.5) : 1;
    if (shade >= 4) {
      // Сгоревшее / сухое: голые ветви
      ctx.strokeStyle = shade === 4 ? '#2a2622' : '#6a6152';
      ctx.lineWidth = Math.max(0.08, r * 0.08);
      ctx.beginPath();
      for (let k = 0; k < 6; k++) { const a = k * 1.05 + h * 6; ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); }
      ctx.stroke();
      ctx.fillStyle = shade === 4 ? '#1d1a17' : '#4a4337';
      ctx.beginPath(); ctx.arc(x, y, r * 0.25, 0, Math.PI * 2); ctx.fill();
      continue;
    }
    const sp = SPECIES[r < 2.2 ? 4 : Math.floor(h * 4)];
    const tint = shade * 0.04; // посечённые осколками — темнее
    // Крона: несколько «шапок» вокруг центра
    const lobes = [];
    for (let k = 0; k < sp.lobes; k++) {
      const a = (k / sp.lobes) * Math.PI * 2 + h * 5;
      const d = r * sp.spread * (0.7 + hash2(k, 3, Math.round(x * 7 + y)) * 0.6);
      lobes.push([x + Math.cos(a) * d, y + Math.sin(a) * d, r * (0.55 + hash2(k, 4, Math.round(x + y * 5)) * 0.2)]);
    }
    lobes.push([x, y, r * 0.62]);
    ctx.fillStyle = sp.c[2];
    ctx.beginPath();
    for (const [lx, ly, lr] of lobes) { ctx.moveTo(lx + lr, ly); ctx.arc(lx, ly, lr, 0, Math.PI * 2); }
    ctx.fill();
    ctx.fillStyle = sp.c[0];
    ctx.beginPath();
    for (const [lx, ly, lr] of lobes) { ctx.moveTo(lx - lr * 0.12 + lr * 0.85, ly - lr * 0.12); ctx.arc(lx - lr * 0.12, ly - lr * 0.12, lr * 0.85, 0, Math.PI * 2); }
    ctx.fill();
    // Блики с северо-запада
    ctx.fillStyle = sp.c[1];
    ctx.globalAlpha *= 0.75 - tint;
    ctx.beginPath();
    for (const [lx, ly, lr] of lobes) { ctx.moveTo(lx - lr * 0.35 + lr * 0.45, ly - lr * 0.35); ctx.arc(lx - lr * 0.35, ly - lr * 0.35, lr * 0.45, 0, Math.PI * 2); }
    ctx.fill();
    ctx.globalAlpha = faded ? (ppm >= 4 ? 0.3 : 0.5) : 1;
    if (fine) {
      // Листва: мелкие светлые и тёмные пятна
      for (let k = 0; k < 10; k++) {
        const a = hash2(k, 7, Math.round(x * 11 + y)) * Math.PI * 2, d = Math.sqrt(hash2(k, 8, Math.round(x + y * 11))) * r * 0.9;
        ctx.fillStyle = k % 2 ? sp.c[1] : sp.c[2];
        ctx.globalAlpha = (faded ? 0.25 : 0.55);
        ctx.beginPath(); ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, r * 0.12, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (shade > 0 && shade < 4) {
      // Посечённые: сквозь крону видны ветви
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = '#3a3226';
      ctx.lineWidth = r * 0.06;
      ctx.beginPath(); ctx.moveTo(x - r * 0.6, y); ctx.lineTo(x + r * 0.5, y + r * 0.2); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function drawTrees(ctx, world, b, ppm) {
  if (ppm >= 1.5) return drawTreesDetailed(ctx, world, b, ppm);
  const q = { x0: b.x0 - 12, y0: b.y0 - 12, x1: b.x1 + 12, y1: b.y1 + 12 };
  const detailed = ppm >= 0.5;
  const minR = 0.75 / ppm;
  const fadeOn = ppm >= 2;
  const mk = () => ({
    shadow: new Path2D(), crowns: TREE_COLORS.map(() => new Path2D()), light: new Path2D(), dark: new Path2D(), n: 0,
  });
  const normal = mk(), faded = mk();
  const mask = world.mask;
  world.trees.forEach(q, (arr, i) => {
    const x = arr[i], y = arr[i + 1], r0 = arr[i + 2], shade = arr[i + 3];
    if (r0 <= 0.01) return; // уничтожено
    const g = fadeOn && mask.has(x, y, M.FORT) ? faded : normal;
    g.n++;
    const r = Math.max(r0, minR);
    const burnt = shade >= 4;
    if (detailed) {
      const s = r * 0.75;
      g.shadow.moveTo(x + s + r, y + s);
      g.shadow.arc(x + s, y + s, r, 0, Math.PI * 2);
    }
    g.crowns[shade].moveTo(x + r, y);
    g.crowns[shade].arc(x, y, r, 0, Math.PI * 2);
    if (detailed && !burnt) {
      g.light.moveTo(x - r * 0.3 + r * 0.55, y - r * 0.3);
      g.light.arc(x - r * 0.3, y - r * 0.3, r * 0.55, 0, Math.PI * 2);
      if (ppm >= 2) {
        g.dark.moveTo(x + r * 0.35 + r * 0.4, y + r * 0.35);
        g.dark.arc(x + r * 0.35, y + r * 0.35, r * 0.4, 0, Math.PI * 2);
      }
    }
  });
  const paint = (g, alpha) => {
    if (!g.n) return;
    ctx.globalAlpha = alpha;
    if (detailed) {
      ctx.fillStyle = 'rgba(16,20,8,0.5)';
      ctx.fill(g.shadow);
    }
    for (let k = 0; k < TREE_COLORS.length; k++) {
      ctx.fillStyle = TREE_COLORS[k];
      ctx.fill(g.crowns[k]);
    }
    if (detailed) {
      ctx.fillStyle = 'rgba(128,146,84,0.28)';
      ctx.fill(g.light);
      ctx.fillStyle = 'rgba(15,22,8,0.3)';
      ctx.fill(g.dark);
    }
    ctx.globalAlpha = 1;
  };
  paint(normal, 1);
  paint(faded, ppm >= 4 ? 0.28 : 0.5);
}

// ---------- Колеи ----------
function drawTracks(ctx, t, ppm) {
  const k = 1 - t.age * 0.6;
  if (ppm < 0.9) {
    strokeLine(ctx, t.line, 4, `rgba(70,60,42,${0.22 * k})`);
    return;
  }
  // Примятая полоса и две колеи гусениц
  strokeLine(ctx, t.line, t.gauge + 1.4, `rgba(190,178,140,${0.12 * k})`);
  strokeLine(ctx, offsetLine(t.line, -t.gauge / 2), 0.65, `rgba(58,48,34,${0.5 * k})`);
  strokeLine(ctx, offsetLine(t.line, t.gauge / 2), 0.65, `rgba(58,48,34,${0.5 * k})`);
  if (ppm >= 3) {
    // Отпечатки траков
    strokeLine(ctx, offsetLine(t.line, -t.gauge / 2), 0.55, `rgba(35,28,20,${0.35 * k})`, [0.12, 0.16]);
    strokeLine(ctx, offsetLine(t.line, t.gauge / 2), 0.55, `rgba(35,28,20,${0.35 * k})`, [0.12, 0.16]);
  }
}

// ---------- Подбитая техника ----------
const WRECK_DIMS = { tank: [7, 3.6], ifv: [6.8, 3.2], apc: [7.6, 2.9], truck: [8, 2.5] };
function drawWreck(ctx, w, ppm) {
  const [L, W] = WRECK_DIMS[w.type];
  ctx.save();
  ctx.translate(w.x, w.y);
  ctx.rotate(w.angle);
  ctx.fillStyle = 'rgba(10,10,8,0.45)';
  ctx.fillRect(-L / 2 + 0.6, -W / 2 + 0.6, L, W);
  ctx.fillStyle = '#2b2824';
  ctx.fillRect(-L / 2, -W / 2, L, W);
  if (ppm >= 1.5) {
    // Ржавые подпалины, сорванная башня рядом
    ctx.fillStyle = 'rgba(110,62,38,0.8)';
    for (let i = 0; i < 5; i++) {
      const u = (hash2(i, 1, w.seed) - 0.5) * L * 0.8, v = (hash2(i, 2, w.seed) - 0.5) * W * 0.8;
      ctx.fillRect(u, v, 0.8, 0.6);
    }
    if (w.type === 'tank') {
      ctx.fillStyle = '#34302a';
      ctx.beginPath();
      ctx.ellipse(L * 0.4 + 3, W * 0.8 + 1, 1.5, 1.3, 0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(L * 0.4 + 4, W * 0.8 + 0.9, 4, 0.25);
    }
  }
  ctx.restore();
}

// ---------- Фортификация ----------
// Сверху видно: бруствер (выброшенный грунт), тёмную щель траншеи, перекрытия
// из брёвен/сетки, насыпи блиндажей. Подземные ходы на снимке не видны.
function spoilColor(age, alpha = 1) {
  // свежий грунт светлый, старый зарастает травой
  const r = Math.round(150 - age * 35), g = Math.round(132 - age * 20), bl = Math.round(100 - age * 30);
  return `rgba(${r},${g},${bl},${alpha})`;
}

// Точки вдоль ломаной с шагом step и нормалью (влево от направления)
function samplesWithNormals(line, step) {
  const pts = resample(line, step);
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    out.push([pts[i], [-dy / L, dx / L]]);
  }
  return out;
}

// Бруствер: комья выброшенного грунта, светлые сверху, с тенью; старые — с травой
function parapetLumps(ctx, t, sign, ppm) {
  const step = ppm >= 4 ? 0.45 : 0.8;
  const tones = [spoilColor(t.age, 1), spoilColor(Math.max(0, t.age - 0.25), 1), spoilColor(t.age + 0.25, 1)];
  for (const [p, n] of samplesWithNormals(t.line, step)) {
    const seed = Math.round(p[0] * 13) * 7 + Math.round(p[1] * 13);
    for (const side of sign ? [sign, -sign] : [1, -1]) {
      const front = side === sign;
      const base = sign ? (front ? 1.7 : 1.2) : 1.5;
      const k = hash2(seed, side > 0 ? 1 : 2, 3);
      const off = base + (k - 0.5) * (front ? 1.4 : 0.8);
      const r = (front ? 0.45 : 0.32) + k * 0.35;
      const x = p[0] + n[0] * side * off, y = p[1] + n[1] * side * off;
      ctx.fillStyle = 'rgba(30,24,16,0.28)';
      ctx.beginPath(); ctx.ellipse(x + 0.12, y + 0.12, r, r * 0.7, k * 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = tones[Math.floor(k * 3) % 3];
      ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.7, k * 3, 0, Math.PI * 2); ctx.fill();
      if (ppm >= 4) {
        ctx.fillStyle = 'rgba(255,240,210,0.18)';
        ctx.beginPath(); ctx.ellipse(x - r * 0.25, y - r * 0.25, r * 0.45, r * 0.3, k * 3, 0, Math.PI * 2); ctx.fill();
      }
      // Старые позиции зарастают
      if (t.age > 0.4 && k > 0.6) {
        ctx.fillStyle = 'rgba(88,104,52,0.55)';
        ctx.beginPath(); ctx.arc(x + r * 0.3, y, r * 0.5, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  // Мешки с песком у стрелковых ячеек и через каждые ~7 м бруствера
  if (ppm >= 3 && sign) {
    const bags = [];
    if (t.pit) bags.push([t.pit, 1.2, true]);
    if (t.sub === 'fire') {
      const pts = samplesWithNormals(t.line, 7);
      for (let i = 1; i < pts.length - 1; i += 1) bags.push([[pts[i][0][0] + pts[i][1][0] * sign * 0.9, pts[i][0][1] + pts[i][1][1] * sign * 0.9], 0.9, false, pts[i][1]]);
    }
    for (const [c, R, ring, n] of bags) {
      const count = ring ? 9 : 4;
      for (let k = 0; k < count; k++) {
        let x, y, a;
        if (ring) { a = (k / count) * Math.PI * 2; x = c[0] + Math.cos(a) * R; y = c[1] + Math.sin(a) * R; a += Math.PI / 2; }
        else { const tx = -n[1], ty = n[0]; const o = (k - 1.5) * 0.55; x = c[0] + tx * o; y = c[1] + ty * o; a = Math.atan2(ty, tx); }
        ctx.save(); ctx.translate(x, y); ctx.rotate(a);
        ctx.fillStyle = 'rgba(20,16,10,0.35)'; ctx.beginPath(); ctx.roundRect(-0.25 + 0.06, -0.15 + 0.06, 0.5, 0.3, 0.1); ctx.fill();
        ctx.fillStyle = k % 2 ? '#a39470' : '#958760';
        ctx.beginPath(); ctx.roundRect(-0.25, -0.15, 0.5, 0.3, 0.1); ctx.fill();
        ctx.strokeStyle = 'rgba(60,50,30,0.6)'; ctx.lineWidth = 0.03; ctx.stroke();
        ctx.restore();
      }
    }
  }
}

// Сама траншея вблизи: кромка, освещённая и затенённая стенки, дно, обшивка, настил
function trenchCut(ctx, t, w, ppm) {
  // Какая стенка освещена (солнце с северо-запада): смотрим нормаль ломаной
  const a = t.line[0], b = t.line[t.line.length - 1];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L;
  const lit = nx * 0.707 + ny * 0.707 > 0 ? 1 : -1; // +нормаль — к юго-востоку: эта стенка смотрит на солнце
  strokeLine(ctx, t.line, w + 0.45, '#3b3024'); // срез грунта по кромке
  strokeLine(ctx, t.line, w, '#211a12');
  strokeLine(ctx, offsetLine(t.line, lit * w * 0.3), w * 0.28, 'rgba(128,104,74,0.6)'); // освещённая стенка
  strokeLine(ctx, offsetLine(t.line, -lit * w * 0.32), w * 0.22, 'rgba(8,6,4,0.55)'); // тень
  strokeLine(ctx, t.line, w * 0.34, '#17110b'); // дно
  if (ppm >= 5) {
    // Обшивка стен: доски/плетень — короткие поперечные штрихи вдоль обеих стенок
    ctx.strokeStyle = 'rgba(112,88,58,0.75)';
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    for (const [p, n] of samplesWithNormals(t.line, 0.22)) {
      for (const sd of [1, -1]) {
        const o0 = sd * w * 0.36, o1 = sd * w * 0.5;
        ctx.moveTo(p[0] + n[0] * o0, p[1] + n[1] * o0); ctx.lineTo(p[0] + n[0] * o1, p[1] + n[1] * o1);
      }
    }
    ctx.stroke();
    // Настил по дну
    strokeLine(ctx, t.line, w * 0.3, 'rgba(92,72,48,0.9)', [0.1, 0.16]);
  }
  if (t.pit) {
    ctx.fillStyle = '#140f0a';
    ctx.beginPath(); ctx.arc(t.pit[0], t.pit[1], 0.95, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(128,104,74,0.45)';
    ctx.beginPath(); ctx.arc(t.pit[0] - 0.2, t.pit[1] - 0.2, 0.6, Math.PI * 0.9, Math.PI * 1.9); ctx.fill();
  }
  if (t.niches && ppm >= 2) {
    ctx.fillStyle = '#0f0b07';
    for (const nch of t.niches) {
      ctx.beginPath();
      ctx.ellipse(nch.p[0] + nch.side * 0.55, nch.p[1] - nch.side * 0.3, 0.5, 0.38, 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export function drawForts(ctx, world, q, ppm) {
  const items = world.forts.query(q);
  if (!items.length) return;
  const trenches = items.filter((f) => f.kind === 'trench');
  const low = ppm < 0.9;

  // 1) Бруствер и тыльный отвал
  for (const t of trenches) {
    if (low) {
      strokeLine(ctx, t.line, 3.5, spoilColor(t.age, 0.9));
      continue;
    }
    const s = t.sub === 'fire' || t.sub === 'cell' ? 1 : 0;
    // Нормаль «к противнику» сравниваем с нормалью линии, чтобы бруствер был спереди
    const [a, b] = [t.line[0], t.line[t.line.length - 1]];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const ln = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
    const sign = t.enemy && ln[0] * t.enemy[0] + ln[1] * t.enemy[1] < 0 ? -1 : 1;
    if (s) {
      strokeLine(ctx, offsetLine(t.line, sign * 1.7), 2.6, spoilColor(t.age, 0.95)); // бруствер к противнику
      strokeLine(ctx, offsetLine(t.line, -sign * 1.2), 1.5, spoilColor(t.age, 0.7)); // тыльный отвал
    } else strokeLine(ctx, t.line, 3.8, spoilColor(t.age, 0.85));
    if (ppm >= 1.8) parapetLumps(ctx, t, s ? sign : 0, ppm);
  }
  // Насыпи блиндажей и капониров
  for (const f of items) {
    if (f.kind === 'dugout' && f.collapsed) {
      ctx.fillStyle = '#3a3128';
      ctx.beginPath(); ctx.arc(f.x, f.y, Math.max(f.w, f.h) * 0.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(110,85,55,0.8)';
      for (let i = 0; i < 8; i++) ctx.fillRect(f.x + Math.cos(i) * 2 - 1, f.y + Math.sin(i * 1.7) * 2, 2.2, 0.35); // брёвна наката
    } else if (f.kind === 'dugout') {
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.angle);
      ctx.fillStyle = 'rgba(15,12,8,0.35)';
      ctx.beginPath();
      ctx.roundRect(-f.w / 2 - 1.2 + 0.5, -f.h / 2 - 1.2 + 0.5, f.w + 2.4, f.h + 2.4, 1.5);
      ctx.fill();
      ctx.fillStyle = spoilColor(f.age);
      ctx.beginPath();
      ctx.roundRect(-f.w / 2 - 1.2, -f.h / 2 - 1.2, f.w + 2.4, f.h + 2.4, 1.5);
      ctx.fill();
      if (ppm >= 2) {
        // Брёвна наката видны по краям насыпи
        ctx.strokeStyle = 'rgba(80,60,40,0.8)';
        ctx.lineWidth = 0.28;
        ctx.beginPath();
        for (let x = -f.w / 2; x <= f.w / 2; x += 0.35) {
          ctx.moveTo(x, -f.h / 2 - 1.1); ctx.lineTo(x, -f.h / 2 - 0.5);
        }
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,245,215,0.12)';
        ctx.fillRect(-f.w / 2, -f.h / 2, f.w * 0.6, f.h * 0.6);
      }
      if (f.net) {
        ctx.fillStyle = 'rgba(80,92,52,0.75)';
        ctx.beginPath();
        ctx.roundRect(-f.w / 2 - 1.6, -f.h / 2 - 1.6, f.w + 3.2, f.h + 3.2, 1.8);
        ctx.fill();
      }
      ctx.restore();
    } else if (f.kind === 'capon') {
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.angle);
      // U-образный вал, открытый назад (от противника)
      ctx.strokeStyle = spoilColor(0.4, 0.95);
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(-f.h / 2, -f.w / 2 - 1);
      ctx.lineTo(f.h / 2, -f.w / 2 - 1);
      ctx.lineTo(f.h / 2, f.w / 2 + 1);
      ctx.lineTo(-f.h / 2, f.w / 2 + 1);
      ctx.stroke();
      ctx.fillStyle = 'rgba(60,50,35,0.55)';
      ctx.fillRect(-f.h / 2, -f.w / 2, f.h, f.w);
      ctx.restore();
    }
  }
  // 2) Сама щель траншеи
  for (const t of trenches) {
    const w = low ? Math.max(1.2, 0.8 / ppm) : t.width;
    if (!low && ppm >= 1.8) { trenchCut(ctx, t, w, ppm); continue; }
    strokeLine(ctx, t.line, w, '#231c14');
    if (!low) {
      strokeLine(ctx, t.line, w * 0.45, '#140f0a');
      if (t.pit) {
        ctx.fillStyle = '#1a140e';
        ctx.beginPath();
        ctx.arc(t.pit[0], t.pit[1], 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
      // «Лисьи норы» — ниши в стенках
      if (t.niches && ppm >= 2) {
        ctx.fillStyle = '#120d09';
        for (const nch of t.niches) {
          ctx.beginPath();
          ctx.arc(nch.p[0] + nch.side * 0.5, nch.p[1] - nch.side * 0.3, 0.45, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
  // 3) Перекрытия
  for (const t of trenches) {
    if (!t.covered || low) continue;
    if (t.covered === 'logs') {
      strokeLine(ctx, t.line, t.width + 1.3, '#6c5840');
      if (ppm >= 3) {
        // Отдельные брёвна поперёк траншеи, торцы, присыпка грунтом
        for (const [p, n] of samplesWithNormals(t.line, 0.32)) {
          const h = hash2(Math.round(p[0] * 10), Math.round(p[1] * 10), 5);
          const L = (t.width + 1.2) / 2 + h * 0.2;
          ctx.strokeStyle = h < 0.5 ? '#7a6344' : '#665238';
          ctx.lineWidth = 0.26;
          ctx.beginPath(); ctx.moveTo(p[0] - n[0] * L, p[1] - n[1] * L); ctx.lineTo(p[0] + n[0] * L, p[1] + n[1] * L); ctx.stroke();
          ctx.fillStyle = '#b39a70';
          ctx.beginPath(); ctx.arc(p[0] + n[0] * L, p[1] + n[1] * L, 0.12, 0, Math.PI * 2); ctx.fill();
        }
      }
      strokeLine(ctx, t.line, t.width + 0.4, spoilColor(t.age, 0.45));
    } else {
      strokeLine(ctx, t.line, t.width + 1.8, 'rgba(84,94,56,0.85)');
      if (ppm >= 3) {
        // Маскировочная сеть: ячейки и лоскуты «листвы»
        strokeLine(ctx, t.line, t.width + 1.6, 'rgba(50,58,32,0.6)', [0.25, 0.35]);
        for (const [p, n] of samplesWithNormals(t.line, 0.45)) {
          const h = hash2(Math.round(p[0] * 7), Math.round(p[1] * 7), 9);
          ctx.fillStyle = h < 0.33 ? 'rgba(104,112,60,0.9)' : h < 0.66 ? 'rgba(70,80,44,0.9)' : 'rgba(120,104,70,0.85)';
          const o = (h - 0.5) * (t.width + 1.2);
          ctx.beginPath(); ctx.ellipse(p[0] + n[0] * o, p[1] + n[1] * o, 0.28, 0.16, h * 6, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
  }
  // Входы в блиндажи
  if (!low)
    for (const f of items)
      if (f.kind === 'dugout') {
        ctx.save();
        ctx.translate(f.x, f.y);
        ctx.rotate(f.angle);
        ctx.fillStyle = '#16110b';
        ctx.fillRect(-0.5, f.h / 2 + 0.3, 1, 1.2);
        ctx.restore();
      }
}

// ---------- Электросеть ----------
function inQ(q, x, y, pad = 60) {
  return x > q.x0 - pad && x < q.x1 + pad && y > q.y0 - pad && y < q.y1 + pad;
}

function drawPowerGround(ctx, world, q, ppm) {
  const p = world.power;
  if (!p) return;
  const m = p.main;
  if (inQ(q, m.x, m.y, 60)) {
    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.rotate(m.angle);
    const hw = m.w / 2, hh = m.h / 2;
    ctx.fillStyle = m.alive ? '#8e8b82' : '#3b3530';
    ctx.fillRect(-hw, -hh, m.w, m.h);
    ctx.strokeStyle = 'rgba(40,40,36,0.8)';
    ctx.lineWidth = 0.3;
    ctx.strokeRect(-hw, -hh, m.w, m.h); // забор
    if (m.alive) {
      // Трансформаторы с радиаторами и шины
      for (const tx of [-14, 0, 14]) {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(tx - 3 + 0.8, -6 + 0.8, 6, 8);
        ctx.fillStyle = '#5c625e';
        ctx.fillRect(tx - 3, -6, 6, 8);
        if (ppm >= 2) {
          ctx.strokeStyle = 'rgba(0,0,0,0.4)';
          ctx.lineWidth = 0.12;
          ctx.beginPath();
          for (let k = -2.5; k < 3; k += 0.7) { ctx.moveTo(tx + k, -6); ctx.lineTo(tx + k, 2); }
          ctx.stroke();
        }
      }
      ctx.strokeStyle = '#c8c6be';
      ctx.lineWidth = 0.25;
      ctx.beginPath();
      for (const yy of [-12, -10, 8, 10]) { ctx.moveTo(-hw + 3, yy); ctx.lineTo(hw - 3, yy); }
      ctx.stroke();
      ctx.fillStyle = '#6d6a62';
      for (const xx of [-20, -8, 8, 20]) ctx.fillRect(xx - 0.5, -13, 1, 25); // порталы
      ctx.fillStyle = '#9c9a92';
      ctx.fillRect(hw - 10, hh - 8, 8, 6); // ОПУ
    } else {
      ctx.fillStyle = 'rgba(20,16,12,0.8)';
      for (const tx of [-14, 0, 14]) { ctx.beginPath(); ctx.arc(tx, -2, 5, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = '#5a4a3a';
      for (let k = 0; k < 20; k++) ctx.fillRect(Math.sin(k * 3.1) * hw * 0.9, Math.cos(k * 1.7) * hh * 0.9, 1.5, 0.6);
    }
    ctx.restore();
  }
  // Будки ТП
  for (const tp of p.tps) {
    if (!inQ(q, tp.x, tp.y, 10)) continue;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(tp.x - 1.5 + 0.8, tp.y - 2 + 0.8, 3, 4);
    ctx.fillStyle = tp.alive ? '#a7a49b' : '#3a3530';
    ctx.fillRect(tp.x - 1.5, tp.y - 2, 3, 4);
    if (tp.alive && ppm >= 3) {
      ctx.fillStyle = '#d9b93a';
      ctx.fillRect(tp.x - 0.35, tp.y - 0.5, 0.7, 0.7); // знак «Опасно»
    }
  }
}

function drawPowerLines(ctx, world, q, ppm) {
  const p = world.power;
  if (!p || ppm < 0.2) return;
  // Фидеры 10 кВ: столбы и провод
  for (const tp of p.tps) {
    const pts = tp.poles;
    ctx.beginPath();
    let on = false;
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i];
      const gap = tp.cut && Math.hypot(x - tp.cut.x, y - tp.cut.y) < 20;
      if (!inQ(q, x, y) || gap) { on = false; continue; }
      if (!on) { ctx.moveTo(x, y); on = true; } else ctx.lineTo(x, y);
    }
    if (ppm >= 0.8) {
      ctx.save();
      ctx.translate(2.5, 2.5);
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.lineWidth = 0.12;
      ctx.stroke(); // тень провода
      ctx.restore();
    }
    ctx.strokeStyle = 'rgba(40,40,40,0.55)';
    ctx.lineWidth = Math.max(0.1, 0.35 / ppm);
    ctx.stroke();
    if (ppm >= 1)
      for (const [x, y] of pts) {
        if (!inQ(q, x, y, 5)) continue;
        ctx.fillStyle = '#4a4238';
        ctx.beginPath(); ctx.arc(x, y, 0.3, 0, Math.PI * 2); ctx.fill();
      }
  }
  // ЛЭП 110 кВ: решётчатые опоры и три провода
  const pl = p.pylons;
  for (let i = 1; i < pl.length; i++) {
    const a = pl[i - 1], b = pl[i];
    if (!inQ(q, a.x, a.y, 300) && !inQ(q, b.x, b.y, 300)) continue;
    if (p.feedCut && (Math.hypot(a.x - p.feedCut.x, a.y - p.feedCut.y) < 1 || Math.hypot(b.x - p.feedCut.x, b.y - p.feedCut.y) < 1)) continue;
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = -(b.y - a.y) / L, ny = (b.x - a.x) / L;
    for (const o of [-3, 0, 3]) {
      ctx.beginPath();
      ctx.moveTo(a.x + nx * o + 5, a.y + ny * o + 5);
      ctx.lineTo(b.x + nx * o + 5, b.y + ny * o + 5);
      ctx.strokeStyle = 'rgba(0,0,0,0.15)';
      ctx.lineWidth = Math.max(0.12, 0.4 / ppm);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(a.x + nx * o, a.y + ny * o);
      ctx.lineTo(b.x + nx * o, b.y + ny * o);
      ctx.strokeStyle = 'rgba(55,55,55,0.6)';
      ctx.stroke();
    }
  }
  for (const t of pl) {
    if (!inQ(q, t.x, t.y, 10)) continue;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(t.x - 2 + 4, t.y - 2 + 4, 4, 4);
    ctx.strokeStyle = '#4b4b48';
    ctx.lineWidth = 0.3;
    ctx.strokeRect(t.x - 2, t.y - 2, 4, 4);
    ctx.beginPath();
    ctx.moveTo(t.x - 2, t.y - 2); ctx.lineTo(t.x + 2, t.y + 2);
    ctx.moveTo(t.x + 2, t.y - 2); ctx.lineTo(t.x - 2, t.y + 2);
    ctx.stroke();
  }
}
