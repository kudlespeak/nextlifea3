// Логистика: склады, запасы, расход и подвоз.
// Три вида ресурсов (в «единицах снабжения»):
//   ammo   — стрелковые боеприпасы и выстрелы к пушкам (1 ед. = носимый боекомплект одного бойца);
//   shells — артиллерийские выстрелы и мины (1 ед. = 1 выстрел);
//   fuel   — топливо (1 ед. ≈ 250 л).
// Склад пополняется подвозом из тыла (за краем карты) и отдаёт запасы грузовикам и подразделениям рядом.
// Грузовик в режиме автоснабжения сам выбирает, кого снабжать, и возвращается на склад за грузом.
// Модуль без DOM и без привязки к карте — под будущий режим с заводами и сетью складов.

export const RES = ['ammo', 'shells', 'fuel'];
export const RES_NAMES = { ammo: 'патроны', shells: 'снаряды', fuel: 'топливо' };

// Расход стрелкового боекомплекта за одну очередь / выстрел (доля от полного)
export const AMMO_USE = { atgm: 1 / 4, rifle: 1 / 80, mg: 1 / 60, gl: 1 / 10, sniper: 1 / 40, cannon: 1 / 40, autocannon: 1 / 60, hmg: 1 / 70 };
// Сколько ед. боеприпасов в полном боекомплекте машины; ёмкость бака (ед. топлива) и запас хода, км
const VEH = {
  tank: { ammo: 4, fuel: 5, range: 30 }, ifv: { ammo: 3, fuel: 3, range: 40 }, apc: { ammo: 2, fuel: 3, range: 55 },
  btm: { ammo: 0, fuel: 4, range: 30 }, truck: { ammo: 0, fuel: 2, range: 90 }, medevac: { ammo: 0, fuel: 2, range: 90 },
  arty: { ammo: 0, fuel: 2, range: 80 }, spg: { ammo: 0, fuel: 4, range: 35 }, mlrs: { ammo: 0, fuel: 2, range: 80 },
  fuel: { ammo: 0, fuel: 2, range: 90 }, armcar: { ammo: 2, fuel: 2, range: 70 }, sam: { ammo: 0, fuel: 2, range: 70 },
};
const TRUCK_CAP = { ammo: 50, shells: 70, fuel: 30 };
const DEPOT_START = { ammo: 500, shells: 700, fuel: 300 };
const DEPOT_FLOW = { ammo: 20, shells: 25, fuel: 10 }; // подвоз из тыла, ед. в 10 мин
const RANGE_SUPPLY = 55; // м — грузовик снабжает вокруг себя
const RANGE_DEPOT = 110; // м — склад снабжает вокруг себя

export class Logistics {
  constructor(sim) {
    this.sim = sim;
    this.depots = [];
    this.nextTick = 0;
    this.nextFlow = 0;
  }

  addDepot(side, x, y, name = 'Склад') {
    const d = { id: this.depots.length + 1, side, x, y, name, stock: { ...DEPOT_START }, cap: { ammo: 1200, shells: 1600, fuel: 700 }, alive: true };
    this.depots.push(d);
    return d;
  }

  // Начальные запасы подразделения
  init(u) {
    if (u.soldiers) for (const s of u.soldiers) s.mag = 1;
    const v = VEH[u.type];
    if (v) { u.fuel = 1; if (v.ammo) u.rounds = 1; }
    if (u.type === 'truck') { u.cargoRes = { ...TRUCK_CAP }; u.autoSupply = true; u.cap = TRUCK_CAP; }
    if (u.type === 'fuel') { u.cargoRes = { ammo: 0, shells: 0, fuel: 90 }; u.autoSupply = true; u.cap = { ammo: 0, shells: 0, fuel: 90 }; }
    if (u.type === 'ifv') u.atgmLeft = 2; // ПТУР на башне
    if (u.soldiers) for (const s of u.soldiers) s.grenades = 2;
  }

  // Расход топлива на пройденный путь
  burn(u, meters) {
    const v = VEH[u.type];
    if (!v || u.fuel === undefined) return;
    const before = u.fuel;
    u.fuel = Math.max(0, u.fuel - meters / (v.range * 1000));
    if (before > 0.15 && u.fuel <= 0.15) this.sim.msg(`${u.label}: топливо на исходе`, u.side);
    if (before > 0 && u.fuel <= 0) this.sim.msg(`${u.label}: кончилось топливо — машина встала`, u.side);
  }

  // Потребность подразделения по видам ресурсов (ед.)
  need(u) {
    const n = { ammo: 0, shells: 0, fuel: 0 };
    if (u.dead || u.embarked) return n;
    if (u.soldiers) for (const s of u.soldiers) if (!s.dead && !s.evac) n.ammo += 1 - (s.mag ?? 1);
    const v = VEH[u.type];
    if (v) {
      if (v.ammo && u.rounds !== undefined) n.ammo += (1 - u.rounds) * v.ammo;
      if (u.fuel !== undefined) n.fuel += (1 - u.fuel) * v.fuel;
    }
    if (u.def.caliber) n.shells += Math.max(0, u.def.ammo - u.ammo);
    return n;
  }

  // Самое низкое обеспечение (0..1) — для индикаторов и выбора, кого снабжать
  level(u) {
    let lv = 1;
    if (u.soldiers) {
      const al = u.soldiers.filter((s) => !s.dead && !s.evac);
      if (al.length) lv = Math.min(lv, al.reduce((a, s) => a + (s.mag ?? 1), 0) / al.length);
    }
    if (u.rounds !== undefined) lv = Math.min(lv, u.rounds);
    if (u.fuel !== undefined) lv = Math.min(lv, u.fuel);
    if (u.def.caliber) lv = Math.min(lv, u.ammo / u.def.ammo);
    return lv;
  }

  // Выдать из источника src (запасы {ammo,shells,fuel}) подразделению u не больше budget ед. каждого вида
  give(src, u, budget) {
    const n = this.need(u);
    let moved = 0;
    const take = (res, want) => {
      const q = Math.min(want, src[res], budget);
      src[res] -= q;
      moved += q;
      return q;
    };
    if (n.ammo > 0.01 && src.ammo > 0) {
      let q = take('ammo', n.ammo);
      // Сначала бойцы с пустыми магазинами
      if (u.soldiers) for (const s of [...u.soldiers].sort((a, b) => (a.mag ?? 1) - (b.mag ?? 1))) {
        if (s.dead || s.evac || q <= 0) continue;
        const d = Math.min(1 - (s.mag ?? 1), q);
        s.mag = (s.mag ?? 1) + d; q -= d;
        if (s.mag > 0.9) s.grenades = 2;
      }
      const v = VEH[u.type];
      if (q > 0 && v?.ammo && u.rounds !== undefined) { const d = Math.min((1 - u.rounds) * v.ammo, q); u.rounds += d / v.ammo; q -= d; }
      src.ammo += q; moved -= q; // остаток вернуть
    }
    if (n.shells > 0.5 && src.shells > 0) { const q = Math.floor(take('shells', n.shells)); u.ammo += q; }
    if (n.fuel > 0.01 && src.fuel > 0) { const v = VEH[u.type]; const q = take('fuel', n.fuel); u.fuel = Math.min(1, u.fuel + q / v.fuel); }
    return moved;
  }

  update(dt) {
    const sim = this.sim;
    if (sim.time < this.nextTick) return;
    const step = 2;
    this.nextTick = sim.time + step;
    // Подвоз из тыла
    if (sim.time >= this.nextFlow) {
      this.nextFlow = sim.time + 600;
      for (const d of this.depots) if (d.alive && (d.built ?? 1) >= 1) for (const r of RES) d.stock[r] = Math.min(d.cap[r], d.stock[r] + DEPOT_FLOW[r]);
    }
    for (const u of sim.units) {
      if (u.dead || u.embarked) continue;
      // Склад снабжает всех рядом (и грузит грузовики)
      for (const d of this.depots) {
        if (!d.alive || (d.built ?? 1) < 1 || d.side !== u.side || Math.hypot(u.x - d.x, u.y - d.y) > RANGE_DEPOT) continue;
        if (u.cargoRes) {
          for (const r of RES) { const q = Math.min(u.cap[r] - u.cargoRes[r], d.stock[r], 12 * step); u.cargoRes[r] += q; d.stock[r] -= q; }
        }
        this.give(d.stock, u, 3 * step);
      }
    }
    // Грузовики снабжают стоящих рядом
    for (const t of sim.units) {
      if (t.dead || !t.cargoRes || t.state === 'moving') continue;
      for (const u of sim.units) {
        if (u === t || u.side !== t.side || u.dead || u.embarked || u.cargoRes) continue;
        if (Math.hypot(u.x - t.x, u.y - t.y) > RANGE_SUPPLY) continue;
        const moved = this.give(t.cargoRes, u, 2 * step);
        if (moved > 0) t.supplying = sim.time;
      }
      if (t.autoSupply && !sim.game?.prep && !(t.autoPause > sim.time)) this.autoTruck(t);
    }
  }

  // Автоснабжение: пустой — на склад; иначе к самому нуждающемуся (не на передовую под огонь)
  autoTruck(t) {
    const sim = this.sim;
    if (t.pending || sim.queue.some((q) => q.unit === t)) return;
    if (t.supplying && sim.time - t.supplying < 6) return; // ещё разгружается
    const rs = RES.filter((r) => t.cap[r] > 0);
    const load = rs.reduce((a, r) => a + t.cargoRes[r] / t.cap[r], 0) / rs.length;
    const depot = this.nearestDepot(t);
    if (load < 0.2 && depot) {
      if (Math.hypot(t.x - depot.x, t.y - depot.y) > RANGE_DEPOT * 0.6) this.goTo(t, depot.x, depot.y, 'на склад за грузом');
      return;
    }
    let best = null, bs = 0;
    for (const u of sim.units) {
      if (u.side !== t.side || u.dead || u.embarked || u.cargoRes || u === t) continue;
      const n = this.need(u);
      const useful = Math.min(n.ammo, t.cargoRes.ammo) + Math.min(n.shells, t.cargoRes.shells) * 0.15 + Math.min(n.fuel, t.cargoRes.fuel) * 1.5;
      if (useful < 0.8) continue;
      // Не лезть под огонь: подразделения в бою и у линии соприкосновения ждут, пока отойдут
      if (u.underFire && sim.time - u.underFire < 60) continue;
      const d = Math.hypot(u.x - t.x, u.y - t.y);
      const score = useful / (1 + d / 800);
      if (score > bs) { bs = score; best = u; }
    }
    if (best) {
      if (Math.hypot(best.x - t.x, best.y - t.y) > RANGE_SUPPLY * 0.7) {
        const a = Math.atan2(t.y - best.y, t.x - best.x);
        this.goTo(t, best.x + Math.cos(a) * 25, best.y + Math.sin(a) * 25, `везёт снабжение: ${best.label}`);
      }
    } else if (depot && load < 0.95 && Math.hypot(t.x - depot.x, t.y - depot.y) > RANGE_DEPOT * 0.6) this.goTo(t, depot.x, depot.y, 'пополняет груз на складе');
  }

  goTo(t, x, y, why) {
    t.supplyTask = why;
    this.sim.orderMove([t], x, y);
    t.autoSupply = true; // orderMove сбрасывает задачи, но не режим
  }

  nearestDepot(u) {
    let best = null, bd = Infinity;
    for (const d of this.depots) {
      if (!d.alive || (d.built ?? 1) < 1 || d.side !== u.side) continue;
      const dd = Math.hypot(d.x - u.x, d.y - u.y);
      if (dd < bd) { bd = dd; best = d; }
    }
    return best;
  }

  // Разрыв рядом со складом: часть запасов уничтожена, при сильном ударе — пожар и детонация
  hitDepot(x, y, blast) {
    const msgs = [];
    for (const d of this.depots) {
      if (!d.alive) continue;
      const dist = Math.hypot(d.x - x, d.y - y);
      if (dist > 30 + blast * 2) continue;
      const k = Math.min(0.5, (blast / 7) * 0.25 * (1 - dist / (30 + blast * 2)) + 0.03);
      for (const r of RES) d.stock[r] = Math.floor(d.stock[r] * (1 - k));
      d.hits = (d.hits || 0) + 1;
      msgs.push(`${d.name} (${d.side === 'blue' ? 'Велнария' : 'Кардагор'}): попадание, уничтожено ~${Math.round(k * 100)}% запасов`);
      if (d.hits >= 12 || (d.stock.ammo + d.stock.shells + d.stock.fuel) < 20) { d.alive = false; msgs.push(`${d.name}: склад уничтожен`); (this.sim.fires || []).push({ x: d.x, y: d.y, r: 40, until: this.sim.time + 1800 }); }
    }
    return msgs;
  }
}
