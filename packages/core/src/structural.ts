import { isDraft } from 'immer';
import { type Bounds, pointInPolygon, polygonBounds } from './geometry';
import type { Command } from './history';
import { type RoomShape, roomShapes } from './rooms';
import { type Level, isBoundary } from './schema';

/**
 * Structural and household-shelter walls. A wall is marked structural by the person
 * (`structural: true`), marked not (`false`), or not yet decided; one at least 200 mm thick
 * and undecided is probably structural (HDB plans draw concrete walls that thick). Shelter
 * walls are found from the room beside them, whatever the mark: HDB never lets them change.
 */
export type WallStatus = 'shelter' | 'structural' | 'likely' | 'none';

/** Rooms whose walls are the household shelter's. */
export const SHELTER_ROOM = /shelter|bomb|\bh\.?s\.?\b/i;

/** As thick as this, an unmarked wall is probably structural. */
export const LIKELY_THICKNESS = 0.2;

/** Room names either side of a wall at `t` along it (null where it faces outside). */
export function sidesOf(level: Level, wallId: string, t = 0.5): (string | null)[] {
  const w = level.walls[wallId];
  const a = w && level.vertices[w.a];
  const b = w && level.vertices[w.b];
  if (!w || !a || !b) return [];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-9) return [];
  const mid = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  const off = w.thickness / 2 + 0.05;
  const shapes = roomShapes(level);
  const boxes = boxesOf(shapes);
  return [1, -1].map((k) => {
    const p = { x: mid.x + n.x * off * k, y: mid.y + n.y * off * k };
    const room = Object.values(level.rooms).find((r) => {
      const s = shapes.get(r.id);
      // Outside a room's box is outside the room (a cheap test first, on a plan of many rooms).
      const b = boxes.get(r.id);
      if (!s || !b || p.x < b.min.x || p.x > b.max.x || p.y < b.min.y || p.y > b.max.y) {
        return false;
      }
      return pointInPolygon(p, s.outer) && !s.holes.some((h) => pointInPolygon(p, h));
    });
    return room?.name ?? null;
  });
}

const boxCache = new WeakMap<Map<string, RoomShape>, Map<string, Bounds>>();

/** Each room's outline's box, a millimetre over (so rounding never leaves a point out). */
function boxesOf(shapes: Map<string, RoomShape>): Map<string, Bounds> {
  let out = boxCache.get(shapes);
  if (!out) {
    out = new Map();
    for (const [id, s] of shapes) {
      const { min, max } = polygonBounds(s.outer);
      out.set(id, {
        min: { x: min.x - 1e-3, y: min.y - 1e-3 },
        max: { x: max.x + 1e-3, y: max.y + 1e-3 },
      });
    }
    boxCache.set(shapes, out);
  }
  return out;
}

/** What a wall of `level` (the flat as it is) is, for hacking. */
export function wallStatus(level: Level, wallId: string): WallStatus {
  const w = level.walls[wallId];
  if (!w || isBoundary(w)) return 'none';
  // Beside the shelter anywhere along it (a long traced wall may run past it and on).
  const shelter = [0.15, 0.5, 0.85].some((t) =>
    sidesOf(level, wallId, t).some((s) => s && SHELTER_ROOM.test(s)),
  );
  if (shelter) return 'shelter';
  if (w.structural === true) return 'structural';
  if (w.structural === undefined && w.thickness >= LIKELY_THICKNESS - 1e-6) return 'likely';
  return 'none';
}

/** Statuses, kept by the walls they were found for with the corners and rooms they saw. */
const statusCache = new WeakMap<
  object,
  { vertices: object; rooms: object; out: Map<string, Exclude<WallStatus, 'none'>> }
>();

/**
 * Every wall's status, where it isn't 'none'. Kept for a frozen level while its walls, corners
 * and rooms stay the same objects (all a status depends on), so a drag of furniture reuses it.
 */
export function wallStatuses(level: Level): Map<string, Exclude<WallStatus, 'none'>> {
  const cached = statusCache.get(level.walls);
  if (cached && cached.vertices === level.vertices && cached.rooms === level.rooms) {
    return cached.out;
  }
  const out = new Map<string, Exclude<WallStatus, 'none'>>();
  for (const id of Object.keys(level.walls)) {
    const s = wallStatus(level, id);
    if (s !== 'none') out.set(id, s);
  }
  const frozen =
    !isDraft(level) &&
    Object.isFrozen(level.walls) &&
    Object.isFrozen(level.vertices) &&
    Object.isFrozen(level.rooms);
  if (frozen) statusCache.set(level.walls, { vertices: level.vertices, rooms: level.rooms, out });
  return out;
}

/**
 * Marks walls structural or not (`value`), in the flat as it is and in the renovation alike
 * (a wall is what it is, whichever version shows it): one undo step.
 */
export function markStructural(wallIds: string[], value: boolean): Command {
  return {
    label: value ? 'Mark structural' : 'Mark not structural',
    // Written to both versions here: not carried over (nor held back) again.
    carry: false,
    recipe: (d) => {
      for (const level of [...d.levels, ...(d.renovation?.levels ?? [])]) {
        for (const id of wallIds) {
          const w = level.walls[id];
          if (w && !isBoundary(w)) w.structural = value;
        }
      }
    },
  };
}
