import { describe, expect, it } from 'vitest';
import { detectFaces, roomArea } from '../rooms';
import { Project, isBoundary } from '../schema';
import { SAMPLE_PLAN_KEY, sampleFlatProject } from './sampleFlat';

describe('sampleFlatProject', () => {
  const p = sampleFlatProject('prj_t');
  const l = p.levels[0]!;

  it('is a valid project', () => {
    expect(() => Project.parse(p)).not.toThrow();
  });

  it('has the nine rooms of the 3-room flat, adding up to its 69 m² gross floor area', () => {
    const names = Object.values(l.rooms)
      .map((r) => r.name)
      .sort();
    expect(names).toEqual([
      'Air-con ledge',
      'Bath/WC 1',
      'Bath/WC 2',
      'Bedroom',
      'Dry kitchen',
      'Household shelter',
      'Kitchen',
      'Living and dining',
      'Main bedroom',
    ]);
    const total = Object.values(l.rooms).reduce((s, r) => s + roomArea(l, r), 0);
    expect(total).toBeCloseTo(69, 0);
    expect(detectFaces(l)).toHaveLength(9);
  });

  it('marks off the dry kitchen with boundaries, not walls', () => {
    const between = Object.values(l.walls).filter((w) => w.id.startsWith('w_dry-kitchen_living'));
    expect(between).toHaveLength(2);
    for (const w of between) expect(isBoundary(w)).toBe(true);
  });

  it('comes with its plan image, scaled to the walls', () => {
    expect(p.underlay?.assetKey).toBe(SAMPLE_PLAN_KEY);
    // The plan's 10275 mm top dimension spans 1037.6 px of the bundled image.
    expect(1037.6 * (p.underlay?.scale ?? 0)).toBeCloseTo(10.275, 2);
  });

  it('has readable ids that every reference uses', () => {
    expect(l.rooms['rm_main-bedroom']).toBeDefined();
    expect(l.walls['w_bedroom_main-bedroom']).toBeDefined();
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
    expect(kinds.filter((k) => k === 'door')).toHaveLength(6);
    expect(kinds.filter((k) => k === 'window')).toHaveLength(7);
    expect(kinds.filter((k) => k === 'passage')).toHaveLength(1);
  });
});
