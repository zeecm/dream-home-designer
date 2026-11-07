import {
  type Level,
  type PlanGeometry,
  type SceneCamera,
  type Site,
  type SkyOpening,
  type SunPosition,
  daylight,
  furnitureKind,
  groundInSun,
  itemLights,
  levelBounds,
  planGeometry,
  revealPasses,
  skyOpenings,
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
      // A clear sky's blue, held back a little: it lights the rooms as much as it is seen.
      zenith: lerp('#1c2740', '#9cb8da', light),
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
  for (let y = 0; y < height; y++) {
    // Row 0 looks straight down, the last row straight up (three's equirect, flipY off).
    const c = skyRadiance(sky, -Math.cos((Math.PI * (y + 0.5)) / height)).multiplyScalar(
      1 / sky.nits,
    );
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

/**
 * The sky's radiance (linear RGB, cd/m²) looking `up` (the direction's height, -1 to 1): the
 * horizon's colour blending to the zenith's above, the far ground's below.
 */
export function skyRadiance(sky: SkyLight, up: number): THREE.Color {
  const c = up >= 0 ? sky.horizon.clone().lerp(sky.zenith, up ** 0.6) : sky.ground.clone();
  return c.multiplyScalar(sky.nits);
}

/**
 * The radiance an even (Lambertian) light filling a wall opening needs to let in what the sky
 * lets in through it: the irradiance the sky above the horizon gives the opening, over π. The
 * sky is even all round, so only how high each direction looks matters:
 * E = 2 ∫ L(sin φ) cos² φ dφ over the sky's half of the view.
 */
export function portalRadiance(sky: SkyLight): THREE.Color {
  const n = 64;
  const sum = new THREE.Color(0, 0, 0);
  for (let i = 0; i < n; i++) {
    const phi = ((i + 0.5) / n) * (Math.PI / 2);
    const w = Math.cos(phi) ** 2 * (Math.PI / 2 / n);
    sum.add(skyRadiance(sky, Math.sin(phi)).multiplyScalar(w));
  }
  return sum.multiplyScalar(2 / Math.PI);
}

/**
 * The ground outside's radiance from the sky's light alone (linear RGB, cd/m²): its colour lit
 * by the open sky, E = 2π ∫ L(sin φ) sin φ cos φ dφ, over π. With portals the sky lights
 * nothing itself, so the ground gives this off (the sun still lights it, and shades it).
 */
export function skyOnGround(sky: SkyLight): THREE.Color {
  const n = 64;
  const lux = new THREE.Color(0, 0, 0);
  for (let i = 0; i < n; i++) {
    const phi = ((i + 0.5) / n) * (Math.PI / 2);
    const w = 2 * Math.PI * Math.sin(phi) * Math.cos(phi) * (Math.PI / 2 / n);
    lux.add(skyRadiance(sky, Math.sin(phi)).multiplyScalar(w));
  }
  return lux.multiply(new THREE.Color(GROUND_COLOR)).multiplyScalar(1 / Math.PI);
}

/**
 * The cap on a single sample (cd/m²) for each light the tracer can choose from: twice what the
 * brightest thing in the scene can really give (a white wall in full sun; a surface a hand's
 * width from a lamp), so only a rare runaway path (a glossy bounce onto the sun's patch) that
 * would leave a speck is cut. The tracer aims each sample at one light picked at random and
 * scales what it finds by how many there are (`lightChoices`), so the cap the picture uses is
 * this times that count: a sunlit wall's one direct sample is never cut.
 */
export function sampleClamp(daylight: Daylight): number {
  const sunlit = daylight.sun ? (0.9 * daylight.sun.intensity) / Math.PI : 0;
  return 2 * Math.max(sunlit, 10_000);
}

/**
 * How many lights the tracer picks among for each sample, by its own rule (three-gpu-pathtracer
 * 0.0.23, `getLights` and the shader's `lightsDenom`): every visible rect area, spot, point and
 * directional light, whatever its intensity, and the sky if it lights the scene. It picks one
 * at random and scales its find by the count. Give it the scene the tracer is given.
 */
export function lightChoices(scene: THREE.Scene): number {
  let n = 0;
  scene.traverse((o) => {
    const l = o as THREE.Object3D & {
      isRectAreaLight?: boolean;
      isSpotLight?: boolean;
      isPointLight?: boolean;
      isDirectionalLight?: boolean;
    };
    if (l.visible && (l.isRectAreaLight || l.isSpotLight || l.isPointLight || l.isDirectionalLight))
      n++;
  });
  return Math.max(1, n + (scene.environment && scene.environmentIntensity !== 0 ? 1 : 0));
}

/**
 * How much of the ground's light reaches the rooms through a window, against an even view of
 * open ground (its sunlit share as `groundInSun` finds it) filling the lower half of the view.
 * Measured against the tracer finding the ground itself (long renders, `HANDOVER.md`): less
 * than the view suggests, as what lies just below a window is the house's own wall, and the
 * ground beside the house sees only part of the sky.
 */
export const GROUND_REACHES = 0.37;

/** Open ground's radiance from the sun alone (linear RGB, cd/m²). */
export function sunOnGround(daylight: Daylight): THREE.Color {
  const sun = daylight.sun;
  if (!sun) return new THREE.Color(0, 0, 0);
  return sun.color
    .clone()
    .multiply(new THREE.Color(GROUND_COLOR))
    .multiplyScalar((sun.intensity * Math.max(0, sun.direction.y)) / Math.PI);
}

/** Open ground's radiance outside (linear RGB, cd/m²): its colour lit by the sun and the sky. */
export function groundRadiance(daylight: Daylight): THREE.Color {
  return skyOnGround(daylight.sky).add(sunOnGround(daylight));
}

/** Lights in the sky's openings: their names start with this, then the opening's id. */
export const PORTAL = 'portal:';

/** Clear glass lets this much of the light through (its colour, #f4faf8, in linear light). */
export const GLASS_PASSES = 0.9;

/** Below this much daylight (`Daylight.light`) the sky's light is too little to aim at. */
export const PORTALS_FROM = 0.05;

/**
 * The radiance a portal gives (linear RGB, cd/m²): the sky's (`portalRadiance`), and the
 * ground's below it (open ground's sky-lit radiance, and its sunlit radiance as much as it is in
 * the sun, `groundInSun`; half of it, the lower half of the view; as much as reaches the rooms,
 * `GROUND_REACHES`), less what the reveal behind it hides (`revealPasses`) and the glass takes.
 */
export function portalLight(
  level: Level,
  o: SkyOpening,
  daylight: Daylight,
  reaches = GROUND_REACHES,
  geom?: PlanGeometry,
): THREE.Color {
  const ground = skyOnGround(daylight.sky);
  const s = daylight.sun;
  if (s) {
    const dir = { x: s.direction.x, y: s.direction.y, z: s.direction.z };
    ground.add(sunOnGround(daylight).multiplyScalar(groundInSun(level, o, dir, geom)));
  }
  return portalRadiance(daylight.sky)
    .add(ground.multiplyScalar(0.5 * reaches))
    .multiplyScalar(revealPasses(o.width, o.height, o.depth) * (o.glazed ? GLASS_PASSES : 1));
}

/**
 * A light in each opening that lets the sky into a room (`skyOpenings`) of the rooms given (all
 * if none), carrying the light that comes in through it (`portalLight`): an even rectangle the
 * opening's size, flat in it just inside the pane (the reveal's sill, jambs and head on the
 * room's side of it lit, nothing of it reaching into the room), shining in. The tracer aims
 * samples at lights, so a room's daylight is found every sample, where the sky and the sunlit
 * ground alone are found only by rays that chance on a window, in specks. Inside the pane, a ray
 * from the room meets it before the pane, and the tracer weighs that hit against the bounce
 * that sent it (behind the pane it would weigh it against the pane, and count it twice).
 */
export function portalLights(level: Level, daylight: Daylight, rooms?: ReadonlySet<string>) {
  const out: THREE.RectAreaLight[] = [];
  const geom = planGeometry(level);
  for (const o of skyOpenings(level, geom)) {
    if (rooms && !rooms.has(o.roomId)) continue;
    const c = portalLight(level, o, daylight, GROUND_REACHES, geom);
    const peak = Math.max(c.r, c.g, c.b);
    if (!(peak > 0)) continue;
    const at = new THREE.Vector3(o.at.x, level.elevation + o.bottom + o.height / 2, o.at.y);
    const light = new THREE.RectAreaLight(
      new THREE.Color(c.r / peak, c.g / peak, c.b / peak),
      peak,
      o.width,
      o.height,
    );
    light.name = `${PORTAL}${o.id}`;
    light.position.copy(at);
    // Lights look along -z: into the room, its width along the wall.
    light.lookAt(at.x - o.out.x, at.y, at.z - o.out.y);
    light.updateMatrixWorld();
    out.push(light);
  }
  return out;
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

/**
 * The parts of lamp models that hold the bulb (their box around it), whose material lets
 * the bulb's light through; the base, pole and arm still cast shadows. A model with no part
 * round its bulb gives up its nearest one.
 */
export function lampShades(group: THREE.Object3D, level: Level): Set<THREE.Mesh> {
  group.updateMatrixWorld(true);
  const bulbs = new Map(itemLights(level).map((l) => [l.itemId, l.position]));
  const parts = new Map<string, THREE.Mesh[]>();
  group.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.userData.shared) return;
    let p: THREE.Object3D | null = o;
    while (p && !p.name.startsWith('item:')) p = p.parent;
    const id = p?.name.slice(5);
    if (!id || !bulbs.has(id)) return;
    const list = parts.get(id) ?? [];
    list.push(o);
    parts.set(id, list);
  });
  const out = new Set<THREE.Mesh>();
  for (const [id, list] of parts) {
    const b = bulbs.get(id);
    if (!b) continue;
    const bulb = new THREE.Vector3(b.x, b.y, b.z);
    const boxes = list.map((m) => {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      return (m.geometry.boundingBox as THREE.Box3).clone().applyMatrix4(m.matrixWorld);
    });
    const round = list.filter((_, i) => boxes[i]?.clone().expandByScalar(0.03).containsPoint(bulb));
    if (round.length) {
      for (const m of round) out.add(m);
      continue;
    }
    let best = 0;
    boxes.forEach((box, i) => {
      if (box.distanceToPoint(bulb) < (boxes[best] as THREE.Box3).distanceToPoint(bulb)) best = i;
    });
    const nearest = list[best];
    if (nearest) out.add(nearest);
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
  /**
   * Lights in the openings that let the sky in (`portalLights`), for a view from inside (with
   * ceilings): `true` for every room, or the rooms to light (`daylightReach`). If there are
   * any (and it is day, `PORTALS_FROM`), the sky lights the rooms only through them, and is
   * seen (through windows, and as the backdrop) but lights nothing; if none, the sky lights
   * the scene as without.
   */
  portals?: boolean | ReadonlySet<string>;
}

export interface ExactScene {
  scene: THREE.Scene;
  meshes: LevelMeshes;
  sun: THREE.DirectionalLight | null;
  lamps: THREE.Light[];
  portals: THREE.RectAreaLight[];
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
  // Models' own materials, made ready; in a lamp, its shade lets the bulb's light out.
  const shades = lampShades(meshes.group, level);
  meshes.group.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.userData.shared) return;
    const shade = shades.has(o);
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
    // Two-sided, as every surface here (see PhotoMaterials).
    new THREE.MeshStandardMaterial({ color: GROUND_COLOR, roughness: 1, side: THREE.DoubleSide }),
  );
  ground.name = EXACT_EXTRAS.ground;
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(cx, level.elevation - GROUND_DROP, cz);
  scene.add(ground);

  const sky = skyTexture(opts.daylight.sky);
  let backdrop: THREE.DataTexture | null = null;
  scene.environment = sky;
  scene.background = sky;
  // With portals the sky's light comes through them alone: the sky lights nothing directly (it
  // would twice), and is still seen, through the windows and as the backdrop. Without any (no
  // opening to the sky in reach, or night), the sky lights the scene itself.
  const portals =
    opts.portals && opts.daylight.light >= PORTALS_FROM
      ? portalLights(level, opts.daylight, opts.portals === true ? undefined : opts.portals)
      : [];
  if (portals.length) {
    scene.environmentIntensity = 0;
    // The ground's light comes in through the portals too: a ray from a room that passes out
    // through an opening goes through the ground (as a shadow ray does through anything that
    // casts none), where it would count it twice and, found only by chance, in specks.
    (ground.material as THREE.Material & { castShadow?: boolean }).castShadow = false;
    // Seen through the glass (rays the tracer treats as shadow rays, which pass it too), the
    // backdrop below the horizon shows the ground as it looks lit. Seen straight on (through
    // an open passage), the ground is there; the sky lights nothing, so it gives off the sky's
    // share itself.
    const look = groundRadiance(opts.daylight).multiplyScalar(1 / opts.daylight.sky.nits);
    backdrop = skyTexture({ ...opts.daylight.sky, ground: look });
    scene.background = backdrop;
    const glow = skyOnGround(opts.daylight.sky);
    const peak = Math.max(glow.r, glow.g, glow.b, 1e-9);
    const m = ground.material as THREE.MeshStandardMaterial;
    m.emissive.setRGB(glow.r / peak, glow.g / peak, glow.b / peak);
    m.emissiveIntensity = peak;
  }
  for (const p of portals) scene.add(p);

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
    portals,
    dispose() {
      meshes.dispose();
      materials.dispose();
      ground.geometry.dispose();
      (ground.material as THREE.Material).dispose();
      sky.dispose();
      backdrop?.dispose();
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
