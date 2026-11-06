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
  'black is solid wall; grey is a half-height wall; blue across a wall is a window, a thin blue line a glass wall; brown is a door (with its swing); a gap in a wall with nothing in it is an opening with no door; light grey is floor; thin grey outlines are furniture; the red dot and wedge are the camera and what it sees.';

/** How far the camera's wedge reaches, metres (it shows the direction, not the depth). */
const WEDGE = 6;

const pts = (ps: readonly Vec2[]) => ps.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' ');

/**
 * The plan of `level` as an SVG document, `px` pixels on its longer side, with camera `c`
 * drawn on it: its position and the part of the floor in its view (a wedge looking across
 * a room, or where the picture's corners meet the floor looking down).
 */
export function planSketch(
  level: Level,
  c: SceneCamera,
  px = 1024,
): { svg: string; width: number; height: number } {
  const geom = planGeometry(level);
  const shapes = roomShapes(level);
  const xs: number[] = [];
  const ys: number[] = [];
  const grow = (p: Vec2) => {
    xs.push(p.x);
    ys.push(p.y);
  };
  for (const p of geom.pieces) for (const q of p.polygon) grow(q);
  for (const s of shapes.values()) for (const q of s.outer) grow(q);
  // The camera itself, if it stands outside the walls.
  const eye = { x: c.position.x, y: c.position.z };
  grow(eye);
  if (!xs.length) grow({ x: 0, y: 0 });
  const margin = 0.6;
  const x0 = Math.min(...xs) - margin;
  const y0 = Math.min(...ys) - margin;
  const w = Math.max(...xs) + margin - x0;
  const h = Math.max(...ys) + margin - y0;
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
  out.push(cameraMarks(c, level, sight, line));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x0} ${y0} ${w} ${h}">${out.join('')}</svg>`;
  return { svg, width, height };
}

/**
 * The camera's dot and the floor it sees: across a room, a wedge stopped by the walls (so
 * it shows what the picture can and can't see past); looking down, where the picture's
 * corners meet the floor.
 */
function cameraMarks(c: SceneCamera, level: Level, sight: Segment[], line: number): string {
  const f = cameraFrame(c);
  const C = SKETCH_COLOURS;
  const floorY = level.elevation;
  const eye = { x: c.position.x, y: c.position.z };
  const flat = Math.hypot(f.forward.x, f.forward.z);
  const below = c.position.y - floorY < level.ceilingHeight;
  let area: Vec2[];
  if (flat > 0.7) {
    // Across the room: rays between the picture's left and right edges, to the first wall.
    const half = Math.atan(f.tanX);
    const h0 = Math.atan2(f.forward.z, f.forward.x);
    area = [eye];
    const n = 48;
    for (let i = 0; i <= n; i++) {
      const a = h0 - half + (2 * half * i) / n;
      const d = { x: Math.cos(a), y: Math.sin(a) };
      const r = Math.min(WEDGE, below ? rayDistance(sight, eye, d) : WEDGE);
      area.push({ x: eye.x + d.x * r, y: eye.y + d.y * r });
    }
  } else {
    // Looking down: where the picture's corners meet the floor (or reach far out).
    area = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([sx, sy]) => {
      const d = {
        x: f.forward.x + f.right.x * f.tanX * (sx as number) + f.up.x * f.tanY * (sy as number),
        y: f.forward.y + f.right.y * f.tanX * (sx as number) + f.up.y * f.tanY * (sy as number),
        z: f.forward.z + f.right.z * f.tanX * (sx as number) + f.up.z * f.tanY * (sy as number),
      };
      const t = d.y < -1e-3 ? (floorY - c.position.y) / d.y : WEDGE * 4;
      const l = Math.hypot(d.x, d.z) * t;
      const s = l > WEDGE * 4 ? (WEDGE * 4) / l : 1;
      return { x: eye.x + d.x * t * s, y: eye.y + d.z * t * s };
    });
  }
  const r = 0.18;
  return [
    `<polygon points="${pts(area)}" fill="${C.camera}" fill-opacity="0.18" stroke="${C.camera}" stroke-width="${line}"/>`,
    `<circle cx="${eye.x}" cy="${eye.y}" r="${r}" fill="${C.camera}"/>`,
  ].join('');
}
