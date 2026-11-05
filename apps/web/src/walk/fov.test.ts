import { describe, expect, it } from 'vitest';
import { FOV_DEFAULT, FOV_MAX, verticalFov } from './fov';

const across = (vertical: number, aspect: number) =>
  (2 * Math.atan(Math.tan((vertical * Math.PI) / 360) * aspect) * 180) / Math.PI;

describe('verticalFov', () => {
  it('gives the same view across whatever the shape of the view', () => {
    for (const aspect of [21 / 9, 16 / 9, 4 / 3, 1, 0.8]) {
      expect(across(verticalFov(FOV_DEFAULT, aspect), aspect)).toBeCloseTo(FOV_DEFAULT, 6);
    }
  });

  it('keeps the width across on a phone held upright, as far as a camera sensibly goes', () => {
    // An iPhone in portrait (390 × 844 less the bars): the full 110° and 120° across.
    expect(across(verticalFov(FOV_DEFAULT, 0.5), 0.5)).toBeCloseTo(FOV_DEFAULT, 6);
    expect(across(verticalFov(FOV_MAX, 0.46), 0.46)).toBeCloseTo(FOV_MAX, 0);
    expect(verticalFov(FOV_MAX, 0.2)).toBe(150);
  });
});
