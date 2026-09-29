// Следы боёв: сгоревшие посадки, накатанные гусеницами колеи, поля воронок,
// подбитая техника. Сосредоточены в серой зоне и у опорных пунктов.

import { bboxOf, catmullRom, resample, blob } from './geom.js';
import { addCraterCluster, addBurn } from './mapgen.js';
import { M } from './spatial.js';

function addScar(world, item, pad) {
  item.bbox = bboxOf(item.poly || item.line || [[item.x, item.y]], pad);
  world.scars.insert(item);
  return item;
}

export function seedBattleDamage(world, rng, frontX) {
  const inZone = (x, w = 750) => Math.abs(x - frontX) < w;

  // ---------- Сгоревшие участки посадок ----------
  for (const belt of world.belts.items) {
    const near = inZone(belt.mid[0], 800);
    const hasFort = world.forts.query({ x0: belt.mid[0] - 30, y0: belt.mid[1] - 30, x1: belt.mid[0] + 30, y1: belt.mid[1] + 30 }).length > 0;
    if (!(near && rng.chance(hasFort ? 0.75 : 0.45))) continue;
    const t0 = belt.len * rng.float(0, 0.6);
    const t1 = Math.min(belt.len, t0 + belt.len * rng.float(0.25, 0.7));
    burnBeltSection(world, rng, belt, t0, t1);
  }

  // ---------- Поля воронок ----------
  for (let k = 0; k < 45; k++) {
    const x = frontX + rng.gauss(0, 380);
    const y = rng.float(150, world.H - 150);
    const heavy = rng.chance(0.3);
    addCraterCluster(world, rng, x, y, heavy ? rng.int(25, 60) : rng.int(5, 18), heavy ? rng.float(40, 90) : rng.float(15, 45), rng.float(0, 1));
  }
  // Старые, заросшие воронки по всей прифронтовой полосе
  for (let k = 0; k < 40; k++) {
    const x = frontX + rng.gauss(0, 900);
    addCraterCluster(world, rng, x, rng.float(100, world.H - 100), rng.int(2, 8), rng.float(10, 40), 1);
  }

  // ---------- Колеи от гусениц ----------
  const trackFrom = [];
  for (const f of world.forts.items) if (f.kind === 'capon' || f.kind === 'dugout') trackFrom.push([f.x, f.y]);
  for (let k = 0; k < 70; k++) {
    let start;
    if (trackFrom.length && rng.chance(0.4)) {
      const p = rng.pick(trackFrom);
      start = [p[0] + rng.float(-40, 40), p[1] + rng.float(-40, 40)];
    } else start = [frontX + rng.gauss(0, 650), rng.float(100, world.H - 100)];
    addTracks(world, rng, start, rng.float(150, 800));
  }

  // ---------- Подбитая техника ----------
  for (let k = 0; k < 14; k++) {
    const x = frontX + rng.gauss(0, 420), y = rng.float(200, world.H - 200);
    if (world.mask.has(x, y, M.WATER | M.BUILD)) continue;
    const type = rng.weighted([['tank', 3], ['ifv', 4], ['truck', 2], ['apc', 2]]);
    addScar(world, { kind: 'wreck', x, y, angle: rng.float(0, 6.28), type, seed: rng.int(0, 1e9) }, 10);
    addBurn(world, rng, x, y, rng.float(6, 14));
    addTracks(world, rng, [x, y], rng.float(80, 300), true);
  }
}

// Сгоревший участок посадки: чёрные и сухие стволы, часть деревьев уничтожена, выжженная земля
export function burnBeltSection(world, rng, belt, t0, t1) {
  const [ax, ay] = belt.line[0];
  const { dir, normal: n } = belt;
  const half = belt.width / 2 + 3;
  const pts = [];
  for (let t = t0; t <= t1; t += 12) {
    const w = half * rng.float(0.8, 1.3);
    pts.push([ax + dir[0] * t + n[0] * w, ay + dir[1] * t + n[1] * w]);
  }
  for (let t = t1; t >= t0; t -= 12) {
    const w = half * rng.float(0.8, 1.3);
    pts.push([ax + dir[0] * t - n[0] * w, ay + dir[1] * t - n[1] * w]);
  }
  if (pts.length < 4) return;
  addScar(world, { kind: 'burn', poly: pts, x: ax + dir[0] * (t0 + t1) / 2, y: ay + dir[1] * (t0 + t1) / 2, belt: true }, 4);
  const bb = bboxOf(pts, 2);
  world.trees.forEach(bb, (arr, i) => {
    const dx = arr[i] - ax, dy = arr[i + 1] - ay;
    const t = dx * dir[0] + dy * dir[1];
    const o = dx * n[0] + dy * n[1];
    if (t < t0 || t > t1 || Math.abs(o) > half) return;
    const r = rng.next();
    if (r < 0.2) arr[i + 2] = 0; // уничтожено
    else if (r < 0.62) { arr[i + 3] = 4; arr[i + 2] *= 0.55; } // обугленный ствол
    else if (r < 0.9) { arr[i + 3] = 5; arr[i + 2] *= 0.75; } // сухое, без листвы
    else arr[i + 2] *= 0.8;
  });
  world.burnedBelts = (world.burnedBelts || 0) + 1;
}

// Колея: плавная кривая с разворотами, огибает воду и здания
export function addTracks(world, rng, start, length, fresh = false) {
  let [x, y] = start;
  let a = rng.float(0, Math.PI * 2);
  const pts = [[x, y]];
  const step = 12;
  for (let s = 0; s < length; s += step) {
    a += rng.gauss(0, 0.18);
    if (rng.chance(0.015)) a += Math.PI * rng.float(0.6, 1); // разворот
    const nx = x + Math.cos(a) * step, ny = y + Math.sin(a) * step;
    if (world.mask.has(nx, ny, M.WATER | M.BUILD | M.CITY) || nx < 0 || ny < 0 || nx > world.W || ny > world.H) {
      a += Math.PI * 0.6;
      continue;
    }
    x = nx; y = ny;
    pts.push([x, y]);
  }
  if (pts.length < 4) return null;
  const line = resample(catmullRom(pts, 4), 3);
  return addScar(world, { kind: 'tracks', line, gauge: rng.float(2.5, 2.9), age: fresh ? 0 : rng.float(0, 1) }, 4);
}
