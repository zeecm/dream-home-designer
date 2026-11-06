import type { StepPrompt } from '@dhd/core';
import type { AiSettings, Provider } from '../credentials';
import { errorBody } from '../providers';
import { readSse } from './sse';

/**
 * One designer request, streamed, straight from this browser to the person's provider with
 * their own key: the request each provider takes (its documented REST shape) and the reading
 * of its events. Every step sends the system prompt and the run's stable prefix first, byte
 * for byte, so the provider can cache them; Claude is told where (`cache_control`).
 */

export type Effort = StepPrompt['effort'];

/** What a request streamed: kept as it arrives, so a step cut off can still be metered. */
export interface StepSink {
  /** Each event's parsed JSON, in order (what `usageOf` reads). */
  events: unknown[];
  text: string;
  thinking: string;
  /** Why the answer ended; null while it streams (or if it was cut off). */
  stop: 'end' | 'length' | 'refusal' | null;
}

export const newSink = (): StepSink => ({ events: [], text: '', thinking: '', stop: null });

/** A response that wasn't OK: its status, its body and, where readable, how long to wait. */
export class HttpFail extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly retryAfter: number | null,
  ) {
    super(`HTTP ${status}`);
  }
}

export interface StreamHooks {
  /** The request was accepted and the answer has begun (Claude: `message_start`). */
  onStart?: () => void;
  /** Any event at all (for the quiet timeout). */
  onEvent?: () => void;
  /** The latest line of the model's thinking summary. */
  onThinking?: (line: string) => void;
}

/** Claude's smallest cacheable prefix, in tokens, by model (the claude-api reference). */
export function minCacheable(model: string): number {
  const m = model.toLowerCase();
  if (/opus-4-[56](?!\d)|haiku-4-5(?!\d)/.test(m)) return 4096;
  if (/opus-4-7(?!\d)|haiku-3-5(?!\d)|mythos-preview/.test(m)) return 2048;
  // Opus 4.8, 4.1 and 4 (dated or not), the Sonnet 4s, Sonnet 5 (not 5.5).
  if (
    /opus-4-[18](?!\d)|opus-4(?:-0)?(?!-?\d)|opus-4-\d{8}|sonnet-4(?!-?\d)|sonnet-4-\d{8}|sonnet-4-[56](?!\d)|sonnet-5(?:-0)?(?!-?\d)|sonnet-5-\d{8}/.test(
      m,
    )
  )
    return 1024;
  return 512;
}

const ANTHROPIC_VERSION = '2026-10-21';

/**
 * The Claude models the designer's requests are written for (claude-api models.md): adaptive
 * thinking with summaries, `output_config` effort and a JSON schema. Older ones differ
 * (Haiku 4.5 takes no effort; some take thinking budgets), so they aren't offered.
 */
export const DESIGNER_CLAUDE = [
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-haiku-5-5',
  'claude-fable-5-1',
  'claude-fable-5',
];
/** Where the server-side refusal fallback (`fallbacks: 'default'`) applies: the Opus 5 line. */
const FALLBACK = /^claude-opus-5(-5)?$/;
/** OpenAI models that take `reasoning_effort`. */
const REASONING = /^(gpt-5|o\d)/;

/** Why the designer can't use this model, or null when it can. */
export function designerCannotUse(ai: { provider: string; model: string }): string | null {
  if (ai.provider !== 'anthropic' || DESIGNER_CLAUDE.includes(ai.model.trim())) return null;
  return `The designer works with Claude Opus 5.5 or 5, Sonnet 5.5 or 5, Haiku 5.5 and Fable 5; “${ai.model}” isn’t one of them. Choose one in AI settings.`;
}
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** A short stable label for a run's cache (OpenAI routes requests with it), not the plan's id. */
export function cacheKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `dhd-${(h >>> 0).toString(36)}`;
}

/** The request for one step: where it goes, its headers and its body. */
export function requestFor(
  ai: AiSettings,
  p: StepPrompt,
  effort: Effort = p.effort,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const stable = `${p.prefix}${p.shared}`;
  if (ai.provider === 'anthropic') {
    const fallback = FALLBACK.test(ai.model.trim());
    // Cache the stable blocks (the prefix, then the room steps' shared concept), each only
    // once the prompt up to it is long enough for the model to cache at all.
    const min = minCacheable(ai.model) * 3.2;
    const mark = (chars: number) =>
      chars >= min ? { cache_control: { type: 'ephemeral' as const } } : {};
    const sys = p.system.length;
    const content = [
      { type: 'text', text: p.prefix, ...mark(sys + p.prefix.length) },
      ...(p.shared ? [{ type: 'text', text: p.shared, ...mark(sys + stable.length) }] : []),
      { type: 'text', text: p.tail },
    ];
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'x-api-key': ai.key,
        'anthropic-version': ANTHROPIC_VERSION,
        ...(fallback ? { 'anthropic-beta': FALLBACK_BETA } : {}),
        // The person's own key in their own browser: what this header is for.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: {
        model: ai.model,
        max_tokens: p.maxTokens,
        stream: true,
        system: [{ type: 'text', text: p.system }],
        messages: [{ role: 'user', content }],
        // Summaries stream while it thinks, so a long think isn't taken for a stuck request.
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort, format: { type: 'json_schema', schema: p.schema } },
        // A declined request is retried on Anthropic's recommended model, not failed.
        ...(fallback ? { fallbacks: 'default' } : {}),
      },
    };
  }
  if (ai.provider === 'openai') {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { authorization: `Bearer ${ai.key}` },
      body: {
        model: ai.model,
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: p.maxTokens,
        ...(REASONING.test(ai.model) ? { reasoning_effort: effort } : {}),
        // Every step of a run shares its prefix: one cache key routes them together.
        prompt_cache_key: cacheKey(stable),
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: p.kind === 'layout' ? 'concept' : 'space',
            strict: true,
            schema: p.schema,
          },
        },
        messages: [
          { role: 'system', content: p.system },
          { role: 'user', content: `${stable}${p.tail}` },
        ],
      },
    };
  }
  // Gemini caches matching prefixes by itself (implicit caching).
  const older = /^gemini-2/.test(ai.model);
  const budget = { high: 16_384, medium: 8192, low: 2048 }[effort];
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ai.model)}:streamGenerateContent?alt=sse`,
    headers: { 'x-goog-api-key': ai.key },
    body: {
      systemInstruction: { parts: [{ text: p.system }] },
      contents: [{ role: 'user', parts: [{ text: `${stable}${p.tail}` }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: p.schema,
        maxOutputTokens: p.maxTokens,
        thinkingConfig: {
          includeThoughts: true,
          ...(older
            ? { thinkingBudget: Math.min(budget, Math.floor(p.maxTokens / 2)) }
            : { thinkingLevel: effort === 'low' ? 'low' : 'high' }),
        },
      },
    },
  };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;

/** How long a refused request asks to wait, in seconds: `retry-after`, else Gemini's body. */
export function retryAfterOf(headers: Headers | null, body: unknown): number | null {
  // Not CORS-safelisted, so often unreadable from a browser; the body is the fallback.
  const h = headers?.get('retry-after');
  if (h && /^\d+(\.\d+)?$/.test(h.trim())) return Math.ceil(Number(h));
  const first = Array.isArray(body) ? body[0] : body;
  const details = obj(obj(first)?.error)?.details;
  if (Array.isArray(details)) {
    for (const d of details) {
      const delay = obj(d)?.retryDelay;
      const m = typeof delay === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(delay) : null;
      if (m) return Math.ceil(Number(m[1]));
    }
  }
  return null;
}

/**
 * Sends one step and reads its stream into `sink`. Resolves when the answer ends; throws
 * `HttpFail` for a refused request, and whatever fetch throws (an abort, being offline).
 */
export async function streamStep(
  ai: AiSettings,
  p: StepPrompt,
  effort: Effort,
  sink: StepSink,
  signal: AbortSignal,
  hooks: StreamHooks = {},
  doFetch: typeof fetch = fetch,
): Promise<void> {
  const req = requestFor(ai, p, effort);
  const res = await doFetch(req.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...req.headers },
    body: JSON.stringify(req.body),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await errorBody(res);
    throw new HttpFail(res.status, body, retryAfterOf(res.headers, body));
  }
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    hooks.onStart?.();
  };
  const think = (t: string) => {
    sink.thinking += t;
    // The last line, from the tail only (the whole text grows long).
    const line = sink.thinking.slice(-400).trim().split('\n').pop()?.trim();
    if (line) hooks.onThinking?.(line);
  };
  const read = READERS[ai.provider];
  await readSse(res.body, (e) => {
    hooks.onEvent?.();
    if (e.data === '[DONE]') return;
    let data: unknown;
    try {
      data = JSON.parse(e.data);
    } catch {
      return; // not JSON: nothing we read
    }
    sink.events.push(data);
    read(obj(data) ?? {}, sink, { start, think });
  });
}

type Reader = (
  e: Obj,
  sink: StepSink,
  on: { start: () => void; think: (t: string) => void },
) => void;

/** An error event in the middle of a stream (Claude's `overloaded_error`, say). */
function streamError(e: Obj, provider: Provider): never {
  const err = obj(e.error);
  const type = String(err?.type ?? err?.status ?? '');
  const status = /overloaded/i.test(type)
    ? 529
    : /rate_limit|RESOURCE_EXHAUSTED/i.test(type)
      ? 429
      : typeof err?.code === 'number'
        ? err.code
        : 500;
  throw new HttpFail(status, provider === 'gemini' ? [e] : e, null);
}

const READERS: Record<Provider, Reader> = {
  anthropic: (e, sink, on) => {
    if (e.type === 'error') streamError(e, 'anthropic');
    if (e.type === 'message_start') on.start();
    if (e.type === 'content_block_start') {
      // Declined, and carried on by the fallback model: its answer starts afresh.
      if (obj(e.content_block)?.type === 'fallback') sink.text = '';
    }
    if (e.type === 'content_block_delta') {
      const d = obj(e.delta);
      if (d?.type === 'text_delta' && typeof d.text === 'string') sink.text += d.text;
      if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') on.think(d.thinking);
    }
    if (e.type === 'message_delta') {
      const r = obj(e.delta)?.stop_reason;
      sink.stop = r === 'max_tokens' ? 'length' : r === 'refusal' ? 'refusal' : 'end';
    }
  },
  openai: (e, sink, on) => {
    if (e.error) streamError(e, 'openai');
    on.start();
    const choice = obj(Array.isArray(e.choices) ? e.choices[0] : undefined);
    const delta = obj(choice?.delta);
    if (typeof delta?.content === 'string') sink.text += delta.content;
    if (typeof delta?.refusal === 'string' && delta.refusal) sink.stop = 'refusal';
    const finish = choice?.finish_reason;
    if (typeof finish === 'string' && sink.stop !== 'refusal') {
      sink.stop = finish === 'length' ? 'length' : finish === 'content_filter' ? 'refusal' : 'end';
    }
  },
  gemini: (e, sink, on) => {
    if (e.error) streamError(e, 'gemini');
    on.start();
    if (obj(e.promptFeedback)?.blockReason) sink.stop = 'refusal';
    const cand = obj(Array.isArray(e.candidates) ? e.candidates[0] : undefined);
    const parts = obj(cand?.content)?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const pt = obj(part);
        if (typeof pt?.text !== 'string') continue;
        if (pt.thought) on.think(pt.text);
        else sink.text += pt.text;
      }
    }
    const finish = cand?.finishReason;
    if (typeof finish === 'string') {
      sink.stop =
        finish === 'MAX_TOKENS'
          ? 'length'
          : /SAFETY|RECITATION|PROHIBITED|BLOCKLIST|SPII|IMAGE_SAFETY/.test(finish)
            ? 'refusal'
            : 'end';
    }
  },
};
