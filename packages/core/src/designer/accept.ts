import { current, isDraft } from 'immer';
import { furnitureKind } from '../furniture';
import { pointInPolygon } from '../geometry';
import type { Command } from '../history';
import { AFTER_SUFFIX, draftLevel } from '../levels';
import { matchRooms } from '../renovation';
import { roomArea, roomShapes } from '../rooms';
import type { Item, Level, Vec2 } from '../schema';
import { applyLevel } from '../topology';
import { WET } from './locks';
import { type Aspect, BATHROOMS, type Part } from './schema';
import { type Space, roomsBeside, spacesOf } from './spaces';

/**
 * Accepting a version: what is ticked goes into the renovation in one undo step, starting a
 * renovation if there is none. The walls part (all or nothing) brings the version's walls,
 * doors and room names; each space then takes its furniture, built-ins, finishes and
 * electrical points as ticked. Pieces placed by hand since the version was made are kept
 * unless `removeHandPlaced`. A space whose outline depends on the version's walls takes
 * nothing without the walls part.
 */

export interface AcceptOptions {
  /** The level the version was designed on: pieces in After that aren't in it (nor in the
   * version) were placed by hand since, and are kept. Without it, every piece in After that
   * the version doesn't have is treated as placed by hand. */
  base?: Level;
  removeHandPlaced?: boolean;
  label?: string;
}

const centre = (it: Item): Vec2 => ({ x: it.position.x, y: it.position.z });

/** Furniture or built-ins: which part a piece belongs to. */
export const aspectOf = (it: Item): Aspect =>
  furnitureKind(it.assetId)?.carpentry ? 'built-ins' : 'furniture';

/** Whether the space's outline in `target` differs from `now` (so it needs the version's walls). */
export function dependsOnWalls(now: Level, target: Level, space: Space): boolean {
  const matched = matchRooms(now, target);
  return space.rooms.some((id) => {
    const was = matched.get(id);
    const a = target.rooms[id];
    const b = was ? now.rooms[was] : undefined;
    return !a || !b || Math.abs(roomArea(target, a) - roomArea(now, b)) > 0.05;
  });
}

/** The parts of `parts` a space can take on `now`: none of a wall-dependent one without walls. */
export function allowedParts(now: Level, target: Level, parts: Part[]): Part[] {
  if (parts.some((p) => p.aspect === 'walls')) return parts;
  const spaces = new Map(spacesOf(target).map((s) => [s.key, s]));
  return parts.filter((p) => {
    if (!('space' in p) || p.space === BATHROOMS) return true;
    const s = spaces.get(p.space);
    return !!s && !dependsOnWalls(now, target, s);
  });
}

/**
 * The level After becomes: `now` (After as it is, or the flat as it is with no renovation)
 * with the parts taken from `target` (a DesignResult's level).
 */
export function mergeDesign(
  now: Level,
  target: Level,
  parts: Part[],
  opts: AcceptOptions = {},
): Level {
  const ok = allowedParts(now, target, parts);
  const walls = ok.some((p) => p.aspect === 'walls');
  const has = (space: string, aspect: Part['aspect']) =>
    ok.some((p) => 'space' in p && p.space === space && p.aspect === aspect);
  const out: Level = structuredClone(now);
  if (walls) {
    out.vertices = structuredClone(target.vertices);
    out.openings = structuredClone(target.openings);
    // Walls as the version has them, finished as they are now (finishes are their own part).
    out.walls = Object.fromEntries(
      Object.values(target.walls).map((w) => {
        const was = now.walls[w.id];
        return [
          w.id,
          {
            ...structuredClone(w),
            materialLeft: was?.materialLeft ?? 'paint-white',
            materialRight: was?.materialRight ?? 'paint-white',
          },
        ];
      }),
    );
    const matched = matchRooms(now, target);
    out.rooms = Object.fromEntries(
      Object.values(target.rooms).map((r) => {
        const was = now.rooms[matched.get(r.id) ?? r.id];
        return [r.id, { ...structuredClone(r), floorMaterial: was?.floorMaterial ?? 'wood-oak' }];
      }),
    );
    // Points on walls that are gone go with them.
    out.points = Object.fromEntries(
      Object.entries(now.points ?? {}).filter(([, p]) => !p.wall || !!out.walls[p.wall.wallId]),
    );
  }

  const spaces = spacesOf(target);
  const shapes = roomShapes(target);
  const inRooms = (rooms: string[], p: Vec2) =>
    rooms.some((id) => {
      const s = shapes.get(id);
      return !!s && pointInPolygon(p, s.outer) && !s.holes.some((h) => pointInPolygon(p, h));
    });
  const base = opts.base;
  const byHand = (it: Item) => !target.items[it.id] && (!base || !base.items[it.id]);

  for (const s of spaces) {
    for (const aspect of ['furniture', 'built-ins'] as const) {
      if (!has(s.key, aspect)) continue;
      for (const it of Object.values(out.items)) {
        if (aspectOf(it) !== aspect || !inRooms(s.rooms, centre(it))) continue;
        if (byHand(it) && !opts.removeHandPlaced) continue;
        delete out.items[it.id];
      }
      for (const it of Object.values(target.items)) {
        if (aspectOf(it) === aspect && inRooms(s.rooms, centre(it))) {
          out.items[it.id] = structuredClone(it);
        }
      }
    }
    if (has(s.key, 'finishes')) finishRooms(out, target, s.rooms);
    if (has(s.key, 'electrical')) {
      out.points ??= {};
      for (const p of Object.values(target.points ?? {})) {
        if (out.points[p.id]) continue;
        const at = p.at ?? wallPointAt(target, p.wall);
        if (at && inRooms(s.rooms, at) && (!p.wall || out.walls[p.wall.wallId])) {
          out.points[p.id] = structuredClone(p);
        }
      }
    }
  }
  if (has(BATHROOMS, 'finishes')) {
    finishRooms(
      out,
      target,
      Object.values(target.rooms)
        .filter((r) => WET.test(r.name))
        .map((r) => r.id),
    );
  }
  return out;
}

/** Floors of `rooms` and the wall faces towards them, as `target` has them. */
function finishRooms(out: Level, target: Level, rooms: string[]) {
  const set = new Set(rooms);
  for (const id of rooms) {
    const r = target.rooms[id];
    const o = out.rooms[id];
    if (r && o) o.floorMaterial = r.floorMaterial;
  }
  for (const w of Object.values(target.walls)) {
    const o = out.walls[w.id];
    if (!o) continue;
    const [l, r] = roomsBeside(target, w.id);
    if (l && set.has(l)) o.materialLeft = w.materialLeft;
    if (r && set.has(r)) o.materialRight = w.materialRight;
  }
}

/** A wall point's place on the plan, just off its face. */
function wallPointAt(
  level: Level,
  wall: { wallId: string; t: number; side: 'left' | 'right' } | undefined,
) {
  const w = wall && level.walls[wall.wallId];
  const a = w && level.vertices[w.a];
  const b = w && level.vertices[w.b];
  if (!wall || !w || !a || !b) return null;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const k = (wall.side === 'left' ? 1 : -1) * (w.thickness / 2 + 0.05);
  return {
    x: a.x + (b.x - a.x) * wall.t + (-(b.y - a.y) / len) * k,
    y: a.y + (b.y - a.y) * wall.t + ((b.x - a.x) / len) * k,
  };
}

/**
 * Puts a version's parts into the renovation of level `levelId` (the flat as it is), starting
 * one if there is none: one undo step. `target` is the version's DesignResult level, worked
 * out on After as it is now (or the flat, with no renovation).
 */
export function acceptDesign(
  levelId: string,
  target: Level,
  parts: Part[],
  opts: AcceptOptions = {},
): Command {
  return {
    label: opts.label ?? 'Use design',
    recipe: (d) => {
      if (!d.renovation) {
        const levels = d.levels.map((l) => ({
          ...structuredClone(current(l)),
          id: `${l.id}${AFTER_SUFFIX}`,
        }));
        d.renovation = { levels };
      }
      const after = draftLevel(d, `${levelId}${AFTER_SUFFIX}`);
      const now = (isDraft(after) ? current(after) : after) as Level;
      const next = mergeDesign(now, target, parts, opts);
      applyLevel(after, next, { items: true });
    },
  };
}
