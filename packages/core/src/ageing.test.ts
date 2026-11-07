import { describe, expect, it } from 'vitest';
import {
  type AgeingChoice,
  type AgeingIssue,
  type AgeingReport,
  ageingReport,
  ageingSupersedes,
  parseAgeingSetting,
  pinchKey,
  table7,
} from './ageing';
import { addOpening, drawWall, updateRoom } from './commands';
import { accessClearWidth } from './delivery';
import { addPoint } from './electrical';
import { blankProject } from './factory';
import { furnishedSample } from './fixtures/furnishedSample';
import { sampleFlatProject } from './fixtures/sampleFlat';
import { furnitureKind, newItem } from './furniture';
import { type EditorDoc, dispatch, emptyHistory } from './history';
import { variantLevels } from './levels';
import { startRenovation } from './renovation';
import type { Level, Opening, Vec2 } from './schema';
import { furnishedPass, walkwayReport } from './walkway';

/**
 * Two 4 m rooms over a corridor `clear` wide (walls 100 mm on centre lines), a door from the
 * corridor into each, and the main door in the corridor's long outside wall at `mainX`.
 *
 *   (0,0) ---------- (4,0) ---------- (8,0)
 *     |   Room A       |    Room B       |
 *   (0,4) ---[dA]--- (4,4) ---[dB]--- (8,4)
 *     |           corridor               |
 *   (0,Y) ------------[main]------------ (8,Y)
 */
interface Home {
  s: EditorDoc;
  y: number;
  lvl: () => Level;
  wall: (a: Vec2, b: Vec2) => string;
  room: (x: number, y: number) => string;
  door: (wallId: string, width: number, extra?: Partial<Opening>) => string;
}

function build(
  outline: [number, number][][],
  names: [string, Vec2][],
): Omit<Home, 'y'> & { s: EditorDoc } {
  const h = {
    s: { doc: blankProject('t', 'prj_t'), history: emptyHistory() } as EditorDoc,
  };
  const lvl = () => h.s.doc.levels[0] as Level;
  for (const pts of outline) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i] as [number, number];
      const [bx, by] = pts[i + 1] as [number, number];
      h.s = dispatch(
        h.s,
        drawWall(
          lvl(),
          { point: { x: ax, y: ay } },
          { point: { x: bx, y: by } },
          { thickness: 0.1 },
        ).command,
      );
    }
  }
  const room = (x: number, y: number) => {
    const l = lvl();
    const r = Object.values(l.rooms).find((r) => {
      const pts = r.loop.map((v) => l.vertices[v] as Vec2);
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      return (
        x > Math.min(...xs) && x < Math.max(...xs) && y > Math.min(...ys) && y < Math.max(...ys)
      );
    });
    if (!r) throw new Error(`no room at ${x},${y}`);
    return r.id;
  };
  for (const [name, at] of names) {
    h.s = dispatch(h.s, updateRoom(lvl().id, room(at.x, at.y), { name }));
  }
  const wall = (a: Vec2, b: Vec2) => {
    const l = lvl();
    const w = Object.values(l.walls).find((w) => {
      const p = l.vertices[w.a];
      const q = l.vertices[w.b];
      if (!p || !q) return false;
      const is = (u: Vec2, v: Vec2) => Math.hypot(u.x - v.x, u.y - v.y) < 1e-6;
      return (is(p, a) && is(q, b)) || (is(p, b) && is(q, a));
    });
    if (!w) throw new Error(`no wall ${a.x},${a.y} ${b.x},${b.y}`);
    return w.id;
  };
  const door = (wallId: string, width: number, extra: Partial<Opening> = {}) => {
    const r = addOpening(lvl().id, {
      wallId,
      kind: 'door',
      t: 0.5,
      width,
      height: 2.1,
      sill: 0,
      swing: 'leftIn',
      ...extra,
    });
    h.s = dispatch(h.s, r.command);
    return r.openingId;
  };
  return {
    get s() {
      return h.s;
    },
    set s(v) {
      h.s = v;
    },
    lvl,
    wall,
    room,
    door,
  };
}

function home(
  opts: {
    clear?: number;
    a?: string;
    b?: string;
    corridor?: string;
    main?: Partial<Opening> & { width?: number };
    noMain?: boolean;
    dA?: Partial<Opening> & { width?: number };
    dB?: Partial<Opening> & { width?: number };
  } = {},
): Home & { dA: string; dB: string; main: string | null } {
  const clear = opts.clear ?? 1.2;
  const y = 4 + clear + 0.1;
  const h = build(
    [
      [
        [0, 0],
        [8, 0],
        [8, y],
        [0, y],
        [0, 0],
      ],
      [
        [0, 4],
        [8, 4],
      ],
      [
        [4, 0],
        [4, 4],
      ],
    ],
    [
      [opts.a ?? 'Bath/WC', { x: 2, y: 2 }],
      [opts.b ?? 'Bedroom', { x: 6, y: 2 }],
      [opts.corridor ?? 'Living', { x: 2, y: 4 + clear / 2 }],
    ],
  );
  const { width: wa = 0.9, ...ea } = opts.dA ?? {};
  const { width: wb = 0.9, ...eb } = opts.dB ?? {};
  // Out of each room: +n of a wall drawn left to right is down (y grows down), the corridor.
  const dA = h.door(h.wall({ x: 0, y: 4 }, { x: 4, y: 4 }), wa, { swing: 'leftIn', ...ea });
  const dB = h.door(h.wall({ x: 4, y: 4 }, { x: 8, y: 4 }), wb, { swing: 'leftIn', ...eb });
  let main: string | null = null;
  if (!opts.noMain) {
    const { width: wm = 1.0, ...em } = opts.main ?? {};
    // The bottom wall runs from (8, Y) to (0, Y): +n is up, into the corridor.
    main = h.door(h.wall({ x: 8, y }, { x: 0, y }), wm, { swing: 'leftIn', ...em });
  }
  return Object.assign(h, { y, dA, dB, main });
}

let n = 0;
/** The level with pieces added: [kind id, centre, rotation, scale x, scale z]. */
function withItems(lvl: Level, pieces: [string, Vec2, number?, number?, number?][]): Level {
  const items = { ...lvl.items };
  for (const [kindId, at, rot, sx, sz] of pieces) {
    const kind = furnitureKind(kindId);
    if (!kind) throw new Error(`no ${kindId}`);
    const it = newItem(`it_${++n}`, kind, at, rot ?? 0);
    it.scale = { ...it.scale, x: sx ?? 1, z: sz ?? 1 };
    items[it.id] = it;
  }
  return Object.freeze({ ...lvl, items });
}
const lastId = () => `it_${n}`;
const frozen = (l: Level) => Object.freeze({ ...l });

const wheel = (extra: Partial<AgeingChoice> = {}): AgeingChoice => ({
  profile: 'wheelchair',
  ...extra,
});
const walking = (extra: Partial<AgeingChoice> = {}): AgeingChoice => ({
  profile: 'walking',
  ...extra,
});
const kinds = (r: AgeingReport, kind: AgeingIssue['kind']) =>
  r.issues.filter((i) => i.kind === kind);

describe('doors and their squares (A)', () => {
  it('1. a 0.90 swing door off a 1.20 corridor is fine; off 1.05 it needs 1.10; a pocket door 1.00', () => {
    const ok = home({ clear: 1.2 });
    expect(
      ageingReport(frozen(ok.lvl()), wheel()).issues.filter((i) => i.openingId === ok.dA),
    ).toEqual([]);
    const tight = home({ clear: 1.05 });
    const r = ageingReport(frozen(tight.lvl()), wheel());
    const ds = kinds(r, 'door-space').filter((i) => i.openingId === tight.dA);
    expect(ds).toHaveLength(1);
    expect(ds[0]?.need).toBeCloseTo(1.1, 5);
    expect(Math.abs((ds[0]?.have ?? 0) - 1.05)).toBeLessThanOrEqual(0.01);
    expect(ds[0]?.clear).toBeCloseTo(0.86, 5);
    expect(ds[0]?.alt).toEqual({ clear: 0.9, need: 1.0 });
    expect(ds[0]?.group).toBe('bathroom');
    const pocket = home({ clear: 1.05, dA: { style: 'pocket' } });
    const rp = ageingReport(frozen(pocket.lvl()), wheel());
    expect(rp.issues.filter((i) => i.openingId === pocket.dA && i.kind.startsWith('door'))).toEqual(
      [],
    );
  });

  it('2. a 0.80 swing door: 0.76 clear, short for a wheelchair, fine with a walking aid', () => {
    const h = home({ dA: { width: 0.8 } });
    const r = ageingReport(frozen(h.lvl()), wheel());
    const w = kinds(r, 'door-width').filter((i) => i.openingId === h.dA);
    expect(w).toHaveLength(1);
    expect(w[0]?.need).toBeCloseTo(0.8, 5);
    expect(w[0]?.have).toBeCloseTo(0.76, 5);
    expect(w[0]?.level).toBe('needed');
    expect(kinds(ageingReport(frozen(h.lvl()), walking()), 'door-width')).toEqual([]);
    const narrow = home({ dA: { width: 0.75 } });
    const wa = kinds(ageingReport(frozen(narrow.lvl()), walking()), 'door-width');
    expect(wa).toHaveLength(1);
    expect(wa[0]?.need).toBeCloseTo(0.75, 5);
    expect(wa[0]?.have).toBeCloseTo(0.71, 5);
  });

  it('3. the main door: 1.0 fine; 0.85 is 0.81 clear; a 1.60 double door is 0.76 a leaf', () => {
    const big = { clear: 2.0 };
    expect(kinds(ageingReport(frozen(home(big).lvl()), wheel()), 'door-width')).toEqual([]);
    const h = home({ ...big, main: { width: 0.85 } });
    const w = kinds(ageingReport(frozen(h.lvl()), wheel()), 'door-width');
    expect(w.map((i) => i.openingId)).toEqual([h.main]);
    expect(w[0]?.need).toBeCloseTo(0.85, 5);
    expect(w[0]?.have).toBeCloseTo(0.81, 5);
    expect(w[0]?.group).toBe('in');
    const d = home({ ...big, main: { width: 1.6, style: 'double' } });
    const dw = kinds(ageingReport(frozen(d.lvl()), wheel()), 'door-width');
    expect(dw[0]?.have).toBeCloseTo(0.76, 5);
  });

  it('table 7 steps by the millimetre; a 0.94 swing door is 0.90 clear, not 0.8999', () => {
    expect(table7(0.9)).toBe(1.0);
    expect(table7(0.899)).toBe(1.1);
    expect(table7(0.85)).toBe(1.1);
    expect(table7(0.849)).toBe(1.2);
    expect(table7(0.8)).toBe(1.2);
    expect(table7(0.799)).toBeNull();
    const o = (extra: Partial<Opening>): Opening => ({
      id: 'o',
      wallId: 'w',
      kind: 'door',
      t: 0.5,
      width: 0.94,
      height: 2.1,
      sill: 0,
      ...extra,
    });
    expect(accessClearWidth(o({}))).toBe(0.9);
    expect(table7(accessClearWidth(o({})))).toBe(1.0);
    // Per leaf for a double door; a bi-fold as drawn (2 panels up to 1.2 m); a barn door clear.
    expect(accessClearWidth(o({ width: 1.6, style: 'double' }))).toBe(0.76);
    expect(accessClearWidth(o({ width: 0.8, style: 'bifold' }))).toBe(0.72);
    expect(accessClearWidth(o({ width: 0.9, style: 'sliding' }))).toBe(0.9);
    expect(accessClearWidth(o({ width: 1.6, style: 'sliding' }))).toBe(0.8);
    expect(accessClearWidth(o({ width: 0.9, kind: 'passage' }))).toBe(0.9);
  });

  it('a door short of its square suggests the smallest wider door that would do', () => {
    // A 0.84 door (0.80 clear) needs 1.20; a 1.15 corridor would do for a 0.85 clear door.
    const h = home({ clear: 1.15, dA: { width: 0.84 } });
    const ds = kinds(ageingReport(frozen(h.lvl()), wheel()), 'door-space').find(
      (i) => i.openingId === h.dA,
    );
    expect(ds?.need).toBeCloseTo(1.2, 5);
    expect(ds?.alt).toEqual({ clear: 0.85, need: 1.1 });
  });

  it('the setting: one unreadable field drops only itself', () => {
    expect(parseAgeingSetting(JSON.stringify({ profile: 'wheelchair', bedroomId: 7 }))).toEqual({
      profile: 'wheelchair',
    });
    expect(
      parseAgeingSetting(JSON.stringify({ profile: 'walking', flatType: '9', extra: true })),
    ).toEqual({ profile: 'walking' });
    expect(parseAgeingSetting('nonsense')).toEqual({ profile: 'off' });
  });

  it('a 0.94 door off a 1.05 corridor needs only 1.00 (the 0.90 row)', () => {
    const h = home({ clear: 1.05, dA: { width: 0.94 } });
    const r = ageingReport(frozen(h.lvl()), wheel());
    expect(r.issues.filter((i) => i.openingId === h.dA)).toEqual([]);
  });
});

describe('inside the main door (A)', () => {
  // A 0.90 door at x 4 swinging in, hinged at x 4.45, its handle at x 3.55.
  const big = (): ReturnType<typeof home> => home({ clear: 2.0, main: { width: 0.9 } });

  it('4. a shoe cabinet 0.30 from the handle: latch-side on it; on the hinge side: none', () => {
    const h = big();
    const face = h.y - 0.05;
    const lvl = withItems(h.lvl(), [
      ['shoe-cabinet', { x: 3.55 - 0.3 - 0.4, y: face - 0.175 }, Math.PI],
    ]);
    const r = ageingReport(lvl, wheel());
    const l = kinds(r, 'latch-side');
    expect(l).toHaveLength(1);
    expect(l[0]?.need).toBeCloseTo(0.45, 5);
    expect(Math.abs((l[0]?.have ?? 0) - 0.3)).toBeLessThanOrEqual(0.01);
    expect(l[0]?.itemIds).toEqual([lastId()]);
    expect(l[0]?.group).toBe('in');
    // Walking aid: the same strip.
    expect(kinds(ageingReport(lvl, walking()), 'latch-side')).toHaveLength(1);
    const hinge = withItems(h.lvl(), [
      ['shoe-cabinet', { x: 4.45 + 1.0 + 0.4, y: face - 0.175 }, Math.PI],
    ]);
    expect(kinds(ageingReport(hinge, wheel()), 'latch-side')).toEqual([]);
  });

  it('4. a box filling the space inside the door: entrance-space, with its depth', () => {
    const h = big();
    const face = h.y - 0.05;
    const lvl = withItems(h.lvl(), [['dining-4', { x: 4, y: face - 0.6 - 0.4 }]]);
    const e = kinds(ageingReport(lvl, wheel()), 'entrance-space');
    expect(e).toHaveLength(1);
    expect(e[0]?.need).toBeCloseTo(1.5, 5);
    expect(e[0]?.have).toBeGreaterThan(0.5);
    expect(e[0]?.have).toBeLessThan(0.7);
    expect(e[0]?.itemIds).toEqual([lastId()]);
    // The bare 2.0 m corridor has the room.
    expect(kinds(ageingReport(frozen(h.lvl()), wheel()), 'entrance-space')).toEqual([]);
  });

  it('an out-swinging main door has no latch strip (its pull side is the corridor outside)', () => {
    const h = home({ clear: 2.0, main: { width: 0.9, swing: 'leftOut' } });
    const face = h.y - 0.05;
    const lvl = withItems(h.lvl(), [
      ['shoe-cabinet', { x: 3.55 - 0.3 - 0.4, y: face - 0.175 }, Math.PI],
    ]);
    expect(kinds(ageingReport(lvl, wheel()), 'latch-side')).toEqual([]);
  });
});

describe('routes (A)', () => {
  it('5. a bare 0.95 corridor to the bathroom: one flat route issue; walkways see none', () => {
    const h = home({ clear: 0.95, main: { width: 0.9 } });
    const lvl = frozen(h.lvl());
    const r = ageingReport(lvl, wheel());
    const routes = kinds(r, 'route');
    expect(routes).toHaveLength(1);
    expect(routes[0]?.flat).toBe(true);
    expect(routes[0]?.need).toBeCloseTo(1.0, 5);
    expect(Math.abs((routes[0]?.have ?? 0) - 0.95)).toBeLessThanOrEqual(0.02);
    expect(routes[0]?.itemIds).toEqual([]);
    expect(routes[0]?.to).toEqual([h.room(2, 2)]);
    expect(routes[0]?.group).toBe('bathroom');
    // The bathroom door's own square is a separate issue.
    expect(kinds(r, 'door-space').some((i) => i.openingId === h.dA)).toBe(true);
    expect(walkwayReport(lvl).issues).toEqual([]);
    // The same corridor to a bedroom: 0.90 is enough.
    const b = home({ clear: 0.95, a: 'Bedroom 2', b: 'Study', main: { width: 0.9 } });
    expect(kinds(ageingReport(frozen(b.lvl()), wheel()), 'route')).toEqual([]);
  });

  it('6. a cabinet narrowing the way to the bathroom to 0.92: route on it, 1.00; none walking', () => {
    const h = home({ clear: 1.2, main: { width: 0.9 } });
    const face = h.y - 0.05;
    // Between the main door (x 4) and the bathroom door (x 2): 0.28 deep.
    const lvl = withItems(h.lvl(), [
      ['shoe-cabinet', { x: 3.0, y: face - 0.14 }, Math.PI, 1, 0.28 / 0.35],
    ]);
    const r = ageingReport(lvl, wheel());
    const routes = kinds(r, 'route');
    expect(routes).toHaveLength(1);
    expect(routes[0]?.itemIds).toEqual([lastId()]);
    expect(routes[0]?.need).toBeCloseTo(1.0, 5);
    expect(Math.abs((routes[0]?.have ?? 0) - 0.92)).toBeLessThanOrEqual(0.02);
    expect(routes[0]?.flat).toBeUndefined();
    expect(kinds(ageingReport(lvl, walking()), 'route')).toEqual([]);
  });

  it('a piece on a 0.90 route to the living room is the walkways’ line, not repeated', () => {
    const h = home({ clear: 1.2, a: 'Store', b: 'Living', corridor: 'Hall', main: { width: 0.9 } });
    const face = h.y - 0.05;
    const lvl = withItems(h.lvl(), [['shoe-cabinet', { x: 5.0, y: face - 0.175 }, Math.PI]]);
    expect(kinds(ageingReport(lvl, wheel()), 'route')).toEqual([]);
    expect(walkwayReport(lvl).issues.length).toBeGreaterThan(0);
  });

  it('the stricter 1.00 way to the bathroom: the ageing bar replaces the walkway bar', () => {
    const h = home({ clear: 1.2, main: { width: 0.9 } });
    const face = h.y - 0.05;
    // Between the main door and the bathroom door: 0.85 left, short of both 0.90 and 1.00.
    const lvl = withItems(h.lvl(), [['shoe-cabinet', { x: 3.0, y: face - 0.175 }, Math.PI]]);
    const age = ageingReport(lvl, wheel());
    const walk = walkwayReport(lvl);
    expect(kinds(age, 'route')[0]?.need).toBeCloseTo(1.0, 5);
    const toBath = walk.issues.filter((w) => w.to.some((t) => t.roomId === h.room(2, 2)));
    expect(toBath.length).toBeGreaterThan(0);
    const hide = ageingSupersedes(walk, age);
    for (const w of toBath) expect(hide.has(`${w.itemId}|${pinchKey(w.pinch)}`)).toBe(true);
  });
});

/** One room `w` × `d` inside (walls 0.1 on centre lines), named, with no doors. */
function box(w: number, d: number, name: string) {
  const W = w + 0.1;
  const D = d + 0.1;
  const h = build(
    [
      [
        [0, 0],
        [W, 0],
        [W, D],
        [0, D],
        [0, 0],
      ],
    ],
    [[name, { x: W / 2, y: D / 2 }]],
  );
  return h;
}

describe('room to turn (B)', () => {
  it('7. a 3.0 × 2.0 room: room to turn; a 2.0 bed against a wall leaves 1.17; one wall to wall 1.00', () => {
    const h = box(3.0, 2.0, 'Bedroom');
    const id = h.room(1, 1);
    const empty = ageingReport(frozen(h.lvl()), wheel({ bedroomId: id }));
    expect(kinds(empty, 'turn')).toEqual([]);
    expect(empty.turns[0]?.have ?? 0).toBeGreaterThanOrEqual(1.5);
    // A 1.0 m wide bed, 2.0 long, along the long (top) wall from the left wall.
    const bed = withItems(h.lvl(), [
      ['bed-single', { x: 0.05 + 1.0, y: 0.05 + 0.5 }, Math.PI / 2, 1 / 0.92],
    ]);
    // Turned a quarter, a bed's length runs along x and its width along y.
    const t = kinds(ageingReport(bed, wheel({ bedroomId: id })), 'turn');
    expect(t).toHaveLength(1);
    expect(Math.abs((t[0]?.have ?? 0) - 1.17)).toBeLessThanOrEqual(0.01);
    expect(t[0]?.itemIds).toEqual([lastId()]);
    expect(t[0]?.level).toBe('recommended');
    expect(t[0]?.group).toBe('bedroom');
    const long = withItems(h.lvl(), [
      ['bed-single', { x: 0.05 + 1.5, y: 0.05 + 0.5 }, Math.PI / 2, 1 / 0.92, 3.0 / 2.0],
    ]);
    const tl = kinds(ageingReport(long, wheel({ bedroomId: id })), 'turn');
    expect(Math.abs((tl[0]?.have ?? 0) - 1.0)).toBeLessThanOrEqual(0.01);
    // Walking aid: no turning at all.
    expect(kinds(ageingReport(bed, walking({ bedroomId: id })), 'turn')).toEqual([]);
  });

  it('7. a 2.0 × 1.42 bathroom: 1.42 across, nothing to blame', () => {
    const h = box(2.0, 1.42, 'Bath/WC 2');
    const t = kinds(ageingReport(frozen(h.lvl()), wheel()), 'turn');
    expect(t).toHaveLength(1);
    expect(Math.abs((t[0]?.have ?? 0) - 1.42)).toBeLessThanOrEqual(0.01);
    expect(t[0]?.itemIds).toEqual([]);
    expect(t[0]?.flat).toBe(true);
    expect(t[0]?.group).toBe('bathroom');
    // With a basin blamed, the line still knows the room itself is too small empty.
    const withBasin = withItems(h.lvl(), [['vanity', { x: 0.05 + 0.3, y: 0.05 + 0.225 }]]);
    const tb = kinds(ageingReport(withBasin, wheel()), 'turn');
    expect(tb[0]?.itemIds.length).toBeGreaterThan(0);
    expect(Math.abs((tb[0]?.empty ?? 0) - 1.42)).toBeLessThanOrEqual(0.01);
  });

  it('a 1.42 bathroom with its door on the long wall: the circle stays inside (no false pass)', () => {
    // Bathroom 2.0 × 1.42 above a 2 m hall, the door in the wall between them.
    const h = build(
      [
        [
          [0, 0],
          [2.1, 0],
          [2.1, 3.62],
          [0, 3.62],
          [0, 0],
        ],
        [
          [0, 1.52],
          [2.1, 1.52],
        ],
      ],
      [
        ['Bath/WC', { x: 1, y: 0.7 }],
        ['Living', { x: 1, y: 2.5 }],
      ],
    );
    h.door(h.wall({ x: 0, y: 1.52 }, { x: 2.1, y: 1.52 }), 0.9, { swing: 'leftOut' });
    const r = ageingReport(frozen(h.lvl()), wheel());
    const t = r.turns.find((x) => x.roomIds.includes(h.room(1, 0.7)));
    expect(Math.abs((t?.have ?? 0) - 1.42)).toBeLessThanOrEqual(0.01);
    expect(t?.ok).toBe(false);
  });

  it('8. a living room and dry kitchen joined by a boundary: one turning space', () => {
    const lvl = sampleFlatProject('prj_t').levels[0] as Level;
    const r = ageingReport(lvl, wheel());
    const living = Object.values(lvl.rooms).find((x) => x.name === 'Living and dining')?.id;
    const dry = Object.values(lvl.rooms).find((x) => x.name === 'Dry kitchen')?.id;
    const t = r.turns.filter(
      (x) => x.roomIds.includes(living ?? '') || x.roomIds.includes(dry ?? ''),
    );
    expect(t).toHaveLength(1);
    expect(t[0]?.roomIds).toContain(living);
    expect(t[0]?.roomIds).toContain(dry);
  });
});

describe('their bedroom: the bed', () => {
  /** A 4 × 4 bedroom with a queen bed against the top wall, `left` and `right` m beside it. */
  function bedroom(left: number, right: number) {
    const h = box(4.0, 4.0, 'Bedroom');
    // Queen: 1.52 wide. Its left (seen from the foot) is +x when it faces +y? Place by sides.
    const x0 = 0.05 + left;
    const lvl = withItems(h.lvl(), [['bed-queen', { x: x0 + 0.76, y: 0.05 + 1.0 }]]);
    // Walls beside the bed: boxes standing at the given distances.
    const bedId = lastId();
    const right0 = x0 + 1.52 + right;
    const out = withItems(lvl, [['wardrobe', { x: right0 + 0.3, y: 1.0 }, Math.PI / 2]]);
    return { h, lvl: out, bedId, id: h.room(1, 1) };
  }

  it('9. a queen bed with 0.80 and 0.70 beside it: bed, 1.00 needed, 0.80 the better side', () => {
    const b = bedroom(0.8, 0.7);
    const bed = kinds(ageingReport(b.lvl, wheel({ bedroomId: b.id })), 'bed');
    expect(bed).toHaveLength(1);
    expect(bed[0]?.need).toBeCloseTo(1.0, 5);
    expect(Math.abs((bed[0]?.have ?? 0) - 0.8)).toBeLessThanOrEqual(0.01);
    expect(bed[0]?.itemIds[0]).toBe(b.bedId);
    const roomy = bedroom(1.05, 0.7);
    expect(kinds(ageingReport(roomy.lvl, wheel({ bedroomId: roomy.id })), 'bed')).toEqual([]);
    const tight = bedroom(0.7, 0.7);
    const wa = kinds(ageingReport(tight.lvl, walking({ bedroomId: tight.id })), 'bed');
    expect(wa).toHaveLength(1);
    expect(wa[0]?.need).toBeCloseTo(0.75, 5);
  });

  it('a bedside table at the head end doesn’t count against the bed side', () => {
    const b = bedroom(1.2, 1.2);
    // A bedside table in the left side's head end.
    const lvl = withItems(b.lvl, [['bedside', { x: 0.05 + 1.2 - 0.25, y: 0.05 + 0.2 }]]);
    expect(kinds(ageingReport(lvl, wheel({ bedroomId: b.id })), 'bed')).toEqual([]);
  });
});

/** A 2.4 × 2.0 bathroom over a 2 m hall, the door in the wall between at x 1.2, and a toilet. */
function bath(
  opts: { door?: Partial<Opening> & { width?: number }; hall?: number; depth?: number } = {},
) {
  const hall = opts.hall ?? 2.0;
  const D = (opts.depth ?? 2.0) + 0.1;
  const Y = D + hall + 0.1;
  const h = build(
    [
      [
        [0, 0],
        [2.5, 0],
        [2.5, Y],
        [0, Y],
        [0, 0],
      ],
      [
        [0, D],
        [2.5, D],
      ],
    ],
    [
      ['Bath/WC', { x: 1.2, y: 1 }],
      ['Living', { x: 1.2, y: D + hall / 2 }],
    ],
  );
  const { width = 0.9, ...extra } = opts.door ?? {};
  // Swinging out, into the hall (+n of the wall, drawn left to right, is down).
  const doorId = h.door(h.wall({ x: 0, y: D }, { x: 2.5, y: D }), width, {
    swing: 'leftIn',
    ...extra,
  });
  return { h, doorId, id: h.room(1.2, 1) };
}

describe('their bathroom (C)', () => {
  it('10. the toilet facing a wall 0.90 from its front: wc-front 0.90; 1.05: none', () => {
    // The toilet's back on the left wall (x 0.05), facing +x: rotation -π/2 turns front to +x.
    const { h, id } = bath();
    // Turned a quarter, it faces -x: its front `gap` from the left wall's face (x 0.05).
    const far = (gap: number) =>
      withItems(h.lvl(), [['toilet', { x: 0.05 + gap + 0.35, y: 1.0 }, Math.PI / 2]]);
    const r = ageingReport(far(0.9), wheel({ bathroomId: id }));
    const f = kinds(r, 'wc-front');
    expect(f).toHaveLength(1);
    expect(Math.abs((f[0]?.have ?? 0) - 0.9)).toBeLessThanOrEqual(0.01);
    expect(f[0]?.need).toBeCloseTo(1.0, 5);
    expect(kinds(ageingReport(far(1.05), wheel({ bathroomId: id })), 'wc-front')).toEqual([]);
  });

  it('10. a vanity 0.38 from the toilet’s centre and a wall 0.40 the other side: wc-side 0.40', () => {
    const { h, id } = bath();
    // Toilet against the top wall (y 0.05) facing +y, centre x c; the left wall at 0.05.
    const c = 0.05 + 0.4;
    const lvl = withItems(h.lvl(), [
      ['toilet', { x: c, y: 0.05 + 0.35 }],
      ['vanity', { x: c + 0.38 + 0.3, y: 0.05 + 0.225 }],
    ]);
    const s = kinds(ageingReport(lvl, wheel({ bathroomId: id })), 'wc-side');
    expect(s).toHaveLength(1);
    expect(Math.abs((s[0]?.have ?? 0) - 0.4)).toBeLessThanOrEqual(0.005);
    expect(s[0]?.need).toBeCloseTo(0.45, 5);
    const ok = withItems(h.lvl(), [
      ['toilet', { x: 0.05 + 0.47, y: 0.05 + 0.35 }],
      ['vanity', { x: 0.05 + 0.47 + 0.38 + 0.3, y: 0.05 + 0.225 }],
    ]);
    expect(kinds(ageingReport(ok, wheel({ bathroomId: id })), 'wc-side')).toEqual([]);
  });

  it('11. a door swinging into the bathroom: door-in; out, folding, sliding, pocket: none', () => {
    const into = bath({ door: { swing: 'leftOut' } });
    const di = kinds(ageingReport(frozen(into.h.lvl()), wheel()), 'door-in');
    expect(di).toHaveLength(1);
    expect(di[0]?.level).toBe('recommended');
    expect(di[0]?.openingId).toBe(into.doorId);
    for (const door of [
      { swing: 'leftIn' as const },
      { style: 'folding' as const, swing: 'leftOut' as const },
      { style: 'bifold' as const, swing: 'leftOut' as const },
      { style: 'sliding' as const },
      { style: 'pocket' as const },
    ]) {
      const b = bath({ door });
      expect(kinds(ageingReport(frozen(b.h.lvl()), wheel()), 'door-in')).toEqual([]);
    }
    // A passage has no door to swing.
    const p = bath({ door: { kind: 'passage' } });
    expect(kinds(ageingReport(frozen(p.h.lvl()), wheel()), 'door-in')).toEqual([]);
  });

  it('12. a 0.85 gap between the vanity and a wall on the way to the toilet: wc-way 0.85', () => {
    const { h, id } = bath({ depth: 3.0 });
    // A 3 m deep bathroom, its door at x 0.8..1.7 in the bottom wall. The toilet in the top
    // left corner facing down; a counter from the right wall stops 0.85 short of the left
    // one, so the way from the door to the toilet passes between them.
    const lvl = withItems(h.lvl(), [
      ['toilet', { x: 0.05 + 0.5, y: 0.05 + 0.35 }],
      // A long counter from the right wall towards the left, 0.85 short of it, mid-room.
      ['vanity', { x: 0.05 + 0.85 + 0.775, y: 1.2 }, 0, 1.55 / 0.6],
    ]);
    const w = kinds(ageingReport(lvl, wheel({ bathroomId: id })), 'wc-way');
    expect(w).toHaveLength(1);
    expect(w[0]?.need).toBeCloseTo(1.0, 5);
    expect(Math.abs((w[0]?.have ?? 0) - 0.85)).toBeLessThanOrEqual(0.02);
    expect(kinds(ageingReport(lvl, walking({ bathroomId: id })), 'wc-way')).toEqual([]);
  });

  it('17. no toilet piece in their bathroom: no wc lines and the note', () => {
    const { h, id } = bath();
    const r = ageingReport(frozen(h.lvl()), wheel({ bathroomId: id }));
    expect(r.issues.filter((i) => i.kind.startsWith('wc-'))).toEqual([]);
    expect(r.notes).toContain('add-toilet');
  });

  it('no room named as a bathroom: the note to name one', () => {
    const h = box(3, 3, 'Bedroom');
    expect(ageingReport(frozen(h.lvl()), wheel()).notes).toContain('name-bathroom');
  });
});

describe('switches and sockets (D)', () => {
  /** A bedroom (or kitchen) 4 × 4 with points on its top wall's inside face. */
  function room(name: string) {
    const h = box(4, 4, name);
    const l = h.lvl();
    const wallId = h.wall({ x: 0, y: 0 }, { x: 4.1, y: 0 });
    const w = l.walls[wallId];
    // The inside face: the wall runs left to right along y 0, so +n (left) is down, inside.
    const side = w && l.vertices[w.a]?.x === 0 ? 'left' : 'right';
    return { h, wallId, side: side as 'left' | 'right' };
  }
  const withPoint = (
    r: ReturnType<typeof room>,
    kind: 'socket-double' | 'switch',
    height: number,
  ) => {
    const c = addPoint(r.h.lvl().id, {
      kind,
      wall: { wallId: r.wallId, t: 0.5, side: r.side, height },
    });
    r.h.s = dispatch(r.h.s, c.command);
    return c.pointId;
  };

  it('13. heights: 0.30 socket in a bedroom; behind a TV console; in a kitchen; switches', () => {
    const a = room('Bedroom');
    const low = withPoint(a, 'socket-double', 0.3);
    const r = ageingReport(frozen(a.h.lvl()), walking());
    const reach = kinds(r, 'reach');
    expect(reach).toHaveLength(1);
    expect(reach[0]?.pointIds).toEqual([low]);
    expect(reach[0]?.group).toBe('points');
    // Behind a TV console standing against that wall: not checked.
    const tv = withItems(a.h.lvl(), [['tv-console', { x: 2.05, y: 0.05 + 0.2 }]]);
    expect(kinds(ageingReport(tv, walking()), 'reach')).toEqual([]);
    const k = room('Kitchen');
    withPoint(k, 'socket-double', 0.3);
    expect(kinds(ageingReport(frozen(k.h.lvl()), walking()), 'reach')).toEqual([]);
    const s = room('Bedroom');
    const hi = withPoint(s, 'switch', 1.35);
    expect(kinds(ageingReport(frozen(s.h.lvl()), wheel()), 'reach')[0]?.pointIds).toEqual([hi]);
    const fine = room('Bedroom');
    withPoint(fine, 'switch', 1.05);
    expect(kinds(ageingReport(frozen(fine.h.lvl()), wheel()), 'reach')).toEqual([]);
  });
});

describe('the choice', () => {
  it('14. no bedroom chosen: no bed or bedroom turn lines; counts per bedroom; chosen: its checks', () => {
    const lvl = furnishedSample();
    const f = Object.freeze({ ...lvl });
    const r = ageingReport(f, wheel());
    expect(r.bedroom).toBeUndefined();
    expect(r.issues.some((i) => i.kind === 'bed')).toBe(false);
    expect(r.issues.some((i) => i.group === 'bedroom')).toBe(false);
    const names = r.bedrooms.map((b) => f.rooms[b.roomId]?.name).sort();
    expect(names).toEqual(['Bedroom', 'Main bedroom']);
    const main = r.bedrooms.find((b) => f.rooms[b.roomId]?.name === 'Main bedroom');
    const chosen = ageingReport(f, wheel({ bedroomId: main?.roomId }));
    expect(chosen.bedroom).toBe(main?.roomId);
    expect(chosen.issues.filter((i) => i.group === 'bedroom')).toHaveLength(main?.count ?? -1);
    expect(chosen.passed.some((p) => p.group === 'bedroom') || (main?.count ?? 0) > 0).toBe(true);
  });

  it('a bedroom named for the person, or a study, can be theirs and stays chosen', () => {
    const base = Object.freeze({ ...furnishedSample() });
    const main = Object.values(base.rooms).find((r) => r.name === 'Main bedroom')?.id ?? '';
    const study = Object.values(base.rooms).find((r) => r.name === 'Bedroom')?.id ?? '';
    for (const name of ['Ah Ma’s room', 'Mum’s room', 'Parents room', 'Study']) {
      const lvl = Object.freeze({
        ...base,
        rooms: {
          ...base.rooms,
          [main]: { ...(base.rooms[main] as Level['rooms'][string]), name },
          [study]: { ...(base.rooms[study] as Level['rooms'][string]), name: 'Study' },
        },
      });
      const r = ageingReport(lvl, wheel({ bedroomId: main }));
      // Still chosen through the rename, still checked (its bed is in it).
      expect(r.bedroom).toBe(main);
      expect(r.bedroomIds).toContain(main);
      expect(r.issues.some((i) => i.kind === 'bed')).toBe(true);
      // A study with no bed can be chosen too, and is offered.
      expect(r.bedroomIds).toContain(study);
      expect(ageingReport(lvl, wheel({ bedroomId: study })).bedroom).toBe(study);
      // Neither bathroom nor kitchen is offered.
      for (const id of r.bedroomIds) expect(lvl.rooms[id]?.name).not.toMatch(/bath|kitchen/i);
    }
  });

  it('15. their bathroom: an en-suite when chosen, else the nearest; a chosen one wins', () => {
    // Bedroom (A) with a bathroom off it (C), and a common bathroom (B) off the corridor.
    const y = 4 + 1.2 + 0.1;
    const h = build(
      [
        [
          [0, 0],
          [12, 0],
          [12, y],
          [0, y],
          [0, 0],
        ],
        [
          [0, 4],
          [12, 4],
        ],
        [
          [4, 0],
          [4, 4],
        ],
        [
          [8, 0],
          [8, 4],
        ],
      ],
      [
        ['Bedroom', { x: 2, y: 2 }],
        ['Bath/WC 1', { x: 6, y: 2 }],
        ['Bath/WC 2', { x: 10, y: 2 }],
        ['Living', { x: 6, y: 4.6 }],
      ],
    );
    h.door(h.wall({ x: 0, y: 4 }, { x: 4, y: 4 }), 0.9, { swing: 'leftOut' });
    // Bath 1 opens off the bedroom; Bath 2 off the corridor.
    h.door(h.wall({ x: 4, y: 0 }, { x: 4, y: 4 }), 0.9, { swing: 'leftOut' });
    h.door(h.wall({ x: 8, y: 4 }, { x: 12, y: 4 }), 0.9, { swing: 'leftOut' });
    h.door(h.wall({ x: 12, y }, { x: 0, y }), 1.0, { swing: 'leftIn', t: 0.8 });
    const lvl = frozen(h.lvl());
    const bed = h.room(2, 2);
    const b1 = h.room(6, 2);
    const b2 = h.room(10, 2);
    expect(ageingReport(lvl, wheel({ bedroomId: bed })).bathroom).toBe(b1);
    // No bedroom: nearest the main door (at x 2.4 of 12, nearer Bath 2's door? It's at x 10:
    // the main door is at t 0.8 from x 12, so x 2.4; Bath 1 is only reached through the
    // bedroom).
    const none = ageingReport(lvl, wheel());
    expect([b1, b2]).toContain(none.bathroom);
    expect(none.bathroomAuto).toBe(true);
    const picked = ageingReport(lvl, wheel({ bedroomId: bed, bathroomId: b2 }));
    expect(picked.bathroom).toBe(b2);
    expect(picked.bathroomAuto).toBe(false);
  });

  it('16. no outside door: no-main-door, no door/route/entrance lines; turning and bathroom run', () => {
    const { h, id } = bath();
    // Bath with a toilet facing a wall 0.9 away; no main door at all.
    const lvl = withItems(h.lvl(), [['toilet', { x: 0.05 + 0.9 + 0.35, y: 1.0 }, Math.PI / 2]]);
    const r = ageingReport(lvl, wheel({ bathroomId: id }));
    expect(r.status).toBe('no-main-door');
    expect(r.notes).toContain('no-main-door');
    expect(
      r.issues.filter((i) =>
        ['door-width', 'door-space', 'route', 'entrance-space', 'latch-side'].includes(i.kind),
      ),
    ).toEqual([]);
    expect(kinds(r, 'turn').length + kinds(r, 'wc-front').length).toBeGreaterThan(0);
  });
});

describe('the sample flat', () => {
  it('18. furnished, wheelchair, each bedroom in turn: the reviewed lines', () => {
    const lvl = Object.freeze({ ...furnishedSample() });
    const lines = (choice: AgeingChoice) =>
      ageingReport(lvl, choice).issues.map(
        (i) =>
          `${i.group} ${i.level} ${i.kind} ${lvl.rooms[i.roomId ?? '']?.name ?? ''} ${i.need.toFixed(2)}/${i.have.toFixed(2)}${i.flat ? ' walls' : ''}${i.itemIds.length ? ` [${i.itemIds.map((id) => lvl.items[id]?.assetId).join(',')}]` : ''}`,
      );
    const out: Record<string, string[]> = { none: lines(wheel()) };
    for (const b of ageingReport(lvl, wheel()).bedrooms) {
      out[lvl.rooms[b.roomId]?.name ?? b.roomId] = lines(wheel({ bedroomId: b.roomId }));
    }
    expect(out).toMatchSnapshot();
    // The bare sample: no route lines blamed on pieces.
    const bare = sampleFlatProject('prj_t').levels[0] as Level;
    for (const b of ageingReport(bare, wheel()).bedrooms) {
      const r = ageingReport(bare, wheel({ bedroomId: b.roomId }));
      expect(r.issues.filter((i) => i.kind === 'route' && i.itemIds.length)).toEqual([]);
    }
  });

  it('19. the same level twice: the same issues and keys, in the same order', () => {
    const lvl = furnishedSample();
    const a = ageingReport(Object.freeze({ ...lvl }), wheel());
    const b = ageingReport(Object.freeze({ ...lvl }), wheel());
    expect(b.issues.map((i) => i.key)).toEqual(a.issues.map((i) => i.key));
    expect(b).toEqual(a);
  });

  it('a stale pass: walkways on After, then ageing on Before matches a fresh run', () => {
    let s: EditorDoc = { doc: sampleFlatProject('prj_t'), history: emptyHistory() };
    s = dispatch(s, startRenovation());
    const [before] = variantLevels(s.doc, 'before') as [Level];
    const [after] = variantLevels(s.doc, 'after') as [Level];
    const furnished = Object.freeze({ ...after, items: furnishedSample().items });
    const fresh = ageingReport(Object.freeze({ ...before }), wheel());
    walkwayReport(before);
    walkwayReport(furnished);
    const again = ageingReport(before, wheel());
    expect(again.issues).toEqual(fresh.issues);
  });

  it('a level with no main door rastered between: the pass kept for L is still L’s', () => {
    // L furnished, its pass made by walkways; then a new plan with no main door (its bare
    // raster is made afresh); then the ageing check on L reads L's pass.
    const L = Object.freeze({ ...furnishedSample() });
    const fresh = ageingReport(Object.freeze({ ...L }), wheel());
    walkwayReport(L);
    const near = Int32Array.from(furnishedPass(L).near);
    const other = box(3.0, 2.0, 'Bedroom');
    const X = Object.freeze({ ...other.lvl(), items: { ...other.lvl().items } });
    expect(walkwayReport(X).status).toBe('no-main-door');
    const kept = furnishedPass(L).near;
    let differ = 0;
    for (let k = 0; k < near.length; k++) if (kept[k] !== near[k]) differ++;
    expect(differ).toBe(0);
    expect(ageingReport(L, wheel()).issues).toEqual(fresh.issues);
  });

  it('Before and After are checked separately', () => {
    let s: EditorDoc = { doc: sampleFlatProject('prj_t'), history: emptyHistory() };
    s = dispatch(s, startRenovation());
    const [before] = variantLevels(s.doc, 'before') as [Level];
    const [after] = variantLevels(s.doc, 'after') as [Level];
    const furnished = Object.freeze({ ...after, items: furnishedSample().items });
    const main = Object.values(before.rooms).find((r) => r.name === 'Main bedroom')?.id;
    const a = ageingReport(before, wheel({ bedroomId: main }));
    const b = ageingReport(furnished, wheel({ bedroomId: main }));
    // After's bed is checked; Before has none.
    expect(a.issues.some((i) => i.kind === 'bed')).toBe(false);
    expect(b.bedroom).toBe(main);
    expect(b.issues.map((i) => i.key)).not.toEqual(a.issues.map((i) => i.key));
  });
});
