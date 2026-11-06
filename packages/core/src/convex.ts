import type { Vec2 } from './schema';

/**
 * Small polygon helpers for the clearance checks: boxes, overlap, clipping, distances, and
 * the area off one side of a piece. Polygons are short (a footprint, a wall piece, a door's
 * sweep) and mostly convex. Metres.
 */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const boxes = new WeakMap<readonly Vec2[], Box>();
/** A polygon's bounding box (kept per polygon). */
export function box(poly: readonly Vec2[]): Box {
  let b = boxes.get(poly);
  if (!b) {
    b = {
      x0: Number.POSITIVE_INFINITY,
      y0: Number.POSITIVE_INFINITY,
      x1: Number.NEGATIVE_INFINITY,
      y1: Number.NEGATIVE_INFINITY,
    };
    for (const p of poly) {
      b.x0 = Math.min(b.x0, p.x);
      b.y0 = Math.min(b.y0, p.y);
      b.x1 = Math.max(b.x1, p.x);
      b.y1 = Math.max(b.y1, p.y);
    }
    boxes.set(poly, b);
  }
  return b;
}
/** Whether two polygons' boxes meet, `pad` apart at most (a quick no before the exact test). */
export const near = (p: readonly Vec2[], q: readonly Vec2[], pad = 0) => {
  const a = box(p);
  const b = box(q);
  return a.x0 <= b.x1 + pad && b.x0 <= a.x1 + pad && a.y0 <= b.y1 + pad && b.y0 <= a.y1 + pad;
};

export const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;

function axes(poly: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as Vec2;
    const q = poly[(i + 1) % poly.length] as Vec2;
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len > 1e-9) out.push({ x: -(q.y - p.y) / len, y: (q.x - p.x) / len });
  }
  return out;
}

/** How far two convex polygons overlap (the least push to part them); 0 when apart. */
export function overlapDepth(p: readonly Vec2[], q: readonly Vec2[]): number {
  if (!near(p, q)) return 0;
  let least = Number.POSITIVE_INFINITY;
  for (const n of [...axes(p), ...axes(q)]) {
    let p0 = Number.POSITIVE_INFINITY;
    let p1 = Number.NEGATIVE_INFINITY;
    let q0 = Number.POSITIVE_INFINITY;
    let q1 = Number.NEGATIVE_INFINITY;
    for (const v of p) {
      const d = dot(v, n);
      p0 = Math.min(p0, d);
      p1 = Math.max(p1, d);
    }
    for (const v of q) {
      const d = dot(v, n);
      q0 = Math.min(q0, d);
      q1 = Math.max(q1, d);
    }
    const o = Math.min(p1, q1) - Math.max(p0, q0);
    if (o <= 0) return 0;
    least = Math.min(least, o);
  }
  return Number.isFinite(least) ? least : 0;
}

/** `poly` clipped to the half-plane where `f(v) >= 0` (f linear). */
export function clipHalf(poly: Vec2[], f: (v: Vec2) => number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Vec2;
    const b = poly[(i + 1) % poly.length] as Vec2;
    const fa = f(a);
    const fb = f(b);
    if (fa >= 0) out.push(a);
    if (fa >= 0 !== fb >= 0) {
      const t = fa / (fa - fb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

export function convexHull(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: Vec2, a: Vec2, b: Vec2) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2] as Vec2, lower[lower.length - 1] as Vec2, p) <= 0
    )
      lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (const p of [...pts].reverse()) {
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2] as Vec2, upper[upper.length - 1] as Vec2, p) <= 0
    )
      upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The point of segment ab nearest p. */
export function nearestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const len2 = ex * ex + ey * ey;
  const t =
    len2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2));
  return { x: a.x + ex * t, y: a.y + ey * t };
}

function inside(p: Vec2, poly: readonly Vec2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Vec2;
    const b = poly[j] as Vec2;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/** The nearest point of a polygon to p, and how far it is (0 inside). */
export function nearestOnPolygon(p: Vec2, poly: readonly Vec2[]): { at: Vec2; d: number } {
  if (inside(p, poly)) return { at: p, d: 0 };
  let best = { at: poly[0] ?? p, d: Number.POSITIVE_INFINITY };
  for (let i = 0; i < poly.length; i++) {
    const q = nearestOnSegment(p, poly[i] as Vec2, poly[(i + 1) % poly.length] as Vec2);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < best.d) best = { at: q, d };
  }
  return best;
}

/** The nearest point of a polygon's edge to p (inside or out), the edge's index and distance. */
export function nearestOnEdge(
  p: Vec2,
  poly: readonly Vec2[],
): { at: Vec2; d: number; edge: number } {
  let best = { at: poly[0] ?? p, d: Number.POSITIVE_INFINITY, edge: 0 };
  for (let i = 0; i < poly.length; i++) {
    const q = nearestOnSegment(p, poly[i] as Vec2, poly[(i + 1) % poly.length] as Vec2);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < best.d) best = { at: q, d, edge: i };
  }
  return best;
}

/**
 * How far apart two polygons are, and the nearest pair of points (one on each); 0 when they
 * meet. Exact for polygons whose edges don't cross (vertex-to-edge both ways).
 */
export function polygonGap(
  p: readonly Vec2[],
  q: readonly Vec2[],
): { d: number; a: Vec2; b: Vec2 } {
  let best = { d: Number.POSITIVE_INFINITY, a: p[0] as Vec2, b: q[0] as Vec2 };
  if (overlapDepth(p, q) > 0) return { d: 0, a: best.a, b: best.a };
  const one = (from: readonly Vec2[], to: readonly Vec2[], flip: boolean) => {
    for (const v of from) {
      for (let i = 0; i < to.length; i++) {
        const w = nearestOnSegment(v, to[i] as Vec2, to[(i + 1) % to.length] as Vec2);
        const d = Math.hypot(w.x - v.x, w.y - v.y);
        if (d < best.d) best = flip ? { d, a: w, b: v } : { d, a: v, b: w };
      }
    }
  };
  one(p, q, false);
  one(q, p, true);
  return best;
}

// --- the area off one side of a piece -----------------------------------------------------

/** One side of a piece: its two corners (left to right, looking out) and outward normal. */
export interface Side {
  a: Vec2;
  b: Vec2;
  n: Vec2;
  width: number;
}

/** Footprint corners: back-left, back-right, front-right, front-left (itemFootprint). */
export function sideOf(fp: Vec2[], side: 'front' | 'left' | 'right'): Side {
  const [bl, br, fr, fl] = fp as [Vec2, Vec2, Vec2, Vec2];
  const [a, b, inner] =
    // Each long side from the foot (front) to the head (back).
    side === 'front' ? [fr, fl, br] : side === 'left' ? [fl, bl, fr] : [fr, br, fl];
  const width = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  // Outward: away from the opposite side.
  const d = { x: (b.x - a.x) / width, y: (b.y - a.y) / width };
  let n = { x: -d.y, y: d.x };
  if (dot({ x: inner.x - a.x, y: inner.y - a.y }, n) > 0) n = { x: -n.x, y: -n.y };
  return { a, b, n, width };
}

/** The area `need` deep off a side. */
export function zoneOf(s: Side, need: number): Vec2[] {
  const off = (p: Vec2) => ({ x: p.x + s.n.x * need, y: p.y + s.n.y * need });
  return [s.a, s.b, off(s.b), off(s.a)];
}

/** The room off a side, up to `need`: how far the nearest obstacle is, in the side's width. */
export function roomOff(s: Side, need: number, obstacles: Vec2[][]): number {
  const d = { x: (s.b.x - s.a.x) / s.width, y: (s.b.y - s.a.y) / s.width };
  const u = (p: Vec2) => (p.x - s.a.x) * d.x + (p.y - s.a.y) * d.y;
  const v = (p: Vec2) => (p.x - s.a.x) * s.n.x + (p.y - s.a.y) * s.n.y;
  // A wall or piece only touching the side's ends (a corner) isn't in front of it.
  const e = 0.01;
  let have = need;
  const zone = zoneOf(s, need);
  for (const poly of obstacles) {
    if (!near(zone, poly)) continue;
    let c = clipHalf(poly, (p) => u(p) - e);
    c = clipHalf(c, (p) => s.width - e - u(p));
    c = clipHalf(c, (p) => v(p) + 0.005);
    c = clipHalf(c, (p) => need - v(p));
    for (const p of c) have = Math.min(have, Math.max(0, v(p)));
  }
  return have;
}

/** A side cut to its first `width` (from its start). */
export function shorten(s: Side, width: number): Side {
  const k = width / s.width;
  return { ...s, b: { x: s.a.x + (s.b.x - s.a.x) * k, y: s.a.y + (s.b.y - s.a.y) * k }, width };
}

/** A piece's footprint (back-left, back-right, front-right, front-left) grown by `by` all round. */
export function growRect(fp: Vec2[], by: number): Vec2[] {
  const [bl, br, fr, fl] = fp as [Vec2, Vec2, Vec2, Vec2];
  const unit = (p: Vec2, q: Vec2) => {
    const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    return { x: ((q.x - p.x) / len) * by, y: ((q.y - p.y) / len) * by };
  };
  const ex = unit(bl, br);
  const ey = unit(bl, fl);
  const at = (p: Vec2, sx: number, sy: number) => ({
    x: p.x + ex.x * sx + ey.x * sy,
    y: p.y + ex.y * sx + ey.y * sy,
  });
  return [at(bl, -1, -1), at(br, 1, -1), at(fr, 1, 1), at(fl, -1, 1)];
}
