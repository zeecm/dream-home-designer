import { describe, expect, it } from 'vitest';
import { addOpening, drawWall } from './commands';
import { blankProject } from './factory';
import { sampleFlatProject } from './fixtures/sampleFlat';
import { type EditorDoc, dispatch, emptyHistory, undo } from './history';
import type { Level, Vec2 } from './schema';
import { shiftBlocked, shiftIds, shiftNeedsSteps, shiftWall } from './shiftWall';

/** Two rooms side by side, 3 m + 3 m by 4 m, the top and bottom walls each in two pieces. */
function flat() {
  let s: EditorDoc = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
  const lvl = () => s.doc.levels[0] as Level;
  const draw = (a: Vec2, b: Vec2) => {
    s = dispatch(s, drawWall(lvl(), { point: a }, { point: b }, { thickness: 0.1 }).command);
  };
  draw({ x: 0, y: 0 }, { x: 6, y: 0 });
  draw({ x: 6, y: 0 }, { x: 6, y: 4 });
  draw({ x: 6, y: 4 }, { x: 0, y: 4 });
  draw({ x: 0, y: 4 }, { x: 0, y: 0 });
  draw({ x: 3, y: 0 }, { x: 3, y: 4 });
  const wallAt = (p: Vec2, q: Vec2) => {
    const l = lvl();
    const w = Object.values(l.walls).find((w) => {
      const a = l.vertices[w.a];
      const b = l.vertices[w.b];
      const is = (u: Vec2 | undefined, v: Vec2) => !!u && Math.hypot(u.x - v.x, u.y - v.y) < 1e-6;
      return a && b && ((is(a, p) && is(b, q)) || (is(a, q) && is(b, p)));
    });
    if (!w) throw new Error(`no wall ${JSON.stringify([p, q])}`);
    return w;
  };
  return {
    lvl,
    wallAt,
    get s() {
      return s;
    },
    apply(cmd: Parameters<typeof dispatch>[1], key?: string) {
      s = dispatch(s, cmd, key ? { coalesceKey: key } : {});
    },
  };
}

const ends = (l: Level, id: string) => {
  const w = l.walls[id];
  return w ? [l.vertices[w.a], l.vertices[w.b]] : [];
};

describe('shiftWall', () => {
  it('steps where the wall carries straight on, instead of bending the next piece', () => {
    const f = flat();
    const topLeft = f.wallAt({ x: 0, y: 0 }, { x: 3, y: 0 });
    const topRight = f.wallAt({ x: 3, y: 0 }, { x: 6, y: 0 });
    expect(shiftNeedsSteps(f.lvl(), topLeft.id)).toEqual(
      f.lvl().vertices[topLeft.a]?.x === 0 ? { a: false, b: true } : { a: true, b: false },
    );
    const start = f.lvl();
    const ids = shiftIds(start, topLeft.id);
    const out = (() => {
      const a = start.vertices[topLeft.a] as Vec2;
      const b = start.vertices[topLeft.b] as Vec2;
      return b.x - a.x > 0 ? -0.5 : 0.5; // the offset that moves it to y = -0.5
    })();
    // Dispatched again and again as a drag goes on, from the same start.
    f.apply(shiftWall(start, topLeft.id, out / 2, ids), 'drag');
    f.apply(shiftWall(start, topLeft.id, out, ids), 'drag');
    const l = f.lvl();
    for (const v of ends(l, topLeft.id)) expect(v?.y).toBeCloseTo(-0.5, 6);
    for (const v of ends(l, topRight.id)) expect(v?.y).toBeCloseTo(0, 6);
    // The step: from the old corner up to the moved wall's end.
    const step = Object.values(l.walls).filter((w) => {
      const [a, b] = ends(l, w.id);
      return a && b && a.x === 3 && b.x === 3 && Math.min(a.y, b.y) < -0.4;
    });
    expect(step).toHaveLength(1);
    // One undo step takes it all back.
    expect(undo(f.s).doc.levels[0]?.walls[step[0]?.id ?? '']).toBeUndefined();
  });

  it('keeps doors and windows on the walls that follow where they were', () => {
    const f = flat();
    const left = f.wallAt({ x: 0, y: 0 }, { x: 0, y: 4 });
    // A 1 m window 1 m up from the bottom-left corner.
    const a = f.lvl().vertices[left.a] as Vec2;
    const t = a.y === 4 ? 1.5 / 4 : 2.5 / 4;
    const added = addOpening(f.lvl().id, {
      wallId: left.id,
      kind: 'window',
      t,
      width: 1,
      height: 1.2,
      sill: 0.9,
    });
    f.apply(added.command);
    const bottomLeft = f.wallAt({ x: 0, y: 4 }, { x: 3, y: 4 });
    const start = f.lvl();
    const s0 = start.vertices[bottomLeft.a] as Vec2;
    const s1 = start.vertices[bottomLeft.b] as Vec2;
    // Down by 1 m: the window keeps its distance from its wall's far end, the top corner,
    // which didn't move.
    const down = s1.x - s0.x > 0 ? 1 : -1;
    f.apply(shiftWall(start, bottomLeft.id, down, shiftIds(start, bottomLeft.id)));
    const l = f.lvl();
    const o = l.openings[added.openingId];
    const w = l.walls[left.id];
    const pa = w && l.vertices[w.a];
    const pb = w && l.vertices[w.b];
    if (!o || !pa || !pb) throw new Error('lost the window');
    const length = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    expect(length).toBeCloseTo(5, 6);
    // Its centre is still 2.5 m from the top corner (y = 0), as it began.
    const top = pa.y < pb.y ? pa : pb;
    const centreY = pa.y + (pb.y - pa.y) * o.t;
    expect(Math.abs(centreY - top.y)).toBeCloseTo(2.5, 6);
  });

  it('stops short of another wall, and before a wall that follows vanishes', () => {
    const f = flat();
    const mid = f.wallAt({ x: 3, y: 0 }, { x: 3, y: 4 });
    const l = f.lvl();
    const a = l.vertices[mid.a] as Vec2;
    const b = l.vertices[mid.b] as Vec2;
    const right = -(b.y - a.y) < 0 ? -1 : 1; // the sign that moves it towards x = 6
    expect(shiftBlocked(l, mid.id, right * 1)).toBe(false);
    expect(shiftBlocked(l, mid.id, right * 2.98)).toBe(true);
    expect(shiftBlocked(l, mid.id, right * 3.5)).toBe(true);
  });

  it('stops short of the doors and windows on a wall that follows', () => {
    // The sample's wall between the bedrooms, towards the Bedroom: the walls above and below
    // it shorten, and the Bedroom's door below keeps its place, its near edge about 0.2 m
    // from this wall, so the move stops just short of it.
    const l = sampleFlatProject().levels[0] as Level;
    const id = 'w_bedroom_main-bedroom';
    expect(shiftBlocked(l, id, -0.1)).toBe(false);
    expect(shiftBlocked(l, id, -0.2)).toBe(true);
  });
});
