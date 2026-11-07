import { defaultBrief, sampleFlatProject } from '@dhd/core';
import { describe, expect, it } from 'vitest';
import { planScope } from './scope';

const project = sampleFlatProject('prj_a');
const living = {
  label: 'Living and dining',
  spaces: ['rm_dry-kitchen+rm_living-and-dining'],
  all: false,
};

describe('planScope: what a scope button asks for', () => {
  it('a room on a plan with nothing accepted: that room alone, the words as the household’s', () => {
    const sp = planScope(living, defaultBrief(), project, [], ' More storage ', 'dsn_x', {});
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
    const sp = planScope(living, defaultBrief(), withReno, [], '', 'dsn_z', {});
    expect(sp?.ctx.variant).toBe('after');
    expect(sp?.brief.start).toBe('after');
  });
});
