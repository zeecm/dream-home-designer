import { describe, expect, it } from 'vitest';
import {
  type ClearanceIssue,
  ZONE_MIN_DEPTH,
  bedSideRoom,
  chairsOf,
  clearanceIssues,
  clearanceZones,
  doorSweep,
  floorEdges,
  issueItem,
  zoneDepth,
  zoneShown,
} from './clearance';
import { addOpening, drawWall } from './commands';
import { blankProject } from './factory';
import { ledgeFlatLevel } from './fixtures/ledgeFlat';
import { furnitureKind, newItem, placeFurniture } from './furniture';
import { type EditorDoc, dispatch, emptyHistory } from './history';
import { doorSwing, planGeometry } from './plan';
import { type Item, Level, type Opening, type Vec2 } from './schema';

/** A 4 m square room, walls 100 mm thick on centre lines at 0 and 4. */
function room(): EditorDoc {
  let s: EditorDoc = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
  const pts: [number, number][] = [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
    [0, 0],
  ];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i] as [number, number];
    const [bx, by] = pts[i + 1] as [number, number];
    const lvl = s.doc.levels[0] as Level;
    s = dispatch(
      s,
      drawWall(lvl, { point: { x: ax, y: ay } }, { point: { x: bx, y: by } }, { thickness: 0.1 })
        .command,
    );
  }
  return s;
}

let n = 0;
/** The level with pieces added: [kind id, centre, rotation]. */
function withItems(level: Level, pieces: [string, Vec2, number?][]): Level {
  const items = { ...level.items };
  for (const [kindId, at, rot] of pieces) {
    const kind = furnitureKind(kindId);
    if (!kind) throw new Error(`no ${kindId}`);
    const it = newItem(`it_${++n}`, kind, at, rot ?? 0);
    items[it.id] = it;
  }
  return { ...level, items };
}
const level = (s: EditorDoc) => s.doc.levels[0] as Level;
const zones = (xs: ClearanceIssue[]) => xs.filter((x) => x.kind === 'zone');

describe('clearance checks', () => {
  it('a wardrobe needs 0.60 m in front: short at 0.32, fine at 0.60, turning with it', () => {
    const base = level(room());
    // Facing up (rotation π), its front 0.32 m from the top wall's face (y 0.05).
    const short = zones(
      clearanceIssues(withItems(base, [['wardrobe', { x: 2, y: 0.67 }, Math.PI]])),
    );
    expect(short).toHaveLength(1);
    const z = short[0];
    if (z?.kind !== 'zone') throw new Error('no zone');
    expect(z.need).toBeCloseTo(0.6);
    expect(z.have).toBeCloseTo(0.32, 3);
    expect(
      zones(clearanceIssues(withItems(base, [['wardrobe', { x: 2, y: 0.95 }, Math.PI]]))),
    ).toHaveLength(0);
    // Turned to face the left wall (front -x), 0.32 m from it.
    const turned = zones(
      clearanceIssues(withItems(base, [['wardrobe', { x: 0.67, y: 2 }, Math.PI / 2]])),
    );
    expect(turned).toHaveLength(1);
    expect(turned[0]?.kind === 'zone' && turned[0].have).toBeCloseTo(0.32, 3);
  });

  it('a bedside table in front blocks; a rug or a person does not', () => {
    const base = level(room());
    // Wardrobe on the top wall facing down: front at y 0.65.
    const blocked = clearanceIssues(
      withItems(base, [
        ['wardrobe', { x: 2, y: 0.35 }],
        ['bedside', { x: 2, y: 0.95 }],
      ]),
    );
    const z = zones(blocked)[0];
    expect(z?.kind === 'zone' && z.have).toBeCloseTo(0.1, 3);
    for (const free of ['rug', 'person']) {
      const ok = zones(
        clearanceIssues(
          withItems(base, [
            ['wardrobe', { x: 2, y: 0.35 }],
            [free, { x: 2, y: 1.1 }],
          ]),
        ),
      );
      expect(ok).toHaveLength(0);
    }
  });

  it('beds: a queen needs both sides, a single one', () => {
    const base = level(room());
    const queen = furnitureKind('bed-queen');
    if (!queen) throw new Error('no queen');
    // Left side 0.40 m from the left wall's face (x 0.05).
    const qx = 0.05 + 0.4 + queen.size.w / 2;
    const q = zones(clearanceIssues(withItems(base, [['bed-queen', { x: qx, y: 1.5 }]])));
    expect(q).toHaveLength(1);
    expect(q[0]?.kind === 'zone' && q[0].have).toBeCloseTo(0.4, 3);
    const single = furnitureKind('bed-single');
    if (!single) throw new Error('no single');
    const sx = 0.05 + single.size.w / 2 + 0.003;
    expect(
      zones(clearanceIssues(withItems(base, [['bed-single', { x: sx, y: 1.5 }]]))),
    ).toHaveLength(0);
  });

  it('bedSideRoom: both long sides of a bed as measured, short or not; nothing for other pieces', () => {
    const base = level(room());
    const queen = furnitureKind('bed-queen');
    const single = furnitureKind('bed-single');
    if (!queen || !single) throw new Error('no bed');
    const qx = 0.05 + 0.4 + queen.size.w / 2;
    const ql = withItems(base, [['bed-queen', { x: qx, y: 1.5 }]]);
    const q = bedSideRoom(ql, Object.values(ql.items).at(-1) as Item);
    expect(q.map((s) => s.side)).toEqual(['left', 'right']);
    expect(q.map((s) => s.have).sort()).toEqual([expect.closeTo(0.4, 3), 0.6]);
    expect(q.every((s) => s.need === 0.6)).toBe(true);
    // A single bed against the wall (3 mm off): that side is closed, though the check finds
    // nothing (one side is enough).
    const sl = withItems(base, [['bed-single', { x: 0.05 + single.size.w / 2 + 0.003, y: 1.5 }]]);
    const s = bedSideRoom(sl, Object.values(sl.items).at(-1) as Item);
    expect(s.map((x) => x.have).sort()).toEqual([expect.closeTo(0.003, 3), 0.6]);
    const wl = withItems(base, [['wardrobe', { x: 2, y: 2 }]]);
    expect(bedSideRoom(wl, Object.values(wl.items).at(-1) as Item)).toEqual([]);
  });

  it('a piece in a swinging door’s sweep blocks it; beside a sliding door it does not', () => {
    const s0 = room();
    const bottom = Object.values(level(s0).walls).find((w) => {
      const a = level(s0).vertices[w.a];
      const b = level(s0).vertices[w.b];
      return a && b && a.y === 4 && b.y === 4;
    });
    if (!bottom) throw new Error('no wall');
    const door = (style?: Opening['style'], swing: Opening['swing'] = 'leftIn') =>
      addOpening(level(s0).id, {
        wallId: bottom.id,
        kind: 'door',
        t: 0.5,
        width: 0.8,
        height: 2.1,
        sill: 0,
        swing,
        ...(style ? { style } : {}),
      });
    for (const style of [undefined, 'double', 'bifold'] as const) {
      let d = door(style);
      let s = dispatch(s0, d.command);
      let sweep = doorSweep(level(s), d.openingId);
      const cy = (sw: Vec2[][]) => sw.flat().reduce((t, p) => t + p.y, 0) / sw.flat().length;
      // Swinging into the room.
      if (cy(sweep) > 4) {
        d = door(style, 'leftOut');
        s = dispatch(s0, d.command);
        sweep = doorSweep(level(s), d.openingId);
      }
      const pts = sweep.flat();
      const c = { x: pts.reduce((t, p) => t + p.x, 0) / pts.length, y: cy(sweep) };
      const issues = clearanceIssues(withItems(level(s), [['armchair', c]]));
      expect(issues.some((i) => i.kind === 'door')).toBe(true);
    }
    const sliding = door('sliding');
    const s = dispatch(s0, sliding.command);
    // An armchair half a metre in from the wall, in front of the door.
    const issues = clearanceIssues(withItems(level(s), [['armchair', { x: 2, y: 3.95 - 0.9 }]]));
    expect(issues.some((i) => i.kind === 'door')).toBe(false);
  });

  it('pieces overlapping more than 40 mm; a chair under a table is fine', () => {
    const base = level(room());
    const sofa = furnitureKind('sofa-3');
    if (!sofa) throw new Error('no sofa');
    const over = (by: number) =>
      clearanceIssues(
        withItems(base, [
          ['sofa-3', { x: 2, y: 1.5 }],
          ['sofa-3', { x: 2, y: 1.5 + sofa.size.d - by }],
        ]),
      ).filter((i) => i.kind === 'overlap');
    expect(over(0.05)).toHaveLength(2);
    expect(over(0.03)).toHaveLength(0);
    const tucked = clearanceIssues(
      withItems(base, [
        ['dining-4', { x: 2, y: 2 }],
        ['dining-chair', { x: 1.6, y: 2.2 }, Math.PI],
      ]),
    ).filter((i) => i.kind === 'overlap');
    expect(tucked).toHaveLength(0);
  });

  it('a piece pushed into a wall; one placed against it is fine', () => {
    const base = level(room());
    const kind = furnitureKind('wardrobe');
    if (!kind) throw new Error('no wardrobe');
    const into = clearanceIssues(withItems(base, [['wardrobe', { x: 2, y: 0.05 + 0.3 - 0.04 }]]));
    const w = into.find((i) => i.kind === 'wall');
    expect(w?.kind === 'wall' && w.depth).toBeCloseTo(0.04, 3);
    const placed = placeFurniture(planGeometry(base), kind, { x: 2, y: 0.4 }, 0);
    const ok = clearanceIssues(withItems(base, [['wardrobe', placed.at, placed.rotation]]));
    expect(ok.some((i) => i.kind === 'wall')).toBe(false);
  });

  it('an L-shaped kitchen is fine; a galley 0.85 m wide is short at every cabinet', () => {
    const base = level(room());
    const top: [string, Vec2, number][] = [0.35, 0.95, 1.55].map((x) => [
      'kitchen-base',
      { x, y: 0.35 },
      0,
    ]);
    const left: [string, Vec2, number][] = [0.95, 1.55].map((y) => [
      'kitchen-base',
      { x: 0.35, y },
      -Math.PI / 2,
    ]);
    expect(zones(clearanceIssues(withItems(base, [...top, ...left])))).toHaveLength(0);
    // Facing the top run across 0.85 m.
    const facing: [string, Vec2, number][] = [0.35, 0.95, 1.55].map((x) => [
      'kitchen-base',
      { x, y: 0.65 + 0.85 + 0.3 },
      Math.PI,
    ]);
    const galley = zones(clearanceIssues(withItems(base, [...top, ...facing])));
    expect(galley).toHaveLength(6);
    for (const g of galley) expect(g.kind === 'zone' && g.have).toBeCloseTo(0.85, 3);
  });

  it('beds: bedside tables at the head don’t count; a single bed short both sides is one issue', () => {
    const base = level(room());
    const queen = furnitureKind('bed-queen');
    const side = furnitureKind('bedside');
    if (!queen || !side) throw new Error('no bed');
    // Headboard on the top wall, a bedside table each side at the head, 1 m clear beyond.
    const by = 0.05 + queen.size.d / 2;
    const hy = 0.05 + side.size.d / 2;
    const off = queen.size.w / 2 + side.size.w / 2;
    const tables = clearanceIssues(
      withItems(base, [
        ['bed-queen', { x: 2, y: by }],
        ['bedside', { x: 2 - off, y: hy }],
        ['bedside', { x: 2 + off, y: hy }],
      ]),
    );
    expect(zones(tables)).toHaveLength(0);
    // A single bed in a 1.3 m wide alcove: 0.2 m one side, 0.18 m the other: one line.
    const single = furnitureKind('bed-single');
    if (!single) throw new Error('no single');
    const lvl = withItems(base, [
      ['bed-single', { x: 0.05 + 0.2 + single.size.w / 2, y: 2 }],
      ['wardrobe', { x: 0.05 + 0.2 + single.size.w + 0.18 + 0.3, y: 2 }, Math.PI / 2],
    ]);
    const z = zones(clearanceIssues(lvl)).filter(
      (x) => x.kind === 'zone' && lvl.items[x.itemId]?.assetId === 'bed-single',
    );
    expect(z).toHaveLength(1);
    expect(z[0]?.kind === 'zone' && z[0].have).toBeCloseTo(0.2, 2);
  });

  it('a barn door’s slide is checked; a U kitchen’s facing arms are short', () => {
    const s0 = room();
    const bottom = Object.values(level(s0).walls).find((w) => {
      const a = level(s0).vertices[w.a];
      const b = level(s0).vertices[w.b];
      return a && b && a.y === 4 && b.y === 4;
    });
    if (!bottom) throw new Error('no wall');
    const d = addOpening(level(s0).id, {
      wallId: bottom.id,
      kind: 'door',
      t: 0.5,
      width: 0.8,
      height: 2.1,
      sill: 0,
      swing: 'leftIn',
      style: 'sliding',
    });
    const s = dispatch(s0, d.command);
    const sweep = doorSweep(level(s), d.openingId);
    expect(sweep.length).toBeGreaterThan(0);
    const pts = sweep.flat();
    const c = {
      x: pts.reduce((t, p) => t + p.x, 0) / pts.length,
      y: pts.reduce((t, p) => t + p.y, 0) / pts.length,
    };
    const issues = clearanceIssues(withItems(level(s), [['bedside', c]]));
    expect(issues.some((i) => i.kind === 'door')).toBe(true);

    // A U: top run, left leg, and a bottom arm facing the top run 0.85 m across.
    const base = level(room());
    const top: [string, Vec2, number][] = [0.35, 0.95, 1.55].map((x) => [
      'kitchen-base',
      { x, y: 0.35 },
      0,
    ]);
    const leg: [string, Vec2, number][] = [0.95].map((y) => [
      'kitchen-base',
      { x: 0.35, y },
      -Math.PI / 2,
    ]);
    const arm: [string, Vec2, number][] = [0.35, 0.95, 1.55].map((x) => [
      'kitchen-base',
      { x, y: 1.25 + 0.85 + 0.3 - 0.6 },
      Math.PI,
    ]);
    // The arm's back sits on the leg's end (one run), facing the top across 0.85 m... and
    // the leg's front faces nothing. Every top and arm cabinet is short except where the
    // leg stands in front of a corner one.
    const u = zones(clearanceIssues(withItems(base, [...top, ...leg, ...arm])));
    expect(u.length).toBeGreaterThan(0);
  });

  it('is quick: 80 pieces in a few milliseconds', () => {
    const base = level(room());
    const ids = ['wardrobe', 'sofa-3', 'desk', 'bedside', 'kitchen-base', 'armchair', 'bed-queen'];
    const pieces: [string, Vec2, number][] = Array.from({ length: 80 }, (_, i) => [
      ids[i % ids.length] as string,
      { x: 0.5 + (i % 9) * 0.4, y: 0.5 + Math.floor(i / 9) * 0.4 },
      0,
    ]);
    const lvl = withItems(base, pieces);
    clearanceIssues(lvl);
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      // A new level object each time, as a drag makes (walls and doors stay cached).
      const fresh = { ...lvl, items: { ...lvl.items } };
      const t0 = performance.now();
      clearanceIssues(fresh);
      times.push(performance.now() - t0);
    }
    // The median, so one slow run on a busy machine doesn't decide it.
    const ms = times.sort((a, b) => a - b)[3] as number;
    console.log(`clearance: ${ms.toFixed(2)} ms`);
    // 20 ms here; a shared CI runner gets three times that unless PERF is set.
    expect(ms).toBeLessThan(process.env.PERF ? 20 : 60);
  });

  it('13. a dining chair needs 0.75 m from the table to pull it out', () => {
    const base = level(room());
    const back = (xs: ClearanceIssue[]) => xs.filter((x) => x.kind === 'zone' && x.side === 'back');
    // A dining table 1.00 m from the top wall's face (y 0.05), a chair between, facing it.
    const roomy = withItems(base, [
      ['dining-4', { x: 2, y: 0.05 + 1.0 + 0.4 }],
      ['dining-chair', { x: 2, y: 1.05 - 0.15 }],
    ]);
    expect(back(clearanceIssues(roomy))).toHaveLength(0);
    // At 0.55 m: short, 0.55 here.
    const tight = withItems(base, [
      ['dining-4', { x: 2, y: 0.05 + 0.55 + 0.4 }],
      ['dining-chair', { x: 2, y: 0.6 - 0.15 }],
    ]);
    const z = back(clearanceIssues(tight));
    expect(z).toHaveLength(1);
    const i = z[0];
    if (i?.kind !== 'zone') throw new Error('no zone');
    expect(i.need).toBeCloseTo(0.75, 5);
    expect(i.what).toBe('Pulling out the chair needs');
    expect(Math.abs(i.have - 0.55)).toBeLessThanOrEqual(0.005);
    // Its table's chairs, and the zone drawn while it's handled.
    const tableId = Object.values(tight.items).find((t) => t.assetId === 'dining-4')?.id ?? '';
    const chair = Object.values(tight.items).find((t) => t.assetId === 'dining-chair');
    if (!chair) throw new Error('no chair');
    expect(chairsOf(tight, tableId)).toEqual([chair.id]);
    expect(clearanceZones(chair, tight)[0]?.side).toBe('back');
    // Turned 30°: the same room behind it.
    const turned = withItems(base, [
      ['dining-4', { x: 2, y: 0.05 + 0.55 + 0.4 }],
      ['dining-chair', { x: 2, y: 0.6 - 0.15 }, Math.PI / 6],
    ]);
    const t = back(clearanceIssues(turned))[0];
    expect(t?.kind === 'zone' && Math.abs(t.have - 0.55)).toBeLessThanOrEqual(0.005);
    // A chair 0.50 m from any table isn't one of its chairs.
    const apart = withItems(base, [
      ['dining-4', { x: 2, y: 2 }],
      ['dining-chair', { x: 2, y: 2 - 0.4 - 0.5 - 0.25 }],
    ]);
    expect(back(clearanceIssues(apart))).toHaveLength(0);
    // Back to back with another table's chair 0.60 m behind: short.
    const pair = withItems(base, [
      ['dining-4', { x: 2, y: 1.2 }],
      ['dining-chair', { x: 2, y: 1.75 }, Math.PI],
      ['dining-chair', { x: 2, y: 2.45 }],
      ['dining-4', { x: 2, y: 3.0 }],
    ]);
    const bb = back(clearanceIssues(pair));
    expect(bb.length).toBeGreaterThan(0);
    for (const x of bb)
      expect(x.kind === 'zone' && Math.abs(x.have - 0.6)).toBeLessThanOrEqual(0.005);
  });

  /** A swing door in the room's top or left wall, `at` from the top-left corner, hinged away from it. */
  function cornerDoor(s: EditorDoc, which: 'top' | 'left', at: number, style?: Opening['style']) {
    const l = level(s);
    const wall = Object.values(l.walls).find((w) => {
      const a = l.vertices[w.a];
      const b = l.vertices[w.b];
      if (!a || !b) return false;
      return which === 'top' ? a.y === 0 && b.y === 0 : a.x === 0 && b.x === 0;
    });
    if (!wall) throw new Error('no wall');
    const a = l.vertices[wall.a] as Vec2;
    const b = l.vertices[wall.b] as Vec2;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    // Distance from the corner (0, 0) along the wall to the door's centre.
    const fromA = Math.hypot(a.x, a.y) < 1e-9;
    const t = fromA ? at / len : 1 - at / len;
    const geom = planGeometry(l);
    const f = geom.frames[wall.id];
    if (!f) throw new Error('no frame');
    // The swing into the room, hinged at the jamb farther from the corner.
    const swings: Opening['swing'][] = ['leftIn', 'rightIn', 'leftOut', 'rightOut'];
    const pick = swings.find((sw) => {
      const o = {
        id: 'x',
        wallId: wall.id,
        kind: 'door',
        t,
        width: 0.8,
        height: 2.1,
        sill: 0,
        swing: sw,
      } as Opening;
      const d = doorSwing(f, o);
      const inside = d.leafEnd.x > 0.05 && d.leafEnd.y > 0.05;
      return inside && Math.hypot(d.hinge.x, d.hinge.y) > at;
    });
    const r = addOpening(l.id, {
      wallId: wall.id,
      kind: 'door',
      t,
      width: 0.8,
      height: 2.1,
      sill: 0,
      swing: pick ?? 'leftIn',
      ...(style ? { style } : {}),
      ...(style === 'sliding' ? { panels: 2 } : {}),
    });
    return { s: dispatch(s, r.command), id: r.openingId };
  }

  it('14. doors at a corner whose leaves meet: one issue each; apart, sliding or double: none', () => {
    const doors = (xs: ClearanceIssue[]) => xs.filter((x) => x.kind === 'doors');
    let a = cornerDoor(room(), 'top', 0.55);
    let b = cornerDoor(a.s, 'left', 0.55);
    const clash = doors(clearanceIssues(level(b.s)));
    expect(clash).toHaveLength(2);
    expect(new Set(clash.map((x) => (x.kind === 'doors' ? x.openingId : '')))).toEqual(
      new Set([a.id, b.id]),
    );
    // A door clash is about two doors, not a piece.
    expect(clash.every((x) => issueItem(x) === null)).toBe(true);
    // Each 0.3 m further from the corner (0.6 apart): clear.
    a = cornerDoor(room(), 'top', 0.85);
    b = cornerDoor(a.s, 'left', 0.85);
    expect(doors(clearanceIssues(level(b.s)))).toHaveLength(0);
    // Two two-panel sliding doors side by side on one wall: none.
    a = cornerDoor(room(), 'top', 1.0, 'sliding');
    b = cornerDoor(a.s, 'top', 2.4, 'sliding');
    expect(doors(clearanceIssues(level(b.s)))).toHaveLength(0);
    // A double door's own two leaves: none.
    a = cornerDoor(room(), 'top', 2.0, 'double');
    expect(doors(clearanceIssues(level(a.s)))).toHaveLength(0);
  });

  it('15. a door hitting a wardrobe’s doors: 0.30 m off its swing yes, 0.50 no, a bookshelf no', () => {
    // A swing door in the left wall at y 2, its leaf reaching 0.85 m into the room.
    const d = cornerDoor(room(), 'left', 2.0);
    const lvl = level(d.s);
    const sweep = doorSweep(lvl, d.id).flat();
    const reach = Math.max(...sweep.map((p) => p.x));
    expect(reach).toBeCloseTo(0.87, 1);
    const front = (gap: number, kind = 'wardrobe') =>
      clearanceIssues(withItems(lvl, [[kind, { x: reach + gap + 0.3, y: 2 }, Math.PI / 2]])).filter(
        (x) => x.kind === 'door-front' || x.kind === 'door',
      );
    const hit = front(0.3);
    expect(hit).toHaveLength(1);
    expect(hit[0]?.kind).toBe('door-front');
    expect(hit[0]?.kind === 'door-front' && hit[0].openingId).toBe(d.id);
    expect(front(0.5)).toHaveLength(0);
    expect(front(0.3, 'bookshelf')).toHaveLength(0);
  });
});

/** A 4 m square room as `room()`, its right side (x 4) a room boundary, and beyond it `beyond`. */
function openRight(beyond: 'nothing' | 'a room'): Level {
  let s: EditorDoc = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
  const segs: [number, number, number, number, boolean][] = [
    [0, 0, 4, 0, false],
    [4, 0, 4, 4, true],
    [4, 4, 0, 4, false],
    [0, 4, 0, 0, false],
  ];
  // A second room to the right, walled on its other three sides.
  if (beyond === 'a room') segs.push([4, 0, 7, 0, false], [7, 0, 7, 4, false], [7, 4, 4, 4, false]);
  for (const [ax, ay, bx, by, open] of segs) {
    s = dispatch(
      s,
      drawWall(
        level(s),
        { point: { x: ax, y: ay } },
        { point: { x: bx, y: by } },
        { thickness: 0.1, ...(open ? { kind: 'boundary' as const } : {}) },
      ).command,
    );
  }
  return level(s);
}

/** How deep a zone reaches (a side's corners, then each pushed out). */
const depth = (zone: readonly Vec2[]) => {
  const [a, , , d] = zone as [Vec2, Vec2, Vec2, Vec2];
  return Math.hypot(d.x - a.x, d.y - a.y);
};

describe('clearance zones stop at walls (#72)', () => {
  const queen = furnitureKind('bed-queen');
  if (!queen) throw new Error('no queen');
  // In the top-left corner, its head on the top wall's face (y 0.05), its left side on the
  // left wall's face (x 0.05): the left side's full zone would be in the wall and past it.
  const corner = { x: 0.05 + queen.size.w / 2, y: 0.05 + queen.size.d / 2 };

  it('a bed against a wall: that side is closed, its zone has no depth and stays in the room', () => {
    const lvl = withItems(level(room()), [['bed-queen', corner]]);
    const short = zones(clearanceIssues(lvl));
    expect(short).toHaveLength(1);
    const z = short[0];
    if (z?.kind !== 'zone') throw new Error('no zone');
    expect(z.side).toBe('left');
    expect(z.have).toBeCloseTo(0, 6);
    // Nothing of it past the wall's face: no depth at all. It faces the wall (-x).
    expect(depth(z.zone)).toBeCloseTo(0, 6);
    expect(zoneDepth(z.zone)).toBeCloseTo(0, 6);
    expect(Math.min(...z.zone.map((p) => p.x))).toBeGreaterThanOrEqual(0.05 - 1e-6);
    expect(z.out.x).toBeCloseTo(-1, 6);
    expect(z.out.y).toBeCloseTo(0, 6);
    // Shown while handled: the open side in full, the closed one with no depth; without the
    // level, the rule's full zones (as before).
    const bed = lvl.items[z.itemId];
    if (!bed) throw new Error('no bed');
    const shown = clearanceZones(bed, lvl);
    expect(depth(shown.find((x) => x.side === 'right')?.zone ?? [])).toBeCloseTo(0.6, 6);
    expect(depth(shown.find((x) => x.side === 'left')?.zone ?? [])).toBeCloseTo(0, 6);
    const whole = clearanceZones(bed).find((x) => x.side === 'left');
    expect(depth(whole?.zone ?? [])).toBeCloseTo(0.6, 6);
  });

  it('a wall in the zone cuts it there; a piece in it does not (the room it lacks is shown)', () => {
    const base = level(room());
    // A wardrobe facing up, 0.32 m from the top wall's face: drawn 0.32 deep, not 0.60.
    const walled = zones(
      clearanceIssues(withItems(base, [['wardrobe', { x: 2, y: 0.67 }, Math.PI]])),
    )[0];
    if (walled?.kind !== 'zone') throw new Error('no zone');
    expect(walled.have).toBeCloseTo(0.32, 3);
    expect(depth(walled.zone)).toBeCloseTo(0.32, 3);
    for (const p of walled.zone) expect(p.y).toBeGreaterThanOrEqual(0.05 - 1e-6);
    // A bedside table 0.10 m in front: the zone keeps its full 0.60 m over the table.
    const pieced = zones(
      clearanceIssues(
        withItems(base, [
          ['wardrobe', { x: 2, y: 0.35 }],
          ['bedside', { x: 2, y: 0.95 }],
        ]),
      ),
    )[0];
    if (pieced?.kind !== 'zone') throw new Error('no zone');
    expect(pieced.have).toBeCloseTo(0.1, 3);
    expect(depth(pieced.zone)).toBeCloseTo(0.6, 6);
  });

  it('the floor’s edge ends the room as a wall does; a boundary to another room does not', () => {
    // The bed's right side 0.30 m from the boundary at x 4 (a line: no thickness).
    const at = { x: 4 - 0.3 - queen.size.w / 2, y: 0.05 + queen.size.d / 2 };
    const edge = zones(clearanceIssues(withItems(openRight('nothing'), [['bed-queen', at]])));
    expect(edge).toHaveLength(1);
    const z = edge[0];
    if (z?.kind !== 'zone') throw new Error('no zone');
    expect(z.side).toBe('right');
    expect(z.have).toBeCloseTo(0.3, 2);
    expect(depth(z.zone)).toBeCloseTo(0.3, 2);
    for (const p of z.zone) expect(p.x).toBeLessThanOrEqual(4 + 1e-3);
    // Another room beyond the boundary: open floor, room to get in.
    const open = withItems(openRight('a room'), [['bed-queen', at]]);
    expect(zones(clearanceIssues(open))).toEqual([]);
  });

  it('a dining chair’s pull-back zone stops at the wall behind it', () => {
    const tight = withItems(level(room()), [
      ['dining-4', { x: 2, y: 0.05 + 0.55 + 0.4 }],
      ['dining-chair', { x: 2, y: 0.6 - 0.15 }],
    ]);
    const z = zones(clearanceIssues(tight)).find((x) => x.kind === 'zone' && x.side === 'back');
    if (z?.kind !== 'zone') throw new Error('no zone');
    expect(Math.abs(depth(z.zone) - z.have)).toBeLessThanOrEqual(0.005);
    for (const p of z.zone) expect(p.y).toBeGreaterThanOrEqual(0.05 - 1e-6);
  });
});

describe('the floor’s edge along part of a boundary (#72, ledgeFlat)', () => {
  const flat = ledgeFlatLevel();
  const xs = (e: Vec2[]) => e.map((p) => p.x);

  it('is found along each boundary, only where there is no floor beyond', () => {
    expect(Level.safeParse(flat).success).toBe(true);
    const edges = floorEdges(flat);
    // The balcony's three sides, and the living room's south line west of the balcony only.
    expect(edges).toHaveLength(4);
    const south = edges.filter((e) => e.every((p) => Math.abs(p.y - 4.4) < 0.01));
    expect(south).toHaveLength(1);
    const s = south[0] as Vec2[];
    expect(Math.min(...xs(s))).toBeCloseTo(3.4, 6);
    expect(Math.abs(Math.max(...xs(s)) - 5.4)).toBeLessThan(0.002);
  });

  it('a wardrobe facing it is short where it is the edge, not where the balcony is beyond', () => {
    // Facing south (+y), its front 0.30 m from the line at y 4.4.
    const at = (x: number) => withItems(flat, [['wardrobe', { x, y: 4.4 - 0.3 - 0.3 }]]);
    const edge = zones(clearanceIssues(at(4.45)));
    expect(edge).toHaveLength(1);
    const z = edge[0];
    if (z?.kind !== 'zone') throw new Error('no zone');
    expect(z.have).toBeCloseTo(0.3, 2);
    expect(depth(z.zone)).toBeCloseTo(0.3, 2);
    // Over the balcony: open floor, room to open it.
    expect(zones(clearanceIssues(at(7.0)))).toEqual([]);
  });

  it('bedSideRoom measures a bed’s side as the check does: up to the floor’s edge', () => {
    const queen = furnitureKind('bed-queen');
    if (!queen) throw new Error('no queen');
    // Turned so a long side faces south, 0.30 m from the edge west of the balcony, its foot
    // clear of the living room's west wall.
    const lvl = withItems(flat, [
      ['bed-queen', { x: 4.55, y: 4.4 - 0.3 - queen.size.w / 2 }, Math.PI / 2],
    ]);
    const bed = Object.values(lvl.items).at(-1) as Item;
    const sides = bedSideRoom(lvl, bed);
    const short = sides.filter((s) => s.have < s.need - 0.005);
    expect(short).toHaveLength(1);
    expect(short[0]?.have).toBeCloseTo(0.3, 2);
    // The same figure the check gives that side.
    const z = zones(clearanceIssues(lvl)).filter((x) => x.kind === 'zone' && x.itemId === bed.id);
    expect(z.map((x) => x.kind === 'zone' && [x.side, x.have])).toEqual(
      short.map((s) => [s.side, s.have]),
    );
  });

  it('a piece standing on it has a zone too shallow to draw', () => {
    const lvl = withItems(flat, [['wardrobe', { x: 4.45, y: 4.4 - 0.3 }]]);
    const z = zones(clearanceIssues(lvl))[0];
    if (z?.kind !== 'zone') throw new Error('no zone');
    expect(zoneShown(z.zone)).toBe(false);
    expect(depth(z.zone)).toBeLessThan(ZONE_MIN_DEPTH);
  });
});
