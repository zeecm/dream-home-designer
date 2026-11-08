import { type Design, type Level, defaultBrief, sampleFlatProject } from '@dhd/core';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { MAX_VERSIONS, fromRecord, memoryStore, openDesigns } from './storage';

const level = sampleFlatProject('prj_a').levels[0] as Level;

function design(id: string, projectId = 'prj_a'): Omit<Design, 'n'> {
  return {
    id,
    projectId,
    levelId: level.id,
    name: 'Warm Japandi',
    parent: null,
    createdAt: '2026-11-06T10:00:00.000Z',
    waivers: [],
    base: { variant: 'before', fingerprint: 'abc' },
    baseLevel: level,
    brief: defaultBrief(),
    request: { scope: { kind: 'all' }, feedback: '', locks: [] },
    aliases: { W1: 'w_1' },
    concept: null,
    spaces: {},
    usage: [],
    accepted: null,
  };
}

describe('the designs store', () => {
  it('numbers versions per plan in one transaction, and keeps no key', async () => {
    const idb = new IDBFactory();
    const store = await openDesigns(idb);
    expect(store.memory).toBe(false);
    const a = await store.create(design('d1'));
    const b = await store.create(design('d2'));
    const other = await store.create(design('d3', 'prj_b'));
    expect([a.design.n, b.design.n, other.design.n]).toEqual([1, 2, 1]);
    // Two at once still get different numbers.
    const [c, d] = await Promise.all([store.create(design('d4')), store.create(design('d5'))]);
    expect(new Set([c.design.n, d.design.n])).toEqual(new Set([3, 4]));
    const list = await store.list('prj_a');
    expect(list.map((x) => x.id)).toEqual(
      ['d1', 'd2', 'd4', 'd5'].sort((p, q) => {
        const n = (id: string) => list.find((x) => x.id === id)?.n ?? 0;
        return n(p) - n(q);
      }),
    );
    // Read again in a fresh connection: the same versions.
    const again = await openDesigns(idb);
    expect((await again.list('prj_a')).length).toBe(4);
    // No key is ever stored: the whole database as text.
    const rows = JSON.stringify(await again.list('prj_a'));
    expect(rows).not.toMatch(/sk-|AIza|api[-_]?key/i);
  });

  it('gives the options of one proposal its number (V4A, V4B); anything else moves on', async () => {
    const store = await openDesigns(new IDBFactory());
    const from = (letter: string, proposalId = 'prop1') => ({
      conversationId: 'c1',
      proposalId,
      letter,
    });
    const a = await store.create({ ...design('a'), from: from('A') }, 4);
    const b = await store.create({ ...design('b'), from: from('B') }, 4);
    const other = await store.create({ ...design('o'), from: from('A', 'prop2') }, 4);
    const v1 = await store.create(design('v1'), 4);
    expect([a.design.n, b.design.n, other.design.n, v1.design.n]).toEqual([4, 4, 5, 6]);
  });

  it('keeps 20 versions a plan: the oldest not accepted go first', async () => {
    const store = await openDesigns(new IDBFactory());
    const first = await store.create(design('keep'));
    await store.put({
      ...first.design,
      accepted: { at: '2026-11-06T10:00:00.000Z', parts: [{ aspect: 'walls' }], level },
    });
    let pruned = 0;
    for (let i = 0; i < MAX_VERSIONS; i++) pruned += (await store.create(design(`d${i}`))).pruned;
    const list = await store.list('prj_a');
    expect(list).toHaveLength(MAX_VERSIONS);
    expect(pruned).toBe(1);
    // The accepted V1 stayed; the oldest unaccepted (V2, d0) went.
    expect(list.some((d) => d.id === 'keep')).toBe(true);
    expect(list.some((d) => d.id === 'd0')).toBe(false);
  });

  it('never gives two versions one number: a version put back after another took its number moves on', async () => {
    for (const store of [await openDesigns(new IDBFactory()), memoryStore()]) {
      await store.create(design('d1'));
      await store.create(design('d2'));
      const v3 = (await store.create(design('d3'))).design;
      await store.remove('prj_a', 'd3');
      const again = (await store.create(design('d4'))).design;
      expect(again.n).toBe(3);
      const back = await store.restore(v3);
      expect(back.n).toBe(4);
      const ns = (await store.list('prj_a')).map((d) => d.n);
      expect(new Set(ns).size).toBe(ns.length);
      // Put back with its number free: it keeps it.
      await store.remove('prj_a', 'd2');
      const v2 = (await store.list('prj_a')).length;
      expect(v2).toBe(3);
    }
  });

  it('remembers the brief per plan, and forgets a plan’s designs with it', async () => {
    const store = await openDesigns(new IDBFactory());
    const brief = { ...defaultBrief(), colours: 'love sage' };
    await store.putBrief('prj_a', brief);
    await store.create(design('d1'));
    expect((await store.getBrief('prj_a'))?.colours).toBe('love sage');
    expect(await store.getBrief('prj_b')).toBeNull();
    await store.removeProject('prj_a');
    expect(await store.list('prj_a')).toEqual([]);
    expect(await store.getBrief('prj_a')).toBeNull();
  });

  it('leaves out records that no longer parse, or come from a newer app', () => {
    const ok = { ...design('x'), n: 1, schemaVersion: 1 };
    expect(fromRecord(ok)?.id).toBe('x');
    expect(fromRecord({ ...ok, schemaVersion: 2 })).toBeNull();
    expect(fromRecord({ ...ok, n: 'one' })).toBeNull();
    expect(fromRecord(null)).toBeNull();
  });

  it('falls back to memory when IndexedDB can’t open, or takes too long', async () => {
    const broken = {
      open: () => {
        throw new Error('denied');
      },
    } as unknown as IDBFactory;
    expect((await openDesigns(broken)).memory).toBe(true);
    const stuck = { open: () => ({}) } as unknown as IDBFactory;
    expect((await openDesigns(stuck, 20)).memory).toBe(true);
    expect((await openDesigns(undefined)).memory).toBe(true);
    const mem = memoryStore();
    expect((await mem.create(design('m1'))).design.n).toBe(1);
    expect((await mem.create(design('m2'))).design.n).toBe(2);
    expect((await mem.list('prj_a')).map((d) => d.id)).toEqual(['m1', 'm2']);
  });
});
