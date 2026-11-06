/**
 * The exact render's one quality setting in slice 1, "Good": 256 samples, the picture 1600 px
 * on its long side on a desktop and 1280 on a phone, stopping at 90 s (desktop) or 120 s
 * (phone) if the samples aren't done by then. Phones also trace fewer bounces.
 */
export interface ExactSettings {
  samples: number;
  /** The picture's long side, px. */
  long: number;
  /** Drawing stops here, ms. */
  cap: number;
  bounces: number;
  transmissiveBounces: number;
  /** Textures are packed at this size (the models' own are 512 px). */
  textureSize: number;
  /** For tests: the picture fitted inside this box (px), keeping its shape. */
  box?: { width: number; height: number };
}

/** A test's override (Playwright sets it before the app loads): a small, quick picture. */
export interface ExactTestOverride {
  width?: number;
  height?: number;
  samples?: number;
}

declare global {
  interface Window {
    __DHD_EXACT_TEST__?: ExactTestOverride;
  }
}

export const GOOD = {
  samples: 256,
  desktopLong: 1600,
  phoneLong: 1280,
  desktopCap: 90_000,
  phoneCap: 120_000,
};

/** A phone: a coarse pointer, or a screen under 900 px wide. */
export function isPhone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(pointer: coarse)').matches || window.innerWidth < 900;
}

export function exactSettings(phone: boolean, test?: ExactTestOverride): ExactSettings {
  const s: ExactSettings = {
    samples: test?.samples ?? GOOD.samples,
    long: phone ? GOOD.phoneLong : GOOD.desktopLong,
    cap: phone ? GOOD.phoneCap : GOOD.desktopCap,
    bounces: phone ? 3 : 5,
    transmissiveBounces: 6,
    textureSize: 512,
  };
  if (test?.width && test.height) s.box = { width: test.width, height: test.height };
  return s;
}

/**
 * The picture's size in whole pixels for a view `aspect` (width over height) wide: `long` on
 * its long side, or fitted inside `box`.
 */
export function renderSize(
  aspect: number,
  long: number,
  box?: { width: number; height: number },
): { width: number; height: number } {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  let w = a >= 1 ? long : long * a;
  let h = a >= 1 ? long / a : long;
  if (box) {
    const k = Math.min(1, box.width / w, box.height / h);
    w *= k;
    h *= k;
  }
  return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
}
