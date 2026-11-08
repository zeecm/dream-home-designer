import { z } from 'zod';
import { Vec2 } from '../../schema';
import { RoomUse } from '../schema';

/**
 * A house rule (slice 3a): something the household wants to always hold, as data the app
 * compiles into a hard check. The model only fills it in; the app checks it, says it in its own
 * words (`ruleSentence`) and refuses one that can't hold (`vetRule`) before it is kept. Closed:
 * a subject, a relation, a target and a number, so a new wording needs no code.
 */

export const RULE_RELATIONS = [
  'notIn',
  'in',
  'faces',
  'notFaces',
  'within',
  'atLeast',
  'against',
  'keepClear',
] as const;
export type RuleRelation = (typeof RULE_RELATIONS)[number];

/** Kinds of piece a rule may be about as a group. */
export const CATEGORIES = [
  'tall',
  'storage',
  'seating',
  'beds',
  'tables',
  'lighting',
  'plants',
] as const;
export type RuleCategory = (typeof CATEGORIES)[number];

export const TARGET_KINDS = [
  'room',
  'roomUse',
  'wall',
  'opening',
  'ownDoor',
  'window',
  'kind',
  'route',
  'spot',
] as const;
export type RuleTargetKind = (typeof TARGET_KINDS)[number];

export const RuleSubject = z.discriminatedUnion('kind', [
  /** Nothing / anything standing on the floor. */
  z.object({ kind: z.literal('any') }),
  z.object({ kind: z.literal('category'), category: z.enum(CATEGORIES) }),
  /** A catalogue id ("sofa-3") or a role ("sofa"). */
  z.object({ kind: z.literal('kind'), kindId: z.string().min(1).max(40) }),
  /** One piece in the plan, by its id (pieces in proposals are said by their kind). */
  z.object({ kind: z.literal('item'), itemId: z.string().min(1).max(40) }),
]);
export type RuleSubject = z.infer<typeof RuleSubject>;

export const RuleTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('room'), roomId: z.string().min(1) }),
  z.object({ kind: z.literal('roomUse'), use: RoomUse }),
  z.object({ kind: z.literal('wall'), wallId: z.string().min(1) }),
  z.object({ kind: z.literal('opening'), openingId: z.string().min(1) }),
  z.object({ kind: z.literal('ownDoor') }),
  z.object({ kind: z.literal('window') }),
  z.object({ kind: z.literal('kind'), kindId: z.string().min(1).max(40) }),
  /** The way from the main door to these rooms (a corridor is never a word: it is a route). */
  z.object({
    kind: z.literal('route'),
    from: z.literal('main-door'),
    to: z.array(z.string().min(1)).min(1).max(8),
  }),
  z.object({ kind: z.literal('spot'), at: Vec2, r: z.number().min(0.2).max(3) }),
]);
export type RuleTarget = z.infer<typeof RuleTarget>;

/** Rules a home keeps at most (UX §11.8). */
export const MAX_RULES = 20;
/** A clear width kept along a route is never under the walkway check's own minimum. */
export const ROUTE_FLOOR = 0.6;
/** The default clear width of a route ("nothing in the way"). */
export const ROUTE_WIDTH = 0.9;
/** How far off a piece may turn and still face something (P2's widest, 30°). */
export const FACE_ANGLE = 30;
/** A piece's back this close to a face is against it (P2's backs onto). */
export const AGAINST_GAP = 0.05;

/** The targets each relation can have (UX §3.3 b: anything else can't be checked). */
export const FITS: Record<RuleRelation, readonly RuleTargetKind[]> = {
  notIn: ['room', 'roomUse', 'route', 'spot'],
  in: ['room', 'roomUse'],
  faces: ['opening', 'ownDoor', 'window', 'kind', 'wall'],
  notFaces: ['opening', 'ownDoor', 'window', 'kind', 'wall'],
  within: ['opening', 'ownDoor', 'window', 'kind', 'wall', 'spot'],
  atLeast: ['opening', 'ownDoor', 'window', 'kind', 'wall', 'spot'],
  against: ['wall', 'window', 'kind'],
  keepClear: ['route', 'spot', 'opening'],
};

/**
 * The number a rule takes, and its range (metres): null where it takes none. The same limits
 * the offer's fields refuse with (UX §3.5).
 */
export function numberRange(
  relation: RuleRelation,
  target: RuleTargetKind,
): { min: number; max: number; what: string; default: number | null } | null {
  if (relation === 'within' || relation === 'atLeast')
    return { min: 0.1, max: 10, what: 'Distance', default: null };
  if (relation === 'keepClear' && target === 'route')
    return { min: ROUTE_FLOOR, max: 3, what: 'Clear width', default: ROUTE_WIDTH };
  if (relation === 'keepClear' && target === 'opening')
    return { min: 0.3, max: 2, what: 'Clear in front', default: 0.9 };
  if (relation === 'notIn' && target === 'route')
    return { min: ROUTE_FLOOR, max: 3, what: 'Clear width', default: ROUTE_WIDTH };
  return null;
}

const RuleBase = z.object({
  id: z.string().min(1),
  /** The person's words, editable (UX §3.2). */
  name: z.string().min(1).max(80),
  subject: RuleSubject,
  relation: z.enum(RULE_RELATIONS),
  target: RuleTarget,
  /** Metres: the distance (within, atLeast) or the clear width (keepClear, a route); else null. */
  n: z.number().min(0).max(20).nullable(),
  /** The level it is about. */
  levelId: z.string(),
  at: z.string(),
  /** Where it was kept from: the designer's reply turn, and the version on the table then. */
  from: z.object({ turnId: z.string(), version: z.string().max(8).nullable() }),
  deleted: z.boolean().default(false),
});

/** Why a rule doesn't fit the vocabulary, or null (the matrix and the numbers). */
export function unfitOf(r: z.infer<typeof RuleBase>): string | null {
  if (!FITS[r.relation].includes(r.target.kind)) return 'that relation can’t have that target';
  if (r.subject.kind === 'any' && r.relation !== 'notIn' && r.relation !== 'keepClear')
    return 'only “nothing in …” or “keep … clear” can be about anything';
  const range = numberRange(r.relation, r.target.kind);
  if (!range) return null;
  if (r.n === null) return range.default === null ? 'it needs a number' : null;
  if (r.n < range.min - 1e-9 || r.n > range.max + 1e-9)
    return `${range.what.toLowerCase()} must be ${range.min.toFixed(2)}–${range.max.toFixed(2)} m`;
  return null;
}

export const Rule = RuleBase.superRefine((r, ctx) => {
  const why = unfitOf(r);
  if (why) ctx.addIssue({ code: z.ZodIssueCode.custom, message: why });
});
export type Rule = z.infer<typeof Rule>;

/** The number a rule is checked with: its own, else the default its relation has. */
export const ruleNumber = (r: Pick<Rule, 'relation' | 'target' | 'n'>): number | null =>
  r.n ?? numberRange(r.relation, r.target.kind)?.default ?? null;

/** A rule's number to the cent, as kept. */
export const roundN = (n: number) => Math.round(n * 100) / 100;
