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

const { STORAGE_SEEN_KEY, loadStorage, meterSetting, setMeterAmount, storageKey, useStorage } =
  await import('./store');
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

  it('the designer reads a project’s setting whether or not the meter has it open, and sets how much they own', () => {
    useStorage.getState().load('prj_5');
    data.set(
      storageKey('prj_6'),
      JSON.stringify({ ...DEFAULT, people: { rm_a: { adults: 1, children: 0 } } }),
    );
    // Read from what this browser kept, never loaded into the meter.
    expect(meterSetting('prj_6').people).toEqual({ rm_a: { adults: 1, children: 0 } });
    expect(useStorage.getState().projectId).toBe('prj_5');
    // "How much do you own?" answered in the designer: the meter's own amount, kept.
    setMeterAmount('prj_6', 'lots');
    expect(useStorage.getState().projectId).toBe('prj_6');
    expect(meterSetting('prj_6').amount).toBe('lots');
    expect(JSON.parse(data.get(storageKey('prj_6')) ?? '{}').amount).toBe('lots');
  });

  it('a room back to its beds drops its entry', () => {
    useStorage.getState().load('prj_3');
    useStorage.getState().setPeople('rm_a', { adults: 2, children: 0 });
    useStorage.getState().setPeople('rm_a', null);
    expect(useStorage.getState().setting.people).toEqual({});
  });

  it('people edited in the renovation go under the room in the flat as it is; gone rooms drop', () => {
    useStorage.getState().load('prj_4');
    useStorage.getState().setPeople('rm_gone', { adults: 1, children: 0 });
    const alias = new Map([['rm_after', 'rm_before']]);
    const known = new Set(['rm_before', 'rm_after']);
    useStorage.getState().setPeople('rm_after', { adults: 2, children: 1 }, alias, known);
    expect(useStorage.getState().setting.people).toEqual({ rm_before: { adults: 2, children: 1 } });
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
