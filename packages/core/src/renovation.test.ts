import { describe, expect, it } from 'vitest';
import {
  addOpening,
  deleteOpening,
  deleteWall,
  drawWall,
  moveVertex,
  restoreVersion,
  splitWall,
  updateOpening,
  updateRoom,
  updateWall,
} from './commands';
import { finish } from './finishes';
import { hdb4RoomProject } from './fixtures/hdb4room';
import { type EditorDoc, dispatch, emptyHistory, undo } from './history';
import { AFTER_SUFFIX, findLevel, touchedVariant, variantLevels } from './levels';
import { loadProject } from './migrate';
import {
  carriedToRenovation,
  endRenovation,
  renovationChanges,
  renovationDiff,
  startRenovation,
} from './renovation';
import { Project } from './schema';

const L = 'lvl_ground';
const A = `${L}${AFTER_SUFFIX}`;

function renovating(): EditorDoc {
  return dispatch({ doc: hdb4RoomProject(), history: emptyHistory() }, startRenovation());
}

const diffOf = (s: EditorDoc) => {
  const before = s.doc.levels[0];
  const after = s.doc.renovation?.levels[0];
  if (!before || !after) throw new Error('no renovation');
  return renovationDiff(before, after);
};

describe('startRenovation and endRenovation', () => {
  it('copies the plan with the same element ids, and undoes', () => {
    const s = renovating();
    const after = s.doc.renovation?.levels[0];
    expect(after?.id).toBe(A);
    expect(Object.keys(after?.walls ?? {})).toEqual(Object.keys(s.doc.levels[0]?.walls ?? {}));
    expect(Project.parse(s.doc).renovation?.levels).toHaveLength(1);
    expect(variantLevels(s.doc, 'after')[0]?.id).toBe(A);
    expect(variantLevels(s.doc, 'before')[0]?.id).toBe(L);
    expect(undo(s).doc.renovation).toBeUndefined();
    expect(() => dispatch(s, startRenovation())).toThrow();
  });

  it('edits each version on its own: the after level is found by its id', () => {
    let s = renovating();
    s = dispatch(s, deleteWall(A, 'w_living_kitchen'));
    expect(findLevel(s.doc, A)?.walls.w_living_kitchen).toBeUndefined();
    expect(findLevel(s.doc, L)?.walls.w_living_kitchen).toBeDefined();
  });

  it('can be discarded, or made the plan once the work is done', () => {
    let s = renovating();
    s = dispatch(s, deleteWall(A, 'w_living_kitchen'));
    const discarded = dispatch(s, endRenovation('before'));
    expect(discarded.doc.renovation).toBeUndefined();
    expect(discarded.doc.levels[0]?.walls.w_living_kitchen).toBeDefined();
    const adopted = dispatch(s, endRenovation('after'));
    expect(adopted.doc.renovation).toBeUndefined();
    expect(adopted.doc.levels[0]?.id).toBe(L);
    expect(adopted.doc.levels[0]?.walls.w_living_kitchen).toBeUndefined();
    expect(undo(adopted).doc.renovation?.levels[0]?.id).toBe(A);
  });

  it('survives a save and load, and repairs both versions', () => {
    const s = renovating();
    const { project } = loadProject(JSON.parse(JSON.stringify(s.doc)));
    expect(project.renovation?.levels[0]?.id).toBe(A);
  });

  it('gives a renovation level that shares the plan’s id its own on load', () => {
    const doc = JSON.parse(JSON.stringify(renovating().doc));
    doc.renovation.levels[0].id = L;
    const { project, fixes } = loadProject(doc);
    expect(project.renovation?.levels[0]?.id).toBe(A);
    expect(fixes.some((f) => f.includes('renamed'))).toBe(true);
  });
});

describe('touchedVariant', () => {
  it('names the version an undo step changes', () => {
    let s = renovating();
    expect(touchedVariant(s.history.past.at(-1)?.inverse ?? [])).toBe('after');
    s = dispatch(s, deleteWall(A, 'w_living_kitchen'));
    expect(touchedVariant(s.history.past.at(-1)?.inverse ?? [])).toBe('after');
    s = dispatch(s, deleteWall(L, 'w_bed3_bed2'));
    expect(touchedVariant(s.history.past.at(-1)?.inverse ?? [])).toBe('before');
    expect(touchedVariant([{ op: 'replace', path: ['name'], value: 'x' }])).toBeNull();
  });
});

describe('renovationDiff', () => {
  it('finds nothing in an untouched copy', () => {
    const d = diffOf(renovating());
    expect(d.demolished).toEqual([]);
    expect(d.built).toEqual([]);
    expect(d.areaAfter).toBeCloseTo(d.areaBefore);
  });

  it('counts a wall taken out as hacked, with its outline, and the rooms merging', () => {
    const s = dispatch(renovating(), deleteWall(A, 'w_living_kitchen'));
    const d = diffOf(s);
    // 4.5 m of wall line, less the 1.6 m passage in it that was never wall.
    expect(d.demolishedLength).toBeCloseTo(2.9);
    expect(d.openingsRemoved).toEqual(['op_kitchen']);
    expect(d.builtLength).toBe(0);
    expect(d.demolished.every((x) => x.polygon.length === 4)).toBe(true);
    // The kitchen joins the living room: one room fewer. Areas run to wall lines, as HDB
    // measures them, so the total stays the same.
    expect(Object.keys(s.doc.renovation?.levels[0]?.rooms ?? {}).length).toBeLessThan(
      Object.keys(s.doc.levels[0]?.rooms ?? {}).length,
    );
    expect(d.areaAfter).toBeCloseTo(d.areaBefore);
  });

  it('sees a wall split in the same place as unchanged', () => {
    const before = renovating();
    const split = splitWall(A, 'w_front_r', { x: 8, y: 0 }, before.doc.renovation?.levels[0]);
    const d = diffOf(dispatch(before, split.command));
    expect(d.demolishedLength).toBe(0);
    expect(d.builtLength).toBe(0);
  });

  it('counts a wall cut down to half height, and a door widened or moved', () => {
    const low = diffOf(dispatch(renovating(), updateWall(A, 'w_bed3_bed2', { height: 1 })));
    expect(low.demolishedLength).toBeCloseTo(4);
    const wide = diffOf(dispatch(renovating(), updateOpening(A, 'op_bed2', { width: 1.2 })));
    expect(wide.openingsAdded).toEqual(['op_bed2']);
    expect(wide.openingsRemoved).toEqual(['op_bed2']);
    const moved = diffOf(dispatch(renovating(), updateOpening(A, 'op_bed2', { t: 0.3 })));
    expect(moved.openingsAdded).toEqual(['op_bed2']);
  });

  it('counts a moved wall as hacked and rebuilt, and a thicker one too', () => {
    // Moving corner v10 east moves the partition between bedroom 2 and the master.
    const moved = diffOf(dispatch(renovating(), moveVertex(A, 'v10', { x: 7.6, y: 4.5 })));
    expect(moved.demolishedLength).toBeGreaterThan(3.9);
    expect(moved.builtLength).toBeGreaterThan(3.9);
    const thick = diffOf(dispatch(renovating(), updateWall(A, 'w_bed3_bed2', { thickness: 0.2 })));
    expect(thick.demolishedLength).toBeCloseTo(4);
    expect(thick.builtLength).toBeCloseTo(4);
  });
});

const changesOf = (s: EditorDoc) => {
  const before = s.doc.levels[0];
  const after = s.doc.renovation?.levels[0];
  if (!before || !after) throw new Error('no renovation');
  return renovationChanges(before, after);
};

describe('renovationChanges', () => {
  it('lists nothing for an untouched copy', () => {
    expect(changesOf(renovating())).toEqual([]);
  });

  it('places a wall taken out between the rooms it divided, with its doorway and the merge', () => {
    const changes = changesOf(dispatch(renovating(), deleteWall(A, 'w_living_kitchen')));
    const between = changes.filter((c) => c.rooms.join() === 'Kitchen,Living');
    expect(between.map((c) => c.kind)).toEqual(['hack', 'opening']);
    expect(between[0]).toMatchObject({ kind: 'hack', outside: false });
    expect(between[0]?.kind === 'hack' && between[0].length).toBeCloseTo(2.9);
    // Its doorway went with it: not something to close up.
    expect(between[1]).toMatchObject({ kind: 'opening', change: 'with-wall' });
    // One of the two rooms is gone and the other grew into it.
    expect(changes.filter((c) => c.kind === 'room' && c.change === 'removed')).toHaveLength(1);
    expect(changes.filter((c) => c.kind === 'area')).toHaveLength(1);
  });

  it('places doors and windows by the rooms either side, outside included', () => {
    let s = dispatch(renovating(), updateOpening(A, 'op_bed2', { width: 1.2 }));
    s = dispatch(s, deleteOpening(A, 'op_win_bed3'));
    const changes = changesOf(s);
    expect(changes).toContainEqual({
      rooms: ['Bedroom 2', 'Living'],
      outside: false,
      kind: 'opening',
      change: 'changed',
      opening: 'door',
      width: 1.2,
      before: { width: s.doc.levels[0]?.openings.op_bed2?.width },
      height: s.doc.levels[0]?.openings.op_bed2?.height,
      sill: 0,
      moved: false,
    });
    expect(changes).toContainEqual({
      rooms: ['Bedroom 3'],
      outside: true,
      kind: 'opening',
      change: 'removed',
      opening: 'window',
      width: 1.4,
    });
  });

  it('lists a floor refinished, by the finishes’ names, and orders changes by place', () => {
    let s = dispatch(renovating(), updateRoom(A, 'rm_kitchen', { floorMaterial: 'wood-oak' }));
    s = dispatch(s, updateWall(A, 'w_bed3_bed2', { height: 1 }));
    const changes = changesOf(s);
    // The wall cut down is hacked, and built again lower.
    expect(changes.map((c) => [c.rooms.join(', '), c.kind])).toEqual([
      ['Bedroom 2, Bedroom 3', 'hack'],
      ['Bedroom 2, Bedroom 3', 'build'],
      ['Kitchen', 'floor'],
    ]);
    expect(changes[2]).toEqual({
      rooms: ['Kitchen'],
      outside: false,
      kind: 'floor',
      from: finish('tile-grey')?.name,
      to: finish('wood-oak')?.name,
    });
  });

  it('matches rooms by where they are: a wall hacked and drawn again changes no room', () => {
    let s = dispatch(renovating(), deleteWall(A, 'w_bed3_bed2'));
    const l = s.doc.renovation?.levels[0];
    if (!l) throw new Error('no renovation');
    s = dispatch(
      s,
      drawWall(l, { vertexId: 'v11' }, { vertexId: 'v6' }, { thickness: 0.1 }).command,
    );
    const changes = changesOf(s);
    expect(changes.filter((c) => c.kind === 'room' || c.kind === 'area')).toEqual([]);
  });

  it('lists a room renamed, and names the room as renamed wherever it is', () => {
    let s = dispatch(renovating(), updateRoom(A, 'rm_bed2', { name: 'Study' }));
    s = dispatch(s, updateOpening(A, 'op_bed2', { height: 2.4 }));
    const changes = changesOf(s);
    expect(changes).toContainEqual({
      rooms: ['Study'],
      outside: false,
      kind: 'rename',
      from: 'Bedroom 2',
    });
    // The door changed in height only: not "moved".
    expect(changes).toContainEqual(
      expect.objectContaining({ rooms: ['Living', 'Study'], kind: 'opening', moved: false }),
    );
  });
});

describe('carriedToRenovation', () => {
  it('carries a fix to the flat as it is over to the renovation: no false change', () => {
    let s = renovating();
    s = dispatch(s, carriedToRenovation(moveVertex(L, 'v10', { x: 7.2, y: 4.5 })));
    expect(s.doc.renovation?.levels[0]?.vertices.v10).toMatchObject({ x: 7.2, y: 4.5 });
    expect(diffOf(s).demolished).toEqual([]);
    expect(diffOf(s).built).toEqual([]);
    // A wall found and drawn in the flat as it is appears in the renovation too.
    const l = s.doc.levels[0];
    if (!l) throw new Error('no level');
    s = dispatch(
      s,
      carriedToRenovation(
        drawWall(l, { point: { x: 1, y: 1 } }, { point: { x: 2, y: 1 } }, { thickness: 0.1 })
          .command,
      ),
    );
    expect(Object.keys(s.doc.renovation?.levels[0]?.walls ?? {})).toEqual(
      Object.keys(s.doc.levels[0]?.walls ?? {}),
    );
    expect(changesOf(s)).toEqual([]);
  });

  it('leaves what the renovation changed itself, and undoes in one step, on the flat as it is', () => {
    let s = dispatch(renovating(), updateWall(A, 'w_bed3_bed2', { height: 1 }));
    s = dispatch(s, carriedToRenovation(updateWall(L, 'w_bed3_bed2', { thickness: 0.2 })));
    // Field by field: the fix's thickness goes over, the renovation keeps its height.
    expect(s.doc.renovation?.levels[0]?.walls.w_bed3_bed2).toMatchObject({
      height: 1,
      thickness: 0.2,
    });
    // A wall taken out of the flat as it is goes from the renovation too, where it was kept.
    s = dispatch(s, carriedToRenovation(deleteWall(L, 'w_bed2_master')));
    expect(s.doc.renovation?.levels[0]?.walls.w_bed2_master).toBeUndefined();
    expect(touchedVariant(s.history.past.at(-1)?.inverse ?? [])).toBe('before');
    const back = undo(s);
    expect(back.doc.renovation?.levels[0]?.walls.w_bed2_master).toBeDefined();
    expect(back.doc.levels[0]?.walls.w_bed2_master).toBeDefined();
  });

  const wallAt = (s: EditorDoc, from: { x: number; y: number }, to: { x: number; y: number }) => {
    const l = s.doc.levels[0];
    if (!l) throw new Error('no level');
    return drawWall(l, { point: from }, { point: to }, { thickness: 0.1 }).command;
  };

  it('splits a wall the renovation repainted, keeping its paint; both changing a field holds it back', () => {
    // The renovation paints the living room's partition; the flat as it is gets a wall
    // meeting it in a T (splitting it): carried, the paint kept.
    let s = dispatch(renovating(), updateWall(A, 'w_mid_2', { materialLeft: 'paint-sage' }));
    const outcome = {};
    s = dispatch(
      s,
      carriedToRenovation(wallAt(s, { x: 3.65, y: 4.5 }, { x: 3.65, y: 2 }), outcome),
    );
    expect(outcome).toMatchObject({ carried: true, conflict: false });
    const after = s.doc.renovation?.levels[0];
    expect(after?.walls.w_mid_2?.materialLeft).toBe('paint-sage');
    expect(Object.keys(after?.walls ?? {}).sort()).toEqual(
      Object.keys(s.doc.levels[0]?.walls ?? {}).sort(),
    );
    expect(changesOf(s).filter((c) => c.kind !== 'build' && c.kind !== 'hack')).toEqual([]);
    // Both versions give the same wall a different thickness: not carried.
    s = dispatch(renovating(), updateWall(A, 'w_mid_2', { thickness: 0.2 }));
    s = dispatch(s, carriedToRenovation(updateWall(L, 'w_mid_2', { thickness: 0.15 }), outcome));
    expect(outcome).toMatchObject({ conflict: true });
    expect(s.doc.renovation?.levels[0]?.walls.w_mid_2?.thickness).toBe(0.2);
  });

  it('never leaves the renovation a door on a missing wall, or a door moved by a split', () => {
    // The renovation adds a door to a wall; the flat as it is loses that wall.
    const door = addOpening(A, {
      wallId: 'w_bed3_bed2',
      kind: 'door',
      t: 0.7,
      width: 0.8,
      height: 2.1,
      sill: 0,
    });
    let s = dispatch(renovating(), door.command);
    const outcome = {};
    s = dispatch(s, carriedToRenovation(deleteWall(L, 'w_bed3_bed2'), outcome));
    expect(outcome).toMatchObject({ conflict: true });
    const after = s.doc.renovation?.levels[0];
    expect(after?.walls.w_bed3_bed2).toBeDefined();
    expect(after?.openings[door.openingId]?.wallId).toBe('w_bed3_bed2');
    // A wall split in the flat as it is, where the renovation has its own door: not carried.
    s = dispatch(renovating(), door.command);
    s = dispatch(s, carriedToRenovation(wallAt(s, { x: 3.5, y: 7 }, { x: 2, y: 7 }), outcome));
    expect(outcome).toMatchObject({ conflict: true });
    expect(s.doc.renovation?.levels[0]?.openings[door.openingId]?.t).toBe(0.7);
  });

  it('carries no wall drawn where the renovation already drew one', () => {
    let s = renovating();
    const after = s.doc.renovation?.levels[0];
    if (!after) throw new Error('no renovation');
    s = dispatch(
      s,
      drawWall(after, { point: { x: 1, y: 1 } }, { point: { x: 2.5, y: 1 } }, { thickness: 0.1 })
        .command,
    );
    const outcome = {};
    s = dispatch(s, carriedToRenovation(wallAt(s, { x: 1, y: 1 }, { x: 2.5, y: 1 }), outcome));
    expect(outcome).toMatchObject({ conflict: true });
    const walls = Object.values(s.doc.renovation?.levels[0]?.walls ?? {});
    expect(walls.length).toBe(Object.keys(after.walls).length + 1);
  });

  it('carries nothing of a restored version, and gives a new room a free name', () => {
    const start = renovating();
    let s = dispatch(start, updateWall(A, 'w_bed3_bed2', { height: 1 }));
    const outcome = {};
    s = dispatch(s, carriedToRenovation(restoreVersion(start.doc), outcome));
    expect(outcome).toEqual({ carried: false, conflict: false });
    expect(s.doc.renovation?.levels[0]?.walls.w_bed3_bed2?.height).toBeUndefined();
    // The renovation divides a room ("Room 1"); the flat as it is divides another: the
    // renovation doesn't end up with two rooms called Room 1.
    s = dispatch(
      start,
      (() => {
        const a = start.doc.renovation?.levels[0];
        if (!a) throw new Error('no renovation');
        return drawWall(
          a,
          { point: { x: 8, y: 0 } },
          { point: { x: 8, y: 4.5 } },
          { thickness: 0.1 },
        ).command;
      })(),
    );
    expect(Object.values(s.doc.renovation?.levels[0]?.rooms ?? {}).map((r) => r.name)).toContain(
      'Room 1',
    );
    s = dispatch(s, carriedToRenovation(wallAt(s, { x: 0, y: 6.5 }, { x: 3.5, y: 6.5 })));
    const names = Object.values(s.doc.renovation?.levels[0]?.rooms ?? {}).map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('takes an edit the renovation already has as done, not as a conflict', () => {
    let s = dispatch(renovating(), deleteWall(A, 'w_bed3_bed2'));
    const outcome = {};
    s = dispatch(s, carriedToRenovation(deleteWall(L, 'w_bed3_bed2'), outcome));
    expect(outcome).toMatchObject({ conflict: false });
    expect(changesOf(s)).toEqual([]);
  });

  it('takes back the steps of a drag already carried when a later step is held back', () => {
    // The renovation adds its own door to a wall; a drag in the flat as it is first moves a
    // corner (carried), then removes that wall (held back: the door would be left hanging).
    const door = addOpening(A, {
      wallId: 'w_bed3_bed2',
      kind: 'door',
      t: 0.7,
      width: 0.8,
      height: 2.1,
      sill: 0,
    });
    const start = dispatch(renovating(), door.command);
    const at = start.doc.renovation?.levels ?? [];
    const step1 = {};
    let s = dispatch(
      start,
      carriedToRenovation(moveVertex(L, 'v10', { x: 7.2, y: 4.5 }), step1, at),
      { coalesceKey: 'drag' },
    );
    expect(step1).toMatchObject({ carried: true });
    expect(s.doc.renovation?.levels[0]?.vertices.v10?.x).toBe(7.2);
    const step2 = {};
    s = dispatch(s, carriedToRenovation(deleteWall(L, 'w_bed3_bed2'), step2, at), {
      coalesceKey: 'drag',
    });
    expect(step2).toMatchObject({ conflict: true });
    expect(s.doc.renovation?.levels[0]).toEqual(at[0]);
  });

  it('holds back what the renovation would make no sense of', () => {
    const outcome: { carried?: boolean; conflict?: boolean } = {};
    // A wall split where the renovation thickened and painted it: the new piece takes the
    // renovation's thickness and paint too.
    let s = dispatch(
      renovating(),
      updateWall(A, 'w_bed3_bed2', { thickness: 0.2, materialLeft: 'paint-sage' }),
    );
    s = dispatch(s, carriedToRenovation(wallAt(s, { x: 3.5, y: 6.5 }, { x: 2, y: 6.5 }), outcome));
    expect(outcome).toMatchObject({ carried: true });
    const after = s.doc.renovation?.levels[0];
    const pieces = Object.values(after?.walls ?? {}).filter((w) => {
      const a = after?.vertices[w.a];
      const b = after?.vertices[w.b];
      return a?.x === 3.5 && b?.x === 3.5;
    });
    expect(pieces.length).toBe(2);
    for (const w of pieces) expect(w).toMatchObject({ thickness: 0.2, materialLeft: 'paint-sage' });
    // The renovation renamed a room the edit merges away: held back.
    s = dispatch(renovating(), updateRoom(A, 'rm_bed3', { name: 'Study' }));
    s = dispatch(s, carriedToRenovation(deleteWall(L, 'w_bed3_bed2'), outcome));
    expect(outcome).toMatchObject({ conflict: true });
    expect(s.doc.renovation?.levels[0]?.rooms.rm_bed3?.name).toBe('Study');
    // A split of a wall whose corner the renovation moved would bend it: held back.
    s = dispatch(renovating(), moveVertex(A, 'v6', { x: 3.7, y: 8.5 }));
    s = dispatch(s, carriedToRenovation(wallAt(s, { x: 3.5, y: 6.5 }, { x: 2, y: 6.5 }), outcome));
    expect(outcome).toMatchObject({ conflict: true });
    // A door added onto one the renovation put there: held back.
    const own = addOpening(A, {
      wallId: 'w_bed3_bed2',
      kind: 'door',
      t: 0.5,
      width: 0.8,
      height: 2.1,
      sill: 0,
    });
    s = dispatch(renovating(), own.command);
    const fix = addOpening(L, {
      wallId: 'w_bed3_bed2',
      kind: 'door',
      t: 0.52,
      width: 0.8,
      height: 2.1,
      sill: 0,
    });
    s = dispatch(s, carriedToRenovation(fix.command, outcome));
    expect(outcome).toMatchObject({ conflict: true });
    // A wall the flat as it is makes a boundary, where the renovation has its own door: held back.
    s = dispatch(renovating(), own.command);
    s = dispatch(
      s,
      carriedToRenovation(updateWall(L, 'w_bed3_bed2', { kind: 'boundary' }), outcome),
    );
    expect(outcome).toMatchObject({ conflict: true });
  });
});
