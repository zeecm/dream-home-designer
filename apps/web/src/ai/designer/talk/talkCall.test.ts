import {
  type Conversation,
  type Level,
  aliasesFor,
  defaultBrief,
  sampleFlatProject,
  spacesOf,
  talk,
  talkPrompt,
} from '@dhd/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REPLY_PLAN as REPLY_PLAN_FIXTURE,
  REPLY_TEXT as REPLY_TEXT_FIXTURE,
} from '../../../../../../packages/core/src/designer/talk/fixtures/replies';
import type { AiSettings } from '../../credentials';
import { anthropicStream } from '../fixtures/streams';
import { NET_WAITS } from '../request';
import { type TalkCallResult, talkCall } from './talkCall';

const level = sampleFlatProject('prj_t').levels[0] as Level;
const aliases = aliasesFor(level);
const AI: AiSettings = { provider: 'anthropic', key: 'sk-ant-test-0000', model: 'claude-opus-5-5' };
const conv = talk({} as Conversation, {
  type: 'start',
  id: 'conv1',
  at: '2026-11-08T10:00:00.000Z',
  projectId: 'prj_t',
  levelId: level.id,
  brief: defaultBrief(),
  beforeFp: 'fp0',
  afterFp: null,
  nextN: 1,
  level,
  form: null,
  ids: ['t1', 't2'],
});
const prompt = talkPrompt({
  conv,
  level,
  before: level,
  aliases,
  message: 'Not the sofa under the window',
  events: [],
  onTable: [],
});
const parseCtx = {
  aliases,
  spaces: spacesOf(level).map((s) => ({ key: s.key, name: s.name, rooms: s.rooms })),
  walls: 'allowed' as const,
};

interface Held {
  body: Record<string, unknown>;
  signal: AbortSignal;
  release: () => void;
}

/**
 * A provider that sends a reply's first `head` characters of its stream at once, and the rest
 * when released; `reply` answers a call itself (a 429, a drop).
 */
function provider(
  answer: unknown,
  opts: { head?: number; reply?: (n: number) => Response | Error | null } = {},
) {
  const calls: Held[] = [];
  const fn = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const call: Held = { body, signal: init?.signal as AbortSignal, release };
    calls.push(call);
    const custom = opts.reply?.(calls.length);
    if (custom instanceof Error) throw custom;
    if (custom) return custom;
    const text = anthropicStream(answer, { input: 1000, cached: 3000, output: 400 });
    // Up to the middle of the text: the first pieces of the reply's JSON.
    const head = opts.head ?? text.indexOf('text_delta') + 200;
    const bytes = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        const abort = () =>
          ctrl.error(new DOMException('The operation was aborted.', 'AbortError'));
        call.signal.addEventListener('abort', abort, { once: true });
        ctrl.enqueue(bytes.encode(text.slice(0, head)));
        await gate;
        if (call.signal.aborted) return;
        ctrl.enqueue(bytes.encode(text.slice(head)));
        ctrl.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { calls, fetch: fn as typeof fetch };
}

async function until(cond: () => boolean, what = 'condition') {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await vi.advanceTimersByTimeAsync(10);
  }
  throw new Error(`never: ${what}`);
}

function start(doFetch: typeof globalThis.fetch) {
  const ctrl = new AbortController();
  const texts: string[] = [];
  let result: TalkCallResult | null = null;
  void talkCall({
    ai: AI,
    prompt,
    parseCtx,
    signal: ctrl.signal,
    fetch: doFetch,
    onText: (t) => texts.push(t.say),
  }).then((r) => {
    result = r;
  });
  return { ctrl, texts, result: () => result };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('talkCall', () => {
  it('the first words show before the stream ends; the reply is read at its end', async () => {
    const p = provider(REPLY_TEXT_FIXTURE);
    const s = start(p.fetch);
    await until(() => s.texts.some((t) => t.length > 0), 'first words');
    expect(s.result()).toBeNull();
    const first = s.texts.find((t) => t.length > 0) as string;
    expect(REPLY_TEXT_FIXTURE.say.startsWith(first)).toBe(true);
    expect(first.length).toBeLessThan(REPLY_TEXT_FIXTURE.say.length);
    p.calls[0]?.release();
    await until(() => s.result() !== null, 'the end');
    const r = s.result() as unknown as TalkCallResult;
    expect(r.status).toBe('done');
    if (r.status === 'done') expect(r.reply.say).toBe(REPLY_TEXT_FIXTURE.say);
    expect(r.usage).toHaveLength(1);
    expect(r.usage[0]?.estimated).toBe(false);
  });

  it('the request: the talk schema, the system prompt, the history as messages', () => {
    const p = provider(REPLY_TEXT_FIXTURE);
    void talkCall({
      ai: AI,
      prompt,
      parseCtx,
      signal: new AbortController().signal,
      fetch: p.fetch,
    });
    return until(() => p.calls.length > 0).then(() => {
      const b = p.calls[0]?.body as {
        system: { text: string }[];
        messages: { role: string }[];
        output_config: { format: { schema: { properties: Record<string, unknown> } } };
        max_tokens: number;
      };
      expect(Object.keys(b.output_config.format.schema.properties)).toContain('say');
      expect(b.system[0]?.text).toMatch(/interior designer/);
      expect(b.messages.at(-1)?.role).toBe('user');
      expect(b.max_tokens).toBe(4000);
      p.calls[0]?.release();
    });
  });

  it('Stop: the request is aborted, the text so far kept, its cost estimated (~)', async () => {
    const p = provider(REPLY_TEXT_FIXTURE);
    const s = start(p.fetch);
    await until(() => s.texts.some((t) => t.length > 0), 'first words');
    s.ctrl.abort();
    await until(() => s.result() !== null, 'stopped');
    expect(p.calls[0]?.signal.aborted).toBe(true);
    const r = s.result() as unknown as TalkCallResult;
    expect(r.status).toBe('stopped');
    expect(r.say.length).toBeGreaterThan(0);
    expect(r.usage[0]?.estimated).toBe(true);
  });

  it('a dropped connection is tried again and its text starts afresh', async () => {
    const p = provider(REPLY_TEXT_FIXTURE, {
      reply: (n) => (n === 1 ? new TypeError('Failed to fetch') : null),
    });
    const s = start(p.fetch);
    await until(() => p.calls.length === 2, 'tried again');
    p.calls[1]?.release();
    await vi.advanceTimersByTimeAsync((NET_WAITS[0] ?? 3) * 1000);
    await until(() => s.result() !== null, 'the end');
    expect((s.result() as unknown as TalkCallResult).status).toBe('done');
  });

  it('a 429 waits as it says, then goes through', async () => {
    const p = provider(REPLY_PLAN_FIXTURE, {
      reply: (n) =>
        n === 1
          ? new Response(
              JSON.stringify({
                type: 'error',
                error: { type: 'rate_limit_error', message: 'Slow' },
              }),
              {
                status: 429,
                headers: { 'retry-after': '2' },
              },
            )
          : null,
    });
    const s = start(p.fetch);
    await until(() => p.calls.length === 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(p.calls).toHaveLength(1);
    await until(() => p.calls.length === 2, 'after the wait');
    p.calls[1]?.release();
    await until(() => s.result() !== null, 'the end');
    const r = s.result() as unknown as TalkCallResult;
    expect(r.status).toBe('done');
    if (r.status === 'done') expect(r.reply.kind).toBe('plan');
  });

  it('unreadable twice: not answered, both attempts metered', async () => {
    const p = provider('{"kind": "reply", "say": ');
    const s = start(p.fetch);
    await until(() => p.calls.length === 1);
    p.calls[0]?.release();
    await until(() => p.calls.length === 2, 'asked once more');
    p.calls[1]?.release();
    await until(() => s.result() !== null, 'failed');
    const r = s.result() as unknown as TalkCallResult;
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.error).toMatch(/couldn’t be read/);
    expect(p.calls).toHaveLength(2);
    expect(r.usage).toHaveLength(2);
  });

  it('a refused key and a spent quota stop at once', async () => {
    for (const [status, type, kind] of [
      [401, 'authentication_error', 'key'],
      [402, 'billing_error', 'quota'],
    ] as const) {
      const p = provider(REPLY_TEXT_FIXTURE, {
        reply: () =>
          new Response(JSON.stringify({ type: 'error', error: { type, message: 'No' } }), {
            status,
          }),
      });
      const s = start(p.fetch);
      await until(() => s.result() !== null, kind);
      const r = s.result() as unknown as TalkCallResult;
      expect(r.status).toBe('halted');
      if (r.status === 'halted') expect(r.halt.kind).toBe(kind);
      expect(p.calls).toHaveLength(1);
    }
  });
});
