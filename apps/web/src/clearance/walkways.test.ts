import { describe, expect, it, vi } from 'vitest';

// The stores read the browser's storage as they load: a stand-in for Node.
vi.hoisted(() => {
  const data = new Map<string, string>();
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = globalThis;
  g.addEventListener = () => {};
  g.removeEventListener = () => {};
  g.localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
    removeItem: (k: string) => data.delete(k),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
});

const { flushWalkways, startAgeing, startWalkways, useWalkways } = await import('./walkways');

describe('the walkway runner', () => {
  it('runs the ageing check with clearance checks off, and stops it when it is off', () => {
    startWalkways(false);
    flushWalkways();
    expect(useWalkways.getState().report).toBeNull();
    expect(useWalkways.getState().ageing).toBeNull();
    startAgeing({ profile: 'wheelchair' });
    flushWalkways();
    const s = useWalkways.getState();
    expect(s.report).toBeNull();
    expect(s.ageing?.profile).toBe('wheelchair');
    expect(s.level).not.toBeNull();
    // Another choice runs again on the same level.
    startAgeing({ profile: 'walking' });
    flushWalkways();
    expect(useWalkways.getState().ageing?.profile).toBe('walking');
    // Both on: one pass, both reports.
    startWalkways(true);
    flushWalkways(true);
    expect(useWalkways.getState().report).not.toBeNull();
    expect(useWalkways.getState().ageing).not.toBeNull();
    startAgeing(null);
    startWalkways(false);
    flushWalkways(true);
    expect(useWalkways.getState().ageing).toBeNull();
    expect(useWalkways.getState().level).toBeNull();
  });
});
