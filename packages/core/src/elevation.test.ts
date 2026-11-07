import { freeze } from 'immer';
import { describe, expect, it } from 'vitest';
import { addOpening, deleteWall, renameRoom, splitWall, updateRoom, updateWall } from './commands';
import { roundChain } from './dimensions';
import { addPoint, updatePoint } from './electrical';
import {
  type Elevation,
  chainFigures,
  elevationChanges,
  elevationLabels,
  midSentence,
  wallElevation,
} from './elevation';
import { type RoomFace, faceAt, faceRef, resolveFace, roomFaces } from './faces';
import { furnishedSample } from './fixtures/furnishedSample';
import {
  LID,
  R_SEGS,
  apply,
  level,
  opening,
  piece,
  roomId,
  roomR,
  wallAlong,
  walls,
} from './fixtures/roomR';
import { addItem } from './furniture';
import type { EditorDoc } from './history';
import { AFTER_SUFFIX } from './levels';
import { startRenovation } from './renovation';
import type { Item, Level } from './schema';
import { markStructural } from './structural';

const A = `${LID}${AFTER_SUFFIX}`;
const faces = (l: Level) => roomFaces(l, roomId(l));
const face = (l: Level, letter: string) => faces(l).find((f) => f.letter === letter) as RoomFace;
const elev = (s: EditorDoc, letter: string, opts = {}) => {
  const l = level(s);
  return wallElevation(l, face(l, letter), opts);
};
const top = (s: EditorDoc) => wallAlong(level(s), [0, 0], [4, 0]);
const right = (s: EditorDoc) => wallAlong(level(s), [4, 0], [4, 3]);
const tier = (e: Elevation, t: number) => e.chains.find((c) => c.tier === t)?.stops ?? [];
const withItems = (s: EditorDoc, ...items: Item[]) =>
  apply(s, ...items.map((it) => addItem(LID, it)));
const socket = (wallId: string, t: number, height: number, kind = 'socket-double' as const) =>
  addPoint(LID, { kind, wall: { wallId, t, side: 'left', height } });

describe('wallElevation', () => {
  it('AC5: a socket at t 0.25 on the top wall is at u 0.95 in C; the door in A', () => {
    const s0 = roomR();
    const s = apply(s0, socket(top(s0), 0.25, 0.3).command);
    const c = elev(s, 'C');
    expect(c.points).toHaveLength(1);
    expect(c.points[0]?.u).toBeCloseTo(0.95, 6);
    expect(c.points[0]?.z).toBeCloseTo(0.3, 6);
    expect(c.points[0]?.n).toBe(1);
    const a = elev(s, 'A');
    expect(a.openings).toHaveLength(1);
    expect(a.openings[0]?.u0).toBeCloseTo(1.5, 6);
    expect(a.openings[0]?.u1).toBeCloseTo(2.4, 6);
    expect(roundChain(tier(a, 1), 0.01)).toEqual([1.5, 0.9, 1.5]);
    expect(roundChain(tier(a, 2), 0.01)).toEqual([3.9]);
    // The handle: a leftIn door hinges at vertex a's end (x = 2.45 on the bottom wall, drawn
    // from x 4 to 0), so its latch is at x 1.55, which is on the right as you face A.
    expect(a.openings[0]?.latch).toBe('right');
  });

  it('AC6: a 1.20 window centred on the top wall, sill 0.90, height 1.20', () => {
    const s0 = roomR();
    const s = apply(
      s0,
      opening(level(s0), [0, 0], [4, 0], { kind: 'window', width: 1.2, sill: 0.9, height: 1.2 }),
    );
    const c = elev(s, 'C');
    const w = c.openings[0];
    expect(w?.kind).toBe('window');
    expect(w?.u0).toBeCloseTo(1.35, 6);
    expect(w?.u1).toBeCloseTo(2.55, 6);
    expect(w?.sill).toBeCloseTo(0.9, 6);
    expect(w?.head).toBeCloseTo(2.1, 6);
    expect(chainFigures(tier(c, 1))).toEqual([1350, 1200, 1350]);
    const win = c.heights.find((h) => h.what === 'window');
    expect(win?.marks.map((z) => Math.round(z * 1000))).toEqual([900, 2100]);
    expect(c.heights.find((h) => h.what === 'ceiling')?.marks).toEqual([2.6]);
    expect(faces(level(s)).find((f) => f.letter === 'C')?.label).toBe('window wall');
  });

  it('AC7: a built-in wardrobe against the right wall: fronts and a top cabinet line', () => {
    const s = withItems(
      roomR(),
      piece('it_w', 'built-in-wardrobe', 3.65, 1.5, Math.PI / 2),
      piece('it_t', 'coffee-table', 2.1, 1.5),
    );
    const d = elev(s, 'D');
    expect(d.items.map((i) => i.id)).toEqual(['it_w']);
    const w = d.items[0];
    expect(w?.outline.u0).toBeCloseTo(0.55, 6);
    expect(w?.outline.u1).toBeCloseTo(2.35, 6);
    expect(w?.outline.z0).toBeCloseTo(0, 6);
    expect(w?.outline.z1).toBeCloseTo(2.6, 6);
    expect(w?.square && w.against).toBe(true);
    expect(w?.fronts.map((f) => Number((f.u1 - f.u0).toFixed(3)))).toEqual([0.6, 0.6, 0.6]);
    expect(w?.lines).toEqual([2.1]);
    expect(faces(level(s)).find((f) => f.letter === 'D')?.label).toBe('wardrobe wall');
    // Tier 0 adds the wardrobe's edges.
    expect(chainFigures(tier(d, 0))).toEqual([550, 1800, 550]);
    expect(elev(s, 'D', { furniture: 'none' }).items).toEqual([]);
  });

  it('AC8: a socket hidden behind a wardrobe, not behind a fridge, TV console or bedside', () => {
    const s0 = roomR();
    const sock = socket(right(s0), 1 / 3, 0.3);
    const s1 = apply(s0, sock.command);
    const hidden = (it: Item) =>
      elev(withItems(s1, it), 'D').notes.filter((n) => n.kind === 'hidden');
    const notes = hidden(piece('it_w', 'built-in-wardrobe', 3.65, 1.5, Math.PI / 2));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.ids).toEqual([sock.pointId, 'it_w']);
    expect(notes[0]?.text).toBe(
      'Socket 1 is behind the built-in wardrobe: you won’t reach it. Move it, or ask the carpenter for a cut-out.',
    );
    expect(hidden(piece('it_f', 'fridge', 3.6, 1, Math.PI / 2))).toEqual([]);
    expect(hidden(piece('it_c', 'tv-console', 3.75, 1, Math.PI / 2))).toEqual([]);
    expect(hidden(piece('it_b', 'bedside', 3.75, 1, Math.PI / 2))).toEqual([]);
    const cook = addPoint(LID, {
      kind: 'cooker',
      wall: { wallId: right(s0), t: 1 / 3, side: 'left', height: 0.6 },
    });
    const s2 = withItems(
      apply(s0, cook.command),
      piece('it_h', 'kitchen-hob', 3.65, 1, Math.PI / 2),
    );
    expect(elev(s2, 'D').notes).toEqual([]);
  });

  it('AC9: a wardrobe covering 0.50 m of the window; a desk under the sill does not', () => {
    const s0 = roomR();
    const s1 = apply(
      s0,
      opening(level(s0), [0, 0], [4, 0], { kind: 'window', width: 1.2, sill: 0.9, height: 1.2 }),
    );
    const s = withItems(s1, piece('it_w', 'built-in-wardrobe', 1.0, 0.35));
    const n = elev(s, 'C').notes.filter((x) => x.kind === 'covers');
    expect(n.map((x) => x.text)).toEqual(['The built-in wardrobe covers 0.50 m of Window 1.']);
    const d = withItems(s1, piece('it_d', 'desk', 2, 0.35));
    expect(elev(d, 'C').notes).toEqual([]);
  });

  it('AC10: a wall run 0.45 m over a base run gets a note; 0.60 none; 0.60 over a hob, a note', () => {
    const at = (gap: number, base = 'built-in-kitchen-base') => {
      const b = piece('it_b', base, 2, 0.35);
      const w = piece('it_u', 'built-in-kitchen-wall', 2, 0.225);
      w.position = { ...w.position, y: 0.9 + gap };
      return elev(withItems(roomR(), b, w), 'C').notes.filter((x) => x.kind === 'lowCabinet');
    };
    expect(at(0.45).map((n) => n.text)).toEqual([
      '0.45 m between the counter and the wall cabinets: 0.55 m or more is usual.',
    ]);
    expect(at(0.6)).toEqual([]);
    expect(at(0.6, 'kitchen-hob').map((n) => n.text)).toEqual([
      '0.60 m between the hob and the wall cabinets: at least 0.65 m is usual over a hob, for the hood.',
    ]);
    // The catalogue's own wall cabinet (at 1.45) over a base cabinet: no note.
    const s = withItems(
      roomR(),
      piece('it_b', 'kitchen-base', 2, 0.35),
      piece('it_u', 'kitchen-wall', 2, 0.225),
    );
    expect(elev(s, 'C').notes).toEqual([]);
    // Over a hob it is 0.55 m from the worktop (not from the hob's glass on it): a note.
    const h = withItems(
      roomR(),
      piece('it_b', 'kitchen-hob', 2, 0.35),
      piece('it_u', 'kitchen-wall', 2, 0.225),
    );
    expect(elev(h, 'C').notes.map((n) => n.text.slice(0, 6))).toEqual(['0.55 m']);
    expect(elev(h, 'C').heights.find((x) => x.what === 'counter')?.marks).toEqual([0.9]);
  });

  it('AC11: a wall run on the shelter wall gets a note; on a structural wall none', () => {
    const s0 = roomR();
    const run = piece('it_u', 'built-in-kitchen-wall', 2, 0.225);
    const shelter = withItems(
      apply(s0, renameRoom(LID, roomId(level(s0)), 'Household shelter')),
      run,
    );
    expect(elev(shelter, 'C').notes.map((n) => n.kind)).toEqual(['shelterFixing']);
    expect(elev(shelter, 'C').notes[0]?.text).toBe(
      'The kitchen wall run is fixed to the household shelter wall: HDB doesn’t allow drilling it.',
    );
    const structural = withItems(apply(s0, markStructural([top(s0)], true)), run);
    expect(elev(structural, 'C').notes).toEqual([]);
    expect(elev(structural, 'C').walls[0]?.status).toBe('structural');
  });

  it('AC12: a 2.60 m built-in in a room with a 2.50 m ceiling', () => {
    const s0 = roomR();
    const s = withItems(
      apply(s0, updateRoom(LID, roomId(level(s0)), { ceilingHeight: 2.5 })),
      piece('it_w', 'built-in-wardrobe', 3.65, 1.5, Math.PI / 2),
    );
    const d = elev(s, 'D');
    expect(d.ceiling).toBe(2.5);
    expect(d.notes.map((n) => [n.kind, n.text])).toEqual([
      ['tooTall', 'The built-in wardrobe is 0.10 m taller than this room’s ceiling.'],
    ]);
  });

  it('AC13: a half wall with glass above, a glass wall, and a boundary', () => {
    const s0 = roomR();
    const half = elev(apply(s0, updateWall(LID, top(s0), { height: 1.05, glassAbove: true })), 'C');
    expect(half.walls.map((w) => [w.build, w.top, w.glassAbove])).toEqual([['half', 1.05, true]]);
    expect(half.walls[0]?.panes.length).toBeGreaterThan(0);
    expect(half.walls[0]?.panes.every((p) => p.z0 >= 1.05 && p.z1 <= 2.6)).toBe(true);
    expect(half.heights.find((h) => h.what === 'half')?.marks).toEqual([1.05]);
    const glass = elev(apply(s0, updateWall(LID, top(s0), { build: 'glass' })), 'C');
    expect(glass.walls.map((w) => w.build)).toEqual(['glass']);
    expect(glass.points).toEqual([]);
    const b = walls([...R_SEGS, [2, 0, 2, 3]], (i) => (i === 4 ? { kind: 'boundary' } : {}));
    const l = level(b);
    const mid = wallAlong(l, [2, 0], [2, 3]);
    const f = faceAt(l, mid, 'left') as RoomFace;
    const other = l.rooms[(faceAt(l, mid, 'right') as RoomFace).roomId]?.name;
    expect(wallElevation(l, f).walls.map((w) => w.build)).toEqual(['open']);
    expect(f.label).toBe(`open to ${other}`);
  });

  it('AC15: trunking with a 2.0 m leg along the top wall', () => {
    const s0 = roomR();
    const unit = addPoint(LID, {
      kind: 'aircon',
      wall: { wallId: top(s0), t: 0.25, side: 'left', height: 2.4 },
      route: [
        { x: 3, y: 0.1 },
        { x: 3, y: 1 },
      ],
    });
    const c = elev(apply(s0, unit.command), 'C');
    expect(c.trunking).toHaveLength(1);
    expect(c.trunking[0]?.length).toBeCloseTo(2, 6);
    // An aircon unit's tag is its top; its plate centre half its height lower.
    expect(c.points[0]?.tagHeight).toBe(2.4);
    expect(c.points[0]?.z).toBeCloseTo(2.4 - 0.145, 6);
  });

  it('a stub wall standing out from a face is a section band across it', () => {
    const s = roomR([[2, 0, 2, 1]]);
    const l = level(s);
    const c = faces(l).find((f) => f.letter === 'C') as RoomFace;
    const e = wallElevation(l, c);
    expect(e.fins).toHaveLength(1);
    expect(e.fins[0]?.u0).toBeCloseTo(1.9, 6);
    expect(e.fins[0]?.u1).toBeCloseTo(2.0, 6);
    expect(e.ends).toHaveLength(2);
  });

  it('an empty face; the finish named in the header', () => {
    const s0 = roomR();
    const e = elev(apply(s0, updateWall(LID, top(s0), { materialLeft: 'paint-sage' })), 'C');
    expect(e.empty).toBe(true);
    expect(e.finishName).toBe('Sage paint');
    const p = elev(apply(s0, updateWall(LID, top(s0), { materialLeft: 'wallpaper-fluted' })), 'C');
    expect(p.finishName).toBe('Fluted wood wallpaper');
  });

  it('a 30° turn changes no u or z', () => {
    const k = Math.PI / 6;
    const r = (x: number, y: number) => [
      x * Math.cos(k) - y * Math.sin(k),
      x * Math.sin(k) + y * Math.cos(k),
    ];
    const segs = R_SEGS.map(
      ([ax, ay, bx, by]) => [...r(ax, ay), ...r(bx, by)] as [number, number, number, number],
    );
    const s0 = walls(segs);
    const l0 = level(s0);
    const [tx0, ty0] = r(0, 0) as [number, number];
    const [tx1, ty1] = r(4, 0) as [number, number];
    const t = wallAlong(l0, [tx0, ty0], [tx1, ty1]);
    const [wx, wy] = r(1.0, 0.35) as [number, number];
    const ward = piece('it_w', 'built-in-wardrobe', wx, wy, k);
    const s = withItems(apply(s0, socket(t, 0.25, 0.3).command), ward);
    const l = level(s);
    const c = faceAt(l, t, 'left') as RoomFace;
    const e = wallElevation(l, c);
    expect(c.length).toBeCloseTo(3.9, 6);
    expect(e.points[0]?.u).toBeCloseTo(0.95, 6);
    expect(e.items[0]?.square).toBe(true);
    expect(e.items[0]?.outline.u0).toBeCloseTo(0.05, 6);
    expect(e.items[0]?.outline.u1).toBeCloseTo(1.85, 6);
  });
});

describe('columns and outside corners', () => {
  /** A 0.4 m square column of 100 mm walls, its corner at (x, y). */
  const column = (x: number, y: number): [number, number, number, number][] => [
    [x, y, x + 0.4, y],
    [x + 0.4, y, x + 0.4, y + 0.4],
    [x + 0.4, y + 0.4, x, y + 0.4],
    [x, y + 0.4, x, y],
  ];
  const holeFaces = (l: Level) => faces(l).filter((f) => f.kind === 'hole');

  it('a column: no cut bands on its faces, and nothing behind it drawn on them', () => {
    const s = withItems(
      walls([...R_SEGS, ...column(1.5, 1.2)]),
      // Against the right wall, behind the column as seen on its west face.
      piece('it_b', 'bookshelf', 3.8, 1.4, Math.PI / 2),
    );
    const l = level(s);
    const hs = holeFaces(l);
    expect(hs).toHaveLength(4);
    for (const f of hs) {
      const e = wallElevation(l, f);
      expect(e.ends).toEqual([]);
      expect(e.items.map((i) => i.id)).toEqual([]);
    }
    // The right wall, facing the bookshelf, still has it, and both its corners cut.
    const d = faces(l).find((f) => f.kind === 'wall' && f.normal.x < -0.9) as RoomFace;
    const e = wallElevation(l, d);
    expect(e.items.map((i) => i.id)).toEqual(['it_b']);
    expect(e.ends).toHaveLength(2);
  });

  it('two columns: each a loop of its own, neither linked to the other', () => {
    const l = level(walls([...R_SEGS, ...column(1.0, 1.2), ...column(2.5, 1.2)]));
    const hs = holeFaces(l);
    expect(hs).toHaveLength(8);
    expect(new Set(hs.map((f) => f.loop)).size).toBe(2);
    for (const f of hs) expect(wallElevation(l, f).ends).toEqual([]);
  });

  it('an L-shaped room: no cut band at its outside corner', () => {
    const l = level(
      walls([
        [0, 0, 4, 0],
        [4, 0, 4, 3],
        [4, 3, 2, 3],
        [2, 3, 2, 1.5],
        [2, 1.5, 0, 1.5],
        [0, 1.5, 0, 0],
      ]),
    );
    const inner = faceAt(l, wallAlong(l, [2, 3], [2, 1.5]), 'left') as RoomFace;
    const step = faceAt(l, wallAlong(l, [2, 1.5], [0, 1.5]), 'left') as RoomFace;
    expect(inner && step).toBeTruthy();
    for (const f of [inner, step]) {
      const e = wallElevation(l, f);
      expect(e.ends).toHaveLength(1);
    }
    // The inside corner's band is at the far end of each, away from the outside corner.
    expect(wallElevation(l, inner).ends[0]?.u0).toBeLessThan(0);
    expect(wallElevation(l, step).ends[0]?.u0).toBeGreaterThan(0);
  });
});

describe('elevationChanges', () => {
  /** R with a socket on the top wall, and a renovation started. */
  const reno = () => {
    const s0 = roomR();
    const sock = socket(top(s0), 0.25, 0.3);
    return { s: apply(s0, sock.command, startRenovation()), pointId: sock.pointId };
  };
  const afterOf = (s: EditorDoc) => s.doc.renovation?.levels[0] as Level;

  it('AC16: a window added in After, a socket moved 1 m along', () => {
    const { s, pointId } = reno();
    const t = top(s);
    const win = addOpening(A, {
      wallId: t,
      kind: 'window',
      t: 0.5,
      width: 1.2,
      height: 1.2,
      sill: 0.9,
    });
    const s2 = apply(
      s,
      win.command,
      updatePoint(A, pointId, { wall: { wallId: t, t: 0.5, side: 'left', height: 0.3 } }),
    );
    const c = faceAt(afterOf(s2), t, 'left') as RoomFace;
    const ch = elevationChanges(level(s2), afterOf(s2), c);
    expect(ch.added.has(win.openingId)).toBe(true);
    expect(ch.added.has(pointId)).toBe(true);
    expect(ch.moved).toHaveLength(1);
    expect(ch.moved[0]?.from?.u).toBeCloseTo(0.95, 6);
    expect(ch.hacked).toEqual([]);
    // Before keeps the same face, with no window.
    const before = resolveFace(level(s2), faceRef(c)) as RoomFace;
    expect(before.length).toBeCloseTo(3.9, 6);
    expect(wallElevation(level(s2), before).openings).toEqual([]);
  });

  it('AC16: half the top wall cut down is hacked (and built) on that stretch', () => {
    const { s } = reno();
    const t = top(s);
    const split = splitWall(A, t, { x: 2, y: 0 }, afterOf(s));
    const s1 = apply(s, split.command);
    const half = wallAlong(afterOf(s1), [2, 0], [4, 0]);
    const s2 = apply(s1, updateWall(A, half, { height: 1.0 }));
    const c = resolveFace(
      afterOf(s2),
      faceRef(faceAt(level(s2), t, 'left') as RoomFace),
    ) as RoomFace;
    expect(c.length).toBeCloseTo(3.9, 6);
    const ch = elevationChanges(level(s2), afterOf(s2), c);
    expect(ch.hacked).toHaveLength(1);
    expect(ch.hacked[0]?.[0]).toBeCloseTo(1.95, 2);
    expect(ch.hacked[0]?.[1]).toBeCloseTo(3.9, 6);
  });

  it('AC16: the whole wall hacked: no face in After', () => {
    const { s } = reno();
    const t = top(s);
    const ref = faceRef(faceAt(level(s), t, 'left') as RoomFace);
    const s1 = apply(s, deleteWall(A, t, afterOf(s)));
    expect(resolveFace(afterOf(s1), ref)).toBeNull();
    expect(resolveFace(level(s1), ref)?.length).toBeCloseTo(3.9, 6);
  });

  it('a piece in Before only (removed in After) is drawn where it was', () => {
    const { s } = reno();
    const s1 = apply(s, addItem(LID, piece('it_w', 'built-in-wardrobe', 3.65, 1.5, Math.PI / 2)));
    const l = level(s1);
    const lA = afterOf(s1);
    const d = faceAt(lA, right(s1), 'left') as RoomFace;
    const ch = elevationChanges(l, lA, d);
    expect(ch.removed.map((r) => [r.kind, r.id])).toEqual([['item', 'it_w']]);
  });
});

describe('elevation labels', () => {
  it('hides tier 0 and point tags until the scale lets them fit', () => {
    const s0 = roomR();
    const s = withItems(
      apply(s0, socket(right(s0), 0.3, 0.3).command, socket(right(s0), 0.34, 0.3).command),
      piece('it_w', 'built-in-wardrobe', 3.65, 1.5, Math.PI / 2),
    );
    const d = elev(s, 'D');
    const small = elevationLabels(d, 30);
    expect(small.chains.find((c) => c.tier === 0)?.show).toBe(false);
    expect(small.chains.find((c) => c.tier === 2)?.show).toBe(true);
    expect(small.tags).toBe('none');
    const big = elevationLabels(d, 600);
    expect(big.chains.every((c) => c.show && c.figures.every(Boolean))).toBe(true);
    expect(big.tags).toBe('full');
    expect(big.heights.every((h) => h.every(Boolean))).toBe(true);
  });

  it('keeps height figures in neighbouring columns from overlapping', () => {
    const s0 = roomR();
    const s1 = apply(
      s0,
      opening(level(s0), [0, 0], [4, 0], { kind: 'window', width: 1.2, sill: 0.9, height: 1.2 }),
    );
    // A wall cabinet just right of the window: its top (2.20) beside the window's head (2.10).
    const cab = piece('it_u', 'built-in-kitchen-wall', 3.2, 0.225);
    cab.scale = { x: 0.5, y: 1, z: 1 };
    const c = elev(withItems(s1, cab), 'C');
    const shown = (px: number) => elevationLabels(c, px).heights.flat().filter(Boolean).length;
    const all = c.heights.flatMap((h) => h.marks).length;
    expect(shown(600)).toBe(all);
    expect(shown(15)).toBeLessThan(all);
  });

  it('a name mid-sentence', () => {
    expect(midSentence('Built-in wardrobe')).toBe('built-in wardrobe');
    expect(midSentence('TV console')).toBe('TV console');
  });
});

describe('the furnished sample', () => {
  const sample = () => freeze(structuredClone(furnishedSample()), true) as Level;

  it('AC17: every face, the same twice and in order; every chain adds up', () => {
    const run = (l: Level) =>
      Object.keys(l.rooms)
        .sort()
        .flatMap((id) => roomFaces(l, id).map((f) => wallElevation(l, f)));
    const a = run(sample());
    const b = run(sample());
    expect(a.length).toBeGreaterThan(20);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (const e of a) {
      const overall = chainFigures(e.chains.find((c) => c.tier === 2)?.stops ?? [])[0] ?? 0;
      expect(Math.abs(overall - Math.round(e.width * 100) * 10)).toBeLessThanOrEqual(0);
      for (const c of e.chains) {
        expect(chainFigures(c.stops).reduce((x, y) => x + y, 0)).toBe(overall);
      }
    }
  });

  it('faceRef finds the same face again, and resolves in a copy of the level', () => {
    const l = sample();
    const copy = sample();
    for (const id of Object.keys(l.rooms)) {
      for (const f of roomFaces(l, id)) {
        if (f.kind === 'return') continue;
        const again = resolveFace(copy, faceRef(f));
        expect([again?.roomId, again?.index]).toEqual([f.roomId, f.index]);
      }
    }
  });
});
