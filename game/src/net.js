// Сетевая игра: хост считает симуляцию и рассылает снимки состояния,
// гость отображает их и отправляет свои приказы.

import { Rng } from './rng.js';
import { digTrench } from './forts.js';
import { SIDES } from './sim/units.js';

const POSE_IDX = ['stand', 'crouch', 'prone', 'trench', 'window', 'inside', 'under', 'dead'];

export class Net {
  constructor(url) {
    this.url = url;
    this.handlers = {};
    this.ws = new WebSocket(url);
    this.ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      (this.handlers[m.t] || (() => {}))(m);
    };
    this.ws.onclose = () => (this.handlers.close || (() => {}))();
    this.ws.onerror = () => (this.handlers.error || (() => {}))();
  }
  on(t, fn) { this.handlers[t] = fn; return this; }
  send(obj) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  ready() { return new Promise((res, rej) => { this.ws.onopen = res; this.handlers.error = rej; }); }
}

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

// ---------- Снимок (хост) ----------
export function makeSnapshot(sim) {
  const units = sim.units.map((u) => {
    const base = [u.id, r1(u.x), r1(u.y), r2(u.heading), u.state, u.mode, u.dead ? 1 : 0, r2(u.hp ?? 1), u.ammo, u.cargo, u.fire ? 1 : 0, r1(u.speed), u.task?.type || '', u.roe, u.firedAt ? r1(u.firedAt) : 0];
    if (u.soldiers) base.push(u.soldiers.map((s) => [r1(s.x), r1(s.y), r2(s.heading), POSE_IDX.indexOf(s.pose), Math.round(s.hp), (s.dead ? 1 : 0) | (s.under ? 2 : 0) | (s.evac ? 4 : 0) | (s.wounded << 3) | (s.moving ? 32 : 0) | (s.treated ? 64 : 0) | (s.inTrench ? 128 : 0)]));
    return base;
  });
  const shells = sim.art.shells.map((s) => [r1(s.x0), r1(s.y0), r1(s.x), r1(s.y), r1(s.tLaunch), r1(s.tImpact), s.caliber]);
  const drones = sim.drones.list.filter((d) => !d.dead).map((d) => [d.id, d.side, d.kind, r1(d.x), r1(d.y), r1(d.tx), r1(d.ty), d.state, r2(d.heading), d.op.id]);
  const g = sim.game;
  const snap = { t: 'snap', time: r1(sim.time), units, shells, drones, fires: (sim.fires || []).map((f) => [r1(f.x), r1(f.y), f.r, r1(f.until)]) };
  if (g) {
    snap.zones = g.zones.map((z) => [z.owner, r2(z.prog), z.blue || 0, z.red || 0, z.contested ? 1 : 0]);
    snap.score = g.score;
    snap.winner = g.winner;
    snap.reason = g.reason;
    snap.endAt = g.endAt;
  }
  snap.tracers = sim.combat.tracers.filter((t) => !t.sent).map((t) => { t.sent = true; return [r1(t.x0), r1(t.y0), r1(t.x1), r1(t.y1), t.side === 'blue' ? 0 : 1, t.heavy ? 1 : 0]; });
  return snap;
}

export function gridPacket(sim) {
  const g = sim.game?.grid;
  if (!g) return null;
  return { t: 'grid', v: g.version, c: Array.from(g.c, (v) => Math.round(v * 100)) };
}

// ---------- Применение снимка (гость) ----------
export function applySnapshot(sim, snap) {
  sim.time = snap.time;
  const byId = new Map(sim.units.map((u) => [u.id, u]));
  for (const a of snap.units) {
    const u = byId.get(a[0]);
    if (!u) continue;
    u.tx = a[1]; u.ty = a[2];
    if (u.x === undefined || Math.hypot(u.x - a[1], u.y - a[2]) > 80) { u.x = a[1]; u.y = a[2]; }
    u.heading = a[3]; u.state = a[4]; u.mode = a[5];
    u.dead = !!a[6]; u.hp = a[7]; u.ammo = a[8]; u.cargo = a[9];
    u.fire = a[10] ? (u.fire || { rounds: 0, next: 0 }) : null;
    u.speed = a[11];
    u.task = a[12] ? { type: a[12], ...(u.task?.type === a[12] ? u.task : {}) } : null;
    u.roe = a[13]; u.firedAt = a[14];
    if (u.soldiers && a[15]) {
      a[15].forEach((q, i) => {
        const s = u.soldiers[i];
        if (!s) return;
        s.tx = q[0]; s.ty = q[1];
        if (Math.hypot(s.x - q[0], s.y - q[1]) > 40) { s.x = q[0]; s.y = q[1]; }
        s.heading = q[2]; s.pose = POSE_IDX[q[3]] || 'stand'; s.hp = q[4];
        const f = q[5];
        s.dead = !!(f & 1); s.under = !!(f & 2); s.evac = !!(f & 4); s.wounded = (f >> 3) & 3; s.moving = !!(f & 32); s.treated = !!(f & 64); s.inTrench = !!(f & 128);
        if (s.dead) s.mode = 'dead';
      });
      u.strength = u.soldiers.filter((s) => !s.dead).length / u.soldiers.length;
    }
  }
  sim.art.shells = snap.shells.map((s) => ({ x0: s[0], y0: s[1], x: s[2], y: s[3], tLaunch: s[4], tImpact: s[5], caliber: s[6] }));
  const ops = new Map(sim.units.map((u) => [u.id, u]));
  sim.drones.list = snap.drones.map((d) => ({ id: d[0], side: d[1], kind: d[2], x: d[3], y: d[4], tx: d[5], ty: d[6], state: d[7], heading: d[8], op: ops.get(d[9]) || {}, dead: false }));
  sim.fires = snap.fires.map((f) => ({ x: f[0], y: f[1], r: f[2], until: f[3] }));
  sim.combat.fires = sim.fires;
  for (const t of snap.tracers || []) sim.combat.tracers.push({ x0: t[0], y0: t[1], x1: t[2], y1: t[3], side: t[4] ? 'red' : 'blue', heavy: !!t[5], t: sim.time });
  const g = sim.game;
  if (g && snap.zones) {
    snap.zones.forEach((z, i) => { const zn = g.zones[i]; if (!zn) return; zn.owner = z[0]; zn.prog = z[1]; zn.blue = z[2]; zn.red = z[3]; zn.contested = !!z[4]; });
    g.score = snap.score;
    g.winner = snap.winner;
    g.reason = snap.reason;
    g.endAt = snap.endAt;
  }
}

export function applyGrid(sim, pkt) {
  const g = sim.game?.grid;
  if (!g) return;
  for (let i = 0; i < pkt.c.length; i++) g.c[i] = pkt.c[i] / 100;
  g.version++;
}

// Плавное движение между снимками
export function interpolate(sim, dt) {
  const k = Math.min(1, dt * 8);
  for (const u of sim.units) {
    if (u.tx !== undefined) { u.x += (u.tx - u.x) * k; u.y += (u.ty - u.y) * k; }
    if (u.soldiers) for (const s of u.soldiers) if (s.tx !== undefined) { s.x += (s.tx - s.x) * k; s.y += (s.ty - s.y) * k; }
  }
}

// ---------- События мира (гость) ----------
export function applyWorldEvent(sim, ev, invalidate) {
  const world = sim.world;
  if (ev.k === 'boom') sim.art.explodeWorld(ev.x, ev.y, ev.c, ev.f, ev.s);
  else if (ev.k === 'trench') {
    const items = digTrench(world, new Rng(ev.s), ev.pts, ev.side, SIDES[ev.side].enemy);
    for (const it of items) invalidate(it.bbox);
  } else if (ev.k === 'wreck') {
    const w = { kind: 'wreck', x: ev.x, y: ev.y, angle: ev.a, type: ev.t, seed: ev.id * 7919 };
    w.bbox = { x0: ev.x - 10, y0: ev.y - 10, x1: ev.x + 10, y1: ev.y + 10 };
    world.scars.insert(w);
    invalidate(w.bbox);
  }
}
