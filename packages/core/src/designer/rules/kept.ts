import { z } from 'zod';
import { furnitureKind, newItem } from '../../furniture';
import type { Item, Level } from '../../schema';
import { nameOf } from '../place';

/**
 * Kept pieces (slice 3a, Keep this): a piece the household wants left where it is. A plan
 * piece is kept by its id (the brief keeps it in place); a piece only in a proposal is kept by
 * its kind and pose, and later designs place it there again. Either is checked like a rule
 * (principle K) but listed apart, and never counts as one of "your N rules".
 */

/** Kept pieces a home keeps at most (tech §2.5). */
export const MAX_KEPT = 30;
/** How near a kept piece must stand to where it was kept. */
export const KEPT_GAP = 0.05;
export const KEPT_ANGLE = (3 * Math.PI) / 180;

export const Kept = z.object({
  id: z.string(),
  /** A plan piece's id; null for a piece only in a proposal (kept by kind and pose). */
  itemId: z.string().nullable(),
  assetId: z.string(),
  /** Where it is: plan x, y (metres) and its turn (radians). */
  pose: z.object({ x: z.number(), y: z.number(), rot: z.number() }),
  /** Its size as kept (scale), so it is placed again the same. */
  scale: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
  /** "plan", or the version it was kept from ("V4"). */
  from: z.string().max(12),
  levelId: z.string(),
  at: z.string(),
});
export type Kept = z.infer<typeof Kept>;

const turnDiff = (a: number, b: number) => {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return Math.min(d, 2 * Math.PI - d);
};

/** Whether an item stands where a kept piece was kept. */
export const keptHolds = (k: Kept, it: Item) =>
  it.assetId === k.assetId &&
  Math.hypot(it.position.x - k.pose.x, it.position.z - k.pose.y) <= KEPT_GAP + 1e-6 &&
  turnDiff(it.rotationY, k.pose.rot) <= KEPT_ANGLE + 1e-6;

/** A kept piece in words ("the 3-seat sofa"). */
export const keptName = (k: Kept) => {
  const kind = furnitureKind(k.assetId);
  return `the ${kind ? nameOf(kind) : 'piece'}`;
};

export interface KeptCheck {
  key: string;
  principle: 'K';
  hard: true;
  waivable: true;
  text: string;
  itemId?: string;
}

/**
 * The kept pieces a level doesn't hold: a plan piece moved or gone, a proposal's piece not
 * placed where it was kept. Hard and waivable, as a rule is.
 */
export function keptChecks(kept: readonly Kept[], level: Level): KeptCheck[] {
  const items = Object.values(level.items);
  return kept.flatMap((k) => {
    const held = k.itemId
      ? !!level.items[k.itemId] && keptHolds(k, level.items[k.itemId] as Item)
      : items.some((it) => keptHolds(k, it));
    if (held) return [];
    const near = k.itemId ? level.items[k.itemId] : undefined;
    return [
      {
        key: `K|${k.id}`,
        principle: 'K' as const,
        hard: true as const,
        waivable: true as const,
        text: `You kept ${keptName(k)} where it is${k.from === 'plan' ? '' : ` in ${k.from}`}.`,
        ...(near ? { itemId: near.id } : {}),
      },
    ];
  });
}

/** A proposal's kept piece as an item placed again in a later design (stays where it is). */
export function keptItem(k: Kept, ceiling: number): Item | null {
  const kind = furnitureKind(k.assetId);
  if (!kind) return null;
  const it = newItem(`kept_${k.id}`, kind, { x: k.pose.x, y: k.pose.y }, k.pose.rot, ceiling);
  return k.scale ? { ...it, scale: { ...k.scale } } : it;
}
