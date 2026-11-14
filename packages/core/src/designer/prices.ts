import type { StepPrompt } from './prompts';
import type { DesignBrief, Provider, Usage } from './schema';

/**
 * What a design costs on the person's own key, in US$ (providers bill in US$; the
 * renovation's own cost stays in S$). List prices per million tokens, as of PRICES_AS_OF;
 * a browser can override them (the web app keeps overrides in localStorage). No prices are
 * fetched. A model not in the table (by exact id, then a listed id it is a dated snapshot of)
 * has none, and the designer never runs on it (`designerCannotUse` in `@dhd/ai`).
 */
export interface Rates {
  input: number;
  cachedInput: number;
  /** Writing the prompt cache; null where the provider caches for free. */
  cacheWrite: number | null;
  /** Output, thinking included. */
  output: number;
  /** Prompts longer than `prompt` tokens are billed at these. */
  above?: {
    prompt: number;
    input: number;
    cachedInput: number;
    cacheWrite: number | null;
    output: number;
  };
}

export interface Price extends Rates {
  /** Checked against the provider's own pricing page; otherwise "list price, check your provider". */
  checked: boolean;
  /**
   * Announced changes, oldest first: from the UTC day `from` (YYYY-MM-DD) on, these rates
   * replace the ones above (the long-prompt tier stays unless the change sets its own).
   */
  changes?: ({ from: string } & Rates)[];
}

export const PRICES_AS_OF = '2026-11';

/** Gemini 3.6 and 3.8 Flash: twice the price from 1 Jan 2027. */
const FLASH_38: Price = {
  input: 0.75,
  cachedInput: 0.075,
  cacheWrite: null,
  output: 3.75,
  checked: true,
  changes: [{ from: '2027-01-01', input: 1.5, cachedInput: 0.15, cacheWrite: null, output: 7.5 }],
};
const GEMINI_31_PRO: Price = {
  input: 2,
  cachedInput: 0.2,
  cacheWrite: null,
  output: 12,
  checked: true,
  above: { prompt: 200_000, input: 4, cachedInput: 0.4, cacheWrite: null, output: 18 },
};
const GEMINI_25_PRO_LONG = {
  prompt: 200_000,
  input: 2.5,
  cachedInput: 0.25,
  cacheWrite: null,
  output: 15,
};

/**
 * Checked on 14 Nov 2026 against the providers' own pricing pages (standard, paid tier):
 * Anthropic's platform.claude.com/docs/en/about-claude/pricing (cache writes at the 5-minute
 * rate) and Google's aistudio.google.com/docs/pricing (where ai.google.dev/gemini-api/docs/pricing
 * now redirects; cached input is its context caching price, and implicit caching writes for
 * free). OpenAI's are not checked. Every Gemini 3 text model Google lists is here, with the old
 * endpoints it routes to them; not listed, so unpriced and refused: gemini-3-pro (never a Gemini
 * API id) and gemini-3-pro-preview (shut down 9 Mar 2026). The Gemini 4 models aren't priced yet
 * (their requests aren't checked).
 */
export const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20, checked: true },
  'claude-opus-5': { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25, checked: true },
  'claude-sonnet-5-5': { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10, checked: true },
  'claude-sonnet-5': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10, checked: true },
  'claude-haiku-5-5': {
    input: 0.1,
    cachedInput: 0.01,
    cacheWrite: 0.125,
    output: 0.5,
    checked: true,
    above: { prompt: 100_000, input: 0.5, cachedInput: 0.05, cacheWrite: 0.625, output: 2.5 },
  },
  'claude-fable-5-1': {
    input: 10,
    cachedInput: 0.25,
    cacheWrite: 12.5,
    output: 50,
    checked: true,
  },
  'claude-fable-5': { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50, checked: true },
  'gpt-5': { input: 1.25, cachedInput: 0.125, cacheWrite: null, output: 10, checked: false },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, cacheWrite: null, output: 2, checked: false },
  'gemini-3.8-flash': FLASH_38,
  'gemini-3.6-flash': FLASH_38,
  // Older endpoints Google sends to 3.8 and 3.6 Flash (deprecations page): at those models'
  // rates, which the pricing page doesn't list for these ids, so not marked checked.
  'gemini-3.7-flash': { ...FLASH_38, checked: false },
  'gemini-3.5-flash': { ...FLASH_38, checked: false },
  'gemini-3.5-flash-lite': {
    input: 0.3,
    cachedInput: 0.03,
    cacheWrite: null,
    output: 2.5,
    checked: true,
  },
  'gemini-3.1-pro-preview': GEMINI_31_PRO,
  'gemini-3.1-pro-preview-customtools': GEMINI_31_PRO,
  'gemini-3.1-flash-lite': {
    input: 0.25,
    cachedInput: 0.025,
    cacheWrite: null,
    output: 1.5,
    checked: true,
  },
  'gemini-3-flash-preview': {
    input: 0.5,
    cachedInput: 0.05,
    cacheWrite: null,
    output: 3,
    checked: true,
  },
  // From 1 Dec 2026 Google sends its requests to Gemini 3.8 Flash, billed at that model's
  // rates: from the day those pass its own, the dearer of the two, part by part.
  'gemini-2.5-pro': {
    input: 1.25,
    cachedInput: 0.125,
    cacheWrite: null,
    output: 10,
    checked: true,
    above: GEMINI_25_PRO_LONG,
    changes: [
      {
        from: '2027-01-01',
        input: 1.5,
        cachedInput: 0.15,
        cacheWrite: null,
        output: 10,
      },
    ],
  },
  // From 1 Dec 2026 its requests go to Gemini 3.5 Flash-Lite, at the same rates.
  'gemini-2.5-flash': {
    input: 0.3,
    cachedInput: 0.03,
    cacheWrite: null,
    output: 2.5,
    checked: true,
  },
  'gemini-2.5-flash-lite': {
    input: 0.1,
    cachedInput: 0.01,
    cacheWrite: null,
    output: 0.4,
    checked: true,
  },
};

/** What may follow a listed id in a dated snapshot of it: -20261101, -2025-08-07, -001. */
const SNAPSHOT = /^-(\d{8}|\d{4}-\d{2}-\d{2}|\d{3})$/;

/**
 * A model's price: by its exact id, then by a listed id it is a dated snapshot of (so
 * gpt-5-2025-08-07 is gpt-5, but gpt-5-pro is not).
 */
export function priceOf(
  model: string,
  table: Record<string, Price> = PRICES,
  /** When, in ms since the epoch: an announced change applies from its day on. */
  at: number = Date.now(),
): Price | null {
  const id = model.trim().toLowerCase();
  const key = table[id]
    ? id
    : Object.keys(table)
        .filter((k) => id.startsWith(k) && SNAPSHOT.test(id.slice(k.length)))
        .sort((a, b) => b.length - a.length)[0];
  const price = key ? table[key] : undefined;
  return price ? priceOn(price, at) : null;
}

/** A price as it stands on the day of `at`: its latest change by then, if any. */
function priceOn(price: Price, at: number): Price {
  if (!price.changes?.length) return price;
  const day = new Date(at).toISOString().slice(0, 10);
  const change = price.changes.filter((c) => c.from <= day).at(-1);
  if (!change) return price;
  const { from: _from, ...rates } = change;
  return { checked: price.checked, ...(price.above ? { above: price.above } : {}), ...rates };
}

/**
 * The price a request is metered at: the served model's (the response names it), else the
 * asked one's, so a served model the table doesn't know never makes a request free.
 */
export function meteredPrice(
  served: string,
  asked: string,
  table: Record<string, Price> = PRICES,
): Price | null {
  return priceOf(served, table) ?? priceOf(asked, table);
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
  thorough: { layout: { typical: 8000, max: 24_000 }, room: { typical: 5000, max: 16_000 } },
  quick: { layout: { typical: 4000, max: 12_000 }, room: { typical: 2500, max: 8000 } },
};

/** How many times a room's answer is sent back when it fails a hard check, at most. */
export const FIX_ROUNDS = 2;
/** How many fix requests a whole run sends, at most (whatever the rooms). */
export const FIX_PER_RUN = 3;
/** How many times one room's answer may be sent back: once on Quick, twice on Thorough. */
export const fixRoundsFor = (quality: DesignBrief['quality']) =>
  quality === 'quick' ? 1 : FIX_ROUNDS;
/** Tokens a fix round's prompt adds for the failures and where the pieces were placed. */
const FIX_EXTRA = 600;

export interface StepEstimate {
  step: string;
  kind: StepPrompt['kind'];
  input: number;
  /** Of `input`, the stable part a provider can cache. */
  cacheable: number;
  output: { typical: number; high: number };
  /** `fix`: what its fix rounds may add on top of high (the run's cap aside). */
  usd: { typical: number; high: number; fix: number } | null;
}

export interface RunEstimate {
  requests: number;
  steps: StepEstimate[];
  input: number;
  tokens: { typical: number; high: number };
  /**
   * Null when the model has no price. `fix`: what fix rounds may add on top of high, at most
   * FIX_PER_RUN requests in the run.
   */
  usd: { typical: number; high: number; fix: number } | null;
  /** The fix requests a run may send, at most. */
  fixes: number;
  /** The largest prompt of any step, in tokens. */
  largestInput: number;
}

/**
 * What a run will cost, from the prompts actually built. Each step's input is its prompt's
 * characters ÷ 3.2; typical output from the table, high its max_tokens. Typical reads the
 * stable prefix from cache from the second room step on, where the provider caches (Claude
 * writes it on the first room step, at the cache-write rate); high assumes no cache at all.
 * `fix` is what the fix rounds may add on top of high: a room whose answer the app's checks send
 * back goes again up to once (Quick) or twice (Thorough), and a run sends at most FIX_PER_RUN
 * fix requests in all, so the dearest three are counted. Retries aren't in it.
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
  /** Each fix request the rooms may send, priced. */
  const fixOnes: number[] = [];
  const steps = prompts.map((p): StepEstimate => {
    const input = tokensOf(p.system.length + p.prefix.length + p.shared.length + p.tail.length);
    const cacheable = Math.min(
      input,
      tokensOf(p.system.length + p.prefix.length + p.shared.length),
    );
    const out = OUTPUT[opts.quality][p.kind];
    const n = p.kind === 'room' ? ++room : 0;
    // A room step may be sent back to be fixed, once or twice by quality.
    const rounds = p.kind === 'room' ? fixRoundsFor(opts.quality) : 0;
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
      const high = usdOf({ input, cachedInput: 0, cacheWrite: 0, output: out.max }, price);
      // A fix round sends the prompt again with the answer and the failures (about a typical
      // answer's length more), and may write as much as the first.
      const fixOne = usdOf(
        { input: input + out.typical + FIX_EXTRA, cachedInput: 0, cacheWrite: 0, output: out.max },
        price,
      );
      usd = { typical: usdOf(typical, price), high, fix: fixOne * rounds };
      for (let k = 0; k < rounds; k++) fixOnes.push(fixOne);
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
  const roomFixes = steps.filter((s) => s.kind === 'room').length * fixRoundsFor(opts.quality);
  const fixes = Math.min(FIX_PER_RUN, roomFixes);
  return {
    requests: steps.length,
    steps,
    input: sum((s) => s.input),
    tokens: {
      typical: sum((s) => s.input + s.output.typical),
      high: sum((s) => s.input + s.output.high),
    },
    usd: price
      ? {
          typical: sum((s) => s.usd?.typical ?? 0),
          high: sum((s) => s.usd?.high ?? 0),
          fix: [...fixOnes]
            .sort((a, b) => b - a)
            .slice(0, FIX_PER_RUN)
            .reduce((t, v) => t + v, 0),
        }
      : null,
    fixes,
    largestInput: Math.max(0, ...steps.map((s) => s.input)),
  };
}
