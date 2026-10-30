import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUNDLED_ASSETS, drawingBox, hashBlob, hashOfKey, keyOfHash } from './assets';

describe('plan image keys', () => {
  it('hashes a blob to hex SHA-256 and round-trips it through a key', async () => {
    const hash = await hashBlob(new Blob(['abc']));
    expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashOfKey(keyOfHash(hash))).toBe(hash);
  });

  it('treats older browser-only keys as having no hash', () => {
    expect(hashOfKey('img_abc123')).toBeNull();
    expect(hashOfKey('sha256:nothex')).toBeNull();
  });
});

describe('bundled plan images', () => {
  it('are keyed by the hash of the file the app serves', async () => {
    for (const [key, url] of Object.entries(BUNDLED_ASSETS)) {
      const file = readFileSync(new URL(`../public${url}`, import.meta.url));
      expect(keyOfHash(await hashBlob(new Blob([file])))).toBe(key);
    }
  });
});

describe('drawingBox', () => {
  it('finds the plan on a page, not its title or notes', () => {
    const w = 200;
    const h = 200;
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    const ink = (x: number, y: number) => data.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
    // A plan: a square outline from (20, 30) to (120, 130) with a dimension line above it.
    for (let i = 20; i <= 120; i++) {
      ink(i, 30);
      ink(i, 130);
      ink(20, i + 10);
      ink(120, i + 10);
      ink(i, 22);
    }
    for (let y = 22; y <= 30; y++) ink(20, y);
    // Notes further down, apart from it.
    for (let x = 20; x < 180; x++) for (const y of [170, 175, 180]) ink(x, y);
    const box = drawingBox({ width: w, height: h, data }, 4, 2);
    expect(box).toEqual({ x0: 40, y0: 40, x1: 248, y1: 264 });
  });
});
