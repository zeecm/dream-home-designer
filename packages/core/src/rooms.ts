import { type Draft, isDraft } from 'immer';
import { placeLabel, pointInPolygon, signedArea } from './geometry';
import type { Level, Room, Vec2 } from './schema';

/** Faces smaller than this are slivers between nearly coincident walls, not rooms. */
export const MIN_ROOM_AREA = 0.25;

type LevelLike = Pick<Level, 'vertices' | 'walls'>;

/**
 * Finds the enclosed spaces of the wall graph: its bounded faces, as loops of vertex ids.
 *
 * Walls already meet at shared vertices (the wall tool splits walls where they cross),
 * so the graph is planar as stored. Dead-end walls are pruned first; then each directed
 * edge is walked by always taking the next edge clockwise at the far vertex, which traces
 * every face once with its interior on the left. Bounded faces wind counter-clockwise
 * (positive area); each component's outer boundary winds the other way and is dropped.
 */
export function detectFaces(level: LevelLike): string[][] {
  return traceFaces(level).faces;
}

/**
 * The bounded faces (counter-clockwise) and, for each connected group of walls that encloses
 * anything, its outer boundary (clockwise), as loops of vertex ids.
 */
function traceFaces(level: LevelLike): { faces: string[][]; outers: string[][] } {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)?.add(b);
  };
  for (const w of Object.values(level.walls)) {
    if (w.a === w.b || !level.vertices[w.a] || !level.vertices[w.b]) continue;
    link(w.a, w.b);
    link(w.b, w.a);
  }

  // Prune dead ends (a wall sticking into a room, or a lone wall) until none are left.
  const queue = [...adj.keys()].filter((v) => (adj.get(v)?.size ?? 0) < 2);
  while (queue.length) {
    const v = queue.pop() as string;
    const ns = adj.get(v);
    if (!ns) continue;
    adj.delete(v);
    for (const n of ns) {
      const nn = adj.get(n);
      nn?.delete(v);
      if (nn && nn.size < 2) queue.push(n);
    }
  }

  const pos = (id: string) => level.vertices[id] as Vec2;
  const sorted = new Map<string, string[]>();
  for (const [v, ns] of adj) {
    const p = pos(v);
    sorted.set(
      v,
      [...ns].sort((a, b) => {
        const pa = pos(a);
        const pb = pos(b);
        return Math.atan2(pa.y - p.y, pa.x - p.x) - Math.atan2(pb.y - p.y, pb.x - p.x);
      }),
    );
  }

  const seen = new Set<string>();
  const faces: string[][] = [];
  const outers: string[][] = [];
  for (const [u, ns] of sorted) {
    for (const v of ns) {
      if (seen.has(`${u}>${v}`)) continue;
      const loop: string[] = [];
      let a = u;
      let b = v;
      for (let guard = 0; guard < 10_000 && !seen.has(`${a}>${b}`); guard++) {
        seen.add(`${a}>${b}`);
        loop.push(a);
        const around = sorted.get(b) as string[];
        const i = around.indexOf(a);
        const next = around[(i - 1 + around.length) % around.length] as string;
        a = b;
        b = next;
      }
      const area = signedArea(loop.map(pos));
      if (area > MIN_ROOM_AREA) faces.push(loop);
      else if (area < -MIN_ROOM_AREA) outers.push(loop);
    }
  }
  return { faces, outers };
}

/**
 * Which outer boundaries are holes in which faces: a group of walls standing free inside a
 * room (a shelter or a column not touching the room's walls) is a hole in the smallest face
 * around it. Returns, per face index, the boundaries it loses.
 */
function assignHoles(
  faces: readonly string[][],
  outers: readonly string[][],
  pos: (id: string) => Vec2,
): Map<number, string[][]> {
  const polys = faces.map((loop) => loop.map(pos));
  const areas = polys.map((p) => Math.abs(signedArea(p)));
  const holes = new Map<number, string[][]>();
  for (const outer of outers) {
    const ids = new Set(outer);
    const pts = outer.map(pos);
    let best = -1;
    faces.forEach((loop, fi) => {
      if (loop.some((id) => ids.has(id))) return; // the same group of walls
      const poly = polys[fi] as Vec2[];
      if (!pts.every((p) => pointInPolygon(p, poly))) return;
      if (best < 0 || (areas[fi] as number) < (areas[best] as number)) best = fi;
    });
    if (best >= 0) holes.set(best, [...(holes.get(best) ?? []), outer]);
  }
  return holes;
}

export interface RoomShape {
  outer: Vec2[];
  /** Free-standing enclosures inside the room, which are not part of its floor. */
  holes: Vec2[][];
}

const shapeCache = new WeakMap<object, Map<string, RoomShape>>();

/**
 * Every room's outline and holes. Cached per level object, so call it freely on immutable
 * levels; a draft inside a recipe is measured afresh each time.
 */
export function roomShapes(level: Level): Map<string, RoomShape> {
  const cached = !isDraft(level) && shapeCache.get(level);
  if (cached) return cached;
  const pos = (id: string) => {
    const v = level.vertices[id];
    if (!v) throw new Error(`missing vertex ${id}`);
    return { x: v.x, y: v.y };
  };
  const rooms = Object.values(level.rooms).filter((r) => r.loop.every((id) => level.vertices[id]));
  const { outers } = traceFaces(level);
  const holes = assignHoles(
    rooms.map((r) => r.loop),
    outers,
    pos,
  );
  const out = new Map<string, RoomShape>();
  rooms.forEach((r, i) => {
    out.set(r.id, { outer: r.loop.map(pos), holes: (holes.get(i) ?? []).map((h) => h.map(pos)) });
  });
  if (!isDraft(level)) shapeCache.set(level, out);
  return out;
}

/** The room's outline and holes; an empty shape if its loop references a missing corner. */
export function roomShape(level: Level, room: Room): RoomShape {
  return roomShapes(level).get(room.id) ?? { outer: [], holes: [] };
}

/** Floor area in m², measured to wall centre lines, less any free-standing enclosures. */
export function roomArea(level: Level, room: Room): number {
  const s = roomShape(level, room);
  return (
    Math.abs(signedArea(s.outer)) - s.holes.reduce((sum, h) => sum + Math.abs(signedArea(h)), 0)
  );
}

/** FNV-1a, base 36: a stable id from a room's corners so recipes stay deterministic. */
function roomIdFor(loop: string[]): string {
  let h = 0x811c9dc5;
  for (const ch of [...loop].sort().join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `rm_${h.toString(36).padStart(7, '0')}`;
}

function nextRoomName(rooms: Iterable<Room>): string {
  const used = new Set<number>();
  for (const r of rooms) {
    const m = /^Room (\d+)$/.exec(r.name);
    if (m) used.add(Number(m[1]));
  }
  let n = 1;
  while (used.has(n)) n++;
  return `Room ${n}`;
}

/**
 * Makes the level's rooms match the faces of its wall graph, keeping each existing room's
 * id, name and materials when its space survives an edit. A face inherits from the old
 * room whose label point it contains, preferring the one that covered most of it (so two
 * rooms merged by deleting a wall keep the larger one's name), with shared corners as the
 * tie-break. A room split in two keeps its identity in the half that holds its label
 * point; the other half becomes a new "Room N". Rooms whose space is gone are removed.
 *
 * Call this inside a command's recipe after changing walls, so undo restores both.
 */
export function syncRooms(lvl: Draft<Level>): void {
  const traced = traceFaces(lvl);
  const faces = traced.faces;
  const pos = (id: string) => lvl.vertices[id] as Vec2;
  const faceHoles = assignHoles(faces, traced.outers, pos);
  const oldRooms = Object.values(lvl.rooms).filter((r) => r.loop.every((id) => lvl.vertices[id]));
  const oldHoles = assignHoles(
    oldRooms.map((r) => r.loop),
    traced.outers,
    pos,
  );
  const old = oldRooms.map((room, ri) => {
    const poly = room.loop.map(pos);
    const holes = (oldHoles.get(ri) ?? []).map((h) => h.map(pos));
    return {
      room,
      corners: new Set(room.loop),
      // A point inside the room's floor, never inside an enclosure standing in it.
      label: placeLabel(poly, { x: 0, y: 0 }, [], holes),
      area: Math.abs(signedArea(poly)) - holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0),
    };
  });

  type Match = { face: number; room: number; score: number };
  const candidates: Match[] = [];
  faces.forEach((loop, fi) => {
    const poly = loop.map(pos);
    const holes = (faceHoles.get(fi) ?? []).map((h) => h.map(pos));
    const faceArea =
      Math.abs(signedArea(poly)) - holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0);
    const contains = (p: Vec2) =>
      pointInPolygon(p, poly) && !holes.some((h) => pointInPolygon(p, h));
    old.forEach((o, ri) => {
      const shared = loop.filter((id) => o.corners.has(id)).length;
      const jaccard = shared / (loop.length + o.corners.size - shared);
      const inside = contains(o.label);
      if (!inside && jaccard < 0.6) return;
      const coverage = Math.min(o.area, faceArea) / Math.max(o.area, faceArea, 1e-9);
      candidates.push({
        face: fi,
        room: ri,
        score: (inside ? 1 : 0) + 0.5 * coverage + 0.05 * jaccard,
      });
    });
  });
  candidates.sort((p, q) => q.score - p.score || p.face - q.face || p.room - q.room);

  const faceRoom = new Map<number, number>();
  const usedRooms = new Set<number>();
  for (const c of candidates) {
    if (faceRoom.has(c.face) || usedRooms.has(c.room)) continue;
    faceRoom.set(c.face, c.room);
    usedRooms.add(c.room);
  }

  const next: Record<string, Room> = {};
  faces.forEach((loop, fi) => {
    const ri = faceRoom.get(fi);
    const prev = ri === undefined ? undefined : old[ri]?.room;
    if (prev) {
      const sameLoop =
        prev.loop.length === loop.length && prev.loop.every((id) => loop.includes(id));
      next[prev.id] = sameLoop ? { ...prev } : { ...prev, loop };
      return;
    }
    let id = roomIdFor(loop);
    while (next[id] || lvl.rooms[id]) id = `${id}x`;
    next[id] = {
      id,
      name: nextRoomName([...Object.values(next), ...Object.values(lvl.rooms)]),
      loop,
      floorMaterial: 'wood-oak',
      ceilingMaterial: 'paint-white',
    };
  });

  for (const id of Object.keys(lvl.rooms)) {
    if (!next[id]) delete lvl.rooms[id];
  }
  for (const [id, room] of Object.entries(next)) {
    const cur = lvl.rooms[id];
    if (!cur) {
      lvl.rooms[id] = room;
    } else if (cur.loop.join() !== room.loop.join()) {
      cur.loop = room.loop;
    }
  }
}
