import { type Price, priceOf, tokensOf, usdOf } from '@dhd/core';
import { anySignal, failure } from './errors';
import type { Page } from './page';
import { type AiSettings, PROVIDERS } from './providers';
import {
  type Effort,
  HttpFail,
  type StepSink,
  type StreamHooks,
  UNPRICED,
  effortBelow,
  newSink,
} from './stream';

/**
 * One request to the person's provider, with the runner's rules for when it goes wrong
 * (shared by a design run's steps and a talk call): a rate limit waited out (its own figure,
 * else 15 s, then 30 s), a busy server tried once more after 10 s, a dropped connection tried
 * twice more once the page is back in view and online, an unreadable answer asked for once
 * more, an answer too long asked for again at lower effort. A refused key or a spent quota
 * stops at once. Every attempt that streamed is metered, a cut-off one estimated.
 */

/** How long a request may go without a single event. */
export const QUIET_MS = 120_000;
/** Waits after a rate limit when the provider doesn't say how long. */
const RATE_WAITS = [15, 30];
const SERVER_WAIT = 10;
/** Seconds before each try again after the connection dropped (a phone locked, a blip). */
export const NET_WAITS = [3, 10];
/** Longest wait for the tab to be in view and online again before a try, ms. */
const BACK_MS = 10 * 60_000;
/**
 * A design step cut off while the page was out of view (a locked phone) is sent again on
 * return, if the page was away no longer than this; past it, the run is interrupted and the
 * card asks before anything more is spent.
 */
export const AWAY_MS = 10 * 60_000;
/**
 * How many times one step is sent again after the page came back: each time pays for its
 * prompt again, so a third cut-off interrupts the run (its card asks before more is spent).
 */
export const RESENDS = 2;
const ABORT_TEXT = 'Stopped.';

export class Stopped extends Error {}
/**
 * Why a run stopped where it may carry on from: away too long, a step cut off more often
 * than RESENDS, or no room left in its figure (or the tab's limit) to send a step again.
 */
export type InterruptReason = 'away' | 'resent' | 'limit';
/** A run that ends here, ready to carry on when asked (its card says why). */
export class Interrupted extends Error {
  constructor(readonly reason: InterruptReason) {
    super(reason);
  }
}

/**
 * When a page last went out of view (ms since the epoch), and how long it was away the last
 * time it came back: watched from its first request on. A server has no page, never away.
 */
interface Away {
  hiddenAt: number;
  awayFor: number;
}
const watched = new WeakMap<Page, Away>();
const NEVER_AWAY: Readonly<Away> = { hiddenAt: Number.NEGATIVE_INFINITY, awayFor: 0 };
function watchPage(page: Page | undefined): Readonly<Away> {
  if (!page) return NEVER_AWAY;
  const known = watched.get(page);
  if (known) return known;
  const away: Away = {
    hiddenAt: page.hidden() ? Date.now() : Number.NEGATIVE_INFINITY,
    awayFor: 0,
  };
  watched.set(page, away);
  page.onVisibility(() => {
    if (page.hidden()) away.hiddenAt = Date.now();
    else away.awayFor = Date.now() - away.hiddenAt;
  });
  return away;
}
export interface Halt {
  kind: 'quota' | 'key' | 'offline' | 'network' | 'unpriced';
  message: string;
}
export class Halted extends Error {
  constructor(readonly halt: Halt) {
    super(halt.message);
  }
}

/**
 * Resolves once the page is in view and online (a phone suspends a hidden tab's requests,
 * so trying while it is hidden only fails again), or after BACK_MS.
 */
function backOnline(page: Page | undefined, signal: AbortSignal, limit = BACK_MS): Promise<void> {
  const ready = () => !page || (!page.hidden() && !page.offline());
  if (!page || ready()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      stopVisibility();
      stopOnline();
      signal.removeEventListener('abort', done);
      resolve();
    };
    const check = () => {
      if (ready()) done();
    };
    // (A delay past 2^31 ms fires at once: no limit means no timer.)
    const timer = Number.isFinite(limit) ? setTimeout(done, limit) : undefined;
    const stopVisibility = page.onVisibility(check);
    const stopOnline = page.onOnline(check);
    signal.addEventListener('abort', done);
  });
}

/** Waits `ms`, or rejects as stopped when `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Stopped(ABORT_TEXT));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Stopped(ABORT_TEXT));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;

/** What a refused request means for the run. */
export function classify(
  ai: AiSettings,
  f: HttpFail,
): 'quota' | 'key' | 'rate' | 'server' | 'other' {
  const first = Array.isArray(f.body) ? f.body[0] : f.body;
  const err = obj(obj(first)?.error);
  const msg = typeof err?.message === 'string' ? err.message : '';
  // Quota first: OpenAI's insufficient_quota comes as a 429, like a rate limit.
  if (
    ai.provider === 'openai' &&
    (err?.code === 'insufficient_quota' || err?.type === 'insufficient_quota')
  )
    return 'quota';
  if (
    ai.provider === 'anthropic' &&
    (f.status === 402 || err?.type === 'billing_error' || /credit balance|billing/i.test(msg))
  )
    return 'quota';
  if (ai.provider === 'gemini' && f.status === 429) {
    const details = Array.isArray(err?.details) ? err.details : [];
    const daily = details.some((d) =>
      (Array.isArray(obj(d)?.violations) ? (obj(d)?.violations as unknown[]) : []).some((v) =>
        /PerDay/i.test(String(obj(v)?.quotaId ?? '')),
      ),
    );
    if (daily) return 'quota';
  }
  if (failure(ai.provider, f.status, f.body, ai.key).kind === 'key') return 'key';
  if (f.status === 429) return 'rate';
  if (f.status >= 500) return 'server';
  return 'other';
}

/** A request's progress as shown: a design step's row, or a talk call's status line. */
export interface RequestState {
  label: string;
  status: 'waiting' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';
  thinking: string;
  error: string | null;
  wait: {
    seconds: number;
    attempt: number;
    net?: boolean;
    server?: boolean;
    /** Cut off while the page was out of view: waiting for it to come back (and be online). */
    away?: boolean;
  } | null;
  retries: number;
  cutOffHigh: number | null;
  /** This request's sends again after the page came back (a locked phone): not a retry. */
  resent?: number;
  /** The row's sends again, across its requests (its fix rounds too): never reset. */
  resentAll?: number;
}

export interface RequestOptions<T> {
  ai: AiSettings;
  signal: AbortSignal;
  /** The browser page it runs in (out of view, offline); none on a server. */
  page?: Page;
  prices?: Record<string, Price>;
  /** Sends one attempt, streaming into `sink`. */
  send: (effort: Effort, sink: StepSink, signal: AbortSignal, hooks: StreamHooks) => Promise<void>;
  effort: Effort;
  /**
   * The effort an answer cut off at its limit is asked for again at, once, or null for none
   * (`lowerEffort` on the request: one that really thinks less). One step down by default.
   */
  lower?: (effort: Effort) => Effort | null;
  /** The prompt's length and the answer's limit (what a cut-off attempt may still be billed). */
  promptChars: number;
  maxTokens: number;
  /** Its row (mutated as it goes) and the repaint. */
  st: RequestState;
  update: () => void;
  /** Meters an attempt (`finished`: its answer came to an end, with its own usage). */
  meter: (sink: StepSink, ms: number, finished: boolean) => void;
  /** The answer read, or null when it can't be (asked for once more). */
  parse: (text: string) => T | null;
  onStart?: () => void;
  /** A rate limit was met (a run then sends one request at a time). */
  onRate?: () => void;
  /** Each attempt's sink, as it begins (a talk call shows its text as it streams). */
  onAttempt?: (sink: StepSink) => void;
  /** After each event read (the text grew, perhaps). */
  onDelta?: (sink: StepSink) => void;
  /** Thinking lines repaint at most four times a second, across a run's requests. */
  throttle?: { last: number };
  /** Before trying again: why not (the tab's limit reached), or null to go on. */
  mayRetry?: () => string | null;
  /**
   * A design run's step: cut off while the page was out of view, it is sent again at once
   * when the page is back (not counted as a network retry), at most RESENDS times and only
   * while `mayRetry` allows (the run's figure and the tab's limit); else, or when the page was
   * away more than AWAY_MS, the run is interrupted (`Interrupted`). A talk call leaves this off.
   */
  resumeOnReturn?: boolean;
  /** Sent again after the page came back. */
  onResent?: () => void;
}

/** One request, retried as the rules say: its answer, or null when it failed (`st.error`). */
export async function requestStep<T>(o: RequestOptions<T>): Promise<T | null> {
  const { ai, st } = o;
  // No figure, no request: whatever the caller checked, a model with no price never sends one
  // (what it spent could be neither shown nor held to the figure and the tab's limit).
  if (!priceOf(ai.model, o.prices)) throw new Halted({ kind: 'unpriced', message: UNPRICED });
  const name = PROVIDERS[ai.provider].short;
  const page = o.page;
  const away = watchPage(page);
  const isHidden = () => !!page?.hidden();
  // This request's own count (a row's fix round is a request of its own: timed apart); the
  // row's total, which the cap counts, goes on.
  st.resent = 0;
  const throttle = o.throttle ?? { last: 0 };
  const fail = (text: string): null => {
    st.status = 'failed';
    st.error = text;
    st.thinking = '';
    st.wait = null;
    o.update();
    return null;
  };
  let effort = o.effort;
  let waits = 0;
  let server = 0;
  let net = 0;
  let unreadable = 0;
  let long = 0;
  let attempt = 0;
  for (;;) {
    if (o.signal.aborted) throw new Stopped(ABORT_TEXT);
    const no = attempt++ > 0 ? (o.mayRetry?.() ?? null) : null;
    // A design run's step isn't failed for it (it would never be asked for again): the run is
    // interrupted with the step left to do, and its card asks.
    if (no && o.resumeOnReturn) throw new Interrupted('limit');
    if (no) return fail(`${st.label}: ${no}`);
    const ctrl = new AbortController();
    const signal = anySignal([o.signal, ctrl.signal]);
    let quiet = false;
    let timer = setTimeout(() => {
      quiet = true;
      ctrl.abort();
    }, QUIET_MS);
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        quiet = true;
        ctrl.abort();
      }, QUIET_MS);
    };
    const sink = newSink();
    o.onAttempt?.(sink);
    const t0 = Date.now();
    st.status = 'running';
    st.wait = null;
    o.update();
    let error: unknown = null;
    try {
      await o.send(effort, sink, signal, {
        onStart: () => o.onStart?.(),
        onEvent: bump,
        onDelta: () => o.onDelta?.(sink),
        onThinking: (line) => {
          if (line === st.thinking) return;
          st.thinking = line;
          const now = Date.now();
          if (now - throttle.last >= 250) {
            throttle.last = now;
            o.update();
          }
        },
      });
    } catch (e) {
      error = e;
    } finally {
      clearTimeout(timer);
    }
    // Refused before it began: nothing billed. Anything that streamed is metered.
    const refused = error instanceof HttpFail && sink.events.length === 0;
    if (!refused) o.meter(sink, Date.now() - t0, !error && sink.stop !== null);
    if (error) {
      if (o.signal.aborted) {
        st.status = 'cancelled';
        const price = priceOf(ai.model, o.prices);
        st.cutOffHigh = price
          ? usdOf(
              {
                input: tokensOf(o.promptChars),
                cachedInput: 0,
                cacheWrite: 0,
                output: o.maxTokens,
              },
              price,
            )
          : null;
        st.thinking = '';
        o.update();
        throw new Stopped(ABORT_TEXT);
      }
      // Cut off while out of view (a locked phone, another app; a stream that went quiet
      // meanwhile too): not a bad connection. Once the page is back and online it goes again
      // at once, as often as that happens.
      if (o.resumeOnReturn && !(error instanceof HttpFail) && (isHidden() || away.hiddenAt >= t0)) {
        st.wait = { seconds: 0, attempt: 0, away: true };
        o.update();
        await backOnline(page, o.signal, Number.POSITIVE_INFINITY);
        if (o.signal.aborted) throw new Stopped(ABORT_TEXT);
        if (away.awayFor > AWAY_MS) throw new Interrupted('away');
        if ((st.resentAll ?? 0) >= RESENDS) throw new Interrupted('resent');
        if (o.mayRetry?.()) throw new Interrupted('limit');
        st.resent = (st.resent ?? 0) + 1;
        st.resentAll = (st.resentAll ?? 0) + 1;
        st.wait = null;
        o.onResent?.();
        continue;
      }
      if (quiet) return fail(`${st.label}: the model went quiet for two minutes.`);
      if (error instanceof HttpFail) {
        const kind = classify(ai, error);
        const said = failure(ai.provider, error.status, error.body, ai.key);
        if (kind === 'quota') {
          throw new Halted({
            kind: 'quota',
            message:
              'Your key has run out of quota or credit. Top up with your provider, then go on.',
          });
        }
        if (kind === 'key') throw new Halted({ kind: 'key', message: said.message });
        if (kind === 'rate') {
          o.onRate?.();
          if (waits < RATE_WAITS.length) {
            const seconds = Math.max(1, error.retryAfter ?? RATE_WAITS[waits] ?? 30);
            waits++;
            st.retries++;
            for (let s = seconds; s > 0; s--) {
              st.wait = { seconds: s, attempt: waits };
              o.update();
              await sleep(1000, o.signal);
            }
            continue;
          }
          return fail(`${st.label}: ${name} is still limiting requests from your key.`);
        }
        if (kind === 'server' && server < 1) {
          server++;
          st.retries++;
          // The wait is shown, a second at a time, as a rate limit's is.
          for (let s = SERVER_WAIT; s > 0; s--) {
            st.wait = { seconds: s, attempt: server, server: true };
            o.update();
            await sleep(1000, o.signal);
          }
          continue;
        }
        return fail(`${st.label}: ${said.message}`);
      }
      // The connection dropped (a phone locked, a blip): once back in view and online,
      // try again a couple of times before stopping.
      if (net < NET_WAITS.length) {
        const seconds = NET_WAITS[net] ?? 10;
        net++;
        st.retries++;
        st.wait = { seconds, attempt: net, net: true };
        o.update();
        await backOnline(page, o.signal);
        for (let s = seconds; s > 0; s--) {
          st.wait = { seconds: s, attempt: net, net: true };
          o.update();
          await sleep(1000, o.signal);
        }
        continue;
      }
      const offline = !!page?.offline();
      throw new Halted({
        kind: offline ? 'offline' : 'network',
        message: offline ? 'You’re offline.' : `Couldn’t reach ${name}, even after trying again.`,
      });
    }
    if (sink.stop === 'refusal') return fail(`${st.label}: the model declined this request.`);
    if (sink.stop === 'length') {
      const lower = (o.lower ?? effortBelow)(effort);
      if (long < 1 && lower) {
        long++;
        st.retries++;
        effort = lower;
        continue;
      }
      return fail(`${st.label}: the answer was too long for one step.`);
    }
    const value = o.parse(sink.text);
    if (value === null) {
      if (unreadable < 1) {
        unreadable++;
        st.retries++;
        continue;
      }
      return fail(`${st.label}: the model’s answer couldn’t be read.`);
    }
    st.status = 'done';
    st.thinking = '';
    st.wait = null;
    return value;
  }
}
