/**
 * When to look for new comments. No notifications in slice 1: the client polls with
 * If-None-Match (a 304 is cheap), every 30 s while the panel or a thread is open and every
 * 2 min otherwise, only while the tab is visible (once at once when it comes back or gains
 * focus), and every 5 min after errors. One timer, jittered ±10%.
 */
export const POLL_ACTIVE_MS = 30_000;
export const POLL_IDLE_MS = 120_000;
export const POLL_ERROR_MS = 300_000;

export interface PollerDeps {
  /** Fetches; resolves true on success (a 304 included), false on an error. */
  fetch: (signal: AbortSignal) => Promise<boolean>;
  /** The panel or a thread is open. */
  active: () => boolean;
  visible: () => boolean;
  random?: () => number;
}

export interface Poller {
  /** Fetches now (unless one is in flight) and schedules the next. */
  poke: () => void;
  /** The tab was hidden or shown. Hidden: the fetch in flight is aborted, no timer runs. */
  visibility: () => void;
  /** The panel opened or closed: the interval changes from now. */
  reschedule: () => void;
  stop: () => void;
}

export function createPoller(deps: PollerDeps): Poller {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: AbortController | null = null;
  let failing = false;
  let stopped = false;
  const random = deps.random ?? Math.random;

  const interval = () => {
    const base = failing ? POLL_ERROR_MS : deps.active() ? POLL_ACTIVE_MS : POLL_IDLE_MS;
    return base * (0.9 + 0.2 * random());
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = undefined;
    if (stopped || !deps.visible()) return;
    timer = setTimeout(poke, interval());
  };
  const poke = () => {
    if (stopped || !deps.visible()) return;
    if (inflight) return;
    const ctrl = new AbortController();
    inflight = ctrl;
    clearTimeout(timer);
    void deps
      .fetch(ctrl.signal)
      .then(
        (ok) => {
          if (!ctrl.signal.aborted) failing = !ok;
        },
        () => {
          if (!ctrl.signal.aborted) failing = true;
        },
      )
      .finally(() => {
        if (inflight === ctrl) inflight = null;
        if (!ctrl.signal.aborted) schedule();
      });
  };
  return {
    poke,
    visibility: () => {
      if (deps.visible()) {
        poke();
        return;
      }
      clearTimeout(timer);
      timer = undefined;
      inflight?.abort();
      inflight = null;
    },
    reschedule: () => {
      if (!inflight) schedule();
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      inflight?.abort();
      inflight = null;
    },
  };
}
