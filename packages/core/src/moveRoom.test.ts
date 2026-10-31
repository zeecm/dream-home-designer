import { describe, expect, it } from 'vitest';
import { addOpening, drawWall } from './commands';
import { blankProject } from './factory';
import { addItem, furnitureKind, newItem } from './furniture';
import { pointInPolygon } from './geometry';
import { type EditorDoc, dispatch, emptyHistory, undo } from './history';
import { moveBlocked, moveRoom, moveTowards, planRoomMove, roomJoined } from './moveRoom';
import { roomArea } from './rooms';
import type { Level, Vec2 } from './schema';

/** Draws walls (0.1 m thick) from point lists, each a run of joined walls. */
function plan(...runs: Vec2[][]) {
  let s: EditorDoc = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
  const lvl = () => s.doc.levels[0] as Level;
  for (const run of runs) {
    for (let i = 0; i + 1 < run.length; i++) {
      const a = run[i] as Vec2;
      const b = run[i + 1] as Vec2;
      s = dispatch(s, drawWall(lvl(), { point: a }, { point: b }, { thickness: 0.1 }).command);
    }
  }
  /** The smallest room whose outline holds the point. */
  const roomWith = (p: Vec2) => {
    const l = lvl();
    const r = Object.values(l.rooms)
      .filter((r) =>
        pointInPolygon(
          p,
          r.loop.map((id) => l.vertices[id] as Vec2),
        ),
      )
      .sort((q, r) => roomArea(l, q) - roomArea(l, r))[0];
    if (!r) throw new Error(`no room at ${JSON.stringify(p)}`);
    return r;
  };
  return {
    lvl,
    roomWith,
    get s() {
      return s;
    },
    apply(cmd: Parameters<typeof dispatch>[1], key?: string) {
      s = dispatch(s, cmd, key ? { coalesceKey: key } : {});
    },
  };
}

const box = (x: number, y: number, w: number, h: number): Vec2[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
  { x, y },
];

const extent = (l: Level, ids: string[]) => {
  const vs = ids.map((id) => l.vertices[id] as Vec2);
  const xs = vs.map((v) => v.x);
  const ys = vs.map((v) => v.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};

describe('moveRoom', () => {
  it('moves a room standing alone with its furniture, keeping its name, in one undo step', () => {
    const f = plan(box(0, 0, 3, 2));
    const sofa = furnitureKind('sofa-3');
    if (!sofa) throw new Error('no sofa');
    f.apply(addItem(f.lvl().id, newItem('it_in', sofa, { x: 1.5, y: 1 })));
    f.apply(addItem(f.lvl().id, newItem('it_out', sofa, { x: 6, y: 1 })));
    const room = f.roomWith({ x: 1, y: 1 });
    const start = f.lvl();
    expect(roomJoined(start, room.id)).toBe(false);
    const set = planRoomMove(start, room.id, null);
    expect(set.vertices).toHaveLength(4);
    expect(set.items).toEqual(['it_in']);
    // Dispatched again and again as a drag goes on, from the same start.
    f.apply(moveRoom(start, set, { x: 0.5, y: 0 }), 'drag');
    f.apply(moveRoom(start, set, { x: 1, y: -0.5 }), 'drag');
    const l = f.lvl();
    const moved = l.rooms[room.id];
    expect(moved?.name).toBe(room.name);
    expect(extent(l, moved?.loop ?? [])).toEqual({ x0: 1, y0: -0.5, x1: 4, y1: 1.5 });
    expect(roomArea(l, moved ?? room)).toBeCloseTo(6, 6);
    expect(l.items.it_in?.position).toMatchObject({ x: 2.5, z: 0.5 });
    expect(l.items.it_out?.position).toMatchObject({ x: 6, z: 1 });
    expect(undo(f.s).doc.levels[0]?.items.it_in?.position).toMatchObject({ x: 1.5, z: 1 });
  });

  it('carries what stands inside it, and stretches its neighbour through the wall they share', () => {
    // Two rooms side by side, 3 m + 3 m by 4 m, and a closet standing in the left one.
    const g = plan(
      box(0, 0, 6, 4),
      [
        { x: 3, y: 0 },
        { x: 3, y: 4 },
      ],
      box(1, 1, 1, 1),
    );
    const left = g.roomWith({ x: 0.5, y: 0.5 });
    const right = g.roomWith({ x: 5, y: 2 });
    const start = g.lvl();
    expect(roomJoined(start, left.id)).toBe(true);
    const set = planRoomMove(start, left.id, 'x');
    // Its four corners and the closet's four.
    expect(set.vertices).toHaveLength(8);
    g.apply(moveRoom(start, set, { x: -0.5, y: 0 }));
    const l = g.lvl();
    expect(roomArea(l, l.rooms[right.id] ?? right)).toBeCloseTo(3.5 * 4, 6);
    expect(roomArea(l, l.rooms[left.id] ?? left)).toBeCloseTo(3 * 4 - 1, 6);
    const closet = Object.values(l.rooms).find((r) => r.id !== left.id && r.id !== right.id);
    expect(extent(l, closet?.loop ?? [])).toEqual({ x0: 0.5, y0: 1, x1: 1.5, y1: 2 });
  });

  it('keeps doors on the walls that follow where they were, measured from the far end', () => {
    const f = plan(box(0, 0, 6, 4), [
      { x: 3, y: 0 },
      { x: 3, y: 4 },
    ]);
    const l0 = f.lvl();
    // The right room's top wall, from x = 3 to 6: a door 1 m from its far corner (x = 6).
    const top = Object.values(l0.walls).find((w) => {
      const xs = [l0.vertices[w.a], l0.vertices[w.b]].map((v) => v?.x);
      const ys = [l0.vertices[w.a], l0.vertices[w.b]].map((v) => v?.y);
      return ys.every((y) => y === 0) && xs.includes(3) && xs.includes(6);
    });
    if (!top) throw new Error('no top wall');
    const aAt3 = l0.vertices[top.a]?.x === 3;
    const door = addOpening(l0.id, {
      wallId: top.id,
      kind: 'door',
      t: aAt3 ? 2 / 3 : 1 / 3,
      width: 0.8,
      height: 2.1,
      sill: 0,
    });
    f.apply(door.command);
    const left = f.roomWith({ x: 1, y: 2 });
    const start = f.lvl();
    f.apply(moveRoom(start, planRoomMove(start, left.id, 'x'), { x: 0.5, y: 0 }));
    const l = f.lvl();
    const w = l.walls[top.id];
    const o = l.openings[door.openingId];
    const a = w && l.vertices[w.a];
    const b = w && l.vertices[w.b];
    if (!o || !a || !b) throw new Error('lost the door');
    const centreX = a.x + (b.x - a.x) * o.t;
    expect(centreX).toBeCloseTo(5, 6);
  });

  it('stops short of walls in its way, and before a neighbour shrinks to nothing', () => {
    // Two boxes 1 m apart: the left one may come no nearer than the walls' half thicknesses.
    const f = plan(box(0, 0, 2, 2), box(3, 0, 2, 2));
    const left = f.roomWith({ x: 1, y: 1 });
    const start = f.lvl();
    const move = planRoomMove(start, left.id, null);
    expect(moveBlocked(start, move, { x: 0.8, y: 0 })).toBe(false);
    expect(moveBlocked(start, move, { x: 0.95, y: 0 })).toBe(true);
    // Pushed into it, it stops 10 cm short; pushed into it at a slant, it slides along it.
    const to = moveTowards(start, move, { x: 0, y: 0 }, { x: 2, y: 0 });
    expect(to.x).toBeCloseTo(0.9, 6);
    const slid = moveTowards(start, move, { x: 0, y: 0 }, { x: 2, y: 0.5 });
    expect(slid.x).toBeLessThan(0.91);
    expect(slid.y).toBeCloseTo(0.5, 6);
    // Two rooms sharing a wall: the left one can't squash the right one thinner than about
    // 0.3 m (its area over half its perimeter).
    const g = plan(box(0, 0, 6, 4), [
      { x: 3, y: 0 },
      { x: 3, y: 4 },
    ]);
    const gl = g.roomWith({ x: 1, y: 1 });
    const gs = g.lvl();
    const gm = planRoomMove(gs, gl.id, 'x');
    expect(moveBlocked(gs, gm, { x: 2.6, y: 0 })).toBe(false);
    expect(moveBlocked(gs, gm, { x: 2.75, y: 0 })).toBe(true);
    // Held to its axis: the part of a drag across it is ignored.
    expect(moveTowards(gs, gm, { x: 0, y: 0 }, { x: 0.5, y: 0.7 })).toEqual({ x: 0.5, y: 0 });
  });

  it('leaves a corner where a joined wall runs across the move, with a step, so no wall slants', () => {
    // A 6 by 3 m room with a 3 by 3 m room below its left half: the lower room's walls meet
    // the upper one's bottom wall at its left corner and at a T.
    const f = plan(box(0, 0, 6, 3), [
      { x: 0, y: 3 },
      { x: 0, y: 6 },
      { x: 3, y: 6 },
      { x: 3, y: 3 },
    ]);
    const upper = f.roomWith({ x: 4, y: 1 });
    const lower = f.roomWith({ x: 1, y: 5 });
    const start = f.lvl();
    expect(roomJoined(start, upper.id)).toBe(true);
    const move = planRoomMove(start, upper.id, 'x');
    // The left corner steps; the T stays as the bottom wall slides through it.
    expect(move.steps).toHaveLength(1);
    expect(move.vertices).toHaveLength(3);
    const square = (l: Level) =>
      Object.values(l.walls).every((w) => {
        const a = l.vertices[w.a] as Vec2;
        const b = l.vertices[w.b] as Vec2;
        return Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.y - b.y) < 1e-9;
      });
    for (const dx of [1, -1, 0.5]) {
      f.apply(moveRoom(start, move, { x: dx, y: 0 }), 'drag');
      const l = f.lvl();
      expect(square(l)).toBe(true);
      expect(roomArea(l, l.rooms[upper.id] ?? upper)).toBeCloseTo(18, 6);
      expect(roomArea(l, l.rooms[lower.id] ?? lower)).toBeCloseTo(9, 6);
      expect(l.rooms[upper.id]?.name).toBe(upper.name);
      expect(l.rooms[lower.id]?.name).toBe(lower.name);
    }
    // Turning to the other axis mid-drag, planned afresh: the first axis's step goes, and the
    // lower room's sides stretch.
    f.apply(moveRoom(start, planRoomMove(start, upper.id, 'y'), { x: 0, y: -0.5 }), 'drag');
    expect(Object.keys(f.lvl().walls).sort()).toEqual(Object.keys(start.walls).sort());
    expect(roomArea(f.lvl(), f.lvl().rooms[lower.id] ?? lower)).toBeCloseTo(10.5, 6);
    // Back to where it began: the step goes, leaving the plan as it was.
    f.apply(moveRoom(start, move, { x: 0, y: 0 }), 'drag');
    expect(Object.keys(f.lvl().walls).sort()).toEqual(Object.keys(start.walls).sort());
    // One undo step for the whole drag.
    expect(undo(f.s).doc.levels[0]?.walls).toEqual(start.walls);
  });

  /** Every wall runs straight across or straight down the plan. */
  const square = (l: Level) =>
    Object.values(l.walls).every((w) => {
      const a = l.vertices[w.a] as Vec2;
      const b = l.vertices[w.b] as Vec2;
      return Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.y - b.y) < 1e-9;
    });
  /** No two walls lie along each other (overlapping for more than a point). */
  const noOverlaps = (l: Level) => {
    const ws = Object.values(l.walls).map((w) => [l.vertices[w.a], l.vertices[w.b]] as Vec2[]);
    for (let i = 0; i < ws.length; i++) {
      for (let j = i + 1; j < ws.length; j++) {
        const [p, q] = ws[i] as Vec2[];
        const [r, t] = ws[j] as Vec2[];
        if (!p || !q || !r || !t) continue;
        const horizontal = p.y === q.y && r.y === t.y && p.y === r.y;
        const vertical = p.x === q.x && r.x === t.x && p.x === r.x;
        const [lo1, hi1, lo2, hi2] = horizontal
          ? [Math.min(p.x, q.x), Math.max(p.x, q.x), Math.min(r.x, t.x), Math.max(r.x, t.x)]
          : [Math.min(p.y, q.y), Math.max(p.y, q.y), Math.min(r.y, t.y), Math.max(r.y, t.y)];
        if ((horizontal || vertical) && Math.min(hi1, hi2) - Math.max(lo1, lo2) > 1e-9)
          return false;
      }
    }
    return true;
  };

  it('at a crossing of walls, the step never lies along another wall, and every room survives', () => {
    // Four 4 m rooms in a square: the top-left one moves right and down.
    const f = plan(
      box(0, 0, 8, 8),
      [
        { x: 4, y: 0 },
        { x: 4, y: 8 },
      ],
      [
        { x: 0, y: 4 },
        { x: 8, y: 4 },
      ],
    );
    const start = f.lvl();
    const names = Object.values(start.rooms).map((r) => [r.id, r.name]);
    const room = f.roomWith({ x: 1, y: 1 });
    for (const [axis, delta] of [
      ['x', { x: 0.5, y: 0 }],
      ['y', { x: 0, y: 1 }],
      ['x', { x: -0.5, y: 0 }],
    ] as const) {
      const move = planRoomMove(start, room.id, axis);
      expect(moveTowards(start, move, { x: 0, y: 0 }, delta)).toEqual(delta);
      f.apply(moveRoom(start, move, delta), 'drag');
      const l = f.lvl();
      expect(square(l)).toBe(true);
      expect(noOverlaps(l)).toBe(true);
      expect(Object.values(l.rooms).map((r) => [r.id, r.name])).toEqual(names);
      expect(roomArea(l, l.rooms[room.id] ?? room)).toBeCloseTo(16, 6);
    }
  });

  it('never squeezes a neighbour out, and a neighbour shrunk mid-drag keeps its name', () => {
    const f = plan(box(0, 0, 4, 2), [
      { x: 3, y: 0 },
      { x: 3, y: 2 },
    ]);
    const store = f.roomWith({ x: 3.5, y: 1 });
    f.apply({
      label: 'name it',
      recipe: (d) => {
        const r = d.levels[0]?.rooms[store.id];
        if (r) {
          r.name = 'Store';
          r.floorMaterial = 'tile-white';
        }
      },
    });
    const left = f.roomWith({ x: 1, y: 1 });
    const start = f.lvl();
    const move = planRoomMove(start, left.id, 'x');
    // The store stays wide enough to use: about 0.35 m (2 m long).
    const to = moveTowards(start, move, { x: 0, y: 0 }, { x: 2, y: 0 });
    expect(to.x).toBeCloseTo(0.64, 6);
    f.apply(moveRoom(start, move, to), 'drag');
    f.apply(moveRoom(start, move, { x: 0.3, y: 0 }), 'drag');
    const l = f.lvl();
    expect(l.rooms[store.id]).toMatchObject({ name: 'Store', floorMaterial: 'tile-white' });
    expect(roomArea(l, l.rooms[store.id] ?? store)).toBeCloseTo(1.4, 6);
  });

  it('takes a step back as it came: moving back closes the step up, one move after another', () => {
    // A 4 by 3 m room hanging below a long wall, the room's top corners T-junctions on it.
    const f = plan(
      [
        { x: -2, y: 0 },
        { x: 6, y: 0 },
      ],
      [
        { x: 0, y: 0 },
        { x: 0, y: 3 },
        { x: 4, y: 3 },
        { x: 4, y: 0 },
      ],
    );
    const room = f.roomWith({ x: 2, y: 1 });
    const start = f.lvl();
    const walls = Object.keys(start.walls).length;
    // As arrow keys do: each move planned afresh from the plan as it then is.
    const press = (axis: 'x' | 'y', delta: Vec2) => {
      const l = f.lvl();
      const move = planRoomMove(l, room.id, axis);
      const to = moveTowards(l, move, { x: 0, y: 0 }, delta);
      f.apply(moveRoom(l, move, to));
      return to;
    };
    expect(press('y', { x: 0, y: 0.1 })).toEqual({ x: 0, y: 0.1 });
    expect(Object.keys(f.lvl().walls).length).toBe(walls + 2);
    expect(press('y', { x: 0, y: -0.1 })).toEqual({ x: 0, y: -0.1 });
    expect(Object.keys(f.lvl().walls).length).toBe(walls);
    expect(square(f.lvl())).toBe(true);
    // Across and down, then back up and across: back as it began.
    press('x', { x: 0.01, y: 0 });
    press('y', { x: 0, y: 0.01 });
    expect(press('y', { x: 0, y: -0.01 })).toEqual({ x: 0, y: -0.01 });
    expect(press('x', { x: -0.01, y: 0 })).toEqual({ x: -0.01, y: 0 });
    const l = f.lvl();
    expect(Object.keys(l.walls).length).toBe(walls);
    expect(roomArea(l, l.rooms[room.id] ?? room)).toBeCloseTo(12, 6);
  });

  it('gives a step the side and faces of the wall it continues', () => {
    const f = plan(
      [
        { x: -2, y: 0 },
        { x: 6, y: 0 },
      ],
      [
        { x: 0, y: 3 },
        { x: 0, y: 0 },
      ],
      [
        { x: 0, y: 3 },
        { x: 4, y: 3 },
        { x: 4, y: 0 },
      ],
    );
    const room = f.roomWith({ x: 2, y: 1 });
    const l0 = f.lvl();
    // The room's left wall, drawn upwards, lies to its right of its line, with blue inside.
    const leftWall = Object.values(l0.walls).find(
      (w) => l0.vertices[w.a]?.x === 0 && l0.vertices[w.b]?.x === 0,
    );
    if (!leftWall) throw new Error('no left wall');
    f.apply({
      label: 'side',
      recipe: (d) => {
        const w = d.levels[0]?.walls[leftWall.id];
        if (w) {
          w.side = 'right';
          w.materialRight = 'paint-blue';
        }
      },
    });
    const start = f.lvl();
    const move = planRoomMove(start, room.id, 'y');
    f.apply(moveRoom(start, move, { x: 0, y: 0.5 }));
    const l = f.lvl();
    const step =
      l.walls[
        move.steps.find((s) => s.corner === leftWall.b || s.corner === leftWall.a)?.wall ?? ''
      ];
    const lw = l.walls[leftWall.id];
    if (!step || !lw) throw new Error('no step');
    const dir = (w: typeof lw) => {
      const a = l.vertices[w.a] as Vec2;
      const b = l.vertices[w.b] as Vec2;
      return { x: b.x - a.x, y: b.y - a.y };
    };
    expect(dir(step).x * dir(lw).x + dir(step).y * dir(lw).y).toBeGreaterThan(0);
    expect(step).toMatchObject({ side: 'right', materialRight: 'paint-blue' });
  });

  it('carries a door on its own wall past a T-junction on that wall', () => {
    // A 4 m room, a neighbour joined to its right wall at a T 2 m down, and a 0.8 m door
    // centred 0.6 m down that wall.
    const f = plan(box(0, 0, 4, 4), [
      { x: 4, y: 2 },
      { x: 6, y: 2 },
      { x: 6, y: 4 },
      { x: 4, y: 4 },
    ]);
    const l0 = f.lvl();
    const upper = Object.values(l0.walls).find((w) => {
      const ys = [l0.vertices[w.a]?.y, l0.vertices[w.b]?.y];
      return (
        l0.vertices[w.a]?.x === 4 && l0.vertices[w.b]?.x === 4 && ys.includes(0) && ys.includes(2)
      );
    });
    if (!upper) throw new Error('no wall');
    const door = addOpening(l0.id, {
      wallId: upper.id,
      kind: 'door',
      t: l0.vertices[upper.a]?.y === 0 ? 0.3 : 0.7,
      width: 0.8,
      height: 2.1,
      sill: 0,
    });
    f.apply(door.command);
    const room = f.roomWith({ x: 1, y: 1 });
    const start = f.lvl();
    const move = planRoomMove(start, room.id, 'y');
    // Down, the door goes with the room until it reaches the T.
    const down = moveTowards(start, move, { x: 0, y: 0 }, { x: 0, y: 2 });
    expect(down.y).toBeCloseTo(0.95, 6);
    // Up, it goes with the room.
    f.apply(moveRoom(start, move, { x: 0, y: -0.5 }));
    const l = f.lvl();
    const w = l.walls[upper.id];
    const o = l.openings[door.openingId];
    const a = w && l.vertices[w.a];
    const b = w && l.vertices[w.b];
    if (!o || !a || !b) throw new Error('lost the door');
    expect(a.y + (b.y - a.y) * o.t).toBeCloseTo(0.1, 6);
  });

  it('stops on a corner it reaches, not a few millimetres short of it', () => {
    // A room below a long wall whose T-junctions are off the centimetre grid: moved right,
    // its top-right corner reaches the long wall's end (at 6.004) exactly.
    const f = plan(
      [
        { x: -2, y: 0 },
        { x: 6.004, y: 0 },
        { x: 6.004, y: -3 },
      ],
      [
        { x: 0, y: 0 },
        { x: 0, y: 3 },
        { x: 4, y: 3 },
        { x: 4, y: 0 },
      ],
    );
    const room = f.roomWith({ x: 2, y: 1 });
    const start = f.lvl();
    const move = planRoomMove(start, room.id, 'x');
    const to = moveTowards(start, move, { x: 0, y: 0 }, { x: 3, y: 0 });
    expect(to.x).toBeCloseTo(2.004, 9);
    f.apply(moveRoom(start, move, to));
    const l = f.lvl();
    const shortest = Math.min(
      ...Object.values(l.walls).map((w) => {
        const a = l.vertices[w.a] as Vec2;
        const b = l.vertices[w.b] as Vec2;
        return Math.hypot(b.x - a.x, b.y - a.y);
      }),
    );
    expect(shortest).toBeGreaterThan(0.5);
  });
});
