import {
  DRAFT_CHARS,
  type Proposal,
  type ProposalOption,
  type RunEstimate,
  type ScopeRef,
  TALK_LIMITS,
  type TurnOf,
  askRule,
  atMostOf,
  cut,
  levelFingerprint,
  scopeCut,
} from '@dhd/core';
import { useStore } from '../../../store';
import { aiSettings } from '../../credentials';
import { contextFor, estimateFor, plannedPrompts } from '../plan';
import { type DraftDesign, type RunPlan, blankStep, runDesign } from '../run';
import { addUsage, capUsd, countRun, overLimit, priceTable, spent, usd } from '../spend';
import { type Running, designOpts, useDesigner } from '../state';
import { designerCannotUse } from '../stream';
import { type ScopePlan, planScope } from './scope';
import { talkStore } from './talkStore';
import { threshold } from './threshold';
import { act, actProposal, clearTyped, newId, nowIso, say, typedNow, useTalk } from './useTalk';

/**
 * A design run from the conversation: a scope button ("Living and dining · about US$0.20"),
 * Another idea, Go ahead on a cost card, or "Design Kitchen too". Every priced press goes the
 * same way: priced, run at once or asked first (askRule), one at a time from the first tap.
 * The runner is slice 1's, unchanged; what it saves goes into the proposal (not a version:
 * only an accept makes one). The person's words in the composer go with a new proposal.
 */

const doc = () => useStore.getState().editor.doc;

const memo = new Map<string, RunEstimate | null>();
/** What a plan would cost (memoised per plan, brief, scope, rooms, model, prices and words). */
export function estimateScope(sp: ScopePlan): RunEstimate | null {
  const ai = aiSettings();
  if (!ai) return null;
  const key = JSON.stringify([
    ai.model,
    sp.brief,
    sp.scope,
    sp.plan.rooms,
    !!sp.plan.layout,
    sp.plan.feedback ?? '',
    Object.keys(sp.draft.spaces).sort(),
    levelFingerprint(sp.ctx.base),
    priceTable()[ai.model] ?? null,
  ]);
  if (memo.has(key)) return memo.get(key) ?? null;
  const est = estimateFor(
    ai,
    plannedPrompts(sp.ctx, sp.draft, sp.plan, designOpts(doc())),
    sp.brief.quality,
    priceTable(),
  );
  memo.set(key, est);
  if (memo.size > 40) memo.delete(memo.keys().next().value as string);
  return est;
}

/** What a priced press asks for: a new proposal for a scope, or a stopped one's missing rooms. */
export interface PressRequest {
  scope: ScopeRef;
  words: string;
  finish: { proposalId: string; letter: string; rooms: string[] } | null;
}

/** The plan and price of a request, on the plan as it is now. */
function planOf(req: PressRequest, designId: string): { sp: ScopePlan; est: RunEstimate } | null {
  const conv = useTalk.getState().conv;
  const ai = aiSettings();
  if (!conv || !ai || designerCannotUse(ai)) return null;
  if (req.finish) {
    const f = req.finish;
    const p = useTalk.getState().proposals.find((x) => x.id === f.proposalId);
    const sp = p ? finishPlan(p, f.letter, f.rooms) : null;
    const est = sp ? estimateScope(sp) : null;
    return sp && est ? { sp, est } : null;
  }
  const project = doc();
  const sp = planScope(
    req.scope,
    conv.brief,
    project,
    useDesigner.getState().designs,
    req.words,
    designId,
    designOpts(project),
  );
  const est = sp ? estimateScope(sp) : null;
  return sp && est ? { sp, est } : null;
}

/** A request's price, for its button or its cost card. */
export const pressPrice = (req: PressRequest): RunEstimate | null =>
  planOf(req, 'dsn_est')?.est ?? null;

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
  if (starting || useDesigner.getState().run) return false;
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

async function askOrRun(req: PressRequest) {
  const made = planOf(req, newId('dsn'));
  if (!made) return;
  const ask = askRule(made.est, {
    spentTab: spent().usd,
    cap: capUsd(),
    threshold: threshold(),
    designRunsThisTab: spent().runs,
    pressedPriced: true,
  });
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
  });
  if (!req.finish) await clearTyped();
}

/** The request a cost card stands for (or its cheaper room). */
export const cardRequest = (card: TurnOf<'cost-ask'>, cheaper?: ScopeRef): PressRequest =>
  card.finish
    ? { scope: card.scope, words: '', finish: card.finish }
    : { scope: cheaper ?? card.scope, words: card.words, finish: null };

/** A card's figure as the price would be now (to keep the card and its cost check alike). */
export function cardEstimate(card: TurnOf<'cost-ask'>): TurnOf<'cost-ask'>['estimate'] {
  const u = pressPrice(cardRequest(card))?.usd;
  return u ? { typical: u.typical, high: u.high, fix: u.fix } : null;
}

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
    const made = answer === 'not-now' ? null : planOf(req, newId('dsn'));
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
  const proposalId = newId('prop');
  const scope = scopeCut(req.scope);
  const words = cut(req.words, DRAFT_CHARS);
  const option: ProposalOption = {
    letter: 'A',
    name: cut(scope.all ? 'Whole flat' : scope.label, TALK_LIMITS.name),
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
  const proposal: Proposal = {
    projectId: project.id,
    id: proposalId,
    conversationId: conv.id,
    recordVersion: 1,
    n: conv.nextN,
    turnId: ids.turn,
    at: nowIso(),
    scope,
    words,
    options: [structuredClone(option)],
  };
  await actProposal(proposalId, () => proposal);
  await act({ type: 'propose', at: nowIso(), ids, proposalId, scope, words });
  if (ids.person) await clearTyped();
  // Every new proposal goes on the plan (after an accept the stage had gone back to After).
  useTalk.setState({ shown: `${proposalId}:A`, open: null, why: null });
  useDesigner.setState({ previewing: true });
  say(`Designing V${proposal.n}, ${option.name}.`);
  void runOption(proposal, 'A', sp, made.est, approved);
}

/** The plan for the rooms a stopped option lacks, into the same option. */
function finishPlan(p: Proposal, letter: string, rooms: string[]): ScopePlan | null {
  const o = p.options.find((x) => x.letter === letter);
  const ctx = o && contextFor(doc(), o.brief, o.aliases);
  if (!o || !ctx) return null;
  const plan: RunPlan = {
    layout: null,
    rooms,
    ...(p.words.trim() ? { feedback: p.words.trim() } : {}),
    locks: structuredClone(o.locks),
  };
  const draft: DraftDesign = structuredClone({
    id: o.designId,
    brief: o.brief,
    aliases: o.aliases,
    concept: o.concept,
    spaces: o.spaces,
    usage: o.usage,
    request: { locks: o.locks },
  });
  return { scope: p.scope, brief: o.brief, plan, draft, ctx, locks: structuredClone(o.locks) };
}

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
    result: designOpts(project),
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
  if (useTalk.getState().live?.ctrl === ctrl) useTalk.setState({ live: null });
  const r = useDesigner.getState().run;
  if (r?.ctrl === ctrl) useDesigner.setState({ run: null });
  say(
    status === 'checked'
      ? `V${p.n} is ready. ${state.usage.length ? `Cost ${usd(state.usage.reduce((t, u) => t + (u.usd ?? 0), 0))}.` : ''}`
      : status === 'stopped'
        ? 'Stopped. Finished rooms are kept.'
        : (state.halt?.message ?? 'The design didn’t work.'),
  );
  endRun();
}

/** Stops the design run going on (its finished rooms are kept). */
export const stopTalkRun = () => useTalk.getState().live?.ctrl.abort();
