import { describe, expect, it } from 'vitest';
import { emptyLevel } from './factory';
import { hdb4RoomLevel } from './fixtures/hdb4room';
import { MITER_LIMIT, footprintPolygon, footprintSpans, wallFootprints } from './footprints';
import { pointInPolygon, signedArea } from './geometry';
import { wallFrame } from './plan';
import type { Level, Vec2, Wall } from './schema';

type W = [id: string, a: string, b: string, thickness: number];

function makeLevel(pts: Record<string, [number, number]>, walls: W[]): Level {
  const l = emptyLevel();
  for (const [id, [x, y]] of Object.entries(pts)) l.vertices[id] = { id, x, y };
  for (const [id, a, b, thickness] of walls) {
    l.walls[id] = {
      id,
      a,
      b,
      thickness,
      materialLeft: 'paint-white',
      materialRight: 'paint-white',
    };
  }
  return l;
}

const area = (pts: Vec2[]) => Math.abs(signedArea(pts));
function totalArea(l: Level): number {
  const f = wallFootprints(l);
  return (
    Object.values(f.walls).reduce((s, w) => s + area(footprintPolygon(w)), 0) +
    f.hubs.reduce((s, h) => s + area(h.polygon), 0)
  );
}
const near = (p: Vec2 | undefined, x: number, y: number) => {
  expect(p?.x).toBeCloseTo(x, 9);
  expect(p?.y).toBeCloseTo(y, 9);
};

describe('wallFootprints', () => {
  it('a lone wall is a rectangle with square ends', () => {
    const l = makeLevel({ a: [0, 0], b: [4, 0] }, [['w', 'a', 'b', 0.2]]);
    const f = wallFootprints(l).walls.w!;
    near(f.aL, 0, 0.1);
    near(f.aR, 0, -0.1);
    near(f.bL, 4, 0.1);
    near(f.bR, 4, -0.1);
    expect(wallFootprints(l).hubs).toEqual([]);
  });

  it('an L corner mitres to shared inner and outer corners with no hub', () => {
    const l = makeLevel({ o: [0, 0], x: [4, 0], y: [0, 3] }, [
      ['wx', 'o', 'x', 0.2],
      ['wy', 'o', 'y', 0.2],
    ]);
    const f = wallFootprints(l);
    near(f.walls.wx?.aL, 0.1, 0.1); // inner
    near(f.walls.wx?.aR, -0.1, -0.1); // outer
    near(f.walls.wy?.aR, 0.1, 0.1);
    near(f.walls.wy?.aL, -0.1, -0.1);
    expect(f.hubs).toEqual([]);
    // outer L: 4.1 x 0.2 plus 0.2 x 2.9
    expect(totalArea(l)).toBeCloseTo(0.82 + 0.58, 9);
  });

  it('a T stem stops at the face of a thicker through-wall; a hub fills the middle', () => {
    const l = makeLevel({ w: [-2, 0], o: [0, 0], e: [2, 0], s: [0, 2] }, [
      ['west', 'w', 'o', 0.2],
      ['east', 'o', 'e', 0.2],
      ['stem', 'o', 's', 0.1],
    ]);
    const f = wallFootprints(l);
    const stem = f.walls.stem!;
    expect(Math.min(stem.aL.y, stem.aR.y)).toBeCloseTo(0.1, 9);
    expect(f.hubs).toHaveLength(1);
    // through wall 4 x 0.2, stem 0.1 x 1.9
    expect(totalArea(l)).toBeCloseTo(0.8 + 0.19, 9);
  });

  it('an X crossing covers the cross exactly once', () => {
    const l = makeLevel({ o: [0, 0], e: [2, 0], s: [0, 2], w: [-2, 0], n: [0, -2] }, [
      ['we', 'o', 'e', 0.2],
      ['ws', 'o', 's', 0.2],
      ['ww', 'o', 'w', 0.2],
      ['wn', 'o', 'n', 0.2],
    ]);
    expect(totalArea(l)).toBeCloseTo(2 * 0.8 - 0.04, 9);
    expect(wallFootprints(l).hubs).toHaveLength(1);
  });

  it('collinear walls of different thickness meet with square ends and no hub', () => {
    const l = makeLevel({ w: [-2, 0], o: [0, 0], e: [2, 0] }, [
      ['thick', 'w', 'o', 0.2],
      ['thin', 'o', 'e', 0.1],
    ]);
    const f = wallFootprints(l);
    near(f.walls.thick?.bL, 0, 0.1);
    near(f.walls.thin?.aL, 0, 0.05);
    expect(f.hubs).toEqual([]);
    expect(totalArea(l)).toBeCloseTo(0.4 + 0.2, 9);
  });

  it('nearly collinear walls still mitre without spikes', () => {
    const l = makeLevel({ w: [-2, 0], o: [0, 0], e: [2, 0.02] }, [
      ['a', 'w', 'o', 0.2],
      ['b', 'o', 'e', 0.2],
    ]);
    const f = wallFootprints(l);
    for (const p of [f.walls.a?.bL, f.walls.a?.bR, f.walls.b?.aL, f.walls.b?.aR]) {
      expect(Math.hypot(p!.x, p!.y)).toBeLessThan(0.11);
    }
  });

  it('an acute corner bevels instead of spiking past the miter limit', () => {
    const t = (10 * Math.PI) / 180;
    const l = makeLevel({ o: [0, 0], x: [4, 0], y: [4 * Math.cos(t), 4 * Math.sin(t)] }, [
      ['a', 'o', 'x', 0.2],
      ['b', 'o', 'y', 0.2],
    ]);
    const f = wallFootprints(l);
    for (const w of Object.values(f.walls)) {
      for (const p of [w.aL, w.aR]) {
        expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(MITER_LIMIT * 0.1 + 1e-9);
      }
    }
    expect(f.hubs).toHaveLength(1);
  });

  it('gives every reference-plan wall an outline whose sides run forwards', () => {
    const l = hdb4RoomLevel();
    const f = wallFootprints(l);
    expect(Object.keys(f.walls).sort()).toEqual(Object.keys(l.walls).sort());
    for (const w of Object.values(l.walls)) {
      const a = l.vertices[w.a]!;
      const b = l.vertices[w.b]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
      const s = footprintSpans(f.walls[w.id]!, a, d);
      expect(s.left[1], w.id).toBeGreaterThan(s.left[0]);
      expect(s.right[1], w.id).toBeGreaterThan(s.right[0]);
      // mitres never move an end more than half the thickest wall from its vertex
      for (const u of [...s.left, ...s.right]) {
        expect(u, w.id).toBeGreaterThanOrEqual(-0.1 - 1e-9);
        expect(u, w.id).toBeLessThanOrEqual(len + 0.1 + 1e-9);
      }
    }
  });
});

describe('walls to one side of their line', () => {
  const sided = (l: Level, side: 'left' | 'right') => {
    for (const w of Object.values(l.walls)) w.side = side;
    return l;
  };

  it('keep a flush face where a thick wall runs on into a thin one', () => {
    // Along +x, the right side is -y: both walls lie below the line y = 0.
    const l = sided(
      makeLevel({ a: [0, 0], b: [2, 0], c: [4, 0] }, [
        ['thick', 'a', 'b', 0.3],
        ['thin', 'b', 'c', 0.1],
      ]),
      'right',
    );
    const f = wallFootprints(l).walls;
    for (const p of [f.thick?.aL, f.thick?.bL, f.thin?.aL, f.thin?.bL])
      expect(p?.y).toBeCloseTo(0, 9);
    near(f.thick?.aR, 0, -0.3);
    near(f.thin?.bR, 4, -0.1);
  });

  it('mitre on their faces at a corner, so a room traced on its inside faces stays square', () => {
    // A corner traced on the room side: the walls lie outside the line (to its left here).
    const l = sided(
      makeLevel({ a: [0, 0], b: [3, 0], c: [3, 3] }, [
        ['x', 'a', 'b', 0.2],
        ['y', 'b', 'c', 0.3],
      ]),
      'right',
    );
    const f = wallFootprints(l);
    // The faces on the line meet exactly at the corner; the outer faces meet at their mitre.
    near(f.walls.x?.bL, 3, 0);
    near(f.walls.y?.aL, 3, 0);
    near(f.walls.x?.bR, 3.3, -0.2);
    near(f.walls.y?.aR, 3.3, -0.2);
    expect(f.hubs).toHaveLength(0);
  });

  it('put the frame on the wall centre line, off the drawn line', () => {
    const l = sided(makeLevel({ a: [0, 0], b: [2, 0] }, [['w', 'a', 'b', 0.3]]), 'left');
    const fp = wallFootprints(l).walls.w;
    const frame = wallFrame(l, l.walls.w as Wall, fp);
    expect(frame?.a.y).toBeCloseTo(0.15, 9);
    expect(frame?.half).toBeCloseTo(0.15, 9);
  });
});

describe('junction hubs with one-sided walls', () => {
  it('fill only the gap where a wall thins and a third wall meets on the flush side', () => {
    const l = makeLevel({ w: [-2, 0], v: [0, 0], e: [2, 0], s: [0, -2] }, [
      ['thick', 'w', 'v', 0.3],
      ['thin', 'v', 'e', 0.1],
      ['stem', 'v', 's', 0.1],
    ]);
    l.walls.thick!.side = 'left';
    l.walls.thin!.side = 'left';
    const f = wallFootprints(l);
    const hub = f.hubs.find((h) => h.vertexId === 'v');
    // Nothing past the thin wall's room-side face (y = 0.1) on its side of the junction.
    expect(hub).toBeDefined();
    expect(pointInPolygon({ x: 0.01, y: 0.2 }, hub?.polygon ?? [])).toBe(false);
  });
});
