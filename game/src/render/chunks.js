// Кэш отрисованных чанков по уровням детализации (LOD).
// Каждый чанк — холст 512×512 px; на уровне с ppm пикселей/метр он покрывает 512/ppm метров.
// Мелкие уровни (обзор всей карты) не рисуются напрямую — это сотни миллисекунд на чанк
// и фризы при отдалении камеры. Они собираются уменьшением четырёх чанков следующего уровня,
// по частям в несколько кадров.

import { drawChunk } from './draw.js';

export const CHUNK_PX = 512;
export const LEVELS = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16];
const COMPOSE_BELOW = 3; // уровни 0..2 — сборка из уровня выше
const MAX_CACHE = 220;

export class ChunkCache {
  constructor(world) {
    this.world = world;
    this.cache = new Map(); // key → { canvas, level, cx, cy, used }
    this.frame = 0;
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
  // Отрисовать чанк. deadline — performance.now(), после которого сборка откладывается
  // до следующего кадра (тогда возвращается null).
  render(level, cx, cy, deadline = Infinity) {
    if (level < COMPOSE_BELOW) return this.compose(level, cx, cy, deadline);
    const size = this.worldSize(level);
    const old = this.cache.get(this.key(level, cx, cy));
    const canvas = old?.canvas || document.createElement('canvas');
    canvas.width = canvas.height = CHUNK_PX; // сброс содержимого
    const ctx = canvas.getContext('2d');
    drawChunk(ctx, this.world, { x0: cx * size, y0: cy * size, x1: (cx + 1) * size, y1: (cy + 1) * size }, LEVELS[level]);
    const entry = { canvas, level, cx, cy, used: this.frame };
    this.cache.set(this.key(level, cx, cy), entry);
    this.evict();
    return entry;
  }
  compose(level, cx, cy, deadline) {
    // Сначала — все четыре «дочерних» чанка
    const kids = [];
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++) {
        const kx = cx * 2 + dx, ky = cy * 2 + dy;
        if (!this.inWorld(level + 1, kx, ky)) continue;
        let e = this.cache.get(this.key(level + 1, kx, ky));
        if (!e || e.stale) {
          if (performance.now() > deadline) return null;
          e = this.render(level + 1, kx, ky, deadline);
          if (!e) return null;
        }
        e.used = this.frame;
        kids.push([dx, dy, e]);
      }
    const old = this.cache.get(this.key(level, cx, cy));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = CHUNK_PX;
    const g = canvas.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    const h = CHUNK_PX / 2;
    for (const [dx, dy, e] of kids) g.drawImage(e.canvas, dx * h, dy * h, h, h);
    const entry = { canvas, level, cx, cy, used: this.frame };
    if (old) old.canvas = null;
    this.cache.set(this.key(level, cx, cy), entry);
    return entry;
  }
  evict() {
    if (this.cache.size <= MAX_CACHE) return;
    // Обзорные уровни и их «источник» (уровень 3) держим всегда
    const entries = [...this.cache.entries()].filter(([, e]) => e.level > COMPOSE_BELOW).sort((a, b) => a[1].used - b[1].used);
    for (let i = 0; i < entries.length && this.cache.size > MAX_CACHE; i++) this.cache.delete(entries[i][0]);
  }
  // Сбросить чанки, пересекающие область (после новых воронок и т.п.)
  invalidate(b) {
    for (const e of this.cache.values()) {
      const size = this.worldSize(e.level);
      const x0 = e.cx * size, y0 = e.cy * size;
      // Старая картинка рисуется, пока не готова новая
      if (x0 <= b.x1 && x0 + size >= b.x0 && y0 <= b.y1 && y0 + size >= b.y0) e.stale = true;
    }
  }
}
