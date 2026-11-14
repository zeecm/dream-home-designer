import {
  type Aspect,
  type ContextInput,
  type DesignInput,
  type DesignOptions,
  type DesignResult,
  type DraftDesign,
  FIX_PER_RUN,
  type FixRequest,
  type Level,
  type ParseResult,
  type Price,
  type RunPlan,
  type SpaceDesign,
  type StepPrompt,
  type Usage,
  aliasesFor,
  designResult,
  fixRoundsFor,
  layoutStep,
  lensOn,
  levelBounds,
  meteredPrice,
  parseConcept,
  parseSpaceDesign,
  placedWords,
  resolveAsset,
  roomStep,
  tokensOf,
  usageOf,
  usdOf,
} from '@dhd/core';
import { AiError } from './errors';
import type { Page } from './page';
import { type AiSettings, PROVIDERS } from './providers';
import {
  type Halt,
  Halted,
  type InterruptReason,
  Interrupted,
  Stopped,
  requestStep,
} from './request';
import { type StepSink, fixStepFor, lowerEffort, requestFor, streamStep } from './stream';

/**
 * The designer's runner: the layout-and-style step for the whole flat, then one step per
 * space on the plan as the layout leaves it. The first room runs alone until its answer
 * starts (so the others read the prompt cache it wrote), then two more at a time, one at a
 * time after a rate limit. Each step is kept as it finishes; Stop aborts every request in
 * flight and keeps what's done. Every request's tokens are metered, a cut-off one estimated.
 * Each room's answer is placed and checked as it arrives: hard checks it fails go back to the
 * designer (once a room on Quick, twice on Thorough, FIX_PER_RUN requests in a run at most,
 * with the app's own lines) before the version is shown.
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
  /**
   * Waiting out a rate limit, or for the connection to come back: seconds left, and which
   * wait of two.
   */
  wait: {
    seconds: number;
    attempt: number;
    net?: boolean;
    server?: boolean;
    /** Cut off while the page was out of view: going again once it is back. */
    away?: boolean;
  } | null;
  /** Requests made again (an unreadable answer, a step too long, a busy server). */
  retries: number;
  /** Sent again after the page came back (a locked phone): not a retry of a bad answer. */
  resent: number;
  /** Cut off by Stop: the most it may still be billed (its prompt, and output to its limit). */
  cutOffHigh: number | null;
  /** Sent back to be fixed: which round, and how many checks it failed. */
  fixing: { round: number; problems: number } | null;
}

export type { Halt };

export interface RunState {
  steps: StepState[];
  /**
   * paused: the tab's limit was reached, waiting for the person. interrupted: the page was
   * away too long to carry on by itself (its checkpoint carries on when asked).
   */
  phase: 'running' | 'paused' | 'done' | 'stopped' | 'halted' | 'failed' | 'interrupted';
  halt: Halt | null;
  /** Interrupted: why (away too long, cut off too often, no room left in its figure). */
  interrupt?: InterruptReason | null;
  /** This run's requests. */
  usage: Usage[];
  startedAt: number;
  endedAt: number | null;
  /** What the live region says now (once per step, a pause, a failure). */
  said: string;
}

/** A version as the runner builds it, and what a run asks for (core's). */
export type { DraftDesign, RunPlan };

export interface RunOptions {
  ai: AiSettings;
  /** The run's stable context (its aliases are the prefix's; never changed mid-run). */
  ctx: ContextInput;
  design: DraftDesign;
  plan: RunPlan;
  signal: AbortSignal;
  /**
   * The browser page it runs in: a step cut off while it was out of view goes again on its
   * return. None on a server (no page to wait for, no browser-only header).
   */
  page?: Page;
  prices?: Record<string, Price>;
  result?: DesignOptions;
  /** Labels for the room rows before the layout is known. */
  expected?: { key: string; label: string }[];
  fetch?: typeof fetch;
  onUpdate?: (state: RunState) => void;
  /**
   * The version after each step that changed it (never called if the layout fails), with
   * the fix requests the run may still send.
   */
  onSave?: (design: DraftDesign, info: { fixesLeft: number }) => void | Promise<void>;
  /** Fix requests this run may send (a run carried on keeps what was left); FIX_PER_RUN. */
  fixesLeft?: number;
  /** How long a finished step took: the layout, a room's answer, a fix round (ms). */
  onTimed?: (kind: 'layout' | 'room' | 'fix', ms: number) => void;
  /** A step cut off while the page was out of view was sent again on its return. */
  onResent?: (st: StepState) => void;
  /**
   * A step's request goes ('start'), or came back with its answer ('end'): the layout, a
   * room's answer, a fix round (by the row's key). Not ended when the run stops or is
   * interrupted mid-step.
   */
  onStep?: (key: string, kind: 'layout' | 'room' | 'fix', phase: 'start' | 'end') => void;
  onUsage?: (u: Usage) => void;
  /** Where a version is placed and checked (the designer's worker); else here, at once. */
  results?: (
    base: Level,
    before: Level,
    design: DesignInput,
    opts?: DesignOptions,
  ) => Promise<DesignResult>;
  /**
   * Whether the tab's limit (or the run's figure) has been reached, counting `next` (the step
   * about to be sent) at its most: before each step, and before any request is sent again.
   */
  overLimit?: (next?: { key: string; kind: 'layout' | 'room' | 'fix' }) => boolean;
  /** The limit was reached: true to finish the design, false to stop here. */
  confirmOver?: () => Promise<boolean>;
  /**
   * After "finish", go on only while `overLimit` says so, and ask again the next time it is
   * reached (a new figure set meanwhile); without it the rest of the run goes on past it.
   */
  askAgain?: boolean;
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
    ...(next.v ? { v: next.v } : {}),
    items: [
      ...previous.items.filter((i) => kept(i.assetId)),
      ...next.items.filter((i) => !kept(i.assetId)),
    ],
    faces: keep.includes('finishes') ? previous.faces : next.faces,
    notes: next.notes,
    summary: next.summary,
  };
}

/** What a run interrupted says, by why. */
export const interruptText = (why: InterruptReason) =>
  why === 'away'
    ? 'Paused while you were away. Finished steps are kept.'
    : why === 'resent'
      ? 'Paused: a step was cut off again and again. Finished steps are kept.'
      : 'Paused: this design has used what it was priced at. Finished steps are kept.';

/** Which step a run is on, the same everywhere it is shown: "Step 2 of 5". */
export function progressOf(state: Pick<RunState, 'steps'>): { step: number; of: number } {
  const of = Math.max(1, state.steps.length);
  const done = state.steps.filter((s) => s.status !== 'waiting' && s.status !== 'running').length;
  return { step: Math.min(done + 1, of), of };
}

/** A step not started yet. */
export const blankStep = (key: string, label: string, kind: StepState['kind']): StepState => ({
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
  resent: 0,
  cutOffHigh: null,
  fixing: null,
});

const usdText = (v: number) => (v < 10 ? `US$${v.toFixed(2)}` : `US$${Math.round(v)}`);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** `p`, or Stopped as soon as `signal` aborts (whichever comes first). */
function untilStopped<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Stopped());
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Stopped());
    signal.addEventListener('abort', stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

export async function runDesign(o: RunOptions): Promise<{ state: RunState; design: DraftDesign }> {
  const { ai, ctx, plan } = o;
  // Placed and checked in the designer's worker when there is one; here otherwise. Stop always
  // ends the run, even while a check is out (a worker that hangs or dies says nothing).
  const placeAny = o.results ?? ((b, f, d, opts) => Promise.resolve(designResult(b, f, d, opts)));
  const place: typeof placeAny = (b, f, d, opts) => untilStopped(placeAny(b, f, d, opts), o.signal);
  const doFetch = o.fetch ?? fetch.bind(globalThis);
  const design: DraftDesign = structuredClone(o.design);
  const name = PROVIDERS[ai.provider].short;
  const state: RunState = {
    steps: [],
    phase: 'running',
    halt: null,
    interrupt: null,
    usage: [],
    startedAt: Date.now(),
    endedAt: null,
    said: '',
  };
  const blank = blankStep;
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
  /** Fix requests the run may still send (the estimate counts this many at most). */
  let fixesLeft = o.fixesLeft ?? FIX_PER_RUN;
  const save = () => {
    const snapshot = structuredClone(design);
    const info = { fixesLeft };
    saving = saving.then(() => o.onSave?.(snapshot, info)).catch(() => {});
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
  /**
   * Whether the next step may go (`next`: counted at its most). It is reserved (`onStep`
   * 'start') in the same step as the check passes: two rooms let go together each count the
   * other, never both checked against the room only one of them fits.
   */
  const mayStart = async (next?: {
    key: string;
    kind: 'layout' | 'room' | 'fix';
  }): Promise<boolean> => {
    const reserve = () => {
      if (next) o.onStep?.(next.key, next.kind, 'start');
      return true;
    };
    for (;;) {
      if (stopping || o.signal.aborted) return false;
      if (allowOver || !o.overLimit?.(next)) return reserve();
      if (!asking) {
        state.phase = 'paused';
        say(
          `Paused: this tab has reached its limit. ${usdText(spentSoFar())} spent on this design.`,
        );
        update();
        asking = (o.confirmOver?.() ?? Promise.resolve(false)).then((go) => {
          state.phase = 'running';
          if (go && !o.askAgain) allowOver = true;
          if (!go) stopping = true;
          // Asked once for this figure; the next one is asked afresh.
          if (go && o.askAgain) asking = null;
          update();
          return go;
        });
      }
      // Stop while paused ends the wait too.
      const go = await Promise.race([asking, aborted]);
      if (!go || o.signal.aborted) return false;
      // Carried on: every step that waited on the answer is checked again, one at a time,
      // against what it allowed (each reserved as it goes), so only those that fit it go; one
      // that doesn't asks afresh.
    }
  };

  let cap = 2;

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
    if (!finished && !o.signal.aborted) {
      // Cut off before its usage arrived (a locked phone, a dropped connection): it may be
      // billed in full, its whole prompt and output to its limit, and is counted so (the
      // figure it is held to never assumes less). Stop's cut-off is said apart, at that most.
      const price = meteredPrice(u.model, ai.model, o.prices);
      const most = {
        input: tokensOf(promptChars),
        cachedInput: 0,
        cacheWrite: 0,
        output: Math.max(p.maxTokens, u.output, tokensOf(outputChars)),
      };
      u = { ...u, ...most, estimated: true, usd: price ? usdOf(most, price) : null };
    } else if (!finished) {
      // Cut off by Stop: what streamed, counted from its characters.
      const output = Math.max(u.output, tokensOf(outputChars));
      const price = meteredPrice(u.model, ai.model, o.prices);
      u = { ...u, output, estimated: true, usd: price ? usdOf({ ...u, output }, price) : null };
    }
    state.usage.push(u);
    design.usage.push(u);
    st.tokens += u.input + u.cachedInput + u.cacheWrite + u.output;
    st.usd = st.usd === null || u.usd === null ? null : st.usd + u.usd;
    st.estimated ||= u.estimated;
    o.onUsage?.(u);
  };

  const throttle = { last: 0 };
  /** One step, retried as the rules say; its parsed answer, or null when it failed. */
  function step<T>(
    p: StepPrompt,
    st: StepState,
    parse: (raw: unknown) => ParseResult<T>,
    onStart?: () => void,
  ): Promise<T | null> {
    return requestStep({
      ai,
      signal: o.signal,
      ...(o.page ? { page: o.page } : {}),
      ...(o.prices ? { prices: o.prices } : {}),
      send: (effort, sink, signal, hooks) =>
        streamStep(ai, p, effort, sink, signal, hooks, doFetch, { browser: !!o.page }),
      effort: p.effort,
      lower: (e) => lowerEffort(ai, e, (x) => requestFor(ai, p, x)),
      promptChars: p.system.length + p.prefix.length + p.shared.length + p.tail.length,
      maxTokens: p.maxTokens,
      st,
      update: () => {
        if (st.status === 'failed' && st.error) say(st.error);
        update();
      },
      meter: (sink, ms, finished) => meter(p, sink, st, ms, finished),
      parse: (text) => {
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          return null;
        }
        const r = parse(raw);
        return r.ok ? r.value : null;
      },
      ...(onStart ? { onStart } : {}),
      onRate: () => {
        cap = 1;
      },
      throttle,
      resumeOnReturn: true,
      onResent: () => o.onResent?.(st),
      // No request is sent again past the run's figure or the tab's limit (the room gate's
      // own check): the run is interrupted, and its card asks before more is spent.
      mayRetry: () => (o.overLimit?.() ? 'this design has used what it was priced at.' : null),
    });
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
      if (!(await mayStart({ key: 'layout', kind: 'layout' }))) return ended('stopped');
      const bounds = levelBounds(ctx.base);
      const prompt = layoutStep(ctx, {
        ...(plan.feedback ? { feedback: plan.feedback } : {}),
        ...(plan.talk ? { talk: plan.talk } : {}),
        locks: plan.locks ?? [],
        previous: plan.layout.previous ?? null,
      });
      const t0 = Date.now();
      // (Reserved as `mayStart` let it go.)
      const concept = await step(prompt, st, (raw) => parseConcept(raw, bounds));
      o.onStep?.(st.key, 'layout', 'end');
      // (A step sent again after the page was away took the time away too: not timed.)
      if (!st.resent) o.onTimed?.('layout', Date.now() - t0);
      if (!concept) return ended('failed');
      design.concept = concept;
      say(`Layout and style done. ${usdText(spentSoFar())} so far.`);
      update();
    }

    // 2. The spaces, on the plan as the layout leaves it.
    const r0 = await place(ctx.base, ctx.before, { ...design, spaces: {} }, o.result);
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
    const r = await place(ctx.base, ctx.before, { ...design, spaces: others }, o.result);
    design.aliases = aliasesFor(r.level, design.aliases);
    const spaces = r.spaces.filter((s) => wanted.includes(s.key));
    // The room rows as they really are.
    const layoutRow = state.steps.filter((s) => s.kind === 'layout');
    state.steps = [...layoutRow, ...spaces.map((s) => blank(s.key, s.name, 'room'))];
    for (const s of spaces) design.spaces[s.key] = { name: s.name, status: 'skipped' };
    if (plan.layout) await save();
    update();

    const bounds = levelBounds(r.level);
    /** The hard checks a space's answer fails (that the plan didn't already), in the app's words. */
    /**
     * The hard checks one space's answer fails (that the plan didn't already), in the app's
     * words, and where it placed each piece: worked out on that space alone. Failures that
     * furnishing can't fix (a missing window, more people than bedrooms) aren't sent back.
     */
    const failing = async (s: (typeof spaces)[number], answer: SpaceDesign) => {
      const trial: DraftDesign = {
        ...design,
        spaces: { [s.key]: { name: s.name, status: 'done', design: answer } },
      };
      const res = await place(ctx.base, ctx.before, trial, o.result);
      const mine = res.checks.filter(
        (c) =>
          c.hard &&
          !c.already &&
          ((c.part && 'space' in c.part && c.part.space === s.key) ||
            (!!c.roomId && s.rooms.includes(c.roomId))),
      );
      return {
        fixable: mine
          .filter((c) => !c.unfixable)
          .map((c) => ({ ref: (c.itemId && res.refs[c.itemId]) || null, text: c.text })),
        placed: placedWords(res.level, s, res.refs, design.aliases, ctx.site?.north ?? 0),
      };
    };
    // A run-stopping error (a refused key, a quota): set before the first room's gate opens,
    // so no other room is sent after it.
    let runError: unknown = null;
    // The storage lens's block in each room step (what the space should hold), unless it's off.
    const storage = o.result && !lensOn(o.result, 'storage') ? false : o.result?.storage;
    const room = async (s: (typeof spaces)[number], onStart?: () => void) => {
      const st = state.steps.find((x) => x.key === s.key) as StepState;
      if (!(await mayStart({ key: s.key, kind: 'room' }))) {
        onStart?.();
        return;
      }
      const prompt = roomStep(ctx, s, r.level, design.aliases, {
        concept: design.concept,
        ...(o.result?.kept?.length ? { kept: o.result.kept } : {}),
        ...(storage !== undefined ? { storage } : {}),
        ...(plan.feedback ? { feedback: plan.feedback } : {}),
        ...(plan.talk ? { talk: plan.talk } : {}),
        locks: plan.locks ?? [],
        previous: plan.previous?.[s.key] ?? null,
      });
      try {
        const parse = (raw: unknown) => parseSpaceDesign(raw, bounds);
        const t0 = Date.now();
        const answer = await step(prompt, st, parse, onStart);
        o.onStep?.(st.key, 'room', 'end');
        if (!st.resent) o.onTimed?.('room', Date.now() - t0);
        if (answer) {
          const merge = (a: SpaceDesign) =>
            mergeAnswer(plan.previous?.[s.key], a, plan.keep?.[s.key] ?? [], o.result);
          let current = merge(answer);
          // Placed and checked: what fails goes back to the designer, at most twice.
          const first = await failing(s, current);
          let fixes = 0;
          let now = first;
          const rounds = fixRoundsFor(ctx.brief.quality);
          while (now.fixable.length && fixes < rounds && fixesLeft > 0) {
            // Taken from the run's few before any wait (rooms run side by side, and may all
            // wait on one pause), and given back if the step may not go.
            fixesLeft--;
            if (!(await mayStart({ key: s.key, kind: 'fix' }))) {
              fixesLeft++;
              break;
            }
            fixes++;
            const left = now.fixable;
            st.fixing = { round: fixes, problems: left.length };
            st.status = 'running';
            say(`${s.name}: checking… fixing ${plural(left.length, 'problem')}.`);
            update();
            const fix: FixRequest = { round: fixes, failures: left, placed: now.placed };
            const tf = Date.now();
            const again = await step(
              fixStepFor(
                ai,
                roomStep(ctx, s, r.level, design.aliases, {
                  concept: design.concept,
                  ...(o.result?.kept?.length ? { kept: o.result.kept } : {}),
                  ...(storage !== undefined ? { storage } : {}),
                  ...(plan.feedback ? { feedback: plan.feedback } : {}),
                  ...(plan.talk ? { talk: plan.talk } : {}),
                  locks: plan.locks ?? [],
                  previous: current,
                  fix,
                }),
              ),
              st,
              parse,
            );
            o.onStep?.(st.key, 'fix', 'end');
            if (!st.resent) o.onTimed?.('fix', Date.now() - tf);
            st.fixing = null;
            if (!again) {
              // The fix didn't come: the answer before it stands, checked as it is.
              st.status = 'done';
              st.error = null;
              break;
            }
            const next = await failing(s, merge(again));
            // Kept only if it fails less; no better twice running is a room that can't pass,
            // and the second round isn't spent on it.
            if (next.fixable.length < left.length) {
              current = merge(again);
              now = next;
            } else break;
          }
          design.spaces[s.key] = {
            name: s.name,
            status: 'done',
            design: current,
            ...(fixes
              ? { fixes, fixed: Math.max(0, first.fixable.length - now.fixable.length) }
              : {}),
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
    if (e instanceof Interrupted) {
      state.interrupt = e.reason;
      say(interruptText(e.reason));
      return ended('interrupted');
    }
    state.halt = {
      kind: 'network',
      message: e instanceof AiError ? e.message : 'Something went wrong.',
    };
    return ended('halted');
  }
}
