import { type Level, type RoomFace, faceRef, roomShapes } from '@dhd/core';
import { useEditor } from '../editor';
import { currentLevel } from '../store';
import { ONE_VIEW_QUERY } from '../ui/oneView';
import { faceForSelection } from './nav';

/**
 * Opening and closing the wall view from the app: the Inspector's buttons, the L key, the
 * letters on the plan. Remembers the button it was opened from (focus goes back there on
 * close) and the room last looked at (a wall's side towards it is the one L opens). On a
 * phone, opening adds a history entry so the Back button closes the view.
 */

let opener: HTMLElement | null = null;
/** The opening button's `data-wall-entry`, to find it again if it was drawn afresh. */
let openerKey: string | null = null;
let lastRoom: string | null = null;
const HISTORY_KEY = 'dhdWallView';
/** Whether this page added the history entry the open view is on (a phone's). */
let pushed = false;

/** The room last looked at: a wall's or a thing's side towards it is the one opened. */
export const lastRoomLooked = () => lastRoom;

// A reload on that entry: the view isn't open any more, so the entry means nothing.
if (window.history.state?.[HISTORY_KEY] === true) {
  const { [HISTORY_KEY]: _, ...rest } = window.history.state as Record<string, unknown>;
  window.history.replaceState(rest, '');
}

useEditor.subscribe((s, prev) => {
  if (s.selection !== prev.selection && s.selection?.kind === 'room') lastRoom = s.selection.id;
  // Closed any way but Back (Close, Esc, 1, 2 or 3): its history entry goes too.
  if (prev.elevation && !s.elevation && pushed) {
    pushed = false;
    if (window.history.state?.[HISTORY_KEY] === true) window.history.back();
  }
});

const phone = () => !!window.matchMedia?.(ONE_VIEW_QUERY).matches;

/** Opens (or moves the open view to) a face; `from` gets focus back when it closes. */
export function openFace(level: Level, face: RoomFace, from?: Element | null) {
  const ed = useEditor.getState();
  const wasOpen = !!ed.elevation;
  if (!wasOpen) {
    const active = from ?? document.activeElement;
    opener = active instanceof HTMLElement && active !== document.body ? active : null;
    openerKey = opener?.dataset.wallEntry ?? null;
  } else if (ed.selection?.kind === 'wall') {
    // Stepping or flipping with a wall selected: the selection moves to the wall now shown.
    const solid = face.stretches.filter((s) => !s.boundary);
    const pick = [...(solid.length ? solid : face.stretches)].sort(
      (a, b) => b.u1 - b.u0 - (a.u1 - a.u0),
    )[0];
    if (pick) ed.select({ kind: 'wall', id: pick.wallId });
  }
  lastRoom = face.roomId;
  ed.openElevation(faceRef(face));
  // The plan beside it frames the room.
  const outer = roomShapes(level).get(face.roomId)?.outer ?? [];
  if (outer.length && !phone()) {
    const xs = outer.map((p) => p.x);
    const ys = outer.map((p) => p.y);
    const box = {
      min: { x: Math.min(...xs), y: Math.min(...ys) },
      max: { x: Math.max(...xs), y: Math.max(...ys) },
    };
    const same = JSON.stringify(box) === JSON.stringify(useEditor.getState().fitBox);
    if (!same || !wasOpen) {
      useEditor.setState({ fitBox: box });
      useEditor.getState().requestFit(48);
    }
  }
  if (!wasOpen && phone() && !pushed) {
    window.history.pushState({ ...(window.history.state ?? {}), [HISTORY_KEY]: true }, '');
    pushed = true;
  }
}

/** Opens the face the selection is on (L): false if there is none. */
export function openSelected(): boolean {
  const level = currentLevel();
  if (!level) return false;
  const face = faceForSelection(level, useEditor.getState().selection, lastRoom);
  if (!face) return false;
  openFace(level, face);
  return true;
}

function closed() {
  useEditor.getState().closeElevation();
  const back = opener;
  const key = openerKey;
  opener = null;
  openerKey = null;
  // Back to the button it was opened from (drawn again, if it was hidden while open), else
  // the plan.
  requestAnimationFrame(() => {
    const again = key
      ? document.querySelector<HTMLElement>(`[data-wall-entry="${CSS.escape(key)}"]`)
      : null;
    const to = back?.isConnected ? back : again;
    if (to) to.focus();
    else document.querySelector<SVGSVGElement>('svg.plan-svg')?.focus();
  });
}

/** Closes the view (Close, Esc), back to the view it was opened from. */
export function closeView() {
  if (!useEditor.getState().elevation) return;
  closed();
}

// Back on a phone: off the view's entry, so the view closes (the entry is already gone).
window.addEventListener('popstate', () => {
  if (!pushed || window.history.state?.[HISTORY_KEY] === true) return;
  pushed = false;
  if (useEditor.getState().elevation) closed();
});
