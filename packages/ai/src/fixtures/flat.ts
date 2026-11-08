import {
  type DesignBrief,
  type Level,
  aliasesFor,
  defaultBrief,
  sampleFlatProject,
} from '@dhd/core';
import type { AiSettings, Provider } from '../providers';
import { type DraftDesign, type RunOptions, type RunState, runDesign } from '../run';
import { answerFor, promptOf } from './sample';
import { type FixtureUsage, anthropicStream, geminiStream, openaiStream } from './streams';

/**
 * The sample flat for the runner's tests, and a mocked provider that streams the fixtures'
 * answers when released (no test runner needed: a run in any runtime can use it).
 */

export const level = sampleFlatProject('prj_test').levels[0] as Level;
export const brief: DesignBrief = {
  ...defaultBrief(),
  household: { ...defaultBrief().household, elders: ['frame'] },
  budget: { low: 40_000, high: 60_000 },
};
export const aliases = aliasesFor(level);
export const ctx = { base: level, before: level, brief, aliases };
export const AI: Record<Provider, AiSettings> = {
  anthropic: { provider: 'anthropic', key: 'sk-ant-test-0000', model: 'claude-opus-5-5' },
  openai: { provider: 'openai', key: 'sk-test-0000', model: 'gpt-5' },
  gemini: { provider: 'gemini', key: 'AIzaTest0000', model: 'gemini-2.5-pro' },
};
export const USAGE: FixtureUsage = { input: 1000, cached: 3000, output: 2000, thoughts: 500 };
export const STREAMS = { anthropic: anthropicStream, openai: openaiStream, gemini: geminiStream };

export const fresh = (): DraftDesign => ({
  id: 'dsn_run',
  brief,
  aliases,
  concept: null,
  spaces: {},
  usage: [],
});

export interface Call {
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
export function provider(
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

export function start(p: Provider, extra: Partial<RunOptions> & { fetch: typeof fetch }) {
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
