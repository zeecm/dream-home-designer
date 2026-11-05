import { describe, expect, it } from 'vitest';
import { hdb4RoomProject } from './fixtures/hdb4room';
import { dispatch, emptyHistory, undo } from './history';
import { type LayoutOp, adoptLayout, applyLayout, lockedWalls, planForModel } from './layouts';
import { renovationChanges } from './renovation';

const op = (o: Partial<LayoutOp> & Pick<LayoutOp, 'op'>): LayoutOp => ({
  wallId: null,
  openingId: null,
  a: null,
  b: null,
  height: null,
  t: null,
  width: null,
  style: null,
  at: null,
  name: null,
  ...o,
});

describe('suggested layouts', () => {
  const before = hdb4RoomProject().levels[0]!;

  it('locks outside walls; tells the model what is either side of each wall', () => {
    const locked = lockedWalls(before);
    expect(locked.has('w_front_l')).toBe(true);
    expect(locked.has('w_bed3_bed2')).toBe(false);
    const plan = planForModel(before);
    const w = plan.walls.find((x) => x.id === 'w_bed3_bed2')!;
    expect(w.between.sort()).toEqual(['Bedroom 2', 'Bedroom 3']);
    expect(plan.rooms.map((r) => r.name)).toContain('Master bedroom');
  });

  it('applies what it may and refuses the rest, in words', () => {
    const { level, refused } = applyLayout(before, [
      op({ op: 'remove_wall', wallId: 'w_bed3_bed2' }),
      op({ op: 'remove_wall', wallId: 'w_front_l' }),
      op({ op: 'half_wall', wallId: 'w_living_kitchen', height: 1 }),
      op({ op: 'rename_room', at: { x: 4, y: 7 }, name: 'Family room' }),
      op({ op: 'remove_wall', wallId: 'w_nope' }),
    ]);
    expect(level.walls.w_bed3_bed2).toBeUndefined();
    expect(level.walls.w_front_l).toBeDefined();
    expect(level.walls.w_living_kitchen?.height).toBe(1);
    expect(refused).toHaveLength(2);
    expect(refused[0]).toMatch(/^remove wall between .*outside.*: an outside/);
    expect(Object.values(level.rooms).some((r) => r.name === 'Family room')).toBe(true);
    // Its change list is the renovation's.
    const changes = renovationChanges(before, level);
    expect(changes.some((c) => c.kind === 'hack')).toBe(true);
  });

  it('keeps the shelter (labelled HS too) and bathrooms shut, however the model goes about it', () => {
    const hs = {
      ...before,
      rooms: { ...before.rooms, rm_bed3: { ...before.rooms.rm_bed3!, name: 'HS' } },
    };
    expect(lockedWalls(hs).has('w_bed3_bed2')).toBe(true);
    const { level, refused } = applyLayout(hs, [
      op({ op: 'add_door', wallId: 'w_bed3_bed2', t: 0.5, width: 0.8 }),
    ]);
    expect(Object.keys(level.openings)).toEqual(Object.keys(hs.openings));
    expect(refused).toHaveLength(1);
  });

  it('becomes the renovation in one undo step', () => {
    let s = { doc: hdb4RoomProject(), history: emptyHistory() };
    const { level } = applyLayout(s.doc.levels[0]!, [
      op({ op: 'remove_wall', wallId: 'w_bed3_bed2' }),
    ]);
    s = dispatch(s, adoptLayout(level.id, level));
    expect(s.doc.renovation?.levels[0]?.walls.w_bed3_bed2).toBeUndefined();
    expect(s.doc.levels[0]?.walls.w_bed3_bed2).toBeDefined();
    s = undo(s);
    expect(s.doc.renovation).toBeUndefined();
  });
});
