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
  type Level,
  type LookImage,
  type OptionLook,
  type ParseResult,
  type Price,
  type PromptImage,
  type RunPlan,
  type SpaceDesign,
  type StepPrompt,
  type Usage,
  actOnLook,
  aliasesFor,
  applyLookEdit,
  critiqueSketch,
  designResult,
  fixRoundsFor,
  keptAsWas,
  layoutStep,
  leftOutLines,
  lensOn,
  lensReports,
  levelBounds,
  lookFacts,
  lookNoWorse,
  lookStep,
  meteredPrice,
  parseConcept,
  parseLook,
  parseSpaceDesign,
  peopleWords,
  placedWords,
  resolveAsset,
  roomIdAt,
  roomStep,
  runReport,
  tokensOf,
  usageOf,
  usdOf,
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
 * Each room's answer is placed and checked as it arrives: hard checks it fails go back to the
 * designer (once a room on Quick, twice on Thorough, FIX_PER_RUN requests in a run at most,
 * with the app's own lines) before the version is shown.
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
  onStep?: (key: string, kind: StepKind, phase: 'start' | 'end') => void;
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

export async function runDesign(
  o: RunOptions,
): Promise<{ state: RunState; design: DraftDesign; look: OptionLook | null }> {
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
  const save = () => {
    const snapshot = structuredClone(design);
    const info = { fixesLeft: fixesLeft + held };
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
  const mayStart = async (next?: { key: string; kind: StepKind }): Promise<boolean> => {
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
    return { state, design, look };
  };

  // The storage lens's block in each room step (what the space should hold), unless it's off.
  const storage = o.result && !lensOn(o.result, 'storage') ? false : o.result?.storage;

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
    const reportOf = (spaces?: string[]) =>
      runReport(
        before,
        { spaces: design.spaces, brief: ctx.brief },
        { aliases: design.aliases, ...(spaces ? { spaces } : {}) },
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
            locks: plan.locks ?? [],
            previous: entry.design,
            fix,
          }),
        ),
        st,
        (raw) => parseSpaceDesign(raw, bounds),
      );
      o.onStep?.(st.key, 'fix', 'end');
      st.fixing = null;
      if (again) {
        entry.design = mergeAnswer(
          plan.previous?.[r.space],
          again,
          plan.keep?.[r.space] ?? [],
          o.result,
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
    const lookRow = state.steps.filter((s) => s.kind === 'look');
    state.steps = [...layoutRow, ...spaces.map((s) => blank(s.key, s.name, 'room')), ...lookRow];
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
    // A run-stopping error (a refused key, a quota): set before the first room's gate opens,
    // so no other room is sent after it.
    let runError: unknown = null;

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
      /** The room as checked so far (its answer in): what a Stop in its fix round keeps. */
      let checked: ((stopped: FixRound) => DraftDesign['spaces'][string]) | null = null;
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
          const most = fixRoundsFor(ctx.brief.quality);
          /** How each round went (and one not sent for want of fix-ups), for the card. */
          const rounds: FixRound[] = [];
          // Paid for and checked: kept if the run is stopped in a fix round, with that round said.
          checked = (stopped) => ({
            name: s.name,
            status: 'done',
            design: current,
            fixes,
            fixed: Math.max(0, first.fixable.length - now.fixable.length),
            rounds: [...rounds, stopped],
          });
          while (now.fixable.length && fixes < most) {
            if (fixesLeft <= 0) {
              const n = now.fixable.length;
              rounds.push({ outcome: 'no-fixups', before: n, after: n });
              break;
            }
            // Taken from the run's few before any wait (rooms run side by side, and may all
            // wait on one pause), and given back if the step may not go. Held, it is saved as
            // still left until the request goes.
            fixesLeft--;
            held++;
            const go = await mayStart({ key: s.key, kind: 'fix' });
            held--;
            if (!go) {
              fixesLeft++;
              break;
            }
            fixes++;
            const left = now.fixable;
            st.fixing = { round: fixes, problems: left.length };
            st.status = 'running';
            say(`${s.name}: checking… fixing ${plural(left.length, 'problem')}.`);
            update();
            const fix: FixRequest = {
              round: fixes,
              failures: left,
              placed: now.placed,
              leftOut: now.leftOut,
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
              // The fix didn't come: the answer before it stands, checked as it is, and the
              // card says why (cut off at the length limit, or no readable answer).
              rounds.push({
                outcome: st.failed ? NO_ANSWER[st.failed] : 'error',
                before: left.length,
                after: left.length,
              });
              st.status = 'done';
              st.error = null;
              break;
            }
            const next = await failing(s, merge(again));
            // Kept only if it fails less; no better twice running is a room that can't pass,
            // and the second round isn't spent on it.
            const out = { before: left.length, after: next.fixable.length };
            if (next.fixable.length < left.length) {
              rounds.push({ outcome: 'fixed', ...out });
              current = merge(again);
              now = next;
            } else {
              rounds.push({ outcome: 'no-better', ...out });
              break;
            }
          }
          design.spaces[s.key] = {
            name: s.name,
            status: 'done',
            design: current,
            ...(fixes
              ? { fixes, fixed: Math.max(0, first.fixable.length - now.fixable.length) }
              : {}),
            ...(rounds.length ? { rounds } : {}),
          };
          say(`${s.name} done. ${usdText(spentSoFar())} so far.`);
        } else {
          design.spaces[s.key] = { name: s.name, status: 'failed', error: st.error ?? '' };
        }
      } catch (e) {
        if (e instanceof Stopped) {
          const keep = checked as typeof checked;
          const n = st.fixing?.problems ?? 0;
          design.spaces[s.key] = keep
            ? keep({ outcome: 'stopped', before: n, after: n })
            : { name: s.name, status: 'cancelled' };
        }
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
