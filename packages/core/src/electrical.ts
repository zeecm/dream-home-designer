import { furnitureKind, itemFootprint } from './furniture';
import { pointInPolygon } from './geometry';
import type { Command } from './history';
import { newId } from './ids';
import { draftLevel } from './levels';
import { type PlanGeometry, planGeometry } from './plan';
import { renovationDiff } from './renovation';
import { roomShapes } from './rooms';
import { type ElecKind, ElecPoint, type Level, type Vec2, isBoundary, wallFaces } from './schema';
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
 * A kind's usual height (metres above the floor): sockets 300 mm (1150 over a kitchen
 * counter), switches 1050, data and TV 300, an aircon unit's top 200 below the ceiling, a
 * water heater 2000, a cooker 600, a doorbell 1200; ceiling points at the ceiling.
 */
export function defaultHeight(level: Level, kind: ElecKind, place?: WallPlace): number {
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
 * plate JAMB_CLEAR from it), and in a window's width only under its sill (or over its head).
 * Null if the face has no room for it.
 */
export function clearAlong(
  level: Level,
  geom: PlanGeometry,
  kind: ElecKind,
  place: WallPlace,
  height: number,
): number | null {
  const f = geom.frames[place.wallId];
  if (!f || isBoundary(f.wall)) return null;
  const half = ELEC_KINDS[kind].plate.w / 2;
  const span = place.side === 'left' ? f.left : f.right;
  const lo = Math.max(0, span[0]) + half;
  const hi = Math.min(f.length, span[1]) - half;
  if (hi < lo) return null;
  const [bottom, top] = verticalSpan(kind, height);
  // Openings on this wall the point can't overlap at its height.
  const blocks = Object.values(level.openings)
    .filter((o) => o.wallId === place.wallId)
    .filter((o) => {
      const sill = o.kind === 'window' ? o.sill : 0;
      return top > sill + 1e-9 && bottom < sill + o.height - 1e-9;
    })
    .map((o) => {
      const c = o.t * f.length;
      return [c - o.width / 2, c + o.width / 2] as [number, number];
    });
  const ok = (u: number) =>
    u >= lo - 1e-9 &&
    u <= hi + 1e-9 &&
    blocks.every(
      ([s0, s1]) => u + half <= s0 - JAMB_CLEAR + 1e-9 || u - half >= s1 + JAMB_CLEAR - 1e-9,
    );
  const want = Math.min(hi, Math.max(lo, place.along));
  if (ok(want)) return want;
  // Beside each jamb in the way, nearest first.
  const candidates = blocks
    .flatMap(([s0, s1]) => [s0 - JAMB_CLEAR - half, s1 + JAMB_CLEAR + half])
    .filter(ok)
    .sort((p, q) => Math.abs(p - want) - Math.abs(q - want));
  return candidates[0] ?? null;
}

/**
 * Where a point of `kind` goes for a tap at `p`: on the nearest wall face within
 * `tolerance` (0.3 m), at its default height (or `height`), clear of openings. Null with no
 * wall face near, or no room on it.
 */
export function placePoint(
  level: Level,
  kind: ElecKind,
  p: Vec2,
  opts: { geom?: PlanGeometry; tolerance?: number; height?: number } = {},
): (NonNullable<ElecPoint['wall']> & { at: Vec2 }) | null {
  const geom = opts.geom ?? planGeometry(level);
  const tol = opts.tolerance ?? 0.3;
  let best: { place: WallPlace; dist: number; len: number } | null = null;
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
    best = { place: { wallId: w.id, along: u, side }, dist, len };
  }
  if (!best) return null;
  const height = opts.height ?? defaultHeight(level, kind, best.place);
  const along = clearAlong(level, geom, kind, best.place, height);
  if (along === null) return null;
  const t = Math.min(1, Math.max(0, along / best.len));
  const wall = { wallId: best.place.wallId, t, side: best.place.side, height };
  const pos = pointPosition(level, { id: 'probe', kind, wall });
  return { ...wall, at: pos?.at ?? p };
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

/** An aircon unit's trunking on the plan: from the unit, through its bends, to its compressor. */
export function trunkingPath(level: Level, p: ElecPoint): Vec2[] {
  if (p.kind !== 'aircon') return [];
  const start = pointPosition(level, p);
  if (!start) return [];
  const comp = p.compressorId ? level.points[p.compressorId] : undefined;
  const end = comp?.at;
  return [start.at, ...(p.route ?? []), ...(end ? [end] : [])];
}

/** The trunking's length, rounded to 10 cm as a contractor measures it. */
export const trunkingMetres = (level: Level, p: ElecPoint) =>
  Math.round(trunkingLength(trunkingPath(level, p)) * 10) / 10;

const WET = /bath|toilet|\bwc\b|shower/i;

export type PointWarning = 'wet' | 'shelter' | 'structural' | 'no-compressor';

export const WARNING_TEXT: Record<PointWarning, string> = {
  wet: 'A socket in a bathroom or WC: not allowed near water.',
  shelter: 'On the household shelter wall: it can’t be chased or drilled.',
  structural: 'On a structural wall: surface trunking, or check with HDB.',
  'no-compressor': 'No compressor: run its trunking to one.',
};

/**
 * What's wrong with a point: a socket in a bathroom or WC, a point on the shelter's wall or a
 * structural one (judged on `statusOf`, the flat as it is, where the wall is there), or an
 * aircon unit with no compressor.
 */
export function pointWarnings(level: Level, p: ElecPoint, statusOf: Level = level): PointWarning[] {
  const out: PointWarning[] = [];
  if (isSocket(p.kind) && WET.test(pointRoom(level, p) ?? '')) out.push('wet');
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
 * more than 50 mm), removed (gone, a changed kind, or on a hacked wall).
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
  for (const p of Object.values(bp)) {
    const q = ap[p.id];
    if (!q || q.kind !== p.kind || onHacked(p)) removed.push(p);
  }
  for (const q of Object.values(ap)) {
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
