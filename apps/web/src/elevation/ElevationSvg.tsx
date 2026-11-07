import {
  type ElevItem,
  type ElevOpening,
  type Elevation,
  type ElevationChanges,
  type ElevationLabels,
  type FurnitureMaterial,
  type Rect,
  TRUNK_DEPTH,
  type WallStatus,
  chainFigures,
  finish,
  tagText,
} from '@dhd/core';
import type { ReactNode } from 'react';
import { ElecGlyph } from '../electrical/glyph';

/**
 * A wall seen straight on, drawn: a pure function of the elevation, the labels that fit and
 * the scale, with no store access, so it can be drawn on screen and to a picture (and, in
 * slice 2, on the contractor sheet) alike. Always dark on white, whatever the theme. Drawn
 * in metres, x = u along the wall and y down from the ceiling.
 */

// Colours for paper (as the contractor sheet).
export const PAPER = {
  ink: '#1b1e22',
  muted: '#5c636b',
  faint: '#a9afb6',
  section: '#8d939a',
  hack: '#c0392b',
  new: '#0f8288',
  note: '#c4242a',
  accent: '#1b6c80',
  glass: '#e4eff3',
  white: '#ffffff',
};

const MATERIAL: Record<FurnitureMaterial, string> = {
  wood: '#dcc4a2',
  'wood-dark': '#a0826a',
  fabric: '#c1c4cb',
  'fabric-light': '#e6e4df',
  white: '#f8f8f6',
  charcoal: '#5d6166',
  metal: '#cdd0d4',
  glass: '#dcebf0',
  ceramic: '#f3f3f1',
  leaf: '#a9c69a',
  figure: '#cdd1d5',
  lamp: '#f5e6b3',
  placeholder: '#e8eaec',
};

export interface ElevationSvgProps {
  elev: Elevation;
  labels: ElevationLabels;
  /** Screen (or picture) pixels a metre, for text and line sizes. */
  pxPerM: number;
  changes?: ElevationChanges | null;
  /** The selected opening, piece, point or wall id. */
  selected?: string | null;
  /** A wallpaper's tile as a data URL (null: drawn in its colour). */
  wallpaper?: (id: string) => string | null;
  dims?: boolean;
  /** The least size of a tap target (px); 0 draws none. */
  hitPx?: number;
  /** The room a boundary opens to, for its label. */
  openTo?: string | null;
  /** Prefix for pattern ids, unique on the page. */
  idPrefix?: string;
}

/** Room round the drawing for dimensions, heights and tags (px). */
export const MARGIN_PX = { left: 58, right: 48, top: 32, chain: 22, below: 16 };
/** Compact (a phone): every height at the right, so little room on the left. */
const COMPACT_PX = { ...MARGIN_PX, left: 14, right: 52, top: 26 };
const marginsOf = (compact: boolean) => (compact ? COMPACT_PX : MARGIN_PX);

/** How many chains are drawn below the floor. */
export const chainsShown = (labels: ElevationLabels, dims: boolean) =>
  dims ? labels.chains.filter((c) => c.show).length : 0;

/** The drawing's box in metres (x, y from the top left, y down from the ceiling). */
export function drawingBox(
  elev: Elevation,
  pxPerM: number,
  chains: number,
  compact = false,
): { x: number; y: number; w: number; h: number } {
  const m = marginsOf(compact);
  const px = (n: number) => n / pxPerM;
  const ends = Math.max(0, ...elev.ends.map((e) => Math.max(-e.u0, e.u1 - elev.width)));
  const x = -ends - px(m.left);
  const y = -px(m.top);
  const w = elev.width + 2 * ends + px(m.left + m.right);
  const h = elev.ceiling + px(m.top + m.below + chains * m.chain);
  return { x, y, w, h };
}

/** The scale at which a drawing with this many chains fits `w` × `h` px. */
export function fitScale(
  elev: Elevation,
  w: number,
  h: number,
  chains: number,
  compact = false,
): number {
  const m = marginsOf(compact);
  const ends = Math.max(0, ...elev.ends.map((e) => Math.max(-e.u0, e.u1 - elev.width)));
  const across = (w - m.left - m.right) / (elev.width + 2 * ends);
  const down = (h - m.top - m.below - chains * m.chain) / elev.ceiling;
  return Math.max(8, Math.min(across, down));
}

/** The height a sheet `w` px wide needs to show the drawing whole at the width's scale. */
export function heightFor(elev: Elevation, w: number, chains: number, compact = false): number {
  const m = marginsOf(compact);
  const ends = Math.max(0, ...elev.ends.map((e) => Math.max(-e.u0, e.u1 - elev.width)));
  const k = (w - m.left - m.right) / (elev.width + 2 * ends);
  return Math.round(elev.ceiling * k + m.top + m.below + chains * m.chain);
}

const mm = (z: number) => String(Math.round(z * 1000));

export function ElevationSvg({
  elev,
  labels,
  pxPerM,
  changes,
  selected,
  wallpaper,
  dims = true,
  hitPx = 0,
  openTo,
  idPrefix = 'elev',
}: ElevationSvgProps) {
  const px = (n: number) => n / pxPerM;
  const C = elev.ceiling;
  const Y = (z: number) => C - z;
  const font = px(labels.fontPx);
  const added = changes?.added ?? new Set<string>();
  const id = (s: string) => `${idPrefix}-${s}`;
  const sw = px(1);
  const halo = {
    paintOrder: 'stroke' as const,
    stroke: PAPER.white,
    strokeWidth: px(3),
    strokeLinejoin: 'round' as const,
  };
  const text = (
    x: number,
    y: number,
    s: string,
    opts: {
      anchor?: 'start' | 'middle' | 'end';
      fill?: string;
      size?: number;
      weight?: number;
    } = {},
  ) => (
    <text
      x={x}
      y={y}
      fontSize={opts.size ?? font}
      fontFamily="IBM Plex Sans, system-ui, sans-serif"
      fontWeight={opts.weight ?? 400}
      textAnchor={opts.anchor ?? 'middle'}
      fill={opts.fill ?? PAPER.ink}
      style={halo}
    >
      {s}
    </text>
  );
  const rect = (r: Rect, props: Record<string, unknown> = {}) => (
    <rect
      x={r.u0}
      y={Y(r.z1)}
      width={Math.max(0, r.u1 - r.u0)}
      height={Math.max(0, r.z1 - r.z0)}
      {...props}
    />
  );

  // Patterns: wallpapers at their real size, and the section hatches.
  const papers = [...new Set(elev.walls.map((w) => w.material).filter((m): m is string => !!m))]
    .map((m) => ({ m, url: wallpaper?.(m) ?? null }))
    .filter((p) => p.url);
  const fillOf = (m: string | null) => {
    if (!m) return '#f2efe9';
    if (papers.some((p) => p.m === m)) return `url(#${id(`wp-${m}`)})`;
    return finish(m)?.color ?? '#f2efe9';
  };
  const sectionFill = (s: WallStatus) =>
    s === 'shelter'
      ? `url(#${id('cross')})`
      : s === 'structural' || s === 'likely'
        ? `url(#${id('hatch')})`
        : PAPER.section;
  const hatch = 0.05;

  const out: ReactNode[] = [];

  // The wall.
  for (const [i, w] of elev.walls.entries()) {
    const key = `w${i}`;
    if (w.build === 'open') {
      out.push(
        <g key={key}>
          {rect(
            { u0: w.u0, u1: w.u1, z0: 0, z1: C },
            {
              fill: 'none',
              stroke: PAPER.faint,
              strokeWidth: sw,
              strokeDasharray: `${px(6)} ${px(4)}`,
            },
          )}
          {(w.u1 - w.u0) * pxPerM > 90 &&
            text((w.u0 + w.u1) / 2, Y(C / 2), openTo ? `Open to ${openTo}` : 'Open', {
              fill: PAPER.muted,
            })}
        </g>,
      );
      continue;
    }
    const glass = (
      <g key={`${key}g`}>
        {w.panes.map((p, j) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: panes have no id
          <g key={j}>{rect(p, { fill: PAPER.glass, stroke: 'none' })}</g>
        ))}
        {w.frame.map((p, j) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: frame bars have no id
          <g key={`f${j}`}>{rect(p, { fill: PAPER.faint, stroke: 'none' })}</g>
        ))}
      </g>
    );
    if (w.build === 'glass') {
      out.push(glass);
      if ((w.u1 - w.u0) * pxPerM > 110)
        out.push(
          <g key={`${key}l`}>
            {text((w.u0 + w.u1) / 2, Y(C) + px(18), 'Glass partition', { fill: PAPER.muted })}
          </g>,
        );
      continue;
    }
    out.push(
      <g key={key}>
        {rect({ u0: w.u0, u1: w.u1, z0: 0, z1: w.top }, { fill: fillOf(w.material) })}
        {w.build === 'half' && (
          <line
            x1={w.u0}
            x2={w.u1}
            y1={Y(w.top)}
            y2={Y(w.top)}
            stroke={PAPER.ink}
            strokeWidth={px(1.5)}
          />
        )}
        {w.build === 'half' &&
          !w.glassAbove &&
          text((w.u0 + w.u1) / 2, Y((w.top + C) / 2), 'Open above', { fill: PAPER.muted })}
      </g>,
    );
    if (w.glassAbove) out.push(glass);
  }

  // Floor and ceiling, and the side walls cut through at the ends.
  const left = Math.min(0, ...elev.ends.map((e) => e.u0));
  const right = Math.max(elev.width, ...elev.ends.map((e) => e.u1));
  const frame = (
    <g key="frame">
      {elev.ends.map((e) => (
        <g key={`e${e.u0}`}>
          {rect(
            { u0: e.u0, u1: e.u1, z0: 0, z1: C },
            { fill: sectionFill(e.status), stroke: PAPER.ink, strokeWidth: sw },
          )}
        </g>
      ))}
      <line x1={left} x2={right} y1={Y(C)} y2={Y(C)} stroke={PAPER.ink} strokeWidth={sw} />
      <line
        x1={left - px(12)}
        x2={right + px(12)}
        y1={Y(0)}
        y2={Y(0)}
        stroke={PAPER.ink}
        strokeWidth={px(2)}
      />
    </g>
  );

  out.push(frame);

  // The renovation on this line: hacked and new wall.
  for (const [i, [u0, u1]] of (changes?.hacked ?? []).entries()) {
    out.push(
      <g key={`h${i}`}>
        {rect(
          { u0, u1, z0: 0, z1: C },
          {
            fill: `url(#${id('hack')})`,
            stroke: PAPER.hack,
            strokeWidth: px(1.5),
            strokeDasharray: `${px(6)} ${px(4)}`,
          },
        )}
        {text(
          Math.min(Math.max((u0 + u1) / 2, px(40)), elev.width - px(40)),
          Y(C) + px(16),
          // The whole stretch's length, when more of it was hacked than shows here.
          (changes?.hackedLength[i] ?? 0) > u1 - u0 + 0.05
            ? `Hacked · ${(changes?.hackedLength[i] ?? 0).toFixed(2)} m`
            : 'Hacked',
          { fill: PAPER.hack, weight: 500 },
        )}
      </g>,
    );
  }
  for (const [i, [u0, u1]] of (changes?.built ?? []).entries()) {
    out.push(
      <g key={`b${i}`}>
        {rect({ u0, u1, z0: 0, z1: C }, { fill: 'none', stroke: PAPER.new, strokeWidth: px(2) })}
        {text((u0 + u1) / 2, Y(C) + px(16), 'New wall', { fill: PAPER.new, weight: 500 })}
      </g>,
    );
  }

  // Dead-end walls standing out from it, cut through.
  for (const f of elev.fins) {
    out.push(
      <g key={`fin${f.wallId}`}>
        {rect(
          { u0: f.u0, u1: f.u1, z0: 0, z1: f.top },
          { fill: sectionFill(f.status), stroke: PAPER.ink, strokeWidth: sw },
        )}
      </g>,
    );
  }

  // Openings.
  for (const o of elev.openings) out.push(<OpeningShape key={o.id} o={o} px={px} Y={Y} />);
  for (const r of changes?.removed ?? []) {
    out.push(
      <g key={`rm${r.id}`}>
        {rect(r.at, {
          fill: 'none',
          stroke: PAPER.hack,
          strokeWidth: px(1.5),
          strokeDasharray: `${px(5)} ${px(3)}`,
        })}
      </g>,
    );
  }

  // Pieces, far from you first.
  for (const it of elev.items)
    out.push(<ItemShape key={it.id} it={it} px={px} Y={Y} font={font} />);

  // New in the renovation: a teal outline.
  for (const o of elev.openings) {
    if (added.has(o.id))
      out.push(
        <g key={`new${o.id}`} data-new={o.id}>
          {rect(
            { u0: o.u0, u1: o.u1, z0: o.sill, z1: o.head },
            { fill: 'none', stroke: PAPER.new, strokeWidth: px(2.5) },
          )}
        </g>,
      );
  }
  for (const it of elev.items) {
    if (added.has(it.id))
      out.push(
        <g key={`new${it.id}`} data-new={it.id}>
          {rect(it.outline, { fill: 'none', stroke: PAPER.new, strokeWidth: px(2.5) })}
        </g>,
      );
  }

  // Trunking under the ceiling.
  for (const [i, t] of elev.trunking.entries()) {
    const r = { u0: t.u0, u1: t.u1, z0: C - TRUNK_DEPTH, z1: C };
    out.push(
      <g key={`t${i}`}>
        {rect(r, {
          fill: PAPER.white,
          stroke: PAPER.ink,
          strokeWidth: sw,
          strokeDasharray: `${px(4)} ${px(3)}`,
        })}
        {(t.u1 - t.u0) * pxPerM > 50 &&
          text((t.u0 + t.u1) / 2, Y(C - TRUNK_DEPTH) + font * 1.2, `${t.length.toFixed(1)} m`, {
            fill: PAPER.muted,
          })}
      </g>,
    );
  }

  // Points: plates at their size, the plan's symbol inside (their tags go on top, later).
  const moved = new Set((changes?.moved ?? []).map((m) => m.id));
  const tagsOut: ReactNode[] = [];
  for (const p of elev.points) {
    const r = { u0: p.u - p.w / 2, u1: p.u + p.w / 2, z0: p.z - p.h / 2, z1: p.z + p.h / 2 };
    const warn = p.warnings.length > 0 || p.onGlass;
    if (labels.tags !== 'none') {
      tagsOut.push(
        <g key={`tag${p.id}`} data-tag={p.id}>
          {text(p.u, Y(r.z1) - px(5), tagText(p, labels.tags === 'full', labels.tagNotes[p.id]), {
            size: font,
            fill: labels.tagNotes[p.id] ? PAPER.note : PAPER.ink,
          })}
        </g>,
      );
    }
    out.push(
      <g
        key={p.id}
        data-point={p.id}
        data-change={moved.has(p.id) ? 'moved' : added.has(p.id) ? 'new' : undefined}
      >
        {rect(r, {
          fill: PAPER.white,
          stroke: added.has(p.id) ? PAPER.new : PAPER.ink,
          strokeWidth: added.has(p.id) ? px(2) : sw,
          strokeDasharray: moved.has(p.id) ? `${px(3)} ${px(2)}` : undefined,
        })}
        <g transform={`translate(${p.u} ${Y(p.z)})`}>
          <ElecGlyph
            kind={p.kind}
            r={Math.min(p.w, p.h) * 0.36}
            stroke={PAPER.ink}
            fill={PAPER.white}
            sw={Math.min(sw, Math.min(p.w, p.h) * 0.06)}
          />
        </g>
        {warn && (
          <circle
            cx={p.u}
            cy={Y(p.z)}
            r={Math.max(p.w, p.h) / 2 + px(5)}
            fill="none"
            stroke={PAPER.note}
            strokeWidth={px(1.5)}
          />
        )}
      </g>,
    );
  }

  // Notes: a red outline and a numbered badge.
  for (const n of elev.notes) {
    out.push(
      <g key={`n${n.n}`} data-note={n.n}>
        {rect(n.at, { fill: 'none', stroke: PAPER.note, strokeWidth: px(2) })}
      </g>,
    );
  }
  const badgesOut: ReactNode[] = [];
  for (const b of labels.badges) {
    const bx = b.u;
    const by = Y(b.z);
    badgesOut.push(
      <g key={`b${b.n}`} data-badge={b.n}>
        <rect
          x={bx - px(13)}
          y={by - px(9)}
          width={px(26)}
          height={px(18)}
          rx={px(9)}
          fill={PAPER.note}
        />
        <text
          x={bx}
          y={by + px(4.5)}
          fontSize={px(12)}
          fontWeight={600}
          fontFamily="IBM Plex Sans, system-ui, sans-serif"
          textAnchor="middle"
          fill={PAPER.white}
        >
          {`!${b.n}`}
        </text>
      </g>,
    );
  }

  // Selected: an accent outline (and a ring round a point, a plate being small).
  const selPoint = selected ? elev.points.find((x) => x.id === selected) : undefined;
  const sel = (() => {
    if (!selected) return null;
    const p = elev.points.find((x) => x.id === selected);
    if (p) return { u0: p.u - p.w / 2, u1: p.u + p.w / 2, z0: p.z - p.h / 2, z1: p.z + p.h / 2 };
    const o = elev.openings.find((x) => x.id === selected);
    if (o) return { u0: o.u0, u1: o.u1, z0: o.sill, z1: o.head };
    const it = elev.items.find((x) => x.id === selected);
    if (it) return it.outline;
    const w = elev.walls.filter((x) => x.wallId === selected);
    if (w.length)
      return {
        u0: Math.min(...w.map((x) => x.u0)),
        u1: Math.max(...w.map((x) => x.u1)),
        z0: 0,
        z1: C,
      };
    return null;
  })();

  // Dimensions: chains below the floor, heights beside what they measure.
  const dimsOut: ReactNode[] = [];
  if (dims) {
    let row = 0;
    elev.chains.forEach((c, ci) => {
      const lab = labels.chains[ci];
      if (!lab?.show) return;
      const y = Y(0) + px(MARGIN_PX.chain * (row + 1));
      row++;
      const figs = chainFigures(c.stops);
      const s0 = c.stops[0] ?? 0;
      const s1 = c.stops[c.stops.length - 1] ?? 0;
      dimsOut.push(
        <g key={`c${c.tier}`} data-tier={c.tier}>
          <line x1={s0} x2={s1} y1={y} y2={y} stroke={PAPER.muted} strokeWidth={sw} />
          {c.stops.map((s) => (
            <line
              key={s}
              x1={s - px(4)}
              x2={s + px(4)}
              y1={y + px(4)}
              y2={y - px(4)}
              stroke={PAPER.ink}
              strokeWidth={px(1.25)}
            />
          ))}
          {figs.map((f, i) =>
            lab.figures[i] ? (
              <g key={`${c.stops[i]}`}>
                {text(
                  ((c.stops[i] as number) + (c.stops[i + 1] as number)) / 2,
                  y - px(4),
                  String(f),
                )}
              </g>
            ) : null,
          )}
        </g>,
      );
    });
    const merged = labels.merged;
    if (merged?.marks.length) {
      const x = right + px(10);
      const top = Math.max(...merged.marks);
      dimsOut.push(
        <g key="ht-all" data-height="all">
          <line x1={x} x2={x} y1={Y(0)} y2={Y(top)} stroke={PAPER.muted} strokeWidth={sw} />
          {[0, ...merged.marks].map((z) => (
            <line
              key={z}
              x1={x - px(4)}
              x2={x + px(4)}
              y1={Y(z)}
              y2={Y(z)}
              stroke={PAPER.ink}
              strokeWidth={px(1.25)}
            />
          ))}
          {merged.marks.map((z, i) =>
            merged.shown[i] ? (
              <g key={`l${z}`}>{text(x + px(5), Y(z) + font * 0.35, mm(z), { anchor: 'start' })}</g>
            ) : null,
          )}
        </g>,
      );
    }
    elev.heights.forEach((h, hi) => {
      if (merged) return;
      const shown = labels.heights[hi] ?? [];
      const top = Math.max(...h.marks);
      const x =
        h.what === 'ceiling' ? left - px(16) : h.side === 'left' ? h.u - px(10) : h.u + px(10);
      const tx = h.side === 'left' ? x - px(4) : x + px(4);
      dimsOut.push(
        <g key={`ht${h.what}${h.u}${h.marks.join()}`} data-height={h.what}>
          <line x1={x} x2={x} y1={Y(0)} y2={Y(top)} stroke={PAPER.muted} strokeWidth={sw} />
          {[0, ...h.marks].map((z) => (
            <line
              key={z}
              x1={x - px(4)}
              x2={x + px(4)}
              y1={Y(z)}
              y2={Y(z)}
              stroke={PAPER.ink}
              strokeWidth={px(1.25)}
            />
          ))}
          {h.marks.map((z, i) =>
            shown[i] ? (
              <g key={`l${z}`}>
                {text(tx, Y(z) + font * 0.35, mm(z), {
                  anchor: h.side === 'left' ? 'end' : 'start',
                })}
              </g>
            ) : null,
          )}
        </g>,
      );
    });
  }

  // Tap targets, never smaller than hitPx.
  const hits: ReactNode[] = [];
  if (hitPx > 0) {
    const min = px(hitPx);
    const pad = (r: Rect): Rect => {
      const cu = (r.u0 + r.u1) / 2;
      const cz = (r.z0 + r.z1) / 2;
      const hu = Math.max((r.u1 - r.u0) / 2, min / 2);
      const hz = Math.max((r.z1 - r.z0) / 2, min / 2);
      return { u0: cu - hu, u1: cu + hu, z0: cz - hz, z1: cz + hz };
    };
    const hit = (key: string, r: Rect, label: string) => (
      <g key={key}>
        {rect(r, {
          fill: 'transparent',
          'data-elev-hit': key,
          'aria-label': label,
          style: { cursor: 'pointer' },
        })}
      </g>
    );
    for (const w of elev.walls)
      if (w.wallId && w.build !== 'open')
        hits.push(
          hit(
            `wall:${w.wallId}`,
            { u0: w.u0, u1: w.u1, z0: 0, z1: w.build === 'half' ? w.top : C },
            'Wall',
          ),
        );
    for (const o of elev.openings)
      hits.push(
        hit(`opening:${o.id}`, pad({ u0: o.u0, u1: o.u1, z0: o.sill, z1: o.head }), o.kind),
      );
    for (const it of elev.items) hits.push(hit(`item:${it.id}`, pad(it.outline), it.name));
    for (const p of elev.points)
      hits.push(
        hit(
          `point:${p.id}`,
          pad({ u0: p.u - p.w / 2, u1: p.u + p.w / 2, z0: p.z - p.h / 2, z1: p.z + p.h / 2 }),
          `Point ${p.n}`,
        ),
      );
  }

  return (
    <g className="elev-drawing">
      <defs>
        {papers.map((p) => (
          <pattern
            key={p.m}
            id={id(`wp-${p.m}`)}
            width={0.6}
            height={0.6}
            patternUnits="userSpaceOnUse"
            // Tiled from the floor at the face's left end.
            patternTransform={`translate(0 ${Y(0)})`}
          >
            <image href={p.url ?? ''} width={0.6} height={0.6} preserveAspectRatio="none" />
          </pattern>
        ))}
        <pattern
          id={id('hatch')}
          width={hatch}
          height={hatch}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width={hatch} height={hatch} fill={PAPER.white} />
          <line x1={0} y1={0} x2={0} y2={hatch} stroke={PAPER.ink} strokeWidth={0.008} />
        </pattern>
        <pattern
          id={id('cross')}
          width={hatch}
          height={hatch}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width={hatch} height={hatch} fill={PAPER.white} />
          <line x1={0} y1={0} x2={0} y2={hatch} stroke={PAPER.ink} strokeWidth={0.008} />
          <line x1={0} y1={0} x2={hatch} y2={0} stroke={PAPER.ink} strokeWidth={0.008} />
        </pattern>
        <pattern
          id={id('hack')}
          width={0.1}
          height={0.1}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line
            x1={0}
            y1={0}
            x2={0}
            y2={0.1}
            stroke={PAPER.hack}
            strokeWidth={0.012}
            strokeOpacity={0.5}
          />
        </pattern>
      </defs>
      {out}
      {sel && rect(sel, { fill: 'none', stroke: PAPER.accent, strokeWidth: px(2.5) })}
      {selPoint && (
        <circle
          cx={selPoint.u}
          cy={Y(selPoint.z)}
          r={Math.max(selPoint.w, selPoint.h) / 2 + px(7)}
          fill="none"
          stroke={PAPER.accent}
          strokeWidth={px(2.5)}
        />
      )}
      {dimsOut}
      {badgesOut}
      {tagsOut}
      {hits}
    </g>
  );
}

function OpeningShape({
  o,
  px,
  Y,
}: {
  o: ElevOpening;
  px: (n: number) => number;
  Y: (z: number) => number;
}) {
  const sw = px(1.25);
  const w = o.u1 - o.u0;
  const h = o.head - o.sill;
  if (w <= 0 || h <= 0) return null;
  const box = (
    <rect
      x={o.u0}
      y={Y(o.head)}
      width={w}
      height={h}
      fill={o.kind === 'window' ? PAPER.glass : o.kind === 'passage' ? PAPER.white : '#f3eee6'}
      stroke={PAPER.ink}
      strokeWidth={sw}
    />
  );
  if (o.kind === 'window') {
    const f = Math.min(0.04, w / 6, h / 6);
    return (
      <g data-opening={o.id}>
        {box}
        <rect
          x={o.u0 + f}
          y={Y(o.head) + f}
          width={w - 2 * f}
          height={h - 2 * f}
          fill="none"
          stroke={PAPER.ink}
          strokeWidth={px(0.75)}
        />
        <line
          x1={o.u0 - 0.03}
          x2={o.u1 + 0.03}
          y1={Y(o.sill)}
          y2={Y(o.sill)}
          stroke={PAPER.ink}
          strokeWidth={px(2)}
        />
      </g>
    );
  }
  if (o.kind === 'passage') return <g data-opening={o.id}>{box}</g>;
  // A door: its leaves shut, as you see them.
  const n = Math.max(1, o.panels);
  const step = w / n;
  const dash = `${px(5)} ${px(4)}`;
  const leaves: ReactNode[] = [];
  const glazedFill =
    o.glazed === 'frosted'
      ? '#eef3f5'
      : o.glazed === 'clear' || o.glazed === 'fluted'
        ? PAPER.glass
        : null;
  for (let i = 0; i < n; i++) {
    const a = o.u0 + i * step;
    const b = a + step;
    leaves.push(
      <g key={i}>
        {i > 0 && (
          <line x1={a} x2={a} y1={Y(o.head)} y2={Y(0)} stroke={PAPER.ink} strokeWidth={px(1)} />
        )}
        {glazedFill && (
          <rect
            x={a + Math.min(0.08, step / 5)}
            y={Y(o.head) + 0.12}
            width={Math.max(0, step - 2 * Math.min(0.08, step / 5))}
            height={Math.max(0, o.head - 0.3)}
            fill={glazedFill}
            stroke={PAPER.ink}
            strokeWidth={px(0.75)}
          />
        )}
        {o.glazed === 'fluted' &&
          Array.from({ length: Math.max(2, Math.floor(step / 0.05)) }, (_, k) => {
            const x = a + 0.1 + k * 0.05;
            return x < b - 0.1 ? (
              <line
                key={x}
                x1={x}
                x2={x}
                y1={Y(o.head) + 0.12}
                y2={Y(0.18)}
                stroke={PAPER.faint}
                strokeWidth={px(0.5)}
              />
            ) : null;
          })}
      </g>,
    );
  }
  const handleZ = 1.0;
  const handle = (u: number) => (
    <circle key={`hd${u}`} cx={u} cy={Y(handleZ)} r={px(2.5)} fill={PAPER.ink} />
  );
  const marks: ReactNode[] = [];
  if (o.style === 'swing' || o.style === 'double') {
    // The dashed chevron points to the hinge side.
    const chevron = (latch: number, hinge: number, k: string) => (
      <polyline
        key={k}
        points={`${latch},${Y(o.head)} ${hinge},${Y(o.head / 2)} ${latch},${Y(0)}`}
        fill="none"
        stroke={PAPER.ink}
        strokeWidth={px(0.75)}
        strokeDasharray={dash}
      />
    );
    if (o.style === 'double') {
      const mid = (o.u0 + o.u1) / 2;
      marks.push(chevron(mid, o.u0, 'l'), chevron(mid, o.u1, 'r'));
      marks.push(handle(mid - 0.06), handle(mid + 0.06));
    } else {
      const latchAtLeft = o.latch === 'left';
      const latch = latchAtLeft ? o.u0 : o.u1;
      const hinge = latchAtLeft ? o.u1 : o.u0;
      marks.push(chevron(latch, hinge, 'c'));
      marks.push(handle(latchAtLeft ? o.u0 + 0.07 : o.u1 - 0.07));
    }
  } else if (o.style === 'sliding' || o.style === 'pocket') {
    // An arrow towards the end the leaves slide to (away from the handle).
    const toLeft = o.latch === 'right';
    const y = Y(handleZ + 0.25);
    const c = (o.u0 + o.u1) / 2;
    const len = Math.min(0.3, w / 3);
    const tip = toLeft ? c - len / 2 : c + len / 2;
    const tail = toLeft ? c + len / 2 : c - len / 2;
    const k = toLeft ? 1 : -1;
    marks.push(
      <g key="arrow">
        <line x1={tail} x2={tip} y1={y} y2={y} stroke={PAPER.ink} strokeWidth={px(1)} />
        <polyline
          points={`${tip + k * px(6)},${y - px(4)} ${tip},${y} ${tip + k * px(6)},${y + px(4)}`}
          fill="none"
          stroke={PAPER.ink}
          strokeWidth={px(1)}
        />
      </g>,
    );
    if (o.latch) marks.push(handle(o.latch === 'left' ? o.u0 + 0.06 : o.u1 - 0.06));
  } else {
    // Bi-fold and folding: fold marks across the panels.
    for (let i = 0; i < n; i++) {
      const a = o.u0 + i * step;
      const b = a + step;
      const [p, q] = i % 2 ? [b, a] : [a, b];
      marks.push(
        <polyline
          key={`f${i}`}
          points={`${p},${Y(o.head)} ${q},${Y(o.head / 2)} ${p},${Y(0)}`}
          fill="none"
          stroke={PAPER.ink}
          strokeWidth={px(0.75)}
          strokeDasharray={dash}
        />,
      );
    }
  }
  return (
    <g data-opening={o.id}>
      {box}
      {leaves}
      {marks}
    </g>
  );
}

function ItemShape({
  it,
  px,
  Y,
  font,
}: {
  it: ElevItem;
  px: (n: number) => number;
  Y: (z: number) => number;
  font: number;
}) {
  const r = (x: Rect, props: Record<string, unknown>, key?: string | number) => (
    <rect
      key={key}
      x={x.u0}
      y={Y(x.z1)}
      width={Math.max(0, x.u1 - x.u0)}
      height={Math.max(0, x.z1 - x.z0)}
      {...props}
    />
  );
  const o = it.outline;
  if (it.model) {
    const wide = (o.u1 - o.u0) / px(1) > (it.name.length * font * 0.6) / px(1) + 8;
    return (
      <g data-item={it.id}>
        {r(o, { fill: '#eceef0', fillOpacity: 0.85, stroke: PAPER.muted, strokeWidth: px(1) })}
        {wide && (
          <text
            x={(o.u0 + o.u1) / 2}
            y={Y((o.z0 + o.z1) / 2) + font * 0.35}
            fontSize={font}
            fontFamily="IBM Plex Sans, system-ui, sans-serif"
            textAnchor="middle"
            fill={PAPER.muted}
          >
            {it.name}
          </text>
        )}
      </g>
    );
  }
  const dashed = !it.square;
  return (
    <g data-item={it.id}>
      {it.parts.map((p, i) =>
        r(
          p,
          dashed
            ? {
                fill: 'none',
                stroke: PAPER.muted,
                strokeWidth: px(1),
                strokeDasharray: `${px(4)} ${px(3)}`,
              }
            : { fill: MATERIAL[p.material] ?? '#e8eaec', stroke: PAPER.ink, strokeWidth: px(0.75) },
          i,
        ),
      )}
      {it.fronts.map((f, i) =>
        r(f, { fill: 'none', stroke: PAPER.ink, strokeWidth: px(0.75) }, `fr${i}`),
      )}
      {it.lines.map((z) => (
        <line
          key={`ln${z}`}
          x1={o.u0}
          x2={o.u1}
          y1={Y(z)}
          y2={Y(z)}
          stroke={PAPER.ink}
          strokeWidth={px(0.75)}
        />
      ))}
    </g>
  );
}
