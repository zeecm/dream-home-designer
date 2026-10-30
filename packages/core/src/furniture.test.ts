import { describe, expect, it } from 'vitest';
import { blankProject } from './factory';
import { sampleFlatProject } from './fixtures/sampleFlat';
import {
  FURNITURE,
  addItem,
  deleteItem,
  furnitureKind,
  itemFootprint,
  newItem,
  placeFurniture,
  updateItem,
} from './furniture';
import { dispatch, emptyHistory, undo } from './history';
import { planGeometry } from './plan';
import { Project } from './schema';

const kind = (id: string) => {
  const k = furnitureKind(id);
  if (!k) throw new Error(id);
  return k;
};

describe('the furniture catalogue', () => {
  it('has unique ids, and every part inside its piece', () => {
    expect(new Set(FURNITURE.map((k) => k.id)).size).toBe(FURNITURE.length);
    for (const k of FURNITURE) {
      for (const p of k.parts) {
        expect(p.min[0], k.id).toBeGreaterThanOrEqual(-k.size.w / 2 - 1e-9);
        expect(p.max[0], k.id).toBeLessThanOrEqual(k.size.w / 2 + 1e-9);
        expect(p.min[1], k.id).toBeGreaterThanOrEqual(-k.size.d / 2 - 1e-9);
        expect(p.max[1], k.id).toBeLessThanOrEqual(k.size.d / 2 + 0.02 + 1e-9);
        expect(p.max[2], k.id).toBeLessThanOrEqual(k.size.h + 0.01 + 1e-9);
        for (const i of [0, 1, 2]) expect(p.max[i], k.id).toBeGreaterThan(p.min[i] as number);
      }
    }
  });
});

describe('itemFootprint', () => {
  it('is the scaled, turned rectangle with its back first', () => {
    const it0 = newItem('i', kind('bed-queen'), { x: 2, y: 3 });
    const f = itemFootprint({ ...it0, scale: { x: 1, y: 1, z: 1 } });
    expect(f[0]?.x).toBeCloseTo(2 - 0.76);
    expect(f[0]?.y).toBeCloseTo(3 - 1);
    // A quarter turn: the front now faces -x.
    const turned = itemFootprint({ ...it0, rotationY: Math.PI / 2 });
    const xs = turned.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2);
    expect(turned[0]?.x).toBeCloseTo(3); // back edge at +x
  });
});

describe('placeFurniture', () => {
  const geom = planGeometry(sampleFlatProject().levels[0]!);

  it('puts a wardrobe dropped near a wall flush against it, facing the room', () => {
    // Just inside the main bedroom's top wall (inside face y = 0.15).
    const p = placeFurniture(geom, kind('wardrobe'), { x: 1.5, y: 0.6 }, 0);
    expect(p.at.x).toBeCloseTo(1.5);
    expect(p.at.y).toBeCloseTo(0.15 + 0.3 + 0.005);
    // Front faces +y, into the room.
    expect(-Math.sin(p.rotation)).toBeCloseTo(0);
    expect(Math.cos(p.rotation)).toBeCloseTo(1);
  });

  it('turns to face away from a wall on the left', () => {
    // Near the main bedroom's left wall (inside face x = 0.3).
    const p = placeFurniture(geom, kind('wardrobe'), { x: 0.8, y: 2 }, 0);
    expect(p.at.x).toBeCloseTo(0.3 + 0.3 + 0.005);
    expect(-Math.sin(p.rotation)).toBeCloseTo(1); // front faces +x
  });

  it('leaves free-standing pieces and far drops where they are', () => {
    expect(placeFurniture(geom, kind('dining-4'), { x: 8, y: 4 }, 0.3)).toEqual({
      at: { x: 8, y: 4 },
      rotation: 0.3,
    });
    expect(placeFurniture(geom, kind('wardrobe'), { x: 8, y: 4 }, 0).wallId).toBeUndefined();
  });
});

describe('item commands', () => {
  it('add, move, turn, resize and delete, each one undo step', () => {
    let s = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
    const L = s.doc.levels[0]!.id;
    s = dispatch(s, addItem(L, newItem('it_1', kind('sofa-3'), { x: 1, y: 1 })));
    s = dispatch(
      s,
      updateItem(L, 'it_1', { position: { x: 2 }, rotationY: -Math.PI / 2, scale: { x: 1.2 } }),
    );
    const it1 = s.doc.levels[0]!.items.it_1!;
    expect(it1.position).toEqual({ x: 2, y: 0, z: 1 });
    expect(it1.rotationY).toBeCloseTo((3 * Math.PI) / 2);
    expect(it1.scale.x).toBe(1.2);
    expect(() => Project.parse(s.doc)).not.toThrow();
    s = dispatch(s, deleteItem(L, 'it_1'));
    expect(s.doc.levels[0]!.items.it_1).toBeUndefined();
    s = undo(undo(s));
    expect(s.doc.levels[0]!.items.it_1?.position.x).toBe(1);
  });

  it('refuses a zero size', () => {
    let s = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
    const L = s.doc.levels[0]!.id;
    s = dispatch(s, addItem(L, newItem('it_1', kind('desk'), { x: 1, y: 1 })));
    expect(() => dispatch(s, updateItem(L, 'it_1', { scale: { y: 0 } }))).toThrow();
  });
});
