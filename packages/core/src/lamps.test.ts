import { describe, expect, it } from 'vitest';
import { sampleFlatProject } from './fixtures/sampleFlat';
import { LAMPS_DAYLIGHT, lampsAuto, roomHasDaylight } from './lamps';
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
