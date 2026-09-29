// Резерв и подкрепления: войска не стоят на карте с начала партии —
// игрок (и ИИ) заказывает их за очки подкрепления, и они прибывают на пункт сбора в тылу.
// Очки копятся со временем; число единиц каждого типа ограничено.

import { FACTIONS } from './factions.js';

// Стоимость в очках и время подвоза (с) — в бою; во время подготовки подвоз быстрый
export const COST = {
  inf: 60, eng: 70, atgm: 90, mortar: 80, uav: 90, truck: 40, medevac: 40, fuel: 45, armcar: 90,
  apc: 120, ifv: 160, btm: 110, tank: 260, arty: 200, spg: 280, mlrs: 320, sam: 220,
};
const DELAY = { foot: 40, wheeled: 60, tracked: 90 };
export const START_POINTS = 1400;
export const INCOME = 45; // очков в минуту

// Сколько единиц каждого типа доступно стороне за партию
const AVAIL = {
  blue: { inf: 9, eng: 2, atgm: 3, mortar: 3, uav: 3, truck: 3, medevac: 2, fuel: 2, armcar: 3, apc: 3, ifv: 4, btm: 1, tank: 3, arty: 2, spg: 1, mlrs: 1, sam: 1 },
  red: { inf: 11, eng: 2, atgm: 2, mortar: 4, uav: 2, truck: 3, medevac: 2, fuel: 2, armcar: 2, apc: 4, ifv: 4, btm: 1, tank: 5, arty: 3, spg: 2, mlrs: 2, sam: 1 },
};

const LABEL = {
  inf: (i) => `${i}-е отд.`, eng: (i) => `Сапёры-${i}`, atgm: (i) => `ПТУР-${i}`,
  mortar: (i) => `Миномёт-${i}`, arty: (i) => `Батарея-${i}`, uav: (i) => `БПЛА-${i}`, medevac: (i) => `Санитарка-${i}`,
  truck: (i) => `Снабжение-${i}`, fuel: (i) => `Заправщик-${i}`,
};

export class Reserve {
  constructor(sim, side, spawn) {
    this.sim = sim;
    this.side = side;
    this.spawn = spawn; // { x, y, dir } — пункт сбора и направление на фронт
    this.points = START_POINTS;
    this.avail = { ...AVAIL[side] };
    this.queue = []; // { type, at }
    this.count = {};
  }

  types(unitTypes) {
    return Object.keys(COST).filter((t) => unitTypes[t] && (this.avail[t] ?? 0) > 0);
  }

  canOrder(type) {
    return (this.avail[type] ?? 0) > 0 && this.points >= COST[type];
  }

  // Заказать подразделение; возвращает текст для журнала
  order(type, move) {
    if (!COST[type]) return null;
    if ((this.avail[type] ?? 0) <= 0) return 'Резерв этого типа исчерпан';
    if (this.points < COST[type]) return `Не хватает очков: нужно ${COST[type]}`;
    this.points -= COST[type];
    this.avail[type]--;
    const g = this.sim.game;
    const last = this.queue.length ? this.queue[this.queue.length - 1].at : this.sim.time;
    // Подготовка: всё подвозится быстро; в бою — колоннами, по очереди
    const d = g?.prep ? 6 : DELAY[move] || 60;
    this.queue.push({ type, at: Math.max(this.sim.time, last) + d });
    return null;
  }

  update() {
    const sim = this.sim;
    while (this.queue.length && sim.time >= this.queue[0].at) {
      const { type } = this.queue.shift();
      this.count[type] = (this.count[type] || 0) + 1;
      const n = this.count[type];
      const F = FACTIONS[this.side].units[type];
      const label = LABEL[type] ? LABEL[type](n) : `${F?.short || type} №${n}`;
      // Выход с пункта сбора: чуть в стороне, чтобы колонна не стояла в одной точке
      const k = (n + Object.keys(this.count).length) % 5;
      const sx = this.spawn.x + (sim.rng.next() - 0.5) * 20, sy = this.spawn.y + (k - 2) * 12;
      const u = sim.spawn(this.side, type, sx, sy, label);
      u.heading = this.spawn.dir > 0 ? 0 : Math.PI;
      // Отъехать с пункта сбора на площадку ожидания
      sim.orderMove([u], this.spawn.x + this.spawn.dir * 180 + (sim.rng.next() - 0.5) * 60, this.spawn.y + (k - 2) * 45);
      sim.msg(`Прибыло: ${label} (${F?.name || type})`, this.side);
    }
  }

  income(dt) {
    this.points += (INCOME * dt) / 60;
  }
}
