import { type DesignResult, type Level, type ResultCheck, sampleFlatProject } from '@dhd/core';
import { describe, expect, it } from 'vitest';
import { failingChecks } from './parts';

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

describe('a card’s failing checks (designer v2, criteria 11–12)', () => {
  const shelter = check({
    key: 'HDB|shelter-bed|it_x',
    principle: 'HDB',
    waivable: false,
    text: 'A bed in the Household shelter: the household shelter isn’t a bedroom.',
    part: { space: 'rm_kitchen', aspect: 'furniture' },
  });
  const sofa = check({
    key: 'P2|faces|it_s',
    part: { space: 'rm_dry-kitchen+rm_living-and-dining', aspect: 'furniture' },
  });
  const noBed = check({ key: 'P1|bed|rm_bedroom|child-1', principle: 'P1', roomId: 'rm_bedroom' });
  const nobody = check({ key: 'P1|unplaced|child-2', principle: 'P1', unfixable: true });

  it('accepted anyway is not failing, and stays out of "already in your plan" once accepted', () => {
    const waivers = [{ key: sofa.key, text: sofa.text, at: '2026-11-07T00:00:00Z' }];
    expect(failingChecks(result([sofa]), { waivers }).open).toEqual([]);
    expect(failingChecks(result([sofa]), { waivers }).waived.map((c) => c.key)).toEqual([sofa.key]);
    const accepted = result([{ ...sofa, already: true }]);
    expect(failingChecks(accepted, { waivers }).already).toEqual([]);
    expect(failingChecks(result([shelter]), { waivers: [] }).open[0]?.waivable).toBe(false);
  });

  it('someone with no bed is listed first, and lines keep a steady order', () => {
    const { open } = failingChecks(result([sofa, noBed, nobody]), { waivers: [] });
    expect(open[0]?.key).toBe(nobody.key);
    const again = failingChecks(result([noBed, nobody, sofa]), { waivers: [] }).open;
    expect(again.map((c) => c.key)).toEqual(open.map((c) => c.key));
  });
});
