import type { Design } from '@dhd/core';

/**
 * Compare: the flat as it is, then up to two versions side by side. Which two, as the
 * person picks them (checkboxes), always shown oldest first.
 */

/** At most this many versions beside Before. */
export const MAX_PICKS = 2;

const byN = (designs: Design[]) => [...designs].sort((a, b) => a.n - b.n);

/** The two to start with: the selected version and the one before it (or after it, for V1). */
export function defaultPicks(designs: Design[], selected: string | null): string[] {
  const list = byN(designs);
  const i = Math.max(
    0,
    list.findIndex((d) => d.id === selected),
  );
  const at = list[i];
  if (!at) return [];
  const other = list[i - 1] ?? list[i + 1];
  // The selected one last: a third tick replaces the other one first.
  return other ? [other.id, at.id] : [at.id];
}

/**
 * Ticking or unticking a version. A third tick replaces the pick ticked longest ago (the
 * first of `picks`, which keeps the order they were ticked in); the last one can't go.
 */
export function togglePick(picks: string[], id: string): string[] {
  if (picks.includes(id)) return picks.length > 1 ? picks.filter((p) => p !== id) : picks;
  const next = [...picks, id];
  return next.length > MAX_PICKS ? next.slice(next.length - MAX_PICKS) : next;
}

/** The picks as columns: versions that still exist, oldest first. */
export function ordered(designs: Design[], picks: string[]): string[] {
  return byN(designs)
    .filter((d) => picks.includes(d.id))
    .map((d) => d.id);
}
