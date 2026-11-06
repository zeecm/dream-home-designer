import { roomsBeside } from './designer/spaces';
import { framePoint, planGeometry } from './plan';
import { openPlan } from './sceneFacts';
import { type Level, type Vec2, isGlass } from './schema';

/** Below this much daylight (0 to 1, `daylight`) the lamps go on whatever the room. */
export const LAMPS_DAYLIGHT = 0.35;

/**
 * Whether daylight reaches room `roomId` straight from outside: a window, a glazed door, an
 * open doorway or a glass wall between it and no room. Its open-plan neighbours (rooms joined
 * by a boundary, no wall) count too, as the light crosses into them.
 */
export function roomHasDaylight(level: Level, roomId: string): boolean {
  const space = new Set(openPlan(level, roomId));
  const outsideOf = (wallId: string) => {
    const [a, b] = roomsBeside(level, wallId);
    return (a !== null && space.has(a) && b === null) || (b !== null && space.has(b) && a === null);
  };
  for (const o of Object.values(level.openings)) {
    const lets = o.kind === 'window' || o.kind === 'passage' || (o.kind === 'door' && !!o.glazed);
    if (lets && outsideOf(o.wallId)) return true;
  }
  for (const w of Object.values(level.walls)) {
    if (isGlass(w) && outsideOf(w.id)) return true;
  }
  return false;
}

/**
 * The exact render's lamps, left on Auto: on when it's dark (`light` below LAMPS_DAYLIGHT), or
 * when the camera stands in a room daylight doesn't reach; otherwise off. A camera in no room
 * (an orbit view from outside, over the cut-away walls) has the sky's light.
 */
export function lampsAuto(level: Level, cameraRoomId: string | null, light: number): boolean {
  if (light < LAMPS_DAYLIGHT) return true;
  return (
    cameraRoomId !== null && !!level.rooms[cameraRoomId] && !roomHasDaylight(level, cameraRoomId)
  );
}

/**
 * An opening that lets the sky into a room: a window, a passage, a glazed door or a glass wall
 * between a room and the outside. The exact render puts a light in each ("portal"), carrying
 * the sky's light through it, so a room's daylight is aimed at rather than found by chance.
 */
export interface SkyOpening {
  /** The opening's id, or the glass wall's. */
  id: string;
  /** The room inside. */
  roomId: string;
  /** Its middle on the wall's inner face, the room's side (plan). */
  at: Vec2;
  /** Unit vectors: out of the room, and along the wall. */
  out: Vec2;
  along: Vec2;
  width: number;
  /** Its foot above the floor, and its height, metres. */
  bottom: number;
  height: number;
  /** Glazed (a window, a glazed door, a glass wall), or open (a passage). */
  glazed: boolean;
  /** How deep it is: its wall's thickness, metres. */
  depth: number;
}

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

export function skyOpenings(level: Level): SkyOpening[] {
  const geom = planGeometry(level);
  const out: SkyOpening[] = [];
  /** The inside room and the room's side of the wall (+1: the frame's left), or null. */
  const sides = (wallId: string): { roomId: string; side: number } | null => {
    const [left, right] = roomsBeside(level, wallId);
    if (left !== null && right === null) return { roomId: left, side: 1 };
    if (right !== null && left === null) return { roomId: right, side: -1 };
    return null;
  };
  for (const o of geom.openings) {
    const op = o.opening;
    const lets =
      op.kind === 'window' || op.kind === 'passage' || (op.kind === 'door' && !!op.glazed);
    const s = lets ? sides(o.wallId) : null;
    if (!s) continue;
    const [u0, u1] = o.span;
    const f = o.frame;
    out.push({
      id: op.id,
      roomId: s.roomId,
      at: framePoint(f, (u0 + u1) / 2, s.side),
      out: { x: -f.n.x * s.side, y: -f.n.y * s.side },
      along: f.d,
      width: u1 - u0,
      bottom: op.sill,
      height: op.height,
      glazed: op.kind !== 'passage',
      depth: level.walls[o.wallId]?.thickness ?? 0,
    });
  }
  for (const w of Object.values(level.walls)) {
    const f = geom.frames[w.id];
    const s = isGlass(w) && f ? sides(w.id) : null;
    if (!s || !f) continue;
    out.push({
      id: w.id,
      roomId: s.roomId,
      at: framePoint(f, f.length / 2, s.side),
      out: { x: -f.n.x * s.side, y: -f.n.y * s.side },
      along: f.d,
      width: f.length,
      bottom: 0,
      height: w.height ?? level.ceilingHeight,
      glazed: true,
      depth: w.thickness,
    });
  }
  return out;
}

/**
 * The rooms whose daylight a camera in `roomId` can see the effect of: its open-plan space and
 * the rooms through any door or opening from it (and their open-plan spaces).
 */
export function daylightReach(level: Level, roomId: string): Set<string> {
  const space = new Set(openPlan(level, roomId));
  const reach = new Set(space);
  for (const o of Object.values(level.openings)) {
    if (o.kind === 'window') continue;
    const [a, b] = roomsBeside(level, o.wallId);
    const other = a && space.has(a) ? b : b && space.has(b) ? a : null;
    if (other) for (const r of openPlan(level, other)) reach.add(r);
  }
  return reach;
}
