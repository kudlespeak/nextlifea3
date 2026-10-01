// Кэш сгенерированных карт в IndexedDB браузера: повторный запуск той же карты не ждёт генерации
// (≈5 с), мир восстанавливается из копии за 1–2 с. Копия снимается сразу после генерации — до
// воронок и прочих изменений партии. Ключ — seed, тип карты и версия генератора: после правок
// генератора MAPGEN_VERSION увеличивается, и старые копии не используются. Держим 2 последние карты.
// Работает и в основном потоке, и в фоновых потоках отрисовки. ?nocache — без кэша.

import { generateWorld, MAPGEN_VERSION } from './mapgen.js';
import { SpatialIndex, PointBins, Mask } from './spatial.js';

const DB = 'lf-worlds', STORE = 'w', KEEP = 2;

function open() {
  return new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') return rej(new Error('no idb'));
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// классы внутри мира после копирования — вернуть прототипы
function revive(w) {
  Object.setPrototypeOf(w.mask, Mask.prototype);
  Object.setPrototypeOf(w.trees, PointBins.prototype);
  for (const k of Object.keys(w)) if (w[k] && w[k].bins instanceof Map && Array.isArray(w[k].items) && !(w[k] instanceof PointBins)) Object.setPrototypeOf(w[k], SpatialIndex.prototype);
  return w;
}

const noCache = () => { try { return typeof location !== 'undefined' && new URLSearchParams(location.search).has('nocache'); } catch { return false; } };

export async function loadWorld(seed, layout, write = true) {
  const key = `${MAPGEN_VERSION}:${layout}:${seed}`;
  let db = null;
  if (!noCache()) {
    try {
      db = await open();
      const t0 = performance.now();
      const hit = await req(db.transaction(STORE).objectStore(STORE).get(key));
      if (hit?.world) { const w = revive(hit.world); w.fromCache = true; w.genTime = performance.now() - t0; touch(db, key); return w; }
    } catch { db = null; }
  }
  const w = generateWorld(seed, layout);
  if (db && write) {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ world: w, t: Date.now() }, key); // копия снимается здесь, синхронно
      tx.oncomplete = () => prune(db, key);
    } catch { /* нет места — играем без кэша */ }
  }
  return w;
}
// метка последнего использования — в отдельной маленькой записи (не читать 100 МБ ради даты)
async function touch(db, key) {
  try {
    const st = db.transaction(STORE, 'readwrite').objectStore(STORE);
    const meta = (await req(st.get('__meta'))) || {};
    meta[key] = Date.now();
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(meta, '__meta');
  } catch { /* ignore */ }
}
async function prune(db, key) {
  try {
    await touch(db, key);
    const meta = (await req(db.transaction(STORE).objectStore(STORE).get('__meta'))) || {};
    const keys = (await req(db.transaction(STORE).objectStore(STORE).getAllKeys())).filter((k) => k !== '__meta');
    const old = keys.sort((a, b) => (meta[b] || 0) - (meta[a] || 0)).slice(KEEP);
    if (!old.length) return;
    const st = db.transaction(STORE, 'readwrite').objectStore(STORE);
    for (const k of old) { st.delete(k); delete meta[k]; }
    st.put(meta, '__meta');
  } catch { /* ignore */ }
}
