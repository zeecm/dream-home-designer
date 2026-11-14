import {
  type DesignBrief,
  designResult,
  freeEssentials,
  parseSpaceDesign,
  usageTotals,
} from '@dhd/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sampleMain from '../../core/src/designer/benchmark/answers/sample-main-bedroom.json' with {
  type: 'json',
};
import {
  AI,
  type Phone,
  USAGE,
  away as awayOn,
  brief,
  ctx,
  fakePhone,
  fresh,
  level,
  midRun as midRunOn,
  provider,
  rowOf,
  start,
  until,
} from './fixtures/runner';
import { CONCEPT, answerFor, promptOf } from './fixtures/sample';
import { anthropicStream, geminiStream } from './fixtures/streams';
import { QUIET_MS } from './request';
import { type RunOptions, runDesign } from './run';
import { UNPRICED, designerCannotUse, requestFor } from './stream';

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

  it('each round is stored with how it ended (fixed, no better), for the card', async () => {
    const better = provider('anthropic', {
      auto: true,
      reply: (c, n) => (living(c) && n === 1 ? sse(facingWall()) : null),
    });
    const one = await start('anthropic', { fetch: better.fetch }).run;
    const fixedRoom = Object.values(one.design.spaces).find((s) => s.name.startsWith('Living'));
    expect(fixedRoom?.rounds).toEqual([{ outcome: 'fixed', before: 5, after: 0 }]);
    // Rooms that passed first time have no rounds.
    expect(Object.values(one.design.spaces).filter((s) => s.rounds).length).toBe(1);
    const same = provider('anthropic', {
      auto: true,
      reply: (c) => (living(c) ? sse(facingWall()) : null),
    });
    const two = await start('anthropic', { fetch: same.fetch }).run;
    const stuck = Object.values(two.design.spaces).find((s) => s.name.startsWith('Living'));
    expect(stuck?.rounds).toEqual([{ outcome: 'no-better', before: 5, after: 5 }]);
  });

  it('a fix round cut off at the length limit twice is stored as cut off, not silent', async () => {
    const prov = provider('anthropic', {
      auto: true,
      reply: (c, n) =>
        living(c) && n === 1
          ? sse(facingWall())
          : living(c)
            ? new Response(anthropicStream(facingWall(), USAGE, { stop: 'max_tokens' }), {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
              })
            : null,
    });
    const { design } = await start('anthropic', { fetch: prov.fetch }).run;
    const space = Object.values(design.spaces).find((s) => s.name.startsWith('Living'));
    expect(space?.status).toBe('done');
    expect(space?.rounds).toEqual([{ outcome: 'cut-off', before: 5, after: 5 }]);
  });

  it('a fix round the model declines is stored as declined, never as “no readable answer”', async () => {
    const prov = provider('anthropic', {
      auto: true,
      reply: (c, n) =>
        living(c) && n === 1
          ? sse(facingWall())
          : living(c)
            ? new Response(anthropicStream(facingWall(), USAGE, { stop: 'refusal' }), {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
              })
            : null,
    });
    const { design } = await start('anthropic', { fetch: prov.fetch }).run;
    const space = Object.values(design.spaces).find((s) => s.name.startsWith('Living'));
    expect(space?.rounds).toEqual([{ outcome: 'refused', before: 5, after: 5 }]);
  });

  it('a room still failing when the run’s fix-ups are used up says so', async () => {
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
      reply: (c) => (living(c) ? sse(facingWall()) : null),
    });
    const { design } = await start('anthropic', {
      fetch: prov.fetch,
      ctx: { ...ctx, brief: twoKids },
      design: { ...fresh(), brief: twoKids },
      fixesLeft: 1,
    }).run;
    const outcomes = Object.values(design.spaces).flatMap((s) => s.rounds ?? []);
    expect(outcomes.filter((x) => x.outcome !== 'no-fixups')).toHaveLength(1);
    expect(outcomes.some((x) => x.outcome === 'no-fixups')).toBe(true);
  });

  it('a bed left out for a keep ref the plan doesn’t have: the fix round names it, with the hint', async () => {
    const keptGone = () => {
      const a = structuredClone(answerFor('furnish "Master bedroom"')?.answer) as {
        items: Record<string, unknown>[];
      };
      const bed = a.items.find((i) => i.ref === 'bed1') as Record<string, unknown>;
      bed.keep = 'P99';
      return a;
    };
    const main = (c: { step: string }) => /furnish "(Master|Main) bedroom"/.test(c.step);
    const prov = provider('anthropic', {
      auto: true,
      reply: (c, n) => (main(c) && n === 1 ? sse(keptGone()) : null),
    });
    await start('anthropic', { fetch: prov.fetch }).run;
    const calls = prov.calls.filter(main);
    expect(calls).toHaveLength(2);
    const body = promptOf(calls[1]?.body);
    expect(body).toMatch(/has no bed in /);
    expect(body).toContain('Pieces of your answer the app left out, with why and how to fix it');
    expect(body).toContain('L1 left out');
    expect(body).toContain('“bed1”: there’s no piece “P99” in the flat.');
    expect(body).toContain('Place a new `bed-queen` with keep: null');
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

describe('free fixes and room vetting (designer listens, B1)', () => {
  const sse = (answer: unknown) =>
    new Response(anthropicStream(answer, USAGE), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  const couple: DesignBrief = {
    ...brief,
    sleeping: { 'rm_main-bedroom': ['adult-1', 'adult-2'], rm_bedroom: ['elder-1'] },
  };
  const main = (c: { step: string }) => /furnish "(Master|Main) bedroom"/.test(c.step);
  /** The benchmark's main bedroom answer (by intent) with its bed left out. */
  const noBed = () => ({
    ...sampleMain,
    items: sampleMain.items.filter((i) => i.ref !== 'bed1'),
  });

  it('a main bedroom answer with no bed gets the app’s queen bed, with no request (11)', async () => {
    const prov = provider('anthropic', {
      auto: true,
      reply: (c) => (main(c) ? sse(noBed()) : null),
    });
    const { state, design } = await start('anthropic', {
      fetch: prov.fetch,
      ctx: { ...ctx, brief: couple },
      design: { ...fresh(), brief: couple },
    }).run;
    expect(state.phase).toBe('done');
    // One request for the room: the free fix sent nothing, and no fix round was needed for it.
    expect(prov.calls.filter(main)).toHaveLength(1);
    const space = design.spaces['rm_main-bedroom'];
    const app = space?.design?.items.filter((i) => i.ref.startsWith('app:')) ?? [];
    expect(app.map((i) => [i.ref, i.assetId])).toEqual([['app:bed', 'bed-queen']]);
    expect(space?.fixes).toBeUndefined();
    const r = designResult(level, level, design);
    expect(r.checks.filter((c) => c.hard && c.key.startsWith('P1|bed|rm_main-bedroom'))).toEqual(
      [],
    );
  });

  it('a layout naming the couple’s room “Study” is vetted before any room is sent (21)', async () => {
    const study = {
      ...CONCEPT,
      rooms: CONCEPT.rooms.map((r) =>
        r.room === 'R2' ? { ...r, name: 'Study', use: 'study' } : r,
      ),
    };
    const prov = provider('anthropic', {
      auto: true,
      reply: (c) => (c.step === 'layout' ? sse(study) : null),
    });
    const { design } = await start('anthropic', {
      fetch: prov.fetch,
      ctx: { ...ctx, brief: couple },
      design: { ...fresh(), brief: couple },
    }).run;
    const kept = design.concept?.rooms.find((r) => r.room === 'R2');
    expect([kept?.name, kept?.use]).toEqual(['Main bedroom', 'master']);
    expect(design.appLines).toEqual([
      'Main bedroom stays a bedroom: You and Partner sleep there. To make it a study, change who sleeps where.',
    ]);
    // The room step asks for the bedroom by its kept name.
    expect(prov.calls.some((c) => c.step === 'furnish "Main bedroom"')).toBe(true);
    expect(prov.calls.some((c) => /furnish "Study"/.test(c.step))).toBe(false);
  });

  it('a fix round whose answer drops the bed: the app puts it back, and its row says so (N1)', async () => {
    // The first answer has its bed and a dining table that doesn't belong; the fix takes the
    // table out, and the bed with it.
    const withTable = {
      ...sampleMain,
      items: [
        ...sampleMain.items,
        { ...sampleMain.items[0], ref: 'dt1', assetId: 'dining-4', why: '', against: 'free' },
      ],
    };
    const prov = provider('anthropic', {
      auto: true,
      reply: (c, n) => (main(c) ? sse(n === 1 ? withTable : noBed()) : null),
    });
    const { design } = await start('anthropic', {
      fetch: prov.fetch,
      ctx: { ...ctx, brief: couple },
      design: { ...fresh(), brief: couple },
    }).run;
    expect(prov.calls.filter(main)).toHaveLength(2);
    const space = design.spaces['rm_main-bedroom'];
    expect(space?.rounds?.[0]?.outcome).toBe('fixed');
    const bed = space?.design?.items.find((i) => i.ref.startsWith('app:'));
    expect(bed?.assetId).toBe('bed-queen');
    expect(bed?.why).toBe('Put back by the app: the fix round’s answer left out the queen bed.');
  });

  it('a free pass that fails leaves the paid answer as it is, and the run goes on (S2)', async () => {
    const prov = provider('anthropic', {
      auto: true,
      reply: (c) => (main(c) ? sse(noBed()) : null),
    });
    const { state, design } = await start('anthropic', {
      fetch: prov.fetch,
      ctx: { ...ctx, brief: couple },
      design: { ...fresh(), brief: couple },
      free: () => Promise.reject(new Error('the worker died')),
    }).run;
    expect(state.phase).toBe('done');
    const space = design.spaces['rm_main-bedroom'];
    expect(space?.status).toBe('done');
    // The answer as the model gave it, metered and kept: no app piece, nothing lost.
    expect(space?.design?.items.map((i) => i.ref).sort()).toEqual(
      noBed()
        .items.map((i) => i.ref)
        .sort(),
    );
    expect(state.usage.some((u) => u.step === 'rm_main-bedroom')).toBe(true);
  });

  it('a space whose furniture the person kept (Change something) gets no free pass (S3)', async () => {
    const prov = provider('anthropic', {
      auto: true,
      reply: (c) => (main(c) ? sse(noBed()) : null),
    });
    const asked: string[][] = [];
    const previous = parseSpaceDesign(noBed(), null);
    if (!previous.ok) throw new Error(previous.error);
    const { design } = await start('anthropic', {
      fetch: prov.fetch,
      ctx: { ...ctx, brief: couple },
      design: { ...fresh(), brief: couple },
      plan: {
        layout: null,
        rooms: ['rm_main-bedroom'],
        previous: { 'rm_main-bedroom': previous.value },
        keep: { 'rm_main-bedroom': ['furniture'] },
      },
      free: (b, f, d, opts, fo) => {
        asked.push([...(fo.spaces ?? [])]);
        return Promise.resolve(freeEssentials(b, f, d, opts, fo));
      },
    }).run;
    expect(asked).toEqual([]);
    const items = design.spaces['rm_main-bedroom']?.design?.items ?? [];
    expect(items.some((i) => i.ref.startsWith('app:'))).toBe(false);
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
    const r = requestFor(AI.anthropic, prompt, undefined, { browser: true });
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
    // 2.5 Pro takes a thinking budget until Google routes it to 3.8 Flash on 1 Dec 2026.
    vi.setSystemTime(Date.parse('2026-11-14T12:00:00Z'));
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

  it('tells Claude it comes from a browser only from one: a server sends the same request without', () => {
    const header = 'anthropic-dangerous-direct-browser-access';
    const server = requestFor(AI.anthropic, prompt);
    const browser = requestFor(AI.anthropic, prompt, undefined, { browser: true });
    expect(server.headers[header]).toBeUndefined();
    expect(browser.headers).toEqual({ ...server.headers, [header]: 'true' });
    expect(browser.body).toEqual(server.body);
    // Only Claude's requests carry it.
    for (const p of ['openai', 'gemini'] as const) {
      expect(requestFor(AI[p], prompt, undefined, { browser: true })).toEqual(
        requestFor(AI[p], prompt),
      );
    }
  });

  it('a run sends the browser header from its page only', async () => {
    const header = 'anthropic-dangerous-direct-browser-access';
    for (const page of [fakePhone().page, undefined]) {
      const prov = provider('anthropic', { auto: true });
      const { state } = await start('anthropic', { fetch: prov.fetch, ...(page ? { page } : {}) })
        .run;
      expect(state.phase).toBe('done');
      expect(prov.calls).toHaveLength(5);
      for (const c of prov.calls) expect(c.headers[header]).toBe(page ? 'true' : undefined);
    }
  });
});

describe('a locked phone: a step cut off while away goes again on return (locked-phone runs, part 1)', () => {
  let phone: Phone;
  beforeEach(() => {
    phone = fakePhone();
  });
  const turn = (to: 'visible' | 'hidden') => phone.turn(to);
  const midRun = (extra: Partial<RunOptions> = {}) => midRunOn(phone, extra);
  const away = (r: Awaited<ReturnType<typeof midRun>>['r'], cut: () => void, ms: number) =>
    awayOn(phone, r, cut, ms);

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
      page: phone.page,
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
});

describe('money safety (issue #67)', () => {
  const facingWall = () => {
    const a = structuredClone(answerFor('furnish "Living')?.answer) as {
      items: Record<string, unknown>[];
    };
    const sofa = a.items.find((i) => i.ref === 'sofa1') as Record<string, unknown>;
    Object.assign(sofa, { wall: null, along: null, at: { x: 8.15, y: 2.6 }, rotation: 180 });
    return a;
  };
  const sse = (p: 'anthropic' | 'gemini', answer: unknown) =>
    new Response((p === 'gemini' ? geminiStream : anthropicStream)(answer, USAGE), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  const living = (c: { step: string }) => c.step === 'furnish "Living';
  /** Living's sofa faces the wall every time, and a child sleeps without a bed in each bedroom. */
  const failing: DesignBrief = {
    ...brief,
    household: { ...brief.household, children: ['primary', 'primary'] },
    sleeping: {
      'rm_main-bedroom': ['adult-1', 'adult-2', 'child-1'],
      rm_bedroom: ['elder-1', 'child-2'],
    },
  };
  const isFix = (c: { body: Record<string, unknown> }) => promptOf(c.body).includes('## Fix round');

  it('rooms paused at the fix gate never take more fix-ups than the run has left', async () => {
    // The tech lead's case: three rooms whose answers fail, one fix-up left, a pause at the
    // gate, then Carry on. Before, every room waiting on the pause sent its fix.
    const prov = provider('anthropic', {
      auto: true,
      reply: (c) => (living(c) ? sse('anthropic', facingWall()) : null),
    });
    let carried = false;
    const asks: ((go: boolean) => void)[] = [];
    const r = start('anthropic', {
      fetch: prov.fetch,
      ctx: { ...ctx, brief: failing },
      design: { ...fresh(), brief: failing },
      fixesLeft: 1,
      askAgain: true,
      overLimit: (next) => next?.kind === 'fix' && !carried,
      confirmOver: () => new Promise<boolean>((res) => asks.push(res)),
    });
    await until(() => r.last()?.phase === 'paused', 'paused at a fix gate');
    // Every other room has its answer meanwhile, and reaches its own gate.
    await vi.advanceTimersByTimeAsync(5000);
    carried = true;
    asks[0]?.(true);
    const { state, design } = await r.run;
    expect(state.phase).toBe('done');
    expect(prov.calls.filter(isFix)).toHaveLength(1);
    const fixes = Object.values(design.spaces).reduce((t, s) => t + (s.fixes ?? 0), 0);
    expect(fixes).toBe(1);
  });

  it('a fix-up held at a paused gate is saved as still left, until its request goes', async () => {
    // Saved while paused, a run carried on after the page closed would have lost it.
    const prov = provider('anthropic', {
      auto: true,
      reply: (c) => (living(c) ? sse('anthropic', facingWall()) : null),
    });
    let carried = false;
    const asks: ((go: boolean) => void)[] = [];
    /** Each save's fix-ups left, and whether the run was paused then. */
    const saves: { left: number; paused: boolean }[] = [];
    const r: ReturnType<typeof start> = start('anthropic', {
      fetch: prov.fetch,
      ctx: { ...ctx, brief: failing },
      design: { ...fresh(), brief: failing },
      fixesLeft: 1,
      askAgain: true,
      overLimit: (next) => next?.kind === 'fix' && !carried,
      confirmOver: () => new Promise<boolean>((res) => asks.push(res)),
      onSave: (_d, info) => {
        saves.push({ left: info.fixesLeft, paused: r.last()?.phase === 'paused' });
      },
    });
    await until(() => r.last()?.phase === 'paused', 'paused at a fix gate');
    // The other rooms finish meanwhile, each saving the run.
    await vi.advanceTimersByTimeAsync(5000);
    const paused = saves.filter((x) => x.paused);
    expect(paused.length).toBeGreaterThan(0);
    expect(paused.map((x) => x.left)).toEqual(paused.map(() => 1));
    carried = true;
    asks[0]?.(true);
    await r.run;
    // Sent: spent.
    expect(saves.at(-1)?.left).toBe(0);
  });

  it('after Carry on, each step that waited is checked again against what it allowed', async () => {
    // Carry on allows one more fix request: the second room waiting asks again, not sends.
    const prov = provider('anthropic', {
      auto: true,
      reply: (c) => (living(c) ? sse('anthropic', facingWall()) : null),
    });
    let allowed = 0;
    let started = 0;
    const asks: ((go: boolean) => void)[] = [];
    const r = start('anthropic', {
      fetch: prov.fetch,
      ctx: { ...ctx, brief: failing },
      design: { ...fresh(), brief: failing },
      askAgain: true,
      onStep: (_key, kind, phase) => {
        if (kind === 'fix' && phase === 'start') started++;
      },
      overLimit: (next) => next?.kind === 'fix' && started >= allowed,
      confirmOver: () => new Promise<boolean>((res) => asks.push(res)),
    });
    await until(() => r.last()?.phase === 'paused', 'paused at a fix gate');
    await vi.advanceTimersByTimeAsync(5000);
    allowed = 1;
    asks[0]?.(true);
    await until(() => asks.length === 2, 'asked again');
    expect(started).toBe(1);
    asks[1]?.(false);
    const { state } = await r.run;
    expect(state.phase).toBe('stopped');
    expect(prov.calls.filter(isFix)).toHaveLength(1);
  });

  it('Gemini 3: the layout and rooms think at high, fix rounds at low', async () => {
    const pro = { ...AI.gemini, model: 'gemini-3.1-pro-preview' };
    const prov = provider('gemini', {
      auto: true,
      reply: (c, n) => (living(c) && n === 1 ? sse('gemini', facingWall()) : null),
    });
    const { state } = await start('gemini', { fetch: prov.fetch, ai: pro }).run;
    expect(state.phase).toBe('done');
    const level = (c: { body: Record<string, unknown> }) =>
      (
        (c.body.generationConfig as Record<string, unknown>).thinkingConfig as Record<
          string,
          unknown
        >
      ).thinkingLevel;
    const fixes = prov.calls.filter(isFix);
    expect(fixes.map(level)).toEqual(['low']);
    const steps = prov.calls.filter((c) => !isFix(c));
    expect(steps).toHaveLength(5);
    expect(new Set(steps.map(level))).toEqual(new Set(['high']));
  });

  it('a model with no price sends nothing: the run halts and says why', async () => {
    const prov = provider('gemini', { auto: true });
    const { state } = await start('gemini', {
      fetch: prov.fetch,
      ai: { ...AI.gemini, model: 'gemini-3-pro' },
    }).run;
    expect(prov.calls).toHaveLength(0);
    expect(state.phase).toBe('halted');
    expect(state.halt).toEqual({ kind: 'unpriced', message: UNPRICED });
    expect(designerCannotUse({ provider: 'gemini', model: 'gemini-3-pro' })).toBe(UNPRICED);
    // With the person's own price for it, it may run.
    const own = {
      'gemini-3-pro': { input: 2, cachedInput: 0.2, cacheWrite: null, output: 12, checked: false },
    };
    expect(designerCannotUse({ provider: 'gemini', model: 'gemini-3-pro' }, own)).toBeNull();
  });
});
