import { describe, expect, it } from 'vitest';
import { addWall, deleteWall, moveVertex, renameProject, setWallThickness } from './commands';
import { hdb4RoomProject } from './fixtures/hdb4room';
import {
  type EditorDoc,
  HISTORY_LIMIT,
  canRedo,
  canUndo,
  dispatch,
  emptyHistory,
  redo,
  undo,
} from './history';
import { Project } from './schema';

const L = 'lvl_ground';
const fresh = (): EditorDoc => ({ doc: hdb4RoomProject(), history: emptyHistory() });
const lvl = (s: EditorDoc) => s.doc.levels[0]!;

describe('history', () => {
  it('applies a command and records it', () => {
    const s = dispatch(fresh(), renameProject('My flat'));
    expect(s.doc.name).toBe('My flat');
    expect(canUndo(s)).toBe(true);
    expect(s.history.past[0]?.label).toBe('Rename project');
  });

  it('does not mutate the previous document', () => {
    const s0 = fresh();
    dispatch(s0, moveVertex(L, 'v0', { x: -1, y: -1 }));
    expect(lvl(s0).vertices.v0).toMatchObject({ x: 0, y: 0 });
  });

  it('undo restores the exact previous document and redo reapplies it', () => {
    const s0 = fresh();
    const s1 = dispatch(s0, moveVertex(L, 'v9', { x: 5.5, y: 4.5 }));
    const s2 = undo(s1);
    expect(s2.doc).toEqual(s0.doc);
    expect(canRedo(s2)).toBe(true);
    const s3 = redo(s2);
    expect(s3.doc).toEqual(s1.doc);
  });

  it('a new command clears the redo stack', () => {
    let s = dispatch(fresh(), renameProject('A'));
    s = undo(s);
    s = dispatch(s, renameProject('B'));
    expect(canRedo(s)).toBe(false);
  });

  it('no-op commands are not recorded', () => {
    const s0 = fresh();
    const s1 = dispatch(s0, renameProject(s0.doc.name));
    expect(s1).toBe(s0);
  });

  it('coalesces consecutive commands with the same key into one undo step', () => {
    let s = fresh();
    for (let i = 1; i <= 10; i++) {
      s = dispatch(s, moveVertex(L, 'v9', { x: 5 + i * 0.1, y: 4.5 }), { coalesceKey: 'drag:v9' });
    }
    expect(s.history.past).toHaveLength(1);
    expect(lvl(s).vertices.v9?.x).toBeCloseTo(6);
    expect(lvl(undo(s)).vertices.v9?.x).toBe(5);
  });

  it('does not coalesce with an entry that came back through redo', () => {
    let s = dispatch(fresh(), moveVertex(L, 'v9', { x: 6, y: 4.5 }), { coalesceKey: 'drag:v9' });
    s = redo(undo(s));
    s = dispatch(s, moveVertex(L, 'v9', { x: 6.5, y: 4.5 }), { coalesceKey: 'drag:v9' });
    expect(s.history.past).toHaveLength(2);
  });

  it('caps the undo stack', () => {
    let s = fresh();
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) s = dispatch(s, renameProject(`n${i}`));
    expect(s.history.past).toHaveLength(HISTORY_LIMIT);
  });

  it('undo on empty history is a no-op', () => {
    const s = fresh();
    expect(undo(s)).toBe(s);
    expect(redo(s)).toBe(s);
  });
});

describe('commands', () => {
  it('moving a shared vertex moves every wall that ends at it', () => {
    const s = dispatch(fresh(), moveVertex(L, 'v9', { x: 5.4, y: 4.5 }));
    const walls = Object.values(lvl(s).walls).filter((w) => w.a === 'v9' || w.b === 'v9');
    expect(walls.map((w) => w.id).sort()).toEqual(['w_living_kitchen', 'w_mid_2', 'w_mid_3']);
    expect(lvl(s).vertices.v9).toMatchObject({ x: 5.4, y: 4.5 });
  });

  it('addWall creates new vertices or reuses existing ones', () => {
    const { command, wallId, vertexIds } = addWall(L, { vertexId: 'v0' }, { x: 2, y: 2 });
    const s = dispatch(fresh(), command);
    expect(vertexIds[0]).toBe('v0');
    expect(lvl(s).vertices[vertexIds[1]]).toMatchObject({ x: 2, y: 2 });
    expect(lvl(s).walls[wallId]).toMatchObject({ a: 'v0', b: vertexIds[1], thickness: 0.1 });
  });

  it('addWall rejects a zero-length wall between the same vertex', () => {
    expect(() => addWall(L, { vertexId: 'v0' }, { vertexId: 'v0' })).toThrow();
  });

  it('deleteWall removes its openings and only orphaned vertices', () => {
    const { command, vertexIds } = addWall(L, { vertexId: 'v0' }, { x: 2, y: 2 });
    let s = dispatch(fresh(), command);
    const added = Object.keys(lvl(s).walls).find((id) => lvl(s).walls[id]?.b === vertexIds[1])!;
    s = dispatch(s, deleteWall(L, added));
    expect(lvl(s).vertices.v0).toBeDefined();
    expect(lvl(s).vertices[vertexIds[1]]).toBeUndefined();

    s = dispatch(s, deleteWall(L, 'w_mid_2'));
    expect(lvl(s).openings.op_bed2).toBeUndefined();
    expect(lvl(s).vertices.v11).toBeDefined(); // still used by other walls
  });

  it('setWallThickness validates input', () => {
    expect(() => setWallThickness(L, 'w_mid_1', 0)).toThrow();
    const s = dispatch(fresh(), setWallThickness(L, 'w_mid_1', 0.15));
    expect(lvl(s).walls.w_mid_1?.thickness).toBe(0.15);
  });

  it('documents stay schema-valid through a sequence of edits and undos', () => {
    let s = fresh();
    s = dispatch(s, moveVertex(L, 'v10', { x: 7.2, y: 4.5 }));
    s = dispatch(s, addWall(L, { vertexId: 'v1' }, { x: 5, y: 2 }).command);
    s = dispatch(s, deleteWall(L, 'w_bed2_master'));
    expect(() => Project.parse(s.doc)).not.toThrow();
    s = undo(undo(s));
    expect(() => Project.parse(s.doc)).not.toThrow();
  });
});
