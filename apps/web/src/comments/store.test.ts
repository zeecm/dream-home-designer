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

  it('a poll sent before the first comment never wipes it when it answers late', async () => {
    const empty: CommentsDoc = { version: 0, setting: 'all', threads: [] };
    useComments.setState({ projectId: 'prj_b', status: 'ready', doc: empty, etag: '"0"' });
    let answerPoll: (r: Response) => void = () => {};
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? answer(201, doc(1, 'e9'), '"e9.1"')
        : new Promise<Response>((r) => {
            answerPoll = r;
          }),
    );
    const poll = useComments.getState().refresh(true);
    useComments.getState().startDraft({
      levelId: 'lvl_ground',
      variant: 'before',
      at: { x: 1, y: 2 },
      label: 'Kitchen',
    });
    await useComments.getState().post('Glass door?', 'Mum');
    expect(useComments.getState().doc?.threads).toHaveLength(1);
    answerPoll(answer(200, empty, '"0"'));
    await poll;
    expect(useComments.getState().doc?.threads).toHaveLength(1);

    // Nor does a later answer without an epoch (no comments) replace comments with one.
    vi.stubGlobal('fetch', async () => answer(200, empty, '"0"'));
    await useComments.getState().refresh(true);
    expect(useComments.getState().doc?.epoch).toBe('e9');
  });

  it('a retry after a lost answer sends the same ids, so the server takes it once', async () => {
    useComments.setState({ projectId: 'prj_c', status: 'ready', doc: null, pending: [] });
    const bodies: { id: string; messageId: string }[] = [];
    let fail = true;
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (fail) throw new TypeError('network down');
      return answer(201, doc(1, 'e3'), '"e3.1"');
    });
    useComments.getState().startDraft({
      levelId: 'lvl_ground',
      variant: 'before',
      at: { x: 1, y: 2 },
      label: 'Kitchen',
    });
    await expect(useComments.getState().post('Glass door?', 'Mum')).rejects.toThrow();
    fail = false;
    await useComments.getState().post('Glass door?', 'Mum');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.id).toBe(bodies[0]?.id);
    expect(bodies[1]?.messageId).toBe(bodies[0]?.messageId);
    // Other words are another post, with other ids.
    useComments.getState().startDraft({
      levelId: 'lvl_ground',
      variant: 'before',
      at: { x: 1, y: 2 },
      label: 'Kitchen',
    });
    const first = useComments.getState().draft?.id;
    useComments.getState().renewDraft();
    expect(useComments.getState().draft?.id).not.toBe(first);
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
