/**
 * Errors and usage, sent to the API Worker (/api/telemetry): errors land in its logs and
 * usage events in Analytics Engine. Nothing identifies the person or the plan: no project
 * ids, no plan content, no address beyond the page's path. Each event goes once per visit,
 * and at most a few errors.
 */
const ENDPOINT = '/api/telemetry';
const sent = new Set<string>();
let errors = 0;

function post(body: Record<string, string>) {
  try {
    const blob = new Blob([JSON.stringify(body)], { type: 'text/plain' });
    if (navigator.sendBeacon?.(ENDPOINT, blob)) return;
    void fetch(ENDPOINT, { method: 'POST', body: blob, keepalive: true }).catch(() => {});
  } catch {
    // Telemetry never gets in the way.
  }
}

export type UsageEvent =
  | 'open-sample'
  | 'new-plan'
  | 'upload-plan'
  | 'calibrate'
  | 'first-wall'
  | 'first-room'
  | 'walk'
  | 'furnish'
  | 'renovation'
  | 'share'
  | 'download'
  | 'restore-version';

/** Counts a step of using the app, once per visit (per detail). */
export function track(name: UsageEvent, detail = '') {
  const key = `${name}:${detail}`;
  if (sent.has(key) || import.meta.env.MODE === 'test') return;
  sent.add(key);
  post({ kind: 'event', name, detail });
}

/** Reports an error the app didn't handle; the same message once, ten per visit at most. */
export function reportError(error: unknown) {
  const e = error instanceof Error ? error : new Error(String(error));
  const key = `error:${e.message}`;
  if (sent.has(key) || errors >= 10 || import.meta.env.MODE === 'test') return;
  sent.add(key);
  errors++;
  post({
    kind: 'error',
    message: e.message,
    stack: e.stack ?? '',
    path: window.location.pathname,
    build: import.meta.env.MODE,
  });
}

/** Catches what nothing else did. */
export function watchErrors() {
  window.addEventListener('error', (e) => reportError(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason));
}
