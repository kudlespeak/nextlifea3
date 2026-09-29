// 3D-бойцы: низкополигональные модели со снаряжением (каска, бронежилет с подсумками, рюкзак,
// оружие по специальности), позы и кадры шага. Рендер — тем же растеризатором, 16 ракурсов.

import { Model, mat, hex, fbm, vnoise, mix } from './mesh3d.js';

const U = {
  blue: { uni: '#6f7552', uni2: '#8a7d5a', uni3: '#4b5236', vest: '#5a5e40', helm: '#5f6748', mark: '#3f7fe0' },
  red: { uni: '#5f6a44', uni2: '#454d33', uni3: '#7c7858', vest: '#4d5236', helm: '#525b3b', mark: '#d8433a' },
};
const SKIN = mat('#b3876a', { ao: false });
const BOOT = mat('#231f1a');
const GUN = mat('#1d1e1b', { spec: 0.2 });
const set = (o, c) => { o[0] = c[0]; o[1] = c[1]; o[2] = c[2]; };

function uniform(side) {
  const P = U[side];
  const c2 = hex(P.uni2), c3 = hex(P.uni3);
  return mat(P.uni, {
    fn(o, x, y, z) {
      const v = fbm(x * 4.5 + 3, y * 4.5, z * 4.5);
      if (v < 0.36) set(o, c2); else if (v > 0.68) set(o, c3);
      if (z < 0.3) mix(o, [120, 104, 78], 0.3);
    },
  });
}
const vestMat = (side) => mat(U[side].vest, { fn(o, x, y, z) { if (((z * 14) % 1) < 0.18) mix(o, [0, 0, 0], 0.25); } });
const markMat = (side) => mat(U[side].mark, { ao: false });
function helmetMat(side) {
  const P = U[side];
  return mat(P.helm, {
    fn(o, x, y, z, n) {
      mix(o, [40, 40, 30], vnoise(x * 20, y * 20, z * 20) * 0.35); // чехол
      if (n[2] > 0.8 && Math.abs(y) < 0.035) set(o, hex(P.mark)); // полоса скотча на макушке
    },
  });
}

// Оружие: длина и толщина по специальности
function weapon(M, kind, p0, dir, side) {
  const L = { rifle: 0.82, mg: 1.05, sniper: 1.18, medic: 0.75, eng: 0.75 }[kind] || 0.82;
  const p1 = [p0[0] + dir[0] * L, p0[1] + dir[1] * L, p0[2] + dir[2] * L];
  M.seg(p0, p1, kind === 'mg' ? 0.075 : 0.055, kind === 'mg' ? 0.09 : 0.07, GUN);
  const at = (t) => [p0[0] + dir[0] * L * t, p0[1] + dir[1] * L * t, p0[2] + dir[2] * L * t];
  if (kind === 'sniper') M.seg(at(0.35), at(0.6), 0.06, 0.06, mat('#141518'));
  else { const m = at(0.42); M.seg(m, [m[0], m[1], m[2] - 0.14], 0.04, 0.05, GUN); } // магазин
  if (kind === 'mg') { const b = at(0.4); M.box(b[0] - 0.07, b[0] + 0.07, b[1] - 0.11, b[1] - 0.03, b[2] - 0.12, b[2], mat('#34372b')); }
  void side;
}
// Трубы на плече: РПГ / ПТУР
function tube(M, kind, sh, side) {
  const r = kind === 'atgm' ? 0.075 : 0.055;
  M.cylX(sh[1], sh[2], r, r, sh[0] - 0.45, sh[0] + 0.55, mat(kind === 'atgm' ? '#4f5838' : '#3f4533'), 8);
  if (kind === 'gl') M.cylX(sh[1], sh[2], 0.02, 0.085, sh[0] + 0.55, sh[0] + 0.75, mat('#4f5c3a'), 8);
  void side;
}

// Конечность из двух сегментов (бедро+голень, плечо+предплечье)
function limb(M, a, b, c, w, m) { M.seg(a, b, w, w, m); M.seg(b, c, w * 0.9, w * 0.9, m); }

export function buildSoldier(side, kind, pose, frame, frames = 8) {
  const M = new Model();
  const uni = uniform(side), vest = vestMat(side), helm = helmetMat(side), mark = markMat(side);
  const ph = (Math.max(0, frame - 1) / frames) * Math.PI * 2; // 0 — стоит, 1..frames — шаг
  if (pose === 'prone' || pose === 'dead') {
    const dead = pose === 'dead';
    const k = dead || !frame ? 0 : Math.sin(ph) * 0.1;
    const z0 = 0.13;
    // Корпус вдоль x, ноги назад, голова вперёд
    M.box(-0.35, 0.15, -0.19, 0.19, 0.05, 0.27, uni);
    M.box(-0.3, 0.12, -0.21, 0.21, 0.08, 0.29, vest);
    if (!dead) M.box(-0.36, -0.02, -0.16, 0.16, 0.26, 0.42, mat(U[side].vest)); // рюкзак сверху
    for (const sg of [1, -1]) {
      const sway = sg * k;
      limb(M, [-0.35, sg * 0.1, z0], [-0.75 + sway, sg * (0.16 + (dead ? 0.1 : 0)), 0.1], [-1.15 + sway, sg * (0.2 + (dead ? 0.15 : 0)), 0.08], 0.13, uni);
      M.box(-1.27 + sway, -1.13 + sway, sg * (0.2 + (dead ? 0.15 : 0)) - 0.05, sg * (0.2 + (dead ? 0.15 : 0)) + 0.05, 0.02, 0.16, BOOT);
    }
    M.dome(0.28, 0, 0.12, 0.11, 0.1, 0.11, SKIN, 3, 10, true);
    M.dome(0.27, 0, 0.17, 0.15, 0.14, 0.1, helm, 3, 12);
    if (dead) {
      for (const sg of [1, -1]) limb(M, [0.05, sg * 0.2, 0.2], [0.1, sg * 0.45, 0.1], [0.25, sg * 0.65, 0.08], 0.09, uni);
      M.seg([0.3, 0.55, 0.06], [0.9, 0.9, 0.06], 0.055, 0.06, GUN);
      return M;
    }
    // Руки к оружию, оружие вперёд
    limb(M, [0.08, 0.2, 0.22], [0.25, 0.25, 0.12], [0.42, 0.09, 0.16], 0.09, uni);
    limb(M, [0.08, -0.2, 0.22], [0.3, -0.18, 0.12], [0.62, -0.02, 0.16], 0.09, uni);
    if (kind === 'gl' || kind === 'atgm') tube(M, kind, [0.2, 0.18, 0.22], side);
    else weapon(M, kind, [0.18, 0.06, 0.18], [1, 0, 0], side);
    return M;
  }
  const crouch = pose === 'crouch';
  const cover = pose === 'cover';
  // Высота таза, наклон корпуса вперёд
  const hip = crouch ? 0.62 : 0.93;
  const bob = cover || crouch ? 0 : Math.abs(Math.sin(ph)) * 0.025;
  const lean = crouch ? 0.14 : 0.04;
  const zc = cover ? -0.55 : 0; // «в укрытии» — ниже пояса не видно (в окопе/за подоконником)
  const H = (z) => z + zc + bob;
  // Ноги
  if (!cover) {
    for (const sg of [1, -1]) {
      const p = ph + (sg > 0 ? 0 : Math.PI);
      const moving = frame > 0;
      const fx = crouch ? (sg > 0 ? 0.28 : -0.2) : moving ? Math.sin(p) * 0.3 : sg * 0.03;
      const lift = !crouch && moving ? Math.max(0, Math.cos(p)) * 0.1 : 0;
      const hipP = [0, sg * 0.1, H(hip)];
      const foot = [fx, sg * 0.13, 0.08 + lift];
      const knee = crouch ? [fx + 0.22, sg * 0.14, 0.45] : [(fx) * 0.5 + 0.06 + lift * 0.6, sg * 0.12, H(hip) * 0.5 + 0.04 + lift * 0.5];
      limb(M, hipP, knee, foot, 0.14, uni);
      M.box(foot[0] - 0.08, foot[0] + 0.16, foot[1] - 0.055, foot[1] + 0.055, foot[2] - 0.08, foot[2] + 0.05, BOOT);
    }
  }
  // Корпус: таз, торс, бронежилет, подсумки, рюкзак
  const t0 = H(hip - 0.05), t1 = H(hip + 0.52);
  const tx = lean;
  M.box(-0.12, 0.1, -0.19, 0.19, H(hip - 0.1), H(hip + 0.08), uni);
  M.loft([[t0, [[0.1, -0.2], [0.1, 0.2], [-0.12, 0.2], [-0.12, -0.2]]], [t1, [[0.1 + tx, -0.23], [0.1 + tx, 0.23], [-0.12 + tx, 0.23], [-0.12 + tx, -0.23]]]], uni);
  M.loft([[t0 + 0.08, [[0.14, -0.21], [0.14, 0.21], [-0.15, 0.21], [-0.15, -0.21]]], [t1 - 0.04, [[0.14 + tx, -0.22], [0.14 + tx, 0.22], [-0.15 + tx, 0.22], [-0.15 + tx, -0.22]]]], vest);
  for (const dy of [-0.12, 0, 0.12]) M.box(0.14 + tx * 0.4, 0.21 + tx * 0.4, dy - 0.05, dy + 0.05, t0 + 0.12, t0 + 0.28, vest);
  if (kind === 'medic') {
    M.box(-0.38 + tx, -0.14 + tx, -0.17, 0.17, t0 + 0.08, t1 - 0.02, mat('#e6e3d8', { fn(o, x, y, z) { if (Math.abs(y) < 0.04 && z > t0 + 0.15 && z < t1 - 0.1 || Math.abs(z - (t0 + t1) / 2 + 0.01) < 0.04 && Math.abs(y) < 0.11) set(o, [196, 38, 34]); } }));
  } else if (kind !== 'atgm') {
    M.box(-0.37 + tx, -0.14 + tx, -0.16, 0.16, t0 + 0.1, t1 - 0.03, mat(U[side].vest));
    if (kind === 'eng') M.seg([-0.4 + tx, 0.1, t0], [-0.4 + tx, 0.12, t1 + 0.15], 0.05, 0.03, mat('#6b5a3c'));
  }
  // Голова и каска
  const hz = t1 + 0.1;
  M.dome(0.02 + tx, 0, hz, 0.1, 0.095, 0.11, SKIN, 3, 10, true);
  M.dome(0.0 + tx, 0, hz + 0.03, 0.145, 0.135, 0.13, helm, 3, 12);
  // Плечи, руки и оружие
  const shR = [0.0 + tx, 0.23, t1 - 0.05], shL = [0.0 + tx, -0.23, t1 - 0.05];
  M.seg([shR[0], 0.23, shR[2] - 0.05], [shR[0], 0.23, shR[2] - 0.12], 0.1, 0.1, mark); // нарукавная повязка
  M.seg([shL[0], -0.23, shL[2] - 0.05], [shL[0], -0.23, shL[2] - 0.12], 0.1, 0.1, mark);
  if (kind === 'gl' || kind === 'atgm') {
    const sh = [tx + 0.05, 0.2, t1 + 0.02];
    limb(M, shR, [tx + 0.05, 0.3, t1 - 0.2], [tx + 0.1, 0.2, t1 - 0.02], 0.09, uni);
    limb(M, shL, [tx + 0.2, -0.15, t1 - 0.25], [tx + 0.35, 0.12, t1 - 0.02], 0.09, uni);
    tube(M, kind, sh, side);
  } else {
    const gz = t1 - 0.12;
    limb(M, shR, [tx - 0.02, 0.3, t1 - 0.3], [tx + 0.12, 0.1, gz - 0.02], 0.09, uni);
    limb(M, shL, [tx + 0.18, -0.2, t1 - 0.28], [tx + 0.42, 0.0, gz], 0.09, uni);
    M.box(tx + 0.09, tx + 0.15, 0.07, 0.13, gz - 0.06, gz, SKIN);
    M.box(tx + 0.39, tx + 0.45, -0.03, 0.03, gz - 0.04, gz + 0.02, SKIN);
    weapon(M, kind, [tx - 0.08, 0.1, gz + 0.04], [0.99, -0.1, -0.02], side);
  }
  return M;
}

export const SOLDIER_ANGLES = 16;
