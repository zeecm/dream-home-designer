import type { Change } from '@dhd/core';
import { describe, expect, it, vi } from 'vitest';
import { type CardModel, cardScope, cardVerdict } from './cards';

// The cards read the app's design options; these tests need none of the stores.
vi.mock('../state', () => ({ designOpts: () => ({}) }));

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
