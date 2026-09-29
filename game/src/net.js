// Сетевая игра: хост считает симуляцию и рассылает снимки состояния,
// гость отображает их и отправляет свои приказы.

import { Rng } from './rng.js';
import { digTrench } from './forts.js';
import { SIDES, Unit } from './sim/units.js';

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
    base.push(u.soldiers ? u.soldiers.map((s) => [r1(s.x), r1(s.y), r2(s.heading), POSE_IDX.indexOf(s.pose), Math.round(s.hp), (s.dead ? 1 : 0) | (s.under ? 2 : 0) | (s.evac ? 4 : 0) | (s.wounded << 3) | (s.moving ? 32 : 0) | (s.treated ? 64 : 0) | (s.inTrench ? 128 : 0), r2(s.mag ?? 1)]) : 0);
    // Десант и снабжение
    base.push([u.embarked ? u.embarked.id : 0, u.fuel === undefined ? -1 : r2(u.fuel), u.rounds === undefined ? -1 : r2(u.rounds), u.cargoRes ? [Math.round(u.cargoRes.ammo), Math.round(u.cargoRes.shells), Math.round(u.cargoRes.fuel), u.autoSupply ? 1 : 0] : 0, u.aim === undefined ? null : r2(u.aim), (u.immobile ? 1 : 0) | (u.gunOut ? 2 : 0) | (u.burning ? 4 : 0) | (u.opticsHit ? 8 : 0), u.crew ?? -1, u.era ?? -1]);
    base.push([u.type, u.side, u.label]); // чтобы гость мог создать новое подразделение
    return base;
  });
  const shells = sim.art.shells.map((s) => [r1(s.x0), r1(s.y0), r1(s.x), r1(s.y), r1(s.tLaunch), r1(s.tImpact), s.caliber]);
  const drones = sim.drones.list.filter((d) => !d.dead).map((d) => [d.id, d.side, d.kind, r1(d.x), r1(d.y), r1(d.tx), r1(d.ty), d.state, r2(d.heading), d.op.id]);
  const g = sim.game;
  const snap = { t: 'snap', time: r1(sim.time), units, shells, drones, fires: (sim.fires || []).map((f) => [r1(f.x), r1(f.y), f.r, r1(f.until)]) };
  snap.intel = { blue: sim.intel.blue.map((m) => [m.kind, r1(m.x), r1(m.y), Math.round(m.r), r1(m.t), r1(m.until), m.label]), red: sim.intel.red.map((m) => [m.kind, r1(m.x), r1(m.y), Math.round(m.r), r1(m.t), r1(m.until), m.label]) };
  snap.smokes = (sim.smokes || []).map((s) => [r1(s.x), r1(s.y), s.r, r1(s.t0), r1(s.until)]);
  // Тыловые объекты: гость создаёт их по снимку
  const fac = (kind, f) => [kind, f.id, f.side, r1(f.x), r1(f.y), r2(f.angle || 0), r2(f.built ?? 1), f.alive ? 1 : 0, f.spotted ? 1 : 0, f.name, f.stock ? [Math.round(f.stock.ammo), Math.round(f.stock.shells), Math.round(f.stock.fuel)] : 0];
  snap.fac = [...sim.log.depots.map((d) => fac('depot', d)), ...sim.medpoints.blue.map((m) => fac('medpoint', m)), ...sim.medpoints.red.map((m) => fac('medpoint', m))];
  if (g?.mode === 'drones') {
    snap.dw = g.snapshot();
  } else if (g) {
    snap.prep = g.prep ? 1 : 0; snap.prepEnd = g.prepEnd; snap.ready = g.ready;
    snap.zones = g.zones.map((z) => [z.owner, r2(z.prog), z.blue || 0, z.red || 0, z.contested ? 1 : 0, z.locked ? 1 : 0]);
    snap.lt = g.linesTaken || 0;
    snap.res = {};
    for (const [side, r] of Object.entries(g.reserve || {})) snap.res[side] = [Math.floor(r.points), r.avail, r.queue.map((q) => [q.type, r1(q.at)])];
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
    let u = byId.get(a[0]);
    if (!u && a[17]) {
      // Новое подразделение (прибыло из резерва на стороне хоста)
      const [type, side, label] = a[17];
      u = new Unit(side, type, a[1], a[2], label);
      u.id = a[0];
      sim.log.init(u);
      sim.units.push(u);
      byId.set(u.id, u);
    }
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
        s.mag = q[6];
        if (s.dead) s.mode = 'dead';
      });
      u.strength = u.soldiers.filter((s) => !s.dead).length / u.soldiers.length;
    }
    const e = a[16];
    if (e) {
      const v = e[0] ? byId.get(e[0]) : null;
      if (v !== (u.embarked || null)) {
        if (u.embarked) u.embarked.passengers = u.embarked.passengers.filter((p) => p !== u);
        u.embarked = v;
        if (v && !v.passengers.includes(u)) v.passengers.push(u);
      }
      if (e[1] >= 0) u.fuel = e[1];
      if (e[2] >= 0) u.rounds = e[2];
      if (e[3]) { u.cargoRes = { ammo: e[3][0], shells: e[3][1], fuel: e[3][2] }; u.autoSupply = !!e[3][3]; }
      if (e[4] !== null) u.aim = e[4];
      if (e[5] !== undefined) { u.immobile = !!(e[5] & 1); u.gunOut = !!(e[5] & 2); u.burning = e[5] & 4 ? 1 : 0; u.opticsHit = !!(e[5] & 8); }
      if (e[6] >= 0) u.crew = e[6];
      if (e[7] >= 0) u.era = e[7];
    }
  }
  sim.art.shells = snap.shells.map((s) => ({ x0: s[0], y0: s[1], x: s[2], y: s[3], tLaunch: s[4], tImpact: s[5], caliber: s[6] }));
  const ops = new Map(sim.units.map((u) => [u.id, u]));
  sim.drones.list = snap.drones.map((d) => ({ id: d[0], side: d[1], kind: d[2], x: d[3], y: d[4], tx: d[5], ty: d[6], state: d[7], heading: d[8], op: ops.get(d[9]) || {}, dead: false }));
  sim.fires = snap.fires.map((f) => ({ x: f[0], y: f[1], r: f[2], until: f[3] }));
  sim.combat.fires = sim.fires;
  for (const t of snap.tracers || []) sim.combat.tracers.push({ x0: t[0], y0: t[1], x1: t[2], y1: t[3], side: t[4] ? 'red' : 'blue', heavy: !!t[5], t: sim.time });
  const g = sim.game;
  if (g && snap.dw) g.applySnapshot(snap.dw);
  if (g && snap.zones) {
    snap.zones.forEach((z, i) => { const zn = g.zones[i]; if (!zn) return; zn.owner = z[0]; zn.prog = z[1]; zn.blue = z[2]; zn.red = z[3]; zn.contested = !!z[4]; zn.locked = !!z[5]; });
    if (g.lines) { g.linesTaken = snap.lt; g.lines.forEach((l, i) => { l.owner = i < snap.lt ? g.cfg.attacker : l.owner; }); }
    for (const [side, q] of Object.entries(snap.res || {})) { const r = g.reserve?.[side]; if (!r) continue; r.points = q[0]; r.avail = q[1]; r.queue = q[2].map(([type, at]) => ({ type, at })); }
    g.score = snap.score;
    g.winner = snap.winner;
    g.reason = snap.reason;
    g.endAt = snap.endAt;
    g.prep = !!snap.prep; g.prepEnd = snap.prepEnd; g.ready = snap.ready || g.ready;
  }
  if (snap.intel) for (const side of ['blue', 'red']) sim.intel[side] = snap.intel[side].map((q) => ({ kind: q[0], x: q[1], y: q[2], r: q[3], t: q[4], until: q[5], label: q[6] }));
  if (snap.smokes) { sim.smokes.length = 0; for (const q of snap.smokes) sim.smokes.push({ x: q[0], y: q[1], r: q[2], t0: q[3], until: q[4] }); }
  if (snap.fac) {
    const depots = [], meds = { blue: [], red: [] };
    const old = new Map([...sim.log.depots, ...sim.medpoints.blue, ...sim.medpoints.red].map((f) => [f.id, f]));
    for (const q of snap.fac) {
      const f = old.get(q[1]) || { id: q[1], kind: q[0], cap: { ammo: 1200, shells: 1600, fuel: 700 } };
      Object.assign(f, { side: q[2], x: q[3], y: q[4], angle: q[5], built: q[6], alive: !!q[7], spotted: !!q[8], name: q[9] });
      if (q[10]) f.stock = { ammo: q[10][0], shells: q[10][1], fuel: q[10][2] };
      if (q[0] === 'depot') depots.push(f); else meds[f.side].push(f);
    }
    sim.log.depots = depots;
    sim.medpoints.blue = meds.blue; sim.medpoints.red = meds.red;
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
    if (u.tx !== undefined) {
      const dx = (u.tx - u.x) * k, dy = (u.ty - u.y) * k;
      u.x += dx; u.y += dy;
      u.odo = (u.odo || 0) + Math.hypot(dx, dy);
    }
    if (u.soldiers) for (const s of u.soldiers) if (s.tx !== undefined) {
      const dx = (s.tx - s.x) * k, dy = (s.ty - s.y) * k;
      s.x += dx; s.y += dy;
      s.walk = (s.walk || 0) + Math.hypot(dx, dy); // для анимации шага
    }
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
