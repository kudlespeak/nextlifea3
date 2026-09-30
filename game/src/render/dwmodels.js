// 3D-модели режима «Война дронов»: узлы инфраструктуры (с состояниями: исправен / повреждён /
// разрушен, укрытия 1 и 2 уровня), ПВО, пусковые и летящие дроны. Координаты — метры,
// x — вдоль оси объекта, y — поперёк, z — вверх; начало — центр узла на земле.

import { Model, mat, hex, fbm, vnoise, mix } from './mesh3d.js';

const set = (o, c) => { o[0] = c[0]; o[1] = c[1]; o[2] = c[2]; };
const rect = (x0, x1, y0, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
// Дробная часть без «отрицательного» остатка JS (−0.3 % 1 = −0.3 давало заливку всей половины модели)
const fr = (v) => v - Math.floor(v);
const fm = (v, m) => v - Math.floor(v / m) * m;
// Материалы
const STEEL = mat('#6c7068');
const GALV = mat('#9ea39f', { spec: 0.2 }); // оцинковка порталов ОРУ
const TRGREY = mat('#6f7a74', { fn(o, x, y, z) { mix(o, [40, 45, 42], vnoise(x * 2, y * 2, z * 2) * 0.2); } });
const PORC = mat('#b58a64', { fn(o, x, y, z) { if (fr(z * 6) < 0.35) mix(o, [60, 40, 25], 0.35); } }); // фарфоровые изоляторы
const CONCRETE = mat('#9a978d', { fn(o, x, y, z) { mix(o, [70, 68, 62], vnoise(x * 0.8, y * 0.8, z * 0.8) * 0.3); } });
const CONC_DK = mat('#7b7870', { fn(o, x, y, z) { mix(o, [50, 48, 44], vnoise(x * 0.8, y * 0.8, z * 0.8) * 0.35); } });
const BRICK = mat('#8d5b44', { fn(o, x, y, z, n) { if (Math.abs(n[2]) < 0.5 && (fr(z * 3.4) < 0.12)) mix(o, [200, 190, 170], 0.3); } });
const SOOT = mat('#262320', { fn(o, x, y, z) { mix(o, [80, 60, 40], vnoise(x * 1.5, y * 1.5, z * 1.5) * 0.3); } });
const RUST = mat('#5b4637');
const GABION = mat('#8a8575', { fn(o, x, y, z) { const v = vnoise(x * 5, y * 5, z * 5); mix(o, v > 0.5 ? [120, 115, 100] : [60, 58, 50], 0.5); if (fr((x + y) * 4) < 0.08 || fr(z * 4) < 0.08) mix(o, [40, 40, 38], 0.6); } });
const EARTH = mat('#6d6a45', { fn(o, x, y, z) { mix(o, [90, 80, 50], vnoise(x * 0.5, y * 0.5, z) * 0.4); } });
const COAL = mat('#232220', { fn(o, x, y, z) { mix(o, [60, 58, 55], vnoise(x * 3, y * 3, z * 3) * 0.3); } });
const WHITE = mat('#d8d6cc', { fn(o, x, y, z) { mix(o, [150, 148, 140], vnoise(x * 0.3, y * 0.3, z * 0.3) * 0.25); } });
const TANKW = mat('#c9c8bf', { fn(o, x, y, z, n) { if (Math.abs(n[2]) < 0.5 && (fr(Math.atan2(y, x) * 8) < 0.05)) mix(o, [90, 90, 85], 0.4); } });
const GLASS = mat('#2a3842', { spec: 0.7, ao: false });
const ROOF = mat('#6a6d6b', { fn(o, x, y) { if (fr(x * 0.5) < 0.06) mix(o, [40, 40, 40], 0.3); } });
const BLACK = mat('#141414');

// ------------------------------------------------------------ Трансформатор
function transformer(M, w, h, st, big) {
  const H = big ? 4.6 : 3.4;
  if (st === 'destroyed') {
    // Разорванный бак, выгоревший, осел набок
    M.loft([[0, rect(-w / 2, w / 2, -h / 2, h / 2)], [H * 0.55, rect(-w / 2 + 0.6, w / 2 - 0.2, -h / 2 + 0.4, h / 2 - 0.7)]], SOOT);
    M.box(-w / 2 - 0.8, -w / 2 + 1.2, -h / 2 - 0.5, h / 2 + 0.4, 0, 1.2, RUST);
    M.seg([w * 0.2, 0, H * 0.5], [w * 0.4, h * 0.6, 0.3], 0.4, 0.4, SOOT); // упавший ввод
    return;
  }
  const tank = st === 'damaged' ? SOOT : TRGREY;
  M.box(-w / 2 + 0.6, w / 2 - 0.6, -h / 2 + 1.1, h / 2 - 1.1, 0.3, H, tank);
  // Радиаторы по бокам (рёбра)
  const fins = mat('#5f6964', { fn(o, x) { if (fr(x * 3) < 0.4) mix(o, [25, 28, 26], 0.5); } });
  for (const sg of [1, -1]) M.box(-w / 2 + 1, w / 2 - 1, sg > 0 ? h / 2 - 1.1 : -h / 2, sg > 0 ? h / 2 : -h / 2 + 1.1, 0.6, H - 0.4, st === 'damaged' ? SOOT : fins);
  // Расширитель (консерватор) сверху и вводы с изоляторами
  M.cylX(0, H + 0.7, 0.45, 0.45, -w / 2 + 0.8, -w / 2 + 3, STEEL, 10);
  M.seg([-w / 2 + 1.2, 0, H], [-w / 2 + 1.2, 0, H + 0.7], 0.2, 0.2, STEEL);
  const n = big ? 3 : 3;
  for (let i = 0; i < n; i++) {
    if (st === 'damaged' && i === 1) continue; // отбитый ввод
    const x = -w / 2 + 3.5 + i * ((w - 5) / (n - 1)) * 0.7;
    M.cylZ(x, -0.6, 0.22, 0.14, H, H + (big ? 3.4 : 2.2), PORC, 8);
    M.cylZ(x + 0.6, 0.8, 0.16, 0.1, H, H + 1.4, PORC, 8);
  }
  M.box(-w / 2, -w / 2 + 0.6, -0.8, 0.8, 0.2, 1.6, mat('#48504c')); // шкаф охлаждения
  if (big) {
    // противопожарная стена между автотрансформаторами и маслоприёмник с гравием
    M.box(w / 2 + 1.2, w / 2 + 1.8, -h / 2 - 1.5, h / 2 + 1.5, 0, H + 2.2, CONCRETE);
    M.box(-w / 2 - 1.5, w / 2 + 1.2, -h / 2 - 1.5, h / 2 + 1.5, 0, 0.18, mat('#8a857a', { fn(o, x, y) { mix(o, [60, 58, 52], vnoise(x * 3, y * 3, 0) * 0.5); } }));
  }
  // Маслоприёмник (гравий) и фундамент
  M.box(-w / 2 - 0.3, w / 2 + 0.3, -h / 2 - 0.3, h / 2 + 0.3, 0, 0.3, CONC_DK);
}
function shelter(M, w, h, level, big) {
  const H = (big ? 4.6 : 3.4) + 1.2;
  if (level === 1) {
    // Габионы по периметру (кроме ввода сверху)
    for (const [x0, x1, y0, y1] of [[-w / 2 - 2, w / 2 + 2, -h / 2 - 2, -h / 2 - 0.8], [-w / 2 - 2, w / 2 + 2, h / 2 + 0.8, h / 2 + 2], [-w / 2 - 2, -w / 2 - 0.8, -h / 2 - 2, h / 2 + 2], [w / 2 + 0.8, w / 2 + 2, -h / 2 - 2, h / 2 + 2]])
      M.box(x0, x1, y0, y1, 0, H * 0.75, GABION);
  } else if (level >= 2) {
    // Бетонный «саркофаг» с перекрытием: сверху видно плиту, вводы выведены вбок
    M.box(-w / 2 - 2.2, w / 2 + 2.2, -h / 2 - 2.2, h / 2 + 2.2, 0, H + 0.6, CONCRETE, mat('#8d8a80', { fn(o, x, y) { if (fr((x + 20) * 0.5) < 0.05 || fr((y + 20) * 0.5) < 0.05) mix(o, [50, 50, 45], 0.4); } }));
    for (let i = 0; i < 3; i++) M.cylZ(-w / 2 + 2 + i * 2, h / 2 + 2.6, 0.18, 0.12, 0, H + 2.5, PORC, 8);
  }
}

// ------------------------------------------------------------ ОРУ
function switchyard(M, w, h, st, kv330) {
  const H = kv330 ? 17 : 11;
  const rows = Math.max(2, Math.round(h / (kv330 ? 20 : 9)));
  const cols = Math.max(3, Math.round(w / (kv330 ? 24 : 14)));
  M.box(-w / 2, w / 2, -h / 2, h / 2, 0, 0.15, mat('#9b978a', { fn(o, x, y) { mix(o, [110, 105, 95], vnoise(x * 2, y * 2, 0) * 0.3); } }));
  const dead = st === 'destroyed';
  // Порталы (решётчатые стойки + траверса) и выключатели под ними
  for (let r = 0; r < rows; r++) {
    const y = -h / 2 + ((r + 0.5) * h) / rows;
    const broken = (c) => (dead && (c + r) % 2 === 0) || (st === 'damaged' && (c * 7 + r * 3) % 5 === 0);
    for (let c = 0; c <= cols; c++) {
      const x = -w / 2 + (c * w) / cols;
      if (broken(c)) { M.seg([x, y, 0.3], [x + H * 0.7, y + 1.5, 0.6], 0.5, 0.5, dead ? SOOT : GALV); continue; }
      M.seg([x, y - 0.5, 0], [x, y - 0.3, H], 0.45, 0.45, GALV);
      M.seg([x, y + 0.5, 0], [x, y + 0.3, H], 0.45, 0.45, GALV);
    }
    if (!dead) M.seg([-w / 2, y, H], [w / 2, y, H], 0.35, 0.6, GALV);
    for (let c = 0; c < cols; c++) {
      const x = -w / 2 + ((c + 0.5) * w) / cols;
      if (broken(c)) continue;
      M.box(x - 1.2, x + 1.2, y - 0.6, y + 0.6, 0, 1.4, CONC_DK);
      for (const dy of [-0.35, 0, 0.35]) M.cylZ(x, y + dy * (kv330 ? 4 : 2.4), 0.2, 0.16, 1.4, kv330 ? 7 : 4.5, PORC, 6);
      M.seg([x - 3, y - 2, 0], [x - 3, y - 2, kv330 ? 6 : 4], 0.18, 0.18, GALV); // разъединитель
    }
  }
  // Сборные шины вдоль ОРУ
  const WIRE = mat('#4f534f');
  if (!dead) for (const dy of [-1.5, 0, 1.5]) M.seg([-w / 2, -h / 2 + 2 + dy, H * 0.7], [w / 2, -h / 2 + 2 + dy, H * 0.7], 0.12, 0.12, mat('#8c8f8a'));
  if (!dead) {
    const ph = kv330 ? 4 : 2.4, top = kv330 ? 7 : 4.5;
    for (let r = 0; r < rows; r++) {
      const y = -h / 2 + ((r + 0.5) * h) / rows;
      // три фазы вдоль ряда под траверсами порталов и спуски к каждому выключателю
      for (const dy of [-0.35, 0, 0.35]) M.seg([-w / 2, y + dy * ph, H - 0.8], [w / 2, y + dy * ph, H - 0.8], 0.09, 0.09, WIRE);
      for (let c = 0; c < cols; c++) {
        if ((st === 'damaged' && (c * 7 + r * 3) % 5 === 0)) continue;
        const x = -w / 2 + ((c + 0.5) * w) / cols;
        for (const dy of [-0.35, 0, 0.35]) M.seg([x, y + dy * ph, H - 0.8], [x, y + dy * ph, top], 0.07, 0.07, WIRE);
        // от выключателя через разъединитель к сборным шинам
        if (c % 2 === 0) for (const dy of [-1.5, 0, 1.5]) M.seg([x - 3, y - 2, kv330 ? 6 : 4], [x - 3, -h / 2 + 2 + dy, H * 0.7], 0.07, 0.07, WIRE);
      }
    }
    // молниеотводы по углам ОРУ
    for (const [x, y] of [[-w / 2 - 2, -h / 2 - 2], [w / 2 + 2, -h / 2 - 2], [-w / 2 - 2, h / 2 + 2], [w / 2 + 2, h / 2 + 2]]) {
      M.seg([x, y, 0], [x, y, H + 12], 0.7, 0.7, GALV);
      M.seg([x, y, H + 12], [x, y, H + 17], 0.2, 0.2, GALV);
    }
  }
}

// ------------------------------------------------------------ Здания
function building(M, w, h, H, st, wall = BRICK, roof = ROOF) {
  if (st === 'destroyed') {
    M.loft([[0, rect(-w / 2, w / 2, -h / 2, h / 2)], [H * 0.35, rect(-w / 2 + 1, w / 2 - 2, -h / 2 + 1, h / 2 - 1.5)]], SOOT);
    for (let i = 0; i < 5; i++) M.box(-w / 2 + (i * w) / 5, -w / 2 + (i * w) / 5 + 1.2, -h / 2, -h / 2 + 1, 0, H * (0.5 + 0.1 * (i % 3)), wall);
    return;
  }
  const win = mat(wall.c, { fn(o, x, y, z, n) {
    wall.fn?.(o, x, y, z, n);
    if (Math.abs(n[2]) < 0.5 && (fm(z - 1, 3.3)) > 1 && (fm(z - 1, 3.3)) < 2.4 && (fr((Math.abs(n[0]) > 0.5 ? y : x) * 0.4)) < 0.5 && z < H - 1) set(o, st === 'damaged' ? [20, 18, 16] : [52, 66, 78]);
  } });
  M.box(-w / 2, w / 2, -h / 2, h / 2, 0, H, win, st === 'damaged' ? SOOT : roof);
}

// Машинный зал энергоблока: высокий корпус, котельная, пилоны
function tppUnit(M, w, h, st) {
  const H = 34;
  if (st === 'destroyed') {
    M.box(-w / 2, w / 2, -h / 2, h / 2, 0, 12, SOOT);
    for (let i = 0; i < 6; i++) M.box(-w / 2 + i * (w / 6), -w / 2 + i * (w / 6) + 2, -h / 2, h / 2, 0, H * (0.4 + 0.1 * (i % 3)), CONC_DK);
    return;
  }
  const wall = mat('#a8a497', { fn(o, x, y, z, n) {
    mix(o, [120, 118, 110], vnoise(x * 0.2, y * 0.2, z * 0.2) * 0.2);
    if (Math.abs(n[2]) < 0.5 && z > 8 && z < H - 3 && fr((Math.abs(n[0]) > 0.5 ? y : x) * 0.25) < 0.55) set(o, st === 'damaged' ? [25, 22, 20] : [70, 88, 100]);
  } });
  M.box(-w / 2, w / 2, -h / 2, h / 2 - 22, 0, H, wall, st === 'damaged' ? SOOT : ROOF); // машинный зал
  M.box(-w / 2 + 4, w / 2 - 4, h / 2 - 22, h / 2, 0, H + 14, mat('#8f8b80'), st === 'damaged' ? SOOT : mat('#767470')); // котельная (выше)
  for (let i = 0; i < 4; i++) M.box(-w / 2 + 8 + i * ((w - 16) / 3) - 2, -w / 2 + 8 + i * ((w - 16) / 3) + 2, h / 2 - 20, h / 2 - 16, H + 14, H + 18, STEEL);
}
function chimney(M, st) {
  const H = st === 'destroyed' ? 45 : 120;
  const bands = mat('#b6b0a4', { fn(o, x, y, z) { if (st !== 'destroyed' && z > H - 22 && ((z / 5.5) | 0) % 2 === 0) set(o, [176, 58, 46]); mix(o, [60, 55, 50], Math.max(0, (z - H + 8) / 8) * 0.8); } });
  M.cylZ(0, 0, 9, 5, 0, H, bands, 16);
  M.cylZ(0, 0, 11, 10.5, 0, 3, CONCRETE, 16);
}
function coolingTower(M, st) {
  // Гиперболоид с открытым верхом: снаружи бетонная оболочка, внутри видна тёмная влажная стенка
  // и бассейн с водой; по низу — воздухозаборные окна на колоннах
  const dead = st === 'destroyed';
  const H = dead ? 40 : 76, R0 = 38, N = 28;
  const rad = (z) => R0 * (0.62 + 0.38 * ((z / 76 - 0.78) / 0.78) ** 2);
  const zs = []; for (let i = 0; i <= 10; i++) zs.push(6 + (i / 10) * (H - 6));
  const ang = (k) => (k / N) * Math.PI * 2;
  const shell = mat('#bdb9ae', { fn(o, x, y, z) { mix(o, [112, 110, 102], vnoise(x * 0.15, y * 0.15, z * 0.1) * 0.28); if (z > H - 8) mix(o, [96, 94, 88], 0.35); if (fr(z * 0.18) < 0.05) mix(o, [150, 146, 136], 0.3); } });
  const inner = mat('#4f5552', { fn(o, x, y, z) { mix(o, [34, 40, 40], 0.4 * (1 - z / 76)); mix(o, [70, 74, 70], vnoise(x * 0.2, y * 0.2, z * 0.2) * 0.3); } });
  const faces = [], inF = [];
  for (let r = 0; r < zs.length - 1; r++) {
    const za = zs[r], zb = zs[r + 1], ra = rad(za), rb = rad(zb), ia = ra - 0.8, ib = rb - 0.8;
    for (let k = 0; k < N; k++) {
      const a0 = ang(k), a1 = ang(k + 1), am = (a0 + a1) / 2;
      faces.push({ v: [[Math.cos(a0) * ra, Math.sin(a0) * ra, za], [Math.cos(a1) * ra, Math.sin(a1) * ra, za], [Math.cos(a1) * rb, Math.sin(a1) * rb, zb], [Math.cos(a0) * rb, Math.sin(a0) * rb, zb]], m: shell });
      // внутренняя стенка: нормаль к оси — видна сквозь открытый верх
      inF.push({ v: [[Math.cos(a0) * ia, Math.sin(a0) * ia, za], [Math.cos(a0) * ib, Math.sin(a0) * ib, zb], [Math.cos(a1) * ib, Math.sin(a1) * ib, zb], [Math.cos(a1) * ia, Math.sin(a1) * ia, za]], m: inner, nHint: [-Math.cos(am) * 0.9, -Math.sin(am) * 0.9, 0.44] });
    }
  }
  // верхний венец (кольцо толщины оболочки)
  const rt = rad(H);
  for (let k = 0; k < N; k++) {
    const a0 = ang(k), a1 = ang(k + 1);
    faces.push({ v: [[Math.cos(a0) * (rt - 0.8), Math.sin(a0) * (rt - 0.8), H], [Math.cos(a1) * (rt - 0.8), Math.sin(a1) * (rt - 0.8), H], [Math.cos(a1) * (rt + 0.3), Math.sin(a1) * (rt + 0.3), H], [Math.cos(a0) * (rt + 0.3), Math.sin(a0) * (rt + 0.3), H]], m: mat('#8f8b82'), nHint: [0, 0, 1] });
  }
  M.part(faces);
  M.part(inF);
  // бассейн с водой внутри (видно сверху)
  const rw = rad(6) - 1;
  M.part([{ v: Array.from({ length: N }, (_, k) => [Math.cos(ang(k)) * rw, Math.sin(ang(k)) * rw, 5.5]), m: mat(dead ? '#2b2926' : '#3d5a60', { spec: 0.35, fn(o, x, y) { mix(o, [90, 120, 124], vnoise(x * 0.3, y * 0.3, 1) * 0.35); } }), nHint: [0, 0, 1] }]);
  // колонны воздухозаборных окон и тёмный проём под оболочкой
  const rb0 = rad(6);
  for (let k = 0; k < 20; k++) { const a0 = (k / 20) * Math.PI * 2; M.seg([Math.cos(a0) * rb0, Math.sin(a0) * rb0, 0], [Math.cos(a0) * (rb0 - 0.5), Math.sin(a0) * (rb0 - 0.5), 6], 1.1, 0.9, CONC_DK); }
  M.cylZ(0, 0, rb0 - 1.2, rb0 - 1.2, 0, 5.4, mat('#1f2322'), 24);
  if (dead) for (let i = 0; i < 8; i++) { const a0 = i * 0.8; M.box(Math.cos(a0) * 30 - 4, Math.cos(a0) * 30 + 4, Math.sin(a0) * 30 - 3, Math.sin(a0) * 30 + 3, 0, 4 + (i % 3) * 3, CONC_DK); }
}
function coalYard(M, w, h, st) {
  // Угольный склад: штабели-бурты вдоль склада, между ними рельсы роторного штабелеукладчика,
  // конвейерная галерея к котельной
  const burnt = st !== 'ok';
  M.box(-w / 2, w / 2, -h / 2, h / 2, 0, 0.25, mat('#34322d', { fn(o, x, y) { mix(o, [20, 19, 17], vnoise(x * 0.3, y * 0.3, 0) * 0.5); } }));
  const piles = 2, gap = h / piles;
  const coal = mat(burnt ? '#231f1b' : '#2c2a27', { fn(o, x, y, z) { mix(o, [70, 66, 58], vnoise(x * 0.4, y * 0.4, z * 0.5) * 0.35); if (z > 6) mix(o, [58, 56, 52], 0.25); } });
  for (let i = 0; i < piles; i++) {
    const y0 = -h / 2 + gap * i + 5, y1 = y0 + gap - 14, ym = (y0 + y1) / 2, Hp = burnt ? 4 : 11;
    // бурт — трапеция в разрезе, вытянутая вдоль склада
    const faces = [];
    faces.push({ v: [[-w / 2 + 6, y0, 0.25], [w / 2 - 6, y0, 0.25], [w / 2 - 14, ym - 2, Hp], [-w / 2 + 14, ym - 2, Hp]], m: coal });
    faces.push({ v: [[-w / 2 + 14, ym + 2, Hp], [w / 2 - 14, ym + 2, Hp], [w / 2 - 6, y1, 0.25], [-w / 2 + 6, y1, 0.25]], m: coal });
    faces.push({ v: [[-w / 2 + 14, ym - 2, Hp], [w / 2 - 14, ym - 2, Hp], [w / 2 - 14, ym + 2, Hp], [-w / 2 + 14, ym + 2, Hp]], m: coal, nHint: [0, 0, 1] });
    faces.push({ v: [[w / 2 - 6, y0, 0.25], [w / 2 - 6, y1, 0.25], [w / 2 - 14, ym + 2, Hp], [w / 2 - 14, ym - 2, Hp]], m: coal });
    faces.push({ v: [[-w / 2 + 6, y1, 0.25], [-w / 2 + 6, y0, 0.25], [-w / 2 + 14, ym - 2, Hp], [-w / 2 + 14, ym + 2, Hp]], m: coal });
    M.part(faces);
    // рельсы штабелеукладчика между буртами
    if (i < piles - 1) { const yr = y1 + 7; for (const d of [-2.5, 2.5]) M.box(-w / 2 + 4, w / 2 - 4, yr + d - 0.3, yr + d + 0.3, 0.25, 0.5, STEEL); }
  }
  if (!burnt) {
    // роторный штабелеукладчик: портал на рельсах и стрела над буртом
    const yr = -h / 2 + gap - 2, x = w * 0.1;
    M.box(x - 4, x + 4, yr - 3.5, yr + 3.5, 0.5, 7, mat('#c9a431'));
    M.seg([x, yr, 7], [x + 26, yr - gap * 0.45, 11], 1.4, 1.4, mat('#c9a431'));
    M.cylX(yr - gap * 0.45, 11, 2.6, 2.6, x + 25, x + 28, mat('#8a7a3a'), 10);
  }
  // конвейерная галерея к котельной
  M.seg([-w / 2, -h / 2 + 4, 6], [-w / 2 - 60, -h / 2 - 40, 26], 3, 3, mat('#8a877d'));
  M.seg([-w / 2 + 6, -h / 2 + 4, 0], [-w / 2 + 6, -h / 2 + 4, 6], 1.2, 1.2, STEEL);
}
function oilTank(M, w, st) {
  const r = w / 2, H = 12;
  if (st === 'destroyed') {
    M.cylZ(0, 0, r, r * 0.95, 0, 5, SOOT, 20);
    M.seg([-r, 0, 5], [r * 0.3, r * 0.4, 1], 0.6, 0.3, RUST);
    return;
  }
  M.cylZ(0, 0, r, r, 0, H, st === 'damaged' ? SOOT : TANKW, 20, mat('#a9a8a0', { fn(o, x, y) { if (fr(Math.atan2(y, x) * 4 + 8) < 0.04) mix(o, [60, 60, 55], 0.5); } }));
  M.dome(0, 0, H, r, r, 1.5, mat('#b4b3aa'), 2, 20);
  M.seg([r * 0.7, -r * 0.7, 0], [r * 0.95, -r * 0.3, H], 0.4, 0.4, STEEL); // лестница
  // Обвалование (земляной вал) — общее для площадки, у каждого — кольцо
  M.cylZ(0, 0, r + 4, r + 3.4, 0, 1.2, EARTH, 20, EARTH);
}
// Купол РЭБ: мачта с антенными решётками на бетонном основании
function ewDome(M) {
  M.box(-4, 4, -4, 4, 0, 0.6, CONCRETE);
  M.seg([0, 0, 0.6], [0, 0, 18], 0.5, 0.35, STEEL);
  for (let k = 0; k < 4; k++) { const a = (k * Math.PI) / 2, x = Math.cos(a) * 1.4, y = Math.sin(a) * 1.4; M.box(x - 0.6, x + 0.6, y - 0.6, y + 0.6, 12, 16, mat('#8d9aa3')); }
  M.box(2.5, 5.5, -1.5, 1.5, 0.6, 3, mat('#5d6650'));
}
// Водонапорная башня: ствол и бак наверху
function waterTower(M, w, st) {
  if (st === 'destroyed') { M.cylZ(0, 0, w / 3, w / 3.2, 0, 4, SOOT, 12); M.seg([0, 0, 4], [w / 2, w / 3, 0.5], 0.8, 0.6, RUST); return; }
  M.cylZ(0, 0, w / 5, w / 5.5, 0, 22, mat('#b7aa94'), 12);
  M.cylZ(0, 0, w / 2, w / 2, 22, 28, st === 'damaged' ? SOOT : mat('#8c9aa4'), 16, mat('#7d8a93'));
}
// Копёр угольной шахты: решётчатая башня со шкивами
function headframe(M, w, st) {
  if (st === 'destroyed') { M.box(-w / 2, w / 2, -w / 2, w / 2, 0, 3, SOOT); M.seg([-w / 2, 0, 3], [w, w / 2, 0.5], 0.6, 0.5, RUST); return; }
  for (const [x, y] of [[-w / 3, -w / 3], [w / 3, -w / 3], [-w / 3, w / 3], [w / 3, w / 3]]) M.seg([x, y, 0], [x * 0.4, y * 0.4, 30], 0.5, 0.35, STEEL);
  M.box(-w / 4, w / 4, -w / 4, w / 4, 28, 31, mat('#5a5e58'));
  M.cylY(0, 32, 2.5, -w / 4, w / 4, mat('#3a3c38'), 12); // шкив
  M.box(-w / 2, w / 2, -w / 2, w / 2, 0, 5, st === 'damaged' ? SOOT : mat('#8a6e58'));
}
// Коровник: длинное здание с двускатной крышей
function barn(M, w, h, st) {
  if (st === 'destroyed') { M.box(-w / 2, w / 2, -h / 2, h / 2, 0, 2, SOOT); return; }
  M.box(-w / 2, w / 2, -h / 2, h / 2, 0, 3.2, st === 'damaged' ? SOOT : mat('#d6d0c2'));
  M.loft([[3.2, rect(-w / 2 - 0.4, w / 2 + 0.4, -h / 2 - 0.6, h / 2 + 0.6)], [6, rect(-w / 2 - 0.4, w / 2 + 0.4, -0.2, 0.2)]], mat('#7e6a55'));
}
// Накопитель энергии: ряды контейнеров с батареями
function bessBlock(M, w, h, st) {
  const n = Math.max(2, Math.round(w / 7));
  for (let k = 0; k < n; k++) for (const row of [-1, 1]) {
    const x0 = -w / 2 + k * (w / n) + 0.3, x1 = x0 + w / n - 0.6, y0 = row < 0 ? -h / 2 : 0.6, y1 = row < 0 ? -0.6 : h / 2;
    M.box(x0, x1, y0, y1, 0, st === 'destroyed' && (k + row) % 2 ? 0.8 : 2.6, st === 'destroyed' ? SOOT : mat('#e2e2de', { fn(o, x, y, z, nn) { if (Math.abs(nn[2]) < 0.5 && fr(x * 1.4) < 0.08) mix(o, [90, 100, 110], 0.3); } }));
  }
}
// Понтонный мост: секции на воде и настил
function pontoon(M, w, h, st) {
  const n = Math.max(3, Math.round(w / 7));
  for (let k = 0; k < n; k++) {
    if (st === 'destroyed' && k % 3 === 1) continue;
    const x0 = -w / 2 + k * (w / n), x1 = x0 + w / n - 0.4;
    M.box(x0, x1, -h / 2, h / 2, -0.2, 0.7, mat(st === 'damaged' && k % 2 ? '#3a3a34' : '#5b6448'));
  }
  if (st !== 'destroyed') M.box(-w / 2, w / 2, -h / 2 + 1.2, h / 2 - 1.2, 0.7, 0.9, mat('#6e6a5e'));
}
// Силосный корпус элеватора: два ряда бетонных банок и галерея транспортёра поверху
function siloBlock(M, w, h, st) {
  const n = Math.max(3, Math.round(w / 10)), r = Math.min(w / (n * 2), h / 4), H = st === 'destroyed' ? 9 : 30;
  const SILO = mat('#c9c6bd', { fn(o, x, y, z) { mix(o, [120, 116, 104], vnoise(x * 0.5, y * 0.5, z * 0.3) * 0.25); if (z > 3 && fr(z * 0.22) < 0.04) mix(o, [90, 88, 80], 0.3); } });
  for (let row = 0; row < 2; row++)
    for (let k = 0; k < n; k++) {
      const x = -w / 2 + r + k * r * 2, y = (row - 0.5) * r * 2;
      if (st === 'destroyed' && (k + row) % 2) { M.cylZ(x, y, r, r * 0.9, 0, 4 + (k % 3) * 2, SOOT, 12); continue; }
      M.cylZ(x, y, r, r, 0, H - (st === 'damaged' && k % 3 === 1 ? 10 : 0), st === 'damaged' && k % 2 ? SOOT : SILO, 14, mat('#b8b5ab'));
    }
  if (st !== 'destroyed') {
    M.box(-w / 2, w / 2, -2, 2, H, H + 4, mat('#a9a69b')); // галерея
    M.box(w / 2 - 6, w / 2 + 2, -4, 4, 0, H + 12, CONCRETE); // рабочая башня
  }
}
// Зерносушилка: высокая металлическая колонна с вентиляторами
function dryerTower(M, w, st) {
  if (st === 'destroyed') { M.box(-w / 2, w / 2, -w / 2, w / 2, 0, 3, SOOT); M.seg([-w / 2, 0, 3], [w / 2, w / 3, 0.5], 0.5, 0.4, RUST); return; }
  M.box(-w / 3, w / 3, -w / 3, w / 3, 0, 22, st === 'damaged' ? SOOT : mat('#b7b9b4', { fn(o, x, y, z) { if (fr(z * 0.5) < 0.08) mix(o, [70, 72, 70], 0.35); } }));
  M.box(-w / 2, w / 2, -w / 2, w / 2, 0, 4, STEEL);
  M.cylZ(w / 2 + 1.2, 0, 1.3, 1.3, 1, 3.6, STEEL, 8);
}
function bunker(M, w, h, st) {
  if (st === 'destroyed') {
    M.dome(0, 0, 0, w * 0.55, h * 0.6, 1.2, SOOT, 3, 14);
    for (let i = 0; i < 6; i++) M.box(-w / 2 + i * 3, -w / 2 + i * 3 + 1.8, -h / 2 + (i % 2) * 5, -h / 2 + (i % 2) * 5 + 1.3, 0, 1 + (i % 3) * 0.4, CONC_DK);
    return;
  }
  M.dome(0, 0, 0, w * 0.6, h * 0.75, 4.2, st === 'damaged' ? SOOT : EARTH, 4, 16);
  M.box(w * 0.45, w * 0.62, -2.5, 2.5, 0, 4, CONCRETE); // портал с воротами
  M.box(w * 0.62, w * 0.64, -1.8, 1.8, 0, 3.2, mat('#4d5238'));
}
function hangar(M, w, h, st) {
  if (st === 'destroyed') { M.box(-w / 2, w / 2, -h / 2, h / 2, 0, 2, SOOT); return; }
  const rings = [];
  const n = 8;
  for (let i = 0; i <= n; i++) {
    const a = Math.PI * (i / n);
    rings.push([Math.sin(a) * h * 0.45, rect(-w / 2, w / 2, -Math.cos(a) * h / 2 - 0.01, -Math.cos(a) * h / 2 + 0.01)]);
  }
  // Полуцилиндр вдоль x — как набор коробок-«ламелей»
  for (let i = 0; i < n; i++) {
    const a0 = Math.PI * (i / n), a1 = Math.PI * ((i + 1) / n);
    const y0 = -Math.cos(a0) * h / 2, y1 = -Math.cos(a1) * h / 2;
    M.plate([[-w / 2, y0, Math.sin(a0) * h * 0.45], [w / 2, y0, Math.sin(a0) * h * 0.45], [w / 2, y1, Math.sin(a1) * h * 0.45], [-w / 2, y1, Math.sin(a1) * h * 0.45]], st === 'damaged' ? SOOT : mat('#7d8577', { fn(o, x) { if (fr(x * 0.8) < 0.08) mix(o, [40, 44, 40], 0.4); } }), [0, -Math.cos((a0 + a1) / 2) * 0.9, Math.sin((a0 + a1) / 2)]);
  }
  void rings;
}
function workshop(M, w, h, st) {
  // Цех с шедовой кровлей (зенитные фонари «пилой»)
  const H = 12;
  building(M, w, h, H, st, mat('#a39e90'), mat('#6c706a'));
  if (st === 'destroyed') return;
  const n = Math.max(3, Math.round(w / 10));
  for (let i = 0; i < n; i++) {
    const x0 = -w / 2 + (i * w) / n, x1 = x0 + w / n;
    if (st === 'damaged' && i % 3 === 1) continue;
    M.loft([[H, rect(x0, x1, -h / 2 + 1, h / 2 - 1)], [H + 3.5, rect(x1 - 0.8, x1 - 0.1, -h / 2 + 1, h / 2 - 1)]], mat('#7a7d78'), GLASS);
  }
}
function launcherTruck(M, side, st) {
  // Пусковая: грузовик с наклонной направляющей и дроном на ней (у Кардагора — «Герань», у Велнарии — FP-1)
  const cm = mat(side === 'red' ? '#59603f' : '#4f5c3a');
  if (st === 'destroyed') { M.box(-5, 5, -1.2, 1.2, 0, 1.5, SOOT); return; }
  for (const x of [-3.5, -2.2, 3.2]) for (const sg of [1, -1]) M.cylY(x, 0.5, 0.5, sg > 0 ? 0.8 : -1.2, sg > 0 ? 1.2 : -0.8, BLACK, 10);
  M.box(-5.5, 2.6, -1.2, 1.2, 0.9, 1.4, cm);
  M.box(2.6, 4.6, -1.2, 1.2, 0.9, 3.0, cm);
  M.box(4.58, 4.62, -1, 1, 2, 2.8, GLASS);
  M.seg([-5.8, 0, 1.6], [1.8, 0, 4.2], 0.5, 0.35, STEEL); // направляющая
  if (st === 'ok') {
    const D = new Model();
    (side === 'red' ? droneShahed : droneFP1)(D, 0.8);
    Model.transform(D, -2.2, 0, 3.2, 0);
    // наклон — грубо: приподнять нос
    for (const f of D.parts.flat()) for (const p of f.v) p[2] += (p[0] + 2.2) * 0.33;
    M.merge(D);
  }
}

// ------------------------------------------------------------ Гражданские здания логистики и торговли
function warehouse(M, w, h, st) {
  // Складской корпус класса А: светлые сэндвич-панели, доки для фур вдоль длинной стороны
  const wall = mat('#c9ccc8', { fn(o, x, y, z, n) { if (Math.abs(n[2]) < 0.5 && fr((Math.abs(n[0]) > 0.5 ? y : x) * 0.9) < 0.05) mix(o, [120, 125, 125], 0.4); if (z < 1.2) mix(o, [90, 95, 95], 0.4); } });
  building(M, w, h, 11, st, wall, mat('#8f9496', { fn(o, x, y) { if (fr(y * 0.35) < 0.08) mix(o, [70, 72, 72], 0.4); } }));
  if (st === 'destroyed') return;
  const n = Math.max(3, Math.floor(w / 9));
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + ((i + 0.5) * w) / n;
    M.plate([[x - 1.7, h / 2 + 0.02, 0.3], [x + 1.7, h / 2 + 0.02, 0.3], [x + 1.7, h / 2 + 0.02, 3.8], [x - 1.7, h / 2 + 0.02, 3.8]], mat('#3a4652'), [0, 1, 0]);
    M.box(x - 2, x + 2, h / 2, h / 2 + 2.5, 3.9, 4.2, mat('#6d7275')); // козырёк
  }
}
function canopy(M, w, h, st) {
  if (st === 'destroyed') { M.box(-w / 2, w / 2, -h / 2, h / 2, 0, 1, SOOT); return; }
  for (const x of [-w / 2 + 2, 0, w / 2 - 2]) for (const y of [-h / 2 + 2, h / 2 - 2]) M.seg([x, y, 0], [x, y, 6.5], 0.5, 0.5, mat('#9aa0a2'));
  M.box(-w / 2, w / 2, -h / 2, h / 2, 6.5, 7.4, mat('#e0e2de'), mat('#d8dcd6', { fn(o, x) { if (fr(x * 0.2) < 0.1) mix(o, [40, 90, 160], 0.6); } }));
  for (const y of [-h / 4, h / 4]) M.box(-w / 2 + 4, w / 2 - 4, y - 0.6, y + 0.6, 0, 0.9, CONC_DK); // островки
}
// Навес АЗС: плоская кровля с фирменным фризом, колонки на островках
function fuelCanopy(M, w, h, st, side) {
  if (st === 'destroyed') { M.box(-w / 2, w / 2, -h / 2, h / 2, 0, 0.8, SOOT); for (let i = 0; i < 3; i++) M.seg([-w / 3 + i * w / 3, 0, 0], [-w / 3 + i * w / 3 + 3, 2, 3], 0.4, 0.4, SOOT); return; }
  const brand = side === 'red' ? [200, 40, 36] : [30, 120, 70];
  const post = mat('#d8dad6');
  for (const x of [-w / 2 + 3, w / 2 - 3]) for (const y of [-h / 4, h / 4]) M.seg([x, y, 0], [x, y, 5.4], 0.35, 0.35, post);
  M.box(-w / 2, w / 2, -h / 2, h / 2, 5.4, 6.4, mat('#e4e4e0', { fn(o, x, y, z, n) { if (Math.abs(n[2]) < 0.5) set(o, brand); } }), mat('#eceae4', { fn(o, x, y) { if (Math.abs(y) < 0.6) set(o, brand); } }));
  for (let i = 0; i < 3; i++) {
    const x = -w / 2 + 6 + i * ((w - 12) / 2);
    M.box(x - 3, x + 3, -0.8, 0.8, 0, 0.25, CONC_DK); // островок
    M.box(x - 0.5, x + 0.5, -0.45, 0.45, 0.25, 1.9, mat('#f2f2ee', { fn(o, xx, y, z) { if (z > 1.5) set(o, brand); } })); // колонка
  }
  if (st === 'damaged') M.box(-w / 2, -w / 2 + w * 0.4, -h / 2, h / 2, 5.4, 6.4, SOOT);
}
// Секция машзала ГЭС: бетонный корпус, на крыше — люки над гидроагрегатами, подкрановые пути
function hydroUnit(M, w, h, st) {
  if (st === 'destroyed') { M.box(-w / 2, w / 2, -h / 2, h / 2, 0, 8, SOOT); M.box(-w / 2, -w / 2 + 3, -h / 2, h / 2, 0, 16, CONC_DK); return; }
  M.box(-w / 2, w / 2, -h / 2, h / 2, 0, 16, CONCRETE, mat('#8e8b82', { fn(o, x, y) { const r = Math.hypot(x, y + 2); if (r > 5 && r < 6.2) mix(o, [60, 60, 56], 0.5); if (Math.abs(y - h / 2 + 3) < 0.4) mix(o, [50, 50, 48], 0.5); } }));
  M.cylZ(0, -2, 5.5, 5.5, 16, 16.6, st === 'damaged' ? SOOT : mat('#6f746f'), 16); // люк над агрегатом
  M.box(-w / 2, w / 2, h / 2, h / 2 + 5, 0, 5, CONC_DK); // водоотводящий тракт (нижний бьеф)
}
// Ветроустановка: башня 90 м и гондола (лопасти рисуются отдельно, вращаются)
function windTurbine(M, st) {
  const H = st === 'destroyed' ? 30 : 90;
  M.cylZ(0, 0, 2.2, 1.4, 0, H, st === 'destroyed' ? SOOT : WHITE, 12);
  M.cylZ(0, 0, 5, 5, 0, 1, CONCRETE, 12);
  if (st !== 'destroyed') M.box(-3, 7, -1.6, 1.6, H - 1, H + 2.4, st === 'damaged' ? SOOT : WHITE);
  else M.seg([0, 0, H], [18, 6, 1], 1.2, 0.8, SOOT); // сломанная башня
}
// Поле солнечных панелей: ряды наклонных столов
function pvField(M, w, h, st) {
  const rows = Math.floor(h / 6);
  const panel = mat('#1d2a44', { spec: 0.6, fn(o, x) { if (fr(x * 0.5) < 0.04) mix(o, [180, 190, 200], 0.4); } });
  for (let i = 0; i < rows; i++) {
    const y = -h / 2 + 3 + i * 6;
    const broken = (st === 'destroyed' && i % 3 !== 2) || (st === 'damaged' && i % 4 === 1);
    if (broken) { M.box(-w / 2, w / 2, y - 1.2, y + 1.2, 0, 0.4, SOOT); continue; }
    M.plate([[-w / 2, y - 1.6, 0.8], [w / 2, y - 1.6, 0.8], [w / 2, y + 1.6, 2.4], [-w / 2, y + 1.6, 2.4]], panel, [0, -0.45, 0.9]);
  }
}
function inverter(M, w, h, st) {
  building(M, w, h, 2.8, st, mat('#d9dbd6', { fn(o, x, y, z, n) { if (Math.abs(n[1]) > 0.5 && z > 0.6 && z < 2.2 && fr(x * 1.5) < 0.3) mix(o, [90, 95, 95], 0.5); } }), mat('#c9ccc8'));
}
function mall(M, w, h, st) {
  const wall = mat('#b9b2a4', { fn(o, x, y, z, n) {
    if (Math.abs(n[2]) < 0.5 && z > 7 && z < 9) set(o, [170, 40, 40]); // вывеска
    if (Math.abs(n[2]) < 0.5 && z < 5 && n[1] > 0.5 && Math.abs(x) < w * 0.2) set(o, st === 'ok' ? [60, 90, 110] : [25, 22, 20]); // витрина
  } });
  building(M, w, h, 11, st, wall, mat('#7e8280'));
  if (st === 'destroyed') return;
  for (let i = 0; i < 6; i++) M.box(-w / 2 + 6 + i * (w - 12) / 5 - 1.5, -w / 2 + 6 + i * (w - 12) / 5 + 1.5, -h / 4, -h / 4 + 3, 11, 12.4, mat('#9aa0a2')); // вентиляция
}
function kiosk(M, w, h, st) {
  building(M, w, h, 3.6, st, mat('#d5cbb2', { fn(o, x, y, z, n) { if (n[1] > 0.5 && z > 1 && z < 2.6 && Math.abs(x) < w * 0.3) set(o, [70, 95, 110]); } }), mat('#7a5a44'));
  if (st !== 'destroyed') M.loft([[2.8, rect(-w / 2, w / 2, h / 2, h / 2 + 1.8)], [3.2, rect(-w / 2, w / 2, h / 2, h / 2 + 0.3)]], mat('#3f7d4a', { fn(o, x) { if (fr(x * 1.2) < 0.5) set(o, [225, 225, 215]); } }));
}
function garage(M, w, h, st) {
  building(M, w, h, 7, st, mat('#b7ac9a', { fn(o, x, y, z, n) { if (n[1] > 0.5 && z < 5 && fr((x + w / 2) / (w / 4)) > 0.12) set(o, st === 'ok' ? [165, 40, 36] : [25, 22, 20]); } }), mat('#6d6f6c'));
  if (st !== 'destroyed') M.seg([w / 2 - 3, -h / 2 + 3, 7], [w / 2 - 3, -h / 2 + 3, 16], 0.8, 0.8, mat('#b7ac9a')); // башня для рукавов
}

// ------------------------------------------------------------ Машины на дорогах
const TRAILER = ['#e6e6e2', '#2f5d9e', '#b8372f', '#d9d5c7', '#3f6b45', '#e0b83a'];
function cab(M, x0, x1, w, color, zTop = 3.2) {
  const cm = mat(color);
  M.loft([[1.0, rect(x0, x1, -w, w)], [2.2, rect(x0, x1, -w, w)], [zTop, rect(x0 + 0.1, x1 - 0.25, -w + 0.08, w - 0.08)]], cm);
  M.plate([[x1 + 0.01, -w + 0.15, 2.0], [x1 + 0.01, w - 0.15, 2.0], [x1 - 0.2, w - 0.2, zTop - 0.25], [x1 - 0.2, -w + 0.2, zTop - 0.25]], GLASS, [1, 0, 0.3]);
  M.box(x1 - 0.05, x1 + 0.12, -w + 0.1, w - 0.1, 0.5, 1.0, mat('#2a2c2c')); // бампер
}
function wheelsRow(M, xs, y, R = 0.5) {
  for (const x of xs) for (const sg of [1, -1]) M.cylY(x, R, R, sg > 0 ? y - 0.35 : -y, sg > 0 ? y : -y + 0.35, mat('#1a1a1a'), 10);
}
export function buildVehicle(kind, side, variant = 0) {
  const M = new Model();
  if (kind === 'fura') {
    // Седельный тягач + полуприцеп 13,6 м
    wheelsRow(M, [5.0, 3.3, -4.2, -5.5, -6.8], 1.25, 0.52);
    M.box(1.8, 6.5, -0.5, 0.5, 0.6, 1.1, mat('#2b2b2b'));
    cab(M, 4.4, 6.7, 1.25, ['#e8e8e4', '#1f4f8f', '#a83a2a', '#3a3a3a'][variant % 4], 3.6);
    M.box(-8.2, 5.0, -1.28, 1.28, 1.2, 4.0, mat(TRAILER[variant % TRAILER.length], { fn(o, x, y, z, n) { if (Math.abs(n[2]) < 0.5 && fr(x * 0.6) < 0.04) mix(o, [0, 0, 0], 0.15); } }));
  } else if (kind === 'grain') {
    // Зерновоз-самосвал: трёхосное шасси, высокий кузов под тентом
    wheelsRow(M, [2.9, -1.5, -2.9], 1.2, 0.52);
    cab(M, 1.9, 3.9, 1.2, ['#e8e8e4', '#2f5d9e', '#c8a23a'][variant % 3], 3.0);
    M.box(-4.1, 1.7, -1.25, 1.25, 1.2, 3.4, mat('#8d6b3a', { fn(o, x, y, z, n) { if (Math.abs(n[2]) < 0.5 && fr(x * 0.8) < 0.06) mix(o, [40, 30, 20], 0.25); } }), mat('#d8b85a'));
  } else if (kind === 'grainx') {
    // Тягач с зерновым полуприцепом-хоппером (воронки снизу)
    wheelsRow(M, [5.0, 3.3, -4.2, -5.5, -6.8], 1.25, 0.52);
    M.box(1.8, 6.5, -0.5, 0.5, 0.6, 1.1, mat('#2b2b2b'));
    cab(M, 4.4, 6.7, 1.25, ['#e8e8e4', '#1f4f8f', '#3a3a3a'][variant % 3], 3.6);
    M.loft([[1.0, rect(-7.4, 4.2, -0.5, 0.5)], [1.9, rect(-8.2, 5.0, -1.28, 1.28)], [3.9, rect(-8.2, 5.0, -1.28, 1.28)]], mat('#c7c9c4'), mat('#d9c37a'));
  } else if (kind === 'tractor') {
    // Трактор (К-700-подобный, шарнирная рама) с сеялкой/плугом сзади
    for (const x of [1.6, -1.2]) for (const sg of [1, -1]) M.cylY(x, 0.95, 0.95, sg > 0 ? 0.9 : -1.6, sg > 0 ? 1.6 : -0.9, mat('#1a1a1a'), 12);
    M.box(0.2, 2.6, -0.8, 0.8, 0.8, 1.9, mat(side === 'red' ? '#c84a2a' : '#2f7a3a'));
    cab(M, -1.4, 0.2, 0.85, side === 'red' ? '#c84a2a' : '#2f7a3a', 3.2);
    M.box(-2.3, -1.4, -0.9, 0.9, 0.8, 1.9, mat('#3a3a38'));
    M.box(-6.8, -3.2, -3.0, 3.0, 0.3, 1.0, mat('#6b6a60')); // сеялка / борона
    M.seg([-2.3, 0, 0.8], [-3.2, 0, 0.7], 0.15, 0.15, STEEL);
  } else if (kind === 'combine') {
    // Зерноуборочный комбайн: жатка спереди, бункер, выгрузной шнек
    wheelsRow(M, [2.0], 1.5, 0.95); wheelsRow(M, [-2.6], 1.3, 0.6);
    M.box(-3.6, 2.8, -1.4, 1.4, 0.8, 3.4, mat('#3f8a3a', { fn(o, x, y, z, n) { if (z < 1.2) mix(o, [40, 40, 36], 0.5); } }));
    cab(M, 1.6, 3.0, 0.95, '#3f8a3a', 4.2);
    M.box(-2.8, 0.6, -1.3, 1.3, 3.4, 4.3, mat('#d8b85a')); // бункер с зерном
    M.box(3.0, 5.2, -3.6, 3.6, 0.3, 1.4, mat('#c9c24a', { fn(o, x, y, z, n) { if (fr(y * 1.5) < 0.12) mix(o, [60, 60, 30], 0.4); } })); // жатка
    M.seg([-1.2, 1.2, 4.0], [-2.4, 4.6, 4.2], 0.25, 0.25, mat('#3f8a3a')); // шнек
  } else if (kind === 'van') {
    wheelsRow(M, [2.2, -1.8], 1.1, 0.45);
    cab(M, 1.6, 3.4, 1.1, ['#e8e8e4', '#2f5d9e', '#d9d5c7'][variant % 3], 2.8);
    M.box(-3.4, 1.5, -1.15, 1.15, 0.9, 3.3, mat(TRAILER[(variant + 1) % TRAILER.length]));
  } else if (kind === 'crew') {
    // Ремонтная машина энергетиков: оранжевая кабина, кузов с гидроподъёмником
    wheelsRow(M, [2.3, -2.0], 1.15, 0.5);
    cab(M, 1.3, 3.5, 1.15, '#e0782a', 2.9);
    M.box(-3.6, 1.2, -1.2, 1.2, 0.9, 1.8, mat('#d9d7cf', { fn(o, x, y, z, n) { if (Math.abs(n[1]) > 0.5 && z > 1.2 && z < 1.5) set(o, [230, 120, 40]); } }));
    M.cylZ(-2.8, 0, 0.4, 0.35, 1.8, 2.3, mat('#6d6d6d'), 8);
    M.seg([-2.8, 0, 2.3], [1.0, 0.3, 3.2], 0.35, 0.35, mat('#e8e6e0'));
    M.box(0.9, 1.6, -0.2, 0.8, 2.9, 3.6, mat('#e0782a')); // люлька
  } else if (kind === 'tanker') {
    // Бензовоз: кабина + цистерна
    wheelsRow(M, [2.9, -1.6, -2.9], 1.15, 0.5);
    cab(M, 1.9, 3.9, 1.15, ['#e8e8e4', '#d9a13a', '#3a3a3a'][variant % 3], 3.0);
    M.cylX(0, 2.0, 1.1, 1.1, -3.9, 1.7, mat('#d6d6d0', { fn(o, x, y, z) { if (z > 1.8 && z < 2.2) set(o, side === 'red' ? [200, 40, 36] : [30, 120, 70]); } }), 14);
    M.box(-3.9, 1.8, -0.9, 0.9, 0.7, 1.0, mat('#2b2b2b'));
  } else if (kind === 'car') {
    // Легковой: седан/хэтчбек/кроссовер разных цветов
    const col = ['#d9d9d4', '#1d1f22', '#8a8f94', '#5c1f1f', '#26406b', '#e8e6de', '#3f4a3d', '#b1462c'][variant % 8];
    const cm = mat(col, { spec: 0.35 });
    const suv = variant % 5 === 3;
    for (const x of [1.35, -1.35]) for (const sg of [1, -1]) M.cylY(x, 0.33, 0.33, sg > 0 ? 0.62 : -0.85, sg > 0 ? 0.85 : -0.62, mat('#161616'), 8);
    M.box(-2.2, 2.2, -0.86, 0.86, 0.3, suv ? 1.05 : 0.85, cm);
    M.loft([[suv ? 1.05 : 0.85, rect(-1.5, 1.0, -0.82, 0.82)], [suv ? 1.7 : 1.42, rect(-1.2, 0.55, -0.72, 0.72)]], mat('#2a3440', { spec: 0.6 }), cm);
  } else if (kind === 'gtu') {
    // Мобильная газотурбинная установка: полуприцеп с кожухом турбины, выхлопная труба, модуль управления
    wheelsRow(M, [6.2, 4.6, -4.5, -5.8, -7.1], 1.25, 0.52);
    M.box(-8.5, 7.5, -1.3, 1.3, 1.1, 1.5, mat('#3b3d3a'));
    M.box(-8, 3, -1.25, 1.25, 1.5, 4.2, mat(side === 'red' ? '#c9c2b0' : '#d6d8d2', { fn(o, x, y, z, n) { if (Math.abs(n[1]) > 0.5 && fr(x * 0.8) < 0.08) mix(o, [80, 80, 78], 0.4); } }));
    M.cylZ(-6.5, 0, 0.9, 0.8, 4.2, 7.4, mat('#6d6f6c'), 10); // выхлоп
    M.box(3.2, 7.4, -1.25, 1.25, 1.5, 3.6, mat('#4d6a8a'));
  } else if (kind === 'bus') {
    const cm = mat(['#e3c23a', '#d9d9d4', '#3a6fb0'][variant % 3], { fn(o, x, y, z, n) { if (Math.abs(n[2]) < 0.5 && z > 1.5 && z < 2.5) set(o, [40, 52, 62]); } });
    wheelsRow(M, [3.2, -3.0], 1.2, 0.5);
    M.box(-5.5, 5.5, -1.25, 1.25, 0.4, 3.0, cm, mat('#cfd1cc'));
  } else if (kind === 'fire') {
    const red = mat('#b8231e', { fn(o, x, y, z, n) { if (Math.abs(n[1]) > 0.5 && z > 1.3 && z < 1.6) set(o, [235, 235, 225]); } });
    wheelsRow(M, [2.6, -1.4, -2.7], 1.2, 0.5);
    M.loft([[1.0, rect(1.4, 3.8, -1.2, 1.2)], [3.0, rect(1.5, 3.55, -1.15, 1.15)]], red);
    M.plate([[3.81, -1.0, 1.9], [3.81, 1.0, 1.9], [3.6, 1.0, 2.8], [3.6, -1.0, 2.8]], GLASS, [1, 0, 0.3]);
    M.box(-3.8, 1.4, -1.25, 1.25, 0.9, 3.0, red);
    M.box(-3.6, 1.2, -0.45, 0.45, 3.0, 3.35, mat('#c9ccc8', { fn(o, x) { if (fr(x * 2.5) < 0.2) mix(o, [60, 60, 60], 0.5); } })); // лестница
    M.box(2.0, 3.0, -0.8, 0.8, 3.0, 3.2, mat('#3a6fd8', { ao: false, glow: 30 })); // мигалки
  }
  return M;
}

// ------------------------------------------------------------ Дроны (в полёте)
function droneShahed(M, k = 1, color = '#8a8f8a') {
  const body = mat(color, { fn(o, x, y, z) { mix(o, [60, 62, 60], vnoise(x * 3, y * 3, z * 3) * 0.2); } });
  // Треугольное крыло 2.5 м, фюзеляж, законцовки-кили, толкающий винт
  M.loft([[0.15 * k, [[1.4 * k, 0], [-1.4 * k, 1.25 * k], [-1.6 * k, 1.25 * k], [-1.6 * k, -1.25 * k], [-1.4 * k, -1.25 * k]]], [0.3 * k, [[1.35 * k, 0], [-1.35 * k, 1.2 * k], [-1.55 * k, 1.2 * k], [-1.55 * k, -1.2 * k], [-1.35 * k, -1.2 * k]]]], body);
  M.cylX(0, 0.35 * k, 0.22 * k, 0.24 * k, -1.6 * k, 1.1 * k, body, 10);
  M.dome(1.1 * k, 0, 0.35 * k - 0.2 * k, 0.35 * k, 0.2 * k, 0.2 * k, body, 2, 10);
  for (const sg of [1, -1]) M.loft([[0.3 * k, rect(-1.6 * k, -1.2 * k, sg * 1.2 * k - 0.03, sg * 1.2 * k + 0.03)], [0.8 * k, rect(-1.6 * k, -1.45 * k, sg * 1.2 * k - 0.03, sg * 1.2 * k + 0.03)]], body);
  M.plate([[-1.7 * k, -0.02, 0.05 * k], [-1.7 * k, 0.02, 0.05 * k], [-1.7 * k, 0.02, 0.65 * k], [-1.7 * k, -0.02, 0.65 * k]], BLACK, [-1, 0, 0]);
}
function droneGeran3(M) {
  droneShahed(M, 1, '#2b2d2c');
  M.cylX(0, 0.62, 0.18, 0.2, -1.8, -0.4, mat('#555855'), 10); // ТРД сверху
}
function droneFP1(M, k = 1, color = '#b0b4ad') {
  const body = mat(color, { fn(o, x, y, z) { mix(o, [80, 84, 80], vnoise(x * 3, y * 3, z * 3) * 0.2); } });
  M.cylX(0, 0.35 * k, 0.2 * k, 0.16 * k, -1.8 * k, 1.5 * k, body, 10);
  M.dome(1.5 * k, 0, 0.35 * k - 0.16 * k, 0.3 * k, 0.16 * k, 0.16 * k, body, 2, 8);
  M.box(0.1 * k, 0.6 * k, -2.2 * k, 2.2 * k, 0.48 * k, 0.55 * k, body); // прямое крыло
  M.box(-1.8 * k, -1.5 * k, -0.7 * k, 0.7 * k, 0.38 * k, 0.42 * k, body); // стабилизатор
  M.loft([[0.4 * k, rect(-1.8 * k, -1.4 * k, -0.03, 0.03)], [0.9 * k, rect(-1.8 * k, -1.65 * k, -0.03, 0.03)]], body);
  M.plate([[-1.85 * k, -0.02, 0.0], [-1.85 * k, 0.02, 0.0], [-1.85 * k, 0.02, 0.7 * k], [-1.85 * k, -0.02, 0.7 * k]], BLACK, [-1, 0, 0]);
}
function droneLyutyi(M, color = '#c7c9c2') {
  const body = mat(color);
  M.cylX(0, 0.45, 0.28, 0.2, -2.0, 1.4, body, 10);
  M.box(-0.2, 0.5, -3.3, 3.3, 0.72, 0.8, body); // верхнеплан
  M.seg([-0.2, 0, 0.55], [-0.2, 0, 0.75], 0.15, 0.3, body);
  M.box(-2.3, -1.9, -0.9, 0.9, 0.9, 0.95, body); // Т-образное оперение
  M.loft([[0.45, rect(-2.3, -1.7, -0.03, 0.03)], [0.95, rect(-2.3, -2.05, -0.03, 0.03)]], body);
  M.plate([[-2.05, -0.02, 0.1], [-2.05, 0.02, 0.1], [-2.05, 0.02, 0.8], [-2.05, -0.02, 0.8]], BLACK, [-1, 0, 0]);
}
function droneFP2(M, color = '#8e9489') {
  const body = mat(color);
  M.cylX(0, 0.5, 0.32, 0.26, -2.0, 1.8, body, 12);
  M.dome(1.8, 0, 0.24, 0.45, 0.26, 0.26, body, 2, 10);
  M.box(-0.2, 0.55, -2.6, 2.6, 0.55, 0.62, body);
  for (const sg of [1, -1]) M.loft([[0.5, rect(-2.0, -1.5, sg * 0.4 - 0.03, sg * 0.4 + 0.03)], [1.1, rect(-2.0, -1.75, sg * 0.45 - 0.03, sg * 0.45 + 0.03)]], body);
  M.box(-2.0, -1.6, -0.5, 0.5, 0.5, 0.55, body);
  M.plate([[-2.05, -0.02, 0.05], [-2.05, 0.02, 0.05], [-2.05, 0.02, 0.95], [-2.05, -0.02, 0.95]], BLACK, [-1, 0, 0]);
}
function droneBober(M, color = '#9aa08f') {
  const body = mat(color);
  // Утка с треугольным крылом
  M.cylX(0, 0.3, 0.16, 0.14, -1.3, 1.3, body, 8);
  M.loft([[0.28, [[0.2, 0], [-1.2, 1.3], [-1.3, 1.3], [-1.3, -1.3], [-1.2, -1.3]]], [0.33, [[0.15, 0], [-1.15, 1.25], [-1.25, 1.25], [-1.25, -1.25], [-1.15, -1.25]]]], body);
  M.box(0.9, 1.1, -0.5, 0.5, 0.33, 0.36, body);
  M.loft([[0.3, rect(-1.3, -0.9, -0.03, 0.03)], [0.8, rect(-1.3, -1.15, -0.03, 0.03)]], body);
}
function droneGerbera(M) {
  droneShahed(M, 0.72, '#d9d6c8');
}
function droneLancet(M, k = 1) {
  const body = mat('#6d7560');
  M.cylX(0, 0.2, 0.08, 0.08, -0.7 * k, 0.8 * k, body, 8);
  M.dome(0.8 * k, 0, 0.12, 0.12, 0.08, 0.08, body, 2, 8);
  // Две крестообразные группы крыльев (X-X)
  for (const x of [0.35 * k, -0.45 * k]) for (const a of [0.785, -0.785]) {
    const c = Math.cos(a), s = Math.sin(a);
    M.plate([[x - 0.14, 0, 0.2], [x + 0.14, 0, 0.2], [x + 0.08, c * 0.6, 0.2 + s * 0.6], [x - 0.14, c * 0.6, 0.2 + s * 0.6]], body, [0, -s, c]);
    M.plate([[x - 0.14, 0, 0.2], [x + 0.14, 0, 0.2], [x + 0.08, -c * 0.6, 0.2 + s * 0.6], [x - 0.14, -c * 0.6, 0.2 + s * 0.6]], body, [0, s, c]);
  }
}
function droneOrlan(M) {
  const body = mat('#d4d2c6');
  M.cylX(0, 0.3, 0.15, 0.12, -0.6, 0.8, body, 8);
  M.box(-0.1, 0.25, -1.55, 1.55, 0.45, 0.5, body); // высокоплан
  M.seg([-0.6, 0, 0.3], [-1.3, 0, 0.35], 0.05, 0.05, body); // хвостовая балка
  M.box(-1.45, -1.25, -0.4, 0.4, 0.35, 0.38, body);
  M.loft([[0.36, rect(-1.45, -1.25, -0.02, 0.02)], [0.65, rect(-1.45, -1.38, -0.02, 0.02)]], body);
  M.plate([[-0.62, -0.02, 0.05], [-0.62, 0.02, 0.05], [-0.62, 0.02, 0.55], [-0.62, -0.02, 0.55]], BLACK, [-1, 0, 0]);
}
function droneLeleka(M) {
  const body = mat('#8b907f');
  // Летающее крыло
  M.loft([[0.1, [[0.6, 0], [-0.1, 1.95], [-0.35, 1.95], [-0.35, -1.95], [-0.1, -1.95]]], [0.2, [[0.55, 0], [-0.1, 1.9], [-0.3, 1.9], [-0.3, -1.9], [-0.1, -1.9]]]], body);
  M.dome(0.1, 0, 0.18, 0.5, 0.18, 0.15, body, 2, 8);
}
function droneInterceptor(M, side) {
  const body = mat(side === 'blue' ? '#3c4046' : '#4b4f3c');
  // «Пуля»: вытянутый корпус с четырьмя винтами (взлёт вертикальный, полёт носом вперёд)
  M.cylX(0, 0.25, 0.09, 0.07, -0.35, 0.45, body, 8);
  M.dome(0.45, 0, 0.18, 0.12, 0.07, 0.07, body, 2, 8);
  for (const [x, y] of [[0.2, 0.22], [0.2, -0.22], [-0.25, 0.22], [-0.25, -0.22]]) { M.seg([x * 0.3, y * 0.3, 0.25], [x, y, 0.27], 0.03, 0.02, BLACK); M.cylZ(x, y, 0.12, 0.12, 0.27, 0.28, mat('#1a1a1a'), 10); }
}
// «Охотник»: «Герань» с гиростабилизированной камерой под носом
function droneHunter(M, color) {
  droneShahed(M, 1, color);
  M.dome(0.9, 0, 0.02, 0.22, 0.22, 0.2, mat('#1b1d20', { spec: 0.6 }), 2, 10);
}
// «Молния-2»: простое крыло с двумя балками, толкающий винт
function droneMolniya(M) {
  const body = mat('#7a7f6c');
  M.box(-0.2, 0.25, -1.1, 1.1, 0.25, 0.3, body);
  M.cylX(0, 0.2, 0.1, 0.08, -0.4, 0.5, body, 8);
  for (const sg of [1, -1]) M.box(-1.2, -0.1, sg * 0.35 - 0.03, sg * 0.35 + 0.03, 0.22, 0.26, body);
  M.box(-1.25, -1.05, -0.4, 0.4, 0.3, 0.33, body);
  M.plate([[-0.45, -0.02, 0.05], [-0.45, 0.02, 0.05], [-0.45, 0.02, 0.4], [-0.45, -0.02, 0.4]], BLACK, [-1, 0, 0]);
}
// «Сакер»: небольшой самолёт с V-образным хвостом и камерой
function droneSaker(M) {
  const body = mat('#5d6557');
  M.cylX(0, 0.3, 0.14, 0.11, -0.9, 0.9, body, 8);
  M.box(-0.1, 0.25, -1.3, 1.3, 0.4, 0.44, body);
  for (const sg of [1, -1]) M.plate([[-0.9, 0, 0.35], [-0.65, 0, 0.35], [-0.8, sg * 0.45, 0.7], [-0.95, sg * 0.45, 0.7]], body, [0, -sg * 0.7, 0.7]);
  M.dome(0.7, 0, 0.12, 0.12, 0.12, 0.1, mat('#15171a', { spec: 0.6 }), 2, 8);
}
// Цветовые варианты: серые, ночные чёрные, светлые; у западных — серо-зелёные и тёмные
const PAL = {
  shahed: ['#8a8f8a', '#26282a', '#b9b7ad'], geran_h: ['#5c6154', '#26282a', '#8a8f8a'], gerbera: ['#d9d6c8', '#c7c3b4', '#e2e0d4'],
  fp1: ['#b0b4ad', '#6f7a5f', '#3d4148'], lyutyi: ['#c7c9c2', '#8d9486', '#e0e0da'], fp2: ['#8e9489', '#5f6a55', '#40443e'], bober: ['#9aa08f', '#6c7560', '#3e423c'], grif: ['#cfd2cc', '#b8bcb4', '#dcdcd4'],
};
const DRONE_BUILD = {
  shahed: (M, c) => droneShahed(M, 1, c), geran3: droneGeran3, gerbera: (M, c) => droneShahed(M, 0.72, c), fp1: (M, c) => droneFP1(M, 1, c), fp2: droneFP2, lyutyi: droneLyutyi, bober: droneBober,
  geran_h: droneHunter, molniya: droneMolniya, saker: droneSaker, grif: (M, c) => droneFP1(M, 0.85, c),
  lancet: (M) => droneLancet(M), warmate: (M) => droneLancet(M, 0.8), orlan: droneOrlan, leleka: droneLeleka, sting: (M) => droneInterceptor(M, 'blue'), elka: (M) => droneInterceptor(M, 'red'),
};
export function buildDrone(type, variant = 0) {
  const M = new Model();
  const pal = PAL[type];
  (DRONE_BUILD[type] || droneShahed)(M, pal ? pal[variant % pal.length] : undefined);
  return M;
}

// ------------------------------------------------------------ Узлы по типу
// Руины здания: обгоревший пол, куски стен разной высоты по периметру, кучи обломков, упавшие балки
const RUIN_WALL = { ctrl: BRICK, house: CONCRETE, pump: BRICK, shop: CONCRETE, hall: CONCRETE, store: CONCRETE, garage: BRICK, barn: BRICK, mall: CONCRETE, kiosk: CONCRETE, dryer: CONCRETE, inv: CONCRETE, canopy: null, fcanopy: null };
const RUIN_H = { ctrl: 7, house: 15, pump: 5, shop: 12, hall: 10, store: 8, garage: 6, barn: 4, mall: 10, kiosk: 3.5, dryer: 18, inv: 3 };
function ruins(M, w, h, k) {
  let seed = (Math.round(w * 13 + h * 7) * 2654435761) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const wall = RUIN_WALL[k], H = RUIN_H[k] || 6;
  M.box(-w / 2, w / 2, -h / 2, h / 2, 0, 0.3, mat('#2c2925', { fn(o, x, y) { mix(o, [70, 62, 52], vnoise(x * 0.5, y * 0.5, 0) * 0.45); } }));
  const debris = mat('#6d665c', { fn(o, x, y, z) { mix(o, [40, 36, 32], vnoise(x * 0.9, y * 0.9, z) * 0.6); if (fr(x * 0.7 + y * 0.3) < 0.1) mix(o, [140, 90, 60], 0.35); } });
  // обломки внутри контура
  const nPiles = Math.max(2, Math.round((w * h) / 350));
  for (let i = 0; i < Math.min(nPiles, 14); i++) {
    const rx = Math.min(w, h) * (0.12 + rnd() * 0.18), cx = (rnd() - 0.5) * (w - rx * 2), cy = (rnd() - 0.5) * (h - rx * 2);
    M.dome(cx, cy, 0.3, rx, rx * (0.7 + rnd() * 0.5), 1.2 + rnd() * Math.min(4, H * 0.35), debris, 3, 10);
  }
  if (wall) {
    // уцелевшие куски стен: периметр режется на отрезки, часть стоит, часть обвалилась
    const top = mat('#1f1c19');
    const side = (x0, y0, x1, y1) => {
      const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.round(L / 6));
      for (let i = 0; i < n; i++) {
        if (rnd() < 0.35) continue;
        const t0 = i / n, t1 = (i + 1) / n, hh = H * (0.25 + rnd() * 0.6);
        const ax = x0 + (x1 - x0) * t0, ay = y0 + (y1 - y0) * t0, bx = x0 + (x1 - x0) * t1, by = y0 + (y1 - y0) * t1;
        M.box(Math.min(ax, bx) - 0.3, Math.max(ax, bx) + 0.3, Math.min(ay, by) - 0.3, Math.max(ay, by) + 0.3, 0, hh, wall, top);
      }
    };
    side(-w / 2, -h / 2, w / 2, -h / 2); side(-w / 2, h / 2, w / 2, h / 2); side(-w / 2, -h / 2, -w / 2, h / 2); side(w / 2, -h / 2, w / 2, h / 2);
  }
  // упавшие балки и фермы перекрытия
  for (let i = 0; i < Math.min(6, 1 + Math.round(w / 20)); i++) {
    const x = (rnd() - 0.5) * w * 0.8, y = (rnd() - 0.5) * h * 0.8, a = rnd() * 3.14, L = Math.min(w, h) * (0.3 + rnd() * 0.4);
    M.seg([x - Math.cos(a) * L / 2, y - Math.sin(a) * L / 2, 0.4], [x + Math.cos(a) * L / 2, y + Math.sin(a) * L / 2, 0.4 + rnd() * H * 0.4], 0.35, 0.35, rnd() < 0.5 ? RUST : SOOT);
  }
}
export function buildComp(k, w, h, st, shelterLevel, side) {
  const M = new Model();
  if (st === 'destroyed' && k in RUIN_WALL) { ruins(M, w, h, k); return M; }
  switch (k) {
    case 'at': case 'gsu': transformer(M, w, h, st, true); if (shelterLevel && st !== 'destroyed') shelter(M, w, h, shelterLevel, true); break;
    case 'tr': transformer(M, w, h, st, false); if (shelterLevel && st !== 'destroyed') shelter(M, w, h, shelterLevel, false); break;
    case 'oru': switchyard(M, w, h, st, w > 100); break;
    case 'ctrl': building(M, w, h, 7, st); break;
    case 'unit': tppUnit(M, w, h, st); break;
    case 'chimney': chimney(M, st); break;
    case 'tower': coolingTower(M, st); break;
    case 'coal': coalYard(M, w, h, st); break;
    case 'tank': oilTank(M, w, st); break;
    case 'pump': building(M, w, h, 5, st, mat('#b3ada0')); break;
    case 'rack': M.box(-w / 2, w / 2, -h / 2, h / 2, 0, 0.2, CONC_DK); for (let i = 0; i < 6; i++) M.seg([-w / 2 + i * (w / 5), 0, 0], [-w / 2 + i * (w / 5), 0, 6], 0.4, 0.4, st === 'destroyed' ? SOOT : STEEL); if (st !== 'destroyed') M.box(-w / 2, w / 2, -1.2, 1.2, 6, 6.5, STEEL); break;
    case 'bunker': bunker(M, w, h, st); if (shelterLevel && st !== 'destroyed') M.box(-w / 2 - 1, w / 2 + 1, h / 2 + 0.2, h / 2 + 1.5, 0, 3, GABION); break;
    case 'store': hangar(M, w, h, st); break;
    case 'shop': workshop(M, w, h, st); break;
    case 'hall': warehouse(M, w, h, st); break;
    case 'silo': siloBlock(M, w, h, st); break;
    case 'house': building(M, w, h, h >= 15 ? 15 : 27, st, mat('#c9c4b8', { fn(o, x, y, z) { if (fr(z * 0.35) < 0.08) mix(o, [90, 88, 84], 0.25); } }), mat('#8d8b86')); break;
    case 'barn': barn(M, w, h, st); break;
    case 'bess': bessBlock(M, w, h, st); break;
    case 'pont': pontoon(M, w, h, st); break;
    case 'wtower': waterTower(M, w, st); break;
    case 'headframe': headframe(M, w, st); break;
    case 'dryer': dryerTower(M, w, st); break;
    case 'canopy': canopy(M, w, h, st); break;
    case 'fcanopy': fuelCanopy(M, w, h, st, side); break;
    case 'hgen': hydroUnit(M, w, h, st); break;
    case 'wt': windTurbine(M, st); break;
    case 'pv': pvField(M, w, h, st); break;
    case 'inv': inverter(M, w, h, st); break;
    case 'mall': mall(M, w, h, st); break;
    case 'kiosk': kiosk(M, w, h, st); break;
    case 'garage': garage(M, w, h, st); break;
    case 'launcher': launcherTruck(M, side, st); break;
    default: M.box(-w / 2, w / 2, -h / 2, h / 2, 0, 3, CONCRETE);
  }
  return M;
}

// ------------------------------------------------------------ ПВО
function pickup(M, side) {
  const cm = mat(side === 'blue' ? '#56603f' : '#5b6340', { fn(o, x, y, z) { mix(o, [90, 80, 60], Math.max(0, 0.8 - z) * 0.5); } });
  for (const x of [-1.6, 1.5]) for (const sg of [1, -1]) M.cylY(x, 0.4, 0.4, sg > 0 ? 0.65 : -0.95, sg > 0 ? 0.95 : -0.65, mat('#1b1b1a'), 10);
  M.box(-2.6, 2.6, -0.9, 0.9, 0.55, 1.05, cm);
  M.box(0.6, 2.6, -0.88, 0.88, 1.05, 1.3, cm); // капот
  M.loft([[1.05, rect(-0.6, 0.8, -0.85, 0.85)], [1.8, rect(-0.5, 0.45, -0.8, 0.8)]], cm);
  M.plate([[0.81, -0.75, 1.1], [0.81, 0.75, 1.1], [0.47, 0.72, 1.75], [0.47, -0.72, 1.75]], GLASS, [1, 0, 0.5]);
  M.box(-2.6, -0.65, -0.9, 0.9, 1.05, 1.25, mat('#3f4431')); // борта кузова
  M.box(-2.5, -0.75, -0.8, 0.8, 0.95, 1.0, mat('#2f3228'));
}
function mogTurret(M) {
  // Спаренный пулемёт на тумбе и прожектор
  M.cylZ(0, 0, 0.12, 0.1, 1.0, 1.7, mat('#2b2d27'), 8);
  M.seg([-0.4, 0.08, 1.8], [1.1, 0.08, 1.85], 0.07, 0.07, BLACK);
  M.seg([-0.4, -0.08, 1.8], [1.1, -0.08, 1.85], 0.07, 0.07, BLACK);
  M.box(-0.2, 0.2, -0.25, 0.25, 1.65, 1.95, mat('#3c4031'));
  M.cylX(0.35, 2.05, 0.18, 0.2, -0.1, 0.35, mat('#2a2c28'), 10, mat('#fff7d6', { ao: false, glow: 40 }));
}
function gepard(M) {
  const cm = mat('#4d5b3a', { fn(o, x, y, z) { const v = fbm(x * 0.5, y * 0.5, z * 0.5); if (v < 0.37) set(o, [95, 77, 54]); else if (v > 0.67) set(o, [39, 40, 31]); } });
  for (let i = 0; i < 7; i++) for (const sg of [1, -1]) M.cylY(-2.8 + i * 0.95, 0.4, 0.36, sg > 0 ? 1.15 : -1.65, sg > 0 ? 1.65 : -1.15, mat('#262522'), 10);
  for (const sg of [1, -1]) M.box(-3.4, 3.4, sg > 0 ? 1.15 : -1.65, sg > 0 ? 1.65 : -1.15, 0.75, 0.85, mat('#2a2a25'));
  M.loft([[0.4, rect(-3.5, 3.1, -1.15, 1.15)], [1.0, rect(-3.6, 3.6, -1.6, 1.6)], [1.45, rect(-3.6, 2.4, -1.6, 1.6)]], cm);
}
function gepardTurret(M) {
  const cm = mat('#56633f');
  M.box(-1.6, 1.2, -1.2, 1.2, 1.45, 2.6, cm);
  for (const sg of [1, -1]) { M.box(-0.6, 0.8, sg * 1.2 - 0.25, sg * 1.2 + 0.25, 1.9, 2.4, cm); M.cylX(sg * 1.2, 2.15, 0.07, 0.06, 0.8, 4.2, mat('#2c2e27'), 8); }
  M.box(0.8, 1.6, -0.5, 0.5, 2.3, 3.0, cm); // РЛС сопровождения
  M.cylX(0, 2.65, 0.45, 0.45, 1.6, 1.65, mat('#3a3f33'), 12);
  M.seg([-1.3, 0, 2.6], [-1.3, 0, 3.3], 0.2, 0.2, mat('#2e3129'));
  M.box(-1.5, -1.1, -1.1, 1.1, 3.3, 3.9, mat('#454c3a')); // антенна обзорной РЛС
}
function pantsirHull(M) {
  const cm = mat('#56603c');
  for (const x of [-3.2, -1.8, 1.6, 3.0]) for (const sg of [1, -1]) M.cylY(x, 0.6, 0.6, sg > 0 ? 0.9 : -1.35, sg > 0 ? 1.35 : -0.9, mat('#1c1c1a'), 12);
  M.box(-4.6, 2.2, -1.25, 1.25, 1.0, 1.5, cm);
  M.box(2.2, 4.6, -1.25, 1.25, 1.0, 3.0, cm);
  M.plate([[4.61, -1.0, 2.0], [4.61, 1.0, 2.0], [4.61, 1.0, 2.8], [4.61, -1.0, 2.8]], GLASS, [1, 0, 0]);
}
function pantsirTurret(M) {
  const cm = mat('#5f6843');
  M.box(-1.4, 1.4, -1.0, 1.0, 1.5, 2.9, cm);
  for (const sg of [1, -1]) {
    M.box(-1.0, 1.6, sg * 1.35 - 0.35, sg * 1.35 + 0.35, 2.0, 2.7, cm); // пакет ракет
    M.cylX(sg * 1.2, 2.45, 0.05, 0.05, 1.2, 3.2, mat('#2c2e27'), 6);
    M.cylX(sg * 1.5, 2.45, 0.05, 0.05, 1.2, 3.2, mat('#2c2e27'), 6);
  }
  M.box(-1.2, -0.4, -0.9, 0.9, 2.9, 3.9, mat('#3d4433')); // РЛС обнаружения
  M.cylX(0, 2.3, 0.5, 0.5, 1.4, 1.5, mat('#3a3f33'), 12);
}
function ewTruck(M, side) {
  pickupBig(M, side);
  M.seg([-2, 0, 2.5], [-2, 0, 9], 0.25, 0.25, mat('#8c8f8a'));
  for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2; M.box(-2 + Math.cos(a) * 0.4 - 0.1, -2 + Math.cos(a) * 0.4 + 0.1, Math.sin(a) * 0.4 - 0.5, Math.sin(a) * 0.4 + 0.5, 7.5, 9.2, mat('#d9d6cc')); }
  for (let i = 0; i < 6; i++) M.seg([-3.5 + i * 0.5, 1.1, 2.6], [-3.5 + i * 0.5, 1.1, 4.2], 0.05, 0.05, BLACK);
}
function pickupBig(M, side) {
  const cm = mat(side === 'blue' ? '#56603f' : '#5b6340');
  for (const x of [-2.8, -1.6, 2.2]) for (const sg of [1, -1]) M.cylY(x, 0.55, 0.55, sg > 0 ? 0.8 : -1.2, sg > 0 ? 1.2 : -0.8, mat('#1c1c1a'), 12);
  M.box(-4, 1.4, -1.2, 1.2, 1.0, 2.6, cm);
  M.box(1.4, 3.6, -1.2, 1.2, 1.0, 2.8, cm);
  M.plate([[3.61, -1.0, 1.9], [3.61, 1.0, 1.9], [3.61, 1.0, 2.6], [3.61, -1.0, 2.6]], GLASS, [1, 0, 0]);
}
function radarTurret(M) {
  // Вращающаяся антенна: решётка на мачте
  M.seg([0, 0, 2.6], [0, 0, 5], 0.35, 0.35, mat('#6f736b'));
  M.box(-0.3, 0.3, -2.6, 2.6, 4.6, 7.2, mat('#5c6356', { fn(o, x, y, z) { if (fr((y + 3) * 3) < 0.15 || (fr(z * 3)) < 0.15) mix(o, [25, 28, 24], 0.45); } }));
}
function acousticPost(M) {
  M.seg([0, 0, 0], [0, 0, 6], 0.12, 0.12, mat('#8a8d88'));
  for (const a of [0, 2.1, 4.2]) M.seg([0, 0, 0], [Math.cos(a) * 1.4, Math.sin(a) * 1.4, 0], 0.06, 0.06, mat('#6a6d68'));
  M.cylZ(0, 0, 0.25, 0.1, 6, 6.6, mat('#d4d0c4'), 8);
  M.plate([[-0.6, 0.4, 3.6], [0.6, 0.4, 3.6], [0.6, 0.9, 4.4], [-0.6, 0.9, 4.4]], mat('#1d2a44', { spec: 0.6 }), [0, -0.7, 0.7]);
  M.box(-0.3, 0.3, -0.3, 0.3, 1.2, 1.8, mat('#5b604c'));
}
function icptTeam(M, side) {
  pickup(M, side);
  // Стартовая рама с перехватчиками в кузове
  for (let i = 0; i < 4; i++) M.box(-2.4 + i * 0.45, -2.1 + i * 0.45, -0.6, 0.6, 1.3, 1.45, mat('#2e3129'));
  for (let i = 0; i < 3; i++) { const Dm = new Model(); droneInterceptor(Dm, side); Model.transform(Dm, -2.2 + i * 0.5, 0, 1.2, Math.PI / 2); M.merge(Dm); }
}
export function buildAD(type, side, part) {
  const M = new Model();
  if (part === 'turret') {
    if (type === 'mog') mogTurret(M);
    else if (type === 'spaag') (side === 'blue' ? gepardTurret : pantsirTurret)(M);
    else if (type === 'radar') radarTurret(M);
    return M;
  }
  if (type === 'mog') pickup(M, side);
  else if (type === 'spaag') (side === 'blue' ? gepard : pantsirHull)(M);
  else if (type === 'ew') ewTruck(M, side);
  else if (type === 'ewd') ewDome(M);
  else if (type === 'radar') pickupBig(M, side);
  else if (type === 'acoustic') acousticPost(M);
  else if (type === 'icpt') icptTeam(M, side);
  return M;
}
void hex;
