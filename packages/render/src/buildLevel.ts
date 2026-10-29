import { type Level, openingsOnWall, roomPolygon, wallLine, wallPieces } from '@dhd/core';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MaterialCache } from './materials';

export interface BuildOptions {
  materials: MaterialCache;
  /** Hide ceilings in orbit view so the camera can see in. */
  ceilings?: boolean;
}

/** Plan (x, y) -> world (x, elevation, y). */
function placeOnWall(
  geom: THREE.BufferGeometry,
  origin: { x: number; y: number },
  angle: number,
  elevation: number,
) {
  geom.applyMatrix4(
    new THREE.Matrix4().compose(
      new THREE.Vector3(origin.x, elevation, origin.y),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle),
      new THREE.Vector3(1, 1, 1),
    ),
  );
}

/**
 * Builds static meshes for one level. Walls are merged into one mesh per material, so a
 * 40-wall plan is a handful of draw calls. Phase 1 replaces full rebuilds with a
 * per-wall hash diff.
 */
export function buildLevel(level: Level, opts: BuildOptions): THREE.Group {
  const group = new THREE.Group();
  group.name = `level:${level.id}`;
  const wallGeoms = new Map<string, THREE.BufferGeometry[]>();
  const glassGeoms: THREE.BufferGeometry[] = [];

  for (const wall of Object.values(level.walls)) {
    const line = wallLine(level, wall);
    if (line.length < 1e-6) continue;
    const height = wall.height ?? level.ceilingHeight;
    const openings = openingsOnWall(level, wall.id);
    const half = wall.thickness / 2;

    for (const p of wallPieces(line.length, height, openings)) {
      // Extend end pieces by half the thickness so corners close. Phase 1 mitres them.
      const u0 = p.u0 === 0 ? -half : p.u0;
      const u1 = p.u1 === line.length ? line.length + half : p.u1;
      const g = new THREE.BoxGeometry(u1 - u0, p.y1 - p.y0, wall.thickness);
      g.translate((u0 + u1) / 2, (p.y0 + p.y1) / 2, 0);
      placeOnWall(g, line.a, line.angle, level.elevation);
      const list = wallGeoms.get(wall.materialLeft) ?? [];
      list.push(g);
      wallGeoms.set(wall.materialLeft, list);
    }

    for (const o of openings) {
      if (o.kind !== 'window') continue;
      const g = new THREE.BoxGeometry(o.width, o.height, 0.01);
      g.translate(o.t * line.length, o.sill + o.height / 2, 0);
      placeOnWall(g, line.a, line.angle, level.elevation);
      glassGeoms.push(g);
    }
  }

  for (const [materialId, geoms] of wallGeoms) {
    const merged = mergeGeometries(geoms);
    for (const g of geoms) g.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, opts.materials.get(materialId));
    mesh.name = `walls:${materialId}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  if (glassGeoms.length > 0) {
    const merged = mergeGeometries(glassGeoms);
    for (const g of glassGeoms) g.dispose();
    if (merged) {
      const glass = new THREE.Mesh(merged, opts.materials.glass);
      glass.name = 'glass';
      glass.renderOrder = 1;
      group.add(glass);
    }
  }

  for (const room of Object.values(level.rooms)) {
    const pts = roomPolygon(level, room);
    // Shape lives in XY; rotating -90° about X sends shape (x, y) to world (x, 0, -y),
    // so negate y to land plan y on world +z.
    const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, -p.y)));
    const floorGeom = new THREE.ShapeGeometry(shape);
    floorGeom.rotateX(-Math.PI / 2);
    const floor = new THREE.Mesh(floorGeom, opts.materials.get(room.floorMaterial));
    floor.name = `floor:${room.id}`;
    floor.position.y = level.elevation + 0.001;
    floor.receiveShadow = true;
    floor.userData = { kind: 'floor', roomId: room.id };
    group.add(floor);

    if (opts.ceilings) {
      // +90° about X sends (x, y) to (x, 0, y) and turns the face normal downwards.
      const ceilShape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, p.y)));
      const ceilGeom = new THREE.ShapeGeometry(ceilShape);
      ceilGeom.rotateX(Math.PI / 2);
      const ceil = new THREE.Mesh(ceilGeom, opts.materials.get(room.ceilingMaterial));
      ceil.name = `ceiling:${room.id}`;
      ceil.position.y = level.elevation + (room.ceilingHeight ?? level.ceilingHeight);
      group.add(ceil);
    }
  }

  return group;
}

export function disposeGroup(group: THREE.Object3D): void {
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose();
  });
}
