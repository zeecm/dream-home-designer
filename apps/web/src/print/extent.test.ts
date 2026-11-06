import {
  AFTER_SUFFIX,
  type EditorDoc,
  type Level,
  deleteWall,
  dispatch,
  emptyHistory,
  outlineBounds,
  planExtent,
  planGeometry,
  sampleFlatProject,
  startRenovation,
} from '@dhd/core';
import { describe, expect, it } from 'vitest';
import { sheetExtent } from './extent';

describe('sheetExtent', () => {
  it('After takes in the walls it hacks, so the sheet and its scale go round them', () => {
    let s: EditorDoc = { doc: sampleFlatProject('prj_x'), history: emptyHistory() };
    s = dispatch(s, startRenovation());
    const before = s.doc.levels[0] as Level;
    const id = `${before.id}${AFTER_SUFFIX}`;
    const afterLevel = () => s.doc.renovation?.levels[0] as Level;
    // Hack the outside wall on the right: the After outline loses it.
    s = dispatch(s, deleteWall(id, 'w_living-and-dining_outside-2', afterLevel()));
    const right = outlineBounds(planGeometry(before))?.max.x ?? 0;
    expect(planExtent(planGeometry(afterLevel()))?.max.x).toBeLessThan(right - 0.1);
    expect(sheetExtent(s.doc, 'after')?.max.x).toBeCloseTo(right, 3);
    // As it is now: the flat's own outline (and door swings).
    expect(sheetExtent(s.doc, 'before')?.max.x).toBeCloseTo(right, 3);
  });
});
