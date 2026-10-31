import { describe, expect, it } from 'vitest';
import { verticalFov, widestFov } from './fov';

const across = (vertical: number, aspect: number) =>
  (2 * Math.atan(Math.tan((vertical * Math.PI) / 360) * aspect) * 180) / Math.PI;

describe('verticalFov', () => {
  it('gives the same view across whatever the shape of the view', () => {
    for (const aspect of [21 / 9, 16 / 9, 4 / 3, 1]) {
      expect(across(verticalFov(100, aspect), aspect)).toBeCloseTo(100, 6);
    }
  });

  it('caps a tall, narrow view up and down rather than stretching it', () => {
    // A phone held upright: 100° across would need about 137° up and down.
    expect(verticalFov(100, 0.46)).toBe(100);
    expect(across(verticalFov(100, 0.46), 0.46)).toBeGreaterThan(55);
    // The split screen's taller view keeps most of it.
    expect(across(verticalFov(100, 0.8), 0.8)).toBeGreaterThan(85);
  });

  it('says how wide a view fits, so the slider stops there', () => {
    expect(widestFov(16 / 9)).toBe(120);
    expect(widestFov(1.08)).toBe(100);
    expect(widestFov(390 / 614)).toBe(70);
  });
});
