/**
 * One-dimensional dimension chains, shared by the plan's outside chains and a wall seen straight
 * on: stops along a line (each with where its face is across the line, for an extension line),
 * merged, small pieces joined to their neighbours, and assembled into tiers.
 */

/** Stops closer than this are one. */
export const MERGE = 0.005;
/** A piece of a chain shorter than this is no figure of its own: it joins its neighbour. */
export const MIN_PIECE = 0.02;

/** A stop along a line, and where its face is across the line (NaN: no extension line). */
export interface Stop {
  v: number;
  from: number;
}

/**
 * Sorted, with stops within MERGE of one already kept dropped (the primary ones win); of two
 * that merge, the one whose face is further out (`out` +1 or -1 across the side) gives the
 * extension line, so it is the shorter.
 */
export function mergeStops(primary: Stop[], extra: Stop[] = [], out = 1): Stop[] {
  const kept: Stop[] = [];
  const add = (s: Stop) => {
    const k = kept.find((q) => Math.abs(q.v - s.v) < MERGE);
    if (!k) kept.push({ ...s });
    else if (!Number.isNaN(s.from) && (Number.isNaN(k.from) || s.from * out > k.from * out)) {
      k.from = s.from;
    }
  };
  for (const s of [...primary].sort((a, b) => a.v - b.v)) add(s);
  for (const s of [...extra].sort((a, b) => a.v - b.v)) add(s);
  return kept.sort((a, b) => a.v - b.v);
}

/**
 * The stops with each piece under MIN_PIECE joined to its neighbour, so the chain still adds
 * up: of the two stops either side of a small piece, an inner one that isn't `fixed` (a stop
 * of the tier outside it) goes. The ends always stay.
 */
export function dropSmall(stops: Stop[], fixed: (s: Stop) => boolean = () => false): Stop[] {
  const out = [...stops];
  let i = 1;
  while (out.length > 2 && i < out.length) {
    const piece = (out[i] as Stop).v - (out[i - 1] as Stop).v;
    if (piece >= MIN_PIECE - 1e-9) {
      i++;
      continue;
    }
    if (i < out.length - 1 && !fixed(out[i] as Stop)) out.splice(i, 1);
    else if (i - 1 > 0 && !fixed(out[i - 1] as Stop)) out.splice(i - 1, 1);
    else i++;
  }
  return out;
}

/** Whether two chains have the same stops (within MERGE). */
export const sameStops = (a: Stop[], b: Stop[]) =>
  a.length === b.length && a.every((s, i) => Math.abs(s.v - (b[i] as Stop).v) < MERGE);

/** A chain's tier: 0 the finest, 2 the overall. */
export type Tier = 0 | 1 | 2;

/**
 * Three tiers from a middle tier's stops and the finer stops between them: tier 1 is `middle`
 * merged and with small pieces joined; tier 0 adds `fine`, keeping tier 1's stops; tier 2 is
 * tier 1's ends. A tier the same as the next one out is left out, so the result runs finest
 * first and always ends with tier 2.
 */
export function tieredChains(
  middle: Stop[],
  fine: Stop[],
  out = 1,
): { tier: Tier; stops: Stop[] }[] {
  const tier1 = dropSmall(mergeStops(middle, [], out));
  const isFixed = (x: Stop) => tier1.some((c) => Math.abs(c.v - x.v) < MERGE);
  const tier0 = dropSmall(mergeStops(tier1, fine, out), isFixed);
  const tier2 = [tier1[0] as Stop, tier1[tier1.length - 1] as Stop];
  const list: { tier: Tier; stops: Stop[] }[] = [];
  if (!sameStops(tier0, tier1)) list.push({ tier: 0, stops: tier0 });
  if (!sameStops(tier1, tier2)) list.push({ tier: 1, stops: tier1 });
  list.push({ tier: 2, stops: tier2 });
  return list;
}
