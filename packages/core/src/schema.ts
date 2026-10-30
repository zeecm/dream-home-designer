import { z } from 'zod';

/**
 * Project document schema. Units are metres and radians everywhere.
 * Plan space is 2D (x right, y down as drawn on the floor plan); world space maps
 * plan (x, y) to (x, 0, y) with +Y up.
 */

export const Vec2 = z.object({ x: z.number(), y: z.number() });
export type Vec2 = z.infer<typeof Vec2>;

export const Vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });
export type Vec3 = z.infer<typeof Vec3>;

export const Vertex = z.object({ id: z.string(), x: z.number(), y: z.number() });
export type Vertex = z.infer<typeof Vertex>;

export const Wall = z.object({
  id: z.string(),
  /** Vertex ids. Vertices are shared, so moving one moves every wall that ends at it. */
  a: z.string(),
  b: z.string(),
  thickness: z.number().positive().default(0.1),
  /** Undefined means the level's ceilingHeight. */
  height: z.number().positive().optional(),
  materialLeft: z.string().default('paint-white'),
  materialRight: z.string().default('paint-white'),
  /**
   * 'boundary' marks a room edge that is not a wall, such as where an open kitchen meets the
   * living room: it divides rooms but has no thickness, is never built in 3D and takes no
   * openings. Absent means a wall.
   */
  kind: z.enum(['wall', 'boundary']).optional(),
});
export type Wall = z.infer<typeof Wall>;

export const isBoundary = (w: Pick<Wall, 'kind'>): boolean => w.kind === 'boundary';

export const OpeningKind = z.enum(['door', 'window', 'passage']);
export type OpeningKind = z.infer<typeof OpeningKind>;

export const Opening = z.object({
  id: z.string(),
  wallId: z.string(),
  kind: OpeningKind,
  /** Centre of the opening as a fraction of the wall length from vertex a. */
  t: z.number().min(0).max(1),
  width: z.number().positive(),
  height: z.number().positive(),
  sill: z.number().min(0),
  swing: z.enum(['leftIn', 'leftOut', 'rightIn', 'rightOut']).optional(),
  assetId: z.string().optional(),
});
export type Opening = z.infer<typeof Opening>;

export const Room = z.object({
  id: z.string(),
  name: z.string(),
  /** Ordered vertex ids around the room. */
  loop: z.array(z.string()).min(3),
  floorMaterial: z.string().default('wood-oak'),
  ceilingMaterial: z.string().default('paint-white'),
  ceilingHeight: z.number().positive().optional(),
});
export type Room = z.infer<typeof Room>;

export const Item = z.object({
  id: z.string(),
  assetId: z.string(),
  position: Vec3,
  rotationY: z.number(),
  scale: Vec3,
  parent: z.string().optional(),
  flags: z.object({ snapWall: z.boolean(), collidable: z.boolean() }),
});
export type Item = z.infer<typeof Item>;

export const Light = z.object({
  id: z.string(),
  kind: z.enum(['point', 'spot']),
  position: Vec3,
  color: z.string(),
  intensity: z.number().min(0),
  itemId: z.string().optional(),
});
export type Light = z.infer<typeof Light>;

export const Level = z.object({
  id: z.string(),
  name: z.string(),
  elevation: z.number(),
  ceilingHeight: z.number().positive().default(2.7),
  vertices: z.record(Vertex),
  walls: z.record(Wall),
  openings: z.record(Opening),
  rooms: z.record(Room),
  items: z.record(Item),
  lights: z.record(Light),
});
export type Level = z.infer<typeof Level>;

export const Underlay = z.object({
  assetKey: z.string(),
  opacity: z.number().min(0).max(1),
  rotation: z.number(),
  /** Image px -> world m: world = origin + px * scale. */
  origin: Vec2,
  scale: z.number().positive(),
});
export type Underlay = z.infer<typeof Underlay>;

export const SCHEMA_VERSION = 2;

export const Project = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string(),
  /** Server-assigned; bumped on every successful save. */
  version: z.number().int().nonnegative(),
  name: z.string().min(1),
  units: z.literal('m'),
  underlay: Underlay.nullable(),
  levels: z.array(Level).min(1),
});
export type Project = z.infer<typeof Project>;

export function parseProject(input: unknown): Project {
  return Project.parse(input);
}
