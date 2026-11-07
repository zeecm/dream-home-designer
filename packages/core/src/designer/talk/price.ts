import type { RunEstimate } from '../prices';
import type { Usage } from '../schema';

/**
 * When the designer asks before spending (UX §9.4, tech §3.3): one pure rule for every
 * priced button and every follow-on run. A button that shows its price is consent to that
 * figure; it asks again only under v1's cost-check rules (the tab's first design run, one that
 * may cost US$0.50 or more, or one that would pass the tab's limit). A run that follows a
 * message, with no price shown yet, also asks when its worst case passes the threshold.
 */

/** The per-reply threshold: a figure in US$, or always / never ask. */
export type Threshold = number | 'always' | 'never';
export const DEFAULT_THRESHOLD = 0.25;
export const THRESHOLDS: Threshold[] = [0.1, 0.25, 0.5, 1, 'always', 'never'];
/** v1: a run that may cost this much (its high figure) always shows its cost first. */
export const DEAR_RUN = 0.5;

export type Ask = 'go' | 'ask-threshold' | 'ask-cost-check' | 'ask-limit';

export interface AskInput {
  /** Spent in this tab so far (US$). */
  spentTab: number;
  /** The tab's limit (US$); null: none. */
  cap: number | null;
  threshold: Threshold;
  /** Design runs started in this tab. */
  designRunsThisTab: number;
  /** The run starts from a button that showed its price. */
  pressedPriced: boolean;
}

/** The most a run may cost: every request at its limit, and the dearest fix rounds. */
export const atMostOf = (est: Pick<RunEstimate, 'usd'>): number | null =>
  est.usd ? est.usd.high + est.usd.fix : null;

/** Whether to run a design straight away, or ask first and why. */
export function askRule(est: Pick<RunEstimate, 'usd'>, i: AskInput): Ask {
  const most = atMostOf(est);
  // No price: the limit can't be checked, so every design run asks (as v1).
  if (most === null || !est.usd) return 'ask-cost-check';
  if (i.cap !== null && i.spentTab + most > i.cap) return 'ask-limit';
  if (i.designRunsThisTab === 0) return 'ask-cost-check';
  if (est.usd.high >= DEAR_RUN) return 'ask-cost-check';
  if (i.pressedPriced) return 'go';
  if (i.threshold === 'always') return 'ask-threshold';
  if (i.threshold === 'never') return 'go';
  return most > i.threshold ? 'ask-threshold' : 'go';
}

/** Several runs' estimates as one (a plan's options, run one after another). */
export function estimatePlan(ests: RunEstimate[]): RunEstimate | null {
  const [first, ...rest] = ests;
  if (!first) return null;
  return rest.reduce<RunEstimate>(
    (t, e) => ({
      requests: t.requests + e.requests,
      steps: [...t.steps, ...e.steps],
      input: t.input + e.input,
      tokens: { typical: t.tokens.typical + e.tokens.typical, high: t.tokens.high + e.tokens.high },
      usd:
        t.usd && e.usd
          ? {
              typical: t.usd.typical + e.usd.typical,
              high: t.usd.high + e.usd.high,
              fix: t.usd.fix + e.usd.fix,
            }
          : null,
      fixes: t.fixes + e.fixes,
      largestInput: Math.max(t.largestInput, e.largestInput),
    }),
    first,
  );
}

/**
 * The cost of what was spent (a turn's, or the conversation's): US$ when every request has a
 * price, else null; tokens either way; `estimated` when any was counted from characters.
 */
export function spentOf(usage: readonly Usage[]): {
  usd: number | null;
  tokens: number;
  estimated: boolean;
} {
  let usd: number | null = 0;
  let tokens = 0;
  let estimated = false;
  for (const u of usage) {
    tokens += u.input + u.cachedInput + u.cacheWrite + u.output;
    usd = usd === null || u.usd === null ? null : usd + u.usd;
    estimated ||= u.estimated;
  }
  return { usd, tokens, estimated };
}
