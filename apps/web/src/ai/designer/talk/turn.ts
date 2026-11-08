import { QUIET_MS, designerCannotUse, talkCall } from '@dhd/ai';
import {
  BUDGET_CHOICES,
  COOKING_CHOICES,
  type Conversation,
  type DesignBrief,
  type FactKey,
  type QuestionKey,
  STYLE_NAMES,
  type TalkEstimate,
  type TalkFact,
  type TalkInput,
  type TalkPrompt,
  type TalkQuestion,
  type TurnOf,
  WALL_CHOICES,
  WFH_CHOICES,
  aliasesFor,
  applyFacts,
  echoOf,
  entranceDoor,
  estimateTalk,
  eventsSince,
  handEdits,
  lastAccepted,
  liveRules,
  optionTitle,
  pendingReply,
  priceOf,
  probeLines,
  ruleOffer,
  spacesOf,
  tableLines,
  talkAsks,
  talkChars,
  talkPrompt,
  tokensOf,
  usdOf,
} from '@dhd/core';
import { useStore } from '../../../store';
import { aiSettings } from '../../credentials';
import { browserPage } from '../page';
import { addUsage, capUsd, overLimit, priceTable, spent, usd } from '../spend';
import { designOpts, useDesigner } from '../state';
import { cardChanges, cardResultNow, cardVerdict, optionCard } from './cards';
import { followPlan } from './propose';
import { tableCard } from './rules';
import {
  type LiveReply,
  act,
  clearTyped,
  designLevelId,
  fillComposer,
  newId,
  nowIso,
  say,
  talkLevel,
  talkLevels,
  useTalk,
} from './useTalk';

/**
 * A message to the designer (tech §2.1, §2.8): the person's turn first, then one talk call, its
 * text streamed into the log as it comes (ten paints a second at most, never written per
 * token), its JSON read and kept at the end. A plan then goes on to a design run, priced here
 * for free and run at once or asked first. One reply at a time per plan, across tabs (a Web
 * Lock), and a reply cut off by Stop, a dropped connection or a closed tab keeps its text.
 */

const doc = () => useStore.getState().editor.doc;
const lockName = (projectId: string) => `dhd-talk:${projectId}`;
type Locks = {
  request: (
    name: string,
    opts: { ifAvailable: boolean },
    fn: (lock: unknown) => Promise<unknown>,
  ) => Promise<unknown>;
  query: () => Promise<{ held?: { name?: string }[] }>;
};
const locks = (): Locks | null =>
  (typeof navigator !== 'undefined' && (navigator as unknown as { locks?: Locks }).locks) || null;

/** Whether another tab holds this plan's reply lock (it is waiting for a reply). */
export async function otherTabReplying(projectId: string): Promise<boolean> {
  const l = locks();
  if (!l) return false;
  try {
    const q = await l.query();
    return (
      !holding &&
      !useTalk.getState().reply &&
      (q.held ?? []).some((x) => x.name === lockName(projectId))
    );
  } catch {
    // Can't tell: the other tab's reply is taken to be alive (never cut off by guesswork).
    return true;
  }
}

/** Hand edits since the last accept, said once each in the log (criterion 32). */
export async function noteHandEdits() {
  const after = talkLevels()?.after;
  const conv = useTalk.getState().conv;
  if (!after || !conv) return;
  const accepted = lastAccepted(useDesigner.getState().designs, after);
  if (!accepted?.accepted) return;
  const labels = handEdits(accepted.accepted.level, after).map((l) => l.label);
  if (labels.some((l) => !conv.handSeen.includes(l))) {
    await act({ type: 'handEdits', id: newId('turn'), at: nowIso(), labels });
  }
}

/** The newest proposal still on the table, a line a change (what the designer sees of it). */
async function onTable(conv: Conversation): Promise<string[]> {
  const project = doc();
  const proposals = useTalk.getState().proposals;
  for (let i = conv.turns.length - 1; i >= 0; i--) {
    const t = conv.turns[i];
    if (t?.kind !== 'proposal') continue;
    const p = proposals.find((x) => x.id === t.proposalId);
    // The option on the plan, if it is this proposal's; else its newest.
    const shown = useTalk.getState().shown;
    const o = p?.options.find((x) => shown === `${p.id}:${x.letter}`) ?? p?.options.at(-1);
    if (!p || !o || o.status === 'running' || o.status === 'failed') return [];
    try {
      const card = optionCard(p, o, designLevelId());
      const r = await cardResultNow(project, card);
      if (!r) return [];
      const changes = cardChanges(project, card, r);
      const ticks = o.ticks ?? changes.map((c) => c.id);
      const v = cardVerdict(
        r.checks.filter((c) => c.hard && !c.already).map((c) => ({ key: c.key })),
        [],
        o.waivers.map((w) => w.key),
      );
      const failing = r.checks.filter((c) => v.failing.includes(c.key)).map((c) => c.text);
      return tableLines(
        `${optionTitle(p.n, o.letter, p.options.length)} · ${p.scope.label}: ${v.text}`,
        changes,
        ticks,
        failing,
      );
    } catch {
      return [];
    }
  }
  return [];
}

/** Each proposal since the last reply, as one line ("V2 (Kitchen): accepted 4 of 6"). */
function digests(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of useTalk.getState().proposals) {
    // One line, each option said in it (V4A … ; V4B …).
    const each = p.options.map((o) => {
      const accepted = o.accepted.filter((a) => !a.out).length;
      return `${optionTitle(p.n, o.letter, p.options.length)} (${p.scope.label}): ${o.status === 'failed' ? 'didn’t finish' : o.status === 'stopped' ? 'stopped part-way' : 'designed'}${accepted ? `, ${accepted} changes accepted` : ''}`;
    });
    if (each.length) out[p.id] = `${each.join('; ')}.`;
  }
  return out;
}

/** What a talk call is built from, on the plan as it is now. */
function inputFor(
  conv: Conversation,
  message: string,
  table: string[],
  sent?: string,
): TalkInput | null {
  const project = doc();
  const level = talkLevel();
  const before = talkLevels()?.before;
  if (!level || !before) return null;
  return {
    conv,
    level,
    before,
    aliases: aliasesFor(level, conv.aliases),
    ...(project.site ? { site: project.site } : {}),
    ...(project.models ? { models: project.models } : {}),
    message,
    events: eventsSince(conv, digests()),
    onTable: table,
    ...(sent !== undefined ? { sent } : {}),
  };
}

/** Whether the last request went under five minutes ago (its history is cached then). */
const warm = (conv: Conversation) =>
  !!conv.lastSentAt && Date.now() - Date.parse(conv.lastSentAt) < 5 * 60_000;

const priceMemo = new Map<string, TalkEstimate | null>();
/** What a Send would cost now (Send · about US$0.03), memoised on the conversation and words. */
export function sendPrice(text: string): TalkEstimate | null {
  const ai = aiSettings();
  const conv = useTalk.getState().conv;
  if (!ai || !conv || designerCannotUse(ai)) return null;
  const key = JSON.stringify([
    conv.id,
    conv.rev,
    text.length,
    ai.model,
    priceTable()[ai.model] ?? null,
  ]);
  if (priceMemo.has(key)) return priceMemo.get(key) ?? null;
  // Send's figure leaves out the table's few lines (a send prices itself afresh, in full).
  const input = inputFor(conv, text, []);
  const est = input
    ? estimateTalk(talkChars(talkPrompt(input)), {
        provider: ai.provider,
        model: ai.model,
        quality: conv.brief.quality,
        maxTokens: 4000,
        warm: warm(conv),
        prices: priceTable(),
      })
    : null;
  priceMemo.set(key, est);
  if (priceMemo.size > 20) priceMemo.delete(priceMemo.keys().next().value as string);
  return est;
}

/** A message's figure, built from the request about to go (never a stale estimate). */
function priceOfPrompt(prompt: TalkPrompt, conv: Conversation): TalkEstimate | null {
  const ai = aiSettings();
  return ai
    ? estimateTalk(talkChars(prompt), {
        provider: ai.provider,
        model: ai.model,
        quality: conv.brief.quality,
        maxTokens: prompt.maxTokens,
        warm: warm(conv),
        prices: priceTable(),
      })
    : null;
}

/** Would pass the tab's limit: said as an app line, and nothing goes. */
async function pastLimit(prompt: TalkPrompt, conv: Conversation, anyway = false): Promise<boolean> {
  const est = priceOfPrompt(prompt, conv);
  const cap = capUsd();
  if (!est?.usd || cap === null) return false;
  // Sent anyway (P2-6): only its typical figure must fit; the limit still stops a second try.
  const over = anyway ? spent().usd + est.usd.typical > cap : talkAsks(est, spent().usd, cap);
  if (!over) return false;
  await act({
    type: 'event',
    id: newId('turn'),
    at: nowIso(),
    event: {
      type: 'note',
      text: `This message may cost up to ${usd(est.usd?.high ?? 0)}, which would pass your ${usd(cap)} limit for this tab. Raise the limit in AI settings to send it.`,
    },
  });
  return true;
}

/**
 * Sends the composer's words to the designer. `ruleAsk`: Make this a rule from a Decision (its
 * words are the app's, the composer is left as it is).
 */
export async function sendMessage(
  text: string,
  anyway = false,
  ruleAsk?: { decisionId: string },
): Promise<boolean> {
  const words = text.trim();
  const ai = aiSettings();
  const conv0 = useTalk.getState().conv;
  if (!words || !ai || !conv0 || designerCannotUse(ai)) return false;
  if (pendingReply(conv0) || useTalk.getState().reply) return false;
  let sent = false;
  // The lock first: a tab opening the panel meanwhile can't take this reply for a dead one.
  const got = await withReplyLock(conv0.projectId, async () => {
    await noteHandEdits();
    const conv = useTalk.getState().conv ?? conv0;
    if (pendingReply(conv)) return;
    const input = inputFor(conv, words, await onTable(conv));
    if (!input) return;
    const prompt = talkPrompt(input);
    if (await pastLimit(prompt, conv, anyway)) return;
    const id = newId('turn');
    const next = await act({
      type: 'send',
      id,
      at: nowIso(),
      text: words,
      sent: prompt.sent,
      aliases: input.aliases,
      ...(ruleAsk ? { ruleAsk } : {}),
    });
    if (!next || pendingReply(next)?.id !== id) return;
    sent = true;
    if (!ruleAsk) await clearTyped();
    say('Designer is replying.');
    await replyNow(id, prompt);
  });
  if (got === 'busy') say('Another tab is waiting for a reply.');
  return sent;
}

/** Try again: the newest message, sent as it was the first time (the same bytes). */
export async function retryTurn(turnId: string) {
  const conv0 = useTalk.getState().conv;
  const t = conv0?.turns.find((x) => x.id === turnId);
  if (!conv0 || t?.kind !== 'person' || t.sent === undefined || useTalk.getState().reply) return;
  const got = await withReplyLock(conv0.projectId, async () => {
    const conv = useTalk.getState().conv ?? conv0;
    const at = conv.turns.findIndex((x) => x.id === turnId);
    // History before it only: the turn itself and what came after it aren't repeated.
    const earlier = { ...conv, turns: conv.turns.slice(0, at) };
    const input = inputFor(earlier, t.text, await onTable(earlier), t.sent);
    if (!input || at < 0) return;
    const prompt = talkPrompt(input);
    if (await pastLimit(prompt, conv)) return;
    const next = await act({ type: 'retry', turnId, at: nowIso() });
    if (!next || pendingReply(next)?.id !== turnId) return;
    say('Designer is replying.');
    await replyNow(turnId, prompt);
  });
  if (got === 'busy') say('Another tab is waiting for a reply.');
}

/**
 * Whether a reply another tab was waiting for has gone (that tab closed): its turn is then said
 * as cut off, and Send here works again (P2-3).
 */
export async function recheckElsewhere() {
  const conv = useTalk.getState().conv;
  if (!conv || !pendingReply(conv) || useTalk.getState().reply) return;
  await recoverPending();
}

/** The price of Try again (its request built again). */
export function retryPrice(turnId: string): TalkEstimate | null {
  const ai = aiSettings();
  const conv = useTalk.getState().conv;
  const i = conv?.turns.findIndex((x) => x.id === turnId) ?? -1;
  const t = conv?.turns[i];
  if (!ai || !conv || t?.kind !== 'person' || t.sent === undefined) return null;
  const input = inputFor({ ...conv, turns: conv.turns.slice(0, i) }, t.text, [], t.sent);
  return input
    ? estimateTalk(talkChars(talkPrompt(input)), {
        provider: ai.provider,
        model: ai.model,
        quality: conv.brief.quality,
        maxTokens: 4000,
        warm: warm(conv),
        prices: priceTable(),
      })
    : null;
}

/** Edit: a message not answered goes back into the composer. */
export async function editTurn(turnId: string) {
  const t = useTalk.getState().conv?.turns.find((x) => x.id === turnId);
  if (t?.kind !== 'person') return;
  await act({ type: 'unsend', turnId });
  fillComposer(t.text, true);
}

/** Stops the reply on its way (its text so far is kept). */
export const stopReply = () => useTalk.getState().reply?.ctrl.abort();

/**
 * A reply cut off when its tab closed (a pending turn no tab holds the lock of): its text kept
 * as far as it was checkpointed, and said (tech §2.8).
 */
export async function recoverPending() {
  const conv = useTalk.getState().conv;
  const t = conv && pendingReply(conv);
  // This tab's own reply (about to start, or running) is never taken for a dead one.
  if (!conv || !t?.reply || useTalk.getState().reply || holding) return;
  // Without Web Locks no tab can tell a live reply from a dead one: only one that has been
  // waiting longer than any reply goes quiet for is taken as cut off.
  if (!locks() && Date.now() - Date.parse(t.reply.startedAt) < QUIET_MS) return;
  if (await otherTabReplying(conv.projectId)) return;
  if (holding || useTalk.getState().reply) return;
  const price = aiSettings() ? priceOf(aiSettings()?.model ?? '', priceTable()) : null;
  const out = tokensOf(t.reply.chars || t.reply.checkpoint.length);
  const cost = price
    ? usdOf({ input: 0, cachedInput: 0, cacheWrite: 0, output: out }, price)
    : null;
  await act({
    type: 'replyCut',
    turnId: t.id,
    ids: [newId('turn'), newId('turn')],
    at: nowIso(),
    text: t.reply.checkpoint,
    usage: [],
    cut: 'tab',
    line: `The last reply was cut off when the tab closed. It may have been billed${cost ? ` (about ~${usd(cost)} or more)` : ''}.`,
  });
}

/** Kept as the tab hides: a phone may kill it, and this is the last it reliably runs. */
function checkpoint() {
  const r = useTalk.getState().reply;
  if (!r) return;
  void act({ type: 'checkpoint', turnId: r.turnId, text: r.say, chars: r.say.length });
}
if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') checkpoint();
  });
  window.addEventListener('pagehide', checkpoint);
}

/** This tab holds the reply lock (a reply of its own on its way, or about to be). */
let holding = false;

/** Whatever fails after a reply (pricing its plan, saving) is said, never retried. */
async function guarded(fn: () => Promise<void>) {
  holding = true;
  try {
    await fn();
  } catch (e) {
    await act({
      type: 'event',
      id: newId('turn'),
      at: nowIso(),
      event: {
        type: 'note',
        text: `Couldn’t finish after the reply: ${e instanceof Error ? e.message : 'something went wrong'}.`,
      },
    }).catch(() => {});
  } finally {
    holding = false;
  }
}

/**
 * Runs `fn` holding this plan's reply lock: one reply at a time across tabs. 'busy' when another
 * tab holds it. Without Web Locks (very old browsers) one tab is assumed, and so it is when the
 * Locks API fails before it ever runs `fn`; once `fn` has run, nothing runs it again (B1: a
 * second run would be billed and never shown).
 */
export async function withReplyLock(
  projectId: string,
  fn: () => Promise<void>,
): Promise<'ran' | 'busy'> {
  const l = locks();
  if (!l) {
    await guarded(fn);
    return 'ran';
  }
  let entered = false;
  let busy = false;
  try {
    await l.request(lockName(projectId), { ifAvailable: true }, async (lock) => {
      entered = true;
      if (!lock) {
        busy = true;
        return;
      }
      await guarded(fn);
    });
  } catch {
    if (!entered) {
      await guarded(fn);
      return 'ran';
    }
  }
  return busy ? 'busy' : 'ran';
}

async function replyNow(turnId: string, prompt: TalkPrompt) {
  const ai = aiSettings();
  const conv = useTalk.getState().conv;
  const project = doc();
  const level = talkLevel();
  const before = talkLevels()?.before;
  if (!ai || !conv || !level || !before) return;
  const ctrl = new AbortController();
  const set = (patch: Partial<LiveReply>) => {
    const r = useTalk.getState().reply;
    if (r && r.ctrl === ctrl) useTalk.setState({ reply: { ...r, ...patch } });
  };
  useTalk.setState({ reply: { turnId, say: '', kind: null, thinking: '', wait: null, ctrl } });
  /** The most this reply was priced at, and what it has spent so far. */
  const atMost = priceOfPrompt(prompt, conv)?.usd?.high ?? null;
  let spentHere = 0;
  try {
    const res = await talkCall({
      ai,
      prompt,
      parseCtx: {
        aliases: aliasesFor(level, conv.aliases),
        spaces: spacesOf(level).map((s) => ({ key: s.key, name: s.name, rooms: s.rooms })),
        walls: conv.brief.walls,
        mainDoor: entranceDoor(level),
      },
      signal: ctrl.signal,
      page: browserPage(),
      prices: priceTable(),
      onText: (t) => set({ say: t.say, kind: t.kind }),
      // Never past the tab's limit, nor past what the reply was priced at most: its "up to"
      // figure stays true whatever the network does.
      mayRetry: () =>
        overLimit()
          ? 'stopped at your limit for this tab.'
          : atMost !== null && spentHere >= atMost
            ? `stopped: it has used the most it was priced at (${usd(atMost)}).`
            : null,
      onStatus: (st) => set({ thinking: st.thinking, wait: st.wait }),
      onUsage: (u) => {
        spentHere += u.usd ?? 0;
        addUsage(u);
      },
    });
    const cost = res.usage.reduce((t, u) => t + (u.usd ?? 0), 0);
    if (res.status === 'stopped') {
      await act({
        type: 'replyCut',
        turnId,
        ids: [newId('turn'), newId('turn')],
        at: nowIso(),
        text: res.say,
        usage: res.usage,
        cut: 'stopped',
        line: `Stopped. The text so far is kept.${cost > 0 ? ` ~${usd(cost)}, may still be billed.` : ''}`,
      });
      say('Stopped.');
      return;
    }
    if (res.status !== 'done') {
      const error = res.status === 'halted' ? res.halt.message : res.error;
      await act({
        type: 'replyFailed',
        turnId,
        id: newId('turn'),
        at: nowIso(),
        error,
        text: res.say,
        usage: res.usage,
      });
      say(error);
      return;
    }
    const probe =
      res.reply.kind === 'concern' && res.reply.concern
        ? probeLines(res.reply.concern, {
            level,
            before,
            brief: conv.brief,
            ...(project.models ? { models: project.models } : {}),
          })
        : null;
    const id = newId('turn');
    // A rule offered: vetted on the plan as it is now, before the reply is kept (tech §4).
    const draft = res.reply.memory.rule;
    const now = useTalk.getState().conv ?? conv;
    const offer = draft
      ? ruleOffer(draft, {
          id: newId('rule'),
          at: nowIso(),
          turnId: id,
          version: tableCard(now)?.title ?? null,
          levelId: now.levelId,
          rules: liveRules(now),
          level,
          brief: now.brief,
        })
      : null;
    const after = await act({
      type: 'replyDone',
      turnId,
      id,
      at: nowIso(),
      reply: res.reply,
      lines: res.lines,
      echo: echoOf(res.reply),
      usage: res.usage,
      probe,
      ids: Array.from({ length: 12 }, () => newId('dec')),
      fold: prompt.foldUpTo ? { upTo: prompt.foldUpTo, hard: prompt.foldHard } : null,
      offer,
    });
    // The live region: the finished message in short (UX §9.1).
    say(
      `Designer: ${(res.reply.say.split(/(?<=[.!?])\s/)[0] ?? '').slice(0, 200)} Cost ${usd(cost)}.`,
    );
    // A plan goes on to its design run: priced here, run at once or asked first.
    const t = after?.turns.find((x) => x.id === id);
    const person = after?.turns.find((x) => x.id === turnId);
    if (t?.kind === 'designer' && t.talk?.plan && person?.kind === 'person') {
      useTalk.setState({ reply: null });
      try {
        await followPlan(t.talk.plan, person.text, id);
      } catch (e) {
        await act({
          type: 'event',
          id: newId('turn'),
          at: nowIso(),
          event: {
            type: 'note',
            text: `Couldn’t price the plan: ${e instanceof Error ? e.message : 'something went wrong'}.`,
          },
        });
      }
    }
  } finally {
    const r = useTalk.getState().reply;
    if (r?.ctrl === ctrl) useTalk.setState({ reply: null });
  }
}

const lowerEq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A chip of a designer's question as a What I know fact (free), or null (it fills the composer). */
function factOfChip(q: TalkQuestion, choice: string): TalkFact | null {
  if (!q.fact) return null;
  const k: FactKey = q.fact;
  const pick = <T extends { id: unknown; label: string }>(xs: T[]) =>
    xs.find((x) => lowerEq(String(x.id), choice) || lowerEq(x.label, choice));
  let fact: TalkFact | null = null;
  if (k === 'budget') {
    const c = pick(BUDGET_CHOICES);
    if (c) fact = { key: k, text: c.label, number: null, choice: c.id };
  } else if (k === 'walls') {
    const c = pick(WALL_CHOICES);
    if (c) fact = { key: k, text: c.label, number: null, choice: c.id };
  } else if (k === 'cooking') {
    const c = pick(COOKING_CHOICES);
    if (c) fact = { key: k, text: c.label, number: null, choice: c.id };
  } else if (k === 'wfh') {
    const c = pick(WFH_CHOICES);
    if (c) fact = { key: k, text: c.label, number: c.id, choice: String(c.id) };
  } else if (k === 'style') {
    const id = Object.entries(STYLE_NAMES).find(
      ([sid, name]) => lowerEq(sid, choice) || lowerEq(name, choice),
    )?.[0];
    if (id)
      fact = {
        key: k,
        text: STYLE_NAMES[id as keyof typeof STYLE_NAMES],
        number: null,
        choice: id,
      };
  } else fact = { key: k, text: choice, number: null, choice: null };
  return fact;
}

/** A chip's words: a What I know fact's own label ("A lot: big meals, wok"), else the model's. */
export const chipLabel = (q: TalkQuestion, choice: string) => factOfChip(q, choice)?.text ?? choice;

export function chipFact(
  q: TalkQuestion,
  choice: string,
  brief: DesignBrief,
): { brief: DesignBrief; key: QuestionKey } | null {
  const fact = factOfChip(q, choice);
  if (!fact) return null;
  const f = applyFacts(brief, [fact]);
  const key = f.keys[0];
  return key ? { brief: f.brief, key } : null;
}

/** A chip tapped on a designer's question: free for a fact, else it goes into the composer. */
export async function answerChip(t: TurnOf<'designer'>, index: number, choice: string) {
  const q = t.talk?.questions[index];
  const conv = useTalk.getState().conv;
  if (!q || !conv) return;
  const fact = chipFact(q, choice, conv.brief);
  if (fact) {
    await act({
      type: 'talkAnswer',
      turnId: t.id,
      index,
      words: chipLabel(q, choice),
      id: newId('turn'),
      at: nowIso(),
      brief: fact.brief,
      key: fact.key,
    });
    return;
  }
  fillComposer(`${q.text.replace(/\?$/, '')}: ${choice}.`);
}
