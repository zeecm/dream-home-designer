import { levelBounds, planGeometry } from '@dhd/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Tool, useEditor } from '../editor';
import { useProject, useStore } from '../store';
import { icons } from '../ui/icons';
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
  const select = useSelectTool(ctx);
  const measure = useMeasureTool(ctx);
  return tool === 'measure' ? measure : select;
}

export function PlanCanvas() {
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const project = useProject();
  const level = project.levels[0];
  const dispatch = useStore((s) => s.dispatch);
  const { tool, selection, hover, view, fitRequested } = useEditor();
  const { setView, fitDone, setPointer, requestFit } = useEditor.getState();

  const geom = useMemo(() => (level ? planGeometry(level) : null), [level]);
  const v = view ?? { cx: 0, cy: 0, zoom: 50 };

  useEffect(() => {
    if (!fitRequested || !level || size.width === 0) return;
    setView(fitBounds(levelBounds(level), size));
    fitDone();
  }, [fitRequested, level, size, setView, fitDone]);

  const ctx: ToolContext | null = level && geom ? { level, geom, view: v, size, dispatch } : null;
  const active = useTool(tool, ctx ?? ({} as ToolContext));

  // ---- pointer routing: tools first, pan otherwise
  const pan = useRef<{ x: number; y: number } | null>(null);
  const toolDrag = useRef(false);
  const space = useRef(false);
  const [panning, setPanning] = useState(false);

  const pointer = useCallback(
    (e: {
      clientX: number;
      clientY: number;
      shiftKey: boolean;
      altKey: boolean;
      target: EventTarget | null;
    }): PlanPointer => {
      const r = svgRef.current?.getBoundingClientRect();
      const screen = { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
      return {
        screen,
        world: screenToWorld(v, size, screen),
        hit: parseHit(e.target),
        shift: e.shiftKey,
        alt: e.altKey,
      };
    },
    [v, size],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = pointer(e);
    if (e.button === 1 || e.button === 2 || space.current || !ctx || !active.down(p)) {
      pan.current = p.screen;
      setPanning(true);
      return;
    }
    toolDrag.current = true;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = pointer(e);
    setPointer(p.world);
    if (pan.current) {
      setView(panBy(v, p.screen.x - pan.current.x, p.screen.y - pan.current.y));
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
      if (trackpadPan) setView(panBy(cur, -e.deltaX, -e.deltaY));
      else setView(zoomAt(cur, size, at, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [v, size, setView]);

  // ---- keys: Space pans; the rest goes to the tool
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
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
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
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
    <div ref={wrapRef} className="plan" data-testid="plan">
      <svg
        ref={svgRef}
        className="plan-svg"
        width={size.width}
        height={size.height}
        style={{ cursor }}
        role="application"
        aria-label="Floor plan"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setPointer(null)}
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
        <VertexHandles
          level={level}
          view={v}
          size={size}
          shown={shownVertices}
          interactive={tool === 'select'}
        />
        {active.overlay(ctx)}
      </svg>

      {empty && (
        <div className="plan-empty">
          <p className="plan-empty-title">This plan has no walls yet.</p>
          <p>Upload your floor plan to trace over it, or draw walls straight away.</p>
        </div>
      )}

      <div className="plan-corner plan-corner-br">
        <button
          type="button"
          className="icon-btn"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() =>
            setView(zoomAt(v, size, { x: size.width / 2, y: size.height / 2 }, 1 / 1.25))
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
          onClick={() => setView(zoomAt(v, size, { x: size.width / 2, y: size.height / 2 }, 1.25))}
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
