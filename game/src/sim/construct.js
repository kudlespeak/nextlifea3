// Строительство тыловых объектов игроком: полевой склад и медпункт.
// Ставятся на своей территории (в тылу), у дороги; строятся некоторое время (на подготовке — быстро).
// Склад работает после постройки: снабжает всех рядом и получает подвоз; медпункт принимает раненых.

export const FACILITIES = {
  depot: { name: 'Полевой склад', cost: 150, time: 90, prepTime: 10, max: 3, roadDist: 220 },
  medpoint: { name: 'Медпункт', cost: 80, time: 60, prepTime: 8, max: 3, roadDist: 400 },
};

let nextFacId = 1;

export class Construction {
  constructor(sim) {
    this.sim = sim;
  }

  // Своя территория: во время подготовки — до линии разграничения; в бою — по полю контроля
  // (или по линии фронта на старте), с запасом в 300 м от передовой
  ownGround(side, x, y) {
    const sim = this.sim, g = sim.game;
    if (x < 50 || y < 50 || x > sim.world.W - 50 || y > sim.world.H - 50) return false;
    const e = side === 'blue' ? 1 : -1;
    if (g?.prep) return (g.prepLimit(side) - x) * e >= 150;
    const grid = g?.grid;
    if (grid) {
      const ix = Math.floor(x / grid.cell), iy = Math.floor(y / grid.cell);
      const c = grid.c[iy * grid.w + ix] ?? 0;
      if (side === 'blue' ? c > -0.5 : c < 0.5) return false;
      // и не у самой передовой: клетка на 300 м ближе к противнику тоже своя
      const jx = Math.floor((x + e * 300) / grid.cell);
      const c2 = grid.c[iy * grid.w + Math.max(0, Math.min(grid.w - 1, jx))] ?? 0;
      return side === 'blue' ? c2 < -0.3 : c2 > 0.3;
    }
    return (sim.world.frontX - x) * e >= 600;
  }

  // Проверка места: вернёт текст ошибки или null
  check(side, kind, x, y) {
    const sim = this.sim;
    const F = FACILITIES[kind];
    if (!F) return 'Неизвестный объект';
    const res = sim.game?.reserve?.[side];
    if (res && res.points < F.cost) return `Не хватает очков: нужно ${F.cost}`;
    if (this.list(side, kind).length >= F.max) return `Не больше ${F.max} объектов этого типа`;
    if (!this.ownGround(side, x, y)) return 'Только на своей территории, в тылу (не ближе 300 м к передовой)';
    if (!(sim.nav.speedAt(x, y, 'wheeled') > 0) || sim.solidAt(x, y)) return 'Здесь нельзя: вода, здание или непроезжая местность';
    const near = sim.roads.near(x, y, F.roadDist);
    if (!near.length) return `Нужна дорога рядом (до ${F.roadDist} м) — чтобы подъезжали машины`;
    for (const f of this.all()) if (Math.hypot(f.x - x, f.y - y) < 80) return 'Слишком близко к другому объекту';
    return null;
  }

  all() {
    return [...this.sim.log.depots, ...this.sim.medpoints.blue, ...this.sim.medpoints.red];
  }

  list(side, kind) {
    return kind === 'depot' ? this.sim.log.depots.filter((d) => d.side === side && d.alive) : this.sim.medpoints[side].filter((m) => m.alive);
  }

  // Поставить объект (стройплощадка). Возвращает текст ошибки или null
  place(side, kind, x, y, free = false) {
    const sim = this.sim;
    const err = free ? null : this.check(side, kind, x, y);
    if (err) return err;
    const F = FACILITIES[kind];
    if (!free) sim.game.reserve[side].points -= F.cost;
    // Развернуть вдоль ближайшей дороги
    const n = sim.roads.near(x, y, 400).sort((a, b) => sim.roads.dist(a, x, y) - sim.roads.dist(b, x, y))[0];
    const angle = n !== undefined ? Math.atan2(sim.roads.y[n] - y, sim.roads.x[n] - x) : 0;
    const build = { time: sim.game?.prep ? F.prepTime : F.time, left: sim.game?.prep ? F.prepTime : F.time };
    const count = this.list(side, kind).length + 1;
    if (kind === 'depot') {
      const d = sim.log.addDepot(side, x, y, `Склад №${count}`);
      d.id = nextFacId++; d.angle = angle; d.build = build; d.built = 0;
      d.stock = { ammo: 150, shells: 200, fuel: 90 }; // стартовый завоз, дальше — подвоз из тыла
    } else {
      sim.medpoints[side].push({ id: nextFacId++, kind: 'medpoint', side, x, y, angle, alive: true, built: 0, build, name: `Медпункт №${count}` });
    }
    sim.msg(`${F.name}: стройка начата${build.time > 20 ? ` — будет готов через ${Math.round(build.time)} с` : ''}`, side);
    return null;
  }

  update(dt) {
    const sim = this.sim;
    for (const f of this.all()) {
      if (!f.build || f.built >= 1 || !f.alive) continue;
      f.build.left -= dt;
      f.built = Math.min(1, 1 - f.build.left / f.build.time);
      if (f.built >= 1) sim.msg(`${f.name}: построен и работает`, f.side);
    }
  }
}
