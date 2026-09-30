// Государство и мир «Войны дронов»: законы, мобилизация, налоговая ставка, национальные проекты,
// НИОКР, инфляция и курс, репутация (помощь и санкции), иностранные контракты, кредиты и военные
// облигации, цена зерна, случайные события, экономическая победа, рейтинг страны, история показателей.
//
// Всё сводится к множителям k(side, ключ): налоги, торговля, АЗС, пошлины, зерно, промышленность,
// зарплаты, содержание армии, цена дронов и стройки, ремонт, точность ПВО, урожай, пуски, спрос.

export const LAWS = {
  martial: { name: 'Военное положение', desc: 'ремонт на 25% быстрее, зарплата бригад −30%; налоги −10%, довольство −5%', eff: { repairTime: 0.8, wages: 0.7, tax: 0.9 }, happy: -0.05 },
  curfew: { name: 'Комендантский час', desc: 'страх после ударов проходит вдвое быстрее; торговля −15%, АЗС −10%', eff: { fearDecay: 2, trade: 0.85, fuel: 0.9 } },
  prices: { name: 'Контроль цен', desc: 'довольство +5%; выручка магазинов −10%', eff: { trade: 0.9 }, happy: 0.05 },
  fuelcards: { name: 'Талоны на топливо', desc: 'продажа топлива −30%, зато бензовозы на мехдворы агрофирм идут вдвое чаще', eff: { fuel: 0.7, farmFuel: 2 }, happy: -0.02 },
  fund: { name: 'Фонд восстановления', desc: 'взнос 3 оч/мин; оборудование для ремонта на 40% дешевле', eff: { repairCost: 0.6 }, fee: 3 },
};
export const TAXES = [{ name: 'Низкие', k: 0.8, happy: 0.05 }, { name: 'Обычные', k: 1, happy: 0 }, { name: 'Высокие', k: 1.25, happy: -0.08 }];
export const MOBIL = [
  { name: 'Добровольцы', desc: 'армия только из контрактников', eff: {} },
  { name: 'Частичная мобилизация', desc: 'содержание армии −15%, пусков +15%; рабочих рук −7%, довольство −4%', eff: { upkeep: 0.85, launch: 1.15, labor: 0.93 }, happy: -0.04 },
  { name: 'Всеобщая мобилизация', desc: 'содержание армии −30%, пусков +30%; рабочих рук −15%, довольство −9%', eff: { upkeep: 0.7, launch: 1.3, labor: 0.85 }, happy: -0.09 },
];
export const PROJECTS = {
  powerbridge: { name: 'Энергомост с соседом', cost: 900, time: 900, desc: '+150 МВт импорта электроэнергии: вторая межсистемная ЛЭП', importMW: 150 },
  highway: { name: 'Магистраль к границе', cost: 800, time: 900, desc: 'фуры быстрее проходят границу: пошлины и экспорт +25%', eff: { transit: 1.25 } },
  technopark: { name: 'Технопарк БПЛА', cost: 1000, time: 900, desc: 'дроны на 15% дешевле, комплектующих нужно на 30% меньше', eff: { drone: 0.85, parts: 0.7 } },
  agroholding: { name: 'Агрохолдинг', cost: 700, time: 720, desc: 'урожайность +25%, экспорт зерна +10%', eff: { yield: 1.25, agro: 1.1 } },
  airshield: { name: 'Эшелонированная ПВО городов', cost: 1100, time: 900, desc: 'все средства ПВО точнее на 12%', eff: { adEff: 1.12 } },
};
export const TECH = {
  energy: { name: 'Энергетика', levels: [
    { name: 'Быстрый ремонт сетей', cost: 250, time: 300, desc: 'ремонт на 15% быстрее', eff: { repairTime: 0.85 } },
    { name: 'Модульные подстанции', cost: 400, time: 420, desc: 'оборудование для ремонта на 20% дешевле', eff: { repairCost: 0.8 } },
    { name: 'Умные сети', cost: 600, time: 600, desc: 'потребление −7% без отключений', eff: { demand: 0.93 } },
  ] },
  economy: { name: 'Экономика', levels: [
    { name: 'Логистика', cost: 250, time: 300, desc: 'торговля и АЗС +8%', eff: { trade: 1.08, fuel: 1.08 } },
    { name: 'Агротехнологии', cost: 400, time: 420, desc: 'урожайность +12%', eff: { yield: 1.12 } },
    { name: 'Цифровое государство', cost: 600, time: 600, desc: 'налоги +12%', eff: { tax: 1.12 } },
  ] },
  military: { name: 'Оборонные разработки', levels: [
    { name: 'Помехозащищённая навигация', cost: 250, time: 300, desc: 'дроны на 8% дешевле', eff: { drone: 0.92 } },
    { name: 'Радары нового поколения', cost: 400, time: 420, desc: 'ПВО точнее на 8%', eff: { adEff: 1.08 } },
    { name: 'Массовое производство', cost: 600, time: 600, desc: 'пусков +25%, содержание армии −10%', eff: { launch: 1.25, upkeep: 0.9 } },
  ] },
};
const CREDIT = { amount: 600, total: 780, minutes: 30 };
const BONDS = { amount: 400, total: 480, minutes: 40 };
const EVENTS = [
  { id: 'drought', w: 2, text: 'Засуха: урожайность −30% на 20 минут', eff: { yield: 0.7 }, dur: 1200 },
  { id: 'harvest', w: 2, text: 'Благоприятная погода: урожайность +25% на 20 минут', eff: { yield: 1.25 }, dur: 1200 },
  { id: 'strike', w: 1.5, text: 'Забастовка на заводах: промышленность −20% на 6 минут (люди недовольны)', eff: { industry: 0.8 }, dur: 360, when: (s) => s.happy < 0.8 },
  { id: 'cold', w: 2, text: 'Похолодание: потребление электроэнергии +12% на 8 минут', eff: { demand: 1.12 }, dur: 480 },
  { id: 'fuelcut', w: 1.5, text: 'Перебои с поставками нефти: бензовозы на мехдворы простаивают 4 минуты', eff: { farmFuel: 0 }, dur: 240 },
  { id: 'invest', w: 1, text: 'Иностранные инвестиции: +200 оч.', points: 200, when: (s) => s.rep >= 50 },
  { id: 'cyber', w: 1, text: 'Кибератака на энергосистему: щит управления подстанции выведен из строя', cyber: true },
  { id: 'volunteers', w: 1.5, text: 'Добровольцы: сформирована ещё одна ремонтная бригада', crew: true },
  { id: 'demand', w: 1.5, text: 'Рост мировых цен на зерно', price: 0.2 },
];

export class DWState {
  constructor(g) {
    this.g = g;
    this.sim = g.sim;
    this.grainPrice = 1;
    this.side = {};
    for (const side of ['blue', 'red']) {
      this.side[side] = {
        laws: {}, lawT: 0, tax: 1, mobil: 0, project: null, projects: [], tech: { energy: 0, economy: 0, military: 0 }, research: null,
        infl: 0, rate: 1, rep: 70, debts: [], contracts: [], offerT: this.sim.time + 600, eventT: this.sim.time + 900, temp: [], log: [],
        mil: [], inc: [], hist: [], ecoWin: 0,
      };
    }
    this.histT = 0;
    this.tickT = 0;
  }
  // ---------------------------------------------------------------- Множители
  // Кэш множителей: пересчёт раз в 5 с и после команд (k() зовут в каждой стрельбе ПВО)
  k(side, key) {
    const ck = side + key;
    const c = this.cache?.[ck];
    if (c !== undefined) return c;
    const v = this.kRaw(side, key);
    (this.cache = this.cache || {})[ck] = v;
    return v;
  }
  kRaw(side, key) {
    const T = this.side[side];
    if (!T) return 1;
    let k = 1;
    const mul = (e) => { if (e && e[key] !== undefined) k *= e[key]; };
    for (const id in T.laws) if (T.laws[id]) mul(LAWS[id].eff);
    mul(MOBIL[T.mobil].eff);
    for (const id of T.projects) mul(PROJECTS[id].eff);
    for (const b in TECH) for (let i = 0; i < T.tech[b]; i++) mul(TECH[b].levels[i].eff);
    for (const e of T.temp) mul(e.eff);
    if (key === 'tax') k *= TAXES[T.tax].k;
    k *= this.g.infra?.k(side, key) ?? 1; // сезон, НПЗ, области
    // инфляция: всё, что покупает государство, дорожает
    if (key === 'drone' || key === 'arms' || key === 'build') k *= 1 + T.infl;
    // курс валюты: выручка от экспорта и пошлин
    if (key === 'transit' || key === 'agro') k *= T.rate;
    // санкции при низкой репутации
    if (key === 'agro' && T.rep < 35) k *= 0.85;
    if (key === 'parts' && T.rep < 35) k *= 1.6;
    return k;
  }
  happyAdd(side) {
    const T = this.side[side];
    let h = TAXES[T.tax].happy + (MOBIL[T.mobil].happy || 0) - T.infl * 0.25;
    for (const id in T.laws) if (T.laws[id]) h += LAWS[id].happy || 0;
    return h;
  }
  importMW(side) { return this.side[side].projects.reduce((a, id) => a + (PROJECTS[id].importMW || 0), 0); }
  fees(side) {
    const T = this.side[side];
    let f = 0;
    for (const id in T.laws) if (T.laws[id]) f += LAWS[id].fee || 0;
    for (const d of T.debts) f += d.perMin;
    return f;
  }
  // ---------------------------------------------------------------- Команды
  cooldown(T) { return this.sim.time < T.lawT ? `Законы меняют не чаще раза в 3 минуты (ещё ${Math.ceil(T.lawT - this.sim.time)} с)` : null; }
  setLaw(side, id, on) {
    this.cache = {};
    const T = this.side[side];
    if (!LAWS[id]) return 'Нет такого закона';
    const cd = this.cooldown(T); if (cd) return cd;
    T.laws[id] = !!on; T.lawT = this.sim.time + 180;
    this.sim.msg(`${LAWS[id].name}: ${on ? 'введено' : 'отменено'}`, side);
    return null;
  }
  setTax(side, level) {
    this.cache = {};
    const T = this.side[side];
    const cd = this.cooldown(T); if (cd) return cd;
    T.tax = Math.max(0, Math.min(2, level | 0)); T.lawT = this.sim.time + 180;
    this.sim.msg(`Налоговая ставка: ${TAXES[T.tax].name.toLowerCase()}`, side);
    return null;
  }
  setMobil(side, level) {
    this.cache = {};
    const T = this.side[side];
    const cd = this.cooldown(T); if (cd) return cd;
    T.mobil = Math.max(0, Math.min(2, level | 0)); T.lawT = this.sim.time + 180;
    this.sim.msg(`Мобилизация: ${MOBIL[T.mobil].name.toLowerCase()}`, side);
    return null;
  }
  pay(side, cost) { const S = this.g.sides[side]; if (S.points < cost) return `Не хватает очков: нужно ${Math.round(cost)}`; S.points -= cost; S.stats.spent += cost; return null; }
  startProject(side, id) {
    const T = this.side[side], P = PROJECTS[id];
    if (!P) return 'Нет такого проекта';
    if (T.project) return 'Национальный проект уже идёт';
    if (T.projects.includes(id)) return 'Уже построено';
    const cost = Math.round(P.cost * this.k(side, 'build'));
    const err = this.pay(side, cost); if (err) return err;
    T.project = { id, until: this.sim.time + P.time, total: P.time };
    this.sim.msg(`Национальный проект «${P.name}» начат (−${cost} оч., ${Math.round(P.time / 60)} мин)`, side);
    return null;
  }
  startResearch(side, branch) {
    const T = this.side[side], B = TECH[branch];
    if (!B) return 'Нет такого направления';
    if (T.research) return 'НИОКР уже идут';
    const L = B.levels[T.tech[branch]];
    if (!L) return 'Направление исследовано полностью';
    const err = this.pay(side, L.cost); if (err) return err;
    T.research = { branch, until: this.sim.time + L.time, total: L.time };
    this.sim.msg(`НИОКР: «${L.name}» (−${L.cost} оч., ${Math.round(L.time / 60)} мин)`, side);
    return null;
  }
  takeCredit(side, kind) {
    const T = this.side[side], S = this.g.sides[side];
    const C = kind === 'bonds' ? BONDS : CREDIT;
    if (T.debts.some((d) => d.kind === kind)) return kind === 'bonds' ? 'Облигации уже выпущены — сначала погасите' : 'Кредит уже взят — сначала погасите';
    if (kind === 'bonds' && (S.morale ?? 100) < 70) return 'Облигации покупают, когда тыл крепок (устойчивость от 70)';
    S.points += C.amount;
    T.debts.push({ kind, left: C.total, perMin: C.total / C.minutes });
    this.sim.msg(kind === 'bonds' ? `Военные облигации: +${C.amount} оч., погашение ${C.total} за ${C.minutes} мин` : `Кредит: +${C.amount} оч., возврат ${C.total} за ${C.minutes} мин`, side);
    return null;
  }
  acceptContract(side, id) {
    const T = this.side[side];
    const c = T.contracts.find((q) => q.id === id);
    if (!c || c.state !== 'offer') return 'Предложение уже неактуально';
    if (c.kind === 'arms') {
      const cost = Math.round(c.price);
      const err = this.pay(side, cost); if (err) return err;
      c.state = 'done';
      T.armsCredit = (T.armsCredit || 0) + 1;
      this.sim.msg(`Закупка: ${c.title} — поставка оплачена, поставьте ЗРК бесплатно на вкладке «ПВО»`, side);
      return null;
    }
    c.state = 'active'; c.start = this.snapshotProgress(side, c); c.until = this.sim.time + c.time;
    this.sim.msg(`Контракт принят: ${c.title}`, side);
    return null;
  }
  snapshotProgress(side, c) {
    if (c.kind === 'grain') return this.g.econ.side[side].exported;
    return 0;
  }
  // ---------------------------------------------------------------- Цикл
  update(dt) {
    const t = this.sim.time;
    this.tickT -= dt;
    if (this.tickT > 0) return;
    this.cache = {};
    const step = 5 - this.tickT; this.tickT = 5;
    const g = this.g;
    // цена зерна: случайное блуждание около 1
    this.grainPrice = Math.max(0.65, Math.min(1.5, this.grainPrice + this.sim.rng.gauss(0, 0.01) + (1 - this.grainPrice) * 0.01));
    for (const side of ['blue', 'red']) {
      const T = this.side[side], S = g.sides[side];
      T.temp = T.temp.filter((e) => e.until > t);
      // долги: платёж в минуту
      for (const d of T.debts) { const p = Math.min(d.left, (d.perMin * step) / 60); d.left -= p; }
      T.debts = T.debts.filter((d) => d.left > 0.5);
      // нацпроект и НИОКР
      if (T.project && t >= T.project.until) { T.projects.push(T.project.id); this.sim.msg(`Национальный проект «${PROJECTS[T.project.id].name}» завершён`, side); T.project = null; }
      if (T.research && t >= T.research.until) { const b = T.research.branch; this.sim.msg(`НИОКР завершены: «${TECH[b].levels[T.tech[b]].name}»`, side); T.tech[b]++; T.research = null; }
      // инфляция: военные траты против дохода за последние 10 минут
      T.mil.push(S.stats.mil || 0); T.inc.push(Math.max(1, S.income)); // только военные траты: дроны, ПВО, содержание армии
      if (T.mil.length > 120) { T.mil.shift(); T.inc.shift(); }
      const spent10 = T.mil.length > 1 ? (T.mil[T.mil.length - 1] - T.mil[0]) / (T.mil.length * step / 60) : 0;
      const inc10 = T.inc.reduce((a, v) => a + v, 0) / T.inc.length;
      const ratio = spent10 / Math.max(10, inc10);
      const target = Math.max(0, Math.min(0.5, (ratio - 0.6) * 0.6));
      // стартовая расстановка ПВО не в счёт: первые 10 минут боя инфляция не растёт
      if (!g.prep && t - (g.startAt || 0) > 600) T.infl += Math.sign(target - T.infl) * Math.min(Math.abs(target - T.infl), 0.002 * step / 5);
      // курс: доля экспорта и пошлин в доходе
      const I = S.inc || {};
      const exp = ((I.agro || 0) + (I.transit || 0)) / Math.max(10, S.income);
      T.rate = Math.max(0.85, Math.min(1.2, T.rate + (0.85 + exp * 1.0 - T.rate) * 0.02));
      // репутация тянется к 70
      T.rep += (70 - T.rep) * 0.002 * step;
      // помощь союзников: тыл слабеет, а репутация хорошая
      T.aid = (S.morale ?? 100) < 55 && T.rep >= 55 ? 4 : 0;
      if (T.aid && t > (T.aidSpareT || 0)) { T.aidSpareT = t + 1200; S.spare++; this.sim.msg('Помощь союзников: передан резервный автотрансформатор', side); }
      this.contracts(side, t);
      this.events(side, t);
      this.ecoVictory(side);
    }
    this.cache = {};
    this.histT -= step;
    if (this.histT <= 0) { this.histT = 30; for (const side of ['blue', 'red']) { const S = g.sides[side], H = this.side[side].hist; H.push([Math.round(S.income), Math.round(S.morale ?? 100), Math.round((S.supply ?? 1) * 100), Math.round(g.econ.summary(side).pop / 1000)]); if (H.length > 240) H.shift(); } }
  }
  // Доход (оч/мин) от помощи и расходы (оч/мин) на законы и долги
  flows(side) { const T = this.side[side]; return { aid: T.aid || 0, fees: this.fees(side) }; }
  // ---------------------------------------------------------------- Контракты
  contracts(side, t) {
    const T = this.side[side], g = this.g, rng = this.sim.rng, K = g.incomeK(side);
    for (const c of T.contracts) {
      if (c.state === 'offer' && t > c.expires) c.state = 'expired';
      if (c.state !== 'active') continue;
      if (c.kind === 'grain') c.progress = g.econ.side[side].exported - c.start;
      if (c.kind === 'power') { const S = g.sides[side]; if (S.gen > S.demand * 1.08) c.progress += 5; }
      if (c.progress >= c.need) {
        c.state = 'done'; g.sides[side].points += c.reward; T.rep = Math.min(100, T.rep + 4);
        this.sim.msg(`Контракт выполнен: ${c.title} — премия ${c.reward} оч., репутация растёт`, side);
      } else if (t > c.until) { c.state = 'failed'; T.rep = Math.max(0, T.rep - 6); this.sim.msg(`Контракт сорван: ${c.title} — репутация падает`, side); }
    }
    T.contracts = T.contracts.filter((c) => c.state === 'offer' || c.state === 'active' || t - (c.until || c.expires) < 120);
    if (t < T.offerT) return;
    T.offerT = t + 720 + rng.float(0, 480);
    const n = T.contracts.length + (this.nextId = (this.nextId || 0) + 1);
    const kind = rng.weighted([['grain', 3], ['power', 2], ['arms', 1.5]]);
    let c;
    if (kind === 'grain') { const need = Math.round(rng.float(15, 30)) * 1000; c = { kind, title: `Поставить ${need / 1000} тыс. т зерна за 15 мин`, need, time: 900, reward: Math.round(need * 0.012 * K) }; }
    else if (kind === 'power') c = { kind, title: 'Экспорт электроэнергии: 8 минут держать генерацию на 8% выше потребления (в течение 20 мин)', need: 480, time: 1200, reward: Math.round(260 * K) };
    else c = { kind, title: side === 'blue' ? 'Партнёры предлагают ЗРК IRIS-T со скидкой 45%' : 'Партнёры предлагают ЗРК «Бук-М2» со скидкой 45%', price: Math.round(320 * 0.55 * this.k(side, 'arms')) };
    Object.assign(c, { id: n, state: 'offer', expires: t + 360, progress: 0 });
    T.contracts.push(c);
    this.sim.msg(`Иностранный заказ: ${c.title}${c.reward ? ` — премия ${c.reward} оч.` : ` — ${c.price} оч.`} (принять на вкладке «Государство», 6 мин)`, side);
  }
  // ---------------------------------------------------------------- События
  events(side, t) {
    const T = this.side[side], g = this.g, rng = this.sim.rng;
    if (t < T.eventT || g.prep) return;
    T.eventT = t + 900 + rng.float(0, 600);
    const sum = g.econ.summary(side);
    const ok = EVENTS.filter((e) => (!e.when || e.when({ happy: sum.happy, rep: T.rep })) && !(e.id === 'fuelcut' && g.infra?.has(side, 'refinery')));
    const e = rng.weighted(ok.map((q) => [q, q.w]));
    if (!e) return;
    if (e.eff) T.temp.push({ id: e.id, eff: e.eff, until: t + e.dur, text: e.text });
    if (e.points) g.sides[side].points += e.points;
    if (e.price) this.grainPrice = Math.min(1.5, this.grainPrice + e.price);
    if (e.crew) g.sides[side].crews.push({ id: Math.max(0, ...g.sides[side].crews.map((c) => c.id)) + 1, job: null, veh: null });
    if (e.cyber) { const ps = g.objs(side, 'ps110'); const o = ps[rng.int(0, ps.length - 1)]; const c = o?.comps.find((q) => q.k === 'ctrl' && q.state === 'ok'); if (c) { c.state = 'damaged'; c.hp = 0.5; g.repair(side, c.id, false); } }
    T.log.push([t, e.text]); if (T.log.length > 12) T.log.shift();
    this.sim.msg(`Событие: ${e.text}`, side);
  }
  // Репутация: удары рядом с жильём противника
  onImpact(attacker, x, y) {
    const T = this.side[attacker];
    if (!T) return;
    for (const s of this.g.world.settlements) {
      if (s.side === attacker) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < (s.type === 'city' ? 1800 : 700)) { T.rep = Math.max(0, T.rep - 0.8); return; }
    }
  }
  // ---------------------------------------------------------------- Экономическая победа
  gdp(side) { const I = this.g.sides[side].inc || {}; return Math.max(1, (I.industry || 0) + (I.tax || 0) + (I.trade || 0) + (I.fuel || 0) + (I.transit || 0) + (I.agro || 0)); }
  ecoVictory(side) {
    const g = this.g, T = this.side[side];
    const enemy = side === 'blue' ? 'red' : 'blue';
    if (g.winner || g.prep || this.sim.time - (g.startAt || 0) < 5400) { T.ecoWin = 0; return; }
    const lead = this.gdp(side) / this.gdp(enemy);
    if (lead >= 2.2 && (g.sides[enemy].morale ?? 100) < 60) T.ecoWin += 5; else T.ecoWin = Math.max(0, T.ecoWin - 10);
    if (T.ecoWin >= 900) {
      g.winner = side;
      g.reason = `Экономическая победа: экономика стороны «${side === 'blue' ? 'Велнария' : 'Кардагор'}» вдвое сильнее, противник не выдержал гонки`;
      this.sim.msg(g.reason);
    }
  }
  // ---------------------------------------------------------------- Рейтинг страны
  rating(side) {
    const g = this.g, S = g.sides[side], sum = g.econ.summary(side);
    const built = g.objects.filter((o) => o.side === side && o.built && !(o.build && !o.build.up)).length;
    const lv = g.objects.filter((o) => o.side === side).reduce((a, o) => a + ((o.level || 1) - 1), 0);
    return Math.round(this.gdp(side) * 0.5 + sum.pop / 8000 + sum.happy * 25 + (S.morale ?? 100) * 0.3 + built * 1.5 + lv + this.side[side].projects.length * 8 + Object.values(this.side[side].tech).reduce((a, v) => a + v, 0) * 3 + this.side[side].rep * 0.1);
  }
  // ---------------------------------------------------------------- Сеть
  snap() {
    const R1 = (v) => Math.round(v * 100) / 100;
    return { gp: R1(this.grainPrice), s: ['blue', 'red'].map((sd) => { const T = this.side[sd]; return { laws: T.laws, lawT: T.lawT, tax: T.tax, mobil: T.mobil, project: T.project, projects: T.projects, tech: T.tech, research: T.research, infl: R1(T.infl), rate: R1(T.rate), rep: Math.round(T.rep), debts: T.debts.map((d) => ({ kind: d.kind, left: Math.round(d.left), perMin: R1(d.perMin) })), contracts: T.contracts, temp: T.temp.map((e) => ({ id: e.id, until: e.until, text: e.text, eff: e.eff })), log: T.log, hist: T.hist.slice(-120), aid: T.aid, armsCredit: T.armsCredit || 0, ecoWin: T.ecoWin }; }) };
  }
  applySnap(q) {
    this.grainPrice = q.gp;
    ['blue', 'red'].forEach((sd, i) => Object.assign(this.side[sd], q.s[i]));
    this.cache = {};
  }
}
