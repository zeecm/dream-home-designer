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
function labelClearance(
  p: Vec2,
  half: Vec2,
  poly: readonly Vec2[],
  avoid: readonly Circle[],
  holes: readonly (readonly Vec2[])[],
) {
  let worst = Number.POSITIVE_INFINITY;
  for (const sx of [-1, 0, 1]) {
    for (const sy of [-1, 0, 1]) {
      const q = { x: p.x + sx * half.x, y: p.y + sy * half.y };
      let edge = Number.POSITIVE_INFINITY;
      for (const ring of [poly, ...holes]) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          edge = Math.min(edge, segmentDistance(q, ring[j] as Vec2, ring[i] as Vec2));
        }
      }
      const inside = pointInPolygon(q, poly) && !holes.some((h) => pointInPolygon(q, h));
      let gap = inside ? edge : -edge;
      for (const c of avoid) gap = Math.min(gap, Math.hypot(q.x - c.c.x, q.y - c.c.y) - c.r);
      worst = Math.min(worst, gap);
    }
  }
  return worst;
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
  if (poly.length < 3 || labelClearance(home, half, poly, avoid, holes) >= 0) return home;
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0;
  const h = Math.max(...ys) - y0;
  let best = home;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const p = { x: x0 + (w * i) / steps, y: y0 + (h * j) / steps };
      if (!pointInPolygon(p, poly)) continue;
      const clear = labelClearance(p, half, poly, avoid, holes);
      // Any spot that fits beats any that doesn't; among those, stay close to the centre.
      const score = (clear >= 0 ? 1000 : clear) - 0.1 * Math.hypot(p.x - home.x, p.y - home.y);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
  }
  return best;
}
