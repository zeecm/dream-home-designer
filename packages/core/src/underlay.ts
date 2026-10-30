import type { Command } from './history';
import type { Underlay, Vec2 } from './schema';

/** Image pixels to plan metres: world = origin + R(rotation) · px · scale. */
export function underlayToWorld(u: Underlay, px: Vec2): Vec2 {
  const c = Math.cos(u.rotation);
  const s = Math.sin(u.rotation);
  return {
    x: u.origin.x + (c * px.x - s * px.y) * u.scale,
    y: u.origin.y + (s * px.x + c * px.y) * u.scale,
  };
}

export function worldToUnderlay(u: Underlay, w: Vec2): Vec2 {
  const c = Math.cos(u.rotation);
  const s = Math.sin(u.rotation);
  const dx = (w.x - u.origin.x) / u.scale;
  const dy = (w.y - u.origin.y) / u.scale;
  return { x: c * dx + s * dy, y: -s * dx + c * dy };
}

/**
 * A first placement for a freshly uploaded plan: centred on `centre`, `metresWide` across
 * (a guess until the user calibrates), half transparent so walls drawn over it stand out.
 */
export function placeUnderlay(
  assetKey: string,
  image: { width: number; height: number },
  centre: Vec2,
  metresWide = 14,
): Underlay {
  const scale = metresWide / Math.max(1, image.width);
  return {
    assetKey,
    opacity: 0.5,
    rotation: 0,
    scale,
    origin: { x: centre.x - (image.width * scale) / 2, y: centre.y - (image.height * scale) / 2 },
  };
}

export function setUnderlay(underlay: Underlay | null): Command {
  return {
    label: underlay ? 'Set plan image' : 'Remove plan image',
    recipe: (d) => {
      d.underlay = underlay;
    },
  };
}

export function setUnderlayOpacity(opacity: number): Command {
  const o = Math.min(1, Math.max(0, opacity));
  return {
    label: 'Change plan image opacity',
    recipe: (d) => {
      if (d.underlay) d.underlay.opacity = o;
    },
  };
}

/** Rotates the image to `rotation` (radians) about `pivot`, which stays where it is. */
export function rotateUnderlay(rotation: number, pivot: Vec2): Command {
  return {
    label: 'Rotate plan image',
    recipe: (d) => {
      const u = d.underlay;
      if (!u) return;
      const px = worldToUnderlay(u, pivot);
      u.rotation = rotation;
      const moved = underlayToWorld(u, px);
      u.origin = { x: u.origin.x + pivot.x - moved.x, y: u.origin.y + pivot.y - moved.y };
    },
  };
}

/**
 * Sets the image's scale so the two points the user clicked are `distance` metres apart.
 * The first point stays where it is on the plan, so walls already traced near it keep
 * lining up.
 */
export function calibrateUnderlay(p1: Vec2, p2: Vec2, distance: number): Command {
  const measured = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (!(distance > 0)) throw new Error('distance must be positive');
  if (measured < 1e-9) throw new Error('pick two different points');
  return {
    label: 'Calibrate plan image',
    recipe: (d) => {
      const u = d.underlay;
      if (!u) throw new Error('there is no plan image to calibrate');
      const px = worldToUnderlay(u, p1);
      u.scale *= distance / measured;
      const moved = underlayToWorld(u, px);
      u.origin = { x: u.origin.x + p1.x - moved.x, y: u.origin.y + p1.y - moved.y };
    },
  };
}
