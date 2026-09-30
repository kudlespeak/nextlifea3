// ИИ режима «Война дронов»: строит ПВО вокруг ценных объектов, держит резерв на ремонт,
// разведывает позиции ПВО противника, выбивает их барражирующими боеприпасами и наносит
// массированные удары волнами (ложные цели + ударные), обходя известные зоны ПВО.

import { DW_AD, DW_DRONES, COMP, GTU } from './dronewar.js';
import { BUILD, upgradeCost } from './dwecon.js';
import { SALE } from './dwlogi.js';
import { PROJECTS, TECH } from './dwstate.js';

// Доктрины штаба: экономист копит и строит, ястреб бьёт, черепаха закапывается в оборону
const DOCTRINES = {
  economist: { name: 'экономист', roi: 0.5, off: 0.45, cover: 1, projects: ['agroholding', 'highway', 'powerbridge', 'technopark', 'airshield'], tech: ['economy', 'energy', 'military'] },
  hawk: { name: 'ястреб', roi: 1.0, off: 0.7, cover: 0.85, projects: ['technopark', 'airshield', 'highway', 'agroholding', 'powerbridge'], tech: ['military', 'economy', 'energy'] },
  turtle: { name: 'черепаха', roi: 0.7, off: 0.45, cover: 1.3, projects: ['airshield', 'powerbridge', 'agroholding', 'highway', 'technopark'], tech: ['energy', 'military', 'economy'] },
  balanced: { name: 'взвешенный', roi: 0.7, off: 0.55, cover: 1, projects: ['highway', 'airshield', 'agroholding', 'technopark', 'powerbridge'], tech: ['economy', 'military', 'energy'] },
};

const VALUE = { refinery: 7, railterm: 4, port: 4, coalmine: 4, cement: 3, decoy: 6, elevator: 5, solar: 3, bess: 3, pontoon: 3, reserve: 3, tpp: 14, ps330: 12, hpp: 10, chp: 8, ps110: 6, bridge: 5, oil: 5, ammo: 5, factory: 7, workshop: 5, launch: 5, hub: 5, wpp: 3, spp: 3 };
const WANT_COVER = { elevator: 1.5, tpp: 7, ps330: 6, hpp: 5, chp: 4, ps110: 3, factory: 3, workshop: 1.5, launch: 2.5, bridge: 1.5, oil: 2, ammo: 2, wpp: 1, spp: 1.5 };
const TARGET_COMPS = { refinery: ['tank', 'shop', 'dryer'], railterm: ['rack', 'hall'], port: ['rack', 'hall'], coalmine: ['headframe', 'shop'], cement: ['shop', 'silo'], decoy: ['tr', 'oru'], elevator: ['silo', 'dryer'], solar: ['pv', 'inv', 'oru'], bess: ['bess'], pontoon: ['pont'], reserve: ['hall', 'tank'], hpp: ['gsu', 'oru', 'hgen'], chp: ['unit', 'gsu', 'oru'], wpp: ['wt', 'gsu'], spp: ['pv', 'inv', 'oru'], tpp: ['gsu', 'unit', 'oru', 'coal'], ps330: ['at', 'oru'], ps110: ['tr', 'oru'], bridge: ['span'], oil: ['tank'], ammo: ['bunker'], factory: ['shop'], workshop: ['shop'], launch: ['launcher'], hub: ['hall'] };

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
    const dk = Object.keys(DOCTRINES);
    this.doctrine = DOCTRINES[dk[sim.rng.int(0, dk.length - 1)]];
    this.sent = {}; // сколько дронов отправлено по каждой цели
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
      if (inc > 0) { const o = this.doctrine.off; this.fund.def += inc * (1 - o); this.fund.off += inc * o; }
    }
    const pend = g.pendingCost(this.side);
    // Резерв на ремонт: не тратить последнее, пока энергосистема повреждена
    this.reserve = Math.min(300, 30 + pend.sum * 0.6); // на оборудование взамен уничтоженного
    // Копим на выгодную стройку: удары и новые позиции — только из того, что сверх цели
    if (this.goal && !this.finishing()) this.reserve += this.goal.cost * 0.8;
    if (t > this.next.plan) { this.next.plan = t + 30; this.plan(); this.govern(); }
    if (t > (this.next.prod ?? 0)) { this.next.prod = t + 12; this.produce(); }
    this.doGoal();
    this.defense();
    if (t > this.next.shelter) { this.next.shelter = t + 90; this.shelters(); }
    if (t > this.next.recon) { const few = g.objects.filter((o) => o.side === this.enemy && g.known(this.side, o)).length < 25; this.next.recon = t + (few ? 70 : 200) / this.k + this.sim.rng.float(0, 60); this.recon(); }
    if (!g.prep && t > this.next.loiter) { this.next.loiter = t + 70; this.loiter(); }
    if (!g.prep && t > (this.next.hunt ?? t + 150)) { this.next.hunt = t + 170 / this.k + this.sim.rng.float(0, 90); this.hunt(); }
    else if (this.next.hunt === undefined) this.next.hunt = t + 150;
    if (!g.prep && t > this.next.strike) {
      const hr = (this.sim.tod() / 3600) % 24, night = hr > 20 || hr < 5;
      // Эскалация: к третьей фазе удары вдвое чаще
      // Богатая казна — удары чаще (деньги копить незачем, когда стройки окупились)
      const rich = Math.min(2.5, 1 + Math.max(0, S.points - 800) / 2000);
      this.next.strike = t + ((night ? 200 : 300) / this.k + this.sim.rng.float(0, 120)) / (1 + (g.endless ? 0.25 : 0.5) * g.phase()) / Math.sqrt(rich);
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
    const put = (type, x, y) => { if (!g.res.adOk(this.side, type)) type = { icpt: 'mog', ewd: 'ew' }[type] || type; const c = g.adCost(this.side, type); if (!g.canPlace(this.side, type, x, y) && !g.placeAD(this.side, type, x, y)) this.pay('def', c); };
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
      want *= this.doctrine.cover;
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
    else if (S.points > 1200 && ['tpp', 'ps330', 'factory'].includes(worst.kind) && !g.ad.some((a) => !a.dead && a.side === this.side && a.type === 'ewd' && Math.hypot(a.x - worst.x, a.y - worst.y) < 3000)) type = 'ewd';
    if (spend() < g.adCost(this.side, type)) return;
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

  // ---------- Производство и исследования ----------
  // Держим запас каждого типа: не хватает — заказываем на заводе (платим сразу)
  produce() {
    const g = this.g, R = g.res, side = this.side, S = this.S, T = this.types();
    if (g.winner) return;
    const hawk = this.doctrine === DOCTRINES.hawk ? 1.5 : this.doctrine.off > 0.55 ? 1.25 : 1;
    const want = {};
    for (const d of T.strike) want[d.k] = (d.k === 'bober' ? 8 : d.k === 'geran3' || d.k === 'fp2' ? 4 : d.k === 'lyutyi' ? 6 : 16) * hawk;
    for (const d of T.decoy) want[d.k] = 14 * hawk;
    if (T.loiter) want[T.loiter.k] = 6;
    if (T.recon) want[T.recon.k] = 5;
    for (const [k, d] of Object.entries(DW_DRONES)) if (d.side === side && d.cls === 'hunter' && R.droneOk(side, k)) want[k] = 3;
    const list = Object.entries(want).map(([k, w]) => [k, w - R.stock(side, k) - R.queued(side, k)]).filter(([, gap]) => gap > 0).sort((a, b) => b[1] - a[1]);
    // минимальный запас ударных держим всегда (даже «экономист» не остаётся без дронов)
    const strikeStock = T.strike.reduce((q, d) => q + R.stock(side, d.k) + R.queued(side, d.k), 0);
    for (const [k, gap] of list) {
      const n = Math.min(4, Math.ceil(gap)), cost = g.droneCost(side, k) * n;
      const must = strikeStock < 8 && DW_DRONES[k].cls === 'strike' && S.points - cost >= (this.reserve ?? 30);
      if (!must && !this.can('off', cost)) break;
      if (!R.order(side, k, n)) this.pay('off', cost);
    }
  }
  research() {
    const g = this.g, R = g.res, side = this.side, S = this.S;
    if (R.side[side].cur) return;
    const order = ['loiter', 'sat', 'mass', 'energy', 'icpt', 'heavy', 'hunter', 'industry', 'export', 'robot', 'workshop', 'ewd', 'retail', 'reserve'];
    for (const id of order) {
      if (!R.available(side, id)) continue;
      if (S.points - R.cost(side, id) >= 40) R.start(side, id);
      return;
    }
  }

  // ---------- Разведка и удары ----------
  types() {
    const t = Object.entries(DW_DRONES).filter(([k, d]) => d.side === this.side && this.g.res.droneOk(this.side, k)).map(([k, d]) => ({ k, ...d }));
    return { strike: t.filter((d) => d.cls === 'strike'), decoy: t.filter((d) => d.cls === 'decoy'), loiter: t.find((d) => d.cls === 'loiter'), recon: t.find((d) => d.cls === 'recon') };
  }
  recon() {
    const g = this.g, T = this.types();
    if (!T.recon || g.res.stock(this.side, T.recon.k) < 1) return;
    const rng = this.sim.rng, W = g.world.W, H = g.world.H, C = 5000;
    // разведка по квадратам вражеской территории: сначала неразведанные, ближе к фронту
    this.scouted = this.scouted || new Set();
    let best = null, bs = -Infinity;
    for (let k = 0; k < 24; k++) {
      const x = this.side === 'blue' ? rng.float(g.frontX + 1500, W - 1500) : rng.float(1500, g.frontX - 1500), y = rng.float(1500, H - 1500);
      const key = `${Math.floor(x / C)},${Math.floor(y / C)}`;
      const s = (this.scouted.has(key) ? 0 : 10) - Math.abs(x - g.frontX) / 8000 + rng.float(0, 2);
      if (s > bs) { bs = s; best = [x, y, key]; }
    }
    if (best && !g.launch(this.side, T.recon.k, 1, best[0], best[1])) this.scouted.add(best[2]);
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
    if (tr && this.sim.rng.chance(0.5) && !g.drones.some((d) => !d.dead && d.vehTarget === tr.id) && g.res.stock(this.side, T.loiter.k) > 0) {
      g.launch(this.side, T.loiter.k, 1, tr.x, tr.y, { vehTarget: tr.id });
    }
    for (const a of known.slice(0, 2)) {
      if (g.drones.some((d) => !d.dead && d.adTarget === a.id)) continue;
      const n = a.type === 'sam' || a.type === 'radar' ? 2 : 1;
      if (g.res.stock(this.side, T.loiter.k) < 1) return;
      g.launch(this.side, T.loiter.k, n, a.x, a.y, { adTarget: a.id });
    }
  }
  // Охотники с ИИ — на дороги противника: у распредцентра, погранперехода, нефтебазы, АЗС
  hunt() {
    const g = this.g, rng = this.sim.rng;
    const types = Object.entries(DW_DRONES).filter(([k, d]) => d.side === this.side && d.cls === 'hunter' && g.res.droneOk(this.side, k) && g.res.stock(this.side, k) > 0);
    if (!types.length) return;
    const L = g.logi.side[this.enemy];
    const areas = [L.hub, L.border, L.oilDepot, ...L.fuels].filter((o) => o && g.known(this.side, o));
    if (!areas.length) return;
    const o = areas[rng.int(0, areas.length - 1)];
    const p = g.logi.gate(o);
    const front = types.find(([, d]) => d.front);
    const [k, D] = front && Math.abs(p[0] - g.frontX) < D_RANGE(front[1]) - 1500 && rng.chance(0.6) ? front : types.find(([, d]) => !d.front) || types[0];
    const n = D.cost < 10 ? 3 : 1 + (rng.chance(0.4) ? 1 : 0);
    g.launch(this.side, k, n, p[0] + rng.float(-800, 800), p[1] + rng.float(-800, 800));
  }
  strike() {
    const g = this.g, S = this.S, T = this.types(), rng = this.sim.rng;
    const budget = 1e9; // дроны оплачены при заказе: удар ограничен запасом и пусковыми
    // Ценность цели / известная защита
    const knownAD = g.ad.filter((a) => !a.dead && a.side === this.enemy && a.spotted[this.side]);
    let best = null, bs = -1;
    const dir = g.directive[this.side];
    for (const o of g.objs(this.enemy)) {
      if (!g.known(this.side, o)) continue; // бьём только по разведанному
      let v = VALUE[o.kind];
      if (v && dir && !dir.done && dir.oid === o.id) v *= 4; // директива штаба
      if (!v) continue;
      const ok = o.comps.filter((c) => TARGET_COMPS[o.kind]?.includes(c.k) && c.state === 'ok');
      if (!ok.length) continue;
      if (o.kind === 'bridge' && o.btype !== 'rail' && o.btype !== 'highway') continue;
      const def = knownAD.filter((a) => Math.hypot(a.x - o.x, a.y - o.y) < (a.type === 'sam' ? 9000 : 3000)).length;
      // память о потерях: по цели, где дроны массово сбивают, бьём реже
      const sent = this.sent[o.id] || 0, lost = g.lossLog?.[this.side]?.[o.id] || 0;
      const lossRate = sent >= 6 ? lost / sent : 0;
      const s = (v * (ok.length / o.comps.length + 0.5)) / (1 + def * 0.35) / (1 + lossRate * 1.5) * rng.float(0.7, 1.3);
      if (s > bs) { bs = s; best = o; }
    }
    if (!best) return;
    // Двухходовка: цель плотно прикрыта — сначала выбиваем ПВО барражирующими, удар — через 2–3 минуты
    const guards = knownAD.filter((a) => a.type !== 'acoustic' && Math.hypot(a.x - best.x, a.y - best.y) < (a.type === 'sam' ? 9000 : 3500));
    const t = this.sim.time;
    if (guards.length >= 2 && T.loiter && !(this.sead && this.sead.oid === best.id)) {
      const launchX = g.frontX + (this.side === 'blue' ? -1300 : 1300);
      let sent = 0;
      for (const a of guards.slice(0, 3)) {
        if (Math.abs(a.x - launchX) > T.loiter.range || g.drones.some((d) => !d.dead && d.adTarget === a.id)) continue;
        const n = a.type === 'sam' || a.type === 'radar' ? 2 : 1;
        if (g.res.stock(this.side, T.loiter.k) < 1) break;
        if (!g.launch(this.side, T.loiter.k, n, a.x, a.y, { adTarget: a.id })) sent++;
      }
      if (sent) { this.sead = { oid: best.id, until: t + 150 }; this.intent = `готовит удар по «${best.name}»: сначала подавляет ПВО`; this.next.strike = t + 150; return; }
    }
    if (this.sead && t < this.sead.until && this.sead.oid === best.id) return;
    const aims = best.comps.filter((c) => TARGET_COMPS[best.kind].includes(c.k) && c.state === 'ok');
    // Состав волны
    const heavy = best.kind === 'bridge' || best.kind === 'factory';
    let main = this.side === 'red'
      ? (heavy || rng.chance(0.15) ? T.strike.find((d) => d.k === 'geran3') : null) || T.strike.find((d) => d.k === 'shahed')
      : (heavy ? T.strike.find((d) => d.k === 'fp2') : rng.chance(0.5) ? T.strike.find((d) => d.k === 'lyutyi') : T.strike.find((d) => d.k === (best.kind === 'ps110' || best.kind === 'launch' ? 'bober' : 'fp1'))) || T.strike.find((d) => d.k === 'fp1');
    if (!main || g.res.stock(this.side, main.k) < 2) main = T.strike.filter((d) => d.k !== 'bober' && g.res.stock(this.side, d.k) >= 2).sort((a, b) => g.res.stock(this.side, b.k) - g.res.stock(this.side, a.k))[0];
    if (!main) return;
    const unit = g.droneCost(this.side, main.k);
    const rich = Math.min(3, 1 + Math.max(0, S.points - 800) / 1500);
    let n = Math.max(2, Math.min(Math.round(12 * this.k * rich), Math.floor((budget * 0.8) / unit)));
    if (n * unit > budget) n = Math.floor(budget / unit);
    // Пропускная способность стартовых позиций: 300 дронов разом не поднять
    const free = g.econ.launchFree(this.side);
    if (free < 4) { this.launchShort++; return; }
    n = Math.min(n, Math.max(2, Math.floor(free * 0.55)), g.res.stock(this.side, main.k));
    if (n < 2) return;
    let slots = free - n;
    const route = this.route(best, knownAD);
    this.sent[best.id] = (this.sent[best.id] || 0) + n;
    // Ложные цели идут первыми, чтобы вскрыть и отвлечь ПВО (у Велнарии — рой дешёвых «Бобров»)
    if (!T.decoy.length && main.k !== 'bober') {
      const bob = T.strike.find((d) => d.k === 'bober');
      const nb = Math.min(Math.ceil(n / 2), 8, slots, Math.floor((budget - n * unit) / g.droneCost(this.side, 'bober')));
      if (bob && nb > 1 && rng.chance(0.5)) {
        slots -= nb;
        const c = aims[rng.int(0, aims.length - 1)];
        g.launch(this.side, 'bober', nb, c.x, c.y, { route, oid: best.id, cid: c.id });
      }
    }
    if (T.decoy.length) {
      const dec = T.decoy[0];
      const nd = Math.min(Math.round(n * 1.2), slots, Math.floor((budget - n * unit) / g.droneCost(this.side, dec.k)));
      if (nd > 0) g.launch(this.side, dec.k, nd, best.x + rng.float(-300, 300), best.y + rng.float(-300, 300), { route, oid: best.id });
    }
    // Ударные — по отдельным узлам
    let left = n;
    let i = 0;
    while (left > 0) {
      const c = aims[i % aims.length];
      const k = Math.min(left, Math.max(1, Math.ceil(n / aims.length)));
      g.launch(this.side, main.k, k, c.x, c.y, { route, oid: best.id, cid: c.id });
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
      if (SALE[o.kind]) gain = o.stock > 0 ? (0.4 * SALE[o.kind].value * (60 / SALE[o.kind].every) * K) / logi.crowd(o) : 0;
      else if (o.kind === 'hub') gain = o.stock >= 0.8 * g.logi.hubCap(o) ? 0.08 * ((I.trade || 0) + (I.fuel || 0)) : 0; // склад забит — нужен больше
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
      const rival = L.markets.filter((m) => m.kind !== 'store' && Math.hypot(m.x - (p?.[0] ?? 0), m.y - (p?.[1] ?? 0)) < 3000).length;
      if (p) out.push({ act: 'build', kind, x: p[0], y: p[1], cost: BUILD[kind].cost, gain: (kind === 'mall' ? 5 : 4) * (60 / SALE[kind].every) * K * 0.85 / (1 + 0.3 * rival) + 0.4, name: `${BUILD[kind].name} у города ${c.name}` });
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
      // выручка АЗС ограничена подвозом: чем больше заправок, тем меньше каждой достаётся бензовозов
      if (best && bd > 5000) { const p = this.spot('fuel', best[0], best[1], 60, 350); if (p) out.push({ act: 'build', kind: 'fuel', x: p[0], y: p[1], cost: BUILD.fuel.cost, gain: SALE.fuel.value * (60 / SALE.fuel.every) * K * 0.8 * Math.min(1, 10 / Math.max(1, L.fuels.length)), name: 'АЗС на трассе' }); }
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
    // ----- развитие страны -----
    const add = (kind, ax, ay, r0, r1, gain, name) => { if (gain <= 0 || S.points < 0) return; const p = this.spot(kind, ax, ay, r0, r1); if (p) out.push({ act: 'build', kind, x: p[0], y: p[1], cost: BUILD[kind].cost, gain, name }); };
    const have = (kind) => g.objs(side, kind).length;
    const labor = E.labor(side), tax = I.tax || 0, ind = I.industry || 0;
    const city = cities[rng.int(0, cities.length - 1)];
    if (city) {
      if (sum.happy > 0.8 && have('housing') < 6) add('housing', city.x, city.y, 1200, 3500, 2.4 * K * sum.happy * labor + 0.6, `жилой квартал у города ${city.name}`);
      if (have('hospital') < cities.length && !g.objs(side, 'hospital').some((o) => Math.hypot(o.x - city.x, o.y - city.y) < 6000)) add('hospital', city.x, city.y, 800, 3000, 0.04 * tax + (sum.happy < 0.8 ? 2 : 0.6), `больница в городе ${city.name}`);
      if (labor < 0.95 && have('school') < 4) add('school', city.x, city.y, 800, 3000, (1 - labor) * 0.6 * (ind + tax) + 0.5, `школа и колледж в городе ${city.name}`);
    }
    if (sum.elevGrain > 4000 && have('mill') < 3) { const e = g.objs(side, 'elevator').sort((a, b) => (b.grain || 0) - (a.grain || 0))[0]; if (e) add('mill', e.x, e.y, 800, 4000, 3.5 * K, `мелькомбинат у элеватора «${e.name}»`); }
    { const vs = g.world.settlements.filter((q) => q.side === side && q.type === 'village' && !g.objs(side, 'dairy').some((o) => Math.hypot(o.x - q.x, o.y - q.y) < 5000)); const v = vs[rng.int(0, Math.max(0, vs.length - 1))]; if (v && have('dairy') < 6) add('dairy', v.x, v.y, 400, 2000, 1.4 * K, `молочная ферма у села ${v.name}`); }
    if (have('solar') < 5) { const ps = g.objs(side, 'ps110')[rng.int(0, g.objs(side, 'ps110').length - 1)]; if (ps) add('solar', ps.x, ps.y, 1000, 3500, S.supply < 0.97 ? (1 - S.supply) * (ind + tax) * 0.6 + 1.5 : 0.8, 'солнечная станция'); }
    { const ps = g.objs(side, 'ps110').find((q) => (q.shed || 0) > 0 && !g.objs(side, 'bess').some((o) => o.ps === q.id || Math.hypot(o.x - q.x, o.y - q.y) < 1500)); if (ps) add('bess', ps.x, ps.y, 300, 1300, 2.5, `накопитель энергии у ${ps.name}`); }
    { const br = g.objs(side, 'bridge').find((b) => b.btype !== 'rail' && g.bridgeCap(b) === 0 && !g.objects.some((o) => o.kind === 'pontoon' && o.bridge === b.id)); if (br) { const s0 = E.siteFor(side, 'pontoon', br.x, br.y); if (!s0.err) out.push({ act: 'build', kind: 'pontoon', x: br.x, y: br.y, cost: BUILD.pontoon.cost, gain: 5, name: `понтонная переправа у моста «${br.name.replace(/^Мост через /, '')}»` }); } }
    if ((sum.farmGrain > 12000 || this.S.stats.lostAD > 6) && have('autopark') < 3) { const c = cities[0]; if (c) add('autopark', c.x, c.y, 1500, 4000, 2, 'автобаза'); }
    if (S.spare === 0 && have('reserve') < 2) { const c = cities[rng.int(0, cities.length - 1)]; if (c) add('reserve', c.x, c.y, 2000, 5000, 3, 'склад госрезерва'); }
    // ----- ресурсы, вода, экспорт по железной дороге и реке -----
    const IF = g.infra;
    if (!have('refinery')) add('refinery', cities[0]?.x ?? 0, cities[0]?.y ?? 0, 3000, 7000, 5 + 0.2 * (I.fuel || 0), 'НПЗ');
    if (!have('coalmine')) add('coalmine', cities[0]?.x ?? 0, cities[0]?.y ?? 0, 4000, 9000, 0.1 * (ind + tax) + 2, 'угольная шахта');
    if (!have('cement')) add('cement', cities[0]?.x ?? 0, cities[0]?.y ?? 0, 2500, 6000, 5, 'цементный завод');
    for (const c of cities) if (c.water === false && !g.objs(side, 'watertower').some((o) => Math.hypot(o.x - c.x, o.y - c.y) < 4000)) add('watertower', c.x, c.y, 800, 3000, 4, `водонапорная станция в городе ${c.name}`);
    if (!have('railterm') && sum.elevGrain > 8000) {
      const el = g.objs(side, 'elevator').sort((a, b) => (b.grain || 0) - (a.grain || 0))[0];
      if (el) { const pts = g.world.rails.items.filter((r) => !r.siding).flatMap((r) => r.line); const rp = pts.reduce((a, q) => (Math.hypot(q[0] - el.x, q[1] - el.y) < Math.hypot(a[0] - el.x, a[1] - el.y) ? q : a), pts[0]); if (rp && Math.hypot(rp[0] - el.x, rp[1] - el.y) < 4500) add('railterm', rp[0], rp[1], 60, 400, 0.4 * (I.agro || 0) + 4, 'ж/д терминал для экспорта зерна'); }
    }
    if (!have('port') && sum.elevGrain > 12000) {
      const rv = g.world.water.items.find((r) => r.kind === 'river' && E.territoryOk(side, r.line[0][0]));
      const el = g.objs(side, 'elevator')[0];
      if (rv && el) { const rp = rv.line.reduce((a, q) => (Math.hypot(q[0] - el.x, q[1] - el.y) < Math.hypot(a[0] - el.x, a[1] - el.y) ? q : a)); if (Math.hypot(rp[0] - el.x, rp[1] - el.y) < 5500) add('port', rp[0], rp[1], 80, 320, 0.3 * (I.agro || 0) + 3, 'речной порт для экспорта зерна'); }
    }
    void IF;
    // Макеты подстанций — когда противник бьёт по нашим ПС 110
    if (have('decoy') < 3 && g.objs(side, 'ps110').some((q) => q.comps.some((c) => c.state !== 'ok'))) { const ps = g.objs(side, 'ps110')[rng.int(0, g.objs(side, 'ps110').length - 1)]; add('decoy', ps.x, ps.y, 1500, 4000, 2.2, 'макет подстанции'); }
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
    if (best && br >= this.doctrine.roi) { this.goal = { ...best, roi: br, t0: this.sim.time }; this.intent = `копит на: ${best.name} (${best.cost} оч., окупится за ~${Math.round(best.cost / best.gain)} мин)`; }
    else this.intent = 'вкладывает в удары и оборону';
  }
  // Законы, мобилизация, нацпроекты, НИОКР, контракты и кредиты
  govern() {
    const g = this.g, S = this.S, side = this.side, St = g.state, T = St.side[side], D = this.doctrine;
    const mor = S.morale ?? 100, sum = g.econ.summary(side);
    const law = (id, on) => { if (!!T.laws[id] !== on && !St.cooldown(T)) St.setLaw(side, id, on); };
    this.research();
    // новые объекты — сразу к сети (без подключения они не работают)
    for (const o of g.objs(side)) {
      if (!g.econ.needsGrid(o) || o.grid) continue;
      const q = g.econ.gridCheck(side, o.id);
      if (!q.err && S.points - q.cost >= 20) g.econ.gridConnect(side, o.id);
    }
    law('martial', mor < 45);
    law('fund', g.pendingCost(side).sum > 300 || T.laws.fund && g.pendingCost(side).sum > 120);
    law('curfew', this.settlementsFear() > 0.35);
    if (!St.cooldown(T)) {
      const tax = S.points < 150 && mor > 70 ? 2 : sum.happy < 0.7 ? 0 : 1;
      if (tax !== T.tax) St.setTax(side, tax);
      else {
        const mob = mor < 40 ? 2 : (this.launchShort >= 3 || D === DOCTRINES.hawk) && mor < 80 ? 1 : 0;
        if (mob !== T.mobil) St.setMobil(side, mob);
      }
    }
    if (!T.project && !this.goal) for (const id of D.projects) {
      if (T.projects.includes(id)) continue;
      const cost = PROJECTS[id].cost * St.k(side, 'build');
      if (id === 'powerbridge' && S.supply > 0.95 && D !== DOCTRINES.turtle) continue;
      if (S.points > cost * 1.3 + this.reserve) St.startProject(side, id);
      break;
    }
    if (!T.research && S.points > 800 + this.reserve) for (const b of D.tech) { const L = TECH[b].levels[T.tech[b]]; if (!L) continue; if (S.points > L.cost + 500) St.startResearch(side, b); break; }
    for (const c of T.contracts) {
      if (c.state !== 'offer') continue;
      if (c.kind === 'grain' && sum.elevGrain + sum.farmGrain >= c.need * 0.7) St.acceptContract(side, c.id);
      if (c.kind === 'power' && S.gen > S.demand * 1.1) St.acceptContract(side, c.id);
      if (c.kind === 'arms' && S.points > c.price * 2.5 && g.ad.filter((a) => !a.dead && a.side === side && a.type === 'sam').length < 3) St.acceptContract(side, c.id);
    }
    if (mor < 40 && S.points < 100 && !T.debts.some((d) => d.kind === 'credit')) St.takeCredit(side, 'credit');
    // Области: губернаторы со специализацией (раз в начале, дальше — по обстановке)
    const IF = g.infra, EI = IF.side[side];
    IF.cities(side).forEach((c, i) => {
      if (EI.spec[i] || S.points < 300) return;
      const want = i === 0 ? (D === DOCTRINES.economist ? 'trade' : 'industry') : D === DOCTRINES.turtle ? 'energy' : 'agro';
      IF.setRegion(side, i, want);
    });
    // Резервная ЛЭП к подстанции, у которой одна линия питания
    if (S.points > 1200 + this.reserve && !IF.newLines.some((q) => q.side === side)) {
      const ends = IF.lineEnds(side);
      for (const ps of g.objs(side, 'ps110')) {
        const deg = g.lines.filter((l) => l.side === side && (l.a === ps.id || l.b === ps.id)).length;
        if (deg > 1) continue;
        const other = ends.filter((o) => o !== ps && (o.kind === 'ps110' || o.kind === 'ps330') && !IF.lineCheck(side, ps.id, o.id).err).sort((a, b) => Math.hypot(a.x - ps.x, a.y - ps.y) - Math.hypot(b.x - ps.x, b.y - ps.y))[0];
        if (other) { IF.buildLine(side, ps.id, other.id); break; }
      }
    }
    // Завод разбит и стоит близко к фронту — эвакуация вглубь тыла
    const fac = g.objs(side, 'factory')[0];
    if (fac && !fac.build && fac.comps.filter((c) => c.k === 'shop' && c.state === 'destroyed').length >= 2 && S.points > 700) {
      const rx = side === 'blue' ? 3000 : g.world.W - 3000;
      for (let k = 0; k < 30; k++) { const x = rx + (side === 'blue' ? 1 : -1) * k * 150, y = 4000 + ((k * 2300) % (g.world.H - 8000)); if (!IF.evacCheck(side, fac.id, x, y).err) { IF.evacuate(side, fac.id, x, y); break; } }
    }
    if (mor > 80 && this.goal && S.points < this.goal.cost * 0.5 && this.goal.roi > 1.2 && !T.debts.some((d) => d.kind === 'bonds')) St.takeCredit(side, 'bonds');
  }
  settlementsFear() { const ss = this.g.world.settlements.filter((q) => q.side === this.side && q.type === 'city'); return ss.reduce((a, q) => a + q.fear, 0) / Math.max(1, ss.length); }
  doGoal() {
    const G = this.goal, g = this.g, S = this.S;
    if (!G) return;
    if (S.points - (this.reserve - G.cost * 0.8) < G.cost) return;
    const err = G.act === 'upgrade' ? g.upgrade(this.side, G.id) : g.buildCivil(this.side, G.kind, G.x, G.y);
    if (!err) { const o = this.doctrine.off; this.fund.def = Math.max(0, this.fund.def - G.cost * (1 - o)); this.fund.off = Math.max(0, this.fund.off - G.cost * o); if (G.kind === 'launch') this.launchShort = 0; }
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
