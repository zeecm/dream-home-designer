import { type Item, type Level, sampleFlatProject } from '@dhd/core';
import { describe, expect, it } from 'vitest';
import { drawOrder } from './MiniLayout';

const piece = (id: string, assetId: string): Item =>
  ({
    id,
    assetId,
    position: { x: 1, y: 0, z: 1 },
    rotationY: 0,
    scale: { x: 1, y: 1, z: 1 },
  }) as Item;

describe('MiniLayout: the order pieces are drawn in', () => {
  it('low pieces first, so a rug never hides its table; the same however they were placed', () => {
    const level = sampleFlatProject().levels[0] as Level;
    const items = [piece('a', 'coffee-table'), piece('b', 'rug'), piece('c', 'sofa-3')];
    const one = { ...level, items: Object.fromEntries(items.map((i) => [i.id, i])) };
    const two = {
      ...level,
      items: Object.fromEntries([...items].reverse().map((i) => [i.id, i])),
    };
    const order = drawOrder(one).map((i) => i.assetId);
    expect(order[0]).toBe('rug');
    expect(order.indexOf('rug')).toBeLessThan(order.indexOf('coffee-table'));
    expect(drawOrder(two).map((i) => i.id)).toEqual(drawOrder(one).map((i) => i.id));
  });
});
