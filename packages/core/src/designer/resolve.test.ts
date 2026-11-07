import { describe, expect, it } from 'vitest';
import { type ResolveSide, acceptResolve, piecesNoWorse } from './resolve';

/** A space as placed: its failing hard check keys, the plan's count, and its pieces. */
const side = (keys: string[], plan: number, patch: Partial<ResolveSide> = {}): ResolveSide => ({
  keys: new Set(keys),
  plan,
  dropped: 0,
  soft: 0,
  broken: 0,
  ...patch,
});

const WALK = 'P3|walkway|it_arm1|circulation';
const WALK2 = 'P3|walkway|it_chair2|circulation';
const FACES = 'P2|faces|it_sofa1';
const APART = 'P2|apart|it_dine1';

describe('acceptResolve: a walkway re-solve is taken only when strictly better', () => {
  it('rejects a new hard check even though the total falls (walkway fixed, dining "apart" added)', () => {
    // The tech-lead's case: two walkway failures fixed, the dining table now 0.48 m from the
    // armchair. The plan's walkways and clearances fell from 3 to 1: the old rule took it.
    const before = side([WALK, WALK2, FACES], 3);
    const after = side([FACES, APART], 1);
    expect(acceptResolve(before, after)).toBe(false);
  });

  it('rejects when as many fail as before', () => {
    expect(acceptResolve(side([WALK, FACES], 2), side([WALK, FACES], 1))).toBe(false);
    expect(acceptResolve(side([], 1), side([], 0))).toBe(false);
  });

  it('rejects a piece more left out, short of room or turned from what it goes with', () => {
    const before = side([WALK, FACES], 2);
    const better = side([FACES], 1);
    expect(acceptResolve(before, { ...better, dropped: 1 })).toBe(false);
    expect(acceptResolve(before, { ...better, soft: 1 })).toBe(false);
    expect(acceptResolve(before, { ...better, broken: 1 })).toBe(false);
    expect(piecesNoWorse(before, { ...better, broken: 1 })).toBe(false);
  });

  it('rejects when the plan’s walkways and clearances get worse elsewhere', () => {
    expect(acceptResolve(side([WALK, FACES], 2), side([FACES], 3))).toBe(false);
  });

  it('accepts strictly better with no new key', () => {
    expect(acceptResolve(side([WALK, WALK2, FACES], 3), side([FACES], 1))).toBe(true);
    // Pieces as before (one already left out stays out) are no worse.
    expect(
      acceptResolve(side([WALK, FACES], 2, { dropped: 1 }), side([FACES], 2, { dropped: 1 })),
    ).toBe(true);
  });
});
