import type { CommentsDoc } from '@dhd/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The plan's store reads the browser's storage as it loads: a stand-in for Node.
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

const { canComment, useComments } = await import('./store');

const doc = (version: number, epoch: string, text = 'Glass door?'): CommentsDoc => ({
  version,
  epoch,
  setting: 'all',
  threads: [
    {
      id: 't_1',
      anchor: { levelId: 'lvl_ground', variant: 'before', at: { x: 1, y: 2 }, label: 'Kitchen' },
      resolved: null,
      messages: [
        { id: 'm_1', name: 'Mum', role: 'viewer', text, at: '2026-11-06T09:00:00Z', mine: false },
      ],
    },
  ],
});

const answer = (status: number, body?: CommentsDoc, etag = '') =>
  new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: { 'Content-Type': 'application/json', ETag: etag, 'X-Role': 'viewer' },
  });

describe('the comments store', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps what it has on a 304, drops an older answer, and takes a new epoch', async () => {
    useComments.setState({
      projectId: 'prj_a',
      status: 'ready',
      doc: doc(3, 'e1'),
      etag: '"e1.3"',
    });
    const fetch = vi.fn(async () => answer(304));
    vi.stubGlobal('fetch', fetch);
    await useComments.getState().refresh();
    expect(useComments.getState().doc?.version).toBe(3);
    const sent = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((sent.headers as Record<string, string>)['If-None-Match']).toBe('"e1.3"');

    // A slow poll that answers with an older version of the same comments is dropped.
    vi.stubGlobal('fetch', async () => answer(200, doc(2, 'e1', 'old'), '"e1.2"'));
    await useComments.getState().refresh(true);
    expect(useComments.getState().doc?.version).toBe(3);

    // The plan was deleted and made again: version 1 of another epoch replaces it.
    vi.stubGlobal('fetch', async () => answer(200, doc(1, 'e2', 'new'), '"e2.1"'));
    await useComments.getState().refresh();
    expect(useComments.getState().doc?.epoch).toBe('e2');
    expect(useComments.getState().etag).toBe('"e2.1"');
  });

  it('works out rights from the role and the owner’s setting', () => {
    expect(canComment('viewer', 'all')).toBe(true);
    expect(canComment('viewer', 'edit')).toBe(false);
    expect(canComment('editor', 'edit')).toBe(true);
    expect(canComment('editor', 'off')).toBe(false);
    expect(canComment('owner', 'off')).toBe(true);
    expect(canComment('open', 'edit')).toBe(true);
  });
});
