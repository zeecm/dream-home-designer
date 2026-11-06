import {
  ELEC_KINDS,
  type ElecPoint,
  type Level,
  type Vec2,
  addPoint,
  axesOf,
  deletePoint,
  legInto,
  nextBend,
  onLedge,
  placePoint,
  pointInPolygon,
  pointPosition,
  pointRoom,
  roomShapes,
  routeAlongWalls,
  simplifyPath,
  trunkingLength,
  trunkingPath,
  unitAxes,
  updatePoint,
} from '@dhd/core';
import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../editor';
import { clearRouteNotice, glyphRadius } from '../electrical/electrical';
import { ElecGlyph } from '../electrical/glyph';
import { currentLevel, useStore } from '../store';
import { icons } from '../ui/icons';
import { formatLength } from '../units';
import { type PlanPointer, type ToolContext, type ToolController, gridSnap } from './tools';
import { type Size, type View, fitBounds, worldToScreen } from './view';

/** The trunking bar's height over the top of the plan (it never covers the plan's middle). */
const BAR_H = 96;

/**
 * Where a run is likely to end: the nearest compressor, else (unless `compressors`) the
 * nearest aircon ledge.
 */
function runTarget(level: Level, from: Vec2, compressors = false): Vec2 | null {
  const dist = (p: Vec2) => Math.hypot(p.x - from.x, p.y - from.y);
  const spots: Vec2[] = Object.values(level.points)
    .filter((q) => q.kind === 'compressor' && q.at)
    .map((q) => q.at as Vec2);
  if (!spots.length && !compressors) {
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
  // On a phone, the unit's room and the ledge fill the plan below the bar, zoomed in if need
  // be, so a fingertip covers centimetres, not metres.
  const phone = size.width < 600;
  if (phone) {
    for (const [, shape] of roomShapes(level)) {
      if (!shape.outer.length) continue;
      if (!pointInPolygon(from, shape.outer) && !pointInPolygon(to, shape.outer)) continue;
      for (const p of shape.outer) {
        min.x = Math.min(min.x, p.x - 0.3);
        min.y = Math.min(min.y, p.y - 0.3);
        max.x = Math.max(max.x, p.x + 0.3);
        max.y = Math.max(max.y, p.y + 0.3);
      }
    }
  }
  const seen = (p: Vec2) => {
    const s = worldToScreen(view, size, p);
    return s.x >= 16 && s.x <= size.width - 16 && s.y >= BAR_H + 8 && s.y <= size.height - 16;
  };
  const fit = fitBounds({ min, max }, area, phone ? 12 : 24);
  if (!phone && seen(min) && seen(max)) return view;
  const zoom = phone ? fit.zoom : Math.min(fit.zoom, view.zoom);
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
  /** Where the pointer is while a run is going: the next bend's preview. */
  const [aim, setAim] = useState<PlanPointer | null>(null);
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
  // A pinch or a pan that left the run's last bend under the bar: brought back below it once
  // the plan settles.
  const view = ctx.view;
  // biome-ignore lint/correctness/useExhaustiveDependencies: on each view change, once settled
  useEffect(() => {
    if (!runId) return;
    const timer = window.setTimeout(() => {
      const c = ctxRef.current;
      const level = currentLevel() ?? c.level;
      const ac = level.points[runId];
      const last = ac && trunkingPath(level, ac).at(-1);
      if (!last) return;
      const s = worldToScreen(c.view, c.size, last);
      const under = s.y >= 0 && s.y < BAR_H + 8 && s.x >= 0 && s.x <= c.size.width;
      if (!under) return;
      const by = BAR_H + 48 - s.y;
      useEditor.getState().setView({ ...c.view, cy: c.view.cy - by / c.view.zoom }, true);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [runId, view]);

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

  /** The run routed along the walls to the ledge: its own undo step, and the run ends. */
  const alongWalls = () => {
    const r = runningUnit();
    if (!r) return;
    const routed = routeAlongWalls(live(), r.ac.id, ctx.geom);
    if ('error' in routed) {
      useStore.setState({ notice: routed.error });
      return;
    }
    ctx.dispatch(routed.command);
    clearRouteNotice();
    setTrunking(null);
    select({ kind: 'point', id: r.ac.id });
  };

  /**
   * What a tap here does to the run: the legs it adds from the last bend (square, as
   * nextBend has them, and into a compressor or the ledge along the walls, as legInto has
   * them), and where it ends the run, if it does: on a compressor tapped, or on a new one on
   * the aircon ledge.
   */
  const step = (level: Level, ac: ElecPoint, p: PlanPointer) => {
    const path = trunkingPath(level, ac);
    const last = path.at(-1);
    if (!last) return null;
    const prev = path.at(-2);
    const axes = unitAxes(level, ac);
    const comp = compressorAt(p);
    const compAt = comp ? level.points[comp]?.at : undefined;
    const spotOn = gridSnap(p.world, 0.05, p.alt);
    const ledge = !comp && onLedge(level, spotOn) ? spotOn : undefined;
    const end = compAt ?? ledge;
    if (end) {
      const corner = p.alt
        ? []
        : legInto(level, last, end, {
            geom: ctx.geom,
            prev,
            axes,
            alongWalls: true,
            except: ac.id,
          });
      return { legs: [last, ...corner, end], comp, ledge };
    }
    const bend = nextBend(level, last, p.world, {
      alt: p.alt,
      geom: ctx.geom,
      target: runTarget(level, last, true),
      axes: [
        axes,
        prev && Math.hypot(last.x - prev.x, last.y - prev.y) > 1e-9
          ? axesOf({ x: last.x - prev.x, y: last.y - prev.y })
          : null,
      ],
    });
    return bend ? { legs: [last, bend.at] } : null;
  };

  return {
    cursor: 'copy',
    down: (p) => {
      setMissed(null);
      const run = runningUnit();
      if (run) {
        const s = step(ctx.level, run.ac, p);
        // The preview is of where the finger was: it goes with the tap (and the ghost of a
        // new point with it, so none is left behind once the run ends).
        setAim(null);
        setGhost(null);
        if (!s) return true;
        const ends = !!(s.comp || s.ledge);
        // Bends that go straight on are merged as the run is made.
        const path = simplifyPath([...trunkingPath(ctx.level, run.ac), ...s.legs.slice(1)]);
        const route = path.slice(1, ends ? -1 : undefined);
        if (s.comp) {
          ctx.dispatch(updatePoint(ctx.level.id, run.ac.id, { route, compressorId: s.comp }), {
            coalesceKey: run.t.key,
          });
          setTrunking(null);
          select({ kind: 'point', id: run.ac.id });
          return true;
        }
        // A tap on the aircon ledge ends the run there, on a new compressor.
        if (s.ledge) {
          const c = addPoint(ctx.level.id, { kind: 'compressor', at: s.ledge });
          ctx.dispatch(c.command, { coalesceKey: run.t.key });
          ctx.dispatch(updatePoint(ctx.level.id, run.ac.id, { route, compressorId: c.pointId }), {
            coalesceKey: run.t.key,
          });
          setTrunking(null);
          select({ kind: 'point', id: run.ac.id });
          return true;
        }
        ctx.dispatch(updatePoint(ctx.level.id, run.ac.id, { route }), {
          coalesceKey: run.t.key,
        });
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
        setAim(null);
        return;
      }
      setGhost(p.world);
      setAim(useEditor.getState().trunking ? p : null);
      setMissed((m) => (m && Math.hypot(p.screen.x - m.at.x, p.screen.y - m.at.y) < 40 ? m : null));
    },
    up: () => {},
    touchCancel: () => setAim(null),
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
        const s = (q: Vec2) => worldToScreen(view, size, q);
        // The next leg (and the corner into a compressor or the ledge) where a tap would put it.
        const legs = (aim && step(level, run, aim)?.legs) ?? [];
        const next = trunkingLength(legs);
        const sofar = trunkingLength(path);
        const end = legs.at(-1);
        const tag = end && s(end);
        const label = formatLength(next);
        return (
          <>
            {next > 1e-3 && tag && (
              <g pointerEvents="none" data-testid="trunk-preview">
                <polyline
                  className="elec-trunk-preview"
                  points={legs.map((q) => `${s(q).x},${s(q).y}`).join(' ')}
                />
                <circle className="pending-corner" cx={tag.x} cy={tag.y} r={4} />
                <g
                  className="handle-length"
                  transform={`translate(${Math.min(Math.max(tag.x + 14, 8), size.width - 76)} ${Math.max(tag.y - 18, BAR_H + 12)})`}
                >
                  <rect x={0} y={-11} width={68} height={22} rx={4} />
                  <text x={34} textAnchor="middle" y={4} className="num">
                    {label}
                  </text>
                </g>
              </g>
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
                  <span className="num" data-testid="trunking-sofar">
                    {formatLength(sofar, 1)}
                    {next > 1e-3 ? ` + ${formatLength(next, 1)} next` : ''}
                  </span>
                </span>
                <span className="draw-bar-row">
                  <button
                    type="button"
                    className="btn trunking-undo"
                    disabled={!run.route?.length}
                    onClick={undoBend}
                    aria-label="Undo bend"
                    title="Undo bend (Backspace)"
                  >
                    {icons.undo}
                    <span className="trunking-wide">Undo bend</span>
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
                    className="btn"
                    onClick={alongWalls}
                    title="Route along the walls, inside the flat, to the ledge"
                    aria-describedby="trunking-route-what"
                  >
                    <span className="trunking-wide">Route along the walls</span>
                    <span className="trunking-narrow">Along walls</span>
                  </button>
                  <span id="trunking-route-what" className="visually-hidden">
                    Route along the walls
                  </span>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      // Bends that go straight on are merged as the run is made.
                      const path = trunkingPath(live(), run);
                      const tidy = simplifyPath(path);
                      if (tidy.length < path.length) {
                        const end = !!run.compressorId;
                        ctx.dispatch(
                          updatePoint(ctx.level.id, run.id, {
                            route: tidy.slice(1, end ? -1 : undefined),
                          }),
                          { coalesceKey: trunking.key },
                        );
                      }
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
