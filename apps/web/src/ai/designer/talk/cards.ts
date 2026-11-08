import {
  type Change,
  type Design,
  type DesignInput,
  type DesignResult,
  type Level,
  type Project,
  type Proposal,
  type ProposalOption,
  type Usage,
  changeSet,
  levelFingerprint,
} from '@dhd/core';
import { readResult, requestResult } from '../results';
import { designOpts } from '../state';

/**
 * A card in the conversation: a proposal's option, or a version made by v1's form ("Earlier
 * designs"). Both are shown, ticked and accepted the same way, on the plan as it is now.
 */
export interface CardModel {
  /** `proposalId:A`, or `d:designId`. */
  key: string;
  kind: 'proposal' | 'design';
  n: number;
  /** "Living and dining", "Whole flat". */
  label: string;
  input: DesignInput;
  usage: Usage[];
  waivers: { key: string; text: string; at: string }[];
  ticks: string[] | null;
  accepted: ProposalOption['accepted'];
  status: ProposalOption['status'];
  note: string | null;
  words: string;
  at: string;
  /** The fingerprint of the level it was made on. */
  madeOn: string;
  proposal?: Proposal;
  option?: ProposalOption;
  design?: Design;
}

export const cardKey = (p: Proposal, letter: string) => `${p.id}:${letter}`;

export function optionCard(p: Proposal, o: ProposalOption): CardModel {
  return {
    key: cardKey(p, o.letter),
    kind: 'proposal',
    n: p.n,
    label: p.scope.all ? 'Whole flat' : p.scope.label,
    input: {
      id: o.designId,
      brief: o.brief,
      aliases: o.aliases,
      concept: o.concept,
      spaces: o.spaces,
      request: { locks: o.locks },
    },
    usage: o.usage,
    waivers: o.waivers,
    ticks: o.ticks,
    accepted: o.accepted,
    status: o.status,
    note: o.note,
    words: p.words,
    at: p.at,
    madeOn: o.base.fingerprint,
    proposal: p,
    option: o,
  };
}

/** A version v1's form made, as a card (its accepts happened in v1's Accept dialog). */
export function designCard(d: Design): CardModel {
  const stopped = Object.values(d.spaces).some(
    (s) => s.status === 'cancelled' || s.status === 'skipped',
  );
  return {
    key: `d:${d.id}`,
    kind: 'design',
    n: d.n,
    label: d.concept?.name ?? d.name,
    input: d,
    usage: d.usage,
    waivers: d.waivers ?? [],
    ticks: null,
    accepted: [],
    status: stopped ? 'stopped' : 'checked',
    note: null,
    words: d.request.feedback,
    at: d.createdAt,
    madeOn: d.base.fingerprint,
    design: d,
  };
}

/** The plan a card is placed on and merged into: After when there is one, else the flat. */
export function nowOf(project: Project): { now: Level; before: Level } | null {
  const before = project.levels[0];
  if (!before) return null;
  return { now: project.renovation?.levels[0] ?? before, before };
}

/**
 * A card placed on the plan as it is now, if it is ready: null while the designer's worker
 * works it out (a calm "Checking…" shows; `useResultsTick` re-renders when it lands).
 */
export function cardResult(project: Project, card: CardModel): DesignResult | null {
  const b = nowOf(project);
  if (!b) return null;
  return readResult(b.now, b.before, card.input, designOpts(project));
}

/** A card placed on the plan as it is now, waited for (an accept, a request's context). */
export async function cardResultNow(
  project: Project,
  card: CardModel,
): Promise<DesignResult | null> {
  const b = nowOf(project);
  if (!b) return null;
  return requestResult(b.now, b.before, card.input, designOpts(project));
}

const changesMemo = new Map<string, Change[]>();
/** The card's changes from the plan as it is now. */
export function cardChanges(project: Project, card: CardModel, r: DesignResult): Change[] {
  const b = nowOf(project);
  if (!b) return [];
  const inAlready = card.accepted.filter((a) => !a.out).map((a) => a.id);
  const key = `${card.key}|${levelFingerprint(b.now)}|${levelFingerprint(r.level)}|${inAlready.join(',')}`;
  const hit = changesMemo.get(key);
  if (hit) return hit;
  const out = cardScope(changeSet(b.now, r, card.input), card, inAlready);
  changesMemo.set(key, out);
  if (changesMemo.size > 12) changesMemo.delete(changesMemo.keys().next().value as string);
  return out;
}

/**
 * A card's changes, from the plan as it is now: only in the scope it was asked for (a Kitchen
 * proposal never re-proposes the living room it copied from the version before), and never
 * one already accepted from it (another tab's accept, a stale plan).
 */
export function cardScope(
  changes: Change[],
  card: CardModel,
  accepted: readonly string[],
): Change[] {
  const scope = card.proposal?.scope;
  // Walls and room names belong to the proposal whatever its scope; furniture and finishes only
  // to the spaces it was asked about.
  // A space is its rooms joined by `+`: after a merge or a split since the proposal, a group
  // is in scope when any of its rooms is.
  const rooms = new Set(scope?.spaces.flatMap((k) => k.split('+')) ?? []);
  const inScope = (c: Change) =>
    !scope ||
    scope.all ||
    c.group === 'walls' ||
    c.group === 'names' ||
    c.group.split('+').some((r) => rooms.has(r));
  const done = new Set(accepted);
  return changes.filter((c) => inScope(c) && !done.has(c.id));
}

/**
 * The card's one verdict (the Checks line, On the table, the folded line): every hard check the
 * proposal fails that isn't waived, whether its row is ticked or not, and any the ticked
 * changes fail together; then those accepted anyway.
 */
export function cardVerdict(
  open: readonly { key: string }[],
  subset: readonly { key: string }[],
  waived: readonly string[],
): { failing: string[]; waived: number; text: string; tone: 'pass' | 'waived' | 'fail' } {
  const w = new Set(waived);
  const failing = [...new Set([...open, ...subset].map((c) => c.key))].filter((k) => !w.has(k));
  const n = failing.length;
  if (n)
    return {
      failing,
      waived: w.size,
      text: `${n} ${n === 1 ? 'doesn’t' : 'don’t'} pass`,
      tone: 'fail',
    };
  if (w.size) return { failing, waived: w.size, text: `${w.size} accepted anyway`, tone: 'waived' };
  return { failing, waived: 0, text: 'Passes all checks', tone: 'pass' };
}

/** Whether the plan the card would go on has changed since it was made. */
export const planMoved = (project: Project, card: CardModel) => {
  const b = nowOf(project);
  return !!b && card.status !== 'running' && levelFingerprint(b.now) !== card.madeOn;
};

/** A card's head: on a plan of several levels it names the level it designs (the first). */
export const headLabel = (project: Project, card: CardModel) =>
  project.levels.length > 1 && project.levels[0]?.name
    ? `${card.label} · ${project.levels[0].name}`
    : card.label;
