import { AFTER_SUFFIX, type Vec2, anchorFor } from '@dhd/core';
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useComments } from '../comments/store';
import { type Selection, useEditor } from '../editor';
import { cycle, objectPoint, planObjects } from './keyboard';
import { parseHit } from './layers';
import type { PlanPointer, ToolContext, ToolController } from './tools';
import { panBy, screenToWorld, worldToScreen } from './view';

/** What a comment there attaches to, as the plan outlines it before the click. */
function targetOf(hit: Selection | null): Selection | null {
  if (!hit || hit.kind === 'vertex') return null;
  return hit;
}

/**
 * What is under a point of the canvas. The lift of a press is captured by the canvas, so
 * its own target says nothing; a finger that moved lifts somewhere else than it pressed.
 */
function hitAt(screen: Vec2): Selection | null {
  const svg = document.querySelector('.plan-svg');
  const r = svg?.getBoundingClientRect();
  if (!r) return null;
  return parseHit(document.elementFromPoint(r.left + screen.x, r.top + screen.y));
}

/** Focuses the composer's first field: inside the tap's own handler, so iOS shows the keyboard. */
function focusComposer() {
  const el = document.querySelector<HTMLElement>(
    '[data-comment-compose] input, [data-comment-compose] textarea',
  );
  el?.focus({ preventScroll: true });
}

/**
 * The Comment tool: a click or tap drops a pin on what is under it (a piece, a point, an
 * opening, a wall, a room, or a plain spot) and opens the composer next to it. By
 * keyboard, Tab picks a target, the arrows pan the plan under a crosshair, Enter places.
 */
export function useCommentTool(ctx: ToolContext): ToolController {
  const start = useRef<PlanPointer | null>(null);
  /** Placing by keyboard: the crosshair at the centre shows. */
  const [keyboard, setKeyboard] = useState(false);

  const place = (world: Vec2, hit: Selection | null) => {
    const level = ctx.level;
    if (!level) return;
    const { variant } = useEditor.getState();
    const levelId = level.id.endsWith(AFTER_SUFFIX)
      ? level.id.slice(0, -AFTER_SUFFIX.length)
      : level.id;
    const anchor = { levelId, variant, ...anchorFor(level, world, targetOf(hit)) };
    const svg = document.querySelector<HTMLElement>('.plan-svg');
    useComments.setState({ returnFocus: svg });
    flushSync(() => useComments.getState().startDraft(anchor));
    focusComposer();
  };

  return {
    cursor: 'crosshair',
    down: (p) => {
      start.current = p;
      return true;
    },
    move: (p, dragging) => {
      if (!dragging) useEditor.getState().setHover(targetOf(p.hit));
    },
    up: (p) => {
      const s = start.current;
      start.current = null;
      if (!s) return;
      // A drag with a mouse isn't a click. (A finger's tap or drag arrives as a press and a
      // lift at the one spot where it lifted.)
      if (Math.hypot(p.screen.x - s.screen.x, p.screen.y - s.screen.y) > 6) return;
      setKeyboard(false);
      useEditor.getState().setHover(null);
      // The press's target: the lift is captured by the canvas, so it hit nothing.
      place(p.world, hitAt(p.screen) ?? s.hit);
    },
    touchCancel: () => {
      start.current = null;
    },
    key: (e) => {
      const ed = useEditor.getState();
      const level = ctx.level;
      if (!level) return false;
      if (e.key === 'Tab' && (e.target as Element | null)?.classList?.contains('plan-svg')) {
        const next = cycle(
          planObjects(level).filter((o) => o.kind !== 'vertex'),
          ed.hover,
          e.shiftKey,
        );
        if (!next) {
          ed.setHover(null);
          return false; // leave the plan past either end
        }
        setKeyboard(true);
        ed.setHover(next);
        return true;
      }
      const arrows: Record<string, Vec2> = {
        ArrowLeft: { x: 1, y: 0 },
        ArrowRight: { x: -1, y: 0 },
        ArrowUp: { x: 0, y: 1 },
        ArrowDown: { x: 0, y: -1 },
      };
      const a = arrows[e.key];
      if (a) {
        const step = e.shiftKey ? 120 : 30;
        setKeyboard(true);
        ed.setHover(null);
        const v = ed.view ?? ctx.view;
        ed.setView(panBy(v, a.x * step, a.y * step), true);
        return true;
      }
      if (e.key === 'Enter' && keyboard) {
        const target = ed.hover;
        const at = target
          ? objectPoint(level, target)
          : screenToWorld(ed.view ?? ctx.view, ctx.size, {
              x: ctx.size.width / 2,
              y: ctx.size.height / 2,
            });
        if (!at) return false;
        place(at, target);
        return true;
      }
      if (e.key === 'Escape' && (keyboard || ed.hover)) {
        setKeyboard(false);
        ed.setHover(null);
        return true;
      }
      return false;
    },
    overlay: (c) => {
      if (!keyboard) return null;
      const hover = useEditor.getState().hover;
      const at = hover
        ? objectPoint(c.level, hover)
        : screenToWorld(c.view, c.size, { x: c.size.width / 2, y: c.size.height / 2 });
      if (!at) return null;
      const s = worldToScreen(c.view, c.size, at);
      return (
        <path
          className="comment-crosshair"
          d={`M ${s.x - 12} ${s.y} H ${s.x + 12} M ${s.x} ${s.y - 12} V ${s.y + 12}`}
          pointerEvents="none"
        />
      );
    },
  };
}
