import {
  type Conversation,
  type ElecPoint,
  type Proposal,
  pointName,
  pointPosition,
  twoLevelProject,
} from '@dhd/core';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
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
  setHouseRules: () => {},
  setHouseKept: () => {},
  houseKeptFor: () => [],
  houseRulesFor: () => [],
  useDesigner: create(() => ({ designs: [] })),
  getBrief: async () => null,
  loadDesigns: async () => {},
  putBrief: async () => {},
}));
vi.mock('../results', () => ({}));

const { designLevelId, levelGone, levelGoneText, rulesOn, talkLevel, talkLevels, useTalk } =
  await import('./useTalk');
const { headLabel, nowOf, optionCard } = await import('./cards');
const { makePointer, pointerGone } = await import('./pointers');

describe('pointers carry their level (3a.12) and say when their target is gone (3a.4)', () => {
  it('a chip on the conversation’s level names it when the home has several', () => {
    useTalk.setState({ conv: { levelId: upper.id, draftPointers: [] } as unknown as Conversation });
    const room = Object.values(upper.rooms)[0];
    if (!room) throw new Error('no room');
    const p = makePointer({ kind: 'room', id: room.id, at: { x: 0, y: 0 } });
    expect(p).toMatchObject({
      levelId: upper.id,
      levelName: upper.name,
      version: { kind: 'plan' },
      label: `${room.name} · ${upper.name}`,
      state: 'in your plan',
    });
    expect(p && pointerGone(p)).toBe(false);
    expect(p && pointerGone({ ...p, targetId: 'rm_gone' })).toBe(true);
    // A version deleted since: gone too.
    const v = p && {
      ...p,
      version: { kind: 'option' as const, proposalId: 'gone', letter: 'A', title: 'V9' },
    };
    expect(v && pointerGone(v)).toBe(true);
  });

  it('a piece on your plan after an Accept is there (in the renovation’s copy), never "gone"', () => {
    useTalk.setState({ conv: { levelId: upper.id, draftPointers: [] } as unknown as Conversation });
    const room = Object.values(upper.rooms)[0];
    if (!room) throw new Error('no room');
    const p = makePointer({ kind: 'room', id: room.id, at: { x: 0, y: 0 } });
    if (!p) throw new Error('no pointer');
    // The accepted piece is only in `<level>~after`; the pointer names the plan's level.
    const accepted = {
      ...project,
      renovation: {
        levels: project.levels.map((l) => ({
          ...l,
          id: `${l.id}~after`,
          items: { ...l.items, it_new: { id: 'it_new' } as never },
          points: { ...l.points, pt_new: { id: 'pt_new' } as never },
        })),
      },
    } as typeof project;
    const piece = { ...p, kind: 'item' as const, targetId: 'it_new' };
    const point = { ...p, kind: 'point' as const, targetId: 'pt_new' };
    expect(pointerGone(piece, accepted)).toBe(false);
    expect(pointerGone(point, accepted)).toBe(false);
    expect(pointerGone({ ...piece, targetId: 'it_none' }, accepted)).toBe(true);
    // Before the Accept (no renovation): it isn't there.
    expect(pointerGone(piece, project)).toBe(true);
  });

  it('a point on a wall (a socket) is pointed at where it is on the wall, by its name', () => {
    useTalk.setState({ conv: { levelId: upper.id, draftPointers: [] } as unknown as Conversation });
    const wall = Object.values(upper.walls)[0];
    if (!wall) throw new Error('no wall');
    // On the shared fixture for this test only: put back as it was after.
    const was = upper.points;
    onTestFinished(() => {
      upper.points = was;
    });
    upper.points = {
      ...upper.points,
      pt_wall: {
        id: 'pt_wall',
        kind: 'socket-double',
        wall: { wallId: wall.id, t: 0.5, side: 'left', height: 0.3 },
      },
    };
    const at = pointPosition(upper, upper.points.pt_wall as ElecPoint)?.at;
    const p = makePointer({ kind: 'point', id: 'pt_wall', at: { x: 0, y: 0 } });
    expect(at).toBeTruthy();
    expect(p?.at).toEqual(at);
    expect(p?.label).toMatch(new RegExp(`^${pointName({ kind: 'socket-double' })}`, 'i'));
    expect(p && pointerGone(p)).toBe(false);
  });
});

describe('house rules go with the conversation’s level (slice 3a)', () => {
  it('a card is checked against the live rules of its own level only', () => {
    const rule = (id: string, levelId: string, deleted = false) =>
      ({ id, levelId, deleted }) as Conversation['rules'][number];
    useTalk.setState({
      conv: {
        levelId: upper.id,
        rules: [rule('a', upper.id), rule('b', upper.id, true), rule('c', ground.id)],
      } as Conversation,
    });
    expect(rulesOn(upper.id).map((r) => r.id)).toEqual(['a']);
    expect(rulesOn(ground.id)).toEqual([]);
    useTalk.setState({ conv: null });
    expect(rulesOn(upper.id)).toEqual([]);
  });
});

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

  it('a level gone from the plan: read only, never moved onto the level shown', () => {
    useTalk.setState({ conv: { levelId: 'lvl_gone' } as Conversation });
    expect(designLevelId()).toBe('lvl_gone');
    expect(levelGone()).toBe(true);
    expect(talkLevel()).toBeUndefined();
    expect(talkLevels()).toBeNull();
    expect(levelGoneText()).toBe(
      'This conversation’s level is no longer in the plan. Start over to design Ground.',
    );
  });

  it('an accept is refused on a card of another level, or once the level has gone', async () => {
    const { levelRefusal } = await import('./accept');
    const card = (levelId: string) =>
      ({ levelId, title: 'V2' }) as Parameters<typeof levelRefusal>[0];
    useTalk.setState({ conv: { levelId: ground.id } as Conversation });
    expect(levelRefusal(card(ground.id))).toBeNull();
    expect(levelRefusal(card(upper.id))).toBe(
      'V2 designs Upper, not the level this conversation designs, so nothing was accepted.',
    );
    useTalk.setState({ conv: { levelId: 'lvl_gone' } as Conversation });
    expect(levelRefusal(card('lvl_gone'))).toMatch(/^This conversation’s level is no longer/);
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
          look: null,
          note: null,
        },
      ],
    } as unknown as Proposal;
    const card = optionCard(p, p.options[0] as Proposal['options'][number], upper.id);
    expect(headLabel(project, card)).toBe('Kitchen · Upper');
    expect(nowOf(project, card.levelId)?.now.id).toBe(upper.id);
  });
});
