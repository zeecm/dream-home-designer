import {
  type EditorDoc,
  type Level,
  type NotchDim,
  blankProject,
  dispatch,
  drawWall,
  emptyHistory,
  planDimensions,
  sampleFlatProject,
} from '@dhd/core';
import { describe, expect, it } from 'vitest';
import { type Seg, notchDrawings, notchFigure, readingAngle } from './notches';

/** An upright line 10 mm long on paper, inner end at the top. */
const line = { a: { x: 50, y: 40 }, b: { x: 50, y: 50 } };

describe('notchFigure', () => {
  it('6: a gap of 6.5 mm puts the figure beside the line, reading along it', () => {
    const f = notchFigure(line, 6.5, '1000');
    expect(f.place).toBe('beside');
    expect(Math.abs(f.at.x - 50)).toBeGreaterThan(1);
    expect(Math.abs(f.at.x - 50)).toBeLessThan(3.25);
    expect(f.at.y).toBeCloseTo(45, 6);
    expect(f.deg).toBe(-90);
  });

  it('6: a gap of 3.2 mm puts it in a break in the line; under 2.8 mm, beyond the mouth', () => {
    const brk = notchFigure(line, 3.2, '1000');
    expect(brk.place).toBe('break');
    expect(brk.at).toEqual({ x: 50, y: 45 });
    const out = notchFigure(line, 2, '1000');
    expect(out.place).toBe('mouth');
    expect(out.at.x).toBeCloseTo(50, 6);
    expect(out.at.y).toBeGreaterThan(50);
  });

  it('beside, on the side no extension line crosses', () => {
    // An extension line running down the slot 1.4 mm right of the line.
    const ext: Seg = [
      { x: 51.4, y: 30 },
      { x: 51.4, y: 60 },
    ];
    const f = notchFigure(line, 6.5, '1000', { blockers: [ext] });
    expect(f.place).toBe('beside');
    expect(f.at.x).toBeLessThan(50);
    const g = notchFigure(line, 6.5, '1000', {
      blockers: [
        [
          { x: 48.6, y: 30 },
          { x: 48.6, y: 60 },
        ],
      ],
    });
    expect(g.at.x).toBeGreaterThan(50);
  });

  it('beyond the mouth, it moves out along the line past whatever it would touch', () => {
    const chain: Seg = [
      { x: 40, y: 52.5 },
      { x: 60, y: 52.5 },
    ];
    const f = notchFigure(line, 2, '1000', { blockers: [chain] });
    expect(f.place).toBe('mouth');
    // Clear of the chain line: its near end past 52.5 by the margin.
    expect(f.at.y - (4 * 2.2 * 0.55) / 2).toBeGreaterThan(52.5);
  });

  it('figures never read upside down; an upright line reads upwards', () => {
    expect(readingAngle({ x: 0, y: 1 })).toBe(-90);
    expect(readingAngle({ x: 0, y: -1 })).toBe(-90);
    expect(readingAngle({ x: -1, y: 0 })).toBeCloseTo(0, 6);
    expect(readingAngle({ x: 1, y: 1 })).toBeCloseTo(45, 6);
  });
});

describe('notchDrawings', () => {
  const P = (v: { x: number; y: number }) => ({ x: v.x * 10, y: v.y * 10 });

  it('the sample on A4 (1:100): one depth, 1000, its figure beside the line', () => {
    const level = sampleFlatProject('prj_t').levels[0] as Level;
    const d = notchDrawings(planDimensions(level).notches, P, 10);
    expect(d).toHaveLength(1);
    expect(d[0]?.depths).toEqual(['1000']);
    expect(d[0]?.figures[0]?.place).toBe('beside');
    expect(d[0]?.ticks).toHaveLength(2);
    // An extension line from where a flank turns at the mouth.
    expect(d[0]?.ext).toHaveLength(1);
  });

  const two = (apart: number): NotchDim[] => [
    {
      a: { x: 2.5, y: 2.05 },
      b: { x: 2.5, y: 4.05 },
      gap: 1.9,
      notch: 0,
      corners: [{ x: 2.05, y: 4.05 }],
    },
    {
      a: { x: 2.5 + apart, y: 2.05 },
      b: { x: 2.5 + apart, y: 3.75 },
      gap: 1.9,
      notch: 0,
      corners: [{ x: 3.95, y: 3.75 }],
    },
  ];

  it('two depths of a notch 8 mm apart or more: one each', () => {
    const d = notchDrawings(two(0.95), P, 10);
    expect(d.map((x) => x.depths)).toEqual([['2000'], ['1700']]);
  });

  it('two depths under 8 mm apart: one chain on the centre line, back face, nearer and further mouth', () => {
    const d = notchDrawings(two(0.5), P, 10);
    expect(d).toHaveLength(1);
    expect(d[0]?.depths).toEqual(['1700', '300']);
    expect(d[0]?.ticks.map((t) => Number(t.y.toFixed(2)))).toEqual([20.5, 37.5, 40.5]);
    expect(d[0]?.ticks.every((t) => Math.abs(t.x - 27.5) < 1e-6)).toBe(true);
    expect(d[0]?.ext).toHaveLength(2);
  });

  it('a tapered pair, however close on paper, stays two depths: a chain would make up figures', () => {
    // A U whose left flank slants 0.3 m out over its 2 m (core's tapered-notch fixture).
    let st: EditorDoc = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
    const pts: [number, number][] = [
      [0, 0],
      [6, 0],
      [6, 4],
      [4, 4],
      [4, 2],
      [2, 2],
      [1.7, 4],
      [0, 4],
      [0, 0],
    ];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i] as [number, number];
      const [bx, by] = pts[i + 1] as [number, number];
      const lvl = st.doc.levels[0] as Level;
      const r = drawWall(
        lvl,
        { point: { x: ax, y: ay } },
        { point: { x: bx, y: by } },
        {
          thickness: 0.1,
        },
      );
      st = dispatch(st, r.command);
    }
    const notches = planDimensions(st.doc.levels[0] as Level).notches;
    expect(notches).toHaveLength(2);
    // At 1:200 (5 mm a metre) the two lines are under 8 mm apart, but not parallel.
    const P5 = (v: { x: number; y: number }) => ({ x: v.x * 5, y: v.y * 5 });
    const d = notchDrawings(notches, P5, 5);
    expect(d).toHaveLength(2);
    const depths = d.flatMap((x) => x.depths).sort();
    const expected = notches
      .map((n) => String(Math.round(Math.hypot(n.b.x - n.a.x, n.b.y - n.a.y) * 100) * 10))
      .sort();
    expect(depths).toEqual(expected);
    expect(depths).toEqual(['2000', '2020']);
  });
});
