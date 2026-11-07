import { isDraft } from 'immer';
import { type RoomEntry, roomEntries } from './delivery';
import { furnitureKind, itemFootprint } from './furniture';
import { openingsOnWall, pointInPolygon } from './geometry';
import { type PlanGeometry, framePoint, openingSpan, planGeometry } from './plan';
import { type RoomShape, roomShapes } from './rooms';
import { type Item, type Level, type Vec2, isBoundary } from './schema';

/**
 * The faces of a room: the straight runs of its outline, named A, B, C… clockwise on the plan
 * from the one you come in by, each seen from inside the room (what is on your left is on the
 * left: `u` runs from the face's left end, `v` into the room). Spec: docs/specs/elevation.md.
 */

/** Edges of an outline within this angle of each other are one run. */
export const FACE_ANGLE = (1 * Math.PI) / 180;
/** …and with their face lines within this of each other. */
export const FACE_OFFSET = 0.01;
/** Stepping round a room skips faces shorter than this that hold nothing. */
export const MIN_STEP_FACE = 0.3;
/** How far into the room a piece is in front of a face. */
export const DEPTH = 0.65;
/** A piece with its back this close to a face is against it. */
export const AGAINST = 0.1;
/** A piece this close names the wall it is by ("bed wall", "TV wall"). */
const NAMES_WALL = 0.3;

export interface FaceStretch {
  wallId: string;
  side: 'left' | 'right';
  /** Along the wall from its vertex a (the wall frame's u), from < to. */
  from: number;
  to: number;
  /** Along the face from its left end, u0 < u1. */
  u0: number;
  u1: number;
  /** A room boundary (no wall). */
  boundary: boolean;
}

/**
 * 'wall': a run of walls and boundaries; 'return': a step in the outline between two runs in
 * line (where walls of different thickness meet, the junction's edge), with no wall of its
 * own; 'hole': a face of a column or other enclosure standing in the room.
 */
export type FaceKind = 'wall' | 'return' | 'hole';

export interface RoomFace {
  roomId: string;
  /** Its place in `roomFaces`. */
  index: number;
  letter: string;
  /** A friendly name ("bed wall"), or null. */
  label: string | null;
  kind: FaceKind;
  /** May be empty (a return). */
  stretches: FaceStretch[];
  /** The face's ends, inside corner to inside corner, as you look at it. */
  left: Vec2;
  right: Vec2;
  /** Unit vectors: along the face from left to right, and out of it into the room. */
  dir: Vec2;
  normal: Vec2;
  length: number;
  /** The room's ceiling height. */
  ceiling: number;
  /** Whether stepping round the room stops at it. */
  steppable: boolean;
  /** For a face that is all room boundary: the room it is open to (id), or null. */
  openTo: string | null;
}

/**
 * Which face is meant, kept by a viewer across edits: the room, the wall side it was opened
 * from (null for a return), and where its middle was and which way it faced, to find it again
 * when that wall is split or redrawn, or in the other version of a renovation.
 */
export interface FaceRef {
  roomId: string;
  wallId: string | null;
  side: 'left' | 'right' | null;
  mid: Vec2;
  normal: Vec2;
}

const dot = (p: Vec2, q: Vec2) => p.x * q.x + p.y * q.y;
const sub = (p: Vec2, q: Vec2): Vec2 => ({ x: p.x - q.x, y: p.y - q.y });
const unit = (p: Vec2): Vec2 => {
  const l = Math.hypot(p.x, p.y) || 1;
  return { x: p.x / l, y: p.y / l };
};

/** A point's place seen on a face: along it from its left end, and out into the room. */
export function faceUV(
  face: Pick<RoomFace, 'left' | 'dir' | 'normal'>,
  p: Vec2,
): { u: number; v: number } {
  const d = sub(p, face.left);
  return { u: dot(d, face.dir), v: dot(d, face.normal) };
}

/** The face's letter for its place in the list: A to Z, then AA, AB… */
export function faceLetter(i: number): string {
  const a = String.fromCharCode(65 + (i % 26));
  return i < 26 ? a : `${String.fromCharCode(65 + Math.floor(i / 26) - 1)}${a}`;
}

/** What a face is called on screen: its letter and name, "C · bed wall", or "Wall C". */
export function faceTitle(face: Pick<RoomFace, 'letter' | 'label'>): string {
  return face.label ? `${face.letter} · ${face.label}` : `Wall ${face.letter}`;
}

/** Per frozen level: the geometry, rooms' faces and lookups, made once. */
interface Ctx {
  level: Level;
  geom: PlanGeometry;
  shapes: Map<string, RoomShape>;
  wallByPair: Map<string, string>;
  faces: Map<string, RoomFace[]>;
  items: Map<string, Item[]>;
  bySide: Map<string, RoomFace> | null;
  entries: Map<string, RoomEntry> | null;
}

const ctxCache = new WeakMap<object, Ctx>();

function ctxOf(level: Level): Ctx {
  const cacheable = !isDraft(level) && Object.isFrozen(level);
  const cached = cacheable && ctxCache.get(level);
  if (cached) return cached;
  const wallByPair = new Map<string, string>();
  for (const w of Object.values(level.walls)) {
    if (w.a === w.b) continue;
    const key = w.a < w.b ? `${w.a}|${w.b}` : `${w.b}|${w.a}`;
    if (!wallByPair.has(key)) wallByPair.set(key, w.id);
  }
  const ctx: Ctx = {
    level,
    geom: planGeometry(level),
    shapes: roomShapes(level),
    wallByPair,
    faces: new Map(),
    items: new Map(),
    bySide: null,
    entries: null,
  };
  if (cacheable) ctxCache.set(level, ctx);
  return ctx;
}

/** The level's plan geometry, shared with its faces (made once per frozen level). */
export const faceGeometry = (level: Level): PlanGeometry => ctxOf(level).geom;

interface Seg {
  p: Vec2;
  q: Vec2;
  d: Vec2;
  wallId: string;
  side: 'left' | 'right';
  from: number;
  to: number;
  boundary: boolean;
}

/** The outline's edges as face segments, in loop order (the room on their left). */
function segsOf(ctx: Ctx, loop: readonly string[]): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < loop.length; i++) {
    const va = loop[i] as string;
    const vb = loop[(i + 1) % loop.length] as string;
    const id = ctx.wallByPair.get(va < vb ? `${va}|${vb}` : `${vb}|${va}`);
    const w = id ? ctx.level.walls[id] : undefined;
    const f = id ? ctx.geom.frames[id] : undefined;
    if (!w || !f) continue;
    const side = w.a === va ? 'left' : 'right';
    const boundary = isBoundary(w);
    const span: [number, number] = boundary ? [0, f.length] : side === 'left' ? f.left : f.right;
    const k = boundary ? 0 : side === 'left' ? 1 : -1;
    const a = framePoint(f, span[0], k);
    const b = framePoint(f, span[1], k);
    const [p, q] = side === 'left' ? [a, b] : [b, a];
    if (Math.hypot(q.x - p.x, q.y - p.y) < 1e-6) continue;
    out.push({
      p,
      q,
      d: unit(sub(q, p)),
      wallId: w.id,
      side,
      from: span[0],
      to: span[1],
      boundary,
    });
  }
  return out;
}

/** Whether segment `s` carries on the run of `group` (in line, the same sort of edge). */
function inLine(group: Seg[], s: Seg): boolean {
  const g = group[0] as Seg;
  if (g.boundary !== s.boundary) return false;
  if (dot(g.d, s.d) < Math.cos(FACE_ANGLE) - 1e-12) return false;
  const n = { x: -g.d.y, y: g.d.x };
  return (
    Math.abs(dot(sub(s.p, g.p), n)) <= FACE_OFFSET + 1e-9 &&
    Math.abs(dot(sub(s.q, g.p), n)) <= FACE_OFFSET + 1e-9
  );
}

type Draft = Omit<RoomFace, 'index' | 'letter' | 'label' | 'steppable'>;

function faceOf(
  roomId: string,
  kind: FaceKind,
  segs: Seg[],
  ceiling: number,
  ends?: [Vec2, Vec2],
): Draft {
  const left = ends ? ends[0] : (segs[0] as Seg).p;
  const right = ends ? ends[1] : (segs[segs.length - 1] as Seg).q;
  const length = Math.hypot(right.x - left.x, right.y - left.y);
  const dir = length > 1e-9 ? unit(sub(right, left)) : (segs[0]?.d ?? { x: 1, y: 0 });
  const normal = { x: -dir.y, y: dir.x };
  const base = { left, dir, normal };
  const stretches = segs.map((s): FaceStretch => {
    const a = faceUV(base, s.p).u;
    const b = faceUV(base, s.q).u;
    return {
      wallId: s.wallId,
      side: s.side,
      from: s.from,
      to: s.to,
      u0: Math.min(a, b),
      u1: Math.max(a, b),
      boundary: s.boundary,
    };
  });
  return {
    roomId,
    kind,
    stretches,
    left,
    right,
    dir,
    normal,
    length,
    ceiling,
    openTo: null,
  };
}

/** A loop's faces: runs in line merged, a return wherever two runs in line step apart. */
function loopFaces(ctx: Ctx, roomId: string, loop: readonly string[], hole: boolean): Draft[] {
  const segs = segsOf(ctx, loop);
  if (segs.length === 0) return [];
  const groups: Seg[][] = [];
  for (const s of segs) {
    const last = groups[groups.length - 1];
    if (last && inLine(last, s)) last.push(s);
    else groups.push([s]);
  }
  // The loop may start mid-run: its last run carries on into its first.
  if (groups.length > 1) {
    const last = groups[groups.length - 1] as Seg[];
    const first = groups[0] as Seg[];
    if (last.every((s) => inLine(first, s))) {
      groups.pop();
      groups[0] = [...last, ...first];
    }
  }
  const room = ctx.level.rooms[roomId];
  const ceiling = room?.ceilingHeight ?? ctx.level.ceilingHeight;
  const kind: FaceKind = hole ? 'hole' : 'wall';
  const out: Draft[] = [];
  groups.forEach((g, i) => {
    out.push(faceOf(roomId, kind, g, ceiling));
    const next = groups[(i + 1) % groups.length] as Seg[];
    if (groups.length < 2) return;
    const end = (g[g.length - 1] as Seg).q;
    const start = (next[0] as Seg).p;
    const a = g[g.length - 1] as Seg;
    const b = next[0] as Seg;
    // A step between two runs in line (or nearly), with walls both sides: a return.
    const parallel = Math.abs(dot(a.d, b.d)) > Math.cos(FACE_ANGLE) - 1e-12;
    if (
      !a.boundary &&
      !b.boundary &&
      parallel &&
      Math.hypot(start.x - end.x, start.y - end.y) > 0.001
    ) {
      out.push(faceOf(roomId, hole ? 'hole' : 'return', [], ceiling, [end, start]));
    }
  });
  return out;
}

/** The room at a point (not in a hole). */
function roomAt(ctx: Ctx, p: Vec2): string | null {
  for (const r of Object.values(ctx.level.rooms)) {
    const s = ctx.shapes.get(r.id);
    if (s && pointInPolygon(p, s.outer) && !s.holes.some((h) => pointInPolygon(p, h))) return r.id;
  }
  return null;
}

/** A room's items: those whose centre is in the room (not in an enclosure in it). Cached. */
export function roomItems(level: Level, roomId: string): Item[] {
  const ctx = ctxOf(level);
  const hit = ctx.items.get(roomId);
  if (hit) return hit;
  const s = ctx.shapes.get(roomId);
  const out = s
    ? Object.values(level.items).filter((it) => {
        const c = { x: it.position.x, y: it.position.z };
        return pointInPolygon(c, s.outer) && !s.holes.some((h) => pointInPolygon(c, h));
      })
    : [];
  ctx.items.set(roomId, out);
  return out;
}

/** A piece's footprint seen on a face: its spans along it and out from it. */
export function itemBand(
  face: Pick<RoomFace, 'left' | 'dir' | 'normal'>,
  item: Item,
): { u0: number; u1: number; v0: number; v1: number } {
  const uv = itemFootprint(item).map((p) => faceUV(face, p));
  return {
    u0: Math.min(...uv.map((x) => x.u)),
    u1: Math.max(...uv.map((x) => x.u)),
    v0: Math.min(...uv.map((x) => x.v)),
    v1: Math.max(...uv.map((x) => x.v)),
  };
}

const overlapsFace = (face: Draft, u0: number, u1: number) =>
  Math.min(u1, face.length) - Math.max(u0, 0) > 1e-3;

const TV = /(^|-)tv(-|$)/;

/** What a face holds that names it, and whether it holds anything at all. */
function contents(
  ctx: Ctx,
  face: Draft,
  items: Item[],
): {
  hasWindow: boolean;
  holds: boolean;
  bed: boolean;
  tv: boolean;
  sink: boolean;
  hob: boolean;
  wardrobe: boolean;
} {
  let hasWindow = false;
  let holds = false;
  for (const s of face.stretches) {
    if (s.boundary) continue;
    const f = ctx.geom.frames[s.wallId];
    if (!f) continue;
    for (const o of openingsOnWall(ctx.level, s.wallId)) {
      const [a, b] = openingSpan(f, o);
      if (Math.min(b, s.to) - Math.max(a, s.from) <= 1e-3) continue;
      holds = true;
      if (o.kind === 'window') hasWindow = true;
    }
  }
  if (!holds) {
    holds = Object.values(ctx.level.points ?? {}).some(
      (p) =>
        p.wall && face.stretches.some((s) => s.wallId === p.wall?.wallId && s.side === p.wall.side),
    );
  }
  const found = { bed: false, tv: false, sink: false, hob: false, wardrobe: false };
  for (const it of items) {
    const band = itemBand(face, it);
    if (!overlapsFace(face, band.u0, band.u1) || band.v0 > DEPTH || band.v1 < -0.05) continue;
    holds = true;
    if (band.v0 > NAMES_WALL) continue;
    const kind = furnitureKind(it.assetId);
    if (!kind) continue;
    if (kind.comesFlat === 'bed' || kind.shape === 'bed') {
      // Its head (back) against the face: it faces out into the room.
      const facing = { x: -Math.sin(it.rotationY), y: Math.cos(it.rotationY) };
      if (dot(facing, face.normal) > Math.cos(FACE_ANGLE * 5)) found.bed = true;
    }
    if (TV.test(it.assetId)) found.tv = true;
    if (it.assetId === 'kitchen-sink') found.sink = true;
    if (it.assetId === 'kitchen-hob') found.hob = true;
    if (it.assetId === 'built-in-wardrobe') found.wardrobe = true;
  }
  return { hasWindow, holds, ...found };
}

function entriesOf(ctx: Ctx): Map<string, RoomEntry> {
  if (!ctx.entries) ctx.entries = roomEntries(ctx.level, ctx.geom).entries;
  return ctx.entries;
}

/**
 * A room's faces: its outline's straight runs (consecutive edges within 1° whose face lines are
 * within 10 mm), clockwise on the plan from A, the face you come in by (the door on the way in
 * from the main door, or the boundary it is open across; with neither, the face nearest the
 * top of the plan, then the leftmost), with a return between runs in line that step apart, and
 * then the faces of each enclosure standing in it. Each with its ends, length, normal into the
 * room, the room's ceiling and a friendly name. Cached per frozen level.
 */
export function roomFaces(level: Level, roomId: string): RoomFace[] {
  const ctx = ctxOf(level);
  const hit = ctx.faces.get(roomId);
  if (hit) return hit;
  const room = level.rooms[roomId];
  const shape = ctx.shapes.get(roomId);
  if (!room || !shape) return [];
  const outline = loopFaces(ctx, roomId, room.loop, false);
  const holes = shape.holeLoops.flatMap((h) => loopFaces(ctx, roomId, h, true));
  for (const f of [...outline, ...holes]) {
    if (f.stretches.length && f.stretches.every((s) => s.boundary)) {
      const mid = { x: (f.left.x + f.right.x) / 2, y: (f.left.y + f.right.y) / 2 };
      f.openTo = roomAt(ctx, { x: mid.x - f.normal.x * 0.1, y: mid.y - f.normal.y * 0.1 });
    }
  }
  // Face A: the way in.
  const entry = entriesOf(ctx).get(roomId);
  const door = entry?.door?.o;
  const walls = outline.map((f, i) => ({ f, i })).filter(({ f }) => f.kind === 'wall');
  let start = -1;
  if (door)
    start = walls.find(({ f }) => f.stretches.some((s) => s.wallId === door.wallId))?.i ?? -1;
  if (start < 0 && entry?.openTo) {
    start = walls.find(({ f }) => f.openTo === entry.openTo)?.i ?? -1;
  }
  if (start < 0) {
    const mid = (f: Draft) => ({ x: (f.left.x + f.right.x) / 2, y: (f.left.y + f.right.y) / 2 });
    const top = [...walls].sort((a, b) => {
      const p = mid(a.f);
      const q = mid(b.f);
      return Math.abs(p.y - q.y) > 1e-3 ? p.y - q.y : p.x - q.x;
    })[0];
    start = top?.i ?? 0;
  }
  const ordered = [...outline.slice(start), ...outline.slice(0, start), ...holes];
  const items = roomItems(level, roomId);
  const names = (f: Draft): { label: string | null; holds: boolean } => {
    const c = contents(ctx, f, items);
    const isDoor = !!door && f.stretches.some((s) => s.wallId === door.wallId);
    const open = f.openTo ? level.rooms[f.openTo]?.name : undefined;
    const label = isDoor
      ? 'door wall'
      : c.bed
        ? 'bed wall'
        : c.tv
          ? 'TV wall'
          : c.sink
            ? 'sink wall'
            : c.hob
              ? 'hob wall'
              : c.wardrobe
                ? 'wardrobe wall'
                : c.hasWindow
                  ? 'window wall'
                  : open
                    ? `open to ${open}`
                    : null;
    return { label, holds: c.holds || isDoor };
  };
  const faces = ordered.map((f, i): RoomFace => {
    const { label, holds } = names(f);
    return {
      ...f,
      index: i,
      letter: faceLetter(i),
      label,
      steppable: f.length >= MIN_STEP_FACE - 1e-9 || holds,
    };
  });
  ctx.faces.set(roomId, faces);
  return faces;
}

/** Every room's faces, by wall side (`wallId|side`). */
function bySide(ctx: Ctx): Map<string, RoomFace> {
  if (ctx.bySide) return ctx.bySide;
  const out = new Map<string, RoomFace>();
  for (const id of Object.keys(ctx.level.rooms)) {
    for (const f of roomFaces(ctx.level, id)) {
      for (const s of f.stretches) {
        const key = `${s.wallId}|${s.side}`;
        if (!out.has(key)) out.set(key, f);
      }
    }
  }
  ctx.bySide = out;
  return out;
}

/** The face a wall side belongs to, or null if no room faces it (an outside face). */
export function faceAt(level: Level, wallId: string, side: 'left' | 'right'): RoomFace | null {
  return bySide(ctxOf(level)).get(`${wallId}|${side}`) ?? null;
}

/** The wall sides of a wall that face a room: [left, right], null where none does. */
export function wallFaceSides(level: Level, wallId: string): [RoomFace | null, RoomFace | null] {
  return [faceAt(level, wallId, 'left'), faceAt(level, wallId, 'right')];
}

/** A face's middle. */
export const faceMid = (f: Pick<RoomFace, 'left' | 'right'>): Vec2 => ({
  x: (f.left.x + f.right.x) / 2,
  y: (f.left.y + f.right.y) / 2,
});

/** What a viewer keeps to find this face again. */
export function faceRef(face: RoomFace): FaceRef {
  const solid = face.stretches.filter((s) => !s.boundary);
  const pick = [...(solid.length ? solid : face.stretches)].sort(
    (a, b) => b.u1 - b.u0 - (a.u1 - a.u0),
  )[0];
  return {
    roomId: face.roomId,
    wallId: pick?.wallId ?? null,
    side: pick?.side ?? null,
    mid: faceMid(face),
    normal: { ...face.normal },
  };
}

/**
 * The face a ref means on `level`: the face of the same wall side, or failing that (the wall
 * split, redrawn, or the other version of a renovation) the face on the same line (within
 * 10 mm and 1°) that faces the same way and runs past the ref's middle, the same room first.
 * Null if there is none ("That wall is gone").
 */
export function resolveFace(level: Level, ref: FaceRef): RoomFace | null {
  if (ref.wallId && ref.side) {
    const f = faceAt(level, ref.wallId, ref.side);
    if (f) return f;
  }
  let best: { f: RoomFace; score: number } | null = null;
  const rooms = Object.keys(level.rooms);
  for (const id of rooms) {
    for (const f of roomFaces(level, id)) {
      if (dot(f.normal, ref.normal) < Math.cos(FACE_ANGLE) - 1e-12) continue;
      const { u, v } = faceUV(f, ref.mid);
      if (Math.abs(v) > FACE_OFFSET + 1e-9) continue;
      if (u < -FACE_OFFSET || u > f.length + FACE_OFFSET) continue;
      const score = (f.roomId === ref.roomId ? 0 : 1) + Math.abs(v);
      if (!best || score < best.score) best = { f, score };
    }
  }
  return best?.f ?? null;
}

/** The next face round the room that stepping stops at (`by` +1 or -1), wrapping round. */
export function stepFace(faces: readonly RoomFace[], from: RoomFace, by: 1 | -1): RoomFace {
  const n = faces.length;
  for (let k = 1; k <= n; k++) {
    const f = faces[(((from.index + by * k) % n) + n) % n] as RoomFace;
    if (f.steppable) return f;
  }
  return from;
}

/** The faces stepping stops at, in order. */
export const steppableFaces = (faces: readonly RoomFace[]): RoomFace[] =>
  faces.filter((f) => f.steppable);

/** The other side of a face's wall, when a room faces it: the same wall seen from that room. */
export function otherSide(level: Level, face: RoomFace): RoomFace | null {
  for (const s of face.stretches) {
    if (s.boundary) continue;
    const f = faceAt(level, s.wallId, s.side === 'left' ? 'right' : 'left');
    if (f) return f;
  }
  return null;
}
