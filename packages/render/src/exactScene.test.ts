import {
  DEFAULT_SITE,
  type Level,
  type Project,
  dispatch,
  emptyHistory,
  furnitureKind,
  itemLights,
  newItem,
  revealPasses,
  roomIdAt,
  sampleFlatProject,
  skyOpenings,
  startRenovation,
  sunDirection,
  sunPosition,
} from '@dhd/core';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  EXACT_EXTRAS,
  GLASS_PASSES,
  GROUND_COLOR,
  GROUND_REACHES,
  PORTAL,
  PORTAL_TILT,
  buildExactScene,
  exactCamera,
  exactDaylight,
  groundRadiance,
  isSpotLamp,
  lampLights,
  portalLights,
  portalRadiance,
  skyOnGround,
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

describe('portals: the sky’s light through its openings', () => {
  const level = sampleFlatProject().levels[0] as Level;
  const sky = exactDaylight(DEFAULT_SITE, 300, 12).sky;

  it('puts lights in each opening to the sky, its size, shining into the room', () => {
    const openings = skyOpenings(level);
    const ground = new THREE.Color(1000, 900, 800);
    const lights = portalLights(level, sky, undefined, ground);
    // The sky's and the ground's in every window to the outside, and nothing else.
    expect(lights).toHaveLength(2 * openings.length);
    expect(openings.length).toBeGreaterThan(5);
    for (const o of openings) {
      for (const part of ['sky', 'ground'] as const) {
        const l = lights.find((x) => x.name === `${PORTAL}${o.id}:${part}`);
        if (!l) throw new Error(`${o.id} ${part}`);
        expect(l).toBeInstanceOf(THREE.RectAreaLight);
        expect(l.width).toBeCloseTo(o.width, 9);
        expect(l.height).toBeCloseTo(o.height, 9);
        // Its middle at the opening's height, in the room, clear of the wall (tipped, its upper
        // edge reaches back no further than the wall's face).
        expect(l.position.y).toBeCloseTo(level.elevation + o.bottom + o.height / 2, 9);
        expect(roomIdAt(level, { x: l.position.x, y: l.position.z })).toBe(o.roomId);
        const inward = (l.position.x - o.at.x) * -o.out.x + (l.position.z - o.at.y) * -o.out.y;
        expect(inward).toBeCloseTo((o.height / 2) * Math.sin(PORTAL_TILT) + 0.001, 9);
        // It shines along -z: into the room, tipped down (the sky's) or up (the ground's).
        const shines = new THREE.Vector3(0, 0, -1).applyQuaternion(l.quaternion);
        expect(shines.x * -o.out.x + shines.z * -o.out.y).toBeCloseTo(Math.cos(PORTAL_TILT), 9);
        expect(shines.y).toBeCloseTo((part === 'sky' ? -1 : 1) * Math.sin(PORTAL_TILT), 9);
        // Its width runs along the wall (its local x).
        const across = new THREE.Vector3(1, 0, 0).applyQuaternion(l.quaternion);
        expect(Math.abs(across.x * o.along.x + across.z * o.along.y)).toBeCloseTo(1, 9);
        // The sky's light, or half the ground's (the lower half of the view), less what the
        // reveal hides and the glass takes.
        const view = part === 'sky' ? portalRadiance(sky) : ground.clone().multiplyScalar(0.5);
        const want = view.multiplyScalar(revealPasses(o.width, o.height, o.depth) * GLASS_PASSES);
        expect(l.intensity * l.color.g).toBeCloseTo(want.g, 6);
        expect(l.intensity * l.color.r).toBeCloseTo(want.r, 6);
      }
    }
    // Without the ground's light, the sky's alone.
    expect(portalLights(level, sky).map((l) => l.name)).toEqual(
      openings.map((o) => `${PORTAL}${o.id}:sky`),
    );
    // Windows in the flat's 0.2 m walls: the reveal hides a fifth or so of the sky.
    for (const o of openings) {
      const f = revealPasses(o.width, o.height, o.depth);
      expect(f, o.id).toBeGreaterThan(0.6);
      expect(f, o.id).toBeLessThan(0.95);
    }
    // Only the rooms asked for.
    expect(portalLights(level, sky, new Set(['rm_kitchen']))).toHaveLength(
      openings.filter((o) => o.roomId === 'rm_kitchen').length,
    );
  });

  it('carries an even sky at half its radiance (a window sees the upper half of its view)', () => {
    const even = { ...sky, zenith: sky.horizon.clone() };
    const L = portalRadiance(even);
    expect(L.g / (even.horizon.g * even.nits)).toBeCloseTo(0.5, 3);
  });

  it('with portals, lights by them, not by the sky, which is still seen', () => {
    const daylight = exactDaylight(DEFAULT_SITE, 300, 12);
    const lit = buildExactScene(level, { ceilings: true, daylight, lamps: false, portals: true });
    expect(lit.portals.length).toBe(2 * skyOpenings(level).length);
    const sunlit = lit.portals.find((p) => p.name.endsWith(':ground'));
    // The ground's: open ground's light, as much as reaches the rooms (and the reveal and
    // glass pass, over half here).
    const want = groundRadiance(daylight).multiplyScalar(0.5 * GROUND_REACHES * GLASS_PASSES);
    expect(sunlit && sunlit.intensity * sunlit.color.g).toBeGreaterThan(0.5 * want.g);
    expect(sunlit && sunlit.intensity * sunlit.color.g).toBeLessThan(want.g);
    // The ground's light comes in through them: rays from the rooms pass through the ground.
    const ground = lit.scene.getObjectByName(EXACT_EXTRAS.ground) as THREE.Mesh;
    const m = ground.material as THREE.MeshStandardMaterial & { castShadow?: boolean };
    expect(m.castShadow).toBe(false);
    // The sky lights nothing, the ground included: seen, it gives off the sky's share itself.
    expect(m.emissiveIntensity * m.emissive.g).toBeCloseTo(skyOnGround(daylight.sky).g, 6);
    // An even sky of radiance L lights open ground with πL, so it gives off its colour × L.
    const even = { ...daylight.sky, zenith: daylight.sky.horizon.clone() };
    const L = even.horizon.g * even.nits;
    expect(skyOnGround(even).g / (new THREE.Color(GROUND_COLOR).g * L)).toBeCloseTo(1, 3);
    expect(lit.scene.environmentIntensity).toBe(0);
    // The backdrop is the sky, and below the horizon the ground as it looks lit (seen through
    // glass, where the tracer passes the ground).
    const bg = lit.scene.background as THREE.DataTexture;
    expect(bg).not.toBe(lit.scene.environment);
    const px = bg.image.data as unknown as Float32Array;
    const top = (bg.image.height - 1) * bg.image.width * 4;
    const env = (lit.scene.environment as THREE.DataTexture).image.data as unknown as Float32Array;
    expect(px[top + 1]).toBeCloseTo(env[top + 1] ?? 0, 3);
    expect(px[1]).toBeCloseTo(groundRadiance(daylight).g, 1);
    expect(lit.scene.backgroundIntensity).toBe(1);
    lit.dispose();
    const open = buildExactScene(level, { ceilings: false, daylight, lamps: false });
    expect(open.portals).toHaveLength(0);
    expect(open.scene.environmentIntensity).toBe(1);
    const bare = open.scene.getObjectByName(EXACT_EXTRAS.ground) as THREE.Mesh;
    expect((bare.material as THREE.MeshStandardMaterial).emissiveIntensity).toBe(1);
    expect((bare.material as THREE.MeshStandardMaterial).emissive.getHex()).toBe(0);
    expect((bare.material as THREE.Material & { castShadow?: boolean }).castShadow).not.toBe(false);
    open.dispose();
  });
});
