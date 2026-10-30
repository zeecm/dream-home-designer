import {
  type OpeningKind,
  type OpeningPlacement,
  type SnapResult,
  type Vec2,
  type WallEnd,
  addOpening,
  calibrateUnderlay,
  clampOpeningT,
  drawWall,
  placeOpening,
  snapPoint,
} from '@dhd/core';
import { useEffect, useRef, useState } from 'react';
import { newWallOptions, useEditor } from '../editor';
import { useStore } from '../store';
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
export function useWallTool(ctx: ToolContext): ToolController {
  const [from, setFrom] = useState<WallEnd | null>(null);
  const [first, setFirst] = useState<string | null>(null);
  const [snap, setSnap] = useState<SnapResult | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const thickness = useEditor((s) => s.wallThickness);
  const tool = useEditor((s) => s.tool);
  const fromPos = from ? posOf(ctx, from) : null;

  // Undo can remove the corner the chain is drawing from; start over rather than fail.
  useEffect(() => {
    if (from && !fromPos) {
      setFrom(null);
      setFirst(null);
      setTyped('');
    }
  }, [from, fromPos]);

  // Leaving the tool abandons the chain in progress.
  useEffect(() => {
    if (tool !== 'wall') {
      setFrom(null);
      setFirst(null);
      setTyped('');
      setSnap(null);
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

  /** Corners this chain created or started from, so returning to them doesn't end it. */
  const chain = useRef(new Set<string>());
  const finish = () => {
    setFrom(null);
    setFirst(null);
    setTyped('');
    setError(null);
    chain.current = new Set();
  };

  // A new thickness starts a new chain (it is how people switch to inner walls).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to thickness only
  useEffect(() => {
    setFrom(null);
    setFirst(null);
    chain.current = new Set();
  }, [thickness]);

  const commit = (end: WallEnd) => {
    if (!from) return;
    try {
      const existed = new Set(Object.keys(ctx.level.vertices));
      const r = drawWall(ctx.level, from, end, newWallOptions(thickness));
      ctx.dispatch(r.command);
      setError(null);
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

  return {
    cursor: 'crosshair',
    down: (p) => {
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
    move: (p) => setSnap(snapAt(p)),
    up: () => {},
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
        const len = typed ? parseLength(typed) : null;
        if (typed && fromPos && len && len > 0) {
          const target = snap?.point ?? { x: fromPos.x + 1, y: fromPos.y };
          let dx = target.x - fromPos.x;
          let dy = target.y - fromPos.y;
          const n = Math.hypot(dx, dy) || 1;
          dx /= n;
          dy /= n;
          if (n < 1e-9) dx = 1;
          setTyped('');
          commit({ point: { x: fromPos.x + dx * len, y: fromPos.y + dy * len } });
        } else {
          finish();
        }
        return true;
      }
      if (e.key === 'Escape' && from) {
        finish();
        return true;
      }
      return false;
    },
    overlay: ({ view, size }) => {
      const at = snap?.point;
      const s1 = at && worldToScreen(view, size, at);
      const s0 = fromPos && worldToScreen(view, size, fromPos);
      const len = fromPos && at ? Math.hypot(at.x - fromPos.x, at.y - fromPos.y) : 0;
      return (
        <g className="draw-overlay" pointerEvents="none">
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
          {s1 && <SnapMarker snap={snap} at={s1} />}
          {s1 && (typed || error) && (
            <g transform={`translate(${s1.x + 14} ${s1.y + 22})`}>
              <rect
                x={0}
                y={-14}
                width={error ? 260 : 120}
                height={22}
                rx={4}
                className={error ? 'typed error' : 'typed'}
              />
              <text x={8} y={2}>
                {error ?? `Length: ${typed} ⏎`}
              </text>
            </g>
          )}
        </g>
      );
    },
  };
}

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
      if (!at?.fits) return true;
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
    },
    up: () => {},
    key: () => false,
    overlay: ({ view, size }) => {
      const at = keep.current;
      const f = at && ctx.geom.frames[at.wallId];
      if (onBoundary && !at) {
        const why = 'A room boundary takes no doors or windows';
        return (
          <g
            pointerEvents="none"
            transform={`translate(${onBoundary.x + 14} ${onBoundary.y + 22})`}
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
          : 'Overlaps an opening';
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
  useEffect(() => {
    if (tool !== 'calibrate') {
      setPoints([]);
      setTyped('');
      setError(null);
    }
  }, [tool]);

  const apply = () => {
    const [p1, p2] = points;
    const len = parseLength(typed);
    if (!p1 || !p2) return;
    if (!len || len <= 0) {
      setError('Type the real length, e.g. 4.5 m or 4500 mm, then press Enter.');
      return;
    }
    const factor = len / Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (factor > 100 || factor < 0.01) {
      setError(
        `That would change the scale ${factor > 1 ? 'up' : 'down'} more than 100×. Check the length and its unit, then press Enter.`,
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
    down: (p) => {
      if (points.length >= 2) setPoints([p.world]);
      else setPoints((prev) => [...prev, p.world]);
      setError(null);
      return true;
    },
    move: (p) => setCursor(p.world),
    up: () => {},
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
      const banner = !useStoreUnderlay()
        ? 'Set scale needs a plan image. Upload one from the Plan image panel first.'
        : points.length < 2
          ? `Set scale ${step}/2 · Click both ends of a wall whose length you know (${points.length}/2 clicked).`
          : 'Set scale 2/2 · Type its real length and press Enter (e.g. 4.5 m or 4500 mm).';
      return (
        <g pointerEvents="none">
          <foreignObject x={12} y={12} width={Math.max(0, size.width - 24)} height={40}>
            <div className="canvas-banner">{error ?? banner}</div>
          </foreignObject>
          {a && b && (
            <g className="measure">
              <line {...seg(view, size, a, b)} />
              <circle {...dot(view, size, a)} r={4} />
              <circle {...dot(view, size, b)} r={4} />
            </g>
          )}
          {points.length === 2 && b && (
            <g
              transform={`translate(${worldToScreen(view, size, b).x + 14} ${worldToScreen(view, size, b).y + 22})`}
              className="draw-overlay"
            >
              <rect x={0} y={-14} width={150} height={22} rx={4} className="typed" />
              <text x={8} y={2}>{`Real length: ${typed || '…'}`}</text>
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
  const thickness = useEditor((s) => s.wallThickness);
  const tool = useEditor((s) => s.tool);
  useEffect(() => {
    if (tool !== 'room') setStart(null);
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
        const level = useStore.getState().editor.doc.levels[0];
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
    move: (p) => setSnap(snapAt(p)),
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
      if (!s1) return null;
      if (!start || !at) {
        return (
          <g className="draw-overlay" pointerEvents="none">
            <SnapMarker snap={snap} at={s1} />
          </g>
        );
      }
      const s0 = worldToScreen(view, size, start.point);
      const x = Math.min(s0.x, s1.x);
      const y = Math.min(s0.y, s1.y);
      const w = Math.abs(at.x - start.point.x);
      const h = Math.abs(at.y - start.point.y);
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
          {error && (
            <g transform={`translate(${s1.x + 14} ${s1.y + 22})`}>
              <rect x={0} y={-14} width={300} height={22} rx={4} className="typed error" />
              <text x={8} y={2}>
                {error}
              </text>
            </g>
          )}
        </g>
      );
    },
  };
}
