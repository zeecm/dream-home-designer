import { type Footprints, type WallFootprint, footprintSpans, wallFootprints } from './footprints';
import { type Circle, clampOpeningT, openingsOnWall } from './geometry';
import type { Level, Opening, OpeningKind, Vec2, Wall } from './schema';

/**
 * A wall's local frame: origin at vertex a, unit direction d towards b, left normal n,
 * and where each mitred side starts and ends (u measured along d from a).
 */
export interface WallFrame {
  wall: Wall;
  a: Vec2;
  d: Vec2;
  n: Vec2;
  length: number;
  half: number;
  left: [number, number];
  right: [number, number];
}

export function wallFrame(
  level: Level,
  wall: Wall,
  fp: WallFootprint | undefined,
): WallFrame | null {
  const a = level.vertices[wall.a];
  const b = level.vertices[wall.b];
  if (!a || !b || !fp) return null;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < 1e-9) return null;
  const d = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  const spans = footprintSpans(fp, a, d);
  return {
    wall,
    a: { x: a.x, y: a.y },
    d,
    n: { x: -d.y, y: d.x },
    length,
    half: wall.thickness / 2,
    left: spans.left,
    right: spans.right,
  };
}

/** A point at distance u along the wall, on its left (+1), centre line (0) or right (-1) face. */
export function framePoint(f: WallFrame, u: number, side: number): Vec2 {
  return {
    x: f.a.x + f.d.x * u + f.n.x * f.half * side,
    y: f.a.y + f.d.y * u + f.n.y * f.half * side,
  };
}

/** Where an opening cuts the wall, clamped to the wall's length. */
export function openingSpan(f: WallFrame, o: Opening): [number, number] {
  const c = o.t * f.length;
  return [Math.max(0, c - o.width / 2), Math.min(f.length, c + o.width / 2)];
}

export interface PlanWallPiece {
  wallId: string;
  polygon: Vec2[];
}

export interface PlanOpening {
  opening: Opening;
  wallId: string;
  kind: OpeningKind;
  /** The gap across the wall's full thickness. */
  polygon: Vec2[];
  frame: WallFrame;
  span: [number, number];
}

export interface PlanGeometry {
  footprints: Footprints;
  frames: Record<string, WallFrame>;
  /** Solid wall between openings, mitred at the ends. */
  pieces: PlanWallPiece[];
  openings: PlanOpening[];
}

/**
 * Everything a plan drawing needs: each wall cut into solid pieces around its openings
 * (so doors and windows read as gaps, the way architects draw them), the gaps themselves,
 * and the junction hubs.
 */
export function planGeometry(level: Level, footprints = wallFootprints(level)): PlanGeometry {
  const frames: Record<string, WallFrame> = {};
  const pieces: PlanWallPiece[] = [];
  const openings: PlanOpening[] = [];

  for (const wall of Object.values(level.walls)) {
    const f = wallFrame(level, wall, footprints.walls[wall.id]);
    if (!f) continue;
    frames[wall.id] = f;
    const holes = openingsOnWall(level, wall.id)
      .map((o) => ({ o, span: openingSpan(f, o) }))
      .filter((h) => h.span[1] > h.span[0])
      .sort((p, q) => p.span[0] - q.span[0]);

    let cursor = 0;
    const solid = (s: number, e: number) => {
      if (e - s < 1e-9) return;
      // Same rule as the 3D extrusion: a side whose mitres overshoot collapses to a point,
      // so a very short, thick wall never draws a folded outline.
      const span = (from: number, to: number): [number, number] =>
        to > from ? [from, to] : [(from + to) / 2, (from + to) / 2];
      const [l0, l1] = span(s === 0 ? f.left[0] : s, e === f.length ? f.left[1] : e);
      const [r0, r1] = span(s === 0 ? f.right[0] : s, e === f.length ? f.right[1] : e);
      pieces.push({
        wallId: wall.id,
        polygon: [
          framePoint(f, l0, 1),
          framePoint(f, l1, 1),
          framePoint(f, r1, -1),
          framePoint(f, r0, -1),
        ],
      });
    };
    for (const h of holes) {
      const [u0, u1] = h.span;
      if (u0 > cursor) solid(cursor, u0);
      cursor = Math.max(cursor, u1);
      openings.push({
        opening: h.o,
        wallId: wall.id,
        kind: h.o.kind,
        frame: f,
        span: h.span,
        polygon: [
          framePoint(f, u0, 1),
          framePoint(f, u1, 1),
          framePoint(f, u1, -1),
          framePoint(f, u0, -1),
        ],
      });
    }
    solid(cursor, f.length);
  }
  return { footprints, frames, pieces, openings };
}

export interface DoorSwing {
  hinge: Vec2;
  /** The leaf drawn fully open, perpendicular to the wall. */
  leafEnd: Vec2;
  /** Where the arc meets the far jamb. */
  arcEnd: Vec2;
  radius: number;
  /** SVG arc sweep flag for drawing from leafEnd to arcEnd. */
  sweep: 0 | 1;
}

/**
 * The plan symbol of a door. "left"/"right" put the hinge at the jamb nearer vertex a or b;
 * "In"/"Out" open it to the wall's left (+n) or right (-n) side.
 */
export function doorSwing(f: WallFrame, o: Opening): DoorSwing {
  const swing = o.swing ?? 'leftIn';
  const [u0, u1] = openingSpan(f, o);
  const side = swing.endsWith('In') ? 1 : -1;
  const hingeU = swing.startsWith('left') ? u0 : u1;
  const otherU = swing.startsWith('left') ? u1 : u0;
  const radius = u1 - u0;
  const hinge = framePoint(f, hingeU, side);
  const leafEnd = { x: hinge.x + f.n.x * side * radius, y: hinge.y + f.n.y * side * radius };
  const arcEnd = framePoint(f, otherU, side);
  const v1 = { x: leafEnd.x - hinge.x, y: leafEnd.y - hinge.y };
  const v2 = { x: arcEnd.x - hinge.x, y: arcEnd.y - hinge.y };
  return { hinge, leafEnd, arcEnd, radius, sweep: v1.x * v2.y - v1.y * v2.x > 0 ? 1 : 0 };
}

/** A circle covering the quarter disc a door leaf sweeps, for keeping labels clear of it. */
export function swingZone(s: DoorSwing): Circle {
  return {
    c: { x: (s.leafEnd.x + s.arcEnd.x) / 2, y: (s.leafEnd.y + s.arcEnd.y) / 2 },
    r: s.radius * Math.SQRT1_2,
  };
}

export interface OpeningPlacement {
  wallId: string;
  /** Centre along the wall, clamped so the opening fits. */
  t: number;
  width: number;
  /** +1 if the point is on the wall's left (+n) side, -1 on its right. */
  side: 1 | -1;
  /** True if the point is nearer the wall's start (vertex a). */
  nearA: boolean;
  /** False if the wall is too short for even a narrow opening. */
  fits: boolean;
}

/**
 * Where an opening of `width` would go for a pointer at `p`: on the nearest wall within
 * `tolerance` of its face, centred under the pointer and kept on the wall.
 */
export function placeOpening(
  geom: PlanGeometry,
  p: Vec2,
  width: number,
  tolerance: number,
): OpeningPlacement | null {
  let best: (OpeningPlacement & { d: number }) | null = null;
  for (const f of Object.values(geom.frames)) {
    const b = { x: f.a.x + f.d.x * f.length, y: f.a.y + f.d.y * f.length };
    const dx = b.x - f.a.x;
    const dy = b.y - f.a.y;
    const raw = ((p.x - f.a.x) * dx + (p.y - f.a.y) * dy) / (f.length * f.length);
    const t = Math.min(1, Math.max(0, raw));
    const foot = { x: f.a.x + dx * t, y: f.a.y + dy * t };
    const d = Math.hypot(p.x - foot.x, p.y - foot.y);
    if (d > tolerance + f.half || (best && d >= best.d)) continue;
    const w = Math.min(width, f.length - 0.1);
    best = {
      wallId: f.wall.id,
      t: clampOpeningT(f.length, w, t),
      width: w,
      side: (p.x - foot.x) * f.n.x + (p.y - foot.y) * f.n.y >= 0 ? 1 : -1,
      nearA: t < 0.5,
      fits: w >= 0.4,
      d,
    };
  }
  if (!best) return null;
  const { d: _, ...placement } = best;
  return placement;
}
