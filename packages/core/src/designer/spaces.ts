import { placeLabel, pointInPolygon } from '../geometry';
import { type PlanGeometry, type WallFrame, openingSpan, planGeometry } from '../plan';
import { roomArea, roomShapes } from '../rooms';
import { type Level, type OpeningKind, type Vec2, isBoundary } from '../schema';
import { type RoomKind, roomKind } from '../suggest';
import type { SpaceKey } from './schema';

/**
 * Spaces: what one room step designs. Rooms joined by room boundaries are one space (an open
 * dry kitchen with the living room); rooms joined by a door or a passage are separate. The
 * shelter, ledges and outdoor rooms, bathrooms (their finishes come with the layout) and
 * rooms under 3 m² aren't spaces.
 */
export interface Space {
  key: SpaceKey;
  /** The largest room's name. */
  name: string;
  /** Room ids, sorted. */
  rooms: string[];
  /** The largest room. */
  main: string;
  kinds: RoomKind[];
  area: number;
}

export const MIN_SPACE_AREA = 3;

/** How far past a wall's face to look for the room on that side. */
const PROBE = 0.05;

/** The room containing a point (not in one of its holes). */
export function roomIdAt(level: Level, p: Vec2): string | null {
  const shapes = roomShapes(level);
  for (const r of Object.values(level.rooms)) {
    const s = shapes.get(r.id);
    if (s && pointInPolygon(p, s.outer) && !s.holes.some((h) => pointInPolygon(p, h))) return r.id;
  }
  return null;
}

/** The room ids on a wall's left (+n) and right sides at its middle, null for outside. */
export function roomsBeside(level: Level, wallId: string): [string | null, string | null] {
  const w = level.walls[wallId];
  const a = w && level.vertices[w.a];
  const b = w && level.vertices[w.b];
  if (!w || !a || !b) return [null, null];
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const off = (isBoundary(w) ? 0 : w.thickness / 2) + PROBE;
  const at = (k: number) => roomIdAt(level, { x: mid.x + n.x * off * k, y: mid.y + n.y * off * k });
  return [at(1), at(-1)];
}

/** Whether a room gets a room step: not the shelter, a ledge, a bathroom or a tiny room. */
export function isDesigned(level: Level, roomId: string): boolean {
  const r = level.rooms[roomId];
  if (!r) return false;
  const kind = roomKind(r.name);
  return kind !== 'none' && kind !== 'bathroom' && roomArea(level, r) >= MIN_SPACE_AREA;
}

/** The level's spaces, top to bottom then left to right. */
export function spacesOf(level: Level): Space[] {
  const designed = Object.keys(level.rooms)
    .filter((id) => isDesigned(level, id))
    .sort();
  const parent = new Map(designed.map((id) => [id, id]));
  const find = (id: string): string => {
    let p = id;
    while (parent.get(p) !== p) p = parent.get(p) as string;
    return p;
  };
  for (const w of Object.values(level.walls)) {
    if (!isBoundary(w)) continue;
    const [l, r] = roomsBeside(level, w.id);
    if (!l || !r || l === r || !parent.has(l) || !parent.has(r)) continue;
    const [pl, pr] = [find(l), find(r)];
    if (pl !== pr) parent.set(pl < pr ? pr : pl, pl < pr ? pl : pr);
  }
  const groups = new Map<string, string[]>();
  for (const id of designed) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);
  const shapes = roomShapes(level);
  const out = [...groups.values()].map((rooms) => {
    const areas = rooms.map((id) => roomArea(level, level.rooms[id]!));
    const main = rooms[areas.indexOf(Math.max(...areas))] as string;
    const s = shapes.get(main);
    const label = s ? placeLabel(s.outer, { x: 0.05, y: 0.05 }, [], s.holes) : { x: 0, y: 0 };
    return {
      space: {
        key: rooms.join('+'),
        name: level.rooms[main]?.name ?? 'Room',
        rooms,
        main,
        kinds: rooms.map((id) => roomKind(level.rooms[id]?.name ?? '')),
        area: areas.reduce((p, q) => p + q, 0),
      },
      label,
    };
  });
  out.sort(
    (p, q) =>
      Math.round(p.label.y * 10) - Math.round(q.label.y * 10) ||
      p.label.x - q.label.x ||
      (p.space.key < q.space.key ? -1 : 1),
  );
  return out.map((o) => o.space);
}

/** The space a room is in, if any. */
export const spaceOfRoom = (spaces: Space[], roomId: string | null) =>
  roomId ? spaces.find((s) => s.rooms.includes(roomId)) : undefined;

/** An opening on a face: where it cuts the wall (along it) and how high it is. */
export interface FaceOpening {
  id: string;
  kind: OpeningKind;
  u0: number;
  u1: number;
  sill: number;
  top: number;
}

/** A wall's face towards a space: the side (+1 left, -1 right), where it runs along the wall. */
export interface Face {
  wallId: string;
  side: 1 | -1;
  roomId: string;
  frame: WallFrame;
  /** The face's extent along the wall, between its inside corners. */
  u0: number;
  u1: number;
  openings: FaceOpening[];
}

/** Every wall face towards one of `rooms` (room boundaries have none). */
export function facesOf(level: Level, rooms: string[], geom = planGeometry(level)): Face[] {
  const inSpace = new Set(rooms);
  const out: Face[] = [];
  for (const w of Object.values(level.walls)) {
    if (isBoundary(w)) continue;
    const f = geom.frames[w.id];
    if (!f) continue;
    const [left, right] = roomsBeside(level, w.id);
    for (const [side, roomId] of [
      [1, left],
      [-1, right],
    ] as const) {
      if (!roomId || !inSpace.has(roomId)) continue;
      const [u0, u1] = side === 1 ? f.left : f.right;
      out.push({
        wallId: w.id,
        side,
        roomId,
        frame: f,
        u0,
        u1,
        openings: openingsOn(geom, w.id),
      });
    }
  }
  return out.sort((p, q) => (p.wallId < q.wallId ? -1 : p.wallId > q.wallId ? 1 : p.side - q.side));
}

function openingsOn(geom: PlanGeometry, wallId: string): FaceOpening[] {
  return geom.openings
    .filter((o) => o.wallId === wallId)
    .map((o) => {
      const [u0, u1] = openingSpan(o.frame, o.opening);
      return {
        id: o.opening.id,
        kind: o.kind,
        u0,
        u1,
        sill: o.opening.sill,
        top: o.opening.sill + o.opening.height,
      };
    })
    .sort((p, q) => p.u0 - q.u0);
}

/** Where a face is clear for a piece standing from `bottom` to `top`: stretches along the wall. */
export function clearStretches(face: Face, bottom: number, top: number): [number, number][] {
  // Under a window only if the piece is lower than its sill, less 20 mm.
  const blocked = face.openings
    .filter((o) => (o.kind === 'window' ? top > o.sill - 0.02 && bottom < o.top : bottom < o.top))
    .map((o) => [o.u0, o.u1] as [number, number]);
  let spans: [number, number][] = [[face.u0, face.u1]];
  for (const [b0, b1] of blocked) {
    spans = spans.flatMap(([s0, s1]): [number, number][] => {
      if (b1 <= s0 || b0 >= s1) return [[s0, s1]];
      const out: [number, number][] = [];
      if (b0 > s0) out.push([s0, b0]);
      if (b1 < s1) out.push([b1, s1]);
      return out;
    });
  }
  return spans.filter(([s0, s1]) => s1 - s0 > 0.01);
}
