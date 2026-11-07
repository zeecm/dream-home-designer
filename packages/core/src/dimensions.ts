import type { Bounds } from './geometry';
import { labelClearance, placeLabel, pointInPolygon, signedArea } from './geometry';
import {
  type PlanGeometry,
  type WallFrame,
  doorLeaves,
  doorStyle,
  doorSwing,
  framePoint,
  planGeometry,
  swingZone,
} from './plan';
import { roomShapes } from './rooms';
import type { Level, Room, Vec2 } from './schema';

/**
 * Dimensions for a measured plan, the way a contractor reads one: chains of dimensions
 * outside each side of the flat (openings and the wall between them, the corners, the
 * overall), each room's clear width and depth, and a tag on each door and window with its
 * width. Everything in metres, in plan space (x right, y down).
 */

export type ChainSide = 'top' | 'right' | 'bottom' | 'left';

export interface DimensionChain {
  /** The side of the flat it runs along, or 'aligned' along a slanting outside face. */
  side: ChainSide | 'aligned';
  /**
   * 0: openings and the wall between them; 1: corners (where the outside face turns);
   * 2: overall. An aligned chain is tier 1.
   */
  tier: 0 | 1 | 2;
  /**
   * For a side: the plan coordinate of the flat's outermost face on that side (y for top and
   * bottom, x for left and right); the chain is drawn outside it. For an aligned chain: 0.
   */
  at: number;
  /**
   * Sorted positions along the side (x for top and bottom, y for left and right); for an
   * aligned chain, distances along `line` from its start.
   */
  stops: number[];
  /**
   * For a side: where each stop's face is, across the side (the coordinate `at` measures),
   * for the extension line from it to the chain.
   */
  from: number[];
  /** Aligned only: the outside face, start to end, and the unit normal pointing out. */
  line?: { a: Vec2; b: Vec2; out: Vec2 };
}

/** A room's clear width (along x) or depth (along y), face to face through its label point. */
export interface RoomSpan {
  roomId: string;
  axis: 'x' | 'y';
  a: Vec2;
  b: Vec2;
}

/** A door's or window's tag ("D 900"): its width and where to put it. */
export interface OpeningTag {
  openingId: string;
  kind: 'door' | 'window';
  width: number;
  /** The opening's centre on the wall's centre line. */
  at: Vec2;
  /** Unit normal to the wall, towards the side the tag goes on (clear of a door's swing). */
  out: Vec2;
  /** Half the wall's thickness: the tag goes this far and a little more along `out`. */
  half: number;
}

export interface DimensionOptions {
  /** Half the size of a room's label (metres), to place it in the room: about 1:100 text. */
  labelHalf?: (room: Room) => Vec2;
  /** Half a door or window tag's size (metres), along the wall and across it: labels keep clear. */
  tagHalf?: { along: number; across: number };
  /** More boxes labels keep clear of (centre and half sizes, metres): built-ins, say. */
  avoidBoxes?: { c: Vec2; hx: number; hy: number }[];
  /**
   * Boxes neither labels nor room spans may cross (centre and half sizes, metres): a
   * renovation's hacked walls, say.
   */
  blockBoxes?: { c: Vec2; hx: number; hy: number }[];
  /**
   * The room a span's figure needs (metres): its width with a gap, and its height with a gap.
   * A span through a label needs the width beside the label; one beside it, the height on its
   * far side.
   */
  spanFigure?: { w: number; h: number };
  /** More points the drawing covers (a renovation's hacked walls): the chains go outside them. */
  include?: Vec2[];
}

/**
 * A notch's depth: a recess the flat wraps round (an air-con ledge's slot, say), whose
 * flanks face each other and can't be seen from outside, so no outside chain measures them.
 */
export interface NotchDim {
  /** The inner end (at the notch's back) and the mouth, on the line the depth is drawn on. */
  a: Vec2;
  b: Vec2;
  /** The clear width across the notch, face to face (the narrowest, where it tapers). */
  gap: number;
  /** Which notch: the two dimensions of one notch (one along each flank) share it. */
  notch: number;
  /** Where each flank measured turns at the mouth: an extension line runs from it to `b`. */
  corners: Vec2[];
}

export interface PlanDimensions {
  chains: DimensionChain[];
  /** Notches' depths, measured along their flanks. */
  notches: NotchDim[];
  spans: RoomSpan[];
  tags: OpeningTag[];
  /** Where each room's label goes (the point its spans run through). */
  labels: { roomId: string; at: Vec2 }[];
  /**
   * What the drawing covers: the walls' outline (faces, not centre lines), the boundary lines,
   * door swings and `include`, or null with no walls. The side chains run outside it.
   */
  bounds: Bounds | null;
}

/** Stops closer than this are one. */
const MERGE = 0.005;
/** A wall faces a side when its outside face is within this of square to it. */
const AXIS_TOLERANCE = (1 * Math.PI) / 180;
/** Room spans shorter than this aren't worth a dimension. */
const MIN_SPAN = 0.6;
/** A piece of a chain shorter than this is no figure of its own: it joins its neighbour. */
const MIN_PIECE = 0.02;
/** A room this much of its bounding box or less has no one width and depth (an L, say). */
const RECTISH = 0.95;
/** How far past a face a point is tested for a room or free space. */
const PROBE = 0.05;
/** The half-size of a room label the spans are placed for, in metres (about 1:100 text). */
const LABEL_HALF = { x: 0.6, y: 0.35 };

const SIDE_NORMAL: Record<ChainSide, Vec2> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};
const SIDES: ChainSide[] = ['top', 'right', 'bottom', 'left'];
/** The plan coordinate that runs along a side. */
const along = (side: ChainSide, p: Vec2) => (side === 'top' || side === 'bottom' ? p.x : p.y);

/** A stop along a side, and where its face is across the side. */
interface Stop {
  v: number;
  from: number;
}

/**
 * Sorted, with stops within MERGE of one already kept dropped (the primary ones win); of two
 * that merge, the one whose face is further out (`out` +1 or -1 across the side) gives the
 * extension line, so it is the shorter.
 */
function mergeStops(primary: Stop[], extra: Stop[] = [], out = 1): Stop[] {
  const kept: Stop[] = [];
  const add = (s: Stop) => {
    const k = kept.find((q) => Math.abs(q.v - s.v) < MERGE);
    if (!k) kept.push({ ...s });
    else if (!Number.isNaN(s.from) && (Number.isNaN(k.from) || s.from * out > k.from * out)) {
      k.from = s.from;
    }
  };
  for (const s of [...primary].sort((a, b) => a.v - b.v)) add(s);
  for (const s of [...extra].sort((a, b) => a.v - b.v)) add(s);
  return kept.sort((a, b) => a.v - b.v);
}

/**
 * The stops with each piece under MIN_PIECE joined to its neighbour, so the chain still adds
 * up: of the two stops either side of a small piece, an inner one that isn't `fixed` (a stop
 * of the tier outside it) goes. The ends always stay.
 */
function dropSmall(stops: Stop[], fixed: (s: Stop) => boolean = () => false): Stop[] {
  const out = [...stops];
  let i = 1;
  while (out.length > 2 && i < out.length) {
    const piece = (out[i] as Stop).v - (out[i - 1] as Stop).v;
    if (piece >= MIN_PIECE - 1e-9) {
      i++;
      continue;
    }
    if (i < out.length - 1 && !fixed(out[i] as Stop)) out.splice(i, 1);
    else if (i - 1 > 0 && !fixed(out[i - 1] as Stop)) out.splice(i - 1, 1);
    else i++;
  }
  return out;
}

const sameStops = (a: Stop[], b: Stop[]) =>
  a.length === b.length && a.every((s, i) => Math.abs(s.v - (b[i] as Stop).v) < MERGE);

interface Polys {
  rooms: { outer: Vec2[]; holes: Vec2[][] }[];
  solid: Vec2[][];
}

const inRoom = (p: Vec2, polys: Polys) =>
  polys.rooms.some((s) => pointInPolygon(p, s.outer) && !s.holes.some((h) => pointInPolygon(p, h)));
/** Outside the flat: in no room and in no wall. */
const free = (p: Vec2, polys: Polys) =>
  !inRoom(p, polys) && !polys.solid.some((s) => pointInPolygon(p, s));

/** A stretch of a wall's face with a room behind it and the outside in front. */
interface Stretch {
  frame: WallFrame;
  /** The face that looks out: +1 left, -1 right. */
  side: 1 | -1;
  u0: number;
  u1: number;
}

/** The way a face looks out: square to the side it faces, if within 1° of one, else its normal. */
function lookOf(out: Vec2): { side: ChainSide | null; dir: Vec2 } {
  const side = SIDES.find((k) => {
    const n = SIDE_NORMAL[k];
    return out.x * n.x + out.y * n.y > Math.cos(AXIS_TOLERANCE) - 1e-12;
  });
  return side ? { side, dir: SIDE_NORMAL[side] } : { side: null, dir: out };
}

/** How a point of a face looks out: not at all, seen from outside, or hidden in a notch. */
type Look = 'no' | 'seen' | 'hidden';

/**
 * The stretches of each wall's faces that look outside: the flat (a room or a wall) just
 * behind the other face (measured where that face runs, so a corner's mitre still counts)
 * and free space just in front. `seen` are those that can be seen from outside, with nothing
 * of the flat further out the way they look (a face in a notch, hidden behind another part
 * of the flat, isn't dimensioned from outside). `facing` are the whole runs that look out,
 * seen or not, with how much of each is hidden. Found by sampling every 2 cm, each change
 * refined to a fraction of a millimetre.
 */
function outsideStretches(
  geom: PlanGeometry,
  polys: Polys,
  segs: Seg[],
): { seen: Stretch[]; facing: Facing[] } {
  const out: Stretch[] = [];
  const facing: Facing[] = [];
  const lines = boundarySegs(geom);
  /** Within `d` of a boundary line: a room closed by it is just there, past a wall's end. */
  const byBoundary = (p: Vec2, d: number) =>
    lines.some(([a, b]) => segDistance(p, a, b) <= d + 1e-6);
  for (const [wallId, f] of Object.entries(geom.frames)) {
    if (geom.boundaries.includes(wallId)) continue;
    for (const side of [1, -1] as const) {
      const face = side === 1 ? f.left : f.right;
      const back = side === 1 ? f.right : f.left;
      const [s0, s1] = face;
      if (s1 - s0 < 0.05) continue;
      const { dir } = lookOf({ x: f.n.x * side, y: f.n.y * side });
      const look = (u: number): Look => {
        const p = framePoint(f, u, side);
        const front = { x: p.x + f.n.x * side * PROBE, y: p.y + f.n.y * side * PROBE };
        const ub = Math.min(Math.max(u, back[0] + 0.01), back[1] - 0.01);
        const q = framePoint(f, ub, -side);
        const behind = { x: q.x - f.n.x * side * PROBE, y: q.y - f.n.y * side * PROBE };
        const outward =
          free(front, polys) &&
          // A face beside a room closed by a boundary (a terrace past the walls) is inside
          // that room, as far as the wall's half thickness goes past the room's line.
          !byBoundary(front, f.half) &&
          !free(behind, polys);
        if (!outward) return 'no';
        return rayHit(front, dir, segs) === Number.POSITIVE_INFINITY ? 'seen' : 'hidden';
      };
      const n = Math.max(2, Math.ceil((s1 - s0) / 0.02));
      const at = (i: number) => s0 + ((s1 - s0) * i) / n;
      const looks = Array.from({ length: n + 1 }, (_, i) => look(at(i)));
      /** The runs where `pred` holds, each end refined between the samples either side. */
      const runs = (pred: (l: Look) => boolean): [number, number][] => {
        const found: [number, number][] = [];
        const edge = (from: number, to: number, startsIn: boolean) => {
          let lo = from;
          let hi = to;
          for (let k = 0; k < 14; k++) {
            const m = (lo + hi) / 2;
            if (pred(look(m)) === startsIn) lo = m;
            else hi = m;
          }
          return (lo + hi) / 2;
        };
        let start: number | null = null;
        let prev = pred(looks[0] as Look);
        if (prev) start = s0;
        for (let i = 1; i <= n; i++) {
          const cur = pred(looks[i] as Look);
          if (cur !== prev) {
            const e = edge(at(i - 1), at(i), prev);
            if (cur) start = e;
            else if (start !== null) {
              if (e - start > 0.05) found.push([start, e]);
              start = null;
            }
          }
          prev = cur;
        }
        if (start !== null && s1 - start > 0.05) found.push([start, s1]);
        return found;
      };
      const seen = runs((l) => l === 'seen');
      for (const [u0, u1] of seen) out.push({ frame: f, side, u0, u1 });
      for (const [u0, u1] of runs((l) => l !== 'no')) {
        // Its hidden part: from the first gap between seen parts to the last.
        const inside = seen.filter(([p, q]) => p >= u0 - 1e-9 && q <= u1 + 1e-9);
        const gaps: [number, number][] = [];
        let from = u0;
        for (const [p, q] of inside) {
          gaps.push([from, p]);
          from = q;
        }
        gaps.push([from, u1]);
        const hid = gaps.filter(([p, q]) => q - p > 0.05);
        const first = hid[0];
        const last = hid[hid.length - 1];
        const hidden: [number, number] | null = first && last ? [first[0], last[1]] : null;
        facing.push({ frame: f, side, u0, u1, hidden });
      }
    }
  }
  return { seen: out, facing };
}

/** A run of face that looks out, and the part of it hidden from outside (or null), as `u`. */
type Facing = Stretch & { hidden: [number, number] | null };

type Seg = [Vec2, Vec2];

/** The boundary lines (rooms divided or closed without a wall), end to end. */
function boundarySegs(geom: PlanGeometry): Seg[] {
  return geom.boundaries.flatMap((id) => {
    const f = geom.frames[id];
    return f ? [[framePoint(f, 0, 0), framePoint(f, f.length, 0)] as Seg] : [];
  });
}

function segDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function boundsOf(all: readonly Vec2[]): Bounds | null {
  if (all.length === 0) return null;
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  return {
    min: { x: Math.min(...xs), y: Math.min(...ys) },
    max: { x: Math.max(...xs), y: Math.max(...ys) },
  };
}

/**
 * Bounds of every wall piece, junction and opening and the boundary lines' ends (a terrace
 * closed by a boundary past the walls), and of `include`: the flat's outline, face to face.
 */
export function outlineBounds(geom: PlanGeometry, include: readonly Vec2[] = []): Bounds | null {
  const walls = [
    ...geom.pieces.map((p) => p.polygon),
    ...geom.footprints.hubs.map((h) => h.polygon),
    ...geom.openings.map((o) => o.polygon),
  ].flat();
  if (walls.length === 0) return null;
  return boundsOf([...walls, ...boundarySegs(geom).flat(), ...include]);
}

/** Where each door's leaves reach, open: a door opening out of the flat reaches past it. */
function doorReach(geom: PlanGeometry): Vec2[] {
  return geom.openings.flatMap((o) => {
    if (o.kind !== 'door') return [];
    const style = doorStyle(o.opening);
    if (style === 'swing') {
      const s = doorSwing(o.frame, o.opening);
      // The arc's middle, too: it bulges past its ends on a slanting wall.
      const m = {
        x: s.leafEnd.x + s.arcEnd.x - 2 * s.hinge.x,
        y: s.leafEnd.y + s.arcEnd.y - 2 * s.hinge.y,
      };
      const k = s.radius / (Math.hypot(m.x, m.y) || 1);
      return [s.hinge, s.leafEnd, s.arcEnd, { x: s.hinge.x + m.x * k, y: s.hinge.y + m.y * k }];
    }
    if (style === 'sliding' || style === 'pocket') return [];
    return doorLeaves(o.frame, o.opening, style === 'double' ? 1 : 0.5).flatMap((l) => [l.a, l.b]);
  });
}

/**
 * What a measured drawing of the plan covers: its outline (`outlineBounds`, with `include`)
 * and the door swings, so the dimensions outside clear a door that opens out.
 */
export function planExtent(geom: PlanGeometry, include: readonly Vec2[] = []): Bounds | null {
  const b = outlineBounds(geom, include);
  if (!b) return null;
  return boundsOf([b.min, b.max, ...doorReach(geom)]);
}

/** Where a ray from p first meets a segment, as a distance along it, or Infinity. */
function rayHit(p: Vec2, d: Vec2, segs: readonly Seg[]): number {
  return rayHitPoint(p, d, segs).t;
}

/** Where a ray from p first meets a segment: the distance along it and the point (or Infinity, null). */
function rayHitPoint(p: Vec2, d: Vec2, segs: readonly Seg[]): { t: number; at: Vec2 | null } {
  let best = Number.POSITIVE_INFINITY;
  for (const [a, b] of segs) {
    const e = { x: b.x - a.x, y: b.y - a.y };
    const den = d.x * e.y - d.y * e.x;
    if (Math.abs(den) < 1e-12) continue;
    const w = { x: a.x - p.x, y: a.y - p.y };
    const t = (w.x * e.y - w.y * e.x) / den;
    const s = (w.x * d.y - w.y * d.x) / den;
    if (t > 1e-6 && s >= -1e-9 && s <= 1 + 1e-9 && t < best) best = t;
  }
  return {
    t: best,
    at: Number.isFinite(best) ? { x: p.x + d.x * best, y: p.y + d.y * best } : null,
  };
}

/** Notch flanks shorter than this get no depth. */
const MIN_NOTCH = 0.1;
/** A flank's hit on another lies on its face within this. */
const ON_FACE = 0.001;
/** How far past a flank's end the probe for the mouth goes. */
const PAST_END = 0.02;

/**
 * A flank: a run of face that looks out, from a to b (in a fixed turn from `out`, so two
 * runs in line go the same way), and its hidden part as distances from a.
 */
interface Flank {
  a: Vec2;
  b: Vec2;
  out: Vec2;
  hidden: [number, number];
}

const sub = (p: Vec2, q: Vec2): Vec2 => ({ x: p.x - q.x, y: p.y - q.y });
const dot = (p: Vec2, q: Vec2) => p.x * q.x + p.y * q.y;
const offset = (p: Vec2, d: Vec2, k: number): Vec2 => ({ x: p.x + d.x * k, y: p.y + d.y * k });
const dist = (p: Vec2, q: Vec2) => Math.hypot(q.x - p.x, q.y - p.y);
const unit = (p: Vec2): Vec2 => {
  const l = Math.hypot(p.x, p.y) || 1;
  return { x: p.x / l, y: p.y / l };
};

/**
 * The runs of face that look out with a part hidden, as flanks; runs in line end to end on
 * two walls (where a wall meets the flank from behind) are one.
 */
function flanksOf(facing: Facing[], polys: Polys): Flank[] {
  const list = facing.flatMap((s): Flank[] => {
    if (!s.hidden) return [];
    const out = { x: s.frame.n.x * s.side, y: s.frame.n.y * s.side };
    const p = framePoint(s.frame, s.u0, s.side);
    const q = framePoint(s.frame, s.u1, s.side);
    const [h0, h1] = s.hidden;
    const len = s.u1 - s.u0;
    return dot(sub(q, p), { x: out.y, y: -out.x }) >= 0
      ? [{ a: p, b: q, out, hidden: [h0 - s.u0, h1 - s.u0] }]
      : [{ a: q, b: p, out, hidden: [len - (h1 - s.u0), len - (h0 - s.u0)] }];
  });
  // Every run that looks out, to join a flank to the run in line with it.
  const all = facing.map((s) => {
    const p = framePoint(s.frame, s.u0, s.side);
    const q = framePoint(s.frame, s.u1, s.side);
    return { p, q, out: { x: s.frame.n.x * s.side, y: s.frame.n.y * s.side } };
  });
  const cos = Math.cos(AXIS_TOLERANCE);
  /** Where the face goes on from `end` along `t`: a run in line just past it, through a joint. */
  const next = (end: Vec2, t: Vec2, out: Vec2) => {
    for (const r of all) {
      if (dot(r.out, out) < cos - 1e-12) continue;
      for (const [s, e] of [
        [r.p, r.q],
        [r.q, r.p],
      ] as const) {
        const along = dot(sub(s, end), t);
        if (Math.abs(dot(sub(s, end), out)) > MERGE || along < -MERGE || along > 0.4) continue;
        if (dot(sub(e, s), t) <= 0) continue;
        // The face goes on between them: free in front, the flat behind.
        const mid = { x: (end.x + s.x) / 2, y: (end.y + s.y) / 2 };
        if (!free(offset(mid, out, PROBE), polys) || free(offset(mid, out, -PROBE), polys))
          continue;
        return e;
      }
    }
    return null;
  };
  // Each flank carried on, both ways, along runs in line (seen ones, too: it turns there).
  for (const f of list) {
    const t = unit(sub(f.b, f.a));
    for (let k = 0, e = next(f.b, t, f.out); e && k < 8; k++, e = next(f.b, t, f.out)) f.b = e;
    const back = { x: -t.x, y: -t.y };
    for (let k = 0, e = next(f.a, back, f.out); e && k < 8; k++, e = next(f.a, back, f.out)) {
      const grow = dist(f.a, e);
      f.a = e;
      f.hidden = [f.hidden[0] + grow, f.hidden[1] + grow];
    }
  }
  // A flank found twice (hidden on two of its walls): the hidden parts together.
  const kept: Flank[] = [];
  for (const f of list) {
    const same = kept.find((g) => dist(g.a, f.a) < MERGE && dist(g.b, f.b) < MERGE);
    if (!same) kept.push(f);
    else
      same.hidden = [Math.min(same.hidden[0], f.hidden[0]), Math.max(same.hidden[1], f.hidden[1])];
  }
  return kept;
}

/**
 * Notches' depths. A flank is a run of face that looks out with a part of it hidden (its
 * front ray meets the flat), and its gap the shortest of those rays. It runs on to where the
 * face turns, unless the face goes on in view for more than the gap (a long outside wall
 * past the notch, measured on the side chain): then it stops where the face comes into view.
 * Probed just past each end, a little in front (5 cm, or `gap / 2` if less): free space is
 * its mouth, the flat its inner end. Neither (a shaft or closed slot) or both (a slot right through) give no depth. Two
 * flanks face each other when each one's rays land on the other's face; paired by the most
 * overlap. Facing within 1°, with ends that agree within 5 mm: one depth on the centre line
 * between them. Otherwise (mouths that differ, or a taper), one along each flank, `gap / 4`
 * out from its face; a flank on its own, `gap / 2` out. Flanks under 0.10 m are left out.
 */
function notchDims(facing: Facing[], polys: Polys, segs: Seg[]): NotchDim[] {
  /** The rays from a face between distances `from` and `to` along it: hit points and the nearest. */
  const rays = (f: Flank, from: number, to: number) => {
    const t = unit(sub(f.b, f.a));
    const n = Math.max(4, Math.ceil((to - from) / 0.01));
    const hits: Vec2[] = [];
    let near = Number.POSITIVE_INFINITY;
    for (let i = 0; i <= n; i++) {
      // Just inside the ends: a ray from a corner can graze the wall it turns into.
      const d = from + 0.005 + ((to - from - 0.01) * i) / n;
      const h = rayHitPoint(offset(offset(f.a, t, d), f.out, 0.001), f.out, segs);
      if (!h.at) continue;
      hits.push(h.at);
      near = Math.min(near, h.t + 0.001);
    }
    return { hits, near, step: (to - from) / n };
  };
  const flanks = flanksOf(facing, polys).flatMap((f) => {
    const len = dist(f.a, f.b);
    const [h0, h1] = f.hidden;
    const gap = rays(f, h0, h1).near;
    if (!Number.isFinite(gap)) return [];
    const t = unit(sub(f.b, f.a));
    const d0 = h0 > gap ? h0 : 0;
    const d1 = len - h1 > gap ? h1 : len;
    if (d1 - d0 < MIN_NOTCH) return [];
    const a = offset(f.a, t, d0);
    const b = offset(f.a, t, d1);
    // Close in front (a probe out in the middle of a tapered notch could miss its back).
    const ahead = Math.min(gap / 2, PROBE);
    const freeAt = (end: Vec2, k: number) => free(offset(offset(end, t, k), f.out, ahead), polys);
    const freeA = freeAt(a, -PAST_END);
    const freeB = freeAt(b, PAST_END);
    if (freeA === freeB) return [];
    const [inner, mouth] = freeA ? [b, a] : [a, b];
    const face = { a, b };
    const { hits, step } = rays(f, d0, d1);
    return [{ inner, mouth, out: f.out, gap, hits, step, face }];
  });
  type F = (typeof flanks)[number];
  const landsOn = (x: F, y: F) =>
    x.hits.filter((h) => segDistance(h, y.face.a, y.face.b) <= ON_FACE + 1e-9).length * x.step;
  const pairs: { x: F; y: F; overlap: number }[] = [];
  for (let i = 0; i < flanks.length; i++) {
    for (let j = i + 1; j < flanks.length; j++) {
      const x = flanks[i] as F;
      const y = flanks[j] as F;
      const overlap = Math.min(landsOn(x, y), landsOn(y, x));
      if (overlap > 0) pairs.push({ x, y, overlap });
    }
  }
  pairs.sort((p, q) => q.overlap - p.overlap);
  const used = new Set<F>();
  const dims: NotchDim[] = [];
  let notch = 0;
  const along = (x: F, k: number): NotchDim => ({
    a: offset(x.inner, x.out, x.gap * k),
    b: offset(x.mouth, x.out, x.gap * k),
    gap: x.gap,
    notch,
    corners: [x.mouth],
  });
  for (const { x, y } of pairs) {
    if (used.has(x) || used.has(y)) continue;
    used.add(x);
    used.add(y);
    const d = unit(sub(x.mouth, x.inner));
    const len = dist(x.inner, x.mouth);
    const facingEach = dot(x.out, y.out) < -Math.cos(AXIS_TOLERANCE) + 1e-12;
    const agree =
      Math.abs(dot(sub(y.inner, x.inner), d)) < MERGE &&
      Math.abs(dot(sub(y.mouth, x.inner), d) - len) < MERGE;
    if (facingEach && agree) {
      const gap = Math.min(x.gap, y.gap);
      dims.push({
        a: offset(x.inner, x.out, gap / 2),
        b: offset(x.mouth, x.out, gap / 2),
        gap,
        notch,
        corners: [x.mouth, y.mouth],
      });
    } else {
      dims.push(along(x, 1 / 4), along(y, 1 / 4));
    }
    notch++;
  }
  for (const x of flanks) {
    if (used.has(x)) continue;
    dims.push(along(x, 1 / 2));
    notch++;
  }
  return dims;
}

const edgesOf = (poly: readonly Vec2[]): Seg[] =>
  poly.map((p, i) => [p, poly[(i + 1) % poly.length] as Vec2]);

/** A box: centre and half sizes (metres). */
interface Box {
  c: Vec2;
  hx: number;
  hy: number;
}

const boxesOverlap = (p: Vec2, half: Vec2, b: Box) =>
  Math.abs(p.x - b.c.x) < half.x + b.hx && Math.abs(p.y - b.c.y) < half.y + b.hy;

/** Whether the segment a–b crosses the box (Liang–Barsky clipping). */
function segmentHitsBox(a: Vec2, b: Vec2, box: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const d = { x: b.x - a.x, y: b.y - a.y };
  const clip = (p: number, q: number) => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return (
    clip(-d.x, a.x - (box.c.x - box.hx)) &&
    clip(d.x, box.c.x + box.hx - a.x) &&
    clip(-d.y, a.y - (box.c.y - box.hy)) &&
    clip(d.y, box.c.y + box.hy - a.y) &&
    t1 - t0 > 1e-9
  );
}

/** Whether segments a–b and c–d cross, or come within `gap` of each other. */
function segmentsNear(a: Vec2, b: Vec2, c: Vec2, d: Vec2, gap: number): boolean {
  const cr = (o: Vec2, p: Vec2, q: Vec2) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  if (cr(c, d, a) * cr(c, d, b) < 0 && cr(a, b, c) * cr(a, b, d) < 0) return true;
  return (
    Math.min(
      segDistance(a, c, d),
      segDistance(b, c, d),
      segDistance(c, a, b),
      segDistance(d, a, b),
    ) < gap
  );
}

/** How far a circle reaches into a box (centre, half sizes): 0 if clear. */
function intrusion(p: Vec2, half: Vec2, c: { c: Vec2; r: number }): number {
  const ox = Math.abs(c.c.x - p.x) - half.x;
  const oy = Math.abs(c.c.y - p.y) - half.y;
  if (ox > 0 || oy > 0) return Math.max(0, c.r - Math.hypot(Math.max(ox, 0), Math.max(oy, 0)));
  return c.r - Math.max(ox, oy);
}

/** Whether a box (centre, half sizes) and a polygon overlap. */
function boxHitsPolygon(c: Vec2, half: Vec2, poly: readonly Vec2[]): boolean {
  const box = { c, hx: half.x, hy: half.y };
  if (poly.some((p) => Math.abs(p.x - c.x) < half.x && Math.abs(p.y - c.y) < half.y)) return true;
  if (pointInPolygon(c, poly)) return true;
  return edgesOf(poly).some(([a, b]) => segmentHitsBox(a, b, box));
}

/**
 * The plan's dimensions. Outside walls (a room on one side only, measured along each face,
 * and only where the face can be seen from outside: not in a notch behind another part of
 * the flat) within 1° of square to an axis join the side they face: tier 1 stops at the ends of each
 * run of outside face (where it turns a corner or steps), tier 0 adds each opening's edges,
 * tier 2 is the overall. Stops within 5 mm are one, and a tier the same as the next is left
 * out. A slanting outside face gets an aligned chain of its own, and its ends are stops on
 * both sides it lies between. Each room's clear width and depth are measured from its
 * label point to the nearest face or room boundary, left out under 0.6 m. Doors and
 * windows get tags.
 */
export function planDimensions(
  level: Level,
  geom: PlanGeometry = planGeometry(level),
  opts: DimensionOptions = {},
): PlanDimensions {
  const shapes = [...roomShapes(level).values()];
  const polys: Polys = {
    rooms: shapes.filter((s) => s.outer.length >= 3),
    solid: [
      ...geom.pieces.map((p) => p.polygon),
      ...geom.footprints.hubs.map((h) => h.polygon),
      ...geom.openings.map((o) => o.polygon),
    ],
  };
  const bounds = planExtent(geom, opts.include);
  const chains: DimensionChain[] = [];
  const solidSegs = polys.solid.flatMap(edgesOf);
  /** Whether a face point can be seen from outside, looking back along `dir` (or just beside it). */
  const seen = (p: Vec2, dir: Vec2) =>
    [0, 0.002, -0.002].some((k) => {
      const q = { x: p.x + dir.x * 0.001 - dir.y * k, y: p.y + dir.y * 0.001 + dir.x * k };
      return rayHit(q, dir, solidSegs) === Number.POSITIVE_INFINITY;
    });

  // Runs of outside face per side, and the openings' edges on them.
  const runs: Record<ChainSide, { at: number; from: number; to: number }[]> = {
    top: [],
    right: [],
    bottom: [],
    left: [],
  };
  const corners: Record<ChainSide, Stop[]> = { top: [], right: [], bottom: [], left: [] };
  const edges: Record<ChainSide, Stop[]> = { top: [], right: [], bottom: [], left: [] };
  const across = (side: ChainSide, p: Vec2) => (side === 'top' || side === 'bottom' ? p.y : p.x);
  const stopAt = (side: ChainSide, p: Vec2): Stop => ({
    v: along(side, p),
    // A stop out of sight (an opening's edge in a notch, say) gets no extension line to it.
    from: seen(p, SIDE_NORMAL[side]) ? across(side, p) : Number.NaN,
  });
  const sinTol = Math.sin(AXIS_TOLERANCE);

  const stretches = outsideStretches(geom, polys, solidSegs);
  for (const s of stretches.seen) {
    const f = s.frame;
    const outN = { x: f.n.x * s.side, y: f.n.y * s.side };
    const a = framePoint(f, s.u0, s.side);
    const b = framePoint(f, s.u1, s.side);
    const holes = geom.openings
      .filter((o) => o.wallId === f.wall.id)
      .filter((o) => {
        const c = (o.span[0] + o.span[1]) / 2;
        return c > s.u0 && c < s.u1;
      });
    const { side } = lookOf(outN);
    if (side) {
      const perp = side === 'top' || side === 'bottom' ? a.y : a.x;
      const [p, q] = [along(side, a), along(side, b)].sort((m, n) => m - n) as [number, number];
      runs[side].push({ at: perp, from: p, to: q });
      for (const o of holes) {
        for (const u of o.span) edges[side].push(stopAt(side, framePoint(f, u, s.side)));
      }
      continue;
    }
    // A slanting face: its own chain, and its ends are corners on the sides it lies between.
    const len = s.u1 - s.u0;
    const stops = mergeStops(
      [0, len].map((v) => ({ v, from: 0 })),
      holes.flatMap((o) => o.span.map((u) => ({ v: u - s.u0, from: 0 }))),
    );
    chains.push({
      side: 'aligned',
      tier: 1,
      at: 0,
      stops: stops.map((x) => x.v),
      from: stops.map(() => 0),
      line: { a, b, out: outN },
    });
    for (const k of SIDES) {
      const n = SIDE_NORMAL[k];
      if (outN.x * n.x + outN.y * n.y > sinTol) corners[k].push(stopAt(k, a), stopAt(k, b));
    }
  }

  for (const side of SIDES) {
    const list = [...runs[side]].sort((p, q) => p.from - q.from);
    if (list.length === 0 || !bounds) continue;
    // Faces in line and end to end are one run: no corner between them.
    const merged: { at: number; from: number; to: number }[] = [];
    for (const r of list) {
      const last = merged.find((m) => Math.abs(m.at - r.at) < MERGE && r.from <= m.to + MERGE);
      if (last) last.to = Math.max(last.to, r.to);
      else merged.push({ ...r });
    }
    const out = side === 'top' || side === 'left' ? -1 : 1;
    const tier1 = dropSmall(
      mergeStops(
        [
          ...merged.flatMap((r) => [
            { v: r.from, from: r.at },
            { v: r.to, from: r.at },
          ]),
          ...corners[side],
        ],
        [],
        out,
      ),
    );
    const isCorner = (x: Stop) => tier1.some((c) => Math.abs(c.v - x.v) < MERGE);
    const tier0 = dropSmall(mergeStops(tier1, edges[side], out), isCorner);
    const tier2 = [tier1[0] as Stop, tier1[tier1.length - 1] as Stop];
    const at =
      side === 'top'
        ? bounds.min.y
        : side === 'bottom'
          ? bounds.max.y
          : side === 'left'
            ? bounds.min.x
            : bounds.max.x;
    const push = (tier: 0 | 1 | 2, st: Stop[]) =>
      chains.push({
        side,
        tier,
        at,
        stops: st.map((x) => x.v),
        from: st.map((x) => (Number.isNaN(x.from) ? at : x.from)),
      });
    if (!sameStops(tier0, tier1)) push(0, tier0);
    if (!sameStops(tier1, tier2)) push(1, tier1);
    push(2, tier2);
  }

  // Door and window tags, on the side away from a door's swing (or into the room, for a
  // window in an outside wall, clear of the dimension chains).
  const tags: OpeningTag[] = [];
  for (const o of geom.openings) {
    if (o.kind === 'passage') continue;
    const f = o.frame;
    const u = (o.span[0] + o.span[1]) / 2;
    const c = framePoint(f, u, 0);
    let k = 1;
    if (o.kind === 'door') k = (o.opening.swing ?? 'leftIn').endsWith('In') ? -1 : 1;
    else {
      const probe = (s: number) => ({
        x: c.x + f.n.x * s * (f.half + PROBE),
        y: c.y + f.n.y * s * (f.half + PROBE),
      });
      // Into the room, for a window in an outside wall; between two rooms, into the larger,
      // which has more room to keep its label clear of the tag.
      const areaAt = (q: Vec2) => {
        const r = polys.rooms.find((x) => pointInPolygon(q, x.outer));
        return r ? Math.abs(signedArea(r.outer)) : -1;
      };
      k = areaAt(probe(1)) >= areaAt(probe(-1)) ? 1 : -1;
    }
    tags.push({
      openingId: o.opening.id,
      kind: o.kind,
      // As the chains have it: the opening as it fits its wall.
      width: o.span[1] - o.span[0],
      at: c,
      out: { x: f.n.x * k, y: f.n.y * k },
      half: f.half,
    });
  }

  // Room labels, clear of door swings, walls, hacked walls and the tags (as boxes: a tag is
  // long and thin, and placeLabel's circles are tested only at a label's corners and edge
  // middles).
  const swings = geom.openings
    .filter((o) => o.kind === 'door')
    .map((o) => swingZone(doorSwing(o.frame, o.opening)));
  const tagHalf = opts.tagHalf ?? { along: 0.32, across: 0.12 };
  const boxOf = (t: OpeningTag): Box => {
    const off = t.half + tagHalf.across;
    const c = { x: t.at.x + t.out.x * off, y: t.at.y + t.out.y * off };
    // Along the wall is square to `out`.
    const ax = Math.abs(t.out.y) * tagHalf.along + Math.abs(t.out.x) * tagHalf.across;
    const ay = Math.abs(t.out.x) * tagHalf.along + Math.abs(t.out.y) * tagHalf.across;
    return { c, hx: ax, hy: ay };
  };
  // Door leaves, open: a label keeps off them, and a span may cross a swing's arc, not its leaf.
  const leaves: Seg[] = geom.openings.flatMap((o): Seg[] => {
    if (o.kind !== 'door') return [];
    const style = doorStyle(o.opening);
    if (style === 'swing') {
      const sw = doorSwing(o.frame, o.opening);
      return [[sw.hinge, sw.leafEnd]];
    }
    if (style === 'sliding' || style === 'pocket') return [];
    return doorLeaves(o.frame, o.opening, style === 'double' ? 1 : 0.5).map((l): Seg => [l.a, l.b]);
  });
  const blocks = opts.blockBoxes ?? [];
  const tagBoxes = [...tags.map(boxOf), ...(opts.avoidBoxes ?? []), ...blocks];
  const onLeaf = (p: Vec2, half: Vec2) =>
    leaves.some(([a, b]) => segmentHitsBox(a, b, { c: p, hx: half.x, hy: half.y }));
  const onWall = (p: Vec2, half: Vec2) =>
    polys.solid.some((poly) => boxHitsPolygon(p, half, poly)) || onLeaf(p, half);
  const blocked = (p: Vec2, half: Vec2) =>
    tagBoxes.some((b) => boxesOverlap(p, half, b)) || onWall(p, half);
  /** How much of a label box tags and other boxes cover (m²). */
  const covered = (p: Vec2, half: Vec2) =>
    tagBoxes.reduce((sum, b) => {
      const ox = Math.min(p.x + half.x, b.c.x + b.hx) - Math.max(p.x - half.x, b.c.x - b.hx);
      const oy = Math.min(p.y + half.y, b.c.y + b.hy) - Math.max(p.y - half.y, b.c.y - b.hy);
      return ox > 0 && oy > 0 ? sum + ox * oy : sum;
    }, 0);
  /**
   * placeLabel's spot, or if a tag, a box or a wall (a wall's face is half its thickness inside
   * the room's centre-line outline) is in the way, the nearest spot on a grid that is clear of
   * them (and fits as placeLabel's must), or, with none clear, the least covered.
   */
  const place = (outer: Vec2[], half: Vec2, holes: Vec2[][]) => {
    const home = placeLabel(outer, half, swings, holes);
    if (!blocked(home, half)) return home;
    const xs = outer.map((p) => p.x);
    const ys = outer.map((p) => p.y);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const w = Math.max(...xs) - x0;
    const h = Math.max(...ys) - y0;
    // A hacked wall weighs most, then tags and boxes, then a wall or door leaf or poking out
    // of the room, then a door's swing, then the way from placeLabel's spot.
    const score = (p: Vec2) =>
      (blocks.some((b) => boxesOverlap(p, half, b)) ? 50 : 0) +
      (tagBoxes.some((b) => boxesOverlap(p, half, b)) ? 30 : 0) +
      covered(p, half) * 100 +
      (polys.solid.some((poly) => boxHitsPolygon(p, half, poly)) ? 20 : 0) +
      (onLeaf(p, half) ? 20 : 0) +
      Math.max(0, -labelClearance(p, half, outer, [], holes)) * 100 +
      swings.reduce((sum, c) => sum + intrusion(p, half, c), 0) * 30 +
      Math.hypot(p.x - home.x, p.y - home.y) * 0.1;
    let best = home;
    let bestScore = score(home);
    for (let i = 0; i <= 24; i++) {
      for (let j = 0; j <= 24; j++) {
        const p = { x: x0 + (w * i) / 24, y: y0 + (h * j) / 24 };
        if (!pointInPolygon(p, outer)) continue;
        const sc = score(p);
        if (sc < bestScore) {
          bestScore = sc;
          best = p;
        }
      }
    }
    return best;
  };
  const labels: { roomId: string; at: Vec2 }[] = [];
  const placed: { c: Vec2; half: Vec2; roomId: string }[] = [];
  const shapeOf = roomShapes(level);
  for (const r of Object.values(level.rooms)) {
    const shape = shapeOf.get(r.id);
    if (!shape || shape.outer.length < 3) continue;
    const half = opts.labelHalf?.(r) ?? LABEL_HALF;
    const p = place(shape.outer, half, shape.holes);
    labels.push({ roomId: r.id, at: p });
    placed.push({ c: p, half, roomId: r.id });
  }

  // A tag on a label (one that had no room to keep clear of it) or on a built-in goes to the
  // other side of its wall, if that side is clear.
  const others = (opts.avoidBoxes ?? []).map((b) => ({ c: b.c, half: { x: b.hx, y: b.hy } }));
  const onLabel = (b: Box) => [...placed, ...others].some((l) => boxesOverlap(l.c, l.half, b));
  for (const t of tags) {
    if (!onLabel(boxOf(t))) continue;
    const flipped = { ...t, out: { x: -t.out.x, y: -t.out.y } };
    if (!onLabel(boxOf(flipped))) t.out = flipped.out;
  }

  // Each room's clear width and depth, face to face: through its label, or if a tag, a door's
  // leaf or a hacked wall is in the way (or the label leaves its figure no room), on the
  // nearest line beside the label that is clear, with room for its figure on its far side;
  // with none, no span. A room much less than its bounding box (an L, say) has no one width
  // and depth: none.
  const segs: Seg[] = [...solidSegs, ...boundarySegs(geom)];
  const spanBoxes = [...tags.map(boxOf), ...blocks];
  const fig = opts.spanFigure ?? { w: 0, h: 0 };
  const spans: RoomSpan[] = [];
  for (const { c: p, half, roomId } of placed) {
    const shape = shapeOf.get(roomId);
    if (!shape) continue;
    const box = boundsOf(shape.outer);
    if (!box) continue;
    const area =
      Math.abs(signedArea(shape.outer)) -
      shape.holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0);
    const boxArea = (box.max.x - box.min.x) * (box.max.y - box.min.y);
    if (area < RECTISH * boxArea) continue;
    for (const axis of ['x', 'y'] as const) {
      const d = axis === 'x' ? { x: 1, y: 0 } : { x: 0, y: 1 };
      // Square to the span: y for a width, x for a depth.
      const across = axis === 'x' ? { x: 0, y: 1 } : { x: 1, y: 0 };
      const halfAlong = axis === 'x' ? half.x : half.y;
      const clearOfLabel = (axis === 'x' ? half.y : half.x) + 0.12;
      const lo = axis === 'x' ? box.min.y : box.min.x;
      const hi = axis === 'x' ? box.max.y : box.max.x;
      const at0 = axis === 'x' ? p.y : p.x;
      const offsets = [0];
      for (let k = 0; clearOfLabel + k * 0.1 < hi - lo; k++) {
        offsets.push(clearOfLabel + k * 0.1, -(clearOfLabel + k * 0.1));
      }
      // In this room (not the next one through a wall), and on no wall or door leaf.
      const inside = (q: Vec2) =>
        pointInPolygon(q, shape.outer) &&
        !shape.holes.some((h) => pointInPolygon(q, h)) &&
        !onWall(q, { x: 0.001, y: 0.001 });
      // A line beside the label keeps clear of the walls either side, by more than its figure.
      const roomy = (q: Vec2) => {
        const k = fig.h * 1.5;
        return [k, -k].every((m) => inside({ x: q.x + across.x * m, y: q.y + across.y * m }));
      };
      const span = (q: Vec2) => {
        const fwd = rayHit(q, d, segs);
        const back = rayHit(q, { x: -d.x, y: -d.y }, segs);
        if (!Number.isFinite(fwd) || !Number.isFinite(back)) return null;
        return {
          fwd,
          back,
          a: { x: q.x - d.x * back, y: q.y - d.y * back },
          b: { x: q.x + d.x * fwd, y: q.y + d.y * fwd },
        };
      };
      const find = () => {
        for (const off of offsets) {
          if (at0 + off <= lo || at0 + off >= hi) continue;
          const q = { x: p.x + across.x * off, y: p.y + across.y * off };
          if (!inside(q) || (off !== 0 && !roomy(q))) continue;
          const sp = span(q);
          if (!sp || sp.fwd + sp.back < MIN_SPAN) continue;
          const { a, b } = sp;
          const hits = (u: Vec2, v: Vec2) =>
            spanBoxes.some((bx) => segmentHitsBox(u, v, bx)) ||
            leaves.some(([l0, l1]) => segmentsNear(u, v, l0, l1, 0.03));
          if (hits(a, b)) continue;
          if (off === 0) {
            // Through the label: its figure goes beside the label, on the longer side.
            if (Math.max(sp.fwd, sp.back) - halfAlong < fig.w) continue;
          } else {
            // Beside it: the figure on the far side, inside the room and clear.
            if (sp.fwd + sp.back < fig.w) continue;
            const k = Math.sign(off) * fig.h;
            const shift = (v: Vec2) => ({ x: v.x + across.x * k, y: v.y + across.y * k });
            if (fig.h > 0 && (!inside(shift(q)) || hits(shift(a), shift(b)))) continue;
          }
          return { a, b };
        }
        return null;
      };
      const found = find();
      if (found) spans.push({ roomId, axis, ...found });
    }
  }

  const notches = notchDims(stretches.facing, polys, solidSegs);
  return { chains, notches, spans, tags, labels, bounds };
}

/**
 * A chain's pieces rounded to `step` (0.01 for 10 mm) so they add up to its rounded overall:
 * each stop is rounded from the first, and the pieces are the differences.
 */
export function roundChain(stops: readonly number[], step: number): number[] {
  const first = stops[0];
  if (first === undefined) return [];
  const units = stops.map((s) => Math.round((s - first) / step));
  const out: number[] = [];
  for (let i = 1; i < units.length; i++) {
    out.push(Number((((units[i] as number) - (units[i - 1] as number)) * step).toFixed(6)));
  }
  return out;
}

export type Paper = 'A4' | 'A3';

/** Landscape paper sizes, in millimetres. */
export const PAPER_MM: Record<Paper, { w: number; h: number }> = {
  A4: { w: 297, h: 210 },
  A3: { w: 420, h: 297 },
};

/** The contractor's sheet: margins, the title column and the band each side for dimensions (mm). */
export const SHEET_MM = { margin: 10, title: 70, band: 30 } as const;

/** The scales a plan is printed at, largest first. */
export const SHEET_SCALES = [50, 100, 200] as const;

/** The drawing area left for the plan itself on a sheet, in millimetres. */
export function sheetDrawingArea(paper: Paper): { w: number; h: number } {
  const p = PAPER_MM[paper];
  const { margin, title, band } = SHEET_MM;
  return { w: p.w - 2 * margin - title - 2 * band, h: p.h - 2 * margin - 2 * band };
}

/**
 * The scale to print a plan of these bounds (metres) at: the largest of 1:50, 1:100 and 1:200
 * that fits the drawing area, or, when none does, the plan fitted to it (`fits` false: not
 * to scale), as 1:`scale` rounded up.
 */
export function sheetScale(bounds: Bounds, paper: Paper): { scale: number; fits: boolean } {
  const area = sheetDrawingArea(paper);
  const w = Math.max(bounds.max.x - bounds.min.x, 1e-6) * 1000;
  const h = Math.max(bounds.max.y - bounds.min.y, 1e-6) * 1000;
  for (const s of SHEET_SCALES) {
    if (w / s <= area.w + 1e-9 && h / s <= area.h + 1e-9) return { scale: s, fits: true };
  }
  return { scale: Math.ceil(Math.max(w / area.w, h / area.h)), fits: false };
}
