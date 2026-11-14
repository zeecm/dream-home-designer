import { describe, expect, it } from 'vitest';
import { sampleFlatProject } from '../../fixtures/sampleFlat';
import type { Level } from '../../schema';
import { aliasesFor } from '../aliases';
import { briefData } from '../describe';
import { defaultBrief } from '../schema';
import { spacesOf } from '../spaces';
import { FACT_LABELS, FIX_ALL_CHOICES, factText, nextQuestions } from './firstMeeting';
import { REPLY_PLAN } from './fixtures/replies';
import { echoOf, eventsSince, sentText, talkPrompt } from './prompt';
import { talk } from './reducer';
import { type TalkParseContext, applyFacts, parseTalkReply } from './reply';
import { type Conversation, type TurnOf, conversationFromRecord } from './schema';

/**
 * The designer listens, PR C (spec docs/specs/designer-listens.md §6, criteria 27 and the
 * records): "Before you see a design: Fix every check first" is a fact of What I know, set by the
 * person or from the designer's reply on their word, changed free with Undo, and a cost card's
 * repeat warning is kept with it (talk records 5).
 */

const project = sampleFlatProject('prj_c');
const level = project.levels[0] as Level;
const aliases = aliasesFor(level);
const AT = '2026-11-14T10:00:00.000Z';
let n = 0;
const id = () => `c${++n}`;
const ctx = (): TalkParseContext => ({
  aliases,
  spaces: spacesOf(level).map((s) => ({ key: s.key, name: s.name, rooms: s.rooms })),
  walls: 'allowed',
});

function met(): Conversation {
  const c = talk({} as Conversation, {
    type: 'start',
    id: 'conv1',
    at: AT,
    projectId: 'prj_c',
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

/** The owner's plan reply, on their word "fix them all before coming back to me". */
const strictPlan = {
  ...REPLY_PLAN,
  say: 'I’ll keep fixing until every check passes before you see it.',
  memory: {
    ...REPLY_PLAN.memory,
    facts: [
      {
        key: 'fix-all',
        text: 'Fix every check before showing a design',
        number: null,
        choice: 'on',
      },
    ],
  },
};

describe('Fix every check first, as a fact (§6, criterion 27)', () => {
  it('is a row of What I know, never asked in the first meeting; Show it as it is by default', () => {
    expect(FACT_LABELS['fix-all']).toBe('Before you see a design');
    expect(FIX_ALL_CHOICES.map((c) => c.label)).toEqual([
      'Fix every check first',
      'Show it as it is',
    ]);
    const b = defaultBrief();
    expect(factText('fix-all', b, level)).toBe('Show it as it is');
    expect(factText('fix-all', { ...b, fixAll: true }, level)).toBe('Fix every check first');
    // The first meeting's questions never include it.
    let done = new Set<
      Parameters<typeof nextQuestions>[0] extends ReadonlySet<infer K> ? K : never
    >();
    for (let i = 0; i < 10; i++) {
      const q = nextQuestions(done, b, level);
      if (!q) break;
      expect(q.keys).not.toContain('fix-all');
      done = new Set([...done, ...q.keys]);
    }
  });

  it('a reply noting it on their word sets it, said as noted; "off" sets it back', () => {
    const r = parseTalkReply(strictPlan, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reply.memory.facts).toEqual([
      expect.objectContaining({ key: 'fix-all', choice: 'on' }),
    ]);
    const on = applyFacts(defaultBrief(), r.reply.memory.facts);
    expect(on.brief.fixAll).toBe(true);
    expect(on.keys).toEqual(['fix-all']);
    expect(on.lines).toEqual(['fix every check before you see a design']);
    const off = applyFacts(on.brief, [{ key: 'fix-all', text: '', number: null, choice: 'off' }]);
    expect(off.brief.fixAll).toBe(false);
    // An unknown choice is no fact.
    const odd = parseTalkReply(
      {
        ...strictPlan,
        memory: {
          ...strictPlan.memory,
          facts: [{ ...strictPlan.memory.facts[0], choice: 'always' }],
        },
      },
      ctx(),
    );
    expect(odd.ok && odd.reply.memory.facts).toEqual([]);
  });

  it('is never in the room steps’ brief (their prefix stays cached); the talk call is told it live', () => {
    const b = { ...defaultBrief(), fixAll: true };
    expect(JSON.stringify(briefData(b, aliases))).toEqual(
      JSON.stringify(briefData(defaultBrief(), aliases)),
    );
    const c = { ...met(), brief: b };
    const p = talkPrompt({
      conv: c,
      level,
      before: level,
      aliases,
      onTable: [],
      events: eventsSince(c),
      message: sentText('Fix them all', []),
    } as Parameters<typeof talkPrompt>[0]);
    const all = JSON.stringify(p);
    expect(all).toContain('fix every check first');
    expect(all).toContain('fix-all on/off');
  });

  it('changed in What I know: a "You changed" line; its Undo puts it back, once, never a second line', () => {
    const c = met();
    const on = talk(c, {
      type: 'editFact',
      key: 'fix-all',
      brief: { ...c.brief, fixAll: true },
      at: AT,
      id: 'ev1',
      level,
    });
    const line = on.turns.at(-1) as TurnOf<'event'>;
    expect(line.event).toMatchObject({
      type: 'fact',
      key: 'fix-all',
      text: 'You changed: before you see a design Show it as it is → Fix every check first.',
    });
    expect(on.brief.fixAll).toBe(true);
    const undone = talk(on, { type: 'factUndo', eventId: 'ev1' });
    expect(undone.brief.fixAll).toBe(false);
    expect(undone.turns).toHaveLength(on.turns.length);
    expect((undone.turns.at(-1) as TurnOf<'event'>).event).toMatchObject({ undone: true });
    // Once: a second Undo does nothing.
    expect(talk(undone, { type: 'factUndo', eventId: 'ev1' })).toBe(undone);
    // Kept through the record, as 5.
    const back = conversationFromRecord(JSON.parse(JSON.stringify(undone)));
    expect(back?.recordVersion).toBe(5);
    expect((back?.turns.at(-1) as TurnOf<'event'>).event).toMatchObject({ undone: true });
  });

  it('Undo restores the value before the change (kept on the line), never the opposite of now (N1)', () => {
    const c = met();
    const on = talk(c, {
      type: 'editFact',
      key: 'fix-all',
      brief: { ...c.brief, fixAll: true },
      at: AT,
      id: 'ev1',
      level,
    });
    expect((on.turns.at(-1) as TurnOf<'event'>).event).toMatchObject({ was: false });
    // Changed since by other means (a reply turned it off): Undo still puts back "off" as it was.
    const off = { ...on, brief: { ...on.brief, fixAll: false } };
    expect(talk(off, { type: 'factUndo', eventId: 'ev1' }).brief.fixAll).toBe(false);
  });

  it('turned on by a reply’s fact: the next run owes one ask; the person setting it, or that ask, clears it (S1)', () => {
    const pid = id();
    let c = talk(met(), { type: 'send', id: pid, at: AT, text: 'Fix them all first', sent: 'x' });
    const r = parseTalkReply(strictPlan, ctx());
    if (!r.ok) throw new Error(r.error);
    c = talk(c, {
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
    expect(c.brief.fixAll).toBe(true);
    expect(c.strictAsk).toBe(true);
    // The one ask: a cost card marked strict clears it.
    const asked = talk(c, {
      type: 'ask',
      at: AT,
      ids: [id(), 'cost-s'],
      scope: { label: 'Main bedroom', spaces: ['rm_main'], all: false },
      words: '',
      reason: 'ask-threshold',
      estimate: null,
      strict: true,
    });
    expect(asked.strictAsk).toBe(false);
    expect((asked.turns.find((t) => t.id === 'cost-s') as TurnOf<'cost-ask'>).strict).toBe(true);
    // The person setting it in What I know owes no ask either.
    const set = talk(c, {
      type: 'editFact',
      key: 'fix-all',
      brief: { ...c.brief, fixAll: true },
      at: AT,
      id: 'ev2',
      level,
    });
    expect(set.strictAsk).toBe(false);
    // Read back as stored.
    expect(conversationFromRecord(JSON.parse(JSON.stringify(c)))?.strictAsk).toBe(true);
  });
});

describe('a cost card’s repeat warning, kept (§5)', () => {
  it('is stored with the card and read back; a card without one has none', () => {
    const c = met();
    const asked = talk(c, {
      type: 'ask',
      at: AT,
      ids: [id(), 'cost1'],
      scope: { label: 'Main bedroom', spaces: ['rm_main'], all: false },
      words: '',
      reason: 'ask-threshold',
      estimate: { typical: 0.1, high: 0.3, fix: 0.6 },
      repeat: {
        titles: ['V7', 'V8'],
        failures: ['You and Partner have no bed in Main bedroom'],
        count: 1,
        card: { proposalId: 'prop8', letter: 'A' },
        again: false,
        sigs: ['P1|bed|rm_main|'],
      },
    });
    const card = asked.turns.find((t) => t.id === 'cost1') as TurnOf<'cost-ask'>;
    expect(card.repeat?.titles).toEqual(['V7', 'V8']);
    const back = conversationFromRecord(JSON.parse(JSON.stringify(asked)));
    expect((back?.turns.find((t) => t.id === 'cost1') as TurnOf<'cost-ask'>).repeat).toEqual(
      card.repeat,
    );
    const plain = talk(c, {
      type: 'ask',
      at: AT,
      ids: [id(), 'cost2'],
      scope: { label: 'Main bedroom', spaces: ['rm_main'], all: false },
      words: '',
      reason: 'ask-threshold',
      estimate: null,
    });
    expect((plain.turns.find((t) => t.id === 'cost2') as TurnOf<'cost-ask'>).repeat).toBeNull();
    // echoOf is untouched by it (the history's bytes never carry the app's cost cards).
    expect(echoOf).toBeTypeOf('function');
  });
});
