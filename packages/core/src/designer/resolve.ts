/**
 * Whether a walkway re-solve of a space is taken (result.ts, keepWalkwaysClear): only when it
 * is strictly better and no worse in any way. Pure, so it is tested on its own.
 */

/** A space as placed, before or after a re-solve. */
export interface ResolveSide {
  /** The space's failing hard checks (keys), with the space alone furnished. */
  keys: ReadonlySet<string>;
  /** The plan's failing walkways and clearances. */
  plan: number;
  /** Pieces left out (of any kind). */
  dropped: number;
  /** Pieces placed short of the room they need. */
  soft: number;
  /** Pieces placed breaking one of their relationships (P2). */
  broken: number;
}

/** No more pieces left out, short of room or turned from what they go with. */
export function piecesNoWorse(
  before: Pick<ResolveSide, 'dropped' | 'soft' | 'broken'>,
  after: Pick<ResolveSide, 'dropped' | 'soft' | 'broken'>,
): boolean {
  return (
    after.dropped <= before.dropped && after.soft <= before.soft && after.broken <= before.broken
  );
}

/**
 * Taken only if: no hard check fails that didn't before (a walkway fixed by adding a dining
 * "apart" failure is not better), fewer fail, the plan's walkways and clearances are no worse,
 * and the pieces are no worse (piecesNoWorse).
 */
export function acceptResolve(before: ResolveSide, after: ResolveSide): boolean {
  return (
    piecesNoWorse(before, after) &&
    [...after.keys].every((k) => before.keys.has(k)) &&
    after.keys.size < before.keys.size &&
    after.plan <= before.plan
  );
}
