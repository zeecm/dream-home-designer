import {
  furnitureKind,
  furnitureLayer,
  levelBounds,
  planGeometry,
  siteOf,
  underlayToWorld,
} from '@dhd/core';
import type { Vec2 } from '@dhd/core';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { type PixelBox, inkBounds } from '../assets';
import { type Tool, useEditor } from '../editor';
import { currentLevel, useLevel, useProject, useStore } from '../store';
import { Compass, describeNorth } from '../ui/Compass';
import { uploadPlanImage, usePlanImage, useUploadPicker } from '../ui/PlanImage';
import { RenovationMarks } from '../ui/Renovation';
import { icons } from '../ui/icons';
import { useCalibrateTool, useOpeningTool, useRoomTool, useWallTool } from './drawTools';
import { useFurnitureTool } from './furnitureTool';
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
  onDrawnHandle,
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
  // While a dialog is open, keys are the dialog's, not the plan's shortcuts.
  !!document.querySelector('dialog[open]') ||
  (t instanceof HTMLElement &&
    (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)));

function useTool(tool: Tool, ctx: ToolContext): ToolController {
  // Every tool hook runs every render so hook order never changes.
  const select = useSelectTool(ctx);
  const routed = useRef(false);
  /** A press on a handle (not on the piece): a place if it never moves, a resize if it does. */
  const onHandle = useRef<{ start: PlanPointer; moved: boolean } | null>(null);
  /** The pointer is over a placed piece or its handles: no ghost of a new one there. */
  const overOwn = useRef(false);
  /**
   * A placing tool that also moves what it placed: a press on an existing piece of its kind
   * goes to Select for that gesture (a drag moves it, a tap selects it), instead of adding
   * another one beside it. Furniture just placed shows its resize and turn handles: a drag
   * from one goes to Select too, but a tap there still places the next piece (beside a
   * chair, the next chair). A piece that goes on top of others or above them (a table lamp,
   * a ceiling light) is placed over a piece as anywhere else.
   */
  const placing = (own: ToolController, kind: 'item' | 'opening'): ToolController => {
    const handle = (p: PlanPointer) =>
      kind === 'item' && p.hit?.kind !== kind && (select.grabs?.(p) ?? false);
    const over = () => {
      const k = kind === 'item' && furnitureKind(useEditor.getState().furnitureKind);
      return !!k && (!!k.ceiling || (k.elevation ?? 0) > 0);
    };
    /**
     * Whether a piece is on the same level as the one picked (a lamp with a lamp, a light with
     * a light): a press on it selects it, rather than placing over it.
     */
    const raised = (id: string) => {
      const it = ctx?.level.items[id];
      const picked = furnitureKind(useEditor.getState().furnitureKind);
      return !!it && furnitureLayer(furnitureKind(it.assetId)) === furnitureLayer(picked);
    };
    const onOwn = (p: PlanPointer) =>
      (p.hit?.kind === kind && (!over() || raised(p.hit.id))) || handle(p);
    return {
      ...own,
      grabs: (p) => onOwn(p) || (own.grabs?.(p) ?? false),
      down: (p) => {
        routed.current = onOwn(p);
        onHandle.current = handle(p) ? { start: p, moved: false } : null;
        return routed.current ? select.down(p) : own.down(p);
      },
      move: (p, dragging, from) => {
        if (!dragging) overOwn.current = onOwn(p);
        const h = onHandle.current;
        if (
          h &&
          dragging &&
          Math.hypot(p.screen.x - h.start.screen.x, p.screen.y - h.start.screen.y) >= 3
        ) {
          h.moved = true;
        }
        return routed.current && dragging ? select.move(p, dragging) : own.move(p, dragging, from);
      },
      up: (p) => {
        const h = onHandle.current;
        onHandle.current = null;
        if (!routed.current) return own.up(p);
        routed.current = false;
        select.up(p);
        if (h && !h.moved && !(ctx && onDrawnHandle(ctx, h.start))) {
          own.down(h.start);
          own.up(p);
        }
      },
      // Mid-drag on a piece or a handle, Escape and the rest go to Select's drag.
      key: (e) => (routed.current && select.key(e)) || own.key(e),
      touchCancel: () => {
        onHandle.current = null;
        if (routed.current) {
          routed.current = false;
          select.touchCancel?.();
        } else own.touchCancel?.();
      },
      overlay: (o) =>
        kind === 'item' ? (
          <>
            {!overOwn.current && !routed.current && own.overlay(o)}
            {select.overlay(o)}
          </>
        ) : routed.current ? (
          // Dragging a door shows Select's clearances to the corners, not a new door's ghost.
          select.overlay(o)
        ) : (
          own.overlay(o)
        ),
    };
  };
  const tools: Record<Tool, ToolController> = {
    select,
    measure: useMeasureTool(ctx),
    wall: useWallTool(ctx),
    room: useRoomTool(ctx),
    door: placing(useOpeningTool(ctx, 'door'), 'opening'),
    window: placing(useOpeningTool(ctx, 'window'), 'opening'),
    passage: placing(useOpeningTool(ctx, 'passage'), 'opening'),
    calibrate: useCalibrateTool(ctx),
    furniture: placing(useFurnitureTool(ctx), 'item'),
  };
  return tools[tool];
}

/**
 * Fingers on the screen anywhere, not only on the plan: a pinch whose other finger landed
 * on a bar beside the plan is still a pinch, never a tap. `multi` holds until all lift.
 */
const screenTouch = { down: new Set<number>(), multi: false };
if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType !== 'touch') return;
      // The first finger on the screen: forget any whose lift never arrived.
      if (e.isPrimary) {
        screenTouch.down.clear();
        screenTouch.multi = false;
      }
      screenTouch.down.add(e.pointerId);
      if (screenTouch.down.size > 1) screenTouch.multi = true;
    },
    { capture: true },
  );
  // Seen in the capture phase (nothing can stop it there); `multi` is reset only after the
  // plan's own handlers have seen the last lift.
  const lift = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    screenTouch.down.delete(e.pointerId);
    if (screenTouch.down.size === 0) {
      setTimeout(() => {
        if (screenTouch.down.size === 0) screenTouch.multi = false;
      });
    }
  };
  window.addEventListener('pointerup', lift, { capture: true });
  window.addEventListener('pointercancel', lift, { capture: true });
}

/** How much of the plan a coast keeps on screen (px). */
const KEEP = 48;

export function PlanCanvas() {
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const project = useProject();
  const level = useLevel();
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
  const imageUrl = image.status === 'ready' ? image.url : null;
  const [ink, setInk] = useState<PixelBox | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured once per image
  useEffect(() => {
    setInk(null);
    if (image.status !== 'ready') return;
    let live = true;
    void inkBounds(image).then((b) => live && setInk(b));
    return () => {
      live = false;
    };
  }, [imageUrl]);
  const upload = useUploadPicker();
  const [dropping, setDropping] = useState(false);
  // Focus ring on the canvas: shown when Tab moved focus here, hidden on the next click.
  const [ring, setRing] = useState(false);
  const lastTab = useRef(0);
  const lastPointer = useRef(0);
  const v = view ?? { cx: 0, cy: 0, zoom: 50 };
  /** The view now: a fast drag can move again before React re-renders with the last move. */
  const liveView = () => useEditor.getState().view ?? v;

  const viewAdjusted = useEditor((s) => s.viewAdjusted);
  /** When the plan was last fitted, and what to: a resize soon after still refits. */
  const lastFit = useRef({ at: 0, ink: null as PixelBox | null, image: '' });
  // Fit on request, and while the pane settles or the plan image arrives, until the user
  // pans or zooms. Once settled, a resize (a phone's details panel opening) keeps the view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refit on size, request or image, not on every edit
  useEffect(() => {
    if ((!fitRequested && viewAdjusted) || !level || size.width === 0) return;
    const prev = lastFit.current;
    const resizedOnly = prev.ink === ink && prev.image === image.status;
    if (!fitRequested && resizedOnly && prev.at > 0 && Date.now() - prev.at > 1000) return;
    let b = levelBounds(level);
    if (!b && underlay && image.status === 'ready') {
      // Frame the drawing, not the whole page around it.
      const box = ink ?? { x0: 0, y0: 0, x1: image.width, y1: image.height };
      const corners = [
        { x: box.x0, y: box.y0 },
        { x: box.x1, y: box.y0 },
        { x: box.x1, y: box.y1 },
        { x: box.x0, y: box.y1 },
      ].map((p) => underlayToWorld(underlay, p));
      b = {
        min: { x: Math.min(...corners.map((c) => c.x)), y: Math.min(...corners.map((c) => c.y)) },
        max: { x: Math.max(...corners.map((c) => c.x)), y: Math.max(...corners.map((c) => c.y)) },
      };
    }
    setView(fitBounds(b, size));
    lastFit.current = { at: Date.now(), ink, image: image.status };
    fitDone();
  }, [fitRequested, viewAdjusted, size, image.status, ink, setView, fitDone]);

  // When the pane resizes (a phone's details panel folding or opening), the plan stays put
  // on screen: its top left keeps its place rather than everything shifting by half.
  const lastSize = useRef(size);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a resize only
  useEffect(() => {
    const prev = lastSize.current;
    lastSize.current = size;
    const cur = useEditor.getState().view;
    const settled = Date.now() - lastFit.current.at > 1000;
    if (!cur || prev.width === 0 || size.width === 0) return;
    if (!useEditor.getState().viewAdjusted && !settled) return; // still fitting
    const dx = size.width - prev.width;
    const dy = size.height - prev.height;
    if (dx === 0 && dy === 0) return;
    setView({ ...cur, cx: cur.cx + dx / 2 / cur.zoom, cy: cur.cy + dy / 2 / cur.zoom }, true);
  }, [size]);

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

  // ---- touch: a touch waits until it's clear what the finger is doing. A tap acts where the
  // finger lifts; a drag in a drawing tool previews under the finger and acts from where it
  // started to where it lifts; a second finger turns it into pinch-zoom and two-finger pan,
  // in every tool, without ever placing anything.
  const touches = useRef(new Map<number, Vec2>());
  /**
   * A finger pan let go while moving carries on and slows to a stop, as a map does: its speed
   * (screen px per ms, smoothed over the last moves) and when it last moved.
   */
  const fling = useRef<{ vx: number; vy: number; at: number; dist: number } | null>(null);
  const flingFrame = useRef<number | undefined>(undefined);
  const trackFling = (dx: number, dy: number) => {
    // A lift where the last move ended says nothing about the speed.
    if (dx === 0 && dy === 0) return;
    const now = performance.now();
    const f = fling.current;
    const dt = f ? Math.max(1, now - f.at) : 16;
    const k = f ? 0.7 : 1;
    fling.current = {
      vx: (f?.vx ?? 0) * (1 - k) + (dx / dt) * k,
      vy: (f?.vy ?? 0) * (1 - k) + (dy / dt) * k,
      at: now,
      dist: (f?.dist ?? 0) + Math.hypot(dx, dy),
    };
  };
  const stopFling = () => {
    if (flingFrame.current !== undefined) cancelAnimationFrame(flingFrame.current);
    flingFrame.current = undefined;
    fling.current = null;
  };
  const startFling = () => {
    const f = fling.current;
    fling.current = null;
    // Only a finger that really panned (not what's left of a pinch, lifting a frame after
    // the other) and is still moving as it lifts (not one that stopped, then lifted).
    if (!f || f.dist < 40 || performance.now() - f.at > 60 || Math.hypot(f.vx, f.vy) < 0.25) {
      return;
    }
    // No faster than a brisk flick (2.5 px/ms coasts about 800 px).
    const k = Math.min(1, 2.5 / Math.hypot(f.vx, f.vy));
    let vx = f.vx * k;
    let vy = f.vy * k;
    let last = performance.now();
    let mine = useEditor.getState().view;
    const step = (now: number) => {
      const cur = useEditor.getState().view ?? v;
      // Something else moved the view (Fit, a zoom button): it wins.
      if (cur !== mine) {
        flingFrame.current = undefined;
        return;
      }
      const dt = Math.min(32, now - last);
      last = now;
      const next = panBy(cur, vx * dt, vy * dt);
      // It stops before the plan leaves the screen: some of it (KEEP px, or all of a plan
      // smaller than that) stays in view, unless the coast is bringing it back.
      const lvl = currentLevel();
      const b = lvl && levelBounds(lvl);
      if (b) {
        const showing = (w: typeof next) => {
          const along = (lo: number, hi: number, c: number, span: number) => {
            const a = (lo - c) * w.zoom + span / 2;
            const z = (hi - c) * w.zoom + span / 2;
            // A plan flat this way (one straight wall): in view, or how far off.
            if (z - a < 1) return a >= 0 && a <= span ? 1 : -(a < 0 ? -a : a - span) / KEEP;
            const seen = Math.min(span, Math.max(a, z)) - Math.max(0, Math.min(a, z));
            return seen / Math.min(KEEP, Math.abs(z - a) || KEEP);
          };
          return Math.min(
            along(b.min.x, b.max.x, w.cx, size.width),
            along(b.min.y, b.max.y, w.cy, size.height),
          );
        };
        const after = showing(next);
        if (after < 1 && after < showing(cur)) {
          flingFrame.current = undefined;
          return;
        }
      }
      setView(next, true);
      mine = useEditor.getState().view;
      // Slows by about two thirds every 325 ms, as a phone's scrolling does.
      const decay = Math.exp(-dt / 325);
      vx *= decay;
      vy *= decay;
      flingFrame.current = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : undefined;
    };
    flingFrame.current = requestAnimationFrame(step);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: stopFling reads only refs
  useEffect(() => () => stopFling(), []);
  /** Tools whose finger drags (corners, walls, doors, pieces) are taken back on a cancel. */
  const takesBack =
    tool === 'select' ||
    tool === 'furniture' ||
    tool === 'door' ||
    tool === 'window' ||
    tool === 'passage';
  const touch = useRef<{
    start: PlanPointer;
    moved: boolean;
    /** Handed to the tool as a press (Select dragging a corner or door). */
    claimed: boolean;
    /** It stopped the plan coasting: a tap then does only that. */
    stopped?: boolean;
  } | null>(null);
  /** Whether the press now going down stopped a coast. */
  const stoppedCoast = useRef(false);
  const gesture = useRef<{ dist: number; mid: Vec2 } | null>(null);
  /** Where a finger placing a point is: the magnifier shows the plan under it. */
  const [loupe, setLoupe] = useState<Vec2 | null>(null);
  /** Whether a finger here places a point: drawing, or dragging a corner in Select. */
  const placesPoint = (start: PlanPointer, claimed: boolean) =>
    tool === 'wall' ||
    tool === 'room' ||
    tool === 'measure' ||
    tool === 'calibrate' ||
    (tool === 'select' && claimed && start.hit?.kind === 'vertex');
  /** A finger held still on a point shows the magnifier too, after a moment. */
  const loupeHold = useRef<number | undefined>(undefined);
  const hideLoupe = () => {
    window.clearTimeout(loupeHold.current);
    setLoupe(null);
  };
  // (Without useId's colons, which SVG url(#…) references don't take.)
  const sceneId = `plan-scene${useId().replace(/:/g, '')}`;
  const screenOf = (e: { clientX: number; clientY: number }): Vec2 => {
    const r = svgRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const twoFingers = () => {
    const [a, b] = [...touches.current.values()];
    if (!a || !b) return null;
    return {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  };
  const onTouchDown = (e: React.PointerEvent) => {
    // The first finger down: forget any touch whose lift never arrived.
    if (e.isPrimary) {
      touches.current.clear();
      gesture.current = null;
    }
    touches.current.set(e.pointerId, screenOf(e));
    if (touches.current.size >= 2) {
      hideLoupe();
      // A second finger: whatever the first one was starting is called off (a drag it had
      // begun is taken back).
      if (touch.current?.claimed && ctx) {
        if (takesBack) active.touchCancel?.();
        else active.up(touch.current.start);
      }
      touch.current = null;
      pan.current = null;
      gesture.current = twoFingers();
      return;
    }
    if (gesture.current) return; // still lifting fingers from a pinch
    const start = pointer(e);
    touch.current = { start, moved: false, claimed: false, stopped: stoppedCoast.current };
    // Held still on the spot it will place (or on a corner in Select): magnify it.
    window.clearTimeout(loupeHold.current);
    if (placesPoint(start, true)) {
      loupeHold.current = window.setTimeout(() => {
        if (touch.current?.start === start && !gesture.current) setLoupe(start.screen);
      }, 250);
    }
    // A finger on something a drawing tool lets you drag (a scale line's end) takes it at
    // once, so the smallest correction counts.
    if (ctx && active.grabs?.(start)) {
      touch.current = { start, moved: true, claimed: active.down(start) };
    }
  };
  const onTouchMove = (e: React.PointerEvent) => {
    if (!touches.current.has(e.pointerId)) return;
    touches.current.set(e.pointerId, screenOf(e));
    if (gesture.current) {
      const now = twoFingers();
      if (!now) return;
      const cur = useEditor.getState().view ?? v;
      const panned = panBy(
        cur,
        now.mid.x - gesture.current.mid.x,
        now.mid.y - gesture.current.mid.y,
      );
      setView(zoomAt(panned, size, now.mid, now.dist / gesture.current.dist), true);
      gesture.current = now;
      return;
    }
    const t = touch.current;
    if (!t || !ctx) return;
    const p = pointer(e);
    if (!t.moved && Math.hypot(p.screen.x - t.start.screen.x, p.screen.y - t.start.screen.y) < 8) {
      return;
    }
    if (!t.moved) {
      t.moved = true;
      if (tool === 'select') {
        // Dragging a corner or a door moves it; dragging anything else pans the plan,
        // without selecting what the finger started on.
        const kind = t.start.hit?.kind;
        // A wall moves only once selected: dragging another pans, as rooms do.
        const sel = useEditor.getState().selection;
        const selectedWall = kind === 'wall' && sel?.kind === 'wall' && sel.id === t.start.hit?.id;
        t.claimed =
          (kind === 'vertex' || kind === 'opening' || kind === 'item' || selectedWall) &&
          active.down(t.start);
        if (!t.claimed) {
          pan.current = t.start.screen;
          fling.current = null;
        }
      } else if (active.grabs?.(t.start)) {
        t.claimed = active.down(t.start);
      }
    }
    if (pan.current) {
      const dx = p.screen.x - pan.current.x;
      const dy = p.screen.y - pan.current.y;
      setView(panBy(liveView(), dx, dy), true);
      pan.current = p.screen;
      trackFling(dx, dy);
      return;
    }
    // Placing a point (drawing, or dragging a corner), the finger hides it: magnify it.
    window.clearTimeout(loupeHold.current);
    setLoupe(placesPoint(t.start, t.claimed) ? p.screen : null);
    // Drawing tools follow the finger as they follow a hovering mouse, and see where a drag
    // they'll get whole (touchDrag) began, to preview it.
    active.move(p, t.claimed, !t.claimed && active.touchDrag ? t.start : undefined);
  };
  const onTouchUp = (e: React.PointerEvent) => {
    // A busy page can merge a quick drag's moves into the lift: play its last stretch as a
    // move first, so a drag that arrived all at once is still a drag, not a tap.
    onTouchMove(e);
    hideLoupe();
    touches.current.delete(e.pointerId);
    if (gesture.current) {
      if (touches.current.size === 0) gesture.current = null;
      // One finger left of a pinch: it carries on moving the plan, as on a map.
      const [rest] = [...touches.current.values()];
      if (touches.current.size === 1 && rest) {
        gesture.current = null;
        touch.current = { start: pointer(e), moved: true, claimed: false };
        pan.current = rest;
        fling.current = { vx: 0, vy: 0, at: performance.now(), dist: 0 };
      }
      return;
    }
    const t = touch.current;
    touch.current = null;
    if (pan.current) {
      pan.current = null;
      startFling();
      return;
    }
    if (!t || !ctx) return;
    // Another finger was down somewhere: a pinch begun off the plan, not a tap or a drag.
    if (screenTouch.multi) {
      if (t.claimed && !takesBack) active.up(t.start);
      else active.touchCancel?.();
      return;
    }
    // A tap that stopped the plan coasting does only that, as on a phone's lists and maps.
    if (t.stopped && !t.moved && !t.claimed) return;
    const end = pointer(e);
    if (t.claimed) {
      active.up(end);
    } else if (t.moved && active.touchDrag) {
      active.touchDrag(t.start, end);
    } else {
      active.down(t.moved ? end : t.start);
      active.up(t.moved ? end : t.start);
    }
  };

  /** The system took the touch (a back swipe, a long press): end it without acting. */
  const onTouchCancel = (e: React.PointerEvent) => {
    hideLoupe();
    touches.current.delete(e.pointerId);
    if (touches.current.size === 0) gesture.current = null;
    const t = touch.current;
    touch.current = null;
    pan.current = null;
    // A drag it had begun is taken back; a tool without a way to do that just ends it.
    if (t?.claimed && ctx && !takesBack) active.up(t.start);
    else if (ctx) active.touchCancel?.();
  };

  // Pointer events don't reliably carry a click count, so detect double-clicks here.
  const lastDown = useRef({ t: 0, x: 0, y: 0 });
  const onPointerDown = (e: React.PointerEvent) => {
    stoppedCoast.current = flingFrame.current !== undefined;
    stopFling();
    lastPointer.current = Date.now();
    setRing(false);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (e.pointerType === 'touch') {
      onTouchDown(e);
      return;
    }
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
    if (e.pointerType === 'touch') {
      onTouchMove(e);
      return;
    }
    const p = pointer(e);
    if (pan.current) {
      setView(panBy(liveView(), p.screen.x - pan.current.x, p.screen.y - pan.current.y), true);
      pan.current = p.screen;
      return;
    }
    if (ctx) active.move(p, toolDrag.current);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') {
      onTouchUp(e);
      return;
    }
    if (pan.current) {
      pan.current = null;
      setPanning(false);
      return;
    }
    if (toolDrag.current && ctx) active.up(pointer(e));
    toolDrag.current = false;
  };

  // ---- wheel: pinch or ctrl+wheel zooms; trackpad scroll pans; a mouse wheel zooms
  // biome-ignore lint/correctness/useExhaustiveDependencies: stopFling reads only refs
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stopFling();
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
  const north = siteOf(project).north;

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
        onPointerCancel={(e) => (e.pointerType === 'touch' ? onTouchCancel(e) : onPointerUp(e))}
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
        <g id={sceneId}>
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
            <PlanShapes
              level={level}
              geom={geom}
              interactive={
                tool === 'select'
                  ? true
                  : tool === 'furniture'
                    ? 'items'
                    : tool === 'door' || tool === 'window' || tool === 'passage'
                      ? 'openings'
                      : false
              }
            />
            <RenovationMarks />
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
        </g>
        {loupe && <Loupe at={loupe} size={size} scene={sceneId} />}
      </svg>

      <p id="plan-keys" className="visually-hidden">
        In Select, Tab moves through rooms, walls, openings and corners; Escape then Shift+Tab
        leaves the plan. Arrow keys nudge the selected corner, wall, opening, piece or room by 1 cm,
        or 10 cm with Shift, and otherwise pan the plan.
      </p>
      <p className="visually-hidden" aria-live="polite">
        {describe(level, selection)}
      </p>

      {/* Out of the way as soon as a drawing tool is picked, so it never blocks a click. */}
      {empty && !underlay && (tool === 'select' || tool === 'measure') && (
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
          <p className="field-hint">Or drop a JPG, PNG or PDF here, or try a sample:</p>
          <div className="button-row">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => upload.sample('drawn')}
              disabled={upload.busy}
            >
              Simple drawn plan
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => upload.sample('hdb')}
              disabled={upload.busy}
            >
              HDB plan (PDF)
            </button>
          </div>
          {upload.error && <p className="field-hint error-text">{upload.error}</p>}
          {upload.picker}
        </div>
      )}

      {/* Only in Select: the drawing tools' bars and notices take the top of the plan. */}
      {!empty && tool === 'select' && (
        <button
          type="button"
          className="plan-compass"
          aria-label={`${describeNorth(north)}. Set which way the plan faces`}
          title="Which way the plan faces"
          onClick={() => useEditor.getState().revealDirection()}
        >
          <Compass north={north} size={36} />
        </button>
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

/** How much the magnifier enlarges, and its radius (screen px). */
const LOUPE_ZOOM = 2.5;
const LOUPE_R = 52;

/**
 * A magnifier above the finger: the plan around the point it is placing, enlarged, with a
 * crosshair on the point. Near the top it moves to a top corner, and keeps to the screen.
 */
function Loupe({ at, size, scene }: { at: Vec2; size: Size; scene: string }) {
  const clip = `loupe${useId().replace(/:/g, '')}`;
  const gap = LOUPE_R + 44;
  const edge = LOUPE_R + 6;
  const clamp = (n: number, max: number) => Math.min(max - edge, Math.max(edge, n));
  const above = at.y - gap >= edge;
  // Above the finger; with no room there, in the top corner away from it, clear of the wall
  // being drawn and its length.
  const x = above ? clamp(at.x, size.width) : at.x < size.width / 2 ? size.width - edge : edge;
  const y = above ? at.y - gap : edge;
  return (
    <g className="loupe" pointerEvents="none" data-testid="loupe">
      <clipPath id={clip}>
        <circle cx={x} cy={y} r={LOUPE_R} />
      </clipPath>
      <circle cx={x} cy={y} r={LOUPE_R} className="loupe-bg" />
      <g clipPath={`url(#${clip})`}>
        <use
          href={`#${scene}`}
          transform={`translate(${x} ${y}) scale(${LOUPE_ZOOM}) translate(${-at.x} ${-at.y})`}
        />
      </g>
      <circle cx={x} cy={y} r={LOUPE_R} className="loupe-ring" />
      <path
        d={`M ${x - 10} ${y} H ${x + 10} M ${x} ${y - 10} V ${y + 10}`}
        className="loupe-cross"
      />
    </g>
  );
}
