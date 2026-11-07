import { type Tier, tieredChains } from './chains';
import { type Carpentry, carpentryOf } from './cost';
import {
  ELEC_KINDS,
  type PointWarning,
  electricalChanges,
  latchEnd,
  pointPosition,
  pointWarnings,
  trunkingPath,
} from './electrical';
import { AGAINST, DEPTH, type RoomFace, faceGeometry, faceUV, roomFaces, roomItems } from './faces';
import { finish } from './finishes';
import { type FurnitureMaterial, furnitureKind, furnitureLayer, itemFootprint } from './furniture';
import { glassPartition, openingsOnWall } from './geometry';
import { type DoorStyle, doorPanels, doorStyle, framePoint, openingSpan } from './plan';
import { renovationDiff } from './renovation';
import {
  type ElecKind,
  type Item,
  type Level,
  type OpeningKind,
  type Vec2,
  hasGlassAbove,
  isBoundary,
  isGlass,
  isHalfWall,
} from './schema';
import { type WallStatus, wallStatus } from './structural';

/**
 * A wall seen straight on (an elevation): one face of a room as you see it standing in the
 * room, to scale: the wall and its finish, openings, the pieces in front of it, the points on
 * it, dimensions and notes. All in metres: `u` along the face from its left end, `z` up from
 * the floor. Spec: docs/specs/elevation.md.
 */

/** Doors of fitted carpentry are drawn no wider than this. */
export const DOOR_MAX = 0.6;
/** Counter to wall cabinet: less than this gets a note… */
export const GAP_USUAL = 0.55;
/** …and less than this over a hob (the hood). */
export const GAP_HOB = 0.65;
/** A wardrobe over 2.2 m tall has a top cabinet from this height (the storage meter's rule). */
export const TOP_CABINET_FROM = 2.1;
const TOP_CABINET_OVER = 2.2;
/** A kitchen base run's plinth. */
const PLINTH = 0.1;
/** Trunking within this of a face runs along it; drawn this deep under the ceiling. */
const TRUNK_NEAR = 0.3;
export const TRUNK_DEPTH = 0.08;

export interface Rect {
  u0: number;
  u1: number;
  z0: number;
  z1: number;
}

export interface ElevWall {
  /** '' for a return (the junction between two runs). */
  wallId: string;
  u0: number;
  u1: number;
  /** solid: to the ceiling; half: to `top`; glass: a framed partition; open: a room boundary. */
  build: 'solid' | 'half' | 'glass' | 'open';
  top: number;
  /** A half wall with fixed glass from its top to the ceiling. */
  glassAbove: boolean;
  /** The finish on this side (solid and half walls), a finish id. */
  material: string | null;
  /** As the flat is (`statusOf`). */
  status: WallStatus;
  /** A glass partition's (or the glass above a half wall's) panes and frame. */
  panes: Rect[];
  frame: Rect[];
}

export interface ElevOpening {
  id: string;
  kind: OpeningKind;
  /** Numbered left to right by kind: Window 1, Window 2. */
  n: number;
  u0: number;
  u1: number;
  sill: number;
  head: number;
  style: DoorStyle;
  panels: number;
  /** Which end the handle is at, as you look; a swing door's hinge is at the other. */
  latch: 'left' | 'right' | null;
  glazed: 'clear' | 'frosted' | 'fluted' | null;
}

export interface ElevPart extends Rect {
  material: FurnitureMaterial;
}

export interface ElevItem {
  id: string;
  assetId: string;
  name: string;
  /** Its boxes projected onto the face, far from you first. */
  parts: ElevPart[];
  outline: Rect;
  /** Square to the face (within 1°, either way round): exact; else a projected outline. */
  square: boolean;
  /** Its back within AGAINST of the face. */
  against: boolean;
  /** How far its nearest point is from the face. */
  near: number;
  /** A real model: drawn as its outline with its name. */
  model: boolean;
  carpentry: Carpentry | null;
  /** Indicative doors (fitted carpentry seen from the front). */
  fronts: Rect[];
  /** Heights of lines across it: a top cabinet, a plinth, the countertop. */
  lines: number[];
  /** Hung on the wall (a wall cabinet). */
  hung: boolean;
}

export interface ElevPoint {
  id: string;
  /** Numbered left to right. */
  n: number;
  kind: ElecKind;
  /** The plate's centre, and its size. */
  u: number;
  z: number;
  w: number;
  h: number;
  /** The height its tag shows: to the plate's centre, an aircon unit's to its top. */
  tagHeight: number;
  /** From the face's left end to its centre, to 10 mm. */
  fromLeft: number;
  warnings: PointWarning[];
  /** Left on a glass wall, where no point can be. */
  onGlass: boolean;
}

export interface ElevTrunk {
  pointId: string;
  u0: number;
  u1: number;
  length: number;
}

/** A vertical dimension at `u`: heights from the floor (`marks`), labels on `side`. */
export interface ElevHeight {
  u: number;
  side: 'left' | 'right';
  marks: number[];
  what: 'ceiling' | 'window' | 'door' | 'half' | 'counter' | 'cabinet' | 'hung';
}

export type NoteKind = 'hidden' | 'covers' | 'lowCabinet' | 'shelterFixing' | 'tooTall';

export interface ElevNote {
  /** Numbered for its "!" badge. */
  n: number;
  kind: NoteKind;
  ids: string[];
  text: string;
  /** Where the red outline goes. */
  at: Rect;
}

export interface Elevation {
  face: RoomFace;
  width: number;
  ceiling: number;
  walls: ElevWall[];
  /** The side walls cut through at the face's ends: section bands outside [0, width]. */
  ends: { u0: number; u1: number; status: WallStatus }[];
  /** Dead-end walls standing out from the face: section bands across it. */
  fins: { wallId: string; u0: number; u1: number; top: number; status: WallStatus }[];
  openings: ElevOpening[];
  items: ElevItem[];
  points: ElevPoint[];
  trunking: ElevTrunk[];
  chains: { tier: Tier; stops: number[] }[];
  heights: ElevHeight[];
  notes: ElevNote[];
  /** The finish on most of the face ("Sage paint"), or null. */
  finishName: string | null;
  /** Nothing on it: no opening, point or piece. */
  empty: boolean;
}

export interface ElevationOptions {
  /** Pieces against the wall (the default), or none. */
  furniture?: 'wall' | 'none';
  /** The level whose walls' status counts (the flat as it is, when showing a renovation). */
  statusOf?: Level;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const mm10 = (x: number) => Math.round(x * 100) / 100;

/** A name mid-sentence: "built-in wardrobe", but "TV console". */
export function midSentence(name: string): string {
  const [a, b] = name;
  return a && b && b === b.toLowerCase() && b !== b.toUpperCase()
    ? a.toLowerCase() + name.slice(1)
    : name;
}

/** A point's word in a note: "Socket", "Switch", "TV point". */
export function pointWord(kind: ElecKind): string {
  switch (kind) {
    case 'socket-double':
    case 'socket-single':
      return 'Socket';
    case 'switch':
      return 'Switch';
    case 'tv':
      return 'TV point';
    case 'data':
      return 'Data point';
    case 'aircon':
      return 'Aircon point';
    case 'cooker':
      return 'Cooker point';
    case 'water-heater':
      return 'Water heater point';
    case 'doorbell':
      return 'Doorbell';
    default:
      return ELEC_KINDS[kind].short;
  }
}

/** A finish as the header says it: "Sage paint", "Fluted wood wallpaper". */
export function finishName(id: string): string | null {
  const f = finish(id);
  if (!f) return null;
  if (id.startsWith('wallpaper-')) return `${f.name} wallpaper`;
  if (id.startsWith('paint-#')) return `Paint ${f.color}`;
  return `${f.name} paint`;
}

const statusCache = new WeakMap<object, Map<string, WallStatus>>();

/** A wall's status as the flat is (`statusOf`, where the wall is there), cached per level. */
function statusIn(statusOf: Level, level: Level, id: string): WallStatus {
  const lvl = statusOf.walls[id] ? statusOf : level;
  const frozen = Object.isFrozen(lvl);
  let m = frozen ? statusCache.get(lvl) : undefined;
  if (!m) {
    m = new Map();
    if (frozen) statusCache.set(lvl, m);
  }
  const hit = m.get(id);
  if (hit) return hit;
  const s = wallStatus(lvl, id);
  m.set(id, s);
  return s;
}

/** Where a wall's frame u lands on the face. */
function uOn(
  face: RoomFace,
  f: ReturnType<typeof faceGeometry>['frames'][string],
  u: number,
  side: 'left' | 'right',
) {
  return faceUV(face, framePoint(f, u, side === 'left' ? 1 : -1)).u;
}

/** A piece projected onto a face (null if it isn't a known kind). */
function projectItem(face: RoomFace, it: Item): ElevItem | null {
  const kind = furnitureKind(it.assetId);
  if (!kind) return null;
  const c = Math.cos(it.rotationY);
  const s = Math.sin(it.rotationY);
  const k = it.scale;
  const parts = kind.parts
    .map((part) => {
      const [x0, y0, z0] = part.min;
      const [x1, y1, z1] = part.max;
      const uv = [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ].map(([x, y]) => {
        const lx = (x as number) * k.x;
        const ly = (y as number) * k.z;
        return faceUV(face, {
          x: it.position.x + lx * c - ly * s,
          y: it.position.z + lx * s + ly * c,
        });
      });
      return {
        u0: Math.min(...uv.map((p) => p.u)),
        u1: Math.max(...uv.map((p) => p.u)),
        z0: it.position.y + z0 * k.y,
        z1: it.position.y + z1 * k.y,
        material: part.material,
        v: Math.min(...uv.map((p) => p.v)),
      };
    })
    .sort((a, b) => a.v - b.v);
  const foot = itemFootprint(it, kind).map((p) => faceUV(face, p));
  const near = Math.min(...foot.map((p) => p.v));
  const outline: Rect = {
    u0: Math.min(...parts.map((p) => p.u0)),
    u1: Math.max(...parts.map((p) => p.u1)),
    z0: Math.min(...parts.map((p) => p.z0)),
    z1: Math.max(...parts.map((p) => p.z1)),
  };
  const xAxis = { x: c, y: s };
  const along = Math.abs(xAxis.x * face.dir.x + xAxis.y * face.dir.y);
  const across = Math.abs(xAxis.x * face.dir.y - xAxis.y * face.dir.x);
  const sin1 = Math.sin((1 * Math.PI) / 180);
  const square = Math.min(along, across) < sin1;
  // Its front faces you: its back to the face.
  const front = { x: -s, y: c };
  const facing = front.x * face.normal.x + front.y * face.normal.y > Math.cos((1 * Math.PI) / 180);
  const carpentry = carpentryOf(it) ?? null;
  const fronts: Rect[] = [];
  const lines: number[] = [];
  if (carpentry && square && facing) {
    const w = outline.u1 - outline.u0;
    const doors = Math.max(1, Math.ceil(w / DOOR_MAX - 1e-9));
    const step = w / doors;
    const base = it.position.y;
    const top = outline.z1;
    let z0 = outline.z0;
    let z1 = top;
    if (carpentry === 'wardrobe' || carpentry === 'tall') {
      z0 = base + 0.05;
      if (top - base > TOP_CABINET_OVER + 1e-9) lines.push(base + TOP_CABINET_FROM);
    } else if (carpentry === 'base') {
      z0 = base + PLINTH;
      z1 = top - 0.03;
      lines.push(base + PLINTH, z1);
    }
    if (carpentry !== 'low') {
      for (let i = 0; i < doors; i++) {
        fronts.push({ u0: outline.u0 + i * step, u1: outline.u0 + (i + 1) * step, z0, z1 });
      }
    }
  }
  return {
    id: it.id,
    assetId: it.assetId,
    name: kind.name,
    parts: parts.map(({ v: _v, ...p }) => p),
    outline,
    square,
    against: near <= AGAINST + 1e-9,
    near,
    model: !!kind.model,
    carpentry,
    fronts,
    lines,
    hung: furnitureLayer(kind) === 'high',
  };
}

const overlap = (a0: number, a1: number, b0: number, b1: number) =>
  Math.min(a1, b1) - Math.max(a0, b0);
const rectsMeet = (a: Rect, b: Rect) =>
  overlap(a.u0, a.u1, b.u0, b.u1) > 1e-6 && overlap(a.z0, a.z1, b.z0, b.z1) > 1e-6;

/** Pieces a socket behind is out of reach: a bed, or something at least 1.5 m tall… */
function hides(it: ElevItem): boolean {
  const kind = furnitureKind(it.assetId);
  if (!kind) return false;
  if (kind.comesFlat === 'bed' || kind.shape === 'bed') return true;
  // …that is storage or furniture (not a fridge, a lamp, a plant or a person).
  const furniture = ['Bedroom', 'Living', 'Dining', 'Storage', 'Built-in'].includes(kind.category);
  return furniture && !it.hung && it.outline.z1 - it.outline.z0 >= 1.5 - 1e-9;
}

/** Things that cover a window: furniture, not a lamp, a plant or a person. */
const covers = (it: ElevItem) => {
  const cat = furnitureKind(it.assetId)?.category;
  return cat !== 'Lighting' && cat !== 'Decor' && cat !== 'People';
};

/**
 * The face as you see it: its walls (solid with this side's finish, half, glass or open), the
 * openings on it, the pieces in front of it (within DEPTH, far from you first), its points,
 * the trunking along it, dimensions (tier 1 the openings, tier 0 adding pieces against the
 * wall, tier 2 the overall), heights, and notes.
 */
export function wallElevation(
  level: Level,
  face: RoomFace,
  opts: ElevationOptions = {},
): Elevation {
  const geom = faceGeometry(level);
  const statusOf = opts.statusOf ?? level;
  const L = face.length;
  const ceiling = face.ceiling;
  const walls: ElevWall[] = [];
  const openings: ElevOpening[] = [];

  for (const s of face.stretches) {
    const w = level.walls[s.wallId];
    const f = geom.frames[s.wallId];
    if (!w || !f) continue;
    const u0 = clamp(s.u0, 0, L);
    const u1 = clamp(s.u1, 0, L);
    const status = isBoundary(w) ? 'none' : statusIn(statusOf, level, w.id);
    if (isBoundary(w)) {
      walls.push({
        wallId: w.id,
        u0,
        u1,
        build: 'open',
        top: ceiling,
        glassAbove: false,
        material: null,
        status,
        panes: [],
        frame: [],
      });
      continue;
    }
    const ops = openingsOnWall(level, w.id);
    // A wall's glass, mapped onto the face and kept to this stretch.
    const glassOf = (y0: number, y1: number) => {
      const g = glassPartition(f.length, y0, y1, ops);
      const map = (r: { u0: number; u1: number; y0: number; y1: number }): Rect | null => {
        const a = clamp(r.u0, s.from, s.to);
        const b = clamp(r.u1, s.from, s.to);
        if (b - a < 1e-6) return null;
        const p = uOn(face, f, a, s.side);
        const q = uOn(face, f, b, s.side);
        return { u0: Math.min(p, q), u1: Math.max(p, q), z0: r.y0, z1: r.y1 };
      };
      return {
        panes: g.panes.map(map).filter((r): r is Rect => !!r),
        frame: g.frame.map(map).filter((r): r is Rect => !!r),
      };
    };
    if (isGlass(w)) {
      const g = glassOf(0, ceiling);
      walls.push({
        wallId: w.id,
        u0,
        u1,
        build: 'glass',
        top: ceiling,
        glassAbove: false,
        material: null,
        status,
        ...g,
      });
    } else {
      const half = isHalfWall(w, ceiling);
      const top = half ? (w.height as number) : ceiling;
      const above = half && hasGlassAbove(w, ceiling);
      const g = above ? glassOf(top, ceiling) : { panes: [], frame: [] };
      walls.push({
        wallId: w.id,
        u0,
        u1,
        build: half ? 'half' : 'solid',
        top,
        glassAbove: above,
        material: s.side === 'left' ? w.materialLeft : w.materialRight,
        status,
        ...g,
      });
    }
    for (const o of ops) {
      const [a, b] = openingSpan(f, o);
      if (overlap(a, b, s.from, s.to) <= 1e-3) continue;
      const p = uOn(face, f, a, s.side);
      const q = uOn(face, f, b, s.side);
      const le = latchEnd(o);
      // Vertex a's end is on the left as you look at the wall's left side.
      const latch = le === undefined ? null : (le === 0) === (s.side === 'left') ? 'left' : 'right';
      openings.push({
        id: o.id,
        kind: o.kind,
        n: 0,
        u0: clamp(Math.min(p, q), 0, L),
        u1: clamp(Math.max(p, q), 0, L),
        sill: o.kind === 'window' ? o.sill : 0,
        head: Math.min(ceiling, (o.kind === 'window' ? o.sill : 0) + o.height),
        style: doorStyle(o),
        panels: doorPanels(o),
        latch,
        glazed: o.glazed ?? null,
      });
    }
  }
  if (face.stretches.length === 0) {
    walls.push({
      wallId: '',
      u0: 0,
      u1: L,
      build: 'solid',
      top: ceiling,
      glassAbove: false,
      material: null,
      status: 'none',
      panes: [],
      frame: [],
    });
  }
  openings.sort((a, b) => a.u0 - b.u0);
  const counts: Partial<Record<OpeningKind, number>> = {};
  for (const o of openings) {
    counts[o.kind] = (counts[o.kind] ?? 0) + 1;
    o.n = counts[o.kind] as number;
  }

  // The side walls at the ends, and dead-end walls standing out from the face.
  const faces = roomFaces(level, face.roomId);
  const sameLoop = faces.filter((f) => (f.kind === 'hole') === (face.kind === 'hole'));
  const at = sameLoop.findIndex((f) => f.index === face.index);
  const ends: Elevation['ends'] = [];
  const endOf = (f: RoomFace | undefined, last: boolean, u: number) => {
    const s = f && (last ? f.stretches[f.stretches.length - 1] : f.stretches[0]);
    const w = s && level.walls[s.wallId];
    if (!w || isBoundary(w)) return;
    const t = w.thickness;
    ends.push({
      u0: u < 0.5 ? -t : L,
      u1: u < 0.5 ? 0 : L + t,
      status: statusIn(statusOf, level, w.id),
    });
  };
  if (at >= 0 && sameLoop.length > 1) {
    endOf(sameLoop[(at - 1 + sameLoop.length) % sameLoop.length], true, 0);
    endOf(sameLoop[(at + 1) % sameLoop.length], false, 1);
  }
  const fins: Elevation['fins'] = [];
  const inRoom = new Set(faces.flatMap((f) => f.stretches.map((s) => s.wallId)));
  const corners = new Set(
    face.stretches.flatMap((s) => {
      const w = level.walls[s.wallId];
      return w ? [w.a, w.b] : [];
    }),
  );
  for (const w of Object.values(level.walls)) {
    if (inRoom.has(w.id) || isBoundary(w)) continue;
    const [on, off] = corners.has(w.a) ? [w.a, w.b] : corners.has(w.b) ? [w.b, w.a] : [null, null];
    const p = on && level.vertices[on];
    const q = off && level.vertices[off];
    if (!p || !q) continue;
    const pu = faceUV(face, p);
    const qu = faceUV(face, q);
    if (qu.v <= 0.05 || pu.u <= 0 || pu.u >= L) continue;
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const sin = len > 0 ? Math.abs(qu.v - pu.v) / len : 1;
    const half = w.thickness / 2 / Math.max(sin, 0.2);
    fins.push({
      wallId: w.id,
      u0: clamp(pu.u - half, 0, L),
      u1: clamp(pu.u + half, 0, L),
      top: Math.min(w.height ?? ceiling, ceiling),
      status: statusIn(statusOf, level, w.id),
    });
  }

  // Pieces in front of the face.
  const items: ElevItem[] =
    opts.furniture === 'none'
      ? []
      : roomItems(level, face.roomId)
          .map((it) => projectItem(face, it))
          .filter(
            (e): e is ElevItem =>
              !!e && e.near <= DEPTH + 1e-9 && overlap(e.outline.u0, e.outline.u1, 0, L) > 1e-3,
          )
          .sort((a, b) => a.near - b.near || a.id.localeCompare(b.id));

  // Points on this face (this side of its walls), numbered left to right.
  const points: ElevPoint[] = [];
  for (const p of Object.values(level.points ?? {})) {
    const pw = p.wall;
    if (!pw) continue;
    const s = face.stretches.find((x) => x.wallId === pw.wallId && x.side === pw.side);
    if (!s) continue;
    const pos = pointPosition(level, p);
    if (!pos) continue;
    const plate = ELEC_KINDS[p.kind].plate;
    const u = faceUV(face, pos.at).u;
    const z = p.kind === 'aircon' ? pw.height - plate.h / 2 : pw.height;
    const w = level.walls[pw.wallId];
    points.push({
      id: p.id,
      n: 0,
      kind: p.kind,
      u,
      z,
      w: plate.w,
      h: plate.h,
      tagHeight: pw.height,
      fromLeft: mm10(u),
      warnings: pointWarnings(level, p, statusOf),
      onGlass: !!w && isGlass(w),
    });
  }
  points.sort((a, b) => a.u - b.u || a.z - b.z || a.id.localeCompare(b.id));
  points.forEach((p, i) => {
    p.n = i + 1;
  });

  // Aircon trunking legs along this face.
  const trunking: ElevTrunk[] = [];
  for (const p of Object.values(level.points ?? {})) {
    if (p.kind !== 'aircon') continue;
    const path = trunkingPath(level, p);
    for (let i = 1; i < path.length; i++) {
      const a = faceUV(face, path[i - 1] as Vec2);
      const b = faceUV(face, path[i] as Vec2);
      if (Math.abs(a.v - b.v) > 0.02) continue;
      if (Math.min(a.v, b.v) < -0.01 || Math.max(a.v, b.v) > TRUNK_NEAR) continue;
      const u0 = clamp(Math.min(a.u, b.u), 0, L);
      const u1 = clamp(Math.max(a.u, b.u), 0, L);
      if (u1 - u0 > 0.01) trunking.push({ pointId: p.id, u0, u1, length: u1 - u0 });
    }
  }

  // Dimensions along the bottom.
  const middle = [0, L, ...openings.flatMap((o) => [o.u0, o.u1])].map((v) => ({
    v,
    from: Number.NaN,
  }));
  const fine = items
    .filter((it) => it.against)
    .flatMap((it) => [it.outline.u0, it.outline.u1])
    .filter((v) => v > 0 && v < L)
    .map((v) => ({ v, from: Number.NaN }));
  const chains = tieredChains(middle, fine).map((c) => ({
    tier: c.tier,
    stops: c.stops.map((s) => s.v),
  }));

  // Heights beside what they measure.
  const heights: ElevHeight[] = [{ u: 0, side: 'left', marks: [ceiling], what: 'ceiling' }];
  const addHeight = (h: ElevHeight) => {
    const marks = [...h.marks]
      .filter((z) => z > 0.005)
      .sort((a, b) => a - b)
      .filter((z, i, all) => i === 0 || z - (all[i - 1] as number) >= 0.01);
    if (!marks.length) return;
    const same = heights.find(
      (x) =>
        x.what === h.what &&
        x.marks.length === marks.length &&
        x.marks.every((z, i) => Math.abs(z - (marks[i] as number)) < 0.01),
    );
    if (!same) heights.push({ ...h, marks });
  };
  for (const o of openings) {
    if (o.kind === 'window')
      addHeight({ u: o.u1, side: 'right', marks: [o.sill, o.head], what: 'window' });
    else addHeight({ u: o.u1, side: 'right', marks: [o.head], what: 'door' });
  }
  for (const w of walls) {
    if (w.build === 'half') addHeight({ u: w.u1, side: 'right', marks: [w.top], what: 'half' });
  }
  for (const it of items) {
    if (!it.against) continue;
    if (it.carpentry === 'base')
      addHeight({ u: it.outline.u0, side: 'left', marks: [it.outline.z1], what: 'counter' });
    else if (it.carpentry === 'wall')
      addHeight({
        u: it.outline.u1,
        side: 'right',
        marks: [it.outline.z0, it.outline.z1],
        what: 'cabinet',
      });
    else if (it.hung)
      addHeight({ u: it.outline.u1, side: 'right', marks: [it.outline.z0], what: 'hung' });
  }

  // Notes.
  const notes: Omit<ElevNote, 'n'>[] = [];
  const against = items.filter((it) => it.against);
  for (const p of points) {
    const plate: Rect = {
      u0: p.u - p.w / 2,
      u1: p.u + p.w / 2,
      z0: p.z - p.h / 2,
      z1: p.z + p.h / 2,
    };
    const by = against.find((it) => hides(it) && rectsMeet(plate, it.outline));
    if (by) {
      notes.push({
        kind: 'hidden',
        ids: [p.id, by.id],
        text: `${pointWord(p.kind)} ${p.n} is behind the ${midSentence(by.name)}: you won’t reach it. Move it, or ask the carpenter for a cut-out.`,
        at: plate,
      });
    }
  }
  for (const o of openings) {
    if (o.kind !== 'window') continue;
    for (const it of against) {
      if (!covers(it)) continue;
      const along = overlap(it.outline.u0, it.outline.u1, o.u0, o.u1);
      if (along <= 0.05 + 1e-9 || it.outline.z1 <= o.sill + 0.05 + 1e-9 || it.outline.z0 >= o.head)
        continue;
      notes.push({
        kind: 'covers',
        ids: [it.id, o.id],
        text: `The ${midSentence(it.name)} covers ${mm10(along).toFixed(2)} m of Window ${o.n}.`,
        at: {
          u0: Math.max(it.outline.u0, o.u0),
          u1: Math.min(it.outline.u1, o.u1),
          z0: Math.max(o.sill, it.outline.z0),
          z1: Math.min(o.head, it.outline.z1),
        },
      });
    }
  }
  const bases = against.filter((it) => it.carpentry === 'base' && !it.hung);
  for (const cab of against.filter((it) => it.carpentry === 'wall')) {
    let worst: { base: ElevItem; gap: number; hob: boolean } | null = null;
    for (const b of bases) {
      if (overlap(cab.outline.u0, cab.outline.u1, b.outline.u0, b.outline.u1) <= 0.05) continue;
      const gap = cab.outline.z0 - b.outline.z1;
      if (gap < 0) continue;
      const hob = b.assetId === 'kitchen-hob';
      const short = gap < (hob ? GAP_HOB : GAP_USUAL) - 1e-6;
      if (short && (!worst || gap < worst.gap || (hob && !worst.hob)))
        worst = { base: b, gap, hob };
    }
    if (worst) {
      notes.push({
        kind: 'lowCabinet',
        ids: [cab.id, worst.base.id],
        text: `${mm10(worst.gap).toFixed(2)} m between the counter and the wall cabinets: ${GAP_USUAL.toFixed(2)} m or more is usual, and at least ${GAP_HOB.toFixed(2)} m over the hob for the hood.`,
        at: {
          u0: Math.max(cab.outline.u0, worst.base.outline.u0),
          u1: Math.min(cab.outline.u1, worst.base.outline.u1),
          z0: worst.base.outline.z1,
          z1: cab.outline.z0,
        },
      });
    }
  }
  for (const it of against) {
    if (!it.hung) continue;
    const onShelter = walls.some(
      (w) => w.status === 'shelter' && overlap(w.u0, w.u1, it.outline.u0, it.outline.u1) > 1e-3,
    );
    if (onShelter) {
      const name = midSentence(it.name);
      notes.push({
        kind: 'shelterFixing',
        ids: [it.id],
        text: `The ${name} is fixed to the household shelter wall: HDB doesn’t allow drilling it.`,
        at: it.outline,
      });
    }
  }
  for (const it of items) {
    const over = it.outline.z1 - ceiling;
    if (over > 0.01 + 1e-9) {
      notes.push({
        kind: 'tooTall',
        ids: [it.id],
        text: `The ${midSentence(it.name)} is ${mm10(over).toFixed(2)} m taller than this room’s ceiling.`,
        at: { ...it.outline, z0: ceiling },
      });
    }
  }
  notes.sort((a, b) => a.at.u0 - b.at.u0 || a.at.z0 - b.at.z0);

  // The finish on most of the face.
  const byFinish = new Map<string, number>();
  for (const w of walls) {
    if (w.material && (w.build === 'solid' || w.build === 'half'))
      byFinish.set(w.material, (byFinish.get(w.material) ?? 0) + w.u1 - w.u0);
  }
  const main = [...byFinish.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  return {
    face,
    width: L,
    ceiling,
    walls,
    ends,
    fins,
    openings,
    items,
    points,
    trunking,
    chains,
    heights,
    notes: notes.map((n, i) => ({ ...n, n: i + 1 })),
    finishName: main ? finishName(main) : null,
    empty: openings.length === 0 && items.length === 0 && points.length === 0,
  };
}

// ------------------------------------------------------------------------------- labels

export interface ElevationLabels {
  fontPx: number;
  /** Per chain (as `elev.chains`): shown at all, and which pieces' figures fit. */
  chains: { tier: Tier; show: boolean; figures: boolean[] }[];
  /** Point tags: "1 · h1150", just "1", or none, so they never overlap. */
  tags: 'full' | 'short' | 'none';
  /** Per height column (as `elev.heights`): which marks' figures are shown. */
  heights: boolean[][];
}

/** A label's width at `fontPx` (figures about 0.6 em, a little padding). */
export const labelWidth = (text: string, fontPx: number) => text.length * 0.6 * fontPx + 4;

/** A point's tag, as the drawing and the list show it. */
export const tagText = (p: Pick<ElevPoint, 'n' | 'tagHeight'>, full = true) =>
  full ? `${p.n} · h${Math.round(p.tagHeight * 1000)}` : `${p.n}`;

/** A chain's pieces in mm, rounded to 10 mm so they add up. */
export function chainFigures(stops: readonly number[]): number[] {
  const first = stops[0];
  if (first === undefined) return [];
  const units = stops.map((s) => Math.round((s - first) * 100));
  return units.slice(1).map((u, i) => (u - (units[i] as number)) * 10);
}

/**
 * Which labels to draw at a scale (`pxPerM` screen pixels a metre), so figures stay `fontPx`
 * (11) or larger and never overlap: tier 0 only when all its figures fit, tiers 1 and 2 always
 * with the figures that fit; point tags full, short or none; each height column's figures that
 * clear the one below.
 */
export function elevationLabels(elev: Elevation, pxPerM: number, fontPx = 11): ElevationLabels {
  const chains = elev.chains.map((c) => {
    const figs = chainFigures(c.stops);
    const fits = figs.map(
      (mm, i) =>
        ((c.stops[i + 1] as number) - (c.stops[i] as number)) * pxPerM >=
        labelWidth(String(mm), fontPx),
    );
    return { tier: c.tier, show: c.tier !== 0 || fits.every(Boolean), figures: fits };
  });
  const clear = (full: boolean) => {
    const boxes = elev.points.map((p) => {
      const w = labelWidth(tagText(p, full), fontPx) / pxPerM;
      const h = (fontPx + 4) / pxPerM;
      const z = p.z + p.h / 2;
      return { u0: p.u - w / 2, u1: p.u + w / 2, z0: z, z1: z + h };
    });
    return boxes.every((a, i) => boxes.every((b, j) => j <= i || !rectsMeet(a, b)));
  };
  const tags = clear(true) ? 'full' : clear(false) ? 'short' : 'none';
  const heights = elev.heights.map((h) => {
    let last = Number.NEGATIVE_INFINITY;
    return h.marks.map((z) => {
      const ok = (z - last) * pxPerM >= fontPx + 2;
      if (ok) last = z;
      return ok;
    });
  });
  return { fontPx, chains, tags, heights };
}

// ------------------------------------------------------------------------------ changes

export interface ElevationChanges {
  /** After's openings, points and pieces that are new (or a piece resized, a point moved). */
  added: Set<string>;
  /** Moved points, with where they were on this face (if they were on it). */
  moved: { id: string; from: { u: number; z: number } | null }[];
  /** Before's openings, points and pieces gone in After, where they were on this face. */
  removed: { kind: 'opening' | 'point' | 'item'; id: string; at: Rect }[];
  /** Stretches of the face hacked, and of new wall, as [u0, u1]. */
  hacked: [number, number][];
  built: [number, number][];
}

const diffCache = new WeakMap<object, WeakMap<object, ReturnType<typeof diffOf>>>();

function diffOf(before: Level, after: Level) {
  return { walls: renovationDiff(before, after), elec: electricalChanges(before, after) };
}

function cachedDiff(before: Level, after: Level) {
  const frozen = Object.isFrozen(before) && Object.isFrozen(after);
  if (!frozen) return diffOf(before, after);
  let m = diffCache.get(before);
  if (!m) {
    m = new WeakMap();
    diffCache.set(before, m);
  }
  const hit = m.get(after);
  if (hit) return hit;
  const d = diffOf(before, after);
  m.set(after, d);
  return d;
}

/**
 * What a renovation changes on a face of `after`: new and resized pieces, new and moved
 * points and new openings (teal); closed openings, removed points and pieces (red dashed,
 * where they were); hacked stretches of the face's line and new wall on it.
 */
export function elevationChanges(before: Level, after: Level, face: RoomFace): ElevationChanges {
  const { walls, elec } = cachedDiff(before, after);
  const L = face.length;
  const added = new Set<string>([...walls.openingsAdded, ...elec.status.keys()]);
  for (const it of Object.values(after.items)) {
    const was = before.items[it.id];
    const resized =
      was &&
      (was.assetId !== it.assetId ||
        Math.abs(was.scale.x - it.scale.x) > 1e-6 ||
        Math.abs(was.scale.y - it.scale.y) > 1e-6 ||
        Math.abs(was.scale.z - it.scale.z) > 1e-6);
    if (!was || resized) added.add(it.id);
  }
  /** On this face's line: its u, or null. */
  const onLine = (p: Vec2, behind: number) => {
    const { u, v } = faceUV(face, p);
    return v >= -behind - 0.02 && v <= 0.02 ? u : null;
  };
  const stretchesOf = (xs: typeof walls.demolished, lvl: Level): [number, number][] =>
    xs.flatMap((s): [number, number][] => {
      const w = lvl.walls[s.wallId];
      const behind = w ? w.thickness : 0.3;
      const a = onLine(s.from, behind);
      const b = onLine(s.to, behind);
      if (a === null || b === null) return [];
      const u0 = clamp(Math.min(a, b), 0, L);
      const u1 = clamp(Math.max(a, b), 0, L);
      return u1 - u0 > 0.01 ? [[u0, u1]] : [];
    });
  const removed: ElevationChanges['removed'] = [];
  const bGeom = faceGeometry(before);
  for (const id of walls.openingsRemoved) {
    const o = before.openings[id];
    const f = o && bGeom.frames[o.wallId];
    if (!o || !f) continue;
    const [a, b] = openingSpan(f, o);
    for (const k of [1, -1]) {
      const p = faceUV(face, framePoint(f, a, k));
      const q = faceUV(face, framePoint(f, b, k));
      if (Math.abs(p.v) > 0.02 || Math.abs(q.v) > 0.02) continue;
      const u0 = clamp(Math.min(p.u, q.u), 0, L);
      const u1 = clamp(Math.max(p.u, q.u), 0, L);
      if (u1 - u0 < 0.01) continue;
      const sill = o.kind === 'window' ? o.sill : 0;
      removed.push({
        kind: 'opening',
        id,
        at: { u0, u1, z0: sill, z1: Math.min(face.ceiling, sill + o.height) },
      });
    }
  }
  for (const p of elec.removed) {
    const pos = pointPosition(before, p);
    if (!pos?.normal || !p.wall) continue;
    if (pos.normal.x * face.normal.x + pos.normal.y * face.normal.y < 0.9) continue;
    const u = onLine(pos.at, 0);
    if (u === null || u < 0 || u > L) continue;
    const plate = ELEC_KINDS[p.kind].plate;
    const z = p.kind === 'aircon' ? p.wall.height - plate.h / 2 : p.wall.height;
    removed.push({
      kind: 'point',
      id: p.id,
      at: { u0: u - plate.w / 2, u1: u + plate.w / 2, z0: z - plate.h / 2, z1: z + plate.h / 2 },
    });
  }
  for (const it of Object.values(before.items)) {
    if (after.items[it.id]) continue;
    const e = projectItem(face, it);
    if (!e || e.near > DEPTH || e.near < -0.05 || overlap(e.outline.u0, e.outline.u1, 0, L) <= 1e-3)
      continue;
    removed.push({ kind: 'item', id: it.id, at: e.outline });
  }
  const moved: ElevationChanges['moved'] = [];
  for (const [id, was] of elec.from) {
    const pos = pointPosition(before, was);
    const u = pos?.normal && was.wall ? onLine(pos.at, 0) : null;
    moved.push({ id, from: u === null || !was.wall ? null : { u, z: was.wall.height } });
  }
  return {
    added,
    moved,
    removed,
    hacked: stretchesOf(walls.demolished, before),
    built: stretchesOf(walls.built, after),
  };
}
