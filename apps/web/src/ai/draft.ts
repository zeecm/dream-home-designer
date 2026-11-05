import type { Level, TracedPlan } from '@dhd/core';
import { create } from 'zustand';
import { useEditor } from '../editor';
import { currentLevel, useStore } from '../store';

/** A traced plan waiting to be accepted or discarded, drawn over the plan image. */
export interface TraceDraft {
  /** The level as it would be with the trace in (drawn over the plan to look over). */
  level: Level;
  /** What was read, in plan metres: built again on Accept, against the plan as it is then. */
  plan: TracedPlan;
  /** Walls and openings the model saw that couldn't be placed. */
  skipped: number;
  /** The total area printed on the plan, if the model saw one. */
  printedArea: number | null;
  /** Whether accepting replaces the walls already drawn. */
  replace: boolean;
}

interface DraftState {
  draft: TraceDraft | null;
  running: AbortController | null;
  error: string | null;
  /** The error was the key being refused: the way on is AI settings, not trying again. */
  keyRefused?: boolean;
  /** The project and level the trace is for: another one opened ends it. */
  at: string | null;
  set: (s: Partial<Omit<DraftState, 'set'>>) => void;
}

export const useTrace = create<DraftState>((set) => ({
  draft: null,
  running: null,
  error: null,
  at: null,
  set: (s) => set(s),
}));

/** Where a trace belongs: this project, this level (and plan before or after). */
export const traceWhere = () => `${useStore.getState().editor.doc.id}/${currentLevel()?.id ?? ''}`;

// Another project or level opened: a trace for the old one is cancelled or put away.
const check = () => {
  const s = useTrace.getState();
  if (s.at === null || s.at === traceWhere()) return;
  s.running?.abort();
  useTrace.setState({ running: null, draft: null, error: null, at: null });
};
useStore.subscribe(check);
useEditor.subscribe(check);
