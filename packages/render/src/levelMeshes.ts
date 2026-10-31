import {
  type FurnitureMaterial,
  type Item,
  type Level,
  type Opening,
  type RoomShape,
  type Vec2,
  type WallFrame,
  doorLeaf,
  doorSwing,
  framePoint,
  furnitureKind,
  isBoundary,
  openingSpan,
  openingsOnWall,
  outsideOpenings,
  roomShapes,
  wallFootprints,
  wallFrame,
  wallPieces,
} from '@dhd/core';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { extrudePolygon } from './extrude';
import type { MaterialCache } from './materials';
import type { ModelSource } from './models';

export interface LevelMeshOptions {
  /** Hide ceilings in orbit view so the camera can see in. */
  ceilings?: boolean;
  /** Furniture models; without it every piece is drawn from its catalogue boxes. */
  models?: ModelSource;
}

interface Part {
  key: string;
  objects: THREE.Object3D[];
}

export interface UpdateStats {
  built: number;
  reused: number;
  removed: number;
}

const r = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Regroups a wall's triangles by which way they face: group 0 its left side (along `left`),
 * group 1 its right side, group 2 everything else.
 */
function bySide(g: THREE.BufferGeometry, left: THREE.Vector3): THREE.BufferGeometry {
  const src = g.index ? g.toNonIndexed() : g;
  const pos = src.getAttribute('position');
  const names = Object.keys(src.attributes);
  const tris: number[][] = [[], [], []];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < pos.count / 3; t++) {
    a.fromBufferAttribute(pos, t * 3);
    b.fromBufferAttribute(pos, t * 3 + 1);
    c.fromBufferAttribute(pos, t * 3 + 2);
    const n = b.sub(a).cross(c.sub(a)).normalize();
    const k = n.dot(left);
    (tris[k > 0.9 ? 0 : k < -0.9 ? 1 : 2] as number[]).push(t);
  }
  const out = new THREE.BufferGeometry();
  const order = tris.flat();
  for (const name of names) {
    const attr = src.getAttribute(name);
    const size = attr.itemSize;
    const data = new Float32Array(order.length * 3 * size);
    order.forEach((t, i) => {
      for (let v = 0; v < 3; v++) {
        for (let e = 0; e < size; e++) {
          data[(i * 3 + v) * size + e] = attr.getComponent(t * 3 + v, e);
        }
      }
    });
    out.setAttribute(name, new THREE.BufferAttribute(data, size));
  }
  let start = 0;
  tris.forEach((list, i) => {
    out.addGroup(start * 3, list.length * 3, i);
    start += list.length;
  });
  if (src !== g) src.dispose();
  return out;
}
const pointsKey = (pts: readonly Vec2[]) => pts.map((p) => `${r(p.x)},${r(p.y)}`).join(';');

/**
 * The 3D meshes of one level, rebuilt incrementally. Every wall, junction hub, door leaf,
 * floor and ceiling is its own mesh, cached under a key made of everything that shapes it
 * (for a wall: its mitred outline, height, openings and material). `update` rebuilds only
 * the parts whose key changed, so dragging a corner touches the few walls that meet there.
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
    const put = (id: string, key: string, build: () => THREE.Object3D[]) => {
      seen.add(id);
      const cur = this.parts.get(id);
      if (cur && cur.key === key) {
        stats.reused++;
        return;
      }
      if (cur) this.drop(cur);
      const objects = build();
      for (const o of objects) this.group.add(o);
      this.parts.set(id, { key, objects });
      stats.built++;
    };

    const footprints = wallFootprints(level);
    const hubHeight = new Map<string, number>();
    // Doors to the outside are shown shut; the rest stand open, as the plan draws them.
    const outside = outsideOpenings(level);

    for (const wall of Object.values(level.walls)) {
      if (isBoundary(wall)) continue; // a room edge, not something built
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
        wall.materialRight,
        openings.map((o) => [o.kind, r(o.t), r(o.width), r(o.height), r(o.sill)].join()).join('|'),
      ].join('/');
      put(`wall:${wall.id}`, key, () => this.buildWall(f, height, level.elevation, openings));
      for (const o of openings) {
        if (o.kind !== 'door') continue;
        const shut = outside.has(o.id);
        const leaf = doorLeaf(f, o, !shut);
        const top = level.elevation + Math.min(o.height, height);
        put(`door:${o.id}`, `${pointsKey(leaf)}/${r(level.elevation)}/${r(top)}`, () => {
          const mesh = new THREE.Mesh(
            extrudePolygon(leaf, level.elevation, top),
            this.materials.get('door'),
          );
          mesh.name = `door:${o.id}`;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          if (shut) return [mesh];
          // An inside door turns about its hinge: built standing open, it can swing shut
          // by `swing` radians (in plan) and back (setDoorOpen).
          const s = doorSwing(f, o);
          const open = { x: s.leafEnd.x - s.hinge.x, y: s.leafEnd.y - s.hinge.y };
          const closed = { x: s.arcEnd.x - s.hinge.x, y: s.arcEnd.y - s.hinge.y };
          const swing = Math.atan2(
            open.x * closed.y - open.y * closed.x,
            open.x * closed.x + open.y * closed.y,
          );
          const pivot = new THREE.Group();
          pivot.name = `door:${o.id}`;
          pivot.position.set(s.hinge.x, 0, s.hinge.y);
          mesh.position.set(-s.hinge.x, 0, -s.hinge.y);
          pivot.add(mesh);
          const [u0, u1] = openingSpan(f, o);
          const centre = framePoint(f, (u0 + u1) / 2, 0);
          pivot.userData = { door: o.id, swing, centre };
          return [pivot];
        });
      }
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

    const shapes = roomShapes(level);
    for (const room of Object.values(level.rooms)) {
      const shape = shapes.get(room.id);
      if (!shape) continue; // a loop that references a missing corner draws nothing
      const ceilingY = level.elevation + (room.ceilingHeight ?? level.ceilingHeight);
      const outline = [shape.outer, ...shape.holes].map(pointsKey).join('|');
      const key = `${outline}/${room.floorMaterial}/${room.ceilingMaterial}/${r(level.elevation)}/${r(ceilingY)}/${!!this.opts.ceilings}`;
      put(`room:${room.id}`, key, () =>
        this.buildRoom(
          room.id,
          shape,
          level.elevation,
          ceilingY,
          room.floorMaterial,
          room.ceilingMaterial,
        ),
      );
    }

    for (const item of Object.values(level.items)) {
      const { position: p, scale: k } = item;
      const key = [
        item.assetId,
        r(p.x),
        r(p.y),
        r(p.z),
        r(item.rotationY),
        r(k.x),
        r(k.y),
        r(k.z),
        r(level.elevation),
        // Rebuilt once its model arrives, to swap the stand-in for it.
        this.modelFor(item) ? 'model' : 'boxes',
      ].join('/');
      put(`item:${item.id}`, key, () => this.buildItem(item, level.elevation));
    }

    for (const [id, part] of this.parts) {
      if (seen.has(id)) continue;
      this.drop(part);
      this.parts.delete(id);
      stats.removed++;
    }
    return stats;
  }

  /** The inside doors that can swing, with where their doorway's middle is (plan x, y). */
  doors(): { id: string; centre: { x: number; y: number } }[] {
    const out: { id: string; centre: { x: number; y: number } }[] = [];
    for (const o of this.group.children) {
      if (o.userData.door) out.push({ id: o.userData.door, centre: o.userData.centre });
    }
    return out;
  }

  /** Swings an inside door: 1 standing open (as built and drawn in plan), 0 shut. */
  setDoorOpen(id: string, open: number): void {
    const part = this.parts.get(`door:${id}`);
    const pivot = part?.objects[0];
    if (!pivot?.userData.door) return;
    // A plan angle θ (counter-clockwise in x, y) is a turn of -θ about world +Y (x, z).
    pivot.rotation.y = -(pivot.userData.swing as number) * (1 - Math.min(1, Math.max(0, open)));
  }

  dispose(): void {
    for (const part of this.parts.values()) this.drop(part);
    this.parts.clear();
  }

  private drop(part: Part) {
    for (const o of part.objects) {
      this.group.remove(o);
      // A model's geometry belongs to the library, shared by every copy.
      o.traverse((m) => {
        if (m instanceof THREE.Mesh && !m.userData.shared) m.geometry.dispose();
      });
    }
  }

  /** The item's model file, if its kind has one and it has loaded. */
  private modelFor(item: Item): string | undefined {
    const file = furnitureKind(item.assetId)?.model;
    return file && this.opts.models?.has(file) ? file : undefined;
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
      // Each side takes its own paint; ends, tops and reveals stay white.
      const sided = bySide(merged, new THREE.Vector3(f.n.x, 0, f.n.y));
      merged.dispose();
      const mesh = new THREE.Mesh(sided, [
        this.materials.get(f.wall.materialLeft),
        this.materials.get(f.wall.materialRight),
        this.materials.get('paint-white'),
      ]);
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

  /**
   * A piece of furniture: its model, scaled to the item's size, or else its catalogue boxes,
   * scaled, one merged mesh per material (a model still loading shows as its box).
   */
  private buildItem(item: Item, elevation: number): THREE.Object3D[] {
    const kind = furnitureKind(item.assetId);
    if (!kind) return [];
    const k = item.scale;
    const model = kind.model ? this.opts.models?.get(kind.model) : null;
    if (model) {
      const g = new THREE.Group();
      g.add(model);
      g.name = `item:${item.id}`;
      // Model x is the width, y the height and z the depth, front +z, as the item's axes.
      // An uploaded model is fitted to its catalogue size (it may be in centimetres).
      const n = this.opts.models?.natural?.(kind.model ?? '');
      const fit = (size: number, own: number | undefined) => (own && own > 1e-6 ? size / own : 1);
      g.scale.set(
        k.x * fit(kind.size.w, n?.x),
        k.y * fit(kind.size.h, n?.y),
        k.z * fit(kind.size.d, n?.z),
      );
      g.position.set(item.position.x, elevation + item.position.y, item.position.z);
      g.rotation.y = -item.rotationY;
      g.userData = { kind: 'item', itemId: item.id };
      return [g];
    }
    const byMaterial = new Map<FurnitureMaterial, THREE.BufferGeometry[]>();
    for (const part of kind.parts) {
      // Item axes (x across, y back to front, z up) to the mesh's (x, z, y).
      const [x0, y0, z0] = part.min;
      const [x1, y1, z1] = part.max;
      const g = new THREE.BoxGeometry((x1 - x0) * k.x, (z1 - z0) * k.y, (y1 - y0) * k.z);
      g.translate(((x0 + x1) / 2) * k.x, ((z0 + z1) / 2) * k.y, ((y0 + y1) / 2) * k.z);
      const list = byMaterial.get(part.material) ?? [];
      list.push(g);
      byMaterial.set(part.material, list);
    }
    const out: THREE.Mesh[] = [];
    for (const [material, geoms] of byMaterial) {
      const merged = mergeGeometries(geoms);
      for (const g of geoms) g.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, this.materials.get(`furniture-${material}`));
      mesh.name = `item:${item.id}`;
      mesh.position.set(item.position.x, elevation + item.position.y, item.position.z);
      // Plan rotation r turns item x towards plan (cos r, sin r): about +Y that is -r.
      mesh.rotation.y = -item.rotationY;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { kind: 'item', itemId: item.id };
      out.push(mesh);
    }
    return out;
  }

  private buildRoom(
    id: string,
    shape: RoomShape,
    elevation: number,
    ceilingY: number,
    floorMaterial: string,
    ceilingMaterial: string,
  ): THREE.Mesh[] {
    const toShape = (flip: number) => {
      const s = new THREE.Shape(shape.outer.map((p) => new THREE.Vector2(p.x, flip * p.y)));
      for (const h of shape.holes) {
        s.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, flip * p.y))));
      }
      return s;
    };
    // Shape lives in XY; rotating -90° about X sends shape (x, y) to world (x, 0, -y),
    // so negate y to land plan y on world +z.
    const floorGeom = new THREE.ShapeGeometry(toShape(-1));
    floorGeom.rotateX(-Math.PI / 2);
    const floor = new THREE.Mesh(floorGeom, this.materials.get(floorMaterial));
    floor.name = `floor:${id}`;
    floor.position.y = elevation + 0.001;
    floor.receiveShadow = true;
    floor.userData = { kind: 'floor', roomId: id };
    const out = [floor];
    if (this.opts.ceilings) {
      // +90° about X sends (x, y) to (x, 0, y) and turns the face normal downwards.
      const ceilGeom = new THREE.ShapeGeometry(toShape(1));
      ceilGeom.rotateX(Math.PI / 2);
      const ceil = new THREE.Mesh(ceilGeom, this.materials.get(ceilingMaterial));
      ceil.name = `ceiling:${id}`;
      ceil.position.y = ceilingY;
      out.push(ceil);
    }
    return out;
  }
}
