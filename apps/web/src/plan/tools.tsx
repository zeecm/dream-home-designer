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
  settleVertex,
  snapCorner,
  splitWall,
  updateOpening,
} from '@dhd/core';
import { type ReactNode, useRef, useState } from 'react';
import { type Selection, type Tool, useEditor } from '../editor';
import { useStore } from '../store';
import { formatLength } from '../units';
import { cycle, movedVertices, nudge, objectPoint, planObjects } from './keyboard';
import { type Size, type View, panBy, reveal, worldToScreen } from './view';

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
    'Click to select; Tab and the arrow keys work too. Double-click a wall to add a corner, or a room to rename it.',
  wall: 'Click to place corners; type a length for an exact wall. Joining an existing corner or wall, Enter or a double-click finishes.',
  room: 'Click two opposite corners to draw a rectangular room. Esc cancels.',
  door: 'Pick a width, then click a wall to add a door.',
  window: 'Pick a width, then click a wall to add a window.',
  passage: 'Pick a width, then click a wall to add an opening.',
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

const ARROWS: Record<string, Vec2> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

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
        const r = splitWall(levelId, h.id, p.world, ctx.level);
        ctx.dispatch(r.command);
        select({ kind: 'vertex', id: r.vertexId });
        return true;
      }
      select(h);
      if (h.kind === 'room' && p.clicks === 2) {
        useEditor.getState().requestRename();
        return true;
      }
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
        const to = p.alt
          ? p.world
          : snapCorner(ctx.level, d.id, p.world, { tolerance: snapTolerance(ctx), grid: 0.05 });
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
      const d = drag.current;
      drag.current = null;
      if (d?.kind === 'vertex' && d.moved) {
        // Merge, split and re-detect rooms once, at the end of the drag, in the same undo step.
        const level = useStore.getState().editor.doc.levels[0];
        if (level) ctx.dispatch(settleVertex(level, d.id), { coalesceKey: d.key });
      }
    },
    key: (e) => {
      const sel = useEditor.getState().selection;
      const onCanvas = e.target instanceof SVGSVGElement;
      // Tab walks through the plan's objects while the canvas has focus; past the last one it
      // lets focus move on, so the canvas never traps the keyboard.
      if (e.key === 'Tab' && onCanvas && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const next = cycle(planObjects(ctx.level), sel, e.shiftKey);
        select(next);
        if (!next) return false;
        const at = objectPoint(ctx.level, next);
        if (at) useEditor.getState().setView(reveal(ctx.view, ctx.size, at), true);
        return true;
      }
      if ((e.key === 'Enter' || e.key === 'F2') && onCanvas && sel?.kind === 'room') {
        useEditor.getState().requestRename();
        return true;
      }
      const arrow = ARROWS[e.key];
      if (arrow && (onCanvas || e.target === document.body) && !e.ctrlKey && !e.metaKey) {
        // Read the live document: key repeat can outrun React's re-render.
        const live = () => useStore.getState().editor.doc.levels[0] ?? ctx.level;
        // 1 cm per press, 10 cm with Shift; a run of nudges is one undo step.
        const step = e.shiftKey ? 0.1 : 0.01;
        const cmds = sel ? nudge(live(), sel, { x: arrow.x * step, y: arrow.y * step }) : [];
        if (sel && cmds.length > 0) {
          const key = `nudge:${sel.id}`;
          const moved = movedVertices(live(), sel);
          for (const cmd of cmds) ctx.dispatch(cmd, { coalesceKey: key });
          for (const id of moved) {
            const level = live();
            if (level.vertices[id]) ctx.dispatch(settleVertex(level, id), { coalesceKey: key });
          }
        } else {
          const px = e.shiftKey ? 200 : 40;
          useEditor.getState().setView(panBy(ctx.view, -arrow.x * px, -arrow.y * px), true);
        }
        return true;
      }
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
