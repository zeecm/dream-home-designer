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
let lastRoom: string | null = null;
const HISTORY_KEY = 'dhdWallView';

useEditor.subscribe((s, prev) => {
  if (s.selection !== prev.selection && s.selection?.kind === 'room') lastRoom = s.selection.id;
});

const phone = () => !!window.matchMedia?.(ONE_VIEW_QUERY).matches;

/** Opens (or moves the open view to) a face; `from` gets focus back when it closes. */
export function openFace(level: Level, face: RoomFace, from?: Element | null) {
  const ed = useEditor.getState();
  const wasOpen = !!ed.elevation;
  if (!wasOpen) {
    const active = from ?? document.activeElement;
    opener = active instanceof HTMLElement ? active : null;
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
  if (!wasOpen && phone() && window.history.state?.[HISTORY_KEY] !== true) {
    window.history.pushState({ ...(window.history.state ?? {}), [HISTORY_KEY]: true }, '');
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
  opener = null;
  requestAnimationFrame(() => {
    if (back?.isConnected) back.focus();
    else document.querySelector<SVGSVGElement>('svg.plan-svg')?.focus();
  });
}

/** Closes the view (Close, Esc), back to the view it was opened from. */
export function closeView() {
  if (!useEditor.getState().elevation) return;
  // A phone's view added a history entry: going back closes it (popstate, below).
  if (window.history.state?.[HISTORY_KEY] === true) {
    window.history.back();
    return;
  }
  closed();
}

window.addEventListener('popstate', () => {
  if (useEditor.getState().elevation && window.history.state?.[HISTORY_KEY] !== true) closed();
});
