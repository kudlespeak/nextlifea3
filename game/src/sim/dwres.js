// «Война дронов»: промышленность. Исследований нет — все дроны, ракеты, средства ПВО и постройки
// доступны сразу, но военных заводов на старте нет: цепочки строятся с нуля, строятся и работают долго.
//
// Сырьё добывают карьеры, рудники и нефтепромыслы глубокого тыла; заводы перерабатывают его в
// материалы (сталь, бетон, асфальт, химсырьё), из материалов — комплектующие (двигатели, взрывчатка,
// электроника, планеры, оптика, аккумуляторы…). Каждая партия едет грузовиком к потребителю или на
// терминал комплектующих — колонну можно перехватить. Сборочные цеха собирают дроны, ракетный завод —
// крылатые ракеты: на каждую единицу нужен свой набор комплектующих (рецепт).
// Чего нет — можно купить по импорту (дорого, едет фурой с погранперехода; импортные двигатели и
// электроника хуже — такие дроны чаще отказывают). У завода — уровень (1–3), выход на мощность после
// пуска, режим работы (обычный, ночная смена, аврал с браком), рабочие из ближайших городов,
// содержание в бюджете; нужен свет.

import { DW_DRONES } from './dronewar.js';

// ---------------------------------------------------------------- Ресурсы
export const RES = {
  sand: { name: 'Песок и щебень', lot: 40, imp: 0.6 },
  ore: { name: 'Руда', lot: 40, imp: 0.8 },
  crude: { name: 'Нефть', lot: 40, imp: 1 },
  steel: { name: 'Сталь', lot: 10, imp: 3 },
  chem: { name: 'Химсырьё', lot: 10, imp: 3 },
  concrete: { name: 'Бетон', lot: 10, imp: 2 },
  asphalt: { name: 'Асфальт', lot: 10, imp: 2 },
  rfuel: { name: 'Ракетное топливо', lot: 4, imp: 12 },
  eng_p: { name: 'Поршневые двигатели', lot: 4, imp: 9, poor: true },
  eng_j: { name: 'Турбореактивные двигатели', lot: 2, imp: 40, poor: true },
  explosive: { name: 'Взрывчатка (БЧ)', lot: 4, imp: 8 },
  electronics: { name: 'Электроника и навигация', lot: 6, imp: 7, poor: true },
  airframe: { name: 'Планеры и корпуса', lot: 4, imp: 6 },
  optics: { name: 'Оптика и тепловизоры', lot: 4, imp: 9 },
  battery: { name: 'Аккумуляторы', lot: 6, imp: 4 },
  cable: { name: 'Кабель', lot: 6, imp: 3 },
  trafo: { name: 'Трансформаторы', lot: 1, imp: 120 },
  nets: { name: 'Антидроновые сетки', lot: 4, imp: 5 },
  ewkit: { name: 'Станции РЭБ', lot: 2, imp: 40 },
  dummy: { name: 'Макеты', lot: 4, imp: 4 },
  trucks: { name: 'Грузовики', lot: 1, imp: 40 },
};
export const RES_GROUPS = [
  ['Сырьё', ['sand', 'ore', 'crude']],
  ['Материалы', ['steel', 'chem', 'concrete', 'asphalt', 'rfuel']],
  ['Комплектующие', ['eng_p', 'eng_j', 'explosive', 'electronics', 'airframe', 'optics', 'battery']],
  ['Для тыла и ПВО', ['cable', 'trafo', 'nets', 'ewkit', 'dummy', 'trucks']],
];

// ---------------------------------------------------------------- Заводы
// out/in — за цикл; t — длительность цикла (с) на 1-м уровне при полной мощности; workers — рабочих;
// upkeep — оч/мин; power — нужен свет; raw — добыча на карте (не строится)
export const FACT = {
  quarry: { name: 'Карьер', raw: true, out: { sand: 4 }, t: 60, workers: 300, upkeep: 0.2 },
  mine: { name: 'Рудник', raw: true, out: { ore: 4 }, t: 60, workers: 600, upkeep: 0.3 },
  oilfield: { name: 'Нефтепромысел', raw: true, out: { crude: 6 }, t: 60, workers: 300, upkeep: 0.2 },
  steel: { name: 'Металлургический завод', in: { ore: 2 }, out: { steel: 2 }, t: 60, workers: 1500, upkeep: 1.0, power: true },
  concrete: { name: 'Бетонный завод (ЖБИ)', in: { sand: 2 }, out: { concrete: 2 }, t: 60, workers: 300, upkeep: 0.3, power: true },
  asphalt: { name: 'Асфальтобетонный завод', in: { sand: 2, crude: 1 }, out: { asphalt: 2 }, t: 60, workers: 200, upkeep: 0.3 },
  chem: { name: 'Химический комбинат', in: { crude: 2 }, out: { chem: 2 }, t: 60, workers: 900, upkeep: 0.8, power: true },
  refinery: { name: 'НПЗ: ракетное топливо', in: { crude: 1 }, out: { rfuel: 1 }, t: 150, workers: 0, upkeep: 0, power: true },
  engine: { name: 'Завод двигателей', in: { steel: 1 }, out: { eng_p: 1 }, t: 90, workers: 800, upkeep: 0.6, power: true },
  turbine: { name: 'Завод турбореактивных двигателей', in: { steel: 2, electronics: 1 }, out: { eng_j: 1 }, t: 480, workers: 1200, upkeep: 1.2, power: true },
  explosive: { name: 'Пороховой завод', in: { chem: 1 }, out: { explosive: 1 }, t: 90, workers: 600, upkeep: 0.6, power: true },
  electronics: { name: 'Завод электроники', in: { chem: 1 }, out: { electronics: 2 }, t: 150, workers: 700, upkeep: 0.7, power: true },
  composite: { name: 'Композитный завод', in: { chem: 1 }, out: { airframe: 1 }, t: 90, workers: 500, upkeep: 0.5, power: true },
  optics: { name: 'Оптический завод', in: { chem: 1 }, out: { optics: 1 }, t: 200, workers: 400, upkeep: 0.5, power: true },
  battery: { name: 'Завод аккумуляторов', in: { chem: 1, steel: 1 }, out: { battery: 2 }, t: 150, workers: 500, upkeep: 0.5, power: true },
  cable: { name: 'Кабельный завод', in: { steel: 1 }, out: { cable: 2 }, t: 120, workers: 400, upkeep: 0.4, power: true },
  trafo: { name: 'Трансформаторный завод', in: { steel: 2, cable: 2 }, out: { trafo: 1 }, t: 600, workers: 700, upkeep: 0.7, power: true },
  netfab: { name: 'Сеточный завод', in: { steel: 1 }, out: { nets: 2 }, t: 120, workers: 200, upkeep: 0.2, power: true },
  ewfab: { name: 'Завод станций РЭБ', in: { electronics: 2 }, out: { ewkit: 1 }, t: 400, workers: 500, upkeep: 0.6, power: true },
  decoyfab: { name: 'Завод макетов', in: { chem: 1 }, out: { dummy: 2 }, t: 150, workers: 150, upkeep: 0.15 },
  autoplant: { name: 'Автосборочный завод', in: { steel: 2, eng_p: 1 }, out: { trucks: 1 }, t: 400, workers: 1200, upkeep: 0.8, power: true },
};
// Сборка: линии на 1-м уровне; какие классы собирает
// Нагрузка заводов на сеть, МВт (за уровень): металлургия и химия — энергоёмкие
export const PLANT_MW = { steel: 60, chem: 45, refinery: 30, turbine: 20, autoplant: 18, missile: 20, engine: 15, explosive: 15, trafo: 15, electronics: 12, cable: 12, composite: 10, battery: 10, uground: 10, mine: 10, concrete: 8, ewfab: 8, workshop: 6, optics: 6, netfab: 6, asphalt: 6, oilfield: 6, decoyfab: 4, quarry: 4, minifab: 2, terminal: 2 };
export const ASSEMBLY = {
  workshop: { name: 'Сборочный цех БПЛА', lines: 3, drones: true, workers: 600, upkeep: 0.6, power: true },
  missile: { name: 'Ракетный завод', lines: 2, missiles: true, workers: 1500, upkeep: 1.4, power: true },
  uground: { name: 'Подземный цех', lines: 1.5, drones: true, missiles: true, workers: 500, upkeep: 1.2, power: true },
  minifab: { name: 'Рассредоточенный цех', lines: 0.6, drones: true, light: true, workers: 120, upkeep: 0.15 },
};
export const STORE_KINDS = new Set(['terminal']);
// что идёт прямо в сборку (если терминала нет, везут на распредцентр — оттуда берут цеха)
const ASSEMBLY_USES = new Set(['eng_p', 'eng_j', 'explosive', 'electronics', 'airframe', 'optics', 'battery', 'rfuel', 'cable', 'trafo', 'nets', 'ewkit', 'dummy', 'trucks', 'concrete', 'asphalt']);
const MODES = { normal: { k: 1, upkeep: 1, power: 1, defect: 0 }, night: { k: 1.4, upkeep: 1.6, power: 1.3, defect: 0 }, rush: { k: 1.7, upkeep: 1.3, power: 1.2, defect: 0.12 } };
export const MODE_NAME = { normal: 'обычный режим', night: 'ночная смена (+40%, дороже)', rush: 'аврал (+70%, брак 12%)' };
const levelK = (o) => 1 + 0.6 * ((o.level || 1) - 1);
const RAMP = 900; // с: выход на полную мощность после пуска

// ---------------------------------------------------------------- Рецепты
const isMissile = (D) => D.cls === 'cruise';
const LIGHT = new Set(['decoy', 'recon', 'loiter']);
export function recipe(k) {
  const D = DW_DRONES[k];
  if (!D) return {};
  const bch = (per) => Math.max(1, Math.round((D.wh || 0) / per));
  if (D.cls === 'cruise') return { airframe: 2, eng_j: 1, explosive: bch(100), electronics: 2, rfuel: 1 };
  if (D.cls === 'decoy') return { airframe: 1, eng_p: 1 };
  if (D.cls === 'recon') return D.speed < 28 ? { airframe: 1, battery: 2, optics: 1, electronics: 1 } : { airframe: 1, eng_p: 1, optics: 1, electronics: 1 };
  if (D.cls === 'loiter') return { airframe: 1, battery: 1, electronics: 1, explosive: 1, optics: 1 };
  const jet = D.speed >= 90;
  const r = { airframe: 1, [jet ? 'eng_j' : 'eng_p']: 1, explosive: bch(50), electronics: 1 };
  if (D.cls === 'hunter') r.optics = 1;
  return r;
}
export const recipeText = (k) => Object.entries(recipe(k)).map(([r, n]) => `${RES[r].name.toLowerCase()} ×${n}`).join(', ');
// Работа на сборку одной единицы (линия·секунд): дроны — минуты, ракеты — около часа
export const droneWork = (k) => Math.max(120, DW_DRONES[k].cost * (isMissile(DW_DRONES[k]) ? 30 : 28));
// Цена заказа — сборка и испытания; сами комплектующие — со своих заводов или по импорту
export const assemblyCost = (k) => Math.round(DW_DRONES[k].cost * 0.35);
const START_STOCK = { strike: 10, decoy: 12, recon: 4 };
const QUEUE_MAX = 80;
const BASE_STOCK = new Set(['shahed', 'gerbera', 'orlan', 'fp1', 'bober', 'grif', 'leleka']);

export class DWResearch {
  constructor(g) {
    this.g = g;
    this.sim = g.sim;
    this.side = {};
    for (const side of ['blue', 'red']) {
      const stock = {}, poor = {};
      for (const [k, D] of Object.entries(DW_DRONES)) if (D.side === side && D.cls !== 'interceptor') { stock[k] = BASE_STOCK.has(k) ? (k === 'bober' ? 6 : START_STOCK[D.cls] || 0) : 0; poor[k] = 0; }
      const pool = {}, imp = {};
      for (const r in RES) { pool[r] = 0; imp[r] = 0; }
      this.side[side] = {
        stock, poor, queue: [], cur: { drone: null, missile: null }, rate: { drone: 0, missile: 0 }, prog: 0,
        pool, imp, labor: 1, workers: 0, workersAvail: 0, export: false, made: {}, warnT: 0, shipped: 0, lostCargo: 0,
      };
    }
    this.shipT = 0;
    this.tickT = 0;
  }
  // ---------------------------------------------------------------- Совместимость (исследований нет)
  has() { return true; }
  droneOk() { return true; }
  adOk() { return true; }
  buildOk() { return true; }
  needFor() { return ''; }

  // ---------------------------------------------------------------- Заводы стороны
  ready(o) { return !(o.build && !o.build.up) && o.comps.some((c) => c.state !== 'destroyed'); }
  // Нагрузка заводов по подстанциям 110 кВ (МВт): завод на фидере ПС 35 — через её ПС 110
  plantLoad(side) {
    const out = new Map(), g = this.g;
    for (const o of this.plants(side)) {
      const mw = (PLANT_MW[o.kind] || 0) * (o.level || 1) * (o.mode === 'rush' ? 1.3 : o.mode === 'night' ? 1.15 : 1);
      if (!mw || o.offGrid || o.idle === 'нет света') continue;
      if (!o._ps || this.sim.time - (o._psT || 0) > 30) {
        o._psT = this.sim.time;
        const p35 = g.objs(side, 'ps35').find((q) => !q.build && Math.hypot(q.x - o.x, q.y - o.y) < 10000);
        // фидер ПС 35 питается с шин 110 кВ (мимо трансформаторов 110/10 района) — ключ «h<id>»
        o._ps = p35?.ps != null ? 'h' + p35.ps : g.econ.nearestPS(side, o.x, o.y)?.id;
      }
      if (o._ps != null) out.set(o._ps, (out.get(o._ps) || 0) + mw);
    }
    return out;
  }
  plants(side) { return this.g.objs(side).filter((o) => (FACT[o.kind] || ASSEMBLY[o.kind]) && this.ready(o)); }
  // Мощность завода сейчас (0…∼2): уровень, выход на мощность, узлы, свет, рабочие, режим
  power(o) {
    const g = this.g, F = FACT[o.kind] || ASSEMBLY[o.kind], T = this.side[o.side];
    if (!F || !this.ready(o)) return 0;
    if (o.kind === 'refinery' && !o.built) return 0;
    const all = o.comps.length, ok = o.comps.filter((c) => g.compOk(c)).length / Math.max(1, all);
    let k = levelK(o) * ok;
    const t0 = o.readyAt ?? (F.raw || !o.built ? -1e9 : this.sim.time);
    if (o.readyAt === undefined && !F.raw && o.built) o.readyAt = this.sim.time;
    k *= Math.min(1, 0.45 + 0.55 * Math.max(0, this.sim.time - t0) / RAMP);
    if (F.power) {
      // промышленная ПС 35/10 в 10 км — свой фидер, иначе — районная ПС 110
      const p35 = g.objs(o.side, 'ps35').filter((q) => !q.build && Math.hypot(q.x - o.x, q.y - o.y) < 10000).sort((a, b) => (b.supply ?? 0) - (a.supply ?? 0))[0];
      const ps = p35 || g.econ.nearestPS(o.side, o.x, o.y);
      const sup = ps ? (ps.supply ?? 1) : 1;
      // «уступать свет городу»: при нехватке на подстанции завод встаёт первым (его нагрузка снимается)
      if (o.yieldPower && !p35 && ps && (sup < 0.97 || (ps.shed || 0) > 0)) { o.idle = 'уступил свет городу'; o.offGrid = true; return 0; }
      o.offGrid = false;
      if (sup < 0.45) { o.idle = 'нет света'; return 0; }
      k *= Math.min(1, sup);
    }
    if ((o.evacUntil || 0) > this.sim.time) { o.idle = 'эвакуация района (ГО)'; return 0; }
    if (F.workers) k *= T.labor;
    k *= MODES[o.mode || 'normal'].k;
    return k;
  }
  // Сколько рабочих нужно и сколько есть: люди городов стороны (минус мобилизованные)
  updateLabor(side) {
    const T = this.side[side];
    let need = 0;
    for (const o of this.plants(side)) need += (FACT[o.kind] || ASSEMBLY[o.kind]).workers || 0;
    const pop = this.g.econ.settlementsOf(side).reduce((a, s) => a + s.pop, 0);
    const avail = pop * 0.02 * this.g.econ.labor(side);
    T.workers = need; T.workersAvail = avail;
    T.labor = need <= avail ? 1 : Math.max(0.35, avail / need);
  }
  // Содержание промышленности (оч/мин) — в общих расходах стороны
  upkeep(side) {
    let u = 0;
    for (const o of this.plants(side)) { const F = FACT[o.kind] || ASSEMBLY[o.kind]; u += (F.upkeep || 0) * levelK(o) * MODES[o.mode || 'normal'].upkeep; }
    return u;
  }
  // Режим работы завода
  setMode(side, id, mode) {
    const o = this.g.obj(id);
    if (!o || o.side !== side || !(FACT[o.kind] || ASSEMBLY[o.kind])) return 'Это не завод';
    if (!MODES[mode]) return 'Нет такого режима';
    o.mode = mode;
    this.sim.msg(`${o.name}: ${MODE_NAME[mode]}`, side);
    return null;
  }
  setExport(side, on) { this.side[side].export = !!on; }

  // ---------------------------------------------------------------- Импорт комплектующих
  importCost(side, r, n) { return Math.round(RES[r].imp * n * (this.g.state?.k(side, 'arms') ?? 1)); }
  buyImport(side, r, n) {
    const T = this.side[side], S = this.g.sides[side], L = this.g.logi.side[side];
    if (!RES[r]) return 'Нет такого товара';
    n = Math.max(1, Math.min(40, n | 0));
    const cost = this.importCost(side, r, n);
    if (S.points < cost) return `Не хватает очков: нужно ${cost}`;
    if (!L.border.comps.some((c) => c.state !== 'destroyed')) return 'Погранпереход разрушен — импорт невозможен';
    const to = this.storeFor(side, r);
    S.points -= cost; S.stats.spent += cost;
    const v = this.ship(side, L.border, to, r, n, true);
    this.sim.msg(`Импорт: ${RES[r].name.toLowerCase()} ×${n} (−${cost} оч.)${v ? ' — фура выехала с погранперехода' : ''}`, side);
    return null;
  }

  // ---------------------------------------------------------------- Доставка партий
  // Куда везти: ближайший завод, которому это нужно; иначе — терминал комплектующих; иначе — сборка
  // (для комплектующих) или распредцентр
  storeFor(side, r, from) {
    const g = this.g, x = from?.x ?? g.sides[side].base.x, y = from?.y ?? g.sides[side].base.y;
    const near = (list) => list.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];
    const users = this.plants(side).filter((o) => FACT[o.kind]?.in?.[r]);
    if (users.length) return near(users);
    const term = g.objs(side, 'terminal').filter((o) => this.ready(o));
    if (term.length) return near(term);
    if (!ASSEMBLY_USES.has(r)) return this.g.logi.side[side].hub; // сырьё и материалы — некому; держим на месте (см. dispatch)
    const asm = this.plants(side).filter((o) => ASSEMBLY[o.kind]);
    if (asm.length) return near(asm);
    return this.g.logi.side[side].hub;
  }
  ship(side, from, to, r, n, imported = false) {
    const logi = this.g.logi, T = this.side[side];
    const v = logi.spawn(side, 'cargo', logi.gate(from), logi.gate(to), { type: 'cargo', res: r, n, imp: imported, to: to.id });
    if (!v) { this.receive(side, r, n, imported); return null; } // нет дороги — довозят окольными путями (без машины на карте)
    (T.incoming ||= {})[r] = (T.incoming[r] || 0) + n; // в пути (для интерфейса и ИИ)
    return v;
  }
  receive(side, r, n, imported) {
    const T = this.side[side];
    if (r === 'trucks') { this.g.logi.side[side].trucksFree += n; T.cargoCap = (T.cargoCap || 0) + 2 * n; this.sim.msg(`Автозавод: ${n} новых грузовиков в автопарке`, side); return; }
    if (r === 'trafo') { this.g.sides[side].spare += n; this.sim.msg(`Трансформаторный завод: +${n} резервный трансформатор`, side); return; }
    if (imported && RES[r].poor) T.imp[r] += n; else T.pool[r] += n;
  }
  // Прибытие машины (зовёт логистика); true — обработано
  arrive(v) {
    const T = v.task;
    if (T?.type !== 'cargo' && T?.type !== 'xport') return false;
    const logi = this.g.logi;
    if (v.state === 'back') { logi.home(v); return true; }
    if (T.type === 'xport') {
      if (logi.side[v.side].border.comps.some((c) => c.state !== 'destroyed')) { logi.earn(v.side, T.n * T.price, v.x, v.y, 'trade'); this.sim.msg(`Экспорт: ${RES[T.res].name.toLowerCase()} ×${T.n} продано за границу`, v.side); }
    } else { this.receive(v.side, T.res, T.n, T.imp); const I = this.side[v.side].incoming; if (I) I[T.res] = Math.max(0, (I[T.res] || 0) - T.n); }
    v.dead = true; v.deadAt = this.sim.time; // разгрузились — машина уходит в парк (не рисуем обратный рейс)
    return true;
  }
  onLost(v) {
    if (v.task?.type !== 'cargo') return;
    this.side[v.side].lostCargo += v.task.n;
    const I = this.side[v.side].incoming; if (I) I[v.task.res] = Math.max(0, (I[v.task.res] || 0) - v.task.n);
    this.sim.msg(`Колонна уничтожена: потеряно ${RES[v.task.res].name.toLowerCase()} ×${v.task.n}`, v.side);
  }
  cargoOnRoad(side) { return this.g.logi.vehicles.filter((v) => !v.dead && v.side === side && v.kind === 'cargo').length; }

  // ---------------------------------------------------------------- Заказы на сборку
  queued(side, k) { return this.side[side].queue.filter((q) => q.k === k).reduce((a, q) => a + q.n, 0); }
  order(side, k, n = 1) {
    const D = DW_DRONES[k], T = this.side[side], S = this.g.sides[side];
    if (!D || D.side !== side || D.cls === 'interceptor') return 'Этот тип не производится';
    if (T.queue.reduce((a, q) => a + q.n, 0) + n > QUEUE_MAX) return `Очередь заполнена (до ${QUEUE_MAX})`;
    const cost = assemblyCost(k) * n;
    if (S.points < cost) return `Не хватает очков: нужно ${cost}`;
    S.points -= cost; S.stats.spent += cost; S.stats.mil += cost;
    const last = T.queue[T.queue.length - 1];
    if (last && last.k === k) { last.n += n; last.paid += cost; } else T.queue.push({ k, n, paid: cost });
    const need = isMissile(D) ? 'missile' : 'drone';
    if (!this.plants(side).some((o) => ASSEMBLY[o.kind]?.[need === 'missile' ? 'missiles' : 'drones'])) this.sim.msg(`${D.short}: заказ принят, но ${need === 'missile' ? 'ракетного завода' : 'сборочного цеха'} пока нет — стройте (вкладка «Стройка»)`, side);
    return null;
  }
  // Поднять заказ в начало очереди (приоритет)
  top(side, i) {
    const Q = this.side[side].queue;
    if (!Q[i] || i === 0) return null;
    Q.unshift(...Q.splice(i, 1));
    return null;
  }
  cancel(side, i) {
    const T = this.side[side], q = T.queue[i];
    if (!q) return 'Нет такого заказа';
    const refund = Math.round(q.paid);
    this.g.sides[side].points += refund;
    T.queue.splice(i, 1);
    return null;
  }
  stock(side, k) { return this.side[side].stock[k] || 0; }
  // Взять из запаса n штук; сколько из них — «плохих» (импортные узлы, брак аврала)
  take(side, k, n) {
    const T = this.side[side];
    const m = Math.min(n, T.stock[k] || 0);
    T.stock[k] -= m;
    const bad = Math.min(T.poor[k] || 0, Math.round((m * (T.poor[k] || 0)) / Math.max(1, m + T.stock[k])));
    T.poor[k] = Math.max(0, (T.poor[k] || 0) - bad);
    this.lastPoor = bad;
    return m;
  }
  // Хватает ли комплектующих на одну единицу (свои, затем импортные)
  canBuild(side, k) {
    const T = this.side[side];
    return Object.entries(recipe(k)).every(([r, n]) => T.pool[r] + T.imp[r] >= n);
  }
  missing(side, k) {
    const T = this.side[side];
    return Object.entries(recipe(k)).filter(([r, n]) => T.pool[r] + T.imp[r] < n).map(([r]) => r);
  }
  consume(side, k) {
    const T = this.side[side];
    let poor = false;
    for (const [r, n] of Object.entries(recipe(k))) {
      const own = Math.min(n, T.pool[r]);
      T.pool[r] -= own;
      if (n > own) { T.imp[r] -= n - own; poor = true; }
    }
    return poor;
  }

  // ---------------------------------------------------------------- Такт
  update(dt) {
    this.tickT -= dt;
    if (this.tickT > 0) return;
    const step = 2 - this.tickT; // такт ~2 с
    this.tickT = 2;
    for (const side of ['blue', 'red']) {
      this.updateLabor(side);
      this.produce(side, step);
      this.assemble(side, step);
    }
    this.shipT -= step;
    if (this.shipT <= 0) { this.shipT = 10; for (const side of ['blue', 'red']) { this.dispatch(side); this.exportSurplus(side); } }
  }
  produce(side, dt) {
    const T = this.side[side];
    for (const o of this.plants(side)) {
      const F = FACT[o.kind];
      if (!F) continue;
      o.idle = null;
      const k = this.power(o);
      if (k <= 0) { o.idle = o.idle || 'не работает'; continue; }
      // сырьё на входе — из общего пула стороны (его привезли грузовики)
      if (F.in && !Object.entries(F.in).every(([r, n]) => T.pool[r] + (RES[r].poor ? T.imp[r] : 0) >= n)) {
        if ((o.prog || 0) >= 1) { o.idle = `нет сырья: ${Object.entries(F.in).filter(([r, n]) => T.pool[r] + (RES[r].poor ? T.imp[r] : 0) < n).map(([r]) => RES[r].name.toLowerCase()).join(', ')}`; continue; }
      }
      o.prog = (o.prog || 0) + (k * dt) / F.t;
      while (o.prog >= 1) {
        if (F.in) {
          if (!Object.entries(F.in).every(([r, n]) => T.pool[r] + (RES[r].poor ? T.imp[r] : 0) >= n)) { o.prog = 1; o.idle = `нет сырья: ${Object.entries(F.in).filter(([r, n]) => T.pool[r] + (RES[r].poor ? T.imp[r] : 0) < n).map(([r]) => RES[r].name.toLowerCase()).join(', ')}`; break; }
          for (const [r, n] of Object.entries(F.in)) { const own = Math.min(n, T.pool[r]); T.pool[r] -= own; if (n > own) T.imp[r] -= n - own; }
        }
        o.prog -= 1;
        const loss = (o.mode === 'rush' ? 0.1 : 0);
        o.out = o.out || {};
        for (const [r, n] of Object.entries(F.out)) { o.out[r] = (o.out[r] || 0) + n * (1 - loss); T.made[r] = (T.made[r] || 0) + n; }
      }
    }
  }
  // Готовые партии — грузовиками к потребителям (не чаще раза в 10 с, не больше машин, чем есть)
  dispatch(side) {
    const T = this.side[side];
    let road = this.cargoOnRoad(side);
    const cap = 60 + (T.cargoCap || 0) + 8 * this.g.objs(side, 'autopark').filter((o) => this.ready(o)).length;
    // сначала — продукция заводов (короткие рейсы, на них стоит сборка), сырьё из глубокого тыла — потом
    const list = this.plants(side).sort((a, b) => (FACT[a.kind]?.raw ? 1 : 0) - (FACT[b.kind]?.raw ? 1 : 0));
    for (const o of list) {
      if (!o.out) continue;
      for (const [r, n] of Object.entries(o.out)) {
        if (n < 1) continue;
        o.shipT = o.shipT || this.sim.time;
        const lot = RES[r].lot;
        if (n < lot && this.sim.time - o.shipT < 120) continue; // ждём полную партию, но не дольше 2 мин
        if (road >= cap) { o.idle = o.idle || 'нет грузовиков для вывоза'; break; }
        const load = Math.min(Math.floor(n), lot);
        if (load < 1) continue;
        const to = this.storeFor(side, r, o);
        if (to === o) { this.receive(side, r, load, false); o.out[r] -= load; continue; }
        // некому перерабатывать (нет завода и терминала): продукция копится на месте, не больше трёх партий
        if (to === this.g.logi.side[side].hub && !ASSEMBLY_USES.has(r)) { if (n >= lot * 3) { o.out[r] = lot * 3; o.idle = 'склад полон — нет потребителя'; } continue; }
        this.ship(side, o, to, r, load);
        o.out[r] -= load; o.shipT = this.sim.time; road++; T.shipped += load;
      }
    }
  }
  // Излишки бетона, асфальта, стали, сеток и кабеля — на экспорт (если включено)
  exportSurplus(side) {
    const T = this.side[side], L = this.g.logi.side[side];
    if (!T.export || !L.border.comps.some((c) => c.state !== 'destroyed')) return;
    for (const r of ['concrete', 'asphalt', 'steel', 'nets', 'cable']) {
      if (T.pool[r] < 30) continue;
      const n = 10, from = this.storeFor(side, r);
      const v = this.g.logi.spawn(side, 'cargo', this.g.logi.gate(from), this.g.logi.gate(L.border), { type: 'xport', res: r, n, price: RES[r].imp * 0.6 });
      if (v) { T.pool[r] -= n; break; }
    }
  }
  // Сборка: линии сборочных цехов (дроны) и ракетного завода (ракеты); единица начинается, когда есть
  // все комплектующие; если на первую в очереди не хватает — берётся следующая по очереди
  assemble(side, dt) {
    const T = this.side[side];
    const lines = { drone: 0, missile: 0, light: 0 };
    let defect = 0, defW = 0;
    for (const o of this.plants(side)) {
      const A = ASSEMBLY[o.kind];
      if (!A) continue;
      const k = this.power(o) * A.lines;
      if (A.missiles) lines.missile += A.drones ? k / 2 : k;
      if (A.drones) { if (A.light) lines.light += k; else lines.drone += A.missiles ? k / 2 : k; }
      defect += MODES[o.mode || 'normal'].defect * k; defW += k;
    }
    const sp = this.g.state?.k(side, 'prod') ?? 1;
    T.rate = { drone: (lines.drone + lines.light) * sp, missile: lines.missile * sp };
    const defRate = defW ? defect / defW : 0;
    for (const cat of ['drone', 'missile']) {
      let w = (cat === 'drone' ? lines.drone + lines.light : lines.missile) * sp * dt;
      const lightOnly = cat === 'drone' && lines.drone <= 0;
      while (w > 0) {
        let cur = T.cur[cat];
        if (!cur) {
          const qi = T.queue.findIndex((q) => isMissile(DW_DRONES[q.k]) === (cat === 'missile') && (!lightOnly || LIGHT.has(DW_DRONES[q.k].cls) || q.k === 'bober' || q.k === 'molniya') && this.canBuild(side, q.k));
          if (qi < 0) {
            const first = T.queue.find((q) => isMissile(DW_DRONES[q.k]) === (cat === 'missile'));
            if (first && (cat === 'drone' ? lines.drone + lines.light : lines.missile) > 0 && this.sim.time - T.warnT > 240) { T.warnT = this.sim.time; this.sim.msg(`Сборка стоит: на «${DW_DRONES[first.k].short}» не хватает — ${this.missing(side, first.k).map((r) => RES[r].name.toLowerCase()).join(', ')}`, side); }
            break;
          }
          const q = T.queue[qi];
          const poor = this.consume(side, q.k);
          cur = T.cur[cat] = { k: q.k, prog: 0, poor };
          q.paid -= q.paid / q.n; q.n--;
          if (!q.n) T.queue.splice(qi, 1);
        }
        const need = droneWork(cur.k) - cur.prog;
        if (w < need) { cur.prog += w; w = 0; break; }
        w -= need;
        T.stock[cur.k] = (T.stock[cur.k] || 0) + 1;
        if (cur.poor || this.sim.rng.chance(defRate)) T.poor[cur.k] = (T.poor[cur.k] || 0) + 1;
        if (cat === 'missile') this.sim.msg(`Ракетный завод: готова ракета «${DW_DRONES[cur.k].short}» (в запасе ${T.stock[cur.k]})`, side);
        T.cur[cat] = null;
      }
    }
    T.prog = T.cur.drone ? T.cur.drone.prog : 0;
  }
  // Удар по терминалу или заводу с запасом: часть общего запаса сгорает
  onPlantHit(o) {
    if (o.kind !== 'terminal') return;
    const T = this.side[o.side];
    for (const r in T.pool) T.pool[r] = Math.floor(T.pool[r] * 0.7);
    this.sim.msg(`${o.name}: пожар на складе — потеряна треть запаса комплектующих`, o.side);
  }

  // ---------------------------------------------------------------- Сеть
  snap() {
    return ['blue', 'red'].map((sd) => {
      const T = this.side[sd];
      return [T.stock, T.poor, T.queue.map((q) => [q.k, q.n, Math.round(q.paid)]), ['drone', 'missile'].map((c) => (T.cur[c] ? [T.cur[c].k, Math.round(T.cur[c].prog)] : 0)), [Math.round(T.rate.drone * 100) / 100, Math.round(T.rate.missile * 100) / 100],
        Object.fromEntries(Object.entries(T.pool).map(([r, n]) => [r, Math.round(n * 10) / 10])), Object.fromEntries(Object.entries(T.imp).map(([r, n]) => [r, Math.round(n)])), Math.round(T.labor * 100) / 100, Math.round(T.workers), Math.round(T.workersAvail), T.export ? 1 : 0];
    });
  }
  applySnap(s) {
    ['blue', 'red'].forEach((sd, i) => {
      const q = s[i], T = this.side[sd];
      if (!q) return;
      T.stock = q[0]; T.poor = q[1];
      T.queue = q[2].map(([k, n, paid]) => ({ k, n, paid }));
      T.cur = { drone: q[3][0] ? { k: q[3][0][0], prog: q[3][0][1] } : null, missile: q[3][1] ? { k: q[3][1][0], prog: q[3][1][1] } : null };
      T.rate = { drone: q[4][0], missile: q[4][1] };
      T.pool = q[5]; T.imp = q[6]; T.labor = q[7]; T.workers = q[8]; T.workersAvail = q[9]; T.export = !!q[10];
      T.prog = T.cur.drone ? T.cur.drone.prog : 0;
    });
  }
}
export const RESEARCH = {};
