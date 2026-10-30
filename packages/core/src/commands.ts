import type { Draft } from 'immer';
import type { z } from 'zod';
import { clampOpeningT } from './geometry';
import type { Command } from './history';
import { newId } from './ids';
import { type Level, Opening, type Project, Room, type Vec2, Wall } from './schema';

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
      const v = level(d, levelId).vertices[vertexId];
      if (!v) throw new Error(`vertex ${vertexId} not found`);
      v.x = to.x;
      v.y = to.y;
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
  opts: { thickness?: number; height?: number } = {},
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

/** Deletes the wall, its openings, any vertex left unused, and rooms that lose a corner. */
export function deleteWall(levelId: string, wallId: string): Command {
  return {
    label: 'Delete wall',
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
        if (stillUsed.has(vid)) continue;
        delete lvl.vertices[vid];
        for (const room of Object.values(lvl.rooms)) {
          if (room.loop.includes(vid)) delete lvl.rooms[room.id];
        }
      }
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
      if (lvl.vertices[vertexId]) {
        delete lvl.vertices[vertexId];
        for (const room of Object.values(lvl.rooms)) {
          if (room.loop.includes(vertexId)) delete lvl.rooms[room.id];
        }
      }
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
        if (!lvl.walls[opening.wallId]) throw new Error(`wall ${opening.wallId} not found`);
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
    },
  };
}

/** Moves vertex b along the wall so the wall has the given centre-line length. */
export function setWallLength(levelId: string, wallId: string, newLength: number): Command {
  if (!(newLength > 0)) throw new Error('length must be positive');
  return {
    label: 'Change wall length',
    recipe: (d) => {
      const lvl = level(d, levelId);
      const w = lvl.walls[wallId];
      if (!w) throw new Error(`wall ${wallId} not found`);
      const a = lvl.vertices[w.a];
      const b = lvl.vertices[w.b];
      if (!a || !b) throw new Error(`wall ${wallId} references a missing vertex`);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-9) throw new Error('wall has zero length');
      b.x = a.x + ((b.x - a.x) / len) * newLength;
      b.y = a.y + ((b.y - a.y) / len) * newLength;
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
      Object.assign(o, p);
      if ('swing' in patch && patch.swing === undefined) delete o.swing;
      if (o.kind !== 'door') delete o.swing;
      else o.swing ??= 'leftIn';
      if (o.kind !== 'window') o.sill = 0;
      o.t = clampOpeningT(Math.hypot(b.x - a.x, b.y - a.y), o.width, o.t);
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
