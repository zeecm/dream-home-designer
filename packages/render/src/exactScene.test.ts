import {
  DEFAULT_SITE,
  type Level,
  type Project,
  dispatch,
  emptyHistory,
  furnitureKind,
  itemLights,
  newItem,
  sampleFlatProject,
  startRenovation,
  sunDirection,
  sunPosition,
} from '@dhd/core';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  EXACT_EXTRAS,
  buildExactScene,
  exactCamera,
  exactDaylight,
  isSpotLamp,
  lampLights,
} from './exactScene';
import { LevelMeshes } from './levelMeshes';
import { MaterialCache } from './materials';
import type { ModelSource } from './models';

/** Pieces put down in a level (ids `it_t000`…). */
function withItems(level: Level, pieces: [string, number, number][]): Level {
  const items = { ...level.items };
  pieces.forEach(([kindId, x, y], i) => {
    const kind = furnitureKind(kindId);
    if (!kind) throw new Error(kindId);
    const it = newItem(`it_t${String(i).padStart(3, '0')}`, kind, { x, y }, 0, level.ceilingHeight);
    items[it.id] = it;
  });
  return { ...level, items };
}

const FURNISHED: [string, number, number][] = [
  ['sofa-3', 7.5, 5.4],
  ['bed-queen', 2.1, 1.2],
  ['dining-4', 8.6, 3.6],
  ['wardrobe', 0.6, 1.6],
  ['fridge', 5.0, 5.2],
];

/** The sample flat as it is and as renovated (the after furnished), as the editor makes them. */
function sampleVersions(): { before: Level; after: Level } {
  let s = { doc: sampleFlatProject(), history: emptyHistory() };
  s = dispatch(s, startRenovation());
  const p: Project = s.doc;
  const before = withItems(p.levels[0] as Level, FURNISHED);
  const after = withItems(p.renovation?.levels[0] as Level, [
    ...FURNISHED,
    ['ceiling-light', 8.3, 3.2],
    ['floor-lamp', 9.6, 5.5],
  ]);
  return { before, after };
}

/** Every mesh under `root`, by name, with its vertex positions in world space. */
function meshes(root: THREE.Object3D): Map<string, Float32Array[]> {
  root.updateMatrixWorld(true);
  const out = new Map<string, Float32Array[]>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const list = out.get(o.name) ?? [];
    const pos = o.geometry.getAttribute('position').clone().applyMatrix4(o.matrixWorld);
    list.push(Float32Array.from(pos.array as Float32Array));
    out.set(o.name, list);
  });
  return out;
}

/**
 * A stand-in model library, every model loaded: a pole (a thin box from 0.35 to 0.95 m) and a
 * shade round the point 0.12 m up, where the catalogue's globe pendant has its bulb.
 */
function fakeModels(): ModelSource {
  const pole = new THREE.BoxGeometry(0.02, 0.6, 0.02).translate(0, 0.65, 0);
  const shade = new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(0, 0.12, 0);
  const material = new THREE.MeshStandardMaterial({ color: '#cccccc', side: THREE.FrontSide });
  return {
    has: () => true,
    get: () => {
      const g = new THREE.Group();
      for (const [name, geometry] of [
        ['pole', pole],
        ['shade', shade],
      ] as const) {
        const m = new THREE.Mesh(geometry, material);
        m.name = name;
        m.userData.shared = true;
        g.add(m);
      }
      return g;
    },
  };
}

const noon = exactDaylight(DEFAULT_SITE, 300, 12);

describe('the exact scene', () => {
  it('has exactly the 3D view’s meshes, vertex for vertex, plus only lights, ground and sky', () => {
    const models = fakeModels();
    for (const level of Object.values(sampleVersions())) {
      // A model in each, and pieces turned: their world positions must match too.
      const lit = withItems(level, [['globe-pendant', 8.6, 3.6]]);
      const view = new LevelMeshes(new MaterialCache(), { ceilings: true, models });
      view.update(lit);
      const exact = buildExactScene(lit, {
        ceilings: true,
        daylight: noon,
        lamps: true,
        models,
      });
      const a = meshes(view.group);
      const b = meshes(exact.meshes.group);
      expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
      for (const [name, arrays] of a) {
        const other = b.get(name) ?? [];
        expect(other.length, name).toBe(arrays.length);
        arrays.forEach((arr, i) => expect(other[i], name).toEqual(arr));
      }
      // And the whole scene: the level's meshes, the ground; lights; the sky as its backdrop.
      const extra: string[] = [];
      exact.scene.traverse((o) => {
        if (o === exact.scene || o === exact.meshes.group) return;
        let p: THREE.Object3D | null = o;
        while (p && p !== exact.meshes.group) p = p.parent;
        if (p) return; // the level's own
        extra.push(o instanceof THREE.Light ? 'light' : o.name || o.type);
      });
      expect(new Set(extra)).toEqual(new Set(['light', EXACT_EXTRAS.ground, 'Object3D']));
      expect(exact.scene.environment).toBeInstanceOf(THREE.DataTexture);
      expect(exact.scene.background).toBe(exact.scene.environment);
      exact.dispose();
      view.dispose();
    }
  });

  it('makes every surface two-sided, so no sealed room lets light through a ceiling', () => {
    const level = withItems(sampleVersions().after, [['globe-pendant', 8.6, 3.6]]);
    const exact = buildExactScene(level, {
      ceilings: true,
      daylight: noon,
      lamps: true,
      models: fakeModels(),
    });
    let n = 0;
    exact.scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of [o.material].flat() as THREE.Material[]) {
        expect(m.side, `${o.name} ${m.name}`).toBe(THREE.DoubleSide);
        n++;
      }
    });
    expect(n).toBeGreaterThan(100);
    exact.dispose();
  });

  it('lets only a lamp model’s shade (round its bulb) pass its light, not its pole', () => {
    const level = withItems(sampleFlatProject().levels[0] as Level, [['globe-pendant', 8.6, 3.6]]);
    const exact = buildExactScene(level, {
      ceilings: true,
      daylight: noon,
      lamps: true,
      models: fakeModels(),
    });
    const lamp = exact.meshes.group.getObjectByName('item:it_t000');
    const part = (name: string) =>
      lamp?.getObjectByName(name) as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
    const castShadow = (m: THREE.Mesh<THREE.BufferGeometry, THREE.Material>) =>
      (m.material as THREE.Material & { castShadow?: boolean }).castShadow;
    expect(castShadow(part('shade'))).toBe(false);
    expect(castShadow(part('pole'))).not.toBe(false);
    exact.dispose();
  });

  it('keeps the doors as the 3D view has them', () => {
    const { after } = sampleVersions();
    const door = Object.values(after.openings).find(
      (o) => o.kind === 'door' && o.id.includes('bedroom'),
    );
    if (!door) throw new Error('no door');
    const view = new LevelMeshes(new MaterialCache(), { ceilings: true });
    view.update(after);
    view.setDoorOpen(door.id, 0.25);
    const exact = buildExactScene(after, {
      ceilings: true,
      daylight: noon,
      lamps: false,
      doors: new Map([[door.id, 0.25]]),
    });
    const pose = (g: THREE.Object3D) => {
      const d = g.getObjectByName(`door:${door.id}`);
      d?.updateMatrixWorld(true);
      return d?.children.map((c) => c.matrixWorld.elements.map((v) => Math.round(v * 1e6)));
    };
    expect(pose(exact.meshes.group)).toEqual(pose(view.group));
    exact.dispose();
  });
});

describe('the exact scene’s light', () => {
  const twelve: [string, number, number][] = [
    ['ceiling-light', 8.3, 3.2],
    ['ceiling-light', 1.5, 1.5],
    ['ceiling-light', 4.2, 1.2],
    ['pendant', 8.6, 3.6],
    ['floor-lamp', 9.6, 5.5],
    ['table-lamp', 5.4, 0.4],
    ['globe-pendant', 4.9, 0.9],
    ['enamel-pendant', 7.0, 2.6],
    ['desk-lamp', 5.6, 0.6],
    ['floor-lamp', 7.0, 5.6],
    ['table-lamp', 2.0, 0.4],
    ['ceiling-light', 4.0, 7.0],
  ];

  it('gives each lamp its light, ceiling lights shining straight down', () => {
    const level = withItems(sampleFlatProject().levels[0] as Level, twelve);
    expect(itemLights(level)).toHaveLength(12);
    const on = buildExactScene(level, { ceilings: true, daylight: noon, lamps: true });
    expect(on.lamps).toHaveLength(12);
    for (const light of on.lamps) {
      const item = level.items[light.name.slice(5)];
      if (!item) throw new Error(light.name);
      if (isSpotLamp(item.assetId)) {
        expect(light).toBeInstanceOf(THREE.SpotLight);
        const s = light as THREE.SpotLight;
        const down = s.target
          .getWorldPosition(new THREE.Vector3())
          .sub(s.getWorldPosition(new THREE.Vector3()))
          .normalize();
        expect(down.y).toBeCloseTo(-1, 9);
        expect((s as THREE.SpotLight & { radius: number }).radius).toBe(0.05);
      } else {
        expect(light).toBeInstanceOf(THREE.PointLight);
        expect((light as THREE.PointLight).distance).toBe(0);
        expect((light as THREE.PointLight).decay).toBe(2);
      }
      // Catalogue candela as they are.
      const kind = furnitureKind(item.assetId);
      expect(light.intensity).toBe(kind?.light?.candela);
    }
    expect(on.lamps.filter((l) => l instanceof THREE.SpotLight)).toHaveLength(4);
    // Shades glow with the lamps on.
    const glows = (o: THREE.Mesh) =>
      [o.material].flat().some((m) => (m as THREE.MeshStandardMaterial).emissive.getHex() > 0);
    const lamp: THREE.Mesh[] = [];
    on.meshes.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o.name === 'item:it_t004') lamp.push(o);
    });
    expect(lamp.some(glows)).toBe(true);
    on.dispose();

    const off = buildExactScene(level, { ceilings: true, daylight: noon, lamps: false });
    expect(off.lamps).toHaveLength(0);
    let lights = 0;
    off.scene.traverse((o) => {
      if (o instanceof THREE.Light && !(o instanceof THREE.DirectionalLight)) lights++;
      if (o instanceof THREE.Mesh) expect(glows(o), o.name).toBe(false);
    });
    expect(lights).toBe(0);
    expect(lampLights(withItems(level, []))).toHaveLength(12);
    off.dispose();
  });

  it('puts the sun along sunDirection, and none at 9 pm in Singapore', () => {
    const level = sampleFlatProject().levels[0] as Level;
    for (const hour of [8, 12, 16.5]) {
      const d = exactDaylight(DEFAULT_SITE, 300, hour);
      const scene = buildExactScene(level, { ceilings: true, daylight: d, lamps: false });
      const sun = scene.sun;
      if (!sun) throw new Error(`no sun at ${hour}`);
      const dir = sun.position.clone().sub(sun.target.position).normalize();
      const want = sunDirection(DEFAULT_SITE, sunPosition(DEFAULT_SITE, 300, hour));
      expect(Math.abs(dir.x - want.x)).toBeLessThan(1e-6);
      expect(Math.abs(dir.y - want.y)).toBeLessThan(1e-6);
      expect(Math.abs(dir.z - want.z)).toBeLessThan(1e-6);
      scene.dispose();
    }
    const night = exactDaylight(DEFAULT_SITE, 300, 21);
    expect(night.sun).toBeNull();
    const scene = buildExactScene(level, { ceilings: true, daylight: night, lamps: true });
    expect(scene.sun).toBeNull();
    let suns = 0;
    scene.scene.traverse((o) => {
      if (o instanceof THREE.DirectionalLight) suns++;
    });
    expect(suns).toBe(0);
    scene.dispose();
  });

  it('dims the sun as it sinks, and the sky with the daylight', () => {
    const high = exactDaylight(DEFAULT_SITE, 300, 12.5);
    const low = exactDaylight(DEFAULT_SITE, 300, 18.3);
    expect(high.sun?.intensity).toBeGreaterThan(50_000);
    expect(low.sun?.intensity ?? 0).toBeLessThan((high.sun?.intensity ?? 0) / 2);
    expect(exactDaylight(DEFAULT_SITE, 300, 22).sky.nits).toBeLessThan(1);
    expect(high.sky.nits).toBeGreaterThan(1000);
  });
});

describe('exactCamera', () => {
  it('stands where the view does and looks the same way, with its lens', () => {
    const c = {
      position: { x: 3.2, y: 1.6, z: 4.1 },
      target: { x: 5.2, y: 1.3, z: 2.0 },
      fov: (64 * Math.PI) / 180,
      aspect: 390 / 844,
    };
    const cam = exactCamera(c);
    expect(cam.position.toArray()).toEqual([3.2, 1.6, 4.1]);
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const want = new THREE.Vector3(2, -0.3, -2.1).normalize();
    expect(dir.angleTo(want)).toBeLessThan(1e-6);
    expect(cam.fov).toBeCloseTo(64, 9);
    expect(cam.aspect).toBe(390 / 844);
    expect(cam.near).toBe(0.02);
    // Straight down, the picture's up as given.
    const down = exactCamera({ ...c, target: { x: 3.2, y: 0, z: 4.1 }, up: { x: 0, y: 0, z: -1 } });
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(down.quaternion);
    expect(up.angleTo(new THREE.Vector3(0, 0, -1))).toBeLessThan(1e-6);
  });
});
