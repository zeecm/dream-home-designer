import { type Level, dispatch, emptyHistory, hdb4RoomProject } from '@dhd/core';
import { expect, describe as group, it } from 'vitest';
import { cycle, describe, nudge, planObjects } from './keyboard';

const hdb4RoomLevel = (): Level => {
  const level = hdb4RoomProject().levels[0];
  if (!level) throw new Error('fixture');
  return level;
};

const run = (level: Level, cmds: ReturnType<typeof nudge>): Level => {
  let s = { doc: { ...hdb4RoomProject(), levels: [level] }, history: emptyHistory() };
  for (const c of cmds) s = dispatch(s, c);
  return s.doc.levels[0] as Level;
};

group('planObjects', () => {
  it('lists every object once, rooms first and corners last', () => {
    const level = hdb4RoomLevel();
    const objs = planObjects(level);
    const total =
      Object.keys(level.rooms).length +
      Object.keys(level.walls).length +
      Object.keys(level.openings).length +
      Object.keys(level.vertices).length;
    expect(objs).toHaveLength(total);
    expect(objs[0]?.kind).toBe('room');
    expect(objs.at(-1)?.kind).toBe('vertex');
  });
});

group('cycle', () => {
  const objs = [
    { kind: 'room' as const, id: 'a' },
    { kind: 'wall' as const, id: 'b' },
  ];
  it('starts at either end and stops past the other', () => {
    expect(cycle(objs, null, false)).toEqual(objs[0]);
    expect(cycle(objs, null, true)).toBeNull();
    expect(cycle(objs, objs[0] ?? null, false)).toEqual(objs[1]);
    expect(cycle(objs, objs[1] ?? null, false)).toBeNull();
    expect(cycle(objs, objs[0] ?? null, true)).toBeNull();
  });
});

group('nudge', () => {
  it('moves both ends of a wall', () => {
    const level = hdb4RoomLevel();
    const w = level.walls.w_mid_3;
    if (!w) throw new Error('fixture');
    const next = run(level, nudge(level, { kind: 'wall', id: 'w_mid_3' }, { x: 0, y: 0.1 }));
    expect(next.vertices[w.a]?.y).toBeCloseTo((level.vertices[w.a]?.y ?? 0) + 0.1);
    expect(next.vertices[w.b]?.y).toBeCloseTo((level.vertices[w.b]?.y ?? 0) + 0.1);
  });

  it('slides an opening along its wall and ignores movement across it', () => {
    const level = hdb4RoomLevel();
    const [id, o] = Object.entries(level.openings)[0] ?? [];
    if (!id || !o) throw new Error('fixture');
    const w = level.walls[o.wallId];
    const a = w && level.vertices[w.a];
    const b = w && level.vertices[w.b];
    if (!a || !b) throw new Error('fixture');
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const along = { x: ((b.x - a.x) / len) * 0.1, y: ((b.y - a.y) / len) * 0.1 };
    const across = { x: -along.y, y: along.x };
    expect(nudge(level, { kind: 'opening', id }, across)).toEqual([]);
    const next = run(level, nudge(level, { kind: 'opening', id }, along));
    expect((next.openings[id]?.t ?? 0) * len).toBeCloseTo(o.t * len + 0.1);
  });

  it('does not move rooms', () => {
    const level = hdb4RoomLevel();
    const id = Object.keys(level.rooms)[0] ?? '';
    expect(nudge(level, { kind: 'room', id }, { x: 1, y: 0 })).toEqual([]);
  });
});

group('describe', () => {
  it('names walls by the rooms beside them and their length', () => {
    const level = hdb4RoomLevel();
    expect(describe(level, { kind: 'wall', id: 'w_mid_3' })).toMatch(
      /^Wall between Bedroom 2 and Kitchen, 2(\.00)? m long$/,
    );
  });
});
