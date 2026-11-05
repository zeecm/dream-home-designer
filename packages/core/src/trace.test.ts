import { describe, expect, it } from 'vitest';
import { blankProject, emptyLevel } from './factory';
import { dispatch, emptyHistory, undo } from './history';
import { newId } from './ids';
import { roomArea } from './rooms';
import { PlanReading, importTrace, readingToPlan, tracedLevel } from './trace';

// 100 px to the metre, the image's top left at the plan's origin.
const u = { assetKey: 'k', opacity: 0.5, rotation: 0, origin: { x: 0, y: 0 }, scale: 0.01 };

/** A 4 × 3 m room read a little roughly, a bedroom 2 × 3 beside it, a door between. */
const reading: PlanReading = PlanReading.parse({
  walls: [
    { a: { x: 0, y: 0 }, b: { x: 603, y: 2 }, thickness: 19 },
    { a: { x: 600, y: 0 }, b: { x: 601, y: 304 }, thickness: 21 },
    { a: { x: 604, y: 300 }, b: { x: 0, y: 298 }, thickness: 20 },
    { a: { x: 2, y: 302 }, b: { x: 0, y: 3 }, thickness: 20 },
    // The partition stops 8 cm short of the front wall and runs into the back one.
    { a: { x: 401, y: 8 }, b: { x: 399, y: 297 }, thickness: 11 },
  ],
  openings: [
    { kind: 'door', a: { x: 400, y: 100 }, b: { x: 400, y: 190 } },
    { kind: 'window', a: { x: 100, y: 0 }, b: { x: 250, y: 0 } },
  ],
  rooms: [
    { name: 'Living', at: { x: 200, y: 150 } },
    { name: 'Bedroom', at: { x: 500, y: 150 } },
  ],
  printedArea: 18,
});

describe('readingToPlan', () => {
  it('straightens, joins corners and takes a wall end onto the wall it stops short of', () => {
    const plan = readingToPlan(reading, u);
    expect(plan.walls).toHaveLength(5);
    for (const w of plan.walls) {
      expect(Math.abs(w.a.x - w.b.x) < 1e-9 || Math.abs(w.a.y - w.b.y) < 1e-9).toBe(true);
    }
    // The four outer corners are shared exactly.
    const corners = new Set(plan.walls.flatMap((w) => [w.a, w.b]).map((p) => `${p.x},${p.y}`));
    expect(corners.size).toBeLessThanOrEqual(6);
    const part = plan.walls[4]!;
    expect(Math.min(part.a.y, part.b.y)).toBeCloseTo(plan.walls[0]!.a.y, 6);
    // Standard thicknesses.
    expect(plan.walls.map((w) => w.thickness)).toEqual([0.2, 0.2, 0.2, 0.2, 0.1]);
  });
});

describe('tracedLevel and importTrace', () => {
  it('draws two rooms named from their labels, with the door and window on their walls', () => {
    let s = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
    const level = s.doc.levels[0] ?? emptyLevel();
    const { level: traced, skipped } = tracedLevel(level, readingToPlan(reading, u), newId);
    expect(skipped).toBe(0);
    s = dispatch(s, importTrace(level.id, traced));
    const lvl = s.doc.levels[0]!;
    const rooms = Object.values(lvl.rooms);
    expect(rooms.map((r) => r.name).sort()).toEqual(['Bedroom', 'Living']);
    const living = rooms.find((r) => r.name === 'Living')!;
    expect(roomArea(lvl, living)).toBeCloseTo(4 * 3, 0);
    const ops = Object.values(lvl.openings);
    expect(ops.map((o) => o.kind).sort()).toEqual(['door', 'window']);
    expect(ops.find((o) => o.kind === 'door')?.width).toBeCloseTo(0.9, 1);
    // One undo step takes it all back.
    s = undo(s);
    expect(Object.keys(s.doc.levels[0]!.walls)).toHaveLength(0);
  });
});

describe('readingToPlan, as models draw walls', () => {
  const box = (extra: PlanReading['walls'], openings: PlanReading['openings'] = []) =>
    readingToPlan(
      PlanReading.parse({
        walls: [
          { a: { x: 0, y: 0 }, b: { x: 400, y: 0 }, thickness: 20 },
          { a: { x: 400, y: 0 }, b: { x: 400, y: 300 }, thickness: 20 },
          { a: { x: 0, y: 300 }, b: { x: 400, y: 300 }, thickness: 20 },
          ...extra,
        ],
        openings,
        rooms: [],
      }),
      u,
    );

  it('makes the two faces of a thick wall one centre line, as thick as the gap', () => {
    const plan = box([
      { a: { x: -10, y: 0 }, b: { x: -10, y: 300 }, thickness: 2 },
      { a: { x: 10, y: 0 }, b: { x: 10, y: 300 }, thickness: 2 },
    ]);
    expect(plan.walls).toHaveLength(4);
    const left = plan.walls.find((w) => w.a.x === w.b.x && w.a.x < 1)!;
    expect(left.a.x).toBeCloseTo(0, 6);
    expect(left.thickness).toBeCloseTo(0.2, 6);
  });

  it('joins a wall broken at its door, and swings the door the way the plan shows', () => {
    const plan = box(
      [
        { a: { x: 0, y: 0 }, b: { x: 0, y: 100 }, thickness: 20 },
        { a: { x: 0, y: 190 }, b: { x: 0, y: 300 }, thickness: 20 },
      ],
      [
        {
          kind: 'door',
          a: { x: 0, y: 100 },
          b: { x: 0, y: 190 },
          hinge: { x: 0, y: 190 },
          arc: { x: 60, y: 130 },
        },
      ],
    );
    expect(plan.walls).toHaveLength(4);
    const { level } = tracedLevel(emptyLevel('lvl_t'), plan, newId);
    expect(Object.values(level.rooms)).toHaveLength(1);
    const door = Object.values(level.openings)[0]!;
    const w = level.walls[door.wallId]!;
    const a = level.vertices[w.a]!;
    const b = level.vertices[w.b]!;
    // Hinged at y = 1.9 (towards whichever end of the wall that is), opening to +x.
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const hingeAlong = (1.9 - a.y) * d.y;
    const arcSide = -(0.6 - a.x) * d.y + (1.3 - a.y) * d.x;
    expect(door.swing).toBe(
      `${hingeAlong > door.t * len ? 'right' : 'left'}${arcSide > 0 ? 'In' : 'Out'}`,
    );
    expect(door.swing?.endsWith(a.y < b.y ? 'Out' : 'In')).toBe(true);
  });
});
