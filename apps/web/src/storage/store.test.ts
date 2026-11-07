import { describe, expect, it, vi } from 'vitest';

// The store reads the browser's storage as it loads: a stand-in for Node.
const data = vi.hoisted(() => {
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
  return data;
});

const { STORAGE_SEEN_KEY, loadStorage, storageKey, useStorage } = await import('./store');
const { ageingKey } = await import('../ageing/store');

const DEFAULT = {
  people: {},
  others: { adults: 0, children: 0 },
  amount: 'typical',
  shelter: true,
};

describe('the storage household, per browser and project', () => {
  it('is the default for a project never seen, and for unreadable data', () => {
    expect(loadStorage('prj_a')).toEqual(DEFAULT);
    data.set(storageKey('prj_b'), '{not json');
    expect(loadStorage('prj_b')).toEqual(DEFAULT);
  });

  it('keeps each project under its own key, apart from the ageing check, and the default as none', () => {
    useStorage.getState().load('prj_1');
    useStorage.getState().setPeople('rm_b', { adults: 1, children: 1 });
    useStorage.getState().set({ amount: 'lots' });
    expect(JSON.parse(data.get(storageKey('prj_1')) ?? '{}')).toEqual({
      ...DEFAULT,
      people: { rm_b: { adults: 1, children: 1 } },
      amount: 'lots',
    });
    expect(data.has(ageingKey('prj_1'))).toBe(false);
    useStorage.getState().load('prj_2');
    expect(useStorage.getState().setting).toEqual(DEFAULT);
    useStorage.getState().load('prj_1');
    expect(useStorage.getState().setting.amount).toBe('lots');
    // Back to the beds and Typical: nothing kept.
    useStorage.getState().resetPeople();
    useStorage.getState().set({ amount: 'typical' });
    expect(data.has(storageKey('prj_1'))).toBe(false);
  });

  it('a room back to its beds drops its entry', () => {
    useStorage.getState().load('prj_3');
    useStorage.getState().setPeople('rm_a', { adults: 2, children: 0 });
    useStorage.getState().setPeople('rm_a', null);
    expect(useStorage.getState().setting.people).toEqual({});
  });

  it('the intro shows the first time the panel opens in this browser', () => {
    data.delete(STORAGE_SEEN_KEY);
    useStorage.getState().openPanel();
    expect(useStorage.getState().intro).toBe(true);
    useStorage.getState().closePanel();
    useStorage.getState().openPanel();
    expect(useStorage.getState().intro).toBe(false);
    useStorage.getState().setHighlight('rm_a');
    useStorage.getState().closePanel();
    expect(useStorage.getState()).toMatchObject({ open: false, highlight: null });
  });
});
