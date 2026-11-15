import { type StepKind, type StepState, blankStep, interruptText, runDesign } from '@dhd/ai';
import {
  type Conversation,
  DRAFT_CHARS,
  type DraftDesign,
  type OptionLook,
  PROPOSAL_RECORD_VERSION,
  type PlanAddress,
  type Proposal,
  type ProposalOption,
  type RunCheckpoint,
  type RunEstimate,
  type RunPlan,
  type ScopePlan,
  type ScopeRef,
  TALK_LIMITS,
  type TalkAction,
  type TalkAsk,
  type TalkPlan,
  type TurnOf,
  anotherAsk,
  askRule,
  atMostOf,
  costFigure,
  cut,
  entranceDoor,
  firstAndMore,
  levelFingerprint,
  liveRules,
  lookNote,
  lookRuleOffer,
  looksAt,
  nextLetter,
  notMetText,
  optionName,
  optionTitle,
  planScope,
  readyLine,
  ruleSentence,
  scopeCut,
} from '@dhd/core';
import { meterSetting } from '../../../storage/store';
import { useStore } from '../../../store';
import { aiSettings } from '../../credentials';
import { rasterise } from '../look';
import { browserPage } from '../page';
import { freshPrice, readPrice, trialFree, trialResult } from '../results';
import {
  addUsage,
  cannotDesign,
  capUsd,
  countRun,
  overLimit,
  priceTable,
  spent,
  usd,
} from '../spend';
import { type MadeWith, type Running, designOpts, houseKeptFor, useDesigner } from '../state';
import { cardReportNow, optionCard } from './cards';
import { declinedPieces, freePlacedWords } from './free';
import {
  type PriceInput,
  type Priced,
  approvedLeft,
  figureHolds,
  finishedSpace,
  fixRoomsOf,
  lookAtEnd,
  resumeFigure,
  spentWithInflight,
  stepHigh,
} from './pricing';
import { dependsNow, notMetOf, repeatFor } from './repeat';
import { type RunHold, takeRunLock } from './runLock';
import { cardHeadIntoView, logFollowing } from './scroll';
import { talkStore } from './talkStore';
import { threshold } from './threshold';
import { timeLeft, timeLeftMark } from './timeLeft';
import {
  act,
  actProposal,
  clearTyped,
  designLevelId,
  levelGone,
  newId,
  nowIso,
  rulesOn,
  say,
  talkLevel,
  talkLevels,
  typedNow,
  useTalk,
} from './useTalk';
import { holdScreen } from './wakeLock';

/**
 * A design run from the conversation: a scope button ("Living and dining · about US$0.20"),
 * Another idea, Go ahead on a cost card, or "Design Kitchen too". Every priced press goes the
 * same way: priced, run at once or asked first (askRule), one at a time from the first tap.
 * The runner is slice 1's, unchanged; what it saves goes into the proposal (not a version:
 * only an accept makes one). The person's words in the composer go with a new proposal.
 */

const doc = () => useStore.getState().editor.doc;

/** What a priced press asks for: a new proposal for a scope, or a stopped one's missing rooms. */
export interface PressRequest {
  scope: ScopeRef;
  words: string;
  finish: { proposalId: string; letter: string; rooms: string[] } | null;
  /** From a designer's plan: what it is for, the household's words, the decisions. */
  talk?: TalkAsk;
  /** The designer's name for it ("A console by the door"). */
  title?: string;
  /** Another idea as the next option (B, C) of a proposal, for the same rooms. */
  alternative?: { proposalId: string; letter: 'B' | 'C' };
  /** What the designer's plan said it fixes (its `addresses`): kept on the option it makes. */
  addresses?: PlanAddress[];
}

/** The house rules on the level designed, as the app says them. */
const ruleWords = () => {
  const level = talkLevel();
  return level ? rulesOn(designLevelId()).map((r) => ruleSentence(r, level)) : [];
};

/** The decisions as a run's talk block carries them. */
const decided = () =>
  (useTalk.getState().conv?.decisions ?? []).filter((d) => !d.deleted).map((d) => d.text);

/**
 * A pushback's alternative as a run asks for it (P2-2): the designer's own suggestion is what it
 * is for; the person's words, which asked for what was pushed back on, don't go with it.
 */
export const altRequest = (plan: TalkPlan): PressRequest => ({
  scope: plan.scope,
  words: '',
  finish: null,
  title: plan.title,
  talk: { intent: plan.intent, said: '', decided: decided() },
});

/** A designer's plan (or a concern's alternative) as a run asks for it. */
export const planRequest = (plan: TalkPlan, said: string, scope?: ScopeRef): PressRequest => ({
  scope: scope ?? plan.scope,
  words: said,
  finish: null,
  talk: { intent: plan.intent, said, decided: decided() },
  ...(plan.addresses?.length ? { addresses: plan.addresses } : {}),
});

/** The plan a designer's reply made (a cost card's `talk.replyTo`), for its `addresses`. */
const replyPlan = (turnId: string): TalkPlan | null => {
  const t = useTalk.getState().conv?.turns.find((x) => x.id === turnId);
  return t?.kind === 'designer' ? (t.talk?.plan ?? null) : null;
};

/** What pricing a request needs, as plain data (what the worker is sent). */
function priceInput(req: PressRequest, designId: string): Omit<PriceInput, 'designs'> | null {
  const conv = useTalk.getState().conv;
  const ai = aiSettings();
  if (!conv || !ai || cannotDesign(ai) || levelGone()) return null;
  const project = doc();
  let finish: PriceInput['finish'];
  // What it is placed with: a new design's kept pieces now; finishing an option, its own.
  let made: MadeWith = 'new';
  if (req.finish) {
    const f = req.finish;
    const p = useTalk.getState().proposals.find((x) => x.id === f.proposalId);
    const o = p?.options.find((x) => x.letter === f.letter);
    if (!p || !o) return null;
    finish = { option: o, rooms: f.rooms, words: p.words, scope: p.scope };
    made = madeOf(p, f.letter);
  }
  // Another idea asks for something different from the options so far, with the person's words.
  const alt = req.alternative;
  const of = alt && useTalk.getState().proposals.find((x) => x.id === alt.proposalId);
  if (alt && !of) return null;
  // The person's words (this time's, else the card's) go as theirs; the options so far as the
  // designer's own, on a line of their own.
  const words = of ? req.words || of.words : req.words;
  const asked = of && !req.talk ? anotherAsk(of, words, decided()) : req.talk;
  // The house rules go with what the run is for, in the app's words (slice 3a).
  const rules = ruleWords();
  const talk = !rules.length
    ? asked
    : asked
      ? { ...asked, rules }
      : // A scope button asks with no words: the rules go all the same.
        { intent: '', said: '', decided: [], rules };
  return {
    project,
    levelId: designLevelId(),
    brief: conv.brief,
    scope: req.scope,
    words,
    ...(talk ? { talk } : {}),
    ...(finish ? { finish } : {}),
    designId,
    // Priced before the version exists: every kept piece goes in.
    opts: designOpts(project, designLevelId(), made),
    ai: { provider: ai.provider, model: ai.model },
    prices: priceTable(),
    ...(declinedPieces().length ? { declined: declinedPieces() } : {}),
  };
}

/** What a shown price is kept by: the plan, what is asked, the brief, the versions, the prices. */
function priceKey(req: PressRequest): string | null {
  const conv = useTalk.getState().conv;
  const ai = aiSettings();
  if (!conv || !ai) return null;
  const levels = talkLevels();
  const designs = useDesigner.getState().designs;
  return JSON.stringify([
    ai.model,
    priceTable()[ai.model] ?? null,
    conv.brief,
    req,
    designLevelId(),
    levels ? levelFingerprint(levels.before) : null,
    levels?.after ? levelFingerprint(levels.after) : null,
    // The storage meter's setting: the room steps' storage block (and the results) read it.
    meterSetting(doc().id),
    // What the person left out (the room steps are told).
    declinedPieces(),
    designs.map((d) => [d.id, d.accepted?.at ?? null]),
    useTalk
      .getState()
      .proposals.find((x) => x.id === req.finish?.proposalId)
      ?.options.map((o) => o.usage.length) ?? null,
  ]);
}

/**
 * The plan and price of a request, worked out afresh in the worker on the plan as it is now:
 * what a press goes ahead with (never a price shown earlier).
 */
async function planOf(req: PressRequest, designId: string): Promise<Priced> {
  const input = priceInput(req, designId);
  return input ? freshPrice(input).catch(() => null) : null;
}

/** A request's price for its button or card: null while it is worked out, or when it can't be. */
export const pressPrice = (req: PressRequest): RunEstimate | null => pressPriceState(req).est;

/**
 * The figure a request's button last showed (its most), by request: a press compares the
 * price now with it when the button's own cached price has gone meanwhile (replaced or
 * evicted by what the press itself changed), rather than asking as if it had risen.
 */
const lastShown = new Map<string, number>();
const requestKey = (req: PressRequest) => JSON.stringify({ ...req, words: '' });

/** The price and whether it is still being worked out (a skeleton shows meanwhile). */
export function pressPriceState(req: PressRequest): { est: RunEstimate | null; pending: boolean } {
  const key = priceKey(req);
  if (!key) return { est: null, pending: false };
  const v = readPrice(key, () => priceInput(req, 'dsn_est'));
  const most = v?.est ? atMostOf(v.est) : null;
  if (most !== null) {
    const k = requestKey(req);
    lastShown.delete(k);
    lastShown.set(k, most);
    if (lastShown.size > 50) lastShown.delete(lastShown.keys().next().value as string);
  }
  return { est: v?.est ?? null, pending: v === undefined };
}

/** A scope button's request (without the person's words: they add little to its price). */
export const scopeRequest = (scope: ScopeRef): PressRequest => ({ scope, words: '', finish: null });

/** A scope's price for its button (without the person's words: they add little). */
export const scopePrice = (scope: ScopeRef): RunEstimate | null =>
  pressPrice({ scope, words: '', finish: null });

const finishRequest = (p: Proposal, letter: string, rooms: string[]): PressRequest => {
  const o = p.options.find((x) => x.letter === letter);
  const names = rooms.map((k) => o?.spaces[k]?.name ?? 'a room').join(', ');
  return {
    scope: { label: cut(`${names} too`, TALK_LIMITS.label), spaces: rooms, all: false },
    words: '',
    finish: { proposalId: p.id, letter, rooms },
  };
};

/** The price of the rooms a stopped option lacks. */
export const finishPrice = (p: Proposal, letter: string, rooms: string[]) =>
  pressPrice(finishRequest(p, letter, rooms));

/**
 * Keep fixing's price input (B2): the option's rooms whose fix-ups ran out with failures left,
 * fix rounds only, into the same option, placed with what it was made with.
 */
function keepFixingInput(
  p: Proposal,
  letter: string,
  designId?: string,
): Omit<PriceInput, 'designs'> | null {
  const conv = useTalk.getState().conv;
  const ai = aiSettings();
  const o = p.options.find((x) => x.letter === letter);
  if (!conv || !ai || cannotDesign(ai) || levelGone() || !o || !fixRoomsOf(o).length) return null;
  const project = doc();
  return {
    project,
    levelId: designLevelId(),
    brief: conv.brief,
    scope: p.scope,
    words: '',
    keepFixing: { option: o, words: p.words, scope: p.scope },
    designId: designId ?? o.designId,
    opts: designOpts(project, designLevelId(), madeOf(p, letter)),
    ai: { provider: ai.provider, model: ai.model },
    prices: priceTable(),
    ...(declinedPieces().length ? { declined: declinedPieces() } : {}),
  };
}

/** What Keep fixing's shown price is kept by: the option as it is, the plan, the prices. */
function keepFixingKey(p: Proposal, letter: string): string | null {
  const ai = aiSettings();
  const o = p.options.find((x) => x.letter === letter);
  const levels = talkLevels();
  if (!ai || !o) return null;
  return JSON.stringify([
    'keep-fixing',
    p.id,
    letter,
    ai.model,
    priceTable()[ai.model] ?? null,
    o.usage.length,
    fixRoomsOf(o),
    levels ? levelFingerprint(levels.before) : null,
    levels?.after ? levelFingerprint(levels.after) : null,
    meterSetting(doc().id),
    declinedPieces(),
  ]);
}

/**
 * Keep fixing's price for its button and its cost card: its rooms' fix rounds, the pool the
 * quality gives that many rooms at the dearest fix request (null while worked out, or none).
 */
export function keepFixingPrice(
  p: Proposal,
  letter: string,
): { est: RunEstimate | null; pending: boolean } {
  const key = keepFixingKey(p, letter);
  if (!key) return { est: null, pending: false };
  const v = readPrice(key, () => keepFixingInput(p, letter));
  return { est: v?.est ?? null, pending: v === undefined };
}

/**
 * Keep fixing (B2), from its cost card's confirm (always asked): a fix-only run on the same
 * option, bound to the figure the card showed. Priced higher since: the new figure (the card
 * shows it and asks again); nothing to fix or nothing priced: 'no'.
 */
export async function keepFixing(
  p: Proposal,
  letter: string,
  shown: number | null,
): Promise<'started' | 'no' | { dearer: number }> {
  if (!begin()) return 'no';
  try {
    const input = keepFixingInput(p, letter);
    const made = input ? await freshPrice(input).catch(() => null) : null;
    if (!made || doc().id !== p.projectId) return 'no';
    const now = atMostOf(made.est);
    // Never on a figure it wasn't shown at (no price at all, or a higher one).
    if (shown === null || now === null) return 'no';
    if (!figureHolds(shown, now)) return { dearer: now };
    const sp: ScopePlan = {
      ...made.sp,
      draft: structuredClone(made.sp.draft),
      plan: structuredClone(made.sp.plan),
      locks: structuredClone(made.sp.locks),
    };
    const q = await actProposal(p.id, (x) =>
      x
        ? {
            ...x,
            options: x.options.map((y) =>
              // Its figure is now Keep fixing's: "Couldn't make everything pass within US$x"
              // says the latest one (money review N2).
              y.letter === letter
                ? { ...y, status: 'running' as const, note: null, approved: shown }
                : y,
            ),
          }
        : x,
    );
    if (!q || doc().id !== p.projectId) return 'no';
    useTalk.setState({ shown: `${p.id}:${letter}`, open: null, why: null });
    useDesigner.setState({ previewing: true });
    say(
      `Fixing ${optionTitle(q.n, letter, q.options.length)} again, up to ${made.est.fixes} more fix-ups.`,
    );
    void runOption(q, letter, sp, made.est, shown);
    return 'started';
  } finally {
    end();
  }
}

/** What a cost card keeps of an estimate: its figure and its words from one value (QA). */
export const figureOf = (est: RunEstimate) =>
  costFigure(est, useTalk.getState().conv?.brief.quality ?? 'thorough');

/** One priced press at a time, from the first tap (a double tap starts one run). */
let starting = false;
function begin(): boolean {
  if (starting || useDesigner.getState().run || useTalk.getState().reply) return false;
  // Its level gone from the plan: nothing runs (the panel says why).
  if (levelGone()) return false;
  starting = true;
  useDesigner.setState({ starting: true });
  return true;
}
function end() {
  starting = false;
  useDesigner.setState({ starting: false });
}

/**
 * A priced button was pressed (a scope, Another idea): the person's words go with a new
 * proposal. It runs at once unless a cost rule applies, when a cost card asks first (UX §9.4).
 */
export async function pressScope(scope: ScopeRef, words?: string) {
  if (!begin()) return;
  try {
    await askOrRun({ scope, words: words ?? typedNow(), finish: null });
  } finally {
    end();
  }
}

/** "Design Kitchen too": the rooms a stopped option lacks, priced and asked like any press. */
export async function finishRooms(p: Proposal, letter: string, rooms: string[]) {
  if (!begin()) return;
  try {
    await askOrRun(finishRequest(p, letter, rooms));
  } finally {
    end();
  }
}

/** A priced button that runs a designer's idea (a concern's alternative), priced as shown. */
export async function pressPlan(plan: TalkPlan) {
  if (!begin()) return;
  try {
    await askOrRun(altRequest(plan));
  } finally {
    end();
  }
}

/**
 * The run after a designer's plan (tech §2.5): priced here, free; it runs at once unless a rule
 * applies (the per-reply threshold too, now that no price was shown yet), else its cost card
 * asks with Go ahead, Just {room} and Not now.
 */
export async function followPlan(plan: TalkPlan, said: string, replyTo: string) {
  // A run going on (or starting): the plan is never dropped; its card asks for later.
  const started = begin();
  try {
    const req = planRequest(plan, said);
    const made = await planOf(req, newId('dsn'));
    if (!made) {
      await act({
        type: 'event',
        id: newId('turn'),
        at: nowIso(),
        event: { type: 'note', text: 'Couldn’t work out what the designer’s plan would cost.' },
      });
      return;
    }
    const ask = rule(made.est, false);
    // The same failures again, nothing changed, the plan addressing nothing new: it always asks
    // (designer listens §5), even under the threshold. It only ever adds an ask.
    const repeat = await repeatFor(
      req.scope,
      (plan.addresses ?? []).map((a) => a.sig),
    ).catch(() => null);
    // Strict turned on by a reply (no figure seen yet): this run asks once (money review S1).
    const strict = strictOwed();
    if (ask === 'go' && started && !repeat && !strict) {
      await run(req, made, atMostOf(made.est), { person: null, turn: newId('turn') });
      return;
    }
    await act({
      type: 'ask',
      at: nowIso(),
      ids: [newId('turn'), newId('turn')],
      scope: req.scope,
      words: said,
      reason: ask === 'go' ? 'ask-threshold' : ask,
      estimate: figureOf(made.est),
      talk: { replyTo, title: plan.title, intent: plan.intent },
      just: plan.just,
      ...(repeat ? { repeat } : {}),
      ...(strict ? { strict } : {}),
    });
  } finally {
    if (started) end();
  }
}

/**
 * Fix every check first was turned on by a designer's reply, on the person's word but with no
 * figure seen: the next run asks once whatever the threshold (money review S1), then the usual
 * rules apply. Only ever adds an ask.
 */
const strictOwed = () => {
  const c = useTalk.getState().conv;
  return !!c?.strictAsk && !!c.brief.fixAll;
};

const rule = (est: RunEstimate, pressedPriced: boolean) =>
  askRule(est, {
    spentTab: spent().usd,
    cap: capUsd(),
    threshold: threshold(),
    designRunsThisTab: spent().runs,
    pressedPriced,
  });

async function askOrRun(req: PressRequest) {
  // The button's price (priced without the person's words), then the price now, in full: a
  // press never goes ahead on a stale or missing one; it asks with the cost card instead.
  // The figure the button showed: its cached price, or (gone meanwhile) the last it showed.
  const shown = pressPrice({ ...req, words: '' });
  const remembered = shown ? undefined : lastShown.get(requestKey(req));
  const was = shown ? atMostOf(shown) : (remembered ?? null);
  const made = await planOf(req, newId('dsn'));
  if (!made) return;
  const now = atMostOf(made.est);
  // The money rule, unchanged: no figure shown, or one that has risen, asks.
  const dearer =
    (!shown && remembered === undefined) || (was !== null && now !== null && now > was + 0.005);
  // The rule's own card first (the tab's first run, the limit); dearer only stops a go.
  const ruled = rule(made.est, true);
  const ask = ruled === 'go' && dearer ? 'ask-threshold' : ruled;
  // A new design of a scope that failed the same way twice, nothing changed (§5): it asks.
  // Never for the rooms a stopped option lacks or another idea (those ask for something new).
  const repeat =
    !req.finish && !req.alternative
      ? await repeatFor(
          req.scope,
          (req.addresses ?? []).map((a) => a.sig),
        ).catch(() => null)
      : null;
  const strict = strictOwed();
  if (ask === 'go' && !repeat && !strict) {
    await run(req, made, atMostOf(made.est), { person: newId('turn'), turn: newId('turn') });
    return;
  }
  await act({
    type: 'ask',
    at: nowIso(),
    ids: [newId('turn'), newId('turn')],
    scope: req.scope,
    words: req.words,
    reason: ask === 'go' ? 'ask-threshold' : ask,
    estimate: figureOf(made.est),
    finish: req.finish,
    alt: req.alternative ?? null,
    ...(repeat ? { repeat } : {}),
    ...(strict ? { strict } : {}),
    // A designer's idea keeps what it is for through its card (P2-2).
    ...(req.talk
      ? {
          talk: { replyTo: '', title: req.title ?? req.scope.label, intent: req.talk.intent },
          just: null,
        }
      : {}),
  });
  if (!req.finish && !req.talk) await clearTyped();
}

/** The request a cost card stands for (or its cheaper room). */
export const cardRequest = (card: TurnOf<'cost-ask'>, cheaper?: ScopeRef): PressRequest =>
  card.finish
    ? { scope: card.scope, words: '', finish: card.finish }
    : {
        scope: cheaper ?? card.scope,
        words: card.words,
        finish: null,
        ...(card.talk
          ? { talk: { intent: card.talk.intent, said: card.words, decided: decided() } }
          : {}),
        ...(card.talk?.replyTo && replyPlan(card.talk.replyTo)?.addresses?.length
          ? { addresses: replyPlan(card.talk.replyTo)?.addresses }
          : {}),
        // Another idea's card: the option it adds (the cheaper room is a new card of its own).
        ...(card.alt && !cheaper ? { alternative: card.alt } : {}),
      };

/**
 * The answer to a cost card: Go ahead, Just {room}, or Not now. Go ahead binds the figure the
 * card showed: if the price has gone up since, the card shows the new one and asks again. Only
 * the call that answered the card (in the record as read, so not another tab) starts the run.
 */
export async function answerCost(
  card: TurnOf<'cost-ask'>,
  answer: 'go' | 'cheaper' | 'not-now',
  cheaper?: ScopeRef,
) {
  if (!begin()) return;
  try {
    const req = cardRequest(card, answer === 'cheaper' ? cheaper : undefined);
    const made = answer === 'not-now' ? null : await planOf(req, newId('dsn'));
    if (answer !== 'not-now' && !made) return;
    const shown = card.estimate ? card.estimate.high + card.estimate.fix : null;
    const fresh = made ? atMostOf(made.est) : null;
    if (answer === 'go' && shown !== null && fresh !== null && fresh > shown + 0.005) {
      await act({
        type: 'costRefresh',
        turnId: card.id,
        estimate: made ? figureOf(made.est) : null,
      });
      say('The price has gone up since; check it again before going ahead.');
      return;
    }
    const mine = newId('turn');
    const conv = await act({ type: 'costAnswer', turnId: card.id, answer, at: nowIso(), id: mine });
    const t = conv?.turns.find((x) => x.id === card.id);
    if (!made || t?.kind !== 'cost-ask' || t.answerId !== mine) return;
    // Go ahead: the most the card showed; the cheaper room: what its button showed.
    const approved = answer === 'go' && shown !== null ? shown : fresh;
    await run(req, made, approved, { person: null, turn: newId('turn') });
  } finally {
    end();
  }
}

/** Starts a request's run: a new proposal (its record and turn), or the stopped one again. */
async function run(
  req: PressRequest,
  made: { sp: ScopePlan; est: RunEstimate },
  approved: number | null,
  ids: { person: string | null; turn: string },
) {
  const conv = useTalk.getState().conv;
  if (!conv) return;
  // The plan it was priced on: another opened meanwhile, it runs nowhere (each await below).
  const planId = doc().id;
  const here = () => doc().id === planId;
  // The runner works on its own copies, never on what the store holds.
  const sp: ScopePlan = {
    ...made.sp,
    draft: structuredClone(made.sp.draft),
    plan: structuredClone(made.sp.plan),
    locks: structuredClone(made.sp.locks),
  };
  if (req.finish) {
    const { proposalId, letter } = req.finish;
    const p = await actProposal(proposalId, (x) =>
      x
        ? {
            ...x,
            options: x.options.map((y) =>
              y.letter === letter ? { ...y, status: 'running' as const, note: null } : y,
            ),
          }
        : x,
    );
    if (p && here()) void runOption(p, letter, sp, made.est, approved);
    return;
  }
  const project = doc();
  const s = await talkStore();
  const fp = await s.putLevel(project.id, sp.ctx.base);
  if (!here()) return;
  if (req.alternative) {
    const { proposalId, letter } = req.alternative;
    const option = newOption(letter, req.scope, sp, fp, req.addresses, approved);
    // Only the letter it was priced as: another tab may have added it meanwhile.
    const p = await actProposal(proposalId, (x) =>
      x && nextLetter(x) === letter ? { ...x, options: [...x.options, option] } : null,
    );
    if (!p?.options.some((o) => o.letter === letter && o.designId === option.designId)) {
      // Another tab added this letter first: nothing runs here, and the log says why.
      await act({
        type: 'event',
        id: newId('turn'),
        at: nowIso(),
        event: { type: 'note', text: `Another tab is already making option ${letter}.` },
      });
      return;
    }
    if (ids.person) await clearTyped();
    if (!here()) return;
    useTalk.setState({ shown: `${proposalId}:${letter}`, open: null, why: null });
    useDesigner.setState({ previewing: true });
    say(`Designing V${p.n}${letter}, another idea for ${p.scope.label}.`);
    void runOption(p, letter, sp, made.est, approved);
    return;
  }
  const proposalId = newId('prop');
  const scope = scopeCut(req.scope);
  const words = cut(req.words, DRAFT_CHARS);
  const option = newOption('A', scope, sp, fp, req.addresses, approved);
  const proposal: Proposal = {
    projectId: project.id,
    id: proposalId,
    conversationId: conv.id,
    recordVersion: PROPOSAL_RECORD_VERSION,
    n: conv.nextN,
    turnId: ids.turn,
    at: nowIso(),
    scope,
    words,
    options: [structuredClone(option)],
  };
  await actProposal(proposalId, () => proposal);
  const after = await act({ type: 'propose', at: nowIso(), ids, proposalId, scope, words });
  // Its number is the one the record gave it (another tab may have taken this one meanwhile).
  const p = await numbered(proposal, after);
  if (ids.person) await clearTyped();
  if (!here()) return;
  // Every new proposal goes on the plan (after an accept the stage had gone back to After).
  useTalk.setState({ shown: `${proposalId}:A`, open: null, why: null });
  useDesigner.setState({ previewing: true });
  say(`Designing V${p.n}, ${option.name}.`);
  void runOption(p, 'A', sp, made.est, approved);
}

/**
 * A new proposal with the number its turn took in the record (the action that added it took
 * the next one, read in its own transaction), patched when this tab's mirror was behind.
 */
export async function numbered(p: Proposal, conv: Conversation | null): Promise<Proposal> {
  const n = conv ? conv.nextN - 1 : p.n;
  if (n === p.n || n < 1) return p;
  return (await actProposal(p.id, (x) => (x ? { ...x, n } : x))) ?? { ...p, n };
}

/** An option as its run starts (its rooms saved into it as they come). */
function newOption(
  letter: ProposalOption['letter'],
  scope: ScopeRef,
  sp: ScopePlan,
  fp: string,
  addresses?: PlanAddress[],
  approved: number | null = null,
): ProposalOption {
  return {
    letter,
    ...(addresses?.length ? { addresses: structuredClone(addresses) } : {}),
    // What it is asked on (§5's "nothing changed"), and the figure it was approved for.
    depends: dependsNow(),
    approved,
    madeAt: nowIso(),
    // The kept pieces it is made with, on its record (read so whatever changes after).
    kept: [...houseKeptFor(designLevelId(), 'new')],
    name: cut(
      letter === 'A' ? (scope.all ? 'Whole flat' : scope.label) : `Idea ${letter}`,
      TALK_LIMITS.name,
    ),
    designId: sp.draft.id,
    brief: sp.brief,
    aliases: sp.draft.aliases,
    concept: sp.draft.concept,
    spaces: sp.draft.spaces,
    locks: sp.locks,
    usage: [],
    base: { variant: sp.ctx.variant, fingerprint: fp },
    status: 'running',
    ticks: null,
    accepted: [],
    waivers: [],
    version: null,
    look: null,
    note: null,
  };
}

/**
 * Another idea (UX §7.4): for one or two rooms, the next option (B, then C) of the same card;
 * for the whole flat, or once C is there, a new card. Priced and asked like any press.
 */
export async function pressAnother(p: Proposal) {
  if (!nextLetter(p)) {
    await pressScope(p.scope);
    return;
  }
  if (!begin()) return;
  try {
    await askOrRun({ ...anotherRequest(p), words: typedNow() });
  } finally {
    end();
  }
}

/** Another idea's request: the next option of `p`, or a new card for its scope. */
const anotherRequest = (p: Proposal): PressRequest => {
  const letter = nextLetter(p);
  return {
    scope: p.scope,
    words: '',
    finish: null,
    ...(letter ? { alternative: { proposalId: p.id, letter } } : {}),
  };
};

/** Another idea's price for its button (what its press compares with). */
export const anotherPrice = (p: Proposal): RunEstimate | null => pressPrice(anotherRequest(p));

const cutNote = (s: string | null) => (s ? cut(s, 300) : null);

/**
 * The second look's suggested house rules, vetted as a reply's rule is (slice 3a's `vetRule`
 * through `lookRuleOffer`) on the plan as it is now: each becomes the designer's line with the
 * free Keep as a rule offer under it; one the app can't hold as a rule stays a note on the card.
 */
function lookOffersOf(
  look: OptionLook | null,
  p: Proposal,
  letter: string,
  design: DraftDesign,
): { look: OptionLook | null; offers: Extract<TalkAction, { type: 'lookOffer' }>[] } {
  const conv = useTalk.getState().conv;
  const level = talkLevel();
  if (!look?.offers.length || !conv || !level) return { look, offers: [] };
  const version = optionTitle(p.n, letter, p.options.length);
  const notes = [...look.notes];
  const offers: Extract<TalkAction, { type: 'lookOffer' }>[] = [];
  let rules = liveRules(conv);
  for (const o of look.offers) {
    const id = newId('turn');
    const offer = lookRuleOffer(o.rule, {
      id: newId('rule'),
      at: nowIso(),
      turnId: id,
      version,
      levelId: conv.levelId,
      rules,
      level,
      brief: conv.brief,
      aliases: design.aliases,
      mainDoor: entranceDoor(level),
    });
    if (!offer) {
      notes.push(lookNote(o.line));
      continue;
    }
    // Two alike in one look: the second is vetted against the first.
    rules = [...rules, offer.rule];
    offers.push({
      type: 'lookOffer',
      id,
      at: nowIso(),
      replyTo: p.turnId,
      version,
      line: o.line,
      offer,
    });
  }
  return { look: { ...look, notes: [...new Set(notes)].slice(0, 12) }, offers };
}

/** A run carried on from its checkpoint: its lock already held here. */
interface CarryFrom {
  run: RunCheckpoint;
  hold: RunHold;
}

/** Hooks the resume module sets (it imports this one): a run here was interrupted. */
export const runHooks: { interrupted: () => void } = { interrupted: () => {} };

/** Rooms a checkpoint has finished, and how many it designs (null: not known yet). */
export function roomsDone(
  o: ProposalOption,
  run: RunCheckpoint,
): { done: number; total: number | null } {
  const rooms = run.rooms;
  if (!rooms) return { done: 0, total: null };
  return { done: rooms.filter((k) => finishedSpace(o.spaces[k])).length, total: rooms.length };
}

/** "3 of 5 rooms done" (or the layout, when no room is known yet). */
export function doneText(d: { done: number; total: number | null }): string {
  return d.total === null ? 'the layout is sent again' : `${d.done} of ${d.total} rooms done`;
}

/** The plan and price of carrying an interrupted option on, on the plan as it is now. */
export async function resumePriced(p: Proposal, letter: string): Promise<Priced> {
  const o = p.options.find((x) => x.letter === letter);
  const conv = useTalk.getState().conv;
  const ai = aiSettings();
  if (!o?.run || !conv || !ai || cannotDesign(ai) || levelGone()) return null;
  const project = doc();
  return freshPrice({
    project,
    levelId: designLevelId(),
    brief: conv.brief,
    scope: p.scope,
    words: '',
    resume: { option: o, run: o.run, scope: p.scope },
    designId: o.designId,
    // Priced as it runs: on the conversation's level, with what it was made with.
    opts: designOpts(project, designLevelId(), o.kept ? { kept: o.kept } : (o.madeAt ?? p.at)),
    ai: { provider: ai.provider, model: ai.model },
    prices: priceTable(),
  }).catch(() => null);
}

/**
 * Carries an interrupted option on from its checkpoint (its lock held here): by itself
 * (`press` null: within the figure it was approved for) or on Carry on, bound to the figure
 * its button showed ('dearer': priced higher since, nothing started; null: not priced).
 */
export async function carryOn(
  p: Proposal,
  letter: string,
  hold: RunHold,
  press: { shown: number | null } | null,
): Promise<'started' | 'dearer' | 'no'> {
  if (!begin()) return 'no';
  try {
    const o = p.options.find((x) => x.letter === letter);
    const run = o?.run;
    if (!o || !run) return 'no';
    // Still this plan, and still its run's to carry on (another plan opened meanwhile: never).
    const still = () => doc().id === p.projectId && hold.held;
    const made = await resumePriced(p, letter);
    if (!made || !still()) return 'no';
    const figure = resumeFigure(made.est, run.fixesLeft);
    const shown = press?.shown ?? null;
    if (press && !figureHolds(shown, figure)) return 'dearer';
    // By itself: what is left of what it was approved for (the steps in flight counted at
    // their most); on Carry on, the figure its button showed.
    const approved = press ? shown : run.approved === null ? figure : approvedLeft(run);
    const sp: ScopePlan = {
      ...made.sp,
      draft: structuredClone(made.sp.draft),
      plan: structuredClone(made.sp.plan),
      locks: structuredClone(made.sp.locks),
    };
    const d = roomsDone(o, run);
    if (!press) {
      await act({
        type: 'event',
        id: newId('turn'),
        at: nowIso(),
        event: {
          type: 'note',
          text: `Picked up where it stopped: ${doneText(d)}, not paid for again.`,
        },
      });
      if (!still()) return 'no';
    }
    useTalk.setState({ shown: `${p.id}:${letter}`, open: null, why: null });
    useDesigner.setState({ previewing: true });
    void runOption(p, letter, sp, made.est, approved, { run, hold });
    return 'started';
  } finally {
    end();
  }
}

/** Ends an interrupted option as it is: stopped, its finished rooms kept (Keep as it is). */
export async function keepAsItIs(p: Proposal, letter: string) {
  await actProposal(p.id, (x) =>
    x
      ? {
          ...x,
          options: x.options.map((o) => {
            if (o.letter !== letter) return o;
            const { run: _done, ...rest } = o;
            return { ...rest, status: 'stopped' as const };
          }),
        }
      : x,
  );
  await act({
    type: 'event',
    id: newId('turn'),
    at: nowIso(),
    event: { type: 'stopped', usd: null },
  });
  await act({ type: 'scopeNext', at: nowIso(), id: newId('turn') });
}

/** The checkpoint's copy of what a run asks for. */
const planRecord = (plan: RunPlan): RunCheckpoint['plan'] =>
  structuredClone(plan) as RunCheckpoint['plan'];

/** What an option was made with, for its kept pieces (its record's set, else its time). */
function madeOf(p: Proposal, letter: string): MadeWith {
  const o = p.options.find((x) => x.letter === letter);
  return o?.kept ? { kept: o.kept } : (o?.madeAt ?? p.at);
}

/**
 * Runs one option with slice 1's runner, saving each room into the proposal, with a
 * checkpoint to carry on from if the page goes (`from`: carrying one on). It holds the run's
 * Web Lock and keeps the screen on while it goes.
 */
async function runOption(
  p: Proposal,
  letter: string,
  sp: ScopePlan,
  est: RunEstimate,
  approved: number | null,
  from?: CarryFrom,
) {
  const ai = aiSettings();
  const project = doc();
  // Its own plan's: never run against a plan opened meanwhile (its results would go nowhere).
  const projectId = p.projectId;
  if (!ai || project.id !== projectId) {
    from?.hold.release();
    return;
  }
  const ctrl = new AbortController();
  let endRun: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    endRun = resolve;
  });
  // Thorough with a model that can see ends with the second look (priced in its figure). A run
  // carried on looks only if its checkpoint says the look is still to come: never once it went,
  // and never for one written before there was a look.
  // Keep fixing (fix rounds only) never looks again; carried on, as its checkpoint says.
  const looks =
    looksAt(sp.brief, ai) && (from ? from.run.look === 'left' : !sp.plan.fixOnly?.length);
  const runId = from?.run.id ?? newId('run');
  const now = nowIso();
  const prior = from?.run;
  // Carried on: the steps that were in flight when the page went count as spent at their most
  // (they were never metered), and what it may spend now is on top of that.
  const priorSpent = prior ? spentWithInflight(prior) : 0;
  const ck: RunCheckpoint = prior
    ? {
        ...structuredClone(prior),
        at: now,
        provider: ai.provider,
        model: ai.model,
        spent: priorSpent,
        inflight: [],
        approved: approved === null ? null : priorSpent + approved,
        paused: null,
        stopped: false,
      }
    : {
        id: runId,
        startedAt: now,
        at: now,
        provider: ai.provider,
        model: ai.model,
        plan: planRecord(sp.plan),
        ...(sp.expected ? { expected: structuredClone(sp.expected) } : {}),
        layout: sp.plan.layout ? 'left' : 'none',
        rooms: null,
        ...(looks ? { look: 'left' as const } : {}),
        // The pool its figure priced (any room may take it all while it makes progress).
        fixesLeft: est.fixes,
        fixing: {},
        approved,
        spent: 0,
        inflight: [],
        stopped: false,
        paused: null,
        times: [],
      };
  const spentBefore = ck.spent;
  /** Keep fixing (B2): a fix-only run the person asked for on a version already shown. */
  const keeping = !!ck.plan.fixOnly?.length;
  /** Problems Keep fixing had fixed on this option before this run (its log line counts on). */
  const keptOf = (spaces: ProposalOption['spaces']) =>
    Object.values(spaces).reduce(
      (t, s) =>
        t +
        (s.rounds ?? [])
          .filter((x) => x.by === 'keep' && x.outcome === 'fixed')
          .reduce((a, x) => a + Math.max(0, x.before - x.after), 0),
      0,
    );
  const keptBefore = keptOf(p.options.find((o) => o.letter === letter)?.spaces ?? {});
  // Carried on: the steps it finished before, shown done above the ones it goes on with.
  const option0 = p.options.find((o) => o.letter === letter);
  const before: StepState[] = [];
  if (prior && option0) {
    if (prior.layout === 'done') {
      before.push({ ...blankStep('layout', 'Layout and style', 'layout'), status: 'done' });
    }
    for (const k of prior.rooms ?? []) {
      const s = option0.spaces[k];
      if (finishedSpace(s)) {
        before.push({
          ...blankStep(k, s?.name ?? 'Room', 'room'),
          status: s?.status === 'failed' ? 'failed' : 'done',
        });
      }
    }
  }
  const shownSteps = (steps: StepState[]) => (before.length ? [...before, ...steps] : steps);
  const steps = shownSteps([
    ...(sp.plan.layout ? [blankStep('layout', 'Layout and style', 'layout')] : []),
    ...(sp.plan.rooms === 'all'
      ? (sp.expected ?? [])
      : sp.plan.rooms.map((key) => ({ key, label: sp.draft.spaces[key]?.name ?? 'Room' }))
    ).map((r) => blankStep(r.key, r.label, 'room')),
    ...(looks ? [blankStep('look', 'Second look', 'look')] : []),
  ]);
  const running: Running = {
    designId: sp.draft.id,
    projectId,
    state: {
      steps,
      phase: 'running',
      halt: null,
      usage: [],
      startedAt: Date.now(),
      endedAt: null,
      said: 'Designing…',
    },
    ctrl,
    estimate: est.usd?.typical ?? null,
    paused: null,
    remaining: null,
    ended,
    again: () => {},
  };
  // Written to this plan's record by its id, whichever plan is open now (another plan opened
  // mid-run still ends this one's run in its own record).
  const writeOption = (patch: (o: ProposalOption) => ProposalOption) =>
    actProposal(
      p.id,
      (x) =>
        x ? { ...x, options: x.options.map((o) => (o.letter === letter ? patch(o) : o)) } : x,
      projectId,
    );
  const writeRun = () => writeOption((o) => ({ ...o, run: structuredClone(ck) }));
  // Stop (or another plan opened): marked stopped before the requests are aborted, so a page
  // that goes before the run's end is written never carries it on. There from the first moment
  // the run shows.
  const stop = () => {
    ck.stopped = true;
    void writeRun();
    ctrl.abort();
  };
  const firstLeft = timeLeft(steps, ck.times, null);
  useDesigner.setState({ run: running });
  useTalk.setState({
    live: {
      proposalId: p.id,
      letter,
      state: running.state,
      ctrl,
      paused: null,
      pausedBy: null,
      remaining: null,
      approved,
      left: firstLeft,
      wake: null,
      stop,
    },
  });
  if (!prior) countRun();
  const setLive = (patch: Partial<NonNullable<ReturnType<typeof useTalk.getState>['live']>>) => {
    const l = useTalk.getState().live;
    if (l && l.ctrl === ctrl) useTalk.setState({ live: { ...l, ...patch } });
  };
  // The screen kept on while it runs (not while it waits at a limit).
  const screen = holdScreen((wake) => setLive({ wake }));
  const liveState = () => useTalk.getState().live?.state;
  // What this run has spent, as each request is metered (the checkpoint has it at once).
  let spentHere = 0;
  const spentRun = () => spentHere;
  /**
   * The most finishing may still cost: the steps not done, at their limit, and the fix-ups left
   * at the dearest fix request (a room done may still take them while it makes progress).
   */
  const remainingHigh = () => {
    if (!est.usd) return null;
    const done = new Set(
      (liveState()?.steps ?? []).filter((s) => s.status === 'done').map((s) => s.key),
    );
    const left = est.steps.filter((s) => !done.has(s.step));
    return left.reduce((t, s) => t + (s.usd?.high ?? 0), 0) + est.usd.fixOne * ck.fixesLeft;
  };
  // The runner's own rows (without the ones finished before it carried on).
  let runnerSteps: StepState[] = [];
  let left = firstLeft;
  let lastBack = 0;
  /** The checkpoint as of `d` (the version just saved): rooms known, the pool, spent. */
  const checkpoint = (d: DraftDesign, fixesLeft: number, fixing = ck.fixing) => {
    if (ck.layout === 'left' && runnerSteps.some((s) => s.kind === 'layout' && s.status === 'done'))
      ck.layout = 'done';
    if (ck.rooms === null && ck.layout !== 'left') {
      const rooms = runnerSteps.filter((s) => s.kind === 'room').map((s) => s.key);
      if (rooms.length && rooms.every((k) => d.spaces[k])) ck.rooms = rooms;
    }
    // The look, once it has ended (looked at, skipped or failed), is never asked for again.
    const lk = runnerSteps.find((s) => s.kind === 'look');
    if (ck.look === 'left' && lk && ['done', 'failed', 'skipped'].includes(lk.status))
      ck.look = 'done';
    // Only ever down within a run (a save's count may be older than a round's reservation, which
    // already took its fix-up: `onStep`).
    ck.fixesLeft = Math.min(ck.fixesLeft, fixesLeft);
    ck.fixing = structuredClone(fixing);
    ck.spent = spentBefore + spentRun();
    ck.at = nowIso();
    return structuredClone(ck);
  };
  /** The most a step sent now may cost, reserved before it goes (`stepHigh`). */
  const highOf = (key: string, kind: StepKind) => stepHigh(est, key, kind);
  /** The steps on their way, at their most. */
  const inflightHigh = () => ck.inflight.reduce((t, x) => t + x.high, 0);
  // The run's own figure: past what it was priced at, it asks as the tab's limit does. After
  // Finish, a new figure (what finishing may still cost) holds until the run ends.
  let cap = approved;
  let pastTab = false;
  const save = async (
    d: DraftDesign,
    info: { fixesLeft: number; fixing: RunCheckpoint['fixing'] },
  ) => {
    const copy = structuredClone(d);
    const run = checkpoint(copy, info.fixesLeft, info.fixing);
    await writeOption((o) => ({
      ...o,
      aliases: copy.aliases,
      concept: copy.concept,
      spaces: copy.spaces,
      // The layout's vetting lines and the orphans taken out (a run with no layout step keeps
      // the option's own, with its own added).
      ...(sp.plan.layout
        ? { appLines: copy.appLines }
        : copy.appLines?.length
          ? { appLines: [...new Set([...(o.appLines ?? []), ...copy.appLines])].slice(0, 8) }
          : {}),
      usage: copy.usage,
      run,
    }));
  };
  // Its lock, taken once the run shows here (never a moment shown as a run with no owner).
  const hold = from?.hold ??
    (await takeRunLock(runId)) ?? {
      release: () => {},
      held: true,
    };
  // Saved at once: a page that goes before the first step ends can carry on from the start.
  await writeRun();
  const {
    state,
    design,
    look: looked,
  } = await runDesign({
    // At every finished room it was asked for (carried on: the checkpoint's, not only those left).
    ...(looks
      ? {
          look: {
            rasterise,
            scope: ck.plan.rooms,
            // Kept with the checkpoint (the runner saves it next): a reload in its round keeps it.
            onAnswer: (l: OptionLook) => {
              ck.lookResult = l;
            },
          },
        }
      : {}),
    ai,
    ctx: sp.ctx,
    design: sp.draft,
    plan: sp.plan,
    signal: ctrl.signal,
    page: browserPage(),
    prices: priceTable(),
    // Placed as its card will be: with the kept pieces it was made with.
    result: designOpts(project, designLevelId(), madeOf(p, letter)),
    results: trialResult,
    // The app's free fixes for each room, in the worker; never a piece the person left out.
    free: trialFree,
    declined: declinedPieces(),
    fixesLeft: ck.fixesLeft,
    fixing: ck.fixing,
    // Carried on: what was on its way when the page went (a fix round among it is recorded as
    // gone, never sent again).
    ...(prior?.inflight.length ? { lost: prior.inflight.map((x) => x.step) } : {}),
    // Keep fixing's rounds are said apart on the card (asked and paid for after it was shown).
    ...(keeping ? { roundsBy: 'keep' as const } : {}),
    ...(sp.expected ? { expected: sp.expected } : {}),
    onUpdate: (st) => {
      runnerSteps = st.steps;
      const shown = { ...st, steps: shownSteps(st.steps) };
      // The time left, worked out again only when a step ends or a fix round starts.
      if (timeLeftMark(shown.steps) !== left.at) left = timeLeft(shown.steps, ck.times, left);
      setLive({ state: shown, left });
      const r = useDesigner.getState().run;
      if (r && r.ctrl === ctrl) useDesigner.setState({ run: { ...r, state: shown } });
    },
    onSave: save,
    // (These two write what was spent and what is on its way; `ck.at`, its last progress, moves
    // only when a step is saved.)
    onUsage: (u) => {
      addUsage(u);
      spentHere += u.usd ?? 0;
      ck.spent = spentBefore + spentHere;
      void writeRun();
    },
    onStep: (key, kind, phase, info) => {
      // The look's answer is back (or nothing was sent): paid for, so never asked again, even
      // if the page goes during its round.
      if (kind === 'look' && phase === 'end' && ck.look === 'left') ck.look = 'done';
      // A fix round's fix-up is gone in the same write as its reservation (tech lead S2): a page
      // that dies between the two never carries on with it still left.
      if (info) ck.fixesLeft = Math.min(ck.fixesLeft, info.fixesLeft);
      // A step on its way, at its most: counted as spent if the page goes before it is back.
      ck.inflight = ck.inflight.filter((x) => x.step !== key);
      if (phase === 'start') ck.inflight = [...ck.inflight, { step: key, high: highOf(key, kind) }];
      void writeRun();
    },
    onTimed: (kind, ms) => {
      ck.times = [...ck.times, { kind, ms }].slice(-60);
    },
    onResent: (st) => {
      // Once a return: "Back. Carrying on from Bedroom 2: 3 of 5 rooms done, not paid for again."
      if (Date.now() - lastBack < 5000 || doc().id !== projectId) return;
      lastBack = Date.now();
      const rows = shownSteps(runnerSteps).filter((s) => s.kind === 'room');
      const done = rows.filter((s) => s.status === 'done' || s.status === 'failed').length;
      void act({
        type: 'event',
        id: newId('turn'),
        at: nowIso(),
        event: {
          type: 'note',
          text: `Back. Carrying on from ${st.kind === 'look' ? 'the second look' : st.label}: ${done} of ${rows.length} rooms done, not paid for again.`,
        },
      });
    },
    // Its figure holds what it spent, the steps on their way at their most, and the step about
    // to go at its most: one that doesn't fit pauses and asks; nothing is sent again past it.
    overLimit: (next) => {
      if (!pastTab && overLimit()) return true;
      if (cap === null) return false;
      const committed = spentRun() + inflightHigh();
      // A step about to go must fit at its most; with none (a request sent again), nothing more
      // goes once all of it is committed.
      return next ? committed + highOf(next.key, next.kind) > cap + 1e-9 : committed >= cap;
    },
    askAgain: true,
    confirmOver: () =>
      new Promise<boolean>((resolve) => {
        const by = !pastTab && overLimit() ? 'tab' : 'approved';
        const more = remainingHigh();
        // Waiting for the person: the screen may sleep, and a page closed now asks again.
        screen.release();
        ck.paused = by;
        void writeRun();
        setLive({
          pausedBy: by,
          remaining: more,
          paused: (go) => {
            setLive({ paused: null, pausedBy: null });
            ck.paused = null;
            if (go) screen.hold();
            if (go && by === 'tab') pastTab = true;
            // The new figure (tech lead N3): what is spent, the steps not done at their high (a
            // room in its fix rounds still counts at its room step's high, which is generous),
            // and the fix-ups left at the dearest fix request; a fix round already on its way
            // isn't added again (its fix-up is no longer left, and what it spends is metered).
            if (go && by === 'approved') cap = more === null ? null : spentRun() + more;
            resolve(go);
          },
        });
        say(
          by === 'tab'
            ? 'Paused: this tab has reached its limit.'
            : `Paused: the next step may take this design past what it was priced at. ${usd(spentRun())} spent so far.`,
        );
      }),
  });
  screen.end();
  if (state.phase === 'interrupted' && !ck.stopped) {
    // The checkpoint stays, and the card asks (resume.ts): away too long, or (cut off again
    // and again, or no room left in its figure) asked whatever the time.
    const why = state.interrupt ?? 'away';
    ck.paused =
      why === 'resent' ? 'resent' : why === 'limit' ? (overLimit() ? 'tab' : 'approved') : null;
    const run = checkpoint(design, ck.fixesLeft);
    await writeOption((o) => ({ ...o, run }));
    if (useTalk.getState().live?.ctrl === ctrl) useTalk.setState({ live: null });
    const r = useDesigner.getState().run;
    if (r?.ctrl === ctrl) useDesigner.setState({ run: null });
    hold.release();
    if (doc().id === projectId) say(interruptText(why));
    endRun();
    runHooks.interrupted();
    return;
  }
  // Nothing designed (every request refused, the layout failed): the card says it didn't work,
  // never a passing design with nothing in it. Some rooms done: stopped part-way.
  const designed = Object.values(design.spaces).filter(
    (x) => x.status === 'done' || x.status === 'copied',
  ).length;
  const failedRooms = Object.values(design.spaces).some((x) => x.status === 'failed');
  const failed = state.phase === 'failed' || state.phase === 'halted' || failedRooms;
  const status: ProposalOption['status'] =
    designed === 0 && state.phase !== 'stopped'
      ? 'failed'
      : state.phase === 'done' && !failedRooms
        ? 'checked'
        : 'stopped';
  const cutOff = state.steps.reduce((t, s) => t + (s.cutOffHigh ?? 0), 0);
  // The look as it ended; carried on after it answered, as the checkpoint kept it.
  const ending = lookAtEnd({
    looked,
    run: ck,
    brief: sp.brief,
    ai,
    phase: state.phase,
    stopped: ctrl.signal.aborted,
    at: nowIso(),
  });
  const lookNow = ending.look;
  // A house rule the second look suggests, vetted on the plan as it is (only while open).
  const { look, offers } =
    doc().id === projectId
      ? lookOffersOf(lookNow, p, letter, design)
      : { look: lookNow, offers: [] };
  await writeOption((o) => {
    // Ended: nothing to carry on from.
    const { run: _ended, ...rest } = o;
    return {
      ...rest,
      status,
      // Named by the designer's summary (A keeps its room's name without one).
      name: optionName(o, o.letter === 'A' ? o.name : undefined),
      // The second look's notes; a round it kept is in the rooms already saved.
      ...(look ? { look, spaces: structuredClone(design.spaces) } : {}),
      note: cutNote(
        state.halt?.message ?? (failed ? (state.steps.find((s) => s.error)?.error ?? null) : null),
      ),
    };
  });
  // Whether the log was following the run (the person hadn't scrolled away): read before the
  // next turn goes in, which takes the log to its foot.
  const following = logFollowing();
  // The conversation's lines, only while its plan is open (the record `act` writes is its).
  if (doc().id === projectId) {
    if (state.phase === 'stopped') {
      await act({
        type: 'event',
        id: newId('turn'),
        at: nowIso(),
        event: { type: 'stopped', usd: cutOff > 0 ? cutOff : null },
      });
    }
    // Stopped during the look, every room done: said, and the design stands as checked.
    if (ending.stopNote) {
      await act({
        type: 'event',
        id: newId('turn'),
        at: nowIso(),
        event: { type: 'note', text: ending.stopNote },
      });
    }
    // A house rule the second look suggests: offered in the log as a reply's is (free).
    for (const o of offers) await act(o);
    if (keeping && status !== 'failed') {
      // Keep fixing is the person's own action, said in the log as an accept is (UX B2).
      const more = keptOf(design.spaces) - keptBefore;
      const spentNow = state.usage.reduce((t, u) => t + (u.usd ?? 0), 0);
      const title = optionTitle(p.n, letter, p.options.length);
      await act({
        type: 'event',
        id: newId('turn'),
        at: nowIso(),
        event: {
          type: 'note',
          text: `You kept fixing ${title}: ${more ? `the app fixed ${more} more problem${more === 1 ? '' : 's'}` : 'nothing more was fixed'}${state.usage.length ? `, for ${usd(spentNow)}` : ''}.`,
        },
      });
    }
    // Fix every check first, and some still don't pass: the app says so in the log, plainly,
    // the card's own heading's words (designer listens §6), never just "designed".
    if (status === 'checked' && !keeping) {
      const line = await strictNotMetLine(p.id, letter).catch(() => null);
      if (line && doc().id === projectId) {
        await act({
          type: 'event',
          id: newId('turn'),
          at: nowIso(),
          event: { type: 'note', text: line },
        });
      }
    }
    // Where next? only after a new design (Keep fixing goes on with the card on the table).
    if (status !== 'failed' && !keeping) {
      await act({ type: 'scopeNext', at: nowIso(), id: newId('turn') });
    }
  }
  hold.release();
  // Nothing designed: no empty version stays on the plan (N3).
  if (status === 'failed' && useTalk.getState().shown === `${p.id}:${letter}`) {
    useTalk.setState({ shown: null });
    useDesigner.setState({ previewing: false });
  }
  if (useTalk.getState().live?.ctrl === ctrl) useTalk.setState({ live: null });
  const r = useDesigner.getState().run;
  if (r?.ctrl === ctrl) useDesigner.setState({ run: null });
  // Said only where its plan is open (never in another plan's live region): one announcement,
  // from the card's one list ("V8 is ready. 3 don’t pass: You have no bed …, and 2 more.").
  if (doc().id === projectId) {
    const title = `V${p.n}${p.options.length > 1 || letter !== 'A' ? letter : ''}`;
    // Carried on: what this session spent and what the option has cost in all (QA: the card and
    // the conversation show the whole), else this run's.
    const here = state.usage.reduce((t, u) => t + (u.usd ?? 0), 0);
    const all = design.usage.reduce((t, u) => t + (u.usd ?? 0), 0);
    const cost = !state.usage.length
      ? prior && all > 0
        ? `${usd(all)} in all`
        : null
      : prior
        ? `${usd(here)} since you came back, ${usd(all)} in all`
        : usd(here);
    if (status === 'checked') {
      // Once its checks are worked out (the worker has it), never holding the run's end up.
      void (
        keeping ? keptText(p.id, letter, title, cost) : readyText(p.id, letter, title, cost)
      ).then((t) => {
        if (doc().id === projectId) say(t);
      });
    } else {
      say(
        status === 'stopped'
          ? 'Stopped. Finished rooms are kept.'
          : (state.halt?.message ?? 'The design didn’t work.'),
      );
    }
    // The card's head in view when it's taller than the log (its lead is read first).
    if (status !== 'failed' && following) cardHeadIntoView(`${p.id}:${letter}`);
  }
  endRun();
}

/** Keep fixing's end in the live region: "Kept fixing V1: passes all checks now. Cost US$0.04 more." */
async function keptText(
  proposalId: string,
  letter: string,
  title: string,
  cost: string | null,
): Promise<string> {
  const p = useTalk.getState().proposals.find((x) => x.id === proposalId);
  const o = p?.options.find((x) => x.letter === letter);
  // "US$0.04 more" for its own run; carried on, the phrase says both figures already.
  const tail = cost ? ` Cost ${cost}${/in all$/.test(cost) ? '' : ' more'}.` : '';
  if (!p || !o) return `Kept fixing ${title}.${tail}`;
  try {
    const got = await cardReportNow(doc(), optionCard(p, o, designLevelId()));
    const n = got?.report.failures.length ?? null;
    if (n === null) return `Kept fixing ${title}.${tail}`;
    return n
      ? `Kept fixing ${title}: ${n} still ${n === 1 ? 'doesn’t' : 'don’t'} pass.${tail}`
      : `Kept fixing ${title}: passes all checks now.${tail}`;
  } catch {
    return `Kept fixing ${title}.${tail}`;
  }
}

/** The run's end in the live region, from the card's run report (its one list). */
async function readyText(
  proposalId: string,
  letter: string,
  title: string,
  cost: string | null,
): Promise<string> {
  const p = useTalk.getState().proposals.find((x) => x.id === proposalId);
  const o = p?.options.find((x) => x.letter === letter);
  const plain = `${title} is ready.${cost ? ` Cost ${cost}.` : ''}`;
  if (!p || !o) return plain;
  try {
    const got = await cardReportNow(doc(), optionCard(p, o, designLevelId()));
    if (!got) return plain;
    // Fix every check first, not met: "V8 is back. Couldn't make everything pass: 2 still don't
    // pass." (UX Accessibility), never "is ready".
    const n = got.report.failures.length;
    if (o.brief.fixAll && n > 0) {
      return `${title} is back. Couldn’t make everything pass: ${n} still ${n === 1 ? 'doesn’t' : 'don’t'} pass.${cost ? ` Cost ${cost}.` : ''}`;
    }
    // What the app placed itself, free, said once with the rest: "…; the app placed a queen bed,
    // free. Cost US$0.04."
    const free = freePlacedWords(got.changes, got.r);
    const line = readyLine(title, got.report, null);
    return `${free ? `${line.replace(/\.$/, '')}; the app placed ${free}, free.` : line}${cost ? ` Cost ${cost}.` : ''}`;
  } catch {
    return plain;
  }
}

/**
 * The app's line after a run with Fix every check first on that couldn't make everything pass
 * (designer listens §6, criterion 28): "V8: couldn't make everything pass within US$0.60. 2 still
 * don't pass: You and Partner have no bed in Main bedroom, and 1 more." Null otherwise.
 */
async function strictNotMetLine(proposalId: string, letter: string): Promise<string | null> {
  const p = useTalk.getState().proposals.find((x) => x.id === proposalId);
  const o = p?.options.find((x) => x.letter === letter);
  if (!p || !o || !o.brief.fixAll) return null;
  const got = await cardReportNow(doc(), optionCard(p, o, designLevelId()));
  const n = got?.report.failures.length ?? 0;
  if (!got || !n) return null;
  const title = optionTitle(p.n, letter, p.options.length);
  const words = notMetText(notMetOf(o));
  return cut(
    `${title}: ${words} ${n} still ${n === 1 ? 'doesn’t' : 'don’t'} pass: ${firstAndMore(got.report)}.`,
    TALK_LIMITS.note,
  );
}

/** Stops the design run going on (its finished rooms are kept). */
export const stopTalkRun = () => {
  const l = useTalk.getState().live;
  if (l?.stop) l.stop();
  else l?.ctrl.abort();
};

/** Ends a run the person stopped whose end was never written: stopped, nothing carried on. */
export async function endStopped(p: Proposal, letter: string) {
  await actProposal(p.id, (x) =>
    x
      ? {
          ...x,
          options: x.options.map((o) => {
            if (o.letter !== letter) return o;
            const { run: _stopped, ...rest } = o;
            return { ...rest, status: 'stopped' as const };
          }),
        }
      : x,
  );
}
