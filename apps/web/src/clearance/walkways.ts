import { type Level, type WalkwayReport, walkwayReport } from '@dhd/core';
import { create } from 'zustand';
import { useEditor } from '../editor';
import { currentLevel, useStore } from '../store';

/**
 * Walkways for the level shown, kept outside React. They take a few milliseconds to work out,
 * too many for every frame of a drag: while a pointer is down, edits are checked at most every
 * 100 ms (a trailing timer; 250 ms if a run is slow); a release or any other edit (Undo, a
 * nudge, a field) checks at once, so what's drawn and read out after it is current.
 */
export interface WalkwayState {
  report: WalkwayReport | null;
  /** The level the report is for (it may trail the one shown by up to a timer's wait). */
  level: Level | null;
  /** Bumped by each check that follows a release: the drop's announcement waits for it. */
  released: number;
  /** Whether checks run (the clearance switch). */
  on: boolean;
}

export const useWalkways = create<WalkwayState>(() => ({
  report: null,
  level: null,
  released: 0,
  on: true,
}));

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let wait = 100;
let pointerDown = false;

/** Whether a pointer is held down on the page (a drag in progress). */
export const pointerHeld = () => pointerDown;

function run(released = false) {
  if (timer) clearTimeout(timer);
  timer = null;
  const { on } = useWalkways.getState();
  const level = on ? (currentLevel() ?? null) : null;
  const prev = useWalkways.getState();
  if (level === prev.level && !released) return;
  const t0 = performance.now();
  const report = level ? walkwayReport(level) : null;
  // A slow plan (a big one, a slow phone) is checked less often while dragging.
  wait = performance.now() - t0 > 30 ? 250 : 100;
  useWalkways.setState({
    report,
    level,
    ...(released ? { released: prev.released + 1 } : {}),
  });
}

/** Checks the level shown now (a gesture's end; tests). */
export function flushWalkways(released = false) {
  run(released);
}

function changed() {
  if (pointerDown) {
    if (!timer) timer = setTimeout(() => run(), wait);
    return;
  }
  // Not dragging: once the current event has done its edits.
  if (!timer) timer = setTimeout(() => run(), 0);
}

/** Starts watching the project, the version shown and the switch (once). */
export function startWalkways(on: boolean) {
  useWalkways.setState({ on });
  if (started) {
    changed();
    return;
  }
  started = true;
  useStore.subscribe((s, p) => {
    if (s.editor.doc !== p.editor.doc) changed();
  });
  useEditor.subscribe((s, p) => {
    if (s.variant !== p.variant) changed();
  });
  if (typeof window !== 'undefined') {
    window.addEventListener(
      'pointerdown',
      () => {
        pointerDown = true;
      },
      true,
    );
    const up = () => {
      if (!pointerDown) return;
      pointerDown = false;
      // After the tool's own pointerup has made its last edit.
      setTimeout(() => run(true), 0);
    };
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }
  run();
}
