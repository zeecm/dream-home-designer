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
  /**
   * What the brief said of a plan piece before it was kept ('bring', or 'in-place' the person
   * chose themselves): put back when it is let go, never simply deleted. Set by the reducer.
   */
  prior: z.enum(['bring', 'in-place']).nullable().optional(),
  /** When it was let go (Let the designer move it): in `keptGone` only. */
  until: z.string().optional(),
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

/**
 * The kept pieces a version made at `madeAt` is placed and checked with: those kept before it.
 * Keep this places a piece again in later designs, never in the version it was kept from (that
 * version, re-solved around a copy of its own piece, would move the original), and still kept
 * then (one let go after it was made stays in it: a version, once made, stays as it was); 'new'
 * (a design not made yet) is those kept now. Required, so no caller forgets which it is.
 */
export const keptBefore = (kept: readonly Kept[], madeAt: string | 'new'): readonly Kept[] =>
  madeAt === 'new'
    ? kept.filter((k) => !k.until)
    : kept.filter((k) => k.at < madeAt && (!k.until || k.until > madeAt));

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

/**
 * Puts the kept pieces on `level` (changed in place) and returns the ids of the pieces that
 * stand for them, which nothing clears or moves: a plan piece by its id, moved to where it was
 * kept if a version had moved it; a proposal's piece the plan already has there (its version
 * accepted); else the piece placed again. One place for the result and the room steps' prompt.
 */
export function placeKept(level: Level, kept: readonly Kept[]): Set<string> {
  const ids = new Set<string>();
  for (const k of kept) {
    if (k.itemId) {
      const own = level.items[k.itemId];
      if (!own) continue;
      if (!keptHolds(k, own)) {
        own.position.x = k.pose.x;
        own.position.z = k.pose.y;
        own.rotationY = k.pose.rot;
      }
      ids.add(own.id);
      continue;
    }
    const holder = Object.values(level.items).find((x) => keptHolds(k, x));
    if (holder) {
      ids.add(holder.id);
      continue;
    }
    const it = keptItem(k, level.ceilingHeight);
    if (!it) continue;
    level.items[it.id] = it;
    ids.add(it.id);
  }
  return ids;
}

/** `level` with the kept pieces on it (a copy), and the ids that stand for them. */
export function withKept(level: Level, kept: readonly Kept[]): { level: Level; ids: Set<string> } {
  if (!kept.length) return { level, ids: new Set() };
  const copy = structuredClone(level);
  return { level: copy, ids: placeKept(copy, kept) };
}
