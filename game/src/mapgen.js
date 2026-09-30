// Процедурная генерация карты: степь, поля с лесополосами, река, балка,
// трасса, железная дорога, город и сёла. Всё детерминировано по seed.

import { Rng, fbm } from './rng.js';
import {
  bboxOf, catmullRom, resample, offsetLine, tangents, pointInPoly,
  distToLine, rectCorners, blob, dist,
} from './geom.js';
import { SpatialIndex, PointBins, Mask, M } from './spatial.js';
import { buildFortifications } from './forts.js';
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
function infraLayout(kind, L = 0) {
  const c = (k, u, v, w, h, extra = {}) => ({ k, u, v, w, h, ...extra });
  switch (kind) {
    case 'tpp': return { w: 440, h: 320, comps: [
      c('unit', -100, -40, 96, 58, { n: 'Энергоблок №1' }), c('unit', 0, -40, 96, 58, { n: 'Энергоблок №2' }), c('unit', 100, -40, 96, 58, { n: 'Энергоблок №3' }),
      c('chimney', -55, 30, 18, 18, { n: 'Дымовая труба №1' }), c('chimney', 55, 30, 18, 18, { n: 'Дымовая труба №2' }),
      c('tower', -150, 110, 76, 76, { n: 'Градирня №1' }), c('tower', -55, 120, 76, 76, { n: 'Градирня №2' }), c('tower', 40, 120, 76, 76, { n: 'Градирня №3' }),
      c('gsu', -100, -92, 14, 9, { n: 'Блочный трансформатор №1' }), c('gsu', 0, -92, 14, 9, { n: 'Блочный трансформатор №2' }), c('gsu', 100, -92, 14, 9, { n: 'Блочный трансформатор №3' }),
      c('oru', 160, -110, 110, 70, { n: 'ОРУ-330 кВ' }), c('coal', 165, 90, 100, 110, { n: 'Угольный склад' }), c('ctrl', -180, -110, 32, 20, { n: 'Главный щит управления' }),
    ] };
    case 'ps330': return { w: 250, h: 180, comps: [
      c('at', -60, 0, 15, 10, { n: 'АТ-1 330/110 кВ' }), c('at', 0, 0, 15, 10, { n: 'АТ-2 330/110 кВ' }), c('at', 60, 0, 15, 10, { n: 'АТ-3 330/110 кВ' }),
      c('oru', 0, -58, 210, 42, { n: 'ОРУ-330 кВ' }), c('oru', 0, 58, 210, 42, { n: 'ОРУ-110 кВ' }), c('ctrl', 104, 0, 24, 14, { n: 'ОПУ' }),
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
      c('oru', 80, 5, 56, 80, { n: 'ОРУ-330 кВ' }), c('ctrl', 40, 40, 26, 16, { n: 'Щит управления ГЭС' }),
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
    blue: { dir: -1, rear: 0, cities: [{ c: J(W * 0.13, H * 0.5, 400, 800), sc: 1 }, { c: J(W * 0.31, H * 0.24, 600, 600), sc: 0.62 }, { c: J(W * 0.3, H * 0.77, 600, 600), sc: 0.62 }] },
    red: { dir: 1, rear: W, cities: [{ c: J(W * 0.87, H * 0.5, 400, 800), sc: 1 }, { c: J(W * 0.69, H * 0.25, 600, 600), sc: 0.62 }, { c: J(W * 0.7, H * 0.76, 600, 600), sc: 0.62 }] },
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
  for (const S of Object.values(sides)) {
    const [cap, cN, cS] = S.cities;
    growth.get(cN).push(wobblyRoad(rng, cN.c, cap.c.slice(), 5));
    growth.get(cS).push(wobblyRoad(rng, cS.c, cap.c.slice(), 5));
    growth.get(cN).push(wobblyRoad(rng, cN.c, [W / 2 - S.dir * 400, cN.c[1] + rng.float(-600, 600)], 4));
    growth.get(cS).push(wobblyRoad(rng, cS.c, [W / 2 - S.dir * 400, cS.c[1] + rng.float(-600, 600)], 4));
  }
  for (const v of villages) {
    let best = null, bd = Infinity;
    for (const ct of allC) { const d = Math.hypot(ct.c[0] - v.c[0], ct.c[1] - v.c[1]); if (d < bd) { bd = d; best = ct; } }
    if (bd < 6000) growth.get(best).push(wobblyRoad(rng, v.c, best.c.slice(), 4));
    else addRoad(world, wobblyRoad(rng, v.c, nearestPoint(highway, v.c), 4), 'local');
  }
  for (const v of villages) addRoad(world, v.street, 'village');

  // Городские мосты столиц
  for (const S of Object.values(sides)) {
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
    S.cities.forEach((ct, i) => buildCity(world, rng, ct.c, i === 2 ? S.branch : S.rail, S.river, growth.get(ct), ct.sc));
  }
  setBuildStyle(null);
  for (const lines of growth.values()) for (const line of lines) connectToCity(world, line);
  for (const v of villages) { setBuildStyle(v.side); buildVillageStreet(world, rng, v.street, 0.9); if (rng.chance(0.5)) buildFarm(world, rng, v); }
  setBuildStyle(null);

  // ---------- Объекты инфраструктуры ----------
  const FORBID = M.WATER | M.BUILD | M.ROAD | M.RAIL | M.CITY | M.SETTLE | M.BALKA | M.VILLAGE | M.CITYZONE;
  let nextId = 1;
  // Площадка объекта с прилегающей территорией (выкошенная полоса, подъезд, забор): не в посадке,
  // не на дороге и не впритык к другим объектам
  const place = (side, kind, name, x, y, opts = {}) => {
    const lay = infraLayout(kind, opts.L);
    const angle = opts.angle ?? rng.float(-0.4, 0.4);
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
    const site = addItem(world.areas, { kind: 'dwsite', poly, apron, site: kind, x: o.x, y: o.y, angle, w: lay.w + 16, h: lay.h + 16, pad, fp: lay.comps.map((c) => [c.u, c.v, c.w, c.h, c.k]) });
    // Подъездная дорога: от ворот (сторона, обращённая к дороге) к ближайшей дороге так, чтобы
    // не пройти сквозь чужие площадки, дома и воду; перебираем несколько точек примыкания
    const gates = [0, Math.PI / 2, Math.PI, -Math.PI / 2].map((q) => {
      const ext = (q === 0 || q === Math.PI ? lay.w / 2 : lay.h / 2) + 8;
      return { q, p: [at[0] + Math.cos(angle + q) * ext, at[1] + Math.sin(angle + q) * ext] };
    });
    const cands = [];
    for (const r of world.roadList) {
      if (r.type === 'street' || r.type === 'dirt') continue;
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
      const line = L < 200 ? resample([g.p, c.p], 8) : wobblyRoad(rng, g.p, c.p, 3);
      if (!clear(line)) continue;
      addRoad(world, line, opts.paved ? 'local' : 'dirt');
      o.gate = g.p; o.gateQ = g.q; done = true;
      break;
    }
    if (!done) {
      // запасной вариант: прямой отрезок от любых ворот к любой точке, лишь бы не сквозь площадки
      outer: for (const c of cands.slice(0, 200)) for (const g of gates) {
        const line = resample([g.p, c.p], 8);
        if (clear(line)) { addRoad(world, line, opts.paved ? 'local' : 'dirt'); o.gate = g.p; o.gateQ = g.q; done = true; break outer; }
      }
      if (!done) { o.gate = gates[1].p; o.gateQ = gates[1].q; }
    }
    site.gateQ = o.gateQ;
    world.infra.push(o);
    return o;
  };
  const lines = [];
  // Конец ЛЭП — портал ОРУ нужного напряжения, со стороны, обращённой к другому концу
  const portal = (o, kv, toward) => {
    if (!o.comps) return [o.x, o.y];
    const orus = o.comps.filter((q) => q.k === 'oru');
    const oru = orus.find((q) => q.n.includes(String(kv))) || orus[0];
    if (!oru) return [o.x, o.y];
    const c = Math.cos(o.angle), s = Math.sin(o.angle);
    const lx = (toward[0] - o.x) * c + (toward[1] - o.y) * s - oru.u, ly = -(toward[0] - o.x) * s + (toward[1] - o.y) * c - oru.v;
    const [u, v] = Math.abs(lx) / oru.w > Math.abs(ly) / oru.h ? [oru.u + Math.sign(lx) * oru.w / 2, oru.v] : [oru.u, oru.v + Math.sign(ly) * oru.h / 2];
    return [o.x + u * c - v * s, o.y + u * s + v * c];
  };
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
    pyl[0].portal = true; pyl[pyl.length - 1].portal = !!b.comps;
    lines.push({ id: lines.length + 1, kv, a: a.id ?? null, b: b.id ?? null, pylons: pyl, side: a.side });
  };
  for (const [side, S] of Object.entries(sides)) {
    const [cap, cN, cS] = S.cities.map((ct) => ct.c);
    const rearX = S.rear;
    const nm = DW_NAMES[side].cities;
    const tpp = place(side, 'tpp', DW_NAMES[side].tpp, (cap[0] + rearX) / 2 + rng.float(-300, 300), H * 0.22 + rng.float(-600, 600), { angle: rng.float(-0.2, 0.2), paved: true });
    const psA = place(side, 'ps330', `ПС 330 кВ «${nm[0]}»`, cap[0] - S.dir * 2200, cap[1] - 1200 + rng.float(-300, 300));
    const psB = place(side, 'ps330', 'ПС 330 кВ «Центральная»', (cap[0] + cN[0] + cS[0]) / 3 + S.dir * 600, H * 0.5 + rng.float(-900, 900));
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
    place(side, 'ammo', 'Арсенал', (cap[0] + rearX) / 2, H * 0.8 + rng.float(-600, 600));
    place(side, 'factory', `Завод БПЛА «${side === 'blue' ? 'Сокол' : 'Беркут'}»`, cN[0] + S.dir * 1500, cN[1] - 900);
    place(side, 'launch', 'Стартовая позиция «Север»', W / 2 + S.dir * W * 0.2 + rng.float(-800, 800), H * 0.1 + rng.float(-300, 500));
    place(side, 'launch', 'Стартовая позиция «Юг»', W / 2 + S.dir * W * 0.2 + rng.float(-800, 800), H * 0.9 + rng.float(-500, 300));
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
    for (const v of villages) if (v.side === side) place(side, 'store', `Магазин, ${v.name}`, v.c[0], v.c[1], { forbid: cityForbid, step: 20, extra: { settlement: v.name, village: true } });
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
    ...allC.map((ct) => ({ x: ct.c[0], y: ct.c[1], r: 3300 * ct.sc })),
    ...allC.map((ct) => { const a = rng.float(0, 6.28); return { x: ct.c[0] + Math.cos(a) * 2600 * ct.sc, y: ct.c[1] + Math.sin(a) * 2600 * ct.sc, r: 1900 * ct.sc }; }),
    ...villages.map((v) => ({ x: v.c[0], y: v.c[1], r: rng.float(1100, 2000) })),
  ];
  for (let i = 0; i < 18; i++) massifs.push({ x: rng.float(1500, W - 1500), y: rng.float(1500, H - 1500), r: rng.float(700, 1300) }); // хутора и агрофирмы в степи
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
  finishBuildings(world, new Rng((seed ^ 0x1e7) >>> 0), false);
  buildPowerGridDW(world, new Rng((seed ^ 0x9092) >>> 0));
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
};

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
function connectToCity(world, line) {
  const { mask } = world;
  let cut = line.findIndex(([x, y]) => mask.has(x, y, M.CITY));
  if (cut < 0) { addRoad(world, line, 'local'); return; }
  cut = Math.max(1, cut - 1);
  const trimmed = line.slice(0, cut + 1);
  const end = trimmed[trimmed.length - 1];
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
    if (ok) { trimmed.push(c.slice()); break; }
  }
  addRoad(world, resample(trimmed, 10), 'local');
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

// ---------- Поля «Войны дронов» ----------
// Массив полей вокруг села/города: у каждого свой разворот; полосы разной ширины, в полосе — поля
// разной длины вразбежку (как нарезаны паи), краевые поля подрезаны по неровному контуру массива.
// Лесополосы — только по части длинных границ. Между массивами — степь с пятнами залежи.
function buildFieldsDW(world, rng, massifs) {
  const { mask, W, H } = world;
  const avoid = M.SETTLE | M.CITY | M.CITYZONE | M.WATER | M.BALKA | M.VILLAGE | M.BUILD | M.RAIL;
  const G = 40, gw = Math.ceil(W / G), gh = Math.ceil(H / G);
  const taken = new Uint8Array(gw * gh);
  const cell = (x, y) => { const i = Math.floor(x / G), j = Math.floor(y / G); return i < 0 || j < 0 || i >= gw || j >= gh ? -1 : j * gw + i; };
  const busy = (x, y) => { const k = cell(x, y); return k < 0 || taken[k] === 1; };
  const take = (poly) => {
    const bb = bboxOf(poly, 0);
    for (let y = Math.floor(bb.y0 / G) * G + G / 2; y < bb.y1; y += G)
      for (let x = Math.floor(bb.x0 / G) * G + G / 2; x < bb.x1; x += G) if (pointInPoly(x, y, poly)) { const k = cell(x, y); if (k >= 0) taken[k] = 1; }
  };
  const crops = [['wheat', 4], ['stubble', 4], ['sunflower', 3], ['plowed', 1.6], ['harrowed', 1.4], ['corn', 1.5], ['fallow', 1.2], ['meadow', 0.6]];
  let nFields = 0;
  for (const m of massifs) {
    const th = rng.float(-0.7, 0.7) + (rng.chance(0.5) ? Math.PI / 2 : 0);
    const c = Math.cos(th), s = Math.sin(th);
    const toW = (u, v) => [m.x + u * c - v * s, m.y + u * s + v * c];
    const ph = [rng.float(0, 6.28), rng.float(0, 6.28), rng.float(0, 6.28)];
    const rad = (a) => m.r * (0.8 + 0.14 * Math.sin(a * 2 + ph[0]) + 0.1 * Math.sin(a * 3 + ph[1]) + 0.06 * Math.sin(a * 5 + ph[2]));
    const inside = (x, y) => Math.hypot(x - m.x, y - m.y) < rad(Math.atan2(y - m.y, x - m.x));
    const R = m.r * 1.15;
    let v = -R + rng.float(0, 200);
    let prevCrop = null;
    while (v < R) {
      const sw = rng.float(260, 720);
      let u = -R - rng.float(0, 700);
      while (u < R) {
        const fl = rng.float(420, 1500);
        const u0 = u + 9, u1 = u + fl - 9, v0 = v + 9, v1 = v + sw - 9;
        u += fl + (rng.chance(0.2) ? rng.float(15, 50) : 0);
        const cen = toW((u0 + u1) / 2, (v0 + v1) / 2);
        if (!inside(cen[0], cen[1]) || busy(cen[0], cen[1])) continue;
        // Поле, возможно, разрезанное пополам, если частично заходит на запретное
        const tryPart = (a0, a1, b0, b1, depth) => {
          // края массива — неровные: поле укорачивается вдоль длинной стороны до контура
          const ok2 = (a) => { const p = toW(a, b0), q = toW(a, b1); return inside(p[0], p[1]) && inside(q[0], q[1]); };
          const along = a1 - a0 >= b1 - b0;
          if (along) {
            if (!ok2(a0)) { let lo = a0, hi = (a0 + a1) / 2; if (!ok2(hi)) return; for (let k = 0; k < 7; k++) { const m = (lo + hi) / 2; if (ok2(m)) hi = m; else lo = m; } a0 = hi; }
            if (!ok2(a1)) { let lo = (a0 + a1) / 2, hi = a1; if (!ok2(lo)) return; for (let k = 0; k < 7; k++) { const m = (lo + hi) / 2; if (ok2(m)) lo = m; else hi = m; } a1 = lo; }
            if (a1 - a0 < 220) return;
          }
          const poly = [toW(a0, b0), toW(a1, b0), toW(a1, b1), toW(a0, b1)];
          if (!along && poly.some((p) => !inside(p[0], p[1]))) return;
          let bad = false;
          for (let i = 0; i <= 4 && !bad; i++) for (let j = 0; j <= 4 && !bad; j++) {
            const x = poly[0][0] + (poly[1][0] - poly[0][0]) * (i / 4) + (poly[3][0] - poly[0][0]) * (j / 4);
            const y = poly[0][1] + (poly[1][1] - poly[0][1]) * (i / 4) + (poly[3][1] - poly[0][1]) * (j / 4);
            if (mask.has(x, y, avoid) || busy(x, y)) bad = true;
          }
          if (bad) {
            if (depth > 1) return;
            if (a1 - a0 > b1 - b0) { const mid = (a0 + a1) / 2; tryPart(a0, mid - 6, b0, b1, depth + 1); tryPart(mid + 6, a1, b0, b1, depth + 1); }
            else { const mid = (b0 + b1) / 2; tryPart(a0, a1, b0, mid - 6, depth + 1); tryPart(a0, a1, mid + 6, b1, depth + 1); }
            return;
          }
          let area = 0;
          for (let i = 0; i < 4; i++) { const p = poly[i], q = poly[(i + 1) % 4]; area += p[0] * q[1] - q[0] * p[1]; }
          if (Math.abs(area) / 2 < 40000) return;
          const crop = prevCrop && rng.chance(0.3) ? prevCrop : rng.weighted(crops);
          prevCrop = crop;
          const field = { kind: 'field', poly, crop, angle: (a1 - a0 > b1 - b0 ? th : th + Math.PI / 2) + (rng.chance(0.12) ? Math.PI / 2 : 0), seed: rng.int(0, 1e9), patches: [] };
          for (let k = rng.int(0, 3); k > 0; k--) {
            const q = toW(rng.float(a0, a1), rng.float(b0, b1));
            field.patches.push({ x: q[0], y: q[1], rx: rng.float(30, 120), ry: rng.float(20, 70), a: rng.float(0, 3.14), dark: rng.chance(0.6) });
          }
          addItem(world.fields, field, 0);
          take(poly);
          nFields++;
        };
        tryPart(u0, u1, v0, v1, 0);
      }
      // Лесополоса по длинной границе полосы — не везде
      if (rng.chance(0.38)) {
        const bw = rng.float(12, 20);
        let run = [];
        const flush = () => { if (run.length >= 3) segsBelt(world, rng, run[0], run[run.length - 1], avoid, bw); run = []; };
        for (let uu = -R; uu <= R; uu += 90) {
          const p = toW(uu, v);
          if (inside(p[0], p[1]) && !mask.has(p[0], p[1], avoid)) run.push(p); else flush();
        }
        flush();
      }
      v += sw;
    }
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
  const rows = Math.max(3, Math.floor((bw - 5) / 3.1));
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
      if (!rng.chance(0.75)) continue;
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
  return addBuilding(world, { ...props, x, y, w, h, angle: blk.phi + (props.rot || 0) });
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
