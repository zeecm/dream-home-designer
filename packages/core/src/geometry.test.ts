import { describe, expect, it } from 'vitest';
import { hdb4RoomLevel, hdb4RoomProject } from './fixtures/hdb4room';
import {
  labelPoint,
  levelBounds,
  pointInPolygon,
  polygonCentroid,
  roomArea,
  signedArea,
  wallLine,
  wallPieces,
} from './geometry';
import type { Opening } from './schema';
import { Project } from './schema';

const op = (o: Partial<Opening>): Opening => ({
  id: 'o',
  wallId: 'w',
  kind: 'window',
  t: 0.5,
  width: 1,
  height: 1,
  sill: 1,
  ...o,
});

describe('fixture', () => {
  it('is a valid project', () => {
    expect(() => Project.parse(hdb4RoomProject())).not.toThrow();
  });

  it('every wall, opening and room references things that exist', () => {
    const l = hdb4RoomLevel();
    for (const w of Object.values(l.walls)) {
      expect(l.vertices[w.a], w.id).toBeDefined();
      expect(l.vertices[w.b], w.id).toBeDefined();
    }
    for (const o of Object.values(l.openings)) expect(l.walls[o.wallId], o.id).toBeDefined();
    for (const r of Object.values(l.rooms))
      for (const v of r.loop) expect(l.vertices[v]).toBeDefined();
  });

  it('room areas add up to the flat', () => {
    const l = hdb4RoomLevel();
    const areas = Object.fromEntries(Object.values(l.rooms).map((r) => [r.name, roomArea(l, r)]));
    expect(areas).toEqual({
      Living: 22.5,
      Kitchen: 27,
      'Bedroom 3': 14,
      'Bedroom 2': 14,
      'Master bedroom': 16,
    });
    const b = levelBounds(l)!;
    const total = Object.values(areas).reduce((a, x) => a + x, 0);
    expect(total).toBeCloseTo((b.max.x - b.min.x) * (b.max.y - b.min.y));
  });
});

describe('signedArea', () => {
  it('flips sign with winding', () => {
    const sq = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ];
    expect(signedArea(sq)).toBe(4);
    expect(signedArea([...sq].reverse())).toBe(-4);
  });
});

describe('wallLine', () => {
  it('gives length and a rotation that maps local +x onto the wall', () => {
    const l = hdb4RoomLevel();
    const line = wallLine(l, l.walls.w_right_f!); // (11,0) -> (11,4.5): along +plan y
    expect(line.length).toBe(4.5);
    // rotating local +x (1,0,0) by angle about +Y gives (cos a, 0, -sin a) = world (0,0,1)
    expect(Math.cos(line.angle)).toBeCloseTo(0);
    expect(-Math.sin(line.angle)).toBeCloseTo(1);
  });
});

describe('wallPieces', () => {
  it('is one full piece with no openings', () => {
    expect(wallPieces(4, 2.6, [])).toEqual([{ u0: 0, u1: 4, y0: 0, y1: 2.6 }]);
  });

  it('a door gets side pieces and a lintel, no sill', () => {
    const p = wallPieces(4, 2.6, [op({ kind: 'door', t: 0.5, width: 1, sill: 0, height: 2.1 })]);
    expect(p).toEqual([
      { u0: 0, u1: 1.5, y0: 0, y1: 2.6 },
      { u0: 1.5, u1: 2.5, y0: 2.1, y1: 2.6 },
      { u0: 2.5, u1: 4, y0: 0, y1: 2.6 },
    ]);
  });

  it('a window gets a sill piece as well', () => {
    const p = wallPieces(4, 2.6, [op({ t: 0.5, width: 1, sill: 0.9, height: 1.2 })]);
    expect(p).toContainEqual({ u0: 1.5, u1: 2.5, y0: 0, y1: 0.9 });
    expect(p).toHaveLength(4);
  });

  it('clamps an opening that hangs off the wall end', () => {
    const p = wallPieces(2, 2.6, [op({ kind: 'passage', t: 0.95, width: 1, sill: 0, height: 3 })]);
    expect(p).toEqual([{ u0: 0, u1: 1.4, y0: 0, y1: 2.6 }]);
  });

  it('handles overlapping openings without negative pieces', () => {
    const p = wallPieces(6, 2.6, [
      op({ id: 'a', t: 0.5, width: 2, sill: 0, height: 2 }),
      op({ id: 'b', t: 0.55, width: 2, sill: 0, height: 2 }),
    ]);
    for (const piece of p) {
      expect(piece.u1).toBeGreaterThan(piece.u0);
      expect(piece.y1).toBeGreaterThan(piece.y0);
    }
  });

  it('solid area equals wall area minus hole area', () => {
    const p = wallPieces(5, 2.6, [
      op({ t: 0.2, width: 1, sill: 0, height: 2.1 }),
      op({ t: 0.7, width: 1.5, sill: 0.9, height: 1.2 }),
    ]);
    const solid = p.reduce((s, q) => s + (q.u1 - q.u0) * (q.y1 - q.y0), 0);
    expect(solid).toBeCloseTo(5 * 2.6 - 1 * 2.1 - 1.5 * 1.2);
  });
});

describe('polygon helpers', () => {
  const L = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 1 },
    { x: 1, y: 1 },
    { x: 1, y: 4 },
    { x: 0, y: 4 },
  ];

  it('area centroid of a rectangle is its centre, either winding', () => {
    const r = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 2 },
      { x: 0, y: 2 },
    ];
    expect(polygonCentroid(r)).toEqual({ x: 2, y: 1 });
    expect(polygonCentroid([...r].reverse())).toEqual({ x: 2, y: 1 });
  });

  it('point in polygon handles an L shape', () => {
    expect(pointInPolygon({ x: 0.5, y: 3 }, L)).toBe(true);
    expect(pointInPolygon({ x: 2, y: 2 }, L)).toBe(false);
  });

  it('label point stays inside a thin L whose centroid falls outside', () => {
    const thin = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(pointInPolygon(polygonCentroid(thin), thin)).toBe(false);
    expect(pointInPolygon(labelPoint(thin), thin)).toBe(true);
    expect(pointInPolygon(labelPoint(L), L)).toBe(true);
  });
});
