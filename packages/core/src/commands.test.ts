import { describe, expect, it } from 'vitest';
import {
  deleteOpening,
  deleteVertex,
  setCeilingHeight,
  setWallLength,
  updateOpening,
  updateRoom,
  updateWall,
} from './commands';
import { hdb4RoomProject } from './fixtures/hdb4room';
import { clampOpeningT, roomArea, wallLine } from './geometry';
import { type EditorDoc, dispatch, emptyHistory, undo } from './history';
import { Project } from './schema';

const L = 'lvl_ground';
const fresh = (): EditorDoc => ({ doc: hdb4RoomProject(), history: emptyHistory() });
const lvl = (s: EditorDoc) => s.doc.levels[0]!;

describe('updateWall', () => {
  it('changes only the given fields and undoes cleanly', () => {
    const s0 = fresh();
    const s1 = dispatch(s0, updateWall(L, 'w_mid_1', { thickness: 0.15, height: 2.4 }));
    expect(lvl(s1).walls.w_mid_1).toMatchObject({ thickness: 0.15, height: 2.4, a: 'v8' });
    expect(lvl(s1).walls.w_mid_1?.materialLeft).toBe('paint-white');
    expect(undo(s1).doc).toEqual(s0.doc);
  });

  it('height: undefined resets to the level ceiling height', () => {
    let s = dispatch(fresh(), updateWall(L, 'w_mid_1', { height: 2.4 }));
    s = dispatch(s, updateWall(L, 'w_mid_1', { height: undefined }));
    expect(lvl(s).walls.w_mid_1).not.toHaveProperty('height');
    expect(() => Project.parse(s.doc)).not.toThrow();
  });

  it('rejects invalid values before touching the document', () => {
    expect(() => updateWall(L, 'w_mid_1', { thickness: 0 })).toThrow();
    expect(() => updateWall(L, 'w_mid_1', { thickness: -1 })).toThrow();
  });
});

describe('setWallLength', () => {
  it('end mode moves only vertex b along the wall', () => {
    const s = dispatch(fresh(), setWallLength(L, 'w_mid_3', 3, 'end')); // v9 (5,4.5) -> v10 (7,4.5)
    expect(lvl(s).vertices.v10).toMatchObject({ x: 8, y: 4.5 });
    expect(wallLine(lvl(s), lvl(s).walls.w_mid_3!).length).toBeCloseTo(3);
  });

  it('push mode slides the far wall so square corners stay square', () => {
    // Master bedroom's top wall v10 (7,4.5) -> v3 (11,4.5): 4 m -> 3.5 m.
    const s = dispatch(fresh(), setWallLength(L, 'w_mid_4', 3.5));
    const l = lvl(s);
    expect(l.vertices.v3).toMatchObject({ x: 10.5, y: 4.5 });
    expect(l.vertices.v2).toMatchObject({ x: 10.5, y: 0 }); // up the right wall
    expect(l.vertices.v4).toMatchObject({ x: 10.5, y: 8.5 }); // down the right wall
    for (const w of Object.values(l.walls)) {
      const a = l.vertices[w.a]!;
      const b = l.vertices[w.b]!;
      expect(a.x === b.x || a.y === b.y, w.id).toBe(true);
    }
    expect(roomArea(l, l.rooms.rm_master!)).toBeCloseTo(14);
  });
});

describe('updateRoom', () => {
  it('renames and changes the floor; rejects an empty name', () => {
    const s = dispatch(
      fresh(),
      updateRoom(L, 'rm_bed3', { name: 'Study', floorMaterial: 'tile-grey' }),
    );
    expect(lvl(s).rooms.rm_bed3).toMatchObject({ name: 'Study', floorMaterial: 'tile-grey' });
    expect(() => updateRoom(L, 'rm_bed3', { name: '  ' })).toThrow();
  });
});

describe('updateOpening', () => {
  it('clamps t so the opening stays on the wall', () => {
    // w_mid_4 is 4 m long; a 0.9 m door can centre no closer than 0.45 m to an end.
    const s = dispatch(fresh(), updateOpening(L, 'op_master', { t: 0.99 }));
    expect(lvl(s).openings.op_master?.t).toBeCloseTo(1 - 0.45 / 4);
  });

  it('switching a door to a window drops the swing; back to a door restores one', () => {
    let s = dispatch(fresh(), updateOpening(L, 'op_bed2', { kind: 'window', sill: 0.9 }));
    expect(lvl(s).openings.op_bed2).not.toHaveProperty('swing');
    expect(lvl(s).openings.op_bed2?.sill).toBe(0.9);
    s = dispatch(s, updateOpening(L, 'op_bed2', { kind: 'door' }));
    expect(lvl(s).openings.op_bed2).toMatchObject({ swing: 'leftIn', sill: 0 });
    expect(() => Project.parse(s.doc)).not.toThrow();
  });
});

describe('deleteOpening and setCeilingHeight', () => {
  it('delete removes the opening; ceiling height applies to the level', () => {
    let s = dispatch(fresh(), deleteOpening(L, 'op_main'));
    expect(lvl(s).openings.op_main).toBeUndefined();
    s = dispatch(s, setCeilingHeight(L, 2.8));
    expect(lvl(s).ceilingHeight).toBe(2.8);
    expect(() => setCeilingHeight(L, 0)).toThrow();
  });
});

describe('clampOpeningT', () => {
  it('centres an opening wider than the wall and clamps both ends', () => {
    expect(clampOpeningT(1, 2, 0.1)).toBe(0.5);
    expect(clampOpeningT(4, 1, 0)).toBeCloseTo(0.125);
    expect(clampOpeningT(4, 1, 1)).toBeCloseTo(0.875);
    expect(clampOpeningT(4, 1, 0.5)).toBe(0.5);
  });
});

describe('deleteVertex', () => {
  it('removes every wall at the corner and the rooms that used it, as one step', () => {
    const s0 = fresh();
    const s = dispatch(s0, deleteVertex(L, 'v10')); // Bed 2 / Master / Kitchen corner
    const l = lvl(s);
    expect(l.vertices.v10).toBeUndefined();
    for (const w of Object.values(l.walls)) expect([w.a, w.b]).not.toContain('v10');
    expect(l.rooms.rm_master).toBeUndefined();
    expect(l.openings.op_master).toBeUndefined(); // it sat on w_mid_4 (v10 -> v3)
    expect(s.history.past).toHaveLength(1);
    expect(undo(s).doc).toEqual(s0.doc);
  });
});
