import { doorSweep } from '../clearance';
import { overlapDepth } from '../convex';
import { type FurnitureKind, furnitureLayer, itemFootprint, newItem } from '../furniture';
import { pointInPolygon } from '../geometry';
import type { PlanGeometry } from '../plan';
import { roomShapes } from '../rooms';
import type { Item, Level, Vec2 } from '../schema';
import { fixedSize } from './catalogue';
import { type Face, clearStretches } from './spaces';
import type { Note } from './walls';

/**
 * Placing a space's pieces, and repairing them: each piece is put where the answer says
 * (backed onto a wall face at `along`, or free at `at`), then checked against a small index
 * of what is in or around that space only (its rooms, the walls and windows near it, door
 * sweeps and doorways, and the pieces placed before it). A piece with a problem is moved
 * in turn: slid along its wall, moved, turned, narrowed, taking the first try that leaves it
 * with none; otherwise it is left out. Pieces go in priority order, so of two that clash
 * the lower-priority one is the one left out. The whole level's checks (clearanceIssues,
 * walkwayReport) run once, after.
 */

/** What a candidate position runs into. */
export type Hit =
  | { kind: 'outside' }
  | { kind: 'wall' }
  | { kind: 'door' }
  | { kind: 'doorway' }
  | { kind: 'opening'; window: boolean }
  | { kind: 'overlap'; otherId: string; otherName: string };

const SEAT = /dining-chair|stool|plastic-chair/;
const TABLE = /table|desk|dining-\d/;

interface Placed {
  id: string;
  assetId: string;
  name: string;
  fp: Vec2[];
  box: Box;
}

interface Box {
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

interface Shape {
  poly: Vec2[];
  box: Box;
}
const shape = (poly: Vec2[]): Shape => ({ poly, box: boxOf(poly) });

/** Everything a piece in one space can run into, and the pieces placed in it so far. */
export interface SpaceIndex {
  rooms: { outer: Vec2[]; holes: Vec2[][] }[];
  solid: Shape[];
  doorways: Shape[];
  sweeps: Shape[];
  placed: Placed[];
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
  const doorways = geom.openings
    .filter((o) => o.kind !== 'window')
    .map((o) => shape(o.polygon))
    .filter(near);
  const sweeps = Object.values(level.openings)
    .filter((o) => o.kind === 'door')
    .flatMap((o) => doorSweep(level, o.id, geom.frames))
    .map(shape)
    .filter(near);
  return { rooms: rs, solid, doorways, sweeps, placed: [] };
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

const inRooms = (ix: SpaceIndex, p: Vec2) =>
  ix.rooms.some((r) => pointInPolygon(p, r.outer) && !r.holes.some((h) => pointInPolygon(p, h)));

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

/** What a piece at this position runs into (empty: it can stand there). */
export function hitsOf(ix: SpaceIndex, item: Item, kind: FurnitureKind, on?: OnFace): Hit[] {
  const fp = itemFootprint(item, kind);
  const out: Hit[] = [];
  if (!inset(fp).every((p) => inRooms(ix, p))) out.push({ kind: 'outside' });
  if (on) {
    for (const o of on.face.openings) {
      const vertical =
        o.kind === 'window' ? on.top > o.sill - 0.02 && on.bottom < o.top : on.bottom < o.top;
      if (vertical && on.u0 < o.u1 - 1e-6 && o.u0 < on.u1 - 1e-6) {
        out.push({ kind: 'opening', window: o.kind === 'window' });
        break;
      }
    }
  }
  if (!blocksFloor(kind)) return out;
  const box = boxOf(fp);
  const hit = (shapes: Shape[], depth: number) =>
    shapes.some((s) => !apart(s.box, box) && overlapDepth(fp, s.poly) > depth);
  if (hit(ix.solid, 0.01)) out.push({ kind: 'wall' });
  if (hit(ix.doorways, 0.01)) out.push({ kind: 'doorway' });
  if (hit(ix.sweeps, 0.005)) out.push({ kind: 'door' });
  for (const p of ix.placed) {
    if (apart(p.box, box)) continue;
    const tucked =
      (SEAT.test(item.assetId) && TABLE.test(p.assetId)) ||
      (SEAT.test(p.assetId) && TABLE.test(item.assetId));
    if (tucked) continue;
    if (overlapDepth(fp, p.fp) > 0.04) {
      out.push({ kind: 'overlap', otherId: p.id, otherName: p.name });
      break;
    }
  }
  return out;
}

/** Adds a piece to the index, for the pieces after it to keep clear of. */
export function addToIndex(ix: SpaceIndex, item: Item, kind: FurnitureKind) {
  if (!blocksFloor(kind)) return;
  const fp = itemFootprint(item, kind);
  ix.placed.push({ id: item.id, assetId: item.assetId, name: nameOf(kind), fp, box: boxOf(fp) });
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
}

export interface PlaceOutcome {
  item: Item | null;
  repaired: Note[];
  dropped: Note[];
  /** Positions tried. */
  tries: number;
}

const BUILT_IN_MIN = 0.3;
const SLIDE = 0.6;
const MOVE = 0.4;
const STEP = 0.05;
const NARROW = [0.95, 0.9, 0.85, 0.8];

/** The item for a piece at a pose. */
function itemAt(want: Want, at: Vec2, rotation: number, w: number): Item {
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
function onFace(f: Face, along: number, d: number): { at: Vec2; rotation: number } {
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

const vertical = (want: Want) => {
  const bottom = want.kind.elevation ?? 0;
  return { bottom, top: bottom + want.h };
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
      if (result.item) {
        repaired.push(...result.notes.map(note));
        addToIndex(ix, result.item, want.kind);
        return { item: result.item, repaired, dropped, tries };
      }
      // This wall has no room for it: its notes go, and the next wall is tried.
      repaired.length = before;
      firstWhy ??= result.why;
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

type Repair = ({ item: Item; notes: string[] } | { item: null; why: string }) & { tries: number };

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
  if (!first.length) return { item: at(along, w), notes: [], tries: 0 };
  const why = reasonOf(first[0] as Hit);
  let n = 0;
  for (const s of SLIDES) {
    n++;
    if (!check(along + s, w).length) {
      return {
        item: at(along + s, w),
        notes: [`Moved the ${name} ${Math.abs(s).toFixed(2)} m along the wall to clear ${why}.`],
        tries: n,
      };
    }
  }
  if (want.kind.carpentry) {
    for (const k of NARROW) {
      for (const s of NARROW_SLIDES) {
        n++;
        if (!check(along + s, w * k).length) {
          return {
            item: at(along + s, w * k),
            notes: [`Narrowed the ${name} to ${(w * k).toFixed(2)} m to clear ${why}.`],
            tries: n,
          };
        }
      }
    }
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
  if (!first.length) return { item: make(at, want.rotation, want.w), notes: [], tries: 0 };
  const why = reasonOf(first[0] as Hit);
  let n = 0;
  const tryAt = (p: Vec2, r: number, w: number) => {
    n++;
    return hitsOf(ix, make(p, r, w), want.kind).length === 0;
  };
  for (let s = STEP; s <= MOVE + 1e-9; s += STEP) {
    for (const d of DIRS) {
      const p = { x: at.x + d.x * s, y: at.y + d.y * s };
      if (tryAt(p, want.rotation, want.w)) {
        return {
          item: make(p, want.rotation, want.w),
          notes: [`Moved the ${name} ${s.toFixed(2)} m to clear ${why}.`],
          tries: n,
        };
      }
    }
  }
  if (!fixedSize(want.kind)) {
    const turned = want.rotation + Math.PI / 2;
    for (const s of [0, 0.1, 0.2]) {
      for (const d of s ? DIRS : [DIRS[0] as Vec2]) {
        const p = { x: at.x + d.x * s, y: at.y + d.y * s };
        if (tryAt(p, turned, want.w)) {
          return {
            item: make(p, turned, want.w),
            notes: [`Turned the ${name} to clear ${why}.`],
            tries: n,
          };
        }
      }
    }
  }
  if (want.kind.carpentry || want.kind.id === 'rug') {
    for (const k of NARROW) {
      if (tryAt(at, want.rotation, want.w * k)) {
        return {
          item: make(at, want.rotation, want.w * k),
          notes: [`Narrowed the ${name} to ${(want.w * k).toFixed(2)} m to clear ${why}.`],
          tries: n,
        };
      }
    }
  }
  return { item: null, why: `no room for it here (it would hit ${why})`, tries: n };
}
