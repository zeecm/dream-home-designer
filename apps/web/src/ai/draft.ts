import type { Level, TracedPlan } from '@dhd/core';
import { create } from 'zustand';

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
  set: (s: Partial<Omit<DraftState, 'set'>>) => void;
}

export const useTrace = create<DraftState>((set) => ({
  draft: null,
  running: null,
  error: null,
  set: (s) => set(s),
}));
