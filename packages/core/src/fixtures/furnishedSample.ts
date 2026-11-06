import { furnitureKind, newItem } from '../furniture';
import type { Item, Level, Vec2 } from '../schema';
import { sampleFlatProject } from './sampleFlat';

/** Pieces added to a level: [kind id, centre, rotation, scale across]. */
export function withPieces(
  level: Level,
  pieces: [string, Vec2, number?, number?][],
  prefix = 'it_f',
): Level {
  const items = { ...level.items };
  pieces.forEach(([kindId, at, rot, sx], i) => {
    const kind = furnitureKind(kindId);
    if (!kind) throw new Error(`no ${kindId}`);
    const it: Item = newItem(`${prefix}${String(i).padStart(3, '0')}`, kind, at, rot ?? 0, 2.6);
    if (sx) it.scale = { ...it.scale, x: sx };
    items[it.id] = it;
  });
  return { ...level, items };
}

/** The sample flat furnished as a family would: beds, a desk, a sofa, a TV, a kitchen run. */
export function furnishedSample(): Level {
  const l = sampleFlatProject().levels[0] as Level;
  return withPieces(l, [
    ['bed-queen', { x: 2.1, y: 0.15 + 1.05 }],
    ['wardrobe', { x: 0.3 + 0.3, y: 1.6 }, -Math.PI / 2],
    ['bed-single', { x: 3.32 + 0.46, y: 0.15 + 1.05 }],
    ['desk', { x: 5.4, y: 0.15 + 0.3 }],
    ['sofa-3', { x: 7.5, y: 5.9 - 0.45 }, Math.PI],
    ['tv-console', { x: 8.3, y: 1.65 + 0.2 }],
    ['dining-4', { x: 8.6, y: 3.6 }],
    ['fridge', { x: 4.682 + 0.35, y: 5.2 }, -Math.PI / 2],
    ['kitchen-base', { x: 3.35 + 0.3, y: 8.425 }, Math.PI],
    ['kitchen-sink', { x: 3.35 + 1.0, y: 8.425 }, Math.PI],
    ['kitchen-base', { x: 3.35 + 1.7, y: 8.425 }, Math.PI],
    ['kitchen-hob', { x: 3.35 + 2.4, y: 8.425 }, Math.PI],
  ]);
}
