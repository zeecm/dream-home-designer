import {
  type Bounds,
  type DimensionChain,
  ELEC_KINDS,
  ELEC_KIND_ORDER,
  type ElecChanges,
  type ElecKind,
  type ElecPoint,
  type Level,
  type OpeningTag,
  PAPER_MM,
  type Paper,
  type PlanDimensions,
  type PlanGeometry,
  type Project,
  type RenovationDiff,
  type Room,
  SHEET_MM,
  type Variant,
  type Vec2,
  doorLeaves,
  doorStyle,
  doorSwing,
  electricalChanges,
  framePoint,
  furnitureKind,
  isGlass,
  isHalfWall,
  itemFootprint,
  itemSize,
  placeLabel,
  planDimensions,
  planExtent,
  planGeometry,
  pointInPolygon,
  pointName,
  pointPosition,
  pointRoom,
  renovationChanges,
  roomArea,
  roomShape,
  roomShapes,
  roundChain,
  sheetDrawingArea,
  sheetScale,
  trunkingMetres,
  trunkingPath,
  wallStatus,
} from '@dhd/core';
import type { ReactElement, ReactNode } from 'react';
import { atDefaultHeight } from '../electrical/electrical';
import { ElecGlyph } from '../electrical/glyph';
import { changesAsText } from '../ui/Renovation';
import { hackedPoints, sheetLevels } from './extent';
import { printFrame } from './frame';

/**
 * The plan for contractors: a measured drawing on A4 or A3, landscape, one SVG per page in
 * millimetres. Page 1 is the plan with its dimensions and a title column; page 2, for a
 * renovation's After, lists the changes room by room with ruled lines for notes. Always dark
 * on white, whatever the screen's theme, and drawn from the plan's geometry, not the screen.
 */

export interface SheetOptions {
  paper: Paper;
  /** Which version of the flat: the renovation's, or as it is now. */
  variant: Variant;
  /** Loose furniture as outlines; built-ins are always drawn. */
  furniture: boolean;
  /** An electrical plan page (and its schedule) after the plan. */
  electrical?: boolean;
}

// Colours for paper.
const INK = '#1b1e22';
const WALL = '#3b4046';
const HALF = '#9aa0a7';
const MUTED = '#5c636b';
const FAINT = '#a9afb6';
const HACK = '#c0392b';
const NEW = '#0f8288';
/** A new half wall: a light teal, with a teal edge. */
const NEW_HALF = '#9fd3d5';
const FONT = 'Helvetica, Arial, sans-serif';

/** Text sizes, mm. */
const DIM_TEXT = 2.2;
const TAG_TEXT = 1.9;
const NAME_TEXT = 2.6;
const AREA_TEXT = 2.1;

/** Rough advance width of text in our sans face, mm (digits about 0.56 em). */
const textWidth = (s: string, size: number, bold = false) => s.length * size * (bold ? 0.6 : 0.55);

/** White round text, so it reads over a line or a hatch without hiding the walls. */
const HALO = {
  stroke: '#ffffff',
  strokeWidth: 0.7,
  paintOrder: 'stroke',
  strokeLinejoin: 'round',
} as const;

const mm = (m: number) => String(Math.round(m * 1000));
const sqft = (m2: number) => Math.round(m2 * 10.7639);
const n2 = (v: number) => Number(v.toFixed(2));
const pts = (ps: readonly Vec2[]) => ps.map((p) => `${n2(p.x)},${n2(p.y)}`).join(' ');

/** Today, the way the sheet dates it: "6 November 2026". */
export const sheetDate = (d = new Date()) =>
  d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

interface Sheet {
  w: number;
  h: number;
  /** Plan metres to paper millimetres. */
  P: (v: Vec2) => Vec2;
  k: number;
  scale: number;
  fits: boolean;
}

function layout(paper: Paper, bounds: Bounds | null): Sheet {
  const { w, h } = PAPER_MM[paper];
  const b = bounds ?? { min: { x: 0, y: 0 }, max: { x: 1, y: 1 } };
  const { scale, fits } = sheetScale(b, paper);
  const k = 1000 / scale;
  const area = sheetDrawingArea(paper);
  const pw = (b.max.x - b.min.x) * k;
  const ph = (b.max.y - b.min.y) * k;
  const ox = SHEET_MM.margin + SHEET_MM.band + (area.w - pw) / 2;
  const oy = SHEET_MM.margin + SHEET_MM.band + (area.h - ph) / 2;
  return {
    w,
    h,
    k,
    scale,
    fits,
    P: (v) => ({ x: ox + (v.x - b.min.x) * k, y: oy + (v.y - b.min.y) * k }),
  };
}

// ---------------------------------------------------------------------------- the plan

function Walls({
  level,
  geom,
  sheet,
  guarded,
}: {
  level: Level;
  geom: PlanGeometry;
  sheet: Sheet;
  guarded: ReadonlySet<string>;
}) {
  const { P } = sheet;
  return (
    <g className="walls">
      {geom.pieces.map((p, i) => {
        const w = level.walls[p.wallId];
        if (!w) return null;
        const glass = isGlass(w);
        const half = isHalfWall(w, level.ceilingHeight);
        const fill = glass ? '#ffffff' : guarded.has(p.wallId) ? 'url(#hatch)' : half ? HALF : WALL;
        const poly = p.polygon.map(P);
        const [l0, l1, r1, r0] = poly;
        return (
          <g key={`${p.wallId}:${i}`} data-wall={p.wallId}>
            <polygon
              points={pts(poly)}
              fill={fill}
              // A hairline of its own colour closes the seams between pieces.
              stroke={glass || guarded.has(p.wallId) ? WALL : fill}
              strokeWidth={glass || guarded.has(p.wallId) ? 0.15 : 0.06}
            />
            {glass && l0 && l1 && r1 && r0 && (
              <line
                x1={n2((l0.x + r0.x) / 2)}
                y1={n2((l0.y + r0.y) / 2)}
                x2={n2((l1.x + r1.x) / 2)}
                y2={n2((l1.y + r1.y) / 2)}
                stroke={WALL}
                strokeWidth={0.12}
              />
            )}
          </g>
        );
      })}
      {geom.footprints.hubs.map((h) => (
        <polygon
          key={h.vertexId}
          points={pts(h.polygon.map(P))}
          fill={WALL}
          stroke={WALL}
          strokeWidth={0.06}
        />
      ))}
      {geom.boundaries.map((id) => {
        const f = geom.frames[id];
        if (!f) return null;
        const a = P(framePoint(f, 0, 0));
        const b = P(framePoint(f, f.length, 0));
        return (
          <line
            key={id}
            x1={n2(a.x)}
            y1={n2(a.y)}
            x2={n2(b.x)}
            y2={n2(b.y)}
            stroke={MUTED}
            strokeWidth={0.2}
            strokeDasharray="1.2 0.8"
          />
        );
      })}
    </g>
  );
}

/**
 * Doors (by how they open), windows and openings, over the gaps in the walls. One new in a
 * renovation (`added`) is drawn teal, and where it is cut into a wall that stays (`cut`), the
 * gap is hatched as hacking.
 */
function Openings({
  geom,
  sheet,
  added,
  cut,
}: {
  geom: PlanGeometry;
  sheet: Sheet;
  added: ReadonlySet<string>;
  cut: ReadonlySet<string>;
}) {
  const { P } = sheet;
  const line = (a: Vec2, b: Vec2, key: string, ink: string, dash?: string) => {
    const p = P(a);
    const q = P(b);
    return (
      <line
        key={key}
        x1={n2(p.x)}
        y1={n2(p.y)}
        x2={n2(q.x)}
        y2={n2(q.y)}
        stroke={ink}
        strokeWidth={0.22}
        strokeDasharray={dash}
      />
    );
  };
  const arc = (c: Vec2, from: Vec2, to: Vec2, key: string, arcInk: string) => {
    const r = Math.hypot(from.x - c.x, from.y - c.y) * sheet.k;
    const cross = (from.x - c.x) * (to.y - c.y) - (from.y - c.y) * (to.x - c.x);
    const p = P(from);
    const q = P(to);
    return (
      <path
        key={key}
        d={`M ${n2(p.x)} ${n2(p.y)} A ${n2(r)} ${n2(r)} 0 0 ${cross > 0 ? 1 : 0} ${n2(q.x)} ${n2(q.y)}`}
        fill="none"
        stroke={arcInk}
        strokeWidth={0.13}
      />
    );
  };
  return (
    <g className="openings">
      {geom.openings.map((o) => {
        const f = o.frame;
        const [u0, u1] = o.span;
        const parts: ReactNode[] = [];
        const isNew = added.has(o.opening.id);
        const ln = (a: Vec2, b: Vec2, key: string, dash?: string) =>
          line(a, b, key, isNew ? NEW : INK, dash);
        const ar = (c: Vec2, from: Vec2, to: Vec2, key: string) =>
          arc(c, from, to, key, isNew ? NEW : MUTED);
        if (o.kind === 'window') {
          parts.push(ln(framePoint(f, u0, 1), framePoint(f, u1, 1), 'f1'));
          parts.push(ln(framePoint(f, u0, -1), framePoint(f, u1, -1), 'f2'));
          parts.push(ln(framePoint(f, u0, 0), framePoint(f, u1, 0), 'g'));
        }
        if (o.kind === 'door') {
          const style = doorStyle(o.opening);
          if (style === 'swing') {
            const s = doorSwing(f, o.opening);
            parts.push(ln(s.hinge, s.leafEnd, 'leaf'));
            parts.push(ar(s.hinge, s.leafEnd, s.arcEnd, 'arc'));
          } else if (style === 'double') {
            const open = doorLeaves(f, o.opening, 1);
            const shut = doorLeaves(f, o.opening, 0);
            open.forEach((l, i) => {
              parts.push(ln(l.a, l.b, `l${i}`));
              parts.push(ar(l.a, l.b, shut[i]?.b ?? l.b, `a${i}`));
            });
          } else if (style === 'sliding' || style === 'pocket') {
            const shut = doorLeaves(f, o.opening, 0);
            shut.forEach((l, i) => parts.push(ln(l.a, l.b, `s${i}`)));
            if (shut.length === 1) {
              for (const [i, l] of doorLeaves(f, o.opening, 1).entries()) {
                parts.push(ln(l.a, l.b, `d${i}`, '0.8 0.5'));
              }
            }
          } else {
            doorLeaves(f, o.opening, 0.5).forEach((l, i) => parts.push(ln(l.a, l.b, `f${i}`)));
          }
        }
        return (
          <g
            key={o.opening.id}
            data-opening={o.opening.id}
            data-new={isNew || undefined}
            data-cut={cut.has(o.opening.id) || undefined}
          >
            {cut.has(o.opening.id) ? (
              <polygon
                className="opening-cut"
                points={pts(o.polygon.map(P))}
                fill="url(#hack-hatch)"
                stroke={HACK}
                strokeWidth={0.25}
                strokeDasharray="1 0.6"
              />
            ) : (
              <polygon points={pts(o.polygon.map(P))} fill="#ffffff" />
            )}
            {parts}
          </g>
        );
      })}
    </g>
  );
}

/** Built-ins (with their name and length) and, if asked for, the loose furniture. */
function Furniture({
  level,
  sheet,
  loose,
}: {
  level: Level;
  sheet: Sheet;
  loose: boolean;
}) {
  const { P } = sheet;
  return (
    <g className="furniture">
      {Object.values(level.items).map((item) => {
        const kind = furnitureKind(item.assetId);
        const builtIn = !!kind?.carpentry;
        if (!builtIn && (!loose || kind?.ceiling)) return null;
        const f = itemFootprint(item, kind).map(P);
        const c = P({ x: item.position.x, y: item.position.z });
        const { w, d } = itemSize(item, kind);
        let deg = (item.rotationY * 180) / Math.PI;
        deg = ((((deg + 90) % 180) + 180) % 180) - 90;
        const name = (kind?.name ?? 'Built-in').replace(/^Built-in /, '');
        const label = `${name.charAt(0).toUpperCase()}${name.slice(1)} ${mm(w)}`;
        const size = Math.min(TAG_TEXT, (d * sheet.k) / 2.2);
        const fitsText = textWidth(label, size) <= w * sheet.k - 1;
        return (
          <g key={item.id} data-item={item.id} className={builtIn ? 'built-in' : 'loose'}>
            <polygon
              points={pts(f)}
              fill={builtIn ? '#f1f2f3' : 'none'}
              stroke={builtIn ? MUTED : FAINT}
              strokeWidth={builtIn ? 0.18 : 0.13}
            />
            {builtIn && (
              <text
                x={n2(c.x)}
                y={n2(c.y)}
                transform={`rotate(${n2(deg)} ${n2(c.x)} ${n2(c.y)})`}
                fontSize={fitsText ? n2(size) : n2(Math.max(1.2, size * 0.8))}
                textAnchor="middle"
                dominantBaseline="central"
                fill={MUTED}
              >
                {fitsText ? label : mm(w)}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

/**
 * What the renovation hacks: red hatch, dashed, drawn under the After walls, so where a wall
 * is put back in its place (glass, a half wall) only what actually goes shows.
 */
function Hacked({ diff, sheet }: { diff: RenovationDiff; sheet: Sheet }) {
  const { P } = sheet;
  return (
    <g className="reno-hacked">
      {diff.demolished.map((s, i) => (
        <polygon
          // biome-ignore lint/suspicious/noArrayIndexKey: stretches in order
          key={i}
          points={pts(s.polygon.map(P))}
          fill="url(#hack-hatch)"
          stroke={HACK}
          strokeWidth={0.25}
          strokeDasharray="1 0.6"
        />
      ))}
    </g>
  );
}

/**
 * What the renovation builds, in teal, each as what it is: a wall solid, a half wall light
 * with a teal edge, glass a teal outline with its centre line. Each new stretch long enough
 * gets its length beside it.
 */
function Built({ diff, level, sheet }: { diff: RenovationDiff; level: Level; sheet: Sheet }) {
  const { P } = sheet;
  return (
    <g className="reno-built">
      {diff.built.map((s, i) => {
        const w = level.walls[s.wallId];
        const glass = !!w && isGlass(w);
        const half = !!w && !glass && isHalfWall(w, level.ceilingHeight);
        const a = P(s.from);
        const b = P(s.to);
        const kind = glass ? 'glass' : half ? 'half' : 'wall';
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: stretches in order
          <g key={i} data-built={kind} data-wall={s.wallId}>
            <polygon
              points={pts(s.polygon.map(P))}
              fill={glass ? '#ffffff' : half ? NEW_HALF : NEW}
              stroke={NEW}
              strokeWidth={glass || half ? 0.2 : 0.06}
            />
            {glass && (
              <line
                x1={n2(a.x)}
                y1={n2(a.y)}
                x2={n2(b.x)}
                y2={n2(b.y)}
                stroke={NEW}
                strokeWidth={0.14}
              />
            )}
          </g>
        );
      })}
    </g>
  );
}

/**
 * The length of each new stretch of wall, in teal beside it (on the side away from the
 * nearer room label), when there is room for the figure.
 */
function BuiltLengths({
  diff,
  sheet,
  dims,
}: { diff: RenovationDiff; sheet: Sheet; dims: PlanDimensions }) {
  const { P } = sheet;
  const labels = dims.labels.map((l) => P(l.at));
  return (
    <g className="reno-built-lengths">
      {diff.built.map((s, i) => {
        if (s.length < 0.4) return null;
        const a = P(s.from);
        const b = P(s.to);
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const text = String(Math.round(s.length * 100) * 10);
        if (textWidth(text, TAG_TEXT) + 1 > len) return null;
        const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
        const n = { x: -d.y, y: d.x };
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        // Half the wall's thickness out, and a gap: the side further from a room's label.
        const halfT =
          Math.max(
            ...s.polygon.map((p) => Math.abs((P(p).x - m.x) * n.x + (P(p).y - m.y) * n.y)),
          ) || 0;
        const off = halfT + 0.6 + TAG_TEXT * 0.45;
        const at = (k: number) => ({ x: m.x + n.x * off * k, y: m.y + n.y * off * k });
        const near = (p: Vec2) => Math.min(...labels.map((l) => Math.hypot(l.x - p.x, l.y - p.y)));
        const p = labels.length && near(at(-1)) > near(at(1)) ? at(-1) : at(1);
        let deg = (Math.atan2(d.y, d.x) * 180) / Math.PI;
        if (deg > 90) deg -= 180;
        if (deg <= -90) deg += 180;
        return (
          <text
            // biome-ignore lint/suspicious/noArrayIndexKey: stretches in order
            key={i}
            className="built-length"
            x={n2(p.x)}
            y={n2(p.y)}
            transform={`rotate(${n2(deg)} ${n2(p.x)} ${n2(p.y)})`}
            fontSize={TAG_TEXT}
            textAnchor="middle"
            dominantBaseline="central"
            fill={NEW}
            {...HALO}
          >
            {text}
          </text>
        );
      })}
    </g>
  );
}

function Tags({
  tags,
  sheet,
  added,
}: {
  tags: OpeningTag[];
  sheet: Sheet;
  added: ReadonlySet<string>;
}) {
  return (
    <g className="tags">
      {tags.map((t) => {
        // Beside the wall, clear of its face by a gap and half the text's height.
        const off = t.half * sheet.k + 0.6 + TAG_TEXT * 0.4;
        const c = sheet.P(t.at);
        const p = { x: c.x + t.out.x * off, y: c.y + t.out.y * off };
        // Along the wall, read from the bottom or the right.
        const vertical = Math.abs(t.out.x) > 0.7;
        return (
          <text
            key={t.openingId}
            className="opening-tag"
            data-opening={t.openingId}
            x={n2(p.x)}
            y={n2(p.y)}
            transform={vertical ? `rotate(-90 ${n2(p.x)} ${n2(p.y)})` : undefined}
            fontSize={TAG_TEXT}
            textAnchor="middle"
            dominantBaseline="central"
            fill={added.has(t.openingId) ? NEW : MUTED}
            {...HALO}
          >
            {`${t.kind === 'door' ? 'D' : 'W'} ${mm(t.width)}`}
          </text>
        );
      })}
    </g>
  );
}

const areaText = (m2: number) => `${m2.toFixed(1)} m² · ${sqft(m2)} sq ft`;

/** A room name's height on paper per line (mm, before scaling). */
const NAME_LINE = NAME_TEXT * 1.1;

/**
 * A room label's size on paper (mm): its name (on two lines, if that is narrower and the room
 * is too narrow for one), area and size, shrunk (to 70% at most) to fit a small room; half
 * its box, and the name's lines.
 */
function labelFit(
  level: Level,
  room: Room,
  k: number,
): { scale: number; half: Vec2; name: string[] } {
  const area = textWidth(areaText(roomArea(level, room)), AREA_TEXT);
  const outer = roomShape(level, room).outer;
  const xs = outer.map((p) => p.x);
  const ys = outer.map((p) => p.y);
  // Less the walls (half of each, about) and a gap.
  const roomW = (Math.max(...xs) - Math.min(...xs)) * k - 4;
  const roomH = (Math.max(...ys) - Math.min(...ys)) * k - 4;
  const fit = (name: string[]) => {
    const w = Math.max(area, ...name.map((n) => textWidth(n, NAME_TEXT, true)));
    const h = 8.4 + (name.length - 1) * NAME_LINE;
    const scale = Math.min(1, Math.max(0.7, Math.min(roomW / (w + 1.6), roomH / h)));
    return { scale, w, h, name, fits: (w + 1.6) * scale <= roomW };
  };
  let best = fit([room.name]);
  const words = room.name.split(' ');
  if (!best.fits && words.length > 1) {
    // Split at the space nearest the middle.
    let cut = 1;
    for (let i = 1; i < words.length; i++) {
      const left = words.slice(0, i).join(' ').length;
      const bestLeft = words.slice(0, cut).join(' ').length;
      if (Math.abs(left - room.name.length / 2) < Math.abs(bestLeft - room.name.length / 2)) {
        cut = i;
      }
    }
    const two = fit([words.slice(0, cut).join(' '), words.slice(cut).join(' ')]);
    if (two.w * two.scale < best.w * best.scale) best = two;
  }
  const { scale, w, h, name } = best;
  return { scale, half: { x: (w * scale) / 2 + 0.8, y: (h / 2) * scale }, name };
}

/**
 * Room names and areas, and each room's clear width and depth: a line face to face through
 * the label with its figure beside the label, or, where either figure has no room there,
 * both under the area ("2920 × 4120").
 */
function Rooms({
  level,
  dims,
  sheet,
}: {
  level: Level;
  dims: PlanDimensions;
  sheet: Sheet;
}) {
  const { P } = sheet;
  return (
    <g className="room-labels">
      {dims.labels.map(({ roomId, at }) => {
        const room = level.rooms[roomId];
        if (!room) return null;
        const c = P(at);
        const { scale: f, half, name } = labelFit(level, room, sheet.k);
        // A name on two lines moves the first up and the rest down by half a line.
        const dy = ((name.length - 1) * NAME_LINE) / 2;
        const spans = dims.spans
          .filter((s) => s.roomId === roomId)
          .map((s) => {
            const x = s.axis === 'x';
            const a = P(s.a);
            const b = P(s.b);
            const len = Math.round(Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) * 100) * 10;
            const text = String(len);
            // Where the line runs, across it: through the label, or beside it (clear of a tag).
            const line = x ? a.y : a.x;
            const through = Math.abs(line - (x ? c.y : c.x)) < 0.05;
            const gap = (x ? half.x : half.y) + 0.6;
            const start = x ? a.x : a.y;
            const end = x ? b.x : b.y;
            const mid0 = x ? c.x : c.y;
            const lo = through ? mid0 - gap : end;
            const hi = through ? mid0 + gap : end;
            const before = lo - start;
            const after = end - hi;
            const fits = Math.max(before, after) >= textWidth(text, DIM_TEXT) + 2;
            // Beside the label, the figure keeps off where the other span crosses this one.
            const tw = textWidth(text, DIM_TEXT) / 2 + 0.8;
            const cross = (other: boolean) =>
              other && end - (mid0 + tw) >= tw && mid0 - tw - start >= tw
                ? end - mid0 >= mid0 - start
                  ? (mid0 + end) / 2
                  : (start + mid0) / 2
                : (start + end) / 2;
            const mid = !through
              ? cross(dims.spans.some((o) => o.roomId === roomId && o.axis !== s.axis))
              : before >= after
                ? (start + lo) / 2
                : (hi + end) / 2;
            // The figure's side of the line: away from the label (a through line: before it).
            const away = through ? -1 : line > (x ? c.y : c.x) ? 1 : -1;
            return { s, x, len, text, start, end, lo, hi, fits, mid, line, away };
          });
        const onLines = spans.every((p) => p.fits);
        const extra = !onLines && spans.length ? spans.map((p) => p.text).join(' × ') : null;
        const tick = (x: boolean, line: number, v: number, key: string) => (
          <line
            key={key}
            x1={n2(x ? v - 0.6 : line - 0.6)}
            y1={n2(x ? line + 0.6 : v + 0.6)}
            x2={n2(x ? v + 0.6 : line + 0.6)}
            y2={n2(x ? line - 0.6 : v - 0.6)}
            stroke={INK}
            strokeWidth={0.18}
          />
        );
        const seg = (x: boolean, line: number, p: number, q: number, key: string) =>
          q - p > 0.3 ? (
            <line
              key={key}
              x1={n2(x ? p : line)}
              y1={n2(x ? line : p)}
              x2={n2(x ? q : line)}
              y2={n2(x ? line : q)}
              stroke={FAINT}
              strokeWidth={0.13}
            />
          ) : null;
        return (
          <g key={roomId} className="room" data-room={roomId}>
            {spans.map(({ s, x, len, text, start, end, lo, hi, mid, line, away }) => {
              // Text sits out from the line by a gap; below or right of it, past its height.
              const off = away > 0 ? 0.7 + DIM_TEXT * 0.72 : -0.7;
              return (
                <g key={s.axis} className="room-span" data-axis={s.axis} data-mm={len}>
                  {seg(x, line, start, Math.min(lo, end), 'a')}
                  {seg(x, line, Math.max(hi, start), end, 'b')}
                  {tick(x, line, start, 'ta')}
                  {tick(x, line, end, 'tb')}
                  {onLines &&
                    (x ? (
                      <text
                        x={n2(mid)}
                        y={n2(line + off)}
                        fontSize={DIM_TEXT}
                        textAnchor="middle"
                        fill={INK}
                        {...HALO}
                      >
                        {text}
                      </text>
                    ) : (
                      <text
                        x={n2(line + off)}
                        y={n2(mid)}
                        transform={`rotate(-90 ${n2(line + off)} ${n2(mid)})`}
                        fontSize={DIM_TEXT}
                        textAnchor="middle"
                        fill={INK}
                        {...HALO}
                      >
                        {text}
                      </text>
                    ))}
                </g>
              );
            })}
            <text
              className="room-name"
              x={n2(c.x)}
              y={n2(c.y - ((extra ? 2.2 : 0.6) + dy) * f)}
              fontSize={n2(NAME_TEXT * f)}
              fontWeight={700}
              textAnchor="middle"
              fill={INK}
              {...HALO}
            >
              {name.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the name's lines in order
                <tspan key={i} x={n2(c.x)} dy={i === 0 ? 0 : n2(NAME_LINE * f)}>
                  {i < name.length - 1 ? `${line} ` : line}
                </tspan>
              ))}
            </text>
            <text
              className="room-area"
              x={n2(c.x)}
              y={n2(c.y + ((extra ? 0.8 : 2.4) + dy) * f)}
              fontSize={n2(AREA_TEXT * f)}
              textAnchor="middle"
              fill={MUTED}
              {...HALO}
            >
              {areaText(roomArea(level, room))}
            </text>
            {extra && (
              <text
                className="room-size"
                x={n2(c.x)}
                y={n2(c.y + (3.6 + dy) * f)}
                fontSize={n2(AREA_TEXT * f)}
                textAnchor="middle"
                fill={INK}
                {...HALO}
              >
                {extra}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

/** One chain of dimensions outside a side: extension lines, the line, ticks and figures. */
function Chain({
  chain,
  sheet,
  offset,
  blockers = [],
}: {
  chain: DimensionChain;
  sheet: Sheet;
  /** How far outside the plan's outline the line runs, mm. */
  offset: number;
  /** Where the extension lines of the chains further out cross this one (plan, along the side). */
  blockers?: number[];
}) {
  const { P } = sheet;
  const pieces = roundChain(chain.stops, 0.01);
  const side = chain.side;
  if (side === 'aligned') {
    const l = chain.line;
    if (!l) return null;
    const len = Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);
    const d = { x: (l.b.x - l.a.x) / len, y: (l.b.y - l.a.y) / len };
    const at = (s: number, out: number) => {
      const p = P({ x: l.a.x + d.x * s, y: l.a.y + d.y * s });
      return { x: p.x + l.out.x * out, y: p.y + l.out.y * out };
    };
    let deg = (Math.atan2(d.y, d.x) * 180) / Math.PI;
    if (deg > 90) deg -= 180;
    if (deg <= -90) deg += 180;
    const first = chain.stops[0] ?? 0;
    const last = chain.stops[chain.stops.length - 1] ?? 0;
    const p0 = at(first, offset);
    const p1 = at(last, offset);
    return (
      <g className="dim-chain" data-side="aligned" data-tier={chain.tier}>
        <line
          x1={n2(p0.x)}
          y1={n2(p0.y)}
          x2={n2(p1.x)}
          y2={n2(p1.y)}
          stroke={INK}
          strokeWidth={0.15}
        />
        {chain.stops.map((s, i) => {
          const a = at(s, 1.5);
          const b = at(s, offset + 1.2);
          const t0 = at(s, offset);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: stops in order
            <g key={i}>
              <line
                x1={n2(a.x)}
                y1={n2(a.y)}
                x2={n2(b.x)}
                y2={n2(b.y)}
                stroke={MUTED}
                strokeWidth={0.1}
              />
              <line
                x1={n2(t0.x - 0.6)}
                y1={n2(t0.y + 0.6)}
                x2={n2(t0.x + 0.6)}
                y2={n2(t0.y - 0.6)}
                stroke={INK}
                strokeWidth={0.22}
              />
            </g>
          );
        })}
        {pieces.map((p, i) => {
          const s0 = chain.stops[i] ?? 0;
          const s1 = chain.stops[i + 1] ?? 0;
          const m = at((s0 + s1) / 2, offset + 0.8);
          return (
            <text
              // biome-ignore lint/suspicious/noArrayIndexKey: pieces in order
              key={i}
              className="dim-text"
              x={n2(m.x)}
              y={n2(m.y)}
              transform={`rotate(${n2(deg)} ${n2(m.x)} ${n2(m.y)})`}
              fontSize={DIM_TEXT}
              textAnchor="middle"
              fill={INK}
            >
              {mm(p)}
            </text>
          );
        })}
      </g>
    );
  }
  const horizontal = side === 'top' || side === 'bottom';
  const outSign = side === 'top' || side === 'left' ? -1 : 1;
  // Paper coordinates: along the side, and across it (the chain's line).
  const alongP = (v: number) =>
    horizontal ? sheet.P({ x: v, y: 0 }).x : sheet.P({ x: 0, y: v }).y;
  const acrossP = (v: number) =>
    horizontal ? sheet.P({ x: 0, y: v }).y : sheet.P({ x: v, y: 0 }).x;
  const edge = acrossP(chain.at);
  const lineAt = edge + outSign * offset;
  const pt = (a: number, c: number) => (horizontal ? { x: a, y: c } : { x: c, y: a });
  const L = (p: Vec2, q: Vec2, w: number, color: string, key?: string) => (
    <line
      key={key}
      x1={n2(p.x)}
      y1={n2(p.y)}
      x2={n2(q.x)}
      y2={n2(q.y)}
      stroke={color}
      strokeWidth={w}
    />
  );
  const a0 = alongP(chain.stops[0] ?? 0);
  const a1 = alongP(chain.stops[chain.stops.length - 1] ?? 0);
  // Figures sit outside the line; a figure too long for its piece, or running into the one
  // before, goes out a row, beside its piece if need be: clear of the figure before it and
  // of the extension lines of the chains further out, which cross that row.
  const rows: number[] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const ext = blockers.map(alongP);
  const free = (mid: number, w: number) =>
    mid - w / 2 >= (rows[1] as number) + 0.8 &&
    !ext.some((e) => e > mid - w / 2 - 0.8 && e < mid + w / 2 + 0.8);
  const figures = pieces.map((p, i) => {
    const s0 = alongP(chain.stops[i] ?? 0);
    const s1 = alongP(chain.stops[i + 1] ?? 0);
    const text = mm(p);
    const w = textWidth(text, DIM_TEXT);
    let mid = (s0 + s1) / 2;
    let row = 0;
    const fits = w + 0.8 <= s1 - s0;
    if (!fits || mid - w / 2 < (rows[0] as number) + 0.8) {
      row = 1;
      const home = mid;
      // The nearest spot that is clear, trying either way out from the piece's middle.
      let found = false;
      for (let k = 0; k <= 60 && !found; k++) {
        for (const sgn of k === 0 ? [1] : [-1, 1]) {
          const m = home + sgn * k * 0.25;
          if (free(m, w)) {
            mid = m;
            found = true;
            break;
          }
        }
      }
      if (!found) mid = Math.max(home, (rows[1] as number) + 0.8 + w / 2);
    }
    rows[row] = mid + w / 2;
    // Text baseline, out from the line by a gap (and a row): letters stand outside it.
    const across = lineAt + outSign * (0.7 + row * 2.7) + (outSign > 0 ? DIM_TEXT * 0.72 : 0);
    if (horizontal) {
      return (
        <text
          // biome-ignore lint/suspicious/noArrayIndexKey: pieces in order
          key={i}
          className="dim-text"
          x={n2(mid)}
          y={n2(across)}
          fontSize={DIM_TEXT}
          textAnchor="middle"
          fill={INK}
        >
          {text}
        </text>
      );
    }
    // Vertical, read from the right: rotated a quarter turn back, so its top faces left.
    const x = across;
    return (
      <text
        // biome-ignore lint/suspicious/noArrayIndexKey: pieces in order
        key={i}
        className="dim-text"
        x={n2(x)}
        y={n2(mid)}
        transform={`rotate(-90 ${n2(x)} ${n2(mid)})`}
        fontSize={DIM_TEXT}
        textAnchor="middle"
        fill={INK}
      >
        {text}
      </text>
    );
  });
  return (
    <g className="dim-chain" data-side={side} data-tier={chain.tier}>
      {chain.stops.map((s, i) => {
        const a = alongP(s);
        const from = acrossP(chain.from[i] ?? chain.at) + outSign * 1.5;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: stops in order
          <g key={i}>
            {L(pt(a, from), pt(a, lineAt + outSign * 1.2), 0.1, MUTED)}
            {L(pt(a - 0.6, lineAt + 0.6), pt(a + 0.6, lineAt - 0.6), 0.25, INK)}
          </g>
        );
      })}
      {L(pt(a0 - 1.2, lineAt), pt(a1 + 1.2, lineAt), 0.15, INK)}
      {figures}
    </g>
  );
}

function Chains({ dims, sheet }: { dims: PlanDimensions; sheet: Sheet }) {
  const out: ReactNode[] = [];
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const list = dims.chains.filter((c) => c.side === side).sort((a, b) => a.tier - b.tier);
    list.forEach((c, i) => {
      const outer = list.slice(i + 1).flatMap((o) => o.stops);
      out.push(
        <Chain
          key={`${side}${c.tier}`}
          chain={c}
          sheet={sheet}
          offset={7 + i * 7.5}
          blockers={outer}
        />,
      );
    });
  }
  dims.chains
    .filter((c) => c.side === 'aligned')
    // biome-ignore lint/suspicious/noArrayIndexKey: aligned chains in order
    .forEach((c, i) => out.push(<Chain key={`al${i}`} chain={c} sheet={sheet} offset={7} />));
  return <g className="dimensions">{out}</g>;
}

// ---------------------------------------------------------------------------- the title column

interface LegendKey {
  key: string;
  label: string;
  swatch: ReactNode;
  /** How many of it (the electrical page's points). */
  count?: number;
}

function legendKeys(
  level: Level,
  guarded: ReadonlySet<string>,
  diff: RenovationDiff | null,
  cut: ReadonlySet<string>,
) {
  const walls = Object.values(level.walls);
  const keys: LegendKey[] = [];
  const box = (fill: string, stroke = 'none', dash?: string) => (
    <rect
      width={6}
      height={2.4}
      fill={fill}
      stroke={stroke}
      strokeWidth={0.2}
      strokeDasharray={dash}
    />
  );
  keys.push({ key: 'wall', label: 'Wall', swatch: box(WALL) });
  if (guarded.size) {
    keys.push({
      key: 'structural',
      label: 'Structural or shelter wall',
      swatch: box('url(#hatch)', WALL),
    });
  }
  if (walls.some(isGlass)) {
    keys.push({
      key: 'glass',
      label: 'Glass partition',
      swatch: (
        <>
          {box('#ffffff', WALL)}
          <line x1={0} y1={1.2} x2={6} y2={1.2} stroke={WALL} strokeWidth={0.12} />
        </>
      ),
    });
  }
  if (walls.some((w) => isHalfWall(w, level.ceilingHeight))) {
    keys.push({ key: 'half', label: 'Half wall', swatch: box(HALF) });
  }
  if (walls.some((w) => w.kind === 'boundary')) {
    keys.push({
      key: 'boundary',
      label: 'Room boundary (no wall)',
      swatch: (
        <line
          x1={0}
          y1={1.2}
          x2={6}
          y2={1.2}
          stroke={MUTED}
          strokeWidth={0.2}
          strokeDasharray="1.2 0.8"
        />
      ),
    });
  }
  if (diff?.demolished.length || cut.size) {
    keys.push({
      key: 'hacked',
      label: 'Wall to hack',
      swatch: box('url(#hack-hatch)', HACK, '1 0.6'),
    });
  }
  const built = (diff?.built ?? []).map((s) => level.walls[s.wallId]);
  const glass = (w: (typeof built)[number]) => !!w && isGlass(w);
  const half = (w: (typeof built)[number]) =>
    !!w && !isGlass(w) && isHalfWall(w, level.ceilingHeight);
  if (built.some((w) => !glass(w) && !half(w))) {
    keys.push({ key: 'new', label: 'New wall', swatch: box(NEW) });
  }
  if (built.some(glass)) {
    keys.push({
      key: 'new-glass',
      label: 'New glass partition',
      swatch: (
        <>
          {box('#ffffff', NEW)}
          <line x1={0} y1={1.2} x2={6} y2={1.2} stroke={NEW} strokeWidth={0.14} />
        </>
      ),
    });
  }
  if (built.some(half)) {
    keys.push({ key: 'new-half', label: 'New half wall', swatch: box(NEW_HALF, NEW) });
  }
  if (diff?.openingsAdded.length) {
    keys.push({
      key: 'new-opening',
      label: 'New door or window',
      swatch: (
        <>
          <line x1={0} y1={2.4} x2={0} y2={0} stroke={NEW} strokeWidth={0.22} />
          <path d="M 0 0 A 2.4 2.4 0 0 1 2.4 2.4" fill="none" stroke={NEW} strokeWidth={0.13} />
        </>
      ),
    });
  }
  return keys;
}

/**
 * Splits text into lines of at most `width` mm at this size; a word too long for a line of
 * its own (a long name without spaces) is broken where it reaches the edge.
 */
function wrap(text: string, size: number, width: number, bold = false): string[] {
  const words = text.split(' ').flatMap((w) => {
    if (textWidth(w, size, bold) <= width) return [w];
    const per = Math.max(1, Math.floor(width / (size * (bold ? 0.6 : 0.55))));
    const parts: string[] = [];
    for (let i = 0; i < w.length; i += per) parts.push(w.slice(i, i + per));
    return parts;
  });
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && textWidth(next, size, bold) > width) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

function TitleColumn({
  sheet,
  project,
  levelName,
  version,
  paper,
  north,
  legend,
  page,
  pages,
  date,
  subtitle = 'Plan for contractors',
  note,
}: {
  sheet: Sheet;
  /** What the page is, under the project's name. */
  subtitle?: string;
  /** A last line, bold, under the caveat (the electrical page's licensed worker). */
  note?: string;
  project: Project;
  levelName: string;
  version: string;
  paper: Paper;
  north: number;
  /** The plan's key; null on a page without the plan (no key, scale bar or north). */
  legend: LegendKey[] | null;
  page: number;
  pages: number;
  date: string;
}) {
  const x0 = sheet.w - SHEET_MM.margin - SHEET_MM.title;
  const x = x0 + 5;
  const width = SHEET_MM.title - 10;
  const top = SHEET_MM.margin;
  const bottom = sheet.h - SHEET_MM.margin;
  let y = top + 9;
  const out: ReactNode[] = [];
  const text = (
    s: string,
    size0: number,
    opts: { bold?: boolean; color?: string; cls?: string; gap?: number; shrink?: boolean } = {},
  ) => {
    // A long word shrinks the text (to 70% at most) to fit the column; past that it breaks.
    const longest = Math.max(...s.split(' ').map((w) => textWidth(w, size0, opts.bold)));
    const size = opts.shrink ? n2(size0 * Math.max(0.7, Math.min(1, width / longest))) : size0;
    // One text, a row per line (spaces kept, so it reads as the sentence it is).
    const lines = wrap(s, size, width, opts.bold);
    out.push(
      <text
        key={out.length}
        className={opts.cls}
        x={x}
        y={n2(y)}
        fontSize={size}
        fontWeight={opts.bold ? 700 : 400}
        fill={opts.color ?? INK}
      >
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines in order
          <tspan key={i} x={x} dy={i === 0 ? 0 : n2(size * 1.35)}>
            {i < lines.length - 1 ? `${line} ` : line}
          </tspan>
        ))}
      </text>,
    );
    y += lines.length * size * 1.35;
    y += opts.gap ?? 0;
  };
  text(project.name, 4.2, { bold: true, cls: 'sheet-name', gap: 1, shrink: true });
  text(subtitle, 2.6, { color: MUTED, gap: 4 });
  const row = (k: string, v: string, cls?: string) => {
    const lines = wrap(v, 2.3, width - 18);
    out.push(
      <text key={out.length} x={x} y={n2(y)} fontSize={2.3} fill={MUTED}>
        {k}
      </text>,
      <text key={out.length + 1} className={cls} x={x + 18} y={n2(y)} fontSize={2.3} fill={INK}>
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines in order
          <tspan key={i} x={x + 18} dy={i === 0 ? 0 : 3.1}>
            {i < lines.length - 1 ? `${line} ` : line}
          </tspan>
        ))}
      </text>,
    );
    y += 3.6 + (lines.length - 1) * 3.1;
  };
  row('Date', date, 'sheet-date');
  row('Level', levelName);
  row('Version', version, 'sheet-version');
  row('Scale', sheet.fits ? `1:${sheet.scale} at ${paper}` : 'Not to scale', 'sheet-scale');
  y += 3;
  // The scale bar: 5 m, or 2.5 m where 5 m is wider than the column (1:50).
  if (sheet.fits && legend) {
    const metres = 5 * sheet.k <= width ? 5 : 2.5;
    const step = metres === 5 ? 1 : 0.5;
    const n = Math.round(metres / step);
    const segW = step * sheet.k;
    out.push(
      <g key="bar" className="scale-bar" data-metres={metres} data-mm={n2(metres * sheet.k)}>
        {Array.from({ length: n }, (_, i) => (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: bar segments
            key={i}
            x={n2(x + i * segW)}
            y={n2(y)}
            width={n2(segW)}
            height={1.6}
            fill={i % 2 ? '#ffffff' : INK}
            stroke={INK}
            strokeWidth={0.15}
          />
        ))}
        {Array.from({ length: n + 1 }, (_, i) =>
          i % (metres === 5 ? 1 : 2) === 0 || i === n ? (
            <text
              // biome-ignore lint/suspicious/noArrayIndexKey: bar labels
              key={`t${i}`}
              x={n2(x + i * segW)}
              y={n2(y + 4.4)}
              fontSize={2}
              textAnchor="middle"
              fill={INK}
            >
              {i === n ? `${metres} m` : String(i * step)}
            </text>
          ) : null,
        )}
      </g>,
    );
    y += 9;
  }
  if (legend) {
    // North, as the plan's site has it: an arrow turned clockwise from the plan's up.
    const cx = x + 6;
    const cy = y + 6;
    const deg = (north * 180) / Math.PI;
    out.push(
      <g key="north" className="north-arrow" data-degrees={n2(deg)}>
        <circle cx={n2(cx)} cy={n2(cy)} r={5} fill="none" stroke={INK} strokeWidth={0.2} />
        <g transform={`rotate(${n2(deg)} ${n2(cx)} ${n2(cy)})`}>
          <path
            d={`M ${n2(cx)} ${n2(cy - 4.4)} L ${n2(cx + 1.8)} ${n2(cy + 3)} L ${n2(cx)} ${n2(cy + 1.8)} L ${n2(cx - 1.8)} ${n2(cy + 3)} Z`}
            fill={INK}
          />
          <text
            x={n2(cx)}
            y={n2(cy - 5.8)}
            fontSize={2.4}
            fontWeight={700}
            textAnchor="middle"
            fill={INK}
          >
            N
          </text>
        </g>
      </g>,
    );
    y += 16;
  }
  text('Dimensions in mm. Areas to wall centre lines.', 2.2, { color: MUTED, gap: 1 });
  text('For discussion, not for construction. Check on site.', 2.2, {
    bold: true,
    cls: 'sheet-caveat',
    gap: note ? 1 : 4,
  });
  if (note) text(note, 2.2, { bold: true, cls: 'sheet-note', gap: 4 });
  if (legend?.length) {
    out.push(
      <text key="lh" x={x} y={n2(y)} fontSize={2.3} fontWeight={700} fill={INK}>
        Key
      </text>,
    );
    y += 3.4;
    for (const k of legend) {
      out.push(
        <g key={`k${k.key}`} className="legend-key" data-key={k.key} data-count={k.count}>
          <g transform={`translate(${x} ${n2(y - 2.1)})`}>{k.swatch}</g>
          <text x={x + 8.5} y={n2(y)} fontSize={2.2} fill={INK}>
            {k.label}
          </text>
        </g>,
      );
      y += 3.6;
    }
  }
  return (
    <g className="title-column">
      <line x1={x0} y1={top} x2={x0} y2={bottom} stroke={INK} strokeWidth={0.25} />
      {out}
      <text
        className="sheet-page"
        x={x}
        y={bottom - 4}
        fontSize={2.3}
        fill={MUTED}
      >{`Page ${page} of ${pages}`}</text>
    </g>
  );
}

function Frame({ sheet, label, children }: { sheet: Sheet; label: string; children: ReactNode }) {
  const m = SHEET_MM.margin;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={`${sheet.w}mm`}
      height={`${sheet.h}mm`}
      viewBox={`0 0 ${sheet.w} ${sheet.h}`}
      fontFamily={FONT}
      className="contractor-page"
    >
      <title>{label}</title>
      <defs>
        <pattern
          id="hatch"
          width={1}
          height={1}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width={1} height={1} fill="#d4d7db" />
          <line x1={0.5} y1={0} x2={0.5} y2={1} stroke={WALL} strokeWidth={0.22} />
        </pattern>
        <pattern
          id="hack-hatch"
          width={1}
          height={1}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(-45)"
        >
          <rect width={1} height={1} fill="#fbe9e7" />
          <line x1={0.5} y1={0} x2={0.5} y2={1} stroke={HACK} strokeWidth={0.18} />
        </pattern>
      </defs>
      <rect width={sheet.w} height={sheet.h} fill="#ffffff" />
      <rect
        x={m}
        y={m}
        width={sheet.w - 2 * m}
        height={sheet.h - 2 * m}
        fill="none"
        stroke={INK}
        strokeWidth={0.35}
      />
      {children}
    </svg>
  );
}

// ---------------------------------------------------------------------------- page 2

/** The change list's lines (as Copy list gives them), as rows of words to wrap. */
function changeRows(text: string, width: number): { place?: string; text: string }[][] {
  const out: { place?: string; text: string }[][] = [];
  for (const line of text.split('\n')) {
    if (!line) {
      out.push([]);
      continue;
    }
    const m = line.match(/^([^:]+): (.*)$/);
    const place = m?.[1];
    const words = wrap(line, 3, width);
    // The place, bold, at the start of its first row.
    out.push(
      words.map((w, i) => {
        const last = i === words.length - 1;
        const t = last ? w : `${w} `;
        if (i === 0 && place && t.startsWith(`${place}:`)) {
          return { place: `${place}:`, text: t.slice(place.length + 1) };
        }
        return { text: t };
      }),
    );
  }
  return out;
}

function ChangesPage({
  sheet,
  rows,
  first,
  last,
  title,
  label,
}: {
  sheet: Sheet;
  rows: { place?: string; text: string }[][];
  first: boolean;
  last: boolean;
  title: ReactNode;
  label: string;
}) {
  const x = SHEET_MM.margin + 8;
  const right = sheet.w - SHEET_MM.margin - SHEET_MM.title - 8;
  const bottom = sheet.h - SHEET_MM.margin - 8;
  let y = SHEET_MM.margin + 12;
  const out: ReactNode[] = [];
  if (first) {
    out.push(
      <text key="h" x={x} y={y} fontSize={4.2} fontWeight={700} fill={INK}>
        Changes, room by room
      </text>,
    );
    y += 8;
  }
  out.push(
    <g key="list" className="change-list">
      {rows.map((r, i) => {
        if (r.length === 0) {
          y += 2.4;
          return null;
        }
        const ty = y;
        y += r.length * 4.4 + 1.2;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines in order
          <text key={i} className="change-line" x={x} y={n2(ty)} fontSize={3} fill={INK}>
            {r.map((part, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a line's rows
              <tspan key={j} x={x} dy={j === 0 ? 0 : 4.4}>
                {part.place && <tspan fontWeight={700}>{part.place}</tspan>}
                {part.text}
              </tspan>
            ))}
          </text>
        );
      })}
    </g>,
  );
  if (last) {
    y += 6;
    if (y < bottom - 16) {
      out.push(
        <text key="nh" x={x} y={n2(y)} fontSize={3.4} fontWeight={700} fill={INK}>
          Notes
        </text>,
      );
      y += 9;
      const lines: ReactNode[] = [];
      for (; y <= bottom; y += 9) {
        lines.push(
          <line key={y} x1={x} y1={n2(y)} x2={right} y2={n2(y)} stroke={FAINT} strokeWidth={0.2} />,
        );
      }
      out.push(
        <g key="notes" className="notes-lines">
          {lines}
        </g>,
      );
    }
  }
  return (
    <Frame sheet={sheet} label={label}>
      {out}
      {title}
    </Frame>
  );
}

// ---------------------------------------------------------------------------- electrical

/** A point's symbol radius on paper, mm. */
const ELEC_R = 1.5;
const ELEC_TEXT = 1.7;

type ElecState = 'same' | 'new' | 'moved' | 'removed';

/** Each point of the version printed, with what the renovation does to it. */
interface SheetPoint {
  p: ElecPoint;
  level: Level;
  state: ElecState;
}

function sheetPoints(level: Level, before: Level, ch: ElecChanges | null): SheetPoint[] {
  const shown = Object.values(level.points ?? {}).map((p) => ({
    p,
    level,
    state: (ch?.status.get(p.id) ?? 'same') as ElecState,
  }));
  const removed = (ch?.removed ?? []).map((p) => ({ p, level: before, state: 'removed' as const }));
  return [...shown, ...removed];
}

const ELEC_INK: Record<ElecState, string> = {
  same: INK,
  new: NEW,
  moved: NEW,
  removed: HACK,
};

/** A point's symbol on paper at its place (sheet mm). */
function PointMark({
  sp,
  sheet,
  ink,
  faint,
}: { sp: SheetPoint; sheet: Sheet; ink: string; faint?: boolean }) {
  const pos = pointPosition(sp.level, sp.p);
  if (!pos) return null;
  const c = sheet.P(pos.at);
  const tag = !faint && sp.p.wall && !atDefaultHeight(sp.level, sp.p);
  const out = pos.normal ?? { x: 0, y: 0 };
  const reach = pos.normal ? 4.2 : 2.6;
  return (
    <g
      className="elec-mark"
      data-point={sp.p.id}
      data-kind={sp.p.kind}
      data-change={faint ? 'was' : sp.state}
      opacity={faint ? 0.35 : undefined}
    >
      <g transform={`translate(${n2(c.x)} ${n2(c.y)})`}>
        <ElecGlyph
          kind={sp.p.kind}
          gang={sp.p.gang}
          r={ELEC_R}
          normal={pos.normal}
          stroke={ink}
          fill="#ffffff"
          sw={0.22}
        />
      </g>
      {tag && sp.p.wall && (
        <text
          x={n2(c.x + out.x * reach)}
          y={n2(c.y + out.y * reach)}
          dy="0.36em"
          fontSize={ELEC_TEXT}
          textAnchor="middle"
          fill={ink}
          {...HALO}
        >
          {`h${Math.round(sp.p.wall.height * 1000)}`}
        </text>
      )}
    </g>
  );
}

/** Legend rows for the electrical page: each kind there, its heights and how many. */
function elecLegend(points: SheetPoint[]): LegendKey[] {
  const keys: LegendKey[] = [];
  const live = points.filter((sp) => sp.state !== 'removed');
  for (const kind of ELEC_KIND_ORDER) {
    const of = live.filter((sp) => sp.p.kind === kind);
    if (!of.length) continue;
    const heights = [
      ...new Set(of.flatMap((sp) => (sp.p.wall ? [Math.round(sp.p.wall.height * 1000)] : []))),
    ].sort((a, b) => a - b);
    const where =
      ELEC_KINDS[kind].place === 'ceiling'
        ? 'ceiling'
        : kind === 'compressor'
          ? 'ledge'
          : `${heights.join(', ')} mm`;
    keys.push({
      key: `elec-${kind}`,
      label: `${ELEC_KINDS[kind].short}, ${where}, ×${of.length}`,
      count: of.length,
      swatch: (
        <g transform="translate(3 0.4)">
          <ElecGlyph
            kind={kind}
            gang={1}
            r={kind === 'aircon' || kind === 'compressor' ? 0.75 : 1.1}
            normal={ELEC_KINDS[kind].place === 'wall' ? { x: 0, y: 1 } : undefined}
            stroke={INK}
            fill="#ffffff"
            sw={0.2}
          />
        </g>
      ),
    });
  }
  const has = (s: ElecState) => points.some((sp) => sp.state === s);
  const dot = (ink: string, faint = false) => (
    <circle
      cx={3}
      cy={1.2}
      r={1.1}
      fill="#ffffff"
      stroke={ink}
      strokeWidth={0.3}
      opacity={faint ? 0.35 : 1}
    />
  );
  if (has('new')) keys.push({ key: 'elec-new', label: 'New point', swatch: dot(NEW) });
  if (has('moved'))
    keys.push({
      key: 'elec-moved',
      label: 'Moved point (faint: where it was)',
      swatch: (
        <>
          {dot(NEW)}
          <circle
            cx={0.8}
            cy={1.2}
            r={0.7}
            fill="none"
            stroke={INK}
            strokeWidth={0.2}
            opacity={0.35}
          />
        </>
      ),
    });
  if (has('removed'))
    keys.push({ key: 'elec-removed', label: 'Point taken out', swatch: dot(HACK) });
  if (points.some((sp) => sp.p.kind === 'aircon' && (sp.p.route?.length || sp.p.compressorId)))
    keys.push({
      key: 'elec-trunking',
      label: 'Aircon trunking, with its length',
      swatch: (
        <line
          x1={0}
          y1={1.2}
          x2={6}
          y2={1.2}
          stroke={INK}
          strokeWidth={0.25}
          strokeDasharray="1 0.6"
        />
      ),
    });
  return keys;
}

/** The electrical plan: the walls grey, the points black (or as the renovation changes them). */
function ElectricalPlan({
  level,
  before,
  geom,
  sheet,
  guarded,
  points,
  ch,
}: {
  level: Level;
  before: Level;
  geom: PlanGeometry;
  sheet: Sheet;
  guarded: ReadonlySet<string>;
  points: SheetPoint[];
  ch: ElecChanges | null;
}) {
  const shapes = roomShapes(level);
  return (
    <g className="plan electrical-plan">
      <g className="floors">
        {[...shapes.values()].map((s, i) => (
          <path
            // biome-ignore lint/suspicious/noArrayIndexKey: rooms in order
            key={i}
            d={[s.outer, ...s.holes]
              .filter((r) => r.length >= 3)
              .map((r) => `M ${pts(r.map(sheet.P))} Z`)
              .join(' ')}
            fillRule="evenodd"
            fill="#ffffff"
          />
        ))}
      </g>
      <g className="elec-base" opacity={0.32}>
        <Walls level={level} geom={geom} sheet={sheet} guarded={guarded} />
        <Openings geom={geom} sheet={sheet} added={new Set()} cut={new Set()} />
      </g>
      <g className="elec-rooms">
        {Object.values(level.rooms).map((r) => {
          const s = shapes.get(r.id);
          if (!s || s.outer.length < 3) return null;
          // Clear of the points' symbols.
          const avoid = points.flatMap((sp) => {
            const at = sp.state !== 'removed' && pointPosition(sp.level, sp.p)?.at;
            return at ? [{ c: at, r: 3.2 / sheet.k }] : [];
          });
          const half = { x: textWidth(r.name, 2.2) / 2 / sheet.k, y: 1.4 / sheet.k };
          const c = sheet.P(placeLabel(s.outer, half, avoid, s.holes));
          return (
            <text
              key={r.id}
              x={n2(c.x)}
              y={n2(c.y)}
              fontSize={2.2}
              textAnchor="middle"
              fill={MUTED}
              {...HALO}
            >
              {r.name}
            </text>
          );
        })}
      </g>
      <g className="elec-trunking">
        {points.map((sp) => {
          if (sp.state === 'removed') return null;
          const path = trunkingPath(sp.level, sp.p);
          if (path.length < 2) return null;
          const q = path.map(sheet.P);
          // Its length beside the longest stretch.
          let best = 0;
          for (let i = 1; i < q.length; i++) {
            const a = q[i - 1] as Vec2;
            const b = q[i] as Vec2;
            const c0 = q[best] as Vec2;
            const c1 = q[best + 1] as Vec2;
            if (Math.hypot(b.x - a.x, b.y - a.y) > Math.hypot(c1.x - c0.x, c1.y - c0.y))
              best = i - 1;
          }
          const a = q[best] as Vec2;
          const b = q[best + 1] as Vec2;
          const ink = ELEC_INK[sp.state];
          return (
            <g key={sp.p.id} data-trunking={sp.p.id}>
              <polyline
                points={pts(q)}
                fill="none"
                stroke={ink}
                strokeWidth={0.3}
                strokeDasharray="1.2 0.7"
              />
              <text
                x={n2((a.x + b.x) / 2)}
                y={n2((a.y + b.y) / 2 - 1.2)}
                fontSize={ELEC_TEXT}
                textAnchor="middle"
                fill={ink}
                {...HALO}
              >
                {`${trunkingMetres(sp.level, sp.p).toFixed(1)} m`}
              </text>
            </g>
          );
        })}
      </g>
      <g className="elec-points">
        {points.map((sp) => {
          const was = sp.state === 'moved' ? ch?.from.get(sp.p.id) : undefined;
          return (
            <g key={`${sp.state}:${sp.p.id}`}>
              {was && (
                <PointMark
                  sp={{ p: was, level: before, state: 'same' }}
                  sheet={sheet}
                  ink={INK}
                  faint
                />
              )}
              <PointMark sp={sp} sheet={sheet} ink={ELEC_INK[sp.state]} />
            </g>
          );
        })}
      </g>
    </g>
  );
}

/** The schedule's rows: room, point, how many, height, and (After) the change. */
function scheduleRows(points: SheetPoint[]) {
  const rows = new Map<
    string,
    { room: string; what: string; qty: number; height: string; change: string; kind: ElecKind }
  >();
  for (const sp of points) {
    const room = pointRoom(sp.level, sp.p) ?? 'Outside';
    const height =
      ELEC_KINDS[sp.p.kind].place === 'ceiling'
        ? 'Ceiling'
        : sp.p.wall
          ? String(Math.round(sp.p.wall.height * 1000))
          : '–';
    const change = { same: '', new: 'New', moved: 'Move', removed: 'Take out' }[sp.state];
    const what = pointName(sp.p);
    const key = [room, what, height, change].join('|');
    const r = rows.get(key);
    if (r) r.qty += 1;
    else rows.set(key, { room, what, qty: 1, height, change, kind: sp.p.kind });
  }
  return [...rows.values()].sort(
    (a, b) =>
      a.room.localeCompare(b.room) ||
      ELEC_KIND_ORDER.indexOf(a.kind) - ELEC_KIND_ORDER.indexOf(b.kind) ||
      a.change.localeCompare(b.change),
  );
}

function SchedulePage({
  sheet,
  rows,
  first,
  renovation,
  title,
  label,
}: {
  sheet: Sheet;
  rows: ReturnType<typeof scheduleRows>;
  first: boolean;
  renovation: boolean;
  title: ReactNode;
  label: string;
}) {
  const x = SHEET_MM.margin + 8;
  const right = sheet.w - SHEET_MM.margin - SHEET_MM.title - 8;
  let y = SHEET_MM.margin + 12;
  const out: ReactNode[] = [];
  if (first) {
    out.push(
      <text key="h" x={x} y={y} fontSize={4.2} fontWeight={700} fill={INK}>
        Electrical schedule
      </text>,
    );
    y += 6;
    out.push(
      <text key="lew" className="sheet-lew" x={x} y={y} fontSize={2.8} fontWeight={700} fill={INK}>
        Work by a Licensed Electrical Worker.
      </text>,
    );
    y += 8;
  }
  const cols = [x, x + 52, x + 120, x + 135, x + 158];
  const head = ['Room', 'Point', 'Qty', 'Height (mm)', renovation ? 'Change' : ''];
  out.push(
    <g key="head" className="schedule-head">
      {head.map((h, i) => (
        <text key={h || i} x={cols[i]} y={y} fontSize={2.6} fontWeight={700} fill={INK}>
          {h}
        </text>
      ))}
      <line x1={x} y1={y + 1.6} x2={right} y2={y + 1.6} stroke={INK} strokeWidth={0.25} />
    </g>,
  );
  y += 6;
  rows.forEach((r, i) => {
    const ink = r.change === 'Take out' ? HACK : r.change ? NEW : INK;
    out.push(
      // biome-ignore lint/suspicious/noArrayIndexKey: rows in order
      <g key={i} className="schedule-row" data-kind={r.kind} data-qty={r.qty}>
        <text x={cols[0]} y={n2(y)} fontSize={2.6} fill={INK}>
          {r.room}
        </text>
        <text x={cols[1]} y={n2(y)} fontSize={2.6} fill={INK}>
          {r.what}
        </text>
        <text x={cols[2]} y={n2(y)} fontSize={2.6} fill={INK}>
          {r.qty}
        </text>
        <text x={cols[3]} y={n2(y)} fontSize={2.6} fill={INK}>
          {r.height}
        </text>
        <text x={cols[4]} y={n2(y)} fontSize={2.6} fill={ink}>
          {r.change}
        </text>
        <line
          x1={x}
          y1={n2(y + 1.6)}
          x2={right}
          y2={n2(y + 1.6)}
          stroke={FAINT}
          strokeWidth={0.15}
        />
      </g>,
    );
    y += 4.6;
  });
  return (
    <Frame sheet={sheet} label={label}>
      {out}
      {title}
    </Frame>
  );
}

// ---------------------------------------------------------------------------- the sheets

export interface ContractorSheets {
  pages: ReactNode[];
  scale: number;
  fits: boolean;
}

/** The sheet's pages as React elements (SVG), for `renderToStaticMarkup`. */
export function contractorPages(
  project: Project,
  opts: SheetOptions,
  date = sheetDate(),
): ContractorSheets {
  const levels = sheetLevels(project, opts.variant);
  if (!levels) throw new Error('This plan has no level to print.');
  const { level, before, diff } = levels;
  const geom = planGeometry(level);
  // Hacked walls are drawn too: the sheet and the chains go round them.
  const hacked = hackedPoints(diff);
  const sheet = layout(opts.paper, planExtent(geom, hacked));
  const boxOf = (ps: readonly Vec2[]) => {
    const xs = ps.map((p) => p.x);
    const ys = ps.map((p) => p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    return { c: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, hx: (x1 - x0) / 2, hy: (y1 - y0) / 2 };
  };
  // Labels and tags placed for their size on paper.
  const dims = planDimensions(level, geom, {
    labelHalf: (room) => {
      const h = labelFit(level, room, sheet.k).half;
      return { x: h.x / sheet.k, y: h.y / sheet.k };
    },
    tagHalf: { along: 3.6 / sheet.k, across: 1.4 / sheet.k },
    spanFigure: { w: (textWidth('0000', DIM_TEXT) + 2.6) / sheet.k, h: (DIM_TEXT + 1) / sheet.k },
    // Built-ins (always drawn), and the furniture when it is.
    avoidBoxes: Object.values(level.items).flatMap((item) => {
      const kind = furnitureKind(item.assetId);
      if (!kind?.carpentry && (!opts.furniture || kind?.ceiling)) return [];
      return [boxOf(itemFootprint(item, kind))];
    }),
    blockBoxes: (diff?.demolished ?? []).map((s) => boxOf(s.polygon)),
    include: hacked,
  });
  // Concrete walls, judged on the flat as it is; not once they're glass or cut down.
  const guarded = new Set<string>();
  for (const [id, w] of Object.entries(level.walls)) {
    if (isGlass(w) || isHalfWall(w, level.ceilingHeight)) continue;
    const s = before.walls[id] ? wallStatus(before, id) : wallStatus(level, id);
    if (s === 'structural' || s === 'shelter') guarded.add(id);
  }
  const after = diff ? level : null;
  const changes = after && diff ? renovationChanges(before, after, diff) : [];
  const version = project.renovation && diff ? 'After the renovation' : 'As it is now';
  // New doors and windows, and those cut into a wall that was there before.
  const added = new Set(diff?.openingsAdded ?? []);
  const beforeWalls = diff ? planGeometry(before).pieces.map((p) => p.polygon) : [];
  const cut = new Set(
    geom.openings
      .filter((o) => added.has(o.opening.id))
      .filter((o) => {
        const c = framePoint(o.frame, (o.span[0] + o.span[1]) / 2, 0);
        return beforeWalls.some((poly) => pointInPolygon(c, poly));
      })
      .map((o) => o.opening.id),
  );

  // Page 2 onwards: the change list, wrapped and split over pages.
  const listWidth = sheet.w - 2 * SHEET_MM.margin - SHEET_MM.title - 16;
  const rows = changes.length ? changeRows(changesAsText(changes), listWidth) : [];
  const listPages: (typeof rows)[] = [];
  if (rows.length) {
    let cur: typeof rows = [];
    let used = 20;
    const room = sheet.h - 2 * SHEET_MM.margin - 20;
    for (const r of rows) {
      const h = r.length ? r.length * 4.4 + 1.2 : 2.4;
      if (used + h > room && cur.length) {
        listPages.push(cur);
        cur = [];
        used = 12;
      }
      cur.push(r);
      used += h;
    }
    listPages.push(cur);
  }
  // The electrical plan and its schedule, after the rest.
  const elecCh = opts.electrical && diff ? electricalChanges(before, level) : null;
  const elecPoints = opts.electrical ? sheetPoints(level, before, elecCh) : [];
  const elecRows = scheduleRows(elecPoints);
  const perPage = Math.max(1, Math.floor((sheet.h - 2 * SHEET_MM.margin - 40) / 4.6));
  const schedulePages: (typeof elecRows)[] = [];
  for (let i = 0; i < elecRows.length; i += perPage)
    schedulePages.push(elecRows.slice(i, i + perPage));
  if (opts.electrical && !schedulePages.length) schedulePages.push([]);
  const elecPages = opts.electrical ? 1 + schedulePages.length : 0;
  const total = 1 + listPages.length + elecPages;
  const title = (
    page: number,
    legend: LegendKey[] | null,
    extra: { subtitle?: string; note?: string } = {},
  ) => (
    <TitleColumn
      {...extra}
      sheet={sheet}
      project={project}
      levelName={before.name}
      version={version}
      paper={opts.paper}
      north={project.site?.north ?? 0}
      legend={legend}
      page={page}
      pages={total}
      date={date}
    />
  );
  const legend = legendKeys(level, guarded, diff, cut);
  const shapes = roomShapes(level);
  const plan = (
    <Frame key="p1" sheet={sheet} label={`Plan of ${project.name}, page 1 of ${total}`}>
      <g className="plan" data-scale={sheet.scale} data-fits={sheet.fits}>
        <g className="floors">
          {[...shapes.values()].map((s, i) => (
            <path
              // biome-ignore lint/suspicious/noArrayIndexKey: rooms in order
              key={i}
              d={[s.outer, ...s.holes]
                .filter((r) => r.length >= 3)
                .map((r) => `M ${pts(r.map(sheet.P))} Z`)
                .join(' ')}
              fillRule="evenodd"
              fill="#ffffff"
            />
          ))}
        </g>
        <Furniture level={level} sheet={sheet} loose={opts.furniture} />
        {diff && <Hacked diff={diff} sheet={sheet} />}
        <Walls level={level} geom={geom} sheet={sheet} guarded={guarded} />
        {diff && <Built diff={diff} level={level} sheet={sheet} />}
        <Openings geom={geom} sheet={sheet} added={added} cut={cut} />
        <Tags tags={dims.tags} sheet={sheet} added={added} />
        {diff && <BuiltLengths diff={diff} sheet={sheet} dims={dims} />}
        <Rooms level={level} dims={dims} sheet={sheet} />
        <Chains dims={dims} sheet={sheet} />
      </g>
      {title(1, legend)}
    </Frame>
  );
  const pages: ReactNode[] = [plan];
  listPages.forEach((r, i) => {
    pages.push(
      <ChangesPage
        // biome-ignore lint/suspicious/noArrayIndexKey: pages in order
        key={`c${i}`}
        sheet={sheet}
        rows={r}
        first={i === 0}
        last={i === listPages.length - 1}
        title={title(i + 2, null)}
        label={`Changes for ${project.name}, page ${i + 2} of ${total}`}
      />,
    );
  });
  if (opts.electrical) {
    const at = 2 + listPages.length;
    const lew = 'Work by a Licensed Electrical Worker.';
    pages.push(
      <Frame
        key="e1"
        sheet={sheet}
        label={`Electrical plan of ${project.name}, page ${at} of ${total}`}
      >
        <g className="electrical-page" data-points={elecPoints.length}>
          <ElectricalPlan
            level={level}
            before={before}
            geom={geom}
            sheet={sheet}
            guarded={guarded}
            points={elecPoints}
            ch={elecCh}
          />
        </g>
        {title(at, elecLegend(elecPoints), { subtitle: 'Electrical plan', note: lew })}
      </Frame>,
    );
    schedulePages.forEach((rows, i) => {
      pages.push(
        <SchedulePage
          // biome-ignore lint/suspicious/noArrayIndexKey: pages in order
          key={`s${i}`}
          sheet={sheet}
          rows={rows}
          first={i === 0}
          renovation={!!elecCh}
          title={title(at + 1 + i, null, { subtitle: 'Electrical schedule', note: lew })}
          label={`Electrical schedule for ${project.name}, page ${at + 1 + i} of ${total}`}
        />,
      );
    });
  }
  return { pages, scale: sheet.scale, fits: sheet.fits };
}

/** The pages as SVG markup, rendered with React's server renderer (loaded when needed). */
export async function contractorMarkup(project: Project, opts: SheetOptions): Promise<string[]> {
  const { renderToStaticMarkup } = await import('react-dom/server');
  return contractorPages(project, opts).pages.map((p) => renderToStaticMarkup(p as ReactElement));
}

/**
 * Prints the sheet from a hidden frame, one page per SVG, at the paper's size with no
 * margins (the sheet draws its own); the print dialog saves it as a PDF.
 */
export async function printContractorSheet(project: Project, opts: SheetOptions) {
  const pages = await contractorMarkup(project, opts);
  for (const old of document.querySelectorAll('iframe[data-print="contractor"]')) old.remove();
  const frameEl = document.createElement('iframe');
  frameEl.setAttribute('aria-hidden', 'true');
  frameEl.dataset.print = 'contractor';
  frameEl.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
  document.body.append(frameEl);
  const doc = frameEl.contentDocument;
  const win = frameEl.contentWindow;
  if (!doc || !win) throw new Error('This browser can’t print from here.');
  const { w, h } = PAPER_MM[opts.paper];
  doc.title = `${project.name}: plan for contractors`;
  const style = doc.createElement('style');
  // Each page in a box of the paper's size that clips, so nothing spills onto a blank page.
  style.textContent = `@page{size:${opts.paper} landscape;margin:0}html,body{margin:0;padding:0;background:#fff}.sheet-paper{width:${w}mm;height:${h}mm;overflow:hidden;break-after:page;page-break-after:always}.sheet-paper:last-child{break-after:auto;page-break-after:auto}svg.contractor-page{display:block;width:${w}mm;height:${h}mm}`;
  doc.head.append(style);
  doc.body.innerHTML = pages.map((p) => `<div class="sheet-paper">${p}</div>`).join('');
  printFrame(frameEl);
}
