import type { Draft } from 'immer';
import { pointInPolygon } from './geometry';
import type { Command } from './history';
import { draftLevel } from './levels';
import { MODEL_KINDS } from './modelKinds.generated';
import type { PlanGeometry } from './plan';
import type { CustomModel, Item, Level, Project, Vec2, Vec3 } from './schema';

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
  | 'leaf'
  /** A lit shade or diffuser: it glows. */
  | 'lamp'
  /** The stand-in for a model that is still loading. */
  | 'placeholder';

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
  | 'Lighting'
  | 'Decor';

/** The catalogue's categories, in the order the palette lists them. */
export const CATEGORIES: FurnitureCategory[] = [
  'Bedroom',
  'Living',
  'Dining',
  'Kitchen',
  'Bathroom',
  'Storage',
  'Lighting',
  'Decor',
];

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
  /** Hangs from the ceiling: placed with its top at the ceiling, not on the floor. */
  ceiling?: boolean;
  /** A lamp: where its bulb is (item axes, at scale 1), its colour and brightness. */
  light?: { at: [number, number, number]; color: string; candela: number };
  /**
   * A real model (a GLB file the web app serves from /models/), drawn instead of the boxes
   * once it has loaded. Its natural size is `size`, so an item's scale stretches it too.
   */
  model?: string;
  /** Where the model comes from (its licence page). */
  source?: string;
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
  // Lighting
  {
    id: 'floor-lamp',
    name: 'Floor lamp',
    category: 'Lighting',
    size: { w: 0.4, d: 0.4, h: 1.6 },
    light: { at: [0, 0, 1.45], color: '#ffd9a8', candela: 40 },
    parts: [
      box(-0.15, 0.15, -0.15, 0.15, 0, 0.03, 'metal'),
      box(-0.015, 0.015, -0.015, 0.015, 0.03, 1.35, 'metal'),
      box(-0.2, 0.2, -0.2, 0.2, 1.35, 1.6, 'lamp'),
    ],
  },
  {
    id: 'table-lamp',
    name: 'Table lamp',
    category: 'Lighting',
    size: { w: 0.3, d: 0.3, h: 0.45 },
    // On a bedside table or desk: lift it in its details for a taller one.
    elevation: 0.5,
    walkThrough: true,
    light: { at: [0, 0, 0.32], color: '#ffd9a8', candela: 25 },
    parts: [
      box(-0.08, 0.08, -0.08, 0.08, 0, 0.02, 'ceramic'),
      box(-0.03, 0.03, -0.03, 0.03, 0.02, 0.22, 'ceramic'),
      box(-0.15, 0.15, -0.15, 0.15, 0.22, 0.45, 'lamp'),
    ],
  },
  {
    id: 'ceiling-light',
    name: 'Ceiling light',
    category: 'Lighting',
    size: { w: 0.45, d: 0.45, h: 0.08 },
    ceiling: true,
    walkThrough: true,
    light: { at: [0, 0, -0.1], color: '#fff1dc', candela: 120 },
    parts: [box(-0.225, 0.225, -0.225, 0.225, 0, 0.08, 'lamp')],
  },
  {
    id: 'pendant',
    name: 'Pendant light',
    category: 'Lighting',
    size: { w: 0.35, d: 0.35, h: 0.9 },
    ceiling: true,
    walkThrough: true,
    light: { at: [0, 0, 0.05], color: '#ffd9a8', candela: 60 },
    parts: [
      box(-0.005, 0.005, -0.005, 0.005, 0.2, 0.9, 'charcoal'),
      box(-0.175, 0.175, -0.175, 0.175, 0, 0.2, 'lamp'),
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

/** A catalogue entry made from a model (tools/models builds these). */
export type ModelKind = Omit<FurnitureKind, 'parts' | 'model' | 'source'> & {
  model: string;
  source: string;
};

/** A model's entry, with one box of its size to stand in until the model loads. */
const fromModel = (k: ModelKind): FurnitureKind => ({
  ...k,
  parts: [
    box(-k.size.w / 2, k.size.w / 2, -k.size.d / 2, k.size.d / 2, 0, k.size.h, 'placeholder'),
  ],
});

FURNITURE.push(...MODEL_KINDS.map(fromModel));

const byId = new Map(FURNITURE.map((k) => [k.id, k]));

/** The open project's uploaded models, as catalogue entries (see `setProjectModels`). */
const custom = new Map<string, FurnitureKind>();

/** The `model` of an uploaded model's entry: its content key, which the app resolves. */
export const customModelFile = (hash: string) => `sha256:${hash}`;

/** An uploaded model's catalogue entry, with a stand-in box of its size. */
export function customKind(m: CustomModel): FurnitureKind {
  const { w, d, h } = m.size;
  return {
    id: m.id,
    name: m.name,
    category: (CATEGORIES.includes(m.category as FurnitureCategory)
      ? m.category
      : 'Decor') as FurnitureCategory,
    size: m.size,
    model: customModelFile(m.hash),
    parts: [box(-w / 2, w / 2, -d / 2, d / 2, 0, h, 'placeholder')],
  };
}

/**
 * Puts a project's uploaded models in the catalogue, replacing the last project's. The app
 * calls it whenever the open project's `models` change, before anything is drawn from them.
 * Their ids are unique, so an entry left from another project never matches an item.
 */
export function setProjectModels(models: Project['models']) {
  custom.clear();
  for (const m of Object.values(models ?? {})) custom.set(m.id, customKind(m));
}

/** The open project's uploaded models, in the order they were added. */
export const projectKinds = (): FurnitureKind[] => [...custom.values()];

/** The catalogue entry an item was made from, if this version of the app knows it. */
export const furnitureKind = (assetId: string): FurnitureKind | undefined =>
  byId.get(assetId) ?? custom.get(assetId);

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

/** Pieces hung this high or higher (a wall cabinet, a clock) keep their own height. */
export const HUNG = 1.2;

/**
 * Where a kind of piece sits up and down: from the ceiling, hung on a wall, on a tabletop
 * (a lamp, a TV: placed on a piece, it stands on that piece's top), or on the floor.
 */
export function furnitureLayer(kind?: FurnitureKind): 'ceiling' | 'high' | 'tabletop' | 'floor' {
  if (!kind) return 'floor';
  if (kind.ceiling) return 'ceiling';
  const e = kind.elevation ?? 0;
  return e >= HUNG ? 'high' : e > 0 ? 'tabletop' : 'floor';
}

/**
 * What a tabletop piece put down at plan point `at` stands on: the highest piece standing
 * on the floor or a tabletop whose footprint holds the point (under a wall cabinet, the desk
 * beneath it).
 */
export function standsOn(items: Iterable<Item>, at: Vec2): Item | undefined {
  let best: Item | undefined;
  let top = Number.NEGATIVE_INFINITY;
  for (const it of items) {
    const kind = furnitureKind(it.assetId);
    const layer = furnitureLayer(kind);
    if (layer === 'ceiling' || layer === 'high') continue;
    if (!pointInPolygon(at, itemFootprint(it, kind))) continue;
    const h = it.position.y + itemSize(it, kind).h;
    if (h > top) {
      top = h;
      best = it;
    }
  }
  return best;
}

/**
 * A new item of `kind` at plan point `at`, turned by `rotation`. A ceiling light hangs
 * from `ceilingHeight`.
 */
export function newItem(
  id: string,
  kind: FurnitureKind,
  at: Vec2,
  rotation = 0,
  ceilingHeight = 2.7,
): Item {
  const y = kind.ceiling ? Math.max(0, ceilingHeight - kind.size.h) : (kind.elevation ?? 0);
  return {
    id,
    assetId: kind.id,
    position: { x: at.x, y, z: at.y },
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
    // Slid along the wall as little as it takes to clear the walls beside it (a corner).
    const along = clearAlong(geom, f, side, u, size);
    best = {
      gap,
      wallId: f.wall.id,
      at: {
        x: f.a.x + f.d.x * along + f.n.x * off * side,
        y: f.a.y + f.d.y * along + f.n.y * off * side,
      },
      // Facing away from the wall: (-sin r, cos r) = side · n.
      rotation: Math.atan2(-f.n.x * side, f.n.y * side),
    };
  }
  return best ? { at: best.at, rotation: best.rotation, wallId: best.wallId } : { at, rotation };
}

/**
 * The nearest centre to `u` along wall `f` at which a piece of `size`, backed onto the face
 * on `side`, stays clear of every other wall and junction: those reaching into the strip it
 * would stand in, measured along the wall.
 */
function clearAlong(
  geom: PlanGeometry,
  f: PlanGeometry['frames'][string],
  side: 1 | -1,
  u: number,
  size: { w: number; d: number },
): number {
  const s0 = f.half + 0.01;
  const s1 = f.half + size.d;
  const blocked: [number, number][] = [];
  const solids = [
    ...geom.pieces.filter((p) => p.wallId !== f.wall.id).map((p) => p.polygon),
    ...geom.footprints.hubs.map((h) => h.polygon),
  ];
  for (const poly of solids) {
    // Into the wall's frame: along it, and out from its centre line on `side`.
    const local = poly.map((p) => {
      const rx = p.x - f.a.x;
      const ry = p.y - f.a.y;
      return { x: rx * f.d.x + ry * f.d.y, y: (rx * f.n.x + ry * f.n.y) * side };
    });
    const inStrip = clipSlab(local, s0, s1);
    if (inStrip.length < 3) continue;
    const xs = inStrip.map((p) => p.x);
    blocked.push([Math.min(...xs), Math.max(...xs)]);
  }
  const half = size.w / 2;
  const free = (c: number) =>
    blocked.every(([a, b]) => c + half <= a + 1e-6 || c - half >= b - 1e-6);
  if (free(u)) return u;
  // Only along this wall: a piece too wide for the free stretch stays where it snapped,
  // overlapping, rather than leaving the wall altogether.
  const options = blocked
    .flatMap(([a, b]) => [a - half - 0.005, b + half + 0.005])
    .filter((c) => c >= 0 && c <= f.length && free(c))
    .sort((p, q) => Math.abs(p - u) - Math.abs(q - u));
  return options[0] ?? u;
}

/** The part of a polygon with y between y0 and y1 (two Sutherland–Hodgman passes). */
function clipSlab(poly: Vec2[], y0: number, y1: number): Vec2[] {
  const clip = (pts: Vec2[], keep: (p: Vec2) => boolean, y: number) => {
    const out: Vec2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i] as Vec2;
      const q = pts[(i + 1) % pts.length] as Vec2;
      if (keep(p)) out.push(p);
      if (keep(p) !== keep(q)) {
        const t = (y - p.y) / (q.y - p.y);
        out.push({ x: p.x + (q.x - p.x) * t, y });
      }
    }
    return out;
  };
  return clip(
    clip(poly, (p) => p.y >= y0, y0),
    (p) => p.y <= y1,
    y1,
  );
}

const lvl = draftLevel;

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

/**
 * A copy of `item` beside it: one width (and a 5 cm gap) along its own width, as you would
 * set out a row of chairs. The caller makes the id; addItem stores it.
 */
export function duplicateOf(item: Item, id: string): Item {
  const step = itemSize(item).w + 0.05;
  return {
    ...structuredClone(item),
    id,
    position: {
      ...item.position,
      x: item.position.x + Math.cos(item.rotationY) * step,
      z: item.position.z + Math.sin(item.rotationY) * step,
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

/** Adds an uploaded model to the project's catalogue. The caller makes its id. */
export function addModel(model: CustomModel): Command {
  return {
    label: `Add model ${model.name}`,
    recipe: (d) => {
      d.models ??= {};
      d.models[model.id] = structuredClone(model);
    },
  };
}

/** Renames an uploaded model or moves it to another category. */
export function updateModel(
  id: string,
  patch: Partial<Pick<CustomModel, 'name' | 'category'>>,
): Command {
  return {
    label: 'Edit model',
    recipe: (d) => {
      const m = d.models?.[id];
      if (!m) throw new Error(`model ${id} not found`);
      if (patch.name !== undefined) {
        const name = patch.name.trim().slice(0, 80);
        if (name) m.name = name;
      }
      if (patch.category !== undefined) m.category = patch.category;
    },
  };
}

/**
 * Takes an uploaded model out of the project, with every piece made from it (in both the
 * flat as it is and the renovation), in one undo step.
 */
export function deleteModel(id: string): Command {
  return {
    label: 'Delete model',
    recipe: (d) => {
      if (!d.models?.[id]) throw new Error(`model ${id} not found`);
      delete d.models[id];
      for (const level of [...d.levels, ...(d.renovation?.levels ?? [])]) {
        for (const it of Object.values(level.items)) {
          if (it.assetId === id) delete level.items[it.id];
        }
      }
    },
  };
}

/** How many pieces in the project (both variants) are made from a model. */
export function modelUses(p: Pick<Project, 'levels' | 'renovation'>, id: string): number {
  let n = 0;
  for (const level of [...p.levels, ...(p.renovation?.levels ?? [])]) {
    for (const it of Object.values(level.items)) if (it.assetId === id) n++;
  }
  return n;
}

/** `name` (e.g. "queen bed") goes in the undo label and the Undo toast. */
export function deleteItem(levelId: string, itemId: string, name = 'furniture'): Command {
  return {
    label: `Delete ${name}`,
    recipe: (d) => {
      delete lvl(d, levelId).items[itemId];
    },
  };
}

/** A lamp's light in world space (y up, z = plan y), with the item it belongs to. */
export interface ItemLight {
  itemId: string;
  position: Vec3;
  color: string;
  candela: number;
}

/** Every lamp on the level, with its bulb where the item puts it (moved, turned, scaled). */
export function itemLights(level: Level, elevation = level.elevation): ItemLight[] {
  const out: ItemLight[] = [];
  for (const item of Object.values(level.items)) {
    const light = furnitureKind(item.assetId)?.light;
    if (!light) continue;
    const [lx, ly, lz] = light.at;
    const x = lx * item.scale.x;
    const y = ly * item.scale.z;
    const c = Math.cos(item.rotationY);
    const s = Math.sin(item.rotationY);
    out.push({
      itemId: item.id,
      position: {
        x: item.position.x + x * c - y * s,
        y: elevation + item.position.y + lz * item.scale.y,
        z: item.position.z + x * s + y * c,
      },
      color: light.color,
      candela: light.candela,
    });
  }
  return out;
}
