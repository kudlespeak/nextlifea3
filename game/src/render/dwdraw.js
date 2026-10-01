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
import { drawExtras } from './dwextra.js';

const SIDE_COL = { blue: '#6fa6ff', red: '#ff7d72' };
const ST_COL = { ok: '#7ddc6a', damaged: '#f0c34a', destroyed: '#ef5a4a' };
const GLYPH = { tpp: 'ТЭС', ps330: '330', ps110: '110', bridge: 'М', oil: 'НБ', ammo: 'АР', factory: 'ЗД', launch: 'СП', hub: 'РЦ', decoy: 'МКТ', refinery: 'НПЗ', watertower: 'ВОД', railterm: 'ЖДТ', port: 'ПОРТ', coalmine: 'ШХ', cement: 'ЦЗ', elevator: 'ЭЛ', agro: 'МД', housing: 'ЖК', hospital: 'БЛ', school: 'ШК', mill: 'МК', dairy: 'МФ', solar: 'СЭС', bess: 'АКБ', pontoon: 'ПН', autopark: 'АБ', reserve: 'ГР', border: 'ПП', mall: 'ТЦ', market: 'СМ', store: 'маг', firest: 'ПЧ', rembase: 'РБ', fuel: 'АЗС', hpp: 'ГЭС', chp: 'ТЭЦ', wpp: 'ВЭС', spp: 'СЭС' };
const VEH_COL = { fura: '#e8e2cc', van: '#cfd8e0', tanker: '#f0d060', grain: '#d8b85a', grainx: '#e0c060', supply: null, crew: '#ff9a3a', fire: '#ff4a3a' };
const AD_GLYPH = { dummy: 'МАК', mog: 'МОГ', spaag: 'ЗСУ', sam: 'ЗРК', ew: 'РЭБ', ewd: 'КРЭБ', acoustic: 'АП', radar: 'РЛС', icpt: 'ПХ' };

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
    if (sh.wait) { const [sx, sy] = toS(head.x, head.y); ctx.fillStyle = '#ff5a4a'; ctx.font = `${Math.round(11 * dpr)}px sans-serif`; ctx.fillText('стоит', sx + 6 * dpr, sy - 6 * dpr); }
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

function drawFrontFire(ctx, world, toS, inView, z, now, dpr) {
  const F = world.front, H = world.H, t = now / 1000;
  const lineX = (y, off) => F.fx + off + Math.sin(y / 2700 + F.ph) * 180 + Math.sin(y / 900 + F.ph * 2) * 45;
  const hs = (a, b) => { const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return v - Math.floor(v); };
  for (let i = 0; i < 40; i++) {
    const per = 4 + hs(i, 1) * 9, cyc = Math.floor((t + hs(i, 2) * per) / per), ph = ((t + hs(i, 2) * per) % per) / per * per;
    const y = 300 + hs(i, cyc) * (H - 600), x = lineX(y, (hs(cyc, i) - 0.5) * 1100);
    if (!inView(x, y, 200)) continue;
    const [sx, sy] = toS(x, y);
    if (ph < 0.25) {
      // вспышка разрыва
      const r = (18 + 30 * hs(i, cyc + 7)) * z * (1 - ph * 2) + 3 * dpr;
      const gr = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
      gr.addColorStop(0, 'rgba(255,240,190,0.95)'); gr.addColorStop(0.4, 'rgba(255,150,60,0.7)'); gr.addColorStop(1, 'rgba(255,90,30,0)');
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
    }
    if (ph < 7) {
      // облако дыма и пыли, уносимое ветром
      const k = ph / 7, r = (10 + 45 * k) * z + 2 * dpr;
      ctx.fillStyle = `rgba(70,64,56,${0.45 * (1 - k)})`;
      ctx.beginPath(); ctx.arc(sx + k * 30 * z, sy - k * 40 * z, r, 0, Math.PI * 2); ctx.fill();
    }
  }
  // очаги пожаров в серой зоне: столбы дыма
  for (let i = 0; i < 12; i++) {
    const y = 600 + hs(i, 99) * (H - 1200), x = lineX(y, (hs(i, 98) - 0.5) * 900);
    if (!inView(x, y, 400)) continue;
    for (let k = 0; k < 6; k++) {
      const f = ((t * 0.08 + k / 6 + hs(i, k)) % 1);
      const [sx, sy] = toS(x + f * 120, y - f * 40);
      ctx.fillStyle = `rgba(55,52,48,${0.35 * (1 - f)})`;
      ctx.beginPath(); ctx.arc(sx, sy - f * 160 * z, (8 + f * 40) * z + dpr, 0, Math.PI * 2); ctx.fill();
    }
  }
}
function drawLineEnds(ctx, g, world, side, toS, inView, z) {
  const known = (id) => id == null || id === 'import' || g.known(side, g.obj(id));
  for (const ln of world.power?.lines || []) {
    const pl = ln.pylons;
    if (!pl || pl.length < 2) continue;
    if (!(ln.feed ? known(ln.a) : known(ln.a) && known(ln.b))) continue;
    const big = ln.kv >= 330, sp = big ? 7.5 : 4, Hw = big ? 30 : 20;
    for (const [end, nb] of [[pl[0], pl[1]], [pl[pl.length - 1], pl[pl.length - 2]]]) {
      if (!end.ph || !inView(end.x, end.y, 300)) continue;
      const L = Math.hypot(end.x - nb.x, end.y - nb.y) || 1, nx = -(end.y - nb.y) / L, ny = (end.x - nb.x) / L;
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass ? 'rgba(55,57,55,0.9)' : 'rgba(0,0,0,0.18)';
        ctx.lineWidth = Math.max(0.7, (big ? 0.7 : 0.5) * z);
        ctx.beginPath();
        for (const o of [-sp, 0, sp]) {
          const P = (x, y, h) => { const [sx, sy] = toS(pass ? x : x + 0.3 * h, pass ? y : y + 0.34 * h); return [sx, sy - (pass ? h * K3 * z : 0)]; };
          // от опоры (провод на высоте траверсы) к порталу; на опоре — там же, где кончается провод на карте
          const A = P(nb.x + nx * o, nb.y + ny * o, pass ? 0 : Hw), B = P(end.x + nx * o * 0.5, end.y + ny * o * 0.5, end.ph), M = P((nb.x + end.x) / 2 + nx * o * 0.75, (nb.y + end.y) / 2 + ny * o * 0.75, end.ph * 0.6);
          ctx.moveTo(A[0], A[1]); ctx.quadraticCurveTo(2 * M[0] - (A[0] + B[0]) / 2, 2 * M[1] - (A[1] + B[1]) / 2, B[0], B[1]);
        }
        ctx.stroke();
      }
    }
  }
}
// ---------- Ограда объекта: бетонный забор у энергетики, военных и промышленных объектов,
// сетчатый — у пожарных частей, баз и прочего; магазины и АЗС открыты; ворота со шлагбаумом и будкой охраны со стороны подъезда ----------
const OPEN_SITE = new Set(['store', 'kiosk', 'fuel', 'mall', 'market']);
const HARD_FENCE = new Set(['tpp', 'hpp', 'chp', 'ps330', 'ps110', 'decoy', 'oil', 'ammo', 'factory', 'workshop', 'launch', 'refinery', 'coalmine', 'reserve', 'bess', 'spp', 'solar', 'hub', 'elevator', 'cement', 'railterm', 'port']);
function drawFence(ctx, o, toS, z, dpr, part) {
  if (OPEN_SITE.has(o.kind)) return; // магазины, АЗС и ТЦ открыты с улицы — без ограды
  const hard = HARD_FENCE.has(o.kind), Hf = hard ? 2.6 : 1.8;
  const hw = o.w / 2 + 8, hh = o.h / 2 + 8, c = Math.cos(o.angle), s = Math.sin(o.angle);
  const W = (u, v) => [o.x + u * c - v * s, o.y + u * s + v * c];
  // стороны: 0 — +u, π/2 — +v, π — −u, −π/2 — −v; ворота — на стороне gateQ
  const gq = o.gateQ ?? Math.PI / 2;
  const gside = Math.abs(Math.cos(gq)) > 0.5 ? (Math.cos(gq) > 0 ? 0 : 2) : (Math.sin(gq) > 0 ? 1 : 3);
  const sides = [[[hw, -hh], [hw, hh]], [[hw, hh], [-hw, hh]], [[-hw, hh], [-hw, -hh]], [[-hw, -hh], [hw, -hh]]];
  const gate = 5;
  const runs = [];
  sides.forEach(([p, q], i) => {
    if (i !== gside) { runs.push([p, q]); return; }
    const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], L = Math.hypot(q[0] - p[0], q[1] - p[1]), d = [(q[0] - p[0]) / L, (q[1] - p[1]) / L];
    runs.push([p, [m[0] - d[0] * gate, m[1] - d[1] * gate]], [[m[0] + d[0] * gate, m[1] + d[1] * gate], q]);
  });
  // дальние от зрителя стороны рисуем до сооружений, ближние — после (перекрывают правильно)
  const cy = toS(o.x, o.y)[1];
  const mine = (p, q) => { const my = toS(...W((p[0] + q[0]) / 2, (p[1] + q[1]) / 2))[1]; return part === 'back' ? my < cy : my >= cy; };
  for (let i = runs.length - 1; i >= 0; i--) if (!mine(...runs[i])) runs.splice(i, 1);
  const P = (u, v, h) => { const [x, y] = W(u, v); const [sx, sy] = toS(x, y); return [sx, sy - h * K3 * z]; };
  const G = (u, v, h) => { const [x, y] = W(u, v); const [sx, sy] = toS(x + 0.3 * h, y + 0.34 * h); return [sx, sy]; };
  // тень забора
  ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = Math.max(1, (hard ? 1.2 : 0.6) * z * 2);
  ctx.beginPath();
  for (const [p, q] of runs) { const A = G(p[0], p[1], Hf), B = G(q[0], q[1], Hf); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); }
  ctx.stroke();
  // полотно: у бетонного — плиты (заливка между низом и верхом), у сетчатого — прозрачная сетка
  for (const [p, q] of runs) {
    const a0 = P(p[0], p[1], 0), b0 = P(q[0], q[1], 0), a1 = P(p[0], p[1], Hf), b1 = P(q[0], q[1], Hf);
    ctx.beginPath(); ctx.moveTo(a0[0], a0[1]); ctx.lineTo(b0[0], b0[1]); ctx.lineTo(b1[0], b1[1]); ctx.lineTo(a1[0], a1[1]); ctx.closePath();
    ctx.fillStyle = hard ? 'rgba(168,164,152,0.95)' : 'rgba(150,160,150,0.25)'; ctx.fill();
    ctx.strokeStyle = hard ? 'rgba(90,88,82,0.9)' : 'rgba(110,118,112,0.8)'; ctx.lineWidth = Math.max(0.6, 0.15 * z * 4);
    ctx.beginPath(); ctx.moveTo(a1[0], a1[1]); ctx.lineTo(b1[0], b1[1]); ctx.stroke();
    if (z > 0.8) {
      // столбы / стыки плит через 3 м
      const L = Math.hypot(q[0] - p[0], q[1] - p[1]), n = Math.floor(L / 3);
      ctx.beginPath();
      for (let k = 0; k <= n; k++) { const t = k / Math.max(1, n), u = p[0] + (q[0] - p[0]) * t, v = p[1] + (q[1] - p[1]) * t; const A = P(u, v, 0), B = P(u, v, Hf + (hard ? 0.3 : 0)); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); }
      ctx.strokeStyle = hard ? 'rgba(120,116,108,0.9)' : 'rgba(80,86,82,0.9)'; ctx.lineWidth = Math.max(0.5, 0.12 * z * 4); ctx.stroke();
      if (hard) { // «колючка» поверху
        ctx.strokeStyle = 'rgba(60,60,58,0.7)'; ctx.lineWidth = Math.max(0.4, 0.06 * z * 4);
        ctx.beginPath(); const a2 = P(p[0], p[1], Hf + 0.5), b2 = P(q[0], q[1], Hf + 0.5); ctx.moveTo(a2[0], a2[1]); ctx.lineTo(b2[0], b2[1]); ctx.stroke();
      }
    }
  }
  // ворота: шлагбаум и будка охраны
  if (!mine(...sides[gside])) return;
  const [gp, gq2] = sides[gside], gm = [(gp[0] + gq2[0]) / 2, (gp[1] + gq2[1]) / 2], L = Math.hypot(gq2[0] - gp[0], gq2[1] - gp[1]), d = [(gq2[0] - gp[0]) / L, (gq2[1] - gp[1]) / L];
  if (z > 0.5) {
    const A = P(gm[0] - d[0] * gate, gm[1] - d[1] * gate, 1), B = P(gm[0] + d[0] * (gate - 1), gm[1] + d[1] * (gate - 1), 1);
    ctx.strokeStyle = '#d23a2a'; ctx.lineWidth = Math.max(0.8, 0.25 * z * 4); ctx.setLineDash([3 * z, 3 * z]);
    ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = '#f2f0ea'; ctx.lineWidth = Math.max(0.4, 0.12 * z * 4); ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
  }
  if (hard) {
    // будка КПП внутри у ворот
    const nIn = gside === 0 ? [-1, 0] : gside === 2 ? [1, 0] : gside === 1 ? [0, -1] : [0, 1];
    const bu = gm[0] - d[0] * (gate + 4) + nIn[0] * 4, bv = gm[1] - d[1] * (gate + 4) + nIn[1] * 4;
    const corners = [[-1.8, -1.4], [1.8, -1.4], [1.8, 1.4], [-1.8, 1.4]];
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); corners.forEach(([du, dv], i) => { const q = G(bu + du, bv + dv, 2.6); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); ctx.fill();
    ctx.fillStyle = '#c9c4b6'; ctx.beginPath(); corners.forEach(([du, dv], i) => { const q = P(bu + du, bv + dv, 0); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); ctx.fill();
    ctx.fillStyle = '#6f7b83'; ctx.beginPath(); corners.forEach(([du, dv], i) => { const q = P(bu + du, bv + dv, 2.6); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); ctx.fill();
  }
}
// ---------- Связи внутри объекта: ошиновка от ОРУ к трансформаторам, токопроводы от блоков,
// газоходы к трубе, кабели солнечных полей, трубопроводы резервуарного парка ----------
const ORU_H = (c) => (c.w > 100 || /330/.test(c.name) ? 13 : 8.5);
function edgeToward(c, px, py, inset = 3) {
  // точка на границе прямоугольника узла в сторону (px, py)
  const cs = Math.cos(c.angle), sn = Math.sin(c.angle);
  const lx = (px - c.x) * cs + (py - c.y) * sn, ly = -(px - c.x) * sn + (py - c.y) * cs;
  const hw = Math.max(1, c.w / 2 - inset), hh = Math.max(1, c.h / 2 - inset);
  const k = Math.min(hw / (Math.abs(lx) || 1e-6), hh / (Math.abs(ly) || 1e-6), 1);
  const u = lx * k, v = ly * k;
  return [c.x + u * cs - v * sn, c.y + u * sn + v * cs];
}
function nearestComp(list, c) { let b = null, bd = Infinity; for (const q of list) { const d = Math.hypot(q.x - c.x, q.y - c.y); if (d < bd) { bd = d; b = q; } } return b; }
// Возвращает элементы {y, draw} — их рисуют вперемешку с сооружениями по глубине (y), чтобы
// газоход уходил за трубу, а шины — за портал
function linkItems(ctx, o, toS, z, dpr) {
  const out = [];
  const alive = o.comps.filter((c) => c.state !== 'destroyed');
  if (alive.length < 2) return out;
  const by = (...k) => alive.filter((c) => k.includes(c.k));
  const SHX = 0.3, SHY = 0.34;
  // локальная система площадки: u — вдоль длинной оси, v — поперёк; разводка идёт по осям
  const cs = Math.cos(o.angle), sn = Math.sin(o.angle);
  const Wp = (u, v) => [o.x + u * cs - v * sn, o.y + u * sn + v * cs];
  const P = (u, v, h, shadow) => { const [x, y] = Wp(u, v); const [sx, sy] = toS(shadow ? x + SHX * h : x, shadow ? y + SHY * h : y); return [sx, sy - (shadow ? 0 : h * K3 * z)]; };
  // Ортогональная трасса от края узла A к краю узла B: прямо, если узлы перекрываются по одной из
  // осей, иначе — «Г» с поворотом у B. Возвращает точки (u, v)
  const ortho = (A, B, inA = 0, inB = 0) => {
    const ou0 = Math.max(A.u - A.w / 2, B.u - B.w / 2), ou1 = Math.min(A.u + A.w / 2, B.u + B.w / 2);
    const ov0 = Math.max(A.v - A.h / 2, B.v - B.h / 2), ov1 = Math.min(A.v + A.h / 2, B.v + B.h / 2);
    if (ou1 - ou0 > 1) {
      const u = Math.max(ou0 + 0.5, Math.min(ou1 - 0.5, A.u)), sg = Math.sign(B.v - A.v) || 1;
      return [[u, A.v + sg * (A.h / 2 - inA)], [u, B.v - sg * (B.h / 2 - inB)]];
    }
    if (ov1 - ov0 > 1) {
      const v = Math.max(ov0 + 0.5, Math.min(ov1 - 0.5, A.v)), sg = Math.sign(B.u - A.u) || 1;
      return [[A.u + sg * (A.w / 2 - inA), v], [B.u - sg * (B.w / 2 - inB), v]];
    }
    const sv = Math.sign(B.v - A.v) || 1, su = Math.sign(B.u - A.u) || 1;
    return [[A.u, A.v + sv * (A.h / 2 - inA)], [A.u, B.v], [B.u - su * (B.w / 2 - inB), B.v]];
  };
  // провода (фазы) между двумя точками: тень на земле, затем провод с провисом
  const depth = (pts) => { let y = -Infinity; for (let i = 0; i < pts.length; i++) y = Math.max(y, Wp(pts[i][0], pts[i][1])[1]); return y; };
  const wire = (a, h0, b, h1, phases, gap, col, w, sag = 0.25) => out.push({ y: (Wp(...a)[1] + Wp(...b)[1]) / 2, draw: () => wire0(a, h0, b, h1, phases, gap, col, w, sag) });
  const duct = (pts, h, wd, col, legs = 12) => { for (let i = 1; i < pts.length; i++) out.push({ y: depth([pts[i - 1], pts[i]]) - 0.5, draw: () => duct0([pts[i - 1], pts[i]], h, wd, col, legs, i > 1) }); };
  const tray = (pts, w, col) => out.push({ y: -Infinity, draw: () => tray0(pts, w, col) });
  const wire0 = (a, h0, b, h1, phases, gap, col, w, sag = 0.25) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nu = -(b[1] - a[1]) / L, nv = (b[0] - a[0]) / L;
    for (const pass of [0, 1]) {
      ctx.strokeStyle = pass ? col : 'rgba(0,0,0,0.18)';
      ctx.lineWidth = Math.max(pass ? 0.8 : 0.6, w * z);
      ctx.beginPath();
      for (let i = 0; i < phases; i++) {
        const o2 = (i - (phases - 1) / 2) * gap;
        const au = a[0] + nu * o2, av = a[1] + nv * o2, bu = b[0] + nu * o2, bv = b[1] + nv * o2;
        const hm = (h0 + h1) / 2 - L * sag * 0.08;
        const A = P(au, av, h0, !pass), B = P(bu, bv, h1, !pass), M = P((au + bu) / 2, (av + bv) / 2, hm, !pass);
        ctx.moveTo(A[0], A[1]); ctx.quadraticCurveTo(2 * M[0] - (A[0] + B[0]) / 2, 2 * M[1] - (A[1] + B[1]) / 2, B[0], B[1]);
      }
      ctx.stroke();
    }
  };
  // короб на эстакаде (газоход, закрытый токопровод, трубопровод): тень, опоры, боковина и верх
  const duct0 = (pts, h, wd, col, legs, joint) => {
    const dk = shade(col, 0.72);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nu = (-(b[1] - a[1]) / L) * wd / 2, nv = ((b[0] - a[0]) / L) * wd / 2;
      const quad = (hh, sh) => { const q = [P(a[0] + nu, a[1] + nv, hh, sh), P(b[0] + nu, b[1] + nv, hh, sh), P(b[0] - nu, b[1] - nv, hh, sh), P(a[0] - nu, a[1] - nv, hh, sh)]; ctx.beginPath(); q.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); };
      ctx.fillStyle = 'rgba(0,0,0,0.2)'; quad(h, true); ctx.fill();
      if (legs && h > 2 && z > 0.35) {
        ctx.strokeStyle = 'rgba(70,70,66,0.9)'; ctx.lineWidth = Math.max(0.6, 0.35 * z);
        ctx.beginPath();
        for (let t = 0; t <= L; t += legs) { const u = a[0] + ((b[0] - a[0]) * t) / L, v = a[1] + ((b[1] - a[1]) * t) / L; const G = P(u, v, 0), T = P(u, v, h - wd * 0.3); ctx.moveTo(G[0], G[1]); ctx.lineTo(T[0], T[1]); }
        ctx.stroke();
      }
      // боковина (толщина короба) и крышка
      const th = Math.min(wd, 4);
      const s0 = [P(a[0] + nu, a[1] + nv, h, false), P(b[0] + nu, b[1] + nv, h, false), P(b[0] + nu, b[1] + nv, h - th, false), P(a[0] + nu, a[1] + nv, h - th, false)];
      const s1 = [P(a[0] - nu, a[1] - nv, h, false), P(b[0] - nu, b[1] - nv, h, false), P(b[0] - nu, b[1] - nv, h - th, false), P(a[0] - nu, a[1] - nv, h - th, false)];
      ctx.fillStyle = dk;
      for (const q of [s0, s1]) { ctx.beginPath(); q.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.fill(); }
      ctx.fillStyle = col; quad(h, false); ctx.fill();
    }
    // стык на повороте — крышкой, чтобы короб не «ломался»
    if (joint) { const [u, v] = pts[0], r = wd / 2; const q = [P(u - r, v - r, h), P(u + r, v - r, h), P(u + r, v + r, h), P(u - r, v + r, h)]; ctx.fillStyle = col; ctx.beginPath(); q.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.fill(); }
  };
  // кабель в лотке по земле
  const tray0 = (pts, w, col) => {
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(0.7, w * z); ctx.lineJoin = 'round';
    ctx.beginPath(); pts.forEach(([u, v], k) => { const p = P(u, v, 0.2, false); if (k) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.stroke();
  };
  const near = (list, c) => nearestComp(list, c);
  const orus = by('oru');
  // трансформаторы → ОРУ: шины прямо к ячейке (автотрансформатор — к обоим напряжениям);
  // несколько блочных трансформаторов к одному ОРУ — каждый на своей высоте, пучком
  const toOru = new Map();
  // обесточена подстанция или повреждён трансформатор — разъединители его ячейки разомкнуты
  const deadPs = o.supply !== undefined && o.supply < 0.05;
  const openAt = (a, b, h, T) => out.push({ y: (Wp(...a)[1] + Wp(...b)[1]) / 2 + 0.1, draw: () => {
    const m = [a[0] + (b[0] - a[0]) * 0.75, a[1] + (b[1] - a[1]) * 0.75], m2 = [a[0] + (b[0] - a[0]) * 0.82, a[1] + (b[1] - a[1]) * 0.82];
    const A = P(m[0], m[1], h), B = P(m2[0], m2[1], h + 3.5);
    ctx.strokeStyle = '#c9ccc4'; ctx.lineWidth = Math.max(1, 0.35 * z);
    ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke(); // поднятый нож разъединителя
    if (z > 0.6) { ctx.fillStyle = T.state === 'ok' ? '#e0b030' : '#ef5a4a'; ctx.beginPath(); ctx.arc(A[0], A[1], Math.max(1.5, 0.5 * z), 0, Math.PI * 2); ctx.fill(); }
  } });
  for (const T of by('at', 'gsu', 'tr')) {
    const targets = T.k === 'at' ? orus : orus.length ? [near(orus, T)] : [];
    for (const O of targets) {
      const k = toOru.get(O) || 0; toOru.set(O, k + 1);
      const r = ortho(T, O, T.w * 0.2, 3);
      const a = r[0], b = r[r.length - 1];
      const hT = T.k === 'tr' ? 4 : 6.5, hO = ORU_H(O) - (T.k === 'gsu' ? k * 1.6 : 0);
      if (r.length === 2) wire(a, hT, b, hO, 3, T.k === 'tr' ? 1.2 : 2.2, 'rgba(70,72,68,0.95)', 0.35);
      else { wire(a, hT, r[1], hO, 3, 2.2, 'rgba(70,72,68,0.95)', 0.35); wire(r[1], hO, b, hO, 3, 2.2, 'rgba(70,72,68,0.95)', 0.35, 0.1); }
      if (deadPs || T.state !== 'ok') openAt(r[r.length - 2], b, hO, T);
    }
  }
  // энергоблок / гидроагрегат → блочный трансформатор: закрытый токопровод
  const gsus = by('gsu');
  for (const U of by('unit', 'hgen')) { const G = near(gsus, U); if (G) duct(ortho(U, G, 1, 1), 5, 2.4, '#8d8f88', 8); }
  // энергоблок → дымовая труба: газоход коробом на эстакаде, входит в трубу сбоку
  const ch = by('chimney');
  for (const U of by('unit')) { const C = near(ch, U); if (C) duct(ortho(U, C, 1, 1), 14, 5.5, '#8a857a', 14); }
  // солнечные поля → инверторная → ОРУ: кабельные лотки
  const inv = by('inv');
  for (const Pv of by('pv')) { const I = near(inv, Pv); if (I) tray(ortho(Pv, I, 1, 1), 0.5, 'rgba(40,40,38,0.8)'); }
  for (const I of inv) { const O = near(orus, I); if (O) tray(ortho(I, O, 1, 2), 0.6, 'rgba(40,40,38,0.8)'); }
  const trs = by('tr');
  for (const B of by('bess')) { const T = near(trs, B); if (T) tray(ortho(B, T, 1, 1), 0.6, 'rgba(40,40,38,0.8)'); }
  // резервуарный парк: от каждого резервуара — отвод к коллектору вдоль ряда, коллекторы сходятся
  // в магистраль к насосной и эстакаде налива (всё на низких опорах)
  const hubs = by('pump', 'shop', 'rack', 'hall');
  const tanks = by('tank');
  if (hubs.length && tanks.length > 1) {
    const rows = new Map();
    for (const t of tanks) { const k = Math.round(t.v / 8); (rows.get(k) || rows.set(k, []).get(k)).push(t); }
    const H0 = near(hubs, tanks[0]);
    const su = Math.sign(H0.u - tanks[0].u) || 1;
    const colU = H0.u - su * (H0.w / 2 + 6); // магистраль вдоль v у насосной
    let v0 = Infinity, v1 = -Infinity;
    const pc = '#9c968b';
    for (const row of rows.values()) {
      const vr = row[0].v + row[0].h / 2 + 5; // коллектор ряда — в проезде за резервуарами
      const us = row.map((t) => t.u);
      const far = su > 0 ? Math.min(...us) : Math.max(...us);
      duct([[far, vr], [colU, vr]], 1.4, 0.9, pc, 6);
      for (const t of row) duct([[t.u, t.v + t.h / 2], [t.u, vr]], 1.4, 0.7, pc, 0);
      v0 = Math.min(v0, vr); v1 = Math.max(v1, vr);
    }
    for (const H of hubs) { v0 = Math.min(v0, H.v); v1 = Math.max(v1, H.v); }
    duct([[colU, v0], [colU, v1]], 1.4, 1.1, pc, 6);
    for (const H of hubs) duct([[colU, H.v], [H.u - su * (H.w / 2), H.v]], 1.4, 0.9, pc, 0);
  }
  return out;
}
// затемнить цвет #rrggbb
function shade(hex, k) { const n = parseInt(hex.slice(1), 16); return `rgb(${((n >> 16) & 255) * k | 0},${((n >> 8) & 255) * k | 0},${(n & 255) * k | 0})`; }
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
  const night = 1 - daylight(sim.tod());
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
      const items = [...o.comps, ...(z > 0.12 ? linkItems(ctx, o, toS, z, dpr) : [])].sort((a, b) => a.y - b.y);
      const fenced = z > 0.2 && o.kind !== 'bridge' && o.kind !== 'pontoon' && o.kind !== 'wpp';
      if (fenced) drawFence(ctx, o, toS, z, dpr, 'back');
      for (const c of items) {
        if (c.draw) { c.draw(); continue; }
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
      if (fenced) drawFence(ctx, o, toS, z, dpr, 'front');
      // Пар градирен и дым труб — пока блоки работают
      const units = o.comps.filter((c) => c.k === 'unit' && c.state === 'ok').length;
      // пар и дым — по фактической выработке (разгрузка при нехватке угля или сети видна сразу)
      const cap = o.kind === 'tpp' ? 750 : o.kind === 'chp' ? 140 : 0;
      const load = cap && o.gen !== undefined ? Math.min(1, o.gen / cap) : units / 3;
      if ((o.kind === 'tpp' || o.kind === 'chp') && units && load > 0.02) {
        for (const c of o.comps) {
          if (c.k === 'tower' && c.state === 'ok') plume(ctx, toS, c.x, c.y, 76, z, now, 'steam', load, c.x * 3);
          if (c.k === 'chimney' && c.state === 'ok') plume(ctx, toS, c.x, c.y, o.kind === 'chp' ? 80 : 120, z, now, 'smoke', load, c.y * 3);
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

  // ---------- Бои на линии фронта: разрывы артиллерии и дым над серой зоной ----------
  if (sim.world.front) drawFrontFire(ctx, sim.world, toS, inView, z, now, dpr);
  // ---------- Последние пролёты ЛЭП: от опоры к концевому порталу ОРУ, провода на высоте траверсы ----------
  if (z > 0.08) drawLineEnds(ctx, g, sim.world, side, toS, inView, z);
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
    // макет ЗРК выглядит как настоящий ЗРК (у своих подписан «МАК»)
    const vt = a.type === 'dummy' ? 'sam' : a.type;
    if (z >= 1.3) {
      const heading = a.state === 'moving' ? a.heading : a.heading;
      const hk = vt === 'sam' ? `sam:${a.side}:hull` : `dwad:${a.type}:${a.side}:hull`;
      const hb = vt === 'sam' ? MODELS[hk] : () => buildAD(a.type, a.side, 'hull');
      const r = spriteFor(hk, hb, heading, z, undefined, now);
      if (r) drawSprite(ctx, r, sx, sy, z, r.residual);
      const turret = vt === 'sam' ? `sam:${a.side}:turret` : a.type === 'mog' || a.type === 'spaag' || a.type === 'radar' ? `dwad:${a.type}:${a.side}:turret` : null;
      if (turret) {
        const tb = vt === 'sam' ? MODELS[turret] : () => buildAD(a.type, a.side, 'turret');
        const ta = a.type === 'radar' ? (now / 1400) % (Math.PI * 2) : a.target ? a.aim : heading;
        const piv = a.type === 'sam' ? -1.4 : a.type === 'mog' ? -1.5 : a.type === 'radar' ? -2 : a.type === 'spaag' && a.side === 'red' ? -2 : 0;
        const rt = spriteFor(turret, tb, ta, z, undefined, now);
        if (rt) drawSprite(ctx, rt, sx + Math.cos(heading) * piv * z, sy + Math.sin(heading) * piv * z, z, rt.residual);
      }
      if (a.state === 'deploying') ring(ctx, sx, sy - 8 * dpr, 7 * dpr, 1 - (a.until - t) / DW_AD[a.type].deploy, '#ffd36b', dpr);
    } else {
      badge(ctx, sx, sy, a.type === 'dummy' && own ? 'МАК' : AD_GLYPH[vt], own ? SIDE_COL[a.side] : '#ff7d72', dpr, sel, !own);
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

  // ---------- Ямы на дорогах: дорожная бригада засыпает (кольцо — ход работ) ----------
  for (const h of g.roadHoles || []) {
    if (!inView(h.x, h.y, 30)) continue;
    const [sx, sy] = toS(h.x, h.y);
    if (h.fixAt > 1) ring(ctx, sx, sy - 10 * dpr, 7 * dpr, 1 - (h.fixAt - t) / 180, '#ffd36b', dpr);
    if (z > 0.4) { ctx.fillStyle = '#e0b030'; ctx.fillRect(sx + 6 * z, sy - 2 * z, Math.max(3 * dpr, 4 * z), Math.max(2 * dpr, 2 * z)); } // конус / каток
  }
  // ---------- Поезда, люди, пыль, фары, пожары на полях, временные обходы ЛЭП ----------
  drawExtras(ctx, g, sim, view, side, toS, inView, now, t, night, fire);

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
