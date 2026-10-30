import {
  type Level,
  type Opening,
  type Vec2,
  type WallFrame,
  framePoint,
  openingsOnWall,
  roomPolygon,
  wallFootprints,
  wallFrame,
  wallPieces,
} from '@dhd/core';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { extrudePolygon } from './extrude';
import type { MaterialCache } from './materials';

export interface LevelMeshOptions {
  /** Hide ceilings in orbit view so the camera can see in. */
  ceilings?: boolean;
}

interface Part {
  key: string;
  meshes: THREE.Mesh[];
}

export interface UpdateStats {
  built: number;
  reused: number;
  removed: number;
}

const r = (n: number) => Math.round(n * 1e6) / 1e6;
const pointsKey = (pts: readonly Vec2[]) => pts.map((p) => `${r(p.x)},${r(p.y)}`).join(';');

/**
 * The 3D meshes of one level, rebuilt incrementally. Every wall, junction hub, floor and
 * ceiling is its own mesh, cached under a key made of everything that shapes it (for a
 * wall: its mitred outline, height, openings and material). `update` rebuilds only the
 * parts whose key changed, so dragging a corner touches the few walls that meet there.
 */
export class LevelMeshes {
  readonly group = new THREE.Group();
  private parts = new Map<string, Part>();

  constructor(
    private readonly materials: MaterialCache,
    private readonly opts: LevelMeshOptions = {},
  ) {
    this.group.name = 'level';
  }

  update(level: Level): UpdateStats {
    const stats: UpdateStats = { built: 0, reused: 0, removed: 0 };
    const seen = new Set<string>();
    const put = (id: string, key: string, build: () => THREE.Mesh[]) => {
      seen.add(id);
      const cur = this.parts.get(id);
      if (cur && cur.key === key) {
        stats.reused++;
        return;
      }
      if (cur) this.drop(cur);
      const meshes = build();
      for (const m of meshes) this.group.add(m);
      this.parts.set(id, { key, meshes });
      stats.built++;
    };

    const footprints = wallFootprints(level);
    const hubHeight = new Map<string, number>();

    for (const wall of Object.values(level.walls)) {
      const f = wallFrame(level, wall, footprints.walls[wall.id]);
      if (!f) continue;
      const height = wall.height ?? level.ceilingHeight;
      for (const vid of [wall.a, wall.b]) {
        hubHeight.set(vid, Math.min(hubHeight.get(vid) ?? Number.POSITIVE_INFINITY, height));
      }
      const openings = openingsOnWall(level, wall.id).sort((p, q) => p.id.localeCompare(q.id));
      const key = [
        pointsKey([f.a, f.d]),
        r(f.length),
        r(f.half),
        f.left.map(r).join(),
        f.right.map(r).join(),
        r(height),
        r(level.elevation),
        wall.materialLeft,
        openings.map((o) => [o.kind, r(o.t), r(o.width), r(o.height), r(o.sill)].join()).join('|'),
      ].join('/');
      put(`wall:${wall.id}`, key, () => this.buildWall(f, height, level.elevation, openings));
    }

    for (const hub of footprints.hubs) {
      const h = hubHeight.get(hub.vertexId) ?? level.ceilingHeight;
      const key = `${pointsKey(hub.polygon)}/${r(h)}/${r(level.elevation)}`;
      put(`hub:${hub.vertexId}`, key, () => {
        const mesh = new THREE.Mesh(
          extrudePolygon(hub.polygon, level.elevation, level.elevation + h),
          this.materials.get('paint-white'),
        );
        mesh.name = `hub:${hub.vertexId}`;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        return [mesh];
      });
    }

    for (const room of Object.values(level.rooms)) {
      let pts: Vec2[];
      try {
        pts = roomPolygon(level, room);
      } catch {
        continue; // a loop that references a missing corner draws nothing
      }
      const ceilingY = level.elevation + (room.ceilingHeight ?? level.ceilingHeight);
      const key = `${pointsKey(pts)}/${room.floorMaterial}/${room.ceilingMaterial}/${r(level.elevation)}/${r(ceilingY)}/${!!this.opts.ceilings}`;
      put(`room:${room.id}`, key, () =>
        this.buildRoom(
          room.id,
          pts,
          level.elevation,
          ceilingY,
          room.floorMaterial,
          room.ceilingMaterial,
        ),
      );
    }

    for (const [id, part] of this.parts) {
      if (seen.has(id)) continue;
      this.drop(part);
      this.parts.delete(id);
      stats.removed++;
    }
    return stats;
  }

  dispose(): void {
    for (const part of this.parts.values()) this.drop(part);
    this.parts.clear();
  }

  private drop(part: Part) {
    for (const m of part.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
    }
  }

  private buildWall(
    f: WallFrame,
    height: number,
    elevation: number,
    openings: Opening[],
  ): THREE.Mesh[] {
    const pieces: THREE.BufferGeometry[] = [];
    for (const p of wallPieces(f.length, height, openings)) {
      // End pieces follow the mitred outline; pieces between openings are plain boxes.
      const span = (s: [number, number]): [number, number] => {
        const u0 = p.u0 === 0 ? s[0] : p.u0;
        const u1 = p.u1 === f.length ? s[1] : p.u1;
        return u1 > u0 ? [u0, u1] : [(u0 + u1) / 2, (u0 + u1) / 2];
      };
      const [l0, l1] = span(f.left);
      const [r0, r1] = span(f.right);
      if (l1 - l0 < 1e-6 && r1 - r0 < 1e-6) continue;
      const poly = [
        framePoint(f, l0, 1),
        framePoint(f, l1, 1),
        framePoint(f, r1, -1),
        framePoint(f, r0, -1),
      ];
      pieces.push(extrudePolygon(poly, elevation + p.y0, elevation + p.y1));
    }
    const out: THREE.Mesh[] = [];
    const merged = pieces.length ? mergeGeometries(pieces) : null;
    for (const g of pieces) g.dispose();
    if (merged) {
      const mesh = new THREE.Mesh(merged, this.materials.get(f.wall.materialLeft));
      mesh.name = `wall:${f.wall.id}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { kind: 'wall', wallId: f.wall.id };
      out.push(mesh);
    }

    const glass: THREE.BufferGeometry[] = [];
    for (const o of openings) {
      if (o.kind !== 'window') continue;
      const c = o.t * f.length;
      const thin = { ...f, half: 0.005 };
      const u0 = c - o.width / 2;
      const u1 = c + o.width / 2;
      const poly = [
        framePoint(thin, u0, 1),
        framePoint(thin, u1, 1),
        framePoint(thin, u1, -1),
        framePoint(thin, u0, -1),
      ];
      glass.push(extrudePolygon(poly, elevation + o.sill, elevation + o.sill + o.height));
    }
    const glassGeom = glass.length ? mergeGeometries(glass) : null;
    for (const g of glass) g.dispose();
    if (glassGeom) {
      const mesh = new THREE.Mesh(glassGeom, this.materials.glass);
      mesh.name = `glass:${f.wall.id}`;
      mesh.renderOrder = 1;
      out.push(mesh);
    }
    return out;
  }

  private buildRoom(
    id: string,
    pts: Vec2[],
    elevation: number,
    ceilingY: number,
    floorMaterial: string,
    ceilingMaterial: string,
  ): THREE.Mesh[] {
    // Shape lives in XY; rotating -90° about X sends shape (x, y) to world (x, 0, -y),
    // so negate y to land plan y on world +z.
    const floorGeom = new THREE.ShapeGeometry(
      new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, -p.y))),
    );
    floorGeom.rotateX(-Math.PI / 2);
    const floor = new THREE.Mesh(floorGeom, this.materials.get(floorMaterial));
    floor.name = `floor:${id}`;
    floor.position.y = elevation + 0.001;
    floor.receiveShadow = true;
    floor.userData = { kind: 'floor', roomId: id };
    const out = [floor];
    if (this.opts.ceilings) {
      // +90° about X sends (x, y) to (x, 0, y) and turns the face normal downwards.
      const ceilGeom = new THREE.ShapeGeometry(
        new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, p.y))),
      );
      ceilGeom.rotateX(Math.PI / 2);
      const ceil = new THREE.Mesh(ceilGeom, this.materials.get(ceilingMaterial));
      ceil.name = `ceiling:${id}`;
      ceil.position.y = ceilingY;
      out.push(ceil);
    }
    return out;
  }
}
