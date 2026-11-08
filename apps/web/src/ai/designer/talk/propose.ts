import {
  type Conversation,
  DRAFT_CHARS,
  type DraftDesign,
  PROPOSAL_RECORD_VERSION,
  type Proposal,
  type ProposalOption,
  type RunEstimate,
  type RunPlan,
  type ScopePlan,
  type ScopeRef,
  TALK_LIMITS,
  type TalkAsk,
  type TalkPlan,
  type TurnOf,
  anotherAsk,
  askRule,
  atMostOf,
  cut,
  levelFingerprint,
  nextLetter,
  optionName,
  planScope,
  ruleSentence,
  scopeCut,
} from '@dhd/core';
import { meterSetting } from '../../../storage/store';
import { useStore } from '../../../store';
import { aiSettings } from '../../credentials';
import { freshPrice, readPrice, trialResult } from '../results';
import { blankStep, runDesign } from '../run';
import { addUsage, capUsd, countRun, overLimit, priceTable, spent, usd } from '../spend';
import { type Running, designOpts, useDesigner } from '../state';
import { designerCannotUse } from '../stream';
import type { PriceInput, Priced } from './pricing';
import { talkStore } from './talkStore';
import { threshold } from './threshold';
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
});

/** What pricing a request needs, as plain data (what the worker is sent). */
function priceInput(req: PressRequest, designId: string): Omit<PriceInput, 'designs'> | null {
  const conv = useTalk.getState().conv;
  const ai = aiSettings();
  if (!conv || !ai || designerCannotUse(ai) || levelGone()) return null;
  const project = doc();
  let finish: PriceInput['finish'];
  if (req.finish) {
    const f = req.finish;
    const p = useTalk.getState().proposals.find((x) => x.id === f.proposalId);
    const o = p?.options.find((x) => x.letter === f.letter);
    if (!p || !o) return null;
    finish = { option: o, rooms: f.rooms, words: p.words, scope: p.scope };
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
    opts: designOpts(project, designLevelId(), 'new'),
    ai: { provider: ai.provider, model: ai.model },
    prices: priceTable(),
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

/** The price and whether it is still being worked out (a skeleton shows meanwhile). */
export function pressPriceState(req: PressRequest): { est: RunEstimate | null; pending: boolean } {
  const key = priceKey(req);
  if (!key) return { est: null, pending: false };
  const v = readPrice(key, () => priceInput(req, 'dsn_est'));
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
    if (ask === 'go' && started) {
      await run(req, made, atMostOf(made.est), { person: null, turn: newId('turn') });
      return;
    }
    const u = made.est.usd;
    await act({
      type: 'ask',
      at: nowIso(),
      ids: [newId('turn'), newId('turn')],
      scope: req.scope,
      words: said,
      reason: ask === 'go' ? 'ask-threshold' : ask,
      estimate: u ? { typical: u.typical, high: u.high, fix: u.fix } : null,
      talk: { replyTo, title: plan.title, intent: plan.intent },
      just: plan.just,
    });
  } finally {
    if (started) end();
  }
}

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
  const shown = pressPrice({ ...req, words: '' });
  const made = await planOf(req, newId('dsn'));
  if (!made) return;
  const was = shown ? atMostOf(shown) : null;
  const now = atMostOf(made.est);
  const dearer = !shown || (was !== null && now !== null && now > was + 0.005);
  // The rule's own card first (the tab's first run, the limit); dearer only stops a go.
  const ruled = rule(made.est, true);
  const ask = ruled === 'go' && dearer ? 'ask-threshold' : ruled;
  if (ask === 'go') {
    await run(req, made, atMostOf(made.est), { person: newId('turn'), turn: newId('turn') });
    return;
  }
  const u = made.est.usd;
  await act({
    type: 'ask',
    at: nowIso(),
    ids: [newId('turn'), newId('turn')],
    scope: req.scope,
    words: req.words,
    reason: ask,
    estimate: u ? { typical: u.typical, high: u.high, fix: u.fix } : null,
    finish: req.finish,
    alt: req.alternative ?? null,
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
      const u = made?.est.usd;
      await act({
        type: 'costRefresh',
        turnId: card.id,
        estimate: u ? { typical: u.typical, high: u.high, fix: u.fix } : null,
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
    if (p) void runOption(p, letter, sp, made.est, approved);
    return;
  }
  const project = doc();
  const s = await talkStore();
  const fp = await s.putLevel(project.id, sp.ctx.base);
  if (req.alternative) {
    const { proposalId, letter } = req.alternative;
    const option = newOption(letter, req.scope, sp, fp);
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
    useTalk.setState({ shown: `${proposalId}:${letter}`, open: null, why: null });
    useDesigner.setState({ previewing: true });
    say(`Designing V${p.n}${letter}, another idea for ${p.scope.label}.`);
    void runOption(p, letter, sp, made.est, approved);
    return;
  }
  const proposalId = newId('prop');
  const scope = scopeCut(req.scope);
  const words = cut(req.words, DRAFT_CHARS);
  const option = newOption('A', scope, sp, fp);
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
): ProposalOption {
  return {
    letter,
    madeAt: nowIso(),
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

/** Runs one option with slice 1's runner, saving each room into the proposal. */
async function runOption(
  p: Proposal,
  letter: string,
  sp: ScopePlan,
  est: RunEstimate,
  approved: number | null,
) {
  const ai = aiSettings();
  if (!ai) return;
  const project = doc();
  const projectId = project.id;
  const ctrl = new AbortController();
  let endRun: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    endRun = resolve;
  });
  const steps = [
    ...(sp.plan.layout ? [blankStep('layout', 'Layout and style', 'layout')] : []),
    ...(sp.plan.rooms === 'all'
      ? (sp.expected ?? [])
      : sp.plan.rooms.map((key) => ({ key, label: sp.draft.spaces[key]?.name ?? 'Room' }))
    ).map((r) => blankStep(r.key, r.label, 'room')),
  ];
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
    },
  });
  countRun();
  const setLive = (patch: Partial<NonNullable<ReturnType<typeof useTalk.getState>['live']>>) => {
    const l = useTalk.getState().live;
    if (l && l.ctrl === ctrl) useTalk.setState({ live: { ...l, ...patch } });
  };
  const liveState = () => useTalk.getState().live?.state;
  const spentRun = () => (liveState()?.usage ?? []).reduce((t, u) => t + (u.usd ?? 0), 0);
  /** The most finishing may still cost: the steps not done, at their limit, and the fix rounds. */
  const remainingHigh = () => {
    if (!est.usd) return null;
    const done = new Set(
      (liveState()?.steps ?? []).filter((s) => s.status === 'done').map((s) => s.key),
    );
    const left = est.steps.filter((s) => !done.has(s.step));
    return left.reduce((t, s) => t + (s.usd?.high ?? 0), 0) + (left.length ? est.usd.fix : 0);
  };
  // The run's own figure: past what it was priced at, it asks as the tab's limit does. After
  // Finish, a new figure (what finishing may still cost) holds until the run ends.
  let cap = approved;
  let pastTab = false;
  const save = async (d: DraftDesign) => {
    if (doc().id !== projectId) return;
    const copy = structuredClone(d);
    await actProposal(p.id, (x) =>
      x
        ? {
            ...x,
            options: x.options.map((o) =>
              o.letter === letter
                ? {
                    ...o,
                    aliases: copy.aliases,
                    concept: copy.concept,
                    spaces: copy.spaces,
                    usage: copy.usage,
                  }
                : o,
            ),
          }
        : x,
    );
  };
  const { state, design } = await runDesign({
    ai,
    ctx: sp.ctx,
    design: sp.draft,
    plan: sp.plan,
    signal: ctrl.signal,
    prices: priceTable(),
    // Placed as its card will be: with the pieces kept when this option was asked for.
    result: designOpts(
      project,
      designLevelId(),
      p.options.find((o) => o.letter === letter)?.madeAt ?? p.at,
    ),
    results: trialResult,
    ...(sp.expected ? { expected: sp.expected } : {}),
    onUpdate: (st) => {
      setLive({ state: st });
      const r = useDesigner.getState().run;
      if (r && r.ctrl === ctrl) useDesigner.setState({ run: { ...r, state: st } });
    },
    onSave: save,
    onUsage: addUsage,
    overLimit: () => (!pastTab && overLimit()) || (cap !== null && spentRun() >= cap),
    askAgain: true,
    confirmOver: () =>
      new Promise<boolean>((resolve) => {
        const by = !pastTab && overLimit() ? 'tab' : 'approved';
        const more = remainingHigh();
        setLive({
          pausedBy: by,
          remaining: more,
          paused: (go) => {
            setLive({ paused: null, pausedBy: null });
            if (go && by === 'tab') pastTab = true;
            if (go && by === 'approved') cap = more === null ? null : spentRun() + more;
            resolve(go);
          },
        });
        say(
          by === 'tab'
            ? 'Paused: this tab has reached its limit.'
            : `Paused: this design has used ${usd(spentRun())}, what it was priced at.`,
        );
      }),
  });
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
  if (doc().id === projectId) {
    await actProposal(p.id, (x) =>
      x
        ? {
            ...x,
            options: x.options.map((o) =>
              o.letter === letter
                ? {
                    ...o,
                    status,
                    // Named by the designer's summary (A keeps its room's name without one).
                    name: optionName(o, o.letter === 'A' ? o.name : undefined),
                    note: cutNote(
                      state.halt?.message ??
                        (failed ? (state.steps.find((s) => s.error)?.error ?? null) : null),
                    ),
                  }
                : o,
            ),
          }
        : x,
    );
    if (state.phase === 'stopped') {
      await act({
        type: 'event',
        id: newId('turn'),
        at: nowIso(),
        event: { type: 'stopped', usd: cutOff > 0 ? cutOff : null },
      });
    }
    if (status !== 'failed') await act({ type: 'scopeNext', at: nowIso(), id: newId('turn') });
  }
  // Nothing designed: no empty version stays on the plan (N3).
  if (status === 'failed' && useTalk.getState().shown === `${p.id}:${letter}`) {
    useTalk.setState({ shown: null });
    useDesigner.setState({ previewing: false });
  }
  if (useTalk.getState().live?.ctrl === ctrl) useTalk.setState({ live: null });
  const r = useDesigner.getState().run;
  if (r?.ctrl === ctrl) useDesigner.setState({ run: null });
  say(
    status === 'checked'
      ? `V${p.n}${p.options.length > 1 || letter !== 'A' ? letter : ''} is ready. ${state.usage.length ? `Cost ${usd(state.usage.reduce((t, u) => t + (u.usd ?? 0), 0))}.` : ''}`
      : status === 'stopped'
        ? 'Stopped. Finished rooms are kept.'
        : (state.halt?.message ?? 'The design didn’t work.'),
  );
  endRun();
}

/** Stops the design run going on (its finished rooms are kept). */
export const stopTalkRun = () => useTalk.getState().live?.ctrl.abort();
