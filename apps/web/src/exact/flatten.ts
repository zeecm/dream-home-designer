import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * The scene as the path tracer takes it: one mesh per material, in world space. The tracer
 * (0.0.23) gives each mesh one material, numbered by mesh, so a mesh with several (a wall's
 * two painted sides and its white ends, as geometry groups) would put the wrong material on
 * every mesh after it. Each group's triangles go to their own material's mesh here instead,
 * with their world transform baked in. The geometry is the same triangles, untouched;
 * lights, the sky and the backdrop come along as they are.
 */
export function flattenForTracing(scene: THREE.Scene): THREE.Scene {
  scene.updateMatrixWorld(true);
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const out = new THREE.Scene();
  out.environment = scene.environment;
  out.background = scene.background;
  out.environmentIntensity = scene.environmentIntensity;
  out.backgroundIntensity = scene.backgroundIntensity;
  const visible = (o: THREE.Object3D) => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
    return true;
  };
  scene.traverse((o) => {
    if (o instanceof THREE.Light) {
      if (!visible(o)) return;
      const copy = o.clone(false) as THREE.Light;
      // In world space, with its target (a sun's, a spot's) where it was.
      o.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale);
      out.add(copy);
      const t = (o as THREE.Light & { target?: THREE.Object3D }).target;
      const ct = (copy as THREE.Light & { target?: THREE.Object3D }).target;
      if (t && ct) {
        ct.position.setFromMatrixPosition(t.matrixWorld);
        out.add(ct);
      }
      return;
    }
    if (!(o instanceof THREE.Mesh) || !visible(o)) return;
    const src = plain(o.geometry as THREE.BufferGeometry);
    const geom = (src.index ? src.toNonIndexed() : src).applyMatrix4(o.matrixWorld);
    if (geom !== src) src.dispose();
    const mats = [o.material].flat() as THREE.Material[];
    const groups = Array.isArray(o.material) && geom.groups.length ? geom.groups : null;
    const add = (m: THREE.Material | undefined, g: THREE.BufferGeometry) => {
      if (!m) return g.dispose();
      const list = buckets.get(m) ?? [];
      list.push(g);
      buckets.set(m, list);
    };
    if (!groups) {
      geom.clearGroups();
      add(mats[0], geom);
      return;
    }
    for (const grp of groups) {
      const count = Math.min(grp.count, geom.getAttribute('position').count - grp.start);
      if (count > 0) add(mats[grp.materialIndex ?? 0], slice(geom, grp.start, count));
    }
    geom.dispose();
  });
  for (const [material, list] of buckets) {
    const merged = mergeGeometries(uniform(list, material), false);
    for (const g of list) g.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = material.name;
    out.add(mesh);
  }
  out.updateMatrixWorld(true);
  return out;
}

/**
 * A copy of `g` with every attribute plain floats (a model's may be quantised, normalised or
 * interleaved), its index and groups as they were.
 */
function plain(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(g.attributes)) {
    const a = attr as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    const data = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) {
      for (let k = 0; k < a.itemSize; k++) data[i * a.itemSize + k] = a.getComponent(i, k);
    }
    out.setAttribute(name, new THREE.BufferAttribute(data, a.itemSize));
  }
  if (g.index) out.setIndex(g.index.clone());
  for (const grp of g.groups) out.addGroup(grp.start, grp.count, grp.materialIndex);
  return out;
}

/** Vertices `start` to `start + count` of a non-indexed geometry, as a geometry of their own. */
function slice(g: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(g.attributes)) {
    const a = attr as THREE.BufferAttribute;
    const size = a.itemSize;
    const data = (a.array as Float32Array).slice(start * size, (start + count) * size);
    out.setAttribute(name, new THREE.BufferAttribute(data, size));
  }
  return out;
}

/**
 * Gives every geometry of one material the same attributes (position, normal, uv, and
 * colour where the material uses vertex colours), as merging needs, filling any missing.
 */
function uniform(list: THREE.BufferGeometry[], material: THREE.Material): THREE.BufferGeometry[] {
  const colours = (material as THREE.MeshStandardMaterial).vertexColors === true;
  const keep = ['position', 'normal', 'uv', ...(colours ? ['color'] : [])];
  for (const g of list) {
    const n = g.getAttribute('position').count;
    for (const name of Object.keys(g.attributes)) if (!keep.includes(name)) g.deleteAttribute(name);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv'))
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    if (colours && !g.getAttribute('color')) {
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4).fill(1), 4));
    }
    const c = g.getAttribute('color');
    if (c && c.itemSize === 3) {
      const data = new Float32Array(c.count * 4);
      for (let i = 0; i < c.count; i++) {
        data[i * 4] = c.getX(i);
        data[i * 4 + 1] = c.getY(i);
        data[i * 4 + 2] = c.getZ(i);
        data[i * 4 + 3] = 1;
      }
      g.setAttribute('color', new THREE.BufferAttribute(data, 4));
    }
  }
  return list;
}
