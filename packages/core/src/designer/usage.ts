import { PRICES, type Price, meteredPrice, tokensOf, usdOf } from './prices';
import type { Provider, Usage } from './schema';

/**
 * A request's tokens, read from the provider's own streamed events, in one shape for all
 * three. The counts mean different things per provider, so they are normalised:
 * - Claude's `input_tokens` leaves out cached tokens (read and written, counted apart);
 *   its `output_tokens` include thinking.
 * - OpenAI's `prompt_tokens` include the cached ones; `completion_tokens` include reasoning.
 * - Gemini's `promptTokenCount` includes cached content; output billed is candidates plus
 *   thoughts.
 * In `Usage`, `input` is what is billed at the input rate (cached tokens taken out). The
 * price is that of the model the response names.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export interface UsageOpts {
  step: string;
  /** The model asked for, if the response doesn't name one. */
  model: string;
  ms: number;
  prices?: Record<string, Price>;
  /** When the usage never arrived: the prompt's and the streamed answer's characters. */
  promptChars?: number;
  outputChars?: number;
}

/**
 * The usage in a request's events (the parsed JSON of each streamed event, in order), or an
 * estimate from characters when they carry none (a step stopped or failed early).
 */
export function usageOf(provider: Provider, events: unknown[], opts: UsageOpts): Usage {
  const counts = read(provider, events, opts.outputChars ?? 0);
  const model = counts?.model ?? opts.model;
  const price = meteredPrice(model, opts.model, opts.prices ?? PRICES);
  const c = counts ?? {
    input: tokensOf(opts.promptChars ?? 0),
    cachedInput: 0,
    cacheWrite: 0,
    output: tokensOf(opts.outputChars ?? 0),
    reasoning: null,
  };
  return {
    step: opts.step,
    provider,
    model,
    input: c.input,
    cachedInput: c.cachedInput,
    cacheWrite: c.cacheWrite,
    output: c.output,
    reasoning: c.reasoning,
    estimated: !counts || !!counts.estimated,
    usd: price ? usdOf(c, price) : null,
    ms: opts.ms,
  };
}

type Counts = Pick<Usage, 'input' | 'cachedInput' | 'cacheWrite' | 'output' | 'reasoning'> & {
  model?: string;
  /** Part of it was counted from characters. */
  estimated?: boolean;
};

function read(provider: Provider, events: unknown[], outputChars: number): Counts | null {
  if (provider === 'anthropic') {
    // message_start carries the prompt's counts; each message_delta the output so far.
    let found = false;
    let ended = false;
    let model: string | undefined;
    const c: Counts = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: null };
    for (const e of events) {
      const ev = obj(e);
      const msg = obj(ev?.message);
      const u = obj(msg?.usage) ?? obj(ev?.usage);
      if (!u) continue;
      found = true;
      if (ev?.type === 'message_delta') ended = true;
      model = str(msg?.model) ?? model;
      c.input = num(u.input_tokens) ?? c.input;
      c.cachedInput = num(u.cache_read_input_tokens) ?? c.cachedInput;
      c.cacheWrite = num(u.cache_creation_input_tokens) ?? c.cacheWrite;
      c.output = num(u.output_tokens) ?? c.output;
    }
    if (!found) return null;
    // Stopped before its final message_delta: message_start's output count is a few tokens,
    // so the streamed answer's characters count instead.
    if (!ended) {
      c.output = Math.max(c.output, tokensOf(outputChars));
      c.estimated = true;
    }
    return { ...c, ...(model ? { model } : {}) };
  }
  if (provider === 'openai') {
    // The last chunk (choices: []) carries the usage, with stream_options.include_usage.
    for (const e of [...events].reverse()) {
      const ev = obj(e);
      const u = obj(ev?.usage);
      if (!u) continue;
      const prompt = num(u.prompt_tokens) ?? 0;
      const cached = Math.min(prompt, num(obj(u.prompt_tokens_details)?.cached_tokens) ?? 0);
      const model = str(ev?.model);
      return {
        input: prompt - cached,
        cachedInput: cached,
        cacheWrite: 0,
        output: num(u.completion_tokens) ?? 0,
        reasoning: num(obj(u.completion_tokens_details)?.reasoning_tokens) ?? null,
        ...(model ? { model } : {}),
      };
    }
    return null;
  }
  for (const e of [...events].reverse()) {
    const ev = obj(e);
    const u = obj(ev?.usageMetadata);
    if (!u) continue;
    const prompt = num(u.promptTokenCount) ?? 0;
    const cached = Math.min(prompt, num(u.cachedContentTokenCount) ?? 0);
    const thoughts = num(u.thoughtsTokenCount);
    const model = str(ev?.modelVersion);
    return {
      input: prompt - cached,
      cachedInput: cached,
      cacheWrite: 0,
      output: (num(u.candidatesTokenCount) ?? 0) + (thoughts ?? 0),
      reasoning: thoughts ?? null,
      ...(model ? { model } : {}),
    };
  }
  return null;
}

/** All a run's tokens, and those read from cache, for "88,410 tokens (12,300 from cache)". */
export function usageTotals(usage: Usage[]): {
  tokens: number;
  cached: number;
  usd: number | null;
  estimated: boolean;
} {
  let tokens = 0;
  let cached = 0;
  let usd: number | null = 0;
  for (const u of usage) {
    tokens += u.input + u.cachedInput + u.cacheWrite + u.output;
    cached += u.cachedInput;
    usd = usd === null || u.usd === null ? null : usd + u.usd;
  }
  return { tokens, cached, usd, estimated: usage.some((u) => u.estimated) };
}
