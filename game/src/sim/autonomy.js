// Автономные действия подразделений (включено по умолчанию, выключается для каждого — u.auto = false).
// Игрок задаёт замысел, а мелочи бойцы и экипажи делают сами:
//  • пехота под огнём в поле — в ближайшее укрытие (своя траншея, здание);
//  • в траншее — смещается по ходам к участку, откуда идёт угроза;
//  • перевязанных тяжелораненых — эвакуирует;
//  • санитарные машины сами ездят за ранеными и отвозят их в медпункт;
//  • подбитая техника ставит дымовую завесу и отходит в тыл.
// Эти же правила работают и для ИИ — это «низший уровень» управления.

const SMOKE_LIFE = 70;

export class Autonomy {
  constructor(sim) {
    this.sim = sim;
    this.next = 0;
    this.smokes = sim.smokes = []; // { x, y, r, t0, until }
  }

  update() {
    const sim = this.sim;
    // Дым рассеивается
    for (let i = this.smokes.length - 1; i >= 0; i--) if (sim.time > this.smokes[i].until) this.smokes.splice(i, 1);
    if (sim.time < this.next) return;
    this.next = sim.time + 2;
    if (sim.puppet) return;
    for (const u of sim.units) {
      if (u.dead || u.embarked || u.auto === false || u.autoPause > sim.time) continue;
      if (u.soldiers) this.infantry(u);
      else if (u.type === 'medevac') this.medevac(u);
      else if (['tank', 'ifv', 'apc', 'armcar', 'spg', 'btm'].includes(u.type)) this.vehicle(u);
    }
  }

  underFire(u, sec = 10) {
    return u.underFire && this.sim.time - u.underFire < sec;
  }

  infantry(u) {
    const sim = this.sim;
    // Перевязанных тяжелораненых — эвакуировать
    // (если к отделению уже едет санитарка — ждём её, а не несём раненых навстречу)
    const medComing = sim.units.some((v) => v.type === 'medevac' && !v.dead && v.medTarget === u && v.state === 'moving');
    if (!medComing && u.soldiers.some((s) => !s.dead && s.wounded === 2 && !s.evacMove && s.treated) && sim.time - (u.lastEvac || -1e9) > 30 && sim.evacDest(u)) {
      u.lastEvac = sim.time;
      sim.orderEvac(u);
    }
    if (sim.game?.prep) return;
    // В здании, по которому бьют (рушится, горит, потери) — уходить в другое укрытие
    const bld = u.soldiers.find((s) => !s.dead && s.building)?.building;
    if (bld && u.mode === 'trench' && !u.task) {
      const prev = u.bldDamage ?? bld.damage ?? 0;
      const hit = (bld.damage || 0) - prev;
      u.bldDamage = bld.damage || 0;
      const casualties = u.soldiers.filter((s) => s.dead || s.wounded === 2).length;
      const underground = u.soldiers.every((s) => s.dead || s.under);
      if (!underground && (bld.collapsed || bld.ruined || hit > 0.25 || (casualties >= 2 && this.underFire(u, 20))) && sim.time - (u.lastFlee || -1e9) > 45) {
        u.lastFlee = sim.time;
        const alt = this.nearestBuilding(u.x, u.y, 180, bld);
        const node = (sim.trenches.ensure(), sim.trenches.nearest(u.x, u.y, 180, true));
        if (alt) { sim.orderGarrison(u, alt); sim.msg(`${u.label}: здание под обстрелом — переходят в соседнее`, u.side); return; }
        if (node >= 0) { const n = sim.trenches.nodes[node]; sim.orderOccupy(u, n.x, n.y); sim.msg(`${u.label}: здание под обстрелом — уходят в траншею`, u.side); return; }
        if (bld.interior?.basement && !bld.collapsed) { sim.orderBasement(u, bld); sim.msg(`${u.label}: здание под обстрелом — спускаются в подвал`, u.side); return; }
        const dir = u.side === 'blue' ? -1 : 1;
        sim.orderMove([u], u.x + dir * 150, u.y);
        sim.msg(`${u.label}: здание под обстрелом — отходят`, u.side);
        return;
      }
    }
    // Под огнём в чистом поле, без задачи — в укрытие
    if (u.mode === 'field' && !u.task && !u.pending && u.state === 'idle' && this.underFire(u)) {
      sim.trenches.ensure();
      const node = sim.trenches.nearest(u.x, u.y, 150, true);
      if (node >= 0) {
        const n = sim.trenches.nodes[node];
        if (!n.item?.side || n.item.side === u.side) { sim.orderOccupy(u, n.x, n.y); sim.msg(`${u.label}: под огнём — занимает траншею`, u.side); return; }
      }
      const b = this.nearestBuilding(u.x, u.y, 130);
      if (b) { sim.orderGarrison(u, b); sim.msg(`${u.label}: под огнём — укрывается в здании`, u.side); }
      return;
    }
    // В траншее: сместиться к угрожаемому участку (не чаще раза в 40 с)
    if (u.mode === 'trench' && !u.task && u.state === 'idle' && sim.time - (u.lastShift || -1e9) > 40) {
      const threat = this.threat(u, 700);
      if (!threat) return;
      const g = sim.trenches;
      g.ensure();
      // Узел траншеи в пределах 70 м от отделения, ближайший к угрозе
      let best = -1, bd = Infinity;
      for (const id of g.near(u.x, u.y, 70)) {
        const nd = g.nodes[id];
        if (nd.under) continue;
        const d = Math.hypot(nd.x - threat.x, nd.y - threat.y);
        if (d < bd) { bd = d; best = id; }
      }
      if (best < 0) return;
      const nd = g.nodes[best];
      const cur = Math.hypot(u.x - threat.x, u.y - threat.y);
      if (cur - bd < 25) return; // и так ближе некуда
      u.lastShift = sim.time;
      sim.doOccupy(u, best);
      sim.msg(`${u.label}: смещается по траншее к угрожаемому участку`, u.side);
    }
  }

  // Ближайший видимый противник
  threat(u, R) {
    const sim = this.sim;
    let best = null, bd = R;
    for (const t of sim.units) {
      if (t.side === u.side || t.dead || t.embarked || !sim.vision.now[u.side].has(t.id)) continue;
      const d = Math.hypot(t.x - u.x, t.y - u.y);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  nearestBuilding(x, y, R, except = null) {
    let best = null, bd = R;
    for (const b of this.sim.world.buildings.query({ x0: x - R, y0: y - R, x1: x + R, y1: y + R })) {
      if (!b.interior || b.collapsed || b.ruined || b === except || b.w * b.h < 40) continue;
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  // Санитарка: к отделению с перевязанными ранеными, затем — в медпункт
  medevac(v) {
    const sim = this.sim;
    if (v.state !== 'idle' || sim.queue.some((q) => q.unit === v)) return;
    const med = sim.nearestMed(v.side, v.x, v.y);
    const waiting = sim.units.filter((u) => u.side === v.side && u.soldiers && !u.dead && !u.embarked &&
      u.soldiers.some((s) => !s.dead && s.wounded === 2 && !s.evac));
    if (v.cargo >= 4 || (v.cargo > 0 && !waiting.length)) {
      if (med && Math.hypot(v.x - med.x, v.y - med.y) > 60) { v.medTask = `везёт раненых: ${med.name}`; sim.orderMove([v], med.x, med.y); }
      return;
    }
    // Ближайшее отделение с ранеными, не под плотным огнём
    let best = null, bd = 3500;
    for (const u of waiting) {
      if (this.underFire(u, 25)) continue;
      const d = Math.hypot(u.x - v.x, u.y - v.y);
      if (d < bd) { bd = d; best = u; }
    }
    v.medTarget = best;
    if (!best) return;
    if (bd > 70) {
      // Подъехать на 30–40 м с тыльной стороны — носить недалеко
      const a = Math.atan2(v.y - best.y, v.x - best.x);
      v.medTask = `едет за ранеными: ${best.label}`;
      sim.orderMove([v], best.x + Math.cos(a) * 35, best.y + Math.sin(a) * 35);
    } else if (best.soldiers.some((s) => !s.dead && s.wounded === 2 && !s.evacMove) && sim.time - (best.lastEvac || -1e9) > 10) {
      best.lastEvac = sim.time;
      sim.orderEvac(best);
    }
  }

  // Подбитая техника под огнём: дым и отход в тыл
  vehicle(u) {
    const sim = this.sim;
    if (sim.game?.prep) return;
    if ((u.hp ?? 1) > 0.6 || !this.underFire(u, 6)) return;
    if ((u.smokeLeft ?? 2) > 0 && sim.time - (u.lastSmoke || -1e9) > 45) {
      u.smokeLeft = (u.smokeLeft ?? 2) - 1;
      u.lastSmoke = sim.time;
      this.smoke(u.x + Math.cos(u.heading) * 25, u.y + Math.sin(u.heading) * 25, 28);
      sim.msg(`${u.label}: повреждён — ставит дымовую завесу и отходит`, u.side);
      // Отход на 400 м в сторону своего тыла (задним ходом по дороге — упрощённо)
      const dir = u.side === 'blue' ? -1 : 1;
      const tx = u.x + dir * 400, ty = u.y;
      sim.orderMove([u], tx, ty);
      u.retreating = sim.time;
    }
  }

  smoke(x, y, r) {
    const sim = this.sim;
    this.smokes.push({ x, y, r, t0: sim.time, until: sim.time + SMOKE_LIFE });
  }

  // Дым между наблюдателем и целью — не видно
  blocks(ax, ay, bx, by) {
    for (const s of this.smokes) {
      const k = Math.min(1, (this.sim.time - s.t0) / 4); // завеса разворачивается за 4 с
      const r = s.r * k;
      if (r < 3) continue;
      const vx = bx - ax, vy = by - ay;
      const L2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((s.x - ax) * vx + (s.y - ay) * vy) / L2));
      if (Math.hypot(ax + vx * t - s.x, ay + vy * t - s.y) < r) return true;
    }
    return false;
  }
}
