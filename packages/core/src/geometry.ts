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

/** Floor area of the room's loop, in m². Measured to wall centre lines. */
export function roomArea(level: Level, room: Room): number {
  return Math.abs(signedArea(roomPolygon(level, room)));
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
