// «Война дронов»: исследования (открывают дроны, средства ПВО и постройки) и производство дронов.
// Дроны больше не берутся из воздуха: их заказывают на заводе БПЛА (оплата при заказе),
// цеха собирают по очереди, готовые идут в запас; пуск расходует запас.

import { DW_DRONES } from './dronewar.js';

// Что открыто с начала игры (остальное — через исследования)
const BASE_DRONES = new Set(['shahed', 'gerbera', 'orlan', 'fp1', 'bober', 'grif', 'leleka']);
const BASE_AD = new Set(['mog', 'spaag', 'sam', 'ew', 'acoustic', 'radar']);
const BASE_BUILD = new Set(['store', 'fuel', 'market', 'hub', 'elevator', 'agro', 'launch', 'factory', 'decoy', 'housing', 'hospital', 'school', 'mill', 'dairy', 'autopark', 'watertower', 'pontoon']);

export const RESEARCH = {
  // ----- дроны и производство
  loiter: { cat: 'Дроны', name: 'Барражирующие боеприпасы', cost: 180, time: 240, drones: ['lancet', 'warmate'], desc: '«Ланцет» / Warmate — по найденным разведкой позициям ПВО и машинам' },
  heavy: { cat: 'Дроны', name: 'Тяжёлые и реактивные БПЛА', cost: 320, time: 420, drones: ['geran3', 'fp2', 'lyutyi'], desc: 'реактивная «Герань-3»; FP-2 (105 кг) и точный «Лютый»' },
  hunter: { cat: 'Дроны', name: 'Машинное зрение: охотники', cost: 280, time: 360, req: ['loiter'], drones: ['geran_h', 'molniya', 'saker'], desc: 'дроны сами ищут фуры и бензовозы на дорогах' },
  mass: { cat: 'Дроны', name: 'Поточная сборка', cost: 250, time: 300, eff: { lines: 1 }, desc: '+1 сборочная линия на заводе БПЛА' },
  robot: { cat: 'Дроны', name: 'Роботизированные линии', cost: 450, time: 480, req: ['mass'], eff: { speed: 1.35 }, desc: 'сборка на 35% быстрее' },
  workshop: { cat: 'Дроны', name: 'Рассредоточенное производство', cost: 220, time: 300, req: ['mass'], build: ['workshop'], desc: 'сборочные цеха БПЛА в тылу: +2 линии каждый, завод уже не единственная цель' },
  sat: { cat: 'Дроны', name: 'Спутниковая разведка', cost: 260, time: 360, desc: 'раз в 8 минут снимок открывает случайный объект противника' },
  // ----- ПВО
  icpt: { cat: 'ПВО', name: 'Дроны-перехватчики', cost: 200, time: 240, ad: ['icpt'], desc: 'расчёты перехватчиков «Стинг» / «Ёлка»' },
  ewd: { cat: 'ПВО', name: 'Стационарные купола РЭБ', cost: 260, time: 300, ad: ['ewd'], desc: 'купол РЭБ над важным объектом' },
  // ----- строительство
  energy: { cat: 'Строительство', name: 'Распределённая энергетика', cost: 240, time: 300, build: ['solar', 'bess'], desc: 'солнечные станции и накопители энергии' },
  industry: { cat: 'Строительство', name: 'Тяжёлая промышленность', cost: 300, time: 360, build: ['refinery', 'coalmine', 'cement'], desc: 'НПЗ, угольная шахта, цементный завод' },
  export: { cat: 'Строительство', name: 'Экспортная инфраструктура', cost: 220, time: 300, build: ['railterm', 'port'], desc: 'ж/д терминал и речной порт' },
  retail: { cat: 'Строительство', name: 'Крупный ритейл', cost: 150, time: 200, build: ['mall'], desc: 'торговые центры' },
  reserve: { cat: 'Строительство', name: 'Государственный резерв', cost: 150, time: 200, build: ['reserve'], desc: 'склады госрезерва' },
};
const UNLOCK = { drone: {}, ad: {}, build: {} };
for (const [id, R] of Object.entries(RESEARCH)) {
  for (const k of R.drones || []) UNLOCK.drone[k] = id;
  for (const k of R.ad || []) UNLOCK.ad[k] = id;
  for (const k of R.build || []) UNLOCK.build[k] = id;
}
// Работа на сборку одного дрона (линия·секунд): дороже — дольше
export const droneWork = (k) => Math.max(20, DW_DRONES[k].cost * 3);
const START_STOCK = { strike: 10, decoy: 12, recon: 4 };
const QUEUE_MAX = 80;

export class DWResearch {
  constructor(g) {
    this.g = g;
    this.sim = g.sim;
    this.side = {};
    for (const side of ['blue', 'red']) {
      const stock = {};
      for (const [k, D] of Object.entries(DW_DRONES)) if (D.side === side && D.cls !== 'interceptor') stock[k] = BASE_DRONES.has(k) ? (k === 'bober' ? 6 : START_STOCK[D.cls] || 0) : 0;
      this.side[side] = { done: [], cur: null, stock, queue: [], prog: 0, rate: 0 };
    }
  }
  // ---------------------------------------------------------------- Исследования
  has(side, id) { return this.side[side].done.includes(id); }
  droneOk(side, k) { const r = UNLOCK.drone[k]; return !r || this.has(side, r); }
  adOk(side, k) { const r = UNLOCK.ad[k]; return !r || this.has(side, r); }
  buildOk(side, k) { const r = UNLOCK.build[k]; return !r || this.has(side, r); }
  needFor(kind, k) { const r = UNLOCK[kind][k]; return r ? RESEARCH[r].name : ''; }
  cost(side, id) { return Math.round(RESEARCH[id].cost * (this.g.state?.k(side, 'build') ?? 1)); }
  available(side, id) {
    const R = RESEARCH[id];
    return !this.has(side, id) && (R.req || []).every((q) => this.has(side, q));
  }
  start(side, id) {
    const R = RESEARCH[id], T = this.side[side], S = this.g.sides[side];
    if (!R) return 'Нет такого исследования';
    if (this.has(side, id)) return 'Уже исследовано';
    if (T.cur) return 'Лаборатории заняты другим исследованием';
    if (!this.available(side, id)) return `Сначала: ${R.req.filter((q) => !this.has(side, q)).map((q) => `«${RESEARCH[q].name}»`).join(', ')}`;
    const cost = this.cost(side, id);
    if (S.points < cost) return `Не хватает очков: нужно ${cost}`;
    S.points -= cost; S.stats.spent += cost;
    T.cur = { id, until: this.sim.time + R.time, total: R.time };
    this.sim.msg(`Исследование «${R.name}» начато (−${cost} оч., ${Math.round(R.time / 60)} мин)`, side);
    return null;
  }
  // ---------------------------------------------------------------- Производство
  // Сборочные линии: цеха завода БПЛА (и построенных сборочных цехов), если есть свет; плюс поставки партнёров
  lines(side) {
    const g = this.g;
    let n = 0;
    for (const o of g.objs(side)) {
      if ((o.kind !== 'factory' && o.kind !== 'workshop') || (o.build && !o.build.up) || o.evac) continue;
      const shops = o.comps.filter((c) => c.k === 'shop');
      if (!shops.length) continue;
      const ok = shops.filter((c) => g.compOk(c)).length / shops.length;
      const ps = g.econ.nearestPS(side, o.x, o.y);
      const power = Math.max(0.25, Math.min(1, ps?.supply ?? 1));
      n += (o.kind === 'factory' ? 3 + (this.has(side, 'mass') ? 1 : 0) : 2 * (o.level || 1)) * ok * power;
    }
    return n + 0.5; // поставки партнёров — даже без завода что-то приходит
  }
  speed(side) { return (this.has(side, 'robot') ? 1.35 : 1) * (this.g.state?.k(side, 'prod') ?? 1); }
  queued(side, k) { return this.side[side].queue.filter((q) => q.k === k).reduce((a, q) => a + q.n, 0); }
  order(side, k, n = 1) {
    const D = DW_DRONES[k], T = this.side[side], S = this.g.sides[side];
    if (!D || D.side !== side || D.cls === 'interceptor') return 'Этот тип не производится';
    if (!this.droneOk(side, k)) return `Нужно исследование «${this.needFor('drone', k)}»`;
    if (T.queue.reduce((a, q) => a + q.n, 0) + n > QUEUE_MAX) return `Очередь завода заполнена (до ${QUEUE_MAX})`;
    const unit = this.g.droneCost(side, k), cost = Math.round(unit * n);
    if (S.points < cost) return `Не хватает очков: нужно ${cost}`;
    S.points -= cost; S.stats.spent += cost; S.stats.mil += cost;
    this.g.econ.useParts(side, cost);
    const last = T.queue[T.queue.length - 1];
    if (last && last.k === k) { last.n += n; last.paid += cost; } else T.queue.push({ k, n, paid: cost });
    return null;
  }
  cancel(side, i) {
    const T = this.side[side], q = T.queue[i];
    if (!q) return 'Нет такого заказа';
    const keep = i === 0 && T.prog > 0 ? 1 : 0; // начатый дрон доделывают
    const back = q.n - keep;
    if (back <= 0) return 'Этот дрон уже собирают';
    const refund = Math.round((q.paid / q.n) * back);
    this.g.sides[side].points += refund;
    q.paid -= refund; q.n = keep;
    if (!q.n) T.queue.splice(i, 1);
    return null;
  }
  stock(side, k) { return this.side[side].stock[k] || 0; }
  take(side, k, n) { const T = this.side[side]; const m = Math.min(n, T.stock[k] || 0); T.stock[k] = (T.stock[k] || 0) - m; return m; }
  // ---------------------------------------------------------------- Такт
  update(dt) {
    const t = this.sim.time;
    for (const side of ['blue', 'red']) {
      const T = this.side[side];
      if (T.cur && t >= T.cur.until) {
        T.done.push(T.cur.id);
        const R = RESEARCH[T.cur.id];
        this.sim.msg(`Исследование завершено: «${R.name}» — ${R.desc}`, side);
        T.cur = null;
      }
      T.rate = this.lines(side) * this.speed(side);
      let w = T.rate * dt;
      while (w > 0 && T.queue.length) {
        const q = T.queue[0], need = droneWork(q.k) - T.prog;
        if (w < need) { T.prog += w; w = 0; break; }
        w -= need; T.prog = 0;
        T.stock[q.k] = (T.stock[q.k] || 0) + 1;
        q.paid -= q.paid / q.n; q.n--;
        if (!q.n) T.queue.shift();
      }
      if (!T.queue.length) T.prog = 0;
    }
  }
  // ---------------------------------------------------------------- Сеть
  snap() {
    return ['blue', 'red'].map((sd) => { const T = this.side[sd]; return [T.done, T.cur ? [T.cur.id, Math.round(T.cur.until), T.cur.total] : 0, T.stock, T.queue.map((q) => [q.k, q.n, Math.round(q.paid)]), Math.round(T.prog * 10) / 10, Math.round(T.rate * 100) / 100]; });
  }
  applySnap(s) {
    ['blue', 'red'].forEach((sd, i) => {
      const q = s[i], T = this.side[sd];
      T.done = q[0]; T.cur = q[1] ? { id: q[1][0], until: q[1][1], total: q[1][2] } : null; T.stock = q[2];
      T.queue = q[3].map(([k, n, paid]) => ({ k, n, paid })); T.prog = q[4]; T.rate = q[5];
    });
  }
}
