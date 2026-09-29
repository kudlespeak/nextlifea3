// ИИ стороны для одиночной игры.
// Уровень командира (раз в 15–40 с): замысел (оборона / наступление), цели, десант на технике,
// артиллерия, дроны. Уровень отделения (каждые 2–8 с): под огнём в поле — в укрытие, эвакуация.
//
// Замысел:
//  • defend — держит свои позиции: пехота в траншеях и зданиях у опорных пунктов, броня в резерве
//    за ними; контратакует только чтобы вернуть свой опорный пункт; дальше своей линии не идёт;
//  • attack — наступает к целям перекатами, пехота подъезжает на БМП/БТР и спешивается перед целью.

const DIFF = {
  easy: { think: 40, aggr: 0.35, artyRounds: 2, react: 8 },
  normal: { think: 25, aggr: 0.6, artyRounds: 3, react: 4 },
  hard: { think: 15, aggr: 0.85, artyRounds: 5, react: 2 },
};

const ARMOR = ['tank', 'ifv', 'apc', 'armcar'];
// Порядок закупки из резерва
const PLAN_ATT = ['inf', 'inf', 'ifv', 'inf', 'tank', 'mortar', 'truck', 'inf', 'apc', 'uav', 'inf', 'arty', 'tank', 'medevac', 'inf', 'ifv', 'atgm', 'inf', 'tank', 'mlrs', 'spg', 'armcar', 'inf', 'fuel', 'sam', 'inf', 'ifv', 'inf'];
const PLAN_DEF = ['inf', 'inf', 'inf', 'mortar', 'atgm', 'truck', 'inf', 'eng', 'uav', 'ifv', 'inf', 'arty', 'medevac', 'tank', 'inf', 'atgm', 'mortar', 'inf', 'spg', 'sam', 'inf', 'fuel', 'mlrs', 'inf', 'inf'];

export class AI {
  constructor(sim, side, mode, difficulty = 'normal') {
    this.sim = sim;
    this.side = side;
    this.enemy = side === 'blue' ? 'red' : 'blue';
    this.mode = mode;
    this.d = DIFF[difficulty] || DIFF.normal;
    this.nextThink = sim.time + 5;
    this.nextReact = 0;
    this.nextArty = sim.time + 60;
    this.nextDrone = sim.time + 30;
    this.dir = side === 'blue' ? 1 : -1; // направление на противника по x
    const gm = sim.game;
    this.posture = gm.mode === 'assault' ? (gm.cfg.attacker === side ? 'attack' : 'defend') : 'attack';
    this.nextBuy = sim.time + 2;
    this.plan = this.posture === 'defend' ? PLAN_DEF : PLAN_ATT;
    this.planIdx = 0;
  }

  own() {
    return this.sim.units.filter((u) => u.side === this.side && !u.dead);
  }

  update() {
    const sim = this.sim;
    if (sim.time >= this.nextBuy) { this.nextBuy = sim.time + (sim.game?.prep ? 3 : 15); this.buy(); if (sim.game?.prep) this.prepare(); }
    if (sim.game?.prep) return;
    if (sim.time >= this.nextReact) { this.nextReact = sim.time + this.d.react; this.react(); }
    if (sim.time >= this.nextThink) { this.nextThink = sim.time + this.d.think; this.think(); }
    if (sim.time >= this.nextArty) { this.nextArty = sim.time + 35; this.artillery(); }
    if (sim.time >= this.nextDrone) { this.nextDrone = sim.time + 45; this.dronesAI(); }
  }

  // Закупка по плану: следующее доступное; если не хватает очков — ждём
  buy() {
    const res = this.sim.game?.reserve?.[this.side];
    if (!res) return;
    this.buildRear(res);
    for (let tries = 0; tries < this.plan.length; tries++) {
      const t = this.plan[this.planIdx % this.plan.length];
      if (!this.sim.unitTypes[t] || (res.avail[t] ?? 0) <= 0) { this.planIdx++; continue; }
      if (res.points < 0 || !res.canOrder(t)) return;
      res.order(t, this.sim.unitTypes[t].move);
      this.planIdx++;
      return;
    }
  }

  // Склад и медпункт — у пункта сбора, чуть в тылу (как поставил бы игрок)
  buildRear(res) {
    const sim = this.sim;
    for (const kind of ['medpoint', 'depot']) {
      if (sim.build.list(this.side, kind).length) continue;
      const sp = res.spawn;
      for (let k = 0; k < 24; k++) {
        const x = sp.x - this.dir * (150 + (k % 4) * 80), y = sp.y + (Math.floor(k / 4) - 2.5) * 110 + (kind === 'depot' ? 60 : -60);
        if (!sim.build.check(this.side, kind, x, y)) { sim.build.place(this.side, kind, x, y); break; }
      }
    }
  }

  // ---------- Подготовка ----------
  // Оборона: занять траншеи у своих опорных пунктов. Наступление: выйти на рубеж атаки.
  prepare() {
    const sim = this.sim, gm = sim.game;
    const own = this.own().filter((u) => !u.aiPlaced && u.state === 'idle' && !u.pending);
    for (const u of own) u.aiPlaced = true;
    const squads = own.filter((u) => u.soldiers && ['inf', 'eng', 'atgm'].includes(u.type) && u.mode === 'field');
    if (this.posture === 'defend') {
      const pts = this.holdPoints();
      squads.forEach((u, i) => {
        const p = pts[i % pts.length];
        if (p) this.occupyNear(u, p.x, p.y, 200);
      });
      // Броня — в резерв за опорными пунктами
      own.filter((u) => ARMOR.includes(u.type)).forEach((u, i) => {
        const p = pts[i % pts.length];
        if (p) sim.orderMove([u], p.x - this.dir * 450, p.y + (i % 3 - 1) * 120);
      });
    } else {
      // Рубеж атаки у линии разграничения: пехота с техникой вместе
      const L = gm.prepLimit(this.side) - this.dir * 150;
      const all = own.filter((u) => (u.soldiers && ['inf', 'atgm'].includes(u.type)) || ARMOR.includes(u.type));
      const ys = all.map((u) => u.y).sort((a, b) => a - b);
      const cy = ys[ys.length >> 1] || sim.world.H / 2;
      all.forEach((u, i) => sim.orderMove([u], L - this.dir * (u.soldiers ? 0 : 120), cy + (sim.rng.next() - 0.5) * 900));
    }
  }

  // Точки обороны: свои опорные пункты или ближние к фронту траншеи
  holdPoints() {
    const sim = this.sim, gm = sim.game;
    // Эшелоны: сектора текущей линии обороны (пока держим её — там; потеряли — следующая)
    if (gm.lines) {
      const line = gm.lines[gm.linesTaken] || gm.lines[gm.lines.length - 1];
      return line.sectors;
    }
    const mine = gm.zones.filter((z) => z.owner === this.side);
    if (mine.length) return mine;
    const fx = sim.world.frontX;
    return sim.world.forts.items.filter((f) => f.kind === 'trench' && f.sub === 'fire' && f.side === this.side && f.line.length > 3)
      .sort((a, b) => Math.abs(a.line[0][0] - fx) - Math.abs(b.line[0][0] - fx)).slice(0, 4)
      .map((f) => { const p = f.line[f.line.length >> 1]; return { x: p[0], y: p[1] }; });
  }

  occupyNear(u, x, y, R) {
    const sim = this.sim;
    sim.trenches.ensure();
    const node = sim.trenches.nearest(x + (sim.rng.next() - 0.5) * 80, y + (sim.rng.next() - 0.5) * 80, R, true);
    if (node >= 0) { const n = sim.trenches.nodes[node]; if (!n.item?.side || n.item.side === this.side) { sim.orderOccupy(u, n.x, n.y); return true; } }
    const b = this.nearestBuilding(x, y, R);
    if (b) { sim.orderGarrison(u, b); return true; }
    sim.orderMove([u], x, y);
    return false;
  }

  // Не дальше своей линии (для обороны): x не за пределами опорных пунктов + 150 м
  beyondLine(x) {
    const pts = this.holdPoints();
    if (!pts.length) return false;
    const edge = this.dir > 0 ? Math.max(...pts.map((p) => p.x)) + 150 : Math.min(...pts.map((p) => p.x)) - 150;
    return this.dir > 0 ? x > edge : x < edge;
  }

  // ---------- Реакция отделений ----------
  react() {
    const sim = this.sim;
    for (const u of this.own()) {
      if (!u.soldiers) {
        // Машина с десантом под огнём — высадить
        if (u.passengers?.length && u.underFire && sim.time - u.underFire < 8) sim.orderUnload(u);
        continue;
      }
      if (u.embarked) continue;
      if (u.soldiers.some((s) => !s.dead && s.wounded === 2 && !s.evacMove && s.treated)) sim.orderEvac(u);
      if (!(u.underFire && sim.time - u.underFire < 10)) continue;
      if (u.mode !== 'field' || u.task || u.state === 'planning') continue;
      sim.trenches.ensure();
      // Укрытие — своя или ничья траншея, не в сторону противника (для обороны)
      const node = sim.trenches.nearest(u.x, u.y, 160, true);
      if (node >= 0) {
        const n = sim.trenches.nodes[node];
        const ok = (!n.item?.side || n.item.side === this.side) && !(this.posture === 'defend' && this.beyondLine(n.x));
        if (ok) { sim.orderOccupy(u, n.x, n.y); continue; }
      }
      const b = this.nearestBuilding(u.x, u.y, 150);
      if (b && !(this.posture === 'defend' && this.beyondLine(b.x))) sim.orderGarrison(u, b);
    }
  }

  nearestBuilding(x, y, R) {
    let best = null, bd = R;
    for (const b of this.sim.world.buildings.query({ x0: x - R, y0: y - R, x1: x + R, y1: y + R })) {
      if (!b.interior || b.collapsed || b.w * b.h < 40) continue;
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  // Цель наступления
  objective(from) {
    const sim = this.sim, gm = sim.game;
    if (gm.mode === 'zones' || gm.mode === 'assault') {
      const z = gm.zones.filter((q) => q.owner !== this.side && !q.locked).sort((a, b) => Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y))[0];
      if (z) return { x: z.x, y: z.y, zone: z };
      return null;
    }
    // Активный фронт: ближайшая известная позиция противника или шаг вперёд
    const seen = [...sim.vision.seen[this.side].values()].sort((a, b) => Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y))[0];
    if (seen) return { x: seen.x, y: seen.y };
    return { x: from.x + this.dir * 600, y: from.y + sim.rng.float(-200, 200) };
  }

  think() {
    if (this.posture === 'defend') this.thinkDefend();
    else this.thinkAttack();
  }

  // Оборона: держать; вернуть потерянный опорный пункт контратакой ближайших сил
  thinkDefend() {
    const sim = this.sim, gm = sim.game;
    const own = this.own();
    const lost = gm.zones.filter((z) => !z.locked && (z.owner !== this.side || z.contested));
    for (const u of own) {
      if (u.embarked || u.task || u.state !== 'idle') continue;
      if (u.soldiers && u.type === 'inf' && u.mode === 'field' && u.strength >= 0.45) {
        const z = lost.sort((a, b) => Math.hypot(a.x - u.x, a.y - u.y) - Math.hypot(b.x - u.x, b.y - u.y))[0];
        if (z && Math.hypot(z.x - u.x, z.y - u.y) < 1200 && sim.rng.chance(this.d.aggr)) { this.occupyNear(u, z.x, z.y, 200); continue; }
        // Иначе — в ближайшую свою траншею у опорного пункта
        const p = this.holdPoints().sort((a, b) => Math.hypot(a.x - u.x, a.y - u.y) - Math.hypot(b.x - u.x, b.y - u.y))[0];
        if (p) this.occupyNear(u, p.x, p.y, 250);
      } else if (ARMOR.includes(u.type)) {
        const z = lost.sort((a, b) => Math.hypot(a.x - u.x, a.y - u.y) - Math.hypot(b.x - u.x, b.y - u.y))[0];
        if (z && Math.hypot(z.x - u.x, z.y - u.y) < 1500 && sim.rng.chance(this.d.aggr * 0.7)) sim.orderMove([u], z.x - this.dir * 250, z.y);
        else if (this.beyondLine(u.x)) {
          const p = this.holdPoints()[0];
          if (p) sim.orderMove([u], p.x - this.dir * 400, u.y);
        }
      }
    }
  }

  thinkAttack() {
    const sim = this.sim;
    const own = this.own();
    const carriers = own.filter((u) => (u.type === 'ifv' || u.type === 'apc') && !u.fire);
    // Машины с десантом: везут к цели и высаживают за 600 м
    for (const v of carriers) {
      if (!v.passengers.length || v.state !== 'idle') continue;
      const obj = this.objective(v);
      if (!obj) { sim.orderUnload(v); continue; }
      const d = Math.hypot(obj.x - v.x, obj.y - v.y);
      if (d < 700) { sim.orderUnload(v); continue; }
      const k = Math.min(1, (d - 600) / d);
      sim.orderMove([v], v.x + (obj.x - v.x) * k, v.y + (obj.y - v.y) * k);
    }
    const attackers = own.filter((u) => (u.soldiers && u.type === 'inf' && !u.embarked) || (ARMOR.includes(u.type) && !u.passengers.length));
    for (const u of attackers) {
      // Залегли в траншее под огнём — через минуту поднимаются и продолжают наступать
      if (u.mode === 'trench' && !u.task && u.state === 'idle') {
        u.aiHold = u.aiHold ?? sim.time;
        const obj0 = this.objective(u);
        const supp = u.soldiers ? u.soldiers.reduce((a, s) => a + (s.dead ? 0 : s.supp), 0) / Math.max(1, u.soldiers.filter((s) => !s.dead).length) : 0;
        if (sim.time - u.aiHold < 60 || supp > 5 || !obj0 || Math.hypot(obj0.x - u.x, obj0.y - u.y) < 220) continue;
      } else u.aiHold = null;
      if (u.task || u.state !== 'idle' || u.pending) continue;
      if (u.soldiers && u.strength < 0.45) continue; // потрёпанные не наступают
      if (!sim.rng.chance(this.d.aggr)) continue;
      const obj = this.objective(u);
      if (!obj) continue;
      const d = Math.hypot(obj.x - u.x, obj.y - u.y);
      // Далеко — сесть на свою пустую БМП/БТР рядом
      if (u.soldiers && d > 1500) {
        const v = carriers.find((q) => !q.passengers.length && q.state === 'idle' && Math.hypot(q.x - u.x, q.y - u.y) < 500 && sim.seatsFree(q) >= u.soldiers.filter((s) => !s.dead).length);
        if (v) { sim.orderBoard(u, v); continue; }
      }
      if (u.soldiers && d < 250) {
        // У цели: занять траншею или здание, либо зачистить
        sim.trenches.ensure();
        const node = sim.trenches.nearest(obj.x, obj.y, 120, true);
        if (node >= 0) {
          const n = sim.trenches.nodes[node];
          if (n.item?.side && n.item.side !== this.side) sim.orderClear(u, n.x, n.y);
          else sim.orderOccupy(u, n.x, n.y);
          continue;
        }
        const b = this.nearestBuilding(obj.x, obj.y, 150);
        if (b) { sim.orderGarrison(u, b); continue; }
      }
      // Шаг к цели: не больше 700 м за раз, пехота — скрытно; броня держится за пехотой
      const k = Math.min(1, 700 / Math.max(1, d));
      const tx = u.x + (obj.x - u.x) * k + sim.rng.float(-60, 60);
      const ty = u.y + (obj.y - u.y) * k + sim.rng.float(-60, 60);
      sim.orderMove([u], tx, ty, { stealth: !!u.soldiers && d < 900 });
      u.aiHold = null;
    }
  }

  // Артиллерия: по видимым скоплениям противника
  artillery() {
    const sim = this.sim;
    const guns = this.own().filter((u) => u.def.caliber && !u.fire && u.ammo > 0 && u.state === 'idle');
    if (!guns.length) return;
    const targets = sim.units.filter((t) => t.side === this.enemy && !t.dead && !t.embarked && sim.vision.now[this.side].has(t.id));
    if (!targets.length) return;
    // Ценность: пехота на открытом месте, техника
    const score = (t) => (t.soldiers ? t.soldiers.filter((s) => !s.dead && !s.under).length * (t.mode === 'field' ? 1.5 : 0.7) : 6);
    targets.sort((a, b) => score(b) - score(a));
    for (const g of guns) {
      const t = targets.find((q) => {
        const d = Math.hypot(q.x - g.x, q.y - g.y);
        return d > 300 && d < 15000;
      });
      if (!t) continue;
      const fuse = t.soldiers && t.mode === 'trench' && sim.rng.chance(0.5) ? 'air' : 'ground';
      sim.art.orderFire([g], t.x, t.y, { rounds: this.d.artyRounds, fuse });
    }
  }

  dronesAI() {
    const sim = this.sim;
    for (const op of this.own().filter((u) => u.type === 'uav')) {
      op.dronesLeft = op.dronesLeft || { ...op.def.drones };
      // Разведчик над целью наступления / над своей линией в обороне
      const hasRecon = sim.drones.list.some((d) => d.op === op && d.kind === 'recon' && !d.dead);
      if (!hasRecon && op.dronesLeft.recon) {
        const obj = this.posture === 'defend' ? { x: sim.world.frontX, y: op.y } : this.objective(op) || { x: sim.world.frontX, y: op.y };
        sim.drones.launch(op, 'recon', obj.x, obj.y);
      }
      // FPV — по обнаруженной технике, иначе по пехоте в поле
      if (op.dronesLeft.fpv && sim.rng.chance(this.d.aggr)) {
        const t = sim.units.filter((q) => q.side === this.enemy && !q.dead && !q.embarked && sim.vision.now[this.side].has(q.id) && Math.hypot(q.x - op.x, q.y - op.y) < 6500)
          .sort((a, b) => (a.soldiers ? 1 : 0) - (b.soldiers ? 1 : 0))[0];
        if (t) sim.drones.launch(op, 'fpv', t.x, t.y, t.id);
      }
    }
  }
}
