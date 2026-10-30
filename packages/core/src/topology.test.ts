import { describe, expect, it } from 'vitest';
import { drawWall, moveVertex, setWallLength, splitWall, updateOpening } from './commands';
import { emptyLevel } from './factory';
import { hdb4RoomProject } from './fixtures/hdb4room';
import { roomArea } from './geometry';
import { type EditorDoc, dispatch, emptyHistory, undo } from './history';
import { NewerSchemaError, loadProject } from './migrate';
import { Project } from './schema';
import { snapPoint } from './snap';
import { repairLevel, settleVertex } from './topology';

const L = 'lvl_ground';
const lvl = (s: EditorDoc) => s.doc.levels[0]!;
const fresh = (): EditorDoc => ({ doc: hdb4RoomProject(), history: emptyHistory() });
const wallLengths = (s: EditorDoc) =>
  Object.values(lvl(s).walls).map((w) => {
    const a = lvl(s).vertices[w.a]!;
    const b = lvl(s).vertices[w.b]!;
    return Math.hypot(b.x - a.x, b.y - a.y);
  });

/** A 5 x 4 rectangle drawn with the wall tool, as one room. */
function rectangle(): EditorDoc {
  let s: EditorDoc = {
    doc: { ...hdb4RoomProject(), levels: [emptyLevel()] },
    history: emptyHistory(),
  };
  const pts = [
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 5, y: 4 },
    { x: 0, y: 4 },
  ];
  let from: { vertexId: string } | { point: { x: number; y: number } } = { point: pts[0]! };
  let first = '';
  for (let i = 1; i <= 4; i++) {
    const r = drawWall(lvl(s), from, i === 4 ? { vertexId: first } : { point: pts[i]! });
    s = dispatch(s, r.command);
    first ||= r.startVertexId;
    from = { vertexId: r.endVertexId };
  }
  return s;
}
const vertexAt = (s: EditorDoc, x: number, y: number) =>
  Object.values(lvl(s).vertices).find((v) => v.x === x && v.y === y)!.id;

describe('settleVertex', () => {
  it('a corner dropped on its neighbour merges and the zero-length wall goes', () => {
    let s = rectangle();
    const c = vertexAt(s, 5, 4);
    s = dispatch(s, moveVertex(L, c, { x: 5, y: 0 }), { coalesceKey: 'drag' });
    s = dispatch(s, settleVertex(lvl(s), c), { coalesceKey: 'drag' });
    expect(Object.keys(lvl(s).walls)).toHaveLength(3);
    for (const len of wallLengths(s)) expect(len).toBeGreaterThan(0.01);
    expect(Object.keys(lvl(s).rooms)).toHaveLength(1); // the triangle that is left
    expect(s.history.past).toHaveLength(5); // 4 walls drawn + one drag step
    expect(() => Project.parse(s.doc)).not.toThrow();
  });

  it('a corner dragged across another wall splits both where they cross; rooms survive', () => {
    const s0 = fresh();
    // Push the Bed 2 / Master corner v5 (7, 8.5) up past the corridor wall to (7, 3).
    let s = dispatch(s0, moveVertex(L, 'v5', { x: 7, y: 3 }), { coalesceKey: 'd' });
    s = dispatch(s, settleVertex(lvl(s), 'v5'), { coalesceKey: 'd' });
    const l = lvl(s);
    // The wall from v10 (7, 4.5) to v5 is collinear with nothing; w_bed2_master now runs
    // from v10 up to (7, 3). The back walls v4-v5-v6 slant up and cross the corridor
    // (y = 4.5) walls, which are split at the crossings.
    for (const len of wallLengths(s)) expect(len).toBeGreaterThan(1e-3);
    expect(Object.keys(l.rooms).length).toBeGreaterThan(0);
    for (const r of Object.values(l.rooms)) expect(roomArea(l, r)).toBeGreaterThan(0.25);
    // A later unrelated wall must not wipe every room (it did before settling existed).
    const r2 = drawWall(l, { point: { x: 1, y: 1 } }, { point: { x: 2, y: 1 } });
    const s2 = dispatch(s, r2.command);
    expect(Object.keys(lvl(s2).rooms).length).toBe(Object.keys(l.rooms).length);
    expect(undo(undo(s2)).doc).toEqual(s0.doc);
  });

  it('a corner dropped on a wall splits that wall', () => {
    let s = rectangle();
    const r = drawWall(lvl(s), { point: { x: 2, y: 1 } }, { point: { x: 2, y: 2 } }); // a stub inside
    s = dispatch(s, r.command);
    s = dispatch(s, moveVertex(L, r.endVertexId, { x: 2, y: 4 }));
    s = dispatch(s, settleVertex(lvl(s), r.endVertexId));
    const onBottom = Object.values(lvl(s).walls).filter(
      (w) => w.a === r.endVertexId || w.b === r.endVertexId,
    );
    expect(onBottom).toHaveLength(3); // the stub plus the two halves of the bottom wall
  });
});

describe('no sliver walls next to corners', () => {
  it('snapping onto a wall right beside its corner gives the corner', () => {
    const l = lvl(fresh());
    const s = snapPoint(l, { x: 0.05, y: 0.12 }, { tolerance: 0.15, grid: 0.1 });
    expect(s).toMatchObject({ kind: 'vertex', vertexId: 'v0' });
  });

  it('splitting a wall within 5 cm of its end does nothing', () => {
    const s0 = fresh();
    const r = splitWall(L, 'w_front_l', { x: 0.03, y: 0 }, lvl(s0));
    expect(r.vertexId).toBe('v0');
    expect(dispatch(s0, r.command)).toBe(s0);
  });

  it('a wall ending on another wall near its corner joins the corner', () => {
    const s0 = fresh();
    const r = drawWall(
      lvl(s0),
      { point: { x: 2, y: -2 } },
      { point: { x: 0.04, y: 0 }, wallId: 'w_front_l' },
    );
    expect(r.endVertexId).toBe('v0');
  });
});

describe('openings stay on their walls', () => {
  it('shortening a wall pulls its door back on and narrows it if needed', () => {
    let s = dispatch(fresh(), updateOpening(L, 'op_master', { t: 0.85 }));
    s = dispatch(s, setWallLength(L, 'w_mid_4', 1.2, 'end'));
    const o = lvl(s).openings.op_master!;
    expect(o.t * 1.2 - o.width / 2).toBeGreaterThanOrEqual(-1e-9);
    expect(o.t * 1.2 + o.width / 2).toBeLessThanOrEqual(1.2 + 1e-9);
    s = dispatch(s, setWallLength(L, 'w_mid_4', 0.5, 'end'));
    expect(lvl(s).openings.op_master!.width).toBeLessThanOrEqual(0.5);
  });

  it('an opening wider than its wall is rejected', () => {
    expect(() => dispatch(fresh(), updateOpening(L, 'op_master', { width: 5 }))).toThrow(
      /does not fit/,
    );
  });
});

describe('loading documents', () => {
  it('repairs dangling references instead of failing to draw', () => {
    const doc = hdb4RoomProject();
    const l = doc.levels[0]!;
    delete l.vertices.v10; // three walls and the master room now point at nothing
    const { project, fixes } = loadProject(doc);
    const fixed = project.levels[0]!;
    expect(fixes.length).toBeGreaterThan(0);
    for (const w of Object.values(fixed.walls)) {
      expect(fixed.vertices[w.a]).toBeDefined();
      expect(fixed.vertices[w.b]).toBeDefined();
    }
    for (const o of Object.values(fixed.openings)) expect(fixed.walls[o.wallId]).toBeDefined();
    expect(fixed.rooms.rm_master).toBeUndefined();
  });

  it('leaves a sound document untouched and refuses one from a newer app', () => {
    const doc = hdb4RoomProject();
    expect(repairLevel(doc.levels[0]!).fixes).toEqual([]);
    expect(loadProject(doc).project).toEqual(doc);
    expect(() => loadProject({ ...doc, schemaVersion: 99 })).toThrow(NewerSchemaError);
  });
});
