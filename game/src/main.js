import { generateWorld, addCraterCluster, addBurn } from './mapgen.js';
import { ChunkCache, LEVELS, CHUNK_PX } from './render/chunks.js';
import { Rng } from './rng.js';
import { Sim, UNIT_TYPES, SIDES } from './sim/units.js';
import { T_NAMES } from './sim/nav.js';
import { drawUnits, drawSymbol, emitDust, pickUnit, pickSoldier } from './render/units.js';
import { drawFortOverlay, FORT_VIEWS, FORT_VIEW_NAMES } from './render/forts.js';
import { digTrench } from './forts.js';
import { drawInteriors, buildingAtScreen } from './render/interiors.js';
import { POSES } from './sim/units.js';

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed')) || 1337;

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const mini = document.getElementById('minimap');
const mctx = mini.getContext('2d');
const hud = {
  coords: document.getElementById('coords'),
  scale: document.getElementById('scale-bar'),
  scaleLabel: document.getElementById('scale-label'),
  info: document.getElementById('info'),
  strike: document.getElementById('btn-strike'),
  labels: document.getElementById('btn-labels'),
  newMap: document.getElementById('btn-new'),
  loading: document.getElementById('loading'),
  clock: document.getElementById('clock'),
  speeds: document.querySelectorAll('#timebar [data-speed]'),
  sel: document.getElementById('selpanel'),
  selList: document.getElementById('sel-list'),
  selTitle: document.getElementById('sel-title'),
  stealth: document.getElementById('btn-stealth'),
  stop: document.getElementById('btn-stop'),
  side: document.getElementById('btn-side'),
  forts: document.getElementById('btn-forts'),
  dig: document.getElementById('btn-dig'),
  clear: document.getElementById('btn-clear'),
  toast: document.getElementById('toast'),
  task: document.getElementById('sel-task'),
  basement: document.getElementById('btn-basement'),
  interior: document.getElementById('btn-interior'),
  stances: document.querySelectorAll('#stances [data-stance]'),
};
let interiorsForce = false;

const world = generateWorld(seed);
const chunks = new ChunkCache(world);
const strikeRng = new Rng(seed ^ 0x5eed);
const sim = new Sim(world);
sim.deployDefault(new Rng(seed ^ 0xa11));

// Состояние интерфейса управления
const ui = { selected: new Set(), box: null, marks: [], soldier: null, underground: false };
let orderMode = null; // 'clear' — следующий приказ = зачистка траншеи
let controlSide = 'blue';
let stealthOrders = false;
let timeScale = 5;
let paused = false;
let fortView = 'off';
let dig = null; // { points: [], cursor } — режим рытья траншеи
const digRng = new Rng(seed ^ 0xd16);

let dpr = window.devicePixelRatio || 1;
const cam = { x: world.W / 2, y: world.H / 2, zoom: 0.3 }; // zoom — device px на метр
let showLabels = true;
let strikeMode = false;
let dirty = true;
let mouse = null;

hud.info.textContent = `seed ${seed} · карта ${world.genTime.toFixed(0)} мс · навигация ${sim.navTime.toFixed(0)} мс · деревьев ${world.trees.count.toLocaleString('ru')} · зданий ${world.buildings.items.length.toLocaleString('ru')}`;

// ---------- Размеры и камера ----------
function resize() {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  minZoom = Math.min(canvas.width / world.W, canvas.height / world.H) * 0.9;
  cam.zoom = Math.max(cam.zoom, minZoom);
  dirty = true;
}
let minZoom = 0.1;
const MAX_ZOOM = 16;
addEventListener('resize', resize);
resize();
cam.zoom = minZoom * 1.1;

function clampCam() {
  cam.zoom = Math.min(MAX_ZOOM, Math.max(minZoom, cam.zoom));
  cam.x = Math.min(world.W, Math.max(0, cam.x));
  cam.y = Math.min(world.H, Math.max(0, cam.y));
}

const screenToWorld = (sx, sy) => [cam.x + (sx * dpr - canvas.width / 2) / cam.zoom, cam.y + (sy * dpr - canvas.height / 2) / cam.zoom];

function zoomAt(sx, sy, factor) {
  const [wx, wy] = screenToWorld(sx, sy);
  cam.zoom *= factor;
  clampCam();
  const [nx, ny] = screenToWorld(sx, sy);
  cam.x += wx - nx;
  cam.y += wy - ny;
  clampCam();
  dirty = true;
}

// ---------- Ввод: мышь, колесо, тач ----------
// ЛКМ — выбрать отряд / тянуть карту; Shift+ЛКМ — рамка; ПКМ — приказ.
// На сенсорном экране: тап по отряду — выбор, тап по земле — приказ выбранным.
const view = { cam, canvas, get dpr() { return dpr; } };
const selectedUnits = () => sim.units.filter((u) => ui.selected.has(u.id));
let drag = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  if (e.button === 2) {
    if (dig) finishDig();
    else orderAt(e.clientX, e.clientY);
    return;
  }
  const box = e.shiftKey && !strikeMode;
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: 0, box, touch: e.pointerType === 'touch' };
  if (box) ui.box = { x0: e.clientX * dpr, y0: e.clientY * dpr, x1: e.clientX * dpr, y1: e.clientY * dpr };
});
canvas.addEventListener('pointermove', (e) => {
  mouse = [e.clientX, e.clientY];
  if (dig) dig.cursor = screenToWorld(e.clientX, e.clientY);
  if (pinch) return;
  if (drag && drag.id === e.pointerId) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.box) {
      ui.box.x1 = e.clientX * dpr;
      ui.box.y1 = e.clientY * dpr;
    } else {
      cam.x -= (dx * dpr) / cam.zoom;
      cam.y -= (dy * dpr) / cam.zoom;
      clampCam();
    }
  }
  dirty = true;
});
canvas.addEventListener('pointerup', (e) => {
  if (!drag || drag.id !== e.pointerId) return;
  if (drag.box) {
    boxSelect(ui.box, e.ctrlKey || e.metaKey);
    ui.box = null;
  } else if (drag.moved < 6) {
    if (strikeMode) strike(...screenToWorld(e.clientX, e.clientY));
    else if (dig) dig.points.push(screenToWorld(e.clientX, e.clientY));
    else clickAt(e.clientX, e.clientY, e.ctrlKey || e.metaKey, drag.touch);
  }
  drag = null;
});
canvas.addEventListener('pointerleave', () => { mouse = null; dirty = true; });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, Math.pow(1.0015, -e.deltaY));
}, { passive: false });

function clickAt(cx, cy, additive, touch) {
  // Вблизи можно выбрать отдельного бойца выделенного отделения
  const sol = pickSoldier(sim, view, cx * dpr, cy * dpr, ui);
  if (sol) {
    ui.soldier = sol;
    refreshPanel();
    return;
  }
  if (orderMode && ui.selected.size) { orderAt(cx, cy); return; }
  ui.soldier = null;
  const u = pickUnit(sim, view, cx * dpr, cy * dpr, controlSide);
  if (u) {
    if (additive) ui.selected.has(u.id) ? ui.selected.delete(u.id) : ui.selected.add(u.id);
    else { ui.selected.clear(); ui.selected.add(u.id); }
  } else if (touch && ui.selected.size) orderAt(cx, cy);
  else if (!additive) ui.selected.clear();
  refreshPanel();
}

function boxSelect(b, additive) {
  if (!additive) ui.selected.clear();
  const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
  for (const u of sim.units) {
    if (u.side !== controlSide) continue;
    const sx = (u.x - cam.x) * cam.zoom + canvas.width / 2, sy = (u.y - cam.y) * cam.zoom + canvas.height / 2;
    if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) ui.selected.add(u.id);
  }
  refreshPanel();
}

function orderAt(cx, cy) {
  const units = selectedUnits();
  if (!units.length) return;
  const [x, y] = screenToWorld(cx, cy);
  ui.marks.push({ x, y, t: performance.now(), stealth: stealthOrders });
  // Приказ одному бойцу
  if (ui.soldier) {
    const u = sim.units.find((q) => q.id === ui.soldier.unitId);
    if (u) { sim.orderSoldier(u, ui.soldier.idx, x, y); return; }
  }
  const foot = units.filter((u) => u.soldiers);
  const rest = units.filter((u) => !u.soldiers);
  const bld = buildingAtScreen(world, view, cx * dpr, cy * dpr);
  if (orderMode === 'basement') {
    setOrderMode(null);
    // Здание под курсором или ближайшее с подвалом
    let target = bld?.interior?.basement ? bld : null;
    if (!target) {
      let bd = 150;
      for (const b of world.buildings.query({ x0: x - 150, y0: y - 150, x1: x + 150, y1: y + 150 })) {
        if (!b.interior?.basement) continue;
        const d = Math.hypot(b.x - x, b.y - y);
        if (d < bd) { bd = d; target = b; }
      }
    }
    if (!target) { toast('Рядом нет подвалов и погребов'); return; }
    for (const u of foot) sim.orderBasement(u, target);
    toast(`В укрытие: ${target.interior.basement.kind}`);
    return;
  }
  // ПКМ по зданию — пехота занимает его (у окон), техника встаёт рядом
  if (bld && foot.length) {
    for (const u of foot) sim.orderGarrison(u, bld);
    if (rest.length) sim.orderMove(rest, x, y, { stealth: stealthOrders });
    toast(`Занять здание${bld.interior.floors > 1 ? ` (${bld.interior.floors} эт.)` : ''}: ${foot.length} отд.`);
    return;
  }
  if (orderMode === 'clear') {
    setOrderMode(null);
    let ok = 0;
    for (const u of foot) if (sim.orderClear(u, x, y)) ok++;
    toast(ok ? `Зачистка траншеи: ${ok} отд.` : 'Укажите точку на траншее');
    return;
  }
  // Клик по траншее — пехота занимает позицию, техника просто едет рядом
  sim.trenches.ensure();
  const onTrench = sim.trenches.nearest(x, y, 6, true) >= 0;
  if (onTrench && foot.length) {
    foot.forEach((u, i) => {
      // Несколько отделений — занимают соседние участки
      const off = (i - (foot.length - 1) / 2) * 45;
      const node = sim.trenches.nodes[sim.trenches.nearest(x, y, 6, true)];
      const it = node.item;
      let tx = x, ty = y;
      if (it?.line && foot.length > 1) {
        const a = it.line[0], b = it.line[it.line.length - 1];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        tx += ((b[0] - a[0]) / L) * off;
        ty += ((b[1] - a[1]) / L) * off;
      }
      if (!sim.orderOccupy(u, tx, ty)) sim.orderOccupy(u, x, y);
    });
    if (rest.length) sim.orderMove(rest, x, y, { stealth: stealthOrders });
    toast(`Занять траншею: ${foot.length} отд.`);
    return;
  }
  sim.orderMove(units, x, y, { stealth: stealthOrders });
}

function setOrderMode(m) {
  orderMode = m;
  hud.clear.classList.toggle('active', m === 'clear');
  hud.basement.classList.toggle('active', m === 'basement');
  canvas.style.cursor = m ? 'crosshair' : 'grab';
}

let toastTimer = 0;
function toast(text) {
  hud.toast.textContent = text;
  hud.toast.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (hud.toast.style.opacity = 0), 3500);
}

let pinch = null;
canvas.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    const [a, b] = e.touches;
    pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
    drag = null;
  }
}, { passive: true });
canvas.addEventListener('touchmove', (e) => {
  if (pinch && e.touches.length === 2) {
    const [a, b] = e.touches;
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    zoomAt((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2, d / pinch.d);
    pinch.d = d;
  }
}, { passive: true });
canvas.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; });

const keys = new Set();
addEventListener('keydown', (e) => {
  keys.add(e.key.toLowerCase());
  if (e.key === '+' || e.key === '=') zoomAt(innerWidth / 2, innerHeight / 2, 1.25);
  if (e.key === '-') zoomAt(innerWidth / 2, innerHeight / 2, 0.8);
  if (e.code === 'KeyB') toggleStrike();
  if (e.code === 'KeyL') toggleLabels();
  if (e.code === 'KeyG') toggleStealth();
  if (e.code === 'KeyX') { sim.stop(selectedUnits()); refreshPanel(); }
  if (e.code === 'Escape') {
    if (dig) toggleDig();
    else if (orderMode) setOrderMode(null);
    else if (ui.soldier) { ui.soldier = null; refreshPanel(); }
    else { ui.selected.clear(); refreshPanel(); }
  }
  if (e.code === 'KeyC') setOrderMode(orderMode === 'clear' ? null : 'clear');
  if (e.code === 'KeyV') setOrderMode(orderMode === 'basement' ? null : 'basement');
  if (e.code === 'KeyI') toggleInterior();
  const stanceKeys = { KeyZ: 'stand', KeyH: 'crouch', KeyP: 'prone', KeyN: 'auto' };
  if (stanceKeys[e.code]) setStance(stanceKeys[e.code]);
  if (e.code === 'KeyO') cycleFortView();
  if (e.code === 'KeyT') toggleDig();
  if (e.code === 'Enter' && dig) finishDig();
  if (e.code === 'Space') { e.preventDefault(); setSpeed(paused ? timeScale : 0); }
  if (e.code === 'Tab') { e.preventDefault(); switchSide(); }
  if (e.code === 'KeyA' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    for (const u of sim.units) if (u.side === controlSide) ui.selected.add(u.id);
    refreshPanel();
  }
  const speedKeys = { Digit1: 1, Digit2: 5, Digit3: 20, Digit4: 60 };
  if (speedKeys[e.code]) setSpeed(speedKeys[e.code]);
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

function toggleStrike() {
  if (dig) toggleDig();
  strikeMode = !strikeMode;
  hud.strike.classList.toggle('active', strikeMode);
  canvas.style.cursor = strikeMode ? 'crosshair' : 'grab';
}
function toggleLabels() {
  showLabels = !showLabels;
  hud.labels.classList.toggle('active', showLabels);
  dirty = true;
}
function toggleStealth() {
  stealthOrders = !stealthOrders;
  hud.stealth.classList.toggle('active', stealthOrders);
}
function switchSide() {
  controlSide = controlSide === 'blue' ? 'red' : 'blue';
  ui.selected.clear();
  hud.side.textContent = `Сторона: ${SIDES[controlSide].name}`;
  hud.side.style.color = SIDES[controlSide].fill;
  refreshPanel();
}
function setSpeed(v) {
  if (v === 0) paused = true;
  else { paused = false; timeScale = v; }
  hud.speeds.forEach((b) => b.classList.toggle('active', paused ? b.dataset.speed === '0' : Number(b.dataset.speed) === timeScale));
}
hud.speeds.forEach((b) => (b.onclick = () => setSpeed(Number(b.dataset.speed))));
setSpeed(timeScale);
hud.stealth.onclick = toggleStealth;
hud.stop.onclick = () => { sim.stop(selectedUnits()); refreshPanel(); };
hud.side.onclick = switchSide;
switchSide(); switchSide();
function cycleFortView() {
  fortView = FORT_VIEWS[(FORT_VIEWS.indexOf(fortView) + 1) % FORT_VIEWS.length];
  ui.underground = fortView === 'underground';
  hud.forts.textContent = FORT_VIEW_NAMES[fortView];
  hud.forts.classList.toggle('active', fortView !== 'off');
}
function toggleDig() {
  if (strikeMode) toggleStrike();
  dig = dig ? null : { points: [], cursor: null };
  hud.dig.classList.toggle('active', !!dig);
  hud.dig.textContent = dig ? 'Копаем: ПКМ — готово' : 'Копать траншею';
  canvas.style.cursor = dig ? 'crosshair' : 'grab';
  if (dig && fortView === 'off') cycleFortView();
}
function finishDig() {
  if (dig.points.length >= 2) {
    const diggers = selectedUnits().filter((u) => u.def.dig);
    if (diggers.length) {
      const job = sim.orderDig(diggers, dig.points);
      const rate = diggers.reduce((a, u) => a + u.def.dig, 0);
      toast(`Рыть траншею ${Math.round(job.total)} м: ${diggers.map((u) => u.label).join(', ')} · ~${fmtEta((job.total / rate) * 3600)} игрового времени`);
    } else {
      // Без выбранных копающих — мгновенно (тестовый режим)
      const created = digTrench(world, digRng, dig.points, controlSide, controlSide === 'blue' ? [1, 0] : [-1, 0]);
      for (const c of created) chunks.invalidate(c.bbox);
      toast('Траншея создана мгновенно (тест). Чтобы рыли бойцы — выберите пехоту, сапёров или БТМ.');
    }
  }
  dig.points = [];
  toggleDig();
}
hud.forts.onclick = cycleFortView;
hud.clear.onclick = () => setOrderMode(orderMode === 'clear' ? null : 'clear');
hud.basement.onclick = () => setOrderMode(orderMode === 'basement' ? null : 'basement');
hud.interior.onclick = () => toggleInterior();
hud.stances.forEach((b) => (b.onclick = () => setStance(b.dataset.stance)));
function toggleInterior() {
  interiorsForce = !interiorsForce;
  hud.interior.classList.toggle('active', interiorsForce);
  hud.interior.textContent = interiorsForce ? 'Интерьеры: всегда' : 'Интерьеры: вблизи';
}
// Поза — выбранному бойцу или всем бойцам выбранных отделений
function setStance(st) {
  if (ui.soldier) {
    const u = sim.units.find((q) => q.id === ui.soldier.unitId);
    if (u) sim.setStance(u, st, ui.soldier.idx);
  } else for (const u of selectedUnits()) sim.setStance(u, st);
  toast(`Поза: ${st === 'auto' ? 'авто (по обстановке)' : POSES[st].name}`);
  updatePanel();
}
hud.dig.onclick = toggleDig;
hud.forts.textContent = FORT_VIEW_NAMES[fortView];
hud.strike.onclick = toggleStrike;
hud.labels.onclick = toggleLabels;
hud.labels.classList.add('active');
hud.newMap.onclick = () => {
  const s = Math.floor(Math.random() * 1e6);
  location.search = `?seed=${s}`;
};

// Артудар: кластер воронок, чанки в зоне перерисуются
function strike(x, y) {
  const n = strikeRng.int(5, 14);
  const added = addCraterCluster(world, strikeRng, x, y, n, strikeRng.float(12, 35));
  if (strikeRng.chance(0.35)) added.push(addBurn(world, strikeRng, x, y, strikeRng.float(20, 60)));
  let b = { x0: x, y0: y, x1: x, y1: y };
  for (const c of added) b = { x0: Math.min(b.x0, c.bbox.x0), y0: Math.min(b.y0, c.bbox.y0), x1: Math.max(b.x1, c.bbox.x1), y1: Math.max(b.y1, c.bbox.y1) };
  chunks.invalidate(b);
  flashes.push({ x, y, t: performance.now() });
  dirty = true;
}
const flashes = [];

// ---------- Миникарта ----------
mini.width = 240;
mini.height = 160;
const miniScale = mini.width / world.W;
mini.addEventListener('pointerdown', (e) => {
  const moveTo = (ev) => {
    const r = mini.getBoundingClientRect();
    cam.x = ((ev.clientX - r.left) / r.width) * world.W;
    cam.y = ((ev.clientY - r.top) / r.height) * world.H;
    clampCam();
    dirty = true;
  };
  moveTo(e);
  mini.setPointerCapture(e.pointerId);
  mini.onpointermove = moveTo;
  mini.onpointerup = () => (mini.onpointermove = null);
});

// ---------- Кадр ----------
function pickLevel() {
  for (let i = 0; i < LEVELS.length; i++) if (LEVELS[i] >= cam.zoom * 0.85) return i;
  return LEVELS.length - 1;
}

function visibleRange(level) {
  const size = chunks.worldSize(level);
  const hw = canvas.width / 2 / cam.zoom, hh = canvas.height / 2 / cam.zoom;
  return {
    cx0: Math.max(0, Math.floor((cam.x - hw) / size)),
    cy0: Math.max(0, Math.floor((cam.y - hh) / size)),
    cx1: Math.min(Math.ceil(world.W / size) - 1, Math.floor((cam.x + hw) / size)),
    cy1: Math.min(Math.ceil(world.H / size) - 1, Math.floor((cam.y + hh) / size)),
  };
}

function drawLevel(level, requestMissing, need) {
  const size = chunks.worldSize(level);
  const r = visibleRange(level);
  const sx = (wx) => Math.round((wx - cam.x) * cam.zoom + canvas.width / 2);
  const sy = (wy) => Math.round((wy - cam.y) * cam.zoom + canvas.height / 2);
  for (let cy = r.cy0; cy <= r.cy1; cy++)
    for (let cx = r.cx0; cx <= r.cx1; cx++) {
      const e = chunks.get(level, cx, cy);
      if (e) {
        const x0 = sx(cx * size), y0 = sy(cy * size), x1 = sx((cx + 1) * size), y1 = sy((cy + 1) * size);
        ctx.drawImage(e.canvas, x0, y0, x1 - x0, y1 - y0);
      }
      if (requestMissing && (!e || e.stale)) {
        const dx = (cx + 0.5) * size - cam.x, dy = (cy + 0.5) * size - cam.y;
        need.push({ level, cx, cy, d: dx * dx + dy * dy });
      }
    }
}

let lastNow = performance.now();
let panelTimer = 0;
function frame(now) {
  chunks.frame++;
  const dtReal = Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
  lastNow = now;
  // Симуляция: шаги не длиннее 0.25 игровой секунды
  if (!paused) {
    let gdt = dtReal * timeScale;
    while (gdt > 1e-6) {
      const step = Math.min(0.25, gdt);
      sim.update(step);
      gdt -= step;
    }
  }
  sim.processQueue(8);
  for (const ev of sim.events) {
    if (ev.type === 'forts') chunks.invalidate(ev.bbox);
    else if (ev.type === 'msg') toast(ev.text);
  }
  sim.events.length = 0;
  emitDust(sim, paused ? 0 : dtReal, timeScale);
  dirty = true;
  panelTimer += dtReal;
  if (panelTimer > 0.2) { panelTimer = 0; updatePanel(); }
  // Клавиатура
  const pan = (12 * dpr) / cam.zoom;
  if (keys.has('w') || keys.has('arrowup') || keys.has('ц')) { cam.y -= pan; dirty = true; }
  if (keys.has('s') || keys.has('arrowdown') || keys.has('ы')) { cam.y += pan; dirty = true; }
  if (keys.has('a') || keys.has('arrowleft') || keys.has('ф')) { cam.x -= pan; dirty = true; }
  if (keys.has('d') || keys.has('arrowright') || keys.has('в')) { cam.x += pan; dirty = true; }
  clampCam();

  if (flashes.length) dirty = true;
  if (dirty) {
    dirty = false;
    const need = [];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1b1d17';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const L = pickLevel();
    drawLevel(0, true, need);
    // Промежуточные уровни, если уже есть в кэше — плавная подгрузка
    for (let l = Math.max(1, L - 2); l < L; l++) drawLevel(l, false, need);
    if (L > 0) drawLevel(L, true, need);

    // Всё за пределами карты — тёмное
    {
      const x0 = Math.round((0 - cam.x) * cam.zoom + canvas.width / 2), y0 = Math.round((0 - cam.y) * cam.zoom + canvas.height / 2);
      const x1 = Math.round((world.W - cam.x) * cam.zoom + canvas.width / 2), y1 = Math.round((world.H - cam.y) * cam.zoom + canvas.height / 2);
      ctx.fillStyle = '#1b1d17';
      ctx.fillRect(0, 0, canvas.width, y0);
      ctx.fillRect(0, y1, canvas.width, canvas.height - y1);
      ctx.fillRect(0, 0, x0, canvas.height);
      ctx.fillRect(x1, 0, canvas.width - x1, canvas.height);
    }

    // Рендер недостающих чанков с бюджетом по времени
    need.sort((a, b) => a.level - b.level || a.d - b.d);
    const t0 = performance.now();
    let rendered = 0;
    for (const n of need) {
      if (rendered > 0 && performance.now() - t0 > 14) break;
      chunks.render(n.level, n.cx, n.cy);
      rendered++;
    }
    if (rendered < need.length || rendered > 0) dirty = true;
    hud.loading.style.opacity = need.length > rendered ? 1 : 0;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawInteriors(ctx, world, sim, view, interiorsForce, ui.underground);
    drawFortOverlay(ctx, world, view, fortView, dig);
    drawUnits(ctx, sim, view, ui);
    drawOverlay(now);
    drawMinimap();
    updateHud();
  }
  requestAnimationFrame(frame);
}

// ---------- Подписи, вспышки ударов ----------
function drawOverlay(now) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const toS = (x, y) => [((x - cam.x) * cam.zoom + canvas.width / 2) / dpr, ((y - cam.y) * cam.zoom + canvas.height / 2) / dpr];
  if (showLabels) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const s of world.settlements) {
      const isCity = s.type === 'city';
      if (!isCity && cam.zoom < 0.08) continue;
      if (cam.zoom > 3) continue;
      const [x, y] = toS(s.x, s.y);
      ctx.font = isCity ? '700 20px "PT Sans", system-ui, sans-serif' : '600 15px "PT Sans", system-ui, sans-serif';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(s.name, x, y);
      ctx.fillStyle = isCity ? '#fff6dc' : '#f1ecde';
      ctx.fillText(s.name, x, y);
    }
  }
  // Вспышки разрывов
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i];
    const t = (now - f.t) / 700;
    if (t > 1) { flashes.splice(i, 1); continue; }
    const [x, y] = toS(f.x, f.y);
    const r = (15 + t * 60) * Math.max(0.5, Math.min(2, cam.zoom / dpr));
    ctx.fillStyle = `rgba(255,190,90,${0.5 * (1 - t)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawMinimap() {
  const ov = chunks.get(0, 0, 0);
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.fillStyle = '#1b1d17';
  mctx.fillRect(0, 0, mini.width, mini.height);
  const size = chunks.worldSize(0);
  for (let cy = 0; cy * size < world.H; cy++)
    for (let cx = 0; cx * size < world.W; cx++) {
      const e = chunks.get(0, cx, cy);
      if (e) mctx.drawImage(e.canvas, cx * size * miniScale, cy * size * miniScale, size * miniScale, size * miniScale);
    }
  for (const u of sim.units) {
    mctx.fillStyle = SIDES[u.side].fill;
    mctx.fillRect(u.x * miniScale - 1.5, u.y * miniScale - 1.5, 3, 3);
  }
  if (!ov) return;
  const hw = canvas.width / 2 / cam.zoom, hh = canvas.height / 2 / cam.zoom;
  mctx.strokeStyle = '#ffd36b';
  mctx.lineWidth = 1.5;
  mctx.strokeRect((cam.x - hw) * miniScale, (cam.y - hh) * miniScale, hw * 2 * miniScale, hh * 2 * miniScale);
}

function updateHud() {
  // Масштабная линейка: «круглая» длина около 120 css px
  const mPerCss = dpr / cam.zoom;
  const target = 120 * mPerCss;
  const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  const len = nice.find((n) => n >= target * 0.6) || 5000;
  hud.scale.style.width = `${len / mPerCss}px`;
  hud.scaleLabel.textContent = len >= 1000 ? `${len / 1000} км` : `${len} м`;
  if (mouse) {
    const [x, y] = screenToWorld(mouse[0], mouse[1]);
    hud.coords.textContent = `X ${Math.round(x)} м · Y ${Math.round(y)} м`;
  }
}

// ---------- Панели: время и выбранные отряды ----------
function fmtTime(sec) {
  const d = Math.floor(sec / 86400) + 1;
  const h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return `День ${d} · ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function fmtEta(sec) {
  if (sec < 60) return `${Math.round(sec)} с`;
  if (sec < 3600) return `${Math.round(sec / 60)} мин`;
  return `${Math.floor(sec / 3600)} ч ${Math.round((sec % 3600) / 60)} мин`;
}
const STATE_TEXT = { idle: 'стоит', planning: 'прокладка маршрута', moving: 'марш' };

function refreshPanel() {
  const units = selectedUnits();
  hud.sel.style.display = units.length ? 'flex' : 'none';
  hud.selList.innerHTML = '';
  for (const u of units.slice(0, 12)) {
    const row = document.createElement('div');
    row.className = 'unit-row';
    const c = document.createElement('canvas');
    c.width = 44; c.height = 30;
    drawSymbol(c.getContext('2d'), 22, 15, 18, u.side, u.def.symbol);
    row.appendChild(c);
    const info = document.createElement('div');
    info.innerHTML = `<b>${u.label}</b> <span class="muted">${u.def.name}</span><div class="st" data-id="${u.id}"></div>`;
    row.appendChild(info);
    row.onclick = () => { cam.x = u.x; cam.y = u.y; };
    hud.selList.appendChild(row);
  }
  if (units.length > 12) {
    const more = document.createElement('div');
    more.className = 'muted';
    more.textContent = `и ещё ${units.length - 12}…`;
    hud.selList.appendChild(more);
  }
  // Одно отделение — список бойцов, можно выбрать любого
  if (units.length === 1 && units[0].soldiers) {
    const u = units[0];
    const box = document.createElement('div');
    box.className = 'soldiers';
    for (const sd of u.soldiers) {
      const b = document.createElement('button');
      b.className = 'soldier' + (ui.soldier && ui.soldier.unitId === u.id && ui.soldier.idx === sd.idx ? ' active' : '');
      b.textContent = `${sd.idx + 1}. ${sd.role}`;
      b.dataset.sid = sd.idx;
      b.onclick = (ev) => {
        ev.stopPropagation();
        ui.soldier = ui.soldier && ui.soldier.idx === sd.idx ? null : { unitId: u.id, idx: sd.idx };
        if (ui.soldier) { cam.x = sd.x; cam.y = sd.y; cam.zoom = Math.max(cam.zoom, 6 * dpr); }
        refreshPanel();
      };
      box.appendChild(b);
    }
    hud.selList.appendChild(box);
  }
  hud.selTitle.textContent = ui.soldier ? `Боец: ${sim.units.find((q) => q.id === ui.soldier.unitId)?.soldiers[ui.soldier.idx].role}` : `Выбрано: ${units.length}`;
  updatePanel();
}

const TASK_TEXT = { occupy: 'занимает позицию', clear: 'зачистка траншеи', dig: 'роет траншею', manual: 'ручное управление', garrison: 'занимает здание', basement: 'уходит в укрытие' };
function updatePanel() {
  hud.clock.textContent = fmtTime(sim.time);
  const units = selectedUnits();
  hud.task.textContent = '';
  const soldierObj = ui.soldier ? sim.units.find((q) => q.id === ui.soldier.unitId)?.soldiers[ui.soldier.idx] : null;
  const cur = soldierObj ? soldierObj.stance : units.find((u) => u.soldiers)?.soldiers[0].stance;
  hud.stances.forEach((b) => b.classList.toggle('active', b.dataset.stance === cur));
  document.getElementById('stances').style.display = units.some((u) => u.soldiers) ? 'flex' : 'none';
  if (units.length === 1) {
    const u = units[0];
    let t = u.task ? `Задача: ${TASK_TEXT[u.task.type]}` : u.mode === 'trench' ? 'В траншее' : '';
    if (u.task?.type === 'dig') t += ` · ${Math.round((u.task.job.done / u.task.job.total) * 100)}%`;
    if (u.task?.type === 'clear') t += ` · ${Math.round((u.task.progress / Math.max(1, u.task.line.length - 1)) * 100)}%`;
    if (u.pending) t += ' · выдвигается';
    hud.task.textContent = t;
    if (ui.soldier && ui.soldier.unitId === u.id) {
      const sd = u.soldiers[ui.soldier.idx];
      const where = sd.under ? (sd.building ? sd.building.interior.basement?.kind || 'под землёй' : 'под землёй') : sd.building ? 'в здании' : sim.trenches.nearest(sd.x, sd.y, 1.5) >= 0 ? 'в траншее' : 'на открытой местности';
      hud.task.textContent = `${sd.role} · ${POSES[sd.pose]?.name || ''} · ${sd.mode === 'path' ? 'движется' : 'на месте'} · ${where} · поза: ${sd.stance === 'auto' ? 'авто' : POSES[sd.stance].name} · ПКМ — куда идти`;
    }
  }
  for (const el of hud.selList.querySelectorAll('.st')) {
    const u = sim.units.find((q) => q.id === Number(el.dataset.id));
    if (!u) continue;
    const terr = T_NAMES[sim.nav.classAt(u.x, u.y)];
    let t = `${STATE_TEXT[u.state]} · ${terr}`;
    if (u.state === 'moving') t += ` · ${(u.speed * 3.6).toFixed(0)} км/ч · прибытие ~${fmtEta(u.eta)}`;
    if (u.state === 'idle' && u.noRoute && sim.time - u.noRoute < 30) t += ' · нет маршрута!';
    el.textContent = t;
  }
}

// Стартовая отрисовка обзорного уровня, затем цикл
for (let cy = 0; cy * chunks.worldSize(0) < world.H; cy++)
  for (let cx = 0; cx * chunks.worldSize(0) < world.W; cx++) chunks.render(0, cx, cy);
hud.loading.style.opacity = 0;
requestAnimationFrame(frame);

// Для отладки из консоли
window.game = { world, cam, chunks, sim, ui, CHUNK_PX };
