import { describe, expect, it } from 'vitest';
import { emptyLevel } from './factory';
import { hdb4RoomLevel } from './fixtures/hdb4room';
import { sampleFlatProject } from './fixtures/sampleFlat';
import { wallLine } from './geometry';
import { cornerSpot, projectOnSegment, segmentIntersection, snapCorner, snapPoint } from './snap';

const l = hdb4RoomLevel();

describe('segment helpers', () => {
  it('projects onto a segment and clamps', () => {
    expect(projectOnSegment({ x: 2, y: 1 }, { x: 0, y: 0 }, { x: 4, y: 0 })).toEqual({
      t: 0.5,
      point: { x: 2, y: 0 },
      distance: 1,
    });
    expect(projectOnSegment({ x: -3, y: 0 }, { x: 0, y: 0 }, { x: 4, y: 0 }).t).toBe(0);
  });

  it('intersects crossing segments and rejects parallel or distant ones', () => {
    const x = segmentIntersection({ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }, { x: 4, y: 0 });
    expect(x?.point).toEqual({ x: 2, y: 2 });
    expect(
      segmentIntersection({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 1 }, { x: 4, y: 1 }),
    ).toBeNull();
    expect(
      segmentIntersection({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 3, y: -1 }, { x: 3, y: 1 }),
    ).toBeNull();
  });
});

describe('snapPoint', () => {
  const opts = { tolerance: 0.15, grid: 0.1 };

  it('prefers an existing corner within tolerance', () => {
    expect(snapPoint(l, { x: 5.1, y: 4.4 }, opts)).toMatchObject({
      kind: 'vertex',
      vertexId: 'v9',
    });
  });

  it('falls back to a point on a wall', () => {
    const s = snapPoint(l, { x: 2.03, y: 0.12 }, opts);
    expect(s).toMatchObject({ kind: 'wall', wallId: 'w_front_l' });
    expect(s.point).toEqual({ x: 2.03, y: 0 });
  });

  it('snaps to 0/45/90 degrees from the previous corner with the length on the grid', () => {
    const s = snapPoint(l, { x: 20.04, y: 3.07 }, { ...opts, from: { x: 18, y: 3 } });
    expect(s.kind).toBe('angle');
    expect(s.point).toEqual({ x: 20, y: 3 });
  });

  it('where an angle guide crosses a wall near the pointer, it lands on the crossing', () => {
    // Drawing straight down from (2, -3): the guide meets the front wall at (2, 0).
    const s = snapPoint(l, { x: 2.08, y: -0.1 }, { ...opts, from: { x: 2, y: -3 } });
    expect(s).toMatchObject({ kind: 'intersection', wallId: 'w_front_l' });
    expect(s.point.x).toBeCloseTo(2);
    expect(s.point.y).toBeCloseTo(0);
  });

  it('rounds to the grid when nothing else applies, without float noise', () => {
    expect(snapPoint(l, { x: 20.33, y: -5.27 }, opts)).toEqual({
      point: { x: 20.3, y: -5.3 },
      kind: 'grid',
    });
  });

  it('can exclude the corner being dragged', () => {
    const s = snapPoint(l, { x: 5.02, y: 4.5 }, { ...opts, excludeVertices: new Set(['v9']) });
    expect(s.kind).not.toBe('vertex');
  });
});

describe('snapCorner', () => {
  it('keeps both walls square when dragged near their right-angle crossing', () => {
    // v4 (11, 8.5) joins the right wall (from v3 above) and the back wall (from v5 left).
    const p = snapCorner(l, 'v4', { x: 11.12, y: 8.37 }, { tolerance: 0.15 });
    expect(p).toEqual({ x: 11, y: 8.5 });
  });

  it('slides along one square guide when only one applies', () => {
    const p = snapCorner(l, 'v4', { x: 11.03, y: 10.02 }, { tolerance: 0.15 });
    expect(p.x).toBeCloseTo(11);
    expect(p.y).toBeCloseTo(10);
  });

  it('prefers a nearby corner of another wall', () => {
    expect(snapCorner(l, 'v4', { x: 7.05, y: 8.45 }, { tolerance: 0.15 })).toEqual({
      x: 7,
      y: 8.5,
    });
  });
});

describe('cornerSpot', () => {
  const l = sampleFlatProject().levels[0]!;
  const along = (id: string, p: { x: number; y: number }) => {
    const line = wallLine(l, l.walls[id]!);
    return projectOnSegment(p, line.a, line.b).t * line.length;
  };

  it('is null on a wall too short and thick to take a corner', () => {
    const lvl = emptyLevel();
    lvl.vertices.a = { id: 'a', x: 0, y: 0 };
    lvl.vertices.b = { id: 'b', x: 0.28, y: 0 };
    lvl.walls.w = {
      id: 'w',
      a: 'a',
      b: 'b',
      thickness: 0.3,
      materialLeft: 'paint-white',
      materialRight: 'paint-white',
    };
    expect(cornerSpot(lvl, 'w')).toBeNull();
  });

  it('is the middle of a wall with nothing there', () => {
    const p = cornerSpot(l, 'w_bath-wc-1_bath-wc-2');
    expect(p).toEqual({ x: 2.397, y: 5.2465 });
  });

  it('moves to a jamb rather than into a door or window', () => {
    for (const w of Object.values(l.walls)) {
      const p = cornerSpot(l, w.id);
      if (!p) continue;
      const len = wallLine(l, w).length;
      const u = along(w.id, p);
      for (const o of Object.values(l.openings).filter((o) => o.wallId === w.id)) {
        const inside = u > o.t * len - o.width / 2 + 1e-6 && u < o.t * len + o.width / 2 - 1e-6;
        expect(inside, `${w.id} at ${u}`).toBe(false);
      }
    }
  });
});
