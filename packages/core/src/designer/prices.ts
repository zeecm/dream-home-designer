import type { StepPrompt } from './prompts';
import type { DesignBrief, Provider, Usage } from './schema';

/**
 * What a design costs on the person's own key, in US$ (providers bill in US$; the
 * renovation's own cost stays in S$). List prices per million tokens, as of PRICES_AS_OF;
 * a browser can override them (the web app keeps overrides in localStorage). No prices are
 * fetched. A model not in the table (by exact id, then the longest listed prefix) has none.
 */
export interface Price {
  input: number;
  cachedInput: number;
  /** Writing the prompt cache; null where the provider caches for free. */
  cacheWrite: number | null;
  /** Output, thinking included. */
  output: number;
  /** Checked against the provider's own pricing page; otherwise "list price, check your provider". */
  checked: boolean;
  /** Prompts longer than `prompt` tokens are billed at these. */
  above?: {
    prompt: number;
    input: number;
    cachedInput: number;
    cacheWrite: number | null;
    output: number;
  };
}

export const PRICES_AS_OF = '2026-11';

export const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20, checked: true },
  'claude-sonnet-5-5': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10, checked: true },
  'claude-haiku-5-5': {
    input: 0.1,
    cachedInput: 0.01,
    cacheWrite: 0.125,
    output: 0.5,
    checked: false,
    above: { prompt: 100_000, input: 0.5, cachedInput: 0.05, cacheWrite: 0.625, output: 2.5 },
  },
  'gpt-5': { input: 1.25, cachedInput: 0.125, cacheWrite: null, output: 10, checked: false },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, cacheWrite: null, output: 2, checked: false },
  'gemini-2.5-pro': {
    input: 1.25,
    cachedInput: 0.31,
    cacheWrite: null,
    output: 10,
    checked: false,
  },
  'gemini-2.5-flash': {
    input: 0.3,
    cachedInput: 0.03,
    cacheWrite: null,
    output: 2.5,
    checked: false,
  },
};

/** What may follow a listed id in a dated snapshot of it: -20261101, -2025-08-07, -001. */
const SNAPSHOT = /^-(\d{8}|\d{4}-\d{2}-\d{2}|\d{3})$/;

/**
 * A model's price: by its exact id, then by a listed id it is a dated snapshot of (so
 * gpt-5-2025-08-07 is gpt-5, but gpt-5-pro is not).
 */
export function priceOf(model: string, table: Record<string, Price> = PRICES): Price | null {
  const id = model.trim().toLowerCase();
  if (table[id]) return table[id] ?? null;
  const prefix = Object.keys(table)
    .filter((k) => id.startsWith(k) && SNAPSHOT.test(id.slice(k.length)))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? (table[prefix] ?? null) : null;
}

type Counts = Pick<Usage, 'input' | 'cachedInput' | 'cacheWrite' | 'output'>;

/** US$ for a request's tokens at `price` (a cache write at the input rate where it's free). */
export function usdOf(u: Counts, price: Price): number {
  const prompt = u.input + u.cachedInput + u.cacheWrite;
  const p = price.above && prompt > price.above.prompt ? price.above : price;
  return (
    (u.input * p.input +
      u.cachedInput * p.cachedInput +
      u.cacheWrite * (p.cacheWrite ?? p.input) +
      u.output * p.output) /
    1e6
  );
}

/** Characters per token, for estimating a prompt before it is sent. */
export const CHARS_PER_TOKEN = 3.2;
export const tokensOf = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

/** Output a step typically takes (thinking included), and at most (its max_tokens). */
export const OUTPUT: Record<
  DesignBrief['quality'],
  Record<StepPrompt['kind'], { typical: number; max: number }>
> = {
  thorough: { layout: { typical: 8000, max: 24_000 }, room: { typical: 5000, max: 12_000 } },
  quick: { layout: { typical: 4000, max: 12_000 }, room: { typical: 2500, max: 6000 } },
};

export interface StepEstimate {
  step: string;
  kind: StepPrompt['kind'];
  input: number;
  /** Of `input`, the stable part a provider can cache. */
  cacheable: number;
  output: { typical: number; high: number };
  usd: { typical: number; high: number } | null;
}

export interface RunEstimate {
  requests: number;
  steps: StepEstimate[];
  input: number;
  tokens: { typical: number; high: number };
  /** Null when the model has no price. */
  usd: { typical: number; high: number } | null;
  /** The largest prompt of any step, in tokens. */
  largestInput: number;
}

/**
 * What a run will cost, from the prompts actually built. Each step's input is its prompt's
 * characters ÷ 3.2; typical output from the table, high its max_tokens. Typical reads the
 * stable prefix from cache from the second room step on, where the provider caches (Claude
 * writes it on the first room step, at the cache-write rate); high assumes no cache at all.
 * Retries aren't in it.
 */
export function estimateRun(
  prompts: StepPrompt[],
  opts: {
    provider: Provider;
    model: string;
    quality: DesignBrief['quality'];
    prices?: Record<string, Price>;
  },
): RunEstimate {
  const price = priceOf(opts.model, opts.prices);
  let room = 0;
  const steps = prompts.map((p): StepEstimate => {
    const input = tokensOf(p.system.length + p.prefix.length + p.shared.length + p.tail.length);
    const cacheable = Math.min(
      input,
      tokensOf(p.system.length + p.prefix.length + p.shared.length),
    );
    const out = OUTPUT[opts.quality][p.kind];
    const n = p.kind === 'room' ? ++room : 0;
    let usd: StepEstimate['usd'] = null;
    if (price) {
      const typical: Counts =
        n >= 2
          ? { input: input - cacheable, cachedInput: cacheable, cacheWrite: 0, output: out.typical }
          : n === 1 && opts.provider === 'anthropic'
            ? {
                input: input - cacheable,
                cachedInput: 0,
                cacheWrite: cacheable,
                output: out.typical,
              }
            : { input, cachedInput: 0, cacheWrite: 0, output: out.typical };
      usd = {
        typical: usdOf(typical, price),
        high: usdOf({ input, cachedInput: 0, cacheWrite: 0, output: out.max }, price),
      };
    }
    return {
      step: p.step,
      kind: p.kind,
      input,
      cacheable,
      output: { typical: out.typical, high: out.max },
      usd,
    };
  });
  const sum = (f: (s: StepEstimate) => number) => steps.reduce((t, s) => t + f(s), 0);
  return {
    requests: steps.length,
    steps,
    input: sum((s) => s.input),
    tokens: {
      typical: sum((s) => s.input + s.output.typical),
      high: sum((s) => s.input + s.output.high),
    },
    usd: price
      ? { typical: sum((s) => s.usd?.typical ?? 0), high: sum((s) => s.usd?.high ?? 0) }
      : null,
    largestInput: Math.max(0, ...steps.map((s) => s.input)),
  };
}
