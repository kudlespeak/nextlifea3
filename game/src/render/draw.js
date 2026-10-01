// Отрисовка фрагмента карты (чанка) в «спутниковом» стиле.
// Всё рисуется в мировых координатах (метрах), масштаб ppm = пикселей на метр.

import { fbm, hash2 } from '../rng.js';
import { offsetLine, resample, distToLine } from '../geom.js';
import { CROPS } from '../mapgen.js';
import { M } from '../spatial.js';

const GROUND = '#7b784e';

const AREA_ORDER = ['hill', 'frontzone', 'floodplain', 'vground', 'suburb', 'balka', 'urban', 'farmyard', 'industrial', 'dwsite', 'yard', 'square', 'park', 'plot', 'garden', 'stadium', 'pitch', 'platform', 'dam', 'drive', 'path', 'frontline', 'teeth'];
const AREA_COLORS = {
  floodplain: '#6c7843',
  urban: '#7d7c64',
  yard: '#7c7b5e',
  plot: '#7a7550',
  farmyard: '#8d8466',
  industrial: '#86837b',
  park: '#5c6b3b',
  platform: '#aaa69d',
  square: '#a29e92',
  pitch: '#5f7f41',
  path: '#b0a78c',
  dam: '#8e8a6e',
};
const GARDEN_TONES = [['#6b5b43', '#5f6b3a'], ['#72603f', '#6a7440'], ['#5d5140', '#56663a']];
const TREE_COLORS = ['#2d3922', '#34422a', '#3c4a2c', '#434b2c', '#2a2622', '#5c564b']; // 4 — обугленные, 5 — сухие
const ROAD_RANK = { dirt: 0, village: 1, street: 2, local: 3, ramp: 3.5, avenue: 4, highway: 5 };

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
  const fl = world.fields.query(q).filter((f) => !f.removed); // под стройкой поле убрано
  fl.sort((a, b2) => (CROPS[b2.crop].soft ? 1 : 0) - (CROPS[a.crop].soft ? 1 : 0)); // пятна степи — под полями
  for (const f of fl) drawField(ctx, f, b, ppm);
  drawAreas(ctx, world, b, q, ppm);
  drawLowFreq(ctx, world, b, ppm);
  if (ppm >= 2 && !world.gfxLow) drawMicro(ctx, world, b, ppm);
  const season = world.season;
  if (season === 'autumn') { ctx.fillStyle = 'rgba(160,110,40,0.2)'; ctx.fillRect(b.x0, b.y0, size, size); } // пожухлая трава и стерня
  else if (season === 'spring') { ctx.fillStyle = 'rgba(70,150,50,0.1)'; ctx.fillRect(b.x0, b.y0, size, size); } // молодая зелень
  drawWater(ctx, world, b, q, ppm);
  if (season === 'winter') drawSnow(ctx, world, b, size, ppm); // снег на полях и лёд на реке, дороги расчищены
  const scars = world.scars.query(q);
  for (const s of scars) if (s.kind === 'burn') drawBurn(ctx, s);
  for (const s of scars) if (s.kind === 'tracks') drawTracks(ctx, s, ppm);
  drawRails(ctx, world, b, q, ppm);
  drawRoads(ctx, world, b, q, ppm);
  for (const k of world.areas.query(q)) if (k.kind === 'kpp') drawKpp(ctx, k, ppm);
  drawRailCrossings(ctx, world, b, q, ppm);
  drawForts(ctx, world, q, ppm);
  drawDetours(ctx, world, scars, ppm);
  for (const s of scars) if (s.kind === 'crater') drawCrater(ctx, s, ppm);
  for (const s of scars) if (s.kind === 'wreck') drawWreck(ctx, s, ppm);
  drawBuildings(ctx, world, q, ppm);
  drawPowerGround(ctx, world, q, ppm);
  drawTrees(ctx, world, b, ppm);
  if (season === 'winter') { ctx.fillStyle = 'rgba(236,240,246,0.22)'; ctx.fillRect(b.x0, b.y0, size, size); } // иней на крышах и кронах
  else if (season === 'autumn') drawAutumnLeaves(ctx, world, b, ppm);
  drawPowerLines(ctx, world, q, ppm);

  // Зерно снимка — в пиксельных координатах, со сдвигом, чтобы чанки стыковались
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const pat = grainPattern(ctx);
  const ox = Math.round(b.x0 * ppm) % 128, oy = Math.round(b.y0 * ppm) % 128;
  pat.setTransform(new DOMMatrix([1, 0, 0, 1, -ox, -oy]));
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, size * ppm, size * ppm);
}

// ---------- Времена года ----------
// Зима: снежный покров (сквозь него едва читаются борозды полей и пятна степи), лёд на реках
function drawSnow(ctx, world, b, size, ppm) {
  ctx.fillStyle = 'rgba(236,240,245,0.8)';
  ctx.fillRect(b.x0, b.y0, size, size);
  // лёд на реках и прудах — голубоватый, с тёмными промоинами у середины
  for (const w of world.water.query({ x0: b.x0 - 10, y0: b.y0 - 10, x1: b.x1 + 10, y1: b.y1 + 10 })) {
    if (w.line) { strokeLine(ctx, w.line, (w.width || 20) * 0.9, 'rgba(196,214,228,0.55)'); if (w.width > 30) strokeLine(ctx, w.line, w.width * 0.12, 'rgba(70,96,120,0.35)'); }
    else if (w.poly) { ctx.beginPath(); pathPoly(ctx, w.poly); ctx.fillStyle = 'rgba(196,214,228,0.55)'; ctx.fill(); }
  }
}
// Осень: жёлто-рыжие пятна крон в лесополосах
function drawAutumnLeaves(ctx, world, b, ppm) {
  if (ppm < 0.3) return;
  for (const belt of world.belts.query({ x0: b.x0 - 20, y0: b.y0 - 20, x1: b.x1 + 20, y1: b.y1 + 20 })) {
    strokeLine(ctx, belt.line, belt.width * 0.9, 'rgba(200,130,40,0.28)');
  }
}

// КПП на дороге у линии фронта: змейка из бетонных блоков, шлагбаум, будка, мешки с песком, флаг
function drawKpp(ctx, k, ppm) {
  ctx.save(); ctx.translate(k.x, k.y); ctx.rotate(k.angle);
  const hw = (k.w || 8) / 2;
  const block = (x, y, w, h) => { ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(x - w / 2 + 0.5, y - h / 2 + 0.6, w, h); ctx.fillStyle = '#c4c0b4'; ctx.fillRect(x - w / 2, y - h / 2, w, h); };
  // змейка: блоки поочерёдно с разных сторон дороги
  for (let i = 0; i < 4; i++) { const x = -14 + i * 9, y = (i % 2 ? 1 : -1) * (hw - 2.2); block(x, y, 1.6, hw + 0.5); }
  if (ppm >= 0.6) {
    // шлагбаум
    ctx.strokeStyle = '#e6e2d8'; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.moveTo(22, -hw - 1); ctx.lineTo(22, hw - 1); ctx.stroke();
    ctx.strokeStyle = '#c8321f'; ctx.setLineDash([1, 1]); ctx.beginPath(); ctx.moveTo(22, -hw - 1); ctx.lineTo(22, hw - 1); ctx.stroke(); ctx.setLineDash([]);
  }
  // будка и мешки с песком на обочине
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(18.6, hw + 2.6, 5, 4);
  ctx.fillStyle = '#7d8a6a'; ctx.fillRect(18, hw + 2, 5, 4);
  ctx.strokeStyle = '#9a8a62'; ctx.lineWidth = 1.1;
  ctx.beginPath(); ctx.arc(8, -hw - 5, 3.2, Math.PI * 0.1, Math.PI * 1.9); ctx.stroke();
  // флагшток с флагом стороны
  ctx.fillStyle = k.side === 'blue' ? '#3d6fb8' : '#b8423d'; ctx.fillRect(26, hw + 3, 3, 2);
  ctx.fillStyle = '#e0dccf'; ctx.fillRect(25.7, hw + 3, 0.3, 5);
  ctx.restore();
}
// ---------- Фон степи: пятна травы разной сухости ----------
function drawSteppeTexture(ctx, world, b, ppm) {
  const size = b.x1 - b.x0;
  const G = 48;
  // Крупные плавные переходы (выгоревшие склоны, зелёные понижения) + мягкая средняя пятнистость;
  // контраст невысокий — без «камуфляжа»
  const img = lowFreqImage(G, (wx, wy) => {
    const big = fbm(wx / 2200, wy / 2200, world.seed + 31, 3);
    const mid = fbm(wx / 420, wy / 420, world.seed + 57, 3);
    const t = Math.min(1, Math.max(0, (big - 0.5) * 1.6 + (mid - 0.5) * 0.55 + 0.5));
    const g2 = fbm(wx / 900, wy / 900, world.seed + 91, 2) - 0.5; // оттенок: чуть зеленее / суше
    return [lerp(112, 146, t) - g2 * 10, lerp(116, 136, t) + g2 * 6, lerp(70, 88, t) - g2 * 4, 255];
  }, b);
  ctx.imageSmoothingEnabled = true;
  drawLF(ctx, img, G, b, size);
}
// Отсчёты шума берутся на краях чанка включительно и рисуются от центра первого пикселя до центра
// последнего — соседние чанки делят краевые отсчёты, швов нет
function drawLF(ctx, img, G, b, size) {
  ctx.drawImage(img, 0.5, 0.5, G - 1, G - 1, b.x0, b.y0, size, size);
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
      const [r, gg, bb, a] = fn(b.x0 + (i / (G - 1)) * size, b.y0 + (j / (G - 1)) * size);
      const k = (j * G + i) * 4;
      img.data[k] = r; img.data[k + 1] = gg; img.data[k + 2] = bb; img.data[k + 3] = a;
    }
  g.putImageData(img, 0, 0);
  return lfCanvas;
}

// Мелкая фактура вблизи: пучки травы, стерня, комья земли (штрихи двух тонов одной заливкой)
// Микротекстура травы (штрихи и крапинки): плитка 97×97 м, нарисованная один раз на масштаб и
// привязанная к мировым координатам. Дороги, вода и дома рисуются поверх, так что маска не нужна
const MICRO_T = 97;
const microTiles = new Map();
function microPattern(ctx, ppm) {
  let pat = microTiles.get(ppm);
  if (pat) return pat;
  const step = ppm >= 8 ? 0.3 : ppm >= 4 ? 0.5 : 0.9, len = step * 0.9;
  const px = Math.round(MICRO_T * ppm), k = px / MICRO_T;
  const cv = mkCanvas(px, px), g = cv.getContext('2d');
  g.scale(k, k);
  const light = new Path2D(), dark = new Path2D(), dots = new Path2D();
  const n = Math.round(MICRO_T / step);
  for (let iy = 0; iy < n; iy++)
    for (let ix = 0; ix < n; ix++) {
      const h = hash2(ix, iy, 991);
      if (h < 0.35) continue;
      const x = ix * step + hash2(ix, iy, 13) * step, y = iy * step + hash2(ix, iy, 29) * step;
      // у краёв плитки — копии штриха по ту сторону, чтобы шов не был виден
      for (const ox of x < 1 ? [0, MICRO_T] : x > MICRO_T - 1 ? [0, -MICRO_T] : [0])
        for (const oy of y < 1 ? [0, MICRO_T] : y > MICRO_T - 1 ? [0, -MICRO_T] : [0]) {
          const qx = x + ox, qy = y + oy;
          if (h > 0.93) { dots.moveTo(qx + len * 0.2, qy); dots.arc(qx, qy, len * 0.2, 0, Math.PI * 2); continue; }
          const a = hash2(ix, iy, 7) * Math.PI, dx = Math.cos(a) * len * 0.5, dy = Math.sin(a) * len * 0.5;
          const path = h < 0.64 ? dark : light;
          path.moveTo(qx - dx, qy - dy); path.lineTo(qx + dx, qy + dy);
        }
    }
  g.lineWidth = step * 0.16; g.lineCap = 'round';
  g.strokeStyle = 'rgba(40,44,18,0.22)'; g.stroke(dark);
  g.strokeStyle = 'rgba(214,206,150,0.2)'; g.stroke(light);
  g.fillStyle = 'rgba(60,48,30,0.22)'; g.fill(dots);
  pat = { cv, k };
  microTiles.set(ppm, pat);
  return pat;
}
function drawMicro(ctx, world, b, ppm) {
  const { cv, k } = microPattern(ctx, ppm);
  const pat = ctx.createPattern(cv, 'repeat');
  pat.setTransform(new DOMMatrix([1 / k, 0, 0, 1 / k, 0, 0])); // плитка в метрах, от начала мира
  ctx.fillStyle = pat;
  ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
}

// Крупные светлые/тёмные разводы поверх полей (влажность, рельеф)
function drawLowFreq(ctx, world, b, ppm) {
  const size = b.x1 - b.x0;
  const img = lowFreqImage(40, (wx, wy) => {
    const n = fbm(wx / 420, wy / 420, world.seed + 77, 3) * 0.7 + fbm(wx / 120, wy / 120, world.seed + 13, 2) * 0.3;
    const d = n - 0.5;
    return d < 0 ? [30, 28, 10, Math.min(255, -d * 110)] : [255, 245, 215, Math.min(255, d * 70)];
  }, b);
  drawLF(ctx, img, 40, b, size);
}

// ---------- Поле ----------
function drawField(ctx, f, b, ppm) {
  const crop = CROPS[f.crop];
  if (crop.soft) {
    // пятно степи: без межи и борозд, края растушёваны двумя проходами
    ctx.fillStyle = crop.color;
    ctx.globalAlpha = crop.soft * 0.5;
    ctx.beginPath(); pathPoly(ctx, f.poly); ctx.fill();
    ctx.lineJoin = 'round'; ctx.lineWidth = 60; ctx.strokeStyle = crop.color; ctx.globalAlpha = crop.soft * 0.25; ctx.stroke();
    ctx.globalAlpha = crop.soft * 0.6;
    const [cx, cy] = f.poly.reduce((a, p) => [a[0] + p[0] / f.poly.length, a[1] + p[1] / f.poly.length], [0, 0]);
    ctx.beginPath(); pathPoly(ctx, f.poly.map(([x, y]) => [cx + (x - cx) * 0.7, cy + (y - cy) * 0.7])); ctx.fill();
    ctx.globalAlpha = 1;
    return;
  }
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
  if (crop.furrow && ppm >= 0.6) {
    const sp = ppm >= 2 ? 1.6 : ppm >= 1 ? 3 : 6;
    ctx.globalAlpha = ppm >= 2 ? 0.8 : 0.45; // издали рядки сливаются
    ctx.beginPath();
    const start = Math.floor(mn / sp) * sp;
    for (let off = start; off <= mx; off += sp) {
      ctx.moveTo(nx * off + dx * amn, ny * off + dy * amn);
      ctx.lineTo(nx * off + dx * amx, ny * off + dy * amx);
    }
    ctx.lineWidth = sp * 0.35;
    ctx.strokeStyle = crop.furrow;
    ctx.stroke();
    ctx.globalAlpha = 1;
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
  if (crop.dots && ppm >= 4) {
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
  ctx.lineWidth = 24;
  ctx.strokeStyle = 'rgba(70,60,30,0.07)';
  ctx.stroke();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'rgba(105,100,62,0.35)'; // межа
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
    for (const a of items) if (!(kind === 'dwsite' && fogHidden(world, a.side, a.oid))) drawArea(ctx, a, b, ppm);
  }
}
// Туман войны «Войны дронов»: объект противника, ещё не найденный разведкой, на карте не виден
export function fogHidden(world, side, oid) {
  const F = world.fog;
  if (!F || !F.on || side === undefined || side === F.side || oid === undefined || oid === null) return false;
  return !F.known.has(oid);
}

// Свободные от сооружений полосы для внутренних проездов площадки (в её локальных координатах)
function siteDrive(a) {
  if (a._drive) return a._drive;
  const hw = a.w / 2, hh = a.h / 2, fp = a.fp || [];
  const hitsU = (v0, v1, u0 = -hw, u1 = hw) => fp.some(([u, v, w, h]) => v + h / 2 > v0 && v - h / 2 < v1 && u + w / 2 > u0 && u - w / 2 < u1);
  let v = null;
  for (let d = 0; d <= hh - 6 && v === null; d += 2) for (const s of [1, -1]) if (v === null && !hitsU(s * d - 4.5, s * d + 4.5)) v = s * d;
  // от ворот: вдоль оси ворот со сдвигом, пока полоса не свободна — до продольного проезда или до центра
  let g = null;
  if (a.gateQ !== undefined) {
    const gq = a.gateQ, along = Math.abs(Math.cos(gq)) > 0.5;
    if (along) {
      const sg = Math.cos(gq) > 0 ? 1 : -1, stop = 0;
      for (let d = 0; d <= hh - 6 && !g; d += 2) for (const s of [1, -1]) {
        const y = s * d, u0 = Math.min(sg * hw, stop), u1 = Math.max(sg * hw, stop);
        if (!g && !hitsU(y - 3.5, y + 3.5, u0, u1)) g = [u0, y - 3.5, u1 - u0, 7];
      }
    } else {
      const sg = Math.sin(gq) > 0 ? 1 : -1, stop = v ?? 0;
      const v0 = Math.min(sg * hh, stop), v1 = Math.max(sg * hh, stop);
      for (let d = 0; d <= hw - 6 && !g; d += 2) for (const s of [1, -1]) {
        const x = s * d;
        if (!g && !fp.some(([u, vv, w, h]) => u + w / 2 > x - 3.5 && u - w / 2 < x + 3.5 && vv + h / 2 > v0 && vv - h / 2 < v1)) g = [x - 3.5, v0, 7, v1 - v0];
      }
    }
  }
  return (a._drive = { v, g });
}

function drawArea(ctx, a, b, ppm) {
  switch (a.kind) {
    case 'hill': {
      // Холм: мягкая светотень (склон к солнцу светлее, обратный — темнее)
      const gr = ctx.createRadialGradient(a.x - a.r * 0.35, a.y - a.r * 0.35, a.r * 0.1, a.x, a.y, a.r * 1.1);
      gr.addColorStop(0, `rgba(255,250,215,${0.1 * a.h})`);
      gr.addColorStop(0.55, 'rgba(0,0,0,0)');
      gr.addColorStop(1, `rgba(20,24,10,${0.14 * a.h})`);
      ctx.beginPath();
      pathPoly(ctx, a.poly);
      ctx.fillStyle = gr;
      ctx.fill();
      break;
    }
    case 'frontzone': {
      // серая зона: выгоревшая, изрытая земля между позициями
      ctx.beginPath(); pathPoly(ctx, a.poly);
      ctx.fillStyle = 'rgba(96,84,60,0.5)'; ctx.fill();
      ctx.save(); ctx.clip();
      for (let y = Math.floor(b.y0 / 60) * 60; y < b.y1; y += 60)
        for (let x = Math.floor(b.x0 / 60) * 60; x < b.x1; x += 60) {
          const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453, f = h - Math.floor(h);
          if (f < 0.55) continue;
          ctx.fillStyle = `rgba(${f > 0.85 ? '40,34,26' : '70,60,44'},${0.25 + (f - 0.55) * 0.5})`;
          ctx.beginPath(); ctx.ellipse(x + f * 40, y + (1 - f) * 40, 6 + f * 14, 5 + f * 10, f * 3, 0, Math.PI * 2); ctx.fill();
        }
      ctx.restore();
      break;
    }
    case 'frontline': {
      // линия окопов издали — бурая извилистая полоса (вблизи её рисуют сами траншеи)
      if (ppm >= 0.9) break;
      strokeLine(ctx, a.line, Math.max(5, 2.2 / ppm), a.side === 'blue' ? 'rgba(70,58,40,0.85)' : 'rgba(78,56,40,0.85)');
      break;
    }
    case 'teeth': {
      // противотанковые «зубы драконов» — три ряда бетонных пирамидок
      const [p, q] = a.line, L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, dx = (q[0] - p[0]) / L, dy = (q[1] - p[1]) / L;
      if (ppm < 0.35) { strokeLine(ctx, a.line, Math.max(2, 1.2 / ppm), 'rgba(170,166,154,0.7)'); break; }
      for (let t = 0; t < L; t += 3) for (const r of [-3, 0, 3]) {
        const x = p[0] + dx * (t + (r ? 1.5 : 0)) - dy * r, y = p[1] + dy * (t + (r ? 1.5 : 0)) + dx * r;
        ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(x - 0.4, y - 0.2, 1.4, 1.4);
        ctx.fillStyle = '#b8b4a8'; ctx.fillRect(x - 0.6, y - 0.6, 1.2, 1.2);
      }
      break;
    }
    case 'dwsite': {
      if (a.site === 'wpp') {
        // ветропарк: площадки у башен и полевая дорога между ними, без сплошной отсыпки
        ctx.save(); ctx.translate(a.x, a.y); ctx.rotate(a.angle);
        const pts = a.fp.filter((f) => f[4] === 'wt');
        ctx.strokeStyle = 'rgba(150,138,110,0.8)'; ctx.lineWidth = 5; ctx.lineJoin = 'round';
        ctx.beginPath(); pts.forEach(([u, v], i) => (i ? ctx.lineTo(u, v) : ctx.moveTo(u, v)));
        const o = a.fp.find((f) => f[4] === 'oru'); if (o) ctx.lineTo(o[0], o[1]);
        ctx.stroke();
        ctx.fillStyle = '#8f8b7c';
        for (const [u, v] of pts) ctx.fillRect(u - 12, v - 12, 24, 24);
        if (o) { ctx.fillRect(o[0] - 28, o[1] - 24, 56, 64); ctx.strokeStyle = 'rgba(55,55,50,0.9)'; ctx.lineWidth = Math.max(0.25, 0.6 / ppm); ctx.strokeRect(o[0] - 28, o[1] - 24, 56, 64); }
        ctx.restore();
        break;
      }
      // Прилегающая территория: выкошенная полоса вокруг ограды, площадка (щебень/асфальт/гравий),
      // забор с воротами, у магазинов и АЗС — парковка с разметкой
      const civil = ['mall', 'market', 'store', 'fuel', 'hub', 'border', 'firest', 'rembase'].includes(a.site);
      if (a.apron) {
        ctx.beginPath(); pathPoly(ctx, a.apron);
        ctx.fillStyle = civil ? 'rgba(122,128,86,0.9)' : 'rgba(128,132,88,0.92)';
        ctx.fill();
        if (ppm >= 0.4) { ctx.lineWidth = Math.max(0.3, 0.5 / ppm); ctx.strokeStyle = 'rgba(80,84,50,0.35)'; ctx.stroke(); }
      }
      ctx.beginPath();
      pathPoly(ctx, a.poly);
      const paved = a.site === 'mall' || a.site === 'market' || a.site === 'fuel' || a.site === 'hub' || a.site === 'border';
      ctx.fillStyle = a.site === 'bridge' ? 'rgba(0,0,0,0)' : paved ? '#6b6c68' : a.site === 'ammo' ? '#6d6b4d' : a.site === 'store' ? '#7d7a70' : a.site === 'tpp' || a.site === 'factory' ? '#8d8a80' : '#8f8b7c';
      ctx.fill();
      if (ppm >= 0.5) {
        ctx.save();
        ctx.clip();
        ctx.translate(a.x, a.y);
        ctx.rotate(a.angle);
        const hw = a.w / 2, hh = a.h / 2;
        if (paved) {
          // разметка парковки: ряды мест 2.6 м
          ctx.strokeStyle = 'rgba(235,235,225,0.55)';
          ctx.lineWidth = 0.15;
          ctx.beginPath();
          const py = a.site === 'fuel' ? null : hh - 7;
          if (py !== null) for (let u = -hw + 4; u < hw - 4; u += 2.6) { ctx.moveTo(u, py - 5); ctx.lineTo(u, py); ctx.moveTo(u, -hh + 2); ctx.lineTo(u, -hh + 7); }
          ctx.stroke();
          ctx.fillStyle = 'rgba(40,40,38,0.25)';
          ctx.fillRect(-hw, -1.5, a.w, 3);
        } else {
          ctx.strokeStyle = 'rgba(60,58,50,0.25)';
          ctx.lineWidth = 0.4;
          ctx.beginPath();
          const step = a.site === 'ps330' || a.site === 'ps110' ? 12 : 30;
          for (let u = -hw; u <= hw; u += step) { ctx.moveTo(u, -hh); ctx.lineTo(u, hh); }
          ctx.stroke();
        }
        // проезды не идут сквозь сооружения: продольный — по ближайшей к оси свободной полосе,
        // от ворот — по свободной полосе до продольного
        const band = siteDrive(a);
        if (!paved && band.v !== null && a.w > 60) { ctx.fillStyle = 'rgba(70,70,66,0.55)'; ctx.fillRect(-hw, band.v - 4, a.w, 8); }
        if (a.gateQ !== undefined && band.g) {
          ctx.fillStyle = paved ? 'rgba(55,56,54,0.9)' : 'rgba(78,76,70,0.8)';
          const [x, y, w, h] = band.g; ctx.fillRect(x, y, w, h);
        }
        ctx.restore();
      }
      if (ppm < 0.5 && a.fp) {
        // издали — силуэты сооружений (на ближнем масштабе их рисует 3D-слой)
        ctx.save(); ctx.translate(a.x, a.y); ctx.rotate(a.angle);
        for (const [u, v, w, h, k] of a.fp) {
          const round = k === 'tank' || k === 'tower' || k === 'chimney' || k === 'wt';
          ctx.fillStyle = k === 'coal' ? '#2a2826' : k === 'tank' || k === 'tower' ? '#c9c7bf' : k === 'oru' ? 'rgba(120,120,112,0.9)' : k === 'pv' ? '#2c3b52' : '#76786f';
          if (round) { ctx.beginPath(); ctx.arc(u, v, Math.max(w, h) / 2, 0, Math.PI * 2); ctx.fill(); }
          else ctx.fillRect(u - w / 2, v - h / 2, w, h);
        }
        ctx.restore();
      }
      if (a.site !== 'bridge') {
        ctx.save();
        ctx.beginPath();
        pathPoly(ctx, a.poly);
        ctx.strokeStyle = civil ? 'rgba(70,72,68,0.7)' : 'rgba(55,55,50,0.9)';
        ctx.lineWidth = Math.max(0.25, 0.6 / ppm);
        ctx.setLineDash(ppm >= 1 ? [2.5, 0.8] : []);
        ctx.stroke();
        ctx.restore();
      }
      break;
    }
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
    case 'drive':
      strokeLine(ctx, a.line, a.width, '#5c5d59');
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
        // у берега — мелководье светлее и теплее, к стрежню — глубже и холоднее
        if (w.width > 12) { strokeLine(ctx, offsetLine(part, w.width * 0.42), w.width * 0.16, 'rgba(92,104,84,0.35)'); strokeLine(ctx, offsetLine(part, -w.width * 0.42), w.width * 0.16, 'rgba(92,104,84,0.35)'); }
        strokeLine(ctx, part, w.width * 0.55, '#304c50');
        strokeLine(ctx, part, w.width * 0.25, '#2a4549');
        if (ppm >= 0.8 && w.width > 12) {
          // струи течения и блики — короткие светлые штрихи вдоль русла
          const k = Math.round(part[0][0] * 7 + part[0][1] * 3);
          for (const [o, a] of [[-0.22, 0.16], [0.12, 0.12], [0.3, 0.1]]) strokeLine(ctx, offsetLine(part, w.width * o), Math.max(0.3, 0.5 / ppm), `rgba(190,210,212,${a})`, [3 + (k % 5), 11 + (k % 7)]);
        }
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

// Переезды: где дорога пересекает путь, поверх покрытия — настил и рельсы (рельсы не «тонут» под грунтовкой)
function drawRailCrossings(ctx, world, b, q, ppm) {
  if (ppm < 0.5) return;
  const rails = world.rails.query(q);
  if (!rails.length) return;
  const roads = world.roads.query(q);
  for (const r of rails) for (const part of clipLine(r.line, b, 20)) {
    for (let i = 1; i < part.length; i++) {
      const a = part[i - 1], c = part[i];
      const mx = (a[0] + c[0]) / 2, my = (a[1] + c[1]) / 2;
      if (!world.mask.has(mx, my, M.ROAD)) continue;
      const road = roads.find((rd) => distToLine(mx, my, rd.line) < rd.width / 2 + 2);
      if (!road || road.type === 'highway' || road.type === 'avenue') continue; // там путепровод
      const seg = [a, c];
      strokeLine(ctx, seg, Math.min(road.width, 6), road.type === 'dirt' ? '#a0907a' : road.type === 'village' ? '#5f5e59' : '#555653'); // покрытие дороги на переезде
      const w = Math.max(0.18, 0.6 / ppm);
      strokeLine(ctx, offsetLine(seg, -0.76), w, '#2f2d2a');
      strokeLine(ctx, offsetLine(seg, 0.76), w, '#2f2d2a');
    }
  }
}

// Объезд воронки на дороге: машины накатали колею по обочине в обход ямы
function drawDetours(ctx, world, scars, ppm) {
  if (ppm < 0.5) return;
  for (const c of scars) {
    if (c.kind !== 'crater' || (c.r || 0) < 1.5) continue;
    let best = null, bd = Infinity, bt = null;
    for (const r of world.roads.query({ x0: c.x - 20, y0: c.y - 20, x1: c.x + 20, y1: c.y + 20 }, false)) {
      if (r.type === 'dirt') continue;
      for (let i = 1; i < r.line.length; i++) {
        const a = r.line[i - 1], b = r.line[i], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
        const u = Math.max(0, Math.min(1, ((c.x - a[0]) * dx + (c.y - a[1]) * dy) / L2)), d = Math.hypot(a[0] + dx * u - c.x, a[1] + dy * u - c.y);
        if (d < bd) { bd = d; best = r; const L = Math.sqrt(L2); bt = [dx / L, dy / L]; }
      }
    }
    if (!best || bd > best.width / 2 + c.r * 0.5) continue;
    const w = best.type === 'highway' ? 13 : best.width / 2, off = w + c.r + 3.5;
    const nx = -bt[1], ny = bt[0], D = c.r * 3 + 14;
    const pts = [];
    for (let k = 0; k <= 12; k++) { const tt = -1 + (2 * k) / 12, bump = Math.cos((tt * Math.PI) / 2); pts.push([c.x + bt[0] * tt * D + nx * off * bump, c.y + bt[1] * tt * D + ny * off * bump]); }
    strokeLine(ctx, pts, 4, 'rgba(112,96,70,0.85)');
    if (ppm >= 1) { strokeLine(ctx, offsetLine(pts, -0.9), 0.5, 'rgba(80,66,46,0.8)'); strokeLine(ctx, offsetLine(pts, 0.9), 0.5, 'rgba(80,66,46,0.8)'); }
  }
}

// ---------- Дороги ----------
function bridgeRuns(world, road) {
  if (road._bridges) return road._bridges;
  const runs = [];
  let cur = null;
  for (let i = 0; i < road.line.length; i++) {
    const [x, y] = road.line[i];
    // вода — мост; железная дорога под трассой или проспектом — путепровод (не переезд)
    const over = (road.type === 'highway' || road.type === 'avenue') && world.mask.has(x, y, M.RAIL);
    const wet = over || (world.mask.has(x, y, M.WATER) && world.mask.near(x, y, 6, M.WATER));
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
        case 'village': {
          // улица в селе — асфальт; перемычка в поле — щебёнка
          const m = p[Math.floor(p.length / 2)];
          const gravel = !world.mask.has(m[0], m[1], M.VILLAGE | M.CITY | M.CITYZONE);
          strokeLine(ctx, p, r.width, gravel ? '#7f796c' : '#5f5e59');
          if (gravel && ppm >= 1.5) strokeLine(ctx, p, r.width * 0.8, 'rgba(160,150,130,0.35)', [0.3, 0.9]);
          break;
        }
        default:
          strokeLine(ctx, p, r.width, r.type === 'local' ? '#555653' : '#535350');
      }
    }
  ctx.lineCap = 'round';
  // Мосты: парапеты
  for (const { r } of parts)
    for (const run of bridgeRuns(world, r)) drawParapets(ctx, run, r.width / 2 + 0.8);
  // Узлы: переходно-скоростные полосы у трассы, скруглённые углы примыканий и перекрёстков
  const nodes = junctionNodes(world).filter((n) => inQ(q, n.x, n.y, 120));
  for (const n of nodes) if (n.main.type === 'highway' && n.sub.type !== 'dirt') speedLanes(ctx, n, ppm);
  for (const n of nodes) fillets(ctx, n);
  if (ppm >= 0.9) drawBusStops(ctx, world, q, ppm);

  // 3) разметка (путепроводы — после неё, поверх трассы): у примыканий разметка второстепенной дороги обрывается стоп-линией, а краевая
  // линия главной — разрывается (второстепенная дорога не «прорезает» трассу и разделительный газон)
  if (ppm >= 0.9) {
    const white = 'rgba(225,222,210,0.85)';
    const J = junctions(world);
    const near = (r) => J.filter((j) => (j.sub === r || j.main === r) && inQ(q, j.x, j.y, 60));
    const cut = (line, js, pad) => {
      if (!js.length) return [line];
      const out = [];
      let cur = [];
      for (const pt of line) {
        const hit = js.some((j) => Math.hypot(pt[0] - j.x, pt[1] - j.y) < j.r + pad(j));
        if (hit) { if (cur.length > 1) out.push(cur); cur = []; } else cur.push(pt);
      }
      if (cur.length > 1) out.push(cur);
      return out;
    };
    for (const { r, parts: ps } of parts) {
      const js = near(r);
      const asSub = js.filter((j) => j.sub === r), asMain = js.filter((j) => j.main === r);
      for (const p0 of ps) {
        const fine = resample(p0, 4);
        if (r.type === 'highway') {
          const xm = nodes.filter((n) => n.cross && n.main === r).map((n) => ({ x: n.x, y: n.y, r: 0, sub: n.sub }));
          for (const p of cut(fine, [...asMain, ...xm], (j) => j.sub.width / 2 + 2)) for (const s of [-1, 1]) strokeLine(ctx, offsetLine(p, s * 11.6), 0.18, white);
          for (const s of [-1, 1]) {
            strokeLine(ctx, offsetLine(p0, s * 6.8), 0.15, white, [3, 9]);
            strokeLine(ctx, offsetLine(p0, s * 2), 0.18, white);
          }
        } else if (r.type === 'local' || r.type === 'avenue') {
          // осевая второстепенной обрывается на перекрёстке «иксом»
          const xs = nodes.filter((n) => n.cross && n.sub === r).map((n) => ({ x: n.x, y: n.y, r: (n.main.type === 'highway' ? 13 : n.main.width / 2) + 2 }));
          for (const p of cut(fine, [...asSub, ...xs], () => 3)) strokeLine(ctx, p, 0.15, white, [3, 6]);
        }
        // стоп-линии перед перекрёстком «иксом» — с обеих сторон главной
        if (r.type !== 'dirt')
          for (const n of nodes) {
            if (!n.cross || n.sub !== r) continue;
            const hwM = n.main.type === 'highway' ? 13 : n.main.width / 2, cx = n.x + n.u[0] * (hwM + 2), cy = n.y + n.u[1] * (hwM + 2), hw = r.width / 2 - 0.3;
            ctx.beginPath(); ctx.moveTo(cx - n.u[1] * hw, cy + n.u[0] * hw); ctx.lineTo(cx + n.u[1] * hw, cy - n.u[0] * hw);
            ctx.lineWidth = 0.4; ctx.strokeStyle = white; ctx.stroke();
          }
        // стоп-линия на второстепенной дороге перед главной
        if (r.type !== 'dirt' && r.type !== 'street')
          for (const j of asSub) {
            const L = Math.hypot(j.dx, j.dy) || 1, ux = j.dx / L, uy = j.dy / L; // направление от главной дороги вдоль второстепенной
            const cx = j.x + ux * (j.r + 1.5), cy = j.y + uy * (j.r + 1.5);
            const hw = r.width / 2 - 0.3;
            ctx.beginPath(); ctx.moveTo(cx - uy * hw, cy + ux * hw); ctx.lineTo(cx + uy * hw, cy - ux * hw);
            ctx.lineWidth = 0.4; ctx.strokeStyle = white; ctx.stroke();
          }
      }
    }
  }
  drawRoundabouts(ctx, world, q, ppm); // поверх разметки: кольцо не перечёркивают полосы трассы
  drawOverpasses(ctx, world, q, ppm);
  if (ppm >= 1.5) drawZebras(ctx, world, q);
  if (ppm >= 2) drawSigns(ctx, nodes, world, q);
}

// Круговая развязка: асфальтовое кольцо, центральный островок с газоном и бордюром, разметка
function drawRoundabouts(ctx, world, q, ppm) {
  for (const c of world.roundabouts || []) {
    if (!inQ(q, c.x, c.y, c.r + 20)) continue;
    const disc = (r, col) => { ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); };
    disc(c.r + 3, '#9c9580');
    disc(c.r, '#555653');
    disc(c.r * 0.5 + 1, '#b7b3a8'); // бордюр
    disc(c.r * 0.5, '#6f7d48'); // газон
    if (ppm >= 0.9) {
      ctx.beginPath(); ctx.arc(c.x, c.y, c.r * 0.75, 0, Math.PI * 2);
      ctx.setLineDash([2, 3]); ctx.lineWidth = 0.18; ctx.strokeStyle = 'rgba(225,222,210,0.8)'; ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#4f6a3a'; for (let k = 0; k < 5; k++) { const a = k * 1.3; ctx.beginPath(); ctx.arc(c.x + Math.cos(a) * c.r * 0.22, c.y + Math.sin(a) * c.r * 0.22, 1.4, 0, Math.PI * 2); ctx.fill(); } // кусты на островке
    }
  }
}
// Остановка: карман у обочины и павильон со стороны села
function drawBusStops(ctx, world, q, ppm) {
  for (const st of world.stops || []) {
    if (!inQ(q, st.x, st.y, 40)) continue;
    const nx = -st.ty * st.side, ny = st.tx * st.side;
    const P = (d, o) => [st.x + st.tx * d + nx * (st.w + o), st.y + st.ty * d + ny * (st.w + o)];
    ctx.beginPath(); pathPoly(ctx, [P(-22, 0), P(-12, 3.2), P(12, 3.2), P(22, 0)]); ctx.fillStyle = '#555653'; ctx.fill();
    if (ppm >= 1.5) { ctx.strokeStyle = 'rgba(225,222,210,0.8)'; ctx.lineWidth = 0.15; ctx.beginPath(); const a = P(-12, 0.1), b = P(12, 0.1); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.setLineDash([1, 1]); ctx.stroke(); ctx.setLineDash([]); }
    // павильон: тень, стенка, кровля
    const box = (o0, o1, d0, d1) => [P(d0, o0), P(d1, o0), P(d1, o1), P(d0, o1)];
    ctx.beginPath(); pathPoly(ctx, box(5.2, 6.8, -2.4, 2.4).map(([x, y]) => [x + 1.2, y + 1.4])); ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fill();
    ctx.beginPath(); pathPoly(ctx, box(5.2, 6.8, -2.4, 2.4)); ctx.fillStyle = '#4f7fa8'; ctx.fill();
    ctx.beginPath(); pathPoly(ctx, box(6.4, 6.8, -2.4, 2.4)); ctx.fillStyle = '#2f3a44'; ctx.fill();
  }
}
// Знаки у узлов: «Уступи дорогу» (треугольник) на второстепенной, указатель на трассе перед съездом
function drawSigns(ctx, nodes, world, q) {
  for (const n of nodes) {
    if (!inQ(q, n.x, n.y, 60) || n.sub.type === 'dirt') continue;
    const hwM = n.main.type === 'highway' ? 13 : n.main.width / 2, side = [-n.u[1], n.u[0]];
    // справа по ходу к главной: направление движения к перекрёстку — −u, правая сторона — (−u) повернуть по часовой
    const rx = n.u[1], ry = -n.u[0];
    const sx = n.x + n.u[0] * (hwM + 5) + rx * (n.sub.width / 2 + 1.6), sy = n.y + n.u[1] * (hwM + 5) + ry * (n.sub.width / 2 + 1.6);
    void side;
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(sx + 0.4, sy + 0.5, 0.9, 0.2);
    ctx.fillStyle = '#e8e6de'; ctx.beginPath(); ctx.moveTo(sx, sy - 0.75); ctx.lineTo(sx + 0.7, sy + 0.5); ctx.lineTo(sx - 0.7, sy + 0.5); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#c0302a'; ctx.lineWidth = 0.18; ctx.stroke();
    if (n.main.type === 'highway' && !n.cross) {
      // указатель направления — синий щит за 80 м до съезда
      const d = 80, bx = n.x - n.t[0] * d + (n.x + n.u[0] - n.x) * (hwM + 3), by = n.y - n.t[1] * d + n.u[1] * (hwM + 3);
      ctx.fillStyle = '#2f5d9e'; ctx.fillRect(bx - 1.2, by - 0.35, 2.4, 0.7);
      ctx.fillStyle = 'rgba(240,240,235,0.8)'; ctx.fillRect(bx - 0.9, by - 0.1, 1.8, 0.15);
    }
  }
}

// Пешеходные переходы («зебры») на всех рукавах перекрёстков проспектов в городе
function cityCrossings(world) {
  if (world._cityX) return world._cityX;
  const out = [];
  const list = world.roadList.filter((r) => r.type === 'avenue');
  for (const A of list)
    for (const B of world.roads.query(A.bbox)) {
      if (B === A || (B.type !== 'street' && B.type !== 'avenue') || (B.type === 'avenue' && B._order < A._order)) continue;
      for (let i = 1; i < A.line.length; i++) for (let j = 1; j < B.line.length; j++) {
        const a0 = A.line[i - 1], a1 = A.line[i], b0 = B.line[j - 1], b1 = B.line[j];
        const r0 = a1[0] - a0[0], r1 = a1[1] - a0[1], s0 = b1[0] - b0[0], s1 = b1[1] - b0[1], den = r0 * s1 - r1 * s0;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((b0[0] - a0[0]) * s1 - (b0[1] - a0[1]) * s0) / den, u = ((b0[0] - a0[0]) * r1 - (b0[1] - a0[1]) * r0) / den;
        if (t < 0 || t > 1 || u < 0 || u > 1) continue;
        const La = Math.hypot(r0, r1) || 1, Lb = Math.hypot(s0, s1) || 1;
        out.push({ x: a0[0] + r0 * t, y: a0[1] + r1 * t, ta: [r0 / La, r1 / La], tb: [s0 / Lb, s1 / Lb], wa: A.width, wb: B.width });
      }
    }
  world._cityX = out;
  return out;
}
function drawZebras(ctx, world, q) {
  ctx.fillStyle = 'rgba(232,230,220,0.8)';
  for (const c of cityCrossings(world)) {
    if (!inQ(q, c.x, c.y, 30)) continue;
    // рукава: вдоль ta (переход через проспект шириной wa на расстоянии wb/2 от центра) и вдоль tb
    for (const [t, w, dist] of [[c.ta, c.wa, c.wb / 2 + 2.5], [c.tb, c.wb, c.wa / 2 + 2.5]])
      for (const sg of [-1, 1]) {
        const cx = c.x + t[0] * sg * dist, cy = c.y + t[1] * sg * dist, nx = -t[1], ny = t[0];
        for (let k = -w / 2 + 0.6; k < w / 2 - 0.3; k += 1.1) {
          const px = cx + nx * k, py = cy + ny * k;
          ctx.beginPath();
          ctx.moveTo(px - t[0] * 1.5, py - t[1] * 1.5); ctx.lineTo(px + t[0] * 1.5, py + t[1] * 1.5);
          ctx.lineTo(px + t[0] * 1.5 + nx * 0.55, py + t[1] * 1.5 + ny * 0.55); ctx.lineTo(px - t[0] * 1.5 + nx * 0.55, py - t[1] * 1.5 + ny * 0.55);
          ctx.fill();
        }
      }
  }
}

// Узлы сети для отрисовки: примыкания (конец второстепенной у главной) и перекрёстки «иксом»
// (второстепенная проходит насквозь — два направления). У каждого: точка на оси главной, её
// касательная t и направление второстепенной u (от главной)
const SURF = { village: '#5f5e59', local: '#555653', ramp: '#555653', dirt: '#a0907a', street: '#535350', avenue: '#535350', highway: '#4c4d4b' };
function junctionNodes(world) {
  if (world._jnodes) return world._jnodes;
  const out = [];
  const tanAt = (line, p) => { let bi = 1, bd = Infinity; for (let i = 1; i < line.length; i++) { const d = distToLine(p[0], p[1], [line[i - 1], line[i]]); if (d < bd) { bd = d; bi = i; } } const a = line[bi - 1], b = line[bi], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; const tx = (b[0] - a[0]) / L, ty = (b[1] - a[1]) / L; const tt = Math.max(0, Math.min(L, (p[0] - a[0]) * tx + (p[1] - a[1]) * ty)); return { t: [tx, ty], f: [a[0] + tx * tt, a[1] + ty * tt] }; };
  for (const j of junctions(world)) {
    if (j.main.type === 'street' || j.main.type === 'avenue') continue; // городская сетка — свои прямые углы
    const L = Math.hypot(j.dx, j.dy) || 1, { t, f } = tanAt(j.main.line, [j.x, j.y]);
    out.push({ x: f[0], y: f[1], main: j.main, sub: j.sub, u: [j.dx / L, j.dy / L], t });
  }
  for (const c of world.crossings || []) {
    if (c.kind !== 'x') continue;
    const { t, f } = tanAt(c.main.line, [c.x, c.y]), m = tanAt(c.minor.line, [c.x, c.y]).t;
    for (const sg of [1, -1]) out.push({ x: f[0], y: f[1], main: c.main, sub: c.minor, u: [m[0] * sg, m[1] * sg], t, cross: true });
  }
  world._jnodes = out;
  return out;
}
// Скруглённые углы: между кромкой второстепенной и кромкой главной — асфальтовый «клин» с дугой
function fillets(ctx, n) {
  const { main, sub, u, t } = n;
  if (sub.type === 'dirt' && main.type !== 'dirt') return;
  const hwM = main.type === 'highway' ? 13 : main.width / 2, hwS = sub.width / 2;
  const R = sub.type === 'village' || sub.type === 'dirt' ? 6 : main.type === 'highway' ? 16 : 10;
  const nrm = Math.abs(u[0] * -t[1] + u[1] * t[0]) || 1; // косой подход — кромка главной дальше по u
  for (const sg of [-1, 1]) {
    const p = [-u[1] * sg, u[0] * sg];
    const pt = Math.sign(p[0] * t[0] + p[1] * t[1]) || 1; // вдоль кромки главной — в сторону p
    const C = [n.x + u[0] * hwM / nrm + p[0] * hwS, n.y + u[1] * hwM / nrm + p[1] * hwS];
    const A = [C[0] + u[0] * R, C[1] + u[1] * R], B = [C[0] + t[0] * pt * R, C[1] + t[1] * pt * R];
    ctx.beginPath(); ctx.moveTo(C[0], C[1]); ctx.lineTo(A[0], A[1]); ctx.quadraticCurveTo(C[0], C[1], B[0], B[1]); ctx.closePath();
    ctx.fillStyle = SURF[sub.type] || '#555653';
    ctx.fill();
  }
}
// Полосы разгона и торможения вдоль трассы у примыкания (клин 70 м + полоса 60 м с каждой стороны)
function speedLanes(ctx, n, ppm) {
  const { t, u } = n;
  const side = Math.sign(u[0] * -t[1] + u[1] * t[0]) || 1, nx = -t[1] * side, ny = t[0] * side;
  const off = (d, w) => [n.x + t[0] * d + nx * (13 + w), n.y + t[1] * d + ny * (13 + w)];
  const inner = [], outer = [];
  for (let d = -130; d <= 130; d += 10) { const w = Math.min(3.5, Math.max(0, (130 - Math.abs(d)) / 70 * 3.5)); inner.push(off(d, 0)); outer.push(off(d, w)); }
  ctx.beginPath(); pathPoly(ctx, [...inner, ...outer.reverse()]);
  ctx.fillStyle = '#4f504d'; ctx.fill();
  if (ppm >= 0.9) strokeLine(ctx, inner.slice(3, -3), 0.2, 'rgba(225,222,210,0.8)', [2, 2]);
}
// Путепровод развязки: второстепенная дорога над трассой — тень, опоры, покрытие, ограждения
function drawOverpasses(ctx, world, q, ppm) {
  for (const c of world.crossings || []) {
    if (c.kind !== 'interchange' || !inQ(q, c.x, c.y, 120)) continue;
    const r = c.minor, run = c.over;
    ctx.save(); ctx.translate(4, 4.5); strokeLine(ctx, run, r.width + 3, 'rgba(0,0,0,0.38)'); ctx.restore();
    for (const s of [-1, 1]) { const px = c.x + c.nx * s * 15, py = c.y + c.ny * s * 15; ctx.fillStyle = '#8a877e'; ctx.fillRect(px - 1.4, py - 1.4, 2.8, 2.8); } // опоры за обочинами
    ctx.lineCap = 'butt';
    strokeLine(ctx, run, r.width + 2, '#9c9580');
    strokeLine(ctx, run, r.width, SURF[r.type] || '#555653');
    drawParapets(ctx, run, r.width / 2 + 0.9);
    if (ppm >= 0.9) strokeLine(ctx, run, 0.15, 'rgba(225,222,210,0.85)', [3, 6]);
    ctx.lineCap = 'round';
  }
}

// Примыкания: конец второстепенной дороги у главной (у каждой — направление вдоль второстепенной)
function junctions(world) {
  if (world._junc) return world._junc;
  const out = [];
  const list = world.roadList || world.roads.items;
  for (const r of list) {
    for (const end of [0, r.line.length - 1]) {
      const e = r.line[end], nb = r.line[end === 0 ? Math.min(1, r.line.length - 1) : Math.max(0, end - 1)];
      let best = null, bd = Infinity;
      for (const m of world.roads.query({ x0: e[0] - 40, y0: e[1] - 40, x1: e[0] + 40, y1: e[1] + 40 })) {
        if (m === r || ROAD_RANK[m.type] < ROAD_RANK[r.type]) continue;
        const d = distToLine(e[0], e[1], m.line);
        if (d < m.width / 2 + 6 && d < bd) { bd = d; best = m; }
      }
      if (best) out.push({ x: e[0], y: e[1], r: best.width / 2 + (best.type === 'highway' ? 1 : 0.5), main: best, sub: r, dx: nb[0] - e[0], dy: nb[1] - e[1] });
    }
  }
  world._junc = out;
  return out;
}
// ---------- Здания ----------
// Выпуклая оболочка точек контура и тех же точек, сдвинутых на (s, s); обход — всегда против часовой
function shadowHull(poly, s) {
  const pts = [];
  for (const [x, y] of poly) pts.push([x, y], [x + s, y + s]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
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
    // Тень выпуклого дома = выпуклая оболочка контура и его сдвига (шестиугольник): один контур на
    // дом вместо четырёх перекрывающихся — заливка в разы дешевле
    const h = shadowHull(bd.poly, s);
    ctx.moveTo(h[0][0], h[0][1]);
    for (let k = 1; k < h.length; k++) ctx.lineTo(h[k][0], h[k][1]);
    ctx.closePath();
  }
  ctx.fillStyle = 'rgba(18,18,12,0.42)';
  ctx.fill('nonzero');

  // Сначала северные: фасад южного здания должен перекрывать крышу северного (вид с наклоном с юга)
  list.sort((a, b) => a.y - b.y);
  if (ppm < 1) { drawBuildingsFar(ctx, list, ppm); return; }
  for (const bd of list) drawBuilding(ctx, bd, ppm);
}

// Издали (меньше 1 пикс/м) — тысячи домов на чанк: стены, крыши и скаты одного цвета собираются
// в один путь (порядок «стены → крыши → скаты» издали неотличим от посчитанного по дому)
const FAR_STYLES = new Set(['gable', 'flat', 'barn', 'hangar', 'shed']);
function drawBuildingsFar(ctx, list, ppm) {
  const walls = new Map(), roofs = new Map(), facets = new Map();
  const add = (m, k, pts) => { let a = m.get(k); if (!a) m.set(k, (a = [])); a.push(pts); };
  for (const bd of list) {
    if (!FAR_STYLES.has(bd.style) || bd.collapsed || (bd.ruined && bd.interior)) { drawBuilding(ctx, bd, ppm); continue; }
    const p = bd.poly;
    if (ppm >= 0.5) {
      const H = bd.height || 4, D = H * FACADE_K;
      const pal = WALLS[bd.style] || WALLS.gable, seed = Math.floor(bd.x * 3 + bd.y * 5);
      const base = pal[Math.floor(hash2(seed, 1, 5) * pal.length)];
      let area = 0;
      for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; area += a[0] * b[1] - b[0] * a[1]; }
      const orient = area > 0 ? 1 : -1;
      for (let i = 0; i < p.length; i++) {
        const a = p[i], b = p[(i + 1) % p.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L < 0.5) continue;
        const nx = ((b[1] - a[1]) / L) * orient, ny = (-(b[0] - a[0]) / L) * orient;
        if (ny <= 0.05) continue;
        const Dq = D * ny;
        add(walls, litWall(base, -nx * 0.18 - 0.2), [a, b, [b[0], b[1] + Dq], [a[0], a[1] + Dq]]);
      }
    }
    add(roofs, bd.roof, p);
    if (bd.style === 'gable' || bd.style === 'barn') {
      const c = Math.cos(bd.angle), s = Math.sin(bd.angle), long = bd.w >= bd.h;
      const W = (u, v) => [bd.x + u * c - v * s, bd.y + u * s + v * c];
      const L = long ? bd.w / 2 : bd.h / 2, Sd = long ? bd.h / 2 : bd.w / 2;
      const LW = (a, b) => (long ? W(a, b) : W(b, a));
      const n1 = long ? [-s, c] : [c, s];
      for (const sg of [-1, 1]) {
        const k = (sg * n1[0]) * SUN[0] + (sg * n1[1]) * SUN[1];
        const col = k >= 0 ? `rgba(255,250,235,${(Math.round(k * 10) / 10 * 0.22 * 0.8).toFixed(3)})` : `rgba(0,0,0,${(Math.round(-k * 10) / 10 * 0.22 * 1.2).toFixed(3)})`;
        add(facets, col, [LW(-L, sg * Sd), LW(L, sg * Sd), LW(L, 0), LW(-L, 0)]);
      }
    }
  }
  for (const m of [walls, roofs, facets])
    for (const [col, polys] of m) {
      ctx.beginPath();
      for (const q of polys) pathPoly(ctx, q);
      ctx.fillStyle = col;
      ctx.fill('nonzero');
    }
}

// ---------- Фасады (псевдо-3D) ----------
// Камера смотрит чуть с юга: у каждого здания видна южная стена — полоса под контуром крыши
// высотой ~0.28 от высоты здания. На ней — этажи, окна, двери, балконы.
const FACADE_STYLES = new Set(['gable', 'flat', 'barn', 'hangar', 'shed']);
const WALLS = {
  gable: ['#d8cfb9', '#cdbb94', '#b98d6e', '#e2dcc8', '#bfa77f'], // штукатурка, кирпич
  flat: ['#b9b3a6', '#c7c0ae', '#a9a79d', '#bdb09a'], // панель, силикатный кирпич
  barn: ['#9a6a52', '#a58f72'], hangar: ['#8f979b', '#7d8a86'], shed: ['#8a7a64', '#7f8c7c'],
};
export const FACADE_K = 0.42;

// Цвет стены с учётом освещения (k > 0 — светлее, < 0 — темнее); кэш — стен тысячи, цветов десятки
const LIT = new Map();
function litWall(hex, k) {
  const key = hex + (Math.round(k * 50) / 50);
  let v = LIT.get(key);
  if (!v) {
    const n = parseInt(hex.slice(1), 16), ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    const t = k > 0 ? 255 : 0, a = Math.min(1, Math.abs(k));
    v = `rgb(${ch.map((c) => Math.round(c + (t - c) * a)).join(',')})`;
    LIT.set(key, v);
  }
  return v;
}
function drawFacade(ctx, bd, ppm) {
  const p = bd.poly;
  const H = bd.height || 4;
  const D = H * FACADE_K;
  const seed = Math.floor(bd.x * 3 + bd.y * 5);
  const pal = WALLS[bd.style] || WALLS.gable;
  const base = pal[Math.floor(hash2(seed, 1, 5) * pal.length)];
  const floors = bd.interior?.floors || Math.max(1, Math.round(H / 3.1));
  const dmg = Math.min(1, bd.damage || 0);
  // Ориентация контура — чтобы найти внешние нормали
  let area = 0;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; area += a[0] * b[1] - b[0] * a[1]; }
  const orient = area > 0 ? 1 : -1;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 0.5) continue;
    const tx = (b[0] - a[0]) / L, ty = (b[1] - a[1]) / L;
    const nx = ty * orient, ny = -tx * orient;
    if (ny <= 0.05) continue; // стена смотрит на север — не видна
    const Dq = D * ny; // косая стена видна уже
    const quad = [a, b, [b[0], b[1] + Dq], [a[0], a[1] + Dq]];
    ctx.beginPath(); pathPoly(ctx, quad);
    // Освещение: солнце с северо-запада — западные грани светлее, восточные темнее; низ темнее (земля, тень)
    const k = -nx * 0.18 - 0.06;
    if (ppm < 1) { ctx.fillStyle = litWall(base, k - 0.14); ctx.fill(); continue; } // издали — одна заливка готовым цветом
    ctx.fillStyle = base; ctx.fill();
    ctx.fillStyle = k > 0 ? `rgba(255,250,235,${k})` : `rgba(0,0,0,${-k})`;
    ctx.fill();
    const g = ctx.createLinearGradient(a[0], a[1], a[0], a[1] + Dq);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.28)');
    ctx.fillStyle = g; ctx.fill();
    if (ppm < 1) continue;
    const fh = Dq / floors;
    // Межэтажные пояса
    ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = Math.min(0.12, fh * 0.08);
    ctx.beginPath();
    for (let f = 1; f < floors; f++) { ctx.moveTo(a[0], a[1] + fh * f); ctx.lineTo(b[0], b[1] + fh * f); }
    ctx.stroke();
    // Окна (и ворота у ангаров/сараев)
    if (bd.style === 'hangar' || bd.style === 'barn') {
      const gw = Math.min(L * 0.4, 5);
      const c = (L - gw) / 2;
      const gx = a[0] + tx * c, gy = a[1] + ty * c;
      ctx.fillStyle = dmg > 0.5 ? '#1a1612' : '#5b5f5c';
      ctx.beginPath(); pathPoly(ctx, [[gx, gy + Dq * 0.25], [gx + tx * gw, gy + ty * gw + Dq * 0.25], [gx + tx * gw, gy + ty * gw + Dq], [gx, gy + Dq]]); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 0.05; ctx.stroke();
    } else {
      const step = bd.style === 'flat' ? 3.2 : 3.6;
      const n = Math.max(1, Math.floor(L / step));
      const ww = Math.min(1.3, (L / n) * 0.45);
      for (let f = 0; f < floors; f++) {
        const top = a[1] + fh * (f + 0.22), hgt = fh * 0.5;
        for (let k2 = 0; k2 < n; k2++) {
          const t = ((k2 + 0.5) / n) * L;
          const cx = a[0] + tx * t, cy = top + ty * t;
          const ground = f === floors - 1;
          const door = ground && k2 === Math.floor(n / 2) && bd.style !== 'flat' && n > 1 && hash2(seed, i, 3) < 0.5;
          const broken = hash2(seed + k2, f, i) < dmg * 1.2;
          const x0 = cx - tx * ww / 2, y0 = cy - ty * ww / 2;
          const h2 = door ? fh * 0.72 : hgt;
          ctx.beginPath(); pathPoly(ctx, [[x0, y0], [x0 + tx * ww, y0 + ty * ww], [x0 + tx * ww, y0 + ty * ww + h2], [x0, y0 + h2]]);
          ctx.fillStyle = door ? '#4a3a2c' : broken ? '#141210' : (hash2(k2, f, seed) < 0.3 ? '#4d5a62' : '#35434b');
          ctx.fill();
          if (!door && !broken && ppm >= 2) {
            // Рама и блик
            ctx.strokeStyle = 'rgba(240,240,230,0.55)'; ctx.lineWidth = Math.min(0.06, ww * 0.06); ctx.stroke();
            ctx.fillStyle = 'rgba(200,225,240,0.25)';
            ctx.beginPath(); pathPoly(ctx, [[x0, y0], [x0 + tx * ww * 0.45, y0 + ty * ww * 0.45], [x0 + tx * ww * 0.2, y0 + ty * ww * 0.2 + h2 * 0.6], [x0, y0 + h2 * 0.6]]); ctx.fill();
          }
          if (broken && ppm >= 2) { ctx.fillStyle = 'rgba(40,30,20,0.5)'; ctx.beginPath(); ctx.ellipse(cx, cy - fh * 0.1, ww * 0.8, fh * 0.35, 0, 0, Math.PI * 2); ctx.fill(); } // копоть
          // Балконы многоэтажек
          if (bd.style === 'flat' && !ground && k2 % 2 === 1 && ppm >= 1.5) {
            ctx.fillStyle = 'rgba(0,0,0,0.25)';
            ctx.fillRect(x0 - tx * 0.3, y0 + h2 + fh * 0.05, ww + 0.6, fh * 0.18);
            ctx.strokeStyle = 'rgba(200,200,190,0.8)'; ctx.lineWidth = 0.05;
            ctx.beginPath(); ctx.moveTo(x0 - tx * 0.3, y0 + h2 + fh * 0.2); ctx.lineTo(x0 + tx * (ww + 0.3), y0 + ty * (ww + 0.3) + h2 + fh * 0.2); ctx.stroke();
          }
        }
      }
    }
    // Пробоины от попаданий
    for (const br of bd.breaches || []) {
      const d = Math.abs((br[0] - a[0]) * nx + (br[1] - a[1]) * ny);
      const t = (br[0] - a[0]) * tx + (br[1] - a[1]) * ty;
      if (d > 1.5 || t < 0 || t > L) continue;
      ctx.fillStyle = '#100d0a';
      ctx.beginPath(); ctx.ellipse(a[0] + tx * t, a[1] + ty * t + Dq * 0.6, 1.1, Dq * 0.3, 0, 0, Math.PI * 2); ctx.fill();
    }
    // Кромка: карниз сверху светлее, цоколь снизу темнее
    ctx.lineWidth = 0.08;
    ctx.strokeStyle = 'rgba(255,255,240,0.35)'; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.strokeStyle = 'rgba(20,18,14,0.6)'; ctx.beginPath(); ctx.moveTo(a[0], a[1] + Dq); ctx.lineTo(b[0], b[1] + Dq); ctx.stroke();
  }
}

// Разрушенное здание без крыши: сверху видны перекрытия, стены комнат, завалы
function drawRuinedInside(ctx, bd, ppm) {
  const it = bd.interior;
  const p = bd.poly;
  ctx.beginPath(); pathPoly(ctx, p);
  ctx.fillStyle = '#6d665a'; ctx.fill();
  ctx.save(); ctx.clip();
  const seed = Math.floor(bd.x * 11 + bd.y * 3);
  // Обгоревшие пятна и куски перекрытий
  for (let i = 0; i < 18; i++) {
    const u = hash2(i, 1, seed), v = hash2(i, 2, seed);
    const x = bd.bbox.x0 + u * (bd.bbox.x1 - bd.bbox.x0), y = bd.bbox.y0 + v * (bd.bbox.y1 - bd.bbox.y0);
    ctx.fillStyle = i % 3 === 0 ? 'rgba(20,16,12,0.55)' : i % 3 === 1 ? 'rgba(150,140,125,0.7)' : 'rgba(95,70,50,0.6)';
    ctx.beginPath(); ctx.ellipse(x, y, 0.8 + hash2(i, 3, seed) * 2.4, 0.5 + hash2(i, 4, seed) * 1.4, hash2(i, 5, seed) * 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  // Остатки стен — толстые, с неровным верхом
  for (const w of it.walls) {
    ctx.strokeStyle = w.outer ? '#9d968a' : '#8a8378';
    ctx.lineWidth = w.outer ? 0.45 : 0.3;
    ctx.beginPath(); ctx.moveTo(w.a[0], w.a[1]); ctx.lineTo(w.b[0], w.b[1]); ctx.stroke();
    if (ppm >= 2) { ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.08; ctx.beginPath(); ctx.moveTo(w.a[0] + 0.15, w.a[1] + 0.15); ctx.lineTo(w.b[0] + 0.15, w.b[1] + 0.15); ctx.stroke(); }
  }
  // Кирпичные завалы
  for (let i = 0; i < 26; i++) {
    const u = hash2(i, 7, seed), v = hash2(i, 8, seed);
    const x = bd.bbox.x0 + u * (bd.bbox.x1 - bd.bbox.x0), y = bd.bbox.y0 + v * (bd.bbox.y1 - bd.bbox.y0);
    ctx.fillStyle = i % 2 ? '#7a5140' : '#8f877a';
    ctx.fillRect(x, y, 0.35 + hash2(i, 9, seed) * 0.5, 0.25);
  }
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

  // Объём: видимые с юга стены (фасады с окнами и этажами)
  if (FACADE_STYLES.has(bd.style) && ppm >= 0.5) drawFacade(ctx, bd, ppm);
  if (bd.ruined && bd.interior && ppm >= 1) { drawRuinedInside(ctx, bd, ppm); return; }

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
  // Пробоины в кровле от попаданий (до полного разрушения)
  if (!bd.ruined && (bd.damage || 0) > 0.15) {
    ctx.save();
    ctx.beginPath(); pathPoly(ctx, p); ctx.clip();
    const seed = Math.floor(bd.x * 17 + bd.y * 19);
    const n = Math.ceil((bd.damage || 0) * 7);
    for (let i = 0; i < n; i++) {
      const u = (hash2(i, 21, seed) - 0.5) * bd.w * 0.8, v = (hash2(i, 22, seed) - 0.5) * bd.h * 0.8;
      const [x, y] = W(u, v);
      const r = 0.6 + hash2(i, 23, seed) * 1.4;
      ctx.fillStyle = 'rgba(40,32,24,0.6)'; ctx.beginPath(); ctx.arc(x, y, r * 1.6, 0, Math.PI * 2); ctx.fill(); // обломки вокруг
      ctx.fillStyle = '#16120e'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      if (ppm >= 3) { ctx.strokeStyle = '#6b5236'; ctx.lineWidth = 0.1; ctx.beginPath(); ctx.moveTo(x - r, y - r * 0.3); ctx.lineTo(x + r, y + r * 0.2); ctx.moveTo(x - r * 0.8, y + r * 0.4); ctx.lineTo(x + r * 0.7, y - r * 0.5); ctx.stroke(); } // стропила
    }
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
  for (const m of p.mains) if (!m.dw && inQ(q, m.x, m.y, 60)) {
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
  // Трансформаторные подстанции 10/0,4 кВ (КТП): будка с кровлей, тенью, дверями и знаком
  for (const tp of p.tps) {
    if (!inQ(q, tp.x, tp.y, 10)) continue;
    const w = 5, h = 3.6;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(tp.x - w / 2 + 0.9, tp.y - h / 2 + 1, w, h);
    ctx.fillStyle = tp.alive ? '#b9b6ad' : '#2e2a26';
    ctx.fillRect(tp.x - w / 2, tp.y - h / 2, w, h);
    if (ppm >= 2) {
      ctx.strokeStyle = tp.alive ? 'rgba(90,90,85,0.8)' : 'rgba(0,0,0,0.6)'; ctx.lineWidth = 0.12;
      ctx.strokeRect(tp.x - w / 2, tp.y - h / 2, w, h);
      ctx.beginPath(); ctx.moveTo(tp.x - w / 2, tp.y); ctx.lineTo(tp.x + w / 2, tp.y); ctx.stroke(); // конёк
      if (tp.alive) {
        ctx.fillStyle = '#6e7a82'; ctx.fillRect(tp.x - 1.8, tp.y + h / 2 - 0.2, 1.2, 0.35); ctx.fillRect(tp.x + 0.6, tp.y + h / 2 - 0.2, 1.2, 0.35); // двери
        ctx.fillStyle = '#e0c040'; ctx.fillRect(tp.x - 0.3, tp.y + h / 2 - 0.25, 0.6, 0.4); // «Опасно»
      } else { ctx.fillStyle = 'rgba(20,16,12,0.6)'; ctx.beginPath(); ctx.arc(tp.x, tp.y, 3.5, 0, Math.PI * 2); ctx.fill(); }
    }
  }
}

function drawPowerLines(ctx, world, q, ppm) {
  const p = world.power;
  if (!p || ppm < 0.2) return;
  // Магистральные ЛЭП 330/110 кВ («Война дронов»): решётчатые опоры с траверсой и тенью от солнца,
  // три фазы (у 330 кВ — расщеплённые) и их тени; на концах — порталы ОРУ
  const SH = [0.3, 0.34]; // смещение тени на метр высоты (солнце с северо-запада)
  for (const ln of p.lines || []) {
    // линии противника видны, когда найдены оба конца (или конец — межсистемная связь)
    const hid = (id) => id !== 'import' && id != null && fogHidden(world, ln.side, id);
    if (ln.feed ? hid(ln.a) : hid(ln.a) || hid(ln.b)) continue;
    const pl = ln.pylons, big = ln.kv >= 330;
    const sp = big ? 7.5 : 4, Hw = big ? 30 : 20, Ht = big ? 40 : 28;
    for (let i = 1; i < pl.length; i++) {
      const a = pl[i - 1], b = pl[i];
      if (!inQ(q, a.x, a.y, 400) && !inQ(q, b.x, b.y, 400)) continue;
      if (a.ph || b.ph) continue; // последний пролёт к порталу ОРУ рисует слой объектов — с высотой
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      const nx = -(b.y - a.y) / L, ny = (b.x - a.x) / L;
      const ha = a.portal ? 12 : Hw, hb = b.portal ? 12 : Hw;
      for (const o of [-sp, 0, sp]) {
        // тень провода: провисает — середина пролёта ниже
        ctx.beginPath();
        ctx.moveTo(a.x + nx * o + SH[0] * ha, a.y + ny * o + SH[1] * ha);
        ctx.quadraticCurveTo((a.x + b.x) / 2 + nx * o + SH[0] * (ha + hb) * 0.3, (a.y + b.y) / 2 + ny * o + SH[1] * (ha + hb) * 0.3, b.x + nx * o + SH[0] * hb, b.y + ny * o + SH[1] * hb);
        ctx.strokeStyle = 'rgba(0,0,0,0.2)';
        ctx.lineWidth = Math.max(0.2, (big ? 1.1 : 0.9) / ppm);
        ctx.stroke();
        for (const d of big && ppm >= 2 ? [-0.25, 0.25] : [0]) {
          ctx.beginPath();
          ctx.moveTo(a.x + nx * (o + d), a.y + ny * (o + d));
          ctx.lineTo(b.x + nx * (o + d), b.y + ny * (o + d));
          ctx.strokeStyle = 'rgba(55,57,55,0.85)';
          ctx.lineWidth = Math.max(0.12, (big && ppm >= 2 ? 0.7 : 0.9) / ppm);
          ctx.stroke();
        }
      }
    }
    for (let i = 0; i < pl.length; i++) {
      const t = pl[i];
      if (!inQ(q, t.x, t.y, 60)) continue;
      const nb = pl[Math.min(pl.length - 1, i + 1)], pb = pl[Math.max(0, i - 1)];
      const ang = Math.atan2(nb.y - pb.y, nb.x - pb.x);
      if (t.portal && t.ph) continue; // портал — часть модели ОРУ
      if (t.portal) {
        // портал ОРУ: две стойки и ригель поперёк линии
        ctx.save(); ctx.translate(t.x, t.y); ctx.rotate(ang);
        ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(-sp - 3 + 3.6, 3.4); ctx.lineTo(sp + 3 + 3.6, 3.4); ctx.stroke();
        ctx.fillStyle = '#8e928e';
        for (const o of [-sp - 3, sp + 3]) ctx.fillRect(-0.7, o - 0.7, 1.4, 1.4);
        ctx.strokeStyle = '#a4a8a4'; ctx.lineWidth = 0.7;
        ctx.beginPath(); ctx.moveTo(0, -sp - 3); ctx.lineTo(0, sp + 3); ctx.stroke();
        ctx.restore();
        continue;
      }
      const s = big ? 9 : 6;
      // тень решётчатой опоры: сужающаяся к вершине, с тенью траверсы
      ctx.save(); ctx.translate(t.x, t.y);
      ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = Math.max(0.3, 1 / ppm);
      const tx = SH[0] * Ht, ty = SH[1] * Ht, cx = SH[0] * Hw, cy = SH[1] * Hw;
      const c = Math.cos(ang), sn = Math.sin(ang);
      ctx.beginPath();
      for (const [ux, uy] of [[-s / 2, -s / 2], [s / 2, -s / 2], [s / 2, s / 2], [-s / 2, s / 2]]) { ctx.moveTo(ux * c - uy * sn, ux * sn + uy * c); ctx.lineTo(tx, ty); }
      ctx.moveTo(cx - sn * -(sp + 1.5), cy + c * -(sp + 1.5)); ctx.lineTo(cx - sn * (sp + 1.5), cy + c * (sp + 1.5)); // траверса
      ctx.stroke();
      ctx.restore();
      // сама опора (вид сверху): основание с раскосами, траверса с гирляндами изоляторов
      ctx.save(); ctx.translate(t.x, t.y); ctx.rotate(ang);
      ctx.fillStyle = 'rgba(70,72,68,0.25)'; ctx.fillRect(-s / 2, -s / 2, s, s);
      ctx.strokeStyle = '#4e514d';
      ctx.lineWidth = Math.max(0.3, 1 / ppm);
      ctx.strokeRect(-s / 2, -s / 2, s, s);
      ctx.beginPath();
      ctx.moveTo(-s / 2, -s / 2); ctx.lineTo(s / 2, s / 2); ctx.moveTo(s / 2, -s / 2); ctx.lineTo(-s / 2, s / 2);
      ctx.stroke();
      ctx.strokeStyle = '#5e615d'; ctx.lineWidth = Math.max(0.5, 1.6 / ppm);
      ctx.beginPath(); ctx.moveTo(0, -sp - 1.5); ctx.lineTo(0, sp + 1.5); ctx.stroke();
      if (ppm >= 1.5) { ctx.fillStyle = '#b8a888'; for (const o of [-sp, 0, sp]) ctx.fillRect(-0.3, o - 0.3, 0.6, 0.6); }
      ctx.restore();
    }
  }
  // Фидеры 10 кВ: в городе — кабель в земле (не видно), за городом — бетонные опоры и три провода
  // под землю кабель уходит только в застроенной части города (на пустырях у окраин — опоры)
  const inCity = (x, y) => world.mask.has(x, y, M.CITY | M.CITYZONE) && world.mask.near(x, y, 45, M.BUILD);
  for (const tp of [...p.tps, ...(p.feeds || [])]) {
    if (tp.oid !== undefined ? fogHidden(world, tp.side, tp.oid) : p.mains?.[tp.main] && fogHidden(world, p.mains[tp.main].side, p.mains[tp.main].infraId)) continue;
    const pts = tp.poles;
    // ТП городского района питается кабелем целиком (веер опор от подстанции над кварталами — неправда)
    if (tp.oid === undefined && world.mask.has(tp.x, tp.y, M.CITY | M.CITYZONE)) continue;
    const runs = [];
    let cur = null;
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i];
      const gap = tp.cut && Math.hypot(x - tp.cut.x, y - tp.cut.y) < 20;
      if (!inQ(q, x, y, 60) || gap || inCity(x, y)) { cur = null; continue; }
      if (!cur) runs.push((cur = []));
      cur.push([x, y]);
    }
    for (const run of runs) {
      if (run.length < 2) continue;
      if (ppm >= 0.8) strokeLine(ctx, run.map(([x, y]) => [x + 3, y + 3.4]), 0.12, 'rgba(0,0,0,0.16)'); // тень провода
      strokeLine(ctx, run, Math.max(0.12, 0.8 / ppm), 'rgba(45,45,45,0.7)');
      if (ppm >= 1)
        for (const [x, y] of run) {
          ctx.strokeStyle = 'rgba(0,0,0,0.22)'; ctx.lineWidth = 0.25;
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 3, y + 3.4); ctx.stroke(); // тень столба
          ctx.fillStyle = '#9c988e';
          ctx.beginPath(); ctx.arc(x, y, 0.3, 0, Math.PI * 2); ctx.fill();
        }
    }
  }
  // Сельские линии 0,4 кВ: провод по опорам с фонарями вдоль улицы
  if (ppm >= 0.8 && p.lamps) {
    let prev = null;
    for (const l of p.lamps) {
      if (l.road < 0) { prev = null; continue; }
      if (prev && prev.road === l.road && Math.hypot(prev.x - l.x, prev.y - l.y) < 90 && (inQ(q, l.x, l.y, 20) || inQ(q, prev.x, prev.y, 20))) {
        ctx.strokeStyle = 'rgba(0,0,0,0.14)'; ctx.lineWidth = 0.1;
        ctx.beginPath(); ctx.moveTo(prev.x + 2.4, prev.y + 2.7); ctx.lineTo(l.x + 2.4, l.y + 2.7); ctx.stroke();
        ctx.strokeStyle = 'rgba(40,40,40,0.7)'; ctx.lineWidth = Math.max(0.1, 0.7 / ppm);
        ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(l.x, l.y); ctx.stroke();
      }
      if (inQ(q, l.x, l.y, 5) && ppm >= 1.5) {
        ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 0.25; ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.lineTo(l.x + 2.4, l.y + 2.7); ctx.stroke(); // тень опоры
        ctx.fillStyle = '#8f8a80'; ctx.beginPath(); ctx.arc(l.x, l.y, 0.3, 0, Math.PI * 2); ctx.fill();
      }
      prev = l;
    }
  }
  // ЛЭП 110 кВ: решётчатые опоры и три провода
  for (const main of p.mains) {
  const pl = main.pylons;
  for (let i = 1; i < pl.length; i++) {
    const a = pl[i - 1], b = pl[i];
    if (!inQ(q, a.x, a.y, 300) && !inQ(q, b.x, b.y, 300)) continue;
    if (main.feedCut && (Math.hypot(a.x - main.feedCut.x, a.y - main.feedCut.y) < 1 || Math.hypot(b.x - main.feedCut.x, b.y - main.feedCut.y) < 1)) continue;
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
}
