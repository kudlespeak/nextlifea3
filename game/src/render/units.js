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

const SPRITES = {
  tank(ctx, u) {
    shadowRect(ctx, -3.6, -1.8, 7.2, 3.6);
    ctx.fillStyle = P.track;
    ctx.fillRect(-3.6, -1.8, 7.2, 0.75);
    ctx.fillRect(-3.6, 1.05, 7.2, 0.75);
    rrect(ctx, -3.4, -1.3, 6.8, 2.6, 0.3);
    ctx.fillStyle = P.body;
    ctx.fill();
    ctx.fillStyle = P.dark;
    ctx.fillRect(-3.3, -0.9, 1.4, 1.8); // МТО
    // Башня и ствол (башня смотрит по ходу)
    ctx.save();
    ctx.translate(0.2, 0);
    ctx.fillStyle = P.dark;
    ctx.fillRect(1.2, -0.13, 4.6, 0.26);
    ctx.beginPath();
    if (u.side === 'blue') {
      // Западный танк: угловатая башня с нишей
      ctx.moveTo(1.6, -1.1); ctx.lineTo(1.6, 1.1); ctx.lineTo(-1.2, 1.35); ctx.lineTo(-2.2, 0.9); ctx.lineTo(-2.2, -0.9); ctx.lineTo(-1.2, -1.35); ctx.closePath();
    } else ctx.ellipse(0, 0, 1.55, 1.3, 0, 0, Math.PI * 2);
    ctx.fillStyle = P.light;
    ctx.fill();
    if (u.side === 'red') {
      // Блоки динамической защиты
      ctx.fillStyle = P.dark;
      for (const [bx, by] of [[1.1, -0.9], [1.1, 0.9], [0.6, -1.2], [0.6, 1.2]]) ctx.fillRect(bx - 0.25, by - 0.2, 0.5, 0.4);
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.12;
    ctx.stroke();
    ctx.fillStyle = P.dark;
    ctx.beginPath();
    ctx.arc(-0.4, -0.45, 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  },
  ifv(ctx) {
    shadowRect(ctx, -3.4, -1.6, 6.8, 3.2);
    ctx.fillStyle = P.track;
    ctx.fillRect(-3.4, -1.6, 6.8, 0.6);
    ctx.fillRect(-3.4, 1.0, 6.8, 0.6);
    rrect(ctx, -3.3, -1.2, 6.6, 2.4, 0.25);
    ctx.fillStyle = P.body;
    ctx.fill();
    ctx.beginPath(); // скошенный нос
    ctx.moveTo(2.2, -1.2); ctx.lineTo(3.3, -0.7); ctx.lineTo(3.3, 0.7); ctx.lineTo(2.2, 1.2);
    ctx.fillStyle = P.light;
    ctx.fill();
    ctx.fillStyle = P.dark;
    ctx.fillRect(-3.2, -0.8, 1.2, 0.6); // десантные люки
    ctx.fillRect(-3.2, 0.2, 1.2, 0.6);
    ctx.fillRect(0.6, -0.08, 2.9, 0.16);
    ctx.beginPath();
    ctx.arc(0.4, 0, 0.8, 0, Math.PI * 2);
    ctx.fillStyle = P.light;
    ctx.fill();
  },
  apc(ctx) {
    shadowRect(ctx, -3.8, -1.45, 7.6, 2.9);
    ctx.fillStyle = P.track;
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
    ctx.fillStyle = P.dark;
    ctx.fillRect(1.5, -0.05, 2.2, 0.12);
    ctx.beginPath();
    ctx.arc(1.2, 0, 0.6, 0, Math.PI * 2);
    ctx.fillStyle = P.light;
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(-2.8, -0.9, 3, 1.8);
  },
  truck(ctx) {
    shadowRect(ctx, -4, -1.25, 8, 2.5);
    ctx.fillStyle = P.track;
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
    ctx.fillStyle = P.dark;
    ctx.beginPath();
    ctx.moveTo(-4.2, 0); ctx.lineTo(-7, -1.1); ctx.lineTo(-7, 1.1);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#3d4230';
    ctx.fillRect(-10.5, -0.12, 4.5, 0.24);
    ctx.fillStyle = P.body;
    ctx.fillRect(-7.3, -1.1, 1.3, 2.2);
  },
  btm(ctx) {
    // Гусеничный тягач с траншейным рабочим органом сзади
    shadowRect(ctx, -4.5, -1.6, 9, 3.2);
    ctx.fillStyle = P.track;
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
export function drawUnits(ctx, sim, view, ui, fogSide = null) {
  const hidden = (u) => fogSide && u.side !== fogSide && !sim.vision.now[fogSide].has(u.id);
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
      if (hidden(u)) continue;
      if (u.soldiers) {
        drawSoldiers(ctx, u, toS, z, dpr, ui);
        continue;
      }
      if (u.dead) continue;
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
      P = FACTIONS[u.side].camo;
      (SPRITES[u.type] || SPRITES.truck)(ctx, u, z);
      // Опознавательная полоса цвета стороны
      if (u.def.move !== 'foot') {
        ctx.fillStyle = SIDES[u.side].color;
        ctx.fillRect(-1.2, -0.25, 0.6, 0.5);
      }
      ctx.restore();
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
    if (u.dead || hidden(u)) continue;
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
    if (u.dead) continue;
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

// Бойцы по отдельности. Поза видна по силуэту сверху:
//  стоя — плечи поперёк направления; пригнувшись — компактнее;
//  лёжа — вытянутый силуэт вдоль направления; в укрытии — только каска и плечи.
function drawSoldiers(ctx, u, toS, z, dpr, ui) {
  const selUnit = ui.selected.has(u.id);
  // Пикселей на «метр силуэта»: не меньше 13 px, чтобы позу было видно и при среднем зуме
  const m = Math.max(z, 13 * dpr);
  for (const s of u.soldiers) {
    const [x, y] = toS(s.x, s.y);
    const isSel = ui.soldier && ui.soldier.unitId === u.id && ui.soldier.idx === s.idx;
    const pose = s.pose || 'stand';
    if (s.evac) continue;
    if (s.dead) {
      // Погибший: тёмное пятно и неподвижный силуэт
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(s.heading + 0.6);
      ctx.fillStyle = 'rgba(90,20,15,0.55)';
      ctx.beginPath(); ctx.ellipse(-0.3 * m, 0.1 * m, 0.7 * m, 0.45 * m, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2e3026';
      ctx.beginPath(); ctx.ellipse(-0.5 * m, 0, 0.6 * m, 0.22 * m, 0, 0, Math.PI * 2); ctx.fill();
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
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(s.heading);
    const body = '#3c4230', dark = '#262a1d';
    const wl = (s.role === 'Пулемётчик' || s.role === 'Снайпер' ? 1.15 : 0.85) * m;
    const shadow = (fn) => { ctx.save(); ctx.translate(0.25 * m, 0.25 * m); ctx.fillStyle = 'rgba(10,12,6,0.45)'; fn(); ctx.restore(); };
    if (pose === 'prone') {
      shadow(() => { ctx.beginPath(); ctx.ellipse(-0.55 * m, 0, 0.85 * m, 0.26 * m, 0, 0, Math.PI * 2); ctx.fill(); });
      ctx.strokeStyle = dark;
      ctx.lineWidth = Math.max(1, 0.14 * m);
      ctx.beginPath();
      ctx.moveTo(-1.0 * m, 0.08 * m); ctx.lineTo(-1.45 * m, 0.28 * m);
      ctx.moveTo(-1.0 * m, -0.08 * m); ctx.lineTo(-1.45 * m, -0.28 * m);
      ctx.stroke();
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(-0.5 * m, 0, 0.62 * m, 0.24 * m, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#1c1e16';
      ctx.beginPath(); ctx.moveTo(0.05 * m, 0.06 * m); ctx.lineTo(0.05 * m + wl, 0.06 * m); ctx.stroke();
      ctx.fillStyle = '#4a5036';
      ctx.beginPath(); ctx.arc(0.12 * m, 0, 0.16 * m, 0, Math.PI * 2); ctx.fill();
    } else if (pose === 'trench' || pose === 'window' || pose === 'inside') {
      ctx.strokeStyle = '#1c1e16';
      ctx.lineWidth = Math.max(1, 0.12 * m);
      if (pose !== 'inside') { ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(wl, 0); ctx.stroke(); }
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(0, 0, 0.16 * m, 0.3 * m, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#4a5036';
      ctx.beginPath(); ctx.arc(0, 0, 0.17 * m, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = Math.max(0.8, 0.05 * m);
      ctx.stroke();
    } else {
      const sc = pose === 'crouch' ? 0.8 : 1;
      shadow(() => { ctx.beginPath(); ctx.ellipse(0, 0, 0.22 * m * sc, 0.34 * m * sc, 0, 0, Math.PI * 2); ctx.fill(); });
      ctx.strokeStyle = '#1c1e16';
      ctx.lineWidth = Math.max(1, 0.12 * m);
      ctx.beginPath(); ctx.moveTo(0.05 * m, 0.1 * m); ctx.lineTo(0.05 * m + wl * sc, 0.1 * m); ctx.stroke();
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(pose === 'crouch' ? 0.05 * m : 0, 0, 0.2 * m * sc, 0.33 * m * sc, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#4a5036';
      ctx.beginPath(); ctx.arc(pose === 'crouch' ? 0.12 * m : 0.02 * m, 0, 0.15 * m, 0, Math.PI * 2); ctx.fill();
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
    if (s.mode === 'dig' && z > 3) {
      const t = (performance.now() / 300 + s.idx) % 1;
      ctx.strokeStyle = '#8a7a5a';
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(s.heading + t) * m * 0.7, y + Math.sin(s.heading + t) * m * 0.7);
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

// ---------- Снаряды в полёте, выстрелы, разрывы и осколки ----------
export function drawArtillery(ctx, sim, view) {
  const { cam, canvas, dpr } = view;
  const z = cam.zoom;
  const toS = (x, y) => [(x - cam.x) * z + canvas.width / 2, (y - cam.y) * z + canvas.height / 2];
  const now = performance.now();
  // Снаряды: точка по дуге (высота условно — смещение вверх на экране)
  for (const sh of sim.art.shells) {
    const p = Math.max(0, Math.min(1, (sim.time - sh.tLaunch) / (sh.tImpact - sh.tLaunch)));
    const [ax, ay] = toS(sh.x0, sh.y0), [bx, by] = toS(sh.x, sh.y);
    const arc = Math.min(160 * dpr, Math.hypot(bx - ax, by - ay) * 0.25);
    const pos = (q) => [ax + (bx - ax) * q, ay + (by - ay) * q - Math.sin(Math.PI * q) * arc];
    const [x, y] = pos(p);
    const [tx, ty] = pos(Math.max(0, p - 0.04));
    ctx.strokeStyle = 'rgba(255,220,160,0.5)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(x, y); ctx.stroke();
    ctx.fillStyle = '#fff2c0';
    ctx.beginPath(); ctx.arc(x, y, 2 * dpr, 0, Math.PI * 2); ctx.fill();
    // Метка точки падения
    ctx.strokeStyle = 'rgba(255,110,80,0.6)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.arc(bx, by, 5 * dpr, 0, Math.PI * 2); ctx.stroke();
  }
  const fx = sim.art.effects;
  for (let i = fx.length - 1; i >= 0; i--) {
    const e = fx[i];
    const t = (now - e.t) / 1000;
    if (t > 4) { fx.splice(i, 1); continue; }
    const [x, y] = toS(e.x, e.y);
    if (e.type === 'muzzle') {
      if (t > 0.25) continue;
      ctx.fillStyle = `rgba(255,200,90,${1 - t * 4})`;
      ctx.beginPath(); ctx.arc(x, y, (6 + t * 30) * dpr, 0, Math.PI * 2); ctx.fill();
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
