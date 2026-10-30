import type { Level } from '@dhd/core';
import type * as THREE from 'three';
import { LevelMeshes } from './levelMeshes';
import type { MaterialCache } from './materials';

export { extrudePolygon } from './extrude';

export interface BuildOptions {
  materials: MaterialCache;
  /** Hide ceilings in orbit view so the camera can see in. */
  ceilings?: boolean;
}

/** Builds a level's meshes once. Editors keep a LevelMeshes and call update() instead. */
export function buildLevel(level: Level, opts: BuildOptions): THREE.Group {
  const meshes = new LevelMeshes(opts.materials, { ceilings: opts.ceilings });
  meshes.update(level);
  return meshes.group;
}

export function disposeGroup(group: THREE.Object3D): void {
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
  });
}
