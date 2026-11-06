import { furnitureKind, furnitureLayer, itemFootprint, itemSize } from './furniture';
import { pointInPolygon } from './geometry';
import { type PlanGeometry, doorStyle, framePoint, planGeometry } from './plan';
import { roomShapes } from './rooms';
import type { Level, Opening, Vec2 } from './schema';
import { isBoundary } from './schema';
import { outsideOpenings } from './walk';

/**
 * Will it get in? The way from the flat's main door to a piece, room to room through doors
 * and passages, and whether the piece can be carried through each: square through the clear
 * width and height, tipped any way, or a sofa tilted on its diagonal; and turned in the space
 * in front of the door. Advice only. Spec: docs/specs/my-furniture.md.
 */
export type Fit = 'fits' | 'tight' | 'hinges' | 'too-big';

export interface DoorOnTheWay {
  openingId: string;
  /** The room it opens into on the way in (null: outside). */
  into: string | null;
  /** Clear width and height. */
  clear: number;
  height: number;
  fit: Fit;
  /** What it fails on: the width the piece needs on its narrowest carry, or the turn. */
  need?: number;
  turn?: { space: number };
  centre: Vec2;
}

export type Delivery =
  | { status: 'no-room' }
  | { status: 'no-door' }
  | { status: 'unreachable'; from: string }
  | { status: Fit; from: string; doors: DoorOnTheWay[]; worst: DoorOnTheWay | null };

/** Room for the hand: under this to spare is tight. */
const SPARE = 0.02;
/** Far enough in front of a door: a room is never deeper than this for turning. */
const FAR = 3;
/** Outside the main door: an HDB common corridor, about this wide. */
const CORRIDOR = 1.2;

/** A door's clear width: what its leaves, open, leave of the opening. */
export function clearWidth(o: Opening): number {
  if (o.kind !== 'door') return o.width;
  const style = doorStyle(o);
  const panels = o.panels ?? (style === 'bifold' || style === 'folding' ? 4 : 2);
  switch (style) {
    case 'double':
      return o.width - 0.08;
    case 'sliding':
      return o.width * (1 - 1 / panels);
    case 'pocket':
      return o.width;
    case 'bifold':
    case 'folding':
      return o.width - 0.04 * panels;
    default:
      return o.width - 0.04;
  }
}

/**
 * The longest piece of breadth `t` that turns from a space `space` deep through a door
 * `width` wide at a right angle (the classic moving-sofa-round-a-corner limit).
 */
export function turnLimit(width: number, space: number, t: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < 180; i++) {
    const th = (i / 180) * (Math.PI / 2);
    const s = Math.sin(th);
    const c = Math.cos(th);
    best = Math.min(best, (width * s + space * c - t) / (s * c));
  }
  return Math.max(0, best);
}

/** How far a typed diagonal may stray outside `diagonalRange` (a measurement, in metres). */
export const DIAGONAL_TOLERANCE = 0.005;

/**
 * The possible diagonal depths of a sofa `d` deep and `h` high: its width across when tipped
 * on its back (from the back's top to the seat's front bottom, the line a stick lies on, to
 * the bottom back corner). At most the shorter of depth and height (a plain carry is already
 * that wide), and at least the height of the right triangle's corner, d·h / √(d² + h²).
 */
export function diagonalRange(d: number, h: number): { min: number; max: number } {
  return { min: (d * h) / Math.hypot(d, h), max: Math.min(d, h) };
}

/** Whether a measured diagonal is possible for a sofa `d` deep and `h` high. */
export function diagonalFits(diagonal: number, d: number, h: number): boolean {
  const r = diagonalRange(d, h);
  return diagonal >= r.min - DIAGONAL_TOLERANCE && diagonal <= r.max + DIAGONAL_TOLERANCE;
}

interface Carry {
  l: number;
  t: number;
  v: number;
}

/** Every way to carry a piece w × d × h through a door (and a sofa on its diagonal). */
function carries(w: number, d: number, h: number, diagonal?: number): Carry[] {
  const dims = [w, d, h];
  const out: Carry[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (j === i) continue;
      const k = 3 - i - j;
      out.push({ l: dims[i] as number, t: dims[j] as number, v: dims[k] as number });
    }
  }
  if (diagonal) out.push({ l: w, t: diagonal, v: Math.hypot(d, h) });
  return out;
}

/** A door or passage in the door graph: where it is, and the rooms either side. */
export interface RouteDoor {
  o: Opening;
  centre: Vec2;
  n: Vec2;
  half: number;
  /** Room ids either side: +n, -n (null: outside). */
  sides: [string | null, string | null];
}

/** The way through a flat: its doors and passages, and rooms open to each other. */
export interface DoorGraph {
  doors: RouteDoor[];
  /** Rooms joined across a room boundary (no door), both ways. */
  free: Map<string, Set<string>>;
}

/** The room at a point (not in a hole), by id. */
function roomIdAt(level: Level, p: Vec2): string | null {
  const shapes = roomShapes(level);
  return (
    Object.values(level.rooms).find((r) => {
      const s = shapes.get(r.id);
      return !!s && pointInPolygon(p, s.outer) && !s.holes.some((h) => pointInPolygon(p, h));
    })?.id ?? null
  );
}

/** A flat's doors and passages with the rooms either side, and its room boundaries. */
export function doorGraph(level: Level, geom: PlanGeometry = planGeometry(level)): DoorGraph {
  const doors = geom.openings
    .filter((g) => g.kind !== 'window')
    .map((g): RouteDoor => {
      const f = g.frame;
      const u = (g.span[0] + g.span[1]) / 2;
      const centre = framePoint(f, u, 0);
      const off = f.half + 0.1;
      const at = (k: number) => ({ x: centre.x + f.n.x * off * k, y: centre.y + f.n.y * off * k });
      return {
        o: g.opening,
        centre,
        n: f.n,
        half: f.half,
        sides: [roomIdAt(level, at(1)), roomIdAt(level, at(-1))],
      };
    });
  const shapes = roomShapes(level);
  const free = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!free.has(a)) free.set(a, new Set());
    free.get(a)?.add(b);
  };
  // By id, so the way found doesn't depend on the order the walls were stored in.
  const walls = Object.values(level.walls).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const wall of walls) {
    if (!isBoundary(wall)) continue;
    const f = geom.frames[wall.id];
    if (!f) continue;
    const mid = framePoint(f, f.length / 2, 0);
    const at = (k: number) => ({ x: mid.x + f.n.x * 0.1 * k, y: mid.y + f.n.y * 0.1 * k });
    const room = (q: Vec2) =>
      Object.values(level.rooms).find((r) => {
        const s = shapes.get(r.id);
        return !!s && pointInPolygon(q, s.outer);
      })?.id;
    const a = room(at(1));
    const b = room(at(-1));
    if (a && b && a !== b) {
      link(a, b);
      link(b, a);
    }
  }
  return { doors, free };
}

/** How a room was reached: from `room`, through `door` (null: across a room boundary). */
export type RouteStep = { room: string; door: RouteDoor | null } | null;

/**
 * Fewest doors from `start` (a room id) to every room, or to `target` (it stops there):
 * across a room boundary costs no door. `pass` says whether a door may be gone through from
 * one room into another; `skip` is a door never used (the one the way began at). Each room
 * reached maps to the step it was reached by (null for `start`).
 */
export function doorSearch(
  graph: DoorGraph,
  start: string,
  opts: {
    target?: string;
    skip?: RouteDoor;
    pass?: (door: RouteDoor, from: string, into: string) => boolean;
  } = {},
): Map<string, RouteStep> {
  const prev = new Map<string, RouteStep>();
  prev.set(start, null);
  const queue = [start];
  while (queue.length) {
    const room = queue.shift() as string;
    if (room === opts.target) break;
    // Across a room boundary costs no door: to the front of the queue.
    for (const nb of graph.free.get(room) ?? []) {
      if (prev.has(nb)) continue;
      prev.set(nb, { room, door: null });
      queue.unshift(nb);
    }
    for (const door of graph.doors) {
      if (door === opts.skip) continue;
      const [pa, pb] = door.sides;
      const other = pa === room ? pb : pb === room ? pa : undefined;
      if (!other || prev.has(other)) continue;
      if (opts.pass && !opts.pass(door, room, other)) continue;
      prev.set(other, { room, door });
      queue.push(other);
    }
  }
  return prev;
}

/** The doors on the way to `room` found by doorSearch, in order (null if it wasn't reached). */
export function routeTo(
  prev: Map<string, RouteStep>,
  room: string,
): { door: RouteDoor; into: string }[] | null {
  if (!prev.has(room)) return null;
  const route: { door: RouteDoor; into: string }[] = [];
  for (let at = room; ; ) {
    const step = prev.get(at);
    if (!step) break;
    if (step.door) route.unshift({ door: step.door, into: at });
    at = step.room;
  }
  return route;
}

/** How far a ray from `p` along `dir` runs before meeting a wall (capped). */
function rayToWall(p: Vec2, dir: Vec2, walls: Vec2[][]): number {
  let best = FAR;
  for (const poly of walls) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i] as Vec2;
      const b = poly[(i + 1) % poly.length] as Vec2;
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const den = dir.x * ey - dir.y * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((a.x - p.x) * ey - (a.y - p.y) * ex) / den;
      const s = ((a.x - p.x) * dir.y - (a.y - p.y) * dir.x) / den;
      if (t > 1e-6 && s >= 0 && s <= 1) best = Math.min(best, t);
    }
  }
  return best;
}

/** The flat's main doors: doors to the outside, widest first; with none, every door. */
export function mainDoors(level: Level, geom = planGeometry(level)): string[] {
  const outside = outsideOpenings(level, geom);
  const doors = Object.values(level.openings).filter((o) => o.kind === 'door');
  const main = doors.filter((o) => outside.has(o.id));
  // A hinged door first (a balcony's sliding or folding doors aren't the way in), then the
  // widest clear opening.
  const hinged = (o: Opening) => {
    const st = doorStyle(o);
    return st === 'swing' || st === 'double' ? 0 : 1;
  };
  return (main.length ? main : doors)
    .sort((a, b) => hinged(a) - hinged(b) || clearWidth(b) - clearWidth(a))
    .map((o) => o.id);
}

/**
 * The flat's way in: the main door, if a door leads outside at all (an upper floor of a
 * house, or a plan whose outside wall isn't drawn, has none).
 */
export function entranceDoor(level: Level, geom = planGeometry(level)): string | null {
  const first = mainDoors(level, geom)[0];
  return first && outsideOpenings(level, geom).has(first) ? first : null;
}

/**
 * The way in for a piece on `level`, from the main door `from` (default: the widest door to
 * the outside): the doors on the route, each judged, and the worst of them.
 */
export function deliveryCheck(
  level: Level,
  itemId: string,
  opts: { from?: string; lift?: { width: number; height: number } } = {},
): Delivery {
  const item = level.items[itemId];
  if (!item) return { status: 'no-room' };
  const geom = planGeometry(level);
  const graph = doorGraph(level, geom);
  const doors = graph.doors;
  const shapes = roomShapes(level);
  const p = { x: item.position.x, y: item.position.z };
  const target = Object.values(level.rooms).find((r) => {
    const s = shapes.get(r.id);
    return !!s && pointInPolygon(p, s.outer) && !s.holes.some((h) => pointInPolygon(p, h));
  })?.id;
  if (!target) return { status: 'no-room' };
  const from = opts.from ?? mainDoors(level, geom)[0];
  const start = doors.find((d) => d.o.id === from);
  if (!from || !start) return { status: 'no-door' };

  const kind = furnitureKind(item.assetId);
  const { w, d, h } = itemSize(item, kind);
  // A sofa's diagonal, scaled as its depth and height were.
  const k0 = kind?.size;
  const diagonal =
    kind?.diagonal && k0 ? kind.diagonal * (Math.hypot(d, h) / Math.hypot(k0.d, k0.h)) : undefined;
  const ways = carries(w, d, h, diagonal);
  // In the way of a turn: walls, their junctions, and built-in carpentry.
  const walls = [
    ...geom.pieces.map((q) => q.polygon),
    ...geom.footprints.hubs.map((hub) => hub.polygon),
    ...Object.values(level.items)
      .filter(
        (it) =>
          furnitureKind(it.assetId)?.carpentry &&
          furnitureLayer(furnitureKind(it.assetId)) === 'floor',
      )
      .map((it) => itemFootprint(it)),
  ];

  /** One door, entered from the side `k` (+1: from +n into -n). */
  const judge = (door: RouteDoor, k: number, into: string | null): DoorOnTheWay => {
    const clear = clearWidth(door.o);
    const height = door.o.height;
    // The space to turn in, on each side.
    const space = (side: number) =>
      rayToWall(
        {
          x: door.centre.x + door.n.x * door.half * side,
          y: door.centre.y + door.n.y * door.half * side,
        },
        { x: door.n.x * side, y: door.n.y * side },
        walls,
      );
    // Outside (no room that side): the common corridor.
    const sideRoom = (side: number) => (side > 0 ? door.sides[0] : door.sides[1]);
    const room = (side: number) => (sideRoom(side) ? space(side) : Math.min(CORRIDOR, space(side)));
    const before = room(k);
    const after = room(-k);
    const goes = (c: Carry, width: number) => {
      if (c.t > width || c.v > height) return false;
      // Movers tip a long piece up to get it round: its length in plan, tilted under the
      // ceiling as far as it goes.
      const lift = Math.max(0, level.ceilingHeight - c.v);
      const l = c.l > lift ? Math.sqrt(c.l * c.l - lift * lift) : c.v;
      const turns = (sp: number) => l <= sp || l <= turnLimit(width, sp, c.t);
      return turns(before) && turns(after);
    };
    const passing = ways.filter((c) => goes(c, clear));
    const centre = door.centre;
    if (passing.length) {
      const spare = Math.max(...passing.map((c) => clear - c.t));
      return {
        openingId: door.o.id,
        into,
        clear,
        height,
        centre,
        fit: spare >= SPARE ? 'fits' : 'tight',
      };
    }
    const style = door.o.kind === 'door' ? doorStyle(door.o) : null;
    if ((style === 'swing' || style === 'double') && ways.some((c) => goes(c, door.o.width))) {
      return { openingId: door.o.id, into, clear, height, centre, fit: 'hinges' };
    }
    // What it fails on: the narrowest carry that fits the height, else the turn.
    const upright = ways.filter((c) => c.v <= height);
    const need = upright.length ? Math.min(...upright.map((c) => c.t)) : Math.min(w, d, h);
    if (need <= clear) {
      return {
        openingId: door.o.id,
        into,
        clear,
        height,
        centre,
        fit: 'too-big',
        turn: { space: Math.min(before, after) },
      };
    }
    return { openingId: door.o.id, into, clear, height, centre, fit: 'too-big', need };
  };

  // The first door is the main door, from outside (or from whichever side is outside).
  const startInto = start.sides[0] ?? start.sides[1];
  if (!startInto) return { status: 'unreachable', from };
  const startK = start.sides[0] === startInto ? -1 : 1;
  const first = judge(start, startK, startInto);

  /** Fewest doors from the main door's room to the target, using doors `ok` lets through. */
  const search = (ok: (j: DoorOnTheWay) => boolean): DoorOnTheWay[] | null => {
    if (!ok(first)) return null;
    const judged = new Map<RouteDoor, DoorOnTheWay>();
    const prev = doorSearch(graph, startInto, {
      target,
      skip: start,
      pass: (door, from, into) => {
        const j = judge(door, door.sides[0] === from ? 1 : -1, into);
        judged.set(door, j);
        return ok(j);
      },
    });
    const route = routeTo(prev, target);
    if (!route) return null;
    return [first, ...route.map((r) => judged.get(r.door) as DoorOnTheWay)];
  };
  const route = search((j) => j.fit !== 'too-big') ?? search(() => true);
  if (!route) return { status: 'unreachable', from };

  // A lift door first, if given.
  if (opts.lift) {
    const { width, height } = opts.lift;
    const fits = ways.some((c) => c.t <= width && c.v <= height);
    route.unshift({
      openingId: 'lift',
      into: null,
      clear: width,
      height,
      centre: first.centre,
      fit: fits ? 'fits' : 'too-big',
      ...(fits ? {} : { need: Math.min(...ways.map((c) => c.t)) }),
    });
  }
  const order: Fit[] = ['fits', 'tight', 'hinges', 'too-big'];
  const worst = route.reduce<DoorOnTheWay | null>(
    (p, q) =>
      !p || order.indexOf(q.fit) > order.indexOf(p.fit) || (q.fit === p.fit && q.clear < p.clear)
        ? q
        : p,
    null,
  );
  return { status: worst?.fit ?? 'fits', from, doors: route, worst };
}

/** Pieces whose way in is worth checking: on the floor, not built in, not people or rugs. */
export function deliverable(assetId: string): boolean {
  const kind = furnitureKind(assetId);
  if (!kind || kind.carpentry || kind.walkThrough || kind.category === 'People') return false;
  return furnitureLayer(kind) === 'floor';
}
