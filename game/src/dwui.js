// Интерфейс режима «Война дронов»: левая панель (энергосистема, ПВО, удары, ремонт),
// карточка выбранного объекта / позиции ПВО, клики по карте, подсказки.

import { DW_DRONES, DW_AD, COMP, KIND_NAME, CIVIL, dronesOf, shelterDef, GTU, PACE, WX } from './sim/dronewar.js';
import { VEH } from './sim/dwlogi.js';
import { BUILD, BUILD_GROUPS, STAGE_NAME, upgradeCost, UPKEEP, LAUNCH_PER } from './sim/dwecon.js';
import { LAWS, TAXES, MOBIL, PROJECTS, TECH } from './sim/dwstate.js';
import { REGION_SPEC } from './sim/dwinfra.js';
import { RESEARCH, droneWork } from './sim/dwres.js';
import { icon } from './icons.js';
const CREW_ST = { travel: 'едет к объекту', waitfire: 'ждёт, пока потушат', work: 'ремонтирует' };

const $ = (id) => document.getElementById(id);
const TAB_TITLE = { grid: 'Обзор', ad: 'ПВО', strike: 'Дроны и удары', repair: 'Ремонт', econ: 'Стройка', res: 'Исследования', state: 'Страна' };
const AD_ICON = { mog: 'mog', spaag: 'spaag', sam: 'sam', ew: 'ew', acoustic: 'acoustic', radar: 'radar', ewd: 'ewd', icpt: 'icpt', dummy: 'decoyps' };
const DRONE_ICON = { strike: 'strike', decoy: 'decoy', recon: 'recon', loiter: 'loiter', hunter: 'hunter' };
const GROUP_ICON = ['market', 'mill', 'railterm', 'housing', 'bolt', 'shield'];
const GROUP_SHORT = ['торговля', 'агро', 'экспорт', 'люди', 'энергия', 'военное'];
const BUILD_ICON = { store: 'store', fuel: 'fuel', market: 'market', mall: 'mall', hub: 'hub', autopark: 'autopark', elevator: 'elevator', agro: 'agro', mill: 'mill', dairy: 'dairy', cement: 'cement', railterm: 'railterm', port: 'port', housing: 'housing', hospital: 'hospital', school: 'school', watertower: 'watertower', solar: 'solar', bess: 'bess', refinery: 'refinery', coalmine: 'coalmine', reserve: 'reserve', pontoon: 'pontoon', launch: 'launch', workshop: 'workshop', decoy: 'decoyps' };
// Первое предложение описания — для плитки
// Перерисовать блок, не закрывая раскрытые «подробности» и не сбрасывая прокрутку
function setHTML(el, html) {
  if (!el) return;
  const open = new Set([...el.querySelectorAll('details[open] > summary')].map((q) => q.textContent));
  el.innerHTML = html;
  for (const d of el.querySelectorAll('details')) if (open.has(d.querySelector('summary')?.textContent)) d.open = true;
}
const shortDesc = (d) => String(d).split(/[;:(]/)[0].slice(0, 70);
// Длительность в реальных минутах (мир идёт в sim.pace раз быстрее часов)
const rmin = (sim, sec) => Math.max(1, Math.round(sec / (sim.pace || 1) / 60));
const ST_TEXT = { ok: 'исправен', damaged: 'выведен из строя', destroyed: 'разрушен' };
const ST_CLS = { ok: 'ok', damaged: 'warn', destroyed: 'bad' };
const kmh = (v) => Math.round(v * 3.6);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export class DWUI {
  constructor(o) {
    Object.assign(this, o); // sim, side, issue, log, focus, screenToWorld, view
    this.state = { tab: 'grid', mode: null, count: 4, route: [], selAD: null, selObj: null, showRanges: false, wave: null };
    this.enemy = this.side === 'blue' ? 'red' : 'blue';
    $('roster').style.display = 'none';
    $('dw-panel').classList.add('show');
    for (const [k, ic] of Object.entries({ grid: 'home', ad: 'shield', strike: 'target', repair: 'wrench', econ: 'crane', res: 'flask', state: 'columns' })) { const b = document.querySelector(`.dw-rail [data-dwtab="${k}"] i`); if (b) b.outerHTML = icon(ic, 'ri'); }
    $('dw-fold').onclick = () => { this.state.folded = !this.state.folded; this.fold(); };
    this.fold();
    document.body.classList.add('dw');
    for (const t of document.querySelectorAll('[data-dwtab]')) t.onclick = () => { if (this.state.tab === t.dataset.dwtab && !this.state.folded) { this.state.folded = true; this.fold(); return; } this.state.tab = t.dataset.dwtab; this.state.folded = false; this.fold(); this.build(); };
    $('dw-body').onclick = (e) => this.onPanel(e);
    $('dw-card').onclick = (e) => this.onPanel(e);
    $('dw-status').onclick = (e) => this.onPanel(e);
    // пока кнопка мыши зажата над панелью, не перерисовываем её — иначе клик теряется
    for (const id of ['dw-body', 'dw-card', 'dw-status']) $(id).addEventListener('pointerdown', () => { this.pressing = true; });
    window.addEventListener('pointerup', () => setTimeout(() => { this.pressing = false; }, 0));
    window.addEventListener('pointercancel', () => { this.pressing = false; });
    this.build();
  }
  get g() { return this.sim.game; }
  get S() { return this.g.sides[this.side]; }

  tabByIndex(i) {
    const k = ['grid', 'ad', 'strike', 'repair', 'econ', 'res', 'state'][i];
    if (!k) return;
    this.state.tab = k; this.state.folded = false; this.fold(); this.build();
  }
  // Обучение при первом запуске: пять шагов с подсветкой вкладок (можно пропустить; запоминается)
  tutorial(force = false) {
    let done = false;
    try { done = localStorage.getItem('dw-tut') === '1'; } catch { /* нет хранилища — показываем */ }
    if (done && !force) return;
    const steps = [
      ['Ваша задача', 'Удержать тыл: свет, топливо и торговля кормят бюджет, а удары противника по энергосистеме и логистике его обрушают. Проигрывает сторона, чья «устойчивость тыла» (вверху, «тыл») упадёт до нуля.', 'grid'],
      ['ПВО', 'Вкладка «ПВО» (Shift+2): выберите средство и кликните по своей земле. РЛС наводит огневые группы в радиусе 25 км — без неё они бьют почти вслепую. Макеты ЗРК отвлекают удары.', 'ad'],
      ['Удары', 'Вкладка «Удары» (Shift+3): дроны собирает завод — закажите «+1/+5», потом кликните по цели. Объекты противника видны только после разведки.', 'strike'],
      ['Ремонт и энергосеть', '«Ремонт» (Shift+4) — бригады чинят узлы бесплатно, платите только за уничтоженное оборудование. На «Обзоре» — веерные отключения: они спасают трансформаторы от перегрева.', 'repair'],
      ['Карта и время', 'Журнал слева внизу: клик по событию — перейти к месту. M — слой миникарты (энергосеть, логистика, ПВО). Пробел — пауза, 1–5 — скорость, F1 — справка. Погода меняется: в туман видят только РЛС.', 'grid'],
    ];
    let i = 0;
    const box = $('tut');
    const show = () => {
      const [h, t, tab] = steps[i];
      $('tut-h').textContent = h; $('tut-t').textContent = t; $('tut-n').textContent = `${i + 1} из ${steps.length}`;
      $('tut-next').textContent = i === steps.length - 1 ? 'Понятно' : 'Далее';
      this.state.tab = tab; this.state.folded = false; this.fold(); this.build();
      box.classList.add('show');
    };
    const end = () => { box.classList.remove('show'); try { localStorage.setItem('dw-tut', '1'); } catch { /* ignore */ } };
    $('tut-next').onclick = () => { if (++i >= steps.length) end(); else show(); };
    $('tut-skip').onclick = end;
    show();
  }
  // ------------------------------------------------ Панель
  build() {
    for (const t of document.querySelectorAll('[data-dwtab]')) t.classList.toggle('active', t.dataset.dwtab === this.state.tab);
    const g = this.g, side = this.side;
    $('dw-title').textContent = TAB_TITLE[this.state.tab] || '';
    const ICON = icon;
    const tile = (attr, sel, icon, name, sub, right, extra = '', cls = '', title = '') => `<div class="dw-tile${sel ? ' sel' : ''}${cls ? ' ' + cls : ''}" ${attr} title="${esc(title)}">${icon ? ICON(icon, 'ic') : ''}<b>${esc(name)}</b><small>${sub}</small>${right}${extra}</div>`;
    let h = '';
    if (this.state.tab === 'grid') {
      h = `<div id="dw-grid"></div>`;
    } else if (this.state.tab === 'ad') {
      h += `<div class="dw-note">Выберите средство и кликните по карте на своей земле. Свою позицию выделите кликом — правый клик переместит мобильную группу.</div><div class="dw-tiles">`;
      for (const [k, T] of Object.entries(DW_AD)) {
        const ok = g.res.adOk(side, k);
        h += tile(ok ? `data-ad="${k}"` : '', this.state.mode === 'ad:' + k, AD_ICON[k] || 'shield', T.name[side], ok ? esc(T.sub[side]) : `${icon('lock')} исследуйте «${esc(g.res.needFor('ad', k))}»`, `<span class="price">${g.adCost(side, k)}</span>`, '', ok ? '' : 'locked', T.desc);
      }
      h += `</div><label class="dw-check"><input type="checkbox" data-act="ranges" ${this.state.showRanges ? 'checked' : ''}> Показывать зоны поражения</label>`;
      h += `<div class="dw-sub">Ваши позиции</div><div id="dw-adlist"></div>`;
    } else if (this.state.tab === 'strike') {
      h += `<div id="dw-prod"></div><div class="dw-note">Выберите дрон и кликните по цели: <b>клик — 1 дрон</b>, <b>Ctrl+клик — 5</b>, <b>Shift+клик</b> — точка маршрута. Числа в углу — запас; «+1 / +5» — заказать на заводе.</div><div class="dw-tiles">`;
      for (const k of dronesOf(side)) {
        const D = DW_DRONES[k], ok = g.res.droneOk(side, k), cost = g.droneCost(side, k);
        const role = { strike: 'ударный', decoy: 'ложная цель', recon: 'разведчик', loiter: 'по ПВО и машинам', hunter: 'охотник на дорогах' }[D.cls] || '';
        const sub = ok ? `${role}${D.wh ? ` · ${D.wh} кг` : ''} · ${Math.round(cost)} оч.` : `${icon('lock')} исследуйте «${esc(g.res.needFor('drone', k))}»`;
        const n = g.res.stock(side, k);
        h += tile(ok ? `data-drone="${k}"` : '', this.state.mode === 'strike:' + k, DRONE_ICON[D.cls] || 'strike', D.short, sub, ok ? `<span class="stock${n ? '' : ' zero'}" data-stock="${k}">${n}</span>` : '', ok ? `<span class="row"><button data-order="${k}:1" title="заказать 1 — ${cost.toFixed(0)} оч.">+1</button><button data-order="${k}:5" title="заказать 5 — ${(cost * 5).toFixed(0)} оч.">+5</button></span>` : '', ok ? '' : 'locked', D.desc);
      }
      const wave = side === 'red' ? { label: 'Волна «Гербер» и «Гераней»' } : { label: 'Рой «Бобров» и FP-1' };
      h += tile('data-wave="1"', this.state.mode === 'wave', 'wave', wave.label, 'до 6 каждого типа из запаса одним кликом', '');
      h += `</div><div class="dw-sub">В воздухе</div><div id="dw-air"></div>`;
    } else if (this.state.tab === 'repair') {
      h += `<label class="dw-check"><input type="checkbox" data-act="auto" ${this.S.auto ? 'checked' : ''}> <b>Авторемонт</b> — бригады сами едут к повреждениям (важное первым)</label>`;
      h += `<div class="dw-tiles">${tile('data-act="crew"', false, 'crew', 'Нанять бригаду', 'зарплата 0,9 оч/мин', '<span class="price">60</span>')}${tile('data-act="spare"', false, 'spare', 'Резервный АТ', 'запасной автотрансформатор', '<span class="price">150</span>')}${tile('data-act="net"', this.state.mode === 'net', 'net', 'Сетка над дорогой', 'кликните по дороге: 600 м защиты от лёгких дронов', '<span class="price">40</span>')}</div>`;
      h += `<div id="dw-crews"></div><div class="dw-sub">Повреждено</div><div id="dw-dmg"></div>`;
    } else if (this.state.tab === 'econ') {
      h += `<div class="dw-note">Выберите постройку и кликните у дороги на своей земле (правый клик — отмена). Готовый объект подключите к сети в его карточке.</div>`;
      const grp = this.state.bgrp ?? 0;
      h += `<div class="dw-subtabs">${BUILD_GROUPS.map(([n], i) => `<button data-bgrp="${i}" class="${grp === i ? 'sel' : ''}" title="${esc(n)}">${icon(GROUP_ICON[i] || 'info')}<small>${GROUP_SHORT[i] || ''}</small></button>`).join('')}</div><div class="dw-sub">${esc(BUILD_GROUPS[grp][0])}</div><div class="dw-tiles">`;
      for (const k of BUILD_GROUPS[grp][1]) {
        const B = BUILD[k], ok = g.res.buildOk(side, k);
        h += tile(ok ? `data-build="${k}"` : '', this.state.mode === 'build:' + k, BUILD_ICON[k] || 'store', B.name, ok ? `${rmin(this.sim, B.time)} мин · ${esc(shortDesc(B.desc))}` : `${icon('lock')} исследуйте «${esc(g.res.needFor('build', k))}»`, `<span class="price">${B.cost}</span>`, '', ok ? '' : 'locked', B.desc);
      }
      h += `</div><div class="dw-sub">Инструменты</div><div class="dw-tiles">`;
      h += tile('data-act="pave"', this.state.mode === 'pave', 'pave', 'Асфальт', 'клик по грунтовке — машины быстрее', '<span class="price">60/км</span>');
      h += tile('data-act="line"', this.state.mode?.startsWith('line'), 'line', 'ЛЭП 110 кВ', 'клик по двум подстанциям — обходная линия', '<span class="price">25/км</span>');
      h += `</div><div id="dw-econ"></div>`;
    } else if (this.state.tab === 'state') {
      const sub = this.state.gsub || 'econ';
      h += `<div class="dw-subtabs">${[['econ', 'coin', 'Бюджет'], ['law', 'law', 'Законы'], ['reg', 'map', 'Области']].map(([k, ic, n]) => `<button data-gsub="${k}" class="${sub === k ? 'sel' : ''}">${icon(ic)} ${n}</button>`).join('')}</div><div id="dw-state"></div>`;
    } else if (this.state.tab === 'res') {
      h += `<div id="dw-res"></div>`;
    }
    $('dw-body').innerHTML = h;
    this.modeHint();
    this.update(true);
  }
  // Свернуть панель до узкой полосы с иконками (карта свободна); клик по иконке — развернуть
  fold() {
    $('dw-panel').classList.toggle('folded', !!this.state.folded);
    $('dw-fold').innerHTML = icon(this.state.folded ? 'expand' : 'collapse');
    $('dw-fold').title = this.state.folded ? 'Развернуть панель' : 'Свернуть панель (или повторный клик по вкладке)';
  }
  // Подсказка по текущему режиму — над картой, чтобы было понятно, что делает клик
  modeHint() {
    const m = this.state.mode, el = $('dw-hint');
    let t = '';
    if (m?.startsWith('ad:')) t = `Кликните по карте на своей территории — поставить <b>${esc(DW_AD[m.slice(3)].name[this.side])}</b> · ПКМ — отмена`;
    else if (m?.startsWith('strike:')) { const D = DW_DRONES[m.slice(7)]; t = `<b>${esc(D.short)}</b> (в запасе ${this.g.res.stock(this.side, m.slice(7))}): ${D.cls === 'hunter' ? 'кликните по району дорог' : D.cls === 'loiter' ? 'кликните по найденной позиции ПВО или машине' : D.cls === 'recon' ? 'кликните, куда лететь на разведку' : 'кликните по объекту противника'} · Ctrl — 5 шт. · Shift — точка маршрута · ПКМ — отмена`; }
    else if (m === 'wave') t = 'Кликните по объекту противника — волна из запаса · ПКМ — отмена';
    else if (m?.startsWith('build:')) t = `Кликните у дороги на своей земле — <b>${esc(BUILD[m.slice(6)].name)}</b> · ПКМ — отмена`;
    else if (m === 'pave') t = 'Кликните по грунтовой или сельской дороге · ПКМ — отмена';
    else if (m === 'line') t = 'Кликните по первой подстанции или станции · ПКМ — отмена';
    else if (m?.startsWith('line:')) t = 'Теперь кликните по второй подстанции · ПКМ — отмена';
    else if (m === 'net') t = 'Кликните по дороге — натянуть сетку · ПКМ — отмена';
    else if (m?.startsWith('evac:')) t = 'Кликните, куда вывезти завод (не ближе 14 км к фронту) · ПКМ — отмена';
    el.innerHTML = t;
    el.classList.toggle('show', !!t);
  }
  // «Что сделать сейчас»: до трёх важных подсказок с кнопкой действия
  advice() {
    const g = this.g, side = this.side, S = this.S, out = [];
    if (g.prep) out.push(['info', 'Подготовка: расставьте ПВО у ТЭС и подстанций, затем нажмите «К бою».', `<button data-tab="ad">ПВО</button>`]);
    if (S.collapse > 0) out.push(['bad', `Энергосистема на грани краха — ${Math.max(0, 120 - S.collapse).toFixed(0)} с. Нужны деньги на ремонт!`, `<button data-tab="repair">Ремонт</button>`]);
    const unplugged = g.objs(side).filter((o) => g.econ.needsGrid(o) && !o.grid && !(o.build && !o.build.grid));
    if (unplugged.length) { const o = unplugged[0], q = g.econ.gridCheck(side, o.id); out.push(['bad', `«${esc(o.name)}» не подключён к сети и не работает`, q.err ? `<button data-obj="${o.id}">Показать</button>` : `<button data-grid="${o.id}">${icon('plug')} ${q.cost}</button>`]); }
    const dmg = []; for (const o of g.objs(side)) for (const c of o.comps) if (c.state !== 'ok' && !S.queue.includes(c.id) && !S.crews.some((w) => w.job?.id === c.id)) dmg.push(c);
    if (dmg.length && !S.auto) out.push(['bad', `Повреждено ${dmg.length} узл. без ремонта`, `<button data-act="auto" data-on="1">Включить авторемонт</button>`]);
    const shed = g.objs(side, 'ps110').find((p) => p.unstable);
    if (shed && !S.autoShed) out.push(['bad', `${esc(shed.name)}: перегрузка — введите отключения`, `<button data-tab="grid">Свет</button>`]);
    if (!g.prep) {
      const strikeTypes = dronesOf(side).filter((k) => g.res.droneOk(side, k) && DW_DRONES[k].cls === 'strike');
      const stock = strikeTypes.reduce((a, k) => a + g.res.stock(side, k), 0), queued = g.res.side[side].queue.length;
      if (!stock && !queued) out.push(['', 'Ударных дронов нет в запасе — закажите на заводе', `<button data-order="${strikeTypes[0]}:5">+5 ${esc(DW_DRONES[strikeTypes[0]].short)}</button>`]);
      const known = g.objects.filter((o) => o.side === this.enemy && g.known(side, o) && !CIVIL.has(o.kind) && o.kind !== 'bridge').length;
      const recon = dronesOf(side).find((k) => DW_DRONES[k].cls === 'recon');
      if (known < 4) out.push(['info', 'Цели противника не найдены — отправьте разведчика вглубь его территории', `<button data-drone="${recon}">${icon('recon')} ${esc(DW_DRONES[recon].short)}</button>`]);
    }
    if (!g.prep && !g.res.side[side].cur && S.points > 400) { const id = Object.keys(RESEARCH).find((k) => g.res.available(side, k)); if (id) out.push(['info', `Лаборатории простаивают: «${esc(RESEARCH[id].name)}»`, `<button data-res="${id}">${g.res.cost(side, id)}</button>`]); }
    $('dw-advice').innerHTML = out.slice(0, 3).map(([c, txt, btn]) => `<div class="dw-tip ${c}"><span>${txt}</span>${btn}</div>`).join('');
  }

  // Устойчивость тыла (своя и противника), фаза, время партии
  status() {
    const g = this.g, t = this.sim.time;
    const E = g.sides[this.enemy], S = this.S;
    const col = (v) => (v > 60 ? '#7ddc6a' : v > 30 ? '#f0c34a' : '#ef5a4a');
    const bar = (label, v, tip) => `<div class="dw-mor" title="${tip}"><span>${label}</span><div class="bar"><i style="width:${Math.max(0, v).toFixed(0)}%;background:${col(v)}"></i></div><b style="color:${col(v)}">${Math.max(0, v).toFixed(0)}</b></div>`;
    const real = (s) => Math.max(0, s) / (this.sim.pace || 1);
    const hhmm = (s) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
    const PH = ['пробные удары', 'массированные удары', 'удар возмездия'];
    let h = bar('Ваш тыл', S.morale ?? 100, 'Устойчивость тыла: упадёт до нуля — поражение. Бьют отключения света, разрушения, пожары, пустые магазины') + bar('Тыл врага', E.morale ?? 100, 'Устойчивость тыла противника');
    h += `<div class="dw-phase"><span>${g.prep ? 'подготовка' : `фаза ${(g.phaseNo || 0) + 1}: ${PH[g.phaseNo || 0]}`}${g.infra ? ` · ${g.infra.season().name}` : ''}${g.weather ? ` · <span title="${esc(WX[g.weather.kind]?.note || '')}">${esc(WX[g.weather.kind]?.name.toLowerCase() || '')}</span>` : ''}</span><span>${g.endless ? (g.prep ? '' : `в бою ${hhmm(real(t - (g.startAt || t)))}`) : `осталось ${hhmm(real(g.endAt - t))}`}</span></div>`;
    $('dw-status').innerHTML = h;
  }

  update(force = false) {
    const g = this.g, S = this.S, side = this.side;
    if (!g || (this.pressing && !force)) return;
    $('dw-pts').textContent = Math.floor(S.points);
    this.status();
    this.advice();
    if (this.state.tab === 'grid') {
      const p110 = g.objs(side, 'ps110');
      const cities = this.sim.world.settlements.filter((s) => s.type === 'city' && s.side === side);
      const cityRow = (ci) => {
        const ps = p110.filter((p) => p.city === ci);
        const v = ps.reduce((a, p) => a + (p.supply ?? 1), 0) / Math.max(1, ps.length);
        return `<div class="dw-city"><span>${esc(cities.find((c, i) => i === ci)?.name || '')}</span><div class="bar"><i style="width:${(v * 100).toFixed(0)}%;background:${v > 0.8 ? '#ffe27a' : v > 0.4 ? '#f0a040' : '#ef5a4a'}"></i></div><b>${(v * 100).toFixed(0)}%</b></div>`;
      };
      const achr = this.sim.time < S.achrUntil;
      const supCol = S.supply > 0.8 ? 'var(--ok)' : S.supply > 0.4 ? '#f0c34a' : 'var(--bad)';
      const I = S.inc || {};
      let h = `<div class="dw-big"><div title="сколько вырабатывают станции"><small>выработка</small><b>${S.gen}</b> МВт</div><div title="сколько нужно городам и сёлам"><small>нужно</small><b>${S.demand}</b> МВт</div><div title="сколько дошло до потребителей"><small>свет</small><b style="color:${supCol}">${(S.supply * 100).toFixed(0)}%</b></div></div>`;
      h += `<div class="dw-big"><div title="доход в минуту (реальную)"><small>доход</small><b style="color:${S.income >= 0 ? 'var(--ok)' : 'var(--bad)'}">${S.income >= 0 ? '+' : ''}${(S.income * (this.sim.pace || 1)).toFixed(0)}</b>/мин</div><div><small>логистика</small><b>${(S.logi ?? 1) < 1 ? '<span class="bad">сбой</span>' : 'норма'}</b></div><div><small>топливо</small><b>${((S.oil ?? 1) * 100).toFixed(0)}%</b></div></div>`;
      if (achr) h += `<div class="dw-alarm">⚠ АЧР: аварийные отключения</div>`;
      if (S.collapse > 0) h += `<div class="dw-alarm">⚠ Энергосистема на грани: ${Math.max(0, 120 - S.collapse).toFixed(0)} с до краха — нужны средства на ремонт</div>`;
      const P = S.moraleParts;
      if (P) {
        const parts = [['нет света', P.power], ['мосты', P.bridges], ['пустые магазины', P.shops], ['пожары', P.fires], ['погранпереход', P.border], ['нет воды', P.water || 0]].filter(([, v]) => v > 0.05);
        h += `<div class="dw-income">Тыл: ${parts.length ? parts.map(([n, v]) => `<span class="bad">${n} −${v.toFixed(1)}</span>`).join(' · ') : '<span class="ok">потерь нет</span>'}${P.regen ? ` · <span class="ok">восстановление +${P.regen.toFixed(1)}</span>` : ''}</div>`;
      }
      // Районы (подстанции 110 кВ): свет по районам, отключения — одной кнопкой
      h += `<div class="dw-sub">Свет по районам</div><label class="dw-check"><input type="checkbox" data-act="autoshed" ${S.autoShed ? 'checked' : ''}> Автодиспетчер (сам вводит отключения при нехватке)</label>`;
      for (const ps of p110) {
        const v = ps.supply ?? 1, L = ps.shed || 0;
        const st = ps.unstable ? `<span class="bad">⚠ перегрузка — трансформатор отключится через ${Math.max(0, 60 - (ps.overT || 0))} с</span>` : L ? `<span class="warn">отключено ${L} из 5 очередей</span>` : '';
        const btn = [0, 1, 2, 3, 4].map((k) => `<button data-shed="${ps.id}:${k}" class="${L === k ? 'sel' : ''}" title="${k ? `отключить ${k} из 5 очередей (−${k * 20}% нагрузки)` : 'все со светом'}">${k}</button>`).join('');
        const gtus = (g.gens || []).filter((q) => q.ps === ps.id && !q.dead);
        h += `<div class="dw-ps"><div class="dw-city"><span data-obj="${ps.id}" style="cursor:pointer">${esc(ps.name.replace(/^ПС 110 кВ /, ''))}</span><div class="bar"><i style="width:${(v * 100).toFixed(0)}%;background:${v > 0.8 ? '#ffe27a' : v > 0.4 ? '#f0a040' : '#ef5a4a'}"></i></div><b>${(v * 100).toFixed(0)}%</b></div>${st ? `<small>${st}</small>` : ''}<div class="dw-btns"><span class="muted">отключения:</span>${btn}<button data-gtu="${ps.id}" title="${GTU.name}: мобильная газотурбинная установка на шины 10 кВ">+ГТУ ${GTU.cost}</button>${gtus.length ? `<span class="muted">ГТУ ${gtus.length}</span>` : ''}</div></div>`;
      }
      const G = S.genBy || {};
      const src = [['tpp', 'ТЭС'], ['hpp', 'ГЭС'], ['chp', 'ТЭЦ'], ['wpp', `ВЭС (ветер ${Math.round((g.wind ?? 0.6) * 100)}%)`], ['spp', 'СЭС'], ['import', 'импорт'], ['gtu', 'ГТУ'], ['bess', 'накопители']];
      let more = `<div class="dw-gen">${src.filter(([k]) => G[k] !== undefined).map(([k, n]) => `<span><small>${n}</small><b>${Math.round(G[k] || 0)}</b></span>`).join('')}</div>`;
      more += `<div class="dw-income">Доход по статьям (оч/мин игры): промышленность ${(I.industry || 0).toFixed(0)} · налоги ${(I.tax || 0).toFixed(0)} · магазины ${(I.trade || 0).toFixed(0)} · АЗС ${(I.fuel || 0).toFixed(0)} · фуры ${(I.transit || 0).toFixed(0)} · зерно ${(I.agro || 0).toFixed(0)} · <span class="bad">бригады ${(I.wages || 0).toFixed(0)} · армия ${(I.upkeep || 0).toFixed(0)}</span> · нефтебаза ${((S.oil ?? 1) * 100).toFixed(0)}% · арсенал ${((S.ammo ?? 1) * 100).toFixed(0)}%</div>`;
      more += `<div class="dw-note">Если сеть не даёт подстанции всю мощность, без отключений режим неустойчив: через минуту защита выведет трансформатор. Плановые очереди снимают нагрузку, остальные районы со светом.</div>`;
      h += `<details class="dw-more"><summary>Генерация и доход подробно</summary>${more}</details>`;
      const L = g.logi.side[side];
      const withGoods = L.markets.filter((m) => m.stock > 0).length, cut = L.markets.filter((m) => m.cut).length + L.fuels.filter((m) => m.cut).length;
      const withFuel = L.fuels.filter((m) => m.stock > 0).length;
      const veh = g.logi.vehicles.filter((v) => !v.dead && v.side === side);
      const cnt = (k) => veh.filter((v) => v.kind === k).length;
      h += `<details class="dw-more"><summary>Торговля и логистика</summary><div class="dw-income">Торговля <b>+${(S.tradeAvg ?? 0).toFixed(1)}</b> · на складе РЦ <b>${L.hub.stock}</b> · магазинов с товаром ${withGoods}/${L.markets.length} · АЗС с топливом ${withFuel}/${L.fuels.length}${cut ? ` · <span class="bad">отрезано ${cut}</span>` : ''}<br>На дорогах: фур ${cnt('fura')}, развозных ${cnt('van')}, бензовозов ${cnt('tanker')}, снабжение ПВО ${cnt('supply')}, ремонтники ${cnt('crew')}, пожарные ${cnt('fire')}${L.stats.lostTrucks ? ` · <span class="bad">потеряно машин ${L.stats.lostTrucks}</span>` : ''}</div></details>`;
      const groups = ['tpp', 'hpp', 'chp', 'wpp', 'spp', 'solar', 'bess', 'ps330', 'ps110', 'decoy', 'bridge', 'pontoon', 'elevator', 'reserve', 'oil', 'ammo', 'factory', 'workshop', 'launch', 'hub', 'border', 'rembase', 'firest', 'fuel'];
      let own = '';
      for (const k of groups) for (const o of g.objs(side, k)) own += this.objRow(o);
      h += `<details class="dw-more"><summary>Ваши объекты</summary>${own}</details>`;
      const E = g.sides[this.enemy];
      let en = `<div class="dw-income">Снабжение городов противника ≈ <b>${(E.supply * 100).toFixed(0)}%</b> · очки ≈ ${Math.round(E.points / 50) * 50}</div>`;
      const hiddenN = g.objects.filter((o) => o.side === this.enemy && !g.known(side, o) && !CIVIL.has(o.kind)).length;
      if (hiddenN) en += `<div class="dw-note">Не найдено ещё ~${hiddenN} объектов — ищите разведчиками, ударными дронами на маршруте и спутником.</div>`;
      for (const k of groups) for (const o of g.objs(this.enemy, k)) if (g.known(side, o) && !CIVIL.has(k) && (k !== 'bridge' || o.btype === 'rail' || o.btype === 'highway')) en += this.objRow(o);
      h += `<details class="dw-more"><summary>Противник — разведданные</summary>${en}</details>`;
      setHTML($('dw-grid'), h);
    } else if (this.state.tab === 'ad') {
      const list = g.ad.filter((a) => a.side === side && !a.dead);
      $('dw-adlist').innerHTML = list.map((a) => `<div class="dw-row small${this.state.selAD === a.id ? ' sel' : ''}" data-selad="${a.id}"><div><b>${esc(a.name)}</b><small>${a.state === 'deploying' ? 'развёртывание' : a.state === 'moving' ? 'на марше' : a.target ? 'ведёт огонь' : 'готов'}${a.kills ? ` · сбито ${a.kills}` : ''}${a.missiles ? ` · ракет ${a.missiles}` : ''}${a.type === 'icpt' ? ` · перехватчиков ${a.stock}` : ''}</small></div></div>`).join('') || '<div class="dw-note">нет</div>';
    } else if (this.state.tab === 'strike') {
      const air = g.drones.filter((d) => !d.dead && d.side === side && DW_DRONES[d.type].cls !== 'interceptor');
      const by = {};
      for (const d of air) by[d.type] = (by[d.type] || 0) + 1;
      $('dw-air').innerHTML = Object.entries(by).map(([k, n]) => `<div class="dw-row small"><div><b>${esc(DW_DRONES[k].short)}</b></div><span>${n}</span></div>`).join('') || '<div class="dw-note">нет</div>';
      $('dw-air').innerHTML += `<div class="dw-note">Пущено ${S.stats.launched}, попаданий ${S.stats.hits}. Сбито противника: ${S.stats.shot}.</div>`;
      const P = g.res.side[side];
      const bar = (k) => `<div class="bar"><i style="width:${(100 * Math.max(0, Math.min(1, k))).toFixed(0)}%"></i></div>`;
      let ph = `<div class="dw-income">Сборка: <b>${P.rate.toFixed(1)}</b> линий${P.rate < 1 ? ' <span class="bad">— завод выбит, идут только поставки партнёров</span>' : ''} · в очереди ${P.queue.reduce((a, q) => a + q.n, 0)}</div>`;
      ph += P.queue.slice(0, 6).map((q, i) => `<div class="dw-crew">${esc(DW_DRONES[q.k].short)} ×${q.n}${i === 0 ? bar(P.prog / droneWork(q.k)) : ''}<button class="dw-x" data-cancel="${i}" title="отменить (деньги за несобранные вернут)">${icon('close')}</button></div>`).join('');
      $('dw-prod').innerHTML = ph;
      for (const el of document.querySelectorAll('[data-stock]')) { const n = g.res.stock(side, el.dataset.stock); el.textContent = n; el.classList.toggle('zero', !n); }
    } else if (this.state.tab === 'repair') {
      const busyN = S.crews.filter((c) => c.job).length;
      $('dw-crews').innerHTML = `<div class="dw-note">Бригад <b>${S.crews.length}</b> (на выезде ${busyN}), зарплата −${(S.crews.length * 0.9).toFixed(1)} оч/мин · резервных автотрансформаторов: <b>${S.spare}</b></div>` + S.crews.filter((c) => c.job || c.veh).map((c) => {
        const j = c.job;
        if (!j) return `<div class="dw-crew">Бригада №${c.id}: возвращается на базу</div>`;
        const comp = g.comps.get(j.id) || g.lines.find((l) => l.id === j.id);
        const k = 1 - j.left / j.total;
        const what = j.kind === 'net' ? 'сетка над дорогой' : j.shelter ? `${COMP[comp?.k]?.net ? 'сетка' : 'укрытие'}: ${comp?.name}` : comp?.name || 'ЛЭП';
        return `<div class="dw-crew">Бригада №${c.id}: ${esc(what)} — <span class="${j.state === 'waitfire' ? 'warn' : ''}">${CREW_ST[j.state] || ''}</span><div class="bar"><i style="width:${(k * 100).toFixed(0)}%"></i></div></div>`;
      }).join('');
      const dmg = [];
      for (const o of g.objs(side)) for (const c of o.comps) if (c.state !== 'ok') dmg.push(c);
      for (const l of g.lines) if (l.side === side && l.cut) dmg.push(l);
      $('dw-crews').innerHTML += `<div class="dw-note">Бригады на зарплате: ремонт повреждённого — бесплатно, за уничтоженное оборудование (трансформатор, пролёт, резервуар…) платите один раз при выезде. В очереди ${S.queue.length}. Пожары тушат пожарные части.</div>`;
      $('dw-dmg').innerHTML = dmg.map((c) => {
        const crew = S.crews.find((w) => w.job?.id === c.id);
        const inQ = S.queue.includes(c.id);
        const name = c.pylons ? `ЛЭП ${c.kv} кВ` : `${c.name}`;
        const where = c.pylons ? '' : ` · ${c.obj.name}`;
        const fe = c.fire > 0 ? (c.fireEngine ? ' · тушат пожарные' : ' · горит, пожарные в пути/нет машин') : '';
        const st = crew ? `бригада №${crew.id}: ${CREW_ST[crew.job.state] || ''}` : inQ ? (c.blockedUntil > this.sim.time ? 'нет проезда (мост)' : c.waitFunds ? `ждёт денег на оборудование (${c.waitFunds})` : 'в очереди — ждёт свободную бригаду') : '';
        const k = g.repairCost(side, c);
        return `<div class="dw-row small"><div><b class="${c.pylons ? 'warn' : ST_CLS[c.state]}">${esc(name)}</b><small>${esc(where)}${fe}${st ? ' · ' + esc(st) : ''}</small></div>${crew || inQ ? `<span class="muted">${k || ''}</span>` : `<button data-repair="${c.id}">${k ? 'Ремонт ' + k : 'Ремонт'}</button>`}</div>`;
      }).join('') || '<div class="dw-note">всё исправно</div>';
    }
    else if (this.state.tab === 'econ') this.buildTab();
    else if (this.state.tab === 'state') { const sub = this.state.gsub || 'econ'; if (sub === 'econ') this.econ('dw-state'); else this.govt(sub); }
    else if (this.state.tab === 'res') this.researchTab();
    if (force || this.state.selObj || this.state.selAD) this.card();
  }

  researchTab() {
    const g = this.g, side = this.side, T = g.state.side[side], R = g.res.side[side], t = this.sim.time;
    const bar = (k) => `<div class="bar"><i style="width:${(100 * Math.max(0, Math.min(1, k))).toFixed(0)}%"></i></div>`;
    let h = `<div class="dw-note">Исследования открывают новые дроны, ПВО и постройки. Идёт одна тема за раз; улучшения (НИОКР) — параллельно, внизу.</div>`;
    if (R.cur) { const Q = RESEARCH[R.cur.id]; h += `<div class="dw-crew">${icon('flask')} <b>${esc(Q.name)}</b> — ещё ${rmin(this.sim, R.cur.until - t)} мин${bar(1 - (R.cur.until - t) / R.cur.total)}</div>`; }
    const CI = { 'Дроны': icon('target'), 'ПВО': icon('shield'), 'Строительство': icon('crane') };
    for (const cat of ['Дроны', 'ПВО', 'Строительство']) {
      h += `<div class="dw-sub">${CI[cat]} ${cat}</div><div class="dw-tiles">`;
      for (const [id, Q] of Object.entries(RESEARCH)) {
        if (Q.cat !== cat) continue;
        const done = g.res.has(side, id), av = g.res.available(side, id), cur = R.cur?.id === id;
        const req = (Q.req || []).filter((q) => !g.res.has(side, q)).map((q) => `«${RESEARCH[q].name}»`).join(', ');
        const right = done ? '<span class="price ok">✔</span>' : cur ? '<span class="price">идёт</span>' : av ? `<span class="price">${g.res.cost(side, id)}</span>` : `<span class="price">${icon('lock')}</span>`;
        const clickable = !done && !cur && av && !R.cur;
        h += `<div class="dw-tile${done ? ' sel' : ''}${!done && !av ? ' locked' : ''}" ${clickable ? `data-res="${id}"` : ''} title="${esc(Q.desc)}"><b>${esc(Q.name)}</b><small>${esc(Q.desc)}${req ? ` · сначала ${esc(req)}` : ` · ${rmin(this.sim, Q.time)} мин`}</small>${right}</div>`;
      }
      h += '</div>';
    }
    h += `<div class="dw-sub">НИОКР — улучшения</div>`;
    if (T.research) { const L = TECH[T.research.branch].levels[T.tech[T.research.branch]]; h += `<div class="dw-crew">${esc(L.name)} — ${Math.ceil((T.research.until - t) / 60)} мин${bar(1 - (T.research.until - t) / T.research.total)}</div>`; }
    for (const [b, B] of Object.entries(TECH)) {
      const lv = T.tech[b], nx = B.levels[lv];
      h += `<div class="dw-row small"><div><b>${esc(B.name)}</b> <small>${B.levels.map((q, i) => `<span class="${i < lv ? 'ok' : 'muted'}" title="${esc(q.desc)}">${i < lv ? '✔' : '○'} ${esc(q.name)}</span>`).join(' · ')}</small>${nx ? `<small>дальше: ${esc(nx.desc)}</small>` : ''}</div>${nx && !T.research ? `<button data-tech="${b}">${nx.cost}</button>` : ''}</div>`;
    }
    setHTML($('dw-res'), h);
  }
  govt(sub = 'law') {
    const g = this.g, side = this.side, T = g.state.side[side], t = this.sim.time;
    const bar = (k) => `<div class="bar"><i style="width:${(100 * Math.max(0, Math.min(1, k))).toFixed(0)}%"></i></div>`;
    const cd = t < T.lawT ? ` <small class="muted">(менять можно через ${Math.ceil(T.lawT - t)} с)</small>` : '';
    let h = `<div class="dw-sub">Законы${cd}</div>`;
    for (const [id, L] of Object.entries(LAWS)) h += `<label class="dw-check dw-law" title="${esc(L.desc)}"><input type="checkbox" data-law="${id}" ${T.laws[id] ? 'checked' : ''}> <b>${esc(L.name)}</b><small>${esc(L.desc)}</small></label>`;
    h += `<div class="dw-btns"><span class="muted">налоги:</span>${TAXES.map((q, i) => `<button data-tax="${i}" class="${T.tax === i ? 'sel' : ''}" title="налоги ×${q.k}, довольство ${q.happy >= 0 ? '+' : ''}${Math.round(q.happy * 100)}%">${q.name}</button>`).join('')}</div>`;
    h += `<div class="dw-btns"><span class="muted">мобилизация:</span>${MOBIL.map((q, i) => `<button data-mobil="${i}" class="${T.mobil === i ? 'sel' : ''}" title="${esc(q.desc)}">${q.name}</button>`).join('')}</div><div class="dw-note">${esc(MOBIL[T.mobil].desc)}</div>`;
    h += `<div class="dw-sub">Финансы и мир</div><div class="dw-income">Инфляция <b class="${T.infl > 0.1 ? 'bad' : ''}">${Math.round(T.infl * 100)}%</b> (дроны, ПВО и стройка дороже, люди недовольны; растёт, когда военные траты обгоняют доход) · курс <b>${T.rate.toFixed(2)}</b> (экспорт и пошлины ×курс) · цена зерна <b>×${g.state.grainPrice.toFixed(2)}</b><br>Репутация в мире <b class="${T.rep < 35 ? 'bad' : ''}">${Math.round(T.rep)}</b>/100: удары рядом с жильём противника снижают её, выполненные контракты повышают. ${T.rep < 35 ? '<span class="bad">Санкции: комплектующие дороже, зерно дешевле.</span>' : T.aid ? '<span style="color:var(--ok)">Союзники помогают: +4 оч/мин и резервные трансформаторы.</span>' : 'От 55 и при слабом тыле — помощь союзников.'}</div>`;
    const debt = (kind) => T.debts.find((d) => d.kind === kind);
    h += `<div class="dw-btns"><button data-credit="credit" ${debt('credit') ? 'disabled' : ''} title="+600 сейчас, возврат 780 за 30 мин">Кредит +600</button><button data-credit="bonds" ${debt('bonds') ? 'disabled' : ''} title="+400 сейчас, погашение 480 за 40 мин; только при устойчивости от 70">Военные облигации +400</button>${T.debts.map((d) => `<span class="muted">${d.kind === 'bonds' ? 'облигации' : 'кредит'}: осталось ${d.left} (${d.perMin.toFixed(0)}/мин)</span>`).join(' ')}</div>`;
    const offers = T.contracts.filter((c) => c.state !== 'expired');
    h += `<div class="dw-sub">Иностранные заказы</div>` + (offers.map((c) => `<div class="dw-row small"><div><b>${esc(c.title)}</b><small>${c.state === 'offer' ? `предложение ещё ${Math.ceil(c.expires - t)} с` : c.state === 'active' ? `выполнено ${Math.round((100 * c.progress) / c.need)}% · осталось ${Math.ceil((c.until - t) / 60)} мин` : c.state === 'done' ? 'выполнен' : 'сорван'}${c.reward ? ` · премия ${c.reward}` : ''}</small>${c.state === 'active' ? bar(c.progress / c.need) : ''}</div>${c.state === 'offer' ? `<button data-contract="${c.id}">${c.price ? `Купить ${c.price}` : 'Принять'}</button>` : ''}</div>`).join('') || '<div class="dw-note">нет предложений — заказы приходят раз в 12–20 минут</div>');
    if (T.armsCredit) h += `<div class="dw-note">Оплачено ЗРК по контракту: ${T.armsCredit} — ставьте на вкладке «ПВО» бесплатно.</div>`;
    h += `<div class="dw-sub">Национальные проекты</div>`;
    if (T.project) { const P = PROJECTS[T.project.id]; h += `<div class="dw-crew">${esc(P.name)} — строится ${Math.ceil((T.project.until - t) / 60)} мин${bar(1 - (T.project.until - t) / T.project.total)}</div>`; }
    for (const [id, P] of Object.entries(PROJECTS)) { const done = T.projects.includes(id); h += `<div class="dw-row small"><div><b class="${done ? 'ok' : ''}">${esc(P.name)}${done ? ' ✔' : ''}</b><small>${esc(P.desc)} · ${Math.round(P.time / 60)} мин</small></div>${done || T.project ? '' : `<button data-project="${id}">${Math.round(P.cost * g.state.k(side, 'build'))}</button>`}</div>`; }
    if (T.temp.length || T.log.length) h += `<div class="dw-sub">События</div>` + T.temp.map((e) => `<div class="dw-note">⏳ ${esc(e.text)} — ещё ${Math.ceil((e.until - t) / 60)} мин</div>`).join('') + T.log.slice(-4).reverse().map(([, txt]) => `<div class="dw-note muted">${esc(txt)}</div>`).join('');
    if (sub === 'law') { setHTML($('dw-state'), h); return; }
    h = '';
    // Области: у каждого города своя область и губернатор со специализацией
    h += `<div class="dw-sub">Области</div>`;
    const cities = g.infra.cities(side), EI = g.infra.side[side];
    cities.forEach((c, i) => {
      const ss = g.world.settlements.filter((q) => q.side === side && q.region === i);
      const pop = ss.reduce((a, q) => a + q.pop, 0), hp = ss.reduce((a, q) => a + q.pop * q.happy, 0) / Math.max(1, pop);
      const cur = EI.spec[i] || 'none', wait = t < (EI.specT[i] || 0);
      h += `<div class="dw-row small"><div><b>Область «${esc(c.name)}»</b><small>${Math.round(pop / 1000)} тыс. жителей, ${ss.length} поселений · довольство ${Math.round(hp * 100)}% · ${c.water === false ? '<span class="bad">нет воды</span>' : 'вода есть'} · ${esc(REGION_SPEC[cur].name)}${REGION_SPEC[cur].desc ? ` — ${esc(REGION_SPEC[cur].desc)}` : ''}</small><div class="dw-btns">${Object.entries(REGION_SPEC).filter(([k]) => k !== 'none').map(([k, R]) => `<button data-region="${i}:${k}" class="${cur === k ? 'sel' : ''}" ${wait || cur === k ? 'disabled' : ''} title="${esc(R.desc)} (80 оч., менять раз в 10 мин)">${esc(R.name)}</button>`).join('')}</div></div></div>`;
    });
    const E = g.state.side[this.enemy];
    h += `<div class="dw-sub">Рейтинг страны</div><div class="dw-income">Вы <b>${g.state.rating(side)}</b> · противник ≈ <b>${g.state.rating(this.enemy)}</b> (экономика, люди, стройка, НИОКР, репутация)${T.ecoWin > 0 ? `<br><span style="color:var(--ok)">Экономическая победа близко: ${Math.round((100 * T.ecoWin) / 900)}%</span>` : ''}${E.ecoWin > 0 ? `<br><span class="bad">Противник близок к экономической победе: ${Math.round((100 * E.ecoWin) / 900)}%</span>` : ''}<br><small>Экономическая победа: экономика вдвое сильнее противника 15 минут подряд (после 1,5 ч боёв), а его тыл ниже 60.</small></div>`;
    setHTML($('dw-state'), h);
  }

  econ(target = 'dw-econ') {
    const g = this.g, side = this.side, S = this.S, I = S.inc || {}, E = g.econ.summary(side);
    const k = (v) => (v >= 10000 ? `${(v / 1000).toFixed(0)} тыс.` : Math.round(v).toLocaleString('ru-RU'));
    const plus = [['промышленность', I.industry], ['налоги', I.tax], ['магазины и производство', I.trade], ['АЗС', I.fuel], ['фуры (пошлины)', I.transit], ['экспорт зерна', I.agro], ['инвестиции и сборы', I.other]];
    const minus = [['зарплата бригад', -(I.wages || 0)], ['содержание армии', -(I.upkeep || 0)], ['законы, кредиты, помощь', -(I.state || 0)]];
    const civ = plus.reduce((a, [, v]) => a + (v || 0), 0), mil = minus.reduce((a, [, v]) => a + (v || 0), 0);
    let h = `<div class="dw-sub">Бюджет, оч/мин</div><div class="dw-income"><b style="color:var(--ok)">+${civ.toFixed(1)}</b> гражданская экономика: ${plus.map(([n, v]) => `${n} ${(v || 0).toFixed(1)}`).join(' · ')}<br><b class="bad">−${mil.toFixed(1)}</b> ${minus.map(([n, v]) => `${n} ${v.toFixed(1)}`).join(' · ')}<br>Расходы на удары и ПВО — разовые (пуски, позиции, ракеты).</div>`;
    h += `<div class="dw-sub">Население</div><div class="dw-income">Жителей <b>${k(E.pop)}</b> · довольство <b>${(E.happy * 100).toFixed(0)}%</b> (свет, товары, страх после ударов) · мобилизовано ${k(E.mobilized)} — рабочие руки <b class="${E.labor < 0.9 ? 'bad' : ''}">${(E.labor * 100).toFixed(0)}%</b>. Налоги и промышленность падают, когда людей забирают в расчёты ПВО, бригады и на пусковые.</div>`;
    const upk = Object.entries(UPKEEP).map(([t, v]) => [t, g.ad.filter((a) => a.side === side && !a.dead && a.type === t).length, v]).filter(([, n]) => n);
    h += `<div class="dw-income">Содержание: ${upk.map(([t, n, v]) => `${esc(DW_AD[t].name[side])} ×${n} (${(n * v).toFixed(1)})`).join(' · ') || 'нет позиций'} · стартовые позиции ${g.objs(side, 'launch').filter((o) => !o.build).length} × 0,8</div>`;
    h += `<div class="dw-sub">Пуски и комплектующие</div><div class="dw-income">Стартовые позиции: свободно <b>${E.launchFree}</b> из ${E.launchCap} пусков за 5 мин (${LAUNCH_PER} на исправную пусковую, реконструкция +50%) · комплектующие для дронов <b class="${E.parts < 10 ? 'bad' : ''}">${Math.round(E.parts)}</b>/150 (везут фуры с импортом; нет запаса — дроны дороже в 1,5 раза)</div>`;
    h += `<div class="dw-sub">Сельское хозяйство</div><div class="dw-income">Агрофирм ${E.farms}, полей ${E.fields} · в работе ${E.working}${E.noFuel ? ` · <span class="bad">без солярки ${E.noFuel}</span>` : ''}<br>Зерно на токах ${k(E.farmGrain)} т · на элеваторах ${k(E.elevGrain)} из ${k(E.elevCap)} т · собрано ${k(E.harvested)} т · продано ${k(E.exported)} т${E.lostGrain ? ` · <span class="bad">потеряно ${k(E.lostGrain)} т</span>` : ''}</div>`;
    const I2 = g.infra, EI = I2.side[side];
    const ships = I2.ships.filter((q) => q.side === side);
    const dryCities = g.world.settlements.filter((q) => q.side === side && q.type === 'city' && q.water === false).map((q) => q.name);
    h += `<div class="dw-sub">Ресурсы и транспорт</div><div class="dw-income">Сезон: <b>${I2.season().name}</b> · стройматериалы <b>${Math.round(EI.mat)}</b> (скидка 20% на стройку и ремонт, пока хватает; дают цементные заводы и импорт) · уголь: ${I2.has(side, 'coalmine') ? 'своя шахта' : 'только склад ТЭС'} · топливо: ${I2.has(side, 'refinery') ? 'свой НПЗ' : 'нефтебаза'}<br>Вода: ${dryCities.length ? `<span class="bad">нет воды в городах: ${dryCities.map(esc).join(', ')}</span>` : 'в городах есть'}${ships.length ? `<br>Экспорт в пути: ${ships.map((q) => `${q.kind === 'train' ? 'поезд' : 'баржа'} ${Math.round(q.load / 1000)} тыс. т${q.wait ? ' <span class="bad">стоит у разрушенного моста</span>' : ''}`).join(', ')}` : ''}${I2.paving.filter((q) => q.side === side).length ? `<br>Дорожники в работе: ${I2.paving.filter((q) => q.side === side).length}` : ''}${I2.newLines.filter((q) => q.side === side).length ? ` · строится ЛЭП: ${I2.newLines.filter((q) => q.side === side).map((q) => esc(q.name)).join(', ')}` : ''}</div>`;
    const farms = g.econ.farms.filter((f) => f.side === side);
    h += farms.map((f) => `<div class="dw-row small"><div><b>${esc(f.name)}</b><small>${STAGE_NAME[f.stage] || ''}${f.work ? ` · ${f.work.kind === 'combine' ? 'комбайны' : 'тракторы'} в поле` : ''}${f.noFuel ? ' · <span class="bad">нет солярки</span>' : ''} · ГСМ ${f.tank} · на току ${Math.round(f.grain)} т</small></div></div>`).join('');
    const ai = this.sim.ais?.find((a) => a.side === this.enemy);
    if (ai?.intent) h += `<div class="dw-sub">Разведка</div><div class="dw-income">Штаб противника ${esc(ai.intent)}${ai.doctrine ? ` · доктрина: ${esc(ai.doctrine.name)}` : ''}</div>`;
    // История показателей (каждые 30 с, до 2 часов)
    const H = g.state.side[side].hist;
    if (H.length > 2) {
      const spark = (i, label, col) => { const v = H.map((q) => q[i]), lo = Math.min(...v), hi = Math.max(...v, lo + 1); const pts = v.map((y, k) => `${((k / (v.length - 1)) * 100).toFixed(1)},${(24 - ((y - lo) / (hi - lo)) * 22).toFixed(1)}`).join(' '); return `<div>${label}: <b>${v[v.length - 1]}</b><svg viewBox="0 0 100 26" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg></div>`; };
      h += `<div class="dw-sub">История за ${Math.round(H.length / 2)} мин</div><div class="dw-spark">${spark(0, 'доход, оч/мин', '#7ddc6a')}${spark(1, 'устойчивость тыла', '#f0c34a')}${spark(2, 'свет, %', '#ffe27a')}${spark(3, 'жителей, тыс.', '#9cc8ff')}</div>`;
    }
    setHTML($(target), h);
  }
  // Стройка: что строится, что ждёт подключения
  buildTab() {
    const g = this.g, side = this.side;
    const bld = g.objects.filter((o) => o.side === side && o.build);
    const unplugged = g.objs(side).filter((o) => g.econ.needsGrid(o) && !o.grid && !o.build);
    let h = '';
    if (bld.length || unplugged.length) h += `<div class="dw-sub">Идёт стройка</div>` + bld.map((o) => `<div class="dw-crew" data-obj="${o.id}">${esc(o.name)} — ${o.build.grid ? '<span class="bad">готов, ждёт подключения к сети</span>' : o.build.up ? `реконструкция до ${(o.level || 1) + 1}-го ур.` : `строится, ещё ${rmin(this.sim, o.build.until - this.sim.time)} мин`}${o.build.grid ? ` <button data-grid="${o.id}">${icon('plug')} Подключить</button>` : ''}<div class="bar"><i style="width:${(100 * (1 - (o.build.until - this.sim.time) / o.build.total)).toFixed(0)}%"></i></div></div>`).join('') + unplugged.map((o) => `<div class="dw-crew" data-obj="${o.id}">${esc(o.name)} — <span class="bad">не подключён</span> <button data-grid="${o.id}">${icon('plug')} Подключить</button></div>`).join('');
    h += `<label class="dw-check"><input type="checkbox" data-act="flows" ${this.state.showFlows ? 'checked' : ''}> Слой потоков на карте: зерно, топливо, товары</label>`;
    setHTML($('dw-econ'), h);
  }

  // Название типа объекта; макет противник видит как настоящую подстанцию
  kindName(o) { return o.mimic ? (o.side === this.side ? `${KIND_NAME[o.kind]}` : KIND_NAME[o.mimic]) : KIND_NAME[o.kind]; }
  objRow(o) {
    const bad = o.comps.filter((c) => c.state !== 'ok').length;
    const fire = o.comps.some((c) => c.fire > 0);
    const st = o.kind === 'bridge' ? (this.g.bridgeCap(o) === 0 ? 'destroyed' : bad ? 'damaged' : 'ok') : bad === 0 ? 'ok' : o.comps.filter((c) => c.state === 'destroyed').length > o.comps.length / 2 ? 'destroyed' : 'damaged';
    const extra = o.kind === 'ps110' && o.side === this.side ? ` · ${((o.supply ?? 1) * 100).toFixed(0)}%` : '';
    return `<div class="dw-row small${this.state.selObj === o.id ? ' sel' : ''}" data-obj="${o.id}"><div><b class="${ST_CLS[st]}">${esc(o.kind === 'bridge' ? o.name.replace(/^Мост через /, 'Мост ') : o.name)}</b><small>${this.kindName(o)}${bad ? ` · неисправно ${bad}/${o.comps.length}` : ''}${extra}${fire ? ' · ' + icon('alert') : ''}</small></div></div>`;
  }

  // ------------------------------------------------ Карточка
  card() {
    const g = this.g, side = this.side;
    const el = $('dw-card');
    const o = this.state.selObj ? g.obj(this.state.selObj) : null;
    const a = this.state.selAD ? g.ad.find((q) => q.id === this.state.selAD) : null;
    const v = this.state.selVeh ? g.logi.vehicles.find((q) => q.id === this.state.selVeh) : null;
    if (!o && !a && !v) { el.classList.remove('show'); return; }
    if (v && !o && !a) {
      const own = v.side === side;
      const what = { import: 'везёт товар в распредцентр (пошлина при доставке)', export: 'везёт экспорт на границу (выручка на погранпереходе)', deliver: v.kind === 'tanker' ? 'везёт топливо на АЗС' : 'развозит товар по магазинам', resupply: 'везёт боеприпасы на позицию ПВО', repair: 'ремонтная бригада', fire: 'выезд на пожар' }[v.task.type] || '';
      el.innerHTML = `<button class="dw-close" data-act="close">${icon('close')}</button><div class="dw-title">${esc(VEH[v.kind].name)}</div><div class="dw-subt">${own ? 'ваш транспорт' : 'транспорт противника (обнаружен разведкой)'} · ${v.dead ? 'уничтожен' : v.state === 'back' && v.task.type !== 'export' ? 'возвращается' : v.state === 'work' ? 'на месте работ' : what}</div>${!own && !v.dead && (v.kind === 'fura' || v.kind === 'supply' || v.kind === 'tanker') ? '<div class="dw-note">Цель для барражирующих боеприпасов: выберите «Ланцет»/Warmate на вкладке «Удары» и кликните по машине.</div>' : ''}`;
      el.classList.add('show');
      return;
    }
    let h = `<button class="dw-close" data-act="close">${icon('close')}</button>`;
    if (o) {
      const own = o.side === side;
      const stockInfo = o.stock !== undefined && own ? ` · товара ${o.stock}${o.cut ? ' · <span class="bad">отрезан: нет проезда</span>' : ''}` : o.engines !== undefined && own ? ` · свободных машин ${o.engines}` : '';
      h += `<div class="dw-title">${esc(o.name)}</div><div class="dw-subt">${this.kindName(o)}${stockInfo} · ${own ? 'ваш объект' : CIVIL.has(o.kind) ? 'гражданский объект противника — удары запрещены' : 'объект противника'}${o.kind === 'ps110' && own ? ` · питание района ${((o.supply ?? 1) * 100).toFixed(0)}%` : ''}${o.kind === 'bridge' ? ` · пропускная способность ${(g.bridgeCap(o) * 100).toFixed(0)}%` : ''}</div>`;
      if (own && (o.build || BUILD[o.kind] || o.grain !== undefined || o.kind === 'factory')) {
        const lv = o.level || 1;
        let e = `<div class="dw-income">Уровень <b>${lv}</b>${o.grain !== undefined ? ` · зерна ${Math.round(o.grain)} т из ${Math.round(g.econ.elevCap(o))}` : ''}${o.kind === 'hub' ? ` · на складе ${o.stock}` : ''}`;
        if (o.kind === 'bess') e += ` · заряд ${Math.round((o.charge ?? 1) * 100)}%`;
        if (o.kind === 'solar') e += ` · выработка ${Math.round(o.gen || 0)} МВт`;
        if (o.idle) e += ` · <span class="warn">простой: ${esc(o.idle)}</span>`;
        if (o.kind === 'factory' && !o.build) e += ` <button data-act="evac" data-id="${o.id}" title="вывезти оборудование вглубь тыла (не ближе 14 км к фронту): 300 оч., 10 мин без производства">Эвакуировать в тыл</button>`;
        if (o.kind === 'pontoon') e += ` · ${g.obj(o.bridge) && g.bridgeCap(g.obj(o.bridge)) === 0.4 ? 'машины идут по понтонам' : 'в резерве: мост цел'}`;
        if (g.econ.needsGrid(o) && !o.grid) { const q = g.econ.gridCheck(side, o.id); e += ` · <span class="bad">не подключён к сети</span> ` + (q.err ? `<span class="warn">${esc(q.err)}</span>` : `<button data-grid="${o.id}" title="протянуть ${q.f.kv === 110 ? 'ЛЭП 110 кВ к ближайшей подстанции' : 'отпайку 10 кВ от ближайшей ТП или подстанции'} (${(q.f.L / 1000).toFixed(1)} км)">${icon('plug')} Подключить к сети — ${q.cost}</button>`); }
        if (o.build?.grid) e += ` · <span class="warn">построен, ждёт подключения</span>`;
        else if (o.build) e += ` · <span class="warn">${o.build.up ? 'реконструкция' : 'строится'}: ${(100 * (1 - (o.build.until - this.sim.time) / o.build.total)).toFixed(0)}%</span>`;
        else if (BUILD[o.kind] && lv < 3) e += ` <button data-upg="${o.id}" title="реконструкция: больше выручки и вместимости">Реконструкция до ${lv + 1} ур. — ${upgradeCost(o)}</button>`;
        h += e + '</div>';
      }
      h += '<div class="dw-comps">';
      for (const c of o.comps) {
        const C = COMP[c.k];
        const inQ = this.S.queue.includes(c.id) || this.S.crews.some((w) => w.job?.id === c.id);
        let btns = '';
        if (own) {
          if (c.state !== 'ok') { const k = g.repairCost(side, c); btns += inQ ? '<span class="muted">в ремонте</span>' : `<button data-repair="${c.id}" title="${k ? 'оборудование взамен уничтоженного' : 'бригады на зарплате — бесплатно'}">Ремонт${k ? ' ' + k : ''}</button>`; }
          else if ((C.shelter || C.net) && shelterDef(c, c.shelter + 1)) { const L = c.shelter + 1, Sd = shelterDef(c, L); btns += this.S.queue.includes('S' + c.id) || this.S.crews.some((w) => w.job?.shelter && w.job.id === c.id) ? `<span class="muted">${C.net ? 'ставят сетку' : 'строится укрытие'}</span>` : `<button data-shelter="${c.id}" data-level="${L}" title="${esc(Sd.name)}">${C.net ? 'Сетка' : L === 1 ? 'Габионы' : 'Бетон'} ${Sd.cost}</button>`; }
        } else if (c.state === 'ok' && !CIVIL.has(o.kind)) btns += `<button data-target="${c.id}">Цель</button>`;
        h += `<div class="dw-comp"><span class="dot ${ST_CLS[c.state]}"></span><span class="nm">${esc(c.name)}${c.shelter ? ` <small>[${C.net ? 'сетка' : c.shelter === 1 ? 'габионы' : 'бетон'}]</small>` : ''}${c.fire > 0 ? ' ' + icon('alert') : ''}</span><span class="hp"><i style="width:${(c.hp * 100).toFixed(0)}%"></i></span><span class="st">${ST_TEXT[c.state]}</span>${btns}</div>`;
      }
      h += '</div>';
      if (!own) h += `<div class="dw-note">Выберите на вкладке «Удары» тип дронов и кликните по узлу — или нажмите «Цель» у узла.</div>`;
    } else if (a) {
      const T = DW_AD[a.type];
      const own = a.side === side;
      h += `<div class="dw-title">${esc(a.name)}</div><div class="dw-subt">${esc(T.sub[a.side])} · ${a.dead ? 'уничтожен' : a.state === 'deploying' ? 'развёртывание' : a.state === 'moving' ? 'на марше' : 'готов'}${own ? '' : ' · обнаружен разведкой'}</div>`;
      if (own) {
        h += `<div class="dw-note">${esc(T.desc)}</div><div class="dw-stats">Дальность ${(T.range / 1000).toFixed(1)} км${T.radar ? ` · РЛС ${(T.radar / 1000).toFixed(0)} км` : ''}${a.missiles ? ` · ракет ${a.missiles}` : ''}${T.ammo ? ` · боезапас ${Math.round(a.ammo)}` : ''}${a.type === 'icpt' ? ` · перехватчиков ${a.stock}` : ''} · сбито ${a.kills || 0}${['mog', 'spaag', 'icpt'].includes(a.type) ? (g.linked(a) ? ' · наводка РЛС: есть' : ' · <span class="warn">нет связи с РЛС — огонь без наводки</span>') : ''}${a.supplyComing ? ' · <b>боеприпасы в пути</b>' : a.supplyCut && g.sim.time - a.supplyCut < 90 ? ' · <span class="bad">нет подъезда для снабжения — переставьте ближе к дороге</span>' : ''}</div>`;
        if (a.type === 'sam') h += `<div class="dw-btns"><button data-roe="all" class="${a.roe === 'all' ? 'sel' : ''}">Огонь по всем целям</button><button data-roe="threat" class="${a.roe !== 'all' ? 'sel' : ''}">Беречь ракеты (только угрозы)</button></div>`;
        if (T.mobile) h += `<div class="dw-note">ПКМ по карте — переместить (${kmh(T.mobile)} км/ч, потом развёртывание).</div>`;
      } else h += `<div class="dw-note">Цель для барражирующих боеприпасов: выберите «${this.side === 'red' ? 'Ланцет-3' : 'Warmate'}» на вкладке «Удары» и кликните по позиции.</div>`;
    }
    el.innerHTML = h;
    el.classList.add('show');
  }

  onPanel(e) {
    const t = e.target.closest('[data-tab],[data-bgrp],[data-gsub],[data-order],[data-cancel],[data-res],[data-grid],[data-ad],[data-drone],[data-wave],[data-obj],[data-selad],[data-repair],[data-shelter],[data-roe],[data-act],[data-target],[data-shed],[data-gtu],[data-build],[data-upg],[data-law],[data-tax],[data-mobil],[data-project],[data-tech],[data-credit],[data-contract],[data-region]');
    if (!t) return;
    const g = this.g, side = this.side;
    const d = t.dataset;
    if (d.tab) { this.state.tab = d.tab; this.build(); }
    else if (d.bgrp !== undefined) { this.state.bgrp = Number(d.bgrp); this.build(); }
    else if (d.gsub) { this.state.gsub = d.gsub; this.build(); }
    else if (d.ad) { this.state.mode = this.state.mode === 'ad:' + d.ad ? null : 'ad:' + d.ad; this.build(); }
    else if (d.drone) { this.state.mode = this.state.mode === 'strike:' + d.drone ? null : 'strike:' + d.drone; this.state.route = []; this.build(); }
    else if (d.wave) { this.state.mode = this.state.mode === 'wave' ? null : 'wave'; this.state.route = []; this.build(); }
    else if (d.order) { const [k, n] = d.order.split(':'); this.issue('dw', 'orderDrones', side, k, Number(n)); }
    else if (d.cancel !== undefined) this.issue('dw', 'cancelOrder', side, Number(d.cancel));
    else if (d.res) this.issue('dw', 'startLab', side, d.res);
    else if (d.obj) { const o = g.obj(Number(d.obj)); this.select(o, null); this.focus(o.x, o.y, 0.35); }
    else if (d.selad) { const a = g.ad.find((q) => q.id === Number(d.selad)); this.select(null, a); this.focus(a.x, a.y, 1.5); }
    else if (d.repair) this.issue('dw', 'repair', side, d.repair);
    else if (d.shelter) this.issue('dw', 'shelter', side, d.shelter, Number(d.level));
    else if (d.roe) this.issue('dw', 'setROE', side, this.state.selAD, d.roe);
    else if (d.target) {
      const c = g.comps.get(d.target);
      if (!this.state.mode?.startsWith('strike:') && this.state.mode !== 'wave') { this.state.tab = 'strike'; this.state.mode = side === 'red' ? 'strike:shahed' : 'strike:lyutyi'; this.build(); }
      this.fire(c.x, c.y, c.obj, c);
    } else if (d.act === 'close') this.select(null, null);
    else if (d.act === 'ranges') this.state.showRanges = t.checked;
    else if (d.act === 'flows') this.state.showFlows = t.checked;
    else if (d.act === 'pave') { this.state.mode = this.state.mode === 'pave' ? null : 'pave'; this.build(); }
    else if (d.act === 'line') { this.state.mode = this.state.mode?.startsWith('line') ? null : 'line'; this.build(); }
    else if (d.act === 'evac') { this.state.mode = 'evac:' + d.id; this.build(); }
    else if (d.region) { const [i, spec] = d.region.split(':'); this.issue('dw', 'setRegion', side, Number(i), spec); }
    else if (d.act === 'auto') this.issue('dw', 'setAuto', side, d.on ? true : t.checked);
    else if (d.act === 'crew') this.issue('dw', 'buyCrew', side);
    else if (d.act === 'spare') this.issue('dw', 'buySpare', side);
    else if (d.act === 'autoshed') this.issue('dw', 'setAutoShed', side, t.checked);
    else if (d.shed) { const [id, lv] = d.shed.split(':').map(Number); this.issue('dw', 'setShed', side, id, lv); }
    else if (d.gtu) this.issue('dw', 'buyGTU', side, Number(d.gtu));
    else if (d.act === 'net') { this.state.mode = this.state.mode === 'net' ? null : 'net'; this.build(); }
    else if (d.build) { this.state.mode = this.state.mode === 'build:' + d.build ? null : 'build:' + d.build; this.build(); }
    else if (d.upg) this.issue('dw', 'upgrade', side, Number(d.upg));
    else if (d.grid) this.issue('dw', 'gridConnect', side, Number(d.grid));
    else if (d.law) this.issue('dw', 'setLaw', side, d.law, t.checked);
    else if (d.tax) this.issue('dw', 'setTax', side, Number(d.tax));
    else if (d.mobil) this.issue('dw', 'setMobil', side, Number(d.mobil));
    else if (d.project) this.issue('dw', 'startProject', side, d.project);
    else if (d.tech) this.issue('dw', 'startResearch', side, d.tech);
    else if (d.credit) this.issue('dw', 'takeCredit', side, d.credit);
    else if (d.contract) this.issue('dw', 'acceptContract', side, Number(d.contract));
    setTimeout(() => this.update(true), 50);
  }

  select(o, a, v = null) {
    this.state.selObj = o?.id ?? null;
    this.state.selAD = a?.id ?? null;
    this.state.selVeh = v?.id ?? null;
    this.card();
  }

  // ------------------------------------------------ Карта
  objAt(x, y) {
    const g = this.g;
    let best = null, bd = Infinity;
    for (const o of g.objects) {
      if (o.kind === 'import' || !g.known(this.side, o)) continue;
      const c = Math.cos(-o.angle), s = Math.sin(-o.angle);
      const lx = (x - o.x) * c - (y - o.y) * s, ly = (x - o.x) * s + (y - o.y) * c;
      const pad = 30 / Math.max(0.05, this.view.cam.zoom) * 0.2;
      if (Math.abs(lx) < o.w / 2 + pad && Math.abs(ly) < o.h / 2 + pad) { const d = Math.hypot(lx, ly); if (d < bd) { bd = d; best = o; } }
    }
    // На обзорном масштабе — по значку
    if (!best) for (const o of g.objects) { if (o.kind !== 'import' && g.known(this.side, o) && Math.hypot(o.x - x, o.y - y) * this.view.cam.zoom < 16 * this.view.dpr) best = o; }
    return best;
  }
  compAt(o, x, y) {
    let best = null, bd = Infinity;
    for (const c of o.comps) {
      const cs = Math.cos(-c.angle), sn = Math.sin(-c.angle);
      const lx = (x - c.x) * cs - (y - c.y) * sn, ly = (x - c.x) * sn + (y - c.y) * cs;
      const d = Math.hypot(Math.max(0, Math.abs(lx) - c.w / 2), Math.max(0, Math.abs(ly) - c.h / 2));
      if (d < bd) { bd = d; best = c; }
    }
    return bd < 20 ? best : null;
  }
  adAt(x, y) {
    const z = this.view.cam.zoom, R = Math.max(14 * this.view.dpr / z, 6);
    let best = null, bd = R;
    for (const a of this.g.visibleAD(this.side)) {
      if (a.dead) continue;
      const p = a.side === this.side ? [a.x, a.y] : a.spotX?.[this.side] || [a.x, a.y];
      const d = Math.hypot(p[0] - x, p[1] - y);
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  vehAt(x, y) {
    const z = this.view.cam.zoom, R = Math.max(10 * this.view.dpr / z, 8);
    let best = null, bd = R;
    for (const v of this.g.visibleVehicles(this.side)) { if (v.dead) continue; const d = Math.hypot(v.x - x, v.y - y); if (d < bd) { bd = d; best = v; } }
    return best;
  }
  click(sx, sy, shift, ctrl = false) {
    this.burst = ctrl;
    const [x, y] = this.screenToWorld(sx, sy);
    const g = this.g, side = this.side, mode = this.state.mode;
    if (mode?.startsWith('ad:')) {
      const type = mode.slice(3);
      const err = g.canPlace(side, type, x, y);
      if (err) { this.log(`${DW_AD[type].name[side]}: ${err}`); return true; }
      this.issue('dw', 'placeAD', side, type, x, y);
      if (!shift) { this.state.mode = null; this.build(); }
      return true;
    }
    if (mode?.startsWith('build:')) {
      const kind = mode.slice(6);
      const s = g.econ.siteFor(side, kind, x, y);
      if (s.err) { this.log(`${BUILD[kind].name}: ${s.err}`); return true; }
      this.issue('dw', 'buildCivil', side, kind, x, y);
      if (!shift) { this.state.mode = null; this.build(); }
      return true;
    }
    if (mode === 'pave') {
      const q = g.infra.roadAt(side, x, y);
      if (q.err) { this.log(q.err); return true; }
      this.issue('dw', 'pave', side, x, y);
      if (!shift) { this.state.mode = null; this.build(); }
      return true;
    }
    if (mode?.startsWith('line')) {
      const o = this.objAt(x, y);
      if (!o || o.side !== side || !g.infra.lineEnds(side).includes(o)) { this.log('ЛЭП: выберите свою подстанцию или электростанцию'); return true; }
      if (mode === 'line') { this.state.mode = 'line:' + o.id; this.build(); return true; }
      const a = Number(mode.slice(5)), q = g.infra.lineCheck(side, a, o.id);
      if (q.err) { this.log(`ЛЭП: ${q.err}`); return true; }
      this.issue('dw', 'buildLine', side, a, o.id);
      this.state.mode = null; this.build();
      return true;
    }
    if (mode?.startsWith('evac:')) {
      const id = Number(mode.slice(5)), q = g.infra.evacCheck(side, id, x, y);
      if (q.err) { this.log(`Эвакуация: ${q.err}`); return true; }
      this.issue('dw', 'evacuate', side, id, x, y);
      this.state.mode = null; this.build();
      return true;
    }
    if (mode === 'net') {
      this.issue('dw', 'buildNet', side, x, y);
      if (!shift) { this.state.mode = null; this.build(); }
      return true;
    }
    if (mode?.startsWith('strike:') || mode === 'wave') {
      if (shift) { this.state.route.push({ x, y }); return true; }
      const o = this.objAt(x, y);
      const c = o && o.side !== side ? this.compAt(o, x, y) : null;
      this.fire(c ? c.x : x, c ? c.y : y, o && o.side !== side ? o : null, c);
      return true;
    }
    const a = this.adAt(x, y);
    if (a) { this.select(null, a); return true; }
    const veh = this.vehAt(x, y);
    if (veh) { this.select(null, null, veh); return true; }
    const o = this.objAt(x, y);
    this.select(o, null);
    return true;
  }
  fire(x, y, o, c) {
    const g = this.g, side = this.side;
    const route = this.state.route.slice();
    this.state.route = [];
    if (this.state.mode === 'wave') {
      const [a, b] = side === 'red' ? ['gerbera', 'shahed'] : ['bober', 'fp1'];
      this.issue('dw', 'launch', side, a, 6, x, y, { route, oid: o?.id, cid: c?.id });
      this.issue('dw', 'launch', side, b, 6, x, y, { route, oid: o?.id, cid: c?.id });
      return;
    }
    const type = this.state.mode.slice(7);
    const D = DW_DRONES[type];
    const n = this.burst ? 5 : 1;
    if (D.cls === 'hunter') {
      if (D.front) { const from = g.launchPoints(side, D)[0]; if (Math.abs(x - from.x) > D.range) { this.log(`${D.short}: район дальше ${D.range / 1000} км от передовой`); return; } }
      this.issue('dw', 'launch', side, type, n, x, y, { route });
      return;
    }
    if (D.cls === 'loiter') {
      const veh = this.vehAt(x, y);
      if (veh && veh.side !== side) {
        if (veh.kind === 'crew' || veh.kind === 'fire') { this.log('По пожарным и ремонтным бригадам удары не наносятся'); return; }
        this.issue('dw', 'launch', side, type, Math.min(n, 2), veh.x, veh.y, { vehTarget: veh.id });
        return;
      }
      const t = this.adAt(x, y);
      if (!t || t.side === side) { this.log(`${D.short}: нужна цель — позиция ПВО или машина противника, найденная разведкой`); return; }
      const p = t.spotX?.[side] || [t.x, t.y];
      const from = g.launchPoints(side, D)[0];
      if (Math.abs(p[0] - from.x) > D.range) { this.log(`${D.short}: цель дальше ${D.range / 1000} км от передовой`); return; }
      this.issue('dw', 'launch', side, type, Math.min(n, 4), p[0], p[1], { adTarget: t.id });
      return;
    }
    this.issue('dw', 'launch', side, type, D.cls === 'recon' ? 1 : n, x, y, { route, oid: o?.id, cid: c?.id });
  }
  rclick(sx, sy) {
    const [x, y] = this.screenToWorld(sx, sy);
    if (this.state.mode) { this.state.mode = null; this.state.route = []; this.build(); return; }
    const a = this.state.selAD && this.g.ad.find((q) => q.id === this.state.selAD && q.side === this.side);
    if (a) this.issue('dw', 'moveAD', this.side, a.id, x, y);
  }
  cancel() { this.state.mode = null; this.state.route = []; this.select(null, null); this.build(); }

  hint(sx, sy) {
    const [x, y] = this.screenToWorld(sx, sy);
    const g = this.g, side = this.side, mode = this.state.mode;
    if (mode?.startsWith('ad:')) {
      const type = mode.slice(3);
      const err = g.canPlace(side, type, x, y);
      return err ? `<span style="color:var(--bad)">${esc(err)}</span>` : `ЛКМ — поставить <b>${esc(DW_AD[type].name[side])}</b> (${DW_AD[type].cost} оч.), Shift — несколько`;
    }
    if (mode?.startsWith('build:')) {
      const kind = mode.slice(6), s = g.econ.siteFor(side, kind, x, y);
      return s.err ? `<span style="color:var(--bad)">${esc(s.err)}</span>` : `ЛКМ — построить <b>${esc(BUILD[kind].name)}</b> (${BUILD[kind].cost} оч., ${Math.round(BUILD[kind].time / 60)} мин). Shift — несколько. ПКМ — отмена`;
    }
    if (mode === 'pave') { const q = g.infra.roadAt(side, x, y); return q.err ? `<span style="color:var(--bad)">${esc(q.err)}</span>` : `ЛКМ — асфальтировать ${(q.len / 1000).toFixed(1)} км (${q.cost} оч., 3 мин). ПКМ — отмена`; }
    if (mode?.startsWith('line')) {
      const o = this.objAt(x, y);
      if (mode === 'line') return o && o.side === side && g.infra.lineEnds(side).includes(o) ? `ЛКМ — начать ЛЭП от «${esc(o.name)}»` : 'Выберите первую подстанцию или станцию';
      if (!o) return 'Выберите вторую подстанцию или станцию';
      const q = g.infra.lineCheck(side, Number(mode.slice(5)), o.id);
      return q.err ? `<span style="color:var(--bad)">${esc(q.err)}</span>` : `ЛКМ — ЛЭП 110 кВ до «${esc(o.name)}»: ${(q.L / 1000).toFixed(1)} км, ${q.cost} оч., 5 мин`;
    }
    if (mode?.startsWith('evac:')) { const q = g.infra.evacCheck(side, Number(mode.slice(5)), x, y); return q.err ? `<span style="color:var(--bad)">${esc(q.err)}</span>` : 'ЛКМ — перевезти завод сюда (300 оч., 10 мин без производства)'; }
    if (mode === 'net') return 'ЛКМ по дороге — натянуть сетку на ~600 м (40 оч., ставит ремонтная бригада). Shift — несколько. ПКМ — отмена';
    if (mode?.startsWith('strike:') || mode === 'wave') {
      const type = mode === 'wave' ? (side === 'red' ? 'shahed' : 'lyutyi') : mode.slice(7);
      const D = DW_DRONES[type];
      const pts = g.launchPoints(side, D);
      if (!pts.length) return '<span style="color:var(--bad)">нет исправных пусковых</span>';
      let L = 0, p = pts[0];
      for (const w of [...this.state.route, { x, y }]) { L += Math.hypot(w.x - p.x, w.y - p.y); p = w; }
      const o = this.objAt(x, y);
      const c = o && o.side !== side ? this.compAt(o, x, y) : null;
      const eta = L / (D.speed * PACE); // темп полёта
      const tgt = c ? `${o.name} → ${c.name}` : o && o.side !== side ? o.name : D.cls === 'recon' ? 'район разведки' : 'точка';
      return `Цель: <b>${esc(tgt)}</b> · подлёт ~${Math.floor(eta / 60)}:${String(Math.floor(eta % 60)).padStart(2, '0')}${this.state.route.length ? ` · через ${this.state.route.length} точ.` : ''}<br><small>ЛКМ — пуск, Shift+ЛКМ — точка маршрута, ПКМ — отмена</small>`;
    }
    const a = this.adAt(x, y);
    if (a) return `<b>${esc(a.name)}</b>${a.side === side ? '' : ' (противник)'}`;
    const o = this.objAt(x, y);
    if (o) {
      const c = this.compAt(o, x, y);
      return `<b>${esc(o.name)}</b>${c ? ` · ${esc(c.name)}: ${ST_TEXT[c.state]}${c.fire > 0 ? ', горит' : ''}` : ''}`;
    }
    return null;
  }
}
