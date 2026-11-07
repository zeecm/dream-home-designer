import { CLEARANCE_RULES, doorSweep, ruleSide } from '../clearance';
import { frontReach } from '../clearance-doors';
import { overlapDepth, roomOff, sideOf, zoneOf } from '../convex';
import { type FurnitureKind, furnitureLayer, itemFootprint, itemSize, newItem } from '../furniture';
import { pointInPolygon } from '../geometry';
import type { PlanGeometry } from '../plan';
import { roomShapes } from '../rooms';
import type { Item, Level, Vec2 } from '../schema';
import { fixedSize } from './catalogue';
import { FIT, UNDER_WINDOW, roleOf, windowZones } from './principles';
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
const blocking = (hs: Hit[]) => hs.some((h) => !SOFT.has(h.kind));

const SEAT = /dining-chair|stool|plastic-chair/;
const TABLE = /table|desk|dining-\d/;

interface Placed {
  id: string;
  assetId: string;
  name: string;
  fp: Vec2[];
  box: Box;
  /** The room it needs kept clear to be used. */
  zones: Vec2[][];
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
const shape = (poly: Vec2[]): Shape => ({ poly, box: boxOf(poly) });

/** Everything a piece in one space can run into, and the pieces placed in it so far. */
export interface SpaceIndex {
  rooms: { outer: Vec2[]; holes: Vec2[][] }[];
  solid: Shape[];
  doorways: Shape[];
  sweeps: Shape[];
  /** In front of each window, kept clear above its sill. */
  windows: (Shape & { sill: number })[];
  placed: Placed[];
  /** Ways being kept clear (a walkway a piece narrowed). */
  keepOut: Shape[];
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
  if (hit(ix.keepOut, 0.01)) out.push({ kind: 'keep-out' });
  if (!UNDER_WINDOW.has(roleOf(kind))) {
    const top = (kind.elevation ?? 0) + itemSize(item, kind).h;
    const high = ix.windows.filter((w) => top > w.sill - FIT.sill);
    if (hit(high, 0.01)) out.push({ kind: 'opening', window: true });
  }
  const tuckedWith = (p: Placed) =>
    (SEAT.test(item.assetId) && TABLE.test(p.assetId)) ||
    (SEAT.test(p.assetId) && TABLE.test(item.assetId));
  for (const p of ix.placed) {
    if (apart(p.box, box) || tuckedWith(p)) continue;
    if (overlapDepth(fp, p.fp) > 0.04) {
      out.push({ kind: 'overlap', otherId: p.id, otherName: p.name });
      break;
    }
  }
  if (out.length) return out;
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
    const room = (side: 'front' | 'left' | 'right') => {
      const sd = side === 'front' ? sideOf(fp, side) : ruleSide(fp, side);
      return roomOff(sd, rule.need, near(zoneOf(sd, rule.need))) >= rule.need - 0.005;
    };
    const ok =
      rule.side === 'front'
        ? room('front')
        : rule.side === 'sides'
          ? room('left') && room('right')
          : room('left') || room('right');
    if (!ok) out.push({ kind: 'zone' });
  }
  // Its hinged front (a wardrobe's, the fridge's doors) clear of doors' swings.
  const reach = frontReach(item, fp);
  if (reach && !out.length) {
    const rb = boxOf(reach);
    if (ix.sweeps.some((s) => !apart(s.box, rb) && overlapDepth(reach, s.poly) > 0.02)) {
      out.push({ kind: 'zone' });
    }
  }
  for (const p of ix.placed) {
    if (!p.zones.length || tuckedWith(p)) continue;
    if (p.zones.some((z) => !apart(boxOf(z), box) && overlapDepth(fp, z) > 0.01)) {
      out.push({ kind: 'in-zone', otherId: p.id, otherName: p.name });
      break;
    }
  }
  return out;
}

/** The room a placed piece needs kept clear: in front, or a double bed's two sides. */
function zonesOf(kind: FurnitureKind, fp: Vec2[]): Vec2[][] {
  const rule = CLEARANCE_RULES[kind.id];
  if (!rule || rule.side === 'either-side') return [];
  if (rule.side === 'front') return [zoneOf(sideOf(fp, 'front'), rule.need)];
  return (['left', 'right'] as const).map((s) => zoneOf(ruleSide(fp, s), rule.need));
}

/**
 * The way to keep clear around a walkway's narrow point: the path within 1.5 m of the pinch,
 * as wide as the walkway needs.
 */
export function keepOutOf(path: Vec2[], pinch: [Vec2, Vec2], need: number): Shape[] {
  const mid = { x: (pinch[0].x + pinch[1].x) / 2, y: (pinch[0].y + pinch[1].y) / 2 };
  const h = need / 2;
  const close = (p: Vec2) => Math.hypot(p.x - mid.x, p.y - mid.y) <= 1.5;
  const out: Shape[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const p = path[i] as Vec2;
    const q = path[i + 1] as Vec2;
    if (!close(p) && !close(q)) continue;
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len < 1e-6) continue;
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
export function addToIndex(ix: SpaceIndex, item: Item, kind: FurnitureKind) {
  if (!blocksFloor(kind)) return;
  const fp = itemFootprint(item, kind);
  ix.placed.push({
    id: item.id,
    assetId: item.assetId,
    name: nameOf(kind),
    fp,
    box: boxOf(fp),
    zones: zonesOf(kind, fp),
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
