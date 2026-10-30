import {
  type HistoryEntry,
  type OpeningKind,
  type OpeningPlacement,
  type SnapResult,
  type Vec2,
  type WallEnd,
  addOpening,
  calibrateUnderlay,
  clampOpeningT,
  drawWall,
  moveVertex,
  placeOpening,
  settleVertex,
  snapCorner,
  snapPoint,
} from '@dhd/core';
import { useEffect, useRef, useState } from 'react';
import { newWallOptions, useEditor } from '../editor';
import { currentLevel, useStore } from '../store';
import { useUploadPicker } from '../ui/PlanImage';
import { formatLength, parseLength } from '../units';
import { type PlanPointer, type ToolContext, type ToolController, snapTolerance } from './tools';
import { worldToScreen } from './view';

const endFor = (s: SnapResult): WallEnd =>
  s.vertexId ? { vertexId: s.vertexId } : { point: s.point, wallId: s.wallId };

const posOf = (ctx: ToolContext, e: WallEnd): Vec2 | null => {
  if ('vertexId' in e) {
    const v = ctx.level.vertices[e.vertexId];
    return v ? { x: v.x, y: v.y } : null;
  }
  return e.point;
};

/**
 * Draws walls corner by corner. Each click commits one wall (one undo step). Typing a
 * number sets the next wall's length along the current direction. Clicking the chain's
 * first corner closes it; Enter, a double-click or Esc finishes.
 */
type Turn = 'left' | 'straight' | 'right';
const TURNS: { id: Turn; label: string }[] = [
  { id: 'left', label: '↰ Left' },
  { id: 'straight', label: '↑ Straight' },
  { id: 'right', label: 'Right ↱' },
];

/** A direction turned a quarter left or right, as seen on screen (plan y points down). */
const turnFrom = (d: Vec2, t: Turn): Vec2 =>
  t === 'right' ? { x: -d.y, y: d.x } : t === 'left' ? { x: d.y, y: -d.x } : d;

export function useWallTool(ctx: ToolContext): ToolController {
  const [from, setFrom] = useState<WallEnd | null>(null);
  const [first, setFirst] = useState<string | null>(null);
  const [snap, setSnap] = useState<SnapResult | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** Which way a typed length goes, picked on the drawing bar; null aims at the pointer. */
  const [turn, setTurn] = useState<Turn | null>(null);
  const thickness = useEditor((s) => s.wallThickness);
  const tool = useEditor((s) => s.tool);
  const fromPos = from ? posOf(ctx, from) : null;

  /** Corners this chain created or started from, so returning to them doesn't end it. */
  const chain = useRef(new Set<string>());
  /** Each wall of the chain: where it started and the undo step it made, for "Undo". */
  const steps = useRef<{ start: string; entry: HistoryEntry | undefined }[]>([]);
  /** The direction of the last wall, for a typed length with no pointer to aim by. */
  const lastDir = useRef<Vec2>({ x: 1, y: 0 });
  /** Where a finger drag that will draw the first wall began, to preview it from. */
  const [dragFrom, setDragFrom] = useState<SnapResult | null>(null);
  /** The ends of the wall drawn last: a finger on one drags it instead of drawing anew. */
  const lastWall = useRef<[string, string] | null>(null);
  const grab = useRef<{ id: string; key: string; moved: boolean } | null>(null);
  /** The end of the last wall under a finger at `p`, if any. */
  const endUnder = (p: PlanPointer): string | null => {
    for (const id of [...(lastWall.current ?? [])].reverse()) {
      const v = ctx.level.vertices[id];
      if (!v) continue;
      const s = worldToScreen(ctx.view, ctx.size, v);
      if (Math.hypot(s.x - p.screen.x, s.y - p.screen.y) <= END_REACH) return id;
    }
    return null;
  };
  /** Ends the chain in progress. */
  const finish = () => {
    setFrom(null);
    setFirst(null);
    setTyped('');
    setError(null);
    setSnap(null);
    setTurn(null);
    chain.current = new Set();
    steps.current = [];
    lastDir.current = { x: 1, y: 0 };
  };

  // Undo can remove the corner the chain is drawing from; start over rather than fail.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to the corner going
  useEffect(() => {
    if (from && !fromPos) finish();
  }, [from, fromPos]);

  // Leaving the tool abandons the chain in progress.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to the tool only
  useEffect(() => {
    if (tool !== 'wall') {
      finish();
      lastWall.current = null;
    }
  }, [tool]);

  const snapAt = (p: PlanPointer): SnapResult =>
    p.alt
      ? { point: p.world, kind: 'free' }
      : snapPoint(ctx.level, p.world, {
          tolerance: snapTolerance(ctx),
          grid: 0.1,
          from: fromPos ?? undefined,
        });

  // A new thickness starts a new chain (it is how people switch to inner walls).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to thickness only
  useEffect(() => finish(), [thickness]);

  const commit = (end: WallEnd, start: WallEnd | null = from) => {
    if (!start) return;
    try {
      const level = currentLevel() ?? ctx.level;
      const existed = new Set(Object.keys(level.vertices));
      const r = drawWall(level, start, end, newWallOptions(thickness));
      ctx.dispatch(r.command);
      setError(null);
      // Aim the next typed length afresh: by the pointer once it moves, else straight on.
      setSnap(null);
      const past = useStore.getState().editor.history.past;
      steps.current.push({ start: r.startVertexId, entry: past[past.length - 1] });
      lastWall.current = [r.startVertexId, r.endVertexId];
      setDragFrom(null);
      const after = currentLevel();
      const a = after?.vertices[r.startVertexId];
      const b = after?.vertices[r.endVertexId];
      if (a && b && Math.hypot(b.x - a.x, b.y - a.y) > 1e-9) {
        const n = Math.hypot(b.x - a.x, b.y - a.y);
        lastDir.current = { x: (b.x - a.x) / n, y: (b.y - a.y) / n };
      }
      // The chain ends where it joins what is already drawn: back at its first corner,
      // on an existing corner, or on an existing wall. Free clicks keep it going.
      const closed = 'vertexId' in end && end.vertexId === first;
      const joined =
        ('vertexId' in end && existed.has(end.vertexId) && !chain.current.has(end.vertexId)) ||
        ('wallId' in end && !!end.wallId) ||
        (existed.has(r.endVertexId) && !chain.current.has(r.endVertexId));
      if (closed || joined) {
        finish();
        return;
      }
      chain.current.add(r.startVertexId);
      chain.current.add(r.endVertexId);
      setFirst((f) => f ?? r.startVertexId);
      setFrom({ vertexId: r.endVertexId });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * Where a wall of the typed length would end: turned as picked on the drawing bar, else
   * towards the pointer if it has moved since the last wall, else straight on.
   */
  const typedEnd = (text: string): Vec2 | null => {
    const len = parseLength(text);
    if (!fromPos || !len || len <= 0) return null;
    let d = turnFrom(lastDir.current, turn ?? 'straight');
    const target = snap?.point;
    if (turn === null && target) {
      const n = Math.hypot(target.x - fromPos.x, target.y - fromPos.y);
      if (n > 0.05) d = { x: (target.x - fromPos.x) / n, y: (target.y - fromPos.y) / n };
    }
    return { x: fromPos.x + d.x * len, y: fromPos.y + d.y * len };
  };

  /** Adds the next wall at the typed length. */
  const addTyped = (text = typed) => {
    const end = typedEnd(text);
    if (!end) {
      setError('Enter a length such as 3200 (mm) or 3.2 m.');
      return;
    }
    setTyped('');
    // Landing on a corner (closing the outline, say) joins it, which also ends the chain.
    const level = currentLevel() ?? ctx.level;
    const onto = Object.values(level.vertices).find(
      (v) => Math.hypot(v.x - end.x, v.y - end.y) < 0.02,
    );
    commit(onto ? { vertexId: onto.id } : { point: end });
    // Keep the new end in view: a typed wall can run off the screen.
    const s = worldToScreen(ctx.view, ctx.size, end);
    const m = 48;
    if (s.x < m || s.y < m + 56 || s.x > ctx.size.width - m || s.y > ctx.size.height - m) {
      useEditor.getState().setView({ ...ctx.view, cx: end.x, cy: end.y }, true);
    }
  };

  /**
   * Takes back the chain's last wall and carries on from where it started. Only while that
   * wall is still the latest undo step; after any other edit it just ends the chain.
   */
  const undoLast = () => {
    const step = steps.current.pop();
    const past = useStore.getState().editor.history.past;
    if (!step || past[past.length - 1] !== step.entry) {
      finish();
      return;
    }
    useStore.getState().undo();
    const level = currentLevel();
    if (level?.vertices[step.start]) setFrom({ vertexId: step.start });
    else finish();
  };

  return {
    cursor: 'crosshair',
    // A finger on an end of the wall just drawn adjusts it, as in Select.
    grabs: (p) => {
      const id = endUnder(p);
      grab.current = id ? { id, key: `wall-end:${id}:${Date.now()}`, moved: false } : null;
      return id !== null;
    },
    touchCancel: () => setDragFrom(null),
    touchDrag: (start, end) => {
      setDragFrom(null);
      // A finger dragged from one corner to another draws that wall.
      if (from) {
        commit(endFor(snapAt(end)));
        return;
      }
      const s0 = snapAt(start);
      const s1 = snapPoint(ctx.level, end.world, {
        tolerance: snapTolerance(ctx),
        grid: 0.1,
        from: s0.point,
      });
      setFirst(s0.vertexId ?? null);
      chain.current = new Set(s0.vertexId ? [s0.vertexId] : []);
      commit(endFor(s1), endFor(s0));
    },
    down: (p) => {
      if (grab.current) return true; // an end, grabbed by a finger (see grabs)
      const s = snapAt(p);
      if (p.clicks === 2) {
        finish();
        return true;
      }
      if (!from) {
        setFrom(endFor(s));
        setFirst(s.vertexId ?? null);
        chain.current = new Set(s.vertexId ? [s.vertexId] : []);
        return true;
      }
      commit(endFor(s));
      return true;
    },
    move: (p, dragging, start) => {
      const g = grab.current;
      if (g && dragging) {
        const to = p.alt
          ? p.world
          : snapCorner(ctx.level, g.id, p.world, { tolerance: snapTolerance(ctx), grid: 0.05 });
        ctx.dispatch(moveVertex(ctx.level.id, g.id, to), { coalesceKey: g.key });
        g.moved = true;
        return;
      }
      // A finger drawing the first wall: preview it from where the finger went down.
      const s0 = !fromPos && start ? snapAt(start) : null;
      setDragFrom(s0);
      setSnap(
        s0
          ? snapPoint(ctx.level, p.world, {
              tolerance: snapTolerance(ctx),
              grid: 0.1,
              from: s0.point,
            })
          : snapAt(p),
      );
    },
    up: () => {
      const g = grab.current;
      grab.current = null;
      if (g?.moved) {
        // Joins a corner it was dropped on, in the same undo step as the drag.
        const level = currentLevel();
        if (level) ctx.dispatch(settleVertex(level, g.id), { coalesceKey: g.key });
      }
    },
    key: (e) => {
      if (from && /^[0-9.,]$|^m$|^c$/i.test(e.key)) {
        setTyped((t) => t + e.key);
        return true;
      }
      if (from && e.key === 'Backspace' && typed) {
        setTyped((t) => t.slice(0, -1));
        return true;
      }
      if (e.key === 'Enter' && from) {
        if (typed) addTyped();
        else finish();
        return true;
      }
      if (e.key === 'Escape' && from) {
        finish();
        return true;
      }
      return false;
    },
    overlay: ({ view, size }) => {
      // A typed length previews where it will go; otherwise the wall follows the pointer.
      const planned = typed ? typedEnd(typed) : null;
      const at = planned ?? snap?.point;
      const s1 = at && worldToScreen(view, size, at);
      const startAt = fromPos ?? dragFrom?.point ?? null;
      const s0 = startAt && worldToScreen(view, size, startAt);
      const len = startAt && at ? Math.hypot(at.x - startAt.x, at.y - startAt.y) : 0;
      // The last wall's ends, which a finger can drag to adjust.
      const ends = (lastWall.current ?? [])
        .map((id) => ctx.level.vertices[id])
        .filter((v): v is NonNullable<typeof v> => !!v)
        .map((v) => worldToScreen(view, size, v));
      // A second row, once a length is typed: which way it goes, and any problem.
      // Turning needs a wall to turn from: not before the chain's first.
      const more = (!!typed && steps.current.length > 0) || !!error;
      return (
        <g className="draw-overlay" pointerEvents="none">
          {from && (
            // While a chain is open: an exact length and which way it turns, take back the
            // last wall, or finish. Buttons and a real field, so it all works without a keyboard.
            <foreignObject
              x={8}
              y={8}
              width={Math.max(0, size.width - 16)}
              height={more ? 104 : 56}
              pointerEvents="auto"
            >
              <form
                className="draw-bar"
                onPointerDown={(e) => e.stopPropagation()}
                onPointerMove={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onSubmit={(e) => {
                  e.preventDefault();
                  // Read the field itself: a tap can land before the typing re-rendered.
                  const field = e.currentTarget.elements.namedItem('length');
                  const value = field instanceof HTMLInputElement ? field.value : typed;
                  if (value.trim()) addTyped(value);
                }}
              >
                <span className="draw-bar-row">
                  <input
                    name="length"
                    className="input num"
                    inputMode="decimal"
                    autoComplete="off"
                    aria-label="Next wall length"
                    placeholder="Length, e.g. 3200"
                    value={typed}
                    onChange={(e) => {
                      setTyped(e.target.value);
                      setError(null);
                    }}
                  />
                  {/* Never disabled: a tap right after typing can come before the re-render
                      that would enable it, and a disabled button drops the tap. */}
                  <button type="submit" className="btn" aria-disabled={!typed}>
                    Add
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={steps.current.length === 0}
                    onClick={undoLast}
                  >
                    Undo
                  </button>
                  <button type="button" className="btn btn-primary" onClick={finish}>
                    Done
                  </button>
                </span>
                {more && (
                  <span className="draw-bar-row">
                    {error ? (
                      <span className="draw-bar-error" role="alert">
                        {error}
                      </span>
                    ) : (
                      <fieldset className="segmented" aria-label="Direction">
                        {TURNS.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            aria-pressed={(turn ?? (snap ? null : 'straight')) === t.id}
                            onClick={() => setTurn(t.id)}
                          >
                            {t.label}
                          </button>
                        ))}
                      </fieldset>
                    )}
                  </span>
                )}
              </form>
            </foreignObject>
          )}
          {s0 && s1 && (
            <>
              {snap?.angle !== undefined && (
                <line
                  className="guide"
                  x1={s0.x - Math.cos(snap.angle) * 2000}
                  y1={s0.y - Math.sin(snap.angle) * 2000}
                  x2={s0.x + Math.cos(snap.angle) * 2000}
                  y2={s0.y + Math.sin(snap.angle) * 2000}
                />
              )}
              <line
                className="ghost-wall"
                x1={s0.x}
                y1={s0.y}
                x2={s1.x}
                y2={s1.y}
                strokeWidth={Math.max(2, thickness * view.zoom)}
                strokeDasharray={thickness > 0 ? undefined : '6 4'}
              />
              <g transform={`translate(${(s0.x + s1.x) / 2} ${(s0.y + s1.y) / 2 - 18})`}>
                <rect x={-34} y={-11} width={68} height={22} rx={4} />
                <text textAnchor="middle" y={4} className="num">
                  {formatLength(len)}
                </text>
              </g>
            </>
          )}
          {ends.map((e) => (
            <circle key={`${e.x},${e.y}`} className="end-handle" cx={e.x} cy={e.y} r={9} />
          ))}
          {s1 && !planned && <SnapMarker snap={snap} at={s1} />}
          {s1 && error && (
            <g transform={`translate(${Math.min(s1.x + 14, size.width - 270)} ${s1.y + 22})`}>
              <rect
                x={0}
                y={-14}
                width={error ? 260 : 120}
                height={22}
                rx={4}
                className={error ? 'typed error' : 'typed'}
              />
              <text x={8} y={2}>
                {error ?? `Length: ${typed}`}
              </text>
            </g>
          )}
        </g>
      );
    },
  };
}

/** How near (screen pixels) a finger must land to an end to take it: a fingertip's reach. */
const END_REACH = 22;

function SnapMarker({ snap, at }: { snap: SnapResult | null; at: Vec2 }) {
  if (!snap) return null;
  switch (snap.kind) {
    case 'vertex':
      return <circle className="snap-marker" cx={at.x} cy={at.y} r={6} />;
    case 'wall':
    case 'intersection':
      return (
        <rect
          className="snap-marker"
          x={at.x - 5}
          y={at.y - 5}
          width={10}
          height={10}
          transform={`rotate(45 ${at.x} ${at.y})`}
        />
      );
    default:
      return <circle className="snap-dot" cx={at.x} cy={at.y} r={2.5} />;
  }
}

const OPENING_DEFAULTS: Record<OpeningKind, { height: number; sill: number }> = {
  door: { height: 2.1, sill: 0 },
  window: { height: 1.2, sill: 0.9 },
  passage: { height: 2.1, sill: 0 },
};

type Placement = OpeningPlacement;

/** Places a door, window or passage on the wall under the pointer. */
export function useOpeningTool(ctx: ToolContext, kind: OpeningKind): ToolController {
  const [place, setPlace] = useState<Placement | null>(null);
  const keep = useRef(place);
  keep.current = place;
  const def = OPENING_DEFAULTS[kind];
  const width = useEditor((s) => s.openingWidths[kind]);

  const tolerance = () => Math.max(0.3, 14 / ctx.view.zoom);
  const find = (p: PlanPointer): Placement | null =>
    placeOpening(ctx.geom, p.world, width, tolerance());
  // Over a room boundary there's nothing to place into; say so instead of showing nothing.
  const [onBoundary, setOnBoundary] = useState<Vec2 | null>(null);
  /** Where a tap found no wall, to say so. */
  const [missed, setMissed] = useState<Vec2 | null>(null);
  /** Where an opening went in narrower than picked, to fit its wall, and how wide. */
  const [narrowed, setNarrowed] = useState<{ at: Vec2; width: number } | null>(null);
  const boundaryNear = (p: PlanPointer) =>
    ctx.geom.boundaries.some((id) => {
      const f = ctx.geom.frames[id];
      if (!f) return false;
      const u = (p.world.x - f.a.x) * f.d.x + (p.world.y - f.a.y) * f.d.y;
      const v = (p.world.x - f.a.x) * f.n.x + (p.world.y - f.a.y) * f.n.y;
      return u >= 0 && u <= f.length && Math.abs(v) <= tolerance();
    });

  return {
    cursor: 'copy',
    down: (p) => {
      const at = find(p);
      if (!at?.fits) {
        // Say why where it was tried: a tap has no hover preview to show it beforehand.
        setPlace(at);
        setOnBoundary(!at && boundaryNear(p) ? p.screen : null);
        setMissed(!at && !boundaryNear(p) ? p.screen : null);
        return true;
      }
      setPlace(null);
      setMissed(null);
      setOnBoundary(null);
      setNarrowed(at.width < width - 1e-6 ? { at: p.screen, width: at.width } : null);
      const r = addOpening(ctx.level.id, {
        wallId: at.wallId,
        kind,
        t: at.t,
        width: at.width,
        height: def.height,
        sill: def.sill,
        ...(kind === 'door'
          ? { swing: `${at.nearA ? 'left' : 'right'}${at.side > 0 ? 'In' : 'Out'}` as const }
          : {}),
      });
      ctx.dispatch(r.command);
      useEditor.getState().select({ kind: 'opening', id: r.openingId });
      return true;
    },
    move: (p) => {
      const at = find(p);
      setPlace(at);
      setOnBoundary(!at && boundaryNear(p) ? p.screen : null);
      setMissed(null);
      // The "narrowed" note stays until the pointer moves well away from it.
      setNarrowed((n) =>
        n && Math.hypot(p.screen.x - n.at.x, p.screen.y - n.at.y) < 60 ? n : null,
      );
    },
    up: () => {},
    key: () => false,
    overlay: ({ view, size }) => {
      const at = keep.current;
      const f = at && ctx.geom.frames[at.wallId];
      const name = kind === 'passage' ? 'opening' : kind;
      const note = at ? null : (onBoundary ?? missed ?? narrowed?.at ?? null);
      if (note) {
        const why = onBoundary
          ? 'A room boundary takes no doors or windows'
          : missed
            ? `Tap or click on a wall to add ${kind === 'passage' ? 'an opening' : `a ${kind}`}`
            : `Narrowed to ${Math.round((narrowed?.width ?? 0) * 1000)} mm to fit this wall`;
        return (
          <g
            pointerEvents="none"
            transform={`translate(${Math.min(note.x + 14, size.width - why.length * 7 - 24)} ${note.y + 22})`}
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
      if (!at || !f) return null;
      const c = at.t * f.length;
      const corners = [
        [c - at.width / 2, 1],
        [c + at.width / 2, 1],
        [c + at.width / 2, -1],
        [c - at.width / 2, -1],
      ].map(([u, side]) =>
        worldToScreen(view, size, {
          x: f.a.x + f.d.x * (u as number) + f.n.x * (f.half + 0.02) * (side as number),
          y: f.a.y + f.d.y * (u as number) + f.n.y * (f.half + 0.02) * (side as number),
        }),
      );
      const why = at.fits
        ? null
        : at.width < 0.4
          ? 'This wall is too short'
          : `No room for a ${Math.round(width * 1000)} mm ${name} here`;
      const tip = corners[0];
      return (
        <g pointerEvents="none">
          <polygon
            className={at.fits ? 'ghost-opening' : 'ghost-opening invalid'}
            points={corners.map((p) => `${p.x},${p.y}`).join(' ')}
          />
          {why && tip && (
            <g transform={`translate(${tip.x + 12} ${tip.y - 18})`}>
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
          )}
        </g>
      );
    },
  };
}

/**
 * Sets the plan image's scale: click both ends of something whose length you know (a
 * dimensioned wall), then type that length.
 */
export function useCalibrateTool(ctx: ToolContext): ToolController {
  const [points, setPoints] = useState<Vec2[]>([]);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const tool = useEditor((s) => s.tool);
  /** The end being dragged to adjust it, once both are placed. */
  const grab = useRef<number | null>(null);
  const endAt = (p: PlanPointer): number | null => {
    if (points.length < 2) return null;
    let best: number | null = null;
    let bestD = 24; // screen px: a fingertip's reach
    points.forEach((q, i) => {
      const s = worldToScreen(ctx.view, ctx.size, q);
      const d = Math.hypot(s.x - p.screen.x, s.y - p.screen.y);
      if (d < bestD) {
        best = i;
        bestD = d;
      }
    });
    return best;
  };
  const moveEnd = (i: number, to: Vec2) =>
    setPoints((prev) => prev.map((q, k) => (k === i ? to : q)));
  useEffect(() => {
    if (tool !== 'calibrate') {
      setPoints([]);
      setTyped('');
      setError(null);
    }
  }, [tool]);

  const upload = useUploadPicker();
  const apply = (text = typed) => {
    const [p1, p2] = points;
    const len = parseLength(text);
    if (!p1 || !p2) return;
    if (!len || len <= 0) {
      setError('Enter the real length, e.g. 4500 (mm) or 4.5 m.');
      return;
    }
    const factor = len / Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (factor > 100 || factor < 0.01) {
      setError(
        `That would change the scale ${factor > 1 ? 'up' : 'down'} more than 100×. Check the length and its unit.`,
      );
      return;
    }
    try {
      ctx.dispatch(calibrateUnderlay(p1, p2, len));
      // The image grew or shrank about the first point; scale the view the same way so
      // the drawing stays exactly where it was on screen.
      const v = ctx.view;
      useEditor.getState().setView(
        {
          cx: p1.x + factor * (v.cx - p1.x),
          cy: p1.y + factor * (v.cy - p1.y),
          zoom: v.zoom / factor,
        },
        true,
      );
      setPoints([]);
      setTyped('');
      setError(null);
      useEditor.getState().setTool('wall');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return {
    cursor: 'crosshair',
    grabs: (p) => endAt(p) !== null,
    // A finger dragged along the dimension line marks both ends at once.
    touchDrag: (a, b) => {
      setPoints([a.world, b.world]);
      setError(null);
    },
    down: (p) => {
      // Both ends placed: pressing on one drags it; anywhere else starts over.
      const end = endAt(p);
      if (end !== null) {
        grab.current = end;
        return true;
      }
      if (points.length >= 2) setPoints([p.world]);
      else setPoints((prev) => [...prev, p.world]);
      setError(null);
      return true;
    },
    move: (p, dragging) => {
      setCursor(p.world);
      if (dragging && grab.current !== null) moveEnd(grab.current, p.world);
    },
    up: () => {
      grab.current = null;
    },
    key: (e) => {
      if (points.length === 2 && /^[0-9.,]$|^m$|^c$/i.test(e.key)) {
        setTyped((t) => t + e.key);
        return true;
      }
      if (points.length === 2 && e.key === 'Backspace') {
        setTyped((t) => t.slice(0, -1));
        return true;
      }
      if (points.length === 2 && e.key === 'Enter') {
        apply();
        return true;
      }
      if (e.key === 'Escape' && points.length > 0) {
        setPoints([]);
        setTyped('');
        return true;
      }
      return false;
    },
    overlay: ({ view, size }) => {
      const a = points[0];
      const b = points[1] ?? cursor;
      const step = !ctx.level || points.length === 0 ? 1 : points.length === 1 ? 1 : 2;
      if (!useStoreUnderlay()) {
        // Nothing to scale yet: the way to get a plan image, right here.
        return (
          <foreignObject
            x={12}
            y={12}
            width={Math.max(0, size.width - 24)}
            height={120}
            pointerEvents="auto"
          >
            <div
              className="draw-bar"
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
            >
              <span>Set scale needs a plan image of your floor plan.</span>
              <span className="draw-bar-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={upload.open}
                  disabled={upload.busy}
                >
                  {upload.busy ? 'Reading…' : 'Upload floor plan'}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => upload.sample('hdb')}
                  disabled={upload.busy}
                >
                  HDB plan (PDF)
                </button>
              </span>
              {upload.error && <span className="error-text">{upload.error}</span>}
              {upload.picker}
            </div>
          </foreignObject>
        );
      }
      const banner =
        points.length < 2
          ? `Set scale ${step}/2 · Tap or click both ends of a length you know, or drag along it (${points.length}/2).`
          : 'Set scale 2/2 · Type its real length and press Enter (e.g. 4.5 m or 4500 mm).';
      const asking = points.length === 2;
      // The length card goes on the side away from the line, so the marked ends stay in view.
      const lineY =
        a && b ? (worldToScreen(view, size, a).y + worldToScreen(view, size, b).y) / 2 : 0;
      const cardH = asking ? 96 : 40;
      // At the bottom, it sits above the corner controls (Fit) and the scale bar.
      const cardY = asking && lineY < size.height / 2 ? size.height - cardH - 72 : 12;
      return (
        <g pointerEvents="none">
          <foreignObject
            x={12}
            y={cardY}
            width={Math.max(0, size.width - 24)}
            height={cardH}
            pointerEvents={asking ? 'auto' : 'none'}
          >
            {asking ? (
              // A real field, so phones show a number pad; typing anywhere works too.
              <form
                className="canvas-banner canvas-form"
                onPointerDown={(e) => e.stopPropagation()}
                onSubmit={(e) => {
                  e.preventDefault();
                  // Read the field itself: a tap can land before the typing re-rendered.
                  const field = e.currentTarget.elements.namedItem('length');
                  apply(field instanceof HTMLInputElement ? field.value : typed);
                }}
              >
                <label htmlFor="calibrate-length">
                  {error ?? 'Set scale 2/2 · How long is it really? Drag an end to adjust it.'}
                </label>
                <span className="canvas-form-row">
                  <input
                    id="calibrate-length"
                    name="length"
                    className="input num"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="e.g. 4500 (mm) or 4.5 m"
                    // biome-ignore lint/a11y/noAutofocus: the next step is typing this length
                    autoFocus
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setPoints([]);
                        setTyped('');
                      }
                    }}
                  />
                  <button type="submit" className="btn btn-primary">
                    Set scale
                  </button>
                </span>
              </form>
            ) : (
              <div className="canvas-banner">{error ?? banner}</div>
            )}
          </foreignObject>
          {a && b && (
            <g className="measure">
              <line {...seg(view, size, a, b)} />
              <circle {...dot(view, size, a)} r={points.length === 2 ? 6 : 4} />
              <circle {...dot(view, size, b)} r={points.length === 2 ? 6 : 4} />
            </g>
          )}
        </g>
      );
    },
  };
}

const useStoreUnderlay = () => useStore.getState().editor.doc.underlay;

const seg = (
  view: Parameters<typeof worldToScreen>[0],
  size: Parameters<typeof worldToScreen>[1],
  a: Vec2,
  b: Vec2,
) => {
  const s0 = worldToScreen(view, size, a);
  const s1 = worldToScreen(view, size, b);
  return { x1: s0.x, y1: s0.y, x2: s1.x, y2: s1.y };
};
const dot = (
  view: Parameters<typeof worldToScreen>[0],
  size: Parameters<typeof worldToScreen>[1],
  p: Vec2,
) => {
  const s = worldToScreen(view, size, p);
  return { cx: s.x, cy: s.y };
};

/** Draws a rectangular room from two opposite corners: four walls, one undo step. */
export function useRoomTool(ctx: ToolContext): ToolController {
  const [start, setStart] = useState<SnapResult | null>(null);
  const [snap, setSnap] = useState<SnapResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Where a finger drag drawing the room began, to preview the room before it lifts. */
  const [dragFrom, setDragFrom] = useState<SnapResult | null>(null);
  const thickness = useEditor((s) => s.wallThickness);
  const tool = useEditor((s) => s.tool);
  useEffect(() => {
    if (tool !== 'room') {
      setStart(null);
      setError(null);
    }
  }, [tool]);

  const snapAt = (p: PlanPointer): SnapResult =>
    p.alt
      ? { point: p.world, kind: 'free' }
      : snapPoint(ctx.level, p.world, { tolerance: snapTolerance(ctx), grid: 0.1 });

  const build = (a: SnapResult, b: Vec2) => {
    const w = Math.abs(b.x - a.point.x);
    const h = Math.abs(b.y - a.point.y);
    if (w < 0.3 || h < 0.3) {
      setError('A room needs to be at least 0.3 m on each side.');
      return;
    }
    const corners: Vec2[] = [a.point, { x: b.x, y: a.point.y }, b, { x: a.point.x, y: b.y }];
    const key = `room:${Date.now()}`;
    let from: WallEnd = endFor(a);
    let first: string | null = null;
    try {
      for (let i = 1; i <= 4; i++) {
        const level = currentLevel();
        if (!level) return;
        const to: WallEnd =
          i === 4 && first ? { vertexId: first } : { point: corners[i % 4] as Vec2 };
        const r = drawWall(level, from, to, newWallOptions(thickness));
        ctx.dispatch(r.command, { coalesceKey: key });
        first ??= r.startVertexId;
        from = { vertexId: r.endVertexId };
      }
      setError(null);
    } catch (e) {
      // All four walls or none: take back the ones already added.
      const key0 = key;
      const past = useStore.getState().editor.history.past;
      if (past[past.length - 1]?.coalesceKey === key0) useStore.getState().undo();
      setError((e as Error).message);
    }
  };

  return {
    cursor: 'crosshair',
    // A finger dragged corner to corner draws the room in one go, from where it went down
    // (not from a corner an earlier stray tap left waiting).
    touchDrag: (a, b) => {
      build(snapAt(a), snapAt(b).point);
      setStart(null);
      setDragFrom(null);
    },
    touchCancel: () => setDragFrom(null),
    down: (p) => {
      const s = snapAt(p);
      if (!start) {
        setStart(s);
        setError(null);
      } else {
        build(start, s.point);
        setStart(null);
      }
      return true;
    },
    move: (p, _dragging, from) => {
      setDragFrom(from ? snapAt(from) : null);
      setSnap(snapAt(p));
    },
    up: () => {},
    key: (e) => {
      if (e.key === 'Escape' && start) {
        setStart(null);
        return true;
      }
      return false;
    },
    overlay: ({ view, size }) => {
      const at = snap?.point;
      const s1 = at && worldToScreen(view, size, at);
      // With a corner waiting (a phone has no pointer to preview with), say so and offer a
      // way out; a problem shows here too, since there may be no pointer to show it by.
      const notice = (error || start) && (
        <foreignObject x={8} y={8} width={Math.max(0, size.width - 16)} height={52}>
          <div
            className="draw-bar draw-bar-notice"
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            <span
              className={error ? 'draw-bar-error' : undefined}
              role={error ? 'alert' : undefined}
            >
              {error ?? 'First corner set. Tap or click the opposite corner.'}
            </span>
            {start && (
              <button
                type="button"
                className="btn"
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={() => setStart(null)}
              >
                Cancel
              </button>
            )}
          </div>
        </foreignObject>
      );
      const corner = start && worldToScreen(view, size, start.point);
      // The room grows from a corner set by a tap, or from where a finger drag began.
      const origin = start ?? dragFrom;
      if (!origin || !at || !s1) {
        return (
          <g className="draw-overlay" pointerEvents="none">
            {corner && <circle className="pending-corner" cx={corner.x} cy={corner.y} r={6} />}
            {s1 && <SnapMarker snap={snap} at={s1} />}
            <g pointerEvents="auto">{notice}</g>
          </g>
        );
      }
      const s0 = worldToScreen(view, size, origin.point);
      const x = Math.min(s0.x, s1.x);
      const y = Math.min(s0.y, s1.y);
      const w = Math.abs(at.x - origin.point.x);
      const h = Math.abs(at.y - origin.point.y);
      return (
        <g className="draw-overlay" pointerEvents="none">
          <rect
            className="ghost-room"
            x={x}
            y={y}
            width={Math.abs(s1.x - s0.x)}
            height={Math.abs(s1.y - s0.y)}
          />
          <g transform={`translate(${(s0.x + s1.x) / 2} ${Math.min(s0.y, s1.y) - 18})`}>
            <rect x={-58} y={-11} width={116} height={22} rx={4} />
            <text textAnchor="middle" y={4} className="num">
              {`${w.toFixed(2)} × ${h.toFixed(2)} m`}
            </text>
          </g>
          <SnapMarker snap={snap} at={s1} />
          <g pointerEvents="auto">{notice}</g>
        </g>
      );
    },
  };
}
