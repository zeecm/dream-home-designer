import type { SavedVersion } from './backend';

/** A pause this long between saves ends an editing session. */
export const SESSION_GAP_MS = 5 * 60_000;
/** How many points in time the history offers. */
export const MAX_POINTS = 20;

/**
 * The points worth going back to, newest first. Autosave keeps a version every few seconds
 * of editing, so offer the plan as it was at the end of each session instead: a version
 * that stayed current at least SESSION_GAP_MS before the next save replaced it.
 */
export function historyPoints(versions: readonly SavedVersion[]): SavedVersion[] {
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const kept = sorted.filter((v, i) => {
    const prev = sorted[i - 1];
    // Saved when the one before it was replaced; the very first has no start, so keep it.
    if (!prev || prev.version !== v.version - 1) return true;
    return Date.parse(v.replacedAt) - Date.parse(prev.replacedAt) >= SESSION_GAP_MS;
  });
  // The last version before the current one is always worth offering.
  const last = sorted.at(-1);
  if (last && kept.at(-1) !== last) kept.push(last);
  return kept.reverse().slice(0, MAX_POINTS);
}
