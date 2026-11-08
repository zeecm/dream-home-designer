import {
  type Conversation,
  type Level,
  type Proposal,
  defaultBrief,
  sampleFlatProject,
  talk,
} from '@dhd/core';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { numberFor } from '../storage';
import { dayMark } from './days';
import { Unreadable, Unsaved, openTalk } from './talkStore';

const level = sampleFlatProject('prj_a').levels[0] as Level;
const AT = '2026-11-07T10:00:00.000Z';

const started = (projectId = 'prj_a'): Conversation =>
  talk({} as Conversation, {
    type: 'start',
    id: 'conv1',
    at: AT,
    projectId,
    levelId: level.id,
    brief: defaultBrief(),
    beforeFp: 'fp0',
    afterFp: null,
    nextN: 1,
    level,
    form: null,
    ids: ['t1', 't2'],
  });

const proposal = (id: string, projectId = 'prj_a'): Proposal => ({
  projectId,
  id,
  conversationId: 'conv1',
  recordVersion: 1,
  n: 1,
  turnId: 't9',
  at: AT,
  scope: { label: 'Kitchen', spaces: ['rm_kitchen'], all: false },
  words: '',
  options: [
    {
      letter: 'A',
      name: 'Kitchen',
      designId: 'dsn_1',
      brief: defaultBrief(),
      aliases: {},
      concept: null,
      spaces: {},
      locks: [],
      usage: [],
      base: { variant: 'before', fingerprint: 'fp0' },
      status: 'running',
      ticks: null,
      accepted: [],
      waivers: [],
      version: null,
      note: null,
    },
  ],
});

describe('the conversation store (dhd-talk)', () => {
  it('two writers reading and writing in turn never lose each other’s change', async () => {
    const s = await openTalk(new IDBFactory());
    expect(s.memory).toBe(false);
    await s.apply('prj_a', () => started());
    // Two tabs' free actions, applied to the record as each reads it.
    await Promise.all([
      s.apply('prj_a', (c) =>
        c
          ? talk(c, {
              type: 'decisionAdd',
              id: 'd1',
              at: AT,
              kind: 'wish',
              text: 'A piano',
              from: null,
            })
          : c,
      ),
      s.apply('prj_a', (c) =>
        c
          ? talk(c, {
              type: 'decisionAdd',
              id: 'd2',
              at: AT,
              kind: 'keep',
              text: 'The shoe cabinet',
              from: null,
            })
          : c,
      ),
    ]);
    const c = await s.get('prj_a');
    expect(c?.decisions.map((d) => d.id).sort()).toEqual(['d1', 'd2']);
    expect(c?.rev).toBe(3);
  });

  it('a write that changes nothing is not written', async () => {
    const s = await openTalk(new IDBFactory());
    const first = await s.apply('prj_a', () => started());
    const same = await s.apply('prj_a', () => null);
    expect(same?.rev).toBe(first?.rev);
  });

  it('removing a plan removes its conversation, proposals and levels, not another plan’s', async () => {
    const s = await openTalk(new IDBFactory());
    for (const p of ['prj_a', 'prj_b']) {
      await s.apply(p, () => started(p));
      await s.applyProposal(p, 'prop1', () => proposal('prop1', p));
      await s.putLevel(p, level);
    }
    const fp = await s.putLevel('prj_a', level);
    expect(await s.getLevel('prj_a', fp)).toEqual(level);
    await s.removeProject('prj_a');
    expect(await s.get('prj_a')).toBeNull();
    expect(await s.proposals('prj_a')).toEqual([]);
    expect(await s.getLevel('prj_a', fp)).toBeNull();
    expect(await s.get('prj_b')).not.toBeNull();
    expect(await s.proposals('prj_b')).toHaveLength(1);
  });

  it('Start over removes the old conversation’s proposals only (both stores)', async () => {
    for (const s of [await openTalk(new IDBFactory()), await openTalk(undefined)]) {
      await s.applyProposal('prj_a', 'p_old', () => proposal('p_old'));
      await s.applyProposal('prj_a', 'p_new', () => ({
        ...proposal('p_new'),
        conversationId: 'conv2',
      }));
      await s.applyProposal('prj_b', 'p_b', () => proposal('p_b', 'prj_b'));
      await s.removeProposals('prj_a', 'conv2');
      expect((await s.proposals('prj_a')).map((p) => p.id)).toEqual(['p_new']);
      expect((await s.proposals('prj_b')).map((p) => p.id)).toEqual(['p_b']);
      // The levels no record names any more go; another plan's stay.
      const kept = await s.putLevel('prj_a', level);
      const moved = structuredClone(level);
      const v = Object.values(moved.vertices)[0];
      if (v) v.x += 1;
      const other = await s.putLevel('prj_a', moved);
      const theirs = await s.putLevel('prj_b', moved);
      expect(other).not.toBe(kept);
      await s.sweepLevels('prj_a', [kept]);
      expect(await s.getLevel('prj_a', kept)).not.toBeNull();
      expect(await s.getLevel('prj_a', other)).toBeNull();
      expect(await s.getLevel('prj_b', theirs)).not.toBeNull();
    }
  });

  it('a record that wouldn’t read back is never written; nothing is lost', async () => {
    const s = await openTalk(new IDBFactory());
    await s.apply('prj_a', () => started());
    await expect(
      s.apply('prj_a', (c) => (c ? { ...c, draft: 'x'.repeat(5000) } : c)),
    ).rejects.toBeInstanceOf(Unsaved);
    expect((await s.get('prj_a'))?.draft).toBe('');
  });

  const putRaw = (idb: IDBFactory, rec: unknown) =>
    new Promise<void>((resolve, reject) => {
      const req = idb.open('dhd-talk', 1);
      req.onsuccess = () => {
        const tx = req.result.transaction('conversations', 'readwrite');
        tx.objectStore('conversations').put(rec);
        tx.oncomplete = () => {
          req.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });

  it('a newer build’s record is kept as it is: never set aside, never overwritten', async () => {
    const idb = new IDBFactory();
    const s = await openTalk(idb);
    await s.apply('prj_a', () => started());
    // A newer build's record, as it would be stored (a tab of this build left open across a
    // deploy).
    await putRaw(idb, { ...started(), recordVersion: 9, draft: 'from the newer build' });
    expect(await s.get('prj_a')).toBeNull();
    await expect(s.apply('prj_a', () => started())).rejects.toBeInstanceOf(Unreadable);
    expect(await s.setAside('prj_a')).toBe('newer');
    expect(await s.setAside('prj_a')).toBe('newer');
    await expect(s.apply('prj_a', () => started())).rejects.toBeInstanceOf(Unreadable);
  });

  it('an unreadable record of this version is set aside, kept, and a new one can start', async () => {
    const idb = new IDBFactory();
    const s = await openTalk(idb);
    await s.apply('prj_a', () => started());
    await putRaw(idb, { ...started(), turns: 'not a list' });
    expect(await s.get('prj_a')).toBeNull();
    await expect(s.apply('prj_a', () => started())).rejects.toBeInstanceOf(Unreadable);
    expect(await s.setAside('prj_a')).toBe('aside');
    expect(await s.setAside('prj_a')).toBe('none');
    expect((await s.apply('prj_a', () => started()))?.id).toBe('conv1');
  });
});

describe('versions and days', () => {
  it('an accepted proposal keeps its number when it is free, else takes the next', () => {
    const d = (n: number) => ({ n }) as never;
    expect(numberFor([d(1), d(2)], 4)).toBe(4);
    expect(numberFor([d(1), d(4)], 4)).toBe(5);
    expect(numberFor([], undefined)).toBe(1);
  });

  it('day marks read Today, Yesterday, then the weekday and date', () => {
    const now = new Date(2026, 10, 7, 12);
    expect(dayMark(new Date(2026, 10, 7, 9).toISOString(), now)).toBe('Today');
    expect(dayMark(new Date(2026, 10, 6, 23).toISOString(), now)).toBe('Yesterday');
    expect(dayMark(new Date(2026, 10, 4, 10).toISOString(), now)).toBe('Wed 4 Nov');
  });
});

describe('a run’s checkpoint in its option (locked-phone runs, part 1)', () => {
  const run = {
    id: 'run_1',
    startedAt: AT,
    at: AT,
    provider: 'anthropic' as const,
    model: 'claude-opus-5-5',
    plan: { layout: {}, rooms: 'all' as const },
    layout: 'done' as const,
    rooms: ['rm_kitchen', 'rm_bedroom'],
    fixesLeft: 2,
    approved: 0.9,
    spent: 0.3,
    inflight: [{ step: 'rm_bedroom', high: 0.12 }],
    stopped: false,
    paused: null,
    times: [{ kind: 'room' as const, ms: 31_000 }],
  };
  const withRun = (r: unknown) => {
    const p = proposal('prop1');
    return { ...p, options: [{ ...p.options[0], run: r }] } as Proposal;
  };

  it('is kept with the rooms it saved, and read back as written', async () => {
    const s = await openTalk(new IDBFactory());
    await s.applyProposal('prj_a', 'prop1', () => withRun(run));
    const [back] = await s.proposals('prj_a');
    expect(back?.options[0]?.run).toEqual(run);
  });

  it('one that can’t be read is dropped, never the proposal with it', async () => {
    const s = await openTalk(new IDBFactory());
    await s.applyProposal('prj_a', 'prop1', () => withRun({ ...run, fixesLeft: -1 }));
    const [back] = await s.proposals('prj_a');
    expect(back?.id).toBe('prop1');
    expect(back?.options[0]?.run).toBeUndefined();
  });
});
