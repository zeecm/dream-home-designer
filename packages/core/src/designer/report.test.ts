import { describe, expect, it } from 'vitest';
import { aliasesFor } from './aliases';
import {
  SAMPLE_KEYS,
  sampleAnswers,
  sampleConcept,
  sampleDesign,
  sampleLevel,
  tanBrief,
} from './fixtures/sample';
import { roomStep } from './prompts';
import {
  type RunReport,
  addressedIn,
  failureLines,
  firstAndMore,
  leadLine,
  leadParts,
  leftOutLines,
  leftSig,
  manyOf,
  mergeLines,
  peopleWords,
  readyLine,
  reportLine,
  roundLines,
  runReport,
  tableEntries,
  verdictWords,
} from './report';
import { type ResultCheck, designResult } from './result';
import type { DesignBrief, DesignInput, FixRound } from './schema';
import { spacesOf } from './spaces';

/**
 * The run report (spec docs/specs/designer-listens.md §1, criteria 1, 3, 4 and 8): built once
 * from a version's result and its stored fix rounds, the one source for the talk call, the fix
 * rounds and the card.
 */

const level = sampleLevel();
const aliases = aliasesFor(level);
/** Two adults, in the main bedroom (as the checks assume). */
const couple: DesignBrief = {
  ...tanBrief(),
  household: { ...tanBrief().household, children: [], elders: [] },
};

/**
 * The fixture version: the main bedroom's bed kept as "P99" (a piece the plan doesn't have, as
 * in the owner's V6 to V9), and a sofa that isn't in the catalogue. So 2 failures as the person
 * reads them (neither of the couple has a bed; the living room seats 0) and 2 pieces left out.
 */
function fixture(): { d: DesignInput; r: ReturnType<typeof designResult> } {
  const answers = sampleAnswers(level);
  const main = answers[SAMPLE_KEYS.main];
  const living = answers[SAMPLE_KEYS.living];
  if (!main || !living) throw new Error('sample answers');
  main.items = main.items.map((i) => (i.ref === 'bed1' ? { ...i, keep: 'P99' } : i));
  living.items = living.items.map((i) => (i.ref === 'sofa1' ? { ...i, assetId: 'sofa-999' } : i));
  const d = sampleDesign({ level, answers, brief: couple });
  return { d, r: designResult(level, level, d) };
}

const fake = (key: string, text: string, itemId?: string): ResultCheck => ({
  key,
  principle: key.split('|')[0] as ResultCheck['principle'],
  hard: true,
  waivable: true,
  text,
  ...(itemId ? { itemId } : {}),
  already: false,
  part: null,
});

describe('runReport (criterion 1)', () => {
  const { d, r } = fixture();
  const rep = runReport(r, d, { aliases });

  it('F1–F2: the room and the app’s words; L1–L2: ref, catalogue id, reason and hint', () => {
    expect(rep.failures.map((f) => f.id)).toEqual(['F1', 'F2']);
    expect(rep.failures.map((f) => f.text)).toEqual([
      'Adult 1 and Adult 2 have no bed in Master bedroom.',
      'Living and dining seats 0; the household needs at least 2 on a sofa or chairs.',
    ]);
    expect(rep.failures[0]).toMatchObject({
      roomId: 'rm_main-bedroom',
      room: 'Master bedroom',
      count: 2,
      keys: ['P1|bed|rm_main-bedroom|adult-1', 'P1|bed|rm_main-bedroom|adult-2'],
      // Across runs: principle, code, room and who (never an item id).
      sig: 'P1|bed|rm_main-bedroom|adult-1 P1|bed|rm_main-bedroom|adult-2',
      causedBy: 'L1',
    });
    expect(rep.leftOut.map((l) => [l.id, l.ref, l.assetId, l.code, l.causes])).toEqual([
      ['L1', 'bed1', 'bed-queen', 'keep-missing', 'F1'],
      ['L2', 'sofa1', 'sofa-999', 'not-catalogue', null],
    ]);
    expect(rep.leftOut[0]?.text).toBe('“bed1”: there’s no piece “P99” in the flat.');
    // A keep-ref drop: the starting plan doesn't have it; place a new one with keep: null.
    expect(rep.leftOut[0]?.hint).toBe(
      'P99 isn’t in the plan this design starts from. Place a new `bed-queen` with keep: null, or keep a piece listed in The flat now.',
    );
    expect(rep.leftOut[1]?.hint).toBe('As the app says; pick from the catalogue.');
  });

  it('the model’s lines carry the plan’s ids; the person’s never do, and use their names', () => {
    expect(failureLines(rep, aliases)).toEqual([
      'F1 doesn’t pass · Master bedroom (R2): Adult 1 and Adult 2 have no bed in Master bedroom.',
      'F2 doesn’t pass · Living and dining (R3): Living and dining seats 0; the household needs at least 2 on a sofa or chairs.',
    ]);
    const l = leftOutLines(rep);
    expect(l[0]).toBe(
      'L1 left out · Master bedroom · bed1 (bed-queen): “bed1”: there’s no piece “P99” in the flat. To fix: P99 isn’t in the plan this design starts from. Place a new `bed-queen` with keep: null, or keep a piece listed in The flat now.',
    );
    for (const x of [...failureLines(rep, aliases), ...l])
      expect(x.length).toBeLessThanOrEqual(300);
    // One line for the couple, with the cause once.
    expect(rep.failures[0]?.says).toBe('You and Partner have no bed in Master bedroom.');
    expect(rep.failures[0]?.cause).toBe(
      'The designer’s answer used a queen bed that isn’t in your plan, so the app left it out.',
    );
    for (const f of rep.failures) {
      expect(`${f.says} ${f.cause}`).not.toMatch(/\b[WPRD]\d+\b|Adult \d/);
    }
    // A plan may name L1 by the failure it causes, in the words the card showed.
    expect(tableEntries(rep).find((e) => e.id === 'L1')?.says).toBe(
      'You and Partner have no bed in Master bedroom.',
    );
  });

  it('a check on a piece names it by the answer’s ref, or by its short id for a plan piece', () => {
    const placed = Object.entries(r.refs).find(([, ref]) => ref === 'ward1')?.[0] ?? '';
    const planPiece = 'it_plan';
    const more = runReport(
      {
        ...r,
        checks: [
          ...r.checks,
          fake(`P3|walkway|${placed}|main`, 'The way is 0.70 m; it needs 0.90 m.', placed),
          fake(`P3|walkway|${planPiece}|main`, 'The way past it is 0.80 m.', planPiece),
        ],
      },
      d,
      { aliases: { ...aliases, P42: planPiece } },
    );
    const byKey = new Map(more.failures.map((f) => [f.key, f]));
    expect(byKey.get(`P3|walkway|${placed}|main`)?.pieces).toEqual(['ward1']);
    expect(byKey.get(`P3|walkway|${placed}|main`)?.assetId).toBe('built-in-wardrobe');
    expect(byKey.get(`P3|walkway|${planPiece}|main`)?.pieces).toEqual(['P42']);
    // Waived checks aren't failures; a scope leaves the others out.
    expect(
      runReport(r, d, { waived: ['P1|bed|rm_main-bedroom|adult-1'] }).failures.map((f) => f.says),
    ).toEqual([
      'Partner has no bed in Master bedroom.',
      'Living and dining seats 0; the household needs at least 2 on a sofa or chairs.',
    ]);
    expect(runReport(r, d, { spaces: [SAMPLE_KEYS.living] }).leftOut.map((x) => x.ref)).toEqual([
      'sofa1',
    ]);
  });

  it('the same failure on several pieces is one line; the bed comes before the chairs', () => {
    const chairs = Object.keys(r.refs).filter(
      (id) => r.level.items[id]?.assetId === 'dining-chair',
    );
    expect(chairs.length).toBe(4);
    const rep2 = runReport(
      {
        ...r,
        checks: [
          ...chairs.map((id) => fake(`P2|belongs|${id}`, 'The dining chair isn’t at a table.', id)),
          ...r.checks,
        ],
      },
      d,
      { aliases },
    );
    expect(rep2.failures.map((f) => f.says)).toEqual([
      'You and Partner have no bed in Master bedroom.',
      'Living and dining seats 0; the household needs at least 2 on a sofa or chairs.',
      '4 dining chairs aren’t at a table.',
    ]);
    expect(rep2.failures[2]?.count).toBe(4);
    expect(failureLines(rep2, aliases)[2]).toBe(
      'F3 doesn’t pass · Living and dining (R3) · chair1, chair2, chair3, chair4 (dining-chair): 4 dining chairs aren’t at a table.',
    );
  });

  it('criterion 3: the digest’s verdict: “2 don’t pass, 2 pieces left out”, or “passes”', () => {
    expect(verdictWords(rep)).toBe('2 don’t pass, 2 pieces left out');
    const ok = runReport(designResult(level, level, sampleDesign({ level, brief: couple })), d);
    expect(verdictWords({ ...ok, leftOut: [] })).toBe('passes');
    // More than On the table lists: it says so.
    const many = { ...rep, leftOut: Array.from({ length: 10 }, () => rep.leftOut[0]) };
    expect(verdictWords(many as RunReport)).toBe('2 don’t pass, 10 pieces left out (8 listed)');
  });
});

describe('merging lines', () => {
  it('the same words in two rooms are two lines; one room’s, one', () => {
    const t = (key: string, roomId: string) => ({
      key,
      text: 'The dining chair isn’t at a table.',
      says: 'The dining chair isn’t at a table.',
      roomId,
    });
    const lines = mergeLines([
      t('P2|belongs|a', 'r1'),
      t('P2|belongs|b', 'r1'),
      t('P2|belongs|c', 'r2'),
    ]);
    expect(lines.map((l) => l.says)).toEqual([
      '2 dining chairs aren’t at a table.',
      'The dining chair isn’t at a table.',
    ]);
  });

  it('pieces said many times', () => {
    expect(manyOf('The dining chair isn’t at a table.', 4)).toBe(
      '4 dining chairs aren’t at a table.',
    );
    expect(manyOf('The bench faces away from its table.', 2)).toBe(
      '2 benches face away from its table.',
    );
    expect(manyOf('Something odd happened.', 3)).toBe('Something odd happened (3 pieces).');
    expect(manyOf('The sofa faces the wall.', 1)).toBe('The sofa faces the wall.');
  });
});

describe('the hints by reason', () => {
  const { d, r } = fixture();
  const note = (n: object) => ({
    ...r,
    dropped: [
      {
        text: 'Left out the 3-seat sofa: no wall or spot in the room has room for it.',
        ref: 'sofa1',
        space: SAMPLE_KEYS.living,
        ...n,
      },
    ],
  });
  const living = sampleAnswers(level)[SAMPLE_KEYS.living];
  const withSofa = sampleDesign({
    level,
    brief: couple,
    answers: { ...sampleAnswers(level), ...(living ? { [SAMPLE_KEYS.living]: living } : {}) },
  });

  it('no wall long enough: the numbers when the room is short, else the walls are taken', () => {
    const short = runReport(note({ code: 'no-wall', need: 2.1, longest: 1.8 }), withSofa, {
      aliases,
    });
    expect(short.leftOut[0]?.hint).toBe(
      'Needs 2.10 m of wall; the longest free run in R3 is 1.80 m. Use a smaller piece, another room, or free-standing.',
    );
    expect(short.leftOut[0]?.cause).toBe(
      'The 3-seat sofa needs 2.10 m of wall; the longest free wall in Living and dining is 1.80 m.',
    );
    const taken = runReport(note({ code: 'no-wall', need: 2.1, longest: 3.4 }), withSofa, {
      aliases,
    });
    expect(taken.leftOut[0]?.hint).toMatch(
      /^Needs 2\.10 m of wall; the walls long enough for it are taken by your other pieces\./,
    );
    expect(taken.leftOut[0]?.cause).toBe(
      'The walls in Living and dining that could take the 3-seat sofa are taken by other pieces.',
    );
    const nowhere = runReport(note({ code: 'no-place' }), d, { aliases });
    expect(nowhere.leftOut[0]?.hint).toBe(
      'It had no spot inside R3. Give it `against`, or put it in another room.',
    );
    expect(runReport(note({ code: 'keep-in-place' }), d).leftOut[0]?.hint).toMatch(
      /^The brief says this piece stays where it is/,
    );
    // Part 1's reasons have their own hints: never "place it again".
    expect(runReport(note({ code: 'keep-held' }), d).leftOut[0]?.hint).toMatch(
      /^That piece stays where it is \(in another room, kept by the household, or moved by hand\)/,
    );
    expect(runReport(note({ code: 'duplicate' }), d).leftOut[0]?.hint).toMatch(
      /^That piece is placed once already\. Keep it only once/,
    );
  });

  it('the solver’s drop carries its code and numbers (beds the room can’t hold)', () => {
    const answers = sampleAnswers(level);
    const main = answers[SAMPLE_KEYS.main];
    if (!main) throw new Error('sample');
    main.items = [
      ...main.items,
      ...[2, 3].map((k) => ({ ...(main.items[0] as (typeof main.items)[number]), ref: `bed${k}` })),
    ];
    const r2 = designResult(level, level, sampleDesign({ level, answers, brief: couple }));
    const dropped = r2.dropped.filter((n) => n.ref?.startsWith('bed'));
    expect(dropped.length).toBeGreaterThan(0);
    for (const n of dropped) expect(n.code).toMatch(/^(no-wall|no-place)$/);
    // Every piece left out has a code (part 1's reasons included).
    for (const n of r2.dropped.filter((x) => x.ref)) expect(n.code).toBeTruthy();
  });
});

describe('peopleWords', () => {
  it('their names as What I know says them, with the verb agreeing', () => {
    expect(peopleWords('Adult 1 has no bed in Main bedroom.', couple)).toBe(
      'You have no bed in Main bedroom.',
    );
    expect(peopleWords('Adult 2 has no bed.', couple)).toBe('Partner has no bed.');
    // A name they gave is in the check's own words already, and stays.
    const named = { ...couple, names: { 'adult-1': 'Rachel' } };
    expect(peopleWords('Rachel has no bed. Adult 2 has no bed.', named)).toBe(
      'Rachel has no bed. Partner has no bed.',
    );
  });
});

describe('the card’s lead and the app’s lines (criterion 8’s copy)', () => {
  const room = (rounds: FixRound[], fixes = rounds.length, fixed = 0, key = 'k') => ({
    key,
    name: key === 'k' ? 'Main bedroom' : 'Living room',
    fixes,
    fixed,
    rounds,
  });

  it('a fix line whenever a round ran: fixed, cut off, no better, used up', () => {
    expect(leadLine([room([{ outcome: 'fixed', before: 3, after: 0 }])], 0)).toBe(
      'Checked and fixed 3 problems before showing you.',
    );
    // The fix sentence and the count apart (the count alone is set heavier).
    expect(leadParts([room([{ outcome: 'fixed', before: 3, after: 1 }])], 2)).toEqual({
      fix: 'Checked and fixed 2 problems before showing you.',
      count: '2 still don’t pass:',
    });
    expect(leadLine([room([{ outcome: 'cut-off', before: 4, after: 4 }])], 4)).toBe(
      'Sent back to be fixed once, but the answer was cut off at the length limit and wasn’t used. 4 still don’t pass:',
    );
    expect(leadLine([room([{ outcome: 'no-better', before: 2, after: 2 }])], 2)).toBe(
      'Sent back to be fixed once. The answer was no better, so the first design is shown. 2 still don’t pass:',
    );
    expect(
      leadLine(
        [
          room([{ outcome: 'fixed', before: 3, after: 2 }]),
          room([{ outcome: 'no-better', before: 2, after: 2 }], 1, 0, 'k2'),
          room([{ outcome: 'no-fixups', before: 1, after: 1 }], 0, 0, 'k3'),
        ],
        5,
      ),
    ).toBe(
      'Checked and fixed 1 problem before showing you. This design used the 2 fix-ups it was priced for. 5 still don’t pass:',
    );
    expect(leadLine([room([{ outcome: 'failed', before: 1, after: 1 }])], 1)).toMatch(
      /^Sent back to be fixed once, but no readable answer came/,
    );
    // A refusal or a busy provider is said as that, never as "no readable answer".
    expect(leadLine([room([{ outcome: 'refused', before: 1, after: 1 }])], 1)).toMatch(
      /but the model declined, so the first design is shown/,
    );
    expect(leadLine([room([{ outcome: 'error', before: 1, after: 1 }])], 1)).toMatch(
      /but the request didn’t go through/,
    );
    // Rooms, counted as rooms.
    expect(
      leadLine(
        [
          room([{ outcome: 'no-better', before: 2, after: 2 }]),
          room([{ outcome: 'no-better', before: 1, after: 1 }], 1, 0, 'k2'),
        ],
        3,
      ),
    ).toBe(
      'Sent 2 rooms back to be fixed. Neither answer was better, so the first designs are shown. 3 still don’t pass:',
    );
    // A record kept before rounds were stored: never a claim it can't back.
    expect(leadLine([room([], 1, 0)], 1)).toBe(
      'Sent back to be fixed once; nothing was fixed, so the first design is shown. 1 still doesn’t pass:',
    );
    expect(leadLine([room([], 1, 1)], 0)).toBe('Checked and fixed 1 problem before showing you.');
    // No rounds: just the count; nothing failing either: no lead at all.
    expect(leadLine([room([], 0)], 2)).toBe('2 don’t pass:');
    expect(leadLine([room([], 0)], 0)).toBeNull();
  });

  it('How it was checked, room by room', () => {
    expect(
      roundLines([
        room([
          { outcome: 'fixed', before: 3, after: 1 },
          { outcome: 'no-better', before: 1, after: 2 },
        ]),
      ]),
    ).toEqual(['Main bedroom · fix round 1: 3 → 1 problem · fix round 2: no better, not used']);
    // The second look's round is its own: named so, and never one of the room's tries.
    expect(
      roundLines([
        room([
          { outcome: 'no-better', before: 2, after: 2 },
          { outcome: 'fixed', before: 1, after: 0, by: 'look' },
        ]),
      ]),
    ).toEqual([
      'Main bedroom · fix round 1: no better, not used · the second look’s round: 1 → 0 problems',
    ]);
    expect(roundLines([room([{ outcome: 'no-fixups', before: 1, after: 1, by: 'look' }])])).toEqual(
      ['Main bedroom · not sent back after the second look: the run’s fix-ups were used up'],
    );
    expect(leadLine([room([{ outcome: 'no-better', before: 1, after: 1, by: 'look' }])], 1)).toBe(
      'Sent back to be fixed after the second look. The answer was no better, so the first design is shown. 1 still doesn’t pass:',
    );
    expect(
      leadLine(
        [
          room([
            { outcome: 'no-better', before: 1, after: 1 },
            { outcome: 'no-better', before: 1, after: 1, by: 'look' },
          ]),
        ],
        1,
      ),
    ).toBe(
      'Sent back to be fixed once, and after the second look. The last answer was no better, so the earlier one is shown. 1 still doesn’t pass:',
    );
  });

  it('the announcement and the line in place of an emptied reply, from the one list', () => {
    const { d, r } = fixture();
    const rep = runReport(r, d, { aliases });
    expect(readyLine('V8', rep, 'US$0.31')).toBe(
      'V8 is ready. 2 don’t pass: You and Partner have no bed in Master bedroom, and 1 more. Cost US$0.31.',
    );
    expect(reportLine('V8', rep)).toBe(
      'V8: 2 don’t pass. You and Partner have no bed in Master bedroom, and 1 more.',
    );
    const passing = {
      failures: [],
      leftOut: [],
      rooms: [room([{ outcome: 'fixed', before: 3, after: 0 }])],
    };
    expect(readyLine('V8', passing, null)).toBe(
      'V8 is ready. Passes all checks; the app fixed 3 problems first.',
    );
    // A decimal point never cuts the line short.
    const walk = runReport(
      { ...r, checks: [fake('P3|walkway|x|main', 'The way is 0.85 m: it needs 0.90 m.')] },
      d,
    );
    expect(firstAndMore(walk)).toBe('The way is 0.85 m');
  });

  it('what the design set out to fix: done when no failure of that signature is left', () => {
    const { d, r } = fixture();
    const rep = runReport(r, d, { aliases });
    const f1 = rep.failures[0];
    const l2 = rep.leftOut[1];
    if (!f1 || !l2) throw new Error('fixture');
    const rows = addressedIn(
      [
        { id: 'F1', sig: f1.sig, says: f1.says, change: 'a queen bed against the long wall' },
        {
          id: 'F9',
          sig: 'P1|desks|rm_bedroom|',
          says: 'Bedroom has 0 desks',
          change: 'a desk',
        },
        { id: 'L2', sig: leftSig(l2), says: l2.says, change: 'a 3-seat sofa' },
      ],
      rep,
    );
    expect(rows.map((x) => [x.done, x.left])).toEqual([
      [false, false],
      [true, false],
      [false, true],
    ]);
    // A piece left out, named by the failure it caused: never "Fixed" while that failure
    // stands, even when the next answer simply leaves the piece out of its list.
    const l1 = tableEntries(rep).find((e) => e.id === 'L1');
    if (!l1) throw new Error('fixture');
    expect(l1.sig.split(' ')).toEqual([
      'L|rm_main-bedroom|bed-queen',
      'P1|bed|rm_main-bedroom|adult-1',
      'P1|bed|rm_main-bedroom|adult-2',
    ]);
    const asL = { ...l1, change: 'a new queen bed' };
    const bedStillOut = { ...rep, leftOut: [] };
    expect(addressedIn([asL], bedStillOut)[0]?.done).toBe(false);
    expect(addressedIn([asL], { ...rep, leftOut: [], failures: [] })[0]?.done).toBe(true);
    // Half of the couple still without a bed: not done.
    const half = runReport(r, d, { waived: ['P1|bed|rm_main-bedroom|adult-1'] });
    expect(addressedIn([{ id: 'F1', sig: f1.sig, says: '', change: '' }], half)[0]?.done).toBe(
      false,
    );
  });
});

describe('a fix round’s prompt (criterion 4)', () => {
  it('lists the space’s left-out pieces with their reasons and hints, as well as the failing checks', () => {
    const { d, r } = fixture();
    const rep = runReport(r, d, { aliases, spaces: [SAMPLE_KEYS.main] });
    const main = spacesOf(r.level).find((s) => s.key === SAMPLE_KEYS.main);
    if (!main) throw new Error('sample');
    const p = roomStep(
      { base: level, before: level, brief: couple, aliases },
      main,
      r.level,
      aliases,
      {
        concept: sampleConcept(),
        fix: {
          round: 1,
          failures: rep.failures.map((f) => ({ ref: null, text: f.text })),
          leftOut: leftOutLines(rep),
        },
      },
    );
    expect(p.tail).toContain('## Fix round 1');
    expect(p.tail).toContain('"Adult 1 and Adult 2 have no bed in Master bedroom."');
    expect(p.tail).toContain('Pieces of your answer the app left out, with why and how to fix it');
    expect(p.tail).toContain('L1 left out · Master bedroom · bed1 (bed-queen)');
    expect(p.tail).toContain('Place a new `bed-queen` with keep: null');
    expect(p.tail).not.toContain('L2 left out');
    expect(p.tail).toContain('never drop a bed, seat, table or desk the room needs');
  });

  it('is bounded: at most 8 failures and 8 pieces left out, whatever comes', () => {
    const { r } = fixture();
    const main = spacesOf(r.level).find((s) => s.key === SAMPLE_KEYS.main);
    if (!main) throw new Error('sample');
    const p = roomStep(
      { base: level, before: level, brief: couple, aliases },
      main,
      r.level,
      aliases,
      {
        concept: sampleConcept(),
        fix: {
          round: 1,
          failures: Array.from({ length: 12 }, (_, i) => ({ ref: null, text: `Failure ${i + 1}` })),
          leftOut: Array.from({ length: 12 }, (_, i) => `L${i + 1} left out`),
        },
      },
    );
    expect(p.tail).toContain('"Failure 8"');
    expect(p.tail).not.toContain('"Failure 9"');
    expect(p.tail).toContain('"L8 left out"');
    expect(p.tail).not.toContain('"L9 left out"');
  });
});
