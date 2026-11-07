import { describe, expect, it } from 'vitest';
import { SPECK, speckLimit, spreadSigma, spreadSpecks } from './specks';

/** A w × h picture of grey `base`, with `spots` ([x, y, rgb]) set. */
function picture(w: number, h: number, base: number, spots: [number, number, number[]][] = []) {
  const px = new Float32Array(w * h * 3).fill(base);
  for (const [x, y, rgb] of spots)
    for (let c = 0; c < 3; c++) px[(y * w + x) * 3 + c] = rgb[c] ?? 0;
  return px;
}
const total = (px: Float32Array) => px.reduce((a, b) => a + b, 0);

describe('specks spread, not cut', () => {
  const w = 40;
  const h = 30;
  const sigma = 3;

  it('keeps all the light: a speck in the middle, by an edge, in a corner', () => {
    for (const [x, y] of [
      [20, 15],
      [0, 15],
      [20, 0],
      [0, 0],
      [w - 1, h - 1],
      [1, 1],
    ] as [number, number][]) {
      const before = picture(w, h, 1, [[x, y, [400, 400, 400]]]);
      const after = spreadSpecks(before, w, h, SPECK, sigma);
      expect(total(after) / total(before), `${x},${y}`).toBeCloseTo(1, 4);
      // No speck left: a soft glow, the pixel within a few times the pixels about it (in a
      // corner its light is spread over a quarter of the room a middle one has).
      const near: number[] = [];
      for (const [dx, dy] of [
        [-1, -1],
        [0, -1],
        [1, -1],
        [-1, 0],
        [1, 0],
        [-1, 1],
        [0, 1],
        [1, 1],
      ] as const) {
        const qx = Math.min(w - 1, Math.max(0, x + dx));
        const qy = Math.min(h - 1, Math.max(0, y + dy));
        near.push(after[(qy * w + qx) * 3] ?? 0);
      }
      near.sort((a, b) => a - b);
      const median = ((near[3] ?? 0) + (near[4] ?? 0)) / 2;
      expect((after[(y * w + x) * 3] ?? 0) / median, `${x},${y}`).toBeLessThan(SPECK);
    }
  });

  it('spreads it over the pixels about it, not far, and keeps a picture without specks', () => {
    const before = picture(w, h, 1, [[20, 15, [400, 400, 400]]]);
    const after = spreadSpecks(before, w, h, SPECK, sigma);
    // Within 3 σ, all of it.
    let near = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const extra = (after[(y * w + x) * 3] ?? 0) - 1;
        if (Math.abs(x - 20) > 3 * sigma || Math.abs(y - 15) > 3 * sigma) {
          expect(Math.abs(extra)).toBeLessThan(1e-6);
        } else near += extra;
      }
    }
    // (The speck itself included: what it keeps, and what comes back to it.)
    expect(near).toBeCloseTo(399, 3);
    // An even picture, or one gently lit across, is left as it is.
    const even = picture(w, h, 3);
    expect(Array.from(spreadSpecks(even, w, h, SPECK, sigma))).toEqual(Array.from(even));
  });

  it('keeps an evenly speckled picture even to its edges and corners', () => {
    // Specks scattered at random over an even wall (one pixel in ten), as early samples look.
    const spots: [number, number, number[]][] = [];
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) if (rand() < 0.1) spots.push([x, y, [60, 60, 60]]);
    }
    const before = picture(w, h, 1, spots);
    const after = spreadSpecks(before, w, h, SPECK, sigma);
    const band = (inside: boolean, img = after) => {
      let sum = 0;
      let n = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const edge = Math.min(x, y, w - 1 - x, h - 1 - y) < 4;
          if (edge === !inside) {
            sum += img[(y * w + x) * 3] ?? 0;
            n++;
          }
        }
      }
      return sum / n;
    };
    expect(total(after) / total(before)).toBeCloseTo(1, 4);
    // Spread, the edges come nearer the picture's mean, not further (skipped taps darken them,
    // clamped ones light them): within 10% of it.
    const mean = total(before) / 3 / (w * h);
    expect(Math.abs(band(false) / mean - 1)).toBeLessThan(0.1);
    expect(Math.abs(band(false) / mean - 1)).toBeLessThan(Math.abs(band(false, before) / mean - 1));
    expect(Math.abs(band(true) / mean - 1)).toBeLessThan(0.1);
  });

  it('finds a speck by the median of the eight around it, even in twos and threes', () => {
    // Three specks side by side: each has at most two bright neighbours, so the median is the
    // grey around them and all three are cut down.
    const before = picture(w, h, 1, [
      [10, 10, [300, 300, 300]],
      [11, 10, [300, 300, 300]],
      [12, 10, [300, 300, 300]],
    ]);
    const after = spreadSpecks(before, w, h, SPECK, sigma);
    for (const x of [10, 11, 12]) expect(after[(10 * w + x) * 3] ?? 0).toBeLessThan(50);
    // A bright block (a window): its inside has bright neighbours and stands.
    const block: [number, number, number[]][] = [];
    for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) block.push([x, y, [200, 200, 200]]);
    const window = spreadSpecks(picture(w, h, 1, block), w, h, SPECK, sigma);
    // (Its corners, three bright of eight, are cut, their light kept nearby: within 1%.)
    expect(Math.abs((window[(10 * w + 10) * 3] ?? 0) / 200 - 1)).toBeLessThan(0.01);
    expect(Math.abs((window[(5 * w + 10) * 3] ?? 0) / 200 - 1)).toBeLessThan(0.01);
  });

  it('keeps a speck’s light on its own surface', () => {
    // A grey floor (bottom half) and a red wall (top half); a speck on the floor.
    const before = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const rgb = y < h / 2 ? [2, 0.2, 0.2] : [1, 1, 1];
        for (let c = 0; c < 3; c++) before[(y * w + x) * 3 + c] = rgb[c] ?? 0;
      }
    }
    for (let c = 0; c < 3; c++) before[((h / 2 + 1) * w + 20) * 3 + c] = 300;
    const after = spreadSpecks(before, w, h, SPECK, sigma);
    // The wall's pixels just above it barely change.
    const wall = after[((h / 2 - 1) * w + 20) * 3 + 1] ?? 0;
    expect(wall).toBeLessThan(0.2 * 1.05);
    expect(total(after) / total(before)).toBeCloseTo(1, 4);
  });

  it('counts a pixel that is not a number as black, not spread over the others', () => {
    const before = picture(w, h, 1, [
      [20, 15, [Number.NaN, 1, 1]],
      [5, 5, [Number.POSITIVE_INFINITY, 0, 0]],
    ]);
    const after = spreadSpecks(before, w, h, SPECK, sigma);
    expect(after.every(Number.isFinite)).toBe(true);
    expect(after[(15 * w + 20) * 3 + 1]).toBe(0);
    expect(after[(10 * w + 30) * 3]).toBeCloseTo(1, 6);
  });

  it('loosens as the samples add up, so a real highlight stands once settled', () => {
    expect(speckLimit(SPECK, 1)).toBe(SPECK);
    expect(speckLimit(SPECK, 64)).toBe(SPECK);
    expect(speckLimit(SPECK, 256)).toBe(SPECK);
    expect(speckLimit(SPECK, 512)).toBe(4 * SPECK);
    expect(speckLimit(SPECK, 1024)).toBe(16 * SPECK);
    expect(speckLimit(0, 64)).toBe(Number.POSITIVE_INFINITY);
    // A glint 30 times the wall: spread at Good's 256, left alone at 1024 samples.
    const glint = picture(w, h, 1, [[20, 15, [30, 30, 30]]]);
    expect(
      spreadSpecks(glint, w, h, speckLimit(SPECK, 256), sigma)[(15 * w + 20) * 3],
    ).toBeLessThan(10);
    expect(spreadSpecks(glint, w, h, speckLimit(SPECK, 1024), sigma)[(15 * w + 20) * 3]).toBe(30);
    // 12 px on a 480-wide picture, 3 on the spike's 120.
    expect(spreadSigma(480)).toBe(12);
    expect(spreadSigma(120)).toBe(3);
  });
});
