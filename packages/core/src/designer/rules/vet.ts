import { entranceDoor } from '../../delivery';
import { furnitureKind } from '../../furniture';
import { levelBounds } from '../../geometry';
import type { Level } from '../../schema';
import { SHELTER_ROOM } from '../../structural';
import { measureRoute } from '../../walkway';
import { usesOf as roomUses } from '../checks';
import { BEDROOM_USES, peopleOf, roleOf, sleepingPlan } from '../principles';
import type { ProgrammeUse } from '../principles';
import type { DesignBrief, RoomUse } from '../schema';
import { roomsBeside } from '../spaces';
import { stableJson } from '../util';
import { ruleChecks } from './check';
import {
  MAX_RULES,
  ROUTE_FLOOR,
  Rule,
  type RuleSubject,
  type RuleTarget,
  numberRange,
  roundN,
  ruleNumber,
} from './schema';
import { kindInCategory, listWords, ruleSentence, subjectMatches } from './words';

/**
 * Vetting a rule before it is offered (slice 3a tech §4): the first refusal that applies
 * decides, in this order: unfit, limit, duplicate, conflict, range, hdb, flat, needs, no-door.
 * Needs only the plan, so it runs when the reply lands and the offer is stored with its verdict.
 */

export type VetRefusal =
  | 'unfit'
  | 'limit'
  | 'duplicate'
  | 'conflict'
  | 'range'
  | 'hdb'
  | 'flat'
  | 'needs'
  | 'no-door';

export type Vet =
  | {
      ok: true;
      rule: Rule;
      /** The number lowered to what the flat allows (UX §4). */
      adjusted?: { from: number; to: number; why: string };
      /** A clear width kept on the same route already: that rule is raised instead. */
      raises?: { ruleId: string; from: number; to: number };
      /** What the plan already breaks (UX §3.3 a): never blocks. */
      planBreaks: string[];
    }
  | { ok: false; why: VetRefusal; text: string; with?: Rule };

export interface VetCtx {
  /** The conversation's rules (deleted ones are ignored). */
  rules: readonly Rule[];
  level: Level;
  brief: DesignBrief;
  /** The uses a room is checked for (default: what its name says). */
  usesOf?: (roomId: string) => ProgrammeUse[];
}

export const NOT_CHECKABLE = 'I couldn’t turn this into a check, so it’s noted, not checked.';
export const LIMIT_TEXT = `You have ${MAX_RULES} rules, the most a home can have. Delete one in Your rules to keep this.`;
const m = (n: number) => `${n.toFixed(2)} m`;
const floor2 = (n: number) => Math.floor(n * 100 + 1e-6) / 100;

const sameTarget = (a: RuleTarget, b: RuleTarget) => {
  if (a.kind === 'route' && b.kind === 'route')
    return stableJson([...a.to].sort()) === stableJson([...b.to].sort());
  return stableJson(a) === stableJson(b);
};

/** Whether two subjects can be about the same piece (item ⊂ kind ⊂ role ⊂ category ⊂ any). */
export function subjectsOverlap(a: RuleSubject, b: RuleSubject, level: Level): boolean {
  if (a.kind === 'any' || b.kind === 'any') return true;
  if (stableJson(a) === stableJson(b)) return true;
  const one = (x: RuleSubject, y: RuleSubject): boolean => {
    if (x.kind === 'item') {
      const it = level.items[x.itemId];
      return !!it && subjectMatches(y, it);
    }
    if (x.kind === 'kind' && y.kind === 'kind') {
      const kx = furnitureKind(x.kindId);
      const ky = furnitureKind(y.kindId);
      return (
        x.kindId === y.kindId ||
        (!!kx && roleOf(kx) === y.kindId) ||
        (!!ky && roleOf(ky) === x.kindId)
      );
    }
    if (x.kind === 'kind' && y.kind === 'category') return kindInCategory(x.kindId, y.category);
    return false;
  };
  return one(a, b) || one(b, a);
}

/** Rooms a room target covers (a room, or every room of a use). */
function roomsOf(
  t: RuleTarget,
  level: Level,
  usesOf: (id: string) => ProgrammeUse[],
): string[] | null {
  if (t.kind === 'room') return [t.roomId];
  if (t.kind === 'roomUse')
    return Object.keys(level.rooms).filter((id) => (usesOf(id) as string[]).includes(t.use));
  return null;
}

/** Whether two targets can be the same place. */
function targetsOverlap(
  a: RuleTarget,
  b: RuleTarget,
  level: Level,
  usesOf: (id: string) => ProgrammeUse[],
): boolean {
  if (sameTarget(a, b)) return true;
  const ra = roomsOf(a, level, usesOf);
  const rb = roomsOf(b, level, usesOf);
  if (ra && rb) return ra.some((r) => rb.includes(r));
  return false;
}

const OPPOSITE: Partial<Record<Rule['relation'], Rule['relation']>> = {
  in: 'notIn',
  notIn: 'in',
  faces: 'notFaces',
  notFaces: 'faces',
};

/** A live rule the new one contradicts, if any (UX §4). */
function conflictOf(
  rule: Rule,
  live: readonly Rule[],
  level: Level,
  usesOf: (id: string) => ProgrammeUse[],
): Rule | null {
  for (const old of live) {
    if (!subjectsOverlap(rule.subject, old.subject, level)) continue;
    // Opposite relations on the same place.
    if (
      OPPOSITE[rule.relation] === old.relation &&
      targetsOverlap(rule.target, old.target, level, usesOf)
    ) {
      // "In Bedroom" and "not in any bedroom" only clash when every room the first allows is out.
      const inR = rule.relation === 'in' ? rule : old.relation === 'in' ? old : null;
      const outR = inR === rule ? old : rule;
      if (inR) {
        const allowed = roomsOf(inR.target, level, usesOf) ?? [];
        const banned = roomsOf(outR.target, level, usesOf) ?? [];
        if (allowed.length && allowed.every((r) => banned.includes(r))) return old;
        continue;
      }
      return old;
    }
    // Against a wall, and not in either room it is a wall of.
    const pair = [rule, old];
    const against = pair.find((r) => r.relation === 'against' && r.target.kind === 'wall');
    const notIn = pair.find((r) => r.relation === 'notIn');
    if (against && notIn && against !== notIn && against.target.kind === 'wall') {
      const sides = roomsBeside(level, against.target.wallId).filter((r): r is string => !!r);
      const banned = roomsOf(notIn.target, level, usesOf) ?? [];
      if (sides.length && sides.every((r) => banned.includes(r))) return old;
    }
    // Keep the way clear, and in a room that is all way (a corridor).
    const clear = pair.find(
      (r) => (r.relation === 'keepClear' || r.relation === 'notIn') && r.target.kind === 'route',
    );
    const inside = pair.find((r) => r.relation === 'in');
    if (clear && inside && clear !== inside) {
      const rooms = roomsOf(inside.target, level, usesOf) ?? [];
      if (rooms.length && rooms.every((r) => usesOf(r).includes('corridor'))) return old;
    }
  }
  return null;
}

/** The range a number may take for a rule, with the reasons (UX §3.5). */
export interface RuleLimits {
  min: number;
  max: number;
  /** Why a number under `min` is refused, and over `max`. */
  under: string;
  over: string;
}

/**
 * What a rule's number may be: the relation's range, the flat's own width on a route, and what
 * another rule on the same subject and target leaves (the field's `validate` and vetting share it).
 */
export function ruleLimits(
  rule: Rule,
  ctx: Pick<VetCtx, 'rules' | 'level'>,
  /** The width a route's cap is measured at (it is exact near it): the number being tried. */
  probe = ruleNumber(rule) ?? ROUTE_FLOOR,
): RuleLimits | null {
  const range = numberRange(rule.relation, rule.target.kind);
  if (!range) return null;
  let { min, max } = range;
  let under =
    rule.target.kind === 'route'
      ? `At least ${m(ROUTE_FLOOR)}: the walkway check already keeps ${m(ROUTE_FLOOR)}.`
      : `At least ${m(min)}.`;
  let over = `At most ${m(max)}.`;
  if (rule.target.kind === 'route') {
    const cap = routeCap(rule.target.to, ctx.level, probe);
    if (cap && cap.width < max) {
      max = floor2(cap.width);
      over = `The way to ${cap.room} is ${m(cap.width)} wall to wall, so it can’t keep {n} clear. Use ${m(max)} or less.`;
    }
  }
  for (const other of ctx.rules) {
    if (other.deleted || other.id === rule.id) continue;
    if (stableJson(other.subject) !== stableJson(rule.subject)) continue;
    if (!sameTarget(other.target, rule.target)) continue;
    const n = ruleNumber(other);
    if (n === null) continue;
    if (rule.relation === 'within' && other.relation === 'atLeast' && n > min) {
      min = n;
      under = `That contradicts “${other.name}”: use ${m(n)} or more.`;
    }
    if (rule.relation === 'atLeast' && other.relation === 'within' && n < max) {
      max = n;
      over = `That contradicts “${other.name}”: use ${m(n)} or less.`;
    }
  }
  return { min, max, under, over };
}

/** The reason a number can't be the rule's, or null (LengthField's validate). */
export function ruleNumberProblem(
  rule: Rule,
  n: number,
  ctx: Pick<VetCtx, 'rules' | 'level'>,
): string | null {
  const lim = ruleLimits(rule, ctx, n);
  if (!lim) return null;
  if (n < lim.min - 0.005) return lim.under;
  if (n > lim.max + 0.005) return lim.over.replace('{n}', m(n));
  return null;
}

/**
 * The narrowest of a route's rooms, wall to wall (the most it can keep clear), measured near
 * `need` (the walkway check's cap: exact where the way is near or under it, else none).
 */
function routeCap(
  to: readonly string[],
  level: Level,
  need: number,
): { width: number; room: string } | null {
  const r = measureRoute(level, to, need);
  if (r.status !== 'ok') return null;
  let best: { width: number; room: string } | null = null;
  for (const p of r.perRoom) {
    if (!Number.isFinite(p.bareCap)) continue;
    if (!best || p.bareCap < best.width)
      best = { width: p.bareCap, room: level.rooms[p.roomId]?.name ?? 'a room' };
  }
  return best;
}

/** Whether a rule's ids are all on the level. */
function onLevel(rule: Rule, level: Level): boolean {
  const t = rule.target;
  if (rule.subject.kind === 'item' && !level.items[rule.subject.itemId]) return false;
  switch (t.kind) {
    case 'room':
      return !!level.rooms[t.roomId];
    case 'wall':
      return !!level.walls[t.wallId];
    case 'opening':
      return !!level.openings[t.openingId];
    case 'route':
      return t.to.every((id) => !!level.rooms[id]);
    default:
      return true;
  }
}

/** Vet a candidate rule: refused with why, or kept as it is (or with its number adjusted). */
export function vetRule(raw: unknown, ctx: VetCtx): Vet {
  const { level } = ctx;
  const usesOf = ctx.usesOf ?? ((id: string) => roomUses(level, id, { brief: ctx.brief }));
  // 1. Unfit: not the vocabulary, or about what isn't on the plan.
  const parsed = Rule.safeParse(raw);
  if (!parsed.success || !onLevel(parsed.data, level))
    return { ok: false, why: 'unfit', text: NOT_CHECKABLE };
  let rule = parsed.data;
  const live = ctx.rules.filter((r) => !r.deleted && r.id !== rule.id);
  // 2. The limit.
  if (live.length >= MAX_RULES) return { ok: false, why: 'limit', text: LIMIT_TEXT };
  // 3. The same rule.
  const n = ruleNumber(rule);
  const same = live.find(
    (r) =>
      r.relation === rule.relation &&
      stableJson(r.subject) === stableJson(rule.subject) &&
      sameTarget(r.target, rule.target) &&
      (r.relation === 'keepClear' && r.target.kind === 'route'
        ? (ruleNumber(r) ?? 0) >= (n ?? 0) - 0.005
        : Math.abs((ruleNumber(r) ?? 0) - (n ?? 0)) < 0.005),
  );
  if (same) return { ok: false, why: 'duplicate', text: 'You already have this rule.', with: same };
  // 4. Opposite rules.
  const clash = conflictOf(rule, live, level, usesOf);
  if (clash)
    return { ok: false, why: 'conflict', text: 'It contradicts a rule you have:', with: clash };
  // 5. Ranges that don't overlap.
  for (const r of live) {
    if (stableJson(r.subject) !== stableJson(rule.subject) || !sameTarget(r.target, rule.target))
      continue;
    const a = r.relation === 'within' ? r : rule.relation === 'within' ? rule : null;
    const b = r.relation === 'atLeast' ? r : rule.relation === 'atLeast' ? rule : null;
    if (!a || !b || a === b) continue;
    const d1 = ruleNumber(a) ?? 0;
    const d2 = ruleNumber(b) ?? 0;
    if (d2 > d1 + 0.005)
      return {
        ok: false,
        why: 'range',
        text: `These can’t both be met: within ${m(d1)} of ${targetOnly(a, level)}, and at least ${m(d2)} from it.`,
        with: r,
      };
  }
  // 6. HDB.
  const hdb = hdbOf(rule, level, ctx.brief, usesOf);
  if (hdb) return { ok: false, why: 'hdb', text: hdb };
  // 7. What the flat can meet.
  let adjusted: Extract<Vet, { ok: true }>['adjusted'];
  if (rule.target.kind === 'route' && entranceDoor(level)) {
    const cap = n === null ? null : routeCap(rule.target.to, level, n);
    if (cap && n !== null && n > cap.width + 0.005) {
      const to = floor2(cap.width);
      if (to < ROUTE_FLOOR)
        return {
          ok: false,
          why: 'flat',
          text: `The way to ${cap.room} is ${m(cap.width)} wall to wall, under the ${m(ROUTE_FLOOR)} any walkway needs.`,
        };
      adjusted = {
        from: n,
        to,
        why: `The way to ${cap.room} is ${m(cap.width)} wall to wall, so I’ve set ${m(to)}.`,
      };
      rule = { ...rule, n: to };
    }
  }
  if (rule.relation === 'atLeast' && n !== null) {
    const b = levelBounds(level);
    const across = b ? Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y) : 0;
    if (b && n > across)
      return {
        ok: false,
        why: 'flat',
        text: `Your home is ${m(across)} across at most, so nothing can be ${m(n)} from ${targetOnly(rule, level)}.`,
      };
  }
  // 8. A must-have ruled out.
  const needs = needsOf(rule, level, ctx.brief, usesOf);
  if (needs) return { ok: false, why: 'needs', text: needs };
  // 9. A route needs the main door.
  if (rule.target.kind === 'route' && !entranceDoor(level))
    return {
      ok: false,
      why: 'no-door',
      text: 'Mark the main door first: a rule about the way from the main door needs it.',
    };
  // A wider clear way on a route a rule already keeps clear: that rule is raised.
  let raises: Extract<Vet, { ok: true }>['raises'];
  if (rule.relation === 'keepClear' && rule.target.kind === 'route') {
    const old = live.find(
      (r) =>
        r.relation === 'keepClear' &&
        stableJson(r.subject) === stableJson(rule.subject) &&
        sameTarget(r.target, rule.target),
    );
    const was = old && ruleNumber(old);
    const now = ruleNumber(rule);
    if (old && was !== null && was !== undefined && now !== null && now > was)
      raises = { ruleId: old.id, from: was, to: roundN(now) };
  }
  const prefix = `Your rule “${rule.name}”: `;
  const planBreaks = ruleChecks([rule], { level, usesOf }).map((c) =>
    c.text.startsWith(prefix) ? c.text.slice(prefix.length).replace(/\.$/, '') : c.text,
  );
  return {
    ok: true,
    rule,
    ...(adjusted ? { adjusted } : {}),
    ...(raises ? { raises } : {}),
    planBreaks,
  };
}

/** The target's words alone ("the window"), from the sentence. */
function targetOnly(rule: Rule, level: Level): string {
  const s = ruleSentence(rule, level);
  const at = s.lastIndexOf(' of ');
  const from = s.lastIndexOf(' from ');
  const i = Math.max(at + 4, from + 6);
  return i > 6 ? s.slice(i) : s;
}

/** An HDB reason the rule can't be kept, or null. */
function hdbOf(
  rule: Rule,
  level: Level,
  brief: DesignBrief,
  usesOf: (id: string) => ProgrammeUse[],
): string | null {
  const t = rule.target;
  const shelter = (id: string | null) => !!id && SHELTER_ROOM.test(level.rooms[id]?.name ?? '');
  // Beds in the household shelter, unless the helper sleeps there.
  if (rule.relation === 'in') {
    const rooms = roomsOf(t, level, usesOf) ?? [];
    const beds = subjectsOverlap(rule.subject, { kind: 'category', category: 'beds' }, level);
    const helperThere = rooms.some((r) => (brief.sleeping?.[r] ?? []).some((k) => k === 'helper'));
    if (beds && rule.subject.kind !== 'any' && rooms.length && rooms.every(shelter) && !helperThere)
      return 'A bed can’t be in the household shelter: HDB doesn’t allow it as a bedroom.';
  }
  // Something kept right by the shelter's door, where it opens.
  if (rule.relation === 'within' && t.kind === 'opening') {
    const o = level.openings[t.openingId];
    const isShelterDoor =
      !!o && o.kind !== 'window' && roomsBeside(level, o.wallId).some((r) => shelter(r));
    if (isShelterDoor && (ruleNumber(rule) ?? 0) < Math.max(0.9, o?.width ?? 0.9) - 0.005)
      return 'The household shelter’s door must open fully: nothing can stand within 0.90 m of it.';
  }
  return null;
}

/** A must-have the rule would rule out, in the app's words, or null. */
function needsOf(
  rule: Rule,
  level: Level,
  brief: DesignBrief,
  usesOf: (id: string) => ProgrammeUse[],
): string | null {
  if (rule.relation !== 'notIn') return null;
  const rooms = roomsOf(rule.target, level, usesOf);
  if (!rooms?.length) return null;
  // Beds where someone sleeps.
  if (subjectsOverlap(rule.subject, { kind: 'category', category: 'beds' }, level)) {
    const bedrooms = Object.values(level.rooms)
      .filter((r) => usesOf(r.id).some((u) => BEDROOM_USES.has(u as RoomUse)))
      .map((r) => ({ id: r.id, area: 1 }));
    if (peopleOf(brief).length) {
      const plan = sleepingPlan(brief, bedrooms, (id) => !!level.rooms[id]);
      for (const id of rooms) {
        const who = (plan.rooms.get(id) ?? []).map((p) => p.name);
        if (who.length)
          return `${listWords(who)} ${who.length === 1 ? 'sleeps' : 'sleep'} in ${level.rooms[id]?.name ?? 'that room'}, so it needs beds. Change who sleeps where in What I know about you.`;
      }
    }
  }
  // The kitchen's sink and hob.
  const wet = ['kitchen-sink', 'kitchen-hob'].some((k) =>
    subjectsOverlap(rule.subject, { kind: 'kind', kindId: k }, level),
  );
  if (wet && rooms.some((id) => usesOf(id).includes('kitchen')))
    return 'The kitchen needs its sink and hob, so this can’t be a rule.';
  return null;
}
