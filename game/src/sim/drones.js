// Дроны: разведчик (зависает и смотрит сверху, ночью — тепловизор),
// FPV-камикадзе (догоняет цель и подрывается), сбросчик (сбрасывает гранаты ВОГ).
// Управляются расчётом БПЛА; дальность связи 7 км, батарея ограничена.
// По дронам стреляет пехота — шанс сбить небольшой, у быстрых FPV — ещё меньше.

const KINDS = {
  recon: { name: 'разведчик', speed: 14, battery: 1800, loiter: 70 },
  fpv: { name: 'FPV', speed: 26, battery: 600 },
  bomber: { name: 'сбросчик', speed: 12, battery: 1500, drops: 3 },
};
export const DRONE_KINDS = KINDS;
const LINK_RANGE = 7000;

let nextDroneId = 1;

export class Drones {
  constructor(sim) {
    this.sim = sim;
    this.list = [];
  }

  // Запуск: kind, точка или цель-подразделение
  launch(op, kind, x, y, targetId = null) {
    const sim = this.sim;
    if (!op || op.dead || op.type !== 'uav') return 'Нужен расчёт БПЛА';
    op.dronesLeft = op.dronesLeft || { ...op.def.drones };
    if (sim.game?.prep) {
      if (kind !== 'recon') return 'Идёт подготовка — удары после начала боя';
      x = sim.game.clampPrep(op.side, x);
    }
    if (!op.dronesLeft[kind]) return `${op.label}: нет дронов типа «${KINDS[kind].name}»`;
    if (Math.hypot(x - op.x, y - op.y) > LINK_RANGE) return `${op.label}: цель дальше дальности связи (7 км)`;
    // Разведчик у этого расчёта уже в воздухе — перенаправляем
    if (kind === 'recon') {
      const cur = this.list.find((d) => d.op === op && d.kind === 'recon' && !d.dead);
      if (cur) { cur.tx = x; cur.ty = y; cur.state = 'fly'; return `${op.label}: разведчик перенаправлен`; }
    }
    op.dronesLeft[kind]--;
    const d = {
      id: nextDroneId++, side: op.side, kind, op, x: op.x, y: op.y, tx: x, ty: y, targetId,
      state: 'fly', battery: KINDS[kind].battery, drops: KINDS[kind].drops || 0, nextDrop: 0, heading: 0, dead: false, ang: 0,
    };
    this.list.push(d);
    return `${op.label}: запущен ${KINDS[kind].name}${kind === 'fpv' && targetId ? ' по цели' : ''}`;
  }

  recall(op) {
    for (const d of this.list) if (d.op === op && !d.dead && d.kind !== 'fpv') d.state = 'return';
  }

  update(dt) {
    const sim = this.sim;
    for (const d of this.list) {
      if (d.dead) continue;
      const k = KINDS[d.kind];
      d.battery -= dt;
      if (d.op.dead || Math.hypot(d.x - d.op.x, d.y - d.op.y) > LINK_RANGE) { this.lose(d, 'потеря связи'); continue; }
      if (d.battery <= 0) { this.lose(d, 'разрядилась батарея'); continue; }
      if (d.battery < 120 && d.kind !== 'fpv' && d.state !== 'return') d.state = 'return';
      // Цель-подразделение: пока видна — следуем за ней
      if (d.targetId) {
        const t = sim.units.find((u) => u.id === d.targetId);
        if (t && !t.dead && sim.vision.now[d.side].has(t.id)) { d.tx = t.x; d.ty = t.y; }
      }
      let gx = d.tx, gy = d.ty;
      if (d.state === 'return') { gx = d.op.x; gy = d.op.y; }
      else if (d.state === 'loiter') {
        d.ang += dt * (k.speed / k.loiter) * 0.6;
        gx = d.tx + Math.cos(d.ang) * k.loiter;
        gy = d.ty + Math.sin(d.ang) * k.loiter;
      }
      const dx = gx - d.x, dy = gy - d.y;
      const dist = Math.hypot(dx, dy);
      const step = Math.min(dist, k.speed * dt);
      if (dist > 0.01) {
        d.x += (dx / dist) * step;
        d.y += (dy / dist) * step;
        d.heading = Math.atan2(dy, dx);
      }
      if (d.state === 'return' && dist < 8) {
        d.dead = true; d.landed = true;
        d.op.dronesLeft[d.kind]++;
        continue;
      }
      if (d.kind === 'recon' && d.state === 'fly' && dist < k.loiter) d.state = 'loiter';
      if (d.kind === 'fpv' && dist < 3) { this.fpvHit(d); continue; }
      if (d.kind === 'bomber' && d.state === 'fly' && dist < 4) d.state = 'hover';
      if (d.kind === 'bomber' && d.state === 'hover' && sim.time >= d.nextDrop) {
        sim.art.explode(d.tx + sim.rng.float(-2.5, 2.5), d.ty + sim.rng.float(-2.5, 2.5), 'vog', 'ground', d.side, false);
        d.drops--;
        d.nextDrop = sim.time + 15;
        if (d.drops <= 0) d.state = 'return';
      }
    }
    this.antiAir(dt);
    this.list = this.list.filter((d) => !d.dead || sim.time - (d.deadAt || sim.time) < 1);
  }

  fpvHit(d) {
    const sim = this.sim;
    d.dead = true;
    d.deadAt = sim.time;
    // Попали по технике?
    const veh = sim.units.find((u) => !u.dead && !u.soldiers && u.side !== d.side && Math.hypot(u.x - d.x, u.y - d.y) < 6);
    if (veh) {
      sim.combat.hitVehicle(veh, 0.75, d.op);
      sim.art.effects.push({ type: 'blast', x: d.x, y: d.y, caliber: 30, air: false, h: 0, t: performance.now(), rays: [] });
      sim.msg(`FPV-дрон поразил ${veh.def.short}${veh.dead ? ' — уничтожен' : ''}`, null);
    } else sim.art.explode(d.x, d.y, 'fpv', 'ground', d.side, false);
  }

  lose(d, why) {
    d.dead = true;
    d.deadAt = this.sim.time;
    this.sim.msg(`${d.op.label}: ${KINDS[d.kind].name} потерян — ${why}`, d.side);
  }

  // Пехота стреляет по дронам в пределах 120 м
  antiAir(dt) {
    const sim = this.sim;
    for (const d of this.list) {
      if (d.dead || d.state === 'return' && Math.hypot(d.x - d.op.x, d.y - d.op.y) < 50) continue;
      for (const u of sim.units) {
        if (u.dead || u.embarked || u.side === d.side || !u.soldiers || u.roe === 'hold') continue;
        if (Math.hypot(u.x - d.x, u.y - d.y) > 120) continue;
        const shooters = u.soldiers.filter((s) => !s.dead && !s.under && s.wounded < 2).length;
        const p = (d.kind === 'fpv' ? 0.004 : 0.012) * shooters * dt;
        if (sim.rng.chance(p)) {
          d.dead = true;
          d.deadAt = sim.time;
          sim.msg(`${u.label}: сбит дрон противника (${KINDS[d.kind].name})`, u.side);
          break;
        }
      }
    }
  }
}
