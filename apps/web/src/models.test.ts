import { describe, expect, it } from 'vitest';
import { isGlb, modelSize, nameOfFile } from './modelFiles';

const glb = (length: number, declared = length, version = 2) => {
  const buf = new ArrayBuffer(length);
  const v = new DataView(buf);
  [...'glTF'].forEach((c, i) => v.setUint8(i, c.charCodeAt(0)));
  v.setUint32(4, version, true);
  v.setUint32(8, declared, true);
  return buf;
};

describe('uploaded models', () => {
  it('takes binary glTF 2.0 only, whole', () => {
    expect(isGlb(glb(64))).toBe(true);
    expect(isGlb(glb(64, 80))).toBe(false); // cut short
    expect(isGlb(glb(64, 64, 1))).toBe(false);
    expect(isGlb(new TextEncoder().encode('{"asset":{"version":"2.0"}}').buffer)).toBe(false);
    expect(isGlb(new ArrayBuffer(8))).toBe(false);
  });

  it('reads sizes in metres, or in centimetres or millimetres when too big for a flat', () => {
    expect(modelSize({ x: 0.8, y: 1, z: 0.9 })).toEqual({ w: 0.8, d: 0.9, h: 1 });
    expect(modelSize({ x: 80, y: 100, z: 90 })).toEqual({ w: 0.8, d: 0.9, h: 1 });
    expect(modelSize({ x: 150, y: 90, z: 200 })).toEqual({ w: 1.5, d: 2, h: 0.9 });
    expect(modelSize({ x: 2400, y: 750, z: 900 })).toEqual({ w: 2.4, d: 0.9, h: 0.75 });
    // A flat model (a rug) keeps a sliver of height.
    expect(modelSize({ x: 2, y: 0, z: 3 }).h).toBe(0.01);
  });

  it('names a model after its file', () => {
    expect(nameOfFile('grandmas-armchair_v2.glb')).toBe('Grandmas armchair v2');
    expect(nameOfFile('.glb')).toBe('My model');
  });
});
