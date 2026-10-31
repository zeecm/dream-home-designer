import { pointInPolygon } from './geometry';
import type { Command } from './history';
import { newId } from './ids';
import { draftLevel } from './levels';
import { detectFaces, roomShapes, syncRooms } from './rooms';
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

/** The room's corners in a move: carried, staying or stepping. */
const cornersOf = (move: RoomMove) =>
  new Set([...move.vertices, ...move.stays, ...move.steps.map((s) => s.corner)]);

/** Shorter than this, a wall a move shrinks has closed up: its ends merge. */
const CLOSED = 1e-6;

/**
 * Where a door or window on a wall with one end moved keeps its distance from: the end that
 * moved on one of the room's own walls (it goes with the room), the end that stayed on a wall
 * joined to it.
 */
function anchorEnd(w0: Wall, corners: Set<string>, movedA: boolean): 'a' | 'b' {
  const ours = corners.has(w0.a) && corners.has(w0.b);
  return ours === movedA ? 'a' : 'b';
}

/** An opening's new `t`, kept its distance from the anchor end of a wall now `after` long. */
function keptT(anchor: 'a' | 'b', t0: number, before: number, after: number): number {
  return anchor === 'a' ? (t0 * before) / after : 1 - ((1 - t0) * before) / after;
}

/**
 * Puts `lvl` (a copy or draft of `start`) back as it was in `start`, then applies the move
 * by `delta`: corners and furniture, steps, walls the move closed up, and the doors and
 * windows on walls with one end moved.
 */
function applyMove(lvl: Movable, start: Level, move: RoomMove, delta: Vec2): void {
  // Back to the start, dropping anything an earlier application (along either axis) added.
  for (const id of Object.keys(lvl.walls)) if (!start.walls[id]) delete lvl.walls[id];
  for (const id of Object.keys(lvl.vertices)) if (!start.vertices[id]) delete lvl.vertices[id];
  for (const id of Object.keys(lvl.rooms)) if (!start.rooms[id]) delete lvl.rooms[id];
  for (const [id, v] of Object.entries(start.vertices)) {
    const cur = lvl.vertices[id];
    if (!cur) lvl.vertices[id] = { ...v };
    else if (cur.x !== v.x || cur.y !== v.y) {
      cur.x = v.x;
      cur.y = v.y;
    }
  }
  for (const [id, w] of Object.entries(start.walls)) {
    const cur = lvl.walls[id];
    if (!cur) lvl.walls[id] = structuredClone(w);
    else if (cur.a !== w.a || cur.b !== w.b) {
      cur.a = w.a;
      cur.b = w.b;
    }
  }
  for (const [id, r] of Object.entries(start.rooms)) {
    const cur = lvl.rooms[id];
    if (!cur) lvl.rooms[id] = structuredClone(r);
    else if (cur.loop.join() !== r.loop.join()) cur.loop = [...r.loop];
  }
  for (const [id, it] of Object.entries(start.items)) {
    const cur = lvl.items[id];
    if (cur && (cur.position.x !== it.position.x || cur.position.z !== it.position.z)) {
      cur.position.x = it.position.x;
      cur.position.z = it.position.z;
    }
  }
  for (const [id, o] of Object.entries(start.openings)) {
    const cur = lvl.openings[id];
    if (cur && cur.t !== o.t) cur.t = o.t;
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
  const corners = cornersOf(move);
  const d = move.axis ? dirOf(move.axis) : null;
  for (const s of move.steps) {
    const c = start.vertices[s.corner];
    if (!c || !d) continue;
    // Walls at the corner leave it for the new one: the room's walls running across the
    // move, and any wall running the way it moves towards where it goes (the step takes
    // its first stretch, so it never lies along another wall). The rest stay.
    let template: Wall | undefined;
    for (const w0 of Object.values(start.walls)) {
      if (w0.a !== s.corner && w0.b !== s.corner) continue;
      const other = otherEnd(w0, s.corner);
      const o = start.vertices[other];
      const w = lvl.walls[w0.id];
      if (!o || !w) continue;
      const runs = along(c, o, d);
      const ours = corners.has(other);
      if (runs && (ours || !template)) template = w0;
      const leaves = runs ? (o.x - c.x) * delta.x + (o.y - c.y) * delta.y > 0 : ours;
      if (!leaves) continue;
      if (w.a === s.corner) w.a = s.vertex;
      else w.b = s.vertex;
    }
    template ??= Object.values(start.walls).find(
      (w) => (w.a === s.corner || w.b === s.corner) && corners.has(otherEnd(w, s.corner)),
    );
    if (!template) continue;
    lvl.vertices[s.vertex] = { id: s.vertex, x: c.x + delta.x, y: c.y + delta.y };
    // Running the same way as the wall it copies, so its side and faces match.
    const ta = start.vertices[template.a];
    const tb = start.vertices[template.b];
    const same = !ta || !tb || (tb.x - ta.x) * delta.x + (tb.y - ta.y) * delta.y >= 0;
    lvl.walls[s.wall] = {
      ...structuredClone(template),
      id: s.wall,
      a: same ? s.corner : s.vertex,
      b: same ? s.vertex : s.corner,
    };
  }
  // A wall the move closed up (a step taken back): its ends merge into the one that stayed.
  for (const id of Object.keys(lvl.walls)) {
    const w = lvl.walls[id];
    const pa = w && lvl.vertices[w.a];
    const pb = w && lvl.vertices[w.b];
    if (!w || !pa || !pb || Math.hypot(pb.x - pa.x, pb.y - pa.y) >= CLOSED) continue;
    if (Object.values(start.openings).some((o) => o.wallId === w.id)) continue;
    const keep = !move.vertices.includes(w.a) && start.vertices[w.a] ? w.a : w.b;
    const drop = keep === w.a ? w.b : w.a;
    delete lvl.walls[w.id];
    for (const o of Object.values(lvl.walls)) {
      if (o.a === drop) o.a = keep;
      if (o.b === drop) o.b = keep;
    }
    delete lvl.vertices[drop];
    for (const r of Object.values(lvl.rooms)) {
      if (!r.loop.includes(drop)) continue;
      const loop = r.loop
        .map((id) => (id === drop ? keep : id))
        .filter((id, i, all) => id !== all[(i + 1) % all.length]);
      if (loop.length >= 3) r.loop = loop;
    }
  }
  // Doors and windows: carried with a wall that moved whole; on a wall with one end moved,
  // kept their distance from its anchor end (anchorEnd).
  for (const [id, o0] of Object.entries(start.openings)) {
    const w0 = start.walls[o0.wallId];
    const w = lvl.walls[o0.wallId];
    const o = lvl.openings[id];
    const pa = w0 && start.vertices[w0.a];
    const pb = w0 && start.vertices[w0.b];
    const na = w && lvl.vertices[w.a];
    const nb = w && lvl.vertices[w.b];
    if (!w0 || !o || !pa || !pb || !na || !nb) continue;
    const movedA = Math.hypot(na.x - pa.x, na.y - pa.y) > 1e-9;
    const movedB = Math.hypot(nb.x - pb.x, nb.y - pb.y) > 1e-9;
    if (movedA === movedB) continue;
    const before = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    const after = Math.hypot(nb.x - na.x, nb.y - na.y);
    if (after < 1e-9) continue;
    o.t = keptT(anchorEnd(w0, corners, movedA), o0.t, before, after);
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
 * A room narrower than this (about: twice its area over its perimeter, which for a long
 * strip is its width) is too thin to use: a move doesn't squeeze one this far.
 */
const THIN = 0.3;

interface RoomsShape {
  /** How many rooms the walls enclose. */
  count: number;
  /** How many of them are thin, and the thinnest one's width (Infinity if none). */
  thin: number;
  thinnest: number;
}

function roomsShape(level: Pick<Level, 'vertices' | 'walls'>): RoomsShape {
  const faces = detectFaces(level);
  let thin = 0;
  let thinnest = Number.POSITIVE_INFINITY;
  for (const loop of faces) {
    const pts = loop.map((id) => level.vertices[id] as Vec2);
    let area = 0;
    let perimeter = 0;
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length] as Vec2;
      area += p.x * q.y - q.x * p.y;
      perimeter += Math.hypot(q.x - p.x, q.y - p.y);
    });
    const width = perimeter > 0 ? Math.abs(area) / perimeter : 0;
    if (width < THIN) {
      thin++;
      thinnest = Math.min(thinnest, width);
    }
  }
  return { count: faces.length, thin, thinnest };
}

const shapes = new WeakMap<Level, RoomsShape>();
function startShape(level: Level): RoomsShape {
  let s = shapes.get(level);
  if (!s) {
    s = roomsShape(level);
    shapes.set(level, s);
  }
  return s;
}

/**
 * Whether moving the room by `delta` would bring a wall closer to another than their half
 * thicknesses allow (unless they are joined, or were already that close and are not getting
 * closer), shrink a wall past its doors or turn it back, or squeeze a room out of existence.
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
  const corners = cornersOf(move);
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
    // A step starts as nothing, at the corner it leaves.
    const corner = from.vertices[w.a] ?? from.vertices[w.b];
    const pa = w0 ? from.vertices[w0.a] : corner;
    const pb = w0 ? from.vertices[w0.b] : corner;
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
    // One end moved: the wall must not turn back on itself, and must keep room for its doors
    // and windows (each kept from its anchor end). One without any may shrink to nothing,
    // closing up (a room squeezed out is caught below).
    const before = { x: pb.x - pa.x, y: pb.y - pa.y };
    const now = { x: nb.x - na.x, y: nb.y - na.y };
    if (before.x * now.x + before.y * now.y <= 0) return true;
    const length0 = Math.hypot(before.x, before.y);
    const anchor = anchorEnd(w0, corners, !same(pa, na));
    let need = 0;
    for (const op of Object.values(from.openings)) {
      if (op.wallId !== w.id) continue;
      const fromAnchor = anchor === 'a' ? op.t * length0 : (1 - op.t) * length0;
      need = Math.max(need, fromAnchor + op.width / 2 + MIN_JOINED);
    }
    if (Math.hypot(now.x, now.y) < Math.min(need, length0)) return true;
  }
  // Walls meeting at a corner, or at the two ends of one wall (a step), may come as close as
  // that wall lets them.
  const next = new Map<string, Set<string>>();
  for (const w of Object.values(after.walls)) {
    next.set(w.a, (next.get(w.a) ?? new Set()).add(w.b));
    next.set(w.b, (next.get(w.b) ?? new Set()).add(w.a));
  }
  const joined = (p: Wall, q: Wall) =>
    [p.a, p.b].some(
      (u) => u === q.a || u === q.b || next.get(u)?.has(q.a) || next.get(u)?.has(q.b),
    );
  const box = (s: Seg) => {
    const xs = [s.now[0].x, s.now[1].x];
    const ys = [s.now[0].y, s.now[1].y];
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  };
  const boxes = segs.map(box);
  // No two walls are thicker together than this: pairs further apart can't be too close.
  const reach = 2 * Math.max(0.01, ...segs.map((s) => s.w.thickness)) + 0.01;
  for (let i = 0; i < segs.length; i++) {
    const p = segs[i] as Seg;
    const pb = boxes[i] as ReturnType<typeof box>;
    for (let j = i + 1; j < segs.length; j++) {
      const q = segs[j] as Seg;
      // Only pairs whose gap can change.
      if ((!p.changed && !q.changed) || (p.carried && q.carried)) continue;
      const qb = boxes[j] as ReturnType<typeof box>;
      if (
        pb.x0 > qb.x1 + reach ||
        qb.x0 > pb.x1 + reach ||
        pb.y0 > qb.y1 + reach ||
        qb.y0 > pb.y1 + reach
      )
        continue;
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
  // No room squeezed out of existence, merged into another or squeezed thin (one already
  // thin may not get thinner).
  const was = startShape(from);
  const now = roomsShape(after);
  return (
    now.count < was.count ||
    now.thin > was.thin ||
    (now.thin > 0 && now.thinnest < Math.min(was.thinnest, THIN) - 1e-9)
  );
}

/**
 * Along the move's axis, the distances at which a wall with one end moving closes up (its
 * moving end reaching its other end): a move stopping just short of one would leave a stub.
 */
function closingPoints(from: Level, move: RoomMove): number[] {
  if (!move.axis) return [];
  const d = dirOf(move.axis);
  const movers = new Set([...move.vertices, ...move.steps.map((s) => s.corner)]);
  const out: number[] = [];
  for (const w of Object.values(from.walls)) {
    if (movers.has(w.a) === movers.has(w.b)) continue;
    const m = from.vertices[movers.has(w.a) ? w.a : w.b];
    const s = from.vertices[movers.has(w.a) ? w.b : w.a];
    if (!m || !s || !along(m, s, d)) continue;
    out.push((s.x - m.x) * d.x + (s.y - m.y) * d.y);
  }
  return out;
}

/**
 * How far towards `want` the room can go from `have`, checked every centimetre: straight
 * towards it while nothing is in the way, then (moving freely) along each axis alone, so a
 * room pushed against a wall slides along it.
 */
export function moveTowards(from: Level, move: RoomMove, have: Vec2, want: Vec2): Vec2 {
  const step = 0.01;
  const closing = closingPoints(from, move);
  const d = move.axis ? dirOf(move.axis) : null;
  const march = (p: Vec2, to: Vec2): Vec2 => {
    const dist = Math.hypot(to.x - p.x, to.y - p.y);
    const n = Math.ceil(dist / step - 1e-9);
    let cur = p;
    for (let i = 1; i <= n; i++) {
      const next =
        i === n ? to : { x: p.x + ((to.x - p.x) * i) / n, y: p.y + ((to.y - p.y) * i) / n };
      if (!moveBlocked(from, move, next)) {
        cur = next;
        continue;
      }
      // Stopped: a wall closing up between here and there is as far as it goes, not a
      // stub of a few millimetres short of it.
      if (d) {
        const a = cur.x * d.x + cur.y * d.y;
        const b = next.x * d.x + next.y * d.y;
        const between = closing
          .filter((c) => (c - a) * (b - a) > 1e-12 && (c - b) * (a - b) > 1e-12)
          .sort((u, v) => Math.abs(v - a) - Math.abs(u - a));
        for (const c of between) {
          const at = { x: d.x * c, y: d.y * c };
          if (!moveBlocked(from, move, at)) {
            cur = at;
            break;
          }
        }
      }
      break;
    }
    return cur;
  };
  const goal = held(move, want);
  let cur = march(held(move, have), goal);
  if (move.axis || Math.hypot(goal.x - cur.x, goal.y - cur.y) < 1e-9) return cur;
  cur = march(cur, { x: goal.x, y: cur.y });
  return march(cur, { x: cur.x, y: goal.y });
}
