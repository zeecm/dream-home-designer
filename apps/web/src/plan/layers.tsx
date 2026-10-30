import {
  type Level,
  type PlanGeometry,
  type Vec2,
  doorSwing,
  framePoint,
  labelPoint,
  roomArea,
  roomPolygon,
} from '@dhd/core';
import { memo } from 'react';
import type { Selection } from '../editor';
import { formatArea, formatLength } from '../units';
import { type Size, type View, worldToScreen } from './view';

export const pts = (poly: readonly Vec2[]) => poly.map((p) => `${p.x},${p.y}`).join(' ');
const hit = (s: Selection) => `${s.kind}:${s.id}`;

export function parseHit(target: EventTarget | null): Selection | null {
  const el = (target as Element | null)?.closest?.('[data-hit]');
  const raw = el?.getAttribute('data-hit');
  if (!raw) return null;
  const i = raw.indexOf(':');
  const kind = raw.slice(0, i) as Selection['kind'];
  return { kind, id: raw.slice(i + 1) } as Selection;
}

/** Rooms, walls and openings in world units (metres); drawn inside the view transform. */
export const PlanShapes = memo(function PlanShapes({
  level,
  geom,
  interactive,
}: {
  level: Level;
  geom: PlanGeometry;
  interactive: boolean;
}) {
  const pe = interactive ? undefined : 'none';
  return (
    <g>
      <g className="rooms">
        {Object.values(level.rooms).map((r) => (
          <polygon
            key={r.id}
            className={`room floor-${r.floorMaterial}`}
            points={pts(roomPolygon(level, r))}
            data-hit={hit({ kind: 'room', id: r.id })}
            pointerEvents={pe}
          />
        ))}
      </g>
      <g className="walls">
        {geom.pieces.map((p, i) => (
          <polygon
            key={`${p.wallId}:${i}`}
            className="wall"
            points={pts(p.polygon)}
            data-hit={hit({ kind: 'wall', id: p.wallId })}
            pointerEvents={pe}
          />
        ))}
        {geom.footprints.hubs.map((h) => (
          <polygon
            key={h.vertexId}
            className="wall hub"
            points={pts(h.polygon)}
            pointerEvents="none"
          />
        ))}
      </g>
      <g className="openings">
        {geom.openings.map((o) => {
          const f = o.frame;
          const [u0, u1] = o.span;
          const sel = { kind: 'opening', id: o.opening.id } as const;
          return (
            <g key={o.opening.id} data-hit={hit(sel)} pointerEvents={pe}>
              <polygon className={`gap gap-${o.kind}`} points={pts(o.polygon)} />
              {o.kind === 'window' && (
                <>
                  <line
                    className="glazing"
                    x1={framePoint(f, u0, 0).x}
                    y1={framePoint(f, u0, 0).y}
                    x2={framePoint(f, u1, 0).x}
                    y2={framePoint(f, u1, 0).y}
                  />
                  <polygon className="window-frame" points={pts(o.polygon)} />
                </>
              )}
              {o.kind === 'door' && <DoorSymbol geom={o} />}
            </g>
          );
        })}
      </g>
    </g>
  );
});

function DoorSymbol({ geom }: { geom: PlanGeometry['openings'][number] }) {
  const s = doorSwing(geom.frame, geom.opening);
  return (
    <>
      <path
        className="door-hit"
        d={`M ${s.hinge.x} ${s.hinge.y} L ${s.leafEnd.x} ${s.leafEnd.y} A ${s.radius} ${s.radius} 0 0 ${s.sweep} ${s.arcEnd.x} ${s.arcEnd.y} Z`}
      />
      <line className="door-leaf" x1={s.hinge.x} y1={s.hinge.y} x2={s.leafEnd.x} y2={s.leafEnd.y} />
      <path
        className="door-arc"
        d={`M ${s.leafEnd.x} ${s.leafEnd.y} A ${s.radius} ${s.radius} 0 0 ${s.sweep} ${s.arcEnd.x} ${s.arcEnd.y}`}
      />
    </>
  );
}

/** Highlights for the hovered and selected element, in world units. */
export function PlanHighlights({
  level,
  geom,
  hover,
  selection,
}: {
  level: Level;
  geom: PlanGeometry;
  hover: Selection | null;
  selection: Selection | null;
}) {
  const shape = (s: Selection | null, cls: string) => {
    if (!s) return null;
    if (s.kind === 'wall') {
      return geom.pieces
        .filter((p) => p.wallId === s.id)
        .map((p) => (
          <polygon key={`${cls}:${pts(p.polygon)}`} className={cls} points={pts(p.polygon)} />
        ));
    }
    if (s.kind === 'opening') {
      const o = geom.openings.find((x) => x.opening.id === s.id);
      return o ? <polygon className={cls} points={pts(o.polygon)} /> : null;
    }
    if (s.kind === 'room') {
      const r = level.rooms[s.id];
      return r ? (
        <polygon className={`${cls} room-outline`} points={pts(roomPolygon(level, r))} />
      ) : null;
    }
    return null;
  };
  return (
    <g pointerEvents="none">
      {hover &&
        (hover.kind !== selection?.kind || hover.id !== selection?.id) &&
        shape(hover, 'hover')}
      {shape(selection, 'selected')}
    </g>
  );
}

interface ScreenProps {
  level: Level;
  geom: PlanGeometry;
  view: View;
  size: Size;
}

/** Room names and areas, set in screen pixels so they stay legible at any zoom. */
export const RoomLabels = memo(function RoomLabels({ level, view, size }: ScreenProps) {
  return (
    <g className="room-labels" pointerEvents="none">
      {Object.values(level.rooms).map((r) => {
        const poly = roomPolygon(level, r);
        const xs = poly.map((p) => p.x);
        const ys = poly.map((p) => p.y);
        const w = (Math.max(...xs) - Math.min(...xs)) * view.zoom;
        const h = (Math.max(...ys) - Math.min(...ys)) * view.zoom;
        const area = formatArea(roomArea(level, r));
        // Rough advance widths of the label face at 14px semibold and 13px regular. The
        // name matters more than the area, so the area goes first, then the name shortens.
        const room = w - 12;
        let name = r.name;
        while (name.length > 3 && name.length * 7.6 > room) name = `${name.slice(0, -2)}…`;
        const nameFits = name.length * 7.6 <= room && h >= 22;
        const areaFits = nameFits && area.length * 6.8 <= room && h >= 40;
        if (!nameFits) return null;
        const c = worldToScreen(view, size, labelPoint(poly));
        return (
          <g key={r.id} transform={`translate(${c.x} ${c.y})`}>
            <text className="room-name" textAnchor="middle" y={areaFits ? -3 : 5}>
              {name}
            </text>
            {areaFits && (
              <text className="room-area num" textAnchor="middle" y={14}>
                {area}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
});

/** The selected wall's length, drawn as a dimension line outside it. */
export function WallDimension({ geom, view, size, wallId }: ScreenProps & { wallId: string }) {
  const f = geom.frames[wallId];
  if (!f) return null;
  const off = f.half + 18 / view.zoom;
  const p0 = worldToScreen(view, size, {
    x: f.a.x + f.n.x * off,
    y: f.a.y + f.n.y * off,
  });
  const p1 = worldToScreen(view, size, {
    x: f.a.x + f.d.x * f.length + f.n.x * off,
    y: f.a.y + f.d.y * f.length + f.n.y * off,
  });
  const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  let angle = (Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180) / Math.PI;
  if (angle > 90) angle -= 180;
  if (angle < -90) angle += 180;
  return (
    <g className="dimension" pointerEvents="none">
      <line x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} />
      <g transform={`translate(${mid.x} ${mid.y}) rotate(${angle})`}>
        <rect x={-30} y={-10} width={60} height={20} rx={4} />
        <text textAnchor="middle" y={4} className="num">
          {formatLength(f.length)}
        </text>
      </g>
    </g>
  );
}

/** Corner handles in screen pixels; every corner is grabbable, the relevant ones are shown. */
export const VertexHandles = memo(function VertexHandles({
  level,
  view,
  size,
  shown,
  interactive,
}: {
  level: Level;
  view: View;
  size: Size;
  shown: Set<string> | 'all';
  interactive: boolean;
}) {
  return (
    <g className="vertices">
      {Object.values(level.vertices).map((v) => {
        const p = worldToScreen(view, size, v);
        const visible = shown === 'all' || shown.has(v.id);
        return (
          <g key={v.id} transform={`translate(${p.x} ${p.y})`}>
            {interactive && (
              <circle r={8} className="vertex-hit" data-hit={hit({ kind: 'vertex', id: v.id })} />
            )}
            {visible && <circle r={4} className="vertex" pointerEvents="none" />}
          </g>
        );
      })}
    </g>
  );
});
