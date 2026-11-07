import { describe, expect, it } from 'vitest';
import { BENCHMARK, benchText, runFlat } from './benchmark';

/**
 * The benchmark in CI (spec docs/specs/ai-designer-v2.md, criteria 13, 16, 17): every recorded
 * answer, after its fix rounds, shows no hard failure, and a version only says it passes when
 * no hard check it caused fails. No request is made.
 */
describe('the designer benchmark (recorded answers, no requests)', () => {
  const reports = BENCHMARK.map(runFlat);
  it('prints the report', () => {
    console.log(benchText(reports));
  });

  for (const r of reports) {
    it(`${r.id}: no hard failure shown, everyone has a bed, nothing left out`, () => {
      expect(r.shown).toEqual([]);
      expect(r.bedless).toBe(0);
      expect(r.result.dropped.map((n) => n.text)).toEqual([]);
    });
    it(`${r.id}: “passes” only when no hard check it caused fails`, () => {
      expect(r.result.passes).toBe(!r.result.checks.some((c) => c.hard && !c.already));
    });
  }
});
