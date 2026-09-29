// Детальные спрайты техники и бойцов (вид сверху, «псевдо-3D»: светотень, блики, контуры).
// Каждый спрайт рисуется один раз в высоком разрешении во внеэкранный холст и кэшируется;
// в кадре — только drawImage с поворотом. Это и детальнее, и в разы быстрее рисования фигур.
// Координаты рисования — метры, ось X — вперёд (по ходу машины / взгляду бойца).

import { FACTIONS } from '../sim/factions.js';

const VPPM = 30; // пикселей на метр у техники
const SPPM = 44; // у бойцов
const cache = new Map();

function mk(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w); c.height = Math.ceil(h);
  return c;
}

// Детерминированный шум для потёртостей и грязи
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// ---------- Палитры ----------
function pal(side) {
  const c = FACTIONS[side].camo;
  return {
    ...c,
    mark: side === 'blue' ? '#3f7fe0' : '#d8433a', // опознавательные полосы / знаки
    markLight: side === 'blue' ? '#8fb8ff' : '#ff9a90',
    metal: '#3a3d33', rubber: '#1b1c17', glass: '#26343a', canvas: side === 'blue' ? '#6b6f4c' : '#626847',
  };
}

// Заливка «объёмом»: градиент от светлого края к тёмному, контур и блик кромки
function volume(g, path, base, { light = 0.22, dark = 0.35, outline = true, lw = 0.07 } = {}) {
  g.save();
  path();
  const gr = g.createLinearGradient(-2, -2, 2, 2);
  gr.addColorStop(0, shade(base, light));
  gr.addColorStop(0.55, base);
  gr.addColorStop(1, shade(base, -dark));
  g.fillStyle = gr;
  g.fill();
  if (outline) {
    g.strokeStyle = 'rgba(12,13,8,0.85)';
    g.lineWidth = lw;
    g.stroke();
  }
  g.restore();
}

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
  if (k >= 0) { r += (255 - r) * k; gg += (255 - gg) * k; b += (255 - b) * k; }
  else { r *= 1 + k; gg *= 1 + k; b *= 1 + k; }
  return `rgb(${r | 0},${gg | 0},${b | 0})`;
}

const rect = (g, x, y, w, h) => () => { g.beginPath(); g.rect(x, y, w, h); };
const rrect = (g, x, y, w, h, r) => () => { g.beginPath(); g.roundRect(x, y, w, h, r); };
const poly = (g, pts) => () => { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) g.lineTo(p[0], p[1]); g.closePath(); };

// Пятна камуфляжа, грязь и потёртости внутри последнего пути (clip)
function camo(g, x, y, w, h, P, seed, n = 9) {
  const r = rng(seed);
  g.save();
  g.clip();
  for (let i = 0; i < n; i++) {
    g.fillStyle = i % 3 === 0 ? P.dark : i % 3 === 1 ? (P.spot || P.light) : shade(P.body, -0.12);
    g.globalAlpha = 0.5;
    g.beginPath();
    g.ellipse(x + r() * w, y + r() * h, 0.35 + r() * 0.9, 0.2 + r() * 0.45, r() * 3, 0, Math.PI * 2);
    g.fill();
  }
  // Пыль у бортов и мелкие царапины
  g.globalAlpha = 0.16;
  g.fillStyle = '#b8a27a';
  g.fillRect(x, y + h - 0.35, w, 0.35);
  g.fillRect(x, y, w, 0.25);
  g.globalAlpha = 0.25;
  g.strokeStyle = shade(P.body, 0.35);
  g.lineWidth = 0.03;
  for (let i = 0; i < 12; i++) {
    const sx = x + r() * w, sy = y + r() * h;
    g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + (r() - 0.5) * 0.5, sy + (r() - 0.5) * 0.2); g.stroke();
  }
  g.restore();
}

function lines(g, segs, color = 'rgba(0,0,0,0.35)', w = 0.04) {
  g.strokeStyle = color;
  g.lineWidth = w;
  g.beginPath();
  for (const [a, b, c, d] of segs) { g.moveTo(a, b); g.lineTo(c, d); }
  g.stroke();
}

function bolts(g, pts, r = 0.05) {
  for (const [x, y] of pts) {
    g.fillStyle = 'rgba(255,255,230,0.25)';
    g.beginPath(); g.arc(x - 0.01, y - 0.01, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.beginPath(); g.arc(x + 0.015, y + 0.015, r * 0.7, 0, Math.PI * 2); g.fill();
  }
}

function hatch(g, x, y, r, P, open = false) {
  volume(g, () => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); }, P.dark, { light: 0.25, dark: 0.3 });
  g.strokeStyle = 'rgba(255,255,220,0.2)'; g.lineWidth = 0.03;
  g.beginPath(); g.arc(x, y, r * 0.7, 0, Math.PI * 2); g.stroke();
  if (open) { g.fillStyle = '#111'; g.beginPath(); g.arc(x, y, r * 0.55, 0, Math.PI * 2); g.fill(); }
}

function jerry(g, x, y, P) {
  volume(g, rrect(g, x, y, 0.5, 0.34, 0.05), '#4b5236', { light: 0.3 });
  lines(g, [[x + 0.1, y + 0.05, x + 0.4, y + 0.29], [x + 0.4, y + 0.05, x + 0.1, y + 0.29]], 'rgba(0,0,0,0.3)', 0.03);
}

function box(g, x, y, w, h, color) {
  volume(g, rect(g, x, y, w, h), color, { light: 0.3, dark: 0.3 });
  lines(g, [[x + w / 2, y, x + w / 2, y + h]], 'rgba(0,0,0,0.3)', 0.03);
}

// Гусеница: траки со смещением frame (0..3), направляющие колёса видны по краю
function track(g, x, y, L, w, frame) {
  volume(g, rect(g, x, y, L, w), '#26261f', { light: 0.12, dark: 0.3 });
  const step = 0.36;
  const off = (frame / 4) * step;
  g.fillStyle = 'rgba(80,78,64,0.9)';
  for (let t = x + off; t < x + L - 0.05; t += step) g.fillRect(t, y + 0.05, step * 0.45, w - 0.1);
  g.fillStyle = 'rgba(255,255,230,0.12)';
  for (let t = x + off; t < x + L - 0.05; t += step) g.fillRect(t, y + 0.05, step * 0.45, 0.06);
}

function wheel(g, x, y, frame, big = false) {
  const w = big ? 1.2 : 1.05, h = big ? 0.48 : 0.42;
  volume(g, rrect(g, x - w / 2, y - h / 2, w, h, 0.12), '#1d1e18', { light: 0.18, dark: 0.3 });
  g.strokeStyle = 'rgba(255,255,255,0.14)';
  g.lineWidth = 0.05;
  g.beginPath();
  for (let k = 0; k < 4; k++) { const t = x - w / 2 + ((k + frame / 4) / 4) * w; g.moveTo(t, y - h / 2 + 0.04); g.lineTo(t, y + h / 2 - 0.04); }
  g.stroke();
}

function markStripe(g, x, y, w, h, P) {
  g.fillStyle = P.mark;
  g.fillRect(x, y, w, h);
  g.fillStyle = 'rgba(255,255,255,0.18)';
  g.fillRect(x, y, w, h * 0.35);
}

// ---------- Корпуса (hull) и башни (turret) ----------
// Каждая функция: (g, P, frame, seed) в метрах; размеры спрайта — в DEF
const DEF = {
  tank: { w: 8.4, h: 4.2, pivot: [0.1, 0] },
  ifv: { w: 7.6, h: 3.8, pivot: [0.3, 0] },
  apc: { w: 8.2, h: 3.4, pivot: [0.9, 0] },
  truck: { w: 8.6, h: 2.9 },
  medevac: { w: 8.6, h: 2.9 },
  fuel: { w: 8.8, h: 2.9 },
  arty: { w: 16.5, h: 3.2 },
  btm: { w: 10.2, h: 3.6 },
  spg: { w: 8.6, h: 4.0, pivot: [-0.6, 0] },
  mlrs: { w: 9.4, h: 3.0, pivot: [-2.0, 0] },
  armcar: { w: 6.2, h: 2.9, pivot: [-0.2, 0] },
  sam: { w: 8.4, h: 3.2, pivot: [-1.4, 0] },
};

const HULL = {
  tank(g, P, f, seed, side) {
    track(g, -3.8, -1.95, 7.6, 0.78, f);
    track(g, -3.8, 1.17, 7.6, 0.78, f);
    // Крылья (надгусеничные полки) с ящиками ЗИП
    volume(g, rect(g, -3.7, -1.72, 7.3, 0.42), shade(P.body, -0.05));
    volume(g, rect(g, -3.7, 1.3, 7.3, 0.42), shade(P.body, -0.05));
    for (const x of [-3.2, -1.9, 1.2]) { box(g, x, -1.68, 0.9, 0.34, shade(P.body, 0.05)); box(g, x, 1.34, 0.9, 0.34, shade(P.body, 0.05)); }
    // Корпус
    const hull = poly(g, [[-3.5, -1.3], [2.5, -1.3], [3.7, -0.85], [3.7, 0.85], [2.5, 1.3], [-3.5, 1.3]]);
    volume(g, hull, P.body, { light: 0.25, dark: 0.3 });
    hull(); camo(g, -3.5, -1.3, 7.2, 2.6, P, seed);
    // Верхний лобовой лист, фары, мехвод
    volume(g, poly(g, [[2.5, -1.3], [3.7, -0.85], [3.7, 0.85], [2.5, 1.3]]), shade(P.body, 0.08));
    hatch(g, 2.9, 0, 0.28, P);
    for (const y of [-1.0, 1.0]) { g.fillStyle = '#d8d6b8'; g.beginPath(); g.arc(3.45, y, 0.09, 0, Math.PI * 2); g.fill(); }
    // МТО: решётки жалюзи и выхлоп
    volume(g, rect(g, -3.4, -1.05, 1.6, 2.1), shade(P.body, -0.1));
    lines(g, Array.from({ length: 8 }, (_, i) => [-3.3 + i * 0.19, -0.95, -3.3 + i * 0.19, 0.95]), 'rgba(0,0,0,0.55)', 0.06);
    g.fillStyle = '#1a1a14'; g.fillRect(-3.55, 0.7, 0.18, 0.45);
    // Бочки/брёвна на корме
    volume(g, rrect(g, -3.95, -0.9, 0.45, 1.8, 0.2), '#5a4a32');
    bolts(g, [[2.3, -1.15], [2.3, 1.15], [-1.7, -1.15], [-1.7, 1.15]]);
    // Опознавательные полосы на бортах
    markStripe(g, 0.4, -1.72, 0.18, 0.42, P); markStripe(g, 0.4, 1.3, 0.18, 0.42, P);
    if (side === 'red') { g.fillStyle = P.mark; g.globalAlpha = 0.9; g.fillRect(-1.3, -0.08, 0.7, 0.16); g.fillRect(-1.03, -0.35, 0.16, 0.7); g.globalAlpha = 1; }
  },
  ifv(g, P, f, seed) {
    track(g, -3.5, -1.8, 7.0, 0.66, f);
    track(g, -3.5, 1.14, 7.0, 0.66, f);
    const hull = poly(g, [[-3.5, -1.25], [2.0, -1.25], [3.5, -0.7], [3.5, 0.7], [2.0, 1.25], [-3.5, 1.25]]);
    volume(g, hull, P.body);
    hull(); camo(g, -3.5, -1.25, 7, 2.5, P, seed);
    volume(g, poly(g, [[2.0, -1.25], [3.5, -0.7], [3.5, 0.7], [2.0, 1.25]]), shade(P.body, 0.1));
    // Десантные люки на крыше и корме
    for (const y of [-0.85, 0.2]) volume(g, rrect(g, -3.25, y, 1.4, 0.62, 0.08), shade(P.body, -0.08));
    lines(g, [[-3.25, -0.54, -1.85, -0.54], [-3.25, 0.51, -1.85, 0.51]], 'rgba(0,0,0,0.4)');
    hatch(g, 2.45, -0.65, 0.24, P); hatch(g, 1.6, -0.65, 0.22, P);
    for (const x of [-1.5, -0.6]) jerry(g, x, 0.85, P);
    box(g, -1.5, -1.2, 0.8, 0.32, shade(P.body, 0.05));
    bolts(g, [[1.9, -1.1], [1.9, 1.1], [-3.3, -1.1], [-3.3, 1.1]]);
    markStripe(g, -0.2, -1.25, 0.16, 0.35, P); markStripe(g, -0.2, 0.9, 0.16, 0.35, P);
  },
  apc(g, P, f, seed) {
    for (let i = 0; i < 4; i++) { const x = -2.9 + i * 1.8; wheel(g, x, -1.42, f, true); wheel(g, x, 1.42, f, true); }
    const hull = poly(g, [[-3.9, -1.2], [2.3, -1.2], [3.9, -0.5], [3.9, 0.5], [2.3, 1.2], [-3.9, 1.2]]);
    volume(g, hull, P.body);
    hull(); camo(g, -3.9, -1.2, 7.8, 2.4, P, seed);
    volume(g, poly(g, [[2.3, -1.2], [3.9, -0.5], [3.9, 0.5], [2.3, 1.2]]), shade(P.body, 0.1));
    g.fillStyle = P.glass; g.fillRect(3.1, -0.65, 0.3, 0.5); g.fillRect(3.1, 0.15, 0.3, 0.5);
    g.fillStyle = 'rgba(255,255,255,0.2)'; g.fillRect(3.12, -0.63, 0.08, 0.45);
    volume(g, rect(g, -3.7, -0.8, 1.1, 1.6), shade(P.body, -0.12));
    lines(g, Array.from({ length: 6 }, (_, i) => [-3.6 + i * 0.18, -0.7, -3.6 + i * 0.18, 0.7]), 'rgba(0,0,0,0.5)', 0.05);
    for (const y of [-0.95, 0.4]) volume(g, rrect(g, -1.8, y, 0.9, 0.55, 0.08), shade(P.body, -0.06));
    hatch(g, 2.6, 0.55, 0.22, P);
    jerry(g, -2.5, -1.15, P);
    markStripe(g, 0.1, -1.2, 0.16, 0.3, P); markStripe(g, 0.1, 0.9, 0.16, 0.3, P);
  },
  truck(g, P, f, seed, side, kind = 'cargo') {
    for (const x of [-3.2, -2.0, 2.7]) { wheel(g, x, -1.22, f); wheel(g, x, 1.22, f); }
    // Рама, кабина, капот
    volume(g, rect(g, -4.2, -0.5, 8.3, 1.0), '#2a2b23');
    volume(g, rrect(g, 3.1, -1.0, 1.15, 2.0, 0.2), '#56603c');
    lines(g, [[3.4, -0.8, 4.1, -0.8], [3.4, -0.4, 4.1, -0.4], [3.4, 0.4, 4.1, 0.4], [3.4, 0.8, 4.1, 0.8]], 'rgba(0,0,0,0.4)');
    volume(g, rrect(g, 1.8, -1.15, 1.4, 2.3, 0.15), '#5d6841');
    g.fillStyle = P.glass; g.fillRect(3.0, -1.0, 0.22, 2.0);
    g.fillStyle = 'rgba(255,255,255,0.22)'; g.fillRect(3.03, -0.95, 0.07, 0.9);
    // Кузов
    if (kind === 'cargo') {
      volume(g, rect(g, -4.3, -1.25, 5.95, 2.5), P.canvas, { light: 0.3, dark: 0.25 });
      rect(g, -4.3, -1.25, 5.95, 2.5)(); camo(g, -4.3, -1.25, 5.95, 2.5, { ...P, spot: shade(P.canvas, 0.15), dark: shade(P.canvas, -0.2) }, seed, 5);
      lines(g, Array.from({ length: 6 }, (_, i) => [-3.7 + i * 0.95, -1.25, -3.7 + i * 0.95, 1.25]), 'rgba(0,0,0,0.3)', 0.07);
      lines(g, [[-4.3, 0, 1.65, 0]], 'rgba(255,255,230,0.12)', 0.1);
    } else if (kind === 'fuel') {
      volume(g, rrect(g, -4.3, -1.1, 5.9, 2.2, 1.0), '#5f6a48', { light: 0.35, dark: 0.35 });
      lines(g, [[-3.0, -1.1, -3.0, 1.1], [-1.2, -1.1, -1.2, 1.1], [0.6, -1.1, 0.6, 1.1]], 'rgba(0,0,0,0.3)', 0.06);
      hatch(g, -2.1, 0, 0.3, P); hatch(g, -0.3, 0, 0.3, P);
      g.fillStyle = '#c9a23a'; g.fillRect(-4.0, -0.95, 0.9, 0.18);
      volume(g, rect(g, 1.0, -0.6, 0.5, 1.2), '#383a30');
    } else if (kind === 'medic') {
      volume(g, rect(g, -4.3, -1.25, 5.95, 2.5), '#6f7556', { light: 0.3 });
      g.fillStyle = '#ecebe2'; g.fillRect(-2.2, -0.7, 1.4, 1.4);
      g.fillStyle = '#c62b2b'; g.fillRect(-1.68, -0.6, 0.36, 1.2); g.fillRect(-2.1, -0.18, 1.2, 0.36);
    }
    markStripe(g, 2.2, -1.15, 0.15, 0.4, P); markStripe(g, 2.2, 0.75, 0.15, 0.4, P);
  },
  medevac(g, P, f, seed, side) { HULL.truck(g, P, f, seed, side, 'medic'); },
  fuel(g, P, f, seed, side) { HULL.truck(g, P, f, seed, side, 'fuel'); },
  arty(g, P, f, seed, side) {
    // Тягач (сдвинут вперёд) и буксируемая гаубица за ним, ствол по-походному назад
    g.save(); g.translate(3.6, 0); HULL.truck(g, P, f, seed, side); g.restore();
    volume(g, poly(g, [[-0.9, -0.08], [-3.4, -1.05], [-3.4, 1.05], [-0.9, 0.08]]), '#34372b');
    wheel(g, -4.0, -1.25, f); wheel(g, -4.0, 1.25, f);
    volume(g, rrect(g, -4.8, -1.05, 1.6, 2.1, 0.12), P.body);
    volume(g, rect(g, -4.5, -0.6, 0.9, 1.2), shade(P.body, 0.1)); // щит
    volume(g, rect(g, -8.2, -0.14, 4.1, 0.28), '#3a3e31');
    volume(g, rect(g, -8.4, -0.23, 0.45, 0.46), '#2e3128');
  },
  btm(g, P, f, seed) {
    track(g, -3.1, -1.75, 6.9, 0.64, f);
    track(g, -3.1, 1.11, 6.9, 0.64, f);
    volume(g, rect(g, -3.0, -1.2, 6.5, 2.4), '#5d5c3d');
    rect(g, -3.0, -1.2, 6.5, 2.4)(); camo(g, -3.0, -1.2, 6.5, 2.4, P, seed, 5);
    volume(g, rrect(g, 1.5, -1.1, 1.9, 2.2, 0.15), '#6c6b46');
    g.fillStyle = P.glass; g.fillRect(3.1, -0.9, 0.25, 1.8);
    volume(g, rect(g, -5.3, -0.55, 2.4, 1.1), '#3c3b31');
    g.strokeStyle = '#2a2922'; g.lineWidth = 0.35;
    g.beginPath(); g.arc(-5.1, 0, 1.2, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 0.18;
    g.beginPath();
    for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2 + f * 0.2; g.moveTo(-5.1 + Math.cos(a) * 0.9, Math.sin(a) * 0.9); g.lineTo(-5.1 + Math.cos(a) * 1.45, Math.sin(a) * 1.45); }
    g.stroke();
  },
  spg(g, P, f, seed, side) {
    track(g, -4.0, -1.9, 8.0, 0.74, f);
    track(g, -4.0, 1.16, 8.0, 0.74, f);
    const hull = poly(g, [[-3.9, -1.3], [2.8, -1.3], [4.0, -0.8], [4.0, 0.8], [2.8, 1.3], [-3.9, 1.3]]);
    volume(g, hull, P.body);
    hull(); camo(g, -3.9, -1.3, 7.9, 2.6, P, seed);
    volume(g, poly(g, [[2.8, -1.3], [4.0, -0.8], [4.0, 0.8], [2.8, 1.3]]), shade(P.body, 0.1));
    lines(g, Array.from({ length: 7 }, (_, i) => [1.2 + i * 0.2, -1.0, 1.2 + i * 0.2, 1.0]), 'rgba(0,0,0,0.5)', 0.06);
    hatch(g, 3.1, -0.5, 0.25, P);
    markStripe(g, 0.8, -1.3, 0.16, 0.36, P); markStripe(g, 0.8, 0.94, 0.16, 0.36, P);
  },
  mlrs(g, P, f, seed, side) {
    for (const x of [-3.4, -2.2, 0.2, 3.0]) { wheel(g, x, -1.25, f); wheel(g, x, 1.25, f); }
    volume(g, rect(g, -4.6, -0.5, 8.9, 1.0), '#2a2b23');
    volume(g, rrect(g, 2.2, -1.15, 1.8, 2.3, 0.2), '#5a653f');
    g.fillStyle = P.glass; g.fillRect(3.75, -1.0, 0.22, 2.0);
    volume(g, rect(g, -4.5, -1.2, 6.4, 2.4), shade(P.body, -0.1));
    markStripe(g, 2.5, -1.15, 0.15, 0.4, P);
  },
  armcar(g, P, f, seed) {
    for (const x of [-1.9, 1.7]) { wheel(g, x, -1.25, f, true); wheel(g, x, 1.25, f, true); }
    const hull = poly(g, [[-2.9, -1.1], [1.9, -1.1], [3.0, -0.85], [3.0, 0.85], [1.9, 1.1], [-2.9, 1.1]]);
    volume(g, hull, P.body);
    hull(); camo(g, -2.9, -1.1, 5.9, 2.2, P, seed, 6);
    volume(g, poly(g, [[1.9, -1.1], [3.0, -0.85], [3.0, 0.85], [1.9, 1.1]]), shade(P.body, 0.12));
    g.fillStyle = P.glass; g.fillRect(1.25, -0.95, 0.55, 1.9);
    g.fillStyle = 'rgba(255,255,255,0.2)'; g.fillRect(1.3, -0.9, 0.12, 0.9);
    volume(g, rrect(g, -2.95, -0.7, 0.4, 1.4, 0.1), '#4b5236'); // запаска
    markStripe(g, -0.6, -1.1, 0.15, 0.3, P); markStripe(g, -0.6, 0.8, 0.15, 0.3, P);
  },
  sam(g, P, f, seed) {
    for (const x of [-3.0, -1.8, 2.6]) { wheel(g, x, -1.3, f); wheel(g, x, 1.3, f); }
    volume(g, rect(g, -4.2, -0.5, 8.3, 1.0), '#2a2b23');
    volume(g, rrect(g, 2.0, -1.15, 1.9, 2.3, 0.2), '#5a653f');
    g.fillStyle = P.glass; g.fillRect(3.65, -1.0, 0.22, 2.0);
    volume(g, rect(g, -4.2, -1.25, 6.0, 2.5), shade(P.body, -0.05));
    rect(g, -4.2, -1.25, 6.0, 2.5)(); camo(g, -4.2, -1.25, 6.0, 2.5, P, seed, 6);
    markStripe(g, 2.3, -1.15, 0.15, 0.4, P);
  },
};

const TURRET = {
  tank(g, P, side) {
    // Ствол с эжектором и дульным тормозом
    volume(g, rect(g, 1.3, -0.14, 4.9, 0.28), '#3b3f32', { light: 0.3 });
    volume(g, rect(g, 3.1, -0.2, 0.7, 0.4), '#34382c');
    volume(g, rect(g, 5.9, -0.2, 0.4, 0.4), '#2c2f25');
    if (side === 'blue') {
      const t = poly(g, [[1.8, -1.1], [1.8, 1.1], [-1.0, 1.4], [-2.6, 1.05], [-2.6, -1.05], [-1.0, -1.4]]);
      volume(g, t, P.light, { light: 0.3, dark: 0.35 });
      t(); camo(g, -2.6, -1.4, 4.4, 2.8, P, 77, 5);
      volume(g, rect(g, -2.6, -0.9, 0.55, 1.8), shade(P.body, -0.15));
      lines(g, [[-2.55, -0.6, -2.1, -0.6], [-2.55, 0, -2.1, 0], [-2.55, 0.6, -2.1, 0.6]], 'rgba(0,0,0,0.4)');
    } else {
      const t = () => { g.beginPath(); g.ellipse(0, 0, 1.7, 1.38, 0, 0, Math.PI * 2); };
      volume(g, t, P.light, { light: 0.3, dark: 0.35 });
      t(); camo(g, -1.7, -1.4, 3.4, 2.8, P, 91, 5);
      // Блоки динамической защиты «ёлочкой»
      for (const [bx, by] of [[1.25, -0.8], [1.25, 0.8], [0.75, -1.1], [0.75, 1.1], [1.5, -0.35], [1.5, 0.35], [0.2, -1.25], [0.2, 1.25]]) volume(g, rect(g, bx - 0.24, by - 0.17, 0.48, 0.34), shade(P.body, -0.05), { light: 0.35 });
    }
    hatch(g, -0.55, -0.5, 0.38, P); hatch(g, -0.5, 0.55, 0.32, P);
    volume(g, rect(g, 0.85, 0.45, 0.4, 0.32), '#1c2426'); // прицел
    g.fillStyle = 'rgba(160,220,255,0.35)'; g.fillRect(1.15, 0.5, 0.08, 0.22);
    volume(g, rrect(g, -0.9, -1.15, 0.5, 0.3, 0.05), '#2d302a'); // пулемёт на командирской
    lines(g, [[-0.65, -1.0, 0.7, -1.0]], '#1a1c16', 0.07);
    lines(g, [[-1.8, 0.8, -3.2, 1.6]], 'rgba(20,20,15,0.6)', 0.03); // антенна
  },
  ifv(g, P) {
    volume(g, rect(g, 0.6, -0.08, 3.0, 0.16), '#34382c');
    volume(g, rect(g, 3.4, -0.11, 0.3, 0.22), '#2b2e24');
    volume(g, rrect(g, 0.4, 0.42, 1.2, 0.22, 0.08), '#3f4633'); // ПТУР
    const t = rrect(g, -0.95, -0.85, 1.9, 1.7, 0.35);
    volume(g, t, P.light, { light: 0.32, dark: 0.35 });
    hatch(g, -0.35, -0.35, 0.28, P);
    volume(g, rect(g, 0.35, -0.6, 0.35, 0.3), '#1c2426');
  },
  apc(g, P) {
    volume(g, rect(g, 0.3, -0.07, 2.4, 0.14), '#34382c');
    const t = () => { g.beginPath(); g.arc(0, 0, 0.66, 0, Math.PI * 2); };
    volume(g, t, P.light, { light: 0.32 });
    volume(g, rect(g, 0.15, 0.2, 0.3, 0.25), '#1c2426');
  },
  spg(g, P) {
    volume(g, rect(g, 1.8, -0.16, 5.2, 0.32), '#3b3f32', { light: 0.3 });
    volume(g, rect(g, 6.7, -0.24, 0.45, 0.48), '#2c2f25');
    const t = rrect(g, -2.3, -1.25, 4.2, 2.5, 0.3);
    volume(g, t, P.light, { light: 0.3, dark: 0.35 });
    t(); camo(g, -2.3, -1.25, 4.2, 2.5, P, 55, 6);
    hatch(g, -1.0, -0.6, 0.35, P); hatch(g, -1.0, 0.6, 0.3, P);
    box(g, -2.25, -0.8, 0.4, 1.6, shade(P.body, -0.1));
  },
  mlrs(g, P) {
    // Пакет направляющих 40 труб (сверху видны торцы спереди)
    const t = rect(g, -1.9, -0.9, 3.4, 1.8);
    volume(g, t, '#3f4633', { light: 0.25 });
    lines(g, Array.from({ length: 5 }, (_, i) => [-1.9, -0.9 + i * 0.45, 1.5, -0.9 + i * 0.45]), 'rgba(0,0,0,0.35)', 0.04);
    g.fillStyle = '#16170f';
    for (let c = 0; c < 9; c++) { g.beginPath(); g.arc(1.42, -0.8 + c * 0.2, 0.07, 0, Math.PI * 2); g.fill(); }
  },
  armcar(g, P) {
    volume(g, rect(g, 0.2, -0.06, 1.3, 0.12), '#2b2e24');
    volume(g, rrect(g, -0.4, -0.35, 0.8, 0.7, 0.12), P.light, { light: 0.3 });
    volume(g, rect(g, 0.1, 0.12, 0.25, 0.2), '#1c2426');
  },
  sam(g, P) {
    volume(g, rrect(g, -1.3, -1.1, 2.6, 2.2, 0.3), P.light, { light: 0.3 });
    for (const y of [-0.85, -0.45, 0.45, 0.85]) volume(g, rrect(g, -1.1, y - 0.15, 2.2, 0.3, 0.15), '#434936', { light: 0.35 });
    // Радар
    volume(g, rrect(g, -1.25, -0.25, 0.5, 0.5, 0.1), '#2c2f28');
    lines(g, [[-1.0, -0.25, -1.0, 0.25]], 'rgba(160,200,160,0.4)', 0.05);
  },
};

// Спрайт корпуса: frame 0..3 — фаза гусениц/колёс
export function vehicleSprite(type, side, frame) {
  const d = DEF[type] || DEF.truck;
  const key = `v:${type}:${side}:${frame}`;
  let s = cache.get(key);
  if (s) return s;
  const pad = 0.6;
  const W = (d.w + pad * 2) * VPPM, H = (d.h + pad * 2) * VPPM;
  const c = mk(W, H);
  const g = c.getContext('2d');
  g.translate(W / 2, H / 2);
  g.scale(VPPM, VPPM);
  // Мягкая тень от корпуса (солнце сверху-слева)
  g.save();
  g.translate(0.35, 0.35);
  g.filter = 'blur(3px)';
  g.fillStyle = 'rgba(8,10,5,0.55)';
  g.beginPath(); g.roundRect(-d.w / 2 + 0.1, -d.h / 2 + 0.1, d.w - 0.2, d.h - 0.2, 0.4); g.fill();
  g.restore();
  const P = pal(side);
  (HULL[type] || HULL.truck)(g, P, frame, type.length * 131 + (side === 'blue' ? 7 : 3), side);
  s = { canvas: c, w: W / VPPM, h: H / VPPM, pivot: d.pivot };
  cache.set(key, s);
  return s;
}

export function turretSprite(type, side) {
  if (!TURRET[type]) return null;
  const key = `t:${type}:${side}`;
  let s = cache.get(key);
  if (s) return s;
  const R = 7.6; // спрайт с запасом под длинный ствол
  const art = mk(R * 2 * VPPM, R * 2 * VPPM);
  const g = art.getContext('2d');
  g.translate(R * VPPM, R * VPPM);
  g.scale(VPPM, VPPM);
  TURRET[type](g, pal(side), side);
  // Итог: мягкая тень башни на корпус + сама башня
  const c = mk(art.width, art.height);
  const o = c.getContext('2d');
  o.filter = 'brightness(0) blur(2px)';
  o.globalAlpha = 0.5;
  o.drawImage(art, 0.25 * VPPM, 0.25 * VPPM);
  o.filter = 'none';
  o.globalAlpha = 1;
  o.drawImage(art, 0, 0);
  s = { canvas: c, size: R * 2 };
  cache.set(key, s);
  return s;
}

// ---------- Бойцы ----------
// kind: rifle | mg | gl | sniper | atgm | medic | eng; pose: stand | crouch | prone | cover | dead
export const SOLDIER_FRAMES = 8;

function soldierKind(s) {
  if (s.role === 'Медик') return 'medic';
  if (s.weapon === 'mg') return 'mg';
  if (s.weapon === 'gl') return 'gl';
  if (s.weapon === 'sniper') return 'sniper';
  if (s.weapon === 'atgm') return 'atgm';
  if (s.role === 'Сапёр') return 'eng';
  return 'rifle';
}
export { soldierKind };

export function soldierSprite(side, kind, pose, frame) {
  const key = `s:${side}:${kind}:${pose}:${frame}`;
  let s = cache.get(key);
  if (s) return s;
  const R = 1.35;
  const c = mk(R * 2 * SPPM, R * 2 * SPPM);
  const g = c.getContext('2d');
  g.translate(R * SPPM, R * SPPM);
  g.scale(SPPM, SPPM);
  drawSoldierArt(g, side, kind, pose, frame);
  s = { canvas: c, size: R * 2 };
  cache.set(key, s);
  return s;
}

function weaponArt(g, kind, x, y, scale = 1) {
  const L = { rifle: 0.78, mg: 1.0, gl: 0.95, sniper: 1.15, atgm: 1.05, medic: 0.72, eng: 0.72 }[kind] * scale;
  g.save();
  g.translate(x, y);
  if (kind === 'gl') {
    // Гранатомёт на плече: труба с выстрелом
    volume(g, rrect(g, -0.45, -0.055, L, 0.11, 0.04), '#3d4232', { light: 0.35, lw: 0.025 });
    volume(g, () => { g.beginPath(); g.ellipse(L - 0.42, 0, 0.17, 0.08, 0, 0, Math.PI * 2); }, '#4d5a3a', { lw: 0.02 });
  } else if (kind === 'atgm') {
    volume(g, rrect(g, -0.5, -0.07, L, 0.14, 0.05), '#4a5238', { light: 0.35, lw: 0.025 });
  } else {
    volume(g, rect(g, 0, -0.035, L, 0.07), '#1c1d18', { light: 0.35, lw: 0.02 });
    if (kind === 'mg') { volume(g, rect(g, 0.25, -0.1, 0.18, 0.2), '#2a2b24', { lw: 0.02 }); lines(g, [[L - 0.1, -0.1, L - 0.02, -0.18], [L - 0.1, 0.1, L - 0.02, 0.18]], '#1c1d18', 0.025); }
    if (kind === 'sniper') volume(g, rect(g, 0.3, -0.055, 0.28, 0.11), '#15161a', { lw: 0.02 });
    else volume(g, rect(g, 0.28, 0.03, 0.08, 0.12), '#1c1d18', { lw: 0.015 }); // магазин
  }
  g.restore();
}

function drawSoldierArt(g, side, kind, pose, frame) {
  const P = pal(side);
  const uni = side === 'blue' ? '#6c7350' : '#606a45'; // форма
  const uniD = shade(uni, -0.3);
  const vest = side === 'blue' ? '#4e5438' : '#4a4f33';
  const helmet = side === 'blue' ? '#5d6547' : '#545d3c';
  const skin = '#b58a6a';
  const ph = (frame / SOLDIER_FRAMES) * Math.PI * 2;
  const sw = Math.sin(ph);
  // Тень
  g.save();
  g.filter = 'blur(1.5px)';
  g.fillStyle = 'rgba(8,10,5,0.5)';
  g.beginPath();
  if (pose === 'prone' || pose === 'dead') g.ellipse(-0.45, 0.1, 0.95, 0.32, 0, 0, Math.PI * 2);
  else g.ellipse(0.08, 0.12, 0.34, 0.42, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
  const limb = (x0, y0, x1, y1, w, col) => {
    g.strokeStyle = 'rgba(10,10,8,0.8)'; g.lineWidth = w + 0.05; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    g.strokeStyle = col; g.lineWidth = w;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
  };
  if (pose === 'prone' || pose === 'dead') {
    // Лёжа: тело вдоль направления, ноги сзади, оружие вперёд
    const k = pose === 'dead' ? 0 : sw * 0.12;
    limb(-0.75, 0.12, -1.25 + k, 0.3, 0.17, uniD);
    limb(-0.75, -0.12, -1.25 - k, -0.3, 0.17, uniD);
    volume(g, () => { g.beginPath(); g.ellipse(-0.42, 0, 0.5, 0.27, 0, 0, Math.PI * 2); }, uni, { lw: 0.035 });
    volume(g, rrect(g, -0.62, -0.2, 0.42, 0.4, 0.08), vest, { lw: 0.03 });
    volume(g, rrect(g, -0.95, -0.17, 0.34, 0.34, 0.06), shade(vest, -0.1), { lw: 0.03 }); // рюкзак
    if (pose !== 'dead') {
      limb(-0.15, 0.2, 0.25 + k * 0.5, 0.1, 0.1, uni);
      limb(-0.15, -0.2, 0.3, -0.03, 0.1, uni);
      weaponArt(g, kind, 0.02, 0.05);
    } else {
      limb(-0.2, 0.22, 0.05, 0.55, 0.1, uni);
      g.fillStyle = 'rgba(110,20,15,0.55)';
      g.beginPath(); g.ellipse(-0.35, 0.2, 0.5, 0.3, 0.4, 0, Math.PI * 2); g.fill();
    }
    volume(g, () => { g.beginPath(); g.arc(0.06, 0, 0.15, 0, Math.PI * 2); }, helmet, { light: 0.35, lw: 0.035 });
    return;
  }
  const crouch = pose === 'crouch' || pose === 'cover';
  const sc = crouch ? 0.85 : 1;
  // Ноги — шаг (видны спереди и сзади корпуса)
  if (pose !== 'cover') {
    const st = 0.32 * sw * sc;
    limb(0, 0.12, st, 0.14, 0.14, uniD);
    limb(0, -0.12, -st, -0.14, 0.14, uniD);
    // Ботинки
    g.fillStyle = '#211d17';
    g.beginPath(); g.arc(st, 0.14, 0.075, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(-st, -0.14, 0.075, 0, Math.PI * 2); g.fill();
  }
  // Рюкзак / сумка медика / тубус ПТУР
  if (kind === 'medic') {
    volume(g, rrect(g, -0.42 * sc, -0.2, 0.26, 0.4, 0.06), '#5a6040', { lw: 0.03 });
    g.fillStyle = '#e8e6da'; g.fillRect(-0.38 * sc, -0.07, 0.16, 0.14);
    g.fillStyle = '#c62b2b'; g.fillRect(-0.33 * sc, -0.055, 0.05, 0.11); g.fillRect(-0.36 * sc, -0.025, 0.11, 0.05);
  } else if (kind === 'atgm') {
    volume(g, rrect(g, -0.55, -0.1, 0.8, 0.2, 0.08), '#4a5238', { lw: 0.03 });
  } else {
    volume(g, rrect(g, -0.4 * sc, -0.19, 0.22, 0.38, 0.06), shade(vest, -0.12), { lw: 0.03 });
    if (kind === 'eng') lines(g, [[-0.35, 0.22, -0.05, 0.36]], '#6b5a3c', 0.05); // лопатка
  }
  // Корпус: плечи поперёк, бронежилет с подсумками
  volume(g, () => { g.beginPath(); g.ellipse(0, 0, 0.19 * sc, 0.33 * sc, 0, 0, Math.PI * 2); }, uni, { lw: 0.035 });
  volume(g, rrect(g, -0.15 * sc, -0.22 * sc, 0.28 * sc, 0.44 * sc, 0.06), vest, { light: 0.3, lw: 0.03 });
  for (const y of [-0.12, 0, 0.12]) { g.fillStyle = shade(vest, -0.2); g.fillRect(0.06 * sc, (y - 0.04) * sc, 0.07, 0.08 * sc); }
  // Опознавательная повязка на плече
  g.fillStyle = P.mark;
  g.beginPath(); g.ellipse(-0.02, 0.29 * sc, 0.07, 0.045, 0, 0, Math.PI * 2); g.fill();
  // Руки к оружию: правая у приклада, левая на цевье; при ходьбе чуть покачиваются
  const aw = crouch ? 0 : sw * 0.03;
  if (kind === 'gl' || kind === 'atgm') {
    limb(0.0, 0.28 * sc, 0.12, 0.2, 0.09, uni);
    limb(0.0, -0.28 * sc, 0.2, -0.02, 0.09, uni);
    weaponArt(g, kind, -0.05, 0.14);
  } else {
    limb(0.02, 0.27 * sc, 0.2 + aw, 0.1, 0.09, uni);
    limb(0.02, -0.27 * sc, 0.38 - aw, 0.02, 0.09, uni);
    g.fillStyle = skin;
    g.beginPath(); g.arc(0.2 + aw, 0.1, 0.045, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(0.38 - aw, 0.02, 0.045, 0, Math.PI * 2); g.fill();
    weaponArt(g, kind, 0.1, 0.07);
  }
  // Голова: каска с чехлом и лентой
  volume(g, () => { g.beginPath(); g.arc(0.03, 0, 0.155, 0, Math.PI * 2); }, helmet, { light: 0.4, dark: 0.35, lw: 0.035 });
  g.strokeStyle = shade(helmet, -0.35); g.lineWidth = 0.025;
  g.beginPath(); g.arc(0.03, 0, 0.1, 0, Math.PI * 2); g.stroke();
  g.fillStyle = 'rgba(255,255,230,0.25)';
  g.beginPath(); g.arc(-0.02, -0.05, 0.05, 0, Math.PI * 2); g.fill();
}

// Цвет знака стороны (для мелких отметок)
export function sideMark(side) {
  return pal(side).mark;
}
