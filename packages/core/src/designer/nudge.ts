import type { ClearanceIssue } from '../clearance';
import { overlapDepth, polygonGap } from '../convex';
import { itemFootprint } from '../furniture';
import type { Item, Level, Vec2 } from '../schema';
import { BED_ACCESS, type DesignCheck } from './checks';
import { ACCESS } from './principles';

/**
 * Near misses, mended before they are shown: a hard check a version fails by a few
 * centimetres (a walkway at 0.89 m of 0.90 m, a fridge door at 0.89 m) is mended by moving
 * one of its pieces a little, as a designer would on site, rather than sent back to the model
 * as a failure. The solver places to the checks' own limits, and the checks measure the ways
 * on a raster round the pieces as they end up, so a centimetre can be lost between the two.
 */

/** A failure short by at most this much is a near miss. */
export const NEAR_MISS = 0.06;
/** How much more than the shortfall a piece is moved by: placed for 0.92 m where 0.90 m is needed. */
const MARGINS = [0.02, 0.04] as const;
/** Near misses mended in one result, at most (each costs a few checks of the level). */
const MAX_MENDS = 6;

export interface Nudge {
  itemId: string;
  /** How far it was moved (metres). */
  by: number;
  /** The check it mended. */
  key: string;
}

interface Move {
  id: string;
  d: Vec2;
}

const norm = (v: Vec2): Vec2 | null => {
  const l = Math.hypot(v.x, v.y);
  return l > 1e-9 ? { x: v.x / l, y: v.y / l } : null;
};

/**
 * How short a near miss is, against what the hard check needs (0.50 m to a bed side, not the
 * 0.60 m advised), if it is a walkway or the room to use a piece.
 */
export function shortOf(i: ClearanceIssue | undefined, level: Level): number | null {
  if (!i || (i.kind !== 'zone' && i.kind !== 'walkway')) return null;
  const it = level.items[i.itemId];
  const need =
    i.kind === 'walkway'
      ? i.route === 'bed'
        ? Math.min(i.need, BED_ACCESS)
        : i.need
      : ((it && ACCESS[it.assetId]?.hard) ?? i.need);
  const short = need - i.have;
  return short > 0 && short <= NEAR_MISS ? short : null;
}

/** The small moves that could mend an issue, best guess first. */
function movesFor(
  level: Level,
  issue: ClearanceIssue,
  short: number,
  movable: ReadonlySet<string>,
): Move[] {
  const out: Move[] = [];
  const by = (u: Vec2, id: string) => {
    for (const m of MARGINS) out.push({ id, d: { x: u.x * (short + m), y: u.y * (short + m) } });
  };
  if (issue.kind === 'walkway') {
    // The piece narrowing the way, away from the other side of its narrowest point.
    const it = level.items[issue.itemId];
    if (!it || !movable.has(it.id)) return out;
    const fp = itemFootprint(it);
    const [p, q] = issue.pinch;
    const dp = polygonGap([p, p, p], fp).d;
    const dq = polygonGap([q, q, q], fp).d;
    const [mine, other] = dp <= dq ? [p, q] : [q, p];
    const u = norm({ x: mine.x - other.x, y: mine.y - other.y });
    if (u) by(u, it.id);
    return out;
  }
  if (issue.kind === 'zone') {
    // Room off a side of a piece: what stands in that room moves out of it, or the piece
    // moves back from it.
    const [a, , , d] = issue.zone as [Vec2, Vec2, Vec2, Vec2];
    const n = norm({ x: d.x - a.x, y: d.y - a.y });
    if (!n) return out;
    for (const it of Object.values(level.items).sort((x, y) => (x.id < y.id ? -1 : 1))) {
      if (it.id === issue.itemId || !movable.has(it.id)) continue;
      if (overlapDepth(itemFootprint(it), issue.zone) > 0) by(n, it.id);
    }
    if (movable.has(issue.itemId)) by({ x: -n.x, y: -n.y }, issue.itemId);
  }
  return out;
}

/**
 * Moves the version's pieces (`movable`) a few cm where that mends a near miss: a move is kept
 * only if fewer hard checks fail after it and none fails that didn't. Mutates `level`.
 * `hard`: the level's failing hard checks.
 */
export function nudgeNearMisses(
  level: Level,
  movable: ReadonlySet<string>,
  hard: (l: Level) => DesignCheck[],
): Nudge[] {
  const done: Nudge[] = [];
  let checks = hard(level);
  /** Near misses no move mended: not tried again. */
  const stuck = new Set<string>();
  while (done.length < MAX_MENDS) {
    const keys = new Set(checks.map((c) => c.key));
    let mended = false;
    for (const c of checks) {
      const short = shortOf(c.issue, level);
      if (short === null || !c.issue || stuck.has(c.key)) continue;
      for (const m of movesFor(level, c.issue, short, movable)) {
        // The piece alone; then, if that leaves what goes with it failing (a coffee table no
        // longer in reach of the sofa), it and those pieces together.
        let ids = [m.id];
        for (let tries = 0; tries < 2 && !mended; tries++) {
          const was = ids.map((id) => level.items[id] as Item);
          for (const it of was) {
            level.items[it.id] = {
              ...it,
              position: { ...it.position, x: it.position.x + m.d.x, z: it.position.z + m.d.y },
            };
          }
          const now = hard(level);
          const nowKeys = new Set(now.map((x) => x.key));
          if (nowKeys.size < keys.size && [...nowKeys].every((k) => keys.has(k))) {
            for (const id of ids)
              done.push({ itemId: id, by: Math.hypot(m.d.x, m.d.y), key: c.key });
            checks = now;
            mended = true;
            break;
          }
          for (const it of was) level.items[it.id] = it;
          const along = now.flatMap((x) =>
            !keys.has(x.key) && x.itemId && movable.has(x.itemId) && !ids.includes(x.itemId)
              ? [x.itemId]
              : [],
          );
          if (!along.length) break;
          ids = [...ids, ...new Set(along)];
        }
        if (mended) break;
      }
      if (mended) break;
      stuck.add(c.key);
    }
    if (!mended) break;
  }
  return done;
}
