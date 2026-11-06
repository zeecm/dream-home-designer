/**
 * The exact render's exposure, set once from the picture's log-average luminance (so it
 * doesn't pump as samples add up), the way a camera meters a scene: its average brought to
 * middle grey. Clamped to ±3 EV about what a room typically reads at that time of day (a
 * daylit room is a hundred times brighter than one lit by its lamps at night), so night
 * still looks like night and a sunlit room isn't crushed.
 */

/** Middle grey, where the average lands. */
export const KEY = 0.18;
/** A room's typical log-average luminance, cd/m²: by day (sun and sky) and at night (lamps). */
export const DAY_NITS = 1500;
export const NIGHT_NITS = 10;
/** How far auto exposure may go either way of the typical, in stops. */
export const MAX_EV = 3;

/** The exposure for a typical room at daylight `light` (0 night to 1 day), log-interpolated. */
export function baseExposure(light: number): number {
  const t = Math.min(1, Math.max(0, Number.isFinite(light) ? light : 1));
  return KEY / (NIGHT_NITS * (DAY_NITS / NIGHT_NITS) ** t);
}

/**
 * The exposure (a multiplier on the scene's light) for a picture of log-average `nits` at
 * daylight `light`.
 */
export function autoExposure(nits: number, light = 1): number {
  const base = baseExposure(light);
  if (!(nits > 0) || !Number.isFinite(nits)) return base;
  return Math.min(base * 2 ** MAX_EV, Math.max(base * 2 ** -MAX_EV, KEY / nits));
}

/**
 * The log-average (geometric mean) of luminances, cd/m², every `stride`th number from the
 * first; each at least `floor`, so a black patch doesn't drag the mean to nothing.
 */
export function logMean(values: ArrayLike<number>, stride = 1, floor = 1e-3): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < values.length; i += stride) {
    const l = values[i] as number;
    if (!Number.isFinite(l)) continue;
    sum += Math.log(Math.max(l, floor));
    n++;
  }
  return n ? Math.exp(sum / n) : 0;
}
