import { describe, expect, it } from 'vitest';
import { forgetRecent, isSample, recentProjects, rememberRecent } from './recent';

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

describe('recent plans', () => {
  it('keeps a sample’s flag when it is opened again or renamed', () => {
    const st = new MemoryStorage();
    rememberRecent({ id: 'a', name: 'My flat' }, st, true);
    rememberRecent({ id: 'b', name: 'Draft' }, st);
    rememberRecent({ id: 'a', name: 'Renamed' }, st);
    const [a, b] = recentProjects(st);
    expect(a?.id).toBe('a');
    expect(a && isSample(a)).toBe(true);
    expect(b && isSample(b)).toBe(false);
    expect(forgetRecent('b', st).map((r) => r.id)).toEqual(['a']);
  });

  it('knows sample copies from before the flag by their name', () => {
    expect(isSample({ id: 'x', name: '3-room HDB (sample)', openedAt: '' })).toBe(true);
    expect(isSample({ id: 'y', name: '3-room HDB (copy)', openedAt: '' })).toBe(false);
  });
});
