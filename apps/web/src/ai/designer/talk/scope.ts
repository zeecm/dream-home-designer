import {
  type Aspect,
  type ContextInput,
  type Design,
  type DesignBrief,
  type DesignOptions,
  type Lock,
  type Project,
  type ScopeRef,
  spacesOf,
} from '@dhd/core';
import { changeFrom, changePlan, contextFor, lastAccepted, resultFor } from '../plan';
import type { DraftDesign, RunPlan } from '../run';

/**
 * What a scope button asks the runner for, on the plan as it is: once a version is in the
 * renovation, a change from it on After (keeping what was changed by hand since); before that,
 * a fresh design of the scope. Pure, so it is tested on its own.
 */

const ALL_ASPECTS: Aspect[] = ['walls', 'furniture', 'built-ins', 'finishes'];
const ROOM_ASPECTS: Aspect[] = ['furniture', 'built-ins', 'finishes'];

export interface ScopePlan {
  scope: ScopeRef;
  brief: DesignBrief;
  plan: RunPlan;
  draft: DraftDesign;
  ctx: ContextInput & { variant: 'after' | 'before' };
  locks: Lock[];
  expected?: { key: string; label: string }[];
}

/**
 * What a scope asks for on the plan as it is: once a version is in the renovation, a change
 * from it on After (keeping what was changed by hand since); before that, a fresh design of
 * the scope on the plan.
 */
export function planScope(
  scope: ScopeRef,
  brief0: DesignBrief,
  project: Project,
  designs: Design[],
  words: string,
  designId: string,
  opts: DesignOptions,
): ScopePlan | null {
  const brief: DesignBrief = { ...brief0, start: project.renovation ? 'after' : 'before' };
  const feedback = words.trim();
  const after = project.renovation?.levels[0];
  const accepted = lastAccepted(designs, after);
  if (accepted) {
    const from = changeFrom(accepted, designs, project);
    const v = { ...from.v, brief: { ...brief, start: 'after' as const } };
    const r = resultFor(project, v, opts);
    if (!r) return null;
    const made = changePlan(
      v,
      r,
      {
        scope: scope.all ? 'all' : (scope.spaces[0] ?? 'all'),
        aspects: scope.all ? ALL_ASPECTS : ROOM_ASPECTS,
        keep: {},
        feedback,
        held: from.held,
      },
      designId,
    );
    const ctx = made && contextFor(project, v.brief, made.design.aliases);
    if (!made || !ctx) return null;
    return {
      scope,
      brief: v.brief,
      plan: made.plan,
      draft: { ...made.design, brief: v.brief },
      ctx,
      locks: made.locks,
      expected: r.spaces
        .filter((s) => !(made.plan.skip ?? []).includes(s.key))
        .map((s) => ({ key: s.key, label: s.name })),
    };
  }
  const ctx = contextFor(project, brief);
  if (!ctx) return null;
  const draft: DraftDesign = {
    id: designId,
    brief,
    aliases: ctx.aliases,
    concept: null,
    spaces: {},
    usage: [],
    request: { locks: [] },
  };
  if (scope.all) {
    return {
      scope,
      brief,
      plan: { layout: {}, rooms: 'all', ...(feedback ? { feedback } : {}) },
      draft,
      ctx,
      locks: [],
      expected: spacesOf(ctx.base).map((s) => ({ key: s.key, label: s.name })),
    };
  }
  return {
    scope,
    brief,
    plan: { layout: null, rooms: scope.spaces, ...(feedback ? { feedback } : {}) },
    draft,
    ctx,
    locks: [],
  };
}
