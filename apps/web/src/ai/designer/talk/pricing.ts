import {
  type Design,
  type DesignBrief,
  type DesignOptions,
  type DraftDesign,
  type Price,
  type Project,
  type ProposalOption,
  type RunCheckpoint,
  type RunEstimate,
  type RunPlan,
  type ScopePlan,
  type ScopeRef,
  type TalkAsk,
  contextFor,
  estimateRun,
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
  designId: string;
  opts: DesignOptions;
  ai: { provider: 'anthropic' | 'openai' | 'gemini'; model: string };
  prices: Record<string, Price>;
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
  const plan: RunPlan = left === null ? asked : { ...asked, layout: null, rooms: left };
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
 * fix rounds it may still send (the run's `remainingHigh`, priced afresh on what is left).
 */
export function resumeFigure(est: RunEstimate, fixesLeft: number): number | null {
  if (!est.usd) return null;
  const share = est.fixes > 0 ? Math.min(1, fixesLeft / est.fixes) : 0;
  return est.usd.high + est.usd.fix * share;
}

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
  const est = estimateRun(plannedPrompts(sp.ctx, sp.draft, sp.plan, i.opts), {
    provider: i.ai.provider,
    model: i.ai.model,
    quality: sp.brief.quality,
    prices: i.prices,
  });
  return { sp, est };
}
