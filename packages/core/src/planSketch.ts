import { furnitureKind, itemFootprint } from './furniture';
import { doorLeaf, doorSwing, planGeometry } from './plan';
import { roomShapes } from './rooms';
import { type SceneCamera, cameraFrame } from './sceneFacts';
import { type Level, type Vec2, isBoundary, isGlass, isHalfWall } from './schema';
import { type Segment, rayDistance } from './walk';

/**
 * The floor plan as a plain drawing for an image model, with where the camera stands and
 * what it sees: so a model making one view real knows the home around it (a doorway at the
 * picture's edge, the room beyond an opening) and doesn't close or invent what the plan
 * has or hasn't. Plan (x, y) as drawn, y down. No text: the colours are explained in the
 * prompt (SKETCH_KEY).
 */
export const SKETCH_COLOURS = {
  background: '#ffffff',
  floor: '#ececec',
  wall: '#111111',
  half: '#8a8a8a',
  glass: '#4aa3ff',
  window: '#4aa3ff',
  door: '#9a6a3a',
  furniture: '#9a9a9a',
  camera: '#e0201b',
} as const;

/** What the colours mean, for the prompt. */
export const SKETCH_KEY =
  'black is solid wall; grey is a half-height wall; blue across a wall is a window, a thin blue line a glass wall; brown is a door (with its swing); a gap in a wall with nothing in it is an opening with no door; light grey is floor; thin grey outlines are furniture; the red dot is the camera and the red shaded area the floor it sees.';

/** How far the camera's wedge reaches, metres (it shows the direction, not the depth). */
const WEDGE = 6;

const pts = (ps: readonly Vec2[]) => ps.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' ');

/**
 * The plan of `level` as an SVG document, `px` pixels on its longer side, with camera `c`
 * drawn on it: its position and the part of the floor in its view (a wedge looking across
 * a room, or where the picture's corners meet the floor from above).
 */
export function planSketch(
  level: Level,
  c: SceneCamera,
  px = 1024,
  /** Width over height to pad the drawing to (the view's), so it never sets a render's shape. */
  aspect?: number,
): { svg: string; width: number; height: number } {
  const geom = planGeometry(level);
  const shapes = roomShapes(level);
  const xs: number[] = [];
  const ys: number[] = [];
  const grow = (q: Vec2) => {
    xs.push(q.x);
    ys.push(q.y);
  };
  for (const p of geom.pieces) for (const q of p.polygon) grow(q);
  for (const s of shapes.values()) for (const q of s.outer) grow(q);
  if (!xs.length) grow({ x: 0, y: 0 });
  // The home, with room around it for a camera standing just outside; a camera further off
  // (an orbit view) is drawn at the border, never stretching the home small.
  const margin = 0.6;
  const reach = 1.5;
  const hx0 = Math.min(...xs);
  const hy0 = Math.min(...ys);
  const hx1 = Math.max(...xs);
  const hy1 = Math.max(...ys);
  const raw = { x: c.position.x, y: c.position.z };
  const eye = {
    x: Math.min(hx1 + reach, Math.max(hx0 - reach, raw.x)),
    y: Math.min(hy1 + reach, Math.max(hy0 - reach, raw.y)),
  };
  let x0 = Math.min(hx0, eye.x) - margin;
  let y0 = Math.min(hy0, eye.y) - margin;
  let w = Math.max(hx1, eye.x) + margin - x0;
  let h = Math.max(hy1, eye.y) + margin - y0;
  if (aspect && aspect > 0) {
    // Padded evenly to the view's shape.
    if (w / h < aspect) {
      const nw = h * aspect;
      x0 -= (nw - w) / 2;
      w = nw;
    } else {
      const nh = w / aspect;
      y0 -= (nh - h) / 2;
      h = nh;
    }
  }
  const k = px / Math.max(w, h);
  const width = Math.round(w * k);
  const height = Math.round(h * k);
  const C = SKETCH_COLOURS;
  const line = 0.035; // metres: thin lines that stay visible when scaled down

  const out: string[] = [];
  out.push(`<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="${C.background}"/>`);
  for (const s of shapes.values()) {
    out.push(`<polygon points="${pts(s.outer)}" fill="${C.floor}"/>`);
    for (const hole of s.holes) {
      out.push(`<polygon points="${pts(hole)}" fill="${C.background}"/>`);
    }
  }
  // Furniture under the walls, thin outlines.
  for (const item of Object.values(level.items)) {
    const kind = furnitureKind(item.assetId);
    if (kind?.category === 'People') continue;
    out.push(
      `<polygon points="${pts(itemFootprint(item, kind))}" fill="none" stroke="${C.furniture}" stroke-width="${line}"/>`,
    );
  }
  for (const p of geom.pieces) {
    const wall = level.walls[p.wallId];
    if (!wall || isBoundary(wall)) continue;
    if (isGlass(wall)) {
      // Its outline, thin, where the glass stands.
      out.push(
        `<polygon points="${pts(p.polygon)}" fill="${C.background}" stroke="${C.glass}" stroke-width="${line}"/>`,
      );
      continue;
    }
    const fill = isHalfWall(wall, level.ceilingHeight) ? C.half : C.wall;
    out.push(`<polygon points="${pts(p.polygon)}" fill="${fill}"/>`);
  }
  for (const h of geom.footprints.hubs) {
    out.push(`<polygon points="${pts(h.polygon)}" fill="${C.wall}"/>`);
  }
  for (const o of geom.openings) {
    if (o.kind === 'window') {
      out.push(`<polygon points="${pts(o.polygon)}" fill="${C.window}"/>`);
    } else if (o.kind === 'door') {
      const style = o.opening.style ?? 'swing';
      if (style === 'swing') {
        // The leaf standing open and its arc, as a plan draws a door.
        const s = doorSwing(o.frame, o.opening);
        out.push(
          `<polygon points="${pts(doorLeaf(o.frame, o.opening, true))}" fill="${C.door}"/>`,
          `<path d="M ${s.leafEnd.x} ${s.leafEnd.y} A ${s.radius} ${s.radius} 0 0 ${s.sweep} ${s.arcEnd.x} ${s.arcEnd.y}" fill="none" stroke="${C.door}" stroke-width="${line}"/>`,
        );
      } else {
        // Sliding, folding and the rest: the doorway with its leaves shut across it.
        out.push(
          `<polygon points="${pts(doorLeaf(o.frame, o.opening, false))}" fill="${C.door}" stroke="${C.door}" stroke-width="${line * 2}"/>`,
        );
      }
    }
    // A passage is left as a gap in the wall.
  }
  // What blocks sight at eye height: full-height solid walls and windows (glass, half walls
  // and doorways are seen through).
  const sight: Segment[] = [];
  const ring = (poly: readonly Vec2[]) =>
    poly.forEach((a, i) => sight.push({ a, b: poly[(i + 1) % poly.length] as Vec2 }));
  for (const p of geom.pieces) {
    const wall = level.walls[p.wallId];
    if (wall && !isGlass(wall) && !isHalfWall(wall, level.ceilingHeight)) ring(p.polygon);
  }
  for (const h of geom.footprints.hubs) ring(h.polygon);
  for (const o of geom.openings) if (o.kind === 'window') ring(o.polygon);
  out.push(cameraMarks(c, level, sight, line, eye, { x0, y0, x1: x0 + w, y1: y0 + h }));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x0} ${y0} ${w} ${h}">${out.join('')}</svg>`;
  return { svg, width, height };
}

/** The floor a picture's corner ray reaches at most, metres (one near the horizon). */
const FAR = 30;

type Box = { x0: number; y0: number; x1: number; y1: number };

/** `poly` cut to the box (Sutherland–Hodgman). */
function clipToBox(poly: Vec2[], b: Box): Vec2[] {
  const edges: [(p: Vec2) => number][] = [
    [(p) => p.x - b.x0],
    [(p) => b.x1 - p.x],
    [(p) => p.y - b.y0],
    [(p) => b.y1 - p.y],
  ];
  let out = poly;
  for (const [inside] of edges) {
    const src = out;
    out = [];
    src.forEach((p, i) => {
      const q = src[(i + 1) % src.length] as Vec2;
      const a = inside(p);
      const bq = inside(q);
      if (a >= 0) out.push(p);
      if (a >= 0 !== bq >= 0) {
        const t = a / (a - bq);
        out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      }
    });
    if (!out.length) break;
  }
  return out;
}

/**
 * The camera's dot and the floor it sees. Below the ceiling looking across: a wedge between
 * the picture's left and right edges, stopped by the walls (so it shows what the picture
 * can and can't see past). From above the walls (an orbit or cut-away view) or looking
 * down: where the picture's corners meet the floor. Both cut to the drawing; a camera off
 * the drawing is marked at its border (`eye`).
 */
function cameraMarks(
  c: SceneCamera,
  level: Level,
  sight: Segment[],
  line: number,
  eye: Vec2,
  box: Box,
): string {
  const f = cameraFrame(c);
  const C = SKETCH_COLOURS;
  const floorY = level.elevation;
  const at = { x: c.position.x, y: c.position.z };
  const flat = Math.hypot(f.forward.x, f.forward.z);
  const below = c.position.y - floorY < level.ceilingHeight;
  let area: Vec2[];
  if (below && flat > 0.3) {
    const half = Math.atan(f.tanX);
    const h0 = Math.atan2(f.forward.z, f.forward.x);
    area = [at];
    const n = 48;
    for (let i = 0; i <= n; i++) {
      const a = h0 - half + (2 * half * i) / n;
      const d = { x: Math.cos(a), y: Math.sin(a) };
      const r = Math.min(WEDGE, rayDistance(sight, at, d));
      area.push({ x: at.x + d.x * r, y: at.y + d.y * r });
    }
  } else {
    area = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([sx, sy]) => {
      const a = sx as number;
      const b = sy as number;
      const d = {
        x: f.forward.x + f.right.x * f.tanX * a + f.up.x * f.tanY * b,
        y: f.forward.y + f.right.y * f.tanX * a + f.up.y * f.tanY * b,
        z: f.forward.z + f.right.z * f.tanX * a + f.up.z * f.tanY * b,
      };
      const flatLen = Math.hypot(d.x, d.z) || 1e-9;
      // Where it meets the floor, or (above the horizon) far out the same way.
      const t = d.y < -1e-6 ? (floorY - c.position.y) / d.y : Number.POSITIVE_INFINITY;
      const l = Math.min(FAR, flatLen * t);
      return { x: at.x + (d.x / flatLen) * l, y: at.y + (d.z / flatLen) * l };
    });
  }
  const shown = clipToBox(area, box);
  const r = 0.18;
  return [
    shown.length >= 3
      ? `<polygon points="${pts(shown)}" fill="${C.camera}" fill-opacity="0.18" stroke="${C.camera}" stroke-width="${line}"/>`
      : '',
    `<circle cx="${eye.x}" cy="${eye.y}" r="${r}" fill="${C.camera}"/>`,
  ].join('');
}
