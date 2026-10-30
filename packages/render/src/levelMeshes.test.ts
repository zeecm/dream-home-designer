import {
  type Level,
  dispatch,
  emptyHistory,
  emptyLevel,
  hdb4RoomLevel,
  hdb4RoomProject,
  moveVertex,
} from '@dhd/core';
import { describe, expect, it } from 'vitest';
import { LevelMeshes } from './levelMeshes';
import { MaterialCache } from './materials';

/** A 5 x 4 grid of 2 m rooms: 49 walls, 30 corners, 20 rooms, a door in each room. */
function gridLevel(): Level {
  const l = emptyLevel();
  const id = (i: number, j: number) => `v${i}_${j}`;
  for (let i = 0; i <= 5; i++)
    for (let j = 0; j <= 4; j++) l.vertices[id(i, j)] = { id: id(i, j), x: i * 2, y: j * 2 };
  const wall = (a: string, b: string) => {
    const w = `w_${a}_${b}`;
    l.walls[w] = {
      id: w,
      a,
      b,
      thickness: 0.1,
      materialLeft: 'paint-white',
      materialRight: 'paint-white',
    };
    return w;
  };
  for (let i = 0; i <= 5; i++) for (let j = 0; j < 4; j++) wall(id(i, j), id(i, j + 1));
  for (let j = 0; j <= 4; j++)
    for (let i = 0; i < 5; i++) {
      const w = wall(id(i, j), id(i + 1, j));
      if (j > 0 && j < 4)
        l.openings[`op_${w}`] = {
          id: `op_${w}`,
          wallId: w,
          kind: 'door',
          t: 0.5,
          width: 0.8,
          height: 2.1,
          sill: 0,
        };
    }
  for (let i = 0; i < 5; i++)
    for (let j = 0; j < 4; j++) {
      const r = `rm_${i}_${j}`;
      l.rooms[r] = {
        id: r,
        name: r,
        loop: [id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)],
        floorMaterial: 'wood-oak',
        ceilingMaterial: 'paint-white',
      };
    }
  return l;
}

describe('LevelMeshes', () => {
  it('reuses everything when nothing changed', () => {
    const m = new LevelMeshes(new MaterialCache());
    const l = hdb4RoomLevel();
    const first = m.update(l);
    expect(first.reused).toBe(0);
    const again = m.update(structuredClone(l));
    expect(again).toEqual({ built: 0, reused: first.built, removed: 0 });
  });

  it('moving a corner rebuilds only the walls, hubs and rooms around it', () => {
    let s = { doc: hdb4RoomProject(), history: emptyHistory() };
    const m = new LevelMeshes(new MaterialCache());
    m.update(s.doc.levels[0]!);
    s = dispatch(s, moveVertex('lvl_ground', 'v10', { x: 7.5, y: 4.5 }));
    const stats = m.update(s.doc.levels[0]!);
    // v10 slides along its horizontal walls, so those two change length; the Bedroom 2 /
    // Master wall tilts, which also moves the T-junction mitres at its far end (v5) on the
    // two back walls. That is 5 walls, the hubs at v10 and v5, and the 3 rooms touching v10:
    // 10 parts out of 28.
    expect(stats.built).toBe(10);
    expect(stats.removed).toBe(0);
    expect(m.group.getObjectByName('wall:w_mid_1')).toBeDefined();
  });

  it('removes the meshes of deleted walls', () => {
    const m = new LevelMeshes(new MaterialCache());
    const l = hdb4RoomLevel();
    m.update(l);
    const { w_bed2_master: _, ...walls } = l.walls;
    const stats = m.update({ ...l, walls });
    expect(stats.removed).toBeGreaterThan(0);
    expect(m.group.getObjectByName('wall:w_bed2_master')).toBeUndefined();
  });

  it('a corner drag on a 49-wall plan rebuilds in under 5 ms', () => {
    const level = gridLevel();
    expect(Object.keys(level.walls)).toHaveLength(49);
    const m = new LevelMeshes(new MaterialCache());
    m.update(level);
    // warm up the JIT, then time 40 drag steps of an inner corner
    const step = (k: number) => {
      const v = level.vertices.v2_2!;
      return { ...level, vertices: { ...level.vertices, v2_2: { ...v, x: 4 + (k % 10) * 0.01 } } };
    };
    for (let k = 0; k < 20; k++) m.update(step(k));
    const t0 = performance.now();
    let built = 0;
    for (let k = 0; k < 40; k++) built += m.update(step(k + 1)).built;
    const perStep = (performance.now() - t0) / 40;
    // The 4 walls at the corner, the 4 rooms around it, its hub, and the walls and hubs
    // at the far ends of the two walls that tilt: about 15 of 119 parts per step.
    expect(built / 40).toBeLessThanOrEqual(16);
    expect(perStep).toBeLessThan(5);
  });
});
