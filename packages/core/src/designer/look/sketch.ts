import { furnitureKind, itemFootprint } from '../../furniture';
import { placeLabel } from '../../geometry';
import { doorLeaf, doorSwing, planGeometry } from '../../plan';
import { roomArea, roomShapes } from '../../rooms';
import type { Item, Level, Vec2 } from '../../schema';
import { isBoundary, isGlass, isHalfWall } from '../../schema';
import { type AliasMap, aliasOf } from '../aliases';
import type { DesignResult } from '../result';
import { roomIdAt } from '../spaces';
import { clean } from '../util';

/**
 * The second look's picture (tech 3b §2.2): the version as placed, drawn as a plan for a model
 * to look at. Walls, doors and windows; furniture outlines labelled with their short ids (the
 * ones the findings must use) and short names; rooms with their ids, names and areas; the
 * pinches and the room short in front of a piece as dimension lines with their figure; what
 * the version adds or moves in a second colour and what it takes away dashed; a scale bar and,
 * when the site has one, north. Pure: the same input gives the same bytes. Text is our own
 * short ids and the plan's names, cleaned and escaped; nothing a person typed elsewhere.
 */

/** The long side of a picture, px: Claude's largest before it scales down. */
export const LOOK_PX = 1568;
/** Below this, a piece's label is too small to read: the scope is drawn in two pictures. */
export const MIN_PX_PER_M = 30;
/** Room round the scope, metres. */
const AROUND = 1;
/**
 * Labels this near a picture's edge are left to the other half of a split (the halves overlap
 * by twice this): none is cut in two, or piled up at the split.
 */
const LABEL_INSET = 0.25;

export const LOOK_COLOURS = {
  background: '#ffffff',
  floor: '#efefef',
  scope: '#e3ecf7',
  wall: '#111111',
  half: '#8a8a8a',
  glass: '#2b7bd6',
  window: '#2b7bd6',
  door: '#9a6a3a',
  piece: '#555555',
  changed: '#0b7a3b',
  removed: '#c0392b',
  pinch: '#d0021b',
  zone: '#d97706',
  text: '#111111',
} as const;

/** What the colours mean, said in the request. */
export const LOOK_KEY =
  'Black is wall, grey a half-height wall, blue a window or glass; brown is a door with its swing. Rooms are labelled with their id, name and area; the rooms this proposal designs are tinted blue. Furniture is outlined and labelled with its id and name: green is new or moved in this proposal, grey stays as it is, red dashed was taken out. Red lines with a figure mark where a way through narrows; orange shows a piece short of the room in front of it, with the room there is.';

export interface LookImage {
  svg: string;
  width: number;
  height: number;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** What a piece is, in two words or so: "sofa", "dining table". */
const shortName = (it: Item) => {
  const k = furnitureKind(it.assetId);
  const name = (k?.name ?? it.assetId).split(',')[0] ?? '';
  return clean(name.toLowerCase(), 18);
};

const centre = (it: Item): Vec2 => ({ x: it.position.x, y: it.position.z });
const moved = (a: Item, b: Item) =>
  a.assetId !== b.assetId ||
  Math.abs(a.position.x - b.position.x) > 0.01 ||
  Math.abs(a.position.z - b.position.z) > 0.01 ||
  Math.abs(a.rotationY - b.rotationY) > 1e-3 ||
  Math.abs(a.scale.x - b.scale.x) > 1e-3;

/**
 * The pictures of a version's scope: its rooms (and 1 m round them), or the whole flat when
 * `scope` is null. One picture `LOOK_PX` on its long side; when that leaves under 30 px a
 * metre, two, each half the scope (at most two).
 */
export function critiqueSketch(
  result: DesignResult,
  start: Level,
  o: { aliases: AliasMap; scope: string[] | null; north?: number | null },
): LookImage[] {
  const level = result.level;
  const shapes = roomShapes(level);
  const geom = planGeometry(level);
  return framesOf(level, o.scope).map((b) => draw(result, start, o, b, shapes, geom));
}

/** The size of each picture the second look draws of `scope` on `level` (as `critiqueSketch`). */
export function lookPictureSizes(
  level: Level,
  scope: string[] | null,
): { width: number; height: number }[] {
  return framesOf(level, scope).map((b) => {
    const k = LOOK_PX / Math.max(b.x1 - b.x0, b.y1 - b.y0);
    return { width: Math.round((b.x1 - b.x0) * k), height: Math.round((b.y1 - b.y0) * k) };
  });
}

/** The plan areas the pictures show: the scope and 1 m round it, in halves when too large. */
function framesOf(level: Level, scope: string[] | null): Box[] {
  const shapes = roomShapes(level);
  const geom = planGeometry(level);
  const o = { scope };
  const all: Vec2[] = [];
  for (const p of geom.pieces) all.push(...p.polygon);
  for (const s of shapes.values()) all.push(...s.outer);
  const scoped = o.scope?.length ? o.scope.flatMap((id) => shapes.get(id)?.outer ?? []) : all;
  const pts = scoped.length ? scoped : all.length ? all : [{ x: 0, y: 0 }];
  const box: Box = {
    x0: Math.min(...pts.map((p) => p.x)) - (o.scope?.length ? AROUND : 0.5),
    y0: Math.min(...pts.map((p) => p.y)) - (o.scope?.length ? AROUND : 0.5),
    x1: Math.max(...pts.map((p) => p.x)) + (o.scope?.length ? AROUND : 0.5),
    y1: Math.max(...pts.map((p) => p.y)) + (o.scope?.length ? AROUND : 0.5),
  };
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const boxes: Box[] = [];
  if (LOOK_PX / Math.max(w, h) >= MIN_PX_PER_M) boxes.push(box);
  else if (w >= h) {
    // Two halves across the longer side, overlapping by half a metre.
    const mid = box.x0 + w / 2;
    boxes.push({ ...box, x1: mid + 0.25 }, { ...box, x0: mid - 0.25 });
  } else {
    const mid = box.y0 + h / 2;
    boxes.push({ ...box, y1: mid + 0.25 }, { ...box, y0: mid - 0.25 });
  }
  return boxes;
}

function draw(
  result: DesignResult,
  start: Level,
  o: { aliases: AliasMap; scope: string[] | null; north?: number | null },
  b: Box,
  shapes: ReturnType<typeof roomShapes>,
  geom: ReturnType<typeof planGeometry>,
): LookImage {
  const level = result.level;
  const C = LOOK_COLOURS;
  const bw = b.x1 - b.x0;
  const bh = b.y1 - b.y0;
  const k = LOOK_PX / Math.max(bw, bh);
  const width = Math.round(bw * k);
  const height = Math.round(bh * k);
  const X = (x: number) => ((x - b.x0) * k).toFixed(1);
  const Y = (y: number) => ((y - b.y0) * k).toFixed(1);
  const poly = (ps: readonly Vec2[]) => ps.map((p) => `${X(p.x)},${Y(p.y)}`).join(' ');
  const of = aliasOf(o.aliases);
  const scope = new Set(o.scope ?? Object.keys(level.rooms));
  const out: string[] = [];
  const label = (at: Vec2, lines: string[], size: number, colour: string = C.text) => {
    const inside =
      at.x >= b.x0 + LABEL_INSET &&
      at.x <= b.x1 - LABEL_INSET &&
      at.y >= b.y0 + LABEL_INSET &&
      at.y <= b.y1 - LABEL_INSET;
    if (!inside) return;
    const x = X(at.x);
    const y0 = (at.y - b.y0) * k - ((lines.length - 1) * size * 1.15) / 2;
    lines.forEach((l, i) => {
      out.push(
        `<text x="${x}" y="${(y0 + i * size * 1.15).toFixed(1)}" font-family="sans-serif" font-size="${size}" text-anchor="middle" dominant-baseline="middle" fill="${colour}" stroke="#ffffff" stroke-width="3" paint-order="stroke">${esc(l)}</text>`,
      );
    });
  };

  out.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${C.background}"/>`);
  const roomIds = Object.keys(level.rooms).sort();
  for (const id of roomIds) {
    const s = shapes.get(id);
    if (!s) continue;
    out.push(`<polygon points="${poly(s.outer)}" fill="${scope.has(id) ? C.scope : C.floor}"/>`);
    for (const hole of s.holes)
      out.push(`<polygon points="${poly(hole)}" fill="${C.background}"/>`);
  }
  // What the version took out: dashed, under what it put in.
  const items = Object.values(level.items).sort((p, q) => (p.id < q.id ? -1 : 1));
  // (A ceiling light is no piece on the floor: left out, as it is from the labels.)
  const onFloor = (it: Item) => {
    const kind = furnitureKind(it.assetId);
    return kind?.category !== 'People' && !kind?.ceiling;
  };
  for (const it of Object.values(start.items).sort((p, q) => (p.id < q.id ? -1 : 1))) {
    if (level.items[it.id] || !onFloor(it)) continue;
    out.push(
      `<polygon points="${poly(itemFootprint(it))}" fill="none" stroke="${C.removed}" stroke-width="2" stroke-dasharray="6 4"/>`,
    );
  }
  for (const it of items) {
    const kind = furnitureKind(it.assetId);
    if (!onFloor(it)) continue;
    const was = start.items[it.id];
    const changed = !was || moved(it, was);
    out.push(
      `<polygon points="${poly(itemFootprint(it, kind))}" fill="${changed ? '#e6f4ea' : '#f7f7f7'}" stroke="${changed ? C.changed : C.piece}" stroke-width="${changed ? 2.5 : 1.5}"/>`,
    );
  }
  for (const p of geom.pieces) {
    const wall = level.walls[p.wallId];
    if (!wall || isBoundary(wall)) continue;
    if (isGlass(wall)) {
      out.push(
        `<polygon points="${poly(p.polygon)}" fill="${C.background}" stroke="${C.glass}" stroke-width="2"/>`,
      );
      continue;
    }
    out.push(
      `<polygon points="${poly(p.polygon)}" fill="${isHalfWall(wall, level.ceilingHeight) ? C.half : C.wall}"/>`,
    );
  }
  for (const hub of geom.footprints.hubs)
    out.push(`<polygon points="${poly(hub.polygon)}" fill="${C.wall}"/>`);
  for (const op of geom.openings) {
    if (op.kind === 'window')
      out.push(`<polygon points="${poly(op.polygon)}" fill="${C.window}"/>`);
    else if (op.kind === 'door') {
      if ((op.opening.style ?? 'swing') === 'swing') {
        const s = doorSwing(op.frame, op.opening);
        out.push(
          `<polygon points="${poly(doorLeaf(op.frame, op.opening, true))}" fill="${C.door}"/>`,
          `<path d="M ${X(s.leafEnd.x)} ${Y(s.leafEnd.y)} A ${(s.radius * k).toFixed(1)} ${(s.radius * k).toFixed(1)} 0 0 ${s.sweep} ${X(s.arcEnd.x)} ${Y(s.arcEnd.y)}" fill="none" stroke="${C.door}" stroke-width="1.5"/>`,
        );
      } else {
        out.push(
          `<polygon points="${poly(doorLeaf(op.frame, op.opening, false))}" fill="${C.door}"/>`,
        );
      }
    }
  }
  // The key gaps: where a way narrows (the pinch, with its width), and a piece short of the
  // room in front of it (the room there is).
  let clips = 0;
  for (const p of result.problems) {
    const i = p.issue;
    if (i?.kind === 'walkway') {
      const [a, c] = i.pinch;
      out.push(
        `<line x1="${X(a.x)}" y1="${Y(a.y)}" x2="${X(c.x)}" y2="${Y(c.y)}" stroke="${C.pinch}" stroke-width="3"/>`,
      );
      label({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 }, [`${i.have.toFixed(2)} m`], 14, C.pinch);
    } else if (i?.kind === 'zone') {
      // Clipped to the piece's room: the room it lacks is never drawn through a wall.
      const piece = p.itemId ? level.items[p.itemId] : undefined;
      const room = p.roomId ?? (piece ? roomIdAt(level, centre(piece)) : null);
      const shape = room ? shapes.get(room) : undefined;
      let clip = '';
      if (shape) {
        const id = `lookclip${++clips}`;
        out.push(`<clipPath id="${id}"><polygon points="${poly(shape.outer)}"/></clipPath>`);
        clip = ` clip-path="url(#${id})"`;
      }
      out.push(
        `<polygon points="${poly(i.zone)}" fill="none" stroke="${C.zone}" stroke-width="2" stroke-dasharray="5 3"${clip}/>`,
      );
      const z = i.zone;
      const m = z.reduce((t, q) => ({ x: t.x + q.x / z.length, y: t.y + q.y / z.length }), {
        x: 0,
        y: 0,
      });
      label(m, [`${i.have.toFixed(2)} m`], 13, C.zone);
    }
  }
  // Labels last, over everything: rooms (clear of the pieces' labels), then pieces.
  const pieceLabels = items.map((it) => ({ c: centre(it), r: 0.45 }));
  for (const id of roomIds) {
    const s = shapes.get(id);
    const r = level.rooms[id];
    if (!s || !r) continue;
    const at = placeLabel(s.outer, { x: 0.6, y: 0.25 }, pieceLabels, s.holes);
    const name = clean(r.name, 24);
    label(at, [`${of.get(id) ?? ''} ${name}`.trim(), `${roomArea(level, r).toFixed(1)} m²`], 15);
  }
  for (const it of items) {
    const kind = furnitureKind(it.assetId);
    if (kind?.category === 'People' || kind?.ceiling) continue;
    label(centre(it), [`${of.get(it.id) ?? ''} ${shortName(it)}`.trim()], 12);
  }
  // A 1 m scale bar, bottom left; north, top right, when the site has it.
  const sx = 16;
  const sy = height - 18;
  out.push(
    `<line x1="${sx}" y1="${sy}" x2="${(sx + k).toFixed(1)}" y2="${sy}" stroke="${C.text}" stroke-width="3"/>`,
    `<text x="${(sx + k / 2).toFixed(1)}" y="${sy - 8}" font-family="sans-serif" font-size="13" text-anchor="middle" fill="${C.text}">1 m</text>`,
  );
  if (typeof o.north === 'number') {
    const cx = width - 30;
    const cy = 34;
    const dx = Math.sin(o.north) * 18;
    const dy = -Math.cos(o.north) * 18;
    out.push(
      `<line x1="${(cx - dx).toFixed(1)}" y1="${(cy - dy).toFixed(1)}" x2="${(cx + dx).toFixed(1)}" y2="${(cy + dy).toFixed(1)}" stroke="${C.text}" stroke-width="2"/>`,
      `<text x="${(cx + dx * 1.5).toFixed(1)}" y="${(cy + dy * 1.5).toFixed(1)}" font-family="sans-serif" font-size="13" text-anchor="middle" dominant-baseline="middle" fill="${C.text}">N</text>`,
    );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${out.join('')}</svg>`;
  return { svg, width, height };
}
