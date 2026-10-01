// Кэш отрисованных чанков по уровням детализации (LOD).
// Каждый чанк — картинка 512×512 px; на уровне с ppm пикселей/метр он покрывает 512/ppm метров.
// Чанки рисуются в фоновом потоке (worker.js) — основной поток не ждёт отрисовки, фризов нет.
// Обзорные уровни 0..2 собираются уменьшением четырёх чанков следующего уровня.
// Если Web Worker недоступен — рисуем в основном потоке, понемногу за кадр.

import { drawChunk, mkCanvas } from './draw.js';

export const CHUNK_PX = 512;
export const LEVELS = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16];
const COMPOSE_BELOW = 3;
const MAX_CACHE = 220;
const MAX_INFLIGHT = 3;

// Фоновые потоки отрисовки создаются заранее (до генерации мира в основном потоке): они строят
// свою копию мира параллельно, а на многоядерных машинах с памятью их два — чанки рисуются вдвое быстрее
let pre = null;
function workerCount() {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  const mem = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 8;
  return cores >= 6 && mem >= 8 ? 2 : 1;
}
function spawn(seed, layout) {
  const ws = [];
  for (let i = 0; i < workerCount(); i++) {
    try {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.postMessage({ t: 'init', seed, layout, write: false });
      ws.push(w);
    } catch { break; }
  }
  return { seed, layout, ws };
}

export class ChunkCache {
  static prewarm(seed, layout) { pre = spawn(seed, layout); }
  constructor(world) {
    this.world = world;
    // Обзорные уровни собираются из детальных; на большой карте это сотни чанков — рисуем обзор напрямую
    this.composeBelow = world.W * world.H > 3e8 ? 1 : COMPOSE_BELOW;
    this.cache = new Map(); // key → { canvas, level, cx, cy, used, stale }
    this.frame = 0;
    this.tick = 0; // счётчик изменений мира (для устаревших ответов)
    this.inflight = new Map(); // key → stamp
    this.ready = false;
    const P = pre && pre.seed === world.seed && pre.layout === world.layout ? pre : spawn(world.seed, world.layout);
    if (pre && P !== pre) for (const w of pre.ws) w.terminate();
    pre = null;
    this.workers = P.ws.map((w) => ({ w, n: 0 }));
    for (const W of this.workers) {
      W.w.onmessage = (e) => { if (e.data.t === 'chunk') W.n--; this.onMessage(e.data); };
      W.w.onerror = () => { this.workers = this.workers.filter((q) => q !== W); this.inflight.clear(); };
    }
    this.worker = this.workers.length ? this.workers[0].w : null;
  }
  worldSize(level) {
    return CHUNK_PX / LEVELS[level];
  }
  key(level, cx, cy) {
    return `${level}:${cx}:${cy}`;
  }
  get(level, cx, cy) {
    const c = this.cache.get(this.key(level, cx, cy));
    if (c) c.used = this.frame;
    return c;
  }
  inWorld(level, cx, cy) {
    const s = this.worldSize(level);
    return cx * s < this.world.W && cy * s < this.world.H;
  }
  // Событие изменения мира — фоновый поток повторяет его у себя
  worldEvent(ev) {
    for (const W of this.workers) W.w.postMessage({ t: 'ev', ev });
  }
  onMessage(m) {
    if (m.t === 'ready') { this.ready = true; return; }
    if (m.t !== 'chunk') return;
    this.inflight.delete(m.key);
    const [level, cx, cy] = m.key.split(':').map(Number);
    const old = this.cache.get(m.key);
    if (old?.canvas?.close) old.canvas.close();
    // Пока рисовали, мир в этом месте снова изменился — картинка годится, но помечаем устаревшей
    const stale = !!(old && old.invalidAt > m.stamp);
    this.cache.set(m.key, { canvas: m.bmp, level, cx, cy, used: this.frame, stale, invalidAt: old?.invalidAt || 0 });
    this.evict();
  }
  // Запросить чанк. Возвращает запись, если она готова (в фоне — сразу null, придёт позже).
  render(level, cx, cy, deadline = Infinity) {
    if (level < this.composeBelow) return this.compose(level, cx, cy, deadline);
    const size = this.worldSize(level);
    const key = this.key(level, cx, cy);
    const b = { x0: cx * size, y0: cy * size, x1: (cx + 1) * size, y1: (cy + 1) * size };
    if (this.workers.length) {
      if (this.inflight.has(key) || this.inflight.size >= MAX_INFLIGHT * this.workers.length) return null;
      const W = this.workers.reduce((a, q) => (q.n < a.n ? q : a));
      W.n++;
      this.inflight.set(key, this.tick);
      W.w.postMessage({ t: 'render', key, stamp: this.tick, b, ppm: LEVELS[level], px: CHUNK_PX });
      return null;
    }
    if (performance.now() > deadline) return null;
    const old = this.cache.get(key);
    const canvas = old?.canvas || mkCanvas(CHUNK_PX, CHUNK_PX);
    canvas.width = canvas.height = CHUNK_PX;
    drawChunk(canvas.getContext('2d'), this.world, b, LEVELS[level]);
    const entry = { canvas, level, cx, cy, used: this.frame, invalidAt: 0 };
    this.cache.set(key, entry);
    this.evict();
    return entry;
  }
  // Можно ли отправить ещё запрос в фон
  busy() {
    return this.workers.length ? this.inflight.size >= MAX_INFLIGHT * this.workers.length : false;
  }
  compose(level, cx, cy, deadline) {
    const kids = [];
    let missing = false;
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++) {
        const kx = cx * 2 + dx, ky = cy * 2 + dy;
        if (!this.inWorld(level + 1, kx, ky)) continue;
        let e = this.cache.get(this.key(level + 1, kx, ky));
        if (!e || e.stale) {
          const r = this.render(level + 1, kx, ky, deadline);
          if (r) e = r;
          else if (!e) { missing = true; continue; }
        }
        e.used = this.frame;
        kids.push([dx, dy, e]);
      }
    if (missing) return null;
    // Дети ещё обновляются — подождём свежих, если старая сборка есть
    const old = this.cache.get(this.key(level, cx, cy));
    if (old && kids.some(([, , e]) => e.stale)) return null;
    const canvas = mkCanvas(CHUNK_PX, CHUNK_PX);
    const g = canvas.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    const h = CHUNK_PX / 2;
    for (const [dx, dy, e] of kids) g.drawImage(e.canvas, dx * h, dy * h, h, h);
    const entry = { canvas, level, cx, cy, used: this.frame, invalidAt: old?.invalidAt || 0 };
    this.cache.set(this.key(level, cx, cy), entry);
    return entry;
  }
  evict() {
    if (this.cache.size <= MAX_CACHE) return;
    // Обзорные уровни и их «источник» (уровень 3) держим всегда
    const entries = [...this.cache.entries()].filter(([, e]) => e.level > this.composeBelow).sort((a, b) => a[1].used - b[1].used);
    for (let i = 0; i < entries.length && this.cache.size > MAX_CACHE; i++) {
      entries[i][1].canvas?.close?.();
      this.cache.delete(entries[i][0]);
    }
  }
  // Сбросить чанки, пересекающие область (после новых воронок и т.п.)
  invalidate(b) {
    this.tick++;
    for (const e of this.cache.values()) {
      const size = this.worldSize(e.level);
      const x0 = e.cx * size, y0 = e.cy * size;
      // Старая картинка рисуется, пока не готова новая
      if (x0 <= b.x1 && x0 + size >= b.x0 && y0 <= b.y1 && y0 + size >= b.y0) { e.stale = true; e.invalidAt = this.tick; }
    }
  }
}
