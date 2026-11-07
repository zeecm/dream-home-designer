import {
  AFTER_SUFFIX,
  type EditorDoc,
  type Level,
  type Project,
  blankProject,
  deleteWall,
  dispatch,
  drawWall,
  emptyHistory,
  startRenovation,
} from '@dhd/core';
import { describe, expect, it, vi } from 'vitest';
import { contractorMarkup } from './contractorSheet';
import { type Seg, boxHits, obstaclesOf } from './notches';

// The change list's wording comes from the app's panel, which needs a browser; not here.
vi.mock('../ui/Renovation', () => ({ changesAsText: () => '' }));

type Pts = [number, number][];

/** A project drawn with the editor's own commands, in polylines of 100 mm walls. */
function drawn(lines: Pts[], level = (s: EditorDoc) => s.doc.levels[0] as Level, from?: EditorDoc) {
  let s: EditorDoc = from ?? { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
  for (const pts of lines) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i] as [number, number];
      const [bx, by] = pts[i + 1] as [number, number];
      const r = drawWall(
        level(s),
        { point: { x: ax, y: ay } },
        { point: { x: bx, y: by } },
        {
          thickness: 0.1,
        },
      );
      s = dispatch(s, r.command);
    }
  }
  return s;
}

/** Page 1 split: the depths' group, and everything else it must keep clear of. */
async function page1(project: Project, variant: 'before' | 'after' = 'before') {
  const [svg = ''] = await contractorMarkup(project, { paper: 'A4', variant, furniture: false });
  const groups = [...svg.matchAll(/<g class="dim-notch"[\s\S]*?<\/g>/g)].map((m) => m[0]);
  let rest = svg;
  for (const g of groups) rest = rest.replace(g, '');
  return { notch: obstaclesOf(groups.join('')), rest: obstaclesOf(rest), groups };
}

/** The U, notch x 2–4 from y 2, open at the bottom. */
const U: Pts = [
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

describe('contractor sheet: notch depths keep clear of what else is printed', () => {
  it('M1: a slanted U: the depth’s figure is clear of the slanted chain’s figures and every label', async () => {
    const th = 0.5;
    const turned = U.map(([x, y]): [number, number] => [
      x * Math.cos(th) - y * Math.sin(th),
      x * Math.sin(th) + y * Math.cos(th),
    ]);
    const { notch, rest, groups } = await page1(drawn([turned]).doc);
    expect(groups).toHaveLength(1);
    expect(notch.boxes).toHaveLength(1);
    for (const b of notch.boxes) expect(boxHits(b, { boxes: rest.boxes })).toBe(0);
  });

  it('M2: a 100 mm slot at 1:50: the figure is near the slot, on a leader, not out past the chains', async () => {
    const slot: Pts = [
      [0, 0],
      [6, 0],
      [6, 4],
      [3.1, 4],
      [3.1, 1],
      [2.9, 1],
      [2.9, 4],
      [0, 4],
      [0, 0],
    ];
    const { notch, rest, groups } = await page1(drawn([slot]).doc);
    expect(groups).toHaveLength(1);
    const [fig] = notch.boxes;
    if (!fig) throw new Error('no figure');
    for (const b of notch.boxes) expect(boxHits(b, { boxes: rest.boxes, segs: rest.segs })).toBe(0);
    // The depth's line: the longest of the group's lines (ticks are short).
    const line = [...notch.segs].sort(
      (p, q) =>
        Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) - Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y),
    )[0] as Seg;
    const near = (p: { x: number; y: number }) => {
      const [a, b] = line;
      const t = Math.max(
        0,
        Math.min(
          1,
          ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) /
            ((b.x - a.x) ** 2 + (b.y - a.y) ** 2),
        ),
      );
      return Math.hypot(p.x - a.x - t * (b.x - a.x), p.y - a.y - t * (b.y - a.y));
    };
    expect(near(fig.c)).toBeLessThan(15);
    // Above the mouth's chains: no lower than 6 mm past the mouth.
    const mouth = Math.max(line[0].y, line[1].y);
    expect(fig.c.y).toBeLessThan(mouth + 6 + 3);
    expect(groups[0]).toContain('data-place="leader"');
  });

  it('M3: After, a notch made by new walls: the depth line and figure keep off the new wall’s length', async () => {
    let s = drawn([
      [
        [0, 0],
        [6, 0],
        [6, 4],
        [0, 4],
        [0, 0],
      ],
    ]);
    s = dispatch(s, startRenovation());
    const after = (x: EditorDoc) => x.doc.renovation?.levels[0] as Level;
    s = drawn(
      [
        [
          [2, 4],
          [2, 2],
          [4, 2],
          [4, 4],
        ],
      ],
      after,
      s,
    );
    const lvl = after(s);
    const mouth = Object.values(lvl.walls).find((w) => {
      const a = lvl.vertices[w.a];
      const b = lvl.vertices[w.b];
      return (
        a && b && a.y === 4 && b.y === 4 && Math.min(a.x, b.x) === 2 && Math.max(a.x, b.x) === 4
      );
    });
    if (!mouth) throw new Error('no wall across the mouth');
    s = dispatch(s, deleteWall(`${s.doc.levels[0]?.id}${AFTER_SUFFIX}`, mouth.id, lvl));
    const { notch, rest, groups } = await page1(s.doc, 'after');
    expect(groups).toHaveLength(1);
    const svg =
      (await contractorMarkup(s.doc, { paper: 'A4', variant: 'after', furniture: false }))[0] ?? '';
    const teal = obstaclesOf(
      [...svg.matchAll(/<text[^>]*class="built-length"[\s\S]*?<\/text>/g)]
        .map((m) => m[0])
        .join(''),
    ).boxes;
    expect(teal.length).toBeGreaterThan(0);
    // No line of the depth crosses a new wall's length; no figure sits on any label.
    for (const seg of notch.segs) {
      for (const b of teal) expect(boxHits({ ...b, hw: b.hw, hh: b.hh }, { segs: [seg] })).toBe(0);
    }
    for (const b of notch.boxes) expect(boxHits(b, { boxes: rest.boxes })).toBe(0);
  });
});
