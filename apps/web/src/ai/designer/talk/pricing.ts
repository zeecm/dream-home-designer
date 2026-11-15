import {
  type Design,
  type DesignBrief,
  type DesignOptions,
  type DraftDesign,
  NO_LOOK,
  type OptionLook,
  type Price,
  type Project,
  type ProposalOption,
  type RunCheckpoint,
  type RunEstimate,
  type RunPlan,
  type ScopePlan,
  type ScopeRef,
  type TalkAsk,
  canSee,
  contextFor,
  estimateRun,
  fixPoolFor,
  lookBase,
  lookPictureSizes,
  looksAt,
  planScope,
  plannedPrompts,
} from '@dhd/core';

/**
 * What a priced press would ask for, and what it would cost: worked out from plain data, with
 * no store, so the designer's worker can do it off the main thread (and tests without one).
 */

export interface PriceInput {
  project: Project;
  /** The level designed (the conversation's). */
  levelId: string;
  designs: Design[];
  brief: DesignBrief;
  scope: ScopeRef;
  words: string;
  talk?: TalkAsk;
  /** A stopped option's missing rooms, into that option. */
  finish?: { option: ProposalOption; rooms: string[]; words: string; scope: ScopeRef };
  /** An interrupted run carried on: from its checkpoint, into the same option. */
  resume?: { option: ProposalOption; run: RunCheckpoint; scope: ScopeRef };
  /**
   * Keep fixing (B2): a fix-only run on an option whose fix-ups ran out with failures left, into
   * the same option: its stored answers stand, only fix rounds go (`fixRoomsOf`).
   */
  keepFixing?: { option: ProposalOption; words: string; scope: ScopeRef };
  designId: string;
  opts: DesignOptions;
  ai: { provider: 'anthropic' | 'openai' | 'gemini'; model: string };
  prices: Record<string, Price>;
  /** Pieces the person left out of a room (Decisions): the room steps are told, as the run is. */
  declined?: { room: string; role: string }[];
}

export type Priced = { sp: ScopePlan; est: RunEstimate } | null;

/** The plan for the rooms a stopped option lacks, into the same option. */
function finishPlan(
  i: PriceInput & { finish: NonNullable<PriceInput['finish']> },
): ScopePlan | null {
  const o = i.finish.option;
  const ctx = contextFor(i.project, o.brief, i.levelId, o.aliases);
  if (!ctx) return null;
  const plan: RunPlan = {
    layout: null,
    rooms: i.finish.rooms,
    ...(i.finish.words.trim() ? { feedback: i.finish.words.trim() } : {}),
    locks: structuredClone(o.locks),
  };
  const draft: DraftDesign = structuredClone({
    id: o.designId,
    brief: o.brief,
    aliases: o.aliases,
    concept: o.concept,
    spaces: o.spaces,
    usage: o.usage,
    request: { locks: o.locks },
  });
  return {
    scope: i.finish.scope,
    brief: o.brief,
    plan,
    draft,
    ctx,
    locks: structuredClone(o.locks),
  };
}

/**
 * The rooms Keep fixing would send back (B2): those whose last round says the run's fix-ups were
 * used up while they still failed. A round that made no progress never offers it (paying again
 * would likely give the same answer).
 */
export function fixRoomsOf(o: Pick<ProposalOption, 'spaces'>): string[] {
  return Object.entries(o.spaces)
    .filter(
      ([, s]) => s.status === 'done' && !!s.design && s.rounds?.at(-1)?.outcome === 'no-fixups',
    )
    .map(([k]) => k);
}

/** The plan Keep fixing runs: the rooms whose fix-ups ran out, fix rounds only, same option. */
function keepFixingPlan(
  i: PriceInput & { keepFixing: NonNullable<PriceInput['keepFixing']> },
): ScopePlan | null {
  const o = i.keepFixing.option;
  const ctx = contextFor(i.project, o.brief, i.levelId, o.aliases);
  const rooms = fixRoomsOf(o);
  if (!ctx || !rooms.length) return null;
  const plan: RunPlan = {
    layout: null,
    rooms,
    fixOnly: rooms,
    ...(i.keepFixing.words.trim() ? { feedback: i.keepFixing.words.trim() } : {}),
    locks: structuredClone(o.locks),
  };
  const draft: DraftDesign = structuredClone({
    id: o.designId,
    brief: o.brief,
    aliases: o.aliases,
    concept: o.concept,
    spaces: o.spaces,
    usage: o.usage,
    request: { locks: o.locks },
  });
  return {
    scope: i.keepFixing.scope,
    brief: o.brief,
    plan,
    draft,
    ctx,
    locks: structuredClone(o.locks),
  };
}

/**
 * The rooms an interrupted run left in their fix rounds: answered and saved, not settled in the
 * pool. Carried on, they send only their next round (never their room step or a round they had).
 */
export function roomsFixing(o: ProposalOption, run: RunCheckpoint): string[] {
  const answered = (k: string) => o.spaces[k]?.status === 'done' && !!o.spaces[k]?.design;
  // Keep fixing's rooms still queued (no place in the pool yet) go on too (tech lead S3).
  const queued = (run.plan.fixOnly ?? []).filter((k) => !run.fixing[k] && answered(k));
  const open = Object.entries(run.fixing)
    .filter(([k, f]) => !f.settled && answered(k))
    .map(([k]) => k);
  return [...new Set([...open, ...queued])];
}

/** A room an interrupted run finished (done, or failed after its answer): never sent again. */
export const finishedSpace = (s: ProposalOption['spaces'][string] | undefined) =>
  !!s && (s.status === 'done' || s.status === 'failed' || s.status === 'copied');

/** The rooms an interrupted run has still to design (null: the layout comes first). */
export function roomsLeft(o: ProposalOption, run: RunCheckpoint): string[] | null {
  if (run.layout === 'left' || run.rooms === null) return null;
  return run.rooms.filter((k) => !finishedSpace(o.spaces[k]));
}

/**
 * The plan that carries an interrupted run on: what it was asked, less what it finished. The
 * layout, if it never finished, is asked for again whole (rooms start after it).
 */
function resumePlan(
  i: PriceInput & { resume: NonNullable<PriceInput['resume']> },
): ScopePlan | null {
  const { option: o, run } = i.resume;
  const ctx = contextFor(i.project, o.brief, i.levelId, o.aliases);
  if (!ctx) return null;
  const left = roomsLeft(o, run);
  const asked = structuredClone(run.plan) as RunPlan;
  // Rooms still in their fix rounds go on with them alone (in room order, as the run had them).
  const fixing = left === null ? [] : roomsFixing(o, run);
  const rooms =
    left === null ? [] : (run.rooms ?? []).filter((k) => left.includes(k) || fixing.includes(k));
  const plan: RunPlan =
    left === null
      ? asked
      : {
          ...asked,
          layout: null,
          rooms,
          ...(fixing.length ? { fixOnly: fixing } : {}),
        };
  if (left !== null && !fixing.length) delete plan.fixOnly;
  const draft: DraftDesign = structuredClone({
    id: o.designId,
    brief: o.brief,
    aliases: o.aliases,
    concept: o.concept,
    spaces: o.spaces,
    usage: o.usage,
    request: { locks: o.locks },
  });
  return {
    scope: i.resume.scope,
    brief: o.brief,
    plan,
    draft,
    ctx,
    locks: structuredClone(o.locks),
    ...(left === null && run.expected ? { expected: structuredClone(run.expected) } : {}),
  };
}

/**
 * What carrying an interrupted run on may cost at most: the steps left at their high, and the
 * fix-ups it has left at the dearest fix request (any room may take them all).
 */
export function resumeFigure(est: RunEstimate, fixesLeft: number): number | null {
  if (!est.usd) return null;
  return est.usd.high + est.usd.fixOne * Math.max(0, fixesLeft);
}

/**
 * The most a step sent now may cost, reserved in the run's figure before it goes: its own
 * estimate; a room the layout made, a room's on average (so the rooms together are what was
 * priced); a fix round, that room's own fix request at its most (the second look's round, or a
 * room the layout made: the dearest), so the pool at the dearest always covers it.
 */
export function stepHigh(
  est: RunEstimate,
  key: string,
  kind: 'layout' | 'room' | 'fix' | 'look',
): number {
  if (!est.usd) return 0;
  if (kind === 'fix') {
    const own = est.steps.find((x) => x.step === key)?.usd?.fixOne;
    return own && own > 0 ? own : est.usd.fixOne;
  }
  const own = est.steps.find((x) => x.step === key)?.usd?.high;
  if (own !== undefined) return own;
  const rooms = est.steps.filter((x) => x.kind === 'room').map((x) => x.usd?.high ?? 0);
  return rooms.length ? rooms.reduce((t, x) => t + x, 0) / rooms.length : 0;
}

/**
 * What an interrupted run spent: what was metered, and the most each step in flight may cost.
 * A step cut off while the page was alive is both metered (at its most) and still in flight:
 * counted twice, on purpose (it may be billed and sent again).
 */
export const spentWithInflight = (run: RunCheckpoint): number =>
  run.spent + run.inflight.reduce((t, x) => t + x.high, 0);

/**
 * What an interrupted run may still spend of what it was approved for (null: no figure): less
 * what it spent, and the steps that were in flight at their most (a page that died mid-step
 * never metered them).
 */
export const approvedLeft = (run: RunCheckpoint): number | null =>
  run.approved === null ? null : Math.max(0, run.approved - spentWithInflight(run));

/**
 * Whether a press may go ahead on the figure its button showed: not if priced higher now (or
 * priced now and not then, or the other way round): its card shows the new figure and asks.
 */
export const figureHolds = (shown: number | null, now: number | null): boolean =>
  shown === null || now === null ? shown === now : now <= shown + 0.005;

/** The plan a press would run on the plan as it is, and its price. */
export function priceRequest(i: PriceInput): Priced {
  const sp = i.resume
    ? resumePlan(i as PriceInput & { resume: NonNullable<PriceInput['resume']> })
    : i.keepFixing
      ? keepFixingPlan(i as PriceInput & { keepFixing: NonNullable<PriceInput['keepFixing']> })
      : i.finish
        ? finishPlan(i as PriceInput & { finish: NonNullable<PriceInput['finish']> })
        : planScope(
            i.scope,
            i.brief,
            i.project,
            i.levelId,
            i.designs,
            i.words,
            i.designId,
            i.opts,
            i.talk,
          );
  if (!sp) return null;
  const prompts = plannedPrompts(sp.ctx, sp.draft, sp.plan, i.opts, i.declined ?? []);
  // The look covers what the run was asked for (a run carried on: its checkpoint's), not only
  // the rooms left; a carried-on run looks only while its checkpoint says the look is to come.
  const asked = i.resume ? i.resume.run.plan.rooms : sp.plan.rooms;
  // Keep fixing never looks again (its rooms were looked at, or the look's round ran out too).
  const looks =
    !i.keepFixing && looksAt(sp.brief, i.ai) && (!i.resume || i.resume.run.look === 'left');
  // The pool it may really spend: a run carried on, what it has left; Keep fixing, the quality's
  // for its rooms; else the quality's for the rooms asked for.
  const pool = i.resume
    ? i.resume.run.fixesLeft
    : i.keepFixing
      ? fixPoolFor(sp.brief.quality, sp.plan.fixOnly?.length ?? 0, !!sp.brief.fixAll)
      : undefined;
  const est = estimateRun(prompts, {
    ...(pool !== undefined ? { pool } : {}),
    // Fix every check first (designer listens §6): the strict pool, priced in the figure.
    ...(sp.brief.fixAll ? { strict: true } : {}),
    ...(sp.plan.fixOnly?.length ? { fixOnly: sp.plan.fixOnly } : {}),
    provider: i.ai.provider,
    model: i.ai.model,
    quality: sp.brief.quality,
    prices: i.prices,
    // Thorough with a model that can see ends with the second look, in the same figures: its
    // pictures as they will be drawn (the scope's rooms, or the whole flat). Their sizes are
    // the frame's shape at a fixed long side: worked out on the plan before the run, they hold
    // for the plan it draws, as a layout moves only walls inside the flat's outline and runs
    // for some rooms have no layout step.
    look: looks
      ? {
          pictures: lookPictureSizes(
            sp.ctx.base,
            asked === 'all' ? null : asked.flatMap((k) => k.split('+')),
          ),
          ...(prompts.length ? {} : { base: lookBase(sp.ctx) }),
        }
      : false,
  });
  return { sp, est };
}

/** The log's line when the person stopped the second look with every room done. */
export const LOOK_STOP_NOTE = 'You stopped the second look. The rooms are done and checked.';

/**
 * The look an option ends with: the run's, else what its checkpoint kept (carried on after it
 * answered), else, on Thorough with a model that can't see, why there is none; and the log's
 * line when the person stopped the look with every room done.
 */
export function lookAtEnd(o: {
  looked: OptionLook | null;
  run: Pick<RunCheckpoint, 'lookResult'>;
  brief: { quality: string };
  ai: { provider: RunCheckpoint['provider']; model: string };
  phase: string;
  stopped: boolean;
  at: string;
}): { look: OptionLook | null; stopNote: string | null } {
  const look =
    o.looked ??
    o.run.lookResult ??
    (o.brief.quality === 'thorough' && !canSee(o.ai.provider, o.ai.model)
      ? {
          state: 'skipped' as const,
          summary: null,
          notes: [],
          findings: [],
          dropped: [],
          offers: [],
          round: 'none' as const,
          line: NO_LOOK,
          at: o.at,
        }
      : null);
  const stopNote = o.phase === 'done' && o.stopped && look ? LOOK_STOP_NOTE : null;
  return { look, stopNote };
}
