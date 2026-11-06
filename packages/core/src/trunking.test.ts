import { describe, expect, it } from 'vitest';
import { drawWall } from './commands';
import { addPoint, trunkingPath, trunkingStart, updatePoint } from './electrical';
import { blankProject } from './factory';
import { sampleFlatProject } from './fixtures/sampleFlat';
import { pointInPolygon } from './geometry';
import { type EditorDoc, dispatch, emptyHistory, undo } from './history';
import { roomShapes } from './rooms';
import type { ElecPoint, Level, Vec2 } from './schema';
import {
  autoRoute,
  dragBend,
  legInto,
  movePathEnd,
  moveWithTrunking,
  nextBend,
  routeAlongWalls,
  simplifyPath,
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

  it('reaches the ledge square, along the walls, through no wall but the way out', () => {
    const route = autoRoute(l, unit, comp);
    expect(route).not.toBeNull();
    const start = trunkingStart(l, unit) as Vec2;
    const path = [start, ...(route ?? []), comp];
    expect(square(path)).toBe(true);
    expect(inRoom('rm_main-bedroom', start)).toBe(true);
    expect(inRoom('rm_air-con-ledge', comp)).toBe(true);
    // Through walls only on the way out: out of the bedroom through its outside wall, then
    // onto the ledge (which the bedroom doesn't touch) through the ledge's.
    const crossings = path.slice(1).flatMap((p, i) => {
      const c = wallsCrossed(l, path[i] as Vec2, p);
      return c.map((w) => ({ ...w, leg: i }));
    });
    expect(crossings.map((c) => c.wallId)).toEqual([
      'w_main-bedroom_outside-2',
      'w_air-con-ledge_outside-3',
    ]);
    expect(crossings[0]?.through).toBe('window');
    // Straight already: Straighten leaves it be.
    expect(tidyRoute(l, path, { end: true })).toEqual(path);
    // Every bend before the way out is in the bedroom, 50 mm off a face.
    const out = crossings[0]?.leg ?? 0;
    for (const p of path.slice(0, out + 1)) expect(inRoom('rm_main-bedroom', p)).toBe(true);
    // Never into another room on the way.
    for (const p of path)
      for (const id of shapes.keys())
        if (id !== 'rm_main-bedroom' && id !== 'rm_air-con-ledge')
          expect(inRoom(id, p)).toBe(false);
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
    expect(r).not.toBeNull();
    s = dispatch(s, r?.command as NonNullable<typeof r>['command']);
    const ac = level().points[a.pointId] as ElecPoint;
    expect(ac.compressorId).toBe(r?.compressorId);
    const comp = level().points[ac.compressorId as string];
    expect(comp?.kind).toBe('compressor');
    expect(inRoom('rm_air-con-ledge', comp?.at as Vec2)).toBe(true);
    expect(square(trunkingPath(level(), ac))).toBe(true);
    s = undo(s);
    expect(Object.keys(level().points)).toEqual([a.pointId]);
    expect(level().points[a.pointId]?.route).toEqual([{ x: 2, y: 2.2 }]);
  });
});
