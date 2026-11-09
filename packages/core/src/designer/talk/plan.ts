import { designLevels } from '../../levels';
import type { Level, Project } from '../../schema';
import { aliasesFor } from '../aliases';
import type { ContextInput } from '../describe';
import { handEdits, lockCovers } from '../handEdits';
import { lensOn } from '../lenses/lens';
import { type StepPrompt, type TalkAsk, layoutStep, roomStep, runPrompts } from '../prompts';
import { type DesignOptions, type DesignResult, designResult } from '../result';
import type {
  Aspect,
  Concept,
  Design,
  DesignBrief,
  DesignInput,
  Lock,
  SpaceDesign,
  Usage,
} from '../schema';
import { spacesOf } from '../spaces';
import { levelFingerprint } from '../util';
import type { ScopeRef } from './schema';

/** A version as the runner builds it. */
export type DraftDesign = DesignInput & { usage: Usage[] };

export type { TalkAsk };

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
  /** From the conversation: what this proposal is for (the talk block). */
  talk?: TalkAsk;
}

/**
 * Working out what a run will ask for, before it runs: the level a design starts from, its
 * stable context, the requests a whole design or a change makes, and what they'll cost.
 */

/**
 * The level a design starts from, of level `levelId` (a home of several levels is designed a
 * level at a time): After when asked and there is one, else the flat as it is.
 */
export function baseOf(
  doc: Project,
  want: 'after' | 'before',
  levelId: string,
): { base: Level; before: Level; variant: 'after' | 'before' } | null {
  const l = designLevels(doc, levelId);
  if (!l) return null;
  const { before, after } = l;
  return want === 'after' && after
    ? { base: after, before, variant: 'after' }
    : { base: before, before, variant: 'before' };
}

export function contextFor(
  doc: Project,
  brief: DesignBrief,
  levelId: string,
  aliases?: Record<string, string>,
): (ContextInput & { variant: 'after' | 'before' }) | null {
  const b = baseOf(doc, brief.start, levelId);
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
  d: Pick<Design, 'id' | 'brief' | 'aliases' | 'concept' | 'spaces' | 'base' | 'levelId'>,
  opts: DesignOptions,
): DesignResult | null {
  const b = baseOf(doc, d.base.variant, d.levelId);
  if (!b) return null;
  return designResult(b.base, b.before, d, opts);
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
        ...(opts.kept?.length ? { kept: opts.kept } : {}),
        // As the run sends it: the storage lens's block, unless the lens is off.
        ...(!lensOn(opts, 'storage')
          ? { storage: false as const }
          : opts.storage
            ? { storage: opts.storage }
            : {}),
        ...(plan.feedback ? { feedback: plan.feedback } : {}),
        ...(plan.talk ? { talk: plan.talk } : {}),
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
    ...(plan.talk ? { talk: plan.talk } : {}),
    locks: plan.locks ?? [],
    previous: plan.layout.previous ?? null,
  });
  return [layout, ...roomPrompts(ctx, design, plan, opts)];
}

export const ROOM_ASPECTS: Aspect[] = ['furniture', 'built-ins', 'finishes'];
export const ASPECT_NAMES: Record<Aspect, string> = {
  walls: 'Walls',
  furniture: 'Furniture',
  'built-ins': 'Built-ins',
  finishes: 'Paint and floors',
};

/** What "Change something" asks for. */
export interface ChangeRequest {
  /** 'all', a space's key, or several. */
  scope: string | string[];
  aspects: Aspect[];
  /** Kept as they are, by space key ('*' for the walls). */
  keep: Record<string, Aspect[]>;
  feedback: string;
  /** Parts changed by hand since accepting, still kept (`hand-edit` locks; × unlocks one). */
  held?: Lock[];
}

/**
 * The plan as it was just before a version was accepted: what the accept itself changed is
 * the difference to `accepted.level`. Records kept before this was stored fall back to the
 * level the version was designed on.
 */
const priorOf = (d: Design): Level => d.accepted?.prior ?? d.baseLevel;

/**
 * Whether the wall changes a version's accept made are still in After: the walls and
 * openings it added are there, those it took away aren't, and the walls it glazed or cut
 * down still are. Null when it accepted no walls part, or that part changed nothing.
 */
export function wallsStillIn(d: Design, after: Level | undefined): boolean | null {
  if (!after || !d.accepted?.parts.some((p) => p.aspect === 'walls')) return null;
  const was = priorOf(d);
  const acc = d.accepted.level;
  const checks: boolean[] = [];
  for (const [id, w] of Object.entries(acc.walls)) {
    const old = was.walls[id];
    const now = after.walls[id];
    if (!old) checks.push(!!now);
    else if (old.build !== w.build || old.height !== w.height) {
      checks.push(!!now && now.build === w.build && now.height === w.height);
    }
  }
  for (const id of Object.keys(was.walls)) if (!acc.walls[id]) checks.push(!after.walls[id]);
  for (const id of Object.keys(acc.openings)) {
    if (!was.openings[id]) checks.push(!!after.openings[id]);
  }
  for (const id of Object.keys(was.openings)) {
    if (!acc.openings[id]) checks.push(!after.openings[id]);
  }
  return checks.length ? checks.every(Boolean) : null;
}

/**
 * Whether a version is in the renovation now: accepted, and its pieces or its wall changes
 * still there (a version accepted for its walls alone stays accepted through later edits).
 */
export function acceptedNow(d: Design, after: Level | undefined): boolean {
  if (!d.accepted || !after) return false;
  const lvl = d.accepted.level;
  // The pieces the accept itself put in (not those it kept, as held parts are).
  const was = priorOf(d);
  const items = Object.keys(lvl.items).filter((id) => !was.items[id]);
  if (items.some((id) => !!after.items[id])) return true;
  const walls = wallsStillIn(d, after);
  if (walls !== null) return walls;
  if (items.length) return false;
  return levelFingerprint(after) === levelFingerprint(lvl);
}

/** A version's wall changes, as text to compare by. */
const wallsText = (d: Design) => JSON.stringify(d.concept?.walls ?? []);

/**
 * Whether After has `v`'s wall changes already: a version with the same wall changes (it,
 * or one made from it that copied them) was accepted with its walls, and they are still
 * there. Applied again on After, they would be made twice.
 */
export function wallsInAfter(v: Design, designs: Design[], after: Level | undefined): boolean {
  if (!v.concept?.walls.length) return false;
  const mine = wallsText(v);
  return [v, ...designs].some((d) => wallsText(d) === mine && wallsStillIn(d, after) === true);
}

/** The version accepted last that is still in the renovation, if any. */
export function lastAccepted(designs: Design[], after: Level | undefined): Design | null {
  return (
    designs
      .filter((d) => acceptedNow(d, after))
      .sort((a, b) => ((a.accepted?.at ?? '') < (b.accepted?.at ?? '') ? -1 : 1))
      .pop() ?? null
  );
}

/**
 * Where a change to `v` starts. Once a version is accepted, After is the truth (D9): the
 * change is made on After as it is now, and what the person changed by hand since accepting
 * is listed as `hand-edit` locks. A version whose walls are in After already brings no wall
 * changes of its own (they'd be made twice).
 */
export function changeFrom(
  v: Design,
  designs: Design[],
  doc: Project,
): { v: Design; held: Lock[]; accepted: Design | null } {
  // Its own level's renovation, and the versions of that level.
  const after = designLevels(doc, v.levelId)?.after;
  const accepted = lastAccepted(
    designs.filter((d) => d.levelId === v.levelId),
    after,
  );
  if (!accepted?.accepted || !after) return { v, held: [], accepted: null };
  const wallsIn = wallsInAfter(v, designs, after);
  return {
    v: {
      ...v,
      brief: { ...v.brief, start: 'after' },
      base: { ...v.base, variant: 'after' },
      concept: wallsIn && v.concept ? { ...v.concept, walls: [] } : v.concept,
    },
    held: heldFor(v, accepted, after),
    accepted,
  };
}

/**
 * What a version keeps as changed by hand. A version made on After since the last accept
 * already decided on the hand edits made before it (kept, or unlocked and redone): its own
 * hand-edit locks stand, and only edits made since it was made are added. Any other version
 * keeps every hand edit since the last accept.
 */
function heldFor(v: Design, accepted: Design, after: Level): Lock[] {
  const at = accepted.accepted?.at ?? '';
  const decided = v.base.variant === 'after' && v.createdAt > at && v.id !== accepted.id;
  if (!decided) return accepted.accepted ? handEdits(accepted.accepted.level, after) : [];
  const own = v.request.locks.filter((l) => l.by === 'hand-edit');
  const since = handEdits(v.baseLevel, after);
  const key = (l: Lock) => `${l.space}|${l.aspect}|${l.label}`;
  const seen = new Set(own.map(key));
  return [...own, ...since.filter((l) => !seen.has(key(l)))];
}

/**
 * A version as the plan would have it now, for showing it, comparing it and accepting it.
 * Once a version is accepted, After is the truth: it is placed on After as it is, without
 * wall changes After already has, keeping what was changed by hand since the accept (the
 * hand-edit locks it was made with are replaced by those, so an undone accept holds nothing).
 * For a version wholly in the renovation, that is After itself.
 */
export function onPlanNow(d: Design, designs: Design[], doc: Project): Design {
  const from = changeFrom(d, designs, doc);
  const own = from.v.request.locks.filter((l) => l.by !== 'hand-edit');
  const locks = [...own, ...from.held];
  if (locks.length === d.request.locks.length && from.v === d && !from.held.length) return d;
  return { ...from.v, request: { ...from.v.request, locks } };
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
  const held = req.held ?? [];
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
  locks.push(...held);
  const roomsOf = (key: string) => spaces.find((s) => s.key === key)?.rooms ?? key.split('+');
  const locked = (key: string, a: Aspect) =>
    !!req.keep[key]?.includes(a) ||
    held.some(
      (l) => l.aspect === a && (key === '*' ? l.space === '*' : lockCovers(l, roomsOf(key))),
    );
  const asked = (a: Aspect) => req.aspects.includes(a);
  const walls = req.scope === 'all' && asked('walls') && !locked('*', 'walls');
  const roomAspects = ROOM_ASPECTS.filter(asked);
  const keys0 =
    req.scope === 'all' ? null : typeof req.scope === 'string' ? [req.scope] : req.scope;
  const targets = (keys0 ? spaces.filter((s) => keys0.includes(s.key)) : spaces).filter((s) =>
    roomAspects.some((a) => !locked(s.key, a)),
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
    request: { locks },
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
  const one = keys0?.length === 1 ? keys0[0] : null;
  const what = roomAspects.filter((a) => !one || !locked(one, a));
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

/** What a version changed from the one it was made from: "From V1. Changed: Kitchen furniture · “Cheaper.”" */
export function changedText(d: Design, parentN: number | null): string {
  const sc = d.request.scope;
  const aspects = (as: Aspect[]) => as.map((a) => ASPECT_NAMES[a].toLowerCase()).join(', ');
  const what =
    sc.kind === 'space'
      ? `${d.spaces[sc.space]?.name ?? 'a room'} ${aspects(sc.aspects)}`
      : sc.kind === 'aspects'
        ? `the whole design: ${aspects(sc.aspects)}`
        : 'the whole design';
  const words = d.request.feedback.trim();
  return `${parentN ? `From V${parentN}. ` : ''}Changed: ${what}${words ? ` · “${words}”` : ''}`;
}

const ALL_ASPECTS: Aspect[] = ['walls', 'furniture', 'built-ins', 'finishes'];

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
  levelId: string,
  designs: Design[],
  words: string,
  designId: string,
  opts: DesignOptions,
  talk?: TalkAsk,
): ScopePlan | null {
  const sp = planScopeOnly(scope, brief0, project, levelId, designs, words, designId, opts);
  return sp && talk ? { ...sp, plan: { ...sp.plan, talk } } : sp;
}

function planScopeOnly(
  scope: ScopeRef,
  brief0: DesignBrief,
  project: Project,
  levelId: string,
  designs0: Design[],
  words: string,
  designId: string,
  opts: DesignOptions,
): ScopePlan | null {
  // The level designed, and its own versions (another level's never count).
  const after = designLevels(project, levelId)?.after;
  const designs = designs0.filter((d) => d.levelId === levelId);
  const brief: DesignBrief = { ...brief0, start: after ? 'after' : 'before' };
  // The whole flat changes its walls too, unless the scope says furniture only.
  const walls = scope.all && scope.walls !== false;
  const feedback = words.trim();
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
        scope: scope.all ? 'all' : scope.spaces.length ? scope.spaces : 'all',
        aspects: walls ? ALL_ASPECTS : ROOM_ASPECTS,
        keep: {},
        feedback,
        held: from.held,
      },
      designId,
    );
    const ctx = made && contextFor(project, v.brief, levelId, made.design.aliases);
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
  const ctx = contextFor(project, brief, levelId);
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
      plan: { layout: walls ? {} : null, rooms: 'all', ...(feedback ? { feedback } : {}) },
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
