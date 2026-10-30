import {
  type Command,
  type DispatchOptions,
  type Level,
  type PlanGeometry,
  type Vec2,
  deleteOpening,
  deleteVertex,
  deleteWall,
  moveVertex,
  snapPoint,
  splitWall,
  updateOpening,
} from '@dhd/core';
import { type ReactNode, useRef, useState } from 'react';
import { type Selection, type Tool, useEditor } from '../editor';
import { formatLength } from '../units';
import { type Size, type View, worldToScreen } from './view';

export interface PlanPointer {
  world: Vec2;
  screen: Vec2;
  hit: Selection | null;
  shift: boolean;
  alt: boolean;
  /** 2 on the second click of a double-click. */
  clicks: number;
}

export interface ToolContext {
  level: Level;
  geom: PlanGeometry;
  view: View;
  size: Size;
  dispatch: (cmd: Command, opts?: DispatchOptions) => void;
}

/** What the canvas asks of the active tool. */
export interface ToolController {
  /** Return true to claim the gesture; otherwise a drag on the canvas pans. */
  down: (p: PlanPointer) => boolean;
  move: (p: PlanPointer, dragging: boolean) => void;
  up: (p: PlanPointer) => void;
  key: (e: KeyboardEvent) => boolean;
  overlay: (ctx: ToolContext) => ReactNode;
  cursor: string;
}

export const TOOL_HINTS: Record<Tool, string> = {
  select:
    'Click to select. Drag a corner or a door to move it. Double-click a wall to add a corner.',
  wall: 'Click to place corners; type a length for an exact wall. Enter or double-click finishes.',
  room: 'Click two opposite corners to draw a rectangular room. Esc cancels.',
  door: 'Click a wall to add a door.',
  window: 'Click a wall to add a window.',
  passage: 'Click a wall to add an opening.',
  measure: 'Click two points to measure. Esc clears.',
  calibrate: 'Click two points on the plan image, then type the real distance.',
};

/** Rounds to a grid step unless Alt is held. */
export const gridSnap = (p: Vec2, step: number, off: boolean): Vec2 =>
  off ? p : { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };

/** Capture distance: 0.15 m, or 10 screen pixels when zoomed out further than that. */
export const snapTolerance = (ctx: ToolContext) => Math.max(0.15, 10 / ctx.view.zoom);

/** The nearest corner within `px` screen pixels, if any. */
export function nearestVertex(
  ctx: ToolContext,
  p: Vec2,
  px: number,
  exclude?: string,
): { id: string; at: Vec2 } | null {
  let best: { id: string; at: Vec2 } | null = null;
  let bestD = px / ctx.view.zoom;
  for (const v of Object.values(ctx.level.vertices)) {
    if (v.id === exclude) continue;
    const d = Math.hypot(v.x - p.x, v.y - p.y);
    if (d <= bestD) {
      bestD = d;
      best = { id: v.id, at: { x: v.x, y: v.y } };
    }
  }
  return best;
}

/**
 * Where a dragged corner should land: an existing corner or wall if one is close,
 * otherwise square to its neighbouring walls (where two right-angle guides cross, both
 * walls stay square), otherwise the 5 cm grid.
 */
function snapCorner(ctx: ToolContext, id: string, own: Set<string>, p: Vec2): Vec2 {
  const base = {
    tolerance: snapTolerance(ctx),
    grid: 0.05,
    excludeVertices: new Set([id]),
    excludeWalls: own,
  };
  const plain = snapPoint(ctx.level, p, base);
  if (plain.kind === 'vertex' || plain.kind === 'wall') return plain.point;
  const guides: { from: Vec2; angle: number }[] = [];
  for (const w of Object.values(ctx.level.walls)) {
    if (w.a !== id && w.b !== id) continue;
    const other = ctx.level.vertices[w.a === id ? w.b : w.a];
    if (!other) continue;
    const s = snapPoint(ctx.level, p, { ...base, from: other, grid: 0 });
    if (s.kind === 'angle' && s.angle !== undefined) guides.push({ from: other, angle: s.angle });
  }
  const [g1, g2] = guides;
  if (g1 && g2 && Math.abs(Math.sin(g1.angle - g2.angle)) > 0.1) {
    const d1 = { x: Math.cos(g1.angle), y: Math.sin(g1.angle) };
    const d2 = { x: Math.cos(g2.angle), y: Math.sin(g2.angle) };
    const den = d1.x * d2.y - d1.y * d2.x;
    const t = ((g2.from.x - g1.from.x) * d2.y - (g2.from.y - g1.from.y) * d2.x) / den;
    const x = { x: g1.from.x + d1.x * t, y: g1.from.y + d1.y * t };
    if (Math.hypot(x.x - p.x, x.y - p.y) <= base.tolerance * 2) return x;
  }
  if (g1) {
    const d = { x: Math.cos(g1.angle), y: Math.sin(g1.angle) };
    const t = (p.x - g1.from.x) * d.x + (p.y - g1.from.y) * d.y;
    const step = 0.05;
    const tt = Math.round(t / step) * step;
    return { x: g1.from.x + d.x * tt, y: g1.from.y + d.y * tt };
  }
  return plain.point;
}

type Drag =
  | { kind: 'vertex'; id: string; start: Vec2; moved: boolean; key: string }
  | { kind: 'opening'; id: string; wallId: string; start: Vec2; moved: boolean; key: string };

export function useSelectTool(ctx: ToolContext): ToolController {
  const drag = useRef<Drag | null>(null);
  const { select, setHover } = useEditor.getState();
  const levelId = ctx.level.id;

  return {
    cursor: 'default',
    down: (p) => {
      const h = p.hit;
      if (!h) {
        select(null);
        return false;
      }
      if (h.kind === 'wall' && p.clicks === 2) {
        const r = splitWall(levelId, h.id, p.world);
        ctx.dispatch(r.command);
        select({ kind: 'vertex', id: r.vertexId });
        return true;
      }
      select(h);
      // Rooms and walls select on press, but dragging from them pans (rooms cover the plan).
      if (h.kind === 'room' || h.kind === 'wall') return false;
      const key = `drag:${h.id}:${Date.now()}`;
      if (h.kind === 'vertex') {
        drag.current = { kind: 'vertex', id: h.id, start: p.screen, moved: false, key };
      } else if (h.kind === 'opening') {
        const o = ctx.level.openings[h.id];
        if (o)
          drag.current = {
            kind: 'opening',
            id: h.id,
            wallId: o.wallId,
            start: p.screen,
            moved: false,
            key,
          };
      }
      return true;
    },
    move: (p, dragging) => {
      const d = drag.current;
      if (!dragging || !d) {
        setHover(p.hit);
        return;
      }
      if (!d.moved && Math.hypot(p.screen.x - d.start.x, p.screen.y - d.start.y) < 3) return;
      d.moved = true;
      if (d.kind === 'vertex') {
        const own = new Set(
          Object.values(ctx.level.walls)
            .filter((w) => w.a === d.id || w.b === d.id)
            .map((w) => w.id),
        );
        const to = p.alt ? p.world : snapCorner(ctx, d.id, own, p.world);
        ctx.dispatch(moveVertex(levelId, d.id, to), { coalesceKey: d.key });
      } else {
        const f = ctx.geom.frames[d.wallId];
        if (!f) return;
        const u = (p.world.x - f.a.x) * f.d.x + (p.world.y - f.a.y) * f.d.y;
        const step = p.alt ? 0.001 : 0.05;
        const t = (Math.round(u / step) * step) / f.length;
        ctx.dispatch(updateOpening(levelId, d.id, { t }), { coalesceKey: d.key });
      }
    },
    up: () => {
      drag.current = null;
    },
    key: (e) => {
      const sel = useEditor.getState().selection;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        const cmd =
          sel.kind === 'wall'
            ? deleteWall(levelId, sel.id)
            : sel.kind === 'opening'
              ? deleteOpening(levelId, sel.id)
              : sel.kind === 'vertex'
                ? deleteVertex(levelId, sel.id)
                : null;
        if (!cmd) return false;
        ctx.dispatch(cmd);
        select(null);
        return true;
      }
      return false;
    },
    overlay: () => null,
  };
}

export function useMeasureTool(ctx: ToolContext): ToolController {
  const [points, setPoints] = useState<Vec2[]>([]);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const snap = (p: PlanPointer) =>
    (p.alt ? null : nearestVertex(ctx, p.world, 10)?.at) ?? gridSnap(p.world, 0.01, p.alt);

  return {
    cursor: 'crosshair',
    down: (p) => {
      const at = snap(p);
      setPoints((prev) => (prev.length >= 2 ? [at] : [...prev, at]));
      return true;
    },
    move: (p) => setCursor(snap(p)),
    up: () => {},
    key: (e) => {
      if (e.key === 'Escape' && points.length > 0) {
        setPoints([]);
        return true;
      }
      return false;
    },
    overlay: ({ view, size }) => {
      const a = points[0];
      const b = points[1] ?? cursor;
      if (!a || !b) return null;
      const s0 = worldToScreen(view, size, a);
      const s1 = worldToScreen(view, size, b);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const mid = { x: (s0.x + s1.x) / 2, y: (s0.y + s1.y) / 2 };
      return (
        <g className="measure" pointerEvents="none">
          <line x1={s0.x} y1={s0.y} x2={s1.x} y2={s1.y} />
          <circle cx={s0.x} cy={s0.y} r={3.5} />
          <circle cx={s1.x} cy={s1.y} r={3.5} />
          <g transform={`translate(${mid.x} ${mid.y - 16})`}>
            <rect x={-34} y={-11} width={68} height={22} rx={4} />
            <text textAnchor="middle" y={4} className="num">
              {formatLength(len)}
            </text>
          </g>
        </g>
      );
    },
  };
}
