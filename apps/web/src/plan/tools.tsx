import {
  type Axis,
  type Command,
  type DispatchOptions,
  type Item,
  type Level,
  type PlanGeometry,
  type RoomMove,
  type ShiftIds,
  type Vec2,
  addItem,
  deleteItem,
  deleteOpening,
  deleteVertex,
  deleteWall,
  duplicateOf,
  framePoint,
  furnitureKind,
  itemFootprint,
  itemSize,
  moveRoom,
  moveTowards,
  moveVertex,
  newId,
  openingClearances,
  openingSpan,
  placeFurniture,
  planRoomMove,
  roomJoined,
  settleVertex,
  shiftBlocked,
  shiftIds,
  shiftWall,
  snapCorner,
  splitWall,
  updateItem,
  updateOpening,
} from '@dhd/core';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type Selection, type Tool, useEditor } from '../editor';
import { currentLevel, useStore } from '../store';
import { formatLength } from '../units';
import { cycle, movedVertices, nudge, objectPoint, planObjects } from './keyboard';
import { roomHandleAt } from './layers';
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
  /**
   * The pointer moved. `dragFrom` is where a finger drag that will end in `touchDrag`
   * started, so a tool can preview from there before the finger lifts (a first wall, a room).
   */
  move: (p: PlanPointer, dragging: boolean, dragFrom?: PlanPointer) => void;
  up: (p: PlanPointer) => void;
  key: (e: KeyboardEvent) => boolean;
  overlay: (ctx: ToolContext) => ReactNode;
  cursor: string;
  /**
   * A one-finger drag on a touch screen, from `start` to where the finger lifted. Tools that
   * draw between two points take both (a wall or room corner to corner, a scale line end to
   * end); without this, the drag acts as a tap where the finger lifted.
   */
  touchDrag?: (start: PlanPointer, end: PlanPointer) => void;
  /**
   * Whether a touch drag starting at `p` grabs something the tool lets you drag (a scale
   * line's end), so the drag goes to down, move and up as with a mouse instead.
   */
  grabs?: (p: PlanPointer) => boolean;
  /** A finger drag ended without acting (the system took the touch): drop its preview. */
  touchCancel?: () => void;
}

export const TOOL_HINTS: Record<Tool, string> = {
  select:
    'Tap or click to select; drag a corner or a door to move it, or a selected room by its handle. Tab and the arrow keys work too; double-click a wall to add a corner.',
  wall: 'Tap or click each corner, or drag from corner to corner. Type a length for an exact wall. Drag an end of the wall you just drew to adjust it. Joining an existing wall, or Done, finishes.',
  room: 'Drag from one corner to the opposite one, or tap both, to draw a rectangular room.',
  door: 'Pick a width, then tap or click a wall to add a door.',
  window: 'Pick a width, then tap or click a wall to add a window.',
  passage: 'Pick a width, then tap or click a wall to add an opening.',
  measure: 'Tap both ends, or drag between them, to measure.',
  furniture:
    'Pick a piece, then tap or click to place it. Near a wall it backs onto it. Turn it in its details, or with R.',
  calibrate:
    'Tap both ends of a length you know on the plan image, or drag along it, then enter the real length.',
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
  | {
      kind: 'item';
      id: string;
      start: Vec2;
      grab: Vec2;
      /** Its turn when picked up: kept wherever no wall turns it. */
      turn: number;
      moved: boolean;
      key: string;
    }
  | { kind: 'opening'; id: string; wallId: string; start: Vec2; moved: boolean; key: string }
  /** A selected wall, moved sideways: its ends start at a and b, it moves along n. */
  | {
      kind: 'wall';
      id: string;
      a: Vec2;
      b: Vec2;
      n: Vec2;
      from: Vec2;
      offset: number;
      /** The level as the drag began: each move is applied to it afresh. */
      level: Level;
      ids: ShiftIds;
      /** A second click that never moves splits the wall there, as a double-click does. */
      split?: Vec2;
      start: Vec2;
      moved: boolean;
      key: string;
    }
  /** A corner handle of a selected piece: resizes it, the opposite corner staying put. */
  | {
      kind: 'resize';
      id: string;
      /** The opposite corner, where it was when the drag began: it stays put. */
      anchor: Vec2;
      /** A back corner of a piece against a wall: its back stays on the wall (this depth). */
      keepDepth?: number;
      start: Vec2;
      moved: boolean;
      key: string;
    }
  /** The turn handle in front of a selected piece. */
  | { kind: 'rotate'; id: string; start: Vec2; moved: boolean; key: string }
  /** A selected room's move handle: the room and what it carries move together. */
  | {
      kind: 'room';
      id: string;
      /** Where the pointer and the handle were as the drag began (plan metres). */
      from: Vec2;
      handle: Vec2;
      delta: Vec2;
      /** The level as the drag began: each move is applied to it afresh. */
      level: Level;
      /** Joined to other rooms: it moves along one axis at a time. */
      joined: boolean;
      move: RoomMove;
      start: Vec2;
      moved: boolean;
      key: string;
    };

/** How far in front of a selected piece (screen px) its turn handle sits. */
const TURN_HANDLE_GAP = 30;

/**
 * The handles of a selected piece of furniture, on screen: its four corners (back-left,
 * back-right, front-right, front-left) and the turn handle in front of it.
 */
function itemHandles(ctx: ToolContext, it: Item) {
  const f = itemFootprint(it);
  const corners = f.map((q) => worldToScreen(ctx.view, ctx.size, q));
  const [, , fr, fl] = corners;
  const mid = { x: ((fr?.x ?? 0) + (fl?.x ?? 0)) / 2, y: ((fr?.y ?? 0) + (fl?.y ?? 0)) / 2 };
  const c = worldToScreen(ctx.view, ctx.size, { x: it.position.x, y: it.position.z });
  const n = Math.hypot(mid.x - c.x, mid.y - c.y) || 1;
  const out = { x: (mid.x - c.x) / n, y: (mid.y - c.y) / n };
  const turn = { x: mid.x + out.x * TURN_HANDLE_GAP, y: mid.y + out.y * TURN_HANDLE_GAP };
  // The size, shown while resizing, behind the piece: clear of the turn handle in front.
  const back = { x: 2 * c.x - mid.x, y: 2 * c.y - mid.y };
  const label = { x: back.x - out.x * 28, y: back.y - out.y * 28 };
  return { corners, mid, turn, label };
}

/** A piece's shorter side on screen (px). */
const shortSide = (corners: Vec2[]) => {
  const [a, b, c] = corners;
  if (!a || !b || !c) return 0;
  return Math.min(Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(c.x - b.x, c.y - b.y));
};

/**
 * True when a press lands on a selected piece's drawn handle (not merely within reach): a
 * tap there in Furniture is meant for the handle, so it places nothing.
 */
export function onDrawnHandle(ctx: ToolContext, p: PlanPointer): boolean {
  const sel = useEditor.getState().selection;
  const it = sel?.kind === 'item' ? ctx.level.items[sel.id] : undefined;
  if (!it) return false;
  const h = itemHandles(ctx, it);
  const near = (q: Vec2 | undefined, r: number) =>
    !!q && Math.hypot(q.x - p.screen.x, q.y - p.screen.y) <= r;
  return near(h.turn, 11) || h.corners.some((q) => near(q, HANDLE_SIZE * 0.75));
}

/** How near (screen px) a press must land to a selected room's move handle. */
const ROOM_HANDLE_REACH = 18;

/** A selected room's move handle on screen, if a room is selected. */
function roomHandle(ctx: ToolContext): { id: string; at: Vec2 } | null {
  const sel = useEditor.getState().selection;
  if (sel?.kind !== 'room') return null;
  const at = roomHandleAt(ctx.level, ctx.geom, ctx.view.zoom, sel.id);
  return at ? { id: sel.id, at: worldToScreen(ctx.view, ctx.size, at) } : null;
}

/** The drawn handle's radius (screen px): a press on it beats a piece of furniture under it. */
const ROOM_HANDLE_RADIUS = 13;

/** Whether a press lands on the selected room's move handle (a corner or door comes first). */
function onRoomHandle(ctx: ToolContext, p: PlanPointer): string | null {
  if (p.hit && (p.hit.kind === 'vertex' || p.hit.kind === 'opening')) return null;
  const h = roomHandle(ctx);
  const dist = h ? Math.hypot(h.at.x - p.screen.x, h.at.y - p.screen.y) : Number.POSITIVE_INFINITY;
  const reach = p.hit?.kind === 'item' ? ROOM_HANDLE_RADIUS : ROOM_HANDLE_REACH;
  return h && dist <= reach ? h.id : null;
}

/** One room-move step for the arrow keys: `delta` metres, or none if a wall is in the way. */
function nudgeRoom(level: Level, id: string, delta: Vec2): Command | null {
  const axis: Axis | null = !roomJoined(level, id) ? null : delta.x !== 0 ? 'x' : 'y';
  const move = planRoomMove(level, id, axis);
  if (move.vertices.length === 0 && move.steps.length === 0) return null;
  const to = moveTowards(level, move, { x: 0, y: 0 }, delta);
  return Math.hypot(to.x, to.y) < 1e-9 ? null : moveRoom(level, move, to);
}

/**
 * The axis a joined room's drag follows: the way the pointer has gone further, keeping the
 * current one until the other is clearly ahead, so a drag near the diagonal doesn't flicker.
 */
function dragAxis(raw: Vec2, current: Axis | null): Axis {
  const ax = Math.abs(raw.x);
  const ay = Math.abs(raw.y);
  if (current === 'x') return ay > ax * 1.25 + 0.02 ? 'y' : 'x';
  if (current === 'y') return ax > ay * 1.25 + 0.02 ? 'x' : 'y';
  return ax >= ay ? 'x' : 'y';
}

interface NudgeRun {
  sel: Selection;
  key: string;
  vertices: string[];
  timer: number;
}

/** Settle a run of arrow-key nudges this long after the last press. */
const NUDGE_SETTLE_MS = 500;

export function useSelectTool(ctx: ToolContext): ToolController {
  const drag = useRef<Drag | null>(null);
  const { select, setHover } = useEditor.getState();
  const levelId = ctx.level.id;
  const latest = useRef(ctx);
  latest.current = ctx;
  const run = useRef<NudgeRun | null>(null);
  const live = () => currentLevel() ?? latest.current.level;

  /**
   * Ends a run of nudges: merges or splits where the moved corners came to rest, once, like
   * the end of a drag, in the run's undo step. A corner merged into another stays selected
   * under its surviving id.
   */
  const settleRun = () => {
    const r = run.current;
    if (!r) return;
    run.current = null;
    window.clearTimeout(r.timer);
    const at = r.sel.kind === 'vertex' ? live().vertices[r.sel.id] : undefined;
    for (const id of r.vertices) {
      const level = live();
      if (level.vertices[id]) {
        latest.current.dispatch(settleVertex(level, id), { coalesceKey: r.key });
      }
    }
    const level = live();
    const cur = useEditor.getState().selection;
    if (!cur || cur.kind !== r.sel.kind || cur.id !== r.sel.id) return;
    if (r.sel.kind === 'vertex' && !level.vertices[r.sel.id]) {
      const survivor =
        at && Object.values(level.vertices).find((v) => Math.hypot(v.x - at.x, v.y - at.y) < 1e-3);
      select(survivor ? { kind: 'vertex', id: survivor.id } : null);
    } else if (r.sel.kind === 'wall' && !level.walls[r.sel.id]) {
      select(null);
    }
  };
  /**
   * The handle of the selected piece under the pointer, if any. A corner, a door or another
   * piece under the pointer comes first; on the piece itself, only the drawn handle counts,
   * so a small piece can still be dragged by its body.
   */
  const handleAt = (p: PlanPointer): { id: string; corner: number | 'turn' } | null => {
    const sel = useEditor.getState().selection;
    const it = sel?.kind === 'item' ? ctx.level.items[sel.id] : undefined;
    if (!sel || !it) return null;
    const hit = p.hit;
    if (hit && (hit.kind === 'vertex' || hit.kind === 'opening')) return null;
    if (hit?.kind === 'item' && hit.id !== sel.id) return null;
    const h = itemHandles(ctx, it);
    const dist = (q: Vec2 | undefined) =>
      q ? Math.hypot(q.x - p.screen.x, q.y - p.screen.y) : Number.POSITIVE_INFINITY;
    if (dist(h.turn) <= HANDLE_REACH) return { id: sel.id, corner: 'turn' };
    // On the piece itself, a corner counts only on its drawn square, and on a piece small
    // on screen only right at the corner, so the middle of its body is still there to drag.
    const onPiece = hit?.kind === 'item';
    const reach = onPiece ? Math.min(HANDLE_SIZE * 0.75, shortSide(h.corners) / 3) : HANDLE_REACH;
    const i = h.corners.findIndex((q) => dist(q) <= reach);
    return i < 0 ? null : { id: sel.id, corner: i };
  };
  // A finished resize clears its size label: the drag lives in a ref, so say so.
  const [, redraw] = useState(0);
  /**
   * Takes a drag back: only if it recorded a step (one that changed nothing, a turn still on
   * its 15° step, left none, and the step before it is someone else's).
   */
  const cancelDrag = (d: Drag) => {
    const { editor, undo } = useStore.getState();
    if (editor.history.past.at(-1)?.coalesceKey === d.key) undo();
    redraw((n) => n + 1);
  };

  // Settle a pending run when the tool goes away (switching tools mid-run).
  // biome-ignore lint/correctness/useExhaustiveDependencies: settleRun reads only refs
  useEffect(() => () => settleRun(), []);

  return {
    cursor: 'default',
    // On a touch screen, a finger on a selected piece's handle takes it at once.
    grabs: (p) => handleAt(p) !== null || onRoomHandle(ctx, p) !== null,
    // The system took the touch, or a second finger came down to pinch: take the drag back.
    touchCancel: () => {
      const d = drag.current;
      drag.current = null;
      if (d) cancelDrag(d);
    },
    down: (p) => {
      settleRun();
      const handle = handleAt(p);
      if (handle) {
        const key = `handle:${handle.id}:${Date.now()}`;
        const it = ctx.level.items[handle.id];
        const anchor =
          it && handle.corner !== 'turn' ? itemFootprint(it)[(handle.corner + 2) % 4] : undefined;
        const keepDepth =
          it?.flags.snapWall && (handle.corner === 0 || handle.corner === 1)
            ? itemSize(it).d
            : undefined;
        drag.current = anchor
          ? { kind: 'resize', id: handle.id, anchor, keepDepth, start: p.screen, moved: false, key }
          : { kind: 'rotate', id: handle.id, start: p.screen, moved: false, key };
        return true;
      }
      const roomId = onRoomHandle(ctx, p);
      const handleAtStart = roomId && roomHandleAt(ctx.level, ctx.geom, ctx.view.zoom, roomId);
      if (roomId && handleAtStart) {
        const joined = roomJoined(ctx.level, roomId);
        drag.current = {
          kind: 'room',
          id: roomId,
          from: p.world,
          handle: handleAtStart,
          delta: { x: 0, y: 0 },
          level: ctx.level,
          joined,
          move: planRoomMove(ctx.level, roomId, joined ? 'x' : null),
          start: p.screen,
          moved: false,
          key: `drag:${roomId}:${Date.now()}`,
        };
        return true;
      }
      const h = p.hit;
      if (!h) {
        select(null);
        return false;
      }
      // A wall already selected moves sideways when dragged (its joined walls follow).
      const before = useEditor.getState().selection;
      if (h.kind === 'wall' && before?.kind === 'wall' && before.id === h.id) {
        const w = ctx.level.walls[h.id];
        const a = w && ctx.level.vertices[w.a];
        const b = w && ctx.level.vertices[w.b];
        const len = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
        if (a && b && len > 1e-9) {
          drag.current = {
            kind: 'wall',
            id: h.id,
            a: { x: a.x, y: a.y },
            b: { x: b.x, y: b.y },
            n: { x: -(b.y - a.y) / len, y: (b.x - a.x) / len },
            from: p.world,
            offset: 0,
            level: ctx.level,
            ids: shiftIds(ctx.level, h.id),
            split: p.clicks === 2 ? p.world : undefined,
            start: p.screen,
            moved: false,
            key: `drag:${h.id}:${Date.now()}`,
          };
          return true;
        }
      }
      if (h.kind === 'wall' && p.clicks === 2) {
        const r = splitWall(levelId, h.id, p.world, ctx.level);
        ctx.dispatch(r.command);
        select({ kind: 'vertex', id: r.vertexId });
        return true;
      }
      select(h);
      if (h.kind === 'room' && p.clicks === 2) {
        // After this press's default action, which focuses the canvas, has run.
        window.setTimeout(() => useEditor.getState().requestRename(), 0);
        return true;
      }
      // Rooms and walls select on press, but dragging from them pans (rooms cover the plan).
      if (h.kind === 'room' || h.kind === 'wall') return false;
      const key = `drag:${h.id}:${Date.now()}`;
      if (h.kind === 'vertex') {
        drag.current = { kind: 'vertex', id: h.id, start: p.screen, moved: false, key };
      } else if (h.kind === 'item') {
        const it = ctx.level.items[h.id];
        // Where on the piece it was picked up, so it doesn't jump to centre on the pointer.
        if (it)
          drag.current = {
            kind: 'item',
            id: h.id,
            start: p.screen,
            grab: { x: p.world.x - it.position.x, y: p.world.y - it.position.z },
            turn: it.rotationY,
            moved: false,
            key,
          };
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
      if (d.kind === 'resize' || d.kind === 'rotate') {
        const it = ctx.level.items[d.id];
        if (!it) return;
        if (d.kind === 'rotate') {
          // The piece turns to face the pointer, in 15° steps unless Alt is held.
          const v = { x: p.world.x - it.position.x, y: p.world.y - it.position.z };
          let r = Math.atan2(-v.x, v.y);
          if (!p.alt) r = Math.round(r / (Math.PI / 12)) * (Math.PI / 12);
          ctx.dispatch(updateItem(levelId, d.id, { rotationY: r }), { coalesceKey: d.key });
          return;
        }
        const kind = furnitureKind(it.assetId);
        const base = kind?.size ?? { w: 0.5, d: 0.5, h: 0.5 };
        const opp = d.anchor;
        const c = Math.cos(it.rotationY);
        const s = Math.sin(it.rotationY);
        const v = { x: p.world.x - opp.x, y: p.world.y - opp.y };
        const lx = v.x * c + v.y * s;
        const ly = -v.x * s + v.y * c;
        const step = p.alt ? 0.001 : 0.01;
        const w = Math.max(0.1, Math.round(Math.abs(lx) / step) * step);
        const dd = d.keepDepth ?? Math.max(0.1, Math.round(Math.abs(ly) / step) * step);
        const hx = (Math.sign(lx) || 1) * (w / 2);
        // Against a wall, the back corner moves only along it: the back stays on the wall.
        const hy = d.keepDepth ? -dd / 2 : (Math.sign(ly) || 1) * (dd / 2);
        const centre = { x: opp.x + hx * c - hy * s, y: opp.y + hx * s + hy * c };
        ctx.dispatch(
          updateItem(levelId, d.id, {
            scale: { x: w / base.w, z: dd / base.d },
            position: { x: centre.x, z: centre.y },
          }),
          { coalesceKey: d.key },
        );
        return;
      }
      if (d.kind === 'room') {
        // In 1 cm steps (1 mm with Alt), towards the pointer until a wall is in the way, then
        // sliding along it.
        // A joined room goes along the axis the pointer has gone further, starting afresh from
        // where it began when that changes.
        const step = p.alt ? 0.001 : 0.01;
        const raw = { x: p.world.x - d.from.x, y: p.world.y - d.from.y };
        const want = { x: Math.round(raw.x / step) * step, y: Math.round(raw.y / step) * step };
        let have = d.delta;
        if (d.joined) {
          const axis = dragAxis(raw, d.moved && have.x === 0 && have.y === 0 ? null : d.move.axis);
          if (axis !== d.move.axis) {
            d.move = planRoomMove(d.level, d.id, axis);
            have = { x: 0, y: 0 };
          }
        }
        const to = moveTowards(d.level, d.move, have, want);
        if (Math.hypot(to.x - d.delta.x, to.y - d.delta.y) < 1e-9) return;
        d.delta = to;
        ctx.dispatch(moveRoom(d.level, d.move, to), { coalesceKey: d.key });
        return;
      }
      if (d.kind === 'wall') {
        const raw = (p.world.x - d.from.x) * d.n.x + (p.world.y - d.from.y) * d.n.y;
        const step = p.alt ? 0.001 : 0.01;
        const want = Math.round(raw / step) * step;
        // Towards the pointer in small steps, stopping short of a wall in the way (or of a
        // joined wall vanishing): one move never jumps through another wall.
        let off = d.offset;
        const dir = Math.sign(want - off);
        const inc = Math.min(step, 0.01);
        while (dir !== 0 && (want - off) * dir > 1e-9) {
          const next = dir > 0 ? Math.min(want, off + inc) : Math.max(want, off - inc);
          if (shiftBlocked(d.level, d.id, next)) break;
          off = next;
        }
        if (Math.abs(off - d.offset) < 1e-9 && d.offset !== 0) return;
        d.offset = off;
        ctx.dispatch(shiftWall(d.level, d.id, off, d.ids), { coalesceKey: d.key });
        return;
      }
      if (d.kind === 'vertex') {
        const to = p.alt
          ? p.world
          : snapCorner(ctx.level, d.id, p.world, { tolerance: snapTolerance(ctx), grid: 0.05 });
        ctx.dispatch(moveVertex(levelId, d.id, to), { coalesceKey: d.key });
      } else if (d.kind === 'item') {
        const it = ctx.level.items[d.id];
        const kind = it && furnitureKind(it.assetId);
        if (!it) return;
        const want = gridSnap({ x: p.world.x - d.grab.x, y: p.world.y - d.grab.y }, 0.05, p.alt);
        // A piece that stands against a wall backs onto one it's dragged near.
        const spot =
          kind && it.flags.snapWall && !p.alt
            ? placeFurniture(ctx.geom, kind, want, d.turn, itemSize(it, kind))
            : { at: want, rotation: d.turn };
        ctx.dispatch(
          updateItem(levelId, d.id, {
            position: { x: spot.at.x, z: spot.at.y },
            rotationY: spot.rotation,
          }),
          { coalesceKey: d.key },
        );
      } else {
        const f = ctx.geom.frames[d.wallId];
        if (!f) return;
        const op = ctx.level.openings[d.id];
        if (!op) return;
        const u = (p.world.x - f.a.x) * f.d.x + (p.world.y - f.a.y) * f.d.y;
        const step = p.alt ? 0.001 : 0.05;
        // Kept between the wall's inside corners: never into a wall joining it.
        const lo = Math.max(f.left[0], f.right[0], 0) + op.width / 2;
        const hi = Math.min(f.left[1], f.right[1], f.length) - op.width / 2;
        const snapped = Math.round(u / step) * step;
        const at = hi >= lo ? Math.min(hi, Math.max(lo, snapped)) : f.length / 2;
        const t = Math.min(1, Math.max(0, at / f.length));
        ctx.dispatch(updateOpening(levelId, d.id, { t }), { coalesceKey: d.key });
      }
    },
    up: () => {
      const d = drag.current;
      drag.current = null;
      // Labels drawn from the drag (sizes, clearances) go with it.
      if (d?.moved) redraw((n) => n + 1);
      if (d?.kind === 'vertex' && d.moved) {
        // Merge, split and re-detect rooms once, at the end of the drag, in the same undo step.
        const level = currentLevel();
        if (level) ctx.dispatch(settleVertex(level, d.id), { coalesceKey: d.key });
      }
      if (d?.kind === 'wall' && !d.moved && d.split) {
        const r = splitWall(levelId, d.id, d.split, ctx.level);
        ctx.dispatch(r.command);
        select({ kind: 'vertex', id: r.vertexId });
      }
      if (d?.kind === 'room' && d.moved && Math.hypot(d.delta.x, d.delta.y) < 1e-9) {
        // Back where it began: nothing to keep.
        cancelDrag(d);
        return;
      }
      if (d?.kind === 'wall' && d.moved) {
        // Back where it began: nothing to keep.
        if (Math.abs(d.offset) < 1e-9) {
          cancelDrag(d);
          return;
        }
        const w = currentLevel()?.walls[d.id];
        for (const id of w ? [w.a, w.b] : []) {
          const level = currentLevel();
          if (level?.vertices[id]) ctx.dispatch(settleVertex(level, id), { coalesceKey: d.key });
        }
        // Dropped onto a wall already there, it merged into it: nothing left to select.
        if (!currentLevel()?.walls[d.id]) select(null);
      }
    },
    key: (e) => {
      // Escape mid-drag on a handle takes the drag back; the rest of it does nothing.
      const d = drag.current;
      if (
        e.key === 'Escape' &&
        (d?.kind === 'resize' || d?.kind === 'rotate' || d?.kind === 'wall' || d?.kind === 'room')
      ) {
        drag.current = null;
        cancelDrag(d);
        return true;
      }
      const arrow = ARROWS[e.key];
      if (!arrow) settleRun();
      const sel = useEditor.getState().selection;
      if (
        run.current &&
        (!sel || sel.kind !== run.current.sel.kind || sel.id !== run.current.sel.id)
      )
        settleRun();
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
      if (arrow && (onCanvas || e.target === document.body) && !e.ctrlKey && !e.metaKey) {
        // Corners, walls, openings, furniture and rooms move; with nothing selected, arrows pan.
        if (!sel) {
          const px = e.shiftKey ? 200 : 40;
          useEditor.getState().setView(panBy(ctx.view, -arrow.x * px, -arrow.y * px), true);
          return true;
        }
        // Read the live document: key repeat can outrun React's re-render. 1 cm per press,
        // 10 cm with Shift. Corners only move during a run; they merge or split once it ends.
        const step = e.shiftKey ? 0.1 : 0.01;
        const delta = { x: arrow.x * step, y: arrow.y * step };
        const moveBy = sel.kind === 'room' ? nudgeRoom(live(), sel.id, delta) : null;
        const cmds = sel.kind === 'room' ? (moveBy ? [moveBy] : []) : nudge(live(), sel, delta);
        if (cmds.length === 0) return true; // e.g. a door nudged across its wall, a room into one
        if (!run.current) {
          run.current = {
            sel,
            key: `nudge:${sel.id}:${Date.now()}`,
            vertices: movedVertices(live(), sel),
            timer: 0,
          };
        }
        const r = run.current;
        for (const cmd of cmds) ctx.dispatch(cmd, { coalesceKey: r.key });
        // Keep what's being nudged on screen.
        const at = objectPoint(live(), sel);
        if (at) useEditor.getState().setView(reveal(ctx.view, ctx.size, at), true);
        window.clearTimeout(r.timer);
        r.timer = window.setTimeout(settleRun, NUDGE_SETTLE_MS);
        return true;
      }
      // Ctrl/Cmd+D: a copy beside the selected piece, selected to place it.
      if ((e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey) && sel?.kind === 'item') {
        const it = live().items[sel.id];
        if (!it) return false;
        const copy = duplicateOf(it, newId('it'));
        ctx.dispatch(addItem(levelId, copy));
        select({ kind: 'item', id: copy.id });
        return true;
      }
      if ((e.key === 'r' || e.key === 'R') && sel?.kind === 'item' && !e.ctrlKey && !e.metaKey) {
        const it = live().items[sel.id];
        if (!it) return false;
        const quarter = (e.shiftKey ? -1 : 1) * (Math.PI / 2);
        ctx.dispatch(updateItem(levelId, sel.id, { rotationY: it.rotationY + quarter }));
        return true;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        const cmd =
          sel.kind === 'item'
            ? deleteItem(
                levelId,
                sel.id,
                furnitureKind(live().items[sel.id]?.assetId ?? '')?.name.toLowerCase(),
              )
            : sel.kind === 'wall'
              ? deleteWall(levelId, sel.id, ctx.level)
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
    overlay: (o) => {
      const sel = useEditor.getState().selection;
      const dw = drag.current;
      if (dw?.kind === 'wall' && dw.moved) {
        // How far the wall has moved, beside its middle on the side it moves to.
        const mid = {
          x: (dw.a.x + dw.b.x) / 2 + dw.n.x * dw.offset,
          y: (dw.a.y + dw.b.y) / 2 + dw.n.y * dw.offset,
        };
        const s = worldToScreen(o.view, o.size, mid);
        const side = dw.offset < 0 ? -1 : 1;
        const t = worldToScreen(o.view, o.size, {
          x: mid.x + dw.n.x * side * 0.1,
          y: mid.y + dw.n.y * side * 0.1,
        });
        const k = Math.hypot(t.x - s.x, t.y - s.y) || 1;
        // Clear of the wall whichever way it runs, and inside the plan.
        const at = {
          x: Math.min(o.size.width - 40, Math.max(40, s.x + ((t.x - s.x) / k) * 48)),
          y: Math.min(o.size.height - 16, Math.max(16, s.y + ((t.y - s.y) / k) * 48)),
        };
        const off = Math.abs(dw.offset);
        // A move in millimetres (Alt) says so; whole centimetres read as metres.
        const fine = Math.abs(off * 100 - Math.round(off * 100)) > 1e-6;
        return (
          <g
            className="handle-length wall-shift"
            pointerEvents="none"
            transform={`translate(${at.x} ${at.y})`}
          >
            <rect x={-34} y={-11} width={68} height={22} rx={4} />
            <text textAnchor="middle" y={4} className="num">
              {fine ? `${Math.round(off * 1000)} mm` : formatLength(off)}
            </text>
          </g>
        );
      }
      if (dw?.kind === 'opening' && dw.moved) return <OpeningClearances ctx={o} id={dw.id} />;
      if (dw?.kind === 'room') return <RoomMoveHandle ctx={o} drag={dw} />;
      if (sel?.kind === 'room') return <RoomMoveHandle ctx={o} />;
      const it = sel?.kind === 'item' ? o.level.items[sel.id] : undefined;
      if (!it) return null;
      const h = itemHandles(o, it);
      const size = itemSize(it);
      const d = drag.current;
      const resizing = d?.kind === 'resize' && d.moved;
      return (
        <g className="item-handles" pointerEvents="none">
          <line x1={h.mid.x} y1={h.mid.y} x2={h.turn.x} y2={h.turn.y} className="turn-stem" />
          <circle cx={h.turn.x} cy={h.turn.y} r={8} className="turn-handle" />
          {h.corners.map((q, i) => (
            <rect
              key={CORNER_NAMES[i]}
              x={q.x - HANDLE_SIZE / 2}
              y={q.y - HANDLE_SIZE / 2}
              width={HANDLE_SIZE}
              height={HANDLE_SIZE}
              className="size-handle"
            />
          ))}
          {resizing && (
            <g transform={`translate(${h.label.x} ${h.label.y})`} className="handle-length">
              <rect x={-52} y={-11} width={104} height={22} rx={4} />
              <text textAnchor="middle" y={4} className="num">
                {`${formatLength(size.w)} × ${formatLength(size.d)}`}
              </text>
            </g>
          )}
        </g>
      );
    },
  };
}

/**
 * While a door or window is dragged: the clear wall left on each side of it, to the inside
 * corners, drawn as a dimension just off the wall.
 */
/** The four-way arrow drawn in a room's move handle, centred on 0, 0. */
const MOVE_GLYPH =
  'M0 -7V7M-7 0H7M-2.5 -4.5L0 -7L2.5 -4.5M-2.5 4.5L0 7L2.5 4.5M-4.5 -2.5L-7 0L-4.5 2.5M4.5 -2.5L7 0L4.5 2.5';

/**
 * The selected room's move handle, and while it is dragged, how far the room has gone
 * (across, then up or down the plan).
 */
function RoomMoveHandle({
  ctx,
  drag,
}: { ctx: ToolContext; drag?: Extract<Drag, { kind: 'room' }> }) {
  const sel = useEditor.getState().selection;
  const world = drag
    ? { x: drag.handle.x + drag.delta.x, y: drag.handle.y + drag.delta.y }
    : sel?.kind === 'room'
      ? roomHandleAt(ctx.level, ctx.geom, ctx.view.zoom, sel.id)
      : null;
  if (!world) return null;
  const c = worldToScreen(ctx.view, ctx.size, world);
  const dx = drag?.delta.x ?? 0;
  const dy = drag?.delta.y ?? 0;
  // A move in millimetres (Alt) says so; whole centimetres read as metres.
  const fmt = (v: number) =>
    Math.abs(v * 100 - Math.round(v * 100)) > 1e-6
      ? `${Math.round(Math.abs(v) * 1000)} mm`
      : formatLength(Math.abs(v));
  const parts = [
    ...(Math.abs(dx) > 1e-9 ? [`${dx > 0 ? '→' : '←'} ${fmt(dx)}`] : []),
    ...(Math.abs(dy) > 1e-9 ? [`${dy > 0 ? '↓' : '↑'} ${fmt(dy)}`] : []),
  ];
  const text = parts.join('   ');
  const width = text.length * 7 + 20;
  // Below the handle, kept inside the plan.
  const at = {
    x: Math.min(ctx.size.width - width / 2 - 4, Math.max(width / 2 + 4, c.x)),
    y: Math.min(ctx.size.height - 16, c.y + 34),
  };
  return (
    <g pointerEvents="none">
      <g className="room-move" transform={`translate(${c.x} ${c.y})`}>
        <circle r={ROOM_HANDLE_RADIUS} className="move-handle" />
        <path d={MOVE_GLYPH} className="move-glyph" />
      </g>
      {text && (
        <g className="handle-length" transform={`translate(${at.x} ${at.y})`}>
          <rect x={-width / 2} y={-11} width={width} height={22} rx={4} />
          <text textAnchor="middle" y={4} className="num">
            {text}
          </text>
        </g>
      )}
    </g>
  );
}

function OpeningClearances({ ctx, id }: { ctx: ToolContext; id: string }) {
  const op = ctx.level.openings[id];
  const f = op && ctx.geom.frames[op.wallId];
  if (!op || !f) return null;
  const { before, after } = openingClearances(f, op);
  const [u0, u1] = openingSpan(f, op);
  const start = u0 - before;
  const end = u1 + after;
  // On the side the door doesn't swing to, so the dimensions never sit on its arc.
  const side = op.kind === 'door' && (op.swing ?? 'leftIn').endsWith('In') ? -1 : 1;
  const toScreen = (u: number) => worldToScreen(ctx.view, ctx.size, framePoint(f, u, side));
  const a = toScreen(0);
  const n = worldToScreen(ctx.view, ctx.size, {
    x: f.a.x + f.n.x * side * (f.half + 1),
    y: f.a.y + f.n.y * side * (f.half + 1),
  });
  const k = Math.hypot(n.x - a.x, n.y - a.y) || 1;
  const out = { x: (n.x - a.x) / k, y: (n.y - a.y) / k };
  const at = (from: number, to: number, away: number) => {
    const p = toScreen(from);
    const q = toScreen(to);
    return { p, q, m: { x: (p.x + q.x) / 2 + out.x * away, y: (p.y + q.y) / 2 + out.y * away } };
  };
  // Labels 34 px off the wall; the second steps further out if the two would overlap.
  const first = at(start, u0, 34);
  let second = at(u1, end, 34);
  if (Math.hypot(second.m.x - first.m.x, second.m.y - first.m.y) < 76) second = at(u1, end, 62);
  const dim = (d: ReturnType<typeof at>, length: number, name: string) => (
    <g key={name} className="opening-clearance">
      {length >= 1e-3 && (
        <line
          x1={d.p.x + out.x * 18}
          y1={d.p.y + out.y * 18}
          x2={d.q.x + out.x * 18}
          y2={d.q.y + out.y * 18}
        />
      )}
      <g transform={`translate(${d.m.x} ${d.m.y})`} className="handle-length">
        <rect x={-34} y={-11} width={68} height={22} rx={4} />
        <text textAnchor="middle" y={4} className="num">
          {formatLength(length)}
        </text>
      </g>
    </g>
  );
  return (
    <g pointerEvents="none" data-testid="opening-clearances">
      {dim(first, before, 'before')}
      {dim(second, after, 'after')}
    </g>
  );
}

/** How near (screen px) a press must land to a handle to take it: a fingertip's reach. */
const HANDLE_REACH = 20;
/** The footprint's corners, in itemFootprint's order. */
const CORNER_NAMES = ['back-left', 'back-right', 'front-right', 'front-left'];
/** A corner handle's drawn size (screen px); on the piece itself, a press must land on it. */
const HANDLE_SIZE = 12;

export function useMeasureTool(ctx: ToolContext): ToolController {
  const [points, setPoints] = useState<Vec2[]>([]);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  /** Where a finger drag measuring anew began, to show the line before the finger lifts. */
  const [dragFrom, setDragFrom] = useState<Vec2 | null>(null);
  /** The end of the last measurement a finger is dragging. */
  const grab = useRef<number | null>(null);
  const snap = (p: PlanPointer) =>
    (p.alt ? null : nearestVertex(ctx, p.world, 10)?.at) ?? gridSnap(p.world, 0.01, p.alt);
  const endAt = (p: PlanPointer) => {
    if (points.length < 2) return null;
    const i = points.findIndex((q) => {
      const s = worldToScreen(ctx.view, ctx.size, q);
      return Math.hypot(s.x - p.screen.x, s.y - p.screen.y) <= 22;
    });
    return i < 0 ? null : i;
  };

  return {
    cursor: 'crosshair',
    // A finger on an end of the last measurement moves that end.
    grabs: (p) => {
      grab.current = endAt(p);
      return grab.current !== null;
    },
    touchDrag: (a, b) => {
      setPoints([snap(a), snap(b)]);
      setDragFrom(null);
      setCursor(null);
    },
    touchCancel: () => setDragFrom(null),
    down: (p) => {
      if (grab.current !== null) return true;
      const at = snap(p);
      // No stale pointer position: on a phone the next point is the next tap.
      setCursor(null);
      setPoints((prev) => (prev.length >= 2 ? [at] : [...prev, at]));
      return true;
    },
    move: (p, dragging, from) => {
      const g = grab.current;
      if (g !== null && dragging) {
        const at = snap(p);
        setPoints((prev) => prev.map((q, i) => (i === g ? at : q)));
        return;
      }
      setDragFrom(from ? snap(from) : null);
      setCursor(snap(p));
    },
    up: () => {
      grab.current = null;
    },
    key: (e) => {
      if (e.key === 'Escape' && points.length > 0) {
        setPoints([]);
        return true;
      }
      return false;
    },
    overlay: ({ view, size }) => {
      // A finger drag in progress measures from where it began; otherwise the points so far.
      const a = dragFrom ?? points[0];
      const b = dragFrom ? cursor : (points[1] ?? cursor);
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
