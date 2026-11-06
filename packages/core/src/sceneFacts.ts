import { roomIdAt, roomsBeside } from './designer/spaces';
import { PAINTS, WALLPAPERS, finish } from './finishes';
import { furnitureKind, itemFootprint, itemSize } from './furniture';
import { labelPoint, pointInPolygon, signedArea } from './geometry';
import { planGeometry } from './plan';
import { roomArea, roomShapes } from './rooms';
import { type Level, type Vec2, type Vec3, isBoundary, isGlass } from './schema';
import { EYE_HEIGHT, type Segment, collisionSegments, rayDistance } from './walk';

/**
 * What a 3D view actually shows, as plain facts for an image model: which rooms, how big,
 * how high the camera is, and which furniture is in sight. Without them a model reads a
 * view from high up as a big room and fills it with furniture that isn't there.
 * World space: plan (x, y) is world (x, z), +y up.
 */
export interface SceneCamera {
  position: Vec3;
  /** A point it looks at (the orbit's target, or any point ahead). */
  target: Vec3;
  /** Vertical field of view, radians. */
  fov: number;
  /** Width over height of the picture. */
  aspect: number;
  /** The picture's up direction in the world, for a view looking straight down. */
  up?: Vec3;
}

export interface SceneRoomFact {
  id: string;
  name: string;
  /** The room's extent across the picture (left to right) and into it, metres. */
  width: number;
  depth: number;
  /** Floor area, m² (to wall centre lines, as the plan measures it). */
  area: number;
  ceilingHeight: number;
  /** Its floor finish's name and the paints of the walls round it. */
  floor?: string;
  walls: string[];
  /** Open to the first room (an open kitchen: a room boundary, no wall, between them). */
  open?: boolean;
}

export interface SceneItemFact {
  id: string;
  name: string;
  /** Width, depth and height, metres. */
  size: { w: number; d: number; h: number };
  /** Roughly where it is: "against the left wall", "by the window", "centre". */
  where: string;
  roomId: string | null;
}

export type SceneView = 'eye' | 'overhead' | 'outside';

export interface SceneFacts {
  /** The room the picture is of first, then others in sight (through a doorway, from above). */
  rooms: SceneRoomFact[];
  /** The room the camera stands in, if any. */
  cameraRoomId: string | null;
  /** Camera height above the floor, metres. */
  height: number;
  /** Field of view across and up and down, degrees. */
  fovAcross: number;
  fovUp: number;
  /** Inside a room at about eye height, from above (2.2 m and up), or outside every room. */
  view: SceneView;
  /** The furniture in sight, largest first, at most MAX_SCENE_ITEMS. */
  items: SceneItemFact[];
  /** How many more pieces are in sight than are listed. */
  moreItems: number;
}

/** Above this the view is from overhead (a person's eye is about 1.6 m). */
export const OVERHEAD_HEIGHT = 2.2;
export const MAX_SCENE_ITEMS = 25;
const NEAR = 0.05;
const MAX_ROOMS = 6;

interface V3 {
  x: number;
  y: number;
  z: number;
}
const sub3 = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot3 = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross3 = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const norm3 = (a: V3): V3 => {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};

/** The camera's axes and its frustum's half-angle tangents. */
export interface CameraFrame {
  eye: V3;
  forward: V3;
  right: V3;
  up: V3;
  tanX: number;
  tanY: number;
}

export function cameraFrame(c: SceneCamera): CameraFrame {
  const forward = norm3(sub3(c.target, c.position));
  // Looking straight down, "up" in the picture comes from the camera, not the world.
  let worldUp: V3 = { x: 0, y: 1, z: 0 };
  if (Math.abs(forward.y) > 0.999) worldUp = c.up ? norm3(c.up) : { x: 0, y: 0, z: -1 };
  let right = cross3(forward, worldUp);
  if (Math.hypot(right.x, right.y, right.z) < 1e-6) right = { x: 1, y: 0, z: 0 };
  right = norm3(right);
  const up = cross3(right, forward);
  const tanY = Math.tan(c.fov / 2);
  return { eye: c.position, forward, right, up, tanX: tanY * c.aspect, tanY };
}

/** Whether world point `p` is inside the frustum (no far plane). */
export function inFrustum(f: CameraFrame, p: V3): boolean {
  const d = sub3(p, f.eye);
  const z = dot3(d, f.forward);
  if (z < NEAR) return false;
  return Math.abs(dot3(d, f.right)) <= z * f.tanX && Math.abs(dot3(d, f.up)) <= z * f.tanY;
}

/**
 * Whether a box (its corners) can be in sight: false only when every corner is outside one
 * of the frustum's planes (near, left, right, top, bottom), so a box spanning the view counts.
 */
export function boxInFrustum(f: CameraFrame, corners: readonly V3[]): boolean {
  const planes: ((d: V3) => number)[] = [
    (d) => dot3(d, f.forward) - NEAR,
    (d) => dot3(d, f.forward) * f.tanX - dot3(d, f.right),
    (d) => dot3(d, f.forward) * f.tanX + dot3(d, f.right),
    (d) => dot3(d, f.forward) * f.tanY - dot3(d, f.up),
    (d) => dot3(d, f.forward) * f.tanY + dot3(d, f.up),
  ];
  const ds = corners.map((p) => sub3(p, f.eye));
  return planes.every((plane) => ds.some((d) => plane(d) >= 0));
}

function segmentsCross(a: Vec2, b: Vec2, s: Segment): boolean {
  const d1 = { x: b.x - a.x, y: b.y - a.y };
  const d2 = { x: s.b.x - s.a.x, y: s.b.y - s.a.y };
  const den = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(den) < 1e-12) return false;
  const w = { x: s.a.x - a.x, y: s.a.y - a.y };
  const t = (w.x * d2.y - w.y * d2.x) / den;
  const u = (w.x * d1.y - w.y * d1.x) / den;
  return t > 1e-6 && t < 1 - 1e-6 && u >= 0 && u <= 1;
}

function segmentDistance(p: Vec2, s: Segment): number {
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 > 0 ? Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - s.a.x - t * dx, p.y - s.a.y - t * dy);
}

const ringSegments = (ring: readonly Vec2[], out: Segment[]) => {
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length] as Vec2;
    if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-9) out.push({ a, b });
  });
};

/** What blocks sight in plan from below the wall tops: solid walls, hubs and windows. */
function sightBlockers(level: Level, eyeHeight: number): Segment[] {
  const geom = planGeometry(level);
  const out: Segment[] = [];
  for (const p of geom.pieces) {
    const w = level.walls[p.wallId];
    if (!w || isGlass(w) || (w.height ?? level.ceilingHeight) <= eyeHeight) continue;
    ringSegments(p.polygon, out);
  }
  for (const h of geom.footprints.hubs) ringSegments(h.polygon, out);
  // Below a sill and above a window's head the wall is solid; through the glass is the
  // outside or another room's wall. Treat a window as wall.
  for (const o of geom.openings) if (o.kind === 'window') ringSegments(o.polygon, out);
  return out;
}

const fmt = (n: number) => n.toFixed(1);

/**
 * The extent of `poly` across the picture and into it: measured along whichever of its
 * own edge directions lines up best with the camera's right, so a room drawn at an angle
 * is measured along its walls, not its bounding box.
 */
function extents(poly: readonly Vec2[], right: Vec2): { width: number; depth: number } {
  // The tightest box over the room's own edge directions.
  let best = { u: { x: 1, y: 0 }, eu: 0, ev: 0, area: Number.POSITIVE_INFINITY };
  const dirs: Vec2[] = [{ x: 1, y: 0 }];
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length] as Vec2;
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l > 0.3) dirs.push({ x: (b.x - a.x) / l, y: (b.y - a.y) / l });
  });
  for (const u of dirs) {
    const us = poly.map((p) => p.x * u.x + p.y * u.y);
    const vs = poly.map((p) => -p.x * u.y + p.y * u.x);
    const eu = Math.max(...us) - Math.min(...us);
    const ev = Math.max(...vs) - Math.min(...vs);
    if (eu * ev < best.area - 1e-6) best = { u, eu, ev, area: eu * ev };
  }
  // Width is the side that runs most nearly across the picture.
  const { u, eu, ev } = best;
  const across =
    Math.abs(u.x * right.x + u.y * right.y) >= Math.abs(-u.y * right.x + u.x * right.y);
  return across ? { width: eu, depth: ev } : { width: ev, depth: eu };
}

function roomFact(level: Level, id: string, right: Vec2): SceneRoomFact | null {
  const room = level.rooms[id];
  const shape = roomShapes(level).get(id);
  if (!room || !shape || shape.outer.length < 3) return null;
  const { width, depth } = extents(shape.outer, right);
  const walls = new Set<string>();
  for (const w of Object.values(level.walls)) {
    const [left, rightRoom] = roomsBeside(level, w.id);
    const m = left === id ? w.materialLeft : rightRoom === id ? w.materialRight : null;
    // A paint's own name (the shared id also names a plain floor).
    const name = m && ([...PAINTS, ...WALLPAPERS].find((p) => p.id === m) ?? finish(m))?.name;
    if (name) walls.add(name);
  }
  return {
    id,
    name: room.name,
    width,
    depth,
    area: roomArea(level, room),
    ceilingHeight: room.ceilingHeight ?? level.ceilingHeight,
    floor: finish(room.floorMaterial)?.name,
    walls: [...walls],
  };
}

/** Floor points of a room, about `n` of them on a grid, inside its floor. */
function floorSamples(outer: readonly Vec2[], holes: readonly Vec2[][], n = 120): Vec2[] {
  const xs = outer.map((p) => p.x);
  const ys = outer.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const step = Math.max(0.15, Math.sqrt(((x1 - x0) * (y1 - y0)) / n));
  const out: Vec2[] = [];
  for (let x = x0 + step / 2; x < x1; x += step) {
    for (let y = y0 + step / 2; y < y1; y += step) {
      const p = { x, y };
      if (pointInPolygon(p, outer) && !holes.some((h) => pointInPolygon(p, h))) out.push(p);
    }
  }
  return out;
}

/** Window middles and the rooms either side of each. */
function windowSpots(level: Level): { at: Vec2; rooms: (string | null)[] }[] {
  return planGeometry(level)
    .openings.filter((o) => o.kind === 'window')
    .map((o) => {
      const fr = o.frame;
      const u = (o.span[0] + o.span[1]) / 2;
      const at = { x: fr.a.x + fr.d.x * u, y: fr.a.y + fr.d.y * u };
      const side = (k: number) =>
        roomIdAt(level, { x: at.x + fr.n.x * 0.3 * k, y: at.y + fr.n.y * 0.3 * k });
      return { at, rooms: [side(1), side(-1)] };
    });
}

/** Which wall of the room a footprint stands against (within 25 cm), seen from the camera. */
function againstWall(f: CameraFrame, footprint: Vec2[], ring: readonly Vec2[]): string | null {
  let near: { d: number; n: Vec2 } | null = null;
  const sign = signedArea(ring) > 0 ? 1 : -1;
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length] as Vec2;
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l < 1e-9) return;
    // Outward, away from the floor.
    const n = { x: (sign * (b.y - a.y)) / l, y: (sign * -(b.x - a.x)) / l };
    for (const p of footprint) {
      const t = Math.max(
        0,
        Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (l * l)),
      );
      const d = Math.hypot(p.x - a.x - t * (b.x - a.x), p.y - a.y - t * (b.y - a.y));
      if (!near || d < near.d) near = { d, n };
    }
  });
  const hit = near as { d: number; n: Vec2 } | null;
  if (!hit || hit.d >= 0.25) return null;
  const fx = { x: f.forward.x, y: f.forward.z };
  const lf = Math.hypot(fx.x, fx.y);
  const along = (hit.n.x * fx.x + hit.n.y * fx.y) / (lf || 1);
  const side = hit.n.x * f.right.x + hit.n.y * f.right.z;
  if (lf > 0.3 && Math.abs(along) >= Math.abs(side)) {
    return along > 0 ? 'against the far wall' : 'against the near wall';
  }
  return side > 0 ? 'against the right wall' : 'against the left wall';
}

/** Where an item sits, as the picture shows it: "against the left wall, by the window". */
function itemWhere(
  level: Level,
  f: CameraFrame,
  windows: { at: Vec2; rooms: (string | null)[] }[],
  footprint: Vec2[],
  centre: V3,
  roomId: string | null,
  hung: boolean,
): string {
  if (hung) return 'hanging from the ceiling';
  const ring = roomId ? roomShapes(level).get(roomId)?.outer : undefined;
  let where = ring ? againstWall(f, footprint, ring) : null;
  if (!where) {
    const d = sub3(centre, f.eye);
    const x = dot3(d, f.right) / Math.max(NEAR, dot3(d, f.forward) * f.tanX);
    where = x < -0.33 ? 'left' : x > 0.33 ? 'right' : 'centre';
  }
  // By a window of its own room: within half a metre past its own reach.
  const reach = Math.max(...footprint.map((p) => Math.hypot(p.x - centre.x, p.y - centre.z)));
  const byWindow = windows.some(
    (w) =>
      (!roomId || w.rooms.includes(roomId)) &&
      Math.hypot(w.at.x - centre.x, w.at.y - centre.z) < reach + 0.5,
  );
  return byWindow ? `${where}, by the window` : where;
}

/** The room the view looks into: where its middle meets the floor, if that is in one. */
function centreRoom(level: Level, f: CameraFrame, target: V3): string | null {
  const floor = level.elevation;
  if (f.forward.y < -0.02) {
    const t = (floor - f.eye.y) / f.forward.y;
    const hit = { x: f.eye.x + f.forward.x * t, y: f.eye.z + f.forward.z * t };
    const id = roomIdAt(level, hit);
    if (id) return id;
  }
  return roomIdAt(level, { x: target.x, y: target.z });
}

/**
 * The room and the rooms open to it, joined by room boundaries rather than walls (an open
 * kitchen and the living room): one space to stand in. Largest first.
 */
export function openPlan(level: Level, roomId: string): string[] {
  const seen = new Set([roomId]);
  const queue = [roomId];
  const joins = Object.values(level.walls)
    .filter(isBoundary)
    .map((w) => roomsBeside(level, w.id));
  while (queue.length) {
    const id = queue.shift() as string;
    for (const [a, b] of joins) {
      const other = a === id ? b : b === id ? a : null;
      if (other && !seen.has(other)) {
        seen.add(other);
        queue.push(other);
      }
    }
  }
  const area = (id: string) => {
    const r = level.rooms[id];
    return r ? roomArea(level, r) : 0;
  };
  return [...seen].sort((a, b) => area(b) - area(a) || a.localeCompare(b));
}

/** The facts of what camera `c` sees of `level`. */
export function sceneFacts(level: Level, c: SceneCamera): SceneFacts {
  const f = cameraFrame(c);
  const height = c.position.y - level.elevation;
  const at = { x: c.position.x, y: c.position.z };
  const cameraRoomId = roomIdAt(level, at);
  const view: SceneView = !cameraRoomId ? 'outside' : height > OVERHEAD_HEIGHT ? 'overhead' : 'eye';
  // Below the wall tops, walls hide what's behind them; from above, the view sees over them.
  const occludes = height < level.ceilingHeight;
  const blockers = occludes ? sightBlockers(level, height) : [];
  const seen = (p: Vec2) => !occludes || !blockers.some((s) => segmentsCross(at, p, s));

  // How much of each room's floor is in sight.
  const shapes = roomShapes(level);
  const share = new Map<string, number>();
  for (const [id, s] of shapes) {
    const pts = floorSamples(s.outer, s.holes);
    if (!pts.length) continue;
    const vis = pts.filter(
      (p) => inFrustum(f, { x: p.x, y: level.elevation, z: p.y }) && seen(p),
    ).length;
    const room = level.rooms[id];
    if (vis && room) share.set(id, (vis / pts.length) * roomArea(level, room));
  }
  const main =
    view === 'eye'
      ? cameraRoomId
      : (centreRoom(level, f, c.target) ??
        [...share.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
        null);
  const right2 = { x: f.right.x, y: f.right.z };
  // Rooms open to it (no wall between) are part of the same space, in sight or not.
  const open = main ? openPlan(level, main).filter((id) => id !== main) : [];
  const ids = [
    ...new Set([
      ...(main ? [main] : []),
      ...open,
      ...[...share.entries()]
        .filter(([, a]) => a >= 0.5)
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id),
    ]),
  ].slice(0, MAX_ROOMS);
  const rooms = ids
    .map((id) => roomFact(level, id, right2))
    .filter((r): r is SceneRoomFact => !!r)
    .map((r) => (open.includes(r.id) ? { ...r, open: true } : r));

  // The furniture in sight: its box in the frustum, and (below the wall tops) not behind a wall.
  const listed: (SceneItemFact & { footprintArea: number })[] = [];
  const windows = windowSpots(level);
  for (const item of Object.values(level.items)) {
    const kind = furnitureKind(item.assetId);
    if (kind?.category === 'People') continue;
    const size = itemSize(item, kind);
    const fp = itemFootprint(item, kind);
    const y0 = level.elevation + item.position.y;
    const corners = fp.flatMap((p) => [
      { x: p.x, y: y0, z: p.y },
      { x: p.x, y: y0 + size.h, z: p.y },
    ]);
    if (!boxInFrustum(f, corners)) continue;
    const centre = { x: item.position.x, y: y0 + size.h / 2, z: item.position.z };
    // Seen if its middle or a point just inside a corner is in plain sight.
    const probes = [
      { x: centre.x, y: centre.z },
      ...fp.map((p) => ({ x: p.x + (centre.x - p.x) * 0.15, y: p.y + (centre.z - p.y) * 0.15 })),
    ];
    if (!probes.some(seen)) continue;
    const roomId = roomIdAt(level, { x: centre.x, y: centre.z });
    listed.push({
      id: item.id,
      name: kind?.name ?? 'Piece of furniture',
      size,
      where: itemWhere(level, f, windows, fp, centre, roomId, !!kind?.ceiling),
      roomId,
      footprintArea: size.w * size.d,
    });
  }
  listed.sort((a, b) => b.footprintArea - a.footprintArea || a.id.localeCompare(b.id));
  const items = listed.slice(0, MAX_SCENE_ITEMS).map(({ footprintArea: _, ...it }) => it);

  const fovUp = (c.fov * 180) / Math.PI;
  const fovAcross = (2 * Math.atan(Math.tan(c.fov / 2) * c.aspect) * 180) / Math.PI;
  return {
    rooms,
    cameraRoomId,
    height,
    fovAcross,
    fovUp,
    view,
    items,
    moreItems: listed.length - items.length,
  };
}

/** A natural photographer's view: 70° across a wide picture, 70° up a tall one. */
export const EYE_FOV = (70 * Math.PI) / 180;
/** Kept between the camera and the wall behind it, metres. */
const BACK_CLEARANCE = 0.45;
/** A view ahead shorter than this (metres) may turn a little for a better one. */
const CRAMPED = 2.5;
/** Tilted down this much, so the floor and the furniture fill the picture (radians). */
const EYE_TILT = (8 * Math.PI) / 180;

/** The vertical field of view for EYE_FOV on its longer side, at `aspect`. */
export const eyeFov = (aspect: number) =>
  aspect >= 1 ? 2 * Math.atan(Math.tan(EYE_FOV / 2) / aspect) : EYE_FOV;

/**
 * A camera at eye height in the room camera `c` looks into, facing the same way across
 * the floor, backed up to the wall behind so the room is framed. Null if there's no room.
 */
export function eyeLevelCamera(
  level: Level,
  c: SceneCamera,
): { roomId: string; camera: SceneCamera } | null {
  const facts = sceneFacts(level, c);
  const centred = facts.view === 'eye' ? facts.cameraRoomId : (facts.rooms[0]?.id ?? null);
  if (!centred) return null;
  // The space to stand in: the room and any open to it, without the boundaries between.
  const shapes = roomShapes(level);
  const space = openPlan(level, centred).filter((id) => (shapes.get(id)?.outer.length ?? 0) >= 3);
  if (!space.length) return null;
  const inSpace = new Set(space);
  const outline: Segment[] = [];
  for (const id of space) {
    const s = shapes.get(id) as { outer: Vec2[]; holes: Vec2[][] };
    for (const ring of [s.outer, ...s.holes]) {
      const segs: Segment[] = [];
      ringSegments(ring, segs);
      // An edge shared with another room of the space isn't a wall to back onto.
      for (const seg of segs) {
        const mid = { x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2 };
        const l = Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y) || 1;
        const n = { x: (-(seg.b.y - seg.a.y) / l) * 0.05, y: ((seg.b.x - seg.a.x) / l) * 0.05 };
        const a = roomIdAt(level, { x: mid.x + n.x, y: mid.y + n.y });
        const b = roomIdAt(level, { x: mid.x - n.x, y: mid.y - n.y });
        if (!(a && b && a !== b && inSpace.has(a) && inSpace.has(b))) outline.push(seg);
      }
    }
  }
  const f = cameraFrame(c);
  // The direction across the floor: the camera's, or (looking straight down) its picture's up.
  let dir = { x: f.forward.x, y: f.forward.z };
  if (Math.hypot(dir.x, dir.y) < 0.05) dir = { x: f.up.x, y: f.up.z };
  const l = Math.hypot(dir.x, dir.y) || 1;
  dir = { x: dir.x / l, y: dir.y / l };
  const eyeY = level.elevation + EYE_HEIGHT;
  // Where a person could stand: a step clear of furniture on the floor (as a walk is) and of
  // anything up at eye height (a wall cabinet).
  const solid = Object.values(level.items)
    .map((it) => {
      const kind = furnitureKind(it.assetId);
      const top = it.position.y + itemSize(it, kind).h;
      const inWay =
        (it.flags.collidable && it.position.y < 1) ||
        (top > EYE_HEIGHT - 0.3 && it.position.y < EYE_HEIGHT + 0.2);
      return inWay ? itemFootprint(it, kind) : null;
    })
    .filter((fp): fp is Vec2[] => !!fp);
  const STEP = 0.3;
  const around = [
    { x: 0, y: 0 },
    { x: STEP, y: 0 },
    { x: -STEP, y: 0 },
    { x: 0, y: STEP },
    { x: 0, y: -STEP },
  ];
  // The walls' faces and the doors' open leaves, as a walk meets them: not to stand in
  // or look straight into.
  const built = collisionSegments({ ...level, items: {} });
  const sight = [...outline, ...built];
  const blocked = (p: Vec2) =>
    solid.some((fp) => around.some((o) => pointInPolygon({ x: p.x + o.x, y: p.y + o.y }, fp))) ||
    built.some((s) => segmentDistance(p, s) < STEP);
  const inFloor = (p: Vec2) => {
    const id = roomIdAt(level, p);
    return !!id && inSpace.has(id);
  };
  // From each room's middle (the largest room's first), backed up to the wall behind, then
  // forward to the first spot that's clear: the one with the longest view ahead wins.
  const place = (d: Vec2) => {
    let best: { at: Vec2; view: number } | null = null;
    for (const id of space) {
      const start = labelPoint((shapes.get(id) as { outer: Vec2[] }).outer);
      const back = rayDistance(outline, start, { x: -d.x, y: -d.y });
      const ahead = rayDistance(outline, start, d);
      if (!Number.isFinite(back) || !Number.isFinite(ahead)) continue;
      const from = Math.max(0, back - BACK_CLEARANCE);
      const to = -Math.max(0, ahead - BACK_CLEARANCE);
      for (let s = from; s >= to; s -= 0.1) {
        const p = { x: start.x - d.x * s, y: start.y - d.y * s };
        if (!inFloor(p) || blocked(p)) continue;
        const view = rayDistance(sight, p, d);
        // A smaller room's spot has to see clearly further to be chosen over the largest's.
        const score = view - (best ? 0.5 : 0);
        if (!best || score > best.view) best = { at: p, view };
        break;
      }
    }
    return best;
  };
  let best = place(dir);
  // A cramped view (a small room, a wall close ahead): turned up to 60° either way, for a
  // view across the room, each 15° turned costing what 30 cm more of view gains.
  if (!best || best.view < CRAMPED) {
    let score = best ? best.view : Number.NEGATIVE_INFINITY;
    const h0 = Math.atan2(dir.y, dir.x);
    for (const k of [-4, -3, -2, -1, 1, 2, 3, 4]) {
      const h = h0 + (k * Math.PI) / 12;
      const d = { x: Math.cos(h), y: Math.sin(h) };
      const b = place(d);
      if (b && b.view - Math.abs(k) * 0.3 > score) {
        score = b.view - Math.abs(k) * 0.3;
        best = b;
        dir = d;
      }
    }
  }
  // Nowhere clear (a room full of furniture): its middle, over whatever is there.
  const at = best?.at ?? labelPoint((shapes.get(space[0] as string) as { outer: Vec2[] }).outer);
  const roomId = roomIdAt(level, at) ?? centred;
  const aspect = c.aspect;
  return {
    roomId,
    camera: {
      position: { x: at.x, y: eyeY, z: at.y },
      target: { x: at.x + dir.x * 3, y: eyeY - 3 * Math.tan(EYE_TILT), z: at.y + dir.y * 3 },
      fov: eyeFov(aspect),
      aspect,
    },
  };
}

/** The room the camera's in or looks into, by name, if any. */
export const sceneRoomName = (facts: SceneFacts): string | null => facts.rooms[0]?.name ?? null;

const size2 = (s: { w: number; d: number }) => `${fmt(s.w)} × ${fmt(s.d)}`;
const size3 = (s: { w: number; d: number; h: number }) => `${size2(s)} × ${fmt(s.h)} m`;
const roomSize = (r: SceneRoomFact) =>
  `${fmt(r.width)} m × ${fmt(r.depth)} m (${fmt(r.area)} m²), ceiling ${fmt(r.ceilingHeight)} m`;

/** A room this small reads as small to a person; say so, or a model makes it roomy. */
const SMALL_ROOM = 15;

/**
 * The facts as a short "scene sheet" for an image model's prompt. `finishes` also names the
 * floor and wall finishes (for a render that keeps them as they are).
 */
export function sceneSheet(facts: SceneFacts, opts: { finishes?: boolean } = {}): string {
  const out: string[] = [];
  const [main, ...others] = facts.rooms;
  const across = Math.round(facts.fovAcross);
  const h = fmt(facts.height);
  if (facts.view === 'eye') {
    if (main) out.push(`This is ${main.name}, ${roomSize(main)}.`);
    out.push(
      `The camera is ${h} m above the floor, at eye height, with a ${across}° field of view across.`,
    );
    const list = (rs: SceneRoomFact[]) => rs.map((r) => `${r.name}, ${roomSize(r)}`).join('; ');
    const open = others.filter((r) => r.open);
    const beyond = others.filter((r) => !r.open);
    if (open.length) out.push(`It is open to ${list(open)}, with no wall between.`);
    if (beyond.length) out.push(`Also in sight through a doorway: ${list(beyond)}.`);
  } else {
    const where = facts.view === 'outside' ? 'from outside the rooms' : 'from above';
    out.push(
      `This is a cut-away view ${where}: the camera is ${h} m above the floor with a ${across}° field of view across, looking into rooms with no ceiling drawn, so they look bigger than they are.`,
    );
    if (facts.rooms.length) {
      out.push(`Rooms in view: ${facts.rooms.map((r) => `${r.name}, ${roomSize(r)}`).join('; ')}.`);
    }
  }
  if (facts.items.length) {
    const list = facts.items.map((i) => `${i.name} ${size3(i.size)} (${i.where})`).join(', ');
    const more = facts.moreItems ? `, and ${facts.moreItems} smaller pieces` : '';
    out.push(`The only furniture in view: ${list}${more}.`);
  } else {
    out.push('There is no furniture in view.');
  }
  if (opts.finishes && main) {
    const bits = [
      main.walls.length ? `walls ${main.walls.join(', ')}` : '',
      main.floor ? `floor ${main.floor}` : '',
    ].filter(Boolean);
    if (bits.length) out.push(`Finishes in ${main.name}: ${bits.join('; ')}.`);
  }
  // Small as a person sees it: the room with any open to it.
  const space = facts.rooms.filter((r, i) => i === 0 || r.open).reduce((t, r) => t + r.area, 0);
  const many = facts.view !== 'eye' && facts.rooms.length > 1;
  const small = !main
    ? ''
    : many
      ? facts.rooms.every((r) => r.area < SMALL_ROOM)
        ? '; they are small'
        : ''
      : space < SMALL_ROOM
        ? '; it is small'
        : '';
  out.push(
    `Keep ${many ? 'every room' : 'the room'} exactly this size${small}. Do not add, remove, enlarge or move furniture; leave empty floor empty. Everything must stay at true scale.`,
  );
  return out.join(' ');
}
