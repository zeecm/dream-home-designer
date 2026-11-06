import { type Draft, current, original } from 'immer';
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
import { type RoomShape, roomShapes } from './rooms';
import { type ElecPoint, type Level, type Vec2, isBoundary, isGlass } from './schema';
import { SHELTER_ROOM, wallStatus } from './structural';

/**
 * Aircon trunking as a fitter runs it: straight, along a wall face and close to it (along
 * the ceiling line), turning square, and inside the flat to the wall that borders the aircon
 * ledge, through it to the compressor. HDB allows no exposed piping on the façade outside
 * the ledge. A run's path is [beside the unit, ...bends, compressor]; the bends are what an
 * aircon unit's `route` stores.
 */

/** Within this of a wall face (metres) a run hugs it, TRUNK_OFF off the face. */
export const TRUNK_SNAP = 0.3;
/** A run's length steps when nothing nearer catches it. */
const STEP = 0.05;
/** Under this a segment is no segment (1 mm). */
const TINY = 1e-3;

/** What "Route along the walls" says when there's no route inside the flat to the ledge. */
export const NO_INSIDE_ROUTE =
  'No inside route to the ledge: draw it by hand or ask your installer.';
/** What it says with no compressor and no aircon ledge to run to. */
export const NO_LEDGE = 'No compressor or aircon ledge to run to: add a compressor first.';

const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const crossOf = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const along = (p: Vec2, d: Vec2, t: number): Vec2 => ({ x: p.x + d.x * t, y: p.y + d.y * t });
const unit = (v: Vec2): Vec2 | null => {
  const l = Math.hypot(v.x, v.y);
  return l < 1e-12 ? null : { x: v.x / l, y: v.y / l };
};

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

/** The axes along `d` and square to it. */
export const axesOf = (d: Vec2): TrunkAxes => {
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

/** The axes of an aircon unit's wall (null off a wall). */
export function unitAxes(level: Level, unitPoint: ElecPoint): TrunkAxes | null {
  const dir = pointPosition(level, unitPoint)?.dir;
  return dir ? axesOf(dir) : null;
}

/** The axes of the leg from a to b (null for no leg). */
const legAxes = (a: Vec2 | undefined, b: Vec2 | undefined): TrunkAxes | null => {
  const u = a && b ? unit(sub(b, a)) : null;
  return u ? axesOf(u) : null;
};

/** Whether ab runs along one of the axes (within 1 mm over its length). */
export function squareTo(axes: TrunkAxes, a: Vec2, b: Vec2): boolean {
  const v = sub(b, a);
  return Math.abs(dot(v, axes.d)) < TINY || Math.abs(dot(v, axes.n)) < TINY;
}

// ------------------------------------------------------------------------- what a run meets

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
const inBox = (p: Vec2, b: Box) => p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1;
const boxesMeet = (a: Vec2, b: Vec2, box: Box) =>
  Math.max(a.x, b.x) > box.x0 &&
  Math.min(a.x, b.x) < box.x1 &&
  Math.max(a.y, b.y) > box.y0 &&
  Math.min(a.y, b.y) < box.y1;

/** Things on the plan bucketed by 1 m cells, to find those near a spot or a leg quickly. */
class Buckets<T extends { box: Box }> {
  private cells = new Map<string, T[]>();
  constructor(items: readonly T[]) {
    for (const it of items) {
      for (let ix = Math.floor(it.box.x0); ix <= Math.floor(it.box.x1); ix++)
        for (let iy = Math.floor(it.box.y0); iy <= Math.floor(it.box.y1); iy++) {
          const k = `${ix},${iy}`;
          const list = this.cells.get(k);
          if (list) list.push(it);
          else this.cells.set(k, [it]);
        }
    }
  }
  at(p: Vec2): readonly T[] {
    return this.cells.get(`${Math.floor(p.x)},${Math.floor(p.y)}`) ?? [];
  }
  near(a: Vec2, b: Vec2): Set<T> {
    const out = new Set<T>();
    for (let ix = Math.floor(Math.min(a.x, b.x)); ix <= Math.floor(Math.max(a.x, b.x)); ix++)
      for (let iy = Math.floor(Math.min(a.y, b.y)); iy <= Math.floor(Math.max(a.y, b.y)); iy++)
        for (const it of this.cells.get(`${ix},${iy}`) ?? []) out.add(it);
    return out;
  }
}

/** A wall face as trunking sees it: the line it hugs, TRUNK_OFF out from the face. */
interface Face {
  f: WallFrame;
  /** Out of the face. */
  normal: Vec2;
  /** On the face itself, level with the wall's start (u = 0). */
  base: Vec2;
  /** On the hug line, level with the wall's start. */
  origin: Vec2;
  /** The face's extent along the wall (u). */
  lo: number;
  hi: number;
}

/** A solid piece of wall (or a junction hub), or a door, window or passage through one. */
interface Part {
  wallId?: string;
  through: 'solid' | 'door' | 'window' | 'passage';
  poly: Vec2[];
  box: Box;
}

/** What a run meets: wall faces, and the solid and open parts of each wall. */
interface Obstacles {
  faces: Face[];
  parts: Buckets<Part>;
}

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
      const base = framePoint(f, 0, side);
      faces.push({ f, normal, base, origin: along(base, normal, TRUNK_OFF), lo, hi });
    }
  }
  const parts: Part[] = [
    ...geom.pieces.map((p) => ({
      wallId: p.wallId,
      through: 'solid' as const,
      poly: p.polygon,
      box: boxOf(p.polygon),
    })),
    ...geom.footprints.hubs.map((h) => ({
      through: 'solid' as const,
      poly: h.polygon,
      box: boxOf(h.polygon),
    })),
    ...geom.openings.map((o) => ({
      wallId: o.wallId,
      through: o.kind,
      poly: o.polygon,
      box: boxOf(o.polygon),
    })),
  ];
  const out = { faces, parts: new Buckets(parts) };
  obstacleCache.set(geom, out);
  return out;
}

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
  return obs.parts.at(p).some((s) => inBox(p, s.box) && pointInPolygon(p, s.poly));
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
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < TINY) return [];
  const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const hit = new Map<string, TrunkCrossing>();
  for (const s of obstacles(geom).parts.near(a, b)) {
    if (!meets(a, b, s.poly, s.box)) continue;
    const wallId = s.wallId ?? `hub:${s.box.x0},${s.box.y0}`;
    const f = s.wallId ? geom.frames[s.wallId] : undefined;
    const lengthwise = !!f && Math.abs(dot(f.d, dir)) > 0.7;
    const was = hit.get(wallId);
    // Solid wall anywhere in the crossing makes it a hole drilled.
    if (!was || (s.through === 'solid' && was.through !== 'solid'))
      hit.set(wallId, { wallId, through: s.through, lengthwise: lengthwise || !!was?.lengthwise });
  }
  return [...hit.values()];
}

// ------------------------------------------------------------------------------------ rooms

interface RoomEntry {
  id: string;
  shape: RoomShape;
  box: Box;
}
const roomIndex = new WeakMap<Map<string, RoomShape>, Buckets<RoomEntry>>();

function roomsOf(shapes: Map<string, RoomShape>): Buckets<RoomEntry> {
  const cached = roomIndex.get(shapes);
  if (cached) return cached;
  const out = new Buckets(
    [...shapes].map(([id, shape]) => ({ id, shape, box: boxOf(shape.outer) })),
  );
  roomIndex.set(shapes, out);
  return out;
}

/** The room a spot is in, or 'outside'. */
function regionAt(rooms: Buckets<RoomEntry>, p: Vec2): string {
  for (const r of rooms.at(p)) {
    if (!inBox(p, r.box)) continue;
    const s = r.shape;
    if (pointInPolygon(p, s.outer) && !s.holes.some((h) => pointInPolygon(p, h))) return r.id;
  }
  return 'outside';
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
  /**
   * Other axes the leg may run on besides the nearest wall's: the unit's, and the run's last
   * leg's. The one nearest the pointer's way wins.
   */
  axes?: readonly (TrunkAxes | null | undefined)[];
}

/**
 * The bend to add to a run at `from` for the pointer at `cursor`: square to the unit's wall,
 * the last leg or the nearest wall (whichever way is nearest the pointer's), stopping
 * TRUNK_OFF short of (or past) a wall face it reaches within TRUNK_SNAP, so the next leg
 * hugs that face, or level with the target; else in 5 cm steps. It never goes through a wall
 * the pointer isn't past: it stops TRUNK_OFF short of the first face in the way, whatever
 * its angle. `alt` frees the angle. Null where the bend would be on `from`.
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
  const v = sub(cursor, from);
  let axis: Vec2 = { x: 1, y: 0 };
  let s = 0;
  for (const set of [...(opts.axes ?? []), trunkAxes(level, from, geom)]) {
    if (!set) continue;
    for (const a of [set.d, set.n]) {
      const c = dot(v, a);
      if (Math.abs(c) > Math.abs(s) + 1e-9) {
        axis = c < 0 ? { x: -a.x, y: -a.y } : a;
        s = Math.abs(c);
      }
    }
  }
  if (s < TINY) return null;
  const tol = opts.snap ?? TRUNK_SNAP;
  const obs = obstacles(geom);
  let best: { t: number; err: number; snap: Bend['snap'] } | null = null;
  const consider = (t: number, snap: Bend['snap']) => {
    if (t < 0.01) return;
    const err = Math.abs(t - s);
    if (err <= tol + 1e-9 && (!best || err < best.err - 1e-9)) best = { t, err, snap };
  };
  for (const face of obs.faces) {
    // A face across the run: its hug line is where the run would turn along it.
    const k = dot(face.normal, axis);
    if (Math.abs(k) < 0.05) continue;
    const t = dot(sub(face.origin, from), face.normal) / k;
    const u = dot(sub(along(from, axis, t), face.f.a), face.f.d);
    // Past the face's ends by up to TRUNK_OFF: round an outside corner, into an inside one.
    if (u < face.lo - TRUNK_OFF - 1e-6 || u > face.hi + TRUNK_OFF + 1e-6) continue;
    consider(t, 'wall');
  }
  if (opts.target) consider(dot(sub(opts.target, from), axis), 'target');
  const picked = best as { t: number; snap: Bend['snap'] } | null;
  const want = picked ? picked.t : Math.round(s / STEP) * STEP;
  // Stopped short of the first face in the way, unless the pointer is past its wall too.
  const t = stopShort(level, geom, from, axis, want, cursor);
  if (t < TINY) return null;
  return { at: along(from, axis, t), snap: t < want - 1e-9 ? 'wall' : (picked?.snap ?? 'step') };
}

/**
 * How far a leg from `from` along `axis` may go towards `t`: TRUNK_OFF short of the first
 * wall face in its way (whatever that face's angle), unless the leg to `meant` goes through
 * that wall too (a wall crossed on purpose).
 */
function stopShort(
  level: Level,
  geom: PlanGeometry,
  from: Vec2,
  axis: Vec2,
  t: number,
  meant: Vec2,
): number {
  const through = new Set(wallsCrossed(level, from, meant, geom).map((w) => w.wallId));
  let out = t;
  for (const face of obstacles(geom).faces) {
    if (through.has(face.f.wall.id)) continue;
    const k = dot(face.normal, axis);
    // Only a face looking back at the run (the near face of a wall ahead).
    if (k > -0.05) continue;
    const tFace = dot(sub(face.base, from), face.normal) / k;
    const tHug = dot(sub(face.origin, from), face.normal) / k;
    if (tFace < -1e-9 || out <= tHug + 1e-9) continue;
    const u = dot(sub(along(from, axis, tFace), face.f.a), face.f.d);
    if (u < face.lo - 1e-6 || u > face.hi + 1e-6) continue;
    out = tHug;
  }
  return out;
}

/**
 * The corner a run needs from `from` into a fixed end (a compressor) to arrive square: none
 * if it already does (to the last leg, the unit's wall or the nearest wall), else the corner
 * whose two legs go through fewer walls, preferring the one that carries on the way the run
 * was going (from `prev`), then square to the last leg, the unit, the nearest wall.
 */
export function legInto(
  level: Level,
  from: Vec2,
  to: Vec2,
  opts: {
    geom?: PlanGeometry;
    prev?: Vec2;
    axes?: TrunkAxes | null;
    /** Route the way in along the walls, inside the flat (wallRoute), where it can. */
    alongWalls?: boolean;
    /** The unit whose run this is: other runs are joined, not this one. */
    except?: string;
  } = {},
): Vec2[] {
  const geom = opts.geom ?? planGeometry(level);
  // Square to the unit's wall or the nearest wall: never to a last leg run at a free angle
  // (an Alt bend), which would carry the way in on at that angle. `from` itself never moves:
  // the corner goes after it.
  const sets = [opts.axes, trunkAxes(level, from, geom)].filter((a): a is TrunkAxes => !!a);
  const way = opts.prev ? unit(sub(from, opts.prev)) : null;
  if (opts.alongWalls) {
    const axes = opts.axes ?? trunkAxes(level, to, geom);
    const routed = wallRoute(level, from, to, axes, { geom, way, except: opts.except });
    if (routed) return routed;
  }
  if (sets.some((a) => squareTo(a, from, to))) return [];
  const v = sub(to, from);
  let best: { c: Vec2; score: number } | null = null;
  sets.forEach((a, i) => {
    for (const c of [along(from, a.d, dot(v, a.d)), along(from, a.n, dot(v, a.n))]) {
      const walls =
        wallsCrossed(level, from, c, geom).length + wallsCrossed(level, c, to, geom).length;
      const out = unit(sub(c, from));
      // Carrying straight on is best; doubling back over the last leg, worst.
      const turn = !way || !out ? 1 : dot(way, out) > 0.999 ? 0 : dot(way, out) < -0.999 ? 5 : 1;
      const score = walls * 10 + turn + i * 0.1;
      if (!best || score < best.score - 1e-9) best = { c, score };
    }
  });
  const picked = best as { c: Vec2 } | null;
  return picked ? [picked.c] : [];
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

/** How far Straighten slides a leg across to bring it onto a wall face (metres). */
const SLIDE = 1.5;

/**
 * An existing run made straight. A leg square to the last leg, the unit's wall (`axes`) or
 * the nearest wall stays as it is; a crooked one is squared to whichever of those is nearest
 * its way, its bend kept as far along as it was (so no jog follows), never through a wall it
 * didn't go through. Then each leg between two bends that runs off the walls slides across
 * onto the nearest face it can (up to SLIDE), its neighbours lengthening, so the run goes via
 * the walls; the way into a fixed end (`end`: its compressor) is routed along the walls
 * (legInto); bends that don't turn or go nowhere are dropped. The whole path comes back, its
 * first point (and with `end`, its last) where they were.
 */
export function tidyRoute(
  level: Level,
  path: readonly Vec2[],
  opts: { end?: boolean; geom?: PlanGeometry; axes?: TrunkAxes | null; except?: string } = {},
): Vec2[] {
  const first = path[0];
  if (!first) return [];
  const geom = opts.geom ?? planGeometry(level);
  let out: Vec2[] = [{ ...first }];
  const last = opts.end && path.length >= 2 ? path[path.length - 1] : undefined;
  const bends = path.slice(1, last ? -1 : undefined);
  for (const q of bends) {
    const from = out[out.length - 1] as Vec2;
    const sets = [legAxes(out[out.length - 2], from), opts.axes, trunkAxes(level, from, geom)];
    const v = sub(q, from);
    const square = sets.find((a): a is TrunkAxes => !!a && squareTo(a, from, q));
    if (square) {
      // Exactly square: off by under a millimetre, it's put on the line.
      const ax = Math.abs(dot(v, square.n)) < TINY ? square.d : square.n;
      const off = Math.abs(crossOf(ax, v));
      out.push(off < 1e-9 ? { ...q } : along(from, ax, dot(v, ax)));
      continue;
    }
    // Squared to the axis nearest its way, as far along it as the bend was.
    let axis: Vec2 | null = null;
    let s = 0;
    for (const set of sets) {
      if (!set) continue;
      for (const a of [set.d, set.n]) {
        const c = dot(v, a);
        if (Math.abs(c) > Math.abs(s) + 1e-9) {
          axis = c < 0 ? { x: -a.x, y: -a.y } : a;
          s = Math.abs(c);
        }
      }
    }
    if (!axis) continue;
    const t = stopShort(level, geom, from, axis, s, q);
    if (t >= TINY) out.push(along(from, axis, t));
  }
  out = hugLegs(level, removeJogs(level, simplifyPath(out), geom), geom);
  if (last) {
    out.push(
      ...legInto(level, out[out.length - 1] as Vec2, last, {
        geom,
        prev: out[out.length - 2],
        axes: opts.axes,
        alongWalls: true,
        except: opts.except,
      }),
      { ...last },
    );
  }
  return simplifyPath(out);
}

/**
 * Each leg between two bends (both free to move, the first point fixed) that runs off every
 * wall face slid across onto the nearest face parallel to it, up to SLIDE away, where its
 * neighbours (square to it) only lengthen and none of the three legs goes through a wall it
 * didn't already.
 */
function hugLegs(level: Level, pts: Vec2[], geom: PlanGeometry): Vec2[] {
  const out = pts.map((p) => ({ ...p }));
  const faces = obstacles(geom).faces;
  const crossed = (a: Vec2 | undefined, b: Vec2 | undefined) =>
    a && b ? new Set(wallsCrossed(level, a, b, geom).map((w) => w.wallId)) : new Set<string>();
  const within = (now: Set<string>, was: Set<string>) => [...now].every((w) => was.has(w));
  for (let i = 1; i + 1 < out.length; i++) {
    const a = out[i] as Vec2;
    const b = out[i + 1] as Vec2;
    const e = unit(sub(b, a));
    if (!e) continue;
    const before = out[i - 1] as Vec2;
    const after = out[i + 2];
    const squareBy = (p: Vec2 | undefined, q: Vec2) => {
      const u = p ? unit(sub(q, p)) : null;
      return !p || !u || Math.abs(dot(u, e)) < 1e-6;
    };
    if (!squareBy(before, a) || !squareBy(after, b)) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const options: Vec2[] = [];
    let hugging = false;
    for (const face of faces) {
      if (Math.abs(dot(face.normal, e)) > 1e-6) continue;
      const ua = dot(sub(a, face.f.a), face.f.d);
      const ub = dot(sub(b, face.f.a), face.f.d);
      const lo = Math.max(Math.min(ua, ub), face.lo - TRUNK_OFF);
      const hi = Math.min(Math.max(ua, ub), face.hi + TRUNK_OFF);
      // Alongside it for at least half the leg.
      if (hi - lo < Math.min(len, 0.3) * 0.5) continue;
      const delta = dot(sub(face.origin, a), face.normal);
      if (Math.abs(delta) < 1e-6) {
        hugging = true;
        break;
      }
      // The shift onto its hug line, along the face's normal.
      if (Math.abs(delta) <= SLIDE) options.push(along({ x: 0, y: 0 }, face.normal, delta));
    }
    if (hugging) continue;
    const was = [crossed(before, a), crossed(a, b), crossed(b, after)];
    for (const step of options.sort((p, q) => Math.hypot(p.x, p.y) - Math.hypot(q.x, q.y))) {
      const a2 = { x: a.x + step.x, y: a.y + step.y };
      const b2 = { x: b.x + step.x, y: b.y + step.y };
      const now = [crossed(before, a2), crossed(a2, b2), crossed(b2, after)];
      if (now.every((n, k) => within(n, was[k] as Set<string>))) {
        out[i] = a2;
        out[i + 1] = b2;
        break;
      }
    }
  }
  return out;
}

/** A leg shorter than this between two that run on the same way is a jog, to take out. */
export const JOG = 0.15;

/**
 * Jogs taken out: where a leg under JOG joins two legs running the same way, the leg after
 * it moves across onto the line of the one before (or, that leg being the first, from the
 * unit, the one before onto the one after's), where that goes through no wall the legs
 * didn't already. The first point stays put.
 */
function removeJogs(level: Level, pts: Vec2[], geom: PlanGeometry): Vec2[] {
  let out = pts.map((p) => ({ ...p }));
  const crossed = (a: Vec2 | undefined, b: Vec2 | undefined) =>
    a && b ? new Set(wallsCrossed(level, a, b, geom).map((w) => w.wallId)) : new Set<string>();
  const within = (now: Set<string>, was: Set<string>) => [...now].every((w) => was.has(w));
  for (let i = 1; i + 2 < out.length; i++) {
    const p0 = out[i - 1] as Vec2;
    const a = out[i] as Vec2;
    const b = out[i + 1] as Vec2;
    const p3 = out[i + 2] as Vec2;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const u = unit(sub(a, p0));
    const w = unit(sub(p3, b));
    if (len >= JOG || len < 1e-9 || !u || !w || dot(u, w) < 1 - 1e-9) continue;
    const step = sub(a, b);
    // The leg after moves onto the line before: b to a, and p3 with it (p3's next leg, if
    // any, square to it, only lengthens).
    const p3n = { x: p3.x + step.x, y: p3.y + step.y };
    const after = out[i + 3];
    const was = [crossed(b, p3), crossed(p3, after)];
    const now = [crossed(a, p3n), crossed(p3n, after)];
    const nextSquare = !after || Math.abs(dot(unit(sub(after, p3)) ?? w, w)) < 1e-6;
    if (nextSquare && now.every((n, k) => within(n, was[k] as Set<string>))) {
      out[i + 2] = p3n;
      out[i + 1] = { ...a };
      out = simplifyPath(out);
      i = 0;
      continue;
    }
    // Else the leg before moves onto the line after, unless it's the first (from the unit).
    if (i - 1 === 0) continue;
    const pm = out[i - 2] as Vec2;
    const p0n = { x: p0.x - step.x, y: p0.y - step.y };
    const was2 = [crossed(pm, p0), crossed(p0, a)];
    const now2 = [crossed(pm, p0n), crossed(p0n, b)];
    const prevSquare = Math.abs(dot(unit(sub(p0, pm)) ?? u, u)) < 1e-6;
    if (prevSquare && now2.every((n, k) => within(n, was2[k] as Set<string>))) {
      out[i - 1] = p0n;
      out[i] = { ...b };
      out = simplifyPath(out);
      i = 0;
    }
  }
  return out;
}

/** Where the line through p along u meets the line through q along w (null if parallel). */
function meet(p: Vec2, u: Vec2, q: Vec2, w: Vec2): Vec2 | null {
  const den = crossOf(u, w);
  if (Math.abs(den) < 1e-9) return null;
  return along(p, u, crossOf(sub(q, p), w) / den);
}

/**
 * A path re-made from its legs: each leg keeps its direction (from `path`) and runs through
 * its anchor (its first point, or the one given in `anchors`), and each bend is where two
 * legs meet. The ends are `start` and `end`. Legs that don't turn are kept as they were.
 */
function fromLegs(
  path: readonly Vec2[],
  start: Vec2,
  end: Vec2,
  anchors: ReadonlyMap<number, Vec2>,
): Vec2[] {
  const n = path.length;
  const dirs = path.slice(1).map((p, k) => unit(sub(p, path[k] as Vec2)));
  const anchor = (k: number) =>
    k === 0 ? start : k === n - 2 ? end : (anchors.get(k) ?? (path[k] as Vec2));
  const out: Vec2[] = [{ ...start }];
  for (let i = 1; i < n - 1; i++) {
    const u = dirs[i - 1];
    const w = dirs[i];
    const p = u && w ? meet(anchor(i - 1), u, anchor(i), w) : null;
    out.push(p ?? { ...(path[i] as Vec2) });
  }
  out.push({ ...end });
  return out;
}

/**
 * A run with one end moved (the unit along its wall, or the compressor dragged): every leg
 * keeps its direction, the leg at that end now through it, and the bends are where the legs
 * meet (so the bend next to it slides along its other leg); with no bend to slide, a corner
 * goes in. Give it the path as it was when the drag began, every move: a bend that lines up
 * for a moment isn't lost.
 */
export function movePathEnd(
  level: Level,
  path: readonly Vec2[],
  which: 'start' | 'end',
  to: Vec2,
  geom: PlanGeometry = planGeometry(level),
): Vec2[] {
  const first = path[0];
  const last = path[path.length - 1];
  if (!first || !last || path.length < 2) return [...path];
  if (path.length === 2) {
    const [a, b] = which === 'start' ? [to, last] : [first, to];
    return [a, ...legInto(level, a, b, { geom }), b];
  }
  const start = which === 'start' ? to : first;
  const end = which === 'end' ? to : last;
  return simplifyPath(fromLegs(path, start, end, new Map()));
}

/**
 * A spot moved onto the hug line of a wall face within `tol` (TRUNK_SNAP) of it, square to
 * the axes given; then onto a second face square to the first, into a corner.
 */
export function snapToFaces(
  level: Level,
  p: Vec2,
  axes: TrunkAxes,
  opts: { geom?: PlanGeometry; tol?: number } = {},
): Vec2 {
  const geom = opts.geom ?? planGeometry(level);
  const tol = opts.tol ?? TRUNK_SNAP;
  let at = { ...p };
  let used: Vec2 | null = null;
  for (let pass = 0; pass < 2; pass++) {
    let best: { face: Face; dist: number } | null = null;
    for (const face of obstacles(geom).faces) {
      const onAxis =
        Math.abs(Math.abs(dot(face.normal, axes.d)) - 1) < 1e-3 ||
        Math.abs(Math.abs(dot(face.normal, axes.n)) - 1) < 1e-3;
      if (!onAxis || (used && Math.abs(dot(face.normal, used)) > 0.5)) continue;
      const dist = dot(sub(at, face.origin), face.normal);
      if (Math.abs(dist) > tol) continue;
      const u = dot(sub(at, face.f.a), face.f.d);
      if (u < face.lo - TRUNK_OFF - 1e-6 || u > face.hi + TRUNK_OFF + 1e-6) continue;
      if (!best || Math.abs(dist) < Math.abs(best.dist)) best = { face, dist };
    }
    const b = best as { face: Face; dist: number } | null;
    if (!b) break;
    at = along(at, b.face.normal, -b.dist);
    used = b.face.normal;
  }
  return at;
}

/**
 * A bend dragged to `at`: its neighbours slide along their other legs so every leg keeps its
 * direction, except a fixed end (the start, and with `fixedEnd` the compressor), along whose
 * leg the bend slides instead. Give it the path from when the drag began.
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
  const out = path.map((q) => ({ ...q }));
  const fixed = (j: number) => j === 0 || (!!opts.fixedEnd && j === path.length - 1);
  const legs = [index - 1, index + 1]
    .map((j) => {
      const q = path[j];
      const u = q ? unit(sub(q, p)) : null;
      return q && u ? { j, q, u } : null;
    })
    .filter((l): l is { j: number; q: Vec2; u: Vec2 } => !!l);
  // Held by the fixed neighbours: on their legs' lines.
  const held = legs.filter((l) => fixed(l.j));
  let to = { ...at };
  const [h1, h2] = held;
  if (h1 && h2) to = meet(h1.q, h1.u, h2.q, h2.u) ?? to;
  else if (h1) to = along(h1.q, h1.u, dot(sub(at, h1.q), h1.u));
  out[index] = to;
  for (const l of legs) {
    if (fixed(l.j)) continue;
    // The neighbour slides along its other leg to stay on this leg's line.
    const k = l.j + (l.j < index ? -1 : 1);
    const far = path[k];
    const w = far ? unit(sub(l.q, far)) : null;
    // A free last bend (no compressor yet) just moves across, onto this leg's line.
    const slid = far && w ? meet(far, w, to, l.u) : along(to, l.u, dot(sub(l.q, to), l.u));
    if (slid) out[l.j] = slid;
  }
  return out;
}

/**
 * A point changed (`patch`) with the trunking that ends on it kept square: a compressor
 * moved takes the last bend of each run into it along, an aircon unit moved along its wall
 * its first bend (movePathEnd). One command, so a drag is one undo step. Give it the level
 * from when the drag began, every move.
 */
export function moveWithTrunking(
  level: Level,
  pointId: string,
  patch: PointPatch,
  geomIn?: PlanGeometry,
): Command {
  const was = level.points[pointId];
  const set = updatePoint(level.id, pointId, patch);
  if (!was || !(patch.at || patch.wall)) return set;
  const now = { ...was, ...patch } as ElecPoint;
  const units =
    now.kind === 'compressor' && now.at
      ? Object.values(level.points).filter((u) => u.kind === 'aircon' && u.compressorId === pointId)
      : now.kind === 'aircon' && (was.route?.length || was.compressorId)
        ? [was]
        : [];
  // Nothing ends on it: just the point.
  if (units.length === 0) return set;
  const geom = geomIn ?? planGeometry(level);
  const follow: { id: string; route: Vec2[] }[] = [];
  for (const u of units) {
    const path = trunkingPath(level, u);
    if (path.length < 2) continue;
    const end = !!u.compressorId && !!level.points[u.compressorId]?.at;
    if (now.kind === 'compressor' && now.at) {
      follow.push({ id: u.id, route: movePathEnd(level, path, 'end', now.at, geom).slice(1, -1) });
    } else {
      const moved = { ...level, points: { ...level.points, [pointId]: now } };
      const start = trunkingStart(moved, now);
      if (!start) continue;
      const out = movePathEnd(level, path, 'start', start, geom);
      follow.push({ id: u.id, route: out.slice(1, end ? -1 : undefined) });
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

/**
 * The route of a unit with its bend `index` dragged to `at` (dragBend, ends fixed), from the
 * level as the drag began. With `snap`, the bend hugs a face it's dragged near.
 */
export function draggedRoute(
  level: Level,
  unitPoint: ElecPoint,
  index: number,
  at: Vec2,
  opts: { geom?: PlanGeometry; snap?: boolean } = {},
): Vec2[] {
  const geom = opts.geom ?? planGeometry(level);
  const path = trunkingPath(level, unitPoint);
  const end = !!unitPoint.compressorId && !!level.points[unitPoint.compressorId]?.at;
  const bend = path[index + 1];
  const spot =
    opts.snap && bend
      ? snapToFaces(level, at, legAxes(path[index], bend) ?? trunkAxes(level, bend, geom), {
          geom,
        })
      : at;
  const out = dragBend(level, path, index + 1, spot, { fixedEnd: end, geom });
  return out.slice(1, end ? -1 : undefined);
}

/**
 * After walls moved in a recipe (a corner dragged, a wall shifted, a room moved): every
 * aircon run kept square. Each leg that hugged a face before still hugs it (it moves across
 * with the wall), the first leg runs from where the unit now is, and the bends are where the
 * legs meet (fromLegs). Call it in the same recipe, after the walls have moved.
 */
export function followRuns(lvl: Draft<Level>): void {
  const units = Object.values(lvl.points ?? {}).filter(
    (p) => p.kind === 'aircon' && (p.route?.length ?? 0) > 0,
  );
  if (units.length === 0) return;
  const before = original(lvl) as Level | undefined;
  if (!before) return;
  const after = current(lvl) as Level;
  const g0 = planGeometry(before);
  const g1 = planGeometry(after);
  const faces0 = obstacles(g0).faces;
  for (const u of units) {
    const was = before.points[u.id];
    if (!was?.route?.length) continue;
    const path = trunkingPath(before, was);
    const start = trunkingStart(after, after.points[u.id] as ElecPoint);
    if (!start || path.length < 2) continue;
    const comp = was.compressorId ? after.points[was.compressorId]?.at : undefined;
    const end = comp ?? (path[path.length - 1] as Vec2);
    // Legs on a face's hug line: through the same face's hug line now.
    const anchors = new Map<number, Vec2>();
    for (let k = 0; k + 1 < path.length; k++) {
      const a = path[k] as Vec2;
      const b = path[k + 1] as Vec2;
      const e = unit(sub(b, a));
      if (!e) continue;
      const face = faces0.find(
        (f) =>
          Math.abs(dot(f.normal, e)) < 1e-6 &&
          Math.abs(dot(sub(a, f.origin), f.normal)) < 1e-6 &&
          Math.max(dot(sub(a, f.f.a), f.f.d), dot(sub(b, f.f.a), f.f.d)) > f.lo - TRUNK_OFF &&
          Math.min(dot(sub(a, f.f.a), f.f.d), dot(sub(b, f.f.a), f.f.d)) < f.hi + TRUNK_OFF,
      );
      const f1 = face && g1.frames[face.f.wall.id];
      if (!face || !f1) continue;
      const side = dot(face.normal, face.f.n) > 0 ? 1 : -1;
      const normal = { x: f1.n.x * side, y: f1.n.y * side };
      if (dot(normal, face.normal) < 1 - 1e-9) continue;
      const origin = along(framePoint(f1, 0, side), normal, TRUNK_OFF);
      anchors.set(k, along(a, normal, dot(sub(origin, a), normal)));
    }
    // A free last bend (no compressor) moves with its leg's face, if it hugged one.
    const lastLeg = path.length - 2;
    const freeEnd =
      comp || !anchors.has(lastLeg)
        ? end
        : (() => {
            const anchor = anchors.get(lastLeg) as Vec2;
            const a = path[lastLeg] as Vec2;
            return { x: end.x + anchor.x - a.x, y: end.y + anchor.y - a.y };
          })();
    const next = fromLegs(path, start, freeEnd, anchors);
    const route = next.slice(1, comp ? -1 : undefined);
    const same =
      route.length === was.route.length &&
      route.every((q, i) => {
        const w = was.route?.[i];
        return !!w && Math.hypot(q.x - w.x, q.y - w.y) < 1e-9;
      });
    if (!same) u.route = route;
  }
}

// ---------------------------------------------------------------------------- along the walls

/** What going through each kind of wall costs a route, in metres of trunking. */
const THROUGH_COST: Record<TrunkCrossing['through'], number> = {
  window: 0.4,
  passage: 0.4,
  solid: 0.8,
  door: 0.8,
};
/** A leg off every face (across the ceiling) costs this much more a metre. */
const OFF_WALL = 1.5;
/** A leg in a room other than the unit's or the ledge costs this much more a metre. */
const AWAY = 0.3;
/** Each turn, in metres. */
const TURN = 0.2;
/** How far round the unit's room and the ledge a route looks first (metres). */
const REACH = 3;

/**
 * A route along the walls from an aircon unit to a compressor at `compressor` (on the aircon
 * ledge), inside the flat: square to the unit's wall, hugging faces (TRUNK_OFF off them) at
 * the ceiling line, through the unit's room and, if need be, other rooms and corridors (never
 * the household shelter or the outside), through internal walls where it must, and into the
 * ledge only through a wall that borders it. The cheapest by length, turns, legs off a wall,
 * legs away from the unit's room and walls drilled. Its bends (the unit's `route`), or null
 * with no such route (the ledge borders no room it can reach).
 */
export function autoRoute(
  level: Level,
  unitPoint: ElecPoint,
  compressor: Vec2,
  geom: PlanGeometry = planGeometry(level),
): Vec2[] | null {
  const start = trunkingStart(level, unitPoint);
  const pos = pointPosition(level, unitPoint);
  if (!start || !pos?.dir) return null;
  return wallRoute(level, start, compressor, axesOf(pos.dir), { geom, except: unitPoint.id });
}

/**
 * A route along the walls, inside the flat, from `from` to `to` (as autoRoute has it), square
 * to `axes`; `way` is the way the run was already going at `from` (it won't double back).
 * Its bends, or null with none.
 */
export function wallRoute(
  level: Level,
  start: Vec2,
  compressor: Vec2,
  axes: TrunkAxes,
  opts: { geom?: PlanGeometry; way?: Vec2 | null; except?: string } = {},
): Vec2[] | null {
  const geom = opts.geom ?? planGeometry(level);
  const shapes = roomShapes(level);
  const rooms = roomsOf(shapes);
  const home = regionAt(rooms, start);
  const ledge = regionAt(rooms, compressor);
  if (home === 'outside' || ledge === 'outside') return null;
  const boxOfRoom = (id: string) => {
    const s = shapes.get(id);
    return s ? boxOf(s.outer) : null;
  };
  const hb = boxOfRoom(home);
  const lb = boxOfRoom(ledge);
  if (!hb || !lb) return null;
  // Near the unit's room and the ledge first; the whole flat if that finds nothing.
  const near: Box = {
    x0: Math.min(hb.x0, lb.x0) - REACH,
    y0: Math.min(hb.y0, lb.y0) - REACH,
    x1: Math.max(hb.x1, lb.x1) + REACH,
    y1: Math.max(hb.y1, lb.y1) + REACH,
  };
  const job: RouteJob = {
    level,
    geom,
    shapes,
    rooms,
    axes,
    way: opts.way ?? null,
    start,
    compressor,
    home,
    ledge,
    shelter: shelterWalls(level),
    shared: sharedLegs(level, opts.except),
  };
  const first = routeWithin(job, near);
  if (first.route || first.whole) return first.route;
  return routeWithin(job, null).route;
}

interface RouteJob {
  level: Level;
  geom: PlanGeometry;
  shapes: Map<string, RoomShape>;
  rooms: Buckets<RoomEntry>;
  /** The route runs square to these (the unit's wall). */
  axes: TrunkAxes;
  /** The way the run was already going at the start. */
  way: Vec2 | null;
  start: Vec2;
  compressor: Vec2;
  home: string;
  ledge: string;
  /** The household shelter's walls: never drilled. */
  shelter: ReadonlySet<string>;
  /** Other units' trunking: a route joins it where it can, as a fitter shares a trunk. */
  shared: readonly (readonly [Vec2, Vec2])[];
}

/** The legs of every aircon run on the level but `except`'s. */
function sharedLegs(level: Level, except?: string): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  for (const p of Object.values(level.points ?? {})) {
    if (p.kind !== 'aircon' || p.id === except) continue;
    const path = trunkingPath(level, p);
    for (let i = 1; i < path.length; i++) out.push([path[i - 1] as Vec2, path[i] as Vec2]);
  }
  return out;
}

/** Joining another unit's trunking costs this a metre (against 1 for a new run). */
const SHARE = 0.25;
/** A leg along a wall over a doorway's head costs this more (it's avoided if it can be). */
const DOOR_HEAD = 0.6;

/** The walls of the household shelter (wallStatus 'shelter'). */
function shelterWalls(level: Level): Set<string> {
  const out = new Set<string>();
  if (!Object.values(level.rooms).some((r) => SHELTER_ROOM.test(r.name))) return out;
  for (const id of Object.keys(level.walls)) if (wallStatus(level, id) === 'shelter') out.add(id);
  return out;
}

function routeWithin(job: RouteJob, window: Box | null): { route: Vec2[] | null; whole: boolean } {
  const { level, geom, shapes, rooms, start, compressor, home, ledge } = job;
  const { d, n } = job.axes;
  const obs = obstacles(geom);
  const overlaps = (b: Box) =>
    !window || (b.x1 > window.x0 && b.x0 < window.x1 && b.y1 > window.y0 && b.y0 < window.y1);
  // Rooms it may go through: any but the shelter and other ledges, within the window.
  const allowed = new Set<string>();
  let whole = true;
  for (const [id, s] of shapes) {
    const name = level.rooms[id]?.name ?? '';
    const ok = id === home || id === ledge || (!SHELTER_ROOM.test(name) && !LEDGE_ROOM.test(name));
    if (!ok) continue;
    if (overlaps(boxOf(s.outer))) allowed.add(id);
    else whole = false;
  }
  // The area the grid covers: the allowed rooms, and a little round them.
  let area: Box | null = null;
  for (const id of allowed) {
    const s = shapes.get(id);
    if (!s) continue;
    const b = boxOf(s.outer);
    area = area
      ? {
          x0: Math.min(area.x0, b.x0),
          y0: Math.min(area.y0, b.y0),
          x1: Math.max(area.x1, b.x1),
          y1: Math.max(area.y1, b.y1),
        }
      : b;
  }
  if (!area) return { route: null, whole };
  const pad = 0.5;
  const box = { x0: area.x0 - pad, y0: area.y0 - pad, x1: area.x1 + pad, y1: area.y1 + pad };

  // The lines a route may run on: each face's hug line square to the axes (u = const or
  // v = const, with the stretch it hugs), and through both ends. Keyed to 0.1 mm; each line
  // at the first value given it (the ends', so they lie on theirs).
  const us = new Map<number, [number, number][]>();
  const vs = new Map<number, [number, number][]>();
  const exU = new Map<number, number>();
  const exV = new Map<number, number>();
  const key = (x: number) => Math.round(x * 1e4) / 1e4;
  const addLine = (
    m: Map<number, [number, number][]>,
    ex: Map<number, number>,
    c: number,
    ext?: [number, number],
  ) => {
    const k = key(c);
    const list = m.get(k) ?? [];
    if (ext) list.push(ext);
    m.set(k, list);
    if (!ex.has(k)) ex.set(k, c);
  };
  const toU = (p: Vec2) => dot(p, d);
  const toV = (p: Vec2) => dot(p, n);
  for (const p of [start, compressor]) {
    addLine(us, exU, toU(p));
    addLine(vs, exV, toV(p));
  }
  // Other runs' legs square to the axes: lines to join them on.
  const shared: { a: Vec2; b: Vec2; e: Vec2 }[] = [];
  for (const [a, b] of job.shared) {
    const e = unit(sub(b, a));
    if (!e) continue;
    if (Math.abs(dot(e, d)) > 1 - 1e-9) addLine(vs, exV, toV(a));
    else if (Math.abs(dot(e, n)) > 1 - 1e-9) addLine(us, exU, toU(a));
    else continue;
    shared.push({ a, b, e });
  }
  const onShared = (p: Vec2, q: Vec2) => {
    const e = unit(sub(q, p));
    if (!e) return false;
    const m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    return shared.some((s) => {
      if (Math.abs(crossOf(e, s.e)) > 1e-9 || Math.abs(crossOf(sub(m, s.a), s.e)) > 1e-6)
        return false;
      const t = dot(sub(m, s.a), s.e);
      return t > 0 && t < Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
    });
  };
  // Doorways: a leg along the wall over one's head is avoided where it can be.
  const doorHeads = geom.openings
    .filter((o) => o.kind === 'door')
    .map((o) => ({ f: o.frame, span: o.span }));
  const overDoor = (p: Vec2, q: Vec2) => {
    const e = unit(sub(q, p));
    if (!e) return false;
    return doorHeads.some(({ f, span }) => {
      if (Math.abs(dot(e, f.d)) < 1 - 1e-9) return false;
      if (Math.abs(dot(sub(p, f.a), f.n)) > f.half + TRUNK_OFF + 0.01) return false;
      const up = dot(sub(p, f.a), f.d);
      const uq = dot(sub(q, f.a), f.d);
      return Math.max(up, uq) > span[0] && Math.min(up, uq) < span[1];
    });
  };
  for (const face of obs.faces) {
    const a = framePoint(face.f, face.lo - TRUNK_OFF, 0);
    const b = framePoint(face.f, face.hi + TRUNK_OFF, 0);
    if (!boxesMeet(a, b, box) && !inBox(a, box)) continue;
    if (Math.abs(dot(face.normal, d)) > 0.999) {
      const e = [toV(a), toV(b)].sort((x, y) => x - y) as [number, number];
      addLine(us, exU, toU(face.origin), e);
    } else if (Math.abs(dot(face.normal, n)) > 0.999) {
      const e = [toU(a), toU(b)].sort((x, y) => x - y) as [number, number];
      addLine(vs, exV, toV(face.origin), e);
    }
  }
  const U = [...us.keys()].sort((a, b) => a - b);
  const V = [...vs.keys()].sort((a, b) => a - b);
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
  const region = new Map<number, string>();
  for (let i = 0; i < NU; i++)
    for (let j = 0; j < NV; j++) {
      const p = at(i, j);
      const k = i * NV + j;
      if (!inBox(p, box)) state[k] = NO;
      else if (inWall(obs, p)) state[k] = WALL;
      else {
        const r = regionAt(rooms, p);
        region.set(k, r);
        state[k] = allowed.has(r) ? 1 : NO;
      }
    }
  const startNode = U.indexOf(key(toU(start))) * NV + V.indexOf(key(toV(start)));
  const endNode = U.indexOf(key(toU(compressor))) * NV + V.indexOf(key(toV(compressor)));
  if (state[startNode] !== 1 || state[endNode] !== 1) return { route: null, whole };

  const hugs = (ext: [number, number][] | undefined, c: number) =>
    !!ext?.some(([lo, hi]) => c >= lo - 1e-6 && c <= hi + 1e-6);
  /** Whether every stretch of ab clear of walls is in a room it may go through. */
  const clearOfOthers = (a: Vec2, b: Vec2) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.ceil(len / 0.05);
    for (let k = 1; k < steps; k++) {
      const p = { x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps };
      if (!inWall(obs, p) && !allowed.has(regionAt(rooms, p))) return false;
    }
    return true;
  };
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
        if (walls.some((w) => w.lengthwise || w.through === 'door' || job.shelter.has(w.wallId)))
          break;
        // Through a wall: what's on the far side of each must be somewhere it may go. Both
        // ends are; a leg through one wall and no further needs no more looking.
        if (walls.length > 1 || (walls.length === 1 && len > 0.6)) {
          if (!clearOfOthers(a, b)) break;
        }
        const hug =
          di !== 0
            ? hugs(vs.get(V[j0] as number), ((U[i0] as number) + (U[i] as number)) / 2)
            : hugs(us.get(U[i0] as number), ((V[j0] as number) + (V[j] as number)) / 2);
        const r = region.get(node);
        const away = r !== home && r !== ledge;
        // Along another run: its trunk is shared, and its holes are drilled already.
        const joined = onShared(a, b);
        let cost = joined
          ? len * SHARE
          : len * (1 + (hug ? 0 : OFF_WALL) + (away ? AWAY : 0)) + (overDoor(a, b) ? DOOR_HEAD : 0);
        for (const w of walls) {
          const glass = !w.wallId.startsWith('hub:') && isGlass(level.walls[w.wallId] ?? {});
          cost += joined ? 0.1 : glass ? 5 : THROUGH_COST[w.through];
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
  // State s = node * 5 + way in (4: none, at the start, or the way the run already goes).
  const w = job.way;
  const wayIn = !w
    ? 4
    : dot(w, d) > 0.999
      ? 0
      : dot(w, d) < -0.999
        ? 1
        : dot(w, n) > 0.999
          ? 2
          : dot(w, n) < -0.999
            ? 3
            : 4;
  const s0 = startNode * 5 + wayIn;
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
  if (goal < 0) return { route: null, whole };
  const nodes: number[] = [];
  for (let s = goal; s >= 0; s = prev[s] as number) nodes.push(Math.floor(s / 5));
  nodes.reverse();
  const path = nodes.map((k) => at(Math.floor(k / NV), k % NV));
  path[0] = { ...start };
  path[path.length - 1] = { ...compressor };
  return { route: simplifyPath(path).slice(1, -1), whole };
}

/** Where a run along the walls ends: the unit's compressor, the nearest one, or a new one. */
function compressorFor(level: Level, unitPoint: ElecPoint): { at: Vec2; id?: string } | null {
  const own = unitPoint.compressorId ? level.points[unitPoint.compressorId] : undefined;
  if (own?.at) return { at: own.at, id: own.id };
  const from = pointPosition(level, unitPoint)?.at;
  if (!from) return null;
  const dist = (p: Vec2) => Math.hypot(p.x - from.x, p.y - from.y);
  const near = Object.values(level.points)
    .filter((q): q is ElecPoint & { at: Vec2 } => q.kind === 'compressor' && !!q.at)
    .sort((p, q) => dist(p.at) - dist(q.at))[0];
  if (near) return { at: near.at, id: near.id };
  // A new one on the nearest ledge, towards the unit's end of it (clear of its name).
  const ledges: Vec2[] = [];
  for (const [id, shape] of roomShapes(level)) {
    if (LEDGE_ROOM.test(level.rooms[id]?.name ?? '')) ledges.push(ledgeSpot(shape, from));
  }
  const spot = ledges.sort((p, q) => dist(p) - dist(q))[0];
  return spot ? { at: spot } : null;
}

/**
 * Where a new compressor goes on a ledge: level with the middle, along the ledge's length
 * towards `from`'s end, its box clear of the walls; the middle if that isn't on the ledge.
 */
function ledgeSpot(shape: RoomShape, from: Vec2): Vec2 {
  const mid = labelPoint(shape.outer);
  const b = boxOf(shape.outer);
  const half = 0.8 / 2 + 0.2;
  const alongX = b.x1 - b.x0 >= b.y1 - b.y0;
  const [lo, hi] = alongX ? [b.x0 + half, b.x1 - half] : [b.y0 + half, b.y1 - half];
  if (hi <= lo) return mid;
  const toward = alongX ? from.x : from.y;
  const at = toward > (lo + hi) / 2 ? hi : lo;
  // Across it, back against the far side from the unit (the parapet): the name keeps the rest.
  const deep = 0.15 + 0.3 / 2 + 0.05;
  const [clo, chi] = alongX ? [b.y0 + deep, b.y1 - deep] : [b.x0 + deep, b.x1 - deep];
  const midAcross = alongX ? mid.y : mid.x;
  const fromAcross = alongX ? from.y : from.x;
  const across = chi <= clo ? midAcross : fromAcross < midAcross ? chi : clo;
  const spot = alongX ? { x: at, y: across } : { x: across, y: at };
  return pointInPolygon(spot, shape.outer) ? spot : mid;
}

/**
 * Routes an aircon unit's trunking along the walls, inside the flat, to its compressor (the
 * nearest one, or a new one on the ledge), in one undo step. Else why not (NO_LEDGE,
 * NO_INSIDE_ROUTE): the bends are then tapped by hand.
 */
export function routeAlongWalls(
  level: Level,
  unitId: string,
  geom: PlanGeometry = planGeometry(level),
): { command: Command; compressorId: string } | { error: string } {
  const unitPoint = level.points[unitId];
  if (unitPoint?.kind !== 'aircon') return { error: NO_INSIDE_ROUTE };
  const comp = compressorFor(level, unitPoint);
  if (!comp) return { error: NO_LEDGE };
  const route = autoRoute(level, unitPoint, comp.at, geom);
  if (!route) return { error: NO_INSIDE_ROUTE };
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

/** A leg shorter than this needn't hug a wall (a stub into the compressor, a turn). */
const STUB = 0.35;

/** Whether a leg lies on a wall face's hug line, alongside it. */
function legHugs(geom: PlanGeometry, a: Vec2, b: Vec2): boolean {
  const e = unit(sub(b, a));
  if (!e) return true;
  return obstacles(geom).faces.some((f) => {
    if (Math.abs(dot(f.normal, e)) > 1e-6) return false;
    if (Math.abs(dot(sub(a, f.origin), f.normal)) > 1e-6) return false;
    const ua = dot(sub(a, f.f.a), f.f.d);
    const ub = dot(sub(b, f.f.a), f.f.d);
    const lo = Math.max(Math.min(ua, ub), f.lo - TRUNK_OFF);
    const hi = Math.min(Math.max(ua, ub), f.hi + TRUNK_OFF);
    return hi - lo > Math.abs(ub - ua) * 0.5;
  });
}

/**
 * Whether a run to a compressor is as a fitter would leave it: square, every leg but the
 * last (into the compressor) and short turns on a wall's hug line, and through no doorway.
 */
function neatRun(level: Level, path: readonly Vec2[], geom: PlanGeometry): boolean {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Vec2;
    const b = path[i] as Vec2;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const through = wallsCrossed(level, a, b, geom);
    if (through.some((w) => w.through === 'door')) return false;
    // The last leg, a short turn, or a leg through a wall needn't hug one.
    if (i === path.length - 1 || len < STUB || (through.length > 0 && len < 0.6)) continue;
    if (!legHugs(geom, a, b)) return false;
  }
  return true;
}

/** The run of an aircon unit straightened (tidyRoute), as its new bends; null if no change. */
export function straightenedRoute(
  level: Level,
  unitPoint: ElecPoint,
  geom: PlanGeometry = planGeometry(level),
): Vec2[] | null {
  const path = trunkingPath(level, unitPoint);
  if (path.length < 2) return null;
  const end = !!unitPoint.compressorId && !!level.points[unitPoint.compressorId]?.at;
  const axes = unitAxes(level, unitPoint);
  let tidy = tidyRoute(level, path, { end, geom, axes, except: unitPoint.id });
  // Squared but still not neat (a leg across a room, or over a doorway): the run re-made
  // along the walls between its ends, as Route along the walls has it.
  const first = tidy[0];
  const last = tidy[tidy.length - 1];
  if (end && axes && first && last && !neatRun(level, tidy, geom)) {
    const routed = wallRoute(level, first, last, axes, { geom, except: unitPoint.id });
    if (routed) tidy = [first, ...routed, last];
  }
  const route = tidy.slice(1, end ? -1 : undefined);
  const was = unitPoint.route ?? [];
  const same =
    route.length === was.length &&
    route.every((q, i) => {
      const w = was[i];
      return !!w && Math.hypot(q.x - w.x, q.y - w.y) < 1e-6;
    });
  return same ? null : route;
}
