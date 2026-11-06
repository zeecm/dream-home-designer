import { type Draft, current, isDraft } from 'immer';
import { furnitureKind, itemFootprint } from './furniture';
import { pointInPolygon } from './geometry';
import type { Command } from './history';
import { newId } from './ids';
import { draftLevel } from './levels';
import { type PlanGeometry, planGeometry } from './plan';
import { renovationDiff } from './renovation';
import { roomShapes } from './rooms';
import {
  type ElecKind,
  ElecPoint,
  type Level,
  type Opening,
  type Vec2,
  type Wall,
  isBoundary,
  isGlass,
  isHalfWall,
  wallFaces,
} from './schema';
import { wallStatus } from './structural';

/**
 * Electrical points: sockets, switches, lights, aircon units and the rest, placed on a wall
 * face (at a height) or on the plan (ceiling lights, a compressor on the ledge). Spec:
 * docs/specs/electrical.md.
 */

/** Where a kind of point goes: on a wall face, on the ceiling, or on the floor plan. */
export type ElecPlace = 'wall' | 'ceiling' | 'plan';

export interface ElecKindInfo {
  kind: ElecKind;
  name: string;
  /** Short name for the palette and the plan's legend. */
  short: string;
  place: ElecPlace;
  /** The faceplate (or unit) width along the wall and its height, in metres. */
  plate: { w: number; h: number };
}

const PLATE = { w: 0.086, h: 0.086 };

export const ELEC_KINDS: Record<ElecKind, ElecKindInfo> = {
  'socket-double': {
    kind: 'socket-double',
    name: '13A double socket',
    short: 'Double socket',
    place: 'wall',
    plate: { w: 0.146, h: 0.086 },
  },
  'socket-single': {
    kind: 'socket-single',
    name: '13A single socket',
    short: 'Single socket',
    place: 'wall',
    plate: PLATE,
  },
  switch: { kind: 'switch', name: 'Switch', short: 'Switch', place: 'wall', plate: PLATE },
  light: { kind: 'light', name: 'Light point', short: 'Light', place: 'ceiling', plate: PLATE },
  fan: { kind: 'fan', name: 'Fan point', short: 'Fan', place: 'ceiling', plate: PLATE },
  data: { kind: 'data', name: 'Data point', short: 'Data', place: 'wall', plate: PLATE },
  tv: { kind: 'tv', name: 'TV point', short: 'TV', place: 'wall', plate: PLATE },
  aircon: {
    kind: 'aircon',
    name: 'Aircon point (isolator)',
    short: 'Aircon',
    place: 'wall',
    plate: { w: 0.9, h: 0.29 },
  },
  compressor: {
    kind: 'compressor',
    name: 'Aircon compressor',
    short: 'Compressor',
    place: 'plan',
    plate: { w: 0.8, h: 0.55 },
  },
  'water-heater': {
    kind: 'water-heater',
    name: 'Water heater point',
    short: 'Water heater',
    place: 'wall',
    plate: PLATE,
  },
  cooker: {
    kind: 'cooker',
    name: 'Cooker point',
    short: 'Cooker',
    place: 'wall',
    plate: { w: 0.146, h: 0.086 },
  },
  doorbell: { kind: 'doorbell', name: 'Doorbell', short: 'Doorbell', place: 'wall', plate: PLATE },
};

/** The kinds in palette order. */
export const ELEC_KIND_ORDER = Object.keys(ELEC_KINDS) as ElecKind[];

export const isSocket = (k: ElecKind) => k === 'socket-double' || k === 'socket-single';

/** A point's name as a contractor reads it ("2-gang switch"). */
export function pointName(p: Pick<ElecPoint, 'kind' | 'gang'>): string {
  if (p.kind === 'switch') return `${p.gang ?? 1}-gang switch`;
  return ELEC_KINDS[p.kind].name;
}

/** A compressor depth (from its back, on the plan). */
export const COMPRESSOR_DEPTH = 0.3;

/** Where a point on a wall is: along the wall's line, which face, and the room it faces. */
export interface WallPlace {
  wallId: string;
  /** Distance from the wall's vertex a along its line (metres). */
  along: number;
  side: 'left' | 'right';
}

/** How far from a jamb a moved point's plate edge stays. */
export const JAMB_CLEAR = 0.05;

const KITCHEN_BASE = (assetId: string) => furnitureKind(assetId)?.carpentry === 'base';

/** Where a point on a wall sits: on the face, its distance along and off the line, its height. */
export interface PointPosition {
  /** On the plan: the face point (or the point itself, for one on the plan). */
  at: Vec2;
  /** Along the wall's line from vertex a, and off it to the face (metres). */
  along: number;
  off: number;
  /** Height above the floor (the top, for an aircon unit). */
  height: number;
  /** Out of the face, into the room (a unit vector); none for a point on the plan. */
  normal?: Vec2;
  /** Along the wall, from a to b. */
  dir?: Vec2;
}

/** Where a point is on the plan and how high (null if its wall is gone). */
export function pointPosition(level: Level, p: ElecPoint): PointPosition | null {
  if (p.at) {
    const height = ELEC_KINDS[p.kind].place === 'ceiling' ? ceilingAt(level, p.at) : 0;
    return { at: { ...p.at }, along: 0, off: 0, height };
  }
  const pw = p.wall;
  const w = pw && level.walls[pw.wallId];
  const a = w && level.vertices[w.a];
  const b = w && level.vertices[w.b];
  if (!pw || !w || !a || !b) return null;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-9) return null;
  const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const n = { x: -d.y, y: d.x };
  const faces = wallFaces(w);
  const k = pw.side === 'left' ? 1 : -1;
  const off = pw.side === 'left' ? faces.left : faces.right;
  const along = pw.t * len;
  return {
    at: { x: a.x + d.x * along + n.x * off * k, y: a.y + d.y * along + n.y * off * k },
    along,
    off,
    height: pw.height,
    normal: { x: n.x * k, y: n.y * k },
    dir: d,
  };
}

/** The ceiling over a point: its room's, or the level's. */
function ceilingAt(level: Level, at: Vec2): number {
  const room = roomAt(level, at);
  return room?.ceilingHeight ?? level.ceilingHeight;
}

function roomAt(level: Level, at: Vec2) {
  const shapes = roomShapes(level);
  return Object.values(level.rooms).find((r) => {
    const s = shapes.get(r.id);
    return s && pointInPolygon(at, s.outer) && !s.holes.some((h) => pointInPolygon(at, h));
  });
}

/** The room a point serves: the one its face looks into, or the one it is in. */
export function pointRoom(level: Level, p: ElecPoint): string | null {
  const pos = pointPosition(level, p);
  if (!pos) return null;
  const at = pos.normal
    ? { x: pos.at.x + pos.normal.x * 0.05, y: pos.at.y + pos.normal.y * 0.05 }
    : pos.at;
  return roomAt(level, at)?.name ?? null;
}

/** Whether a kitchen base run stands against the face at this place: a socket goes above it. */
export function overCounter(level: Level, place: WallPlace): boolean {
  const pos = pointPosition(level, {
    id: 'probe',
    kind: 'socket-single',
    wall: { wallId: place.wallId, t: 0, side: place.side, height: 0 },
  });
  const w = level.walls[place.wallId];
  const a = w && level.vertices[w.a];
  const b = w && level.vertices[w.b];
  if (!pos?.normal || !pos.dir || !a || !b) return false;
  const front = {
    x: pos.at.x + pos.dir.x * place.along + pos.normal.x * 0.3,
    y: pos.at.y + pos.dir.y * place.along + pos.normal.y * 0.3,
  };
  return Object.values(level.items).some(
    (it) => KITCHEN_BASE(it.assetId) && pointInPolygon(front, itemFootprint(it)),
  );
}

/**
 * Which end of a door its handle (latch) is at: 0 towards vertex a, 1 towards b. A swing
 * door's is the end away from its hinge; a sliding, bi-fold or folding door's the end its
 * leaves don't stack at. None for a double or pocket door, or a passage.
 */
export function latchEnd(o: Opening): 0 | 1 | undefined {
  if (o.kind !== 'door') return undefined;
  const style = o.style ?? 'swing';
  if (style === 'swing') return (o.swing ?? 'leftIn').startsWith('left') ? 1 : 0;
  if (style === 'sliding' || style === 'bifold' || style === 'folding')
    return (o.stack ?? 'a') === 'a' ? 1 : 0;
  return undefined;
}

/**
 * A kind's usual height (metres above the floor): sockets 300 mm (1150 over a kitchen
 * counter), switches 1050, data and TV 300, an aircon unit's top 200 below the ceiling, a
 * water heater 2000, a cooker 600, a doorbell 1200; ceiling points at the ceiling.
 */
export function defaultHeight(level: Level, kind: ElecKind, place?: WallPlace): number {
  const usual = usualHeight(level, kind, place);
  // On a half wall, no higher than its top lets it (an aircon unit can't go on one at all).
  const w = place && level.walls[place.wallId];
  const cap = w && kind !== 'aircon' ? highestOn(level, w, kind) : Number.POSITIVE_INFINITY;
  return Math.min(usual, cap);
}

/** The top of a half wall a point's plate stays JAMB_CLEAR under; none for a full wall. */
function wallTop(level: Level, w: Wall): number {
  return w.height !== undefined && isHalfWall(w, level.ceilingHeight)
    ? w.height
    : Number.POSITIVE_INFINITY;
}

/** The highest a point of `kind` can sit on wall `w` (its height, as it is measured). */
function highestOn(level: Level, w: Wall, kind: ElecKind): number {
  const top = wallTop(level, w) - JAMB_CLEAR;
  const h = ELEC_KINDS[kind].plate.h;
  return Math.floor((kind === 'aircon' ? top : top - h / 2) * 1000 + 1e-6) / 1000;
}

/** The lowest a point's plate bottom goes: clear of the skirting. */
export const PLATE_FLOOR = 0.05;

/** The lowest height a point of `kind` can have (its plate's bottom PLATE_FLOOR up). */
export function minHeight(kind: ElecKind): number {
  const h = ELEC_KINDS[kind].plate.h;
  return Math.ceil((PLATE_FLOOR + (kind === 'aircon' ? h : h / 2)) * 1000 - 1e-6) / 1000;
}

/**
 * The highest a point can go: its plate under its room's ceiling (the level's, where the
 * room sets none), and on a half wall JAMB_CLEAR under its top.
 */
export function maxHeight(level: Level, p: ElecPoint): number {
  const pos = pointPosition(level, p);
  if (!pos) return level.ceilingHeight;
  if (!p.wall || !pos.normal) return ceilingAt(level, pos.at);
  const ceiling = ceilingAt(level, {
    x: pos.at.x + pos.normal.x * 0.05,
    y: pos.at.y + pos.normal.y * 0.05,
  });
  const h = ELEC_KINDS[p.kind].plate.h;
  const under = Math.floor((p.kind === 'aircon' ? ceiling : ceiling - h / 2) * 1000 + 1e-6) / 1000;
  const w = level.walls[p.wall.wallId];
  return Math.min(under, w ? highestOn(level, w, p.kind) : under);
}

function usualHeight(level: Level, kind: ElecKind, place?: WallPlace): number {
  const room = place ? roomOfPlace(level, place) : undefined;
  const ceiling = room?.ceilingHeight ?? level.ceilingHeight;
  switch (kind) {
    case 'socket-double':
    case 'socket-single':
      return place && overCounter(level, place) ? 1.15 : 0.3;
    case 'switch':
      return 1.05;
    case 'data':
    case 'tv':
      return 0.3;
    case 'aircon':
      return Math.round((ceiling - 0.2) * 1000) / 1000;
    case 'water-heater':
      return 2.0;
    case 'cooker':
      return 0.6;
    case 'doorbell':
      return 1.2;
    case 'light':
    case 'fan':
      return ceiling;
    case 'compressor':
      return 0;
  }
}

function roomOfPlace(level: Level, place: WallPlace) {
  const w = level.walls[place.wallId];
  const a = w && level.vertices[w.a];
  const b = w && level.vertices[w.b];
  if (!w || !a || !b) return undefined;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const pos = pointPosition(level, {
    id: 'probe',
    kind: 'socket-single',
    wall: {
      wallId: w.id,
      t: Math.min(1, Math.max(0, place.along / len)),
      side: place.side,
      height: 0,
    },
  });
  if (!pos?.normal) return undefined;
  return roomAt(level, { x: pos.at.x + pos.normal.x * 0.05, y: pos.at.y + pos.normal.y * 0.05 });
}

/** A point's vertical span on its wall: [bottom, top]. */
function verticalSpan(kind: ElecKind, height: number): [number, number] {
  const h = ELEC_KINDS[kind].plate.h;
  // An aircon unit's height is its top; anything else is centred on its height.
  return kind === 'aircon' ? [height - h, height] : [height - h / 2, height + h / 2];
}

/**
 * Where along a wall face a point can go, as near `along` as it can: kept on the face
 * between the inside corners, never in a door or passage (moved to the nearer jamb, its
 * plate JAMB_CLEAR from it; a switch to a swing door's latch side), in a window's width only
 * under its sill (or over its head), and never on another point of the face at its height
 * (`self`, the point being moved, aside). Null if the face has no room for it, on a glass
 * wall, or above a half wall's top. `more` adds points not on the level yet (`extra`, a batch
 * being placed) and stretches of the face to keep off (`blocked`, metres along the wall).
 */
export function clearAlong(
  level: Level,
  geom: PlanGeometry,
  kind: ElecKind,
  place: WallPlace,
  height: number,
  self?: string,
  more: { extra?: readonly ElecPoint[]; blocked?: readonly (readonly [number, number])[] } = {},
): number | null {
  const f = geom.frames[place.wallId];
  // Nothing goes on glass, nor higher on a half wall than its top.
  if (!f || isBoundary(f.wall) || isGlass(f.wall)) return null;
  if (height > highestOn(level, f.wall, kind) + 1e-9) return null;
  const half = ELEC_KINDS[kind].plate.w / 2;
  const span = place.side === 'left' ? f.left : f.right;
  const lo = Math.max(0, span[0]) + half;
  const hi = Math.min(f.length, span[1]) - half;
  if (hi < lo) return null;
  const [bottom, top] = verticalSpan(kind, height);
  const across = (b: number, t: number) => top > b + 1e-9 && bottom < t - 1e-9;
  // Openings on this wall the point can't overlap at its height (a swing door's latch jamb
  // noted), and the other points on this face.
  const blocks: { s0: number; s1: number; latch?: 0 | 1 }[] = [];
  for (const o of Object.values(level.openings)) {
    if (o.wallId !== place.wallId) continue;
    const sill = o.kind === 'window' ? o.sill : 0;
    if (!across(sill, sill + o.height)) continue;
    const c = o.t * f.length;
    const swing = o.kind === 'door' && (o.style ?? 'swing') === 'swing';
    blocks.push({
      s0: c - o.width / 2,
      s1: c + o.width / 2,
      latch: swing ? latchEnd(o) : undefined,
    });
  }
  for (const [s0, s1] of more.blocked ?? []) blocks.push({ s0, s1 });
  for (const q of [...Object.values(level.points ?? {}), ...(more.extra ?? [])]) {
    if (q.id === self || !q.wall || q.wall.wallId !== place.wallId) continue;
    if (q.wall.side !== place.side || !across(...verticalSpan(q.kind, q.wall.height))) continue;
    const c = q.wall.t * f.length;
    const w = ELEC_KINDS[q.kind].plate.w / 2;
    blocks.push({ s0: c - w, s1: c + w });
  }
  const ok = (u: number) =>
    u >= lo - 1e-9 &&
    u <= hi + 1e-9 &&
    blocks.every(
      ({ s0, s1 }) => u + half <= s0 - JAMB_CLEAR + 1e-9 || u - half >= s1 + JAMB_CLEAR - 1e-9,
    );
  const want = Math.min(hi, Math.max(lo, place.along));
  if (ok(want)) return want;
  const beside = (b: (typeof blocks)[number], end: 0 | 1) =>
    end === 0 ? b.s0 - JAMB_CLEAR - half : b.s1 + JAMB_CLEAR + half;
  // A switch tapped in a swing door: beside its latch, not behind the door on its hinge.
  if (kind === 'switch') {
    const door = blocks.find((b) => b.latch !== undefined && want > b.s0 && want < b.s1);
    const at = door && beside(door, door.latch as 0 | 1);
    if (at !== undefined && ok(at)) return at;
  }
  // Beside each jamb or point in the way, nearest first.
  const candidates = blocks
    .flatMap((b) => [beside(b, 0), beside(b, 1)])
    .filter(ok)
    .sort((p, q) => Math.abs(p - want) - Math.abs(q - want));
  return candidates[0] ?? null;
}

/**
 * Where a point of `kind` goes for a tap at `p`: on the nearest wall face within
 * `tolerance` (0.3 m), at its default height (or `height`), clear of openings and other
 * points (`self`, the one being moved, aside). Of a wall's two faces, the one the tap is
 * beyond, or for a tap within the wall, the one looking into a room: a face with no room
 * only for a tap clearly outside it. Null with no wall face near, or no room on it.
 */
export function placePoint(
  level: Level,
  kind: ElecKind,
  p: Vec2,
  opts: { geom?: PlanGeometry; tolerance?: number; height?: number; self?: string } = {},
): (NonNullable<ElecPoint['wall']> & { at: Vec2 }) | null {
  const geom = opts.geom ?? planGeometry(level);
  const tol = opts.tolerance ?? 0.3;
  let best: { place: WallPlace; dist: number; len: number; off: number } | null = null;
  for (const w of Object.values(level.walls)) {
    if (isBoundary(w)) continue;
    const a = level.vertices[w.a];
    const b = level.vertices[w.b];
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const u = (p.x - a.x) * d.x + (p.y - a.y) * d.y;
    if (u < -tol || u > len + tol) continue;
    const s = (p.x - a.x) * -d.y + (p.y - a.y) * d.x;
    const faces = wallFaces(w);
    const mid = (faces.left - faces.right) / 2;
    const side = s >= mid ? 'left' : 'right';
    const off = side === 'left' ? Math.max(0, s - faces.left) : Math.max(0, -s - faces.right);
    const outside = Math.max(0, -u, u - len);
    const dist = Math.hypot(off, outside);
    if (dist > tol || (best && dist >= best.dist)) continue;
    best = { place: { wallId: w.id, along: u, side }, dist, len, off };
  }
  if (!best) return null;
  // A face with no room behind it (the outside of the flat) only for a tap clearly beyond it.
  if (best.off < CLEARLY_OUTSIDE) {
    const other = { ...best.place, side: best.place.side === 'left' ? 'right' : 'left' } as const;
    if (!roomOfPlace(level, best.place) && roomOfPlace(level, other)) best.place = other;
  }
  const height = opts.height ?? defaultHeight(level, kind, best.place);
  const along = clearAlong(level, geom, kind, best.place, height, opts.self);
  if (along === null) return null;
  const t = Math.min(1, Math.max(0, along / best.len));
  const wall = { wallId: best.place.wallId, t, side: best.place.side, height };
  const pos = pointPosition(level, { id: 'probe', kind, wall });
  return { ...wall, at: pos?.at ?? p };
}

/** A tap further than this beyond a wall's face with no room behind it is meant for it. */
const CLEARLY_OUTSIDE = 0.1;

/**
 * Where along its wall a wall point goes moved to `along` metres from vertex a: clear of
 * openings and corners as clearAlong has it. Its new `t`, or null with no room.
 */
export function pointTAt(
  level: Level,
  p: ElecPoint,
  along: number,
  geom: PlanGeometry = planGeometry(level),
): number | null {
  const pw = p.wall;
  const f = pw && geom.frames[pw.wallId];
  if (!pw || !f || f.length < 1e-9) return null;
  const place = { wallId: pw.wallId, along, side: pw.side };
  const u = clearAlong(level, geom, p.kind, place, pw.height, p.id);
  return u === null ? null : Math.min(1, Math.max(0, u / f.length));
}

/**
 * Moves the points on a wall clear of its doors and windows (as clearAlong does), for a
 * recipe that has just added or moved one there. A point with nowhere to go stays.
 */
export function clearPointsOn(lvl: Draft<Level> | Level, wallId: string): void {
  const on = Object.values(lvl.points ?? {}).filter((p) => p.wall?.wallId === wallId);
  if (on.length === 0) return;
  const level = (isDraft(lvl) ? current(lvl) : lvl) as Level;
  const geom = planGeometry(level);
  const len = geom.frames[wallId]?.length ?? 0;
  for (const p of on) {
    const was = level.points[p.id];
    if (!was?.wall || !p.wall) continue;
    const t = pointTAt(level, was, was.wall.t * len, geom);
    if (t !== null && Math.abs(t - was.wall.t) > 1e-9) p.wall.t = t;
  }
}

/** Whether a wall point's plate overlaps a door, passage or window on its wall. */
export function inOpening(level: Level, p: ElecPoint): boolean {
  const pos = p.wall && pointPosition(level, p);
  const w = p.wall && level.walls[p.wall.wallId];
  const a = w && level.vertices[w.a];
  const b = w && level.vertices[w.b];
  if (!p.wall || !pos || !a || !b) return false;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const half = ELEC_KINDS[p.kind].plate.w / 2;
  const [bottom, top] = verticalSpan(p.kind, p.wall.height);
  return Object.values(level.openings).some((o) => {
    if (o.wallId !== p.wall?.wallId) return false;
    const sill = o.kind === 'window' ? o.sill : 0;
    const c = o.t * len;
    return (
      top > sill + 1e-6 &&
      bottom < sill + o.height - 1e-6 &&
      pos.along + half > c - o.width / 2 + 1e-6 &&
      pos.along - half < c + o.width / 2 - 1e-6
    );
  });
}

/** A polyline's length. */
export function trunkingLength(path: readonly Vec2[]): number {
  let s = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Vec2;
    const b = path[i] as Vec2;
    s += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return s;
}

/** How far off a wall face trunking runs (its centre line, 50 mm): it hugs the wall. */
export const TRUNK_OFF = 0.05;

/**
 * Where an aircon unit's trunking starts on the plan: beside the unit, TRUNK_OFF off its
 * face, on the line the trunking hugs that wall along.
 */
export function trunkingStart(level: Level, p: ElecPoint): Vec2 | null {
  const pos = pointPosition(level, p);
  if (!pos) return null;
  const n = pos.normal;
  return n ? { x: pos.at.x + n.x * TRUNK_OFF, y: pos.at.y + n.y * TRUNK_OFF } : pos.at;
}

/**
 * An aircon unit's trunking on the plan: from beside the unit, through its bends, to its
 * compressor.
 */
export function trunkingPath(level: Level, p: ElecPoint): Vec2[] {
  if (p.kind !== 'aircon') return [];
  const start = trunkingStart(level, p);
  if (!start) return [];
  const comp = p.compressorId ? level.points[p.compressorId] : undefined;
  const end = comp?.at;
  return [start, ...(p.route ?? []), ...(end ? [end] : [])];
}

/** The trunking's length, rounded to 10 cm as a contractor measures it. */
export const trunkingMetres = (level: Level, p: ElecPoint) =>
  Math.round(trunkingLength(trunkingPath(level, p)) * 10) / 10;

/** Rooms that are bathrooms or WCs: no sockets, no switches. */
export const WET_ROOM = /bath|toilet|\bwc\b|shower/i;

export type PointWarning = 'wet' | 'shelter' | 'structural' | 'no-compressor' | 'off-ledge';

/** Rooms that are an aircon ledge. */
export const LEDGE_ROOM = /ledge|air-?con/i;

/** Whether a spot is on an aircon ledge (in a room named for one). */
export function onLedge(level: Level, at: Vec2): boolean {
  return LEDGE_ROOM.test(roomAt(level, at)?.name ?? '');
}

/** Whether a level has an aircon ledge (a room named for one). */
const hasLedge = (level: Level) => Object.values(level.rooms).some((r) => LEDGE_ROOM.test(r.name));

export const WARNING_TEXT: Record<PointWarning, string> = {
  wet: 'A socket in a bathroom or WC: not allowed near water.',
  shelter: 'On the household shelter wall: it can’t be chased or drilled.',
  structural: 'On a structural wall: surface trunking, or check with HDB.',
  'no-compressor': 'No compressor: run its trunking to one.',
  'off-ledge': 'Not on the aircon ledge: an HDB flat’s compressors go there.',
};

/**
 * What's wrong with a point: a socket in a bathroom or WC, a point on the shelter's wall or a
 * structural one (judged on `statusOf`, the flat as it is, where the wall is there), an
 * aircon unit with no compressor, or a compressor off the aircon ledge (where there is one).
 */
export function pointWarnings(level: Level, p: ElecPoint, statusOf: Level = level): PointWarning[] {
  const out: PointWarning[] = [];
  if (isSocket(p.kind) && WET_ROOM.test(pointRoom(level, p) ?? '')) out.push('wet');
  if (p.wall) {
    const id = p.wall.wallId;
    const s = statusOf.walls[id] ? wallStatus(statusOf, id) : wallStatus(level, id);
    if (s === 'shelter') out.push('shelter');
    else if (s === 'structural' || s === 'likely') out.push('structural');
  }
  if (
    p.kind === 'aircon' &&
    !(p.compressorId && level.points[p.compressorId]?.kind === 'compressor')
  )
    out.push('no-compressor');
  if (p.kind === 'compressor' && p.at && hasLedge(level) && !onLedge(level, p.at))
    out.push('off-ledge');
  return out;
}

/** How many points of each kind a level has. */
export function pointCounts(level: Level): Partial<Record<ElecKind, number>> {
  const out: Partial<Record<ElecKind, number>> = {};
  for (const p of Object.values(level.points ?? {})) out[p.kind] = (out[p.kind] ?? 0) + 1;
  return out;
}

/** What a renovation does to a point: new, moved, or taken out. */
export type PointChange = 'new' | 'moved' | 'removed';

export interface ElecChanges {
  /** After's points that are new or moved; the rest are as they were. */
  status: Map<string, 'new' | 'moved'>;
  /** Before's points the renovation takes out (gone, changed kind, or on a hacked wall). */
  removed: ElecPoint[];
  /** Where a moved point was (Before), by id. */
  from: Map<string, ElecPoint>;
}

/** Moved further than this (in plan or height), a point counts as relocated. */
const MOVED = 0.05;

/**
 * A renovation's points compared with the flat's, by id: new (not there before, a changed
 * kind, or on a wall the renovation hacks and builds again), moved (onto another wall face, or
 * more than 50 mm), removed (gone, a changed kind, on a hacked wall, or left in a door or
 * window's span in the renovation).
 */
export function electricalChanges(before: Level, after: Level): ElecChanges {
  const status = new Map<string, 'new' | 'moved'>();
  const removed: ElecPoint[] = [];
  const from = new Map<string, ElecPoint>();
  const bp = before.points ?? {};
  const ap = after.points ?? {};
  const hacked = Object.values(bp).some((p) => p.wall)
    ? renovationDiff(before, after).demolished
    : [];
  const onHacked = (p: ElecPoint) => {
    const pos = p.wall && pointPosition(before, p);
    if (!pos?.normal) return false;
    // On the wall's line, where the stretch runs.
    const c = { x: pos.at.x - pos.normal.x * pos.off, y: pos.at.y - pos.normal.y * pos.off };
    return hacked.some((s) => {
      if (s.wallId !== p.wall?.wallId) return false;
      const dx = s.to.x - s.from.x;
      const dy = s.to.y - s.from.y;
      const l2 = dx * dx + dy * dy;
      if (l2 < 1e-12) return false;
      const t = ((c.x - s.from.x) * dx + (c.y - s.from.y) * dy) / l2;
      const q = { x: s.from.x + dx * t, y: s.from.y + dy * t };
      return t >= -1e-6 && t <= 1 + 1e-6 && Math.hypot(c.x - q.x, c.y - q.y) < 0.01;
    });
  };
  // A point left in a doorway or window (After) can't be there: it's taken out.
  const blocked = (q: ElecPoint) => inOpening(after, q);
  for (const p of Object.values(bp)) {
    const q = ap[p.id];
    if (!q || q.kind !== p.kind || onHacked(p) || blocked(q)) removed.push(p);
  }
  for (const q of Object.values(ap)) {
    if (blocked(q)) continue;
    const p = bp[q.id];
    if (!p || p.kind !== q.kind || removed.includes(p)) {
      status.set(q.id, 'new');
      continue;
    }
    const was = pointPosition(before, p);
    const now = pointPosition(after, q);
    if (!was || !now) {
      status.set(q.id, 'new');
      continue;
    }
    const facing =
      !!was.normal !== !!now.normal ||
      (was.normal && now.normal && was.normal.x * now.normal.x + was.normal.y * now.normal.y < 0.9);
    const dist = Math.hypot(was.at.x - now.at.x, was.at.y - now.at.y, was.height - now.height);
    if (facing || dist > MOVED) {
      status.set(q.id, 'moved');
      from.set(q.id, p);
    }
  }
  return { status, removed, from };
}

// ------------------------------------------------------------------------------- commands

export type NewPoint = Omit<ElecPoint, 'id'>;

const KIND_LABEL = (k: ElecKind) => ELEC_KINDS[k].short.toLowerCase();

/** Adds a point; the id is made here, outside the recipe. */
export function addPoint(levelId: string, point: NewPoint): { command: Command; pointId: string } {
  const pointId = newId('pt');
  const value = ElecPoint.parse({ ...point, id: pointId });
  return {
    pointId,
    command: {
      label: `Add ${KIND_LABEL(point.kind)}`,
      recipe: (d) => {
        const lvl = draftLevel(d, levelId);
        lvl.points ??= {};
        if (value.wall && !lvl.walls[value.wall.wallId])
          throw new Error(`wall ${value.wall.wallId} not found`);
        lvl.points[pointId] = structuredClone(value);
      },
    },
  };
}

export type PointPatch = Partial<Omit<ElecPoint, 'id'>>;

/**
 * Changes a point: its kind, place, height, gang, trunking. A field given as undefined is
 * taken off; the result must still be a valid point (on a wall or at a place, not both).
 */
export function updatePoint(levelId: string, pointId: string, patch: PointPatch): Command {
  return {
    label: 'Edit point',
    recipe: (d) => {
      const p = draftLevel(d, levelId).points?.[pointId];
      if (!p) throw new Error(`point ${pointId} not found`);
      for (const [k, v] of Object.entries(patch)) {
        const key = k as keyof PointPatch;
        if (v === undefined) delete p[key];
        else (p as Record<string, unknown>)[key] = structuredClone(v);
      }
      if (p.kind !== 'switch') delete p.gang;
      if (p.kind !== 'aircon') {
        delete p.route;
        delete p.compressorId;
      }
      const ok = ElecPoint.safeParse(JSON.parse(JSON.stringify(p)));
      if (!ok.success) throw new Error(ok.error.issues[0]?.message ?? 'not a valid point');
    },
  };
}

/** Whether a point's height is its kind's usual one (then the plan shows no "h…"). */
export function atDefaultHeight(level: Level, p: ElecPoint): boolean {
  if (!p.wall) return true;
  const pos = pointPosition(level, p);
  if (!pos) return true;
  const want = defaultHeight(level, p.kind, {
    wallId: p.wall.wallId,
    along: pos.along,
    side: p.wall.side,
  });
  return Math.abs(want - p.wall.height) < 0.005;
}

/**
 * Makes a point another kind, worked out from `level` as it is: a wall point takes the new
 * kind's usual height (unless it was moved off its own) and is placed again clear of doors
 * and other points (its plate may be wider); an aircon unit made something else takes its
 * trunking with it, and its compressor where no other unit runs to it. One undo step.
 */
export function setPointKind(level: Level, pointId: string, kind: ElecKind): Command {
  const p = level.points?.[pointId];
  if (!p) throw new Error(`point ${pointId} not found`);
  const patch: PointPatch = { kind };
  if (kind === 'switch') patch.gang = p.gang ?? 1;
  const pos = pointPosition(level, p);
  if (p.wall && pos) {
    if (ELEC_KINDS[kind].place !== 'wall') throw new Error('a wall point stays on a wall');
    const place = { wallId: p.wall.wallId, along: pos.along, side: p.wall.side };
    const height = atDefaultHeight(level, p) ? defaultHeight(level, kind, place) : p.wall.height;
    const along = clearAlong(level, planGeometry(level), kind, place, height, p.id);
    if (along === null) throw new Error(`no room here for ${pointName({ kind, gang: 1 })}`);
    patch.wall = { ...p.wall, height, t: tOf(level, p.wall.wallId, along) ?? p.wall.t };
  }
  const comp = p.kind === 'aircon' && kind !== 'aircon' ? p.compressorId : undefined;
  const shared =
    !!comp &&
    Object.values(level.points).some(
      (q) => q.id !== pointId && q.kind === 'aircon' && q.compressorId === comp,
    );
  const update = updatePoint(level.id, pointId, patch);
  return {
    label: `Make it a ${KIND_LABEL(kind)}`,
    recipe: (d) => {
      update.recipe(d);
      const lvl = draftLevel(d, level.id);
      if (comp && !shared && lvl.points?.[comp]?.kind === 'compressor') delete lvl.points[comp];
    },
  };
}

/** `along` metres on a wall as its `t`. */
function tOf(level: Level, wallId: string, along: number): number | null {
  const w = level.walls[wallId];
  const a = w && level.vertices[w.a];
  const b = w && level.vertices[w.b];
  const len = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
  return len > 1e-9 ? Math.min(1, Math.max(0, along / len)) : null;
}

/** Deletes a point; an aircon unit running to a compressor deleted loses its link. */
export function deletePoint(levelId: string, pointId: string, snapshot?: Level): Command {
  const kind = snapshot?.points?.[pointId]?.kind;
  return {
    label: `Delete ${kind ? KIND_LABEL(kind) : 'point'}`,
    recipe: (d) => {
      const lvl = draftLevel(d, levelId);
      if (!lvl.points?.[pointId]) return;
      delete lvl.points[pointId];
      for (const p of Object.values(lvl.points))
        if (p.compressorId === pointId) delete p.compressorId;
    },
  };
}
