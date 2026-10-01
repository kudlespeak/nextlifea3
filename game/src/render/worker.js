// Фоновый поток отрисовки карты. Держит свою копию мира (генерация по тому же seed)
// и применяет те же события изменения мира (разрывы, траншеи, подбитая техника),
// что и основной поток. Готовые чанки уходят в основной поток как ImageBitmap —
// игра не останавливается на отрисовку.

import { applyEconEvent } from '../mapgen.js';
import { loadWorld } from '../worldcache.js';
import { drawChunk, mkCanvas } from './draw.js';
import { Artillery } from '../sim/artillery.js';
import { digTrench } from '../forts.js';
import { Rng } from '../rng.js';
import { FACTIONS } from '../sim/factions.js';

let world = null;
let art = null;
const early = []; // события, пришедшие до готовности мира

function apply(ev) {
  if (ev.k === 'boom') art.explodeWorld(ev.x, ev.y, ev.c, ev.f, ev.s);
  else if (ev.k === 'trench') digTrench(world, new Rng(ev.s), ev.pts, ev.side, FACTIONS[ev.side].enemy);
  else if (ev.k === 'wreck') {
    const w = { kind: 'wreck', x: ev.x, y: ev.y, angle: ev.a, type: ev.t, seed: ev.id * 7919 };
    w.bbox = { x0: ev.x - 10, y0: ev.y - 10, x1: ev.x + 10, y1: ev.y + 10 };
    world.scars.insert(w);
  } else applyEconEvent(world, ev);
  art.effects.length = 0;
  art.sim.events.length = 0;
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'init') {
    loadWorld(m.seed, m.layout, m.write !== false).then((w) => init(w));
  } else if (m.t === 'ev') {
    if (!world) early.push(m.ev);
    else apply(m.ev);
  } else if (m.t === 'render') {
    if (!world) { pending.push(m); return; }
    render(m);
  }
};
const pending = [];
function render(m) {
  const c = mkCanvas(m.px, m.px);
  const ctx = c.getContext('2d');
  drawChunk(ctx, world, m.b, m.ppm);
  const bmp = c.transferToImageBitmap();
  self.postMessage({ t: 'chunk', key: m.key, stamp: m.stamp, bmp }, [bmp]);
}
function init(w) {
  {
    world = w;
    // Заглушка симуляции: explodeWorld пишет сообщения и эффекты — здесь они не нужны
    const stub = { world, fires: [], events: [], msg() {}, time: 0, puppet: true };
    art = new Artillery(stub);
    for (const ev of early) apply(ev);
    early.length = 0;
    self.postMessage({ t: 'ready' });
    for (const m of pending.splice(0)) render(m);
  }
}
