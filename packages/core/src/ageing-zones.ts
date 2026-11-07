import { type Side, clipHalf, near, zoneOf } from './convex';
import type { Vec2 } from './schema';

/**
 * Exact clear-space measures for the ageing check, on the polygons: how deep the free space
 * off a line is, and the largest square that fits off a wall face. Metres. Spec:
 * docs/specs/ageing-parents.md.
 */

/** Free space off a side, and the obstacle (by index) that ends it (-1: none within need). */
export interface Clear {
  have: number;
  by: number;
}

/**
 * How deep the free space off a side is, up to `need`, within the side's width: the nearest
 * obstacle point in front of it. Obstacles behind the side, or only reaching `skin` in front
 * of it (the wall the side lies on), don't count; nor do those only touching its ends. With
 * a negative skin an obstacle touching the side counts (0 clear), as `roomOff` does.
 */
export function depthOff(s: Side, need: number, obstacles: readonly Vec2[][], skin = 0.01): Clear {
  const d = { x: (s.b.x - s.a.x) / s.width, y: (s.b.y - s.a.y) / s.width };
  const u = (p: Vec2) => (p.x - s.a.x) * d.x + (p.y - s.a.y) * d.y;
  const v = (p: Vec2) => (p.x - s.a.x) * s.n.x + (p.y - s.a.y) * s.n.y;
  const e = 0.01;
  let have = need;
  let by = -1;
  const zone = zoneOf(s, need);
  obstacles.forEach((poly, i) => {
    if (!near(zone, poly)) return;
    let c = clipHalf([...poly], (p) => u(p) - e);
    c = clipHalf(c, (p) => s.width - e - u(p));
    c = clipHalf(c, (p) => v(p) - skin);
    c = clipHalf(c, (p) => need - v(p));
    for (const p of c) {
      const h = Math.max(0, v(p));
      if (h < have - 1e-12) {
        have = h;
        by = i;
      }
    }
  });
  return { have, by };
}

/** A side `w` wide centred at `c` along unit `d`, facing unit `n` (the way its depth goes). */
export function sideAt(c: Vec2, d: Vec2, n: Vec2, w: number): Side {
  return {
    a: { x: c.x - (d.x * w) / 2, y: c.y - (d.y * w) / 2 },
    b: { x: c.x + (d.x * w) / 2, y: c.y + (d.y * w) / 2 },
    n,
    width: w,
  };
}

/** The largest square found, where it is (its near edge's centre) and its outline. */
export interface SquareFit {
  have: number;
  at: Vec2;
  /** The obstacle ending the square one step larger (-1: none). */
  by: number;
}

/**
 * The largest square, at most `max` across, off a face: its near edge on the face, centred
 * at `c` slid along `d` by one of `slides`, its depth going `n`. `limit(side, need)` adds an
 * extra depth limit (where the rooms end). To the millimetre.
 */
export function largestSquare(
  c: Vec2,
  d: Vec2,
  n: Vec2,
  obstacles: readonly Vec2[][],
  max: number,
  slides: readonly number[] = [0],
  limit?: (s: Side, need: number) => number,
): SquareFit {
  const at = (t: number) => ({ x: c.x + d.x * t, y: c.y + d.y * t });
  const fits = (s: number): { t: number; by: number } | null => {
    let by = -1;
    for (const t of slides) {
      const side = sideAt(at(t), d, n, s);
      const r = depthOff(side, s, obstacles);
      const lim = limit ? limit(side, s) : s;
      if (r.have >= s - 1e-4 && lim >= s - 1e-4) return { t, by: -1 };
      if (by < 0) by = r.by;
    }
    return by >= 0 ? { t: Number.NaN, by } : null;
  };
  const ok = (s: number) => {
    const f = fits(s);
    return !!f && !Number.isNaN(f.t);
  };
  if (ok(max)) return { have: max, at: at(fits(max)?.t ?? 0), by: -1 };
  let lo = 0;
  let hi = max;
  while (hi - lo > 0.0005) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  const best = fits(lo);
  const over = fits(Math.min(max, lo + 0.002));
  return {
    have: Math.round(lo * 1000) / 1000,
    at: at(best && !Number.isNaN(best.t) ? best.t : 0),
    by: over?.by ?? -1,
  };
}

/** A square's outline: its near edge `s` wide centred at `c` along `d`, `s` deep along `n`. */
export function squareAt(c: Vec2, d: Vec2, n: Vec2, s: number): Vec2[] {
  return zoneOf(sideAt(c, d, n, s), s);
}
