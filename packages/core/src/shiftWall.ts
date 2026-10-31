import type { Command } from './history';
import { newId } from './ids';
import { draftLevel } from './levels';
import { syncRooms } from './rooms';
import { type Level, type Vec2, type Wall, wallFaces } from './schema';
import { projectOnSegment } from './snap';
import { reclampOpenings } from './topology';

/**
 * Moving a wall sideways (along its normal), as dragging a selected wall does. Walls joined
 * at its ends follow, keeping their far ends; their doors and windows keep their distance
 * from those far ends instead of sliding. Where the wall carries straight on into another
 * one, that one is left where it is and a short step joins them, rather than bending it.
 */

/** Two directions this close to opposite count as one straight wall carrying on. */
const STRAIGHT = Math.cos((3 * Math.PI) / 180);

const sub = (p: Vec2, q: Vec2) => ({ x: p.x - q.x, y: p.y - q.y });
const len = (p: Vec2) => Math.hypot(p.x, p.y);

/** The wall's unit normal (left of a→b), or null for a wall of no length. */
export function wallNormal(level: Level, wallId: string): Vec2 | null {
  const w = level.walls[wallId];
  const a = w && level.vertices[w.a];
  const b = w && level.vertices[w.b];
  if (!a || !b) return null;
  const l = Math.hypot(b.x - a.x, b.y - a.y);
  return l < 1e-9 ? null : { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
}

/** The walls at a vertex other than `except`. */
const others = (level: Level, vertexId: string, except: string) =>
  Object.values(level.walls).filter(
    (w) => w.id !== except && (w.a === vertexId || w.b === vertexId),
  );

/** Whether a wall at `end` carries straight on from the moved wall. */
function straightOn(level: Level, wall: Wall, end: string, other: Wall): boolean {
  const v = level.vertices[end];
  const far = level.vertices[wall.a === end ? wall.b : wall.a];
  const beyond = level.vertices[other.a === end ? other.b : other.a];
  if (!v || !far || !beyond) return false;
  const p = sub(far, v);
  const q = sub(beyond, v);
  const lp = len(p);
  const lq = len(q);
  if (lp < 1e-9 || lq < 1e-9) return false;
  return (p.x * q.x + p.y * q.y) / (lp * lq) < -STRAIGHT;
}

/** The ends of the wall that will need a step: those where another wall carries straight on. */
export function shiftNeedsSteps(level: Level, wallId: string): { a: boolean; b: boolean } {
  const w = level.walls[wallId];
  if (!w) return { a: false, b: false };
  const step = (end: string) => others(level, end, w.id).some((o) => straightOn(level, w, end, o));
  return { a: step(w.a), b: step(w.b) };
}

/** Ids for the steps a shift may add, made once by the caller (outside any recipe). */
export interface ShiftIds {
  a?: { vertex: string; wall: string };
  b?: { vertex: string; wall: string };
}

export function shiftIds(level: Level, wallId: string): ShiftIds {
  const steps = shiftNeedsSteps(level, wallId);
  const pair = () => ({ vertex: newId('v'), wall: newId('w') });
  return { ...(steps.a ? { a: pair() } : {}), ...(steps.b ? { b: pair() } : {}) };
}

/**
 * Moves the wall `offset` metres along its normal from where it is in `from` (the level as
 * the drag began), so the command can be dispatched again and again as the drag goes on,
 * each time from the same start. `ids` names the steps' new corners and walls.
 */
export function shiftWall(from: Level, wallId: string, offset: number, ids: ShiftIds): Command {
  const start = structuredClone(from);
  return {
    label: 'Move wall',
    recipe: (d) => {
      const lvl = draftLevel(d, start.id);
      const w0 = start.walls[wallId];
      const n = wallNormal(start, wallId);
      if (!w0 || !n) throw new Error(`wall ${wallId} not found`);
      // Back to the start: corners, the wall's ends and openings on joined walls.
      for (const [id, v] of Object.entries(start.vertices)) {
        const cur = lvl.vertices[id];
        if (cur) {
          cur.x = v.x;
          cur.y = v.y;
        }
      }
      const wall = lvl.walls[wallId];
      if (!wall) throw new Error(`wall ${wallId} not found`);
      const moved = (p: Vec2) => ({ x: p.x + n.x * offset, y: p.y + n.y * offset });
      for (const end of ['a', 'b'] as const) {
        const vid = w0[end];
        const v = start.vertices[vid];
        if (!v) continue;
        const step = Math.abs(offset) > 1e-9 ? ids[end] : undefined;
        if (!step && ids[end]) {
          // Back where it began: no step.
          const s0 = ids[end];
          if (s0 && wall[end] === s0.vertex) wall[end] = vid;
          if (s0) {
            delete lvl.walls[s0.wall];
            delete lvl.vertices[s0.vertex];
          }
        }
        if (step) {
          // Carrying straight on: the wall's end leaves the corner, and a step joins them.
          const to = moved(v);
          lvl.vertices[step.vertex] = { id: step.vertex, x: to.x, y: to.y };
          wall[end] = step.vertex;
          lvl.walls[step.wall] ??= {
            ...structuredClone(w0),
            id: step.wall,
            a: vid,
            b: step.vertex,
          };
          continue;
        }
        const cur = lvl.vertices[vid];
        if (!cur) continue;
        const to = moved(v);
        cur.x = to.x;
        cur.y = to.y;
        // Openings on the walls that follow keep their distance from those walls' far ends.
        for (const o0 of Object.values(start.openings)) {
          const ow = start.walls[o0.wallId];
          if (!ow || ow.id === wallId || (ow.a !== vid && ow.b !== vid)) continue;
          const pa = start.vertices[ow.a];
          const pb = start.vertices[ow.b];
          if (!pa || !pb) continue;
          const na = ow.a === vid ? to : pa;
          const nb = ow.b === vid ? to : pb;
          const before = Math.hypot(pb.x - pa.x, pb.y - pa.y);
          const after = Math.hypot(nb.x - na.x, nb.y - na.y);
          const o = lvl.openings[o0.id];
          if (!o || after < 1e-9) continue;
          o.t = ow.a === vid ? 1 - ((1 - o0.t) * before) / after : (o0.t * before) / after;
        }
      }
      reclampOpenings(lvl);
      syncRooms(lvl);
    },
  };
}

/** The shortest distance between two segments. */
function segmentDistance(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): number {
  const d1 = sub(p2, p1);
  const d2 = sub(q2, q1);
  const cross = (u: Vec2, v: Vec2) => u.x * v.y - u.y * v.x;
  const den = cross(d1, d2);
  if (Math.abs(den) > 1e-12) {
    const r = sub(q1, p1);
    const t = cross(r, d2) / den;
    const u = cross(r, d1) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(
    projectOnSegment(p1, q1, q2).distance,
    projectOnSegment(p2, q1, q2).distance,
    projectOnSegment(q1, p1, p2).distance,
    projectOnSegment(q2, p1, p2).distance,
  );
}

/** A wall's true centre line (off its line when it lies to one side) and half its thickness. */
function band(w: Wall, p: Vec2, q: Vec2): { p: Vec2; q: Vec2; half: number } {
  const f = wallFaces(w);
  const l = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  const n = { x: -(q.y - p.y) / l, y: (q.x - p.x) / l };
  const shift = (f.left - f.right) / 2;
  const off = (v: Vec2) => ({ x: v.x + n.x * shift, y: v.y + n.y * shift });
  return { p: off(p), q: off(q), half: (f.left + f.right) / 2 };
}

/** Shorter than this, a joined wall is about to vanish: the move stops first. */
const MIN_JOINED = 0.05;

/**
 * Whether moving the wall by `offset` would run it into another wall (closer than their
 * half thicknesses allow, unless joined to it) or shrink a wall that follows it to nothing.
 */
export function shiftBlocked(from: Level, wallId: string, offset: number): boolean {
  const w = from.walls[wallId];
  const n = wallNormal(from, wallId);
  const a = w && from.vertices[w.a];
  const b = w && from.vertices[w.b];
  if (!w || !n || !a || !b) return true;
  const steps = shiftNeedsSteps(from, wallId);
  const ma = { x: a.x + n.x * offset, y: a.y + n.y * offset };
  const mb = { x: b.x + n.x * offset, y: b.y + n.y * offset };
  // Corners the moved wall keeps: where it doesn't step away from them.
  const ends = new Set([...(steps.a ? [] : [w.a]), ...(steps.b ? [] : [w.b])]);
  const at = (id: string, p: Vec2) =>
    id === w.a && !steps.a ? ma : id === w.b && !steps.b ? mb : p;
  for (const o of Object.values(from.walls)) {
    if (o.id === wallId) continue;
    const oa = from.vertices[o.a];
    const ob = from.vertices[o.b];
    if (!oa || !ob) continue;
    const joined =
      ends.has(o.a) || ends.has(o.b) || o.a === w.a || o.a === w.b || o.b === w.a || o.b === w.b;
    if (joined) {
      // A wall that follows: it must keep some length and not turn back on itself.
      const na = at(o.a, oa);
      const nb = at(o.b, ob);
      const before = sub(ob, oa);
      const after = sub(nb, na);
      if (ends.has(o.a) || ends.has(o.b)) {
        if (before.x * after.x + before.y * after.y <= 0) return true;
        // Its doors and windows keep their distance from its far end: the moving end stops
        // short of them rather than squeezing them.
        const moving = ends.has(o.a) ? 'a' : 'b';
        const length0 = len(before);
        let need = MIN_JOINED;
        for (const op of Object.values(from.openings)) {
          if (op.wallId !== o.id) continue;
          const fromFar = moving === 'a' ? (1 - op.t) * length0 : op.t * length0;
          need = Math.max(need, fromFar + op.width / 2 + MIN_JOINED);
        }
        if (len(after) < Math.min(need, length0)) return true;
      }
      continue;
    }
    // Too close (between faces, not lines: a wall may lie to one side of its line), and
    // closer than it began: a wall already that near may move away from it.
    const mine = band(w, ma, mb);
    const was = band(w, a, b);
    const theirs = band(o, oa, ob);
    const clear = Math.max(0.01, mine.half + theirs.half);
    const now = segmentDistance(mine.p, mine.q, theirs.p, theirs.q);
    if (now < clear && now < segmentDistance(was.p, was.q, theirs.p, theirs.q) - 1e-9) return true;
  }
  return false;
}
