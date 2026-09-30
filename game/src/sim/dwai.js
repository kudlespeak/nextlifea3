// ИИ режима «Война дронов»: строит ПВО вокруг ценных объектов, держит резерв на ремонт,
// разведывает позиции ПВО противника, выбивает их барражирующими боеприпасами и наносит
// массированные удары волнами (ложные цели + ударные), обходя известные зоны ПВО.

import { DW_AD, DW_DRONES, COMP, GTU } from './dronewar.js';
import { BUILD, upgradeCost } from './dwecon.js';
import { SALE } from './dwlogi.js';

const VALUE = { elevator: 5, tpp: 14, ps330: 12, hpp: 10, chp: 8, ps110: 6, bridge: 5, oil: 5, ammo: 5, factory: 7, launch: 5, hub: 5, wpp: 3, spp: 3 };
const WANT_COVER = { elevator: 1.5, tpp: 7, ps330: 6, hpp: 5, chp: 4, ps110: 3, factory: 3, launch: 2.5, bridge: 1.5, oil: 2, ammo: 2, wpp: 1, spp: 1.5 };
const TARGET_COMPS = { elevator: ['silo', 'dryer'], hpp: ['gsu', 'oru', 'hgen'], chp: ['unit', 'gsu', 'oru'], wpp: ['wt', 'gsu'], spp: ['pv', 'inv', 'oru'], tpp: ['gsu', 'unit', 'oru', 'coal'], ps330: ['at', 'oru'], ps110: ['tr', 'oru'], bridge: ['span'], oil: ['tank'], ammo: ['bunker'], factory: ['shop'], launch: ['launcher'], hub: ['hall'] };

const D_RANGE = (D) => D.range || 99999;

export class DroneWarAI {
  constructor(sim, side, difficulty = 'normal') {
    this.sim = sim;
    this.side = side;
    this.enemy = side === 'blue' ? 'red' : 'blue';
    this.k = { easy: 0.6, normal: 1, hard: 1.4 }[difficulty] ?? 1;
    const t = sim.time;
    this.next = { think: t + 3, recon: t + 30, strike: t + 200 + sim.rng.float(0, 120), loiter: t + 120, shelter: t + 60 };
    // Бюджет: доход делится между обороной и ударами; ремонт оплачивается первым (из общих очков)
    this.fund = { def: 420, off: 380 };
    this.lastPts = null;
    // Экономика: цель накопления (стройка или реконструкция с лучшей окупаемостью)
    this.goal = null;
    this.intent = '';
    this.launchShort = 0;
    this.next.plan = t + 60;
  }
  // Тратить можно, только оставив запас на идущий ремонт (оплата идёт по ходу работ)
  can(pool, cost) { return this.fund[pool] >= cost && this.S.points - cost >= (this.reserve ?? 30); }
  pay(pool, cost) { this.fund[pool] -= cost; }

  get g() { return this.sim.game; }
  get S() { return this.g.sides[this.side]; }

  update() {
    const t = this.sim.time;
    if (t < this.next.think) return;
    this.next.think = t + 4;
    const g = this.g;
    if (g.winner) return;
    const S = this.S;
    if (this.lastPts !== null) {
      const inc = S.points - this.lastPts;
      if (inc > 0) { this.fund.def += inc * 0.45; this.fund.off += inc * 0.55; }
    }
    const pend = g.pendingCost(this.side);
    // Резерв на ремонт: не тратить последнее, пока энергосистема повреждена
    this.reserve = Math.min(300, 30 + pend.sum * 0.6); // на оборудование взамен уничтоженного
    // Копим на выгодную стройку: удары и новые позиции — только из того, что сверх цели
    if (this.goal && !this.finishing()) this.reserve += this.goal.cost * 0.8;
    if (t > this.next.plan) { this.next.plan = t + 30; this.plan(); }
    this.doGoal();
    this.defense();
    if (t > this.next.shelter) { this.next.shelter = t + 90; this.shelters(); }
    if (t > this.next.recon) { this.next.recon = t + 200 / this.k + this.sim.rng.float(0, 80); this.recon(); }
    if (!g.prep && t > this.next.loiter) { this.next.loiter = t + 70; this.loiter(); }
    if (!g.prep && t > (this.next.hunt ?? t + 150)) { this.next.hunt = t + 170 / this.k + this.sim.rng.float(0, 90); this.hunt(); }
    else if (this.next.hunt === undefined) this.next.hunt = t + 150;
    if (!g.prep && t > this.next.strike) {
      const night = ((t / 3600) % 24) > 20 || ((t / 3600) % 24) < 5;
      // Эскалация: к третьей фазе удары вдвое чаще
      this.next.strike = t + ((night ? 200 : 300) / this.k + this.sim.rng.float(0, 120)) / (1 + (g.endless ? 0.25 : 0.5) * g.phase());
      this.strike();
    }
    this.nets();
    // Дефицит на подстанции держится — везём мобильную ГТУ
    for (const ps of g.objs(this.side, 'ps110')) {
      if ((ps.shed || 0) >= 1 && (ps.demand || 0) - (ps.avail || 0) > 20 && this.can('def', GTU.cost) && !g.buyGTU(this.side, ps.id)) { this.pay('def', GTU.cost); break; }
    }
    if (S.queue.length > S.crews.length && S.crews.length < 20 && this.can('def', 60) && !this.g.buyCrew(this.side)) this.pay('def', 60);
    if (S.spare === 0 && this.can('def', 150) && !this.g.buySpare(this.side)) this.pay('def', 150);
    this.lastPts = S.points;
  }

  // ---------- ПВО ----------
  cover(o) {
    let c = 0;
    for (const a of this.g.ad) {
      if (a.dead || a.side !== this.side) continue;
      const d = Math.hypot(a.x - o.x, a.y - o.y);
      if (a.type === 'mog' && d < 2500) c += 1;
      else if (a.type === 'spaag' && d < 3500) c += 2.5;
      else if (a.type === 'sam' && d < 9000) c += d < 5000 ? 3 : 1.5;
      else if (a.type === 'icpt' && d < 7000) c += 1.5;
      else if (a.type === 'ew' && d < 3000) c += 1.2;
    }
    return c;
  }
  defense() {
    const g = this.g, S = this.S, rng = this.sim.rng;
    const spend = () => Math.min(this.fund.def, S.points - this.reserve);
    const put = (type, x, y) => { if (!g.canPlace(this.side, type, x, y) && !g.placeAD(this.side, type, x, y)) this.pay('def', DW_AD[type].cost); };
    const dir = this.side === 'blue' ? 1 : -1; // к фронту
    // Сеть акустических постов перед тылом
    const posts = g.ad.filter((a) => !a.dead && a.side === this.side && a.type === 'acoustic').length;
    if (posts < 14 && spend() > 20) {
      const x = g.frontX - dir * rng.float(1800, 6000), y = rng.float(600, g.world.H - 600);
      put('acoustic', x, y);
    }
    // Самый недоприкрытый ценный объект
    let worst = null, ws = Infinity;
    const threat = g.directive[this.enemy];
    for (const o of g.objs(this.side)) {
      let want = WANT_COVER[o.kind];
      if (!want) continue;
      if (o.kind === 'bridge' && o.btype !== 'rail' && o.btype !== 'highway') continue;
      if (threat && !threat.done && threat.oid === o.id) want += 4; // разведка предупредила об ударе
      const s = this.cover(o) / want;
      if (s < ws) { ws = s; worst = o; }
    }
    if (!worst || ws >= 1) return;
    // Содержание армии: при раздутых расходах новые позиции — только под реальную дыру в обороне
    const upk = g.econ.upkeep(this.side);
    if (ws > 0.5 && upk > 0.3 * Math.max(10, S.income + upk) && S.points < 1200) return;
    const have = (t) => g.ad.filter((a) => !a.dead && a.side === this.side && a.type === t).length;
    let type = 'mog';
    if (have('radar') < 2 && spend() > DW_AD.radar.cost) type = 'radar';
    else if (have('sam') < (this.k > 1 ? 3 : 2) && spend() > DW_AD.sam.cost + 100 && ['tpp', 'ps330'].includes(worst.kind)) type = 'sam';
    else if (have('spaag') < 4 && spend() > DW_AD.spaag.cost + 60 && ['tpp', 'ps330', 'factory'].includes(worst.kind)) type = 'spaag';
    else if (['tpp', 'ps330', 'ps110'].includes(worst.kind) && !g.ad.some((a) => !a.dead && a.side === this.side && a.type === 'ew' && Math.hypot(a.x - worst.x, a.y - worst.y) < 2000) && spend() > DW_AD.ew.cost) type = 'ew';
    else if (have('icpt') < 4 && spend() > DW_AD.icpt.cost && rng.chance(0.6)) type = 'icpt';
    if (spend() < DW_AD[type].cost) return;
    // Со стороны фронта, откуда идут дроны
    const r = type === 'ew' ? rng.float(200, 700) : type === 'sam' ? rng.float(1500, 3500) : rng.float(500, 1600);
    const a = rng.float(-1.2, 1.2);
    const x = worst.x + dir * Math.cos(a) * r, y = worst.y + Math.sin(a) * r;
    put(type, x, y);
  }
  shelters() {
    const g = this.g;
    if (this.fund.def < 150) return;
    for (const kind of ['ps330', 'tpp', 'ps110']) for (const o of g.objs(this.side, kind))
      for (const c of o.comps) {
        if (!COMP[c.k].shelter || c.state !== 'ok') continue;
        const lvl = c.shelter + 1;
        if (lvl > 2) continue;
        if (lvl === 2 && this.fund.def < 300) continue;
        if (!g.shelter(this.side, c.id, lvl)) { this.pay('def', lvl === 1 ? 35 : 110); return; }
      }
  }

  // Сетки: над пролётами главных мостов и над дорогой, где жгут наши машины
  nets() {
    const g = this.g, t = this.sim.time;
    if (g.prep || this.fund.def < 80 || t < (this.next.nets || 0)) return;
    this.next.nets = t + 60;
    // Сначала — дорога, где только что сожгли нашу машину
    const loss = this.S.lastLoss;
    this.S.lastLoss = null;
    if (loss && !g.buildNet(this.side, loss[0], loss[1])) { this.pay('def', 40); return; }
    const busy = (c) => this.S.queue.includes('S' + c.id) || this.S.crews.some((w) => w.job?.qid === 'S' + c.id);
    for (const o of g.objs(this.side, 'bridge')) {
      if (o.btype !== 'rail' && o.btype !== 'highway') continue;
      const c = o.comps.find((q) => q.k === 'span' && !q.shelter && q.state === 'ok' && !busy(q));
      if (c && !g.shelter(this.side, c.id, 1)) { this.pay('def', 30); return; }
    }
  }

  // ---------- Разведка и удары ----------
  types() {
    const t = Object.entries(DW_DRONES).filter(([, d]) => d.side === this.side).map(([k, d]) => ({ k, ...d }));
    return { strike: t.filter((d) => d.cls === 'strike'), decoy: t.filter((d) => d.cls === 'decoy'), loiter: t.find((d) => d.cls === 'loiter'), recon: t.find((d) => d.cls === 'recon') };
  }
  recon() {
    const g = this.g, T = this.types();
    if (!T.recon || !this.can('off', 10)) return;
    const objs = g.objs(this.enemy).filter((o) => VALUE[o.kind] >= 5);
    const o = objs[this.sim.rng.int(0, objs.length - 1)];
    if (o && !g.launch(this.side, T.recon.k, 1, o.x + this.sim.rng.float(-1500, 1500), o.y + this.sim.rng.float(-1500, 1500))) this.pay('off', g.droneCost(this.side, T.recon.k));
  }
  loiter() {
    const g = this.g, T = this.types(), t = this.sim.time;
    if (!T.loiter) return;
    const launchX = g.frontX + (this.side === 'blue' ? -1300 : 1300);
    const known = g.ad.filter((a) => !a.dead && a.side === this.enemy && a.spotted[this.side] && t - a.spotted[this.side] < 150 && Math.abs(a.x - launchX) < T.loiter.range);
    const pri = { sam: 6, radar: 5, spaag: 4, ew: 4, icpt: 3, mog: 2, acoustic: 0.5 };
    known.sort((a, b) => (pri[b.type] || 0) - (pri[a.type] || 0));
    // Охота на снабжение: замеченные разведкой фуры и грузовики ПВО в досягаемости
    const trucks = g.logi.vehicles.filter((v) => !v.dead && v.side === this.enemy && (v.kind === 'supply' || v.kind === 'fura' || v.kind === 'tanker') && v.spotted[this.side] && t - v.spotted[this.side] < 60 && Math.abs(v.x - launchX) < T.loiter.range * 0.8);
    const tr = trucks[this.sim.rng.int(0, Math.max(0, trucks.length - 1))];
    if (tr && this.sim.rng.chance(0.5) && !g.drones.some((d) => !d.dead && d.vehTarget === tr.id) && this.can('off', T.loiter.cost)) {
      if (!g.launch(this.side, T.loiter.k, 1, tr.x, tr.y, { vehTarget: tr.id })) this.pay('off', g.droneCost(this.side, T.loiter.k));
    }
    for (const a of known.slice(0, 2)) {
      if (g.drones.some((d) => !d.dead && d.adTarget === a.id)) continue;
      const n = a.type === 'sam' || a.type === 'radar' ? 2 : 1;
      if (!this.can('off', T.loiter.cost * n)) return;
      if (!g.launch(this.side, T.loiter.k, n, a.x, a.y, { adTarget: a.id })) this.pay('off', g.droneCost(this.side, T.loiter.k) * n);
    }
  }
  // Охотники с ИИ — на дороги противника: у распредцентра, погранперехода, нефтебазы, АЗС
  hunt() {
    const g = this.g, rng = this.sim.rng;
    const types = Object.entries(DW_DRONES).filter(([, d]) => d.side === this.side && d.cls === 'hunter');
    if (!types.length) return;
    const L = g.logi.side[this.enemy];
    const areas = [L.hub, L.border, L.oilDepot, ...L.fuels].filter(Boolean);
    const o = areas[rng.int(0, areas.length - 1)];
    const p = g.logi.gate(o);
    const front = types.find(([, d]) => d.front);
    const [k, D] = front && Math.abs(p[0] - g.frontX) < D_RANGE(front[1]) - 1500 && rng.chance(0.6) ? front : types.find(([, d]) => !d.front) || types[0];
    const n = D.cost < 10 ? 3 : 1 + (rng.chance(0.4) ? 1 : 0);
    if (!this.can('off', g.droneCost(this.side, k) * n)) return;
    if (!g.launch(this.side, k, n, p[0] + rng.float(-800, 800), p[1] + rng.float(-800, 800))) this.pay('off', g.droneCost(this.side, k) * n);
  }
  strike() {
    const g = this.g, S = this.S, T = this.types(), rng = this.sim.rng;
    const budget = Math.min(this.fund.off, S.points - this.reserve) * 0.9;
    if (budget < 50) return;
    // Ценность цели / известная защита
    const knownAD = g.ad.filter((a) => !a.dead && a.side === this.enemy && a.spotted[this.side]);
    let best = null, bs = -1;
    const dir = g.directive[this.side];
    for (const o of g.objs(this.enemy)) {
      let v = VALUE[o.kind];
      if (v && dir && !dir.done && dir.oid === o.id) v *= 4; // директива штаба
      if (!v) continue;
      const ok = o.comps.filter((c) => TARGET_COMPS[o.kind]?.includes(c.k) && c.state === 'ok');
      if (!ok.length) continue;
      if (o.kind === 'bridge' && o.btype !== 'rail' && o.btype !== 'highway') continue;
      const def = knownAD.filter((a) => Math.hypot(a.x - o.x, a.y - o.y) < (a.type === 'sam' ? 9000 : 3000)).length;
      const s = (v * (ok.length / o.comps.length + 0.5)) / (1 + def * 0.35) * rng.float(0.7, 1.3);
      if (s > bs) { bs = s; best = o; }
    }
    if (!best) return;
    const aims = best.comps.filter((c) => TARGET_COMPS[best.kind].includes(c.k) && c.state === 'ok');
    // Состав волны
    const heavy = best.kind === 'bridge' || best.kind === 'factory';
    const main = this.side === 'red'
      ? (heavy || rng.chance(0.15) ? T.strike.find((d) => d.k === 'geran3') : null) || T.strike.find((d) => d.k === 'shahed')
      : heavy ? T.strike.find((d) => d.k === 'fp2') : rng.chance(0.5) ? T.strike.find((d) => d.k === 'lyutyi') : T.strike.find((d) => d.k === (best.kind === 'ps110' || best.kind === 'launch' ? 'bober' : 'fp1'));
    const unit = g.droneCost(this.side, main.k);
    let n = Math.max(2, Math.min(Math.round(12 * this.k), Math.floor((budget * 0.8) / unit)));
    if (n * unit > budget) n = Math.floor(budget / unit);
    // Пропускная способность стартовых позиций: 300 дронов разом не поднять
    const free = g.econ.launchFree(this.side);
    if (free < 4) { this.launchShort++; return; }
    n = Math.min(n, Math.max(2, Math.floor(free * 0.55)));
    if (n < 2) return;
    let slots = free - n;
    const route = this.route(best, knownAD);
    // Ложные цели идут первыми, чтобы вскрыть и отвлечь ПВО (у Велнарии — рой дешёвых «Бобров»)
    if (!T.decoy.length && main.k !== 'bober') {
      const bob = T.strike.find((d) => d.k === 'bober');
      const nb = Math.min(Math.ceil(n / 2), 8, slots, Math.floor((budget - n * unit) / g.droneCost(this.side, 'bober')));
      if (bob && nb > 1 && rng.chance(0.5)) {
        slots -= nb;
        const c = aims[rng.int(0, aims.length - 1)];
        if (!g.launch(this.side, 'bober', nb, c.x, c.y, { route, oid: best.id, cid: c.id })) this.pay('off', g.droneCost(this.side, 'bober') * nb);
      }
    }
    if (T.decoy.length) {
      const dec = T.decoy[0];
      const nd = Math.min(Math.round(n * 1.2), slots, Math.floor((budget - n * unit) / g.droneCost(this.side, dec.k)));
      if (nd > 0 && !g.launch(this.side, dec.k, nd, best.x + rng.float(-300, 300), best.y + rng.float(-300, 300), { route, oid: best.id })) this.pay('off', g.droneCost(this.side, dec.k) * nd);
    }
    // Ударные — по отдельным узлам
    let left = n;
    let i = 0;
    while (left > 0) {
      const c = aims[i % aims.length];
      const k = Math.min(left, Math.max(1, Math.ceil(n / aims.length)));
      if (!g.launch(this.side, main.k, k, c.x, c.y, { route, oid: best.id, cid: c.id })) this.pay('off', unit * k);
      left -= k; i++;
    }
  }
  // ---------- Экономика: окупаемость вложений против ударов ----------
  // Противник на грани — все силы на удары, стройки подождут
  finishing() { return (this.g.sides[this.enemy].morale ?? 100) < 35; }
  horizon() { const g = this.g; return g.endless ? 40 : Math.max(6, ((g.endAt - this.sim.time) / 60) * 0.6); }
  // Точка под объект рядом с опорной: несколько попыток, пока место не подойдёт
  spot(kind, ax, ay, r0, r1) {
    const g = this.g, rng = this.sim.rng;
    for (let k = 0; k < 10; k++) {
      const a = rng.float(0, 6.283), r = rng.float(r0, r1);
      const x = ax + Math.cos(a) * r, y = ay + Math.sin(a) * r;
      const s = g.econ.siteFor(this.side, kind, x, y);
      if (!s.err) return [x, y];
    }
    return null;
  }
  econCands() {
    const g = this.g, E = g.econ, S = this.S, side = this.side, logi = g.logi, L = logi.side[side];
    const K = g.incomeK(side), I = S.inc || {}, rng = this.sim.rng;
    const out = [];
    const busy = g.objects.some((o) => o.side === side && o.build && !o.build.up); // одна стройка за раз
    // Реконструкция своих объектов
    for (const o of g.objs(side)) {
      if (!BUILD[o.kind] || o.build || (o.level || 1) >= 3 || o.comps.some((c) => c.state === 'destroyed')) continue;
      let gain = 0;
      if (SALE[o.kind]) gain = o.stock > 0 ? 0.4 * SALE[o.kind].value * (60 / SALE[o.kind].every) * K : 0;
      else if (o.kind === 'hub') gain = 0.12 * ((I.trade || 0) + (I.fuel || 0));
      else if (o.kind === 'elevator') gain = (o.grain || 0) > 0.6 * E.elevCap(o) ? 0.3 * (I.agro || 0) + 2 : 0;
      else if (o.kind === 'launch') gain = this.launchShort >= 2 || this.S.points > 1500 ? 9 : 0;
      else if (o.kind === 'agro') gain = 1.2;
      if (gain > 0) out.push({ act: 'upgrade', id: o.id, cost: upgradeCost(o), gain, name: `реконструкция «${o.name}»` });
    }
    if (busy) return out;
    const cities = g.world.settlements.filter((q) => q.side === side && q.type === 'city');
    // Супермаркет или ТЦ в городе, где торговли мало
    for (const c of cities) {
      const near = L.markets.filter((m) => Math.hypot(m.x - c.x, m.y - c.y) < 3500);
      const kind = near.some((m) => m.kind === 'mall') || near.length < 2 ? 'market' : 'mall';
      if (near.length >= (c.capital ? 5 : 3)) continue;
      const p = this.spot(kind, c.x, c.y, 900, 2200);
      if (p) out.push({ act: 'build', kind, x: p[0], y: p[1], cost: BUILD[kind].cost, gain: (kind === 'mall' ? 5 : 4) * (60 / SALE[kind].every) * K * 0.85 + 0.4, name: `${BUILD[kind].name} у города ${c.name}` });
    }
    // АЗС на трассе вдали от других заправок
    {
      const roads = g.world.roadList.filter((r) => r.type === 'highway' || r.type === 'local');
      let best = null, bd = 0;
      for (let k = 0; k < 14; k++) {
        const r = roads[rng.int(0, roads.length - 1)]; if (!r) break;
        const q = r.line[rng.int(0, r.line.length - 1)];
        if (!E.territoryOk(side, q[0])) continue;
        const d = Math.min(...L.fuels.map((m) => Math.hypot(m.x - q[0], m.y - q[1])), 1e9);
        if (d > bd) { bd = d; best = q; }
      }
      if (best && bd > 5000) { const p = this.spot('fuel', best[0], best[1], 60, 350); if (p) out.push({ act: 'build', kind: 'fuel', x: p[0], y: p[1], cost: BUILD.fuel.cost, gain: SALE.fuel.value * (60 / SALE.fuel.every) * K * 0.8, name: 'АЗС на трассе' }); }
    }
    // Логистический хаб у города, далёкого от складов
    const hubs = g.objs(side, 'hub');
    if (hubs.length < 3) {
      let far = null, fd = 0;
      for (const c of cities) { const d = Math.min(...hubs.map((h) => Math.hypot(h.x - c.x, h.y - c.y))); if (d > fd) { fd = d; far = c; } }
      if (far && fd > 8000) { const p = this.spot('hub', far.x, far.y, 1500, 3000); if (p) out.push({ act: 'build', kind: 'hub', x: p[0], y: p[1], cost: BUILD.hub.cost, gain: 0.25 * ((I.trade || 0) + (I.fuel || 0)) + 2, name: `логистический хаб у города ${far.name}` }); }
    }
    // Элеватор ближе к полям, если зерно копится на токах
    const sum = E.summary(side);
    if (sum.farmGrain > 9000 && g.objs(side, 'elevator').length < 4) {
      const els = g.objs(side, 'elevator');
      let far = null, fd = 0;
      for (const f of E.farms) { if (f.side !== side) continue; const d = Math.min(...els.map((e) => Math.hypot(e.x - f.x, e.y - f.y)), 1e9); if (d * (1 + f.grain / 3000) > fd) { fd = d * (1 + f.grain / 3000); far = f; } }
      if (far) { const p = this.spot('elevator', far.x, far.y, 600, 2200); if (p) out.push({ act: 'build', kind: 'elevator', x: p[0], y: p[1], cost: BUILD.elevator.cost, gain: 0.35 * (I.agro || 0) + sum.farmGrain * 0.0004 + 2, name: `элеватор у ${far.name}` }); }
    }
    // Стартовая позиция, если пусковые не успевают
    if ((this.launchShort >= 3 || S.points > 1500) && g.objs(side, 'launch').length < 8) {
      const x = g.frontX + (side === 'blue' ? -1 : 1) * rng.float(9000, 14000), y = rng.float(3000, g.world.H - 3000);
      const p = this.spot('launch', x, y, 0, 1500);
      if (p) out.push({ act: 'build', kind: 'launch', x: p[0], y: p[1], cost: BUILD.launch.cost, gain: 9, name: 'новая стартовая позиция' });
    }
    return out;
  }
  plan() {
    const g = this.g;
    if (g.winner || this.finishing()) { this.goal = null; this.intent = this.finishing() ? 'добивает: все силы на удары' : ''; return; }
    if (this.goal && this.sim.time - this.goal.t0 > 600) this.goal = null; // не накопили за 10 мин — пересмотреть
    if (this.goal) return;
    const H = this.horizon();
    let best = null, br = 0;
    for (const c of this.econCands()) { const roi = (c.gain * H) / c.cost; if (roi > br) { br = roi; best = c; } }
    if (best && br >= 0.7) { this.goal = { ...best, roi: br, t0: this.sim.time }; this.intent = `копит на: ${best.name} (${best.cost} оч., окупится за ~${Math.round(best.cost / best.gain)} мин)`; }
    else this.intent = 'вкладывает в удары и оборону';
  }
  doGoal() {
    const G = this.goal, g = this.g, S = this.S;
    if (!G) return;
    if (S.points - (this.reserve - G.cost * 0.8) < G.cost) return;
    const err = G.act === 'upgrade' ? g.upgrade(this.side, G.id) : g.buildCivil(this.side, G.kind, G.x, G.y);
    if (!err) { this.fund.def -= G.cost * 0.4; this.fund.off -= G.cost * 0.6; if (G.kind === 'launch') this.launchShort = 0; }
    this.goal = null;
  }
  // Маршрут в обход известных позиций ПВО: одна-две точки сбоку
  route(o, knownAD) {
    const g = this.g, rng = this.sim.rng;
    const sx = this.side === 'blue' ? 400 : g.world.W - 400;
    const pts = [];
    const mid = { x: (sx + o.x) / 2, y: o.y + rng.float(-2500, 2500) };
    const threat = (p) => knownAD.filter((a) => Math.hypot(a.x - p.x, a.y - p.y) < (a.type === 'sam' ? 8000 : 2500)).length;
    let best = mid, bt = threat(mid);
    for (let k = 0; k < 6; k++) {
      const p = { x: (sx + o.x) / 2 + rng.float(-1500, 1500), y: Math.max(400, Math.min(g.world.H - 400, o.y + rng.float(-3500, 3500))) };
      const t = threat(p);
      if (t < bt) { bt = t; best = p; }
    }
    pts.push(best);
    // Заход с фланга: последняя точка сбоку от цели
    if (rng.chance(0.6)) pts.push({ x: o.x + (this.side === 'blue' ? -1 : 1) * rng.float(-1500, 800), y: o.y + (rng.chance(0.5) ? 1 : -1) * rng.float(1500, 3000) });
    return pts;
  }
}
