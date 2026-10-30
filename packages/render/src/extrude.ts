import type { Vec2 } from '@dhd/core';
import * as THREE from 'three';

/**
 * Extrudes a plan polygon (convex or not, without holes) between two heights into a
 * non-indexed prism with flat normals and simple UVs (metres along each face). Winding is
 * fixed per triangle, so the polygon may come in either orientation.
 */
export function extrudePolygon(
  poly: readonly Vec2[],
  y0: number,
  y1: number,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
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
  // Caps by ear clipping, so a concave outline (a junction hub) is filled correctly.
  const faces = THREE.ShapeUtils.triangulateShape(
    poly.map((p) => new THREE.Vector2(p.x, p.y)),
    [],
  );
  for (const [i, j, k] of faces) {
    const p0 = poly[i ?? 0] as Vec2;
    const p1 = poly[j ?? 0] as Vec2;
    const p2 = poly[k ?? 0] as Vec2;
    const flat = [p0.x, p0.y, p1.x, p1.y, p2.x, p2.y];
    tri(v(p0, y1), v(p1, y1), v(p2, y1), up, flat);
    tri(v(p0, y0), v(p1, y0), v(p2, y0), down, flat);
  }
  // Each side faces away from the outline: to the right of its edge for a counter-clockwise
  // outline, to the left for a clockwise one.
  let twice = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as Vec2;
    const q = poly[(i + 1) % poly.length] as Vec2;
    twice += p.x * q.y - q.x * p.y;
  }
  const turn = twice >= 0 ? 1 : -1;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as Vec2;
    const q = poly[(i + 1) % poly.length] as Vec2;
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len < 1e-9) continue;
    const out = new THREE.Vector3((q.y - p.y) * turn, 0, -(q.x - p.x) * turn);
    tri(v(p, y0), v(q, y0), v(q, y1), out, [0, y0, len, y0, len, y1]);
    tri(v(p, y0), v(q, y1), v(p, y1), out, [0, y0, len, y1, 0, y1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}
