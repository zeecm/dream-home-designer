import { levelBounds, planGeometry, underlayToWorld } from '@dhd/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Tool, useEditor } from '../editor';
import { useProject, useStore } from '../store';
import { uploadPlanImage, usePlanImage, useUploadPicker } from '../ui/PlanImage';
import { icons } from '../ui/icons';
import { useCalibrateTool, useOpeningTool, useRoomTool, useWallTool } from './drawTools';
import { describe } from './keyboard';
import {
  PlanHighlights,
  PlanShapes,
  RoomLabels,
  VertexHandles,
  WallDimension,
  parseHit,
} from './layers';
import {
  type PlanPointer,
  type ToolContext,
  type ToolController,
  useMeasureTool,
  useSelectTool,
} from './tools';
import { type Size, fitBounds, gridStep, panBy, screenToWorld, zoomAt } from './view';

function useElementSize<T extends Element>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ width: Math.round(width), height: Math.round(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

function useTool(tool: Tool, ctx: ToolContext): ToolController {
  // Every tool hook runs every render so hook order never changes.
  const tools: Record<Tool, ToolController> = {
    select: useSelectTool(ctx),
    measure: useMeasureTool(ctx),
    wall: useWallTool(ctx),
    room: useRoomTool(ctx),
    door: useOpeningTool(ctx, 'door'),
    window: useOpeningTool(ctx, 'window'),
    passage: useOpeningTool(ctx, 'passage'),
    calibrate: useCalibrateTool(ctx),
  };
  return tools[tool];
}

export function PlanCanvas() {
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const project = useProject();
  const level = project.levels[0];
  const dispatch = useStore((s) => s.dispatch);
  // Narrow selectors: the canvas re-renders for these, not for every editor change.
  const tool = useEditor((s) => s.tool);
  const selection = useEditor((s) => s.selection);
  const hover = useEditor((s) => s.hover);
  const view = useEditor((s) => s.view);
  const fitRequested = useEditor((s) => s.fitRequested);
  const { setView, fitDone, requestFit } = useEditor.getState();

  const geom = useMemo(() => (level ? planGeometry(level) : null), [level]);
  const underlay = project.underlay;
  const image = usePlanImage();
  const upload = useUploadPicker();
  const [dropping, setDropping] = useState(false);
  // Focus ring on the canvas: shown when Tab moved focus here, hidden on the next click.
  const [ring, setRing] = useState(false);
  const lastTab = useRef(0);
  const lastPointer = useRef(0);
  const v = view ?? { cx: 0, cy: 0, zoom: 50 };

  const viewAdjusted = useEditor((s) => s.viewAdjusted);
  // Fit on request, and keep fitting while the pane resizes until the user pans or zooms.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refit on size, request or image, not on every edit
  useEffect(() => {
    if ((!fitRequested && viewAdjusted) || !level || size.width === 0) return;
    let b = levelBounds(level);
    if (!b && underlay && image.status === 'ready') {
      const corners = [
        { x: 0, y: 0 },
        { x: image.width, y: 0 },
        { x: image.width, y: image.height },
        { x: 0, y: image.height },
      ].map((p) => underlayToWorld(underlay, p));
      b = {
        min: { x: Math.min(...corners.map((c) => c.x)), y: Math.min(...corners.map((c) => c.y)) },
        max: { x: Math.max(...corners.map((c) => c.x)), y: Math.max(...corners.map((c) => c.y)) },
      };
    }
    setView(fitBounds(b, size));
    fitDone();
  }, [fitRequested, viewAdjusted, size, image.status, setView, fitDone]);

  const ctx: ToolContext | null = level && geom ? { level, geom, view: v, size, dispatch } : null;
  const active = useTool(tool, ctx ?? ({} as ToolContext));

  // ---- pointer routing: tools first, pan otherwise
  const pan = useRef<{ x: number; y: number } | null>(null);
  const toolDrag = useRef(false);
  const space = useRef(false);
  const [panning, setPanning] = useState(false);

  const pointer = useCallback(
    (
      e: {
        clientX: number;
        clientY: number;
        shiftKey: boolean;
        altKey: boolean;
        target: EventTarget | null;
      },
      clicks = 1,
    ): PlanPointer => {
      const r = svgRef.current?.getBoundingClientRect();
      const screen = { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
      return {
        screen,
        world: screenToWorld(v, size, screen),
        hit: parseHit(e.target),
        shift: e.shiftKey,
        alt: e.altKey,
        clicks,
      };
    },
    [v, size],
  );

  // Pointer events don't reliably carry a click count, so detect double-clicks here.
  const lastDown = useRef({ t: 0, x: 0, y: 0 });
  const onPointerDown = (e: React.PointerEvent) => {
    lastPointer.current = Date.now();
    setRing(false);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const now = performance.now();
    const prev = lastDown.current;
    const double =
      e.button === 0 &&
      now - prev.t < 350 &&
      Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 6;
    lastDown.current = double ? { t: 0, x: 0, y: 0 } : { t: now, x: e.clientX, y: e.clientY };
    const p = pointer(e, double ? 2 : 1);
    if (e.button === 1 || e.button === 2 || space.current || !ctx || !active.down(p)) {
      pan.current = p.screen;
      setPanning(true);
      return;
    }
    toolDrag.current = true;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = pointer(e);
    if (pan.current) {
      setView(panBy(v, p.screen.x - pan.current.x, p.screen.y - pan.current.y), true);
      pan.current = p.screen;
      return;
    }
    if (ctx) active.move(p, toolDrag.current);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (pan.current) {
      pan.current = null;
      setPanning(false);
      return;
    }
    if (toolDrag.current && ctx) active.up(pointer(e));
    toolDrag.current = false;
  };

  // ---- wheel: pinch or ctrl+wheel zooms; trackpad scroll pans; a mouse wheel zooms
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const at = { x: e.clientX - r.left, y: e.clientY - r.top };
      const cur = useEditor.getState().view ?? v;
      const trackpadPan =
        !e.ctrlKey && (e.deltaX !== 0 || (e.deltaMode === 0 && !Number.isInteger(e.deltaY)));
      if (trackpadPan) setView(panBy(cur, -e.deltaX, -e.deltaY), true);
      else setView(zoomAt(cur, size, at, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))), true);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [v, size, setView]);

  // ---- keys: Space pans; the rest goes to the tool first
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        lastTab.current = Date.now();
        // Tabbing between plan objects is keyboard use: show the ring again.
        if (e.target === svgRef.current) setRing(true);
      }
      if (isTyping(e.target)) return;
      if (e.code === 'Space') {
        space.current = true;
        e.preventDefault();
        return;
      }
      if (ctx && active.key(e)) e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') space.current = false;
    };
    // Capture phase: the active tool sees keys before the app's shortcuts, so typing a
    // wall length like "2.5m" never switches views or tools.
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up);
    };
  });

  if (!level || !geom || !ctx) return <div ref={wrapRef} className="plan" />;

  const transform = `translate(${size.width / 2 - v.cx * v.zoom} ${size.height / 2 - v.cy * v.zoom}) scale(${v.zoom})`;
  const grid = gridStep(v.zoom);
  const shownVertices = new Set<string>();
  if (selection?.kind === 'vertex') shownVertices.add(selection.id);
  if (hover?.kind === 'vertex') shownVertices.add(hover.id);
  if (selection?.kind === 'wall') {
    const w = level.walls[selection.id];
    if (w) {
      shownVertices.add(w.a);
      shownVertices.add(w.b);
    }
  }
  const cursor = panning ? 'grabbing' : hover && tool === 'select' ? 'pointer' : active.cursor;
  const empty = Object.keys(level.walls).length === 0;

  return (
    <div
      ref={wrapRef}
      className={`plan${dropping ? ' plan-dropping' : ''}`}
      data-testid="plan"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        const f = e.dataTransfer.files[0];
        if (f)
          void uploadPlanImage(f).catch((err: Error) => useStore.setState({ notice: err.message }));
      }}
    >
      <svg
        ref={svgRef}
        className="plan-svg"
        width={size.width}
        height={size.height}
        style={{ cursor }}
        role="application"
        aria-label="Floor plan"
        aria-describedby="plan-keys"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: role="application" takes keyboard input
        tabIndex={0}
        data-ring={ring || undefined}
        onFocus={() =>
          setRing(lastTab.current > lastPointer.current && Date.now() - lastTab.current < 500)
        }
        onBlur={() => setRing(false)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        <defs>
          <pattern
            id="grid-minor"
            width={grid.minor * v.zoom}
            height={grid.minor * v.zoom}
            patternUnits="userSpaceOnUse"
            x={(size.width / 2 - v.cx * v.zoom) % (grid.minor * v.zoom)}
            y={(size.height / 2 - v.cy * v.zoom) % (grid.minor * v.zoom)}
          >
            <path
              d={`M ${grid.minor * v.zoom} 0 L 0 0 0 ${grid.minor * v.zoom}`}
              className="grid-line"
            />
          </pattern>
        </defs>
        <rect
          width={size.width}
          height={size.height}
          fill="url(#grid-minor)"
          pointerEvents="none"
        />
        <g transform={transform}>
          {underlay && image.status === 'ready' && (
            <image
              className="underlay"
              href={image.url}
              width={image.width}
              height={image.height}
              opacity={underlay.opacity}
              transform={`translate(${underlay.origin.x} ${underlay.origin.y}) rotate(${(underlay.rotation * 180) / Math.PI}) scale(${underlay.scale})`}
              pointerEvents="none"
              preserveAspectRatio="none"
            />
          )}
          <PlanShapes level={level} geom={geom} interactive={tool === 'select'} />
          <PlanHighlights
            level={level}
            geom={geom}
            hover={tool === 'select' ? hover : null}
            selection={selection}
          />
        </g>
        <RoomLabels level={level} geom={geom} view={v} size={size} />
        {selection?.kind === 'wall' && (
          <WallDimension level={level} geom={geom} view={v} size={size} wallId={selection.id} />
        )}
        {selection?.kind === 'vertex' &&
          Object.values(level.walls)
            .filter((w) => w.a === selection.id || w.b === selection.id)
            .map((w) => (
              <WallDimension
                key={w.id}
                level={level}
                geom={geom}
                view={v}
                size={size}
                wallId={w.id}
              />
            ))}
        <VertexHandles
          level={level}
          view={v}
          size={size}
          shown={tool === 'wall' || tool === 'room' ? 'all' : shownVertices}
          interactive={tool === 'select'}
        />
        {active.overlay(ctx)}
      </svg>

      <p id="plan-keys" className="visually-hidden">
        In Select, Tab moves through rooms, walls, openings and corners. Arrow keys nudge the
        selected corner, wall or opening by 1 cm, or 10 cm with Shift, and otherwise pan the plan.
      </p>
      <p className="visually-hidden" aria-live="polite">
        {describe(level, selection)}
      </p>

      {empty && !underlay && (
        <div className="plan-empty">
          <p className="plan-empty-title">Start your plan</p>
          <p>Trace over a picture of your floor plan, or draw walls straight away.</p>
          <div className="button-row">
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
              onClick={() => useEditor.getState().setTool('wall')}
            >
              Draw walls
            </button>
          </div>
          <p className="field-hint">
            Or drop a JPG, PNG or PDF here, or{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() => upload.sample('drawn')}
              disabled={upload.busy}
            >
              try the sample plan
            </button>
            .
          </p>
          {upload.error && <p className="field-hint error-text">{upload.error}</p>}
          {upload.picker}
        </div>
      )}

      <div className="plan-corner plan-corner-br">
        <button
          type="button"
          className="icon-btn"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() =>
            setView(zoomAt(v, size, { x: size.width / 2, y: size.height / 2 }, 1 / 1.25), true)
          }
        >
          {icons.minus}
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Fit plan"
          title="Fit plan (F)"
          onClick={requestFit}
        >
          {icons.fit}
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() =>
            setView(zoomAt(v, size, { x: size.width / 2, y: size.height / 2 }, 1.25), true)
          }
        >
          {icons.plus}
        </button>
      </div>
      <ScaleBar zoom={v.zoom} />
    </div>
  );
}

function ScaleBar({ zoom }: { zoom: number }) {
  const metres = [0.5, 1, 2, 5, 10, 20].find((m) => m * zoom >= 60) ?? 20;
  return (
    <div className="plan-corner plan-corner-bl scale-bar" aria-hidden="true">
      <span className="scale-bar-line" style={{ width: metres * zoom }} />
      <span className="num">{metres} m</span>
    </div>
  );
}
