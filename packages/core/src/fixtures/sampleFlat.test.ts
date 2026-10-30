import { describe, expect, it } from 'vitest';
import { pointInPolygon, roomPolygon } from '../geometry';
import { detectFaces, roomArea } from '../rooms';
import { type Level, Project, type Vec2, isBoundary } from '../schema';
import { WALKER_RADIUS, collisionSegments, walkStart } from '../walk';
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

  it('has the walls measured off the plan, keeping flush faces where they thin', () => {
    const t = (id: string) => l.walls[id]?.thickness;
    expect(t('w_main-bedroom_outside-2')).toBe(0.3); // structural
    expect(t('w_household-shelter_outside')).toBe(0.255);
    expect(t('w_bedroom_main-bedroom')).toBe(0.1);
    // The bedroom's outside wall goes from 300 mm to 100 mm with its living-room face
    // flush: both lie to the same side of one line.
    const bedroom = Object.values(l.walls).filter((w) => w.side === 'left');
    expect(bedroom.map((w) => w.thickness).sort()).toEqual([0.1, 0.3, 0.3]);
    for (const w of bedroom) expect(l.vertices[w.a]?.x).toBe(6.495);
  });

  it('can be walked into every room that has a door or an opening', () => {
    const segs = collisionSegments(l);
    const start = walkStart(l);
    if (!start) throw new Error('no start');
    const step = 0.05;
    const free = (p: Vec2) =>
      segs.every((s) => {
        const dx = s.b.x - s.a.x;
        const dy = s.b.y - s.a.y;
        const k = Math.max(
          0,
          Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / (dx * dx + dy * dy || 1)),
        );
        return Math.hypot(p.x - s.a.x - dx * k, p.y - s.a.y - dy * k) >= WALKER_RADIUS;
      });
    const key = (i: number, j: number) => `${i},${j}`;
    const seen = new Set<string>();
    const reached: Vec2[] = [];
    const i0 = Math.round(start.at.x / step);
    const j0 = Math.round(start.at.y / step);
    const queue: [number, number][] = [[i0, j0]];
    seen.add(key(i0, j0));
    while (queue.length) {
      const [i, j] = queue.shift() as [number, number];
      const p = { x: i * step, y: j * step };
      if (!free(p)) continue;
      reached.push(p);
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const n = key(i + di, j + dj);
        if (!seen.has(n) && Math.abs(i + di - i0) < 300 && Math.abs(j + dj - j0) < 300) {
          seen.add(n);
          queue.push([i + di, j + dj]);
        }
      }
    }
    const withWay = new Set(
      Object.values(l.openings)
        .filter((o) => o.kind !== 'window')
        .flatMap((o) => roomsBeside(l, o.wallId)),
    );
    for (const r of Object.values(l.rooms)) {
      if (!withWay.has(r.id)) continue;
      const poly = roomPolygon(l, r);
      expect(
        reached.some((p) => pointInPolygon(p, poly)),
        r.name,
      ).toBe(true);
    }
    expect(withWay.size).toBe(8); // all but the air-con ledge, reached through a window
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
    expect(kinds.filter((k) => k === 'window')).toHaveLength(8);
    expect(kinds.filter((k) => k === 'passage')).toHaveLength(1);
  });
});

/** The rooms on either side of a wall, by sampling just off its middle. */
function roomsBeside(l: Level, wallId: string): string[] {
  const w = l.walls[wallId];
  const a = w && l.vertices[w.a];
  const b = w && l.vertices[w.b];
  if (!w || !a || !b) return [];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return [1, -1].flatMap((k) => {
    const p = {
      x: mid.x + n.x * (w.thickness + 0.05) * k,
      y: mid.y + n.y * (w.thickness + 0.05) * k,
    };
    const room = Object.values(l.rooms).find((r) => pointInPolygon(p, roomPolygon(l, r)));
    return room ? [room.id] : [];
  });
}
