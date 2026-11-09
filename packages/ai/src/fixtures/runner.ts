import { vi } from 'vitest';
import type { Page } from '../page';
import type { RunOptions, RunState } from '../run';
import { provider, start } from './flat';

export * from './flat';

/**
 * The runner's test harness: the sample flat and its mocked provider (`flat`), the wait for
 * streams and promises under fake timers, and a page that can be hidden and shown (a locked
 * phone). Shared by this package's tests and the web app's (a run carried on from its
 * checkpoint).
 */

/** Lets streams and promises run (timers stay put unless asked). */
export async function until(cond: () => boolean, what = 'condition') {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await vi.advanceTimersByTimeAsync(0);
  }
  throw new Error(`never: ${what}`);
}

/** A page to run on, and the way to hide and show it (a phone locked, then unlocked). */
export interface Phone {
  page: Page;
  turn: (to: 'visible' | 'hidden') => void;
}

/** A page of the tests' own, as the browser's document would say it. */
export function fakePhone(): Phone {
  const target = new EventTarget();
  let state: 'visible' | 'hidden' = 'visible';
  const on = (type: string) => (fn: () => void) => {
    target.addEventListener(type, fn);
    return () => target.removeEventListener(type, fn);
  };
  return {
    page: {
      hidden: () => state === 'hidden',
      offline: () => false,
      onVisibility: on('visibilitychange'),
      onOnline: on('online'),
    },
    turn: (to) => {
      state = to;
      target.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

/** A whole flat with rooms 1 and 2 done, rooms 3 and 4 in flight; room 3's label. */
export async function midRun(phone: Phone, extra: Partial<RunOptions> = {}) {
  const prov = provider('anthropic');
  const r = start('anthropic', { page: phone.page, fetch: prov.fetch, ...extra });
  await until(() => prov.calls.length === 1, 'layout');
  prov.calls[0]?.release();
  await until(() => prov.calls.length === 4, 'rooms 1 to 3');
  prov.calls[1]?.release();
  prov.calls[2]?.release();
  await until(() => prov.calls.length === 5, 'room 4');
  const room3 = prov.calls[3]?.step as string;
  const of = (step: string) => prov.calls.filter((c) => c.step === step);
  return { prov, r, room3, of };
}

/** A step's row, by the fixture's step name ('furnish "Living' is Living and dining). */
export const rowOf = (state: RunState, step: string) => {
  const name = step.replace(/^furnish "/, '').replace(/"$/, '');
  return state.steps.find((s) => s.label.startsWith(name));
};

/** Cut off while hidden, and away `ms` before the page is back. */
export async function away(
  phone: Phone,
  r: Awaited<ReturnType<typeof midRun>>['r'],
  cut: () => void,
  ms: number,
) {
  phone.turn('hidden');
  cut();
  await until(() => !!r.last()?.steps.some((s) => s.wait?.away), 'waiting for the page');
  await vi.advanceTimersByTimeAsync(ms);
}
