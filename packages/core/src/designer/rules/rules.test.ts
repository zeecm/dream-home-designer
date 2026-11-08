import { describe, expect, it } from 'vitest';
import { furnishedSample, withPieces } from '../../fixtures/furnishedSample';
import { levelBounds } from '../../geometry';
import type { Level, Vec2 } from '../../schema';
import { measureRoute, walkwayReport } from '../../walkway';
import { aliasesFor } from '../aliases';
import sampleLiving from '../benchmark/answers/sample-living.json';
import { ONGS } from '../benchmark/benchmark';
import { designChecks } from '../checks';
import { SAMPLE_KEYS, parsed, sampleDesign, sampleLevel } from '../fixtures/sample';
import { designResult, designResultKey, swapSegment } from '../result';
import { type DesignBrief, defaultBrief, parseSpaceDesign } from '../schema';
import { ruleChecks, ruleKeepOuts } from './check';
import {
  FITS,
  MAX_RULES,
  RULE_RELATIONS,
  Rule,
  type RuleRelation,
  type RuleTarget,
  TARGET_KINDS,
  numberRange,
} from './schema';
import { ruleNumberProblem, vetRule } from './vet';
import { ruleSentence } from './words';

/**
 * House rules (slice 3a, criteria 39, 40 and 3a.5–3a.8 in core) on the sample flat: Main bedroom
 * (x 0.30–3.22, y 0.15–4.27), Bedroom (3.32–6.20, 0.15–3.05), Living and dining (6.50–10.03,
 * 1.65–5.92) with the passage to the bedrooms (3.00–6.50 by 3.15–4.27), the main door on its
 * south wall at about x 9.1.
 */
const base = sampleLevel();
const at = (x: number, y: number): Vec2 => ({ x, y });
const PI = Math.PI;
const BEDROOMS = ['rm_main-bedroom', 'rm_bedroom'];
const MAIN_DOOR = 'op_door_living-and-dining_outside-3';

let seq = 0;
function rule(patch: Partial<Rule> & Pick<Rule, 'relation' | 'target'>): Rule {
  seq++;
  return {
    id: `ru_${seq}`,
    name: 'A rule',
    subject: { kind: 'any' },
    n: null,
    levelId: base.id,
    at: '2026-11-08T09:00:00.000Z',
    from: { turnId: 'tu_1', version: null },
    deleted: false,
    ...patch,
  };
}
const corridor = (patch: Partial<Rule> = {}) =>
  rule({
    name: 'Never anything in the corridor',
    relation: 'notIn',
    target: { kind: 'route', from: 'main-door', to: BEDROOMS },
    ...patch,
  });
const R = (lvl: Level, rules: Rule[], brief: DesignBrief = defaultBrief()) =>
  designChecks(lvl, { brief, rules }).filter((c) => c.principle === 'R');

/**
 * A shoe cabinet 0.30 m wide and 0.20 m deep on the passage's north wall, between Bath/WC 2's
 * door and the dry kitchen: it leaves 0.92 m.
 */
function shallowCabinet(): Level {
  const lvl = withPieces(base, [['shoe-cabinet', at(4.36, 4.272 - 0.1), PI]]);
  const it = Object.values(lvl.items)[0];
  if (it) it.scale = { ...it.scale, x: 0.3 / 0.8, z: 0.2 / 0.35 };
  return lvl;
}
/** A TV console in the passage's corridor part (it leaves 0.67 m). */
const consoleInPassage = () => withPieces(base, [['tv-console', at(4.0, 3.35), 0]]);

describe('the rule object (tech §2)', () => {
  const targets: Record<string, RuleTarget> = {
    room: { kind: 'room', roomId: 'rm_bedroom' },
    roomUse: { kind: 'roomUse', use: 'bedroom' },
    wall: { kind: 'wall', wallId: 'w_main-bedroom_outside-2' },
    opening: { kind: 'opening', openingId: MAIN_DOOR },
    ownDoor: { kind: 'ownDoor' },
    window: { kind: 'window' },
    kind: { kind: 'kind', kindId: 'tv-console' },
    route: { kind: 'route', from: 'main-door', to: BEDROOMS },
    spot: { kind: 'spot', at: at(8, 3), r: 0.5 },
  };

  it('accepts exactly the relation × target matrix, with a number where one is needed', () => {
    for (const relation of RULE_RELATIONS) {
      for (const kind of TARGET_KINDS) {
        const range = numberRange(relation, kind);
        const r = Rule.safeParse(
          rule({
            subject: { kind: 'kind', kindId: 'sofa' },
            relation,
            target: targets[kind] as RuleTarget,
            n: range ? (range.default ?? range.min) : null,
          }),
        );
        expect(r.success, `${relation} × ${kind}`).toBe(FITS[relation].includes(kind));
      }
    }
  });

  it('takes numbers only in range, and "anything" only for nothing in / keep clear', () => {
    const within = (n: number | null) =>
      Rule.safeParse(
        rule({
          subject: { kind: 'kind', kindId: 'tv' },
          relation: 'atLeast',
          target: targets.kind as RuleTarget,
          n,
        }),
      ).success;
    expect(within(2.4)).toBe(true);
    expect(within(null)).toBe(false);
    expect(within(0.05)).toBe(false);
    expect(within(11)).toBe(false);
    expect(Rule.safeParse(corridor({ relation: 'keepClear', n: 0.5 })).success).toBe(false);
    expect(Rule.safeParse(corridor({ relation: 'keepClear', n: 0.6 })).success).toBe(true);
    expect(
      Rule.safeParse(rule({ relation: 'faces', target: targets.window as RuleTarget })).success,
    ).toBe(false);
    expect(Rule.safeParse({ ...corridor(), target: { kind: 'corridor', id: 'x' } }).success).toBe(
      false,
    );
    expect(Rule.safeParse({ ...corridor(), subject: { kind: 'role', id: 'sofa' } }).success).toBe(
      false,
    );
  });
});

describe('the app’s sentence (UX §3.2)', () => {
  it.each<[string, Partial<Rule> & Pick<Rule, 'relation' | 'target'>]>([
    [
      'Nothing in the way from the main door to Main bedroom and Bedroom, with 0.90 m clear',
      { relation: 'notIn', target: { kind: 'route', from: 'main-door', to: BEDROOMS } },
    ],
    [
      'Keep 1.00 m clear from the main door to Bedroom',
      {
        relation: 'keepClear',
        target: { kind: 'route', from: 'main-door', to: ['rm_bedroom'] },
        n: 1,
      },
    ],
    [
      'The desk in Bedroom',
      {
        subject: { kind: 'kind', kindId: 'desk' },
        relation: 'in',
        target: { kind: 'room', roomId: 'rm_bedroom' },
      },
    ],
    [
      'The 3-seat sofa faces the window',
      {
        subject: { kind: 'kind', kindId: 'sofa-3' },
        relation: 'faces',
        target: { kind: 'window' },
      },
    ],
    [
      'Beds doesn’t face their room’s door',
      {
        subject: { kind: 'category', category: 'beds' },
        relation: 'notFaces',
        target: { kind: 'ownDoor' },
      },
    ],
    [
      'The TV console at least 2.40 m from the 3-seat sofa',
      {
        subject: { kind: 'kind', kindId: 'tv-console' },
        relation: 'atLeast',
        target: { kind: 'kind', kindId: 'sofa-3' },
        n: 2.4,
      },
    ],
    [
      'The shoe cabinet within 1.50 m of the main door',
      {
        subject: { kind: 'kind', kindId: 'shoe-cabinet' },
        relation: 'within',
        target: { kind: 'opening', openingId: MAIN_DOOR },
        n: 1.5,
      },
    ],
    [
      'Keep 0.90 m clear in front of Bath/WC 2’s door',
      {
        relation: 'keepClear',
        target: { kind: 'opening', openingId: 'op_door_bath-wc-2_living-and-dining' },
      },
    ],
    [
      'No tall pieces in any bedroom',
      {
        subject: { kind: 'category', category: 'tall' },
        relation: 'notIn',
        target: { kind: 'roomUse', use: 'bedroom' },
      },
    ],
  ])('%s', (want, patch) => {
    expect(ruleSentence(rule(patch), base)).toBe(want);
  });
});

describe('ruleChecks (tech §3)', () => {
  it('39 in core: a console in the corridor fails with the rule’s wording; deleting the rule passes', () => {
    const lvl = consoleInPassage();
    const r = corridor();
    const [c] = R(lvl, [r]);
    expect(c?.key).toBe(`R|${r.id}|it_f000`);
    expect(c).toMatchObject({ hard: true, waivable: true, itemId: 'it_f000' });
    expect(c?.text).toBe(
      'Your rule “Never anything in the corridor”: the TV console is in the way from the main door to Main bedroom and Bedroom.',
    );
    expect(R(lvl, [{ ...r, deleted: true }])).toEqual([]);
    expect(R(lvl, [])).toEqual([]);
  });

  it('nothing in the way fails where the width left passes; keep 0.90 m clear doesn’t', () => {
    const lvl = shallowCabinet();
    expect(
      designChecks(lvl, { brief: defaultBrief() }).filter((c) => c.key.includes('walkway')),
    ).toEqual([]);
    expect(R(lvl, [corridor()]).map((c) => c.itemId)).toEqual(['it_f000']);
    expect(R(lvl, [corridor({ relation: 'keepClear', n: 0.9 })])).toEqual([]);
    // Measured exactly at 1.00 m, not the raster's width.
    const [c] = R(lvl, [corridor({ relation: 'keepClear', n: 1 })]);
    expect(c?.text).toMatch(/the shoe cabinet leaves 0\.9\d m, 1\.00 m needed\.$/);
  });

  it('a piece in an open room, or in the room the way leads to, isn’t in the way', () => {
    const lvl = furnishedSample();
    const ids = R(lvl, [corridor()]).map((c) => lvl.items[c.itemId ?? '']?.assetId);
    expect(ids).not.toContain('sofa-3');
    // The single bed narrows the way into Bedroom (the walkway check says so too).
    expect(ids).toEqual(['bed-single']);
  });

  it('in, and not in, a room (and a rule never forces a piece: none present passes)', () => {
    const desk = rule({
      subject: { kind: 'kind', kindId: 'desk' },
      relation: 'in',
      target: { kind: 'room', roomId: 'rm_bedroom' },
      name: 'Desk in Bedroom',
    });
    expect(R(base, [desk])).toEqual([]);
    expect(R(withPieces(base, [['desk', at(5.4, 0.45), 0]]), [desk])).toEqual([]);
    const [c] = R(withPieces(base, [['desk', at(8.3, 1.95), 0]]), [desk]);
    expect(c?.text).toBe(
      'Your rule “Desk in Bedroom”: the desk is in Living and dining, not Bedroom.',
    );
    const tall = rule({
      subject: { kind: 'category', category: 'tall' },
      relation: 'notIn',
      target: { kind: 'roomUse', use: 'master' },
      name: 'Nothing tall in our room',
    });
    expect(R(furnishedSample(), [tall]).map((x) => x.text)).toEqual([
      'Your rule “Nothing tall in our room”: the wardrobe is in the main bedroom.',
    ]);
  });

  it('faces and doesn’t face, by the nearest of the target (30°)', () => {
    const lvl = furnishedSample();
    const faces = rule({
      subject: { kind: 'kind', kindId: 'sofa' },
      relation: 'faces',
      target: { kind: 'kind', kindId: 'tv-console' },
      name: 'Sofa faces the TV',
    });
    expect(R(lvl, [faces])).toEqual([]);
    const turned = structuredClone(lvl);
    const sofa = Object.values(turned.items).find((i) => i.assetId === 'sofa-3');
    if (sofa) sofa.rotationY = 0;
    expect(R(turned, [faces])[0]?.text).toBe(
      'Your rule “Sofa faces the TV”: the 3-seat sofa faces away from the TV console.',
    );
    expect(R(lvl, [{ ...faces, relation: 'notFaces' }]).length).toBe(1);
  });

  it('within and at least, from the footprint', () => {
    const lvl = furnishedSample();
    const far = (n: number) =>
      rule({
        subject: { kind: 'kind', kindId: 'tv-console' },
        relation: 'atLeast',
        target: { kind: 'kind', kindId: 'sofa-3' },
        n,
        name: 'TV far from the sofa',
      });
    expect(R(lvl, [far(2.4)])).toEqual([]);
    expect(R(lvl, [far(3.5)])[0]?.text).toMatch(
      /^Your rule “TV far from the sofa”: the TV console is 2\.\d\d m from the 3-seat sofa, 3\.50 m needed\.$/,
    );
    const near = rule({
      subject: { kind: 'kind', kindId: 'bed-single' },
      relation: 'within',
      target: { kind: 'opening', openingId: 'op_door_bath-wc-2_living-and-dining' },
      n: 1,
      name: 'Bed near the toilet',
    });
    expect(R(lvl, [near])[0]?.text).toMatch(
      /is \d\.\d\d m from Bath\/WC 2’s door, 1\.00 m at most\.$/,
    );
    expect(R(lvl, [{ ...near, n: 5 }])).toEqual([]);
  });

  it('against a wall: its back within 0.05 m', () => {
    const lvl = furnishedSample();
    const against = rule({
      subject: { kind: 'kind', kindId: 'wardrobe' },
      relation: 'against',
      target: { kind: 'wall', wallId: 'w_main-bedroom_outside-2' },
      name: 'Wardrobe on the west wall',
    });
    expect(R(lvl, [against])).toEqual([]);
    expect(
      R(lvl, [{ ...against, target: { kind: 'wall', wallId: 'w_bedroom_main-bedroom' } }]).length,
    ).toBe(1);
  });

  it('keep clear in front of a door, and a spot', () => {
    const lvl = withPieces(base, [['plant', at(9.1, 5.35), 0]]);
    const door = rule({
      relation: 'keepClear',
      target: { kind: 'opening', openingId: MAIN_DOOR },
      name: 'Clear at the door',
    });
    expect(R(lvl, [door])[0]?.text).toBe(
      'Your rule “Clear at the door”: the potted plant is in the 0.90 m in front of the main door.',
    );
    expect(R(lvl, [{ ...door, n: 0.3 }])).toEqual([]);
    const spot = rule({ relation: 'notIn', target: { kind: 'spot', at: at(9.1, 5.35), r: 0.3 } });
    expect(R(lvl, [spot]).length).toBe(1);
    expect(R(lvl, [{ ...spot, target: { kind: 'spot', at: at(8, 3), r: 0.3 } }])).toEqual([]);
  });

  it('a new wording needs no code: the checks never read the name', () => {
    const lvl = furnishedSample();
    const rules = [
      corridor(),
      rule({
        subject: { kind: 'kind', kindId: 'sofa' },
        relation: 'faces',
        target: { kind: 'window' },
      }),
      rule({
        subject: { kind: 'category', category: 'tall' },
        relation: 'notIn',
        target: { kind: 'roomUse', use: 'master' },
      }),
    ];
    const strip = (cs: ReturnType<typeof ruleChecks>, names: string[]) =>
      cs.map((c) => ({ ...c, text: names.reduce((t, n) => t.replace(n, '…'), c.text) }));
    const usesOf = () => [];
    const a = ruleChecks(rules, { level: lvl, usesOf });
    const renamed = rules.map((r, i) => ({ ...r, name: `zq${i} ${Math.random().toString(36)}` }));
    const b = ruleChecks(renamed, { level: lvl, usesOf });
    expect(
      strip(
        b,
        renamed.map((r) => r.name),
      ),
    ).toEqual(
      strip(
        a,
        rules.map((r) => r.name),
      ),
    );
  });

  it('keep-outs: only the negative rules’ failing pieces, with convex regions', () => {
    const lvl = consoleInPassage();
    const ko = ruleKeepOuts([corridor()], { level: lvl, usesOf: () => [] });
    expect(ko.map((k) => k.itemId)).toEqual(['it_f000']);
    expect(ko[0]?.polys.length).toBeGreaterThan(0);
    const faces = rule({
      subject: { kind: 'kind', kindId: 'tv-console' },
      relation: 'faces',
      target: { kind: 'window' },
    });
    expect(ruleKeepOuts([faces], { level: lvl, usesOf: () => [] })).toEqual([]);
  });
});

describe('measureRoute (tech §3.3)', () => {
  it('at 0.90 m it says what the walkway check says, on the sample and furnished', () => {
    for (const lvl of [base, furnishedSample(), consoleInPassage()]) {
      const report = walkwayReport(lvl);
      const rooms = report.routes.filter((r) => r.route === 'circulation').map((r) => r.to);
      const ids = rooms.flatMap((t) => ('roomId' in t && t.roomId ? [t.roomId] : []));
      const m = measureRoute(lvl, ids, 0.9);
      for (const p of m.perRoom) {
        const w = report.routes.find(
          (r) => r.route === 'circulation' && 'roomId' in r.to && r.to.roomId === p.roomId,
        );
        expect(w, p.roomId).toBeDefined();
        expect(p.ok, p.roomId).toBe(w?.ok);
        expect(p.have, p.roomId).toBeCloseTo(w?.have ?? -1, 6);
        expect(p.capped).toBe(w?.capped);
        expect(p.pinch).toEqual(w?.pinch);
        expect([...p.blamed].sort()).toEqual([...(w?.blamed ?? [])].sort());
      }
    }
  });

  it('is exact at the rule’s width (1.00 m), and knows a plan with no main door', () => {
    const lvl = shallowCabinet();
    const [p] = measureRoute(lvl, ['rm_bedroom'], 1).perRoom;
    expect(p?.ok).toBe(false);
    expect(p?.have).toBeGreaterThan(0.9);
    expect(p?.have).toBeLessThan(0.94);
    const { [MAIN_DOOR]: _, ...openings } = base.openings;
    expect(measureRoute({ ...base, openings }, ['rm_bedroom'], 0.9).status).toBe('no-main-door');
  });
});

describe('vetRule (tech §4)', () => {
  const ctx = (rules: Rule[] = [], level = base, brief = defaultBrief()) => ({
    rules,
    level,
    brief,
  });
  const sofaWindow = (relation: RuleRelation) =>
    rule({
      subject: { kind: 'kind', kindId: 'sofa' },
      relation,
      target: { kind: 'window' },
      name: relation === 'faces' ? 'Sofa faces the window' : 'Sofa away from the window',
    });

  it('keeps a rule, saying what the plan already breaks (never blocking)', () => {
    const v = vetRule(corridor(), ctx([], consoleInPassage()));
    expect(v).toMatchObject({ ok: true });
    if (v.ok)
      expect(v.planBreaks).toEqual([
        'the TV console is in the way from the main door to Main bedroom and Bedroom',
      ]);
  });

  it('refuses in order: unfit, limit, duplicate, conflict, range', () => {
    expect(vetRule({ ...corridor(), relation: 'faces' }, ctx())).toMatchObject({
      ok: false,
      why: 'unfit',
      text: 'I couldn’t turn this into a check, so it’s noted, not checked.',
    });
    expect(
      vetRule(corridor({ target: { kind: 'route', from: 'main-door', to: ['rm_gone'] } }), ctx()),
    ).toMatchObject({ why: 'unfit' });
    const many = Array.from({ length: MAX_RULES }, (_, i) =>
      rule({ relation: 'notIn', target: { kind: 'spot', at: at(8, 2 + i * 0.1), r: 0.2 } }),
    );
    expect(vetRule(corridor(), ctx(many))).toMatchObject({ why: 'limit' });
    expect(
      vetRule(corridor(), ctx([...many.slice(1), { ...(many[0] as Rule), deleted: true }])),
    ).toMatchObject({
      ok: true,
    });
    const mine = corridor();
    expect(vetRule(corridor(), ctx([mine]))).toMatchObject({ why: 'duplicate', with: mine });
    const old = sofaWindow('notFaces');
    expect(vetRule(sofaWindow('faces'), ctx([old]))).toMatchObject({ why: 'conflict', with: old });
    const near = rule({
      subject: { kind: 'kind', kindId: 'sofa' },
      relation: 'within',
      target: { kind: 'window' },
      n: 1,
    });
    const far = { ...near, id: 'ru_far', relation: 'atLeast' as const, n: 1.5 };
    expect(vetRule(far, ctx([near]))).toMatchObject({
      why: 'range',
      text: 'These can’t both be met: within 1.00 m of the window, and at least 1.50 m from it.',
    });
    expect(vetRule({ ...far, n: 0.8 }, ctx([near]))).toMatchObject({ ok: true });
  });

  it('a room and a use overlap: not in any bedroom contradicts the desk in Bedroom', () => {
    const inBed = rule({
      subject: { kind: 'kind', kindId: 'desk' },
      relation: 'in',
      target: { kind: 'room', roomId: 'rm_bedroom' },
    });
    const noneIn = rule({
      subject: { kind: 'category', category: 'tables' },
      relation: 'notIn',
      target: { kind: 'roomUse', use: 'bedroom' },
    });
    expect(vetRule(noneIn, ctx([inBed]))).toMatchObject({ why: 'conflict' });
  });

  it('a wider clear width on the same way raises the rule you have', () => {
    const mine = corridor({ relation: 'keepClear', n: 0.9 });
    const v = vetRule(corridor({ relation: 'keepClear', n: 1 }), ctx([mine]));
    expect(v).toMatchObject({ ok: true, raises: { ruleId: mine.id, from: 0.9, to: 1 } });
    expect(vetRule(corridor({ relation: 'keepClear', n: 0.8 }), ctx([mine]))).toMatchObject({
      why: 'duplicate',
    });
  });

  it('HDB: no bed in the household shelter (unless the helper sleeps there)', () => {
    const r = rule({
      subject: { kind: 'kind', kindId: 'bed-single' },
      relation: 'in',
      target: { kind: 'room', roomId: 'rm_household-shelter' },
    });
    expect(vetRule(r, ctx())).toMatchObject({ why: 'hdb' });
    const helper: DesignBrief = {
      ...defaultBrief(),
      household: { ...defaultBrief().household, helper: true },
      sleeping: { 'rm_household-shelter': ['helper'] },
    };
    expect(vetRule(r, ctx([], base, helper))).toMatchObject({ ok: true });
    const byShelter = rule({
      subject: { kind: 'kind', kindId: 'shoe-cabinet' },
      relation: 'within',
      target: { kind: 'opening', openingId: 'op_door_household-shelter_kitchen' },
      n: 0.5,
    });
    expect(vetRule(byShelter, ctx())).toMatchObject({
      why: 'hdb',
      text: 'The household shelter’s door must open fully: nothing can stand within 0.90 m of it.',
    });
    // Their room's door is the shelter's for a piece that stands in the shelter.
    const own = rule({
      subject: { kind: 'kind', kindId: 'shoe-cabinet' },
      relation: 'within',
      target: { kind: 'ownDoor' },
      n: 0.5,
    });
    const inShelter = withPieces(base, [['shoe-cabinet', at(7.6, 7.6), 0]]);
    expect(vetRule(own, ctx([], inShelter))).toMatchObject({ why: 'hdb' });
    expect(vetRule(own, ctx())).toMatchObject({ ok: true });
  });

  it('the flat: a clear width over the way’s own is set to it', () => {
    const v = vetRule(corridor({ relation: 'keepClear', n: 2 }), ctx());
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.adjusted?.from).toBe(2);
      expect(v.adjusted?.to).toBeGreaterThan(0.95);
      expect(v.adjusted?.to).toBeLessThan(1.3);
      expect(v.adjusted?.why).toMatch(
        /^The way to .* is \d\.\d\d m wall to wall, so I’ve set \d\.\d\d m\.$/,
      );
      expect(v.rule.n).toBe(v.adjusted?.to);
    }
  });

  it('needs: no beds where someone sleeps; no route without a main door', () => {
    const noBeds = rule({
      subject: { kind: 'category', category: 'beds' },
      relation: 'notIn',
      target: { kind: 'room', roomId: 'rm_bedroom' },
    });
    expect(vetRule(noBeds, ctx([], base, ONGS))).toMatchObject({
      why: 'needs',
      text: expect.stringMatching(
        / sleep in Bedroom, so it needs beds\. Change who sleeps where in What I know about you\.$/,
      ),
    });
    const { [MAIN_DOOR]: _, ...openings } = base.openings;
    expect(vetRule(corridor(), ctx([], { ...base, openings }))).toMatchObject({ why: 'no-door' });
  });

  it('the number field’s reasons (UX §3.5)', () => {
    const r = corridor({ relation: 'keepClear', n: 0.9 });
    expect(ruleNumberProblem(r, 0.5, ctx())).toBe(
      'At least 0.60 m: the walkway check already keeps 0.60 m.',
    );
    expect(ruleNumberProblem(r, 1, ctx())).toBeNull();
    expect(ruleNumberProblem(r, 2.5, ctx())).toMatch(
      /^The way to .* is \d\.\d\d m wall to wall, so it can’t keep 2\.50 m clear\. Use \d\.\d\d m or less\.$/,
    );
    const far = rule({
      subject: { kind: 'kind', kindId: 'tv' },
      relation: 'atLeast',
      target: { kind: 'kind', kindId: 'sofa' },
      n: 2.4,
      name: 'TV at least 2.40 m from the sofa',
    });
    const near = { ...far, id: 'ru_near', relation: 'within' as const, n: 3 };
    expect(ruleNumberProblem(near, 2, ctx([far]))).toBe(
      'That contradicts “TV at least 2.40 m from the sofa”: use 2.40 m or more.',
    );
  });
});

describe('rules in a design (3a.5–3a.7, the solver)', () => {
  const living = parsed(parseSpaceDesign(sampleLiving, levelBounds(base)));
  const run = (rules: Rule[], start = base, id = 'dsn_rules') =>
    designResult(
      start,
      start,
      {
        ...sampleDesign({
          answers: { [SAMPLE_KEYS.living]: living },
          brief: ONGS,
          concept: null,
          id,
        }),
        aliases: aliasesFor(start),
      },
      { rules },
    );

  it('3a.5: the rules are in the result’s key, so a number edit re-checks at no cost', () => {
    const d = sampleDesign({ concept: null });
    const a = designResultKey(base, base, d, {
      rules: [corridor({ relation: 'keepClear', n: 0.9 })],
    });
    const b = designResultKey(base, base, d, {
      rules: [corridor({ relation: 'keepClear', n: 1 })],
    });
    expect(a).not.toBe(b);
  });

  it('3a.7: a rule the plan breaks on a piece the version didn’t touch is already in your plan', () => {
    // A wardrobe in Main bedroom, which the version (Living and dining) doesn't furnish.
    const start = withPieces(base, [['wardrobe', at(0.6, 1.6), -PI / 2]]);
    const tall = rule({
      subject: { kind: 'category', category: 'tall' },
      relation: 'notIn',
      target: { kind: 'room', roomId: 'rm_main-bedroom' },
    });
    const r = run([tall], start, 'dsn_rules_already');
    const c = r.checks.find((x) => x.key.startsWith('R|'));
    expect(c).toMatchObject({ already: true, itemId: 'it_f000' });
  });

  it('the re-solve keeps a failing piece out of a spot, taken only when strictly better', () => {
    const first = run([], base, 'dsn_rules_spot');
    const cab = Object.values(first.level.items).find((i) => i.assetId === 'shoe-cabinet');
    expect(cab).toBeDefined();
    if (!cab) return;
    const spot = rule({
      relation: 'notIn',
      target: { kind: 'spot', at: at(cab.position.x, cab.position.z), r: 0.3 },
      name: 'Keep this spot free',
    });
    const r = run([spot], base, 'dsn_rules_spot');
    expect(r.checks.filter((c) => c.key.startsWith('R|'))).toEqual([]);
    const moved = r.level.items[cab.id];
    expect(
      Math.hypot(
        (moved?.position.x ?? 0) - cab.position.x,
        (moved?.position.z ?? 0) - cab.position.z,
      ),
    ).toBeGreaterThan(0.3);
    for (const x of r.resolves) if (x.taken) expect(x.after).toBeLessThan(x.before);
    // The hard checks are no worse than without the rule.
    expect(r.checks.filter((c) => c.hard).length).toBeLessThanOrEqual(
      first.checks.filter((c) => c.hard).length,
    );
    // A rule it can't meet without making things worse is left to the checks.
    const sofa = Object.values(first.level.items).find((i) => i.assetId === 'sofa-3');
    const pinned = rule({
      relation: 'notIn',
      target: { kind: 'spot', at: at(sofa?.position.x ?? 0, sofa?.position.z ?? 0), r: 0.3 },
    });
    const s = run([pinned], base, 'dsn_rules_spot');
    expect(s.checks.filter((c) => c.key.startsWith('R|')).length).toBe(1);
    for (const x of s.resolves) if (x.taken) expect(x.after).toBeLessThan(x.before);
  });

  it('a rule move that would break a P2 relationship (a bedside away from its bed) is refused', () => {
    const plain = (rules: Rule[]) =>
      designResult(
        base,
        base,
        { ...sampleDesign({ concept: null, id: 'dsn_rules_p2' }), aliases: aliasesFor(base) },
        { rules },
      );
    const first = plain([]);
    const bedside = Object.values(first.level.items).find((i) => i.assetId === 'bedside');
    expect(bedside).toBeDefined();
    if (!bedside) return;
    const spot = rule({
      subject: { kind: 'item', itemId: bedside.id },
      relation: 'notIn',
      target: { kind: 'spot', at: at(bedside.position.x, bedside.position.z), r: 0.3 },
      name: 'Nothing by the bed',
    });
    const r = plain([spot]);
    // Left where it was: the rule fails, and no P2 check is added by moving it.
    expect(r.level.items[bedside.id]?.position).toEqual(bedside.position);
    expect(r.checks.some((c) => c.key === `R|${spot.id}|${bedside.id}`)).toBe(true);
    const p2 = (x: typeof r) =>
      x.checks.filter((c) => c.hard && c.key.startsWith('P2|')).map((c) => c.key);
    expect(p2(r)).toEqual(p2(first));
    expect(r.repaired.some((n) => /your rule/.test(n.text))).toBe(false);
  });

  it('a check key swaps the piece id segment only', () => {
    expect(swapSegment('P2|near|it_1', 'it_1', 'it_9')).toBe('P2|near|it_9');
    expect(swapSegment('R|it_1x|it_1', 'it_1', 'it_9')).toBe('R|it_1x|it_9');
  });

  it('PERF: 20 rules add at most 20 ms (median) to the checks on the sample', () => {
    const lvl = furnishedSample();
    // A household's twenty: two about the way through, the rest about pieces and rooms.
    const kinds = ['sofa', 'tv-console', 'bed-queen', 'wardrobe', 'desk', 'dining-4'];
    const rules: Rule[] = [corridor(), corridor({ relation: 'keepClear', n: 1 })];
    for (let i = 0; rules.length < MAX_RULES; i++) {
      const kindId = kinds[i % kinds.length] as string;
      const subject = { kind: 'kind' as const, kindId };
      const pick = [
        rule({ subject, relation: 'faces', target: { kind: 'window' } }),
        rule({
          subject,
          relation: 'atLeast',
          target: { kind: 'kind', kindId: 'tv' },
          n: 1 + i / 10,
        }),
        rule({ subject, relation: 'notIn', target: { kind: 'roomUse', use: 'kids' } }),
        rule({
          subject,
          relation: 'against',
          target: { kind: 'wall', wallId: 'w_main-bedroom_outside-2' },
        }),
        rule({ relation: 'keepClear', target: { kind: 'spot', at: at(8, 3 + i / 10), r: 0.4 } }),
        rule({ relation: 'keepClear', target: { kind: 'opening', openingId: MAIN_DOOR } }),
      ];
      rules.push(pick[i % pick.length] as Rule);
    }
    const time = (rs: Rule[]) => {
      const ts: number[] = [];
      for (let i = 0; i < 7; i++) {
        const t = performance.now();
        designChecks({ ...lvl, items: { ...lvl.items } }, { brief: ONGS, rules: rs });
        ts.push(performance.now() - t);
      }
      return ts.sort((a, b) => a - b)[3] as number;
    };
    time(rules);
    const extra = time(rules) - time([]);
    console.log(`20 rules: +${extra.toFixed(1)} ms`);
    expect(extra).toBeLessThan(process.env.PERF ? 20 : 60);
  });
});
