import { describe, expect, it } from 'vitest';
import { addOpening, drawWall, renameRoom, setCeilingHeight } from './commands';
import { TYPICAL_RATES, electricalLines } from './cost';
import {
  ELEC_KINDS,
  type NewPoint,
  clearAlong,
  inOpening,
  pointPosition,
  pointRoom,
} from './electrical';
import { blankProject } from './factory';
import { furnishedSample } from './fixtures/furnishedSample';
import { sampleFlatProject } from './fixtures/sampleFlat';
import { furnitureKind, newItem } from './furniture';
import { pointInPolygon } from './geometry';
import { type EditorDoc, dispatch, emptyHistory, undo } from './history';
import { AFTER_SUFFIX } from './levels';
import { planGeometry } from './plan';
import { startRenovation } from './renovation';
import { roomShapes } from './rooms';
import type { ElecPoint, Item, Level, Opening, Vec2 } from './schema';
import { wallStatus } from './structural';
import {
  SUGGEST_NOTES,
  type Suggestion,
  addPoints,
  noRoomFor,
  roomKind,
  suggestPoints,
  suggestionCost,
} from './suggest';

type Seg = [number, number, number, number];

/** Rooms drawn from wall lines (100 mm walls), named by a point inside each. */
function plan(segs: Seg[], names: [string, Vec2][], ceiling = 2.6): EditorDoc {
  let s: EditorDoc = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
  const lvl = () => s.doc.levels[0] as Level;
  for (const [ax, ay, bx, by] of segs) {
    s = dispatch(
      s,
      drawWall(lvl(), { point: { x: ax, y: ay } }, { point: { x: bx, y: by } }, { thickness: 0.1 })
        .command,
    );
  }
  s = dispatch(s, setCeilingHeight(lvl().id, ceiling));
  const shapes = roomShapes(lvl());
  for (const [name, at] of names) {
    const r = Object.values(lvl().rooms).find((r) => {
      const sh = shapes.get(r.id);
      return sh && pointInPolygon(at, sh.outer);
    });
    if (!r) throw new Error(`no room at ${at.x}, ${at.y}`);
    s = dispatch(s, renameRoom(lvl().id, r.id, name));
  }
  return s;
}

const box = (w: number, d: number): Seg[] => [
  [0, 0, w, 0],
  [w, 0, w, d],
  [w, d, 0, d],
  [0, d, 0, 0],
];

const flat = (s: EditorDoc) => s.doc.levels[0] as Level;

/** The wall whose line runs from p to q (either way). */
function wallAlong(l: Level, p: [number, number], q: [number, number]): string {
  const w = Object.values(l.walls).find((w) => {
    const a = l.vertices[w.a];
    const b = l.vertices[w.b];
    if (!a || !b) return false;
    const on = (v: Vec2, r: [number, number]) => Math.hypot(v.x - r[0], v.y - r[1]) < 1e-6;
    return (on(a, p) && on(b, q)) || (on(a, q) && on(b, p));
  });
  if (!w) throw new Error('no wall there');
  return w.id;
}

function door(
  s: EditorDoc,
  p: [number, number],
  q: [number, number],
  t: number,
  extra: Partial<Opening> = {},
): EditorDoc {
  const l = flat(s);
  const r = addOpening(l.id, {
    wallId: wallAlong(l, p, q),
    kind: 'door',
    t,
    width: 0.9,
    height: 2.1,
    sill: 0,
    swing: 'leftIn',
    ...extra,
  });
  return dispatch(s, r.command);
}

let n = 0;
/** The level with pieces added: [kind id, centre, rotation, scale x]. */
function withItems(level: Level, pieces: [string, Vec2, number?, number?][]): Level {
  const items = { ...level.items };
  for (const [kindId, at, rot, sx] of pieces) {
    const kind = furnitureKind(kindId);
    if (!kind) throw new Error(`no ${kindId}`);
    const it: Item = newItem(`it_${String(++n).padStart(3, '0')}`, kind, at, rot ?? 0, 2.6);
    if (sx) it.scale = { ...it.scale, x: sx };
    items[it.id] = it;
  }
  return { ...level, items };
}

const withPoints = (level: Level, points: readonly NewPoint[]): Level => ({
  ...level,
  points: {
    ...level.points,
    ...Object.fromEntries(points.map((p, i) => [`pt_x${i}`, { ...p, id: `pt_x${i}` }])),
  },
});

/** A 4 × 3 m bedroom (100 mm walls, 2.6 m ceiling), its 0.9 m door mid-way along the bottom. */
function bedroom(name = 'Bedroom'): Level {
  return flat(door(plan(box(4, 3), [[name, { x: 2, y: 1.5 }]]), [4, 3], [0, 3], 0.5));
}

const ofRule = (xs: Suggestion[], rule: Suggestion['rule']) => xs.filter((x) => x.rule === rule);
const along = (l: Level, p: NewPoint) => {
  const pos = pointPosition(l, { ...p, id: 'probe' } as ElecPoint);
  if (!pos) throw new Error('no position');
  return pos;
};
const roomId = (l: Level, name: string) => {
  const r = Object.values(l.rooms).find((r) => r.name === name);
  if (!r) throw new Error(`no ${name}`);
  return r.id;
};

describe('roomKind', () => {
  it('reads what a room is from its name', () => {
    expect(roomKind('Main bedroom')).toBe('bedroom');
    expect(roomKind('Master bathroom')).toBe('bathroom');
    expect(roomKind('Bath/WC 1')).toBe('bathroom');
    expect(roomKind('Dry kitchen')).toBe('kitchen');
    expect(roomKind('Living and dining')).toBe('living');
    expect(roomKind('Household shelter')).toBe('none');
    expect(roomKind('Air-con ledge')).toBe('none');
    expect(roomKind('Study')).toBe('study');
    expect(roomKind('Room 3')).toBe('other');
  });
});

describe('suggestPoints: a bedroom', () => {
  it('suggests a light, a switch, a socket and an aircon unit in an empty bedroom', () => {
    const l = bedroom();
    const { points } = suggestPoints(l);
    expect(points.map((p) => p.rule).sort()).toEqual(['aircon', 'dresser', 'light', 'switch']);
    const light = ofRule(points, 'light')[0]?.point;
    expect(light?.at?.x).toBeCloseTo(2, 2);
    expect(light?.at?.y).toBeCloseTo(1.5, 2);
    // The switch: 1.05 m, in the room, on the latch side, its plate 150 mm off the opening.
    const sw = ofRule(points, 'switch')[0]?.point as NewPoint;
    expect(sw.kind).toBe('switch');
    expect(sw.gang).toBe(1);
    expect(sw.wall?.height).toBe(1.05);
    expect(pointRoom(l, { ...sw, id: 'x' })).toBe('Bedroom');
    const o = Object.values(l.openings)[0] as Opening;
    const len = 4;
    const latch = o.t * len + o.width / 2; // a left-hinged door latches towards b
    const edge = along(l, sw).along - ELEC_KINDS.switch.plate.w / 2;
    expect(Math.abs(edge - latch - 0.15)).toBeLessThan(0.005);
    const socket = ofRule(points, 'dresser')[0]?.point as NewPoint;
    expect(socket.kind).toBe('socket-double');
    expect(socket.wall?.height).toBe(0.3);
    const ac = ofRule(points, 'aircon')[0]?.point as NewPoint;
    expect(ac.kind).toBe('aircon');
    expect(ac.wall?.height).toBeCloseTo(2.4, 6);
  });

  it('puts bedside sockets beside a queen bed and the aircon over its head', () => {
    const l = withItems(bedroom(), [['bed-queen', { x: 2, y: 1.05 }]]);
    const { points } = suggestPoints(l);
    const beds = ofRule(points, 'bedside');
    expect(beds).toHaveLength(2);
    const top = wallAlong(l, [0, 0], [4, 0]);
    const xs = beds.map((b) => {
      expect(b.point.kind).toBe('socket-double');
      expect(b.point.wall?.wallId).toBe(top);
      expect(b.point.wall?.height).toBe(0.7);
      return along(l, b.point).at.x;
    });
    xs.sort((a, b) => a - b);
    expect(Math.abs((xs[0] as number) - (2 - 0.76 - 0.25))).toBeLessThan(0.005);
    expect(Math.abs((xs[1] as number) - (2 + 0.76 + 0.25))).toBeLessThan(0.005);
    const ac = ofRule(points, 'aircon')[0]?.point as NewPoint;
    expect(ac.wall?.wallId).toBe(top);
    expect(Math.abs(along(l, ac).at.x - 2)).toBeLessThan(0.01);
    // The desk-or-dresser socket goes elsewhere.
    expect(ofRule(points, 'dresser')[0]?.point.wall?.wallId).not.toBe(top);
  });

  it('gives a single bed against the left wall one bedside socket, on its open side', () => {
    const l = withItems(bedroom(), [['bed-single', { x: 0.05 + 0.46, y: 1.05 }]]);
    const beds = ofRule(suggestPoints(l).points, 'bedside');
    expect(beds).toHaveLength(1);
    expect(beds[0]?.where).toBe('Bedside, right');
    expect(Math.abs(along(l, beds[0]?.point as NewPoint).at.x - (0.97 + 0.25))).toBeLessThan(0.005);
  });

  it('notes a bed that isn’t against a wall', () => {
    const l = withItems(bedroom(), [['bed-queen', { x: 2, y: 1.4 }]]);
    const out = suggestPoints(l);
    expect(ofRule(out.points, 'bedside')).toHaveLength(0);
    expect(out.notes.map((x) => x.text)).toContain(SUGGEST_NOTES.bed);
  });

  it('puts a socket behind a desk at 0.90 m, and no desk-or-dresser socket', () => {
    const l = withItems(bedroom('Study'), [['desk', { x: 2, y: 0.35 }]]);
    const { points } = suggestPoints(l);
    const desk = ofRule(points, 'desk');
    expect(desk).toHaveLength(1);
    expect(desk[0]?.point.wall?.height).toBe(0.9);
    expect(Math.abs(along(l, desk[0]?.point as NewPoint).at.x - 2)).toBeLessThan(0.005);
    expect(ofRule(points, 'dresser')).toHaveLength(0);
  });

  it('two beds side by side closer than 0.4 m share a socket', () => {
    const l = withItems(bedroom(), [
      ['bed-single', { x: 1.2, y: 1.05 }],
      ['bed-single', { x: 1.2 + 0.92 + 0.2, y: 1.05 }],
    ]);
    const beds = ofRule(suggestPoints(l).points, 'bedside');
    expect(beds).toHaveLength(3);
  });
});

/** A 4 × 3 m kitchen with a counter run along its top wall. */
function kitchen(pieces: [string, Vec2, number?, number?][] = []): Level {
  return withItems(
    flat(door(plan(box(4, 3), [['Kitchen', { x: 2, y: 1.5 }]]), [4, 3], [0, 3], 0.5)),
    pieces,
  );
}

const run3 = (): [string, Vec2, number?, number?][] => [
  ['kitchen-base', { x: 0.05 + 0.3, y: 0.35 }],
  ['kitchen-sink', { x: 0.05 + 0.9, y: 0.35 }, 0, 0.75],
  ['kitchen-base', { x: 0.05 + 1.5, y: 0.35 }],
  ['kitchen-hob', { x: 0.05 + 2.1, y: 0.35 }, 0, 0.75],
  ['kitchen-base', { x: 0.05 + 2.7, y: 0.35 }],
];

describe('suggestPoints: a kitchen', () => {
  it('spaces counter sockets clear of the sink and hob, with hood, hob and fridge points', () => {
    const l = kitchen([...run3(), ['fridge', { x: 3.6, y: 1.5 }, Math.PI / 2]]);
    const { points } = suggestPoints(l);
    const counter = ofRule(points, 'counter');
    expect(counter).toHaveLength(3);
    const at = counter.map((c) => along(l, c.point).at.x - 0.05).sort((a, b) => a - b);
    [0.277, 1.523, 2.623].forEach((want, i) => {
      expect(Math.abs((at[i] as number) - want)).toBeLessThan(0.005);
    });
    for (const c of counter) {
      expect(c.point.kind).toBe('socket-double');
      expect(c.point.wall?.height).toBe(1.15);
    }
    const hood = ofRule(points, 'hood')[0]?.point as NewPoint;
    expect(hood.kind).toBe('socket-single');
    expect(hood.wall?.height).toBe(2.1);
    expect(Math.abs(along(l, hood).at.x - 0.05 - 2.1)).toBeLessThan(0.005);
    const cooker = ofRule(points, 'cooker')[0]?.point as NewPoint;
    expect(cooker.kind).toBe('cooker');
    expect(cooker.wall?.height).toBe(0.6);
    expect(Math.abs(along(l, cooker).at.x - 0.05 - 2.1)).toBeLessThan(0.005);
    const fridge = ofRule(points, 'fridge')[0]?.point as NewPoint;
    expect(fridge.kind).toBe('socket-single');
    expect(fridge.wall?.height).toBe(0.3);
    expect(fridge.wall?.wallId).toBe(wallAlong(l, [4, 0], [4, 3]));
    expect(Math.abs(along(l, fridge).at.y - 1.5)).toBeLessThan(0.005);
  });

  it('gives a 1.2 m run one socket and a 2.4 m run two; no counter, a note', () => {
    const short = kitchen([['built-in-kitchen-base', { x: 0.65, y: 0.35 }, 0, 0.5]]);
    expect(ofRule(suggestPoints(short).points, 'counter')).toHaveLength(1);
    const long = kitchen([['built-in-kitchen-base', { x: 1.25, y: 0.35 }]]);
    const out = suggestPoints(long);
    expect(ofRule(out.points, 'counter')).toHaveLength(2);
    // A base run with no hob cabinet: no hood or cooker point, and a note.
    expect(ofRule(out.points, 'hood')).toHaveLength(0);
    expect(out.notes.map((x) => x.text)).toContain(SUGGEST_NOTES.hob);
    const none = suggestPoints(kitchen());
    expect(ofRule(none.points, 'counter')).toHaveLength(0);
    expect(none.notes.map((x) => x.text)).toContain(SUGGEST_NOTES.counter);
  });

  /** A 4 × 3 m kitchen with a window on its top wall, `width` wide, centred `at` along it. */
  const windowed = (at: number, width: number, pieces: [string, Vec2, number?, number?][]) => {
    let s = door(plan(box(4, 3), [['Kitchen', { x: 2, y: 1.5 }]]), [4, 3], [0, 3], 0.5);
    const l = flat(s);
    const r = addOpening(l.id, {
      wallId: wallAlong(l, [0, 0], [4, 0]),
      kind: 'window',
      t: at / 4,
      width,
      height: 1.2,
      sill: 0.9,
    });
    s = dispatch(s, r.command);
    return withItems(flat(s), pieces);
  };

  it('suggests no counter socket again once a run’s sockets are added, a window over it', () => {
    // A 2.4 m run under a 1.2 m window: its first socket is pushed along to the run's end.
    const l = windowed(0.85, 1.2, [['built-in-kitchen-base', { x: 1.25, y: 0.35 }]]);
    const first = suggestPoints(l).points;
    const counter = ofRule(first, 'counter');
    expect(counter.length).toBeGreaterThan(0);
    for (const c of counter) expect(inOpening(l, { ...c.point, id: 'x' } as ElecPoint)).toBe(false);
    const again = suggestPoints(
      withPoints(
        l,
        first.map((p) => p.point),
      ),
    );
    expect(again.points.map((p) => p.key)).toEqual([]);
    // Nor with only the counter sockets added.
    const some = suggestPoints(
      withPoints(
        l,
        counter.map((p) => p.point),
      ),
    );
    expect(ofRule(some.points, 'counter')).toEqual([]);
  });

  it('notes a hood socket a window leaves no room for', () => {
    const l = windowed(2.15, 1.0, run3());
    const out = suggestPoints(l);
    expect(ofRule(out.points, 'hood')).toHaveLength(0);
    expect(out.notes.map((n) => n.text)).toContain(noRoomFor('hood socket'));
  });

  it('rounds a 4.2 m run’s 3.5 sockets up to four', () => {
    const l = withItems(flat(plan(box(5, 3), [['Kitchen', { x: 2, y: 1.5 }]])), [
      ['built-in-kitchen-base', { x: 0.05 + 2.1, y: 0.35 }, 0, 4.2 / 2.4],
    ]);
    expect(ofRule(suggestPoints(l).points, 'counter')).toHaveLength(4);
  });
});

/** A 4 × 3 m living room, its door on the left wall. */
function living(pieces: [string, Vec2, number?, number?][] = []): Level {
  const s = door(plan(box(4, 3), [['Living', { x: 2, y: 1.5 }]]), [0, 3], [0, 0], 0.5);
  return withItems(flat(s), pieces);
}

describe('suggestPoints: a living room', () => {
  it('puts the TV wall behind the console: sockets at ±0.45, TV and data at ∓0.15', () => {
    const l = living([['tv-console', { x: 2, y: 0.25 }]]);
    const { points } = suggestPoints(l);
    const tv = ofRule(points, 'tv-wall');
    expect(tv).toHaveLength(4);
    const top = wallAlong(l, [0, 0], [4, 0]);
    const got = tv
      .map((p) => ({ kind: p.point.kind, x: along(l, p.point).at.x - 2, h: p.point.wall?.height }))
      .sort((a, b) => a.x - b.x);
    const want: [string, number][] = [
      ['socket-double', -0.45],
      ['tv', -0.15],
      ['data', 0.15],
      ['socket-double', 0.45],
    ];
    want.forEach(([kind, x], i) => {
      expect(got[i]?.kind).toBe(kind);
      expect(Math.abs((got[i]?.x as number) - x)).toBeLessThan(0.005);
      expect(got[i]?.h).toBe(0.3);
    });
    for (const p of tv) expect(p.point.wall?.wallId).toBe(top);
    expect(ofRule(points, 'aircon')[0]?.point.wall?.wallId).not.toBe(top);
  });

  it('with a sofa and no console, the TV wall is the one the sofa looks at', () => {
    const l = living([['sofa-3', { x: 2, y: 3 - 0.05 - 0.45 }, Math.PI]]);
    const tv = ofRule(suggestPoints(l).points, 'tv-wall');
    expect(tv).toHaveLength(4);
    const top = wallAlong(l, [0, 0], [4, 0]);
    for (const p of tv) expect(p.point.wall?.wallId).toBe(top);
  });
});

describe('suggestPoints: bathrooms, shelters and ledges', () => {
  it('puts a bathroom’s switch outside, on the latch side; a water heater; no sockets', () => {
    let s = plan(
      [...box(4, 3), [2, 0, 2, 3]],
      [
        ['Bathroom', { x: 1, y: 1.5 }],
        ['Bedroom', { x: 3, y: 1.5 }],
      ],
    );
    s = door(s, [2, 0], [2, 3], 0.5);
    const l = flat(s);
    const bath = roomId(l, 'Bathroom');
    const mine = suggestPoints(l).points.filter((p) => p.roomId === bath);
    expect(mine.map((p) => p.rule).sort()).toEqual(['light', 'switch', 'water-heater']);
    const sw = ofRule(mine, 'switch')[0]?.point as NewPoint;
    expect(pointRoom(l, { ...sw, id: 'x' })).toBe('Bedroom');
    const o = Object.values(l.openings)[0] as Opening;
    const pos = along(l, sw);
    expect(pos.along).toBeGreaterThan(o.t * 3 + o.width / 2);
    const heater = ofRule(mine, 'water-heater')[0]?.point as NewPoint;
    expect(heater.wall?.height).toBe(2);
    expect(heater.wall?.wallId).toBe(wallAlong(l, [0, 3], [0, 0]));
    const light = ofRule(mine, 'light')[0]?.point.at as Vec2;
    expect(light.x).toBeLessThan(2);
  });

  it('suggests nothing in or on a shelter; a compressor on the ledge for a new aircon', () => {
    const s = plan(
      [...box(6, 3), [2, 0, 2, 3], [4, 0, 4, 3]],
      [
        ['Bedroom', { x: 1, y: 1.5 }],
        ['Household shelter', { x: 3, y: 1.5 }],
        ['Air-con ledge', { x: 5, y: 1.5 }],
      ],
    );
    const l = flat(s);
    const out = suggestPoints(l);
    const shelter = roomId(l, 'Household shelter');
    expect(out.points.filter((p) => p.roomId === shelter)).toHaveLength(0);
    for (const p of out.points) {
      if (p.point.wall) expect(wallStatus(l, p.point.wall.wallId)).not.toBe('shelter');
      if (p.point.at) expect(pointRoom(l, { ...p.point, id: 'x' })).not.toBe('Household shelter');
    }
    const comp = ofRule(out.points, 'compressor');
    expect(comp).toHaveLength(1);
    expect(comp[0]?.roomId).toBe(roomId(l, 'Air-con ledge'));
    expect(pointRoom(l, { ...(comp[0]?.point as NewPoint), id: 'x' })).toBe('Air-con ledge');
    // Not with a compressor there already, nor with no aircon suggested.
    const has = withPoints(l, [{ kind: 'compressor', at: { x: 5, y: 1 } }]);
    expect(ofRule(suggestPoints(has).points, 'compressor')).toHaveLength(0);
    const ac = out.points.find((p) => p.rule === 'aircon')?.point as NewPoint;
    expect(ofRule(suggestPoints(withPoints(l, [ac])).points, 'compressor')).toHaveLength(0);
  });

  it('notes a room with a plain name', () => {
    const l = flat(plan(box(4, 3), [['Room 3', { x: 2, y: 1.5 }]]));
    const out = suggestPoints(l);
    expect(out.notes.map((x) => x.text)).toEqual([SUGGEST_NOTES.name]);
    expect(out.points.map((p) => p.rule)).toEqual(['light']);
  });
});

describe('suggestPoints: the sample flat', () => {
  it('gives the dry kitchen no switch, and the living room’s switch a gang for its light', () => {
    const l = sampleFlatProject().levels[0] as Level;
    const { points } = suggestPoints(l);
    const dry = roomId(l, 'Dry kitchen');
    const livingId = roomId(l, 'Living and dining');
    expect(points.filter((p) => p.roomId === dry && p.rule === 'switch')).toHaveLength(0);
    expect(points.some((p) => p.roomId === dry && p.rule === 'light')).toBe(true);
    const sw = points.find((p) => p.roomId === livingId && p.rule === 'switch');
    expect(sw?.point.gang).toBe(2);
    // By the main door.
    const main = Object.values(l.openings).find((o) => o.width === 1 && o.kind === 'door');
    expect(sw?.point.wall?.wallId).toBe(main?.wallId);
  });

  it('suggests nothing already there, and nothing once everything is added', () => {
    for (const l of [sampleFlatProject().levels[0] as Level, furnishedSample()]) {
      const first = suggestPoints(l).points;
      expect(first.length).toBeGreaterThan(10);
      const again = suggestPoints(
        withPoints(
          l,
          first.map((p) => p.point),
        ),
      );
      expect(again.points.map((p) => p.key)).toEqual([]);
    }
  });

  it('drops a suggestion for a socket, light or aircon already there', () => {
    const l = bedroom();
    const first = suggestPoints(l).points;
    const socket = ofRule(first, 'dresser')[0]?.point as NewPoint;
    const wall = socket.wall as NonNullable<NewPoint['wall']>;
    const near: NewPoint = {
      kind: 'socket-single',
      wall: { ...wall, t: wall.t + 0.3 / 4 },
    };
    expect(ofRule(suggestPoints(withPoints(l, [near])).points, 'dresser')).toHaveLength(0);
    const lit = withPoints(l, [{ kind: 'light', at: { x: 1, y: 1 } }]);
    expect(ofRule(suggestPoints(lit).points, 'light')).toHaveLength(0);
    const ac = ofRule(first, 'aircon')[0]?.point as NewPoint;
    const cooled = withPoints(l, [
      { ...ac, wall: { ...(ac.wall as NonNullable<NewPoint['wall']>), t: 0.3 } },
    ]);
    expect(ofRule(suggestPoints(cooled).points, 'aircon')).toHaveLength(0);
  });

  it('places every point clear: off shelters, openings and each other', () => {
    for (const l of [sampleFlatProject().levels[0] as Level, furnishedSample()]) {
      const { points } = suggestPoints(l);
      const geom = planGeometry(l);
      const all = points.map((p, i) => ({ ...p.point, id: `s${i}` }) as ElecPoint);
      for (const p of all) {
        if (!p.wall) continue;
        expect(wallStatus(l, p.wall.wallId)).not.toBe('shelter');
        expect(inOpening(l, p)).toBe(false);
        const len = geom.frames[p.wall.wallId]?.length ?? 0;
        const u = clearAlong(
          l,
          geom,
          p.kind,
          { wallId: p.wall.wallId, along: p.wall.t * len, side: p.wall.side },
          p.wall.height,
          undefined,
          { extra: all.filter((q) => q !== p) },
        );
        expect(u).not.toBeNull();
        expect(Math.abs((u as number) - p.wall.t * len)).toBeLessThan(1e-6);
      }
    }
  });

  it('puts no socket behind the wardrobe', () => {
    const l = furnishedSample();
    const wardrobe = Object.values(l.items).find((it) => it.assetId === 'wardrobe') as Item;
    for (const p of suggestPoints(l).points) {
      if (!p.point.wall || p.point.kind === 'aircon') continue;
      const at = along(l, p.point).at;
      const dx = Math.abs(at.x - wardrobe.position.x);
      const dy = Math.abs(at.y - wardrobe.position.z);
      expect(dx < 0.6 && dy < 0.45).toBe(false);
    }
  });

  it('gives the same suggestions, keys and order whatever order the records are in', () => {
    const l = furnishedSample();
    const a = suggestPoints(l);
    const flip = <T>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).reverse());
    const shuffled: Level = {
      ...l,
      vertices: flip(l.vertices),
      walls: flip(l.walls),
      openings: flip(l.openings),
      rooms: flip(l.rooms),
      items: flip(l.items),
    };
    const b = suggestPoints(shuffled);
    expect(b.points.map((p) => p.key)).toEqual(a.points.map((p) => p.key));
    expect(b.points).toEqual(a.points);
    expect(b.rooms).toEqual(a.rooms);
    expect(suggestPoints(l)).toEqual(a);
  });

  it('prices suggestions as the estimate does', () => {
    const l = furnishedSample();
    const { points } = suggestPoints(l);
    const cost = suggestionCost(points, TYPICAL_RATES);
    const sum = (ls: ReturnType<typeof electricalLines>) =>
      ls.reduce((s, x) => ({ low: s.low + x.low, high: s.high + x.high }), { low: 0, high: 0 });
    const before = electricalLines(l, undefined, TYPICAL_RATES);
    const after = electricalLines(
      withPoints(
        l,
        points.map((p) => p.point),
      ),
      undefined,
      TYPICAL_RATES,
    );
    // Each estimate line is rounded to $10.
    const slack = 5 * (before.length + after.length);
    expect(Math.abs(sum(after).low - sum(before).low - cost.low)).toBeLessThanOrEqual(slack);
    expect(Math.abs(sum(after).high - sum(before).high - cost.high)).toBeLessThanOrEqual(slack);
    expect(cost.low).toBeGreaterThan(0);
  });

  it('finishes quickly on a furnished flat', () => {
    const base = furnishedSample();
    const pieces: [string, Vec2][] = [];
    for (let i = pieces.length + Object.keys(base.items).length; i < 40; i++)
      pieces.push(['plant', { x: 7 + (i % 6) * 0.4, y: 2.2 + Math.floor(i / 6) * 0.3 }]);
    const l = withItems(base, pieces);
    expect(Object.keys(l.items).length).toBeGreaterThanOrEqual(40);
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      const copy = Object.freeze(structuredClone(l));
      const t0 = performance.now();
      suggestPoints(copy);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const limit = process.env.PERF ? 50 : 150;
    expect(times[3]).toBeLessThan(limit);
  });

  it('finishes 40 rooms quickly', () => {
    const segs: Seg[] = [];
    for (let i = 0; i <= 8; i++) segs.push([i * 3, 0, i * 3, 15]);
    for (let j = 0; j <= 5; j++) segs.push([0, j * 3, 24, j * 3]);
    const names: [string, Vec2][] = [];
    for (let i = 0; i < 8; i++)
      for (let j = 0; j < 5; j++)
        names.push([`Bedroom ${i}${j}`, { x: i * 3 + 1.5, y: j * 3 + 1.5 }]);
    const l = Object.freeze(structuredClone(flat(plan(segs, names))));
    const t0 = performance.now();
    const out = suggestPoints(l);
    const ms = performance.now() - t0;
    expect(out.rooms).toHaveLength(40);
    expect(ms).toBeLessThan(process.env.PERF ? 150 : 450);
  });
});

describe('addPoints', () => {
  it('adds them in one undo step, which undo takes back exactly', () => {
    const l = bedroom();
    const s0: EditorDoc = {
      doc: { ...blankProject('t', 'prj_t'), levels: [l] },
      history: emptyHistory(),
    };
    const pts = suggestPoints(l).points.map((p) => p.point);
    const r = addPoints(l.id, pts, 'Add 4 points to Bedroom');
    const s1 = dispatch(s0, r.command);
    expect(r.ids).toHaveLength(4);
    expect(Object.keys(flat(s1).points)).toHaveLength(4);
    expect(s1.history.past).toHaveLength(1);
    expect(s1.history.past[0]?.label).toBe('Add 4 points to Bedroom');
    const s2 = undo(s1);
    expect(s2.doc).toEqual(s0.doc);
  });

  it('adds nothing if any point’s wall is gone', () => {
    const l = bedroom();
    const s0: EditorDoc = {
      doc: { ...blankProject('t', 'prj_t'), levels: [l] },
      history: emptyHistory(),
    };
    const pts = suggestPoints(l).points.map((p) => p.point);
    const bad: NewPoint = {
      kind: 'switch',
      gang: 1,
      wall: { wallId: 'w_gone', t: 0.5, side: 'left', height: 1 },
    };
    const r = addPoints(l.id, [...pts, bad]);
    expect(() => dispatch(s0, r.command)).toThrow();
    expect(Object.keys(flat(s0).points)).toHaveLength(0);
  });
});

describe('suggestPoints in a renovation', () => {
  it('suggests for the renovation, judging walls on the flat as it is', () => {
    const s = dispatch(
      { doc: { ...blankProject('t', 'prj_t'), levels: [bedroom()] }, history: emptyHistory() },
      startRenovation(),
    );
    const before = flat(s);
    const after = s.doc.renovation?.levels[0] as Level;
    expect(after.id).toBe(`${before.id}${AFTER_SUFFIX}`);
    const out = suggestPoints(after, { statusOf: before });
    expect(out.points).toHaveLength(4);
    const r = addPoints(
      after.id,
      out.points.map((p) => p.point),
    );
    const s1 = dispatch(s, r.command);
    expect(Object.keys(flat(s1).points)).toHaveLength(0);
    expect(Object.keys(s1.doc.renovation?.levels[0]?.points ?? {})).toHaveLength(4);
  });
});
