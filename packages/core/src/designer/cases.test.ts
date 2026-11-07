import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withPieces } from '../fixtures/furnishedSample';
import { CASE_MAX_BYTES, CaseFile, caseText, checkCase, designerCase } from './cases';
import { designChecks } from './checks';
import { sampleLevel } from './fixtures/sample';
import { defaultBrief } from './schema';

/**
 * "This is wrong" case files (spec docs/specs/ai-designer-v2.md, criteria 14–16). Every case
 * in `packages/core/src/fixtures/designer/cases/` is a test with no code: today's checks must
 * flag its bad layout on what the person pointed at, unless it is marked `known` with why.
 */
const DIR = join(__dirname, '../fixtures/designer/cases');
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));

describe('the cases folder (criteria 15, 16)', () => {
  it('holds the owner’s three cases of 7 Nov', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'owner-2026-11-07-missing-bed.json',
        'owner-2026-11-07-sofa-facing-wall.json',
        'owner-2026-11-07-table-in-hallway.json',
      ]),
    );
  });

  for (const f of files) {
    it(`${f}: the checks flag what the person pointed at`, () => {
      const c = CaseFile.parse(JSON.parse(readFileSync(join(DIR, f), 'utf8')));
      const { flagged, ok } = checkCase(c);
      if (c.known) {
        // Not covered yet: it says why, and once a principle covers it, `known` comes off.
        expect(c.known.length).toBeGreaterThan(10);
        expect(ok).toBe(false);
        return;
      }
      expect(flagged.map((x) => x.text)).not.toEqual([]);
      expect(ok).toBe(true);
    });
  }

  it('the lines the owner’s cases are flagged with', () => {
    const lines = (f: string) =>
      checkCase(CaseFile.parse(JSON.parse(readFileSync(join(DIR, f), 'utf8')))).flagged.map(
        (x) => x.text,
      );
    expect(lines('owner-2026-11-07-missing-bed.json')).toContain('Child 1 has no bed in Bedroom.');
    expect(lines('owner-2026-11-07-sofa-facing-wall.json')).toContain(
      'The 3-seat sofa faces the wall: 0.75 m in front of it.',
    );
    expect(
      lines('owner-2026-11-07-table-in-hallway.json').some((t) =>
        /^The way through narrows to 0\.\d\d m; it needs 0\.90 m\.$/.test(t),
      ),
    ).toBe(true);
  });
});

describe('a case file (criterion 14)', () => {
  const before = sampleLevel();
  const proposal = withPieces(before, [['sofa-3', { x: 8.3, y: 2.599 }, Math.PI]]);
  const brief = defaultBrief();
  const c = designerCase({
    title: 'The sofa faces the wall',
    what: 'facing',
    words: 'Sofa faces the wall',
    pointer: { itemId: 'it_f000' },
    brief,
    before,
    proposal,
    checks: designChecks(proposal, { brief }),
    model: 'provider/model-name',
  });

  it('has the fields, and none of a key, prices, the plan image or comment authors', () => {
    expect(Object.keys(c).sort()).toEqual(
      [
        'app',
        'before',
        'brief',
        'checks',
        'kind',
        'model',
        'pointer',
        'proposal',
        'rules',
        'schemaVersion',
        'title',
        'v',
        'what',
        'words',
      ].sort(),
    );
    const text = caseText(c);
    expect(text).not.toMatch(/sk-ant-|sk-proj-|AIza|apiKey|"usd"|"price|underlay|assetKey|author/);
    expect(c.checks.some((x) => x.key.startsWith('P2|faces'))).toBe(true);
  });

  it('is under 200 KB for the sample, and reads back', () => {
    const text = caseText(c);
    expect(new TextEncoder().encode(text).length).toBeLessThan(CASE_MAX_BYTES);
    expect(CaseFile.parse(JSON.parse(text))).toEqual(c);
  });

  it('a case no check flags fails unless marked known', () => {
    const fine = designerCase({ ...c, title: 'Looks odd', proposal: before, pointer: null });
    expect(checkCase(fine).ok).toBe(false);
  });
});
