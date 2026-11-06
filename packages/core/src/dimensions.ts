import type { Bounds } from './geometry';
import { labelClearance, placeLabel, pointInPolygon } from './geometry';
import {
  type PlanGeometry,
  type WallFrame,
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
}

export interface PlanDimensions {
  chains: DimensionChain[];
  spans: RoomSpan[];
  tags: OpeningTag[];
  /** Where each room's label goes (the point its spans run through). */
  labels: { roomId: string; at: Vec2 }[];
  /** The walls' outline bounds (faces, not centre lines), or null with no walls. */
  bounds: Bounds | null;
}

/** Stops closer than this are one. */
const MERGE = 0.005;
/** A wall faces a side when its outside face is within this of square to it. */
const AXIS_TOLERANCE = (1 * Math.PI) / 180;
/** Room spans shorter than this aren't worth a dimension. */
const MIN_SPAN = 0.6;
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

/**
 * The stretches of each wall's faces that look outside and can be seen from there: the flat
 * (a room or a wall) just behind the other face (measured where that face runs, so a
 * corner's mitre still counts), free space just in front, and nothing of the flat further
 * out the way it looks (so a face in a notch, hidden behind another part of the flat, isn't
 * dimensioned from outside). Found by sampling every 2 cm, each change refined to a fraction
 * of a millimetre.
 */
function outsideStretches(geom: PlanGeometry, polys: Polys, segs: Seg[]): Stretch[] {
  const out: Stretch[] = [];
  for (const [wallId, f] of Object.entries(geom.frames)) {
    if (geom.boundaries.includes(wallId)) continue;
    for (const side of [1, -1] as const) {
      const face = side === 1 ? f.left : f.right;
      const back = side === 1 ? f.right : f.left;
      const [s0, s1] = face;
      if (s1 - s0 < 0.05) continue;
      const { dir } = lookOf({ x: f.n.x * side, y: f.n.y * side });
      const looksOut = (u: number) => {
        const p = framePoint(f, u, side);
        const front = { x: p.x + f.n.x * side * PROBE, y: p.y + f.n.y * side * PROBE };
        const ub = Math.min(Math.max(u, back[0] + 0.01), back[1] - 0.01);
        const q = framePoint(f, ub, -side);
        const behind = { x: q.x - f.n.x * side * PROBE, y: q.y - f.n.y * side * PROBE };
        return (
          free(front, polys) &&
          !free(behind, polys) &&
          rayHit(front, dir, segs) === Number.POSITIVE_INFINITY
        );
      };
      const n = Math.max(2, Math.ceil((s1 - s0) / 0.02));
      const at = (i: number) => s0 + ((s1 - s0) * i) / n;
      const edge = (from: number, to: number, startsOut: boolean) => {
        let lo = from;
        let hi = to;
        for (let k = 0; k < 14; k++) {
          const m = (lo + hi) / 2;
          if (looksOut(m) === startsOut) lo = m;
          else hi = m;
        }
        return (lo + hi) / 2;
      };
      let start: number | null = null;
      let prev = looksOut(at(0));
      if (prev) start = s0;
      for (let i = 1; i <= n; i++) {
        const cur = looksOut(at(i));
        if (cur !== prev) {
          const e = edge(at(i - 1), at(i), prev);
          if (cur) start = e;
          else if (start !== null) {
            if (e - start > 0.05) out.push({ frame: f, side, u0: start, u1: e });
            start = null;
          }
        }
        prev = cur;
      }
      if (start !== null && s1 - start > 0.05) out.push({ frame: f, side, u0: start, u1: s1 });
    }
  }
  return out;
}

/** Bounds of every wall piece, junction and opening: the flat's outline, face to face. */
export function outlineBounds(geom: PlanGeometry): Bounds | null {
  const all = [
    ...geom.pieces.map((p) => p.polygon),
    ...geom.footprints.hubs.map((h) => h.polygon),
    ...geom.openings.map((o) => o.polygon),
  ].flat();
  if (all.length === 0) return null;
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  return {
    min: { x: Math.min(...xs), y: Math.min(...ys) },
    max: { x: Math.max(...xs), y: Math.max(...ys) },
  };
}

type Seg = [Vec2, Vec2];

/** Where a ray from p first meets a segment, as a distance along it, or Infinity. */
function rayHit(p: Vec2, d: Vec2, segs: readonly Seg[]): number {
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
  return best;
}

const edgesOf = (poly: readonly Vec2[]): Seg[] =>
  poly.map((p, i) => [p, poly[(i + 1) % poly.length] as Vec2]);

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
  const bounds = outlineBounds(geom);
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

  for (const s of outsideStretches(geom, polys, solidSegs)) {
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
    const tier1 = mergeStops(
      [
        ...merged.flatMap((r) => [
          { v: r.from, from: r.at },
          { v: r.to, from: r.at },
        ]),
        ...corners[side],
      ],
      [],
      out,
    );
    const tier0 = mergeStops(tier1, edges[side], out);
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
      k = inRoom(probe(1), polys) ? 1 : -1;
    }
    tags.push({
      openingId: o.opening.id,
      kind: o.kind,
      width: o.opening.width,
      at: c,
      out: { x: f.n.x * k, y: f.n.y * k },
      half: f.half,
    });
  }

  // Room labels, clear of door swings and of the tags (as boxes: a tag is long and thin, and
  // placeLabel's circles are tested only at a label's corners and edge middles).
  const swings = geom.openings
    .filter((o) => o.kind === 'door')
    .map((o) => swingZone(doorSwing(o.frame, o.opening)));
  const tagHalf = opts.tagHalf ?? { along: 0.32, across: 0.12 };
  const boxOf = (t: OpeningTag) => {
    const off = t.half + tagHalf.across;
    const c = { x: t.at.x + t.out.x * off, y: t.at.y + t.out.y * off };
    // Along the wall is square to `out`.
    const ax = Math.abs(t.out.y) * tagHalf.along + Math.abs(t.out.x) * tagHalf.across;
    const ay = Math.abs(t.out.x) * tagHalf.along + Math.abs(t.out.y) * tagHalf.across;
    return { c, hx: ax, hy: ay };
  };
  const tagBoxes = [...tags.map(boxOf), ...(opts.avoidBoxes ?? [])];
  const onTag = (p: Vec2, half: Vec2) =>
    tagBoxes.some(
      (b) => Math.abs(p.x - b.c.x) < half.x + b.hx && Math.abs(p.y - b.c.y) < half.y + b.hy,
    );
  /** How much of a label box tags and other boxes cover (m²). */
  const covered = (p: Vec2, half: Vec2) =>
    tagBoxes.reduce((sum, b) => {
      const ox = Math.min(p.x + half.x, b.c.x + b.hx) - Math.max(p.x - half.x, b.c.x - b.hx);
      const oy = Math.min(p.y + half.y, b.c.y + b.hy) - Math.max(p.y - half.y, b.c.y - b.hy);
      return ox > 0 && oy > 0 ? sum + ox * oy : sum;
    }, 0);
  /**
   * placeLabel's spot, or if a tag or a box is in the way, the nearest spot on a grid that is
   * clear of them (and fits as placeLabel's must), or, with none clear, the least covered.
   */
  const place = (outer: Vec2[], half: Vec2, holes: Vec2[][]) => {
    const home = placeLabel(outer, half, swings, holes);
    if (!onTag(home, half)) return home;
    const xs = outer.map((p) => p.x);
    const ys = outer.map((p) => p.y);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const w = Math.max(...xs) - x0;
    const h = Math.max(...ys) - y0;
    let best = home;
    let bestScore = covered(home, half) * 100;
    for (let i = 0; i <= 24; i++) {
      for (let j = 0; j <= 24; j++) {
        const p = { x: x0 + (w * i) / 24, y: y0 + (h * j) / 24 };
        if (!pointInPolygon(p, outer)) continue;
        if (labelClearance(p, half, outer, swings, holes) < 0) continue;
        const score = covered(p, half) * 100 + Math.hypot(p.x - home.x, p.y - home.y);
        if (score < bestScore) {
          bestScore = score;
          best = p;
        }
      }
    }
    return best;
  };
  const segs: Seg[] = [
    ...solidSegs,
    ...geom.boundaries.flatMap((id) => {
      const f = geom.frames[id];
      return f ? [[framePoint(f, 0, 0), framePoint(f, f.length, 0)] as Seg] : [];
    }),
  ];
  const spans: RoomSpan[] = [];
  const labels: { roomId: string; at: Vec2 }[] = [];
  const placed: { c: Vec2; half: Vec2 }[] = [];
  const shapeOf = roomShapes(level);
  for (const r of Object.values(level.rooms)) {
    const shape = shapeOf.get(r.id);
    if (!shape || shape.outer.length < 3) continue;
    const p = place(shape.outer, opts.labelHalf?.(r) ?? LABEL_HALF, shape.holes);
    labels.push({ roomId: r.id, at: p });
    placed.push({ c: p, half: opts.labelHalf?.(r) ?? LABEL_HALF });
    for (const axis of ['x', 'y'] as const) {
      const d = axis === 'x' ? { x: 1, y: 0 } : { x: 0, y: 1 };
      const fwd = rayHit(p, d, segs);
      const back = rayHit(p, { x: -d.x, y: -d.y }, segs);
      if (!Number.isFinite(fwd) || !Number.isFinite(back) || fwd + back < MIN_SPAN) continue;
      spans.push({
        roomId: r.id,
        axis,
        a: { x: p.x - d.x * back, y: p.y - d.y * back },
        b: { x: p.x + d.x * fwd, y: p.y + d.y * fwd },
      });
    }
  }

  // A tag on a label (one that had no room to keep clear of it) or on a built-in goes to the
  // other side of its wall, if that side is clear.
  const others = (opts.avoidBoxes ?? []).map((b) => ({ c: b.c, half: { x: b.hx, y: b.hy } }));
  const onLabel = (b: { c: Vec2; hx: number; hy: number }) =>
    [...placed, ...others].some(
      (l) => Math.abs(l.c.x - b.c.x) < l.half.x + b.hx && Math.abs(l.c.y - b.c.y) < l.half.y + b.hy,
    );
  for (const t of tags) {
    if (!onLabel(boxOf(t))) continue;
    const flipped = { ...t, out: { x: -t.out.x, y: -t.out.y } };
    if (!onLabel(boxOf(flipped))) t.out = flipped.out;
  }

  return { chains, spans, tags, labels, bounds };
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
