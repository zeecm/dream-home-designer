import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { drawWall, setCeilingHeight } from './commands';
import { blankProject } from './factory';
import { hdb4RoomLevel } from './fixtures/hdb4room';
import { sampleFlatProject } from './fixtures/sampleFlat';
import {
  FURNITURE,
  addItem,
  deleteItem,
  duplicateOf,
  furnitureKind,
  itemFootprint,
  itemLights,
  newItem,
  placeFurniture,
  updateItem,
} from './furniture';
import { dispatch, emptyHistory, undo } from './history';
import { planGeometry } from './plan';
import { Project } from './schema';
import { insideFurniture, walkStart } from './walk';

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

describe('furniture and the walk', () => {
  it('never starts a walk inside a piece of furniture', () => {
    let s = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
    const lvl = () => s.doc.levels[0]!;
    const pts: [number, number][] = [
      [0, 0],
      [3, 0],
      [3, 3.2],
      [0, 3.2],
    ];
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = pts[i]!;
      const [bx, by] = pts[(i + 1) % 4]!;
      s = dispatch(
        s,
        drawWall(lvl(), { point: { x: ax, y: ay } }, { point: { x: bx, y: by } }).command,
      );
    }
    s = dispatch(s, addItem(lvl().id, newItem('it_bed', kind('bed-king'), { x: 1.5, y: 1.6 })));
    const start = walkStart(lvl());
    expect(start).not.toBeNull();
    expect(insideFurniture(lvl(), start!.at)).toBe(false);
  });
});

describe('placeFurniture in a corner', () => {
  const geom = planGeometry(sampleFlatProject().levels[0]!);

  it('slides a wardrobe dropped in a corner clear of the side wall', () => {
    // The main bedroom's top-left corner: top wall inner face y 0.15, left wall face x 0.3.
    const p = placeFurniture(geom, kind('wardrobe'), { x: 0.6, y: 0.45 }, 0);
    const f = itemFootprint(newItem('w', kind('wardrobe'), p.at, p.rotation));
    for (const q of f) {
      expect(q.x).toBeGreaterThanOrEqual(0.3 - 1e-6);
      expect(q.y).toBeGreaterThanOrEqual(0.15 - 1e-6);
    }
  });

  it('keeps a bedside table on a short wall off the thicker wall above it', () => {
    // The bedroom's 100 mm wall (face x 6.395, y 2.156..3.048) below the 300 mm one.
    const p = placeFurniture(geom, kind('bedside'), { x: 6.1, y: 2.2 }, 0);
    expect(p.at.x).toBeCloseTo(6.395 - 0.2 - 0.005);
    const f = itemFootprint(newItem('b', kind('bedside'), p.at, p.rotation));
    for (const q of f) expect(q.y).toBeGreaterThanOrEqual(2.156 - 1e-6);
  });

  it('leaves a piece too wide for the free stretch by the wall it snapped to', () => {
    const p = placeFurniture(geom, kind('desk'), { x: 6.0, y: 2.6 }, 0);
    expect(p.at.y).toBeGreaterThan(2.156);
    expect(p.at.y).toBeLessThan(3.048);
  });
});

describe('lamps', () => {
  const level = () => structuredClone(hdb4RoomLevel());

  it('hangs a ceiling light from the ceiling and stands a floor lamp on the floor', () => {
    const ceiling = furnitureKind('ceiling-light');
    const floor = furnitureKind('floor-lamp');
    if (!ceiling || !floor) throw new Error('missing kinds');
    const c = newItem('c', ceiling, { x: 1, y: 1 }, 0, 2.6);
    expect(c.position.y + ceiling.size.h).toBeCloseTo(2.6);
    expect(newItem('f', floor, { x: 1, y: 1 }).position.y).toBe(0);
  });

  it('puts each lamp’s light where its bulb is, moved, turned and scaled with it', () => {
    const lvl = level();
    const lamp = furnitureKind('floor-lamp');
    if (!lamp) throw new Error('missing kind');
    const item = newItem('lamp1', lamp, { x: 2, y: 3 }, Math.PI / 2);
    item.scale.y = 2;
    lvl.items[item.id] = item;
    lvl.items.sofa = newItem('sofa', furnitureKind('sofa-3') ?? lamp, { x: 0, y: 0 });
    const lights = itemLights(lvl, 0);
    expect(lights).toHaveLength(1);
    const [l] = lights;
    expect(l?.itemId).toBe('lamp1');
    expect(l?.position.x).toBeCloseTo(2);
    expect(l?.position.z).toBeCloseTo(3);
    expect(l?.position.y).toBeCloseTo(2.9);
  });

  it('every lamp kind has its bulb inside its own box', () => {
    for (const k of FURNITURE.filter((f) => f.light)) {
      const [x, y, z] = k.light?.at ?? [0, 0, 0];
      expect(Math.abs(x)).toBeLessThanOrEqual(k.size.w / 2);
      expect(Math.abs(y)).toBeLessThanOrEqual(k.size.d / 2);
      // A ceiling light shines from just under its diffuser.
      expect(z).toBeGreaterThanOrEqual(k.ceiling ? -0.15 : 0);
      expect(z).toBeLessThanOrEqual(k.size.h);
    }
  });
});

describe('ceiling lights and the ceiling height', () => {
  it('move with the ceiling, and undo with it; floor pieces stay', () => {
    const p = sampleFlatProject('p1');
    const lvl = p.levels[0];
    if (!lvl) throw new Error('no level');
    const light = furnitureKind('ceiling-light');
    const lamp = furnitureKind('floor-lamp');
    if (!light || !lamp) throw new Error('missing kinds');
    let s = { doc: p, history: emptyHistory() };
    s = dispatch(s, addItem(lvl.id, newItem('c', light, { x: 2, y: 2 }, 0, lvl.ceilingHeight)));
    s = dispatch(s, addItem(lvl.id, newItem('f', lamp, { x: 3, y: 2 })));
    s = dispatch(s, setCeilingHeight(lvl.id, 3.2));
    const items = s.doc.levels[0]?.items;
    expect((items?.c?.position.y ?? 0) + light.size.h).toBeCloseTo(3.2);
    expect(items?.f?.position.y).toBe(0);
    s = undo(s);
    expect(s.doc.levels[0]?.items.c?.position.y).toBeCloseTo(lvl.ceilingHeight - light.size.h);
  });
});

describe('model kinds', () => {
  it('each has its GLB in the web app, a real size and a CC0 source', () => {
    const models = FURNITURE.filter((k) => k.model);
    expect(models.length).toBeGreaterThan(10);
    for (const k of models) {
      expect(existsSync(`../../apps/web/public/models/${k.model}`), k.id).toBe(true);
      expect(k.size.w * k.size.d * k.size.h).toBeGreaterThan(0);
      expect(k.source).toMatch(/^https:\/\/polyhaven\.com\/a\//);
    }
    expect(new Set(FURNITURE.map((k) => k.id)).size).toBe(FURNITURE.length);
  });
});

describe('duplicateOf', () => {
  it('sets the copy beside the original, along its width, turned the same', () => {
    const chair = newItem('a', furnitureKind('dining-chair')!, { x: 1, y: 2 }, Math.PI / 2);
    const copy = duplicateOf(chair, 'b');
    expect(copy.id).toBe('b');
    expect(copy.rotationY).toBe(chair.rotationY);
    // Turned a quarter, its width runs along plan y.
    expect(copy.position.x).toBeCloseTo(1);
    expect(copy.position.z).toBeCloseTo(2 + 0.45 + 0.05);
    expect(copy.scale).toEqual(chair.scale);
    expect(copy.scale).not.toBe(chair.scale);
  });
});
