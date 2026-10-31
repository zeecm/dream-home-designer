import { current } from 'immer';
import { finish } from './finishes';
import { pointInPolygon } from './geometry';
import type { Command } from './history';
import { AFTER_SUFFIX, type Variant } from './levels';
import { roomArea, roomShapes } from './rooms';
import { type Level, type Vec2, type Wall, isBoundary, wallFaces } from './schema';

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

/** Where a change is: the rooms either side of it (by name, sorted), and whether one side is outside. */
export interface ChangePlace {
  rooms: string[];
  outside: boolean;
}

/** One change a renovation makes, placed by the rooms it touches. */
export type RenovationChange = ChangePlace &
  (
    | { kind: 'hack' | 'build'; length: number }
    | {
        kind: 'opening';
        change: 'added' | 'removed' | 'changed';
        opening: 'door' | 'window' | 'passage';
        width: number;
        /** For one changed: its width before. */
        widthBefore?: number;
      }
    | { kind: 'floor'; from: string; to: string }
    | { kind: 'area'; before: number; after: number }
    | { kind: 'room'; change: 'added' | 'removed'; area: number }
  );

/** How far past a wall's face to look for the room on that side. */
const PROBE = 0.05;

/** The rooms of a level containing each point: names, sorted, and whether a point found none. */
function placeOf(level: Level, points: Vec2[]): ChangePlace {
  const shapes = roomShapes(level);
  const names = new Set<string>();
  let outside = false;
  for (const p of points) {
    const room = Object.values(level.rooms).find((r) => {
      const s = shapes.get(r.id);
      return !!s && pointInPolygon(p, s.outer) && !s.holes.some((h) => pointInPolygon(p, h));
    });
    if (room) names.add(room.name);
    else outside = true;
  }
  return { rooms: [...names].sort(), outside };
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

/** The points just past each face of a wall at an opening's middle. */
function besideOpening(level: Level, id: string): Vec2[] {
  const o = level.openings[id];
  const w = o && level.walls[o.wallId];
  const a = w && level.vertices[w.a];
  const b = w && level.vertices[w.b];
  if (!o || !w || !a || !b) return [];
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  const c = { x: a.x + (b.x - a.x) * o.t, y: a.y + (b.y - a.y) * o.t };
  const f = wallFaces(w);
  return [
    { x: c.x + n.x * (f.left + PROBE), y: c.y + n.y * (f.left + PROBE) },
    { x: c.x - n.x * (f.right + PROBE), y: c.y - n.y * (f.right + PROBE) },
  ];
}

const placeKey = (p: ChangePlace) => `${p.rooms.join('\u0000')}|${p.outside}`;

/**
 * What a renovation changes, item by item, each placed by the rooms it touches (the rooms
 * of the version it is in: the flat as it is for what goes, the renovation for what's new),
 * in order of place: wall hacked and built (lengths summed per place), doors, windows and
 * openings added, removed or changed, floors refinished, rooms that grow or shrink, and rooms
 * new or gone. For a list to discuss with a contractor.
 */
export function renovationChanges(
  before: Level,
  after: Level,
  diff: RenovationDiff = renovationDiff(before, after),
): RenovationChange[] {
  const out: RenovationChange[] = [];
  const walls = (kind: 'hack' | 'build', level: Level, stretches: WallStretch[]) => {
    const byPlace = new Map<string, { place: ChangePlace; length: number }>();
    for (const s of stretches) {
      const place = placeOf(level, besideStretch(s));
      const k = placeKey(place);
      const cur = byPlace.get(k);
      if (cur) cur.length += s.length;
      else byPlace.set(k, { place, length: s.length });
    }
    for (const { place, length } of byPlace.values()) out.push({ ...place, kind, length });
  };
  walls('hack', before, diff.demolished);
  walls('build', after, diff.built);
  const kindOf = (k: string) => (k === 'door' || k === 'window' ? k : 'passage');
  for (const id of diff.openingsAdded) {
    const o = after.openings[id];
    if (!o) continue;
    const was = diff.openingsRemoved.includes(id) ? before.openings[id] : undefined;
    out.push({
      ...placeOf(after, besideOpening(after, id)),
      kind: 'opening',
      change: was ? 'changed' : 'added',
      opening: kindOf(o.kind),
      width: o.width,
      ...(was ? { widthBefore: was.width } : {}),
    });
  }
  for (const id of diff.openingsRemoved) {
    const o = before.openings[id];
    if (!o || diff.openingsAdded.includes(id)) continue;
    out.push({
      ...placeOf(before, besideOpening(before, id)),
      kind: 'opening',
      change: 'removed',
      opening: kindOf(o.kind),
      width: o.width,
    });
  }
  for (const r of Object.values(after.rooms)) {
    const was = before.rooms[r.id];
    const place = { rooms: [r.name], outside: false };
    if (!was) {
      out.push({ ...place, kind: 'room', change: 'added', area: roomArea(after, r) });
      continue;
    }
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
    if (after.rooms[r.id]) continue;
    out.push({
      rooms: [r.name],
      outside: false,
      kind: 'room',
      change: 'removed',
      area: roomArea(before, r),
    });
  }
  // By place, keeping each place's changes in the order above.
  const order = (c: RenovationChange) => `${c.rooms.join(', ')}|${c.outside ? 1 : 0}`;
  return out
    .map((c, i) => ({ c, i }))
    .sort((p, q) => order(p.c).localeCompare(order(q.c)) || p.i - q.i)
    .map(({ c }) => c);
}
