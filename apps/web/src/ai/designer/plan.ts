import type { AiSettings } from '@dhd/ai';
import {
  type DesignBrief,
  type Price,
  type RunEstimate,
  type StepPrompt,
  estimateRun,
} from '@dhd/core';

/**
 * What a run will cost on the person's key. Working out what it asks for (the level a design
 * starts from, its context, a change from a version) is core's (`designer/talk/plan.ts`).
 */
export {
  ASPECT_NAMES,
  type ChangeRequest,
  ROOM_ASPECTS,
  acceptedNow,
  baseOf,
  changeFrom,
  changePlan,
  changedText,
  contextFor,
  lastAccepted,
  onPlanNow,
  plannedPrompts,
  resultFor,
  roomPrompts,
  wallsInAfter,
  wallsStillIn,
} from '@dhd/core';

export function estimateFor(
  ai: AiSettings,
  prompts: StepPrompt[],
  quality: DesignBrief['quality'],
  prices: Record<string, Price>,
): RunEstimate {
  return estimateRun(prompts, { provider: ai.provider, model: ai.model, quality, prices });
}

/** Over this many input tokens in one step, a run is refused. */
export const MAX_STEP_INPUT = 180_000;
/** Over this many in all, the cost check says the plan is large. */
export const LARGE_INPUT = 60_000;
