import { describe, expect, it } from 'vitest';
import { roomIdAt, roomsBeside } from './designer/spaces';
import { hdb4RoomLevel } from './fixtures/hdb4room';
import { sampleFlatProject } from './fixtures/sampleFlat';
import { DOOR_LEAF_THICKNESS, planGeometry } from './plan';
import { daylightReach, groundInSun, revealPasses, skyOpenings } from './portals';
import type { Level, Wall } from './schema';
import { DEFAULT_SITE } from './schema';
import { sunDirection, sunPosition } from './sun';

const level = sampleFlatProject().levels[0] as Level;
const sun = (hour: number) => sunDirection(DEFAULT_SITE, sunPosition(DEFAULT_SITE, 310, hour));

/** The level with one wall changed. */
const withWall = (l: Level, id: string, change: Partial<Wall>): Level => {
  const w = l.walls[id];
  if (!w) throw new Error(id);
  return { ...l, walls: { ...l.walls, [id]: { ...w, ...change } } };
};

describe('openings to the sky', () => {
  it('lets through what the reveal doesn’t hide: all for no depth, less the deeper it is', () => {
    expect(revealPasses(2, 1.2, 0)).toBe(1);
    // Two unit squares one apart see 20% of each other (the textbook's figure).
    expect(revealPasses(1, 1, 1)).toBeCloseTo(0.1998, 4);
    // A 2 m by 1.2 m window, through a whole 0.2 m wall.
    expect(revealPasses(2, 1.2, 0.2)).toBeCloseTo(0.777, 3);
    expect(revealPasses(1.2, 2, 0.2)).toBeCloseTo(revealPasses(2, 1.2, 0.2), 12);
    let last = 1;
    for (const d of [0.05, 0.1, 0.2, 0.4, 1, 4]) {
      const f = revealPasses(2, 1.2, d);
      expect(f).toBeLessThan(last);
      expect(f).toBeGreaterThan(0);
      last = f;
    }
    expect(revealPasses(6, 2.6, 0.05)).toBeGreaterThan(0.97);
  });

  it('finds each window to the outside, its light just inside the pane, looking out', () => {
    const found = skyOpenings(level);
    const windows = Object.values(level.openings).filter(
      (o) => o.kind === 'window' && o.id !== 'op_window_air-con-ledge_bath-wc-1',
    );
    // The air-con ledge is a room: its window isn't to the outside.
    expect(found.map((o) => o.id).sort()).toEqual(windows.map((o) => o.id).sort());
    for (const o of found) {
      const op = level.openings[o.id];
      const t = level.walls[op?.wallId ?? '']?.thickness ?? 0;
      expect(o.width, o.id).toBeCloseTo(op?.width ?? 0, 6);
      expect(o.bottom).toBe(op?.sill);
      expect(o.height).toBe(op?.height);
      expect(o.glazed).toBe(true);
      expect(Math.hypot(o.out.x, o.out.y)).toBeCloseTo(1, 9);
      // In the hole, a hair on the room's side of the pane (the wall's middle, 5 mm each
      // way): the outer half of the hole and that hair beyond it, the rest of the inner half
      // (sill, jambs and head) lit by it.
      expect(o.depth, o.id).toBeCloseTo(t / 2 + 0.006, 9);
      const step = (k: number) => ({ x: o.at.x + o.out.x * k, y: o.at.y + o.out.y * k });
      expect(roomIdAt(level, step(-t / 2)), o.id).toBe(o.roomId);
      expect(roomIdAt(level, step(o.depth + 0.05)), o.id).toBeNull();
    }
  });

  it('puts a passage’s at the far end of the hole and a glazed door’s just inside its leaf', () => {
    const win = skyOpenings(level)[0];
    const op = win && level.openings[win.id];
    if (!win || !op) throw new Error('no window');
    const t = level.walls[op.wallId]?.thickness ?? 0;
    const as = (o: Partial<typeof op>) => {
      const l = { ...level, openings: { ...level.openings, [op.id]: { ...op, ...o } } };
      const s = skyOpenings(l as Level).find((x) => x.id === op.id);
      if (!s) throw new Error('lost');
      // How far it sits from the window's light, outward.
      return { s, out: (s.at.x - win.at.x) * win.out.x + (s.at.y - win.at.y) * win.out.y };
    };
    const passage = as({ kind: 'passage' } as never);
    expect(passage.s.glazed).toBe(false);
    expect(passage.s.depth).toBeCloseTo(0.001, 9);
    expect(passage.out).toBeCloseTo(t / 2 - 0.001 + 0.006, 6);
    // A glazed door: its shut leaf (4 cm) stands flush with the face it swings to. Swinging
    // out, it is at the outer face, and the light a hair inside it (the reveal lit); swinging
    // in, it is at the inner face, and the light a hair inside that (never behind the glass).
    const f = planGeometry(level).frames[op.wallId];
    const roomSide = f ? Math.sign(f.n.x * -win.out.x + f.n.y * -win.out.y) : 1;
    const swings = (inward: boolean) =>
      roomSide > 0 === inward ? ('leftIn' as const) : ('leftOut' as const);
    const out = as({ kind: 'door', glazed: true, swing: swings(false) } as never);
    expect(out.s.glazed).toBe(true);
    expect(out.s.depth).toBeCloseTo(DOOR_LEAF_THICKNESS + 0.001, 9);
    expect(out.out).toBeCloseTo(t / 2 - DOOR_LEAF_THICKNESS - 0.001 + 0.006, 6);
    const inn = as({ kind: 'door', glazed: true, swing: swings(true) } as never);
    expect(inn.s.depth).toBeCloseTo(t + 0.001, 9);
    expect(inn.out).toBeCloseTo(-(t / 2 + 0.001) + 0.006, 6);
  });

  it('gives a glass wall one light, its openings none of their own', () => {
    const op = Object.values(level.openings).find((o) => o.id === skyOpenings(level)[0]?.id);
    if (!op) throw new Error('no window');
    const glass = withWall(level, op.wallId, { build: 'glass' });
    const found = skyOpenings(glass);
    expect(found.filter((o) => o.id === op.id)).toHaveLength(0);
    const wall = found.find((o) => o.id === op.wallId);
    expect(wall?.glazed).toBe(true);
    expect(wall?.bottom).toBe(0);
    expect(wall?.height).toBe(level.ceilingHeight);
    expect(wall?.depth).toBe(0);
  });

  it('gives a window in a half wall a light only up to the wall’s top, none above it', () => {
    const op = Object.values(level.openings).find((o) => o.id === skyOpenings(level)[0]?.id);
    if (!op) throw new Error('no window');
    // The wall's top cuts the window: it keeps its part below, the gap over the wall the rest.
    const cut = withWall(level, op.wallId, { height: op.sill + op.height / 2 });
    const found = skyOpenings(cut);
    const win = found.find((o) => o.id === op.id);
    expect(win?.bottom).toBe(op.sill);
    expect(win?.height).toBeCloseTo(op.height / 2, 9);
    const gap = found.find((o) => o.id === op.wallId);
    expect(gap?.bottom).toBeCloseTo(op.sill + op.height / 2, 9);
    // Under the window's sill: the window is all above the wall, so only the gap's light.
    const low = withWall(level, op.wallId, { height: op.sill - 0.1 });
    expect(skyOpenings(low).filter((o) => o.id === op.id)).toHaveLength(0);
    expect(skyOpenings(low).filter((o) => o.id === op.wallId)).toHaveLength(1);
  });

  it('lets the sky over a half wall to the outside, through glass if it has glass above', () => {
    const op = Object.values(level.openings).find((o) => o.id === skyOpenings(level)[0]?.id);
    if (!op) throw new Error('no window');
    const low = withWall(level, op.wallId, { height: 1.1 });
    const gap = skyOpenings(low).find((o) => o.id === op.wallId);
    expect(gap?.bottom).toBeCloseTo(1.1, 9);
    expect(gap?.height).toBeCloseTo(level.ceilingHeight - 1.1, 9);
    expect(gap?.glazed).toBe(false);
    const glazed = withWall(level, op.wallId, { height: 1.1, glassAbove: true });
    expect(skyOpenings(glazed).find((o) => o.id === op.wallId)?.glazed).toBe(true);
    // A full-height wall: no gap.
    expect(skyOpenings(level).find((o) => o.id === op.wallId)).toBeUndefined();
  });
});

describe('the rooms a camera sees the daylight of', () => {
  const doors = Object.values(level.openings).filter((o) => o.kind === 'door');
  const inside = doors.filter((o) => roomsBeside(level, o.wallId).every((r) => r !== null));

  it('crosses open doors, passages and on, room after room', () => {
    // As built, inside doors stand open: the bedrooms, and the shelter through the kitchen
    // (two rooms away).
    const reach = daylightReach(level, 'rm_living-and-dining');
    for (const id of [
      'rm_living-and-dining',
      'rm_dry-kitchen',
      'rm_kitchen',
      'rm_bedroom',
      'rm_main-bedroom',
      'rm_household-shelter',
    ]) {
      expect(reach.has(id), id).toBe(true);
    }
  });

  it('stops at shut doors, not at a passage or glass', () => {
    const shut = new Map(inside.map((o) => [o.id, 0]));
    const reach = daylightReach(level, 'rm_living-and-dining', shut);
    expect(reach.has('rm_dry-kitchen')).toBe(true);
    expect(reach.has('rm_kitchen')).toBe(true);
    expect(reach.has('rm_bedroom')).toBe(false);
    expect(reach.has('rm_main-bedroom')).toBe(false);
    expect(reach.has('rm_household-shelter')).toBe(false);
    // A shut door's wall made glass lets the light across.
    const toBed = inside.find((o) => roomsBeside(level, o.wallId).includes('rm_bedroom' as never));
    if (!toBed) throw new Error('no bedroom door');
    const glass = withWall(level, toBed.wallId, { build: 'glass' });
    expect(daylightReach(glass, 'rm_living-and-dining', shut).has('rm_bedroom')).toBe(true);
    const half = withWall(level, toBed.wallId, { height: 1 });
    expect(daylightReach(half, 'rm_living-and-dining', shut).has('rm_bedroom')).toBe(true);
  });
});

describe('the ground outside a window in the sun', () => {
  it('is lit when the sun is in front, shaded by the house when it is behind', () => {
    const hdb = hdb4RoomLevel();
    // The living room's window looks west (plan -x): the morning sun is behind the house.
    const living = skyOpenings(hdb).find((o) => o.id === 'op_win_living');
    if (!living) throw new Error('no living window');
    expect(living.out.x).toBeCloseTo(-1, 9);
    expect(groundInSun(hdb, living, sun(9))).toBeLessThan(0.5);
    expect(groundInSun(hdb, living, sun(16))).toBeGreaterThan(0.9);
    // No sun, no sunlit ground.
    expect(groundInSun(hdb, living, null)).toBe(0);
    expect(groundInSun(hdb, living, { x: 0.3, y: -0.2, z: 0.3 })).toBe(0);
    for (const o of skyOpenings(level)) {
      for (const h of [8, 12, 17]) {
        const f = groundInSun(level, o, sun(h));
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
      }
    }
  });

  it('counts the ground under the window shaded when the sun is overhead behind the wall', () => {
    const hdb = hdb4RoomLevel();
    const living = skyOpenings(hdb).find((o) => o.id === 'op_win_living');
    if (!living) throw new Error('no living window');
    // Low in the east, behind the house: all of it in the house's shade.
    expect(groundInSun(hdb, living, { x: 1, y: 0.05, z: 0 })).toBe(0);
    // Low in the west, in front: all of it lit.
    expect(groundInSun(hdb, living, { x: -1, y: 0.05, z: 0 })).toBe(1);
  });
});
