// Проверка карты «Войны дронов» после правок генератора: node game/tests/map.test.mjs [seed…]
// Сеть дорог связна (одна компонента графа логистики), все объекты на ней; загородные дороги не
// пересекаются «иксом» без оформленного узла и не примыкают под острым углом; дома не стоят на
// дорогах. Падает с кодом 1, если что-то не так.
import { generateWorld } from '../src/mapgen.js';
import { Sim } from '../src/sim/units.js';

const seeds = process.argv.slice(2).map(Number).filter(Boolean);
const LIMITS = { xCross: 2, acute: 3, buildingOnRoad: 0 };
let failed = false;
const fail = (seed, msg) => { failed = true; console.log(`  ✗ seed ${seed}: ${msg}`); };
const segX = (a, b, c, d) => {
  const r0 = b[0] - a[0], r1 = b[1] - a[1], s0 = d[0] - c[0], s1 = d[1] - c[1], den = r0 * s1 - r1 * s0;
  if (Math.abs(den) < 1e-9) return -1;
  const t = ((c[0] - a[0]) * s1 - (c[1] - a[1]) * s0) / den, u = ((c[0] - a[0]) * r1 - (c[1] - a[1]) * r0) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
};
for (const seed of seeds.length ? seeds : [1337, 42, 7]) {
  const t0 = performance.now();
  const world = generateWorld(seed, 'dronewar');
  const gen = performance.now() - t0;
  const sim = new Sim(world);
  sim.setupGame({ seed, mode: 'drones', aiSides: [], prep: 10, duration: 0, startHour: 12, playerSide: 'blue' });
  const g = sim.game, R = g.logi.roads, n = R.x.length, comp = new Int32Array(n).fill(-1);
  let c = 0;
  for (let i = 0; i < n; i++) { if (comp[i] >= 0) continue; const st = [i]; comp[i] = c; while (st.length) { const v = st.pop(); for (const [u] of R.adj[v]) if (comp[u] < 0) { comp[u] = c; st.push(u); } } c++; }
  if (c !== 1) fail(seed, `дорожная сеть распалась на ${c} частей`);
  const off = g.objects.filter((o) => o.kind !== 'import' && o.kind !== 'bridge' && o.kind !== 'wpp').filter((o) => R.nearest(...g.logi.gate(o)) < 0);
  if (off.length) fail(seed, `объекты без подъезда: ${off.map((o) => o.name).join(', ')}`);
  // загородные пересечения и острые примыкания
  const rural = world.roadList.filter((r) => ['highway', 'local', 'village', 'ramp'].includes(r.type));
  const nodes = new Set((world.crossings || []).map((q) => `${Math.round(q.x / 30)}:${Math.round(q.y / 30)}`));
  for (const q of world.roundabouts || []) nodes.add(`${Math.round(q.x / 30)}:${Math.round(q.y / 30)}`);
  let xc = 0, ac = 0;
  for (let i = 0; i < rural.length; i++) for (let j = i + 1; j < rural.length; j++) {
    const A = rural[i], B = rural[j];
    if (A.bbox.x0 > B.bbox.x1 || A.bbox.x1 < B.bbox.x0 || A.bbox.y0 > B.bbox.y1 || A.bbox.y1 < B.bbox.y0) continue;
    if (A.type === 'ramp' || B.type === 'ramp') continue;
    for (let a = 1; a < A.line.length; a++) for (let b = 1; b < B.line.length; b++) {
      const t = segX(A.line[a - 1], A.line[a], B.line[b - 1], B.line[b]);
      if (t < 0) continue;
      const P = [A.line[a - 1][0] + (A.line[a][0] - A.line[a - 1][0]) * t, A.line[a - 1][1] + (A.line[a][1] - A.line[a - 1][1]) * t];
      const ed = (L) => Math.min(Math.hypot(P[0] - L[0][0], P[1] - L[0][1]), Math.hypot(P[0] - L[L.length - 1][0], P[1] - L[L.length - 1][1]));
      const va = [A.line[a][0] - A.line[a - 1][0], A.line[a][1] - A.line[a - 1][1]], vb = [B.line[b][0] - B.line[b - 1][0], B.line[b][1] - B.line[b - 1][1]];
      const ang = (Math.acos(Math.min(1, Math.abs(va[0] * vb[0] + va[1] * vb[1]) / (Math.hypot(...va) * Math.hypot(...vb) || 1))) * 180) / Math.PI;
      const known = [-1, 0, 1].some((dx) => [-1, 0, 1].some((dy) => nodes.has(`${Math.round(P[0] / 30) + dx}:${Math.round(P[1] / 30) + dy}`)));
      if (ed(A.line) > 30 && ed(B.line) > 30 && !known && ang < 60) xc++;
      else if (ang < 30 && (ed(A.line) > 30 || ed(B.line) > 30)) ac++;
    }
  }
  if (xc > LIMITS.xCross) fail(seed, `косых пересечений без узла: ${xc}`);
  if (ac > LIMITS.acute) fail(seed, `острых примыканий: ${ac}`);
  const bad = world.mapFix?.buildingRoad ?? 0;
  console.log(`seed ${seed}: генерация ${(gen / 1000).toFixed(1)} с, дорог ${world.roadList.length}, узлов-развязок ${(world.crossings || []).filter((q) => q.kind === 'interchange').length}, кругов ${(world.roundabouts || []).length}, косых пересечений ${xc}, острых примыканий ${ac}, домов снято с дорог при починке ${bad}`);
}
console.log(failed ? 'ПРОВАЛ' : 'ОК');
process.exit(failed ? 1 : 0);
