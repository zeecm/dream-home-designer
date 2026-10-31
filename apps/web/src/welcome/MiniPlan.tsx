import {
  type Item,
  type Level,
  type PlanGeometry,
  type Vec2,
  doorSwing,
  finish,
  itemFootprint,
  placeLabel,
  roomArea,
  roomShapes,
  swingZone,
} from '@dhd/core';
import type { CSSProperties, ReactNode } from 'react';

/** The sample plan's picture, as the app places it under the walls. */
export const SAMPLE_IMAGE = {
  href: '/samples/hdb-3room-type4.png',
  width: 1532,
  height: 1514,
  origin: { x: -2.970327, y: -2.439987 },
  scale: 0.009901979,
};

const pts = (poly: readonly Vec2[]) => poly.map((p) => `${p.x},${p.y}`).join(' ');

export const area = (m2: number) => `${m2.toFixed(1)} m²`;

export interface MiniPlanProps {
  level: Level;
  geom: PlanGeometry;
  /** The part of the plan shown, in metres: x, y, width, height. */
  box: [number, number, number, number];
  /** What to draw: the plan image, walls, rooms (with labels), furniture. */
  show: { image?: boolean; walls?: boolean; rooms?: boolean; labels?: boolean; items?: boolean };
  /** Per room id, a fill in place of its floor's tint. */
  fills?: Record<string, string>;
  /** Wall ids drawn in the accent (selected) or as hacked (dashed). */
  selected?: string;
  hacked?: string[];
  /** Extra furniture to draw (pieces not in the level). */
  extra?: Item[];
  /** Label size in metres (the plan scales with its box). */
  labelSize?: number;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  title: string;
}

/**
 * A read-only drawing of a plan, as the app draws it: rooms tinted by their floor, walls in
 * ink, doors with their swings, windows, and room names with their areas.
 */
export function MiniPlan({
  level,
  geom,
  box,
  show,
  fills,
  selected,
  hacked = [],
  extra = [],
  labelSize = 0.34,
  children,
  className,
  style,
  title,
}: MiniPlanProps) {
  const shapes = roomShapes(level);
  const swings = geom.openings
    .filter((o) => o.kind === 'door')
    .map((o) => swingZone(doorSwing(o.frame, o.opening)));
  const items = [...Object.values(level.items), ...extra];
  return (
    <svg
      className={className}
      style={style}
      viewBox={box.join(' ')}
      role="img"
      aria-label={title}
      preserveAspectRatio="xMidYMid meet"
    >
      {show.image && (
        <image
          href={SAMPLE_IMAGE.href}
          width={SAMPLE_IMAGE.width}
          height={SAMPLE_IMAGE.height}
          transform={`translate(${SAMPLE_IMAGE.origin.x} ${SAMPLE_IMAGE.origin.y}) scale(${SAMPLE_IMAGE.scale})`}
          opacity={show.walls ? 0.35 : 1}
          preserveAspectRatio="none"
        />
      )}
      {show.rooms &&
        Object.values(level.rooms).map((r) => {
          const s = shapes.get(r.id);
          if (!s || s.outer.length < 3) return null;
          const tint = finish(r.floorMaterial)?.color ?? '#ffffff';
          return (
            <path
              key={r.id}
              d={[s.outer, ...s.holes].map((ring) => `M ${pts(ring)} Z`).join(' ')}
              fillRule="evenodd"
              fill={fills?.[r.id] ?? `color-mix(in srgb, ${tint} 22%, #ffffff)`}
            />
          );
        })}
      {show.items &&
        items.map((it) => (
          <polygon key={it.id} points={pts(itemFootprint(it))} className="mp-item" />
        ))}
      {show.walls && (
        <g>
          {geom.pieces.map((p, i) => (
            <polygon
              key={`${p.wallId}:${i}`}
              points={pts(p.polygon)}
              className={
                p.wallId === selected
                  ? 'mp-wall mp-selected'
                  : hacked.includes(p.wallId)
                    ? 'mp-wall mp-hacked'
                    : 'mp-wall'
              }
            />
          ))}
          {geom.footprints.hubs.map((h) => (
            <polygon key={h.vertexId} points={pts(h.polygon)} className="mp-wall" />
          ))}
          {geom.openings.map((o) => (
            <polygon
              key={o.opening.id}
              points={pts(o.polygon)}
              className={o.kind === 'window' ? 'mp-window' : 'mp-gap'}
            />
          ))}
          {geom.openings
            .filter((o) => o.kind === 'door')
            .map((o) => {
              const s = doorSwing(o.frame, o.opening);
              return (
                <path
                  key={`swing:${o.opening.id}`}
                  className="mp-swing"
                  d={`M ${s.hinge.x} ${s.hinge.y} L ${s.leafEnd.x} ${s.leafEnd.y} A ${s.radius} ${s.radius} 0 0 ${s.sweep} ${s.arcEnd.x} ${s.arcEnd.y}`}
                />
              );
            })}
        </g>
      )}
      {show.labels &&
        Object.values(level.rooms).map((r) => {
          const s = shapes.get(r.id);
          if (!s || s.outer.length < 3) return null;
          const name = r.name;
          const half = { x: (name.length * labelSize * 0.55) / 2 + 0.1, y: labelSize * 1.2 };
          const xs = s.outer.map((p) => p.x);
          if (Math.max(...xs) - Math.min(...xs) < half.x * 2) return null;
          const at = placeLabel(s.outer, half, swings, s.holes);
          return (
            <g key={`label:${r.id}`} transform={`translate(${at.x} ${at.y})`}>
              <text
                className="mp-name"
                textAnchor="middle"
                fontSize={labelSize}
                y={-labelSize * 0.1}
              >
                {name}
              </text>
              <text
                className="mp-area"
                textAnchor="middle"
                fontSize={labelSize * 0.85}
                y={labelSize * 1.05}
              >
                {area(roomArea(level, r))}
              </text>
            </g>
          );
        })}
      {children}
    </svg>
  );
}

/** The plan's extent (walls only), padded, as a box for MiniPlan. */
export function planBox(level: Level, pad = 0.4): [number, number, number, number] {
  const vs = Object.values(level.vertices);
  const xs = vs.map((v) => v.x);
  const ys = vs.map((v) => v.y);
  const x0 = Math.min(...xs) - pad;
  const y0 = Math.min(...ys) - pad;
  return [x0, y0, Math.max(...xs) + pad - x0, Math.max(...ys) + pad - y0];
}
