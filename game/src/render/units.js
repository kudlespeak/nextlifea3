// Отрисовка отрядов: тактические знаки (издалека) и техника сверху (вблизи),
// маршруты, выделение, пыль из-под колёс.

import { SIDES } from '../sim/units.js';
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
    case 'supply':
      ctx.beginPath();
      ctx.moveTo(-iw, ih * 0.45); ctx.lineTo(iw, ih * 0.45);
      ctx.stroke();
      break;
  }
  ctx.restore();
}

// ---------- Техника сверху (координаты в метрах, ось X — вперёд) ----------
const OLIVE = '#4b5335', OLIVE_L = '#5a6340', OLIVE_D = '#353a26', TRACK = '#26281f';

function shadowRect(ctx, x, y, w, h) {
  ctx.fillStyle = 'rgba(10,12,6,0.45)';
  ctx.fillRect(x + 0.7, y + 0.7, w, h);
}

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

const SPRITES = {
  tank(ctx, u) {
    shadowRect(ctx, -3.6, -1.8, 7.2, 3.6);
    ctx.fillStyle = TRACK;
    ctx.fillRect(-3.6, -1.8, 7.2, 0.75);
    ctx.fillRect(-3.6, 1.05, 7.2, 0.75);
    rrect(ctx, -3.4, -1.3, 6.8, 2.6, 0.3);
    ctx.fillStyle = OLIVE;
    ctx.fill();
    ctx.fillStyle = OLIVE_D;
    ctx.fillRect(-3.3, -0.9, 1.4, 1.8); // МТО
    // Башня и ствол (башня смотрит по ходу)
    ctx.save();
    ctx.translate(0.2, 0);
    ctx.fillStyle = OLIVE_D;
    ctx.fillRect(1.2, -0.13, 4.6, 0.26);
    ctx.beginPath();
    ctx.ellipse(0, 0, 1.55, 1.3, 0, 0, Math.PI * 2);
    ctx.fillStyle = OLIVE_L;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.12;
    ctx.stroke();
    ctx.fillStyle = OLIVE_D;
    ctx.beginPath();
    ctx.arc(-0.4, -0.45, 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  },
  ifv(ctx) {
    shadowRect(ctx, -3.4, -1.6, 6.8, 3.2);
    ctx.fillStyle = TRACK;
    ctx.fillRect(-3.4, -1.6, 6.8, 0.6);
    ctx.fillRect(-3.4, 1.0, 6.8, 0.6);
    rrect(ctx, -3.3, -1.2, 6.6, 2.4, 0.25);
    ctx.fillStyle = OLIVE;
    ctx.fill();
    ctx.beginPath(); // скошенный нос
    ctx.moveTo(2.2, -1.2); ctx.lineTo(3.3, -0.7); ctx.lineTo(3.3, 0.7); ctx.lineTo(2.2, 1.2);
    ctx.fillStyle = OLIVE_L;
    ctx.fill();
    ctx.fillStyle = OLIVE_D;
    ctx.fillRect(-3.2, -0.8, 1.2, 0.6); // десантные люки
    ctx.fillRect(-3.2, 0.2, 1.2, 0.6);
    ctx.fillRect(0.6, -0.08, 2.9, 0.16);
    ctx.beginPath();
    ctx.arc(0.4, 0, 0.8, 0, Math.PI * 2);
    ctx.fillStyle = OLIVE_L;
    ctx.fill();
  },
  apc(ctx) {
    shadowRect(ctx, -3.8, -1.45, 7.6, 2.9);
    ctx.fillStyle = TRACK;
    for (let i = 0; i < 4; i++) {
      const x = -2.8 + i * 1.75;
      ctx.fillRect(x - 0.5, -1.5, 1, 0.4);
      ctx.fillRect(x - 0.5, 1.1, 1, 0.4);
    }
    ctx.beginPath();
    ctx.moveTo(-3.7, -1.2); ctx.lineTo(2.6, -1.2); ctx.lineTo(3.8, -0.5); ctx.lineTo(3.8, 0.5); ctx.lineTo(2.6, 1.2); ctx.lineTo(-3.7, 1.2);
    ctx.closePath();
    ctx.fillStyle = '#525a3a';
    ctx.fill();
    ctx.fillStyle = OLIVE_D;
    ctx.fillRect(1.5, -0.05, 2.2, 0.12);
    ctx.beginPath();
    ctx.arc(1.2, 0, 0.6, 0, Math.PI * 2);
    ctx.fillStyle = OLIVE_L;
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(-2.8, -0.9, 3, 1.8);
  },
  truck(ctx) {
    shadowRect(ctx, -4, -1.25, 8, 2.5);
    ctx.fillStyle = TRACK;
    for (const x of [-3, -1.8, 2.6]) { ctx.fillRect(x - 0.45, -1.3, 0.9, 0.3); ctx.fillRect(x - 0.45, 1.0, 0.9, 0.3); }
    ctx.fillStyle = '#58603f';
    ctx.fillRect(1.8, -1.15, 2.2, 2.3); // кабина
    ctx.fillStyle = '#2f3a3e';
    ctx.fillRect(3.3, -0.95, 0.5, 1.9); // стекло
    ctx.fillStyle = '#666b4c';
    ctx.fillRect(-4, -1.2, 5.6, 2.4); // тент
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 0.1;
    ctx.beginPath();
    for (let x = -3.4; x < 1.5; x += 0.9) { ctx.moveTo(x, -1.2); ctx.lineTo(x, 1.2); }
    ctx.stroke();
  },
  arty(ctx) {
    // Тягач + орудие на прицепе (ствол назад по-походному)
    SPRITES.truck(ctx);
    ctx.fillStyle = OLIVE_D;
    ctx.beginPath();
    ctx.moveTo(-4.2, 0); ctx.lineTo(-7, -1.1); ctx.lineTo(-7, 1.1);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#3d4230';
    ctx.fillRect(-10.5, -0.12, 4.5, 0.24);
    ctx.fillStyle = OLIVE;
    ctx.fillRect(-7.3, -1.1, 1.3, 2.2);
  },
  btm(ctx) {
    // Гусеничный тягач с траншейным рабочим органом сзади
    shadowRect(ctx, -4.5, -1.6, 9, 3.2);
    ctx.fillStyle = TRACK;
    ctx.fillRect(-3, -1.6, 6.6, 0.6);
    ctx.fillRect(-3, 1.0, 6.6, 0.6);
    ctx.fillStyle = '#5a5a3c';
    ctx.fillRect(-2.9, -1.2, 6.4, 2.4);
    ctx.fillStyle = '#6a6a44';
    ctx.fillRect(1.6, -1.1, 1.8, 2.2); // кабина
    ctx.fillStyle = '#2f3a3e';
    ctx.fillRect(3.0, -0.9, 0.35, 1.8);
    // Роторный рабочий орган
    ctx.fillStyle = '#3b3a30';
    ctx.fillRect(-5.2, -0.55, 2.4, 1.1);
    ctx.beginPath();
    ctx.arc(-5.2, 0, 1.2, 0, Math.PI * 2);
    ctx.strokeStyle = '#2a2922';
    ctx.lineWidth = 0.35;
    ctx.stroke();
  },
  inf(ctx, u, zoom) {
    // Бойцы клином
    const n = Math.max(1, Math.round(u.def.men * u.strength));
    const r = Math.max(0.4, 1.4 / zoom);
    for (let i = 0; i < n; i++) {
      const row = Math.ceil(i / 2);
      const side = i === 0 ? 0 : i % 2 ? -1 : 1;
      const x = -row * 3.2 + ((i * 7) % 3) * 0.4;
      const y = side * row * 2.6;
      ctx.fillStyle = 'rgba(10,12,6,0.4)';
      ctx.beginPath();
      ctx.arc(x + 0.35, y + 0.35, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#3c4230';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#6a6f4e';
      ctx.beginPath();
      ctx.arc(x + r * 0.2, y, r * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
  },
};

// ---------- Пыль ----------
const dust = [];
export function emitDust(sim, dtReal, timeScale) {
  for (const u of sim.units) {
    if (u.state !== 'moving' || u.def.move === 'foot' || u.speed < 2) continue;
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
export function drawUnits(ctx, sim, view, ui) {
  const { cam, canvas, dpr } = view;
  const toS = (x, y) => [(x - cam.x) * cam.zoom + canvas.width / 2, (y - cam.y) * cam.zoom + canvas.height / 2];
  const sel = ui.selected;
  const z = cam.zoom;

  // Пыль
  for (const p of dust) {
    const [sx, sy] = toS(p.x, p.y);
    const k = p.t / p.life;
    ctx.fillStyle = `rgba(170,155,120,${0.35 * (1 - k)})`;
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(1, (p.r + k * 6) * z), 0, Math.PI * 2);
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
      if (u.soldiers) {
        drawSoldiers(ctx, u, toS, z, dpr, ui);
        continue;
      }
      if (sel.has(u.id)) {
        ctx.beginPath();
        ctx.arc(sx, sy, (u.def.move === 'foot' ? 10 : 7) * z, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(184,255,107,0.9)';
        ctx.lineWidth = 1.5 * dpr;
        ctx.setLineDash([4 * dpr, 3 * dpr]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(z, z);
      ctx.rotate(u.heading);
      SPRITES[u.type](ctx, u, z);
      // Опознавательная полоса цвета стороны
      if (u.def.move !== 'foot') {
        ctx.fillStyle = SIDES[u.side].color;
        ctx.fillRect(-1.2, -0.25, 0.6, 0.5);
      }
      ctx.restore();
    }
  }

  // Тактические знаки (вблизи — маленькие над техникой)
  const size = (sprites ? 12 : Math.min(20, Math.max(13, 12 + z * 8))) * dpr;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = `600 ${11 * dpr}px "PT Sans", system-ui, sans-serif`;
  const labelAll = z > 0.35 * dpr || sel.size > 0;
  for (const u of sim.units) {
    let [sx, sy] = toS(u.x, u.y);
    if (sx < -60 || sy < -60 || sx > canvas.width + 60 || sy > canvas.height + 60) continue;
    if (sprites) {
      if (z > 6 * dpr && !sel.has(u.id)) continue;
      sy -= (u.def.move === 'foot' ? 16 : 10) * z + size;
    }
    drawSymbol(ctx, sx, sy, size, u.side, u.def.symbol, { selected: sel.has(u.id), alpha: 0.95 });
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

// Бойцы по отдельности: тело, направление оружия, роль
function drawSoldiers(ctx, u, toS, z, dpr, ui) {
  const selUnit = ui.selected.has(u.id);
  const r = Math.max(0.45, 1.6 / z) * z; // в пикселях
  for (const s of u.soldiers) {
    const [x, y] = toS(s.x, s.y);
    const isSel = ui.soldier && ui.soldier.unitId === u.id && ui.soldier.idx === s.idx;
    ctx.globalAlpha = s.under ? (ui.underground ? 0.95 : 0.3) : 1;
    if (isSel || selUnit) {
      ctx.beginPath();
      ctx.arc(x, y, r * 2.1, 0, Math.PI * 2);
      ctx.strokeStyle = isSel ? '#fff27a' : 'rgba(184,255,107,0.75)';
      ctx.lineWidth = (isSel ? 2 : 1.2) * dpr;
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(10,12,6,0.45)';
    ctx.beginPath();
    ctx.arc(x + r * 0.35, y + r * 0.35, r, 0, Math.PI * 2);
    ctx.fill();
    // Оружие
    const wl = (s.role === 'Пулемётчик' || s.role === 'Снайпер' ? 1.4 : 1.0) * Math.max(r * 1.6, 0.9 * z);
    ctx.strokeStyle = '#1c1e16';
    ctx.lineWidth = Math.max(1, r * 0.35);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(s.heading) * wl, y + Math.sin(s.heading) * wl);
    ctx.stroke();
    ctx.fillStyle = '#3c4230';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // Метка стороны / роли
    ctx.fillStyle = s.role === 'Командир' ? '#fff' : s.role === 'Медик' ? '#ff6b6b' : SIDES[u.side].color;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.45, 0, Math.PI * 2);
    ctx.fill();
    if (s.mode === 'dig' && z > 3) {
      // Лопата мелькает
      const t = (performance.now() / 300 + s.idx) % 1;
      ctx.strokeStyle = '#8a7a5a';
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(s.heading + t) * r * 2, y + Math.sin(s.heading + t) * r * 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

// Попадание по бойцу выделенного отряда (для ручного управления)
export function pickSoldier(sim, view, sx, sy, ui) {
  const { cam, canvas, dpr } = view;
  if (cam.zoom < SPRITE_ZOOM) return null;
  let best = null, bd = Math.max(9 * dpr, 1.8 * cam.zoom);
  for (const u of sim.units) {
    if (!u.soldiers || !ui.selected.has(u.id)) continue;
    for (const s of u.soldiers) {
      const x = (s.x - cam.x) * cam.zoom + canvas.width / 2, y = (s.y - cam.y) * cam.zoom + canvas.height / 2;
      const d = Math.hypot(x - sx, y - sy);
      if (d < bd) { bd = d; best = { unitId: u.id, idx: s.idx }; }
    }
  }
  return best;
}
