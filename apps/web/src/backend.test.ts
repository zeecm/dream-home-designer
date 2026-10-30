import { blankProject } from '@dhd/core';
import { describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, localBackend } from './backend';

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

describe('localBackend', () => {
  it('round-trips a project with API-like versioning', async () => {
    const b = localBackend(new MemoryStorage());
    const created = await b.create(blankProject('Flat', 'prj_a'));
    expect(created.version).toBe(1);
    const v2 = await b.save({ ...created, name: 'Flat 2' });
    expect(v2).toBe(2);
    const got = await b.get('prj_a');
    expect(got).toMatchObject({ name: 'Flat 2', version: 2 });
    expect((await b.list()).map((p) => p.id)).toEqual(['prj_a']);
  });

  it('rejects stale saves and duplicate creates with ConflictError', async () => {
    const b = localBackend(new MemoryStorage());
    const doc = await b.create(blankProject('Flat', 'prj_a'));
    await b.save(doc);
    await expect(b.save(doc)).rejects.toEqual(new ConflictError(2));
    await expect(b.create(doc)).rejects.toBeInstanceOf(ConflictError);
  });

  it('reports missing projects as NotFoundError and can remove', async () => {
    const b = localBackend(new MemoryStorage());
    await expect(b.get('nope')).rejects.toBeInstanceOf(NotFoundError);
    await b.create(blankProject('Flat', 'prj_a'));
    await b.remove('prj_a');
    expect(await b.list()).toEqual([]);
  });
});
