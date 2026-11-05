import { current, produce } from 'immer';
import { z } from 'zod';
import {
  addOpening,
  deleteOpening,
  deleteWall,
  drawWall,
  renameRoom,
  updateWall,
} from './commands';
import { pointInPolygon } from './geometry';
import type { Command } from './history';
import { AFTER_SUFFIX, draftLevel } from './levels';
import { roomArea, roomShapes } from './rooms';
import { type Level, type Opening, type Project, type Vec2, isBoundary } from './schema';
import { applyLevel } from './topology';

/**
 * Suggested layouts: an AI model proposes changes to the flat as it is, as operations on its
 * walls, doors and rooms (by id); they're applied with the app's own commands to a copy, so
 * the renovation's change list and the 3D compare work on them unchanged. What a renovation
 * may not touch (outside walls, the household shelter, bathrooms' walls) is locked here,
 * whatever the model says.
 */
const Pt = z.object({ x: z.number(), y: z.number() });
export const LayoutOp = z.object({
  op: z.enum([
    'remove_wall',
    'add_wall',
    'half_wall',
    'glass_wall',
    'add_door',
    'remove_opening',
    'rename_room',
  ]),
  wallId: z.string().nullable(),
  openingId: z.string().nullable(),
  a: Pt.nullable(),
  b: Pt.nullable(),
  height: z.number().nullable(),
  t: z.number().nullable(),
  width: z.number().nullable(),
  style: z.enum(['swing', 'double', 'sliding', 'pocket', 'bifold', 'folding']).nullable(),
  at: Pt.nullable(),
  name: z.string().nullable(),
});
export type LayoutOp = z.infer<typeof LayoutOp>;

export const LayoutSuggestions = z.object({
  options: z.array(
    z.object({
      name: z.string(),
      summary: z.string(),
      reasons: z.array(z.string()),
      operations: z.array(LayoutOp),
    }),
  ),
});
export type LayoutSuggestions = z.infer<typeof LayoutSuggestions>;

/** Rooms whose walls a renovation keeps: the household shelter and wet rooms. */
const KEPT_ROOM = /shelter|bath|wc|toilet|shower/i;

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

/**
 * Walls a renovation can't take down or change: outside walls (one side outside), and the
 * walls of the household shelter and of bathrooms (wet areas stay where they are).
 */
export function lockedWalls(level: Level): Set<string> {
  const out = new Set<string>();
  for (const w of Object.values(level.walls)) {
    if (isBoundary(w)) continue;
    const sides = sidesOf(level, w.id);
    if (sides.some((s) => s === null) || sides.some((s) => s && KEPT_ROOM.test(s))) out.add(w.id);
    // A wall with a window in it is an outside wall, whatever is on the other side.
    if (Object.values(level.openings).some((o) => o.wallId === w.id && o.kind === 'window')) {
      out.add(w.id);
    }
  }
  return out;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** The flat as the model sees it: walls (and what's either side), openings, rooms, by id. */
export function planForModel(level: Level) {
  const locked = lockedWalls(level);
  const shapes = roomShapes(level);
  return {
    units: 'metres; x to the right, y down the plan',
    ceilingHeight: level.ceilingHeight,
    walls: Object.values(level.walls)
      .filter((w) => !isBoundary(w))
      .flatMap((w) => {
        const a = level.vertices[w.a];
        const b = level.vertices[w.b];
        if (!a || !b) return [];
        return [
          {
            id: w.id,
            a: { x: r2(a.x), y: r2(a.y) },
            b: { x: r2(b.x), y: r2(b.y) },
            thickness: w.thickness,
            between: sidesOf(level, w.id).map((s) => s ?? 'outside'),
            locked: locked.has(w.id),
            ...(w.height !== undefined ? { height: w.height } : {}),
            ...(w.build === 'glass' ? { glass: true } : {}),
          },
        ];
      }),
    openings: Object.values(level.openings).map((o) => ({
      id: o.id,
      kind: o.kind,
      wallId: o.wallId,
      t: r2(o.t),
      width: o.width,
      ...(o.style ? { style: o.style } : {}),
    })),
    rooms: Object.values(level.rooms).map((r) => {
      const s = shapes.get(r.id);
      const c = s
        ? s.outer.reduce(
            (p, q) => ({ x: p.x + q.x / s.outer.length, y: p.y + q.y / s.outer.length }),
            {
              x: 0,
              y: 0,
            },
          )
        : { x: 0, y: 0 };
      return { name: r.name, centre: { x: r2(c.x), y: r2(c.y) }, area: r2(roomArea(level, r)) };
    }),
  };
}

/**
 * A suggested layout applied to a copy of `before`, op by op with the app's own commands.
 * Ops on locked walls, on things that aren't there, or that the commands refuse are left
 * out and listed in `refused` (in words), so a person sees what the model wanted.
 */
export function applyLayout(before: Level, ops: LayoutOp[]): { level: Level; refused: string[] } {
  const locked = lockedWalls(before);
  let lvl: Level = before;
  const refused: string[] = [];
  const apply = (cmd: Command) => {
    const doc = { levels: [lvl] } as unknown as Project;
    lvl = produce(doc, (d) => cmd.recipe(d))?.levels[0] ?? lvl;
  };
  const id = before.id;
  for (const o of ops) {
    try {
      const wall = o.wallId ? lvl.walls[o.wallId] : undefined;
      if (o.op === 'remove_wall' || o.op === 'half_wall' || o.op === 'glass_wall') {
        if (!wall || !o.wallId) throw new Error('no such wall');
        if (locked.has(o.wallId)) throw new Error('an outside, shelter or bathroom wall');
        if (o.op === 'remove_wall') apply(deleteWall(id, o.wallId, lvl));
        else if (o.op === 'glass_wall') {
          apply(
            updateWall(id, o.wallId, { build: 'glass', thickness: Math.min(wall.thickness, 0.08) }),
          );
        } else {
          const h = Math.min(lvl.ceilingHeight - 0.1, Math.max(0.6, o.height ?? 1));
          apply(updateWall(id, o.wallId, { height: h }));
        }
      } else if (o.op === 'add_wall') {
        if (!o.a || !o.b) throw new Error('no ends');
        apply(drawWall(lvl, { point: o.a }, { point: o.b }, { thickness: 0.1 }).command);
      } else if (o.op === 'add_door') {
        if (!wall || !o.wallId) throw new Error('no such wall');
        const sides = sidesOf(lvl, o.wallId);
        if (sides.some((s) => s === null)) throw new Error('an outside wall');
        const a = lvl.vertices[wall.a];
        const b = lvl.vertices[wall.b];
        const len = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
        const width = Math.min(Math.max(o.width ?? 0.9, 0.6), len - 0.1);
        if (width < 0.6) throw new Error('the wall is too short for a door');
        const half = width / 2 / len;
        const opening: Omit<Opening, 'id'> = {
          wallId: o.wallId,
          kind: 'door',
          t: Math.min(1 - half, Math.max(half, o.t ?? 0.5)),
          width,
          height: 2.1,
          sill: 0,
          swing: 'leftIn',
          ...(o.style && o.style !== 'swing' ? { style: o.style } : {}),
        };
        apply(addOpening(id, opening).command);
      } else if (o.op === 'remove_opening') {
        const op = o.openingId ? lvl.openings[o.openingId] : undefined;
        if (!op || !o.openingId) throw new Error('no such opening');
        if (op.kind === 'window' || locked.has(op.wallId)) {
          throw new Error('a window, or an opening in an outside, shelter or bathroom wall');
        }
        apply(deleteOpening(id, o.openingId));
      } else if (o.op === 'rename_room') {
        if (!o.at || !o.name) throw new Error('no place or name');
        const shapes = roomShapes(lvl);
        const at = o.at;
        const room = Object.values(lvl.rooms).find((r) => {
          const s = shapes.get(r.id);
          return s && pointInPolygon(at, s.outer);
        });
        if (!room) throw new Error('no room there');
        apply(renameRoom(id, room.id, o.name.trim()));
      }
    } catch (e) {
      // In words: the wall by the rooms either side of it, not its id.
      const sides = o.wallId ? sidesOf(before, o.wallId) : [];
      const where = sides.length
        ? ` between ${sides.map((x) => x ?? 'outside').join(' and ')}`
        : '';
      refused.push(`${o.op.replace('_', ' ')}${where}: ${(e as Error).message}`);
    }
  }
  return { level: lvl, refused };
}

/**
 * Makes a suggested layout the renovation (starting one if there is none): one undo step.
 * `layout` is the flat as it is, with the layout applied (`applyLayout`).
 */
export function adoptLayout(levelId: string, layout: Level): Command {
  return {
    label: 'Use a suggested layout',
    recipe: (d) => {
      if (!d.renovation) {
        const levels = d.levels.map((l) => ({
          ...structuredClone(current(l)),
          id: `${l.id}${AFTER_SUFFIX}`,
        }));
        d.renovation = { levels };
      }
      applyLevel(draftLevel(d, `${levelId}${AFTER_SUFFIX}`), layout);
    },
  };
}
