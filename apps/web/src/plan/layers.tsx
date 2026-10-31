import {
  type Level,
  type PlanGeometry,
  type RoomShape,
  type Vec2,
  doorSwing,
  finish,
  framePoint,
  furnitureKind,
  itemFootprint,
  itemSize,
  labelClearance,
  placeLabel,
  roomArea,
  roomShape,
  roomShapes,
  swingZone,
} from '@dhd/core';
import { memo, useMemo } from 'react';
import type { Selection } from '../editor';
import { formatArea, formatLength } from '../units';
import { type Size, type View, worldToScreen } from './view';

export const pts = (poly: readonly Vec2[]) => poly.map((p) => `${p.x},${p.y}`).join(' ');
/** An SVG path for a room's outline and holes; draw it with fill-rule evenodd. */
const shapePath = (s: RoomShape) =>
  [s.outer, ...s.holes]
    .filter((ring) => ring.length >= 3)
    .map((ring) => `M ${pts(ring)} Z`)
    .join(' ');
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
  /**
   * What can be pointed at: everything (Select), or only the pieces a placing tool can also
   * move (furniture in Furniture; doors, windows and openings in their tools).
   */
  interactive: boolean | 'items' | 'openings';
}) {
  const pe = interactive === true ? undefined : 'none';
  const peItems = interactive === true || interactive === 'items' ? undefined : 'none';
  const peOpenings = interactive === true || interactive === 'openings' ? undefined : 'none';
  return (
    <g>
      <g className="rooms">
        {Object.values(level.rooms).map((r) => (
          <path
            key={r.id}
            className={`room floor-${r.floorMaterial}`}
            // A light tint of the floor's own colour, over the plan's paper.
            style={{
              fill: `color-mix(in srgb, ${finish(r.floorMaterial)?.color ?? '#ffffff'} 22%, var(--surface))`,
            }}
            d={shapePath(roomShape(level, r))}
            fillRule="evenodd"
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
        {geom.boundaries.map((id) => {
          const f = geom.frames[id];
          if (!f) return null;
          const a = framePoint(f, 0, 0);
          const b = framePoint(f, f.length, 0);
          // A dashed line is only hittable on its dashes; a wide clear twin takes the clicks.
          return (
            <g key={id} data-hit={hit({ kind: 'wall', id })}>
              <line
                className="boundary-hit"
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                pointerEvents={pe ?? 'stroke'}
              />
              <line className="boundary" x1={a.x} y1={a.y} x2={b.x} y2={b.y} pointerEvents="none" />
            </g>
          );
        })}
        {geom.footprints.hubs.map((h) => (
          <polygon
            key={h.vertexId}
            className="wall hub"
            points={pts(h.polygon)}
            pointerEvents="none"
          />
        ))}
      </g>
      <g className="items">
        {Object.values(level.items).map((item) => {
          const f = itemFootprint(item);
          const kind = furnitureKind(item.assetId);
          if (kind?.ceiling) {
            // Overhead: the usual light-fitting symbol, a circle with a cross, so it reads as
            // above the room and doesn't hide what stands under it.
            const { w, d } = itemSize(item);
            const r = Math.min(w, d) / 2;
            const k = r * Math.SQRT1_2;
            const { x, z: y } = item.position;
            return (
              <g
                key={item.id}
                data-hit={hit({ kind: 'item', id: item.id })}
                pointerEvents={peItems}
                className="item item-overhead"
              >
                <circle cx={x} cy={y} r={r} />
                {/* The cross marks a light; a ceiling fan is just its circle. */}
                {kind.light && (
                  <path
                    d={`M${x - k} ${y - k}L${x + k} ${y + k}M${x - k} ${y + k}L${x + k} ${y - k}`}
                  />
                )}
              </g>
            );
          }
          return (
            <g
              key={item.id}
              data-hit={hit({ kind: 'item', id: item.id })}
              pointerEvents={peItems}
              className={`item item-${(kind?.category ?? 'other').toLowerCase()}`}
            >
              <polygon points={pts(f)} />
              {/* The front edge, drawn heavier, shows which way the piece faces. */}
              <line className="item-front" x1={f[3]?.x} y1={f[3]?.y} x2={f[2]?.x} y2={f[2]?.y} />
            </g>
          );
        })}
      </g>
      <g className="openings">
        {geom.openings.map((o) => {
          const f = o.frame;
          const [u0, u1] = o.span;
          const sel = { kind: 'opening', id: o.opening.id } as const;
          return (
            <g key={o.opening.id} data-hit={hit(sel)} pointerEvents={peOpenings}>
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
    if (s.kind === 'wall' && geom.boundaries.includes(s.id)) {
      const f = geom.frames[s.id];
      if (!f) return null;
      const a = framePoint(f, 0, 0);
      const b = framePoint(f, f.length, 0);
      return <line className={`${cls} boundary-mark`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
    }
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
    if (s.kind === 'item') {
      const it = level.items[s.id];
      return it ? <polygon className={cls} points={pts(itemFootprint(it))} /> : null;
    }
    if (s.kind === 'room') {
      const r = level.rooms[s.id];
      return r ? (
        <path
          className={`${cls} room-outline`}
          d={shapePath(roomShape(level, r))}
          fillRule="evenodd"
        />
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
interface RoomLabel {
  id: string;
  name: string;
  area: string | null;
  at: Vec2;
  /** Half the label's size, in metres. */
  half: Vec2;
}

/**
 * Fits each room's name (and area, if there is space) at this zoom, clear of door swings
 * and of the furniture standing in the room.
 */
function roomLabels(level: Level, geom: PlanGeometry, zoom: number): RoomLabel[] {
  const swings = [
    ...geom.openings
      .filter((o) => o.kind === 'door')
      .map((o) => swingZone(doorSwing(o.frame, o.opening))),
    ...Object.values(level.items)
      // What stands in the room, and the lights drawn over it.
      .filter((it) => it.flags.collidable || furnitureKind(it.assetId)?.ceiling)
      .map((it) => {
        const { w, d } = itemSize(it);
        return { c: { x: it.position.x, y: it.position.z }, r: Math.hypot(w, d) / 2 };
      }),
  ];
  const out: RoomLabel[] = [];
  const shapes = roomShapes(level);
  for (const r of Object.values(level.rooms)) {
    const shape = shapes.get(r.id);
    const poly = shape?.outer ?? [];
    if (!shape || poly.length < 3) continue;
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    const w = (Math.max(...xs) - Math.min(...xs)) * zoom;
    const h = (Math.max(...ys) - Math.min(...ys)) * zoom;
    const area = formatArea(roomArea(level, r));
    // Rough advance widths of the label face at 14px semibold and 13px regular. The
    // name matters more than the area, so the area goes first, then the name shortens.
    // Room inside the walls: centre lines less up to 0.1 m of wall on each side.
    const wallPx = 0.2 * zoom;
    const room = w - 12 - wallPx;
    let name = r.name;
    while (name.length > 3 && name.length * 7.6 > room) name = `${name.slice(0, -2)}…`;
    const nameFits = name.length * 7.6 <= room && h - wallPx >= 22;
    const areaFits = nameFits && area.length * 6.8 <= room && h - wallPx >= 40;
    if (!nameFits) continue;
    const halfPx = {
      x: Math.max(name.length * 7.6, areaFits ? area.length * 6.8 : 0) / 2 + 4,
      y: areaFits ? 20 : 10,
    };
    // Keep 10 cm clear of the walls' centre lines, so a label never sits on a thick wall.
    const half = { x: halfPx.x / zoom + 0.1, y: halfPx.y / zoom + 0.1 };
    const at = placeLabel(poly, half, swings, shape.holes);
    out.push({ id: r.id, name, area: areaFits ? area : null, at, half });
  }
  return out;
}

/** Labels are fitted to zoom in steps of about 9%, so a wheel zoom doesn't re-place them. */
const labelZoom = (zoom: number) => 2 ** (Math.round(Math.log2(zoom) * 8) / 8);

/** Half the room move handle's size on screen (px), with room to spare around it. */
const MOVE_HANDLE_HALF = 16;

/** How far (screen px) the move handle keeps from the room's corners. */
const CORNER_CLEAR = 16;

const handleCache = new WeakMap<Level, Map<string, Vec2 | null>>();

/**
 * Where a selected room's move handle goes (plan metres): inside the room, clear of its
 * label, its holes and the door swings, as a label is placed. Null for a room with no shape.
 */
export function roomHandleAt(
  level: Level,
  geom: PlanGeometry,
  zoom: number,
  roomId: string,
): Vec2 | null {
  const step = labelZoom(zoom);
  const key = `${roomId}:${step}`;
  let cache = handleCache.get(level);
  const hit = cache?.get(key);
  if (hit !== undefined) return hit;
  const room = level.rooms[roomId];
  const shape = room && roomShapes(level).get(roomId);
  let at: Vec2 | null = null;
  if (shape && shape.outer.length >= 3) {
    const label = roomLabels(level, geom, step).find((l) => l.id === roomId);
    const avoid = [
      ...geom.openings
        .filter((o) => o.kind === 'door')
        .map((o) => swingZone(doorSwing(o.frame, o.opening))),
      ...(label ? [{ c: label.at, r: Math.hypot(label.half.x, label.half.y) }] : []),
      // Furniture too, so a press on the handle never lands on a piece instead.
      ...Object.values(level.items).map((it) => {
        const { w, d } = itemSize(it);
        return { c: { x: it.position.x, y: it.position.z }, r: Math.hypot(w, d) / 2 };
      }),
    ];
    // Clear of the room's corners, whose targets are large on a touch screen.
    const corners = shape.outer.map((c) => ({ c, r: CORNER_CLEAR / step }));
    const h = MOVE_HANDLE_HALF / step + 0.1;
    const half = { x: h, y: h };
    // Clear of everything if it can be, else of the corners, else just inside the room; in
    // a room too small for it on screen, none (zoom in, or use the arrow keys).
    for (const clear of [[...avoid, ...corners], corners, []]) {
      const p = placeLabel(shape.outer, half, clear, shape.holes);
      if (labelClearance(p, half, shape.outer, clear, shape.holes) >= 0) {
        at = p;
        break;
      }
    }
  }
  if (!cache) {
    cache = new Map();
    handleCache.set(level, cache);
  }
  cache.set(key, at);
  return at;
}

export const RoomLabels = memo(function RoomLabels({ level, geom, view, size }: ScreenProps) {
  // Placement depends on zoom, not on panning, so a pan reuses it.
  const zoomStep = labelZoom(view.zoom);
  const labels = useMemo(() => roomLabels(level, geom, zoomStep), [level, geom, zoomStep]);
  return (
    <g className="room-labels" pointerEvents="none">
      {labels.map((l) => {
        const c = worldToScreen(view, size, l.at);
        return (
          <g key={l.id} transform={`translate(${c.x} ${c.y})`}>
            <text className="room-name" textAnchor="middle" y={l.area ? -3 : 5}>
              {l.name}
            </text>
            {l.area && (
              <text className="room-area num" textAnchor="middle" y={14}>
                {l.area}
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
