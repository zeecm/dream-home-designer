import {
  ELEC_KINDS,
  type ElecPoint,
  type Level,
  type Vec2,
  addPoint,
  deletePoint,
  onLedge,
  placePoint,
  pointPosition,
  pointRoom,
  roomShapes,
  trunkingLength,
  trunkingPath,
  updatePoint,
} from '@dhd/core';
import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../editor';
import { glyphRadius } from '../electrical/electrical';
import { ElecGlyph } from '../electrical/glyph';
import { currentLevel } from '../store';
import { formatLength } from '../units';
import { type PlanPointer, type ToolContext, type ToolController, gridSnap } from './tools';
import { type Size, type View, fitBounds, worldToScreen } from './view';

/** The trunking bar's height over the top of the plan (it never covers the plan's middle). */
const BAR_H = 96;

/** Where a run is likely to end: the nearest compressor, else the nearest aircon ledge. */
function runTarget(level: Level, from: Vec2): Vec2 | null {
  const dist = (p: Vec2) => Math.hypot(p.x - from.x, p.y - from.y);
  const spots: Vec2[] = Object.values(level.points)
    .filter((q) => q.kind === 'compressor' && q.at)
    .map((q) => q.at as Vec2);
  if (!spots.length) {
    for (const [id, shape] of roomShapes(level)) {
      const xs = shape.outer.map((p) => p.x);
      const ys = shape.outer.map((p) => p.y);
      const c = {
        x: (Math.min(...xs) + Math.max(...xs)) / 2,
        y: (Math.min(...ys) + Math.max(...ys)) / 2,
      };
      if (level.rooms[id] && onLedge(level, c)) spots.push(c);
    }
  }
  return spots.sort((p, q) => dist(p) - dist(q))[0] ?? null;
}

/**
 * The view for running trunking from `from`: as it is if the unit and where the run will
 * likely end are both in sight below the bar, else panned (and zoomed out if need be) to them.
 */
export function runView(level: Level, view: View, size: Size, from: Vec2): View {
  const to = runTarget(level, from) ?? from;
  const pad = 0.6;
  const min = { x: Math.min(from.x, to.x) - pad, y: Math.min(from.y, to.y) - pad };
  const max = { x: Math.max(from.x, to.x) + pad, y: Math.max(from.y, to.y) + pad };
  const area = { width: size.width, height: Math.max(1, size.height - BAR_H) };
  const seen = (p: Vec2) => {
    const s = worldToScreen(view, size, p);
    return s.x >= 16 && s.x <= size.width - 16 && s.y >= BAR_H + 8 && s.y <= size.height - 16;
  };
  if (seen(min) && seen(max)) return view;
  const fit = fitBounds({ min, max }, area, 24);
  const zoom = Math.min(fit.zoom, view.zoom);
  // Centred in the plan below the bar.
  return { zoom, cx: fit.cx, cy: fit.cy - BAR_H / 2 / zoom };
}

/** How near (plan metres, or screen px zoomed out) a tap must be to a wall face or compressor. */
const reach = (ctx: ToolContext) => Math.max(0.3, 14 / ctx.view.zoom);

/**
 * Places electrical points: a wall kind on the wall face nearest the tap (within 0.3 m) at its
 * usual height, clear of doors and windows; a ceiling light or fan in a room; a compressor
 * anywhere (on the ledge). An aircon unit then runs its trunking: each tap a bend, a tap on a
 * compressor or on the aircon ledge the end, or "Compressor here" puts one at the last bend.
 */
export function useElectricalTool(ctx: ToolContext): ToolController {
  const kind = useEditor((s) => s.elecKind);
  const trunking = useEditor((s) => s.trunking);
  const [ghost, setGhost] = useState<Vec2 | null>(null);
  const [missed, setMissed] = useState<{ at: Vec2; why: string } | null>(null);
  const info = ELEC_KINDS[kind];
  const { select, setTrunking } = useEditor.getState();
  const live = () => currentLevel() ?? ctx.level;

  // A run starting: the unit and where the run will likely end are brought into sight.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const runId = trunking?.id;
  useEffect(() => {
    if (!runId) return;
    const c = ctxRef.current;
    const level = currentLevel() ?? c.level;
    const ac = level.points[runId];
    const at = ac && pointPosition(level, ac)?.at;
    if (!at || c.size.width <= 0) return;
    const next = runView(level, c.view, c.size, at);
    if (next !== c.view) useEditor.getState().setView(next, true);
  }, [runId]);

  /** Where a point of the kind picked would go for this spot. */
  const spot = (world: Vec2, alt: boolean): ElecPoint | null => {
    if (info.place === 'wall') {
      const w = placePoint(ctx.level, kind, gridSnap(world, 0.01, alt), {
        geom: ctx.geom,
        tolerance: reach(ctx),
      });
      if (!w) return null;
      const { at: _, ...wall } = w;
      return { id: 'ghost', kind, wall, ...(kind === 'switch' ? { gang: 1 } : {}) };
    }
    return { id: 'ghost', kind, at: gridSnap(world, 0.05, alt) };
  };

  /** A compressor within reach of the tap, for the trunking to end on. */
  const compressorAt = (p: PlanPointer) => {
    if (p.hit?.kind === 'point' && ctx.level.points[p.hit.id]?.kind === 'compressor')
      return p.hit.id;
    let best: { id: string; d: number } | null = null;
    for (const q of Object.values(ctx.level.points)) {
      if (q.kind !== 'compressor' || !q.at) continue;
      const d = Math.hypot(q.at.x - p.world.x, q.at.y - p.world.y);
      if (d <= reach(ctx) && (!best || d < best.d)) best = { id: q.id, d };
    }
    return best?.id ?? null;
  };

  const runningUnit = () => {
    const t = useEditor.getState().trunking;
    const ac = t ? live().points[t.id] : undefined;
    return t && ac?.kind === 'aircon' ? { t, ac } : null;
  };

  /** The run's last bend becomes a new compressor, and the run ends on it. */
  const compressorHere = () => {
    const r = runningUnit();
    const last = r?.ac.route?.at(-1);
    if (!r || !last) return;
    const c = addPoint(ctx.level.id, { kind: 'compressor', at: last });
    ctx.dispatch(c.command, { coalesceKey: r.t.key });
    ctx.dispatch(
      updatePoint(ctx.level.id, r.ac.id, {
        route: (r.ac.route ?? []).slice(0, -1),
        compressorId: c.pointId,
      }),
      { coalesceKey: r.t.key },
    );
    setTrunking(null);
    select({ kind: 'point', id: r.ac.id });
  };
  const undoBend = () => {
    const r = runningUnit();
    if (!r?.ac.route?.length) return;
    ctx.dispatch(updatePoint(ctx.level.id, r.ac.id, { route: r.ac.route.slice(0, -1) }), {
      coalesceKey: r.t.key,
    });
  };

  return {
    cursor: 'copy',
    down: (p) => {
      setMissed(null);
      const run = runningUnit();
      if (run) {
        const comp = compressorAt(p);
        if (comp) {
          ctx.dispatch(updatePoint(ctx.level.id, run.ac.id, { compressorId: comp }), {
            coalesceKey: run.t.key,
          });
          setTrunking(null);
          select({ kind: 'point', id: run.ac.id });
          return true;
        }
        const at = gridSnap(p.world, 0.05, p.alt);
        // A tap on the aircon ledge ends the run there, on a new compressor.
        if (onLedge(ctx.level, at)) {
          const c = addPoint(ctx.level.id, { kind: 'compressor', at });
          ctx.dispatch(c.command, { coalesceKey: run.t.key });
          ctx.dispatch(updatePoint(ctx.level.id, run.ac.id, { compressorId: c.pointId }), {
            coalesceKey: run.t.key,
          });
          setTrunking(null);
          select({ kind: 'point', id: run.ac.id });
          return true;
        }
        ctx.dispatch(
          updatePoint(ctx.level.id, run.ac.id, { route: [...(run.ac.route ?? []), at] }),
          { coalesceKey: run.t.key },
        );
        return true;
      }
      if (trunking) setTrunking(null); // its unit went (undone, deleted)
      const s = spot(p.world, p.alt);
      if (!s) {
        setMissed({ at: p.screen, why: `Tap nearer a wall to add a ${info.short.toLowerCase()}` });
        return true;
      }
      if (info.place === 'ceiling' && !pointRoom(ctx.level, s)) {
        setMissed({ at: p.screen, why: `Tap inside a room to add a ${info.short.toLowerCase()}` });
        return true;
      }
      const { id: _, ...point } = s;
      const r = addPoint(ctx.level.id, point);
      ctx.dispatch(r.command);
      select({ kind: 'point', id: r.pointId });
      setGhost(null);
      if (kind === 'aircon')
        setTrunking({ id: r.pointId, key: `trunk:${r.pointId}:${Date.now()}` });
      return true;
    },
    move: (p, dragging) => {
      if (dragging) {
        setGhost(null);
        return;
      }
      setGhost(p.world);
      setMissed((m) => (m && Math.hypot(p.screen.x - m.at.x, p.screen.y - m.at.y) < 40 ? m : null));
    },
    up: () => {},
    key: (e) => {
      const run = runningUnit();
      if (run && e.key === 'Backspace') {
        undoBend();
        return true;
      }
      if (e.key === 'Escape') {
        if (run) {
          setTrunking(null);
          return true;
        }
        select(null);
        useEditor.getState().setTool('select');
        return true;
      }
      const sel = useEditor.getState().selection;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel?.kind === 'point') {
        ctx.dispatch(deletePoint(ctx.level.id, sel.id, ctx.level));
        select(null);
        return true;
      }
      return false;
    },
    overlay: ({ view, size, level }) => {
      const run = trunking ? level.points[trunking.id] : undefined;
      if (trunking && run?.kind === 'aircon') {
        const path = trunkingPath(level, run);
        const last = path.at(-1);
        const to = ghost && gridSnap(ghost, 0.05, false);
        const s = (q: Vec2) => worldToScreen(view, size, q);
        const sofar =
          trunkingLength(path) + (last && to ? Math.hypot(to.x - last.x, to.y - last.y) : 0);
        return (
          <>
            {last && to && (
              <line
                className="elec-trunk-preview"
                x1={s(last).x}
                y1={s(last).y}
                x2={s(to).x}
                y2={s(to).y}
                pointerEvents="none"
              />
            )}
            {/* Over the top of the plan, as the wall tool's bar is; the view is moved below it. */}
            <foreignObject x={8} y={8} width={Math.max(0, size.width - 16)} height={BAR_H - 12}>
              <div
                className="draw-bar trunking-bar"
                data-testid="trunking-bar"
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
              >
                <span className="trunking-bar-text">
                  Tap each bend, then the compressor or the ledge.{' '}
                  <span className="num">{formatLength(sofar, 1)}</span>
                </span>
                <span className="draw-bar-row">
                  <button
                    type="button"
                    className="btn"
                    disabled={!run.route?.length}
                    onClick={undoBend}
                  >
                    Undo bend
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!run.route?.length}
                    onClick={compressorHere}
                    title="Put a compressor at the last bend"
                  >
                    Compressor here
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      setTrunking(null);
                      select({ kind: 'point', id: run.id });
                    }}
                  >
                    Done
                  </button>
                </span>
              </div>
            </foreignObject>
          </>
        );
      }
      if (missed) {
        const why = missed.why;
        return (
          <g
            pointerEvents="none"
            transform={`translate(${Math.max(8, Math.min(missed.at.x + 14, size.width - why.length * 7.5 - 24))} ${missed.at.y + 22})`}
          >
            <rect
              x={0}
              y={-14}
              width={why.length * 7 + 16}
              height={22}
              rx={4}
              className="typed error"
            />
            <text x={8} y={2}>
              {why}
            </text>
          </g>
        );
      }
      const g = ghost && spot(ghost, false);
      const pos = g && pointPosition(level, g);
      if (!pos) return null;
      const c = worldToScreen(view, size, pos.at);
      const normal = pos.normal;
      const r = glyphRadius(view.zoom) * view.zoom;
      return (
        <g className="elec-ghost" pointerEvents="none" transform={`translate(${c.x} ${c.y})`}>
          <ElecGlyph
            kind={kind}
            gang={1}
            r={r}
            normal={normal}
            stroke="var(--accent)"
            fill="var(--surface)"
            sw={1.4}
          />
        </g>
      );
    },
  };
}
