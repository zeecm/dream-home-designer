import {
  type LeafPose,
  type Level,
  type PlanGeometry,
  type RoomShape,
  type Vec2,
  doorLeaves,
  doorStyle,
  doorSwing,
  finish,
  framePoint,
  furnitureKind,
  hasGlassAbove,
  isGlass,
  isHalfWall,
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
  guarded,
}: {
  level: Level;
  geom: PlanGeometry;
  /** Walls drawn hatched: structural, or the household shelter's. */
  guarded?: ReadonlySet<string>;
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
    <g className="plan-shapes">
      <defs>
        {/* Concrete, as plans draw it: hatched (in metres, so it scales with the plan). */}
        <pattern
          id="structural-hatch"
          width={0.12}
          height={0.12}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect className="hatch-ground" width={0.12} height={0.12} />
          <line className="hatch-line" x1={0.06} y1={0} x2={0.06} y2={0.12} />
        </pattern>
      </defs>
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
            className={`wall${wallLook(level, p.wallId)}${guarded?.has(p.wallId) ? ' wall-structural' : ''}`}
            points={pts(p.polygon)}
            data-hit={hit({ kind: 'wall', id: p.wallId })}
            pointerEvents={pe}
          />
        ))}
        {/* A glass partition: the pane, a thin line down the middle of each stretch. */}
        {geom.pieces.map((p, i) => {
          const w = level.walls[p.wallId];
          const [l0, l1, r1, r0] = p.polygon;
          if (!w || !isGlass(w) || !l0 || !l1 || !r1 || !r0) return null;
          return (
            <line
              key={`glass:${p.wallId}:${i}`}
              className="glass-pane"
              x1={(l0.x + r0.x) / 2}
              y1={(l0.y + r0.y) / 2}
              x2={(l1.x + r1.x) / 2}
              y2={(l1.y + r1.y) / 2}
              pointerEvents="none"
            />
          );
        })}
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

/**
 * A door's plan symbol, by how it opens: a swing door's leaf and arc (two for a double door);
 * sliding and pocket leaves shut in the opening, with dashed where they slide to; bi-fold and
 * folding panels drawn half folded.
 */
function DoorSymbol({ geom }: { geom: PlanGeometry['openings'][number] }) {
  const style = doorStyle(geom.opening);
  if (style === 'swing') return <SwingSymbol geom={geom} />;
  const f = geom.frame;
  const o = geom.opening;
  const seg = (l: LeafPose, cls: string, key: string) => (
    <line key={key} className={cls} x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y} />
  );
  if (style === 'double') {
    const open = doorLeaves(f, o, 1);
    const shut = doorLeaves(f, o, 0);
    return (
      <>
        {open.map((l, i) => {
          const end = shut[i]?.b ?? l.b;
          const r = Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);
          const cross = (l.b.x - l.a.x) * (end.y - l.a.y) - (l.b.y - l.a.y) * (end.x - l.a.x);
          const arc = `A ${r} ${r} 0 0 ${cross > 0 ? 1 : 0} ${end.x} ${end.y}`;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: a door's fixed leaves
            <g key={i}>
              <path className="door-hit" d={`M ${l.a.x} ${l.a.y} L ${l.b.x} ${l.b.y} ${arc} Z`} />
              {seg(l, 'door-leaf', 'leaf')}
              <path className="door-arc" d={`M ${l.b.x} ${l.b.y} ${arc}`} />
            </g>
          );
        })}
      </>
    );
  }
  if (style === 'sliding' || style === 'pocket') {
    const shut = doorLeaves(f, o, 0);
    // Where a single leaf slides to (into the wall, or along its face), dashed.
    const away = shut.length === 1 ? doorLeaves(f, o, 1) : [];
    // An arrow the way the leaves slide, beside the opening on its swing side.
    const [u0, u1] = geom.span;
    const toA = (o.stack ?? 'a') === 'a';
    const side = (o.swing ?? 'leftIn').endsWith('In') ? 1 : -1;
    const at = (u: number) => {
      const c = framePoint(f, u, side);
      return { x: c.x + f.n.x * side * 0.12, y: c.y + f.n.y * side * 0.12 };
    };
    const mid = (u0 + u1) / 2;
    const reach = Math.min(0.3, (u1 - u0) / 3);
    const from = at(mid + (toA ? reach : -reach));
    const to = at(mid - (toA ? reach : -reach));
    const head = (k: number) => {
      const back = at(mid - (toA ? reach - 0.08 : -reach + 0.08));
      return { x: back.x + f.n.x * k * 0.05, y: back.y + f.n.y * k * 0.05 };
    };
    const h1 = head(1);
    const h2 = head(-1);
    return (
      <>
        <polygon className="door-hit" points={pts(geom.polygon)} />
        {shut.map((l, i) => seg(l, 'door-leaf', `s${i}`))}
        {away.map((l, i) => seg(l, 'door-slide', `a${i}`))}
        <path
          className="door-arrow"
          d={`M ${from.x} ${from.y} L ${to.x} ${to.y} M ${h1.x} ${h1.y} L ${to.x} ${to.y} L ${h2.x} ${h2.y}`}
        />
      </>
    );
  }
  // Bi-fold and folding: the panels half folded, a zigzag out to the swing side, and the
  // sweep of the first panel from the stack side, so it reads as folding, not a double door.
  const half = doorLeaves(f, o, 0.5);
  const zig = [half[0]?.a, ...half.map((l) => l.b)].filter((p): p is Vec2 => !!p);
  const [u0, u1] = geom.span;
  const first0 = doorLeaves(f, o, 0)[0];
  const first1 = doorLeaves(f, o, 1)[0];
  let sweep: string | null = null;
  if (first0 && first1) {
    const r = Math.hypot(first0.b.x - first0.a.x, first0.b.y - first0.a.y);
    const c = first0.a;
    const cross = (first0.b.x - c.x) * (first1.b.y - c.y) - (first0.b.y - c.y) * (first1.b.x - c.x);
    sweep = `M ${first0.b.x} ${first0.b.y} A ${r} ${r} 0 0 ${cross > 0 ? 1 : 0} ${first1.b.x} ${first1.b.y}`;
  }
  return (
    <>
      <polygon
        className="door-hit"
        points={pts([...zig, framePoint(f, u1, 0), framePoint(f, u0, 0)])}
      />
      <polygon className="door-hit" points={pts(geom.polygon)} />
      {sweep && <path className="door-arc" d={sweep} />}
      {half.map((l, i) => seg(l, 'door-leaf', `f${i}`))}
    </>
  );
}

function SwingSymbol({ geom }: { geom: PlanGeometry['openings'][number] }) {
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

/** How a wall draws in plan: a glass partition, a half wall, or a wall. */
function wallLook(level: Level, id: string): string {
  const w = level.walls[id];
  if (!w) return '';
  if (isGlass(w)) return ' wall-glass';
  return isHalfWall(w, level.ceilingHeight) ? ' wall-half' : '';
}

/** Half walls' heights ("HW 1.00 m"), beside the wall in screen pixels. */
export const WallTags = memo(function WallTags({ level, geom, view, size }: ScreenProps) {
  return (
    <g className="wall-tags" pointerEvents="none">
      {Object.values(level.walls).map((w) => {
        const f = geom.frames[w.id];
        if (!f || !isHalfWall(w, level.ceilingHeight) || f.length * view.zoom < 48) return null;
        // Beside the wall (its left face), clear of the wall and its doors' arcs.
        const c = worldToScreen(view, size, framePoint(f, f.length / 2, 1));
        const n = { x: f.n.x, y: f.n.y };
        const text = `HW ${formatLength(w.height ?? 0)}${hasGlassAbove(w, level.ceilingHeight) ? ' + glass' : ''}`;
        return (
          <text
            key={w.id}
            className="wall-tag num"
            x={c.x + n.x * 10}
            y={c.y + n.y * 10 + 3}
            textAnchor={Math.abs(n.x) > 0.7 ? (n.x > 0 ? 'start' : 'end') : 'middle'}
          >
            {text}
          </text>
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
