import { type DesignResult, type Level, type ResultCheck, sampleFlatProject } from '@dhd/core';
import { describe, expect, it } from 'vitest';
import { checksLine, checksShort, failingChecks, failingParts } from './parts';

/** The checks part of a result (all these helpers read), around the sample flat. */
const level = sampleFlatProject('prj_parts').levels[0] as Level;
const check = (c: Partial<ResultCheck> & { key: string }): ResultCheck => ({
  principle: 'P2',
  hard: true,
  waivable: true,
  text: c.key,
  already: false,
  part: null,
  ...c,
});
const result = (checks: ResultCheck[]) =>
  ({ checks, level, spaces: [] }) as unknown as DesignResult;

describe('Accept’s failing parts and the card’s line (designer v2, criteria 11–12)', () => {
  const living = { space: 'rm_dry-kitchen+rm_living-and-dining', aspect: 'furniture' } as const;
  const shelter = check({
    key: 'HDB|shelter-bed|it_x',
    principle: 'HDB',
    waivable: false,
    text: 'A bed in the Household shelter: the household shelter isn’t a bedroom.',
    part: { space: 'rm_kitchen', aspect: 'furniture' },
  });
  const sofa = check({ key: 'P2|faces|it_s', part: living });
  const noBed = check({ key: 'P1|bed|rm_bedroom|child-1', principle: 'P1', roomId: 'rm_bedroom' });
  const nobody = check({ key: 'P1|unplaced|child-2', principle: 'P1', unfixable: true });

  it('12: an HDB rule failure locks its part (it can’t be accepted anyway)', () => {
    const parts = failingParts(result([shelter, sofa]), new Set());
    expect(parts.get('rm_kitchen|furniture')?.hdb).toBe(true);
    expect(parts.get(`${living.space}|furniture`)?.hdb).toBe(false);
    // Only waivable checks are ever saved as waivers (state.waiveChecks), so its key never
    // reaches the set.
  });

  it('11: a waived check no longer leaves its part out', () => {
    const parts = failingParts(result([sofa]), new Set([sofa.key]));
    expect(parts.size).toBe(0);
  });

  it('a missing bed is the room’s: no part is left out for it (the beds there stay ticked)', () => {
    expect(failingParts(result([noBed]), new Set()).size).toBe(0);
  });

  it('accepted anyway reads amber, never "Passes all checks"; the strip says waived', () => {
    const r = result([sofa]);
    const waivers = [{ key: sofa.key, text: sofa.text, at: '2026-11-07T00:00:00Z' }];
    expect(checksLine(r, { waivers })).toEqual({ text: '1 accepted anyway', tone: 'waived' });
    expect(checksShort(r, { waivers })).toBe('1 waived');
    expect(checksLine(r, { waivers: [] })).toEqual({ text: '1 doesn’t pass', tone: 'fail' });
    expect(checksLine(result([]), { waivers: [] }).text).toBe('Passes all checks');
  });

  it('someone with no bed is listed first, and lines keep a steady order', () => {
    const { open } = failingChecks(result([sofa, noBed, nobody]), { waivers: [] });
    expect(open[0]?.key).toBe(nobody.key);
    const again = failingChecks(result([noBed, nobody, sofa]), { waivers: [] }).open;
    expect(again.map((c) => c.key)).toEqual(open.map((c) => c.key));
  });
});
