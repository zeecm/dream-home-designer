import {
  type DesignBrief,
  type Level,
  PRICES,
  type ProposalOption,
  type RunCheckpoint,
  aliasesFor,
  defaultBrief,
  designResult,
  sampleFlatProject,
  usageTotals,
} from '@dhd/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiSettings, Provider } from '../credentials';
import { answerFor, promptOf } from './fixtures/sample';
import { type FixtureUsage, anthropicStream, geminiStream, openaiStream } from './fixtures/streams';
import { type DraftDesign, QUIET_MS, type RunOptions, type RunState, runDesign } from './run';
import { designerCannotUse, requestFor } from './stream';
import {
  approvedLeft,
  figureHolds,
  priceRequest,
  resumeFigure,
  spentWithInflight,
} from './talk/pricing';

const level = sampleFlatProject('prj_test').levels[0] as Level;
const brief: DesignBrief = {
  ...defaultBrief(),
  household: { ...defaultBrief().household, elders: ['frame'] },
  budget: { low: 40_000, high: 60_000 },
};
const aliases = aliasesFor(level);
const ctx = { base: level, before: level, brief, aliases };
const AI: Record<Provider, AiSettings> = {
  anthropic: { provider: 'anthropic', key: 'sk-ant-test-0000', model: 'claude-opus-5-5' },
  openai: { provider: 'openai', key: 'sk-test-0000', model: 'gpt-5' },
  gemini: { provider: 'gemini', key: 'AIzaTest0000', model: 'gemini-2.5-pro' },
};
const USAGE: FixtureUsage = { input: 1000, cached: 3000, output: 2000, thoughts: 500 };
const STREAMS = { anthropic: anthropicStream, openai: openaiStream, gemini: geminiStream };

const fresh = (): DraftDesign => ({
  id: 'dsn_run',
  brief,
  aliases,
  concept: null,
  spaces: {},
  usage: [],
});

interface Call {
  step: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  signal: AbortSignal;
  release: () => void;
  /** Cuts its stream off part-way, as a locked phone or a dropped connection does. */
  cut: () => void;
  done: boolean;
}

/**
 * A provider that streams each answer's first event at once and the rest when released
 * (`auto` releases at once); `reply` can answer a call itself (a 429, say).
 */
function provider(
  p: Provider,
  opts: { auto?: boolean; reply?: (c: Call, n: number) => Response | null } = {},
) {
  const calls: Call[] = [];
  const fn = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const a = answerFor(promptOf(body));
    if (!a) throw new Error('no fixture answers this request');
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const call: Call = {
      step: a.step,
      body,
      headers: init?.headers as Record<string, string>,
      signal: init?.signal as AbortSignal,
      release,
      cut: () => {},
      done: false,
    };
    calls.push(call);
    const custom = opts.reply?.(call, calls.filter((c) => c.step === call.step).length);
    if (custom) {
      call.done = true;
      return custom;
    }
    if (opts.auto) release();
    const text = STREAMS[p](a.answer, USAGE);
    const end = /\r?\n\r?\n/.exec(text);
    const cut = end ? end.index + end[0].length : text.length;
    const bytes = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        const abort = () => {
          call.done = true;
          ctrl.error(new DOMException('The operation was aborted.', 'AbortError'));
        };
        if (call.signal.aborted) return abort();
        call.signal.addEventListener('abort', abort, { once: true });
        call.cut = () => {
          if (call.done) return;
          call.done = true;
          ctrl.error(new TypeError('network error'));
        };
        ctrl.enqueue(bytes.encode(text.slice(0, cut)));
        await gate;
        if (call.signal.aborted || call.done) return;
        ctrl.enqueue(bytes.encode(text.slice(cut)));
        call.done = true;
        ctrl.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { calls, fetch: fn as typeof fetch };
}

/** Lets streams and promises run (timers stay put unless asked). */
async function until(cond: () => boolean, what = 'condition') {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await vi.advanceTimersByTimeAsync(0);
  }
  throw new Error(`never: ${what}`);
}

function start(p: Provider, extra: Partial<RunOptions> & { fetch: typeof fetch }) {
  const ctrl = new AbortController();
  const states: RunState[] = [];
  const saved: DraftDesign[] = [];
  const run = runDesign({
    ai: AI[p],
    ctx,
    design: fresh(),
    plan: { layout: {}, rooms: 'all' },
    signal: ctrl.signal,
    onUpdate: (s) => states.push(s),
    onSave: (d) => {
      saved.push(d);
    },
    ...extra,
  });
  return { run, ctrl, states, saved, last: () => states[states.length - 1] };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the runner (criteria 25–28)', () => {
  it('runs the layout, then the first room alone until it starts, then two at a time', async () => {
    const prov = provider('anthropic');
    const r = start('anthropic', { fetch: prov.fetch });
    await until(() => prov.calls.length === 1, 'layout');
    expect(prov.calls[0]?.step).toBe('layout');
    // Nothing else goes while the layout runs.
    await vi.advanceTimersByTimeAsync(1000);
    expect(prov.calls).toHaveLength(1);
    prov.calls[0]?.release();
    await until(() => prov.calls.length >= 2, 'room 1');
    // Room 1's message_start has arrived (its first event): rooms 2 and 3 start with it.
    await until(() => prov.calls.length === 4, 'rooms 2 and 3');
    await vi.advanceTimersByTimeAsync(1000);
    expect(prov.calls).toHaveLength(4);
    expect(prov.calls[1]?.done).toBe(false);
    // One of the two finishes: the fourth starts.
    prov.calls[2]?.release();
    await until(() => prov.calls.length === 5, 'room 4');
    for (const c of prov.calls) c.release();
    const { state, design } = await r.run;
    expect(state.phase).toBe('done');
    expect(state.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(Object.values(design.spaces).map((s) => s.status)).toEqual([
      'done',
      'done',
      'done',
      'done',
    ]);
    expect(design.concept?.name).toBe('Warm Japandi for three generations');
    // Saved after the layout and after each room.
    expect(r.saved.length).toBeGreaterThanOrEqual(5);
    // Tokens as the fixtures' usage, every step.
    const t = usageTotals(state.usage);
    expect(t.tokens).toBe(5 * (1000 + 3000 + 2000));
    expect(t.estimated).toBe(false);
  });

  it('waits out a 429 (retry-after 20 s), at most twice, then one room at a time', async () => {
    const prov = provider('anthropic', {
      auto: true,
      reply: (c, n) =>
        /Master bedroom/.test(c.step) && n <= 3
          ? new Response(
              JSON.stringify({
                type: 'error',
                error: { type: 'rate_limit_error', message: 'Slow down' },
              }),
              { status: 429, headers: { 'retry-after': '20' } },
            )
          : null,
    });
    const r = start('anthropic', { fetch: prov.fetch });
    await until(() => !!r.last()?.steps.some((s) => s.wait?.seconds === 20), 'a 20 s wait');
    const waiting = r.last()?.steps.find((s) => s.wait);
    expect(waiting?.wait).toEqual({ seconds: 20, attempt: 1 });
    const tries = () => prov.calls.filter((c) => /Master bedroom/.test(c.step)).length;
    expect(tries()).toBe(1);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(tries()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => tries() === 2, 'second try');
    await vi.advanceTimersByTimeAsync(20_000);
    await until(() => tries() === 3, 'third try');
    const { state } = await r.run;
    // Two waits, then the step fails; the rest are done.
    expect(tries()).toBe(3);
    const failed = state.steps.find((s) => s.status === 'failed');
    expect(failed?.label).toBe('Master bedroom');
    expect(failed?.error).toMatch(/still limiting requests/);
    expect(state.steps.filter((s) => s.status === 'done')).toHaveLength(4);
  });

  it('drops to one room at a time after a rate limit', async () => {
    const prov = provider('anthropic', {
      reply: (c, n) =>
        /Master bedroom/.test(c.step) && n === 1
          ? new Response('{}', { status: 429, headers: { 'retry-after': '5' } })
          : null,
    });
    const r = start('anthropic', { fetch: prov.fetch });
    await until(() => prov.calls.length === 1);
    prov.calls[0]?.release();
    // Room 1 starts; rooms 2 and 3 with it, and one of them is refused (429).
    await until(() => prov.calls.length === 4, 'three rooms');
    const others = prov.calls.slice(2).filter((c) => !/Master/.test(c.step));
    expect(others).toHaveLength(1);
    others[0]?.release();
    await vi.advanceTimersByTimeAsync(1000);
    // The fourth waits: the refused room still holds the one place.
    expect(prov.calls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(5000);
    await until(() => prov.calls.length === 5, 'the retry');
    expect(prov.calls[4]?.step).toMatch(/Master/);
    prov.calls[4]?.release();
    await until(() => prov.calls.length === 6, 'room 4 after it');
    for (const c of prov.calls) c.release();
    expect((await r.run).state.phase).toBe('done');
  });

  it('a quota error stops the run, done steps kept; Finish asks only for the rest (26)', async () => {
    const quota = () =>
      new Response(
        JSON.stringify({
          error: {
            message: 'You exceeded your current quota.',
            type: 'insufficient_quota',
            code: 'insufficient_quota',
          },
        }),
        { status: 429 },
      );
    const prov = provider('openai', {
      auto: true,
      reply: (c) => (/Kitchen/.test(c.step) ? quota() : null),
    });
    const r = start('openai', { fetch: prov.fetch });
    const { state, design } = await r.run;
    expect(state.phase).toBe('halted');
    expect(state.halt?.kind).toBe('quota');
    expect(state.halt?.message).toMatch(/run out of quota or credit/);
    expect(design.concept).not.toBeNull();
    const done = Object.entries(design.spaces).filter(([, s]) => s.status === 'done');
    expect(done.length).toBeGreaterThan(0);
    const missing = Object.entries(design.spaces)
      .filter(([, s]) => s.status !== 'done')
      .map(([k]) => k);
    expect(missing.length).toBeGreaterThan(0);

    // Finish the design: only the missing rooms are asked for.
    const again = provider('openai', { auto: true });
    const finish = await runDesign({
      ai: AI.openai,
      ctx,
      design,
      plan: { layout: null, rooms: missing },
      signal: new AbortController().signal,
      fetch: again.fetch,
    });
    expect(again.calls).toHaveLength(missing.length);
    expect(again.calls.every((c) => c.step !== 'layout')).toBe(true);
    expect(finish.state.phase).toBe('done');
    expect(Object.values(finish.design.spaces).every((s) => s.status === 'done')).toBe(true);
  });

  it('a dropped connection is tried again (after 3 s, then 10 s) before it stops the run', async () => {
    const prov = provider('anthropic', { auto: true });
    let drops = 2;
    const flaky = (async (u: string | URL | Request, i?: RequestInit) => {
      if (drops > 0) {
        drops--;
        throw new TypeError('Failed to fetch');
      }
      return prov.fetch(u, i);
    }) as typeof fetch;
    const r = start('anthropic', { fetch: flaky });
    await until(() => !!r.last()?.steps.some((s) => s.wait?.net), 'a wait for the connection');
    expect(r.last()?.steps.find((s) => s.wait)?.wait).toEqual({
      seconds: 3,
      attempt: 1,
      net: true,
    });
    await vi.advanceTimersByTimeAsync(3000);
    await until(() => !!r.last()?.steps.some((s) => s.wait?.seconds === 10), 'the second wait');
    await vi.advanceTimersByTimeAsync(10_000);
    const { state } = await r.run;
    expect(state.phase).toBe('done');
    expect(state.steps.every((s) => s.status === 'done')).toBe(true);
  });

  it('still unreachable after the tries: halted, saying so (the panel says what is kept)', async () => {
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const r = start('gemini', { fetch: down });
    await until(() => !!r.last()?.steps.some((s) => s.wait?.net), 'first wait');
    await vi.advanceTimersByTimeAsync(3000);
    await until(() => !!r.last()?.steps.some((s) => s.wait?.seconds === 10), 'second wait');
    await vi.advanceTimersByTimeAsync(10_000);
    const { state, design } = await r.run;
    expect(state.phase).toBe('halted');
    expect(state.halt).toEqual({
      kind: 'network',
      message: 'Couldn’t reach Gemini, even after trying again.',
    });
    expect(design.concept).toBeNull();
  });

  it('Stop aborts every request in flight and counts the cut-off steps as estimated (27)', async () => {
    const prov = provider('anthropic');
    const r = start('anthropic', { fetch: prov.fetch });
    await until(() => prov.calls.length === 1);
    prov.calls[0]?.release();
    await until(() => prov.calls.length === 4, 'three rooms in flight');
    r.ctrl.abort();
    const { state, design } = await r.run;
    expect(state.phase).toBe('stopped');
    for (const c of prov.calls.slice(1)) expect(c.signal.aborted).toBe(true);
    const cut = state.usage.filter((u) => u.step !== 'layout');
    expect(cut).toHaveLength(3);
    expect(cut.every((u) => u.estimated)).toBe(true);
    // Claude's message_start had the prompt's counts: those stand, the output is estimated.
    expect(cut[0]?.input).toBe(1000);
    expect(state.steps.map((s) => s.status)).toEqual([
      'done',
      'cancelled',
      'cancelled',
      'cancelled',
      'skipped',
    ]);
    expect(
      Object.values(design.spaces)
        .map((s) => s.status)
        .sort(),
    ).toEqual(['cancelled', 'cancelled', 'cancelled', 'skipped']);
  });

  it('Stop ends the run while a check never comes back (a worker hung or killed)', async () => {
    const prov = provider('anthropic', { auto: true });
    let asked = 0;
    // The plan's two placings answer; every room's check after them never does.
    const results: RunOptions['results'] = (b, f, d, opts) =>
      ++asked <= 2 ? Promise.resolve(designResult(b, f, d, opts)) : new Promise(() => {});
    const r = start('anthropic', { fetch: prov.fetch, results });
    await until(() => asked >= 3, 'a room sent for its check');
    r.ctrl.abort();
    const { state } = await r.run;
    expect(state.phase).toBe('stopped');
    expect(state.endedAt).not.toBeNull();
  });

  const limited = (prov: ReturnType<typeof provider>) => {
    let spent = 0;
    const asks: ((go: boolean) => void)[] = [];
    const r = start('anthropic', {
      fetch: prov.fetch,
      onUsage: (u) => {
        spent += u.usd ?? 0;
      },
      overLimit: () => spent >= 0.03,
      confirmOver: () => new Promise<boolean>((res) => asks.push(res)),
    });
    return { r, asks };
  };

  it('pauses before the next step once past the limit; Finish goes on to the end, asked once (28)', async () => {
    const prov = provider('anthropic', { auto: true });
    const { r, asks } = limited(prov);
    await until(() => r.last()?.phase === 'paused', 'paused');
    // The layout cost more than the limit: no room has started.
    expect(prov.calls).toHaveLength(1);
    expect(r.last()?.said).toMatch(/limit/);
    asks[0]?.(true);
    const { state } = await r.run;
    // Once told to finish, it doesn't ask again before every step.
    expect(asks).toHaveLength(1);
    expect(state.phase).toBe('done');
    expect(state.steps.filter((s) => s.status === 'done')).toHaveLength(5);
  });

  it('Stop here, at the limit, keeps what’s done (28)', async () => {
    const prov = provider('anthropic', { auto: true });
    const { r, asks } = limited(prov);
    await until(() => r.last()?.phase === 'paused', 'paused');
    asks[0]?.(false);
    const { state, design } = await r.run;
    expect(state.phase).toBe('stopped');
    expect(prov.calls).toHaveLength(1);
    expect(state.steps.filter((s) => s.status === 'done')).toHaveLength(1);
    expect(design.concept).not.toBeNull();
  });

  it('Stop while paused at the limit ends the run (no hang)', async () => {
    const prov = provider('anthropic', { auto: true });
    const { r } = limited(prov);
    await until(() => r.last()?.phase === 'paused', 'paused');
    r.ctrl.abort();
    const { state } = await r.run;
    expect(state.phase).toBe('stopped');
    expect(prov.calls).toHaveLength(1);
  });

  it('a refused key on room 1 sends no other room', async () => {
    const prov = provider('anthropic', {
      auto: true,
      reply: (c) =>
        c.step !== 'layout'
          ? new Response(
              JSON.stringify({
                type: 'error',
                error: { type: 'authentication_error', message: 'invalid x-api-key' },
              }),
              { status: 401 },
            )
          : null,
    });
    const r = start('anthropic', { fetch: prov.fetch });
    const { state } = await r.run;
    expect(state.phase).toBe('halted');
    expect(state.halt?.kind).toBe('key');
    expect(prov.calls).toHaveLength(2);
  });

  it('a stream that fails mid-answer is metered (estimated), then tried again', async () => {
    const broken = [
      'event: message_start',
      `data: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } })}`,
      '',
      'event: content_block_delta',
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"items":[' } })}`,
      '',
      'event: error',
      `data: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}`,
      '',
      '',
    ].join('\n');
    const prov = provider('anthropic', {
      auto: true,
      reply: (c, n) =>
        /Kitchen/.test(c.step) && n === 1
          ? new Response(broken, { status: 200, headers: { 'content-type': 'text/event-stream' } })
          : null,
    });
    const r = start('anthropic', { fetch: prov.fetch });
    await until(() => prov.calls.filter((c) => /Kitchen/.test(c.step)).length === 1, 'kitchen');
    await vi.advanceTimersByTimeAsync(10_000);
    const { state } = await r.run;
    expect(state.phase).toBe('done');
    const kitchen = state.steps.find((s) => s.label === 'Kitchen');
    const cut = state.usage.filter((u) => u.step === kitchen?.key);
    expect(cut).toHaveLength(2);
    // Cut off, it may be billed in full: its whole prompt (none of it from the cache) and output
    // to its limit, more than the answer that came after it.
    expect(cut[0]).toMatchObject({ estimated: true, cachedInput: 0, cacheWrite: 0 });
    expect(cut[0]?.input).toBeGreaterThan(1000);
    expect(cut[0]?.output).toBeGreaterThan(cut[1]?.output ?? 0);
    expect(kitchen?.retries).toBe(1);
  });

  it('repaints at most four times a second while the model thinks', async () => {
    const thinking = Array.from({ length: 200 }, (_, i) => `Thought ${i}\n`);
    const prov = provider('anthropic', { auto: true });
    const fetchThinking: typeof fetch = async (url, init) => {
      const res = await prov.fetch(url, init);
      const body = JSON.parse(String(init?.body));
      const a = answerFor(promptOf(body));
      return new Response(anthropicStream(a?.answer, USAGE, { thinking }), {
        status: res.status,
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    const r = start('anthropic', { fetch: fetchThinking });
    await r.run;
    // Five steps of 200 thinking lines each; the clock stands still, so one repaint each.
    expect(r.states.length).toBeLessThan(60);
  });

  it('a step that goes quiet for two minutes fails; the rest go on', async () => {
    const prov = provider('gemini');
    const r = start('gemini', { fetch: prov.fetch });
    await until(() => prov.calls.length === 1);
    prov.calls[0]?.release();
    await until(() => prov.calls.length === 4);
    for (const c of prov.calls.slice(2)) c.release();
    await until(() => prov.calls.length === 5);
    prov.calls[4]?.release();
    await vi.advanceTimersByTimeAsync(QUIET_MS + 10);
    const { state } = await r.run;
    expect(state.steps[1]?.status).toBe('failed');
    expect(state.steps[1]?.error).toMatch(/went quiet/);
    expect(state.steps.filter((s) => s.status === 'done')).toHaveLength(4);
  });
});

describe('fix rounds: the app checks each answer before it is shown (designer v2, 10–11)', () => {
  /** The living room's fixture answer with its sofa turned to face the wall. */
  const facingWall = () => {
    const a = structuredClone(answerFor('furnish "Living')?.answer) as {
      items: Record<string, unknown>[];
    };
    const sofa = a.items.find((i) => i.ref === 'sofa1') as Record<string, unknown>;
    Object.assign(sofa, { wall: null, along: null, at: { x: 8.15, y: 2.6 }, rotation: 180 });
    return a;
  };
  const sse = (answer: unknown) =>
    new Response(anthropicStream(answer, USAGE), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  const living = (c: { step: string }) => c.step === 'furnish "Living';

  it('10: a sofa facing the wall goes back once, naming the piece and the failure; the fix passes', async () => {
    const prov = provider('anthropic', {
      auto: true,
      reply: (c, n) => (living(c) && n === 1 ? sse(facingWall()) : null),
    });
    const r = start('anthropic', { fetch: prov.fetch });
    const { state, design } = await r.run;
    expect(state.phase).toBe('done');
    const calls = prov.calls.filter(living);
    expect(calls).toHaveLength(2);
    const body = promptOf(calls[1]?.body);
    expect(body).toContain('## Fix round 1');
    expect(body).toMatch(
      /- \["sofa1"\] "The 3-seat sofa faces the wall, 0\.\d\d m away: it needs 1\.20 m clear in front\."/,
    );
    const space = Object.values(design.spaces).find((s) => s.name.startsWith('Living'));
    expect(space).toMatchObject({ status: 'done', fixes: 1, fixed: 5 });
    // Both requests are metered, under the room's step.
    const key = Object.keys(design.spaces).find((k) => design.spaces[k] === space);
    expect(state.usage.filter((u) => u.step === key)).toHaveLength(2);
    expect(prov.calls).toHaveLength(6);
  });

  it('11: an answer the fix doesn’t improve is kept, and the second round isn’t spent', async () => {
    const prov = provider('anthropic', {
      auto: true,
      reply: (c) => (living(c) ? sse(facingWall()) : null),
    });
    const r = start('anthropic', { fetch: prov.fetch });
    const { design } = await r.run;
    expect(prov.calls.filter(living)).toHaveLength(2);
    const space = Object.values(design.spaces).find((s) => s.name.startsWith('Living'));
    expect(space).toMatchObject({ status: 'done', fixes: 1, fixed: 0 });
  });

  it('a run sends three fix requests at most, however many rooms fail', async () => {
    // Living fails three checks, then two, then passes (two rounds wanted); a child without a
    // bed in each bedroom fails every answer (a round each): four wanted, three sent.
    const fewer = () => {
      const a = facingWall();
      a.items = a.items.filter((i) => i.ref !== 'coffee1' && i.ref !== 'rug1');
      return a;
    };
    const twoKids: DesignBrief = {
      ...brief,
      household: { ...brief.household, children: ['primary', 'primary'] },
      sleeping: {
        'rm_main-bedroom': ['adult-1', 'adult-2', 'child-1'],
        rm_bedroom: ['elder-1', 'child-2'],
      },
    };
    const prov = provider('anthropic', {
      auto: true,
      reply: (c, n) =>
        living(c) && n === 1 ? sse(facingWall()) : living(c) && n === 2 ? sse(fewer()) : null,
    });
    const r = start('anthropic', {
      fetch: prov.fetch,
      ctx: { ...ctx, brief: twoKids },
      design: { ...fresh(), brief: twoKids },
    });
    const { state, design } = await r.run;
    expect(state.phase).toBe('done');
    const fixes = Object.values(design.spaces).reduce((t, s) => t + (s.fixes ?? 0), 0);
    expect(fixes).toBe(3);
    expect(prov.calls).toHaveLength(5 + 3);
  });

  it('on Quick, a room goes back once at most', async () => {
    const quick: DesignBrief = { ...brief, quality: 'quick' };
    const prov = provider('anthropic', {
      auto: true,
      reply: (c) => (living(c) ? sse(facingWall()) : null),
    });
    const { design } = await start('anthropic', {
      fetch: prov.fetch,
      ctx: { ...ctx, brief: quick },
      design: { ...fresh(), brief: quick },
    }).run;
    expect(prov.calls.filter(living)).toHaveLength(2);
    const space = Object.values(design.spaces).find((s) => s.name.startsWith('Living'));
    expect(space?.fixes).toBe(1);
  });

  it('the fix round says where the app placed each piece', async () => {
    const prov = provider('anthropic', {
      auto: true,
      reply: (c, n) => (living(c) && n === 1 ? sse(facingWall()) : null),
    });
    await start('anthropic', { fetch: prov.fetch }).run;
    const body = promptOf(prov.calls.filter(living)[1]?.body);
    expect(body).toContain('Where the app placed your pieces (data):');
    expect(body).toMatch(
      /"sofa1 \(3-seat sofa\): free at \(\d+(\.\d+)?, \d+(\.\d+)?\), facing [NESW]{1,2}"/,
    );
  });
});

describe('a whole design with each provider (41)', () => {
  for (const p of ['openai', 'gemini'] as const) {
    it(`${p}: streamed, usage read from the final chunk`, async () => {
      const prov = provider(p, { auto: true });
      const r = start(p, { fetch: prov.fetch });
      const { state, design } = await r.run;
      expect(state.phase).toBe('done');
      expect(prov.calls).toHaveLength(5);
      expect(Object.values(design.spaces).every((s) => s.status === 'done')).toBe(true);
      const t = usageTotals(state.usage);
      expect(t.tokens).toBe(5 * (1000 + 3000 + 2000));
      expect(t.cached).toBe(5 * 3000);
      expect(t.estimated).toBe(false);
      expect(state.usage[0]?.reasoning).toBe(500);
    });
  }
});

describe('the requests', () => {
  const prompt = {
    step: 'layout',
    kind: 'layout' as const,
    system: 'S'.repeat(4000),
    prefix: 'P'.repeat(9000),
    shared: '',
    tail: 'T',
    schema: { type: 'object' },
    maxTokens: 24_000,
    effort: 'high' as const,
  };

  it('Claude: streamed, JSON schema, adaptive thinking, the stable prefix cached', () => {
    const r = requestFor(AI.anthropic, prompt);
    expect(r.url).toBe('https://api.anthropic.com/v1/messages');
    expect(r.headers['anthropic-version']).toBe('2026-10-21');
    expect(r.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(r.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 24_000,
      stream: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: { type: 'object' } },
      },
    });
    const content = (r.body.messages as { content: { cache_control?: unknown }[] }[])[0]?.content;
    expect(content?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(content?.[1]?.cache_control).toBeUndefined();
    // Too short to cache for this model: no marker.
    const short = requestFor(AI.anthropic, { ...prompt, system: 'S', prefix: 'P' });
    const sc = (short.body.messages as { content: { cache_control?: unknown }[] }[])[0]?.content;
    expect(sc?.[0]?.cache_control).toBeUndefined();
  });

  it('OpenAI: usage in the stream, effort, a cache key, and the token limit', () => {
    const r = requestFor(AI.openai, prompt, 'medium');
    expect(r.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 24_000,
      reasoning_effort: 'medium',
      response_format: { type: 'json_schema', json_schema: { strict: true } },
    });
    expect(String(r.body.prompt_cache_key)).toMatch(/^dhd-/);
  });

  it('sends Claude’s fallback only where it applies, and refuses models it isn’t written for', () => {
    const opus = requestFor(AI.anthropic, prompt);
    expect(opus.body.fallbacks).toBe('default');
    expect(opus.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    const haiku = requestFor({ ...AI.anthropic, model: 'claude-haiku-5-5' }, prompt);
    expect(haiku.body.fallbacks).toBeUndefined();
    expect(haiku.headers['anthropic-beta']).toBeUndefined();
    expect(designerCannotUse(AI.anthropic)).toBeNull();
    expect(designerCannotUse({ ...AI.anthropic, model: 'claude-sonnet-5-5' })).toBeNull();
    expect(designerCannotUse({ ...AI.anthropic, model: 'claude-haiku-4-5' })).toMatch(
      /“claude-haiku-4-5” isn’t one of them/,
    );
    expect(designerCannotUse(AI.openai)).toBeNull();
    // OpenAI: reasoning effort only to models that reason.
    expect(
      requestFor({ ...AI.openai, model: 'gpt-4o' }, prompt).body.reasoning_effort,
    ).toBeUndefined();
  });

  it('Gemini: streamGenerateContent as SSE, with thinking', () => {
    const r = requestFor(AI.gemini, prompt);
    expect(r.url).toMatch(/models\/gemini-2\.5-pro:streamGenerateContent\?alt=sse$/);
    expect(r.headers['x-goog-api-key']).toBe('AIzaTest0000');
    expect(r.body).toMatchObject({
      generationConfig: {
        responseMimeType: 'application/json',
        maxOutputTokens: 24_000,
        thinkingConfig: { includeThoughts: true, thinkingBudget: 12_000 },
      },
    });
    const g3 = requestFor({ ...AI.gemini, model: 'gemini-3-pro' }, prompt, 'low');
    expect(g3.body).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingLevel: 'low' } },
    });
  });
});

describe('a locked phone: a step cut off while away goes again on return (locked-phone runs, part 1)', () => {
  class Page extends EventTarget {
    visibilityState: 'visible' | 'hidden' = 'visible';
  }
  let page: Page;
  beforeEach(() => {
    page = new Page();
    vi.stubGlobal('document', page);
    vi.stubGlobal('window', new EventTarget());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const turn = (to: 'visible' | 'hidden') => {
    page.visibilityState = to;
    page.dispatchEvent(new Event('visibilitychange'));
  };

  /** A whole flat with rooms 1 and 2 done, rooms 3 and 4 in flight; room 3's label. */
  async function midRun(extra: Partial<RunOptions> = {}) {
    const prov = provider('anthropic');
    const r = start('anthropic', { fetch: prov.fetch, ...extra });
    await until(() => prov.calls.length === 1, 'layout');
    prov.calls[0]?.release();
    await until(() => prov.calls.length === 4, 'rooms 1 to 3');
    prov.calls[1]?.release();
    prov.calls[2]?.release();
    await until(() => prov.calls.length === 5, 'room 4');
    const room3 = prov.calls[3]?.step as string;
    const of = (step: string) => prov.calls.filter((c) => c.step === step);
    return { prov, r, room3, of };
  }
  /** A step's row, by the fixture's step name ('furnish "Living' is Living and dining). */
  const rowOf = (state: RunState, step: string) => {
    const name = step.replace(/^furnish "/, '').replace(/"$/, '');
    return state.steps.find((s) => s.label.startsWith(name));
  };

  /** Cut off while hidden, and away `ms` before the page is back. */
  async function away(r: Awaited<ReturnType<typeof midRun>>['r'], cut: () => void, ms: number) {
    turn('hidden');
    cut();
    await until(() => !!r.last()?.steps.some((s) => s.wait?.away), 'waiting for the page');
    await vi.advanceTimersByTimeAsync(ms);
  }

  it('the step in flight is sent again once the page is back; four returns in a run carry on; finished steps never (criteria 1, 2)', async () => {
    const resent: string[] = [];
    const { prov, r, room3, of } = await midRun({ onResent: (st) => resent.push(st.label) });
    const room4 = prov.calls[4]?.step as string;
    // Rooms 3 and 4 are each cut off twice as the phone locks, and each sent again.
    for (const [cycle, step] of [room3, room3, room4, room4].entries()) {
      const n = of(step).length;
      // (Ten seconds each: under the two minutes after which a quiet stream is cut off too.)
      await away(r, () => of(step).at(-1)?.cut(), 10_000);
      // Nothing goes while hidden.
      expect(of(step)).toHaveLength(n);
      turn('visible');
      await until(() => of(step).length === n + 1, `sent again (${cycle + 1})`);
    }
    for (const c of prov.calls) c.release();
    const { state, design } = await r.run;
    expect(state.phase).toBe('done');
    expect(Object.values(design.spaces).every((s) => s.status === 'done')).toBe(true);
    // The layout and the finished rooms were asked for once; the cut-off rooms three times.
    const steps = prov.calls.map((c) => c.step);
    for (const s of new Set(steps)) {
      expect(steps.filter((x) => x === s).length).toBe(s === room3 || s === room4 ? 3 : 1);
    }
    const row = rowOf(state, room3);
    // Not network retries (two of those halt a run): sent again on return.
    expect(row).toMatchObject({ resent: 2, retries: 0 });
    const label = row?.label ?? '';
    expect(resent.filter((x) => x === label)).toHaveLength(2);
    // Each cut-off attempt is metered as estimated ("~").
    const tries = state.usage.filter((u) => u.step === row?.key);
    expect(tries.map((u) => u.estimated)).toEqual([true, true, false]);
  });

  it('five hide-and-show cycles on one step: sent again twice at most, then the run is interrupted', async () => {
    const { prov, r, room3, of } = await midRun();
    for (let cycle = 1; cycle <= 5; cycle++) {
      turn('hidden');
      of(room3).at(-1)?.cut();
      await vi.advanceTimersByTimeAsync(10_000);
      turn('visible');
      await vi.advanceTimersByTimeAsync(100);
    }
    for (const c of prov.calls) c.release();
    const { state, design } = await r.run;
    expect(state.phase).toBe('interrupted');
    expect(state.interrupt).toBe('resent');
    // The first request and two sent again: the third cut-off sends nothing more.
    expect(of(room3)).toHaveLength(3);
    const key = rowOf(state, room3)?.key as string;
    expect(design.spaces[key]?.status).toBe('skipped');
  });

  it('nothing is sent again past what the run was approved for (the room gate’s own check)', async () => {
    let spent = 0;
    let cap = Number.POSITIVE_INFINITY;
    const { prov, r, room3, of } = await midRun({
      onUsage: (u) => {
        spent += u.usd ?? 0;
      },
      overLimit: () => spent >= cap,
    });
    // What it was approved for is spent: the step cut off now is not sent again.
    cap = spent;
    const before = prov.calls.length;
    await away(r, () => of(room3)[0]?.cut(), 10_000);
    turn('visible');
    await vi.advanceTimersByTimeAsync(1000);
    for (const c of prov.calls) c.release();
    const { state } = await r.run;
    expect(state.phase).toBe('interrupted');
    expect(state.interrupt).toBe('limit');
    expect(prov.calls).toHaveLength(before);
    expect(of(room3)).toHaveLength(1);
  });

  it('two rooms let go together where only one fits: one goes, and nothing committed passes the figure', async () => {
    const HIGH = 0.25;
    let spent = 0;
    let cap = Number.POSITIVE_INFINITY;
    const inflight = new Map<string, number>();
    const committed = () => spent + [...inflight.values()].reduce((t, x) => t + x, 0);
    let most = 0;
    let rooms = 0;
    const prov = provider('anthropic');
    const r = start('anthropic', {
      fetch: prov.fetch,
      onUsage: (u) => {
        spent += u.usd ?? 0;
      },
      onStep: (key, kind, phase) => {
        if (phase === 'end') {
          inflight.delete(key);
          return;
        }
        inflight.set(key, HIGH);
        // The first room's start: room for it and one more, not two.
        if (kind === 'room' && ++rooms === 1) cap = committed() + HIGH + 0.01;
        most = Math.max(most, committed() - cap);
      },
      overLimit: (next) => (next ? committed() + HIGH > cap : committed() >= cap),
    });
    await until(() => prov.calls.length === 1, 'layout');
    prov.calls[0]?.release();
    // Room 1 goes alone until its answer starts; then rooms 2 and 3 are let go together.
    await until(() => prov.calls.length >= 2, 'room 1');
    await vi.advanceTimersByTimeAsync(1000);
    // Only room 2 fits beside room 1: room 3 waits (the run asks, and with no answer, stops).
    expect(prov.calls).toHaveLength(3);
    expect(most).toBeLessThanOrEqual(1e-9);
    for (const c of prov.calls) c.release();
    const { state } = await r.run;
    expect(state.phase).toBe('stopped');
    expect(prov.calls).toHaveLength(3);
    expect(most).toBeLessThanOrEqual(1e-9);
  });

  it('nothing is sent again when what is left of the figure is less than the steps in flight may cost', async () => {
    // The steps on their way at their most (as the run's checkpoint counts them).
    const HIGH = 0.25;
    let spent = 0;
    let cap = Number.POSITIVE_INFINITY;
    const inflight = new Map<string, number>();
    const committed = () => spent + [...inflight.values()].reduce((t, x) => t + x, 0);
    const { prov, r, room3, of } = await midRun({
      onUsage: (u) => {
        spent += u.usd ?? 0;
      },
      onStep: (key, _kind, phase) => {
        if (phase === 'start') inflight.set(key, HIGH);
        else inflight.delete(key);
      },
      overLimit: (next) => (next ? committed() + HIGH > cap : committed() >= cap),
    });
    // Rooms 3 and 4 on their way: a cent of headroom past them, less than either's most.
    expect(inflight.size).toBe(2);
    cap = committed() + 0.01;
    const before = prov.calls.length;
    await away(r, () => of(room3)[0]?.cut(), 10_000);
    turn('visible');
    await vi.advanceTimersByTimeAsync(1000);
    for (const c of prov.calls) c.release();
    const { state } = await r.run;
    // The cut-off attempt is counted at its most, so room 3 doesn't fit again: not resent.
    expect(of(room3)).toHaveLength(1);
    expect(prov.calls).toHaveLength(before);
    expect(state.phase).toBe('interrupted');
    expect(state.interrupt).toBe('limit');
  });

  it('away more than 10 minutes: nothing is sent again, the run ends interrupted, its finished rooms kept', async () => {
    const { prov, r, room3, of } = await midRun();
    // Room 3 cut off as the phone locks; room 4's stream goes quiet meanwhile, cut off too.
    await away(r, () => of(room3)[0]?.cut(), 11 * 60_000);
    turn('visible');
    for (const c of prov.calls) c.release();
    const { state, design } = await r.run;
    expect(state.phase).toBe('interrupted');
    expect(prov.calls).toHaveLength(5);
    const key = rowOf(state, room3)?.key as string;
    expect(design.spaces[key]?.status).toBe('skipped');
    expect(
      Object.values(design.spaces)
        .map((s) => s.status)
        .sort(),
    ).toEqual(['done', 'done', 'skipped', 'skipped']);
  });

  it('killed mid-step, then carried on from its checkpoint: only the room left is asked for', async () => {
    const { prov, r, room3, of } = await midRun();
    await away(r, () => of(room3)[0]?.cut(), 11 * 60_000);
    turn('visible');
    for (const c of prov.calls) c.release();
    await r.run;
    // What the page kept: the version as last saved, and the checkpoint written with it.
    const d = r.saved.at(-1) as DraftDesign;
    const project = sampleFlatProject('prj_test');
    const option: ProposalOption = {
      letter: 'A',
      name: 'Whole flat',
      designId: d.id,
      brief: d.brief,
      aliases: d.aliases,
      concept: d.concept,
      spaces: d.spaces,
      locks: [],
      usage: d.usage,
      base: { variant: 'before', fingerprint: 'fp' },
      status: 'running',
      ticks: null,
      accepted: [],
      note: null,
      waivers: [],
      version: null,
    };
    const run: RunCheckpoint = {
      id: 'run_test',
      startedAt: new Date().toISOString(),
      at: new Date().toISOString(),
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      plan: { layout: {}, rooms: 'all' },
      layout: 'done',
      rooms: Object.keys(d.spaces),
      fixesLeft: 2,
      approved: null,
      spent: 0,
      inflight: [],
      stopped: false,
      paused: null,
      times: [],
    };
    const scope = { label: 'Whole flat', spaces: [], all: true };
    const priced = priceRequest({
      project,
      levelId: project.levels[0]?.id ?? '',
      designs: [],
      brief: d.brief,
      scope,
      words: '',
      resume: { option, run, scope },
      designId: d.id,
      opts: {},
      ai: { provider: 'anthropic', model: 'claude-opus-5-5' },
      prices: PRICES,
    });
    const left = Object.entries(d.spaces)
      .filter(([, s]) => s.status !== 'done')
      .map(([k]) => k);
    const key0 = left[0] as string;
    expect(left).toHaveLength(2);
    expect(priced?.sp.plan).toMatchObject({ layout: null, rooms: left });
    // Priced for what is left only: those two rooms' requests.
    expect(priced?.est.steps).toHaveLength(2);
    // Carry on's figure (criterion 6): those steps at their high, and the fix rounds left.
    const est = priced?.est;
    if (!est?.usd) throw new Error('not priced');
    const high = est.steps.reduce((t, s) => t + (s.usd?.high ?? 0), 0);
    expect(est.usd.high).toBeCloseTo(high, 6);
    expect(resumeFigure(est, run.fixesLeft)).toBeCloseTo(
      high + (est.usd.fix * run.fixesLeft) / est.fixes,
      6,
    );
    expect(resumeFigure(est, 0)).toBeCloseTo(high, 6);
    // Bound to the figure its button showed: priced higher now, it asks again.
    expect(figureHolds(0.4, 0.4)).toBe(true);
    expect(figureHolds(0.4, 0.39)).toBe(true);
    expect(figureHolds(0.4, 0.41)).toBe(false);
    expect(figureHolds(null, 0.4)).toBe(false);
    // By itself it may spend what is left of its figure, less what it spent and the steps
    // that were in flight at their most (a page that died mid-step never metered them).
    const cut = { ...run, approved: 1, spent: 0.2, inflight: [{ step: key0, high: 0.3 }] };
    expect(spentWithInflight(cut)).toBeCloseTo(0.5, 9);
    expect(approvedLeft(cut)).toBeCloseTo(0.5, 9);
    expect(approvedLeft({ ...cut, spent: 0.9 })).toBe(0);
    expect(approvedLeft({ ...cut, approved: null })).toBeNull();
    const prov2 = provider('anthropic', { auto: true });
    const again = await runDesign({
      ai: AI.anthropic,
      ctx: priced?.sp.ctx as RunOptions['ctx'],
      design: priced?.sp.draft as DraftDesign,
      plan: priced?.sp.plan as RunOptions['plan'],
      signal: new AbortController().signal,
      fetch: prov2.fetch,
      fixesLeft: run.fixesLeft,
    });
    // Only the two rooms left: never the layout or a finished room again.
    expect(prov2.calls).toHaveLength(2);
    expect(prov2.calls.map((c) => c.step)).toContain(room3);
    expect(prov2.calls.some((c) => c.step === 'layout')).toBe(false);
    expect(again.state.phase).toBe('done');
    expect(Object.values(again.design.spaces).every((s) => s.status === 'done')).toBe(true);
    // Its earlier usage is kept with it, the new requests' added.
    expect(again.design.usage.length).toBe(d.usage.length + 2);
  });
});
