// Отрисовка фрагмента карты (чанка) в «спутниковом» стиле.
// Всё рисуется в мировых координатах (метрах), масштаб ppm = пикселей на метр.

import { fbm, hash2 } from '../rng.js';
import { offsetLine } from '../geom.js';
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

let grain = null;
function grainPattern(ctx) {
  if (grain) return grain;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
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
  drawTrees(ctx, world, b, ppm);

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
const lfCanvas = document.createElement('canvas');

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
      if (r.type === 'dirt') strokeLine(ctx, p, r.width + 2, 'rgba(120,108,80,0.5)');
      else if (r.type === 'street' || r.type === 'avenue') strokeLine(ctx, p, r.width + 5, '#9b978c');
      else strokeLine(ctx, p, r.width + (r.type === 'highway' ? 6 : 4), '#9c9580');
    }
  // 2) покрытие
  for (const { r, parts: ps } of parts)
    for (const p of ps) {
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
  ctx.beginPath();
  pathPoly(ctx, p);
  ctx.fillStyle = bd.roof;
  ctx.fill();

  const long = bd.w >= bd.h;
  // Середины коротких сторон — конёк
  const mid = (a, c) => [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
  if (bd.style === 'gable' || bd.style === 'barn') {
    const r0 = long ? mid(p[0], p[3]) : mid(p[0], p[1]);
    const r1 = long ? mid(p[1], p[2]) : mid(p[3], p[2]);
    // Затенённый скат (на юго-восток)
    ctx.beginPath();
    if (long) { ctx.moveTo(r0[0], r0[1]); ctx.lineTo(r1[0], r1[1]); ctx.lineTo(p[2][0], p[2][1]); ctx.lineTo(p[3][0], p[3][1]); }
    else { ctx.moveTo(r0[0], r0[1]); ctx.lineTo(r1[0], r1[1]); ctx.lineTo(p[2][0], p[2][1]); ctx.lineTo(p[1][0], p[1][1]); }
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fill();
    if (ppm >= 0.8) strokeLine(ctx, [r0, r1], 0.35, 'rgba(255,255,240,0.25)');
  } else if (bd.style === 'flat') {
    // Парапет и тёмная кромка
    if (ppm >= 0.7) {
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.stroke();
    }
    // Вентшахты / выходы на крышу
    if (ppm >= 1.5 && bd.height > 6) {
      const n = Math.floor(Math.max(bd.w, bd.h) / 14);
      ctx.fillStyle = 'rgba(60,58,52,0.55)';
      const c = Math.cos(bd.angle), s = Math.sin(bd.angle);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n - 0.5;
        const u = long ? t * bd.w : 0, v = long ? 0 : t * bd.h;
        ctx.fillRect(bd.x + u * c - v * s - 1, bd.y + u * s + v * c - 1, 2, 2);
      }
    }
  } else if (bd.style === 'hangar' && ppm >= 1) {
    ctx.save();
    ctx.clip();
    const c = Math.cos(bd.angle), s = Math.sin(bd.angle);
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 0.3;
    ctx.beginPath();
    for (let u = -bd.w / 2; u < bd.w / 2; u += 1.2) {
      ctx.moveTo(bd.x + u * c + (bd.h / 2) * s, bd.y + u * s - (bd.h / 2) * c);
      ctx.lineTo(bd.x + u * c - (bd.h / 2) * s, bd.y + u * s + (bd.h / 2) * c);
    }
    ctx.stroke();
    ctx.restore();
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
function drawTrees(ctx, world, b, ppm) {
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
  }
  // Насыпи блиндажей и капониров
  for (const f of items) {
    if (f.kind === 'dugout') {
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
      if (ppm >= 3) strokeLine(ctx, t.line, t.width + 1.1, 'rgba(60,45,30,0.9)', [0.18, 0.2]);
      strokeLine(ctx, t.line, t.width + 0.6, spoilColor(t.age, 0.55));
    } else {
      strokeLine(ctx, t.line, t.width + 1.8, 'rgba(84,94,56,0.85)');
      if (ppm >= 3) strokeLine(ctx, t.line, t.width + 1.6, 'rgba(50,58,32,0.6)', [0.25, 0.35]);
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
