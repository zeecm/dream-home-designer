import { roomIdAt, roomsBeside } from './designer/spaces';
import { type WallFrame, framePoint, planGeometry } from './plan';
import { openPlan } from './sceneFacts';
import {
  type Level,
  type Vec2,
  type Vec3,
  type Wall,
  hasGlassAbove,
  isBoundary,
  isGlass,
  isHalfWall,
} from './schema';

/**
 * An opening that lets the sky into a room, for the exact render's lights in them ("portals",
 * one each, carrying the sky's and the ground's light through it, so a room's daylight is aimed
 * at rather than found by chance): a window, a passage, a glazed door, a glass wall, the gap
 * over a half wall (glazed if it has glass above) or a boundary, between a room and outside.
 */
export interface SkyOpening {
  /** The opening's id, or the wall's. */
  id: string;
  /** The room inside. */
  roomId: string;
  /**
   * Where its light goes, the middle of it (plan): just inside the pane (a hair on the room's
   * side of it, at the middle of the wall's thickness), or, for an open passage, the wall's
   * outer face; a glazed door's at the wall's inner face (its leaf may stand anywhere between).
   * Whatever of the hole is behind it (its reveal, the sides of the hole through the wall)
   * hides some of the sky; whatever is in front of it, it lights.
   */
  at: Vec2;
  /** Unit vectors: out of the room, and along the wall. */
  out: Vec2;
  along: Vec2;
  width: number;
  /** Its foot above the floor, and its height, metres. */
  bottom: number;
  height: number;
  /** Glazed (a window, a glazed door, glass), or open (a passage, a gap, a boundary). */
  glazed: boolean;
  /** How deep the hole is beyond `at`, to the wall's outer face, metres. */
  depth: number;
}

/** A pane's half thickness (as the 3D view builds it), and a hair more. */
const PANE = 0.005 + 0.001;

/**
 * How much of the light that falls on an opening's outer face gets through to its inner face,
 * past the reveal (the sides of the hole through the wall), for light even all round: the view
 * factor between two parallel `width` × `height` rectangles `depth` apart (the hole's two
 * ends). A 2 m by 1.2 m window in a 0.2 m wall lets 78% through; a hole in no wall, all.
 */
export function revealPasses(width: number, height: number, depth: number): number {
  if (depth <= 0) return 1;
  if (width <= 0 || height <= 0) return 0;
  const x = width / depth;
  const y = height / depth;
  const x1 = Math.sqrt(1 + x * x);
  const y1 = Math.sqrt(1 + y * y);
  const f =
    (2 / (Math.PI * x * y)) *
    (Math.log((x1 * y1) / Math.sqrt(1 + x * x + y * y)) +
      x * y1 * Math.atan(x / y1) +
      y * x1 * Math.atan(y / x1) -
      x * Math.atan(x) -
      y * Math.atan(y));
  return Math.min(1, Math.max(0, f));
}

/** The room inside a wall that has outside on its other side, and which side it is (+1 left). */
function insideOf(level: Level, wallId: string): { roomId: string; side: number } | null {
  const [left, right] = roomsBeside(level, wallId);
  if (left !== null && right === null) return { roomId: left, side: 1 };
  if (right !== null && left === null) return { roomId: right, side: -1 };
  return null;
}

/** A point `k` metres from the wall's middle line toward the room (`side`), at `u` along it. */
function toRoom(f: WallFrame, u: number, side: number, k: number): Vec2 {
  const c = framePoint(f, u, 0);
  return { x: c.x + f.n.x * side * k, y: c.y + f.n.y * side * k };
}

/**
 * Every opening that lets the sky into a room (`SkyOpening`). An opening in a glass wall is
 * part of the wall's (one light, not two).
 */
export function skyOpenings(level: Level): SkyOpening[] {
  const geom = planGeometry(level);
  const out: SkyOpening[] = [];
  const base = (f: WallFrame, s: { roomId: string; side: number }) => ({
    roomId: s.roomId,
    out: { x: -f.n.x * s.side, y: -f.n.y * s.side },
    along: f.d,
  });
  for (const o of geom.openings) {
    const op = o.opening;
    const wall = level.walls[o.wallId];
    const f = geom.frames[o.wallId];
    if (!wall || !f || isGlass(wall)) continue;
    const lets =
      op.kind === 'window' || op.kind === 'passage' || (op.kind === 'door' && !!op.glazed);
    const s = lets ? insideOf(level, o.wallId) : null;
    if (!s) continue;
    const [u0, u1] = o.span;
    const u = (u0 + u1) / 2;
    // A window's pane is at the middle of the wall; a passage has none, so its light goes at
    // the far end of the hole; a door's leaf may stand anywhere in it, so its light goes in
    // front of it all.
    const [at, depth] =
      op.kind === 'window'
        ? [toRoom(f, u, s.side, PANE), f.half - PANE]
        : op.kind === 'passage'
          ? [toRoom(f, u, s.side, -f.half + 0.001), 0]
          : [toRoom(f, u, s.side, f.half + 0.001), 2 * f.half];
    out.push({
      id: op.id,
      ...base(f, s),
      at,
      width: u1 - u0,
      bottom: op.sill,
      height: op.height,
      glazed: op.kind !== 'passage',
      depth: Math.max(0, depth),
    });
  }
  for (const w of Object.values(level.walls)) {
    const f = geom.frames[w.id];
    const s = f ? insideOf(level, w.id) : null;
    if (!s || !f) continue;
    const ceiling = level.ceilingHeight;
    const gap = (bottom: number, glazed: boolean): SkyOpening => ({
      id: w.id,
      ...base(f, s),
      at: toRoom(f, f.length / 2, s.side, glazed ? PANE : 0),
      width: f.length,
      bottom,
      height: ceiling - bottom,
      glazed,
      depth: 0,
    });
    if (isGlass(w)) out.push(gap(0, true));
    else if (isBoundary(w)) out.push(gap(0, false));
    else if (isHalfWall(w, ceiling)) out.push(gap(wallTop(w, ceiling), hasGlassAbove(w, ceiling)));
  }
  return out.filter((o) => o.width > 1e-6 && o.height > 1e-6);
}

const wallTop = (w: Wall, ceiling: number) => Math.min(w.height ?? ceiling, ceiling);

/**
 * The rooms whose daylight a camera in `roomId` sees the effect of: its open-plan space, and on
 * from each room to the next through what lets light across: a passage, an inside window, a
 * glazed door, a door standing open (`doors`: inside doors' open fractions, as the 3D view
 * shows them; one not listed stands open, as built), a glass wall, a half wall.
 */
export function daylightReach(
  level: Level,
  roomId: string,
  doors?: ReadonlyMap<string, number>,
): Set<string> {
  const ceiling = level.ceilingHeight;
  const joins: [string, string][] = [];
  const pair = (wallId: string) => {
    const [a, b] = roomsBeside(level, wallId);
    if (a && b && a !== b) joins.push([a, b]);
  };
  for (const o of Object.values(level.openings)) {
    const across = o.kind !== 'door' || !!o.glazed || (doors?.get(o.id) ?? 1) > OPEN_ENOUGH;
    if (across) pair(o.wallId);
  }
  for (const w of Object.values(level.walls)) {
    if (isGlass(w) || isHalfWall(w, ceiling)) pair(w.id);
  }
  const reach = new Set<string>();
  const queue = [roomId];
  while (queue.length) {
    const r = queue.pop() as string;
    if (reach.has(r)) continue;
    for (const x of openPlan(level, r)) reach.add(x);
    for (const [a, b] of joins) {
      if (reach.has(a) && !reach.has(b)) queue.push(b);
      if (reach.has(b) && !reach.has(a)) queue.push(a);
    }
  }
  return reach;
}

/** A door open less than this lets next to no light by. */
const OPEN_ENOUGH = 0.05;

/**
 * How much of the ground an opening looks down on is in the sun (0 to 1): points on the ground
 * outside it, at even steps of how far below the level the view looks, weighted as they light
 * the opening (cos²), across its width, each tested against the walls (as tall as they stand)
 * on the way to the sun. A point inside the house (another wing) counts as shade. `sun` is the
 * direction to the sun (world: x, up, plan y as z).
 */
export function groundInSun(level: Level, o: SkyOpening, sun: Vec3 | null): number {
  if (!sun || sun.y <= 0) return 0;
  const flat = Math.hypot(sun.x, sun.z);
  const geom = planGeometry(level);
  const walls = Object.values(level.walls)
    .filter((w) => !isBoundary(w))
    .map((w) => ({ f: geom.frames[w.id], top: wallTop(w, level.ceilingHeight) }))
    .filter((w): w is { f: WallFrame; top: number } => !!w.f);
  const lit = (p: Vec2): boolean => {
    if (flat < 1e-9) return true;
    const d = { x: sun.x / flat, y: sun.z / flat };
    const rise = sun.y / flat;
    for (const { f, top } of walls) {
      // Where the ray toward the sun (plan) crosses the wall's middle line.
      const den = d.x * f.d.y - d.y * f.d.x;
      if (Math.abs(den) < 1e-12) continue;
      const ax = f.a.x - p.x;
      const ay = f.a.y - p.y;
      const t = (ax * f.d.y - ay * f.d.x) / den;
      const s = (ax * d.y - ay * d.x) / den;
      if (t > 1e-6 && s >= 0 && s <= f.length && t * rise < top) return false;
    }
    return true;
  };
  const inRoom = (p: Vec2) => roomIdAt(level, p) !== null;
  // The view's middle height above the ground (the ground at the level's floor).
  const eye = o.bottom + o.height / 2;
  const face = { x: o.at.x + o.out.x * (o.depth + 0.01), y: o.at.y + o.out.y * (o.depth + 0.01) };
  let sum = 0;
  let all = 0;
  const steps = 6;
  for (let i = 0; i < steps; i++) {
    const down = ((i + 0.5) / steps) * (Math.PI / 2);
    const w = Math.cos(down) ** 2;
    const far = Math.min(eye / Math.tan(down), 60);
    for (const k of [-0.4, 0, 0.4]) {
      const p = {
        x: face.x + o.out.x * far + o.along.x * o.width * k,
        y: face.y + o.out.y * far + o.along.y * o.width * k,
      };
      all += w;
      if (!inRoom(p) && lit(p)) sum += w;
    }
  }
  return all > 0 ? sum / all : 0;
}
