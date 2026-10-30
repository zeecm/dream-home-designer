import type { Level, Vec2 } from './schema';

/**
 * Plan-space outline of one wall with mitred ends. "Left" is the side of the normal
 * n = (-d.y, d.x), where d is the unit direction from vertex a to vertex b.
 */
export interface WallFootprint {
  wallId: string;
  aL: Vec2;
  bL: Vec2;
  bR: Vec2;
  aR: Vec2;
}

/** Fills the middle of a junction where three or more walls meet (or a bevelled corner). */
export interface JunctionHub {
  vertexId: string;
  polygon: Vec2[];
}

export interface Footprints {
  walls: Record<string, WallFootprint>;
  hubs: JunctionHub[];
}

/** A miter longer than this many half-thicknesses becomes a bevel, so acute corners don't spike. */
export const MITER_LIMIT = 4;
const PARALLEL_EPS = 1e-6;

interface End {
  wallId: string;
  atA: boolean;
  /** Unit direction pointing away from the junction along the wall. */
  e: Vec2;
  half: number;
  angle: number;
  /** Corner on the +90° side of e (towards the next wall by angle). */
  ccw?: Vec2;
  /** Corner on the -90° side of e (towards the previous wall by angle). */
  cw?: Vec2;
}

const perp = (v: Vec2): Vec2 => ({ x: -v.y, y: v.x });
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const offset = (p: Vec2, dir: Vec2, s: number): Vec2 => ({
  x: p.x + dir.x * s,
  y: p.y + dir.y * s,
});

/** Intersection of p + s·u and q + t·v, or null if (nearly) parallel. */
function intersect(p: Vec2, u: Vec2, q: Vec2, v: Vec2): Vec2 | null {
  const den = cross(u, v);
  if (Math.abs(den) < PARALLEL_EPS) return null;
  const s = cross({ x: q.x - p.x, y: q.y - p.y }, v) / den;
  return offset(p, u, s);
}

/**
 * Computes mitred outlines for every wall. Walls meeting at a shared vertex are sorted by
 * angle; each adjacent pair's facing offset edges are intersected to give a shared corner.
 * Collinear walls and miters beyond MITER_LIMIT get square ends instead, and a hub polygon
 * fills whatever gap remains at the junction.
 */
export function wallFootprints(level: Level): Footprints {
  const ends = new Map<string, End[]>();
  const dirs = new Map<string, Vec2>();

  for (const w of Object.values(level.walls)) {
    const a = level.vertices[w.a];
    const b = level.vertices[w.b];
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    dirs.set(w.id, d);
    const half = w.thickness / 2;
    for (const [vid, e, atA] of [
      [w.a, d, true],
      [w.b, { x: -d.x, y: -d.y }, false],
    ] as const) {
      const list = ends.get(vid) ?? [];
      list.push({ wallId: w.id, atA, e, half, angle: Math.atan2(e.y, e.x) });
      ends.set(vid, list);
    }
  }

  const hubs: JunctionHub[] = [];
  for (const [vid, list] of ends) {
    const v = level.vertices[vid];
    if (!v) continue;
    list.sort((p, q) => p.angle - q.angle);
    const k = list.length;
    if (k === 1) {
      const end = list[0] as End;
      end.ccw = offset(v, perp(end.e), end.half);
      end.cw = offset(v, perp(end.e), -end.half);
      continue;
    }
    for (let i = 0; i < k; i++) {
      const p = list[i] as End;
      const q = list[(i + 1) % k] as End;
      const pSide = offset(v, perp(p.e), p.half);
      const qSide = offset(v, perp(q.e), -q.half);
      const corner = intersect(pSide, p.e, qSide, q.e);
      const limit = MITER_LIMIT * Math.max(p.half, q.half);
      if (corner && Math.hypot(corner.x - v.x, corner.y - v.y) <= limit) {
        p.ccw = corner;
        q.cw = corner;
      } else {
        p.ccw = pSide;
        q.cw = qSide;
      }
    }
    // Whatever the wall ends leave uncovered lies within the hull of the junction point and
    // the end corners (exactly so for T and X junctions; a bevel's hull overlaps the walls,
    // which is harmless). Mitred two-wall corners give a degenerate hull and no hub.
    if (k >= 3 || list.some((end) => !samePoint(end.ccw, nextOf(list, end).cw))) {
      const hull = convexHull([v, ...list.flatMap((end) => [end.cw as Vec2, end.ccw as Vec2])]);
      if (hull.length >= 3 && Math.abs(polygonArea(hull)) > 1e-8) {
        hubs.push({ vertexId: vid, polygon: hull });
      }
    }
  }

  const walls: Record<string, WallFootprint> = {};
  for (const w of Object.values(level.walls)) {
    const endA = ends.get(w.a)?.find((x) => x.wallId === w.id && x.atA);
    const endB = ends.get(w.b)?.find((x) => x.wallId === w.id && !x.atA);
    if (!endA?.ccw || !endA.cw || !endB?.ccw || !endB.cw) continue;
    // At a, e = d so the +90° side is left. At b, e = -d so its +90° side is right.
    walls[w.id] = { wallId: w.id, aL: endA.ccw, aR: endA.cw, bR: endB.ccw, bL: endB.cw };
  }
  return { walls, hubs };
}

const samePoint = (p?: Vec2, q?: Vec2) =>
  !!p && !!q && Math.abs(p.x - q.x) < 1e-9 && Math.abs(p.y - q.y) < 1e-9;
const nextOf = (list: End[], end: End) => list[(list.indexOf(end) + 1) % list.length] as End;

/** Andrew's monotone chain; returns the hull counter-clockwise without repeating a point. */
function convexHull(points: readonly Vec2[]): Vec2[] {
  const pts = [...points].sort((p, q) => p.x - q.x || p.y - q.y);
  if (pts.length < 3) return pts;
  const turn = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (input: Vec2[]) => {
    const out: Vec2[] = [];
    for (const p of input) {
      while (
        out.length >= 2 &&
        turn(out[out.length - 2] as Vec2, out[out.length - 1] as Vec2, p) <= 1e-12
      ) {
        out.pop();
      }
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half(pts.reverse())];
}

function polygonArea(points: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Vec2;
    const q = points[(i + 1) % points.length] as Vec2;
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

/** The footprint as a closed polygon: aL, bL, bR, aR. */
export function footprintPolygon(f: WallFootprint): Vec2[] {
  return [f.aL, f.bL, f.bR, f.aR];
}

/**
 * Where each side of the wall starts and ends, measured along the wall from vertex a.
 * Mitred ends make the two sides different lengths.
 */
export function footprintSpans(
  f: WallFootprint,
  a: Vec2,
  d: Vec2,
): { left: [number, number]; right: [number, number] } {
  const u = (p: Vec2) => (p.x - a.x) * d.x + (p.y - a.y) * d.y;
  return { left: [u(f.aL), u(f.bL)], right: [u(f.aR), u(f.bR)] };
}
