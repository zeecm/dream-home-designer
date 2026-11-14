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
  addressedIn,
  failureLines,
  leadLine,
  leftOutLines,
  leftSig,
  peopleWords,
  readyLine,
  reportLine,
  roundLines,
  runReport,
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
 * in the owner's V6 to V9), and a lamp that isn't in the catalogue. So 2 hard failures (neither
 * adult has a bed) and 2 pieces left out.
 */
function fixture(): { d: DesignInput; r: ReturnType<typeof designResult> } {
  const answers = sampleAnswers(level);
  const main = answers[SAMPLE_KEYS.main];
  const living = answers[SAMPLE_KEYS.living];
  if (!main || !living) throw new Error('sample answers');
  main.items = main.items.map((i) => (i.ref === 'bed1' ? { ...i, keep: 'P99' } : i));
  living.items = living.items.map((i) => (i.ref === 'lamp1' ? { ...i, assetId: 'lamp-999' } : i));
  const d = sampleDesign({ level, answers, brief: couple });
  return { d, r: designResult(level, level, d) };
}

describe('runReport (criterion 1)', () => {
  const { d, r } = fixture();
  const rep = runReport(r, d, { aliases });

  it('F1–F2: the room and the app’s words; L1–L2: ref, catalogue id, reason and hint', () => {
    expect(rep.failures.map((f) => f.id)).toEqual(['F1', 'F2']);
    expect(rep.failures.map((f) => f.text)).toEqual([
      'Adult 1 has no bed in Master bedroom.',
      'Adult 2 has no bed in Master bedroom.',
    ]);
    for (const f of rep.failures) {
      expect(f.roomId).toBe('rm_main-bedroom');
      expect(f.room).toBe('Master bedroom');
      // Across runs: principle, code, room and who (never an item id).
      expect(f.sig).toMatch(/^P1\|bed\|rm_main-bedroom\|adult-[12]$/);
    }
    expect(rep.leftOut.map((l) => [l.id, l.ref, l.assetId, l.code])).toEqual([
      ['L1', 'bed1', 'bed-queen', 'keep-missing'],
      ['L2', 'lamp1', 'lamp-999', 'not-catalogue'],
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
      'F1 doesn’t pass · Master bedroom (R2): Adult 1 has no bed in Master bedroom.',
      'F2 doesn’t pass · Master bedroom (R2): Adult 2 has no bed in Master bedroom.',
    ]);
    const l = leftOutLines(rep);
    expect(l[0]).toBe(
      'L1 left out · Master bedroom · bed1 (bed-queen): “bed1”: there’s no piece “P99” in the flat. To fix: P99 isn’t in the plan this design starts from. Place a new `bed-queen` with keep: null, or keep a piece listed in The flat now.',
    );
    for (const x of [...failureLines(rep, aliases), ...l])
      expect(x.length).toBeLessThanOrEqual(300);
    expect(rep.failures.map((f) => f.says)).toEqual([
      'You have no bed in Master bedroom.',
      'Partner has no bed in Master bedroom.',
    ]);
    // The missing bed's cause: the bed of that room the app left out, said without ids.
    expect(rep.failures[0]?.cause).toBe(
      'The designer kept a queen bed that isn’t in your plan, so it was left out.',
    );
    for (const f of rep.failures) {
      expect(`${f.says} ${f.cause}`).not.toMatch(/\b[WPRD]\d+\b|Adult \d/);
    }
  });

  it('a check on a piece names it by the answer’s ref, or by its short id for a plan piece', () => {
    const placed = Object.entries(r.refs).find(([, ref]) => ref === 'ward1')?.[0] ?? '';
    // A piece of the plan (not the answer's): named by the reader's short id.
    const planPiece = 'it_plan';
    const fake = (itemId: string, key: string): ResultCheck => ({
      key,
      principle: 'P3',
      hard: true,
      waivable: true,
      text: 'The way through is 0.70 m; it needs 0.90 m.',
      itemId,
      already: false,
      part: null,
    });
    const more = runReport(
      { ...r, checks: [...r.checks, fake(placed, `P3|walkway|${placed}|main`)] },
      d,
      {
        aliases: { ...aliases, P42: planPiece },
        extra: [fake(planPiece, `P3|walkway|${planPiece}|main`)],
      },
    );
    const byKey = new Map(more.failures.map((f) => [f.key, f]));
    expect(byKey.get(`P3|walkway|${placed}|main`)?.piece).toBe('ward1');
    expect(byKey.get(`P3|walkway|${placed}|main`)?.assetId).toBe('built-in-wardrobe');
    expect(byKey.get(`P3|walkway|${planPiece}|main`)?.piece).toBe('P42');
    // Waived checks aren't failures; a scope leaves the others out.
    expect(
      runReport(r, d, { waived: ['P1|bed|rm_main-bedroom|adult-1'] }).failures.map((f) => f.key),
    ).toEqual(['P1|bed|rm_main-bedroom|adult-2']);
    expect(runReport(r, d, { spaces: [SAMPLE_KEYS.living] }).leftOut.map((x) => x.ref)).toEqual([
      'lamp1',
    ]);
  });

  it('criterion 3: the digest’s verdict: “2 don’t pass, 2 pieces left out”, or “passes”', () => {
    expect(verdictWords(rep)).toBe('2 don’t pass, 2 pieces left out');
    const ok = runReport(designResult(level, level, sampleDesign({ level, brief: couple })), d);
    expect(verdictWords({ ...ok, leftOut: [] })).toBe('passes');
  });
});

describe('the hints by reason', () => {
  it('no wall long enough: the numbers when the room is short, else the walls went to others', () => {
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
    const short = runReport(note({ code: 'no-wall', need: 2.1, longest: 1.8 }), d, { aliases });
    expect(short.leftOut[0]?.hint).toBe(
      'Needs 2.10 m of wall; the longest free run in R3 is 1.80 m. Use a smaller piece, another room, or free-standing.',
    );
    expect(short.leftOut[0]?.cause).toBe(
      'The 3-seat sofa needs 2.10 m of wall; the longest free wall in Living and dining is 1.80 m.',
    );
    const taken = runReport(note({ code: 'no-wall', need: 2.1, longest: 3.4 }), d, { aliases });
    expect(taken.leftOut[0]?.hint).toMatch(/^Needs 2\.10 m of wall; the walls long enough went/);
    const nowhere = runReport(note({ code: 'no-place' }), d, { aliases });
    expect(nowhere.leftOut[0]?.hint).toBe(
      'It had no spot inside R3. Give it `against`, or put it in another room.',
    );
    const brief = runReport(note({ code: 'keep-in-place' }), d, { aliases });
    expect(brief.leftOut[0]?.hint).toMatch(/^The brief says this piece stays where it is/);
  });

  it('the solver’s drop carries its code and numbers (a bed on a wall too short)', () => {
    const answers = sampleAnswers(level);
    const main = answers[SAMPLE_KEYS.main];
    if (!main) throw new Error('sample');
    // Three king beds: the room can hold one at most.
    main.items = [
      ...main.items,
      ...[2, 3].map((k) => ({ ...(main.items[0] as (typeof main.items)[number]), ref: `bed${k}` })),
    ];
    const d = sampleDesign({ level, answers, brief: couple });
    const r = designResult(level, level, d);
    const dropped = r.dropped.filter((n) => n.ref?.startsWith('bed'));
    expect(dropped.length).toBeGreaterThan(0);
    for (const n of dropped) expect(n.code).toMatch(/^(no-wall|no-place)$/);
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
  const room = (rounds: FixRound[], fixes = rounds.length, fixed = 0) => ({
    key: 'k',
    name: 'Main bedroom',
    fixes,
    fixed,
    rounds,
  });

  it('a fix line whenever a round ran: fixed, cut off, no better, used up', () => {
    expect(leadLine([room([{ outcome: 'fixed', before: 3, after: 0 }])], 0)).toBe(
      'Checked and fixed 3 problems before showing you.',
    );
    expect(leadLine([room([{ outcome: 'fixed', before: 3, after: 1 }])], 2)).toBe(
      'Checked and fixed 2 problems before showing you. 2 still don’t pass:',
    );
    expect(leadLine([room([{ outcome: 'cut-off', before: 4, after: 4 }])], 4)).toBe(
      'Sent back to be fixed, but the answer was cut off at the length limit and wasn’t used. 4 still don’t pass:',
    );
    expect(leadLine([room([{ outcome: 'no-better', before: 2, after: 2 }])], 2)).toBe(
      'Sent back to be fixed once. The answer was no better, so the first one is shown. 2 still don’t pass:',
    );
    expect(
      leadLine(
        [
          room([{ outcome: 'fixed', before: 3, after: 2 }]),
          { ...room([{ outcome: 'no-better', before: 2, after: 2 }]), key: 'k2' },
          { ...room([{ outcome: 'no-fixups', before: 1, after: 1 }], 0), key: 'k3' },
        ],
        5,
      ),
    ).toBe(
      'Checked and fixed 1 problem before showing you. This design used the 2 fix-ups it was priced for. 5 still don’t pass:',
    );
    expect(leadLine([room([{ outcome: 'failed', before: 1, after: 1 }])], 1)).toMatch(
      /^Sent back to be fixed, but no readable answer came/,
    );
    // Never silent when nothing was fixed, even from a record kept before rounds were.
    expect(leadLine([room([], 2, 0)], 1)).toBe(
      'Sent back to be fixed 2 times. The last answer was no better, so the earlier one is shown. 1 still doesn’t pass:',
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
          { outcome: 'cut-off', before: 1, after: 1 },
        ]),
      ]),
    ).toEqual([
      'Main bedroom · fix round 1: 3 → 1 problem · fix round 2: cut off at the length limit, not used',
    ]);
  });

  it('the announcement and the line in place of an emptied reply, from the one list', () => {
    const { d, r } = fixture();
    const rep = runReport(r, d, { aliases });
    expect(readyLine('V8', rep, 'US$0.31')).toBe(
      'V8 is ready. 2 don’t pass: You have no bed in Master bedroom, and 1 more. Cost US$0.31.',
    );
    expect(reportLine('V8', rep)).toBe(
      'V8: 2 don’t pass. You have no bed in Master bedroom, and 1 more.',
    );
    const passing = {
      failures: [],
      leftOut: [],
      rooms: [room([{ outcome: 'fixed', before: 3, after: 0 }])],
    };
    expect(readyLine('V8', passing, null)).toBe(
      'V8 is ready. Passes all checks; the app fixed 3 problems first.',
    );
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
          sig: 'P1|seats|rm_living-and-dining|',
          says: 'The living room seats 0',
          change: 'a sofa',
        },
        { id: 'L2', sig: leftSig(l2), says: l2.says, change: 'a floor lamp' },
      ],
      rep,
    );
    expect(rows.map((x) => x.done)).toEqual([false, true, false]);
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
    expect(p.tail).toContain('"Adult 1 has no bed in Master bedroom."');
    expect(p.tail).toContain('Pieces of your answer the app left out, with why and how to fix it');
    expect(p.tail).toContain('L1 left out · Master bedroom · bed1 (bed-queen)');
    expect(p.tail).toContain('Place a new `bed-queen` with keep: null');
    expect(p.tail).not.toContain('lamp1');
    expect(p.tail).toContain('never drop a bed, seat, table or desk the room needs');
  });
});
