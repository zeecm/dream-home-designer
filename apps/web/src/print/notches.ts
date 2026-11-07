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
  /** From this gap up, in a break in the line if not beside it. */
  inBreak: 2.8,
  /** Two depths of one notch closer than this are drawn as one chain on its centre line. */
  merge: 8,
} as const;

/** How far past the mouth a figure beyond it may start, mm: further, it reads as another chain's. */
export const MOUTH_REACH = 6;

/** Rough advance width of a figure in the sheet's sans face, mm (as the sheet measures it). */
export const figureWidth = (text: string) => text.length * NOTCH_MM.text * 0.55;
/** Digits stand about this much of the size above the baseline. */
const CAP = 0.72;

export type FigurePlace = 'beside' | 'break' | 'mouth' | 'leader';

export interface NotchFigure {
  place: FigurePlace;
  /** The figure's middle, and its angle (degrees) reading along the line (level for a leader). */
  at: Vec2;
  deg: number;
  /** For a break: where along the line it is (0 at the inner end, 1 at the mouth). */
  t?: number;
  /** For a leader: the thin line from the depth line to the figure. */
  leader?: Seg;
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

/** A box on paper: its middle, half sizes along `d` and across it, and `d` (a unit vector). */
export interface Box {
  c: Vec2;
  hw: number;
  hh: number;
  d: Vec2;
}

/** What a figure keeps off, on paper: lines, printed text and walls (convex polygons). */
export interface Obstacles {
  segs?: readonly Seg[];
  boxes?: readonly Box[];
  walls?: readonly (readonly Vec2[])[];
}

const cornersOf = (b: Box): Vec2[] => {
  const n = { x: -b.d.y, y: b.d.x };
  return [
    [1, 1],
    [1, -1],
    [-1, -1],
    [-1, 1],
  ].map(([i, j]) => add(add(b.c, b.d, (i as number) * b.hw), n, (j as number) * b.hh));
};

/** Whether two convex outlines overlap (by separating axes). */
function convexOverlap(p: readonly Vec2[], q: readonly Vec2[]): boolean {
  for (const poly of [p, q]) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i] as Vec2;
      const b = poly[(i + 1) % poly.length] as Vec2;
      const axis = { x: -(b.y - a.y), y: b.x - a.x };
      if (Math.abs(axis.x) + Math.abs(axis.y) < 1e-12) continue;
      const pp = p.map((v) => dot(v, axis));
      const qq = q.map((v) => dot(v, axis));
      if (Math.max(...pp) <= Math.min(...qq) || Math.max(...qq) <= Math.min(...pp)) return false;
    }
  }
  return true;
}

/** Whether a segment crosses a box (Liang–Barsky in the box's own frame). */
function segHitsBox(s: Seg, box: Box): boolean {
  const n = { x: -box.d.y, y: box.d.x };
  const local = (p: Vec2) => ({ x: dot(sub(p, box.c), box.d), y: dot(sub(p, box.c), n) });
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
    clip(-v.x, a.x + box.hw) &&
    clip(v.x, box.hw - a.x) &&
    clip(-v.y, a.y + box.hh) &&
    clip(v.y, box.hh - a.y) &&
    t1 - t0 >= 0
  );
}

/** Printed text is kept this much further off than a line (mm), so two figures don't touch. */
const TEXT_CLEAR = 0.6;
const grown = (b: Box): Box => ({ ...b, hw: b.hw + TEXT_CLEAR, hh: b.hh + TEXT_CLEAR });

/** How many obstacles a box touches. */
export function boxHits(box: Box, obs: Obstacles): number {
  const outline = cornersOf(box);
  return (
    (obs.segs ?? []).filter((s) => segHitsBox(s, box)).length +
    (obs.boxes ?? []).filter((b) => convexOverlap(outline, cornersOf(grown(b)))).length +
    (obs.walls ?? []).filter((w) => w.length >= 3 && convexOverlap(outline, w)).length
  );
}

/** Whether a segment crosses any printed text. */
export function segHitsText(s: Seg, obs: Obstacles): boolean {
  return (obs.boxes ?? []).some((b) => segHitsBox(s, grown(b)));
}

/** A figure's box, with a margin: `w` wide, along `d`. */
export const figureBox = (at: Vec2, d: Vec2, w: number): Box => ({
  c: at,
  hw: w / 2 + 0.4,
  hh: (NOTCH_MM.text * CAP) / 2 + 0.4,
  d,
});

/**
 * Where a depth's figure goes, for a line `a` (inner end) to `b` (mouth) in a notch `gap` wide
 * (all on paper, mm), clear of `obstacles` (lines, printed figures and labels, walls):
 * - beside the line from 5 mm, on a side with room for it (`room`, the clear width each side:
 *   +1 is the left of a→b in paper coordinates), at its middle or moved along it;
 * - else in a break in the line (from 2.8 mm), at its middle or moved along it;
 * - else beyond the mouth along the line, starting no more than 6 mm past it;
 * - else read level in the nearest clear spot beside the notch, with a thin leader to it;
 * - with nowhere clear, just past the mouth.
 */
export function notchFigure(
  line: { a: Vec2; b: Vec2 },
  gap: number,
  text: string,
  opts: {
    room?: { left: number; right: number };
    obstacles?: Obstacles;
    /** Not beyond the end (a piece of a chain with another after it): beside, if no break. */
    inside?: boolean;
  } = {},
): NotchFigure & { side: 1 | -1 } {
  const obs = opts.obstacles ?? {};
  const d = unit(sub(line.b, line.a));
  const n = { x: -d.y, y: d.x };
  const deg = readingAngle(d);
  const w = figureWidth(text);
  const depth = len(sub(line.b, line.a));
  const room = opts.room ?? { left: gap / 2, right: gap / 2 };
  const need = NOTCH_MM.text * CAP + 0.9;
  const hits = (at: Vec2, dir = d) => boxHits(figureBox(at, dir, w), obs);
  const along = (t: number) => add(line.a, d, depth * t);
  const besideAt = (s: 1 | -1, t: number) =>
    add(along(t), n, s * (0.5 + (NOTCH_MM.text * CAP) / 2));
  // The middle first, then out along the line, while the figure stays on it.
  const ts = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8].filter(
    (t) => depth * Math.min(t, 1 - t) >= w / 2 + 0.3,
  );
  const sides = ([1, -1] as const)
    .map((s) => ({ s, room: s === 1 ? room.left : room.right }))
    .sort((p, q) => q.room - p.room);
  // The side for the extension line: the one whose middle is clear, else the roomier.
  const best = sides.find((x) => hits(besideAt(x.s, 0.5)) === 0) ?? (sides[0] as { s: 1 | -1 });
  if (gap >= NOTCH_MM.beside) {
    for (const t of ts) {
      for (const x of sides) {
        if (x.room >= need && hits(besideAt(x.s, t)) === 0) {
          return { place: 'beside', at: besideAt(x.s, t), deg, side: x.s };
        }
      }
    }
  }
  if (gap >= NOTCH_MM.inBreak) {
    for (const t of ts) {
      if (depth * Math.min(t, 1 - t) < w / 2 + 1.6) continue;
      if (hits(along(t)) === 0) return { place: 'break', at: along(t), deg, t, side: best.s };
    }
  }
  if (opts.inside) return { place: 'beside', at: besideAt(best.s, 0.5), deg, side: best.s };
  for (let off = 1; off <= MOUTH_REACH + 1e-9; off += 0.5) {
    const p = add(line.b, d, off + w / 2);
    if (hits(p) === 0) return { place: 'mouth', at: p, deg, side: best.s };
  }
  // Read level beside the notch, in the nearest spot that is clear, with a leader to the line.
  const level = { x: 1, y: 0 };
  const half = { w: w / 2 + 0.4, h: (NOTCH_MM.text * CAP) / 2 + 0.4 };
  const spots: { at: Vec2; to: Vec2; r: number }[] = [];
  for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    const to = along(t);
    for (let off = 1.5; off <= 15 + 1e-9; off += 0.75) {
      for (const s of [1, -1]) {
        spots.push({ at: add(to, n, s * (gap / 2 + off)), to, r: off + Math.abs(t - 0.5) * 4 });
      }
    }
  }
  spots.sort((p, q) => p.r - q.r);
  for (const { at, to } of spots) {
    if (hits(at, level) > 0) continue;
    // From the line to the figure's edge, a little short of each.
    const u = unit(sub(at, to));
    const reach = Math.min(
      Math.abs(u.x) > 1e-9 ? half.w / Math.abs(u.x) : Number.POSITIVE_INFINITY,
      Math.abs(u.y) > 1e-9 ? half.h / Math.abs(u.y) : Number.POSITIVE_INFINITY,
    );
    const leader: Seg = [add(to, u, 0.3), add(at, u, -reach)];
    if (segHitsText(leader, obs)) continue;
    return { place: 'leader', at, deg: 0, leader, side: best.s };
  }
  return { place: 'mouth', at: add(line.b, d, 1 + w / 2), deg, side: best.s };
}

/** A depth (or two, as a chain) ready to draw, in paper millimetres. */
export interface NotchDrawing {
  notch: number;
  /** The figures printed, in order ("1000"; or "1700", "300" for a chain). */
  depths: string[];
  /** The line, in pieces (a break leaves a gap). */
  lines: Seg[];
  /** The first is at the inner end, at the back face. */
  ticks: Vec2[];
  /** The way from the inner end to the mouth, on paper. */
  dir: Vec2;
  /** Grey extension lines from where a flank turns at the mouth to the line's tick. */
  ext: Seg[];
  /** Thin leaders from the line to a figure set beside the notch. */
  leaders: Seg[];
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

/** The line from a to b, broken around a figure `w` wide at `t` along it if it's in a break. */
function brokenLine(a: Vec2, b: Vec2, fig: NotchFigure, w: number): Seg[] {
  if (fig.place !== 'break') return [[a, b]];
  const d = unit(sub(b, a));
  const at = len(sub(b, a)) * (fig.t ?? 0.5);
  return [
    [a, add(a, d, at - w / 2 - 0.6)],
    [add(a, d, at + w / 2 + 0.6), b],
  ];
}

/**
 * The notches' depths laid out on paper: `P` maps plan metres to paper mm, `k` is mm per
 * metre. One depth per line; two of one notch, parallel and less than 8 mm apart, become one
 * chain on the centre line between them (back face, nearer mouth, further mouth), with a
 * figure per piece. Figures, and the lines themselves, keep off `obstacles`: what else the
 * sheet prints there.
 */
export function notchDrawings(
  notches: readonly NotchDim[],
  P: (v: Vec2) => Vec2,
  k: number,
  obstacles: Obstacles = {},
): NotchDrawing[] {
  const groups = new Map<number, NotchDim[]>();
  for (const n of notches) groups.set(n.notch, [...(groups.get(n.notch) ?? []), n]);
  const out: NotchDrawing[] = [];
  for (const [notch, list] of groups) {
    const [x, y] = list;
    const mid = (v: NotchDim) => P({ x: (v.a.x + v.b.x) / 2, y: (v.a.y + v.b.y) / 2 });
    const apart = x && y ? len(sub(mid(x), mid(y))) : Number.POSITIVE_INFINITY;
    // Parallel within 1° only: a chain's stops on one line can't stand for a taper's depths.
    const parallel =
      !!x &&
      !!y &&
      Math.abs(dot(unit(sub(x.b, x.a)), unit(sub(y.b, y.a)))) > Math.cos((1 * Math.PI) / 180);
    if (x && y && list.length === 2 && parallel && apart < NOTCH_MM.merge) {
      out.push(chainOf(notch, x, y, P, k, obstacles));
      continue;
    }
    for (const dim of list) out.push(single(notch, dim, P, k, obstacles));
  }
  return out;
}

/** One depth along its line. */
function single(
  notch: number,
  dim: NotchDim,
  P: (v: Vec2) => Vec2,
  k: number,
  obstacles: Obstacles,
): NotchDrawing {
  let a = P(dim.a);
  let b = P(dim.b);
  const d = unit(sub(b, a));
  const n = { x: -d.y, y: d.x };
  const gap = dim.gap * k;
  // The clear width each side of the line: to each flank measured, and the rest of the gap.
  const corners = dim.corners.map(P);
  const acrossOf = () => corners.map((c) => dot(sub(c, b), n));
  const roomOf = () => {
    const across = acrossOf();
    const left = across.find((v) => v > 1e-6);
    const right = across.find((v) => v < -1e-6);
    return {
      left: left ?? gap - Math.abs(right ?? gap / 2),
      right: right !== undefined ? -right : gap - (left ?? gap / 2),
    };
  };
  // A line (with its ticks) through printed text moves across the notch, while it fits.
  const struck = (p: Vec2, q: Vec2) => segHitsText([add(p, d, -0.6), add(q, d, 0.6)], obstacles);
  if (struck(a, b)) {
    const r = roomOf();
    for (let s = 0.5; s <= Math.max(r.left, r.right); s += 0.5) {
      const shift = [s, -s].find(
        (v) =>
          (v > 0 ? r.left : r.right) - Math.abs(v) >= 0.6 && !struck(add(a, n, v), add(b, n, v)),
      );
      if (shift === undefined) continue;
      a = add(a, n, shift);
      b = add(b, n, shift);
      break;
    }
  }
  const room = roomOf();
  const across = acrossOf();
  const text = depthText(Math.hypot(dim.b.x - dim.a.x, dim.b.y - dim.a.y));
  const fig = notchFigure({ a, b }, gap, text, { room, obstacles });
  // From the flank's corner on the figure's side (or the only one).
  const corner =
    corners.find((_, i) => Math.sign(across[i] ?? 0) === fig.side) ?? corners[0] ?? null;
  const e = corner ? extension(corner, b) : null;
  return {
    notch,
    depths: [text],
    lines: brokenLine(a, b, fig, figureWidth(text)),
    ticks: [a, b],
    dir: d,
    ext: e ? [e] : [],
    leaders: fig.leader ? [fig.leader] : [],
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
  obstacles: Obstacles,
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
  const leaders: Seg[] = [];
  const figures: NotchDrawing['figures'] = [];
  const depths: string[] = [];
  pieces.forEach((p, i) => {
    const a = at(stops[i] as number);
    const b = at(stops[i + 1] as number);
    const text = depthText(p);
    depths.push(text);
    const fig = notchFigure({ a, b }, gap, text, { obstacles, inside: i < pieces.length - 1 });
    lines.push(...brokenLine(a, b, fig, figureWidth(text)));
    if (fig.leader) leaders.push(fig.leader);
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
    dir: unit(sub(at(1), at(0))),
    ext,
    leaders,
    figures,
  };
}

/** The markup's attributes, by name. */
function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z0-9:-]+)="([^"]*)"/g)) out[m[1] as string] = m[2] as string;
  return out;
}

const decode = (t: string) =>
  t
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * What a drawn page already prints, read from its markup (as the sheet renders it): every
 * line, and a box round every text (each line of a name in tspans its own), turned as drawn.
 * Widths are the sheet's rough measure of its sans face.
 */
export function obstaclesOf(markup: string): Required<Pick<Obstacles, 'segs' | 'boxes'>> {
  const segs: Seg[] = [];
  for (const m of markup.matchAll(/<line\b([^>]*)\/?>/g)) {
    const a = attrsOf(m[1] as string);
    const v = ['x1', 'y1', 'x2', 'y2'].map((k) => Number(a[k]));
    if (v.every(Number.isFinite)) {
      segs.push([
        { x: v[0] as number, y: v[1] as number },
        { x: v[2] as number, y: v[3] as number },
      ]);
    }
  }
  const boxes: Box[] = [];
  for (const m of markup.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const a = attrsOf(m[1] as string);
    const size = Number(a['font-size'] ?? 2.2);
    const bold = (a['font-weight'] ?? '') === '700';
    const central = a['dominant-baseline'] === 'central';
    const anchor = a['text-anchor'] ?? 'start';
    const rot = /rotate\(\s*([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)\s*\)/.exec(a.transform ?? '');
    const deg = rot ? Number(rot[1]) : 0;
    const pivot = rot ? { x: Number(rot[2]), y: Number(rot[3]) } : null;
    const body = m[2] as string;
    const lines: { x: number; y: number; text: string }[] = [];
    const x0 = Number(a.x ?? 0);
    let y = Number(a.y ?? 0);
    if (body.includes('<tspan')) {
      for (const t of body.matchAll(/<tspan\b([^>]*)>([\s\S]*?)<\/tspan>/g)) {
        const ta = attrsOf(t[1] as string);
        y += Number(ta.dy ?? 0);
        lines.push({ x: Number(ta.x ?? x0), y, text: decode(t[2] as string) });
      }
    } else lines.push({ x: x0, y, text: decode(body) });
    const r = (deg * Math.PI) / 180;
    const d = { x: Math.cos(r), y: Math.sin(r) };
    for (const l of lines) {
      if (!l.text.trim()) continue;
      const w = l.text.length * size * (bold ? 0.6 : 0.55);
      const cx = anchor === 'middle' ? l.x : anchor === 'end' ? l.x - w / 2 : l.x + w / 2;
      const cy = central ? l.y : l.y - size * 0.33;
      // Turned about the pivot as the transform turns it.
      let c = { x: cx, y: cy };
      if (pivot) {
        const v = sub(c, pivot);
        c = { x: pivot.x + v.x * d.x - v.y * d.y, y: pivot.y + v.x * d.y + v.y * d.x };
      }
      boxes.push({ c, hw: w / 2, hh: size * 0.38, d });
    }
  }
  return { segs, boxes };
}
