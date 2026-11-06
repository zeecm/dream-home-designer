import { describe, expect, it } from 'vitest';
import {
  addOpening,
  deleteWall,
  drawWall,
  moveVertex,
  renameRoom,
  splitWall,
  updateWall,
} from './commands';
import { TYPICAL_RATES, costEstimate } from './cost';
import {
  addPoint,
  defaultHeight,
  deletePoint,
  electricalChanges,
  placePoint,
  pointCounts,
  pointPosition,
  pointWarnings,
  trunkingLength,
  trunkingMetres,
  updatePoint,
} from './electrical';
import { blankProject } from './factory';
import { hdb4RoomProject } from './fixtures/hdb4room';
import { furnitureKind, newItem } from './furniture';
import { type EditorDoc, dispatch, emptyHistory, redo, undo } from './history';
import { AFTER_SUFFIX } from './levels';
import { loadProject } from './migrate';
import { carriedToRenovation, startRenovation } from './renovation';
import { ElecPoint, type Level, type Project, SCHEMA_VERSION } from './schema';

/** A w × d room, 100 mm walls, centred on lines from (0, 0); `extra` walls drawn after. */
function room(w: number, d: number, extra: [number, number, number, number][] = []): EditorDoc {
  let s: EditorDoc = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
  const segs: [number, number, number, number][] = [
    [0, 0, w, 0],
    [w, 0, w, d],
    [w, d, 0, d],
    [0, d, 0, 0],
    ...extra,
  ];
  for (const [ax, ay, bx, by] of segs) {
    const lvl = s.doc.levels[0] as Level;
    s = dispatch(
      s,
      drawWall(lvl, { point: { x: ax, y: ay } }, { point: { x: bx, y: by } }, { thickness: 0.1 })
        .command,
    );
  }
  return s;
}
const flat = (s: EditorDoc) => s.doc.levels[0] as Level;
const reno = (s: EditorDoc) => s.doc.renovation?.levels[0] as Level;
const LID = 'lvl_ground';
const A = `${LID}${AFTER_SUFFIX}`;

/** The wall whose line runs from p to q (either way). */
function wallAlong(l: Level, p: [number, number], q: [number, number]): string {
  const w = Object.values(l.walls).find((w) => {
    const a = l.vertices[w.a];
    const b = l.vertices[w.b];
    if (!a || !b) return false;
    const on = (v: { x: number; y: number }, r: [number, number]) =>
      Math.hypot(v.x - r[0], v.y - r[1]) < 1e-6;
    return (on(a, p) && on(b, q)) || (on(a, q) && on(b, p));
  });
  if (!w) throw new Error('no wall there');
  return w.id;
}

/** Adds a point placed by a tap at (x, y), returning the state and its id. */
function tap(s: EditorDoc, kind: ElecPoint['kind'], x: number, y: number, levelId = LID) {
  const level = levelId === LID ? flat(s) : reno(s);
  const wall = placePoint(level, kind, { x, y });
  if (!wall) throw new Error(`nowhere for a ${kind} at ${x}, ${y}`);
  const { at: _, ...place } = wall;
  const r = addPoint(levelId, { kind, wall: place });
  return { s: dispatch(s, r.command), id: r.pointId };
}

const pt = (l: Level, id: string) => l.points[id] as ElecPoint;

/** A wall point's place moved `by` metres towards +x. */
function along(l: Level, id: string, by: number): NonNullable<ElecPoint['wall']> {
  const p = pt(l, id).wall as NonNullable<ElecPoint['wall']>;
  const w = l.walls[p.wallId];
  const a = w && l.vertices[w.a];
  const b = w && l.vertices[w.b];
  if (!a || !b) throw new Error('no wall');
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return { ...p, t: p.t + ((b.x > a.x ? 1 : -1) * by) / len };
}

describe('electrical points (schema 9)', () => {
  it('a version-8 plan parses as 9 with no points on every level', () => {
    const doc = JSON.parse(JSON.stringify(hdb4RoomProject())) as Record<string, unknown>;
    doc.schemaVersion = 8;
    for (const l of doc.levels as Record<string, unknown>[]) delete l.points;
    doc.renovation = { levels: [{ ...(doc.levels as object[])[0], id: A }] };
    const { project } = loadProject(doc);
    expect(project.schemaVersion).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(9);
    expect(project.levels[0]?.points).toEqual({});
    expect(project.renovation?.levels[0]?.points).toEqual({});
  });

  it('a point is on a wall or at a place, never both; gangs are 1 to 3', () => {
    const wall = { wallId: 'w', t: 0.5, side: 'left' as const, height: 0.3 };
    expect(ElecPoint.safeParse({ id: 'p', kind: 'socket-double', wall }).success).toBe(true);
    expect(ElecPoint.safeParse({ id: 'p', kind: 'light', wall, at: { x: 0, y: 0 } }).success).toBe(
      false,
    );
    expect(ElecPoint.safeParse({ id: 'p', kind: 'light' }).success).toBe(false);
    expect(ElecPoint.safeParse({ id: 'p', kind: 'switch', wall, gang: 3 }).success).toBe(true);
    expect(ElecPoint.safeParse({ id: 'p', kind: 'switch', wall, gang: 4 }).success).toBe(false);
  });

  it('pointPosition: on the face, along and off the line, and up', () => {
    const s = room(4, 3);
    const l = flat(s);
    const id = wallAlong(l, [0, 0], [4, 0]);
    const w = l.walls[id];
    // The wall's left, seen from a to b.
    const side = w && l.vertices[w.a]?.x === 0 ? 'left' : 'right';
    const pos = pointPosition(l, {
      id: 'p',
      kind: 'socket-single',
      wall: { wallId: id, t: w && l.vertices[w.a]?.x === 0 ? 0.25 : 0.75, side, height: 0.3 },
    });
    expect(pos?.along).toBeCloseTo(w && l.vertices[w.a]?.x === 0 ? 1 : 3, 6);
    expect(pos?.off).toBeCloseTo(0.05, 6);
    expect(pos?.height).toBeCloseTo(0.3, 6);
    expect(pos?.at.x).toBeCloseTo(1, 6);
    expect(Math.abs(pos?.at.y ?? 0)).toBeCloseTo(0.05, 6);
  });

  it('pointPosition on a plain 4 m wall: 1.00 along, 0.05 off, 0.30 up', () => {
    const l = flat(room(4, 3));
    const lvl: Level = {
      ...l,
      vertices: { a: { id: 'a', x: 0, y: 0 }, b: { id: 'b', x: 4, y: 0 } },
      walls: {
        w: {
          id: 'w',
          a: 'a',
          b: 'b',
          thickness: 0.1,
          materialLeft: 'paint-white',
          materialRight: 'paint-white',
        },
      },
      rooms: {},
    };
    const pos = pointPosition(lvl, {
      id: 'p',
      kind: 'socket-single',
      wall: { wallId: 'w', t: 0.25, side: 'left', height: 0.3 },
    });
    expect(pos?.along).toBeCloseTo(1.0, 6);
    expect(pos?.off).toBeCloseTo(0.05, 6);
    expect(pos?.height).toBeCloseTo(0.3, 6);
    expect(pos?.at).toEqual({ x: 1, y: expect.closeTo(0.05, 6) });
  });

  it('defaultHeight: sockets 300, over a kitchen base run 1150, switches 1050, aircon top 2400', () => {
    let s = room(4, 3);
    const l = flat(s);
    expect(l.ceilingHeight).toBe(2.6);
    const id = wallAlong(l, [0, 0], [4, 0]);
    const w = l.walls[id];
    const inside = w && (l.vertices[w.a]?.x === 0 ? 'right' : 'left');
    // Inside the room (y > 0): which side that is depends on the wall's direction.
    const place = { wallId: id, along: 2, side: inside ?? 'left' } as const;
    const flip = pointPosition(l, {
      id: 'p',
      kind: 'socket-single',
      wall: { wallId: id, t: 0.5, side: place.side, height: 0 },
    });
    const side = (flip?.normal?.y ?? 0) > 0 ? place.side : place.side === 'left' ? 'right' : 'left';
    const p = { ...place, side } as const;
    expect(defaultHeight(l, 'socket-double', p)).toBeCloseTo(0.3);
    expect(defaultHeight(l, 'switch', p)).toBeCloseTo(1.05);
    expect(defaultHeight(l, 'aircon', p)).toBeCloseTo(2.4);
    const kind = furnitureKind('kitchen-base');
    if (!kind) throw new Error('no kitchen base');
    const it = newItem('it_k', kind, { x: 2, y: 0.05 + kind.size.d / 2 }, 0);
    s = dispatch(s, {
      label: 'add',
      recipe: (d) => {
        (d.levels[0] as Level).items[it.id] = it;
      },
    });
    expect(defaultHeight(flat(s), 'socket-double', p)).toBeCloseTo(1.15);
    expect(defaultHeight(flat(s), 'switch', p)).toBeCloseTo(1.05);
  });

  it('a socket tapped in a doorway goes beside the jamb; under a 1.0 m sill a socket stays, a switch moves', () => {
    let s = room(4, 3);
    const wid = wallAlong(flat(s), [0, 0], [4, 0]);
    const w = flat(s).walls[wid];
    const fromA = flat(s).vertices[w?.a ?? '']?.x === 0;
    // A 0.9 m door centred at x = 1 and a 1.2 m window (sill 1.0) centred at x = 3.
    const tAt = (x: number) => (fromA ? x / 4 : 1 - x / 4);
    s = dispatch(
      s,
      addOpening(LID, { wallId: wid, kind: 'door', t: tAt(1), width: 0.9, height: 2.1, sill: 0 })
        .command,
    );
    s = dispatch(
      s,
      addOpening(LID, { wallId: wid, kind: 'window', t: tAt(3), width: 1.2, height: 1.2, sill: 1 })
        .command,
    );
    const x = (p: ReturnType<typeof placePoint>) => p?.at.x ?? Number.NaN;
    // In the door, a little right of its centre: to the right jamb (1.45) + 50 mm + half plate.
    const sock = placePoint(flat(s), 'socket-double', { x: 1.1, y: 0.2 });
    expect(x(sock)).toBeCloseTo(1.45 + 0.05 + 0.073, 6);
    const left = placePoint(flat(s), 'socket-single', { x: 0.9, y: 0.2 });
    expect(x(left)).toBeCloseTo(0.55 - 0.05 - 0.043, 6);
    // Under the window: a socket stays; a switch (1050 mm) moves to the nearer jamb.
    expect(x(placePoint(flat(s), 'socket-single', { x: 3.1, y: 0.2 }))).toBeCloseTo(3.1, 6);
    const sw = placePoint(flat(s), 'switch', { x: 3.1, y: 0.2 });
    expect(x(sw)).toBeCloseTo(3.6 + 0.05 + 0.043, 6);
    // Too far from any wall face (over 0.3 m): nowhere.
    expect(placePoint(flat(s), 'socket-single', { x: 2, y: 1.5 })).toBeNull();
  });

  it('commands undo and redo; a deleted wall takes its points, one undo brings both back', () => {
    let s = room(4, 3);
    const r = tap(s, 'socket-double', 2, 0.2);
    s = r.s;
    expect(pt(flat(s), r.id).kind).toBe('socket-double');
    s = dispatch(s, updatePoint(LID, r.id, { kind: 'socket-single' }));
    expect(pt(flat(s), r.id).kind).toBe('socket-single');
    s = undo(s);
    expect(pt(flat(s), r.id).kind).toBe('socket-double');
    s = redo(s);
    expect(pt(flat(s), r.id).kind).toBe('socket-single');
    const wid = pt(flat(s), r.id).wall?.wallId as string;
    s = dispatch(s, deleteWall(LID, wid, flat(s)));
    expect(flat(s).walls[wid]).toBeUndefined();
    expect(flat(s).points[r.id]).toBeUndefined();
    s = undo(s);
    expect(flat(s).walls[wid]).toBeDefined();
    expect(flat(s).points[r.id]).toBeDefined();
    s = dispatch(s, deletePoint(LID, r.id, flat(s)));
    expect(flat(s).points[r.id]).toBeUndefined();
    // A gang only on a switch; a switch's gang to 3.
    const sw = tap(s, 'switch', 0.2, 1.5);
    s = dispatch(sw.s, updatePoint(LID, sw.id, { gang: 3 }));
    expect(pt(flat(s), sw.id).gang).toBe(3);
    expect(() => dispatch(s, updatePoint(LID, sw.id, { at: { x: 1, y: 1 } }))).toThrow();
  });

  it('points follow their wall: a split keeps them within 1 mm, a moved corner carries them', () => {
    let s = room(4, 3);
    const p1 = tap(s, 'socket-double', 0.8, 0.2);
    const p2 = tap(p1.s, 'switch', 3.2, 0.2);
    s = p2.s;
    const before = [p1.id, p2.id].map((id) => pointPosition(flat(s), pt(flat(s), id)));
    const wid = pt(flat(s), p1.id).wall?.wallId as string;
    s = dispatch(s, splitWall(LID, wid, { x: 2, y: 0 }, flat(s)).command);
    const after = [p1.id, p2.id].map((id) => pointPosition(flat(s), pt(flat(s), id)));
    expect(pt(flat(s), p1.id).wall?.wallId).not.toBe(pt(flat(s), p2.id).wall?.wallId);
    for (let i = 0; i < 2; i++) {
      const b = before[i];
      const a = after[i];
      expect(
        Math.hypot((a?.at.x ?? 0) - (b?.at.x ?? 9), (a?.at.y ?? 0) - (b?.at.y ?? 9)),
      ).toBeLessThan(0.001);
    }
    // A thicker wall: the point stays on its face.
    s = dispatch(s, updateWall(LID, pt(flat(s), p1.id).wall?.wallId as string, { thickness: 0.3 }));
    expect(Math.abs(pointPosition(flat(s), pt(flat(s), p1.id))?.at.y ?? 0)).toBeCloseTo(0.15, 6);
    // Made a boundary: no face to be on.
    s = dispatch(
      s,
      updateWall(LID, pt(flat(s), p1.id).wall?.wallId as string, { kind: 'boundary' }),
    );
    expect(flat(s).points[p1.id]).toBeUndefined();
  });

  it('trunkingLength: (0,0) → (3,0) → (3,2) is 5.00 m', () => {
    expect(
      trunkingLength([
        { x: 0, y: 0 },
        { x: 3, y: 0 },
        { x: 3, y: 2 },
      ]),
    ).toBeCloseTo(5, 9);
  });

  it('no renovation: three double sockets and a light are $240–450 and $50–100', () => {
    let s = room(4, 3);
    for (const x of [0.8, 2, 3.2]) s = tap(s, 'socket-double', x, 0.2).s;
    s = dispatch(s, addPoint(LID, { kind: 'light', at: { x: 2, y: 1.5 } }).command);
    const est = costEstimate(flat(s), undefined, {
      ...TYPICAL_RATES,
      painting: false,
      contingency: false,
    });
    const elec = est.lines.filter((l) => l.group === 'Electrical');
    const sockets = elec.find((l) => l.label === '13A double socket, new');
    expect(sockets).toMatchObject({ qty: 3, low: 240, high: 450 });
    expect(elec.find((l) => l.label === 'Light point, new')).toMatchObject({
      qty: 1,
      low: 50,
      high: 100,
    });
  });

  it('a renovation prices what changes: relocate, removal, nothing, a new kind, a hacked wall', () => {
    let s = room(4, 3, [[2, 0, 2, 3]]);
    const moved = tap(s, 'socket-double', 0.6, 0.2);
    const gone = tap(moved.s, 'socket-double', 0.2, 1.5);
    const same = tap(gone.s, 'switch', 3.8, 1.5);
    const kind = tap(same.s, 'socket-single', 3.0, 2.8);
    const hacked = tap(kind.s, 'tv', 2.2, 1.5);
    s = dispatch(hacked.s, startRenovation());
    const ra = reno(s);
    s = dispatch(s, updatePoint(A, moved.id, { wall: along(ra, moved.id, 1) }));
    s = dispatch(s, deletePoint(A, gone.id));
    s = dispatch(s, updatePoint(A, kind.id, { kind: 'socket-double' }));
    const part = wallAlong(reno(s), [2, 0], [2, 3]);
    s = dispatch(s, deleteWall(A, part, reno(s)));
    const ch = electricalChanges(flat(s), reno(s));
    expect(ch.status.get(moved.id)).toBe('moved');
    expect(ch.status.get(same.id)).toBeUndefined();
    expect(ch.status.get(kind.id)).toBe('new');
    expect(ch.removed.map((p) => p.id).sort()).toEqual([gone.id, hacked.id, kind.id].sort());
    const est = costEstimate(flat(s), reno(s), TYPICAL_RATES);
    const labels = est.lines.filter((l) => l.group === 'Electrical').map((l) => l.label);
    expect(labels).toContain('13A double socket, relocate');
    expect(labels).toContain('13A double socket, removal');
    expect(labels).toContain('13A double socket, new');
    expect(labels).toContain('TV point, removal');
    expect(labels).toContain('13A single socket, removal');
    expect(labels.some((l) => l.startsWith('1-gang switch'))).toBe(false);
  });

  it('an aircon unit with 5 m of trunking: $150–250 plus $150–250', () => {
    let s = room(4, 3);
    const ac = tap(s, 'aircon', 1, 0.2);
    s = ac.s;
    const start = pointPosition(flat(s), pt(flat(s), ac.id))?.at as { x: number; y: number };
    // To a compressor 5 m of trunking away: 2 m along, then 3 m across.
    const comp = addPoint(LID, { kind: 'compressor', at: { x: start.x + 2, y: start.y - 3 } });
    s = dispatch(s, comp.command);
    s = dispatch(
      s,
      updatePoint(LID, ac.id, {
        compressorId: comp.pointId,
        route: [{ x: start.x + 2, y: start.y }],
      }),
    );
    expect(trunkingMetres(flat(s), pt(flat(s), ac.id))).toBeCloseTo(5, 6);
    const lines = costEstimate(flat(s), undefined, TYPICAL_RATES).lines.filter(
      (l) => l.group === 'Electrical',
    );
    expect(lines.find((l) => l.label === 'Aircon point (isolator), new')).toMatchObject({
      low: 150,
      high: 250,
    });
    expect(lines.find((l) => l.label === 'Aircon trunking')).toMatchObject({
      qty: 5,
      low: 150,
      high: 250,
    });
    // The compressor comes with the aircon package.
    expect(lines.some((l) => /compressor/i.test(l.label))).toBe(false);
  });

  it('warns of a socket in a bathroom, the shelter wall, a structural wall and a lone aircon; counts match the lines', () => {
    let s = room(4, 3, [[2, 0, 2, 3]]);
    const room1 = Object.values(flat(s).rooms).find((r) =>
      r.loop.some((v) => flat(s).vertices[v]?.x === 0),
    );
    const room2 = Object.values(flat(s).rooms).find((r) => r.id !== room1?.id);
    if (!room1 || !room2) throw new Error('no rooms');
    s = dispatch(s, renameRoom(LID, room1.id, 'Bathroom'));
    s = dispatch(s, renameRoom(LID, room2.id, 'Household shelter'));
    const wet = tap(s, 'socket-double', 0.2, 1.5);
    const shelter = tap(wet.s, 'switch', 3.8, 1.5);
    s = shelter.s;
    const outer = wallAlong(flat(s), [0, 0], [0, 3]);
    s = dispatch(s, {
      label: 'mark',
      recipe: (d) => {
        const w = (d.levels[0] as Level).walls[outer];
        if (w) w.structural = true;
      },
    });
    const ac = tap(s, 'aircon', 0.2, 2.0);
    s = ac.s;
    const l = flat(s);
    expect(pointWarnings(l, pt(l, wet.id))).toEqual(['wet', 'structural']);
    expect(pointWarnings(l, pt(l, shelter.id))).toEqual(['shelter']);
    expect(pointWarnings(l, pt(l, ac.id))).toEqual(['structural', 'no-compressor']);
    s = dispatch(s, addPoint(LID, { kind: 'light', at: { x: 1, y: 1.5 } }).command);
    const counts = pointCounts(flat(s));
    const lines = costEstimate(flat(s), undefined, TYPICAL_RATES).lines.filter((l) => l.point);
    const fromLines: Record<string, number> = {};
    for (const x of lines)
      fromLines[x.point as string] = (fromLines[x.point as string] ?? 0) + x.qty;
    expect(fromLines).toEqual(counts);
    expect(counts).toEqual({ 'socket-double': 1, switch: 1, aircon: 1, light: 1 });
  });

  it('points carry to the renovation like the rest of the flat, and follow a moved corner', () => {
    let s = dispatch(room(4, 3), startRenovation());
    const r = addPoint(LID, { kind: 'light', at: { x: 2, y: 1.5 } });
    s = dispatch(s, carriedToRenovation(r.command));
    expect(reno(s).points[r.pointId]).toBeDefined();
    const sock = tap(s, 'socket-single', 2, 0.2);
    s = sock.s;
    const t = pt(flat(s), sock.id).wall?.t;
    const v = Object.values(flat(s).vertices).find((v) => v.x === 4 && v.y === 0);
    if (!v) throw new Error('no corner');
    s = dispatch(s, moveVertex(LID, v.id, { x: 5, y: 0 }));
    expect(pt(flat(s), sock.id).wall?.t).toBe(t);
    const doc: Project = s.doc;
    expect(doc.levels[0]?.points[sock.id]).toBeDefined();
  });
});
