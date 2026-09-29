// Стороны конфликта: вымышленные государства, их армии и техника.
// Внутренние ключи сторон остаются 'blue' (запад) и 'red' (восток).

export const FACTIONS = {
  blue: {
    key: 'blue',
    country: 'Республика Велнария',
    short: 'Велнария',
    army: 'Силы обороны Велнарии',
    motto: 'Западные образцы вооружения',
    color: '#4f8dff',
    fill: '#80b4ff',
    flag: ['#2a5ca8', '#e9c43b'],
    enemy: [1, 0],
    // Ночные приборы и тепловизоры: доля дальности обнаружения ночью
    night: 0.7,
    doctrine: [
      'Тепловизоры и ночные прицелы у большинства бойцов — ночью видят дальше противника',
      'Гаубицы 155 мм и миномёты 81 мм — точнее, но боеприпасов меньше',
      'Точная бронетехника с хорошей оптикой, меньше единиц',
      'Разведывательные и ударные дроны с тепловизорами',
    ],
    camo: { body: '#5a6142', light: '#6b7350', dark: '#3d4230', track: '#28291f' },
    units: {
      inf: { name: 'Мотопехотное отделение', short: 'Пехота' },
      eng: { name: 'Инженерное отделение', short: 'Сапёры' },
      btm: { name: 'Инженерная машина «Бобр»', short: 'Бобр' },
      tank: { name: 'Танк «Страж-2А»', short: 'Страж', armor: 0.9, gun: { range: 2600, acc: 0.75 } },
      ifv: { name: 'БМП «Бастион»', short: 'Бастион', armor: 0.45, gun: { range: 1800, acc: 0.6 } },
      apc: { name: 'БТР «Рысь»', short: 'Рысь', armor: 0.35, gun: { range: 1400, acc: 0.5 } },
      arty: { name: 'Гаубица «Л-155» (буксир.)', short: 'Л-155', caliber: 155, ammo: 30, reload: 9 },
      mortar: { name: 'Миномётный расчёт 81 мм', short: 'Миномёт', caliber: 81, ammo: 50 },
      truck: { name: 'Грузовик «Атлас»', short: 'Атлас' },
      uav: { name: 'Расчёт БПЛА «Сокол»', short: 'БПЛА', drones: { recon: 2, fpv: 4, bomber: 1 } },
      medevac: { name: 'Санитарная машина «Ангел»', short: 'Санитарка' },
    },
  },
  red: {
    key: 'red',
    country: 'Кардагорская Федерация',
    short: 'Кардагор',
    army: 'Вооружённые силы Кардагора',
    motto: 'Массированная артиллерия и броня',
    color: '#e5483f',
    fill: '#ff8f85',
    flag: ['#8a1f1f', '#e8e4d8'],
    enemy: [-1, 0],
    night: 0.45,
    doctrine: [
      'Массированная артиллерия 152 мм и миномёты 82 мм, больше боеприпасов',
      'Больше брони и пехоты, танки с динамической защитой',
      'Ночные приборы есть не у всех — ночью видят хуже',
      'Много дешёвых FPV-дронов',
    ],
    camo: { body: '#4b5335', light: '#5a6340', dark: '#353a26', track: '#26281f' },
    units: {
      inf: { name: 'Мотострелковое отделение', short: 'Пехота' },
      eng: { name: 'Сапёрное отделение', short: 'Сапёры' },
      btm: { name: 'Траншейная машина БТМ-4', short: 'БТМ' },
      tank: { name: 'Танк Т-84М', short: 'Т-84М', armor: 1.0, gun: { range: 2400, acc: 0.65 } },
      ifv: { name: 'БМП-4', short: 'БМП-4', armor: 0.4, gun: { range: 1600, acc: 0.5 } },
      apc: { name: 'БТР-90К', short: 'БТР-90К', armor: 0.3, gun: { range: 1200, acc: 0.45 } },
      arty: { name: 'Гаубица «Гиацинт-Б» 152 мм', short: 'Гиацинт', caliber: 152, ammo: 45 },
      mortar: { name: 'Миномётный расчёт 82 мм', short: 'Миномёт', caliber: 82, ammo: 70 },
      truck: { name: 'Грузовик «Урал-К»', short: 'Урал' },
      uav: { name: 'Расчёт БПЛА «Оса»', short: 'БПЛА', drones: { recon: 1, fpv: 7, bomber: 1 } },
      medevac: { name: 'Санитарная машина «МТ-Л»', short: 'Санитарка' },
    },
  },
};

// Оружие бойцов и техники
// range — м; interval — с между очередями; p100 — вероятность попадания очередью на 100 м по стоящему;
// fall — во сколько раз падает на каждые 100 м; dmg — урон попадания; supp — подавление; at — противотанковое
export const WEAPONS = {
  rifle:  { name: 'Автомат', range: 450, interval: 3, p100: 0.16, fall: 0.62, dmg: 45, supp: 1 },
  mg:     { name: 'Пулемёт', range: 800, interval: 2.2, p100: 0.2, fall: 0.72, dmg: 50, supp: 3.5, rounds: 3 },
  gl:     { name: 'Гранатомёт', range: 320, interval: 12, p100: 0.55, fall: 0.6, dmg: 60, supp: 2, at: 0.55, blast: 3 },
  sniper: { name: 'Снайперская винтовка', range: 1000, interval: 9, p100: 0.75, fall: 0.86, dmg: 95, supp: 1.5 },
  // техника
  cannon: { name: 'Танковая пушка', range: 2500, interval: 8, p100: 0.9, fall: 0.94, dmg: 100, supp: 5, at: 0.9, blast: 5 },
  autocannon: { name: 'Автоматическая пушка', range: 1800, interval: 3, p100: 0.55, fall: 0.86, dmg: 80, supp: 5, at: 0.35, blast: 2 },
  hmg:    { name: 'Крупнокалиберный пулемёт', range: 1400, interval: 2.5, p100: 0.35, fall: 0.8, dmg: 70, supp: 4, at: 0.08 },
};

export const ROLE_WEAPON = {
  'Пулемётчик': 'mg', 'Гранатомётчик': 'gl', 'Снайпер': 'sniper',
};
export const VEHICLE_WEAPON = { tank: 'cannon', ifv: 'autocannon', apc: 'hmg' };

export function sideName(side) {
  return FACTIONS[side].short;
}
