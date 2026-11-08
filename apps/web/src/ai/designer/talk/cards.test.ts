import {
  type Change,
  type Design,
  type Level,
  type Proposal,
  TYPICAL_RATES,
  designResult,
  levelBounds,
  parseSpaceDesign,
  sampleFlatProject,
} from '@dhd/core';
import { describe, expect, it, vi } from 'vitest';
import living from '../../../../../../packages/core/src/designer/fixtures/room-living.json' with {
  type: 'json',
};
import {
  SAMPLE_KEYS,
  parsed,
  sampleDesign,
} from '../../../../../../packages/core/src/designer/fixtures/sample';
import {
  type CardModel,
  cardScope,
  cardVerdict,
  earlierDesign,
  optionCard,
  precheckOn,
  putBackMoves,
  versionKey,
} from './cards';

// The cards read the app's design options and results; these tests need neither.
vi.mock('../state', () => ({ designOpts: () => ({}) }));
vi.mock('../results', () => ({}));

const row = (id: string, group: string): Change => ({
  id,
  group,
  groupName: group,
  verb: 'add',
  text: id,
  why: null,
  items: { now: [], target: [] },
  rows: [],
  needsWalls: false,
  checks: [],
  waivable: true,
  name: id,
});

const kitchenCard = {
  key: 'prp_b:A',
  proposal: { scope: { label: 'Kitchen', spaces: ['rm_kitchen'], all: false } },
} as unknown as CardModel;

describe('cardScope: a card proposes only what it was asked about', () => {
  const rows = [
    row('add:sofa', 'rm_living'),
    row('turn:tv', 'rm_living'),
    row('add:fridge', 'rm_kitchen'),
    row('add:hob', 'rm_kitchen'),
    row('walls', 'walls'),
    row('rename:rm_kitchen', 'names'),
  ];

  it('a Kitchen proposal never re-proposes the living room it copied (left out or accepted)', () => {
    expect(cardScope(rows, kitchenCard, []).map((c) => c.id)).toEqual([
      'add:fridge',
      'add:hob',
      'walls',
      'rename:rm_kitchen',
    ]);
  });

  it('a merge or split since: a group is in scope when any of its rooms is', () => {
    const living = {
      key: 'prp_d:A',
      proposal: {
        scope: { label: 'Living and dining', spaces: ['rm_dry+rm_living'], all: false },
      },
    } as unknown as CardModel;
    const after = [
      row('add:sofa', 'rm_living'),
      row('add:table', 'rm_dining+rm_dry+rm_living'),
      row('add:bed', 'rm_bed'),
    ];
    expect(cardScope(after, living, []).map((c) => c.id)).toEqual(['add:sofa', 'add:table']);
  });

  it('a change already accepted from the card is never offered again', () => {
    expect(cardScope(rows, kitchenCard, ['add:fridge']).map((c) => c.id)).not.toContain(
      'add:fridge',
    );
  });

  it('the whole flat, or a version with no proposal, keeps every space', () => {
    const flat = {
      key: 'prp_c:A',
      proposal: { scope: { label: 'The whole flat', spaces: [], all: true } },
    } as unknown as CardModel;
    expect(cardScope(rows, flat, [])).toHaveLength(rows.length);
    expect(cardScope(rows, { key: 'd:dsn_a' } as CardModel, ['walls'])).toHaveLength(5);
  });
});

describe('cardVerdict: one verdict for the Checks line and On the table', () => {
  it('fails while any hard check fails, ticked or not', () => {
    const v = cardVerdict([{ key: 'clear:fridge' }, { key: 'turn:sofa' }], [], []);
    expect(v).toMatchObject({
      tone: 'fail',
      text: '2 don’t pass',
      failing: ['clear:fridge', 'turn:sofa'],
    });
  });

  it('counts a check failed both alone and by the ticked set once', () => {
    const v = cardVerdict([{ key: 'clear:fridge' }], [{ key: 'clear:fridge' }], []);
    expect(v.text).toBe('1 doesn’t pass');
  });

  it('one accepted anyway and others failing: still says what fails', () => {
    const v = cardVerdict([{ key: 'a' }, { key: 'b' }, { key: 'c' }], [], ['a']);
    expect(v).toMatchObject({ tone: 'fail', text: '2 don’t pass', waived: 1 });
  });

  it('all waived: accepted anyway; nothing failing: passes', () => {
    expect(cardVerdict([{ key: 'a' }], [], ['a']).text).toBe('1 accepted anyway');
    expect(cardVerdict([], [], []).text).toBe('Passes all checks');
  });
});

describe('versions in the conversation', () => {
  const v = (from?: Design['from']) => ({ id: 'dsn_1', ...(from ? { from } : {}) }) as Design;
  const mine = { conversationId: 'c1', proposalId: 'p1', letter: 'B' };
  it('shows a version as its option’s card in this conversation, else as its own', () => {
    expect(versionKey(v(mine), 'c1')).toBe('p1:B');
    expect(versionKey(v(mine), 'c2')).toBe('d:dsn_1');
    expect(versionKey(v(), 'c1')).toBe('d:dsn_1');
  });
  it('puts v1’s versions and a started-over conversation’s under Earlier designs', () => {
    expect(earlierDesign(v(), 'c1')).toBe(true);
    expect(earlierDesign(v(mine), 'c2')).toBe(true);
    expect(earlierDesign(v(mine), 'c1')).toBe(false);
  });
});

describe('Put it back follows its history step (tech lead)', () => {
  const step = { patches: [] as unknown[] };
  const other = { patches: [] as unknown[] };
  const pb = (out: boolean) => ({ patches: step.patches, out });
  it('out while in past, in while in future', () => {
    expect(putBackMoves([pb(false)], { past: [step], future: [] }).apply).toEqual([
      { item: pb(false), out: true },
    ]);
    expect(putBackMoves([pb(true)], { past: [], future: [step] }).apply).toEqual([
      { item: pb(true), out: false },
    ]);
    expect(putBackMoves([pb(true)], { past: [other, step], future: [] }).apply).toEqual([]);
  });
  it('trimmed from the history (200 steps on): left as it is and no longer followed', () => {
    const trimmed = { past: Array.from({ length: 200 }, () => other), future: [] };
    const item = pb(true);
    const moves = putBackMoves([item], trimmed);
    expect(moves.apply).toEqual([]);
    expect(moves.gone).toEqual([item]);
  });
});

describe('the accept precheck fails closed (tech lead)', () => {
  const project = sampleFlatProject('prj_pre');
  const level = project.levels[0] as Level;
  // The sofa on the long wall: it narrows the way through, a hard check fails.
  const room = parsed(
    parseSpaceDesign(
      { ...living, items: living.items.map((it, i) => (i === 0 ? { ...it, along: 2.4 } : it)) },
      levelBounds(level),
    ),
  );
  const design = sampleDesign({ level, concept: null, answers: { [SAMPLE_KEYS.living]: room } });
  const proposal: Proposal = {
    projectId: project.id,
    id: 'prop1',
    conversationId: 'c1',
    recordVersion: 2,
    n: 1,
    turnId: 't',
    at: '2026-11-08T10:00:00.000Z',
    scope: { label: 'Living and dining', spaces: [SAMPLE_KEYS.living], all: false },
    words: '',
    options: [
      {
        letter: 'A',
        name: 'Living and dining',
        designId: design.id,
        brief: design.brief,
        aliases: design.aliases,
        concept: null,
        spaces: design.spaces,
        locks: [],
        usage: [],
        base: { variant: 'before', fingerprint: 'fp0' },
        status: 'checked',
        ticks: null,
        accepted: [],
        waivers: [],
        version: null,
        note: null,
      },
    ],
  };
  const card = optionCard(proposal, proposal.options[0] as Proposal['options'][number], level.id);
  it('with no result to check with: missing, never "nothing fails"', () => {
    expect(precheckOn(project, card, ['x'], [], null, TYPICAL_RATES)).toEqual({
      failing: [],
      hdb: false,
      missing: true,
    });
  });
  it('with the result waited for: what the ticked rows fail together', async () => {
    const { changeSet } = await import('@dhd/core');
    const r = designResult(level, level, card.input);
    const all = changeSet(level, r, card.input).map((c) => c.id);
    const pre = precheckOn(project, card, all, [], r, TYPICAL_RATES);
    expect(pre.missing).toBe(false);
    expect(pre.failing.length).toBeGreaterThan(0);
    // Accepted anyway: those no longer stop it.
    const waived = pre.failing.map((c) => c.key);
    expect(precheckOn(project, card, all, waived, r, TYPICAL_RATES).failing).toEqual([]);
  });
});
