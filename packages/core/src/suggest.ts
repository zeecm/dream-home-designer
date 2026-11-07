import { DINING_TABLES, doorSweep, touchingRuns } from './clearance';
import { clipHalf, nearestOnEdge, roomOff, sideOf } from './convex';
import type { Rate, Rates } from './cost';
import { type DoorGraph, type RoomEntry, type RouteDoor, roomEntries } from './delivery';
import {
  ELEC_KINDS,
  JAMB_CLEAR,
  LEDGE_ROOM,
  type NewPoint,
  WET_ROOM,
  clearAlong,
  isSocket,
  latchEnd,
  pointPosition,
} from './electrical';
import { furnitureKind, furnitureLayer, itemFootprint, itemSize } from './furniture';
import { placeLabel, pointInPolygon } from './geometry';
import type { Command } from './history';
import { newId } from './ids';
import { draftLevel } from './levels';
import { type PlanGeometry, type WallFrame, framePoint, planGeometry } from './plan';
import { roomShapes } from './rooms';
import {
  type ElecKind,
  ElecPoint,
  type Item,
  type Level,
  type Vec2,
  isBoundary,
  isGlass,
} from './schema';
import { SHELTER_ROOM, wallStatuses } from './structural';

/**
 * Suggested electrical points: the usual points for each room of a flat, placed by its
 * furniture, for the person to keep or leave out before any is added. Advice, as an
 * electrician's first pass would be. Spec: docs/specs/slice-2s.md (A).
 */

/** What a room is for, as its points go: from its name. */
export type RoomKind = 'none' | 'bathroom' | 'kitchen' | 'bedroom' | 'living' | 'study' | 'other';

/** Outdoor rooms and the shelter: no points of their own. */
const NO_POINTS = /balcony|planter|outside/i;

/** A room's kind from its name, first match wins (a "Master bathroom" is a bathroom). */
export function roomKind(name: string): RoomKind {
  if (SHELTER_ROOM.test(name) || LEDGE_ROOM.test(name) || NO_POINTS.test(name)) return 'none';
  if (WET_ROOM.test(name)) return 'bathroom';
  if (/kitchen|pantry/i.test(name)) return 'kitchen';
  if (/bed|master|guest/i.test(name)) return 'bedroom';
  if (/living|family|lounge|hall/i.test(name)) return 'living';
  if (/study|office/i.test(name)) return 'study';
  return 'other';
}

export type SuggestRule =
  | 'switch'
  | 'bedside'
  | 'desk'
  | 'fridge'
  | 'counter'
  | 'hood'
  | 'cooker'
  | 'tv-wall'
  | 'aircon'
  | 'dresser'
  | 'water-heater'
  | 'light'
  | 'table-light'
  | 'compressor';

/** Each rule's point named for a list ("bedside socket", "2 bedside sockets"). */
export const RULE_NAMES: Record<SuggestRule, [string, string]> = {
  switch: ['switch', 'switches'],
  bedside: ['bedside socket', 'bedside sockets'],
  desk: ['desk socket', 'desk sockets'],
  fridge: ['fridge socket', 'fridge sockets'],
  counter: ['counter socket', 'counter sockets'],
  hood: ['hood socket', 'hood sockets'],
  cooker: ['cooker point', 'cooker points'],
  'tv-wall': ['TV wall point', 'TV wall points'],
  aircon: ['aircon', 'aircons'],
  dresser: ['desk or dresser socket', 'desk or dresser sockets'],
  'water-heater': ['water heater', 'water heaters'],
  light: ['light', 'lights'],
  'table-light': ['table light', 'table lights'],
  compressor: ['compressor', 'compressors'],
};

/** A suggested point, not yet on the plan. */
export interface Suggestion {
  /** Stable while the plan changes: the room, the rule and what the point hangs on. */
  key: string;
  roomId: string;
  rule: SuggestRule;
  point: NewPoint;
  /** Why it is there, for a tooltip. */
  why: string;
  /** Where it is, in a few words ("Bedside, left"). */
  where: string;
}

export interface SuggestNote {
  roomId: string;
  text: string;
}

export interface Suggestions {
  points: Suggestion[];
  notes: SuggestNote[];
  /** Rooms with a point or a note, in plan order (top to bottom, then left to right). */
  rooms: string[];
}

export const SUGGEST_NOTES = {
  counter: 'Draw the counter (Built-in ▸ Kitchen base run) to get counter sockets.',
  bed: 'The bed isn’t against a wall, so there are no bedside sockets.',
  aircon: 'No wall has 0.9 m clear for an aircon unit.',
  name: 'Name the room (Bedroom, Kitchen…) for more than a light and a switch.',
  switch: 'No wall for a switch by this door.',
  hob: 'Add a hob cabinet for hood and cooker points.',
  door: 'No door to put a switch by.',
  trunking: 'Once added, run the aircon’s trunking to the compressor (Run trunking).',
} as const;

/** What a room's suggested points on structural walls are, for a muted note. */
export const structuralNote = (what: string[]) =>
  `${what.join(', ')} ${what.length === 1 ? 'is' : 'are'} on a structural wall: ask your contractor.`;

/** A point that had no clear spot (a window, a door or another point in the way). */
export const noRoomFor = (what: string) =>
  `No clear wall for the ${what}: a window, door or another point is in the way.`;

const WHY = {
  light: 'Ceiling light.',
  table: 'Light over the dining table.',
  switch: 'Switch by the door, on the handle side.',
  bathSwitch: 'Bathroom switch outside the door: no switches in a wet room.',
  heater: 'Water heater point, above the shower.',
  bedside: 'Bedside socket, above the bedside table.',
  desk: 'Desk socket, above the desk top.',
  dresser: 'Socket for a desk or dresser.',
  airconBed: 'Aircon over the bed head: it blows over you, not onto you.',
  airconLedge: 'Aircon on the wall nearest the ledge: shortest trunking.',
  aircon: 'Aircon high on the wall, clear of windows and doors.',
  counter: 'Counter socket, above the backsplash.',
  hood: 'Hood socket, hidden by the hood’s chimney.',
  cooker: 'Hob point, in the cabinet under the hob. Leave it out for a gas hob.',
  fridge: 'Fridge socket, behind it.',
  tv: 'TV wall: sockets, TV and data behind the console.',
  compressor: 'Compressor on the air-con ledge.',
} as const;

/** How close a piece's back is to a wall to be against it. */
const AGAINST = 0.15;
/** A bed side this close to a wall has no room for a bedside table. */
const SIDE_OPEN = 0.1;
/** Bedside socket centres, beyond the bed's side. */
const BEDSIDE_OUT = 0.25;
/** The switch plate's edge from the door opening. */
const SWITCH_OFF = 0.15;
/** Counter sockets: one double socket about every this far. */
const COUNTER_EVERY = 1.2;
/** No counter socket's plate within this of a sink's centre (a 0.5 m bowl plus 300 mm). */
const SINK_CLEAR = 0.55;
/** Nor over the hob, nor within this of it. */
const HOB_CLEAR = 0.15;
/** Furthest a point tied to a piece moves to find a clear spot. */
const NUDGE = 0.3;
/** A switch keeps to its spot by the door: any further, it goes the other side. */
const SWITCH_NUDGE = 0.05;
/** An aircon unit throws its air across at least this much room, where a wall has it. */
const AIRCON_THROW = 2;
/** A TV wall at least this long, where there is one. */
const TV_WALL = 2.4;
/** A point counts as already there this close along the same face, and in height. */
const THERE_ALONG = 0.4;
const THERE_HEIGHT = 0.3;
/** An aircon unit needs this much clear wall. */
const AIRCON_CLEAR = 0.9;
/** A sofa looks at a wall at most this far away. */
const SOFA_REACH = 6;
/** A plate this deep off a face is behind a piece or an open door leaf. */
const BEHIND = 0.15;

const BEDSIDE_HEIGHT = 0.7;
const DESK_HEIGHT = 0.9;
const LOW = 0.3;
const SWITCH_HEIGHT = 1.05;
const COUNTER_HEIGHT = 1.15;
const HOOD_HEIGHT = 2.1;
const COOKER_HEIGHT = 0.6;
const HEATER_HEIGHT = 2.0;

/** A room's light sits this far up from its label point, clear of the name. */
const LIGHT_OFF_LABEL = 0.55;
/** And this far from its walls. */
const LIGHT_WALL_CLEAR = 0.3;
/** The adjacent wall's switch: its plate edge this far round the corner past the latch jamb. */
const CORNER_OFF = 0.1;

const TV_PIECES = new Set(['tv-console', 'built-in-tv-console', 'tv-console-slatted', 'tv']);
const DESKS = new Set(['desk', 'metal-desk']);
const isBed = (it: Item) =>
  it.assetId.startsWith('bed-') || furnitureKind(it.assetId)?.shape === 'bed';
const isSofa = (it: Item) =>
  /(^|-)sofa(-|$)/.test(it.assetId) || furnitureKind(it.assetId)?.shape === 'sofa';

/** A wall face as it looks into a room. */
interface Face {
  key: string;
  wallId: string;
  side: 'left' | 'right';
  roomId: string;
  f: WallFrame;
  /** +1 for the left face, -1 for the right. */
  k: 1 | -1;
  /** Into the room. */
  n: Vec2;
  /** Where the face runs along the wall (between its inside corners). */
  lo: number;
  hi: number;
  shelter: boolean;
  structural: boolean;
}

interface RoomInfo {
  id: string;
  name: string;
  kind: RoomKind;
  outer: Vec2[];
  holes: Vec2[][];
  label: Vec2;
  faces: Face[];
  items: Item[];
}

const sortById = <T extends { id: string }>(xs: T[]) =>
  xs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** A point's plate, bottom to top, at its height (an aircon unit's height is its top). */
function span(kind: ElecKind, height: number): [number, number] {
  const h = ELEC_KINDS[kind].plate.h;
  return kind === 'aircon' ? [height - h, height] : [height - h / 2, height + h / 2];
}

const cache = new WeakMap<Level, { statusOf: Level; out: Suggestions }>();

/**
 * The usual points for every room of `level`, placed by its furniture, and notes on what
 * couldn't be suggested. Nothing already there is suggested again, so adding them all and
 * asking again gives none. Structural walls are judged on `statusOf`, the flat as it is.
 * Each point is clear of openings, corners and the other points (those suggested too).
 */
export function suggestPoints(level: Level, opts: { statusOf?: Level } = {}): Suggestions {
  const statusOf = opts.statusOf ?? level;
  const hit = cache.get(level);
  if (hit && hit.statusOf === statusOf) return hit.out;
  const out = new Suggester(level, statusOf).run();
  if (Object.isFrozen(level)) cache.set(level, { statusOf, out });
  return out;
}

/** What suggested points add to the estimate: each a new point at the viewer's rates. */
export function suggestionCost(points: readonly { point: NewPoint }[], rates: Rates): Rate {
  let low = 0;
  let high = 0;
  for (const { point } of points) {
    if (point.kind === 'compressor') continue;
    low += rates.elecNew[point.kind].low;
    high += rates.elecNew[point.kind].high;
  }
  return { low, high };
}

/**
 * Adds points in one undo step (`label`, "Add 6 points to Main bedroom"). The ids are made
 * here, outside the recipe; every point is checked first, and a point on a wall that's gone
 * stops the whole batch.
 */
export function addPoints(
  levelId: string,
  points: readonly NewPoint[],
  label = `Add ${points.length} ${points.length === 1 ? 'point' : 'points'}`,
): { command: Command; ids: string[] } {
  const ids = points.map(() => newId('pt'));
  const values = points.map((p, i) => ElecPoint.parse({ ...p, id: ids[i] }));
  return {
    ids,
    command: {
      label,
      recipe: (d) => {
        const lvl = draftLevel(d, levelId);
        lvl.points ??= {};
        for (const v of values) {
          if (v.wall && !lvl.walls[v.wall.wallId])
            throw new Error(`wall ${v.wall.wallId} not found`);
          lvl.points[v.id] = structuredClone(v);
        }
      },
    },
  };
}

type Stage = 0 | 1 | 2 | 3 | 4;

class Suggester {
  private geom: PlanGeometry;
  private rooms: RoomInfo[];
  private byId = new Map<string, RoomInfo>();
  private faces = new Map<string, Face>();
  private solid: Vec2[][];
  private sweeps: { id: string; poly: Vec2[] }[];
  private existing: ElecPoint[];
  private batch: ElecPoint[] = [];
  private out: (Suggestion & { stage: Stage; n: number })[] = [];
  private notes: SuggestNote[] = [];
  private graph: DoorGraph | null = null;
  private shapes: ReturnType<typeof roomShapes>;

  constructor(
    private level: Level,
    statusOf: Level,
  ) {
    this.geom = planGeometry(level);
    this.shapes = roomShapes(level);
    const statuses = wallStatuses(statusOf);
    const ownStatuses = statusOf === level ? statuses : wallStatuses(level);
    const status = (id: string) => (statusOf.walls[id] ? statuses.get(id) : ownStatuses.get(id));
    this.solid = [
      ...this.geom.pieces.map((p) => p.polygon),
      ...this.geom.footprints.hubs.map((h) => h.polygon),
    ];
    this.sweeps = sortById(Object.values(level.openings).filter((o) => o.kind === 'door')).flatMap(
      (o) => doorSweep(level, o.id, this.geom.frames).map((poly) => ({ id: o.id, poly })),
    );
    const items = sortById(Object.values(level.items));
    this.rooms = sortById(Object.values(level.rooms)).flatMap((r) => {
      const s = this.shapes.get(r.id);
      if (!s) return [];
      const info: RoomInfo = {
        id: r.id,
        name: r.name,
        kind: roomKind(r.name),
        outer: s.outer,
        holes: s.holes,
        label: placeLabel(s.outer, { x: 0.05, y: 0.05 }, [], s.holes),
        faces: [],
        items: [],
      };
      return [info];
    });
    for (const r of this.rooms) this.byId.set(r.id, r);
    for (const it of items) {
      const r = this.roomAt({ x: it.position.x, y: it.position.z });
      if (r) this.byId.get(r)?.items.push(it);
    }
    for (const wall of sortById(Object.values(level.walls))) {
      if (isBoundary(wall) || isGlass(wall)) continue;
      const f = this.geom.frames[wall.id];
      if (!f) continue;
      for (const k of [1, -1] as const) {
        const sp = k === 1 ? f.left : f.right;
        const lo = Math.max(0, sp[0]);
        const hi = Math.min(f.length, sp[1]);
        if (hi - lo < 0.05) continue;
        const n = { x: f.n.x * k, y: f.n.y * k };
        const mid = framePoint(f, (lo + hi) / 2, k);
        const roomId = this.roomAt({ x: mid.x + n.x * 0.05, y: mid.y + n.y * 0.05 });
        const room = roomId && this.byId.get(roomId);
        if (!room) continue;
        const st = status(wall.id);
        const side = k === 1 ? 'left' : 'right';
        const face: Face = {
          key: `${wall.id}:${side}`,
          wallId: wall.id,
          side,
          roomId: room.id,
          f,
          k,
          n,
          lo,
          hi,
          shelter: st === 'shelter',
          structural: st === 'structural' || st === 'likely',
        };
        room.faces.push(face);
        this.faces.set(face.key, face);
      }
    }
    this.existing = sortById(Object.values(level.points ?? {}));
  }

  private roomAt(p: Vec2): string | null {
    for (const r of this.rooms) {
      if (pointInPolygon(p, r.outer) && !r.holes.some((h) => pointInPolygon(p, h))) return r.id;
    }
    return null;
  }

  /** The room a point serves (its face's, or the one it's in). */
  private roomOfPoint(p: ElecPoint): string | null {
    const pos = pointPosition(this.level, p);
    if (!pos) return null;
    const n = pos.normal ?? { x: 0, y: 0 };
    return this.roomAt({ x: pos.at.x + n.x * 0.05, y: pos.at.y + n.y * 0.05 });
  }

  // ---------------------------------------------------------------- face geometry

  private u(face: Face, p: Vec2): number {
    return (p.x - face.f.a.x) * face.f.d.x + (p.y - face.f.a.y) * face.f.d.y;
  }

  /** How far a point is off a face, into the room. */
  private v(face: Face, p: Vec2): number {
    const o = framePoint(face.f, 0, face.k);
    return (p.x - o.x) * face.n.x + (p.y - o.y) * face.n.y;
  }

  /** Where along a face a shape is, within `depth` of it (null if it isn't). */
  private onFace(face: Face, poly: Vec2[], depth: number): [number, number] | null {
    let c = clipHalf(poly, (p) => this.v(face, p) + 0.02);
    c = clipHalf(c, (p) => depth - this.v(face, p));
    if (c.length < 3) return null;
    const us = c.map((p) => this.u(face, p));
    const s0 = Math.max(face.lo, Math.min(...us));
    const s1 = Math.min(face.hi, Math.max(...us));
    return s1 > s0 ? [s0, s1] : null;
  }

  /** The face a piece's back is against (within AGAINST), and where its back runs along it. */
  private backFace(
    room: RoomInfo,
    it: Item,
  ): { face: Face; u0: number; u1: number; uc: number } | null {
    const [bl, br, , fl] = itemFootprint(it) as [Vec2, Vec2, Vec2, Vec2];
    const back = { x: (bl.x + br.x) / 2, y: (bl.y + br.y) / 2 };
    const dl = Math.hypot(fl.x - bl.x, fl.y - bl.y) || 1;
    const front = { x: (fl.x - bl.x) / dl, y: (fl.y - bl.y) / dl };
    let best: { face: Face; d: number } | null = null;
    for (const face of room.faces) {
      if (face.n.x * front.x + face.n.y * front.y < 0.9) continue;
      const d = this.v(face, back);
      const u = this.u(face, back);
      if (d < -0.05 || d > AGAINST || u < face.lo || u > face.hi) continue;
      if (!best || d < best.d) best = { face, d };
    }
    if (!best) return null;
    const a = this.u(best.face, bl);
    const b = this.u(best.face, br);
    return { face: best.face, u0: Math.min(a, b), u1: Math.max(a, b), uc: this.u(best.face, back) };
  }

  /** Stretches of a face a point at `height` must keep off: open door leaves, tall pieces. */
  private blockedOn(
    face: Face,
    kind: ElecKind,
    height: number,
    more: Item[] = [],
    /** A door whose own leaf doesn't count (a switch round the corner from its latch). */
    besides?: string,
  ): [number, number][] {
    const [bottom] = span(kind, height);
    const out: [number, number][] = [];
    if (bottom < 2.0) {
      for (const sw of this.sweeps) {
        if (sw.id === besides) continue;
        const s = this.onFace(face, sw.poly, BEHIND);
        if (s) out.push(s);
      }
    }
    const room = this.byId.get(face.roomId);
    for (const it of room?.items ?? []) {
      const kind = furnitureKind(it.assetId);
      if (!kind || furnitureLayer(kind) !== 'floor' || kind.walkThrough) continue;
      const top = it.position.y + itemSize(it, kind).h;
      const tall =
        kind.carpentry === 'wardrobe' ||
        kind.carpentry === 'tall' ||
        (top >= 1.4 && it.assetId !== 'fridge') ||
        more.includes(it);
      if (!tall || bottom >= top) continue;
      const s = this.onFace(face, itemFootprint(it, kind), BEHIND);
      if (s) out.push(s);
    }
    return out;
  }

  /** The clear stretches of a face for a point at `height`: off openings and `blocked`. */
  private stretches(
    face: Face,
    kind: ElecKind,
    height: number,
    blocked: [number, number][],
  ): [number, number][] {
    const [bottom, top] = span(kind, height);
    const cuts: [number, number][] = [...blocked];
    for (const o of Object.values(this.level.openings)) {
      if (o.wallId !== face.wallId) continue;
      const sill = o.kind === 'window' ? o.sill : 0;
      if (!(top > sill + 1e-9 && bottom < sill + o.height - 1e-9)) continue;
      const c = o.t * face.f.length;
      cuts.push([c - o.width / 2 - JAMB_CLEAR, c + o.width / 2 + JAMB_CLEAR]);
    }
    cuts.sort((a, b) => a[0] - b[0]);
    const out: [number, number][] = [];
    let at = face.lo;
    for (const [s0, s1] of cuts) {
      if (s0 > at) out.push([at, Math.min(s0, face.hi)]);
      at = Math.max(at, s1);
      if (at >= face.hi) break;
    }
    if (at < face.hi) out.push([at, face.hi]);
    const w = ELEC_KINDS[kind].plate.w;
    return out.filter(([a, b]) => b - a >= w - 1e-9);
  }

  /** The longest clear stretch of a face (ties: the first). */
  private longest(face: Face, kind: ElecKind, height: number, blocked: [number, number][]) {
    let best: [number, number] | null = null;
    for (const s of this.stretches(face, kind, height, blocked)) {
      if (!best || s[1] - s[0] > best[1] - best[0] + 1e-9) best = s;
    }
    return best;
  }

  /** A point on a face, `u` along its wall. */
  private at(face: Face, u: number): Vec2 {
    return framePoint(face.f, u, face.k);
  }

  /** A stretch of one face as another face (on the same line) measures it. */
  private toFace(from: Face, to: Face, [a, b]: readonly [number, number]): [number, number] {
    const ua = this.u(to, this.at(from, a));
    const ub = this.u(to, this.at(from, b));
    return [Math.min(ua, ub), Math.max(ua, ub)];
  }

  private lines = new Map<Face, Face[]>();

  /**
   * The faces of a room on the same straight line as `face`, facing the same way, `face`
   * first: walls drawn as several records in a row are one wall to put a point on.
   */
  private line(face: Face): Face[] {
    const hit = this.lines.get(face);
    if (hit) return hit;
    const room = this.byId.get(face.roomId);
    const rest = (room?.faces ?? [])
      .filter(
        (g) =>
          g !== face &&
          g.n.x * face.n.x + g.n.y * face.n.y > 0.999 &&
          Math.abs(this.v(face, this.at(g, (g.lo + g.hi) / 2))) < 0.005,
      )
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    const out = [face, ...rest];
    this.lines.set(face, out);
    return out;
  }

  /** The face that stands for its line (the first by key). */
  private head(face: Face): Face {
    return [...this.line(face)].sort((a, b) => (a.key < b.key ? -1 : 1))[0] as Face;
  }

  /** The clear stretches of a face's whole line, measured on `face`, joined where they meet. */
  private runStretches(
    face: Face,
    kind: ElecKind,
    height: number,
    blocked: (g: Face) => [number, number][],
  ): [number, number][] {
    const all = this.line(face)
      .flatMap((g) =>
        this.stretches(g, kind, height, blocked(g)).map((s) => this.toFace(g, face, s)),
      )
      .sort((a, b) => a[0] - b[0]);
    const out: [number, number][] = [];
    for (const s of all) {
      const last = out.at(-1);
      if (last && s[0] <= last[1] + 0.01) last[1] = Math.max(last[1], s[1]);
      else out.push([s[0], s[1]]);
    }
    return out;
  }

  /** The longest clear stretch of a face's line (ties: the first). */
  private longestRun(
    face: Face,
    kind: ElecKind,
    height: number,
    blocked: (g: Face) => [number, number][] = (g) => this.blockedOn(g, kind, height),
  ): [number, number] | null {
    let best: [number, number] | null = null;
    for (const s of this.runStretches(face, kind, height, blocked)) {
      if (!best || s[1] - s[0] > best[1] - best[0] + 1e-9) best = s;
    }
    return best;
  }

  /** The doors and passages on a face's wall, as stretches to keep off. */
  private doorways(face: Face): [number, number][] {
    return Object.values(this.level.openings)
      .filter((o) => o.wallId === face.wallId && o.kind !== 'window')
      .map((o) => {
        const c = o.t * face.f.length;
        return [c - o.width / 2 - JAMB_CLEAR, c + o.width / 2 + JAMB_CLEAR];
      });
  }

  /** How far a ray from `p` runs before it meets a wall, or leaves `room` (at most 10 m). */
  private ray(p: Vec2, dir: Vec2, room?: RoomInfo): number {
    let best = 10;
    for (const poly of [...this.solid, ...(room ? [room.outer, ...room.holes] : [])]) {
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i] as Vec2;
        const b = poly[(i + 1) % poly.length] as Vec2;
        const ex = b.x - a.x;
        const ey = b.y - a.y;
        const den = dir.x * ey - dir.y * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((a.x - p.x) * ey - (a.y - p.y) * ex) / den;
        const s = ((a.x - p.x) * dir.y - (a.y - p.y) * dir.x) / den;
        if (t > 0.02 && s >= 0 && s <= 1) best = Math.min(best, t);
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- adding

  private positions = new Map<ElecPoint, ReturnType<typeof pointPosition>>();

  /** Where a point is (kept: points don't change while suggesting). */
  private posOf(p: ElecPoint) {
    if (!this.positions.has(p)) this.positions.set(p, pointPosition(this.level, p));
    return this.positions.get(p) ?? null;
  }

  /** Where along `face` a wall point is, if it is on the face's line, facing the same way. */
  private alongOf(face: Face, q: ElecPoint): number | null {
    if (!q.wall) return null;
    const pos = this.posOf(q);
    if (!pos?.normal || pos.normal.x * face.n.x + pos.normal.y * face.n.y < 0.999) return null;
    if (Math.abs(this.v(face, pos.at)) > 0.01) return null;
    return this.u(face, pos.at);
  }

  /** Whether a point like this one is on this face's line near here already (or suggested). */
  private there(kind: ElecKind, face: Face, along: number, height: number): boolean {
    return [...this.existing, ...this.batch].some((q) => {
      if (!q.wall || (isSocket(kind) ? !isSocket(q.kind) : q.kind !== kind)) return false;
      if (Math.abs(q.wall.height - height) > THERE_HEIGHT + 1e-9) return false;
      const qa = this.alongOf(face, q);
      return qa !== null && Math.abs(qa - along) <= THERE_ALONG + 1e-9;
    });
  }

  /**
   * A wall point as near `along` on `face` as it can go (no further than `limit`), clear of
   * openings, the other points and what `blocked` keeps it off on each face; on the face, or
   * on the next wall record of its line (a wall drawn in pieces). Null where there's no room.
   */
  private onWall(
    kind: ElecKind,
    face: Face,
    along: number,
    height: number,
    limit: number,
    blocked: (g: Face) => [number, number][] = (g) => this.blockedOn(g, kind, height),
  ): NewPoint | null {
    if (face.shelter) return null;
    const want = this.at(face, along);
    let best: { p: NewPoint; d: number } | null = null;
    for (const g of this.line(face)) {
      if (g.shelter) continue;
      const a = this.u(g, want);
      if (a < g.lo - limit - 0.2 || a > g.hi + limit + 0.2) continue;
      const u = clearAlong(
        this.level,
        this.geom,
        kind,
        { wallId: g.wallId, along: a, side: g.side },
        height,
        undefined,
        { extra: this.batch, blocked: blocked(g) },
      );
      if (u === null) continue;
      const d = Math.abs(u - a);
      if (d > limit + 1e-9 || (best && d >= best.d - 1e-9)) continue;
      // Still facing this room (a long wall may run past it).
      const at = this.at(g, u);
      if (this.roomAt({ x: at.x + g.n.x * 0.05, y: at.y + g.n.y * 0.05 }) !== g.roomId) continue;
      const t = Math.min(1, Math.max(0, u / g.f.length));
      best = { p: { kind, wall: { wallId: g.wallId, t, side: g.side, height } }, d };
    }
    return best?.p ?? null;
  }

  private add(
    stage: Stage,
    roomId: string,
    rule: SuggestRule,
    key: string,
    point: NewPoint,
    why: string,
    where: string,
  ) {
    this.out.push({
      key: `${roomId}:${key}`,
      roomId,
      rule,
      point,
      why,
      where,
      stage,
      n: this.out.length,
    });
    this.batch.push(ElecPoint.parse({ ...point, id: `suggested_${this.batch.length}` }));
  }

  private note(roomId: string, text: string) {
    if (!this.notes.some((n) => n.roomId === roomId && n.text === text))
      this.notes.push({ roomId, text });
  }

  /** Points already in a room (wall points by the room they face). */
  private inRoom(roomId: string, kinds: ElecKind[]): ElecPoint[] {
    return this.existing.filter((p) => kinds.includes(p.kind) && this.roomOfPoint(p) === roomId);
  }

  // ---------------------------------------------------------------- the rules

  run(): Suggestions {
    const live = this.rooms.filter((r) => r.kind !== 'none');
    const lights = new Map(live.map((r) => [r.id, this.lightsFor(r)]));
    const entries = this.entryDoors();
    // Switches first, then sockets tied to furniture, aircon units, the desk-or-dresser
    // socket, and lights and the compressor last: the stiffest get first pick.
    // A bathroom's switch must go outside its door: it picks first.
    const baths = live.filter((r) => r.kind === 'bathroom');
    for (const r of [...baths, ...live.filter((r) => r.kind !== 'bathroom')])
      this.switchesFor(r, entries, lights);
    const bedHeads = new Map<string, Set<string>>();
    const tvWalls = new Map<string, string>();
    for (const r of live) {
      if (r.kind === 'bedroom') bedHeads.set(r.id, this.bedside(r));
      if (r.kind === 'bedroom' || r.kind === 'study') this.desks(r);
      if (r.kind === 'kitchen') {
        this.fridges(r);
        this.counters(r);
      }
      if (r.kind === 'living') {
        const tv = this.tvWall(r);
        if (tv) tvWalls.set(r.id, tv);
      }
    }
    let aircon = false;
    for (const r of live) {
      if (r.kind === 'bedroom' || r.kind === 'living')
        aircon = this.aircon(r, bedHeads.get(r.id), tvWalls.get(r.id)) || aircon;
    }
    for (const r of live) {
      if (r.kind === 'bedroom' || r.kind === 'study') this.dresser(r, bedHeads.get(r.id));
      if (r.kind === 'bathroom') this.waterHeater(r, entries.get(r.id)?.door ?? null);
    }
    for (const r of live) {
      for (const l of lights.get(r.id) ?? []) {
        this.add(4, r.id, l.rule, l.key, { kind: 'light', at: l.at }, l.why, l.where);
      }
      if (r.kind === 'other' && /^\s*room(\s+\d+)?\s*$/i.test(r.name))
        this.note(r.id, SUGGEST_NOTES.name);
    }
    if (aircon) this.compressor();
    for (const r of live) {
      const e = entries.get(r.id);
      if (!e?.door && !e?.openTo) this.note(r.id, SUGGEST_NOTES.door);
    }
    this.roomNotes();
    return this.finish();
  }

  /** Each room's points on structural walls, and the trunking an aircon unit still needs. */
  private roomNotes() {
    const faces = [...this.faces.values()];
    const byRoom = new Map<string, Set<string>>();
    for (const s of this.out) {
      const w = s.point.wall;
      if (!w) continue;
      const face = faces.find((f) => f.wallId === w.wallId && f.side === w.side);
      if (!face?.structural) continue;
      const set = byRoom.get(s.roomId) ?? new Set<string>();
      const name = RULE_NAMES[s.rule][0];
      set.add(name.charAt(0).toUpperCase() + name.slice(1));
      byRoom.set(s.roomId, set);
    }
    for (const [roomId, what] of byRoom) {
      const names = [...what].map((n, i) => (i === 0 ? n : n.toLowerCase()));
      this.note(roomId, structuralNote(names));
    }
    for (const s of this.out) if (s.rule === 'aircon') this.note(s.roomId, SUGGEST_NOTES.trunking);
  }

  /** Plan order: by label point, top to bottom then left to right, to the half metre. */
  private finish(): Suggestions {
    const rank = (id: string) => {
      const r = this.byId.get(id);
      return r ? [Math.round(r.label.y / 0.5), Math.round(r.label.x / 0.5)] : [0, 0];
    };
    const order = [...this.rooms]
      .sort((a, b) => {
        const [ay, ax] = rank(a.id) as [number, number];
        const [by, bx] = rank(b.id) as [number, number];
        return ay - by || ax - bx || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      })
      .map((r) => r.id);
    const pos = new Map(order.map((id, i) => [id, i]));
    const points = [...this.out]
      .sort(
        (a, b) =>
          (pos.get(a.roomId) ?? 0) - (pos.get(b.roomId) ?? 0) || a.stage - b.stage || a.n - b.n,
      )
      .map(({ stage: _s, n: _n, ...s }) => s);
    const used = new Set([...points.map((p) => p.roomId), ...this.notes.map((n) => n.roomId)]);
    const notes = [...this.notes].sort(
      (a, b) => (pos.get(a.roomId) ?? 0) - (pos.get(b.roomId) ?? 0),
    );
    return { points, notes, rooms: order.filter((id) => used.has(id)) };
  }

  /** The room's ceiling light and one over each dining table, where none is there yet. */
  private lightsFor(r: RoomInfo) {
    const out: { rule: SuggestRule; key: string; at: Vec2; why: string; where: string }[] = [];
    const lit = this.existing.filter((p) => (p.kind === 'light' || p.kind === 'fan') && p.at);
    for (const t of r.items) {
      if (!DINING_TABLES.has(t.assetId)) continue;
      const c = { x: t.position.x, y: t.position.z };
      if (
        lit.some((p) => p.kind === 'light' && p.at && Math.hypot(p.at.x - c.x, p.at.y - c.y) <= 0.6)
      )
        continue;
      out.push({
        rule: 'table-light',
        key: `table-light:${t.id}`,
        at: c,
        why: WHY.table,
        where: 'Over the dining table',
      });
    }
    const roomLit = lit.some((p) => p.at && this.roomAt(p.at) === r.id);
    const byTable = out.some((l) => Math.hypot(l.at.x - r.label.x, l.at.y - r.label.y) <= 0.6);
    if (!roomLit && !byTable)
      out.unshift({
        rule: 'light',
        key: 'light',
        at: this.lightSpot(r),
        why: WHY.light,
        where: 'Ceiling',
      });
    return out;
  }

  /**
   * Where a room's ceiling light goes: up from its label point (so the room's name stays
   * readable), else down, kept off the walls; at the label point in a room too small.
   */
  private lightSpot(r: RoomInfo): Vec2 {
    for (const dy of [-LIGHT_OFF_LABEL, LIGHT_OFF_LABEL]) {
      const p = { x: r.label.x, y: r.label.y + dy };
      if (!pointInPolygon(p, r.outer) || r.holes.some((h) => pointInPolygon(p, h))) continue;
      if (nearestOnEdge(p, r.outer).d >= LIGHT_WALL_CLEAR) return p;
    }
    return { ...r.label };
  }

  /**
   * The door each room is entered by: the last on the fewest-doors way in from the main
   * door (with none, the room's widest door). A room reached across a room boundary has
   * none of its own: it is `openTo` the room before it.
   */
  private entryDoors(): Map<string, RoomEntry> {
    const { graph, entries } = roomEntries(this.level, this.geom);
    this.graph = graph;
    return entries;
  }

  /** A room's switch by the door it's entered by (outside a bathroom's), a gang per light. */
  private switchesFor(
    r: RoomInfo,
    entries: Map<string, { door: RouteDoor | null; openTo?: string }>,
    lights: Map<string, { rule: SuggestRule }[]>,
  ) {
    const entry = entries.get(r.id);
    const door = entry?.door;
    if (!door) return;
    const count = (id: string, min: number) =>
      Math.max(
        min,
        (lights.get(id)?.length ?? 0) +
          this.inRoom(id, ['light', 'fan']).filter((p) => !!p.at).length,
      );
    let gangs = count(r.id, 1);
    for (const [id, e] of entries) if (e.openTo === r.id) gangs += count(id, 0);
    const bath = r.kind === 'bathroom';
    const sideRoom = bath ? door.sides.find((s) => s !== r.id) : r.id;
    if (!sideRoom) {
      this.note(r.id, SUGGEST_NOTES.switch);
      return;
    }
    const k = door.sides[0] === sideRoom ? 1 : -1;
    const face = this.faces.get(`${door.o.wallId}:${k === 1 ? 'left' : 'right'}`);
    const o = door.o;
    if (!face || face.shelter) {
      this.note(r.id, SUGGEST_NOTES.switch);
      return;
    }
    const c = o.t * face.f.length;
    const u0 = c - o.width / 2;
    const u1 = c + o.width / 2;
    const w = ELEC_KINDS.switch.plate.w;
    // Already a switch by this door, on this side (round the corner too).
    // (Beside a bathroom's switch just suggested, a room's own goes too.)
    const mid = this.at(face, c);
    const near = [...this.existing, ...(bath ? this.batch : [])].some((q) => {
      if (q.kind !== 'switch' || !q.wall) return false;
      const pos = this.posOf(q);
      if (!pos || this.roomOfPoint(q) !== sideRoom) return false;
      return Math.hypot(pos.at.x - mid.x, pos.at.y - mid.y) <= o.width / 2 + 0.6 + w;
    });
    if (near) return;
    let ends: (0 | 1)[];
    const latch = latchEnd(o);
    if (latch !== undefined) ends = [latch, latch === 1 ? 0 : 1];
    else {
      // A passage, pocket or double door: on the side with the longer clear wall.
      const clear = this.stretches(face, 'switch', SWITCH_HEIGHT, []);
      const before = clear.find((s) => Math.abs(s[1] - (u0 - JAMB_CLEAR)) < 0.02);
      const after = clear.find((s) => Math.abs(s[0] - (u1 + JAMB_CLEAR)) < 0.02);
      const lb = before ? before[1] - before[0] : 0;
      const la = after ? after[1] - after[0] : 0;
      ends = la >= lb ? [1, 0] : [0, 1];
    }
    const why = bath ? WHY.bathSwitch : WHY.switch;
    const where = bath ? 'Outside the door' : 'By the door';
    // 150 mm off the latch side; a door with no latch (a passage) either side. Never behind
    // a door on its hinge side: with no room by the latch, round the corner past it.
    type Try = {
      face: Face;
      along: number;
      dir: number;
      limit: number;
      blocked?: (g: Face) => [number, number][];
    };
    const tries: Try[] = [];
    const sides = latch !== undefined ? [latch] : ends;
    for (const end of sides) {
      const dir = end === 1 ? 1 : -1;
      const edge = end === 1 ? u1 : u0;
      tries.push({ face, along: edge + dir * (SWITCH_OFF + w / 2), dir, limit: SWITCH_NUDGE });
    }
    if (latch !== undefined) {
      const corner = this.roundCorner(face, latch === 1 ? 1 : -1);
      // Its own leaf swings away from the latch: it doesn't count there.
      const blocked = (g: Face) => this.blockedOn(g, 'switch', SWITCH_HEIGHT, [], o.id);
      if (corner) tries.push({ ...corner, limit: SWITCH_NUDGE, blocked });
    }
    for (const end of sides) {
      const dir = end === 1 ? 1 : -1;
      const edge = end === 1 ? u1 : u0;
      tries.push({ face, along: edge + dir * (SWITCH_OFF + w / 2), dir, limit: NUDGE });
    }
    for (const { face: at, along, dir, limit, blocked } of tries) {
      const first = this.onWall('switch', at, along, SWITCH_HEIGHT, limit, blocked);
      if (!first) continue;
      this.add(
        0,
        r.id,
        'switch',
        `switch:${o.id}:1`,
        { ...first, gang: Math.min(3, gangs) },
        why,
        where,
      );
      if (gangs > 3) {
        const second = this.onWall(
          'switch',
          at,
          along + dir * (w + JAMB_CLEAR),
          SWITCH_HEIGHT,
          NUDGE,
        );
        if (second)
          this.add(
            0,
            r.id,
            'switch',
            `switch:${o.id}:2`,
            { ...second, gang: Math.min(3, gangs - 3) },
            why,
            where,
          );
      }
      return;
    }
    this.note(r.id, SUGGEST_NOTES.switch);
  }

  /**
   * The wall round the inside corner at one end (`dir` +1: towards b) of a face's line: where
   * a switch goes just past the corner, and which way along that wall is away from it.
   */
  private roundCorner(face: Face, dir: number): { face: Face; along: number; dir: number } | null {
    const ends = this.line(face).flatMap((g) => this.toFace(g, face, [g.lo, g.hi]));
    const cu = dir > 0 ? Math.max(...ends) : Math.min(...ends);
    const c = this.at(face, cu);
    const room = this.byId.get(face.roomId);
    const w = ELEC_KINDS.switch.plate.w;
    for (const g of room?.faces ?? []) {
      if (g.shelter || Math.abs(g.n.x * face.n.x + g.n.y * face.n.y) > 0.5) continue;
      for (const [end, away] of [
        [g.lo, 1],
        [g.hi, -1],
      ] as const) {
        const p = this.at(g, end);
        if (Math.hypot(p.x - c.x, p.y - c.y) > 0.03) continue;
        return { face: g, along: end + away * (CORNER_OFF + w / 2), dir: away };
      }
    }
    return null;
  }

  /** Bedside sockets for each bed whose head is against a wall; the faces of bed heads. */
  private bedside(r: RoomInfo): Set<string> {
    const heads = new Set<string>();
    for (const bed of r.items.filter(isBed)) {
      const bf = this.backFace(r, bed);
      if (!bf || bf.face.shelter) {
        this.note(r.id, SUGGEST_NOTES.bed);
        continue;
      }
      for (const g of this.line(bf.face)) heads.add(g.key);
      const fp = itemFootprint(bed);
      const [bl, br] = fp as [Vec2, Vec2];
      for (const side of ['left', 'right'] as const) {
        const open = roomOff(sideOf(fp, side), SIDE_OPEN, this.solid) >= SIDE_OPEN - 0.005;
        if (!open) continue;
        const corner = this.u(bf.face, side === 'left' ? bl : br);
        const along = corner + Math.sign(corner - bf.uc) * BEDSIDE_OUT;
        if (this.there('socket-double', bf.face, along, BEDSIDE_HEIGHT)) continue;
        // Never nudged in behind the bed's own head.
        const blocked = (g: Face): [number, number][] => [
          ...this.blockedOn(g, 'socket-double', BEDSIDE_HEIGHT),
          this.toFace(bf.face, g, [bf.u0, bf.u1]),
        ];
        const p = this.onWall('socket-double', bf.face, along, BEDSIDE_HEIGHT, NUDGE, blocked);
        if (!p) {
          this.note(r.id, noRoomFor('bedside socket'));
          continue;
        }
        const where = `Bedside, ${side}`;
        this.add(
          1,
          r.id,
          'bedside',
          `bedside:${bed.id}:${side === 'left' ? 'L' : 'R'}`,
          p,
          WHY.bedside,
          where,
        );
      }
    }
    return heads;
  }

  /** A double socket behind each desk against a wall. */
  private desks(r: RoomInfo) {
    for (const desk of r.items.filter((it) => DESKS.has(it.assetId))) {
      const bf = this.backFace(r, desk);
      if (!bf) continue;
      if (this.there('socket-double', bf.face, bf.uc, DESK_HEIGHT)) continue;
      const p = this.onWall('socket-double', bf.face, bf.uc, DESK_HEIGHT, NUDGE);
      if (p) this.add(1, r.id, 'desk', `desk:${desk.id}`, p, WHY.desk, 'Behind the desk');
      else this.note(r.id, noRoomFor('desk socket'));
    }
  }

  /** With no desk: a socket mid-way along the longest clear wall, for a desk or dresser. */
  private dresser(r: RoomInfo, heads: Set<string> = new Set()) {
    if (r.items.some((it) => DESKS.has(it.assetId))) return;
    // Not behind a wardrobe or any built-in.
    const behind = r.items.filter((it) => {
      const k = furnitureKind(it.assetId);
      return !!k?.carpentry || it.assetId === 'wardrobe';
    });
    const blocked = (g: Face) => this.blockedOn(g, 'socket-double', LOW, behind);
    const options = r.faces
      .filter((f) => !f.shelter && !heads.has(f.key) && this.head(f) === f)
      .flatMap((face) => {
        const s = this.longestRun(face, 'socket-double', LOW, blocked);
        return s ? [{ face, s }] : [];
      })
      .sort(
        (a, b) =>
          Number(a.face.structural) - Number(b.face.structural) ||
          b.s[1] - b.s[0] - (a.s[1] - a.s[0]),
      );
    for (const { face, s } of options) {
      const along = (s[0] + s[1]) / 2;
      if (this.there('socket-double', face, along, LOW)) return;
      const p = this.onWall('socket-double', face, along, LOW, NUDGE, blocked);
      if (p) {
        this.add(3, r.id, 'dresser', 'dresser', p, WHY.dresser, 'Desk or dresser');
        return;
      }
    }
    this.note(r.id, noRoomFor('desk or dresser socket'));
  }

  /** A single socket behind each fridge against a wall. */
  private fridges(r: RoomInfo) {
    for (const fr of r.items.filter((it) => it.assetId === 'fridge')) {
      const bf = this.backFace(r, fr);
      if (!bf) continue;
      if (this.there('socket-single', bf.face, bf.uc, LOW)) continue;
      const p = this.onWall('socket-single', bf.face, bf.uc, LOW, NUDGE, () => []);
      if (p) this.add(1, r.id, 'fridge', `fridge:${fr.id}`, p, WHY.fridge, 'Behind the fridge');
      else this.note(r.id, noRoomFor('fridge socket'));
    }
  }

  /** Whether a room has a base cabinet standing in it. */
  private hasCounter(roomId: string): boolean {
    return !!this.byId.get(roomId)?.items.some((it) => {
      const k = furnitureKind(it.assetId);
      return k?.carpentry === 'base' && furnitureLayer(k) === 'floor';
    });
  }

  /** The kitchens a room opens onto, through a door or passage or across a room boundary. */
  private joined(roomId: string): string[] {
    const g = this.graph;
    if (!g) return [];
    const ids = new Set<string>(g.free.get(roomId) ?? []);
    for (const d of g.doors) {
      if (!d.sides.includes(roomId)) continue;
      for (const s of d.sides) if (s && s !== roomId) ids.add(s);
    }
    return [...ids].filter((id) => this.byId.get(id)?.kind === 'kitchen');
  }

  /** Kitchen counters: sockets about every 1.2 m clear of the sink and hob; hood and hob points. */
  private counters(r: RoomInfo) {
    const base = r.items.filter((it) => {
      const k = furnitureKind(it.assetId);
      return k?.carpentry === 'base' && furnitureLayer(k) === 'floor';
    });
    const find = touchingRuns(base);
    // One run per face: an L's two legs are two runs.
    const runs = new Map<string, { face: Face; items: { it: Item; u0: number; u1: number }[] }>();
    for (const it of base) {
      const bf = this.backFace(r, it);
      if (!bf) continue;
      const head = this.head(bf.face);
      const key = `${find(it.id)}|${head.key}`;
      const run = runs.get(key) ?? { face: head, items: [] };
      const [u0, u1] = this.toFace(bf.face, head, [bf.u0, bf.u1]);
      run.items.push({ it, u0, u1 });
      runs.set(key, run);
    }
    if (runs.size === 0) {
      // Not where a kitchen joined to this one (a dry kitchen beside the wet) has the counter.
      if (!this.joined(r.id).some((id) => this.hasCounter(id)))
        this.note(r.id, SUGGEST_NOTES.counter);
      return;
    }
    let hobs = 0;
    const w = ELEC_KINDS['socket-double'].plate.w;
    for (const { face, items } of runs.values()) {
      const lo = Math.min(...items.map((i) => i.u0));
      const hi = Math.max(...items.map((i) => i.u1));
      const len = hi - lo;
      const first = items.map((i) => i.it.id).sort()[0] as string;
      const forbidden: [number, number][] = [];
      for (const { it, u0, u1 } of items) {
        if (it.assetId === 'kitchen-sink') {
          const c = (u0 + u1) / 2;
          forbidden.push([c - SINK_CLEAR - w / 2, c + SINK_CLEAR + w / 2]);
        }
        if (it.assetId === 'kitchen-hob')
          forbidden.push([u0 - HOB_CLEAR - w / 2, u1 + HOB_CLEAR + w / 2]);
      }
      const ok = (u: number) =>
        u >= lo + w / 2 - 1e-9 &&
        u <= hi - w / 2 + 1e-9 &&
        forbidden.every(([a, b]) => u <= a + 1e-9 || u >= b - 1e-9);
      const n = Math.max(1, Math.round(len / COUNTER_EVERY + 1e-9));
      // Sockets over this run already (at counter height, either kind): only the shortfall.
      const have = this.existing.filter((q) => {
        if (!q.wall || !isSocket(q.kind)) return false;
        const qa = this.alongOf(face, q);
        return (
          qa !== null &&
          qa >= lo - 1e-9 &&
          qa <= hi + 1e-9 &&
          Math.abs(q.wall.height - COUNTER_HEIGHT) <= THERE_HEIGHT + 1e-9
        );
      }).length;
      let short = n - have;
      for (let i = 0; i < n && short > 0; i++) {
        const nominal = lo + (len * (i + 0.5)) / n;
        // The nearest clear spot to its share of the run, then the next, and so on.
        const spots = [nominal, ...forbidden.flat(), lo + w / 2, hi - w / 2]
          .filter(ok)
          .sort((a, b) => Math.abs(a - nominal) - Math.abs(b - nominal));
        for (const along of spots) {
          if (this.there('socket-double', face, along, COUNTER_HEIGHT)) continue;
          const p = this.onWall('socket-double', face, along, COUNTER_HEIGHT, len, () => []);
          const u = p ? this.alongOf(face, { ...p, id: 'probe' } as ElecPoint) : null;
          // Where it lands: still clear of the sink and hob, and not by another socket.
          if (!p || u === null || !ok(u) || this.there('socket-double', face, u, COUNTER_HEIGHT))
            continue;
          this.add(1, r.id, 'counter', `counter:${first}:${i}`, p, WHY.counter, `Counter ${i + 1}`);
          short--;
          break;
        }
      }
      // A window or the sink and hob left no room for some of them.
      if (short > 0) this.note(r.id, noRoomFor(`counter socket${short === 1 ? '' : 's'}`));
      for (const { it, u0, u1 } of items) {
        if (it.assetId !== 'kitchen-hob') continue;
        hobs++;
        const c = (u0 + u1) / 2;
        const ceiling = this.level.rooms[r.id]?.ceilingHeight ?? this.level.ceilingHeight;
        const hood = Math.min(HOOD_HEIGHT, Math.round((ceiling - 0.15) * 1000) / 1000);
        if (!this.there('socket-single', face, c, hood)) {
          const p = this.onWall('socket-single', face, c, hood, NUDGE, () => []);
          if (p) this.add(1, r.id, 'hood', `hood:${it.id}`, p, WHY.hood, 'Hood');
          else this.note(r.id, noRoomFor('hood socket'));
        }
        if (!this.there('cooker', face, c, COOKER_HEIGHT)) {
          const p = this.onWall('cooker', face, c, COOKER_HEIGHT, NUDGE, () => []);
          if (p) this.add(1, r.id, 'cooker', `cooker:${it.id}`, p, WHY.cooker, 'Under the hob');
          else this.note(r.id, noRoomFor('cooker point'));
        }
      }
    }
    if (hobs === 0) this.note(r.id, SUGGEST_NOTES.hob);
  }

  /** The TV wall's sockets, TV and data points; the face they're on. */
  private tvWall(r: RoomInfo): string | null {
    let face: Face | null = null;
    let centre = 0;
    let anchor = '';
    for (const it of r.items) {
      if (!TV_PIECES.has(it.assetId)) continue;
      const bf = this.backFace(r, it);
      if (bf && !bf.face.shelter) {
        face = bf.face;
        centre = bf.uc;
        anchor = it.id;
        break;
      }
    }
    if (!face) {
      for (const sofa of r.items.filter(isSofa)) {
        const [, , fr, fl] = itemFootprint(sofa) as [Vec2, Vec2, Vec2, Vec2];
        const [bl] = itemFootprint(sofa) as [Vec2];
        const p = { x: (fr.x + fl.x) / 2, y: (fr.y + fl.y) / 2 };
        const dl = Math.hypot(fl.x - bl.x, fl.y - bl.y) || 1;
        const dir = { x: (fl.x - bl.x) / dl, y: (fl.y - bl.y) / dl };
        let best: { face: Face; t: number; u: number } | null = null;
        for (const f of r.faces) {
          const towards = dir.x * f.n.x + dir.y * f.n.y;
          if (towards > -0.5 || f.shelter) continue;
          const t = -this.v(f, p) / towards;
          const u = this.u(f, { x: p.x + dir.x * t, y: p.y + dir.y * t });
          if (t <= 0 || t > SOFA_REACH || u < f.lo || u > f.hi) continue;
          if (!best || t < best.t) best = { face: f, t, u };
        }
        if (best) {
          face = best.face;
          centre = best.u;
          anchor = sofa.id;
          break;
        }
      }
    }
    if (!face) {
      const bare = r.faces
        .filter(
          (f) =>
            !f.shelter && !Object.values(this.level.openings).some((o) => o.wallId === f.wallId),
        )
        .sort(
          (a, b) =>
            Number(b.hi - b.lo >= TV_WALL) - Number(a.hi - a.lo >= TV_WALL) ||
            Number(a.structural) - Number(b.structural) ||
            b.hi - b.lo - (a.hi - a.lo),
        );
      face = bare[0] ?? null;
      if (!face) {
        this.note(r.id, noRoomFor('TV wall points'));
        return null;
      }
      anchor = face.key;
      const s = this.longestRun(face, 'socket-double', LOW);
      centre = s ? (s[0] + s[1]) / 2 : (face.lo + face.hi) / 2;
    }
    const at = face;
    const set: [ElecKind, number][] = [
      ['socket-double', -0.45],
      ['tv', -0.15],
      ['data', 0.15],
      ['socket-double', 0.45],
    ];
    let missed = false;
    set.forEach(([kind, off], i) => {
      const along = centre + off;
      if (this.there(kind, at, along, LOW)) return;
      const p = this.onWall(kind, at, along, LOW, NUDGE);
      if (p) this.add(1, r.id, 'tv-wall', `tv:${anchor}:${i}`, p, WHY.tv, 'TV wall');
      else missed = true;
    });
    if (missed) this.note(r.id, noRoomFor('TV wall points'));
    return at.key;
  }

  /** One aircon unit: over the bed head, else the best wall with room (never the TV wall). */
  private aircon(r: RoomInfo, heads?: Set<string>, tv?: string): boolean {
    if (this.inRoom(r.id, ['aircon']).length) return false;
    if (this.batch.some((p) => p.kind === 'aircon' && this.roomOfPoint(p) === r.id)) return false;
    const ceiling = this.level.rooms[r.id]?.ceilingHeight ?? this.level.ceilingHeight;
    const h = Math.round((ceiling - 0.2) * 1000) / 1000;
    // Over the bed: the bed-head wall, centred on the bed.
    for (const bed of r.items.filter(isBed)) {
      const bf = this.backFace(r, bed);
      if (!bf || !heads?.has(bf.face.key)) continue;
      const p = this.onWall('aircon', bf.face, bf.uc, h, NUDGE);
      if (p) {
        this.add(2, r.id, 'aircon', 'aircon', p, WHY.airconBed, 'Over the bed head');
        return true;
      }
    }
    const ledge = this.rooms.find((x) => LEDGE_ROOM.test(x.name));
    // Not over a door, where it blows on whoever comes in.
    const blocked = (g: Face) => [...this.blockedOn(g, 'aircon', h), ...this.doorways(g)];
    const tvFace = tv ? this.faces.get(tv) : undefined;
    const tvHead = tvFace ? this.head(tvFace) : undefined;
    const options = r.faces
      .filter((f) => !f.shelter && this.head(f) === f && f !== tvHead)
      .flatMap((face) => {
        const s = this.longestRun(face, 'aircon', h, blocked);
        if (!s || s[1] - s[0] < AIRCON_CLEAR - 1e-9) return [];
        const mid = this.at(face, (s[0] + s[1]) / 2);
        const d = ledge ? Math.hypot(mid.x - ledge.label.x, mid.y - ledge.label.y) : 0;
        // Into the room, not across a corridor.
        const shallow = this.ray(mid, face.n, r) < AIRCON_THROW;
        // Prefer a wall that isn't structural, where its whole line isn't.
        const structural = this.line(face).some((g) => g.structural);
        return [{ face, s, d, shallow, structural }];
      })
      .sort(
        (a, b) =>
          Number(a.shallow) - Number(b.shallow) ||
          Number(a.structural) - Number(b.structural) ||
          a.d - b.d ||
          b.s[1] - b.s[0] - (a.s[1] - a.s[0]),
      );
    for (const { face, s } of options) {
      const p = this.onWall('aircon', face, (s[0] + s[1]) / 2, h, NUDGE, blocked);
      if (p) {
        const why = ledge ? WHY.airconLedge : WHY.aircon;
        this.add(
          2,
          r.id,
          'aircon',
          'aircon',
          p,
          why,
          ledge ? 'Nearest the ledge' : 'High on the wall',
        );
        return true;
      }
    }
    this.note(r.id, SUGGEST_NOTES.aircon);
    return false;
  }

  /** A bathroom's water heater: on the wall furthest from the door, mid-way along it. */
  private waterHeater(r: RoomInfo, door: RouteDoor | null) {
    if (this.inRoom(r.id, ['water-heater']).length) return;
    const from = door?.centre ?? r.label;
    // A wall's whole line: a wall drawn in pieces is one wall to choose.
    const options = r.faces
      .filter((f) => !f.shelter && this.head(f) === f)
      .map((face) => {
        const ends = this.line(face).flatMap((g) => this.toFace(g, face, [g.lo, g.hi]));
        const mid = this.at(face, (Math.min(...ends) + Math.max(...ends)) / 2);
        return { face, d: Math.hypot(mid.x - from.x, mid.y - from.y) };
      })
      .sort((a, b) => b.d - a.d);
    for (const { face } of options) {
      const s = this.longestRun(face, 'water-heater', HEATER_HEIGHT);
      if (!s) continue;
      const p = this.onWall('water-heater', face, (s[0] + s[1]) / 2, HEATER_HEIGHT, NUDGE);
      if (p) {
        this.add(1, r.id, 'water-heater', 'water-heater', p, WHY.heater, 'Over the shower');
        return;
      }
    }
    this.note(r.id, noRoomFor('water heater point'));
  }

  /** The compressor on the aircon ledge, where the level has none. */
  private compressor() {
    if (this.existing.some((p) => p.kind === 'compressor')) return;
    const ledge = this.rooms.find((r) => LEDGE_ROOM.test(r.name));
    if (!ledge) return;
    this.add(
      4,
      ledge.id,
      'compressor',
      'compressor',
      { kind: 'compressor', at: { ...ledge.label } },
      WHY.compressor,
      'On the ledge',
    );
  }
}
