// Процедурная генерация карты: степь, поля с лесополосами, река, балка,
// трасса, железная дорога, город и сёла. Всё детерминировано по seed.

import { checkWorld } from './mapcheck.js';
import { Rng, fbm } from './rng.js';
import {
  bboxOf, catmullRom, resample, offsetLine, tangents, pointInPoly,
  distToLine, rectCorners, blob, dist,
} from './geom.js';
import { SpatialIndex, PointBins, Mask, M } from './spatial.js';
import { buildFortifications, digTrench } from './forts.js';
import { seedBattleDamage } from './damage.js';
import { generateInterior } from './interiors.js';
import { buildPowerGrid, buildPowerGridDW } from './power.js';

export const WORLD_W = 12000;
export const WORLD_H = 6000;

const CITY_NAMES = ['Верхнеозёрск', 'Степногорск', 'Краснолиманск', 'Заречанск'];
// «Война дронов»: у сторон свои названия (без повторов между сторонами)
const DW_VILLAGES = {
  blue: ['Лесная Гать', 'Вербовка', 'Озерцы', 'Сосновый Бор', 'Липово', 'Грабовец', 'Белая Криница', 'Ясенево', 'Ракитное', 'Верховье', 'Зарецкое', 'Малая Ольшанка', 'Полесское', 'Светлый Луг', 'Калиновка', 'Бережаны', 'Вишнёвое', 'Старый Млын', 'Ольшаны', 'Дубровица', 'Ивница', 'Буковина', 'Кленовое', 'Ярова', 'Медвежий Лог', 'Ставки', 'Хмелёвка', 'Ардень-Гора'],
  red: ['Сухой Лог', 'Ковыльное', 'Солончак', 'Кумыш', 'Горелый Курган', 'Буруны', 'Сарыбулак', 'Красный Кут', 'Бугры', 'Жёлтая Балка', 'Тузлы', 'Каменный Курган', 'Отрадное', 'Весёлый Кут', 'Кардашёвка', 'Сартан', 'Новокардаш', 'Таганка', 'Ак-Сай', 'Полынное', 'Карагач', 'Мирный Стан', 'Байрак', 'Суховей', 'Сивашик', 'Терновка', 'Степной Колодец', 'Кош-Чокрак'],
};
const VILLAGE_NAMES = ['Сосновка', 'Дубровное', 'Каменный Брод', 'Весёлое', 'Лозовая', 'Старая Балка', 'Приволье', 'Зелёный Гай', 'Малиновка', 'Кривая Лука', 'Тихий Яр', 'Берёзовка', 'Ольховое', 'Красный Хутор'];

// Типы культур на полях (цвет — спутниковый вид конца лета)
export const CROPS = {
  wheat:     { color: '#c4ab72', furrow: 'rgba(120,95,50,0.20)', tram: true },
  stubble:   { color: '#cdbd8e', furrow: 'rgba(140,120,70,0.22)', tram: true },
  plowed:    { color: '#6f5a43', furrow: 'rgba(40,28,18,0.35)', tram: false },
  harrowed:  { color: '#85705a', furrow: 'rgba(60,45,30,0.22)', tram: false },
  sunflower: { color: '#5d6532', furrow: 'rgba(30,35,10,0.35)', tram: true, dots: '#a39030' },
  corn:      { color: '#56703a', furrow: 'rgba(25,40,15,0.35)', tram: true },
  fallow:    { color: '#858550', furrow: null, tram: false },
  meadow:    { color: '#707c46', furrow: null, tram: false },
  // пятна степи (без границ): залежь, выгоревшая трава, сырые понижения
  dry:       { color: '#958f5e', furrow: null, tram: false, soft: 0.45 },
  green:     { color: '#66744a', furrow: null, tram: false, soft: 0.4 },
  bare:      { color: '#8b7a5c', furrow: null, tram: false, soft: 0.3 },
};

function newWorld(seed, W, H, res = 4) {
  return {
    seed, W, H,
    mask: new Mask(W, H, res),
    fields: new SpatialIndex(W, H),
    areas: new SpatialIndex(W, H),
    water: new SpatialIndex(W, H),
    roads: new SpatialIndex(W, H),
    rails: new SpatialIndex(W, H),
    buildings: new SpatialIndex(W, H, 128),
    belts: new SpatialIndex(W, H),
    scars: new SpatialIndex(W, H, 128),
    forts: new SpatialIndex(W, H, 128),
    trees: new PointBins(W, H, 128, 4), // x, y, радиус, оттенок
    settlements: [],
    roadList: [],
  };
}

// Основная карта «Войны дронов»: выверенный seed (проверка и починка — mapcheck.js, связность дорог —
// connectRoadNet); случайные карты проходят те же проверки
export const MAIN_SEED = 1337;

export function generateWorld(seed, layout = 'front') {
  if (layout === 'dronewar') return generateDroneWarWorld(seed);
  const t0 = performance.now();
  const rng = new Rng(seed);
  const W = WORLD_W, H = WORLD_H;
  const world = newWorld(seed, W, H);
  world.layout = 'front';
  const mask = world.mask;

  // ---------- Ключевые точки ----------
  // Два города — по одному в тылу каждой стороны; фронт между ними
  const cityC = [W * 0.24 + rng.float(-150, 150), H * 0.5 + rng.float(-200, 200)];
  const cityB = [W * 0.76 + rng.float(-150, 150), H * 0.5 + rng.float(-200, 200)];
  const cities = [cityC, cityB];
  const villageSpots = [
    [W * 0.07, H * 0.15], [W * 0.08, H * 0.85], [W * 0.3, H * 0.12], [W * 0.3, H * 0.88],
    [W * 0.44, H * 0.28], [W * 0.46, H * 0.74], [W * 0.56, H * 0.22], [W * 0.54, H * 0.8],
    [W * 0.7, H * 0.12], [W * 0.7, H * 0.88], [W * 0.93, H * 0.16], [W * 0.92, H * 0.84],
  ].map(([x, y]) => [x + rng.float(-220, 220), y + rng.float(-180, 180)]);

  // ---------- Река ----------
  const riverLine = [];
  {
    const xTop = cityC[0] - 450 + rng.float(-200, 100);
    const xBot = cityC[0] + 200 + rng.float(-100, 250);
    const ph = rng.float(0, 6.28);
    for (let y = -150; y <= H + 150; y += 60) {
      const t = y / H;
      const x = xTop + (xBot - xTop) * t + Math.sin(y / 520 + ph) * 170 + (fbm(y / 900, 3.3, seed + 7) - 0.5) * 420;
      riverLine.push([x, y]);
    }
  }
  const river = resample(catmullRom(riverLine, 6), 12);
  const riverW = 34;
  addItem(world.water, { kind: 'river', line: river, width: riverW }, riverW + 200);
  mask.stampLine(river, riverW + 8, M.WATER);
  // Пойменный луг вдоль реки
  addItem(world.areas, { kind: 'floodplain', line: river, width: 260 }, 140);

  // ---------- Город: пятно застройки ----------
  const nameA = rng.pick(CITY_NAMES);
  let nameB = rng.pick(CITY_NAMES);
  while (nameB === nameA) nameB = rng.pick(CITY_NAMES);
  world.settlements.push({ name: nameA, x: cityC[0], y: cityC[1], type: 'city' });
  world.settlements.push({ name: nameB, x: cityB[0], y: cityB[1], type: 'city' });

  // ---------- Трасса (обходит город с севера) ----------
  const hwY = (cityC[1] + cityB[1]) / 2 - 1000;
  const highwayCtrl = [];
  for (let i = 0; i <= 10; i++) {
    const x = -200 + (i / 10) * (W + 400);
    const bend = cities.reduce((a, c) => a + Math.exp(-(((x - c[0]) / 1500) ** 2)) * -120, 0);
    highwayCtrl.push([x, hwY + bend + rng.float(-90, 90) + (i / 10 - 0.5) * 200]);
  }
  const highway = resample(catmullRom(highwayCtrl, 10), 10);
  addRoad(world, highway, 'highway');

  // ---------- Железная дорога (через город, южнее центра) ----------
  const railCtrl = [
    [-200, H * 0.72 + rng.float(-150, 150)],
    [cityC[0] - 300, cityC[1] + 280],
    [cityC[0] + 400, cityC[1] + 230],
    [W * 0.5, H * 0.62 + rng.float(-120, 120)],
    [cityB[0] - 400, cityB[1] + 250],
    [cityB[0] + 300, cityB[1] + 300],
    [W + 200, H * 0.66 + rng.float(-150, 150)],
  ];
  const rail = resample(catmullRom(railCtrl, 12), 8);
  addItem(world.rails, { kind: 'rail', line: rail, width: 10 }, 20);
  mask.stampLine(rail, 16, M.RAIL);

  // ---------- Балки с прудами ----------
  buildBalka(world, rng, river, cityC);
  buildBalka(world, rng, river, cityC);

  // ---------- Сёла: главная улица + дороги к городу ----------
  const villages = villageSpots.map((c, i) => {
    const angle = rng.float(0, Math.PI);
    const len = rng.float(900, 1400);
    const dir = [Math.cos(angle), Math.sin(angle)];
    const ctrl = [];
    for (let k = -2; k <= 2; k++) {
      const s = (k / 2) * (len / 2);
      ctrl.push([c[0] + dir[0] * s + rng.float(-40, 40) * -dir[1], c[1] + dir[1] * s + rng.float(-40, 40) * dir[0]]);
    }
    const street = resample(catmullRom(ctrl, 8), 8);
    addVillageGround(world, street);
    world.settlements.push({ name: VILLAGE_NAMES[(i + seed) % VILLAGE_NAMES.length], x: c[0], y: c[1], type: 'village' });
    return { c, street, angle };
  });

  // Дороги из сёл к городу и к трассе (асфальт). Дороги к городу кладём после
  // застройки: они заканчиваются на окраине и примыкают к уличной сетке.
  const toCity = [[], []];
  for (const v of villages) {
    const ci = Math.hypot(v.c[0] - cityC[0], v.c[1] - cityC[1]) < Math.hypot(v.c[0] - cityB[0], v.c[1] - cityB[1]) ? 0 : 1;
    const C = cities[ci];
    const nearCity = Math.hypot(v.c[0] - C[0], v.c[1] - C[1]) < 3200;
    if (nearCity && (rng.chance(0.6) || Math.abs(v.c[1] - hwY) > 1300)) toCity[ci].push(wobblyRoad(rng, v.c, C.slice(), 3));
    else addRoad(world, wobblyRoad(rng, v.c, nearestPoint(highway, v.c), 3), 'local');
  }
  // Дороги между соседними сёлами
  const linked = new Set();
  villages.forEach((a, i) => {
    let bj = -1, bd = Infinity;
    villages.forEach((b, j) => {
      if (i === j) return;
      const d = Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1]);
      if (d < bd) { bd = d; bj = j; }
    });
    const key = Math.min(i, bj) + ':' + Math.max(i, bj);
    if (bj < 0 || linked.has(key) || bd > 4200) return;
    linked.add(key);
    addRoad(world, wobblyRoad(rng, a.c, villages[bj].c, 4), rng.chance(0.5) ? 'local' : 'dirt');
  });

  for (const v of villages) addRoad(world, v.street, 'village');

  // ---------- Город ----------
  buildCity(world, rng, cityC, rail, river, toCity[0]);
  buildCity(world, rng, cityB, rail, river, toCity[1]);
  for (const line of [...toCity[0], ...toCity[1]]) connectToCity(world, line);

  // ---------- Сёла: дворы ----------
  for (const v of villages) {
    buildVillageStreet(world, rng, v.street, 1);
    // Поперечная улица
    const mid = v.street[Math.floor(v.street.length * rng.float(0.3, 0.7))];
    const a = v.angle + Math.PI / 2 + rng.float(-0.3, 0.3);
    const L = rng.float(350, 650);
    const cross = resample(catmullRom([
      [mid[0] - Math.cos(a) * L * 0.5, mid[1] - Math.sin(a) * L * 0.5],
      [mid[0] + rng.float(-20, 20), mid[1] + rng.float(-20, 20)],
      [mid[0] + Math.cos(a) * L * 0.5, mid[1] + Math.sin(a) * L * 0.5],
    ], 8), 8);
    addRoad(world, cross, 'dirt');
    addVillageGround(world, cross);
    buildVillageStreet(world, rng, cross, 0.85);
    buildFarm(world, rng, v);
  }

  // Кусты и одиночные деревья на выгонах вокруг сёл
  for (const line of world._vgroundLines) {
    for (let k = 0; k < line.length; k += 2) {
      if (!rng.chance(0.5)) continue;
      const [x0, y0] = line[k];
      const x = x0 + rng.gauss(0, 70), y = y0 + rng.gauss(0, 70);
      if (mask.has(x, y, M.ROAD | M.BUILD | M.SETTLE | M.WATER)) continue;
      const n = rng.int(1, 4);
      for (let t = 0; t < n; t++) world.trees.add(x + rng.float(-5, 5), y + rng.float(-5, 5), rng.float(1.5, 3.5), rng.int(0, 3));
    }
  }

  // ---------- Поля и лесополосы ----------
  buildFields(world, rng);

  // ---------- Ивы вдоль реки ----------
  for (let i = 0; i < river.length; i++) {
    const tg = tangents([river[Math.max(0, i - 1)], river[Math.min(river.length - 1, i + 1)]])[0];
    for (const side of [-1, 1]) {
      if (!rng.chance(0.55)) continue;
      const off = riverW / 2 + rng.float(3, 16);
      const x = river[i][0] - tg[1] * off * side + rng.float(-4, 4);
      const y = river[i][1] + tg[0] * off * side + rng.float(-4, 4);
      if (mask.has(x, y, M.ROAD | M.BUILD | M.RAIL | M.WATER)) continue;
      world.trees.add(x, y, rng.float(3, 6), rng.int(0, 3));
    }
  }

  // ---------- Следы войны: воронки и выгоревшие участки ----------
  const frontX = seedWarScars(world, rng, W * 0.5 + rng.float(-250, 250));

  // ---------- Окопы, блиндажи, подземные ходы обеих сторон ----------
  buildFortifications(world, rng, frontX);

  // ---------- Следы боёв: гарь, колеи, воронки, подбитая техника ----------
  seedBattleDamage(world, rng, frontX);

  // ---------- Планировки зданий, крыши, дорожки к дверям ----------
  finishBuildings(world, new Rng((seed ^ 0x1e7) >>> 0));

  // ---------- Электросеть: подстанции, ЛЭП, фонари ----------
  buildPowerGrid(world, new Rng((seed ^ 0x9091) >>> 0));

  // Кроны деревьев в маску — для расчёта прямой видимости
  refreshCanopy(world, { x0: 0, y0: 0, x1: W, y1: H });

  world.genTime = performance.now() - t0;
  return world;
}

// ================================================================
// Режим «Война дронов»: 40×22 км. У каждой стороны столица на реке и два города ближе к фронту,
// сёла, между ними — степь, пустыри, холмы; поля — только вокруг жилья. ТЭС, подстанции 330/110 кВ,
// мосты, нефтебаза, арсенал, завод БПЛА, стартовые позиции; для экономики и снабжения — погранпереход,
// распределительный центр, магазины и ТЦ, пожарные части, ремонтная база.
// Объекты — в world.infra (геометрия и узлы для симуляции).
// ================================================================
export const DW_W = 56000, DW_H = 30000;
export const DW_NAMES = {
  blue: { cities: ['Арденск', 'Белогорье', 'Тихомирск'], river: 'Ардена', tpp: 'Арденская ТЭС' },
  red: { cities: ['Кардагор', 'Краснокаменск', 'Заволжск'], river: 'Карда', tpp: 'Кардагорская ТЭС' },
};

// Узлы объектов (локальные координаты: u — вдоль оси объекта, v — поперёк; размеры в метрах)
// ТЭС и завод БПЛА — в реальную величину (промплощадка сотни метров)
const LAYOUT_SCALE = { tpp: 1.5, factory: 1.5 };
export function infraLayout(kind, L = 0) {
  const l = infraLayout0(kind, L), k = LAYOUT_SCALE[kind];
  if (!k) return l;
  return { ...l, w: l.w * k, h: l.h * k, comps: l.comps.map((q) => ({ ...q, u: q.u * k, v: q.v * k, w: q.w * k, h: q.h * k })) };
}
function infraLayout0(kind, L = 0) {
  const c = (k, u, v, w, h, extra = {}) => ({ k, u, v, w, h, ...extra });
  switch (kind) {
    case 'tpp': return { w: 440, h: 320, comps: [
      c('unit', -100, -40, 96, 58, { n: 'Энергоблок №1' }), c('unit', 0, -40, 96, 58, { n: 'Энергоблок №2' }), c('unit', 100, -40, 96, 58, { n: 'Энергоблок №3' }),
      c('chimney', -55, 30, 18, 18, { n: 'Дымовая труба №1' }), c('chimney', 55, 30, 18, 18, { n: 'Дымовая труба №2' }),
      c('tower', -150, 110, 76, 76, { n: 'Градирня №1' }), c('tower', -55, 120, 76, 76, { n: 'Градирня №2' }), c('tower', 40, 120, 76, 76, { n: 'Градирня №3' }),
      c('gsu', -100, -92, 14, 9, { n: 'Блочный трансформатор №1' }), c('gsu', 0, -92, 14, 9, { n: 'Блочный трансформатор №2' }), c('gsu', 100, -92, 14, 9, { n: 'Блочный трансформатор №3' }),
      c('oru', 160, -110, 110, 70, { n: 'ОРУ-330 кВ' }), c('coal', 165, 90, 100, 110, { n: 'Угольный склад' }), c('ctrl', -180, -110, 32, 20, { n: 'Главный щит управления' }),
    ] };
    case 'ps330': return { w: 340, h: 260, comps: [
      c('at', -80, 2, 20, 13, { n: 'АТ-1 330/110 кВ' }), c('at', 0, 2, 20, 13, { n: 'АТ-2 330/110 кВ' }), c('at', 80, 2, 20, 13, { n: 'АТ-3 330/110 кВ' }),
      c('oru', -10, -80, 280, 84, { n: 'ОРУ-330 кВ' }), c('oru', -10, 82, 280, 60, { n: 'ОРУ-110 кВ' }), c('ctrl', 150, -8, 30, 16, { n: 'ОПУ' }),
      c('tr', 150, 30, 9, 6.5, { n: 'ТСН 10/0,4 кВ' }), c('garage', 145, 105, 26, 14, { n: 'Склад и мастерская' }),
    ] };
    case 'ps110': return { w: 96, h: 76, comps: [
      c('tr', -16, 6, 9, 6.5, { n: 'Т-1 110/10 кВ' }), c('tr', 16, 6, 9, 6.5, { n: 'Т-2 110/10 кВ' }), c('oru', 0, -24, 84, 18, { n: 'ОРУ-110 кВ' }), c('ctrl', 34, 26, 14, 10, { n: 'ОПУ' }),
    ] };
    case 'oil': {
      const comps = [];
      let k = 1;
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) comps.push(c('tank', -80 + i * 40, -40 + j * 40, 24, 24, { n: `Резервуар РВС-${k++}` }));
      comps.push(c('pump', 100, -50, 26, 16, { n: 'Насосная' }), c('rack', 100, 40, 60, 10, { n: 'Эстакада налива' }));
      return { w: 270, h: 170, comps };
    }
    case 'ammo': {
      const comps = [];
      for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) comps.push(c('bunker', -105 + i * 60, -45 + j * 90, 26, 16, { n: `Хранилище №${i * 2 + j + 1}` }));
      comps.push(c('store', 0, 0, 60, 18, { n: 'Склад-ангар' }));
      return { w: 300, h: 190, comps };
    }
    case 'factory': return { w: 250, h: 170, comps: [
      c('shop', -70, -35, 80, 44, { n: 'Цех сборки' }), c('shop', 30, -35, 80, 44, { n: 'Цех двигателей' }), c('shop', -20, 45, 100, 40, { n: 'Цех композитов' }), c('ctrl', 95, 50, 30, 20, { n: 'Заводоуправление' }),
    ] };
    case 'launch': return { w: 150, h: 90, comps: [
      c('launcher', -40, -20, 12, 3.5, { n: 'Пусковая установка №1' }), c('launcher', -40, 20, 12, 3.5, { n: 'Пусковая установка №2' }),
      c('launcher', 10, -20, 12, 3.5, { n: 'Пусковая установка №3' }), c('launcher', 10, 20, 12, 3.5, { n: 'Пусковая установка №4' }),
      c('store', 55, 0, 26, 16, { n: 'Укрытие для БПЛА' }),
    ] };
    case 'hub': return { w: 300, h: 190, comps: [
      c('hall', -70, -40, 130, 60, { n: 'Склад класса А №1' }), c('hall', 75, -40, 110, 60, { n: 'Склад класса А №2' }),
      c('hall', -40, 55, 150, 50, { n: 'Холодильный склад' }), c('ctrl', 110, 60, 30, 20, { n: 'Административный корпус' }),
    ] };
    case 'border': return { w: 200, h: 110, comps: [
      c('canopy', -30, 0, 90, 34, { n: 'Навес досмотра' }), c('ctrl', 60, -30, 34, 16, { n: 'Здание таможни' }), c('hall', 60, 30, 50, 26, { n: 'Склад временного хранения' }),
    ] };
    case 'mall': return { w: 150, h: 110, comps: [c('mall', 0, -15, 110, 60, { n: 'Торговый центр' })] };
    case 'market': return { w: 70, h: 50, comps: [c('mall', 0, -5, 40, 26, { n: 'Супермаркет' })] };
    case 'store': return { w: 34, h: 26, comps: [c('kiosk', 0, 0, 16, 10, { n: 'Магазин' })] };
    case 'hpp': return { w: 230, h: 120, comps: [
      ...[0, 1, 2, 3].map((i) => c('hgen', -80 + i * 38, -18, 34, 30, { n: `Гидроагрегат №${i + 1}` })),
      c('gsu', -60, 32, 14, 9, { n: 'Блочный трансформатор №1' }), c('gsu', -10, 32, 14, 9, { n: 'Блочный трансформатор №2' }),
      c('oru', 80, 5, 56, 80, { n: 'ОРУ-330 кВ' }), c('ctrl', 35, 48, 26, 14, { n: 'Щит управления ГЭС' }),
    ] };
    case 'chp': return { w: 210, h: 150, comps: [
      c('unit', -50, -20, 60, 42, { n: 'Турбоагрегат №1' }), c('unit', 20, -20, 60, 42, { n: 'Турбоагрегат №2' }),
      c('chimney', -15, 45, 16, 16, { n: 'Дымовая труба' }), c('gsu', -50, -55, 12, 8, { n: 'Блочный трансформатор №1' }), c('gsu', 20, -55, 12, 8, { n: 'Блочный трансформатор №2' }),
      c('oru', 78, -30, 40, 50, { n: 'ОРУ-110 кВ' }), c('ctrl', 75, 45, 26, 16, { n: 'Щит управления ТЭЦ' }),
    ] };
    case 'wpp': {
      const n = 9, Lw = 2000, comps = [];
      for (let i = 0; i < n; i++) comps.push(c('wt', -Lw / 2 + (i * Lw) / (n - 1), (i % 2 ? 18 : -18), 14, 14, { n: `Ветроустановка №${i + 1}` }));
      comps.push(c('oru', Lw / 2 + 70, -10, 40, 32, { n: 'ОРУ-110 кВ (ПС ВЭС)' }), c('gsu', Lw / 2 + 70, 22, 12, 8, { n: 'Трансформатор ВЭС' }));
      return { w: Lw + 190, h: 76, comps };
    }
    case 'spp': {
      const comps = [];
      let k = 1;
      for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) comps.push(c('pv', -215 + i * 125, -70 + j * 140, 115, 125, { n: `Поле панелей №${k++}` }));
      comps.push(c('inv', 255, -40, 14, 7, { n: 'Инверторная станция №1' }), c('inv', 255, 40, 14, 7, { n: 'Инверторная станция №2' }), c('oru', 255, 110, 36, 30, { n: 'ОРУ-110 кВ (ПС СЭС)' }));
      return { w: 580, h: 300, comps };
    }
    case 'fuel': return { w: 76, h: 48, comps: [c('fcanopy', -8, -4, 34, 18, { n: 'Навес с колонками' }), c('kiosk', 24, 12, 16, 10, { n: 'Магазин АЗС' })] };
    case 'firest': return { w: 90, h: 60, comps: [c('garage', 0, -5, 60, 26, { n: 'Пожарное депо' }), c('ctrl', 32, 18, 16, 10, { n: 'Пункт связи' })] };
    case 'elevator': return { w: 300, h: 160, comps: [c('silo', -70, -30, 110, 40, { n: 'Силосный корпус №1' }), c('silo', 60, -30, 110, 40, { n: 'Силосный корпус №2' }), c('dryer', 135, -30, 20, 20, { n: 'Зерносушилка' }), c('hall', -50, 45, 150, 34, { n: 'Склад напольного хранения' }), c('ctrl', 90, 50, 28, 16, { n: 'Весовая' })] };
    case 'agro': return { w: 120, h: 80, comps: [c('garage', -22, -14, 64, 24, { n: 'Гараж сельхозтехники' }), c('canopy', 26, 16, 44, 20, { n: 'Навес для комбайнов' }), c('tank', 44, -20, 9, 9, { n: 'Ёмкость ГСМ' })] };
    case 'decoy': return infraLayout('ps110');
    case 'workshop': return { w: 260, h: 150, comps: [c('shop', -60, -25, 110, 50, { n: 'Сборочный цех №1' }), c('shop', 70, -25, 110, 50, { n: 'Сборочный цех №2' }), c('hall', -30, 45, 150, 30, { n: 'Склад комплектующих' }), c('ctrl', 90, 50, 30, 16, { n: 'Испытательная станция' })] };
    case 'refinery': {
      // НПЗ в реальную величину: резервуарный парк, установки, колонны, факел, эстакада налива
      const cs = [];
      for (let i = 0; i < 12; i++) cs.push(c('tank', -320 + (i % 6) * 54, -150 + Math.floor(i / 6) * 60, 42, 42, { n: `Резервуар №${i + 1}` }));
      cs.push(c('shop', 60, -120, 150, 60, { n: 'Установка первичной перегонки' }), c('shop', 60, -30, 150, 50, { n: 'Установка каталитического крекинга' }));
      cs.push(c('column', 190, -110, 22, 22, { n: 'Ректификационная колонна №1' }), c('column', 190, -50, 22, 22, { n: 'Ректификационная колонна №2' }), c('chimney', 250, 60, 16, 16, { n: 'Факельная труба' }));
      cs.push(c('rack', -120, 130, 320, 14, { n: 'Эстакада налива' }), c('hall', 150, 110, 120, 40, { n: 'Товарный парк и насосная' }), c('ctrl', -250, 110, 50, 24, { n: 'Операторная' }));
      return { w: 700, h: 400, comps: cs };
    }
    case 'watertower': return { w: 110, h: 80, comps: [c('wtower', -25, 0, 18, 18, { n: 'Водонапорная башня' }), c('ctrl', 25, 8, 36, 20, { n: 'Насосная с резервным генератором' })] };
    case 'railterm': return { w: 520, h: 130, comps: [c('rack', 0, -40, 440, 12, { n: 'Погрузочная эстакада' }), c('hall', -120, 25, 180, 40, { n: 'Склад зерна' }), c('silo', 90, 20, 120, 34, { n: 'Силосы перевалки' }), c('ctrl', 220, 30, 30, 16, { n: 'Диспетчерская станции' })] };
    case 'port': return { w: 360, h: 150, comps: [c('quay', 0, -52, 300, 12, { n: 'Причал с кранами' }), c('hall', -80, 20, 150, 50, { n: 'Портовый склад' }), c('silo', 90, 15, 110, 34, { n: 'Бункеры зерна' }), c('ctrl', 150, 55, 26, 14, { n: 'Управление порта' })] };
    case 'coalmine': return { w: 480, h: 320, comps: [c('headframe', -160, -80, 22, 22, { n: 'Копёр ствола №1' }), c('headframe', -110, -80, 22, 22, { n: 'Копёр ствола №2' }), c('shop', 60, -90, 170, 60, { n: 'Обогатительная фабрика' }), c('coal', 40, 70, 280, 110, { n: 'Угольный склад' }), c('hall', -160, 60, 90, 50, { n: 'Административно-бытовой комбинат' })] };
    case 'cement': return { w: 440, h: 240, comps: [c('silo', 120, -60, 150, 40, { n: 'Силосы цемента' }), c('shop', -80, -50, 200, 60, { n: 'Печной цех' }), c('chimney', -190, 60, 16, 16, { n: 'Труба печи' }), c('hall', 60, 60, 220, 50, { n: 'Склад стройматериалов' })] };
    case 'housing': return { w: 320, h: 200, comps: [c('house', -90, -55, 110, 14, { n: 'Жилой дом №1' }), c('house', 70, -55, 110, 14, { n: 'Жилой дом №2' }), c('house', -90, 5, 110, 14, { n: 'Жилой дом №3' }), c('house', 70, 5, 110, 14, { n: 'Жилой дом №4' }), c('house', -10, 65, 180, 14, { n: 'Жилой дом №5' }), c('hall', 120, 70, 50, 30, { n: 'Детский сад' })] };
    case 'hospital': return { w: 240, h: 160, comps: [c('house', -30, -35, 150, 18, { n: 'Главный корпус' }), c('house', 70, 30, 70, 16, { n: 'Приёмное отделение' }), c('house', -60, 40, 80, 16, { n: 'Инфекционный корпус' }), c('ctrl', 100, -60, 24, 14, { n: 'Котельная' })] };
    case 'school': return { w: 200, h: 140, comps: [c('house', -20, -35, 120, 16, { n: 'Учебный корпус' }), c('hall', 50, 30, 60, 28, { n: 'Спортзал' }), c('house', -50, 35, 60, 14, { n: 'Колледж' })] };
    case 'mill': return { w: 280, h: 170, comps: [c('shop', -60, -35, 120, 44, { n: 'Мельничный цех' }), c('silo', 80, -40, 90, 30, { n: 'Силосы муки и зерна' }), c('hall', 0, 45, 170, 34, { n: 'Хлебозавод и склад' })] };
    case 'dairy': return { w: 320, h: 160, comps: [c('barn', -80, -40, 120, 22, { n: 'Коровник №1' }), c('barn', 80, -40, 120, 22, { n: 'Коровник №2' }), c('barn', -80, 20, 120, 22, { n: 'Коровник №3' }), c('ctrl', 60, 25, 40, 20, { n: 'Молочный блок' }), c('tank', 120, 50, 16, 16, { n: 'Силосная башня' })] };
    case 'solar': return { w: 620, h: 420, comps: [c('pv', -170, -110, 250, 150, { n: 'Поле панелей №1' }), c('pv', 110, -110, 250, 150, { n: 'Поле панелей №2' }), c('pv', -170, 80, 250, 150, { n: 'Поле панелей №3' }), c('pv', 110, 70, 200, 130, { n: 'Поле панелей №4' }), c('inv', 260, 60, 22, 16, { n: 'Инверторная' }), c('oru', 260, 150, 50, 40, { n: 'ОРУ 110 кВ' })] };
    case 'bess': return { w: 90, h: 64, comps: [c('bess', -20, -4, 30, 26, { n: 'Контейнеры АКБ №1' }), c('bess', 20, -4, 30, 26, { n: 'Контейнеры АКБ №2' }), c('tr', 0, 22, 10, 8, { n: 'Трансформатор' })] };
    case 'pontoon': return { w: Math.max(40, L), h: 10, comps: [c('pont', 0, 0, Math.max(40, L), 8, { n: 'Понтонный мост' })] };
    case 'autopark': return { w: 240, h: 150, comps: [c('garage', -40, -30, 140, 34, { n: 'Гаражи' }), c('canopy', 60, 35, 110, 36, { n: 'Стоянка грузовиков' }), c('ctrl', -90, 45, 24, 14, { n: 'Диспетчерская' }), c('tank', -40, 45, 14, 14, { n: 'Заправка' })] };
    case 'reserve': return { w: 280, h: 170, comps: [c('hall', -60, 0, 140, 70, { n: 'Склад госрезерва' }), c('tank', 80, -45, 28, 28, { n: 'Резервуар ГСМ №1' }), c('tank', 80, 10, 28, 28, { n: 'Резервуар ГСМ №2' }), c('tank', 80, 60, 28, 28, { n: 'Резервуар ГСМ №3' })] };
    case 'rembase': return { w: 170, h: 110, comps: [c('garage', -35, -15, 80, 34, { n: 'Гараж техники' }), c('hall', 50, 10, 50, 40, { n: 'Склад оборудования' }), c('ctrl', -60, 35, 26, 14, { n: 'Диспетчерская' })] };
    case 'bridge': {
      const n = Math.max(2, Math.round(L / 40));
      const comps = [];
      for (let i = 0; i < n; i++) comps.push(c('span', -L / 2 + (i + 0.5) * (L / n), 0, L / n, 14, { n: `Пролёт ${i + 1}` }));
      return { w: L, h: 16, comps };
    }
  }
  return { w: 40, h: 40, comps: [] };
}

function generateDroneWarWorld(seed) {
  const t0 = performance.now();
  const rng = new Rng((seed ^ 0xd7a3) >>> 0);
  const W = DW_W, H = DW_H;
  const world = newWorld(seed, W, H, 9);
  world.layout = 'dronewar';
  world.infra = [];
  const mask = world.mask;
  const J = (x, y, jx, jy) => [x + rng.float(-jx, jx), y + rng.float(-jy, jy)];
  const sides = {
    // стороны не зеркальны: у каждой своё расположение городов (а значит, и объектов при них)
    blue: { dir: -1, rear: 0, cities: [{ c: [W * rng.float(0.1, 0.16), H * rng.float(0.36, 0.64)], sc: 1 }, { c: [W * rng.float(0.26, 0.34), H * rng.float(0.17, 0.32)], sc: 0.62 }, { c: [W * rng.float(0.24, 0.34), H * rng.float(0.68, 0.84)], sc: 0.62 }] },
    red: { dir: 1, rear: W, cities: [{ c: [W * rng.float(0.84, 0.9), H * rng.float(0.36, 0.64)], sc: 1 }, { c: [W * rng.float(0.66, 0.74), H * rng.float(0.17, 0.32)], sc: 0.62 }, { c: [W * rng.float(0.66, 0.76), H * rng.float(0.68, 0.84)], sc: 0.62 }] },
  };
  for (const [side, S] of Object.entries(sides))
    S.cities.forEach((ct, i) => {
      ct.name = DW_NAMES[side].cities[i];
      ct.side = side;
      world.settlements.push({ name: ct.name, x: ct.c[0], y: ct.c[1], type: 'city', side, capital: i === 0 });
    });

  // ---------- Реки: через столицы ----------
  for (const [side, S] of Object.entries(sides)) {
    const cap = S.cities[0].c;
    const xc = cap[0] - S.dir * 250 + rng.float(-100, 100);
    const ph = rng.float(0, 6.28);
    const pts = [];
    for (let y = -150; y <= H + 150; y += 80) {
      const x = xc + Math.sin(y / 900 + ph) * 380 + (fbm(y / 1600, 5.1, seed + (side === 'red' ? 17 : 3)) - 0.5) * 900 + (y - cap[1]) * 0.05 * S.dir;
      pts.push([x, y]);
    }
    S.river = resample(catmullRom(pts, 6), 14);
    S.riverW = side === 'blue' ? 48 : 44;
    addItem(world.water, { kind: 'river', line: S.river, width: S.riverW, name: DW_NAMES[side].river }, S.riverW + 200);
    mask.stampLine(S.river, S.riverW + 8, M.WATER);
    addItem(world.areas, { kind: 'floodplain', line: S.river, width: 320 }, 160);
  }

  // ---------- Водохранилища ГЭС: выше по течению от столиц ----------
  for (const [side, S] of Object.entries(sides)) {
    const y0 = H * 0.07, y1 = H * 0.2;
    const seg = S.river.filter((p) => p[1] > y0 && p[1] < y1);
    const mid = seg[Math.floor(seg.length / 2)];
    const res = blob(mid[0], (y0 + y1) / 2, 520, (y1 - y0) / 2, 0, rng, 40, 0.22);
    addItem(world.water, { kind: 'pond', poly: res }, 12);
    mask.stampPoly(res, M.WATER);
    const damP = S.river.reduce((a, p) => (Math.abs(p[1] - y1 - 40) < Math.abs(a[1] - y1 - 40) ? p : a));
    addItem(world.areas, { kind: 'dam', line: [[damP[0] - 330, damP[1]], [damP[0] + 330, damP[1]]], width: 26 }, 12);
    S.dam = damP;
  }

  // ---------- Холмы и балки степи ----------
  for (let i = 0; i < 130; i++) {
    const x = rng.float(0, W), y = rng.float(0, H), r = rng.float(500, 2000);
    addItem(world.areas, { kind: 'hill', poly: blob(x, y, r, r * rng.float(0.45, 0.9), rng.float(0, 3.14), rng, 36, 0.25), x, y, r, h: rng.float(0.5, 1) }, 0);
  }

  // ---------- Дороги ----------
  const allC = [...sides.blue.cities, ...sides.red.cities];
  const hwY = H * 0.5 - H * 0.075;
  const hwCtrl = [];
  for (let i = 0; i <= 24; i++) {
    const x = -200 + (i / 24) * (W + 400);
    const bend = allC.reduce((a, ct) => a + Math.exp(-(((x - ct.c[0]) / 2200) ** 2)) * -160 * ct.sc, 0);
    hwCtrl.push([x, hwY + bend + rng.float(-150, 150)]);
  }
  const highway = resample(catmullRom(hwCtrl, 10), 12);
  addRoad(world, highway, 'highway');
  const hw2 = [];
  for (let i = 0; i <= 24; i++) hw2.push([-200 + (i / 24) * (W + 400), H * 0.5 + H * 0.1 + rng.float(-250, 250)]);
  const hwLocal = resample(catmullRom(hw2, 10), 12);
  addRoad(world, hwLocal, 'local');

  // Железные дороги: из тыла через столицу к городам
  for (const [side, S] of Object.entries(sides)) {
    const [cap, cN, cS] = S.cities.map((ct) => ct.c);
    const edge = side === 'blue' ? -200 : W + 200;
    const main = resample(catmullRom([[edge, cap[1] + 450], [cap[0] + S.dir * 1500, cap[1] + 380], [cap[0], cap[1] + 280], [(cap[0] + cN[0]) / 2, (cap[1] + cN[1]) / 2 + 200], [cN[0], cN[1] + 230], [cN[0] - S.dir * 2500, cN[1] + 400]], 12), 10);
    const branch = resample(catmullRom([[cap[0] - S.dir * 300, cap[1] + 300], [(cap[0] + cS[0]) / 2, (cap[1] + cS[1]) / 2 + 150], [cS[0], cS[1] - 200], [cS[0] - S.dir * 2000, cS[1] - 350]], 12), 10);
    for (const r of [main, branch]) { addItem(world.rails, { kind: 'rail', line: r, width: 10 }, 20); mask.stampLine(r, 16, M.RAIL); }
    S.rail = main; S.branch = branch;
  }

  // ---------- Сёла ----------
  const spots = [];
  for (const [side, S] of Object.entries(sides)) {
    for (const [fx, fy] of [[0.04, 0.12], [0.05, 0.88], [0.1, 0.25], [0.09, 0.75], [0.2, 0.38], [0.21, 0.62], [0.19, 0.1], [0.2, 0.9], [0.4, 0.45], [0.42, 0.15], [0.41, 0.86], [0.26, 0.5], [0.36, 0.62], [0.35, 0.36], [0.03, 0.5], [0.14, 0.05], [0.14, 0.95], [0.27, 0.07], [0.27, 0.93], [0.33, 0.2], [0.33, 0.8], [0.45, 0.3], [0.45, 0.7], [0.24, 0.33], [0.24, 0.67]]) {
      const x = side === 'blue' ? fx * W : W - fx * W;
      spots.push([x + rng.float(-500, 500), fy * H + rng.float(-400, 400)]);
    }
    void S;
  }
  const villages = [];
  spots.forEach((c, i) => {
    if (c[0] < 400 || c[1] < 400 || c[0] > W - 400 || c[1] > H - 400) return;
    if (mask.near(c[0], c[1], 350, M.WATER)) return;
    if (allC.some((ct) => Math.hypot(ct.c[0] - c[0], ct.c[1] - c[1]) < 1900 * ct.sc)) return;
    const angle = rng.float(0, Math.PI);
    const len = rng.float(700, 1200);
    const dir = [Math.cos(angle), Math.sin(angle)];
    const ctrl = [];
    for (let k = -2; k <= 2; k++) { const t = (k / 2) * (len / 2); ctrl.push([c[0] + dir[0] * t + rng.float(-40, 40) * -dir[1], c[1] + dir[1] * t + rng.float(-40, 40) * dir[0]]); }
    const street = resample(catmullRom(ctrl, 8), 8);
    addVillageGround(world, street);
    const side = c[0] < W / 2 ? 'blue' : 'red';
    const pool = DW_VILLAGES[side];
    const used = new Set(world.settlements.map((q) => q.name));
    let name = pool[(i * 7 + seed) % pool.length];
    for (let k = 0; used.has(name) && k < pool.length; k++) name = pool[(i * 7 + seed + k + 1) % pool.length];
    world.settlements.push({ name, x: c[0], y: c[1], type: 'village', side });
    villages.push({ c, street, angle, name, side });
  });

  const growth = new Map(allC.map((ct) => [ct, []]));
  // довоенные дороги между северными и южными городами сторон: сходятся в одной точке на границе
  // (сейчас там КПП на линии фронта), а не заходят друг за друга «иксом»
  const cross = [1, 2].map((i) => [W / 2 + rng.float(-300, 300), (sides.blue.cities[i].c[1] + sides.red.cities[i].c[1]) / 2 + rng.float(-300, 300)]);
  for (const S of Object.values(sides)) {
    const [cap, cN, cS] = S.cities;
    growth.get(cN).push(wobblyRoad(rng, cN.c, cap.c.slice(), 5));
    growth.get(cS).push(wobblyRoad(rng, cS.c, cap.c.slice(), 5));
    growth.get(cN).push(wobblyRoad(rng, cN.c, cross[0].slice(), 4));
    growth.get(cS).push(wobblyRoad(rng, cS.c, cross[1].slice(), 4));
  }
  // Дороги из сёл: близко к городу — в город, иначе — к ближайшей точке уже проложенной сети
  // (трасса, дороги между городами, дороги соседних сёл): получается дерево с примыканиями «Т»,
  // а не пучок прямых, пересекающихся в чистом поле
  // сеть — только настоящие дороги: линии роста городов из их центров — не дороги (connectToCity их обрезает)
  // (дороги между городами — тоже сеть: их загородные участки остаются, городские заменяют улицы)
  const net = [];
  // сетка отрезков сети (ячейка 250 м): поиск пересечений и соседства — без перебора всех дорог
  const NC = 250, netCells = new Map();
  const netAdd = (o) => {
    net.push(o);
    for (let j = 1; j < o.length; j++) {
      const c = o[j - 1], d = o[j];
      for (let cx = Math.floor(Math.min(c[0], d[0]) / NC); cx <= Math.floor(Math.max(c[0], d[0]) / NC); cx++)
        for (let cy = Math.floor(Math.min(c[1], d[1]) / NC); cy <= Math.floor(Math.max(c[1], d[1]) / NC); cy++) {
          const k = cx * 65536 + cy;
          let a = netCells.get(k); if (!a) netCells.set(k, (a = []));
          a.push(o, j);
        }
    }
  };
  // вызывает fn(линия, j) для отрезков сети рядом с рамкой (отрезок может прийти несколько раз)
  const netNear = (x0, y0, x1, y1, fn) => {
    for (let cx = Math.floor(x0 / NC); cx <= Math.floor(x1 / NC); cx++)
      for (let cy = Math.floor(y0 / NC); cy <= Math.floor(y1 / NC); cy++) {
        const a = netCells.get(cx * 65536 + cy);
        if (a) for (let i = 0; i < a.length; i += 2) fn(a[i], a[i + 1]);
      }
  };
  for (const o of [highway, hwLocal, ...[...growth.values()].flat()]) netAdd(o);
  // Выезд из села: если цель лежит вдоль улицы — дорога продолжает улицу с её конца (а не идёт
  // рядом с ней под острым углом), иначе отходит от середины улицы поперёк
  const exitOf = (v, tgt) => {
    const dx = tgt[0] - v.c[0], dy = tgt[1] - v.c[1], L = Math.hypot(dx, dy) || 1;
    const dot = (dx * Math.cos(v.angle) + dy * Math.sin(v.angle)) / L;
    if (Math.abs(dot) > 0.64) return (dot > 0 ? v.street[v.street.length - 1] : v.street[0]).slice();
    return v.c.slice();
  };
  // Дорога обрывается на первой встреченной дороге сети (Т-примыкание, а не пересечение «иксом»);
  // если примыкание выходит под острым углом, последний участок доворачиваем поперёк
  const joinNet = (ln, skip = 60) => {
    let acc = 0;
    for (let k = 1; k < ln.length; k++) {
      acc += Math.hypot(ln[k][0] - ln[k - 1][0], ln[k][1] - ln[k - 1][1]);
      if (acc < skip) continue;
      let hit = null, hb = 2;
      const a = ln[k - 1], b = ln[k];
      netNear(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), (o, j) => {
        if (o === ln) return;
        const t = segCross(a, b, o[j - 1], o[j]);
        if (t >= 0 && t < hb) { hb = t; hit = { o, j }; }
      });
      if (!hit) {
        // подошла вплотную к другой дороге (ближе 55 м), не пересекая: примыкаем к ней сразу,
        // а не тянем рядом параллельно
        if (k + 3 >= ln.length) continue;
        const p = ln[k];
        let F = null, fd = 55;
        netNear(p[0] - 55, p[1] - 55, p[0] + 55, p[1] + 55, (o, j) => {
          if (o === ln) return;
          const f = footOn(p, o[j - 1], o[j]), d = Math.hypot(f[0] - p[0], f[1] - p[1]);
          if (d < fd) { fd = d; F = f; }
        });
        if (F) return [...ln.slice(0, k + 1), F];
        continue;
      }
      const P = [a[0] + (b[0] - a[0]) * hb, a[1] + (b[1] - a[1]) * hb];
      let out = [...ln.slice(0, k), P];
      const o = hit.o, c = o[hit.j - 1], d = o[hit.j];
      const ta = [b[0] - a[0], b[1] - a[1]], tb = [d[0] - c[0], d[1] - c[1]];
      const cos = Math.abs(ta[0] * tb[0] + ta[1] * tb[1]) / (Math.hypot(...ta) * Math.hypot(...tb) || 1);
      if (cos > 0.77) {
        // острый угол (< 40°): от точки в ~150 м до примыкания — к ближайшей точке дороги-хозяина
        let back = 0, q = out.length - 1;
        while (q > 1 && back < 150) { back += Math.hypot(out[q][0] - out[q - 1][0], out[q][1] - out[q - 1][1]); q--; }
        const Q = out[q];
        let F = P, fd = Infinity;
        for (let j = 1; j < o.length; j++) { const f = footOn(Q, o[j - 1], o[j]); const dd = Math.hypot(f[0] - Q[0], f[1] - Q[1]); if (dd < fd) { fd = dd; F = f; } }
        if (fd > 20) {
          // плавный доворот: сплайн через точку до поворота, точку поворота и середину перемычки
          const q0 = Math.max(0, q - 4), M0 = [(Q[0] + F[0]) / 2, (Q[1] + F[1]) / 2];
          out = [...out.slice(0, q0), ...resample(catmullRom([out[q0], Q, M0, F], 8), 10)];
        }
      }
      return out;
    }
    return ln;
  };
  const order = villages.map((v) => { let bd = Infinity, best = null; for (const ct of allC) { const d = Math.hypot(ct.c[0] - v.c[0], ct.c[1] - v.c[1]); if (d < bd) { bd = d; best = ct; } } return { v, bd, best }; }).sort((a, b) => a.bd - b.bd);
  const touchesNet = (line) => {
    for (let k = 1; k < line.length; k++) {
      const a = line[k - 1], b = line[k];
      let hit = false;
      netNear(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), (o, j) => { if (!hit && segCross(a, b, o[j - 1], o[j]) >= 0) hit = true; });
      if (hit) return true;
    }
    return false;
  };
  for (const { v, bd, best } of order) {
    if (touchesNet(v.street)) continue; // улица села и так пересекает дорогу сети — отдельный выезд не нужен
    if (bd < 3500) { const ln = joinNet(wobblyRoad(rng, exitOf(v, best.c), best.c.slice(), 4)); growth.get(best).push(ln); netAdd(ln); continue; }
    let tp = null, td = Infinity;
    // точки внутри городов не годятся: въезды в город потом обрезаются по краю застройки
    const nearCity = (p) => allC.some((ct) => Math.hypot(ct.c[0] - p[0], ct.c[1] - p[1]) < 2600 * (ct.sc || 1));
    // без переправ: мост через реку у сельской дороги может не встать — такая дорога оборвёт сеть
    const dry = (p) => { const L = Math.hypot(p[0] - v.c[0], p[1] - v.c[1]); for (let t = 0; t < L; t += 15) if (mask.has(v.c[0] + ((p[0] - v.c[0]) * t) / L, v.c[1] + ((p[1] - v.c[1]) * t) / L, M.WATER | M.RAIL)) return false; return true; };
    const cands = [];
    for (const ln of net) for (let k = 0; k < ln.length; k += 2) { const p = ln[k]; if (!nearCity(p)) cands.push([Math.hypot(p[0] - v.c[0], p[1] - v.c[1]), p]); }
    cands.sort((a, b) => a[0] - b[0]);
    for (const [d, p] of cands.slice(0, 200)) if (dry(p)) { td = d; tp = p; break; }
    if (!tp || (bd < 6000 && td > bd * 0.8)) { const ln = joinNet(wobblyRoad(rng, exitOf(v, best.c), best.c.slice(), 4)); growth.get(best).push(ln); netAdd(ln); continue; }
    const ln = joinNet(wobblyRoad(rng, exitOf(v, tp), tp.slice(), td > 2500 ? 4 : 2));
    addRoad(world, ln, 'local'); netAdd(ln);
  }
  for (const v of villages) addRoad(world, v.street, 'village');

  // Городские мосты столиц — теперь это продолжения проспектов городской сетки (см. buildCityDW)
  for (const S of []) {
    const cap = S.cities[0].c;
    for (const dy of [-380, 420]) {
      const y = cap[1] + dy;
      const rp = S.river.reduce((a, p) => (Math.abs(p[1] - y) < Math.abs(a[1] - y) ? p : a));
      const ln = resample([[rp[0] - 700, y + rng.float(-30, 30)], [rp[0], y], [rp[0] + 700, y + rng.float(-30, 30)]], 8);
      addRoad(world, ln, 'avenue');
      mask.stampLine(ln, 22, M.CITY);
      growth.get(S.cities[0]).push(ln);
    }
  }

  // ---------- Города ----------
  for (const [side, S] of Object.entries(sides)) {
    setBuildStyle(side);
    S.cities.forEach((ct, i) => buildCityDW(world, rng, ct.c, i === 2 ? S.branch : S.rail, S.river, growth.get(ct), ct.sc));
  }
  setBuildStyle(null);
  for (const lines of growth.values()) for (const line of lines) connectToCity(world, line);
  for (const v of villages) { setBuildStyle(v.side); buildVillageStreet(world, rng, v.street, 0.9); if (rng.chance(0.5)) buildFarm(world, rng, v); }
  setBuildStyle(null);

  trimStubs(world); // дороги не торчат «хвостами» за перекрёсток
  for (const S of Object.values(sides)) buildRingRoad(world, rng, S.cities[0].c, 1650 * 1.38);
  buildStreams(world, rng, sides);

  // ---------- Объекты инфраструктуры ----------
  const FORBID = M.WATER | M.BUILD | M.ROAD | M.RAIL | M.CITY | M.SETTLE | M.BALKA | M.VILLAGE | M.CITYZONE;
  let nextId = 1;
  // Площадка объекта с прилегающей территорией (выкошенная полоса, подъезд, забор): не в посадке,
  // не на дороге и не впритык к другим объектам
  const place = (side, kind, name, x, y, opts = {}) => {
    const lay = infraLayout(kind, opts.L);
    const R = opts.rng || rng;
    const angle = opts.angle ?? R.float(-0.4, 0.4);
    const forbid = opts.forbid ?? FORBID;
    const pad = opts.pad ?? (lay.w >= 140 ? 45 : lay.w >= 60 ? 22 : 12);
    let at = null;
    for (let a = 0; a < 260 && !at; a++) {
      const r = a * (opts.step || 45), t = a * 2.4;
      const px = x + Math.cos(t) * r, py = y + Math.sin(t) * r;
      if (px < 250 || py < 250 || px > W - 250 || py > H - 250) continue;
      const poly = rectCorners(px, py, lay.w + pad * 2, lay.h + pad * 2, angle);
      if (mask.polyFree(poly, forbid, 10)) at = [px, py];
    }
    if (!at) at = [x, y];
    const o = { id: nextId++, side, kind, name, x: at[0], y: at[1], angle, w: lay.w, h: lay.h, comps: lay.comps, ...opts.extra };
    const poly = rectCorners(o.x, o.y, lay.w + 16, lay.h + 16, angle);
    const apron = rectCorners(o.x, o.y, lay.w + pad * 2, lay.h + pad * 2, angle);
    mask.stampPoly(apron, M.BUILD);
    const site = addItem(world.areas, { kind: 'dwsite', oid: o.id, side, poly, apron, site: kind, x: o.x, y: o.y, angle, w: lay.w + 16, h: lay.h + 16, pad, fp: lay.comps.map((c) => [c.u, c.v, c.w, c.h, c.k]) });
    // Подъездная дорога: от ворот (сторона, обращённая к дороге) к ближайшей дороге так, чтобы
    // не пройти сквозь чужие площадки, дома и воду; перебираем несколько точек примыкания
    const gates = [0, Math.PI / 2, Math.PI, -Math.PI / 2].map((q) => {
      const ext = (q === 0 || q === Math.PI ? lay.w / 2 : lay.h / 2) + 8;
      return { q, p: [at[0] + Math.cos(angle + q) * ext, at[1] + Math.sin(angle + q) * ext] };
    });
    const cands = [];
    for (const r of world.roadList) {
      if (r.type === 'dirt') continue;
      for (let i = 0; i < r.line.length; i += 3) {
        const d = Math.hypot(r.line[i][0] - at[0], r.line[i][1] - at[1]);
        if (d < 5000) cands.push({ p: r.line[i], d, r });
      }
    }
    cands.sort((a, b) => a.d - b.d);
    const clear = (line) => line.every(([x, y], k) => (k < 1 || !pointInPoly(x, y, poly)) && (k < 3 || !mask.has(x, y, M.BUILD | M.WATER) || pointInPoly(x, y, apron)));
    let done = false;
    for (const c of cands.slice(0, 60)) {
      const g = gates.slice().sort((a, b) => Math.hypot(c.p[0] - a.p[0], c.p[1] - a.p[1]) - Math.hypot(c.p[0] - b.p[0], c.p[1] - b.p[1]))[0];
      const L = Math.hypot(c.p[0] - g.p[0], c.p[1] - g.p[1]);
      if (L < 12) { o.gate = g.p; o.gateQ = g.q; done = true; break; }
      const line = cutAtRoad(world, L < 200 ? resample([g.p, c.p], 8) : wobblyRoad(R, g.p, c.p, 3), apron);
      if (!clear(line)) continue;
      addRoad(world, line, opts.paved ? 'local' : 'dirt');
      o.gate = g.p; o.gateQ = g.q; done = true;
      break;
    }
    if (!done) {
      // запасной вариант: прямой отрезок от любых ворот к любой точке, лишь бы не сквозь площадки
      outer: for (const c of cands.slice(0, 200)) for (const g of gates) {
        const line = cutAtRoad(world, resample([g.p, c.p], 8), apron);
        if (clear(line)) { addRoad(world, line, opts.paved ? 'local' : 'dirt'); o.gate = g.p; o.gateQ = g.q; done = true; break outer; }
      }
      if (!done) { o.gate = gates[1].p; o.gateQ = gates[1].q; }
    }
    site.gateQ = o.gateQ;
    world.infra.push(o);
    return o;
  };
  const lines = [];
  const portal = (o, kv, toward) => portalOf(o, kv, toward).pt;
  const line = (a, b, kv) => {
    const ca = [a.x, a.y], cb = [b.x ?? b[0], b.y ?? b[1]];
    const pa = portal(a, kv, cb), pb = b.comps ? portal(b, kv, ca) : cb;
    const n = 8, pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const off = Math.sin(t * Math.PI) * rng.float(-220, 220);
      const dx = pb[0] - pa[0], dy = pb[1] - pa[1], L = Math.hypot(dx, dy) || 1;
      pts.push([pa[0] + dx * t - (dy / L) * off, pa[1] + dy * t + (dx / L) * off]);
    }
    let pyl = resample(catmullRom(pts, 6), kv >= 330 ? 350 : 250).map(([x, y]) => ({ x, y }));
    // опоры не ставим на площадках объектов и в воде (кроме порталов на концах)
    pyl = pyl.filter((p, i) => i === 0 || i === pyl.length - 1 || !mask.has(p.x, p.y, M.BUILD | M.WATER | M.ROAD));
    // провода заходят на шины ОРУ (а не обрываются у ограды): концевая опора напротив портала
    if (a.comps) pyl = terminatePylons(pyl, a, portalOf(a, kv, cb), false, mask);
    if (b.comps) pyl = terminatePylons(pyl, b, portalOf(b, kv, ca), true, mask);
    pyl[0].portal = true; pyl[pyl.length - 1].portal = !!b.comps;
    if (a.comps) pyl[0].ph = portalOf(a, kv, cb).h;
    if (b.comps) pyl[pyl.length - 1].ph = portalOf(b, kv, ca).h;
    lines.push({ id: lines.length + 1, kv, a: a.id ?? null, b: b.id ?? null, pylons: pyl, side: a.side });
  };
  for (const [side, S] of Object.entries(sides)) {
    const [cap, cN, cS] = S.cities.map((ct) => ct.c);
    const rearX = S.rear;
    const nm = DW_NAMES[side].cities;
    const tppNorth = rng.chance(0.5); // ТЭС то на севере, то на юге тыла — у каждой стороны по-своему
    const tpp = place(side, 'tpp', DW_NAMES[side].tpp, cap[0] + (rearX - cap[0]) * rng.float(0.35, 0.7), H * (tppNorth ? rng.float(0.12, 0.3) : rng.float(0.7, 0.88)), { angle: rng.float(-0.5, 0.5), paved: true });
    const aA = rng.float(0, Math.PI * 2);
    const psA = place(side, 'ps330', `ПС 330 кВ «${nm[0]}»`, cap[0] - S.dir * 1800 + Math.cos(aA) * 900, cap[1] + Math.sin(aA) * 1600);
    const psB = place(side, 'ps330', 'ПС 330 кВ «Центральная»', (cap[0] + cN[0] + cS[0]) / 3 + S.dir * rng.float(-400, 1400), H * rng.float(0.35, 0.65));
    const cp1 = place(side, 'ps110', `ПС 110 кВ «${nm[0]}-Северная»`, cap[0] + rng.float(-300, 300), cap[1] - 1100);
    const cp2 = place(side, 'ps110', `ПС 110 кВ «${nm[0]}-Южная»`, cap[0] + rng.float(-300, 300), cap[1] + 1150);
    const pN = place(side, 'ps110', `ПС 110 кВ «${nm[1]}»`, cN[0] + S.dir * 900, cN[1] - 300);
    const pS = place(side, 'ps110', `ПС 110 кВ «${nm[2]}»`, cS[0] + S.dir * 900, cS[1] + 300);
    cp1.city = 0; cp2.city = 0; pN.city = 1; pS.city = 2;
    // Объекты разнесены по территории, а не собраны у столицы: нефтебаза — у ж/д ветки на юге,
    // завод — в промзоне северного города, распредцентр — на трассе между городами,
    // ремонтная база — у центральной подстанции, арсенал — в глубоком тылу
    const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const oilAt = S.branch[Math.floor(S.branch.length * rng.float(0.55, 0.75))];
    place(side, 'oil', `Нефтебаза «${nm[2]}»`, oilAt[0] + rng.float(-300, 300), oilAt[1] + (rng.chance(0.5) ? 450 : -450));
    place(side, 'ammo', 'Арсенал', cap[0] + (rearX - cap[0]) * rng.float(0.3, 0.8), H * (tppNorth ? rng.float(0.65, 0.88) : rng.float(0.12, 0.35)));
    { const fc = rng.chance(0.5) ? cN : cS, fa = rng.float(0, Math.PI * 2); place(side, 'factory', `Завод БПЛА «${side === 'blue' ? 'Сокол' : 'Беркут'}»`, fc[0] + S.dir * 1200 + Math.cos(fa) * 700, fc[1] + Math.sin(fa) * 1100); }
    place(side, 'launch', 'Стартовая позиция «Север»', W / 2 + S.dir * W * rng.float(0.14, 0.3), H * rng.float(0.08, 0.3));
    place(side, 'launch', 'Стартовая позиция «Юг»', W / 2 + S.dir * W * rng.float(0.14, 0.3), H * rng.float(0.7, 0.92));
    // Логистика: погранпереход на трассе у тылового края
    const hwp = highway.reduce((a, p) => (Math.abs(p[0] - (rearX - S.dir * 700)) < Math.abs(a[0] - (rearX - S.dir * 700)) ? p : a));
    place(side, 'border', side === 'blue' ? 'Погранпереход «Запад»' : 'Погранпереход «Восток»', hwp[0], hwp[1] + 150, { angle: 0, paved: true });
    const hubX = lerp2(cap, cN, 0.45);
    const hubP = nearestPoint(highway, hubX);
    place(side, 'hub', `Распределительный центр «${nm[0]}»`, hubP[0], hubP[1] + (hubP[1] > hubX[1] ? -200 : 200), { paved: true, angle: rng.float(-0.15, 0.15) });
    place(side, 'rembase', 'Ремонтная база энергетиков (центральная)', psB.x + S.dir * 700, psB.y + rng.float(-500, 500), { paved: true });
    // Районные электросети (РЭС) у каждого города — свои бригады ближе к объектам
    S.cities.forEach((ct, i) => place(side, 'rembase', `РЭС «${ct.name}»`, ct.c[0] + S.dir * (i ? 900 : 1500) * ct.sc, ct.c[1] + (i === 1 ? 700 : i === 2 ? -700 : 900), { paved: true, extra: { small: true } }));
    const cityForbid = M.WATER | M.BUILD | M.ROAD | M.RAIL | M.CITY;
    S.cities.forEach((ct, i) => {
      place(side, 'firest', `Пожарная часть «${ct.name}»`, ct.c[0] + S.dir * (i ? 600 : 1000), ct.c[1] + (i ? 500 : 400), { forbid: cityForbid, step: 30, paved: true, extra: { city: i } });
      const nMall = i === 0 ? 2 : 1;
      for (let k = 0; k < nMall; k++) {
        const a = rng.float(0, Math.PI * 2);
        place(side, i === 0 ? 'mall' : 'market', i === 0 ? `ТЦ «${['Галерея', 'Меридиан', 'Центральный'][k]}», ${ct.name}` : `Супермаркет, ${ct.name}`, ct.c[0] + Math.cos(a) * 900 * ct.sc, ct.c[1] + Math.sin(a) * 700 * ct.sc,
          { forbid: cityForbid, step: 30, paved: true, extra: { city: i, settlement: ct.name } });
      }
      // АЗС на въезде в город
      const a = rng.float(0, Math.PI * 2);
      place(side, 'fuel', `АЗС «${side === 'blue' ? 'Велойл' : 'Кардойл'}», ${ct.name}`, ct.c[0] + Math.cos(a) * 1100 * ct.sc, ct.c[1] + Math.sin(a) * 900 * ct.sc,
        { forbid: cityForbid, step: 20, paved: true, extra: { city: i, settlement: ct.name } });
    });
    // магазин — на свободном месте у улицы, не на огородах дворов
    for (const v of villages) if (v.side === side) place(side, 'store', `Магазин, ${v.name}`, v.c[0], v.c[1], { forbid: cityForbid | M.SETTLE, step: 12, extra: { settlement: v.name, village: true } });
    // АЗС вдоль трасс
    let nFuel = 1;
    for (const [road, fr] of [[highway, 0.1], [highway, 0.24], [highway, 0.38], [hwLocal, 0.16], [hwLocal, 0.33]]) {
      const tx = side === 'blue' ? fr * W : W - fr * W;
      const p = road.reduce((a, q) => (Math.abs(q[0] - tx) < Math.abs(a[0] - tx) ? q : a));
      place(side, 'fuel', `АЗС «${side === 'blue' ? 'Велойл' : 'Кардойл'}» №${nFuel++} (трасса)`, p[0], p[1] + (rng.chance(0.5) ? 50 : -50), { step: 15, paved: true, angle: rng.float(-0.1, 0.1) });
    }
    // Прочая генерация: ГЭС у плотины, ТЭЦ в столице, ветровая и солнечная станции
    const hpp = place(side, 'hpp', side === 'blue' ? 'Верхнеарденская ГЭС' : 'Верхнекардинская ГЭС', S.dam[0] - S.dir * (S.riverW / 2 + 140), S.dam[1] + 90, { angle: 0, paved: true, step: 20, pad: 14 });
    const chp = place(side, 'chp', `ТЭЦ «${nm[0]}»`, cap[0] + rng.float(-500, 500), cap[1] + 1700, { paved: true, forbid: cityForbid, step: 40 });
    const wpp = place(side, 'wpp', `Ветровая электростанция «${side === 'blue' ? 'Вельский кряж' : 'Кардагорская степь'}»`, (cap[0] + W / 2) / 2 + rng.float(-800, 800), H * 0.36 + rng.float(-800, 800), { angle: rng.float(-0.3, 0.3), pad: 30 });
    const spp = place(side, 'spp', `Солнечная электростанция «${side === 'blue' ? 'Светлый Луг' : 'Суховей'}»`, (cap[0] + cS[0]) / 2 + rng.float(-600, 600), H * 0.66 + rng.float(-600, 600), { angle: rng.float(-0.2, 0.2) });
    // Элеватор у города с железной дорогой: сюда свозят зерно с полей, отсюда — экспорт
    { const er = new Rng((seed ^ 0xe1e7 ^ (side === 'blue' ? 1 : 2)) >>> 0); const ct = S.cities[2] || S.cities[1]; place(side, 'elevator', `Элеватор «${ct.name}»`, ct.c[0] + S.dir * 1300 * ct.sc, ct.c[1] + er.float(-500, 500), { paved: true, rng: er, angle: er.float(-0.3, 0.3) }); }
    chp.city = 0;
    // ЛЭП
    line(tpp, psA, 330); line(tpp, psB, 330); line(psA, psB, 330); line(hpp, psA, 330);
    line(chp, cp2, 110); line(chp, cp1, 110); line(wpp, psB, 110); line(spp, pS, 110);
    const imp = { x: rearX + S.dir * 60, y: psA.y + rng.float(-1200, 1200), id: 'import', side };
    line(imp, psA, 330);
    line(psA, cp1, 110); line(psA, cp2, 110); line(psB, cp2, 110); line(psB, pN, 110); line(psB, pS, 110);
    world.infra.push({ id: 'import:' + side, side, kind: 'import', name: 'Межсистемная связь (импорт)', x: imp.x, y: imp.y, angle: 0, w: 0, h: 0, comps: [] });
  }
  world.power = { lines };

  snapRoadEnds(world);
  connectRoadNet(world, rng);
  fixCrossings(world);
  placeBusStops(world);
  // ---------- Мосты: где дороги и ж/д пересекают реки ----------
  const bridges = [];
  const scan = (ln, type) => {
    let run = null;
    for (let i = 0; i < ln.length; i++) {
      const wet = mask.has(ln[i][0], ln[i][1], M.WATER);
      if (wet && !run) run = { i0: i };
      if (!wet && run) {
        const a = ln[Math.max(0, run.i0 - 1)], b = ln[i];
        const x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2;
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]) + 24;
        // через ручей — водопропускная труба под насыпью, не мост-объект
        if (world.water.query({ x0: x - 20, y0: y - 20, x1: x + 20, y1: y + 20 }).some((w) => w.stream && distToLine(x, y, w.line) < 20)) { run = null; continue; }
        if (L < 260 && !bridges.some((q) => Math.hypot(q.x - x, q.y - y) < 80)) bridges.push({ x, y, L, angle: Math.atan2(b[1] - a[1], b[0] - a[0]), type });
        run = null;
      }
    }
  };
  for (const r of world.roadList) if (['highway', 'local', 'avenue', 'village', 'dirt'].includes(r.type)) scan(resample(r.line, 6), r.type);
  for (const r of world.rails.items) scan(resample(r.line, 6), 'rail');
  const TYPE_NAME = { highway: 'автомобильный мост (трасса)', rail: 'железнодорожный мост', avenue: 'городской мост', local: 'мост', village: 'сельский мост', dirt: 'мост' };
  for (const b of bridges) {
    const side = b.x < W / 2 ? 'blue' : 'red';
    const lay = infraLayout('bridge', b.L);
    world.infra.push({ id: nextId++, side, kind: 'bridge', btype: b.type, name: `Мост через р. ${DW_NAMES[side].river} — ${TYPE_NAME[b.type]}`, x: b.x, y: b.y, angle: b.angle, w: lay.w, h: lay.h, comps: lay.comps, L: b.L });
  }

  // ---------- Поля: массивы вокруг жилья (свой разворот, поля разной длины вразбежку) + пятна степи ----------
  const massifs = [
    ...allC.map((ct) => ({ x: ct.c[0], y: ct.c[1], r: 4600 * ct.sc })),
    ...allC.flatMap((ct) => [0, 1].map(() => { const a = rng.float(0, 6.28); return { x: ct.c[0] + Math.cos(a) * 3600 * ct.sc, y: ct.c[1] + Math.sin(a) * 3600 * ct.sc, r: 2200 * ct.sc }; })),
    ...villages.map((v) => ({ x: v.c[0], y: v.c[1], r: rng.float(1500, 2500) })),
  ];
  // Вся остальная земля — тоже пашня (как на юге в реальности): массивы агрофирм сплошным покрытием;
  // редкие пропуски — выпасы и залежь
  for (let y = 1200; y < H; y += 2700) for (let x = 1200; x < W; x += 2900) {
    if (rng.chance(0.08)) continue;
    massifs.push({ x: x + rng.float(-600, 600), y: y + rng.float(-600, 600), r: rng.float(2000, 2600) });
  }
  roadsideBelts(world, rng, highway);
  buildFieldsDW(world, rng, massifs);
  // Редкие рощи и одиночные деревья в степи
  for (let i = 0; i < 480; i++) {
    const x = rng.float(0, W), y = rng.float(0, H);
    if (mask.has(x, y, M.ROAD | M.BUILD | M.WATER | M.CITY | M.RAIL)) continue;
    const n = rng.int(3, 25), R = rng.float(15, 60);
    for (let k = 0; k < n; k++) world.trees.add(x + rng.gauss(0, R), y + rng.gauss(0, R), rng.float(2, 5), rng.int(0, 3));
  }
  for (const S of Object.values(sides))
    for (let i = 0; i < S.river.length; i++) {
      const tg = tangents([S.river[Math.max(0, i - 1)], S.river[Math.min(S.river.length - 1, i + 1)]])[0];
      for (const sd of [-1, 1]) {
        if (!rng.chance(0.45)) continue;
        const off = S.riverW / 2 + rng.float(3, 16);
        const x = S.river[i][0] - tg[1] * off * sd, y = S.river[i][1] + tg[0] * off * sd;
        if (mask.has(x, y, M.ROAD | M.BUILD | M.RAIL | M.WATER)) continue;
        world.trees.add(x, y, rng.float(3, 6), rng.int(0, 3));
      }
    }
  // Деревья садов, попавшие на площадку объекта, убираем (радиус 0 — не рисуется)
  for (const o of world.infra) {
    if (o.kind === 'bridge' || o.kind === 'import') continue;
    const poly = rectCorners(o.x, o.y, o.w + 16, o.h + 16, o.angle);
    world.trees.forEach(bboxOf(poly, 4), (arr, i) => { if (pointInPoly(arr[i], arr[i + 1], poly)) arr[i + 2] = 0; });
  }
  const frontX = seedWarScars(world, rng, W * 0.5 + rng.float(-200, 200));
  world.frontX = frontX;
  buildFrontDW(world, new Rng((seed ^ 0xf207) >>> 0), frontX);
  world.mapFix = checkWorld(world, true); // починка: дома на дорогах и внахлёст, поля поперёк дорог, деревья на асфальте
  finishBuildings(world, new Rng((seed ^ 0x1e7) >>> 0), false);
  buildPowerGridDW(world, new Rng((seed ^ 0x9092) >>> 0));
  // отпайки 10 кВ: каждый объект запитан от ближайшей ТП или подстанции — провода видно на карте
  world.power.feeds = [];
  for (const o of world.infra) if (FEED_KINDS.has(o.kind)) { const f = gridFeed(world, o); if (f) world.power.feeds.push(f); }
  refreshCanopy(world, { x0: 0, y0: 0, x1: W, y1: H });
  world.genTime = performance.now() - t0;
  return world;
}

// ================================================================
// Вспомогательные
// ================================================================

function addItem(index, item, pad = 0) {
  item.bbox = bboxOf(item.poly || item.line || item.pts, pad);
  index.insert(item);
  return item;
}

export const ROAD_STYLE = {
  highway: { width: 26, stamp: 34 },
  local: { width: 8, stamp: 14 },
  village: { width: 6.5, stamp: 11 },
  street: { width: 10, stamp: 14 },
  avenue: { width: 16, stamp: 20 },
  dirt: { width: 4.5, stamp: 8 },
  ramp: { width: 7, stamp: 11 }, // съезд развязки
};

// Подъезд обрывается на первой встреченной дороге (примыкание), а не пересекает её к дальней
function cutAtRoad(world, line, apron) {
  for (let k = 2; k < line.length - 1; k++) {
    const [x, y] = line[k];
    if (apron && pointInPoly(x, y, apron)) continue;
    if (world.mask.has(x, y, M.ROAD)) return line.slice(0, k + 1);
  }
  return line;
}
// Концы дорог, заехавшие за перекрёсток на 3–80 м, обрезаем по перекрёстку
function trimStubs(world) {
  const distToSeg = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)); return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]); };
  const segX = (a, b, c, d) => {
    const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]], den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-9) return -1;
    const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
  };
  const roads = world.roadList.filter((r) => r.type !== 'street' && r.line.length > 2);
  const bb = (l) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of l) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return { x0, y0, x1, y1 }; };
  const boxes = new Map(world.roadList.map((r) => [r, bb(r.line)]));
  let n = 0;
  for (const r of roads) {
    for (const end of [0, 1]) {
      const L = end ? r.line.slice().reverse() : r.line;
      // хвост: первые до 80 м от конца
      let acc = 0, k = 1;
      while (k < L.length && acc < 80) { acc += Math.hypot(L[k][0] - L[k - 1][0], L[k][1] - L[k - 1][1]); k++; }
      const tail = L.slice(0, k);
      const tb = bb(tail);
      let hit = null, attached = false;
      const near = world.roadList.filter((o) => { if (o === r) return false; const ob = boxes.get(o); return !(ob.x0 > tb.x1 + 15 || ob.x1 < tb.x0 - 15 || ob.y0 > tb.y1 + 15 || ob.y1 < tb.y0 - 15); });
      // конец лежит на другой дороге — это примыкание, а не хвост
      for (const o of near) for (let j = 1; j < o.line.length && !attached; j++) if (distToSeg(tail[0], o.line[j - 1], o.line[j]) < 12) attached = true;
      if (attached || !near.length) continue;
      for (let i = 1; i < tail.length; i++) {
        let bt = 2;
        for (const o of near) for (let j = 1; j < o.line.length; j++) { const t = segX(tail[i - 1], tail[i], o.line[j - 1], o.line[j]); if (t >= 0 && t < bt) bt = t; }
        if (bt > 1) continue;
        const px = tail[i - 1][0] + (tail[i][0] - tail[i - 1][0]) * bt, py = tail[i - 1][1] + (tail[i][1] - tail[i - 1][1]) * bt;
        const d = Math.hypot(px - tail[0][0], py - tail[0][1]);
        if (d > 3) hit = { i, p: [px, py] };
        break;
      }
      if (!hit) continue;
      const rest = [hit.p, ...L.slice(hit.i)];
      if (rest.length < 2) continue;
      r.line = end ? rest.reverse() : rest;
      n++;
    }
  }
  world.stubsTrimmed = n;
}
function addRoad(world, line, type) {
  const st = ROAD_STYLE[type];
  const road = addItem(world.roads, { kind: 'road', type, line, width: st.width }, st.width + 6);
  world.mask.stampLine(line, st.stamp, M.ROAD);
  world.roadList.push(road);
  return road;
}

// Выгон/пастбище вокруг сельских улиц — поля и посадки сюда не заходят
function addVillageGround(world, street) {
  addItem(world.areas, { kind: 'vground', line: street, width: 260 }, 160);
  world._vgroundLines = (world._vgroundLines || []).concat([street]);
  world.mask.stampLine(street, 280, M.VILLAGE);
}

// Дорога из села заканчивается у края застройки и примыкает к ближайшей улице
// (линия может и начинаться в городе — дорога между городами: тогда обрезаем оба конца)
function connectToCity(world, line) {
  const { mask } = world;
  const inC = line.map(([x, y]) => mask.has(x, y, M.CITY));
  if (!inC.some(Boolean)) { addRoad(world, line, 'local'); return; }
  const s = inC.indexOf(false);
  if (s < 0) return; // целиком в городе — её заменяют улицы
  let e = s;
  while (e + 1 < line.length && !inC[e + 1]) e++;
  const trimmed = line.slice(s, e + 1);
  if (trimmed.length < 2) return;
  const attach = (end) => {
    const cands = [];
    for (const r of world.roadList) {
      if (r.type !== 'street' && r.type !== 'avenue') continue;
      for (const p of r.line) if (Math.abs(p[0] - end[0]) < 260 && Math.abs(p[1] - end[1]) < 260) cands.push(p);
    }
    cands.sort((a, b) => Math.hypot(a[0] - end[0], a[1] - end[1]) - Math.hypot(b[0] - end[0], b[1] - end[1]));
    for (const c of cands.slice(0, 40)) {
      const L = Math.hypot(c[0] - end[0], c[1] - end[1]);
      if (L > 250) break;
      let ok = true;
      for (let t = 0; t <= L; t += 2) {
        const x = end[0] + ((c[0] - end[0]) * t) / L, y = end[1] + ((c[1] - end[1]) * t) / L;
        if (mask.has(x, y, M.BUILD | M.WATER)) { ok = false; break; }
      }
      if (ok) return c.slice();
    }
    return null;
  };
  if (e + 1 < line.length) { const c = attach(trimmed[trimmed.length - 1]); if (c) trimmed.push(c); }
  if (s > 0) { const c = attach(trimmed[0]); if (c) trimmed.unshift(c); }
  addRoad(world, resample(trimmed, 10), 'local');
}

// Параметр t (0..1) на отрезке ab точки пересечения с отрезком cd, или −1
function segCross(a, b, c, d) {
  const r0 = b[0] - a[0], r1 = b[1] - a[1], s0 = d[0] - c[0], s1 = d[1] - c[1], den = r0 * s1 - r1 * s0;
  if (Math.abs(den) < 1e-9) return -1;
  const t = ((c[0] - a[0]) * s1 - (c[1] - a[1]) * s0) / den, u = ((c[0] - a[0]) * r1 - (c[1] - a[1]) * r0) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}
function footOn(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  return [a[0] + dx * t, a[1] + dy * t];
}
const lineLen = (l) => { let s = 0; for (let i = 1; i < l.length; i++) s += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]); return s; };

// Концы дорог, не дотянутые до соседней дороги на несколько метров (или до 45 м по ходу), доводим
// до её оси — иначе на карте видна щель, а в графе логистики остров. Вырожденные куски убираем.
function snapRoadEnds(world) {
  const { mask } = world;
  const drop = new Set();
  for (const r of world.roadList) if (lineLen(r.line) < 2) drop.add(r);
  let n = 0;
  for (const r of world.roadList) {
    if (drop.has(r) || r.type === 'highway') continue;
    for (const end of [0, 1]) {
      const L = r.line, E = end ? L[L.length - 1] : L[0], Q = end ? L[Math.max(0, L.length - 4)] : L[Math.min(3, L.length - 1)];
      const dl = Math.hypot(E[0] - Q[0], E[1] - Q[1]) || 1, dir = [(E[0] - Q[0]) / dl, (E[1] - Q[1]) / dl];
      let best = null, bd = Infinity, touch = false;
      for (const o of world.roads.query({ x0: E[0] - 60, y0: E[1] - 60, x1: E[0] + 60, y1: E[1] + 60 })) {
        if (o === r || drop.has(o)) continue;
        const ol = o.line;
        for (let j = 1; j < ol.length && !touch; j++) {
          const f = footOn(E, ol[j - 1], ol[j]), d = Math.hypot(f[0] - E[0], f[1] - E[1]);
          if (d < Math.max(r.width, o.width) / 2 + 2) { touch = true; break; }
          // впереди по ходу (не дальше 45 м) или просто рядом (до 16 м)
          const ahead = (f[0] - E[0]) * dir[0] + (f[1] - E[1]) * dir[1];
          const ok = d < 16 || (ahead > d * 0.8 && d < 45);
          if (ok && d < bd) { bd = d; best = f; }
        }
        if (touch) break;
      }
      if (touch || !best) continue;
      let clear = true;
      for (let t = 2; t < bd; t += 2) { const x = E[0] + ((best[0] - E[0]) * t) / bd, y = E[1] + ((best[1] - E[1]) * t) / bd; if (mask.has(x, y, M.BUILD | M.WATER)) { clear = false; break; } }
      if (!clear) continue;
      if (end) L.push(best); else L.unshift(best);
      mask.stampLine([E, best], ROAD_STYLE[r.type]?.stamp || 8, M.ROAD);
      n++;
    }
  }
  // тупиковые огрызки: короткий кусок, один конец которого ни к чему не примыкает (и там не ворота)
  const gates = world.infra.filter((o) => o.gate).map((o) => o.gate);
  const free = (r, E) => {
    if (gates.some((g) => Math.hypot(g[0] - E[0], g[1] - E[1]) < 25)) return false;
    for (const o of world.roads.query({ x0: E[0] - 30, y0: E[1] - 30, x1: E[0] + 30, y1: E[1] + 30 }, false)) {
      if (o === r || drop.has(o)) continue;
      for (let j = 1; j < o.line.length; j++) { const f = footOn(E, o.line[j - 1], o.line[j]); if (Math.hypot(f[0] - E[0], f[1] - E[1]) < Math.max(r.width, o.width) / 2 + 3) return false; }
    }
    return true;
  };
  for (let pass = 0; pass < 2; pass++)
    for (const r of world.roadList) {
      if (drop.has(r) || r.type === 'highway' || lineLen(r.line) > 80) continue;
      const a = free(r, r.line[0]), b = free(r, r.line[r.line.length - 1]);
      if (a !== b) drop.add(r);
    }
  // индекс перестраиваем: рамки удлинённых дорог изменились
  world.roadList = world.roadList.filter((r) => !drop.has(r));
  const old = world.roads;
  world.roads = new SpatialIndex(world.W, world.H, old.cell);
  for (const r of old.items) if (!drop.has(r)) { r.bbox = bboxOf(r.line, r.width + 6); world.roads.insert(r); }
  world.roadsSnapped = n;
}

// ---------- Объездная столицы ----------
// Кольцо вокруг столицы за краем застройки: куски между сёлами, водой и застройкой; там, где кольцо
// встречает радиальную дорогу, — круговая развязка (world.roundabouts)
function buildRingRoad(world, rng, C, R) {
  const { mask } = world;
  world.roundabouts = world.roundabouts || [];
  const ph = rng.float(0, 6.28), pts = [];
  for (let k = 0; k < 96; k++) {
    const a = (k / 96) * Math.PI * 2, r = R * (1 + 0.07 * Math.sin(3 * a + ph) + 0.04 * Math.sin(5 * a + ph * 2));
    pts.push([C[0] + Math.cos(a) * r, C[1] + Math.sin(a) * r]);
  }
  const line = resample(catmullRom([...pts, pts[0], pts[1], pts[2]], 6), 10);
  const bad = (p) => p[0] < 300 || p[1] < 300 || p[0] > world.W - 300 || p[1] > world.H - 300 || mask.near(p[0], p[1], 14, M.CITY | M.BUILD | M.VILLAGE | M.SETTLE | M.RAIL);
  // ищем начало в «плохой» точке, чтобы куски не рвались на стыке замыкания
  let start = line.findIndex(bad);
  if (start < 0) start = 0;
  const ring = [...line.slice(start), ...line.slice(0, start)];
  const runs = [];
  let cur = [];
  for (const p of ring) { if (bad(p)) { if (cur.length) runs.push(cur); cur = []; } else cur.push(p); }
  if (cur.length) runs.push(cur);
  const made = [];
  for (const run of runs) {
    if (lineLen(run) < 700) continue;
    // широкая вода — не переходим (узкую перекроет мост)
    let wet = 0, ok = true;
    for (const p of run) { if (mask.has(p[0], p[1], M.WATER)) { wet += 10; if (wet > 200) { ok = false; break; } } else wet = 0; }
    if (!ok) continue;
    const r = addRoad(world, run, 'local');
    r.ring = true;
    made.push(r);
  }
  // круговые развязки: пересечения кольца с трассой и загородными дорогами
  for (const r of made)
    for (const o of world.roadList) {
      if (o === r || o.ring || (o.type !== 'highway' && o.type !== 'local')) continue;
      if (o.bbox.x0 > r.bbox.x1 || o.bbox.x1 < r.bbox.x0 || o.bbox.y0 > r.bbox.y1 || o.bbox.y1 < r.bbox.y0) continue;
      for (let i = 1; i < r.line.length; i++) for (let j = 1; j < o.line.length; j++) {
        const a = r.line[i - 1], b = r.line[i], c = o.line[j - 1], d = o.line[j];
        if (Math.max(c[0], d[0]) < Math.min(a[0], b[0]) || Math.min(c[0], d[0]) > Math.max(a[0], b[0]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1]) || Math.min(c[1], d[1]) > Math.max(a[1], b[1])) continue;
        const t = segCross(r.line[i - 1], r.line[i], o.line[j - 1], o.line[j]);
        if (t < 0) continue;
        const x = r.line[i - 1][0] + (r.line[i][0] - r.line[i - 1][0]) * t, y = r.line[i - 1][1] + (r.line[i][1] - r.line[i - 1][1]) * t;
        if (!world.roundabouts.some((q) => Math.hypot(q.x - x, q.y - y) < 80)) world.roundabouts.push({ x, y, r: o.type === 'highway' ? 26 : 18 });
      }
    }
  for (const q of world.roundabouts) mask.stampDisc(q.x, q.y, q.r + 6, M.ROAD);
}

// ---------- Ручьи ----------
// Несколько ручьёв в степи на каждой стороне: от истока в понижении — извилисто к реке. Дороги,
// которые их пересекают, получают малые мосты (общий поиск мостов по воде)
function buildStreams(world, rng, sides) {
  const { mask } = world;
  for (const S of Object.values(sides)) {
    for (let n = 0; n < 4; n++) {
      const src = [S.river[0][0] + S.dir * rng.float(2500, 9000) * (rng.chance(0.5) ? 1 : -1), rng.float(world.H * 0.1, world.H * 0.9)];
      // ближайшая точка реки — устье
      let mouth = S.river[0], md = Infinity;
      for (const p of S.river) { const d = Math.hypot(p[0] - src[0], p[1] - src[1]); if (d < md) { md = d; mouth = p; } }
      if (md < 1500 || md > 9000) continue;
      const ctrl = [];
      for (let k = 0; k <= 6; k++) {
        const t = k / 6, off = k && k < 6 ? rng.float(-0.12, 0.12) * md : 0;
        const nx = -(mouth[1] - src[1]) / md, ny = (mouth[0] - src[0]) / md;
        ctrl.push([src[0] + (mouth[0] - src[0]) * t + nx * off, src[1] + (mouth[1] - src[1]) * t + ny * off]);
      }
      let line = resample(catmullRom(ctrl, 8), 12);
      // исток — ниже последнего препятствия (город, село, объект, ж/д): ручей не течёт сквозь застройку
      let cut = -1;
      line.forEach(([x, y], i) => { if (mask.near(x, y, 20, M.CITY | M.CITYZONE | M.VILLAGE | M.SETTLE | M.BUILD | M.RAIL)) cut = i; });
      line = line.slice(cut + 1);
      if (lineLen(line) < 1200) continue;
      addItem(world.water, { kind: 'river', line, width: 7, stream: true }, 30);
      mask.stampLine(line, 9, M.WATER);
      addItem(world.areas, { kind: 'floodplain', line, width: 60 }, 30);
    }
  }
}

// ---------- Придорожные лесополосы вдоль трассы ----------
function roadsideBelts(world, rng, highway) {
  const { mask } = world;
  const block = M.ROAD | M.BUILD | M.WATER | M.CITY | M.CITYZONE | M.VILLAGE | M.SETTLE | M.RAIL;
  for (const sg of [-1, 1]) {
    const off = offsetLine(highway, sg * 30);
    let run = [];
    const flush = () => {
      if (run.length > 6) {
        for (let k = 0; k + 1 < run.length; k += 4) segsBelt(world, rng, run[k], run[Math.min(run.length - 1, k + 4)], 0, 11);
        mask.stampLine(run, 16, M.GREEN);
      }
      run = [];
    };
    for (const p of off) { if (mask.near(p[0], p[1], 9, block)) flush(); else run.push(p); }
    flush();
  }
}

// ---------- Автобусные остановки ----------
// У каждого села — остановка с карманом на ближайшей загородной дороге (не на трассе с разделителем
// — там площадка за полосой разгона)
function placeBusStops(world) {
  world.stops = [];
  for (const v of world.settlements) {
    if (v.type !== 'village') continue;
    let best = null, bd = 600;
    for (const r of world.roads.query({ x0: v.x - 600, y0: v.y - 600, x1: v.x + 600, y1: v.y + 600 })) {
      if (r.type !== 'local' && r.type !== 'highway') continue;
      for (let i = 1; i < r.line.length; i++) {
        const f = footOn([v.x, v.y], r.line[i - 1], r.line[i]), d = Math.hypot(f[0] - v.x, f[1] - v.y);
        if (d < bd) { bd = d; const a = r.line[i - 1], b = r.line[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; best = { x: f[0], y: f[1], tx: (b[0] - a[0]) / L, ty: (b[1] - a[1]) / L, r }; }
      }
    }
    if (!best) continue;
    // карман — на стороне села
    const side = Math.sign((v.x - best.x) * -best.ty + (v.y - best.y) * best.tx) || 1;
    const w = best.r.type === 'highway' ? 13 : best.r.width / 2;
    const bx = best.x - best.ty * side * (w + 4), by = best.y + best.tx * side * (w + 4);
    if (world.mask.has(bx, by, M.WATER | M.BUILD | M.RAIL)) continue;
    world.stops.push({ x: best.x, y: best.y, tx: best.tx, ty: best.ty, side, w, name: v.name });
  }
}

// ---------- Перекрёстки и развязки ----------
// Загородные дороги, пересекающиеся «иксом»: второстепенная на подходе доворачивает так, чтобы
// пересечь главную под прямым углом (S-образный поворот, как при реконструкции перекрёстков).
// Трасса с другой дорогой — развязка «ромб»: второстепенная идёт путепроводом над трассой, четыре
// съезда соединяют её с проезжими частями. Итог — в world.crossings (для отрисовки разметки).
const XRANK = { dirt: 0, village: 1, ramp: 2, local: 3, highway: 5 };
function fixCrossings(world) {
  const { mask } = world;
  world.crossings = [];
  const along = (line, P) => { let best = 0, bd = Infinity, acc = 0, at = 0; for (let i = 1; i < line.length; i++) { const f = footOn(P, line[i - 1], line[i]), d = Math.hypot(f[0] - P[0], f[1] - P[1]); if (d < bd) { bd = d; at = acc + Math.hypot(f[0] - line[i - 1][0], f[1] - line[i - 1][1]); best = i; } acc += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]); } return { i: best, s: at }; };
  const pointAt = (line, s) => { let acc = 0; for (let i = 1; i < line.length; i++) { const L = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]); if (acc + L >= s) { const t = (s - acc) / (L || 1); return { p: [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t], i }; } acc += L; } return { p: line[line.length - 1].slice(), i: line.length - 1 }; };
  const tangentAt = (line, i) => { const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i)]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; };
  const free = (pts, allow) => pts.every(([x, y]) => !mask.has(x, y, M.BUILD | M.WATER | M.RAIL) || allow(x, y));
  const find = () => {
    const rural = world.roadList.filter((r) => r.type in XRANK && r.type !== 'ramp');
    const out = [];
    for (let i = 0; i < rural.length; i++) for (let j = i + 1; j < rural.length; j++) {
      const A = rural[i], B = rural[j];
      const ba = A.bbox, bb = B.bbox;
      if (ba.x0 > bb.x1 || ba.x1 < bb.x0 || ba.y0 > bb.y1 || ba.y1 < bb.y0) continue;
      for (let a = 1; a < A.line.length; a++) {
        const p0 = A.line[a - 1], p1 = A.line[a];
        const ax0 = Math.min(p0[0], p1[0]), ax1 = Math.max(p0[0], p1[0]), ay0 = Math.min(p0[1], p1[1]), ay1 = Math.max(p0[1], p1[1]);
        if (ax1 < bb.x0 || ax0 > bb.x1 || ay1 < bb.y0 || ay0 > bb.y1) continue;
        for (let b = 1; b < B.line.length; b++) {
        const q0 = B.line[b - 1], q1 = B.line[b];
        if (Math.max(q0[0], q1[0]) < ax0 || Math.min(q0[0], q1[0]) > ax1 || Math.max(q0[1], q1[1]) < ay0 || Math.min(q0[1], q1[1]) > ay1) continue;
        const t = segCross(A.line[a - 1], A.line[a], B.line[b - 1], B.line[b]);
        if (t < 0) continue;
        const P = [A.line[a - 1][0] + (A.line[a][0] - A.line[a - 1][0]) * t, A.line[a - 1][1] + (A.line[a][1] - A.line[a - 1][1]) * t];
        const ed = (L) => Math.min(Math.hypot(P[0] - L[0][0], P[1] - L[0][1]), Math.hypot(P[0] - L[L.length - 1][0], P[1] - L[L.length - 1][1]));
        if (ed(A.line) < 30 || ed(B.line) < 30) continue;
        const main = XRANK[A.type] > XRANK[B.type] || (XRANK[A.type] === XRANK[B.type] && lineLen(A.line) >= lineLen(B.line)) ? A : B;
        out.push({ P, main, minor: main === A ? B : A });
        }
      }
    }
    return out;
  };
  const done = new Set();
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const { P, main, minor } of find()) {
      const key = Math.round(P[0] / 20) + ':' + Math.round(P[1] / 20);
      if (done.has(key)) continue;
      if ((world.roundabouts || []).some((q) => Math.hypot(q.x - P[0], q.y - P[1]) < 60)) { done.add(key); continue; } // там круговая развязка
      const m = along(main.line, P), n0 = along(minor.line, P);
      const t = tangentAt(main.line, m.i);
      let nx = -t[1], ny = t[0];
      const md = tangentAt(minor.line, n0.i);
      if (nx * md[0] + ny * md[1] < 0) { nx = -nx; ny = -ny; }
      const cos = Math.abs(t[0] * md[0] + t[1] * md[1]);
      const hw = main.type === 'highway';
      // почти параллельные (< 25°): дороги идут одна вдоль другой — общий участок оставляем одной
      // дороге (улице села, если она есть), вторая примыкает к ней с обеих сторон
      if (cos > 0.9 && !hw) {
        const host = minor.type === 'village' ? minor : main, cut = host === minor ? main : minor;
        if (mergeAlong(world, cut, host, P)) { changed = true; done.add(key); continue; }
      }
      const straight = hw ? 70 : 30;
      const Ls = lineLen(minor.line);
      // второстепенная дорога — под прямым углом на ±straight м от оси главной (подход разной длины,
      // пока новая трасса не обходит застройку и воду)
      let ok = cos <= 0.26 && !hw;
      if (!ok) for (const reach of hw ? [190, 150, 250, 120] : [110, 80, 150]) {
        if (n0.s < reach + 10 || Ls - n0.s < reach + 10) continue;
        const A = pointAt(minor.line, n0.s - reach), B = pointAt(minor.line, n0.s + reach);
        const ctrl = [A.p, [P[0] - nx * Math.min(straight, reach / 2.5), P[1] - ny * Math.min(straight, reach / 2.5)], P, [P[0] + nx * Math.min(straight, reach / 2.5), P[1] + ny * Math.min(straight, reach / 2.5)], B.p];
        const seg = resample(catmullRom(ctrl, 10), 10);
        if (!free(seg, () => false)) continue;
        minor.line = [...minor.line.slice(0, A.i), ...seg, ...minor.line.slice(B.i)];
        minor.bbox = bboxOf(minor.line, minor.width + 6);
        mask.stampLine(seg, ROAD_STYLE[minor.type].stamp, M.ROAD);
        changed = true; ok = true;
        break;
      }
      done.add(key);
      if (hw && !ok && cos > 0.5) { world.crossings.push({ x: P[0], y: P[1], main, minor, kind: 'x' }); continue; }
      if (!hw) { world.crossings.push({ x: P[0], y: P[1], main, minor, kind: 'x' }); continue; }
      // развязка «ромб»: путепровод и четыре съезда (с второстепенной — на проезжую часть своей стороны)
      const X = { x: P[0], y: P[1], main, minor, kind: 'interchange', tx: t[0], ty: t[1], nx, ny, ramps: [] };
      const half = main.width / 2 - 3;
      // съезд — плавная кривая: уходит со второстепенной в 150 м от трассы и вливается в неё через ~400 м
      // съезд не пересекает чужие дороги (свои — трасса и второстепенная — не в счёт)
      const onRoad = (ln) => ln.some(([x, y]) => mask.has(x, y, M.ROAD) && distToLine(x, y, minor.line) > 22 && distToLine(x, y, main.line) > 30);
      for (const s of [-1, 1]) for (const d of [-1, 1]) {
        const S = pointAt(minor.line, n0.s + s * 150).p;
        const M1 = [P[0] + t[0] * d * 110 + nx * s * 95, P[1] + t[1] * d * 110 + ny * s * 95];
        const M2 = [P[0] + t[0] * d * 260 + nx * s * (half + 16), P[1] + t[1] * d * 260 + ny * s * (half + 16)];
        const E = [P[0] + t[0] * d * 400 + nx * s * half, P[1] + t[1] * d * 400 + ny * s * half];
        const ln = resample(catmullRom([S, M1, M2, E], 10), 10);
        if (!free(ln, () => false) || onRoad(ln)) continue;
        X.ramps.push(addRoad(world, ln, 'ramp'));
      }
      X.over = [[P[0] - nx * 32, P[1] - ny * 32], [P[0] + nx * 32, P[1] + ny * 32]];
      world.crossings.push(X);
    }
    if (!changed) break;
  }
  const old = world.roads;
  world.roads = new SpatialIndex(world.W, world.H, old.cell);
  for (const r of world.roadList) { r.bbox = bboxOf(r.line, r.width + 6); world.roads.insert(r); }
}

// Дорога cut идёт вдоль дороги host (ближе 30 м): этот участок вырезаем, оставшиеся куски
// примыкают к host поперечными отрезками
function mergeAlong(world, cut, host, P) {
  const near = (p) => { let d = Infinity; for (let j = 1; j < host.line.length; j++) { const f = footOn(p, host.line[j - 1], host.line[j]); d = Math.min(d, Math.hypot(f[0] - p[0], f[1] - p[1])); } return d; };
  const foot = (p) => { let best = null, bd = Infinity; for (let j = 1; j < host.line.length; j++) { const f = footOn(p, host.line[j - 1], host.line[j]), d = Math.hypot(f[0] - p[0], f[1] - p[1]); if (d < bd) { bd = d; best = f; } } return best; };
  const L = cut.line;
  let k = 0, bd = Infinity;
  for (let i = 0; i < L.length; i++) { const d = Math.hypot(L[i][0] - P[0], L[i][1] - P[1]); if (d < bd) { bd = d; k = i; } }
  let i0 = k, i1 = k;
  while (i0 > 0 && near(L[i0 - 1]) < 30) i0--;
  while (i1 < L.length - 1 && near(L[i1 + 1]) < 30) i1++;
  const a = L.slice(0, i0), b = L.slice(i1 + 1);
  if (a.length < 2 && b.length < 2) return false;
  if (a.length >= 2) a.push(foot(a[a.length - 1]));
  if (b.length >= 2) b.unshift(foot(b[0]));
  if (a.length >= 2) { cut.line = a; if (b.length >= 2) addRoad(world, b, cut.type); }
  else cut.line = b;
  cut.bbox = bboxOf(cut.line, cut.width + 6);
  return true;
}

function nearestPoint(line, p) {
  let best = line[0], bd = Infinity;
  for (const q of line) {
    const d = dist(p, q);
    if (d < bd) { bd = d; best = q; }
  }
  return best.slice();
}

function wobblyRoad(rng, a, b, n) {
  const pts = [a.slice()];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const off = rng.float(-0.08, 0.08) * L;
    pts.push([a[0] + dx * t - (dy / L) * off, a[1] + dy * t + (dx / L) * off]);
  }
  pts.push(b.slice());
  return resample(catmullRom(pts, 12), 10);
}

// ---------- Балка ----------
function buildBalka(world, rng, river, cityC) {
  const { mask } = world;
  // Точка на реке в южной или северной части, подальше от города
  const idx = Math.floor(river.length * (rng.chance(0.5) ? rng.float(0.78, 0.9) : rng.float(0.1, 0.22)));
  const start = river[idx];
  const dirX = start[0] < cityC[0] ? -1 : 1;
  const flip = rng.chance(0.5) ? 1 : -1;
  const ctrl = [start.slice()];
  let a = dirX > 0 ? 0 : Math.PI;
  let p = start.slice();
  for (let i = 0; i < 6; i++) {
    a += rng.float(-0.45, 0.45) + flip * 0.08;
    p = [p[0] + Math.cos(a) * 320, p[1] + Math.sin(a) * 320];
    ctrl.push(p);
  }
  const line = resample(catmullRom(ctrl, 8), 10);
  const widths = line.map((_, i) => 110 * (1 - i / line.length) + 45);
  addItem(world.areas, { kind: 'balka', line, widths }, 90);
  for (let i = 0; i < line.length; i++) mask.stampDisc(line[i][0], line[i][1], widths[i] * 0.5, M.BALKA);

  // Деревья по тальвегу (дну балки) — густо, с разрывами
  for (let i = 0; i < line.length; i++) {
    const w = widths[i];
    const n = rng.int(2, 6);
    if (rng.chance(0.12)) continue;
    for (let k = 0; k < n; k++) {
      const x = line[i][0] + rng.gauss(0, w * 0.18);
      const y = line[i][1] + rng.gauss(0, w * 0.18);
      if (mask.has(x, y, M.ROAD | M.WATER)) continue;
      world.trees.add(x, y, rng.float(2.5, 5.5), rng.int(0, 3));
    }
  }
  // Пруд с дамбой в середине балки
  const pi = Math.floor(line.length * rng.float(0.35, 0.55));
  const pc = line[pi];
  const tg = tangents(line)[pi];
  const pondAngle = Math.atan2(tg[1], tg[0]);
  const pond = blob(pc[0], pc[1], rng.float(110, 170), rng.float(35, 55), pondAngle, rng, 36, 0.25);
  addItem(world.water, { kind: 'pond', poly: pond }, 12);
  mask.stampPoly(pond, M.WATER);
  // Дамба — поперёк балки, с дорогой-грунтовкой
  const end = pc[0] + tg[0] * 150, endY = pc[1] + tg[1] * 150;
  const dam = [[end - tg[1] * 70, endY + tg[0] * 70], [end + tg[1] * 70, endY - tg[0] * 70]];
  addItem(world.areas, { kind: 'dam', line: dam, width: 16 }, 10);
}

// ---------- Поля и лесополосы ----------
function buildFields(world, rng, keep = null) {
  const { mask, W, H } = world;
  const theta = rng.float(-0.18, 0.18);
  const c = Math.cos(theta), s = Math.sin(theta);
  const toW = (u, v) => [u * c - v * s, u * s + v * c];

  // Разметка сетки в повёрнутых координатах с запасом
  const us = [];
  for (let u = -900; u < W + 900; u += rng.float(480, 900)) us.push(u);
  const vs = [];
  for (let v = -900; v < H + 900; v += rng.float(300, 520)) vs.push(v);

  const avoid = M.SETTLE | M.CITY | M.CITYZONE | M.WATER | M.BALKA | M.VILLAGE;
  const cropPairs = [
    ['wheat', 3], ['stubble', 4], ['plowed', 3], ['harrowed', 2], ['sunflower', 4], ['corn', 2], ['fallow', 1.2],
  ];

  // Грунтовки вдоль части лесополос
  const dirtLines = [];

  for (let i = 0; i + 1 < us.length; i++) {
    for (let j = 0; j + 1 < vs.length; j++) {
      const inset = 18; // половина самой широкой посадки + травяная кромка
      const u0 = us[i] + inset, u1 = us[i + 1] - inset, v0 = vs[j] + inset, v1 = vs[j + 1] - inset;
      const center = toW((u0 + u1) / 2, (v0 + v1) / 2);
      if (center[0] < -300 || center[1] < -300 || center[0] > W + 300 || center[1] > H + 300) continue;
      if (mask.has(center[0], center[1], M.CITYZONE | M.VILLAGE)) continue;
      if (keep && !keep(center[0], center[1])) continue; // вдали от жилья — степь и пустыри

      // Иногда поле делится на два без полосы
      const parts = [];
      if (rng.chance(0.3)) {
        const split = rng.float(0.35, 0.65);
        if (u1 - u0 > v1 - v0) {
          const us2 = u0 + (u1 - u0) * split;
          parts.push([u0, us2, v0, v1], [us2, u1, v0, v1]);
        } else {
          const vs2 = v0 + (v1 - v0) * split;
          parts.push([u0, u1, v0, vs2], [u0, u1, vs2, v1]);
        }
      } else parts.push([u0, u1, v0, v1]);

      for (const [a0, a1, b0, b1] of parts) {
        const poly = [toW(a0, b0), toW(a1, b0), toW(a1, b1), toW(a0, b1)];
        const crop = rng.weighted(cropPairs);
        const along = a1 - a0 > b1 - b0 ? theta : theta + Math.PI / 2;
        const field = {
          kind: 'field', poly, crop,
          angle: along + (rng.chance(0.15) ? Math.PI / 2 : 0),
          seed: rng.int(0, 1e9),
          patches: [],
        };
        // Пятна: сырые низины, другая влажность почвы
        const nP = rng.int(0, 4);
        for (let k = 0; k < nP; k++) {
          const pu = rng.float(a0, a1), pv = rng.float(b0, b1);
          const [px, py] = toW(pu, pv);
          field.patches.push({ x: px, y: py, rx: rng.float(20, 90), ry: rng.float(15, 60), a: rng.float(0, 3.14), dark: rng.chance(0.6) });
        }
        addItem(world.fields, field, 0);
      }
    }
  }

  // Лесополосы по линиям сетки: сегменты между пересечениями
  const segs = [];
  for (let i = 0; i < us.length; i++)
    for (let j = 0; j + 1 < vs.length; j++) segs.push([toW(us[i], vs[j]), toW(us[i], vs[j + 1])]);
  for (let j = 0; j < vs.length; j++)
    for (let i = 0; i + 1 < us.length; i++) segs.push([toW(us[i], vs[j]), toW(us[i + 1], vs[j])]);

  const beltSegs = [];
  for (const [a, b] of segs) {
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (mid[0] < -200 || mid[1] < -200 || mid[0] > W + 200 || mid[1] > H + 200) continue;
    if (keep && !keep(mid[0], mid[1], true)) continue;
    const bw = rng.float(16, 30);
    // Иногда вдоль полосы идёт грунтовка
    if (rng.chance(0.22)) {
      const L = dist(a, b);
      const dx = (b[0] - a[0]) / L, dy = (b[1] - a[1]) / L;
      const side = rng.chance(0.5) ? 1 : -1;
      const off = (bw / 2 + 5) * side;
      // Грунтовка чуть выходит за перекрёсток полос, прорезая поперечную
      const line = resample([
        [a[0] - dy * off - dx * 20, a[1] + dx * off - dy * 20],
        [b[0] - dy * off + dx * 20, b[1] + dx * off + dy * 20],
      ], 10);
      // не тянем грунтовку через город и воду
      const ok = line.every(([x, y]) => !mask.has(x, y, M.CITYZONE | M.WATER | M.BALKA | M.SETTLE | M.VILLAGE | M.BUILD));
      if (ok) dirtLines.push(line);
    }
    if (rng.chance(0.85)) beltSegs.push([a, b, bw]);
  }
  // Сначала дороги (чтобы в полосах остались проезды), потом деревья
  for (const line of dirtLines) addRoad(world, line, 'dirt');
  for (const [a, b, bw] of beltSegs) segsBelt(world, rng, a, b, avoid, bw);
}

// ---------- Площадка объекта, построенного по ходу игры ----------
// То же, что делает place() при генерации: площадка с отсыпкой (для фоновой отрисовки карты),
// занятость маски и подъезд к дороге. Вызывается в основном потоке и в воркере по событию.
export function addSite(world, s) {
  if (s.kind === 'pontoon') return { x0: s.x - 60, y0: s.y - 60, x1: s.x + 60, y1: s.y + 60 }; // на воде: без площадки
  const lay = infraLayout(s.kind, s.L);
  const pad = lay.w >= 140 ? 45 : lay.w >= 60 ? 22 : 12;
  const poly = rectCorners(s.x, s.y, lay.w + 16, lay.h + 16, s.angle);
  const apron = rectCorners(s.x, s.y, lay.w + pad * 2, lay.h + pad * 2, s.angle);
  world.mask.stampPoly(apron, M.BUILD);
  // поле под площадкой изымается (для агрофирмы оно пропадает)
  const out = bboxOf(apron, 60);
  for (const f of world.fields.query(bboxOf(apron, 0))) {
    if (f.kind !== 'field' || f.removed) continue;
    let cx = 0, cy = 0; for (const [x, y] of f.poly) { cx += x; cy += y; } cx /= f.poly.length; cy /= f.poly.length;
    if (pointInPoly(cx, cy, apron) || apron.some(([x, y]) => pointInPoly(x, y, f.poly))) { f.removed = true; out.x0 = Math.min(out.x0, f.bbox.x0); out.y0 = Math.min(out.y0, f.bbox.y0); out.x1 = Math.max(out.x1, f.bbox.x1); out.y1 = Math.max(out.y1, f.bbox.y1); }
  }
  addItem(world.areas, { kind: 'dwsite', oid: s.oid, side: s.side, poly, apron, site: s.kind, x: s.x, y: s.y, angle: s.angle, w: lay.w + 16, h: lay.h + 16, pad, gateQ: s.gateQ, fp: lay.comps.map((c) => [c.u, c.v, c.w, c.h, c.k]) });
  if (s.drive && s.drive.length > 1) {
    const line = cutAtRoad(world, resample(s.drive, 8), apron);
    addItem(world.roads, { kind: 'road', type: 'dirt', line, width: ROAD_STYLE.dirt.width, built: true }, ROAD_STYLE.dirt.width + 6);
    world.mask.stampLine(line, ROAD_STYLE.dirt.stamp, M.ROAD);
  }
  return out;
}

// ---------------------------------------------------------------- Подключение объектов к сети
// Кому нужна отпайка 10 кВ (генерация и подстанции соединены магистральными ЛЭП, мост и импорт — не потребители)
export const FEED_KINDS = new Set(['workshop', 'store', 'fuel', 'market', 'mall', 'hub', 'elevator', 'agro', 'factory', 'oil', 'ammo', 'rembase', 'firest', 'border',
  'housing', 'hospital', 'school', 'mill', 'dairy', 'autopark', 'refinery', 'watertower', 'railterm', 'port', 'coalmine', 'cement', 'reserve', 'launch']);
export const FEED110 = new Set(['solar', 'bess', 'decoy']);
// Портал ОРУ нужного напряжения со стороны, обращённой к другому концу; into — середина шин (туда заходят провода)
export function portalOf(o, kv, toward) {
  if (!o.comps) return { pt: [o.x, o.y], into: null };
  const orus = o.comps.filter((q) => q.k === 'oru');
  const oru = orus.find((q) => (q.n || q.name || '').includes(String(kv))) || orus[0];
  if (!oru) return { pt: edgeOf(o, toward), into: null };
  // линия заходит на концевой портал ряда ОРУ (ряды — вдоль длинной стороны, как в модели switchyard):
  // конец ряда со стороны линии, ряд — ближний к направлению линии
  const c = Math.cos(o.angle), s = Math.sin(o.angle);
  const lx = (toward[0] - o.x) * c + (toward[1] - o.y) * s - oru.u, ly = -(toward[0] - o.x) * s + (toward[1] - o.y) * c - oru.v;
  const big = oru.w > 100 || kv >= 330, H = big ? 17 : 11;
  const rows = Math.max(2, Math.round(oru.h / (big ? 20 : 9)));
  const L = Math.hypot(lx, ly) || 1;
  let r = Math.round(((ly / L) * 0.5 + 0.5) * (rows - 1));
  r = Math.max(0, Math.min(rows - 1, r));
  const su = Math.sign(lx || 1);
  const u = oru.u + su * oru.w / 2, v = oru.v - oru.h / 2 + ((r + 0.5) * oru.h) / rows;
  // концевая опора — за оградой напротив портала: последний пролёт идёт вдоль ряда, а не через площадку
  const uo = su * (o.w / 2 + 8 + (big ? 45 : 30));
  return { pt: [o.x + u * c - v * s, o.y + u * s + v * c], out: [o.x + uo * c - v * s, o.y + uo * s + v * c], into: null, h: H };
}
// Вставляет концевую опору перед порталом ОРУ и убирает опоры, попавшие на площадку или
// слишком близко к концевой (atEnd — портал в конце списка)
export function terminatePylons(pyl, o, P, atEnd, mask = null) {
  if (!P.out || (mask && mask.has(P.out[0], P.out[1], M.WATER))) return pyl; // опору в реку не ставим
  const c = Math.cos(o.angle), s = Math.sin(o.angle);
  const onSite = (p) => { const lx = (p.x - o.x) * c + (p.y - o.y) * s, ly = -(p.x - o.x) * s + (p.y - o.y) * c; return Math.abs(lx) < o.w / 2 + 20 && Math.abs(ly) < o.h / 2 + 20; };
  const list = atEnd ? pyl.slice().reverse() : pyl.slice();
  const head = list[0], T = { x: P.out[0], y: P.out[1] };
  const rest = list.slice(1).filter((p, i, a) => i === a.length - 1 || (!onSite(p) && Math.hypot(p.x - T.x, p.y - T.y) > 90));
  const out = [head, T, ...rest];
  return atEnd ? out.reverse() : out;
}
// Точка на границе площадки объекта в сторону цели
export function edgeOf(o, toward) {
  const c = Math.cos(o.angle || 0), s = Math.sin(o.angle || 0);
  const lx = (toward[0] - o.x) * c + (toward[1] - o.y) * s, ly = -(toward[0] - o.x) * s + (toward[1] - o.y) * c;
  const hw = (o.w || 20) / 2 - 4, hh = (o.h || 20) / 2 - 4;
  const k = Math.min(hw / (Math.abs(lx) || 1e-6), hh / (Math.abs(ly) || 1e-6));
  const u = lx * k, v = ly * k;
  return [o.x + u * c - v * s, o.y + u * s + v * c];
}
// Трасса подключения: 10 кВ — к ближайшей ТП своей стороны (до 3,5 км) или к ПС 110 кВ;
// солнечная станция, накопитель и макет — ЛЭП 110 кВ к порталу ближайшей ПС 110 кВ
export function gridFeed(world, o, maxPs = 9000) {
  const side = o.side, fx = world.frontX ?? world.W / 2;
  const own = (x) => (side === 'blue' ? x < fx : x > fx);
  const pss = world.infra.filter((q) => q.kind === 'ps110' && q.side === side);
  const h = ((typeof o.id === 'number' ? o.id : [...String(o.id)].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7)) * 2654435761) >>> 0;
  const bend = ((h % 1000) / 1000 - 0.5) * 0.25;
  const route = (A, B, step) => {
    const L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
    const mid = [(A[0] + B[0]) / 2 - ((B[1] - A[1]) / L) * L * bend, (A[1] + B[1]) / 2 + ((B[0] - A[0]) / L) * L * bend];
    return resample(L > 300 ? catmullRom([A, mid, B], 6) : [A, B], step);
  };
  let best = null, bd = Infinity;
  for (const p of pss) { const d = Math.hypot(p.x - o.x, p.y - o.y); if (d < bd) { bd = d; best = p; } }
  if (FEED110.has(o.kind)) {
    if (!best || bd > maxPs * 1.5) return null;
    const P = portalOf(best, 110, [o.x, o.y]);
    const A = edgeOf(o, P.pt);
    let pyl = route(A, P.pt, 220).map(([x, y]) => ({ x, y }));
    pyl = terminatePylons(pyl, best, P, true, world.mask);
    pyl[0].portal = true; pyl[pyl.length - 1].portal = true; pyl[pyl.length - 1].ph = P.h;
    return { oid: o.id, kv: 110, side, pylons: pyl, id: 'f' + o.id, L: bd };
  }
  let tgt = null, td = 3500;
  for (const tp of world.power?.tps || []) { if (!own(tp.x)) continue; const d = Math.hypot(tp.x - o.x, tp.y - o.y); if (d < td) { td = d; tgt = [tp.x, tp.y]; } }
  if (!tgt) { if (!best || bd > maxPs) return null; tgt = edgeOf(best, [o.x, o.y]); td = bd; }
  const A = edgeOf(o, tgt);
  return { oid: o.id, kv: 10, side, poles: route(A, tgt, 45), L: td };
}

// События экономики для фоновой отрисовки и гостя: стройка (площадка) и смена культур на полях.
// Возвращает список рамок, которые надо перерисовать.
export function applyEconEvent(world, ev) {
  if (ev.k === 'site') return [addSite(world, ev.s)];
  if (ev.k === 'season') { world.season = ev.id; return null; }
  if (ev.k === 'fog') {
    // туман войны для фоновой отрисовки: какие объекты противника зритель уже нашёл
    if (!world.fog || ev.reset) world.fog = { side: ev.side, on: ev.on !== false, known: new Set() };
    for (const id of ev.ids || []) world.fog.known.add(id);
    return null;
  }
  if (ev.k === 'pave') {
    const r = world.roadList[ev.i];
    if (!r) return null;
    r.type = 'local'; r.width = 8;
    world.mask.stampLine(r.line, ROAD_STYLE.local.stamp, M.ROAD);
    return [r.bbox];
  }
  if (ev.k === 'line') {
    if (!world.power.lines.some((l) => l.id === ev.ln.id)) world.power.lines.push(ev.ln);
    world.power.version = (world.power.version || 0) + 1;
    const xs = ev.ln.pylons.map((p) => p.x), ys = ev.ln.pylons.map((p) => p.y);
    return [{ x0: Math.min(...xs) - 60, y0: Math.min(...ys) - 60, x1: Math.max(...xs) + 60, y1: Math.max(...ys) + 60 }];
  }
  if (ev.k === 'feed') {
    const f = ev.f;
    if (f.kv === 110) { if (!world.power.lines.some((l) => l.id === f.id)) world.power.lines.push({ id: f.id, kv: 110, a: f.oid, b: null, side: f.side, pylons: f.pylons, feed: true }); }
    else if (!(world.power.feeds ||= []).some((q) => q.oid === f.oid)) world.power.feeds.push(f);
    world.power.version = (world.power.version || 0) + 1;
    const P = f.pylons || f.poles.map(([x, y]) => ({ x, y }));
    const xs = P.map((p) => p.x), ys = P.map((p) => p.y);
    return [{ x0: Math.min(...xs) - 60, y0: Math.min(...ys) - 60, x1: Math.max(...xs) + 60, y1: Math.max(...ys) + 60 }];
  }
  if (ev.k === 'gfx') { world.gfxLow = !!ev.low; return null; }
  if (ev.k === 'burn') { const b = addBurn(world, new Rng(ev.s >>> 0), ev.x, ev.y, ev.r); return [bboxOf(b.poly, 4)]; }
  if (ev.k === 'crop') {
    const out = [];
    for (const [i, crop] of ev.f) { const f = world.fields.items[i]; if (f) { f.crop = crop; out.push(f.bbox); } }
    return out;
  }
  return null;
}

// ---------- Связность дорожной сети ----------
// Каждый остров дорог (село или район, чья дорога оборвалась) соединяем с основной сетью новой
// дорогой к ближайшей точке: не через застройку и ж/д; через реку — только узким местом (будет мост)
function connectRoadNet(world, rng) {
  const { mask } = world;
  const xs = [], ys = [], rid = [];
  // шаг 12 м: иначе конец улицы, упёршийся в середину длинного пролёта соседней, кажется оторванным
  world.roadList.forEach((r, ri) => { for (const [x, y] of resample(r.line, 12)) { xs.push(x); ys.push(y); rid.push(ri); } });
  const n = xs.length, par = new Int32Array(n).map((_, i) => i);
  const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) par[a] = b; };
  const C = 100, bins = new Map();
  for (let i = 0; i < n; i++) { const k = Math.floor(xs[i] / C) * 100003 + Math.floor(ys[i] / C); (bins.get(k) || bins.set(k, []).get(k)).push(i); }
  const near = (x, y, r, fn) => { for (let cx = Math.floor((x - r) / C); cx <= Math.floor((x + r) / C); cx++) for (let cy = Math.floor((y - r) / C); cy <= Math.floor((y + r) / C); cy++) for (const j of bins.get(cx * 100003 + cy) || []) fn(j); };
  for (let i = 1; i < n; i++) if (rid[i] === rid[i - 1]) uni(i, i - 1);
  // связь — как в графе дорог логистики (узлы ближе полуширины + 11 м), иначе машины не проедут
  const wOf = (i) => world.roadList[rid[i]].width || 8;
  for (let i = 0; i < n; i++) near(xs[i], ys[i], 40, (j) => { if (rid[j] !== rid[i] && Math.hypot(xs[j] - xs[i], ys[j] - ys[i]) < Math.max(wOf(i), wOf(j)) / 2 + 9) uni(i, j); });
  // концы дорог — к ближайшему узлу в 90 м (как в дорожном графе логистики)
  for (let i = 0; i < n; i++) {
    if (i > 0 && rid[i - 1] === rid[i] && i + 1 < n && rid[i + 1] === rid[i]) continue;
    near(xs[i], ys[i], 40, (j) => { if (rid[j] !== rid[i] && Math.hypot(xs[j] - xs[i], ys[j] - ys[i]) < Math.max(wOf(i), wOf(j)) / 2 + 9) uni(i, j); });
  }
  let noCross = true;
  const passable = (a, b) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let wet = 0, wetMax = 0;
    for (let t = 20; t < L - 20; t += 10) {
      const x = a[0] + ((b[0] - a[0]) * t) / L, y = a[1] + ((b[1] - a[1]) * t) / L;
      if (mask.has(x, y, M.BUILD | M.RAIL) || (mask.has(x, y, M.CITY) && t > 150 && t < L - 150)) return false; // из города можно выехать, но не пересечь его
      if (noCross && t > 40 && t < L - 40 && mask.has(x, y, M.ROAD)) return false; // перемычка не пересекает другие дороги
      if (mask.has(x, y, M.WATER)) { wet += 10; wetMax = Math.max(wetMax, wet); } else wet = 0;
    }
    return wetMax < 200;
  };
  for (let pass = 0; pass < 120; pass++) {
    const size = new Map();
    for (let i = 0; i < n; i++) { const r = find(i); size.set(r, (size.get(r) || 0) + 1); }
    const main = [...size.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const islands = [...size.entries()].filter(([r, k]) => r !== main && k >= 3).sort((a, b) => b[1] - a[1]);
    if (!islands.length) break;
    let linked = false;
    // узлы основной сети — в грубой сетке 200 м; ближайший ищем кольцами наружу (до 8 км)
    const G = 200, mainCells = new Map();
    for (let j = 0; j < n; j++) if (find(j) === main) { const k = Math.floor(xs[j] / G) * 100003 + Math.floor(ys[j] / G); (mainCells.get(k) || mainCells.set(k, []).get(k)).push(j); }
    const nearestMain = (x, y) => {
      const ci = Math.floor(x / G), cj = Math.floor(y / G);
      let best = -1, bd = 8000;
      for (let r = 0; r <= 40 && (r - 1) * G < bd; r++)
        for (let di = -r; di <= r; di++)
          for (let dj = -r; dj <= r; dj += Math.abs(di) === r ? 1 : 2 * r || 1) { // только периметр кольца
            const a = mainCells.get((ci + di) * 100003 + cj + dj);
            if (a) for (const j of a) { const d = Math.hypot(xs[j] - x, ys[j] - y); if (d < bd) { bd = d; best = j; } }
          }
      return [best, bd];
    };
    for (const [root] of islands) {
      const cand = [];
      for (let i = 0, m = 0; i < n; i++) {
        if (find(i) !== root || m++ % 3) continue; // каждый третий узел (36 м) — точности хватает
        const [best, bd] = nearestMain(xs[i], ys[i]);
        if (best >= 0) cand.push([bd, i, best]);
      }
      // по одному лучшему кандидату на квадрат 400 м: иначе все попытки упираются в один и тот же
      // непроходимый участок (застройка, ж/д)
      const bestIn = new Map();
      for (const c of cand) { const k = Math.floor(xs[c[1]] / 400) * 1000 + Math.floor(ys[c[1]] / 400); const b = bestIn.get(k); if (!b || c[0] < b[0]) bestIn.set(k, c); }
      const pick = [...bestIn.values()].sort((a, b) => a[0] - b[0]);
      for (const [, i, j] of pick.slice(0, 300)) {
        const a = [xs[i], ys[i]], b = [xs[j], ys[j]];
        if (!passable(a, b)) continue;
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]), nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L, o = rng.float(-0.06, 0.06) * L;
        const mid = [(a[0] + b[0]) / 2 + nx * o, (a[1] + b[1]) / 2 + ny * o];
        const line = L > 300 && passable(a, mid) && passable(mid, b) ? resample(catmullRom([a, mid, b], 8), 12) : resample([a, b], 12);
        addRoad(world, line, L > 1500 ? 'local' : 'village');
        uni(i, j); linked = true;
        break;
      }
    }
    if (!linked) { if (noCross) { noCross = false; continue; } break; } // без перемычек, не пересекающих дорог, не обойтись — разрешаем перекрёсток
  }
}

// ---------- Поля «Войны дронов» ----------
// Массив полей вокруг села/города: у каждого свой разворот; полосы разной ширины, в полосе — поля
// разной длины вразбежку (как нарезаны паи), краевые поля подрезаны по неровному контуру массива.
// Лесополосы — только по части длинных границ. Между массивами — степь с пятнами залежи.
function buildFieldsDW(world, rng, massifs) {
  const { mask, W, H } = world;
  const avoid = M.SETTLE | M.CITY | M.CITYZONE | M.WATER | M.BALKA | M.VILLAGE | M.BUILD | M.RAIL | M.GREEN;
  const G = 40, gw = Math.ceil(W / G), gh = Math.ceil(H / G);
  const taken = new Uint8Array(gw * gh);
  const cell = (x, y) => { const i = Math.floor(x / G), j = Math.floor(y / G); return i < 0 || j < 0 || i >= gw || j >= gh ? -1 : j * gw + i; };
  const busy = (x, y) => { const k = cell(x, y); return k < 0 || taken[k] === 1; };
  const busyNear = (p) => { for (const d of [30, 50]) for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) { const k = cell(p[0] + dx, p[1] + dy); if (k >= 0 && taken[k] === 1) return true; } return false; };
  const take = (poly) => {
    const bb = bboxOf(poly, 0);
    for (let y = Math.floor(bb.y0 / G) * G + G / 2; y < bb.y1; y += G)
      for (let x = Math.floor(bb.x0 / G) * G + G / 2; x < bb.x1; x += G) if (pointInPoly(x, y, poly)) { const k = cell(x, y); if (k >= 0) taken[k] = 1; }
  };
  const edges = [];
  const crops = [['wheat', 4], ['stubble', 4], ['sunflower', 3], ['plowed', 1.6], ['harrowed', 1.4], ['corn', 1.5], ['fallow', 1.2], ['meadow', 0.6]];
  let nFields = 0;
  // Поля нарезаны вдоль дорог: массивы по трассам и дорогам (ось массива — дорога, первый ряд полей
  // сразу за обочиной и придорожной лесополосой); остальные массивы повёрнуты по ближайшей дороге
  const fieldRoads = world.roadList.filter((r) => r.type === 'highway' || r.type === 'local' || r.type === 'village');
  const roadPts = [];
  for (const r of fieldRoads) {
    const pts = resample(r.line, 60);
    for (let i = 1; i + 1 < pts.length; i++) roadPts.push({ x: pts[i][0], y: pts[i][1], tx: pts[i + 1][0] - pts[i - 1][0], ty: pts[i + 1][1] - pts[i - 1][1], half: r.width / 2 + (r.type === 'highway' ? 4 : 0) });
    let acc = 1400;
    for (let i = 1; i + 1 < pts.length; i++) {
      acc += 60;
      if (acc < 2600) continue;
      const [x, y] = pts[i];
      if (mask.has(x, y, M.CITY | M.CITYZONE | M.WATER | M.VILLAGE)) continue;
      acc = 0;
      massifs.push({ x, y, r: 1500, road: { tx: pts[i + 1][0] - pts[i - 1][0], ty: pts[i + 1][1] - pts[i - 1][1], half: r.width / 2 + (r.type === 'highway' ? 4 : 0) } });
    }
  }
  const RB = 600, rbins = new Map();
  for (const p of roadPts) { const k = `${Math.floor(p.x / RB)},${Math.floor(p.y / RB)}`; (rbins.get(k) || rbins.set(k, []).get(k)).push(p); }
  const nearRoad = (x, y, maxD) => {
    let best = null, bd = maxD;
    const ix = Math.floor(x / RB), iy = Math.floor(y / RB), n = Math.ceil(maxD / RB);
    for (let dx = -n; dx <= n; dx++) for (let dy = -n; dy <= n; dy++) for (const p of rbins.get(`${ix + dx},${iy + dy}`) || []) { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p; } }
    return best;
  };
  // ----- Межевание вдоль дорог: ряды участков по обе стороны, границы повторяют изгибы дороги -----
  // Лесополосы копим и сажаем в конце — только там, где с боку действительно есть поле и полоса
  // не режет чужое поле (иначе остаются «обрывки» посреди степи)
  const pend = [], tracks = [];
  const belt = (line, bw) => pend.push([line, bw]);
  const areaOf = (poly) => { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; };
  const parcelOk = (poly) => {
    if (!mask.polyFree(poly, avoid | M.ROAD | M.RAIL, 14)) return false;
    const bb = bboxOf(poly, 0);
    for (let y = bb.y0 + 20; y < bb.y1; y += 60) for (let x = bb.x0 + 20; x < bb.x1; x += 60) if (pointInPoly(x, y, poly) && busy(x, y)) return false;
    return true;
  };
  const placeParcel = (poly, angle) => {
    const crop = rng.weighted(crops);
    const front = Math.abs(poly[0][0] - W / 2) < 2500;
    const field = { kind: 'field', poly, crop: front && rng.chance(0.6) ? rng.pick(['fallow', 'meadow']) : crop, angle, seed: rng.int(0, 1e9), patches: [] };
    const bb = bboxOf(poly, 0);
    for (let k = rng.int(0, 3); k > 0; k--) field.patches.push({ x: rng.float(bb.x0, bb.x1), y: rng.float(bb.y0, bb.y1), rx: rng.float(30, 110), ry: rng.float(20, 70), a: rng.float(0, 3.14), dark: rng.chance(0.6) });
    addItem(world.fields, field, 0);
    take(poly);
    nFields++;
  };
  const roadsByRank = world.roadList.filter((r) => r.type === 'highway' || r.type === 'local' || r.type === 'village').sort((a, b) => (b.type === 'highway') - (a.type === 'highway'));
  for (const r of roadsByRank) {
    const line = resample(r.line, 25);
    if (line.length < 20) continue;
    const g = r.width / 2 + (r.type === 'highway' ? 30 : 24); // обочина и придорожная лесополоса
    for (const sg of [1, -1]) {
      let i = rng.int(0, 10);
      while (i + 12 < line.length) {
        const n = Math.round(rng.float(450, 1250) / 25);
        const j = Math.min(line.length - 1, i + n);
        const sub = line.slice(i, j + 1);
        i = j;
        if (sub.length < 12) break;
        const inner = sub.slice(1, -1); // межа между соседними участками
        let d = g;
        let ok = false;
        const tg = [sub[sub.length - 1][0] - sub[0][0], sub[sub.length - 1][1] - sub[0][1]];
        const ang = Math.atan2(tg[1], tg[0]) + (rng.chance(0.15) ? Math.PI / 2 : 0);
        // участок (кусок ряда); не помещается — делим пополам по длине
        const tryRow = (pts, d0, d1, depth2) => {
          if (pts.length < 6) return false;
          const poly = [...offsetLine(pts, sg * d0), ...offsetLine(pts, sg * d1).reverse()];
          if (areaOf(poly) < 50000) return false;
          if (parcelOk(poly)) { placeParcel(poly, ang); return true; }
          if (depth2 >= 2) return false;
          const mid = Math.floor(pts.length / 2);
          const l = tryRow(pts.slice(0, mid - 1), d0, d1, depth2 + 1), rr = tryRow(pts.slice(mid + 1), d0, d1, depth2 + 1);
          return l || rr;
        };
        let miss = 0;
        for (let row = 0; row < 3 && miss < 2; row++) {
          const depth = rng.float(300, 650);
          if (tryRow(inner, d, d + depth, 0)) { if (row === 0) ok = true; if (row > 0 && rng.chance(0.2)) belt(offsetLine(inner, sg * (d - 6)), 10); } else miss++;
          d += depth + 12;
        }
        if (ok && rng.chance(0.4)) belt(offsetLine(inner, sg * (g - 12)), rng.float(9, 12)); // вдоль дороги
      }
    }
  }
  const MB = 3000, mbins = new Map();
  // числовые ключи корзин (owner зовут сотни тысяч раз — строковые ключи здесь заметно дороже)
  const mkey = (ix, iy) => (ix + 64) * 4096 + iy + 64;
  for (const m of massifs) { const k = mkey(Math.floor(m.x / MB), Math.floor(m.y / MB)); (mbins.get(k) || mbins.set(k, []).get(k)).push(m); }
  const owner = (x, y) => {
    let best = null, bd = Infinity;
    const ix = Math.floor(x / MB), iy = Math.floor(y / MB);
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (const m of mbins.get(mkey(ix + dx, iy + dy)) || []) {
      const d = Math.hypot(x - m.x, y - m.y) / m.r;
      if (d < bd) { bd = d; best = m; }
    }
    return bd < 1.5 ? best : null;
  };
  for (const m of massifs) {
    const nr = m.road ? null : nearRoad(m.x, m.y, 2200);
    const th = m.road ? Math.atan2(m.road.ty, m.road.tx) : nr ? Math.atan2(nr.ty, nr.tx) + (rng.chance(0.25) ? Math.PI / 2 : 0) : rng.float(-0.7, 0.7) + (rng.chance(0.5) ? Math.PI / 2 : 0);
    const c = Math.cos(th), s = Math.sin(th);
    const toW = (u, v) => [m.x + u * c - v * s, m.y + u * s + v * c];
    const ph = [rng.float(0, 6.28), rng.float(0, 6.28), rng.float(0, 6.28)];
    void ph;
    // территория массива — ячейка Вороного: точка принадлежит ближайшему (с учётом размера) массиву,
    // поэтому массивы стыкуются без пустот
    const inside = (x, y) => owner(x, y) === m;
    const R = m.r * 1.6;
    // полосы полей: у дорожного массива — от обочины в обе стороны, иначе — сплошь
    const strips = [];
    if (m.road) {
      const g = m.road.half + 22; // обочина и придорожная лесополоса
      for (let v = g; v < R;) { const sw = rng.float(300, 700); strips.push([v, sw, v === g]); v += sw; }
      for (let v = -g; v > -R;) { const sw = rng.float(300, 700); strips.push([v - sw, sw, v === -g]); v -= sw; }
    } else for (let v = -R + rng.float(0, 200); v < R;) { const sw = rng.float(260, 720); strips.push([v, sw, false]); v += sw; }
    let prevCrop = null;
    for (const [v, sw] of strips) {
      let u = -R - rng.float(0, 700);
      while (u < R) {
        const fl = rng.float(420, 1500);
        const u0 = u + 9, u1 = u + fl - 9, v0 = v + 9, v1 = v + sw - 9;
        u += fl + (rng.chance(0.1) ? rng.float(15, 40) : 0);
        const cen = toW((u0 + u1) / 2, (v0 + v1) / 2);
        if (!inside(cen[0], cen[1]) || busy(cen[0], cen[1])) continue;
        // Поле, возможно, разрезанное пополам, если частично заходит на запретное
        const tryPart = (a0, a1, b0, b1, depth) => {
          // подрезаем поле до чистой земли: своя ячейка массива, без дорог, воды, застройки и соседних полей
          const clean = (x, y) => inside(x, y) && !busy(x, y) && !mask.has(x, y, avoid | M.ROAD | M.RAIL);
          const lineU = (a) => { for (let k = 0; k <= 5; k++) { const p = toW(a, b0 + ((b1 - b0) * k) / 5); if (!clean(p[0], p[1])) return false; } return true; };
          while (a1 - a0 > 200 && !lineU(a0)) a0 += 25;
          while (a1 - a0 > 200 && !lineU(a1)) a1 -= 25;
          const lineV = (b) => { for (let k = 0; k <= 6; k++) { const p = toW(a0 + ((a1 - a0) * k) / 6, b); if (!clean(p[0], p[1])) return false; } return true; };
          while (b1 - b0 > 150 && !lineV(b0)) b0 += 25;
          while (b1 - b0 > 150 && !lineV(b1)) b1 -= 25;
          if (a1 - a0 < 200 || b1 - b0 < 150) return;
          const along = a1 - a0 >= b1 - b0;
          const poly = [toW(a0, b0), toW(a1, b0), toW(a1, b1), toW(a0, b1)];
          let bad = !mask.polyFree(poly, M.ROAD | M.RAIL, 10); // поле не наезжает на дороги
          for (let i = 0; i <= 4 && !bad; i++) for (let j = 0; j <= 4 && !bad; j++) {
            const x = poly[0][0] + (poly[1][0] - poly[0][0]) * (i / 4) + (poly[3][0] - poly[0][0]) * (j / 4);
            const y = poly[0][1] + (poly[1][1] - poly[0][1]) * (i / 4) + (poly[3][1] - poly[0][1]) * (j / 4);
            if (mask.has(x, y, avoid) || busy(x, y)) bad = true;
          }
          if (bad) {
            if (depth > 2) return;
            if (a1 - a0 > b1 - b0) { const mid = (a0 + a1) / 2; tryPart(a0, mid - 6, b0, b1, depth + 1); tryPart(mid + 6, a1, b0, b1, depth + 1); }
            else { const mid = (b0 + b1) / 2; tryPart(a0, a1, b0, mid - 6, depth + 1); tryPart(a0, a1, mid + 6, b1, depth + 1); }
            return;
          }
          let area = 0;
          for (let i = 0; i < 4; i++) { const p = poly[i], q = poly[(i + 1) % 4]; area += p[0] * q[1] - q[0] * p[1]; }
          if (Math.abs(area) / 2 < 40000) return;
          const front = Math.abs(toW((a0 + a1) / 2, (b0 + b1) / 2)[0] - W / 2) < 2500; // у линии фронта поля брошены
          const crop = front && rng.chance(0.6) ? rng.pick(['fallow', 'meadow']) : prevCrop && rng.chance(0.3) ? prevCrop : rng.weighted(crops);
          prevCrop = crop;
          const field = { kind: 'field', poly, crop, angle: (a1 - a0 > b1 - b0 ? th : th + Math.PI / 2) + (rng.chance(0.12) ? Math.PI / 2 : 0), seed: rng.int(0, 1e9), patches: [] };
          for (let k = rng.int(0, 3); k > 0; k--) {
            const q = toW(rng.float(a0, a1), rng.float(b0, b1));
            field.patches.push({ x: q[0], y: q[1], rx: rng.float(30, 120), ry: rng.float(20, 70), a: rng.float(0, 3.14), dark: rng.chance(0.6) });
          }
          addItem(world.fields, field, 0);
          take(poly);
          nFields++;
          // длинные края поля — кандидаты под лесополосу (в меже между полями)
          const long = a1 - a0 > b1 - b0;
          edges.push(long ? [toW(a0, b0 - 9), toW(a1, b0 - 9)] : [toW(a0 - 9, b0), toW(a0 - 9, b1)]);
          edges.push(long ? [toW(a0, b1 + 9), toW(a1, b1 + 9)] : [toW(a1 + 9, b0), toW(a1 + 9, b1)]);
        };
        tryPart(u0, u1, v0, v1, 0);
      }
    }
  }
  // Лесополосы — только по краям полей (в меже), часть краёв; общий край двух полей — одна полоса
  const seen = new Set();
  for (const e of edges) {
    if (e[0] === 'road') {
      // придорожная полоса: сажаем только там, где рядом поля (куски между пропусками)
      const [, a, b] = e;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      let run = null;
      for (let t = 0; t <= L; t += 50) {
        const p = [a[0] + ((b[0] - a[0]) * t) / L, a[1] + ((b[1] - a[1]) * t) / L];
        const ok = busy(p[0] + 0.001, p[1]) || busyNear(p);
        if (ok && !run) run = [p, p]; else if (ok) run[1] = p;
        if ((!ok || t + 50 > L) && run) { if (Math.hypot(run[1][0] - run[0][0], run[1][1] - run[0][1]) > 150) pend.push([[run[0], run[1]], rng.float(9, 13)]); run = null; }
      }
      continue;
    }
    const [a, b] = e;
    const k = `${Math.round((a[0] + b[0]) / 60)},${Math.round((a[1] + b[1]) / 60)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!rng.chance(0.13)) continue;
    pend.push([[a, b], rng.float(10, 14)]);
  }
  const inField = (x, y) => { for (const f of world.fields.query({ x0: x, y0: y, x1: x, y1: y })) if (f.kind === 'field' && pointInPoly(x, y, f.poly)) return true; return false; };
  for (const [line0, bw] of pend) {
    const line = resample(line0, 20);
    if (line.length < 2) continue;
    const off = bw / 2 + 22;
    // ломаная делится на «годные» куски: сбоку поле, сама полоса не режет поле
    let run = [], sideVote = 0;
    const flush = () => {
      let L = 0;
      for (let i = 1; i < run.length; i++) L += Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]);
      if (run.length >= 2 && L >= 90) {
        for (let k = 0; k + 1 < run.length; k += 5) segsBelt(world, rng, run[k], run[Math.min(run.length - 1, k + 5)], avoid, bw);
        if (L >= 160 && rng.chance(0.9)) tracks.push(offsetLine(run, (sideVote >= 0 ? 1 : -1) * (bw / 2 + 2.5)));
      }
      run = []; sideVote = 0;
    };
    for (let i = 0; i < line.length; i++) {
      const [x, y] = line[i], p = line[Math.max(0, i - 1)], q = line[Math.min(line.length - 1, i + 1)];
      let dx = q[0] - p[0], dy = q[1] - p[1];
      const n = Math.hypot(dx, dy) || 1; dx /= n; dy /= n;
      const l = inField(x - dy * off, y + dx * off), r = inField(x + dy * off, y - dx * off);
      if (!inField(x, y) && (l || r)) { run.push([x, y]); sideVote += (l ? 1 : 0) - (r ? 1 : 0); } else flush();
    }
    flush();
  }
  // Полевые дороги вдоль лесополос; концы примыкают к ближайшей дороге, если до неё недалеко и
  // съезд не режет поле. В дорожный граф логистики не входят (только для вида и сельхозтехники)
  // Концы, не дотянутые до дороги, цепляются к соседней грунтовке (сеть полевых дорог); грунтовка,
  // ни одним концом ни к чему не примыкающая, — лишняя, её нет
  world.fieldTracks = [];
  const clearTo = (e, p) => {
    const d = Math.hypot(p[0] - e[0], p[1] - e[1]);
    if (d <= 8) return true;
    for (let t = 12; t < d - 12; t += 10) {
      const x = e[0] + ((p[0] - e[0]) * t) / d, y = e[1] + ((p[1] - e[1]) * t) / d;
      if (inField(x, y) || mask.has(x, y, M.WATER | M.BUILD | M.RAIL | M.VILLAGE)) return false;
    }
    return true;
  };
  const tk = tracks.map((line) => ({ line, hooked: [false, false] }));
  for (const T of tk) {
    const L = T.line;
    [[L[0], 0], [L[L.length - 1], 1]].forEach(([e, k]) => {
      const nr = nearRoad(e[0], e[1], 320);
      if (!nr || !clearTo(e, [nr.x, nr.y])) return;
      if (Math.hypot(nr.x - e[0], nr.y - e[1]) > 8) { if (k) L.push([nr.x, nr.y]); else L.unshift([nr.x, nr.y]); }
      T.hooked[k] = true;
    });
  }
  for (let pass = 0; pass < 2; pass++)
    for (const T of tk) {
      for (const k of [0, 1]) {
        if (T.hooked[k]) continue;
        const L = T.line, e = k ? L[L.length - 1] : L[0];
        let best = null, bd = 250;
        for (const O of tk) {
          if (O === T || !(O.hooked[0] || O.hooked[1])) continue;
          for (let i = 0; i < O.line.length; i += 2) { const d = Math.hypot(O.line[i][0] - e[0], O.line[i][1] - e[1]); if (d < bd && clearTo(e, O.line[i])) { bd = d; best = O.line[i]; } }
        }
        if (!best) continue;
        if (bd > 8) { if (k) L.push(best.slice()); else L.unshift(best.slice()); }
        T.hooked[k] = true;
      }
    }
  for (const T of tk) {
    if (!T.hooked[0] && !T.hooked[1]) continue;
    const tr = addItem(world.roads, { kind: 'road', type: 'dirt', track: true, line: T.line, width: 3.5 }, 10);
    world.fieldTracks.push(tr);
    world.mask.stampLine(T.line, 5, M.ROAD);
  }
  // Степь: пятна залежи, выгоревшей травы и сырых понижений (мягкие края)
  for (let i = 0; i < Math.round((W * H) / 5.5e6); i++) {
    const x = rng.float(0, W), y = rng.float(0, H);
    if (busy(x, y) || mask.has(x, y, M.CITY | M.CITYZONE | M.VILLAGE)) continue;
    const r = rng.float(250, 1100);
    addItem(world.fields, { kind: 'field', poly: blob(x, y, r, r * rng.float(0.4, 0.9), rng.float(0, 3.14), rng, 28, 0.3), crop: rng.weighted([['dry', 3], ['green', 2], ['bare', 1]]), angle: 0, seed: rng.int(0, 1e9), patches: [] }, 0);
  }
  world.fieldCount = nFields;
}

// Лесополоса: 16–30 м шириной, несколько рядов деревьев и опушка из кустарника.
// Реальные посадки на юге — это 4–8 рядов (акация, клён, абрикос, дуб) с подлеском.
function segsBelt(world, rng, a, b, avoid, bw) {
  const { mask } = world;
  const L = dist(a, b);
  const dx = (b[0] - a[0]) / L, dy = (b[1] - a[1]) / L;
  const rows = bw < 12 ? 2 : Math.max(3, Math.floor((bw - 5) / 3.1));
  const rowGap = (bw - 5) / Math.max(1, rows - 1);
  const step = rng.float(3.4, 4.4);
  const kindShade = rng.int(0, 3);
  const pts = [];
  const gaps = [];
  const nGaps = rng.int(0, 2);
  for (let k = 0; k < nGaps; k++) {
    const g0 = rng.float(0, L);
    gaps.push([g0, g0 + rng.float(15, 60)]);
  }
  const plant = (x, y, rad, shade) => {
    if (mask.has(x, y, avoid | M.ROAD | M.RAIL | M.BUILD)) return;
    if (mask.near(x, y, 6, M.ROAD)) return;
    world.trees.add(x, y, rad, shade);
    pts.push([x, y]);
  };
  for (let d = -8; d < L + 8; d += step) {
    if (gaps.some(([g0, g1]) => d > g0 && d < g1)) continue;
    for (let r = 0; r < rows; r++) {
      if (rng.chance(0.06)) continue;
      const off = (r - (rows - 1) / 2) * rowGap + rng.float(-0.9, 0.9);
      const x = a[0] + dx * (d + rng.float(-1, 1)) - dy * off;
      const y = a[1] + dy * (d + rng.float(-1, 1)) + dx * off;
      const edge = r === 0 || r === rows - 1;
      plant(x, y, rng.float(2.4, 4.4) * (edge ? 0.9 : 1.1), (kindShade + rng.int(0, 1)) % 4);
    }
    // Опушка: кустарник (тёрн, шиповник) по обоим краям
    for (const side of [-1, 1]) {
      if (!rng.chance(bw < 12 ? 0.3 : 0.75)) continue;
      const off = side * (bw / 2 - 1.2 + rng.float(-0.8, 0.8));
      plant(a[0] + dx * (d + rng.float(-1.5, 1.5)) - dy * off, a[1] + dy * (d + rng.float(-1.5, 1.5)) + dx * off, rng.float(1.2, 2.2), 3);
    }
  }
  if (pts.length > 2) {
    addItem(world.belts, {
      kind: 'belt', line: [a, b], width: bw, len: L,
      dir: [dx, dy], normal: [-dy, dx], mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], pts,
    }, 18);
  }
}

// ---------- Сельская улица ----------
function buildVillageStreet(world, rng, street, density) {
  const { mask } = world;
  const tg = tangents(street);
  const roofs = curStyle ? curStyle.roofs : [
    ['#8b4a38', 3], ['#96503b', 2], ['#7e7e79', 3], ['#6c7f86', 1.5], ['#5f7a5a', 1], ['#9a9890', 1.5], ['#7a5540', 1],
  ];
  let s = 0;
  let i = 0;
  const cum = [0];
  for (let k = 1; k < street.length; k++) cum.push(cum[k - 1] + dist(street[k - 1], street[k]));
  const total = cum[cum.length - 1];
  while (s < total - 10) {
    const plotW = rng.float(24, 34);
    s += plotW;
    while (i < street.length - 1 && cum[i + 1] < s - plotW / 2) i++;
    const p = street[i];
    const t = tg[i];
    const ang = Math.atan2(t[1], t[0]);
    for (const side of [-1, 1]) {
      if (!rng.chance(0.95 * density)) continue;
      const depth = rng.float(80, 140);
      const setback = 9;
      const nx = -t[1] * side, ny = t[0] * side;
      const cx = p[0] + nx * (setback + depth / 2), cy = p[1] + ny * (setback + depth / 2);
      const plot = rectCorners(cx, cy, plotW - 1.5, depth, ang);
      if (!mask.polyFree(plot, M.ROAD | M.WATER | M.BUILD | M.SETTLE | M.RAIL | M.CITY | M.BALKA)) continue;
      mask.stampPoly(plot, M.SETTLE);
      const yard = { kind: 'plot', poly: plot, fence: rng.chance(0.7) };
      addItem(world.areas, yard);

      // Огород в задней части — грядки полосами
      const gDepth = depth * rng.float(0.35, 0.55);
      const gcx = p[0] + nx * (setback + depth - gDepth / 2), gcy = p[1] + ny * (setback + depth - gDepth / 2);
      addItem(world.areas, {
        kind: 'garden',
        poly: rectCorners(gcx, gcy, plotW - 4, gDepth - 2, ang),
        angle: ang + Math.PI / 2,
        tone: rng.int(0, 2),
      });

      // Дом у улицы
      const house = makeHouse(rng, roofs);
      const hw = Math.min(house.w, plotW - 5), hd = house.h;
      const along = rng.float(-1, 1) * Math.max(0, (plotW - hw) / 2 - 2);
      const hx = p[0] + nx * (setback + 4 + hd / 2) + t[0] * along;
      const hy = p[1] + ny * (setback + 4 + hd / 2) + t[1] * along;
      addBuilding(world, { ...house, x: hx, y: hy, w: hw, h: hd, angle: ang });
      // Двор: колодец, будка, дровник, летняя кухня, туалет в глубине участка
      const yardAt = (dd, lat) => [p[0] + nx * dd + t[0] * lat * plotW, p[1] + ny * dd + t[1] * lat * plotW];
      if (rng.chance(0.45)) { const [x, y] = yardAt(setback + 4 + hd + rng.float(3, 7), rng.float(-0.35, 0.35)); tryBuilding(world, { x, y, w: 1.6, h: 1.6, angle: ang, roof: '#8a8478', style: 'well', height: 1 }); }
      if (rng.chance(0.4)) { const [x, y] = yardAt(setback + 4 + hd + rng.float(2, 6), rng.float(-0.4, 0.4)); tryBuilding(world, { x, y, w: 1.1, h: 1.4, angle: ang, roof: '#6d5a4a', style: 'shed', height: 1 }); }
      if (rng.chance(0.5)) { const [x, y] = yardAt(setback + 4 + hd + rng.float(6, 14), rng.float(-0.4, 0.4)); tryBuilding(world, { x, y, w: 3.2, h: 1.1, angle: ang + (rng.chance(0.5) ? Math.PI / 2 : 0), roof: '#8a6a45', style: 'woodpile', height: 1.4 }); }
      if (rng.chance(0.3)) { const [x, y] = yardAt(setback + 4 + hd + rng.float(8, 16), rng.float(-0.3, 0.3)); const b2 = tryBuilding(world, { x, y, w: rng.float(4, 5.5), h: rng.float(4, 5), angle: ang, roof: rng.pick(['#7e7e79', '#8b4a38']), style: 'shed', height: 3, summer: true }); if (b2) b2.chimney = [1, 0]; }
      { const [x, y] = yardAt(depth * rng.float(0.5, 0.6) + setback, rng.float(-0.35, 0.35)); tryBuilding(world, { x, y, w: 1.3, h: 1.4, angle: ang, roof: '#6a5a48', style: 'shed', height: 2.2 }); }

      // Хозпостройки
      const nOut = rng.int(1, 3);
      for (let k = 0; k < nOut; k++) {
        const ow = rng.float(4, 9), od = rng.float(3.5, 6);
        const dd = setback + 4 + hd + rng.float(4, depth * 0.4);
        const ox = p[0] + nx * dd + t[0] * rng.float(-plotW * 0.3, plotW * 0.3);
        const oy = p[1] + ny * dd + t[1] * rng.float(-plotW * 0.3, plotW * 0.3);
        tryBuilding(world, { x: ox, y: oy, w: ow, h: od, angle: ang + (rng.chance(0.5) ? Math.PI / 2 : 0), roof: rng.pick(['#7a7872', '#6d5a4a', '#8c8a84', '#6a6f72']), style: 'shed', height: 3 });
      }
      // Теплица и машина во дворе
      if (rng.chance(0.3)) {
        const dd = setback + 4 + hd + rng.float(8, depth * 0.5);
        tryBuilding(world, { x: p[0] + nx * dd + t[0] * rng.float(-plotW * 0.25, plotW * 0.25), y: p[1] + ny * dd + t[1] * rng.float(-plotW * 0.25, plotW * 0.25), w: 3, h: rng.float(5, 8), angle: ang, roof: '#dfe6e4', style: 'greenhouse', height: 2.2 });
      }
      if (rng.chance(0.35)) {
        const side2 = along > 0 ? -1 : 1;
        tryBuilding(world, { x: p[0] + nx * (setback + 3) + t[0] * side2 * plotW * 0.3, y: p[1] + ny * (setback + 3) + t[1] * side2 * plotW * 0.3, w: 1.8, h: 4.3, angle: ang, roof: rng.pick(['#8a2f2a', '#d8d6cf', '#2f4f7a', '#3b3b3b', '#6b6f4a', '#a8a39a']), style: 'car', height: 1.5 });
      }
      // Фруктовые деревья
      const nT = rng.int(3, 10);
      for (let k = 0; k < nT; k++) {
        const dd = setback + 10 + hd + rng.float(0, depth - gDepth - hd - 8);
        const x = p[0] + nx * dd + t[0] * rng.float(-plotW * 0.4, plotW * 0.4);
        const y = p[1] + ny * dd + t[1] * rng.float(-plotW * 0.4, plotW * 0.4);
        if (!mask.has(x, y, M.BUILD)) world.trees.add(x, y, rng.float(1.8, 3.4), rng.int(0, 3));
      }
    }
  }
}

// Постройка без наложения на другие здания и дороги
function tryBuilding(world, b) {
  const poly = rectCorners(b.x, b.y, b.w + 0.8, b.h + 0.8, b.angle);
  if (!world.mask.polyFree(poly, M.BUILD | M.ROAD | M.WATER, 1)) return null;
  return addBuilding(world, b);
}

// Разные дома: старая хата, типовой дом, большой новый дом; веранды
// Облик застройки стороны («Война дронов»): Велнария — черепица и кирпич, дома крупнее;
// Кардагор — шифер, профнастил (синий, зелёный), белёные хаты поменьше. null — общий стиль
let curStyle = null;
const STYLE = {
  blue: { types: [['small', 1], ['std', 5], ['big', 4]], roofs: [['#9a4a36', 4], ['#8b3f33', 3], ['#7a3a2c', 2], ['#5f6a5a', 1], ['#6b5a4a', 1.5]], big: ['#9a4a36', '#7d2f2a', '#5a3a30', '#4d5a66'], small: ['#8b4a38', '#96503b'], panel: ['#b3aea3', '#a8a296', '#bdb6aa'] },
  red: { types: [['small', 5], ['std', 4], ['big', 1]], roofs: [['#8a8a84', 4], ['#4d6c8a', 2.5], ['#5a7a5a', 2], ['#7c5a44', 1], ['#9a9890', 2]], big: ['#4d6c8a', '#6f7478', '#5a7a5a'], small: ['#8a8a84', '#7c7c76', '#94918a', '#a8a59c'], panel: ['#8f8d88', '#9a9892', '#85837e'] },
};
export function setBuildStyle(side) { curStyle = side ? STYLE[side] : null; }
function makeHouse(rng, roofs) {
  if (curStyle) roofs = curStyle.roofs;
  const type = rng.weighted(curStyle ? curStyle.types : [['small', 3], ['std', 5], ['big', 2]]);
  const [w, h] = type === 'small' ? [rng.float(8.5, 10.5), rng.float(7.2, 8.5)] : type === 'std' ? [rng.float(10.5, 13), rng.float(8.5, 10.5)] : [rng.float(13, 16), rng.float(10, 12.5)];
  const roof = type === 'big' ? rng.pick(curStyle ? curStyle.big : ['#8b3f33', '#6b3a2e', '#4d5a66', '#6f7478', '#7d2f2a']) : type === 'small' ? rng.pick(curStyle ? curStyle.small : ['#8a8a84', '#7c7c76', '#94918a', '#6f6a60']) : rng.weighted(roofs);
  return {
    w, h, style: 'gable', houseType: type, roof, height: type === 'big' ? 7 : 5,
    veranda: type !== 'big' && rng.chance(0.45) ? rng.float(2.2, 3) : 0,
  };
}

function addBuilding(world, b) {
  b.kind = 'building';
  b.poly = rectCorners(b.x, b.y, b.w, b.h, b.angle);
  addItem(world.buildings, b, (b.height || 4) + 2);
  world.mask.stampPoly(b.poly, M.BUILD);
  return b;
}

// ---------- Ферма (коровники, мехдвор) у края села ----------
function buildFarm(world, rng, v) {
  const { mask } = world;
  const end = v.street[rng.chance(0.5) ? 0 : v.street.length - 1];
  for (let attempt = 0; attempt < 12; attempt++) {
    const a = rng.float(0, Math.PI * 2);
    const r = rng.float(220, 380);
    const cx = end[0] + Math.cos(a) * r, cy = end[1] + Math.sin(a) * r;
    const ang = v.angle + (rng.chance(0.5) ? Math.PI / 2 : 0);
    const yard = rectCorners(cx, cy, 190, 150, ang);
    if (!mask.polyFree(yard, M.ROAD | M.WATER | M.BUILD | M.SETTLE | M.CITY | M.RAIL | M.BALKA)) continue;
    mask.stampPoly(yard, M.SETTLE);
    addItem(world.areas, { kind: 'farmyard', poly: yard });
    const n = rng.int(3, 5);
    const c = Math.cos(ang), s = Math.sin(ang);
    for (let k = 0; k < n; k++) {
      const off = (k - (n - 1) / 2) * 30;
      addBuilding(world, {
        x: cx - s * off, y: cy + c * off, w: rng.float(90, 130), h: 16, angle: ang,
        roof: rng.pick(['#8e8b85', '#7c7a74', '#8a6a52', '#9c9a93']), style: 'barn', height: 7,
        ruined: rng.chance(0.25),
      });
    }
    // Подъездная грунтовка
    addRoad(world, resample([end.slice(), [cx, cy]], 10), 'dirt');
    return;
  }
}

// ---------- Город ----------
// Город «растёт» органически: несколько районов со своей сеткой и поворотом,
// плотность застройки падает от центра, но тянется вдоль дорог и железной дороги.
// Граница получается рваной: частный сектор, пустыри между районами, «языки» вдоль трасс.
function buildCity(world, rng, C, rail, river, extraGrowth = [], sc = 1) {
  const { mask } = world;
  const R = 1100 * sc; // характерный радиус
  // Линии роста — только ближние к городу куски дорог (иначе на большой карте перебор всех дорог)
  const reach = 3200 * sc;
  const growthLines = [];
  for (const L of [...world.roadList.filter((r) => r.type === 'local' || r.type === 'village').map((r) => r.line), rail, ...extraGrowth]) {
    let cur = [];
    for (const p of L) {
      if (Math.hypot(p[0] - C[0], p[1] - C[1]) < reach) cur.push(p);
      else { if (cur.length > 1) growthLines.push(cur); cur = []; }
    }
    if (cur.length > 1) growthLines.push(cur);
  }
  const noiseSeed = rng.int(0, 1e6);
  const density = (p) => {
    const d = Math.hypot(p[0] - C[0], p[1] - C[1]);
    let dens = Math.exp(-((d / R) ** 2));
    let near = Infinity;
    for (const L of growthLines) near = Math.min(near, distToLine(p[0], p[1], L));
    dens += 0.5 * Math.exp(-((near / 170) ** 2)) * Math.exp(-((d / (1700 * sc)) ** 2));
    // Шум рвёт в основном окраины, центр остаётся сплошным
    const edge = 1 - Math.exp(-((d / (R * 0.7)) ** 2));
    dens += (fbm(p[0] / 420, p[1] / 420, noiseSeed, 3) - 0.5) * 0.7 * edge;
    return dens;
  };

  // Районы: центр + 4–6 вокруг, у каждого свой угол сетки и размер кварталов
  const base = rng.float(-0.3, 0.3);
  const districts = [{ x: C[0], y: C[1], phi: base, su: rng.float(115, 140), sv: rng.float(100, 125), core: true }];
  const nD = sc < 0.8 ? rng.int(3, 5) : rng.int(5, 7);
  for (let i = 0; i < nD; i++) {
    const a = (i / nD) * Math.PI * 2 + rng.float(-0.4, 0.4);
    const r = rng.float(560, 1000) * sc;
    districts.push({
      x: C[0] + Math.cos(a) * r, y: C[1] + Math.sin(a) * r * 0.8,
      phi: base + rng.float(-0.6, 0.6), su: rng.float(90, 150), sv: rng.float(70, 120), core: false,
    });
  }
  const owner = (p) => {
    let best = 0, bd = Infinity;
    districts.forEach((d, i) => {
      const dd = Math.hypot(p[0] - d.x, p[1] - d.y) * (d.core ? 0.8 : 1);
      if (dd < bd) { bd = dd; best = i; }
    });
    return best;
  };

  const blocks = [];
  const INSET = 7;
  districts.forEach((dist, di) => {
    const c = Math.cos(dist.phi), s = Math.sin(dist.phi);
    const toW = (u, v) => [dist.x + u * c - v * s, dist.y + u * s + v * c];
    const span = 1900 * sc;
    const us = [], vs = [];
    for (let u = -span; u <= span; u += dist.su * rng.float(0.8, 1.2)) us.push(u);
    for (let v = -span; v <= span; v += dist.sv * rng.float(0.8, 1.2)) vs.push(v);
    const edges = new Map();
    const iMid = us.findIndex((u) => u >= 0), jMid = vs.findIndex((v) => v >= 0);
    for (let i = 0; i + 1 < us.length; i++)
      for (let j = 0; j + 1 < vs.length; j++) {
        const cu = (us[i] + us[i + 1]) / 2, cv = (vs[j] + vs[j + 1]) / 2;
        const center = toW(cu, cv);
        if (owner(center) !== di) continue;
        if (center[0] < 50 || center[1] < 50 || center[0] > world.W - 50 || center[1] > world.H - 50) continue;
        const dens = density(center);
        if (dens < 0.42) continue;
        const u0 = us[i] + INSET, u1 = us[i + 1] - INSET, v0 = vs[j] + INSET, v1 = vs[j + 1] - INSET;
        const corners = [toW(u0, v0), toW(u1, v0), toW(u1, v1), toW(u0, v1)];
        // Старые дороги могут резать квартал наискось — дома сами обойдут полотно
        if (!mask.polyFree(corners, M.WATER | M.RAIL | M.CITY | M.BALKA | M.SETTLE, 8)) continue;
        // Застолбить квартал вместе с окружающими улицами
        mask.stampPoly([toW(us[i] - 6, vs[j] - 6), toW(us[i + 1] + 6, vs[j] - 6), toW(us[i + 1] + 6, vs[j + 1] + 6), toW(us[i] - 6, vs[j + 1] + 6)], M.CITY);
        mask.stampPoly([toW(us[i] - 70, vs[j] - 70), toW(us[i + 1] + 70, vs[j] - 70), toW(us[i + 1] + 70, vs[j + 1] + 70), toW(us[i] - 70, vs[j + 1] + 70)], M.CITYZONE);
        const d = Math.hypot(center[0] - C[0], center[1] - C[1]) / R;
        blocks.push({ u0, u1, v0, v1, toW, phi: dist.phi, center, d, dens, core: dist.core, corners });
        // Улицы по контуру квартала
        const key = (a, b, c2, d2) => `${a},${b},${c2},${d2}`;
        edges.set(key(i, j, i + 1, j), [us[i], vs[j], us[i + 1], vs[j], j === jMid && dist.core]);
        edges.set(key(i, j + 1, i + 1, j + 1), [us[i], vs[j + 1], us[i + 1], vs[j + 1], j + 1 === jMid && dist.core]);
        edges.set(key(i, j, i, j + 1), [us[i], vs[j], us[i], vs[j + 1], i === iMid && dist.core]);
        edges.set(key(i + 1, j, i + 1, j + 1), [us[i + 1], vs[j], us[i + 1], vs[j + 1], i + 1 === iMid && dist.core]);
      }
    for (const [a0, b0, a1, b1, main] of edges.values()) {
      const line = resample([toW(a0, b0), toW(a1, b1)], 8);
      const wet = line.map(([x, y]) => mask.has(x, y, M.WATER));
      // Через реку — только главные улицы центра (мост), и только поперёк
      if (wet.some(Boolean) && !(main && !wet[0] && !wet[wet.length - 1])) {
        // оставим сухие куски улицы
        let run = [];
        for (let k = 0; k < line.length; k++) {
          if (!wet[k]) run.push(line[k]);
          else { if (run.length > 2) addRoad(world, run, 'street'); run = []; }
        }
        if (run.length > 2) addRoad(world, run, 'street');
        continue;
      }
      addRoad(world, line, main ? 'avenue' : 'street');
    }
  });

  // Подложка: пустыри вокруг кварталов (мягкий край) и сами кварталы
  for (const b of blocks) {
    const { toW, u0, u1, v0, v1 } = b;
    const e = 38;
    addItem(world.areas, { kind: 'suburb', poly: [toW(u0 - e, v0 - e), toW(u1 + e, v0 - e), toW(u1 + e, v1 + e), toW(u0 - e, v1 + e)] });
  }
  for (const b of blocks) {
    const { toW, u0, u1, v0, v1 } = b;
    const e = INSET - 1;
    addItem(world.areas, { kind: 'urban', poly: [toW(u0 - e, v0 - e), toW(u1 + e, v0 - e), toW(u1 + e, v1 + e), toW(u0 - e, v1 + e)] });
  }

  // Наполнение кварталов
  const panelRoof = curStyle ? curStyle.panel : ['#a3a19b', '#96948e', '#8a8984', '#b0ada6', '#9d9a92'];
  const privRoofs = [['#8b4a38', 3], ['#7e7e79', 3], ['#6c7f86', 1.5], ['#9a9890', 1.5], ['#5f7a5a', 1]];
  let parkDone = false, stadiumDone = false, elevatorDone = false;
  blocks.sort((a, b) => a.d - b.d);
  for (const blk of blocks) {
    const { d } = blk;
    const railD = distToLine(blk.center[0], blk.center[1], rail);
    if (railD < 220 && !elevatorDone) {
      elevatorDone = buildElevator(world, rng, blk);
      if (elevatorDone) continue;
    }
    if (railD < 280 && rng.chance(0.7)) { buildIndustrial(world, rng, blk); continue; }
    if (!parkDone && d < 0.4 && rng.chance(0.35)) { parkDone = true; buildPark(world, rng, blk); continue; }
    if (!stadiumDone && d > 0.3 && d < 0.8 && rng.chance(0.2)) { stadiumDone = true; buildStadium(world, rng, blk); continue; }
    // Гаражные кооперативы на отшибе
    if (d > 0.7 && rng.chance(0.08)) { buildGarages(world, rng, blk); continue; }
    const panelP = blk.core ? (d < 0.45 ? 1 : d < 0.8 ? 0.55 : 0.1) : (d < 0.6 ? 0.45 : 0.08);
    if (rng.chance(panelP)) buildPanelBlock(world, rng, blk, panelRoof, d);
    else buildPrivateBlock(world, rng, blk, privRoofs);
  }
  buildStation(world, rng, rail, C);
  world.cityBlocks = blocks.length;
}

// ---------- Город («Война дронов»): реалистичная планировка ----------
// Единая сетка магистралей (слегка изогнутая, как у реальных городов), кварталы примыкают друг
// к другу без пустот. По удалению от центра: исторический центр (мелкие кварталы, периметральная
// застройка, площадь со сквером) → микрорайоны (крупные кварталы с 9/5-этажками, башнями, школой,
// дворами и внутриквартальными проездами) → частный сектор (длинные параллельные улицы с участками,
// рваный край города). Вдоль железной дороги — промзона.
function buildCityDW(world, rng, C, rail, river, extraGrowth = [], sc = 1) {
  const { mask } = world;
  const R = 1650 * sc;
  const phi = rng.float(-0.35, 0.35);
  const c = Math.cos(phi), s = Math.sin(phi);
  const ws = rng.int(0, 1e6);
  const warp = (u, v) => [(fbm(u / 1500, v / 1500, ws, 2) - 0.5) * 70, (fbm(u / 1500 + 7.3, v / 1500 + 2.1, ws, 2) - 0.5) * 70];
  const toW = (u, v) => { const [du, dv] = warp(u, v); const uu = u + du, vv = v + dv; return [C[0] + uu * c - vv * s, C[1] + uu * s + vv * c]; };
  const ph = [rng.float(0, 6.28), rng.float(0, 6.28), rng.float(0, 6.28)];
  const rad = (a) => R * (0.86 + 0.12 * Math.sin(2 * a + ph[0]) + 0.09 * Math.sin(3 * a + ph[1]) + 0.06 * Math.sin(5 * a + ph[2]));
  const inside = (u, v, k = 1) => Math.hypot(u, v) < rad(Math.atan2(v, u)) * k;
  const wet = (u, v) => { const [x, y] = toW(u, v); return mask.has(x, y, M.WATER); };
  // Магистральная сетка
  const lines = (step0, step1) => { const a = [0]; for (let x = 0; x < R * 1.25;) { x += rng.float(step0, step1); a.push(x); } for (let x = 0; x > -R * 1.25;) { x -= rng.float(step0, step1); a.unshift(x); } return a; };
  const us = lines(380, 520), vs = lines(340, 470);
  const railL = (u, v) => { const [x, y] = toW(u, v); return distToLine(x, y, rail); };
  // Загородные дороги, проходящие через город, обрезаем у края: внутри города их продолжают улицы
  const toL = (x, y) => [(x - C[0]) * c + (y - C[1]) * s, -(x - C[0]) * s + (y - C[1]) * c];
  const stubs = [];
  for (const r of [...world.roadList]) {
    if (!['highway', 'local', 'village', 'dirt'].includes(r.type)) continue;
    const inn = r.line.map(([x, y]) => { const [uu, vv] = toL(x, y); return inside(uu, vv, 1.02); });
    if (!inn.some(Boolean)) continue;
    const runs = [];
    let cur = [];
    r.line.forEach((p, k) => {
      if (!inn[k]) cur.push(p);
      else { if (cur.length) { runs.push(cur); if (cur.length > 1 || k > 0) stubs.push(cur[cur.length - 1]); } cur = []; }
      if (inn[k] && k + 1 < r.line.length && !inn[k + 1]) stubs.push(r.line[k + 1]);
    });
    if (cur.length) runs.push(cur);
    const keep = runs.filter((q) => q.length > 1);
    r.line = keep[0] || [r.line[0], r.line[0]];
    r._bridges = null;
    for (const q of keep.slice(1)) addRoad(world, q, r.type);
  }
  if (stubs.length || true) {
    // пересчитать маску дорог в районе города (вырезанные куски больше не «дороги»)
    const bb = { x0: C[0] - R * 1.4, y0: C[1] - R * 1.4, x1: C[0] + R * 1.4, y1: C[1] + R * 1.4 };
    mask.clearRect(bb, M.ROAD);
    for (const r of world.roadList) if (r.line.some(([x, y]) => x > bb.x0 - 40 && x < bb.x1 + 40 && y > bb.y0 - 40 && y < bb.y1 + 40)) mask.stampLine(r.line, ROAD_STYLE[r.type].stamp, M.ROAD);
  }
  const cells = [];
  for (let i = 0; i + 1 < us.length; i++)
    for (let j = 0; j + 1 < vs.length; j++) {
      const cu = (us[i] + us[i + 1]) / 2, cv = (vs[j] + vs[j + 1]) / 2;
      if (!inside(cu, cv, 1.08) || wet(cu, cv)) continue;
      const dn = Math.hypot(cu, cv) / R;
      const [x, y] = toW(cu, cv);
      if (mask.has(x, y, M.BUILD | M.RAIL)) continue;
      let type;
      const microP = sc >= 0.9 ? 1.15 - 1.3 * dn : 0.8 - 1.4 * dn;
      if (dn < 0.2) type = 'center';
      else if (railL(cu, cv) < 260 && rng.chance(0.75)) type = 'industry';
      else if (rng.chance(microP)) type = 'micro';
      else type = 'private';
      cells.push({ i, j, u0: us[i], u1: us[i + 1], v0: vs[j], v1: vs[j + 1], cu, cv, dn, type });
    }
  const has = new Set(cells.map((q) => `${q.i},${q.j}`));
  const cellAt = (i, j) => has.has(`${i},${j}`);
  // Улицы по линиям сетки: непрерывные куски там, где рядом есть кварталы
  const mine = [];
  const road = (pts, type) => {
    // через реку идут только проспекты (мост), улицы обрываются у берега
    if (type === 'avenue') {
      let wetRun = 0, maxRun = 0;
      for (const p of pts) { if (mask.has(p[0], p[1], M.WATER)) { wetRun++; maxRun = Math.max(maxRun, wetRun); } else wetRun = 0; }
      if (maxRun * 12 < 240) { mine.push(addRoad(world, pts, type)); return; }
    }
    let run = [];
    for (const p of pts) {
      if (mask.has(p[0], p[1], M.WATER)) { if (run.length > 2) mine.push(addRoad(world, run, type)); run = []; } else run.push(p);
    }
    if (run.length > 2) mine.push(addRoad(world, run, type));
  };
  const seg = (u0, v0, u1, v1, step = 12) => { const L = Math.hypot(u1 - u0, v1 - v0), n = Math.max(2, Math.ceil(L / step)); const out = []; for (let k = 0; k <= n; k++) out.push(toW(u0 + ((u1 - u0) * k) / n, v0 + ((v1 - v0) * k) / n)); return out; };
  // Проспекты продолжаются через реку мостом: разрыв в 1–3 квартала, где линия идёт по воде,
  // а по обе стороны есть город, заполняем (иначе части города на разных берегах не связаны)
  const bridgeFill = (on, wetAt) => {
    for (let a = 0; a < on.length; a++) {
      if (on[a] || !a || !on[a - 1]) continue;
      let b = a;
      while (b < on.length && !on[b]) b++;
      if (b < on.length && b - a <= 3) { let w = false; for (let k = a; k < b; k++) w = w || wetAt(k); if (w) for (let k = a; k < b; k++) on[k] = true; }
      a = b;
    }
  };
  const wetLine = (u0, v0, u1, v1) => { for (let k = 0; k <= 8; k++) if (wet(u0 + ((u1 - u0) * k) / 8, v0 + ((v1 - v0) * k) / 8)) return true; return false; };
  for (let i = 0; i < us.length; i++) {
    const main = us[i] === 0 || Math.abs(us[i]) < R * 0.3;
    const on = []; for (let j = 0; j < vs.length - 1; j++) on.push(cellAt(i - 1, j) || cellAt(i, j));
    if (main) bridgeFill(on, (j) => wetLine(us[i], vs[j], us[i], vs[j + 1]));
    on.push(false);
    let start = null;
    for (let j = 0; j <= vs.length - 1; j++) {
      if (on[j] && start === null) start = j;
      if (!on[j] && start !== null) { road(seg(us[i], vs[start], us[i], vs[j]), main ? 'avenue' : 'street'); start = null; }
    }
  }
  for (let j = 0; j < vs.length; j++) {
    const main = vs[j] === 0 || Math.abs(vs[j]) < R * 0.3;
    const on = []; for (let i = 0; i < us.length - 1; i++) on.push(cellAt(i, j - 1) || cellAt(i, j));
    if (main) bridgeFill(on, (i) => wetLine(us[i], vs[j], us[i + 1], vs[j]));
    on.push(false);
    let start = null;
    for (let i = 0; i <= us.length - 1; i++) {
      if (on[i] && start === null) start = i;
      if (!on[i] && start !== null) { road(seg(us[start], vs[j], us[i], vs[j]), main ? 'avenue' : 'street'); start = null; }
    }
  }
  const mkBlk = (u0, u1, v0, v1, d, core) => {
    const corners = [toW(u0, v0), toW(u1, v0), toW(u1, v1), toW(u0, v1)];
    const center = toW((u0 + u1) / 2, (v0 + v1) / 2);
    return { u0, u1, v0, v1, toW, phi, center, d, core, corners };
  };
  const E = 9; // отступ застройки от оси улицы
  const blocks = [];
  const panelRoof = curStyle ? curStyle.panel : ['#a3a19b', '#96948e', '#8a8984', '#b0ada6', '#9d9a92'];
  const privRoofs = curStyle ? curStyle.roofs : [['#8b4a38', 3], ['#7e7e79', 3], ['#6c7f86', 1.5], ['#9a9890', 1.5], ['#5f7a5a', 1]];
  let squareDone = false, stadiumDone = false, elevatorDone = false;
  cells.sort((a, b) => a.dn - b.dn);
  for (const q of cells) {
    const { u0, u1, v0, v1 } = q;
    // застолбить квартал (поля и посадки сюда не заходят)
    mask.stampPoly([toW(u0, v0), toW(u1, v0), toW(u1, v1), toW(u0, v1)], M.CITY);
    mask.stampPoly([toW(u0 - 80, v0 - 80), toW(u1 + 80, v0 - 80), toW(u1 + 80, v1 + 80), toW(u0 - 80, v1 + 80)], M.CITYZONE);
    if (q.type === 'center') {
      // мелкие кварталы 3×3 со своими улицами; в центральном — площадь со сквером
      const nu = 3, nv = 3;
      const du = (u1 - u0) / nu, dv = (v1 - v0) / nv;
      for (let k = 1; k < nu; k++) road(seg(u0 + du * k, v0, u0 + du * k, v1), 'street');
      for (let k = 1; k < nv; k++) road(seg(u0, v0 + dv * k, u1, v0 + dv * k), 'street');
      for (let a = 0; a < nu; a++) for (let b = 0; b < nv; b++) {
        const blk = mkBlk(u0 + du * a + E, u0 + du * (a + 1) - E, v0 + dv * b + E, v0 + dv * (b + 1) - E, q.dn * 0.5, true);
        addItem(world.areas, { kind: 'urban', poly: blk.corners });
        if (!squareDone && a === 1 && b === 1 && q.dn < 0.12) {
          squareDone = true;
          addItem(world.areas, { kind: 'square', poly: blk.corners });
          const inner = mkBlk(blk.u0 + 18, blk.u1 - 18, blk.v0 + 18, blk.v1 - 18, 0, true);
          buildPark(world, rng, inner);
          blockBuild(world, blk, (blk.u0 + blk.u1) / 2, blk.v0 + 9, (blk.u1 - blk.u0) * 0.6, 16, { roof: '#9a958a', style: 'flat', height: 18 }); // администрация
          continue;
        }
        buildPanelBlock(world, rng, blk, panelRoof, q.dn * 0.5);
      }
    } else if (q.type === 'micro') {
      const blk = mkBlk(u0 + E, u1 - E, v0 + E, v1 - E, q.dn, false);
      addItem(world.areas, { kind: 'yard', poly: blk.corners });
      buildMicro(world, rng, blk, panelRoof, q.dn);
      if (!stadiumDone && q.dn > 0.3 && rng.chance(0.3)) stadiumDone = true;
    } else if (q.type === 'industry') {
      // промзона: участки ~120 м с проездами, на каждом — цех, склад, гаражи или элеватор
      const nu = Math.max(2, Math.round((u1 - u0) / 125)), nv = Math.max(2, Math.round((v1 - v0) / 110));
      const du = (u1 - u0) / nu, dv = (v1 - v0) / nv;
      addItem(world.areas, { kind: 'industrial', poly: mkBlk(u0 + E, u1 - E, v0 + E, v1 - E, q.dn, false).corners });
      for (let k = 1; k < nu; k++) addItem(world.areas, { kind: 'drive', line: [toW(u0 + du * k, v0 + E), toW(u0 + du * k, v1 - E)], width: 8 }, 5);
      for (let k = 1; k < nv; k++) addItem(world.areas, { kind: 'drive', line: [toW(u0 + E, v0 + dv * k), toW(u1 - E, v0 + dv * k)], width: 8 }, 5);
      for (let a = 0; a < nu; a++) for (let b = 0; b < nv; b++) {
        const blk = mkBlk(u0 + du * a + (a ? 6 : E), u0 + du * (a + 1) - (a < nu - 1 ? 6 : E), v0 + dv * b + (b ? 6 : E), v0 + dv * (b + 1) - (b < nv - 1 ? 6 : E), q.dn, false);
        if (!elevatorDone && railL(q.cu, q.cv) < 200 && rng.chance(0.3)) { elevatorDone = buildElevator(world, rng, blk); if (elevatorDone) continue; }
        if (rng.chance(0.2)) buildGarages(world, rng, blk); else buildIndustrial(world, rng, blk);
      }
    } else {
      // частный сектор: параллельные улицы вдоль длинной стороны, по обе стороны — участки
      const alongU = u1 - u0 >= v1 - v0;
      const [a0, a1, b0, b1] = alongU ? [u0, u1, v0, v1] : [v0, v1, u0, u1];
      const P = (a, b) => (alongU ? [a, b] : [b, a]);
      const nL = Math.max(1, Math.round((b1 - b0) / 70));
      const step = (b1 - b0) / (nL + 1);
      const lanes = [];
      for (let k = 1; k <= nL; k++) lanes.push(b0 + step * k);
      const bounds = [b0, ...lanes, b1];
      // улица только в пределах города (рваный край)
      const span = (b) => { let lo = null, hi = null; for (let a = a0; a <= a1; a += 10) { const [uu, vv] = P(a, b); if (inside(uu, vv) && !wet(uu, vv)) { if (lo === null) lo = a; hi = a; } } return lo === null ? null : [lo, hi]; };
      for (const b of lanes) { const sp = span(b); if (sp && sp[1] - sp[0] > 60) road(seg(...P(sp[0], b), ...P(sp[1], b)), 'village'); }
      for (let k = 0; k + 1 < bounds.length; k++) {
        const bm = (bounds[k] + bounds[k + 1]) / 2;
        const sp = span(bm);
        if (!sp || sp[1] - sp[0] < 50) continue;
        const lo = Math.max(a0 + E, sp[0]), hi = Math.min(a1 - E, sp[1]);
        const [pu0, pv0] = P(lo, bounds[k] + (k === 0 ? E : 5)), [pu1, pv1] = P(hi, bounds[k + 1] - (k + 1 === bounds.length - 1 ? E : 5));
        const blk = mkBlk(Math.min(pu0, pu1), Math.max(pu0, pu1), Math.min(pv0, pv1), Math.max(pv0, pv1), q.dn, false);
        if (!alongU) { blk.phi = phi + Math.PI / 2; blk.toW = (uu, vv) => toW(vv, uu); [blk.u0, blk.u1, blk.v0, blk.v1] = [pv0 < pv1 ? pv0 : pv1, pv0 < pv1 ? pv1 : pv0, pu0 < pu1 ? pu0 : pu1, pu0 < pu1 ? pu1 : pu0]; }
        buildPrivateBlock(world, rng, blk, privRoofs);
      }
    }
    blocks.push(q);
  }
  // Улицы без домов вдоль (краевые клетки, куда застройка не дошла) убираем — не бывает «рамок»
  // из улиц вокруг пустыря. Проспекты оставляем: они связывают город и идут по мостам
  const served = ([x, y]) => { for (const b of world.buildings.query({ x0: x - 60, y0: y - 60, x1: x + 60, y1: y + 60 })) if (Math.hypot(b.x - x, b.y - y) < 40 + Math.max(b.w || 0, b.h || 0) / 2) return true; return false; };
  const drop = new Set();
  for (const r of mine) {
    const pts = resample(r.line, 10);
    const ok = pts.map(served);
    // короткие разрывы (перекрёсток, сквер) не рвут улицу
    for (let i = 0; i < ok.length; i++) if (!ok[i]) { let j = i; while (j < ok.length && !ok[j]) j++; if (i > 0 && j < ok.length && j - i <= 6) for (let k = i; k < j; k++) ok[k] = true; i = j; }
    if (ok.every(Boolean)) continue;
    if (r.type === 'avenue') {
      // проспект не рвём (он идёт по мостам и связывает районы), но концы за последней застройкой
      // срезаем — иначе он уходит в поле тупиком
      const i0 = ok.indexOf(true), i1 = ok.lastIndexOf(true);
      if (i0 < 0 || (i0 === 0 && i1 === ok.length - 1) || i1 - i0 < 2) continue;
      drop.add(r);
      addRoad(world, pts.slice(Math.max(0, i0 - 1), Math.min(pts.length, i1 + 2)), 'avenue');
      continue;
    }
    drop.add(r);
    let run = [];
    for (let i = 0; i <= pts.length; i++) {
      if (i < pts.length && ok[i]) run.push(pts[i]);
      else { if (run.length >= 6) addRoad(world, run, r.type); run = []; }
    }
  }
  if (drop.size) {
    world.roadList = world.roadList.filter((r) => !drop.has(r));
    const old = world.roads;
    world.roads = new SpatialIndex(world.W, world.H, old.cell);
    for (const r of old.items) if (!drop.has(r)) world.roads.insert(r);
    const bb = { x0: C[0] - R * 1.4, y0: C[1] - R * 1.4, x1: C[0] + R * 1.4, y1: C[1] + R * 1.4 };
    mask.clearRect(bb, M.ROAD);
    for (const r of world.roadList) if (r.line.some(([x, y]) => x > bb.x0 - 40 && x < bb.x1 + 40 && y > bb.y0 - 40 && y < bb.y1 + 40)) mask.stampLine(r.line, ROAD_STYLE[r.type].stamp, M.ROAD);
  }
  // обрезанные загородные дороги примыкают к ближайшей городской улице
  const streetPts = [];
  for (const r of world.roadList) if ((r.type === 'street' || r.type === 'avenue' || r.type === 'village') && r.line.some(([x, y]) => Math.hypot(x - C[0], y - C[1]) < R * 1.4)) for (const p of r.line) streetPts.push(p);
  for (const e of stubs) {
    let best = null, bd = 320;
    for (const p of streetPts) { const d = Math.hypot(p[0] - e[0], p[1] - e[1]); if (d < bd && d > 1) { bd = d; best = p; } }
    if (best) addRoad(world, resample([e, best.slice()], 8), 'local');
  }
  buildStation(world, rng, rail, C);
  world.cityBlocks = (world.cityBlocks || 0) + blocks.length;
}

// Микрорайон: 9-этажки по периметру, внутри — ряды 5-этажек, пара башен, школа и детсад,
// внутриквартальные проезды, деревья во дворах
function buildMicro(world, rng, blk, roofs, d) {
  const { u0, u1, v0, v1 } = blk;
  const W = u1 - u0, H = v1 - v0;
  const roof = () => rng.pick(roofs);
  const drive = (a, b) => addItem(world.areas, { kind: 'drive', line: [blk.toW(...a), blk.toW(...b)], width: 5 }, 4);
  // кольцевой проезд
  const m = 24;
  drive([u0 + m, v0 + m], [u1 - m, v0 + m]); drive([u1 - m, v0 + m], [u1 - m, v1 - m]); drive([u1 - m, v1 - m], [u0 + m, v1 - m]); drive([u0 + m, v1 - m], [u0 + m, v0 + m]);
  const tall = d < 0.55 ? 9 : 5;
  // периметр: секции с разрывами-проездами
  const edgeRow = (along, fixed, len, vertical) => {
    let a = along[0] + 12;
    while (a < along[1] - 40) {
      const L = Math.min(rng.float(55, 120), along[1] - 12 - a);
      if (L < 35) break;
      const cu = a + L / 2;
      if (vertical) blockBuild(world, blk, fixed, cu, 13, L, { roof: roof(), style: 'flat', height: tall * 3 });
      else blockBuild(world, blk, cu, fixed, L, 13, { roof: roof(), style: 'flat', height: tall * 3 });
      a += L + rng.float(18, 30);
    }
    void len;
  };
  edgeRow([u0, u1], v0 + 10, W, false);
  edgeRow([u0, u1], v1 - 10, W, false);
  edgeRow([v0 + 30, v1 - 30], u0 + 10, H, true);
  edgeRow([v0 + 30, v1 - 30], u1 - 10, H, true);
  // внутренние ряды: вдоль или «гребёнкой» поперёк, между ними дворы с деревьями и парковками
  const comb = rng.chance(0.4);
  if (!comb) {
    for (let v = v0 + 62; v < v1 - 60; v += rng.float(46, 56)) {
      let a = u0 + 44;
      while (a < u1 - 80) {
        const L = rng.float(60, 110);
        if (a + L > u1 - 44) break;
        if (rng.chance(0.92)) blockBuild(world, blk, a + L / 2, v, L, 12, { roof: roof(), style: 'flat', height: tall === 9 && rng.chance(0.5) ? 27 : 15 });
        a += L + rng.float(18, 32);
      }
      const [px, py] = blk.toW((u0 + u1) / 2, v + 22);
      addItem(world.areas, { kind: 'drive', line: [blk.toW(u0 + 40, v + 22), blk.toW(u1 - 40, v + 22)], width: 7 }, 4); void px; void py;
      for (let k = 0; k < 16; k++) { const [tx, ty] = blk.toW(rng.float(u0 + 30, u1 - 30), v + 12 + rng.float(-4, 4)); if (!world.mask.has(tx, ty, M.BUILD | M.ROAD)) world.trees.add(tx, ty, rng.float(2.5, 4.5), rng.int(0, 3)); }
    }
  } else {
    for (let u = u0 + 60; u < u1 - 60; u += rng.float(44, 54)) {
      let b = v0 + 44;
      while (b < v1 - 80) {
        const L = rng.float(60, 100);
        if (b + L > v1 - 44) break;
        if (rng.chance(0.92)) blockBuild(world, blk, u, b + L / 2, 12, L, { roof: roof(), style: 'flat', height: tall * 3 });
        b += L + rng.float(18, 30);
      }
      for (let k = 0; k < 14; k++) { const [tx, ty] = blk.toW(u + 20 + rng.float(-4, 4), rng.float(v0 + 30, v1 - 30)); if (!world.mask.has(tx, ty, M.BUILD | M.ROAD)) world.trees.add(tx, ty, rng.float(2.5, 4.5), rng.int(0, 3)); }
    }
  }
  // башни 16 этажей
  for (let k = 0; k < (d < 0.4 ? 2 : 1); k++) blockBuild(world, blk, rng.float(u0 + 60, u1 - 60), rng.float(v0 + 60, v1 - 60), 24, 24, { roof: roof(), style: 'flat', height: 48 });
  // школа (буквой П) и детсад у восточного края
  const su = u1 - 70, sv = (v0 + v1) / 2;
  if (blockBuild(world, blk, su, sv, 70, 16, { roof: '#8a8a84', style: 'flat', height: 10 })) {
    blockBuild(world, blk, su - 28, sv + 24, 14, 30, { roof: '#8a8a84', style: 'flat', height: 10 });
    blockBuild(world, blk, su + 28, sv + 24, 14, 30, { roof: '#8a8a84', style: 'flat', height: 10 });
    const [px, py] = blk.toW(su, sv - 45);
    addItem(world.areas, { kind: 'pitch', poly: rectCorners(px, py, 60, 34, blk.phi) });
  }
  blockBuild(world, blk, u0 + 70, (v0 + v1) / 2, 36, 22, { roof: '#9a7a62', style: 'flat', height: 6 });
}

function buildGarages(world, rng, blk) {
  const { u0, u1, v0, v1 } = blk;
  addItem(world.areas, { kind: 'industrial', poly: blk.corners });
  const rows = Math.floor((v1 - v0) / 16);
  for (let r = 0; r < rows; r++) {
    const v = v0 + 8 + r * 16;
    for (let u = u0 + 3; u < u1 - 3; u += 3.6)
      blockBuild(world, blk, u, v, 3.4, 6, { roof: rng.pick(['#6a6964', '#5d5c58', '#7d6452', '#6b6f73']), style: 'shed', height: 2.5 });
  }
}

function blockBuild(world, blk, u, v, w, h, props) {
  const [x, y] = blk.toW(u, v);
  const poly = rectCorners(x, y, w, h, blk.phi + (props.rot || 0));
  if (!world.mask.polyFree(poly, M.ROAD | M.WATER | M.RAIL | M.BUILD, 4)) return null;
  if (hitsBuilding(world, rectCorners(x, y, w + 6, h + 6, blk.phi + (props.rot || 0)))) return null;
  return addBuilding(world, { ...props, x, y, w, h, angle: blk.phi + (props.rot || 0) });
}

// Точная проверка пересечения с уже поставленными зданиями (маска 9 м пропускает узкие корпуса под углом)
function hitsBuilding(world, poly) {
  const bb = bboxOf(poly, 0);
  for (const o of world.buildings.query(bb)) if (convexOverlap(poly, o.poly)) return true;
  return false;
}
function convexOverlap(A, B) {
  for (const P of [A, B])
    for (let i = 0; i < P.length; i++) {
      const p = P[i], q = P[(i + 1) % P.length];
      const nx = q[1] - p[1], ny = p[0] - q[0];
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [x, y] of A) { const d = x * nx + y * ny; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
      for (const [x, y] of B) { const d = x * nx + y * ny; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
      if (a1 <= b0 || b1 <= a0) return false;
    }
  return true;
}

function buildPanelBlock(world, rng, blk, roofs, d) {
  const { u0, u1, v0, v1 } = blk;
  addItem(world.areas, { kind: 'yard', poly: [blk.toW(u0, v0), blk.toW(u1, v0), blk.toW(u1, v1), blk.toW(u0, v1)] });
  const tall = d < 0.25 ? 9 : 5;
  const depth = tall === 9 ? 13 : 12;
  const bw = u1 - u0, bh = v1 - v0;
  // Дома вдоль краёв квартала — «коробка» со двором
  const layout = rng.int(0, 2);
  const roof = () => rng.pick(roofs);
  const edgeU = (v, len) => blockBuild(world, blk, (u0 + u1) / 2 + rng.float(-5, 5), v, len, depth, { roof: roof(), style: 'flat', height: tall * 3 });
  const edgeV = (u, len) => blockBuild(world, blk, u, (v0 + v1) / 2 + rng.float(-5, 5), depth, len, { roof: roof(), style: 'flat', height: tall * 3 });
  if (layout === 0) {
    edgeU(v0 + depth / 2 + 2, bw * rng.float(0.6, 0.85));
    edgeU(v1 - depth / 2 - 2, bw * rng.float(0.6, 0.85));
  } else if (layout === 1) {
    edgeV(u0 + depth / 2 + 2, bh * rng.float(0.6, 0.85));
    edgeV(u1 - depth / 2 - 2, bh * rng.float(0.6, 0.85));
    edgeU(v0 + depth / 2 + 2, bw * 0.45);
  } else {
    // Точечные башни
    const n = rng.int(2, 4);
    for (let k = 0; k < n; k++)
      blockBuild(world, blk, rng.float(u0 + 14, u1 - 14), rng.float(v0 + 14, v1 - 14), 18, 18, { roof: roof(), style: 'flat', height: 30 });
  }
  // Школа / садик в каждом третьем квартале
  if (rng.chance(0.3)) {
    blockBuild(world, blk, (u0 + u1) / 2, (v0 + v1) / 2, 40, 14, { roof: '#b8b2a4', style: 'flat', height: 9 });
  }
  // Гаражи
  if (rng.chance(0.4)) {
    const n = rng.int(5, 12);
    const gu = rng.float(u0 + 20, u1 - 20 - n * 3.5);
    for (let k = 0; k < n; k++)
      blockBuild(world, blk, gu + k * 3.6, (v0 + v1) / 2 + rng.float(-10, 10), 3.4, 6, { roof: rng.pick(['#6a6964', '#5d5c58', '#7d6452']), style: 'shed', height: 2.5 });
  }
  // Деревья во дворе
  const nT = rng.int(8, 22);
  for (let k = 0; k < nT; k++) {
    const [x, y] = blk.toW(rng.float(u0 + 4, u1 - 4), rng.float(v0 + 4, v1 - 4));
    if (!world.mask.has(x, y, M.BUILD | M.ROAD)) world.trees.add(x, y, rng.float(2.5, 5), rng.int(0, 3));
  }
}

function buildPrivateBlock(world, rng, blk, roofs) {
  const { u0, u1, v0, v1 } = blk;
  const bw = u1 - u0;
  const n = Math.max(2, Math.floor(bw / rng.float(24, 32)));
  const pw = bw / n;
  const pd = (v1 - v0) / 2;
  for (const half of [0, 1]) {
    for (let k = 0; k < n; k++) {
      const cu = u0 + pw * (k + 0.5);
      const cv = half === 0 ? v0 + pd / 2 : v1 - pd / 2;
      const [x, y] = blk.toW(cu, cv);
      const plot = rectCorners(x, y, pw - 1, pd - 1, blk.phi);
      addItem(world.areas, { kind: 'plot', poly: plot, fence: rng.chance(0.8) });
      // Огород у задней границы
      const gv = half === 0 ? v0 + pd * 0.8 : v1 - pd * 0.8;
      const [gx, gy] = blk.toW(cu, gv);
      addItem(world.areas, { kind: 'garden', poly: rectCorners(gx, gy, pw - 4, pd * 0.35, blk.phi), angle: blk.phi + Math.PI / 2, tone: rng.int(0, 2) });
      const hv = half === 0 ? v0 + 9 : v1 - 9;
      {
        const house = makeHouse(rng, roofs);
        const hw2 = Math.min(house.w, pw - 4);
        blockBuild(world, blk, cu + rng.float(-1, 1) * Math.max(0, (pw - hw2) / 2 - 1.5), half === 0 ? v0 + 3 + house.h / 2 : v1 - 3 - house.h / 2, hw2, house.h, house);
      }
      if (rng.chance(0.7))
        blockBuild(world, blk, cu + rng.float(-5, 5), half === 0 ? v0 + pd * 0.5 : v1 - pd * 0.5, rng.float(4, 7), rng.float(3.5, 5), { roof: rng.pick(['#7a7872', '#6d5a4a']), style: 'shed', height: 3 });
      const nT = rng.int(1, 4);
      for (let t = 0; t < nT; t++) {
        const [tx, ty] = blk.toW(cu + rng.float(-pw / 2 + 2, pw / 2 - 2), half === 0 ? rng.float(v0 + 18, v0 + pd * 0.6) : rng.float(v1 - pd * 0.6, v1 - 18));
        if (!world.mask.has(tx, ty, M.BUILD)) world.trees.add(tx, ty, rng.float(1.8, 3.2), rng.int(0, 3));
      }
    }
  }
}

function buildIndustrial(world, rng, blk) {
  const { u0, u1, v0, v1 } = blk;
  addItem(world.areas, { kind: 'industrial', poly: [blk.toW(u0, v0), blk.toW(u1, v0), blk.toW(u1, v1), blk.toW(u0, v1)] });
  const n = rng.int(2, 4);
  for (let k = 0; k < n; k++) {
    const w = rng.float(30, 80), h = rng.float(18, 40);
    blockBuild(world, blk, rng.float(u0 + w / 2 + 3, Math.max(u0 + w / 2 + 4, u1 - w / 2 - 3)), rng.float(v0 + h / 2 + 3, Math.max(v0 + h / 2 + 4, v1 - h / 2 - 3)), w, h,
      { roof: rng.pick(['#8f8d88', '#7b7974', '#8b6448', '#6f7b80', '#a09d96']), style: 'hangar', height: 9, ruined: rng.chance(0.15) });
  }
  // Складированный хлам, контейнеры
  const nc = rng.int(3, 10);
  for (let k = 0; k < nc; k++)
    blockBuild(world, blk, rng.float(u0 + 5, u1 - 5), rng.float(v0 + 5, v1 - 5), 6, 2.4, { roof: rng.pick(['#8a3b2e', '#2f5a7a', '#6b6b2e', '#9a9a95']), style: 'flat', height: 2.5, rot: rng.chance(0.5) ? Math.PI / 2 : 0 });
}

function buildElevator(world, rng, blk) {
  const { u0, u1, v0, v1 } = blk;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  addItem(world.areas, { kind: 'industrial', poly: [blk.toW(u0, v0), blk.toW(u1, v0), blk.toW(u1, v1), blk.toW(u0, v1)] });
  const n = 6;
  const siloR = 5.5;
  const pts = [];
  for (let row = 0; row < 2; row++)
    for (let k = 0; k < n; k++) {
      const [x, y] = blk.toW(cu - (n - 1) * siloR + k * siloR * 2, cv + (row - 0.5) * siloR * 2);
      pts.push([x, y]);
    }
  const box = pts.map(([x, y]) => [x, y]);
  if (!world.mask.polyFree(bboxPoly(box, siloR), M.ROAD | M.WATER | M.RAIL | M.BUILD, 4)) return false;
  for (const [x, y] of pts) {
    const silo = { kind: 'building', style: 'silo', x, y, r: siloR, roof: '#c9c6bd', height: 30, poly: rectCorners(x, y, siloR * 2, siloR * 2, 0) };
    addItem(world.buildings, silo, 34);
    world.mask.stampDisc(x, y, siloR, M.BUILD);
  }
  blockBuild(world, blk, cu + n * siloR + 6, cv, 10, 14, { roof: '#bdb9ae', style: 'flat', height: 45 });
  blockBuild(world, blk, cu, cv + siloR * 2 + 12, 60, 14, { roof: '#8f8d88', style: 'hangar', height: 8 });
  return true;
}

function bboxPoly(pts, pad) {
  const b = bboxOf(pts, pad);
  return [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];
}

function buildPark(world, rng, blk) {
  const { u0, u1, v0, v1 } = blk;
  addItem(world.areas, { kind: 'park', poly: [blk.toW(u0, v0), blk.toW(u1, v0), blk.toW(u1, v1), blk.toW(u0, v1)] });
  // Аллеи крест-накрест
  addItem(world.areas, { kind: 'path', line: [blk.toW(u0, v0), blk.toW(u1, v1)], width: 3 }, 3);
  addItem(world.areas, { kind: 'path', line: [blk.toW(u1, v0), blk.toW(u0, v1)], width: 3 }, 3);
  const nT = rng.int(60, 120);
  for (let k = 0; k < nT; k++) {
    const u = rng.float(u0 + 3, u1 - 3), v = rng.float(v0 + 3, v1 - 3);
    const [x, y] = blk.toW(u, v);
    const du = (u - u0) / (u1 - u0), dv = (v - v0) / (v1 - v0);
    if (Math.abs(du - dv) < 0.05 || Math.abs(du + dv - 1) < 0.05) continue;
    world.trees.add(x, y, rng.float(2.5, 5.5), rng.int(0, 3));
  }
}

function buildStadium(world, rng, blk) {
  const { u0, u1, v0, v1 } = blk;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  const [x, y] = blk.toW(cu, cv);
  addItem(world.areas, { kind: 'stadium', x, y, angle: blk.phi, poly: rectCorners(x, y, 105, 70, blk.phi) });
}

function buildStation(world, rng, rail, C) {
  // Ближайшая к центру точка ж/д — вокзал и платформы
  let bi = 0, bd = Infinity;
  rail.forEach((p, i) => {
    const d = dist(p, C);
    if (d < bd) { bd = d; bi = i; }
  });
  const tg = tangents(rail)[bi];
  const ang = Math.atan2(tg[1], tg[0]);
  const p = rail[bi];
  // Станционные пути
  const lo = Math.max(0, bi - 30), hi = Math.min(rail.length, bi + 30);
  for (const off of [-9, 9, 15]) {
    const side = offsetLine(rail.slice(lo, hi), off);
    addItem(world.rails, { kind: 'rail', line: side, width: 5, siding: true }, 8);
    world.mask.stampLine(side, 8, M.RAIL);
  }
  addItem(world.areas, { kind: 'platform', poly: rectCorners(p[0] - tg[1] * 4.5, p[1] + tg[0] * 4.5, 180, 4, ang) });
  const bx = p[0] - tg[1] * 26, by = p[1] + tg[0] * 26;
  addBuilding(world, { x: bx, y: by, w: 55, h: 16, angle: ang, roof: '#7d5a4a', style: 'gable', height: 10 });
}

// ---------- Следы войны ----------
// ---------- Линия фронта «Войны дронов» ----------
// Серая зона (изрытая воронками полоса, выгоревшая трава), по две линии окопов с каждой стороны,
// ряды противотанковых «зубов драконов», на дорогах — КПП с бетонными блоками и шлагбаумом
function buildFrontDW(world, rng, fx) {
  const { W, H, mask } = world;
  const ph = rng.float(0, 6.28);
  const lineX = (y, off) => fx + off + Math.sin(y / 2700 + ph) * 180 + Math.sin(y / 900 + ph * 2) * 45;
  const along = (off, step = 120) => { const pts = []; for (let y = 150; y <= H - 150; y += step) pts.push([lineX(y, off), y]); return pts; };
  // серая зона
  const zl = along(-650, 400), zr = along(650, 400).reverse();
  addItem(world.areas, { kind: 'frontzone', poly: [...zl, ...zr], x: fx, y: H / 2 }, 20);
  for (let y = 200; y < H - 200; y += rng.float(90, 170)) {
    const x = lineX(y, rng.gauss(0, 260));
    addCraterCluster(world, rng, x, y, rng.int(5, 16), rng.float(25, 70), rng.float(0, 1));
    if (rng.chance(0.18)) addBurn(world, rng, x + rng.float(-80, 80), y, rng.float(40, 140));
  }
  // окопы: для каждой стороны — передний край (±450 м) и вторая линия (±1100 м)
  const NO = M.WATER | M.CITY | M.SETTLE | M.BUILD | M.RAIL;
  for (const [side, dir] of [['blue', -1], ['red', 1]]) {
    const enemy = [-dir, 0];
    for (const off of [450, 1100]) {
      const pts = along(dir * off, 160);
      let run = [];
      const flush = () => { if (run.length >= 2) digTrench(world, rng, run, side, enemy); run = []; };
      for (const p of pts) { if (mask.near(p[0], p[1], 25, NO)) flush(); else run.push(p); }
      flush();
      addItem(world.areas, { kind: 'frontline', line: pts, side, x: pts[0][0], y: H / 2 }, 30);
    }
    // «зубы драконов» перед первой линией
    const teeth = along(dir * 300, 200).filter((p) => !mask.near(p[0], p[1], 20, NO | M.ROAD));
    for (let i = 1; i < teeth.length; i++) if (rng.chance(0.75)) addItem(world.areas, { kind: 'teeth', line: [teeth[i - 1], teeth[i]], x: teeth[i][0], y: teeth[i][1] }, 12);
  }
  // КПП на дорогах, пересекающих фронт: по одному с каждой стороны серой зоны
  const kpp = [];
  for (const r of world.roadList) {
    if (r.type === 'street' || r.type === 'village' || r.type === 'dirt') continue;
    for (let i = 1; i < r.line.length; i++) {
      const a = r.line[i - 1], b = r.line[i];
      for (const dir of [-1, 1]) {
        const x0 = lineX(a[1], dir * 820);
        if ((a[0] - x0) * (b[0] - x0) > 0 || a[0] === b[0]) continue;
        const t = (x0 - a[0]) / (b[0] - a[0]), y = a[1] + (b[1] - a[1]) * t;
        if (kpp.some((k) => Math.hypot(k.x - x0, k.y - y) < 300)) continue;
        const k = { kind: 'kpp', pts: [[x0, y]], x: x0, y, angle: Math.atan2(b[1] - a[1], b[0] - a[0]), side: dir < 0 ? 'blue' : 'red', w: r.width || 8 };
        kpp.push(k);
        addItem(world.areas, k, 40);
      }
    }
  }
  world.front = { fx, ph, kpp };
}
function seedWarScars(world, rng, cx) {
  // Условная «серая зона» — полоса посередине между городами
  for (let k = 0; k < 14; k++) {
    const x = cx + rng.gauss(0, 350);
    const y = rng.float(300, world.H - 300);
    addCraterCluster(world, rng, x, y, rng.int(4, 18), rng.float(20, 60));
    if (rng.chance(0.4)) addBurn(world, rng, x + rng.float(-60, 60), y + rng.float(-60, 60), rng.float(30, 110));
  }
  return cx;
}

// age: 0 — свежая, 1 — старая, заросшая травой
export function addCraterCluster(world, rng, x, y, n, spread, age = 0) {
  const added = [];
  for (let i = 0; i < n; i++) {
    const r = rng.chance(0.15) ? rng.float(4, 7) : rng.float(1.2, 3.5);
    const c = { kind: 'crater', x: x + rng.gauss(0, spread), y: y + rng.gauss(0, spread), r, seed: rng.int(0, 1e9), age: age * rng.float(0.5, 1) };
    c.pts = [[c.x, c.y]];
    addItem(world.scars, c, r * 2.6);
    added.push(c);
  }
  return added;
}

export function addBurn(world, rng, x, y, size) {
  const poly = blob(x, y, size, size * rng.float(0.5, 0.9), rng.float(0, 3.14), rng, 28, 0.4);
  const b = { kind: 'burn', poly, x, y };
  addItem(world.scars, b, 4);
  return b;
}

// Планировки, вид крыш и дорожки от крыльца к улице
function finishBuildings(world, rng, interiors = true) {
  for (const b of world.buildings.items) {
    b.interior = interiors ? generateInterior(b, world, rng) : null; // в «Войне дронов» планировки не нужны
    const house = b.style === 'gable' && b.w * b.h < 200;
    if (house) {
      b.hip = rng.chance(0.5);
      if (rng.chance(0.75)) b.chimney = [rng.float(-0.3, 0.3) * b.w, rng.float(-0.2, 0.2) * b.h];
    }
    if (!b.interior || !(house || b.style === 'flat')) continue;
    for (const d of b.interior.doors) {
      if (!d.ext) continue;
      const [x0, y0] = d.p;
      let end = null;
      for (let r = 1.5; r < 30; r += 1) {
        const x = x0 + d.n[0] * r, y = y0 + d.n[1] * r;
        if (world.mask.has(x, y, M.ROAD)) { end = [x, y]; break; }
        if (world.mask.has(x, y, M.WATER)) break;
      }
      if (end) addItem(world.areas, { kind: 'path', line: [[x0 + d.n[0] * 0.8, y0 + d.n[1] * 0.8], end], width: b.style === 'flat' ? 2.2 : 1.2 }, 2);
      if (house) break;
    }
  }
}

// Пересчитать маску крон в прямоугольнике (после того как деревья сломаны)
export function refreshCanopy(world, b) {
  world.mask.clearRect(b, M.CANOPY);
  world.trees.forEach({ x0: b.x0 - 6, y0: b.y0 - 6, x1: b.x1 + 6, y1: b.y1 + 6 }, (arr, i) => {
    const r = arr[i + 2];
    if (r < 1.6 || arr[i + 3] >= 4) return; // кусты, обугленные и сухие стволы обзор не закрывают
    world.mask.stampDisc(arr[i], arr[i + 1], r * 0.8, M.CANOPY);
  });
}
