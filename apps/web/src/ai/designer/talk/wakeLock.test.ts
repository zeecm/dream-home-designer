import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type WakeState, holdScreen } from './wakeLock';

class Page extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
  turn(to: 'visible' | 'hidden') {
    this.visibilityState = to;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

/** A stubbed `navigator.wakeLock`, with its calls in order. */
function wakeLock(refuse = false) {
  const log: string[] = [];
  let n = 0;
  return {
    log,
    api: {
      request: async (type: string) => {
        const id = ++n;
        log.push(`request ${type} ${id}`);
        if (refuse) throw new DOMException('Not allowed', 'NotAllowedError');
        return {
          release: async () => {
            log.push(`release ${id}`);
          },
        };
      },
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the screen kept on while a design runs (criteria 7, 9)', () => {
  let page: Page;
  beforeEach(() => {
    page = new Page();
    vi.stubGlobal('document', page);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is taken at the start, again on each return to view, and let go at the end', async () => {
    const wl = wakeLock();
    vi.stubGlobal('navigator', { wakeLock: wl.api });
    const states: WakeState[] = [];
    const h = holdScreen((s) => states.push(s));
    await flush();
    expect(wl.log).toEqual(['request screen 1']);
    page.turn('hidden');
    page.turn('visible');
    await flush();
    page.turn('hidden');
    page.turn('visible');
    await flush();
    expect(wl.log.filter((l) => l.startsWith('request'))).toHaveLength(3);
    h.end();
    await flush();
    expect(wl.log.at(-1)).toBe('release 3');
    // Gone for good: a return to view takes nothing.
    page.turn('hidden');
    page.turn('visible');
    await flush();
    expect(wl.log.filter((l) => l.startsWith('request'))).toHaveLength(3);
    expect(states).toEqual(['held']);
  });

  it('is let go while the run waits at a limit, and taken again when it goes on', async () => {
    const wl = wakeLock();
    vi.stubGlobal('navigator', { wakeLock: wl.api });
    const h = holdScreen(() => {});
    await flush();
    h.release();
    await flush();
    expect(wl.log).toEqual(['request screen 1', 'release 1']);
    // Not taken on a return to view while it waits.
    page.turn('hidden');
    page.turn('visible');
    await flush();
    expect(wl.log).toHaveLength(2);
    h.hold();
    await flush();
    expect(wl.log.at(-1)).toBe('request screen 2');
    h.end();
  });

  it('says so, and nothing else changes, where it is refused or not there', async () => {
    const wl = wakeLock(true);
    vi.stubGlobal('navigator', { wakeLock: wl.api });
    const refused: WakeState[] = [];
    holdScreen((s) => refused.push(s)).end();
    await flush();
    expect(refused).toEqual(['refused']);
    vi.stubGlobal('navigator', {});
    const none: WakeState[] = [];
    const h = holdScreen((s) => none.push(s));
    await flush();
    expect(none).toEqual(['unsupported']);
    expect(() => h.end()).not.toThrow();
  });
});
