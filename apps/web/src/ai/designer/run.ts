import {
  type Aspect,
  type Concept,
  type ContextInput,
  type DesignInput,
  type DesignOptions,
  type Lock,
  type ParseResult,
  type Price,
  type SpaceDesign,
  type StepPrompt,
  type Usage,
  aliasesFor,
  designResult,
  layoutStep,
  levelBounds,
  parseConcept,
  parseSpaceDesign,
  priceOf,
  resolveAsset,
  roomStep,
  tokensOf,
  usageOf,
  usdOf,
} from '@dhd/core';
import { type AiSettings, PROVIDERS } from '../credentials';
import { AiError, anySignal, failure } from '../providers';
import { type Effort, HttpFail, type StepSink, newSink, streamStep } from './stream';

/**
 * The designer's runner: the layout-and-style step for the whole flat, then one step per
 * space on the plan as the layout leaves it. The first room runs alone until its answer
 * starts (so the others read the prompt cache it wrote), then two more at a time, one at a
 * time after a rate limit. Each step is kept as it finishes; Stop aborts every request in
 * flight and keeps what's done. Every request's tokens are metered, a cut-off one estimated.
 */

export type StepStatus = 'waiting' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';

export interface StepState {
  /** 'layout', or the space's key. */
  key: string;
  label: string;
  kind: 'layout' | 'room';
  status: StepStatus;
  tokens: number;
  usd: number | null;
  /** Some of its tokens are estimated (it was cut off). */
  estimated: boolean;
  /** The model's latest thinking line, while it runs. */
  thinking: string;
  error: string | null;
  /** Waiting out a rate limit: seconds left, and which wait of two. */
  wait: { seconds: number; attempt: number } | null;
  /** Requests made again (an unreadable answer, a step too long, a busy server). */
  retries: number;
}

export interface Halt {
  kind: 'quota' | 'key' | 'offline' | 'network';
  message: string;
}

export interface RunState {
  steps: StepState[];
  /** paused: the tab's limit was reached, waiting for the person. */
  phase: 'running' | 'paused' | 'done' | 'stopped' | 'halted' | 'failed';
  halt: Halt | null;
  /** This run's requests. */
  usage: Usage[];
  startedAt: number;
  endedAt: number | null;
  /** What the live region says now (once per step, a pause, a failure). */
  said: string;
}

/** A version as the runner builds it. */
export type DraftDesign = DesignInput & { usage: Usage[] };

export interface RunPlan {
  /** Run the layout-and-style step first; null keeps the version's concept. */
  layout: { previous?: Concept | null } | null;
  /** The spaces to furnish: every space of the level after the layout, or these keys. */
  rooms: 'all' | string[];
  /** Spaces not to ask for (everything in them kept). */
  skip?: string[];
  feedback?: string;
  locks?: Lock[];
  /** The answers being changed, by space key. */
  previous?: Record<string, SpaceDesign>;
  /** Per space, what stays as the previous answer had it (locked, or not asked for). */
  keep?: Record<string, Aspect[]>;
}

export interface RunOptions {
  ai: AiSettings;
  /** The run's stable context (its aliases are the prefix's; never changed mid-run). */
  ctx: ContextInput;
  design: DraftDesign;
  plan: RunPlan;
  signal: AbortSignal;
  prices?: Record<string, Price>;
  result?: DesignOptions;
  /** Labels for the room rows before the layout is known. */
  expected?: { key: string; label: string }[];
  fetch?: typeof fetch;
  onUpdate?: (state: RunState) => void;
  /** The version after each step that changed it (never called if the layout fails). */
  onSave?: (design: DraftDesign) => void | Promise<void>;
  onUsage?: (u: Usage) => void;
  /** Whether the tab's limit has been reached. */
  overLimit?: () => boolean;
  /** The limit was reached: true to finish the design, false to stop here. */
  confirmOver?: () => Promise<boolean>;
}

/** How long a step may go without a single event. */
export const QUIET_MS = 120_000;
/** Waits after a rate limit when the provider doesn't say how long. */
const RATE_WAITS = [15, 30];
const SERVER_WAIT = 10;
const LOWER: Record<Effort, Effort | null> = { high: 'medium', medium: 'low', low: null };

class Stopped extends Error {}
class Halted extends Error {
  constructor(readonly halt: Halt) {
    super(halt.message);
  }
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

const ABORT_TEXT = 'Stopped.';

/** Waits `ms`, or rejects as stopped when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
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

/** Furniture or built-ins: which part an answer's piece is. */
function aspectOfAnswer(assetId: string, o: DesignOptions | undefined): Aspect {
  return resolveAsset(assetId, o?.models)?.carpentry ? 'built-ins' : 'furniture';
}

/** A new answer for a space, with what stays (`keep`) as the previous answer had it. */
export function mergeAnswer(
  previous: SpaceDesign | null | undefined,
  next: SpaceDesign,
  keep: Aspect[],
  o?: DesignOptions,
): SpaceDesign {
  if (!previous || !keep.length) return next;
  const kept = (a: string) => keep.includes(aspectOfAnswer(a, o));
  return {
    items: [
      ...previous.items.filter((i) => kept(i.assetId)),
      ...next.items.filter((i) => !kept(i.assetId)),
    ],
    faces: keep.includes('finishes') ? previous.faces : next.faces,
    notes: next.notes,
  };
}

const usdText = (v: number) => (v < 10 ? `US$${v.toFixed(2)}` : `US$${Math.round(v)}`);

export async function runDesign(o: RunOptions): Promise<{ state: RunState; design: DraftDesign }> {
  const { ai, ctx, plan } = o;
  const doFetch = o.fetch ?? fetch.bind(globalThis);
  const design: DraftDesign = structuredClone(o.design);
  const name = PROVIDERS[ai.provider].short;
  const state: RunState = {
    steps: [],
    phase: 'running',
    halt: null,
    usage: [],
    startedAt: Date.now(),
    endedAt: null,
    said: '',
  };
  const blank = (key: string, label: string, kind: StepState['kind']): StepState => ({
    key,
    label,
    kind,
    status: 'waiting',
    tokens: 0,
    usd: 0,
    estimated: false,
    thinking: '',
    error: null,
    wait: null,
    retries: 0,
  });
  if (plan.layout) state.steps.push(blank('layout', 'Layout and style', 'layout'));
  const roomRows =
    plan.rooms === 'all' ? (o.expected ?? []) : plan.rooms.map((key) => ({ key, label: key }));
  for (const r of roomRows) state.steps.push(blank(r.key, r.label, 'room'));

  const update = () =>
    o.onUpdate?.({ ...state, steps: state.steps.map((s) => ({ ...s })), usage: [...state.usage] });
  const say = (text: string) => {
    state.said = text;
  };
  const spentSoFar = () => state.usage.reduce((t, u) => t + (u.usd ?? 0), 0);
  let saving: Promise<void> = Promise.resolve();
  const save = () => {
    const snapshot = structuredClone(design);
    saving = saving.then(() => o.onSave?.(snapshot)).catch(() => {});
    return saving;
  };

  // The limit: checked before each step; one question at a time while paused.
  let asking: Promise<boolean> | null = null;
  let stopping = false;
  // Once the person says finish, the rest of the run goes on past the limit.
  let allowOver = false;
  const aborted = new Promise<boolean>((resolve) => {
    if (o.signal.aborted) resolve(false);
    o.signal.addEventListener('abort', () => resolve(false), { once: true });
  });
  const mayStart = async (): Promise<boolean> => {
    if (stopping || o.signal.aborted) return false;
    if (allowOver || !o.overLimit?.()) return true;
    if (!asking) {
      state.phase = 'paused';
      say(`Paused: this tab has reached its limit. ${usdText(spentSoFar())} spent on this design.`);
      update();
      asking = (o.confirmOver?.() ?? Promise.resolve(false)).then((go) => {
        state.phase = 'running';
        if (go) allowOver = true;
        else stopping = true;
        update();
        return go;
      });
    }
    // Stop while paused ends the wait too.
    const go = await Promise.race([asking, aborted]);
    return go && !o.signal.aborted;
  };

  let cap = 2;
  let lastThought = 0;

  /** Meters one request (`finished`: its answer came to an end, with its own usage). */
  const meter = (p: StepPrompt, sink: StepSink, st: StepState, ms: number, finished: boolean) => {
    const promptChars = p.system.length + p.prefix.length + p.shared.length + p.tail.length;
    const outputChars = sink.text.length + sink.thinking.length;
    let u = usageOf(ai.provider, sink.events, {
      step: st.key,
      model: ai.model,
      ms,
      ...(o.prices ? { prices: o.prices } : {}),
      promptChars,
      outputChars,
    });
    if (!finished) {
      // Cut off before its usage arrived: what streamed, counted from its characters.
      const output = Math.max(u.output, tokensOf(outputChars));
      const price = priceOf(u.model, o.prices);
      u = { ...u, output, estimated: true, usd: price ? usdOf({ ...u, output }, price) : null };
    }
    state.usage.push(u);
    design.usage.push(u);
    st.tokens += u.input + u.cachedInput + u.cacheWrite + u.output;
    st.usd = st.usd === null || u.usd === null ? null : st.usd + u.usd;
    st.estimated ||= u.estimated;
    o.onUsage?.(u);
  };

  const fail = (st: StepState, text: string): null => {
    st.status = 'failed';
    st.error = text;
    st.thinking = '';
    st.wait = null;
    say(`${text}`);
    update();
    return null;
  };

  /** One step, retried as the rules say; its parsed answer, or null when it failed. */
  async function step<T>(
    p: StepPrompt,
    st: StepState,
    parse: (raw: unknown) => ParseResult<T>,
    onStart?: () => void,
  ): Promise<T | null> {
    let effort = p.effort;
    let waits = 0;
    let server = 0;
    let unreadable = 0;
    let long = 0;
    for (;;) {
      if (o.signal.aborted) throw new Stopped(ABORT_TEXT);
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
      const t0 = Date.now();
      st.status = 'running';
      st.wait = null;
      update();
      let error: unknown = null;
      try {
        await streamStep(
          ai,
          p,
          effort,
          sink,
          signal,
          {
            onStart: () => onStart?.(),
            onEvent: bump,
            onThinking: (line) => {
              if (line === st.thinking) return;
              st.thinking = line;
              // At most four repaints a second while it thinks.
              const now = Date.now();
              if (now - lastThought >= 250) {
                lastThought = now;
                update();
              }
            },
          },
          doFetch,
        );
      } catch (e) {
        error = e;
      } finally {
        clearTimeout(timer);
      }
      // Refused before it began: nothing billed. Anything that streamed is metered.
      const refused = error instanceof HttpFail && sink.events.length === 0;
      if (!refused) meter(p, sink, st, Date.now() - t0, !error && sink.stop !== null);
      if (error) {
        if (o.signal.aborted) {
          st.status = 'cancelled';
          st.thinking = '';
          update();
          throw new Stopped(ABORT_TEXT);
        }
        if (quiet) return fail(st, `${st.label}: the model went quiet for two minutes.`);
        if (error instanceof HttpFail) {
          const kind = classify(ai, error);
          const said = failure(ai.provider, error.status, error.body, ai.key);
          if (kind === 'quota') {
            throw new Halted({
              kind: 'quota',
              message:
                'Your key has run out of quota or credit. Steps already done are kept. Top up with your provider, then finish the design.',
            });
          }
          if (kind === 'key') throw new Halted({ kind: 'key', message: said.message });
          if (kind === 'rate') {
            cap = 1;
            if (waits < RATE_WAITS.length) {
              const seconds = Math.max(1, error.retryAfter ?? RATE_WAITS[waits] ?? 30);
              waits++;
              st.retries++;
              for (let s = seconds; s > 0; s--) {
                st.wait = { seconds: s, attempt: waits };
                update();
                await sleep(1000, o.signal);
              }
              continue;
            }
            return fail(st, `${st.label}: ${name} is still limiting requests from your key.`);
          }
          if (kind === 'server' && server < 1) {
            server++;
            st.retries++;
            await sleep(SERVER_WAIT * 1000, o.signal);
            continue;
          }
          return fail(st, `${st.label}: ${said.message}`);
        }
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        throw new Halted({
          kind: offline ? 'offline' : 'network',
          message: offline
            ? 'You’re offline. Steps already done are kept; finish the design once you’re back online.'
            : `Couldn’t reach ${name}. Steps already done are kept; finish the design in a moment.`,
        });
      }
      if (sink.stop === 'refusal') return fail(st, `${st.label}: the model declined this request.`);
      if (sink.stop === 'length') {
        const lower = LOWER[effort];
        if (long < 1 && lower) {
          long++;
          st.retries++;
          effort = lower;
          continue;
        }
        return fail(st, `${st.label}: the answer was too long for one step.`);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(sink.text);
      } catch {
        raw = undefined;
      }
      const r = raw === undefined ? null : parse(raw);
      if (!r || !r.ok) {
        if (unreadable < 1) {
          unreadable++;
          st.retries++;
          continue;
        }
        return fail(st, `${st.label}: the model’s answer couldn’t be read.`);
      }
      st.status = 'done';
      st.thinking = '';
      st.wait = null;
      return r.value;
    }
  }

  const finish = (phase: RunState['phase']) => {
    state.phase = phase;
    state.endedAt = Date.now();
    for (const st of state.steps) {
      if (st.status === 'waiting') st.status = 'skipped';
      if (st.status === 'running') st.status = 'cancelled';
      st.thinking = '';
      st.wait = null;
    }
    update();
  };

  const ended = async (phase: RunState['phase']) => {
    finish(phase);
    await saving;
    return { state, design };
  };

  try {
    // 1. The layout and style.
    if (plan.layout) {
      const st = state.steps[0] as StepState;
      if (!(await mayStart())) return ended('stopped');
      const bounds = levelBounds(ctx.base);
      const prompt = layoutStep(ctx, {
        ...(plan.feedback ? { feedback: plan.feedback } : {}),
        locks: plan.locks ?? [],
        previous: plan.layout.previous ?? null,
      });
      const concept = await step(prompt, st, (raw) => parseConcept(raw, bounds));
      if (!concept) return ended('failed');
      design.concept = concept;
      say(`Layout and style done. ${usdText(spentSoFar())} so far.`);
      update();
    }

    // 2. The spaces, on the plan as the layout leaves it.
    const r0 = designResult(ctx.base, ctx.before, { ...design, spaces: {} }, o.result);
    const all = r0.spaces.map((s) => s.key);
    const wanted = (plan.rooms === 'all' ? all : plan.rooms).filter(
      (k) => all.includes(k) && !(plan.skip ?? []).includes(k),
    );
    if (plan.layout && plan.rooms === 'all') {
      // Answers for spaces the new walls did away with go.
      for (const k of Object.keys(design.spaces)) if (!all.includes(k)) delete design.spaces[k];
    }
    const others = Object.fromEntries(
      Object.entries(design.spaces).filter(([k]) => !wanted.includes(k)),
    );
    const r = designResult(ctx.base, ctx.before, { ...design, spaces: others }, o.result);
    design.aliases = aliasesFor(r.level, design.aliases);
    const spaces = r.spaces.filter((s) => wanted.includes(s.key));
    // The room rows as they really are.
    const layoutRow = state.steps.filter((s) => s.kind === 'layout');
    state.steps = [...layoutRow, ...spaces.map((s) => blank(s.key, s.name, 'room'))];
    for (const s of spaces) design.spaces[s.key] = { name: s.name, status: 'skipped' };
    if (plan.layout) await save();
    update();

    const bounds = levelBounds(r.level);
    // A run-stopping error (a refused key, a quota): set before the first room's gate opens,
    // so no other room is sent after it.
    let runError: unknown = null;
    const room = async (s: (typeof spaces)[number], onStart?: () => void) => {
      const st = state.steps.find((x) => x.key === s.key) as StepState;
      if (!(await mayStart())) {
        onStart?.();
        return;
      }
      const prompt = roomStep(ctx, s, r.level, design.aliases, {
        concept: design.concept,
        ...(plan.feedback ? { feedback: plan.feedback } : {}),
        locks: plan.locks ?? [],
        previous: plan.previous?.[s.key] ?? null,
      });
      try {
        const answer = await step(prompt, st, (raw) => parseSpaceDesign(raw, bounds), onStart);
        if (answer) {
          design.spaces[s.key] = {
            name: s.name,
            status: 'done',
            design: mergeAnswer(plan.previous?.[s.key], answer, plan.keep?.[s.key] ?? [], o.result),
          };
          say(`${s.name} done. ${usdText(spentSoFar())} so far.`);
        } else {
          design.spaces[s.key] = { name: s.name, status: 'failed', error: st.error ?? '' };
        }
      } catch (e) {
        if (e instanceof Stopped) design.spaces[s.key] = { name: s.name, status: 'cancelled' };
        runError ??= e;
      } finally {
        onStart?.();
        update();
        void save();
      }
    };

    const [first, ...rest] = spaces;
    if (first) {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const firstDone = room(first, release);
      await gate;
      const queue = [...rest];
      await new Promise<void>((resolve) => {
        let running = 0;
        const pump = () => {
          while (queue.length && running < cap && !runError && !stopping && !o.signal.aborted) {
            const s = queue.shift() as (typeof spaces)[number];
            running++;
            room(s).finally(() => {
              running--;
              pump();
            });
          }
          if (running === 0) resolve();
        };
        pump();
      });
      await firstDone;
      if (runError) throw runError;
    }
    const done = state.steps.filter((s) => s.status === 'done').length;
    if (stopping || o.signal.aborted) {
      say('Stopped. Finished steps are kept.');
      return ended('stopped');
    }
    const total = spentSoFar();
    say(
      done === state.steps.length
        ? `Design done. ${usdText(total)} in all.`
        : `Design done, with ${state.steps.length - done} ${state.steps.length - done === 1 ? 'step' : 'steps'} not designed. ${usdText(total)} in all.`,
    );
    return ended('done');
  } catch (e) {
    if (e instanceof Stopped || o.signal.aborted) {
      say('Stopped. Finished steps are kept.');
      return ended('stopped');
    }
    if (e instanceof Halted) {
      state.halt = e.halt;
      say(e.halt.message);
      return ended('halted');
    }
    state.halt = {
      kind: 'network',
      message: e instanceof AiError ? e.message : 'Something went wrong. Finished steps are kept.',
    };
    return ended('halted');
  }
}
