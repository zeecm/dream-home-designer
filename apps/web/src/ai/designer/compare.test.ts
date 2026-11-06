import type { Design } from '@dhd/core';
import { describe, expect, it } from 'vitest';
import { defaultPicks, ordered, togglePick } from './compare';

const v = (id: string, n: number) => ({ id, n }) as Design;
const designs = [v('c', 3), v('a', 1), v('b', 2)];

describe('Compare: which versions sit beside Before', () => {
  it('starts with the selected version and the one before it', () => {
    expect(ordered(designs, defaultPicks(designs, 'c'))).toEqual(['b', 'c']);
    expect(ordered(designs, defaultPicks(designs, 'b'))).toEqual(['a', 'b']);
    // V1 has none before it: the one after.
    expect(ordered(designs, defaultPicks(designs, 'a'))).toEqual(['a', 'b']);
    // One version: Before and it.
    expect(defaultPicks([v('a', 1)], 'a')).toEqual(['a']);
    expect(defaultPicks([], null)).toEqual([]);
  });

  it('a third tick replaces the one ticked longest ago; the last one stays', () => {
    const picks = defaultPicks(designs, 'c'); // b, then c (selected)
    expect(togglePick(picks, 'a')).toEqual(['c', 'a']);
    expect(togglePick(picks, 'b')).toEqual(['c']);
    expect(togglePick(['c'], 'c')).toEqual(['c']);
    // Shown oldest first, whatever the order ticked; deleted versions drop out.
    expect(ordered(designs, ['c', 'a'])).toEqual(['a', 'c']);
    expect(ordered([v('a', 1)], ['c', 'a'])).toEqual(['a']);
  });
});
