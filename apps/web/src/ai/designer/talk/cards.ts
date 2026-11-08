import {
  type Change,
  type Design,
  type DesignInput,
  type DesignResult,
  type Level,
  type Project,
  type Proposal,
  type ProposalOption,
  type Rates,
  type ResultCheck,
  type Usage,
  changeSet,
  designLevels,
  levelFingerprint,
  mergeChanges,
  optionTitle,
  subsetReport,
} from '@dhd/core';
import { readResult, requestResult } from '../results';
import { designOpts, houseKeptFor, houseRulesFor } from '../state';

/**
 * A card in the conversation: a proposal's option, or a version made by v1's form ("Earlier
 * designs"). Both are shown, ticked and accepted the same way, on the plan as it is now.
 */
export interface CardModel {
  /** `proposalId:A`, or `d:designId`. */
  key: string;
  kind: 'proposal' | 'design';
  /** The level it designs (the conversation's, or the version's own). */
  levelId: string;
  n: number;
  /** "V4", or "V4B" for an alternative. */
  title: string;
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

/**
 * The card a version shows as: its proposal's option in this conversation, else its own
 * (v1's form, or a conversation since started over: under Earlier designs).
 */
export const versionKey = (d: Design, conversationId: string | null) =>
  d.from && d.from.conversationId === conversationId
    ? `${d.from.proposalId}:${d.from.letter}`
    : `d:${d.id}`;

/** Versions shown under Earlier designs: v1's, and those of a conversation started over. */
export const earlierDesign = (d: Design, conversationId: string | null) =>
  !d.from || d.from.conversationId !== conversationId;

export function optionCard(p: Proposal, o: ProposalOption, levelId: string): CardModel {
  return {
    key: cardKey(p, o.letter),
    kind: 'proposal',
    levelId,
    n: p.n,
    title: optionTitle(p.n, o.letter, p.options.length),
    // With alternatives, each is named by its own idea (the title says it on a phone, where
    // the segments show only letters).
    label: p.options.length > 1 ? o.name : p.scope.all ? 'Whole flat' : p.scope.label,
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
export function designCard(d: Design, title = `V${d.n}`): CardModel {
  const stopped = Object.values(d.spaces).some(
    (s) => s.status === 'cancelled' || s.status === 'skipped',
  );
  return {
    key: `d:${d.id}`,
    kind: 'design',
    levelId: d.levelId,
    n: d.n,
    title,
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

/**
 * The level a card is placed on and merged into, of level `levelId`: its renovation when there
 * is one, else the level as it is.
 */
export function nowOf(project: Project, levelId: string): { now: Level; before: Level } | null {
  const l = designLevels(project, levelId);
  return l ? { now: l.after ?? l.before, before: l.before } : null;
}

/**
 * A card placed on the plan as it is now, if it is ready: null while the designer's worker
 * works it out (a calm "Checking…" shows; `useResultsTick` re-renders when it lands).
 */
export function cardResult(project: Project, card: CardModel): DesignResult | null {
  const b = nowOf(project, card.levelId);
  if (!b) return null;
  return readResult(b.now, b.before, card.input, designOpts(project, card.levelId, card.at));
}

/** A card placed on the plan as it is now, waited for (an accept, a request's context). */
export async function cardResultNow(
  project: Project,
  card: CardModel,
): Promise<DesignResult | null> {
  const b = nowOf(project, card.levelId);
  if (!b) return null;
  return requestResult(b.now, b.before, card.input, designOpts(project, card.levelId, card.at));
}

const changesMemo = new Map<string, Change[]>();
/** The card's changes from the plan as it is now. */
export function cardChanges(project: Project, card: CardModel, r: DesignResult): Change[] {
  const b = nowOf(project, card.levelId);
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
  /** The household's live rules on the card's level (UX §3.7: "…and your 2 rules"). */
  rules = 0,
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
  return {
    failing,
    waived: 0,
    text: rules
      ? `Passes all checks and your ${rules === 1 ? 'rule' : `${rules} rules`}`
      : 'Passes all checks',
    tone: 'pass',
  };
}

/** A check's line after "Doesn't pass: " ("your rule “…”: …", not "Your rule"). */
export const midLine = (text: string) =>
  text.startsWith('Your rule ') ? `y${text.slice(1)}` : text;

/**
 * What accepting the ticked changes would leave failing, on `project` as it is, worked out from
 * `r` (the card's result, waited for): the hard checks those changes cause together, less the
 * ones accepted anyway, and whether any is an HDB rule. With no result it fails closed:
 * `missing`, and the accept is refused (never "nothing fails" from a check still pending).
 */
export function precheckOn(
  project: Project,
  card: CardModel,
  ticked: string[],
  waived: readonly string[],
  r: DesignResult | null,
  rates: Rates,
): { failing: ResultCheck[]; hdb: boolean; missing: boolean } {
  const b = nowOf(project, card.levelId);
  if (!b || !r) return { failing: [], hdb: false, missing: true };
  const changes = cardChanges(project, card, r);
  const merged = mergeChanges(b.now, r.level, changes, ticked);
  const rep = subsetReport(b.now, b.before, r, merged, card.input.brief, {
    rates,
    waived: [...card.waivers.map((w) => w.key), ...waived],
    renovation: !!project.renovation,
    rules: houseRulesFor(card.levelId),
    kept: houseKeptFor(card.levelId, card.at),
  });
  return { failing: rep.failing, hdb: rep.failing.some((c) => !c.waivable), missing: false };
}

/**
 * Put it back's step against the plan's history: out while it is in `past`, back in while it is
 * in `future`, and gone once trimmed from both (the history keeps 200 steps): then what it took
 * out stays as it is, and it is no longer followed.
 */
export function putBackMoves<T extends { patches: unknown; out: boolean }>(
  items: readonly T[],
  history: { past: readonly { patches: unknown }[]; future: readonly { patches: unknown }[] },
): { apply: { item: T; out: boolean }[]; gone: T[] } {
  const apply: { item: T; out: boolean }[] = [];
  const gone: T[] = [];
  for (const item of items) {
    const inPast = history.past.some((e) => e.patches === item.patches);
    const inFuture = !inPast && history.future.some((e) => e.patches === item.patches);
    if (!inPast && !inFuture) gone.push(item);
    else if (inPast !== item.out) apply.push({ item, out: inPast });
  }
  return { apply, gone };
}

/** Whether the plan the card would go on has changed since it was made. */
export const planMoved = (project: Project, card: CardModel) => {
  const b = nowOf(project, card.levelId);
  return !!b && card.status !== 'running' && levelFingerprint(b.now) !== card.madeOn;
};

/** A card's head: on a plan of several levels it names the level it designs. */
export const headLabel = (project: Project, card: CardModel) => {
  const name = project.levels.length > 1 ? designLevels(project, card.levelId)?.before.name : '';
  return name ? `${card.label} · ${name}` : card.label;
};
