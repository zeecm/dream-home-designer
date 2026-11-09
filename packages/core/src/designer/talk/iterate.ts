import { z } from 'zod';
import { Level } from '../../schema';
import { peopleOf } from '../principles';
import type { TalkAsk } from '../prompts';
import type { Design, Lock } from '../schema';
import { FACT_LABELS, factText } from './firstMeeting';
import {
  Conversation,
  DRAFT_CHARS,
  PROPOSAL_RECORD_VERSION,
  Proposal,
  type ProposalOption,
  QUESTION_KEYS,
  type ScopeRef,
  TALK_LIMITS,
  TALK_RECORD_VERSION,
  cut,
} from './schema';

/**
 * Iterating on proposals (slice 2, PR 3): alternatives A/B/C for the same rooms, Bring this
 * back, the conversation as text for the family chat, and as a file the person keeps.
 */

/** Options a proposal holds at most (A, B, C). */
export const MAX_OPTIONS = 3;
const LETTERS = ['A', 'B', 'C'] as const;

/**
 * Whether a scope gets alternatives (D3): one or two rooms. A whole-flat A/B/C would triple its
 * worst case, so the whole flat (or three rooms and more) gets one option, and "Another idea"
 * on it makes a new card.
 */
export const alternates = (scope: ScopeRef): boolean =>
  !scope.all && scope.spaces.length >= 1 && scope.spaces.length <= 2;

/** The letter Another idea adds to `p`, or null when it makes a new card instead. */
export function nextLetter(p: Proposal): 'B' | 'C' | null {
  if (!alternates(p.scope) || p.options.length >= MAX_OPTIONS) return null;
  const l = LETTERS[p.options.length];
  return l === 'B' || l === 'C' ? l : null;
}

/** An option's summary: the layout's, else its rooms' own (the designer's words). */
export function optionSummary(o: Pick<ProposalOption, 'concept' | 'spaces'>): string {
  if (o.concept?.summary) return o.concept.summary;
  return Object.values(o.spaces)
    .map((s) => s.design?.summary ?? '')
    .filter(Boolean)
    .join(' ');
}

/**
 * A 2–4 word name for an option's segment ("Sofa by the Bedroom wall"), from the designer's
 * own summary; "Idea B" until it has one.
 */
export function optionName(
  o: Pick<ProposalOption, 'concept' | 'spaces' | 'letter'>,
  fallback = `Idea ${o.letter}`,
): string {
  const first = optionSummary(o)
    .split(/[.;:!?—–(]|, /)[0]
    ?.replace(/^(I(?:’|')ve|I have|I)\s+/i, '')
    .trim();
  if (!first) return fallback;
  // Up to four words that say something ("Sofa on the long wall"), at most five in all, never
  // ending on a little word ("by", "the").
  const out: string[] = [];
  let said = 0;
  for (const w of first.split(/\s+/)) {
    if (said >= 4 || out.length >= 5) break;
    out.push(w);
    if (!LITTLE.has(w.toLowerCase())) said++;
  }
  while (out.length > 1 && LITTLE.has((out[out.length - 1] ?? '').toLowerCase())) out.pop();
  const words = out.join(' ');
  return cut(words.charAt(0).toUpperCase() + words.slice(1), TALK_LIMITS.name);
}
const LITTLE = new Set(
  'a an the on by of to in at for with and or from near facing under over'.split(' '),
);

/** What Another idea is for, in a run's talk block. */
export const ANOTHER_INTENT =
  'Another idea for the same rooms, clearly different from the options already proposed.';

/**
 * What Another idea asks the designer for (a run's talk block): a different idea for the same
 * rooms; the person's words as theirs, and the options so far, in the designer's own words, on
 * a line of their own.
 */
export function anotherAsk(p: Proposal, said: string, decided: string[]): TalkAsk {
  return {
    intent: ANOTHER_INTENT,
    said: cut(said, DRAFT_CHARS),
    decided,
    others: p.options.map((o) => `${o.letter}: ${cut(optionSummary(o) || optionName(o), 300)}`),
  };
}

/** "V4", or "V4B" when the proposal has alternatives. */
export const optionTitle = (n: number, letter: string, options: number) =>
  options > 1 ? `V${n}${letter}` : `V${n}`;

/** What is brought back: a proposal's option, or a version (an accepted one, or v1's). */
export type BringSource =
  | { kind: 'option'; proposal: Proposal; option: ProposalOption }
  | { kind: 'design'; design: Design };

/**
 * The proposal Bring this back makes (tech §4.5): the old option's design, numbered next, on
 * today's brief, nothing ticked or accepted yet, its waivers carried by check key (they are
 * evaluated again on the plan as it is). No request: no usage.
 */
export function broughtBack(
  src: BringSource,
  a: {
    id: string;
    designId: string;
    n: number;
    at: string;
    turnId: string;
    conversationId: string;
    brief: ProposalOption['brief'];
    base: ProposalOption['base'];
    /**
     * What the person changed by hand since (`hand-edit` locks, as a fresh proposal gets them):
     * kept as the plan has them, never removed or moved unless the person unlocks them. They
     * take the place of the old option's own, which were about the plan as it was then.
     */
    held?: Lock[];
    /** The kept pieces it is made with, now (slice 3a): on its record, as a new option's. */
    kept?: ProposalOption['kept'];
  },
): Proposal {
  const from =
    src.kind === 'option'
      ? {
          projectId: src.proposal.projectId,
          scope: src.proposal.scope,
          words: src.proposal.words,
          name: src.option.name,
          aliases: src.option.aliases,
          concept: src.option.concept,
          spaces: src.option.spaces,
          locks: src.option.locks,
          waivers: src.option.waivers,
        }
      : {
          projectId: src.design.projectId,
          scope: designScope(src.design),
          words: src.design.request.feedback,
          name: src.design.concept?.name ?? src.design.name,
          aliases: src.design.aliases,
          concept: src.design.concept,
          spaces: src.design.spaces,
          locks: src.design.request.locks,
          waivers: src.design.waivers ?? [],
        };
  const option: ProposalOption = structuredClone({
    letter: 'A',
    // Made now, with what is kept now (not the old version's set).
    madeAt: a.at,
    ...(a.kept ? { kept: a.kept } : {}),
    name: cut(from.name, TALK_LIMITS.name),
    designId: a.designId,
    brief: a.brief,
    aliases: from.aliases,
    concept: from.concept,
    spaces: from.spaces,
    locks: [...from.locks.filter((l) => l.by !== 'hand-edit'), ...(a.held ?? [])],
    usage: [],
    base: a.base,
    status: 'checked',
    ticks: null,
    accepted: [],
    note: null,
    waivers: from.waivers,
    version: null,
  });
  return {
    projectId: from.projectId,
    id: a.id,
    conversationId: a.conversationId,
    recordVersion: PROPOSAL_RECORD_VERSION,
    n: a.n,
    turnId: a.turnId,
    at: a.at,
    scope: structuredClone(from.scope),
    words: cut(from.words, DRAFT_CHARS),
    options: [option],
  };
}

/** The scope a version was asked for, in a proposal's terms. */
function designScope(d: Design): ScopeRef {
  const done = Object.entries(d.spaces).filter(([, s]) => s.status === 'done');
  if (d.request.scope.kind === 'all' || done.length !== 1)
    return { label: 'Whole flat', spaces: [], all: true };
  const [key, s] = done[0] as [string, { name: string }];
  return { label: cut(s.name, TALK_LIMITS.label), spaces: [key], all: false };
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Copy as text (UX §11): the decisions, What I know, the accepted changes room by room (with
 * the renovation's cost, when the app has it) and the notes for the ID, in plain text for the
 * family chat. Never a key, a price table or the messages themselves.
 */
export function conversationText(
  conv: Conversation,
  proposals: Proposal[],
  level: Level,
  opts: { cost?: string | null; title?: string } = {},
): { text: string; decisions: number; changes: number } {
  const out: string[] = [opts.title ? `${opts.title}: the designer` : 'The designer'];
  const decisions = conv.decisions.filter((d) => !d.deleted);
  out.push('', 'Decisions');
  if (decisions.length) for (const d of decisions) out.push(`- ${d.text}`);
  else out.push('- Nothing decided yet.');
  out.push('', 'What I know about you');
  const b = conv.brief;
  for (const k of QUESTION_KEYS) {
    if (k === 'mobility' && !b.household.elders.length) continue;
    if (k === 'sleeping' && !peopleOf(b).some((p) => p.kind !== 'helper')) continue;
    // How much they own is never asked in the first meeting: Typical until it is said.
    const assumed =
      conv.assumed.includes(k) || (k === 'owns' && b.owns === undefined) ? ' (assumed)' : '';
    out.push(`- ${FACT_LABELS[k]}: ${factText(k, b, level)}${assumed}`);
  }
  // Accepted rows still in the renovation, room by room, in the order they were accepted.
  const rooms = new Map<string, string[]>();
  for (const p of [...proposals].sort((x, y) => x.n - y.n)) {
    for (const o of p.options) {
      for (const a of o.accepted) {
        if (a.out) continue;
        const list = rooms.get(a.groupName) ?? [];
        if (!list.includes(a.text)) list.push(a.text);
        rooms.set(a.groupName, list);
      }
    }
  }
  const changes = [...rooms.values()].reduce((t, l) => t + l.length, 0);
  out.push('', 'Accepted changes');
  if (!changes) out.push('- None yet.');
  for (const [room, list] of rooms) {
    out.push(`${room}:`);
    for (const t of list) out.push(`- ${t}`);
  }
  if (opts.cost) out.push(`Renovation cost: ${opts.cost}`);
  out.push('', 'Notes for your ID');
  if (conv.notes.length) for (const n of conv.notes) out.push(`- ${n.text}`);
  else out.push('- None.');
  return { text: out.join('\n'), decisions: decisions.length, changes };
}

/** "Copied: 6 decisions and 14 accepted changes." */
export const copiedLine = (r: { decisions: number; changes: number }) =>
  `Copied: ${count(r.decisions, 'decision')} and ${count(r.changes, 'accepted change')}.`;

/** The conversation as a file (Download conversation): checked by the records' own schema. */
export const ConversationExport = z.object({
  kind: z.literal('dhd-designer-conversation'),
  version: z.literal(TALK_RECORD_VERSION),
  exportedAt: z.string(),
  conversation: Conversation,
  proposals: z.array(Proposal),
  /** The levels the proposals were made on, by fingerprint. */
  levels: z.record(Level),
});
export type ConversationExport = z.infer<typeof ConversationExport>;

/** The file's contents: the records as kept (no key, no prices), with the levels they name. */
export function conversationExport(
  conv: Conversation,
  proposals: Proposal[],
  levels: Record<string, Level>,
  at: string,
): ConversationExport {
  const used = new Set([
    conv.start.beforeFp,
    ...(conv.start.afterFp ? [conv.start.afterFp] : []),
    ...proposals.flatMap((p) => p.options.map((o) => o.base.fingerprint)),
  ]);
  return ConversationExport.parse({
    kind: 'dhd-designer-conversation',
    version: TALK_RECORD_VERSION,
    exportedAt: at,
    conversation: conv,
    proposals,
    levels: Object.fromEntries(Object.entries(levels).filter(([fp]) => used.has(fp))),
  });
}
