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

export function buildPowerGrid(world, rng) {
  const city = world.settlements.find((s) => s.type === 'city');
  const { mask } = world;
  // Главная подстанция: у западной окраины города, на свободном месте
  let main = null;
  for (let a = 0; a < 60 && !main; a++) {
    const x = city.x - rng.float(700, 1300), y = city.y + rng.float(-500, 500);
    if (!mask.near(x, y, 45, M.ROAD | M.WATER | M.BUILD | M.RAIL | M.CITY)) main = { x, y, w: 50, h: 36, angle: rng.float(-0.3, 0.3) };
  }
  if (!main) main = { x: city.x - 900, y: city.y, w: 50, h: 36, angle: 0 };
  main.hp = 1;
  main.alive = true;
  mask.stampDisc(main.x, main.y, 32, M.BUILD);

  // ЛЭП 110 кВ с западного края карты
  const feedPts = [];
  const y0 = main.y + rng.float(-600, 600);
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    feedPts.push([-50 + (main.x - 30 + 50) * t, y0 + (main.y - y0) * t + Math.sin(t * 5 + rng.float(0, 3)) * 40 * (1 - t)]);
  }
  const pylons = resample(feedPts, 260).map(([x, y]) => ({ x, y }));

  // ТП: центры районов города (по застройке) и сёл
  const tps = [];
  const houses = world.buildings.items.filter((b) => b.interior && (b.style === 'gable' || b.style === 'flat'));
  const cityHouses = houses.filter((b) => Math.hypot(b.x - city.x, b.y - city.y) < 1900);
  // Простая кластеризация: сетка 420 м
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
  for (const v of world.settlements) if (v.type === 'village') tps.push(placeTp(world, rng, v.x, v.y));

  // Фидеры 10 кВ: от главной подстанции к каждой ТП (столбы через 45 м)
  for (const tp of tps) {
    const pts = resample([[main.x, main.y], [(main.x + tp.x) / 2 + rng.float(-80, 80), (main.y + tp.y) / 2 + rng.float(-80, 80)], [tp.x, tp.y]], 45);
    tp.poles = pts;
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
  // Уличные фонари вдоль городских и сельских улиц
  const lamps = [];
  for (const r of world.roadList) {
    if (!['street', 'avenue', 'village'].includes(r.type)) continue;
    const pts = resample(r.line, r.type === 'village' ? 60 : 38);
    for (const [x, y] of pts) {
      let best = -1, bd = 900;
      tps.forEach((tp, i) => {
        const d = Math.hypot(tp.x - x, tp.y - y);
        if (d < bd) { bd = d; best = i; }
      });
      if (best >= 0) lamps.push({ x, y, tp: best, on: rng.chance(r.type === 'village' ? 0.6 : 0.85) });
    }
  }
  world.power = { main, pylons, feedCut: null, tps, lamps, version: 0 };
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
  return p.main.alive && !p.feedCut && tp.alive && !tp.cut;
}

// Урон сети от разрыва; возвращает список сообщений и область перерисовки
export function damagePower(world, x, y, blast) {
  const p = world.power;
  if (!p) return [];
  const msgs = [];
  const near = (a, r) => Math.hypot(a.x - x, a.y - y) < r;
  if (p.main.alive && near(p.main, blast * 1.5 + 22)) {
    p.main.hp -= blast / 9;
    if (p.main.hp <= 0) { p.main.alive = false; msgs.push('Главная подстанция уничтожена — город и сёла обесточены'); }
  }
  if (!p.feedCut) for (const pl of p.pylons) if (near(pl, blast + 5)) { p.feedCut = { x: pl.x, y: pl.y }; msgs.push('Перебита ЛЭП 110 кВ — город обесточен'); break; }
  p.tps.forEach((tp, i) => {
    if (tp.alive && near(tp, blast + 3)) { tp.alive = false; msgs.push('Разрушена трансформаторная подстанция — район без света'); }
    if (!tp.cut) for (const [px, py] of tp.poles) if (Math.hypot(px - x, py - y) < blast + 2) { tp.cut = { x: px, y: py }; msgs.push('Оборван фидер 10 кВ — район без света'); break; }
  });
  if (msgs.length) p.version++;
  return msgs;
}
