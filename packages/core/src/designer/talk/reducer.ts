import type { Level } from '../../schema';
import type { DesignBrief, Usage } from '../schema';
import {
  GREETING_NEXT,
  assume,
  factText,
  formKnows,
  formSummary,
  greeting as greetingText,
  nextQuestions,
} from './firstMeeting';
import { spentOf } from './price';
import type { ProbeLines } from './probe';
import { mechanicalSummary } from './prompt';
import { type TalkReply, applyFacts, confirmText, factQuestion, widens } from './reply';
import {
  type Conversation,
  DECISION_CHARS,
  DRAFT_CHARS,
  type Decision,
  TALK_LIMITS as L,
  MAX_DECISIONS,
  MAX_TURNS,
  QUESTION_KEYS,
  type QuestionKey,
  SENT_CHARS,
  type ScopeRef,
  TALK_RECORD_VERSION,
  type TalkEvent,
  type TalkNoted,
  type Turn,
  type TurnOf,
  cut,
  cutLines,
} from './schema';

/**
 * The conversation's reducer: every change to a conversation is one of these actions, applied
 * to the record as it was read (so two tabs' writes never clobber each other). Pure: ids and
 * times come in the action. An action that doesn't fit the state (an answer to a question
 * already answered, a cost card answered twice) leaves it unchanged, so a double click or a
 * race between tabs does no harm.
 */

export type TalkAction =
  | {
      type: 'start';
      id: string;
      at: string;
      projectId: string;
      levelId: string;
      brief: DesignBrief;
      beforeFp: string;
      afterFp: string | null;
      nextN: number;
      level: Level;
      /** A form filled in for this plan before (v1's brief): its facts are kept, not asked. */
      form: { at: string } | null;
      ids: [string, string];
      /** Start over keeping What I know: those facts are known (not asked), assumptions too. */
      kept?: { known: QuestionKey[]; assumed: QuestionKey[] };
    }
  /**
   * Start over (UX §8.6): a new conversation in this one's place (`fromId`, so two tabs start
   * over once). The numbering goes on; What I know is kept when ticked, else `brief` (fresh).
   */
  | {
      type: 'restart';
      fromId: string;
      id: string;
      at: string;
      keep: boolean;
      brief: DesignBrief;
      beforeFp: string;
      afterFp: string | null;
      level: Level;
      ids: [string, string];
    }
  /**
   * Bring this back (criterion 27): an older proposal or version made again as V(n+1), with no
   * request: its app line, then its card (the proposal record is written beside this).
   */
  | {
      type: 'bringBack';
      at: string;
      ids: { event: string; turn: string };
      proposalId: string;
      /** What it was ("V2", "V4B"). */
      from: string;
    }
  | {
      type: 'answer';
      turnId: string;
      key: QuestionKey;
      brief: DesignBrief;
      at: string;
      id: string;
      level: Level;
    }
  | { type: 'skip'; turnId: string; key: QuestionKey; at: string; id: string; level: Level }
  | { type: 'justDesign'; at: string; ids: [string, string]; level: Level }
  | { type: 'formFilled'; brief: DesignBrief; at: string; ids: [string, string]; level: Level }
  | { type: 'editFact'; key: QuestionKey; brief: DesignBrief; at: string; id: string; level: Level }
  | { type: 'confirmFact'; key: QuestionKey }
  /** A setting of the brief that is no fact of What I know (Thorough or Quick, say). */
  | { type: 'setBrief'; brief: DesignBrief }
  | { type: 'draft'; text: string }
  | {
      type: 'ask';
      at: string;
      ids: [string, string];
      scope: ScopeRef;
      words: string;
      reason: TurnOf<'cost-ask'>['reason'];
      estimate: TurnOf<'cost-ask'>['estimate'];
      finish?: TurnOf<'cost-ask'>['finish'];
      /** A designer's plan: its card follows the reply (no bubble of the person's). */
      talk?: TurnOf<'cost-ask'>['talk'];
      just?: ScopeRef | null;
      alt?: TurnOf<'cost-ask'>['alt'];
    }
  /** The figure on an open cost card, worked out again (the plan or the prices moved). */
  | { type: 'costRefresh'; turnId: string; estimate: TurnOf<'cost-ask'>['estimate'] }
  | {
      type: 'costAnswer';
      turnId: string;
      answer: 'go' | 'cheaper' | 'not-now';
      at: string;
      id: string;
    }
  | {
      type: 'propose';
      at: string;
      /** The person's turn (none when it follows a cost card), and the proposal's. */
      ids: { person: string | null; turn: string };
      proposalId: string;
      scope: ScopeRef;
      words: string;
    }
  | { type: 'scopeNext'; at: string; id: string }
  | {
      type: 'accepted';
      id: string;
      at: string;
      proposalId: string;
      n: number;
      letter: string;
      changes: string[];
      total: number;
      left: string[];
    }
  | { type: 'undone'; eventId: string }
  | { type: 'redone'; eventId: string }
  | { type: 'event'; id: string; at: string; event: TalkEvent }
  | {
      type: 'decisionAdd';
      id: string;
      at: string;
      kind: Decision['kind'];
      text: string;
      from: string | null;
    }
  | { type: 'decisionEdit'; id: string; text: string }
  /** A message to the designer: the person's turn, its reply on its way. */
  | {
      type: 'send';
      id: string;
      at: string;
      text: string;
      sent: string;
      /** The short names the request used, kept (never renamed once given). */
      aliases?: Record<string, string>;
    }
  /** The text streamed so far, kept as the tab hides (a phone may kill it). */
  | { type: 'checkpoint'; turnId: string; text: string; chars: number }
  | {
      type: 'replyDone';
      turnId: string;
      id: string;
      at: string;
      reply: TalkReply;
      /** The app's lines about what it couldn't use ("Walls stay: …"). */
      lines: string[];
      echo: string;
      usage: Usage[];
      /** A concern's measured lines (the probe), worked out by the app. */
      probe: ProbeLines | null;
      /** Ids for what the reply notes and the app lines: one each, in order. */
      ids: string[];
      /** The reply was asked to sum up the turns up to this one. */
      fold: { upTo: string; hard: boolean } | null;
    }
  | {
      type: 'replyFailed';
      turnId: string;
      id: string;
      at: string;
      error: string;
      /** Text that streamed before it failed, kept as cut off. */
      text: string;
      usage: Usage[];
    }
  | {
      type: 'replyCut';
      turnId: string;
      ids: [string, string];
      at: string;
      text: string;
      usage: Usage[];
      cut: 'stopped' | 'tab';
      /** The app's line ("Stopped. The text so far is kept. ~US$0.02, may still be billed."). */
      line: string;
    }
  /** Try again: the same message, its reply on its way again. */
  | { type: 'retry'; turnId: string; at: string }
  /** Edit: a message not answered goes back into the composer. */
  | { type: 'unsend'; turnId: string }
  /** A designer's question answered with a chip (free when it is a What I know fact). */
  | {
      type: 'talkAnswer';
      turnId: string;
      index: number;
      words: string;
      id: string;
      at: string;
      brief?: DesignBrief;
      key?: QuestionKey;
    }
  /** A widening fact the reply asked about, answered Yes (applied) or No. */
  | { type: 'talkConfirm'; turnId: string; index: number; yes: boolean; id: string; at: string }
  /** Changes made by hand since the last accept, said once each. */
  | { type: 'handEdits'; id: string; at: string; labels: string[] }
  | { type: 'decisionDelete'; id: string }
  | { type: 'decisionRestore'; id: string };

/** A new conversation: the greeting and the first questions (or, after a form, the offer). */
export function newConversation(a: Extract<TalkAction, { type: 'start' }>): Conversation {
  const known = a.kept ? a.kept.known : a.form ? formKnows(a.brief) : [];
  const conv: Conversation = {
    projectId: a.projectId,
    id: a.id,
    recordVersion: TALK_RECORD_VERSION,
    rev: 0,
    startedAt: a.at,
    levelId: a.levelId,
    start: { at: a.at, beforeFp: a.beforeFp, afterFp: a.afterFp },
    brief: a.brief,
    assumed: a.kept ? a.kept.assumed.filter((k) => known.includes(k)) : [],
    known,
    met: false,
    settled: [],
    nextN: a.nextN,
    decisions: [],
    turns: [],
    draft: '',
    aliases: {},
    notes: [],
    summary: null,
    foldMisses: 0,
    lastSentAt: null,
    handSeen: [],
    aside: { usd: 0, tokens: 0, estimated: false },
  };
  const date = a.form ? dayOf(a.form.at) : '';
  const greet: Turn = {
    kind: 'designer',
    id: a.ids[0],
    at: a.at,
    text: cut(greetingText(a.level), L.designer),
    lines: [],
    after: cut(
      a.kept
        ? `I’ve kept what I know about you: ${formSummary(a.brief)}. Change any of it in What I know about you.`
        : a.form
          ? `I’ve kept what you told me in the form on ${date}: ${formSummary(a.brief)}. Change any of it in What I know about you.`
          : GREETING_NEXT,
      L.after,
    ),
  };
  return { ...conv, turns: [greet, ...after(conv, a.level, a.ids[1], a.at)] };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "3 Nov" from an ISO time (UTC: the same words in every tab). */
export const dayOf = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

/** What was asked so far, answered, skipped or assumed, and what a form told. */
export function doneKeys(conv: Conversation): Set<QuestionKey> {
  const out = new Set<QuestionKey>([...conv.known, ...conv.settled]);
  for (const t of conv.turns) {
    if (t.kind !== 'app-question') continue;
    for (const k of t.keys) if (t.done[k]) out.add(k);
  }
  for (const k of conv.assumed) out.add(k);
  return out;
}

/** Whether the first meeting is over: no question waits and the offer has been made. */
export const meetingOver = (conv: Conversation) =>
  conv.met || conv.turns.some((t) => t.kind === 'scope');

/** The question message waiting for answers, if any. */
export const openQuestions = (conv: Conversation): TurnOf<'app-question'> | null => {
  for (let i = conv.turns.length - 1; i >= 0; i--) {
    const t = conv.turns[i];
    if (t?.kind === 'app-question') return t.keys.every((k) => t.done[k]) ? null : t;
  }
  return null;
};

/** After a question is settled: the next message of questions, or the scope offer. */
function after(conv: Conversation, level: Level, id: string, at: string): Turn[] {
  if (meetingOver(conv)) return [];
  const done = doneKeys(conv);
  const known = new Set(conv.known);
  const asked = [...done].filter((k) => !known.has(k)).length;
  const next = nextQuestions(done, conv.brief, level, asked);
  if (next) {
    const lead = next.lead ? cut(next.lead, L.lead) : null;
    return [{ kind: 'app-question', id, at, lead, keys: next.keys, done: {} }];
  }
  return [{ kind: 'scope', id, at, next: false }];
}

const push = (conv: Conversation, ...turns: Turn[]): Conversation => {
  const all = [...conv.turns, ...turns];
  if (all.length <= MAX_TURNS) return { ...conv, turns: all };
  // The oldest turns go; what the first meeting settled stays (L10).
  const full = { ...conv, turns: all };
  return {
    ...conv,
    met: meetingOver(full),
    settled: [...doneKeys(full)].filter((k) => !conv.known.includes(k)),
    turns: all.slice(all.length - MAX_TURNS),
  };
};

const replaceTurn = (conv: Conversation, t: Turn): Conversation => ({
  ...conv,
  turns: conv.turns.map((x) => (x.id === t.id ? t : x)),
});

const findTurn = <K extends Turn['kind']>(conv: Conversation, id: string, kind: K) => {
  const t = conv.turns.find((x) => x.id === id);
  return t?.kind === kind ? (t as TurnOf<K>) : null;
};

/** One question settled: its answer in words, then what comes next once the message is done. */
function settle(
  conv: Conversation,
  turnId: string,
  key: QuestionKey,
  done: { state: 'answered' | 'skipped'; words: string },
  brief: DesignBrief,
  level: Level,
  id: string,
  at: string,
): Conversation {
  const t = findTurn(conv, turnId, 'app-question');
  if (!t || !t.keys.includes(key) || t.done[key]) return conv;
  const turn: TurnOf<'app-question'> = {
    ...t,
    done: { ...t.done, [key]: { ...done, words: cut(done.words, L.words) } },
  };
  const assumed =
    done.state === 'skipped'
      ? [...new Set([...conv.assumed, key])]
      : conv.assumed.filter((k) => k !== key);
  let next = replaceTurn({ ...conv, brief, assumed }, turn);
  if (turn.keys.every((k) => turn.done[k])) next = push(next, ...after(next, level, id, at));
  return next;
}

export function talk(conv: Conversation, a: TalkAction): Conversation {
  switch (a.type) {
    case 'start':
      // A conversation there already is stays (two tabs opening the panel at once).
      return conv?.id ? conv : newConversation(a);
    case 'restart': {
      if (!conv || conv.id !== a.fromId) return conv;
      // Kept after a first meeting that ended: nothing is asked again (what was skipped stays
      // as it was); kept part-way, what wasn't answered yet is still asked.
      const known = meetingOver(conv)
        ? [...QUESTION_KEYS]
        : [...new Set([...conv.known, ...doneKeys(conv)])];
      return newConversation({
        type: 'start',
        id: a.id,
        at: a.at,
        projectId: conv.projectId,
        levelId: conv.levelId,
        brief: a.keep ? conv.brief : a.brief,
        beforeFp: a.beforeFp,
        afterFp: a.afterFp,
        nextN: conv.nextN,
        level: a.level,
        form: null,
        ids: a.ids,
        ...(a.keep ? { kept: { known, assumed: conv.assumed } } : {}),
      });
    }
    case 'bringBack': {
      if (conv.turns.some((t) => t.kind === 'proposal' && t.proposalId === a.proposalId))
        return conv;
      const text = `Brought back ${a.from} as V${conv.nextN}, checked on your plan as it is now.`;
      return push(
        { ...conv, nextN: conv.nextN + 1 },
        {
          kind: 'event',
          id: a.ids.event,
          at: a.at,
          event: { type: 'note', text: cut(text, L.note) },
        },
        { kind: 'proposal', id: a.ids.turn, at: a.at, proposalId: a.proposalId },
      );
    }
    case 'answer':
      return settle(
        conv,
        a.turnId,
        a.key,
        { state: 'answered', words: factText(a.key, a.brief, a.level) },
        a.brief,
        a.level,
        a.id,
        a.at,
      );
    case 'skip':
      return settle(
        conv,
        a.turnId,
        a.key,
        { state: 'skipped', words: 'Skipped' },
        conv.brief,
        a.level,
        a.id,
        a.at,
      );
    case 'justDesign': {
      if (meetingOver(conv)) return conv;
      const done = doneKeys(conv);
      const made = assume(conv.brief, a.level, done);
      // The questions still open close as assumed.
      const turns = conv.turns.map((t) => {
        if (t.kind !== 'app-question' || t.keys.every((k) => t.done[k])) return t;
        const d = { ...t.done };
        for (const k of t.keys) {
          if (!d[k]) {
            const fact = factText(k, made.brief, a.level);
            d[k] = { state: 'assumed' as const, words: cut(`Assumed: ${fact}`, L.words) };
          }
        }
        return { ...t, done: d };
      });
      const said: Turn = {
        kind: 'designer',
        id: a.ids[0],
        at: a.at,
        text: made.lines.length ? 'Fine, I’ll start. I’ve assumed:' : 'Fine, I’ll start.',
        lines: made.lines.slice(0, 12).map((l) => cut(l, L.line)),
        after: made.lines.length ? 'These are in What I know about you; tap any to change it.' : '',
      };
      return push(
        {
          ...conv,
          turns,
          brief: made.brief,
          assumed: [...new Set([...conv.assumed, ...made.keys])],
        },
        said,
        { kind: 'scope', id: a.ids[1], at: a.at, next: false },
      );
    }
    case 'formFilled': {
      const over = meetingOver(conv);
      const turns = conv.turns.map((t) => {
        if (t.kind !== 'app-question' || t.keys.every((k) => t.done[k])) return t;
        const d = { ...t.done };
        for (const k of t.keys) {
          if (!d[k]) {
            d[k] = {
              state: 'answered' as const,
              words: cut(factText(k, a.brief, a.level), L.words),
            };
          }
        }
        return { ...t, done: d };
      });
      const known = [...new Set([...conv.known, ...formKnows(a.brief)])];
      const line: Turn = {
        kind: 'event',
        id: a.ids[0],
        at: a.at,
        event: { type: 'note', text: 'You filled in the form.' },
      };
      const next = { ...conv, turns, brief: a.brief, known, assumed: [] };
      return over ? push(next, line) : push(next, line, ...after(next, a.level, a.ids[1], a.at));
    }
    case 'editFact': {
      const was = factText(a.key, conv.brief, a.level);
      const now = factText(a.key, a.brief, a.level);
      const next = { ...conv, brief: a.brief, assumed: conv.assumed.filter((k) => k !== a.key) };
      if (was === now) return next;
      return push(next, {
        kind: 'event',
        id: a.id,
        at: a.at,
        event: {
          type: 'fact',
          key: a.key,
          text: cut(`You changed: ${label(a.key)} ${was} → ${now}.`, L.note),
        },
      });
    }
    case 'setBrief':
      return { ...conv, brief: a.brief };
    case 'confirmFact':
      return { ...conv, assumed: conv.assumed.filter((k) => k !== a.key) };
    case 'draft':
      return conv.draft === a.text ? conv : { ...conv, draft: a.text.slice(0, DRAFT_CHARS) };
    case 'ask':
      return push(
        conv,
        ...(a.talk
          ? []
          : [
              {
                kind: 'person' as const,
                id: a.ids[0],
                at: a.at,
                text: personText(a.scope, a.words),
              },
            ]),
        {
          kind: 'cost-ask',
          id: a.ids[1],
          at: a.at,
          scope: scopeCut(a.scope),
          words: cut(a.words, DRAFT_CHARS),
          reason: a.reason,
          estimate: a.estimate,
          state: 'open',
          answerId: null,
          finish: a.finish ?? null,
          talk: a.talk
            ? {
                replyTo: a.talk.replyTo,
                title: cut(a.talk.title, 60),
                intent: cut(a.talk.intent, 600),
              }
            : null,
          just: a.just ? scopeCut(a.just) : null,
          alt: a.alt ?? null,
        },
      );
    case 'costAnswer': {
      const t = findTurn(conv, a.turnId, 'cost-ask');
      if (!t || t.state !== 'open') return conv;
      const next = replaceTurn(conv, {
        ...t,
        state: a.answer === 'go' ? 'go' : a.answer === 'cheaper' ? 'cheaper' : 'not-now',
        answerId: a.id,
      });
      return a.answer === 'not-now'
        ? push(next, { kind: 'person', id: a.id, at: a.at, text: 'Not now' })
        : next;
    }
    case 'costRefresh': {
      const t = findTurn(conv, a.turnId, 'cost-ask');
      if (!t || t.state !== 'open') return conv;
      if (JSON.stringify(t.estimate) === JSON.stringify(a.estimate)) return conv;
      return replaceTurn(conv, { ...t, estimate: a.estimate });
    }
    case 'propose': {
      if (conv.turns.some((t) => t.kind === 'proposal' && t.proposalId === a.proposalId))
        return conv;
      const turns: Turn[] = [];
      if (a.ids.person) {
        turns.push({
          kind: 'person',
          id: a.ids.person,
          at: a.at,
          text: personText(a.scope, a.words),
        });
      }
      turns.push({ kind: 'proposal', id: a.ids.turn, at: a.at, proposalId: a.proposalId });
      return push({ ...conv, nextN: conv.nextN + 1, draft: '' }, ...turns);
    }
    case 'scopeNext': {
      const last = conv.turns[conv.turns.length - 1];
      if (last?.kind === 'scope') return conv;
      return push(conv, { kind: 'scope', id: a.id, at: a.at, next: true });
    }
    case 'accepted':
      return push(conv, {
        kind: 'event',
        id: a.id,
        at: a.at,
        event: {
          type: 'accepted',
          proposalId: a.proposalId,
          n: a.n,
          letter: a.letter,
          changes: a.changes,
          total: a.total,
          left: a.left.slice(0, 20).map((x) => cut(x, L.left)),
          undone: false,
        },
      });
    case 'undone':
    case 'redone': {
      const t = findTurn(conv, a.eventId, 'event');
      if (!t || t.event.type !== 'accepted') return conv;
      const undone = a.type === 'undone';
      if (t.event.undone === undone) return conv;
      return replaceTurn(conv, { ...t, event: { ...t.event, undone } });
    }
    case 'event':
      return push(conv, { kind: 'event', id: a.id, at: a.at, event: eventCut(a.event) });
    case 'decisionAdd': {
      const text = a.text.trim().slice(0, DECISION_CHARS);
      if (!text) return conv;
      const live = conv.decisions.filter((d) => !d.deleted);
      if (live.some((d) => d.text === text && d.kind === a.kind)) return conv;
      const decisions = [
        ...conv.decisions,
        { id: a.id, kind: a.kind, text, at: a.at, from: a.from, deleted: false },
      ];
      // The oldest go first past the cap (deleted ones before any that stand).
      const over = decisions.length - MAX_DECISIONS;
      const drop = new Set(
        over > 0
          ? [...decisions.filter((d) => d.deleted), ...decisions.filter((d) => !d.deleted)]
              .slice(0, over)
              .map((d) => d.id)
          : [],
      );
      return { ...conv, decisions: decisions.filter((d) => !drop.has(d.id)) };
    }
    case 'decisionEdit': {
      const text = a.text.trim().slice(0, DECISION_CHARS);
      if (!text) return conv;
      return {
        ...conv,
        decisions: conv.decisions.map((d) => (d.id === a.id ? { ...d, text } : d)),
      };
    }
    case 'send': {
      // One reply at a time: a second Send waits for the first.
      if (pendingReply(conv)) return conv;
      return push(
        { ...conv, draft: '', lastSentAt: a.at, ...(a.aliases ? { aliases: a.aliases } : {}) },
        {
          kind: 'person',
          id: a.id,
          at: a.at,
          text: cutLines(a.text, L.person) || '…',
          sent: a.sent.slice(0, SENT_CHARS),
          reply: {
            state: 'pending',
            error: null,
            checkpoint: '',
            chars: 0,
            startedAt: a.at,
            usage: [],
          },
        },
      );
    }
    case 'checkpoint': {
      const t = findTurn(conv, a.turnId, 'person');
      if (!t?.reply || t.reply.state !== 'pending') return conv;
      return replaceTurn(conv, {
        ...t,
        reply: { ...t.reply, checkpoint: cutLines(a.text, L.designer), chars: a.chars },
      });
    }
    case 'replyDone':
      return replyDone(conv, a);
    case 'replyFailed': {
      const t = findTurn(conv, a.turnId, 'person');
      if (!t?.reply || t.reply.state !== 'pending') return conv;
      const text = cutLines(a.text, L.designer);
      const next = replaceTurn(conv, {
        ...t,
        reply: {
          ...t.reply,
          state: 'failed',
          error: cut(a.error, 300),
          checkpoint: '',
          usage: text ? [] : a.usage.slice(0, 8),
        },
      });
      return text ? push(next, cutTurn(a.id, a.at, t.id, text, a.usage, 'network')) : next;
    }
    case 'replyCut': {
      const t = findTurn(conv, a.turnId, 'person');
      if (!t?.reply || t.reply.state !== 'pending') return conv;
      const text = cutLines(a.text, L.designer);
      const next = replaceTurn(conv, {
        ...t,
        // A closed tab's reply was never answered (Try again, Edit); a stopped one was cut.
        reply: {
          ...t.reply,
          state: a.cut === 'tab' ? 'failed' : 'cut',
          checkpoint: '',
          usage: text ? [] : a.usage.slice(0, 8),
        },
      });
      return push(next, ...(text ? [cutTurn(a.ids[0], a.at, t.id, text, a.usage, a.cut)] : []), {
        kind: 'event',
        id: a.ids[1],
        at: a.at,
        event: { type: 'note', text: cut(a.line, L.note) },
      });
    }
    case 'retry': {
      const t = findTurn(conv, a.turnId, 'person');
      if (!t?.reply || (t.reply.state !== 'failed' && t.reply.state !== 'cut')) return conv;
      if (pendingReply(conv)) return conv;
      // Only the newest message sent: an older one would answer out of turn.
      const newest = [...conv.turns]
        .reverse()
        .find((x) => x.kind === 'person' && x.sent !== undefined);
      if (newest?.id !== t.id) return conv;
      return replaceTurn(
        { ...conv, lastSentAt: a.at },
        { ...t, reply: { ...t.reply, state: 'pending', error: null, startedAt: a.at } },
      );
    }
    case 'unsend': {
      const t = findTurn(conv, a.turnId, 'person');
      if (!t?.reply || t.reply.state === 'pending' || t.reply.state === 'done') return conv;
      const gone = (x: Turn) =>
        x.id === t.id || (x.kind === 'designer' && x.talk?.replyTo === t.id);
      const spentHere = spentOf(
        conv.turns
          .filter(gone)
          .flatMap((x) =>
            x.kind === 'person'
              ? (x.reply?.usage ?? [])
              : x.kind === 'designer'
                ? (x.talk?.usage ?? [])
                : [],
          ),
      );
      const aside = {
        usd:
          conv.aside.usd === null || spentHere.usd === null ? null : conv.aside.usd + spentHere.usd,
        tokens: conv.aside.tokens + spentHere.tokens,
        estimated: conv.aside.estimated || spentHere.estimated,
      };
      return {
        ...conv,
        aside,
        turns: conv.turns.filter((x) => !gone(x)),
        draft: t.text.slice(0, DRAFT_CHARS),
      };
    }
    case 'talkAnswer': {
      const t = findTurn(conv, a.turnId, 'designer');
      const q = t?.talk?.questions[a.index];
      if (!t?.talk || !q || t.talk.answered[a.index] !== undefined) return conv;
      const words = cut(a.words, L.words);
      const next = replaceTurn(conv, {
        ...t,
        talk: { ...t.talk, answered: { ...t.talk.answered, [a.index]: words } },
      });
      const key = a.key;
      const known = a.brief
        ? {
            ...next,
            brief: a.brief,
            assumed: key ? next.assumed.filter((k) => k !== key) : next.assumed,
          }
        : next;
      return push(known, { kind: 'person', id: a.id, at: a.at, text: words });
    }
    case 'talkConfirm': {
      const t = findTurn(conv, a.turnId, 'designer');
      const c = t?.talk?.confirms[a.index];
      if (!t?.talk || !c || c.answer !== null) return conv;
      const confirms = t.talk.confirms.map((x, k) =>
        k === a.index ? { ...x, answer: a.yes ? ('yes' as const) : ('no' as const) } : x,
      );
      let next = replaceTurn(conv, { ...t, talk: { ...t.talk, confirms } });
      if (a.yes) {
        const f = applyFacts(next.brief, [
          { key: c.key, text: c.text, number: c.number, choice: c.choice },
        ]);
        next = {
          ...next,
          brief: f.brief,
          assumed: next.assumed.filter((k) => k !== factQuestion(c.key)),
        };
      }
      return push(next, {
        kind: 'person',
        id: a.id,
        at: a.at,
        text: cut(`${a.yes ? 'Yes' : 'No'}: ${c.ask}`, L.person),
      });
    }
    case 'handEdits': {
      const fresh = a.labels.filter((l) => !conv.handSeen.includes(l));
      if (!fresh.length) return conv;
      return push(
        { ...conv, handSeen: [...conv.handSeen, ...fresh].slice(-200) },
        {
          kind: 'event',
          id: a.id,
          at: a.at,
          event: {
            type: 'hand-edits',
            lines: fresh.slice(0, 3).map((l) => cut(l, L.line)),
            more: Math.max(0, fresh.length - 3),
          },
        },
      );
    }
    case 'decisionDelete':
    case 'decisionRestore':
      return {
        ...conv,
        decisions: conv.decisions.map((d) =>
          d.id === a.id ? { ...d, deleted: a.type === 'decisionDelete' } : d,
        ),
      };
  }
}

/** The message whose reply is on its way, if any (one at a time). */
export const pendingReply = (conv: Conversation): TurnOf<'person'> | null =>
  (conv.turns.find((t) => t.kind === 'person' && t.reply?.state === 'pending') as
    | TurnOf<'person'>
    | undefined) ?? null;

/** A reply cut off: its text so far, kept as a plain reply that can't be acted on. */
function cutTurn(
  id: string,
  at: string,
  replyTo: string,
  text: string,
  usage: Usage[],
  how: 'stopped' | 'network' | 'tab',
): Turn {
  return {
    kind: 'designer',
    id,
    at,
    text,
    lines: [],
    after: '',
    talk: {
      replyTo,
      kind: 'reply',
      echo: JSON.stringify({ kind: 'reply', say: text, cut: true }).slice(0, SENT_CHARS),
      usage: usage.slice(0, 8),
      cut: how,
      noted: [],
      questions: [],
      answered: {},
      confirms: [],
      concern: null,
      plan: null,
    },
  };
}

/**
 * A reply in: the designer's turn, what it notes (Decisions, What I know, notes for the ID,
 * each a line with Edit), the app's own lines, and a summary of older turns when asked for.
 */
function replyDone(
  conv: Conversation,
  a: Extract<TalkAction, { type: 'replyDone' }>,
): Conversation {
  const t = findTurn(conv, a.turnId, 'person');
  if (!t?.reply || t.reply.state !== 'pending') return conv;
  const ids = [...a.ids];
  const take = () => ids.shift() ?? `${a.id}-${ids.length}`;
  const r = a.reply;
  const noted: TalkNoted[] = [];
  let next = replaceTurn(conv, { ...t, reply: { ...t.reply, state: 'done', checkpoint: '' } });
  for (const d of r.memory.decisions) {
    const id = take();
    const before = next.decisions.length;
    next = talk(next, {
      type: 'decisionAdd',
      id,
      at: a.at,
      kind: d.kind,
      text: d.text,
      from: null,
    });
    if (next.decisions.length > before || next.decisions.some((x) => x.id === id)) {
      noted.push({ kind: 'decision', text: cut(`Noted in Decisions: ${d.text}`, 300), ref: id });
    }
  }
  // What would widen the next paid run (walls loosened, a higher budget) is asked, not done.
  const wide = r.memory.facts.filter((x) => widens(next.brief, x));
  const facts = r.memory.facts.filter((x) => !wide.includes(x));
  if (facts.length) {
    const f = applyFacts(next.brief, facts);
    next = { ...next, brief: f.brief, assumed: next.assumed.filter((k) => !f.keys.includes(k)) };
    f.lines.forEach((l, k) =>
      noted.push({
        kind: 'fact',
        text: cut(`Noted in What I know: ${l}`, 300),
        ref: f.keys[k] ?? null,
      }),
    );
  }
  for (const n of r.memory.notes) {
    const id = take();
    next = {
      ...next,
      notes: [...next.notes, { id, text: cut(n, L.note), turnId: a.id }].slice(-60),
    };
    noted.push({ kind: 'note', text: cut(`Noted for your ID: ${n}`, 300), ref: id });
  }
  const concern = r.concern
    ? {
        rule: r.concern.rule,
        lines: a.probe?.lines ?? [],
        hdb: a.probe?.hdb ?? false,
        alt: a.probe?.hdb ? null : r.concern.alt,
      }
    : null;
  const said: Turn = {
    kind: 'designer',
    id: a.id,
    at: a.at,
    text: cutLines(r.say, L.designer),
    lines: (r.plan?.assumptions ?? []).slice(0, 5).map((l) => cut(l, L.line)),
    after: '',
    talk: {
      replyTo: t.id,
      kind: r.kind,
      echo: a.echo.slice(0, SENT_CHARS),
      usage: a.usage.slice(0, 8),
      cut: null,
      noted: noted.slice(0, 12),
      questions: r.questions,
      answered: {},
      confirms: wide.slice(0, 6).map((x) => ({
        key: x.key,
        text: cut(x.text, 200),
        number: x.number,
        choice: x.choice,
        ask: cut(confirmText(x), 200),
        answer: null,
      })),
      concern,
      plan: r.plan,
    },
  };
  const appLines: Turn[] = a.lines.slice(0, 3).map((text) => ({
    kind: 'event',
    id: take(),
    at: a.at,
    event: { type: 'note', text: cut(text, L.note) },
  }));
  next = push(next, said, ...appLines);
  if (a.fold) {
    const text =
      r.fold ?? (a.fold.hard || next.foldMisses >= 2 ? mechanicalSummary(next, a.fold.upTo) : null);
    if (text) {
      next = push(
        { ...next, summary: { upTo: a.fold.upTo, text: cut(text, 1200) }, foldMisses: 0 },
        {
          kind: 'event',
          id: take(),
          at: a.at,
          event: {
            type: 'note',
            text: 'I’ve summed up our earlier messages in Decisions and What I know, so I can keep the conversation short. Nothing is lost.',
          },
        },
      );
    } else next = { ...next, foldMisses: next.foldMisses + 1 };
  }
  return next;
}

const label = (k: QuestionKey) =>
  ({
    who: 'who lives here',
    sleeping: 'who sleeps where',
    mobility: 'getting about',
    cooking: 'cooking',
    wfh: 'working from home',
    budget: 'budget',
    walls: 'walls',
    style: 'style',
    anything: 'anything else',
  })[k];

/** The person's turn for a scope button: their words, or what they asked for. */
const personText = (scope: ScopeRef, words: string) =>
  cutLines(words.trim() ? words : `Design ${scope.all ? 'the whole flat' : scope.label}`, L.person);

/** A scope as kept: its label cut. */
export const scopeCut = (s: ScopeRef): ScopeRef => ({
  ...s,
  label: cut(s.label, L.label),
  spaces: s.spaces.slice(0, 30),
});

const eventCut = (e: TalkEvent): TalkEvent =>
  e.type === 'note' || e.type === 'fact'
    ? { ...e, text: cut(e.text, L.note) }
    : e.type === 'accepted'
      ? { ...e, left: e.left.slice(0, 20).map((x) => cut(x, L.left)) }
      : e;
