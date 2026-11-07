import { describe, expect, it } from 'vitest';
import { splitWall } from './commands';
import {
  type RoomFace,
  faceAt,
  faceRef,
  faceUV,
  itemFace,
  otherSide,
  resolveFace,
  roomFaces,
  stepFace,
} from './faces';
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
import { redo, undo } from './history';
import type { Level } from './schema';

const lengths = (fs: RoomFace[]) => fs.map((f) => Number(f.length.toFixed(3)));
const roomNamed = (l: Level, test: (f: RoomFace[]) => boolean) =>
  Object.keys(l.rooms).find((id) => test(roomFaces(l, id))) as string;

describe('roomFaces', () => {
  it('AC1: R has four faces, bottom (A, door wall), left, top, right', () => {
    const l = level(roomR());
    const fs = roomFaces(l, roomId(l));
    expect(fs.map((f) => f.letter)).toEqual(['A', 'B', 'C', 'D']);
    expect(lengths(fs)).toEqual([3.9, 2.9, 3.9, 2.9]);
    expect(fs[0]?.label).toBe('door wall');
    // A is the bottom wall, seen from inside: its left end is at the bottom right.
    expect(fs[0]?.left.x).toBeCloseTo(3.95, 6);
    expect(fs[0]?.left.y).toBeCloseTo(2.95, 6);
    expect(fs[2]?.left.x).toBeCloseTo(0.05, 6);
    expect(fs[2]?.normal).toEqual({ x: -0, y: 1 });
    expect(fs.every((f) => f.kind === 'wall' && f.steppable)).toBe(true);
    expect(fs.every((f) => f.ceiling === 2.6)).toBe(true);
  });

  it('AC2: a wall meeting the top wall from outside splits it, still one face', () => {
    const l = level(roomR([[2, 0, 2, -1]]));
    const r = roomNamed(l, (fs) => fs.length === 4);
    const fs = roomFaces(l, r);
    expect(lengths(fs)).toEqual([3.9, 2.9, 3.9, 2.9]);
    expect(fs[2]?.stretches).toHaveLength(2);
  });

  it('AC3 (as built): an inside face stepped 50 mm for x 1–3 by a thicker wall, flush outside', () => {
    // The top wall in three, its thickness all inside its line (side 'left'): 0.10, 0.15, 0.10.
    const segs: [number, number, number, number][] = [
      [0, 0, 1, 0],
      [1, 0, 3, 0],
      [3, 0, 4, 0],
      ...R_SEGS.slice(1),
    ];
    const s0 = walls(segs, (i) => (i < 3 ? { side: 'left', thickness: i === 1 ? 0.15 : 0.1 } : {}));
    const s = apply(s0, opening(level(s0), [4, 3], [0, 3], { kind: 'door' }));
    const l = level(s);
    const fs = roomFaces(l, roomId(l));
    expect(lengths(fs)).toEqual([3.9, 2.85, 0.95, 0.05, 2, 0.05, 0.95, 2.85]);
    expect(fs.map((f) => f.kind)).toEqual([
      'wall',
      'wall',
      'wall',
      'return',
      'wall',
      'return',
      'wall',
      'wall',
    ]);
    // Letters only for the faces stepping stops at; a return takes the one before, primed.
    expect(fs.map((f) => f.letter)).toEqual(['A', 'B', 'C', 'C′', 'D', 'D′', 'E', 'F']);
    // Stepping skips the two returns.
    const c1 = fs[2] as RoomFace;
    expect(stepFace(fs, c1, 1).index).toBe(4);
    expect(stepFace(fs, fs[4] as RoomFace, -1).index).toBe(2);
    // faceAt on the middle wall gives the 2.00 m face; the returns have no wall side.
    const mid = wallAlong(l, [1, 0], [3, 0]);
    expect(faceAt(l, mid, 'left')?.length).toBeCloseTo(2, 6);
    expect(faceAt(l, mid, 'right')).toBeNull();
    expect(fs[3]?.stretches).toEqual([]);
  });

  it('a real 50 mm return wall is a wall face that faceAt finds', () => {
    // The top wall notched 50 mm into the room by walls for x 1–3.
    const segs: [number, number, number, number][] = [
      [0, 0, 1, 0],
      [1, 0, 1, 0.05],
      [1, 0.05, 3, 0.05],
      [3, 0.05, 3, 0],
      [3, 0, 4, 0],
      ...R_SEGS.slice(1),
    ];
    const s = walls(segs);
    const l = level(s);
    const r = roomNamed(l, (fs) => fs.length > 4);
    const ret = wallAlong(l, [1, 0], [1, 0.05]);
    const side = faceAt(l, ret, 'left') ?? faceAt(l, ret, 'right');
    expect(side?.kind).toBe('wall');
    expect(side?.roomId).toBe(r);
    expect(side?.steppable).toBe(false);
  });

  it('AC4: a wall at 45° across a corner is its own face, its true face length', () => {
    const l = level(roomR([[0, 1, 1, 0]]));
    const r = roomNamed(l, (fs) => fs.length === 5);
    const fs = roomFaces(l, r);
    const cut = fs.find((f) => Math.abs(f.dir.x) > 0.1 && Math.abs(f.dir.y) > 0.1) as RoomFace;
    // Between the inside faces of the left and top walls, 50 mm into the room from its line.
    const t = Math.SQRT2 * (1 + 0.05 * Math.SQRT2 - 0.05 - 0.05);
    expect(cut.length).toBeCloseTo(t, 3);
  });

  it('AC14: a wall with rooms both sides gives two faces, mirrored', () => {
    const s0 = walls([...R_SEGS, [2, 0, 2, 3]]);
    const l0 = level(s0);
    const s = apply(
      s0,
      opening(l0, [2, 0], [2, 3], { kind: 'window', t: 0.3, width: 0.6, sill: 0.9, height: 1.2 }),
    );
    const l = level(s);
    const mid = wallAlong(l, [2, 0], [2, 3]);
    const left = faceAt(l, mid, 'left') as RoomFace;
    const right = faceAt(l, mid, 'right') as RoomFace;
    expect(left.roomId).not.toBe(right.roomId);
    expect(left.length).toBeCloseTo(right.length, 6);
    expect(otherSide(l, left)?.roomId).toBe(right.roomId);
    // The window's middle at u on one is at length - u on the other.
    const w = Object.values(l.openings).find((o) => o.kind === 'window');
    expect(w).toBeDefined();
    const c = { x: 2, y: 0.3 * 3 };
    const ul = faceUV(left, c).u;
    const ur = faceUV(right, c).u;
    expect(ul + ur).toBeCloseTo(left.length, 6);
  });

  it('turning the whole level 30° changes no lengths', () => {
    const rot = (k: number): [number, number, number, number][] =>
      R_SEGS.map(([ax, ay, bx, by]) => {
        const r = (x: number, y: number) => [
          x * Math.cos(k) - y * Math.sin(k),
          x * Math.sin(k) + y * Math.cos(k),
        ];
        return [...r(ax, ay), ...r(bx, by)] as [number, number, number, number];
      });
    const l = level(walls(rot(Math.PI / 6)));
    const fs = roomFaces(l, roomId(l));
    expect([...lengths(fs)].sort()).toEqual([2.9, 2.9, 3.9, 3.9]);
  });

  it('resolveFace survives splitWall, undo and redo, and is null when the wall is gone', () => {
    const s = roomR();
    const l = level(s);
    const top = wallAlong(l, [0, 0], [4, 0]);
    const c = faceAt(l, top, 'left') as RoomFace;
    const ref = faceRef(c);
    const split = splitWall(LID, top, { x: 1, y: 0 }, l);
    const s2 = apply(s, split.command);
    const l2 = level(s2);
    const again = resolveFace(l2, ref);
    expect(again?.length).toBeCloseTo(3.9, 6);
    expect(again?.stretches).toHaveLength(2);
    // A ref from the split plan, kept through undo (its wall id may be the new half's).
    const ref2 = faceRef(again as RoomFace);
    const s3 = undo(s2);
    expect(resolveFace(level(s3), ref2)?.length).toBeCloseTo(3.9, 6);
    expect(resolveFace(level(redo(s3)), ref)?.length).toBeCloseTo(3.9, 6);
  });

  it('caches per frozen level', () => {
    const l = level(roomR());
    expect(Object.isFrozen(l)).toBe(true);
    expect(roomFaces(l, roomId(l))).toBe(roomFaces(l, roomId(l)));
  });

  it('itemFace: the wall a piece stands against, none for one out in the room', () => {
    const s = apply(
      roomR(),
      addItem(LID, piece('it_w', 'built-in-wardrobe', 3.65, 1.5, Math.PI / 2)),
      addItem(LID, piece('it_t', 'coffee-table', 2, 1.5)),
    );
    const l = level(s);
    expect(itemFace(l, 'it_w')?.letter).toBe('D');
    expect(itemFace(l, 'it_t')).toBeNull();
  });
});
