import {
  type Aspect,
  type ContextInput,
  type Design,
  type DesignBrief,
  type Lock,
  type Project,
  type Proposal,
  type ProposalOption,
  type RunEstimate,
  type ScopeRef,
  type TurnOf,
  askRule,
  atMostOf,
  levelFingerprint,
  spacesOf,
} from '@dhd/core';
import { useStore } from '../../../store';
import { aiSettings } from '../../credentials';
import {
  changeFrom,
  changePlan,
  contextFor,
  estimateFor,
  lastAccepted,
  plannedPrompts,
  resultFor,
} from '../plan';
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
 * Go ahead on a cost card, or "Design Kitchen too". The plan is slice 1's runner, unchanged;
 * what it saves goes into the proposal (not a version: only an accept makes one). The person's
 * words in the composer go with it.
 */

const doc = () => useStore.getState().editor.doc;

const memo = new Map<string, RunEstimate | null>();
/** What a scope would cost (memoised per plan, brief, scope, model and words). */
export function estimateScope(sp: ScopePlan): RunEstimate | null {
  const ai = aiSettings();
  if (!ai) return null;
  const key = JSON.stringify([
    ai.model,
    sp.brief,
    sp.scope,
    sp.plan.feedback ?? '',
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

/** A scope's price for its button, or null (no key, or the model can't design). */
export function scopePrice(scope: ScopeRef, words: string): RunEstimate | null {
  const conv = useTalk.getState().conv;
  const ai = aiSettings();
  if (!conv || !ai || designerCannotUse(ai)) return null;
  const sp = planScope(
    scope,
    conv.brief,
    doc(),
    useDesigner.getState().designs,
    words,
    'dsn_est',
    designOpts(doc()),
  );
  return sp ? estimateScope(sp) : null;
}

/**
 * A priced button was pressed: the person's words go with it; it runs at once unless a cost
 * rule applies, when a cost card asks first (UX §9.4).
 */
export async function pressScope(scope: ScopeRef) {
  const conv = useTalk.getState().conv;
  const ai = aiSettings();
  if (!conv || !ai || useDesigner.getState().run || starting) return;
  const words = typedNow();
  const est = scopePrice(scope, words);
  if (!est) return;
  const ask = askRule(est, {
    spentTab: spent().usd,
    cap: capUsd(),
    threshold: threshold(),
    designRunsThisTab: spent().runs,
    pressedPriced: true,
  });
  if (ask === 'go') {
    await startProposal(scope, words, est, { person: newId('turn'), turn: newId('turn') });
    return;
  }
  await act({
    type: 'ask',
    at: nowIso(),
    ids: [newId('turn'), newId('turn')],
    scope,
    words,
    reason: ask,
    estimate: est.usd ? { typical: est.usd.typical, high: est.usd.high, fix: est.usd.fix } : null,
  });
  await clearTyped();
}

/** The answer to a cost card: Go ahead, Just {room}, or Not now. */
export async function answerCost(
  card: TurnOf<'cost-ask'>,
  answer: 'go' | 'cheaper' | 'not-now',
  cheaper?: ScopeRef,
) {
  if (useDesigner.getState().run || starting) return;
  const conv = await act({
    type: 'costAnswer',
    turnId: card.id,
    answer,
    at: nowIso(),
    id: newId('turn'),
  });
  const t = conv?.turns.find((x) => x.id === card.id);
  if (answer === 'not-now' || t?.kind !== 'cost-ask') return;
  const scope = answer === 'cheaper' && cheaper ? cheaper : card.scope;
  const est = scopePrice(scope, card.words);
  if (!est) return;
  await startProposal(scope, card.words, est, { person: null, turn: newId('turn') });
}

let starting = false;

/** Starts a proposal's run: a proposal record, its turn, then the runner. */
async function startProposal(
  scope: ScopeRef,
  words: string,
  est: RunEstimate,
  ids: { person: string | null; turn: string },
) {
  const conv = useTalk.getState().conv;
  const ai = aiSettings();
  if (!conv || !ai || starting || useDesigner.getState().run) return;
  starting = true;
  useDesigner.setState({ starting: true });
  try {
    const project = doc();
    const designId = newId('dsn');
    const sp = planScope(
      scope,
      conv.brief,
      project,
      useDesigner.getState().designs,
      words,
      designId,
      designOpts(project),
    );
    if (!sp) return;
    const s = await talkStore();
    const fp = await s.putLevel(project.id, sp.ctx.base);
    const proposalId = newId('prop');
    const option: ProposalOption = {
      letter: 'A',
      name: scope.all ? 'Whole flat' : scope.label,
      designId,
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
      options: [option],
    };
    await actProposal(proposalId, () => proposal);
    await act({ type: 'propose', at: nowIso(), ids, proposalId, scope, words });
    if (ids.person) await clearTyped();
    useTalk.setState({ shown: `${proposalId}:A`, open: null });
    say(`Designing V${proposal.n}, ${option.name}.`);
    void runOption(proposal, 'A', sp, est);
  } finally {
    starting = false;
    useDesigner.setState({ starting: false });
  }
}

/** "Design Kitchen too": the rooms a stopped option lacks, into the same option. */
export async function finishOption(p: Proposal, letter: string, rooms: string[]) {
  const o = p.options.find((x) => x.letter === letter);
  const ai = aiSettings();
  if (!o || !ai || useDesigner.getState().run || starting) return;
  const project = doc();
  const ctx = contextFor(project, o.brief, o.aliases);
  if (!ctx) return;
  const plan: RunPlan = {
    layout: null,
    rooms,
    ...(p.words.trim() ? { feedback: p.words.trim() } : {}),
    locks: o.locks,
  };
  const draft: DraftDesign = {
    id: o.designId,
    brief: o.brief,
    aliases: o.aliases,
    concept: o.concept,
    spaces: o.spaces,
    usage: o.usage,
    request: { locks: o.locks },
  };
  const sp: ScopePlan = { scope: p.scope, brief: o.brief, plan, draft, ctx, locks: o.locks };
  const est = estimateScope(sp);
  if (!est) return;
  await actProposal(p.id, (x) =>
    x
      ? {
          ...x,
          options: x.options.map((y) =>
            y.letter === letter ? { ...y, status: 'running', note: null } : y,
          ),
        }
      : x,
  );
  void runOption(p, letter, sp, est);
}

/** The price of the rooms a stopped option lacks. */
export function finishPrice(p: Proposal, letter: string, rooms: string[]): RunEstimate | null {
  const o = p.options.find((x) => x.letter === letter);
  const project = doc();
  const ctx = o && contextFor(project, o.brief, o.aliases);
  if (!o || !ctx) return null;
  return estimateScope({
    scope: p.scope,
    brief: o.brief,
    plan: { layout: null, rooms, locks: o.locks },
    draft: {
      id: o.designId,
      brief: o.brief,
      aliases: o.aliases,
      concept: o.concept,
      spaces: o.spaces,
      usage: [],
      request: { locks: o.locks },
    },
    ctx,
    locks: o.locks,
  });
}

/** Runs one option with slice 1's runner, saving each room into the proposal. */
async function runOption(p: Proposal, letter: string, sp: ScopePlan, est: RunEstimate) {
  const ai = aiSettings();
  if (!ai) return;
  const project = doc();
  const projectId = project.id;
  const ctrl = new AbortController();
  const approved = atMostOf(est);
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
  const spentRun = () =>
    (useTalk.getState().live?.state.usage ?? []).reduce((t, u) => t + (u.usd ?? 0), 0);
  // The run's own figure: past what it was priced at, it asks as the tab's limit does.
  const pastApproved = () => approved !== null && spentRun() >= approved;
  const save = async (d: DraftDesign) => {
    if (doc().id !== projectId) return;
    await actProposal(p.id, (x) =>
      x
        ? {
            ...x,
            options: x.options.map((o) =>
              o.letter === letter
                ? {
                    ...o,
                    aliases: d.aliases,
                    concept: d.concept,
                    spaces: d.spaces,
                    usage: d.usage,
                  }
                : o,
            ),
          }
        : x,
    );
  };
  const { state } = await runDesign({
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
    overLimit: () => overLimit() || pastApproved(),
    confirmOver: () =>
      new Promise<boolean>((resolve) => {
        const by = overLimit() ? 'tab' : 'approved';
        setLive({
          pausedBy: by,
          remaining: est.usd ? Math.max(0, est.usd.typical - spentRun()) : null,
          paused: (go) => {
            setLive({ paused: null, pausedBy: null });
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
  const failed = state.phase === 'failed' || state.phase === 'halted';
  const status: ProposalOption['status'] =
    state.phase === 'done' ? 'checked' : failed && !state.usage.length ? 'failed' : 'stopped';
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
                    note:
                      state.halt?.message ??
                      (failed ? (state.steps.find((s) => s.error)?.error ?? null) : null),
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
