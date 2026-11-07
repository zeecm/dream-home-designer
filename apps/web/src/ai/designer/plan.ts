import {
  type Aspect,
  BATHROOMS,
  type Command,
  type ContextInput,
  type Design,
  type DesignBrief,
  type DesignOptions,
  type DesignResult,
  type Level,
  type Lock,
  type Part,
  type Price,
  type Project,
  type RunEstimate,
  type StepPrompt,
  acceptDesign,
  aliasesFor,
  aspectOf,
  designResult,
  estimateRun,
  handEdits,
  layoutStep,
  levelFingerprint,
  lockCovers,
  roomIdAt,
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
  // The limit against the most it may cost, fix rounds included.
  return cap !== null && spend.usd + est.usd.high + (est.usd.fix ?? 0) > cap;
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

/**
 * A "Kept as you changed them" row: one per space and part, its locks unlocked together. A
 * lock holds the whole part (all the room's furniture, say), so the row says what is held
 * (`head`, e.g. "Living and dining furniture, all 15 pieces as they are now") and then why.
 */
export interface HeldRow {
  key: string;
  locks: Lock[];
  text: string;
}
export function heldRows(locks: Lock[], head: (l: Lock) => string = () => ''): HeldRow[] {
  const rows = new Map<string, HeldRow>();
  for (const l of locks) {
    const key = `${l.space}|${l.aspect}`;
    const row = rows.get(key) ?? { key, locks: [], text: '' };
    row.locks.push(l);
    const why = row.locks.map((x) => x.label).join(', ');
    const what = head(l);
    row.text = what ? `${what}: ${why}` : why;
    rows.set(key, row);
  }
  return [...rows.values()];
}

/**
 * What a held row keeps, in words: "Living and dining furniture, all 13 pieces, as now"
 * (counted in After, `after`), "Kitchen furniture, none, as now", "Bedroom paint and floors".
 */
export function heldHead(
  l: Lock,
  spaces: { name: string; rooms: string[] }[],
  after: Level | undefined,
): string {
  if (l.space === '*') return '';
  if (l.space === BATHROOMS) return 'Bathrooms’ paint and floors';
  const s = spaces.find((x) => lockCovers(l, x.rooms));
  const name = s?.name ?? 'A room';
  const what = ASPECT_NAMES[l.aspect].toLowerCase();
  if (l.aspect !== 'furniture' && l.aspect !== 'built-ins') return `${name} ${what}`;
  const n = Object.values(after?.items ?? {}).filter((it) => {
    const room = after && roomIdAt(after, { x: it.position.x, y: it.position.z });
    return aspectOf(it) === l.aspect && !!room && !!s?.rooms.includes(room);
  }).length;
  const pieces = n === 0 ? 'none' : n === 1 ? 'its 1 piece' : `all ${n} pieces`;
  return `${name} ${what}, ${pieces}, as now`;
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
  const after = doc.renovation?.levels[0];
  const accepted = lastAccepted(designs, after);
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
 * Accepting `d`'s ticked parts as the app does: worked out on After as it is now (or the
 * flat, with no renovation), keeping what was changed by hand since the last accept; with
 * the plan as it was before (`prior`), to record what the accept itself changed.
 */
export function acceptCommand(
  d: Design,
  designs: Design[],
  doc: Project,
  parts: Part[],
  result: DesignOptions,
  opts: { removeHandPlaced?: boolean; label?: string } = {},
): { command: Command; prior: Level } | null {
  const before = doc.levels[0];
  const v = onPlanNow(d, designs, doc);
  const r = resultFor(doc, { ...v, base: { ...v.base, variant: 'after' } }, result);
  if (!r || !before) return null;
  return {
    command: acceptDesign(before.id, r.level, parts, {
      base: d.baseLevel,
      ...(opts.removeHandPlaced ? { removeHandPlaced: true } : {}),
      ...(opts.label ? { label: opts.label } : {}),
    }),
    prior: structuredClone(doc.renovation?.levels[0] ?? before),
  };
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
