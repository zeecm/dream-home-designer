import { furnitureKind, furnitureLayer, itemFootprint, itemSize } from './furniture';
import { pointInPolygon } from './geometry';
import { type PlanGeometry, doorStyle, framePoint, planGeometry } from './plan';
import { roomShapes } from './rooms';
import type { Level, Lift, LiftPreset, Opening, Vec2 } from './schema';
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
  /** It gets through only tilted on its diagonal (a sofa whose diagonal depth is known). */
  tilted?: boolean;
  centre: Vec2;
}

export type Delivery =
  | { status: 'no-room' }
  | { status: 'no-door' }
  | { status: 'unreachable'; from: string }
  | {
      status: Fit;
      from: string;
      /** The way in, in order: the lift door first (openingId 'lift') when a lift is given. */
      doors: DoorOnTheWay[];
      worst: DoorOnTheWay | null;
      /** How it goes in the lift, when a lift is given. */
      lift?: LiftFit;
    };

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

/**
 * One way to carry a piece through a door: `l` along the way, `t` across the door, `v` up.
 * `along` is which of the piece's width, depth and height (0, 1, 2) is `l`; `diagonal` marks
 * a sofa tilted on its diagonal.
 */
interface Carry {
  l: number;
  t: number;
  v: number;
  along: number;
  diagonal?: true;
}

/** Every way to carry a piece w × d × h through a door (and a sofa on its diagonal). */
function carries(w: number, d: number, h: number, diagonal?: number): Carry[] {
  const dims = [w, d, h];
  const out: Carry[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (j === i) continue;
      const k = 3 - i - j;
      out.push({ l: dims[i] as number, t: dims[j] as number, v: dims[k] as number, along: i });
    }
  }
  if (diagonal) out.push({ l: w, t: diagonal, v: Math.hypot(d, h), along: 0, diagonal: true });
  return out;
}

/** What a piece needs across a door it can't pass: its narrowest carry under the door's height. */
function needAcross(ways: Carry[], height: number, w: number, d: number, h: number): number {
  const upright = ways.filter((c) => c.v <= height);
  return upright.length ? Math.min(...upright.map((c) => c.t)) : Math.min(w, d, h);
}

/** Within this, a length fits (floating point, not a measurement). */
const EPS = 1e-9;

/**
 * Whether a p × q rectangle fits in an a × b one, turned at an angle if need be (Carver 1956):
 * square if p ≤ a and q ≤ b; otherwise, with p > a and q ≤ b, at an angle when
 * ((a + b)/(p + q))² + ((a − b)/(p − q))² ≥ 2. Either order of each pair.
 */
export function rectFits(p: number, q: number, a: number, b: number): boolean {
  return rectFit(p, q, a, b) !== null;
}

/** As rectFits: the smallest slack of the best square fit, 0 at an angle, null if it doesn't. */
function rectFit(p0: number, q0: number, a0: number, b0: number): number | null {
  const [p, q] = p0 >= q0 ? [p0, q0] : [q0, p0];
  const [a, b] = a0 >= b0 ? [a0, b0] : [b0, a0];
  if (p <= a + EPS && q <= b + EPS) {
    const square = Math.min(a - p, b - q);
    return p <= b + EPS ? Math.max(square, Math.min(b - p, a - q)) : square;
  }
  if (q > b + EPS || p - q < EPS) return null;
  const k = ((a + b) / (p + q)) ** 2 + ((a - b) / (p - q)) ** 2;
  return k >= 2 - EPS ? 0 : null;
}

/** The typical lifts to choose from (spec: docs/specs/slice-2s.md, B1). */
export const LIFT_PRESETS: Record<Exclude<LiftPreset, 'measured'>, Lift> = {
  // ISO 4190-1's 8-person (630 kg) car; BCA's 900 mm minimum clear lift door.
  typical: {
    preset: 'typical',
    door: { width: 0.9, height: 2.0 },
    car: { width: 1.1, depth: 1.4, height: 2.3 },
  },
  // ISO 4190-1's 6-person (450 kg) car.
  older: {
    preset: 'older',
    door: { width: 0.8, height: 2.0 },
    car: { width: 1.0, depth: 1.25, height: 2.2 },
  },
  // ISO 4190-1's 1000 kg bed or stretcher car.
  large: {
    preset: 'large',
    door: { width: 0.9, height: 2.1 },
    car: { width: 1.1, depth: 2.1, height: 2.3 },
  },
};

/** How a piece stands in the lift car: as it stands, on its back, on end, or tilted. */
export type LiftPose = 'upright' | 'back' | 'end' | 'tilted';

export interface LiftFit {
  fit: 'fits' | 'tight' | 'too-big';
  /** How it goes in (when it does). */
  how?: LiftPose;
  /** What stops it: the lift door, or the car. */
  fails?: 'door' | 'car';
  /** At the door: the width it needs on its narrowest carry. */
  need?: number;
  /** The smallest slack, at the door or in the car (negative at a door it doesn't pass). */
  spare: number;
  /** It gets through the lift door only tilted on its diagonal. */
  tilted?: boolean;
  /**
   * In the car it would fit only stood up, and it's too long to stand up as it comes in
   * through the door: its length, and the longest the door and the car's depth allow.
   */
  standUp?: { need: number; allows: number };
}

/**
 * Whether a piece w × d × h (and a sofa's diagonal) goes in a lift, rigid: through the door's
 * cross-section (no turn: the lobby is open), then standing in the car one of four ways. A
 * pose taller than the door comes in lying along its carry and is stood up in the car,
 * turning in the plane of the door, so its length must be within `turnLimit` of the door's
 * height, the car's depth and the carry's thickness.
 */
export function liftFit(
  size: { w: number; d: number; h: number },
  diagonal: number | undefined,
  lift: Lift,
): LiftFit {
  const { w, d, h } = size;
  const dims = [w, d, h];
  const { width: dw, height: dh } = lift.door;
  const { width: cw, depth: cd, height: ch } = lift.car;
  const ways = carries(w, d, h, diagonal);
  const through = ways.filter((c) => c.t <= dw + EPS && c.v <= dh + EPS);
  if (!through.length) {
    const need = needAcross(ways, dh, w, d, h);
    return { fit: 'too-big', fails: 'door', need, spare: dw - need };
  }

  // The poses that fit the car alone: which dimension is up, and the car's slack.
  const poses: { how: LiftPose; up: number; tall: boolean; spare: number }[] = [];
  const standing: [LiftPose, number][] = [
    ['upright', 2],
    ['back', 1],
    ['end', 0],
  ];
  for (const [how, up] of standing) {
    const z = dims[up] as number;
    const [p, q] = dims.filter((_, i) => i !== up) as [number, number];
    const floor = z <= ch + EPS ? rectFit(p, q, cw, cd) : null;
    if (floor !== null) poses.push({ how, up, tall: z > dh + EPS, spare: Math.min(ch - z, floor) });
  }
  // Tilted: one dimension across the car, the other two at an angle in the plane it leaves.
  for (let c = 0; c < 3; c++) {
    const across = dims[c] as number;
    const rest = [0, 1, 2].filter((i) => i !== c) as [number, number];
    const [ip, iq] =
      (dims[rest[0]] as number) >= (dims[rest[1]] as number) ? rest : [rest[1], rest[0]];
    const p = dims[ip] as number;
    const q = dims[iq] as number;
    for (const [a, b] of [
      [cw, cd],
      [cd, cw],
    ] as const) {
      // Square in that plane is one of the standing poses; only an angle adds a way.
      if (across <= a + EPS && p > Math.max(b, ch) + EPS && rectFit(p, q, b, ch) !== null) {
        poses.push({ how: 'tilted', up: ip, tall: true, spare: 0 });
        break;
      }
    }
  }

  // Through the door into each pose; a tall one is stood up as it comes in.
  const passed: { how: LiftPose; spare: number; tilted: boolean }[] = [];
  let standUp: LiftFit['standUp'];
  for (const pose of poses) {
    let ok = through;
    if (pose.tall) {
      const lying = through.filter((c) => c.along === pose.up);
      ok = lying.filter((c) => c.l <= turnLimit(dh, cd, c.v) + EPS);
      if (!ok.length && lying.length) {
        const allows = Math.max(...lying.map((c) => turnLimit(dh, cd, c.v)));
        if (!standUp || allows > standUp.allows) {
          standUp = { need: dims[pose.up] as number, allows };
        }
      }
    }
    if (!ok.length) continue;
    const door = Math.max(...ok.map((c) => dw - c.t));
    passed.push({
      how: pose.how,
      spare: Math.min(door, pose.spare),
      tilted: ok.every((c) => c.diagonal),
    });
  }
  const best = passed.find((p) => p.spare >= SPARE) ?? passed[0];
  if (!best) return { fit: 'too-big', fails: 'car', spare: 0, ...(standUp ? { standUp } : {}) };
  return {
    fit: best.spare >= SPARE ? 'fits' : 'tight',
    how: best.how,
    spare: best.spare,
    ...(best.tilted ? { tilted: true } : {}),
  };
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
  opts: { from?: string; lift?: Lift } = {},
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
        ...(passing.every((c) => c.diagonal) ? { tilted: true } : {}),
      };
    }
    const style = door.o.kind === 'door' ? doorStyle(door.o) : null;
    if ((style === 'swing' || style === 'double') && ways.some((c) => goes(c, door.o.width))) {
      return { openingId: door.o.id, into, clear, height, centre, fit: 'hinges' };
    }
    // What it fails on: the narrowest carry that fits the height, else the turn.
    const need = needAcross(ways, height, w, d, h);
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

  // The lift first, if given: its door, and its car.
  const lift = opts.lift ? liftFit({ w, d, h }, diagonal, opts.lift) : undefined;
  if (opts.lift && lift) {
    route.unshift({
      openingId: 'lift',
      into: null,
      clear: opts.lift.door.width,
      height: opts.lift.door.height,
      centre: first.centre,
      fit: lift.fit,
      ...(lift.need !== undefined ? { need: lift.need } : {}),
      ...(lift.tilted ? { tilted: true } : {}),
    });
  }
  const worst = worstDoor(route);
  return { status: worst?.fit ?? 'fits', from, doors: route, worst, ...(lift ? { lift } : {}) };
}

/** The worst door on a way in: the worst fit, then the narrowest (null for none). */
export function worstDoor(doors: DoorOnTheWay[]): DoorOnTheWay | null {
  const order: Fit[] = ['fits', 'tight', 'hinges', 'too-big'];
  return doors.reduce<DoorOnTheWay | null>(
    (p, q) =>
      !p || order.indexOf(q.fit) > order.indexOf(p.fit) || (q.fit === p.fit && q.clear < p.clear)
        ? q
        : p,
    null,
  );
}

/** Pieces whose way in is worth checking: on the floor, not built in, not people or rugs. */
export function deliverable(assetId: string): boolean {
  const kind = furnitureKind(assetId);
  if (!kind || kind.carpentry || kind.walkThrough || kind.category === 'People') return false;
  return furnitureLayer(kind) === 'floor';
}

/**
 * The check treats every piece as rigid. A bed isn't quite: said beside a "too big" for one.
 */
export function rigidNote(assetId: string): string | null {
  return assetId.startsWith('bed-') || furnitureKind(assetId)?.shape === 'bed'
    ? 'A mattress bends and a frame usually comes flat; ask the shop.'
    : null;
}
