import { describe, expect, it } from 'vitest';
import { addOpening, drawWall } from './commands';
import { blankProject } from './factory';
import { type EditorDoc, dispatch, emptyHistory } from './history';
import { placeOpening, planGeometry } from './plan';
import type { Level, OpeningKind, Vec2 } from './schema';
import { WALKER_RADIUS, collisionSegments, rayDistance, walk, walkStart } from './walk';

/** Two 4 x 4 m rooms side by side, sharing the wall x = 4 (0.1 m thick). */
function twoRooms(between?: { kind: OpeningKind; width: number }): Level {
  let s: EditorDoc = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
  const lvl = () => s.doc.levels[0] as Level;
  const draw = (a: Vec2, b: Vec2) => {
    s = dispatch(s, drawWall(lvl(), { point: a }, { point: b }, { thickness: 0.1 }).command);
  };
  const c = [
    { x: 0, y: 0 },
    { x: 8, y: 0 },
    { x: 8, y: 4 },
    { x: 0, y: 4 },
  ];
  for (let i = 0; i < 4; i++) draw(c[i] as Vec2, c[(i + 1) % 4] as Vec2);
  draw({ x: 4, y: 0 }, { x: 4, y: 4 });
  if (between) {
    const p = placeOpening(planGeometry(lvl()), { x: 4, y: 2 }, between.width, 0.3);
    if (!p) throw new Error('no wall');
    const r = addOpening(lvl().id, {
      wallId: p.wallId,
      kind: between.kind,
      t: p.t,
      width: p.width,
      height: between.kind === 'window' ? 1.2 : 2.1,
      sill: between.kind === 'window' ? 0.9 : 0,
    });
    s = dispatch(s, r.command);
  }
  return lvl();
}

describe('walk', () => {
  it('stops a walker one radius short of a wall', () => {
    const segs = collisionSegments(twoRooms());
    const p = walk(segs, { x: 2, y: 2 }, { x: 5, y: 0 });
    // The wall's face is at x = 3.95.
    expect(p.x).toBeCloseTo(3.95 - WALKER_RADIUS, 5);
    expect(p.y).toBeCloseTo(2, 5);
  });

  it('slides along a wall when walking into it at an angle', () => {
    const segs = collisionSegments(twoRooms());
    const p = walk(segs, { x: 3.5, y: 1 }, { x: 1, y: 1 });
    expect(p.x).toBeLessThan(3.95 - WALKER_RADIUS + 1e-6);
    expect(p.y).toBeCloseTo(2, 5);
  });

  it('walks through a door or a passage, but not a window', () => {
    for (const kind of ['door', 'passage'] as const) {
      const segs = collisionSegments(twoRooms({ kind, width: 0.8 }));
      expect(walk(segs, { x: 2, y: 2 }, { x: 4, y: 0 }).x, kind).toBeCloseTo(6, 5);
    }
    const segs = collisionSegments(twoRooms({ kind: 'window', width: 1.2 }));
    expect(walk(segs, { x: 2, y: 2 }, { x: 4, y: 0 }).x).toBeLessThan(4);
  });

  it('does not tunnel through a thin wall in one big step', () => {
    const segs = collisionSegments(twoRooms());
    expect(walk(segs, { x: 3.7, y: 2 }, { x: 1.0, y: 0 }).x).toBeLessThan(4);
  });
});

describe('walkStart', () => {
  it('starts inside a room, clear of the walls', () => {
    const level = twoRooms();
    const start = walkStart(level);
    expect(start).not.toBeNull();
    const segs = collisionSegments(level);
    const at = start?.at as Vec2;
    expect(walk(segs, at, { x: 0, y: 0 })).toEqual(at);
  });

  it('faces the longest clear view', () => {
    // Each 4 x 4 room's longest view is a diagonal.
    const start = walkStart(twoRooms());
    expect((start?.heading ?? 0) % (Math.PI / 2)).toBeCloseTo(Math.PI / 4);
  });

  it('measures ray distances to walls', () => {
    const segs = collisionSegments(twoRooms());
    expect(rayDistance(segs, { x: 2, y: 2 }, { x: 1, y: 0 })).toBeCloseTo(1.95);
  });

  it('returns null for a plan without rooms', () => {
    expect(walkStart(blankProject('t', 'prj_t').levels[0] as Level)).toBeNull();
  });
});
