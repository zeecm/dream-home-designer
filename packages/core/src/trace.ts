import { produce } from 'immer';
import { z } from 'zod';
import { drawWall } from './commands';
import { pointInPolygon } from './geometry';
import type { Command } from './history';
import { draftLevel } from './levels';
import { roomShapes } from './rooms';
import type { Level, Opening, Project, Underlay, Vec2 } from './schema';
import { projectOnSegment } from './snap';
import { applyLevel } from './topology';
import { underlayToWorld } from './underlay';

/**
 * Reading a floor plan image (by an AI model, or anything else): what was seen, in the
 * image's own pixels, so the plan's calibration (not a guess of scale) turns it into
 * metres. `readingToPlan` cleans it up as a person tracing would; `tracedLevel` builds it
 * with the same wall-drawing rules as the Wall tool; `importTrace` puts it in, one undo step.
 */
const Px = z.object({ x: z.number(), y: z.number() });
export const PlanReading = z.object({
  walls: z.array(z.object({ a: Px, b: Px, thickness: z.number().positive() })),
  openings: z.array(
    z.object({
      kind: z.enum(['door', 'window', 'passage']),
      a: Px,
      b: Px,
      /** For a door: where its hinge is, and a point on its swing arc (which side it opens). */
      hinge: Px.nullable().optional(),
      arc: Px.nullable().optional(),
    }),
  ),
  rooms: z.array(z.object({ name: z.string(), at: Px })),
  /** The total floor area printed on the plan, in m², if there is one. */
  printedArea: z.number().nullable().optional(),
});
export type PlanReading = z.infer<typeof PlanReading>;

/** The same, in plan metres. */
export interface TracedPlan {
  walls: { a: Vec2; b: Vec2; thickness: number }[];
  openings: { kind: Opening['kind']; a: Vec2; b: Vec2; hinge?: Vec2; arc?: Vec2 }[];
  rooms: { name: string; at: Vec2 }[];
}

/** Walls this close to the plan's axes (radians) are straightened onto them. */
const STRAIGHTEN = (2 * Math.PI) / 180;
/** Wall ends this close together (m) become one corner. */
const MERGE = 0.08;
/** A wall end this close to another wall (m) is taken onto it (a T-junction). */
const ONTO = 0.15;
/** Thicknesses snap to 25 mm (HDB plans have 100, 125, 150, 200, 250 mm walls). */
const snapThickness = (t: number) => Math.max(0.05, Math.round(t / 0.025) * 0.025);
/** Two lines this close (m), side by side, are the faces of one thick wall. */
const FACES = 0.4;
/** Pieces of one wall line with a gap up to this (m) and an opening in it are one wall. */
const DOORWAY = 1.3;

const dist = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y);

/** Which axis a wall runs along, if it runs (within 2°) along one. */
function axisOf(a: Vec2, b: Vec2): 'x' | 'y' | null {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const off = (q: number) => Math.abs(Math.atan2(Math.sin(ang - q), Math.cos(ang - q)));
  if (Math.min(off(0), off(Math.PI)) < STRAIGHTEN) return 'x';
  if (Math.min(off(Math.PI / 2), off(-Math.PI / 2)) < STRAIGHTEN) return 'y';
  return null;
}

type Line = { a: Vec2; b: Vec2; thickness: number };

/**
 * Lines along the same axis that are one wall: the two faces of a thick wall drawn as
 * separate lines (one centre line, as thick as the gap between them), and pieces of a wall
 * broken at its doors and windows (joined through the opening).
 */
function mergeAlongAxes(walls: Line[], openings: { a: Vec2; b: Vec2 }[]): Line[] {
  // A line along an axis as: which axis, where across it, and its span along it.
  type Run = { axis: 'x' | 'y'; at: number; lo: number; hi: number; thickness: number };
  const runs: Run[] = [];
  const others: Line[] = [];
  for (const w of walls) {
    const axis = axisOf(w.a, w.b);
    if (!axis) {
      others.push(w);
      continue;
    }
    const [p, q] = axis === 'x' ? [w.a.x, w.b.x] : [w.a.y, w.b.y];
    runs.push({
      axis,
      at: axis === 'x' ? w.a.y : w.a.x,
      lo: Math.min(p, q),
      hi: Math.max(p, q),
      thickness: w.thickness,
    });
  }
  const overlap = (p: Run, q: Run) => Math.min(p.hi, q.hi) - Math.max(p.lo, q.lo);
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        const p = runs[i];
        const q = runs[j];
        if (!p || !q || p.axis !== q.axis) continue;
        const apart = Math.abs(p.at - q.at);
        const shorter = Math.min(p.hi - p.lo, q.hi - q.lo);
        let into: Run | null = null;
        if (apart > 0.03 && apart < FACES && overlap(p, q) > shorter / 2) {
          // Two faces: the centre line between them, the gap as the thickness.
          into = {
            axis: p.axis,
            at: (p.at + q.at) / 2,
            lo: Math.min(p.lo, q.lo),
            hi: Math.max(p.hi, q.hi),
            thickness: snapThickness(apart),
          };
        } else if (apart <= 0.05) {
          const gap = -overlap(p, q);
          const lo = Math.min(p.hi, q.hi);
          const hi = Math.max(p.lo, q.lo);
          // In the gap, an opening's middle, on this line.
          const bridged =
            gap <= 0.15 ||
            (gap <= DOORWAY &&
              openings.some((o) => {
                const mx = (o.a.x + o.b.x) / 2;
                const my = (o.a.y + o.b.y) / 2;
                const [along, across] = p.axis === 'x' ? [mx, my] : [my, mx];
                return along > lo - 0.05 && along < hi + 0.05 && Math.abs(across - p.at) < 0.3;
              }));
          if (bridged) {
            into = {
              axis: p.axis,
              at: (p.at * (p.hi - p.lo) + q.at * (q.hi - q.lo)) / (p.hi - p.lo + q.hi - q.lo),
              lo: Math.min(p.lo, q.lo),
              hi: Math.max(p.hi, q.hi),
              thickness: Math.max(p.thickness, q.thickness),
            };
          }
        }
        if (into) {
          runs.splice(j, 1);
          runs[i] = into;
          merged = true;
          break outer;
        }
      }
    }
  }
  return [
    ...runs.map((r) =>
      r.axis === 'x'
        ? { a: { x: r.lo, y: r.at }, b: { x: r.hi, y: r.at }, thickness: r.thickness }
        : { a: { x: r.at, y: r.lo }, b: { x: r.at, y: r.hi }, thickness: r.thickness },
    ),
    ...others,
  ];
}

/** Pixels to metres, then cleaned: straight, joined at shared corners, standard thicknesses. */
export function readingToPlan(r: PlanReading, u: Underlay): TracedPlan {
  const m = (p: Vec2) => underlayToWorld(u, p);
  let walls = r.walls.map((w) => ({
    a: m(w.a),
    b: m(w.b),
    thickness: snapThickness(w.thickness * u.scale),
  }));
  const openings = r.openings.map((o) => ({
    kind: o.kind,
    a: m(o.a),
    b: m(o.b),
    ...(o.hinge ? { hinge: m(o.hinge) } : {}),
    ...(o.arc ? { arc: m(o.arc) } : {}),
  }));
  // Straighten what runs almost along an axis: both ends on the same line.
  for (const w of walls) {
    const axis = axisOf(w.a, w.b);
    if (axis === 'x') w.a.y = w.b.y = (w.a.y + w.b.y) / 2;
    if (axis === 'y') w.a.x = w.b.x = (w.a.x + w.b.x) / 2;
  }
  walls = mergeAlongAxes(walls, openings);
  // Ends close together become one corner, where the walls' lines meet.
  const ends = walls.flatMap((w, i) => [
    { i, end: 'a' as const, p: w.a, axis: axisOf(w.a, w.b) },
    { i, end: 'b' as const, p: w.b, axis: axisOf(w.a, w.b) },
  ]);
  const group = ends.map((_, i) => i);
  const root = (i: number): number => {
    let r = i;
    while (group[r] !== r) r = group[r] ?? r;
    return r;
  };
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const p = ends[i];
      const q = ends[j];
      if (p && q && dist(p.p, q.p) < MERGE) group[root(i)] = root(j);
    }
  }
  const clusters = new Map<number, typeof ends>();
  ends.forEach((e, i) => {
    const k = root(i);
    clusters.set(k, [...(clusters.get(k) ?? []), e]);
  });
  for (const c of clusters.values()) {
    if (c.length < 2) continue;
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    // An x from the walls running up and down, a y from those running across.
    const ups = c.filter((e) => e.axis === 'y');
    const across = c.filter((e) => e.axis === 'x');
    const at = {
      x: mean((ups.length ? ups : c).map((e) => e.p.x)),
      y: mean((across.length ? across : c).map((e) => e.p.y)),
    };
    for (const e of c) {
      const w = walls[e.i];
      if (w) w[e.end] = { ...at };
    }
  }
  // A free end just short of (or past) another wall's middle is taken onto it.
  for (const [i, w] of walls.entries()) {
    for (const end of ['a', 'b'] as const) {
      const p = w[end];
      if (walls.some((o, j) => j !== i && (dist(o.a, p) < 1e-6 || dist(o.b, p) < 1e-6))) continue;
      let best: { at: Vec2; d: number } | null = null;
      for (const [j, o] of walls.entries()) {
        if (j === i) continue;
        const pr = projectOnSegment(p, o.a, o.b);
        if (pr.t > 0.02 && pr.t < 0.98 && pr.distance < ONTO && (!best || pr.distance < best.d)) {
          best = { at: pr.point, d: pr.distance };
        }
      }
      if (best) w[end] = best.at;
    }
  }
  walls = walls.filter((w) => dist(w.a, w.b) >= 0.1);
  return {
    walls,
    openings,
    rooms: r.rooms.map((x) => ({ name: x.name.trim(), at: m(x.at) })),
  };
}

/**
 * Which way a door on a wall swings, from where the plan shows its hinge and its arc: the
 * hinge at the end nearer the wall's start is 'left', an arc on the wall's +n side is 'In'.
 */
function swingOf(
  lvl: Level,
  wallId: string,
  t: number,
  o: { hinge?: Vec2; arc?: Vec2 },
): NonNullable<Opening['swing']> {
  const w = lvl.walls[wallId];
  const a = w && lvl.vertices[w.a];
  const b = w && lvl.vertices[w.b];
  if (!a || !b) return 'leftIn';
  const len = dist(a, b) || 1;
  const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const along = (p: Vec2) => (p.x - a.x) * d.x + (p.y - a.y) * d.y;
  const side = (p: Vec2) => -(p.x - a.x) * d.y + (p.y - a.y) * d.x;
  const hinge = o.hinge && along(o.hinge) > t * len ? 'right' : 'left';
  const into = o.arc && side(o.arc) < 0 ? 'Out' : 'In';
  return `${hinge}${into}`;
}

/** Default heights and sills, as the opening tools place them. */
const OPENING_SIZE: Record<Opening['kind'], { height: number; sill: number }> = {
  door: { height: 2.1, sill: 0 },
  window: { height: 1.2, sill: 0.9 },
  passage: { height: 2.1, sill: 0 },
};

/**
 * The level with the traced plan drawn in (on top of what is there, or `replace`d): walls
 * by the Wall tool's own rules (shared corners, T-junctions split, rooms found), each opening
 * on the wall it runs along, rooms named from the labels inside them. Pure; ids are made as
 * it goes, outside any recipe.
 */
export function tracedLevel(
  level: Level,
  plan: TracedPlan,
  newId: (prefix: 'op') => string,
  replace = false,
): { level: Level; skipped: number } {
  let lvl: Level = replace ? { ...level, vertices: {}, walls: {}, openings: {}, rooms: {} } : level;
  let skipped = 0;
  const apply = (cmd: Command) => {
    const doc = { levels: [lvl] } as unknown as Project;
    lvl = produce(doc, (d) => cmd.recipe(d))?.levels[0] ?? lvl;
  };
  for (const w of plan.walls) {
    try {
      apply(drawWall(lvl, { point: w.a }, { point: w.b }, { thickness: w.thickness }).command);
    } catch {
      skipped++; // too short, or along another wall
    }
  }
  // Openings: on the wall they run along (parallel, centred within the wall's thickness).
  const openings: Record<string, Opening> = { ...lvl.openings };
  for (const o of plan.openings) {
    const mid = { x: (o.a.x + o.b.x) / 2, y: (o.a.y + o.b.y) / 2 };
    let best: { wallId: string; t: number; width: number; d: number } | null = null;
    for (const w of Object.values(lvl.walls)) {
      const a = lvl.vertices[w.a];
      const b = lvl.vertices[w.b];
      if (!a || !b || w.kind === 'boundary') continue;
      const len = dist(a, b);
      const pr = projectOnSegment(mid, a, b);
      if (pr.distance > w.thickness / 2 + 0.15 || len < 0.3) continue;
      const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
      const width = Math.abs((o.b.x - o.a.x) * d.x + (o.b.y - o.a.y) * d.y);
      if (width < 0.3 || (best && best.d <= pr.distance)) continue;
      best = { wallId: w.id, t: pr.t, width: Math.min(width, len - 0.05), d: pr.distance };
    }
    if (!best) {
      skipped++;
      continue;
    }
    const id = newId('op');
    const len = (() => {
      const w = lvl.walls[best.wallId];
      const a = w && lvl.vertices[w.a];
      const b = w && lvl.vertices[w.b];
      return a && b ? dist(a, b) : 1;
    })();
    const half = best.width / 2 / len;
    openings[id] = {
      id,
      wallId: best.wallId,
      kind: o.kind,
      t: Math.min(1 - half, Math.max(half, best.t)),
      width: best.width,
      ...OPENING_SIZE[o.kind],
      ...(o.kind === 'door' ? { swing: swingOf(lvl, best.wallId, best.t, o) } : {}),
    };
  }
  lvl = { ...lvl, openings };
  // Rooms named from the labels inside them.
  const shapes = roomShapes(lvl);
  const rooms = { ...lvl.rooms };
  for (const label of plan.rooms) {
    if (!label.name) continue;
    for (const r of Object.values(rooms)) {
      const s = shapes.get(r.id);
      if (
        s &&
        pointInPolygon(label.at, s.outer) &&
        !s.holes.some((h) => pointInPolygon(label.at, h))
      ) {
        rooms[r.id] = { ...r, name: label.name };
      }
    }
  }
  return { level: { ...lvl, rooms }, skipped };
}

/** Puts a traced level's walls, corners, openings and rooms in: one undo step. */
export function importTrace(levelId: string, traced: Level): Command {
  return {
    label: 'Trace walls',
    recipe: (d) => {
      applyLevel(draftLevel(d, levelId), traced);
    },
  };
}
