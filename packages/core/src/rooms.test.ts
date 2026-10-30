import { produceWithPatches } from 'immer';
import { describe, expect, it } from 'vitest';
import { deleteWall, drawWall, splitWall, updateRoom } from './commands';
import { blankProject, emptyLevel } from './factory';
import { hdb4RoomLevel, hdb4RoomProject } from './fixtures/hdb4room';
import { type EditorDoc, dispatch, emptyHistory, undo } from './history';
import { detectFaces, roomArea, roomShape, syncRooms } from './rooms';
import { Project } from './schema';

const L = 'lvl_ground';
const fresh = (): EditorDoc => ({ doc: hdb4RoomProject(), history: emptyHistory() });
const lvl = (s: EditorDoc) => s.doc.levels[0]!;
const totalArea = (s: EditorDoc) =>
  Object.values(lvl(s).rooms).reduce((sum, r) => sum + roomArea(lvl(s), r), 0);
const names = (s: EditorDoc) =>
  Object.values(lvl(s).rooms)
    .map((r) => r.name)
    .sort();

describe('detectFaces', () => {
  it('finds exactly the five rooms of the reference plan', () => {
    const l = hdb4RoomLevel();
    const faces = detectFaces(l);
    expect(faces).toHaveLength(5);
    const keys = faces.map((f) => [...f].sort().join());
    for (const room of Object.values(l.rooms)) {
      expect(keys, room.name).toContain([...room.loop].sort().join());
    }
  });

  it('ignores dead-end walls and open polylines', () => {
    const l = emptyLevel();
    for (const [id, x, y] of [
      ['a', 0, 0],
      ['b', 3, 0],
      ['c', 3, 3],
    ] as const) {
      l.vertices[id] = { id, x, y };
    }
    l.walls.ab = {
      id: 'ab',
      a: 'a',
      b: 'b',
      thickness: 0.1,
      materialLeft: 'x',
      materialRight: 'x',
    };
    l.walls.bc = {
      id: 'bc',
      a: 'b',
      b: 'c',
      thickness: 0.1,
      materialLeft: 'x',
      materialRight: 'x',
    };
    expect(detectFaces(l)).toEqual([]);
  });
});

describe('syncRooms', () => {
  it('leaves an already consistent plan untouched', () => {
    const [, patches] = produceWithPatches(hdb4RoomProject(), (d) => {
      syncRooms(d.levels[0]!);
    });
    expect(patches).toEqual([]);
  });
});

describe('drawWall', () => {
  it('drawing across a room splits it; the room keeps its name in one half', () => {
    const s0 = fresh();
    const l0 = lvl(s0);
    // From the front wall at x = 2.5 down to the Living/Bed 3 wall at x = 2.5.
    const r = drawWall(
      l0,
      { point: { x: 2.5, y: 0 }, wallId: 'w_front_l' },
      { point: { x: 2.5, y: 4.5 }, wallId: 'w_mid_1' },
    );
    const s = dispatch(s0, r.command);
    expect(Object.keys(lvl(s).rooms)).toHaveLength(6);
    expect(names(s)).toContain('Living');
    expect(names(s)).toContain('Room 1');
    expect(totalArea(s)).toBeCloseTo(93.5, 9);
    // The main door (t = 0.25 on the 5 m front wall, centre at 1.25 m) stays on the left part.
    const door = lvl(s).openings.op_main!;
    expect(door.wallId).toBe('w_front_l');
    expect(door.t).toBeCloseTo(0.5);
    expect(() => Project.parse(s.doc)).not.toThrow();
    expect(undo(s).doc).toEqual(s0.doc);
  });

  it('a wall crossing the flat splits every wall it crosses and chains through them', () => {
    const s0 = fresh();
    const r = drawWall(lvl(s0), { point: { x: -1, y: 2 } }, { point: { x: 12, y: 2 } });
    const s = dispatch(s0, r.command);
    // crosses the left wall, the living/kitchen wall and the right wall
    expect(r.wallIds).toHaveLength(4);
    for (const id of r.wallIds) expect(lvl(s).walls[id]).toBeDefined();
    expect(Object.keys(lvl(s).rooms)).toHaveLength(7);
    expect(names(s)).toEqual(
      ['Bedroom 2', 'Bedroom 3', 'Kitchen', 'Living', 'Master bedroom', 'Room 1', 'Room 2'].sort(),
    );
    expect(totalArea(s)).toBeCloseTo(93.5, 9);
  });

  it('starting and ending on the same wall splits it twice correctly', () => {
    const s0 = fresh();
    // A bay out from the back wall: two points on w_back_m (v5 (7,8.5) -> v6 (3.5,8.5)).
    const r = drawWall(
      lvl(s0),
      { point: { x: 4, y: 8.5 }, wallId: 'w_back_m' },
      { point: { x: 6, y: 8.5 }, wallId: 'w_back_m' },
    );
    const s = dispatch(s0, r.command);
    // the new wall overlaps the existing middle part, which already exists, so nothing is added
    expect(Object.values(lvl(s).walls).filter((w) => w.thickness === 0.2)).toHaveLength(11);
    expect(totalArea(s)).toBeCloseTo(93.5, 9);
  });

  it('a free end that lands exactly on a wall or corner connects to it', () => {
    const s0 = fresh();
    // No wallId given (as with a typed length), but both ends sit on existing walls.
    const r = drawWall(lvl(s0), { point: { x: 2.5, y: 0 } }, { point: { x: 2.5, y: 4.5 } });
    const s = dispatch(s0, r.command);
    expect(Object.keys(lvl(s).rooms)).toHaveLength(6);
    const r2 = drawWall(lvl(s0), { point: { x: 5, y: 0 } }, { point: { x: 5, y: -2 } });
    expect(r2.startVertexId).toBe('v1');
  });

  it('rejects a wall shorter than 1 cm', () => {
    expect(() =>
      drawWall(lvl(fresh()), { vertexId: 'v0' }, { point: { x: 0.001, y: 0 } }),
    ).toThrow();
  });

  it('builds rooms from scratch as a rectangle is drawn', () => {
    let s: EditorDoc = {
      doc: { ...hdb4RoomProject(), levels: [emptyLevel()] },
      history: emptyHistory(),
    };
    const pts = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 3 },
      { x: 0, y: 3 },
    ];
    let prev: { vertexId: string } | { point: { x: number; y: number } } = { point: pts[0]! };
    for (let i = 1; i <= 4; i++) {
      const target =
        i === 4 ? { vertexId: Object.values(lvl(s).vertices)[0]!.id } : { point: pts[i]! };
      const r = drawWall(lvl(s), prev, target);
      s = dispatch(s, r.command);
      prev = { vertexId: r.endVertexId };
      expect(Object.keys(lvl(s).rooms)).toHaveLength(i === 4 ? 1 : 0);
    }
    expect(names(s)).toEqual(['Room 1']);
    expect(totalArea(s)).toBeCloseTo(12, 9);
  });
});

describe('splitWall and deleteWall keep rooms consistent', () => {
  it('splitting a wall keeps every room and its area', () => {
    const s0 = fresh();
    const s = dispatch(s0, splitWall(L, 'w_mid_3', { x: 6, y: 4.6 }).command);
    expect(names(s)).toEqual(names(s0));
    expect(totalArea(s)).toBeCloseTo(93.5, 9);
    expect(lvl(s).openings.op_master?.wallId).toBeDefined();
  });

  it('deleting the wall between two bedrooms merges them under the larger name', () => {
    const s = dispatch(fresh(), deleteWall(L, 'w_bed2_master'));
    expect(names(s)).toEqual(['Bedroom 3', 'Kitchen', 'Living', 'Master bedroom'].sort());
    expect(totalArea(s)).toBeCloseTo(93.5, 9);
  });
});

describe('rooms inside rooms', () => {
  const rect = (s: EditorDoc, x0: number, y0: number, x1: number, y1: number): EditorDoc => {
    const corners = [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
    let out = s;
    for (let i = 0; i < 4; i++) {
      const a = corners[i]!;
      const b = corners[(i + 1) % 4]!;
      out = dispatch(out, drawWall(lvl(out), { point: a }, { point: b }).command);
    }
    return out;
  };
  const start = (): EditorDoc => {
    let s: EditorDoc = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
    s = rect(s, 0, 0, 6, 6);
    const id = Object.keys(lvl(s).rooms)[0]!;
    return dispatch(s, updateRoom(L, id, { name: 'Living' }));
  };
  const byName = (s: EditorDoc, name: string) =>
    Object.values(lvl(s).rooms).find((r) => r.name === name)!;

  it('subtracts a free-standing enclosure from the room around it', () => {
    const s = rect(start(), 2.5, 2.5, 3.5, 3.5);
    expect(Object.keys(lvl(s).rooms)).toHaveLength(2);
    const living = byName(s, 'Living');
    expect(roomArea(lvl(s), living)).toBeCloseTo(35);
    expect(roomShape(lvl(s), living).holes).toHaveLength(1);
    expect(totalArea(s)).toBeCloseTo(36);
  });

  it('keeps the outer name when the enclosure covers its centre', () => {
    const s = rect(start(), 2, 2, 4, 4);
    expect(byName(s, 'Living')).toBeDefined();
    expect(roomArea(lvl(s), byName(s, 'Living'))).toBeCloseTo(32);
  });

  it('keeps the outer name when the enclosure edge lies on the label search grid', () => {
    // 6 m / 20 steps puts grid lines at 1.8 and 4.2, exactly on this box's edges.
    const s = rect(start(), 1.8, 1.8, 4.2, 4.2);
    expect(roomArea(lvl(s), byName(s, 'Living'))).toBeCloseTo(36 - 2.4 * 2.4);
  });

  it('treats a small free-standing column as a hole', () => {
    const s = rect(start(), 2.85, 2.85, 3.15, 3.15);
    expect(roomArea(lvl(s), byName(s, 'Living'))).toBeCloseTo(36 - 0.09);
  });

  it('gives the area back when the enclosure opens up', () => {
    let s = rect(start(), 2.5, 2.5, 3.5, 3.5);
    const inner = Object.values(lvl(s).rooms).find((r) => r.name !== 'Living')!;
    const wall = Object.values(lvl(s).walls).find(
      (w) => inner.loop.includes(w.a) && inner.loop.includes(w.b),
    )!;
    s = dispatch(s, deleteWall(L, wall.id));
    expect(Object.keys(lvl(s).rooms)).toHaveLength(1);
    expect(roomArea(lvl(s), byName(s, 'Living'))).toBeCloseTo(36);
  });

  it('nests: an enclosure inside the inner room is its hole, not the outer one', () => {
    let s = rect(start(), 1, 1, 5, 5);
    s = rect(s, 2.5, 2.5, 3.5, 3.5);
    const areas = Object.values(lvl(s).rooms)
      .map((r) => roomArea(lvl(s), r))
      .sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(1);
    expect(areas[1]).toBeCloseTo(15);
    expect(areas[2]).toBeCloseTo(20);
  });
});
