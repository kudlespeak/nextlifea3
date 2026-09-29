// Отрисовка отрядов: тактические знаки (издалека) и техника сверху (вблизи),
// маршруты, выделение, пыль из-под колёс.

import { SIDES } from '../sim/units.js';
import { FACTIONS } from '../sim/factions.js';
import { DRONE_KINDS } from '../sim/drones.js';
import { T } from '../sim/nav.js';

const SPRITE_ZOOM = 1.6; // device px/м, с которого рисуем технику

// ---------- Тактический знак ----------
// Синие — прямоугольник, Красные — ромб (как «свои/противник» в НАТО-символике)
export function drawSymbol(ctx, x, y, s, side, symbol, opts = {}) {
  const sd = SIDES[side];
  const w = s * 1.5, h = s;
  ctx.save();
  ctx.translate(x, y);
  ctx.lineJoin = 'round';
  if (opts.selected) {
    ctx.shadowColor = '#b8ff6b';
    ctx.shadowBlur = s * 0.6;
  }
  ctx.beginPath();
  if (side === 'blue') ctx.rect(-w / 2, -h / 2, w, h);
  else {
    const r = s * 0.78;
    ctx.moveTo(0, -r); ctx.lineTo(r, 0); ctx.lineTo(0, r); ctx.lineTo(-r, 0); ctx.closePath();
  }
  ctx.fillStyle = sd.fill;
  ctx.globalAlpha = opts.alpha ?? 1;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(1.5, s * 0.09);
  ctx.strokeStyle = opts.selected ? '#d8ff9a' : '#111';
  ctx.stroke();
  ctx.clip();

  // Иконка рода войск
  ctx.strokeStyle = '#111';
  ctx.fillStyle = '#111';
  ctx.lineWidth = Math.max(1.2, s * 0.07);
  const iw = side === 'blue' ? w / 2 : s * 0.42, ih = side === 'blue' ? h / 2 : s * 0.42;
  const cross = () => {
    ctx.beginPath();
    ctx.moveTo(-iw, -ih); ctx.lineTo(iw, ih);
    ctx.moveTo(iw, -ih); ctx.lineTo(-iw, ih);
    ctx.stroke();
  };
  const oval = (k = 1) => {
    ctx.beginPath();
    ctx.ellipse(0, 0, iw * 0.62 * k, ih * 0.5 * k, 0, 0, Math.PI * 2);
    ctx.stroke();
  };
  switch (symbol) {
    case 'inf': cross(); break;
    case 'mech': cross(); oval(); break;
    case 'motor':
      cross();
      ctx.beginPath();
      ctx.moveTo(0, -ih); ctx.lineTo(0, ih);
      ctx.stroke();
      break;
    case 'armor': oval(1.1); break;
    case 'arty':
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.13, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'mortar':
      // Миномёт: точка и стрелка вверх
      ctx.beginPath();
      ctx.arc(0, ih * 0.35, s * 0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, ih * 0.25); ctx.lineTo(0, -ih * 0.7);
      ctx.moveTo(-iw * 0.25, -ih * 0.4); ctx.lineTo(0, -ih * 0.75); ctx.lineTo(iw * 0.25, -ih * 0.4);
      ctx.stroke();
      break;
    case 'eng':
    case 'engmech': {
      // Инженерный знак — «мостик» с опорами
      const ew = iw * 0.75, eh = ih * 0.45;
      ctx.beginPath();
      ctx.moveTo(-ew, eh); ctx.lineTo(-ew, -eh); ctx.lineTo(ew, -eh); ctx.lineTo(ew, eh);
      ctx.moveTo(0, -eh); ctx.lineTo(0, eh * 0.6);
      ctx.stroke();
      if (symbol === 'engmech') {
        ctx.beginPath();
        ctx.ellipse(0, ih * 0.62, iw * 0.35, ih * 0.2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
    case 'uav': {
      // БПЛА: «птичка» над линией
      ctx.beginPath();
      ctx.moveTo(-iw * 0.6, -ih * 0.3); ctx.lineTo(0, ih * 0.25); ctx.lineTo(iw * 0.6, -ih * 0.3);
      ctx.stroke();
      break;
    }
    case 'medic':
      ctx.lineWidth = Math.max(2, s * 0.12);
      ctx.beginPath();
      ctx.moveTo(0, -ih * 0.6); ctx.lineTo(0, ih * 0.6);
      ctx.moveTo(-ih * 0.6, 0); ctx.lineTo(ih * 0.6, 0);
      ctx.stroke();
      break;
    case 'supply':
      ctx.beginPath();
      ctx.moveTo(-iw, ih * 0.45); ctx.lineTo(iw, ih * 0.45);
      ctx.stroke();
      break;
  }
  ctx.restore();
}

// ---------- Техника сверху (координаты в метрах, ось X — вперёд) ----------
// Палитра камуфляжа текущей отрисовываемой машины (зависит от стороны)
let P = FACTIONS.red.camo;

function shadowRect(ctx, x, y, w, h) {
  ctx.fillStyle = 'rgba(10,12,6,0.45)';
  ctx.fillRect(x + 0.7, y + 0.7, w, h);
}

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// Анимационное состояние машины: пробег (гусеницы/колёса), угол башни, откат ствола
function vehAnim(u, now) {
  const a = u._anim || (u._anim = { tur: u.heading, t: now, recoilSeen: u.recoil, recoilRT: 0 });
  const dt = Math.min(0.1, (now - a.t) / 1000);
  a.t = now;
  // Башня: на цель, если стреляли недавно, иначе — по ходу
  const want = u.aim !== undefined && u.aimAt !== undefined && (u._simTime ?? 0) - u.aimAt < 25 ? u.aim : u.heading;
  const d = Math.atan2(Math.sin(want - a.tur), Math.cos(want - a.tur));
  a.tur += Math.max(-dt * 1.4, Math.min(dt * 1.4, d));
  if (u.recoil !== a.recoilSeen) { a.recoilSeen = u.recoil; a.recoilRT = now; }
  const rk = Math.max(0, 1 - (now - a.recoilRT) / 350);
  return { odo: u.odo || 0, tur: a.tur - u.heading, recoil: rk * rk, moving: u.state === 'moving' && u.speed > 0.3, now };
}

// Гусеница: лента с траками, которые «бегут» с пробегом
function track(ctx, x, y, L, w, odo) {
  ctx.fillStyle = P.track;
  ctx.fillRect(x, y, L, w);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 0.09;
  const step = 0.42, off = -((odo % step) + step) % step;
  ctx.beginPath();
  for (let t = x + off + step; t < x + L; t += step) { ctx.moveTo(t, y + 0.04); ctx.lineTo(t, y + w - 0.04); }
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(x, y, L, w * 0.25);
}

// Колесо сверху: шина с протектором, «бегущим» при движении
function wheel(ctx, x, y, odo) {
  ctx.fillStyle = '#1d1e18';
  ctx.fillRect(x - 0.52, y - 0.2, 1.04, 0.4);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 0.06;
  const ph = ((odo / 0.35) % 1 + 1) % 1;
  ctx.beginPath();
  for (let k = 0; k < 3; k++) { const t = x - 0.52 + ((k + ph) / 3) * 1.04; ctx.moveTo(t, y - 0.2); ctx.lineTo(t, y + 0.2); }
  ctx.stroke();
}

// Камуфляжные пятна по корпусу (детерминированно по id машины)
function blotches(ctx, u, x, y, w, h) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  let seed = u.id * 9301 + 49297;
  const rnd = () => ((seed = (seed * 233280 + 12345) % 1000003) / 1000003);
  for (let i = 0; i < 7; i++) {
    ctx.fillStyle = i % 2 ? P.dark : P.spot || P.light;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.ellipse(x + rnd() * w, y + rnd() * h, 0.4 + rnd() * 0.9, 0.25 + rnd() * 0.5, rnd() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  // Контур и блик сверху
  ctx.strokeStyle = 'rgba(15,16,10,0.7)';
  ctx.lineWidth = 0.09;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = 'rgba(255,255,230,0.08)';
  ctx.fillRect(x, y, w, h * 0.35);
}

function panelLines(ctx, lines) {
  ctx.strokeStyle = 'rgba(0,0,0,0.28)';
  ctx.lineWidth = 0.06;
  ctx.beginPath();
  for (const [x0, y0, x1, y1] of lines) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
  ctx.stroke();
}

function gun(ctx, x0, len, w, recoil, brake = true) {
  const r = recoil * 0.45;
  ctx.fillStyle = P.dark;
  ctx.fillRect(x0 - r, -w / 2, len, w);
  if (brake) ctx.fillRect(x0 + len - 0.35 - r, -w * 0.85, 0.35, w * 1.7);
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fillRect(x0 - r, -w / 2, len, w * 0.3);
}

const SPRITES = {
  tank(ctx, u, z, A) {
    shadowRect(ctx, -3.7, -1.85, 7.4, 3.7);
    track(ctx, -3.6, -1.82, 7.2, 0.72, A.odo);
    track(ctx, -3.6, 1.1, 7.2, 0.72, A.odo);
    // Корпус: крылья, лобовой лист, МТО с решётками
    ctx.fillStyle = P.dark;
    ctx.fillRect(-3.55, -1.25, 7.1, 2.5);
    rrect(ctx, -3.3, -1.12, 6.7, 2.24, 0.25);
    ctx.fillStyle = P.body;
    ctx.fill();
    blotches(ctx, u, -3.3, -1.12, 6.7, 2.24);
    ctx.beginPath(); ctx.moveTo(2.3, -1.12); ctx.lineTo(3.55, -0.75); ctx.lineTo(3.55, 0.75); ctx.lineTo(2.3, 1.12); ctx.closePath();
    ctx.fillStyle = P.light; ctx.fill();
    ctx.fillStyle = P.dark;
    for (let i = 0; i < 5; i++) ctx.fillRect(-3.15 + i * 0.3, -0.85, 0.16, 1.7); // решётки МТО
    panelLines(ctx, [[-1.6, -1.12, -1.6, 1.12], [2.3, -1.12, 2.3, 1.12]]);
    // Бочки/ящики ЗИП на крыльях
    ctx.fillStyle = '#4a4a38';
    ctx.fillRect(-3.1, -1.5, 0.9, 0.3); ctx.fillRect(-3.1, 1.2, 0.9, 0.3);
    // Башня
    ctx.save();
    ctx.translate(0.1, 0);
    ctx.rotate(A.tur);
    gun(ctx, 1.2, 4.7, 0.24, A.recoil);
    ctx.beginPath();
    if (u.side === 'blue') {
      ctx.moveTo(1.7, -1.05); ctx.lineTo(1.7, 1.05); ctx.lineTo(-1.1, 1.35); ctx.lineTo(-2.5, 1.0); ctx.lineTo(-2.5, -1.0); ctx.lineTo(-1.1, -1.35); ctx.closePath();
    } else ctx.ellipse(0, 0, 1.6, 1.32, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.save(); ctx.translate(0.25, 0.25); ctx.fill(); ctx.restore();
    ctx.fillStyle = P.light;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 0.1; ctx.stroke();
    if (u.side === 'red') {
      ctx.fillStyle = P.dark;
      for (const [bx, by] of [[1.15, -0.85], [1.15, 0.85], [0.7, -1.15], [0.7, 1.15], [1.35, -0.4], [1.35, 0.4]]) ctx.fillRect(bx - 0.22, by - 0.18, 0.44, 0.36);
    } else {
      ctx.strokeStyle = P.dark; ctx.lineWidth = 0.1; ctx.strokeRect(-2.45, -0.8, 0.6, 1.6); // корзина
    }
    // Люки и прицел
    ctx.fillStyle = P.dark;
    ctx.beginPath(); ctx.arc(-0.5, -0.5, 0.36, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(-0.5, 0.55, 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1b2224'; ctx.fillRect(0.8, 0.45, 0.35, 0.28);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath(); ctx.arc(-0.55, -0.55, 0.14, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  },
  ifv(ctx, u, z, A) {
    shadowRect(ctx, -3.4, -1.65, 6.8, 3.3);
    track(ctx, -3.4, -1.62, 6.8, 0.6, A.odo);
    track(ctx, -3.4, 1.02, 6.8, 0.6, A.odo);
    rrect(ctx, -3.3, -1.15, 6.6, 2.3, 0.25);
    ctx.fillStyle = P.body; ctx.fill();
    blotches(ctx, u, -3.3, -1.15, 6.6, 2.3);
    ctx.beginPath(); ctx.moveTo(1.9, -1.15); ctx.lineTo(3.3, -0.6); ctx.lineTo(3.3, 0.6); ctx.lineTo(1.9, 1.15); ctx.closePath();
    ctx.fillStyle = P.light; ctx.fill();
    ctx.fillStyle = P.dark;
    ctx.fillRect(-3.2, -0.85, 1.25, 0.65); ctx.fillRect(-3.2, 0.2, 1.25, 0.65); // десантные люки
    ctx.fillRect(2.3, -0.9, 0.5, 0.35); // люк мехвода
    panelLines(ctx, [[-1.8, -1.15, -1.8, 1.15], [1.9, -1.15, 1.9, 1.15]]);
    ctx.save();
    ctx.translate(0.3, 0);
    ctx.rotate(A.tur);
    gun(ctx, 0.5, 2.9, 0.14, A.recoil, false);
    ctx.fillStyle = P.dark; ctx.fillRect(0.4, 0.35, 1.0, 0.16); // спарка / ПТУР
    ctx.beginPath(); ctx.roundRect(-0.9, -0.8, 1.8, 1.6, 0.35);
    ctx.fillStyle = P.light; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 0.08; ctx.stroke();
    ctx.fillStyle = P.dark; ctx.beginPath(); ctx.arc(-0.3, -0.3, 0.25, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  },
  apc(ctx, u, z, A) {
    shadowRect(ctx, -3.8, -1.45, 7.6, 2.9);
    for (let i = 0; i < 4; i++) {
      const x = -2.8 + i * 1.75;
      wheel(ctx, x, -1.28, A.odo);
      wheel(ctx, x, 1.28, A.odo);
    }
    ctx.beginPath();
    ctx.moveTo(-3.7, -1.12); ctx.lineTo(2.4, -1.12); ctx.lineTo(3.8, -0.45); ctx.lineTo(3.8, 0.45); ctx.lineTo(2.4, 1.12); ctx.lineTo(-3.7, 1.12);
    ctx.closePath();
    ctx.fillStyle = P.body; ctx.fill();
    blotches(ctx, u, -3.7, -1.12, 6.1, 2.24);
    ctx.fillStyle = P.light; ctx.fillRect(2.0, -0.95, 1.2, 1.9);
    ctx.fillStyle = '#243034'; ctx.fillRect(2.95, -0.7, 0.3, 0.5); ctx.fillRect(2.95, 0.2, 0.3, 0.5); // смотровые
    ctx.fillStyle = P.dark;
    ctx.fillRect(-3.5, -0.75, 0.9, 1.5); // решётка МТО
    ctx.fillRect(-1.6, -0.9, 0.8, 0.5); ctx.fillRect(-1.6, 0.4, 0.8, 0.5); // люки
    ctx.save();
    ctx.translate(0.9, 0);
    ctx.rotate(A.tur);
    gun(ctx, 0.3, 2.3, 0.12, A.recoil, false);
    ctx.beginPath(); ctx.arc(0, 0, 0.62, 0, Math.PI * 2);
    ctx.fillStyle = P.light; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 0.08; ctx.stroke();
    ctx.restore();
  },
  truck(ctx, u, z, A) {
    shadowRect(ctx, -4, -1.25, 8, 2.5);
    for (const x of [-3, -1.9, 2.7]) { wheel(ctx, x, -1.18, A.odo); wheel(ctx, x, 1.18, A.odo); }
    // Кабина с капотом
    ctx.fillStyle = '#56603d';
    ctx.fillRect(1.85, -1.1, 1.5, 2.2);
    ctx.fillStyle = '#4c5536';
    ctx.fillRect(3.3, -0.95, 0.9, 1.9);
    ctx.fillStyle = '#2b373b';
    ctx.fillRect(3.05, -0.95, 0.28, 1.9); // лобовое стекло
    ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(3.07, -0.9, 0.08, 0.8);
    // Кузов: тент с дугами или ящики со снарядами
    if (u.cargoRes && (u.cargoRes.ammo + u.cargoRes.shells) > 5 && u.type === 'truck') {
      ctx.fillStyle = '#4a4834'; ctx.fillRect(-4, -1.18, 5.7, 2.36);
      const fill = Math.min(1, (u.cargoRes.ammo + u.cargoRes.shells) / 120);
      const n = Math.round(fill * 12);
      for (let i = 0; i < n; i++) { ctx.fillStyle = i % 3 ? '#6d6644' : '#5c6a42'; ctx.fillRect(-3.8 + (i % 4) * 1.35, -1.0 + Math.floor(i / 4) * 0.68, 1.2, 0.58); }
      ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 0.06; ctx.strokeRect(-4, -1.18, 5.7, 2.36);
    } else {
      ctx.fillStyle = '#666b4c';
      ctx.fillRect(-4, -1.2, 5.7, 2.4);
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = 0.1;
      ctx.beginPath();
      for (let x = -3.4; x < 1.6; x += 0.9) { ctx.moveTo(x, -1.2); ctx.lineTo(x, 1.2); }
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fillRect(-4, -1.2, 5.7, 0.8);
    }
    if (u.type === 'medevac') {
      ctx.fillStyle = '#e8e4d8'; ctx.fillRect(-2.2, -0.55, 1.1, 1.1);
      ctx.fillStyle = '#c22'; ctx.fillRect(-1.8, -0.45, 0.3, 0.9); ctx.fillRect(-2.1, -0.15, 0.9, 0.3);
    }
  },
  arty(ctx, u, z, A) {
    // Тягач + орудие на прицепе (ствол назад по-походному) или развёрнутое орудие
    SPRITES.truck(ctx, u, z, A);
    ctx.fillStyle = P.dark;
    ctx.beginPath();
    ctx.moveTo(-4.2, 0); ctx.lineTo(-7, -1.1); ctx.lineTo(-7, 1.1);
    ctx.closePath();
    ctx.fill();
    wheel(ctx, -7.3, -1.2, A.odo); wheel(ctx, -7.3, 1.2, A.odo);
    ctx.fillStyle = P.body;
    ctx.fillRect(-7.9, -1.05, 1.5, 2.1);
    ctx.save();
    ctx.translate(-7.1, 0);
    ctx.fillStyle = '#3d4230';
    ctx.fillRect(-4.3 + A.recoil * 0.8, -0.13, 4.5, 0.26);
    ctx.fillRect(-4.5 + A.recoil * 0.8, -0.22, 0.4, 0.44);
    ctx.restore();
  },
  btm(ctx, u, z, A) {
    // Гусеничный тягач с траншейным рабочим органом сзади
    shadowRect(ctx, -4.5, -1.6, 9, 3.2);
    track(ctx, -3, -1.6, 6.6, 0.6, A.odo);
    track(ctx, -3, 1.0, 6.6, 0.6, A.odo);
    ctx.fillStyle = '#5a5a3c';
    ctx.fillRect(-2.9, -1.15, 6.4, 2.3);
    ctx.fillStyle = '#6a6a44';
    ctx.fillRect(1.6, -1.1, 1.8, 2.2);
    ctx.fillStyle = '#2f3a3e';
    ctx.fillRect(3.0, -0.9, 0.35, 1.8);
    ctx.fillStyle = '#3b3a30';
    ctx.fillRect(-5.2, -0.55, 2.4, 1.1);
    ctx.save();
    ctx.translate(-5.2, 0);
    ctx.rotate((A.odo + (u.task?.type === 'dig' ? A.now / 400 : 0)) % (Math.PI * 2));
    ctx.strokeStyle = '#2a2922';
    ctx.lineWidth = 0.35;
    ctx.beginPath(); ctx.arc(0, 0, 1.2, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 0.2;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; ctx.moveTo(Math.cos(a) * 0.9, Math.sin(a) * 0.9); ctx.lineTo(Math.cos(a) * 1.45, Math.sin(a) * 1.45); }
    ctx.stroke();
    ctx.restore();
  },
};
SPRITES.medevac = SPRITES.truck;

// ---------- Пыль ----------
const dust = [];
export function emitDust(sim, dtReal, timeScale) {
  for (const u of sim.units) {
    if (u.dead || u.def.move === 'foot') continue;
    // Выхлоп: на ходу и при разгоне — гуще
    if (u.state === 'moving' && Math.random() < dtReal * (u.type === 'tank' ? 7 : 4) * Math.min(3, Math.sqrt(timeScale))) {
      const c = Math.cos(u.heading), sn = Math.sin(u.heading);
      const back = u.type === 'truck' || u.type === 'arty' ? 1.5 : -3.6;
      dust.push({ x: u.x + c * back - sn * 0.9, y: u.y + sn * back + c * 0.9, t: 0, life: 1.2 + Math.random(), r: 0.5, smoke: true, vx: -c * 1.5, vy: -sn * 1.5 });
    }
    if (u.state !== 'moving' || u.speed < 2) continue;
    const c = sim.nav.classAt(u.x, u.y);
    if (c === T.ROAD) continue;
    const rate = (u.speed / 10) * (c === T.PLOWED || c === T.DIRT ? 14 : 8) * Math.min(4, Math.sqrt(timeScale));
    let n = rate * dtReal;
    while (n > 0) {
      if (n < 1 && Math.random() > n) break;
      n -= 1;
      const back = -4 - Math.random() * 2;
      dust.push({
        x: u.x + Math.cos(u.heading) * back + (Math.random() - 0.5) * 2,
        y: u.y + Math.sin(u.heading) * back + (Math.random() - 0.5) * 2,
        t: 0,
        life: 2 + Math.random() * 2,
        r: 1.5 + Math.random(),
      });
    }
  }
  for (let i = dust.length - 1; i >= 0; i--) {
    dust[i].t += dtReal;
    if (dust[i].t > dust[i].life) dust.splice(i, 1);
  }
  if (dust.length > 1500) dust.splice(0, dust.length - 1500);
}

// ---------- Основная отрисовка ----------
export function drawUnits(ctx, sim, view, ui, fogSide = null) {
  const hidden = (u) => fogSide && u.side !== fogSide && !sim.vision.now[fogSide].has(u.id);
  const { cam, canvas, dpr } = view;
  const toS = (x, y) => [(x - cam.x) * cam.zoom + canvas.width / 2, (y - cam.y) * cam.zoom + canvas.height / 2];
  const sel = ui.selected;
  const z = cam.zoom;
  const now = performance.now();

  // Пыль
  for (const p of dust) {
    const k = p.t / p.life;
    const [sx, sy] = toS(p.x + (p.vx || 0) * p.t, p.y + (p.vy || 0) * p.t);
    ctx.fillStyle = p.smoke ? `rgba(60,60,58,${0.4 * (1 - k)})` : `rgba(170,155,120,${0.35 * (1 - k)})`;
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(1, (p.r + k * (p.smoke ? 2.5 : 6)) * z), 0, Math.PI * 2);
    ctx.fill();
  }

  // Зачищенные участки траншей
  for (const c of sim.cleared) {
    trenchLine(ctx, c.line, toS, SIDES[c.side].fill, 5 * dpr, 0.35);
  }
  // Идёт зачистка: пройдено / впереди
  for (const u of sim.units) {
    if (u.task?.type !== 'clear') continue;
    const L = u.task.line;
    trenchLine(ctx, L.slice(0, u.task.progress + 1), toS, SIDES[u.side].fill, 5 * dpr, 0.5);
    trenchLine(ctx, L.slice(u.task.progress), toS, '#ff9d6b', 2 * dpr, 0.9, [4 * dpr, 4 * dpr]);
  }
  // Работы по рытью: план пунктиром, готовое сплошным, процент
  ctx.font = `700 ${11 * dpr}px "PT Sans", system-ui, sans-serif`;
  for (const job of sim.digJobs) {
    const pts = job.line.map(([x, y]) => ({ x, y }));
    trenchLine(ctx, pts, toS, '#ffd36b', 2 * dpr, 0.9, [6 * dpr, 4 * dpr]);
    const k = job.cum.findIndex((c) => c >= job.done);
    if (k > 0) trenchLine(ctx, pts.slice(0, k + 1), toS, '#ffd36b', 3.5 * dpr, 0.9);
    const [fx, fy] = toS(...sim.pointAt(job, job.done));
    const txt = `${Math.round((job.done / job.total) * 100)}% · ${Math.round(job.total)} м`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeText(txt, fx + 8 * dpr, fy);
    ctx.fillStyle = '#ffe9a8';
    ctx.fillText(txt, fx + 8 * dpr, fy);
  }

  // Маршруты выделенных
  for (const u of sim.units) {
    if (!sel.has(u.id) || !u.path) continue;
    ctx.beginPath();
    let [sx, sy] = toS(u.x, u.y);
    ctx.moveTo(sx, sy);
    for (let i = u.pathIdx; i < u.path.length; i++) {
      [sx, sy] = toS(u.path[i][0], u.path[i][1]);
      ctx.lineTo(sx, sy);
    }
    ctx.setLineDash([6 * dpr, 5 * dpr]);
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.stroke();
    ctx.lineWidth = 1.3 * dpr;
    ctx.strokeStyle = u.stealth ? 'rgba(170,230,140,0.95)' : 'rgba(255,230,140,0.95)';
    ctx.stroke();
    ctx.setLineDash([]);
    // Точка назначения
    ctx.beginPath();
    ctx.arc(sx, sy, 4 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = u.stealth ? '#aae68c' : '#ffe68c';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1 * dpr;
    ctx.stroke();
  }

  const sprites = z >= SPRITE_ZOOM;
  // Сначала техника (в мировом масштабе)
  if (sprites) {
    for (const u of sim.units) {
      const [sx, sy] = toS(u.x, u.y);
      if (sx < -200 || sy < -200 || sx > canvas.width + 200 || sy > canvas.height + 200) continue;
      if (hidden(u)) continue;
      if (u.soldiers) {
        if (!u.embarked) drawSoldiers(ctx, u, toS, z, dpr, ui, sim, now);
        continue;
      }
      if (u.dead || u.embarked) continue;
      if (sel.has(u.id)) {
        ctx.beginPath();
        ctx.arc(sx, sy, (u.def.move === 'foot' ? 10 : 7) * z, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(184,255,107,0.9)';
        ctx.lineWidth = 1.5 * dpr;
        ctx.setLineDash([4 * dpr, 3 * dpr]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      u._simTime = sim.time;
      const A = vehAnim(u, now);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(z, z);
      ctx.rotate(u.heading);
      // Лёгкое покачивание корпуса на ходу
      if (A.moving && u.def.move !== 'foot') ctx.translate(Math.sin(A.odo * 1.7) * 0.04, 0);
      P = FACTIONS[u.side].camo;
      (SPRITES[u.type] || SPRITES.truck)(ctx, u, z, A);
      // Опознавательная полоса цвета стороны
      if (u.def.move !== 'foot') {
        ctx.fillStyle = SIDES[u.side].color;
        ctx.fillRect(-1.2, -0.25, 0.6, 0.5);
      }
      ctx.restore();
      if (u.passengers?.length) {
        const n = u.passengers.reduce((a, p) => a + p.soldiers.filter((q) => !q.dead).length, 0);
        ctx.font = `700 ${10 * dpr}px "PT Sans", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.beginPath(); ctx.arc(sx + 5 * z, sy + 5 * z, 8 * dpr, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillText(`+${n}`, sx + 5 * z, sy + 5 * z);
      }
    }
  }

  // Тактические знаки (вблизи — маленькие над техникой)
  const size = (sprites ? 15 : Math.min(24, Math.max(17, 16 + z * 8))) * dpr;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = `700 ${12.5 * dpr}px "PT Sans", system-ui, sans-serif`;
  const labelAll = z > 0.35 * dpr || sel.size > 0;
  // Последние известные позиции противника (туман войны)
  if (fogSide) {
    ctx.globalAlpha = 0.45;
    for (const [id, g] of sim.vision.seen[fogSide]) {
      if (sim.vision.now[fogSide].has(id)) continue;
      const [gx, gy] = toS(g.x, g.y);
      if (gx < -40 || gy < -40 || gx > canvas.width + 40 || gy > canvas.height + 40) continue;
      drawSymbol(ctx, gx, gy, size * 0.85, g.side, g.symbol, { alpha: 0.6 });
      ctx.fillStyle = '#fff';
      ctx.fillText(`? ${Math.round((sim.time - g.t) / 60)} мин`, gx, gy + size * 0.55);
    }
    ctx.globalAlpha = 1;
  }
  for (const u of sim.units) {
    if (u.dead || u.embarked || hidden(u)) continue;
    let [sx, sy] = toS(u.x, u.y);
    if (sx < -60 || sy < -60 || sx > canvas.width + 60 || sy > canvas.height + 60) continue;
    if (sprites) {
      if (z > 6 * dpr && !sel.has(u.id)) continue;
      sy -= (u.def.move === 'foot' ? 16 : 10) * z + size;
    }
    drawSymbol(ctx, sx, sy, size, u.side, u.def.symbol, { selected: sel.has(u.id), alpha: 0.95 });
    // Полоска численности / состояния и боезапаса
    {
      const bw = size * 1.5, bx = sx - bw / 2, by = sy - size * 0.5 - 5 * dpr;
      const val = u.soldiers ? u.soldiers.filter((q) => !q.dead).length / u.soldiers.length : u.hp ?? 1;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(bx, by, bw, 3 * dpr);
      ctx.fillStyle = val > 0.66 ? '#7ddc6a' : val > 0.33 ? '#f0c34a' : '#ef5a4a';
      ctx.fillRect(bx, by, bw * val, 3 * dpr);
      if (u.def.caliber) {
        ctx.fillStyle = '#ffd36b';
        ctx.fillRect(bx, by - 4 * dpr, bw * (u.ammo / u.def.ammo), 2 * dpr);
      }
      if (u.fire) {
        ctx.fillStyle = '#ff7a5a';
        ctx.font = `700 ${10 * dpr}px "PT Sans", system-ui, sans-serif`;
        ctx.fillText('огонь', sx, by - 16 * dpr);
        ctx.font = `600 ${11 * dpr}px "PT Sans", system-ui, sans-serif`;
      }
    }
    if (u.state === 'planning') {
      ctx.fillStyle = '#ffe68c';
      ctx.fillText('…', sx + size, sy - size);
    }
    if (labelAll && (sel.has(u.id) || !sprites)) {
      const t = u.label;
      const ty = sy + size * 0.62;
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(t, sx, ty);
      ctx.fillStyle = sel.has(u.id) ? '#e4ffc2' : '#f2eee2';
      ctx.fillText(t, sx, ty);
    }
  }

  // Рамка выделения
  if (ui.box) {
    const { x0, y0, x1, y1 } = ui.box;
    ctx.fillStyle = 'rgba(184,255,107,0.12)';
    ctx.strokeStyle = 'rgba(184,255,107,0.9)';
    ctx.lineWidth = 1 * dpr;
    ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  }

  // Отметки приказов
  for (let i = ui.marks.length - 1; i >= 0; i--) {
    const m = ui.marks[i];
    const k = (performance.now() - m.t) / 600;
    if (k > 1) { ui.marks.splice(i, 1); continue; }
    const [sx, sy] = toS(m.x, m.y);
    ctx.beginPath();
    ctx.arc(sx, sy, (6 + k * 18) * dpr, 0, Math.PI * 2);
    ctx.strokeStyle = m.stealth ? `rgba(170,230,140,${1 - k})` : `rgba(255,230,140,${1 - k})`;
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();
  }
}

// Попадание по отряду в экранных координатах (device px)
export function pickUnit(sim, view, sx, sy, side) {
  const { cam, canvas, dpr } = view;
  let best = null, bd = Infinity;
  const sprites = cam.zoom >= SPRITE_ZOOM;
  for (const u of sim.units) {
    if (u.dead || u.embarked) continue;
    if (side && u.side !== side) continue;
    const ux = (u.x - cam.x) * cam.zoom + canvas.width / 2;
    let uy = (u.y - cam.y) * cam.zoom + canvas.height / 2;
    let d = Math.hypot(ux - sx, uy - sy);
    if (sprites) {
      // Можно попасть и по технике, и по знаку над ней
      const symY = uy - ((u.def.move === 'foot' ? 16 : 10) * cam.zoom + 12 * dpr);
      d = Math.min(d, Math.hypot(ux - sx, symY - sy));
    }
    const hitR = Math.max(16 * dpr, (sprites ? 8 * cam.zoom : 0));
    if (d < hitR && d < bd) { bd = d; best = u; }
  }
  return best;
}

function trenchLine(ctx, pts, toS, color, width, alpha, dash) {
  if (pts.length < 2) return;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const [x, y] = toS(p.x, p.y);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  if (dash) ctx.setLineDash(dash);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

// Бойцы по отдельности, вид сверху. Поза видна по силуэту:
//  стоя — плечи поперёк направления; пригнувшись — компактнее; лёжа — вытянутый силуэт;
//  в укрытии — только каска и плечи. На ходу — шаг (ноги и руки), при стрельбе — вспышка.
const HELMET = { blue: '#586246', red: '#4d5638' };
function drawSoldiers(ctx, u, toS, z, dpr, ui, sim, now) {
  const selUnit = ui.selected.has(u.id);
  // Пикселей на «метр силуэта»: фигуры чуть крупнее натуры (как принято в тактике сверху),
  // не меньше 15 px — чтобы позу и оружие было видно и при среднем зуме
  const m = Math.max(z * 2.1, 17 * dpr);
  const camo = FACTIONS[u.side].camo;
  for (const s of u.soldiers) {
    const [x, y] = toS(s.x, s.y);
    const isSel = ui.soldier && ui.soldier.unitId === u.id && ui.soldier.idx === s.idx;
    const pose = s.pose || 'stand';
    if (s.evac) continue;
    // Анимация: темп шага по пройденному пути
    const an = s._an || (s._an = { walk: s.walk || 0, mv: 0, t: now, shot: s.shotAt, flash: 0 });
    const dtr = Math.max(1, now - an.t);
    const moved = (s.walk || 0) - an.walk;
    an.mv += ((moved > 0.001 ? 1 : 0) - an.mv) * Math.min(1, dtr / 120);
    an.walk = s.walk || 0; an.t = now;
    if (s.shotAt !== an.shot) { an.shot = s.shotAt; an.flash = now; }
    if (s.dead) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(s.heading + 0.6);
      ctx.fillStyle = 'rgba(90,20,15,0.55)';
      ctx.beginPath(); ctx.ellipse(-0.3 * m, 0.1 * m, 0.7 * m, 0.45 * m, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2e3026';
      ctx.beginPath(); ctx.ellipse(-0.5 * m, 0, 0.6 * m, 0.22 * m, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#2e3026'; ctx.lineWidth = Math.max(1, 0.12 * m);
      ctx.beginPath(); ctx.moveTo(-1.0 * m, 0.1 * m); ctx.lineTo(-1.35 * m, 0.35 * m); ctx.moveTo(-0.3 * m, -0.2 * m); ctx.lineTo(0.1 * m, -0.5 * m); ctx.stroke();
      ctx.fillStyle = HELMET[u.side];
      ctx.beginPath(); ctx.arc(0.12 * m, 0, 0.14 * m, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      continue;
    }
    ctx.globalAlpha = s.under ? (ui.underground ? 0.95 : 0.25) : 1;
    if (isSel || selUnit) {
      ctx.beginPath();
      ctx.arc(x, y, 0.95 * m, 0, Math.PI * 2);
      ctx.strokeStyle = isSel ? '#fff27a' : 'rgba(184,255,107,0.75)';
      ctx.lineWidth = (isSel ? 2 : 1.2) * dpr;
      ctx.stroke();
    }
    // Недавно стрелял и стоит — развёрнут на цель
    const firing = s.shotAt !== undefined && sim.time - s.shotAt < 8 && an.mv < 0.5;
    const hd = firing && s.aim !== undefined ? s.aim : s.heading;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(hd);
    const body = camo.body, dark = '#1c1e16';
    const wl = (s.role === 'Пулемётчик' || s.role === 'Снайпер' ? 1.05 : 0.8) * m;
    const shadow = (fn) => { ctx.save(); ctx.translate(0.25 * m, 0.25 * m); ctx.fillStyle = 'rgba(10,12,6,0.45)'; fn(); ctx.restore(); };
    const flash = now - an.flash < 90;
    if (pose === 'prone') {
      shadow(() => { ctx.beginPath(); ctx.ellipse(-0.55 * m, 0, 0.85 * m, 0.26 * m, 0, 0, Math.PI * 2); ctx.fill(); });
      // Ноги: ползком — переставляются
      const k = Math.sin((s.walk || 0) * 5) * 0.12 * an.mv;
      ctx.strokeStyle = camo.dark;
      ctx.lineWidth = Math.max(1, 0.15 * m);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-0.95 * m, 0.08 * m); ctx.lineTo((-1.45 + k) * m, 0.3 * m);
      ctx.moveTo(-0.95 * m, -0.08 * m); ctx.lineTo((-1.45 - k) * m, -0.3 * m);
      ctx.stroke();
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(-0.5 * m, 0, 0.6 * m, 0.25 * m, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = camo.dark; ctx.fillRect(-0.85 * m, -0.16 * m, 0.4 * m, 0.32 * m); // рюкзак
      ctx.strokeStyle = dark; ctx.lineWidth = Math.max(1, 0.1 * m);
      ctx.beginPath(); ctx.moveTo(0.05 * m, 0.08 * m); ctx.lineTo(0.05 * m + wl, 0.08 * m); ctx.stroke();
      ctx.fillStyle = HELMET[u.side];
      ctx.beginPath(); ctx.arc(0.12 * m, 0, 0.17 * m, 0, Math.PI * 2); ctx.fill();
      if (flash) muzzle(ctx, 0.05 * m + wl, 0.08 * m, m);
    } else if (pose === 'trench' || pose === 'window' || pose === 'inside') {
      ctx.strokeStyle = dark;
      ctx.lineWidth = Math.max(1, 0.1 * m);
      if (pose !== 'inside') { ctx.beginPath(); ctx.moveTo(0, 0.05 * m); ctx.lineTo(wl, 0.05 * m); ctx.stroke(); }
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(-0.02 * m, 0, 0.17 * m, 0.3 * m, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = HELMET[u.side];
      ctx.beginPath(); ctx.arc(0, 0, 0.17 * m, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = Math.max(0.8, 0.04 * m);
      ctx.stroke();
      if (flash && pose !== 'inside') muzzle(ctx, wl, 0.05 * m, m);
    } else {
      const sc = pose === 'crouch' ? 0.82 : 1;
      const ph = (s.walk || 0) * (Math.PI / 0.8);
      const sw = Math.sin(ph) * 0.3 * an.mv * sc;
      shadow(() => { ctx.beginPath(); ctx.ellipse(-0.05 * m, 0, 0.3 * m * sc, 0.34 * m * sc, 0, 0, Math.PI * 2); ctx.fill(); });
      // Ноги — шаг
      ctx.strokeStyle = camo.dark;
      ctx.lineWidth = Math.max(1, 0.13 * m);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0, 0.12 * m * sc); ctx.lineTo(sw * m, 0.13 * m * sc);
      ctx.moveTo(0, -0.12 * m * sc); ctx.lineTo(-sw * m, -0.13 * m * sc);
      ctx.stroke();
      // Рюкзак, корпус, руки с оружием
      ctx.fillStyle = camo.dark;
      ctx.fillRect(-0.36 * m * sc, -0.2 * m * sc, 0.2 * m * sc, 0.4 * m * sc);
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(pose === 'crouch' ? 0.04 * m : 0, 0, 0.19 * m * sc, 0.33 * m * sc, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = body;
      ctx.lineWidth = Math.max(1, 0.1 * m);
      ctx.beginPath();
      ctx.moveTo(0.02 * m, 0.28 * m * sc); ctx.lineTo(0.3 * m, 0.14 * m);
      ctx.moveTo(0.02 * m, -0.28 * m * sc); ctx.lineTo((0.22 + sw * 0.3) * m, -0.02 * m);
      ctx.stroke();
      ctx.strokeStyle = dark;
      ctx.lineWidth = Math.max(1, 0.09 * m);
      ctx.beginPath(); ctx.moveTo(0.05 * m, 0.1 * m); ctx.lineTo(0.05 * m + wl * sc, 0.1 * m); ctx.stroke();
      if (s.weapon === 'gl') { ctx.lineWidth = Math.max(1.2, 0.16 * m); ctx.beginPath(); ctx.moveTo(-0.3 * m, -0.18 * m); ctx.lineTo(0.5 * m, -0.18 * m); ctx.stroke(); }
      ctx.fillStyle = HELMET[u.side];
      ctx.beginPath(); ctx.arc(pose === 'crouch' ? 0.1 * m : 0.02 * m, 0, 0.16 * m, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath(); ctx.arc(pose === 'crouch' ? 0.06 * m : -0.02 * m, -0.05 * m, 0.07 * m, 0, Math.PI * 2); ctx.fill();
      if (flash) muzzle(ctx, 0.05 * m + wl * sc, 0.1 * m, m);
    }
    ctx.restore();
    ctx.fillStyle = s.role === 'Командир' ? '#fff' : s.role === 'Медик' ? '#ff6b6b' : SIDES[u.side].color;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1.2 * dpr, 0.07 * m), 0, Math.PI * 2);
    ctx.fill();
    if (s.wounded) {
      // Ранен: красный крест (жёлтый — легко, красный — тяжело)
      const c = s.wounded === 2 ? '#ff3b30' : '#ffb020';
      ctx.strokeStyle = c;
      ctx.lineWidth = 2 * dpr;
      const r = 0.35 * m;
      ctx.beginPath();
      ctx.moveTo(x + r, y - r - 3 * dpr); ctx.lineTo(x + r, y - r + 3 * dpr);
      ctx.moveTo(x + r - 3 * dpr, y - r); ctx.lineTo(x + r + 3 * dpr, y - r);
      ctx.stroke();
    }
    if ((s.mag ?? 1) < 0.15 && z > 2 * dpr) {
      ctx.fillStyle = '#ffcf4a';
      ctx.font = `700 ${9 * dpr}px "PT Sans", sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(s.mag <= 0 ? '0' : '!', x - 0.4 * m, y - 0.4 * m);
    }
    if (s.mode === 'dig' && z > 3) {
      // Лопата: взмахи
      const t = Math.sin(now / 180 + s.idx * 1.7);
      ctx.strokeStyle = '#8a7a5a';
      ctx.lineWidth = Math.max(1, 0.08 * m);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(s.heading + t * 0.6) * m * 0.75, y + Math.sin(s.heading + t * 0.6) * m * 0.75);
      ctx.stroke();
      if (t > 0.9) { ctx.fillStyle = 'rgba(120,100,70,0.6)'; ctx.beginPath(); ctx.arc(x + Math.cos(s.heading + 1.2) * m, y + Math.sin(s.heading + 1.2) * m, 0.15 * m, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  ctx.globalAlpha = 1;
}

function muzzle(ctx, x, y, m) {
  ctx.fillStyle = 'rgba(255,220,120,0.95)';
  ctx.beginPath();
  ctx.moveTo(x, y - 0.08 * m); ctx.lineTo(x + 0.45 * m, y); ctx.lineTo(x, y + 0.08 * m);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(255,170,60,0.5)';
  ctx.beginPath(); ctx.arc(x + 0.12 * m, y, 0.16 * m, 0, Math.PI * 2); ctx.fill();
}

// Попадание по бойцу выделенного отряда (для ручного управления)
export function pickSoldier(sim, view, sx, sy, ui) {
  const { cam, canvas, dpr } = view;
  if (cam.zoom < SPRITE_ZOOM) return null;
  let best = null, bd = Math.max(9 * dpr, 1.8 * cam.zoom);
  for (const u of sim.units) {
    if (!u.soldiers || u.embarked || !ui.selected.has(u.id)) continue;
    for (const s of u.soldiers) {
      const x = (s.x - cam.x) * cam.zoom + canvas.width / 2, y = (s.y - cam.y) * cam.zoom + canvas.height / 2;
      const d = Math.hypot(x - sx, y - sy);
      if (d < bd) { bd = d; best = { unitId: u.id, idx: s.idx }; }
    }
  }
  return best;
}

// ---------- Снаряды в полёте, выстрелы, разрывы и осколки ----------
export function drawArtillery(ctx, sim, view) {
  const { cam, canvas, dpr } = view;
  const z = cam.zoom;
  const toS = (x, y) => [(x - cam.x) * z + canvas.width / 2, (y - cam.y) * z + canvas.height / 2];
  const now = performance.now();
  // Снаряды: баллистика в координатах мира — положение на земле + высота над ней.
  // Высота рисуется смещением вверх (наклонная проекция), тень — на земле под снарядом.
  const OBL = 0.5; // доля высоты, видимая как смещение вверх
  const shellAt = (sh, p) => {
    const R = Math.hypot(sh.x - sh.x0, sh.y - sh.y0);
    const apex = sh.caliber < 100 ? Math.min(900, R * 0.45) : Math.min(2200, R * 0.22);
    return [sh.x0 + (sh.x - sh.x0) * p, sh.y0 + (sh.y - sh.y0) * p, apex * 4 * p * (1 - p)];
  };
  for (const sh of sim.art.shells) {
    const T = sh.tImpact - sh.tLaunch;
    const p = Math.max(0, Math.min(1, (sim.time - sh.tLaunch) / T));
    const [gx, gy, h] = shellAt(sh, p);
    const [sx, sy] = toS(gx, gy);
    const y = sy - h * OBL * z;
    // Тень
    if (h < 400) {
      ctx.fillStyle = `rgba(0,0,0,${0.35 * (1 - h / 400)})`;
      ctx.beginPath(); ctx.ellipse(sx, sy, Math.max(1.5 * dpr, 0.6 * z), Math.max(1 * dpr, 0.3 * z), 0, 0, Math.PI * 2); ctx.fill();
    }
    // След: несколько прошлых положений
    ctx.lineCap = 'round';
    for (let k = 1; k <= 6; k++) {
      const q0 = Math.max(0, p - (k * 0.012)), q1 = Math.max(0, p - ((k - 1) * 0.012));
      const [ax, ay, ah] = shellAt(sh, q0), [bx, by, bh] = shellAt(sh, q1);
      const [asx, asy] = toS(ax, ay), [bsx, bsy] = toS(bx, by);
      ctx.strokeStyle = `rgba(230,225,210,${0.28 * (1 - k / 7)})`;
      ctx.lineWidth = Math.max(1, (1.6 + k * 0.5) * dpr);
      ctx.beginPath(); ctx.moveTo(asx, asy - ah * OBL * z); ctx.lineTo(bsx, bsy - bh * OBL * z); ctx.stroke();
    }
    // Сам снаряд — вытянутый по направлению полёта, со светящимся трассером донной части
    const [nx, ny, nh] = shellAt(sh, Math.min(1, p + 0.004));
    const [nsx, nsy] = toS(nx, ny);
    const ang = Math.atan2(nsy - nh * OBL * z - y, nsx - sx);
    const len = Math.max(4 * dpr, (sh.caliber < 100 ? 0.5 : 0.8) * z * 2);
    ctx.save();
    ctx.translate(sx, y);
    ctx.rotate(ang);
    ctx.fillStyle = 'rgba(255,200,120,0.35)';
    ctx.beginPath(); ctx.arc(-len * 0.4, 0, len * 0.45, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#3a3a33';
    ctx.beginPath(); ctx.ellipse(0, 0, len * 0.5, len * 0.17, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff0c0';
    ctx.beginPath(); ctx.arc(-len * 0.5, 0, Math.max(1, len * 0.12), 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // Точка падения: пульсирует в последние секунды
    const left = sh.tImpact - sim.time;
    const [bx, by] = toS(sh.x, sh.y);
    const pulse = left < 4 ? 0.5 + 0.5 * Math.sin(now / 90) : 0.4;
    ctx.strokeStyle = `rgba(255,110,80,${0.6 * pulse})`;
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.arc(bx, by, (4 + (left < 4 ? (4 - left) * 2 : 0)) * dpr, 0, Math.PI * 2); ctx.stroke();
  }
  const fx = sim.art.effects;
  for (let i = fx.length - 1; i >= 0; i--) {
    const e = fx[i];
    const t = (now - e.t) / 1000;
    if (t > 4) { fx.splice(i, 1); continue; }
    const [x, y] = toS(e.x, e.y);
    if (e.type === 'muzzle') {
      if (t > 0.6) continue;
      // Вспышка по направлению ствола и облачко дыма
      if (t < 0.12) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(e.h || 0);
        const L = Math.max(8 * dpr, (e.small ? 2.5 : 5) * z);
        ctx.fillStyle = `rgba(255,220,120,${1 - t * 8})`;
        ctx.beginPath(); ctx.moveTo(0, -L * 0.3); ctx.lineTo(L * 1.6, 0); ctx.lineTo(0, L * 0.3); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.arc(L * 0.2, 0, L * 0.45, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = `rgba(190,185,170,${0.35 * (1 - t / 0.6)})`;
      ctx.beginPath(); ctx.arc(x + Math.cos(e.h || 0) * t * 6 * z, y + Math.sin(e.h || 0) * t * 6 * z, Math.max(4 * dpr, (e.small ? 1.5 : 3) * z * (1 + t * 3)), 0, Math.PI * 2); ctx.fill();
      continue;
    }
    const cal = e.caliber;
    const R = (cal === 82 ? 4 : cal === 122 ? 7 : 9) * z;
    // Дым
    const smokeA = t < 0.2 ? t * 3 : Math.max(0, 0.6 - (t - 0.2) * 0.16);
    ctx.fillStyle = e.air ? `rgba(200,200,195,${smokeA})` : `rgba(70,62,52,${smokeA})`;
    ctx.beginPath(); ctx.arc(x + t * 6 * z, y - t * 3 * z, Math.max(6 * dpr, R * (1 + t * 0.8)), 0, Math.PI * 2); ctx.fill();
    // Вспышка
    if (t < 0.25) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(10 * dpr, R * 1.6));
      g.addColorStop(0, `rgba(255,245,200,${1 - t * 4})`);
      g.addColorStop(0.4, `rgba(255,160,60,${0.9 - t * 3.6})`);
      g.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, Math.max(10 * dpr, R * 1.6), 0, Math.PI * 2); ctx.fill();
    }
    // Осколки: лучи, обрывающиеся на стенах
    if (t < 0.45 && e.rays) {
      const k = t / 0.45;
      ctx.strokeStyle = `rgba(255,210,140,${0.85 * (1 - k)})`;
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      for (const [a, L] of e.rays) {
        const r0 = L * Math.max(0, k - 0.25) * z, r1 = L * k * z;
        ctx.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
        ctx.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1);
      }
      ctx.stroke();
    }
  }
}

// ---------- Трассеры, дроны, медпункты ----------
export function drawCombatFx(ctx, sim, view, fogSide) {
  const { cam, canvas, dpr } = view;
  const z = cam.zoom;
  const toS = (x, y) => [(x - cam.x) * z + canvas.width / 2, (y - cam.y) * z + canvas.height / 2];
  const now = performance.now();
  // Трассеры (последние 0.35 с реального времени)
  const tr = sim.combat?.tracers || [];
  for (let i = tr.length - 1; i >= 0; i--) {
    const t = tr[i];
    if (!t.rt) t.rt = now;
    const age = (now - t.rt) / 350;
    if (age > 1) { tr.splice(i, 1); continue; }
    const [x0, y0] = toS(t.x0, t.y0), [x1, y1] = toS(t.x1, t.y1);
    const a = age, b = Math.min(1, age + 0.35);
    ctx.strokeStyle = t.side === 'blue' ? `rgba(255,235,150,${0.9 - age * 0.8})` : `rgba(255,170,110,${0.9 - age * 0.8})`;
    ctx.lineWidth = (t.heavy ? 2 : 1.2) * dpr;
    ctx.beginPath();
    ctx.moveTo(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a);
    ctx.lineTo(x0 + (x1 - x0) * b, y0 + (y1 - y0) * b);
    ctx.stroke();
  }
  if (tr.length > 600) tr.splice(0, tr.length - 600);
  // Медпункты
  for (const side of ['blue', 'red']) {
    const m = sim.medpoints?.[side];
    if (!m || (fogSide && side !== fogSide)) continue;
    const [x, y] = toS(m.x, m.y);
    ctx.fillStyle = 'rgba(245,245,240,0.95)';
    ctx.fillRect(x - 11 * dpr, y - 9 * dpr, 22 * dpr, 18 * dpr);
    ctx.fillStyle = '#d33';
    ctx.fillRect(x - 2.5 * dpr, y - 7 * dpr, 5 * dpr, 14 * dpr);
    ctx.fillRect(x - 7 * dpr, y - 2.5 * dpr, 14 * dpr, 5 * dpr);
    ctx.font = `700 ${11 * dpr}px "PT Sans", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeText('Медпункт', x, y + 11 * dpr);
    ctx.fillStyle = '#fff';
    ctx.fillText('Медпункт', x, y + 11 * dpr);
  }
  // Дроны
  for (const d of sim.drones?.list || []) {
    if (d.dead) continue;
    if (fogSide && d.side !== fogSide) {
      // Чужой дрон слышно/видно рядом со своими войсками
      const near = sim.units.some((u) => u.side === fogSide && !u.dead && Math.hypot(u.x - d.x, u.y - d.y) < 300);
      if (!near) continue;
    }
    const [x, y] = toS(d.x, d.y);
    const s = Math.max(5 * dpr, (d.kind === 'fpv' ? 0.5 : 0.7) * z);
    const own = !fogSide || d.side === fogSide;
    if (own && d.state !== 'return') {
      const [tx, ty] = toS(d.tx, d.ty);
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.strokeStyle = d.kind === 'fpv' ? 'rgba(255,90,70,0.7)' : 'rgba(170,220,255,0.6)';
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      if (d.kind === 'recon' && d.state === 'loiter') ctx.arc(tx, ty, DRONE_KINDS.recon.loiter * z, 0, Math.PI * 2);
      else { ctx.moveTo(x, y); ctx.lineTo(tx, ty); }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Тень (дрон высоко — тень смещена)
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.arc(x + 10 * dpr, y + 10 * dpr, s * 0.9, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(d.heading + Math.PI / 4);
    ctx.strokeStyle = '#222';
    ctx.lineWidth = Math.max(1.5, s * 0.25);
    ctx.beginPath();
    ctx.moveTo(-s, -s); ctx.lineTo(s, s); ctx.moveTo(s, -s); ctx.lineTo(-s, s);
    ctx.stroke();
    ctx.fillStyle = SIDES[d.side].fill;
    for (const [px, py] of [[-s, -s], [s, s], [s, -s], [-s, s]]) {
      ctx.beginPath(); ctx.arc(px, py, s * 0.45, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = d.kind === 'fpv' ? '#c33' : d.kind === 'bomber' ? '#b80' : '#333';
    ctx.fillRect(-s * 0.35, -s * 0.35, s * 0.7, s * 0.7);
    ctx.restore();
  }
}
