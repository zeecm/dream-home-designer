import {
  LEDGE_ROOM,
  type PointPatch,
  TRUNK_OFF,
  addPoint,
  pointPosition,
  trunkingPath,
  trunkingStart,
  updatePoint,
} from './electrical';
import { labelPoint, pointInPolygon } from './geometry';
import type { Command } from './history';
import { type PlanGeometry, type WallFrame, framePoint, planGeometry } from './plan';
import { roomShapes } from './rooms';
import { type ElecPoint, type Level, type Vec2, isBoundary, isGlass } from './schema';

/**
 * Aircon trunking as a fitter runs it: straight, along a wall face and close to it (or along
 * the ceiling line), turning at right angles, and out through the outside wall or a window
 * to the compressor on the ledge. A run's path is [beside the unit, ...bends, compressor];
 * the bends are what an aircon unit's `route` stores.
 */

/** Within this of a wall face (metres) a run hugs it, TRUNK_OFF off the face. */
export const TRUNK_SNAP = 0.3;
/** A run's length steps when nothing nearer catches it. */
const STEP = 0.05;
/** Under this a segment is no segment (1 mm). */
const TINY = 1e-3;

const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const along = (p: Vec2, d: Vec2, t: number): Vec2 => ({ x: p.x + d.x * t, y: p.y + d.y * t });

/** A direction made exactly axis-aligned where it nearly is (walls drawn square read square). */
function squared(d: Vec2): Vec2 {
  if (Math.abs(d.x) < 1e-6) return { x: 0, y: d.y < 0 ? -1 : 1 };
  if (Math.abs(d.y) < 1e-6) return { x: d.x < 0 ? -1 : 1, y: 0 };
  const l = Math.hypot(d.x, d.y);
  return { x: d.x / l, y: d.y / l };
}

/** The two directions a run may take: along a wall and square to it. */
export interface TrunkAxes {
  d: Vec2;
  n: Vec2;
}

const axesOf = (d: Vec2): TrunkAxes => {
  const s = squared(d);
  return { d: s, n: { x: -s.y, y: s.x } };
};

/** The axes of the wall nearest `p` (the plan's x and y with no wall). */
export function trunkAxes(
  level: Level,
  p: Vec2,
  geom: PlanGeometry = planGeometry(level),
): TrunkAxes {
  let best: { f: WallFrame; dist: number } | null = null;
  for (const f of Object.values(geom.frames)) {
    if (isBoundary(f.wall)) continue;
    const u = Math.min(f.length, Math.max(0, dot(sub(p, f.a), f.d)));
    const q = along(f.a, f.d, u);
    const dist = Math.hypot(p.x - q.x, p.y - q.y);
    if (!best || dist < best.dist - 1e-9) best = { f, dist };
  }
  return axesOf(best?.f.d ?? { x: 1, y: 0 });
}

/** A wall face as trunking sees it: the line it hugs, TRUNK_OFF out from the face. */
interface Face {
  f: WallFrame;
  /** Out of the face. */
  normal: Vec2;
  /** On the hug line, level with the wall's start (u = 0). */
  origin: Vec2;
  /** The face's extent along the wall (u). */
  lo: number;
  hi: number;
}

/** What a run meets: wall faces, and the solid and open parts of each wall. */
interface Obstacles {
  faces: Face[];
  /** Solid wall (and junction hubs), with the wall each belongs to. */
  solid: { wallId?: string; poly: Vec2[]; box: Box }[];
  /** Doors, windows and passages: gaps through a wall. */
  gaps: { wallId: string; kind: 'door' | 'window' | 'passage'; poly: Vec2[]; box: Box }[];
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const boxOf = (poly: readonly Vec2[]): Box => ({
  x0: Math.min(...poly.map((p) => p.x)),
  y0: Math.min(...poly.map((p) => p.y)),
  x1: Math.max(...poly.map((p) => p.x)),
  y1: Math.max(...poly.map((p) => p.y)),
});

const obstacleCache = new WeakMap<PlanGeometry, Obstacles>();

function obstacles(geom: PlanGeometry): Obstacles {
  const cached = obstacleCache.get(geom);
  if (cached) return cached;
  const faces: Face[] = [];
  for (const f of Object.values(geom.frames)) {
    if (isBoundary(f.wall)) continue;
    for (const side of [1, -1] as const) {
      const [lo, hi] = side > 0 ? f.left : f.right;
      if (hi - lo < 1e-6) continue;
      const normal = { x: f.n.x * side, y: f.n.y * side };
      faces.push({ f, normal, origin: along(framePoint(f, 0, side), normal, TRUNK_OFF), lo, hi });
    }
  }
  const solid: Obstacles['solid'] = [
    ...geom.pieces.map((p) => ({ wallId: p.wallId, poly: p.polygon, box: boxOf(p.polygon) })),
    ...geom.footprints.hubs.map((h) => ({ poly: h.polygon, box: boxOf(h.polygon) })),
  ];
  const gaps = geom.openings.map((o) => ({
    wallId: o.wallId,
    kind: o.kind,
    poly: o.polygon,
    box: boxOf(o.polygon),
  }));
  const out = { faces, solid, gaps };
  obstacleCache.set(geom, out);
  return out;
}

const inBox = (p: Vec2, b: Box) => p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1;
const boxesMeet = (a: Vec2, b: Vec2, box: Box) =>
  Math.max(a.x, b.x) > box.x0 &&
  Math.min(a.x, b.x) < box.x1 &&
  Math.max(a.y, b.y) > box.y0 &&
  Math.min(a.y, b.y) < box.y1;

/** Whether segments ab and cd cross (properly). */
function cross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return d1 * d2 < -1e-12 && d3 * d4 < -1e-12;
}

/** Whether segment ab passes through (or into) a polygon. */
function meets(a: Vec2, b: Vec2, poly: readonly Vec2[], box: Box): boolean {
  if (!boxesMeet(a, b, box)) return false;
  if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) return true;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (pointInPolygon(mid, poly)) return true;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (cross(a, b, poly[i] as Vec2, poly[j] as Vec2)) return true;
  }
  return false;
}

/** Whether a spot is inside a wall's thickness (or a doorway or window in it). */
function inWall(obs: Obstacles, p: Vec2): boolean {
  return (
    obs.solid.some((s) => inBox(p, s.box) && pointInPolygon(p, s.poly)) ||
    obs.gaps.some((g) => inBox(p, g.box) && pointInPolygon(p, g.poly))
  );
}

/** A wall a segment goes through: solid, or by a window, door or passage in it. */
export interface TrunkCrossing {
  wallId: string;
  through: 'solid' | 'window' | 'door' | 'passage';
  /** The segment runs along inside the wall rather than through it. */
  lengthwise: boolean;
}

/** The walls segment ab goes through. */
export function wallsCrossed(
  level: Level,
  a: Vec2,
  b: Vec2,
  geom: PlanGeometry = planGeometry(level),
): TrunkCrossing[] {
  const obs = obstacles(geom);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < TINY) return [];
  const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const hit = new Map<string, TrunkCrossing>();
  const note = (wallId: string, through: TrunkCrossing['through']) => {
    const f = geom.frames[wallId];
    const lengthwise = !!f && Math.abs(dot(f.d, dir)) > 0.7;
    const was = hit.get(wallId);
    // Solid wall anywhere in the crossing makes it a hole drilled.
    if (!was || (through === 'solid' && was.through !== 'solid'))
      hit.set(wallId, { wallId, through, lengthwise: lengthwise || !!was?.lengthwise });
  };
  for (const g of obs.gaps) if (meets(a, b, g.poly, g.box)) note(g.wallId, g.kind);
  for (const s of obs.solid) {
    if (!meets(a, b, s.poly, s.box)) continue;
    if (s.wallId) note(s.wallId, 'solid');
    else note(`hub:${s.box.x0},${s.box.y0}`, 'solid');
  }
  return [...hit.values()];
}

// -------------------------------------------------------------------------- one bend at a time

export interface Bend {
  at: Vec2;
  /** What it lined up with: a wall face (hugging it), the compressor, the 5 cm step, or free. */
  snap: 'wall' | 'target' | 'step' | 'free';
}

export interface BendOptions {
  /** Free: the bend goes where the pointer is, at any angle. */
  alt?: boolean;
  geom?: PlanGeometry;
  /** Where the run will end (its compressor): a bend near level with it lines up with it. */
  target?: Vec2 | null;
  /** How near a face or the target catches the bend (TRUNK_SNAP). */
  snap?: number;
}

/**
 * The bend to add to a run at `from` for the pointer at `cursor`: square to the nearest
 * wall (along it or straight out from it, whichever is nearer the pointer), stopping
 * TRUNK_OFF short of (or past) a wall face it reaches within TRUNK_SNAP, so the next leg
 * hugs that face, or level with the target; else in 5 cm steps. `alt` frees the angle.
 * Null where the bend would be on `from`.
 */
export function nextBend(
  level: Level,
  from: Vec2,
  cursor: Vec2,
  opts: BendOptions = {},
): Bend | null {
  if (opts.alt) {
    return Math.hypot(cursor.x - from.x, cursor.y - from.y) < TINY
      ? null
      : { at: { ...cursor }, snap: 'free' };
  }
  const geom = opts.geom ?? planGeometry(level);
  const { d, n } = trunkAxes(level, from, geom);
  const du = dot(sub(cursor, from), d);
  const dn = dot(sub(cursor, from), n);
  const axis = Math.abs(du) >= Math.abs(dn) ? d : n;
  const s = axis === d ? du : dn;
  if (Math.abs(s) < TINY) return null;
  const tol = opts.snap ?? TRUNK_SNAP;
  let best: { t: number; err: number; snap: Bend['snap'] } | null = null;
  const consider = (t: number, snap: Bend['snap']) => {
    if (Math.sign(t) !== Math.sign(s) || Math.abs(t) < 0.01) return;
    const err = Math.abs(t - s);
    if (err <= tol + 1e-9 && (!best || err < best.err - 1e-9)) best = { t, err, snap };
  };
  for (const face of obstacles(geom).faces) {
    // Only a face across the run: its hug line is where the run would turn along it.
    const k = dot(face.normal, axis);
    if (Math.abs(k) < 0.999) continue;
    const t = dot(sub(face.origin, from), face.normal) / k;
    const u = dot(sub(along(from, axis, t), face.f.a), face.f.d);
    // Past the face's ends by up to TRUNK_OFF: round an outside corner, into an inside one.
    if (u < face.lo - TRUNK_OFF - 1e-6 || u > face.hi + TRUNK_OFF + 1e-6) continue;
    consider(t, 'wall');
  }
  if (opts.target) consider(dot(sub(opts.target, from), axis), 'target');
  const picked = best as { t: number; snap: Bend['snap'] } | null;
  const t = picked ? picked.t : Math.round(s / STEP) * STEP;
  if (Math.abs(t) < TINY) return null;
  return { at: along(from, axis, t), snap: picked?.snap ?? 'step' };
}

/** Whether ab runs along one of the axes (within 1 mm over its length). */
export function squareTo(axes: TrunkAxes, a: Vec2, b: Vec2): boolean {
  const v = sub(b, a);
  return Math.abs(dot(v, axes.d)) < TINY || Math.abs(dot(v, axes.n)) < TINY;
}

/**
 * The corner a run needs from `from` into a fixed end (a compressor) to arrive square: none
 * if it already does, else the corner whose two legs go through fewer walls, preferring
 * the one that carries on the way the run was going (from `prev`).
 */
export function legInto(
  level: Level,
  from: Vec2,
  to: Vec2,
  opts: { geom?: PlanGeometry; prev?: Vec2 } = {},
): Vec2[] {
  const geom = opts.geom ?? planGeometry(level);
  const axes = trunkAxes(level, from, geom);
  if (squareTo(axes, from, to)) return [];
  const v = sub(to, from);
  const corners = [along(from, axes.d, dot(v, axes.d)), along(from, axes.n, dot(v, axes.n))];
  const score = (c: Vec2) => {
    const walls =
      wallsCrossed(level, from, c, geom).length + wallsCrossed(level, c, to, geom).length;
    const prev = opts.prev;
    const turns =
      prev &&
      Math.abs((from.x - prev.x) * (c.y - from.y) - (from.y - prev.y) * (c.x - from.x)) < 1e-6
        ? 0
        : 1;
    return walls * 10 + turns;
  };
  const [c1, c2] = corners as [Vec2, Vec2];
  return [score(c2) < score(c1) ? c2 : c1];
}

/** A path without repeated points or bends that don't turn (the ends kept). */
export function simplifyPath(path: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of path) {
    const last = out.at(-1);
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < TINY) continue;
    out.push({ ...p });
    // The point before this one, if it lies on the line from its neighbours, goes.
    while (out.length >= 3) {
      const a = out[out.length - 3] as Vec2;
      const b = out[out.length - 2] as Vec2;
      const c = out[out.length - 1] as Vec2;
      const l1 = Math.hypot(b.x - a.x, b.y - a.y);
      const l2 = Math.hypot(c.x - b.x, c.y - b.y);
      const crossed = Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x));
      if (crossed > 1e-6 * Math.max(1, l1 * l2) && crossed / Math.max(l1, l2, 1e-9) > 1e-4) break;
      out.splice(out.length - 2, 1);
    }
  }
  return out;
}

/**
 * An existing run made straight: each leg square to the nearest wall and hugging the faces
 * it nears (as nextBend has it, each bend kept as far along as it was), a corner added into
 * a fixed end (`end`: its compressor), and bends that don't turn or go nowhere dropped. The
 * whole path comes back, its first point (and with `end`, its last) where they were.
 */
export function tidyRoute(
  level: Level,
  path: readonly Vec2[],
  opts: { end?: boolean; geom?: PlanGeometry } = {},
): Vec2[] {
  const first = path[0];
  if (!first) return [];
  const geom = opts.geom ?? planGeometry(level);
  const out: Vec2[] = [{ ...first }];
  const last = opts.end && path.length >= 2 ? path[path.length - 1] : undefined;
  const bends = path.slice(1, last ? -1 : undefined);
  for (const q of bends) {
    const from = out[out.length - 1] as Vec2;
    // A leg already square stays as it is; a crooked one is squared (and hugs, as tapped).
    const axes = trunkAxes(level, from, geom);
    if (squareTo(axes, from, q)) {
      // Exactly square: off by under a millimetre, it's put on the line.
      const v = sub(q, from);
      const ax = Math.abs(dot(v, axes.n)) < TINY ? axes.d : axes.n;
      const off = Math.abs(dot(v, ax === axes.d ? axes.n : axes.d));
      out.push(off < 1e-9 ? { ...q } : along(from, ax, dot(v, ax)));
      continue;
    }
    const b = nextBend(level, from, q, { geom, target: last });
    if (b) out.push(b.at);
  }
  if (last) {
    out.push(
      ...legInto(level, out[out.length - 1] as Vec2, last, { geom, prev: out[out.length - 2] }),
      { ...last },
    );
  }
  return simplifyPath(out);
}

/**
 * A run with one end moved (the unit along its wall, or the compressor dragged): the bend
 * next to that end slides with it so the leg stays square, or with no bend to slide, a corner
 * goes in. The other end and the far bends stay.
 */
export function movePathEnd(
  level: Level,
  path: readonly Vec2[],
  which: 'start' | 'end',
  to: Vec2,
  geom: PlanGeometry = planGeometry(level),
): Vec2[] {
  const ordered = which === 'start' ? [...path].reverse() : [...path];
  const end = ordered[ordered.length - 1];
  const next = ordered[ordered.length - 2];
  if (!end || !next) return [...path];
  let out: Vec2[];
  if (ordered.length >= 3) {
    const axes = trunkAxes(level, next, geom);
    const v = sub(end, next);
    const before = ordered.slice(0, -2);
    if (Math.abs(dot(v, axes.n)) < TINY || Math.abs(dot(v, axes.d)) < TINY) {
      // The last leg ran along `ax`: the bend takes the end's new place across it.
      const ax = Math.abs(dot(v, axes.n)) < TINY ? axes.d : axes.n;
      const other = ax === axes.d ? axes.n : axes.d;
      const slid = along(next, other, dot(sub(to, next), other));
      out = [...before, slid, { ...to }];
    } else out = [...before, next, { ...to }];
  } else {
    out = [next, ...legInto(level, next, to, { geom }), { ...to }];
  }
  out = simplifyPath(out);
  return which === 'start' ? out.reverse() : out;
}

/**
 * A bend dragged to `at`: its neighbours slide so the legs either side stay square, except a
 * fixed end (the start, and with `fixedEnd` the compressor), along whose leg the bend slides
 * instead.
 */
export function dragBend(
  level: Level,
  path: readonly Vec2[],
  index: number,
  at: Vec2,
  opts: { fixedEnd?: boolean; geom?: PlanGeometry } = {},
): Vec2[] {
  const p = path[index];
  if (!p || index === 0) return [...path];
  const geom = opts.geom ?? planGeometry(level);
  const axes = trunkAxes(level, p, geom);
  const out = path.map((q) => ({ ...q }));
  const fixed = (j: number) => j === 0 || (!!opts.fixedEnd && j === path.length - 1);
  let to = { ...at };
  const slides: { j: number; across: Vec2 }[] = [];
  for (const j of [index - 1, index + 1]) {
    const q = path[j];
    if (!q) continue;
    const v = sub(q, p);
    const onD = Math.abs(dot(v, axes.n)) < TINY;
    const onN = Math.abs(dot(v, axes.d)) < TINY;
    if (!onD && !onN) continue;
    // The axis the leg runs across: it must stay level with the bend on it.
    const across = onD ? axes.n : axes.d;
    if (fixed(j)) to = along(to, across, dot(sub(q, to), across));
    else slides.push({ j, across });
  }
  out[index] = to;
  for (const { j, across } of slides) {
    const q = out[j] as Vec2;
    out[j] = along(q, across, dot(sub(to, q), across));
  }
  return out;
}

/**
 * A point changed (`patch`) with the trunking that ends on it kept square: a compressor
 * moved takes the last bend of each run into it along, an aircon unit moved along its wall
 * its first bend (movePathEnd). One command, so a drag is one undo step.
 */
export function moveWithTrunking(level: Level, pointId: string, patch: PointPatch): Command {
  const was = level.points[pointId];
  const set = updatePoint(level.id, pointId, patch);
  const follow: { id: string; route: Vec2[] }[] = [];
  if (was && (patch.at || patch.wall)) {
    const now = { ...was, ...patch } as ElecPoint;
    const geom = planGeometry(level);
    if (now.kind === 'compressor' && now.at) {
      for (const u of Object.values(level.points)) {
        if (u.kind !== 'aircon' || u.compressorId !== pointId) continue;
        const path = trunkingPath(level, u);
        if (path.length < 2) continue;
        follow.push({
          id: u.id,
          route: movePathEnd(level, path, 'end', now.at, geom).slice(1, -1),
        });
      }
    } else if (now.kind === 'aircon' && (was.route?.length || was.compressorId)) {
      const path = trunkingPath(level, was);
      const start = trunkingStart({ ...level, points: { ...level.points, [pointId]: now } }, now);
      const end = !!was.compressorId && !!level.points[was.compressorId]?.at;
      if (start && path.length >= 2) {
        const moved = movePathEnd(level, path, 'start', start, geom);
        follow.push({ id: pointId, route: moved.slice(1, end ? -1 : undefined) });
      }
    }
  }
  const updates = follow.map((f) => updatePoint(level.id, f.id, { route: f.route }));
  return {
    label: set.label,
    recipe: (d) => {
      set.recipe(d);
      for (const u of updates) u.recipe(d);
    },
  };
}

/** The route of a unit with its bend `index` dragged to `at` (dragBend, ends fixed). */
export function draggedRoute(level: Level, unit: ElecPoint, index: number, at: Vec2): Vec2[] {
  const path = trunkingPath(level, unit);
  const end = !!unit.compressorId && !!level.points[unit.compressorId]?.at;
  const out = dragBend(level, path, index + 1, at, { fixedEnd: end });
  return out.slice(1, end ? -1 : undefined);
}

// ---------------------------------------------------------------------------- along the walls

function regionAt(level: Level, p: Vec2): string {
  for (const [id, s] of roomShapes(level)) {
    if (pointInPolygon(p, s.outer) && !s.holes.some((h) => pointInPolygon(p, h))) return id;
  }
  return 'outside';
}

/** What going through each kind of wall costs a route, in metres of trunking. */
const THROUGH_COST: Record<TrunkCrossing['through'], number> = {
  window: 0.4,
  solid: 0.8,
  passage: 3,
  door: 3,
};
/** A leg off every face (across the ceiling) costs this much more a metre. */
const OFF_WALL = 0.6;
/** Each turn, in metres. */
const TURN = 0.2;

/**
 * A route along the walls from an aircon unit to a compressor at `compressor`: square to the
 * unit's wall, hugging the faces of the unit's room (TRUNK_OFF off them) and the outside
 * of the flat, through the outside wall or a window, onto the ledge. The cheapest by length,
 * turns, legs off a wall and walls drilled; it never goes into another room (the
 * compressor's aside). Its bends (the unit's `route`), or null with no such route.
 */
export function autoRoute(
  level: Level,
  unit: ElecPoint,
  compressor: Vec2,
  geom: PlanGeometry = planGeometry(level),
): Vec2[] | null {
  const start = trunkingStart(level, unit);
  const pos = pointPosition(level, unit);
  if (!start || !pos?.dir) return null;
  const { d, n } = axesOf(pos.dir);
  const home = regionAt(level, start);
  if (home === 'outside') return null;
  const allowed = new Set([home, 'outside', regionAt(level, compressor)]);
  const obs = obstacles(geom);

  // The lines a route may run on: each face's hug line square to the axes (u = const or
  // v = const, with the stretch it hugs), and through both ends.
  // Keyed to 0.1 mm; each line at the first value given it (the ends', so they lie on theirs).
  const us = new Map<number, [number, number][]>();
  const vs = new Map<number, [number, number][]>();
  const exact = new Map<Map<number, [number, number][]>, Map<number, number>>([
    [us, new Map()],
    [vs, new Map()],
  ]);
  const key = (x: number) => Math.round(x * 1e4) / 1e4;
  const addLine = (m: Map<number, [number, number][]>, c: number, ext?: [number, number]) => {
    const k = key(c);
    const list = m.get(k) ?? [];
    if (ext) list.push(ext);
    m.set(k, list);
    const ex = exact.get(m) as Map<number, number>;
    if (!ex.has(k)) ex.set(k, c);
  };
  const toU = (p: Vec2) => dot(p, d);
  const toV = (p: Vec2) => dot(p, n);
  for (const p of [start, compressor]) {
    addLine(us, toU(p));
    addLine(vs, toV(p));
  }
  for (const face of obs.faces) {
    const a = framePoint(face.f, face.lo - TRUNK_OFF, 0);
    const b = framePoint(face.f, face.hi + TRUNK_OFF, 0);
    if (Math.abs(dot(face.normal, d)) > 0.999) {
      const e = [toV(a), toV(b)].sort((x, y) => x - y) as [number, number];
      addLine(us, toU(face.origin), e);
    } else if (Math.abs(dot(face.normal, n)) > 0.999) {
      const e = [toU(a), toU(b)].sort((x, y) => x - y) as [number, number];
      addLine(vs, toV(face.origin), e);
    }
  }
  const U = [...us.keys()].sort((a, b) => a - b);
  const V = [...vs.keys()].sort((a, b) => a - b);
  const exU = exact.get(us) as Map<number, number>;
  const exV = exact.get(vs) as Map<number, number>;
  const at = (i: number, j: number): Vec2 => {
    const u = exU.get(U[i] as number) as number;
    const v = exV.get(V[j] as number) as number;
    return { x: d.x * u + n.x * v, y: d.y * u + n.y * v };
  };
  const NU = U.length;
  const NV = V.length;
  // Each crossing: in a wall, somewhere it may go, or somewhere it may not.
  const WALL = -1;
  const NO = -2;
  const state = new Int8Array(NU * NV);
  for (let i = 0; i < NU; i++)
    for (let j = 0; j < NV; j++) {
      const p = at(i, j);
      state[i * NV + j] = inWall(obs, p) ? WALL : allowed.has(regionAt(level, p)) ? 1 : NO;
    }
  const startNode = U.indexOf(key(toU(start))) * NV + V.indexOf(key(toV(start)));
  const endNode = U.indexOf(key(toU(compressor))) * NV + V.indexOf(key(toV(compressor)));
  if (state[startNode] !== 1 || state[endNode] !== 1) return null;

  const hugs = (ext: [number, number][] | undefined, c: number) =>
    !!ext?.some(([lo, hi]) => c >= lo - 1e-6 && c <= hi + 1e-6);
  // The four ways out of a crossing: +u, -u, +v, -v.
  const edgeCache = new Map<number, { to: number; cost: number } | null>();
  const edge = (node: number, dir: number): { to: number; cost: number } | null => {
    const ck = node * 4 + dir;
    if (edgeCache.has(ck)) return edgeCache.get(ck) ?? null;
    const i0 = Math.floor(node / NV);
    const j0 = node % NV;
    const di = dir === 0 ? 1 : dir === 1 ? -1 : 0;
    const dj = dir === 2 ? 1 : dir === 3 ? -1 : 0;
    let i = i0 + di;
    let j = j0 + dj;
    let found: { to: number; cost: number } | null = null;
    // Across a wall's thickness to the first crossing clear of it.
    while (i >= 0 && i < NU && j >= 0 && j < NV) {
      const s = state[i * NV + j];
      if (s === NO) break;
      if (s === 1) {
        const a = at(i0, j0);
        const b = at(i, j);
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const walls = wallsCrossed(level, a, b, geom);
        if (walls.some((w) => w.lengthwise)) break;
        const hug =
          di !== 0
            ? hugs(vs.get(V[j0] as number), ((U[i0] as number) + (U[i] as number)) / 2)
            : hugs(us.get(U[i0] as number), ((V[j0] as number) + (V[j] as number)) / 2);
        let cost = len * (hug ? 1 : 1 + OFF_WALL);
        for (const w of walls) {
          const glass = !w.wallId.startsWith('hub:') && isGlass(level.walls[w.wallId] ?? {});
          cost += glass ? 5 : THROUGH_COST[w.through];
        }
        found = { to: i * NV + j, cost };
        break;
      }
      i += di;
      j += dj;
    }
    edgeCache.set(ck, found);
    return found;
  };

  // Dijkstra over (crossing, way in): a turn costs TURN.
  const N = NU * NV * 5;
  const dist = new Float64Array(N).fill(Number.POSITIVE_INFINITY);
  const prev = new Int32Array(N).fill(-1);
  const heap: [number, number][] = [];
  const push = (cost: number, s: number) => {
    heap.push([cost, s]);
    let k = heap.length - 1;
    while (k > 0) {
      const up = (k - 1) >> 1;
      if ((heap[up] as [number, number])[0] <= cost) break;
      [heap[k], heap[up]] = [heap[up] as [number, number], heap[k] as [number, number]];
      k = up;
    }
  };
  const pop = (): [number, number] | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (!top || !last || heap.length === 0) return top;
    heap[0] = last;
    let k = 0;
    for (;;) {
      const l = 2 * k + 1;
      const r = l + 1;
      let m = k;
      if (l < heap.length && (heap[l] as [number, number])[0] < (heap[m] as [number, number])[0])
        m = l;
      if (r < heap.length && (heap[r] as [number, number])[0] < (heap[m] as [number, number])[0])
        m = r;
      if (m === k) break;
      [heap[k], heap[m]] = [heap[m] as [number, number], heap[k] as [number, number]];
      k = m;
    }
    return top;
  };
  // State s = node * 5 + way in (4: none, at the start).
  const s0 = startNode * 5 + 4;
  dist[s0] = 0;
  push(0, s0);
  let goal = -1;
  for (let top = pop(); top; top = pop()) {
    const [cost, s] = top;
    if (cost > (dist[s] as number) + 1e-12) continue;
    const node = Math.floor(s / 5);
    const way = s % 5;
    if (node === endNode) {
      goal = s;
      break;
    }
    for (let dir = 0; dir < 4; dir++) {
      // Never straight back.
      if (way !== 4 && (dir ^ 1) === way) continue;
      const e = edge(node, dir);
      if (!e) continue;
      const c = cost + e.cost + (way !== 4 && dir !== way ? TURN : 0);
      const t = e.to * 5 + dir;
      if (c < (dist[t] as number) - 1e-12) {
        dist[t] = c;
        prev[t] = s;
        push(c, t);
      }
    }
  }
  if (goal < 0) return null;
  const nodes: number[] = [];
  for (let s = goal; s >= 0; s = prev[s] as number) nodes.push(Math.floor(s / 5));
  nodes.reverse();
  const path = nodes.map((k) => at(Math.floor(k / NV), k % NV));
  path[0] = { ...start };
  path[path.length - 1] = { ...compressor };
  return simplifyPath(path).slice(1, -1);
}

/** Where a run along the walls ends: the unit's compressor, the nearest one, or a new one. */
function compressorFor(level: Level, unit: ElecPoint): { at: Vec2; id?: string } | null {
  const own = unit.compressorId ? level.points[unit.compressorId] : undefined;
  if (own?.at) return { at: own.at, id: own.id };
  const from = pointPosition(level, unit)?.at;
  if (!from) return null;
  const dist = (p: Vec2) => Math.hypot(p.x - from.x, p.y - from.y);
  const near = Object.values(level.points)
    .filter((q): q is ElecPoint & { at: Vec2 } => q.kind === 'compressor' && !!q.at)
    .sort((p, q) => dist(p.at) - dist(q.at))[0];
  if (near) return { at: near.at, id: near.id };
  // A new one in the middle of the nearest ledge.
  const ledges: Vec2[] = [];
  for (const [id, shape] of roomShapes(level)) {
    if (LEDGE_ROOM.test(level.rooms[id]?.name ?? '')) ledges.push(labelPoint(shape.outer));
  }
  const spot = ledges.sort((p, q) => dist(p) - dist(q))[0];
  return spot ? { at: spot } : null;
}

/**
 * Routes an aircon unit's trunking along the walls to its compressor (the nearest one, or
 * a new one on the ledge), in one undo step. Null where there's no compressor or ledge to
 * go to or no clean route there: the bends are then tapped by hand.
 */
export function routeAlongWalls(
  level: Level,
  unitId: string,
): { command: Command; compressorId: string } | null {
  const unit = level.points[unitId];
  if (unit?.kind !== 'aircon') return null;
  const comp = compressorFor(level, unit);
  if (!comp) return null;
  const route = autoRoute(level, unit, comp.at);
  if (!route) return null;
  const added = comp.id ? null : addPoint(level.id, { kind: 'compressor', at: comp.at });
  const compressorId = comp.id ?? (added?.pointId as string);
  const set = updatePoint(level.id, unitId, { route, compressorId });
  return {
    compressorId,
    command: {
      label: 'Route the trunking along the walls',
      recipe: (d) => {
        added?.command.recipe(d);
        set.recipe(d);
      },
    },
  };
}

/** The run of an aircon unit straightened (tidyRoute), as its new bends; null if no change. */
export function straightenedRoute(
  level: Level,
  unit: ElecPoint,
  path: readonly Vec2[],
): Vec2[] | null {
  if (path.length < 2) return null;
  const end = !!unit.compressorId && !!level.points[unit.compressorId]?.at;
  const tidy = tidyRoute(level, path, { end });
  const route = tidy.slice(1, end ? -1 : undefined);
  const was = unit.route ?? [];
  const same =
    route.length === was.length &&
    route.every((q, i) => {
      const w = was[i];
      return !!w && Math.hypot(q.x - w.x, q.y - w.y) < 1e-6;
    });
  return same ? null : route;
}
