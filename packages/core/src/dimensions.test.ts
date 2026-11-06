import { describe, expect, it } from 'vitest';
import { addOpening, drawWall } from './commands';
import {
  type ChainSide,
  type DimensionChain,
  planDimensions,
  roundChain,
  sheetScale,
} from './dimensions';
import { blankProject } from './factory';
import { sampleFlatProject } from './fixtures/sampleFlat';
import { pointInPolygon } from './geometry';
import { type EditorDoc, dispatch, emptyHistory } from './history';
import { placeOpening, planGeometry } from './plan';
import { roomShapes } from './rooms';
import type { Level, Vec2 } from './schema';

/** A level drawn with the editor's own commands: polylines of walls, then openings. */
function build(
  lines: { pts: [number, number][]; thickness?: number; boundary?: boolean }[],
  openings: { kind: 'door' | 'window'; width: number; at: Vec2 }[] = [],
): Level {
  let s: EditorDoc = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
  const level = () => s.doc.levels[0] as Level;
  for (const l of lines) {
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const [ax, ay] = l.pts[i] as [number, number];
      const [bx, by] = l.pts[i + 1] as [number, number];
      const r = drawWall(
        level(),
        { point: { x: ax, y: ay } },
        { point: { x: bx, y: by } },
        { thickness: l.thickness ?? 0.1, ...(l.boundary ? { kind: 'boundary' } : {}) },
      );
      s = dispatch(s, r.command);
    }
  }
  for (const o of openings) {
    const p = placeOpening(planGeometry(level()), o.at, o.width, 0.05);
    if (!p) throw new Error('no wall there');
    const r = addOpening(level().id, {
      wallId: p.wallId,
      kind: o.kind,
      t: p.t,
      width: o.width,
      height: o.kind === 'window' ? 1.2 : 2.1,
      sill: o.kind === 'window' ? 0.9 : 0,
    });
    s = dispatch(s, r.command);
  }
  return level();
}

const box = (w: number, h: number): [number, number][] => [
  [0, 0],
  [w, 0],
  [w, h],
  [0, h],
  [0, 0],
];
const chain = (cs: DimensionChain[], side: ChainSide, tier: number) =>
  cs.find((c) => c.side === side && c.tier === tier);
const pieces = (c: DimensionChain | undefined) =>
  c ? c.stops.slice(1).map((s, i) => s - (c.stops[i] as number)) : [];

describe('planDimensions', () => {
  it('1: a 4 × 3 m room with 100 mm walls: overalls, no tier 0 or 1, clear spans', () => {
    const d = planDimensions(build([{ pts: box(4, 3) }]));
    expect(pieces(chain(d.chains, 'top', 2))[0]).toBeCloseTo(4.1, 6);
    expect(pieces(chain(d.chains, 'bottom', 2))[0]).toBeCloseTo(4.1, 6);
    expect(pieces(chain(d.chains, 'left', 2))[0]).toBeCloseTo(3.1, 6);
    expect(pieces(chain(d.chains, 'right', 2))[0]).toBeCloseTo(3.1, 6);
    expect(d.chains.filter((c) => c.tier !== 2)).toEqual([]);
    expect(d.chains).toHaveLength(4);
    const w = d.spans.find((s) => s.axis === 'x');
    const h = d.spans.find((s) => s.axis === 'y');
    expect(w && w.b.x - w.a.x).toBeCloseTo(3.9, 6);
    expect(h && h.b.y - h.a.y).toBeCloseTo(2.9, 6);
    // Chains sit outside the walls' faces.
    expect(chain(d.chains, 'top', 2)?.at).toBeCloseTo(-0.05, 6);
    expect(chain(d.chains, 'right', 2)?.at).toBeCloseTo(4.05, 6);
  });

  it('2: a 1.20 m window centred on the top wall: tier 0 is 1.45 / 1.20 / 1.45', () => {
    const d = planDimensions(
      build([{ pts: box(4, 3) }], [{ kind: 'window', width: 1.2, at: { x: 2, y: 0 } }]),
    );
    const t0 = pieces(chain(d.chains, 'top', 0));
    expect(t0).toHaveLength(3);
    expect(t0[0]).toBeCloseTo(1.45, 6);
    expect(t0[1]).toBeCloseTo(1.2, 6);
    expect(t0[2]).toBeCloseTo(1.45, 6);
    // Only the top: the window is in no other side's chain.
    expect(chain(d.chains, 'bottom', 0)).toBeUndefined();
    expect(d.tags).toHaveLength(1);
    expect(d.tags[0]?.kind).toBe('window');
    // A window's tag goes into the room, away from the chains.
    expect(d.tags[0]?.out.y).toBeCloseTo(1, 6);
  });

  it('4: a 45° corner cut gets an aligned chain, its ends stops on both sides', () => {
    const cut: [number, number][] = [
      [0, 0],
      [3, 0],
      [4, 1],
      [4, 3],
      [0, 3],
      [0, 0],
    ];
    const d = planDimensions(build([{ pts: cut }]));
    const aligned = d.chains.filter((c) => c.side === 'aligned');
    expect(aligned).toHaveLength(1);
    const a = aligned[0] as DimensionChain;
    expect(a.line?.out.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(a.line?.out.y).toBeCloseTo(-Math.SQRT1_2, 6);
    const len = a.stops[a.stops.length - 1] as number;
    // The outside face of the cut, a little longer than its centre line (√2 m).
    expect(len).toBeGreaterThan(Math.SQRT2);
    expect(len).toBeLessThan(Math.SQRT2 + 0.1);
    const ends = [a.line?.a, a.line?.b] as Vec2[];
    const top = chain(d.chains, 'top', 1);
    const right = chain(d.chains, 'right', 1);
    expect(top).toBeDefined();
    expect(right).toBeDefined();
    for (const e of ends) {
      expect(top?.stops.some((s) => Math.abs(s - e.x) < 0.001)).toBe(true);
      expect(right?.stops.some((s) => Math.abs(s - e.y) < 0.001)).toBe(true);
    }
    // The overall still runs the full width and depth.
    expect(pieces(chain(d.chains, 'top', 2))[0]).toBeCloseTo(4.1, 3);
    expect(pieces(chain(d.chains, 'right', 2))[0]).toBeCloseTo(3.1, 3);
  });

  it('5: the sample flat: overalls are its outline, windows on one side, tiers add up', () => {
    const level = sampleFlatProject('prj_t').levels[0] as Level;
    const geom = planGeometry(level);
    const d = planDimensions(level, geom);
    const all = [
      ...geom.pieces.map((p) => p.polygon),
      ...geom.footprints.hubs.map((h) => h.polygon),
    ].flat();
    const minX = Math.min(...all.map((p) => p.x));
    const maxX = Math.max(...all.map((p) => p.x));
    const minY = Math.min(...all.map((p) => p.y));
    const maxY = Math.max(...all.map((p) => p.y));
    for (const side of ['top', 'bottom'] as const) {
      const o = chain(d.chains, side, 2);
      expect(o?.stops[0]).toBeCloseTo(minX, 3);
      expect(o?.stops[1]).toBeCloseTo(maxX, 3);
    }
    for (const side of ['left', 'right'] as const) {
      const o = chain(d.chains, side, 2);
      expect(o?.stops[0]).toBeCloseTo(minY, 3);
      expect(o?.stops[1]).toBeCloseTo(maxY, 3);
    }
    // Every window in an outside wall (a room on one side only, as the walk finds the front
    // door): its two edges in tier 0 of exactly one side.
    const shapes = [...roomShapes(level).values()];
    const inRoom = (p: Vec2) => shapes.some((s) => pointInPolygon(p, s.outer));
    const windows = geom.openings.filter((o) => {
      if (o.kind !== 'window') return false;
      const f = o.frame;
      const u = (o.span[0] + o.span[1]) / 2;
      const side = (k: number) => ({
        x: f.a.x + f.d.x * u + f.n.x * (f.half + 0.1) * k,
        y: f.a.y + f.d.y * u + f.n.y * (f.half + 0.1) * k,
      });
      return inRoom(side(1)) !== inRoom(side(-1));
    });
    expect(windows.length).toBeGreaterThanOrEqual(6);
    for (const w of windows) {
      const f = w.frame;
      const hits = (['top', 'right', 'bottom', 'left'] as const).filter((side) => {
        const t0 = chain(d.chains, side, 0);
        if (!t0) return false;
        const axis = side === 'top' || side === 'bottom' ? 'x' : 'y';
        const e = w.span.map((u) => f.a[axis] + f.d[axis] * u);
        return e.every((v) => t0.stops.some((s) => Math.abs(s - v) < 0.002));
      });
      expect(hits, w.opening.id).toHaveLength(1);
    }
    // Rounded to 10 mm, every tier adds up to its overall.
    for (const c of d.chains) {
      if (c.side === 'aligned') continue;
      const total = roundChain(c.stops, 0.01).reduce((s, p) => s + p, 0);
      const overall = chain(d.chains, c.side, 2) as DimensionChain;
      const [lo, hi] = overall.stops as [number, number];
      expect(total).toBeCloseTo(Math.round((hi - lo) * 100) / 100, 6);
    }
    // Every room gets a label point, and most a width and depth.
    expect(d.labels).toHaveLength(Object.keys(level.rooms).length);
    expect(d.spans.length).toBeGreaterThan(Object.keys(level.rooms).length);
    for (const s of d.spans) expect(Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y)).toBeGreaterThan(0.6);
    // Doors and windows are tagged.
    expect(d.tags.length).toBe(geom.openings.filter((o) => o.kind !== 'passage').length);
  });

  it('6: a room closed by a boundary measures to the boundary line', () => {
    // Two rooms side by side, 3 m and 2 m, divided by a boundary at x = 3.
    const level = build([
      { pts: box(5, 3) },
      {
        pts: [
          [3, 0],
          [3, 3],
        ],
        boundary: true,
      },
    ]);
    expect(Object.keys(level.rooms)).toHaveLength(2);
    const d = planDimensions(level);
    const widths = d.spans
      .filter((s) => s.axis === 'x')
      .map((s) => s.b.x - s.a.x)
      .sort((p, q) => p - q);
    expect(widths[0]).toBeCloseTo(1.95, 6);
    expect(widths[1]).toBeCloseTo(2.95, 6);
  });

  it('a face in a notch, hidden behind the flat, is left off the outside chains', () => {
    // A U: the notch (x 2–4, y 2–4) opens to the bottom.
    const u: [number, number][] = [
      [0, 0],
      [6, 0],
      [6, 4],
      [4, 4],
      [4, 2],
      [2, 2],
      [2, 4],
      [0, 4],
      [0, 0],
    ];
    const d = planDimensions(build([{ pts: u }]));
    // The notch's sides look at each other: neither is on the left or right chain.
    expect(chain(d.chains, 'right', 1)).toBeUndefined();
    expect(chain(d.chains, 'left', 1)).toBeUndefined();
    expect(pieces(chain(d.chains, 'right', 2))[0]).toBeCloseTo(4.1, 6);
    // From below, the notch's steps: 2.1, 1.9, 2.1 (faces of 100 mm walls).
    const bottom = pieces(chain(d.chains, 'bottom', 1));
    expect(bottom.map((p) => Number(p.toFixed(3)))).toEqual([2.1, 1.9, 2.1]);
    // Its extension lines start at a face that can be seen.
    const c = chain(d.chains, 'bottom', 1) as DimensionChain;
    expect(c.from.map((f) => Number(f.toFixed(3)))).toEqual([4.05, 4.05, 4.05, 4.05]);
  });

  it('a narrow room under 0.6 m gets no span across it', () => {
    const d = planDimensions(build([{ pts: box(4, 0.6) }]));
    expect(d.spans.filter((s) => s.axis === 'y')).toEqual([]);
    expect(d.spans.filter((s) => s.axis === 'x')).toHaveLength(1);
  });

  it('a door gets a tag on the side away from its swing', () => {
    const d = planDimensions(
      build([{ pts: box(4, 3) }], [{ kind: 'door', width: 0.9, at: { x: 2, y: 3 } }]),
    );
    const tag = d.tags.find((t) => t.kind === 'door');
    expect(tag?.width).toBeCloseTo(0.9, 6);
    // The door is to the outside: a tier-0 pair on the bottom.
    const t0 = pieces(chain(d.chains, 'bottom', 0));
    expect(t0[1]).toBeCloseTo(0.9, 6);
  });
});

describe('roundChain', () => {
  it('3: pieces rounded to 10 mm add up to the rounded overall', () => {
    const p = roundChain([0, 1.234, 2.468, 3.702], 0.01);
    expect(p).toHaveLength(3);
    expect(p.reduce((s, x) => s + x, 0)).toBeCloseTo(3.7, 9);
    for (const x of p) expect(Math.abs(x - 1.234)).toBeLessThan(0.01);
  });
  it('a single stop has no pieces', () => {
    expect(roundChain([1], 0.01)).toEqual([]);
  });
});

describe('sheetScale', () => {
  const sample = sampleFlatProject('prj_t').levels[0] as Level;
  const bounds = planDimensions(sample).bounds;
  it('7: the sample flat is 1:100 on A4 and 1:50 on A3', () => {
    if (!bounds) throw new Error('no bounds');
    expect(sheetScale(bounds, 'A4')).toEqual({ scale: 100, fits: true });
    expect(sheetScale(bounds, 'A3')).toEqual({ scale: 50, fits: true });
  });
  it('7: 25 m wide is 1:200 on A4; wider than 1:200 allows is not to scale', () => {
    const wide = (w: number) => ({ min: { x: 0, y: 0 }, max: { x: w, y: 8 } });
    expect(sheetScale(wide(25), 'A4').scale).toBe(200);
    const far = sheetScale(wide(40), 'A4');
    expect(far.fits).toBe(false);
    expect(far.scale).toBeGreaterThan(200);
    expect((40 * 1000) / far.scale).toBeLessThanOrEqual(147);
  });
});
