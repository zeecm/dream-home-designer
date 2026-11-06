import {
  type Delivery,
  type DoorOnTheWay,
  LIFT_PRESETS,
  type Level,
  type LiftFit,
  sampleFlatProject,
} from '@dhd/core';
import { describe, expect, it } from 'vitest';
import { deliveryText, liftLine, liftNumbers } from './words';

const level = sampleFlatProject('prj_t').levels[0] as Level;
const { typical } = LIFT_PRESETS;
const main = 'op_door_living-and-dining_outside-3';
const at = { x: 0, y: 0 };
const door = {
  openingId: main,
  into: 'rm_living-and-dining',
  clear: 0.86,
  height: 2.1,
  centre: at,
};

/** A way in through the typical lift and the main door. */
const way = (lift: LiftFit, extra: Partial<DoorOnTheWay> = {}) =>
  ({
    status: lift.fit === 'too-big' ? 'too-big' : 'fits',
    from: main,
    doors: [
      { openingId: 'lift', into: null, clear: 0.9, height: 2, centre: at, fit: lift.fit },
      { ...door, fit: 'fits', ...extra },
    ],
    worst: null,
    lift,
  }) as Delivery;

describe('the lift in words', () => {
  it('a preset’s numbers', () => {
    expect(liftNumbers(typical).replace(/ /g, ' ')).toBe(
      'Door 0.90 × 2.00 m · car 1.10 wide × 1.40 deep × 2.30 m high',
    );
  });

  it('how it goes in, and how little to spare when tight', () => {
    expect(liftLine({ fit: 'fits', how: 'upright', spare: 0.1 })).toBe('Lift: fits as it stands.');
    expect(liftLine({ fit: 'fits', how: 'back', spare: 0.1 })).toBe('Lift: fits on its back.');
    expect(liftLine({ fit: 'fits', how: 'end', spare: 0.1 })).toBe('Lift: fits stood on end.');
    expect(liftLine({ fit: 'fits', how: 'tilted', spare: 0.1 })).toBe('Lift: fits tilted.');
    expect(liftLine({ fit: 'tight', how: 'end', spare: 0.015 })).toBe(
      'Lift: just fits, stood on end (15 mm to spare).',
    );
    expect(liftLine({ fit: 'tight', how: 'tilted', spare: 0 })).toBe('Lift: just fits, tilted.');
    expect(liftLine({ fit: 'too-big', fails: 'car', spare: 0 })).toBeNull();
  });

  it('the verdict names the lift when it doesn’t go in: its door, standing up, its car', () => {
    const text = (f: LiftFit) => deliveryText(level, way(f), typical).replace(/ /g, ' ');
    expect(text({ fit: 'too-big', fails: 'door', need: 0.95, spare: -0.05 })).toBe(
      'Too big for the lift door: 0.90 m wide; it needs 0.95 m on its side.',
    );
    expect(
      text({ fit: 'too-big', fails: 'car', spare: 0, standUp: { need: 2.1, allows: 1.918 } }),
    ).toBe('Too long to stand up through the lift door (needs 2.10 m, the door allows 1.92 m).');
    expect(text({ fit: 'too-big', fails: 'car', spare: 0 })).toBe(
      'Doesn’t fit in the lift (1.10 × 1.40 m, 2.30 m high), even on end or tilted.',
    );
  });

  it('when it goes in the lift, the doors’ verdict leaves the lift out; a tilted door says so', () => {
    const r = way({ fit: 'fits', how: 'end', spare: 0.1 }, { tilted: true });
    expect(deliveryText(level, r, typical).replace(/ /g, ' ')).toBe(
      'Fits through every door on the way in. Narrowest: the main door, 0.86 m (tilted on its diagonal).',
    );
  });
});
