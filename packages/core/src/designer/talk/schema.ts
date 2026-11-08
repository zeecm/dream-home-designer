import { z } from 'zod';
import { Concept, DesignBrief, Lock, SpaceDesign, SpaceStatus, Usage } from '../schema';
import { clean } from '../util';

/**
 * The conversation with the designer (spec docs/specs/ai-designer-v2.md, slice 2): what was
 * said, what the app asked and was told, the proposals on the table and what was accepted of
 * them. Kept in this browser (IndexedDB `dhd-talk`), never in the project, an export, a share
 * link or a request to our server, and never with a key or a price table. Records carry their
 * own version and are checked on the way back in.
 */

export const TALK_RECORD_VERSION = 1;
/** Turns kept in one conversation; the oldest go first. */
export const MAX_TURNS = 500;
/** Decisions kept, and how long each may be. */
export const MAX_DECISIONS = 40;
export const DECISION_CHARS = 160;
/** The composer's limit, and when its counter shows. */
export const DRAFT_CHARS = 2000;

/**
 * How long each text of a record may be. Every text is cut to these where it is made (`cut`),
 * so one long answer or room name never makes a record unreadable.
 */
export const TALK_LIMITS = {
  label: 80,
  words: 400,
  note: 400,
  person: DRAFT_CHARS + 200,
  designer: 2000,
  line: 300,
  after: 400,
  lead: 300,
  name: 60,
  row: 300,
  left: 80,
} as const;

/** A text cut to `max` (control characters out, an ellipsis where it was cut). */
export const cut = (s: string, max: number) => clean(s, max);

/** As `cut`, keeping the person's line breaks (at most one blank line between paragraphs). */
export const cutLines = (s: string, max: number) => {
  const lines = s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => clean(l, max));
  const t = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** The app's own first-meeting questions (UX §8.3), each a fact What I know holds. */
export const QUESTION_KEYS = [
  'who',
  'sleeping',
  'mobility',
  'cooking',
  'wfh',
  'budget',
  'walls',
  'style',
  'anything',
] as const;
export const QuestionKey = z.enum(QUESTION_KEYS);
export type QuestionKey = z.infer<typeof QuestionKey>;

/** What a proposal is about: the whole flat, or some spaces (by key), in words. */
export const ScopeRef = z.object({
  label: z.string().max(TALK_LIMITS.label),
  /** Space keys; empty with `all`. */
  spaces: z.array(z.string()).max(30),
  all: z.boolean(),
});
export type ScopeRef = z.infer<typeof ScopeRef>;

export const Decision = z.object({
  id: z.string(),
  kind: z.enum(['rejected', 'keep', 'wish', 'waiver']),
  text: z.string().max(DECISION_CHARS),
  at: z.string(),
  /** The proposal it came from ("V4"), when it did. */
  from: z.string().max(12).nullable(),
  deleted: z.boolean().default(false),
});
export type Decision = z.infer<typeof Decision>;

/** An app line in the log (UX §6.6). */
export const TalkEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('accepted'),
    proposalId: z.string(),
    n: z.number().int(),
    letter: z.string().max(1),
    /** The change ids accepted. */
    changes: z.array(z.string()),
    /** How many changes the option had in all, and the names of those left out. */
    total: z.number().int().min(0),
    left: z.array(z.string().max(TALK_LIMITS.left)).max(20),
    /** Undone since (the line then offers Redo). */
    undone: z.boolean().default(false),
  }),
  z.object({ type: z.literal('stopped'), usd: z.number().min(0).nullable() }),
  z.object({ type: z.literal('note'), text: z.string().max(TALK_LIMITS.note) }),
  z.object({
    type: z.literal('fact'),
    key: QuestionKey,
    text: z.string().max(TALK_LIMITS.note),
  }),
]);
export type TalkEvent = z.infer<typeof TalkEvent>;

const base = { id: z.string(), at: z.string() };

export const Turn = z.discriminatedUnion('kind', [
  /** What the person said or chose, in words. */
  z.object({ ...base, kind: z.literal('person'), text: z.string().max(TALK_LIMITS.person) }),
  /**
   * The designer's words. In this slice every one is the app's own (the greeting, the
   * assumptions), so `lines` are its bullets; a model's reply comes with the talk call.
   */
  z.object({
    ...base,
    kind: z.literal('designer'),
    text: z.string().max(TALK_LIMITS.designer),
    lines: z.array(z.string().max(TALK_LIMITS.line)).max(12).default([]),
    /** The last line, after the bullets ("These are in What I know about you…"). */
    after: z.string().max(TALK_LIMITS.after).default(''),
  }),
  /** One message of the app's own questions, 1–3 of them, each answered or skipped on its own. */
  z.object({
    ...base,
    kind: z.literal('app-question'),
    lead: z.string().max(TALK_LIMITS.lead).nullable(),
    keys: z.array(QuestionKey).min(1).max(3),
    /** Each question once answered (its answer in words), skipped, or assumed by Just design it. */
    done: z
      .record(
        z.object({
          state: z.enum(['answered', 'skipped', 'assumed']),
          words: z.string().max(TALK_LIMITS.words),
        }),
      )
      .default({}),
  }),
  /** "Where shall we start?": the priced scope buttons (their prices are worked out live). */
  z.object({ ...base, kind: z.literal('scope'), next: z.boolean().default(false) }),
  /** A cost card before a design run (UX §9.4). */
  z.object({
    ...base,
    kind: z.literal('cost-ask'),
    scope: ScopeRef,
    /** The person's words that go with it. */
    words: z.string().max(DRAFT_CHARS),
    /** Why it asks: the tab's first run, a dear one, the limit, or the reply threshold. */
    reason: z.enum(['ask-threshold', 'ask-cost-check', 'ask-limit']),
    /** What the card showed (US$), bound by Go ahead; null without a price. */
    estimate: z
      .object({ typical: z.number().min(0), high: z.number().min(0), fix: z.number().min(0) })
      .nullable(),
    state: z.enum(['open', 'go', 'cheaper', 'not-now', 'expired']),
    /** The answer's id: only the call that answered it starts the run (two tabs). */
    answerId: z.string().nullable().default(null),
    /** A stopped proposal's missing rooms ("Design Kitchen too"), rather than a new one. */
    finish: z
      .object({
        proposalId: z.string(),
        letter: z.string().max(1),
        rooms: z.array(z.string()).max(30),
      })
      .nullable()
      .default(null),
  }),
  z.object({ ...base, kind: z.literal('proposal'), proposalId: z.string() }),
  z.object({ ...base, kind: z.literal('event'), event: TalkEvent }),
]);
export type Turn = z.infer<typeof Turn>;
export type TurnKind = Turn['kind'];
export type TurnOf<K extends TurnKind> = Extract<Turn, { kind: K }>;

export const Conversation = z.object({
  projectId: z.string(),
  id: z.string(),
  recordVersion: z.literal(TALK_RECORD_VERSION),
  /** Bumped by every write, so another tab knows to read it again. */
  rev: z.number().int().min(0),
  startedAt: z.string(),
  /** The level it designs (the flat as it is). */
  levelId: z.string(),
  /** "My plan before the designer": the levels as they were, by fingerprint in `levels`. */
  start: z.object({ at: z.string(), beforeFp: z.string(), afterFp: z.string().nullable() }),
  /** What I know about you. */
  brief: DesignBrief,
  /** Facts the app assumed (Just design it, Skip): marked "Assumed" until confirmed or changed. */
  assumed: z.array(QuestionKey).default([]),
  /** Facts a form told before the first meeting: not asked again. */
  known: z.array(QuestionKey).default([]),
  /** The next proposal's number: one sequence with the plan's versions (V1, V4, V7). */
  nextN: z.number().int().positive(),
  decisions: z
    .array(Decision)
    .max(MAX_DECISIONS * 2)
    .default([]),
  turns: z.array(Turn).max(MAX_TURNS),
  /** The composer, kept across closes and reloads. */
  draft: z.string().max(DRAFT_CHARS).default(''),
});
export type Conversation = z.infer<typeof Conversation>;

/** One option (A, B, C) of a proposal: a version as the runner builds it, not yet a version. */
export const ProposalOption = z.object({
  letter: z.enum(['A', 'B', 'C']),
  name: z.string().max(TALK_LIMITS.name),
  /** The id its pieces are seeded with, and its version's id once accepted. */
  designId: z.string(),
  brief: DesignBrief,
  aliases: z.record(z.string()),
  concept: Concept.nullable(),
  spaces: z.record(
    z.object({
      name: z.string(),
      status: SpaceStatus,
      design: SpaceDesign.optional(),
      error: z.string().optional(),
      fixes: z.number().int().min(0).optional(),
      fixed: z.number().int().min(0).optional(),
    }),
  ),
  /** Locks it was asked with (hand edits kept, parts kept by the person). */
  locks: z.array(Lock),
  usage: z.array(Usage),
  /** The level it was designed on, by fingerprint in `levels`, and which one it was. */
  base: z.object({ variant: z.enum(['before', 'after']), fingerprint: z.string() }),
  status: z.enum(['running', 'checked', 'stopped', 'failed']),
  /** Change ids ticked; null: as the card ticks them first (all that pass). */
  ticks: z.array(z.string()).nullable(),
  /**
   * Rows accepted so far (across accepts), as they read: once in the plan they are no longer
   * a change from it. `out`: undone since.
   */
  accepted: z
    .array(
      z.object({
        id: z.string(),
        text: z.string().max(TALK_LIMITS.row),
        group: z.string(),
        groupName: z.string().max(TALK_LIMITS.label),
        event: z.string(),
        out: z.boolean().default(false),
      }),
    )
    .default([]),
  /** Why the run ended early, in the app's words ("Couldn’t reach Claude, even after…"). */
  note: z.string().max(300).nullable().default(null),
  waivers: z.array(z.object({ key: z.string(), text: z.string(), at: z.string() })).default([]),
  /** The version made by its first accept. */
  version: z.string().nullable().default(null),
});
export type ProposalOption = z.infer<typeof ProposalOption>;

export const Proposal = z.object({
  projectId: z.string(),
  id: z.string(),
  conversationId: z.string(),
  recordVersion: z.literal(TALK_RECORD_VERSION),
  n: z.number().int().positive(),
  turnId: z.string(),
  at: z.string(),
  scope: ScopeRef,
  /** The person's words it was made with. */
  words: z.string().max(DRAFT_CHARS),
  options: z.array(ProposalOption).min(1).max(3),
});
export type Proposal = z.infer<typeof Proposal>;

/** A conversation read back from storage: checked, or null when it can't be used. */
export function conversationFromRecord(raw: unknown): Conversation | null {
  const rec = raw as { recordVersion?: unknown } | null;
  if (!rec || typeof rec !== 'object') return null;
  if (typeof rec.recordVersion === 'number' && rec.recordVersion > TALK_RECORD_VERSION) return null;
  const r = Conversation.safeParse(raw);
  return r.success ? r.data : null;
}

export function proposalFromRecord(raw: unknown): Proposal | null {
  const rec = raw as { recordVersion?: unknown } | null;
  if (!rec || typeof rec !== 'object') return null;
  if (typeof rec.recordVersion === 'number' && rec.recordVersion > TALK_RECORD_VERSION) return null;
  const r = Proposal.safeParse(raw);
  return r.success ? r.data : null;
}
