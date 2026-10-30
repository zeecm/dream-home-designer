import { type Footprints, type WallFootprint, footprintSpans, wallFootprints } from './footprints';
import { openingsOnWall } from './geometry';
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
      const l0 = s === 0 ? f.left[0] : s;
      const l1 = e === f.length ? f.left[1] : e;
      const r0 = s === 0 ? f.right[0] : s;
      const r1 = e === f.length ? f.right[1] : e;
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
