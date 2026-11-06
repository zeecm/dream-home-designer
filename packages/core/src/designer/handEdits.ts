import { finish } from '../finishes';
import { furnitureKind } from '../furniture';
import { renovationDiff } from '../renovation';
import type { Item, Level } from '../schema';
import { aspectOf } from './accept';
import { WET } from './locks';
import { type Aspect, BATHROOMS, type Lock } from './schema';
import { type Space, roomIdAt, roomsBeside, spaceOfRoom, spacesOf } from './spaces';

/**
 * What the person changed by hand since a version was accepted (`accepted`, After as it was
 * then) in After as it is now: pieces moved, resized, added or removed, wall faces
 * repainted, floors changed, walls changed. Each is a lock on its space and aspect, so the
 * next iteration keeps it (and the person can unlock it).
 */
export function handEdits(accepted: Level, now: Level): Lock[] {
  const spaces = spacesOf(now);
  const out: Lock[] = [];
  const add = (space: Space | undefined, aspect: Lock['aspect'], label: string) => {
    if (space) out.push({ space: space.key, aspect, by: 'hand-edit', label });
  };
  /** A room's finishes: its space's, or the bathrooms' (they are no space, but keep them too). */
  const finishesOf = (roomId: string, label: string) => {
    const name = now.rooms[roomId]?.name ?? '';
    if (WET.test(name)) out.push({ space: BATHROOMS, aspect: 'finishes', by: 'hand-edit', label });
    else add(spaceOfRoom(spaces, roomId), 'finishes', label);
  };
  const nameOf = (it: Item) => furnitureKind(it.assetId)?.name ?? 'Piece';
  const spaceOfItem = (it: Item, level: Level) =>
    spaceOfRoom(spaces, roomIdAt(level, { x: it.position.x, y: it.position.z }));
  const same = (p: number, q: number, eps: number) => Math.abs(p - q) <= eps;

  const ids = [...new Set([...Object.keys(accepted.items), ...Object.keys(now.items)])].sort();
  for (const id of ids) {
    const was = accepted.items[id];
    const is = now.items[id];
    if (was && !is) {
      // Where it was, in the rooms of now (a removed piece's room is still there).
      add(spaceOfItem(was, now), aspectOf(was), `${nameOf(was)} (removed)`);
      continue;
    }
    if (!is) continue;
    if (!was) {
      add(spaceOfItem(is, now), aspectOf(is), `${nameOf(is)} (added)`);
      continue;
    }
    const moved =
      !same(was.position.x, is.position.x, 0.01) ||
      !same(was.position.z, is.position.z, 0.01) ||
      !same(was.position.y, is.position.y, 0.01) ||
      !same(was.rotationY, is.rotationY, 1e-3);
    const resized =
      !same(was.scale.x, is.scale.x, 1e-3) ||
      !same(was.scale.y, is.scale.y, 1e-3) ||
      !same(was.scale.z, is.scale.z, 1e-3);
    if (moved || resized) {
      add(spaceOfItem(is, now), aspectOf(is), `${nameOf(is)} (${moved ? 'moved' : 'resized'})`);
    }
  }

  for (const w of Object.values(now.walls)) {
    const was = accepted.walls[w.id];
    if (!was) continue;
    const [l, r] = roomsBeside(now, w.id);
    for (const [side, roomId] of [
      ['materialLeft', l],
      ['materialRight', r],
    ] as const) {
      if (was[side] === w[side] || !roomId) continue;
      const room = now.rooms[roomId]?.name ?? 'Room';
      finishesOf(roomId, `${room} wall (repainted)`);
    }
  }
  for (const r of Object.values(now.rooms)) {
    const was = accepted.rooms[r.id];
    if (!was || was.floorMaterial === r.floorMaterial) continue;
    const to = finish(r.floorMaterial)?.name ?? r.floorMaterial;
    finishesOf(r.id, `${r.name} floor (${to.toLowerCase()})`);
  }

  const diff = renovationDiff(accepted, now);
  if (
    diff.demolished.length ||
    diff.built.length ||
    diff.openingsAdded.length ||
    diff.openingsRemoved.length
  ) {
    out.push({ space: '*', aspect: 'walls', by: 'hand-edit', label: 'Walls and doors (changed)' });
  }
  // One lock per space, aspect and label.
  const seen = new Set<string>();
  return out.filter((l) => {
    const k = `${l.space}|${l.aspect}|${l.label}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Whether a lock is on a space whose rooms are `rooms` (by a room in common: keys can change). */
export const lockCovers = (l: Lock, rooms: readonly string[]): boolean =>
  l.space !== '*' && l.space.split('+').some((id) => rooms.includes(id));

/**
 * The aspects of the space made of `rooms` that stay as the plan has them: the person edited
 * them by hand since accepting (`hand-edit` locks), so a version keeps them, not its answer.
 */
export function heldAspects(
  locks: readonly Lock[] | undefined,
  rooms: readonly string[],
): Aspect[] {
  const out = new Set<Aspect>();
  for (const l of locks ?? []) if (l.by === 'hand-edit' && lockCovers(l, rooms)) out.add(l.aspect);
  return [...out];
}

/** Whether the bathrooms' paint and floors stay as the plan has them. */
export const bathroomsHeld = (locks: readonly Lock[] | undefined): boolean =>
  !!locks?.some((l) => l.by === 'hand-edit' && l.space === BATHROOMS && l.aspect === 'finishes');

/** Whether the walls stay as the plan has them (changed by hand since accepting). */
export const wallsHeld = (locks: readonly Lock[] | undefined): boolean =>
  !!locks?.some((l) => l.by === 'hand-edit' && l.aspect === 'walls');
