import { describe, expect, it } from 'vitest';
import { dropSmall, mergeStops, tieredChains } from './chains';

const at = (...vs: number[]) => vs.map((v) => ({ v, from: 0 }));
const vs = (stops: { v: number }[]) => stops.map((s) => s.v);

describe('chains', () => {
  it('merges stops within 5 mm, the primary ones winning', () => {
    expect(vs(mergeStops(at(0, 1, 2), at(1.003, 1.5)))).toEqual([0, 1, 1.5, 2]);
  });

  it('joins a piece under 20 mm to its neighbour, keeping the ends and fixed stops', () => {
    expect(vs(dropSmall(at(0, 1, 1.01, 2)))).toEqual([0, 1, 2]);
    expect(vs(dropSmall(at(0, 1, 1.01, 2), (s) => s.v === 1.01))).toEqual([0, 1.01, 2]);
    expect(vs(dropSmall(at(0, 1, 1.01, 2), (s) => s.v === 1))).toEqual([0, 1, 2]);
    expect(vs(dropSmall(at(0, 0.01)))).toEqual([0, 0.01]);
  });

  it('builds tiers, dropping one the same as the next', () => {
    const t = tieredChains(at(0, 1.5, 2.4, 3.9), at(0.5, 3));
    expect(t.map((c) => c.tier)).toEqual([0, 1, 2]);
    expect(vs(t[0]?.stops ?? [])).toEqual([0, 0.5, 1.5, 2.4, 3, 3.9]);
    expect(vs(t[2]?.stops ?? [])).toEqual([0, 3.9]);
    // No openings: tier 1 is the overall, and only tier 2 is left.
    expect(tieredChains(at(0, 3.9), []).map((c) => c.tier)).toEqual([2]);
    // Fine stops that are all on tier 1's: no tier 0.
    expect(tieredChains(at(0, 1, 3.9), at(1.002)).map((c) => c.tier)).toEqual([1, 2]);
  });
});
