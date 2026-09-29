// Граф траншей: пехота ходит по окопам, ходам сообщения, входам в блиндажи
// и подземным ходам. Строится из world.forts и перестраивается при изменениях.

const LINK_R = 4; // стыковка концов траншей с соседними, м

export class TrenchGraph {
  constructor(world) {
    this.world = world;
    this.version = -1;
    this.rebuild();
  }

  ensure() {
    if (this.version !== this.world.fortsVersion) this.rebuild();
  }

  rebuild() {
    this.version = this.world.fortsVersion;
    const nodes = []; // { x, y, kind, item, under }
    const adj = [];
    const cell = 8;
    const hash = new Map();
    const addNode = (x, y, props) => {
      const id = nodes.length;
      nodes.push({ x, y, id, ...props });
      adj.push([]);
      const k = Math.floor(x / cell) + ',' + Math.floor(y / cell);
      if (!hash.has(k)) hash.set(k, []);
      hash.get(k).push(id);
      return id;
    };
    const link = (a, b, under = false) => {
      if (a === b) return;
      const d = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y);
      adj[a].push({ to: b, d, under });
      adj[b].push({ to: a, d, under });
    };
    this.nodes = nodes;
    this.adj = adj;
    this.hash = hash;
    this.cell = cell;

    const ends = [];
    const lineNodes = (item, under) => {
      // Дробим длинные отрезки, чтобы было куда «встать» бойцу
      const ids = [];
      const L = item.line;
      for (let i = 0; i < L.length; i++) {
        if (i > 0) {
          const [ax, ay] = L[i - 1], [bx, by] = L[i];
          const n = Math.floor(Math.hypot(bx - ax, by - ay) / 3);
          for (let k = 1; k <= n; k++) ids.push(addNode(ax + ((bx - ax) * k) / (n + 1), ay + ((by - ay) * k) / (n + 1), { item, under, kind: item.kind === 'tunnel' ? 'tunnel' : item.sub }));
        }
        ids.push(addNode(L[i][0], L[i][1], { item, under, kind: item.kind === 'tunnel' ? 'tunnel' : item.sub }));
      }
      for (let i = 1; i < ids.length; i++) link(ids[i - 1], ids[i], under);
      ends.push(ids[0], ids[ids.length - 1]);
      return ids;
    };
    const dugouts = [];
    for (const f of this.world.forts.items) {
      if (f.kind === 'trench') lineNodes(f, false);
      else if (f.kind === 'tunnel') lineNodes(f, true);
      else if (f.kind === 'dugout') dugouts.push(addNode(f.x, f.y, { item: f, kind: 'dugout', under: true }));
    }
    // Стыкуем концы с ближайшими узлами других линий
    for (const e of ends) {
      const n = nodes[e];
      let best = -1, bd = LINK_R;
      for (const id of this.near(n.x, n.y, LINK_R)) {
        if (nodes[id].item === n.item) continue;
        const d = Math.hypot(nodes[id].x - n.x, nodes[id].y - n.y);
        if (d < bd) { bd = d; best = id; }
      }
      if (best >= 0) link(e, best, n.under || nodes[best].under);
    }
    // Блиндаж соединяем с началом входа и с подземными ходами
    for (const id of dugouts) {
      const n = nodes[id];
      for (const nb of this.near(n.x, n.y, 4.5)) {
        if (nb === id) continue;
        const k = nodes[nb].kind;
        if (k === 'entrance' || k === 'tunnel') link(id, nb, true);
      }
    }
  }

  // Узлы в радиусе r
  near(x, y, r) {
    const out = [];
    const c = this.cell;
    for (let gy = Math.floor((y - r) / c); gy <= Math.floor((y + r) / c); gy++)
      for (let gx = Math.floor((x - r) / c); gx <= Math.floor((x + r) / c); gx++) {
        const b = this.hash.get(gx + ',' + gy);
        if (!b) continue;
        for (const id of b) if (Math.hypot(this.nodes[id].x - x, this.nodes[id].y - y) <= r) out.push(id);
      }
    return out;
  }

  // Ближайший узел (опционально — только наземный)
  nearest(x, y, maxR = 40, surfaceOnly = false) {
    let best = -1, bd = Infinity;
    for (const id of this.near(x, y, maxR)) {
      const n = this.nodes[id];
      if (surfaceOnly && n.under) continue;
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }

  // A* по графу. Возвращает список id узлов.
  path(from, to) {
    if (from < 0 || to < 0) return null;
    const N = this.nodes.length;
    const g = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const tx = this.nodes[to].x, ty = this.nodes[to].y;
    const h = (i) => Math.hypot(this.nodes[i].x - tx, this.nodes[i].y - ty);
    const open = [[h(from), from]];
    g[from] = 0;
    while (open.length) {
      // Граф маленький — достаточно простой сортировки
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
      const [, cur] = open.splice(bi, 1)[0];
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === to) break;
      for (const e of this.adj[cur]) {
        const ng = g[cur] + e.d * (e.under ? 1.3 : 1); // под землёй идти медленнее
        if (ng < g[e.to]) {
          g[e.to] = ng;
          prev[e.to] = cur;
          open.push([ng + h(e.to), e.to]);
        }
      }
    }
    if (g[to] === Infinity) return null;
    const out = [];
    for (let i = to; i !== -1; i = prev[i]) out.push(i);
    return out.reverse();
  }

  // Узлы траншеи вокруг точки (обход в ширину по наземным узлам на глубину maxD метров)
  around(start, maxD) {
    const dist = new Map([[start, 0]]);
    const q = [start];
    while (q.length) {
      const cur = q.shift();
      for (const e of this.adj[cur]) {
        if (e.under || this.nodes[e.to].under) continue;
        const d = dist.get(cur) + e.d;
        if (d > maxD || (dist.has(e.to) && dist.get(e.to) <= d)) continue;
        dist.set(e.to, d);
        q.push(e.to);
      }
    }
    return dist;
  }
}
