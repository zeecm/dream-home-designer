import { useSyncExternalStore } from 'react';

/**
 * The walk-through's field of view, as wide as the eye sees: set across the view (not up
 * and down, as three.js counts it), so a narrow view (the split screen, a phone held upright)
 * gets the same width across as a wide one. People see about 114–120° across with both eyes;
 * 110° by default, 60–120° on the slider, on every screen. It can be changed while walking,
 * and the choice is remembered in this browser.
 */

export const FOV_MIN = 60;
export const FOV_MAX = 120;
export const FOV_DEFAULT = 110;
/**
 * Up and down, a phone held upright at 120° across would need about 150°: as far as a camera
 * sensibly goes (three.js breaks down near 180°).
 */
const MAX_VERTICAL = 150;

// A new key: choices made while a tall view capped the slider (about 70°) aren't kept.
const KEY = 'dhd-walk-fov-2';
const listeners = new Set<() => void>();

const clamp = (v: number) => Math.min(FOV_MAX, Math.max(FOV_MIN, v));

function stored(): number {
  try {
    const raw = window.localStorage.getItem(KEY);
    const v = Number(raw);
    return raw !== null && Number.isFinite(v) && v > 0 ? clamp(v) : FOV_DEFAULT;
  } catch {
    return FOV_DEFAULT;
  }
}

let fov = typeof window === 'undefined' ? FOV_DEFAULT : stored();

export function setWalkFov(value: number) {
  fov = clamp(value);
  try {
    window.localStorage.setItem(KEY, String(fov));
  } catch {
    // Private windows may refuse; the choice holds for this visit.
  }
  for (const fn of listeners) fn();
}

/** The field of view across, in degrees, as React state. */
export function useWalkFov(): number {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => fov,
  );
}

/** The camera's (vertical) angle for `across` degrees across a view of this aspect. */
export function verticalFov(across: number, aspect: number): number {
  const half = (across * Math.PI) / 360;
  const v = (2 * Math.atan(Math.tan(half) / Math.max(aspect, 0.01)) * 180) / Math.PI;
  return Math.min(v, MAX_VERTICAL);
}
