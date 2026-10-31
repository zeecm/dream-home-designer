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
  /**
   * Which side of its line (a to b) the wall's thickness lies on: absent means centred on
   * it; 'left' or 'right' puts one face on the line. Walls of different thickness in a
   * row keep a flush face this way, as an outside wall does where it thins at a window.
   */
  side: z.enum(['left', 'right']).optional(),
});
export type Wall = z.infer<typeof Wall>;

export const isBoundary = (w: Pick<Wall, 'kind'>): boolean => w.kind === 'boundary';

/** How far a wall's left and right faces lie from its line (left is +n, n = d rotated +90°). */
export function wallFaces(w: Pick<Wall, 'thickness' | 'side' | 'kind'>): {
  left: number;
  right: number;
} {
  if (isBoundary(w)) return { left: 0, right: 0 };
  if (w.side === 'left') return { left: w.thickness, right: 0 };
  if (w.side === 'right') return { left: 0, right: w.thickness };
  return { left: w.thickness / 2, right: w.thickness / 2 };
}

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

/**
 * Where the home stands, for the sun. `north` is the bearing of north from the plan's up
 * direction, in radians clockwise: 0 when north is up the plan, π/2 when it points to the
 * plan's right. `latitude` and `longitude` are in degrees (+ north, + east), and
 * `utcOffset` is the clock's hours ahead of UTC, so times of day read as on a wall clock.
 */
export const Site = z.object({
  north: z.number(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  utcOffset: z.number().min(-12).max(14),
});
export type Site = z.infer<typeof Site>;

/** Singapore, with north up the plan: what a project without a site gets. */
export const DEFAULT_SITE: Site = { north: 0, latitude: 1.35, longitude: 103.82, utcOffset: 8 };

/**
 * A renovation: the same flat as it is planned to be. It starts as a copy of the project's
 * levels with the same element ids (each level's id gets AFTER_SUFFIX), so the two can be
 * compared wall by wall.
 */
export const Renovation = z.object({ levels: z.array(Level).min(1) });
export type Renovation = z.infer<typeof Renovation>;

/**
 * A furniture model someone uploaded to this project (a binary glTF file, kept by the API
 * and named by its SHA-256). It joins the catalogue while the project is open; items made
 * from it have `assetId` = its id.
 */
export const CustomModel = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  /** Hex SHA-256 of the GLB. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** A catalogue category name (FurnitureCategory). */
  category: z.string(),
  /** Its size in metres at scale 1: width (x), depth and height, as measured on upload. */
  size: z.object({ w: z.number().positive(), d: z.number().positive(), h: z.number().positive() }),
});
export type CustomModel = z.infer<typeof CustomModel>;

export const SCHEMA_VERSION = 6;

export const Project = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string(),
  /** Server-assigned; bumped on every successful save. */
  version: z.number().int().nonnegative(),
  name: z.string().min(1),
  units: z.literal('m'),
  underlay: Underlay.nullable(),
  /** Absent means DEFAULT_SITE. */
  site: Site.optional(),
  /** The flat as it is in `levels`; with a renovation, as it will be here. */
  renovation: Renovation.optional(),
  /** Furniture models uploaded to this project, by id. */
  models: z.record(z.string(), CustomModel).optional(),
  levels: z.array(Level).min(1),
});
export type Project = z.infer<typeof Project>;

export function parseProject(input: unknown): Project {
  return Project.parse(input);
}
