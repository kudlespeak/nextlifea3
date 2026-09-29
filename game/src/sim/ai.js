// ИИ стороны для одиночной игры.
// Уровень командира (раз в 15–40 с): цели наступления, артиллерия, дроны, эвакуация.
// Уровень отделения (каждые 3 с): под огнём в поле — в укрытие.

const DIFF = {
  easy: { think: 40, aggr: 0.35, artyRounds: 2, react: 8 },
  normal: { think: 25, aggr: 0.6, artyRounds: 3, react: 4 },
  hard: { think: 15, aggr: 0.85, artyRounds: 5, react: 2 },
};

export class AI {
  constructor(sim, side, mode, difficulty = 'normal') {
    this.sim = sim;
    this.side = side;
    this.enemy = side === 'blue' ? 'red' : 'blue';
    this.mode = mode;
    this.d = DIFF[difficulty] || DIFF.normal;
    this.nextThink = sim.time + 20;
    this.nextReact = 0;
    this.nextArty = sim.time + 60;
    this.nextDrone = sim.time + 30;
  }

  own() {
    return this.sim.units.filter((u) => u.side === this.side && !u.dead);
  }

  update() {
    const sim = this.sim;
    if (sim.time >= this.nextReact) { this.nextReact = sim.time + this.d.react; this.react(); }
    if (sim.time >= this.nextThink) { this.nextThink = sim.time + this.d.think; this.think(); }
    if (sim.time >= this.nextArty) { this.nextArty = sim.time + 35; this.artillery(); }
    if (sim.time >= this.nextDrone) { this.nextDrone = sim.time + 45; this.dronesAI(); }
  }

  // Реакция отделений: под огнём на открытом месте — в ближайшее укрытие; эвакуация раненых
  react() {
    const sim = this.sim;
    for (const u of this.own()) {
      if (!u.soldiers) continue;
      if (u.soldiers.some((s) => !s.dead && s.wounded === 2 && !s.evacMove && s.treated)) sim.orderEvac(u);
      if (!(u.underFire && sim.time - u.underFire < 10)) continue;
      if (u.mode !== 'field' || u.task || u.state === 'planning') continue;
      sim.trenches.ensure();
      const node = sim.trenches.nearest(u.x, u.y, 160, true);
      if (node >= 0) { sim.orderOccupy(u, sim.trenches.nodes[node].x, sim.trenches.nodes[node].y); continue; }
      const b = this.nearestBuilding(u.x, u.y, 150);
      if (b) sim.orderGarrison(u, b);
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
    if (gm.mode === 'zones' || (gm.mode === 'assault' && gm.cfg.attacker === this.side)) {
      const z = gm.zones.filter((q) => q.owner !== this.side).sort((a, b) => Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y))[0];
      if (z) return { x: z.x, y: z.y, zone: z };
    }
    if (gm.mode === 'assault') return null; // оборона: держать позиции
    // Активный фронт: ближайшая известная позиция противника или шаг вперёд
    const seen = [...sim.vision.seen[this.side].values()].sort((a, b) => Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y))[0];
    if (seen) return { x: seen.x, y: seen.y };
    const dir = this.side === 'blue' ? 1 : -1;
    return { x: from.x + dir * 600, y: from.y + sim.rng.float(-200, 200) };
  }

  think() {
    const sim = this.sim;
    const own = this.own();
    const attackers = own.filter((u) => (u.soldiers && u.type === 'inf' && !u.duty) || ['tank', 'ifv', 'apc'].includes(u.type));
    for (const u of attackers) {
      if (u.task || u.state !== 'idle' || u.mode !== 'field') continue;
      if (u.soldiers && u.strength < 0.45) continue; // потрёпанные не наступают
      if (!sim.rng.chance(this.d.aggr)) continue;
      const obj = this.objective(u);
      if (!obj) continue;
      const d = Math.hypot(obj.x - u.x, obj.y - u.y);
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
      // Шаг к цели: не больше 700 м за раз, пехота — скрытно
      const k = Math.min(1, 700 / Math.max(1, d));
      const tx = u.x + (obj.x - u.x) * k + sim.rng.float(-60, 60);
      const ty = u.y + (obj.y - u.y) * k + sim.rng.float(-60, 60);
      sim.orderMove([u], tx, ty, { stealth: !!u.soldiers });
    }
  }

  // Артиллерия: по видимым скоплениям противника
  artillery() {
    const sim = this.sim;
    const guns = this.own().filter((u) => u.def.caliber && !u.fire && u.ammo > 0 && u.state === 'idle');
    if (!guns.length) return;
    const targets = sim.units.filter((t) => t.side === this.enemy && !t.dead && sim.vision.now[this.side].has(t.id));
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
      // Разведчик над целью наступления / фронтом
      const hasRecon = sim.drones.list.some((d) => d.op === op && d.kind === 'recon' && !d.dead);
      if (!hasRecon && op.dronesLeft.recon) {
        const obj = this.objective(op) || { x: sim.world.frontX, y: op.y };
        sim.drones.launch(op, 'recon', obj.x, obj.y);
      }
      // FPV — по обнаруженной технике, иначе по пехоте в поле
      if (op.dronesLeft.fpv && sim.rng.chance(this.d.aggr)) {
        const t = sim.units.filter((q) => q.side === this.enemy && !q.dead && sim.vision.now[this.side].has(q.id) && Math.hypot(q.x - op.x, q.y - op.y) < 6500)
          .sort((a, b) => (a.soldiers ? 1 : 0) - (b.soldiers ? 1 : 0))[0];
        if (t) sim.drones.launch(op, 'fpv', t.x, t.y, t.id);
      }
    }
  }
}
