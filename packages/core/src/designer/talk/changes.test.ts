import { describe, expect, it } from 'vitest';
import { acceptChanges, putPlanBack } from '../../commands';
import { furnishedSample } from '../../fixtures/furnishedSample';
import { sampleFlatProject } from '../../fixtures/sampleFlat';
import { type EditorDoc, dispatch, emptyHistory, undo } from '../../history';
import type { Level } from '../../schema';
import { acceptDesign, mergeDesign } from '../accept';
import {
  SAMPLE_KEYS,
  SPLIT_BEDROOM,
  sampleAnswers,
  sampleConcept,
  sampleDesign,
} from '../fixtures/sample';
import { designResult } from '../result';
import { BATHROOMS, type Concept, type Part } from '../schema';
import { spacesOf } from '../spaces';
import { changeSet, defaultTicks, mergeChanges, partsOf, subsetReport } from './changes';

const fresh = (level?: Level): EditorDoc => {
  const doc = sampleFlatProject();
  return { doc: level ? { ...doc, levels: [level] } : doc, history: emptyHistory() };
};
const flat = (s: EditorDoc) => s.doc.levels[0] as Level;
const reno = (s: EditorDoc) => s.doc.renovation?.levels[0] as Level;

function allParts(level: Level): Part[] {
  return [
    { aspect: 'walls' },
    ...spacesOf(level).flatMap((s) =>
      (['furniture', 'built-ins', 'finishes', 'electrical'] as const).map((aspect) => ({
        space: s.key,
        aspect,
      })),
    ),
    { space: BATHROOMS, aspect: 'finishes' },
  ];
}

/** A small seeded random number source, so a property test fails the same way twice. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('changeSet', () => {
  const lvl = sampleFlatProject().levels[0] as Level;
  const design = sampleDesign({ level: lvl });
  const r = designResult(lvl, lvl, design);
  const changes = changeSet(lvl, r, design);

  it('lists walls first, then each designed space in plan order, every row in words', () => {
    expect(changes[0]?.id).toBe('walls');
    expect(changes[0]?.rows.length).toBeGreaterThan(0);
    const groups = [...new Set(changes.map((c) => c.group))];
    const order = spacesOf(r.level).map((s) => s.key);
    const spaceGroups = groups.filter((g) => g !== 'walls' && g !== BATHROOMS);
    expect(spaceGroups).toEqual(order.filter((k) => spaceGroups.includes(k)));
    for (const c of changes) {
      expect(c.text).not.toMatch(/\b[WRDP]\d+\b/); // no aliases
      expect(c.text).not.toMatch(/\d\.\d\d,/); // no coordinates
      expect(c.text.length).toBeGreaterThan(5);
    }
  });

  it('the empty sample gets only additions, each with the designer’s reason', () => {
    const pieces = changes.filter((c) => c.items.target.length);
    expect(pieces.length).toBeGreaterThan(5);
    expect(pieces.every((c) => c.verb === 'add')).toBe(true);
    const sofa = pieces.find((c) => /sofa/.test(c.text));
    expect(sofa?.text).toMatch(/^Add a 3.seat sofa/);
    expect(sofa?.why).toMatch(/window/);
  });

  it('chairs are said with their table, in one row that takes them all', () => {
    const table = changes.find((c) => /dining table/.test(c.text));
    expect(table?.text).toMatch(/with \d chairs$/);
    expect(table?.items.target.length).toBeGreaterThan(1);
    expect(changes.some((c) => /^Add a dining chair/.test(c.text))).toBe(false);
  });

  it('a moved piece is a Move (same id), a piece of the same kind elsewhere too; another kind is a Swap', () => {
    const furnished = furnishedSample();
    const rf = designResult(furnished, furnished, sampleDesign({ level: furnished }));
    const cs = changeSet(furnished, rf, sampleDesign({ level: furnished }));
    expect(cs.some((c) => c.verb === 'remove' || c.verb === 'swap' || c.verb === 'move')).toBe(
      true,
    );
    // Every piece taken out or put in is in exactly one row.
    const ids = cs.flatMap((c) => [...c.items.now, ...c.items.target]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rows of a space reshaped by the walls need the walls', () => {
    const concept: Concept = { ...sampleConcept(), walls: SPLIT_BEDROOM };
    const d = sampleDesign({ level: lvl, concept, answers: sampleAnswers() });
    const rr = designResult(lvl, lvl, d);
    const cs = changeSet(lvl, rr, d);
    expect(cs.some((c) => c.needsWalls)).toBe(true);
    // Without the walls, those rows don't go in.
    const ids = cs.filter((c) => c.id !== 'walls').map((c) => c.id);
    const merged = mergeChanges(lvl, rr.level, cs, ids);
    for (const c of cs.filter((x) => x.needsWalls)) {
      for (const id of c.items.target) expect(merged.items[id]).toBeUndefined();
    }
  });

  it('failing checks are on the row that causes them; those rows start unticked', () => {
    const ticks = new Set(defaultTicks(changes));
    for (const c of changes) expect(ticks.has(c.id)).toBe(c.checks.length === 0);
  });
});

describe('mergeChanges and acceptChanges (criterion 23)', () => {
  it('accepting every change gives the same plan as accepting every part', () => {
    const lvl = sampleFlatProject().levels[0] as Level;
    const design = sampleDesign({ level: lvl });
    const r = designResult(lvl, lvl, design);
    const cs = changeSet(lvl, r, design);
    const all = mergeChanges(
      lvl,
      r.level,
      cs,
      cs.map((c) => c.id),
    );
    const parts = mergeDesign(lvl, r.level, allParts(r.level), {
      base: lvl,
      removeHandPlaced: true,
    });
    expect(all.items).toEqual(parts.items);
    expect(all.walls).toEqual(parts.walls);
    expect(all.openings).toEqual(parts.openings);
    expect(all.rooms).toEqual(parts.rooms);
    expect(all.points).toEqual(parts.points);
  });

  it('2 of 5 rows change only those two, as one undo step; Undo gives the project back exactly', () => {
    const s0 = fresh();
    const lvl = flat(s0);
    const design = sampleDesign({ level: lvl, concept: null });
    const r = designResult(lvl, lvl, design);
    const cs = changeSet(lvl, r, design).filter((c) => c.group === SAMPLE_KEYS.living);
    expect(cs.length).toBeGreaterThanOrEqual(5);
    const five = cs.slice(0, 5);
    const two = [five[0]?.id, five[3]?.id] as string[];
    const s1 = dispatch(s0, acceptChanges(lvl.id, r.level, five, two));
    expect(s1.history.past).toHaveLength(1);
    const a = reno(s1);
    const want = new Set(five.filter((c) => two.includes(c.id)).flatMap((c) => c.items.target));
    expect(new Set(Object.keys(a.items))).toEqual(want);
    for (const id of want) expect(a.items[id]).toEqual(r.level.items[id]);
    expect(a.walls).toEqual(lvl.walls);
    expect(flat(s1)).toEqual(lvl);
    const back = undo(s1);
    expect(back.doc).toEqual(s0.doc);
    expect(back.doc.renovation).toBeUndefined();
  });

  it('any subset, then Undo, gives the document back (with and without a renovation)', () => {
    const lvl = sampleFlatProject().levels[0] as Level;
    const design = sampleDesign({ level: lvl });
    const r0 = designResult(lvl, lvl, design);
    const withReno = dispatch(fresh(), acceptDesign(lvl.id, lvl, [], { base: lvl }));
    const after = reno(withReno);
    const r1 = designResult(after, lvl, design);
    const cases: [EditorDoc, Level, ReturnType<typeof designResult>][] = [
      [fresh(), lvl, r0],
      [withReno, after, r1],
    ];
    const rand = rng(7);
    for (const [s0, now, r] of cases) {
      const cs = changeSet(now, r, design);
      for (let i = 0; i < 6; i++) {
        const ids = cs.filter(() => rand() < 0.5).map((c) => c.id);
        const s1 = dispatch(s0, acceptChanges(lvl.id, r.level, cs, ids));
        expect(undo(s1).doc).toEqual(s0.doc);
      }
    }
  });

  it('partsOf names the parts the accepted rows amount to', () => {
    const lvl = sampleFlatProject().levels[0] as Level;
    const design = sampleDesign({ level: lvl });
    const r = designResult(lvl, lvl, design);
    const cs = changeSet(lvl, r, design);
    const living = cs.filter((c) => c.group === SAMPLE_KEYS.living && c.verb === 'add');
    expect(
      partsOf(
        cs,
        living.map((c) => c.id),
      ),
    ).toEqual([
      { space: SAMPLE_KEYS.living, aspect: 'furniture' },
      { space: SAMPLE_KEYS.living, aspect: 'built-ins' },
    ]);
    expect(partsOf(cs, ['walls'])).toEqual([{ aspect: 'walls' }]);
  });

  it('putPlanBack restores the start in one step, or takes the renovation away', () => {
    const s0 = fresh();
    const lvl = flat(s0);
    const r = designResult(lvl, lvl, sampleDesign({ level: lvl }));
    const cs = changeSet(lvl, r, sampleDesign({ level: lvl }));
    const s1 = dispatch(
      s0,
      acceptChanges(
        lvl.id,
        r.level,
        cs,
        cs.map((c) => c.id),
      ),
    );
    const s2 = dispatch(s1, putPlanBack(lvl.id, null));
    expect(s2.doc.renovation).toBeUndefined();
    expect(undo(s2).doc).toEqual(s1.doc);
    const s3 = dispatch(s1, putPlanBack(lvl.id, lvl));
    expect(reno(s3).items).toEqual({});
    expect(reno(s3).walls).toEqual(lvl.walls);
  });
});

describe('subsetReport', () => {
  it('prices and checks only what is ticked', () => {
    const lvl = sampleFlatProject().levels[0] as Level;
    const design = sampleDesign({ level: lvl, concept: null });
    const r = designResult(lvl, lvl, design);
    const cs = changeSet(lvl, r, design);
    const none = subsetReport(lvl, lvl, r, mergeChanges(lvl, r.level, cs, []), design.brief);
    const all = subsetReport(
      lvl,
      lvl,
      r,
      mergeChanges(
        lvl,
        r.level,
        cs,
        cs.map((c) => c.id),
      ),
      design.brief,
    );
    expect(none.delta).toBe(0);
    expect(none.failing).toEqual([]);
    expect(all.delta).toBeGreaterThan(0);
    expect(all.cost.high).toBeGreaterThanOrEqual(all.cost.low);
  });
});
