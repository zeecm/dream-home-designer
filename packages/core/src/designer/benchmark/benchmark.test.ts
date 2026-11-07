import { describe, expect, it } from 'vitest';
import { BENCHMARK, benchText, runFlat } from './benchmark';

/** Extras a room can do without (a chair beyond the household's, a lamp, a bedside table). */
const EXTRAS = /bedside|armchair|lamp|rug|plant|ficus|side table|coffee table|dining chair/;

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
    it(`${r.id}: no hard failure shown, everyone has a bed, nothing it needs left out`, () => {
      expect(r.shown).toEqual([]);
      expect(r.bedless).toBe(0);
      // Only extras may be left out (a bedside table with no room by the bed's head), and
      // what is known not to fit yet (each still left out, so the note comes off when it fits).
      const known = BENCHMARK.find((f) => f.id === r.id)?.known ?? {};
      const out = r.result.dropped.filter((n) => !EXTRAS.test(n.text));
      expect(out.filter((n) => !(n.ref && known[n.ref])).map((n) => n.text)).toEqual([]);
      for (const ref of Object.keys(known)) {
        expect(r.result.dropped.some((n) => n.ref === ref)).toBe(true);
      }
    });
    it(`${r.id}: “passes” only when no hard check it caused fails`, () => {
      expect(r.result.passes).toBe(!r.result.checks.some((c) => c.hard && !c.already));
    });
  }
});
