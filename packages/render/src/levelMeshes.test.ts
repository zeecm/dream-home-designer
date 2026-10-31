import {
  type Level,
  dispatch,
  emptyHistory,
  emptyLevel,
  furnitureKind,
  hdb4RoomLevel,
  hdb4RoomProject,
  moveVertex,
  newItem,
  outsideOpenings,
  planGeometry,
} from '@dhd/core';
import type * as THREE from 'three';
import { Box3, BoxGeometry, Mesh, type MeshStandardMaterial, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { extrudePolygon } from './extrude';
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
    // two back walls. That is 5 walls, the master bedroom door on one of them, the hubs at
    // v10 and v5, and the 3 rooms touching v10: 11 parts.
    expect(stats.built).toBe(11);
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
    // The fastest of five runs: a busy machine (a parallel test run, CI) slows some runs,
    // but not the code.
    let perStep = Number.POSITIVE_INFINITY;
    let built = 0;
    for (let run = 0; run < 5; run++) {
      const t0 = performance.now();
      built = 0;
      for (let k = 0; k < 40; k++) built += m.update(step(k + 1 + (run % 2))).built;
      perStep = Math.min(perStep, (performance.now() - t0) / 40);
    }
    // The 4 walls at the corner, the 4 rooms around it, its hub, and the walls and hubs
    // at the far ends of the two walls that tilt, and a door on one of them: about 16 parts
    // per step.
    expect(built / 40).toBeLessThanOrEqual(17);
    expect(perStep).toBeLessThan(5);
  });
});

describe('door leaves', () => {
  it('stand open inside, and the front door is shut in its wall', () => {
    const m = new LevelMeshes(new MaterialCache());
    const l = hdb4RoomLevel();
    m.update(l);
    const doors = Object.values(l.openings).filter((o) => o.kind === 'door');
    expect(doors.length).toBeGreaterThan(1);
    for (const o of doors) expect(m.group.getObjectByName(`door:${o.id}`), o.id).toBeDefined();
    const front = outsideOpenings(l);
    expect(front.size).toBe(1);
    // A shut leaf sits on the wall's centre line; an open one stands a half width off it.
    const g = planGeometry(l);
    const offset = (o: (typeof doors)[number]) => {
      const f = g.frames[o.wallId]!;
      m.group.updateMatrixWorld(true);
      const obj = m.group.getObjectByName(`door:${o.id}`)!;
      const c = new Box3().setFromObject(obj).getCenter(new Vector3());
      return { off: Math.abs((c.x - f.a.x) * f.n.x + (c.z - f.a.y) * f.n.y), f };
    };
    for (const o of doors) {
      const { off, f } = offset(o);
      expect(off, o.id).toBeCloseTo(front.has(o.id) ? 0 : f.half + o.width / 2, 2);
    }
    // An inside door swings shut into its wall (flush with the face it hinges on), and open
    // again.
    const inside = doors.filter((o) => !front.has(o.id));
    expect(
      m
        .doors()
        .map((d) => d.id)
        .sort(),
    ).toEqual(inside.map((o) => o.id).sort());
    for (const o of inside) {
      m.setDoorOpen(o.id, 0);
      expect(offset(o).off, o.id).toBeLessThan(offset(o).f.half);
      m.setDoorOpen(o.id, 1);
      expect(offset(o).off, o.id).toBeCloseTo(offset(o).f.half + o.width / 2, 2);
    }
  });
});

describe('room boundaries', () => {
  it('builds no wall for a boundary, and removes the wall when one becomes a boundary', () => {
    const l = hdb4RoomLevel();
    const meshes = new LevelMeshes(new MaterialCache());
    meshes.update(l);
    expect(meshes.group.getObjectByName('wall:w_mid_3')).toBeDefined();
    const w = l.walls.w_mid_3;
    if (!w) throw new Error('fixture');
    meshes.update({ ...l, walls: { ...l.walls, w_mid_3: { ...w, kind: 'boundary' } } });
    expect(meshes.group.getObjectByName('wall:w_mid_3')).toBeUndefined();
  });
});

describe('rooms inside rooms', () => {
  /** Area of a mesh's triangles projected on the floor plane. */
  const floorArea = (m: THREE.Mesh) => {
    const pos = m.geometry.getAttribute('position');
    const g = m.geometry.index;
    const n = g ? g.count : pos.count;
    const at = (i: number) => (g ? g.getX(i) : i);
    let area = 0;
    for (let i = 0; i < n; i += 3) {
      const [a, b, c] = [at(i), at(i + 1), at(i + 2)];
      const ax = pos.getX(a);
      const az = pos.getZ(a);
      area += Math.abs(
        ((pos.getX(b) - ax) * (pos.getZ(c) - az) - (pos.getZ(b) - az) * (pos.getX(c) - ax)) / 2,
      );
    }
    return area;
  };

  it('cuts the inner room out of the outer floor and floors the inner room', () => {
    const l = emptyLevel();
    const square = (p: string, x0: number, x1: number) => {
      const ids = [
        [x0, x0],
        [x1, x0],
        [x1, x1],
        [x0, x1],
      ].map(([x, y], i) => {
        const id = `${p}${i}`;
        l.vertices[id] = { id, x: x as number, y: y as number };
        return id;
      });
      ids.forEach((a, i) => {
        const b = ids[(i + 1) % 4] as string;
        l.walls[`${a}${b}`] = {
          id: `${a}${b}`,
          a,
          b,
          thickness: 0.1,
          materialLeft: 'paint-white',
          materialRight: 'paint-white',
        };
      });
      l.rooms[`rm_${p}`] = {
        id: `rm_${p}`,
        name: p,
        loop: ids,
        floorMaterial: 'wood-oak',
        ceilingMaterial: 'paint-white',
      };
    };
    square('o', 0, 6);
    square('i', 2.5, 3.5);
    const meshes = new LevelMeshes(new MaterialCache());
    meshes.update(l);
    const floor = (id: string) =>
      meshes.group.getObjectByName(`floor:${id}`) as THREE.Mesh | undefined;
    expect(floorArea(floor('rm_o') as THREE.Mesh)).toBeCloseTo(35);
    expect(floorArea(floor('rm_i') as THREE.Mesh)).toBeCloseTo(1);
  });
});

describe('furniture', () => {
  it('builds each piece once, and rebuilds only the one that moved', () => {
    const l = hdb4RoomLevel();
    const sofa = newItem('it_sofa', furnitureKind('sofa-3')!, { x: 3, y: 3 });
    const bed = newItem('it_bed', furnitureKind('bed-queen')!, { x: 9, y: 2 });
    const m = new LevelMeshes(new MaterialCache());
    m.update({ ...l, items: { it_sofa: sofa, it_bed: bed } });
    expect(m.group.getObjectByName('item:it_sofa')).toBeDefined();
    const moved = { ...sofa, position: { ...sofa.position, x: 3.5 } };
    const stats = m.update({ ...l, items: { it_sofa: moved, it_bed: bed } });
    expect(stats.built).toBe(1);
    // Turned a quarter, the 2.1 m sofa runs along world z.
    m.update({ ...l, items: { it_sofa: { ...moved, rotationY: Math.PI / 2 }, it_bed: bed } });
    const box = new Box3();
    for (const o of m.group.children.filter((c) => c.name === 'item:it_sofa'))
      box.expandByObject(o);
    expect(box.max.z - box.min.z).toBeCloseTo(2.1, 1);
    expect(box.max.x - box.min.x).toBeCloseTo(0.9, 1);
  });
});

describe('furniture models', () => {
  /** A stand-in model library: one shared box geometry, "loaded" when told to. */
  function fakeModels() {
    const geometry = new BoxGeometry(1, 1, 1);
    let ready = false;
    const lib = {
      geometry,
      load: () => {
        ready = true;
      },
      has: () => ready,
      get: () => {
        if (!ready) return null;
        const mesh = new Mesh(geometry);
        mesh.userData.shared = true;
        return mesh;
      },
    };
    return lib;
  }

  it('shows a box until the model loads, then the model, scaled and turned like the item', () => {
    const kind = furnitureKind('lounge-chair')!;
    expect(kind.model).toMatch(/\.glb$/);
    const l = hdb4RoomLevel();
    const item = { ...newItem('it_chair', kind, { x: 3, y: 3 }), scale: { x: 2, y: 1, z: 1 } };
    const lib = fakeModels();
    const m = new LevelMeshes(new MaterialCache(), { models: lib });
    m.update({ ...l, items: { it_chair: item } });
    const box = m.group.getObjectByName('item:it_chair') as Mesh;
    expect((box.material as MeshStandardMaterial).color.getHexString()).toBe('d6dade');

    lib.load();
    const stats = m.update({ ...l, items: { it_chair: item } });
    expect(stats.built).toBe(1);
    const model = m.group.getObjectByName('item:it_chair')!;
    expect(model.children[0]).toBeInstanceOf(Mesh);
    expect(model.scale.x).toBe(2);
    expect(model.userData).toEqual({ kind: 'item', itemId: 'it_chair' });

    // Removing the piece leaves the library's shared geometry alone.
    let disposed = false;
    lib.geometry.addEventListener('dispose', () => {
      disposed = true;
    });
    m.update({ ...l, items: {} });
    expect(m.group.getObjectByName('item:it_chair')).toBeUndefined();
    expect(disposed).toBe(false);
  });
});

describe('wall paint', () => {
  it('paints each side of a wall on its own, with white ends and top', () => {
    const l = hdb4RoomLevel();
    const [id, w] = Object.entries(l.walls)[0]!;
    const m = new LevelMeshes(new MaterialCache());
    m.update({
      ...l,
      walls: { ...l.walls, [id]: { ...w, materialLeft: 'paint-sage', materialRight: 'paint-sky' } },
    });
    const mesh = m.group.getObjectByName(`wall:${id}`) as THREE.Mesh;
    const mats = mesh.material as THREE.MeshStandardMaterial[];
    expect(mats.map((x) => `#${x.color.getHexString()}`)).toEqual([
      '#bccab3',
      '#c6d7e4',
      '#f2efe9',
    ]);
    const groups = mesh.geometry.groups;
    expect(groups.map((g) => g.materialIndex)).toEqual([0, 1, 2]);
    for (const g of groups) expect(g.count).toBeGreaterThan(0);
  });
});

describe('extrudePolygon', () => {
  it('fills a concave outline exactly, its sides facing out', () => {
    // An L: area 3, made of 0..2 × 0..1 and 0..1 × 1..2.
    const l = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 0, y: 2 },
    ];
    for (const poly of [l, [...l].reverse()]) {
      const g = extrudePolygon(poly, 0, 1);
      const pos = g.getAttribute('position');
      let top = 0;
      const a = new Vector3();
      const b = new Vector3();
      const c = new Vector3();
      for (let t = 0; t < pos.count / 3; t++) {
        a.fromBufferAttribute(pos, t * 3);
        b.fromBufferAttribute(pos, t * 3 + 1);
        c.fromBufferAttribute(pos, t * 3 + 2);
        const n = b.clone().sub(a).cross(c.clone().sub(a));
        if (n.y > 1e-9) top += n.y / 2;
        // The side face along the inner corner's edge x = 1 (y 1..2) faces +x.
        const mid = a.clone().add(b).add(c).divideScalar(3);
        if (Math.abs(n.y) < 1e-9 && Math.abs(mid.x - 1) < 1e-9 && mid.z > 1) {
          expect(n.x).toBeGreaterThan(0);
        }
      }
      expect(top).toBeCloseTo(3);
    }
  });
});
