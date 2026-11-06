import { describe, expect, it } from 'vitest';
import { watchVisualViewport } from './sheetViewport';

class FakeViewport extends EventTarget {
  offsetTop = 0;
  height = 844;
}

describe('watchVisualViewport', () => {
  it('follows the visual viewport as a keyboard opens and closes, until stopped', () => {
    const vars = new Map<string, string>();
    const root = { style: { setProperty: (k: string, v: string | null) => vars.set(k, v ?? '') } };
    const vv = new FakeViewport();
    const stop = watchVisualViewport(root, vv as unknown as VisualViewport);
    expect(vars.get('--vv-height')).toBe('844px');
    expect(vars.get('--vv-top')).toBe('0px');

    // The keyboard opens and the page scrolls to the field.
    vv.height = 508;
    vv.offsetTop = 120;
    vv.dispatchEvent(new Event('resize'));
    expect(vars.get('--vv-height')).toBe('508px');
    expect(vars.get('--vv-top')).toBe('120px');

    stop();
    vv.height = 844;
    vv.dispatchEvent(new Event('resize'));
    expect(vars.get('--vv-height')).toBe('508px');
  });

  it('does nothing without a visual viewport', () => {
    const root = { style: { setProperty: () => {} } };
    expect(() => watchVisualViewport(root, null)()).not.toThrow();
  });
});
