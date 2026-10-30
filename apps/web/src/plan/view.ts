import type { Bounds, Vec2 } from '@dhd/core';

/** The 2D camera: the world point at the centre of the canvas, and pixels per metre. */
export interface View {
  cx: number;
  cy: number;
  zoom: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MIN_ZOOM = 8;
export const MAX_ZOOM = 800;

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export function worldToScreen(v: View, size: Size, p: Vec2): Vec2 {
  return { x: (p.x - v.cx) * v.zoom + size.width / 2, y: (p.y - v.cy) * v.zoom + size.height / 2 };
}

export function screenToWorld(v: View, size: Size, p: Vec2): Vec2 {
  return { x: (p.x - size.width / 2) / v.zoom + v.cx, y: (p.y - size.height / 2) / v.zoom + v.cy };
}

/** Zooms by `factor` keeping the world point under `screen` fixed. */
export function zoomAt(v: View, size: Size, screen: Vec2, factor: number): View {
  const zoom = clampZoom(v.zoom * factor);
  const before = screenToWorld(v, size, screen);
  const after = screenToWorld({ ...v, zoom }, size, screen);
  return { zoom, cx: v.cx + before.x - after.x, cy: v.cy + before.y - after.y };
}

export function panBy(v: View, dxScreen: number, dyScreen: number): View {
  return { ...v, cx: v.cx - dxScreen / v.zoom, cy: v.cy - dyScreen / v.zoom };
}

/** A view that shows `b` with `padding` pixels to spare on every side. */
export function fitBounds(b: Bounds | null, size: Size, padding = 48): View {
  if (!b || size.width <= 0 || size.height <= 0) return { cx: 0, cy: 0, zoom: 50 };
  const w = Math.max(b.max.x - b.min.x, 1);
  const h = Math.max(b.max.y - b.min.y, 1);
  const zoom = clampZoom(Math.min((size.width - 2 * padding) / w, (size.height - 2 * padding) / h));
  return { cx: (b.min.x + b.max.x) / 2, cy: (b.min.y + b.max.y) / 2, zoom };
}

/** Grid spacing in metres that keeps minor lines at least `minPx` apart. */
export function gridStep(zoom: number, minPx = 12): { minor: number; major: number } {
  for (const minor of [0.1, 0.5, 1, 5, 10]) {
    if (minor * zoom >= minPx) return { minor, major: minor === 0.1 ? 1 : minor * 5 };
  }
  return { minor: 10, major: 50 };
}
