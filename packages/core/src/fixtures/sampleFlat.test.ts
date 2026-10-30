import { describe, expect, it } from 'vitest';
import { detectFaces, roomArea } from '../rooms';
import { Project } from '../schema';
import { sampleFlatProject } from './sampleFlat';

describe('sampleFlatProject', () => {
  const p = sampleFlatProject('prj_t');
  const l = p.levels[0]!;

  it('is a valid project', () => {
    expect(() => Project.parse(p)).not.toThrow();
  });

  it('has the ten rooms of a 4-room HDB flat, adding up to the whole floor', () => {
    const names = Object.values(l.rooms)
      .map((r) => r.name)
      .sort();
    expect(names).toEqual([
      'Bathroom',
      'Bedroom 2',
      'Bedroom 3',
      'Corridor',
      'Household shelter',
      'Kitchen',
      'Living and dining',
      'Master bathroom',
      'Master bedroom',
      'Service yard',
    ]);
    const total = Object.values(l.rooms).reduce((s, r) => s + roomArea(l, r), 0);
    expect(total).toBeCloseTo(96);
    expect(detectFaces(l)).toHaveLength(10);
  });

  it('has readable ids that every reference uses', () => {
    expect(l.rooms['rm_bedroom-2']).toBeDefined();
    expect(l.walls['w_bedroom-2_corridor']).toBeDefined();
    for (const w of Object.values(l.walls)) {
      expect(l.vertices[w.a], w.id).toBeDefined();
      expect(l.vertices[w.b], w.id).toBeDefined();
    }
    for (const o of Object.values(l.openings)) expect(l.walls[o.wallId], o.id).toBeDefined();
    for (const r of Object.values(l.rooms)) {
      for (const v of r.loop) expect(l.vertices[v], r.id).toBeDefined();
    }
  });

  it('puts every opening on a wall', () => {
    const kinds = Object.values(l.openings).map((o) => o.kind);
    expect(kinds.filter((k) => k === 'door')).toHaveLength(7);
    expect(kinds.filter((k) => k === 'window')).toHaveLength(8);
    expect(kinds.filter((k) => k === 'passage')).toHaveLength(3);
  });
});
