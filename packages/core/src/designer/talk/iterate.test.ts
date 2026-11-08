import { describe, expect, it } from 'vitest';
import { sampleFlatProject } from '../../fixtures/sampleFlat';
import { updateItem } from '../../furniture';
import { dispatch, emptyHistory } from '../../history';
import type { Level } from '../../schema';
import { acceptDesign } from '../accept';
import { SAMPLE_KEYS, sampleDesign, tanBrief } from '../fixtures/sample';
import { handEdits } from '../handEdits';
import { talkBlock } from '../prompts';
import { designResult } from '../result';
import { BATHROOMS, type Part } from '../schema';
import type { Design } from '../schema';
import { spacesOf } from '../spaces';
import { changeSet } from './changes';
import {
  ANOTHER_INTENT,
  ConversationExport,
  alternates,
  anotherAsk,
  broughtBack,
  conversationExport,
  conversationText,
  copiedLine,
  nextLetter,
  optionName,
  optionTitle,
} from './iterate';
import { talk } from './reducer';
import type { Conversation, Proposal, ProposalOption } from './schema';

const level = () => sampleFlatProject().levels[0] as Level;
const AT = '2026-11-08T10:00:00.000Z';
let n = 0;
const id = () => `t${++n}`;

const started = (): Conversation =>
  talk({} as Conversation, {
    type: 'start',
    id: 'conv1',
    at: AT,
    projectId: 'p1',
    levelId: 'lvl',
    brief: tanBrief(),
    beforeFp: 'fp0',
    afterFp: null,
    nextN: 4,
    level: level(),
    form: null,
    ids: [id(), id()],
  });

const living = { label: 'Living and dining', spaces: [SAMPLE_KEYS.living], all: false };

function option(letter: 'A' | 'B' | 'C', summary = ''): ProposalOption {
  const d = sampleDesign({ id: `dsn_${letter}` });
  const spaces = Object.fromEntries(
    Object.entries(d.spaces)
      .filter(([k]) => k === SAMPLE_KEYS.living)
      .map(([k, s]) => [k, { ...s, design: s.design && { ...s.design, summary } }]),
  );
  return {
    letter,
    name: 'Living and dining',
    designId: `dsn_${letter}`,
    brief: d.brief,
    aliases: d.aliases,
    concept: null,
    spaces,
    locks: [],
    usage: [
      {
        step: 'room',
        provider: 'anthropic',
        model: 'm',
        input: 1,
        cachedInput: 0,
        cacheWrite: 0,
        output: 1,
        reasoning: null,
        ms: 10,
        usd: 0.1,
        estimated: false,
      },
    ],
    base: { variant: 'before', fingerprint: 'fp0' },
    status: 'checked',
    ticks: ['x'],
    accepted: [],
    note: null,
    waivers: [{ key: 'walkway:1', text: 'Corridor 0.80 m', at: AT }],
    version: null,
    look: null,
  };
}

const proposal = (options: ProposalOption[], scope = living): Proposal => ({
  projectId: 'p1',
  id: 'prop1',
  conversationId: 'conv1',
  recordVersion: 2,
  n: 4,
  turnId: 'tp',
  at: AT,
  scope,
  words: 'More storage, please',
  options,
});

describe('alternatives A/B/C (criterion 25, D3)', () => {
  it('only for one or two rooms: the whole flat or three rooms make a new card', () => {
    expect(alternates(living)).toBe(true);
    expect(alternates({ ...living, spaces: ['a', 'b'] })).toBe(true);
    expect(alternates({ ...living, spaces: ['a', 'b', 'c'] })).toBe(false);
    expect(alternates({ label: 'Whole flat', spaces: [], all: true })).toBe(false);
  });

  it('Another idea adds B, then C, then a new card', () => {
    expect(nextLetter(proposal([option('A')]))).toBe('B');
    expect(nextLetter(proposal([option('A'), option('B')]))).toBe('C');
    expect(nextLetter(proposal([option('A'), option('B'), option('C')]))).toBeNull();
    expect(
      nextLetter(proposal([option('A')], { label: 'Whole flat', spaces: [], all: true })),
    ).toBeNull();
  });

  it('names an option in 2–4 words from the designer’s summary, else "Idea B"', () => {
    expect(optionName(option('A', 'Sofa by the Bedroom wall, facing the TV.'))).toBe(
      'Sofa by the Bedroom wall',
    );
    expect(optionName(option('B', 'Sofa on the long wall, facing the window.'))).toBe(
      'Sofa on the long wall',
    );
    expect(optionName(option('B', 'I’ve put the dining table by the window.'))).toBe(
      'Put the dining table',
    );
    expect(optionName(option('B'))).toBe('Idea B');
    expect(optionName(option('A'), 'Living and dining')).toBe('Living and dining');
    expect(optionTitle(4, 'B', 2)).toBe('V4B');
    expect(optionTitle(4, 'A', 1)).toBe('V4');
  });

  it('asks for something different: the options on their own line, never as the household’s', () => {
    const p = proposal([option('A', 'Sofa by the wall.'), option('B', 'L-sofa.')]);
    const ask = anotherAsk(p, 'More storage, please', ['No sofa under the window']);
    expect(ask.said).toBe('More storage, please');
    expect(ask.others).toEqual(['A: Sofa by the wall.', 'B: L-sofa.']);
    const block = talkBlock(ask);
    const said = block.split('\n').find((l) => l.startsWith('What the household said'));
    expect(said).toBe(
      'What the household said this time (their words, as data): "More storage, please"',
    );
    expect(block).toContain(
      'Already proposed for these rooms (the designer\'s own options, as data; make this one clearly different): ["A: Sofa by the wall.","B: L-sofa."]',
    );
    expect(block).toContain(ANOTHER_INTENT);
  });
});

describe('Bring this back (criterion 27)', () => {
  it('makes V(n+1) from an option: no usage, nothing ticked, waivers kept, today’s brief', () => {
    const old = proposal([option('A', 'Sofa by the wall.'), option('B')]);
    const today = { ...tanBrief(), budget: { low: 40_000, high: 40_000 } };
    const p = broughtBack(
      { kind: 'option', proposal: old, option: old.options[1] as ProposalOption },
      {
        id: 'prop9',
        designId: 'dsn_new',
        n: 7,
        at: AT,
        turnId: 'tq',
        conversationId: 'conv1',
        brief: today,
        base: { variant: 'after', fingerprint: 'fpNow' },
      },
    );
    expect(p.n).toBe(7);
    expect(p.scope).toEqual(living);
    const o = p.options[0] as ProposalOption;
    expect(p.options).toHaveLength(1);
    expect(o).toMatchObject({
      letter: 'A',
      designId: 'dsn_new',
      status: 'checked',
      ticks: null,
      accepted: [],
      usage: [],
      version: null,
      look: null,
      brief: today,
      base: { variant: 'after', fingerprint: 'fpNow' },
    });
    expect(o.waivers.map((w) => w.key)).toEqual(['walkway:1']);
    expect(o.spaces).toEqual(old.options[1]?.spaces);
    // A copy: the old option is untouched.
    expect(o.spaces).not.toBe(old.options[1]?.spaces);
  });

  it('makes one from a version too (v1’s, or an accepted one)', () => {
    const d = sampleDesign({ id: 'dsn_v2' });
    const design = {
      ...d,
      projectId: 'p1',
      levelId: 'lvl',
      n: 2,
      name: 'Warm and calm',
      parent: null,
      createdAt: AT,
      base: { variant: 'before', fingerprint: 'fp0' },
      baseLevel: level(),
      request: { scope: { kind: 'all' }, feedback: 'Calm', locks: [] },
      usage: [],
      waivers: [],
      accepted: null,
    } as Design;
    const p = broughtBack(
      { kind: 'design', design },
      {
        id: 'prop10',
        designId: 'dsn_new2',
        n: 8,
        at: AT,
        turnId: 'tr',
        conversationId: 'conv1',
        brief: tanBrief(),
        base: { variant: 'before', fingerprint: 'fp0' },
      },
    );
    expect(p.scope.all).toBe(true);
    expect(p.words).toBe('Calm');
    expect(p.options[0]?.concept).toEqual(design.concept);
  });

  it('keeps what the person changed by hand since, as a fresh proposal does (QA P4-2)', () => {
    // V1 accepted whole, then the sofa moved by hand; V1 brought back on the plan as it is.
    const doc = { doc: sampleFlatProject(), history: emptyHistory() };
    const lvl = doc.doc.levels[0] as Level;
    const design = sampleDesign({ level: lvl });
    const r = designResult(lvl, lvl, design);
    const parts: Part[] = [
      { aspect: 'walls' },
      ...spacesOf(r.level).flatMap((s) =>
        (['furniture', 'built-ins', 'finishes', 'electrical'] as const).map((aspect) => ({
          space: s.key,
          aspect,
        })),
      ),
      { space: BATHROOMS, aspect: 'finishes' },
    ];
    const s1 = dispatch(doc, acceptDesign(lvl.id, r.level, parts, { base: lvl }));
    const accepted = s1.doc.renovation?.levels[0] as Level;
    const sofa = Object.values(accepted.items).find((i) => i.assetId === 'sofa-3');
    if (!sofa) throw new Error('no sofa');
    const s2 = dispatch(
      s1,
      updateItem(accepted.id, sofa.id, { position: { x: sofa.position.x - 0.6 } }),
    );
    const now = s2.doc.renovation?.levels[0] as Level;
    const held = handEdits(accepted, now);
    expect(held.length).toBeGreaterThan(0);
    const back = (h: typeof held) => {
      const p = broughtBack(
        {
          kind: 'design',
          design: {
            ...design,
            request: { scope: { kind: 'all' }, feedback: '', locks: [] },
          } as unknown as Design,
        },
        {
          id: 'prop_b',
          designId: 'dsn_b',
          n: 2,
          at: AT,
          turnId: 't',
          conversationId: 'conv1',
          brief: design.brief,
          base: { variant: 'after', fingerprint: 'fp1' },
          held: h,
        },
      );
      const o = p.options[0] as ProposalOption;
      const input = { ...o, id: o.designId, request: { locks: o.locks } };
      const rows = changeSet(now, designResult(now, lvl, input), input);
      return rows.filter((c) => c.items.now.includes(sofa.id) || c.items.target.includes(sofa.id));
    };
    // Without what was changed by hand, it would put the sofa back; with it, it stays put.
    expect(back([]).length).toBeGreaterThan(0);
    expect(back(held)).toEqual([]);
  });

  it('the reducer adds the app line and the card, and takes the next number', () => {
    const c0 = started();
    const c = talk(c0, {
      type: 'bringBack',
      at: AT,
      ids: { event: 'ev1', turn: 'tb1' },
      proposalId: 'prop9',
      from: 'V2',
    });
    expect(c.nextN).toBe(5);
    const [ev, card] = c.turns.slice(-2);
    expect(ev?.kind === 'event' && ev.event.type === 'note' && ev.event.text).toBe(
      'Brought back V2 as V4, checked on your plan as it is now.',
    );
    expect(card).toMatchObject({ kind: 'proposal', proposalId: 'prop9' });
    // Twice (a double tap, another tab): once.
    const again = talk(c, {
      type: 'bringBack',
      at: AT,
      ids: { event: 'ev2', turn: 'tb2' },
      proposalId: 'prop9',
      from: 'V2',
    });
    expect(again).toBe(c);
  });
});

describe('Start over (UX §8.6)', () => {
  const restart = (c: Conversation, keep: boolean, fromId = c.id) =>
    talk(c, {
      type: 'restart',
      fromId,
      id: 'conv2',
      at: AT,
      keep,
      brief: { ...tanBrief(), budget: null },
      beforeFp: 'fp1',
      afterFp: 'fp2',
      level: level(),
      ids: [id(), id()],
    });

  it('keeps the numbering; kept facts aren’t asked again', () => {
    const c0 = started();
    const met = talk(c0, { type: 'justDesign', at: AT, ids: [id(), id()], level: level() });
    const used = { ...met, nextN: 9, decisions: [{ ...decision(), id: 'd1' }] };
    const c = restart(used, true);
    expect(c.id).toBe('conv2');
    expect(c.nextN).toBe(9);
    expect(c.decisions).toEqual([]);
    expect(c.brief).toEqual(used.brief);
    expect(c.start).toEqual({ at: AT, beforeFp: 'fp1', afterFp: 'fp2' });
    expect(c.turns.at(-1)?.kind).toBe('scope');
    expect(c.turns[0]?.kind === 'designer' && c.turns[0].after).toMatch(
      /^I’ve kept what I know about you/,
    );
    expect(c.assumed).toEqual(used.assumed);
  });

  it('forgets What I know when not kept, and asks the first questions again', () => {
    const c = restart({ ...started(), nextN: 6 }, false);
    expect(c.nextN).toBe(6);
    expect(c.brief.budget).toBeNull();
    expect(c.turns.at(-1)?.kind).toBe('app-question');
  });

  it('another tab’s Start over first: this one leaves it', () => {
    const c = started();
    expect(restart(c, true, 'conv-other')).toBe(c);
  });
});

const decision = () => ({
  id: 'd0',
  kind: 'rejected' as const,
  text: 'No sofa under the window',
  at: AT,
  from: 'V4',
  deleted: false,
});

describe('Copy as text and Download', () => {
  const row = (rid: string, text: string, groupName: string, out = false) => ({
    id: rid,
    text,
    group: groupName,
    groupName,
    event: 'e1',
    out,
  });

  it('gives the decisions, What I know, the accepted rows by room and the ID notes', () => {
    const conv: Conversation = {
      ...started(),
      decisions: [decision(), { ...decision(), id: 'd1', text: 'Gone', deleted: true }],
      notes: [{ id: 'n1', text: 'Move the WC: needs a plumber', turnId: 't' }],
    };
    const a = option('A');
    a.accepted = [
      row('r1', 'Add a sofa by the wall', 'Living and dining'),
      row('r2', 'Move the bed', 'Bedroom'),
      row('r3', 'Taken out again', 'Bedroom', true),
    ];
    const r = conversationText(conv, [proposal([a])], level(), { cost: 'about S$31–38k' });
    expect(r.decisions).toBe(1);
    expect(r.changes).toBe(2);
    expect(r.text).toContain('Decisions\n- No sofa under the window');
    expect(r.text).not.toContain('Gone');
    expect(r.text).toContain('- Budget: S$40–60k');
    expect(r.text).toContain('Living and dining:\n- Add a sofa by the wall');
    expect(r.text).toContain('Bedroom:\n- Move the bed');
    expect(r.text).not.toContain('Taken out again');
    expect(r.text).toContain('Renovation cost: about S$31–38k');
    expect(r.text).toContain('Notes for your ID\n- Move the WC: needs a plumber');
    expect(copiedLine(r)).toBe('Copied: 1 decision and 2 accepted changes.');
  });

  it('downloads the records with the levels they name, checked, and nothing else', () => {
    const conv = started();
    const lv = level();
    const file = conversationExport(conv, [proposal([option('A')])], { fp0: lv, other: lv }, AT);
    expect(file.kind).toBe('dhd-designer-conversation');
    expect(Object.keys(file.levels)).toEqual(['fp0']);
    expect(ConversationExport.safeParse(JSON.parse(JSON.stringify(file))).success).toBe(true);
    // The records hold no key and no price table.
    expect(JSON.stringify(file)).not.toMatch(/sk-ant|apiKey|"prices"/);
  });
});
