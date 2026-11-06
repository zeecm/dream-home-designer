import {
  type Bounds,
  type DimensionChain,
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
  framePoint,
  furnitureKind,
  isGlass,
  isHalfWall,
  itemFootprint,
  itemSize,
  outlineBounds,
  planDimensions,
  planGeometry,
  renovationChanges,
  renovationDiff,
  roomArea,
  roomShape,
  roomShapes,
  roundChain,
  sheetDrawingArea,
  sheetScale,
  variantLevels,
  wallStatus,
} from '@dhd/core';
import type { ReactElement, ReactNode } from 'react';
import { changesAsText } from '../ui/Renovation';

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
}

// Colours for paper.
const INK = '#1b1e22';
const WALL = '#3b4046';
const HALF = '#9aa0a7';
const MUTED = '#5c636b';
const FAINT = '#a9afb6';
const HACK = '#c0392b';
const NEW = '#0f8288';
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

/** Doors (by how they open), windows and openings, over the gaps in the walls. */
function Openings({ geom, sheet }: { geom: PlanGeometry; sheet: Sheet }) {
  const { P } = sheet;
  const line = (a: Vec2, b: Vec2, key: string, dash?: string) => {
    const p = P(a);
    const q = P(b);
    return (
      <line
        key={key}
        x1={n2(p.x)}
        y1={n2(p.y)}
        x2={n2(q.x)}
        y2={n2(q.y)}
        stroke={INK}
        strokeWidth={0.22}
        strokeDasharray={dash}
      />
    );
  };
  const arc = (c: Vec2, from: Vec2, to: Vec2, key: string) => {
    const r = Math.hypot(from.x - c.x, from.y - c.y) * sheet.k;
    const cross = (from.x - c.x) * (to.y - c.y) - (from.y - c.y) * (to.x - c.x);
    const p = P(from);
    const q = P(to);
    return (
      <path
        key={key}
        d={`M ${n2(p.x)} ${n2(p.y)} A ${n2(r)} ${n2(r)} 0 0 ${cross > 0 ? 1 : 0} ${n2(q.x)} ${n2(q.y)}`}
        fill="none"
        stroke={MUTED}
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
        if (o.kind === 'window') {
          parts.push(line(framePoint(f, u0, 1), framePoint(f, u1, 1), 'f1'));
          parts.push(line(framePoint(f, u0, -1), framePoint(f, u1, -1), 'f2'));
          parts.push(line(framePoint(f, u0, 0), framePoint(f, u1, 0), 'g'));
        }
        if (o.kind === 'door') {
          const style = doorStyle(o.opening);
          if (style === 'swing') {
            const s = doorSwing(f, o.opening);
            parts.push(line(s.hinge, s.leafEnd, 'leaf'));
            parts.push(arc(s.hinge, s.leafEnd, s.arcEnd, 'arc'));
          } else if (style === 'double') {
            const open = doorLeaves(f, o.opening, 1);
            const shut = doorLeaves(f, o.opening, 0);
            open.forEach((l, i) => {
              parts.push(line(l.a, l.b, `l${i}`));
              parts.push(arc(l.a, l.b, shut[i]?.b ?? l.b, `a${i}`));
            });
          } else if (style === 'sliding' || style === 'pocket') {
            const shut = doorLeaves(f, o.opening, 0);
            shut.forEach((l, i) => parts.push(line(l.a, l.b, `s${i}`)));
            if (shut.length === 1) {
              for (const [i, l] of doorLeaves(f, o.opening, 1).entries()) {
                parts.push(line(l.a, l.b, `d${i}`, '0.8 0.5'));
              }
            }
          } else {
            doorLeaves(f, o.opening, 0.5).forEach((l, i) => parts.push(line(l.a, l.b, `f${i}`)));
          }
        }
        return (
          <g key={o.opening.id} data-opening={o.opening.id}>
            <polygon points={pts(o.polygon.map(P))} fill="#ffffff" />
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

/** What the renovation hacks (red, dashed) and builds (teal), over the After walls. */
function RenovationMarks({ diff, sheet }: { diff: RenovationDiff; sheet: Sheet }) {
  const { P } = sheet;
  return (
    <>
      <g className="reno-built">
        {diff.built.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stretches in order
          <polygon key={i} points={pts(s.polygon.map(P))} fill={NEW} />
        ))}
      </g>
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
    </>
  );
}

function Tags({ tags, sheet }: { tags: OpeningTag[]; sheet: Sheet }) {
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
            fill={MUTED}
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

/**
 * A room label's size on paper (mm): its name, area and size, shrunk (to 70% at most) to fit
 * a small room, and half its box.
 */
function labelFit(level: Level, room: Room, k: number): { scale: number; half: Vec2 } {
  const w = Math.max(
    textWidth(room.name, NAME_TEXT, true),
    textWidth(areaText(roomArea(level, room)), AREA_TEXT),
  );
  const outer = roomShape(level, room).outer;
  const xs = outer.map((p) => p.x);
  const ys = outer.map((p) => p.y);
  const roomW = (Math.max(...xs) - Math.min(...xs)) * k - 2.5;
  const roomH = (Math.max(...ys) - Math.min(...ys)) * k - 2.5;
  const scale = Math.min(1, Math.max(0.7, Math.min(roomW / (w + 1.6), roomH / 8.4)));
  return { scale, half: { x: (w * scale) / 2 + 0.8, y: 4.2 * scale } };
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
        const { scale: f, half } = labelFit(level, room, sheet.k);
        const spans = dims.spans
          .filter((s) => s.roomId === roomId)
          .map((s) => {
            const x = s.axis === 'x';
            const a = P(s.a);
            const b = P(s.b);
            const len = Math.round(Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) * 100) * 10;
            const text = String(len);
            const gap = (x ? half.x : half.y) + 0.6;
            const start = x ? a.x : a.y;
            const end = x ? b.x : b.y;
            const mid0 = x ? c.x : c.y;
            const lo = mid0 - gap;
            const hi = mid0 + gap;
            const before = lo - start;
            const after = end - hi;
            const room1 = Math.max(before, after);
            const fits = room1 >= textWidth(text, DIM_TEXT) + 2;
            const mid = before >= after ? (start + lo) / 2 : (hi + end) / 2;
            return { s, x, len, text, start, end, lo, hi, fits, mid };
          });
        const onLines = spans.every((p) => p.fits);
        const extra = !onLines && spans.length ? spans.map((p) => p.text).join(' × ') : null;
        const tick = (x: boolean, v: number, key: string) => (
          <line
            key={key}
            x1={n2(x ? v - 0.6 : c.x - 0.6)}
            y1={n2(x ? c.y + 0.6 : v + 0.6)}
            x2={n2(x ? v + 0.6 : c.x + 0.6)}
            y2={n2(x ? c.y - 0.6 : v - 0.6)}
            stroke={INK}
            strokeWidth={0.18}
          />
        );
        const seg = (x: boolean, p: number, q: number, key: string) =>
          q - p > 0.3 ? (
            <line
              key={key}
              x1={n2(x ? p : c.x)}
              y1={n2(x ? c.y : p)}
              x2={n2(x ? q : c.x)}
              y2={n2(x ? c.y : q)}
              stroke={FAINT}
              strokeWidth={0.13}
            />
          ) : null;
        return (
          <g key={roomId} className="room" data-room={roomId}>
            {spans.map(({ s, x, len, text, start, end, lo, hi, mid }) => (
              <g key={s.axis} className="room-span" data-axis={s.axis} data-mm={len}>
                {seg(x, start, Math.min(lo, end), 'a')}
                {seg(x, Math.max(hi, start), end, 'b')}
                {tick(x, start, 'ta')}
                {tick(x, end, 'tb')}
                {onLines &&
                  (x ? (
                    <text
                      x={n2(mid)}
                      y={n2(c.y - 0.7)}
                      fontSize={DIM_TEXT}
                      textAnchor="middle"
                      fill={INK}
                      {...HALO}
                    >
                      {text}
                    </text>
                  ) : (
                    <text
                      x={n2(c.x - 0.7)}
                      y={n2(mid)}
                      transform={`rotate(-90 ${n2(c.x - 0.7)} ${n2(mid)})`}
                      fontSize={DIM_TEXT}
                      textAnchor="middle"
                      fill={INK}
                      {...HALO}
                    >
                      {text}
                    </text>
                  ))}
              </g>
            ))}
            <text
              className="room-name"
              x={n2(c.x)}
              y={n2(c.y - (extra ? 2.2 : 0.6) * f)}
              fontSize={n2(NAME_TEXT * f)}
              fontWeight={700}
              textAnchor="middle"
              fill={INK}
              {...HALO}
            >
              {room.name}
            </text>
            <text
              className="room-area"
              x={n2(c.x)}
              y={n2(c.y + (extra ? 0.8 : 2.4) * f)}
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
                y={n2(c.y + 3.6 * f)}
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
}: {
  chain: DimensionChain;
  sheet: Sheet;
  /** How far outside the plan's outline the line runs, mm. */
  offset: number;
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
  // before, goes out a row, and failing that, beside it.
  const rows: number[] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
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
      if (mid - w / 2 < (rows[1] as number) + 0.8) mid = (rows[1] as number) + 0.8 + w / 2;
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
      out.push(<Chain key={`${side}${c.tier}`} chain={c} sheet={sheet} offset={7 + i * 7.5} />);
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
}

function legendKeys(level: Level, guarded: ReadonlySet<string>, diff: RenovationDiff | null) {
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
  if (diff?.demolished.length) {
    keys.push({
      key: 'hacked',
      label: 'Wall to hack',
      swatch: box('url(#hack-hatch)', HACK, '1 0.6'),
    });
  }
  if (diff?.built.length) keys.push({ key: 'new', label: 'New wall', swatch: box(NEW) });
  return keys;
}

/** Splits text into lines of at most `width` mm at this size. */
function wrap(text: string, size: number, width: number, bold = false): string[] {
  const words = text.split(' ');
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
}: {
  sheet: Sheet;
  project: Project;
  levelName: string;
  version: string | null;
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
    size: number,
    opts: { bold?: boolean; color?: string; cls?: string; gap?: number } = {},
  ) => {
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
  text(project.name, 4.2, { bold: true, cls: 'sheet-name', gap: 1 });
  text('Plan for contractors', 2.6, { color: MUTED, gap: 4 });
  const row = (k: string, v: string, cls?: string) => {
    out.push(
      <text key={out.length} x={x} y={n2(y)} fontSize={2.3} fill={MUTED}>
        {k}
      </text>,
      <text key={out.length + 1} className={cls} x={x + 18} y={n2(y)} fontSize={2.3} fill={INK}>
        {v}
      </text>,
    );
    y += 3.6;
  };
  row('Date', date, 'sheet-date');
  row('Level', levelName);
  if (version) row('Version', version, 'sheet-version');
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
    gap: 4,
  });
  if (legend?.length) {
    out.push(
      <text key="lh" x={x} y={n2(y)} fontSize={2.3} fontWeight={700} fill={INK}>
        Key
      </text>,
    );
    y += 3.4;
    for (const k of legend) {
      out.push(
        <g key={`k${k.key}`} className="legend-key" data-key={k.key}>
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
  const variant = project.renovation ? opts.variant : 'before';
  const level = variantLevels(project, variant)[0];
  const before = project.levels[0];
  if (!level || !before) throw new Error('This plan has no level to print.');
  const geom = planGeometry(level);
  const sheet = layout(opts.paper, outlineBounds(geom));
  // Labels and tags placed for their size on paper.
  const dims = planDimensions(level, geom, {
    labelHalf: (room) => {
      const h = labelFit(level, room, sheet.k).half;
      return { x: h.x / sheet.k, y: h.y / sheet.k };
    },
    tagHalf: { along: 3.6 / sheet.k, across: 1.4 / sheet.k },
    // Built-ins (always drawn), and the furniture when it is.
    avoidBoxes: Object.values(level.items).flatMap((item) => {
      const kind = furnitureKind(item.assetId);
      if (!kind?.carpentry && (!opts.furniture || kind?.ceiling)) return [];
      const f = itemFootprint(item, kind);
      const xs = f.map((p) => p.x);
      const ys = f.map((p) => p.y);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      return [{ c: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, hx: (x1 - x0) / 2, hy: (y1 - y0) / 2 }];
    }),
  });
  // Concrete walls, judged on the flat as it is; not once they're glass or cut down.
  const guarded = new Set<string>();
  for (const [id, w] of Object.entries(level.walls)) {
    if (isGlass(w) || isHalfWall(w, level.ceilingHeight)) continue;
    const s = before.walls[id] ? wallStatus(before, id) : wallStatus(level, id);
    if (s === 'structural' || s === 'shelter') guarded.add(id);
  }
  const after = variant === 'after' ? level : null;
  const diff = after ? renovationDiff(before, after) : null;
  const changes = after && diff ? renovationChanges(before, after, diff) : [];
  const version = project.renovation
    ? variant === 'after'
      ? 'After the renovation'
      : 'As it is now'
    : null;

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
  const total = 1 + listPages.length;
  const title = (page: number, legend: LegendKey[] | null) => (
    <TitleColumn
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
  const legend = legendKeys(level, guarded, diff);
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
        <Walls level={level} geom={geom} sheet={sheet} guarded={guarded} />
        {diff && <RenovationMarks diff={diff} sheet={sheet} />}
        <Openings geom={geom} sheet={sheet} />
        <Tags tags={dims.tags} sheet={sheet} />
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
  style.textContent = `@page{size:${opts.paper} landscape;margin:0}html,body{margin:0;padding:0;background:#fff}svg.contractor-page{display:block;width:${w}mm;height:${h}mm;break-after:page;page-break-after:always}svg.contractor-page:last-child{break-after:auto;page-break-after:auto}`;
  doc.head.append(style);
  doc.body.innerHTML = pages.join('');
  win.focus();
  win.print();
  setTimeout(() => frameEl.remove(), 60_000);
}
