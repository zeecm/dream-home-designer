import { type Level, sampleFlatProject } from '@dhd/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { anthropicStream } from '../../../../../../packages/ai/src/fixtures/streams';
import { REPLY_PLAN } from '../../../../../../packages/core/src/designer/talk/fixtures/replies';

/**
 * A Send's reply under the plan's reply lock (tech-lead B1): whatever fails after the paid call
 * (its plan priced, a save refused) is said, and the call is never made again.
 */

const project = sampleFlatProject('prj_turn');

vi.mock('../../../store', () => ({
  useStore: create(() => ({
    editor: { doc: project, history: { past: [], future: [] } },
    role: 'owner',
  })),
  shownLevelId: () => project.levels[0]?.id,
}));
vi.mock('../state', () => ({
  designOpts: () => ({}),
  setHouseRules: () => {},
  setHouseKept: () => {},
  houseKeptFor: () => [],
  houseRulesFor: () => [],
  useDesigner: create(() => ({
    designs: [],
    panel: true,
    run: null,
    starting: false,
    previewing: false,
  })),
  getBrief: async () => null,
  loadDesigns: async () => {},
  putBrief: async () => {},
}));
vi.mock('../../credentials', async (orig) => ({
  ...(await orig<typeof import('../../credentials')>()),
  aiSettings: () => ({ provider: 'anthropic', key: 'sk-ant-test-0000', model: 'claude-opus-5-5' }),
}));
const followPlan = vi.fn(async () => {
  throw new Error('the plan’s rooms aren’t on this plan');
});
vi.mock('./propose', () => ({ followPlan: (...a: unknown[]) => followPlan(...(a as [])) }));

/** A Web Lock as browsers have it: the callback's own error rejects the request. */
function locks() {
  return {
    request: async (_n: string, _o: unknown, fn: (lock: unknown) => Promise<unknown>) =>
      fn({ name: 'dhd-talk' }),
    query: async () => ({ held: [] }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a Send under the reply lock', () => {
  it('a plan that fails to price after the reply: said once, and only one talk call', async () => {
    let calls = 0;
    vi.stubGlobal('navigator', { ...globalThis.navigator, onLine: true, locks: locks() });
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response(anthropicStream(REPLY_PLAN, { input: 1000, cached: 0, output: 300 }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const { ensureConversation, act, useTalk, talkLevel, newId, nowIso } = await import(
      './useTalk'
    );
    const { sendMessage } = await import('./turn');
    await ensureConversation();
    await act({
      type: 'justDesign',
      at: nowIso(),
      ids: [newId('turn'), newId('turn')],
      level: talkLevel() as Level,
    });
    expect(await sendMessage('Move the sofa off the window')).toBe(true);
    expect(calls).toBe(1);
    expect(followPlan).toHaveBeenCalledTimes(1);
    const turns = useTalk.getState().conv?.turns ?? [];
    expect(turns.some((t) => t.kind === 'designer' && t.talk?.kind === 'plan')).toBe(true);
    expect(
      turns.some(
        (t) =>
          t.kind === 'event' &&
          t.event.type === 'note' &&
          t.event.text === 'Couldn’t price the plan: the plan’s rooms aren’t on this plan.',
      ),
    ).toBe(true);
    expect(useTalk.getState().reply).toBeNull();
  });
});

describe('another tab’s reply: never cut off by guesswork', () => {
  /** A message left waiting for its reply, sent `ago` ms ago (by another tab, for all this one knows). */
  async function waiting(ago: number) {
    const { act, useTalk, newId } = await import('./useTalk');
    // One waits at a time: one left from before goes first.
    const pending = useTalk
      .getState()
      .conv?.turns.find((t) => t.kind === 'person' && t.reply?.state === 'pending');
    if (pending) {
      await act({
        type: 'replyFailed',
        turnId: pending.id,
        id: newId('turn'),
        at: new Date().toISOString(),
        error: 'x',
        text: '',
        usage: [],
      });
    }
    const id = newId('turn');
    await act({
      type: 'send',
      id,
      at: new Date(Date.now() - ago).toISOString(),
      text: 'Is the sofa too big?',
      sent: 'x',
    });
    return id;
  }
  const stateOf = async (id: string) => {
    const { useTalk } = await import('./useTalk');
    const t = useTalk.getState().conv?.turns.find((x) => x.id === id);
    return t?.kind === 'person' ? t.reply?.state : undefined;
  };

  it('a lock query that fails counts as another tab replying: nothing is cut off', async () => {
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      onLine: true,
      locks: { ...locks(), query: async () => Promise.reject(new Error('no')) },
    });
    const { otherTabReplying, recoverPending } = await import('./turn');
    expect(await otherTabReplying('prj_turn')).toBe(true);
    const id = await waiting(10 * 60_000);
    await recoverPending();
    expect(await stateOf(id)).toBe('pending');
  });

  it('without Web Locks a recent reply is left alone; one older than any reply is cut off', async () => {
    vi.stubGlobal('navigator', { ...globalThis.navigator, onLine: true, locks: undefined });
    const { recoverPending } = await import('./turn');
    const { QUIET_MS } = await import('@dhd/ai');
    const fresh = await waiting(1000);
    await recoverPending();
    expect(await stateOf(fresh)).toBe('pending');
    const old = await waiting(QUIET_MS + 60_000);
    await recoverPending();
    expect(await stateOf(old)).toBe('failed');
  });
});
