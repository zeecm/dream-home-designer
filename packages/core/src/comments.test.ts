import { describe, expect, it } from 'vitest';
import fixture from '../../../apps/api/internal/comments/testdata/comments.json';
import {
  type CommentAnchor,
  type CommentThread,
  type CommentsDoc,
  CommentsDoc as CommentsSchema,
  anchorFor,
  anchorPosition,
  commentLabel,
  commentsText,
  goneText,
  threadsView,
} from './comments';
import { hdb4RoomProject } from './fixtures/hdb4room';
import { labelPoint } from './geometry';
import { AFTER_SUFFIX } from './levels';
import type { Item, Level, Project } from './schema';

describe('the comments document', () => {
  it('parses the API fixture (apps/api/internal/comments/testdata)', () => {
    const doc = CommentsSchema.parse(fixture);
    expect(doc.version).toBe(7);
    expect(doc.threads.map((t) => t.anchor.target?.kind ?? 'spot')).toEqual([
      'wall',
      'item',
      'room',
      'spot',
    ]);
    expect(doc.threads[1]?.resolved?.name).toBe('Wei Ling');
    expect(doc.threads[0]?.messages[1]?.mine).toBe(true);
    // Never sent to clients.
    expect(JSON.stringify(fixture)).not.toContain('authHash');
  });

  it('refuses an unknown variant', () => {
    const bad = structuredClone(fixture) as { threads: { anchor: Record<string, unknown> }[] };
    const first = bad.threads[0];
    if (!first) throw new Error('fixture has no thread');
    first.anchor.variant = 'x';
    expect(CommentsSchema.safeParse(bad).success).toBe(false);
  });
});

const fridge = (over: Partial<Item> = {}): Item => ({
  id: 'it_fridge',
  assetId: 'fridge',
  position: { x: 10, y: 0, z: 1 },
  rotationY: 0,
  scale: { x: 1, y: 1, z: 1 },
  flags: { snapWall: true, collidable: true },
  ...over,
});

/** The reference flat with a fridge in the kitchen. */
function sample(): Project {
  const p = hdb4RoomProject();
  const level = p.levels[0] as Level;
  level.items.it_fridge = fridge();
  return p;
}

const level0 = (p: Project) => p.levels[0] as Level;

const anchor = (p: Project, at: { x: number; y: number }, hit: CommentAnchor['target'] | null) => ({
  levelId: 'lvl_ground',
  variant: 'before' as const,
  ...anchorFor(level0(p), at, hit ? { kind: hit.kind, id: hit.id } : null),
});

describe('what a comment attaches to', () => {
  it('attaches to the piece, the wall, the room or a spot', () => {
    const p = sample();
    const onFridge = anchorFor(level0(p), { x: 10.2, y: 1.1 }, { kind: 'item', id: 'it_fridge' });
    expect(onFridge.target).toMatchObject({ kind: 'item', id: 'it_fridge' });
    expect(onFridge.label).toBe('Fridge');

    const onWall = anchorFor(
      level0(p),
      { x: 5.03, y: 2 },
      { kind: 'wall', id: 'w_living_kitchen' },
    );
    const t = onWall.target;
    expect(t?.kind).toBe('wall');
    if (t?.kind !== 'wall') throw new Error('not a wall');
    expect(t.t).toBeCloseTo(2 / 4.5, 2);
    expect(onWall.label).toBe('Wall · Living / Kitchen');

    const inRoom = anchorFor(level0(p), { x: 8, y: 2.5 }, null);
    expect(inRoom.target).toEqual({ kind: 'room', id: 'rm_kitchen' });
    expect(inRoom.label).toBe('Kitchen');

    const outside = anchorFor(level0(p), { x: -3, y: -3 }, null);
    expect(outside.target).toBeUndefined();
    expect(outside.label).toBe('Spot on the plan');
  });

  it('tidies labels as the server keeps them', () => {
    expect(commentLabel('Kitchen\u200f')).toBe('Kitchen');
    expect(commentLabel(' \u200b ')).toBe('Spot on the plan');
    expect(commentLabel('Mum 👩‍👧')).toBe('Mum 👩‍👧');
    expect(Array.from(commentLabel('厨'.repeat(90)))).toHaveLength(80);
  });

  it('names doors by the rooms they join', () => {
    const p = sample();
    const a = anchorFor(level0(p), { x: 5, y: 2.25 }, { kind: 'opening', id: 'op_kitchen' });
    expect(a.label).toBe('Opening · Living / Kitchen');
  });
});

describe('where a pin draws', () => {
  it('follows a piece that moved and turned', () => {
    const p = sample();
    const a = anchor(
      p,
      { x: 10.2, y: 1.1 },
      { kind: 'item', id: 'it_fridge', rel: { x: 0, y: 0 } },
    );
    level0(p).items.it_fridge = fridge({ position: { x: 9, y: 0, z: 2 }, rotationY: Math.PI / 2 });
    const place = anchorPosition(p, a);
    expect(place.state).toBe('on');
    // rel (0.2, 0.1) turned a quarter: (-0.1, 0.2).
    expect(place.at.x).toBeCloseTo(8.9, 3);
    expect(place.at.y).toBeCloseTo(2.2, 3);
  });

  it('keeps its place along a wall that grew', () => {
    const p = sample();
    const a = anchor(p, { x: 5, y: 2 }, { kind: 'wall', id: 'w_living_kitchen', t: 0, off: 0 });
    const v9 = level0(p).vertices.v9;
    if (!v9) throw new Error('no v9');
    v9.y = 9;
    const place = anchorPosition(p, a);
    expect(place.at.y).toBeCloseTo((2 / 4.5) * 9, 3);
  });

  it('stays where it was when its piece is deleted, and comes back with it', () => {
    const p = sample();
    const a = anchor(p, { x: 10, y: 1 }, { kind: 'item', id: 'it_fridge', rel: { x: 0, y: 0 } });
    level0(p).items = {};
    expect(anchorPosition(p, a)).toEqual({ at: { x: 10, y: 1 }, state: 'gone', reason: 'removed' });
    expect(goneText('removed', a)).toBe('The fridge was removed. The pin stays where it was.');
    level0(p).items.it_fridge = fridge({ position: { x: 7, y: 0, z: 3 } });
    expect(anchorPosition(p, a).at).toEqual({ x: 7, y: 3 });
  });

  it('moves to the label point of a room reshaped so the spot falls outside', () => {
    const p = sample();
    const a = anchor(p, { x: 8, y: 4 }, { kind: 'room', id: 'rm_kitchen' });
    expect(anchorPosition(p, a).at).toEqual({ x: 8, y: 4 });
    const l = level0(p);
    for (const id of ['v3', 'v10', 'v9'] as const) {
      const v = l.vertices[id];
      if (v) v.y = 3;
    }
    const place = anchorPosition(p, a);
    const outer = ['v1', 'v2', 'v3', 'v10', 'v9'].map((id) => {
      const v = l.vertices[id];
      return { x: v?.x ?? 0, y: v?.y ?? 0 };
    });
    expect(place.state).toBe('on');
    expect(place.at).toEqual(labelPoint(outer));
  });

  it('knows a wall hacked in the renovation, and a deleted renovation', () => {
    const p = sample();
    const after = structuredClone(level0(p));
    after.id = `lvl_ground${AFTER_SUFFIX}`;
    delete after.walls.w_living_kitchen;
    p.renovation = { levels: [after] };
    const wall = { kind: 'wall' as const, id: 'w_living_kitchen', t: 0.5, off: 0 };
    const inAfter: CommentAnchor = { ...anchor(p, { x: 5, y: 2 }, wall), variant: 'after' };
    expect(anchorPosition(p, inAfter)).toMatchObject({
      state: 'gone',
      reason: 'removed-in-renovation',
    });
    expect(goneText('removed-in-renovation', inAfter)).toBe(
      'This wall is hacked in the renovation.',
    );
    expect(anchorPosition(p, { ...inAfter, variant: 'before' }).state).toBe('on');
    // Something only the renovation had, then deleted there, is just removed.
    const kitchenFridge = { kind: 'item' as const, id: 'it_new', rel: { x: 0, y: 0 } };
    const newPiece: CommentAnchor = { ...inAfter, target: kitchenFridge };
    expect(anchorPosition(p, newPiece).reason).toBe('removed');
    p.renovation = undefined;
    expect(anchorPosition(p, inAfter)).toMatchObject({ state: 'gone', reason: 'no-renovation' });
    expect(anchorPosition(p, { ...inAfter, variant: 'before', levelId: 'lvl_gone' }).reason).toBe(
      'no-level',
    );
  });
});

const msg = (id: string, at: string, mine = false, name = 'Mum') => ({
  id,
  name,
  role: 'viewer' as const,
  text: `text ${id}`,
  at,
  mine,
});

const thread = (
  id: string,
  msgs: CommentThread['messages'],
  resolvedAt?: string,
): CommentThread => ({
  id,
  anchor: { levelId: 'lvl_ground', variant: 'after', at: { x: 0, y: 0 }, label: `Place ${id}` },
  resolved: resolvedAt ? { name: 'Wei Ling', at: resolvedAt } : null,
  messages: msgs,
});

describe('the comments list', () => {
  const doc: CommentsDoc = {
    version: 4,
    setting: 'all',
    threads: [
      thread('t_a', [msg('m1', '2026-11-06T09:00:00Z'), msg('m2', '2026-11-06T12:00:00Z', true)]),
      thread('t_b', [msg('m3', '2026-11-06T10:00:00Z')]),
      thread('t_c', [msg('m4', '2026-11-06T08:00:00Z')], '2026-11-06T11:00:00Z'),
      thread('t_d', [msg('m5', '2026-11-06T07:00:00Z')], '2026-11-06T13:00:00Z'),
      thread('t_e', [msg('m6', '2026-11-06T11:30:00Z', true)]),
    ],
  };

  it('lists open threads by last activity and resolved ones by when they were resolved', () => {
    const v = threadsView(doc, { all: 0, threads: {} });
    expect(v.open.map((i) => i.thread.id)).toEqual(['t_a', 't_e', 't_b']);
    expect(v.resolved.map((i) => i.thread.id)).toEqual(['t_d', 't_c']);
  });

  it("flags unread from others' messages only, since the panel or the thread was seen", () => {
    const seen = Date.parse('2026-11-06T09:30:00Z');
    const v = threadsView(doc, { all: seen, threads: {} });
    expect(v.open.map((i) => [i.thread.id, i.unread])).toEqual([
      ['t_a', false], // only my reply is newer
      ['t_e', false], // mine
      ['t_b', true],
    ]);
    expect(v.unread).toBe(1);
    const opened = threadsView(doc, {
      all: seen,
      threads: { t_b: Date.parse('2026-11-06T10:05:00Z') },
    });
    expect(opened.unread).toBe(0);
  });

  it('copies the open comments as text', () => {
    const text = commentsText(doc, true);
    expect(text.split('\n\n')).toHaveLength(3);
    expect(text.startsWith('Place t_a (After)\nMum: text m1\nMum: text m2')).toBe(true);
    expect(commentsText(doc, false)).not.toContain('(After)');
  });
});
