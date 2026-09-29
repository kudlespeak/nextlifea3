// Модель урона.
// Бойцы: место попадания (голова / корпус / руки / ноги) по позе, каска и бронежилет,
//   тяжесть ранения, кровотечение, последствия (хромает, не может стрелять, без сознания).
// Техника: ракурс (лоб / борт / корма / крыша), броня по ракурсу, динамическая защита,
//   пробитие и поражение узлов: двигатель, ходовая, орудие, экипаж, топливо (пожар), боеукладка.

// Доли попаданий по частям тела в зависимости от позы
const LOC_BY_POSE = {
  stand: { head: 0.1, torso: 0.4, arm: 0.2, leg: 0.3 },
  crouch: { head: 0.12, torso: 0.43, arm: 0.2, leg: 0.25 },
  prone: { head: 0.2, torso: 0.4, arm: 0.25, leg: 0.15 },
  trench: { head: 0.45, torso: 0.3, arm: 0.25, leg: 0 },
  window: { head: 0.4, torso: 0.35, arm: 0.25, leg: 0 },
  inside: { head: 0.2, torso: 0.4, arm: 0.2, leg: 0.2 },
};
export const LOC_NAMES = { head: 'голова', torso: 'грудь/живот', arm: 'рука', leg: 'нога' };

// Средства защиты: доля покрытия и насколько гасят пулю / осколок
const ARMOR = {
  blue: { helmet: { cover: 0.7, bullet: 0.2, frag: 0.75 }, vest: { cover: 0.75, bullet: 0.75, frag: 0.9 } },
  red: { helmet: { cover: 0.65, bullet: 0.15, frag: 0.7 }, vest: { cover: 0.6, bullet: 0.6, frag: 0.85 } },
};

function pick(rng, table) {
  let r = rng.next(), acc = 0;
  for (const [k, p] of Object.entries(table)) { acc += p; if (r < acc) return k; }
  return 'torso';
}

// Попадание по бойцу. kind: 'bullet' | 'frag' | 'blast'; power — условный урон (как раньше dmg)
export function hitSoldier(sim, u, s, kind, power, by = '') {
  const rng = sim.rng;
  if (s.dead) return;
  if (kind === 'blast') { applyWound(sim, u, s, 'torso', power, power > 60 ? 0.8 : 0.3, by, kind); return; }
  const loc = pick(rng, LOC_BY_POSE[s.pose] || LOC_BY_POSE.stand);
  const A = ARMOR[u.side] || ARMOR.red;
  let dmg = power;
  // Защита: каска (голова) и бронежилет (корпус)
  const piece = loc === 'head' ? A.helmet : loc === 'torso' ? A.vest : null;
  if (piece && rng.chance(piece.cover)) {
    const stop = kind === 'bullet' ? piece.bullet : piece.frag;
    if (rng.chance(stop)) {
      // Остановлено защитой: ушиб, подавление
      s.supp = Math.min(12, s.supp + 3);
      s.hp -= dmg * 0.08;
      s.lastHit = { loc, stopped: true, t: sim.time };
      return;
    }
    dmg *= 0.7;
  }
  // Тяжесть и кровотечение по месту
  const k = { head: 1.9, torso: 1.1, arm: 0.45, leg: 0.6 }[loc];
  dmg *= k * rng.float(0.7, 1.3);
  let bleed = { head: 0.6, torso: 0.8, arm: 0.35, leg: 0.5 }[loc];
  if ((loc === 'leg' || loc === 'arm') && rng.chance(0.18)) bleed = 1.6; // артерия
  applyWound(sim, u, s, loc, dmg, bleed, by, kind);
}

function applyWound(sim, u, s, loc, dmg, bleed, by, kind) {
  const before = s.hp;
  s.hp -= dmg;
  s.wounds = s.wounds || [];
  s.wounds.push({ loc, sev: dmg, bleed, t: sim.time, kind });
  s.bleed = (s.bleed || 0) + bleed;
  s.treated = false;
  s.lastHit = { loc, t: sim.time };
  if (loc === 'leg') s.legHit = (s.legHit || 0) + 1;
  if (loc === 'arm') s.armHit = (s.armHit || 0) + 1;
  if (s.hp <= 0) {
    s.hp = 0; s.dead = true; s.path = null; s.mode = 'dead';
    sim.checkUnit(u);
    return;
  }
  // Тяжёлое: без сознания / не может идти (две ноги, сильная кровопотеря, шок)
  const heavy = s.hp < 30 || (s.legHit || 0) >= 2 || (loc === 'head' && dmg > 25);
  s.wounded = heavy ? 2 : s.hp < 75 ? 1 : Math.max(s.wounded || 0, 1);
  if (s.wounded === 2) { s.path = null; s.mode = 'hold'; }
  if (before >= 30 && s.wounded === 2) sim.msg(`${u.label}: тяжело ранен ${s.role.toLowerCase()} (${LOC_NAMES[loc]})`, u.side);
}

// Кровотечение каждый шаг; перевязка/жгут останавливает
export function bleedTick(sim, u, s, dt) {
  if (!s.bleed || s.treated || s.dead) return;
  s.hp -= s.bleed * dt * 0.12;
  if (s.hp < 30 && s.wounded < 2) { s.wounded = 2; s.path = null; s.mode = 'hold'; sim.msg(`${u.label}: ${s.role.toLowerCase()} теряет сознание от кровопотери`, u.side); }
  if (s.hp <= 0) {
    s.hp = 0; s.dead = true; s.mode = 'dead';
    sim.msg(`${u.label}: ${s.role.toLowerCase()} умер от ран`, u.side);
    sim.checkUnit(u);
  }
}

// Скорость и меткость раненого
export function woundSpeed(s) {
  if (!s.wounds?.length) return 1;
  return (s.legHit ? 0.45 : 1) * (s.hp < 60 ? 0.85 : 1);
}
export function woundAim(s) {
  if (!s.wounds?.length) return 1;
  return (s.armHit ? (s.armHit >= 2 ? 0.2 : 0.55) : 1) * (s.hp < 50 ? 0.8 : 1);
}

// Краткое описание состояния бойца для карточки
export function woundText(s) {
  if (!s.wounds?.length) return '';
  const locs = [...new Set(s.wounds.map((w) => LOC_NAMES[w.loc]))].join(', ');
  return `ранен: ${locs}${s.bleed && !s.treated ? (s.bleed > 1.2 ? ' · сильное кровотечение' : ' · кровотечение') : s.treated ? ' · перевязан' : ''}`;
}

// ---------------- Техника ----------------
// Броня по ракурсу (доля от базовой брони машины)
const FACING_K = { front: 1, side: 0.55, rear: 0.35, top: 0.22 };
export const PART_NAMES = { engine: 'двигатель', tracks: 'ходовая', gun: 'орудие', crew: 'экипаж', fuel: 'топливо', ammo: 'боеукладка' };

// Ракурс по направлению прилёта (угол от машины к стрелку)
export function facingOf(t, fromX, fromY, top = false) {
  if (top) return 'top';
  const a = Math.atan2(fromY - t.y, fromX - t.x) - t.heading;
  const d = Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
  return d < Math.PI / 4 ? 'front' : d > (Math.PI * 3) / 4 ? 'rear' : 'side';
}

// Попадание по технике. pen — пробивная способность (как раньше at), from — откуда прилетело.
// Возвращает текст результата для журнала.
export function hitVehicle(sim, t, pen, from, opts = {}) {
  const rng = sim.rng;
  if (t.dead) return '';
  const facing = facingOf(t, from.x, from.y, opts.top);
  let armor = (t.def.armor ?? 0.2) * FACING_K[facing];
  // Динамическая защита (танки Кардагора): гасит первый кумулятивный удар в лоб/борт
  if (opts.shaped && t.type === 'tank' && t.side === 'red' && facing !== 'rear' && facing !== 'top' && (t.era ?? 2) > 0 && rng.chance(0.6)) {
    t.era = (t.era ?? 2) - 1;
    pen *= 0.55;
  }
  t.underFire = sim.time;
  const p = pen * rng.float(0.75, 1.25);
  if (p < armor * 0.9) {
    // Не пробил: рикошет, мелкие повреждения
    t.hp = Math.max(0.05, (t.hp ?? 1) - p * 0.05);
    if (rng.chance(0.25)) t.opticsHit = true; // посечённые приборы — хуже видит/целится
    return `${t.def.short}: ${facing === 'front' ? 'лоб' : facing === 'side' ? 'борт' : facing === 'rear' ? 'корма' : 'крыша'} — непробитие`;
  }
  // Пробитие: чем выше запас по броне, тем больше последствий
  const over = Math.min(2.5, p / Math.max(0.05, armor));
  t.hp = (t.hp ?? 1) - Math.min(0.7, 0.15 + over * 0.15);
  const parts = [];
  const hits = over > 1.8 ? 2 : 1;
  for (let i = 0; i < hits; i++) {
    const part = pickPart(rng, facing, t);
    parts.push(part);
    damagePart(sim, t, part);
    if (t.dead) break;
  }
  if (!t.dead && t.hp <= 0) sim.art.destroyVehicle(t);
  return `${t.def.short}: пробитие (${facing === 'front' ? 'лоб' : facing === 'side' ? 'борт' : facing === 'rear' ? 'корма' : 'крыша'}) — ${parts.map((x) => PART_NAMES[x]).join(', ')}${t.dead ? ', уничтожен' : ''}`;
}

function pickPart(rng, facing, t) {
  const table = facing === 'rear' ? { engine: 0.45, fuel: 0.2, tracks: 0.15, crew: 0.1, ammo: 0.1 }
    : facing === 'side' ? { tracks: 0.25, crew: 0.2, ammo: 0.2, fuel: 0.15, engine: 0.1, gun: 0.1 }
      : facing === 'top' ? { crew: 0.3, ammo: 0.25, engine: 0.2, gun: 0.15, fuel: 0.1 }
        : { gun: 0.3, crew: 0.3, tracks: 0.2, ammo: 0.1, fuel: 0.1 };
  if (!t.def.caliber && !['tank', 'ifv', 'apc', 'armcar'].includes(t.type)) delete table.gun;
  return pick(rng, table);
}

function damagePart(sim, t, part) {
  const rng = sim.rng;
  t.parts = t.parts || {};
  t.parts[part] = (t.parts[part] || 0) + 1;
  if (part === 'engine' || part === 'tracks') {
    t.immobile = true;
    t.speed = 0;
    sim.msg(`${t.label}: ${part === 'engine' ? 'двигатель поражён' : 'повреждена ходовая'} — машина обездвижена`, t.side);
  } else if (part === 'gun') {
    t.gunOut = true;
    sim.msg(`${t.label}: орудие выведено из строя`, t.side);
  } else if (part === 'crew') {
    t.crew = Math.max(0, (t.crew ?? t.def.men) - rng.int(1, 2));
    if (t.crew <= 0) { sim.msg(`${t.label}: экипаж погиб`, t.side); sim.art.destroyVehicle(t); return; }
    sim.msg(`${t.label}: потери в экипаже (осталось ${t.crew})`, t.side);
  } else if (part === 'fuel') {
    t.burning = sim.time;
    (sim.fires || []).push({ x: t.x, y: t.y, r: 10, until: sim.time + 400 });
    sim.msg(`${t.label}: пожар!`, t.side);
  } else if (part === 'ammo') {
    if (rng.chance(t.type === 'tank' ? 0.7 : 0.5)) {
      sim.msg(`${t.label}: детонация боекомплекта`, t.side);
      sim.art.destroyVehicle(t);
      sim.art.explode(t.x, t.y, 'he125', 'ground', null, true);
    } else { t.burning = sim.time; sim.msg(`${t.label}: возгорание боеукладки`, t.side); }
  }
  // Десант в пробитой машине тоже получает
  for (const p of t.passengers || []) for (const s of p.soldiers) if (!s.dead && rng.chance(0.25)) hitSoldier(sim, p, s, 'frag', rng.float(30, 80), t.label);
}

// Горящая машина: теряет живучесть, экипаж покидает её
export function burnTick(sim, t, dt) {
  if (!t.burning || t.dead) return;
  t.hp = (t.hp ?? 1) - dt * 0.004;
  if (t.hp <= 0) sim.art.destroyVehicle(t);
}

// Описание повреждений для карточки
export function vehicleStatus(t) {
  const out = [];
  if (t.immobile) out.push('обездвижена');
  if (t.gunOut) out.push('орудие не работает');
  if (t.crew !== undefined && t.crew < t.def.men) out.push(`экипаж ${t.crew}/${t.def.men}`);
  if (t.burning) out.push('горит');
  if (t.opticsHit) out.push('посечены приборы');
  if (t.era !== undefined) out.push(`ДЗ: ${t.era}`);
  return out.join(' · ');
}
