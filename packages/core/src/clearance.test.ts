import { describe, expect, it } from 'vitest';
import { type ClearanceIssue, clearanceIssues, doorSweep } from './clearance';
import { addOpening, drawWall } from './commands';
import { blankProject } from './factory';
import { furnitureKind, newItem, placeFurniture } from './furniture';
import { type EditorDoc, dispatch, emptyHistory } from './history';
import { planGeometry } from './plan';
import type { Level, Opening, Vec2 } from './schema';

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

  it('pieces overlapping more than 20 mm; a chair under a table is fine', () => {
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
    expect(over(0.015)).toHaveLength(0);
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
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) clearanceIssues(lvl);
    const ms = (performance.now() - t0) / 5;
    console.log(`clearance: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(20);
  });
});
