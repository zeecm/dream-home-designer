import { describe, expect, it } from 'vitest';
import { hdb4RoomLevel } from './fixtures/hdb4room';
import { signedArea } from './geometry';
import { doorSwing, framePoint, planGeometry } from './plan';

const area = (p: { x: number; y: number }[]) => Math.abs(signedArea(p));

describe('planGeometry', () => {
  const level = hdb4RoomLevel();
  const g = planGeometry(level);

  it('cuts every opening out of its wall', () => {
    expect(g.openings).toHaveLength(Object.keys(level.openings).length);
    // w_front_l (5 m, 0.2 thick) has the 1 m main door at t = 0.25: two solid pieces.
    const front = g.pieces.filter((p) => p.wallId === 'w_front_l');
    expect(front).toHaveLength(2);
  });

  it('solid pieces plus gaps cover exactly the mitred outline', () => {
    const fp = g.footprints.walls.w_front_l!;
    const outline = area([fp.aL, fp.bL, fp.bR, fp.aR]);
    const solid = g.pieces
      .filter((p) => p.wallId === 'w_front_l')
      .reduce((s, p) => s + area(p.polygon), 0);
    const gaps = g.openings
      .filter((o) => o.wallId === 'w_front_l')
      .reduce((s, o) => s + area(o.polygon), 0);
    expect(solid + gaps).toBeCloseTo(outline, 9);
    expect(gaps).toBeCloseTo(1 * 0.2, 9);
  });
});

describe('doorSwing', () => {
  const level = hdb4RoomLevel();
  const g = planGeometry(level);
  const door = g.openings.find((o) => o.opening.id === 'op_master')!; // on w_mid_3, v9 -> v10, +x

  it('hinges on the chosen jamb and opens a quarter circle to the chosen side', () => {
    for (const swing of ['leftIn', 'leftOut', 'rightIn', 'rightOut'] as const) {
      const s = doorSwing(door.frame, { ...door.opening, swing });
      expect(Math.hypot(s.leafEnd.x - s.hinge.x, s.leafEnd.y - s.hinge.y)).toBeCloseTo(0.9);
      expect(Math.hypot(s.arcEnd.x - s.hinge.x, s.arcEnd.y - s.hinge.y)).toBeCloseTo(0.9);
      const side = swing.endsWith('In') ? 1 : -1;
      // The wall runs along +x with left normal +y, so In opens to +y.
      expect(Math.sign(s.leafEnd.y - 4.5)).toBe(side);
      const hingeX = swing.startsWith('left') ? 5.55 : 6.45;
      expect(s.hinge.x).toBeCloseTo(hingeX);
    }
  });

  it('picks the sweep that draws the short arc', () => {
    const s = doorSwing(door.frame, { ...door.opening, swing: 'leftIn' });
    // leaf points +y from the hinge, the far jamb is +x: rotating +y to +x is clockwise in
    // maths terms (negative cross), so sweep 0.
    expect(s.sweep).toBe(0);
    expect(framePoint(door.frame, 0, 0)).toEqual({ x: 5, y: 4.5 });
  });
});
