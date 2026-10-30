import { pointInPolygon, signedArea } from './geometry';
import { type PlanGeometry, planGeometry } from './plan';
import { roomShapes } from './rooms';
import type { Level, Vec2 } from './schema';

/**
 * First-person walking, in plan space. The walker is a circle on the floor; walls are the
 * edges of the plan's solid wall pieces and junction hubs. Door and passage gaps are open
 * (the pieces already leave them out); windows are closed again with their own outline.
 * Room boundaries have no pieces, so they never block.
 */
export interface Segment {
  a: Vec2;
  b: Vec2;
}

/** A person, roughly: shoulder radius and eye height, in metres. */
export const WALKER_RADIUS = 0.2;
export const EYE_HEIGHT = 1.6;

export function collisionSegments(level: Level, geom: PlanGeometry = planGeometry(level)) {
  const out: Segment[] = [];
  const ring = (poly: readonly Vec2[]) => {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i] as Vec2;
      const b = poly[(i + 1) % poly.length] as Vec2;
      if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-9) out.push({ a, b });
    }
  };
  for (const p of geom.pieces) ring(p.polygon);
  for (const h of geom.footprints.hubs) ring(h.polygon);
  for (const o of geom.openings) if (o.kind === 'window') ring(o.polygon);
  return out;
}

function closestOnSegment(p: Vec2, s: Segment): Vec2 {
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 > 0 ? Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / len2)) : 0;
  return { x: s.a.x + dx * t, y: s.a.y + dy * t };
}

/** Pushes a circle at `p` out of every segment it overlaps; a few passes settle corners. */
function resolve(p: Vec2, segments: readonly Segment[], radius: number): Vec2 {
  let q = p;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const s of segments) {
      const c = closestOnSegment(q, s);
      const dx = q.x - c.x;
      const dy = q.y - c.y;
      const d = Math.hypot(dx, dy);
      if (d >= radius - 1e-9) continue;
      if (d < 1e-12) continue; // exactly on the line: no direction to push in
      const push = (radius - d) / d;
      q = { x: q.x + dx * push, y: q.y + dy * push };
      moved = true;
    }
    if (!moved) break;
  }
  return q;
}

/**
 * Where a walker at `from` ends up after trying to move by `delta`: it slides along walls
 * instead of stopping dead. The move is taken in steps no longer than half the radius, so
 * a fast step can't tunnel through a thin wall.
 */
export function walk(
  segments: readonly Segment[],
  from: Vec2,
  delta: Vec2,
  radius = WALKER_RADIUS,
): Vec2 {
  const dist = Math.hypot(delta.x, delta.y);
  const steps = Math.max(1, Math.ceil(dist / (radius / 2)));
  let p = from;
  for (let i = 0; i < steps; i++) {
    p = resolve({ x: p.x + delta.x / steps, y: p.y + delta.y / steps }, segments, radius);
  }
  return p;
}

/**
 * Where to start a walk: inside the largest room (usually the living room), at a spot with
 * room to stand, looking along the room's longer side. `heading` is the angle in plan space
 * (radians from +x towards +y).
 */
export function walkStart(level: Level): { at: Vec2; heading: number } | null {
  const shapes = roomShapes(level);
  let best: { area: number; outer: Vec2[]; holes: Vec2[][] } | null = null;
  for (const s of shapes.values()) {
    const area =
      Math.abs(signedArea(s.outer)) - s.holes.reduce((t, h) => t + Math.abs(signedArea(h)), 0);
    if (!best || area > best.area) best = { area, outer: s.outer, holes: s.holes };
  }
  if (!best) return null;
  const segments = collisionSegments(level);
  const xs = best.outer.map((p) => p.x);
  const ys = best.outer.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // The point inside the floor furthest from any wall, on a coarse grid.
  let at: Vec2 | null = null;
  let clear = -1;
  const n = 24;
  for (let i = 1; i < n; i++) {
    for (let j = 1; j < n; j++) {
      const p = { x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * j) / n };
      if (!pointInPolygon(p, best.outer) || best.holes.some((h) => pointInPolygon(p, h))) continue;
      let d = Number.POSITIVE_INFINITY;
      for (const s of segments) {
        const c = closestOnSegment(p, s);
        d = Math.min(d, Math.hypot(p.x - c.x, p.y - c.y));
      }
      if (d > clear) {
        clear = d;
        at = p;
      }
    }
  }
  if (!at) return null;
  // Face the longest clear view inside the flat, in 16 directions; a view out through an
  // open door (an endless ray) doesn't count.
  let heading = 0;
  let far = -1;
  for (let i = 0; i < 16; i++) {
    const h = (i * Math.PI) / 8;
    const ray = rayDistance(segments, at, { x: Math.cos(h), y: Math.sin(h) });
    const d = Number.isFinite(ray) ? ray : -1;
    if (d > far + 1e-9) {
      far = d;
      heading = h;
    }
  }
  return { at, heading };
}

/** How far a ray from `p` along unit `dir` travels before it meets a segment. */
export function rayDistance(segments: readonly Segment[], p: Vec2, dir: Vec2): number {
  let best = Number.POSITIVE_INFINITY;
  for (const s of segments) {
    const ex = s.b.x - s.a.x;
    const ey = s.b.y - s.a.y;
    const den = dir.x * ey - dir.y * ex;
    if (Math.abs(den) < 1e-12) continue;
    const wx = s.a.x - p.x;
    const wy = s.a.y - p.y;
    const t = (wx * ey - wy * ex) / den;
    const u = (wx * dir.y - wy * dir.x) / den;
    if (t > 0 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return best;
}
