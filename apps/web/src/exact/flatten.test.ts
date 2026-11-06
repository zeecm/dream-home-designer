import { DEFAULT_SITE, type Level, furnitureKind, newItem, sampleFlatProject } from '@dhd/core';
import { buildExactScene, exactDaylight } from '@dhd/render';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { flattenForTracing } from './flatten';

/** Each mesh's triangles in world space (to the millimetre), keyed by material. */
function triangles(scene: THREE.Scene): Map<THREE.Material, string[]> {
  scene.updateMatrixWorld(true);
  const out = new Map<THREE.Material, string[]>();
  const v = new THREE.Vector3();
  scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.visible) return;
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
    const pos = g.getAttribute('position');
    const mats = [o.material].flat() as THREE.Material[];
    const groups =
      Array.isArray(o.material) && g.groups.length
        ? g.groups
        : [{ start: 0, count: pos.count, materialIndex: 0 }];
    for (const grp of groups) {
      const m = mats[grp.materialIndex ?? 0] as THREE.Material;
      const list = out.get(m) ?? [];
      for (let i = grp.start; i < grp.start + grp.count; i += 3) {
        const tri: string[] = [];
        for (let k = 0; k < 3; k++) {
          v.fromBufferAttribute(pos, i + k).applyMatrix4(o.matrixWorld);
          tri.push(
            v
              .toArray()
              .map((n) => n.toFixed(3))
              .join(','),
          );
        }
        list.push(tri.join(' '));
      }
      out.set(m, list);
    }
  });
  return out;
}

describe('the scene as the tracer takes it', () => {
  it('has one mesh per material, holding exactly the triangles that use it', () => {
    const level = sampleFlatProject().levels[0] as Level;
    const exact = buildExactScene(level, {
      ceilings: true,
      daylight: exactDaylight(DEFAULT_SITE, 300, 12),
      lamps: false,
    });
    const flat = flattenForTracing(exact.scene);
    const meshes = flat.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
    const materials = meshes.map((m) => m.material);
    expect(new Set(materials).size).toBe(meshes.length);
    for (const m of meshes) expect(Array.isArray(m.material)).toBe(false);
    const before = triangles(exact.scene);
    const after = triangles(flat);
    expect([...after.keys()].sort((a, b) => a.uuid.localeCompare(b.uuid))).toEqual(
      [...before.keys()].sort((a, b) => a.uuid.localeCompare(b.uuid)),
    );
    for (const [m, tris] of before) expect(after.get(m)?.sort(), m.name).toEqual(tris.sort());
    // The sun and its target, and the sky, come along.
    expect(flat.children.some((o) => o instanceof THREE.DirectionalLight)).toBe(true);
    expect(flat.environment).toBe(exact.scene.environment);
    exact.dispose();
  });

  it('keeps a ceiling light’s bulb size and where it points', () => {
    const level = sampleFlatProject().levels[0] as Level;
    const kind = furnitureKind('ceiling-light');
    if (!kind) throw new Error('no ceiling light');
    const lit = { ...level, items: { it_c: newItem('it_c', kind, { x: 8.3, y: 3.2 }, 0, 2.6) } };
    const exact = buildExactScene(lit, {
      ceilings: true,
      daylight: exactDaylight(DEFAULT_SITE, 300, 21),
      lamps: true,
    });
    const flat = flattenForTracing(exact.scene);
    const spots = flat.children.filter((o): o is THREE.SpotLight => o instanceof THREE.SpotLight);
    expect(spots).toHaveLength(1);
    const spot = spots[0] as THREE.SpotLight & { radius?: number };
    expect(spot.radius).toBe(0.05);
    const down = spot.target.position.clone().sub(spot.position).normalize();
    expect(down.y).toBeCloseTo(-1, 9);
    exact.dispose();
  });

  it('gives each instance of an instanced mesh its own triangles', () => {
    const scene = new THREE.Scene();
    const material = new THREE.MeshStandardMaterial();
    const many = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, 3);
    for (let i = 0; i < 3; i++)
      many.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i * 2, 0, 0));
    many.position.set(0, 5, 0);
    scene.add(many);
    const flat = flattenForTracing(scene);
    const mesh = flat.children[0] as THREE.Mesh;
    const pos = mesh.geometry.getAttribute('position');
    expect(pos.count).toBe(3 * 36);
    const box = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute);
    expect(box.min.toArray()).toEqual([-0.5, 4.5, -0.5]);
    expect(box.max.toArray()).toEqual([4.5, 5.5, 0.5]);
  });
});
