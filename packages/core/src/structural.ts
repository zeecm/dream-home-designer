import { pointInPolygon } from './geometry';
import type { Command } from './history';
import { roomShapes } from './rooms';
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

/** Room names either side of a wall (null where it faces outside). */
export function sidesOf(level: Level, wallId: string): (string | null)[] {
  const w = level.walls[wallId];
  const a = w && level.vertices[w.a];
  const b = w && level.vertices[w.b];
  if (!w || !a || !b) return [];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-9) return [];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  const off = w.thickness / 2 + 0.05;
  const shapes = roomShapes(level);
  return [1, -1].map((k) => {
    const p = { x: mid.x + n.x * off * k, y: mid.y + n.y * off * k };
    const room = Object.values(level.rooms).find((r) => {
      const s = shapes.get(r.id);
      return s && pointInPolygon(p, s.outer) && !s.holes.some((h) => pointInPolygon(p, h));
    });
    return room?.name ?? null;
  });
}

/** What a wall of `level` (the flat as it is) is, for hacking. */
export function wallStatus(level: Level, wallId: string): WallStatus {
  const w = level.walls[wallId];
  if (!w || isBoundary(w)) return 'none';
  if (sidesOf(level, wallId).some((s) => s && SHELTER_ROOM.test(s))) return 'shelter';
  if (w.structural === true) return 'structural';
  if (w.structural === undefined && w.thickness >= LIKELY_THICKNESS - 1e-6) return 'likely';
  return 'none';
}

/** Every wall's status, where it isn't 'none'. */
export function wallStatuses(level: Level): Map<string, Exclude<WallStatus, 'none'>> {
  const out = new Map<string, Exclude<WallStatus, 'none'>>();
  for (const id of Object.keys(level.walls)) {
    const s = wallStatus(level, id);
    if (s !== 'none') out.set(id, s);
  }
  return out;
}

/**
 * Marks walls structural or not (`value`), in the flat as it is and in the renovation alike
 * (a wall is what it is, whichever version shows it): one undo step.
 */
export function markStructural(wallIds: string[], value: boolean): Command {
  return {
    label: value ? 'Mark structural' : 'Mark not structural',
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
