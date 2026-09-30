// Интерфейс режима «Война дронов»: левая панель (энергосистема, ПВО, удары, ремонт),
// карточка выбранного объекта / позиции ПВО, клики по карте, подсказки.

import { DW_DRONES, DW_AD, COMP, KIND_NAME, CIVIL, dronesOf, shelterDef, GTU, PACE } from './sim/dronewar.js';
import { VEH } from './sim/dwlogi.js';
const CREW_ST = { travel: 'едет к объекту', waitfire: 'ждёт, пока потушат', work: 'ремонтирует' };

const $ = (id) => document.getElementById(id);
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
    for (const t of document.querySelectorAll('[data-dwtab]')) t.onclick = () => { this.state.tab = t.dataset.dwtab; this.build(); };
    $('dw-body').onclick = (e) => this.onPanel(e);
    $('dw-card').onclick = (e) => this.onPanel(e);
    $('dw-status').onclick = (e) => this.onPanel(e);
    this.build();
  }
  get g() { return this.sim.game; }
  get S() { return this.g.sides[this.side]; }

  // ------------------------------------------------ Панель
  build() {
    for (const t of document.querySelectorAll('[data-dwtab]')) t.classList.toggle('active', t.dataset.dwtab === this.state.tab);
    const g = this.g, side = this.side;
    let h = '';
    if (this.state.tab === 'grid') {
      h = `<div id="dw-grid"></div>`;
    } else if (this.state.tab === 'ad') {
      h += `<div class="dw-note">Выберите средство и кликните по карте на своей территории. ПКМ — отмена. Выбранную мобильную группу ПКМ перемещают.</div>`;
      for (const [k, T] of Object.entries(DW_AD)) {
        h += `<div class="dw-row${this.state.mode === 'ad:' + k ? ' sel' : ''}" data-ad="${k}" title="${esc(T.desc)}"><div><b>${esc(T.name[side])}</b><small>${esc(T.sub[side])}</small></div><span class="cost">${T.cost}</span></div>`;
      }
      h += `<label class="dw-check"><input type="checkbox" data-act="ranges" ${this.state.showRanges ? 'checked' : ''}> Показывать зоны поражения</label>`;
      h += `<div class="dw-sub">Ваши позиции</div><div id="dw-adlist"></div>`;
    } else if (this.state.tab === 'strike') {
      h += `<div class="dw-note">Выберите тип и количество, затем кликните по объекту противника. <b>Shift+клик</b> — точка маршрута (обход ПВО). Барражирующим нужна цель-позиция ПВО, найденная разведкой.</div>`;
      h += `<div class="dw-counts">${[1, 2, 4, 6, 8, 12, 20].map((n) => `<button data-count="${n}" class="${this.state.count === n ? 'sel' : ''}">${n}</button>`).join('')}</div>`;
      for (const k of dronesOf(side)) {
        const D = DW_DRONES[k];
        const cost = g.droneCost(side, k);
        h += `<div class="dw-row${this.state.mode === 'strike:' + k ? ' sel' : ''}" data-drone="${k}" title="${esc(D.desc)}"><div><b>${esc(D.name)}</b><small>${kmh(D.speed)} км/ч${D.wh ? ` · БЧ ${D.wh} кг` : ''}${D.cls === 'decoy' ? ' · ложная цель' : D.cls === 'recon' ? ' · разведка' : D.cls === 'loiter' ? ' · по ПВО и машинам' : D.cls === 'hunter' ? ' · охотник с ИИ: клик по району дорог' : ''}</small></div><span class="cost">${cost.toFixed(0)}</span></div>`;
      }
      const wave = side === 'red' ? { a: 'gerbera', b: 'shahed', label: 'Волна: ложные цели + «Герани»' } : { a: 'bober', b: 'lyutyi', label: 'Рой: «Бобры» + «Лютые»' };
      h += `<div class="dw-row${this.state.mode === 'wave' ? ' sel' : ''}" data-wave="1"><div><b>${wave.label}</b><small>по ${this.state.count} каждого типа, одним кликом</small></div><span class="cost">${Math.round((g.droneCost(side, wave.a) + g.droneCost(side, wave.b)) * this.state.count)}</span></div>`;
      h += `<div class="dw-sub">В воздухе</div><div id="dw-air"></div>`;
    } else if (this.state.tab === 'repair') {
      h += `<label class="dw-check"><input type="checkbox" data-act="auto" ${this.S.auto ? 'checked' : ''}> Авторемонт (важное — первым)</label>`;
      h += `<div class="dw-btns"><button data-act="crew" title="найм +60 и зарплата 0,9 оч/мин">+ бригада (60)</button><button data-act="spare">+ резервный АТ (150)</button><button data-act="net" class="${this.state.mode === 'net' ? 'sel' : ''}" title="Сетка над участком дороги ~600 м: машины под ней защищены от «Ланцетов», Warmate и «Бобров»">Сетка над дорогой (40)</button></div>`;
      h += `<div class="dw-note">Сетки над пролётами мостов — кнопка «Сетка» в карточке моста. Сетка останавливает лёгкие дроны (БЧ до 25 кг), от «Шахедов» и FP-2 почти не спасает.</div>`;
      h += `<div id="dw-crews"></div><div class="dw-sub">Повреждено</div><div id="dw-dmg"></div>`;
    }
    $('dw-body').innerHTML = h;
    this.update(true);
  }

  // Устойчивость тыла, фаза, директивы
  status() {
    const g = this.g, side = this.side, t = this.sim.time;
    const E = g.sides[this.enemy], S = this.S;
    const col = (v) => (v > 60 ? '#7ddc6a' : v > 30 ? '#f0c34a' : '#ef5a4a');
    const bar = (label, v) => `<div class="dw-mor"><span>${label}</span><div class="bar"><i style="width:${Math.max(0, v).toFixed(0)}%;background:${col(v)}"></i></div><b style="color:${col(v)}">${Math.max(0, v).toFixed(0)}</b></div>`;
    const mmss = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
    const PH = ['Фаза 1 · пробные удары', 'Фаза 2 · массированные удары', 'Фаза 3 · удар возмездия'];
    let h = bar('Устойчивость тыла', S.morale ?? 100) + bar('У противника', E.morale ?? 100);
    h += `<div class="dw-phase"><span>${g.prep ? 'Подготовка' : PH[g.phaseNo || 0]}</span><span>до конца ${mmss(g.endAt - t)}</span></div>`;
    const D = g.directive?.[side], T = g.directive?.[this.enemy];
    if (D) {
      const o = g.obj(D.oid);
      if (!D.done) h += `<div class="dw-dir go" data-obj="${D.oid}">🎯 <b>Директива:</b> поразить «${esc(o?.name)}» — ${mmss(D.until - t)} · премия ${D.bonus} и −6 противнику</div>`;
      else if (t - D.until < 60 || D.done === 'ok') h += `<div class="dw-dir done" data-obj="${D.oid}">${D.done === 'ok' ? '✔ Директива выполнена' : '✖ Директива сорвана'}: «${esc(o?.name)}»</div>`;
    }
    if (T && !T.done) { const o = g.obj(T.oid); h += `<div class="dw-dir threat" data-obj="${T.oid}">⚠ <b>Разведка:</b> противник готовит удар по «${esc(o?.name)}» — продержаться ${mmss(T.until - t)} (+3)</div>`; }
    $('dw-status').innerHTML = h;
  }

  update(force = false) {
    const g = this.g, S = this.S, side = this.side;
    if (!g) return;
    $('dw-pts').textContent = Math.floor(S.points);
    this.status();
    if (this.state.tab === 'grid') {
      const p110 = g.objs(side, 'ps110');
      const cities = this.sim.world.settlements.filter((s) => s.type === 'city' && s.side === side);
      const cityRow = (ci) => {
        const ps = p110.filter((p) => p.city === ci);
        const v = ps.reduce((a, p) => a + (p.supply ?? 1), 0) / Math.max(1, ps.length);
        return `<div class="dw-city"><span>${esc(cities.find((c, i) => i === ci)?.name || '')}</span><div class="bar"><i style="width:${(v * 100).toFixed(0)}%;background:${v > 0.8 ? '#ffe27a' : v > 0.4 ? '#f0a040' : '#ef5a4a'}"></i></div><b>${(v * 100).toFixed(0)}%</b></div>`;
      };
      const achr = this.sim.time < S.achrUntil;
      let h = `<div class="dw-big"><div><small>генерация</small><b>${S.gen}</b> МВт</div><div><small>потребление</small><b>${S.demand}</b> МВт</div><div><small>доставлено</small><b style="color:${S.supply > 0.8 ? 'var(--ok)' : S.supply > 0.4 ? '#f0c34a' : 'var(--bad)'}">${(S.supply * 100).toFixed(0)}%</b></div></div>`;
      if (achr) h += `<div class="dw-alarm">⚠ АЧР: аварийные отключения</div>`;
      if (S.collapse > 0) h += `<div class="dw-alarm">⚠ Энергосистема на грани: ${Math.max(0, 120 - S.collapse).toFixed(0)} с до краха — нужны средства на ремонт</div>`;
      const I = S.inc || {};
      h += `<div class="dw-income">Доход <b>${S.income >= 0 ? '+' : ''}${S.income.toFixed(1)}</b> оч/мин: промышленность ${(I.industry || 0).toFixed(0)} · магазины ${(I.trade || 0).toFixed(0)} · АЗС ${(I.fuel || 0).toFixed(0)} · фуры (пошлины и экспорт) ${(I.transit || 0).toFixed(0)} · <span class="bad">зарплата бригад ${(I.wages || 0).toFixed(0)}</span><br>Мосты ${(S.logi ?? 1) < 1 ? '<span class="bad">логистика нарушена</span>' : 'в порядке'} · нефтебаза ${((S.oil ?? 1) * 100).toFixed(0)}% · арсенал ${((S.ammo ?? 1) * 100).toFixed(0)}%</div>`;
      const P = S.moraleParts;
      if (P) {
        const parts = [['свет', P.power], ['мосты', P.bridges], ['пустые магазины и АЗС', P.shops], ['пожары', P.fires], ['погранпереход', P.border]].filter(([, v]) => v > 0.05);
        h += `<div class="dw-income">Устойчивость тыла в минуту: ${parts.length ? parts.map(([n, v]) => `<span class="bad">${n} −${v.toFixed(1)}</span>`).join(' · ') : 'потерь нет'}${P.regen ? ` · <span style="color:var(--ok)">восстановление +${P.regen.toFixed(1)}</span>` : ''}. Разрушения узлов и удары по директиве снимают устойчивость сразу.</div>`;
      }
      // Генерация по источникам
      const G = S.genBy || {};
      const src = [['tpp', 'ТЭС'], ['hpp', 'ГЭС'], ['chp', 'ТЭЦ'], ['wpp', `ВЭС (ветер ${Math.round((g.wind ?? 0.6) * 100)}%)`], ['spp', 'СЭС (солнце)'], ['import', 'импорт'], ['gtu', 'мобильные ГТУ']];
      h += `<div class="dw-sub">Генерация</div><div class="dw-gen">${src.filter(([k]) => G[k] !== undefined).map(([k, n]) => `<span><small>${n}</small><b>${Math.round(G[k] || 0)}</b></span>`).join('')}</div>`;
      h += `<div class="dw-sub">Подстанции 110 кВ — районы</div>`;
      h += `<label class="dw-check"><input type="checkbox" data-act="autoshed" ${S.autoShed ? 'checked' : ''}> Автоматический диспетчер (сам вводит веерные отключения, с задержкой)</label>`;
      for (const ps of p110) {
        const v = ps.supply ?? 1, L = ps.shed || 0;
        const status = ps.unstable ? `<span class="bad">⚠ перегрузка: сеть даёт ${Math.round(ps.avail || 0)} из ${Math.round(ps.demand || 0)} МВт — защита отключит трансформатор через ${Math.max(0, 60 - (ps.overT || 0))} с</span>` : L ? `<span class="warn">веерные отключения: ${L} очеред${L === 1 ? 'ь' : 'и'} из 5 без света по графику</span>` : 'стабильно';
        const btn = [0, 1, 2, 3, 4].map((k) => `<button data-shed="${ps.id}:${k}" class="${L === k ? 'sel' : ''}" title="${k ? `отключить ${k} очеред${k === 1 ? 'ь' : 'и'} из 5 (−${k * 20}% нагрузки)` : 'все районы под напряжением'}">${k}</button>`).join('');
        const gtus = (g.gens || []).filter((q) => q.ps === ps.id && !q.dead);
        h += `<div class="dw-ps"><div class="dw-city"><span>${esc(ps.name.replace(/^ПС 110 кВ /, ''))}</span><div class="bar"><i style="width:${(v * 100).toFixed(0)}%;background:${v > 0.8 ? '#ffe27a' : v > 0.4 ? '#f0a040' : '#ef5a4a'}"></i></div><b>${(v * 100).toFixed(0)}%</b></div>
          <small>${status} · трансформаторы ${Math.round(ps.trCap || 0)} МВт${gtus.length ? ` · ГТУ: ${gtus.map((q) => (q.state === 'ready' ? 'в работе' : 'подключается')).join(', ')}` : ''}</small>
          <div class="dw-btns"><span class="muted">очереди:</span>${btn}<button data-gtu="${ps.id}" title="${GTU.name}: подключается к шинам 10 кВ, работает на топливе с нефтебазы">+ГТУ ${GTU.cost}</button></div></div>`;
      }
      h += `<div class="dw-note">Если сеть не может дать подстанции всю мощность, без веерных отключений режим неустойчив: аварийные отключения и перегрев — через минуту защита выведет трансформатор. Плановые очереди снимают нагрузку, остальные районы стабильно со светом, а люди переносят графики легче (устойчивость тыла падает медленнее).</div>`;
      void cityRow;
      const L = g.logi.side[side];
      const withGoods = L.markets.filter((m) => m.stock > 0).length, cut = L.markets.filter((m) => m.cut).length + L.fuels.filter((m) => m.cut).length;
      const withFuel = L.fuels.filter((m) => m.stock > 0).length;
      const veh = g.logi.vehicles.filter((v) => !v.dead && v.side === side);
      const cnt = (k) => veh.filter((v) => v.kind === k).length;
      h += `<div class="dw-sub">Торговля и логистика</div><div class="dw-income">Торговля <b>+${(S.tradeAvg ?? 0).toFixed(1)}</b> оч/мин · на складе РЦ <b>${L.hub.stock}</b> · магазинов с товаром ${withGoods}/${L.markets.length} · АЗС с топливом ${withFuel}/${L.fuels.length}${cut ? ` · <span class="bad">отрезано ${cut}</span>` : ''}<br>На дорогах: фур ${cnt('fura')}, развозных ${cnt('van')}, бензовозов ${cnt('tanker')}, снабжение ПВО ${cnt('supply')}, ремонтники ${cnt('crew')}, пожарные ${cnt('fire')} · фур пришло ${L.stats.imports}, ушло на экспорт ${L.stats.exports || 0}, доставок ${L.stats.deliveries}${L.stats.lostTrucks ? ` · <span class="bad">потеряно машин ${L.stats.lostTrucks}</span>` : ''}</div>`;
      const groups = ['tpp', 'hpp', 'chp', 'wpp', 'spp', 'ps330', 'ps110', 'bridge', 'oil', 'ammo', 'factory', 'launch', 'hub', 'border', 'rembase', 'firest', 'fuel'];
      h += `<div class="dw-sub">Ваши объекты</div>`;
      for (const k of groups) for (const o of g.objs(side, k)) h += this.objRow(o);
      const E = g.sides[this.enemy];
      h += `<div class="dw-sub">Противник (разведданные)</div><div class="dw-income">Снабжение городов ≈ <b>${(E.supply * 100).toFixed(0)}%</b> · очки ≈ ${Math.round(E.points / 50) * 50}</div>`;
      for (const k of groups) for (const o of g.objs(this.enemy, k)) if (!CIVIL.has(k) && (k !== 'bridge' || o.btype === 'rail' || o.btype === 'highway')) h += this.objRow(o);
      $('dw-grid').innerHTML = h;
    } else if (this.state.tab === 'ad') {
      const list = g.ad.filter((a) => a.side === side && !a.dead);
      $('dw-adlist').innerHTML = list.map((a) => `<div class="dw-row small${this.state.selAD === a.id ? ' sel' : ''}" data-selad="${a.id}"><div><b>${esc(a.name)}</b><small>${a.state === 'deploying' ? 'развёртывание' : a.state === 'moving' ? 'на марше' : a.target ? 'ведёт огонь' : 'готов'}${a.kills ? ` · сбито ${a.kills}` : ''}${a.missiles ? ` · ракет ${a.missiles}` : ''}${a.type === 'icpt' ? ` · перехватчиков ${a.stock}` : ''}</small></div></div>`).join('') || '<div class="dw-note">нет</div>';
    } else if (this.state.tab === 'strike') {
      const air = g.drones.filter((d) => !d.dead && d.side === side && DW_DRONES[d.type].cls !== 'interceptor');
      const by = {};
      for (const d of air) by[d.type] = (by[d.type] || 0) + 1;
      $('dw-air').innerHTML = Object.entries(by).map(([k, n]) => `<div class="dw-row small"><div><b>${esc(DW_DRONES[k].short)}</b></div><span>${n}</span></div>`).join('') || '<div class="dw-note">нет</div>';
      $('dw-air').innerHTML += `<div class="dw-note">Пущено ${S.stats.launched}, попаданий ${S.stats.hits}. Сбито противника: ${S.stats.shot}.</div>`;
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
        const fe = c.fire > 0 ? (c.fireEngine ? ' · 🔥 тушат пожарные' : ' · 🔥 горит, пожарные в пути/нет машин') : '';
        const st = crew ? `бригада №${crew.id}: ${CREW_ST[crew.job.state] || ''}` : inQ ? (c.blockedUntil > this.sim.time ? 'нет проезда (мост)' : c.waitFunds ? `ждёт денег на оборудование (${c.waitFunds})` : 'в очереди — ждёт свободную бригаду') : '';
        const k = g.repairCost(side, c);
        return `<div class="dw-row small"><div><b class="${c.pylons ? 'warn' : ST_CLS[c.state]}">${esc(name)}</b><small>${esc(where)}${fe}${st ? ' · ' + esc(st) : ''}</small></div>${crew || inQ ? `<span class="muted">${k || ''}</span>` : `<button data-repair="${c.id}">${k ? 'Ремонт ' + k : 'Ремонт'}</button>`}</div>`;
      }).join('') || '<div class="dw-note">всё исправно</div>';
    }
    if (force || this.state.selObj || this.state.selAD) this.card();
  }

  objRow(o) {
    const bad = o.comps.filter((c) => c.state !== 'ok').length;
    const fire = o.comps.some((c) => c.fire > 0);
    const st = o.kind === 'bridge' ? (this.g.bridgeCap(o) === 0 ? 'destroyed' : bad ? 'damaged' : 'ok') : bad === 0 ? 'ok' : o.comps.filter((c) => c.state === 'destroyed').length > o.comps.length / 2 ? 'destroyed' : 'damaged';
    const extra = o.kind === 'ps110' && o.side === this.side ? ` · ${((o.supply ?? 1) * 100).toFixed(0)}%` : '';
    return `<div class="dw-row small${this.state.selObj === o.id ? ' sel' : ''}" data-obj="${o.id}"><div><b class="${ST_CLS[st]}">${esc(o.kind === 'bridge' ? o.name.replace(/^Мост через /, 'Мост ') : o.name)}</b><small>${KIND_NAME[o.kind]}${bad ? ` · неисправно ${bad}/${o.comps.length}` : ''}${extra}${fire ? ' · 🔥' : ''}</small></div></div>`;
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
      el.innerHTML = `<button class="dw-close" data-act="close">✕</button><div class="dw-title">${esc(VEH[v.kind].name)}</div><div class="dw-subt">${own ? 'ваш транспорт' : 'транспорт противника (обнаружен разведкой)'} · ${v.dead ? 'уничтожен' : v.state === 'back' && v.task.type !== 'export' ? 'возвращается' : v.state === 'work' ? 'на месте работ' : what}</div>${!own && !v.dead && (v.kind === 'fura' || v.kind === 'supply' || v.kind === 'tanker') ? '<div class="dw-note">Цель для барражирующих боеприпасов: выберите «Ланцет»/Warmate на вкладке «Удары» и кликните по машине.</div>' : ''}`;
      el.classList.add('show');
      return;
    }
    let h = '<button class="dw-close" data-act="close">✕</button>';
    if (o) {
      const own = o.side === side;
      const stockInfo = o.stock !== undefined && own ? ` · товара ${o.stock}${o.cut ? ' · <span class="bad">отрезан: нет проезда</span>' : ''}` : o.engines !== undefined && own ? ` · свободных машин ${o.engines}` : '';
      h += `<div class="dw-title">${esc(o.name)}</div><div class="dw-subt">${KIND_NAME[o.kind]}${stockInfo} · ${own ? 'ваш объект' : CIVIL.has(o.kind) ? 'гражданский объект противника — удары запрещены' : 'объект противника'}${o.kind === 'ps110' && own ? ` · питание района ${((o.supply ?? 1) * 100).toFixed(0)}%` : ''}${o.kind === 'bridge' ? ` · пропускная способность ${(g.bridgeCap(o) * 100).toFixed(0)}%` : ''}</div>`;
      h += '<div class="dw-comps">';
      for (const c of o.comps) {
        const C = COMP[c.k];
        const inQ = this.S.queue.includes(c.id) || this.S.crews.some((w) => w.job?.id === c.id);
        let btns = '';
        if (own) {
          if (c.state !== 'ok') { const k = g.repairCost(side, c); btns += inQ ? '<span class="muted">в ремонте</span>' : `<button data-repair="${c.id}" title="${k ? 'оборудование взамен уничтоженного' : 'бригады на зарплате — бесплатно'}">Ремонт${k ? ' ' + k : ''}</button>`; }
          else if ((C.shelter || C.net) && shelterDef(c, c.shelter + 1)) { const L = c.shelter + 1, Sd = shelterDef(c, L); btns += this.S.queue.includes('S' + c.id) || this.S.crews.some((w) => w.job?.shelter && w.job.id === c.id) ? `<span class="muted">${C.net ? 'ставят сетку' : 'строится укрытие'}</span>` : `<button data-shelter="${c.id}" data-level="${L}" title="${esc(Sd.name)}">${C.net ? 'Сетка' : L === 1 ? 'Габионы' : 'Бетон'} ${Sd.cost}</button>`; }
        } else if (c.state === 'ok' && !CIVIL.has(o.kind)) btns += `<button data-target="${c.id}">Цель</button>`;
        h += `<div class="dw-comp"><span class="dot ${ST_CLS[c.state]}"></span><span class="nm">${esc(c.name)}${c.shelter ? ` <small>[${C.net ? 'сетка' : c.shelter === 1 ? 'габионы' : 'бетон'}]</small>` : ''}${c.fire > 0 ? ' 🔥' : ''}</span><span class="hp"><i style="width:${(c.hp * 100).toFixed(0)}%"></i></span><span class="st">${ST_TEXT[c.state]}</span>${btns}</div>`;
      }
      h += '</div>';
      if (!own) h += `<div class="dw-note">Выберите на вкладке «Удары» тип дронов и кликните по узлу — или нажмите «Цель» у узла.</div>`;
    } else if (a) {
      const T = DW_AD[a.type];
      const own = a.side === side;
      h += `<div class="dw-title">${esc(a.name)}</div><div class="dw-subt">${esc(T.sub[a.side])} · ${a.dead ? 'уничтожен' : a.state === 'deploying' ? 'развёртывание' : a.state === 'moving' ? 'на марше' : 'готов'}${own ? '' : ' · обнаружен разведкой'}</div>`;
      if (own) {
        h += `<div class="dw-note">${esc(T.desc)}</div><div class="dw-stats">Дальность ${(T.range / 1000).toFixed(1)} км${T.radar ? ` · РЛС ${(T.radar / 1000).toFixed(0)} км` : ''}${a.missiles ? ` · ракет ${a.missiles}` : ''}${T.ammo ? ` · боезапас ${Math.round(a.ammo)}` : ''}${a.type === 'icpt' ? ` · перехватчиков ${a.stock}` : ''} · сбито ${a.kills || 0}</div>`;
        if (a.type === 'sam') h += `<div class="dw-btns"><button data-roe="all" class="${a.roe === 'all' ? 'sel' : ''}">Огонь по всем целям</button><button data-roe="threat" class="${a.roe !== 'all' ? 'sel' : ''}">Беречь ракеты (только угрозы)</button></div>`;
        if (T.mobile) h += `<div class="dw-note">ПКМ по карте — переместить (${kmh(T.mobile)} км/ч, потом развёртывание).</div>`;
      } else h += `<div class="dw-note">Цель для барражирующих боеприпасов: выберите «${this.side === 'red' ? 'Ланцет-3' : 'Warmate'}» на вкладке «Удары» и кликните по позиции.</div>`;
    }
    el.innerHTML = h;
    el.classList.add('show');
  }

  onPanel(e) {
    const t = e.target.closest('[data-ad],[data-drone],[data-wave],[data-count],[data-obj],[data-selad],[data-repair],[data-shelter],[data-roe],[data-act],[data-target],[data-shed],[data-gtu]');
    if (!t) return;
    const g = this.g, side = this.side;
    const d = t.dataset;
    if (d.ad) { this.state.mode = this.state.mode === 'ad:' + d.ad ? null : 'ad:' + d.ad; this.build(); }
    else if (d.drone) { this.state.mode = this.state.mode === 'strike:' + d.drone ? null : 'strike:' + d.drone; this.state.route = []; this.build(); }
    else if (d.wave) { this.state.mode = this.state.mode === 'wave' ? null : 'wave'; this.state.route = []; this.build(); }
    else if (d.count) { this.state.count = Number(d.count); this.build(); }
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
    else if (d.act === 'auto') this.issue('dw', 'setAuto', side, t.checked);
    else if (d.act === 'crew') this.issue('dw', 'buyCrew', side);
    else if (d.act === 'spare') this.issue('dw', 'buySpare', side);
    else if (d.act === 'autoshed') this.issue('dw', 'setAutoShed', side, t.checked);
    else if (d.shed) { const [id, lv] = d.shed.split(':').map(Number); this.issue('dw', 'setShed', side, id, lv); }
    else if (d.gtu) this.issue('dw', 'buyGTU', side, Number(d.gtu));
    else if (d.act === 'net') { this.state.mode = this.state.mode === 'net' ? null : 'net'; this.build(); }
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
      if (o.kind === 'import') continue;
      const c = Math.cos(-o.angle), s = Math.sin(-o.angle);
      const lx = (x - o.x) * c - (y - o.y) * s, ly = (x - o.x) * s + (y - o.y) * c;
      const pad = 30 / Math.max(0.05, this.view.cam.zoom) * 0.2;
      if (Math.abs(lx) < o.w / 2 + pad && Math.abs(ly) < o.h / 2 + pad) { const d = Math.hypot(lx, ly); if (d < bd) { bd = d; best = o; } }
    }
    // На обзорном масштабе — по значку
    if (!best) for (const o of g.objects) { if (o.kind !== 'import' && Math.hypot(o.x - x, o.y - y) * this.view.cam.zoom < 16 * this.view.dpr) best = o; }
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
  click(sx, sy, shift) {
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
      const [a, b] = side === 'red' ? ['gerbera', 'shahed'] : ['bober', 'lyutyi'];
      this.issue('dw', 'launch', side, a, this.state.count, x, y, { route, oid: o?.id, cid: c?.id });
      this.issue('dw', 'launch', side, b, this.state.count, x, y, { route, oid: o?.id, cid: c?.id });
      return;
    }
    const type = this.state.mode.slice(7);
    const D = DW_DRONES[type];
    if (D.cls === 'hunter') {
      if (D.front) { const from = g.launchPoints(side, D)[0]; if (Math.abs(x - from.x) > D.range) { this.log(`${D.short}: район дальше ${D.range / 1000} км от передовой`); return; } }
      this.issue('dw', 'launch', side, type, Math.min(this.state.count, 4), x, y, { route });
      return;
    }
    if (D.cls === 'loiter') {
      const veh = this.vehAt(x, y);
      if (veh && veh.side !== side) {
        if (veh.kind === 'crew' || veh.kind === 'fire') { this.log('По пожарным и ремонтным бригадам удары не наносятся'); return; }
        this.issue('dw', 'launch', side, type, Math.min(this.state.count, 2), veh.x, veh.y, { vehTarget: veh.id });
        return;
      }
      const t = this.adAt(x, y);
      if (!t || t.side === side) { this.log(`${D.short}: нужна цель — позиция ПВО или машина противника, найденная разведкой`); return; }
      const p = t.spotX?.[side] || [t.x, t.y];
      const from = g.launchPoints(side, D)[0];
      if (Math.abs(p[0] - from.x) > D.range) { this.log(`${D.short}: цель дальше ${D.range / 1000} км от передовой`); return; }
      this.issue('dw', 'launch', side, type, Math.min(this.state.count, 4), p[0], p[1], { adTarget: t.id });
      return;
    }
    this.issue('dw', 'launch', side, type, D.cls === 'recon' ? 1 : this.state.count, x, y, { route, oid: o?.id, cid: c?.id });
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
