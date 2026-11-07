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
import {
  type Box,
  type Seg,
  boxHits,
  figureBox,
  figureWidth,
  notchDrawings,
  notchFigure,
  obstaclesOf,
  readingAngle,
} from './notches';

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
    const f = notchFigure(line, 6.5, '1000', { obstacles: { segs: [ext] } });
    expect(f.place).toBe('beside');
    expect(f.at.x).toBeLessThan(50);
    const g = notchFigure(line, 6.5, '1000', {
      obstacles: {
        segs: [
          [
            { x: 48.6, y: 30 },
            { x: 48.6, y: 60 },
          ],
        ],
      },
    });
    expect(g.at.x).toBeGreaterThan(50);
  });

  /** A printed figure ("1900"), level, centred on (x, y). */
  const label = (x: number, y: number, text = '1900'): Box => ({
    c: { x, y },
    hw: (text.length * 2.2 * 0.55) / 2,
    hh: 0.85,
    d: { x: 1, y: 0 },
  });
  const clear = (f: { at: { x: number; y: number }; deg: number }, text: string, b: Box) => {
    const r = (f.deg * Math.PI) / 180;
    const fb = figureBox(f.at, { x: Math.cos(r), y: Math.sin(r) }, figureWidth(text));
    return boxHits(fb, { boxes: [b] }) === 0;
  };

  it('M1: another chain’s figure across the line’s middle: the figure moves along the line, clear of it', () => {
    // A long line in a wide notch, a figure printed across its middle, both sides.
    const long = { a: { x: 50, y: 30 }, b: { x: 50, y: 50 } };
    const other = label(50, 40);
    const f = notchFigure(long, 19, '2000', { obstacles: { boxes: [other] } });
    expect(f.place).toBe('beside');
    expect(clear(f, '2000', other)).toBe(true);
    expect(Math.abs(f.at.y - 40)).toBeGreaterThan(1);
  });

  it('M1: both sides crossed all along: the break, then beyond the mouth', () => {
    // Text either side of the line, all along it: the line itself is clear.
    const walls = [label(47.5, 35, '00000000'), label(52.5, 35, '00000000')].map((b) => ({
      ...b,
      d: { x: 0, y: 1 },
      hw: 12,
      hh: 1,
    }));
    const brk = notchFigure(line, 6.5, '1000', { obstacles: { boxes: walls } });
    expect(brk.place).toBe('break');
    // And with the line's middle printed over too, beyond the mouth.
    const mid = { ...label(50, 45, '0000'), d: { x: 0, y: 1 }, hw: 5.5 };
    const out = notchFigure(line, 6.5, '1000', { obstacles: { boxes: [...walls, mid] } });
    expect(out.place).toBe('mouth');
    expect(out.at.y).toBeGreaterThan(50);
  });

  it('M2: beyond the mouth no further than 6 mm; else a leader from a clear spot beside the notch', () => {
    // A 1 mm slot (100 mm at 1:100); two chain rows 2 and 5 mm past the mouth, full width.
    const rows: Seg[] = [2, 5, 8, 11, 14].map((dy) => [
      { x: 0, y: 50 + dy },
      { x: 100, y: 50 + dy },
    ]);
    const f = notchFigure(line, 1, '1000', { obstacles: { segs: rows } });
    expect(f.place).toBe('leader');
    expect(f.deg).toBe(0);
    // Beside the slot, near the line's middle, and a leader from the line to it.
    expect(Math.abs(f.at.x - 50)).toBeLessThan(10);
    expect(f.at.y).toBeGreaterThan(40);
    expect(f.at.y).toBeLessThan(50);
    const l = f.leader as Seg;
    expect(Math.abs(l[0].x - 50)).toBeLessThan(0.5);
    expect(boxHits(figureBox(f.at, { x: 1, y: 0 }, figureWidth('1000')), { segs: rows })).toBe(0);
    // With room just past the mouth, it stays there (within 6 mm).
    const near = notchFigure(line, 1, '1000', { obstacles: { segs: rows.slice(2) } });
    expect(near.place).toBe('mouth');
  });

  it('L4: beyond the mouth, clear of a wall stub beside it', () => {
    // A stub of wall right past the mouth, across the line: the figure clears it.
    const stub = [
      { x: 49, y: 50.5 },
      { x: 53, y: 50.5 },
      { x: 53, y: 53 },
      { x: 49, y: 53 },
    ];
    const f = notchFigure(line, 1, '1700', { obstacles: { walls: [stub] } });
    expect(
      boxHits(
        figureBox(f.at, f.deg === 0 ? { x: 1, y: 0 } : { x: 0, y: -1 }, figureWidth('1700')),
        { walls: [stub] },
      ),
    ).toBe(0);
  });

  it('beyond the mouth, it moves out along the line past whatever it would touch', () => {
    const chain: Seg = [
      { x: 40, y: 52.5 },
      { x: 60, y: 52.5 },
    ];
    const f = notchFigure(line, 2, '1000', { obstacles: { segs: [chain] } });
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

  it('M3: a label on the centre line (a new wall’s length) moves the line across, clear of it', () => {
    // The U at 1:100: the depth on x = 30 mm from y 20.5 to 40.5; "2000" printed under the
    // back wall, centred on the line.
    const u: NotchDim = {
      a: { x: 3, y: 2.05 },
      b: { x: 3, y: 4.05 },
      gap: 1.9,
      notch: 0,
      corners: [
        { x: 2.05, y: 4.05 },
        { x: 3.95, y: 4.05 },
      ],
    };
    const teal: Box = { c: { x: 30, y: 21.7 }, hw: 2.1, hh: 0.75, d: { x: 1, y: 0 } };
    const [d] = notchDrawings([u], P, 10, { boxes: [teal] });
    if (!d) throw new Error('no depth');
    const [a, b] = d.ticks as [{ x: number; y: number }, { x: number; y: number }];
    expect(Math.abs(a.x - 30)).toBeGreaterThan(2.1);
    expect(Math.abs(b.x - a.x)).toBeLessThan(1e-9);
    // Still in the notch, and the figure clear of the label.
    expect(a.x).toBeGreaterThan(20.5);
    expect(a.x).toBeLessThan(39.5);
    const f = d.figures[0];
    if (!f) throw new Error('no figure');
    const r = (f.deg * Math.PI) / 180;
    const fb = figureBox(f.at, { x: Math.cos(r), y: Math.sin(r) }, figureWidth(f.text));
    expect(boxHits(fb, { boxes: [teal] })).toBe(0);
  });
});

describe('obstaclesOf', () => {
  it('reads lines and turned text from the sheet’s markup, a box per line of a name', () => {
    const svg = [
      '<line x1="1" y1="2" x2="3" y2="4" stroke="#000"></line>',
      '<text x="10" y="20" transform="rotate(-90 10 20)" font-size="2.2" text-anchor="middle" dominant-baseline="central">1900</text>',
      '<text x="50" y="50" font-size="2.6" font-weight="700" text-anchor="middle"><tspan x="50" dy="0">Main </tspan><tspan x="50" dy="2.86">bedroom</tspan></text>',
    ].join('');
    const o = obstaclesOf(svg);
    expect(o.segs).toEqual([
      [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
    ]);
    expect(o.boxes).toHaveLength(3);
    const [fig, l1, l2] = o.boxes as [Box, Box, Box];
    // Turned a quarter: it runs up the page, centred where it is drawn.
    expect(fig.c.x).toBeCloseTo(10, 6);
    expect(fig.c.y).toBeCloseTo(20, 6);
    expect(fig.d.y).toBeCloseTo(-1, 6);
    expect(fig.hw).toBeCloseTo((4 * 2.2 * 0.55) / 2, 6);
    expect(l2.c.y - l1.c.y).toBeCloseTo(2.86, 6);
    expect(l2.hw).toBeGreaterThan(l1.hw);
  });
});
