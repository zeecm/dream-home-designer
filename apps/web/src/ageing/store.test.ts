import { describe, expect, it, vi } from 'vitest';

// The stores read the browser's storage as they load: a stand-in for Node.
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

const { ageingKey, choiceOf, loadSetting, useAgeing } = await import('./store');

describe('the older person setting, per browser and project', () => {
  it('is Off for a project never checked, and for unreadable or stale data', () => {
    expect(loadSetting('prj_a')).toEqual({ profile: 'off' });
    data.set(ageingKey('prj_b'), '{not json');
    expect(loadSetting('prj_b')).toEqual({ profile: 'off' });
    data.set(ageingKey('prj_c'), JSON.stringify({ profile: 'skateboard' }));
    expect(loadSetting('prj_c')).toEqual({ profile: 'off' });
  });

  it('keeps each project’s choices under its own key, and Off with nothing chosen keeps none', () => {
    const s = useAgeing.getState();
    s.load('prj_1');
    useAgeing.getState().set({ profile: 'wheelchair', bedroomId: 'rm_b' });
    expect(JSON.parse(data.get(ageingKey('prj_1')) ?? '{}')).toEqual({
      profile: 'wheelchair',
      bedroomId: 'rm_b',
    });
    // The intro shows the first time it is turned on in this browser.
    expect(useAgeing.getState().intro).toBe(true);
    useAgeing.getState().load('prj_2');
    expect(useAgeing.getState().setting).toEqual({ profile: 'off' });
    useAgeing.getState().set({ profile: 'walking' });
    expect(useAgeing.getState().intro).toBe(false);
    useAgeing.getState().set({ profile: 'off' });
    expect(data.has(ageingKey('prj_2'))).toBe(false);
    useAgeing.getState().load('prj_1');
    expect(useAgeing.getState().setting.bedroomId).toBe('rm_b');
    // Clearing a room drops it.
    useAgeing.getState().set({ bedroomId: undefined });
    expect(useAgeing.getState().setting).toEqual({ profile: 'wheelchair' });
  });

  it('turning it off closes the list', () => {
    useAgeing.getState().load('prj_3');
    useAgeing.getState().set({ profile: 'wheelchair' });
    useAgeing.getState().openList();
    expect(useAgeing.getState().listOpen).toBe(true);
    useAgeing.getState().set({ profile: 'off' });
    expect(useAgeing.getState().listOpen).toBe(false);
  });

  it('the choice the check runs with', () => {
    expect(choiceOf({ profile: 'off', bedroomId: 'x' })).toBeNull();
    expect(choiceOf({ profile: 'walking', bathroomId: 'b', flatType: '4' })).toEqual({
      profile: 'walking',
      bathroomId: 'b',
    });
  });
});
