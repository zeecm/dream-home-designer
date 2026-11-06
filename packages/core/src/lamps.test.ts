import { describe, expect, it } from 'vitest';
import { roomIdAt } from './designer/spaces';
import { sampleFlatProject } from './fixtures/sampleFlat';
import {
  LAMPS_DAYLIGHT,
  daylightReach,
  lampsAuto,
  revealPasses,
  roomHasDaylight,
  skyOpenings,
} from './lamps';
import type { Level } from './schema';
import { DEFAULT_SITE } from './schema';
import { daylight, sunPosition } from './sun';

const level = sampleFlatProject().levels[0] as Level;
const light = (hour: number) => daylight(sunPosition(DEFAULT_SITE, 300, hour));

describe('lamps on Auto', () => {
  it('knows which rooms daylight reaches from outside', () => {
    expect(roomHasDaylight(level, 'rm_living-and-dining')).toBe(true);
    expect(roomHasDaylight(level, 'rm_main-bedroom')).toBe(true);
    expect(roomHasDaylight(level, 'rm_kitchen')).toBe(true);
    // Open to the living room (a boundary, no wall): its windows light it.
    expect(roomHasDaylight(level, 'rm_dry-kitchen')).toBe(true);
    // A window only onto the air-con ledge, and the shelter has none.
    expect(roomHasDaylight(level, 'rm_bath-wc-1')).toBe(false);
    expect(roomHasDaylight(level, 'rm_household-shelter')).toBe(false);
  });

  it('turns them on at night, off by day in a room with a window, on in one without', () => {
    expect(light(21)).toBeLessThan(LAMPS_DAYLIGHT);
    expect(light(12)).toBeGreaterThan(LAMPS_DAYLIGHT);
    expect(lampsAuto(level, 'rm_living-and-dining', light(21))).toBe(true);
    expect(lampsAuto(level, 'rm_living-and-dining', light(12))).toBe(false);
    expect(lampsAuto(level, 'rm_dry-kitchen', light(12))).toBe(false);
    expect(lampsAuto(level, 'rm_household-shelter', light(12))).toBe(true);
    expect(lampsAuto(level, 'rm_bath-wc-1', light(12))).toBe(true);
    // From outside the rooms (an orbit view over the walls): the sky lights it.
    expect(lampsAuto(level, null, light(12))).toBe(false);
    expect(lampsAuto(level, null, light(21))).toBe(true);
  });
});

describe('openings to the sky', () => {
  it('lets through what the reveal doesn’t hide: all for no depth, less the deeper it is', () => {
    expect(revealPasses(2, 1.2, 0)).toBe(1);
    // Two unit squares one apart see 20% of each other (the textbook's figure).
    expect(revealPasses(1, 1, 1)).toBeCloseTo(0.1998, 4);
    // The living room's window in its 0.2 m wall.
    expect(revealPasses(2, 1.2, 0.2)).toBeCloseTo(0.777, 3);
    expect(revealPasses(1.2, 2, 0.2)).toBeCloseTo(revealPasses(2, 1.2, 0.2), 12);
    let last = 1;
    for (const d of [0.05, 0.1, 0.2, 0.4, 1, 4]) {
      const f = revealPasses(2, 1.2, d);
      expect(f).toBeLessThan(last);
      expect(f).toBeGreaterThan(0);
      last = f;
    }
    // A wide glass wall barely loses any.
    expect(revealPasses(6, 2.6, 0.05)).toBeGreaterThan(0.97);
  });

  it('finds each window to the outside, on the room’s face of its wall, looking out', () => {
    const found = skyOpenings(level);
    const windows = Object.values(level.openings).filter(
      (o) => o.kind === 'window' && o.id !== 'op_window_air-con-ledge_bath-wc-1',
    );
    // The air-con ledge is a room: its window isn't to the outside.
    expect(found.map((o) => o.id).sort()).toEqual(windows.map((o) => o.id).sort());
    for (const o of found) {
      const op = level.openings[o.id];
      expect(o.width, o.id).toBeCloseTo(op?.width ?? 0, 6);
      expect(o.bottom).toBe(op?.sill);
      expect(o.height).toBe(op?.height);
      expect(o.glazed).toBe(true);
      expect(o.depth).toBe(level.walls[op?.wallId ?? '']?.thickness);
      expect(Math.hypot(o.out.x, o.out.y)).toBeCloseTo(1, 9);
      // Just inside: its room; just past the wall: no room.
      const step = (k: number) => ({ x: o.at.x + o.out.x * k, y: o.at.y + o.out.y * k });
      expect(roomIdAt(level, step(-0.02)), o.id).toBe(o.roomId);
      const wall = level.walls[op?.wallId ?? ''];
      expect(roomIdAt(level, step((wall?.thickness ?? 0) + 0.05)), o.id).toBeNull();
    }
  });

  it('reaches the camera’s open-plan space and the rooms through its doors and openings', () => {
    const reach = daylightReach(level, 'rm_living-and-dining');
    for (const id of ['rm_living-and-dining', 'rm_dry-kitchen', 'rm_bedroom', 'rm_main-bedroom']) {
      expect(reach.has(id), id).toBe(true);
    }
    // Two rooms away (through the kitchen).
    expect(reach.has('rm_household-shelter')).toBe(false);
  });
});
