import {
  type Aspect,
  type ContextInput,
  type DesignInput,
  type DesignOptions,
  type DesignResult,
  type DraftDesign,
  FIX_PER_RUN,
  type FixRequest,
  type FixRound,
  type FreeOptions,
  type FreeOutcome,
  type Level,
  type LookImage,
  type OptionLook,
  type ParseResult,
  type Price,
  type PromptImage,
  type RoomFix,
  type RunPlan,
  type SpaceDesign,
  type StepPrompt,
  type Usage,
  actOnLook,
  aliasesFor,
  applyLookEdit,
  checkSig,
  critiqueSketch,
  designResult,
  firstPassOf,
  freeEssentials,
  freeName,
  furnitureKind,
  isAppRef,
  isDeclined,
  keptAsWas,
  layoutStep,
  leftOutLines,
  lensOn,
  lensReports,
  levelBounds,
  lookFacts,
  lookNoWorse,
  lookStep,
  madeWayLines,
  meteredPrice,
  orphanLines,
  parseConcept,
  parseLook,
  parseSpaceDesign,
  peopleWords,
  placedWords,
  resolveAsset,
  roleOf,
  roomIdAt,
  roomStep,
  runReport,
  stableJson,
  tokensOf,
  usageOf,
  usdOf,
  vetConcept,
} from '@dhd/core';
import { AiError } from './errors';
import type { Page } from './page';
import { type AiSettings, PROVIDERS } from './providers';
import {
  type FailReason,
  type Halt,
  Halted,
  type InterruptReason,
  Interrupted,
  Stopped,
  requestStep,
} from './request';
import { type StepSink, fixStepFor, lowerEffort, requestFor, streamStep } from './stream';

/** How a fix round that brought no answer ended, from why its request failed. */
const NO_ANSWER: Record<FailReason, FixRound['outcome']> = {
  length: 'cut-off',
  unreadable: 'failed',
  refused: 'refused',
  busy: 'error',
  network: 'error',
  limit: 'error',
};

/**
 * The designer's runner: the layout-and-style step for the whole flat, then one step per
 * space on the plan as the layout leaves it. The first room runs alone until its answer
 * starts (so the others read the prompt cache it wrote), then two more at a time, one at a
 * time after a rate limit. Each step is kept as it finishes; Stop aborts every request in
 * flight and keeps what's done. Every request's tokens are metered, a cut-off one estimated.
 * The layout is vetted as it arrives (`vetConcept`: a room where someone sleeps stays a
 * bedroom). Each room's answer gets the app's free fixes (a missing bed, seats, dining table or
 * desk, `freeEssentials`, no request), is placed and checked: hard checks it fails go back to
 * the designer, each answer again with its free fixes, before the version is shown. The fix
 * rounds draw on the run's pool (`fixesLeft`, priced as that many of the dearest fix request): a
 * room keeps going while each round makes progress (strictly fewer hard failures, none new), the
 * rooms taking the fix-ups in turn (a first pass each, then one at a time), and the second look's
 * round draws on what is left.
 */

export type StepStatus = 'waiting' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';

export interface StepState {
  /** 'layout', or the space's key. */
  key: string;
  label: string;
  kind: 'layout' | 'room' | 'look';
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
  /** Why its last request failed, when it did (`requestStep` says it). */
  failed?: FailReason;
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

/** The card's line when the provider refuses the second look's picture. */
export const PICTURE_REFUSED = 'The model couldn’t take the picture, so there’s no second look.';

/** The card's line when the model has no price: no figure, so no look. */
export const LOOK_UNPRICED =
  'This model has no price in the app, so there’s no second look. Add its price in AI settings.';

/**
 * Whether a failed request is the provider refusing a picture (a 400 about the image): by the
 * request's reason when it says one, else by its line.
 */
export const pictureRefused = (line: string, failed?: FailReason) =>
  (failed === 'refused' || /\(400\)/.test(line)) && /image|picture|modality/i.test(line);

/** A request a run sends: the layout, a room's answer, a fix round, the second look. */
export type StepKind = 'layout' | 'room' | 'fix' | 'look';

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
  onSave?: (
    design: DraftDesign,
    info: { fixesLeft: number; fixing: Record<string, RoomFix> },
  ) => void | Promise<void>;
  /**
   * Fix requests this run may send, its pool (a run carried on keeps what was left; Keep fixing
   * its own); FIX_PER_RUN when not given.
   */
  fixesLeft?: number;
  /**
   * Each room's place in the pool, as a checkpoint kept it (a run carried on): a room in its
   * rounds keeps its first pass's fix-ups left, and a settled one gets no more.
   */
  fixing?: Record<string, RoomFix>;
  /** How long a finished step took: the layout, a room's answer, a fix round (ms). */
  onTimed?: (kind: 'layout' | 'room' | 'fix', ms: number) => void;
  /** A step cut off while the page was out of view was sent again on its return. */
  onResent?: (st: StepState) => void;
  /**
   * A step's request goes ('start'), or came back with its answer ('end'): the layout, a
   * room's answer, a fix round (by the row's key). Not ended when the run stops or is
   * interrupted mid-step.
   */
  onStep?: (
    key: string,
    kind: StepKind,
    phase: 'start' | 'end',
    /** A fix round's start: the run's fix-ups left once it goes (its own taken). */
    info?: { fixesLeft: number },
  ) => void;
  /**
   * Keep fixing (B2): every round this run sends is marked `by: 'keep'` (asked and paid for after
   * the version was shown), so the card says it apart.
   */
  roundsBy?: 'keep';
  /**
   * The steps that were on their way when the page went (a run carried on: its checkpoint's
   * `inflight`): a room's fix round among them is recorded as gone (`away`), never sent again.
   */
  lost?: string[];
  onUsage?: (u: Usage) => void;
  /** Where a version is placed and checked (the designer's worker); else here, at once. */
  results?: (
    base: Level,
    before: Level,
    design: DesignInput,
    opts?: DesignOptions,
  ) => Promise<DesignResult>;
  /**
   * Where a space's free fixes are worked out (the designer's worker, as `results`); else here.
   * The missing essentials of a must-have check, added to the answer and kept only when
   * strictly better (core's `freeEssentials`). No request.
   */
  free?: (
    base: Level,
    before: Level,
    design: DesignInput,
    opts: DesignOptions | undefined,
    o: FreeOptions,
  ) => Promise<FreeOutcome>;
  /** Pieces the person left out before (room and role): the free fixes never add them again. */
  declined?: FreeOptions['declined'];
  /**
   * Whether the tab's limit (or the run's figure) has been reached, counting `next` (the step
   * about to be sent) at its most: before each step, and before any request is sent again.
   */
  overLimit?: (next?: { key: string; kind: StepKind }) => boolean;
  /** The limit was reached: true to finish the design, false to stop here. */
  confirmOver?: () => Promise<boolean>;
  /**
   * After "finish", go on only while `overLimit` says so, and ask again the next time it is
   * reached (a new figure set meanwhile); without it the rest of the run goes on past it.
   */
  askAgain?: boolean;
  /**
   * The second look (tech 3b §2): given, the run ends with one (Thorough, a model that can see;
   * the caller decides). The device turns the core's plan drawings into PNGs: null when it
   * can't (the look is skipped, nothing else fails). `scope`: the rooms the run was asked for
   * (a run carried on: its checkpoint's, as `plan` holds only the rooms left); the look is at
   * every finished space among them, whichever session designed it. Default: `plan.rooms`.
   */
  look?: {
    rasterise: (images: LookImage[]) => Promise<PromptImage[] | null>;
    scope?: RunPlan['rooms'];
    /**
     * Its findings, as soon as they are read (before its round): the caller keeps them with the
     * run's checkpoint, so a page that goes during the round still shows the look, and saves.
     */
    onAnswer?: (look: OptionLook) => void;
  };
}

/** The look's lines when it was stopped: before it went, while it was asked, or in its round. */
export const LOOK_STOPPED = {
  before: 'Not looked at: you stopped the run before the second look.',
  asked: 'Not looked at: you stopped the second look before it answered.',
  round: 'You stopped its round, so the rooms are as the first answers left them.',
  away: 'Its round didn’t finish, so the rooms are as the first answers left them.',
  limit: 'Not looked at: the second look would have gone past the limit.',
} as const;

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

/** A space a run designs: its key, name and rooms. */
type RunSpace = { key: string; name: string; rooms: string[] };

export async function runDesign(
  o: RunOptions,
): Promise<{ state: RunState; design: DraftDesign; look: OptionLook | null }> {
  const { ai, ctx, plan } = o;
  // Placed and checked in the designer's worker when there is one; here otherwise. Stop always
  // ends the run, even while a check is out (a worker that hangs or dies says nothing).
  const placeAny = o.results ?? ((b, f, d, opts) => Promise.resolve(designResult(b, f, d, opts)));
  const place: typeof placeAny = (b, f, d, opts) => untilStopped(placeAny(b, f, d, opts), o.signal);
  const freeAny =
    o.free ??
    ((b, f, d, opts, fo) => Promise.resolve().then(() => freeEssentials(b, f, d, opts, fo)));
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
  if (o.look) state.steps.push(blank('look', 'Second look', 'look'));
  /** The second look, once it has run (or why it didn't). */
  let look: OptionLook | null = null;
  /** Its findings once read, before its round (what a Stop or a halt in the round keeps). */
  let answered: OptionLook | null = null;

  const update = () =>
    o.onUpdate?.({ ...state, steps: state.steps.map((s) => ({ ...s })), usage: [...state.usage] });
  const say = (text: string) => {
    state.said = text;
  };
  const spentSoFar = () => state.usage.reduce((t, u) => t + (u.usd ?? 0), 0);
  let saving: Promise<void> = Promise.resolve();
  /** Fix requests the run may still send (the estimate counts this many at most). */
  let fixesLeft = o.fixesLeft ?? FIX_PER_RUN;
  /**
   * Fix-ups taken by rooms waiting at their gate (a pause), not yet sent: saved as still left,
   * so a run carried on after the page closed mid-pause still has them.
   */
  let held = 0;
  /** Each room's place in the pool (by space key): saved with the version. */
  const fixing: Record<string, RoomFix> = structuredClone(o.fixing ?? {});
  const save = () => {
    const snapshot = structuredClone(design);
    const info = { fixesLeft: fixesLeft + held, fixing: structuredClone(fixing) };
    saving = saving.then(() => o.onSave?.(snapshot, info)).catch(() => {});
    return saving;
  };
  /**
   * A fix round that was on its way when the page went (QA, B2): its fix-up was taken and it may
   * still be billed, so it isn't sent again; it is recorded as a round that went (`away`), so the
   * card counts it and says so. A room's round by its reservation (`o.lost`: the checkpoint's
   * steps in flight, a room answered and saved with no pending answer); the second look's by its
   * space's `look` mark.
   */
  {
    const by = o.roundsBy === 'keep' ? { by: 'keep' as const } : {};
    const away = (key: string, round: FixRound) => {
      const e = design.spaces[key];
      if (e?.status !== 'done' || !e.design) return;
      const n = e.rounds?.at(-1)?.after ?? 0;
      design.spaces[key] = {
        ...e,
        rounds: [...(e.rounds ?? []), { ...round, before: n, after: n }].slice(-12),
      };
    };
    for (const k of o.lost ?? []) {
      const rf = fixing[k];
      if (!rf || rf.settled || rf.pending) continue;
      away(k, { outcome: 'away', before: 0, after: 0, ...by });
    }
    for (const [k, rf] of Object.entries(fixing)) {
      if (!rf.look) continue;
      away(k, { outcome: 'away', before: 0, after: 0, by: 'look' });
      delete rf.look;
      // (Its space's fix count went up when its request went: `fixes` is the rounds sent.)
      const e = design.spaces[k];
      if (e) design.spaces[k] = { ...e, fixes: (e.fixes ?? 0) + 1 };
    }
  }

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
  const mayStart = async (next?: { key: string; kind: StepKind }): Promise<boolean> => {
    const reserve = () => {
      // A fix round goes with its fix-up already taken (held until now): the fix-ups left are
      // said with its reservation, so both are written at once (tech lead S2).
      if (next) {
        o.onStep?.(
          next.key,
          next.kind,
          'start',
          next.kind === 'fix' ? { fixesLeft: fixesLeft + held - 1 } : undefined,
        );
      }
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
    return { state, design, look };
  };

  // The storage lens's block in each room step (what the space should hold), unless it's off.
  const storage = o.result && !lensOn(o.result, 'storage') ? false : o.result?.storage;

  /**
   * An answer with the app's free fixes (the missing essentials of its must-have checks),
   * worked out on the space alone as `failing` checks it, and kept only when strictly better.
   * Never in a space whose furniture the person kept (Change something, a lock); the pieces the
   * answer carries over from the one it changes count as theirs, so "no worse" leaves out only
   * what this answer added. It fails open: a free pass that can't be worked out leaves the paid
   * answer as it is (only Stop ends the room).
   */
  const withFree = async (
    s: RunSpace,
    answer: SpaceDesign,
    /** The answer a fix round changed: a piece of it the new one dropped and the app puts back. */
    prior?: SpaceDesign,
    /** Also take out the answer's orphans (a room's own answers; not the second look's round). */
    orphans = true,
  ) => {
    if (furnitureHeld(s)) return answer;
    const trial: DraftDesign = {
      ...design,
      spaces: { [s.key]: { name: s.name, status: 'done', design: answer } },
    };
    // Theirs: only what the answer really carries over from the one it changes (the parts kept,
    // `mergeAnswer`), never a piece of the new answer that happens to share a ref with the old
    // (QA: after an Accept, a redesign's bedside "side2" made every free bed look worse).
    const keepAs = plan.keep?.[s.key] ?? [];
    const carried = (plan.previous?.[s.key]?.items ?? [])
      .filter((i) => keepAs.includes(aspectOfAnswer(i.assetId, o.result)))
      .map((i) => i.ref);
    const out = await untilStopped(
      freeAny(ctx.base, ctx.before, trial, o.result, {
        spaces: [s.key],
        ...(o.declined?.length ? { declined: o.declined } : {}),
        ...(carried.length ? { theirs: { [s.key]: carried } } : {}),
        ...(orphans ? { orphans: true } : {}),
      }),
      o.signal,
    ).catch((e: unknown) => {
      if (e instanceof Stopped) throw e;
      return null;
    });
    const placed =
      out?.added.length || out?.removed?.length ? out.spaces[s.key]?.design : undefined;
    if (!placed) return answer;
    // The orphans it took out are said with the answer, once it is the one used (`write`).
    const lines = [
      ...orphanLines(out?.removed ?? [], () => s.name),
      ...(out ? madeWayLines(out, () => s.name) : []),
    ];
    const said = (d: SpaceDesign) => {
      if (lines.length) took.set(d, lines);
      return d;
    };
    // A piece the fix round's answer dropped, put back by the app: its row says so.
    const had = new Set((prior?.items ?? []).map((i) => roleOf(furnitureKind(i.assetId))));
    const back = (out?.added ?? []).filter((a) => a.space === s.key && had.has(a.role));
    if (!back.length) return said(placed);
    const refs = new Set(back.map((a) => a.ref));
    return said({
      ...placed,
      items: placed.items.map((i) =>
        refs.has(i.ref) && isAppRef(i.ref)
          ? {
              ...i,
              // (What gave way for it, when something did, says so on its own piece.)
              why: `Put back by the app: the fix round’s answer left out the ${freeName(i.assetId)}.`,
            }
          : i,
      ),
    });
  };
  /** The app's lines about the orphans each answer had taken out, by the answer. */
  const took = new WeakMap<SpaceDesign, string[]>();
  /** The person kept this space's furniture: by the plan (Change something) or a lock. */
  const furnitureHeld = (s: RunSpace) =>
    !!plan.keep?.[s.key]?.includes('furniture') ||
    (plan.locks ?? []).some(
      (l) =>
        l.aspect === 'furniture' &&
        (l.space === '*' || l.space.split('+').some((id) => s.rooms.includes(id))),
    );
  const blankLook = (): OptionLook => ({
    state: 'done',
    summary: null,
    notes: [],
    findings: [],
    dropped: [],
    offers: [],
    round: 'none',
    line: null,
    at: new Date().toISOString(),
  });

  /**
   * The second look (its request reserved at the gate): `designed`, the finished spaces it may
   * change; `scope`, the rooms it is drawn and told about (null: the whole flat).
   */
  async function secondLook(
    st: StepState,
    designed: { key: string; rooms: string[]; name: string }[],
    scope: string[] | null,
  ): Promise<OptionLook> {
    const out = blankLook();
    // Its model's price, or no look (every paid request is metered; nothing goes unpriced).
    if (!meteredPrice(ai.model, ai.model, o.prices)) {
      o.onStep?.(st.key, 'look', 'end');
      st.status = 'skipped';
      return { ...out, state: 'skipped', line: LOOK_UNPRICED };
    }
    const before = await place(ctx.base, ctx.before, design, o.result);
    design.aliases = aliasesFor(before.level, design.aliases);
    /** The run's report on the version (its F and L lines), for these spaces or all of them. */
    // A must-have the person left out (a Decision) is theirs: never a failure the look is shown.
    const chosen = before.checks
      .filter(
        (c) => c.hard && !c.itemId && !!c.roomId && isDeclined(c.key, c.roomId, o.declined ?? []),
      )
      .map((c) => c.key);
    const reportOf = (spaces?: string[]) =>
      runReport(
        before,
        { spaces: design.spaces, brief: ctx.brief },
        {
          aliases: design.aliases,
          ...(spaces ? { spaces } : {}),
          ...(chosen.length ? { waived: chosen } : {}),
        },
      );
    const facts = lookFacts(before, ctx.base, {
      report: reportOf(scope ? designed.map((d) => d.key) : undefined),
      aliases: design.aliases,
      scope,
      brief: ctx.brief,
      lenses: lensReports(before, ctx.base, ctx.brief, o.result ?? {}),
      ...(o.result?.rules?.length ? { rules: o.result.rules } : {}),
      ...(o.result?.kept?.length ? { kept: o.result.kept } : {}),
      roomOf: (it) => roomIdAt(before.level, { x: it.position.x, y: it.position.z }),
    });
    const pictures = critiqueSketch(before, ctx.base, {
      aliases: design.aliases,
      scope,
      north: ctx.site?.north ?? null,
    });
    const images = await untilStopped(
      o.look?.rasterise(pictures) ?? Promise.resolve(null),
      o.signal,
    );
    if (!images?.length) {
      // Nothing sent: its reservation ends.
      o.onStep?.(st.key, 'look', 'end');
      st.status = 'skipped';
      return { ...out, state: 'skipped', line: 'The plan couldn’t be drawn for the second look.' };
    }
    const answer = await step(lookStep(ctx, facts, images), st, parseLook);
    o.onStep?.(st.key, 'look', 'end');
    if (!answer) {
      // The look ends there; the design stands. A picture the provider refused (a 400 about
      // the image) is no failure of the design's: skipped, in plain words, never sent again.
      const why = (st.error ?? '').replace(`${st.label}: `, '');
      if (pictureRefused(why, st.failed)) {
        st.status = 'skipped';
        st.error = null;
        return { ...out, state: 'skipped', line: PICTURE_REFUSED };
      }
      return { ...out, state: 'failed', line: `The second look didn’t work: ${why}`.slice(0, 300) };
    }
    out.summary = answer.summary;
    out.findings = answer.findings;
    const answers = Object.fromEntries(
      designed.flatMap((s) => {
        const d = design.spaces[s.key]?.design;
        return d ? [[s.key, d]] : [];
      }),
    );
    const acted = actOnLook(answer, {
      result: before,
      aliases: design.aliases,
      answers,
      ...(o.result?.models ? { models: o.result.models } : {}),
      ...(o.result?.kept?.length ? { kept: o.result.kept } : {}),
      ...(o.declined?.length ? { declined: o.declined } : {}),
    });
    out.notes = acted.notes;
    out.offers = acted.offers.map((x) => ({ rule: x.rule, line: x.line }));
    out.dropped = acted.dropped.map((d) => ({ line: d.finding.line, why: d.why }));
    // Read and paid for: kept now, with the run's usage (a page that goes in its round has it,
    // and says its round never finished).
    answered = { ...out };
    const rounds = acted.edits.length > 0 || acted.rounds.length > 0;
    o.look?.onAnswer?.(
      rounds ? { ...out, notes: [...out.notes, LOOK_STOPPED.away].slice(0, 12) } : answered,
    );
    void save();
    if (!rounds) return out;

    // The round: the edits made, and each space's request sent (while the run's few last).
    const next: DraftDesign = structuredClone(design);
    let changed = false;
    acted.edits.forEach((e, n) => {
      const entry = next.spaces[e.space];
      if (!entry?.design) return;
      entry.design = applyLookEdit(entry.design, e, n + 1);
      changed = true;
    });
    const bounds = levelBounds(before.level);
    /**
     * Each space's round, for its record (a fix round of the app's checks, as a room's are; a
     * round only of taste suggestions is the look's own, said on its card section). Those that
     * came back are settled once the round is kept or not.
     */
    const records: { space: string; round: FixRound | null; checks: number; keys: string[] }[] = [];
    for (const r of acted.rounds) {
      const s = designed.find((x) => x.key === r.space);
      const entry = next.spaces[r.space];
      const space = before.spaces.find((x) => x.key === r.space);
      if (!s || !entry?.design || !space) continue;
      if (fixesLeft <= 0) {
        // Each space it would have sent says so (none goes once the fix-ups are spent).
        records.push({
          space: r.space,
          round: { outcome: 'no-fixups', before: r.checks, after: r.checks, by: 'look' },
          checks: r.checks,
          keys: r.keys,
        });
        continue;
      }
      // The pool's rule: taken before any wait, given back if the step may not go (held, it is
      // saved as still left until the request goes).
      fixesLeft--;
      held++;
      const go = await mayStart({ key: st.key, kind: 'fix' });
      held--;
      if (!go) {
        fixesLeft++;
        break;
      }
      // On its way for this space: a page that goes before it is back records it as gone (QA).
      fixing[r.space] = { ...(fixing[r.space] ?? { left: 0, settled: true }), look: true };
      void save();
      st.fixing = { round: 1, problems: r.failures.length };
      st.status = 'running';
      say(`Second look: sending ${s.name} back once.`);
      update();
      const fix: FixRequest = {
        round: (entry.fixes ?? 0) + 1,
        failures: r.failures,
        placed: placedWords(before.level, space, before.refs, design.aliases, ctx.site?.north ?? 0),
        leftOut: leftOutLines(reportOf([r.space])),
      };
      const again = await step(
        fixStepFor(
          ai,
          roomStep(ctx, space, before.level, design.aliases, {
            concept: design.concept,
            ...(o.result?.kept?.length ? { kept: o.result.kept } : {}),
            ...(storage !== undefined ? { storage } : {}),
            ...(plan.feedback ? { feedback: plan.feedback } : {}),
            ...(plan.talk ? { talk: plan.talk } : {}),
            ...(o.declined?.length ? { declined: o.declined } : {}),
            locks: plan.locks ?? [],
            previous: entry.design,
            fix,
          }),
        ),
        st,
        (raw) => parseSpaceDesign(raw, bounds),
      );
      o.onStep?.(st.key, 'fix', 'end');
      // Back (with an answer or not): no longer on its way.
      const marked = fixing[r.space];
      if (marked) delete marked.look;
      st.fixing = null;
      if (again) {
        // With the app's free fixes, as a room's fix round has them: a bed the answer dropped
        // is put back (and said so), and the round is judged with it (`lookNoWorse`, `record`).
        const prior = entry.design;
        entry.design = await withFree(
          s,
          mergeAnswer(plan.previous?.[r.space], again, plan.keep?.[r.space] ?? [], o.result),
          prior,
          false,
        );
        changed = true;
        records.push({ space: r.space, round: null, checks: r.checks, keys: r.keys });
      } else {
        // No answer: what was there stands, and its record says why.
        const outcome = st.failed ? NO_ANSWER[st.failed] : 'error';
        records.push({
          space: r.space,
          round: { outcome, before: r.checks, after: r.checks, by: 'look' },
          checks: r.checks,
          keys: r.keys,
        });
        st.error = null;
      }
    }
    st.status = 'done';
    /**
     * Writes each check round's record on the space as it stands now (`after`: the result it
     * was judged on, when it was used: its checks still failing are counted from it).
     */
    const record = (after: DesignResult | null) => {
      const failing = after
        ? new Set(after.checks.filter((c) => c.hard && !c.already).map((c) => c.key))
        : null;
      for (const x of records) {
        if (!x.checks) continue;
        const entry = design.spaces[x.space];
        if (!entry || entry.status !== 'done') continue;
        const left = failing ? x.keys.filter((k) => failing.has(k)).length : x.checks;
        const round: FixRound = x.round ?? {
          // Fixed only if its own checks went down (used or not, otherwise no better).
          outcome: failing && left < x.checks ? 'fixed' : 'no-better',
          before: x.checks,
          after: left,
          by: 'look',
        };
        const sent = round.outcome !== 'no-fixups';
        design.spaces[x.space] = {
          ...entry,
          ...(sent ? { fixes: (entry.fixes ?? 0) + 1 } : {}),
          ...(round.outcome === 'fixed'
            ? { fixed: (entry.fixed ?? 0) + round.before - round.after }
            : {}),
          rounds: [...(entry.rounds ?? []), round].slice(-12),
        };
      }
    };
    /**
     * What a refused round was for, as the card's lead says it: its checks by the run report's
     * lines (people of one room together), its taste suggestions as they were.
     */
    const refusedLines = (a: typeof acted): string[] => {
      const rep = reportOf(designed.map((d) => d.key));
      const texts = new Set(before.checks.map((c) => c.text));
      const said = new Set<string>();
      for (const k of a.targets) {
        const f = rep.failures.find((x) => x.keys.includes(k));
        const c = before.checks.find((x) => x.key === k);
        if (f) said.add(f.says);
        else if (c) said.add(peopleWords(c.text, ctx.brief));
      }
      for (const l of a.acted) if (!texts.has(l)) said.add(l);
      return [...said].map(keptAsWas);
    };
    if (!changed) {
      record(null);
      return out;
    }
    const after = await place(ctx.base, ctx.before, next, o.result);
    // Used as a room's fix round is: fewer hard failures, never a kept piece or rule broken.
    if (lookNoWorse(before, after, acted.targets)) {
      design.spaces = next.spaces;
      record(after);
      return { ...out, round: 'kept' };
    }
    record(null);
    return {
      ...out,
      round: 'refused',
      // Once a failure, in the lead's words ("You and Partner have no bed in Main bedroom").
      notes: [...out.notes, ...refusedLines(acted)].slice(0, 12),
    };
  }

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
      // Vetted before any room is sent (free): a room where someone sleeps stays a bedroom, and a
      // wall whose removal joins it to a living room stays. The concept is stored as vetted.
      const vetted = vetConcept(
        concept,
        ctx.base,
        ctx.before,
        design.brief,
        design.aliases,
        design.id,
      );
      design.concept = vetted.concept;
      if (vetted.lines.length) design.appLines = vetted.lines;
      else delete design.appLines;
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
    const lookRow = state.steps.filter((s) => s.kind === 'look');
    state.steps = [...layoutRow, ...spaces.map((s) => blank(s.key, s.name, 'room')), ...lookRow];
    for (const s of spaces) {
      // A room only sent back to be fixed keeps its answer (and its rounds) as stored.
      const kept = design.spaces[s.key];
      if (plan.fixOnly?.includes(s.key) && kept?.status === 'done' && kept.design) continue;
      design.spaces[s.key] = { name: s.name, status: 'skipped' };
    }
    if (plan.layout) await save();
    update();

    const bounds = levelBounds(r.level);
    /** A must-have check of a room where the person left that piece out (`o.declined`). */
    const declinedCheck = (c: { key: string; roomId?: string; itemId?: string }) =>
      !c.itemId && !!c.roomId && isDeclined(c.key, c.roomId, o.declined ?? []);
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
          // A must-have the person left out (a Decision: no bed here) is theirs to have: never
          // sent back to be fixed, never a fix-up spent on it.
          .filter((c) => !c.unfixable && !declinedCheck(c))
          .map((c) => ({ ref: (c.itemId && res.refs[c.itemId]) || null, text: c.text })),
        // Every hard failure's signature (principle|code|room|role): a round that brings in one
        // not there before is no progress, whatever it fixed.
        sigs: new Set(mine.filter((c) => !declinedCheck(c)).map((c) => checkSig(res, c))),
        placed: placedWords(res.level, s, res.refs, design.aliases, ctx.site?.north ?? 0),
        // The pieces it left out, with why and a hint: so a bed dropped for a keep ref the
        // plan doesn't have is said as that, not only as "has no bed".
        leftOut: leftOutLines(
          runReport(
            res,
            { spaces: trial.spaces, brief: ctx.brief },
            { aliases: design.aliases, spaces: [s.key] },
          ),
        ),
      };
    };
    type Failing = Awaited<ReturnType<typeof failing>>;
    // A run-stopping error (a refused key, a quota): set before the first room's gate opens,
    // so no other room is sent after it.
    let runError: unknown = null;

    /**
     * The fix-up pool by progress (spec §3, lead decisions B2). Each room's place in it (carried
     * on: the checkpoint's): in its first pass a room may take `quota`; once every room has had
     * its pass, what is left goes one fix-up at a time to the rooms still making progress, in
     * room order. A room settles when it passes, a round makes no progress (that answer isn't
     * used), no answer comes, or the pool is used up (said as `no-fixups`).
     */
    const quota = firstPassOf(fixesLeft, spaces.length);
    /** A room in its fix rounds: its checked answer and what it fails, and its record so far. */
    interface Fixing {
      s: (typeof spaces)[number];
      st: StepState;
      current: SpaceDesign;
      now: Failing;
      fixes: number;
      fixed: number;
      rounds: FixRound[];
    }
    const open = new Map<string, Fixing>();
    /** Keep fixing's rounds are marked so (asked and paid for after the version was shown). */
    const by = o.roundsBy === 'keep' ? { by: 'keep' as const } : {};
    /**
     * The first pass in room order (tech lead N1): a room takes a first-pass fix-up only from what
     * the rooms before it in order haven't claimed yet (their first-pass fix-ups left, until their
     * pass is over); what it can't take now it may get once every room has had its pass.
     */
    const order = spaces.map((s) => s.key);
    const passed = new Set<string>();
    const claimedBefore = (key: string) =>
      order
        .slice(0, Math.max(0, order.indexOf(key)))
        .filter((k) => !passed.has(k) && !fixing[k]?.settled)
        .reduce((t, k) => t + (fixing[k]?.left ?? quota), 0);
    // The app's lines about the version: the layout's vetting, then the orphans each room's
    // answer in use had taken out.
    const vetLines = [...(design.appLines ?? [])];
    const tookOut = new Map<string, string[]>();
    const placeOf = (key: string): RoomFix => {
      fixing[key] ??= { left: quota, settled: false };
      return fixing[key];
    };
    /** The room as checked so far, into the version (saved with the next `save`). */
    const write = (f: Fixing, last?: FixRound) => {
      const rounds = last ? [...f.rounds, last] : f.rounds;
      design.spaces[f.s.key] = {
        name: f.s.name,
        status: 'done',
        design: f.current,
        ...(f.fixes ? { fixes: f.fixes, fixed: f.fixed } : {}),
        ...(rounds.length ? { rounds: rounds.slice(-12) } : {}),
      };
      tookOut.set(f.s.key, took.get(f.current) ?? []);
      const lines = [...new Set([...vetLines, ...[...tookOut.values()].flat()])].slice(0, 8);
      if (lines.length) design.appLines = lines;
      else delete design.appLines;
    };
    /** The same answer as before, after the merge and the free pass: the room has stalled. */
    const sameAnswer = (a: SpaceDesign, b: SpaceDesign) => stableJson(a) === stableJson(b);
    const merge = (s: RunSpace, a: SpaceDesign) =>
      mergeAnswer(plan.previous?.[s.key], a, plan.keep?.[s.key] ?? [], o.result);
    /**
     * Judges a fix round's answer (merged, as it came): with the free pass, kept only if it makes
     * progress (strictly fewer hard failures, none new; the same answer again has stalled). True
     * when it did and the room still fails. A run carried on judges a pending one from here.
     */
    const judge = async (f: Fixing, merged: SpaceDesign): Promise<boolean> => {
      const { s, st } = f;
      const rf = placeOf(s.key);
      const left = f.now.fixable;
      const settle = (round: FixRound) => {
        f.rounds.push(round);
        rf.settled = true;
        delete rf.pending;
        st.status = 'done';
        write(f);
        void save();
        return false;
      };
      const fixedAnswer = await withFree(s, merged, f.current);
      // The same answer again: stalled, and not placed again to find out.
      if (sameAnswer(fixedAnswer, f.current)) {
        return settle({ outcome: 'no-better', before: left.length, after: left.length, ...by });
      }
      const next = await failing(s, fixedAnswer);
      // Progress: strictly fewer hard failures, and none that wasn't there before.
      const progress =
        next.fixable.length < left.length && [...next.sigs].every((x) => f.now.sigs.has(x));
      const out = { before: left.length, after: next.fixable.length, ...by };
      if (!progress) return settle({ outcome: 'no-better', ...out });
      f.rounds.push({ outcome: 'fixed', ...out });
      f.fixed += left.length - next.fixable.length;
      f.current = fixedAnswer;
      f.now = next;
      delete rf.pending;
      if (!next.fixable.length) rf.settled = true;
      st.status = 'done';
      write(f);
      void save();
      return !rf.settled;
    };
    /**
     * One fix round for a room, from the pool: true when it made progress and still fails (it
     * may have another). The fix-up is taken before any wait and given back if the step may not
     * go (held meanwhile, so saved as still left); once taken it is gone, written with the
     * round's reservation (`onStep`'s `fixesLeft`) and saved.
     */
    const fixOnce = async (f: Fixing): Promise<boolean> => {
      const { s, st } = f;
      const rf = placeOf(s.key);
      const left = f.now.fixable;
      if (!left.length || rf.settled) {
        rf.settled = true;
        return false;
      }
      if (fixesLeft <= 0) {
        f.rounds.push({ outcome: 'no-fixups', before: left.length, after: left.length, ...by });
        rf.settled = true;
        write(f);
        void save();
        return false;
      }
      fixesLeft--;
      held++;
      const go = await mayStart({ key: s.key, kind: 'fix' });
      held--;
      if (!go) {
        // Stopped, or a no at the limit: the run ends; the room isn't settled (a page that goes
        // now carries it on with the fix-up given back).
        fixesLeft++;
        return false;
      }
      if (rf.left > 0) rf.left--;
      f.fixes++;
      // The fix-up is gone once its request goes: written now (the round counted on the room),
      // never counted twice on carrying on.
      write(f);
      void save();
      st.fixing = { round: f.fixes, problems: left.length };
      st.status = 'running';
      say(`${s.name}: checking… fixing ${plural(left.length, 'problem')}.`);
      update();
      const fix: FixRequest = {
        round: f.fixes,
        failures: left,
        placed: f.now.placed,
        leftOut: f.now.leftOut,
      };
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
            ...(o.declined?.length ? { declined: o.declined } : {}),
            locks: plan.locks ?? [],
            previous: f.current,
            fix,
          }),
        ),
        st,
        (raw) => parseSpaceDesign(raw, bounds),
      );
      o.onStep?.(st.key, 'fix', 'end');
      if (!st.resent) o.onTimed?.('fix', Date.now() - tf);
      st.fixing = null;
      if (!again) {
        // The fix didn't come: the answer before it stands, checked as it is, and the card says
        // why (cut off at the length limit, or no readable answer).
        st.error = null;
        f.rounds.push({
          outcome: st.failed ? NO_ANSWER[st.failed] : 'error',
          before: left.length,
          after: left.length,
          ...by,
        });
        rf.settled = true;
        st.status = 'done';
        write(f);
        void save();
        return false;
      }
      // Paid for: kept as it came (merged) before the free pass and the checks, so a page that
      // goes while they run judges it on carrying on, never sending it again (tech lead S1).
      const merged = merge(s, again);
      rf.pending = merged;
      void save();
      return judge(f, merged);
    };
    /** A Stop in a room's fix round: its checked answer is kept, with that round said. */
    const stoppedIn = (f: Fixing) => {
      const n = f.st.fixing?.problems ?? 0;
      write(f, { outcome: 'stopped', before: n, after: n, ...by });
      placeOf(f.s.key).settled = true;
    };

    const room = async (s: (typeof spaces)[number], onStart?: () => void) => {
      const st = state.steps.find((x) => x.key === s.key) as StepState;
      const stored = design.spaces[s.key];
      // Its answer stands (carried on in its rounds, or Keep fixing): only its fix rounds go.
      const fixOnly =
        !!plan.fixOnly?.includes(s.key) && stored?.status === 'done' && !!stored.design;
      // One asked only for its fix rounds with no answer to fix: nothing is sent (its room step
      // was never priced).
      if (plan.fixOnly?.includes(s.key) && !fixOnly) {
        onStart?.();
        return;
      }
      if (!fixOnly && !(await mayStart({ key: s.key, kind: 'room' }))) {
        onStart?.();
        return;
      }
      const prompt = roomStep(ctx, s, r.level, design.aliases, {
        concept: design.concept,
        ...(o.result?.kept?.length ? { kept: o.result.kept } : {}),
        ...(storage !== undefined ? { storage } : {}),
        ...(plan.feedback ? { feedback: plan.feedback } : {}),
        ...(plan.talk ? { talk: plan.talk } : {}),
        ...(o.declined?.length ? { declined: o.declined } : {}),
        locks: plan.locks ?? [],
        previous: plan.previous?.[s.key] ?? null,
      });
      try {
        let f: Fixing;
        if (fixOnly && stored?.design) {
          onStart?.();
          st.status = 'done';
          // A round "not sent: the fix-ups were used up" is what this run now answers.
          const rounds = [...(stored.rounds ?? [])];
          if (rounds.at(-1)?.outcome === 'no-fixups') rounds.pop();
          // Its free pass again (it does nothing a second time): an answer saved as it came,
          // before the page went, gets it now.
          const current = await withFree(s, stored.design);
          f = {
            s,
            st,
            current,
            now: await failing(s, current),
            fixes: stored.fixes ?? 0,
            fixed: stored.fixed ?? 0,
            rounds,
          };
        } else {
          const parse = (raw: unknown) => parseSpaceDesign(raw, bounds);
          const t0 = Date.now();
          const answer = await step(prompt, st, parse, onStart);
          o.onStep?.(st.key, 'room', 'end');
          if (!st.resent) o.onTimed?.('room', Date.now() - t0);
          if (!answer) {
            design.spaces[s.key] = { name: s.name, status: 'failed', error: st.error ?? '' };
            return;
          }
          // Paid for: saved as it came (merged), done, with its place in the pool, before the
          // free pass and the checks run (tech lead S1). A page that goes now carries it on with
          // those, never with its room step again.
          const merged = merge(s, answer);
          design.spaces[s.key] = { name: s.name, status: 'done', design: merged };
          placeOf(s.key);
          void save();
          const current = await withFree(s, merged);
          f = { s, st, current, now: await failing(s, current), fixes: 0, fixed: 0, rounds: [] };
        }
        open.set(s.key, f);
        const rf = placeOf(s.key);
        if (!f.now.fixable.length) rf.settled = true;
        // Placed and checked, and saved as done: a page that goes in its rounds carries on with
        // them, never with its room step again.
        write(f);
        void save();
        // A fix round's answer that came back before the page went: judged now, not sent again.
        if (rf.pending && !rf.settled && !(await judge(f, rf.pending))) rf.left = 0;
        // Its first pass: what it fails goes back to the designer while each round makes
        // progress, from what the rooms before it in order haven't claimed.
        while (
          rf.left > 0 &&
          !rf.settled &&
          fixesLeft - claimedBefore(s.key) > 0 &&
          (await fixOnce(f))
        ) {}
        say(`${s.name} done. ${usdText(spentSoFar())} so far.`);
      } catch (e) {
        if (e instanceof Stopped) {
          const f = open.get(s.key);
          if (f) stoppedIn(f);
          else design.spaces[s.key] = { name: s.name, status: 'cancelled' };
        }
        runError ??= e;
      } finally {
        passed.add(s.key);
        onStart?.();
        update();
        void save();
      }
    };

    /** Runs `jobs` at most `cap` at a time (one at a time after a rate limit), in order. */
    const pumped = (jobs: (() => Promise<void>)[]) =>
      new Promise<void>((resolve) => {
        const queue = [...jobs];
        let running = 0;
        const pump = () => {
          while (queue.length && running < cap && !runError && !stopping && !o.signal.aborted) {
            const job = queue.shift() as () => Promise<void>;
            running++;
            job().finally(() => {
              running--;
              pump();
            });
          }
          if (running === 0) resolve();
        };
        pump();
      });

    const [first, ...rest] = spaces;
    if (first) {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const firstDone = room(first, release);
      await gate;
      await pumped(rest.map((s) => () => room(s)));
      await firstDone;
      if (runError) throw runError;
    }

    // Every room has had its first pass: what the pool has left goes one fix-up at a time to
    // each room still making progress, in room order, until it is used up or none progresses.
    for (;;) {
      if (runError || stopping || o.signal.aborted) break;
      const turn = spaces.flatMap((s) => {
        const f = open.get(s.key);
        return f && !placeOf(s.key).settled && f.now.fixable.length ? [f] : [];
      });
      if (!turn.length) break;
      await pumped(
        turn.map((f) => async () => {
          try {
            await fixOnce(f);
          } catch (e) {
            if (e instanceof Stopped) stoppedIn(f);
            runError ??= e;
          } finally {
            update();
            void save();
          }
        }),
      );
      if (runError) throw runError;
    }

    // 3. The second look: the proposal drawn as a plan, looked at once, what the app's checks
    // agree with acted on in one round (counted in the run's fix requests), kept if no worse.
    // It looks at every finished space the run was asked for (a run carried on: those of the
    // sessions before too), drawn as asked: the whole flat, or those rooms.
    const lookSt = state.steps.find((x) => x.kind === 'look');
    const asked = o.look?.scope ?? plan.rooms;
    const inLook = r.spaces.filter((s) => asked === 'all' || asked.includes(s.key));
    const designedHere = inLook.filter((s) => design.spaces[s.key]?.status === 'done');
    /** Everything but the look was done when it came: a Stop or a no now ends the run done. */
    let lookOnly = false;
    if (o.look && lookSt && !stopping && !o.signal.aborted) {
      lookOnly = true;
      if (!designedHere.length) lookSt.status = 'skipped';
      else if (!(await mayStart({ key: lookSt.key, kind: 'look' }))) {
        // Not sent: the limit was reached and the person said no, or stopped while it asked.
        lookSt.status = 'skipped';
        const line = o.signal.aborted ? LOOK_STOPPED.before : LOOK_STOPPED.limit;
        look = { ...blankLook(), state: 'skipped', line };
      } else {
        try {
          const scope = asked === 'all' ? null : inLook.flatMap((s) => s.rooms);
          look = await secondLook(lookSt, designedHere, scope);
        } catch (e) {
          // A refused key or a spent quota during the look: the look failed, with its line; the
          // rooms are done and checked, so the design stands.
          // In its round, what it found stands (its round's answer is what's lost).
          const got = answered as OptionLook | null;
          if (e instanceof Halted) {
            look = got
              ? { ...got, notes: [...got.notes, e.halt.message.slice(0, 300)].slice(0, 12) }
              : { ...blankLook(), state: 'failed', line: e.halt.message.slice(0, 300) };
            lookSt.status = 'failed';
            lookSt.error = e.halt.message;
          } else {
            look = got
              ? { ...got, notes: [...got.notes, LOOK_STOPPED.round].slice(0, 12) }
              : { ...blankLook(), state: 'stopped', line: LOOK_STOPPED.asked };
            if (!(e instanceof Stopped)) throw e;
          }
        } finally {
          update();
          void save();
        }
      }
    }
    if (lookSt?.status === 'waiting') lookSt.status = 'skipped';
    if ((stopping || o.signal.aborted) && !lookOnly) {
      if (o.look && !look) look = { ...blankLook(), state: 'skipped', line: LOOK_STOPPED.before };
      say('Stopped. Finished steps are kept.');
      return ended('stopped');
    }
    // (The look is no step designed: one stopped or skipped leaves the design done.)
    const rows = state.steps.filter((s) => s.kind !== 'look');
    const done = rows.filter((s) => s.status === 'done').length;
    const total = spentSoFar();
    say(
      done === rows.length
        ? `Design done. ${usdText(total)} in all.`
        : `Design done, with ${rows.length - done} ${rows.length - done === 1 ? 'step' : 'steps'} not designed. ${usdText(total)} in all.`,
    );
    return ended('done');
  } catch (e) {
    if (e instanceof Stopped || o.signal.aborted) {
      // Stopped before the look came (in a room or its fix round): the card says so.
      if (o.look && !look) look = { ...blankLook(), state: 'skipped', line: LOOK_STOPPED.before };
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
