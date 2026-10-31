import { current, isDraft } from 'immer';
import { finish } from './finishes';
import { placeLabel, pointInPolygon } from './geometry';
import type { Command } from './history';
import { AFTER_SUFFIX, type Variant } from './levels';
import { roomArea, roomShapes, syncRooms } from './rooms';
import { type Level, type Vec2, type Wall, isBoundary, wallFaces } from './schema';
import { reclampOpenings } from './topology';

/**
 * Before and after: a renovation is a second copy of the flat, compared with the first
 * wall by wall. The copy keeps every element's id, so a wall the renovation leaves alone
 * is the same wall in both.
 */

/** Starts a renovation: the plan stays as it is, and an identical copy becomes the "after". */
export function startRenovation(): Command {
  return {
    label: 'Plan a renovation',
    recipe: (d) => {
      if (d.renovation) throw new Error('this plan already has a renovation');
      const levels = d.levels.map((l) => {
        const copy = structuredClone(current(l));
        return { ...copy, id: `${copy.id}${AFTER_SUFFIX}` };
      });
      d.renovation = { levels };
    },
  };
}

/**
 * Ends a renovation. Keeping 'after' makes the renovated flat the plan (once the work is
 * done); keeping 'before' drops the renovation.
 */
export function endRenovation(keep: Variant): Command {
  return {
    label: keep === 'after' ? 'Make the renovation the plan' : 'Discard the renovation',
    recipe: (d) => {
      const reno = d.renovation;
      if (!reno) return;
      if (keep === 'after') {
        d.levels = reno.levels.map((l) => {
          const copy = structuredClone(current(l));
          const id = copy.id.endsWith(AFTER_SUFFIX)
            ? copy.id.slice(0, -AFTER_SUFFIX.length)
            : copy.id;
          return { ...copy, id };
        });
      }
      d.renovation = undefined;
    },
  };
}

/** The records an edit to the flat as it is carries over (rooms follow from the walls). */
const CARRIED = ['vertices', 'walls', 'openings', 'items'] as const;
type Carried = (typeof CARRIED)[number];
/** What a room keeps of its own when carried: the rest (its outline) is found again. */
const ROOM_FIELDS = ['name', 'floorMaterial', 'ceilingMaterial', 'ceilingHeight'] as const;

const same = (p: unknown, q: unknown) => JSON.stringify(p) === JSON.stringify(q);

/** What became of an edit carried to the renovation: carried, or held back by a conflict. */
export interface Carry {
  carried?: boolean;
  conflict?: boolean;
}

type Records = Record<Carried, Record<string, unknown>>;
type Change = { key: Carried; id: string; to: unknown };

/** Whether two walls' centre lines run along each other for more than a point. */
function overlapping(p: [Vec2, Vec2], q: [Vec2, Vec2]): boolean {
  const d = { x: p[1].x - p[0].x, y: p[1].y - p[0].y };
  const len = Math.hypot(d.x, d.y);
  if (len < 1e-9) return false;
  const u = { x: d.x / len, y: d.y / len };
  const off = (v: Vec2) => Math.abs((v.x - p[0].x) * -u.y + (v.y - p[0].y) * u.x);
  if (off(q[0]) > 0.005 || off(q[1]) > 0.005) return false;
  const t = (v: Vec2) => (v.x - p[0].x) * u.x + (v.y - p[0].y) * u.y;
  const lo = Math.max(0, Math.min(t(q[0]), t(q[1])));
  const hi = Math.min(len, Math.max(t(q[0]), t(q[1])));
  return hi - lo > 0.01;
}

/**
 * One record of an edit merged into the renovation's copy, field by field: each field the
 * edit changed goes over where the renovation's is as it was (or already as the edit made it),
 * and the renovation keeps the fields it changed itself (a wall's paint, a door's width).
 * 'conflict' where both changed the same field differently, or one removed what the other
 * changed; 'same' where the renovation already has it.
 */
function merge(was: unknown, edited: unknown, there: unknown): unknown | 'conflict' | 'same' {
  if (same(there, edited)) return 'same';
  if (was === undefined) return there === undefined ? edited : 'conflict';
  if (edited === undefined) return same(there, was) ? undefined : 'conflict';
  if (there === undefined) return 'conflict';
  const a = was as Record<string, unknown>;
  const b = edited as Record<string, unknown>;
  const out = { ...(there as Record<string, unknown>) };
  for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (same(a[f], b[f])) continue;
    if (!same(out[f], a[f]) && !same(out[f], b[f])) return 'conflict';
    if (b[f] === undefined) delete out[f];
    else out[f] = b[f];
  }
  return out;
}

/**
 * The changes an edit made to a level (`old` to `now`), merged into the renovation's copy
 * (`there`), if it can take them all: each record merges (`merge`); no door or window of the
 * renovation's own sits on a wall the edit moves an end of (it would slide); and the result
 * holds together (every wall's corners and every opening's wall there, no wall added along
 * another). 'conflict' if not; 'none' for nothing to do.
 */
function planCarry(old: Level, now: Level, there: Level): Change[] | 'none' | 'conflict' {
  const was = old as unknown as Records;
  const edited = now as unknown as Records;
  const has = there as unknown as Records;
  const changes: Change[] = [];
  for (const key of CARRIED) {
    for (const id of new Set([...Object.keys(was[key]), ...Object.keys(edited[key])])) {
      if (same(was[key][id], edited[key][id])) continue;
      const to = merge(was[key][id], edited[key][id], has[key][id]);
      if (to === 'conflict') return 'conflict';
      if (to !== 'same') changes.push({ key, id, to });
    }
  }
  if (changes.length === 0) return 'none';
  // Walls whose ends the edit moves to other corners (a split, a merge), or that it makes
  // a boundary.
  const reended = new Set(
    Object.values(now.walls)
      .filter((w) => {
        const o = old.walls[w.id];
        return o && (o.a !== w.a || o.b !== w.b || (isBoundary(w) && !isBoundary(o)));
      })
      .map((w) => w.id),
  );
  for (const id of reended) {
    // A wall split where the renovation moved one of its ends would bend at the split.
    const o = old.walls[id];
    const w = now.walls[id];
    if (!o || !w || (o.a === w.a && o.b === w.b)) continue;
    if ([o.a, o.b].some((v) => !same(has.vertices[v], was.vertices[v]))) return 'conflict';
  }
  const merged = new Set(changes.filter((c) => c.key === 'openings').map((c) => c.id));
  for (const o of Object.values(there.openings)) {
    // The renovation's own (or own-changed) door, left where it was on a wall now ending
    // elsewhere (or no longer a wall), would slide or float.
    if (reended.has(o.wallId) && !same(o, old.openings[o.id]) && !merged.has(o.id)) {
      return 'conflict';
    }
  }
  // A piece of a wall the edit split takes on what the renovation made of the wall (its
  // thickness, its paint), not the flat's.
  for (const c of changes) {
    if (c.key !== 'walls' || old.walls[c.id] || !c.to) continue;
    const piece = c.to as Wall;
    const a = now.vertices[piece.a];
    const b = now.vertices[piece.b];
    if (!a || !b) continue;
    const from = [...reended].find((id) => {
      const o = old.walls[id];
      const oa = o && old.vertices[o.a];
      const ob = o && old.vertices[o.b];
      return !!oa && !!ob && overlapping([oa, ob], [a, b]);
    });
    if (!from) continue;
    const parent = (changes.find((x) => x.key === 'walls' && x.id === from)?.to ??
      has.walls[from]) as Wall | undefined;
    if (parent) c.to = { ...parent, id: piece.id, a: piece.a, b: piece.b };
  }
  // Tried on a copy: it must hold together.
  const trial = {
    vertices: { ...there.vertices },
    walls: { ...there.walls },
    openings: { ...there.openings },
  } as Record<string, Record<string, unknown>>;
  for (const c of changes) {
    if (c.key === 'items') continue;
    const into = trial[c.key] as Record<string, unknown>;
    if (c.to === undefined) delete into[c.id];
    else into[c.id] = c.to;
  }
  const vs = trial.vertices as Level['vertices'];
  const ws = trial.walls as Level['walls'];
  if (Object.values(ws).some((w) => !vs[w.a] || !vs[w.b])) return 'conflict';
  const ops = Object.values(trial.openings as Level['openings']);
  if (ops.some((o) => !ws[o.wallId] || isBoundary(ws[o.wallId] as Wall))) return 'conflict';
  // No door or window added or moved by the edit overlapping another on its wall.
  for (const c of changes) {
    if (c.key !== 'openings' || !c.to) continue;
    const o = c.to as Level['openings'][string];
    const w = ws[o.wallId];
    const a = w && vs[w.a];
    const b = w && vs[w.b];
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    for (const q of ops) {
      if (q.id === o.id || q.wallId !== o.wallId) continue;
      if (Math.abs(q.t - o.t) * len < (q.width + o.width) / 2 - 1e-6) return 'conflict';
    }
  }
  const ends = (w: Wall): [Vec2, Vec2] | null => {
    const a = vs[w.a];
    const b = vs[w.b];
    return a && b ? [a, b] : null;
  };
  for (const c of changes) {
    const w = c.key === 'walls' && !old.walls[c.id] ? ws[c.id] : undefined;
    const p = w ? ends(w) : null;
    if (!p) continue;
    for (const o of Object.values(ws)) {
      const q = o.id !== c.id ? ends(o) : null;
      if (q && overlapping(p, q)) return 'conflict';
    }
  }
  return changes;
}

/**
 * An edit to the flat as it is (a trace fixed, a wall found), carried over to the renovation
 * where the renovation hasn't changed that part itself: all of it or none (`planCarry`).
 * Rooms are found again from the walls, keeping what the edit gave them (a name, a floor)
 * where the renovation hadn't changed it. A command that replaces the plan or the renovation
 * whole (restoring a version, starting or ending a renovation) carries nothing. One command,
 * so one undo step; `outcome` says what happened. `restore` is the renovation as a drag found
 * it: a step of the drag held back puts it back so, taking back the steps already carried.
 */
export function carriedToRenovation(
  cmd: Command,
  outcome: Carry = {},
  restore?: readonly Level[],
): Command {
  return {
    ...cmd,
    recipe: (d) => {
      outcome.carried = false;
      outcome.conflict = false;
      const reno = d.renovation;
      const levels = d.levels;
      const was = reno ? d.levels.map((l) => structuredClone(current(l))) : [];
      cmd.recipe(d);
      if (!reno || d.renovation !== reno || d.levels !== levels) return;
      d.levels.forEach((l, i) => {
        const old = was[i];
        const after = old && reno.levels.find((a) => a.id === `${old.id}${AFTER_SUFFIX}`);
        if (!old || !after) return;
        const now = isDraft(l) ? current(l) : l;
        const plan = planCarry(old, now, current(after));
        let changed = false;
        // Held back: the renovation as it was, or, part of a drag already carried, as the
        // drag found it.
        const start = restore?.find((r) => r.id === after.id);
        const holdBack = (back: Level | undefined) => {
          outcome.conflict = true;
          if (!back) return;
          for (const key of [...CARRIED, 'rooms'] as const) {
            (after as Record<string, unknown>)[key] = structuredClone(back[key]);
          }
          after.ceilingHeight = back.ceilingHeight;
        };
        if (plan === 'conflict') {
          holdBack(start);
          return;
        }
        const keep = structuredClone(current(after));
        if (plan !== 'none') {
          for (const c of plan) {
            const into: Record<string, unknown> = after[c.key];
            if (c.to === undefined) delete into[c.id];
            else into[c.id] = structuredClone(c.to);
          }
          changed = true;
        }
        if (old.ceilingHeight !== now.ceilingHeight && after.ceilingHeight === old.ceilingHeight) {
          after.ceilingHeight = now.ceilingHeight;
          changed = true;
        }
        if (changed) {
          reclampOpenings(after);
          syncRooms(after);
          // A room the renovation made or changed itself (renamed, refinished) gone with the
          // edit (two rooms merged): held back, the renovation as it was.
          const lost = Object.values(keep.rooms).some((r) => {
            const o = old.rooms[r.id];
            const own = !o || ROOM_FIELDS.some((f) => !same(r[f], o[f]));
            return own && !after.rooms[r.id];
          });
          if (lost) {
            holdBack(start ?? keep);
            return;
          }
        }
        // Rooms: what the edit changed of one (a name, a floor) where the renovation's is as it
        // was, and a new room's name and finishes on the same room there, if the name is free.
        for (const r of Object.values(now.rooms)) {
          const before = old.rooms[r.id];
          const loop = new Set(r.loop);
          const target =
            after.rooms[r.id] ??
            (before
              ? undefined
              : Object.values(after.rooms).find(
                  (q) => q.loop.length === loop.size && q.loop.every((v) => loop.has(v)),
                ));
          if (!target) continue;
          for (const f of ROOM_FIELDS) {
            if (same(r[f], before ? before[f] : target[f])) continue;
            if (before && !same(target[f], before[f])) {
              // The renovation renamed or refinished it too.
              if (!same(target[f], r[f])) outcome.conflict = true;
              continue;
            }
            if (
              f === 'name' &&
              Object.values(after.rooms).some((q) => q.id !== target.id && q.name === r.name)
            ) {
              continue;
            }
            (target as Record<string, unknown>)[f] = structuredClone(r[f]);
            changed = true;
          }
        }
        if (changed) outcome.carried = true;
      });
    },
  };
}

/** A stretch of wall: where it runs, and the face lines either side (plan space). */
export interface WallStretch {
  wallId: string;
  /** From and to, on the wall's line. */
  from: Vec2;
  to: Vec2;
  length: number;
  /** The stretch's outline, face to face. */
  polygon: Vec2[];
}

export interface RenovationDiff {
  /** Wall of the flat as it is that the renovation takes away: what is hacked. */
  demolished: WallStretch[];
  /** Wall the renovation puts up. */
  built: WallStretch[];
  demolishedLength: number;
  builtLength: number;
  /** Doors, windows and openings new in the renovation, and ones it closes up. */
  openingsAdded: string[];
  openingsRemoved: string[];
  areaBefore: number;
  areaAfter: number;
}

const EPS = 0.002;

interface Line {
  wall: Wall;
  a: Vec2;
  d: Vec2;
  length: number;
  height: number;
  /** Face offsets along the left normal (-d.y, d.x): the left face at +left, the right at -right. */
  left: number;
  right: number;
  /** Where doors, windows and openings leave no wall, as [from, to] along the line. */
  holes: [number, number][];
}

function linesOf(level: Level): Line[] {
  const out: Line[] = [];
  for (const wall of Object.values(level.walls)) {
    if (isBoundary(wall)) continue;
    const a = level.vertices[wall.a];
    const b = level.vertices[wall.b];
    if (!a || !b) continue;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < EPS) continue;
    const { left, right } = wallFaces(wall);
    const holes = Object.values(level.openings)
      .filter((o) => o.wallId === wall.id)
      .map((o): [number, number] => [
        Math.max(0, o.t * length - o.width / 2),
        Math.min(length, o.t * length + o.width / 2),
      ]);
    out.push({
      wall,
      a,
      d: { x: (b.x - a.x) / length, y: (b.y - a.y) / length },
      length,
      height: wall.height ?? level.ceilingHeight,
      left,
      right,
      holes,
    });
  }
  return out;
}

/** `spans` with `cuts` taken out (both sorted or not; [from, to] pairs). */
function subtract(spans: [number, number][], cuts: [number, number][]): [number, number][] {
  let out = spans;
  for (const [c0, c1] of cuts) {
    out = out.flatMap(([s0, s1]): [number, number][] => {
      if (c1 <= s0 || c0 >= s1) return [[s0, s1]];
      const keep: [number, number][] = [];
      if (c0 - s0 > EPS) keep.push([s0, c0]);
      if (s1 - c1 > EPS) keep.push([c1, s1]);
      return keep;
    });
  }
  return out;
}

/** The part of `other` that runs along `line` with the same faces, as [t0, t1] on `line`. */
function overlap(line: Line, other: Line): [number, number] | null {
  const cross = line.d.x * other.d.y - line.d.y * other.d.x;
  if (Math.abs(cross) > 1e-6) return null;
  const n = { x: -line.d.y, y: line.d.x };
  const off = (other.a.x - line.a.x) * n.x + (other.a.y - line.a.y) * n.y;
  if (Math.abs(off) > EPS) return null;
  // Facing the other way, the other wall's left face is on our right.
  const same = line.d.x * other.d.x + line.d.y * other.d.y > 0;
  const left = same ? other.left : other.right;
  const right = same ? other.right : other.left;
  if (Math.abs(left - line.left) > EPS || Math.abs(right - line.right) > EPS) return null;
  // Cut down to a half-height wall is a hack too.
  if (Math.abs(other.height - line.height) > EPS) return null;
  const t = (p: Vec2) => (p.x - line.a.x) * line.d.x + (p.y - line.a.y) * line.d.y;
  const t0 = t(other.a);
  const t1 = t0 + (same ? other.length : -other.length);
  const lo = Math.max(0, Math.min(t0, t1));
  const hi = Math.min(line.length, Math.max(t0, t1));
  return hi - lo > EPS ? [lo, hi] : null;
}

/** The stretches of each line in `from` that no line in `against` covers. */
function uncovered(from: Line[], against: Line[]): WallStretch[] {
  const out: WallStretch[] = [];
  for (const line of from) {
    const covers = against
      .map((o) => overlap(line, o))
      .filter((c): c is [number, number] => !!c)
      .sort((p, q) => p[0] - q[0]);
    let at = 0;
    let gaps: [number, number][] = [];
    for (const [lo, hi] of covers) {
      if (lo - at > EPS) gaps.push([at, lo]);
      at = Math.max(at, hi);
    }
    if (line.length - at > EPS) gaps.push([at, line.length]);
    // A doorway in the wall was never wall to hack or build.
    gaps = subtract(gaps, line.holes);
    for (const [t0, t1] of gaps) {
      const p = (t: number, side: number) => ({
        x: line.a.x + line.d.x * t - line.d.y * side,
        y: line.a.y + line.d.y * t + line.d.x * side,
      });
      out.push({
        wallId: line.wall.id,
        from: p(t0, 0),
        to: p(t1, 0),
        length: t1 - t0,
        polygon: [p(t0, line.left), p(t1, line.left), p(t1, -line.right), p(t0, -line.right)],
      });
    }
  }
  return out;
}

interface Gap {
  id: string;
  kind: string;
  centre: Vec2;
  width: number;
  height: number;
  sill: number;
}

function gapsOf(level: Level): Gap[] {
  const out: Gap[] = [];
  for (const o of Object.values(level.openings)) {
    const w = level.walls[o.wallId];
    const a = w && level.vertices[w.a];
    const b = w && level.vertices[w.b];
    if (!a || !b) continue;
    const centre = { x: a.x + (b.x - a.x) * o.t, y: a.y + (b.y - a.y) * o.t };
    out.push({ id: o.id, kind: o.kind, centre, width: o.width, height: o.height, sill: o.sill });
  }
  return out;
}

const sameGap = (p: Gap, q: Gap) =>
  p.kind === q.kind &&
  Math.hypot(p.centre.x - q.centre.x, p.centre.y - q.centre.y) < 0.01 &&
  Math.abs(p.width - q.width) < 0.005 &&
  Math.abs(p.height - q.height) < 0.005 &&
  Math.abs(p.sill - q.sill) < 0.005;

/**
 * What a renovation changes, as a hacking plan shows it: the wall taken away and the wall
 * put up, matched by where walls run (not by id), so a wall split or redrawn in the same
 * place counts as unchanged, and one moved, thickened or cut down counts as hacked and
 * rebuilt. Doors and windows are matched by where they are and their size, so one moved or
 * widened counts as removed and added.
 */
export function renovationDiff(before: Level, after: Level): RenovationDiff {
  const b = linesOf(before);
  const a = linesOf(after);
  const demolished = uncovered(b, a);
  const built = uncovered(a, b);
  const sum = (xs: WallStretch[]) => xs.reduce((s, x) => s + x.length, 0);
  const area = (l: Level) => Object.values(l.rooms).reduce((s, r) => s + roomArea(l, r), 0);
  const gb = gapsOf(before);
  const ga = gapsOf(after);
  return {
    demolished,
    built,
    demolishedLength: sum(demolished),
    builtLength: sum(built),
    openingsAdded: ga.filter((g) => !gb.some((h) => sameGap(g, h))).map((g) => g.id),
    openingsRemoved: gb.filter((g) => !ga.some((h) => sameGap(g, h))).map((g) => g.id),
    areaBefore: area(before),
    areaAfter: area(after),
  };
}

/**
 * Where a change is: the rooms either side of it, by name (sorted; one per room, so two rooms
 * of the same name both show), and whether one side is outside.
 */
export interface ChangePlace {
  rooms: string[];
  outside: boolean;
}

type OpeningKind = 'door' | 'window' | 'passage';

/** One change a renovation makes, placed by the rooms it touches. */
export type RenovationChange = ChangePlace &
  (
    | { kind: 'hack' | 'build'; length: number }
    | {
        kind: 'opening';
        /** 'with-wall': it went with the wall it was in, hacked. */
        change: 'added' | 'removed' | 'with-wall' | 'changed';
        opening: OpeningKind;
        width: number;
        /** For one changed: what it was, where that differs, and whether it moved. */
        before?: { opening?: OpeningKind; width?: number; height?: number; sill?: number };
        height?: number;
        sill?: number;
        moved?: boolean;
      }
    | { kind: 'floor'; from: string; to: string }
    | { kind: 'area'; before: number; after: number }
    | { kind: 'rename'; from: string }
    | { kind: 'room'; change: 'added' | 'removed'; area: number }
  );

/** How far past a wall's face to look for the room on that side. */
const PROBE = 0.05;

type Rooms = { level: Level; name: (roomId: string) => string };

/** The room containing a point, if any. */
function roomAt(level: Level, p: Vec2) {
  const shapes = roomShapes(level);
  return Object.values(level.rooms).find((r) => {
    const s = shapes.get(r.id);
    return !!s && pointInPolygon(p, s.outer) && !s.holes.some((h) => pointInPolygon(p, h));
  });
}

/** The rooms containing each point: names, sorted, and whether a point found none. */
function placeOf({ level, name }: Rooms, points: Vec2[]): ChangePlace {
  const ids = new Set<string>();
  let outside = false;
  for (const p of points) {
    const room = roomAt(level, p);
    if (room) ids.add(room.id);
    else outside = true;
  }
  return { rooms: [...ids].map(name).sort(), outside };
}

/** The points just past each face of a stretch, at its middle. */
function besideStretch(s: WallStretch): Vec2[] {
  const [l0, l1, r1, r0] = s.polygon as [Vec2, Vec2, Vec2, Vec2];
  const len = Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y) || 1;
  const n = { x: -(s.to.y - s.from.y) / len, y: (s.to.x - s.from.x) / len };
  return [
    { x: (l0.x + l1.x) / 2 + n.x * PROBE, y: (l0.y + l1.y) / 2 + n.y * PROBE },
    { x: (r0.x + r1.x) / 2 - n.x * PROBE, y: (r0.y + r1.y) / 2 - n.y * PROBE },
  ];
}

/** An opening's middle and its wall's direction, or null. */
function openingAt(level: Level, id: string): { c: Vec2; d: Vec2; wall: Wall } | null {
  const o = level.openings[id];
  const w = o && level.walls[o.wallId];
  const a = w && level.vertices[w.a];
  const b = w && level.vertices[w.b];
  if (!o || !w || !a || !b) return null;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return {
    c: { x: a.x + (b.x - a.x) * o.t, y: a.y + (b.y - a.y) * o.t },
    d: { x: (b.x - a.x) / len, y: (b.y - a.y) / len },
    wall: w,
  };
}

/** The points just past each face of a wall at an opening's middle. */
function besideOpening(level: Level, id: string): Vec2[] {
  const at = openingAt(level, id);
  if (!at) return [];
  const n = { x: -at.d.y, y: at.d.x };
  const f = wallFaces(at.wall);
  return [
    { x: at.c.x + n.x * (f.left + PROBE), y: at.c.y + n.y * (f.left + PROBE) },
    { x: at.c.x - n.x * (f.right + PROBE), y: at.c.y - n.y * (f.right + PROBE) },
  ];
}

/** Whether a wall of `level` runs through `c` along `d` (so an opening there has a wall). */
function wallRunsThrough(level: Level, c: Vec2, d: Vec2): boolean {
  return linesOf(level).some((l) => {
    if (Math.abs(l.d.x * d.y - l.d.y * d.x) > 1e-6) return false;
    const t = (c.x - l.a.x) * l.d.x + (c.y - l.a.y) * l.d.y;
    const off = Math.abs((c.x - l.a.x) * -l.d.y + (c.y - l.a.y) * l.d.x);
    return off < 0.01 && t > -EPS && t < l.length + EPS;
  });
}

/** A point well inside a room's floor (clear of its holes), as rooms are matched by. */
function insidePoint(level: Level, roomId: string): Vec2 | null {
  const s = roomShapes(level).get(roomId);
  if (!s || s.outer.length < 3) return null;
  return placeLabel(s.outer, { x: 0.05, y: 0.05 }, [], s.holes);
}

/**
 * The renovation's rooms matched to the flat's by where they are (each one's inside point in
 * the other), not by id: a wall hacked and drawn again can leave a room with a new id.
 */
function matchRooms(before: Level, after: Level): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of Object.values(after.rooms)) {
    const pa = insidePoint(after, a.id);
    const b = pa && roomAt(before, pa);
    const pb = b && insidePoint(before, b.id);
    if (b && pb && roomAt(after, pb)?.id === a.id) out.set(a.id, b.id);
  }
  return out;
}

/** Changes in one place come out in this order. */
const KIND_ORDER = ['hack', 'build', 'opening', 'rename', 'floor', 'area', 'room'];

/**
 * What a renovation changes, item by item, each placed by the rooms it touches (found in
 * the version it is in, and named as the room is in the renovation): wall hacked and built
 * (lengths summed per place), doors, windows and openings added, removed (or gone with the
 * wall) or changed, rooms renamed, refinished, grown or shrunk, and rooms new or gone. Rooms
 * are matched between versions by where they are. Ordered by place. For a list to discuss
 * with a contractor.
 */
export function renovationChanges(
  before: Level,
  after: Level,
  diff: RenovationDiff = renovationDiff(before, after),
): RenovationChange[] {
  const matched = matchRooms(before, after);
  const afterOf = new Map([...matched].map(([a, b]) => [b, a]));
  const inAfter: Rooms = { level: after, name: (id) => after.rooms[id]?.name ?? '' };
  const inBefore: Rooms = {
    level: before,
    name: (id) => after.rooms[afterOf.get(id) ?? '']?.name ?? before.rooms[id]?.name ?? '',
  };
  const out: RenovationChange[] = [];
  const walls = (kind: 'hack' | 'build', rooms: Rooms, stretches: WallStretch[]) => {
    const byPlace = new Map<string, { place: ChangePlace; length: number }>();
    for (const s of stretches) {
      const place = placeOf(rooms, besideStretch(s));
      const k = `${place.rooms.join('\u0000')}|${place.outside}`;
      const cur = byPlace.get(k);
      if (cur) cur.length += s.length;
      else byPlace.set(k, { place, length: s.length });
    }
    for (const { place, length } of byPlace.values()) out.push({ ...place, kind, length });
  };
  walls('hack', inBefore, diff.demolished);
  walls('build', inAfter, diff.built);
  const kindOf = (k: string): OpeningKind => (k === 'door' || k === 'window' ? k : 'passage');
  const differs = (p: number, q: number) => Math.abs(p - q) > 0.004;
  for (const id of diff.openingsAdded) {
    const o = after.openings[id];
    if (!o) continue;
    const was = diff.openingsRemoved.includes(id) ? before.openings[id] : undefined;
    const place = placeOf(inAfter, besideOpening(after, id));
    const base = { ...place, kind: 'opening' as const, opening: kindOf(o.kind), width: o.width };
    if (!was) {
      out.push({ ...base, change: 'added' });
      continue;
    }
    const p0 = openingAt(before, id)?.c;
    const p1 = openingAt(after, id)?.c;
    const prev = {
      ...(kindOf(was.kind) !== kindOf(o.kind) ? { opening: kindOf(was.kind) } : {}),
      ...(differs(was.width, o.width) ? { width: was.width } : {}),
      ...(differs(was.height, o.height) ? { height: was.height } : {}),
      ...(differs(was.sill, o.sill) ? { sill: was.sill } : {}),
    };
    out.push({
      ...base,
      change: 'changed',
      before: prev,
      height: o.height,
      sill: o.sill,
      moved: !!p0 && !!p1 && Math.hypot(p1.x - p0.x, p1.y - p0.y) > 0.01,
    });
  }
  for (const id of diff.openingsRemoved) {
    const o = before.openings[id];
    if (!o || diff.openingsAdded.includes(id)) continue;
    const at = openingAt(before, id);
    out.push({
      ...placeOf(inBefore, besideOpening(before, id)),
      kind: 'opening',
      change: at && !wallRunsThrough(after, at.c, at.d) ? 'with-wall' : 'removed',
      opening: kindOf(o.kind),
      width: o.width,
    });
  }
  for (const r of Object.values(after.rooms)) {
    const was = before.rooms[matched.get(r.id) ?? ''];
    const place = { rooms: [r.name], outside: false };
    if (!was) {
      out.push({ ...place, kind: 'room', change: 'added', area: roomArea(after, r) });
      continue;
    }
    if (was.name !== r.name) out.push({ ...place, kind: 'rename', from: was.name });
    if (was.floorMaterial !== r.floorMaterial) {
      const name = (id: string) => finish(id)?.name ?? id;
      out.push({
        ...place,
        kind: 'floor',
        from: name(was.floorMaterial),
        to: name(r.floorMaterial),
      });
    }
    const a0 = roomArea(before, was);
    const a1 = roomArea(after, r);
    if (Math.abs(a1 - a0) >= 0.05) out.push({ ...place, kind: 'area', before: a0, after: a1 });
  }
  for (const r of Object.values(before.rooms)) {
    if (afterOf.has(r.id)) continue;
    out.push({
      rooms: [r.name],
      outside: false,
      kind: 'room',
      change: 'removed',
      area: roomArea(before, r),
    });
  }
  // By place (a room before the walls it shares, outside walls after), then kind.
  const byPlace = (p: RenovationChange, q: RenovationChange) => {
    for (let i = 0; i < Math.min(p.rooms.length, q.rooms.length); i++) {
      const c = (p.rooms[i] as string).localeCompare(q.rooms[i] as string);
      if (c) return c;
    }
    return p.rooms.length - q.rooms.length || Number(p.outside) - Number(q.outside);
  };
  return out
    .map((c, i) => ({ c, i }))
    .sort(
      (p, q) =>
        byPlace(p.c, q.c) ||
        KIND_ORDER.indexOf(p.c.kind) - KIND_ORDER.indexOf(q.c.kind) ||
        p.i - q.i,
    )
    .map(({ c }) => c);
}
