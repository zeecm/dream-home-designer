import { describe, expect, it } from 'vitest';
import { addOpening, drawWall, updateWall } from './commands';
import { blankProject } from './factory';
import { hdb4RoomLevel, hdb4RoomProject } from './fixtures/hdb4room';
import { wallFootprints } from './footprints';
import { signedArea } from './geometry';
import { type EditorDoc, dispatch, emptyHistory } from './history';
import { loadProject } from './migrate';
import {
  DOOR_LEAF_THICKNESS,
  doorLeaf,
  doorSwing,
  framePoint,
  openingClearances,
  placeOpening,
  planGeometry,
} from './plan';
import { type Level, SCHEMA_VERSION, type Vec2, type Wall, isBoundary } from './schema';
import { snapPoint } from './snap';

const area = (p: { x: number; y: number }[]) => Math.abs(signedArea(p));

describe('planGeometry', () => {
  const level = hdb4RoomLevel();
  const g = planGeometry(level);

  it('cuts every opening out of its wall', () => {
    expect(g.openings).toHaveLength(Object.keys(level.openings).length);
    // w_front_l (5 m, 0.2 thick) has the 1 m main door at t = 0.25: two solid pieces.
    const front = g.pieces.filter((p) => p.wallId === 'w_front_l');
    expect(front).toHaveLength(2);
  });

  it('solid pieces plus gaps cover exactly the mitred outline', () => {
    const fp = g.footprints.walls.w_front_l!;
    const outline = area([fp.aL, fp.bL, fp.bR, fp.aR]);
    const solid = g.pieces
      .filter((p) => p.wallId === 'w_front_l')
      .reduce((s, p) => s + area(p.polygon), 0);
    const gaps = g.openings
      .filter((o) => o.wallId === 'w_front_l')
      .reduce((s, o) => s + area(o.polygon), 0);
    expect(solid + gaps).toBeCloseTo(outline, 9);
    expect(gaps).toBeCloseTo(1 * 0.2, 9);
  });
});

describe('doorSwing', () => {
  const level = hdb4RoomLevel();
  const g = planGeometry(level);
  const door = g.openings.find((o) => o.opening.id === 'op_master')!; // on w_mid_4, v10 -> v3, +x

  it('hinges on the chosen jamb and opens a quarter circle to the chosen side', () => {
    for (const swing of ['leftIn', 'leftOut', 'rightIn', 'rightOut'] as const) {
      const s = doorSwing(door.frame, { ...door.opening, swing });
      expect(Math.hypot(s.leafEnd.x - s.hinge.x, s.leafEnd.y - s.hinge.y)).toBeCloseTo(0.9);
      expect(Math.hypot(s.arcEnd.x - s.hinge.x, s.arcEnd.y - s.hinge.y)).toBeCloseTo(0.9);
      const side = swing.endsWith('In') ? 1 : -1;
      // The wall runs along +x with left normal +y, so In opens to +y.
      expect(Math.sign(s.leafEnd.y - 4.5)).toBe(side);
      const hingeX = swing.startsWith('left') ? 7.35 : 8.25;
      expect(s.hinge.x).toBeCloseTo(hingeX);
    }
  });

  it('picks the sweep that draws the short arc', () => {
    const s = doorSwing(door.frame, { ...door.opening, swing: 'leftIn' });
    // leaf points +y from the hinge, the far jamb is +x: rotating +y to +x is clockwise in
    // maths terms (negative cross), so sweep 0.
    expect(s.sweep).toBe(0);
    expect(framePoint(door.frame, 0, 0)).toEqual({ x: 7, y: 4.5 });
  });
});

describe('doorLeaf', () => {
  const door = planGeometry(hdb4RoomLevel()).openings.find((o) => o.opening.id === 'op_master')!;

  it('stands open square to the wall from the hinge, as the plan symbol shows it', () => {
    for (const swing of ['leftIn', 'leftOut', 'rightIn', 'rightOut'] as const) {
      const o = { ...door.opening, swing };
      const s = doorSwing(door.frame, o);
      const [h, end, , back] = doorLeaf(door.frame, o, true) as Vec2[];
      expect(h).toEqual(s.hinge);
      expect(end).toEqual(s.leafEnd);
      // Its thickness lies inside the doorway, towards the far jamb.
      expect(Math.hypot(back!.x - h!.x, back!.y - h!.y)).toBeCloseTo(DOOR_LEAF_THICKNESS);
      expect(Math.abs(back!.x - s.arcEnd.x)).toBeLessThan(Math.abs(h!.x - s.arcEnd.x));
    }
  });

  it('shuts across the middle of the wall', () => {
    const leaf = doorLeaf(door.frame, door.opening, false);
    const ys = leaf.map((p) => p.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(DOOR_LEAF_THICKNESS);
    expect((Math.max(...ys) + Math.min(...ys)) / 2).toBeCloseTo(4.5);
    const xs = leaf.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.9);
  });
});

describe('placeOpening', () => {
  const g = planGeometry(hdb4RoomLevel());
  it('centres on the pointer on the nearest wall and records the side', () => {
    // Just inside the kitchen, under the front wall (y = 0) at x = 6.5, clear of its window.
    const p = placeOpening(g, { x: 6.5, y: 0.2 }, 1.2, 0.3)!;
    expect(p.wallId).toBe('w_front_r');
    expect(p.t * 6).toBeCloseTo(1.5); // 6.5 m is 1.5 m along the 6 m wall from x = 5
    expect(p.side).toBe(1); // +n of a +x wall is +y, into the flat
    expect(p.fits).toBe(true);
  });

  it('keeps the opening on the wall near its end and finds nothing far away', () => {
    const p = placeOpening(g, { x: 10.95, y: 0.1 }, 1.2, 0.3)!;
    expect(p.t * 6 + p.width / 2).toBeLessThanOrEqual(6 + 1e-9);
    expect(placeOpening(g, { x: 20, y: 20 }, 1.2, 0.3)).toBeNull();
  });
});

describe('room boundaries', () => {
  const split = () => {
    let s: EditorDoc = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
    const lvl = () => s.doc.levels[0] as Level;
    const draw = (a: Vec2, b: Vec2, kind?: 'boundary') => {
      s = dispatch(s, drawWall(lvl(), { point: a }, { point: b }, { kind }).command);
    };
    const c = [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 4 },
      { x: 0, y: 4 },
    ];
    for (let i = 0; i < 4; i++) draw(c[i] as Vec2, c[(i + 1) % 4] as Vec2);
    draw({ x: 2, y: 0 }, { x: 2, y: 4 }, 'boundary');
    const set = (n: EditorDoc) => {
      s = n;
    };
    return { s: () => s, lvl, set };
  };

  it('divides rooms without building a wall', () => {
    const { lvl } = split();
    const l = lvl();
    expect(Object.keys(l.rooms)).toHaveLength(2);
    const b = Object.values(l.walls).find((w) => isBoundary(w));
    expect(b).toBeDefined();
    const fp = wallFootprints(l);
    expect(fp.walls[b?.id ?? '']).toBeUndefined();
    const geom = planGeometry(l);
    expect(geom.boundaries).toEqual([b?.id]);
    expect(geom.pieces.some((p) => p.wallId === b?.id)).toBe(false);
    expect(geom.frames[b?.id ?? '']?.half).toBe(0);
    // The outer wall it meets stays straight: no hub at the T.
    expect(fp.hubs.filter((h) => h.vertexId === b?.a || h.vertexId === b?.b)).toEqual([]);
  });

  it('takes no openings, and loses them when a wall becomes a boundary', () => {
    const { s, lvl, set } = split();
    const b = Object.values(lvl().walls).find((w) => isBoundary(w)) as Wall;
    expect(placeOpening(planGeometry(lvl()), { x: 2, y: 2 }, 0.9, 0.3)?.wallId).not.toBe(b.id);
    const op = { wallId: b.id, kind: 'door' as const, t: 0.5, width: 0.9, height: 2.1, sill: 0 };
    expect(() => dispatch(s(), addOpening(lvl().id, op).command)).toThrow();

    set(dispatch(s(), updateWall(lvl().id, b.id, { kind: 'wall' })));
    expect(lvl().walls[b.id]?.kind).toBeUndefined();
    set(dispatch(s(), addOpening(lvl().id, op).command));
    expect(Object.keys(lvl().openings)).toHaveLength(1);
    set(dispatch(s(), updateWall(lvl().id, b.id, { kind: 'boundary' })));
    expect(Object.keys(lvl().openings)).toHaveLength(0);
  });

  it('migrates version-1 documents unchanged', () => {
    const v1 = { ...hdb4RoomProject(), schemaVersion: 1 };
    const { project } = loadProject(JSON.parse(JSON.stringify(v1)));
    expect(project.schemaVersion).toBe(SCHEMA_VERSION);
    expect(project.levels[0]?.walls).toEqual(hdb4RoomProject().levels[0]?.walls);
  });
});

describe('boundaries meeting walls (review round 4)', () => {
  const room = () => {
    let s: EditorDoc = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
    const lvl = () => s.doc.levels[0] as Level;
    const draw = (a: Vec2, b: Vec2, opts: { kind?: 'boundary'; thickness?: number } = {}) => {
      s = dispatch(s, drawWall(lvl(), { point: a }, { point: b }, opts).command);
    };
    const c = [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 4 },
      { x: 0, y: 4 },
    ];
    for (let i = 0; i < 4; i++) draw(c[i] as Vec2, c[(i + 1) % 4] as Vec2, { thickness: 0.2 });
    return {
      lvl,
      draw,
      apply: (cmd: Parameters<typeof dispatch>[1]) => {
        s = dispatch(s, cmd);
      },
    };
  };
  const centre = (l: Level, id: string) => {
    const o = l.openings[id] as { wallId: string; t: number };
    const w = l.walls[o.wallId] as Wall;
    const a = l.vertices[w.a] as Vec2;
    const b = l.vertices[w.b] as Vec2;
    return { x: a.x + (b.x - a.x) * o.t, y: a.y + (b.y - a.y) * o.t };
  };

  it('ending on a window snaps to its jamb instead of moving the window', () => {
    const r = room();
    const p = placeOpening(planGeometry(r.lvl()), { x: 3, y: 0.1 }, 2, 0.3);
    const op = addOpening(r.lvl().id, {
      wallId: p?.wallId as string,
      kind: 'window',
      t: p?.t as number,
      width: 2,
      height: 1.2,
      sill: 0.9,
    });
    r.apply(op.command);
    // The drawing snap moves an end inside the window to its nearer jamb (x = 4)...
    const end = snapPoint(r.lvl(), { x: 3.2, y: 0 }, { tolerance: 0.15 });
    expect(end.kind).toBe('wall');
    expect(end.point.x).toBeCloseTo(4);
    r.draw({ x: 4, y: 2 }, end.point, { kind: 'boundary' });
    // ...so the window stays where it was, whole.
    const at = centre(r.lvl(), op.openingId);
    expect(at.x).toBeCloseTo(3);
    expect(r.lvl().openings[op.openingId]?.width).toBeCloseTo(2);
    // The boundary met the facade at the window's right jamb.
    expect(Object.values(r.lvl().vertices).some((v) => Math.abs(v.x - 4) < 1e-9 && v.y === 0)).toBe(
      true,
    );
  });

  it('a split that still lands inside an opening keeps the corner where it was put', () => {
    // A straight wall crossing a door: no corner may move, or the drawn wall would bend.
    const r = room();
    r.draw({ x: 4, y: 0 }, { x: 4, y: 4 });
    const p = placeOpening(planGeometry(r.lvl()), { x: 4.1, y: 2 }, 0.9, 0.3);
    r.apply(
      addOpening(r.lvl().id, {
        wallId: p?.wallId as string,
        kind: 'door',
        t: p?.t as number,
        width: 0.9,
        height: 2.1,
        sill: 0,
      }).command,
    );
    r.draw({ x: 1, y: 2.1 }, { x: 7, y: 2.1 });
    for (const v of Object.values(r.lvl().vertices)) {
      if (Math.abs(v.x - 4) < 1e-9 && v.y > 0 && v.y < 4) expect(v.y).toBeCloseTo(2.1);
    }
  });

  it('drawing a wall along a boundary turns it into a wall', () => {
    const r = room();
    r.draw({ x: 3, y: 0 }, { x: 3, y: 4 }, { kind: 'boundary' });
    const b = Object.values(r.lvl().walls).find((w) => isBoundary(w)) as Wall;
    r.draw({ x: 3, y: 0 }, { x: 3, y: 4 }, { thickness: 0.1 });
    expect(r.lvl().walls[b.id]?.kind).toBeUndefined();
    expect(Object.values(r.lvl().walls).filter((w) => isBoundary(w))).toHaveLength(0);
  });
});

describe('placeOpening overlap', () => {
  it('does not fit where another opening already is', () => {
    const l = hdb4RoomLevel();
    const geom = planGeometry(l);
    const o = geom.openings[0];
    if (!o) throw new Error('fixture');
    const mid = framePoint(o.frame, (o.span[0] + o.span[1]) / 2, 0);
    expect(placeOpening(geom, mid, 0.9, 0.3)?.fits).toBe(false);
  });
});

describe('openingClearances', () => {
  it('measures the clear wall either side of a door from the inside corners', () => {
    let s: EditorDoc = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
    const lvl = () => s.doc.levels[0] as Level;
    const c = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 3 },
      { x: 0, y: 3 },
    ];
    for (let i = 0; i < 4; i++) {
      const a = c[i] as Vec2;
      const b = c[(i + 1) % 4] as Vec2;
      s = dispatch(s, drawWall(lvl(), { point: a }, { point: b }, { thickness: 0.2 }).command);
    }
    const bottom = Object.values(lvl().walls).find((w) => {
      const a = lvl().vertices[w.a];
      const b = lvl().vertices[w.b];
      return a && b && a.y === 0 && b.y === 0;
    });
    if (!bottom) throw new Error('no bottom wall');
    const f = planGeometry(lvl()).frames[bottom.id];
    if (!f) throw new Error('no frame');
    // A 0.9 m door centred 1 m from vertex a (which may be either end).
    const t = 1 / 4;
    const o = {
      id: 'op',
      wallId: bottom.id,
      kind: 'door' as const,
      t,
      width: 0.9,
      height: 2.1,
      sill: 0,
    };
    const { before, after } = openingClearances(f, o);
    // 4 m between centre lines, less half of each 0.2 m end wall: 3.8 m of clear wall.
    expect(before + after + 0.9).toBeCloseTo(3.8, 6);
    expect(before).toBeCloseTo(1 - 0.45 - 0.1, 6);
  });
});
