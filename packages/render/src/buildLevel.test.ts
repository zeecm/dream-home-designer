import { hdb4RoomLevel, roomPolygon } from '@dhd/core';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildLevel } from './buildLevel';
import { MaterialCache } from './materials';

describe('buildLevel', () => {
  const level = hdb4RoomLevel();
  const group = buildLevel(level, { materials: new MaterialCache() });

  it('merges walls into one mesh per material, plus glass and one floor per room', () => {
    const names = group.children.map((c) => c.name).sort();
    expect(names).toEqual(
      ['walls:paint-white', 'glass', ...Object.keys(level.rooms).map((id) => `floor:${id}`)].sort(),
    );
  });

  it('walls span the plan footprint and ceiling height', () => {
    const walls = group.getObjectByName('walls:paint-white') as THREE.Mesh;
    const box = new THREE.Box3().setFromObject(walls);
    // exterior walls are 0.2 thick and centred on the outline, so extend 0.1 past it
    expect(box.min.x).toBeCloseTo(-0.1);
    expect(box.max.x).toBeCloseTo(11.1);
    expect(box.min.z).toBeCloseTo(-0.1);
    expect(box.max.z).toBeCloseTo(8.6);
    expect(box.min.y).toBeCloseTo(0);
    expect(box.max.y).toBeCloseTo(2.6);
  });

  it('floors land on the right side of the plan (plan y -> world +z)', () => {
    const floor = group.getObjectByName('floor:rm_master') as THREE.Mesh;
    const box = new THREE.Box3().setFromObject(floor);
    expect(box.min.x).toBeCloseTo(7);
    expect(box.max.x).toBeCloseTo(11);
    expect(box.min.z).toBeCloseTo(4.5);
    expect(box.max.z).toBeCloseTo(8.5);
  });

  it('every floor covers exactly its room polygon and faces up', () => {
    for (const room of Object.values(level.rooms)) {
      const pts = roomPolygon(level, room);
      const floor = group.getObjectByName(`floor:${room.id}`) as THREE.Mesh;
      const box = new THREE.Box3().setFromObject(floor);
      expect(box.min.x, room.id).toBeCloseTo(Math.min(...pts.map((p) => p.x)));
      expect(box.max.x, room.id).toBeCloseTo(Math.max(...pts.map((p) => p.x)));
      expect(box.min.z, room.id).toBeCloseTo(Math.min(...pts.map((p) => p.y)));
      expect(box.max.z, room.id).toBeCloseTo(Math.max(...pts.map((p) => p.y)));
      const normals = floor.geometry.getAttribute('normal');
      for (let i = 0; i < normals.count; i++) expect(normals.getY(i), room.id).toBeCloseTo(1);
    }
  });

  it('ceilings sit at ceiling height over the floor and face down', () => {
    const withCeilings = buildLevel(level, { materials: new MaterialCache(), ceilings: true });
    for (const room of Object.values(level.rooms)) {
      const floor = withCeilings.getObjectByName(`floor:${room.id}`) as THREE.Mesh;
      const ceil = withCeilings.getObjectByName(`ceiling:${room.id}`) as THREE.Mesh;
      const fb = new THREE.Box3().setFromObject(floor);
      const cb = new THREE.Box3().setFromObject(ceil);
      expect(cb.min.x, room.id).toBeCloseTo(fb.min.x);
      expect(cb.max.x, room.id).toBeCloseTo(fb.max.x);
      expect(cb.min.z, room.id).toBeCloseTo(fb.min.z);
      expect(cb.max.z, room.id).toBeCloseTo(fb.max.z);
      expect(cb.min.y, room.id).toBeCloseTo(room.ceilingHeight ?? level.ceilingHeight);
      const normals = ceil.geometry.getAttribute('normal');
      for (let i = 0; i < normals.count; i++) expect(normals.getY(i), room.id).toBeCloseTo(-1);
    }
  });
});
