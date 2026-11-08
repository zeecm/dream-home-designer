import { type Conversation, type Proposal, twoLevelProject } from '@dhd/core';
import { describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

/**
 * A home of several levels is designed a level at a time: the conversation's own level, never
 * the first one by default (the plan lists Ground first; this conversation designs Upper).
 */

const project = twoLevelProject();
const [ground, upper] = project.levels as [
  (typeof project.levels)[number],
  (typeof project.levels)[number],
];

vi.mock('../../../store', () => ({
  useStore: create(() => ({ editor: { doc: project, history: { past: [], future: [] } } })),
  shownLevelId: () => ground.id,
}));
vi.mock('../state', () => ({
  designOpts: () => ({}),
  useDesigner: create(() => ({ designs: [] })),
  getBrief: async () => null,
  loadDesigns: async () => {},
  putBrief: async () => {},
}));
vi.mock('../results', () => ({}));

const { designLevelId, talkLevel, talkLevels, useTalk } = await import('./useTalk');
const { headLabel, nowOf, optionCard } = await import('./cards');

describe('the level a conversation designs', () => {
  it('before a conversation: the level shown', () => {
    useTalk.setState({ conv: null });
    expect(designLevelId()).toBe(ground.id);
  });

  it('its own level, whichever is listed first, with its renovation once there is one', () => {
    useTalk.setState({ conv: { levelId: upper.id } as Conversation });
    expect(designLevelId()).toBe(upper.id);
    expect(talkLevel()?.id).toBe(upper.id);
    expect(talkLevels()?.before.id).toBe(upper.id);
    const renovated = {
      ...project,
      renovation: { levels: project.levels.map((l) => ({ ...l, id: `${l.id}~after` })) },
    };
    expect(nowOf(renovated, upper.id)).toMatchObject({
      now: { id: `${upper.id}~after` },
      before: { id: upper.id },
    });
  });

  it('a level gone from the plan: the level shown', () => {
    useTalk.setState({ conv: { levelId: 'lvl_gone' } as Conversation });
    expect(designLevelId()).toBe(ground.id);
  });

  it('each card names its level, and is placed on it', () => {
    const p = {
      id: 'prop1',
      n: 1,
      scope: { label: 'Kitchen', spaces: [], all: false },
      words: '',
      at: '',
      options: [
        {
          letter: 'A',
          name: 'Kitchen',
          designId: 'dsn_1',
          brief: {},
          aliases: {},
          concept: null,
          spaces: {},
          locks: [],
          usage: [],
          base: { variant: 'before', fingerprint: 'fp' },
          status: 'checked',
          ticks: null,
          accepted: [],
          waivers: [],
          version: null,
          note: null,
        },
      ],
    } as unknown as Proposal;
    const card = optionCard(p, p.options[0] as Proposal['options'][number], upper.id);
    expect(headLabel(project, card)).toBe('Kitchen · Upper');
    expect(nowOf(project, card.levelId)?.now.id).toBe(upper.id);
  });
});
