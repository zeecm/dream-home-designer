import { box } from './convex';
import { pointInPolygon } from './geometry';
import type { Vec2 } from './schema';

/**
 * A square-cell raster of the plan for the walkway check: filling polygons, an exact
 * Euclidean distance transform that also finds each cell's nearest obstacle, and a widest-way
 * (maximin) search. Cell k is column k % nx, row floor(k / nx); its centre is
 * (x0 + (i + ½)c, y0 + (j + ½)c). Metres.
 */
export interface Grid {
  c: number;
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  n: number;
}

export const cellCentre = (g: Grid, k: number): Vec2 => ({
  x: g.x0 + ((k % g.nx) + 0.5) * g.c,
  y: g.y0 + (Math.floor(k / g.nx) + 0.5) * g.c,
});

export const cellAt = (g: Grid, p: Vec2): number => {
  const i = Math.floor((p.x - g.x0) / g.c);
  const j = Math.floor((p.y - g.y0) / g.c);
  return i < 0 || j < 0 || i >= g.nx || j >= g.ny ? -1 : j * g.nx + i;
};

/** Every cell a segment passes through (a 4-connected run, so a thin wall stays closed). */
function traverse(g: Grid, a: Vec2, b: Vec2, each: (k: number) => void) {
  let i = Math.floor((a.x - g.x0) / g.c);
  let j = Math.floor((a.y - g.y0) / g.c);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  const tdx = dx !== 0 ? g.c / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const tdy = dy !== 0 ? g.c / Math.abs(dy) : Number.POSITIVE_INFINITY;
  let tx =
    dx !== 0
      ? (dx > 0 ? g.x0 + (i + 1) * g.c - a.x : a.x - (g.x0 + i * g.c)) / Math.abs(dx)
      : Number.POSITIVE_INFINITY;
  let ty =
    dy !== 0
      ? (dy > 0 ? g.y0 + (j + 1) * g.c - a.y : a.y - (g.y0 + j * g.c)) / Math.abs(dy)
      : Number.POSITIVE_INFINITY;
  for (let guard = 0; guard < 1_000_000; guard++) {
    if (i >= 0 && j >= 0 && i < g.nx && j < g.ny) each(j * g.nx + i);
    if (Math.min(tx, ty) > 1) break;
    if (tx < ty) {
      tx += tdx;
      i += sx;
    } else {
      ty += tdy;
      j += sy;
    }
  }
}

/**
 * The cells a polygon covers: those whose centre is inside, and every cell an edge passes
 * through (so a glass partition thinner than a cell still closes the way).
 */
export function fillPolygon(g: Grid, poly: readonly Vec2[], each: (k: number) => void) {
  if (poly.length < 3) return;
  const b = box(poly);
  const i0 = Math.max(0, Math.floor((b.x0 - g.x0) / g.c));
  const i1 = Math.min(g.nx - 1, Math.floor((b.x1 - g.x0) / g.c));
  const j0 = Math.max(0, Math.floor((b.y0 - g.y0) / g.c));
  const j1 = Math.min(g.ny - 1, Math.floor((b.y1 - g.y0) / g.c));
  const p = { x: 0, y: 0 };
  for (let j = j0; j <= j1; j++) {
    p.y = g.y0 + (j + 0.5) * g.c;
    for (let i = i0; i <= i1; i++) {
      p.x = g.x0 + (i + 0.5) * g.c;
      if (pointInPolygon(p, poly)) each(j * g.nx + i);
    }
  }
  for (let e = 0; e < poly.length; e++) {
    traverse(g, poly[e] as Vec2, poly[(e + 1) % poly.length] as Vec2, each);
  }
}

/** Typed arrays kept between runs (a drag runs the check many times a second). */
export class Buffers {
  n = 0;
  colD2 = new Int32Array(0);
  colRow = new Int32Array(0);
  d2 = new Float64Array(0);
  near = new Int32Array(0);
  envV = new Int32Array(0);
  envZ = new Float64Array(0);
  envF = new Float64Array(0);
  fit(g: Grid) {
    if (this.n < g.n) {
      this.n = g.n;
      this.colD2 = new Int32Array(g.n);
      this.colRow = new Int32Array(g.n);
      this.d2 = new Float64Array(g.n);
      this.near = new Int32Array(g.n);
    }
    if (this.envV.length < g.nx + 1) {
      this.envV = new Int32Array(g.nx + 1);
      this.envZ = new Float64Array(g.nx + 2);
      this.envF = new Float64Array(g.nx + 1);
    }
  }
}

const INF = 1e18;

/**
 * Exact squared distance (in cells²) from every cell to the nearest solid cell, and which
 * cell that is (Felzenszwalb–Huttenlocher, columns then rows). Results in `buf.d2`, `buf.near`.
 */
export function distanceField(g: Grid, solid: Uint8Array, buf: Buffers) {
  buf.fit(g);
  const { nx, ny } = g;
  const { colD2, colRow, d2, near, envV: v, envZ: z, envF: f } = buf;
  // Down each column: the nearest solid row above and below.
  for (let i = 0; i < nx; i++) {
    let last = -1;
    for (let j = 0; j < ny; j++) {
      const k = j * nx + i;
      if (solid[k]) last = j;
      colRow[k] = last;
      colD2[k] = last < 0 ? -1 : (j - last) * (j - last);
    }
    last = -1;
    for (let j = ny - 1; j >= 0; j--) {
      const k = j * nx + i;
      if (solid[k]) last = j;
      if (last >= 0) {
        const dd = (last - j) * (last - j);
        if ((colD2[k] as number) < 0 || dd < (colD2[k] as number)) {
          colD2[k] = dd;
          colRow[k] = last;
        }
      }
    }
  }
  // Along each row: the lower envelope of the columns' parabolas.
  for (let j = 0; j < ny; j++) {
    const row = j * nx;
    let kk = -1;
    for (let q = 0; q < nx; q++) {
      const cd = colD2[row + q] as number;
      if (cd < 0) continue;
      f[q] = cd;
      if (kk < 0) {
        kk = 0;
        v[0] = q;
        z[0] = -INF;
        z[1] = INF;
        continue;
      }
      let s = 0;
      for (;;) {
        const p = v[kk] as number;
        s = ((f[q] as number) + q * q - ((f[p] as number) + p * p)) / (2 * q - 2 * p);
        if (s <= (z[kk] as number) && kk > 0) kk--;
        else break;
      }
      if (s <= (z[kk] as number)) {
        // Replaces the only parabola.
        v[kk] = q;
        z[kk] = -INF;
        z[kk + 1] = INF;
        continue;
      }
      kk++;
      v[kk] = q;
      z[kk] = s;
      z[kk + 1] = INF;
    }
    if (kk < 0) {
      for (let i = 0; i < nx; i++) {
        d2[row + i] = INF;
        near[row + i] = -1;
      }
      continue;
    }
    let e = 0;
    for (let i = 0; i < nx; i++) {
      while ((z[e + 1] as number) < i) e++;
      const p = v[e] as number;
      d2[row + i] = (i - p) * (i - p) + (f[p] as number);
      near[row + i] = (colRow[row + p] as number) * nx + p;
    }
  }
}

/** A widest-way search's results; a cell's values hold only where `mark` is this run's `id`. */
export class Search {
  b: Float32Array;
  parent: Int32Array;
  mark: Uint32Array;
  done: Uint32Array;
  id = 0;
  /** The bucket queue's entries, kept between runs. */
  pool = new Int32Array(0);
  next = new Int32Array(0);
  constructor(n: number) {
    this.b = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.mark = new Uint32Array(n);
    this.done = new Uint32Array(n);
  }
  fit(n: number) {
    if (this.b.length < n) {
      this.b = new Float32Array(n);
      this.parent = new Int32Array(n);
      this.mark = new Uint32Array(n);
      this.done = new Uint32Array(n);
      this.id = 0;
    }
  }
  reached(k: number): boolean {
    return this.mark[k] === this.id;
  }
  /** The best width the way to k keeps (-1: not reached). */
  width(k: number): number {
    return this.mark[k] === this.id ? (this.b[k] as number) : -1;
  }
  /** The cells from the start to k. */
  path(k: number): number[] {
    const out: number[] = [];
    for (let at = k, guard = 0; at >= 0 && guard < this.b.length; guard++) {
      out.push(at);
      at = this.parent[at] as number;
    }
    return out.reverse();
  }
}

/**
 * The widest way from the seeds to every cell (maximin over the cells' widths, 8 ways, no
 * corner cutting), bucketed by `step`; widths above `wide` count as wide. With `only`, the
 * search keeps to cells of that room. `first[r]` gets the first cell of room r reached at its
 * best width (popped in order of width, then breadth first, so near its way in), not counting
 * cells marked in `notIn` (a doorway's throat: the room is reached once through it).
 */
export function widestWays(
  g: Grid,
  width: Float32Array,
  seeds: readonly number[],
  seedWidth: number | null,
  out: Search,
  opts: {
    wide: number;
    step: number;
    room?: Int16Array;
    only?: number;
    first?: Int32Array;
    notIn?: Int16Array;
  },
) {
  out.fit(g.n);
  out.id++;
  if (out.id >= 0xffffffff) {
    out.mark.fill(0);
    out.done.fill(0);
    out.id = 1;
  }
  const id = out.id;
  const { b, parent, mark, done } = out;
  const nb = Math.round(opts.wide / opts.step) + 1;
  // Buckets as FIFO lists in one pool of entries (cell, next).
  const head = new Int32Array(nb).fill(-1);
  const tail = new Int32Array(nb).fill(-1);
  let pool = out.pool;
  let next = out.next;
  let used = 0;
  const inv = 1 / opts.step;
  const push = (k: number, w: number) => {
    let q = Math.floor(w * inv + 1e-6);
    if (q < 0) q = 0;
    else if (q >= nb) q = nb - 1;
    if (used >= pool.length) {
      const grown = new Int32Array(pool.length * 2 + 1024);
      grown.set(pool);
      const gn = new Int32Array(grown.length);
      gn.set(next);
      pool = grown;
      next = gn;
      out.pool = pool;
      out.next = next;
    }
    pool[used] = k;
    next[used] = -1;
    const t = tail[q] as number;
    if (t < 0) head[q] = used;
    else next[t] = used;
    tail[q] = used;
    used++;
  };
  const room = opts.room;
  const only = opts.only ?? -1;
  const ok = (k: number) => (width[k] as number) >= 0 && (only < 0 || room?.[k] === only);
  for (const s of seeds) {
    if (!ok(s)) continue;
    const w = Math.min(width[s] as number, seedWidth ?? Number.POSITIVE_INFINITY, opts.wide);
    if (mark[s] === id && (b[s] as number) >= w) continue;
    mark[s] = id;
    b[s] = w;
    parent[s] = -1;
    push(s, w);
  }
  const { nx, n } = g;
  const first = opts.first;
  const off = [1, -1, nx, -nx, 1 + nx, 1 - nx, -1 + nx, -1 - nx];
  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  for (let q = nb - 1; q >= 0; q--) {
    for (let h = head[q] as number; h >= 0; h = next[h] as number) {
      const k = pool[h] as number;
      if (done[k] === id) continue;
      done[k] = id;
      const bk = b[k] as number;
      if (first && room && !(opts.notIn && (opts.notIn[k] as number) >= 0)) {
        const r = room[k] as number;
        if (r >= 0 && (first[r] as number) < 0) first[r] = k;
      }
      const i = k % nx;
      for (let e = 0; e < 8; e++) {
        const ddi = dx[e] as number;
        if (i + ddi < 0 || i + ddi >= nx) continue;
        const m = k + (off[e] as number);
        if (m < 0 || m >= n || done[m] === id || !ok(m)) continue;
        // Diagonally only between two open cells (no slipping between two corners).
        if (e >= 4 && (!ok(k + ddi) || !ok(m - ddi))) continue;
        const wm = width[m] as number;
        const w = bk < wm ? bk : wm;
        if (mark[m] === id && (b[m] as number) >= w) continue;
        mark[m] = id;
        b[m] = w;
        parent[m] = k;
        push(m, w);
      }
    }
  }
}
