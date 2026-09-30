// Отрисовка режима «Война дронов»: объекты инфраструктуры в 3D (по состоянию узлов), пожары,
// пар градирен и дым труб, ПВО с поворотными башнями, дроны на высоте с тенью на земле,
// трассеры, ракеты, прожекторы, разрывы в воздухе; на обзорном масштабе — значки и подписи.

import { spriteFor, drawSprite, K3 } from './mesh3d.js';
import { buildComp, buildAD, buildDrone, buildVehicle } from './dwmodels.js';
import { MODELS } from './models.js';
import { DW_DRONES, DW_AD, KIND_NAME } from '../sim/dronewar.js';
import { daylight } from '../power.js';
import { FACTIONS } from '../sim/factions.js';
import { CivTraffic } from './dwtraffic.js';

const SIDE_COL = { blue: '#6fa6ff', red: '#ff7d72' };
const ST_COL = { ok: '#7ddc6a', damaged: '#f0c34a', destroyed: '#ef5a4a' };
const GLYPH = { tpp: 'ТЭС', ps330: '330', ps110: '110', bridge: 'М', oil: 'НБ', ammo: 'АР', factory: 'ЗД', launch: 'СП', hub: 'РЦ', decoy: 'МКТ', refinery: 'НПЗ', watertower: 'ВОД', railterm: 'ЖДТ', port: 'ПОРТ', coalmine: 'ШХ', cement: 'ЦЗ', elevator: 'ЭЛ', agro: 'МД', housing: 'ЖК', hospital: 'БЛ', school: 'ШК', mill: 'МК', dairy: 'МФ', solar: 'СЭС', bess: 'АКБ', pontoon: 'ПН', autopark: 'АБ', reserve: 'ГР', border: 'ПП', mall: 'ТЦ', market: 'СМ', store: 'маг', firest: 'ПЧ', rembase: 'РБ', fuel: 'АЗС', hpp: 'ГЭС', chp: 'ТЭЦ', wpp: 'ВЭС', spp: 'СЭС' };
const VEH_COL = { fura: '#e8e2cc', van: '#cfd8e0', tanker: '#f0d060', grain: '#d8b85a', grainx: '#e0c060', supply: null, crew: '#ff9a3a', fire: '#ff4a3a' };
const AD_GLYPH = { mog: 'МОГ', spaag: 'ЗСУ', sam: 'ЗРК', ew: 'РЭБ', ewd: 'КРЭБ', acoustic: 'АП', radar: 'РЛС', icpt: 'ПХ' };

// Высота на экране: логарифмически сжата, иначе дрон на 2 км «улетал» бы от своей точки
export const dispH = (alt) => (alt <= 0 ? 0 : 12 + Math.min(alt, 3000) / 3000 * 110);

// Экспортные поезда (локомотив и вагоны-зерновозы вдоль пути) и баржи с буксиром; стройки дорог и ЛЭП
function drawInfra(ctx, g, side, toS, inView, z, now, dpr, t) {
  const I = g.infra;
  for (const sh of I.ships) {
    const head = I.posOf(sh);
    if (!inView(head.x, head.y, 600)) continue;
    const train = sh.kind === 'train';
    const n = train ? 14 : 2, len = train ? 15 : 60, gap = train ? 1.5 : 6;
    for (let k = 0; k < n; k++) {
      const p = I.posOf(sh, Math.max(0, sh.s - k * (len + gap)));
      const [sx, sy] = toS(p.x, p.y);
      const w = Math.max(train ? 1.2 * dpr : 2 * dpr, (train ? 3.2 : 11) * z), L = Math.max(2 * dpr, len * z);
      ctx.save(); ctx.translate(sx, sy); ctx.rotate(p.h);
      ctx.fillStyle = k === 0 ? (train ? '#3a4a5a' : '#6a5a3a') : train ? '#a8905a' : '#7d6b4a';
      ctx.fillRect(-L, -w / 2, L, w);
      if (!train && k > 0 && z > 0.3) { ctx.fillStyle = '#d6b95e'; ctx.fillRect(-L * 0.92, -w * 0.35, L * 0.84, w * 0.7); } // зерно в трюме
      ctx.restore();
    }
    if (sh.wait) { const [sx, sy] = toS(head.x, head.y); ctx.fillStyle = '#ff5a4a'; ctx.font = `${Math.round(11 * dpr)}px sans-serif`; ctx.fillText('⛔', sx + 6 * dpr, sy - 6 * dpr); }
  }
  for (const p of I.paving) {
    if (p.side !== side || !inView(p.x, p.y, 50)) continue;
    const [sx, sy] = toS(p.x, p.y);
    ring(ctx, sx, sy - 12 * dpr, 8 * dpr, 1 - (p.until - t) / p.total, '#ffd36b', dpr);
    ctx.fillStyle = '#e0b030'; ctx.fillRect(sx - 3 * dpr, sy - 3 * dpr, 6 * dpr, 6 * dpr); // каток
  }
  ctx.save(); ctx.setLineDash([8 * dpr, 6 * dpr]); ctx.strokeStyle = 'rgba(255,211,107,0.8)'; ctx.lineWidth = 1.5 * dpr;
  for (const d of I.newLines) { if (d.side !== side || !d.pylons) continue; ctx.beginPath(); d.pylons.forEach((p, i) => { const [sx, sy] = toS(p.x, p.y); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); }); ctx.stroke(); }
  ctx.restore();
  void now;
}

// Потоки экономики своей стороны: зерно (ток → элеватор → граница), солярка (нефтебаза → мехдворы),
// товары (склады → магазины). Толщина — объём.
function drawFlows(ctx, g, side, toS, z, dpr) {
  const E = g.econ, L = g.logi.side[side];
  const arrow = (a, b, w, col, dash) => {
    const [x0, y0] = toS(a[0], a[1]), [x1, y1] = toS(b[0], b[1]);
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, w) * dpr; ctx.setLineDash(dash ? [6 * dpr, 5 * dpr] : []);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    const an = Math.atan2(y1 - y0, x1 - x0), mx = (x0 + x1) / 2, my = (y0 + y1) / 2, s = 6 * dpr;
    ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(mx + Math.cos(an) * s, my + Math.sin(an) * s); ctx.lineTo(mx + Math.cos(an + 2.5) * s, my + Math.sin(an + 2.5) * s); ctx.lineTo(mx + Math.cos(an - 2.5) * s, my + Math.sin(an - 2.5) * s); ctx.closePath(); ctx.fillStyle = col; ctx.fill();
  };
  const els = E.elevators(side);
  ctx.save(); ctx.globalAlpha = 0.8;
  for (const f of E.farms) {
    if (f.side !== side || f.grain < 300) continue;
    const e = els.slice().sort((a, b) => Math.hypot(a.x - f.x, a.y - f.y) - Math.hypot(b.x - f.x, b.y - f.y))[0];
    if (e) arrow([f.x, f.y], [e.x, e.y], 1 + f.grain / 2500, 'rgba(230,190,70,0.85)');
  }
  for (const e of els) if ((e.grain || 0) > 1000) arrow([e.x, e.y], [L.border.x, L.border.y], 1.5 + e.grain / 8000, 'rgba(255,215,90,0.9)');
  if (L.oilDepot) for (const f of E.farms) if (f.side === side && f.tank < 6) arrow([L.oilDepot.x, L.oilDepot.y], [f.x, f.y], 1, 'rgba(240,120,60,0.7)', true);
  const hubs = g.objs(side, 'hub');
  for (const m of L.markets) if (m.stock < 2) { const h = hubs.slice().sort((a, b) => Math.hypot(a.x - m.x, a.y - m.y) - Math.hypot(b.x - m.x, b.y - m.y))[0]; if (h) arrow([h.x, h.y], [m.x, m.y], 1, 'rgba(140,200,255,0.7)', true); }
  ctx.restore();
  void z;
}

// Стройка: бетонные основания узлов, башенный кран, кольцо готовности
function construction(ctx, o, toS, z, dpr, k) {
  for (const c of o.comps) {
    const cs = Math.cos(c.angle), sn = Math.sin(c.angle);
    ctx.fillStyle = k < 0.35 ? 'rgba(110,98,78,0.85)' : 'rgba(150,148,140,0.9)';
    ctx.beginPath();
    for (const [u, v] of [[-c.w / 2, -c.h / 2], [c.w / 2, -c.h / 2], [c.w / 2, c.h / 2], [-c.w / 2, c.h / 2]]) { const [px, py] = toS(c.x + u * cs - v * sn, c.y + u * sn + v * cs); ctx.lineTo(px, py); }
    ctx.closePath(); ctx.fill();
    if (k > 0.35 && z > 0.5) { ctx.strokeStyle = 'rgba(90,88,82,0.9)'; ctx.lineWidth = Math.max(1, 0.4 * z); ctx.stroke(); }
  }
  const [sx, sy] = toS(o.x, o.y);
  if (z > 0.4) {
    // кран: мачта и стрела
    const hgt = 30 * z * 0.5;
    ctx.strokeStyle = '#e0b030'; ctx.lineWidth = Math.max(1.5, 0.8 * z);
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx, sy - hgt); ctx.lineTo(sx + 22 * z * 0.5, sy - hgt); ctx.moveTo(sx, sy - hgt); ctx.lineTo(sx - 8 * z * 0.5, sy - hgt); ctx.stroke();
  }
  ring(ctx, sx, sy - 14 * dpr, 9 * dpr, Math.max(0, Math.min(1, k)), '#ffd36b', dpr);
}

// Тракторы (посевная) и комбайны (уборка) ходят челноком по текущему полю агрофирмы
function drawFarmWork(ctx, g, world, toS, inView, z, now, dpr) {
  const E = g.econ;
  for (const f of E.farms) {
    if (!f.work || f.noFuel) continue;
    const fd = f.fields[f.work.fi];
    if (!fd || !inView(fd.x, fd.y, 900)) continue;
    const fl = world.fields.items[fd.i];
    if (!fl?.poly || fl.poly.length < 3) continue;
    // рамка поля по направлению борозд (поля вдоль дорог — многоугольники со многими вершинами)
    if (!fd._fr) {
      const a = fl.angle || 0, cu = Math.cos(a), su = Math.sin(a);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const [x, y] of fl.poly) { const u = x * cu + y * su, v = -x * su + y * cu; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
      const m = 6; // не заезжаем на межу
      u0 += m; u1 -= m; v0 += m; v1 -= m;
      fd._fr = { p0: [u0 * cu - v0 * su, u0 * su + v0 * cu], ux: (u1 - u0) * cu, uy: (u1 - u0) * su, vx: -(v1 - v0) * su, vy: (v1 - v0) * cu };
    }
    const { p0, ux, uy, vx, vy } = fd._fr;
    const Lu = Math.hypot(ux, uy), Lv = Math.hypot(vx, vy);
    if (Lu < 20 || Lv < 20) continue;
    const combine = f.work.kind === 'combine';
    const mc = E.machines ? E.machines(f) : { tractors: 1, combines: 1 };
    const n = Math.min(3, combine ? mc.combines : mc.tractors);
    const P = Math.max(4, Math.round(Lv / (combine ? 9 : 12))); // проходы: ширина жатки / сеялки
    // уже пройденная часть поля: убранная (стерня) или засеянная (боронованная) полоса
    if (z > 0.08) {
      const done = Math.min(1, Math.max(0, f.work.prog));
      ctx.save();
      ctx.beginPath(); fl.poly.forEach(([x, y], i) => { const [px, py] = toS(x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }); ctx.closePath(); ctx.clip();
      ctx.fillStyle = combine ? 'rgba(196,178,120,0.92)' : 'rgba(133,112,90,0.9)';
      ctx.beginPath();
      for (const [a, b] of [[0, 0], [1, 0], [1, done], [0, done]]) { const [px, py] = toS(p0[0] + ux * a + vx * b, p0[1] + uy * a + vy * b); ctx.lineTo(px, py); }
      ctx.closePath(); ctx.fill();
      if (z > 0.25) {
        // рядки валков/сеялки вдоль прохода
        ctx.strokeStyle = combine ? 'rgba(140,120,70,0.3)' : 'rgba(60,45,30,0.3)';
        ctx.lineWidth = Math.max(0.5, 0.6 * z);
        ctx.beginPath();
        const rows = Math.min(400, Math.floor(done * P));
        for (let k = 0; k <= rows; k++) { const b = k / P; const [ax, ay] = toS(p0[0] + vx * b, p0[1] + vy * b), [bx, by] = toS(p0[0] + ux + vx * b, p0[1] + uy + vy * b); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); }
        ctx.stroke();
      }
      ctx.restore();
    }
    for (let m = 0; m < n; m++) {
      // машины идут друг за другом со сдвигом по проходам
      const prog = Math.min(0.999, Math.max(0, f.work.prog + (m - (n - 1) / 2) * 0.05 + ((now / 1000) % 60) * 0.0004));
      const sPath = prog * P * Lu, pass = Math.floor(sPath / Lu), a = sPath - pass * Lu;
      const fwd = pass % 2 === 0;
      const tu = (fwd ? a : Lu - a) / Lu, tv = (pass + 0.5) / P;
      const x = p0[0] + ux * tu + vx * tv, y = p0[1] + uy * tu + vy * tv;
      const [sx, sy] = toS(x, y);
      const heading = Math.atan2(uy, ux) + (fwd ? 0 : Math.PI);
      if (combine && z > 0.25) {
        ctx.fillStyle = 'rgba(190,170,120,0.28)';
        ctx.beginPath(); ctx.ellipse(sx - Math.cos(heading) * 9 * z, sy - Math.sin(heading) * 9 * z, Math.max(3, 9 * z), Math.max(2, 5 * z), heading, 0, Math.PI * 2); ctx.fill();
      }
      if (z >= 0.45) {
        const r = spriteFor(`dwv:${combine ? 'combine' : 'tractor'}:${f.side}`, () => buildVehicle(combine ? 'combine' : 'tractor', f.side, 0), heading, z, undefined, now);
        if (r) drawSprite(ctx, r, sx, sy, z, r.residual);
      } else {
        ctx.fillStyle = combine ? '#9ccf4a' : '#e0c050';
        ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = dpr;
        ctx.beginPath(); ctx.arc(sx, sy, 3.2 * dpr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
  }
}

function hash(i) { const s = Math.sin(i * 127.1) * 43758.5453; return s - Math.floor(s); }

export function drawDW(ctx, sim, view, side, ui) {
  const g = sim.game;
  if (!g || g.mode !== 'drones') return;
  const { cam, canvas, dpr } = view;
  const z = cam.zoom;
  const W = canvas.width, H = canvas.height;
  const toS = (x, y) => [(x - cam.x) * z + W / 2, (y - cam.y) * z + H / 2];
  const now = performance.now();
  const t = sim.time;
  const night = 1 - daylight(t);
  const inView = (x, y, r) => { const [sx, sy] = toS(x, y); return sx > -r * z - 200 && sy > -r * z - 300 && sx < W + r * z + 200 && sy < H + r * z + 200; };
  const up = (alt) => Math.min(90 * dpr, dispH(alt) * K3 * Math.max(z, 0.35)); // смещение вверх в пикселях
  const detail = z >= 0.3;

  // ---------- Объекты ----------
  for (const o of g.objects) {
    if (o.kind === 'import' || !inView(o.x, o.y, Math.max(o.w, o.h)) || !g.known(side, o)) continue;
    if (o.build && !o.build.up && !o.build.grid) { construction(ctx, o, toS, z, dpr, 1 - (o.build.until - t) / o.build.total); continue; }
    // крупные объекты (ТЭС, ГЭС, подстанции) видны в объёме и издали — пока на экране больше ~60 px
    if (detail || Math.max(o.w, o.h) * z > 60 * dpr) {
      // Сначала дальние узлы (по y экрана), чтобы высокие не перекрывались неверно
      const comps = [...o.comps].sort((a, b) => a.y - b.y);
      for (const c of comps) {
        if (!inView(c.x, c.y, Math.max(c.w, c.h) + 40)) continue;
        const [sx, sy] = toS(c.x, c.y);
        if (c.k === 'span') { drawSpan(ctx, c, sx, sy, z, o); continue; }
        const st = c.state;
        const key = `dwc:${c.k}:${st}:${Math.round(c.w)}x${Math.round(c.h)}:${c.shelter}:${o.side}`;
        const big = c.w > 40 || c.k === 'chimney' || c.k === 'tower' || c.k === 'wt';
        const r = spriteFor(key, () => buildComp(c.k, c.w, c.h, st, c.shelter, o.side), c.angle, z, { maxLod: big ? 7 : 14, shadowAlpha: 0.4 }, now);
        if (r) drawSprite(ctx, r, sx, sy, z, r.residual);
        if (c.k === 'wt' && st !== 'destroyed') rotor(ctx, sx, sy, z, now, g.wind ?? 0.6, c, st === 'damaged', dpr);
        // Выжженная земля и разлитое масло под сгоревшим трансформатором
        if (c.burned || st === 'destroyed') {
          ctx.fillStyle = 'rgba(20,16,12,0.35)';
          ctx.beginPath(); ctx.ellipse(sx, sy, (c.w * 0.8 + 4) * z, (c.h * 0.8 + 4) * z, c.angle, 0, Math.PI * 2); ctx.fill();
        }
      }
      // Пар градирен и дым труб — пока блоки работают
      const units = o.comps.filter((c) => c.k === 'unit' && c.state === 'ok').length;
      if (o.kind === 'tpp' && units) {
        for (const c of o.comps) {
          if (c.k === 'tower' && c.state === 'ok') plume(ctx, toS, c.x, c.y, 76, z, now, 'steam', units / 3, c.x * 3);
          if (c.k === 'chimney' && c.state === 'ok') plume(ctx, toS, c.x, c.y, 120, z, now, 'smoke', units / 3, c.y * 3);
        }
      }
    }
    // Пожары: пламя у основания, столб дыма, уносимый ветром
    for (const c of o.comps) {
      if (c.fire <= 0 || !inView(c.x, c.y, 200)) continue;
      const size = c.k === 'tank' ? 14 : c.k === 'unit' || c.k === 'shop' ? 20 : c.k === 'bunker' ? 10 : 6;
      fire(ctx, toS, c.x, c.y, size, z, now, c.k === 'tank' || c.k === 'coal', hash(c.x + c.y));
    }
  }

  // ---------- Поезда и баржи с зерном, дорожники, строящиеся ЛЭП ----------
  if (g.infra) drawInfra(ctx, g, side, toS, inView, z, now, dpr, t);

  // ---------- Слой экономических потоков ----------
  if (ui?.showFlows && g.econ) drawFlows(ctx, g, side, toS, z, dpr);

  // ---------- Сельхозтехника на полях ----------
  if (g.econ && z >= 0.12) drawFarmWork(ctx, g, sim.world, toS, inView, z, now, dpr);

  // ---------- Разбитые ТП (подложка карты статична — повреждение рисуем поверх) ----------
  if (z > 0.3) for (const tp of sim.world.power?.tps || []) {
    if (tp.alive || !inView(tp.x, tp.y, 10)) continue;
    const [sx, sy] = toS(tp.x, tp.y);
    ctx.fillStyle = 'rgba(22,18,14,0.85)';
    ctx.beginPath(); ctx.ellipse(sx, sy, Math.max(3, 3.2 * z), Math.max(2, 2.4 * z), 0, 0, Math.PI * 2); ctx.fill();
    if (z > 1) { ctx.fillStyle = `rgba(255,${150 + Math.floor(Math.sin(now / 90) * 60)},60,0.8)`; ctx.fillRect(sx - 0.6 * z, sy - 0.6 * z, 1.2 * z, 1.2 * z); } // искрит
  }

  // ---------- Мобильные ГТУ ----------
  for (const gt of g.gens || []) {
    if (gt.side !== side || !inView(gt.x, gt.y, 20)) continue;
    const [sx, sy] = toS(gt.x, gt.y);
    if (gt.dead) { ctx.fillStyle = 'rgba(25,20,16,0.85)'; ctx.beginPath(); ctx.ellipse(sx, sy, Math.max(3 * dpr, 9 * z), Math.max(2 * dpr, 3 * z), gt.angle, 0, Math.PI * 2); ctx.fill(); continue; }
    if (z >= 0.8) {
      const r = spriteFor(`dwv:gtu:${gt.side}`, () => buildVehicle('gtu', gt.side, 0), gt.angle, z, undefined, now);
      if (r) drawSprite(ctx, r, sx, sy, z, r.residual);
      if (gt.state === 'ready' && z > 1.5) plume(ctx, toS, gt.x - Math.cos(gt.angle) * 6.5, gt.y - Math.sin(gt.angle) * 6.5, 8, z, now, 'smoke', 0.4, gt.id);
    } else badge(ctx, sx, sy, 'ГТУ', SIDE_COL[gt.side], dpr, false, false);
    if (gt.state === 'deploying') ring(ctx, sx, sy - 10 * dpr, 8 * dpr, 1 - (gt.until - t) / 150, '#ffd36b', dpr);
  }

  // ---------- Сетки над дорогами ----------
  for (const n of g.nets) {
    if (n.side !== side || z < 0.08) continue;
    if (!inView(n.x, n.y, 400)) continue;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    n.line.forEach((p, i) => { const [sx, sy] = toS(p[0], p[1]); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    if (!n.done) { ctx.setLineDash([6 * dpr, 5 * dpr]); ctx.strokeStyle = 'rgba(255,220,120,0.7)'; ctx.lineWidth = Math.max(2 * dpr, n.w * z); ctx.stroke(); }
    else {
      ctx.strokeStyle = 'rgba(70,90,60,0.45)'; ctx.lineWidth = Math.max(3 * dpr, n.w * z); ctx.stroke();
      if (z > 1.5) { ctx.setLineDash([0.4 * z, 1.1 * z]); ctx.strokeStyle = 'rgba(40,50,35,0.7)'; ctx.lineWidth = n.w * z * 0.92; ctx.stroke(); } // ячейки сетки
    }
    ctx.restore();
  }

  // ---------- Гражданский транспорт (только для вида) ----------
  if (!g._traffic) g._traffic = new CivTraffic(g);
  g._traffic.update(t);
  g._traffic.draw(ctx, view, toS, inView, now);

  // ---------- Перебитые ЛЭП ----------
  for (const l of g.lines) {
    if (!l.cut || !inView(l.cut.x, l.cut.y, 30)) continue;
    const [sx, sy] = toS(l.cut.x, l.cut.y);
    const f = Math.floor(now / 120) % 2;
    ctx.strokeStyle = f ? '#ffe27a' : '#ff9d3a';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    for (let i = 0; i < 5; i++) { const a = i * 1.26 + now / 400; ctx.moveTo(sx, sy); ctx.lineTo(sx + Math.cos(a) * 7 * dpr, sy + Math.sin(a) * 7 * dpr); }
    ctx.stroke();
  }

  // ---------- ПВО ----------
  const ads = g.visibleAD(side);
  for (const a of ads) {
    const own = a.side === side;
    const pos = own ? [a.x, a.y] : a.spotX?.[side] || [a.x, a.y];
    if (!inView(pos[0], pos[1], 60)) continue;
    const [sx, sy] = toS(pos[0], pos[1]);
    const sel = ui.selAD === a.id;
    if (sel || (own && ui.showRanges)) {
      const T = DW_AD[a.type];
      ctx.strokeStyle = own ? 'rgba(140,200,255,0.55)' : 'rgba(255,140,120,0.5)';
      ctx.lineWidth = 1.2 * dpr;
      ctx.setLineDash([6 * dpr, 5 * dpr]);
      ctx.beginPath(); ctx.arc(sx, sy, T.range * z, 0, Math.PI * 2); ctx.stroke();
      if (T.radar && T.radar !== T.range) { ctx.beginPath(); ctx.arc(sx, sy, T.radar * z, 0, Math.PI * 2); ctx.stroke(); }
      ctx.setLineDash([]);
    }
    if (a.dead) {
      ctx.fillStyle = 'rgba(25,20,16,0.6)';
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(3 * dpr, 3 * z), 0, Math.PI * 2); ctx.fill();
      continue;
    }
    if (z >= 1.3) {
      const heading = a.state === 'moving' ? a.heading : a.heading;
      const hk = a.type === 'sam' ? `sam:${a.side}:hull` : `dwad:${a.type}:${a.side}:hull`;
      const hb = a.type === 'sam' ? MODELS[hk] : () => buildAD(a.type, a.side, 'hull');
      const r = spriteFor(hk, hb, heading, z, undefined, now);
      if (r) drawSprite(ctx, r, sx, sy, z, r.residual);
      const turret = a.type === 'sam' ? `sam:${a.side}:turret` : a.type === 'mog' || a.type === 'spaag' || a.type === 'radar' ? `dwad:${a.type}:${a.side}:turret` : null;
      if (turret) {
        const tb = a.type === 'sam' ? MODELS[turret] : () => buildAD(a.type, a.side, 'turret');
        const ta = a.type === 'radar' ? (now / 1400) % (Math.PI * 2) : a.target ? a.aim : heading;
        const piv = a.type === 'sam' ? -1.4 : a.type === 'mog' ? -1.5 : a.type === 'radar' ? -2 : a.type === 'spaag' && a.side === 'red' ? -2 : 0;
        const rt = spriteFor(turret, tb, ta, z, undefined, now);
        if (rt) drawSprite(ctx, rt, sx + Math.cos(heading) * piv * z, sy + Math.sin(heading) * piv * z, z, rt.residual);
      }
      if (a.state === 'deploying') ring(ctx, sx, sy - 8 * dpr, 7 * dpr, 1 - (a.until - t) / DW_AD[a.type].deploy, '#ffd36b', dpr);
    } else {
      badge(ctx, sx, sy, AD_GLYPH[a.type], own ? SIDE_COL[a.side] : '#ff7d72', dpr, sel, !own);
      if (a.state === 'deploying') ring(ctx, sx, sy, 11 * dpr, 1 - (a.until - t) / DW_AD[a.type].deploy, '#ffd36b', dpr);
    }
    if (a.state === 'moving' && own && a.dest) {
      const [dx, dy] = toS(a.dest.x, a.dest.y);
      ctx.strokeStyle = 'rgba(255,230,140,0.7)'; ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(dx, dy); ctx.stroke(); ctx.setLineDash([]);
    }
    if (!own) {
      ctx.font = `700 ${10 * dpr}px "PT Sans", sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffb3aa';
      ctx.fillText(`${Math.round((t - a.spotted[side]) / 60)} мин`, sx, sy + 16 * dpr);
    }
  }

  // ---------- Прожекторы и трассеры ----------
  for (const f of g.fx) {
    const age = t - f.t0;
    if (f.t === 'tracer') {
      if (age > 0.35) continue;
      const own = f.side === side;
      const ownAD = g.ad.find((q) => Math.abs(q.x - f.x0) < 1 && Math.abs(q.y - f.y0) < 1);
      if (!own && !(ownAD && ownAD.spotted[side])) {
        // чужие трассеры видно, только если рядом свои
        if (!g.ad.some((q) => q.side === side && Math.hypot(q.x - f.x0, q.y - f.y0) < 3000)) continue;
      }
      const [ax, ay0] = toS(f.x0, f.y0);
      const ay = ay0 - 4 * dpr;
      const [bx, by0] = toS(f.x1, f.y1);
      const by = by0 - up(f.alt);
      const k = 1 - age / 0.35;
      if (night > 0.3 && !f.heavy && own) {
        // Луч прожектора к цели
        const gr = ctx.createLinearGradient(ax, ay, bx, by);
        gr.addColorStop(0, `rgba(255,250,220,${0.28 * night})`);
        gr.addColorStop(1, 'rgba(255,250,220,0)');
        const nx = -(by - ay), ny = bx - ax, L = Math.hypot(nx, ny) || 1;
        const wd = 0.08 * L;
        ctx.fillStyle = gr;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx + (nx / L) * wd, by + (ny / L) * wd); ctx.lineTo(bx - (nx / L) * wd, by - (ny / L) * wd); ctx.closePath(); ctx.fill();
      }
      // Очередь: трассирующие пули/снаряды летят от ствола к цели (каждая — светящийся штрих)
      const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
      const seg = Math.min(L * 0.12, (f.heavy ? 26 : 18) * dpr);
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      const nB = f.heavy ? 5 : 4;
      for (let i = 0; i < nB; i++) {
        const u = ((age / 0.35) * 1.6 + i / nB + hash(f.x0 + i)) % 1;
        const x1 = ax + dx * u, y1 = ay + dy * u, x0 = x1 - (dx / L) * seg, y0 = y1 - (dy / L) * seg;
        ctx.strokeStyle = f.heavy ? `rgba(255,200,90,${0.35 * k})` : `rgba(255,110,60,${0.3 * k})`;
        ctx.lineWidth = (f.heavy ? 5 : 3.6) * dpr;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        ctx.strokeStyle = f.heavy ? `rgba(255,240,190,${0.95 * k})` : `rgba(255,200,150,${0.95 * k})`;
        ctx.lineWidth = (f.heavy ? 2 : 1.4) * dpr;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      // Дульная вспышка
      if (age < 0.12) {
        const r = (f.heavy ? 9 : 6) * dpr * (1 - age / 0.12);
        const gm = ctx.createRadialGradient(ax, ay, 0, ax, ay, r);
        gm.addColorStop(0, 'rgba(255,245,200,0.95)'); gm.addColorStop(1, 'rgba(255,150,50,0)');
        ctx.fillStyle = gm; ctx.beginPath(); ctx.arc(ax, ay, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      // Разрывы зенитных снарядов рядом с целью — серые облачка
      if (f.heavy && age > 0.1) {
        ctx.fillStyle = `rgba(70,68,64,${0.45 * k})`;
        for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(bx + (hash(f.x1 + i) - 0.5) * 30 * dpr, by + (hash(f.y1 + i * 3) - 0.5) * 20 * dpr, (3 + age * 10) * dpr, 0, Math.PI * 2); ctx.fill(); }
      }
    } else if (f.t === 'airburst') {
      if (age > 5) continue;
      const [sx, sy0] = toS(f.x, f.y);
      const sy = sy0 - up(f.alt);
      const R = (f.small ? 7 : 16) * dpr;
      if (age < 0.35) {
        const k = age / 0.35;
        const gr = ctx.createRadialGradient(sx, sy, 0, sx, sy, R * (0.6 + k));
        gr.addColorStop(0, `rgba(255,250,220,${1 - k})`); gr.addColorStop(0.4, `rgba(255,170,60,${0.9 * (1 - k)})`); gr.addColorStop(1, 'rgba(255,90,20,0)');
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(sx, sy, R * (0.6 + k), 0, Math.PI * 2); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.fillStyle = `rgba(55,52,48,${0.55 * (1 - age / 5)})`;
      ctx.beginPath(); ctx.arc(sx + age * 4 * dpr, sy - age * 2 * dpr, R * 0.5 * (1 + age * 0.8), 0, Math.PI * 2); ctx.fill();
      // горящие обломки падают
      if (!f.small) {
        for (let i = 0; i < 6; i++) {
          const k2 = Math.min(1, age / 3.5);
          const px = sx + (hash(i + f.x) - 0.5) * 36 * dpr * (0.3 + k2), py = sy + k2 * k2 * up(f.alt) * (0.8 + hash(i * 3 + f.y) * 0.2);
          if (k2 >= 1) continue;
          ctx.fillStyle = i % 2 ? `rgba(255,170,70,${1 - k2})` : 'rgba(40,36,32,0.85)';
          ctx.fillRect(px, py, 2.2 * dpr, 2.2 * dpr);
        }
      }
    } else if (f.t === 'impact') {
      // Прилёт: огненный шар, ударная волна, столб дыма, уносимый ветром
      if (age > 30) continue;
      const [sx, sy] = toS(f.x, f.y);
      const wh = f.wh || 20;
      const Rm = Math.max(8 * dpr, (6 + wh * 0.35) * z);
      if (age < 0.8) {
        const k = age / 0.8;
        ctx.strokeStyle = `rgba(255,240,210,${0.6 * (1 - k)})`; ctx.lineWidth = 2 * dpr;
        ctx.beginPath(); ctx.ellipse(sx, sy, Rm * (1 + k * 3), Rm * (1 + k * 3) * 0.7, 0, 0, Math.PI * 2); ctx.stroke();
        const gr = ctx.createRadialGradient(sx, sy - Rm * k * 0.6, 0, sx, sy - Rm * k * 0.6, Rm * (0.8 + k * 0.6));
        gr.addColorStop(0, `rgba(255,248,210,${1 - k})`); gr.addColorStop(0.35, `rgba(255,160,50,${0.95 * (1 - k * 0.7)})`); gr.addColorStop(1, 'rgba(120,40,10,0)');
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(sx, sy - Rm * k * 0.6, Rm * (0.8 + k * 0.6), 0, Math.PI * 2); ctx.fill();
        // вспышка освещает округу
        const gl = ctx.createRadialGradient(sx, sy, 0, sx, sy, Rm * 5);
        gl.addColorStop(0, `rgba(255,170,80,${0.35 * (1 - k)})`); gl.addColorStop(1, 'rgba(255,120,40,0)');
        ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(sx, sy, Rm * 5, 0, Math.PI * 2); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }
      const n = 7;
      for (let i = 0; i < n; i++) {
        const u = Math.min(1, age / 30);
        const hh = (i / n) * (0.4 + age * 0.12) * Rm * 5;
        const r = Rm * (0.5 + (i / n) * 1.2 + age * 0.05);
        ctx.fillStyle = `rgba(${40 + i * 4},${38 + i * 4},${36 + i * 4},${0.5 * (1 - u) * (1 - i / (n + 2))})`;
        ctx.beginPath(); ctx.arc(sx + hh * 0.35, sy - hh, r, 0, Math.PI * 2); ctx.fill();
      }
    } else if (f.t === 'money') {
      if (age > 3 || f.side !== side || z < 0.05) continue;
      const [sx, sy] = toS(f.x, f.y);
      ctx.font = `700 ${11 * dpr}px "PT Sans Narrow", sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 3 * dpr; ctx.strokeStyle = `rgba(0,0,0,${0.6 * (1 - age / 3)})`;
      ctx.strokeText(`+${f.v}`, sx, sy - 12 * dpr - age * 12 * dpr);
      ctx.fillStyle = `rgba(255,226,110,${1 - age / 3})`;
      ctx.fillText(`+${f.v}`, sx, sy - 12 * dpr - age * 12 * dpr);
    } else if (f.t === 'fall') {
      if (age > 6) continue;
      const [sx, sy0] = toS(f.x, f.y);
      const k2 = Math.min(1, age / 5);
      ctx.strokeStyle = `rgba(70,66,60,${0.6 * (1 - age / 6)})`;
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath(); ctx.moveTo(sx, sy0 - up(f.alt)); ctx.lineTo(sx + 8 * dpr * k2, sy0 - up(f.alt) * (1 - k2)); ctx.stroke();
    }
  }

  // ---------- Ракеты ----------
  for (const m of g.missiles) {
    const own = m.side === side;
    if (!own && !g.ad.some((q) => q.side === side && Math.hypot(q.x - m.x, q.y - m.y) < 6000)) continue;
    // дымный след ракеты: густой у сопла, расплывается к хвосту
    for (let i = 1; i < m.trail.length; i++) {
      const [x0, y0, a0] = m.trail[i - 1], [x1, y1, a1] = m.trail[i];
      const [p0x, p0y] = toS(x0, y0), [p1x, p1y] = toS(x1, y1);
      const k = i / m.trail.length;
      ctx.strokeStyle = `rgba(232,230,224,${0.15 + 0.5 * k})`;
      ctx.lineWidth = (5 - k * 3) * dpr;
      ctx.beginPath(); ctx.moveTo(p0x, p0y - up(a0)); ctx.lineTo(p1x, p1y - up(a1)); ctx.stroke();
    }
    const [sx, sy] = toS(m.x, m.y);
    const gm = ctx.createRadialGradient(sx, sy - up(m.alt), 0, sx, sy - up(m.alt), 7 * dpr);
    gm.addColorStop(0, 'rgba(255,255,230,1)'); gm.addColorStop(0.4, 'rgba(255,190,90,0.9)'); gm.addColorStop(1, 'rgba(255,120,40,0)');
    ctx.fillStyle = gm; ctx.beginPath(); ctx.arc(sx, sy - up(m.alt), 7 * dpr, 0, Math.PI * 2); ctx.fill();
  }

  // ---------- Машины на дорогах ----------
  for (const v of g.visibleVehicles(side)) {
    if (!inView(v.x, v.y, 30)) continue;
    const [sx, sy] = toS(v.x, v.y);
    if (v.wreck) {
      const age = t - v.deadAt;
      ctx.fillStyle = 'rgba(25,20,16,0.85)';
      ctx.beginPath(); ctx.ellipse(sx, sy, Math.max(2 * dpr, 4 * z), Math.max(1.5 * dpr, 2 * z), v.heading, 0, Math.PI * 2); ctx.fill();
      if (age < 180) fire(ctx, toS, v.x, v.y, 3, z, now, age < 60, hash(v.id));
      continue;
    }
    if (z >= 1.2) {
      const variant = v.id % 6;
      const key = v.kind === 'supply' ? `truck:${v.side}:hull` : `dwv:${v.kind}:${v.kind === 'fura' || v.kind === 'van' ? variant : v.side}`;
      const b = v.kind === 'supply' ? MODELS[key] : () => buildVehicle(v.kind, v.side, variant);
      const r = spriteFor(key, b, v.heading, z, undefined, now);
      if (r) drawSprite(ctx, r, sx, sy, z, r.residual);
      if (v.kind === 'fire' && Math.floor(now / 250) % 2) { ctx.fillStyle = 'rgba(80,140,255,0.9)'; ctx.beginPath(); ctx.arc(sx, sy - 3.2 * 0.42 * z, Math.max(2, 0.6 * z), 0, Math.PI * 2); ctx.fill(); }
      if (v.state === 'work' && v.kind === 'crew' && Math.floor(now / 150) % 3 === 0) { ctx.fillStyle = 'rgba(255,240,170,0.95)'; ctx.beginPath(); ctx.arc(sx + Math.cos(now / 300) * 3 * z, sy - 4 * z, Math.max(1.5, 0.5 * z), 0, Math.PI * 2); ctx.fill(); } // сварка
      if (v.state === 'work' && v.kind === 'fire') { ctx.strokeStyle = 'rgba(200,230,255,0.7)'; ctx.lineWidth = Math.max(1, 0.4 * z); ctx.beginPath(); ctx.moveTo(sx, sy - 2 * z); ctx.quadraticCurveTo(sx + 8 * z, sy - 9 * z, sx + 14 * z, sy - 3 * z); ctx.stroke(); }
    } else {
      // обзорный масштаб: точки на дорогах — видно потоки машин
      ctx.fillStyle = VEH_COL[v.kind] || SIDE_COL[v.side];
      ctx.strokeStyle = v.side === side ? 'rgba(0,0,0,0.7)' : '#ff4a3a';
      ctx.lineWidth = 1 * dpr;
      const r = (v.kind === 'fura' ? 2.6 : 2.1) * dpr;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill(); if (v.side !== side || z > 0.15) ctx.stroke();
    }
    if (ui.selVeh === v.id) { ctx.strokeStyle = '#fff27a'; ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.arc(sx, sy, Math.max(8 * dpr, 6 * z), 0, Math.PI * 2); ctx.stroke(); }
  }

  // ---------- Дроны ----------
  const drones = g.visibleDrones(side);
  for (const d of drones) {
    if (!inView(d.x, d.y, 100)) continue;
    const own = d.side === side;
    const D = DW_DRONES[d.type];
    const [gx, gy] = toS(d.x, d.y);
    const lift = up(d.alt);
    const sx = gx, sy = gy - lift;
    // Маршрут своих
    if (own && ui.showRoutes !== false && D.cls !== 'interceptor') {
      ctx.strokeStyle = 'rgba(160,210,255,0.25)';
      ctx.lineWidth = 1 * dpr;
      ctx.setLineDash([3 * dpr, 5 * dpr]);
      ctx.beginPath(); ctx.moveTo(gx, gy);
      for (const p of d.route) { const [px, py] = toS(p.x, p.y); ctx.lineTo(px, py); }
      if (D.cls !== 'recon') { const [px, py] = toS(d.aimX, d.aimY); ctx.lineTo(px, py); }
      ctx.stroke(); ctx.setLineDash([]);
    }
    // След
    if (d.trail.length > 2) {
      ctx.strokeStyle = own ? 'rgba(200,220,255,0.25)' : 'rgba(255,150,130,0.35)';
      ctx.lineWidth = 1.2 * dpr;
      ctx.beginPath();
      d.trail.forEach(([x, y], i) => { const [px, py] = toS(x, y); i ? ctx.lineTo(px, py - lift) : ctx.moveTo(px, py - lift); });
      ctx.stroke();
    }
    // Тень на земле
    ctx.fillStyle = `rgba(0,0,0,${Math.max(0.1, 0.35 - d.alt / 6000)})`;
    ctx.beginPath(); ctx.ellipse(gx, gy, Math.max(2 * dpr, 1.2 * z), Math.max(1.2 * dpr, 0.6 * z), 0, 0, Math.PI * 2); ctx.fill();
    // Опознание: свои — модель; чужие — силуэт по классу (ложную цель от ударной на радаре не отличить)
    const showType = own ? d.type : D.cls === 'decoy' ? (d.side === 'red' ? 'shahed' : 'fp1') : d.type;
    const vr = D.cls === 'decoy' && !own ? 0 : d.variant || 0;
    if (z >= 1.2) {
      const k = Math.max(z * 1.1, (D.cls === 'interceptor' ? 7 : 5) * dpr); // не мельче читаемого
      const r = spriteFor(`dwd:${showType}:${vr}`, () => buildDrone(showType, vr), d.heading, k, { shadow: false }, now);
      if (r) drawSprite(ctx, r, sx, sy, k, r.residual);
      // толкающий винт — мерцающий диск за хвостом
      if (D.cls !== 'interceptor') {
        ctx.fillStyle = 'rgba(40,40,40,0.28)';
        ctx.beginPath(); ctx.arc(sx - Math.cos(d.heading) * 1.8 * k, sy - Math.sin(d.heading) * 1.8 * k, 0.45 * k, 0, Math.PI * 2); ctx.fill();
      }
    } else {
      const s = (D.cls === 'interceptor' ? 2.5 : D.cls === 'recon' ? 3.5 : 4) * dpr;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(d.heading);
      ctx.fillStyle = own ? SIDE_COL[d.side] : '#ff5a4a';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 1.2 * dpr;
      ctx.beginPath();
      if (D.cls === 'recon' || D.cls === 'loiter') { ctx.moveTo(s, 0); ctx.lineTo(-s * 0.6, s * 0.9); ctx.lineTo(-s * 0.2, 0); ctx.lineTo(-s * 0.6, -s * 0.9); }
      else if (D.cls === 'interceptor') { ctx.arc(0, 0, s * 0.6, 0, Math.PI * 2); }
      else { ctx.moveTo(s, 0); ctx.lineTo(-s, s); ctx.lineTo(-s * 0.6, 0); ctx.lineTo(-s, -s); }
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    // Ночью у реактивных — факел двигателя
    if (d.type === 'geran3' && night > 0.3) { ctx.fillStyle = 'rgba(255,170,80,0.8)'; ctx.beginPath(); ctx.arc(sx - Math.cos(d.heading) * 8 * dpr, sy - Math.sin(d.heading) * 8 * dpr, 2 * dpr, 0, Math.PI * 2); ctx.fill(); }
    if (!own && z < 1.2) {
      ctx.font = `700 ${9 * dpr}px "PT Sans", sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ffb0a6';
      ctx.fillText(D.cls === 'strike' || D.cls === 'decoy' ? (D.speed > 80 ? 'реакт.' : 'БПЛА') : D.cls === 'recon' ? 'разв.' : D.cls === 'loiter' ? 'барраж.' : '', sx + 7 * dpr, sy - 4 * dpr);
    }
  }

  // ---------- Значки объектов (обзорный масштаб) и подписи ----------
  const labels = z < 0.9;
  for (const o of g.objects) {
    if (o.kind === 'import' || !inView(o.x, o.y, 300) || !g.known(side, o)) continue;
    const [sx, sy] = toS(o.x, o.y);
    const bad = o.comps.filter((c) => c.state !== 'ok').length;
    const dead = o.comps.filter((c) => c.state === 'destroyed').length;
    const fire = o.comps.some((c) => c.fire > 0);
    const st = !o.comps.length ? 'ok' : dead / o.comps.length > 0.5 || (o.kind === 'bridge' && g.bridgeCap(o) === 0) ? 'destroyed' : bad ? 'damaged' : 'ok';
    const sel = ui.selObj === o.id;
    const minor = o.kind === 'store' || o.kind === 'market' || o.kind === 'firest' || o.kind === 'fuel' || (o.kind === 'rembase' && o.small);
    if (minor && z < 0.12 && !sel) continue; // мелкие объекты — только вблизи
    if (!detail || labels || sel) {
      const w = (o.kind === 'bridge' ? 16 : o.kind === 'fuel' ? 28 : 26) * dpr;
      ctx.fillStyle = o.side === side ? 'rgba(20,28,40,0.85)' : 'rgba(45,18,16,0.85)';
      ctx.strokeStyle = sel ? '#fff27a' : SIDE_COL[o.side];
      ctx.lineWidth = (sel ? 2.5 : 1.5) * dpr;
      ctx.beginPath(); ctx.roundRect(sx - w / 2, sy - 8 * dpr, w, 16 * dpr, 4 * dpr); ctx.fill(); ctx.stroke();
      ctx.fillStyle = ST_COL[st];
      ctx.font = `700 ${9.5 * dpr}px "PT Sans Narrow", sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(GLYPH[o.mimic && o.side !== side ? o.mimic : o.kind] || '?', sx, sy + 0.5 * dpr); // макет противник видит как настоящий объект
      if (fire) { ctx.fillStyle = '#ff8a3a'; ctx.beginPath(); ctx.arc(sx + w / 2, sy - 8 * dpr, 3.5 * dpr, 0, Math.PI * 2); ctx.fill(); }
      if (o.kind === 'ps110' && o.supply !== undefined && o.side === side) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(sx - w / 2, sy + 9 * dpr, w, 3 * dpr);
        ctx.fillStyle = o.supply > 0.8 ? '#ffe27a' : o.supply > 0.4 ? '#f0a040' : '#ef5a4a';
        ctx.fillRect(sx - w / 2, sy + 9 * dpr, w * o.supply, 3 * dpr);
      }
      if (z > 0.06 && (o.kind !== 'bridge' || z > 0.2) && (!minor || z > 0.35 || sel)) {
        ctx.font = `600 ${10 * dpr}px "PT Sans", sans-serif`;
        ctx.textBaseline = 'top';
        ctx.lineWidth = 3 * dpr; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        const nm = o.kind === 'bridge' ? 'Мост' : o.name;
        ctx.strokeText(nm, sx, sy + 13 * dpr);
        ctx.fillStyle = o.side === side ? '#e2ecff' : '#ffd9d4';
        ctx.fillText(nm, sx, sy + 13 * dpr);
        ctx.textBaseline = 'alphabetic';
      }
    }
    if (sel && detail) {
      ctx.save();
      ctx.translate(sx, sy); ctx.rotate(o.angle);
      ctx.strokeStyle = '#fff27a'; ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.strokeRect(-o.w / 2 * z - 6, -o.h / 2 * z - 6, o.w * z + 12, o.h * z + 12);
      ctx.restore();
      ctx.setLineDash([]);
    }
  }
  void FACTIONS; void KIND_NAME;
}

// Пролёт моста: обрушен — провал с обломками в воде; повреждён — воронки на полотне
function drawSpan(ctx, c, sx, sy, z, o) {
  const w = c.w * z, h = (o.btype === 'rail' ? 10 : 14) * z;
  if (c.shelter && c.state !== 'destroyed') {
    // сетка над пролётом: рамы-арки и полотно
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(c.angle);
    ctx.fillStyle = 'rgba(60,75,55,0.4)';
    ctx.fillRect(-w / 2, -h / 2 - 2 * z, w, h + 4 * z);
    ctx.strokeStyle = 'rgba(40,48,36,0.8)'; ctx.lineWidth = Math.max(1, 0.5 * z);
    ctx.beginPath();
    for (let u = -w / 2; u <= w / 2 + 0.1; u += Math.max(4, 6 * z)) { ctx.moveTo(u, -h / 2 - 2 * z); ctx.lineTo(u, h / 2 + 2 * z); }
    ctx.stroke();
    ctx.restore();
  }
  if (c.state === 'ok') return;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(c.angle);
  if (c.state === 'destroyed') {
    ctx.fillStyle = '#3e5a60';
    ctx.fillRect(-w / 2, -h / 2 - 1, w, h + 2);
    ctx.fillStyle = 'rgba(80,76,70,0.9)';
    for (let i = 0; i < 6; i++) ctx.fillRect(-w / 2 + (i / 6) * w, -h / 2 + ((i * 37) % 10) / 10 * h, 0.12 * w, 0.2 * h);
    ctx.strokeStyle = 'rgba(30,28,26,0.9)'; ctx.lineWidth = Math.max(1, 0.6 * z);
    ctx.beginPath(); ctx.moveTo(-w / 2, -h / 2); ctx.lineTo(-w / 2 + 0.1 * w, h / 2); ctx.moveTo(w / 2, -h / 2); ctx.lineTo(w / 2 - 0.12 * w, h / 2); ctx.stroke();
  } else {
    ctx.fillStyle = 'rgba(25,22,20,0.7)';
    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc((hash(i + c.x) - 0.5) * w * 0.8, (hash(i * 2 + c.y) - 0.5) * h * 0.6, Math.max(1.5, 1.6 * z), 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}

// Ротор ветроустановки: три лопасти по 55 м на высоте 90 м, вращение от силы ветра; тень на земле
function rotor(ctx, sx, sy, z, now, wind, c, damaged, dpr) {
  const H = 90, R = 55;
  const px = -Math.sin(c.angle), py = Math.cos(c.angle); // плоскость вращения — поперёк ветра
  const a0 = damaged ? 0.5 : (now / 1000) * (0.5 + wind * 1.3) + c.x * 0.01;
  const hubX = sx, hubY = sy - H * K3 * z;
  const shx = 0.3, shy = 0.34; // тень от солнца: смещение на метр высоты
  ctx.lineCap = 'round';
  // тень лопастей на земле
  ctx.strokeStyle = 'rgba(0,0,0,0.16)'; ctx.lineWidth = Math.max(1, 1.8 * z);
  ctx.beginPath();
  for (let k = 0; k < 3; k++) {
    const a = a0 + (k * Math.PI * 2) / 3, h = H + Math.sin(a) * R;
    ctx.moveTo(sx + shx * H * z, sy + shy * H * z);
    ctx.lineTo(sx + (px * Math.cos(a) * R + shx * h) * z, sy + (py * Math.cos(a) * R + shy * h) * z);
  }
  ctx.stroke();
  // лопасти
  ctx.strokeStyle = 'rgba(236,236,230,0.95)'; ctx.lineWidth = Math.max(1, 2.2 * z);
  ctx.beginPath();
  for (let k = 0; k < 3; k++) {
    const a = a0 + (k * Math.PI * 2) / 3;
    ctx.moveTo(hubX, hubY);
    ctx.lineTo(hubX + px * Math.cos(a) * R * z, hubY + py * Math.cos(a) * R * z - Math.sin(a) * R * K3 * z);
  }
  ctx.stroke();
  ctx.fillStyle = '#e8e8e2'; ctx.beginPath(); ctx.arc(hubX, hubY, Math.max(1.2 * dpr, 1.6 * z), 0, Math.PI * 2); ctx.fill();
}

// Столб пара / дыма над высоким сооружением
function plume(ctx, toS, x, y, hgt, z, now, kind, strength, seed) {
  const [sx, sy] = toS(x, y);
  const top = sy - hgt * K3 * z;
  const n = 7;
  for (let i = 0; i < n; i++) {
    const f = ((now / 9000) + i / n + seed * 0.001) % 1;
    const r = (6 + f * 30) * z * (0.6 + strength * 0.4);
    const px = sx + f * 60 * z + Math.sin(f * 6 + seed) * 5 * z;
    const py = top - f * 50 * z;
    ctx.fillStyle = kind === 'steam' ? `rgba(235,236,238,${0.45 * (1 - f) * strength})` : `rgba(90,88,84,${0.35 * (1 - f) * strength})`;
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
  }
}

// Пожар: языки пламени и чёрный дым
function fire(ctx, toS, x, y, size, z, now, heavy, seed) {
  const [sx, sy] = toS(x, y);
  const s = Math.max(3, size * z);
  for (let i = 0; i < 4; i++) {
    const f = ((now / 700) + i / 4 + seed) % 1;
    ctx.fillStyle = `rgba(255,${120 + i * 30},${40 + i * 10},${0.8 * (1 - f)})`;
    ctx.beginPath(); ctx.arc(sx + Math.sin(now / 130 + i * 2) * s * 0.25, sy - f * s * 1.3, s * (0.5 - f * 0.3), 0, Math.PI * 2); ctx.fill();
  }
  const n = heavy ? 10 : 6;
  for (let i = 0; i < n; i++) {
    const f = ((now / (heavy ? 5000 : 4000)) + i / n + seed) % 1;
    const r = s * (0.6 + f * (heavy ? 4 : 2.5));
    ctx.fillStyle = `rgba(${heavy ? 22 : 45},${heavy ? 20 : 42},${heavy ? 18 : 40},${(heavy ? 0.6 : 0.45) * (1 - f)})`;
    ctx.beginPath(); ctx.arc(sx + f * s * 5, sy - s - f * s * (heavy ? 12 : 7), r, 0, Math.PI * 2); ctx.fill();
  }
}

function badge(ctx, sx, sy, txt, col, dpr, sel, enemy) {
  ctx.fillStyle = enemy ? 'rgba(60,16,14,0.9)' : 'rgba(14,22,34,0.9)';
  ctx.strokeStyle = sel ? '#fff27a' : col;
  ctx.lineWidth = (sel ? 2.5 : 1.4) * dpr;
  ctx.beginPath(); ctx.arc(sx, sy, 9 * dpr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = col;
  ctx.font = `700 ${7.5 * dpr}px "PT Sans Narrow", sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(txt, sx, sy + 0.5 * dpr);
  ctx.textBaseline = 'alphabetic';
}
function ring(ctx, x, y, r, k, col, dpr) {
  ctx.strokeStyle = col; ctx.lineWidth = 2 * dpr;
  ctx.beginPath(); ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, k))); ctx.stroke();
}

// Предпросмотр: постановка ПВО, маршрут удара
export function drawDWPreview(ctx, sim, view, side, ui, mw) {
  const g = sim.game;
  const { cam, canvas, dpr } = view;
  const z = cam.zoom;
  const toS = (x, y) => [(x - cam.x) * z + canvas.width / 2, (y - cam.y) * z + canvas.height / 2];
  // Линия фронта
  const [fx] = toS(g.frontX, 0);
  ctx.strokeStyle = 'rgba(255,90,70,0.35)';
  ctx.lineWidth = 2 * dpr;
  ctx.setLineDash([12 * dpr, 8 * dpr]);
  ctx.beginPath(); ctx.moveTo(fx, 0); ctx.lineTo(fx, canvas.height); ctx.stroke();
  ctx.setLineDash([]);
  if (!mw) return;
  const [mx, my] = toS(mw[0], mw[1]);
  if (ui.mode?.startsWith('ad:')) {
    const type = ui.mode.slice(3);
    const err = g.canPlace(side, type, mw[0], mw[1]);
    ctx.strokeStyle = err ? 'rgba(255,90,70,0.8)' : 'rgba(140,255,140,0.8)';
    ctx.fillStyle = err ? 'rgba(255,90,70,0.08)' : 'rgba(140,255,140,0.07)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.arc(mx, my, DW_AD[type].range * z, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(mx, my, 5 * dpr, 0, Math.PI * 2); ctx.stroke();
  }
  if (ui.mode?.startsWith('build:')) {
    // контур будущей площадки (место сдвигается от дороги и разворачивается вдоль неё)
    const kind = ui.mode.slice(6), st = g.econ.siteFor(side, kind, mw[0], mw[1]);
    const lay = st.lay, ok = !st.err;
    const cx = ok ? st.x : mw[0], cy = ok ? st.y : mw[1], ang = ok ? st.angle : 0;
    const w = (lay?.w || 60) + 16, h = (lay?.h || 40) + 16, c = Math.cos(ang), s = Math.sin(ang);
    ctx.strokeStyle = ok ? 'rgba(140,255,140,0.9)' : 'rgba(255,90,70,0.9)';
    ctx.fillStyle = ok ? 'rgba(140,255,140,0.15)' : 'rgba(255,90,70,0.12)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    for (const [u, v] of [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]) { const [px, py] = toS(cx + u * c - v * s, cy + u * s + v * c); ctx.lineTo(px, py); }
    ctx.closePath(); ctx.fill(); ctx.stroke();
    if (ok) { const [a1, b1] = toS(st.drive[0][0], st.drive[0][1]), [a2, b2] = toS(st.drive[1][0], st.drive[1][1]); ctx.setLineDash([4 * dpr, 3 * dpr]); ctx.beginPath(); ctx.moveTo(a1, b1); ctx.lineTo(a2, b2); ctx.stroke(); ctx.setLineDash([]); }
  }
  if (ui.mode === 'pave') {
    // подсветить дорогу, которую заасфальтируют
    const q = g.infra.roadAt(side, mw[0], mw[1]);
    if (!q.err) { ctx.strokeStyle = 'rgba(140,255,140,0.85)'; ctx.lineWidth = Math.max(3 * dpr, 10 * z); ctx.beginPath(); q.r.line.forEach(([x, y], i) => { const [px, py] = toS(x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }); ctx.stroke(); }
  }
  if (ui.mode?.startsWith('line:')) {
    const a = g.obj(Number(ui.mode.slice(5)));
    if (a) { const [ax, ay] = toS(a.x, a.y); ctx.strokeStyle = 'rgba(255,211,107,0.9)'; ctx.lineWidth = 2 * dpr; ctx.setLineDash([8 * dpr, 6 * dpr]); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(mx, my); ctx.stroke(); ctx.setLineDash([]); }
  }
  if (ui.mode?.startsWith('evac:')) {
    const q = g.infra.evacCheck(side, Number(ui.mode.slice(5)), mw[0], mw[1]);
    ctx.strokeStyle = q.err ? 'rgba(255,90,70,0.9)' : 'rgba(140,255,140,0.9)'; ctx.lineWidth = 2 * dpr;
    ctx.strokeRect(mx - 125 * z, my - 85 * z, 250 * z, 170 * z);
    const [fx0] = toS(g.frontX + (side === 'blue' ? -14000 : 14000), 0);
    ctx.setLineDash([10 * dpr, 6 * dpr]); ctx.strokeStyle = 'rgba(140,255,140,0.5)'; ctx.beginPath(); ctx.moveTo(fx0, 0); ctx.lineTo(fx0, canvas.height); ctx.stroke(); ctx.setLineDash([]);
  }
  if (ui.mode?.startsWith('strike:')) {
    ctx.strokeStyle = 'rgba(255,200,120,0.8)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([6 * dpr, 5 * dpr]);
    const type = ui.mode.slice(7);
    const pts = g.launchPoints(side, DW_DRONES[type]);
    if (pts.length) {
      const [ax, ay] = toS(pts[0].x, pts[0].y);
      ctx.beginPath(); ctx.moveTo(ax, ay);
      for (const p of ui.route || []) { const [px, py] = toS(p.x, p.y); ctx.lineTo(px, py); }
      ctx.lineTo(mx, my); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(mx, my, 10 * dpr, 0, Math.PI * 2); ctx.moveTo(mx - 15 * dpr, my); ctx.lineTo(mx + 15 * dpr, my); ctx.moveTo(mx, my - 15 * dpr); ctx.lineTo(mx, my + 15 * dpr); ctx.stroke();
    const D = DW_DRONES[type];
    if (D.cep && z > 0.2) { ctx.beginPath(); ctx.arc(mx, my, D.cep * 2 * z, 0, Math.PI * 2); ctx.stroke(); }
  }
}
