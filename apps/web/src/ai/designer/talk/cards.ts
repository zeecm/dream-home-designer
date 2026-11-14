import {
  type AliasMap,
  type Change,
  type Design,
  type DesignInput,
  type DesignResult,
  type Kept,
  type LensReport,
  type Level,
  type Project,
  type Proposal,
  type ProposalOption,
  type Rates,
  type ResultCheck,
  type RunReport,
  type Usage,
  cardPieces,
  changeSet,
  checkRoomOf,
  designLevels,
  isDeclined,
  levelFingerprint,
  mergeChanges,
  optionTitle,
  runReport,
  subsetReport,
} from '@dhd/core';
import { readLens, readResult, requestResult } from '../results';
import { type MadeWith, designOpts, houseKeptFor, houseRulesFor } from '../state';
import { useTalk } from './useTalk';

/**
 * A report worked out on a plan, shown only for that plan: one for an older plan (the card's
 * result before the run's end, or before a tick) is never shown as this one's (QA: the Cost row
 * said "No renovation work" while the app's bed was ticked, until it caught up).
 */
export function reportFor<T>(worked: { on: unknown; rep: T } | null, on: unknown): T | null {
  return worked && on !== null && worked.on === on ? worked.rep : null;
}

/** Pieces the person left out before (Decisions at Accept): never offered again there. */
export function declinedPieces(): { room: string; role: string }[] {
  const ds = useTalk.getState().conv?.decisions ?? [];
  return ds.flatMap((d) => (!d.deleted && d.free ? [d.free] : []));
}

/**
 * The must-have checks the person chose (they left the app's bed out of that room at an Accept:
 * a Decision): theirs, never counted as failing nor asked about, said as "Left out by you".
 */
export function chosenChecks(
  r: DesignResult,
  declined: readonly { room: string; role: string }[] = declinedPieces(),
): ResultCheck[] {
  return declined.length ? r.checks.filter((c) => c.hard && isChosen(c, declined)) : [];
}

/** Whether a check is a must-have the person left out of its room (`chosenChecks`). */
export const isChosen = (
  c: { key: string; roomId?: string; itemId?: string },
  declined: readonly { room: string; role: string }[],
) => !c.itemId && !!c.roomId && isDeclined(c.key, c.roomId, declined);

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
  /** The kept pieces it was made with (on its record); absent on older ones. */
  kept?: readonly Kept[];
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
    // An alternative is placed with what was kept when it was asked for.
    at: o.madeAt ?? p.at,
    ...(o.kept ? { kept: o.kept } : {}),
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
    ...(d.kept ? { kept: d.kept } : {}),
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

/** What a card's version was made with, for its kept pieces (its record's set, else its time). */
export const madeWith = (card: Pick<CardModel, 'kept' | 'at'>): MadeWith =>
  card.kept ? { kept: card.kept } : card.at;

/**
 * A card placed on the plan as it is now, if it is ready: null while the designer's worker
 * works it out (a calm "Checking…" shows; `useResultsTick` re-renders when it lands).
 */
export function cardResult(project: Project, card: CardModel): DesignResult | null {
  const b = nowOf(project, card.levelId);
  if (!b) return null;
  return readResult(b.now, b.before, card.input, designOpts(project, card.levelId, madeWith(card)));
}

/**
 * A card's lens lines (the storage meter, for the household it designs for) on the plan as it
 * is now: null while the worker works them out.
 */
export function cardLens(project: Project, card: CardModel): LensReport[] | null {
  const b = nowOf(project, card.levelId);
  if (!b) return null;
  return readLens(b.now, b.before, card.input, designOpts(project, card.levelId, madeWith(card)));
}

/** A card placed on the plan as it is now, waited for (an accept, a request's context). */
export async function cardResultNow(
  project: Project,
  card: CardModel,
): Promise<DesignResult | null> {
  const b = nowOf(project, card.levelId);
  if (!b) return null;
  return requestResult(
    b.now,
    b.before,
    card.input,
    designOpts(project, card.levelId, madeWith(card)),
  );
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

/** Whether a check is about this card: a room's own, or a piece one of its changes moves. */
export const inCardOf =
  (changes: readonly Change[]) =>
  (c: { itemId?: string }): boolean =>
    !c.itemId ||
    changes.some(
      (x) => x.items.target.includes(c.itemId ?? '') || x.items.now.includes(c.itemId ?? ''),
    );

/**
 * The card's run report (spec docs/specs/designer-listens.md, UX "One list, one count"): what
 * the version fails in its scope, less what is accepted anyway, one line a failure as the person
 * reads it, with the pieces it left out and its fix rounds. The one list and the one count for
 * the card's lead and Checks row, the On the table bar, the folded line, the option tabs, the
 * announcement and the talk call. What a set of ticks fails together beyond it is the card's
 * own line under Checks (`tickedExtra`), never part of the count.
 */
export function cardRunReport(
  card: CardModel,
  r: DesignResult,
  changes: readonly Change[],
  o: { waive?: readonly string[]; aliases?: AliasMap } = {},
): RunReport {
  const scope = card.proposal?.scope;
  const rooms = new Set(scope?.spaces.flatMap((k) => k.split('+')) ?? []);
  const spaces =
    !scope || scope.all
      ? undefined
      : r.spaces.filter((s) => s.rooms.some((id) => rooms.has(id))).map((s) => s.key);
  // Stopped part-way: the rooms it never placed are said as such ("Stopped before …"), never
  // also counted as failing for want of what they would have held.
  const unplaced =
    card.status === 'stopped'
      ? new Set(
          r.spaces
            .filter((s) => !['done', 'copied', 'locked'].includes(s.status))
            .flatMap((s) => s.rooms),
        )
      : null;
  const inCard = inCardOf(changes);
  return runReport(r, card.input, {
    waived: [
      ...card.waivers.map((w) => w.key),
      ...(o.waive ?? []),
      ...chosenChecks(r).map((c) => c.key),
    ],
    inScope: unplaced ? (c) => inCard(c) && !unplaced.has(checkRoomOf(r, c) ?? '') : inCard,
    ...(spaces ? { spaces } : {}),
    aliases: o.aliases ?? card.input.aliases,
  });
}

/**
 * What the ticked changes fail together that the version itself doesn't (unticking a wall and
 * keeping what needs it): said under the Checks row, and asked about at Accept.
 */
export function tickedExtra(
  rep: RunReport,
  subset: readonly ResultCheck[],
  waived: readonly string[],
): ResultCheck[] {
  const counted = new Set(rep.failures.flatMap((f) => f.keys));
  const w = new Set(waived);
  return subset.filter((c) => !counted.has(c.key) && !w.has(c.key));
}

/** A card's run report on the plan as it is now, waited for (the talk call, the announcement). */
export async function cardReportNow(
  project: Project,
  card: CardModel,
  aliases?: AliasMap,
): Promise<{ r: DesignResult; changes: Change[]; report: RunReport } | null> {
  const r = await cardResultNow(project, card);
  if (!r) return null;
  const changes = cardChanges(project, card, r);
  return { r, changes, report: cardRunReport(card, r, changes, aliases ? { aliases } : {}) };
}

/** A check's line after "Doesn't pass: "("your rule “…”: …", not "Your rule"). */
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
    kept: houseKeptFor(card.levelId, madeWith(card)),
    // A must-have of the card's rows the ticks leave unmet is asked about.
    mustHaves: cardPieces(changes),
  });
  // Never one the person left out themselves (a Decision): theirs, not asked about again.
  const declined = declinedPieces();
  const failing = rep.failing.filter((c) => !isChosen(c, declined));
  return { failing, hdb: failing.some((c) => !c.waivable), missing: false };
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
