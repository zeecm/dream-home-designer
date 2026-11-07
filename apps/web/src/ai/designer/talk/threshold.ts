import { DEFAULT_THRESHOLD, THRESHOLDS, type Threshold } from '@dhd/core';
import { useSyncExternalStore } from 'react';

/**
 * The per-reply threshold (UX §9.4): "Ask me before a reply that may cost more than US$0.25",
 * kept in this browser (`dhd-ai-ask`, localStorage): a figure, 'always' or 'never'.
 */

const KEY = 'dhd-ai-ask';
const listeners = new Set<() => void>();

function load(): Threshold {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === 'always' || raw === 'never') return raw;
    const n = Number(raw);
    return raw !== null && THRESHOLDS.includes(n) ? n : DEFAULT_THRESHOLD;
  } catch {
    return DEFAULT_THRESHOLD;
  }
}
let value: Threshold = typeof window === 'undefined' ? DEFAULT_THRESHOLD : load();

export const threshold = (): Threshold => value;

export function setThreshold(v: Threshold) {
  value = v;
  try {
    window.localStorage.setItem(KEY, String(v));
  } catch {
    // kept for this visit
  }
  for (const fn of listeners) fn();
}

export function useThreshold(): Threshold {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => value,
  );
}

/** For tests: read storage afresh. */
export const reloadThreshold = () => {
  value = load();
  for (const fn of listeners) fn();
};
