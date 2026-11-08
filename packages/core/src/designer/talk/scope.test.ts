import { describe, expect, it } from 'vitest';
import { defaultBrief, sampleFlatProject, twoLevelProject } from '../../index';
import { planScope } from './plan';

const project = sampleFlatProject('prj_a');
const lid = project.levels[0]?.id ?? '';
const living = {
  label: 'Living and dining',
  spaces: ['rm_dry-kitchen+rm_living-and-dining'],
  all: false,
};

describe('planScope: what a scope button asks for', () => {
  it('a room on a plan with nothing accepted: that room alone, the words as the household’s', () => {
    const sp = planScope(living, defaultBrief(), project, lid, [], ' More storage ', 'dsn_x', {});
    expect(sp?.plan).toEqual({ layout: null, rooms: [living.spaces[0]], feedback: 'More storage' });
    expect(sp?.draft.concept).toBeNull();
    expect(sp?.draft.id).toBe('dsn_x');
    expect(sp?.ctx.variant).toBe('before');
  });

  it('the whole flat: the layout step, then every space', () => {
    const sp = planScope(
      { label: 'The whole flat', spaces: [], all: true },
      defaultBrief(),
      project,
      lid,
      [],
      '',
      'dsn_y',
      {},
    );
    expect(sp?.plan.layout).toEqual({});
    expect(sp?.plan.rooms).toBe('all');
    expect(sp?.plan.feedback).toBeUndefined();
    expect(sp?.expected?.map((e) => e.label)).toEqual([
      'Bedroom',
      'Main bedroom',
      'Living and dining',
      'Kitchen',
    ]);
  });

  it('designs on the renovation when there is one', () => {
    const withReno = {
      ...project,
      renovation: { levels: project.levels.map((l) => ({ ...l, id: `${l.id}~after` })) },
    };
    const sp = planScope(living, defaultBrief(), withReno, lid, [], '', 'dsn_z', {});
    expect(sp?.ctx.variant).toBe('after');
    expect(sp?.brief.start).toBe('after');
  });

  it('a home of several levels: the level asked for, never the first by default', () => {
    const two = twoLevelProject();
    const upper = two.levels[1];
    if (!upper) throw new Error('no upper level');
    const sp = planScope(
      { label: 'Upper', spaces: [], all: true },
      defaultBrief(),
      two,
      upper.id,
      [],
      '',
      'dsn_u',
      {},
    );
    expect(sp?.ctx.base.id).toBe(upper.id);
    expect(sp?.ctx.before.id).toBe(upper.id);
    // Its own rooms, not Ground's.
    const rooms = new Set(Object.keys(upper.rooms));
    expect(sp?.expected?.every((e) => e.key.split('+').every((r) => rooms.has(r)))).toBe(true);
  });
});
