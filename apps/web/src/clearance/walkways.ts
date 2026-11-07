import {
  type AgeingChoice,
  type AgeingReport,
  type Level,
  type Variant,
  type WalkwayReport,
  ageingReport,
  walkwayReport,
} from '@dhd/core';
import { create } from 'zustand';
import { useEditor } from '../editor';
import { ageingEnabled } from '../features';
import { currentLevel, useStore } from '../store';

/**
 * Walkways for the level shown, kept outside React. They take a few milliseconds to work out,
 * too many for every frame of a drag: while a pointer is down, edits are checked at most every
 * 100 ms (a trailing timer; 250 ms if a run is slow); a release or any other edit (Undo, a
 * nudge, a field) checks at once, so what's drawn and read out after it is current. The
 * ageing parents check runs in the same pass (it shares the walkway raster), whenever it is on,
 * even with clearance checks switched off.
 */
export interface WalkwayState {
  report: WalkwayReport | null;
  /** The level the report is for (it may trail the one shown by up to a timer's wait). */
  level: Level | null;
  /** The version (Before or After) it is for. */
  variant: Variant | null;
  /** Bumped by each check that follows a release: the drop's announcement waits for it. */
  released: number;
  /** Whether checks run (the clearance switch). */
  on: boolean;
  /** The ageing check of the same level (null while it is off). */
  ageing: AgeingReport | null;
  /** Who the ageing check is for (null: off). */
  ageingChoice: AgeingChoice | null;
}

export const useWalkways = create<WalkwayState>(() => ({
  report: null,
  level: null,
  variant: null,
  released: 0,
  on: true,
  ageing: null,
  ageingChoice: null,
}));

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let wait = 100;
let pointerDown = false;
/** The clearance switch and ageing choice the last run used. */
let lastRun = '';

/** Whether a pointer is held down on the page (a drag in progress). */
export const pointerHeld = () => pointerDown;

function run(released = false) {
  if (timer) clearTimeout(timer);
  timer = null;
  const { on, ageingChoice } = useWalkways.getState();
  const level = on || ageingChoice ? (currentLevel() ?? null) : null;
  const prev = useWalkways.getState();
  // What the last run was for: the level, the clearance switch and the ageing choice.
  const ran = JSON.stringify([on, ageingChoice]);
  if (level === prev.level && ran === lastRun && !released) return;
  lastRun = ran;
  const t0 = performance.now();
  // Walkways first: ageing then reuses their furnished pass.
  const report = level && on ? walkwayReport(level) : null;
  const ageing = level && ageingChoice ? ageingReport(level, ageingChoice) : null;
  // A slow plan (a big one, a slow phone) is checked less often while dragging.
  wait = performance.now() - t0 > 30 ? 250 : 100;
  useWalkways.setState({
    report,
    ageing,
    level,
    variant: useEditor.getState().variant,
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
  start();
}

/** Turns the ageing check on for this choice, or off (null); it runs with or without walkways. */
export function startAgeing(asked: AgeingChoice | null) {
  // On hold (owner): off whatever the browser holds, unless its flag is on.
  const choice = ageingEnabled() ? asked : null;
  if (JSON.stringify(choice) === JSON.stringify(useWalkways.getState().ageingChoice) && started) {
    return;
  }
  useWalkways.setState({ ageingChoice: choice });
  start();
}

function start() {
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
      (e) => {
        // A press on the wall view's drawing edits nothing: no walkways to work out again
        // when it ends (a whole report and re-render on every tap held up a double tap).
        if ((e.target as Element | null)?.closest?.('.elev-sheet')) return;
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
    // However the press ends: let go, cancelled, capture lost, or the window left mid-drag
    // (its pointerup never comes), so the flag never sticks.
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      window.addEventListener(type, up, true);
    }
    window.addEventListener('blur', up);
  }
  run();
}
