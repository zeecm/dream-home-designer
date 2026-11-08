import {
  type Design,
  type DesignBrief,
  type DesignOptions,
  type DraftDesign,
  type Price,
  type Project,
  type ProposalOption,
  type RunEstimate,
  type RunPlan,
  type ScopePlan,
  type ScopeRef,
  type TalkAsk,
  contextFor,
  estimateRun,
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

/** The plan a press would run on the plan as it is, and its price. */
export function priceRequest(i: PriceInput): Priced {
  const sp = i.finish
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
    // Thorough with a model that can see ends with the second look, in the same figures.
    look: looksAt(sp.brief, i.ai),
  });
  return { sp, est };
}
