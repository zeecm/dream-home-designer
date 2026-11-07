import { describe, expect, it, vi } from 'vitest';

// A stand-in for the browser: its storage and address.
const env = vi.hoisted(() => {
  const data = new Map<string, string>();
  const g = globalThis as unknown as Record<string, unknown>;
  const loc = { search: '' };
  g.window = globalThis;
  g.location = loc;
  g.localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
    removeItem: (k: string) => data.delete(k),
  };
  return { data, loc };
});

const { AGEING_FLAG, ageingEnabled, resetFeatures } = await import('./features');

describe('the Older person check is on hold', () => {
  it('is off unless turned on, by the address (remembered) or the browser', () => {
    expect(ageingEnabled()).toBe(false);
    env.loc.search = '?p=prj_a&ageing=1';
    resetFeatures();
    expect(ageingEnabled()).toBe(true);
    expect(env.data.get(AGEING_FLAG)).toBe('1');
    env.loc.search = '';
    resetFeatures();
    expect(ageingEnabled()).toBe(true);
    env.loc.search = '?ageing=0';
    resetFeatures();
    expect(ageingEnabled()).toBe(false);
    expect(env.data.has(AGEING_FLAG)).toBe(false);
  });
});
