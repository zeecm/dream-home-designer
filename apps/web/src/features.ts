/**
 * Features on hold, off unless turned on in this browser. The ageing ("Older person") check is on
 * hold (owner, 7 Nov 2026): its code stays, hidden. Turn it on with `?ageing=1` in the address
 * (remembered) or localStorage `dhd-feature-ageing` = "1"; `?ageing=0` turns it off again.
 */
export const AGEING_FLAG = 'dhd-feature-ageing';

let ageing: boolean | null = null;

/** Whether the Older person check shows (read once per page load). */
export function ageingEnabled(): boolean {
  if (ageing !== null) return ageing;
  ageing = false;
  try {
    const asked =
      typeof window !== 'undefined'
        ? new URLSearchParams(window.location?.search ?? '').get('ageing')
        : null;
    if (asked === '1') window.localStorage.setItem(AGEING_FLAG, '1');
    if (asked === '0') window.localStorage.removeItem(AGEING_FLAG);
    ageing = asked === '1' || window.localStorage.getItem(AGEING_FLAG) === '1';
  } catch {
    ageing = false;
  }
  return ageing;
}

/** Forgets the flag read, so the next call reads it again (tests). */
export function resetFeatures() {
  ageing = null;
}
