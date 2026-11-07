import { type NotchDim, type Vec2, roundChain } from '@dhd/core';

/**
 * Where a notch's depth and its figure go on the contractor's sheet (paper millimetres). Pure:
 * the sheet draws what this returns. Spec: docs/specs/slice-2s.md, C1.
 */

export type Seg = [Vec2, Vec2];

/** Figure size (mm) and the gaps on paper that decide where it goes. */
export const NOTCH_MM = {
  text: 2.2,
  /** The figure goes beside the line from this gap up. */
  beside: 5,
  /** From this gap up to `beside`, in a break in the line; below it, beyond the mouth. */
  inBreak: 2.8,
  /** Two depths of one notch closer than this are drawn as one chain on its centre line. */
  merge: 8,
} as const;

/** Rough advance width of a figure in the sheet's sans face, mm (as the sheet measures it). */
export const figureWidth = (text: string) => text.length * NOTCH_MM.text * 0.55;
/** Digits stand about this much of the size above the baseline. */
const CAP = 0.72;

export type FigurePlace = 'beside' | 'break' | 'mouth';

export interface NotchFigure {
  place: FigurePlace;
  /** The figure's middle, and its angle (degrees) reading along the line. */
  at: Vec2;
  deg: number;
}

const sub = (p: Vec2, q: Vec2): Vec2 => ({ x: p.x - q.x, y: p.y - q.y });
const dot = (p: Vec2, q: Vec2) => p.x * q.x + p.y * q.y;
const add = (p: Vec2, d: Vec2, k: number): Vec2 => ({ x: p.x + d.x * k, y: p.y + d.y * k });
const len = (p: Vec2) => Math.hypot(p.x, p.y);
const unit = (p: Vec2): Vec2 => {
  const l = len(p) || 1;
  return { x: p.x / l, y: p.y / l };
};

/** The angle a figure reads at along `d`: never upside down; an upright line reads upwards. */
export function readingAngle(d: Vec2): number {
  let deg = (Math.atan2(d.y, d.x) * 180) / Math.PI;
  if (deg >= 90 - 1e-6) deg -= 180;
  if (deg < -90 - 1e-6) deg += 180;
  return deg;
}

/** Whether a segment crosses a box of half sizes `hx` along `d` and `hy` across it, centred at `c`. */
function segHitsBox(s: Seg, c: Vec2, d: Vec2, hx: number, hy: number): boolean {
  const n = { x: -d.y, y: d.x };
  const local = (p: Vec2) => ({ x: dot(sub(p, c), d), y: dot(sub(p, c), n) });
  const a = local(s[0]);
  const b = local(s[1]);
  let t0 = 0;
  let t1 = 1;
  const v = { x: b.x - a.x, y: b.y - a.y };
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
    clip(-v.x, a.x + hx) &&
    clip(v.x, hx - a.x) &&
    clip(-v.y, a.y + hy) &&
    clip(v.y, hy - a.y) &&
    t1 - t0 >= 0
  );
}

/** How many of the segments a figure of width `w` at `at`, along `d`, touches (with a margin). */
export function figureHits(at: Vec2, d: Vec2, w: number, blockers: readonly Seg[]): number {
  const hy = (NOTCH_MM.text * CAP) / 2 + 0.4;
  return blockers.filter((s) => segHitsBox(s, at, d, w / 2 + 0.4, hy)).length;
}

/**
 * Where a depth's figure goes, for a line `a` (inner end) to `b` (mouth) in a notch `gap` wide
 * (all on paper, mm): beside the line from 5 mm, on the side with room for it (`room`, the
 * clear width each side: +1 is the left of a→b in paper coordinates) and, of two, the side no
 * extension line or chain crosses; from 2.8 mm, in a break in the line, if the line is long
 * enough to show either side; else beyond the mouth along the line, out to where it touches
 * nothing.
 */
export function notchFigure(
  line: { a: Vec2; b: Vec2 },
  gap: number,
  text: string,
  opts: {
    room?: { left: number; right: number };
    blockers?: readonly Seg[];
    /** Not beyond the end (a piece of a chain with another after it): beside, if no break. */
    inside?: boolean;
  } = {},
): NotchFigure & { side: 1 | -1 } {
  const blockers = opts.blockers ?? [];
  const d = unit(sub(line.b, line.a));
  const n = { x: -d.y, y: d.x };
  const deg = readingAngle(d);
  const w = figureWidth(text);
  const depth = len(sub(line.b, line.a));
  const mid = add(line.a, d, depth / 2);
  const room = opts.room ?? { left: gap / 2, right: gap / 2 };
  const need = NOTCH_MM.text * CAP + 0.9;
  const besideAt = (s: 1 | -1) => add(mid, n, s * (0.5 + (NOTCH_MM.text * CAP) / 2));
  const sides = ([1, -1] as const).map((s) => ({
    s,
    room: s === 1 ? room.left : room.right,
    hits: figureHits(besideAt(s), d, w, blockers),
  }));
  // The side with fewest crossings, then the most room.
  const best = [...sides].sort((p, q) => p.hits - q.hits || q.room - p.room)[0] as {
    s: 1 | -1;
    room: number;
  };
  const roomy = sides.filter((x) => x.room >= need).sort((p, q) => p.hits - q.hits)[0];
  if (gap >= NOTCH_MM.beside && roomy && depth >= w) {
    return { place: 'beside', at: besideAt(roomy.s), deg, side: roomy.s };
  }
  if (gap >= NOTCH_MM.inBreak && depth >= w + 1.2 + 2) {
    return { place: 'break', at: mid, deg, side: best.s };
  }
  if (opts.inside) return { place: 'beside', at: besideAt(best.s), deg, side: best.s };
  let at = add(line.b, d, 1 + w / 2);
  for (let k = 0; k < 40; k++) {
    const p = add(line.b, d, 1 + w / 2 + k * 0.5);
    if (figureHits(p, d, w, blockers) === 0) {
      at = p;
      break;
    }
  }
  return { place: 'mouth', at, deg, side: best.s };
}

/** A depth (or two, as a chain) ready to draw, in paper millimetres. */
export interface NotchDrawing {
  notch: number;
  /** The figures printed, in order ("1000"; or "1700", "300" for a chain). */
  depths: string[];
  /** The line, in pieces (a break leaves a gap). */
  lines: Seg[];
  ticks: Vec2[];
  /** Grey extension lines from where a flank turns at the mouth to the line's tick. */
  ext: Seg[];
  figures: (NotchFigure & { text: string })[];
}

/** A figure of a depth in metres, as the sheet prints it: mm to 10 mm. */
export const depthText = (m: number) => String(Math.round(m * 100) * 10);

/** The extension line from a corner on the face to just past the tick at `to`. */
function extension(corner: Vec2, to: Vec2): Seg | null {
  const v = sub(to, corner);
  if (len(v) < 0.6) return null;
  const u = unit(v);
  return [add(corner, u, 0.5), add(to, u, 1.2)];
}

/**
 * The notches' depths laid out on paper: `P` maps plan metres to paper mm, `k` is mm per
 * metre. One depth per line; two of one notch, parallel and less than 8 mm apart, become one
 * chain on the centre line between them (back face, nearer mouth, further mouth), with a figure per piece.
 * `blockers` are what a figure keeps off: the chains' extension lines and lines.
 */
export function notchDrawings(
  notches: readonly NotchDim[],
  P: (v: Vec2) => Vec2,
  k: number,
  blockers: readonly Seg[] = [],
): NotchDrawing[] {
  const groups = new Map<number, NotchDim[]>();
  for (const n of notches) groups.set(n.notch, [...(groups.get(n.notch) ?? []), n]);
  const out: NotchDrawing[] = [];
  for (const [notch, list] of groups) {
    const [x, y] = list;
    const apart =
      x && y
        ? len(
            sub(
              P({ x: (x.a.x + x.b.x) / 2, y: (x.a.y + x.b.y) / 2 }),
              P({ x: (y.a.x + y.b.x) / 2, y: (y.a.y + y.b.y) / 2 }),
            ),
          )
        : Number.POSITIVE_INFINITY;
    // Parallel within 1° only: a chain's stops on one line can't stand for a taper's depths.
    const parallel =
      !!x &&
      !!y &&
      Math.abs(dot(unit(sub(x.b, x.a)), unit(sub(y.b, y.a)))) > Math.cos((1 * Math.PI) / 180);
    if (x && y && list.length === 2 && parallel && apart < NOTCH_MM.merge) {
      out.push(chainOf(notch, x, y, P, k, blockers));
      continue;
    }
    for (const dim of list) out.push(single(notch, dim, P, k, blockers));
  }
  return out;
}

/** One depth along its line. */
function single(
  notch: number,
  dim: NotchDim,
  P: (v: Vec2) => Vec2,
  k: number,
  blockers: readonly Seg[],
): NotchDrawing {
  const a = P(dim.a);
  const b = P(dim.b);
  const d = unit(sub(b, a));
  const n = { x: -d.y, y: d.x };
  const gap = dim.gap * k;
  // The clear width each side of the line: to each flank measured, and the rest of the gap.
  const corners = dim.corners.map(P);
  const across = corners.map((c) => dot(sub(c, b), n));
  const left = across.find((v) => v > 1e-6);
  const right = across.find((v) => v < -1e-6);
  const room = {
    left: left ?? gap - Math.abs(right ?? gap / 2),
    right: right !== undefined ? -right : gap - (left ?? gap / 2),
  };
  const text = depthText(Math.hypot(dim.b.x - dim.a.x, dim.b.y - dim.a.y));
  const fig = notchFigure({ a, b }, gap, text, { room, blockers });
  const w = figureWidth(text);
  const depth = len(sub(b, a));
  const lines: Seg[] =
    fig.place === 'break'
      ? [
          [a, add(a, d, depth / 2 - w / 2 - 0.6)],
          [add(a, d, depth / 2 + w / 2 + 0.6), b],
        ]
      : [[a, b]];
  // From the flank's corner on the figure's side (or the only one).
  const corner =
    corners.find((c, i) => Math.sign(across[i] ?? 0) === fig.side) ?? corners[0] ?? null;
  const e = corner ? extension(corner, b) : null;
  return {
    notch,
    depths: [text],
    lines,
    ticks: [a, b],
    ext: e ? [e] : [],
    figures: [{ place: fig.place, at: fig.at, deg: fig.deg, text }],
  };
}

/** Two depths of one notch as one chain on the centre line between them. */
function chainOf(
  notch: number,
  x: NotchDim,
  y: NotchDim,
  P: (v: Vec2) => Vec2,
  k: number,
  blockers: readonly Seg[],
): NotchDrawing {
  const o = { x: (x.a.x + y.a.x) / 2, y: (x.a.y + y.a.y) / 2 };
  const d = unit({
    x: x.b.x - x.a.x + (y.b.x - y.a.x),
    y: x.b.y - x.a.y + (y.b.y - y.a.y),
  });
  const along = (p: Vec2) => dot(sub(p, o), d);
  // Stops along the centre line (metres), within 5 mm one.
  const stops: number[] = [];
  for (const s of [x.a, y.a, x.b, y.b].map(along).sort((p, q) => p - q)) {
    if (!stops.some((t) => Math.abs(t - s) < 0.005)) stops.push(s);
  }
  const pieces = roundChain(stops, 0.01);
  const at = (t: number) => P(add(o, d, t));
  const gap = Math.min(x.gap, y.gap) * k;
  const lines: Seg[] = [];
  const figures: NotchDrawing['figures'] = [];
  const depths: string[] = [];
  pieces.forEach((p, i) => {
    const a = at(stops[i] as number);
    const b = at(stops[i + 1] as number);
    const text = depthText(p);
    depths.push(text);
    const fig = notchFigure({ a, b }, gap, text, { blockers, inside: i < pieces.length - 1 });
    const w = figureWidth(text);
    const dp = unit(sub(b, a));
    const l = len(sub(b, a));
    if (fig.place === 'break') {
      lines.push([a, add(a, dp, l / 2 - w / 2 - 0.6)], [add(a, dp, l / 2 + w / 2 + 0.6), b]);
    } else lines.push([a, b]);
    figures.push({ place: fig.place, at: fig.at, deg: fig.deg, text });
  });
  // An extension line from each flank's corner at its mouth to its stop.
  const ext = [x, y].flatMap((dim) => {
    const corner = dim.corners[0];
    if (!corner) return [];
    const e = extension(P(corner), at(along(dim.b)));
    return e ? [e] : [];
  });
  return {
    notch,
    depths,
    lines,
    ticks: stops.map(at),
    ext,
    figures,
  };
}
