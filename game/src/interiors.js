// Планировки зданий: стены с проёмами, двери, окна, комнаты, подвалы/погреба.
// Всё в мировых координатах, чтобы по стенам считать коллизии пехоты.
//
// Типы:
//  • частный дом — прихожая, кухня, 1–2 комнаты; у половины есть погреб;
//  • панельный дом — подъезды (лестничная клетка + 2 квартиры на этаже), общий техподвал;
//  • школа / контора — коридор и кабинеты;
//  • ангар, цех, коровник — большой зал с воротами;
//  • сарай, гараж, теплица — одно помещение.

import { M } from './spatial.js';

const LIGHT = [-0.7071, -0.7071];

export function generateInterior(b, world, rng) {
  if (b.style === 'silo' || b.style === 'car' || b.w * b.h < 10) return null;
  const front = detectFront(b, world);
  // Канонический план: ширина W вдоль фасада, глубина D, фасад при y = -D/2
  const alongW = front === 0 || front === 2;
  const W = alongW ? b.w : b.h, D = alongW ? b.h : b.w;
  const plan = { walls: [], doors: [], windows: [], rooms: [], stairs: [], basement: null, W, D, floors: 1 };

  const big = b.w * b.h;
  if (b.style === 'gable' && big > 350) officePlan(plan, rng, b);
  else if (b.style === 'gable' || b.style === 'hip') housePlan(plan, rng, b);
  else if (b.style === 'flat' && (b.height || 3) >= 12 && Math.max(W, D) >= 30) panelPlan(plan, rng, b);
  else if (b.style === 'flat' && (b.height || 3) >= 12) towerPlan(plan, rng, b);
  else if (b.style === 'flat' && big > 150) officePlan(plan, rng, b);
  else if (b.style === 'hangar' || b.style === 'barn') hallPlan(plan, rng, b);
  else shedPlan(plan, rng, b);

  plan.furniture = furnish(plan, rng);
  return toWorld(plan, b, front);
}

// Какая сторона смотрит на ближайшую дорогу: 0 — «-v», 1 — «+u», 2 — «+v», 3 — «-u»
function detectFront(b, world) {
  const c = Math.cos(b.angle), s = Math.sin(b.angle);
  const sides = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  let best = 0, bd = Infinity;
  sides.forEach(([u, v], i) => {
    const ou = u * b.w / 2, ov = v * b.h / 2;
    const mx = b.x + ou * c - ov * s, my = b.y + ou * s + ov * c;
    const nx = u * c - v * s, ny = u * s + v * c;
    for (let r = 2; r < 60; r += 3) {
      if (world.mask.has(mx + nx * r, my + ny * r, M.ROAD)) {
        if (r < bd) { bd = r; best = i; }
        break;
      }
    }
  });
  return best;
}

// ---------- Вспомогательное построение в каноническом плане ----------
// Стена от (x0,y0) до (x1,y1) с проёмами [{ t, w }] — t от начала стены
function wall(plan, x0, y0, x1, y1, openings = [], outer = false) {
  const L = Math.hypot(x1 - x0, y1 - y0);
  const dx = (x1 - x0) / L, dy = (y1 - y0) / L;
  const cuts = openings.map((o) => [o.t - o.w / 2, o.t + o.w / 2]).sort((a, b) => a[0] - b[0]);
  let t = 0;
  for (const [a, b] of cuts) {
    if (a > t + 0.05) plan.walls.push({ a: [x0 + dx * t, y0 + dy * t], b: [x0 + dx * a, y0 + dy * a], outer });
    t = Math.max(t, b);
  }
  if (t < L - 0.05) plan.walls.push({ a: [x0 + dx * t, y0 + dy * t], b: [x1, y1], outer });
}

function door(plan, x, y, w, ext, nx = 0, ny = 0) {
  plan.doors.push({ p: [x, y], w, ext, n: [nx, ny] });
}

// Окна вдоль наружной стены, пропуская двери и углы
function windows(plan, x0, y0, x1, y1, nx, ny, step, skip = []) {
  const L = Math.hypot(x1 - x0, y1 - y0);
  const dx = (x1 - x0) / L, dy = (y1 - y0) / L;
  for (let t = step / 2 + 0.6; t < L - 0.8; t += step) {
    if (skip.some((sk) => Math.abs(sk - t) < 1.4)) continue;
    plan.windows.push({ p: [x0 + dx * t, y0 + dy * t], n: [nx, ny], w: 1.2 });
  }
}

function room(plan, x0, y0, x1, y1, kind) {
  plan.rooms.push({ r: [x0, y0, x1, y1], kind });
}

// Частный дом: три типа планировки, веранда, зеркальное отражение
function housePlan(plan, rng, b) {
  const { W, D } = plan;
  const hx = W / 2, hy = D / 2;
  const vd = b.veranda || 0; // застеклённая веранда вдоль фасада
  const y0 = -hy + vd; // начало «тёплой» части
  const type = b.houseType || 'std';
  const backDoor = rng.chance(0.35);
  let doorX;
  if (type === 'big') {
    // Коридорная: коридор от входа насквозь, по бокам зал, спальни, кухня, санузел, котельная
    const c0 = -1.1, c1 = 1.1;
    doorX = 0;
    const ym = y0 + (hy - y0) * rng.float(0.45, 0.55);
    wall(plan, c0, y0, c0, hy, [{ t: (ym - y0) / 2, w: 1.0 }, { t: ym - y0 + (hy - ym) * 0.6, w: 1.0 }]);
    wall(plan, c1, y0, c1, hy, [{ t: (ym - y0) / 2, w: 1.0 }, { t: ym - y0 + (hy - ym) / 2, w: 1.0 }]);
    door(plan, c0, (y0 + ym) / 2, 1, false); door(plan, c0, ym + (hy - ym) * 0.6, 1, false);
    door(plan, c1, (y0 + ym) / 2, 1, false); door(plan, c1, ym + (hy - ym) / 2, 1, false);
    wall(plan, -hx, ym, c0, ym);
    wall(plan, c1, ym, hx, ym);
    room(plan, c0, y0, c1, hy, 'коридор');
    room(plan, -hx, y0, c0, ym, 'кухня');
    const yb = ym + (hy - ym) * 0.45;
    wall(plan, -hx, yb, c0, yb, [{ t: (c0 + hx) / 2, w: 0.9 }]);
    door(plan, (-hx + c0) / 2, yb, 0.9, false);
    room(plan, -hx, ym, c0, yb, 'санузел');
    room(plan, -hx, yb, c0, hy, 'котельная');
    room(plan, c1, y0, hx, ym, 'зал');
    room(plan, c1, ym, hx, hy, 'спальня');
  } else if (type === 'small') {
    // Старая хата: сени, кухня с печью, одна комната
    const xs = -hx + W * rng.float(0.38, 0.48);
    const ys = y0 + (hy - y0) * rng.float(0.4, 0.5);
    doorX = (-hx + xs) / 2;
    wall(plan, xs, y0, xs, hy, [{ t: (hy - y0) * 0.35, w: 1.0 }]);
    door(plan, xs, y0 + (hy - y0) * 0.35, 1.0, false);
    wall(plan, -hx, ys, xs, ys, [{ t: (xs + hx) / 2, w: 1.0 }]);
    door(plan, (-hx + xs) / 2, ys, 1.0, false);
    room(plan, -hx, y0, xs, ys, 'сени');
    room(plan, -hx, ys, xs, hy, 'кухня');
    room(plan, xs, y0, hx, hy, 'комната');
  } else {
    // Типовой дом: прихожая, кухня, комната, спальня
    const xs = -hx + W * rng.float(0.38, 0.5);
    const ys = y0 + (hy - y0) * rng.float(0.4, 0.5);
    const ys2 = y0 + (hy - y0) * rng.float(0.45, 0.55);
    doorX = (-hx + xs) / 2;
    wall(plan, xs, y0, xs, hy, [{ t: (ys2 - y0) / 2, w: 1.1 }]);
    door(plan, xs, y0 + (ys2 - y0) / 2, 1.1, false);
    wall(plan, -hx, ys, xs, ys, [{ t: (xs + hx) / 2, w: 1.1 }]);
    door(plan, (-hx + xs) / 2, ys, 1.1, false);
    wall(plan, xs, ys2, hx, ys2, [{ t: 1.2, w: 1.1 }]);
    door(plan, xs + 1.2, ys2, 1.1, false);
    room(plan, -hx, y0, xs, ys, 'прихожая');
    room(plan, -hx, ys, xs, hy, 'кухня');
    room(plan, xs, y0, hx, ys2, 'комната');
    room(plan, xs, ys2, hx, hy, 'спальня');
  }
  // Наружные стены и веранда
  if (vd) {
    wall(plan, -hx, -hy, hx, -hy, [{ t: doorX + hx, w: 1.0 }], true);
    door(plan, doorX, -hy, 1.0, true, 0, -1);
    wall(plan, -hx, y0, hx, y0, [{ t: doorX + hx, w: 1.0 }]);
    door(plan, doorX, y0, 1.0, false);
    room(plan, -hx, -hy, hx, y0, 'веранда');
    windows(plan, -hx, -hy, hx, -hy, 0, -1, 1.3, [doorX + hx]);
  } else {
    wall(plan, -hx, -hy, hx, -hy, [{ t: doorX + hx, w: 1.0 }], true);
    door(plan, doorX, -hy, 1.0, true, 0, -1);
    windows(plan, -hx, -hy, hx, -hy, 0, -1, 2.6, [doorX + hx]);
  }
  wall(plan, hx, -hy, hx, hy, [], true);
  wall(plan, hx, hy, -hx, hy, backDoor ? [{ t: hx - doorX, w: 1.0 }] : [], true);
  wall(plan, -hx, hy, -hx, -hy, [], true);
  if (backDoor) door(plan, doorX, hy, 1.0, true, 0, 1);
  windows(plan, hx, -hy + vd, hx, hy, 1, 0, 2.8);
  windows(plan, -hx, hy, hx, hy, 0, 1, 3.2, backDoor ? [doorX + hx] : []);
  windows(plan, -hx, -hy + vd, -hx, hy, -1, 0, 3.2);
  // Погреб под кухней, лаз из кухни
  const kitchen = plan.rooms.find((r) => r.kind === 'кухня');
  if (kitchen && rng.chance(type === 'small' ? 0.7 : 0.5)) {
    const k = kitchen.r;
    const c = [(k[0] + k[2]) / 2 + 0.4, (k[1] + k[3]) / 2 + 0.4];
    plan.basement = { r: [k[0] + 0.5, k[1] + 0.5, k[2] - 0.5, k[3] - 0.5], kind: 'погреб', access: [c], capacity: 4 };
    plan.stairs.push({ p: c, w: 0.8, h: 0.8, hatch: true });
  }
  plan.front = [0, -1];
  if (rng.chance(0.5)) mirror(plan);
}

// Зеркально по X (дверь и комнаты с другой стороны)
function mirror(plan) {
  const m = (p) => [-p[0], p[1]];
  for (const w of plan.walls) { w.a = m(w.a); w.b = m(w.b); }
  for (const d of plan.doors) { d.p = m(d.p); d.n = [-d.n[0], d.n[1]]; }
  for (const w of plan.windows) { w.p = m(w.p); w.n = [-w.n[0], w.n[1]]; }
  for (const r of plan.rooms) r.r = [-r.r[2], r.r[1], -r.r[0], r.r[3]];
  for (const st of plan.stairs) st.p = m(st.p);
  if (plan.basement) {
    const b = plan.basement;
    b.r = [-b.r[2], b.r[1], -b.r[0], b.r[3]];
    b.access = b.access.map(m);
  }
}

// ---------- Мебель по назначению комнат ----------
function furnish(plan, rng) {
  const out = [];
  const add = (x0, y0, x1, y1, kind) => out.push({ r: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)], kind });
  for (const rm of plan.rooms) {
    const [x0, y0, x1, y1] = rm.r;
    const w = x1 - x0, h = y1 - y0;
    const i = 0.3;
    if (w < 1.2 || h < 1.2) continue;
    // Выбираем стену «подальше от дверей» простым правилом: задняя стена комнаты
    switch (rm.kind) {
      case 'кухня':
        if (plan.W * plan.D < 110) add(x1 - i - 1.5, y1 - i - 1.8, x1 - i, y1 - i, 'печь');
        else add(x0 + i, y1 - i - 0.6, x0 + i + Math.min(2.4, w - 0.8), y1 - i, 'гарнитур');
        add(x0 + w * 0.3, y0 + h * 0.3, x0 + w * 0.3 + 1.1, y0 + h * 0.3 + 0.8, 'стол');
        add(x0 + i, y0 + i, x0 + i + 0.6, y0 + i + 0.6, 'плита');
        break;
      case 'комната':
      case 'зал':
        add(x0 + w * 0.2, y0 + h * 0.25, x1 - w * 0.2, y1 - h * 0.25, 'ковёр');
        add(x1 - i - 0.9, y0 + i, x1 - i, y0 + i + Math.min(2.1, h - 0.8), 'диван');
        add(x0 + i, y1 - i - 0.6, x0 + i + Math.min(1.8, w - 0.8), y1 - i, 'шкаф');
        add((x0 + x1) / 2 - 0.5, (y0 + y1) / 2 - 0.35, (x0 + x1) / 2 + 0.5, (y0 + y1) / 2 + 0.35, 'стол');
        break;
      case 'спальня':
        add(x1 - i - 1.6, y1 - i - 2.0, x1 - i, y1 - i, 'кровать');
        if (w > 3.2) add(x0 + i, y1 - i - 2.0, x0 + i + 0.9, y1 - i, 'кровать');
        add(x0 + i, y0 + i, x0 + i + Math.min(1.6, w - 0.8), y0 + i + 0.6, 'шкаф');
        break;
      case 'санузел':
        add(x0 + i, y0 + i, x0 + i + 0.75, y0 + i + Math.min(1.7, h - 0.6), 'ванна');
        add(x1 - i - 0.45, y1 - i - 0.65, x1 - i, y1 - i, 'унитаз');
        break;
      case 'котельная':
        add(x0 + i, y0 + i, x0 + i + 0.8, y0 + i + 0.8, 'котёл');
        break;
      case 'сени':
      case 'прихожая':
        add(x0 + i, y0 + i, x0 + i + 0.4, y0 + i + Math.min(1.4, h - 0.6), 'вешалка');
        if (w > 2.5) add(x1 - i - 0.8, y1 - i - 0.8, x1 - i, y1 - i, 'ящики');
        break;
      case 'веранда':
        add(x1 - i - 1.4, y0 + i + 0.2, x1 - i, y0 + i + 0.9, 'стол');
        add(x0 + i, y1 - i - 0.5, x0 + i + 1.2, y1 - i, 'ящики');
        break;
      case 'класс':
        for (let x = x0 + 0.8; x < x1 - 1; x += 1.6) for (let y = y0 + 1.6; y < y1 - 0.6; y += 1.2) add(x, y, x + 1.1, y + 0.5, 'парта');
        add((x0 + x1) / 2 - 0.8, y0 + 0.4, (x0 + x1) / 2 + 0.8, y0 + 1.0, 'стол');
        break;
      case 'кабинет':
        add(x0 + w * 0.3, y0 + h * 0.3, x0 + w * 0.3 + 1.4, y0 + h * 0.3 + 0.7, 'стол');
        add(x1 - i - 0.5, y0 + i, x1 - i, y1 - i, 'стеллаж');
        break;
      case 'цех':
        for (let k = 0; k < Math.min(8, Math.floor(w * h / 60)); k++) {
          const cx = x0 + 2 + rng.float(0, w - 4), cy = y0 + 2 + rng.float(0, h - 4);
          add(cx - 1, cy - 0.6, cx + 1, cy + 0.6, rng.chance(0.5) ? 'станок' : 'ящики');
        }
        break;
      case 'коровник':
        for (let x = x0 + 1; x < x1 - 1; x += 1.4) { add(x, y0 + 0.4, x + 0.1, y0 + 2.2, 'стойло'); add(x, y1 - 2.2, x + 0.1, y1 - 0.4, 'стойло'); }
        break;
      case 'сарай':
        add(x0 + i, y0 + i, x0 + i + Math.min(1.8, w - 0.6), y0 + i + 0.7, 'дрова');
        if (h > 2.5) add(x1 - i - 0.9, y1 - i - 0.9, x1 - i, y1 - i, 'ящики');
        break;
      case 'бытовка':
        add(x0 + i, y0 + i, x0 + i + 1.8, y0 + i + 0.7, 'стол');
        break;
    }
  }
  return out;
}

// Панельная многоэтажка: подъезды на фасаде (стороне двора), общий подвал
function panelPlan(plan, rng, b) {
  const { W, D } = plan;
  const hx = W / 2, hy = D / 2;
  plan.floors = Math.max(2, Math.round((b.height || 15) / 3));
  const n = Math.max(1, Math.round(W / 22));
  const sw = W / n;
  const frontOpen = [];
  const access = [];
  for (let i = 0; i < n; i++) {
    const x0 = -hx + i * sw, x1 = x0 + sw, cx = (x0 + x1) / 2;
    const s0 = cx - 1.5, s1 = cx + 1.5, sy = -hy + 5.5;
    frontOpen.push({ t: cx + hx, w: 1.4 });
    door(plan, cx, -hy, 1.4, true, 0, -1);
    // Лестничная клетка
    wall(plan, s0, -hy, s0, sy, [{ t: 3.6, w: 1.0 }]);
    wall(plan, s1, -hy, s1, sy, [{ t: 3.6, w: 1.0 }]);
    wall(plan, s0, sy, s1, sy);
    door(plan, s0, -hy + 3.6, 1.0, false);
    door(plan, s1, -hy + 3.6, 1.0, false);
    room(plan, s0, -hy, s1, sy, 'подъезд');
    plan.stairs.push({ p: [cx, -hy + 3.3], w: 2.4, h: 3.2 });
    access.push([cx, -hy + 3.3]);
    // Квартиры слева и справа от лестницы, каждая на 2 комнаты
    for (const [a0, a1] of [[x0, s0], [s1, x1]]) {
      const ym = -hy + D * rng.float(0.45, 0.55);
      wall(plan, a0, ym, a1, ym, [{ t: (a1 - a0) / 2, w: 1.0 }]);
      door(plan, (a0 + a1) / 2, ym, 1.0, false);
      room(plan, a0, -hy, a1, ym, 'кухня');
      room(plan, a0, ym, a1, hy, 'комната');
    }
    if (i > 0) wall(plan, x0, -hy, x0, hy);
  }
  wall(plan, -hx, -hy, hx, -hy, frontOpen, true);
  wall(plan, hx, -hy, hx, hy, [], true);
  wall(plan, hx, hy, -hx, hy, [], true);
  wall(plan, -hx, hy, -hx, -hy, [], true);
  windows(plan, -hx, -hy, hx, -hy, 0, -1, 3, frontOpen.map((o) => o.t));
  windows(plan, -hx, hy, hx, hy, 0, 1, 3);
  plan.basement = { r: [-hx + 0.8, -hy + 0.8, hx - 0.8, hy - 0.8], kind: 'подвал', access, capacity: Math.round(W * D / 3) };
}

// Точечная башня: ядро с лестницей и 4 квартиры
function towerPlan(plan, rng, b) {
  const { W, D } = plan;
  const hx = W / 2, hy = D / 2;
  plan.floors = Math.max(2, Math.round((b.height || 30) / 3));
  wall(plan, -hx, -hy, hx, -hy, [{ t: hx, w: 1.4 }], true);
  door(plan, 0, -hy, 1.4, true, 0, -1);
  wall(plan, hx, -hy, hx, hy, [], true);
  wall(plan, hx, hy, -hx, hy, [], true);
  wall(plan, -hx, hy, -hx, -hy, [], true);
  // коридор от входа к ядру
  wall(plan, -1.3, -hy, -1.3, -2, [{ t: (hy - 2) / 2, w: 1 }]);
  wall(plan, 1.3, -hy, 1.3, -2, [{ t: (hy - 2) / 2, w: 1 }]);
  wall(plan, -hx, 0, -2, 0, [{ t: (hx - 2) / 2, w: 1 }]);
  wall(plan, 2, 0, hx, 0, [{ t: (hx - 2) / 2, w: 1 }]);
  wall(plan, -2, -2, -2, 2, [{ t: 1, w: 1 }]);
  wall(plan, 2, -2, 2, 2, [{ t: 3, w: 1 }]);
  room(plan, -2, -2, 2, 2, 'подъезд');
  plan.stairs.push({ p: [0, 0.5], w: 2.4, h: 2.4 });
  room(plan, -hx, -hy, -1.3, 0, 'комната'); room(plan, 1.3, -hy, hx, 0, 'кухня');
  room(plan, -hx, 0, -2, hy, 'спальня'); room(plan, 2, 0, hx, hy, 'комната');
  for (const [x0, y0, x1, y1, nx, ny] of [[-hx, -hy, hx, -hy, 0, -1], [hx, -hy, hx, hy, 1, 0], [-hx, hy, hx, hy, 0, 1], [-hx, -hy, -hx, hy, -1, 0]])
    windows(plan, x0, y0, x1, y1, nx, ny, 3, nx === 0 && ny === -1 ? [hx] : []);
  plan.basement = { r: [-hx + 0.8, -hy + 0.8, hx - 0.8, hy - 0.8], kind: 'подвал', access: [[0, 0.5]], capacity: 30 };
}

// Коридорная планировка: школа, контора, вокзал
function officePlan(plan, rng, b) {
  const { W, D } = plan;
  const hx = W / 2, hy = D / 2;
  plan.floors = Math.max(1, Math.round((b.height || 6) / 3.3));
  const cw = 2.6;
  const c0 = -cw / 2, c1 = cw / 2;
  const n = Math.max(2, Math.round(W / 6));
  const rw = W / n;
  const openF = [], openB = [];
  for (let i = 0; i < n; i++) {
    const x0 = -hx + i * rw, x1 = x0 + rw;
    openF.push({ t: rw / 2 + i * rw, w: 1.0 });
    room(plan, x0, -hy, x1, c0, i % 3 === 0 ? 'кабинет' : 'класс');
    room(plan, x0, c1, x1, hy, 'кабинет');
    door(plan, (x0 + x1) / 2, c0, 1.0, false);
    door(plan, (x0 + x1) / 2, c1, 1.0, false);
    if (i > 0) { wall(plan, x0, -hy, x0, c0); wall(plan, x0, c1, x0, hy); }
  }
  wall(plan, -hx, c0, hx, c0, openF);
  wall(plan, -hx, c1, hx, c1, openF.map((o) => ({ ...o })));
  room(plan, -hx, c0, hx, c1, 'коридор');
  // Входы с торцов коридора и в центре фасада
  wall(plan, -hx, -hy, hx, -hy, [{ t: hx, w: 1.6 }], true);
  door(plan, 0, -hy, 1.6, true, 0, -1);
  wall(plan, hx, -hy, hx, hy, [{ t: hy, w: 1.2 }], true);
  door(plan, hx, 0, 1.2, true, 1, 0);
  wall(plan, hx, hy, -hx, hy, [], true);
  wall(plan, -hx, hy, -hx, -hy, [{ t: hy, w: 1.2 }], true);
  door(plan, -hx, 0, 1.2, true, -1, 0);
  // Центральный вход прорезает и коридорную стену
  windows(plan, -hx, -hy, hx, -hy, 0, -1, 3, [hx]);
  windows(plan, -hx, hy, hx, hy, 0, 1, 3);
  plan.stairs.push({ p: [hx - 2, 0], w: 2.2, h: 2.2 });
  if (plan.floors >= 2 || rng.chance(0.5)) plan.basement = { r: [-hx + 0.8, -hy + 0.8, hx - 0.8, hy - 0.8], kind: 'подвал', access: [[hx - 2, 0]], capacity: Math.round(W * D / 4) };
}

// Ангар / цех / коровник: зал с воротами
function hallPlan(plan, rng, b) {
  const { W, D } = plan;
  const hx = W / 2, hy = D / 2;
  const barn = b.style === 'barn';
  if (barn) {
    // Ворота на торцах (коровник вытянут вдоль W или D)
    const longW = W >= D;
    if (longW) {
      wall(plan, -hx, -hy, hx, -hy, [{ t: W * 0.5, w: 1.0 }], true);
      door(plan, 0, -hy, 1.0, true, 0, -1);
      wall(plan, hx, -hy, hx, hy, [{ t: hy, w: 4 }], true);
      door(plan, hx, 0, 4, true, 1, 0);
      wall(plan, hx, hy, -hx, hy, [], true);
      wall(plan, -hx, hy, -hx, -hy, [{ t: hy, w: 4 }], true);
      door(plan, -hx, 0, 4, true, -1, 0);
      windows(plan, -hx, -hy, hx, -hy, 0, -1, 4, [W * 0.5]);
      windows(plan, -hx, hy, hx, hy, 0, 1, 4);
    } else {
      wall(plan, -hx, -hy, hx, -hy, [{ t: hx, w: 4 }], true);
      door(plan, 0, -hy, 4, true, 0, -1);
      wall(plan, hx, hy, -hx, hy, [{ t: hx, w: 4 }], true);
      door(plan, 0, hy, 4, true, 0, 1);
      wall(plan, hx, -hy, hx, hy, [], true);
      wall(plan, -hx, hy, -hx, -hy, [], true);
      windows(plan, hx, -hy, hx, hy, 1, 0, 4);
      windows(plan, -hx, -hy, -hx, hy, -1, 0, 4);
    }
    room(plan, -hx, -hy, hx, hy, 'коровник');
  } else {
    const gate = Math.min(6, W * 0.3);
    wall(plan, -hx, -hy, hx, -hy, [{ t: hx, w: gate }, { t: 2, w: 1 }], true);
    door(plan, 0, -hy, gate, true, 0, -1);
    door(plan, -hx + 2, -hy, 1, true, 0, -1);
    wall(plan, hx, -hy, hx, hy, [], true);
    wall(plan, hx, hy, -hx, hy, [{ t: W - 2, w: 1 }], true);
    door(plan, -hx + 2, hy, 1, true, 0, 1);
    wall(plan, -hx, hy, -hx, -hy, [], true);
    windows(plan, hx, -hy, hx, hy, 1, 0, 5);
    windows(plan, -hx, -hy, -hx, hy, -1, 0, 5);
    // Бытовка в углу
    if (W > 20 && D > 14) {
      wall(plan, hx - 6, -hy, hx - 6, -hy + 5, [{ t: 2.5, w: 1 }]);
      wall(plan, hx - 6, -hy + 5, hx, -hy + 5);
      door(plan, hx - 6, -hy + 2.5, 1, false);
      room(plan, hx - 6, -hy, hx, -hy + 5, 'бытовка');
      room(plan, -hx, -hy, hx - 6, hy, 'цех');
      plan.basement = rng.chance(0.3) ? { r: [hx - 5.5, -hy + 0.5, hx - 0.5, -hy + 4.5], kind: 'подвал', access: [[hx - 3, -hy + 2.5]], capacity: 10 } : null;
      if (plan.basement) plan.stairs.push({ p: [hx - 3, -hy + 2.5], w: 1.2, h: 1.6 });
    } else room(plan, -hx, -hy, hx, hy, 'цех');
    plan.columns = [];
    for (let x = -hx + 6; x < hx - 3; x += 6) for (let y = -hy + 6; y < hy - 3; y += 6) plan.columns.push([x, y]);
  }
}

// Сарай, гараж, теплица, летняя кухня
function shedPlan(plan, rng, b) {
  const { W, D } = plan;
  const hx = W / 2, hy = D / 2;
  const garage = W < 4 && D > 5;
  const gw = garage ? Math.min(W - 0.6, 2.6) : Math.min(1.0, W - 0.8);
  wall(plan, -hx, -hy, hx, -hy, [{ t: hx, w: gw }], true);
  door(plan, 0, -hy, gw, true, 0, -1);
  wall(plan, hx, -hy, hx, hy, [], true);
  wall(plan, hx, hy, -hx, hy, [], true);
  wall(plan, -hx, hy, -hx, -hy, [], true);
  if (!garage && W > 5) windows(plan, hx, -hy, hx, hy, 1, 0, 4);
  room(plan, -hx, -hy, hx, hy, b.style === 'greenhouse' ? 'теплица' : garage ? 'гараж' : 'сарай');
  if (garage && rng.chance(0.5)) {
    // Смотровая яма — тоже укрытие
    plan.basement = { r: [-0.4, -hy + 1.2, 0.4, hy - 0.8], kind: 'смотровая яма', access: [[0, -hy + 1.6]], capacity: 2 };
  }
}

// ---------- В мировые координаты ----------
function toWorld(plan, b, front) {
  // Поворот канонического плана так, чтобы фасад смотрел на сторону front
  const rot = [0, Math.PI / 2, Math.PI, -Math.PI / 2][front];
  // Канон: фасад при -y. front=0 → -v (без поворота); 1 → +u; 2 → +v; 3 → -u
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const c = Math.cos(b.angle), s = Math.sin(b.angle);
  const tw = ([x, y]) => {
    const u = x * cr - y * sr, v = x * sr + y * cr;
    return [b.x + u * c - v * s, b.y + u * s + v * c];
  };
  const tn = ([x, y]) => {
    const u = x * cr - y * sr, v = x * sr + y * cr;
    return [u * c - v * s, u * s + v * c];
  };
  const rectPoly = ([x0, y0, x1, y1]) => [tw([x0, y0]), tw([x1, y0]), tw([x1, y1]), tw([x0, y1])];
  const out = {
    walls: plan.walls.map((w) => ({ a: tw(w.a), b: tw(w.b), outer: w.outer })),
    doors: plan.doors.map((d) => ({ p: tw(d.p), w: d.w, ext: d.ext, n: tn(d.n) })),
    windows: plan.windows.map((w) => ({ p: tw(w.p), n: tn(w.n), w: w.w })),
    rooms: plan.rooms.map((r) => ({ poly: rectPoly(r.r), kind: r.kind, c: tw([(r.r[0] + r.r[2]) / 2, (r.r[1] + r.r[3]) / 2]) })),
    stairs: plan.stairs.map((st) => ({ p: tw(st.p), w: st.w, h: st.h, hatch: !!st.hatch })),
    columns: (plan.columns || []).map(tw),
    furniture: (plan.furniture || []).map((f) => ({ poly: rectPoly(f.r), kind: f.kind })),
    front: tn([0, -1]),
    floors: plan.floors,
    basement: null,
    angle: b.angle + rot,
  };
  if (plan.basement) {
    const bs = plan.basement;
    const [x0, y0, x1, y1] = bs.r;
    const spots = [];
    for (let x = x0 + 0.8; x < x1 - 0.4; x += 1.6) for (let y = y0 + 0.8; y < y1 - 0.4; y += 1.6) spots.push(tw([x, y]));
    out.basement = { poly: rectPoly(bs.r), kind: bs.kind, access: bs.access.map(tw), spots: spots.length ? spots : [tw([(x0 + x1) / 2, (y0 + y1) / 2])], capacity: bs.capacity };
  }
  return out;
}

export { LIGHT };
