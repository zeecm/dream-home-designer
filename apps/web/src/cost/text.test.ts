import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TWO_LEVELS_TOTAL,
  TYPICAL_RATES,
  loadProject,
  projectEstimate,
  sampleFlatProject,
  twoLevelProject,
} from '@dhd/core';
import { describe, expect, it } from 'vitest';
import { byLevel, estimateText, fromFileText, levelsHint, range, unpricedText } from './text';

/** The two-level file the e2e suite opens: written from core's builder. */
const FILE = fileURLToPath(new URL('../../e2e/two-levels.dreamhome.json', import.meta.url));

describe('the estimate across levels, as the dialog and Copy show it', () => {
  it('the e2e file is the two-level fixture, and its total is the one the e2e checks', () => {
    // UPDATE_FIXTURES=1 pnpm --filter @dhd/web test writes it afresh (then format it).
    if (process.env.UPDATE_FIXTURES) writeFileSync(FILE, JSON.stringify(twoLevelProject()));
    const file = JSON.parse(readFileSync(FILE, 'utf8'));
    expect(file).toEqual(twoLevelProject());
    const est = projectEstimate(loadProject(file).project, TYPICAL_RATES);
    expect({ low: est.low, high: est.high }).toEqual(TWO_LEVELS_TOTAL);
    expect(range(est.low, est.high)).toBe('$5,200–8,700');
  });

  it('two levels: a hint, a note on the level from the file, rows by level that add up', () => {
    const p = twoLevelProject();
    const est = projectEstimate(p, TYPICAL_RATES);
    expect(levelsHint(est)).toBe('Covers both levels: Ground and Upper.');
    expect(fromFileText(est, p.levels[0]?.id)).toBe(
      'Upper is priced from the file. It can’t be shown or edited here yet.',
    );
    expect(unpricedText(est)).toBeNull();
    const rows = byLevel(est);
    expect(rows.map((r) => r.name)).toEqual(['Ground', 'Upper', 'Whole home (contingency)']);
    const lines = est.lines.reduce((t, l) => t + l.low, 0);
    expect(rows.reduce((t, r) => t + r.low, 0)).toBe(lines);
    // Copy: the lines in order, then the subtotals before the total.
    const text = estimateText(est, 'Maisonette');
    expect(text).toContain('Built-in wardrobe · Ground · Master bedroom · 6 ft run');
    expect(text).toContain('Built-in wardrobe · Upper · Bedroom 2 · 6 ft run');
    const by = text.indexOf('By level');
    expect(by).toBeGreaterThan(text.indexOf('Contingency (10%)'));
    expect(text.indexOf('Ground: $')).toBeGreaterThan(by);
    expect(text.indexOf('Whole home (contingency): $')).toBeLessThan(text.indexOf('Total: about'));
    // No empty part where a line has no place or quantity.
    expect(text).not.toContain(' ·  · ');
    expect(text).toMatch(/^Contingency \(10%\) · \$[\d,]+–[\d,]+$/m);
  });

  it('one level: no hint, no rows by level, Copy as before', () => {
    const p = sampleFlatProject('prj_t');
    const est = projectEstimate(p, TYPICAL_RATES);
    expect(levelsHint(est)).toBeNull();
    expect(fromFileText(est, p.levels[0]?.id)).toBeNull();
    expect(byLevel(est)).toEqual([]);
    expect(estimateText(est, 'x')).not.toContain('By level');
  });

  it('a level with no renovation plan says it isn’t priced', () => {
    const p = twoLevelProject();
    const ground = p.levels[0];
    if (!ground) throw new Error('no level');
    const est = projectEstimate(
      { ...p, renovation: { levels: [{ ...ground, id: `${ground.id}~after` }] } },
      TYPICAL_RATES,
    );
    expect(unpricedText(est)).toBe(
      'Upper has no renovation plan, so it isn’t priced. It can’t be planned here yet.',
    );
    expect(levelsHint(est)).toBeNull();
    // Ground is shown: nothing is priced from the file.
    expect(fromFileText(est, ground.id)).toBeNull();
    // Only Upper priced, and the app shows Ground: Upper comes from the file.
    const upper = p.levels[1];
    if (!upper) throw new Error('no upper');
    const onlyUpper = projectEstimate(
      { ...p, renovation: { levels: [{ ...upper, id: `${upper.id}~after` }] } },
      TYPICAL_RATES,
    );
    expect(fromFileText(onlyUpper, ground.id)).toBe(
      'Upper is priced from the file. It can’t be shown or edited here yet.',
    );
    // Still a home of two levels: the places say which.
    expect(onlyUpper.lines.find((l) => l.group === 'Painting')?.place).toMatch(/^Upper · /);
    expect(estimateText(est, 'x')).toContain('Upper has no renovation plan');
  });
});
