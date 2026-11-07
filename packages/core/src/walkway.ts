import {
  CLEARANCE_RULES,
  type ClearanceIssue,
  type WalkwayTo,
  bedSides,
  blocks,
} from './clearance';
import { box, near as nearBoxes, nearestOnPolygon } from './convex';
import { entranceDoor } from './delivery';
import { itemFootprint } from './furniture';
import { pointInPolygon } from './geometry';
import {
  Buffers,
  type Grid,
  Search,
  cellAt,
  cellCentre,
  distanceField,
  fillPolygon,
  widestWays,
} from './grid';
import { type WallFrame, planGeometry } from './plan';
import { roomArea, roomShapes } from './rooms';
import type { Item, Level, Vec2 } from './schema';

/**
 * Walkways: room to walk from the main door to every room (0.90 m), and from a bedroom's door
 * to each usable side of its bed (0.60 m), with the furniture as it stands. The widest way is
 * found on a 50 mm raster (distance to the nearest obstacle, then a maximin search); where it
 * comes near the need, its narrowest point is measured exactly on the polygons. A route is
 * never asked to be wider than the flat itself is there, and doorways don't count against
 * it. Advice only. Spec: docs/specs/clearance-checks.md, slice 2 (W).
 */
export const WALKWAY_NEED = 0.9;
export const BED_WAY_NEED = 0.6;
/** Rooms smaller than this (an aircon ledge) aren't walked to. */
const MIN_ROOM_AREA = 1.0;
/** How far a doorway's throat reaches into the room on each side. */
const THROAT_DEPTH = 0.45;
const CELL = 0.05;
const MAX_CELLS = 300_000;
/** Widths above this are all just wide; the search buckets widths by STEP. */
const WIDE = 1.5;
const STEP = 0.01;
/** A raster width this close to the need is measured exactly. */
const SLACK = 0.1;
/** The route is never stricter than the flat: its bare width less this. */
const CAP_MARGIN = 0.02;
/** How far to look for the obstacles either side of a narrow point. */
const REFINE_R = 1.6;
/** A raster cell's owner when it is outside the rooms. */
export const OUTSIDE = -2;

export interface WalkwayRoute {
  route: 'circulation' | 'bed';
  to: WalkwayTo;
  need: number;
  /** The need is the flat's own width there. */
  capped: boolean;
  /** The narrowest clear width on the widest way (0: closed). */
  have: number;
  ok: boolean;
  /** Across the narrowest point; null when the way is wide. */
  pinch: [Vec2, Vec2] | null;
  path: Vec2[];
  /** The pieces that make it narrow. */
  blamed: string[];
}

export interface WalkwayReport {
  status: 'ok' | 'no-main-door' | 'issues';
  /** The main door the routes start from. */
  start: string | null;
  /** Every room and bed side checked. */
  routes: WalkwayRoute[];
  issues: Extract<ClearanceIssue, { kind: 'walkway' }>[];
  /** The raster used (cell size, metres, and cell count). */
  grid: { cell: number; cells: number };
}

export interface Throat {
  openingId: string;
  f: WallFrame;
  u0: number;
  u1: number;
  /** Half its depth across the wall, from the centre line. */
  s: number;
  poly: Vec2[];
  cells: number[];
  /** The rooms either side (-1: outside). */
  rooms: number[];
}

/** Everything that doesn't change while furniture moves. */
export interface Bare {
  g: Grid;
  room: Int16Array;
  rooms: { id: string; area: number }[];
  solid: Uint8Array;
  owner: Int32Array;
  polys: Vec2[][];
  throatOf: Int16Array;
  throats: Throat[];
  width: Float32Array;
  start: string | null;
  startCells: number[];
  startRoom: number;
  adj: Set<number>[];
  search: Search;
  first: Int32Array;
  caps: Map<string, number>;
  /** The bare plan's widest ways inside a bedroom from its doors (by room and seed doors). */
  roomSearches: Map<string, Search>;
}

const bareCache = new WeakMap<
  object,
  { vertices: object; openings: object; rooms: object; bare: Bare }
>();

const buffers = new Buffers();
/** The bare plan's own: a bare raster made between passes never overwrites a pass's `near`. */
const bareBuffers = new Buffers();
const mainSearch = new Search(0);
const auxSearch = new Search(0);
let solidBuf = new Uint8Array(0);
let ownerBuf = new Int32Array(0);
let widthBuf = new Float32Array(0);

/** The level's walls, doors and rooms, rastered once (kept while only furniture changes). */
function bareOf(level: Level): Bare {
  const hit = bareCache.get(level.walls);
  if (
    hit &&
    hit.vertices === level.vertices &&
    hit.openings === level.openings &&
    hit.rooms === level.rooms
  ) {
    return hit.bare;
  }
  const geom = planGeometry(level);
  const shapes = roomShapes(level);
  const rooms = Object.values(level.rooms)
    .filter((r) => shapes.has(r.id))
    .map((r) => ({ id: r.id, area: roomArea(level, r) }));
  // The rooms' extent, a few cells over.
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const r of rooms) {
    const b = box((shapes.get(r.id) as { outer: Vec2[] }).outer);
    x0 = Math.min(x0, b.x0);
    y0 = Math.min(y0, b.y0);
    x1 = Math.max(x1, b.x1);
    y1 = Math.max(y1, b.y1);
  }
  if (!rooms.length) {
    x0 = 0;
    y0 = 0;
    x1 = 1;
    y1 = 1;
  }
  // Coarser for a huge (perhaps mis-scaled) plan, so it never allocates millions of cells.
  const area = (x1 - x0 + 0.4) * (y1 - y0 + 0.4);
  const c = Math.max(CELL, Math.sqrt(area / MAX_CELLS) * 1.05);
  const pad = 2 * c;
  const nx = Math.ceil((x1 - x0 + 2 * pad) / c);
  const ny = Math.ceil((y1 - y0 + 2 * pad) / c);
  const g: Grid = { c, nx, ny, x0: x0 - pad, y0: y0 - pad, n: nx * ny };

  const room = new Int16Array(g.n).fill(-1);
  rooms.forEach((r, idx) => {
    const s = shapes.get(r.id);
    if (!s) return;
    const b = box(s.outer);
    const i0 = Math.max(0, Math.floor((b.x0 - g.x0) / c));
    const i1 = Math.min(nx - 1, Math.floor((b.x1 - g.x0) / c));
    const j0 = Math.max(0, Math.floor((b.y0 - g.y0) / c));
    const j1 = Math.min(ny - 1, Math.floor((b.y1 - g.y0) / c));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * nx + i;
        if (room[k] !== -1) continue;
        const p = cellCentre(g, k);
        if (pointInPolygon(p, s.outer) && !s.holes.some((h) => pointInPolygon(p, h))) {
          room[k] = idx;
        }
      }
    }
  });

  // Obstacles: solid walls and their hubs (half and glass walls too), windows, columns
  // (room holes), and everything outside the rooms. Not doorways, passages or boundaries.
  const polys: Vec2[][] = [
    ...geom.pieces.map((p) => p.polygon),
    ...geom.footprints.hubs.map((h) => h.polygon),
    ...geom.openings.filter((o) => o.kind === 'window').map((o) => o.polygon),
    ...[...shapes.values()].flatMap((s) => s.holes),
  ];
  const solid = new Uint8Array(g.n);
  const owner = new Int32Array(g.n).fill(-1);
  for (let k = 0; k < g.n; k++) {
    if (room[k] === -1) {
      solid[k] = 1;
      owner[k] = OUTSIDE;
    }
  }
  polys.forEach((poly, idx) =>
    fillPolygon(g, poly, (k) => {
      solid[k] = 1;
      owner[k] = idx;
    }),
  );

  // Doorways and passages: their throats, the wall's thickness and a step into each room.
  const throatOf = new Int16Array(g.n).fill(-1);
  const throats: Throat[] = [];
  for (const o of geom.openings) {
    if (o.kind === 'window') continue;
    const f = o.frame;
    const [u0, u1] = o.span;
    const s = f.half + THROAT_DEPTH;
    const at = (u: number, v: number) => ({
      x: f.a.x + f.d.x * u + f.n.x * v,
      y: f.a.y + f.d.y * u + f.n.y * v,
    });
    const poly = [at(u0, -s), at(u1, -s), at(u1, s), at(u0, s)];
    const t: Throat = { openingId: o.opening.id, f, u0, u1, s, poly, cells: [], rooms: [] };
    const idx = throats.length;
    fillPolygon(g, poly, (k) => {
      if (solid[k] || throatOf[k] !== -1) return;
      // Cells whose centre is in it (the edges' cells would widen it).
      const p = cellCentre(g, k);
      const u = (p.x - f.a.x) * f.d.x + (p.y - f.a.y) * f.d.y;
      const v = (p.x - f.a.x) * f.n.x + (p.y - f.a.y) * f.n.y;
      if (u < u0 || u > u1 || Math.abs(v) > s) return;
      throatOf[k] = idx;
      t.cells.push(k);
    });
    const um = (u0 + u1) / 2;
    for (const side of [1, -1]) {
      const k = cellAt(g, at(um, side * (f.half + 0.1)));
      t.rooms.push(k >= 0 ? (room[k] as number) : -1);
    }
    throats.push(t);
  }

  const width = new Float32Array(g.n);
  bareBuffers.fit(g);
  distanceField(g, solid, bareBuffers);
  for (let k = 0; k < g.n; k++) {
    width[k] = solid[k]
      ? -1
      : throatOf[k] !== -1
        ? WIDE
        : Math.min(WIDE, 2 * Math.sqrt(bareBuffers.d2[k] as number) * c);
  }

  // Rooms joined (a door, a passage, a boundary): neighbouring open cells of two rooms.
  const adj = rooms.map(() => new Set<number>());
  for (let k = 0; k < g.n; k++) {
    if (solid[k]) continue;
    const r = room[k] as number;
    for (const m of [k + 1, k + nx]) {
      if (m >= g.n || solid[m]) continue;
      const q = room[m] as number;
      if (q !== r && q >= 0 && r >= 0) {
        adj[r]?.add(q);
        adj[q]?.add(r);
      }
    }
  }

  // The main door: its throat's cells inside the flat.
  const start = entranceDoor(level, geom);
  const startThroat = throats.find((t) => t.openingId === start);
  const startCells = startThroat ? startThroat.cells.filter((k) => !solid[k]) : [];
  const counts = new Map<number, number>();
  for (const k of startCells)
    counts.set(room[k] as number, (counts.get(room[k] as number) ?? 0) + 1);
  const startRoom = [...counts].sort((p, q) => q[1] - p[1])[0]?.[0] ?? -1;

  const search = new Search(g.n);
  const first = new Int32Array(rooms.length).fill(-1);
  if (startCells.length) {
    widestWays(g, width, startCells, null, search, {
      wide: WIDE,
      step: STEP,
      room,
      first,
      notIn: throatOf,
    });
  }
  const bare: Bare = {
    g,
    room,
    rooms,
    solid,
    owner,
    polys,
    throatOf,
    throats,
    width,
    start,
    startCells,
    startRoom,
    adj,
    search,
    first,
    caps: new Map(),
    roomSearches: new Map(),
  };
  if (Object.isFrozen(level.walls)) {
    bareCache.set(level.walls, {
      vertices: level.vertices,
      openings: level.openings,
      rooms: level.rooms,
      bare,
    });
  }
  return bare;
}

/**
 * A doorway's throat with furniture about: each of its open cells as wide as twice its
 * distance to the nearest piece (walls don't count there: the doorway's own width is the
 * door's business), wide when no piece is near.
 */
function throatWidths(t: Throat, fps: Vec2[][], g: Grid, width: Float32Array) {
  const reach = WIDE / 2;
  const close = fps.filter((fp) => nearBoxes(fp, t.poly, reach));
  for (const k of t.cells) {
    if ((width[k] as number) < 0) continue;
    if (!close.length) {
      width[k] = WIDE;
      continue;
    }
    const p = cellCentre(g, k);
    let d = reach;
    for (const fp of close) d = Math.min(d, nearestOnPolygon(p, fp).d);
    width[k] = Math.min(WIDE, 2 * d);
  }
}

/** The obstacles a narrow point is measured against: the bare polygons, then the pieces. */
export interface Obstacles {
  polys: Vec2[][];
  nBare: number;
  ids: string[];
}

/** The raster the polygons were drawn on, to find "outside the rooms", which has none. */
export interface Raster {
  g: Grid;
  solid: Uint8Array;
  owner: Int32Array;
}

/**
 * How far from p along u the rooms end (the first cell outside them), within REFINE_R; null
 * if a wall or piece comes first, or nothing does.
 */
function toOutside(p: Vec2, u: Vec2, r: Raster): number | null {
  const step = r.g.c / 2;
  for (let t = step; t <= REFINE_R; t += step) {
    const k = cellAt(r.g, { x: p.x + u.x * t, y: p.y + u.y * t });
    if (k < 0) return null;
    if (r.solid[k]) return r.owner[k] === OUTSIDE ? Math.max(0, t - step / 2) : null;
  }
  return null;
}

/**
 * Across a narrow point: the nearest obstacle, then the nearest on the other side (a polygon,
 * or where the rooms end on the raster).
 */
function across(
  p: Vec2,
  obs: Obstacles,
  raster: Raster,
): { have: number; a: Vec2; b: Vec2; by: number[] } | null {
  let A = -1;
  let a: Vec2 = p;
  let dA = Number.POSITIVE_INFINITY;
  const found: { i: number; at: Vec2; d: number }[] = [];
  obs.polys.forEach((poly, i) => {
    const bx = box(poly);
    if (
      p.x < bx.x0 - REFINE_R ||
      p.x > bx.x1 + REFINE_R ||
      p.y < bx.y0 - REFINE_R ||
      p.y > bx.y1 + REFINE_R
    ) {
      return;
    }
    const n = nearestOnPolygon(p, poly);
    found.push({ i, at: n.at, d: n.d });
    if (n.d < dA) {
      dA = n.d;
      A = i;
      a = n.at;
    }
  });
  if (A < 0 || dA < 1e-6) return null;
  const ux = (p.x - a.x) / dA;
  const uy = (p.y - a.y) / dA;
  let best: { i: number; at: Vec2; d: number } | null = null;
  for (const q of found) {
    if (q.i === A) continue;
    if ((q.at.x - p.x) * ux + (q.at.y - p.y) * uy <= 1e-6) continue;
    if (!best || q.d < best.d) best = q;
  }
  // Beyond the rooms' edge (a boundary with nothing drawn past it) before any polygon.
  const out = toOutside(p, { x: ux, y: uy }, raster);
  if (out !== null && (!best || out < best.d)) {
    return { have: dA + out, a, b: { x: p.x + ux * out, y: p.y + uy * out }, by: [A] };
  }
  if (!best) return null;
  const have = dA + best.d;
  return { have, ...barOf(a, best.at, have), by: [A, best.i] };
}

/**
 * The bar drawn across a pinch: from one obstacle towards the other, as long as the width
 * reported (the two distances from the narrow point; the obstacles' nearest points can lie a
 * little closer when they aren't straight across from each other).
 */
function barOf(a: Vec2, b: Vec2, have: number): { a: Vec2; b: Vec2 } {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-9 || len >= have - 1e-6) return { a, b };
  const ext = (have - len) / 2;
  const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  return {
    a: { x: a.x - u.x * ext, y: a.y - u.y * ext },
    b: { x: b.x + u.x * ext, y: b.y + u.y * ext },
  };
}

export interface Measure {
  have: number;
  /** The need there: a doorway's pinch never needs more than the doorway is wide. */
  need: number;
  /** Measured exactly (else the raster's width). */
  exact: boolean;
  pinch: [Vec2, Vec2] | null;
  /** Obstacle indices at the pinch (polygons), or pieces (by index) for a doorway's. */
  by: number[];
  inThroat: boolean;
  /** Where on the path it is. */
  at: number;
}

/** The narrowest point of a way, measured exactly where the raster says it's near `need`. */
function measure(
  path: number[],
  raster: Raster,
  width: Float32Array,
  throatOf: Int16Array,
  throats: Throat[],
  need: number,
  obs: Obstacles,
): Measure {
  const { g } = raster;
  let out: Measure = {
    have: Number.POSITIVE_INFINITY,
    need,
    exact: false,
    pinch: null,
    by: [],
    inThroat: false,
    at: -1,
  };
  for (let k = 0; k < path.length; k++) {
    const w = width[path[k] as number] as number;
    if (w < out.have) out = { ...out, have: w, at: k };
  }
  let exact: Measure | null = null;
  // The worst point: the most short of what it needs.
  const consider = (m: Measure) => {
    if (!exact || m.have - m.need < exact.have - exact.need) exact = m;
  };
  // Each stretch of the way narrower than need + slack.
  let stretches = 0;
  for (let k = 0; k < path.length; ) {
    if ((width[path[k] as number] as number) >= need + SLACK) {
      k++;
      continue;
    }
    let e = k;
    let lo = k;
    while (e < path.length && (width[path[e] as number] as number) < need + SLACK) {
      if ((width[path[e] as number] as number) < (width[path[lo] as number] as number)) lo = e;
      e++;
    }
    stretches++;
    const tried = new Set<number>();
    const points = [lo - 2, lo - 1, lo, lo + 1, lo + 2];
    for (let q = k; q < e; q += 6) points.push(q);
    for (const q of points.slice(0, 24)) {
      if (q < k || q >= e || tried.has(q)) continue;
      tried.add(q);
      const cell = path[q] as number;
      const t = throatOf[cell] as number;
      const th = t >= 0 ? throats[t] : undefined;
      const r = across(cellCentre(g, cell), obs, raster);
      if (r)
        consider({
          have: r.have,
          need: th ? Math.min(need, th.u1 - th.u0 - CAP_MARGIN) : need,
          exact: true,
          pinch: [r.a, r.b],
          by: r.by,
          inThroat: !!th,
          at: q,
        });
    }
    k = e;
  }
  // Narrow on the raster but nothing measurable across (no obstacle drawn on the far side
  // within reach): wide enough.
  if (!exact && stretches) return { ...out, have: need + SLACK };
  return exact ?? out;
}

/** A way's cells as plan points, simplified to at most 60. */
function polyline(g: Grid, cells: number[]): Vec2[] {
  const pts = cells.map((k) => cellCentre(g, k));
  const keep = new Uint8Array(pts.length);
  const dp = (i: number, j: number) => {
    if (j <= i + 1) return;
    const a = pts[i] as Vec2;
    const b = pts[j] as Vec2;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let far = -1;
    let fd = 0.06;
    for (let k = i + 1; k < j; k++) {
      const p = pts[k] as Vec2;
      const d = Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len;
      if (d > fd) {
        fd = d;
        far = k;
      }
    }
    if (far < 0) return;
    keep[far] = 1;
    dp(i, far);
    dp(far, j);
  };
  if (pts.length) {
    keep[0] = 1;
    keep[pts.length - 1] = 1;
    dp(0, pts.length - 1);
  }
  let out = pts.filter((_, k) => keep[k]);
  if (out.length > 60) {
    const step = (out.length - 1) / 59;
    out = Array.from({ length: 60 }, (_, k) => out[Math.round(k * step)] as Vec2);
  }
  return out;
}

/**
 * The furniture rastered over the bare plan, its widths and the widest ways from the main
 * door: shared by walkways and the ageing check. Its arrays are module buffers reused by the
 * next pass, so it is kept for one level at a time: call this again (it is free for the same
 * level) rather than holding on to one across levels.
 */
export interface FurnishedPass {
  level: Level;
  bare: Bare;
  pieces: Item[];
  fps: Vec2[][];
  solid: Uint8Array;
  owner: Int32Array;
  width: Float32Array;
  /** Each cell's nearest solid cell. */
  near: Int32Array;
  /** The first cell reached of each room, on the furnished widest ways (-1: not reached). */
  first: Int32Array;
  search: Search;
  raster: Raster;
  bareRaster: Raster;
  obs: Obstacles;
  bareObs: Obstacles;
  nBare: number;
}

let pass: FurnishedPass | null = null;

/** The furnished pass for a level (recomputed whenever the level isn't the last one). */
export function furnishedPass(level: Level): FurnishedPass {
  if (pass && pass.level === level && Object.isFrozen(level)) return pass;
  const bare = bareOf(level);
  const { g, room, rooms, throats, throatOf } = bare;
  const pieces = Object.values(level.items).filter(blocks);
  const fps = pieces.map((it) => itemFootprint(it));
  if (solidBuf.length < g.n) {
    solidBuf = new Uint8Array(g.n);
    ownerBuf = new Int32Array(g.n);
    widthBuf = new Float32Array(g.n);
  }
  const solid = solidBuf;
  const owner = ownerBuf;
  solid.set(bare.solid);
  owner.set(bare.owner);
  const nBare = bare.polys.length;
  fps.forEach((fp, i) =>
    fillPolygon(g, fp, (k) => {
      if (solid[k]) return;
      solid[k] = 1;
      owner[k] = nBare + i;
    }),
  );
  buffers.fit(g);
  distanceField(g, solid, buffers);
  const width = widthBuf;
  for (let k = 0; k < g.n; k++) {
    width[k] = solid[k] ? -1 : Math.min(WIDE, 2 * Math.sqrt(buffers.d2[k] as number) * g.c);
  }
  for (const t of throats) throatWidths(t, fps, g, width);
  const first = new Int32Array(rooms.length).fill(-1);
  if (bare.startCells.length) {
    widestWays(g, width, bare.startCells, null, mainSearch, {
      wide: WIDE,
      step: STEP,
      room,
      first,
      notIn: throatOf,
    });
  } else {
    mainSearch.fit(g.n);
    mainSearch.id++;
  }
  pass = {
    level,
    bare,
    pieces,
    fps,
    solid,
    owner,
    width,
    near: buffers.near,
    first,
    search: mainSearch,
    raster: { g, solid, owner },
    bareRaster: { g, solid: bare.solid, owner: bare.owner },
    obs: { polys: [...bare.polys, ...fps], nBare, ids: pieces.map((p) => p.id) },
    bareObs: { polys: bare.polys, nBare, ids: [] },
    nBare,
  };
  return pass;
}

/**
 * The narrowest point of a way of cells on the pass's furnished raster (or the bare one),
 * measured exactly where it comes within 0.10 m of `need`. For the ageing check.
 */
export function measureWay(p: FurnishedPass, cells: number[], need: number, bare = false): Measure {
  const b = p.bare;
  return bare
    ? measure(cells, p.bareRaster, b.width, b.throatOf, b.throats, need, p.bareObs)
    : measure(cells, p.raster, p.width, b.throatOf, b.throats, need, p.obs);
}

/** The piece a measured obstacle index is, if it is one. */
export const passPiece = (p: FurnishedPass, polyIdx: number): string | null =>
  polyIdx >= p.nBare ? (p.obs.ids[polyIdx - p.nBare] ?? null) : null;

/** Pieces narrowing a bare way (where it's now under `need`) or standing in it. */
export function narrowingPieces(p: FurnishedPass, cells: number[], need: number): string[] {
  const { solid, owner, width, near, nBare, obs, bare } = p;
  const c = bare.g.c;
  const out = new Set<string>();
  for (const k of cells) {
    if (solid[k] && (owner[k] as number) >= nBare)
      out.add(obs.ids[(owner[k] as number) - nBare] as string);
    else if (
      !solid[k] &&
      (width[k] as number) < need &&
      (width[k] as number) < (bare.width[k] as number) - c
    ) {
      const nk = near[k] as number;
      const o = nk >= 0 ? (owner[nk] as number) : -1;
      if (o >= nBare) out.add(obs.ids[o - nBare] as string);
    }
  }
  return [...out];
}

/**
 * Where a closed way is drawn shut: across the doorway a piece fills (its span on the wall's
 * centre line), else across the bare way just before the first piece standing in it.
 */
export function closedBarOf(p: FurnishedPass, bareWay: number[]): [Vec2, Vec2] {
  const { solid, owner, nBare, bare } = p;
  const { g, throatOf, throats } = bare;
  const blocked = (k: number) => !!solid[k] && (owner[k] as number) >= nBare;
  const hit = bareWay.findIndex(blocked);
  if (hit < 0) {
    const q = cellCentre(g, bareWay[bareWay.length - 1] as number);
    return [q, q];
  }
  for (let i = hit; i < bareWay.length && blocked(bareWay[i] as number); i++) {
    const t = throatOf[bareWay[i] as number] as number;
    const th = t >= 0 ? throats[t] : undefined;
    if (th) {
      const at = (u: number) => ({ x: th.f.a.x + th.f.d.x * u, y: th.f.a.y + th.f.d.y * u });
      return [at(th.u0), at(th.u1)];
    }
  }
  const q = cellCentre(g, bareWay[Math.max(0, hit - 1)] as number);
  const r = across(q, p.bareObs, p.bareRaster);
  return r ? [r.a, r.b] : [q, q];
}

/** Pieces standing in a bare way (it is closed). */
export function standingPieces(p: FurnishedPass, cells: number[]): string[] {
  const out = new Set<string>();
  for (const k of cells) {
    const o = p.owner[k] as number;
    if (p.solid[k] && o >= p.nBare) out.add(p.obs.ids[o - p.nBare] as string);
  }
  return [...out];
}

/** A way's cells as plan points (at most 60). */
export const wayPoints = (p: FurnishedPass, cells: number[]): Vec2[] => polyline(p.bare.g, cells);

/** The bare plan rastered (rooms, throats, the bare widest ways from the main door). */
export type BarePlan = Bare;
export type { Throat as DoorThroat, Measure as WayMeasure };

const reports = new WeakMap<Level, WalkwayReport>();

/**
 * Walkways on a level as it is shown: from the main door to every room (each room's widest
 * way), and from a bedroom's door to each usable side of its bed. A short route blames the
 * pieces either side of its narrowest point; one issue per piece and pinch, naming every room
 * or bed side beyond it.
 */
export function walkwayReport(level: Level): WalkwayReport {
  const cached = reports.get(level);
  if (cached) return cached;
  const bare = bareOf(level);
  const { g, room, rooms, throats, throatOf } = bare;
  const grid = { cell: g.c, cells: g.n };
  if (!bare.start) {
    const r: WalkwayReport = { status: 'no-main-door', start: null, routes: [], issues: [], grid };
    if (Object.isFrozen(level)) reports.set(level, r);
    return r;
  }

  const pass = furnishedPass(level);
  const { solid, owner, width, raster, bareRaster, obs, bareObs, nBare, pieces, first } = pass;
  const pieceOf = (polyIdx: number) =>
    polyIdx >= nBare ? (obs.ids[polyIdx - nBare] ?? null) : null;

  /** The flat's own widest width along a bare way: the cap on what a route may need. */
  const capOf = (cells: number[], base: number, roomIdx?: number) => {
    const key = roomIdx === undefined ? '' : `${roomIdx}|${base}`;
    const known = bare.caps.get(key);
    if (key && known !== undefined) return known;
    const m = measure(cells, bareRaster, bare.width, throatOf, throats, base, bareObs);
    const cap = m.exact ? m.have : Number.POSITIVE_INFINITY;
    if (key) bare.caps.set(key, cap);
    return cap;
  };

  /** Pieces narrowing the bare way (where it's now under the need) or standing in it. */
  const narrowing = (cells: number[], need: number) => narrowingPieces(pass, cells, need);

  const closedBar = (bareWay: number[]) => closedBarOf(pass, bareWay);

  const routes: WalkwayRoute[] = [];
  const pinchOf = new Map<WalkwayRoute, Measure>();

  /** Judge one target: its best cell now (-1: not reached) and on the bare plan. */
  const judge = (
    to: WalkwayTo,
    kind: 'circulation' | 'bed',
    base: number,
    now: { search: Search; cell: number },
    bareWay: number[],
    roomIdx?: number,
  ) => {
    const cap = bareWay.length ? capOf(bareWay, base, roomIdx) : Number.POSITIVE_INFINITY;
    const need = Math.min(base, cap - CAP_MARGIN);
    const capped = need < base - 1e-9;
    if (now.cell < 0) {
      // Closed: the pieces standing in the bare way (else those narrowing it).
      const standing = new Set<string>();
      for (const k of bareWay) {
        if (solid[k] && (owner[k] as number) >= nBare) {
          standing.add(obs.ids[(owner[k] as number) - nBare] as string);
        }
      }
      const blamed = standing.size ? [...standing] : narrowing(bareWay, need);
      routes.push({
        route: kind,
        to,
        need,
        capped,
        have: 0,
        ok: false,
        pinch: closedBar(bareWay),
        path: polyline(g, bareWay),
        blamed,
      });
      return;
    }
    const cells = now.search.path(now.cell);
    const m = measure(cells, raster, width, throatOf, throats, need, obs);
    const ok = m.have >= m.need - 0.005;
    let blamed: string[] = [];
    if (!ok) {
      blamed = m.by.map(pieceOf).filter((id) => !!id) as string[];
      // Wall to wall: the furniture pushed the way round to a narrower gap of the flat's.
      if (!blamed.length) blamed = narrowing(bareWay, need);
    }
    const route: WalkwayRoute = {
      route: kind,
      to,
      need: Math.min(need, m.need),
      capped: capped || m.need < need - 1e-9,
      have: Math.max(0, m.have),
      ok,
      pinch: ok ? null : m.pinch,
      path: polyline(g, cells),
      blamed,
    };
    routes.push(route);
    pinchOf.set(route, m);
  };

  // Rooms with a bed in them: a room only reached through one is an en-suite (0.60 m).
  const bedRooms = new Set<number>();
  const beds = pieces.filter((it) => {
    const rule = CLEARANCE_RULES[it.assetId];
    return !!rule && rule.side !== 'front';
  });
  for (const b of beds) {
    const k = cellAt(g, { x: b.position.x, y: b.position.z });
    if (k >= 0 && (room[k] as number) >= 0) bedRooms.add(room[k] as number);
  }
  const direct = new Set<number>();
  if (bare.startRoom >= 0) {
    direct.add(bare.startRoom);
    const queue = [bare.startRoom];
    while (queue.length) {
      const r = queue.shift() as number;
      if (r !== bare.startRoom && bedRooms.has(r)) continue;
      for (const q of bare.adj[r] ?? []) {
        if (direct.has(q)) continue;
        direct.add(q);
        queue.push(q);
      }
    }
  }

  // Circulation: every room of a size, if the bare plan joins it to the main door.
  rooms.forEach((r, idx) => {
    if (r.area < MIN_ROOM_AREA) return;
    const bareCell = bare.first[idx] as number;
    if (bareCell < 0) return;
    const base = direct.has(idx) ? WALKWAY_NEED : BED_WAY_NEED;
    judge(
      { roomId: r.id },
      'circulation',
      base,
      { search: pass.search, cell: first[idx] as number },
      bare.search.path(bareCell),
      idx,
    );
  });

  // To the bed: from the bedroom's doors (from the main door in its own room or a studio).
  for (const bed of beds) {
    const k = cellAt(g, { x: bed.position.x, y: bed.position.z });
    const r = k >= 0 ? (room[k] as number) : -1;
    if (r < 0) continue;
    const sides = bedSides(level, bed);
    if (!sides.length) continue;
    const all = throats.filter(
      (t) => t.rooms.includes(r) && !(t.rooms[0] === r && t.rooms[1] === r),
    );
    // In from the rest of the flat: not through its own en-suite.
    const fromFlat = all.filter((t) => t.rooms.some((q) => q !== r && direct.has(q)));
    const doors = fromFlat.length ? fromFlat : all;
    const own = r !== bare.startRoom && doors.length > 0;
    const seeds = own ? doors.flatMap((t) => t.cells.filter((c) => room[c] === r)) : [];
    const seedKey = `${r}|${doors.map((t) => t.openingId).join(',')}`;
    let bareRoom = own ? bare.roomSearches.get(seedKey) : undefined;
    if (own && !bareRoom) {
      bareRoom = new Search(g.n);
      widestWays(g, bare.width, seeds, null, bareRoom, { wide: WIDE, step: STEP, room, only: r });
      bare.roomSearches.set(seedKey, bareRoom);
    }
    for (const side of sides) {
      const zoneCells: number[] = [];
      fillPolygon(g, side.zone, (c) => {
        const p = cellCentre(g, c);
        if (pointInPolygon(p, side.zone) && room[c] === r) zoneCells.push(c);
      });
      const best = (s: Search, w: Float32Array) => {
        let cell = -1;
        let bw = -1;
        for (const c of zoneCells) {
          if ((w[c] as number) < 0 || !s.reached(c)) continue;
          const v = s.width(c);
          if (v > bw) {
            bw = v;
            cell = c;
          }
        }
        return cell;
      };
      const to = { bedId: bed.id, side: side.side };
      if (own && bareRoom) {
        const bc = best(bareRoom, bare.width);
        if (bc < 0) continue;
        const bareWay = bareRoom.path(bc);
        widestWays(g, width, seeds, null, auxSearch, { wide: WIDE, step: STEP, room, only: r });
        judge(
          to,
          'bed',
          BED_WAY_NEED,
          { search: auxSearch, cell: best(auxSearch, width) },
          bareWay,
        );
      } else {
        const bc = best(bare.search, bare.width);
        if (bc < 0) continue;
        judge(
          to,
          'bed',
          BED_WAY_NEED,
          { search: pass.search, cell: best(pass.search, width) },
          bare.search.path(bc),
        );
      }
    }
  }

  // One issue per piece and pinch, naming every room and bed side beyond it: routes held up
  // by the same pieces at the same need are one pinch (the narrowest of them is shown). A
  // bedroom doorway narrowed by a piece is the room's circulation route's to report.
  const groups = new Map<string, { routes: WalkwayRoute[]; blamed: string[] }>();
  for (const r of routes) {
    if (r.ok || !r.blamed.length || !r.pinch) continue;
    if (r.route === 'bed' && pinchOf.get(r)?.inThroat) continue;
    const blamed = [...new Set(r.blamed)].sort();
    const k = `${r.route}|${blamed.join(',')}|${Math.round(r.need * 100)}`;
    const grp = groups.get(k) ?? { routes: [], blamed };
    grp.routes.push(r);
    groups.set(k, grp);
  }
  const issues: Extract<ClearanceIssue, { kind: 'walkway' }>[] = [];
  for (const grp of groups.values()) {
    const r0 = grp.routes.reduce((p, q) => (q.have < p.have ? q : p));
    for (const itemId of grp.blamed) {
      issues.push({
        kind: 'walkway',
        itemId,
        route: r0.route,
        to: [...grp.routes].sort((p, q) => p.have - q.have || q.need - p.need).map((r) => r.to),
        need: r0.need,
        have: r0.have,
        capped: r0.capped,
        pinch: r0.pinch as [Vec2, Vec2],
        path: r0.path,
      });
    }
  }
  const report: WalkwayReport = {
    status: routes.some((r) => !r.ok) ? 'issues' : 'ok',
    start: bare.start,
    routes,
    issues,
    grid,
  };
  if (Object.isFrozen(level)) reports.set(level, report);
  return report;
}

/** For the plan details' walkway line. */
export function walkwayStatus(level: Level): WalkwayReport['status'] {
  return walkwayReport(level).status;
}
