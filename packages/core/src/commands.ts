import type { Draft } from 'immer';
import type { z } from 'zod';
import { clampOpeningT } from './geometry';
import type { Command } from './history';
import { newId } from './ids';
import { syncRooms } from './rooms';
import { type Level, Opening, type Project, Room, type Vec2, Wall, isBoundary } from './schema';
import { projectOnSegment, segmentIntersection } from './snap';
import { endCapture, reclampOpenings, splitWallAt } from './topology';

function level(draft: Draft<Project>, levelId: string): Draft<Level> {
  const lvl = draft.levels.find((l) => l.id === levelId);
  if (!lvl) throw new Error(`level ${levelId} not found`);
  return lvl;
}

export function renameProject(name: string): Command {
  return {
    label: 'Rename project',
    recipe: (d) => {
      d.name = name;
    },
  };
}

export function moveVertex(levelId: string, vertexId: string, to: Vec2): Command {
  return {
    label: 'Move corner',
    recipe: (d) => {
      const lvl = level(d, levelId);
      const v = lvl.vertices[vertexId];
      if (!v) throw new Error(`vertex ${vertexId} not found`);
      v.x = to.x;
      v.y = to.y;
      reclampOpenings(lvl);
    },
  };
}

/** An endpoint is either an existing vertex id or a new point to create. */
export type Endpoint = { vertexId: string } | Vec2;

export interface AddWallResult {
  command: Command;
  wallId: string;
  vertexIds: [string, string];
}

/**
 * Ids are generated here, outside the recipe, so the caller knows them up front and the
 * recipe itself is deterministic.
 */
export function addWall(
  levelId: string,
  a: Endpoint,
  b: Endpoint,
  opts: { thickness?: number; height?: number; kind?: Wall['kind'] } = {},
): AddWallResult {
  const wallId = newId('w');
  const aId = 'vertexId' in a ? a.vertexId : newId('v');
  const bId = 'vertexId' in b ? b.vertexId : newId('v');
  if (aId === bId) throw new Error('a wall needs two distinct endpoints');

  const command: Command = {
    label: 'Add wall',
    recipe: (d) => {
      const lvl = level(d, levelId);
      for (const [id, ep] of [
        [aId, a],
        [bId, b],
      ] as const) {
        if ('vertexId' in ep) {
          if (!lvl.vertices[id]) throw new Error(`vertex ${id} not found`);
        } else {
          lvl.vertices[id] = { id, x: ep.x, y: ep.y };
        }
      }
      lvl.walls[wallId] = {
        id: wallId,
        a: aId,
        b: bId,
        thickness: opts.thickness ?? 0.1,
        height: opts.height,
        materialLeft: 'paint-white',
        materialRight: 'paint-white',
        ...(opts.kind === 'boundary' ? { kind: 'boundary' as const } : {}),
      };
    },
  };
  return { command, wallId, vertexIds: [aId, bId] };
}

export function setWallThickness(levelId: string, wallId: string, thickness: number): Command {
  if (!(thickness > 0)) throw new Error('thickness must be positive');
  return {
    label: 'Change wall thickness',
    recipe: (d) => {
      const w = level(d, levelId).walls[wallId];
      if (!w) throw new Error(`wall ${wallId} not found`);
      w.thickness = thickness;
    },
  };
}

/**
 * Deletes the wall, its openings and any vertex left unused, then re-detects rooms: two
 * rooms the wall divided merge into one (keeping the larger one's name).
 */
/** `snapshot` (optional) names the undo step after what it deletes: a wall or a boundary. */
export function deleteWall(levelId: string, wallId: string, snapshot?: Level): Command {
  const w = snapshot?.walls[wallId];
  const what = w && isBoundary(w) ? 'boundary' : 'wall';
  return {
    label: `Delete ${what}`,
    recipe: (d) => {
      const lvl = level(d, levelId);
      const wall = lvl.walls[wallId];
      if (!wall) return;
      delete lvl.walls[wallId];

      for (const op of Object.values(lvl.openings)) {
        if (op.wallId === wallId) delete lvl.openings[op.id];
      }

      const stillUsed = new Set<string>();
      for (const w of Object.values(lvl.walls)) {
        stillUsed.add(w.a);
        stillUsed.add(w.b);
      }
      for (const vid of [wall.a, wall.b]) {
        if (!stillUsed.has(vid)) delete lvl.vertices[vid];
      }
      syncRooms(lvl);
    },
  };
}

/** Deletes a corner and every wall that meets it, in one undo step. */
export function deleteVertex(levelId: string, vertexId: string): Command {
  return {
    label: 'Delete corner',
    recipe: (d) => {
      const lvl = level(d, levelId);
      for (const w of Object.values(lvl.walls)) {
        if (w.a === vertexId || w.b === vertexId) deleteWall(levelId, w.id).recipe(d);
      }
      delete lvl.vertices[vertexId];
      syncRooms(lvl);
    },
  };
}

export function addOpening(
  levelId: string,
  opening: Omit<Opening, 'id'>,
): { command: Command; openingId: string } {
  const openingId = newId('op');
  return {
    openingId,
    command: {
      label: `Add ${opening.kind}`,
      recipe: (d) => {
        const lvl = level(d, levelId);
        const wall = lvl.walls[opening.wallId];
        if (!wall) throw new Error(`wall ${opening.wallId} not found`);
        if (isBoundary(wall)) throw new Error('a room boundary has no wall to put an opening in');
        lvl.openings[openingId] = { ...opening, id: openingId };
      },
    },
  };
}

export function renameRoom(levelId: string, roomId: string, name: string): Command {
  return {
    label: 'Rename room',
    recipe: (d) => {
      const room = level(d, levelId).rooms[roomId];
      if (!room) throw new Error(`room ${roomId} not found`);
      room.name = name;
    },
  };
}

// --------------------------------------------------------------------- edits by patch

const WallPatch = Wall.pick({
  thickness: true,
  height: true,
  materialLeft: true,
  materialRight: true,
  kind: true,
}).partial();
export type WallPatch = z.input<typeof WallPatch>;

/** Updates wall properties. `height: undefined` resets to the level's ceiling height. */
export function updateWall(levelId: string, wallId: string, patch: WallPatch): Command {
  const p = WallPatch.parse(patch);
  return {
    label: 'Edit wall',
    recipe: (d) => {
      const w = level(d, levelId).walls[wallId];
      if (!w) throw new Error(`wall ${wallId} not found`);
      Object.assign(w, p);
      if ('height' in patch && patch.height === undefined) delete w.height;
      if (w.kind === 'wall') delete w.kind; // absent means a wall
      if (w.kind === 'boundary') {
        // A boundary has nothing to put a door or window in.
        const lvl = level(d, levelId);
        for (const o of Object.values(lvl.openings))
          if (o.wallId === wallId) delete lvl.openings[o.id];
      }
    },
  };
}

/**
 * Gives the wall a new centre-line length by moving its end corner (b) along the wall.
 * In "push" mode (the default) walls meeting that corner at a right angle move with it,
 * so the wall at the far end slides parallel to itself and a square plan stays square.
 * In "end" mode only the corner moves.
 */
export function setWallLength(
  levelId: string,
  wallId: string,
  newLength: number,
  mode: 'push' | 'end' = 'push',
  /** The end that moves (a vertex id of the wall); defaults to the wall's `b` end. */
  moving?: string,
): Command {
  if (!(newLength > 0)) throw new Error('length must be positive');
  return {
    label: 'Change wall length',
    recipe: (d) => {
      const lvl = level(d, levelId);
      const wall = lvl.walls[wallId];
      if (!wall) throw new Error(`wall ${wallId} not found`);
      if (moving !== undefined && moving !== wall.a && moving !== wall.b)
        throw new Error(`vertex ${moving} is not an end of wall ${wallId}`);
      // Orient the wall so `b` is the end that moves.
      const w = moving === wall.a ? { a: wall.b, b: wall.a } : { a: wall.a, b: wall.b };
      const a = lvl.vertices[w.a];
      const b = lvl.vertices[w.b];
      if (!a || !b) throw new Error(`wall ${wallId} references a missing vertex`);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-9) throw new Error('wall has zero length');
      const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
      const delta = { x: dir.x * (newLength - len), y: dir.y * (newLength - len) };

      const moved = new Set([w.b]);
      if (mode === 'push') {
        for (const other of Object.values(lvl.walls)) {
          if (other.id === wallId || (other.a !== w.b && other.b !== w.b)) continue;
          const farId = other.a === w.b ? other.b : other.a;
          const far = lvl.vertices[farId];
          if (!far || farId === w.a) continue;
          const ol = Math.hypot(far.x - b.x, far.y - b.y);
          const cos = ol > 1e-9 ? ((far.x - b.x) * dir.x + (far.y - b.y) * dir.y) / ol : 1;
          if (Math.abs(cos) < 0.05) moved.add(farId);
        }
      }
      for (const id of moved) {
        const v = lvl.vertices[id];
        if (!v) continue;
        v.x += delta.x;
        v.y += delta.y;
      }
      reclampOpenings(lvl);
    },
  };
}

const RoomPatch = Room.pick({
  name: true,
  floorMaterial: true,
  ceilingMaterial: true,
  ceilingHeight: true,
}).partial();
export type RoomPatch = z.input<typeof RoomPatch>;

export function updateRoom(levelId: string, roomId: string, patch: RoomPatch): Command {
  const p = RoomPatch.parse(patch);
  if (p.name !== undefined && p.name.trim() === '') throw new Error('room name is empty');
  return {
    label: 'Edit room',
    recipe: (d) => {
      const room = level(d, levelId).rooms[roomId];
      if (!room) throw new Error(`room ${roomId} not found`);
      Object.assign(room, p);
      if ('ceilingHeight' in patch && patch.ceilingHeight === undefined) delete room.ceilingHeight;
    },
  };
}

const OpeningPatch = Opening.omit({ id: true, wallId: true }).partial();
export type OpeningPatch = z.input<typeof OpeningPatch>;

/**
 * Updates an opening. `t` is clamped so the opening stays on its wall; a width wider
 * than the wall is rejected.
 */
export function updateOpening(levelId: string, openingId: string, patch: OpeningPatch): Command {
  const p = OpeningPatch.parse(patch);
  return {
    label: 'Edit opening',
    recipe: (d) => {
      const lvl = level(d, levelId);
      const o = lvl.openings[openingId];
      if (!o) throw new Error(`opening ${openingId} not found`);
      const wall = lvl.walls[o.wallId];
      const a = wall && lvl.vertices[wall.a];
      const b = wall && lvl.vertices[wall.b];
      if (!a || !b) throw new Error(`opening ${openingId} is on a missing wall`);
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (p.width !== undefined && p.width > length + 1e-9) {
        throw new Error(
          `an opening ${p.width} m wide does not fit on a ${length.toFixed(2)} m wall`,
        );
      }
      Object.assign(o, p);
      if ('swing' in patch && patch.swing === undefined) delete o.swing;
      if (o.kind !== 'door') delete o.swing;
      else o.swing ??= 'leftIn';
      if (o.kind !== 'window') o.sill = 0;
      o.t = clampOpeningT(length, o.width, o.t);
    },
  };
}

export function deleteOpening(levelId: string, openingId: string): Command {
  return {
    label: 'Delete opening',
    recipe: (d) => {
      delete level(d, levelId).openings[openingId];
    },
  };
}

export function setCeilingHeight(levelId: string, height: number): Command {
  if (!(height > 0)) throw new Error('height must be positive');
  return {
    label: 'Change ceiling height',
    recipe: (d) => {
      level(d, levelId).ceilingHeight = height;
    },
  };
}

// ------------------------------------------------------------------ splitting and drawing

/**
 * In a recipe: puts a new corner on a wall at the point nearest `at`. The wall keeps its
 * id from a to the new corner; a new wall (same thickness, height and materials) runs on
 * to the old b. Openings move to whichever part holds their centre, and room loops that
 * ran along the wall gain the corner.
 */
function splitWallDraft(
  lvl: Draft<Level>,
  wallId: string,
  at: Vec2,
  vertexId: string,
  newWallId: string,
): void {
  const w = lvl.walls[wallId];
  const a = w && lvl.vertices[w.a];
  const b = w && lvl.vertices[w.b];
  if (!w || !a || !b) throw new Error(`wall ${wallId} not found`);
  const t = Math.min(1 - 1e-6, Math.max(1e-6, projectOnSegment(at, a, b).t));
  lvl.vertices[vertexId] = { id: vertexId, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  splitWallAt(lvl, wallId, vertexId, newWallId);
}

export function splitWall(
  levelId: string,
  wallId: string,
  at: Vec2,
  snapshot?: Level,
): { command: Command; vertexId: string; wallId: string } {
  // Next to a corner, the corner itself is the split point: no sliver walls.
  const w = snapshot?.walls[wallId];
  const a = w && snapshot?.vertices[w.a];
  const b = w && snapshot?.vertices[w.b];
  if (w && a && b) {
    const u = projectOnSegment(at, a, b).t * Math.hypot(b.x - a.x, b.y - a.y);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const cap = endCapture(w.thickness);
    if (u < cap || len - u < cap) {
      return {
        vertexId: u < cap ? w.a : w.b,
        wallId,
        command: { label: 'Split wall', recipe: () => {} },
      };
    }
  }
  const vertexId = newId('v');
  const newWallId = newId('w');
  return {
    vertexId,
    wallId: newWallId,
    command: {
      label: 'Split wall',
      recipe: (d) => {
        const lvl = level(d, levelId);
        splitWallDraft(lvl, wallId, at, vertexId, newWallId);
        syncRooms(lvl);
      },
    },
  };
}

/** Where a drawn wall starts or ends: an existing corner, a point on a wall, or open floor. */
export type WallEnd = { vertexId: string } | { point: Vec2; wallId?: string };

export interface DrawWallResult {
  command: Command;
  /** The new walls, in order from start to end (more than one if it crossed walls). */
  wallIds: string[];
  startVertexId: string;
  endVertexId: string;
}

const EPS = 1e-6;

/**
 * A free end that lands exactly on an existing corner or wall (a typed length, say)
 * connects to it, so the new wall joins the graph instead of overlapping it.
 */
function attach(snapshot: Level, e: WallEnd): WallEnd {
  if ('vertexId' in e) return e;
  if (e.wallId) {
    const w = snapshot.walls[e.wallId];
    const a = w && snapshot.vertices[w.a];
    const b = w && snapshot.vertices[w.b];
    if (!w || !a || !b) return { point: e.point };
    const cap = endCapture(w.thickness);
    if (Math.hypot(e.point.x - a.x, e.point.y - a.y) < cap) return { vertexId: w.a };
    if (Math.hypot(e.point.x - b.x, e.point.y - b.y) < cap) return { vertexId: w.b };
    return e;
  }
  for (const v of Object.values(snapshot.vertices)) {
    if (Math.hypot(v.x - e.point.x, v.y - e.point.y) < 1e-4) return { vertexId: v.id };
  }
  for (const w of Object.values(snapshot.walls)) {
    const a = snapshot.vertices[w.a];
    const b = snapshot.vertices[w.b];
    if (!a || !b) continue;
    const pr = projectOnSegment(e.point, a, b);
    if (pr.distance < 1e-4 && pr.t > EPS && pr.t < 1 - EPS)
      return { point: pr.point, wallId: w.id };
  }
  return e;
}

/**
 * Adds one straight wall from `start` to `end`, planned against `snapshot` (the level as
 * the user sees it). Every wall it starts on, ends on or crosses is split so all walls
 * meet at shared corners; it chains through any corner it passes over; rooms are then
 * re-detected. All ids are generated here, before the recipe runs.
 */
export function drawWall(
  snapshot: Level,
  rawStart: WallEnd,
  rawEnd: WallEnd,
  opts: { thickness?: number; height?: number; kind?: Wall['kind'] } = {},
): DrawWallResult {
  const levelId = snapshot.id;
  const start = attach(snapshot, rawStart);
  const end = attach(snapshot, rawEnd);
  const posOf = (e: WallEnd): Vec2 => {
    if ('vertexId' in e) {
      const v = snapshot.vertices[e.vertexId];
      if (!v) throw new Error(`vertex ${e.vertexId} not found`);
      return { x: v.x, y: v.y };
    }
    return e.point;
  };
  const pa = posOf(start);
  const pb = posOf(end);
  const length = Math.hypot(pb.x - pa.x, pb.y - pa.y);
  if (length < 0.01) throw new Error('a wall must be at least 1 cm long');

  const touching = new Set<string>();
  for (const e of [start, end]) {
    if ('vertexId' in e) {
      for (const w of Object.values(snapshot.walls)) {
        if (w.a === e.vertexId || w.b === e.vertexId) touching.add(w.id);
      }
    } else if (e.wallId) {
      touching.add(e.wallId);
    }
  }
  const endVertices = new Set([start, end].flatMap((e) => ('vertexId' in e ? [e.vertexId] : [])));

  // Stops along the new wall, by fraction t: corners it passes and walls it crosses.
  type Stop = { t: number; vertexId: string } | { t: number; split: { wallId: string; at: Vec2 } };
  const stops: Stop[] = [];
  const addStop = (s: Stop) => {
    if (s.t <= EPS || s.t >= 1 - EPS) return;
    if (stops.some((x) => Math.abs(x.t - s.t) * length < 1e-4)) return;
    stops.push(s);
  };
  for (const v of Object.values(snapshot.vertices)) {
    if (endVertices.has(v.id)) continue;
    const pr = projectOnSegment(v, pa, pb);
    if (pr.distance < 1e-4) addStop({ t: pr.t, vertexId: v.id });
  }
  for (const w of Object.values(snapshot.walls)) {
    if (touching.has(w.id)) continue;
    const a = snapshot.vertices[w.a];
    const b = snapshot.vertices[w.b];
    if (!a || !b) continue;
    const x = segmentIntersection(pa, pb, a, b);
    if (!x) continue;
    const wallLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (x.u * wallLen < 1e-4 || (1 - x.u) * wallLen < 1e-4) continue; // at its corner: handled above
    addStop({ t: x.t, split: { wallId: w.id, at: x.point } });
  }
  stops.sort((p, q) => p.t - q.t);

  // Pre-generate every id the recipe will use.
  const endIds = (e: WallEnd) =>
    'vertexId' in e
      ? { vertexId: e.vertexId, splitWallId: undefined as string | undefined }
      : { vertexId: newId('v'), splitWallId: e.wallId ? newId('w') : undefined };
  const startIds = endIds(start);
  const endIdsResolved = endIds(end);
  const stopIds = stops.map((s) =>
    'vertexId' in s ? { vertexId: s.vertexId } : { vertexId: newId('v'), splitWallId: newId('w') },
  );
  const chain = [startIds.vertexId, ...stopIds.map((s) => s.vertexId), endIdsResolved.vertexId];
  const wallIds = chain.slice(1).map(() => newId('w'));

  const command: Command = {
    label: 'Draw wall',
    recipe: (d) => {
      const lvl = level(d, levelId);
      // Which current wall now holds a point of an original wall split earlier in this recipe.
      const family = new Map<string, string[]>();
      const holder = (wallId: string, at: Vec2): string => {
        for (const id of [wallId, ...(family.get(wallId) ?? [])]) {
          const w = lvl.walls[id];
          const a = w && lvl.vertices[w.a];
          const b = w && lvl.vertices[w.b];
          if (!a || !b) continue;
          const pr = projectOnSegment(at, a, b);
          if (pr.distance < 1e-4 && pr.t > EPS && pr.t < 1 - EPS) return id;
        }
        throw new Error(`no part of wall ${wallId} passes through the point`);
      };
      const split = (wallId: string, at: Vec2, vertexId: string, newWallId: string) => {
        splitWallDraft(lvl, holder(wallId, at), at, vertexId, newWallId);
        family.set(wallId, [...(family.get(wallId) ?? []), newWallId]);
      };
      const resolve = (e: WallEnd, ids: { vertexId: string; splitWallId?: string }) => {
        if ('vertexId' in e) {
          if (!lvl.vertices[e.vertexId]) throw new Error(`vertex ${e.vertexId} not found`);
        } else if (e.wallId && ids.splitWallId) {
          split(e.wallId, e.point, ids.vertexId, ids.splitWallId);
        } else {
          lvl.vertices[ids.vertexId] = { id: ids.vertexId, x: e.point.x, y: e.point.y };
        }
      };

      resolve(start, startIds);
      stops.forEach((s, i) => {
        const ids = stopIds[i];
        if ('split' in s && ids && 'splitWallId' in ids && ids.splitWallId) {
          split(s.split.wallId, s.split.at, ids.vertexId, ids.splitWallId);
        }
      });
      resolve(end, endIdsResolved);

      for (let i = 0; i + 1 < chain.length; i++) {
        const a = chain[i] as string;
        const b = chain[i + 1] as string;
        const id = wallIds[i] as string;
        const existing = Object.values(lvl.walls).find(
          (w) => (w.a === a && w.b === b) || (w.a === b && w.b === a),
        );
        if (a === b) continue;
        if (existing) {
          // Tracing a wall over a boundary turns the boundary into that wall.
          if (isBoundary(existing) && opts.kind !== 'boundary') {
            delete existing.kind;
            existing.thickness = opts.thickness ?? 0.1;
          }
          continue;
        }
        lvl.walls[id] = {
          id,
          a,
          b,
          thickness: opts.thickness ?? 0.1,
          height: opts.height,
          materialLeft: 'paint-white',
          materialRight: 'paint-white',
          ...(opts.kind === 'boundary' ? { kind: 'boundary' as const } : {}),
        };
        if (opts.height === undefined) delete lvl.walls[id]?.height;
      }
      syncRooms(lvl);
    },
  };
  return {
    command,
    wallIds,
    startVertexId: startIds.vertexId,
    endVertexId: endIdsResolved.vertexId,
  };
}
