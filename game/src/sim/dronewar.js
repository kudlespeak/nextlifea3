// Режим «Война дронов». Наземных войск нет: стороны бьют по тылу друг друга ударными БПЛА
// и защищают свою инфраструктуру расстановкой ПВО, РЭБ, постов обнаружения и перехватчиков.
//
// Энергосистема каждой стороны считается как поток мощности по графу:
//   ТЭС (энергоблоки → блочные трансформаторы → ОРУ-330) и импорт по межсистемной ЛЭП
//   → ЛЭП 330 кВ → ПС 330/110 (автотрансформаторы АТ, ОРУ-330, ОРУ-110)
//   → ЛЭП 110 кВ → ПС 110/10 (трансформаторы Т-1/Т-2, ОРУ) → районы городов.
// Максимальный поток (Эдмондс—Карп) даёт мощность, дошедшую до каждой ПС 110; при дефиците —
// графики отключений (часть районов гаснет), при резкой потере генерации — срабатывает АЧР.
// Очки дают промышленность (от света), торговля (магазины, АЗС) и транзит фур; тратятся на дроны,
// ПВО, ремонт, укрытия и сетки. Партия короткая (15–40 мин) и идёт по фазам эскалации.
// У каждой стороны — «устойчивость тыла» (0–100): падает от отключений, разрушений, пожаров,
// обрушенных мостов и пустых магазинов, растёт, когда всё работает. Директивы штаба дают цель
// с премией. Проигрывает сторона, чья устойчивость упала до нуля (или энергосистема рухнула без
// средств на ремонт); по истечении времени побеждает более устойчивый тыл.

import { DW_NAMES } from '../mapgen.js';
import { daylight } from '../power.js';
import { M } from '../spatial.js';
import { DWLogistics, VEH } from './dwlogi.js';
import { DWEconomy } from './dwecon.js';
import { DWState } from './dwstate.js';
import { DWInfra } from './dwinfra.js';
import { DWResearch } from './dwres.js';

// ---------------------------------------------------------------- Дроны
export const DW_DRONES = {
  // Кардагор
  shahed: { side: 'red', cls: 'strike', name: 'Герань-2 (Шахед-136)', short: 'Герань-2', speed: 51, alt: [200, 1400], wh: 50, cep: 8, ew: 0.8, rcs: 0.5, noise: 1, cost: 16, desc: 'Барражирующий боеприпас большой дальности, 50 кг, спутниковая навигация с антенной «Комета» — устойчив к РЭБ' },
  geran3: { side: 'red', cls: 'strike', name: 'Герань-3 (реактивный)', short: 'Герань-3', speed: 100, alt: [1500, 3000], wh: 50, cep: 8, ew: 0.8, rcs: 0.6, noise: 0.35, cost: 55, desc: 'Реактивный — вдвое быстрее, пулемёты и перехватчики почти бессильны' },
  gerbera: { side: 'red', cls: 'decoy', name: 'Гербера (ложная цель)', short: 'Гербера', speed: 45, alt: [200, 1400], wh: 0, cep: 30, ew: 0.5, rcs: 0.5, noise: 0.8, cost: 5, desc: 'Дешёвая ложная цель: на радаре не отличить от «Герани», отвлекает ПВО и расходует ракеты' },
  lancet: { side: 'red', cls: 'loiter', name: 'Ланцет-3', short: 'Ланцет', speed: 30, alt: [300, 800], wh: 3, cep: 1.5, ew: 0.35, rcs: 0.15, noise: 0.3, cost: 10, range: 22000, desc: 'Барражирующий боеприпас по разведанной цели (ПВО, РЛС, РЭБ). Нужна разведка' },
  orlan: { side: 'red', cls: 'recon', name: 'Орлан-10', short: 'Орлан', speed: 28, alt: [800, 1500], wh: 0, ew: 0.45, rcs: 0.3, noise: 0.7, cost: 8, endurance: 1000, spot: 1600, desc: 'Разведчик: находит позиции ПВО противника (день — камера, ночью — тепловизор)' },
  geran_h: { side: 'red', cls: 'hunter', name: 'Герань-2 «Охотник» (камера и ИИ)', short: 'Герань-охотник', speed: 51, alt: [150, 600], wh: 50, cep: 3, ew: 0.85, rcs: 0.5, noise: 1, cost: 26, endurance: 2400, spot: 900, desc: 'Сам патрулирует дороги в заданном районе и по камере с ИИ находит фуры, бензовозы, грузовики снабжения — бьёт без оператора. РЭБ почти не мешает' },
  molniya: { side: 'red', cls: 'hunter', front: true, name: 'Молния-2 (охотник)', short: 'Молния', speed: 33, alt: [100, 400], wh: 6, cep: 2, ew: 0.6, rcs: 0.12, noise: 0.5, cost: 8, endurance: 1400, spot: 600, range: 22000, desc: 'Дешёвое самолётное «крыло» с передовых позиций: охотится на машины на дорогах ближе к фронту' },
  elka: { side: 'red', cls: 'interceptor', name: 'Перехватчик «Ёлка»', short: 'Ёлка', speed: 80, alt: [0, 3000], wh: 0.5, ew: 0.6, rcs: 0.1, noise: 0.2, cost: 3, desc: 'Дрон-перехватчик' },
  // Велнария
  fp1: { side: 'blue', cls: 'strike', name: 'FP-1', short: 'FP-1', speed: 45, alt: [200, 1500], wh: 60, cep: 10, ew: 0.65, rcs: 0.45, noise: 1, cost: 15, desc: 'Дальнобойный ударный БПЛА, 60 кг' },
  fp2: { side: 'blue', cls: 'strike', name: 'FP-2', short: 'FP-2', speed: 55, alt: [300, 1200], wh: 105, cep: 7, ew: 0.7, rcs: 0.55, noise: 1, cost: 34, desc: 'Тяжёлый ударный БПЛА, 105 кг — рушит пролёты мостов и цеха' },
  lyutyi: { side: 'blue', cls: 'strike', name: 'Лютый', short: 'Лютый', speed: 55, alt: [500, 1800], wh: 75, cep: 6, ew: 0.75, rcs: 0.6, noise: 1, cost: 25, desc: 'Точный ударный БПЛА самолётного типа, 75 кг' },
  bober: { side: 'blue', cls: 'strike', name: 'Бобёр', short: 'Бобёр', speed: 50, alt: [150, 600], wh: 20, cep: 5, ew: 0.7, rcs: 0.35, noise: 0.9, cost: 9, desc: 'Малый и дешёвый ударный БПЛА, 20 кг — по трансформаторам и пусковым' },
  warmate: { side: 'blue', cls: 'loiter', name: 'Warmate', short: 'Warmate', speed: 28, alt: [300, 800], wh: 1.4, cep: 1.5, ew: 0.35, rcs: 0.12, noise: 0.3, cost: 9, range: 20000, desc: 'Барражирующий боеприпас по разведанной цели (ПВО, РЛС, РЭБ)' },
  leleka: { side: 'blue', cls: 'recon', name: 'Лелека-100', short: 'Лелека', speed: 27, alt: [700, 1400], wh: 0, ew: 0.45, rcs: 0.25, noise: 0.6, cost: 7, endurance: 1000, spot: 1600, desc: 'Разведчик: находит позиции ПВО противника' },
  saker: { side: 'blue', cls: 'hunter', name: 'Сакер-ИИ (охотник)', short: 'Сакер', speed: 45, alt: [150, 500], wh: 20, cep: 2.5, ew: 0.85, rcs: 0.3, noise: 0.8, cost: 20, endurance: 2400, spot: 850, desc: 'Автономный охотник с машинным зрением: патрулирует дороги в районе и сам атакует фуры, бензовозы и грузовики снабжения' },
  grif: { side: 'blue', cls: 'decoy', name: 'Гриф-Д (ложная цель)', short: 'Гриф-Д', speed: 45, alt: [200, 1300], wh: 0, cep: 30, ew: 0.5, rcs: 0.45, noise: 0.8, cost: 5, desc: 'Дешёвая ложная цель: на радаре похожа на ударный БПЛА, отвлекает ПВО' },
  sting: { side: 'blue', cls: 'interceptor', name: 'Перехватчик «Стинг»', short: 'Стинг', speed: 88, alt: [0, 3000], wh: 0.5, ew: 0.6, rcs: 0.1, noise: 0.2, cost: 3, desc: 'Дрон-перехватчик' },
};
export const dronesOf = (side) => Object.entries(DW_DRONES).filter(([, d]) => d.side === side && d.cls !== 'interceptor').map(([k]) => k);

// ---------------------------------------------------------------- ПВО и службы
export const DW_AD = {
  mog: { cost: 28, name: { blue: 'Мобильная огневая группа', red: 'Мобильная огневая группа' }, sub: { blue: 'пикап, 12,7 мм, прожектор, тепловизор', red: 'пикап, «Корд», прожектор' }, range: 1600, maxAlt: 1500, mobile: 16, deploy: 20, radar: 0, visual: 1700, ammo: 90, desc: 'Дёшево и эффективно против «Шахедов» на малой высоте. Лучше работает по наводке постов и РЛС' },
  spaag: { cost: 150, name: { blue: 'ЗСУ «Гепард»', red: 'ЗРПК «Панцирь-С1»' }, sub: { blue: '2×35 мм, радар', red: '2×30 мм + ракеты' }, range: 3800, maxAlt: 3500, mobile: 12, deploy: 45, radar: 7000, ammo: 150, missiles: { blue: 0, red: 8 }, mRange: 9000, mCost: 7, desc: 'Радиолокационная зенитная артиллерия: сбивает и реактивные цели' },
  sam: { cost: 320, name: { blue: 'ЗРК IRIS-T SLM', red: 'ЗРК «Бук-М2»' }, sub: { blue: '8 ракет, 12 км', red: '8 ракет, 12 км' }, range: 12000, maxAlt: 20000, mobile: 9, deploy: 120, radar: 16000, missiles: 8, mCost: 16, desc: 'Ракеты по всему, что видит радар: 1 ракета = 16 очков. Ложные цели съедают боезапас' },
  ew: { cost: 55, name: { blue: 'РЭБ «Буковель-АД»', red: 'РЭБ «Поле-21»' }, sub: { blue: 'подавление ГНСС, 3,5 км', red: 'подавление ГНСС, 3,5 км' }, range: 3500, mobile: 0, deploy: 40, desc: 'Сбивает спутниковую навигацию: дроны промахиваются, часть падает. Устойчивые антенны («Комета») держатся дольше' },
  acoustic: { cost: 6, name: { blue: 'Акустический пост «Небесная крепость»', red: 'Акустический пост' }, sub: { blue: 'микрофоны, 3 км', red: 'микрофоны, 3 км' }, range: 3000, mobile: 0, deploy: 10, desc: 'Слышит низколетящие винтовые дроны и наводит мобильные группы' },
  radar: { cost: 90, name: { blue: 'РЛС «Малахит»', red: 'РЛС «Каста-2Е2»' }, sub: { blue: 'обнаружение 16 км', red: 'обнаружение 16 км' }, range: 16000, mobile: 7, deploy: 60, radar: 16000, desc: 'Видит цели далеко, но хуже — на малой высоте' },
  ewd: { cost: 180, name: { blue: 'Купол РЭБ «Лима»', red: 'Купол РЭБ «Красуха»' }, sub: { blue: 'стационарный, подавление ГНСС 6 км', red: 'стационарный, подавление ГНСС 6 км' }, range: 6000, mobile: 0, deploy: 120, desc: 'Стационарный купол над промзоной или городом: большой радиус, но дорогое содержание (1,2 оч/мин)' },
  icpt: { cost: 45, name: { blue: 'Расчёт перехватчиков «Стинг»', red: 'Расчёт перехватчиков «Ёлка»' }, sub: { blue: '8 перехватчиков, 9 км', red: '8 перехватчиков, 9 км' }, range: 9000, maxAlt: 3000, mobile: 14, deploy: 30, stock: 8, desc: 'Дроны-перехватчики: 3 очка за штуку, хороши против «Шахедов», бессильны против реактивных' },
};

// ---------------------------------------------------------------- Узлы объектов
export const COMP = {
  unit: { name: 'энергоблок', cost: 220, time: 600, fire: 0.5, hard: 1.6 },
  gsu: { name: 'блочный трансформатор', cost: 140, time: 420, fire: 0.75, spare: true, hard: 0.8, shelter: true },
  at: { name: 'автотрансформатор', cost: 130, time: 420, fire: 0.75, spare: true, hard: 0.8, shelter: true },
  tr: { name: 'трансформатор', cost: 45, time: 180, fire: 0.65, hard: 0.8, shelter: true },
  oru: { name: 'ОРУ', cost: 40, time: 150, fire: 0.1, hard: 0.7, big: true },
  ctrl: { name: 'щит управления', cost: 25, time: 120, fire: 0.4, hard: 1 },
  chimney: { name: 'дымовая труба', cost: 60, time: 300, hard: 2.5 },
  tower: { name: 'градирня', cost: 70, time: 300, hard: 2.5 },
  coal: { name: 'угольный склад', cost: 30, time: 120, fire: 0.6, hard: 1.2, big: true },
  span: { name: 'пролёт моста', cost: 170, time: 720, hard: 2.2, net: true },
  tank: { name: 'резервуар', cost: 45, time: 200, fire: 0.9, hard: 0.9 },
  pump: { name: 'насосная', cost: 30, time: 120, fire: 0.5, hard: 1 },
  rack: { name: 'эстакада', cost: 20, time: 90, fire: 0.5, hard: 1 },
  bunker: { name: 'хранилище боеприпасов', cost: 50, time: 240, fire: 0.3, detonate: true, hard: 1.3, shelter: true },
  store: { name: 'склад', cost: 35, time: 150, fire: 0.5, hard: 1 },
  shop: { name: 'цех', cost: 90, time: 360, fire: 0.6, hard: 1.4, big: true },
  launcher: { name: 'пусковая', cost: 40, time: 150, fire: 0.3, hard: 0.7 },
  hall: { name: 'складской корпус', cost: 60, time: 240, fire: 0.6, hard: 1.3, big: true },
  canopy: { name: 'навес', cost: 20, time: 90, fire: 0.2, hard: 1 },
  mall: { name: 'торговый зал', cost: 70, time: 300, fire: 0.6, hard: 1.2, big: true },
  kiosk: { name: 'магазин', cost: 10, time: 60, fire: 0.5, hard: 0.8 },
  garage: { name: 'гараж', cost: 40, time: 200, fire: 0.5, hard: 1.2 },
  fcanopy: { name: 'навес с колонками', cost: 30, time: 120, fire: 0.8, hard: 0.9 },
  hgen: { name: 'гидроагрегат', cost: 160, time: 480, fire: 0.3, hard: 2.2 }, // в машзале под бетоном
  wt: { name: 'ветроустановка', cost: 45, time: 240, fire: 0.5, hard: 0.7 },
  pv: { name: 'поле солнечных панелей', cost: 35, time: 180, fire: 0.1, hard: 0.6, big: true },
  inv: { name: 'инверторная станция', cost: 30, time: 150, fire: 0.5, hard: 0.8 },
  silo: { name: 'силосный корпус', cost: 80, time: 360, fire: 0.7, hard: 1.6, big: true }, // зерновая пыль и зерно горят долго
  dryer: { name: 'зерносушилка', cost: 45, time: 200, fire: 0.8, hard: 0.9 },
  house: { name: 'корпус', cost: 60, time: 300, fire: 0.5, hard: 1.4, big: true },
  barn: { name: 'коровник', cost: 30, time: 150, fire: 0.6, hard: 0.9, big: true },
  bess: { name: 'контейнеры АКБ', cost: 90, time: 240, fire: 0.9, hard: 0.7 },
  pont: { name: 'понтоны', cost: 40, time: 150, fire: 0, hard: 0.8 },
  wtower: { name: 'водонапорная башня', cost: 40, time: 180, fire: 0, hard: 1.2 },
  headframe: { name: 'копёр', cost: 90, time: 360, fire: 0.2, hard: 1.8 },
};
// Потеря узла бьёт по устойчивости тыла (разрушен — полностью, выведен из строя — наполовину)
const SHOCK = { silo: 0.8, dryer: 0.3, hgen: 2, wt: 0.3, pv: 0.3, inv: 0.4, unit: 2, at: 2, gsu: 1.5, span: 1.5, tr: 1, oru: 1, shop: 1, tank: 0.6, bunker: 0.6, hall: 0.6, chimney: 0.6, tower: 0.6, coal: 0.5, launcher: 0.3, ctrl: 0.3, pump: 0.3, rack: 0.2, store: 0.3 };
// Темп: полёт в 1,5 раза быстрее реального (карта 40 км, партия 25 мин); вероятности огня ПВО
// в секунду умножены на тот же коэффициент — время в зоне поражения и шансы сбития те же
export const PACE = 2;
const PHASES = [{ name: 'Фаза 1 — пробные удары', inc: 1, drain: 1 }, { name: 'Фаза 2 — массированные удары', inc: 1.25, drain: 1.25 }, { name: 'Фаза 3 — удар возмездия', inc: 1.5, drain: 1.6 }];
const NET_ROAD = { cost: 40, time: 200, len: 600, name: 'Антидроновая сетка над дорогой' };
// Ремонт дешевле номинала: часть покрывает государственный фонд восстановления
const REPAIR_K = 0.55;
// Время ремонта сжато под темп партии (25 мин): замена трансформатора — минуты, а не часы
const REPAIR_T = 0.5;
// По гражданским объектам удары не наносятся (магазины, ТЦ, погранпереход)
export const CIVIL = new Set(['mall', 'market', 'store', 'border', 'firest', 'rembase', 'fuel', 'agro', 'housing', 'hospital', 'school', 'mill', 'dairy', 'autopark', 'watertower']);
export const SHELTER = [null, { name: 'Габионы и мешки (защита от осколков)', cost: 35, time: 90 }, { name: 'Бетонное укрытие (защита от прямого попадания)', cost: 110, time: 300 }];
// Сетка над пролётом моста: лёгкие дроны (до 25 кг БЧ: «Бобёр», «Ланцет», Warmate) рвутся на ней
export const NET = [null, { name: 'Антидроновая сетка над пролётом', cost: 30, time: 150 }];
export const shelterDef = (c, level) => (COMP[c.k]?.net ? NET[level] : SHELTER[level]);
export const KIND_NAME = { fuel: 'АЗС', hpp: 'ГЭС', chp: 'ТЭЦ', wpp: 'ВЭС', spp: 'СЭС', tpp: 'ТЭС', ps330: 'ПС 330 кВ', ps110: 'ПС 110 кВ', bridge: 'Мост', oil: 'Нефтебаза', ammo: 'Арсенал', factory: 'Завод БПЛА', workshop: 'Сборочный цех БПЛА', launch: 'Стартовая позиция', import: 'Импорт', hub: 'Распределительный центр', border: 'Погранпереход', elevator: 'Элеватор', oldfactory: 'Цеха (оборудование вывезено)', decoy: 'Макет подстанции', refinery: 'НПЗ', watertower: 'Водонапорная станция', railterm: 'Ж/д терминал', port: 'Речной порт', coalmine: 'Угольная шахта', cement: 'Цементный завод', agro: 'Мехдвор', housing: 'Жилой квартал', hospital: 'Больница', school: 'Школа', mill: 'Мелькомбинат', dairy: 'Молочная ферма', solar: 'Солнечная станция', bess: 'Накопитель энергии', pontoon: 'Понтонная переправа', autopark: 'Автобаза', reserve: 'Госрезерв', mall: 'Торговый центр', market: 'Супермаркет', store: 'Магазин', firest: 'Пожарная часть', rembase: 'Ремонтная база' };

// Западные образцы ПВО точнее, у Кардагора — массовость и ложные цели
const AD_EFF = { blue: 0.97, red: 1.0 };
const DEMAND = { 0: 260, 1: 200, 2: 200 }; // МВт на одну ПС 110 кВ (столицу питают две)
const TR_CAP = { 0: 170, 1: 130, 2: 130 }; // МВт на трансформатор 110/10 кВ
// Генерация по типам: МВт на агрегат
const GEN = { tpp: 250, hpp: 55, chp: 70, wt: 4.5, pv: 7.5, import: 250, gtu: 25 }; // солнечные станции игрока: 3 поля × 7,5 МВт
// Мобильная газотурбинная установка: подключается к шинам 10 кВ подстанции 110 кВ
export const GTU = { cost: 220, deploy: 150, max: 2, name: 'Мобильная ГТУ 25 МВт' };
const LINE_CAP = { 330: 900, 110: 260 };
const START_POINTS = 800;
// Ремонтные бригады: по 4 на центральной базе и по 3 в каждом РЭС; зарплата — в минуту за каждую
const START_CREWS = 13, MAX_CREWS = 30, WAGE = 0.9;
const FRONT_POST = 1300;

let nextId = 1;
const hyp = Math.hypot;

export class DroneWar {
  constructor(sim, cfg) {
    this.sim = sim;
    this.cfg = cfg;
    this.mode = 'drones';
    this.world = sim.world;
    this.winner = null;
    this.reason = '';
    this.prepEnd = sim.time + (cfg.prep ?? 180);
    this.prep = (cfg.prep ?? 180) > 0;
    this.startAt = this.prepEnd;
    this.ready = { blue: false, red: false };
    for (const s of cfg.aiSides || []) this.ready[s] = true; // ИИ готов сразу — «К бою» начинает без ожидания
    this.endless = cfg.duration === 0; // без ограничения по времени: партия идёт, пока не рухнет чей-то тыл
    this.endAt = this.endless ? 0 : this.prepEnd + (cfg.duration || 2400);
    this.frontX = this.world.frontX || this.world.W / 2;
    this.drones = [];
    this.missiles = [];
    this.fx = [];
    this.ad = [];
    this.objects = [];
    this.comps = new Map();
    this.lines = [];
    this.sides = {};
    this.flowTimer = 0;
    this.detTimer = 0;
    this.econTimer = 0;
    this.logPower = { blue: [], red: [] };
    this.nets = [];
    this.gens = []; // мобильные ГТУ
    this.phaseNo = 0;
    this.directive = { blue: null, red: null };
    this.nextDirective = 0;
    this.buildObjects();
    for (const side of ['blue', 'red']) {
      const cap = this.world.settlements.find((s) => s.type === 'city' && s.side === side && s.capital);
      this.sides[side] = {
        points: START_POINTS, income: 0, crews: Array.from({ length: START_CREWS }, (_, i) => ({ id: i + 1, job: null, veh: null })), queue: [], auto: true, reserve: 60,
        spare: 2, base: { x: cap.x, y: cap.y }, supply: 1, gen: 0, demand: 0, delivered: 0, achrUntil: 0, lastGen: null,
        collapse: 0, launchCd: {}, stats: { launched: 0, hits: 0, shot: 0, lostAD: 0, spent: 0, repairs: 0, mil: 0 },
        seenObjects: new Set(), history: [], factor: 1, morale: 100, moraleLog: [], lastLoss: null, autoShed: true,
      };
    }
    this.logi = new DWLogistics(this);
    this.econ = new DWEconomy(this);
    this.state = new DWState(this);
    this.infra = new DWInfra(this);
    this.res = new DWResearch(this);
    // Туман войны: объекты противника неизвестны, пока их не найдёт разведка (мосты — на любой карте)
    this.fog = cfg.fog !== false;
    this.intel = { blue: new Set(), red: new Set() };
    this.satT = { blue: 0, red: 0 };
    this.intelTick(true);
    this.deployStart();
    this.flow(true);
  }

  // ---------- Объекты из генератора ----------
  buildObjects() {
    for (const o of this.world.infra) {
      const c = Math.cos(o.angle), s = Math.sin(o.angle);
      const obj = { ...o, comps: [] };
      for (const d of o.comps) {
        const comp = {
          id: `${o.id}:${obj.comps.length}`, oid: o.id, obj, k: d.k, name: d.n, u: d.u, v: d.v, w: d.w, h: d.h,
          x: o.x + d.u * c - d.v * s, y: o.y + d.u * s + d.v * c, angle: o.angle,
          hp: 1, state: 'ok', fire: 0, shelter: 0, repair: null, burned: false,
        };
        obj.comps.push(comp);
        this.comps.set(comp.id, comp);
      }
      this.objects.push(obj);
    }
    for (const ln of this.world.power.lines) {
      this.lines.push({ ...ln, cut: null, repair: null, hp: 1, id: `L${ln.id}` });
    }
    // Мосты: какая река, дальний берег (к фронту) — города по ту сторону зависят от мостов
    this.byId = new Map(this.objects.map((o) => [o.id, o]));
  }
  obj(id) { return this.byId.get(id); }
  known(side, o) { return !this.fog || !o || o.side === side || o.kind === 'bridge' || o.kind === 'import' || this.intel[side].has(o.id); }
  reveal(side, o, how) {
    if (this.known(side, o)) return;
    this.intel[side].add(o.id);
    this.sim.events.push({ type: 'intel', side, oid: o.id });
    if (how) this.sim.msg(`Разведка: обнаружен объект «${o.name}» (${how})`, side);
  }
  // Объекты у линии фронта видны с передовой; спутниковые снимки (исследование) — раз в 8 минут
  intelTick(init = false) {
    for (const o of this.objects) {
      if (o.kind === 'bridge' || o.kind === 'import') continue;
      const enemy = o.side === 'blue' ? 'red' : 'blue';
      if (Math.abs(o.x - this.frontX) < 5000) this.reveal(enemy, o, init ? null : 'видно с передовой');
    }
    if (init) return;
    for (const side of ['blue', 'red']) {
      if (!this.res.has(side, 'sat') || this.sim.time < this.satT[side]) continue;
      this.satT[side] = this.sim.time + 480;
      const enemy = side === 'blue' ? 'red' : 'blue';
      const hidden = this.objects.filter((o) => o.side === enemy && !this.known(side, o) && !CIVIL.has(o.kind));
      if (hidden.length) this.reveal(side, hidden[this.sim.rng.int(0, hidden.length - 1)], 'спутниковый снимок');
    }
  }
  objs(side, kind) { return this.objects.filter((o) => o.side === side && (!kind || o.kind === kind)); }
  compOk(c) { return c.state === 'ok' && c.fire <= 0; }
  lineAlive(a, b) {
    const ln = this.lines.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
    return ln && !ln.cut;
  }

  // Стартовая ПВО: немного у ключевых объектов, остальное — за игроком
  deployStart() {
    for (const side of ['blue', 'red']) {
      const tpp = this.objs(side, 'tpp')[0];
      const psA = this.objs(side, 'ps330')[0];
      const cap = this.sides[side].base;
      const dir = side === 'blue' ? 1 : -1;
      const put = (type, x, y) => this.placeAD(side, type, x, y, true);
      put('radar', cap.x - dir * 600, cap.y + 300);
      put('mog', tpp.x + dir * 300, tpp.y + 150);
      put('mog', psA.x + dir * 250, psA.y - 150);
      put('mog', cap.x + dir * 1500, cap.y - 400);
      for (const [dx, dy] of [[2600, -2500], [2600, 0], [2600, 2500], [4200, -1200], [4200, 1300]]) put('acoustic', cap.x + dir * dx, cap.y + dy);
      put('icpt', cap.x + dir * 700, cap.y - 200);
    }
  }

  // ---------- Команды ----------
  setReady(side) { this.ready[side] = true; }
  setAuto(side, on) { this.sides[side].auto = !!on; }
  canPlace(side, type, x, y) {
    const W = this.world.W;
    if (x < 100 || y < 100 || x > W - 100 || y > this.world.H - 100) return 'За краем карты';
    if (side === 'blue' ? x > this.frontX - 700 : x < this.frontX + 700) return 'Только на своей территории (не ближе 700 м к линии фронта)';
    if (this.world.mask.has(x, y, M.WATER)) return 'В воде нельзя';
    if (this.res && !this.res.adOk(side, type)) return `Нужно исследование «${this.res.needFor('ad', type)}»`;
    const cost = this.adCost(side, type);
    if (this.sides[side].points < cost) return `Не хватает очков: нужно ${cost}`;
    return null;
  }
  // Цена позиции ПВО с учётом инфляции; закупленный по контракту ЗРК — бесплатно
  adCost(side, type) {
    if (type === 'sam' && (this.state?.side[side].armsCredit || 0) > 0) return 0;
    return Math.round(DW_AD[type].cost * (this.state ? this.state.k(side, 'arms') : 1));
  }
  placeAD(side, type, x, y, free = false) {
    if (!free) {
      const err = this.canPlace(side, type, x, y);
      if (err) return err;
      const cost = this.adCost(side, type);
      if (type === 'sam' && cost === 0) this.state.side[side].armsCredit--;
      this.sides[side].points -= cost;
      this.sides[side].stats.spent += cost;
      this.sides[side].stats.mil += cost;
    }
    const T = DW_AD[type];
    const a = {
      id: nextId++, side, type, x, y, heading: side === 'blue' ? 0 : Math.PI, hp: 1, dead: false,
      state: free ? 'ready' : 'deploying', until: this.sim.time + (free ? 0 : T.deploy), dest: null,
      ammo: T.ammo || 0, missiles: typeof T.missiles === 'object' ? T.missiles[side] : T.missiles || 0, stock: T.stock || 0,
      mMax: typeof T.missiles === 'object' ? T.missiles[side] : T.missiles || 0,
      cd: 0, target: null, roe: type === 'sam' ? 'threat' : 'all', spotted: {}, fireT: -99, kills: 0, aim: 0,
      name: T.name[side],
    };
    this.ad.push(a);
    if (!free) this.sim.msg(`${a.name}: развёртывание${T.deploy ? ` (${T.deploy} с)` : ''}`, side);
    return null;
  }
  moveAD(side, id, x, y) {
    const a = this.ad.find((q) => q.id === id && q.side === side && !q.dead);
    if (!a) return 'Нет такого подразделения';
    const T = DW_AD[a.type];
    if (!T.mobile) return 'Стационарная станция — перенести нельзя';
    if (side === 'blue' ? x > this.frontX - 700 : x < this.frontX + 700) return 'Только на своей территории';
    a.dest = { x, y };
    a.state = 'moving';
    return null;
  }
  setROE(side, id, roe) {
    const a = this.ad.find((q) => q.id === id && q.side === side);
    if (a) a.roe = roe;
  }

  // Пуск: count дронов типа type по точке/объекту/узлу; route — промежуточные точки
  launch(side, type, count, tx, ty, opts = {}) {
    const D = DW_DRONES[type];
    if (!D || D.side !== side) return 'Этот тип дронов у стороны не состоит на вооружении';
    if (this.prep && D.cls !== 'recon') return 'Идёт развёртывание — удары после окончания подготовки';
    if (opts.oid && CIVIL.has(this.obj(opts.oid)?.kind)) return 'Удары по гражданским объектам (магазины, ТЦ, погранпереход, пожарные, ремонтники) не наносятся';
    const S = this.sides[side];
    if (this.res && !this.res.droneOk(side, type)) return `${D.short}: нужно исследование «${this.res.needFor('drone', type)}»`;
    const have = this.res ? this.res.stock(side, type) : count;
    if (have <= 0) return `${D.short}: в запасе нет — закажите на заводе (вкладка «Удары»)`;
    count = Math.min(count, have);
    const sites = this.launchPoints(side, D);
    if (!sites.length) return 'Нет исправных стартовых позиций';
    // Пропускная способность стартовых позиций: пусковых и расчётов мало — больше за раз не поднять
    const fromSites = D.cls === 'strike' || D.cls === 'decoy' || (D.cls === 'hunter' && !D.front);
    if (fromSites) {
      const free = this.econ.launchFree(side);
      if (count > free) return free > 0 ? `Стартовые позиции загружены: сейчас можно поднять не больше ${free} (лимит ${this.econ.launchCap(side)} за 5 мин — стройте и улучшайте стартовые позиции)` : `Стартовые позиции загружены: все пусковые заняты (лимит ${this.econ.launchCap(side)} за 5 мин)`;
      this.econ.useLaunch(side, count);
    }
    this.res?.take(side, type, count);
    const rng = this.sim.rng;
    const strike = D.cls === 'strike' || D.cls === 'decoy';
    let tDep = 0;
    for (let i = 0; i < count; i++) {
      // Разные пусковые и интервалы, у каждого — свой маршрут: дроны идут веером, а не колонной
      const site = sites[(i + rng.int(0, sites.length - 1)) % sites.length];
      tDep += strike ? rng.float(2, 7) : rng.float(1, 4);
      const delay = tDep + (site.delay || 0);
      const own = (opts.route || []).map((p) => ({ x: p.x + rng.float(-1500, 1500), y: p.y + rng.float(-1500, 1500) }));
      if (strike && D.cls !== 'loiter') {
        // промежуточная точка сбоку от прямой, на 30–70% пути
        const f = rng.float(0.3, 0.7), bx = site.x + (tx - site.x) * f, by = site.y + (ty - site.y) * f;
        const L = hyp(tx - site.x, ty - site.y) || 1, off = rng.float(-0.18, 0.18) * L;
        own.splice(Math.floor(own.length / 2), 0, { x: bx - ((ty - site.y) / L) * off, y: by + ((tx - site.x) / L) * off });
      }
      const d = {
        id: nextId++, side, type, x: site.x + rng.float(-40, 40), y: site.y + rng.float(-40, 40), alt: 0, heading: rng.float(0, 6.28), speed: D.speed, state: 'wait', t0: this.sim.time + delay,
        route: own, tx, ty, oid: opts.oid ?? null, cid: opts.cid ?? null, adTarget: opts.adTarget ?? null, vehTarget: opts.vehTarget ?? null,
        cruise: D.alt[0] + this.sim.rng.float(0, 1) * (D.alt[1] - D.alt[0]), drift: [0, 0], dead: false, seen: {}, ew: 0, trail: [], hp: 1,
        until: this.sim.time + delay + (D.endurance || 4 * 3600), wave: opts.wave ?? null, spawnSite: site.oid,
        variant: rng.int(0, 2), home: D.cls === 'hunter' ? [tx, ty] : null,
      };
      // Точка прицеливания: разброс (КВО) — задаётся заранее
      const g = this.sim.rng;
      const r = (D.cep || 0) * Math.sqrt(-2 * Math.log(Math.max(1e-6, g.float(0, 1)))) * 0.85, a = g.float(0, Math.PI * 2);
      d.aimX = tx + Math.cos(a) * r; d.aimY = ty + Math.sin(a) * r;
      this.drones.push(d);
    }
    S.stats.launched += count;
    const tgt = opts.oid ? this.obj(opts.oid)?.name : opts.adTarget ? 'позиция ПВО' : opts.vehTarget ? 'транспорт на дороге' : D.cls === 'hunter' ? `охота на дорогах у точки ${Math.round(tx)}, ${Math.round(ty)}` : `точка ${Math.round(tx)}, ${Math.round(ty)}`;
    this.sim.msg(`Пуск: ${D.short} ×${count} → ${tgt} (в запасе ещё ${this.res ? this.res.stock(side, type) : '—'})`, side);
    return null;
  }
  droneCost(side, type) {
    const fac = this.objs(side, 'factory').find((q) => !(q.build && !q.build.up));
    const ok = fac ? fac.comps.filter((c) => c.k === 'shop' && this.compOk(c)).length / fac.comps.filter((c) => c.k === 'shop').length : 0;
    return DW_DRONES[type].cost * (1 - 0.3 * ok) * (this.econ ? this.econ.partsK(side) : 1) * (this.state ? this.state.k(side, 'drone') : 1); // свой завод удешевляет дроны до 30%, без комплектующих — дороже
  }
  launchPoints(side, D) {
    if (D.cls === 'strike' || D.cls === 'decoy' || (D.cls === 'hunter' && !D.front)) {
      const out = [];
      for (const o of this.objs(side, 'launch')) {
        if (o.build && !o.build.up) continue;
        const ok = o.comps.filter((c) => c.k === 'launcher' && this.compOk(c));
        ok.forEach((c, i) => out.push({ x: c.x, y: c.y, oid: o.id, delay: i * 2 }));
      }
      return out;
    }
    // Барражирующие и разведчики — с передовых позиций операторов
    const x = this.frontX + (side === 'blue' ? -FRONT_POST : FRONT_POST);
    return [0.25, 0.5, 0.75].map((f) => ({ x, y: this.world.H * f }));
  }

  // Ремонт узла или линии
  repair(side, id, manual = true) {
    const S = this.sides[side];
    const c = this.comps.get(id) || this.lines.find((l) => l.id === id);
    if (!c) return 'Нет такого узла';
    if ((c.obj?.side ?? c.side) !== side) return 'Чужой объект';
    const need = c.pylons ? !!c.cut : c.state !== 'ok';
    if (!need) return 'Узел исправен';
    if (S.queue.includes(id) || S.crews.some((w) => w.job?.id === id)) return 'Уже в очереди на ремонт';
    S.queue.push(id);
    if (manual) this.sim.msg(`Ремонт: ${c.name || 'ЛЭП'} — в очереди`, side);
    return null;
  }
  shelter(side, id, level) {
    const S = this.sides[side];
    const c = this.comps.get(id);
    if (!c || c.obj.side !== side || !(COMP[c.k].shelter || COMP[c.k].net)) return 'Здесь укрытие не строят';
    if (c.shelter >= level) return 'Уже есть';
    if (COMP[c.k].net && level > 1) return 'Сетка уже есть';
    if (level > c.shelter + 1) return 'Сначала — габионы';
    if (S.queue.includes('S' + id)) return 'Уже в очереди';
    S.queue.push('S' + id);
    this.sim.msg(`${shelterDef(c, level).name}: ${c.name} — в очереди`, side);
    return null;
  }
  // Сетка над участком дороги (~600 м): ставит ремонтная бригада
  buildNet(side, x, y) {
    const S = this.sides[side];
    if (side === 'blue' ? x > this.frontX - 700 : x < this.frontX + 700) return 'Только на своей территории';
    if (this.nets.filter((n) => n.side === side).length >= 14) return 'Больше сеток не поставить';
    if (S.points < NET_ROAD.cost) return `Не хватает очков: нужно ${NET_ROAD.cost}`;
    let best = null, bd = 120, bi = 0;
    for (const r of this.world.roadList) {
      if (r.type === 'street') continue;
      for (let i = 0; i < r.line.length; i++) { const d = hyp(r.line[i][0] - x, r.line[i][1] - y); if (d < bd) { bd = d; best = r; bi = i; } }
    }
    if (!best) return 'Укажите точку на дороге (не городская улица)';
    // Участок ±300 м вдоль дороги
    const L = best.line;
    let i0 = bi, i1 = bi, acc = 0;
    while (i0 > 0 && acc < NET_ROAD.len / 2) { acc += hyp(L[i0][0] - L[i0 - 1][0], L[i0][1] - L[i0 - 1][1]); i0--; }
    acc = 0;
    while (i1 < L.length - 1 && acc < NET_ROAD.len / 2) { acc += hyp(L[i1 + 1][0] - L[i1][0], L[i1 + 1][1] - L[i1][1]); i1++; }
    const line = L.slice(i0, i1 + 1).map((p) => [p[0], p[1]]);
    if (this.nets.some((n) => n.side === side && hyp(n.x - L[bi][0], n.y - L[bi][1]) < 250)) return 'Здесь сетка уже есть';
    const xs = line.map((p) => p[0]), ys = line.map((p) => p[1]);
    const net = { id: 'R' + (this.nets.length + 1) + side[0], side, line, x: L[bi][0], y: L[bi][1], done: false, w: (best.width || 8) + 6,
      bb: { x0: Math.min(...xs) - 12, y0: Math.min(...ys) - 12, x1: Math.max(...xs) + 12, y1: Math.max(...ys) + 12 } };
    this.nets.push(net);
    S.queue.push(net.id);
    this.sim.msg(`${NET_ROAD.name}: участок у точки ${Math.round(net.x)}, ${Math.round(net.y)} — в очереди`, side);
    return null;
  }
  underNet(side, x, y) {
    for (const n of this.nets) {
      if (!n.done || n.side !== side || x < n.bb.x0 || x > n.bb.x1 || y < n.bb.y0 || y > n.bb.y1) continue;
      for (let i = 1; i < n.line.length; i++) if (segDist(x, y, n.line[i - 1], n.line[i]) < n.w / 2 + 2) return true;
    }
    return false;
  }
  // Стройка и реконструкция (гражданская экономика — dwecon.js)
  buildCivil(side, kind, x, y) { return this.econ.build(side, kind, x, y); }
  // Государство (dwstate.js)
  setLaw(side, id, on) { return this.state.setLaw(side, id, on); }
  // Инфраструктура (dwinfra.js)
  pave(side, x, y) { return this.infra.pave(side, x, y); }
  buildLine(side, a, b) { return this.infra.buildLine(side, a, b); }
  evacuate(side, id, x, y) { return this.infra.evacuate(side, id, x, y); }
  setRegion(side, i, spec) { return this.infra.setRegion(side, i, spec); }
  setTax(side, level) { return this.state.setTax(side, level); }
  setMobil(side, level) { return this.state.setMobil(side, level); }
  startProject(side, id) { return this.state.startProject(side, id); }
  startResearch(side, branch) { return this.state.startResearch(side, branch); }
  takeCredit(side, kind) { return this.state.takeCredit(side, kind); }
  acceptContract(side, id) { return this.state.acceptContract(side, id); }
  upgrade(side, id) { return this.econ.upgrade(side, id); }
  orderDrones(side, k, n) { return this.res.order(side, k, n); }
  cancelOrder(side, i) { return this.res.cancel(side, i); }
  startLab(side, id) { return this.res.start(side, id); }
  gridConnect(side, id) { return this.econ.gridConnect(side, id); }
  buyCrew(side) {
    const S = this.sides[side];
    if (S.points < 60) return 'Не хватает очков: нужно 60';
    if (S.crews.length >= MAX_CREWS) return 'Больше бригад не набрать';
    S.points -= 60;
    S.crews.push({ id: Math.max(0, ...S.crews.map((c) => c.id)) + 1, job: null, veh: null });
    this.sim.msg(`Сформирована ремонтная бригада №${S.crews.length}`, side);
    return null;
  }
  buySpare(side) {
    const S = this.sides[side];
    if (S.points < 150) return 'Не хватает очков: нужно 150';
    S.points -= 150;
    S.spare++;
    this.sim.msg('Закуплен резервный автотрансформатор', side);
    return null;
  }

  // ---------- Главный цикл ----------
  update(dt) {
    const sim = this.sim;
    if (this.winner) return;
    if (this.prep && (sim.time >= this.prepEnd || (this.ready.blue && this.ready.red))) {
      this.prep = false;
      this.startAt = sim.time;
      this.endAt = this.endless ? 0 : sim.time + (this.cfg.duration || 2400);
      this.nextDirective = sim.time + 120;
      sim.msg('Развёртывание окончено — стороны могут наносить удары');
    }
    if (!this.prep) this.updateCampaign();
    for (const gt of this.gens) if (gt.state === 'deploying' && sim.time >= gt.until && !gt.dead) { gt.state = 'ready'; this.flowTimer = 0; sim.msg(`${GTU.name}: подключена к ${this.obj(gt.ps)?.name}`, gt.side); }
    this.updateAD(dt);
    this.updateDrones(dt);
    this.updateMissiles(dt);
    this.detTimer -= dt;
    if (this.detTimer <= 0) { this.detTimer = 1; this.detect(); }
    this.updateFires(dt);
    this.logi.update(dt);
    this.econ.update(dt);
    this.state.update(dt);
    this.infra.update(dt);
    this.res.update(dt);
    this.updateRepairs(dt);
    this.flowTimer -= dt;
    if (this.flowTimer <= 0) { this.flowTimer = 2; this.flow(); }
    this.econTimer -= dt;
    if (this.econTimer <= 0) { this.econTimer = 5; this.economy(5); }
    // эффекты живут столько, сколько рисуются (прилёты с дымом — дольше, трассеры — доли секунды)
    const LIFE = { tracer: 0.5, airburst: 5, fall: 6, money: 3, impact: 30 };
    if (this.fx.length > 60) this.fx = this.fx.filter((f) => sim.time - f.t0 < (LIFE[f.t] ?? 5));
    if (this.fx.length > 600) this.fx.splice(0, this.fx.length - 600);
  }

  // ---------- Энергосистема ----------
  // Выработка станции (МВт) с учётом исправности узлов
  genOf(o) {
    const ok = (k) => o.comps.filter((c) => c.k === k && this.compOk(c));
    const all = (k) => o.comps.filter((c) => c.k === k);
    const frac = (k) => ok(k).length / Math.max(1, all(k).length);
    if (!ok('oru').length && o.kind !== 'import') return 0;
    const ctrl = all('ctrl').length ? (ok('ctrl').length ? 1 : 0.7) : 1;
    const t = this.sim.time;
    switch (o.kind) {
      case 'tpp': {
        const units = all('unit'), gsus = all('gsu');
        let g = 0;
        units.forEach((u, i) => { if (this.compOk(u) && gsus[i] && this.compOk(gsus[i])) g += GEN.tpp; });
        const coal = all('coal')[0];
        let fuel = coal ? (this.compOk(coal) ? 1 : coal.state === 'destroyed' ? 0.55 : 0.8) : 1;
        if (this.infra?.coalBonus(o.side)) fuel = Math.max(fuel, 0.95) * 1.1; // уголь своей шахты идёт прямо на блоки
        return g * fuel * (0.5 + 0.5 * frac('chimney')) * (0.67 + 0.33 * frac('tower')) * ctrl;
      }
      case 'hpp': {
        const gsus = all('gsu');
        return all('hgen').reduce((a, u, i) => a + (this.compOk(u) && gsus[Math.floor(i / 2)] && this.compOk(gsus[Math.floor(i / 2)]) ? GEN.hpp : 0), 0) * ctrl;
      }
      case 'chp': {
        const gsus = all('gsu');
        return all('unit').reduce((a, u, i) => a + (this.compOk(u) && gsus[i] && this.compOk(gsus[i]) ? GEN.chp : 0), 0) * (0.5 + 0.5 * frac('chimney')) * ctrl;
      }
      case 'wpp': return ok('gsu').length ? ok('wt').length * GEN.wt * this.wind : 0;
      case 'spp': case 'solar': return ok('pv').length * GEN.pv * daylight(this.sim.tod()) * (0.3 + 0.7 * frac('inv')) * (this.infra?.season().eff.solar ?? 1);
    }
    return 0;
  }
  // Энергосистема стороны — поток мощности по сети: станции → шины ОРУ → ЛЭП → автотрансформаторы
  // ПС 330/110 → ЛЭП 110 → трансформаторы ПС 110/10 → районы. Дефицит на ПС 110 без плановых
  // (веерных) отключений — неустойчивый режим: аварийные отключения, перегрев и отключение
  // трансформатора. Плановые очереди снимают нагрузку, и остальные районы получают свет стабильно.
  flow(first = false) {
    const sim = this.sim;
    const hour = (sim.tod() / 3600) % 24;
    const prof = 0.72 + 0.18 * Math.exp(-(((hour - 8.5) / 2) ** 2)) + 0.28 * Math.exp(-(((hour - 19.5) / 2.5) ** 2));
    // Ветер: медленное случайное блуждание 0.15..1
    this.wind = Math.max(0.15, Math.min(1, (this.wind ?? 0.6) + sim.rng.gauss(0, 0.03)));
    const dtF = first ? 0 : 2;
    for (const side of ['blue', 'red']) {
      const S = this.sides[side];
      const nodes = new Map();
      const node = (k) => { if (!nodes.has(k)) nodes.set(k, nodes.size + 2); return nodes.get(k); }; // 0 — исток, 1 — сток
      const edges = [];
      const E = (a, b, c) => { if (c > 0) edges.push([a, b, c]); };
      const genBy = {};
      let totalGen = 0;
      // Станции
      for (const o of this.objs(side)) {
        if (!GEN[o.kind] && !['tpp', 'hpp', 'chp', 'wpp', 'spp', 'solar'].includes(o.kind)) continue;
        if (o.build && !o.build.up) continue;
        const kv = o.kind === 'tpp' || o.kind === 'hpp' ? 330 : 110;
        const g = this.genOf(o);
        o.gen = g;
        const key = o.kind === 'solar' ? 'spp' : o.kind;
        genBy[key] = (genBy[key] || 0) + g;
        totalGen += g;
        E(0, node(`${o.id}:${kv}`), g);
        // построенная станция — кабелем 110 кВ к ближайшей подстанции
        if (o.built && o.ps != null) { E(node(`${o.id}:110`), node(`${o.ps}:110`), 150); }
      }
      // накопители энергии отдают мощность прямо на шины 10 кВ своей подстанции
      for (const x of this.econ.gridExtras(side)) { E(0, node(`${x.ps}:10`), x.mw); genBy.bess = (genBy.bess || 0) + x.mw; totalGen += x.mw; }
      const imp = this.lines.find((l) => l.a === 'import' && l.side === side);
      const impCap = (imp && !imp.cut ? GEN.import : 0) + this.state.importMW(side); // энергомост (нацпроект) — отдельная линия
      genBy.import = impCap; totalGen += impCap;
      E(0, node('import:330'), impCap);
      // Подстанции
      const p110 = this.objs(side, 'ps110');
      const allK = (o, k) => o.comps.filter((c) => c.k === k);
      const okK = (o, k) => o.comps.filter((c) => c.k === k && this.compOk(c));
      for (const ps of this.objs(side, 'ps330')) {
        const oruOk = allK(ps, 'oru').every((c) => this.compOk(c));
        const cap = oruOk ? okK(ps, 'at').length * 250 * (okK(ps, 'ctrl').length ? 1 : 0.6) : 0;
        E(node(`${ps.id}:330`), node(`${ps.id}:110`), cap);
      }
      const D = [];
      p110.forEach((ps, i) => {
        const oruOk = allK(ps, 'oru').every((c) => this.compOk(c));
        const cap = oruOk ? okK(ps, 'tr').length * (TR_CAP[ps.city ?? 1]) * (okK(ps, 'ctrl').length ? 1 : 0.7) : 0;
        ps.trCap = cap;
        E(node(`${ps.id}:110`), node(`${ps.id}:10`), cap);
        D[i] = DEMAND[ps.city ?? 1] * prof * this.state.k(side, 'demand');
        E(node(`${ps.id}:10`), 1, D[i]);
        // мобильные ГТУ — прямо на шины 10 кВ
        for (const gt of this.gens) if (gt.ps === ps.id && !gt.dead && gt.state === 'ready') {
          const mw = GEN.gtu * ((S.oil ?? 1) > 0.1 ? 1 : 0.4);
          E(0, node(`${ps.id}:10`), mw); genBy.gtu = (genBy.gtu || 0) + mw; totalGen += mw;
        }
      });
      // ЛЭП — в обе стороны
      for (const l of this.lines) {
        if (l.side !== side || l.cut) continue;
        const a = l.a === 'import' ? 'import' : l.a, b = l.b === 'import' ? 'import' : l.b;
        const na = node(`${a}:${l.kv}`), nb = node(`${b}:${l.kv}`);
        E(na, nb, LINE_CAP[l.kv]); E(nb, na, LINE_CAP[l.kv]);
      }
      const n = nodes.size + 2;
      const cap = Array.from({ length: n }, () => new Float64Array(n));
      for (const [a, b, c] of edges) cap[a][b] += c;
      const watch = p110.map((ps) => node(`${ps.id}:10`));
      const got = maxflowPer(cap, 0, 1, watch);
      // Аварийная частотная разгрузка: генерация резко упала более чем на четверть
      if (!first && S.lastGen !== null && totalGen < S.lastGen * 0.72 && S.lastGen > 150) {
        S.achrUntil = sim.time + 40 + sim.rng.float(0, 30);
        sim.msg('Энергосистема: резкая потеря генерации — сработала АЧР, аварийные отключения по всей стороне', side);
      }
      S.lastGen = totalGen;
      S.genBy = genBy;
      const achr = sim.time < S.achrUntil;
      let del = 0, dem = 0, lostW = 0;
      p110.forEach((ps, i) => {
        const L = ps.shed || 0;
        const Dp = D[i] * (1 - 0.2 * L);
        const avail = got[i];
        const stable = Dp <= avail * 1.02 + 1;
        let delivered;
        if (stable) { delivered = Dp; ps.overT = Math.max(0, (ps.overT || 0) - dtF * 2); }
        else {
          // неустойчивый режим: аварийные отключения сверх плана, перегрев трансформаторов
          delivered = avail * 0.85;
          ps.overT = (ps.overT || 0) + dtF;
          if (ps.overT >= 60) {
            ps.overT = 0;
            const tr = ps.comps.find((c) => c.k === 'tr' && this.compOk(c));
            if (tr) {
              tr.state = 'damaged'; tr.hp = Math.min(tr.hp, 0.5);
              if (sim.rng.chance(0.25)) tr.fire = 120;
              sim.msg(`${ps.name}: перегрузка — сработала защита, ${tr.name} отключился и требует ремонта. Введите веерные отключения!`, side);
            }
          }
        }
        // Диспетчер-автомат: подбирает число очередей отключений (с задержкой)
        if (S.autoShed) {
          let need = 0;
          while (need < 4 && D[i] * (1 - 0.2 * need) > avail * 1.01 + 1) need++;
          need = Math.min(4, need);
          ps.autoT = (ps.autoT || 0) + dtF;
          if (need > L && ps.autoT >= 12) { ps.shed = need; ps.autoT = 0; }
          else if (need < L && ps.autoT >= 60) { ps.shed = L - 1; ps.autoT = 0; }
          else if (need === L) ps.autoT = 0;
        }
        let supply = Math.max(0, Math.min(1, delivered / D[i]));
        if (achr) supply = Math.min(supply, 0.25);
        ps.supply = supply; ps.unstable = !stable; ps.avail = avail; ps.demand = D[i];
        del += D[i] * supply; dem += D[i];
        lostW += D[i] * (1 - supply) * (stable ? 0.7 : 1.3);
        const m = this.world.power.mains.find((q) => q.infraId === ps.id);
        if (m) {
          const changed = Math.abs((m.supply ?? 1) - Math.max(0.06, supply)) > 0.02;
          m.supply = Math.max(0.06, supply);
          m.alive = ps.comps.some((c) => c.k === 'tr' && this.compOk(c)) || supply > 0.1;
          const sh = Math.floor(sim.time / 1200) * 0.37 % 1;
          if (m.shift !== sh) { m.shift = sh; this.world.power.version++; }
          if (changed) this.world.power.version++;
        }
      });
      S.gen = Math.round(totalGen); S.demand = Math.round(dem); S.delivered = Math.round(del);
      S.supply = dem ? del / dem : 1;
      S.powerLoss = dem ? lostW / dem : 0; // для устойчивости тыла: плановые отключения переносятся легче
    }
  }
  setShed(side, psId, level) {
    const ps = this.obj(psId);
    if (!ps || ps.side !== side || ps.kind !== 'ps110') return 'Нет такой подстанции';
    ps.shed = Math.max(0, Math.min(4, level | 0));
    this.sides[side].autoShed = false;
    this.flowTimer = 0;
    this.sim.msg(`${ps.name}: ${ps.shed ? `веерные отключения — ${ps.shed} очеред${ps.shed === 1 ? 'ь' : 'и'} из 5 без света` : 'все районы включены'}. Диспетчер — ручной режим`, side);
    return null;
  }
  setAutoShed(side, on) { this.sides[side].autoShed = !!on; this.flowTimer = 0; }
  buyGTU(side, psId) {
    const S = this.sides[side];
    const ps = this.obj(psId);
    if (!ps || ps.side !== side || ps.kind !== 'ps110') return 'ГТУ подключают к подстанции 110 кВ';
    if (this.gens.filter((g) => g.ps === ps.id && !g.dead).length >= GTU.max) return `Не больше ${GTU.max} ГТУ на подстанцию`;
    if (S.points < GTU.cost) return `Не хватает очков: нужно ${GTU.cost}`;
    S.points -= GTU.cost; S.stats.spent += GTU.cost;
    const k = this.gens.filter((g) => g.ps === ps.id).length;
    const a = ps.angle + Math.PI / 2, off = ps.h / 2 + 18 + k * 14;
    this.gens.push({ id: nextId++, side, ps: ps.id, x: ps.x + Math.cos(a) * off, y: ps.y + Math.sin(a) * off, angle: ps.angle, state: 'deploying', until: this.sim.time + GTU.deploy, dead: false });
    this.sim.msg(`${GTU.name}: едет к ${ps.name}, подключение через ${Math.round(GTU.deploy / 60)} мин`, side);
    return null;
  }

  // ---------- Экономика и условия победы ----------
  economy(dt) {
    const sim = this.sim;
    for (const side of ['blue', 'red']) {
      const S = this.sides[side];
      const p110 = this.objs(side, 'ps110');
      const town = (ci) => { const ps = p110.filter((p) => p.city === ci); return ps.reduce((a, p) => a + (p.supply ?? 1), 0) / Math.max(1, ps.length); };
      // Логистика городов за рекой: хотя бы один мост цел
      const br = this.objs(side, 'bridge');
      const brOk = br.filter((b) => this.bridgeCap(b) > 0.4).length;
      const logi = br.length ? (brOk === 0 ? 0.45 : brOk < br.length / 2 ? 0.8 : 1) : 1;
      S.logi = logi;
      const fac = this.objs(side, 'factory')[0];
      const facOk = fac ? fac.comps.filter((c) => c.k === 'shop' && this.compOk(c)).length / 3 : 0;
      const oil = this.objs(side, 'oil')[0];
      S.oil = oil ? oil.comps.filter((c) => c.k === 'tank' && c.state !== 'destroyed').length / oil.comps.filter((c) => c.k === 'tank').length : 1;
      if (this.infra?.has(side, 'refinery')) S.oil = Math.max(S.oil, 0.8); // своё топливо с НПЗ
      const ammo = this.objs(side, 'ammo')[0];
      S.ammo = ammo ? ammo.comps.filter((c) => c.k === 'bunker' && c.state !== 'destroyed').length / ammo.comps.filter((c) => c.k === 'bunker').length : 1;
      // Промышленность при отключениях проседает сильнее, чем свет: цеха стоят целиком
      const ind = (ci) => town(ci) ** 2;
      // Промышленность (от света) + торговля в магазинах (начисляется при продажах, см. логистику)
      // Рабочие руки: мобилизованные (ПВО, бригады, пусковые) не работают на заводах
      const labor = this.econ.labor(side);
      // ночная смена на заводах работает не в полную силу
      const shift = 0.85 + 0.15 * daylight(sim.tod());
      const perMin = (4 + 10 * ind(0) + (4 * ind(1) + 4 * ind(2)) * logi + 4 * facOk * town(0) + 2 * S.oil) * this.incomeK(side) * labor * shift * this.state.k(side, 'industry');
      const tax = this.econ.taxes(side, dt) * this.incomeK(side) * labor * this.state.k(side, 'tax');
      const upkeep = this.econ.upkeep(side) * this.state.k(side, 'upkeep');
      const fl = this.state.flows(side); // помощь союзников, взносы по законам и долги
      const L = this.logi.side[side];
      // Скользящие средние по статьям дохода (очков в минуту)
      const rate = (key) => { const v = (L.stats[key] - (L['last_' + key] ?? L.stats[key])) * (60 / dt); L['last_' + key] = L.stats[key]; return v; };
      const avg = (k, v) => (S.inc[k] = (S.inc[k] ?? v) * 0.88 + v * 0.12);
      S.inc = S.inc || {};
      S.inc.industry = perMin;
      avg('trade', rate('trade')); avg('fuel', rate('fuel')); avg('transit', rate('transit')); S.inc.agro = (S.inc.agro ?? 0) * 0.97 + rate('agro') * 0.03; // экспорт идёт партиями — среднее за ~3 мин
      S.tradeAvg = S.inc.trade + S.inc.fuel + S.inc.transit;
      S.inc.tax = tax;
      S.inc.other = this.econ.extraIncome(side); // инвестиции и сборы на армию
      S.inc.upkeep = -upkeep;
      S.inc.wages = -S.crews.length * WAGE * this.state.k(side, 'wages');
      S.inc.state = fl.aid - fl.fees;
      S.income = perMin + S.tradeAvg + S.inc.agro + tax + S.inc.other + S.inc.state + S.inc.wages - upkeep;
      if (!this.prep) { S.points += ((perMin + tax + S.inc.other + S.inc.state + S.inc.wages - upkeep) * dt) / 60; S.stats.spent += ((-S.inc.wages + upkeep) * dt) / 60; S.stats.mil += (upkeep * dt) / 60; }
      if (!this.prep) this.moraleTick(side, dt);
      // История снабжения для итога
      S.history.push(S.supply);
      if (S.history.length > 120) S.history.shift();
      // Коллапс: энергосистема лежит, а денег на ремонт нет
      const pend = this.pendingCost(side);
      const broke = pend.min !== Infinity && S.points < pend.min;
      if (!this.prep && S.supply < 0.35 && broke) S.collapse += dt;
      else if (!this.prep && S.points < 1 && pend.n > 6) S.collapse += dt * 0.5;
      else S.collapse = Math.max(0, S.collapse - dt * 2);
      if (S.collapse >= 120 && !this.winner) {
        this.winner = side === 'blue' ? 'red' : 'blue';
        this.reason = `Энергосистема стороны «${side === 'blue' ? 'Велнария' : 'Кардагор'}» рухнула, а средств на восстановление не осталось`;
        sim.msg(this.reason);
      }
    }
    for (const side of ['blue', 'red']) {
      if (this.winner || this.sides[side].morale > 0) continue;
      this.winner = side === 'blue' ? 'red' : 'blue';
      this.reason = `Тыл стороны «${side === 'blue' ? 'Велнария' : 'Кардагор'}» не выдержал: отключения, разрушения и пожары обрушили устойчивость до нуля`;
      sim.msg(this.reason);
    }
    if (!this.winner && !this.prep && !this.endless && sim.time >= this.endAt) {
      const b = this.sides.blue.morale + Math.min(5, this.sides.blue.points / 400), r = this.sides.red.morale + Math.min(5, this.sides.red.points / 400);
      this.winner = Math.abs(b - r) < 3 ? 'draw' : b > r ? 'blue' : 'red';
      this.reason = `Время вышло. Устойчивость тыла: Велнария ${this.sides.blue.morale.toFixed(0)}, Кардагор ${this.sides.red.morale.toFixed(0)}`;
    }
  }
  // ---------- Кампания: фазы эскалации и директивы штаба ----------
  phase() { return this.phaseNo; }
  incomeK() { return PHASES[this.phaseNo].inc; }
  drainK() { return this.endless ? [0.3, 0.45, 0.75][this.phaseNo] : PHASES[this.phaseNo].drain; }
  updateCampaign() {
    const sim = this.sim, t = sim.time;
    // Без ограничения — фазы по прошедшему времени (20 мин, час); иначе — трети партии
    const el = t - this.startAt;
    const ph = this.endless ? (el < 4500 ? 0 : el < 9000 ? 1 : 2) : Math.min(2, Math.floor((el / (this.endAt - this.startAt)) * 3));
    if (ph !== this.phaseNo) {
      this.phaseNo = ph;
      sim.msg(`${PHASES[ph].name}: доход ×${PHASES[ph].inc}, удары по тылу болезненнее${this.endless ? '' : ` (×${this.drainK()})`}`);
    }
    for (const side of ['blue', 'red']) {
      const D = this.directive[side];
      const enemy = side === 'blue' ? 'red' : 'blue';
      if (D && !D.done && t > D.until) {
        D.done = 'fail';
        this.sides[enemy].morale = Math.min(100, this.sides[enemy].morale + 3);
        sim.msg(`Директива не выполнена: ${this.obj(D.oid).name} уцелел`, side);
        sim.msg(`Удар противника по объекту «${this.obj(D.oid).name}» сорван — устойчивость +3`, enemy);
      }
    }
    if (false && t >= this.nextDirective) { // директивы штаба отключены (по просьбе игрока)
      this.nextDirective = t + 300;
      for (const side of ['blue', 'red']) {
        const enemy = side === 'blue' ? 'red' : 'blue';
        const W = { tpp: 3, ps330: 4, ps110: 3, hpp: 2.5, chp: 2.5, wpp: 1, spp: 1, bridge: 2, oil: 2, ammo: 1.5, factory: 2, hub: 2, launch: 1.5 };
        const cands = this.objs(enemy).filter((o) => W[o.kind] && (o.kind !== 'bridge' || o.btype === 'rail' || o.btype === 'highway') && o.comps.some((c) => c.state === 'ok'));
        if (!cands.length) continue;
        const o = sim.rng.weighted(cands.map((q) => [q, W[q.kind]]));
        const bonus = Math.round(150 * this.incomeK());
        this.directive[side] = { oid: o.id, until: t + 360, done: null, bonus };
        sim.msg(`Директива штаба: поразить «${o.name}» за 6 минут — премия ${bonus} оч. и −6 к устойчивости противника`, side);
        sim.msg(`Разведка: противник готовит удар по объекту «${o.name}» — усильте ПВО (продержаться 6 минут: +3 к устойчивости)`, enemy);
      }
    }
  }
  // Устойчивость тыла: отключения, мосты, пустые магазины, пожары, погранпереход
  moraleTick(side, dt) {
    const S = this.sides[side], L = this.logi.side[side];
    const k = this.drainK();
    let burning = 0;
    for (const o of this.objs(side)) for (const c of o.comps) if (c.fire > 0) burning++;
    const br = this.objs(side, 'bridge').filter((b) => b.btype !== 'village' && b.btype !== 'dirt');
    const brDown = br.length ? br.filter((b) => this.bridgeCap(b) === 0).length / br.length : 0;
    const shops = [...L.markets, ...L.fuels];
    const empty = shops.length ? shops.filter((m) => m.stock < 1 || !m.comps.some((c) => c.state !== 'destroyed')).length / shops.length : 0;
    const borderDown = !L.border.comps.some((c) => c.state !== 'destroyed');
    const parts = { power: Math.max(0, (S.powerLoss ?? 1 - S.supply) - (this.endless ? 0.1 : 0)) * 6, bridges: brDown * 2, shops: Math.max(0, empty - 0.5) * 4, fires: Math.min(2, burning * 0.25), border: borderDown ? 1 : 0, water: (this.infra?.side[side].noWater || 0) * 1.5 };
    let drain = 0;
    for (const key in parts) { parts[key] *= k; drain += parts[key]; }
    // восстановление: когда свет есть и пожаров мало — тем быстрее, чем сильнее тыл просел
    // (в долгой партии тыл «отходит» между волнами ударов)
    const lack = (100 - S.morale) / 100;
    let regen = S.supply > 0.93 && burning === 0 ? 1.5 : S.supply > 0.8 ? 0.6 : 0;
    if (this.endless && S.supply > 0.85) regen += 2.5 * lack / (1 + burning * 0.15);
    S.moraleParts = { ...parts, regen };
    S.morale = Math.max(0, Math.min(100, S.morale + ((regen - drain) * dt) / 60));
  }
  shock(side, v, why) {
    const S = this.sides[side];
    S.morale = Math.max(0, S.morale - v * this.drainK());
    void why;
  }
  integrity(side) {
    let n = 0, ok = 0;
    for (const o of this.objs(side)) for (const c of o.comps) { n++; ok += c.state === 'ok' ? 1 : c.state === 'damaged' ? 0.5 : 0; }
    return n ? ok / n : 1;
  }
  pendingCost(side) {
    let min = Infinity, n = 0, sum = 0;
    for (const o of this.objs(side)) for (const c of o.comps) if (c.state === 'destroyed') { const k = this.repairCost(side, c); if (k > 0) { n++; sum += k; min = Math.min(min, k); } }
    return { min, n, sum };
  }
  // Бригады на зарплате: работа бесплатна. Платим один раз — за оборудование взамен уничтоженного
  // (новый трансформатор, пролёт, резервуар…); провод ЛЭП и повреждения чинят своими силами.
  // Резервный автотрансформатор со склада ставится бесплатно
  repairCost(side, c) {
    if (c.pylons) return 0;
    const C = COMP[c.k];
    if (c.state !== 'destroyed') return 0;
    if (C.spare && this.sides[side].spare > 0) return 0;
    return Math.max(5, Math.round(C.cost * REPAIR_K * 0.8 * (this.state ? this.state.k(side, 'repairCost') : 1)));
  }
  repairTime(side, c) {
    if (c.pylons) return 90;
    const C = COMP[c.k];
    let t = C.time * REPAIR_T * (c.state === 'destroyed' ? 1 : 0.4);
    if (C.spare && c.state === 'destroyed' && this.sides[side].spare <= 0) t *= 1.6;
    const S = this.sides[side];
    t *= 1 + (1 - (S.oil ?? 1)) * 0.3; // без топлива техника бригад простаивает
    const reg = this.infra && !c.pylons && ['tpp', 'ps330', 'ps110', 'hpp', 'chp', 'wpp', 'spp', 'solar'].includes(c.obj?.kind) && this.infra.specAt(side, c.x, c.y) === 'energy' ? 0.8 : 1;
    return t * reg * (this.state ? this.state.k(side, 'repairTime') : 1);
  }
  farBank(c) {
    const side = c.obj?.side ?? c.side;
    const x = c.x ?? c.pylons?.[0]?.x, y = c.y ?? c.pylons?.[0]?.y;
    const river = this.world.water.items.find((w) => w.kind === 'river' && w.name === DW_NAMES[side].river);
    if (!river) return false;
    const rp = river.line.reduce((a, p) => (Math.abs(p[1] - y) < Math.abs(a[1] - y) ? p : a));
    return side === 'blue' ? x > rp[0] : x < rp[0];
  }
  bridgeCap(b) {
    if (!b) return 1;
    const spans = b.comps.filter((c) => c.k === 'span');
    const cap = spans.some((c) => c.state === 'destroyed') ? 0 : spans.some((c) => c.state === 'damaged') ? 0.5 : 1;
    if (cap >= 0.5) return cap;
    // понтонная переправа рядом: машины идут медленно, но идут
    if (b.pontoon === undefined || this.sim.time > (b._pT || 0)) { b._pT = this.sim.time + 5; b.pontoon = this.objects.find((o) => o.kind === 'pontoon' && o.bridge === b.id) || null; }
    const p = b.pontoon;
    return p && !(p.build && !p.build.up) && p.comps.some((c) => c.state !== 'destroyed') ? 0.4 : cap;
  }

  // ---------- Ремонт ----------
  // Ремонт: бригада — машина с ремонтной базы. Едет по дорогам (через целые мосты), ждёт пожарных,
  // работает (оплата по ходу работ: нет денег — пауза), затем берёт следующий узел или возвращается.
  updateRepairs() {
    const sim = this.sim;
    for (const side of ['blue', 'red']) {
      const S = this.sides[side];
      if (S.auto && !this.prep) {
        const busy = new Set(S.crews.map((w) => w.job?.id).filter(Boolean));
        const want = [];
        for (const o of this.objs(side)) for (const c of o.comps) if (c.state !== 'ok' && !S.queue.includes(c.id) && !busy.has(c.id)) want.push(c);
        for (const l of this.lines) if (l.side === side && l.cut && !S.queue.includes(l.id) && !busy.has(l.id)) want.push(l);
        want.sort((a, b) => this.priority(b) - this.priority(a));
        S.queue.push(...want.map((c) => c.id));
      }
      for (const crew of S.crews) {
        if (crew.job || crew.veh) continue;
        const job = this.nextJob(side);
        if (!job) break;
        const base = this.logi.baseNear(side, job.pos[0], job.pos[1]);
        if (!base) { S.queue.unshift(job.qid); break; } // все базы разрушены — бригады не выезжают
        const v = this.logi.spawn(side, 'crew', this.logi.gate(base), job.pos, { type: 'repair', crew: crew.id });
        if (!v) { const bc = this.comps.get(job.id) || this.lines.find((l) => l.id === job.id); if (bc) bc.blockedUntil = sim.time + 60; S.queue.push(job.qid); continue; }
        crew.job = job; crew.veh = v;
        job.state = 'travel';
      }
    }
  }
  // Следующая работа из очереди (до которой можно доехать)
  nextJob(side) {
    const S = this.sides[side];
    for (let qi = 0; qi < S.queue.length; qi++) {
      const id = S.queue[qi];
      const kind = typeof id === 'string' && id.startsWith('S') ? 'shelter' : typeof id === 'string' && id.startsWith('R') ? 'net' : typeof id === 'string' && id.startsWith('T') ? 'tp' : 'repair';
      const c = kind === 'shelter' ? this.comps.get(id.slice(1)) : kind === 'net' ? this.nets.find((n) => n.id === id) : kind === 'tp' ? this.world.power.tps[+id.slice(1)] : this.comps.get(id) || this.lines.find((l) => l.id === id);
      const need = c && (kind === 'shelter' ? !!shelterDef(c, c.shelter + 1) : kind === 'net' ? !c.done : kind === 'tp' ? !c.alive : c.pylons ? !!c.cut : c.state !== 'ok');
      if (!need) { S.queue.splice(qi--, 1); continue; }
      if (c.blockedUntil && this.sim.time < c.blockedUntil) continue;
      const shelter = kind === 'shelter';
      const level = shelter ? c.shelter + 1 : 0;
      const cost = shelter ? shelterDef(c, level).cost : kind === 'net' ? NET_ROAD.cost : kind === 'tp' ? 0 : this.repairCost(side, c);
      // оборудование и материалы оплачиваются при выезде; нет денег — узел ждёт, бригада берёт следующий
      if (cost > S.points) { c.waitFunds = cost; continue; }
      c.waitFunds = 0;
      S.queue.splice(qi, 1);
      if (cost) { const pay = this.infra ? this.infra.matPrice(side, cost, true) : cost; S.points -= pay; S.stats.spent += pay; } // стройматериалы — скидка
      const total = shelter ? shelterDef(c, level).time : kind === 'net' ? NET_ROAD.time : kind === 'tp' ? 90 : this.repairTime(side, c);
      const pos = c.pylons ? [c.cut.x, c.cut.y] : [c.x, c.y];
      return { id: kind === 'tp' ? id : c.id, qid: id, kind, shelter, level, cost, total, left: total, paid: 0, pos, state: 'travel' };
    }
    return null;
  }
  crewOf(v) { return this.sides[v.side].crews.find((w) => w.veh === v); }
  crewWork(v, dt) {
    const sim = this.sim, side = v.side, S = this.sides[side];
    const crew = this.crewOf(v);
    const j = crew?.job;
    if (!j) { const b = this.logi.baseNear(side, v.x, v.y); if (!b || !this.logi.send(v, this.logi.gate(b), 'back')) this.logi.home(v); return; }
    const c = j.kind === 'tp' ? this.world.power.tps[+j.id.slice(1)] : j.kind === 'net' ? this.nets.find((n) => n.id === j.id) : j.shelter ? this.comps.get(j.id) : this.comps.get(j.id) || this.lines.find((l) => l.id === j.id);
    if (!c) { crew.job = null; this.crewNext(v, crew); return; }
    if (c.fire > 0) { j.state = 'waitfire'; return; } // тушат пожарные
    j.state = 'work';
    j.left -= dt;
    if (j.left > 0) return;
    if (j.kind === 'tp') { c.alive = true; this.world.power.version++; sim.msg('ТП восстановлена — свет в квартале', side); }
    else if (j.kind === 'net') { c.done = true; sim.msg(`${NET_ROAD.name} — готова`, side); }
    else if (j.shelter) { c.shelter = j.level; sim.msg(`${shelterDef(c, j.level).name}: ${c.name} (${c.obj.name}) — готово`, side); }
    else if (c.pylons) { c.cut = null; this.world.power.version++; sim.msg(`ЛЭП ${c.kv} кВ восстановлена`, side); }
    else {
      if (COMP[c.k].spare && c.state === 'destroyed' && S.spare > 0) S.spare--;
      if (c.state === 'destroyed') c.rebuilt = true;
      c.state = 'ok'; c.hp = 1; c.burned = false;
      sim.msg(`Отремонтировано: ${c.name} (${c.obj.name})`, side);
    }
    S.stats.repairs++;
    this.flowTimer = 0;
    crew.job = null;
    this.crewNext(v, crew);
  }
  // После работы — сразу к следующему узлу, иначе на базу
  crewNext(v, crew) {
    const job = this.nextJob(v.side);
    // Следующий узел рядом — едем сразу; далеко — пусть едет бригада с ближайшей базы
    const base = job && this.logi.baseNear(v.side, job.pos[0], job.pos[1]);
    const near = job && hyp(job.pos[0] - v.x, job.pos[1] - v.y) < Math.max(4000, base ? hyp(job.pos[0] - base.x, job.pos[1] - base.y) : 0);
    if (job && near && this.logi.send(v, job.pos)) { crew.job = job; v.task = { type: 'repair', crew: crew.id }; return; }
    if (job) this.sides[v.side].queue.unshift(job.qid);
    const b = this.logi.baseNear(v.side, v.x, v.y);
    if (!b || !this.logi.send(v, this.logi.gate(b), 'back')) this.logi.home(v);
  }
  crewHome(v) { const crew = this.crewOf(v); if (crew) { if (crew.job) this.sides[v.side].queue.unshift(crew.job.qid); crew.job = null; crew.veh = null; } }
  crewLost(v) {
    const S = this.sides[v.side];
    const crew = this.crewOf(v);
    if (!crew) return;
    if (crew.job) S.queue.unshift(crew.job.qid);
    S.crews = S.crews.filter((w) => w !== crew);
    this.sim.msg(`Потеряна ремонтная бригада №${crew.id}`, v.side);
  }
  adType(a) { return DW_AD[a.type]; }
  // Пополнение позиции ПВО привезённым грузом (перехватчики — по 3 очка)
  restockAD(a) {
    const T = DW_AD[a.type], S = this.sides[a.side];
    if (T.ammo) a.ammo = T.ammo;
    if (a.mMax) a.missiles = a.mMax;
    if (T.stock) { const n = Math.min(T.stock - a.stock, Math.floor(S.points / 3)); a.stock += n; S.points -= n * 3; }
    this.sim.msg(`${a.name}: подвезли боеприпасы`, a.side);
  }
  priority(c) {
    if (c.pylons) return c.kv >= 330 ? 70 : 55;
    const k = c.k, o = c.obj;
    const base = { at: 100, gsu: 95, unit: 90, oru: 88, tr: 85, ctrl: 60, span: 65, coal: 50, chimney: 45, tower: 40, launcher: 35, shop: 30, tank: 25, pump: 25, rack: 15, bunker: 20, store: 10, hall: 30, mall: 25, kiosk: 12, garage: 35, canopy: 15 }[k] || 10;
    return base + (o.kind === 'ps110' && o.city === 0 ? 5 : 0) - (c.state === 'damaged' ? 0 : 3);
  }

  // ---------- Пожары ----------
  updateFires(dt) {
    for (const c of this.comps.values()) {
      if (c.fire <= 0) continue;
      c.fire -= dt * 0.4; // без пожарных выгорает долго (тушение — см. логистику)
      // Горящий резервуар может поджечь соседний
      if (c.k === 'tank' && this.sim.rng.chance(dt * 0.004)) {
        for (const n of c.obj.comps) if (n !== c && n.k === 'tank' && n.fire <= 0 && n.state !== 'destroyed' && hyp(n.x - c.x, n.y - c.y) < 45) {
          n.fire = 200 + this.sim.rng.float(0, 150); n.state = 'damaged'; n.hp = Math.min(n.hp, 0.5);
          this.sim.msg(`${c.obj.name}: огонь перекинулся на ${n.name}`, c.obj.side);
          break;
        }
      }
      // Детонация боеприпасов в хранилище
      if (c.k === 'bunker' && c.state !== 'ok' && this.sim.rng.chance(dt * 0.25)) {
        const a = this.sim.rng.float(0, Math.PI * 2), r = this.sim.rng.float(0, 30);
        this.sim.art.explode(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, this.sim.rng.chance(0.2) ? '152' : '82', 'ground', null, true);
      }
      if (c.fire <= 0) { c.fire = 0; if (c.state !== 'ok') c.burned = true; }
    }
  }

  // ---------- ПВО ----------
  updateAD(dt) {
    const sim = this.sim;
    for (const a of this.ad) {
      if (a.dead) continue;
      const T = DW_AD[a.type];
      if (a.state === 'deploying' && sim.time >= a.until) { a.state = 'ready'; sim.msg(`${a.name}: готов к работе`, a.side); }
      if (a.state === 'moving') {
        const dx = a.dest.x - a.x, dy = a.dest.y - a.y, d = hyp(dx, dy);
        const v = T.mobile * (0.7 + 0.3 * (this.sides[a.side].oil ?? 1));
        if (d < v * dt) { a.x = a.dest.x; a.y = a.dest.y; a.state = 'deploying'; a.until = sim.time + T.deploy * 0.6; a.dest = null; }
        else { a.x += (dx / d) * v * dt; a.y += (dy / d) * v * dt; a.heading = Math.atan2(dy, dx); }
        continue;
      }
      if (a.state !== 'ready') continue;
      a.cd -= dt;
      if (a.type === 'ew' || a.type === 'ewd' || a.type === 'acoustic' || a.type === 'radar') continue;
      this.engage(a, T, dt);
    }
    this.ad = this.ad.filter((a) => !a.dead || sim.time - a.deadAt < 600);
  }

  engage(a, T, dt) {
    const sim = this.sim;
    const night = 1 - daylight(sim.tod());
    // Цели: вражеские дроны, которые видит сторона (кроме своих перехватчиков)
    let best = null, bs = Infinity;
    for (const d of this.drones) {
      if (d.dead || d.side === a.side || d.state === 'wait' || d.alt < 5) continue;
      if (!d.seen[a.side] || sim.time - d.seen[a.side] > 3) continue;
      const D = DW_DRONES[d.type];
      if (D.cls === 'interceptor') continue;
      const dist = hyp(d.x - a.x, d.y - a.y);
      const rng = a.type === 'spaag' && a.missiles > 0 ? T.mRange : T.range;
      if (dist > rng || d.alt > (T.maxAlt || 99999)) continue;
      if (a.type === 'sam' && a.roe !== 'all') {
        // Беречь ракеты: только реактивные или те, что идут к важным объектам
        const threat = D.speed > 80 || this.objs(a.side).some((o) => ['tpp', 'ps330', 'ps110', 'bridge', 'hpp', 'chp'].includes(o.kind) && hyp(o.x - d.x, o.y - d.y) < 5000);
        if (!threat) continue;
      }
      if (a.type === 'icpt' && this.drones.filter((q) => q.hunt === d.id && !q.dead).length >= 2) continue;
      if (a.type === 'sam' && this.missiles.some((m) => m.target === d.id)) continue;
      const s = dist * (d.aimed ? 0.5 : 1);
      if (s < bs) { bs = s; best = d; }
    }
    if (!best) { a.target = null; return; }
    const d = best, D = DW_DRONES[d.type];
    const dist = hyp(d.x - a.x, d.y - a.y);
    a.aim = Math.atan2(d.y - a.y, d.x - a.x);
    a.target = d.id;
    const cued = sim.time - (d.cued?.[a.side] || -99) < 30;
    if (a.type === 'mog') {
      if (dist > T.range || a.ammo <= 0) return;
      a.ammo -= dt;
      // Пулемёт с прожектором и тепловизором: хорош по медленным низким целям
      const fs = Math.max(0.2, Math.min(1.1, 55 / D.speed));
      const fa = d.alt < 400 ? 1 : d.alt < 900 ? 0.6 : 0.3;
      const fn = 1 - night * 0.2;
      const p = 0.022 * PACE * AD_EFF[a.side] * this.state.k(a.side, 'adEff') * fs * fa * fn * (cued ? 1 : 0.55) * (1 - dist / (T.range * 1.3));
      a.fireT = sim.time;
      this.fx.push({ t: 'tracer', x0: a.x, y0: a.y, x1: d.x + sim.rng.float(-25, 25), y1: d.y + sim.rng.float(-25, 25), alt: d.alt, t0: sim.time, side: a.side });
      if (sim.rng.chance(p * dt)) this.kill(d, a, 'пулемётным огнём');
    } else if (a.type === 'spaag') {
      if (a.missiles > 0 && dist > T.range && a.cd <= 0) { this.fireMissile(a, d, T.mCost); a.missiles--; a.cd = 4; return; }
      if (dist > T.range || a.ammo <= 0) return;
      const fs = Math.max(0.35, Math.min(1, 80 / D.speed));
      const p = 0.034 * PACE * AD_EFF[a.side] * this.state.k(a.side, 'adEff') * fs * (1 - dist / (T.range * 1.2));
      a.fireT = sim.time;
      a.ammo -= dt;
      this.fx.push({ t: 'tracer', x0: a.x, y0: a.y, x1: d.x, y1: d.y, alt: d.alt, t0: sim.time, side: a.side, heavy: true });
      if (sim.rng.chance(p * dt)) this.kill(d, a, 'зенитной артиллерией');
    } else if (a.type === 'sam') {
      if (a.missiles <= 0 || a.cd > 0) return;
      this.fireMissile(a, d, T.mCost);
      a.missiles--;
      a.cd = 6;
    } else if (a.type === 'icpt') {
      if (a.stock <= 0 || a.cd > 0) return;
      a.stock--;
      a.cd = 5;
      const type = a.side === 'blue' ? 'sting' : 'elka';
      this.drones.push({
        id: nextId++, side: a.side, type, x: a.x, y: a.y, alt: 20, heading: a.aim, speed: DW_DRONES[type].speed, state: 'hunt', t0: sim.time,
        hunt: d.id, route: [], tx: d.x, ty: d.y, cruise: d.alt, drift: [0, 0], dead: false, seen: {}, ew: 0, trail: [], hp: 1, until: sim.time + 360, from: a.id,
      });
      void D;
    }
  }

  fireMissile(a, d, cost) {
    const S = this.sides[a.side];
    S.points -= cost;
    S.stats.spent += cost;
    a.fireT = this.sim.time;
    this.missiles.push({ x: a.x, y: a.y, alt: 5, target: d.id, side: a.side, from: a.id, speed: 750, t0: this.sim.time, trail: [] });
  }

  updateMissiles(dt) {
    for (const m of this.missiles) {
      if (m.dead) continue;
      const d = this.drones.find((q) => q.id === m.target);
      if (!d || d.dead) { m.dead = true; this.fx.push({ t: 'airburst', x: m.x, y: m.y, alt: m.alt, t0: this.sim.time, small: true }); continue; }
      const dx = d.x - m.x, dy = d.y - m.y, dz = d.alt - m.alt, dist = hyp(dx, dy, dz);
      const step = m.speed * dt;
      m.trail.push([m.x, m.y, m.alt]);
      if (m.trail.length > 30) m.trail.shift();
      if (dist < step + 20) {
        m.dead = true;
        if (this.sim.rng.chance((DW_DRONES[d.type].rcs < 0.3 ? 0.6 : 0.8) * (m.side === 'blue' ? 1.1 : 1))) this.kill(d, this.ad.find((q) => q.id === m.from), 'ракетой ЗРК');
        else this.fx.push({ t: 'airburst', x: d.x, y: d.y, alt: d.alt, t0: this.sim.time, small: true });
        continue;
      }
      m.x += (dx / dist) * step; m.y += (dy / dist) * step; m.alt += (dz / dist) * step;
      if (this.sim.time - m.t0 > 40) m.dead = true;
    }
    this.missiles = this.missiles.filter((m) => !m.dead);
  }

  // Дрон сбит: обломки падают; с боевой частью на малой высоте — может взорваться на земле
  kill(d, by, how) {
    const sim = this.sim;
    if (d.dead) return;
    // память о потерях: сколько дронов сбили на подлёте к цели (для ИИ)
    if (d.oid != null) { const m = (this.lossLog = this.lossLog || { blue: {}, red: {} })[d.side]; m[d.oid] = (m[d.oid] || 0) + 1; }
    d.dead = true;
    d.deadAt = sim.time;
    const D = DW_DRONES[d.type];
    this.fx.push({ t: 'airburst', x: d.x, y: d.y, alt: d.alt, t0: sim.time });
    if (by) by.kills = (by.kills || 0) + 1;
    const defSide = by?.side || (d.side === 'blue' ? 'red' : 'blue');
    this.sides[defSide].stats.shot++;
    if (D.cls === 'strike' && !this.prep) this.sides[defSide].morale = Math.min(100, this.sides[defSide].morale + 0.08); // сбитые над городом — поддержка тыла
    const decoy = D.cls === 'decoy';
    if (by) sim.msg(`${by.name}: сбит ${decoy ? 'дрон — оказалась ложная цель «Гербера»' : D.short} ${how}`, by.side);
    if (D.wh >= 10 && sim.rng.chance(d.alt < 600 ? 0.4 : 0.15)) {
      // Обломки с боевой частью падают на землю
      const fx = d.x + Math.cos(d.heading) * d.alt * 0.3, fy = d.y + Math.sin(d.heading) * d.alt * 0.3;
      this.falling = this.falling || [];
      this.falling.push({ x: fx, y: fy, at: sim.time + Math.sqrt(d.alt / 4.9) * 0.6, wh: D.wh * 0.6, side: d.side });
    }
  }

  // ---------- Полёт ----------
  updateDrones(dt) {
    const sim = this.sim;
    const ews = this.ad.filter((a) => !a.dead && (a.type === 'ew' || a.type === 'ewd') && a.state === 'ready');
    for (const f of this.falling || []) if (!f.done && sim.time >= f.at) { f.done = true; this.impact({ side: f.side, type: 'debris', wh: f.wh }, f.x, f.y, true); }
    if (this.falling) this.falling = this.falling.filter((f) => !f.done);
    for (const d of this.drones) {
      if (d.dead) continue;
      const D = DW_DRONES[d.type];
      if (d.state === 'wait') { if (sim.time >= d.t0) { d.state = D.cls === 'recon' ? 'fly' : d.state === 'wait' ? 'fly' : d.state; } else continue; }
      if (sim.time > d.until) { d.dead = true; d.deadAt = sim.time; if (D.cls === 'recon') sim.msg(`${D.short}: вернулся — батарея на исходе`, d.side); else if (D.cls === 'hunter') { this.fx.push({ t: 'fall', x: d.x, y: d.y, alt: d.alt, t0: sim.time }); sim.msg(`${D.short}: топливо кончилось, целей не найдено`, d.side); } continue; }
      // РЭБ: сбой навигации (дрейф), потеря связи у барражирующих и разведчиков
      let jam = 0;
      for (const e of ews) { const R = DW_AD[e.type].range; if (e.side !== d.side && hyp(e.x - d.x, e.y - d.y) < R) jam = Math.max(jam, 1 - hyp(e.x - d.x, e.y - d.y) / R * 0.5); }
      if (jam > 0 && D.cls !== 'interceptor') {
        d.ew += dt;
        const k = (1 - D.ew) * jam;
        d.drift[0] += sim.rng.gauss(0, 1) * k * 9 * dt + Math.cos(d.heading + 1.3) * k * 4 * dt;
        d.drift[1] += sim.rng.gauss(0, 1) * k * 9 * dt + Math.sin(d.heading + 1.3) * k * 4 * dt;
        if ((D.cls === 'loiter' || D.cls === 'recon') && sim.rng.chance(k * 0.12 * dt)) {
          if (D.cls === 'recon') { d.state = 'rtb'; } else { d.dead = true; d.deadAt = sim.time; this.fx.push({ t: 'fall', x: d.x, y: d.y, alt: d.alt, t0: sim.time }); sim.msg(`${D.short}: потеря связи в зоне РЭБ`, d.side); continue; }
        }
        if (D.cls !== 'recon' && sim.rng.chance(k * 0.006 * dt)) { d.dead = true; d.deadAt = sim.time; this.fx.push({ t: 'fall', x: d.x, y: d.y, alt: d.alt, t0: sim.time }); this.falling = this.falling || []; if (D.wh) this.falling.push({ x: d.x, y: d.y, at: sim.time + 8, wh: D.wh, side: d.side }); continue; }
      }
      if (D.cls === 'interceptor') { this.flyInterceptor(d, D, dt); continue; }
      if (D.cls === 'recon') { this.flyRecon(d, D, dt); continue; }
      if (D.cls === 'hunter' && !d.vehTarget) { this.flyHunter(d, D, dt); continue; }
      // Цель — позиция ПВО: следим за её последним известным местом
      if (d.adTarget) {
        const t = this.ad.find((q) => q.id === d.adTarget);
        if (t && !t.dead && t.spotted[d.side] && sim.time - t.spotted[d.side] < 120) { d.tx = t.x; d.ty = t.y; d.aimX = t.x; d.aimY = t.y; }
      }
      if (d.vehTarget) {
        // Машина едет: оператор ведёт её, пока видно (своя разведка или камера самого боеприпаса)
        const v = this.logi.vehicles.find((q) => q.id === d.vehTarget);
        if (v && !v.dead && (hyp(v.x - d.x, v.y - d.y) < 2500 || sim.time - (v.spotted[d.side] || -999) < 60)) { d.tx = v.x; d.ty = v.y; d.aimX = v.x; d.aimY = v.y; d.route.length = 0; }
        else if (D.cls === 'hunter') { d.vehTarget = null; d.tx = d.home?.[0] ?? d.x; d.ty = d.home?.[1] ?? d.y; d.wp = null; continue; } // цель уничтожена или потеряна — снова патруль
      }
      const wp = d.route.length ? d.route[0] : { x: d.aimX + d.drift[0], y: d.aimY + d.drift[1] };
      const dx = wp.x - d.x, dy = wp.y - d.y, dist = hyp(dx, dy);
      let v = D.speed * PACE;
      // Профиль высоты: набор после старта, крейсер, пикирование на последних 1.5 км
      const toTarget = hyp(d.aimX + d.drift[0] - d.x, d.aimY + d.drift[1] - d.y);
      let wantAlt = d.cruise;
      if (!d.route.length && toTarget < 1500 && D.cls !== 'decoy') { wantAlt = Math.min(d.cruise, toTarget * 0.9); v *= 1.35; d.aimed = true; }
      d.alt += Math.max(-60 * dt, Math.min(18 * dt, wantAlt - d.alt));
      // Плавный разворот
      const want = Math.atan2(dy, dx);
      let dh = Math.atan2(Math.sin(want - d.heading), Math.cos(want - d.heading));
      d.heading += Math.max(-0.5 * dt, Math.min(0.5 * dt, dh)) * (dist < 300 ? 3 : 1);
      if (Math.abs(dh) > 1.2 && dist < 200) d.heading = want;
      d.x += Math.cos(d.heading) * v * dt;
      d.y += Math.sin(d.heading) * v * dt;
      d.speed = v;
      d.trail.push([d.x, d.y]);
      if (d.trail.length > 40) d.trail.shift();
      if (d.route.length && dist < 150) d.route.shift();
      else if (!d.route.length && dist < Math.max(12, v * dt * 1.5)) {
        if (D.cls === 'decoy') { d.dead = true; d.deadAt = sim.time; this.fx.push({ t: 'fall', x: d.x, y: d.y, alt: 0, t0: sim.time }); continue; }
        this.impact(d, d.x, d.y);
      }
      if (d.x < -500 || d.y < -500 || d.x > this.world.W + 500 || d.y > this.world.H + 500) d.dead = true;
    }
    this.drones = this.drones.filter((d) => !d.dead || sim.time - d.deadAt < 3);
  }

  flyInterceptor(d, D, dt) {
    const sim = this.sim;
    const t = this.drones.find((q) => q.id === d.hunt);
    if (!t || t.dead) {
      // Цель уничтожена — ищем другую рядом
      const n = this.drones.filter((q) => !q.dead && q.side !== d.side && q.seen[d.side] && DW_DRONES[q.type].cls !== 'interceptor' && hyp(q.x - d.x, q.y - d.y) < 3000)[0];
      if (n) d.hunt = n.id; else { d.dead = true; d.deadAt = sim.time; return; }
      return;
    }
    const dx = t.x - d.x, dy = t.y - d.y, dz = t.alt - d.alt, dist = hyp(dx, dy);
    // Перехват с упреждением
    const lead = dist / Math.max(20, D.speed * PACE);
    const px = t.x + Math.cos(t.heading) * t.speed * lead, py = t.y + Math.sin(t.heading) * t.speed * lead;
    d.heading = Math.atan2(py - d.y, px - d.x);
    d.x += Math.cos(d.heading) * D.speed * PACE * dt; d.y += Math.sin(d.heading) * D.speed * PACE * dt;
    d.alt += Math.max(-25 * dt, Math.min(25 * dt, dz));
    d.trail.push([d.x, d.y]); if (d.trail.length > 25) d.trail.shift();
    if (hyp(t.x - d.x, t.y - d.y, t.alt - d.alt) < 30) {
      const TD = DW_DRONES[t.type];
      const p = (DW_DRONES[t.type].speed > D.speed * 0.95 ? 0.2 : 0.55) * AD_EFF[d.side];
      d.dead = true; d.deadAt = sim.time;
      if (sim.rng.chance(p)) this.kill(t, { side: d.side, name: D.short, kills: 0 }, 'дроном-перехватчиком');
      else { this.fx.push({ t: 'airburst', x: d.x, y: d.y, alt: d.alt, t0: sim.time, small: true }); void TD; }
    }
  }

  // Охотник с ИИ: долетает до района, патрулирует дороги (от узла к узлу), по камере находит машины
  // противника (фуры, бензовозы, развозные и грузовики снабжения — не пожарных и не ремонтников)
  // и переходит в атаку; цель потеряна — снова патруль
  flyHunter(d, D, dt) {
    const sim = this.sim, R = this.logi.roads;
    const inArea = hyp(d.x - d.tx, d.y - d.ty) < 3500;
    if (!d.wp || hyp(d.wp[0] - d.x, d.wp[1] - d.y) < 120) {
      if (d.route.length && !inArea) { const p = d.route.shift(); d.wp = [p.x, p.y]; }
      else if (!inArea) d.wp = [d.tx, d.ty];
      else {
        const ids = R.near(d.tx + sim.rng.float(-2500, 2500), d.ty + sim.rng.float(-2500, 2500), 900);
        const id = ids.length ? ids[sim.rng.int(0, ids.length - 1)] : -1;
        d.wp = id >= 0 ? [R.x[id], R.y[id]] : [d.tx + sim.rng.float(-1500, 1500), d.ty + sim.rng.float(-1500, 1500)];
        d.state = 'loiter';
      }
    }
    const want = Math.atan2(d.wp[1] - d.y, d.wp[0] - d.x);
    const dh = Math.atan2(Math.sin(want - d.heading), Math.cos(want - d.heading));
    d.heading += Math.max(-0.6 * dt, Math.min(0.6 * dt, dh));
    const v = D.speed * PACE * (d.state === 'loiter' ? 0.8 : 1);
    d.x += Math.cos(d.heading) * v * dt; d.y += Math.sin(d.heading) * v * dt; d.speed = v;
    d.alt += Math.max(-20 * dt, Math.min(12 * dt, d.cruise - d.alt));
    d.trail.push([d.x, d.y]); if (d.trail.length > 40) d.trail.shift();
    // поиск целей: камера (ночью — тепловизор, дальность меньше)
    d.scanT = (d.scanT || 0) - dt;
    if (d.scanT > 0 || !inArea) return;
    d.scanT = 1;
    const night = 1 - daylight(sim.tod());
    const Rs = D.spot * (1 - night * 0.3);
    let best = null, bd = Rs;
    for (const q of this.logi.vehicles) {
      if (q.dead || q.side === d.side || q.kind === 'crew' || q.kind === 'fire') continue;
      const dd = hyp(q.x - d.x, q.y - d.y);
      if (dd < bd) { bd = dd; best = q; }
    }
    if (best) {
      d.vehTarget = best.id; d.aimX = best.x; d.aimY = best.y; d.tx = best.x; d.ty = best.y; d.route.length = 0; d.state = 'fly';
      best.spotted[d.side] = sim.time;
      sim.msg(`${D.short}: ИИ опознал цель — ${VEH[best.kind].name.toLowerCase()}, атакует`, d.side);
    }
  }

  flyRecon(d, D, dt) {
    const sim = this.sim;
    const home = this.launchPoints(d.side, D)[0];
    let gx, gy;
    if (d.state === 'rtb' || sim.time > d.until - 200) { gx = home.x; gy = home.y; d.state = 'rtb'; }
    else if (hyp(d.tx - d.x, d.ty - d.y) < 400 || d.state === 'loiter') {
      d.state = 'loiter';
      d.ang = (d.ang || 0) + dt * (D.speed / 800);
      gx = d.tx + Math.cos(d.ang) * 800; gy = d.ty + Math.sin(d.ang) * 800;
    } else { gx = d.tx; gy = d.ty; }
    const dx = gx - d.x, dy = gy - d.y, dist = hyp(dx, dy);
    const want = Math.atan2(dy, dx);
    const dh = Math.atan2(Math.sin(want - d.heading), Math.cos(want - d.heading));
    d.heading += Math.max(-0.4 * dt, Math.min(0.4 * dt, dh));
    d.x += Math.cos(d.heading) * D.speed * PACE * dt; d.y += Math.sin(d.heading) * D.speed * PACE * dt;
    d.alt += Math.max(-20 * dt, Math.min(8 * dt, d.cruise - d.alt));
    d.trail.push([d.x, d.y]); if (d.trail.length > 40) d.trail.shift();
    if (d.state === 'rtb' && dist < 150) { d.dead = true; d.deadAt = sim.time; }
    // Разведка: позиции ПВО в радиусе обзора (ночью — тепловизор, дальность меньше)
    const night = 1 - daylight(sim.tod());
    const R = D.spot * (1 - night * 0.35);
    for (const a of this.ad) {
      if (a.dead || a.side === d.side) continue;
      const dd = hyp(a.x - d.x, a.y - d.y);
      // Стреляющие видны дальше (вспышки), замаскированные стоящие — ближе
      if (dd < R * (sim.time - a.fireT < 20 ? 1.5 : a.state === 'moving' ? 1.2 : 0.85)) {
        if (!a.spotted[d.side] || sim.time - a.spotted[d.side] > 60) sim.msg(`${D.short}: обнаружена позиция — ${a.name}`, d.side);
        a.spotted[d.side] = sim.time;
        a.spotX = a.spotX || {}; a.spotX[d.side] = [a.x, a.y];
      }
    }
    for (const v of this.logi.vehicles) if (!v.dead && v.side !== d.side && hyp(v.x - d.x, v.y - d.y) < R) v.spotted[d.side] = sim.time;
  }

  // Подрыв: урон узлам в радиусе, эффект на местности (воронка, дома, пожар)
  impact(d, x, y, debris = false) {
    const sim = this.sim;
    const D = DW_DRONES[d.type] || { wh: d.wh, short: 'обломки' };
    const wh = d.wh ?? D.wh;
    if (!debris) { d.dead = true; d.deadAt = sim.time; }
    const cal = wh >= 90 ? 'dw105' : wh >= 45 ? 'dw50' : wh >= 15 ? 'dw20' : 'dw3';
    sim.art.explode(x, y, cal, 'ground', d.side, true);
    this.fx.push({ t: 'impact', x, y, wh, t0: sim.time });
    if (wh > 0) { this.econ?.onImpact(x, y, wh); this.state?.onImpact(d.side, x, y); this.infra?.onImpact(x, y, wh); }
    // Радиусы: сплошного поражения и осколочный
    const rl = 3 + wh * 0.13, rf = 8 + wh * 0.45;
    const enemy = d.side === 'blue' ? 'red' : 'blue';
    let hitAny = null;
    for (const o of this.objects) {
      if (hyp(o.x - x, o.y - y) > Math.max(o.w, o.h) / 2 + rf + 10) continue;
      for (const c of o.comps) {
        // Расстояние до прямоугольника узла
        const cs = Math.cos(-c.angle), sn = Math.sin(-c.angle);
        const lx = (x - c.x) * cs - (y - c.y) * sn, ly = (x - c.x) * sn + (y - c.y) * cs;
        const ex = Math.max(0, Math.abs(lx) - c.w / 2), ey = Math.max(0, Math.abs(ly) - c.h / 2);
        const dist = hyp(ex, ey);
        if (dist > rf) continue;
        const C = COMP[c.k];
        let dmg;
        if (dist <= rl) {
          dmg = (wh / 50) * 1.1 / C.hard;
          if (C.net && c.shelter) dmg *= wh <= 25 ? 0.08 : 0.8; // сетка: лёгкий дрон рвётся на ней
          else if (c.shelter >= 2) dmg *= 0.3; // бетонное укрытие
          else if (c.shelter === 1) dmg *= 0.75;
          if (C.big && dist <= 0.5) dmg *= 0.8; // большие объекты теряют часть площади
        } else {
          dmg = (wh / 50) * 0.35 * (1 - (dist - rl) / (rf - rl)) / C.hard;
          if (c.shelter >= 1) dmg *= C.net ? 0.4 : 0.12; // габионы держат осколки
          if (C.big) dmg *= 0.5;
        }
        if (dmg < 0.03) continue;
        this.damageComp(c, dmg, d);
        hitAny = c;
      }
    }
    // Линии: подрыв у опоры рвёт провода
    for (const l of this.lines) {
      if (l.cut) continue;
      for (const p of l.pylons) if (hyp(p.x - x, p.y - y) < rl + 6) { l.cut = { x: p.x, y: p.y }; this.world.power.version++; sim.msg(`Перебита ЛЭП ${l.kv} кВ`, l.side); this.flowTimer = 0; break; }
    }
    // Машины на дорогах
    for (const v of this.logi.vehicles) {
      if (v.dead) continue;
      const dd = hyp(v.x - x, v.y - y);
      let kill = dd < 6 ? 0.95 : dd < rl * 1.5 ? 0.8 : dd < rf ? 0.4 * (1 - dd / rf) : 0;
      if (kill && this.underNet(v.side, v.x, v.y)) kill *= wh <= 25 ? 0.08 : 0.8; // машина под сеткой
      if (kill && sim.rng.chance(kill)) {
        this.sides[v.side].lastLoss = [v.x, v.y]; this.logi.destroy(v, `удар ${D.short}`); if (v.side !== d.side) sim.msg(`${D.short}: уничтожен ${VEH[v.kind].name.toLowerCase()} противника`, d.side); }
    }
    // Мобильные ГТУ
    for (const gt of this.gens) {
      if (gt.dead) continue;
      const dd = hyp(gt.x - x, gt.y - y);
      if (dd < rl * 1.4 || (dd < rf && sim.rng.chance(0.4 * (1 - dd / rf)))) { gt.dead = true; gt.deadAt = sim.time; this.flowTimer = 0; sim.msg(`${GTU.name} у ${this.obj(gt.ps)?.name} уничтожена`, gt.side); }
    }
    // Трансформаторные подстанции 10/0,4 кВ в городах и сёлах: прилёт рядом — район без света
    const P = this.world.power;
    for (let i = 0; i < P.tps.length; i++) {
      const tp = P.tps[i];
      if (!tp.alive) continue;
      const dd = hyp(tp.x - x, tp.y - y);
      if (dd < rl + 6 || (dd < rf && sim.rng.chance(0.5 * (1 - dd / rf)))) {
        tp.alive = false; P.version++;
        const sd = tp.x < this.world.W / 2 ? 'blue' : 'red';
        if (!this.sides[sd].queue.includes('T' + i)) this.sides[sd].queue.push('T' + i);
        sim.msg('Разбита трансформаторная подстанция (ТП 10/0,4 кВ) — квартал без света до ремонта', sd);
      }
    }
    // ПВО рядом с разрывом
    for (const a of this.ad) {
      if (a.dead || a.side === d.side) continue;
      const dd = hyp(a.x - x, a.y - y);
      const kill = D.cls === 'loiter' ? (dd < 8 ? 0.85 : dd < 20 ? 0.3 : 0) : dd < rl * 1.3 ? 0.9 : dd < rf ? 0.35 * (1 - dd / rf) : 0;
      if (kill && sim.rng.chance(kill)) { a.dead = true; a.deadAt = sim.time; this.sides[a.side].stats.lostAD++; sim.msg(`Потеряна позиция: ${a.name}`, a.side); sim.msg(`${D.short}: поражена позиция ПВО противника (${a.name})`, d.side); }
    }
    if (!debris) {
      const S = this.sides[d.side];
      if (hitAny) { S.stats.hits++; sim.msg(`${D.short}: попадание — ${hitAny.obj.name}, ${hitAny.name}${hitAny.state === 'ok' ? ' (незначительно)' : hitAny.state === 'destroyed' ? ' — уничтожен' : ' — выведен из строя'}`, d.side); }
      else if (this.inCity(x, y)) sim.msg(`${D.short}: промах, разрыв в городской застройке`, d.side);
      const on = this.objects.find((o) => o.side === enemy && hyp(o.x - x, o.y - y) < Math.max(o.w, o.h) / 2 + 60);
      if (on) sim.msg(`Удар по объекту: ${on.name}${hitAny ? (hitAny.state === 'ok' ? ` — лёгкие повреждения («${hitAny.name}» в работе)` : ` — ${hitAny.state === 'destroyed' ? 'уничтожен' : 'выведен из строя'} узел «${hitAny.name}»`) : ' — промах'}`, enemy);
      else if (this.inCity(x, y)) sim.msg('Прилёт по жилому району: повреждены дома', enemy);
    }
  }
  inCity(x, y) { return this.world.mask.has(x, y, M.CITY | M.CITYZONE); }

  damageComp(c, dmg, d) {
    const sim = this.sim;
    const C = COMP[c.k];
    const was = c.state;
    if (c.rebuilt) dmg *= 0.85; // восстановлено по новым нормам — прочнее
    c.hp -= dmg;
    if (c.hp <= 0) { c.hp = 0; c.state = 'destroyed'; }
    else if (c.hp < 0.62) c.state = 'damaged';
    if (C.fire && c.state !== 'ok' && c.fire <= 0 && sim.rng.chance(C.fire * (c.state === 'destroyed' ? 1 : 0.6))) {
      c.fire = (c.k === 'tank' ? 320 : c.k === 'at' || c.k === 'gsu' || c.k === 'tr' ? 240 : 150) * sim.rng.float(0.7, 1.3);
    }
    if (C.detonate && c.state !== 'ok' && was === 'ok') { c.fire = Math.max(c.fire, 120); sim.msg(`${c.obj.name}: детонация боеприпасов в «${c.name}»`, c.obj.side); }
    if (c.k === 'span' && c.state === 'destroyed' && was !== 'destroyed') sim.msg(`${c.obj.name}: обрушен ${c.name.toLowerCase()} — движение по мосту невозможно`, c.obj.side);
    if (was !== c.state) {
      this.flowTimer = 0;
      const side = c.obj.side;
      if (c.obj.kind === 'decoy' && was === 'ok') this.sim.msg(`${c.obj.name} (макет): противник потратил удар на ложную цель`, side);
      if (!this.prep && SHOCK[c.k] && !CIVIL.has(c.obj.kind) && c.obj.kind !== 'decoy') this.shock(side, SHOCK[c.k] * (c.state === 'destroyed' ? 1 : 0.5), c.name);
      const D = d && this.directive[d.side];
      if (D && !D.done && D.oid === c.oid && c.state !== 'ok') {
        D.done = 'ok';
        this.sides[d.side].points += D.bonus;
        this.shock(side, (this.endless ? 4 : 6) / this.drainK(), 'директива');
        sim.msg(`Директива выполнена: «${c.obj.name}» поражён — премия ${D.bonus} оч.`, d.side);
        sim.msg(`Противник поразил приоритетный объект «${c.obj.name}» — устойчивость −6`, side);
      }
    }
    // Сторона видит, что её объект повреждён; противник узнаёт об успехе по вспышке/разведке
    if (d) this.sides[d.side].seenObjects.add(c.oid);
  }

  // ---------- Обнаружение ----------
  detect() {
    const sim = this.sim;
    const night = 1 - daylight(sim.tod());
    if (this.fog) {
      if ((this.intelT = (this.intelT || 0) - 1) <= 0) { this.intelT = 5; this.intelTick(); }
      for (const d of this.drones) {
        if (d.dead || d.state === 'wait') continue;
        const D = DW_DRONES[d.type];
        if (D.cls === 'interceptor') continue;
        const R = (D.spot || (D.cls === 'strike' || D.cls === 'loiter' ? 700 : 500)) * (1 - night * 0.25);
        for (const o of this.objects) {
          if (o.side === d.side || this.intel[d.side].has(o.id) || o.kind === 'bridge' || o.kind === 'import') continue;
          if (Math.abs(o.x - d.x) < R + o.w / 2 && Math.abs(o.y - d.y) < R + o.w / 2 && hyp(o.x - d.x, o.y - d.y) < R + Math.max(o.w, o.h) / 2) this.reveal(d.side, o, D.short);
        }
      }
    }
    for (const d of this.drones) {
      if (d.dead || d.state === 'wait') continue;
      const D = DW_DRONES[d.type];
      const enemy = d.side === 'blue' ? 'red' : 'blue';
      let seen = false, cue = false;
      for (const a of this.ad) {
        if (a.dead || a.side !== enemy || a.state === 'deploying') continue;
        const T = DW_AD[a.type];
        const dist = hyp(a.x - d.x, a.y - d.y);
        if (T.radar) {
          // Радиогоризонт: низколетящие видны ближе; малые дроны — ещё ближе
          const R = T.radar * Math.min(1, 0.28 + d.alt / 900) * (0.4 + D.rcs);
          if (dist < R) { seen = true; cue = true; }
        }
        if (a.type === 'acoustic' && dist < T.range && d.alt < 2200 && D.noise > 0.5) { seen = true; cue = true; }
        if (!T.radar && a.type !== 'acoustic' && a.type !== 'ew' && a.type !== 'ewd') {
          const vis = (T.visual || 1200) * (1 - night * 0.35) * (d.alt < 1500 ? 1 : 0.6);
          if (dist < vis) seen = true;
        }
      }
      // Свои дроны-разведчики тоже видят (по бокам)
      if (!seen) for (const q of this.drones) if (!q.dead && q.side === enemy && DW_DRONES[q.type].cls === 'recon' && hyp(q.x - d.x, q.y - d.y) < 900) seen = true;
      // Над крупными городами — наблюдатели (визуально, днём и по звуку)
      if (!seen && this.world.mask.has(d.x, d.y, M.CITY | M.CITYZONE) && d.alt < 1200 && (d.x < this.frontX) === (enemy === 'blue')) seen = true;
      if (seen) { if (!d.seen[enemy]) d.firstSeen = sim.time; d.seen[enemy] = sim.time; }
      if (cue) { d.cued = d.cued || {}; d.cued[enemy] = sim.time; }
    }
  }

  // Что показывать стороне: свои дроны — все; чужие — только обнаруженные
  visibleDrones(side) {
    return this.drones.filter((d) => !d.dead && d.state !== 'wait' && (d.side === side || (d.seen[side] && this.sim.time - d.seen[side] < 4)));
  }
  // Машины: свои — все; чужие — замеченные разведкой за последние 90 с
  visibleVehicles(side) {
    return this.logi.vehicles.filter((v) => v.side === side || v.wreck || (v.spotted[side] && this.sim.time - v.spotted[side] < 90));
  }
  visibleAD(side) {
    return this.ad.filter((a) => a.side === side || (a.spotted[side] && this.sim.time - a.spotted[side] < 600));
  }
}

// ---------- Сеть: снимок состояния для гостя (хост считает, гость отображает) ----------
const R1 = (v) => Math.round(v * 10) / 10;
const STI = ['ok', 'damaged', 'destroyed'];
const AST = ['ready', 'deploying', 'moving'];
DroneWar.prototype.snapshot = function () {
  const t = this.sim.time;
  const seenBits = (d) => (d.seen.blue && t - d.seen.blue < 4 ? 1 : 0) | (d.seen.red && t - d.seen.red < 4 ? 2 : 0);
  const sideSnap = (S) => [R1(S.points), R1(S.income), Math.round(S.supply * 1000) / 1000, S.gen, S.demand, S.delivered, R1(S.achrUntil), R1(S.collapse), S.spare, S.auto ? 1 : 0,
    S.crews.map((c) => (c.job ? [c.id, c.job.id, R1(c.job.left), R1(c.job.total), c.job.state, c.job.shelter ? 1 : 0, c.job.level || 0, c.veh ? 1 : 0, c.job.kind || 'repair'] : [c.id, c.veh ? 1 : 0])), S.queue.slice(0, 60), R1(S.tradeAvg ?? 0),
    [S.stats.launched, S.stats.hits, S.stats.shot, S.stats.lostAD, S.stats.spent, S.stats.repairs], R1(S.logi ?? 1), R1(S.oil ?? 1), R1(S.ammo ?? 1),
    R1(S.morale), S.inc ? [R1(S.inc.industry), R1(S.inc.trade), R1(S.inc.fuel), R1(S.inc.transit), R1(S.inc.wages || 0), R1(S.inc.tax || 0), R1(S.inc.upkeep || 0), R1(S.inc.agro || 0), R1(S.inc.other || 0), R1(S.inc.state || 0)] : 0, S.moraleParts ? Object.values(S.moraleParts).map(R1) : 0];
  return {
    d: this.drones.filter((d) => !d.dead && d.state !== 'wait').map((d) => [d.id, d.side, d.type, R1(d.x), R1(d.y), Math.round(d.alt), R1(d.heading), R1(d.aimX ?? d.x), R1(d.aimY ?? d.y), seenBits(d), d.state === 'loiter' ? 1 : 0, (d.route || []).map((p) => [Math.round(p.x), Math.round(p.y)]), d.variant || 0]),
    a: this.ad.map((a) => [a.id, a.side, a.type, R1(a.x), R1(a.y), R1(a.heading), AST.indexOf(a.state), a.dead ? 1 : 0, a.missiles, a.stock, Math.round(a.ammo), a.kills || 0, a.target ? 1 : 0, R1(a.aim), R1(a.spotted.blue || 0), R1(a.spotted.red || 0), a.roe, R1(a.until), R1(a.fireT), a.dest ? [Math.round(a.dest.x), Math.round(a.dest.y)] : 0]),
    c: this.objects.map((o) => o.comps.map((c) => [Math.round(c.hp * 100), STI.indexOf(c.state), Math.round(c.fire), c.shelter, c.burned ? 1 : 0])),
    ps: this.objects.map((o) => (o.supply === undefined ? -1 : Math.round(o.supply * 1000) / 1000)),
    l: this.lines.map((l) => (l.cut ? [Math.round(l.cut.x), Math.round(l.cut.y)] : 0)),
    m: this.missiles.map((m) => [R1(m.x), R1(m.y), Math.round(m.alt), m.side]),
    f: this.fx.filter((f) => t - f.t0 < 0.3 || (f.t !== 'tracer' && t - f.t0 < 0.3)).map((f) => [f.t, R1(f.x ?? f.x0), R1(f.y ?? f.y0), R1(f.x1 ?? 0), R1(f.y1 ?? 0), Math.round(f.alt || 0), f.side || '', f.heavy ? 1 : 0, f.small ? 1 : 0, f.wh || 0, f.v || 0]),
    cp: [this.phaseNo, R1(this.startAt ?? 0), ['blue', 'red'].map((sd) => { const D = this.directive[sd]; return D ? [D.oid, R1(D.until), D.done || '', D.bonus] : 0; })],
    n: this.nets.map((n) => [n.id, n.side, n.done ? 1 : 0, n.line.map((p) => [Math.round(p[0]), Math.round(p[1])]), n.w]),
    gn: this.gens.map((q) => [q.id, q.side, q.ps, R1(q.x), R1(q.y), R1(q.angle), q.state, q.dead ? 1 : 0]),
    tp: this.world.power.tps.map((q) => (q.alive ? 1 : 0)).join(''),
    pw: this.objects.map((o) => (o.kind === 'ps110' ? [o.shed || 0, o.unstable ? 1 : 0, Math.round(o.overT || 0), Math.round(o.avail || 0), Math.round(o.demand || 0), Math.round(o.trCap || 0)] : o.gen !== undefined ? Math.round(o.gen) : 0)),
    en: [R1(this.wind ?? 0.6), ['blue', 'red'].map((sd) => { const S = this.sides[sd]; return [S.autoShed ? 1 : 0, R1(S.powerLoss ?? 0), S.genBy || {}]; })],
    s: { blue: sideSnap(this.sides.blue), red: sideSnap(this.sides.red) },
    g: [this.prep ? 1 : 0, R1(this.prepEnd), R1(this.endAt), this.winner, this.reason, this.ready.blue ? 1 : 0, this.ready.red ? 1 : 0, this.endless ? 1 : 0, R1(this.startAt ?? 0)],
    v: this.logi.vehicles.map((v) => [v.id, v.side, v.kind, R1(v.x), R1(v.y), R1(v.heading), v.state, v.dead ? 1 : 0, v.wreck ? 1 : 0, (v.spotted.blue && t - v.spotted.blue < 90 ? 1 : 0) | (v.spotted.red && t - v.spotted.red < 90 ? 2 : 0), v.task.type, R1(v.deadAt ?? 0)]),
    st: this.objects.map((o) => (o.stock === undefined ? -1 : o.stock)),
    eco: this.econ.snap(),
    gv: this.state.snap(),
    inf: this.infra.snap(),
    rs: this.res.snap(),
    it: this.fog ? [[...this.intel.blue], [...this.intel.red]] : 0,
    ls: ['blue', 'red'].map((sd) => { const L = this.logi.side[sd]; return [L.stats.imports, L.stats.deliveries, L.stats.sold, L.stats.lostTrucks, L.stats.trade]; }),
  };
};
DroneWar.prototype.applySnapshot = function (s) {
  const t = this.sim.time;
  if (s.eco) this.econ.applySnap(s.eco); // сначала — построенные объекты (индексы остальных массивов)
  if (s.gv) this.state.applySnap(s.gv);
  if (s.inf) this.infra.applySnap(s.inf);
  if (s.rs) this.res.applySnap(s.rs);
  if (s.it) ['blue', 'red'].forEach((sd, i) => { for (const id of s.it[i]) if (!this.intel[sd].has(id)) { this.intel[sd].add(id); this.sim.events.push({ type: 'intel', side: sd, oid: id }); } });
  this.fog = !!s.it;
  const old = new Map(this.drones.map((d) => [d.id, d]));
  this.drones = s.d.map((q) => {
    const o = old.get(q[0]);
    const d = o || { id: q[0], trail: [], seen: {}, drift: [0, 0], dead: false };
    Object.assign(d, { side: q[1], type: q[2], alt: q[5], heading: q[6], aimX: q[7], aimY: q[8], state: q[10] ? 'loiter' : 'fly', speed: DW_DRONES[q[2]].speed, route: q[11].map(([x, y]) => ({ x, y })), variant: q[12] || 0 });
    d.tx = q[3]; d.ty = q[4];
    if (!o) { d.x = q[3]; d.y = q[4]; }
    d.seen = { blue: q[9] & 1 ? t : 0, red: q[9] & 2 ? t : 0 };
    d.trail.push([d.x, d.y]); if (d.trail.length > 40) d.trail.shift();
    return d;
  });
  const oldA = new Map(this.ad.map((a) => [a.id, a]));
  this.ad = s.a.map((q) => {
    const a = oldA.get(q[0]) || { id: q[0], spotted: {}, spotX: {}, name: DW_AD[q[2]].name[q[1]] };
    Object.assign(a, { side: q[1], type: q[2], x: q[3], y: q[4], heading: q[5], state: AST[q[6]], dead: !!q[7], missiles: q[8], stock: q[9], ammo: q[10], kills: q[11], target: q[12] ? 1 : null, aim: q[13], roe: q[16], until: q[17], fireT: q[18], dest: q[19] ? { x: q[19][0], y: q[19][1] } : null });
    a.spotted = { blue: q[14], red: q[15] };
    a.spotX = { blue: [a.x, a.y], red: [a.x, a.y] };
    if (a.dead && !a.deadAt) a.deadAt = t;
    return a;
  });
  this.objects.forEach((o, i) => {
    o.comps.forEach((c, j) => { const q = s.c[i][j]; c.hp = q[0] / 100; c.state = STI[q[1]]; c.fire = q[2]; c.shelter = q[3]; c.burned = !!q[4]; });
    if (s.ps[i] >= 0) o.supply = s.ps[i];
  });
  for (const o of this.objects) if (o.kind === 'ps110') {
    const m = this.world.power.mains.find((q) => q.infraId === o.id);
    if (m && Math.abs((m.supply ?? 1) - Math.max(0.06, o.supply ?? 1)) > 0.02) { m.supply = Math.max(0.06, o.supply ?? 1); this.world.power.version++; }
  }
  this.lines.forEach((l, i) => { const q = s.l[i]; l.cut = q ? { x: q[0], y: q[1] } : null; });
  this.missiles = s.m.map((q) => ({ x: q[0], y: q[1], alt: q[2], side: q[3], trail: [[q[0], q[1], q[2]]] }));
  for (const q of s.f) {
    const f = q[0] === 'tracer' ? { t: 'tracer', x0: q[1], y0: q[2], x1: q[3], y1: q[4], alt: q[5], side: q[6], heavy: !!q[7], t0: t } : { t: q[0], x: q[1], y: q[2], alt: q[5], small: !!q[8], wh: q[9], v: q[10], side: q[6], t0: t };
    this.fx.push(f);
  }
  { const LIFE = { tracer: 0.5, airburst: 5, fall: 6, money: 3, impact: 30 }; this.fx = this.fx.filter((f) => t - f.t0 < (LIFE[f.t] ?? 5)); }
  for (const side of ['blue', 'red']) {
    const S = this.sides[side], q = s.s[side];
    Object.assign(S, { points: q[0], income: q[1], supply: q[2], gen: q[3], demand: q[4], delivered: q[5], achrUntil: q[6], collapse: q[7], spare: q[8], auto: !!q[9], queue: q[11], tradeAvg: q[12], logi: q[14], oil: q[15], ammo: q[16] });
    void 0;
    S.crews = q[10].map((c) => (c.length > 2 ? { id: c[0], job: { id: c[1], left: c[2], total: c[3], state: c[4], shelter: !!c[5], level: c[6], kind: c[8] }, veh: c[7] ? {} : null } : { id: c[0], job: null, veh: c[1] ? {} : null }));
    [S.stats.launched, S.stats.hits, S.stats.shot, S.stats.lostAD, S.stats.spent, S.stats.repairs] = q[13];
    S.morale = q[17];
    if (q[18]) { S.inc = { industry: q[18][0], trade: q[18][1], fuel: q[18][2], transit: q[18][3], wages: q[18][4], tax: q[18][5] || 0, upkeep: q[18][6] || 0, agro: q[18][7] || 0, other: q[18][8] || 0, state: q[18][9] || 0 }; S.tradeAvg = q[18][1] + q[18][2] + q[18][3]; }
    if (q[19]) { const [power, bridges, shops, fires, border, regen] = q[19]; S.moraleParts = { power, bridges, shops, fires, border, regen }; }
  }
  [this.prep, this.prepEnd, this.endAt, this.winner, this.reason] = [!!s.g[0], s.g[1], s.g[2], s.g[3], s.g[4]];
  this.endless = !!s.g[7]; if (s.g[8]) this.startAt = s.g[8];
  const oldV = new Map(this.logi.vehicles.map((v) => [v.id, v]));
  this.logi.vehicles = (s.v || []).map((q) => {
    const v = oldV.get(q[0]) || { id: q[0], x: q[3], y: q[4], spotted: {}, task: {} };
    Object.assign(v, { side: q[1], kind: q[2], tx: q[3], ty: q[4], heading: q[5], state: q[6], dead: !!q[7], wreck: !!q[8], deadAt: q[11] });
    v.spotted = { blue: q[9] & 1 ? t : 0, red: q[9] & 2 ? t : 0 };
    v.task = { ...v.task, type: q[10] };
    if (!oldV.has(q[0])) { v.x = q[3]; v.y = q[4]; }
    return v;
  });
  if (s.st) this.objects.forEach((o, i) => { if (s.st[i] >= 0) o.stock = s.st[i]; });
  if (s.ls) ['blue', 'red'].forEach((sd, i) => { const L = this.logi.side[sd]; [L.stats.imports, L.stats.deliveries, L.stats.sold, L.stats.lostTrucks, L.stats.trade] = s.ls[i]; });
  this.ready = { blue: !!s.g[5], red: !!s.g[6] };
  if (s.cp) {
    this.phaseNo = s.cp[0]; this.startAt = s.cp[1];
    ['blue', 'red'].forEach((sd, i) => { const q = s.cp[2][i]; this.directive[sd] = q ? { oid: q[0], until: q[1], done: q[2] || null, bonus: q[3] } : null; });
  }
  if (s.gn) this.gens = s.gn.map((q) => ({ id: q[0], side: q[1], ps: q[2], x: q[3], y: q[4], angle: q[5], state: q[6], dead: !!q[7] }));
  if (s.tp) { const P = this.world.power; let ch = false; P.tps.forEach((q, i) => { const a = s.tp[i] === '1'; if (q.alive !== a) { q.alive = a; ch = true; } }); if (ch) P.version++; }
  if (s.pw) this.objects.forEach((o, i) => { const q = s.pw[i]; if (Array.isArray(q)) [o.shed, o.unstable, o.overT, o.avail, o.demand, o.trCap] = [q[0], !!q[1], q[2], q[3], q[4], q[5]]; else if (q) o.gen = q; });
  if (s.en) { this.wind = s.en[0]; ['blue', 'red'].forEach((sd, i) => { const S = this.sides[sd]; [S.autoShed, S.powerLoss, S.genBy] = [!!s.en[1][i][0], s.en[1][i][1], s.en[1][i][2]]; }); }
  if (s.n) this.nets = s.n.map((q) => { const xs = q[3].map((p) => p[0]), ys = q[3].map((p) => p[1]); const m = q[3][Math.floor(q[3].length / 2)]; return { id: q[0], side: q[1], done: !!q[2], line: q[3], w: q[4], x: m[0], y: m[1], bb: { x0: Math.min(...xs) - 12, y0: Math.min(...ys) - 12, x1: Math.max(...xs) + 12, y1: Math.max(...ys) + 12 } }; });
};
// Гость: плавное движение дронов между снимками
DroneWar.prototype.interpolate = function (dt) {
  const k = Math.min(1, dt * 8);
  for (const d of this.drones) if (d.tx !== undefined) { d.x += (d.tx - d.x) * k; d.y += (d.ty - d.y) * k; }
  for (const v of this.logi.vehicles) if (v.tx !== undefined && !v.dead) { v.x += (v.tx - v.x) * k; v.y += (v.ty - v.y) * k; }
};

function segDist(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
  return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t);
}

// Максимальный поток (Эдмондс—Карп) на матрице ёмкостей; возвращает поток в указанные узлы
function maxflowPer(cap, s, t, watch) {
  const n = cap.length;
  const flow = Array.from({ length: n }, () => new Float64Array(n));
  for (;;) {
    const prev = new Int32Array(n).fill(-1);
    prev[s] = s;
    const q = [s];
    while (q.length && prev[t] < 0) {
      const u = q.shift();
      for (let v = 0; v < n; v++) if (prev[v] < 0 && cap[u][v] - flow[u][v] > 1e-6) { prev[v] = u; q.push(v); }
    }
    if (prev[t] < 0) break;
    let aug = Infinity;
    for (let v = t; v !== s; v = prev[v]) aug = Math.min(aug, cap[prev[v]][v] - flow[prev[v]][v]);
    for (let v = t; v !== s; v = prev[v]) { flow[prev[v]][v] += aug; flow[v][prev[v]] -= aug; }
  }
  return watch.map((w) => flow[w][t]);
}
