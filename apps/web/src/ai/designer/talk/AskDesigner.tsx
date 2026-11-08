import type { Level } from '@dhd/core';
import { type Selection, useEditor } from '../../../editor';
import { objectPoint } from '../../../plan/keyboard';
import { useStore } from '../../../store';
import { openPanel } from '../state';
import { targetOf } from './PlanPopover';
import { addPointer, makePointer } from './pointers';
import { ensureConversation } from './useTalk';

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
      className="btn talk-ask-btn"
      onClick={async () => {
        openPanel();
        await ensureConversation();
        const at = objectPoint(level, selection);
        const t = at ? targetOf(selection, at) : null;
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
