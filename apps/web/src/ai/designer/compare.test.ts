import type { Design, DesignProblem } from '@dhd/core';
import { describe, expect, it } from 'vitest';
import { defaultPicks, ordered, problemsInOrder, togglePick } from './compare';

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

  it('problems worst first, then by room, then by text, whatever order they came in', () => {
    const p = (kind: DesignProblem['kind'], text: string, zone = false) =>
      ({ kind, text, ...(zone ? { issue: { kind: 'zone' } } : {}) }) as DesignProblem;
    const list = [
      p('budget', 'About S$9,000 over'),
      p('clearance', 'Wardrobe doors need 0.60 m', true),
      p('window', 'Bedroom has no window'),
      p('clearance', 'B: the sofa overlaps the table'),
      p('clearance', 'A: a door hits the shoe cabinet'),
      p('structural', 'A change touches a structural wall'),
    ];
    const room = (x: DesignProblem) => x.text.slice(0, 1);
    const once = problemsInOrder(list, room).map((x) => x.text);
    expect(once).toEqual([
      'A change touches a structural wall',
      'A: a door hits the shoe cabinet',
      'B: the sofa overlaps the table',
      'Bedroom has no window',
      'Wardrobe doors need 0.60 m',
      'About S$9,000 over',
    ]);
    expect(problemsInOrder([...list].reverse(), room).map((x) => x.text)).toEqual(once);
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
