import { type Level, aliasesFor, sampleFlatProject } from '@dhd/core';
import { describe, expect, it } from 'vitest';
import { humanize } from './words';

const level = sampleFlatProject('prj_words').levels[0] as Level;
const aliases = aliasesFor(level);

describe('notes in words', () => {
  it('puts a known wall, room or door in words', () => {
    const w = Object.keys(aliases).find((a) => a.startsWith('W') && level.walls[aliases[a] ?? '']);
    const text = humanize(`Hack ${w}: a structural wall.`, aliases, level);
    expect(text).not.toMatch(/\bW\d+\b/);
    expect(text).toMatch(/^Hack (the wall between|a wall in the|an outside wall)/);
  });

  it('says a line about something not on the plan again whole, never “a wall a wall”', () => {
    expect(humanize('Hack wall W99: there’s no wall “W99”.', aliases, level)).toBe(
      'One wall change was left out: the designer named a wall that isn’t on the plan.',
    );
    expect(humanize('“sofa2”: there’s no piece “P99” in the flat.', aliases, level)).toBe(
      'One piece was left out: the designer named a piece of yours that isn’t in the flat.',
    );
  });
});
