import type { ClearanceIssue } from './clearance';
import { overlapDepth, sideOf, zoneOf } from './convex';
import { itemSize } from './furniture';
import type { Item, Vec2 } from './schema';

/**
 * Door clashes: two doors whose leaves hit each other when both are open, and a door that
 * hits a piece's own hinged front (a wardrobe's or the fridge's door, drawers pulled out).
 * Advice only. Spec: docs/specs/clearance-checks.md, slice 2 (C).
 */

/** More than this much overlap is a clash (less is a drawing's rounding). */
const CLASH = 0.02;

/**
 * How far a piece's hinged front reaches out when open (Neufert; carpenters' 450 mm leaf).
 * The fridge's door is as wide as the fridge, so its reach is its width.
 */
export const REACH: Record<string, number | 'width'> = {
  wardrobe: 0.45,
  'built-in-wardrobe': 0.45,
  'shoe-cabinet': 0.4,
  'built-in-shoe-cabinet': 0.4,
  fridge: 'width',
  washer: 0.45,
  'chest-of-drawers': 0.45,
  'shelf-with-drawers': 0.45,
  'kitchen-base': 0.45,
  'kitchen-sink': 0.45,
  'kitchen-hob': 0.45,
  'built-in-kitchen-base': 0.45,
};

/** The area a piece's hinged front sweeps, off its front at full width; null if it has none. */
export function frontReach(item: Item, fp: Vec2[]): Vec2[] | null {
  const r = REACH[item.assetId];
  if (r === undefined) return null;
  const depth = r === 'width' ? itemSize(item).w : r;
  return zoneOf(sideOf(fp, 'front'), depth);
}

const hits = (a: Vec2[][], b: Vec2[][]) => a.some((p) => b.some((q) => overlapDepth(p, q) > CLASH));

/**
 * Doors whose leaves meet when both are open: one issue for each door of a pair. A double
 * door's own leaves never clash (they're one door). Depends only on walls and doors.
 */
export function doorClashes(
  sweeps: readonly [string, Vec2[][]][],
): Extract<ClearanceIssue, { kind: 'doors' }>[] {
  const out: Extract<ClearanceIssue, { kind: 'doors' }>[] = [];
  for (let i = 0; i < sweeps.length; i++) {
    for (let j = i + 1; j < sweeps.length; j++) {
      const [a, sa] = sweeps[i] as [string, Vec2[][]];
      const [b, sb] = sweeps[j] as [string, Vec2[][]];
      if (!hits(sa, sb)) continue;
      out.push({ kind: 'doors', openingId: a, otherId: b, sweep: sa });
      out.push({ kind: 'doors', openingId: b, otherId: a, sweep: sb });
    }
  }
  return out;
}

/**
 * Pieces whose hinged front a door's leaves hit when both are open. A piece already standing
 * in that door's swing (slice 1's 'door' issue, in `inSwing` as "item|opening") isn't
 * reported twice.
 */
export function doorFrontIssues(
  items: readonly Item[],
  fps: ReadonlyMap<string, Vec2[]>,
  sweeps: readonly [string, Vec2[][]][],
  inSwing: ReadonlySet<string>,
): Extract<ClearanceIssue, { kind: 'door-front' }>[] {
  const out: Extract<ClearanceIssue, { kind: 'door-front' }>[] = [];
  for (const it of items) {
    const fp = fps.get(it.id);
    const reach = fp && frontReach(it, fp);
    if (!reach) continue;
    for (const [openingId, sweep] of sweeps) {
      if (inSwing.has(`${it.id}|${openingId}`)) continue;
      if (sweep.some((s) => overlapDepth(reach, s) > CLASH)) {
        out.push({ kind: 'door-front', itemId: it.id, openingId, zone: reach, sweep });
      }
    }
  }
  return out;
}
