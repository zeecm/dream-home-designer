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
const { furnitureKind, newItem } = await import('@dhd/core');
const { currentLevel } = await import('../store');
const { useEditor } = await import('../editor');

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
    // Clearance turned on (by keyboard: no release) with ageing on: walkways show too.
    startWalkways(true);
    flushWalkways();
    expect(useWalkways.getState().report).not.toBeNull();
    expect(useWalkways.getState().ageing).not.toBeNull();
    startAgeing(null);
    startWalkways(false);
    flushWalkways();
    expect(useWalkways.getState().ageing).toBeNull();
    expect(useWalkways.getState().level).toBeNull();
  });

  it('with clearance checks off, a sofa narrowing the way is still an ageing line', () => {
    startAgeing(null);
    startWalkways(false);
    const level = currentLevel();
    const kind = furnitureKind('sofa-3');
    if (!level || !kind) throw new Error('no sample level');
    // Across the corridor to the bedrooms (as the clearance e2e drags it), shown as a level
    // the runner checks (a designer's version on show: no edit needed).
    const sofa = newItem('it_runner_sofa', kind, { x: 5.5, y: 3.75 }, 0);
    const withSofa = Object.freeze({ ...level, items: { ...level.items, [sofa.id]: sofa } });
    useEditor.setState({
      preview: { level: withSofa, before: level, label: 'V2', side: 'version' },
    });
    startAgeing({ profile: 'walking' });
    flushWalkways();
    const s = useWalkways.getState();
    expect(s.report).toBeNull();
    const routes = s.ageing?.issues.filter((i) => i.kind === 'route') ?? [];
    expect(routes.some((i) => i.itemIds.includes('it_runner_sofa'))).toBe(true);
    expect(s.ageing?.passed.some((p) => p.kind === 'route')).toBe(false);
    useEditor.setState({ preview: null });
  });
});
