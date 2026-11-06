import {
  type Level,
  type SceneCamera,
  type Site,
  type SunPosition,
  daylight,
  furnitureKind,
  itemLights,
  levelBounds,
  sunDirection,
  sunPosition,
} from '@dhd/core';
import * as THREE from 'three';
import { LevelMeshes } from './levelMeshes';
import type { ModelSource } from './models';
import { PhotoMaterials } from './photo';

/**
 * The exact render's scene: the 3D view's own meshes (built by the same `LevelMeshes`, so
 * every wall, door, window and piece is where the plan has it), with physically based
 * materials and real light (a sky, the sun, every lamp). Nothing else is added but the
 * ground outside. Units: lamps in candela (the catalogue's), the sun in lux, the sky in
 * cd/m², as three.js's physical lights count them.
 */

/** A small step under the floor for the ground outside, metres. */
const GROUND_DROP = 0.01;
export const GROUND_COLOR = '#9a9a94';
/** A spot light's bulb, metres across its middle (soft shadows under furniture). */
export const SPOT_RADIUS = 0.05;
export const SPOT_ANGLE = Math.PI / 3;
export const SPOT_PENUMBRA = 0.6;
/** The sun's light where the air is thin, lux (it drops with the air it passes through). */
const SUN_LUX = 110_000;
/** The clear sky's brightness by day, cd/m² (about 12,000 lux on the ground). */
const SKY_NITS = 4_000;
/** The sky on a dark night, cd/m². */
const NIGHT_NITS = 0.4;

const lerp = (a: string, b: string, t: number) =>
  new THREE.Color(a).lerp(new THREE.Color(b), Math.min(1, Math.max(0, t)));

export interface SkyLight {
  zenith: THREE.Color;
  horizon: THREE.Color;
  /** Below the horizon (the ground far off). */
  ground: THREE.Color;
  /** How bright (cd/m²) the colours above are taken at 1. */
  nits: number;
}

export interface SunLight {
  /** Unit vector towards the sun, world space. */
  direction: THREE.Vector3;
  color: THREE.Color;
  /** Lux. */
  intensity: number;
}

export interface Daylight {
  sun: SunLight | null;
  sky: SkyLight;
  /** 0 (night) to 1 (sun well up), as the 3D view counts it. */
  light: number;
}

/**
 * The sun and sky at `hour` on day `day`: the sun along `sunDirection` (as the 3D view's),
 * warm when low and dimmed by the air it crosses (Meinel's air-mass formula); none below
 * the horizon. The sky blue by day, deep blue and faint at night.
 */
export function exactDaylight(site: Site, day: number, hour: number): Daylight {
  const pos: SunPosition = sunPosition(site, day, hour);
  const light = daylight(pos);
  const d = sunDirection(site, pos);
  let sun: SunLight | null = null;
  if (pos.altitude > 0) {
    const sinAlt = Math.max(Math.sin((pos.altitude * Math.PI) / 180), 0.01);
    const airMass = 1 / sinAlt;
    sun = {
      direction: new THREE.Vector3(d.x, d.y, d.z).normalize(),
      // The 3D view's sun colour: warm when low.
      color: lerp('#ffb066', '#fff6ea', pos.altitude / 25),
      intensity: SUN_LUX * 0.7 ** (airMass ** 0.678),
    };
  }
  return {
    sun,
    light,
    sky: {
      zenith: lerp('#1c2740', '#7fa6d6', light),
      horizon: lerp('#33415e', '#dce6ee', light),
      ground: lerp('#0b0d10', '#8a8a84', light),
      nits: NIGHT_NITS + SKY_NITS * light,
    },
  };
}

/**
 * The sky as an equirectangular picture (float, linear): zenith to horizon above, the far
 * ground below. Even all round, so it doesn't matter which way it faces.
 */
export function skyTexture(sky: SkyLight, width = 64, height = 32): THREE.DataTexture {
  const data = new Float32Array(width * height * 4);
  const c = new THREE.Color();
  for (let y = 0; y < height; y++) {
    // Row 0 looks straight down, the last row straight up (three's equirect, flipY off).
    const up = -Math.cos((Math.PI * (y + 0.5)) / height);
    if (up >= 0) c.copy(sky.horizon).lerp(sky.zenith, up ** 0.6);
    else c.copy(sky.ground);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = c.r * sky.nits;
      data[i + 1] = c.g * sky.nits;
      data[i + 2] = c.b * sky.nits;
      data[i + 3] = 1;
    }
  }
  const t = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** A flush ceiling light (its bulb under its body) shines down as a spot; others all round. */
export function isSpotLamp(assetId: string): boolean {
  const kind = furnitureKind(assetId);
  return !!kind?.ceiling && !!kind.light && kind.light.at[2] < 0;
}

/** A spot light with a bulb of `radius`, as the path tracer reads it. */
type RoundSpot = THREE.SpotLight & { radius?: number };

/**
 * Every lamp on the level as a light (no nearest-eight cap, no fade-out distance: walls
 * block them now): flush ceiling lights a spot shining down, the rest a point at the bulb.
 */
export function lampLights(level: Level): THREE.Light[] {
  const out: THREE.Light[] = [];
  for (const l of itemLights(level)) {
    const item = level.items[l.itemId];
    const at = new THREE.Vector3(l.position.x, l.position.y, l.position.z);
    if (item && isSpotLamp(item.assetId)) {
      const s: RoundSpot = new THREE.SpotLight(l.color, l.candela, 0, SPOT_ANGLE, SPOT_PENUMBRA, 2);
      s.radius = SPOT_RADIUS;
      s.position.copy(at);
      s.name = `lamp:${l.itemId}`;
      // Straight down: its target a metre under it, carried with it.
      s.add(s.target);
      s.target.position.set(0, -1, 0);
      out.push(s);
    } else {
      const p = new THREE.PointLight(l.color, l.candela, 0, 2);
      p.position.copy(at);
      p.name = `lamp:${l.itemId}`;
      out.push(p);
    }
  }
  return out;
}

export interface ExactSceneOptions {
  /** Ceilings on: a view from inside (eye height, the walk); off for a cut-away orbit view. */
  ceilings: boolean;
  models?: ModelSource;
  daylight: Daylight;
  lamps: boolean;
  /** Inside doors' open fractions as the 3D view has them (a walk opens doors as it nears). */
  doors?: ReadonlyMap<string, number>;
}

export interface ExactScene {
  scene: THREE.Scene;
  meshes: LevelMeshes;
  sun: THREE.DirectionalLight | null;
  lamps: THREE.Light[];
  dispose(): void;
}

/** Names the exact render adds to the level's meshes (the rest are `LevelMeshes`'s own). */
export const EXACT_EXTRAS = { ground: 'exact:ground', sun: 'exact:sun' } as const;

export function buildExactScene(level: Level, opts: ExactSceneOptions): ExactScene {
  const scene = new THREE.Scene();
  const materials = new PhotoMaterials(opts.lamps);
  const meshes = new LevelMeshes(materials, { ceilings: opts.ceilings, models: opts.models });
  meshes.update(level);
  for (const [id, open] of opts.doors ?? []) meshes.setDoorOpen(id, open);
  // Models' own materials, made ready (and a lamp's let its bulb shine through).
  meshes.group.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.userData.shared) return;
    let p: THREE.Object3D | null = o;
    while (p && !p.name.startsWith('item:')) p = p.parent;
    const item = p ? level.items[p.name.slice(5)] : undefined;
    const shade = !!(item && furnitureKind(item.assetId)?.light);
    o.material = Array.isArray(o.material)
      ? o.material.map((m) => materials.model(m, shade))
      : materials.model(o.material, shade);
  });
  scene.add(meshes.group);

  const b = levelBounds(level);
  const cx = b ? (b.min.x + b.max.x) / 2 : 0;
  const cz = b ? (b.min.y + b.max.y) / 2 : 0;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ color: GROUND_COLOR, roughness: 1 }),
  );
  ground.name = EXACT_EXTRAS.ground;
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(cx, level.elevation - GROUND_DROP, cz);
  scene.add(ground);

  const sky = skyTexture(opts.daylight.sky);
  scene.environment = sky;
  scene.background = sky;

  let sun: THREE.DirectionalLight | null = null;
  const s = opts.daylight.sun;
  if (s) {
    sun = new THREE.DirectionalLight(s.color, s.intensity);
    sun.name = EXACT_EXTRAS.sun;
    sun.target.position.set(cx, level.elevation, cz);
    sun.position.copy(s.direction).multiplyScalar(100).add(sun.target.position);
    scene.add(sun, sun.target);
  }
  const lamps = opts.lamps ? lampLights(level) : [];
  for (const l of lamps) scene.add(l);
  scene.updateMatrixWorld(true);

  return {
    scene,
    meshes,
    sun,
    lamps,
    dispose() {
      meshes.dispose();
      materials.dispose();
      ground.geometry.dispose();
      (ground.material as THREE.Material).dispose();
      sky.dispose();
    },
  };
}

/** The camera of a view, exactly: its position, where it looks, its up and its lens. */
export function exactCamera(c: SceneCamera, near = 0.02): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(c.fov), c.aspect, near, 500);
  cam.position.set(c.position.x, c.position.y, c.position.z);
  if (c.up) cam.up.set(c.up.x, c.up.y, c.up.z);
  cam.lookAt(c.target.x, c.target.y, c.target.z);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return cam;
}
