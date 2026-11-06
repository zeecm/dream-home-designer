import { type Level, isBoundary } from '../schema';
import { SHELTER_ROOM, sidesOf, wallStatus } from '../structural';

/**
 * What the designer may not change, and why. HDB never allows the household shelter's
 * walls to change; outside walls (and any wall with a window) and bathrooms' walls (wet
 * areas) stay; structural walls (marked, or probably so by their thickness) only when the
 * brief asks for structural changes, and then each change is flagged. Windows and the main
 * door stay, and so do the kitchen's sink and hob (see placement). This is `lockedWalls`,
 * split by reason.
 */
export type WallLock = 'shelter' | 'outside' | 'wet' | 'structural' | 'likely';

/** Rooms whose walls are wet-area walls. */
export const WET = /bath|\bwc\b|toilet|shower/i;

/** The lock on each wall of `level` that has one, as `lockedWalls` finds them, with the reason. */
export function wallLocks(level: Level): Map<string, WallLock> {
  const out = new Map<string, WallLock>();
  const windows = new Set(
    Object.values(level.openings)
      .filter((o) => o.kind === 'window')
      .map((o) => o.wallId),
  );
  for (const w of Object.values(level.walls)) {
    if (isBoundary(w)) continue;
    const status = wallStatus(level, w.id);
    const sides = sidesOf(level, w.id);
    if (status === 'shelter' || sides.some((s) => s && SHELTER_ROOM.test(s))) {
      out.set(w.id, 'shelter');
    } else if (sides.some((s) => s === null) || windows.has(w.id)) out.set(w.id, 'outside');
    else if (sides.some((s) => s && WET.test(s))) out.set(w.id, 'wet');
    else if (status === 'structural' || status === 'likely') out.set(w.id, status);
  }
  return out;
}

/**
 * The locks a design works with: the flat as it is (`before`) decides structure, and both it
 * and the level being designed on (`base`, a renovation perhaps) decide the rest, so a wall
 * the renovation already put up beside the shelter is still the shelter's.
 */
export function designLocks(before: Level, base: Level): Map<string, WallLock> {
  const out = new Map(wallLocks(base));
  const order: WallLock[] = ['shelter', 'outside', 'wet', 'structural', 'likely'];
  for (const [id, lock] of wallLocks(before)) {
    if (!base.walls[id]) continue;
    const cur = out.get(id);
    if (!cur || order.indexOf(lock) < order.indexOf(cur)) out.set(id, lock);
  }
  return out;
}
