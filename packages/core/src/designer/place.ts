import { CLEARANCE_RULES, DINING_CHAIRS, PULL_BACK, doorSweep, ruleSide } from '../clearance';
import { frontReach } from '../clearance-doors';
import { overlapDepth, box as polyBox, roomOff, sideOf, zoneOf } from '../convex';
import { type FurnitureKind, furnitureLayer, itemFootprint, itemSize, newItem } from '../furniture';
import { pointInPolygon } from '../geometry';
import type { PlanGeometry } from '../plan';
import { roomShapes } from '../rooms';
import type { Item, Level, Vec2 } from '../schema';
import { fixedSize } from './catalogue';
import { ACCESS, FIT, UNDER_WINDOW, roleOf, sillTop, windowZones } from './principles';
import { type Face, clearStretches } from './spaces';
import type { Note } from './walls';

/**
 * Placing a space's pieces, and repairing them: each piece is put where the answer says
 * (backed onto a wall face at `along`, or free at `at`), then checked against a small index
 * of what is in or around that space only (its rooms, the walls and windows near it, door
 * sweeps and doorways, and the pieces placed before it). A piece with a problem is moved
 * in turn: slid along its wall, moved, turned, narrowed, taking the first try that leaves it
 * with none; otherwise it is left out. Pieces go in priority order, so of two that clash
 * the lower-priority one is the one left out.
 *
 * Room to use a piece (a wardrobe's doors, beside a bed) is checked as it is placed: a
 * position that leaves it short, or stands in another piece's, is taken only when no
 * position on any wall is clear of both. Walkways are checked once a space is furnished
 * (`keepOut` moves a piece off a way it narrows).
 */

/** What a candidate position runs into. */
export type Hit =
  | { kind: 'outside' }
  | { kind: 'wall' }
  | { kind: 'door' }
  | { kind: 'doorway' }
  | { kind: 'opening'; window: boolean }
  | { kind: 'overlap'; otherId: string; otherName: string }
  /** Short of the room in front of it (or beside it) to use it. */
  | { kind: 'zone' }
  /** In the room another piece needs to be used. */
  | { kind: 'in-zone'; otherId: string; otherName: string }
  /** On a walkway being kept clear. */
  | { kind: 'keep-out' };

/** Hits a position may still be taken with, when nothing better is found. */
const SOFT = new Set<Hit['kind']>(['zone', 'in-zone']);
export const blocking = (hs: Hit[]) => hs.some((h) => !SOFT.has(h.kind));

const SEAT = /dining-chair|desk-chair|stool|plastic-chair/;
const TABLE = /table|desk|dining-(\d|extendable|bench)/;

interface Placed {
  id: string;
  assetId: string;
  name: string;
  fp: Vec2[];
  box: Box;
  /** The room it needs kept clear to be used. */
  zones: Vec2[][];
  /** Its zones include the view to the TV (a coffee table, a rug or a side table may stand there). */
  view?: boolean;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const boxOf = (poly: Vec2[]): Box => {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const p of poly) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
};
const apart = (p: Box, q: Box, pad = 0) =>
  p.x1 < q.x0 - pad || q.x1 < p.x0 - pad || p.y1 < q.y0 - pad || q.y1 < p.y0 - pad;

export interface Shape {
  poly: Vec2[];
  box: Box;
}
export const shape = (poly: Vec2[]): Shape => ({ poly, box: boxOf(poly) });

/** Everything a piece in one space can run into, and the pieces placed in it so far. */
export interface SpaceIndex {
  rooms: { outer: Vec2[]; holes: Vec2[][] }[];
  solid: Shape[];
  /** Each doorway's gap and its throat, by the opening's id. */
  doorways: (Shape & { openingId: string; throat: boolean })[];
  sweeps: Shape[];
  /** In front of each window, kept clear above its sill. */
  windows: (Shape & { sill: number })[];
  placed: Placed[];
  /** Ways being kept clear (a walkway a piece narrowed). */
  keepOut: Shape[];
  /**
   * Openings the design adds or moves (not in the level it starts from, or not where they
   * were): a piece kept where it stands must keep clear of their throats too.
   */
  fresh?: ReadonlySet<string>;
}

/** The index for a space of `level`: its rooms, and walls, windows and doors within a metre. */
export function spaceIndex(level: Level, geom: PlanGeometry, rooms: string[]): SpaceIndex {
  const shapes = roomShapes(level);
  const rs = rooms.flatMap((id) => {
    const s = shapes.get(id);
    return s ? [{ outer: s.outer, holes: s.holes }] : [];
  });
  const area = boxOf(rs.flatMap((r) => r.outer));
  const near = (s: Shape) => !apart(s.box, area, 1);
  const solid = [
    ...geom.pieces.map((p) => p.polygon),
    ...geom.footprints.hubs.map((h) => h.polygon),
    ...geom.openings.filter((o) => o.kind === 'window').map((o) => o.polygon),
  ]
    .map(shape)
    .filter(near);
  // A doorway, and its throat: 0.6 m into the rooms either side, kept free to walk through.
  const doorways = geom.openings
    .filter((o) => o.kind !== 'window')
    .flatMap((o) => {
      const f = o.frame;
      const [u0, u1] = o.span;
      const v = f.half + THROAT;
      const at = (u: number, k: number) => ({
        x: f.a.x + f.d.x * u + f.n.x * k,
        y: f.a.y + f.d.y * u + f.n.y * k,
      });
      const openingId = o.opening.id;
      return [
        { ...shape(o.polygon), openingId, throat: false },
        { ...shape([at(u0, -v), at(u1, -v), at(u1, v), at(u0, v)]), openingId, throat: true },
      ];
    })
    .filter(near);
  const sweeps = Object.values(level.openings)
    .filter((o) => o.kind === 'door')
    .flatMap((o) => doorSweep(level, o.id, geom.frames))
    .map(shape)
    .filter(near);
  const windows = geom.openings
    .filter((o) => o.kind === 'window')
    .flatMap((o) => windowZones(o).map((z) => ({ ...shape(z), sill: o.opening.sill })))
    .filter(near);
  return { rooms: rs, solid, doorways, sweeps, windows, placed: [], keepOut: [] };
}

/** A footprint corner pulled 1 cm towards the middle (corners on a room's edge read as in). */
function inset(fp: Vec2[]): Vec2[] {
  const c = fp.reduce((p, q) => ({ x: p.x + q.x / fp.length, y: p.y + q.y / fp.length }), {
    x: 0,
    y: 0,
  });
  return fp.map((p) => {
    const d = Math.hypot(p.x - c.x, p.y - c.y) || 1;
    const k = Math.min(0.01, d / 2) / d;
    return { x: p.x + (c.x - p.x) * k, y: p.y + (c.y - p.y) * k };
  });
}

export const inRooms = (ix: SpaceIndex, p: Vec2) =>
  ix.rooms.some((r) => pointInPolygon(p, r.outer) && !r.holes.some((h) => pointInPolygon(p, h)));

/** A footprint's back side, facing out behind. */
function backOf(fp: Vec2[]) {
  const [bl, br, , fl] = fp as [Vec2, Vec2, Vec2, Vec2];
  const depth = Math.hypot(fl.x - bl.x, fl.y - bl.y) || 1;
  const width = Math.hypot(bl.x - br.x, bl.y - br.y) || 1;
  return { a: br, b: bl, n: { x: (bl.x - fl.x) / depth, y: (bl.y - fl.y) / depth }, width };
}

/**
 * Room behind a dining chair to pull it out: the checks measure 0.75 m from the table's
 * edge, and a chair half tucked under reaches 0.15 m less than its depth past it.
 */
function chairPull(fp: Vec2[]): number {
  const [bl, , , fl] = fp as [Vec2, Vec2, Vec2, Vec2];
  const depth = Math.hypot(fl.x - bl.x, fl.y - bl.y);
  return Math.max(0.3, PULL_BACK - depth + 0.15);
}

/** How far a doorway's throat reaches into the rooms either side. */
const THROAT = 0.6;

/** Whether a piece blocks the floor (rugs, lamps, wall cabinets and ceiling lights don't). */
export const blocksFloor = (kind: FurnitureKind) =>
  !kind.walkThrough && kind.category !== 'People' && furnitureLayer(kind) === 'floor';

/** A wall piece's stretch along its face, to check it against the face's openings. */
export interface OnFace {
  face: Face;
  u0: number;
  u1: number;
  bottom: number;
  top: number;
}

/**
 * What blocks a piece at this position whatever else is placed: outside the rooms, a wall, a
 * doorway, a door's sweep, a way kept clear, a window. Null: nothing.
 */
export function fixedHit(
  ix: SpaceIndex,
  item: Item,
  kind: FurnitureKind,
  on?: OnFace,
  fp = itemFootprint(item, kind),
): Hit | null {
  return fixedHitOf(ix, item, kind, on, fp, ix.keepOut);
}

/**
 * Whether a footprint stands on a way kept clear: fixedHit's keep-out test alone (with
 * `fixedHit(ix minus its keepOut)` it makes up fixedHit, for a pose tried with and without).
 */
export function keepOutHit(keepOut: Shape[], kind: FurnitureKind, fp: Vec2[]): boolean {
  if (!keepOut.length || !blocksFloor(kind)) return false;
  const box = boxOf(fp);
  return keepOut.some((s) => !apart(s.box, box) && overlapDepth(fp, s.poly) > 0.01);
}

/** fixedHit, with the ways kept clear given (none: what blocks a pose whatever is kept clear). */
export function fixedHitOf(
  ix: SpaceIndex,
  item: Item,
  kind: FurnitureKind,
  on: OnFace | undefined,
  fp: Vec2[],
  keepOut: Shape[],
): Hit | null {
  if (!inset(fp).every((p) => inRooms(ix, p))) return { kind: 'outside' };
  if (on) {
    for (const o of on.face.openings) {
      const vertical =
        o.kind === 'window' ? on.top > o.sill - 0.02 && on.bottom < o.top : on.bottom < o.top;
      if (vertical && on.u0 < o.u1 - 1e-6 && o.u0 < on.u1 - 1e-6) {
        return { kind: 'opening', window: o.kind === 'window' };
      }
    }
  }
  if (!blocksFloor(kind)) return null;
  const box = boxOf(fp);
  const hit = (shapes: Shape[], depth: number) =>
    shapes.some((s) => !apart(s.box, box) && overlapDepth(fp, s.poly) > depth);
  if (hit(ix.solid, 0.01)) return { kind: 'wall' };
  if (hit(ix.doorways, 0.01)) return { kind: 'doorway' };
  if (hit(ix.sweeps, 0.005)) return { kind: 'door' };
  if (hit(keepOut, 0.01)) return { kind: 'keep-out' };
  if (!UNDER_WINDOW.has(roleOf(kind))) {
    const top = sillTop(kind, itemSize(item, kind).h);
    const high = ix.windows.filter((w) => top > w.sill - FIT.sill);
    if (hit(high, 0.01)) return { kind: 'opening', window: true };
  }
  return null;
}

/**
 * What stops a piece kept where it stands (Want.stays) from staying: outside the rooms, a
 * wall, a doorway, a door's sweep, a way kept clear. Not the throat of a doorway it stood by
 * already, as fixedHit has for a new piece (the checks judge the ways past it), but the
 * throat of one the design adds or moves (`ix.fresh`). Not a window either.
 */
export function stayHit(ix: SpaceIndex, kind: FurnitureKind, fp: Vec2[]): Hit | null {
  if (!inset(fp).every((p) => inRooms(ix, p))) return { kind: 'outside' };
  if (!blocksFloor(kind)) return null;
  const box = boxOf(fp);
  const hit = (shapes: Shape[], depth: number) =>
    shapes.some((s) => !apart(s.box, box) && overlapDepth(fp, s.poly) > depth);
  if (hit(ix.solid, 0.01)) return { kind: 'wall' };
  const doorways = ix.doorways.filter((d) => !d.throat || ix.fresh?.has(d.openingId));
  if (hit(doorways, 0.01)) return { kind: 'doorway' };
  if (hit(ix.sweeps, 0.005)) return { kind: 'door' };
  if (hit(ix.keepOut, 0.01)) return { kind: 'keep-out' };
  return null;
}

/**
 * What a piece at this position runs into (empty: it can stand there). `fixedChecked`: its
 * fixed hits (fixedHit) are known to be none. `fp`: its footprint, when already worked out.
 */
export function hitsOf(
  ix: SpaceIndex,
  item: Item,
  kind: FurnitureKind,
  on?: OnFace,
  fixedChecked = false,
  fp = itemFootprint(item, kind),
): Hit[] {
  const out: Hit[] = [];
  // What blocks it outright: the first reason is enough (it is the one said).
  if (!fixedChecked) {
    const fixed = fixedHit(ix, item, kind, on, fp);
    if (fixed) return [fixed];
  }
  if (!blocksFloor(kind)) return out;
  const box = boxOf(fp);
  if (on) {
    for (const o of on.face.openings) {
      const vertical =
        o.kind === 'window' ? on.top > o.sill - 0.02 && on.bottom < o.top : on.bottom < o.top;
      if (vertical && on.u0 < o.u1 - 1e-6 && o.u0 < on.u1 - 1e-6) {
        return [{ kind: 'opening', window: o.kind === 'window' }];
      }
    }
  }
  const tuckedWith = (p: Placed) =>
    (SEAT.test(item.assetId) && TABLE.test(p.assetId)) ||
    (SEAT.test(p.assetId) && TABLE.test(item.assetId));
  for (const p of ix.placed) {
    if (apart(p.box, box) || tuckedWith(p)) continue;
    if (overlapDepth(fp, p.fp) > 0.04) {
      return [{ kind: 'overlap', otherId: p.id, otherName: p.name }];
    }
  }
  // Room to use it: its own zones clear of walls and pieces, and clear of others' zones.
  const rule = CLEARANCE_RULES[kind.id];
  if (rule) {
    const near = (z: Vec2[]) => {
      const zb = boxOf(z);
      return [
        ...ix.solid.filter((s) => !apart(s.box, zb)).map((s) => s.poly),
        ...ix.placed.filter((p) => !apart(p.box, zb) && !tuckedWith(p)).map((p) => p.fp),
      ];
    };
    // The hard need (a bed's access side, sliding wardrobe doors: 0.50 m); a double bed needs
    // one long side only.
    const access = ACCESS[kind.id];
    const need = access?.hard ?? rule.need;
    const room = (side: 'front' | 'left' | 'right') => {
      const sd = side === 'front' ? sideOf(fp, side) : ruleSide(fp, side);
      return roomOff(sd, need, near(zoneOf(sd, need))) >= need - 0.005;
    };
    const ok =
      rule.side === 'front'
        ? room('front')
        : rule.side === 'sides' && !access?.oneSide
          ? room('left') && room('right')
          : room('left') || room('right');
    if (!ok) out.push({ kind: 'zone' });
  }
  // A dining chair: room behind it to pull it out and sit (from its table, which is ahead).
  if (DINING_CHAIRS.has(kind.id) && !out.length) {
    const back = backOf(fp);
    const need = chairPull(fp);
    const zone = zoneOf(back, need);
    const zb = boxOf(zone);
    const obstacles = [
      ...ix.solid.filter((s) => !apart(s.box, zb)).map((s) => s.poly),
      ...ix.placed.filter((p) => !apart(p.box, zb) && !TABLE.test(p.assetId)).map((p) => p.fp),
    ];
    if (roomOff(back, need, obstacles) < need - 0.005) out.push({ kind: 'zone' });
  }
  // Its hinged front (a wardrobe's, the fridge's doors) clear of doors' swings.
  const reach = frontReach(item, fp);
  if (reach && !out.length) {
    const rb = boxOf(reach);
    if (ix.sweeps.some((s) => !apart(s.box, rb) && overlapDepth(reach, s.poly) > 0.02)) {
      out.push({ kind: 'zone' });
    }
  }
  const low = LOW_ROLES.has(roleOf(kind));
  for (const p of ix.placed) {
    if (!p.zones.length || tuckedWith(p) || (p.view && low)) continue;
    if (p.zones.some((z) => !apart(polyBox(z), box) && overlapDepth(fp, z) > 0.01)) {
      out.push({ kind: 'in-zone', otherId: p.id, otherName: p.name });
      break;
    }
  }
  return out;
}

/** What may stand between a sofa and its TV: low tables and rugs. */
const LOW_ROLES = new Set(['coffee-table', 'side-table', 'rug']);

/**
 * The room a placed piece needs kept clear: in front, a double bed's two sides, a single
 * bed's roomier side.
 */
function zonesOf(ix: SpaceIndex, kind: FurnitureKind, fp: Vec2[]): Vec2[][] {
  if (DINING_CHAIRS.has(kind.id)) {
    const back = backOf(fp);
    return [zoneOf(back, chairPull(fp))];
  }
  const rule = CLEARANCE_RULES[kind.id];
  if (!rule) return [];
  const access = ACCESS[kind.id];
  const need = access?.hard ?? rule.need;
  if (rule.side === 'front') return [zoneOf(sideOf(fp, 'front'), need)];
  const sides = (['left', 'right'] as const).map((s) => ruleSide(fp, s));
  if (rule.side === 'sides' && !access?.oneSide) return sides.map((s) => zoneOf(s, need));
  const room = (s: (typeof sides)[number]) => {
    const z = boxOf(zoneOf(s, need));
    const near = [
      ...ix.solid.filter((x) => !apart(x.box, z)).map((x) => x.poly),
      ...ix.placed.filter((p) => !apart(p.box, z)).map((p) => p.fp),
    ];
    return roomOff(s, need, near);
  };
  const [l, r] = sides as [(typeof sides)[number], (typeof sides)[number]];
  return [zoneOf(room(l) >= room(r) ? l : r, need)];
}

/**
 * The way to keep clear around a walkway's narrow point: the path within 1.5 m of the pinch
 * (all of it, with none), as wide as the walkway needs.
 */
export function keepOutOf(path: Vec2[], pinch: [Vec2, Vec2] | null, need: number): Shape[] {
  const mid = pinch ? { x: (pinch[0].x + pinch[1].x) / 2, y: (pinch[0].y + pinch[1].y) / 2 } : null;
  const h = need / 2;
  const out: Shape[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const p = path[i] as Vec2;
    const q = path[i + 1] as Vec2;
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len < 1e-6) continue;
    if (mid) {
      // The segment's nearest point to the pinch (a long one passes close by between its ends).
      const t = Math.max(
        0,
        Math.min(1, ((mid.x - p.x) * (q.x - p.x) + (mid.y - p.y) * (q.y - p.y)) / (len * len)),
      );
      const c = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
      if (Math.hypot(c.x - mid.x, c.y - mid.y) > 1.5) continue;
    }
    const d = { x: (q.x - p.x) / len, y: (q.y - p.y) / len };
    const n = { x: -d.y * h, y: d.x * h };
    const a = { x: p.x - d.x * h, y: p.y - d.y * h };
    const b = { x: q.x + d.x * h, y: q.y + d.y * h };
    out.push(
      shape([
        { x: a.x + n.x, y: a.y + n.y },
        { x: b.x + n.x, y: b.y + n.y },
        { x: b.x - n.x, y: b.y - n.y },
        { x: a.x - n.x, y: a.y - n.y },
      ]),
    );
  }
  return out;
}

/** Adds a piece to the index, for the pieces after it to keep clear of. */
export function addToIndex(
  ix: SpaceIndex,
  item: Item,
  kind: FurnitureKind,
  fp = itemFootprint(item, kind),
) {
  if (!blocksFloor(kind)) return;
  ix.placed.push({
    id: item.id,
    assetId: item.assetId,
    name: nameOf(kind),
    fp,
    box: boxOf(fp),
    zones: zonesOf(ix, kind, fp),
  });
}

/** A kind's name in a sentence: "the built-in wardrobe", "the 3-seat sofa". */
export function nameOf(kind: FurnitureKind): string {
  const n = kind.name;
  return /^[A-Z][a-z]/.test(n) ? n[0]?.toLowerCase() + n.slice(1) : n;
}

const reasonOf = (h: Hit): string => {
  switch (h.kind) {
    case 'door':
      return 'the door';
    case 'doorway':
      return 'the doorway';
    case 'opening':
      return h.window ? 'the window' : 'the doorway';
    case 'overlap':
      return `the ${h.otherName}`;
    case 'wall':
      return 'the wall';
    case 'outside':
      return 'the room’s walls';
    case 'zone':
      return 'the room it needs to be used';
    case 'in-zone':
      return `the room the ${h.otherName} needs`;
    case 'keep-out':
      return 'the walkway';
  }
};

/** What the model asked for one piece, resolved: its kind and size, and where. */
export interface Want {
  id: string;
  ref: string;
  kind: FurnitureKind;
  w: number;
  d: number;
  h: number;
  /** Backed onto this face, `along` from the wall's start (null: centred). */
  face: Face | null;
  /** The space's other faces, longest clear first, to try when `face` has no room. */
  faces: Face[];
  along: number | null;
  /** Free-standing: centre and rotation (radians). */
  at: Vec2 | null;
  rotation: number;
  ceiling: number;
  /** A piece of the flat's own, brought along. */
  brought: Item | null;
  /**
   * `brought` is a piece of the renovation the design starts from (an accepted version's, or
   * put in by hand) that the answer keeps: it stands where it is, or a few cm off, while it
   * still fits there; only otherwise is it placed again, like a piece brought along.
   */
  stays?: boolean;
}

export interface PlaceOutcome {
  item: Item | null;
  repaired: Note[];
  dropped: Note[];
  /** Positions tried. */
  tries: number;
}

export const BUILT_IN_MIN = 0.3;
const SLIDE = 0.6;
const MOVE = 0.4;
const STEP = 0.05;
const NARROW = [0.95, 0.9, 0.85, 0.8];

/**
 * The item for a piece at a pose. Items made here are cached with their pose and reused across
 * solves, then deep-frozen in results: never mutate one after it is made.
 */
export function itemAt(want: Want, at: Vec2, rotation: number, w: number): Item {
  const k = want.kind;
  const base = want.brought
    ? { ...structuredClone(want.brought), position: { ...want.brought.position, x: at.x, z: at.y } }
    : newItem(want.id, k, at, rotation, want.ceiling);
  const tall = k.carpentry === 'wardrobe' || k.carpentry === 'tall';
  const tau = Math.PI * 2;
  return {
    ...base,
    rotationY: ((rotation % tau) + tau) % tau,
    scale: want.brought
      ? { ...want.brought.scale, x: w / k.size.w }
      : {
          x: w / k.size.w,
          y: tall ? base.scale.y : want.h / k.size.h,
          z: want.d / k.size.d,
        },
  };
}

/** A pose backed onto a face: the centre `along` the wall, its back on the face, facing in. */
export function onFace(f: Face, along: number, d: number): { at: Vec2; rotation: number } {
  const off = f.frame.half + d / 2 + 0.0005;
  const fr = f.frame;
  return {
    at: {
      x: fr.a.x + fr.d.x * along + fr.n.x * off * f.side,
      y: fr.a.y + fr.d.y * along + fr.n.y * off * f.side,
    },
    rotation: Math.atan2(-fr.n.x * f.side, fr.n.y * f.side),
  };
}

export const vertical = (want: Want) => {
  const bottom = want.kind.elevation ?? 0;
  return { bottom, top: sillTop(want.kind, want.h) };
};

/**
 * Places one piece and repairs it against the index; adds it to the index when placed.
 * Tries at most 60 positions after the first.
 */
export function placePiece(ix: SpaceIndex, want: Want): PlaceOutcome {
  const name = nameOf(want.kind);
  const repaired: Note[] = [];
  const dropped: Note[] = [];
  let tries = 0;
  const note = (text: string) => ({ text, ref: want.ref, itemId: want.id });
  const drop = (why: string): PlaceOutcome => {
    const text = want.brought
      ? `Your ${want.w.toFixed(2)} m ${name} doesn’t fit here: ${why}.`
      : `Left out the ${name}: ${why}.`;
    return { item: null, repaired, dropped: [note(text)], tries };
  };
  const builtIn = !!want.kind.carpentry;

  if (want.face || (want.at === null && want.faces.length)) {
    // Against a wall: the face asked for, else every other face, longest first, before the
    // piece is left out (the first reason it failed is the one said).
    const { bottom, top } = vertical(want);
    const faces = want.face
      ? [want.face, ...want.faces.filter((f) => f !== want.face)]
      : want.faces;
    let firstWhy: string | null = null;
    // The first position found short of room to use it, if no wall has a clear one.
    let fallback: { item: Item; notes: Note[] } | null = null;
    for (const [i, face] of faces.entries()) {
      const before = repaired.length;
      const stretches = clearStretches(face, bottom, top);
      if (!stretches.length) continue;
      let w = want.w;
      const fits = stretches.filter(([s0, s1]) => s1 - s0 >= w - 1e-6);
      const pick = (list: [number, number][]) => {
        if (want.along === null || i > 0) {
          return list.reduce((p, q) => (q[1] - q[0] > p[1] - p[0] ? q : p));
        }
        const a = want.along;
        return list.reduce((p, q) => {
          const dist = ([s0, s1]: [number, number]) => (a < s0 ? s0 - a : a > s1 ? a - s1 : 0);
          return dist(q) < dist(p) ? q : p;
        });
      };
      let stretch: [number, number];
      if (fits.length) stretch = pick(fits);
      else if (builtIn) {
        stretch = pick(stretches);
        const len = stretch[1] - stretch[0];
        if (len < BUILT_IN_MIN) continue;
        w = len;
        repaired.push(note(`Narrowed the ${name} to ${w.toFixed(2)} m to fit the wall.`));
      } else continue;
      const centre = (stretch[0] + stretch[1]) / 2;
      const wanted = want.along === null || i > 0 ? centre : want.along;
      const along = Math.min(stretch[1] - w / 2, Math.max(stretch[0] + w / 2, wanted));
      if (i > 0) {
        repaired.push(
          note(`Moved the ${name} to another wall: it didn’t fit on the one asked for.`),
        );
      } else if (Math.abs(along - wanted) > STEP - 1e-6) {
        const inOpening = face.openings.find((o) => wanted > o.u0 && wanted < o.u1);
        const why = inOpening
          ? inOpening.kind === 'window'
            ? 'the window'
            : 'the doorway'
          : 'the corner';
        repaired.push(
          note(
            `Moved the ${name} ${Math.abs(along - wanted).toFixed(2)} m along the wall to clear ${why}.`,
          ),
        );
      }
      const result = repairOnFace(ix, want, face, along, w);
      tries += result.tries;
      if (result.item && !result.soft) {
        repaired.push(...result.notes.map(note));
        addToIndex(ix, result.item, want.kind);
        return { item: result.item, repaired, dropped, tries };
      }
      if (result.item && !fallback) {
        fallback = {
          item: result.item,
          notes: [...repaired.slice(before), ...result.notes.map(note)],
        };
      }
      // This wall has no clear room for it: its notes go, and the next wall is tried.
      repaired.length = before;
      if (!result.item) firstWhy ??= result.why;
    }
    if (fallback) {
      repaired.push(...fallback.notes);
      addToIndex(ix, fallback.item, want.kind);
      return { item: fallback.item, repaired, dropped, tries };
    }
    return drop(firstWhy ?? 'no wall in the room is long enough');
  }

  if (!want.at) return drop('it had no place');
  const at = want.at;
  if (!inRooms(ix, at)) return drop('it was placed outside this room');
  const result = repairFree(ix, want, at);
  tries += result.tries;
  if (!result.item) return drop(result.why);
  repaired.push(...result.notes.map(note));
  addToIndex(ix, result.item, want.kind);
  return { item: result.item, repaired, dropped, tries };
}

type Repair = (
  | {
      item: Item;
      notes: string[] /** Short of room to use it (no clear position found). */;
      soft: boolean;
    }
  | { item: null; why: string }
) & { tries: number };

const offsets = (max: number) => {
  const out: number[] = [];
  for (let s = STEP; s <= max + 1e-9; s += STEP)
    out.push(Math.round(s * 100) / 100, -Math.round(s * 100) / 100);
  return out;
};
const SLIDES = offsets(SLIDE);
const NARROW_SLIDES = [0, 0.1, -0.1, 0.2, -0.2, 0.3, -0.3];

function repairOnFace(ix: SpaceIndex, want: Want, face: Face, along: number, w: number): Repair {
  const { bottom, top } = vertical(want);
  const name = nameOf(want.kind);
  const at = (u: number, width: number) => {
    const pose = onFace(face, u, want.d);
    return itemAt(want, pose.at, pose.rotation, width);
  };
  const check = (u: number, width: number) =>
    hitsOf(ix, at(u, width), want.kind, {
      face,
      u0: u - width / 2,
      u1: u + width / 2,
      bottom,
      top,
    });
  const first = check(along, w);
  if (!first.length) return { item: at(along, w), notes: [], soft: false, tries: 0 };
  const why = reasonOf(first[0] as Hit);
  let n = 0;
  let soft: { u: number; width: number; note: string | null } | null = blocking(first)
    ? null
    : { u: along, width: w, note: null };
  const tryAt = (u: number, width: number, text: string): Repair | null => {
    n++;
    const hs = check(u, width);
    if (!hs.length) return { item: at(u, width), notes: [text], soft: false, tries: n };
    if (!soft && !blocking(hs)) soft = { u, width, note: text };
    return null;
  };
  for (const s of SLIDES) {
    const r = tryAt(
      along + s,
      w,
      `Moved the ${name} ${Math.abs(s).toFixed(2)} m along the wall to clear ${why}.`,
    );
    if (r) return r;
  }
  if (want.kind.carpentry) {
    for (const k of NARROW) {
      for (const s of NARROW_SLIDES) {
        const r = tryAt(
          along + s,
          w * k,
          `Narrowed the ${name} to ${(w * k).toFixed(2)} m to clear ${why}.`,
        );
        if (r) return r;
      }
    }
  }
  const best = soft as { u: number; width: number; note: string | null } | null;
  if (best) {
    return {
      item: at(best.u, best.width),
      notes: best.note && blocking(first) ? [best.note] : [],
      soft: true,
      tries: n,
    };
  }
  return { item: null, why: `no room for it on that wall (it would hit ${why})`, tries: n };
}

const DIRS: Vec2[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

function repairFree(ix: SpaceIndex, want: Want, at: Vec2): Repair {
  const name = nameOf(want.kind);
  const make = (p: Vec2, r: number, w: number) => itemAt(want, p, r, w);
  const first = hitsOf(ix, make(at, want.rotation, want.w), want.kind);
  if (!first.length) {
    return { item: make(at, want.rotation, want.w), notes: [], soft: false, tries: 0 };
  }
  const why = reasonOf(first[0] as Hit);
  let n = 0;
  let soft: { p: Vec2; r: number; w: number; note: string | null } | null = blocking(first)
    ? null
    : { p: at, r: want.rotation, w: want.w, note: null };
  const tryAt = (p: Vec2, r: number, w: number, text: string): Repair | null => {
    n++;
    const hs = hitsOf(ix, make(p, r, w), want.kind);
    if (!hs.length) return { item: make(p, r, w), notes: [text], soft: false, tries: n };
    if (!soft && !blocking(hs)) soft = { p, r, w, note: text };
    return null;
  };
  for (let s = STEP; s <= MOVE + 1e-9; s += STEP) {
    for (const d of DIRS) {
      const p = { x: at.x + d.x * s, y: at.y + d.y * s };
      const r = tryAt(
        p,
        want.rotation,
        want.w,
        `Moved the ${name} ${s.toFixed(2)} m to clear ${why}.`,
      );
      if (r) return r;
    }
  }
  // Turned only where its way of facing doesn't matter (not a bed, nor a seat facing a focus).
  if (!fixedSize(want.kind) && !FACING.test(want.kind.id)) {
    const turned = want.rotation + Math.PI / 2;
    for (const s of [0, 0.1, 0.2]) {
      for (const d of s ? DIRS : [DIRS[0] as Vec2]) {
        const p = { x: at.x + d.x * s, y: at.y + d.y * s };
        const r = tryAt(p, turned, want.w, `Turned the ${name} to clear ${why}.`);
        if (r) return r;
      }
    }
  }
  if (want.kind.carpentry || want.kind.id === 'rug') {
    for (const k of NARROW) {
      const r = tryAt(
        at,
        want.rotation,
        want.w * k,
        `Narrowed the ${name} to ${(want.w * k).toFixed(2)} m to clear ${why}.`,
      );
      if (r) return r;
    }
  }
  const best = soft as { p: Vec2; r: number; w: number; note: string | null } | null;
  if (best) {
    return {
      item: make(best.p, best.r, best.w),
      notes: best.note && blocking(first) ? [best.note] : [],
      soft: true,
      tries: n,
    };
  }
  return { item: null, why: `no room for it here (it would hit ${why})`, tries: n };
}

/** Pieces whose facing matters: never turned a quarter to clear something. */
const FACING = /sofa|armchair|lounge-chair|chinese-bench|tv|desk/;
