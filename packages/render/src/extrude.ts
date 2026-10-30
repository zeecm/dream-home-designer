import type { Vec2 } from '@dhd/core';
import * as THREE from 'three';

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
