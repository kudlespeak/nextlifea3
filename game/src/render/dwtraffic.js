// Гражданский транспорт «Войны дронов» — только для вида: легковые и автобусы ездят между
// сёлами, городами, ТЦ и АЗС своей стороны по дорожному графу (через целые мосты). Не влияет на
// игру и не передаётся по сети. Число машин зависит от света и топлива (нет бензина — пустые
// дороги). Дёшево: машина — точка на готовой ломаной, не больше одного расчёта маршрута за кадр,
// рисуются только машины в кадре; на обзорном масштабе не рисуются вовсе.

import { spriteFor, drawSprite } from './mesh3d.js';
import { buildVehicle } from './dwmodels.js';

const PER_SIDE = 55;
const SPEED = 1.7; // тот же темп, что у служебного транспорта

export class CivTraffic {
  constructor(g) {
    this.g = g;
    this.cars = [];
    this.wrecks = [];
    this.lastT = null;
    this.seed = 12345;
    this.checkT = 0;
    this.seenFx = new WeakSet();
    this.pois = { blue: [], red: [] };
    for (const s of g.world.settlements) this.pois[s.side]?.push({ x: s.x, y: s.y, w: s.type === 'city' ? 4 : 1 });
    for (const o of g.objects) if ((o.kind === 'fuel' || o.kind === 'mall' || o.kind === 'market') && this.pois[o.side]) {
      const p = g.logi.gate(o);
      this.pois[o.side].push({ x: p[0], y: p[1], w: o.kind === 'fuel' ? 2 : 1.5, stop: o.kind === 'fuel' ? 12 : 25 });
    }
  }
  rnd() { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296; }
  pick(list) {
    let tot = 0;
    for (const p of list) tot += p.w;
    let r = this.rnd() * tot;
    for (const p of list) if ((r -= p.w) <= 0) return p;
    return list[list.length - 1];
  }
  want(side) {
    const S = this.g.sides[side];
    return Math.round(PER_SIDE * (0.35 + 0.65 * (S.oil ?? 1)) * (0.5 + 0.5 * (S.supply ?? 1)));
  }
  trip(side, from) {
    const list = this.pois[side];
    if (!list.length) return null;
    const a = from || this.pick(list);
    for (let k = 0; k < 4; k++) {
      const b = this.pick(list);
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (b === a || d < 800 || d > 9000) continue;
      const r = this.g.logi.roadRoute([a.x, a.y], [b.x, b.y]);
      if (r && r.path.length > 3) return { r, a, b };
    }
    return null;
  }
  update(t) {
    if (this.lastT === null) { this.lastT = t; return; }
    const dt = Math.min(2, Math.max(0, t - this.lastT));
    this.lastT = t;
    if (dt <= 0) return;
    const g = this.g;
    // Удары: машины рядом с разрывом сгорают
    for (const f of g.fx) {
      if (f.t !== 'impact' || this.seenFx.has(f)) continue;
      this.seenFx.add(f);
      for (const c of this.cars) if (!c.gone && Math.hypot(c.x - f.x, c.y - f.y) < 25 + (f.wh || 0) * 0.3) { c.gone = true; this.wrecks.push({ x: c.x, y: c.y, h: c.heading, t }); }
    }
    this.wrecks = this.wrecks.filter((w) => t - w.t < 300);
    // Новые поездки: не больше одной за кадр
    for (const side of ['blue', 'red']) {
      const n = this.cars.filter((c) => c.side === side && !c.gone).length;
      if (n < this.want(side) && this.rnd() < 0.5) {
        const tr = this.trip(side);
        if (tr) {
          const pi = n < 10 ? 1 : 1 + Math.floor(this.rnd() * (tr.r.path.length - 2)); // первые — сразу на дороге
          const p = tr.r.path[pi - 1];
          const bus = this.rnd() < 0.08;
          this.cars.push({ side, x: p[0], y: p[1], heading: 0, path: tr.r.path, pi, bridges: tr.r.bridges, dest: tr.b, kind: bus ? 'bus' : 'car', variant: Math.floor(this.rnd() * 8), v: (bus ? 12 : 14 + this.rnd() * 9) * SPEED, pause: 0 });
          break;
        }
      }
    }
    // Мост обрушен — разворот и объезд (или поездка отменяется)
    this.checkT -= dt;
    const check = this.checkT <= 0;
    if (check) this.checkT = 2;
    for (const c of this.cars) {
      if (c.gone) continue;
      if (check && c.bridges.some((id) => g.bridgeCap(g.obj(id)) === 0)) {
        const r = g.logi.roadRoute([c.x, c.y], [c.dest.x, c.dest.y]);
        if (r) { c.path = r.path; c.pi = 1; c.bridges = r.bridges; } else { c.gone = true; continue; }
      }
      if (c.pause > 0) { c.pause -= dt; continue; }
      let step = c.v * dt;
      while (step > 0 && c.pi < c.path.length) {
        const [tx, ty] = c.path[c.pi];
        const dx = tx - c.x, dy = ty - c.y, d = Math.hypot(dx, dy);
        if (d > 0.01) c.heading = Math.atan2(dy, dx);
        if (d <= step) { c.x = tx; c.y = ty; step -= d; c.pi++; } else { c.x += (dx / d) * step; c.y += (dy / d) * step; step = 0; }
      }
      if (c.pi >= c.path.length) {
        // Приехали: постоять (на АЗС — заправка) и поехать дальше, иногда — исчезнуть (заехал во двор)
        if (this.rnd() < 0.35) { c.gone = true; continue; }
        const tr = this.trip(c.side, c.dest);
        if (!tr) { c.gone = true; continue; }
        c.pause = c.dest.stop || 4;
        c.path = tr.r.path; c.pi = 1; c.bridges = tr.r.bridges; c.dest = tr.b;
      }
    }
    if (this.cars.length > PER_SIDE * 3) this.cars = this.cars.filter((c) => !c.gone);
  }
  draw(ctx, view, toS, inView, now) {
    const { cam, dpr } = view;
    const z = cam.zoom;
    if (z < 0.25) return;
    for (const w of this.wrecks) {
      if (!inView(w.x, w.y, 10)) continue;
      const [sx, sy] = toS(w.x, w.y);
      ctx.fillStyle = 'rgba(25,20,16,0.85)';
      ctx.beginPath(); ctx.ellipse(sx, sy, Math.max(1.5 * dpr, 2.3 * z), Math.max(1 * dpr, 1 * z), w.h, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = 'rgba(225,228,230,0.9)';
    for (const c of this.cars) {
      if (c.gone || !inView(c.x, c.y, 12)) continue;
      const [sx, sy] = toS(c.x, c.y);
      if (z >= 1.2) {
        const key = `dwv:${c.kind}:${c.variant % (c.kind === 'bus' ? 3 : 8)}`;
        const r = spriteFor(key, () => buildVehicle(c.kind, c.side, c.variant), c.heading, z, undefined, now);
        if (r) drawSprite(ctx, r, sx, sy, z, r.residual);
      } else ctx.fillRect(sx - 0.8 * dpr, sy - 0.8 * dpr, 1.6 * dpr, 1.6 * dpr);
    }
  }
}
