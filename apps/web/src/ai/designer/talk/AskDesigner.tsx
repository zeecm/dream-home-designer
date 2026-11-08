import type { Level } from '@dhd/core';
import { type Selection, useEditor } from '../../../editor';
import { useStore } from '../../../store';
import { openPanel } from '../state';
import { targetOf } from './PlanPopover';
import { addPointer, makePointer } from './pointers';
import { ensureConversation } from './useTalk';

/** Where a selection is, for its pointer. */
function centre(level: Level, sel: Selection) {
  if (sel.kind === 'item') {
    const it = level.items[sel.id];
    if (it) return { x: it.position.x, y: it.position.z };
  }
  const wallId =
    sel.kind === 'wall' ? sel.id : sel.kind === 'opening' ? level.openings[sel.id]?.wallId : null;
  const w = wallId ? level.walls[wallId] : undefined;
  const a = w && level.vertices[w.a];
  const b = w && level.vertices[w.b];
  if (a && b) {
    const t = sel.kind === 'opening' ? (level.openings[sel.id]?.t ?? 0.5) : 0.5;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  const r = sel.kind === 'room' ? level.rooms[sel.id] : undefined;
  const pts = (r?.loop ?? []).flatMap((id) => {
    const v = level.vertices[id];
    return v ? [v] : [];
  });
  const n = pts.length || 1;
  return { x: pts.reduce((t, p) => t + p.x, 0) / n, y: pts.reduce((t, p) => t + p.y, 0) / n };
}

/**
 * The Inspector's Ask the designer (slice 3a §2.3, 3a.1): opens the designer with a chip for
 * what is selected on your plan (no version), the composer focused. The piece stays selected.
 */
export function AskDesigner({ level, selection }: { level: Level; selection: Selection }) {
  const viewer = useStore((s) => s.role === 'viewer');
  const previewing = useEditor((s) => !!s.preview);
  if (viewer || previewing || selection.kind === 'vertex') return null;
  return (
    <button
      type="button"
      className="btn"
      onClick={async () => {
        openPanel();
        await ensureConversation();
        const t = targetOf(selection, centre(level, selection));
        const p = t ? makePointer(t) : null;
        if (p) await addPointer(p);
        requestAnimationFrame(() =>
          document.querySelector<HTMLTextAreaElement>('#talk-text')?.focus(),
        );
      }}
    >
      Ask the designer
    </button>
  );
}
