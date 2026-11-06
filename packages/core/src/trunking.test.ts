import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { drawWall } from './commands';
import {
  addPoint,
  placePoint,
  pointWarnings,
  trunkingPath,
  trunkingStart,
  updatePoint,
} from './electrical';
import { blankProject } from './factory';
import { sampleFlatProject } from './fixtures/sampleFlat';
import { pointInPolygon } from './geometry';
import { type EditorDoc, dispatch, emptyHistory, undo } from './history';
import { planGeometry } from './plan';
import { roomShapes, syncRooms } from './rooms';
import type { ElecPoint, Level, Vec2 } from './schema';
import { shiftIds, shiftWall } from './shiftWall';
import {
  NO_LEDGE,
  autoRoute,
  axesOf,
  dragBend,
  draggedRoute,
  hasJog,
  legInto,
  movePathEnd,
  moveWithTrunking,
  nextBend,
  routeAlongWalls,
  simplifyPath,
  straightenedRoute,
  tidyRoute,
  wallsCrossed,
} from './trunking';

/** A 4 × 3 room, 100 mm walls centred on lines from (0, 0): inside faces at 0.05 in. */
function room(): Level {
  let s: EditorDoc = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
  const segs: [number, number, number, number][] = [
    [0, 0, 4, 0],
    [4, 0, 4, 3],
    [4, 3, 0, 3],
    [0, 3, 0, 0],
  ];
  for (const [ax, ay, bx, by] of segs) {
    const lvl = s.doc.levels[0] as Level;
    const r = drawWall(
      lvl,
      { point: { x: ax, y: ay } },
      { point: { x: bx, y: by } },
      { thickness: 0.1 },
    );
    s = dispatch(s, r.command);
  }
  return s.doc.levels[0] as Level;
}

/** Whether every leg runs along x or along y (within 1 mm). */
const square = (path: readonly Vec2[]) =>
  path.every((p, i) => {
    const q = path[i - 1];
    return !q || Math.abs(p.x - q.x) < 1e-3 || Math.abs(p.y - q.y) < 1e-3;
  });

const close = (p: Vec2 | undefined, x: number, y: number) => {
  expect(p?.x).toBeCloseTo(x, 6);
  expect(p?.y).toBeCloseTo(y, 6);
};

describe('nextBend', () => {
  const l = room();
  // On the top wall's hug line: its inside face at y 0.05, 50 mm off it.
  const from = { x: 1, y: 0.1 };

  it('goes square to the wall, along whichever axis is nearer the pointer, in 5 cm steps', () => {
    const along = nextBend(l, from, { x: 2.03, y: 0.4 });
    close(along?.at, 2.05, 0.1);
    expect(along?.snap).toBe('step');
    const down = nextBend(l, from, { x: 1.2, y: 1.62 });
    close(down?.at, 1, 1.6);
    // Nowhere to go: on the start.
    expect(nextBend(l, from, { x: 1.0004, y: 0.1 })).toBeNull();
  });

  it('within 0.3 m of a face it reaches, stops 50 mm short so the next leg hugs it', () => {
    // The right wall's inside face is at x 3.95: its hug line at 3.9.
    const b = nextBend(l, from, { x: 3.65, y: 0.3 });
    close(b?.at, 3.9, 0.1);
    expect(b?.snap).toBe('wall');
    // Further off than 0.3 m: no catch.
    close(nextBend(l, from, { x: 3.55, y: 0.3 })?.at, 3.55, 0.1);
    // Through the wall: 50 mm past its outside face (4.05), to run down the outside.
    close(nextBend(l, from, { x: 4.2, y: 0.2 })?.at, 4.1, 0.1);
    // Then down the right wall, stopping 50 mm off the bottom one (inside face 2.95).
    close(nextBend(l, { x: 3.9, y: 0.1 }, { x: 3.7, y: 2.75 })?.at, 3.9, 2.9);
  });

  it('lines up with the compressor when near level with it', () => {
    const b = nextBend(l, from, { x: 2.1, y: 0.5 }, { target: { x: 2.3, y: 2 } });
    close(b?.at, 2.3, 0.1);
    expect(b?.snap).toBe('target');
  });

  it('alt frees the angle', () => {
    const b = nextBend(l, from, { x: 2.33, y: 1.71 }, { alt: true });
    close(b?.at, 2.33, 1.71);
    expect(b?.snap).toBe('free');
    expect(square([from, b?.at as Vec2])).toBe(false);
  });
});

describe('legInto, tidyRoute and the rest', () => {
  const l = room();

  it('a leg into a fixed end gets a corner unless already square', () => {
    expect(legInto(l, { x: 1, y: 0.1 }, { x: 1, y: 2 })).toEqual([]);
    const [c] = legInto(l, { x: 1, y: 0.1 }, { x: 3, y: 2 });
    expect(square([{ x: 1, y: 0.1 }, c as Vec2, { x: 3, y: 2 }])).toBe(true);
    // Carrying on the way the run went (down) rather than turning first.
    const [c2] = legInto(l, { x: 1, y: 1 }, { x: 3, y: 2 }, { prev: { x: 1, y: 0.1 } });
    close(c2, 1, 2);
  });

  it('tidyRoute makes a crooked run square, its ends where they were, no wasted bends', () => {
    const crooked = [
      { x: 1, y: 0.1 },
      { x: 2.02, y: 0.17 },
      { x: 2.1, y: 1.0 },
      { x: 2.13, y: 1.97 },
      { x: 3.03, y: 2.1 },
      { x: 3.5, y: 2.5 },
    ];
    expect(square(crooked)).toBe(false);
    const tidy = tidyRoute(l, crooked, { end: true });
    expect(square(tidy)).toBe(true);
    close(tidy[0], 1, 0.1);
    close(tidy.at(-1), 3.5, 2.5);
    // No zero-length legs and no bend that doesn't turn.
    expect(simplifyPath(tidy)).toHaveLength(tidy.length);
    for (let i = 1; i < tidy.length; i++) {
      const a = tidy[i - 1] as Vec2;
      const b = tidy[i] as Vec2;
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(1e-3);
    }
    // Straight already: nothing changes.
    expect(tidyRoute(l, tidy, { end: true })).toEqual(tidy);
  });

  it('simplifyPath drops repeats and bends that go straight on', () => {
    expect(
      simplifyPath([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 1 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
    ]);
  });

  it('a moved end slides its bend; a dragged bend slides its neighbours, square either side', () => {
    const path = [
      { x: 1, y: 0.1 },
      { x: 3.9, y: 0.1 },
      { x: 3.9, y: 2.9 },
      { x: 2, y: 2.9 },
    ];
    const moved = movePathEnd(l, path, 'end', { x: 2, y: 2.5 });
    expect(moved).toEqual([
      { x: 1, y: 0.1 },
      { x: 3.9, y: 0.1 },
      { x: 3.9, y: 2.5 },
      { x: 2, y: 2.5 },
    ]);
    const dragged = dragBend(l, path, 2, { x: 3.5, y: 2.6 });
    expect(square(dragged)).toBe(true);
    close(dragged[1], 3.5, 0.1);
    close(dragged[2], 3.5, 2.6);
    close(dragged[3], 2, 2.6);
    // The compressor fixed: the bend slides along its leg instead.
    const fixed = dragBend(l, path, 2, { x: 3.5, y: 2.6 }, { fixedEnd: true });
    expect(square(fixed)).toBe(true);
    close(fixed[2], 3.5, 2.9);
    close(fixed[3], 2, 2.9);
  });
});

describe('moveWithTrunking', () => {
  it('a compressor dragged takes the last bend along; the run stays square', () => {
    const l = room();
    let s: EditorDoc = {
      doc: { ...blankProject('t', 'prj_t'), levels: [l] },
      history: emptyHistory(),
    };
    const lvl = () => s.doc.levels[0] as Level;
    const top = Object.values(l.walls).find(
      (w) => l.vertices[w.a]?.y === 0 && l.vertices[w.b]?.y === 0,
    );
    const ac = addPoint(l.id, {
      kind: 'aircon',
      wall: { wallId: top?.id as string, t: 0.25, side: 'left', height: 2.4 },
    });
    s = dispatch(s, ac.command);
    const side = (trunkingStart(lvl(), lvl().points[ac.pointId] as ElecPoint) as Vec2).y > 0;
    const y0 = side ? 0.1 : -0.1;
    const cu = addPoint(l.id, { kind: 'compressor', at: { x: 3.9, y: 2 } });
    s = dispatch(s, cu.command);
    s = dispatch(
      s,
      updatePoint(l.id, ac.pointId, { compressorId: cu.pointId, route: [{ x: 3.9, y: y0 }] }),
    );
    expect(square(trunkingPath(lvl(), lvl().points[ac.pointId] as ElecPoint))).toBe(true);
    s = dispatch(s, moveWithTrunking(lvl(), cu.pointId, { at: { x: 3.5, y: 2.2 } }));
    const path = trunkingPath(lvl(), lvl().points[ac.pointId] as ElecPoint);
    expect(square(path)).toBe(true);
    close(path.at(-1), 3.5, 2.2);
    s = undo(s);
    close(lvl().points[cu.pointId]?.at, 3.9, 2);
    expect(lvl().points[ac.pointId]?.route).toEqual([{ x: 3.9, y: y0 }]);
  });
});

describe('autoRoute: the sample flat', () => {
  const l = sampleFlatProject().levels[0] as Level;
  const shapes = roomShapes(l);
  const inRoom = (id: string, p: Vec2) => {
    const s = shapes.get(id);
    return !!s && pointInPolygon(p, s.outer);
  };
  // The main bedroom's aircon on the bed wall (where Suggest points puts it); the ledge's
  // compressor in its middle.
  const unit: ElecPoint = {
    id: 'ac',
    kind: 'aircon',
    wall: { wallId: 'w_bedroom_main-bedroom', t: 0.504, side: 'left', height: 2.4 },
  };
  const comp = { x: 1.3205, y: 6.6705 };

  it('reaches the ledge square, inside the flat, into the ledge through the wall that borders it', () => {
    const route = autoRoute(l, unit, comp);
    expect(route).not.toBeNull();
    const start = trunkingStart(l, unit) as Vec2;
    const path = [start, ...(route ?? []), comp];
    expect(square(path)).toBe(true);
    expect(inRoom('rm_main-bedroom', start)).toBe(true);
    expect(inRoom('rm_air-con-ledge', comp)).toBe(true);
    // Never on the façade: every bend in a room (the bedroom, then through to the ledge).
    for (const p of path) expect([...shapes.keys()].some((id) => inRoom(id, p))).toBe(true);
    for (const p of path) expect(inRoom('rm_household-shelter', p)).toBe(false);
    const crossings = path.slice(1).flatMap((p, i) => {
      const c = wallsCrossed(l, path[i] as Vec2, p);
      return c.map((w) => ({ ...w, leg: i }));
    });
    // No outside wall drilled; the last wall is the ledge's, which the bath borders.
    for (const c of crossings) expect(c.wallId).not.toMatch(/outside/);
    expect(crossings.at(-1)?.wallId).toBe('w_air-con-ledge_bath-wc-1');
    expect(crossings.at(-1)?.leg).toBe(path.length - 2);
    // The bedroom first: every bend before the first wall is in it.
    const out = crossings[0]?.leg ?? 0;
    for (const p of path.slice(0, out + 1)) expect(inRoom('rm_main-bedroom', p)).toBe(true);
    // Straight already: Straighten leaves it be.
    expect(tidyRoute(l, path, { end: true })).toEqual(path);
  });

  it('no inside route when the ledge borders no room it may go into: null', () => {
    // The bathroom the ledge borders made a household shelter (never drilled), and the
    // other bathroom's stretch of the ledge wall gone from reach the same way.
    const shut = structuredClone(l);
    for (const id of ['rm_bath-wc-1', 'rm_bath-wc-2']) {
      const r = shut.rooms[id];
      if (r) r.name = `Household shelter ${id}`;
    }
    expect(autoRoute(shut, unit, comp)).toBeNull();
  });

  it('no clean route (a unit on the outside of the flat): null', () => {
    const outside = {
      ...unit,
      wall: { wallId: 'w_main-bedroom_outside', t: 0.2, side: 'right' as const, height: 2.4 },
    };
    expect(autoRoute(l, outside, comp)).toBeNull();
  });

  it('routeAlongWalls: a new compressor on the ledge and the route, one undo step', () => {
    const project = sampleFlatProject();
    const lid = project.levels[0]?.id as string;
    const a = addPoint(lid, { kind: 'aircon', wall: unit.wall });
    let s: EditorDoc = dispatch({ doc: project, history: emptyHistory() }, a.command);
    // A crooked run by hand first.
    s = dispatch(s, updatePoint(lid, a.pointId, { route: [{ x: 2, y: 2.2 }] }));
    const level = () => s.doc.levels[0] as Level;
    const r = routeAlongWalls(level(), a.pointId);
    if ('error' in r) throw new Error(r.error);
    s = dispatch(s, r.command);
    const ac = level().points[a.pointId] as ElecPoint;
    expect(ac.compressorId).toBe(r.compressorId);
    const comp = level().points[ac.compressorId as string];
    expect(comp?.kind).toBe('compressor');
    expect(inRoom('rm_air-con-ledge', comp?.at as Vec2)).toBe(true);
    expect(square(trunkingPath(level(), ac))).toBe(true);
    s = undo(s);
    expect(Object.keys(level().points)).toEqual([a.pointId]);
    expect(level().points[a.pointId]?.route).toEqual([{ x: 2, y: 2.2 }]);
    // Nowhere to run to: why not, and nothing changes.
    const bare = structuredClone(level());
    for (const r of Object.values(bare.rooms)) if (r.name === 'Air-con ledge') r.name = 'Store';
    expect(routeAlongWalls(bare, a.pointId)).toEqual({ error: NO_LEDGE });
  });
});

describe('angled walls', () => {
  /** A 4 × 3 room with its top right corner cut off at 45°, 100 mm walls. */
  function cut(): Level {
    let s: EditorDoc = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
    const segs: [number, number, number, number][] = [
      [0, 0, 3, 0],
      [3, 0, 4, 1],
      [4, 1, 4, 3],
      [4, 3, 0, 3],
      [0, 3, 0, 0],
    ];
    for (const [ax, ay, bx, by] of segs) {
      const lvl = s.doc.levels[0] as Level;
      const r = drawWall(
        lvl,
        { point: { x: ax, y: ay } },
        { point: { x: bx, y: by } },
        { thickness: 0.1 },
      );
      s = dispatch(s, r.command);
    }
    return s.doc.levels[0] as Level;
  }
  const l = cut();
  const diag = {
    d: { x: Math.SQRT1_2, y: Math.SQRT1_2 },
    n: { x: -Math.SQRT1_2, y: Math.SQRT1_2 },
  };
  /** Square to x and y, or to the cut. */
  const squareHere = (path: readonly Vec2[]) =>
    path.every((p, i) => {
      const q = path[i - 1];
      if (!q) return true;
      const v = { x: p.x - q.x, y: p.y - q.y };
      return (
        Math.abs(v.x) < 1e-3 ||
        Math.abs(v.y) < 1e-3 ||
        Math.abs(v.x * diag.d.x + v.y * diag.d.y) < 1e-3 ||
        Math.abs(v.x * diag.n.x + v.y * diag.n.y) < 1e-3
      );
    });
  const through = (path: readonly Vec2[]) =>
    path.slice(1).flatMap((p, i) => wallsCrossed(l, path[i] as Vec2, p));

  it('a bend near the cut never runs out through a wall the pointer isn’t past', () => {
    // From beside the cut, the pointer down and right: the cut's own axis is nearest, which
    // runs into the x = 4 wall. It stops 50 mm (along its face's normal) short of it.
    const from = { x: 3.35, y: 0.5 };
    const b = nextBend(l, from, { x: 3.9, y: 2.95 });
    expect(b).not.toBeNull();
    expect(b?.at.x).toBeLessThan(3.95);
    expect(through([from, b?.at as Vec2])).toEqual([]);
    expect(b?.snap).toBe('wall');
  });

  it('Straighten: every leg square to the unit, the last leg or a wall; none leaves the room', () => {
    const start = { x: 1, y: 0.1 };
    // Crooked bends by the cut, the last near the y = 3 wall.
    const crooked = [start, { x: 3.3, y: 0.6 }, { x: 3.2, y: 2.7 }, { x: 1.2, y: 2.75 }];
    const tidy = tidyRoute(l, crooked, { axes: axesOf({ x: 1, y: 0 }) });
    expect(squareHere(tidy)).toBe(true);
    expect(through(tidy)).toEqual([]);
    close(tidy[0], 1, 0.1);
    // Already straight: left be.
    expect(tidyRoute(l, tidy, { axes: axesOf({ x: 1, y: 0 }) })).toEqual(tidy);
  });

  it('a leg square to the unit or the last leg stays, even at 45°', () => {
    // A unit on a 45° wall: its first leg along the cut's axis, the next square to that leg.
    const path = [
      { x: 1, y: 0.5 },
      { x: 2, y: 1.5 },
      { x: 2.5, y: 1 },
    ];
    expect(tidyRoute(l, path, { axes: diag })).toEqual(path);
  });
});

describe('dragging keeps the run square, and comes back as it was', () => {
  const l = room();
  const top = Object.values(l.walls).find(
    (w) => l.vertices[w.a]?.y === 0 && l.vertices[w.b]?.y === 0,
  );
  const setUp = () => {
    let s: EditorDoc = {
      doc: { ...blankProject('t', 'prj_t'), levels: [l] },
      history: emptyHistory(),
    };
    const lvl = () => s.doc.levels[0] as Level;
    const ac = addPoint(l.id, {
      kind: 'aircon',
      wall: { wallId: top?.id as string, t: 0.25, side: 'left', height: 2.4 },
    });
    s = dispatch(s, ac.command);
    const y0 = (trunkingStart(lvl(), lvl().points[ac.pointId] as ElecPoint) as Vec2).y;
    const cu = addPoint(l.id, { kind: 'compressor', at: { x: 2, y: 2.9 * Math.sign(y0) } });
    s = dispatch(s, cu.command);
    const route = [
      { x: 3.9, y: y0 },
      { x: 3.9, y: 2.9 * Math.sign(y0) },
    ];
    s = dispatch(s, updatePoint(l.id, ac.pointId, { compressorId: cu.pointId, route }));
    return { s, ac: ac.pointId, cu: cu.pointId, route, y: Math.sign(y0) };
  };

  it('a compressor dragged through a spot where a bend lines up, and back: no bend lost', () => {
    const { s: s0, ac, cu, route, y } = setUp();
    const level0 = s0.doc.levels[0] as Level;
    let s = s0;
    // Each move from the level as the drag began (as the Select tool does).
    for (const at of [
      { x: 3.9, y: 2 * y }, // in line with the last bend's leg: it would merge
      { x: 3, y: 2.5 * y },
      { x: 2, y: 2.9 * y }, // back where it began
    ]) {
      s = dispatch(s, moveWithTrunking(level0, cu, { at }), { coalesceKey: 'drag' });
      const lvl = s.doc.levels[0] as Level;
      expect(square(trunkingPath(lvl, lvl.points[ac] as ElecPoint))).toBe(true);
    }
    expect((s.doc.levels[0] as Level).points[ac]?.route).toEqual(route);
    // One undo step for the whole drag.
    expect(s.history.past.length - s0.history.past.length).toBe(1);
  });

  it('a unit dragged along its wall takes its first bend along, and back', () => {
    const { s: s0, ac, route } = setUp();
    const level0 = s0.doc.levels[0] as Level;
    const was = level0.points[ac]?.wall as NonNullable<ElecPoint['wall']>;
    let s = s0;
    for (const t of [0.5, 0.1, was.t]) {
      s = dispatch(s, moveWithTrunking(level0, ac, { wall: { ...was, t } }), {
        coalesceKey: 'drag',
      });
      const lvl = s.doc.levels[0] as Level;
      expect(square(trunkingPath(lvl, lvl.points[ac] as ElecPoint))).toBe(true);
    }
    expect((s.doc.levels[0] as Level).points[ac]?.route).toEqual(route);
  });

  it('a bend dragged near a face hugs it; its neighbours slide; the compressor stays', () => {
    const { s, ac } = setUp();
    const lvl = s.doc.levels[0] as Level;
    const unitPoint = lvl.points[ac] as ElecPoint;
    // The second bend dragged up and in, 0.2 m off the right wall: back onto its hug line.
    const route = draggedRoute(
      lvl,
      unitPoint,
      1,
      { x: 3.7, y: 2.5 * Math.sign(unitPoint.route?.[1]?.y ?? 1) },
      { snap: true },
    );
    const path = trunkingPath(
      { ...lvl, points: { ...lvl.points, [ac]: { ...unitPoint, route } } },
      { ...unitPoint, route },
    );
    expect(square(path)).toBe(true);
    expect(route[1]?.x).toBeCloseTo(3.9, 9);
    expect(path.at(-1)).toEqual(lvl.points[unitPoint.compressorId as string]?.at);
  });
});

describe('walls moved under a run', () => {
  const l = room();
  const wallAt = (lvl: Level, x0: number, y0: number, x1: number, y1: number) =>
    Object.values(lvl.walls).find((w) => {
      const a = lvl.vertices[w.a];
      const b = lvl.vertices[w.b];
      const is = (p: typeof a, x: number, y: number) =>
        !!p && Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9;
      return (is(a, x0, y0) && is(b, x1, y1)) || (is(a, x1, y1) && is(b, x0, y0));
    })?.id as string;
  const setUp = () => {
    const top = wallAt(l, 0, 0, 4, 0);
    let s: EditorDoc = {
      doc: { ...blankProject('t', 'prj_t'), levels: [l] },
      history: emptyHistory(),
    };
    const ac = addPoint(l.id, {
      kind: 'aircon',
      wall: { wallId: top, t: 0.25, side: 'left', height: 2.4 },
    });
    s = dispatch(s, ac.command);
    const lvl = () => s.doc.levels[0] as Level;
    const y0 = (trunkingStart(lvl(), lvl().points[ac.pointId] as ElecPoint) as Vec2).y;
    const k = Math.sign(y0);
    const cu = addPoint(l.id, { kind: 'compressor', at: { x: 2, y: 2.9 * k } });
    s = dispatch(s, cu.command);
    s = dispatch(
      s,
      updatePoint(l.id, ac.pointId, {
        compressorId: cu.pointId,
        route: [
          { x: 3.9, y: y0 },
          { x: 3.9, y: 2.9 * k },
        ],
      }),
    );
    return { s, ac: ac.pointId, k };
  };

  it('the wall the run hugs moves: the run moves with it, square', () => {
    const { s: s0, ac, k } = setUp();
    const lvl0 = s0.doc.levels[0] as Level;
    const right = wallAt(lvl0, 4, 0, 4, 3 * k);
    const s = dispatch(s0, shiftWall(lvl0, right, 0.4, shiftIds(lvl0, right)));
    const lvl = s.doc.levels[0] as Level;
    const w = lvl.walls[right] as Level['walls'][string];
    const x = (lvl.vertices[w.a] as Vec2).x;
    expect(Math.abs(x - 4)).toBeCloseTo(0.4, 9);
    const path = trunkingPath(lvl, lvl.points[ac] as ElecPoint);
    expect(square(path)).toBe(true);
    // Still 50 mm off the moved wall's inside face (x - 0.05).
    expect(path[1]?.x).toBeCloseTo(x - 0.1, 9);
    expect(path[2]?.x).toBeCloseTo(x - 0.1, 9);
    // And Straighten has nothing to do.
    expect(straightenedRoute(lvl, lvl.points[ac] as ElecPoint)).toBeNull();
  });

  it('the unit’s own wall moves: the first leg stays square, no jog for Straighten', () => {
    const { s: s0, ac, k } = setUp();
    const lvl0 = s0.doc.levels[0] as Level;
    const top = wallAt(lvl0, 0, 0, 4, 0);
    const s = dispatch(s0, shiftWall(lvl0, top, 0.11, shiftIds(lvl0, top)));
    const lvl = s.doc.levels[0] as Level;
    const unitPoint = lvl.points[ac] as ElecPoint;
    const path = trunkingPath(lvl, unitPoint);
    expect(
      Math.abs((path[0] as Vec2).y - (trunkingStart(lvl0, lvl0.points[ac] as ElecPoint) as Vec2).y),
    ).toBeCloseTo(0.11, 9);
    expect(square(path)).toBe(true);
    expect(path).toHaveLength(4);
    expect(straightenedRoute(lvl, unitPoint)).toBeNull();
    void k;
  });
});

describe('the way in, and rooms not to go through', () => {
  const l = sampleFlatProject().levels[0] as Level;
  const geom = planGeometry(l);
  it('a hand run’s way into the ledge never doubles back over its last leg', () => {
    // The last leg ran left along the main bedroom's top wall to its corner; the ledge's
    // compressor is to the right and far below.
    const prev = { x: 2.5, y: 0.2 };
    const from = { x: 0.35, y: 0.2 };
    const comp = { x: 1.3205, y: 6.6705 };
    const corner = legInto(l, from, comp, { geom, prev });
    const first = corner[0] as Vec2;
    // Not back along y = 0.2 towards x 1.32.
    expect(Math.abs(first.y - 0.2) > 1e-6 || first.x < from.x).toBe(true);
    const routed = legInto(l, from, comp, { geom, prev, alongWalls: true });
    const path = [prev, from, ...routed, comp];
    expect(square(path)).toBe(true);
    expect(path[2]?.x).toBeCloseTo(0.35, 9);
    // Through no door on the way.
    for (let i = 1; i < path.length; i++)
      for (const w of wallsCrossed(l, path[i - 1] as Vec2, path[i] as Vec2, geom))
        expect(w.through).not.toBe('door');
  });

  it('a unit in the household shelter: no route (its walls can’t be drilled)', () => {
    const placed = placePoint(l, 'aircon', { x: 7.2, y: 6.25 });
    if (!placed) throw new Error('no wall');
    const { at: _, ...wall } = placed;
    const inShelter: ElecPoint = { id: 'ac', kind: 'aircon', wall };
    expect(autoRoute(l, inShelter, { x: 1.3205, y: 6.6705 })).toBeNull();
    // Run by hand through its wall: a warning.
    const run: ElecPoint = {
      ...inShelter,
      compressorId: 'cu',
      route: [
        { x: 7.2, y: 8.5 },
        { x: 5.5, y: 8.5 },
      ],
    };
    const lvl = {
      ...l,
      points: {
        ac: run,
        cu: { id: 'cu', kind: 'compressor' as const, at: { x: 1.3205, y: 6.6705 } },
      },
    };
    expect(pointWarnings(lvl, run)).toContain('trunk-shelter');
  });

  it('Straighten brings a leg down the middle of a room onto a wall', () => {
    // From the bed wall, across the middle of the main bedroom and down to the ledge.
    const unitPoint: ElecPoint = {
      id: 'ac',
      kind: 'aircon',
      wall: { wallId: 'w_bedroom_main-bedroom', t: 0.504, side: 'left', height: 2.4 },
    };
    const start = trunkingStart(l, unitPoint) as Vec2;
    const crooked = [start, { x: 1.6, y: 1.7 }, { x: 1.55, y: 3.0 }, { x: 0.9, y: 3.1 }];
    const tidy = tidyRoute(l, crooked, { geom, axes: axesOf({ x: 0, y: 1 }) });
    expect(square(tidy)).toBe(true);
    // The leg down the room's middle (x ≈ 1.6) has moved onto a wall's hug line.
    const shapes = roomShapes(l);
    const bed = shapes.get('rm_main-bedroom')?.outer ?? [];
    for (const p of tidy) expect(pointInPolygon(p, bed)).toBe(true);
    const vertical = tidy
      .slice(1)
      .findIndex((p, i) => Math.abs(p.x - (tidy[i] as Vec2).x) < 1e-6 && i > 0);
    expect(vertical).toBeGreaterThanOrEqual(0);
    const legX = (tidy[vertical + 1] as Vec2).x;
    expect([0.35, 2.85].some((x) => Math.abs(legX - x) < 1e-6)).toBe(true);
  });
});

describe('QA round 2', () => {
  const l = sampleFlatProject().levels[0] as Level;
  const geom = planGeometry(l);
  const comp = { x: 1.3205, y: 6.6705 };
  const bedUnit: ElecPoint = {
    id: 'ac',
    kind: 'aircon',
    wall: { wallId: 'w_bedroom_main-bedroom', t: 0.504, side: 'left', height: 2.4 },
  };
  const xy = axesOf({ x: 1, y: 0 });

  it('an Alt bend stays where it is when the run ends on the ledge; the way in is square', () => {
    const start = trunkingStart(l, bedUnit) as Vec2;
    const alt = { x: 1.1, y: 3.05 };
    const way = legInto(l, alt, comp, { geom, prev: start, axes: xy, alongWalls: true });
    const path = simplifyPath([start, alt, ...way, comp]);
    expect(path[1]).toEqual(alt);
    expect(square(path.slice(1))).toBe(true);
  });

  it('Straighten after an Alt run: square, along the walls, through no doorway', () => {
    const run: ElecPoint = { ...bedUnit, compressorId: 'cu', route: [{ x: 1.1, y: 3.05 }] };
    const lvl: Level = {
      ...l,
      points: { ac: run, cu: { id: 'cu', kind: 'compressor', at: comp } },
    };
    const route = straightenedRoute(lvl, run, geom);
    expect(route).not.toBeNull();
    const path = [trunkingStart(lvl, run) as Vec2, ...(route ?? []), comp];
    expect(square(path)).toBe(true);
    for (let i = 1; i < path.length; i++)
      for (const w of wallsCrossed(lvl, path[i - 1] as Vec2, path[i] as Vec2, geom))
        expect(w.through).not.toBe('door');
    // Nothing more to do once straight.
    const done = { ...run, route: route ?? [] };
    expect(
      straightenedRoute({ ...lvl, points: { ...lvl.points, ac: done } }, done, geom),
    ).toBeNull();
  });

  it('a jog under 15 cm is taken out', () => {
    const r = room();
    const jog = [
      { x: 1, y: 0.1 },
      { x: 2, y: 0.1 },
      { x: 2, y: 1 },
      { x: 2.1, y: 1 },
      { x: 2.1, y: 2.9 },
      { x: 3, y: 2.9 },
    ];
    const tidy = tidyRoute(r, jog, { axes: xy });
    expect(square(tidy)).toBe(true);
    for (let i = 1; i < tidy.length; i++) {
      const a = tidy[i - 1] as Vec2;
      const b = tidy[i] as Vec2;
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(0.15);
    }
  });

  it('a second unit joins the first one’s trunk on its way to the ledge', () => {
    const first = autoRoute(l, bedUnit, comp, geom) ?? [];
    const a: ElecPoint = { ...bedUnit, compressorId: 'cu', route: first };
    const lvl: Level = { ...l, points: { ac: a, cu: { id: 'cu', kind: 'compressor', at: comp } } };
    const other: ElecPoint = {
      id: 'ac2',
      kind: 'aircon',
      wall: { wallId: 'w_main-bedroom_outside', t: 0.25, side: 'left', height: 2.4 },
    };
    const g = planGeometry(lvl);
    const second = autoRoute(lvl, other, comp, g);
    expect(second).not.toBeNull();
    const p1 = trunkingPath(lvl, a);
    const p2 = [trunkingStart(lvl, other) as Vec2, ...(second ?? []), comp];
    // Some stretch of the second run lies on the first's.
    let shared = 0;
    for (let i = 1; i < p2.length; i++) {
      const s = p2[i - 1] as Vec2;
      const t = p2[i] as Vec2;
      for (let k = 1; k < p1.length; k++) {
        const u = p1[k - 1] as Vec2;
        const v = p1[k] as Vec2;
        const sameX =
          Math.abs(s.x - t.x) < 1e-6 && Math.abs(u.x - v.x) < 1e-6 && Math.abs(s.x - u.x) < 1e-6;
        const sameY =
          Math.abs(s.y - t.y) < 1e-6 && Math.abs(u.y - v.y) < 1e-6 && Math.abs(s.y - u.y) < 1e-6;
        if (sameX)
          shared += Math.max(
            0,
            Math.min(Math.max(s.y, t.y), Math.max(u.y, v.y)) -
              Math.max(Math.min(s.y, t.y), Math.min(u.y, v.y)),
          );
        if (sameY)
          shared += Math.max(
            0,
            Math.min(Math.max(s.x, t.x), Math.max(u.x, v.x)) -
              Math.max(Math.min(s.x, t.x), Math.min(u.x, v.x)),
          );
      }
    }
    expect(shared).toBeGreaterThan(1);
  });
});

describe('QA round 3', () => {
  /** The sample with an aircon unit on the main bedroom's right wall, a quarter way down. */
  const withUnit = (route: Vec2[] | null) => {
    const project = sampleFlatProject();
    const lid = project.levels[0]?.id as string;
    let s: EditorDoc = { doc: project, history: emptyHistory() };
    const a = addPoint(lid, {
      kind: 'aircon',
      wall: { wallId: 'w_bedroom_main-bedroom', t: 0.25, side: 'left', height: 2.4 },
    });
    s = dispatch(s, a.command);
    const cu = addPoint(lid, { kind: 'compressor', at: { x: 1.891, y: 6.82 } });
    s = dispatch(s, cu.command);
    if (route) s = dispatch(s, updatePoint(lid, a.pointId, { route, compressorId: cu.pointId }));
    return { s, id: a.pointId, lid };
  };
  /** Bath/WC 1's right wall (x 2.397, 90 mm) hugged from inside: 2.397 - 0.045 - 0.05. */
  const BATH_HUG = 2.397 - 0.095;
  // Down its wall, over the door head, through Bath/WC 1 into the ledge (as routed before).
  const overDoor = [
    { x: 3.166, y: 2.998 },
    { x: 2.85, y: 2.998 },
    { x: 2.85, y: 4.222 },
    { x: BATH_HUG, y: 4.222 },
    { x: BATH_HUG, y: 6.274 },
    { x: 1.891, y: 6.274 },
  ];

  it('its wall moved 0.2 m left: no jog left behind, and Straighten finds nothing to do', () => {
    const { s: s0, id } = withUnit(overDoor);
    const l0 = s0.doc.levels[0] as Level;
    const wall = 'w_bedroom_main-bedroom';
    const s = dispatch(s0, shiftWall(l0, wall, 0.2, shiftIds(l0, wall)));
    const lvl = s.doc.levels[0] as Level;
    const u = lvl.points[id] as ElecPoint;
    const path = trunkingPath(lvl, u);
    // The unit moved with its wall (its face now 0.116 m from the door wall's).
    expect((path[0] as Vec2).x).toBeCloseTo(2.966, 3);
    expect(square(path)).toBe(true);
    expect(hasJog(path)).toBe(false);
    expect(straightenedRoute(lvl, u)).toBeNull();
  });

  it('a jog under 15 cm is not straight: Straighten takes it out', () => {
    const { s: s0, id } = withUnit(overDoor);
    const l0 = s0.doc.levels[0] as Level;
    const wall = 'w_bedroom_main-bedroom';
    const moved = dispatch(s0, shiftWall(l0, wall, 0.2, shiftIds(l0, wall)));
    // The run as it was left before: a 0.116 m jog where the faces step.
    const lvl0 = moved.doc.levels[0] as Level;
    const jogged = [{ x: 2.966, y: 2.998 }, ...overDoor.slice(1)];
    const unitPoint = { ...(lvl0.points[id] as ElecPoint), route: jogged };
    const lvl = { ...lvl0, points: { ...lvl0.points, [id]: unitPoint } };
    expect(hasJog(trunkingPath(lvl, unitPoint))).toBe(true);
    const fixed = straightenedRoute(lvl, unitPoint);
    expect(fixed).not.toBeNull();
    const after = { ...unitPoint, route: fixed ?? [] };
    const path = trunkingPath({ ...lvl, points: { ...lvl.points, [id]: after } }, after);
    expect(square(path)).toBe(true);
    expect(hasJog(path)).toBe(false);
  });

  it('with a trunk down the left wall, the unit joins it rather than going over the door', () => {
    const project = sampleFlatProject();
    const lid = project.levels[0]?.id as string;
    let s: EditorDoc = { doc: project, history: emptyHistory() };
    const level = () => s.doc.levels[0] as Level;
    const route = (wallId: string, t: number) => {
      const a = addPoint(lid, { kind: 'aircon', wall: { wallId, t, side: 'left', height: 2.4 } });
      s = dispatch(s, a.command);
      const r = routeAlongWalls(level(), a.pointId);
      if ('error' in r) throw new Error(r.error);
      s = dispatch(s, r.command);
      return trunkingPath(level(), level().points[a.pointId] as ElecPoint);
    };
    route('w_main-bedroom_outside', 0.2);
    const second = route('w_bedroom_main-bedroom', 0.25);
    expect(square(second)).toBe(true);
    // Down the left wall's hug line (x 0.35), not the door wall's (x 2.85).
    expect(second.some((p) => Math.abs(p.x - 0.35) < 1e-6)).toBe(true);
    expect(second.some((p) => Math.abs(p.x - 2.85) < 1e-6)).toBe(false);
  });
});

describe('straightenedRoute', () => {
  it('the new bends for a crooked run; null once straight or with nothing to straighten', () => {
    const l = room();
    const top = Object.values(l.walls).find(
      (w) => l.vertices[w.a]?.y === 0 && l.vertices[w.b]?.y === 0,
    );
    const unitPoint: ElecPoint = {
      id: 'ac',
      kind: 'aircon',
      wall: { wallId: top?.id as string, t: 0.25, side: 'left', height: 2.4 },
      compressorId: 'cu',
      route: [{ x: 2.6, y: 1.7 }],
    };
    const level: Level = {
      ...l,
      points: { ac: unitPoint, cu: { id: 'cu', kind: 'compressor', at: { x: 3.5, y: 2.5 } } },
    };
    const fixed = straightenedRoute(level, unitPoint);
    expect(fixed).not.toBeNull();
    const straight = { ...unitPoint, route: fixed ?? [] };
    const after = { ...level, points: { ...level.points, ac: straight } };
    expect(square(trunkingPath(after, straight))).toBe(true);
    expect(straightenedRoute(after, straight)).toBeNull();
    // No run at all: nothing to straighten.
    const bare = { ...unitPoint, route: undefined, compressorId: undefined };
    expect(straightenedRoute({ ...level, points: { ac: bare } }, bare)).toBeNull();
  });
});

describe('autoRoute on a big plan', () => {
  it('a 16 × 16 grid of rooms (612 walls) routes in well under a second', () => {
    const n = 17;
    const base = blankProject('big', 'prj_big').levels[0] as Level;
    const vertices: Level['vertices'] = {};
    const walls: Level['walls'] = {};
    const v = (i: number, j: number) => `v${i}_${j}`;
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= n; j++) vertices[v(i, j)] = { id: v(i, j), x: i * 3, y: j * 3 };
    const wall = (a: string, b: string) => {
      const id = `w_${a}_${b}`;
      walls[id] = {
        id,
        a,
        b,
        thickness: 0.1,
        materialLeft: 'paint-white',
        materialRight: 'paint-white',
      };
    };
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= n; j++) {
        if (i < n) wall(v(i, j), v(i + 1, j));
        if (j < n) wall(v(i, j), v(i, j + 1));
      }
    expect(Object.keys(walls).length).toBe(612);
    let level = produce({ ...base, vertices, walls }, (d) => syncRooms(d));
    const ledgeRoom = Object.values(level.rooms).find((r) =>
      pointInPolygon({ x: 1.5, y: 1.5 }, roomShapes(level).get(r.id)?.outer ?? []),
    );
    level = produce(level, (d) => {
      const r = d.rooms[ledgeRoom?.id as string];
      if (r) r.name = 'Air-con ledge';
    });
    // The unit four rooms along and three down; the compressor in the corner ledge.
    const placed = placePoint(level, 'aircon', { x: 13.5, y: 9.1 });
    if (!placed) throw new Error('no wall');
    const { at: _, ...wallPlace } = placed;
    const unitPoint: ElecPoint = { id: 'ac', kind: 'aircon', wall: wallPlace };
    const geom = planGeometry(level);
    const times: number[] = [];
    let route: Vec2[] | null = null;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      route = autoRoute(level, unitPoint, { x: 1.5, y: 1.5 }, geom);
      times.push(performance.now() - t0);
    }
    // The median, so a busy machine's one slow run doesn't decide it.
    const ms = times.sort((a, b) => a - b)[2] as number;
    expect(route).not.toBeNull();
    const path = [trunkingStart(level, unitPoint) as Vec2, ...(route ?? []), { x: 1.5, y: 1.5 }];
    expect(square(path)).toBe(true);
    // 400 ms is the bound; a shared CI runner gets three times that unless PERF is set.
    expect(ms).toBeLessThan(process.env.PERF ? 400 : 1200);
  });
});
