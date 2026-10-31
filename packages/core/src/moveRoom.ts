import { pointInPolygon } from './geometry';
import type { Command } from './history';
import { newId } from './ids';
import { draftLevel } from './levels';
import { roomShapes, syncRooms } from './rooms';
import type { Item, Level, Opening, Room, Vec2, Vertex, Wall } from './schema';
import { MIN_JOINED, band, segmentDistance } from './shiftWall';
import { reclampOpenings } from './topology';

/**
 * Moving a whole room, as dragging a selected room's handle does: its corners, everything
 * standing inside it (walls, enclosures, furniture) and the doors and windows in its walls go
 * together.
 *
 * A room standing alone moves freely. A room joined to others moves along one axis at a time,
 * so that walls joined to it never slant: a joined wall running the way the room moves
 * stretches or shrinks; where one runs across the move, its corner stays, and the room's wall
 * leaves it with a short step along the move (as a moved wall steps where another carries
 * straight on). A wall the room shares with a neighbour moves with it, so the neighbour grows
 * or shrinks.
 */

export type Axis = 'x' | 'y';

/** What moving a room carries and changes, worked out once as the move begins. */
export interface RoomMove {
  /** Null: anywhere (a room standing alone); otherwise along this axis only. */
  axis: Axis | null;
  /** Corners that move with the room. */
  vertices: string[];
  items: string[];
  /**
   * Corners that stay, where a joined wall runs across the move: the room's walls leave each
   * for a new corner (`vertex`), joined back to it by a new wall (`wall`).
   */
  steps: { corner: string; vertex: string; wall: string }[];
  /** Corners of the room that stay, its wall sliding along through them. */
  stays: string[];
}

/** Two directions within about a degree count as running the same way. */
const PARALLEL = Math.sin(Math.PI / 180);

const dirOf = (axis: Axis): Vec2 => (axis === 'x' ? { x: 1, y: 0 } : { x: 0, y: 1 });

/** Whether the segment p–q runs along `d` (a unit vector), either way. */
function along(p: Vec2, q: Vec2, d: Vec2): boolean {
  const l = Math.hypot(q.x - p.x, q.y - p.y);
  return l > 1e-9 && Math.abs((q.x - p.x) * d.y - (q.y - p.y) * d.x) / l < PARALLEL;
}

/** The corners on the room's outline or inside it, and the furniture standing in it. */
function carried(level: Level, roomId: string): { vertices: Set<string>; items: string[] } {
  const room = level.rooms[roomId];
  const outer = room && roomShapes(level).get(roomId)?.outer;
  if (!room || !outer || outer.length < 3) return { vertices: new Set(), items: [] };
  const loop = new Set(room.loop);
  const vertices = new Set(
    Object.values(level.vertices)
      .filter((v) => loop.has(v.id) || pointInPolygon(v, outer))
      .map((v) => v.id),
  );
  const items = Object.values(level.items)
    .filter((it) => pointInPolygon({ x: it.position.x, y: it.position.z }, outer))
    .map((it) => it.id);
  return { vertices, items };
}

const wallsAt = (level: Level, id: string) =>
  Object.values(level.walls).filter((w) => w.a === id || w.b === id);
const otherEnd = (w: Wall, id: string) => (w.a === id ? w.b : w.a);

/** Whether walls join the room from outside it: then it moves along one axis at a time. */
export function roomJoined(level: Level, roomId: string): boolean {
  const { vertices } = carried(level, roomId);
  return Object.values(level.walls).some((w) => vertices.has(w.a) !== vertices.has(w.b));
}

/**
 * Works out a move of the room: along `axis`, or anywhere for null (meant for a room
 * standing alone). New ids for the steps are made here, outside any recipe.
 */
export function planRoomMove(level: Level, roomId: string, axis: Axis | null): RoomMove {
  const { vertices: inRoom, items } = carried(level, roomId);
  if (!axis) return { axis, vertices: [...inRoom], items, steps: [], stays: [] };
  const d = dirOf(axis);
  const room = level.rooms[roomId];
  const loop = new Set(room?.loop ?? []);
  const vertices: string[] = [];
  const steps: RoomMove['steps'] = [];
  const stays: string[] = [];
  for (const id of inRoom) {
    const v = level.vertices[id];
    const walls = wallsAt(level, id);
    const outside = walls.filter((w) => !inRoom.has(otherEnd(w, id)));
    if (!v || !loop.has(id) || outside.length === 0) {
      vertices.push(id);
      continue;
    }
    const runs = (w: Wall) => {
      const o = level.vertices[otherEnd(w, id)];
      return !!o && along(v, o, d);
    };
    const inside = walls.filter((w) => inRoom.has(otherEnd(w, id)));
    // On a straight stretch of the room's wall running the way it moves: the corner stays
    // and the wall slides along through it.
    if (inside.every(runs)) {
      stays.push(id);
      continue;
    }
    // Joined walls running the way it moves stretch.
    if (outside.every(runs)) {
      vertices.push(id);
      continue;
    }
    steps.push({ corner: id, vertex: newId('v'), wall: newId('w') });
  }
  return { axis, vertices, items, steps, stays };
}

/** The parts of a level a move changes. */
interface Movable {
  vertices: Record<string, Vertex>;
  walls: Record<string, Wall>;
  openings: Record<string, Opening>;
  items: Record<string, Item>;
  rooms: Record<string, Room>;
}

/** The move's delta, held to its axis. */
const held = (move: RoomMove, delta: Vec2): Vec2 =>
  move.axis === 'x' ? { x: delta.x, y: 0 } : move.axis === 'y' ? { x: 0, y: delta.y } : delta;

/**
 * Puts `lvl` (a copy or draft of `start`) back as it was in `start`, then applies the move
 * by `delta`: corners and furniture, steps, and the doors and windows on walls with one end
 * moved (kept their distance from the end that stayed).
 */
function applyMove(lvl: Movable, start: Level, move: RoomMove, delta: Vec2): void {
  for (const [id, v] of Object.entries(start.vertices)) {
    const cur = lvl.vertices[id];
    if (cur) {
      cur.x = v.x;
      cur.y = v.y;
    }
  }
  for (const [id, w] of Object.entries(start.walls)) {
    const cur = lvl.walls[id];
    if (cur) {
      cur.a = w.a;
      cur.b = w.b;
    }
  }
  // Steps from earlier in the drag (along this axis or the other) go. Rooms keep their
  // identity through that: in their outlines, a step's corner takes its new corner's place.
  const stepCorner = new Map<string, string>();
  for (const w of Object.values(lvl.walls)) {
    if (start.walls[w.id]) continue;
    if (!start.vertices[w.b]) stepCorner.set(w.b, w.a);
    delete lvl.walls[w.id];
  }
  for (const id of Object.keys(lvl.vertices)) if (!start.vertices[id]) delete lvl.vertices[id];
  for (const r of Object.values(lvl.rooms)) {
    if (r.loop.every((id) => lvl.vertices[id])) continue;
    const loop = r.loop
      .map((id) => stepCorner.get(id) ?? id)
      .filter((id, i, all) => lvl.vertices[id] && id !== all[(i + 1) % all.length]);
    if (loop.length >= 3) r.loop = loop;
  }
  for (const [id, it] of Object.entries(start.items)) {
    const cur = lvl.items[id];
    if (cur) {
      cur.position.x = it.position.x;
      cur.position.z = it.position.z;
    }
  }
  for (const [id, o] of Object.entries(start.openings)) {
    const cur = lvl.openings[id];
    if (cur) cur.t = o.t;
  }
  if (Math.hypot(delta.x, delta.y) < 1e-9) return;

  for (const id of move.vertices) {
    const v = lvl.vertices[id];
    if (!v) continue;
    v.x += delta.x;
    v.y += delta.y;
  }
  for (const id of move.items) {
    const it = lvl.items[id];
    if (!it) continue;
    it.position.x += delta.x;
    it.position.z += delta.y;
  }
  const d = move.axis ? dirOf(move.axis) : null;
  const room = new Set([...move.vertices, ...move.stays, ...move.steps.map((t) => t.corner)]);
  for (const s of move.steps) {
    const c = start.vertices[s.corner];
    if (!c || !d) continue;
    const to = { x: c.x + delta.x, y: c.y + delta.y };
    // The room's walls at the corner leave it for the new one: those running across the
    // move, and the one running the way it moves, towards where it goes (the step takes
    // its first stretch). A wall running away from where it goes stays, the step extending
    // it.
    const inside = Object.values(start.walls).filter(
      (w) => (w.a === s.corner || w.b === s.corner) && room.has(otherEnd(w, s.corner)),
    );
    let template: Wall | undefined;
    for (const w0 of inside) {
      const o = start.vertices[otherEnd(w0, s.corner)];
      const w = lvl.walls[w0.id];
      if (!o || !w) continue;
      const runs = along(c, o, d);
      if (runs) template ??= w0;
      const ahead = (o.x - c.x) * delta.x + (o.y - c.y) * delta.y > 0;
      if (runs && !ahead) continue;
      if (w.a === s.corner) w.a = s.vertex;
      else w.b = s.vertex;
    }
    template ??= inside[0];
    if (!template) continue;
    lvl.vertices[s.vertex] = { id: s.vertex, x: to.x, y: to.y };
    lvl.walls[s.wall] = { ...structuredClone(template), id: s.wall, a: s.corner, b: s.vertex };
  }
  // Doors and windows: carried with a wall that moved whole, and kept their distance from
  // the end that stayed on a wall that stretched or shrank.
  for (const [id, o0] of Object.entries(start.openings)) {
    const w0 = start.walls[o0.wallId];
    const w = lvl.walls[o0.wallId];
    const o = lvl.openings[id];
    const pa = w0 && start.vertices[w0.a];
    const pb = w0 && start.vertices[w0.b];
    const na = w && lvl.vertices[w.a];
    const nb = w && lvl.vertices[w.b];
    if (!o || !pa || !pb || !na || !nb) continue;
    const movedA = Math.hypot(na.x - pa.x, na.y - pa.y) > 1e-9;
    const movedB = Math.hypot(nb.x - pb.x, nb.y - pb.y) > 1e-9;
    if (movedA === movedB) continue;
    const before = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    const after = Math.hypot(nb.x - na.x, nb.y - na.y);
    if (after < 1e-9) continue;
    o.t = movedA ? 1 - ((1 - o0.t) * before) / after : (o0.t * before) / after;
  }
}

/**
 * Moves the room by `delta` (held to the move's axis) from where it is in `from` (the level
 * as the drag began), so it can be dispatched again and again as a drag goes on, each time
 * from the same start.
 */
export function moveRoom(from: Level, move: RoomMove, delta: Vec2): Command {
  const start = structuredClone(from);
  const by = held(move, delta);
  return {
    label: 'Move room',
    recipe: (d) => {
      const lvl = draftLevel(d, start.id);
      applyMove(lvl, start, move, by);
      reclampOpenings(lvl);
      syncRooms(lvl);
    },
  };
}

/**
 * Whether moving the room by `delta` would bring a wall closer to another than their half
 * thicknesses allow (unless they are joined, or were already that close and are not getting
 * closer), or shrink or turn back a wall that stretches.
 */
export function moveBlocked(from: Level, move: RoomMove, delta: Vec2): boolean {
  const by = held(move, delta);
  const after: Movable = {
    vertices: structuredClone(from.vertices),
    walls: structuredClone(from.walls),
    openings: {},
    items: {},
    rooms: {},
  };
  applyMove(after, from, move, by);
  interface Seg {
    w: Wall;
    was: [Vec2, Vec2];
    now: [Vec2, Vec2];
    /** Both ends moved by the delta: carried whole. */
    carried: boolean;
    changed: boolean;
  }
  const same = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-9;
  const segs: Seg[] = [];
  for (const w of Object.values(after.walls)) {
    const na = after.vertices[w.a];
    const nb = after.vertices[w.b];
    if (!na || !nb) continue;
    const w0 = from.walls[w.id];
    const pa = w0 ? from.vertices[w0.a] : from.vertices[w.a];
    // A step starts as nothing, at the corner it leaves.
    const pb = w0 ? from.vertices[w0.b] : pa;
    if (!pa || !pb) continue;
    const moved = (p: Vec2, n: Vec2) => same({ x: p.x + by.x, y: p.y + by.y }, n);
    const changed = !same(pa, na) || !same(pb, nb);
    segs.push({
      w,
      was: [pa, pb],
      now: [na, nb],
      carried: !!w0 && changed && moved(pa, na) && moved(pb, nb),
      changed,
    });
    if (!w0 || !changed || same(pa, na) === same(pb, nb)) continue;
    // One end moved: the wall must keep some length, not turn back on itself, and keep its
    // doors and windows their distance from the end that stayed.
    const before = { x: pb.x - pa.x, y: pb.y - pa.y };
    const now = { x: nb.x - na.x, y: nb.y - na.y };
    if (before.x * now.x + before.y * now.y <= 0) return true;
    const length0 = Math.hypot(before.x, before.y);
    const movingA = !same(pa, na);
    let need = MIN_JOINED;
    for (const op of Object.values(from.openings)) {
      if (op.wallId !== w.id) continue;
      const fromFar = movingA ? (1 - op.t) * length0 : op.t * length0;
      need = Math.max(need, fromFar + op.width / 2 + MIN_JOINED);
    }
    if (Math.hypot(now.x, now.y) < Math.min(need, length0)) return true;
  }
  const joined = (p: Wall, q: Wall) => p.a === q.a || p.a === q.b || p.b === q.a || p.b === q.b;
  for (let i = 0; i < segs.length; i++) {
    const p = segs[i] as Seg;
    for (let j = i + 1; j < segs.length; j++) {
      const q = segs[j] as Seg;
      // Only pairs whose gap can change.
      if ((!p.changed && !q.changed) || (p.carried && q.carried)) continue;
      if (joined(p.w, q.w)) continue;
      const pn = band(p.w, ...p.now);
      const qn = band(q.w, ...q.now);
      const clear = Math.max(0.01, pn.half + qn.half);
      const now = segmentDistance(pn.p, pn.q, qn.p, qn.q);
      if (now >= clear) continue;
      const pw = band(p.w, ...p.was);
      const qw = band(q.w, ...q.was);
      if (now < segmentDistance(pw.p, pw.q, qw.p, qw.q) - 1e-9) return true;
    }
  }
  return false;
}

/**
 * How far towards `want` the room can go from `have`, in steps no longer than `step`:
 * straight towards it while nothing is in the way, then (moving freely) along each axis
 * alone, so a room pushed against a wall slides along it.
 */
export function moveTowards(
  from: Level,
  move: RoomMove,
  have: Vec2,
  want: Vec2,
  step = 0.01,
): Vec2 {
  const march = (p: Vec2, to: Vec2): Vec2 => {
    const dist = Math.hypot(to.x - p.x, to.y - p.y);
    const n = Math.ceil(dist / step - 1e-9);
    let cur = p;
    for (let i = 1; i <= n; i++) {
      const next =
        i === n ? to : { x: p.x + ((to.x - p.x) * i) / n, y: p.y + ((to.y - p.y) * i) / n };
      if (moveBlocked(from, move, next)) break;
      cur = next;
    }
    return cur;
  };
  const goal = held(move, want);
  let cur = march(held(move, have), goal);
  if (move.axis || Math.hypot(goal.x - cur.x, goal.y - cur.y) < 1e-9) return cur;
  cur = march(cur, { x: goal.x, y: cur.y });
  return march(cur, { x: cur.x, y: goal.y });
}
