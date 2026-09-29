// Кэш отрисованных чанков по уровням детализации (LOD).
// Каждый чанк — холст 512×512 px; на уровне с ppm пикселей/метр он покрывает 512/ppm метров.

import { drawChunk } from './draw.js';

export const CHUNK_PX = 512;
export const LEVELS = [0.125, 0.25, 0.5, 1, 2, 4, 8];
const MAX_CACHE = 180;

export class ChunkCache {
  constructor(world) {
    this.world = world;
    this.cache = new Map(); // key → { canvas, level, cx, cy, used }
    this.queue = [];
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
  render(level, cx, cy) {
    const size = this.worldSize(level);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = CHUNK_PX;
    const ctx = canvas.getContext('2d');
    drawChunk(ctx, this.world, { x0: cx * size, y0: cy * size, x1: (cx + 1) * size, y1: (cy + 1) * size }, LEVELS[level]);
    const entry = { canvas, level, cx, cy, used: this.frame };
    this.cache.set(this.key(level, cx, cy), entry);
    this.evict();
    return entry;
  }
  evict() {
    if (this.cache.size <= MAX_CACHE) return;
    const entries = [...this.cache.entries()].filter(([, e]) => e.level > 0).sort((a, b) => a[1].used - b[1].used);
    for (let i = 0; i < entries.length && this.cache.size > MAX_CACHE; i++) this.cache.delete(entries[i][0]);
  }
  // Сбросить чанки, пересекающие область (после новых воронок и т.п.)
  invalidate(b) {
    for (const [k, e] of this.cache) {
      const size = this.worldSize(e.level);
      const x0 = e.cx * size, y0 = e.cy * size;
      if (x0 <= b.x1 && x0 + size >= b.x0 && y0 <= b.y1 && y0 + size >= b.y0) {
        e.stale = true;
        // Не удаляем сразу — старая картинка рисуется, пока не готова новая
        this.cache.set(k, e);
      }
    }
  }
}
