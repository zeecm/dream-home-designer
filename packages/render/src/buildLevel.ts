import {
  type Level,
  type Vec2,
  footprintSpans,
  openingsOnWall,
  roomPolygon,
  wallFootprints,
  wallLine,
  wallPieces,
} from '@dhd/core';
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

  const footprints = wallFootprints(level);
  const hubHeight = new Map<string, number>();
  const addWallGeom = (materialId: string, g: THREE.BufferGeometry) => {
    const list = wallGeoms.get(materialId) ?? [];
    list.push(g);
    wallGeoms.set(materialId, list);
  };

  for (const wall of Object.values(level.walls)) {
    const line = wallLine(level, wall);
    const fp = footprints.walls[wall.id];
    if (line.length < 1e-6 || !fp) continue;
    const height = wall.height ?? level.ceilingHeight;
    for (const vid of [wall.a, wall.b]) {
      hubHeight.set(vid, Math.min(hubHeight.get(vid) ?? Number.POSITIVE_INFINITY, height));
    }
    const openings = openingsOnWall(level, wall.id);
    const half = wall.thickness / 2;
    const d = { x: Math.cos(-line.angle), y: Math.sin(-line.angle) };
    const n = { x: -d.y, y: d.x };
    const spans = footprintSpans(fp, line.a, d);
    const at = (u: number, side: number): Vec2 => ({
      x: line.a.x + d.x * u + n.x * half * side,
      y: line.a.y + d.y * u + n.y * half * side,
    });

    for (const p of wallPieces(line.length, height, openings)) {
      // End pieces follow the mitred outline; pieces between openings are plain boxes.
      const span = (s: [number, number]): [number, number] => {
        const u0 = p.u0 === 0 ? s[0] : p.u0;
        const u1 = p.u1 === line.length ? s[1] : p.u1;
        return u1 > u0 ? [u0, u1] : [(u0 + u1) / 2, (u0 + u1) / 2];
      };
      const [l0, l1] = span(spans.left);
      const [r0, r1] = span(spans.right);
      if (l1 - l0 < 1e-6 && r1 - r0 < 1e-6) continue;
      const poly = [at(l0, 1), at(l1, 1), at(r1, -1), at(r0, -1)];
      addWallGeom(
        wall.materialLeft,
        extrudePolygon(poly, level.elevation + p.y0, level.elevation + p.y1),
      );
    }

    for (const o of openings) {
      if (o.kind !== 'window') continue;
      const g = new THREE.BoxGeometry(o.width, o.height, 0.01);
      g.translate(o.t * line.length, o.sill + o.height / 2, 0);
      placeOnWall(g, line.a, line.angle, level.elevation);
      glassGeoms.push(g);
    }
  }

  for (const hub of footprints.hubs) {
    const h = hubHeight.get(hub.vertexId) ?? level.ceilingHeight;
    addWallGeom('paint-white', extrudePolygon(hub.polygon, level.elevation, level.elevation + h));
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

/**
 * Extrudes a convex plan polygon between two heights into a non-indexed prism with flat
 * normals and simple UVs (metres along each face). Winding is fixed per triangle, so the
 * polygon may come in either orientation.
 */
export function extrudePolygon(
  poly: readonly Vec2[],
  y0: number,
  y1: number,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const c = poly.reduce(
    (acc, p) => ({ x: acc.x + p.x / poly.length, y: acc.y + p.y / poly.length }),
    {
      x: 0,
      y: 0,
    },
  );
  const centre = new THREE.Vector3(c.x, (y0 + y1) / 2, c.y);
  const tri = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    d: THREE.Vector3,
    outward: THREE.Vector3,
    uvs: number[],
  ) => {
    const nrm = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a));
    if (nrm.lengthSq() < 1e-18) return;
    if (nrm.dot(outward) < 0) {
      pos.push(a.x, a.y, a.z, d.x, d.y, d.z, b.x, b.y, b.z);
      uv.push(uvs[0]!, uvs[1]!, uvs[4]!, uvs[5]!, uvs[2]!, uvs[3]!);
    } else {
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z, d.x, d.y, d.z);
      uv.push(...uvs);
    }
  };
  const v = (p: Vec2, y: number) => new THREE.Vector3(p.x, y, p.y);
  const up = new THREE.Vector3(0, 1, 0);
  const down = new THREE.Vector3(0, -1, 0);
  const p0 = poly[0] as Vec2;
  for (let i = 1; i + 1 < poly.length; i++) {
    const p1 = poly[i] as Vec2;
    const p2 = poly[i + 1] as Vec2;
    const flat = [p0.x, p0.y, p1.x, p1.y, p2.x, p2.y];
    tri(v(p0, y1), v(p1, y1), v(p2, y1), up, flat);
    tri(v(p0, y0), v(p1, y0), v(p2, y0), down, flat);
  }
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as Vec2;
    const q = poly[(i + 1) % poly.length] as Vec2;
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len < 1e-9) continue;
    const mid = new THREE.Vector3((p.x + q.x) / 2, (y0 + y1) / 2, (p.y + q.y) / 2);
    const out = mid.sub(centre);
    tri(v(p, y0), v(q, y0), v(q, y1), out, [0, y0, len, y0, len, y1]);
    tri(v(p, y0), v(q, y1), v(p, y1), out, [0, y0, len, y1, 0, y1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

export function disposeGroup(group: THREE.Object3D): void {
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose();
  });
}
