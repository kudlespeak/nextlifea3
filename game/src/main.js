import { MAIN_SEED, applyEconEvent } from './mapgen.js';
import { loadWorld } from './worldcache.js';
import { ChunkCache, LEVELS, CHUNK_PX } from './render/chunks.js';
import { Rng } from './rng.js';
import { Sim, SIDES, POSES, UNIT_TYPES, unitDef } from './sim/units.js';
import { COST, INCOME } from './sim/reserve.js';
import { woundText, vehicleStatus } from './sim/wounds.js';
import { T_NAMES } from './sim/nav.js';
import { CALIBERS } from './sim/artillery.js';
import { FACTIONS } from './sim/factions.js';
import { MODES } from './sim/modes.js';
import { drawUnits, drawSymbol, emitDust, pickUnit, pickSoldier, drawArtillery, drawCombatFx } from './render/units.js';
import { drawFortOverlay, FORT_VIEWS, FORT_VIEW_NAMES } from './render/forts.js';
import { digTrench } from './forts.js';
import { drawInteriors, buildingAtScreen } from './render/interiors.js';
import { drawNight, drawFog } from './render/night.js';
import { drawFront, drawZones, drawPrep, drawSpawns, drawInfra } from './render/modes.js';
import { drawFacilities, drawPlacement } from './render/facilities.js';
import { FACILITIES } from './sim/construct.js';
import { RES, RES_NAMES } from './sim/logistics.js';
import { daylight } from './power.js';
import { packDelta, unpackDelta } from './net.js';
const deltaOut = {}, deltaIn = {};
import { Net, makeSnapshot, applySnapshot, gridPacket, applyGrid, interpolate, applyWorldEvent } from './net.js';

import { DWUI } from './dwui.js';
import { drawDW, drawDWPreview } from './render/dwdraw.js';
import { drawWeatherLayer } from './render/dwextra.js';
import { drawSmoke } from './render/smoke.js';
import { WX, DW_AD as DW_AD_REF } from './sim/dronewar.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const canvas = $('map');
const ctx = canvas.getContext('2d');
const mini = $('minimap');
const mctx = mini.getContext('2d');

// Игровые объекты создаются при старте партии
let world = null, chunks = null, sim = null, cfg = null;
let dwui = null; // интерфейс режима «Война дронов»
let role = 'single'; // single | host | guest
let net = null;

// ================= Состояние интерфейса =================
const ui = { selected: new Set(), box: null, marks: [], soldier: null, underground: false };
let orderMode = null; // move | occupy | clear | basement | fire | dig | strike | recon | fpv | bomber
let controlSide = 'blue';
let stealthOrders = false;
let showMore = false; // раскрыты редкие команды
let timeScale = 1;
let paused = false;
let fortView = 'off';
let interiorsForce = false;
let showLabels = true;
let dig = null;
const fireOpts = { rounds: 3, fuse: 'ground' };
let dpr = window.devicePixelRatio || 1;
const cam = { x: 0, y: 0, zoom: 1 };
let mouse = null;
let minZoom = 0.05;
const MAX_ZOOM = 28;
let digRng = new Rng(1);

// ================= Стартовое меню =================
const menu = {
  side: 'blue', mode: 'zones', role: 'defend', startHour: 5, fog: true, difficulty: 'normal', duration: 3600, prep: 300,
  seed: Number(params.get('seed')) || Math.floor(Math.random() * 1e6), tab: 'single',
  map: params.get('seed') ? 'random' : 'main', // «Война дронов»: основная выверенная карта или случайная
  gfx: (() => { try { return params.get('gfx') || localStorage.getItem('gfx') || 'high'; } catch { return 'high'; } })(),
};
window.GFX = menu.gfx;

function buildMenu() {
  const f = $('factions');
  f.innerHTML = '';
  for (const side of ['blue', 'red']) {
    const F = FACTIONS[side];
    const d = document.createElement('div');
    d.className = 'faction' + (menu.side === side ? ' sel' : '');
    const kit = ['tank', 'ifv', 'apc', 'arty', 'mortar'].map((t) => F.units[t].name).join(' · ');
    d.innerHTML = `<div class="flag"><i style="background:${F.flag[0]}"></i><i style="background:${F.flag[1]}"></i></div>
      <b style="color:${F.fill}">${F.country}</b><div class="army">${F.army} · ${F.motto}</div>
      <ul>${F.doctrine.map((x) => `<li>${x}</li>`).join('')}</ul><div class="kit">Техника: ${kit}</div>`;
    d.onclick = () => { menu.side = side; buildMenu(); };
    f.appendChild(d);
  }
  const opts = (id, label, list, key) => {
    const row = $(id);
    row.innerHTML = `<span>${label}</span>`;
    for (const [v, name] of list) {
      const b = document.createElement('button');
      b.textContent = name;
      b.className = menu[key] === v ? 'sel' : '';
      b.onclick = () => { menu[key] = v; buildMenu(); };
      row.appendChild(b);
    }
  };
  const mo = $('opt-mode');
  mo.innerHTML = '';
  for (const [k, m] of Object.entries(MODES)) {
    const b = document.createElement('button');
    b.textContent = m.name;
    b.className = menu.mode === k ? 'sel' : '';
    b.onclick = () => { if (k !== menu.mode && (k === 'drones' || menu.mode === 'drones')) { menu.duration = k === 'drones' ? 0 : 3600; menu.prep = k === 'drones' ? 120 : 300; } menu.mode = k; buildMenu(); };
    mo.appendChild(b);
  }
  $('mode-desc').textContent = MODES[menu.mode].desc;
  $('opt-attacker').style.display = menu.mode === 'assault' ? 'flex' : 'none';
  opts('opt-attacker', 'Ваша задача', [['attack', 'Наступление'], ['defend', 'Оборона']], 'role');
  opts('opt-time', 'Начало', [[5, 'Рассвет 05:00'], [12, 'День 12:00'], [20, 'Сумерки 20:00'], [23, 'Ночь 23:00']], 'startHour');
  opts('opt-fog', 'Туман войны', [[true, 'Включён'], [false, 'Выключен']], 'fog');
  opts('opt-diff', 'Сложность ИИ', [['easy', 'Лёгкая'], ['normal', 'Нормальная'], ['hard', 'Тяжёлая']], 'difficulty');
  // «Война дронов» — короткие партии с фазами эскалации
  const durs = menu.mode === 'drones' ? [[2400, '40 мин'], [7200, '2 часа'], [0, 'Без ограничения']] : [[1800, '30 мин'], [3600, '60 мин'], [5400, '90 мин']];
  if (!durs.some(([v]) => v === menu.duration)) menu.duration = menu.mode === 'drones' ? 0 : 3600;
  opts('opt-dur', 'Длительность', durs, 'duration');
  const preps = menu.mode === 'drones' ? [[0, 'Нет'], [60, '1 мин'], [120, '2 мин'], [180, '3 мин']] : [[0, 'Нет'], [180, '3 мин'], [300, '5 мин'], [600, '10 мин']];
  if (!preps.some(([v]) => v === menu.prep)) menu.prep = menu.mode === 'drones' ? 120 : 300;
  opts('opt-prep', 'Подготовка', preps, 'prep');
  $('opt-map').style.display = menu.mode === 'drones' ? 'flex' : 'none';
  opts('opt-map', 'Карта', [['main', 'Основная (выверенная)'], ['random', 'Случайная']], 'map');
  // Графика: «экономная» — без людей, пыли, фар, погоды на экране, травяной микротекстуры и огней окон
  opts('opt-gfx', 'Графика', [['high', 'Высокая'], ['low', 'Экономная (слабый ПК)']], 'gfx');
  try { localStorage.setItem('gfx', menu.gfx); } catch { /* ignore */ }
  window.GFX = menu.gfx;
  const fixed = menu.mode === 'drones' && menu.map === 'main';
  $('opt-seed').value = fixed ? MAIN_SEED : menu.seed;
  $('opt-seed').disabled = fixed;
  $('seed-rnd').disabled = fixed;
  $('opt-diff').style.display = menu.tab === 'single' ? 'flex' : 'none';
  $('mp-card').style.display = menu.tab === 'mp' ? 'block' : 'none';
  $('tab-single').classList.toggle('active', menu.tab === 'single');
  $('tab-mp').classList.toggle('active', menu.tab === 'mp');
  $('btn-start').style.display = menu.tab === 'single' || (role === 'host' && net?.guestReady) ? '' : 'none';
  $('start-hint').textContent = menu.tab === 'single'
    ? `Вы: ${FACTIONS[menu.side].country}. Противник: ${FACTIONS[menu.side === 'blue' ? 'red' : 'blue'].country} (ИИ).`
    : role === 'host' ? (net?.guestReady ? 'Соперник подключён — можно начинать.' : 'Ждём соперника…') : 'Создайте комнату или подключитесь по коду.';
}
$('tab-single').onclick = () => { menu.tab = 'single'; buildMenu(); };
$('tab-mp').onclick = () => { menu.tab = 'mp'; buildMenu(); };
$('opt-seed').onchange = (e) => { menu.seed = Number(e.target.value) || 1; menu.map = 'random'; };
$('seed-rnd').onclick = () => { menu.seed = Math.floor(Math.random() * 1e6); buildMenu(); };
$('mp-url').value = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host || 'localhost:8080'}/ws`;

function gameConfig() {
  const enemy = menu.side === 'blue' ? 'red' : 'blue';
  return {
    seed: menu.mode === 'drones' && menu.map === 'main' ? MAIN_SEED : menu.seed, mode: menu.mode, attacker: menu.role === 'attack' ? menu.side : enemy, startHour: menu.startHour, fog: menu.fog,
    difficulty: menu.difficulty, duration: menu.duration, prep: menu.prep, playerSide: menu.side,
    aiSides: menu.tab === 'single' ? [enemy] : [], multiplayer: menu.tab === 'mp',
  };
}

$('btn-start').onclick = () => {
  const c = gameConfig();
  if (role === 'host') {
    net.send({ t: 'start', cfg: { ...c, playerSide: c.playerSide === 'blue' ? 'red' : 'blue' } });
  }
  startGame(c);
};

// ---------- Мультиплеер: лобби ----------
async function connect() {
  if (net) return net;
  net = new Net($('mp-url').value);
  $('mp-status').textContent = 'Подключение к серверу…';
  try { await net.ready(); } catch { $('mp-status').textContent = 'Не удалось подключиться. Запустите node game/server.js и откройте игру по его адресу.'; net = null; throw new Error('no server'); }
  net.on('error', (m) => { $('mp-status').textContent = m.text || 'Ошибка связи'; })
    .on('close', () => { if (sim) log('Связь с сервером потеряна'); else $('mp-status').textContent = 'Соединение закрыто'; })
    .on('left', () => { if (sim) log('Соперник отключился'); else { net.guestReady = false; buildMenu(); } });
  return net;
}
$('mp-host').onclick = async () => {
  await connect();
  role = 'host';
  net.on('hosted', (m) => { $('mp-code').textContent = m.code; $('mp-status').textContent = `Комната ${m.code}. Сообщите код сопернику.`; buildMenu(); })
    .on('guest', () => { net.guestReady = true; $('mp-status').textContent = 'Соперник подключился. Настройте игру и нажмите «В бой».'; buildMenu(); })
    .on('cmd', (m) => execCommand(m.c, m.a));
  net.send({ t: 'host' });
};
$('mp-join').onclick = async () => {
  await connect();
  role = 'guest';
  net.on('joined', (m) => { $('mp-status').textContent = `Вы в комнате ${m.code}. Ждём, пока хост начнёт игру…`; })
    .on('start', (m) => startGame(m.cfg))
    .on('snap', (m0) => { const m = unpackDelta(deltaIn, m0); if (sim && m) { applySnapshot(sim, m); lastSnap = performance.now(); if (m.spd) { mpSpeed.host = m.spd[0]; mpSpeed.guest = m.spd[1]; mpApply(); } } })
    .on('grid', (m) => { if (sim) applyGrid(sim, m); })
    .on('ev', (m) => { if (!sim) return; for (const e of m.list) { chunks.worldEvent(e); applyWorldEvent(sim, e, (b) => chunks.invalidate(b)); } })
    .on('msg', (m) => { if (sim && (!m.side || m.side === controlSide)) log(m.text); });
  net.send({ t: 'join', code: $('mp-join-code').value.trim() });
};
let lastSnap = 0;

buildMenu();

// ================= Запуск партии =================
function startGame(c) {
  deltaOut.prev = null; deltaOut.n = 0; deltaIn.last = null;
  for (const id of ['btn-forts', 'btn-interior']) { const b = $(id); if (b) b.style.display = c.mode === 'drones' ? 'none' : ''; }
  cfg = c;
  controlSide = c.playerSide;
  $('menu-screen').classList.add('hide');
  $('loading').style.opacity = 1;
  $('loading').textContent = 'Генерация местности…';
  const layout = c.mode === 'drones' ? 'dronewar' : 'front';
  ChunkCache.prewarm(c.seed, layout); // потоки отрисовки строят свою копию мира параллельно
  setTimeout(async () => {
    world = await loadWorld(c.seed, layout);
    chunks = new ChunkCache(world);
    sim = new Sim(world);
    sim.setupGame(c);
    if (role === 'guest') { sim.puppet = true; sim.ais = []; }
    if (c.mode === 'drones') { const fe = { k: 'fog', side: controlSide, on: sim.game.fog, reset: true, ids: [...sim.game.intel[controlSide]] }; chunks.worldEvent(fe); applyEconEvent(world, fe); }
    digRng = new Rng(c.seed ^ 0xd16);
    if (c.multiplayer) { timeScale = 1; mpSpeed.host = mpSpeed.guest = 1; mpApply(); document.querySelector('.timebox').classList.add('mp'); }
    $('info').textContent = `seed ${c.seed} · карта ${(world.W / 1000).toFixed(0)}×${(world.H / 1000).toFixed(0)} км · ${world.fromCache ? 'из кэша ' : ''}${world.genTime.toFixed(0)} мс`;
    const b = $('side-badge');
    b.textContent = FACTIONS[controlSide].country;
    b.className = controlSide;
    resize();
    // Камера — у своих позиций
    if (c.mode === 'drones') {
      const cap = world.settlements.find((q) => q.type === 'city' && q.side === controlSide && q.capital);
      cam.x = (cap.x + sim.game.frontX) / 2; cam.y = cap.y; cam.zoom = 0.1 * dpr;
    } else {
      const sp = sim.game.reserve[controlSide].spawn;
      cam.x = (sp.x + sim.game.prepLimit(controlSide)) / 2; cam.y = sp.y;
      cam.zoom = 0.35 * dpr;
    }
    mini.width = 540;
    mini.height = Math.round(540 * world.H / world.W);
    for (let cy = 0; cy * chunks.worldSize(0) < world.H; cy++)
      for (let cx = 0; cx * chunks.worldSize(0) < world.W; cx++) chunks.render(0, cx, cy);
    const enemy = controlSide === 'blue' ? 'red' : 'blue';
    if (c.mode === 'drones') {
      if (!c.multiplayer) $('speed8').style.display = '';
      // в «Войне дронов» окопов и планировок зданий нет
      for (const id of ['btn-forts', 'btn-interior']) { const b = $(id); if (b) b.style.display = 'none'; }
      dwui = new DWUI({ sim, side: controlSide, issue, log, focus: (x, y, zm) => focus(x, y, zm * dpr), screenToWorld, view });
      if (role !== 'guest') setTimeout(() => dwui.tutorial(), 1500);
      if (window.GFX === 'low') chunks.worldEvent({ k: 'gfx', low: true });
      $('mini-layer').onclick = cycleMiniLayer;
      $('prep-text').innerHTML = 'Разверните ПВО: мобильные группы, РЛС, РЭБ, посты. Удары дронами — после окончания развёртывания.';
      log(`${MODES[c.mode].name}. Вы — ${FACTIONS[controlSide].country}, противник — ${FACTIONS[enemy].country}${c.aiSides.length ? ' (ИИ)' : ''}. F1 — справка.`);
      log('Защищайте ТЭС, подстанции, мосты и склады; ремонтируйте их. Проиграет тот, чья энергосистема рухнет без денег на восстановление.');
      log('Слева — меню: Обзор, ПВО, Удары (производство и пуск дронов), Ремонт, Стройка, Заводы, Страна. Вверху панели — «что сделать сейчас» с кнопками.');
      $('loading').style.opacity = 0;
      lastNow = performance.now();
      requestAnimationFrame(frame);
      return;
    }
    buildRoster();
    log(`${MODES[c.mode].name}. Вы — ${FACTIONS[controlSide].country}, противник — ${FACTIONS[enemy].country}${c.aiSides.length ? ' (ИИ)' : ''}. F1 — справка.`);
    if (c.mode === 'assault') log(c.attacker === controlSide ? 'Ваша задача: прорвать четыре линии обороны противника по очереди.' : 'Ваша задача: удержать хотя бы одну из четырёх линий обороны до конца времени. За отход на следующую линию дают подкрепления.');
    log('Войска заказываются во вкладке «Резерв» слева и прибывают на пункт сбора.');
    showTab('reserve');
    $('loading').style.opacity = 0;
    $('loading').textContent = 'Прорисовка местности…';
    lastNow = performance.now();
    requestAnimationFrame(frame);
  }, 30);
}

// ================= Камера =================
function resize() {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  // большая карта вытянута по ширине: при полном отдалении она занимает ~60% высоты экрана (вся ширина — на миникарте)
  if (world) minZoom = Math.max(Math.min(canvas.width / world.W, canvas.height / world.H) * 0.9, canvas.height / (world.H * 1.7));
  cam.zoom = Math.max(cam.zoom, minZoom);
}
addEventListener('resize', resize);
resize();

function clampCam() {
  cam.zoom = Math.min(MAX_ZOOM, Math.max(minZoom, cam.zoom));
  cam.x = Math.min(world.W + 2000, Math.max(-2000, cam.x));
  cam.y = Math.min(world.H + 1500, Math.max(-1500, cam.y));
}
const screenToWorld = (sx, sy) => [cam.x + (sx * dpr - canvas.width / 2) / cam.zoom, cam.y + (sy * dpr - canvas.height / 2) / cam.zoom];
function zoomAt(sx, sy, factor) {
  const [wx, wy] = screenToWorld(sx, sy);
  cam.zoom *= factor;
  clampCam();
  const [nx, ny] = screenToWorld(sx, sy);
  cam.x += wx - nx; cam.y += wy - ny;
  clampCam();
}
function focus(x, y, zoom) { cam.x = x; cam.y = y; if (zoom) cam.zoom = Math.max(cam.zoom, zoom); clampCam(); }

const view = { cam, canvas, get dpr() { return dpr; } };
const selectedUnits = () => (sim ? sim.units.filter((u) => ui.selected.has(u.id) && !u.dead && u.side === controlSide) : []);
// Найден объект противника: перерисовать его площадку и ЛЭП/отпайки, что к нему ведут
function fogBoxes(sim, oid) {
  const o = sim.game.obj(oid), out = [];
  if (o) out.push({ x0: o.x - Math.max(o.w, o.h) - 200, y0: o.y - Math.max(o.w, o.h) - 200, x1: o.x + Math.max(o.w, o.h) + 200, y1: o.y + Math.max(o.w, o.h) + 200 });
  const P = sim.world.power;
  const box = (pts) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of pts) { const x = p.x ?? p[0], y = p.y ?? p[1]; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } out.push({ x0: x0 - 80, y0: y0 - 80, x1: x1 + 80, y1: y1 + 80 }); };
  for (const l of P.lines || []) if (l.a === oid || l.b === oid) box(l.pylons);
  for (const f of P.feeds || []) if (f.oid === oid) box(f.poles);
  P.mains?.forEach((m, i) => { if (m.infraId === oid) for (const tp of P.tps) if (tp.main === i) box(tp.poles); });
  return out;
}
const fogSide = () => (cfg?.fog ? controlSide : null);

// ================= Приказы (единый диспетчер: локально или по сети) =================
const building = (i) => world.buildings.items[i];
const bIndex = (b) => world.buildings.items.indexOf(b);
const unitsById = (ids) => sim.units.filter((u) => ids.includes(u.id) && !u.dead);
// Отделение в машине перед любым приказом, кроме посадки/позы/огня, спешивается
const dis = (u) => { if (u?.embarked) sim.disembark(u); return u; };
const COMMANDS_IMPL = {
  speed: (who, v) => { mpSpeed[who] = v; mpApply(); },
  move: (ids, x, y, stealth, direct) => {
    const us = unitsById(ids);
    // Ручной приказ приостанавливает автоматику (снабжение, санитарки, укрытие) на 3 минуты
    for (const u of us) u.autoPause = sim.time + 180;
    sim.orderMove(us, x, y, { stealth, direct });
  },
  board: (id, vid) => { const u = unitsById([id])[0], v = unitsById([vid])[0]; if (u && v) sim.orderBoard(u, v); },
  unload: (ids) => { for (const u of unitsById(ids)) { if (u.passengers?.length) sim.orderUnload(u); else if (u.embarked) sim.disembark(u); } },
  supply: (ids, on) => { for (const u of unitsById(ids)) if (u.cargoRes) { u.autoSupply = on; if (!on) u.supplyTask = null; } },
  ready: (side) => sim.game?.setReady(side),
  auto: (ids, on) => { for (const u of unitsById(ids)) { u.auto = on; if (u.cargoRes) u.autoSupply = on; } },
  build: (side, kind, x, y) => {
    const err = sim.build.place(side, kind, x, y);
    if (err) sim.msg(`${FACILITIES[kind].name}: ${err}`, side);
  },
  spawn: (side, type) => {
    const r = sim.game?.reserve?.[side];
    if (!r) return;
    const err = r.order(type, UNIT_TYPES[type].move);
    sim.msg(err || `Заказано: ${unitDef(type, side).name} — прибудет на пункт сбора`, side);
  },
  occupy: (id, x, y) => { const u = dis(unitsById([id])[0]); if (u && !sim.orderOccupy(u, x, y)) sim.orderMove([u], x, y); },
  garrison: (id, bi) => { const u = dis(unitsById([id])[0]); if (u) sim.orderGarrison(u, building(bi)); },
  basement: (id, bi) => { const u = dis(unitsById([id])[0]); if (u) sim.orderBasement(u, building(bi)); },
  clear: (id, x, y) => { const u = dis(unitsById([id])[0]); if (u) sim.orderClear(u, x, y); },
  soldier: (id, idx, x, y) => { const u = dis(unitsById([id])[0]); if (u) sim.orderSoldier(u, idx, x, y); },
  dig: (ids, pts) => sim.orderDig(unitsById(ids).map(dis), pts),
  fire: (ids, x, y, rounds, fuse) => { for (const t of sim.art.orderFire(unitsById(ids), x, y, { rounds, fuse })) sim.msg(t, sim.units.find((u) => u.id === ids[0])?.side); },
  stop: (ids) => { const us = unitsById(ids); sim.stop(us); for (const u of us) u.fire = null; },
  stance: (id, st, idx) => { const u = unitsById([id])[0]; if (u) sim.setStance(u, st, idx); },
  roe: (ids, roe) => { for (const u of unitsById(ids)) u.roe = roe; },
  evac: (ids) => { for (const u of unitsById(ids)) sim.orderEvac(u); },
  drone: (id, kind, x, y, target) => { const u = unitsById([id])[0]; const r = sim.drones.launch(u, kind, x, y, target); if (r) sim.msg(r, u?.side); },
  recall: (ids) => { for (const u of unitsById(ids)) sim.drones.recall(u); },
  // «Война дронов»: действие игры с проверками внутри; ошибка — сообщением стороне
  dw: (action, side, ...args) => { const r = sim.game?.[action]?.(side, ...args); if (typeof r === 'string') sim.msg(r, side); },
};
function execCommand(name, args) {
  const fn = COMMANDS_IMPL[name];
  if (fn) fn(...args);
}
function issue(name, ...args) {
  if (role === 'guest') net.send({ t: 'cmd', c: name, a: args });
  else execCommand(name, args);
}

// ================= Ввод =================
let drag = null, pinch = null, lastRight = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  if (!sim) return;
  closeMenu();
  canvas.setPointerCapture(e.pointerId);
  if (e.button === 2) {
    if (dwui) { dwui.rclick(e.clientX, e.clientY); return; }
    if (orderMode === 'dig') { finishDig(); return; }
    if (orderMode?.startsWith('build:')) { setOrderMode(null); return; }
    // Двойной ПКМ — напрямик
    const now = performance.now();
    const dbl = lastRight && now - lastRight.t < 380 && Math.hypot(e.clientX - lastRight.x, e.clientY - lastRight.y) < 24;
    lastRight = dbl ? null : { t: now, x: e.clientX, y: e.clientY };
    orderAt(e.clientX, e.clientY, dbl);
    return;
  }
  const box = e.shiftKey && !orderMode && !dwui;
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0, box, touch: e.pointerType === 'touch', shift: e.shiftKey };
  if (box) ui.box = { x0: e.clientX * dpr, y0: e.clientY * dpr, x1: e.clientX * dpr, y1: e.clientY * dpr };
});
canvas.addEventListener('pointermove', (e) => {
  if (!sim) return;
  mouse = [e.clientX, e.clientY];
  if (dig) dig.cursor = screenToWorld(e.clientX, e.clientY);
  updateHint();
  if (pinch || !drag || drag.id !== e.pointerId) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  drag.x = e.clientX; drag.y = e.clientY;
  if (drag.box) { ui.box.x1 = e.clientX * dpr; ui.box.y1 = e.clientY * dpr; }
  else { cam.x -= (dx * dpr) / cam.zoom; cam.y -= (dy * dpr) / cam.zoom; clampCam(); }
});
canvas.addEventListener('pointerup', (e) => {
  if (!drag || drag.id !== e.pointerId) return;
  if (drag.box) { boxSelect(ui.box, e.ctrlKey || e.metaKey); ui.box = null; }
  else if (drag.moved < 6) { if (dwui) dwui.click(e.clientX, e.clientY, drag.shift, e.ctrlKey || e.metaKey); else clickAt(e.clientX, e.clientY, e.ctrlKey || e.metaKey, drag.touch); }
  drag = null;
});
canvas.addEventListener('pointerleave', () => { mouse = null; $('hint').style.display = 'none'; });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); if (sim) zoomAt(e.clientX, e.clientY, Math.pow(1.0015, -e.deltaY)); }, { passive: false });
canvas.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    const [a, b] = e.touches;
    pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
    drag = null;
  }
}, { passive: true });
canvas.addEventListener('touchmove', (e) => {
  if (pinch && e.touches.length === 2 && sim) {
    const [a, b] = e.touches;
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    zoomAt((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2, d / pinch.d);
    pinch.d = d;
  }
}, { passive: true });
canvas.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; });

function clickAt(cx, cy, additive, touch) {
  const [x, y] = screenToWorld(cx, cy);
  if (orderMode?.startsWith('build:')) {
    const kind = orderMode.slice(6);
    const err = sim.build.check(controlSide, kind, x, y);
    if (err) { log(`${FACILITIES[kind].name}: ${err}`); return; }
    issue('build', controlSide, kind, x, y);
    setOrderMode(null);
    return;
  }
  if (orderMode === 'strike') { if (role !== 'guest') sim.art.explode(x, y, 152, fireOpts.fuse); return; }
  if (orderMode === 'dig') { dig.points.push([x, y]); updateHint(); return; }
  if (orderMode && ui.selected.size) { orderAt(cx, cy); return; }
  const sol = pickSoldier(sim, view, cx * dpr, cy * dpr, ui);
  if (sol) { ui.soldier = sol; buildCard(); return; }
  const u = pickUnit(sim, view, cx * dpr, cy * dpr, controlSide);
  if (u) {
    ui.soldier = null;
    if (additive) ui.selected.has(u.id) ? ui.selected.delete(u.id) : ui.selected.add(u.id);
    else { ui.selected.clear(); ui.selected.add(u.id); }
  } else if (touch && ui.selected.size) { orderAt(cx, cy); return; }
  else if (!additive) { ui.selected.clear(); ui.soldier = null; }
  selectionChanged();
}

function boxSelect(b, additive) {
  if (!additive) ui.selected.clear();
  ui.soldier = null;
  const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
  for (const u of sim.units) {
    if (u.side !== controlSide || u.dead) continue;
    const sx = (u.x - cam.x) * cam.zoom + canvas.width / 2, sy = (u.y - cam.y) * cam.zoom + canvas.height / 2;
    if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) ui.selected.add(u.id);
  }
  selectionChanged();
}

// Вражеское подразделение под курсором (для FPV-удара) — только видимое
function enemyAt(cx, cy) {
  const enemy = controlSide === 'blue' ? 'red' : 'blue';
  const u = pickUnit(sim, view, cx * dpr, cy * dpr, enemy);
  return u && (!cfg.fog || sim.vision.now[controlSide].has(u.id)) ? u : null;
}

function orderAt(cx, cy, direct = false) {
  const units = selectedUnits();
  if (!units.length) return;
  const [x, y] = screenToWorld(cx, cy);
  const mode = orderMode;
  ui.marks.push({ x, y, t: performance.now(), stealth: stealthOrders, direct });
  const ids = (us) => us.map((u) => u.id);
  if (!mode && !ui.soldier) {
    // ПКМ по своей машине с местами — пехота садится
    const veh = pickUnit(sim, view, cx * dpr, cy * dpr, controlSide);
    const riders = units.filter((u) => u.soldiers && u !== veh && u.embarked !== veh);
    if (veh && !veh.soldiers && veh.def.seats && riders.length) {
      for (const u of riders) issue('board', u.id, veh.id);
      log(`Приказ: посадка в ${veh.label}`);
      return;
    }
    // ПКМ по видимому противнику расчётом БПЛА — FPV-удар
    const op = units.find((u) => u.type === 'uav');
    const t = op && enemyAt(cx, cy);
    if (t) { issue('drone', op.id, 'fpv', t.x, t.y, t.id); return; }
  }
  if (direct && !mode) {
    issue('move', ids(units), x, y, false, true);
    log('Приказ: напрямик');
    return;
  }
  if (mode === 'fire') {
    issue('fire', ids(units.filter((u) => u.def.caliber)), x, y, fireOpts.rounds, fireOpts.fuse);
    setOrderMode(null);
    return;
  }
  if (mode === 'recon' || mode === 'fpv' || mode === 'bomber') {
    const op = units.find((u) => u.type === 'uav');
    const t = mode === 'fpv' ? enemyAt(cx, cy) : null;
    issue('drone', op.id, mode, t ? t.x : x, t ? t.y : y, t ? t.id : null);
    setOrderMode(null);
    return;
  }
  if (ui.soldier && !mode) { issue('soldier', ui.soldier.unitId, ui.soldier.idx, x, y); return; }
  const foot = units.filter((u) => u.soldiers);
  const rest = units.filter((u) => !u.soldiers);
  const bld = buildingAtScreen(world, view, cx * dpr, cy * dpr);
  if (mode) setOrderMode(null);
  if (mode === 'move') { issue('move', ids(units), x, y, stealthOrders); return; }
  if (mode === 'basement') {
    let target = bld?.interior?.basement ? bld : null;
    if (!target) {
      let bd = 150;
      for (const b of world.buildings.query({ x0: x - 150, y0: y - 150, x1: x + 150, y1: y + 150 })) {
        if (!b.interior?.basement) continue;
        const d = Math.hypot(b.x - x, b.y - y);
        if (d < bd) { bd = d; target = b; }
      }
    }
    if (!target) { log('Рядом нет подвалов и погребов'); return; }
    for (const u of foot) issue('basement', u.id, bIndex(target));
    log(`Приказ: укрыться (${target.interior.basement.kind})`);
    return;
  }
  if (mode === 'clear') {
    for (const u of foot) issue('clear', u.id, x, y);
    log('Приказ: зачистить траншею');
    return;
  }
  if (bld && foot.length) {
    for (const u of foot) issue('garrison', u.id, bIndex(bld));
    if (rest.length) issue('move', ids(rest), x, y, stealthOrders);
    log(`Приказ: занять здание${bld.interior.floors > 1 ? ` (${bld.interior.floors} эт.)` : ''}`);
    return;
  }
  sim.trenches.ensure();
  const tn = sim.trenches.nearest(x, y, 6, true);
  if (tn >= 0 && foot.length) {
    const it = sim.trenches.nodes[tn].item;
    foot.forEach((u, i) => {
      let tx = x, ty = y;
      if (it?.line && foot.length > 1) {
        const a = it.line[0], b = it.line[it.line.length - 1];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const off = (i - (foot.length - 1) / 2) * 45;
        tx += ((b[0] - a[0]) / L) * off; ty += ((b[1] - a[1]) / L) * off;
      }
      issue('occupy', u.id, tx, ty);
    });
    if (rest.length) issue('move', ids(rest), x, y, stealthOrders);
    log('Приказ: занять траншею');
    return;
  }
  if (mode === 'occupy') { log('Укажите траншею или здание'); return; }
  issue('move', ids(units), x, y, stealthOrders);
}

function setOrderMode(m) {
  if (m === 'dig') dig = { points: [], cursor: null };
  else if (orderMode === 'dig' && m !== 'dig') dig = null;
  orderMode = m;
  if (m === 'dig' && fortView === 'off') cycleFortView();
  canvas.style.cursor = m ? 'crosshair' : 'grab';
  updateCommands();
  updateHint();
}

function finishDig() {
  if (dig && dig.points.length >= 2) {
    const diggers = selectedUnits().filter((u) => u.def.dig);
    if (diggers.length && !dig.test) {
      issue('dig', diggers.map((u) => u.id), dig.points);
      const L = dig.points.reduce((a, p, i) => (i ? a + Math.hypot(p[0] - dig.points[i - 1][0], p[1] - dig.points[i - 1][1]) : 0), 0);
      const rate = diggers.reduce((a, u) => a + u.def.dig, 0);
      log(`Приказ: рыть траншею ${Math.round(L)} м · ~${fmtEta((L / rate) * 3600)}`);
    } else if (role !== 'guest') {
      const seed = digRng.int(0, 2 ** 30);
      const created = digTrench(world, new Rng(seed), dig.points, controlSide, SIDES[controlSide].enemy);
      chunks.worldEvent({ k: 'trench', pts: dig.points, side: controlSide, s: seed });
      for (const c of created) chunks.invalidate(c.bbox);
      sim.trenches.ensure();
      log('Траншея создана мгновенно (тест)');
    }
  }
  setOrderMode(null);
}

// ================= Клавиатура =================
const keys = new Set();
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || !sim) return;
  keys.add(e.code);
  if (e.key === '+' || e.key === '=') zoomAt(innerWidth / 2, innerHeight / 2, 1.25);
  if (e.key === '-') zoomAt(innerWidth / 2, innerHeight / 2, 0.8);
  const c = e.code;
  if (c === 'Escape') {
    if ($('help').classList.contains('show')) toggleHelp(false);
    else if (dwui) dwui.cancel();
    else if (orderMode) setOrderMode(null);
    else if (ui.soldier) { ui.soldier = null; buildCard(); }
    else { ui.selected.clear(); selectionChanged(); }
    return;
  }
  if (c === 'F1') { e.preventDefault(); toggleHelp(); return; }
  if (c === 'Space') { e.preventDefault(); requestSpeed(paused ? timeScale : 0); return; }
  if (c === 'Enter' && orderMode === 'dig') { finishDig(); return; }
  if (c === 'KeyA' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    for (const u of sim.units) if (u.side === controlSide && !u.dead) ui.selected.add(u.id);
    selectionChanged();
    return;
  }
  // Shift+1…7 — вкладки меню «Войны дронов»; M — слой миникарты
  if (dwui && e.shiftKey && /^Digit[1-7]$/.test(c)) { dwui.tabByIndex(+c.slice(5) - 1); return; }
  if (dwui && c === 'KeyM') { cycleMiniLayer(); return; }
  const speedKeys = { Digit1: 0.5, Digit2: 1, Digit3: 2, Digit4: 4, ...(dwui ? { Digit5: 8 } : {}) };
  if (speedKeys[c]) { requestSpeed(speedKeys[c]); return; }
  if (c === 'KeyL') toggleLabels();
  if (c === 'KeyO') cycleFortView();
  if (c === 'KeyI') toggleInterior();
  for (const cmd of COMMANDS) if (cmd.key === c && cmd.when(selectedUnits())) { cmd.run(); return; }
});
addEventListener('keyup', (e) => keys.delete(e.code));

// ================= Панель команд =================
const ICON = {
  move: '<path d="M4 12h14M13 6l6 6-6 6"/>',
  occupy: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  clear: '<path d="M3 12h11M10 7l5 5-5 5M19 5v14"/>',
  basement: '<path d="M3 6h5v4h4v4h4v4h5"/><path d="M17 3v6M14 6l3 3 3-3"/>',
  dig: '<path d="M14 3l7 7M17.5 6.5L9 15M9 15l-5.5 5.5M6 13l5 5"/>',
  fire: '<circle cx="12" cy="12" r="6"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>',
  stealth: '<path d="M3 3l18 18M10.6 5.1A9 9 0 0 1 12 5c5 0 9 4.5 10 7-.5 1.2-1.4 2.6-2.6 3.8M6.2 6.3C4.2 7.7 2.7 9.8 2 12c1 2.5 5 7 10 7 1.7 0 3.3-.5 4.7-1.3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  evac: '<path d="M12 5v14M5 12h14"/><rect x="3" y="3" width="18" height="18" rx="3"/>',
  roe: '<path d="M4 12h8M12 8l4 4-4 4"/><circle cx="19" cy="12" r="2"/>',
  recon: '<circle cx="12" cy="12" r="3"/><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/>',
  fpv: '<path d="M5 5l14 14M19 5L5 19"/><circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/>',
  bomber: '<path d="M12 3v10M8 9l4 4 4-4"/><circle cx="12" cy="18" r="3"/>',
  recall: '<path d="M9 14l-5-5 5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  unload: '<path d="M3 16h13l3-5h2v5"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M9 11V4M6 7l3-3 3 3"/>',
  supply: '<rect x="3" y="8" width="10" height="9" rx="1"/><path d="M13 11h4l3 3v3h-7"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/><path d="M6 5h4"/>',
  auto: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
  stance: '<circle cx="12" cy="5" r="2"/><path d="M12 7v6l-3 7M12 13l3 7M8 10h8"/>',
};
const ROE_NAMES = { free: 'Огонь свободно', return: 'Только в ответ', hold: 'Не стрелять' };
const svg = (p) => `<svg class="i" viewBox="0 0 24 24">${p}</svg>`;
const has = (units, f) => units.some(f);
const idsOf = (us) => us.map((u) => u.id);
// primary — всегда на панели; остальные — под «Ещё»
const inf = (u) => has(u, (q) => q.soldiers);
const COMMANDS = [
  { id: 'unload', label: 'Высадить', key: 'KeyU', icon: 'unload', primary: true, when: (u) => has(u, (q) => q.passengers?.length || q.embarked), run: () => issue('unload', idsOf(selectedUnits())), active: () => false, tip: 'Высадить десант у машины' },
  { id: 'fire', label: 'Огонь', key: 'KeyF', icon: 'fire', primary: true, when: (u) => has(u, (q) => q.def.caliber), run: () => setOrderMode(orderMode === 'fire' ? null : 'fire'), active: () => orderMode === 'fire', tip: 'Артиллерийский огонь по точке' },
  { id: 'recon', label: 'Разведка', key: 'KeyJ', icon: 'recon', primary: true, when: (u) => has(u, (q) => q.type === 'uav'), run: () => setOrderMode(orderMode === 'recon' ? null : 'recon'), active: () => orderMode === 'recon', tip: 'Дрон-разведчик: зависнет над точкой, видит сверху (ночью — тепловизор)' },
  { id: 'fpv', label: 'FPV-удар', key: 'KeyK', icon: 'fpv', primary: true, when: (u) => has(u, (q) => q.type === 'uav'), run: () => setOrderMode(orderMode === 'fpv' ? null : 'fpv'), active: () => orderMode === 'fpv', tip: 'FPV-камикадзе: клик по видимой цели (или просто ПКМ по противнику)' },
  { id: 'bomber', label: 'Сброс', key: 'KeyB', icon: 'bomber', primary: true, when: (u) => has(u, (q) => q.type === 'uav'), run: () => setOrderMode(orderMode === 'bomber' ? null : 'bomber'), active: () => orderMode === 'bomber', tip: 'Дрон-сбросчик: 3 гранаты ВОГ на точку' },
  { id: 'evac', label: 'Эвакуация', key: 'KeyR', icon: 'evac', primary: true, when: (u) => has(u, (q) => q.soldiers?.some((s) => !s.dead && s.wounded === 2)), run: () => issue('evac', idsOf(selectedUnits())), active: () => false, tip: 'Вынести тяжелораненых к санитарке, транспорту или в медпункт' },
  { id: 'dig', label: 'Копать', key: 'KeyT', icon: 'dig', primary: true, when: (u) => has(u, (q) => q.type === 'eng' || q.type === 'btm'), run: () => setOrderMode(orderMode === 'dig' ? null : 'dig'), active: () => orderMode === 'dig', tip: 'Рыть траншею: клики — точки, ПКМ/Enter — копать' },
  { id: 'stealth', label: 'Скрытно', key: 'KeyG', icon: 'stealth', primary: true, when: (u) => u.length > 0, run: () => { stealthOrders = !stealthOrders; updateCommands(); }, active: () => stealthOrders, tip: 'Следующие приказы «идти»: вдоль посадок и балок, избегая открытых мест' },
  { id: 'auto', label: 'Автономно', key: 'KeyH', icon: 'auto', primary: true, when: (u) => u.length > 0, run: () => {
    const on = !(selectedUnits()[0]?.auto !== false);
    issue('auto', idsOf(selectedUnits()), on);
    for (const q of selectedUnits()) { q.auto = on; if (q.cargoRes) q.autoSupply = on; }
    buildCommands();
  }, active: () => selectedUnits()[0]?.auto !== false, tip: 'Сами: укрытие под огнём, смещение по траншее к угрозе, эвакуация раненых, дым и отход подбитой техники, санитарки и снабжение ездят сами' },
  { id: 'stop', label: 'Стоп', key: 'KeyX', icon: 'stop', primary: true, when: (u) => u.length > 0, run: () => issue('stop', idsOf(selectedUnits())), active: () => false, tip: 'Остановиться, отменить задачу и огонь' },
  // --- редкие ---
  { id: 'recall', label: 'Вернуть дроны', key: 'KeyY', icon: 'recall', when: (u) => has(u, (q) => q.type === 'uav'), run: () => issue('recall', idsOf(selectedUnits())), active: () => false, tip: 'Вернуть дроны к оператору' },
  { id: 'clear', label: 'Зачистить', key: 'KeyC', icon: 'clear', when: inf, run: () => setOrderMode(orderMode === 'clear' ? null : 'clear'), active: () => orderMode === 'clear', tip: 'Зачистить траншею до указанной точки' },
  { id: 'basement', label: 'В подвал', key: 'KeyV', icon: 'basement', when: inf, run: () => setOrderMode(orderMode === 'basement' ? null : 'basement'), active: () => orderMode === 'basement', tip: 'Укрыться в подвале / погребе' },
  { id: 'dig2', label: 'Копать', key: 'KeyT', icon: 'dig', when: (u) => inf(u) && !has(u, (q) => q.type === 'eng' || q.type === 'btm'), run: () => setOrderMode(orderMode === 'dig' ? null : 'dig'), active: () => orderMode === 'dig', tip: 'Рыть траншею силами отделения (медленнее сапёров)' },
  { id: 'roe', label: 'Огонь: свободно', key: 'KeyQ', icon: 'roe', when: (u) => has(u, (q) => q.soldiers || ['tank', 'ifv', 'apc'].includes(q.type)), run: () => {
    const us = selectedUnits();
    const order = ['free', 'return', 'hold'];
    const next = order[(order.indexOf(us[0]?.roe || 'free') + 1) % 3];
    issue('roe', idsOf(us), next);
    for (const u of us) u.roe = next;
    buildCommands();
  }, active: () => selectedUnits()[0]?.roe !== 'free', tip: 'Режим огня: свободно / только в ответ / не стрелять' },
  { id: 'stance', label: 'Поза', key: 'KeyZ', icon: 'stance', when: inf, run: () => {
    const cur = currentSoldier()?.stance || selectedUnits().find((u) => u.soldiers)?.soldiers[0]?.stance || 'auto';
    const i = STANCES.findIndex((q) => q.id === cur);
    setStance(STANCES[(i + 1) % STANCES.length].id);
    buildCommands();
  }, active: () => false, tip: 'Поза бойцов: авто → стоя → пригнувшись → лёжа' },
  { id: 'move', label: 'Идти', key: 'KeyM', icon: 'move', when: (u) => u.length > 0, run: () => setOrderMode(orderMode === 'move' ? null : 'move'), active: () => orderMode === 'move', tip: 'Двигаться в точку (то же, что ПКМ по земле)' },
];
const KEYNAME = (code) => code.replace('Key', '').replace('Digit', '');
const STANCES = [
  { id: 'auto', label: 'Авто' },
  { id: 'stand', label: 'Стоя' },
  { id: 'crouch', label: 'Пригнувшись' },
  { id: 'prone', label: 'Лёжа' },
];

function buildCommands() {
  const units = selectedUnits();
  const box = $('cmds');
  box.innerHTML = '';
  const avail = COMMANDS.filter((c) => c.when(units));
  const prim = avail.filter((c) => c.primary);
  const rest = avail.filter((c) => !c.primary);
  const add = (c) => {
    const b = document.createElement('button');
    b.className = 'cmd';
    b.dataset.cmd = c.id;
    b.title = c.tip;
    let label = c.label;
    if (c.id === 'roe') label = ROE_NAMES[units[0]?.roe || 'free'];
    if (c.id === 'stance') label = 'Поза: ' + (STANCES.find((q) => q.id === (currentSoldier()?.stance || units.find((u) => u.soldiers)?.soldiers[0]?.stance || 'auto'))?.label || 'авто').toLowerCase();
    b.innerHTML = `${svg(ICON[c.icon])}<span>${label}</span><kbd>${KEYNAME(c.key)}</kbd>`;
    b.onclick = () => c.run();
    box.appendChild(b);
  };
  for (const c of prim) add(c);
  if (rest.length) {
    if (showMore) for (const c of rest) add(c);
    const m = document.createElement('button');
    m.className = 'cmd more';
    m.title = 'Редкие приказы';
    m.innerHTML = `${svg(showMore ? '<path d="M6 15l6-6 6 6"/>' : '<path d="M6 9l6 6 6-6"/>')}<span>${showMore ? 'Скрыть' : 'Ещё'}</span>`;
    m.onclick = () => { showMore = !showMore; buildCommands(); };
    box.appendChild(m);
  }
  const opts = $('opts');
  opts.innerHTML = '';
  if (units.some((u) => u.def.caliber)) {
    const r = document.createElement('div');
    r.className = 'seg';
    r.innerHTML = '<span>Выстрелов</span>';
    for (const n of [1, 3, 6, 10]) {
      const b = document.createElement('button');
      b.dataset.rounds = n;
      b.textContent = n;
      b.onclick = () => { fireOpts.rounds = n; updateCommands(); };
      r.appendChild(b);
    }
    opts.appendChild(r);
    const f = document.createElement('div');
    f.className = 'seg';
    f.innerHTML = '<span>Взрыватель</span>';
    for (const [id, name] of [['ground', 'Контакт'], ['air', 'Воздушный подрыв']]) {
      const b = document.createElement('button');
      b.dataset.fuse = id;
      b.textContent = name;
      b.onclick = () => { fireOpts.fuse = id; updateCommands(); };
      f.appendChild(b);
    }
    opts.appendChild(f);
  }
  const op = units.find((u) => u.type === 'uav');
  if (op) {
    const left = op.dronesLeft || op.def.drones;
    const d = document.createElement('div');
    d.className = 'seg';
    d.innerHTML = `<span>Дроны</span><span style="min-width:0;color:var(--text)">разведчиков ${left.recon} · FPV ${left.fpv} · сбросчиков ${left.bomber}</span>`;
    opts.appendChild(d);
  }
  const sup = document.createElement('div');
  sup.className = 'supply';
  sup.id = 'supply';
  opts.appendChild(sup);
  const pass = document.createElement('div');
  pass.className = 'pass';
  pass.id = 'pass';
  opts.appendChild(pass);
  updateCommands();
}

function updateCommands() {
  for (const b of document.querySelectorAll('#cmds .cmd')) {
    const c = COMMANDS.find((q) => q.id === b.dataset.cmd);
    b.classList.toggle('active', !!c?.active());
  }
  const units = selectedUnits();
  const sd = currentSoldier();
  const cur = sd ? sd.stance : units.find((u) => u.soldiers)?.soldiers.find((q) => !q.dead)?.stance;
  for (const b of document.querySelectorAll('[data-stance]')) b.classList.toggle('active', b.dataset.stance === cur);
  for (const b of document.querySelectorAll('[data-rounds]')) b.classList.toggle('active', Number(b.dataset.rounds) === fireOpts.rounds);
  for (const b of document.querySelectorAll('[data-fuse]')) b.classList.toggle('active', b.dataset.fuse === fireOpts.fuse);
}

function setStance(st) {
  const sd = currentSoldier();
  if (sd) issue('stance', ui.soldier.unitId, st, ui.soldier.idx);
  else for (const u of selectedUnits()) issue('stance', u.id, st, null);
  // Сразу показываем в интерфейсе (гостю — до следующего снимка)
  if (sd) sd.stance = st; else for (const u of selectedUnits()) if (u.soldiers) for (const s of u.soldiers) s.stance = st;
  updateCommands();
}

const currentSoldier = () => (ui.soldier ? sim.units.find((q) => q.id === ui.soldier.unitId)?.soldiers[ui.soldier.idx] : null);

// ================= Карточка выбранного =================
const STATE_TEXT = { idle: 'на месте', planning: 'прокладывает маршрут', moving: 'в движении' };
const TASK_TEXT = { occupy: 'занимает позицию', clear: 'зачищает траншею', dig: 'роет траншею', manual: 'ручное управление', garrison: 'занимает здание', basement: 'уходит в укрытие' };

function selectionChanged() {
  if (ui.soldier && !ui.selected.has(ui.soldier.unitId)) ui.soldier = null;
  buildCard();
  updateRoster();
}

function buildCard() {
  const units = selectedUnits();
  const card = $('card');
  card.classList.toggle('show', units.length > 0);
  if (!units.length) return;
  const sc = $('card-sym').getContext('2d');
  sc.clearRect(0, 0, 120, 84);
  drawSymbol(sc, 60, 42, 40, units[0].side, units[0].def.symbol);
  const one = units.length === 1 ? units[0] : null;
  $('card-title').textContent = one ? one.label : `Группа: ${units.length}`;
  if (one) $('card-sub').textContent = one.def.name;
  else {
    const cnt = {};
    for (const u of units) cnt[u.def.short] = (cnt[u.def.short] || 0) + 1;
    $('card-sub').textContent = Object.entries(cnt).map(([k, v]) => `${k} ×${v}`).join(' · ');
  }
  const box = $('soldiers');
  box.innerHTML = '';
  if (one?.soldiers) {
    for (const s of one.soldiers) {
      const c = document.createElement('div');
      c.className = 'chip';
      c.dataset.sid = s.idx;
      c.innerHTML = `<b>${s.idx + 1}. ${s.role}</b><small></small><div class="bar"><i></i></div>`;
      c.onclick = () => { ui.soldier = ui.soldier && ui.soldier.idx === s.idx ? null : { unitId: one.id, idx: s.idx }; buildCard(); };
      c.ondblclick = () => focus(s.x, s.y, 6 * dpr);
      box.appendChild(c);
    }
  }
  buildCommands();
  updateCard();
}

function updateCard() {
  const units = selectedUnits();
  if (!units.length) { $('card').classList.remove('show'); return; }
  const one = units.length === 1 ? units[0] : null;
  const stats = [];
  if (one) {
    if (one.soldiers) {
      const alive = one.soldiers.filter((s) => !s.dead);
      const w = alive.filter((s) => s.wounded).length;
      const ev = one.soldiers.filter((s) => s.evac).length;
      stats.push(`Личный состав <b>${alive.length}/${one.soldiers.length}</b>${w ? ` · ранено <b>${w}</b>` : ''}${ev ? ` · эвакуировано ${ev}` : ''}`);
      const supp = alive.reduce((a, s) => a + s.supp, 0) / Math.max(1, alive.length);
      if (supp > 3) stats.push('<b style="color:var(--bad)">под огнём</b>');
    } else {
      stats.push(`Состояние <b>${Math.round((one.hp ?? 1) * 100)}%</b>${one.cargo ? ` · раненых на борту <b>${one.cargo}</b>` : ''}`);
      const vs = vehicleStatus(one);
      if (vs) stats.push(`<b style="color:var(--bad)">${vs}</b>`);
    }
    if (one.def.caliber) stats.push(`Боезапас <b>${one.ammo}/${one.def.ammo}</b> · ${CALIBERS[one.def.caliber].name}`);
    stats.push(`${STATE_TEXT[one.state] || ''} · ${T_NAMES[sim.nav.classAt(one.x, one.y)]}`);
    if (one.state === 'moving' && one.mode === 'field' && one.speed) stats.push(`${(one.speed * 3.6).toFixed(0)} км/ч${one.eta ? ` · прибытие ~${fmtEta(one.eta)}` : ''}`);
  } else {
    const men = units.reduce((a, u) => a + (u.soldiers ? u.soldiers.filter((s) => !s.dead).length : 0), 0);
    stats.push(`Подразделений <b>${units.length}</b>`);
    if (men) stats.push(`Бойцов <b>${men}</b>`);
  }
  $('card-stats').innerHTML = stats.map((s) => `<span>${s}</span>`).join('');
  let task = '';
  if (one) {
    if (one.fire) task = `Ведёт огонь${one.fire.rounds ? `: осталось ${one.fire.rounds} выстр.` : ''}${one.fire.next && sim.time < one.fire.next ? ` · готовность через ${Math.ceil(one.fire.next - sim.time)} с` : ''}`;
    else if (one.task) {
      task = `Задача: ${TASK_TEXT[one.task.type] || one.task.type}`;
      if (one.task.type === 'dig' && one.task.job) task += ` · ${Math.round((one.task.job.done / one.task.job.total) * 100)}%`;
      if (one.task.type === 'clear' && one.task.line) task += ` · ${Math.round((one.task.progress / Math.max(1, one.task.line.length - 1)) * 100)}%`;
    } else if (one.mode === 'trench') task = 'Бойцы действуют по отдельности (траншея / здание)';
    if (one.pending) task += ' · выдвигается к месту';
    if (one.noRoute && sim.time - one.noRoute < 30) task += ' · нет маршрута!';
    if (one.roe && one.roe !== 'free') task += ` · ${ROE_NAMES[one.roe].toLowerCase()}`;
  }
  const sd = currentSoldier();
  if (sd) {
    const where = sd.under ? 'в укрытии под землёй' : sd.building ? 'в здании' : sim.trenches.nearest(sd.x, sd.y, 1.5) >= 0 ? 'в траншее' : 'на открытой местности';
    task = `Выбран боец: ${sd.role} · ${sd.dead ? (sd.evac ? 'эвакуирован' : 'погиб') : `${POSES[sd.pose]?.name || ''} · ${where}`} — ПКМ: куда идти`;
  }
  $('task').textContent = task;
  updateSupply(units, one);
  if (one?.soldiers) {
    for (const c of document.querySelectorAll('#soldiers .chip')) {
      const s = one.soldiers[Number(c.dataset.sid)];
      if (!s) continue;
      c.classList.toggle('active', !!ui.soldier && ui.soldier.idx === s.idx);
      c.classList.toggle('dead', s.dead);
      const wt = woundText(s);
      c.querySelector('small').textContent = s.evac ? 'эвакуирован' : s.dead ? 'погиб' : `${s.wounded === 2 ? 'тяжело · ' : ''}${wt ? wt + ' · ' : ''}${s.supp > 4 ? 'подавлен · ' : ''}${POSES[s.pose]?.name || ''}`;
      const bar = c.querySelector('.bar > i');
      bar.style.width = `${s.hp}%`;
      bar.style.background = s.hp > 70 ? 'var(--ok)' : s.hp > 30 ? 'var(--warn)' : 'var(--bad)';
    }
  }
  updateCommands();
}
$('card-close').onclick = () => { ui.selected.clear(); selectionChanged(); };

// Снабжение и десант в карточке
function updateSupply(units, one) {
  const box = $('supply'), pass = $('pass');
  if (!box) return;
  const bar = (name, v) => `<span class="it">${name}<span class="bar"><i style="width:${Math.round(Math.max(0, Math.min(1, v)) * 100)}%;background:${v > 0.5 ? 'var(--ok)' : v > 0.2 ? 'var(--warn)' : 'var(--bad)'}"></i></span></span>`;
  const items = [];
  const list = one ? [one] : units;
  const al = list.flatMap((u) => (u.soldiers || []).filter((q) => !q.dead && !q.evac));
  if (al.length) items.push(bar('Патроны', al.reduce((a, q) => a + (q.mag ?? 1), 0) / al.length));
  const veh = list.filter((u) => u.fuel !== undefined && !u.dead);
  const rd = veh.filter((u) => u.rounds !== undefined);
  if (rd.length) items.push(bar('Боекомплект', rd.reduce((a, u) => a + u.rounds, 0) / rd.length));
  if (veh.length) items.push(bar('Топливо', veh.reduce((a, u) => a + u.fuel, 0) / veh.length));
  const guns = list.filter((u) => u.def.caliber);
  if (guns.length) items.push(bar('Выстрелы', guns.reduce((a, u) => a + u.ammo / u.def.ammo, 0) / guns.length));
  if (one?.cargoRes) items.push(`<span class="it">Груз: ${RES.map((r) => `${RES_NAMES[r]} <b>${Math.round(one.cargoRes[r])}</b>`).join(' · ')}</span>`);
  box.innerHTML = items.join('');
  let p = '';
  if (one?.passengers?.length) p = `Десант: ${one.passengers.map((q) => `<b>${q.label}</b>`).join(', ')} · свободно мест ${sim.seatsFree(one)}`;
  else if (one?.def.seats) p = `Мест для десанта: ${sim.seatsFree(one)} — ПКМ пехотой по машине, чтобы посадить`;
  if (one?.embarked) p = `Едет в машине: <b>${one.embarked.label}</b> — любой приказ «идти» спешит отделение`;
  if (one?.cargoRes && one.autoSupply && one.supplyTask) p += `${p ? ' · ' : ''}Автоснабжение: ${one.supplyTask}`;
  pass.innerHTML = p;
}

// ================= Резерв =================
let rosterTab = 'units';
function showTab(t) {
  rosterTab = t;
  $('tab-units').classList.toggle('active', t === 'units');
  $('tab-reserve').classList.toggle('active', t === 'reserve');
  $('roster-list').style.display = t === 'units' ? '' : 'none';
  $('reserve-list').style.display = t === 'reserve' ? '' : 'none';
  if (t === 'reserve') buildReserve();
}
$('tab-units').onclick = () => showTab('units');
$('tab-reserve').onclick = () => showTab('reserve');
const RES_GROUPS = [['Пехота', ['inf', 'eng', 'atgm']], ['Бронетехника', ['tank', 'ifv', 'apc', 'armcar', 'btm']], ['Огневая поддержка', ['mortar', 'arty', 'spg', 'mlrs', 'sam', 'uav']], ['Тыл', ['truck', 'fuel', 'medevac']]];
function buildReserve() {
  const r = sim?.game?.reserve?.[controlSide];
  const box = $('reserve-list');
  if (!r) return;
  box.innerHTML = '';
  const info = document.createElement('div');
  info.className = 'res-info';
  info.id = 'res-info';
  box.appendChild(info);
  {
    const h = document.createElement('div');
    h.className = 'group-title';
    h.textContent = 'Тыл — поставить на карте';
    box.appendChild(h);
    for (const [kind, F] of Object.entries(FACILITIES)) {
      const row = document.createElement('div');
      row.className = 'res-row';
      row.dataset.build = kind;
      row.innerHTML = `<div style="font:700 20px 'PT Sans';text-align:center;color:${kind === 'medpoint' ? '#ff6b6b' : 'var(--accent-2)'}">${kind === 'medpoint' ? '✚' : '▦'}</div><div><div class="nm">${F.name}</div><div class="ds">${kind === 'depot' ? 'снабжает всех рядом, грузовики берут груз' : 'сюда везут раненых'}</div></div><div class="cs">${F.cost}</div>`;
      row.title = 'Выбрать место на карте: своя территория, рядом с дорогой';
      row.onclick = () => setOrderMode(orderMode === 'build:' + kind ? null : 'build:' + kind);
      box.appendChild(row);
    }
  }
  for (const [name, types] of RES_GROUPS) {
    const ts = types.filter((t) => UNIT_TYPES[t] && r.avail[t] !== undefined);
    if (!ts.length) continue;
    const h = document.createElement('div');
    h.className = 'group-title';
    h.textContent = name;
    box.appendChild(h);
    for (const t of ts) {
      const d = unitDef(t, controlSide);
      const row = document.createElement('div');
      row.className = 'res-row';
      row.dataset.type = t;
      const c = document.createElement('canvas');
      c.width = 68; c.height = 48;
      drawSymbol(c.getContext('2d'), 34, 24, 26, controlSide, d.symbol);
      row.appendChild(c);
      const mid = document.createElement('div');
      mid.innerHTML = `<div class="nm">${d.name}</div><div class="ds"></div>`;
      row.appendChild(mid);
      const cs = document.createElement('div');
      cs.className = 'cs';
      cs.textContent = COST[t];
      row.appendChild(cs);
      row.title = 'Заказать: прибудет на пункт сбора';
      row.onclick = () => { issue('spawn', controlSide, t); setTimeout(updateReserve, 50); };
      box.appendChild(row);
    }
  }
  const q = document.createElement('div');
  q.id = 'res-queue';
  box.appendChild(q);
  updateReserve();
}
function updateReserve() {
  const r = sim?.game?.reserve?.[controlSide];
  if (!r) return;
  $('res-pts').textContent = Math.floor(r.points);
  if (rosterTab !== 'reserve') return;
  const info = $('res-info');
  if (info) info.innerHTML = `Очки подкрепления: <b>${Math.floor(r.points)}</b> (+${INCOME}/мин). Нажмите на подразделение — оно прибудет на <b>пункт сбора</b> (флаг на карте)${sim.game.prep ? ', во время подготовки — почти сразу' : ''}.`;
  for (const row of document.querySelectorAll('#reserve-list .res-row[data-build]')) {
    const kind = row.dataset.build, F = FACILITIES[kind];
    const n = sim.build.list(controlSide, kind).length;
    row.classList.toggle('off', r.points < F.cost || n >= F.max);
    row.classList.toggle('sel', orderMode === 'build:' + kind);
    row.querySelector('.ds').textContent = `${kind === 'depot' ? 'снабжает всех рядом' : 'сюда везут раненых'} · построено ${n}/${F.max}`;
  }
  for (const row of document.querySelectorAll('#reserve-list .res-row[data-type]')) {
    const t = row.dataset.type;
    const n = r.avail[t] ?? 0;
    row.classList.toggle('off', !r.canOrder(t));
    row.querySelector('.ds').textContent = n > 0 ? `осталось ${n}${r.points < COST[t] ? ' · не хватает очков' : ''}` : 'исчерпано';
  }
  const q = $('res-queue');
  if (q) q.innerHTML = r.queue.length ? '<div class="group-title">В пути</div>' + r.queue.map((it) => `<div class="res-q">${unitDef(it.type, controlSide).name} · ${Math.max(0, Math.ceil(it.at - sim.time))} с</div>`).join('') : '';
}

// ================= Список подразделений =================
const GROUPS = [
  ['Пехота', ['inf', 'atgm']], ['Инженеры', ['eng', 'btm']], ['Бронетехника', ['tank', 'ifv', 'apc', 'armcar']],
  ['Артиллерия', ['mortar', 'arty', 'spg', 'mlrs']], ['ПВО и дроны', ['sam', 'uav']], ['Тыл', ['truck', 'fuel', 'medevac']],
];
function buildRoster() {
  const list = $('roster-list');
  list.innerHTML = '';
  const own = sim.units.filter((u) => u.side === controlSide);
  for (const [name, types] of GROUPS) {
    const us = own.filter((u) => types.includes(u.type));
    if (!us.length) continue;
    const t = document.createElement('div');
    t.className = 'group-title';
    t.textContent = name;
    list.appendChild(t);
    for (const u of us) {
      const r = document.createElement('div');
      r.className = 'r-row';
      r.dataset.id = u.id;
      const c = document.createElement('canvas');
      c.width = 68; c.height = 48;
      drawSymbol(c.getContext('2d'), 34, 24, 26, u.side, u.def.symbol);
      r.appendChild(c);
      const mid = document.createElement('div');
      mid.innerHTML = `<div class="r-name">${u.label}</div><div class="r-state"></div>`;
      r.appendChild(mid);
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.innerHTML = '<i></i>';
      r.appendChild(bar);
      r.onclick = (e) => {
        if (u.dead) return;
        ui.soldier = null;
        if (e.ctrlKey || e.metaKey || e.shiftKey) ui.selected.has(u.id) ? ui.selected.delete(u.id) : ui.selected.add(u.id);
        else { ui.selected.clear(); ui.selected.add(u.id); }
        selectionChanged();
      };
      r.ondblclick = () => focus(u.x, u.y, 2 * dpr);
      list.appendChild(r);
    }
  }
}

function updateRoster() {
  for (const r of document.querySelectorAll('#roster-list .r-row')) {
    const u = sim.units.find((q) => q.id === Number(r.dataset.id));
    if (!u) continue;
    r.classList.toggle('sel', ui.selected.has(u.id));
    r.classList.toggle('dead', u.dead);
    let st;
    if (u.dead) st = 'уничтожено';
    else if (u.embarked) st = `в машине: ${u.embarked.label}`;
    else if (u.fire) st = `огонь · ${u.ammo} выстр.`;
    else if (u.task) st = TASK_TEXT[u.task.type] || '';
    else if (u.soldiers && u.soldiers.some((s) => !s.dead && s.supp > 4)) st = 'под огнём';
    else if (u.mode === 'trench') st = 'на позиции';
    else st = STATE_TEXT[u.state];
    if (u.soldiers && u.soldiers.some((s) => !s.dead && s.wounded === 2)) st += ' · раненые';
    if (!u.dead) {
      const lv = sim.log.level(u);
      if (lv < 0.25) st += lv <= 0.02 ? ' · нет припасов!' : ' · мало припасов';
    }
    if (u.passengers?.length) st += ` · десант ${u.passengers.length}`;
    r.querySelector('.r-state').textContent = st;
    const val = u.dead ? 0 : u.soldiers ? u.soldiers.filter((q) => !q.dead).length / u.soldiers.length : u.hp ?? 1;
    const bar = r.querySelector('.bar > i');
    bar.style.width = `${Math.max(0, val) * 100}%`;
    bar.style.background = val > 0.66 ? 'var(--ok)' : val > 0.33 ? 'var(--warn)' : 'var(--bad)';
  }
}
$('roster-toggle').onclick = () => {
  const r = $('roster');
  r.classList.toggle('collapsed');
  $('roster-toggle').textContent = r.classList.contains('collapsed') ? '+' : '–';
};

// ================= Журнал =================
// Место события: объект или позиция ПВО, чьё имя упомянуто в сообщении (самое длинное совпадение)
function eventPlace(text) {
  const g = sim?.game;
  if (!g || g.mode !== 'drones') return null;
  let best = null, bl = 0;
  for (const o of g.objects) if (o.name && o.name.length > bl && text.includes(o.name) && (o.side === controlSide || g.known(controlSide, o))) { best = o; bl = o.name.length; }
  for (const a of g.ad) if (a.side === controlSide && a.name.length > bl && text.includes(a.name)) { best = a; bl = a.name.length; }
  return best ? [best.x, best.y] : null;
}
function log(text) {
  const box = $('log');
  const ev = document.createElement('div');
  ev.className = 'ev' + (/убит|уничтож|обруш|погиб|умер|тяжело ранен|обесточ|Перебита|Потеряна/.test(text) ? ' loss' : '');
  ev.innerHTML = `<time>${sim ? fmtClock(sim.tod()) : ''}</time><span></span>`;
  ev.querySelector('span').textContent = text;
  const at = eventPlace(text);
  if (at) { ev.classList.add('go'); ev.title = 'Показать на карте'; ev.onclick = () => { cam.x = at[0]; cam.y = at[1]; cam.zoom = Math.max(cam.zoom, 0.4 * dpr); clampCam(); }; }
  box.prepend(ev);
  while (box.children.length > 9) box.lastChild.remove();
  [...box.children].forEach((c, i) => c.classList.toggle('old', i > 3));
}

// ================= Подсказка у курсора =================
function updateHint() {
  const h = $('hint');
  if (!mouse || !sim) { h.style.display = 'none'; return; }
  const [x, y] = screenToWorld(mouse[0], mouse[1]);
  const units = selectedUnits();
  let text = '';
  if (dwui) text = dwui.hint(mouse[0], mouse[1]) || '';
  else
  if (orderMode === 'fire') {
    const g = units.find((u) => u.def.caliber);
    if (g) {
      const cal = CALIBERS[g.def.caliber];
      const d = Math.hypot(x - g.x, y - g.y);
      const ok = d >= cal.minR && d <= cal.maxR;
      text = ok ? `<b>Огонь</b> · ${(d / 1000).toFixed(2)} км · рассеяние ±${Math.round(cal.sigma * d * 2)} м · ${fireOpts.rounds} выстр. · ${fireOpts.fuse === 'air' ? 'воздушный подрыв' : 'контакт'}`
        : `<b>Вне досягаемости</b> · ${(d / 1000).toFixed(2)} км (можно ${cal.minR}–${cal.maxR} м)`;
    }
  } else if (orderMode === 'dig') {
    const pts = dig.points.length ? [...dig.points, [x, y]] : [];
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    text = dig.points.length ? `<b>Траншея</b> ${Math.round(L)} м · ЛКМ — ещё точка · ПКМ/Enter — копать` : '<b>Траншея</b>: кликните начало';
  } else if (orderMode === 'fpv') {
    const t = enemyAt(mouse[0], mouse[1]);
    text = t ? `<b>FPV-удар</b> по цели: ${t.def.short}` : '<b>FPV-удар</b>: кликните видимую цель или точку';
  } else if (orderMode === 'recon') text = '<b>Разведка</b>: точка для зависания дрона';
  else if (orderMode === 'bomber') text = '<b>Сброс</b>: точка сброса 3 гранат';
  else if (orderMode === 'clear') text = '<b>Зачистить</b>: укажите точку на траншее';
  else if (orderMode === 'basement') text = '<b>В подвал</b>: укажите здание (или рядом)';
  else if (orderMode === 'occupy') text = '<b>Занять</b>: траншею или здание';
  else if (orderMode === 'move') text = '<b>Идти</b>: укажите точку';
  else if (orderMode === 'strike') text = '<b>Удар 152 мм (тест)</b>: клик — разрыв';
  else if (orderMode?.startsWith('build:')) {
    const kind = orderMode.slice(6);
    const err = sim.build.check(controlSide, kind, x, y);
    text = err ? `<b>${FACILITIES[kind].name}</b>: ${err}` : `<b>${FACILITIES[kind].name}</b> · ${FACILITIES[kind].cost} очков · ЛКМ — поставить, ПКМ — отмена`;
  }
  else if (units.length && !ui.soldier) {
    const v = pickUnit(sim, view, mouse[0] * dpr, mouse[1] * dpr, controlSide);
    const riders = units.filter((u) => u.soldiers && u !== v && u.embarked !== v);
    if (v && !v.soldiers && v.def.seats && riders.length) text = `ПКМ — <b>посадка</b> в ${v.label} · свободно мест ${sim.seatsFree(v)}`;
    else if (units.some((u) => u.type === 'uav') && enemyAt(mouse[0], mouse[1])) text = 'ПКМ — <b>FPV-удар</b> по цели';
  }
  if (!text && !orderMode && units.some((u) => u.soldiers)) {
    const b = buildingAtScreen(world, view, mouse[0] * dpr, mouse[1] * dpr);
    if (b) text = `ПКМ — <b>занять здание</b>${b.interior.floors > 1 ? ` · ${b.interior.floors} эт.` : ''}${b.interior.basement ? ` · ${b.interior.basement.kind}` : ''}`;
    else if (sim.trenches.nearest(x, y, 6, true) >= 0) text = 'ПКМ — <b>занять траншею</b>';
  }
  if (!text) { h.style.display = 'none'; return; }
  h.innerHTML = text;
  h.style.display = 'block';
  h.style.left = `${mouse[0] + 16}px`;
  h.style.top = `${mouse[1] + 18}px`;
}

// ================= Верхняя панель =================
function setSpeed(v) {
  if (v === 0) paused = true;
  else { paused = false; timeScale = v; }
  for (const b of document.querySelectorAll('[data-speed]')) b.classList.toggle('active', paused ? b.dataset.speed === '0' : Number(b.dataset.speed) === timeScale);
}
for (const b of document.querySelectorAll('[data-speed]')) b.onclick = () => requestSpeed(Number(b.dataset.speed));
// Скорость в сетевой игре: каждый игрок просит свою, идёт наименьшая из двух (пауза — если кто-то на паузе).
// Считает только хост, гость лишь показывает снимки — синхронизация не ломается.
const mpSpeed = { host: 1, guest: 1, eff: 1 };
function mpApply() {
  mpSpeed.eff = Math.min(mpSpeed.host, mpSpeed.guest);
  if (mpSpeed.eff === 0) paused = true; else { paused = false; timeScale = mpSpeed.eff; }
  for (const b of document.querySelectorAll('[data-speed]')) { const v = Number(b.dataset.speed); b.classList.toggle('active', v === mpSpeed[role === 'guest' ? 'guest' : 'host']); b.classList.toggle('eff', v === mpSpeed.eff); }
  const other = role === 'guest' ? mpSpeed.host : mpSpeed.guest;
  const el = $('mp-speed'); if (el) { el.textContent = `соп. ${other ? other + '×' : '❚❚'}`; el.title = `Идёт ${mpSpeed.eff ? mpSpeed.eff + '×' : 'пауза'}: скорость — меньшая из выбранных вами и соперником, пауза — если кто-то нажал паузу`; }
}
function requestSpeed(v) {
  if (!cfg?.multiplayer) { setSpeed(v); return; }
  issue('speed', role === 'guest' ? 'guest' : 'host', v);
  if (role === 'guest') { mpSpeed.guest = v; mpApply(); }
}
setSpeed(timeScale);

function toggleLabels() { showLabels = !showLabels; $('btn-labels').classList.toggle('active', showLabels); }
function cycleFortView() {
  fortView = FORT_VIEWS[(FORT_VIEWS.indexOf(fortView) + 1) % FORT_VIEWS.length];
  ui.underground = fortView === 'underground';
  $('forts-lbl').textContent = fortView === 'off' ? 'Окопы' : FORT_VIEW_NAMES[fortView];
  $('btn-forts').classList.toggle('active', fortView !== 'off');
}
function toggleInterior() { interiorsForce = !interiorsForce; $('btn-interior').classList.toggle('active', interiorsForce); }
function toggleHelp(v) { $('help').classList.toggle('show', v ?? !$('help').classList.contains('show')); }
const closeMenu = () => $('menu').classList.remove('open');
$('btn-labels').onclick = toggleLabels;
$('btn-forts').onclick = cycleFortView;
$('btn-interior').onclick = toggleInterior;
$('btn-help').onclick = () => toggleHelp();
$('help-close').onclick = () => toggleHelp(false);
$('help').onclick = (e) => { if (e.target.id === 'help') toggleHelp(false); };
$('btn-menu').onclick = (e) => { e.stopPropagation(); $('menu').classList.toggle('open'); };
$('btn-strike').onclick = () => { closeMenu(); if (!cfg?.multiplayer) setOrderMode('strike'); };
$('btn-dig-test').onclick = () => { closeMenu(); if (cfg?.multiplayer) return; setOrderMode('dig'); dig.test = true; };
$('btn-new').onclick = () => { location.reload(); };
$('side-badge').onclick = () => {};
$('btn-ready').onclick = () => { issue('ready', controlSide); if (sim?.game) sim.game.ready[controlSide] = true; updateScoreboard(); };
$('end-menu').onclick = () => { location.reload(); };

// Табло: режим, очки/территория, оставшееся время, время суток
function updateScoreboard() {
  const g = sim.game;
  if (!g) return;
  const left = (g.endless ? sim.time - (g.startAt ?? sim.time) : Math.max(0, g.endAt - sim.time)) / (sim.pace || 1); // в реальных секундах
  const pb = $('prep-bar');
  pb.classList.toggle('show', !!g.prep);
  if (g.prep) {
    const pl = Math.max(0, g.prepEnd - sim.time) / (sim.pace || 1);
    $('prep-time').textContent = `${Math.floor(pl / 60)}:${String(Math.floor(pl % 60)).padStart(2, '0')}`;
    const rd = g.ready[controlSide];
    $('btn-ready').textContent = rd ? 'ЖДЁМ СОПЕРНИКА…' : 'К БОЮ ▶';
    $('btn-ready').disabled = rd;
  }
  const light = daylight(sim.tod());
  const sun = light > 0.6 ? '☀' : light > 0.1 ? '◐' : '☾';
  let mid = '';
  if (g.mode === 'drones') {
    const S = g.sides[controlSide], E = g.sides[controlSide === 'blue' ? 'red' : 'blue'];
    const col = (v) => (v > 0.8 ? 'var(--ok)' : v > 0.4 ? '#f0c34a' : 'var(--bad)');
    const mc = (v) => (v > 60 ? 'var(--ok)' : v > 30 ? '#f0c34a' : 'var(--bad)');
    mid = `<span class="m" title="Устойчивость тыла: ваша : противника">тыл</span> <b style="color:${mc(S.morale ?? 100)}">${Math.round(S.morale ?? 100)}</b><span class="m">:</span><span style="color:${mc(E.morale ?? 100)}">${Math.round(E.morale ?? 100)}</span> <span class="m">· свет</span> <span style="color:${col(S.supply)}">${(S.supply * 100).toFixed(0)}%</span> <span class="m">·</span> <b>${Math.floor(S.points)}</b> <span class="m">оч (+${(S.income * (sim.pace || 1)).toFixed(0)}/мин)${g.prep ? '' : ` · фаза ${(g.phaseNo || 0) + 1}`}</span>`;
  } else if (g.mode === 'zones') mid = `<span class="b">${Math.floor(g.score.blue)}</span> : <span class="r">${Math.floor(g.score.red)}</span> <span class="m">/ 500</span>`;
  else if (g.mode === 'assault') { const att = g.cfg.attacker; mid = `<span class="m">прорвано линий</span> <span class="${att === 'blue' ? 'b' : 'r'}">${g.linesTaken || 0}/4</span>`; }
  else {
    const t = g.territory(), i = g.initTerr || t;
    const d = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
    mid = `<span class="b">${d(t.blue - i.blue)}</span> : <span class="r">${d(t.red - i.red)}</span> <span class="m">продвижение</span>`;
  }
  const clock = left >= 3600 ? `${Math.floor(left / 3600)}:${String(Math.floor((left % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(left % 60)).padStart(2, '0')}` : `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
  $('scoreboard').innerHTML = `${mid} <span class="m" title="${g.endless ? 'Идёт партия (без ограничения по времени)' : 'До конца партии'}">· ${g.endless ? '⏱ ' : ''}${clock}</span> <span title="Время суток">${sun}</span>`;
  if (g.winner && !$('end-screen').classList.contains('show')) showEnd();
}

function showEnd() {
  const g = sim.game;
  const win = g.winner === controlSide;
  $('end-title').textContent = g.winner === 'draw' ? 'Ничья' : win ? 'Победа' : 'Поражение';
  $('end-title').style.color = g.winner === 'draw' ? 'var(--text)' : win ? 'var(--ok)' : 'var(--bad)';
  $('end-reason').textContent = `${g.winner === 'draw' ? '' : FACTIONS[g.winner].country + ': '}${g.reason}`;
  const row = (side) => {
    const us = sim.units.filter((u) => u.side === side);
    const sol = us.flatMap((u) => u.soldiers || []);
    return `<tr><td style="color:${FACTIONS[side].fill}">${FACTIONS[side].short}</td><td>погибло ${sol.filter((s) => s.dead && !s.evac).length}</td><td>эвакуировано ${sol.filter((s) => s.evac).length + (sim.stats[side].evac || 0)}</td><td>потеряно техники ${us.filter((u) => !u.soldiers && u.dead).length}</td></tr>`;
  };
  if (g.mode === 'drones') {
    const r2 = (side) => { const S = g.sides[side]; return `<tr><td style="color:${FACTIONS[side].fill}">${FACTIONS[side].short}</td><td>устойчивость тыла ${Math.round(S.morale ?? 0)}</td><td>пущено ${S.stats.launched}, попаданий ${S.stats.hits}</td><td>сбито чужих ${S.stats.shot}</td><td>ремонтов ${S.stats.repairs}, потеряно ПВО ${S.stats.lostAD}</td></tr>`; };
    $('end-stats').innerHTML = r2('blue') + r2('red');
    drawEndChart(g);
  } else $('end-stats').innerHTML = row('blue') + row('red');
  $('end-screen').classList.add('show');
  paused = true;
}

// Графики партии на итоговом экране: устойчивость тыла и доля света по времени (обе стороны)
function drawEndChart(g) {
  const cv = $('end-chart'); if (!cv || !g.state) return;
  const H = { blue: g.state.side.blue.hist, red: g.state.side.red.hist };
  const n = Math.max(H.blue.length, H.red.length);
  cv.style.display = n > 1 ? 'block' : 'none';
  if (n < 2) return;
  const c = cv.getContext('2d'), W = (cv.width = 520), Ht = (cv.height = 170);
  c.fillStyle = 'rgba(255,255,255,0.04)'; c.fillRect(0, 0, W, Ht);
  c.strokeStyle = 'rgba(255,255,255,0.12)'; c.lineWidth = 1;
  for (const v of [25, 50, 75]) { const y = 10 + (1 - v / 100) * (Ht - 30); c.beginPath(); c.moveTo(30, y); c.lineTo(W - 6, y); c.stroke(); }
  c.fillStyle = 'rgba(230,230,220,0.6)'; c.font = '11px sans-serif'; c.fillText('100', 4, 14); c.fillText('0', 14, Ht - 18);
  const plot = (arr, k, col, dash) => { c.strokeStyle = col; c.lineWidth = 2; c.setLineDash(dash); c.beginPath(); arr.forEach((q, i) => { const x = 30 + (i / (n - 1)) * (W - 36), y = 10 + (1 - q[k] / 100) * (Ht - 30); if (i) c.lineTo(x, y); else c.moveTo(x, y); }); c.stroke(); c.setLineDash([]); };
  plot(H.blue, 1, FACTIONS.blue.fill, []); plot(H.red, 1, FACTIONS.red.fill, []);
  plot(H.blue, 2, FACTIONS.blue.fill, [4, 4]); plot(H.red, 2, FACTIONS.red.fill, [4, 4]);
  c.fillStyle = 'rgba(230,230,220,0.8)'; c.fillText('сплошная — устойчивость тыла, пунктир — свет, %', 34, Ht - 4);
}

// ================= Миникарта =================
mini.addEventListener('pointerdown', (e) => {
  if (!sim) return;
  const moveTo = (ev) => {
    const r = mini.getBoundingClientRect();
    cam.x = ((ev.clientX - r.left) / r.width) * world.W;
    cam.y = ((ev.clientY - r.top) / r.height) * world.H;
    clampCam();
  };
  moveTo(e);
  mini.setPointerCapture(e.pointerId);
  mini.onpointermove = moveTo;
  mini.onpointerup = () => (mini.onpointermove = null);
});

const MINI_LAYERS = ['all', 'grid', 'logi', 'ad'], MINI_NAMES = { all: 'Все', grid: 'Энергосеть', logi: 'Логистика', ad: 'ПВО' };
let miniLayer = 0;
function cycleMiniLayer() {
  miniLayer = (miniLayer + 1) % MINI_LAYERS.length;
  const b = $('mini-layer'); if (b) b.textContent = MINI_NAMES[MINI_LAYERS[miniLayer]];
  drawMinimap();
}
function drawMinimap() {
  const miniScale = mini.width / world.W;
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.fillStyle = '#15170f';
  mctx.fillRect(0, 0, mini.width, mini.height);
  const size = chunks.worldSize(0);
  for (let cy = 0; cy * size < world.H; cy++)
    for (let cx = 0; cx * size < world.W; cx++) {
      const e = chunks.get(0, cx, cy);
      if (e) mctx.drawImage(e.canvas, cx * size * miniScale, cy * size * miniScale, size * miniScale, size * miniScale);
    }
  const dark = 1 - daylight(sim.tod());
  if (dark > 0.05) { mctx.fillStyle = `rgba(6,10,26,${0.6 * dark})`; mctx.fillRect(0, 0, mini.width, mini.height); }
  for (const line of dwui ? [] : sim.game?.lines || []) {
    for (const sec of line.sectors) {
      mctx.strokeStyle = sec.owner ? SIDES[sec.owner].fill : '#e8e2cc';
      mctx.globalAlpha = sec.locked && line.k !== (sim.game.linesTaken || 0) ? 0.4 : 1;
      mctx.lineWidth = 2;
      mctx.beginPath();
      sec.seg.forEach(([x, y], i) => (i ? mctx.lineTo(x * miniScale, y * miniScale) : mctx.moveTo(x * miniScale, y * miniScale)));
      mctx.stroke();
      mctx.globalAlpha = 1;
    }
  }
  for (const z of sim.game?.zones || []) {
    if (z.line !== undefined) continue;
    mctx.strokeStyle = z.owner ? FACTIONS[z.owner].fill : '#ddd';
    mctx.lineWidth = 2;
    mctx.beginPath(); mctx.arc(z.x * miniScale, z.y * miniScale, Math.max(4, z.r * miniScale), 0, Math.PI * 2); mctx.stroke();
  }
  if (dwui) {
    const g = sim.game, layer = MINI_LAYERS[miniLayer];
    if (layer === 'grid') {
      // энергосеть: ЛЭП (перебитые — красным), подстанции по питанию района
      for (const l of g.lines) {
        if (!l.pylons || (l.side !== controlSide && !g.known(controlSide, g.obj(l.a) || {}))) continue;
        mctx.strokeStyle = l.cut ? '#ef5a4a' : l.kv >= 330 ? '#ffd36b' : '#9fd0ff'; mctx.lineWidth = l.kv >= 330 ? 1.6 : 1;
        mctx.beginPath(); l.pylons.forEach((p, i) => (i ? mctx.lineTo(p.x * miniScale, p.y * miniScale) : mctx.moveTo(p.x * miniScale, p.y * miniScale))); mctx.stroke();
      }
    } else if (layer === 'logi') {
      for (const v of g.visibleVehicles(controlSide)) { if (v.dead) continue; mctx.fillStyle = v.side === controlSide ? '#e8e2cc' : '#ff7d72'; mctx.fillRect(v.x * miniScale - 1.5, v.y * miniScale - 1.5, 3, 3); }
      for (const h of g.roadHoles || []) { mctx.fillStyle = '#e0b030'; mctx.fillRect(h.x * miniScale - 2, h.y * miniScale - 2, 4, 4); }
    } else if (layer === 'ad') {
      for (const a of g.visibleAD(controlSide)) {
        if (a.dead) continue; const T = DW_AD_REF[a.type], R = Math.max(T.range || 0, T.radar || 0);
        if (!R) continue;
        mctx.strokeStyle = a.side === controlSide ? 'rgba(140,200,255,0.6)' : 'rgba(255,140,120,0.6)'; mctx.lineWidth = 1;
        mctx.beginPath(); mctx.arc(a.x * miniScale, a.y * miniScale, R * miniScale, 0, Math.PI * 2); mctx.stroke();
      }
    }
    mctx.strokeStyle = 'rgba(255,90,70,0.6)'; mctx.lineWidth = 1;
    mctx.beginPath(); mctx.moveTo(g.frontX * miniScale, 0); mctx.lineTo(g.frontX * miniScale, mini.height); mctx.stroke();
    for (const o of g.objects) {
      if (o.kind === 'import' || o.kind === 'bridge' || !g.known(controlSide, o)) continue;
      const bad = o.comps.some((c) => c.state !== 'ok');
      mctx.fillStyle = bad ? (o.comps.some((c) => c.state === 'destroyed') ? '#ef5a4a' : '#f0c34a') : SIDES[o.side].fill;
      mctx.strokeStyle = '#000';
      mctx.fillRect(o.x * miniScale - 4, o.y * miniScale - 4, 8, 8); mctx.strokeRect(o.x * miniScale - 4, o.y * miniScale - 4, 8, 8);
    }
    for (const d of g.visibleDrones(controlSide)) {
      mctx.fillStyle = d.side === controlSide ? SIDES[d.side].fill : '#ff4a3a';
      mctx.fillRect(d.x * miniScale - 2, d.y * miniScale - 2, 4, 4);
    }
    for (const a of g.visibleAD(controlSide)) {
      if (a.dead || a.type === 'acoustic') continue;
      mctx.fillStyle = a.side === controlSide ? '#cfe0ff' : '#ff9d8f';
      mctx.beginPath(); mctx.arc(a.x * miniScale, a.y * miniScale, 2.5, 0, Math.PI * 2); mctx.fill();
    }
  }
  const fog = fogSide();
  for (const d of [...sim.log.depots, ...sim.medpoints.blue, ...sim.medpoints.red]) {
    if (fog && d.side !== fog && !d.spotted) continue;
    mctx.fillStyle = d.alive ? SIDES[d.side].fill : '#777';
    mctx.strokeStyle = '#000';
    mctx.fillRect(d.x * miniScale - 6, d.y * miniScale - 5, 12, 10);
    mctx.strokeRect(d.x * miniScale - 6, d.y * miniScale - 5, 12, 10);
  }
  for (const u of sim.units) {
    if (u.dead || u.embarked) continue;
    if (fog && u.side !== fog && !sim.vision.now[fog].has(u.id)) continue;
    mctx.fillStyle = ui.selected.has(u.id) ? '#b8ff6b' : SIDES[u.side].fill;
    mctx.fillRect(u.x * miniScale - 3, u.y * miniScale - 3, 6, 6);
  }
  const hw = canvas.width / 2 / cam.zoom, hh = canvas.height / 2 / cam.zoom;
  mctx.strokeStyle = '#f2c14e';
  mctx.lineWidth = 2;
  mctx.strokeRect((cam.x - hw) * miniScale, (cam.y - hh) * miniScale, hw * 2 * miniScale, hh * 2 * miniScale);
}

// ================= Отрисовка кадра =================
function pickLevel() {
  for (let i = 0; i < LEVELS.length; i++) if (LEVELS[i] >= cam.zoom * 0.85) return i;
  return LEVELS.length - 1;
}
function visibleRange(level) {
  const size = chunks.worldSize(level);
  const hw = canvas.width / 2 / cam.zoom, hh = canvas.height / 2 / cam.zoom;
  return {
    cx0: Math.max(0, Math.floor((cam.x - hw) / size)), cy0: Math.max(0, Math.floor((cam.y - hh) / size)),
    cx1: Math.min(Math.ceil(world.W / size) - 1, Math.floor((cam.x + hw) / size)), cy1: Math.min(Math.ceil(world.H / size) - 1, Math.floor((cam.y + hh) / size)),
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

// «Серые зоны» у краёв карты: местность не обрывается в чёрное, а уходит в дымку — полоса 5 км
// у края постепенно затягивается серой мглой, за краем — сплошная дымка с лёгкими разводами
const HAZE = [128, 132, 124];
let hazeTile = null;
function drawEdgeHaze() {
  const z = cam.zoom, W = canvas.width, H = canvas.height;
  const sx = (x) => (x - cam.x) * z + W / 2, sy = (y) => (y - cam.y) * z + H / 2;
  const x0 = sx(0), y0 = sy(0), x1 = sx(world.W), y1 = sy(world.H);
  const B = 5000 * z; // ширина полосы, px
  if (x0 + B < 0 && y0 + B < 0 && x1 - B > W && y1 - B > H) return;
  const [r, g, b] = HAZE, c = (a) => `rgba(${r},${g},${b},${a})`;
  ctx.save();
  // за краем: сплошная дымка
  ctx.fillStyle = c(1);
  if (y0 > 0) ctx.fillRect(0, 0, W, y0);
  if (y1 < H) ctx.fillRect(0, y1, W, H - y1);
  if (x0 > 0) ctx.fillRect(0, 0, x0, H);
  if (x1 < W) ctx.fillRect(x1, 0, W - x1, H);
  // у края: плавный переход
  const band = (gx0, gy0, gx1, gy1, rx, ry, rw, rh) => {
    if (rx > W || ry > H || rx + rw < 0 || ry + rh < 0) return;
    const gr = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
    gr.addColorStop(0, c(1)); gr.addColorStop(0.35, c(0.7)); gr.addColorStop(1, c(0));
    ctx.fillStyle = gr; ctx.fillRect(rx, ry, rw, rh);
  };
  band(x0, 0, x0 + B, 0, x0, y0, B, y1 - y0);
  band(x1, 0, x1 - B, 0, x1 - B, y0, B, y1 - y0);
  band(0, y0, 0, y0 + B * 0.6, x0, y0, x1 - x0, B * 0.6);
  band(0, y1, 0, y1 - B * 0.6, x0, y1 - B * 0.6, x1 - x0, B * 0.6);
  // разводы облаков поверх дымки (плитка с шумом, едет медленно)
  if (!hazeTile) {
    hazeTile = document.createElement('canvas'); hazeTile.width = hazeTile.height = 256;
    const g2 = hazeTile.getContext('2d');
    for (let i = 0; i < 70; i++) {
      const px = Math.random() * 256, py = Math.random() * 256, rr = 20 + Math.random() * 60;
      const l = Math.random() < 0.5 ? 255 : 90;
      for (const ox of [-256, 0, 256]) for (const oy of [-256, 0, 256]) { // плитка бесшовная: пятна у краёв повторены с другой стороны
        const gg = g2.createRadialGradient(px + ox, py + oy, 0, px + ox, py + oy, rr);
        gg.addColorStop(0, `rgba(${l},${l},${l},0.05)`); gg.addColorStop(1, `rgba(${l},${l},${l},0)`);
        g2.fillStyle = gg; g2.fillRect(px + ox - rr, py + oy - rr, rr * 2, rr * 2);
      }
    }
  }
  const pat = ctx.createPattern(hazeTile, 'repeat');
  const k = Math.max(0.5, Math.min(4, 2000 * z / 256));
  pat.setTransform(new DOMMatrix([k, 0, 0, k, (x0 + performance.now() * 0.004) % (256 * k), y0 % (256 * k)]));
  ctx.fillStyle = pat;
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  if (x1 - x0 > B && y1 - y0 > B * 0.6) ctx.rect(x0 + B * 0.5, y0 + B * 0.3, x1 - x0 - B, y1 - y0 - B * 0.6); // внутренняя часть карты — без разводов
  ctx.fill('evenodd');
  ctx.restore();
}

// Экранные прямоугольники видимых чанков уровня, которых ещё нет в кэше
function missingRects(level) {
  const size = chunks.worldSize(level);
  const r = visibleRange(level);
  const sx = (wx) => Math.round((wx - cam.x) * cam.zoom + canvas.width / 2);
  const sy = (wy) => Math.round((wy - cam.y) * cam.zoom + canvas.height / 2);
  const out = [];
  for (let cy = r.cy0; cy <= r.cy1; cy++)
    for (let cx = r.cx0; cx <= r.cx1; cx++) if (!chunks.get(level, cx, cy)) out.push([sx(cx * size), sy(cy * size), sx((cx + 1) * size), sy((cy + 1) * size)]);
  return out;
}

function drawArtyOverlay() {
  const guns = selectedUnits().filter((u) => u.def.caliber);
  if (!guns.length) return;
  const toS = (x, y) => [(x - cam.x) * cam.zoom + canvas.width / 2, (y - cam.y) * cam.zoom + canvas.height / 2];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const g of guns) {
    const cal = CALIBERS[g.def.caliber];
    const [x, y] = toS(g.x, g.y);
    ctx.setLineDash([8 * dpr, 6 * dpr]);
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = 'rgba(255,190,120,0.55)';
    ctx.beginPath(); ctx.arc(x, y, cal.maxR * cam.zoom, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,110,80,0.5)';
    ctx.beginPath(); ctx.arc(x, y, cal.minR * cam.zoom, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }
  if (orderMode === 'fire' && mouse) {
    const g = guns[0];
    const cal = CALIBERS[g.def.caliber];
    const [wx, wy] = screenToWorld(mouse[0], mouse[1]);
    const d = Math.hypot(wx - g.x, wy - g.y);
    const ok = d >= cal.minR && d <= cal.maxR;
    ctx.save();
    ctx.translate(mouse[0] * dpr, mouse[1] * dpr);
    ctx.rotate(Math.atan2(wy - g.y, wx - g.x));
    ctx.beginPath();
    ctx.ellipse(0, 0, Math.max(4, cal.sigma * d * 2 * cam.zoom), Math.max(3, cal.sigma * d * 0.9 * cam.zoom), 0, 0, Math.PI * 2);
    ctx.fillStyle = ok ? 'rgba(255,120,80,0.18)' : 'rgba(120,120,120,0.15)';
    ctx.fill();
    ctx.strokeStyle = ok ? '#ff7a5a' : '#999';
    ctx.lineWidth = 1.5 * dpr;
    ctx.stroke();
    ctx.setLineDash([3 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.arc(0, 0, cal.lethal * cam.zoom, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}

function drawLabels() {
  if (!showLabels || cam.zoom > 3 * dpr) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // подписи не налезают друг на друга: сначала города, потом сёла; село, чья подпись задела уже
  // поставленную, пропускаем (на большой карте при отдалении сёл сотни)
  const placed = [], vw = canvas.width / dpr, vh = canvas.height / dpr;
  const list = world.settlements.slice().sort((a, b) => (b.type === 'city') - (a.type === 'city'));
  for (const s of list) {
    const city = s.type === 'city';
    const x = ((s.x - cam.x) * cam.zoom + canvas.width / 2) / dpr, y = ((s.y - cam.y) * cam.zoom + canvas.height / 2) / dpr;
    if (x < -200 || x > vw + 200 || y < -40 || y > vh + 40) continue;
    const hw = s.name.length * (city ? 7 : 5), hh = city ? 14 : 10;
    if (placed.some((q) => Math.abs(q[0] - x) < q[2] + hw && Math.abs(q[1] - y) < q[3] + hh)) continue;
    placed.push([x, y, hw, hh]);
    ctx.font = city ? '700 24px "PT Sans Narrow", system-ui, sans-serif' : '700 17px "PT Sans Narrow", system-ui, sans-serif';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(s.name.toUpperCase(), x, y);
    ctx.fillStyle = city ? '#fff6dc' : '#f1ecde';
    ctx.fillText(s.name.toUpperCase(), x, y);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

let lastNow = performance.now();
let uiTimer = 0, netTimer = 0, gridTimer = 0, visTimer = 0;
let rosterUnits = 0;
// Кадр защищён: ошибка в одном слое не должна останавливать игру (иначе «всё пропадает»)
let frameErrors = 0;
function frame(now) {
  try { frameBody(now); }
  catch (err) {
    frameErrors++;
    console.error(err);
    if (frameErrors <= 3) log(`Сбой отрисовки: ${err.message}. Игра продолжается.`);
  }
  requestAnimationFrame(frame);
}
function frameBody(now) {
  chunks.frame++;
  const dtReal = Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
  lastNow = now;
  if (role === 'guest') {
    // Гость: плавное движение между снимками, свой расчёт тумана войны
    interpolate(sim, dtReal);
    if (sim.game?.interpolate) sim.game.interpolate(dtReal);
    if (!paused) sim.time += dtReal * timeScale * (sim.pace || 1);
    visTimer += dtReal;
    if (visTimer > 1) { visTimer = 0; sim.vision.update(true); }
  } else if (!paused) {
    let gdt = dtReal * timeScale * (sim.pace || 1);
    while (gdt > 1e-6) {
      const step = Math.min(0.25, gdt);
      sim.update(step);
      gdt -= step;
    }
  }
  if (role !== 'guest') sim.processQueue(8);
  const netEvents = [];
  for (const ev of sim.events) {
    if (ev.type === 'forts') chunks.invalidate(ev.bbox);
    else if (ev.type === 'msg') {
      if (!ev.side || ev.side === controlSide) log(ev.text);
      if (role === 'host' && (!ev.side || ev.side !== controlSide)) net.send({ t: 'msg', text: ev.text, side: ev.side });
    } else if (ev.type === 'intel') {
      if (ev.side === controlSide) { const fe = { k: 'fog', ids: [ev.oid] }; chunks.worldEvent(fe); applyEconEvent(sim.world, fe); for (const b of fogBoxes(sim, ev.oid)) chunks.invalidate(b); }
    } else if (ev.type === 'net') {
      chunks.worldEvent(ev.ev); // фоновая отрисовка карты повторяет изменение мира
      if (role === 'host') netEvents.push(ev.ev);
    }
  }
  sim.events.length = 0;
  // Смена времени года — перерисовать карту (снег, осенние краски)
  if (sim.game?.infra) {
    const sid = sim.game.infra.season().id;
    if (sid !== world.season) { const se = { k: 'season', id: sid }; applyEconEvent(world, se); chunks.worldEvent(se); chunks.invalidate({ x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 }); }
  }
  if (role === 'host') {
    if (netEvents.length) net.send({ t: 'ev', list: netEvents });
    netTimer += dtReal;
    if (netTimer > 0.125) { netTimer = 0; const sn = makeSnapshot(sim); sn.spd = [mpSpeed.host, mpSpeed.guest, paused ? 0 : timeScale]; net.send(packDelta(deltaOut, sn)); }
    gridTimer += dtReal;
    if (gridTimer > 3) { gridTimer = 0; const gp = gridPacket(sim); if (gp) net.send(gp); }
  }
  emitDust(sim, paused ? 0 : dtReal, timeScale * (sim.pace || 1));
  const pan = (12 * dpr) / cam.zoom;
  if (!keys.has('ControlLeft') && !keys.has('ControlRight')) {
    if (keys.has('KeyW') || keys.has('ArrowUp')) cam.y -= pan;
    if (keys.has('KeyS') || keys.has('ArrowDown')) cam.y += pan;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) cam.x -= pan;
    if (keys.has('KeyD') || keys.has('ArrowRight')) cam.x += pan;
    clampCam();
  }

  const need = [];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#15170f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const L = pickLevel();
  // Подложки грубее текущего масштаба рисуем только под ещё не готовыми чанками — иначе каждый
  // кадр это 2–4 полноэкранных масштабирования картинки (главная цена кадра)
  const holes = L > 0 ? missingRects(L) : [];
  if (holes.length) {
    ctx.save();
    ctx.beginPath();
    for (const [x0, y0, x1, y1] of holes) ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.imageSmoothingQuality = 'low';
    drawLevel(0, false, need);
    for (let l = Math.max(1, L - 2); l < L; l++) drawLevel(l, false, need);
    // при отдалении в кэше остались чанки на уровень детальнее — уменьшенные, они совпадают с
    // готовыми соседями (ширина дорог, разметка), а растянутая грубая подложка дала бы «ступеньки»
    if (L + 1 < LEVELS.length) { ctx.imageSmoothingQuality = 'high'; drawLevel(L + 1, false, need); }
    ctx.restore();
    ctx.imageSmoothingQuality = 'high';
  }
  drawLevel(L, true, need);
  drawEdgeHaze();
  // Миникарте нужны все обзорные чанки, даже вне экрана
  const s0 = chunks.worldSize(0);
  for (let cy = 0; cy * s0 < world.H; cy++)
    for (let cx = 0; cx * s0 < world.W; cx++) {
      const e = chunks.get(0, cx, cy);
      if ((!e || e.stale) && !need.some((n) => n.level === 0 && n.cx === cx && n.cy === cy)) need.push({ level: 0, cx, cy, d: 1e12 });
    }
  // Сначала — текущий масштаб у центра экрана, затем обзорная подложка
  const pri = (n) => (n.level === L ? 0 : n.level === 0 ? 1 : 2);
  need.sort((a, b) => pri(a) - pri(b) || a.d - b.d);
  const t0 = performance.now();
  let rendered = 0;
  for (const n of need) {
    if (performance.now() - t0 > 10) break;
    if (chunks.render(n.level, n.cx, n.cy, t0 + 10)) rendered++;
    if (chunks.busy()) break;
  }
  {
    // «Прорисовка…» — только если под центром экрана вообще нечего показать
    const has = (l) => chunks.get(l, Math.floor(cam.x / chunks.worldSize(l)), Math.floor(cam.y / chunks.worldSize(l)));
    let any = false;
    for (let l = 0; l <= L && !any; l++) any = !!has(l);
    $('loading').style.opacity = any ? 0 : 1;
  }

  const fog = fogSide();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawInteriors(ctx, world, sim, view, interiorsForce, ui.underground);
  if (dwui) {
    drawNight(ctx, world, sim, view, 1 - daylight(sim.tod()));
    drawDWPreview(ctx, sim, view, controlSide, dwui.state, mouse ? screenToWorld(mouse[0], mouse[1]) : null);
    drawDW(ctx, sim, view, controlSide, dwui.state);
    drawArtillery(ctx, sim, view);
    drawSmoke(ctx, sim.game, sim, view, performance.now(), window.GFX === 'low');
    if (window.GFX !== 'low') drawWeatherLayer(ctx, sim.game, view, performance.now(), sim.time, sim.tod());
    drawLabels();
    uiTimer += dtReal;
    if (uiTimer > 0.25) {
      uiTimer = 0;
      $('clock').textContent = fmtTime(sim.tod());
      const wk = sim.game.weather?.kind || 'clear';
      $('clock').title = `Погода: ${WX[wk].name}${WX[wk].note ? ' — ' + WX[wk].note : ''}`;
      dwui.update();
      drawMinimap();
      updateScale();
      updateScoreboard();
    }
    return;
  }
  drawFront(ctx, sim.game, view);
  drawFortOverlay(ctx, world, view, fortView, dig);
  drawNight(ctx, world, sim, view, 1 - daylight(sim.tod()));
  if (fog) drawFog(ctx, sim, view, fog);
  drawZones(ctx, sim.game, view);
  drawPrep(ctx, sim.game, view, controlSide);
  drawFacilities(ctx, sim, view, fog);
  if (orderMode?.startsWith('build:') && mouse) {
    const kind = orderMode.slice(6);
    const [bx, by] = screenToWorld(mouse[0], mouse[1]);
    drawPlacement(ctx, view, kind, controlSide, bx, by, !sim.build.check(controlSide, kind, bx, by));
  }
  drawSpawns(ctx, sim.game, view, fog ? controlSide : null);
  drawInfra(ctx, world, sim, view, controlSide, fog);
  drawArtyOverlay();
  drawUnits(ctx, sim, view, ui, fog);
  drawCombatFx(ctx, sim, view, fog);
  drawArtillery(ctx, sim, view);
  drawLabels();

  uiTimer += dtReal;
  if (uiTimer > 0.25) {
    uiTimer = 0;
    $('clock').textContent = fmtTime(sim.tod());
    if (sim.units.some((u) => u.dead && ui.selected.has(u.id))) { for (const u of sim.units) if (u.dead) ui.selected.delete(u.id); buildCard(); }
    updateCard();
    updateRoster();
    updateReserve();
    drawMinimap();
    updateScale();
    updateScoreboard();
    if (orderMode === 'fire') updateHint();
    if (sim.units.length !== rosterUnits) { rosterUnits = sim.units.length; buildRoster(); }
  }
}

function updateScale() {
  const mPerCss = dpr / cam.zoom;
  const target = 110 * mPerCss;
  const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  const len = nice.find((n) => n >= target * 0.6) || 5000;
  $('scale-bar').style.width = `${len / mPerCss}px`;
  $('scale-label').textContent = len >= 1000 ? `${len / 1000} км` : `${len} м`;
  if (mouse) {
    const [x, y] = screenToWorld(mouse[0], mouse[1]);
    $('coords').textContent = `${(x / 1000).toFixed(2)} · ${(y / 1000).toFixed(2)} км`;
  }
}

function fmtClock(sec) {
  const h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function fmtTime(sec) { return `День ${Math.floor(sec / 86400) + 1} · ${fmtClock(sec)}`; }
function fmtEta(sec) {
  if (sec < 60) return `${Math.round(sec)} с`;
  if (sec < 3600) return `${Math.round(sec / 60)} мин`;
  return `${Math.floor(sec / 3600)} ч ${Math.round((sec % 3600) / 60)} мин`;
}

// Автостарт для отладки: ?autostart=1&side=red&mode=front
if (params.get('autostart')) {
  menu.side = params.get('side') || menu.side;
  menu.mode = params.get('mode') || menu.mode;
  if (params.get('hour')) menu.startHour = Number(params.get('hour'));
  if (params.get('fog') === '0') menu.fog = false;
  if (params.get('role')) menu.role = params.get('role');
  if (params.get('prep')) menu.prep = Number(params.get('prep'));
  if (menu.mode === 'drones') menu.duration = params.has('dur') ? Number(params.get('dur')) : 0;
  startGame(gameConfig());
}

window.game = {
  get world() { return world; }, get sim() { return sim; }, get chunks() { return chunks; }, cam, ui, CHUNK_PX, setOrderMode, orderAt, fireOpts, issue,
  get role() { return role; },
};
