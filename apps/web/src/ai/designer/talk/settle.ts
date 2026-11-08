import type { Project } from '@dhd/core';
import { useEffect, useState } from 'react';
import { useProject } from '../../../store';

/**
 * The plan as the conversation works from it: the project once edits have paused for `delay`
 * ms, so a drag on the plan never runs the designer's checks frame by frame (a card's result
 * takes about 120 ms on a computer). An accept or an undo shows within the delay.
 */
export function useSettledProject(delay = 250): Project {
  const live = useProject();
  const [settled, setSettled] = useState(live);
  useEffect(() => {
    if (live === settled) return;
    const t = setTimeout(() => setSettled(live), delay);
    return () => clearTimeout(t);
  }, [live, settled, delay]);
  return settled;
}

interface Perf {
  ms: number;
  calls: number;
}
/**
 * Time spent in the designer's own work on the main thread, counted only when a test asks
 * (it sets `window.__dhdDesignerPerf`): the drag-performance check reads it.
 */
export function timed<T>(fn: () => T): T {
  const perf = (globalThis as { __dhdDesignerPerf?: Perf }).__dhdDesignerPerf;
  if (!perf) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    perf.ms += performance.now() - t0;
    perf.calls++;
  }
}
