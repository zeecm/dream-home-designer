import { describe, expect, it } from 'vitest';
import { deleteWall, moveVertex, splitWall, updateWall } from './commands';
import { hdb4RoomProject } from './fixtures/hdb4room';
import { type EditorDoc, dispatch, emptyHistory, undo } from './history';
import { AFTER_SUFFIX, findLevel, variantLevels } from './levels';
import { loadProject } from './migrate';
import { endRenovation, renovationDiff, startRenovation } from './renovation';
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
    expect(d.demolishedLength).toBeCloseTo(4.5);
    expect(d.builtLength).toBe(0);
    expect(d.demolished[0]?.polygon).toHaveLength(4);
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
