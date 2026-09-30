// Смена дня и ночи и электросеть.
// Сеть: ЛЭП 110 кВ с запада → главная подстанция города → фидеры 10 кВ →
// трансформаторные подстанции (ТП) по районам и сёлам → дома и уличные фонари.
// Разрушили подстанцию или перебили провод — район гаснет.

import { M } from './spatial.js';
import { resample } from './geom.js';

// Освещённость: 1 — день, 0 — ночь (рассвет 4:30–6:00, закат 19:30–21:30)
export function daylight(time) {
  const h = (time / 3600) % 24;
  if (h >= 6 && h < 19.5) return 1;
  if (h < 4.5 || h >= 21.5) return 0;
  if (h < 6) return (h - 4.5) / 1.5;
  return 1 - (h - 19.5) / 2;
}

// Сеть: у каждого города своя главная подстанция с ЛЭП 110 кВ от ближнего края карты.
// ТП городских районов и сёл питаются от ближайшей главной подстанции.
export function buildPowerGrid(world, rng) {
  const { mask } = world;
  const cities = world.settlements.filter((s) => s.type === 'city');
  const mains = [];
  for (const city of cities) {
    const west = city.x < world.W / 2; // ЛЭП приходит с «тыльного» края
    let main = null;
    for (let a = 0; a < 60 && !main; a++) {
      const x = city.x + (west ? -1 : 1) * rng.float(700, 1300), y = city.y + rng.float(-500, 500);
      if (!mask.near(x, y, 45, M.ROAD | M.WATER | M.BUILD | M.RAIL | M.CITY)) main = { x, y, w: 50, h: 36, angle: rng.float(-0.3, 0.3) };
    }
    if (!main) main = { x: city.x + (west ? -900 : 900), y: city.y, w: 50, h: 36, angle: 0 };
    main.hp = 1;
    main.alive = true;
    main.feedCut = null;
    main.name = city.name;
    mask.stampDisc(main.x, main.y, 32, M.BUILD);
    const feedPts = [];
    const y0 = main.y + rng.float(-600, 600);
    const x0 = west ? -50 : world.W + 50;
    const x1 = main.x + (west ? -30 : 30);
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      feedPts.push([x0 + (x1 - x0) * t, y0 + (main.y - y0) * t + Math.sin(t * 5 + rng.float(0, 3)) * 40 * (1 - t)]);
    }
    main.pylons = resample(feedPts, 260).map(([x, y]) => ({ x, y }));
    mains.push(main);
  }

  const { tps, lamps } = buildDistribution(world, rng, mains, cities);
  world.power = { mains, tps, lamps, version: 0 };
}


// Распределительная сеть: ТП районов и сёл, фидеры 10 кВ, привязка домов и фонарей
function buildDistribution(world, rng, mains, cities, sameSide = null) {
  // ТП: центры районов городов (по застройке) и сёл
  const tps = [];
  const houses = world.buildings.items.filter((b) => (b.interior || world.layout === 'dronewar') && (b.style === 'gable' || b.style === 'flat'));
  for (const city of cities) {
    const cityHouses = houses.filter((b) => Math.hypot(b.x - city.x, b.y - city.y) < 1900 * (city.capital === false ? 0.65 : 1));
    const cells = new Map();
    for (const b of cityHouses) {
      const k = Math.floor(b.x / 420) + ',' + Math.floor(b.y / 420);
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(b);
    }
    for (const list of cells.values()) {
      if (list.length < 6) continue;
      const cx = list.reduce((a, b) => a + b.x, 0) / list.length, cy = list.reduce((a, b) => a + b.y, 0) / list.length;
      tps.push(placeTp(world, rng, cx, cy));
    }
  }
  for (const v of world.settlements) if (v.type === 'village') tps.push(placeTp(world, rng, v.x, v.y));

  // Фидеры 10 кВ: от ближайшей главной подстанции к каждой ТП (столбы через 45 м)
  for (const tp of tps) {
    let mi = 0, md = Infinity;
    mains.forEach((m, i) => { if (sameSide && m.side !== sameSide(tp)) return; const d = Math.hypot(m.x - tp.x, m.y - tp.y); if (d < md) { md = d; mi = i; } });
    const main = mains[mi];
    tp.main = mi;
    // фидер выходит из ячейки 10 кВ на краю подстанции, а не из её середины
    let sx = main.x, sy = main.y;
    if (main.w) {
      const c = Math.cos(main.angle || 0), sn = Math.sin(main.angle || 0);
      const lx = (tp.x - main.x) * c + (tp.y - main.y) * sn, ly = -(tp.x - main.x) * sn + (tp.y - main.y) * c;
      const k = Math.min((main.w / 2 - 3) / (Math.abs(lx) || 1e-6), (main.h / 2 - 3) / (Math.abs(ly) || 1e-6));
      sx = main.x + lx * k * c - ly * k * sn; sy = main.y + lx * k * sn + ly * k * c;
    }
    tp.poles = resample([[sx, sy], [(sx + tp.x) / 2 + rng.float(-80, 80), (sy + tp.y) / 2 + rng.float(-80, 80)], [tp.x, tp.y]], 45);
    tp.alive = true;
    tp.cut = null;
  }
  // Здания — к ближайшей ТП
  for (const b of houses) {
    let best = -1, bd = 1400;
    tps.forEach((tp, i) => {
      const d = Math.hypot(tp.x - b.x, tp.y - b.y);
      if (d < bd) { bd = d; best = i; }
    });
    b.tp = best;
  }
  // Уличные фонари — на обочине (не на оси дороги), через одну опору по разные стороны; на проспектах —
  // с обеих сторон. У фонаря — направление к проезжей части (световое пятно смещено на дорогу)
  const lamps = [];
  world.roadList.forEach((r, ri) => {
    if (!['street', 'avenue', 'village'].includes(r.type)) return;
    const pts = resample(r.line, r.type === 'village' ? 55 : r.type === 'avenue' ? 30 : 36);
    for (let k = 0; k < pts.length; k++) {
      const [x, y] = pts[k];
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1];
      const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
      let best = -1, bd = 900;
      tps.forEach((tp, i) => {
        const d = Math.hypot(tp.x - x, tp.y - y);
        if (d < bd) { bd = d; best = i; }
      });
      if (best < 0) continue;
      // в сёлах опоры 0,4 кВ (с фонарями) — по одной стороне улицы, в городе — через одну
      const sides = r.type === 'avenue' ? [1, -1] : r.type === 'village' ? [1] : [k % 2 ? 1 : -1];
      for (const sd of sides) {
        const off = (r.width || 8) / 2 + 1.6;
        const nx = -ty * sd, ny = tx * sd; // от оси дороги к фонарю
        const lx = x + nx * off, ly = y + ny * off;
        if (world.mask.has(lx, ly, M.BUILD | M.WATER)) continue;
        lamps.push({ x: lx, y: ly, nx: -nx, ny: -ny, tp: best, on: rng.chance(r.type === 'village' ? 0.6 : 0.85), road: r.type === 'village' ? ri : -1 });
      }
    }
  });
  return { tps, lamps };
}

// Сеть режима «Война дронов»: питание районов — от городских ПС 110 кВ (их состояние ведёт симуляция);
// магистральные ЛЭП 330/110 кВ — в world.power.lines (строит генератор карты)
export function buildPowerGridDW(world, rng) {
  const lines = world.power?.lines || [];
  const mains = world.infra.filter((o) => o.kind === 'ps110').map((o) => ({
    x: o.x, y: o.y, w: o.w, h: o.h, angle: o.angle, hp: 1, alive: true, feedCut: null, name: o.name, pylons: [], dw: true, side: o.side, infraId: o.id, supply: 1, shift: 0,
  }));
  const cities = world.settlements.filter((s) => s.type === 'city');
  const { tps, lamps } = buildDistribution(world, rng, mains, cities, (tp) => (tp.x < world.W / 2 ? 'blue' : 'red'));
  world.power = { mains, tps, lamps, lines, version: 0 };
}

function placeTp(world, rng, x, y) {
  for (let a = 0; a < 40; a++) {
    const px = x + rng.float(-60, 60), py = y + rng.float(-60, 60);
    if (!world.mask.near(px, py, 5, M.ROAD | M.WATER | M.BUILD)) {
      world.mask.stampDisc(px, py, 3, M.BUILD);
      return { x: px, y: py };
    }
  }
  return { x, y };
}

export function tpPowered(world, i) {
  const p = world.power;
  if (!p || i < 0 || i === undefined) return false;
  const tp = p.tps[i];
  const m = p.mains[tp.main];
  if (!(m.alive && !m.feedCut && tp.alive && !tp.cut)) return false;
  // Дефицит мощности: графики отключений — часть районов без света (очередь сдвигается)
  if (m.supply !== undefined && m.supply < 0.999) return ((i * 0.6180339887 + (m.shift || 0)) % 1) < m.supply;
  return true;
}

// Урон сети от разрыва; возвращает список сообщений и область перерисовки
export function damagePower(world, x, y, blast) {
  const p = world.power;
  if (!p) return [];
  const msgs = [];
  const near = (a, r) => Math.hypot(a.x - x, a.y - y) < r;
  for (const m of p.mains) {
    if (m.dw) continue; // ПС режима «Война дронов» повреждает его симуляция
    if (m.alive && near(m, blast * 1.5 + 22)) {
      m.hp -= blast / 9;
      if (m.hp <= 0) { m.alive = false; msgs.push(`Подстанция «${m.name}» уничтожена — город и сёла вокруг обесточены`); }
    }
    if (!m.feedCut) for (const pl of m.pylons) if (near(pl, blast + 5)) { m.feedCut = { x: pl.x, y: pl.y }; msgs.push(`Перебита ЛЭП 110 кВ к подстанции «${m.name}» — город обесточен`); break; }
  }
  p.tps.forEach((tp, i) => {
    if (tp.alive && near(tp, blast + 3)) { tp.alive = false; msgs.push('Разрушена трансформаторная подстанция — район без света'); }
    if (!tp.cut) for (const [px, py] of tp.poles) if (Math.hypot(px - x, py - y) < blast + 2) { tp.cut = { x: px, y: py }; msgs.push('Оборван фидер 10 кВ — район без света'); break; }
  });
  if (msgs.length) p.version++;
  return msgs;
}
