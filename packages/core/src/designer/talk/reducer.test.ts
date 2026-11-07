import { describe, expect, it } from 'vitest';
import { sampleFlatProject } from '../../fixtures/sampleFlat';
import type { Level } from '../../schema';
import { tanBrief } from '../fixtures/sample';
import { type DesignBrief, defaultBrief } from '../schema';
import {
  assume,
  bedroomsOf,
  factText,
  greeting,
  nextQuestions,
  sleepingConflict,
} from './firstMeeting';
import { type TalkAction, doneKeys, meetingOver, openQuestions, talk } from './reducer';
import { type Conversation, type QuestionKey, type TurnOf, conversationFromRecord } from './schema';

const level = () => sampleFlatProject().levels[0] as Level;
const AT = '2026-11-07T10:00:00.000Z';
let n = 0;
const id = () => `t${++n}`;

function start(brief: DesignBrief = defaultBrief(), form: { at: string } | null = null) {
  return talk({} as Conversation, {
    type: 'start',
    id: 'conv1',
    at: AT,
    projectId: 'p1',
    levelId: 'lvl',
    brief,
    beforeFp: 'fp0',
    afterFp: null,
    nextN: 1,
    level: level(),
    form,
    ids: [id(), id()],
  });
}

const last = (c: Conversation) => c.turns[c.turns.length - 1];
const question = (c: Conversation) => openQuestions(c) as TurnOf<'app-question'>;
const answer = (c: Conversation, key: QuestionKey, brief: DesignBrief): Conversation =>
  talk(c, {
    type: 'answer',
    turnId: question(c).id,
    key,
    brief,
    at: AT,
    id: id(),
    level: level(),
  });

/** The Ong family: two adults, a child and a grandmother with a stick. */
const ongs = (b = defaultBrief()): DesignBrief => ({
  ...b,
  household: { ...b.household, adults: 2, children: ['primary'], elders: ['stick'] },
  names: { 'adult-1': 'Rachel', 'adult-2': 'Daniel', 'child-1': 'Sophie', 'elder-1': 'Mdm Koh' },
});

describe('the first meeting (criteria 20–22)', () => {
  it('greets from the plan with no flat type, then asks who lives here', () => {
    const g = greeting(level());
    expect(g).toMatch(/^Hello\. I’m your AI interior designer\./);
    expect(g).toContain('a flat of about 67 m²');
    expect(g).toContain('two bedrooms');
    expect(g).toContain('two bathrooms');
    expect(g).toContain('the dry kitchen open to the living and dining');
    const c = start();
    expect(c.turns[0]?.kind).toBe('designer');
    expect(question(c).keys).toEqual(['who']);
    expect(meetingOver(c)).toBe(false);
  });

  it('4 people and 2 bedrooms, nobody placed: who sleeps where comes next, led by the conflict', () => {
    const lvl = level();
    expect(bedroomsOf(lvl, defaultBrief()).map((r) => r.name)).toEqual(['Main bedroom', 'Bedroom']);
    expect(sleepingConflict(ongs(), lvl)).toEqual({ people: 4, bedrooms: 2 });
    // Two adults and a child fit (the main bedroom sleeps two).
    expect(
      sleepingConflict(
        { ...defaultBrief(), household: { ...defaultBrief().household, children: ['teen'] } },
        lvl,
      ),
    ).toBeNull();
    let c = start();
    c = answer(c, 'who', ongs(c.brief));
    const q = question(c);
    expect(q.keys).toEqual(['sleeping', 'mobility']);
    expect(q.lead).toBe('Four people and two bedrooms, so this needs a decision.');
    // Said where: no conflict.
    const placed = {
      ...ongs(),
      sleeping: { 'rm_main-bedroom': ['adult-1', 'adult-2'], rm_bedroom: ['child-1', 'elder-1'] },
    };
    expect(sleepingConflict(placed, lvl)).toBeNull();
    expect(factText('sleeping', placed, lvl)).toBe(
      'Rachel and Daniel in Main bedroom; Sophie and Mdm Koh in Bedroom',
    );
  });

  it('asks at most 8 questions, in the order of UX §8.3, then offers the scope', () => {
    let c = start();
    const asked: QuestionKey[][] = [];
    for (let i = 0; i < 10 && openQuestions(c); i++) {
      const q = question(c);
      asked.push(q.keys);
      for (const k of q.keys) c = answer(c, k, k === 'who' ? ongs(c.brief) : c.brief);
    }
    expect(asked).toEqual([
      ['who'],
      ['sleeping', 'mobility'],
      ['cooking', 'wfh'],
      ['budget', 'walls'],
      ['style'],
    ]);
    expect(asked.flat()).toHaveLength(8);
    expect(last(c)?.kind).toBe('scope');
    expect(meetingOver(c)).toBe(true);
    // A person's answer is kept in words on the question.
    const who = c.turns.find((t) => t.kind === 'app-question') as TurnOf<'app-question'>;
    expect(who.done.who?.words).toBe('Rachel, Daniel, Sophie and Mdm Koh (uses a stick)');
  });

  it('a form filled in before: its facts are kept and said once, not asked again', () => {
    const b = tanBrief();
    const c = start(b, { at: '2026-11-03T08:00:00.000Z' });
    expect((c.turns[0] as TurnOf<'designer'>).after).toMatch(
      /^I’ve kept what you told me in the form on 3 Nov: two adults, two children, one older parent who uses a walking frame, S\$40–60k\./,
    );
    // Only who sleeps where is left (the form didn't say).
    expect(question(c).keys).toEqual(['sleeping']);
  });

  it('Just design it: the assumptions in the text and in What I know (criterion 22)', () => {
    let c = start();
    c = answer(c, 'who', ongs(c.brief));
    expect(sleepingConflict(c.brief, level())).not.toBeNull();
    c = talk(c, { type: 'justDesign', at: AT, ids: [id(), id()], level: level() });
    const said = c.turns.find(
      (t) => t.kind === 'designer' && t.text.startsWith('Fine'),
    ) as TurnOf<'designer'>;
    expect(said.text).toBe('Fine, I’ll start. I’ve assumed:');
    expect(said.lines[0]).toBe('Rachel and Daniel in Main bedroom; Mdm Koh and Sophie in Bedroom');
    expect(said.lines).toContain('Walls: only ones HDB normally allows.');
    expect(c.assumed).toEqual(
      expect.arrayContaining([
        'sleeping',
        'budget',
        'walls',
        'style',
        'cooking',
        'wfh',
        'mobility',
      ]),
    );
    // The conflict is settled by the assumption; the open questions close as assumed.
    expect(sleepingConflict(c.brief, level())).toBeNull();
    expect(openQuestions(c)).toBeNull();
    expect(last(c)?.kind).toBe('scope');
    // A second press does nothing.
    expect(talk(c, { type: 'justDesign', at: AT, ids: [id(), id()], level: level() })).toBe(c);
    // assume() alone, on a brief with nothing open, assumes nothing.
    const all = new Set<QuestionKey>([
      'who',
      'sleeping',
      'mobility',
      'cooking',
      'wfh',
      'budget',
      'walls',
      'style',
    ]);
    expect(assume(c.brief, level(), all).lines).toEqual([]);
  });

  it('Skip records an assumption; changing a fact posts what changed and clears it', () => {
    let c = start();
    c = talk(c, {
      type: 'skip',
      turnId: question(c).id,
      key: 'who',
      at: AT,
      id: id(),
      level: level(),
    });
    expect(c.assumed).toContain('who');
    const b = { ...c.brief, budget: { low: 30_000, high: 50_000 } };
    c = talk(c, { type: 'editFact', key: 'budget', brief: b, at: AT, id: id(), level: level() });
    const ev = last(c) as TurnOf<'event'>;
    expect(ev.event).toEqual({
      type: 'fact',
      key: 'budget',
      text: 'You changed: budget Not sure → S$30–50k.',
    });
    c = talk(c, { type: 'confirmFact', key: 'who' });
    expect(c.assumed).not.toContain('who');
  });

  it('nextQuestions skips what is done and never asks an elder question without one', () => {
    const lvl = level();
    expect(nextQuestions(new Set(['who']), defaultBrief(), lvl)?.keys).toEqual(['sleeping']);
    expect(nextQuestions(new Set(['who', 'sleeping']), defaultBrief(), lvl)?.keys).toEqual([
      'cooking',
      'wfh',
    ]);
  });
});

describe('the reducer', () => {
  const met = () =>
    talk(start(), { type: 'justDesign', at: AT, ids: [id(), id()], level: level() });
  const scope = {
    label: 'Living and dining',
    spaces: ['rm_dry-kitchen+rm_living-and-dining'],
    all: false,
  };

  it('a priced button with a cost card: Go ahead once; a second answer is a no-op', () => {
    let c = met();
    c = talk(c, {
      type: 'ask',
      at: AT,
      ids: [id(), id()],
      scope,
      words: 'More storage',
      reason: 'ask-cost-check',
      estimate: { typical: 0.2, high: 0.5, fix: 0.3 },
    });
    const card = last(c) as TurnOf<'cost-ask'>;
    expect(c.turns[c.turns.length - 2]).toMatchObject({ kind: 'person', text: 'More storage' });
    const go: TalkAction = { type: 'costAnswer', turnId: card.id, answer: 'go', at: AT, id: id() };
    c = talk(c, go);
    expect((last(c) as TurnOf<'cost-ask'>).state).toBe('go');
    expect(talk(c, go)).toBe(c);
    expect(talk(c, { ...go, answer: 'not-now' })).toBe(c);
  });

  it('Not now is the person’s bubble; a proposal takes the next number and clears the draft', () => {
    let c = met();
    c = talk(c, { type: 'draft', text: 'Cheaper' });
    c = talk(c, {
      type: 'ask',
      at: AT,
      ids: [id(), id()],
      scope,
      words: '',
      reason: 'ask-limit',
      estimate: null,
    });
    expect(c.turns[c.turns.length - 2]).toMatchObject({ text: 'Design Living and dining' });
    c = talk(c, {
      type: 'costAnswer',
      turnId: (last(c) as TurnOf<'cost-ask'>).id,
      answer: 'not-now',
      at: AT,
      id: id(),
    });
    expect(last(c)).toMatchObject({ kind: 'person', text: 'Not now' });
    const n0 = c.nextN;
    const p: TalkAction = {
      type: 'propose',
      at: AT,
      ids: { person: id(), turn: id() },
      proposalId: 'prop1',
      scope,
      words: 'Cheaper',
    };
    c = talk(c, p);
    expect(c.nextN).toBe(n0 + 1);
    expect(c.draft).toBe('');
    expect(last(c)).toMatchObject({ kind: 'proposal', proposalId: 'prop1' });
    expect(talk(c, p)).toBe(c);
  });

  it('accepted, undone and redone toggle one line', () => {
    let c = met();
    c = talk(c, {
      type: 'accepted',
      id: 'ev1',
      at: AT,
      proposalId: 'prop1',
      n: 4,
      letter: 'A',
      changes: ['a', 'b'],
      total: 5,
      left: ['the sofa'],
    });
    c = talk(c, { type: 'undone', eventId: 'ev1' });
    expect((last(c) as TurnOf<'event'>).event).toMatchObject({ type: 'accepted', undone: true });
    c = talk(c, { type: 'redone', eventId: 'ev1' });
    expect((last(c) as TurnOf<'event'>).event).toMatchObject({ undone: false });
  });

  it('decisions: add, edit, delete and restore', () => {
    let c = met();
    c = talk(c, {
      type: 'decisionAdd',
      id: 'd1',
      at: AT,
      kind: 'rejected',
      text: ' No sofa under the window ',
      from: 'V2',
    });
    expect(c.decisions).toEqual([
      {
        id: 'd1',
        kind: 'rejected',
        text: 'No sofa under the window',
        at: AT,
        from: 'V2',
        deleted: false,
      },
    ]);
    c = talk(c, { type: 'decisionEdit', id: 'd1', text: 'No sofa by the window' });
    c = talk(c, { type: 'decisionDelete', id: 'd1' });
    expect(c.decisions[0]).toMatchObject({ text: 'No sofa by the window', deleted: true });
    c = talk(c, { type: 'decisionRestore', id: 'd1' });
    expect(c.decisions[0]?.deleted).toBe(false);
    expect(
      talk(c, { type: 'decisionAdd', id: 'd2', at: AT, kind: 'rejected', text: '  ', from: null }),
    ).toBe(c);
  });

  it('invalid answers leave it as it was; the record survives a round trip', () => {
    const c = start();
    const q = question(c);
    const a = talk(c, {
      type: 'answer',
      turnId: 'nope',
      key: 'who',
      brief: c.brief,
      at: AT,
      id: id(),
      level: level(),
    });
    expect(a).toBe(c);
    const b = answer(c, 'who', c.brief);
    expect(
      talk(b, {
        type: 'answer',
        turnId: q.id,
        key: 'who',
        brief: c.brief,
        at: AT,
        id: id(),
        level: level(),
      }),
    ).toBe(b);
    expect(doneKeys(b).has('who')).toBe(true);
    expect(conversationFromRecord(JSON.parse(JSON.stringify(b)))).toEqual(b);
    expect(conversationFromRecord({ ...b, recordVersion: 9 })).toBeNull();
  });
});

describe('long texts (B1): every text is cut where it is made', () => {
  it('a 1000-character answer and a 120-character room name still read back', () => {
    const long = 'Mdm Koh’s quiet room by the window '.repeat(4).slice(0, 120);
    const base = level();
    const lvl: Level = {
      ...base,
      rooms: Object.fromEntries(
        Object.entries(base.rooms).map(([id, r]) => [
          id,
          id === 'rm_bedroom' ? { ...r, name: long } : r,
        ]),
      ),
    };
    let c = talk({} as Conversation, {
      type: 'start',
      id: 'conv1',
      at: AT,
      projectId: 'p1',
      levelId: 'lvl',
      brief: defaultBrief(),
      beforeFp: 'fp0',
      afterFp: null,
      nextN: 1,
      level: lvl,
      form: null,
      ids: [id(), id()],
    });
    const step = (key: QuestionKey, brief: DesignBrief) =>
      talk(c, { type: 'answer', turnId: question(c).id, key, brief, at: AT, id: id(), level: lvl });
    c = step('who', ongs(c.brief));
    c = step('sleeping', {
      ...c.brief,
      sleeping: { rm_bedroom: ['adult-1', 'adult-2', 'child-1', 'elder-1'] },
    });
    c = step('mobility', c.brief);
    c = step('cooking', c.brief);
    c = step('wfh', c.brief);
    c = step('budget', c.brief);
    c = step('walls', c.brief);
    const essay = 'We keep the piano. '.repeat(60).slice(0, 1000);
    c = step('style', { ...c.brief, household: { ...c.brief.household, text: essay } });
    c = talk(c, {
      type: 'ask',
      at: AT,
      ids: [id(), id()],
      scope: { label: long, spaces: ['rm_bedroom'], all: false },
      words: 'x'.repeat(5000),
      reason: 'ask-cost-check',
      estimate: null,
    });
    c = talk(c, {
      type: 'accepted',
      id: id(),
      at: AT,
      proposalId: 'p',
      n: 1,
      letter: 'A',
      changes: [],
      total: 3,
      left: [`the ${long}`],
    });
    c = talk(c, {
      type: 'event',
      id: id(),
      at: AT,
      event: { type: 'note', text: long.repeat(10) },
    });
    const back = conversationFromRecord(JSON.parse(JSON.stringify(c)));
    expect(back).not.toBeNull();
    expect(back).toEqual(c);
    const card = c.turns.find((x) => x.kind === 'cost-ask') as TurnOf<'cost-ask'>;
    expect(card.scope.label.length).toBeLessThanOrEqual(80);
    expect(card.scope.label.endsWith('…')).toBe(true);
  });

  it('start on a conversation there is already leaves it as it is', () => {
    const c = start();
    expect(
      talk(c, {
        type: 'start',
        id: 'conv2',
        at: AT,
        projectId: 'p1',
        levelId: 'lvl',
        brief: defaultBrief(),
        beforeFp: 'fp0',
        afterFp: null,
        nextN: 9,
        level: level(),
        form: null,
        ids: [id(), id()],
      }),
    ).toBe(c);
  });

  it('a cost card records who answered it; its figure can be refreshed only while open', () => {
    let c = talk(start(), { type: 'justDesign', at: AT, ids: [id(), id()], level: level() });
    c = talk(c, {
      type: 'ask',
      at: AT,
      ids: [id(), 'card'],
      scope: { label: 'Kitchen', spaces: ['rm_kitchen'], all: false },
      words: '',
      reason: 'ask-cost-check',
      estimate: { typical: 0.1, high: 0.3, fix: 0.2 },
    });
    const est = { typical: 0.12, high: 0.4, fix: 0.2 };
    c = talk(c, { type: 'costRefresh', turnId: 'card', estimate: est });
    expect((c.turns.find((x) => x.id === 'card') as TurnOf<'cost-ask'>).estimate).toEqual(est);
    c = talk(c, { type: 'costAnswer', turnId: 'card', answer: 'go', at: AT, id: 'tab-a' });
    const after = talk(c, {
      type: 'costAnswer',
      turnId: 'card',
      answer: 'go',
      at: AT,
      id: 'tab-b',
    });
    expect((after.turns.find((x) => x.id === 'card') as TurnOf<'cost-ask'>).answerId).toBe('tab-a');
    expect(
      talk(c, { type: 'costRefresh', turnId: 'card', estimate: { typical: 1, high: 2, fix: 0 } }),
    ).toBe(c);
  });
});
