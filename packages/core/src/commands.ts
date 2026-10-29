import type { Draft } from 'immer';
import type { Command } from './history';
import { newId } from './ids';
import type { Level, Opening, Project, Vec2 } from './schema';

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
