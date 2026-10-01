// Дымовые шлейфы пожаров: дым поднимается столбом, на высоте ветер сносит его и растягивает на
// километры — шлейф расширяется, светлеет и рассеивается; на земле под ним — тень. Горящая
// нефтебаза или ТЭС видна издалека по шлейфу через пол-карты, горящий дом — на сотни метров.
// Шлейф — не частицы, а функция времени: клубы равномерно «едут» вдоль оси по ветру, ось слегка
// петляет (порывы); дёшево и одинаково у всех игроков.

import { K3 } from './mesh3d.js';

let puff = null, puffLight = null;
function sprite(dark) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(64, 64) : Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  const col = dark ? '34,32,30' : '150,146,140';
  gr.addColorStop(0, `rgba(${col},1)`); gr.addColorStop(0.45, `rgba(${col},0.75)`); gr.addColorStop(1, `rgba(${col},0)`);
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return c;
}
const hash = (i) => { const s = Math.sin(i * 127.1) * 43758.5453; return s - Math.floor(s); };

// Источники: пожары на узлах объектов, горящие дома (артиллерия, обломки), пожары на полях,
// свежие прилёты (небольшой дым минуты две)
function sources(g, sim) {
  const out = [];
  for (const o of g.objects)
    for (const c of o.comps) {
      if (c.fire <= 0) continue;
      const big = c.k === 'tank' || c.k === 'coal' ? 3 : c.k === 'unit' || c.k === 'shop' || c.k === 'hall' ? 2 : c.k === 'gsu' || c.k === 'at' || c.k === 'tr' ? 1.6 : 1;
      out.push({ x: c.x, y: c.y, k: big, oil: c.k === 'tank' || c.k === 'tr' || c.k === 'gsu' || c.k === 'at', seed: c.x * 0.37 + c.y * 0.11 });
    }
  for (const f of sim.fires || []) if (f.until > sim.time) out.push({ x: f.x, y: f.y, k: Math.min(1.6, f.r / 20), seed: f.x * 0.21 });
  for (const f of g.fieldFires || []) out.push({ x: f.x, y: f.y, k: 0.8 + f.r / 60, light: true, seed: f.y * 0.17 });
  for (const f of g.fx || []) if (f.t === 'impact' && sim.time - f.t0 < 150) out.push({ x: f.x, y: f.y, k: 0.35 + Math.min(0.6, (f.wh || 10) / 80), fade: 1 - (sim.time - f.t0) / 150, seed: f.x * 0.13 });
  return out;
}

export function drawSmoke(ctx, g, sim, view, now, low) {
  const { cam, canvas, dpr } = view, z = cam.zoom, W = canvas.width, H = canvas.height;
  puff = puff || sprite(true); puffLight = puffLight || sprite(false);
  const list = sources(g, sim);
  if (!list.length) return;
  const wind = g.wind ?? 0.6, dir = g.weather?.dir ?? 0.6, wx = Math.cos(dir), wy = Math.sin(dir);
  const rain = g.weather?.kind === 'rain' ? 0.6 : 1;
  const t = now / 1000;
  const toS = (x, y) => [(x - cam.x) * z + W / 2, (y - cam.y) * z + H / 2];
  ctx.save();
  for (const S of list) {
    // длина шлейфа: от сотен метров (дом) до 6–8 км (резервуар с нефтепродуктами); при слабом ветре
    // дым стоит выше и короче, при сильном — стелется длинной полосой
    const L = (350 + S.k * S.k * 900) * (0.45 + wind) * rain * (S.fade ?? 1);
    const rise = 40 + S.k * 70; // высота, на которой дым ложится по ветру, м
    // клубы расставлены по геометрической прогрессии: шаг ≈ доле радиуса клуба, поэтому у источника
    // (узкий столб) клубы часто и шлейф сплошной, а в широком хвосте — реже, без лишней работы
    const r0 = 6 + S.k * 7, grow = 0.09 + 0.05 * (1 - wind), s0 = r0 / grow;
    const cap = low ? 22 : 64;
    const c = Math.max(0.55 * grow, Math.log((L + s0) / s0) / cap), n = Math.ceil(Math.log((L + s0) / s0) / c);
    const v = 4 + wind * 9; // скорость сноса, м/с
    const ph = (t * v * c) / (r0 * 2); // фаза движения клубов вдоль шлейфа
    for (const pass of low ? [1] : [0, 1]) { // 0 — тень на земле, 1 — сам дым
      for (let i = n - 1; i >= 0; i--) {
        const s = s0 * (Math.exp(c * (i + (ph % 1))) - 1); // расстояние от источника по ветру
        if (s > L) continue;
        const u = s / L; // 0 у источника → 1 в конце шлейфа
        const meander = Math.sin(s / 420 + S.seed + t * 0.05) * s * 0.07 + Math.sin(s / 130 + S.seed * 2) * s * 0.025;
        const x = S.x + wx * s - wy * meander, y = S.y + wy * s + wx * meander;
        const h = rise * Math.min(1, u * 6) + s * 0.04; // столб, затем плавный подъём
        const r = r0 + s * grow; // шлейф расширяется
        const a = (S.light ? 0.2 : S.oil ? 0.4 : 0.3) * Math.pow(1 - u, 1.25) * Math.min(1, u * 14 + 0.35) * (S.fade ?? 1);
        let [sx, sy] = toS(x, y);
        if (pass) sy -= h * K3 * z; else { sx += h * 0.3 * z; sy += h * 0.34 * z; }
        const R = Math.max(1.5 * dpr, r * z);
        if (sx + R < 0 || sy + R < 0 || sx - R > W || sy - R > H) continue;
        ctx.globalAlpha = pass ? a : a * 0.22;
        // у источника — чёрный дым, дальше — серый (разбавляется воздухом)
        ctx.drawImage(pass && u > 0.45 && !S.oil ? puffLight : puff, sx - R, sy - R * 0.85, R * 2, R * 1.7);
      }
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}
void hash;
