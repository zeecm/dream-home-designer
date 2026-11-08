/**
 * The screen kept on while a design runs (docs/specs/locked-phone-runs.md, part 1): a Screen
 * Wake Lock, taken when the run starts, taken again each time the page comes back into view
 * (the browser lets it go when the page is hidden), and let go when the run ends, pauses at a
 * limit or is stopped. Where the browser has none, or refuses it (low-power mode), nothing
 * else changes: the card says the screen may turn off on its own.
 */

export type WakeState = 'held' | 'refused' | 'unsupported';

interface Sentinel {
  release: () => Promise<void>;
  addEventListener?: (type: 'release', fn: () => void) => void;
}
interface WakeLockApi {
  request: (type: 'screen') => Promise<Sentinel>;
}

const api = (): WakeLockApi | null =>
  (typeof navigator !== 'undefined' &&
    (navigator as unknown as { wakeLock?: WakeLockApi }).wakeLock) ||
  null;

export interface ScreenHold {
  /** Let go of the screen (the run ended or paused); `hold` takes it again. */
  release: () => void;
  /** Take it (again), after a pause. */
  hold: () => void;
  /** Done with it for good: let go and stop watching the page. */
  end: () => void;
}

/**
 * Keeps the screen on until released. `onState` hears whether it is held, refused or not
 * there at all, each time that changes.
 */
export function holdScreen(onState: (s: WakeState) => void): ScreenHold {
  let wanted = true;
  let sentinel: Sentinel | null = null;
  let last: WakeState | null = null;
  const tell = (s: WakeState) => {
    if (s !== last) onState(s);
    last = s;
  };
  const take = async () => {
    const wl = api();
    if (!wl) return tell('unsupported');
    const shown = typeof document === 'undefined' || document.visibilityState === 'visible';
    if (!wanted || sentinel || !shown) return;
    try {
      const s = await wl.request('screen');
      if (!wanted) {
        void s.release().catch(() => {});
        return;
      }
      sentinel = s;
      s.addEventListener?.('release', () => {
        if (sentinel === s) sentinel = null;
      });
      tell('held');
    } catch {
      tell('refused');
    }
  };
  const drop = () => {
    const s = sentinel;
    sentinel = null;
    if (s) void s.release().catch(() => {});
  };
  // The browser lets it go when the page is hidden: taken again on return.
  const onVisible = () => {
    if (document.visibilityState === 'visible') {
      drop();
      void take();
    }
  };
  const watch = typeof document !== 'undefined';
  if (watch) document.addEventListener('visibilitychange', onVisible);
  void take();
  return {
    release: () => {
      wanted = false;
      drop();
    },
    hold: () => {
      wanted = true;
      void take();
    },
    end: () => {
      wanted = false;
      drop();
      if (watch) document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
