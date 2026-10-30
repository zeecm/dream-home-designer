import type { Draft } from 'immer';
import type { Command } from './history';
import type { PlanGeometry } from './plan';
import type { Item, Level, Project, Vec2 } from './schema';

/**
 * The furniture catalogue: pieces built from boxes, sized as they commonly come in a
 * Singapore flat, so a plan can be furnished and walked through without downloading
 * models. Each piece has a default size; an item's scale stretches it, so a sofa can be
 * made 2.4 m long or a wardrobe 1.8 m wide.
 *
 * Item axes: x across the width, y from back (-) to front (+), z up, all in metres from the
 * centre of the piece's footprint on the floor. An item turned by rotationY (radians) faces
 * (-sin r, cos r) in plan; at 0 its front faces +y, down the screen.
 */
export type FurnitureMaterial =
  | 'wood'
  | 'wood-dark'
  | 'fabric'
  | 'fabric-light'
  | 'white'
  | 'charcoal'
  | 'metal'
  | 'glass'
  | 'ceramic'
  | 'leaf';

export interface FurniturePart {
  min: [number, number, number];
  max: [number, number, number];
  material: FurnitureMaterial;
}

export type FurnitureCategory =
  | 'Bedroom'
  | 'Living'
  | 'Dining'
  | 'Kitchen'
  | 'Bathroom'
  | 'Storage'
  | 'Decor';

export interface FurnitureKind {
  id: string;
  name: string;
  category: FurnitureCategory;
  /** Width (x), depth (y) and height (z) at scale 1. */
  size: { w: number; d: number; h: number };
  /** Height above the floor it is placed at, e.g. for wall cabinets. */
  elevation?: number;
  /** Things you walk over or under (a rug, a wall cabinet) don't block a walk. */
  walkThrough?: boolean;
  /** Placed back to a wall when dropped near one. */
  againstWall?: boolean;
  parts: FurniturePart[];
}

const box = (
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  material: FurnitureMaterial,
): FurniturePart => ({ min: [x0, y0, z0], max: [x1, y1, z1], material });

/** Four legs of size s just inside a w × d footprint, h tall. */
const legs = (w: number, d: number, h: number, s: number, m: FurnitureMaterial) => {
  const x = w / 2 - s;
  const y = d / 2 - s;
  return [
    box(-x - s, -x, -y - s, -y, 0, h, m),
    box(x, x + s, -y - s, -y, 0, h, m),
    box(-x - s, -x, y, y + s, 0, h, m),
    box(x, x + s, y, y + s, 0, h, m),
  ];
};

function bed(id: string, name: string, w: number): FurnitureKind {
  const d = 2.0;
  const h = 1.0;
  return {
    id,
    name,
    category: 'Bedroom',
    size: { w, d, h },
    againstWall: true,
    parts: [
      box(-w / 2, w / 2, -d / 2, d / 2, 0, 0.3, 'wood'),
      box(-w / 2 + 0.03, w / 2 - 0.03, -d / 2 + 0.08, d / 2 - 0.03, 0.3, 0.52, 'fabric-light'),
      box(-w / 2, w / 2, -d / 2, -d / 2 + 0.08, 0, h, 'wood'),
      box(-w / 2 + 0.1, w / 2 - 0.1, -d / 2 + 0.1, -d / 2 + 0.45, 0.52, 0.64, 'white'),
    ],
  };
}

function table(id: string, name: string, w: number, d: number, h: number): FurnitureKind {
  return {
    id,
    name,
    category: 'Dining',
    size: { w, d, h },
    parts: [
      box(-w / 2, w / 2, -d / 2, d / 2, h - 0.04, h, 'wood'),
      ...legs(w, d, h - 0.04, 0.05, 'wood-dark'),
    ],
  };
}

function cabinet(
  id: string,
  name: string,
  category: FurnitureCategory,
  w: number,
  d: number,
  h: number,
  body: FurnitureMaterial,
  top?: FurnitureMaterial,
): FurnitureKind {
  return {
    id,
    name,
    category,
    size: { w, d, h },
    againstWall: true,
    parts: [
      box(-w / 2, w / 2, -d / 2, d / 2, 0.05, top ? h - 0.03 : h, body),
      box(-w / 2 + 0.02, w / 2 - 0.02, -d / 2 + 0.02, d / 2 - 0.05, 0, 0.05, 'charcoal'),
      ...(top ? [box(-w / 2, w / 2, -d / 2, d / 2 + 0.02, h - 0.03, h, top)] : []),
    ],
  };
}

export const FURNITURE: FurnitureKind[] = [
  // Bedroom
  bed('bed-single', 'Single bed', 0.92),
  bed('bed-super-single', 'Super single bed', 1.07),
  bed('bed-queen', 'Queen bed', 1.52),
  bed('bed-king', 'King bed', 1.83),
  cabinet('wardrobe', 'Wardrobe', 'Bedroom', 1.2, 0.6, 2.1, 'white'),
  cabinet('bedside', 'Bedside table', 'Bedroom', 0.45, 0.4, 0.5, 'wood'),
  {
    id: 'desk',
    name: 'Desk',
    category: 'Bedroom',
    size: { w: 1.2, d: 0.6, h: 0.75 },
    againstWall: true,
    parts: [
      box(-0.6, 0.6, -0.3, 0.3, 0.72, 0.75, 'wood'),
      box(-0.6, -0.56, -0.3, 0.3, 0, 0.72, 'white'),
      box(0.56, 0.6, -0.3, 0.3, 0, 0.72, 'white'),
      box(0.1, 0.56, -0.28, 0.28, 0.55, 0.72, 'white'),
    ],
  },
  // Living
  {
    id: 'sofa-3',
    name: '3-seat sofa',
    category: 'Living',
    size: { w: 2.1, d: 0.9, h: 0.85 },
    againstWall: true,
    parts: [
      box(-1.05, 1.05, -0.45, 0.45, 0.08, 0.42, 'fabric'),
      box(-1.05, 1.05, -0.45, -0.25, 0.42, 0.85, 'fabric'),
      box(-1.05, -0.9, -0.25, 0.45, 0.42, 0.62, 'fabric'),
      box(0.9, 1.05, -0.25, 0.45, 0.42, 0.62, 'fabric'),
      box(-0.9, 0.9, -0.25, 0.43, 0.42, 0.5, 'fabric-light'),
      ...legs(2.1, 0.9, 0.08, 0.04, 'wood-dark'),
    ],
  },
  {
    id: 'armchair',
    name: 'Armchair',
    category: 'Living',
    size: { w: 0.85, d: 0.85, h: 0.85 },
    parts: [
      box(-0.425, 0.425, -0.425, 0.425, 0.08, 0.42, 'fabric'),
      box(-0.425, 0.425, -0.425, -0.25, 0.42, 0.85, 'fabric'),
      box(-0.425, -0.3, -0.25, 0.425, 0.42, 0.62, 'fabric'),
      box(0.3, 0.425, -0.25, 0.425, 0.42, 0.62, 'fabric'),
      ...legs(0.85, 0.85, 0.08, 0.04, 'wood-dark'),
    ],
  },
  {
    ...table('coffee-table', 'Coffee table', 1.1, 0.6, 0.4),
    category: 'Living',
  },
  cabinet('tv-console', 'TV console', 'Living', 1.8, 0.4, 0.5, 'wood-dark'),
  {
    id: 'tv',
    name: 'TV, 55 inch',
    category: 'Living',
    size: { w: 1.23, d: 0.25, h: 0.78 },
    elevation: 0.5,
    againstWall: true,
    parts: [
      box(-0.615, 0.615, -0.03, 0.03, 0.07, 0.78, 'charcoal'),
      box(-0.15, 0.15, -0.12, 0.12, 0, 0.02, 'charcoal'),
      box(-0.03, 0.03, -0.02, 0.02, 0.02, 0.1, 'charcoal'),
    ],
  },
  {
    id: 'rug',
    name: 'Rug',
    category: 'Living',
    size: { w: 2.0, d: 1.4, h: 0.01 },
    walkThrough: true,
    parts: [box(-1, 1, -0.7, 0.7, 0, 0.01, 'fabric-light')],
  },
  {
    id: 'floor-lamp',
    name: 'Floor lamp',
    category: 'Living',
    size: { w: 0.4, d: 0.4, h: 1.6 },
    parts: [
      box(-0.15, 0.15, -0.15, 0.15, 0, 0.03, 'metal'),
      box(-0.015, 0.015, -0.015, 0.015, 0.03, 1.35, 'metal'),
      box(-0.2, 0.2, -0.2, 0.2, 1.35, 1.6, 'fabric-light'),
    ],
  },
  // Dining
  table('dining-4', 'Dining table, 4 seats', 1.4, 0.8, 0.75),
  table('dining-6', 'Dining table, 6 seats', 1.8, 0.9, 0.75),
  {
    id: 'dining-chair',
    name: 'Dining chair',
    category: 'Dining',
    size: { w: 0.45, d: 0.5, h: 0.9 },
    parts: [
      box(-0.225, 0.225, -0.25, 0.25, 0.42, 0.46, 'wood'),
      box(-0.225, 0.225, -0.25, -0.21, 0.46, 0.9, 'wood'),
      ...legs(0.45, 0.5, 0.42, 0.035, 'wood-dark'),
    ],
  },
  // Kitchen
  cabinet('kitchen-base', 'Base cabinet', 'Kitchen', 0.6, 0.6, 0.9, 'white', 'charcoal'),
  {
    ...cabinet('kitchen-sink', 'Sink cabinet', 'Kitchen', 0.8, 0.6, 0.9, 'white', 'charcoal'),
    parts: [
      ...cabinet('x', 'x', 'Kitchen', 0.8, 0.6, 0.9, 'white', 'charcoal').parts,
      box(-0.25, 0.25, -0.2, 0.2, 0.88, 0.905, 'metal'),
    ],
  },
  {
    ...cabinet('kitchen-hob', 'Hob cabinet', 'Kitchen', 0.8, 0.6, 0.9, 'white', 'charcoal'),
    parts: [
      ...cabinet('x', 'x', 'Kitchen', 0.8, 0.6, 0.9, 'white', 'charcoal').parts,
      box(-0.3, 0.3, -0.22, 0.22, 0.9, 0.91, 'glass'),
    ],
  },
  {
    ...cabinet('kitchen-wall', 'Wall cabinet', 'Kitchen', 0.6, 0.35, 0.7, 'white'),
    elevation: 1.45,
    walkThrough: true,
    parts: [box(-0.3, 0.3, -0.175, 0.175, 0, 0.7, 'white')],
  },
  cabinet('fridge', 'Fridge', 'Kitchen', 0.7, 0.7, 1.8, 'metal'),
  {
    ...cabinet('washer', 'Washing machine', 'Kitchen', 0.6, 0.6, 0.85, 'white'),
    parts: [
      box(-0.3, 0.3, -0.3, 0.3, 0, 0.85, 'white'),
      box(-0.18, 0.18, 0.3, 0.31, 0.2, 0.56, 'glass'),
    ],
  },
  // Bathroom
  {
    id: 'toilet',
    name: 'Toilet',
    category: 'Bathroom',
    size: { w: 0.4, d: 0.7, h: 0.75 },
    againstWall: true,
    parts: [
      box(-0.18, 0.18, -0.35, -0.17, 0.4, 0.75, 'ceramic'),
      box(-0.15, 0.15, -0.2, 0.33, 0, 0.4, 'ceramic'),
    ],
  },
  {
    id: 'vanity',
    name: 'Basin and vanity',
    category: 'Bathroom',
    size: { w: 0.6, d: 0.45, h: 0.85 },
    againstWall: true,
    parts: [
      box(-0.3, 0.3, -0.225, 0.225, 0.35, 0.82, 'wood'),
      box(-0.3, 0.3, -0.225, 0.225, 0.82, 0.85, 'ceramic'),
    ],
  },
  // Storage
  cabinet('shoe-cabinet', 'Shoe cabinet', 'Storage', 0.8, 0.35, 1.0, 'wood'),
  {
    id: 'bookshelf',
    name: 'Bookshelf',
    category: 'Storage',
    size: { w: 0.8, d: 0.3, h: 1.8 },
    againstWall: true,
    parts: [
      box(-0.4, -0.38, -0.15, 0.15, 0, 1.8, 'wood'),
      box(0.38, 0.4, -0.15, 0.15, 0, 1.8, 'wood'),
      box(-0.38, 0.38, -0.15, -0.13, 0, 1.8, 'wood'),
      ...[0, 0.45, 0.9, 1.35, 1.78].map((z) => box(-0.38, 0.38, -0.13, 0.15, z, z + 0.02, 'wood')),
    ],
  },
  // Decor
  {
    id: 'plant',
    name: 'Potted plant',
    category: 'Decor',
    size: { w: 0.45, d: 0.45, h: 1.2 },
    parts: [
      box(-0.15, 0.15, -0.15, 0.15, 0, 0.35, 'ceramic'),
      box(-0.22, 0.22, -0.22, 0.22, 0.35, 1.2, 'leaf'),
    ],
  },
];

const byId = new Map(FURNITURE.map((k) => [k.id, k]));

/** The catalogue entry an item was made from, if this version of the app knows it. */
export const furnitureKind = (assetId: string): FurnitureKind | undefined => byId.get(assetId);

/** An item's actual size: its kind's size times its scale. */
export function itemSize(item: Item, kind = furnitureKind(item.assetId)) {
  const s = kind?.size ?? { w: 0.5, d: 0.5, h: 0.5 };
  return { w: s.w * item.scale.x, d: s.d * item.scale.z, h: s.h * item.scale.y };
}

/** The item's footprint in plan: corners back-left, back-right, front-right, front-left. */
export function itemFootprint(item: Item, kind = furnitureKind(item.assetId)): Vec2[] {
  const { w, d } = itemSize(item, kind);
  const c = Math.cos(item.rotationY);
  const s = Math.sin(item.rotationY);
  // Local x maps to (c, s), local y (front) to (-s, c).
  return [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ].map(([x, y]) => ({
    x: item.position.x + (x as number) * c - (y as number) * s,
    y: item.position.z + (x as number) * s + (y as number) * c,
  }));
}

/** A new item of `kind` at plan point `at`, turned by `rotation`. */
export function newItem(id: string, kind: FurnitureKind, at: Vec2, rotation = 0): Item {
  return {
    id,
    assetId: kind.id,
    position: { x: at.x, y: kind.elevation ?? 0, z: at.y },
    rotationY: rotation,
    scale: { x: 1, y: 1, z: 1 },
    flags: { snapWall: !!kind.againstWall, collidable: !kind.walkThrough },
  };
}

/** How far from a wall's face a piece's back is still pulled flush against it. */
export const WALL_SNAP = 0.35;

/**
 * Where a piece dropped at `at` goes: if its kind stands against a wall and a wall face is
 * within reach, back to that wall (turned to face away from it, slid along it to where it
 * was dropped); otherwise where it was dropped, as turned.
 */
export function placeFurniture(
  geom: PlanGeometry,
  kind: FurnitureKind,
  at: Vec2,
  rotation: number,
  size = kind.size,
): { at: Vec2; rotation: number; wallId?: string } {
  if (!kind.againstWall) return { at, rotation };
  let best: { gap: number; at: Vec2; rotation: number; wallId: string } | null = null;
  for (const f of Object.values(geom.frames)) {
    if (f.half === 0) continue; // a boundary has no face to stand against
    const rx = at.x - f.a.x;
    const ry = at.y - f.a.y;
    const u = rx * f.d.x + ry * f.d.y;
    if (u < 0 || u > f.length) continue;
    const v = rx * f.n.x + ry * f.n.y;
    const side = v >= 0 ? 1 : -1;
    const gap = Math.abs(v) - f.half - size.d / 2;
    if (gap > WALL_SNAP || gap < -size.d / 2 - f.half) continue;
    if (best && gap >= best.gap) continue;
    const off = f.half + size.d / 2 + 0.005;
    best = {
      gap,
      wallId: f.wall.id,
      at: { x: f.a.x + f.d.x * u + f.n.x * off * side, y: f.a.y + f.d.y * u + f.n.y * off * side },
      // Facing away from the wall: (-sin r, cos r) = side · n.
      rotation: Math.atan2(-f.n.x * side, f.n.y * side),
    };
  }
  return best ? { at: best.at, rotation: best.rotation, wallId: best.wallId } : { at, rotation };
}

function lvl(d: Draft<Project>, levelId: string): Draft<Level> {
  const l = d.levels.find((x) => x.id === levelId);
  if (!l) throw new Error(`level ${levelId} not found`);
  return l;
}

/** Adds a piece of furniture. The caller makes the item (and its id) beforehand. */
export function addItem(levelId: string, item: Item): Command {
  const name = furnitureKind(item.assetId)?.name ?? 'item';
  return {
    label: `Add ${name.toLowerCase()}`,
    recipe: (d) => {
      lvl(d, levelId).items[item.id] = structuredClone(item);
    },
  };
}

export type ItemPatch = Partial<Pick<Item, 'rotationY'>> & {
  position?: Partial<Item['position']>;
  scale?: Partial<Item['scale']>;
};

/** Moves, turns or resizes a piece of furniture. */
export function updateItem(levelId: string, itemId: string, patch: ItemPatch): Command {
  return {
    label: 'Edit furniture',
    recipe: (d) => {
      const it = lvl(d, levelId).items[itemId];
      if (!it) throw new Error(`item ${itemId} not found`);
      if (patch.position) Object.assign(it.position, patch.position);
      if (patch.scale) {
        for (const [k, v] of Object.entries(patch.scale)) {
          if (v !== undefined && !(v > 0)) throw new Error('scale must be positive');
        }
        Object.assign(it.scale, patch.scale);
      }
      if (patch.rotationY !== undefined) {
        const tau = Math.PI * 2;
        it.rotationY = ((patch.rotationY % tau) + tau) % tau;
      }
    },
  };
}

export function deleteItem(levelId: string, itemId: string): Command {
  return {
    label: 'Delete furniture',
    recipe: (d) => {
      delete lvl(d, levelId).items[itemId];
    },
  };
}
