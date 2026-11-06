import {
  type Aspect,
  type ContextInput,
  type Design,
  type DesignBrief,
  type DesignOptions,
  type DesignResult,
  type Level,
  type Lock,
  type Price,
  type Project,
  type RunEstimate,
  type StepPrompt,
  aliasesFor,
  designResult,
  estimateRun,
  layoutStep,
  levelFingerprint,
  roomStep,
  runPrompts,
  spacesOf,
} from '@dhd/core';
import type { AiSettings } from '../credentials';
import type { DraftDesign, RunPlan } from './run';

/**
 * Working out what a run will ask for, before it runs: the level a design starts from, its
 * stable context, the requests a whole design or a change makes, and what they'll cost.
 */

/** The level a design starts from: After when asked and there is one, else the flat as it is. */
export function baseOf(
  doc: Project,
  want: 'after' | 'before',
): { base: Level; before: Level; variant: 'after' | 'before' } | null {
  const before = doc.levels[0];
  if (!before) return null;
  const after = doc.renovation?.levels[0];
  return want === 'after' && after
    ? { base: after, before, variant: 'after' }
    : { base: before, before, variant: 'before' };
}

export function contextFor(
  doc: Project,
  brief: DesignBrief,
  aliases?: Record<string, string>,
): (ContextInput & { variant: 'after' | 'before' }) | null {
  const b = baseOf(doc, brief.start);
  if (!b) return null;
  return {
    base: b.base,
    before: b.before,
    brief,
    aliases: aliasesFor(b.base, aliases ?? {}),
    ...(doc.site ? { site: doc.site } : {}),
    ...(doc.models ? { models: doc.models } : {}),
    variant: b.variant,
  };
}

/** A version placed on the plan as it is now (on After, if it was designed on it). */
export function resultFor(
  doc: Project,
  d: Pick<Design, 'id' | 'brief' | 'aliases' | 'concept' | 'spaces' | 'base'>,
  opts: DesignOptions,
): DesignResult | null {
  const b = baseOf(doc, d.base.variant);
  if (!b) return null;
  return designResult(b.base, b.before, d, opts);
}

/** Whether the plan the version would go on has changed since it was made. */
export function planChanged(doc: Project, d: Design): boolean {
  const b = baseOf(doc, d.base.variant);
  return !!b && levelFingerprint(b.base) !== d.base.fingerprint;
}

/** The room requests a plan makes on the level as it is (no layout step run). */
export function roomPrompts(
  ctx: ContextInput,
  design: DraftDesign,
  plan: RunPlan,
  opts: DesignOptions,
): StepPrompt[] {
  const r0 = designResult(ctx.base, ctx.before, { ...design, spaces: {} }, opts);
  const all = r0.spaces.map((s) => s.key);
  const wanted = (plan.rooms === 'all' ? all : plan.rooms).filter(
    (k) => all.includes(k) && !(plan.skip ?? []).includes(k),
  );
  const others = Object.fromEntries(
    Object.entries(design.spaces).filter(([k]) => !wanted.includes(k)),
  );
  const r = designResult(ctx.base, ctx.before, { ...design, spaces: others }, opts);
  const aliases = aliasesFor(r.level, design.aliases);
  return r.spaces
    .filter((s) => wanted.includes(s.key))
    .map((s) =>
      roomStep(ctx, s, r.level, aliases, {
        concept: design.concept,
        ...(plan.feedback ? { feedback: plan.feedback } : {}),
        locks: plan.locks ?? [],
        previous: plan.previous?.[s.key] ?? null,
      }),
    );
}

/** The requests a run would make (a layout step's rooms as the plan has them now). */
export function plannedPrompts(
  ctx: ContextInput,
  design: DraftDesign,
  plan: RunPlan,
  opts: DesignOptions,
): StepPrompt[] {
  if (!plan.layout) return roomPrompts(ctx, design, plan, opts);
  if (!design.concept) {
    // A whole design: the rooms of the plan as it is, as the estimate's best guess.
    return runPrompts(ctx, spacesOf(ctx.base), ctx.aliases);
  }
  const layout = layoutStep(ctx, {
    ...(plan.feedback ? { feedback: plan.feedback } : {}),
    locks: plan.locks ?? [],
    previous: plan.layout.previous ?? null,
  });
  return [layout, ...roomPrompts(ctx, design, plan, opts)];
}

export function estimateFor(
  ai: AiSettings,
  prompts: StepPrompt[],
  quality: DesignBrief['quality'],
  prices: Record<string, Price>,
): RunEstimate {
  return estimateRun(prompts, { provider: ai.provider, model: ai.model, quality, prices });
}

/** The cost check comes first: a run that may cost US$0.50, the tab's first, or one past the limit. */
export function needsCostCheck(
  est: RunEstimate,
  spend: { usd: number; runs: number },
  cap: number | null,
): boolean {
  if (spend.runs === 0) return true;
  if (!est.usd) return true;
  if (est.usd.high >= 0.5) return true;
  return cap !== null && spend.usd + est.usd.high > cap;
}

/** Over this many input tokens in one step, a run is refused. */
export const MAX_STEP_INPUT = 180_000;
/** Over this many in all, the cost check says the plan is large. */
export const LARGE_INPUT = 60_000;

export const ROOM_ASPECTS: Aspect[] = ['furniture', 'built-ins', 'finishes'];
export const ASPECT_NAMES: Record<Aspect, string> = {
  walls: 'Walls',
  furniture: 'Furniture',
  'built-ins': 'Built-ins',
  finishes: 'Paint and floors',
};

/** What "Change something" asks for. */
export interface ChangeRequest {
  /** 'all', or a space's key. */
  scope: string;
  aspects: Aspect[];
  /** Kept as they are, by space key ('*' for the walls). */
  keep: Record<string, Aspect[]>;
  feedback: string;
}

/**
 * The run a change makes from version `v` (`result`: it on the plan now), and the new
 * version's starting point: what isn't asked for is copied from `v`.
 */
export function changePlan(
  v: Design,
  result: DesignResult,
  req: ChangeRequest,
  newId: string,
): { plan: RunPlan; design: DraftDesign; locks: Lock[]; labels: string[] } | null {
  const spaces = result.spaces;
  const name = (key: string) => spaces.find((s) => s.key === key)?.name ?? 'Room';
  const locks: Lock[] = [];
  for (const [key, aspects] of Object.entries(req.keep)) {
    for (const aspect of aspects) {
      locks.push({
        space: key,
        aspect,
        by: 'person',
        label:
          key === '*' ? 'Walls and doors' : `${name(key)}: ${ASPECT_NAMES[aspect].toLowerCase()}`,
      });
    }
  }
  const locked = (key: string, a: Aspect) => !!req.keep[key]?.includes(a);
  const asked = (a: Aspect) => req.aspects.includes(a);
  const walls = req.scope === 'all' && asked('walls') && !locked('*', 'walls');
  const roomAspects = ROOM_ASPECTS.filter(asked);
  const targets = (req.scope === 'all' ? spaces : spaces.filter((s) => s.key === req.scope)).filter(
    (s) => roomAspects.some((a) => !locked(s.key, a)),
  );
  if (!walls && !targets.length) return null;
  const keep: Record<string, Aspect[]> = {};
  const previous: RunPlan['previous'] = {};
  for (const s of spaces) {
    keep[s.key] = ROOM_ASPECTS.filter((a) => !asked(a) || locked(s.key, a));
    const answer = s.storedKey ? v.spaces[s.storedKey]?.design : undefined;
    if (answer) previous[s.key] = answer;
  }
  const copied: DraftDesign['spaces'] = {};
  for (const [k, e] of Object.entries(v.spaces)) {
    if (e.design && ['done', 'copied', 'locked'].includes(e.status)) {
      copied[k] = { name: e.name, status: 'copied', design: e.design };
    }
  }
  const design: DraftDesign = {
    id: newId,
    brief: v.brief,
    aliases: v.aliases,
    concept: v.concept,
    spaces: copied,
    usage: [],
  };
  const keys = targets.map((s) => s.key);
  const plan: RunPlan = {
    layout: walls ? { previous: v.concept } : null,
    rooms: walls ? 'all' : keys,
    ...(walls
      ? {
          skip: spaces.filter((s) => !targets.includes(s)).map((s) => s.key),
        }
      : {}),
    ...(req.feedback.trim() ? { feedback: req.feedback.trim() } : {}),
    locks,
    previous,
    keep,
  };
  const what = roomAspects.filter((a) => req.scope === 'all' || !locked(req.scope, a));
  const labels = [
    ...(walls ? ['Layout and style'] : []),
    ...targets.map((s) =>
      `${s.name} ${what
        .filter((a) => !locked(s.key, a))
        .map((a) => ASPECT_NAMES[a].toLowerCase())
        .join(', ')}`.trim(),
    ),
  ];
  return { plan, design, locks, labels };
}
