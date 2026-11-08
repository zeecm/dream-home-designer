import {
  type Price,
  type TalkKind,
  type TalkParseContext,
  type TalkPrompt,
  type TalkReply,
  type Usage,
  parseTalkReply,
  partialTalk,
  priceOf,
  talkChars,
  tokensOf,
  usageOf,
  usdOf,
} from '@dhd/core';
import type { AiSettings } from '../../credentials';
import { type Halt, Halted, type RequestState, Stopped, requestStep } from '../request';
import { streamRequest, talkRequestFor } from '../stream';

/**
 * One talk call (tech §2.8): sent with the runner's retry rules, its text read as it streams
 * (`partialTalk`, painted ten times a second at most), its JSON parsed at the end. Every
 * attempt is metered, a cut-off one estimated from its characters. No store is touched here:
 * what came of it is returned, and the caller records it.
 */

export interface TalkCallOptions {
  ai: AiSettings;
  prompt: TalkPrompt;
  parseCtx: TalkParseContext;
  signal: AbortSignal;
  prices?: Record<string, Price>;
  fetch?: typeof fetch;
  /** The reply's words so far (and its kind once known), at most every `paintMs`. */
  onText?: (p: { say: string; kind: TalkKind | null }) => void;
  /** Its thinking line, or a wait (a rate limit, a dropped connection). */
  onStatus?: (st: RequestState) => void;
  onUsage?: (u: Usage) => void;
  paintMs?: number;
}

export type TalkCallResult =
  | { status: 'done'; reply: TalkReply; lines: string[]; usage: Usage[]; say: string }
  | { status: 'failed'; error: string; usage: Usage[]; say: string }
  | { status: 'stopped'; usage: Usage[]; say: string }
  | { status: 'halted'; halt: Halt; usage: Usage[]; say: string };

export async function talkCall(o: TalkCallOptions): Promise<TalkCallResult> {
  const { ai, prompt } = o;
  const st: RequestState = {
    label: 'The reply',
    status: 'waiting',
    thinking: '',
    error: null,
    wait: null,
    retries: 0,
    cutOffHigh: null,
  };
  const usage: Usage[] = [];
  const chars = talkChars(prompt);
  const paintMs = o.paintMs ?? 100;
  let text = '';
  let lastPaint = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const paint = () => {
    timer = null;
    lastPaint = Date.now();
    const p = partialTalk(text);
    o.onText?.({ say: p.say ?? '', kind: p.kind ?? null });
  };
  const settle = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  let read: { reply: TalkReply; lines: string[] } | null = null;
  try {
    const value = await requestStep({
      ai,
      signal: o.signal,
      ...(o.prices ? { prices: o.prices } : {}),
      send: (effort, sink, signal, hooks) =>
        streamRequest(ai, talkRequestFor(ai, prompt, effort), sink, signal, hooks, o.fetch),
      effort: prompt.effort,
      promptChars: chars.all,
      maxTokens: prompt.maxTokens,
      st,
      update: () => o.onStatus?.({ ...st }),
      meter: (sink, ms, finished) => {
        const outputChars = sink.text.length + sink.thinking.length;
        let u = usageOf(ai.provider, sink.events, {
          step: 'talk',
          model: ai.model,
          ms,
          ...(o.prices ? { prices: o.prices } : {}),
          promptChars: chars.all,
          outputChars,
        });
        if (!finished) {
          // Cut off before its usage came: what streamed, counted from its characters.
          const output = Math.max(u.output, tokensOf(outputChars));
          const price = priceOf(u.model, o.prices);
          u = { ...u, output, estimated: true, usd: price ? usdOf({ ...u, output }, price) : null };
        }
        usage.push(u);
        o.onUsage?.(u);
      },
      parse: (raw) => {
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          return null;
        }
        const r = parseTalkReply(json, o.parseCtx);
        return r.ok ? { reply: r.reply, lines: r.lines } : null;
      },
      // A new attempt (a retry) starts its text afresh.
      onAttempt: () => {
        settle();
        text = '';
        o.onText?.({ say: '', kind: null });
      },
      onDelta: (sink) => {
        if (sink.text === text) return;
        text = sink.text;
        if (timer) return;
        timer = setTimeout(paint, Math.max(0, paintMs - (Date.now() - lastPaint)));
      },
    });
    read = value;
  } catch (e) {
    settle();
    const say = partialTalk(text).say ?? '';
    if (e instanceof Stopped) return { status: 'stopped', usage, say };
    if (e instanceof Halted) return { status: 'halted', halt: e.halt, usage, say };
    return { status: 'failed', error: 'Something went wrong.', usage, say };
  }
  settle();
  const say = partialTalk(text).say ?? '';
  if (!read) {
    return {
      status: 'failed',
      error: st.error ?? 'The model’s answer couldn’t be read.',
      usage,
      say,
    };
  }
  return { status: 'done', reply: read.reply, lines: read.lines, usage, say: read.reply.say };
}
