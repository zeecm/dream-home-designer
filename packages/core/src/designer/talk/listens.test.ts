import { describe, expect, it } from 'vitest';
import { sampleFlatProject } from '../../fixtures/sampleFlat';
import type { Level } from '../../schema';
import { aliasesFor } from '../aliases';
import { defaultBrief } from '../schema';
import { spacesOf } from '../spaces';
import { REPLY_PLAN, REPLY_TEXT } from './fixtures/replies';
import { TALK_SYSTEM, echoOf, eventsSince, sentText, tableLines, talkPrompt } from './prompt';
import { talk } from './reducer';
import {
  TALK_SCHEMA,
  type TalkParseContext,
  aboutTheApp,
  cantClaim,
  filterClaims,
  parseTalkReply,
} from './reply';
import type { Conversation } from './schema';

/**
 * The designer listens, PR A (spec docs/specs/designer-listens.md, criteria 2, 3, 5, 6, 7): the
 * talk call is told what the app found, the prompt tells the truth about the app, the claims
 * filter takes out "I can't check" and nothing else, and a plan says what it fixes.
 */

const project = sampleFlatProject('prj_l');
const level = project.levels[0] as Level;
const aliases = aliasesFor(level);
const AT = '2026-11-14T10:00:00.000Z';
let n = 0;
const id = () => `l${++n}`;
const ctx = (table?: TalkParseContext['table']): TalkParseContext => ({
  aliases,
  spaces: spacesOf(level).map((s) => ({ key: s.key, name: s.name, rooms: s.rooms })),
  walls: 'allowed',
  ...(table ? { table } : {}),
});

function met(): Conversation {
  const c = talk({} as Conversation, {
    type: 'start',
    id: 'conv1',
    at: AT,
    projectId: 'prj_l',
    levelId: level.id,
    brief: { ...defaultBrief(), walls: 'allowed' },
    beforeFp: 'fp0',
    afterFp: null,
    nextN: 1,
    level,
    form: null,
    ids: [id(), id()],
  });
  return talk(c, { type: 'justDesign', at: AT, ids: [id(), id()], level });
}

function exchange(c: Conversation, message: string, raw: unknown): Conversation {
  const pid = id();
  let next = talk(c, {
    type: 'send',
    id: pid,
    at: AT,
    text: message,
    sent: sentText(message, eventsSince(c)),
  });
  const r = parseTalkReply(raw, ctx());
  if (!r.ok) throw new Error(r.error);
  next = talk(next, {
    type: 'replyDone',
    turnId: pid,
    id: id(),
    at: AT,
    reply: r.reply,
    lines: r.lines,
    echo: echoOf(r.reply),
    usage: [],
    probe: null,
    ids: Array.from({ length: 8 }, id),
    fold: null,
  });
  return next;
}

const F = [
  'F1 doesn’t pass · Main bedroom (R2): Adult 1 has no bed in Main bedroom.',
  'F2 doesn’t pass · Main bedroom (R2): Adult 2 has no bed in Main bedroom.',
];
const L = [
  'L1 left out · Main bedroom · bed1 (bed-queen): “bed1”: there’s no piece “P7” in the flat. To fix: P7 isn’t in the plan this design starts from. Place a new `bed-queen` with keep: null, or keep a piece listed in The flat now.',
  'L2 left out · Main bedroom · desk2 (desk): Left out the desk: no wall or spot in the room has room for it. To fix: Needs 1.20 m of wall; the longest free run in R2 is 0.90 m. Use a smaller piece, another room, or free-standing.',
];

describe('the talk call after a run (criteria 2, 3)', () => {
  const c = exchange(met(), 'Design the main bedroom', REPLY_TEXT);
  const build = (onTable: string[], events: string[] = eventsSince(c)) =>
    talkPrompt({
      conv: c,
      level,
      before: level,
      aliases,
      message: 'Where is the bed?',
      events,
      onTable,
    });

  it('the F and L lines are in On the table; the history’s bytes are those of before the run', () => {
    const before = build([]);
    const table = tableLines('V6 · Main bedroom: 2 don’t pass', [], [], {
      failures: F,
      leftOut: L,
    });
    const after = build(table);
    const last =
      after.messages
        .at(-1)
        ?.blocks.map((b) => b.text)
        .join('') ?? '';
    const onTable = last.slice(last.indexOf('## On the table (data)'));
    for (const l of [...F, ...L]) expect(onTable).toContain(JSON.stringify(l));
    expect(onTable).not.toContain("Doesn't pass (the app's words)");
    // The history (every message but the last) is byte for byte the same: the cache holds.
    expect(JSON.stringify(after.messages.slice(0, -1))).toBe(
      JSON.stringify(before.messages.slice(0, -1)),
    );
    expect(after.system).toBe(before.system);
  });

  it('at most 8 F and 8 L lines', () => {
    const many = (p: string) => Array.from({ length: 12 }, (_, i) => `${p}${i + 1} x`);
    const t = tableLines('V6', [], [], { failures: many('F'), leftOut: many('L') });
    expect(t.filter((x) => x.startsWith('F')).length).toBe(8);
    expect(t.filter((x) => x.startsWith('L')).length).toBe(8);
  });

  it('Since your last reply carries the verdict, frozen into the message at Send', () => {
    const p = build(
      [],
      ['V6 (Main bedroom, and Living room): designed; 2 don’t pass, 2 pieces left out.'],
    );
    expect(p.sent).toContain(
      JSON.stringify(
        'V6 (Main bedroom, and Living room): designed; 2 don’t pass, 2 pieces left out.',
      ),
    );
  });
});

describe('TALK_SYSTEM tells the truth about the app (criterion 5)', () => {
  it('no "it, not you" framing; how the app works, and the rules of §2', () => {
    expect(TALK_SYSTEM).not.toContain('not you, says whether something passes');
    expect(TALK_SYSTEM).toContain(
      'How the app works (fact): once they approve a plan, the app places the pieces you design and runs every check',
    );
    expect(TALK_SYSTEM).toContain('before they see the design');
    expect(TALK_SYSTEM).toContain('up to the fix rounds the design was priced for');
    expect(TALK_SYSTEM).toMatch(/never say you can.t see, run or act on the checks/);
    expect(TALK_SYSTEM).toContain('Apologise at most once');
    expect(TALK_SYSTEM).toMatch(/don.t promise "no problems"/);
    expect(TALK_SYSTEM).toContain('plan.addresses');
    // Only what this build does (lead blocker 5): B1 places missing essentials itself and
    // vets rooms; "as many rounds as the price allows" waits for B2.
    expect(TALK_SYSTEM).toContain('the app places the missing piece itself, free');
    expect(TALK_SYSTEM).toContain('A room where someone sleeps stays a bedroom');
    expect(TALK_SYSTEM).not.toMatch(/as many rounds/i);
    expect(TALK_SYSTEM).toMatchSnapshot();
  });

  it('the task asks for notes on work the app doesn’t cover, and for addresses', () => {
    const c = met();
    const p = talkPrompt({
      conv: c,
      level,
      before: level,
      aliases,
      message: 'Hi',
      events: [],
      onTable: [],
    });
    const last =
      p.messages
        .at(-1)
        ?.blocks.map((b) => b.text)
        .join('') ?? '';
    expect(last).not.toContain('what the app can’t do');
    expect(last).not.toContain("what the app can't do");
    expect(last).toContain(
      "notes for their ID about work the app doesn't cover (beams, plumbing, curtains, products)",
    );
    expect(last).toContain('"addresses"');
    const plan = (
      TALK_SCHEMA.properties.plan as { anyOf: { properties?: Record<string, unknown> }[] }
    ).anyOf[0]?.properties;
    expect(Object.keys(plan ?? {})).toContain('addresses');
  });

  it('a stored note about the app is never sent again', () => {
    const c: Conversation = {
      ...met(),
      notes: [
        {
          id: 'n1',
          text: 'Explained that the app handles the placement and checks directly, which cannot be hidden.',
          turnId: 't',
        },
        { id: 'n2', text: 'Beam over the dining table: ask the ID for its depth.', turnId: 't' },
      ],
    };
    const p = talkPrompt({
      conv: c,
      level,
      before: level,
      aliases,
      message: 'Hi',
      events: [],
      onTable: [],
    });
    const last =
      p.messages
        .at(-1)
        ?.blocks.map((b) => b.text)
        .join('') ?? '';
    expect(last).not.toContain('cannot be hidden');
    expect(last).toContain('Beam over the dining table');
  });
});

describe('the claims filter (criterion 6, as the lead fixed it)', () => {
  const BANNED = [
    // The owner's export.
    "I don't have the ability to run them in the background and fix them before you see the results.",
    'I don’t have the ability to run the checks before you see the results.',
    // Variants.
    'I can’t run the checks myself.',
    "I'm not able to fix the problems before you see them.",
    'Unfortunately, I cannot see the checks the app runs.',
    'I do not have access to the check results.',
    // QA M2: verify governed by the inability.
    'I am not able to verify the design.',
    'I can’t check whether it passes before you see it.',
    'I can’t verify it.',
    // A decimal point inside a removed sentence doesn't split it.
    'I can’t run the checks on the 0.9 m walkway before you see it.',
  ];
  const KEPT = [
    'The app’s checks found 4 problems.',
    'The app measured 0.85 m behind the sofa.',
    'I’ll move the desk to W3.',
    // True, in the third person: kept (blame is a voice rule for the prompt, not the filter).
    'The app itself places the items and runs the checks.',
    'The app removed the bed because it doesn’t allow sleeping furniture in Living & Study.',
    // Honest limits that aren't about the checks.
    'I can’t fit a king bed in Main bedroom: it’s 2.8 m wide.',
    'I can’t see a way to fit both desks, so one goes in the living room.',
    // The tech lead's probes: a decimal, a claim of a fit (not of checking), "e.g.".
    'The 0.9 m walkway stays clear.',
    'I can’t get both desks in without failing the checks: the room is 3.1 m wide.',
    'A smaller piece, e.g. a 1.2 m desk, fits under the window.',
    // What the app doesn't cover, said honestly.
    'I can’t check the beam depth from the plan; your ID should.',
    'I can’t check the lift size, so please measure it before ordering.',
    'I can’t verify the exact product dimensions of that IKEA sofa.',
    'I can’t test how the colour looks in your light.',
  ];

  it('takes out each banned sentence, and keeps the rest', () => {
    for (const b of BANNED) expect(cantClaim(b), b).toBe(true);
    for (const k of KEPT) expect(cantClaim(k), k).toBe(false);
  });

  it('the export’s reply: only the banned sentence goes', () => {
    const say =
      "I completely understand your frustration. As your designer, I suggest the layouts, but the app itself places the items and runs the checks. I don't have the ability to run them in the background and fix them before you see the results. I will add the queen bed back.";
    const out = filterClaims(say);
    expect(out.removed).toBe(1);
    expect(out.say).toBe(
      'I completely understand your frustration. As your designer, I suggest the layouts, but the app itself places the items and runs the checks. I will add the queen bed back.',
    );
    expect(filterClaims(KEPT.join(' '))).toEqual({ say: KEPT.join(' '), removed: 0 });
    // Never cut at a decimal point or after "e.g.": whole sentences stay whole, or go whole.
    const probes =
      'The 0.9 m walkway stays clear. I can’t get both desks in without failing the checks: the room is 3.1 m wide. A smaller piece, e.g. a 1.2 m desk, fits.';
    expect(filterClaims(probes)).toEqual({ say: probes, removed: 0 });
    expect(
      filterClaims(
        'I can’t run the checks on the 0.9 m walkway before you see it. I’ll widen it to 1.0 m.',
      ),
    ).toEqual({ say: 'I’ll widen it to 1.0 m.', removed: 1 });
    // "no" isn't an abbreviation: "I'd say no." stays a sentence of its own.
    expect(filterClaims('I’d say no. I can’t run the checks myself. The bed goes back.')).toEqual({
      say: 'I’d say no. The bed goes back.',
      removed: 1,
    });
    // Lines and paragraphs stay as they were.
    expect(filterClaims('First line.\nI can’t run the checks myself.\nLast line.').say).toBe(
      'First line.\nLast line.',
    );
  });

  it('criterion 10’s reply shows only “I’ll add the bed.”', () => {
    const r = parseTalkReply(
      { ...REPLY_TEXT, say: "I don't have the ability to run the checks. I'll add the bed." },
      ctx(),
    );
    expect(r.ok && r.reply.say).toBe("I'll add the bed.");
    expect(r.ok && r.reply.removed).toBe(1);
  });

  it('a reply cut off or kept from a closed tab is filtered too', () => {
    let c = met();
    c = talk(c, { type: 'send', id: 'p9', at: AT, text: 'Fix it', sent: sentText('Fix it', []) });
    const cut = talk(c, {
      type: 'replyCut',
      turnId: 'p9',
      ids: ['c1', 'c2'],
      at: AT,
      text: 'I can’t run the checks myself. I’ll add the bed',
      usage: [],
      cut: 'tab',
      line: 'Cut off.',
    });
    const said = cut.turns.find((t) => t.id === 'c1');
    expect(said?.kind === 'designer' && said.text).toBe('I’ll add the bed');
  });

  it('a reply that is only a banned claim still reads (no paid retry); its say is empty', () => {
    const r = parseTalkReply({ ...REPLY_TEXT, say: 'I can’t run the checks myself.' }, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reply.say).toBe('');
    expect(r.reply.removed).toBe(1);
    // Nothing said at all is still unreadable (and tried again), as before.
    expect(parseTalkReply({ ...REPLY_TEXT, say: '' }, ctx()).ok).toBe(false);
  });

  it('notes about the app, its checks or their mood are never saved', () => {
    const notes = [
      'Explained that the app handles the placement and checks directly, which cannot be hidden.',
      'Client is frustrated with the checks.',
      'Lighting design for the living room is for the ID.',
    ];
    const r = parseTalkReply({ ...REPLY_TEXT, memory: { ...REPLY_TEXT.memory, notes } }, ctx());
    expect(r.ok && r.reply.memory.notes).toEqual([
      'Lighting design for the living room is for the ID.',
    ]);
    expect(aboutTheApp('Plumbing move for the sink: needs a licensed plumber.')).toBe(false);
    // Notes for the ID that say "check" or "placement" stay.
    expect(aboutTheApp('Check beam height before hacking the wardrobe wall.')).toBe(false);
    expect(aboutTheApp('Power point placement behind the TV console.')).toBe(false);
    expect(aboutTheApp('The checks run after approval.')).toBe(true);
  });
});

describe('plan.addresses (criterion 7, core)', () => {
  const table: NonNullable<TalkParseContext['table']> = {
    title: 'V8',
    failing: 4,
    entries: [
      { id: 'F1', sig: 'P1|bed|rm_main-bedroom|adult-1', says: 'You have no bed in Main bedroom.' },
      {
        id: 'L1',
        sig: 'L|rm_main-bedroom|bed',
        says: 'The queen bed in Main bedroom was left out',
      },
    ],
  };

  it('read against the table: known ids kept with their signature and words, others dropped', () => {
    const r = parseTalkReply(
      {
        ...REPLY_PLAN,
        plan: {
          ...REPLY_PLAN.plan,
          addresses: [
            { id: 'F1', change: 'a queen bed against the long wall' },
            { id: 'f1', change: 'twice' },
            { id: 'F9', change: 'not on the table' },
            { id: 'L1', change: '' },
          ],
        },
      },
      ctx(table),
    );
    expect(r.ok && r.reply.plan?.addresses).toEqual([
      {
        id: 'F1',
        sig: 'P1|bed|rm_main-bedroom|adult-1',
        says: 'You have no bed in Main bedroom.',
        change: 'a queen bed against the long wall',
      },
    ]);
    expect(r.ok && r.reply.plan?.unaddressed).toBeUndefined();
  });

  it('a long signature is kept within the record, whole signatures only (never dropping it)', () => {
    const long = Array.from({ length: 30 }, (_, i) => `P2|belongs|rm_living|chair-${i}`).join(' ');
    const r = parseTalkReply(
      {
        ...REPLY_PLAN,
        plan: { ...REPLY_PLAN.plan, addresses: [{ id: 'F1', change: 'a table for the chairs' }] },
      },
      ctx({ title: 'V8', failing: 1, entries: [{ id: 'F1', sig: long, says: 'Chairs' }] }),
    );
    const sig = r.ok ? (r.reply.plan?.addresses?.[0]?.sig ?? '') : '';
    expect(sig.length).toBeLessThanOrEqual(300);
    expect(long.startsWith(sig)).toBe(true);
    expect(sig.endsWith('chair-')).toBe(false);
  });

  it('none after a failing design: the plan says so; no table, nothing either way', () => {
    const none = parseTalkReply(REPLY_PLAN, ctx(table));
    expect(none.ok && none.reply.plan?.unaddressed).toEqual({ title: 'V8', failing: 4 });
    expect(none.ok && none.reply.plan?.addresses).toBeUndefined();
    const plain = parseTalkReply(REPLY_PLAN, ctx());
    expect(plain.ok && plain.reply.plan?.unaddressed).toBeUndefined();
  });
});
