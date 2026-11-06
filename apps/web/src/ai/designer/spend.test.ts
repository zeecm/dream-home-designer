import type { Usage } from '@dhd/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** sessionStorage and localStorage for node. */
function storage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => {
      m.delete(k);
    },
    setItem: (k, v) => {
      m.set(k, String(v));
    },
  };
}

const use = (usd: number, output = 1000): Usage => ({
  step: 'layout',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  input: 500,
  cachedInput: 100,
  cacheWrite: 0,
  output,
  reasoning: null,
  estimated: false,
  usd,
  ms: 10,
});

describe('the tab’s meter and limit (28)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { sessionStorage: storage(), localStorage: storage() });
  });

  it('adds every request to sessionStorage, and a fresh load reads it back', async () => {
    const s = await import('./spend');
    s.reloadSpend();
    s.addUsage(use(0.25));
    s.addUsage(use(0.5, 2000));
    expect(s.spent().usd).toBeCloseTo(0.75, 6);
    expect(s.spent().tokens).toBe(1600 + 2600);
    expect(JSON.parse(window.sessionStorage.getItem('dhd-ai-spend') ?? '{}').usd).toBeCloseTo(0.75);
    s.reloadSpend();
    expect(s.spent().usd).toBeCloseTo(0.75, 6);
    s.resetSpend();
    expect(s.spent().usd).toBe(0);
  });

  it('US$5 by default; passing the limit is told before and during a run', async () => {
    const s = await import('./spend');
    s.reloadSpend();
    expect(s.capUsd()).toBe(5);
    s.addUsage(use(4.5));
    expect(s.wouldPass(0.4)).toBe(false);
    expect(s.wouldPass(0.6)).toBe(true);
    expect(s.overLimit()).toBe(false);
    s.setCap(1);
    expect(window.localStorage.getItem('dhd-ai-cap')).toBe('1');
    expect(s.overLimit()).toBe(true);
    s.setCap(null);
    expect(s.overLimit()).toBe(false);
    s.reloadSpend();
    expect(s.capUsd()).toBeNull();
  });

  it('keeps the person’s own prices per model, over the list prices', async () => {
    const s = await import('./spend');
    s.reloadSpend();
    expect(s.priceTable()['claude-opus-5-5']?.output).toBe(20);
    s.setPrice('claude-opus-5-5', {
      input: 1,
      cachedInput: 0.1,
      cacheWrite: 1.25,
      output: 5,
      checked: true,
    });
    s.reloadSpend();
    expect(s.priceTable()['claude-opus-5-5']?.output).toBe(5);
    expect(s.hasOverride('claude-opus-5-5')).toBe(true);
    s.setPrice('claude-opus-5-5', null);
    expect(s.priceTable()['claude-opus-5-5']?.output).toBe(20);
    expect(s.usd(0.873)).toBe('US$0.87');
    expect(s.usd(12.4)).toBe('US$12');
  });

  it('never trusts a price that would hide spending: empty, zero or broken ones are refused', async () => {
    const s = await import('./spend');
    expect(s.priceInput('')).toBeNull();
    expect(s.priceInput('  ')).toBeNull();
    expect(s.priceInput('abc')).toBeNull();
    expect(s.priceInput('-1')).toBeNull();
    expect(s.priceInput('0.2')).toBe(0.2);
    const p = { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20, checked: false };
    expect(s.validPrice(p)).toEqual(p);
    expect(s.validPrice({ ...p, input: 0 })).toBeNull();
    expect(s.validPrice({ ...p, output: Number.NaN })).toBeNull();
    expect(s.validPrice({ ...p, cachedInput: undefined })).toBeNull();
    expect(s.setPrice('claude-opus-5-5', { ...p, output: 0 })).toBe(false);
    // A bad price already stored is dropped on load: the list price applies again.
    window.localStorage.setItem(
      'dhd-ai-prices',
      JSON.stringify({ 'claude-opus-5-5': { input: 'x', output: 0 }, 'gpt-5': p }),
    );
    s.reloadSpend();
    expect(s.priceTable()['claude-opus-5-5']?.output).toBe(20);
    expect(s.hasOverride('claude-opus-5-5')).toBe(false);
    expect(s.hasOverride('gpt-5')).toBe(true);
  });
});
