import { describe, expect, it } from 'vitest';
import { furnishedSample } from './fixtures/furnishedSample';
import { hdb4RoomLevel, hdb4RoomProject } from './fixtures/hdb4room';
import { tiledLevel } from './fixtures/tiled';
import { itemSize } from './furniture';
import {
  type Circle,
  GLASS_FRAME,
  circlesNear,
  crossingsAt,
  glassPartition,
  insideAt,
  labelClearance,
  labelPoint,
  levelBounds,
  placeLabel,
  pointInPolygon,
  polygonBounds,
  polygonCentroid,
  signedArea,
  wallLine,
  wallPieces,
} from './geometry';
import { doorSwing, planGeometry, swingZone } from './plan';
import { roomArea, roomShapes } from './rooms';
import type { Opening, Vec2 } from './schema';
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

describe('placeLabel', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
    { x: 0, y: 4 },
  ];
  const half = { x: 0.6, y: 0.25 };

  it('uses the centre when nothing is in the way', () => {
    expect(placeLabel(square, half)).toEqual({ x: 2, y: 2 });
  });

  it('moves clear of a door swing over the centre', () => {
    const swing = { c: { x: 2, y: 1.6 }, r: 0.9 };
    const p = placeLabel(square, half, [swing]);
    expect(pointInPolygon(p, square)).toBe(true);
    // The whole box clears the circle and stays inside the room.
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const q = { x: p.x + sx * half.x, y: p.y + sy * half.y };
        expect(Math.hypot(q.x - 2, q.y - 1.6)).toBeGreaterThanOrEqual(0.9 - 1e-9);
        expect(pointInPolygon(q, square)).toBe(true);
      }
    }
  });

  it('falls back to the roomiest spot when nothing fits', () => {
    const tiny = square.map((v) => ({ x: v.x / 4, y: v.y / 4 }));
    const p = placeLabel(tiny, half);
    expect(pointInPolygon(p, tiny)).toBe(true);
  });
});

describe('circlesNear', () => {
  // Door swings and furniture over a terrace of four furnished flats, plus circles scattered
  // round each room (some just past its box, some across its walls), as the plan passes them.
  const level = tiledLevel(furnishedSample(), 2, 2);
  const plan: Circle[] = [
    ...planGeometry(level)
      .openings.filter((o) => o.kind === 'door')
      .map((o) => swingZone(doorSwing(o.frame, o.opening))),
    ...Object.values(level.items).map((it) => {
      const { w, d } = itemSize(it);
      return { c: { x: it.position.x, y: it.position.z }, r: Math.hypot(w, d) / 2 };
    }),
  ];
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const shapes = [...roomShapes(level).values()];
  const scattered = shapes.flatMap((s) => {
    const { min, max } = polygonBounds(s.outer);
    return Array.from({ length: 12 }, () => ({
      c: {
        x: min.x - 1.5 + rand() * (max.x - min.x + 3),
        y: min.y - 1.5 + rand() * (max.y - min.y + 3),
      },
      r: 0.05 + rand() * 0.8,
    }));
  });
  const all = [...plan, ...scattered];

  it('crossingsAt and insideAt find the points pointInPolygon finds, a row at a time', () => {
    for (const s of shapes) {
      const { min, max } = polygonBounds(s.outer);
      // A raster's rows, and rows through the corners (where an edge test can go either way).
      const ys = [
        ...Array.from({ length: 30 }, (_, j) => min.y - 0.1 + ((max.y - min.y + 0.2) * j) / 29),
        ...s.outer.map((p) => p.y),
      ];
      const xsOf = [...s.outer.map((p) => p.x)];
      for (const y of ys) {
        const row = crossingsAt(s.outer, y);
        const xs = [
          ...Array.from({ length: 40 }, (_, i) => min.x - 0.1 + ((max.x - min.x + 0.2) * i) / 39),
          ...xsOf,
        ];
        for (const x of xs) {
          expect(insideAt(row, x)).toBe(pointInPolygon({ x, y }, s.outer));
        }
      }
    }
  });

  it('keeps only the circles near the room', () => {
    const s = shapes[0] as (typeof shapes)[number];
    const near = circlesNear(s.outer, { x: 0.5, y: 0.3 }, all);
    expect(near.length).toBeGreaterThan(0);
    expect(near.length).toBeLessThan(all.length / 4);
  });

  it('leaves every clearance placeLabel samples the same, to the bit', () => {
    for (const s of shapes) {
      const { min, max } = polygonBounds(s.outer);
      for (const half of [
        { x: 0, y: 0 },
        { x: 0.05, y: 0.05 },
        { x: 0.6, y: 0.25 },
        { x: 1.4, y: 0.6 },
      ]) {
        const near = circlesNear(s.outer, half, all);
        const points = [labelPoint(s.outer)];
        for (let i = 0; i <= 20; i++) {
          for (let j = 0; j <= 20; j++) {
            points.push({
              x: min.x + ((max.x - min.x) * i) / 20,
              y: min.y + ((max.y - min.y) * j) / 20,
            });
          }
        }
        for (const p of points) {
          const a = labelClearance(p, half, s.outer, all, s.holes);
          const b = labelClearance(p, half, s.outer, near, s.holes);
          if (!Object.is(a, b)) expect({ p, half, b }).toEqual({ p, half, b: a });
        }
      }
    }
  });

  /** placeLabel as it was: every grid spot measured in row order, against every circle. */
  function placeLabelPlain(
    poly: Vec2[],
    half: Vec2,
    avoid: readonly Circle[],
    holes: Vec2[][],
    steps = 20,
  ): Vec2 {
    const home = labelPoint(poly);
    if (poly.length < 3 || labelClearance(home, half, poly, avoid, holes) >= 0) return home;
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const w = Math.max(...xs) - x0;
    const h = Math.max(...ys) - y0;
    let best = home;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps; j++) {
        const p = { x: x0 + (w * i) / steps, y: y0 + (h * j) / steps };
        if (!pointInPolygon(p, poly)) continue;
        const clear = labelClearance(p, half, poly, avoid, holes);
        const score = (clear >= 0 ? 1000 : clear) - 0.1 * Math.hypot(p.x - home.x, p.y - home.y);
        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }
    }
    return best;
  }

  it('leaves placeLabel where measuring every spot against every circle puts it', () => {
    // Crowded too: more circles inside each room, so few spots fit or none do.
    const crowded = [
      ...all,
      ...shapes.flatMap((s) => {
        const { min, max } = polygonBounds(s.outer);
        return Array.from({ length: 6 }, () => ({
          c: { x: min.x + rand() * (max.x - min.x), y: min.y + rand() * (max.y - min.y) },
          r: 0.2 + rand() * 0.6,
        }));
      }),
    ];
    let moved = 0;
    for (const avoid of [[], all, crowded]) {
      for (const s of shapes) {
        for (const half of [
          { x: 0.05, y: 0.05 },
          { x: 0.6, y: 0.25 },
          { x: 0.9, y: 0.6 },
          { x: 2.5, y: 1.5 },
        ]) {
          const a = placeLabelPlain(s.outer, half, avoid, s.holes);
          const b = placeLabel(s.outer, half, avoid, s.holes);
          expect(Object.is(a.x, b.x) && Object.is(a.y, b.y)).toBe(true);
          if (a.x !== labelPoint(s.outer).x || a.y !== labelPoint(s.outer).y) moved++;
        }
      }
    }
    // The grid search ran, not only the room's own label point.
    expect(moved).toBeGreaterThan(20);
  });
});

describe('glassPartition', () => {
  const door = {
    id: 'd',
    wallId: 'w',
    kind: 'door' as const,
    t: 0.5,
    width: 0.9,
    height: 2.1,
    sill: 0,
  };
  it('frames each stretch around a door, with mullions so no pane is over 1.2 m', () => {
    const { panes, frame } = glassPartition(4, 0, 2.6, [door]);
    // Either side of the door (1.55 m each): two panes each; a transom over the door.
    const full = panes.filter((p) => p.y0 < 0.1);
    expect(full.length).toBe(4);
    for (const p of panes) expect(p.u1 - p.u0).toBeLessThanOrEqual(1.2 + 1e-9);
    const transom = panes.filter((p) => p.y0 > 2);
    expect(transom.length).toBe(1);
    expect(transom[0]?.u0).toBeCloseTo(1.55 + GLASS_FRAME);
    // Panes and frame never overlap, and together fill each stretch's outline.
    const area = (r: { u0: number; u1: number; y0: number; y1: number }) =>
      (r.u1 - r.u0) * (r.y1 - r.y0);
    const total = [...panes, ...frame].reduce((n, r) => n + area(r), 0);
    expect(total).toBeCloseTo(4 * 2.6 - 0.9 * 2.1, 6);
  });

  it('puts fixed glass over a half wall, cut only by what reaches above it', () => {
    const { panes } = glassPartition(3, 1, 2.6, [
      door,
      { ...door, id: 'w2', kind: 'window', sill: 0.2, height: 0.5, t: 0.2 },
    ]);
    for (const p of panes) expect(p.y0).toBeGreaterThanOrEqual(1);
    // The low window doesn't reach the glass; the door cuts it.
    expect(panes.some((p) => p.u0 < 1.05 && p.u1 > 1.95 && p.y1 < 2.1)).toBe(false);
  });

  it('makes a stretch too narrow for glass all frame', () => {
    const { panes, frame } = glassPartition(0.06, 0, 2.6, []);
    expect(panes).toEqual([]);
    expect(frame).toEqual([{ u0: 0, u1: 0.06, y0: 0, y1: 2.6 }]);
  });
});
