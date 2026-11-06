import { freeze } from 'immer';
import type { Level, Vec2 } from '../schema';

/** FNV-1a over a string, base 36, 7 characters: stable ids from a design's inputs. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

/** A seeded id: the same parts always give the same id. */
export const seededId = (prefix: string, ...parts: (string | number)[]) =>
  `${prefix}_d${hash(parts.join('|'))}`;

/** JSON with object keys sorted, so the same data always gives the same text. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableJson(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * What a level is, as far as a design depends on it: its walls, corners, openings, rooms
 * (with their finishes), pieces and points. Record order doesn't change it.
 */
export function levelFingerprint(level: Level): string {
  const { vertices, walls, openings, rooms, items, points, ceilingHeight } = level;
  return hash(stableJson({ vertices, walls, openings, rooms, items, points, ceilingHeight }));
}

/** A level whose records are in id order, so what is worked out from it never depends on order. */
export function sortedLevel(level: Level): Level {
  const sort = <T>(r: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return {
    ...level,
    vertices: sort(level.vertices),
    walls: sort(level.walls),
    openings: sort(level.openings),
    rooms: sort(level.rooms),
    items: sort(level.items),
    lights: sort(level.lights),
    points: sort(level.points ?? {}),
  };
}

/**
 * A sorted, deeply frozen copy of a level (the level itself when it already is one). The
 * plan's caches (room shapes, wall statuses, wall lines) keep answers only for frozen levels,
 * so everything the designer works out goes through this first.
 */
export function settled(level: Level): Level {
  if (Object.isFrozen(level) && Object.isFrozen(level.walls) && isSorted(level)) return level;
  const src = Object.isFrozen(level) ? level : structuredClone(level);
  return freeze(sortedLevel(src), true);
}

const isSorted = (level: Level) =>
  (['vertices', 'walls', 'openings', 'rooms', 'items'] as const).every((k) => {
    const keys = Object.keys(level[k]);
    return keys.every((id, i) => i === 0 || (keys[i - 1] as string) < id);
  });

/** Control characters and line separators, which have no place in a name or a prompt. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: taking them out is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Text from the plan or a model, safe to put in a prompt or a list: no control characters, cut. */
export function clean(s: string, max: number): string {
  const t = s.replace(CONTROL, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export const r2 = (v: number) => Math.round(v * 100) / 100;
export const pt = (p: Vec2): [number, number] => [r2(p.x), r2(p.y)];
export const metres = (v: number) => `${v.toFixed(2)} m`;

/** Degrees clockwise on the plan (y down) as an item's rotationY: they are the same turn. */
export const rotationOf = (degrees: number) => (((degrees % 360) + 360) % 360) * (Math.PI / 180);
