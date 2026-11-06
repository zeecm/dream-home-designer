import { type Level, type Vec2, roomShapes } from '@dhd/core';
import { useEffect } from 'react';
import { create } from 'zustand';
import { useEditor } from '../../editor';
import { MAX_ZOOM, MIN_ZOOM } from '../../plan/view';

/**
 * [Show] in the designer: fits a room or a spot of the version on show into the plan, and
 * rings it for a moment.
 */
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export const useDesignFocus = create<{ box: Box | null; at: number }>(() => ({ box: null, at: 0 }));

export function showRoom(level: Level, roomIds: string[]) {
  const pts = roomIds.flatMap((id) => roomShapes(level).get(id)?.outer ?? []);
  if (pts.length) showBox(pts);
}

export function showPoint(p: Vec2, r = 1) {
  showBox([
    { x: p.x - r, y: p.y - r },
    { x: p.x + r, y: p.y + r },
  ]);
}

function showBox(pts: Vec2[]) {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  useDesignFocus.setState({
    box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) },
    at: Date.now(),
  });
}

/** In the plan: fits the box asked for, and rings it. */
export function DesignFocusLayer({ size }: { size: { width: number; height: number } }) {
  const { box, at } = useDesignFocus();
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new request only
  useEffect(() => {
    if (!box || !size.width) return;
    const w = Math.max(box.x1 - box.x0, 2);
    const h = Math.max(box.y1 - box.y0, 2);
    const pad = 32;
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min((size.width - 2 * pad) / w, (size.height - 2 * pad) / h)),
    );
    useEditor
      .getState()
      .setView({ cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, zoom }, true);
    const t = setTimeout(() => useDesignFocus.setState({ box: null }), 2500);
    return () => clearTimeout(t);
  }, [at]);
  if (!box) return null;
  return (
    <rect
      className="design-focus"
      x={box.x0 - 0.1}
      y={box.y0 - 0.1}
      width={box.x1 - box.x0 + 0.2}
      height={box.y1 - box.y0 + 0.2}
      pointerEvents="none"
    />
  );
}
