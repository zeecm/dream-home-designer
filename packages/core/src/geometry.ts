import type { Level, Opening, Room, Vec2, Wall } from './schema';

export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const length = (a: Vec2): number => Math.hypot(a.x, a.y);
export const distance = (a: Vec2, b: Vec2): number => length(sub(a, b));

/** Shoelace formula. Sign depends on winding; use Math.abs for an area. */
export function signedArea(points: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Vec2;
    const q = points[(i + 1) % points.length] as Vec2;
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

export function roomPolygon(level: Level, room: Room): Vec2[] {
  return room.loop.map((id) => {
    const v = level.vertices[id];
    if (!v) throw new Error(`room ${room.id} references missing vertex ${id}`);
    return { x: v.x, y: v.y };
  });
}

export function centroid(points: readonly Vec2[]): Vec2 {
  const n = points.length || 1;
  const s = points.reduce((acc, p) => add(acc, p), { x: 0, y: 0 });
  return scale(s, 1 / n);
}

export interface WallLine {
  a: Vec2;
  b: Vec2;
  length: number;
  /** Rotation about world +Y that aligns local +X with a->b (plan y maps to world z). */
  angle: number;
}

export function wallLine(level: Level, wall: Wall): WallLine {
  const a = level.vertices[wall.a];
  const b = level.vertices[wall.b];
  if (!a || !b) throw new Error(`wall ${wall.id} references a missing vertex`);
  const d = sub(b, a);
  return { a, b, length: length(d), angle: -Math.atan2(d.y, d.x) };
}

/** An axis-aligned box in wall-local space: u along the wall from a, y up from the floor. */
export interface WallPiece {
  u0: number;
  u1: number;
  y0: number;
  y1: number;
}

/**
 * Splits a wall into solid boxes around its rectangular openings: full-height pieces
 * between openings, plus a lintel above and (for windows) a sill wall below each one.
 * This avoids CSG entirely for v1, where every opening is rectangular.
 */
export function wallPieces(
  wallLength: number,
  height: number,
  openings: readonly Opening[],
): WallPiece[] {
  const holes = openings
    .map((o) => {
      const c = o.t * wallLength;
      const u0 = Math.max(0, c - o.width / 2);
      const u1 = Math.min(wallLength, c + o.width / 2);
      const y0 = Math.max(0, Math.min(height, o.sill));
      const y1 = Math.max(y0, Math.min(height, o.sill + o.height));
      return { u0, u1, y0, y1 };
    })
    .filter((h) => h.u1 > h.u0 && h.y1 > h.y0)
    .sort((p, q) => p.u0 - q.u0);

  const pieces: WallPiece[] = [];
  let cursor = 0;
  for (const h of holes) {
    const u0 = Math.max(h.u0, cursor);
    if (h.u1 <= u0) continue; // fully covered by an earlier hole
    if (u0 > cursor) pieces.push({ u0: cursor, u1: u0, y0: 0, y1: height });
    if (h.y0 > 0) pieces.push({ u0, u1: h.u1, y0: 0, y1: h.y0 });
    if (h.y1 < height) pieces.push({ u0, u1: h.u1, y0: h.y1, y1: height });
    cursor = h.u1;
  }
  if (cursor < wallLength) pieces.push({ u0: cursor, u1: wallLength, y0: 0, y1: height });
  return pieces;
}

/** Aluminium frame width around glass (m). */
export const GLASS_FRAME = 0.04;
/** Glass panes wider than this get a mullion between them (m). */
const MAX_PANE = 1.2;

/**
 * A framed glass partition from `y0` to `y1` along a wall, around its openings (a door
 * through a glass wall, or into the wall under fixed glass): the panes (thin glass) and the
 * frame (full thickness: a rail along the bottom and top of each stretch, a post at each end,
 * and mullions so no pane is wider than 1.2 m). A stretch too narrow for glass is all frame.
 */
export function glassPartition(
  wallLength: number,
  y0: number,
  y1: number,
  openings: readonly Opening[],
  frame = GLASS_FRAME,
): { panes: WallPiece[]; frame: WallPiece[] } {
  const panes: WallPiece[] = [];
  const bars: WallPiece[] = [];
  for (const p of wallPieces(wallLength, y1, openings)) {
    const lo = Math.max(y0, p.y0);
    if (p.y1 - lo < 1e-6) continue;
    const { u0, u1 } = p;
    if (u1 - u0 <= 2 * frame + 0.01 || p.y1 - lo <= 2 * frame + 0.01) {
      bars.push({ u0, u1, y0: lo, y1: p.y1 });
      continue;
    }
    bars.push({ u0, u1, y0: lo, y1: lo + frame }, { u0, u1, y0: p.y1 - frame, y1: p.y1 });
    const inner = u1 - u0 - 2 * frame;
    const n = Math.max(1, Math.ceil((inner - 1e-6) / MAX_PANE));
    const step = (inner - (n - 1) * frame) / n;
    let u = u0;
    for (let i = 0; i <= n; i++) {
      bars.push({ u0: u, u1: u + frame, y0: lo + frame, y1: p.y1 - frame });
      if (i < n)
        panes.push({ u0: u + frame, u1: u + frame + step, y0: lo + frame, y1: p.y1 - frame });
      u += frame + step;
    }
  }
  return { panes, frame: bars };
}

export function openingsOnWall(level: Level, wallId: string): Opening[] {
  return Object.values(level.openings).filter((o) => o.wallId === wallId);
}

export interface Bounds {
  min: Vec2;
  max: Vec2;
}

export function levelBounds(level: Level): Bounds | null {
  const vs = Object.values(level.vertices);
  if (vs.length === 0) return null;
  const min = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY };
  const max = { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY };
  for (const v of vs) {
    min.x = Math.min(min.x, v.x);
    min.y = Math.min(min.y, v.y);
    max.x = Math.max(max.x, v.x);
    max.y = Math.max(max.y, v.y);
  }
  return { min, max };
}

/** Keeps an opening's centre far enough from both wall ends that it fits on the wall. */
export function clampOpeningT(wallLength: number, width: number, t: number): number {
  if (wallLength <= 0) return 0.5;
  const half = Math.min(0.5, width / 2 / wallLength);
  return Math.min(1 - half, Math.max(half, t));
}

/** Area-weighted centroid of a simple polygon; the vertex average if it has no area. */
export function polygonCentroid(points: readonly Vec2[]): Vec2 {
  const a = signedArea(points);
  if (Math.abs(a) < 1e-12) return centroid(points);
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Vec2;
    const q = points[(i + 1) % points.length] as Vec2;
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

/** Even-odd test; points exactly on an edge may land either way. */
export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Vec2;
    const b = poly[j] as Vec2;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Where a horizontal line at `y` crosses the polygon's edges, worked out as `pointInPolygon`
 * does: (x, y) is inside exactly when `insideAt(crossingsAt(poly, y), x)`. For testing a row
 * of points (a raster's cells) at the cost of one edge pass.
 */
export function crossingsAt(poly: readonly Vec2[], y: number): number[] {
  const xs: number[] = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Vec2;
    const b = poly[j] as Vec2;
    if (a.y > y !== b.y > y) xs.push(((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x);
  }
  return xs;
}

/** Whether x is inside, on a row whose `crossingsAt` are `xs` (even-odd, as pointInPolygon). */
export function insideAt(xs: readonly number[], x: number): boolean {
  let inside = false;
  for (const c of xs) if (x < c) inside = !inside;
  return inside;
}

/**
 * A point inside the polygon to hang its label on: the area centroid when that is
 * inside (most rooms), otherwise the middle of the widest horizontal run through the
 * polygon's vertical centre.
 */
export function labelPoint(poly: readonly Vec2[]): Vec2 {
  const c = polygonCentroid(poly);
  if (pointInPolygon(c, poly)) return c;
  const ys = poly.map((p) => p.y);
  const y = (Math.min(...ys) + Math.max(...ys)) / 2;
  const xs: number[] = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Vec2;
    const b = poly[j] as Vec2;
    if (a.y > y !== b.y > y) xs.push(((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x);
  }
  xs.sort((p, q) => p - q);
  let best: Vec2 = c;
  let width = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const x0 = xs[i] as number;
    const x1 = xs[i + 1] as number;
    if (x1 - x0 > width) {
      width = x1 - x0;
      best = { x: (x0 + x1) / 2, y };
    }
  }
  return best;
}

export interface Circle {
  c: Vec2;
  r: number;
}

function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/**
 * How much room a label box of half-size `half` centred at `p` has to spare: the smallest gap
 * from its outline (sampled at corners and edge midpoints) to the polygon's edges and to the
 * circles. Negative when it pokes outside the polygon or into a circle.
 */
export function labelClearance(
  p: Vec2,
  half: Vec2,
  poly: readonly Vec2[],
  avoid: readonly Circle[],
  holes: readonly (readonly Vec2[])[],
) {
  return clearance(p, half, poly, avoid, holes, 0, Number.NEGATIVE_INFINITY);
}

/**
 * `labelClearance`, giving up early on a spot `placeLabel` would not pick: once it's known
 * not to fit and to score (`clearance - cost`) below `beat` (or level with it, when
 * `tiesLose`), the rest can only lower it, so it returns what it has so far (a value at or
 * above the true clearance, never a fit).
 */
function clearance(
  p: Vec2,
  half: Vec2,
  poly: readonly Vec2[],
  avoid: readonly Circle[],
  holes: readonly (readonly Vec2[])[],
  cost: number,
  beat: number,
  tiesLose = false,
) {
  const rings = [poly, ...holes];
  let worst = Number.POSITIVE_INFINITY;
  for (let sx = -1; sx <= 1; sx++) {
    for (let sy = -1; sy <= 1; sy++) {
      const q = { x: p.x + sx * half.x, y: p.y + sy * half.y };
      let edge = Number.POSITIVE_INFINITY;
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          edge = Math.min(edge, segmentDistance(q, ring[j] as Vec2, ring[i] as Vec2));
        }
      }
      let inside = pointInPolygon(q, poly);
      for (let k = 0; inside && k < holes.length; k++) {
        if (pointInPolygon(q, holes[k] as Vec2[])) inside = false;
      }
      // Strictly negative outside, so a point on an edge never counts as fitting.
      let gap = inside ? edge : -edge - 1e-9;
      for (const c of avoid) gap = Math.min(gap, Math.hypot(q.x - c.c.x, q.y - c.c.y) - c.r);
      worst = Math.min(worst, gap);
      if (worst < 0) {
        const score = worst - cost;
        if (score < beat || (score === beat && tiesLose)) return worst;
      }
    }
  }
  return worst;
}

/** The smallest axis-aligned box round the points (both corners at 0, 0 when there are none). */
export function polygonBounds(poly: readonly Vec2[]): Bounds {
  if (poly.length === 0) return { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
  const min = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY };
  const max = { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY };
  for (const p of poly) {
    min.x = Math.min(min.x, p.x);
    min.y = Math.min(min.y, p.y);
    max.x = Math.max(max.x, p.x);
    max.y = Math.max(max.y, p.y);
  }
  return { min, max };
}

/** How far past `near`'s reach a circle must be to be left out: well over rounding error. */
const NEAR_MARGIN = 0.01;

/**
 * The circles that can change a label's clearance in this room: those reaching the room's box
 * grown by `half` (where any label box's outline can be, centred in the room). One wholly
 * outside it is further from every sampled point inside the room than the room's own edge
 * is, and never covers one outside it, so `labelClearance` (and `placeLabel`) give the same
 * answer without it, to the bit. On a big plan this is a few circles instead of hundreds.
 */
export function circlesNear(
  poly: readonly Vec2[],
  half: Vec2,
  circles: readonly Circle[],
): Circle[] {
  const { min, max } = polygonBounds(poly);
  const x0 = min.x - half.x;
  const y0 = min.y - half.y;
  const x1 = max.x + half.x;
  const y1 = max.y + half.y;
  return circles.filter(({ c, r }) => {
    const dx = c.x - Math.max(x0, Math.min(c.x, x1));
    const dy = c.y - Math.max(y0, Math.min(c.y, y1));
    const reach = r + NEAR_MARGIN;
    return dx * dx + dy * dy <= reach * reach;
  });
}

/**
 * Where to put a room's label box (half-size `half`, metres) so it stays inside the room,
 * out of its `holes` and clear of the `avoid` circles, such as door swings: `labelPoint` when
 * that fits, otherwise the roomiest spot on a grid over the room, preferring spots near
 * `labelPoint`.
 */
export function placeLabel(
  poly: readonly Vec2[],
  half: Vec2,
  avoid: readonly Circle[] = [],
  holes: readonly (readonly Vec2[])[] = [],
  steps = 20,
): Vec2 {
  const home = labelPoint(poly);
  if (poly.length < 3) return home;
  // Only the circles that can tell: on a big plan most are rooms away (same answer, faster).
  const near = circlesNear(poly, half, avoid);
  if (labelClearance(home, half, poly, near, holes) >= 0) return home;
  const {
    min: { x: x0, y: y0 },
    max,
  } = polygonBounds(poly);
  const w = max.x - x0;
  const h = max.y - y0;
  // The grid's spots nearest `home` first: once one fits, a spot further out can't beat it,
  // so most are never measured. Ties go to the first spot in row order, as a plain scan of
  // the grid gives them, so the answer is the same.
  const spots: { p: Vec2; cost: number; k: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const p = { x: x0 + (w * i) / steps, y: y0 + (h * j) / steps };
      // Any spot that fits beats any that doesn't; among those, stay close to the centre.
      spots.push({ p, cost: 0.1 * Math.hypot(p.x - home.x, p.y - home.y), k: spots.length });
    }
  }
  spots.sort((a, b) => a.cost - b.cost || a.k - b.k);
  let best = home;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestK = -1;
  const beats = (score: number, k: number) =>
    score > bestScore || (score === bestScore && k < bestK);
  for (const { p, cost, k } of spots) {
    // Not even a fit here would beat the best: no need to measure it.
    if (!beats(1000 - cost, k) || !pointInPolygon(p, poly)) continue;
    const clear = clearance(p, half, poly, near, holes, cost, bestScore, k > bestK);
    const score = (clear >= 0 ? 1000 : clear) - cost;
    if (beats(score, k)) {
      bestScore = score;
      best = p;
      bestK = k;
    }
  }
  return best;
}
