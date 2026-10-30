import type { Level, Vec2 } from './schema';

export interface SegmentProjection {
  /** 0 at a, 1 at b, clamped. */
  t: number;
  point: Vec2;
  distance: number;
}

export function projectOnSegment(p: Vec2, a: Vec2, b: Vec2): SegmentProjection {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const raw = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const t = Math.min(1, Math.max(0, raw));
  const point = { x: a.x + dx * t, y: a.y + dy * t };
  return { t, point, distance: Math.hypot(p.x - point.x, p.y - point.y) };
}

/** Where segments p1p2 and q1q2 cross, as fractions along each; null if parallel or apart. */
export function segmentIntersection(
  p1: Vec2,
  p2: Vec2,
  q1: Vec2,
  q2: Vec2,
): { t: number; u: number; point: Vec2 } | null {
  const r = { x: p2.x - p1.x, y: p2.y - p1.y };
  const s = { x: q2.x - q1.x, y: q2.y - q1.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12) return null;
  const qp = { x: q1.x - p1.x, y: q1.y - p1.y };
  const t = (qp.x * s.y - qp.y * s.x) / den;
  const u = (qp.x * r.y - qp.y * r.x) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { t, u, point: { x: p1.x + r.x * t, y: p1.y + r.y * t } };
}

/** Rounds away float noise so snapped coordinates read as typed (0.3, not 0.30000000000000004). */
const q = (n: number) => Math.round(n * 1e6) / 1e6;

export type SnapKind = 'vertex' | 'intersection' | 'wall' | 'angle' | 'grid' | 'free';

export interface SnapResult {
  point: Vec2;
  kind: SnapKind;
  /** Set when the point is an existing corner. */
  vertexId?: string;
  /** Set when the point lies on an existing wall (not at one of its corners). */
  wallId?: string;
  /** For angle snaps: the constrained direction, for drawing a guide. */
  angle?: number;
}

export interface SnapOptions {
  /** Capture distance in metres (the UI passes max(0.15 m, a few pixels)). */
  tolerance: number;
  /** Grid step in metres; 0 turns the grid off. */
  grid?: number;
  /** The previous corner when drawing, which enables angle snapping. */
  from?: Vec2;
  angleStep?: number;
  /** How far off an angle step the pointer may be and still snap to it. */
  angleTolerance?: number;
  excludeVertices?: ReadonlySet<string>;
  excludeWalls?: ReadonlySet<string>;
}

/**
 * Snaps a pointer position for drawing, in priority order: an existing corner, the
 * crossing of an angle guide with a wall, a point on a wall, a 0/45/90° guide from the
 * previous corner (its length on the grid), then the grid.
 */
export function snapPoint(level: Level, p: Vec2, opts: SnapOptions): SnapResult {
  const tol = opts.tolerance;

  let best: { id: string; d: number } | null = null;
  for (const v of Object.values(level.vertices)) {
    if (opts.excludeVertices?.has(v.id)) continue;
    const d = Math.hypot(v.x - p.x, v.y - p.y);
    if (d <= tol && (!best || d < best.d)) best = { id: v.id, d };
  }
  if (best) {
    const v = level.vertices[best.id] as Vec2;
    return { point: { x: v.x, y: v.y }, kind: 'vertex', vertexId: best.id };
  }

  const walls = Object.values(level.walls).filter((w) => !opts.excludeWalls?.has(w.id));
  const ends = (w: (typeof walls)[number]) => {
    const a = level.vertices[w.a];
    const b = level.vertices[w.b];
    return a && b ? ([a, b] as const) : null;
  };

  let angle: number | undefined;
  let ray: { point: Vec2; len: number } | null = null;
  if (opts.from) {
    const step = opts.angleStep ?? Math.PI / 4;
    const raw = Math.atan2(p.y - opts.from.y, p.x - opts.from.x);
    const snapped = Math.round(raw / step) * step;
    const len = Math.hypot(p.x - opts.from.x, p.y - opts.from.y);
    const off = Math.abs(Math.atan2(Math.sin(raw - snapped), Math.cos(raw - snapped)));
    if (len > 1e-9 && off <= (opts.angleTolerance ?? (5 * Math.PI) / 180)) {
      angle = snapped;
      const g = opts.grid ?? 0;
      const l = g > 0 ? Math.max(g, Math.round(len / g) * g) : len;
      ray = {
        len: l,
        point: {
          x: q(opts.from.x + Math.cos(snapped) * l),
          y: q(opts.from.y + Math.sin(snapped) * l),
        },
      };
    }
  }

  // An angle guide that crosses a wall near the pointer satisfies both constraints.
  if (opts.from && angle !== undefined) {
    const far = { x: opts.from.x + Math.cos(angle) * 1e4, y: opts.from.y + Math.sin(angle) * 1e4 };
    let hit: { wallId: string; point: Vec2; d: number } | null = null;
    for (const w of walls) {
      const e = ends(w);
      if (!e) continue;
      const x = segmentIntersection(opts.from, far, e[0], e[1]);
      if (!x || x.t * 1e4 < 1e-6) continue;
      const d = Math.hypot(x.point.x - p.x, x.point.y - p.y);
      if (d <= tol && (!hit || d < hit.d)) hit = { wallId: w.id, point: x.point, d };
    }
    if (hit) {
      return {
        point: { x: q(hit.point.x), y: q(hit.point.y) },
        kind: 'intersection',
        wallId: hit.wallId,
        angle,
      };
    }
  }

  let onWall: { wallId: string; point: Vec2; d: number } | null = null;
  for (const w of walls) {
    const e = ends(w);
    if (!e) continue;
    const pr = projectOnSegment(p, e[0], e[1]);
    if (pr.distance <= tol && pr.t > 0 && pr.t < 1 && (!onWall || pr.distance < onWall.d)) {
      onWall = { wallId: w.id, point: pr.point, d: pr.distance };
    }
  }
  // A point on a wall right next to one of its corners is that corner: no sliver walls.
  if (onWall) {
    const w = level.walls[onWall.wallId];
    for (const id of w ? [w.a, w.b] : []) {
      const v = level.vertices[id];
      if (
        v &&
        !opts.excludeVertices?.has(id) &&
        Math.hypot(v.x - onWall.point.x, v.y - onWall.point.y) <= tol
      ) {
        return { point: { x: v.x, y: v.y }, kind: 'vertex', vertexId: id };
      }
    }
  }
  if (onWall) {
    return {
      point: jambSnap(level, onWall.wallId, onWall.point),
      kind: 'wall',
      wallId: onWall.wallId,
    };
  }

  if (ray) return { point: ray.point, kind: 'angle', angle };

  const g = opts.grid ?? 0;
  if (g > 0) {
    return {
      point: { x: q(Math.round(p.x / g) * g), y: q(Math.round(p.y / g) * g) },
      kind: 'grid',
    };
  }
  return { point: p, kind: 'free' };
}

/**
 * Where a dragged corner should land: an existing corner or wall if one is close,
 * otherwise square to its neighbouring walls (where two right-angle guides cross, both
 * walls stay square), otherwise the grid.
 */
export function snapCorner(
  level: Level,
  vertexId: string,
  p: Vec2,
  opts: { tolerance: number; grid?: number },
): Vec2 {
  const own = new Set(
    Object.values(level.walls)
      .filter((w) => w.a === vertexId || w.b === vertexId)
      .map((w) => w.id),
  );
  const step = opts.grid ?? 0.05;
  const base = {
    tolerance: opts.tolerance,
    grid: step,
    excludeVertices: new Set([vertexId]),
    excludeWalls: own,
  };
  const plain = snapPoint(level, p, base);
  if (plain.kind === 'vertex' || plain.kind === 'wall') return plain.point;
  const guides: { from: Vec2; angle: number }[] = [];
  for (const w of Object.values(level.walls)) {
    if (!own.has(w.id)) continue;
    const other = level.vertices[w.a === vertexId ? w.b : w.a];
    if (!other) continue;
    const s = snapPoint(level, p, { ...base, from: other, grid: 0 });
    if (s.kind === 'angle' && s.angle !== undefined) guides.push({ from: other, angle: s.angle });
  }
  const [g1, g2] = guides;
  if (g1 && g2 && Math.abs(Math.sin(g1.angle - g2.angle)) > 0.1) {
    const d1 = { x: Math.cos(g1.angle), y: Math.sin(g1.angle) };
    const d2 = { x: Math.cos(g2.angle), y: Math.sin(g2.angle) };
    const den = d1.x * d2.y - d1.y * d2.x;
    const t = ((g2.from.x - g1.from.x) * d2.y - (g2.from.y - g1.from.y) * d2.x) / den;
    const x = { x: q(g1.from.x + d1.x * t), y: q(g1.from.y + d1.y * t) };
    if (Math.hypot(x.x - p.x, x.y - p.y) <= opts.tolerance * 2) return x;
  }
  if (g1) {
    const d = { x: Math.cos(g1.angle), y: Math.sin(g1.angle) };
    const t = Math.round(((p.x - g1.from.x) * d.x + (p.y - g1.from.y) * d.y) / step) * step;
    return { x: q(g1.from.x + d.x * t), y: q(g1.from.y + d.y * t) };
  }
  return plain.point;
}

/**
 * Where to add a corner to a wall without moving its doors or windows: its middle, or the
 * nearer jamb of an opening there. Null if every spot near there is in an opening.
 */
export function cornerSpot(level: Level, wallId: string): Vec2 | null {
  const w = level.walls[wallId];
  const a = w && level.vertices[w.a];
  const b = w && level.vertices[w.b];
  if (!a || !b) return null;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const p = jambSnap(level, wallId, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const u = projectOnSegment(p, a, b).t * length;
  const inside = Object.values(level.openings).some(
    (o) =>
      o.wallId === wallId &&
      u > o.t * length - o.width / 2 + 1e-6 &&
      u < o.t * length + o.width / 2 - 1e-6,
  );
  // splitWall makes no corner this close to an end (it uses the end instead): endCapture.
  const margin = Math.max(0.05, w.thickness / 2);
  return inside || u < margin || u > length - margin ? null : p;
}

/**
 * A point on a wall that falls inside a door or window moves to the opening's nearer jamb,
 * so a wall drawn to it meets the wall beside the opening instead of splitting it (which
 * would have to shove the opening aside). Only the point being drawn moves, and the drawing
 * preview shows where it went.
 */
function jambSnap(level: Level, wallId: string, p: Vec2): Vec2 {
  const w = level.walls[wallId];
  const a = w && level.vertices[w.a];
  const b = w && level.vertices[w.b];
  const at = { x: q(p.x), y: q(p.y) };
  if (!a || !b) return at;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < 1e-9) return at;
  const u = projectOnSegment(p, a, b).t * length;
  for (const o of Object.values(level.openings)) {
    if (o.wallId !== wallId) continue;
    const u0 = o.t * length - o.width / 2;
    const u1 = o.t * length + o.width / 2;
    if (u <= u0 + 1e-6 || u >= u1 - 1e-6) continue;
    // The nearer jamb, unless it is the wall's own end; then the other one.
    const jambs = (u - u0 < u1 - u ? [u0, u1] : [u1, u0]).filter(
      (j) => j > 0.05 && j < length - 0.05,
    );
    const j = jambs[0];
    if (j === undefined) return at;
    return { x: q(a.x + ((b.x - a.x) * j) / length), y: q(a.y + ((b.y - a.y) * j) / length) };
  }
  return at;
}
