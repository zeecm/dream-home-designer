import {
  ELEC_KINDS,
  type ElecPoint,
  type Vec2,
  addPoint,
  deletePoint,
  placePoint,
  pointRoom,
  trunkingLength,
  trunkingPath,
  updatePoint,
} from '@dhd/core';
import { useState } from 'react';
import { useEditor } from '../editor';
import { glyphRadius } from '../electrical/electrical';
import { ElecGlyph } from '../electrical/glyph';
import { currentLevel } from '../store';
import { formatLength } from '../units';
import { type PlanPointer, type ToolContext, type ToolController, gridSnap } from './tools';
import { worldToScreen } from './view';

/** How near (plan metres, or screen px zoomed out) a tap must be to a wall face or compressor. */
const reach = (ctx: ToolContext) => Math.max(0.3, 14 / ctx.view.zoom);

/**
 * Places electrical points: a wall kind on the wall face nearest the tap (within 0.3 m) at its
 * usual height, clear of doors and windows; a ceiling light or fan in a room; a compressor
 * anywhere (on the ledge). An aircon unit then runs its trunking: each tap a bend, a tap on a
 * compressor the end, or "New compressor here" puts one at the last bend.
 */
export function useElectricalTool(ctx: ToolContext): ToolController {
  const kind = useEditor((s) => s.elecKind);
  const trunking = useEditor((s) => s.trunking);
  const [ghost, setGhost] = useState<Vec2 | null>(null);
  const [missed, setMissed] = useState<{ at: Vec2; why: string } | null>(null);
  const info = ELEC_KINDS[kind];
  const { select, setTrunking } = useEditor.getState();
  const live = () => currentLevel() ?? ctx.level;

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
            {/* At the foot of the plan: the unit was just placed on a wall, often a top one. */}
            <foreignObject
              x={8}
              y={Math.max(8, size.height - 118 - 52)}
              width={Math.max(0, size.width - 16)}
              height={118}
            >
              <div
                className="draw-bar trunking-bar"
                data-testid="trunking-bar"
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
              >
                <span>
                  Run the trunking: tap where it bends, then tap the compressor.{' '}
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
                    New compressor here
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
      if (!g) return null;
      const pos = g.wall
        ? placePoint(level, kind, gridSnap(ghost, 0.01, false), {
            geom: ctx.geom,
            tolerance: reach(ctx),
          })
        : null;
      const at = pos?.at ?? g.at;
      if (!at) return null;
      const c = worldToScreen(view, size, at);
      const w = g.wall && level.walls[g.wall.wallId];
      const a = w && level.vertices[w.a];
      const b = w && level.vertices[w.b];
      let normal: Vec2 | undefined;
      if (a && b && g.wall) {
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
        normal = g.wall.side === 'left' ? n : { x: -n.x, y: -n.y };
      }
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
