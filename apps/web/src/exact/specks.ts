/**
 * The exact render's speck spread (`pathtracer.ts` runs it on the GPU): a speck is a pixel
 * more than `speckLimit` times as bright as the median of the eight around it (true light
 * found by chance, too rarely to average out yet: the sun's patch on a floor, seen off a
 * wall). It keeps that much and its excess is spread softly over the pixels about it that
 * look like it, so the picture keeps all its light. This is the kernel in TypeScript, kept
 * in step with the shaders, for its tests.
 */

/** How many times its neighbours' median a pixel may be, at first. */
export const SPECK = 2.5;
/** How widely a speck's light is spread: a Gaussian this fraction of the picture's width. */
export const SPREAD = 1 / 40;

/**
 * The limit after `samples` samples: SPECK up to Good's 256 (specks still stand out there:
 * 2% of pixels in the sample flat's living room at 4 pm), then loosening with the square of the
 * samples (10 at 512, 40 at 1024), so a real thin highlight (a sun sliver, a bulb, a glint, a
 * window's corner) stands once the picture has settled. 0: none spread.
 */
export function speckLimit(speck: number, samples: number): number {
  if (!(speck > 0)) return Number.POSITIVE_INFINITY;
  return speck * Math.max(1, samples / 256) ** 2;
}

/** The spread's σ in pixels for a picture `width` across (at least 1). */
export const spreadSigma = (width: number) => Math.max(1, width * SPREAD);

/** An index off 0 … n − 1 mirrored back in at the edge (−1 → 0, n → n − 1), then held in. */
const mirror = (i: number, n: number) =>
  Math.min(n - 1, Math.max(0, i < 0 ? -i - 1 : i > n - 1 ? 2 * n - 1 - i : i));

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Spreads the specks of `rgb` (w × h, 3 numbers a pixel, rows in order): as the shaders do.
 * Returns the picture with its specks spread.
 */
export function spreadSpecks(
  rgb: Float32Array,
  w: number,
  h: number,
  limit: number,
  sigma: number,
): Float32Array {
  const n = w * h;
  const finite = (v: number) => (Number.isFinite(v) ? Math.max(0, v) : 0);
  const src = Float32Array.from(rgb, finite);
  // A pixel with any channel not finite counts as black (as the shader's `at`).
  for (let i = 0; i < n; i++) {
    if (![0, 1, 2].every((c) => Number.isFinite(rgb[i * 3 + c] ?? 0))) {
      src[i * 3] = src[i * 3 + 1] = src[i * 3 + 2] = 0;
    }
  }
  // Off the picture, the pixel across from it (−1 → 1), so a pixel at the edge is never its
  // own neighbour (as the shader).
  const across = (i: number, m: number) =>
    Math.min(m - 1, Math.max(0, i < 0 ? -i : i > m - 1 ? 2 * (m - 1) - i : i));
  const at = (x: number, y: number, c: number) =>
    src[(across(y, h) * w + across(x, w)) * 3 + c] ?? 0;
  const kept = new Float32Array(n * 3);
  const excess = new Float32Array(n * 3);
  const look = new Float32Array(n * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v: number[] = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx || dy)
            v.push(lum(at(x + dx, y + dy, 0), at(x + dx, y + dy, 1), at(x + dx, y + dy, 2)));
        }
      }
      v.sort((a, b) => a - b);
      const cap = limit * Math.max(0.5 * ((v[3] ?? 0) + (v[4] ?? 0)), 1e-4);
      const i = y * w + x;
      const c = [at(x, y, 0), at(x, y, 1), at(x, y, 2)] as const;
      const l = lum(...c);
      const s = l > cap ? cap / l : 1;
      const kl = l * s;
      c.forEach((v, k) => {
        kept[i * 3 + k] = v * s;
        excess[i * 3 + k] = v - v * s;
        look[i * 4 + k] = (v * s) / Math.max(kl, 1e-6);
      });
      look[i * 4 + 3] = Math.log2(Math.max(kl, 1e-6));
    }
  }
  const alike = (a: number, b: number) => {
    let dc = 0;
    for (let k = 0; k < 3; k++) dc += ((look[a * 4 + k] ?? 0) - (look[b * 4 + k] ?? 0)) ** 2;
    const dw = (look[a * 4 + 3] ?? 0) - (look[b * 4 + 3] ?? 0);
    return Math.exp(-(0.1 * dw * dw + 2 * dc) / (2 * 0.6 * 0.6));
  };
  const r = Math.ceil(3 * sigma);
  const axis = (from: Float32Array, dx: number, dy: number) => {
    // Divided by the weights each pixel hands out, then gathered.
    const weights = (x: number, y: number, each: (q: number, k: number) => void) => {
      for (let i = -r; i <= r; i++) {
        // Off the picture, mirrored back in at its edge (as the shader).
        const qx = mirror(x + dx * i, w);
        const qy = mirror(y + dy * i, h);
        const q = qy * w + qx;
        each(q, Math.exp(-(i * i) / (2 * sigma * sigma)) * alike(y * w + x, q));
      }
    };
    const norm = new Float32Array(n * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        weights(x, y, (_, k) => {
          sum += k;
        });
        const p = y * w + x;
        for (let c = 0; c < 3; c++) norm[p * 3 + c] = (from[p * 3 + c] ?? 0) / Math.max(sum, 1e-6);
      }
    }
    const out = new Float32Array(n * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        weights(x, y, (q, k) => {
          for (let c = 0; c < 3; c++)
            out[p * 3 + c] = (out[p * 3 + c] ?? 0) + k * (norm[q * 3 + c] ?? 0);
        });
      }
    }
    return out;
  };
  const spread = axis(axis(excess, 1, 0), 0, 1);
  return kept.map((v, i) => v + (spread[i] ?? 0));
}
