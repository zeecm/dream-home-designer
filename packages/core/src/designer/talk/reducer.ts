import type { Level } from '../../schema';
import { type Kept, MAX_KEPT } from '../rules/kept';
import { MAX_RULES, type Rule, roundN } from '../rules/schema';
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
import {
  type TalkReply,
  applyFacts,
  confirmText,
  factQuestion,
  filterClaims,
  widens,
} from './reply';
import {
  type Conversation,
  DECISION_CHARS,
  DRAFT_CHARS,
  type Decision,
  TALK_LIMITS as L,
  MAX_DECISIONS,
  MAX_POINTERS,
  MAX_RULE_RECORDS,
  MAX_TURNS,
  type Pointer,
  QUESTION_KEYS,
  type QuestionKey,
  type RuleOffer,
  type RuleVet,
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
      /** Start over keeping What I know: the house rules go on too (Q2), and kept pieces. */
      rules?: Rule[];
      keptPieces?: Kept[];
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
      /** The level the new conversation designs (the one shown); else the same as before. */
      levelId?: string;
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
      /** The house rules it is checked on (3a.8). */
      rules?: number;
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
      /** Make this a rule from a Decision (priced): its reply offers the rule. */
      ruleAsk?: { decisionId: string };
      /** What it points at (the composer's chips, or a popover's one). */
      pointers?: Pointer[];
      /**
       * Sent from outside the composer (a popover's paid row, Make this a rule): what is
       * typed there and its chips stay for the person's own message.
       */
      keepDraft?: boolean;
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
      /** The rule it offers, as the app built and vetted it (when the reply had one). */
      offer?: { rule: Rule; vet: RuleVet } | null;
      /** Said by the app in the reply's place, when the claims filter emptied it. */
      appLine?: string;
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
  | { type: 'decisionRestore'; id: string }
  /** House rules (slice 3a): the offer answered, and Your rules' edits. */
  | {
      type: 'ruleKeep';
      turnId: string;
      /** The numbers as the offer's fields have them (Change the numbers). */
      n?: number | null;
      /** The app line that follows (Moved to Your rules, for a Decision made a rule). */
      id: string;
      at: string;
    }
  | { type: 'ruleOnce'; turnId: string; id: string; at: string }
  /**
   * A proposal's second look suggested a house rule (slice 3b): the designer's line with the
   * offer under it, answered as a reply's offer is (Keep as a rule, Just this once). Free.
   */
  | {
      type: 'lookOffer';
      id: string;
      at: string;
      /** The proposal's turn. */
      replyTo: string;
      /** "V4", for the line. */
      version: string;
      line: string;
      offer: { rule: Rule; vet: RuleVet };
    }
  | { type: 'ruleReplace'; turnId: string; at: string }
  | { type: 'ruleKeepYours'; turnId: string }
  /** Just this once's Make it a rule (free): the offer opens again, vetted again. */
  | { type: 'ruleReopen'; decisionId: string; vet: RuleVet }
  | { type: 'ruleEdit'; ruleId: string; n?: number | null; name?: string }
  | { type: 'ruleDelete'; ruleId: string }
  | { type: 'ruleRestore'; ruleId: string }
  /** Pointers (slice 3a): a chip added to the composer or taken off (at most five). */
  | { type: 'pointerAdd'; pointer: Pointer }
  | { type: 'pointerRemove'; id: string }
  /** Keep this: a piece kept where it is, with its app line; Let the designer move it. */
  | { type: 'keepItem'; kept: Kept; id: string; at: string; text: string }
  | { type: 'unkeepItem'; keptId: string; id: string; at: string; text: string }
  | { type: 'tipSeen'; tip: 'point' };

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
    rules: (a.rules ?? []).slice(0, MAX_RULES),
    kept: (a.keptPieces ?? []).slice(0, MAX_KEPT),
    keptGone: [],
    draftPointers: [],
    tips: [],
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
        levelId: a.levelId ?? conv.levelId,
        brief: a.keep ? conv.brief : a.brief,
        beforeFp: a.beforeFp,
        afterFp: a.afterFp,
        nextN: conv.nextN,
        level: a.level,
        form: null,
        ids: a.ids,
        ...(a.keep
          ? {
              kept: { known, assumed: conv.assumed },
              rules: liveRules(conv),
              keptPieces: conv.kept,
            }
          : {}),
      });
    }
    case 'bringBack': {
      if (conv.turns.some((t) => t.kind === 'proposal' && t.proposalId === a.proposalId))
        return conv;
      const rules = a.rules ?? 0;
      const text = `Brought back ${a.from} as V${conv.nextN}, checked on your plan as it is now${
        rules ? ` and on your ${rules === 1 ? 'rule' : `${rules} rules`}` : ''
      }.`;
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
      const pointers = (a.pointers ?? []).slice(0, MAX_POINTERS);
      return push(
        {
          ...conv,
          ...(a.keepDraft ? {} : { draft: '', draftPointers: [] }),
          lastSentAt: a.at,
          ...(a.aliases ? { aliases: a.aliases } : {}),
        },
        {
          kind: 'person',
          id: a.id,
          at: a.at,
          text: cutLines(a.text, L.person) || '…',
          sent: a.sent.slice(0, SENT_CHARS),
          ...(a.ruleAsk ? { ruleAsk: a.ruleAsk } : {}),
          ...(pointers.length ? { pointers } : {}),
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
      // What came of it is kept, less any "I can't check" (a tab's checkpoint is raw text).
      const text = cutLines(filterClaims(a.text).say, L.designer);
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
      // What came of it is kept, less any "I can't check" (a tab's checkpoint is raw text).
      const text = cutLines(filterClaims(a.text).say, L.designer);
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
    case 'ruleKeep':
    case 'ruleOnce':
    case 'ruleReplace':
    case 'ruleKeepYours':
    case 'ruleReopen':
    case 'ruleEdit':
    case 'ruleDelete':
    case 'ruleRestore':
      return ruleAction(conv, a);
    case 'lookOffer': {
      if (conv.turns.some((t) => t.id === a.id)) return conv;
      const said: Turn = {
        kind: 'designer',
        id: a.id,
        at: a.at,
        text: cutLines(`From my second look at ${a.version}: ${a.line}`, L.designer),
        lines: [],
        after: '',
        talk: {
          replyTo: a.replyTo,
          kind: 'reply',
          echo: '',
          usage: [],
          cut: null,
          noted: [],
          questions: [],
          answered: {},
          confirms: [],
          concern: null,
          plan: null,
          offer: { ...a.offer, state: a.offer.vet.ok ? 'open' : 'refused' },
          look: true,
        },
      };
      return push(conv, said);
    }
    case 'pointerAdd': {
      const p = a.pointer;
      const same = conv.draftPointers.some(
        (x) =>
          x.id === p.id ||
          (x.kind === p.kind &&
            x.targetId === p.targetId &&
            (p.kind !== 'spot' || (x.at.x === p.at.x && x.at.y === p.at.y)) &&
            JSON.stringify(x.version) === JSON.stringify(p.version)),
      );
      if (same || conv.draftPointers.length >= MAX_POINTERS) return conv;
      return { ...conv, draftPointers: [...conv.draftPointers, p] };
    }
    case 'pointerRemove':
      if (!conv.draftPointers.some((x) => x.id === a.id)) return conv;
      return { ...conv, draftPointers: conv.draftPointers.filter((x) => x.id !== a.id) };
    case 'keepItem': {
      const k = a.kept;
      const already = conv.kept.some(
        (x) => x.id === k.id || (k.itemId ? x.itemId === k.itemId : keptSame(x, k)),
      );
      if (already || conv.kept.length >= MAX_KEPT) return conv;
      const prior = k.itemId ? (conv.brief.keep.items[k.itemId] ?? null) : null;
      const brief = k.itemId
        ? {
            ...conv.brief,
            keep: {
              ...conv.brief.keep,
              items: { ...conv.brief.keep.items, [k.itemId]: 'in-place' as const },
            },
          }
        : conv.brief;
      return push(
        { ...conv, brief, kept: [...conv.kept, k.itemId ? { ...k, prior } : k] },
        {
          kind: 'event',
          id: a.id,
          at: a.at,
          event: { type: 'kept', keptId: k.id, text: cut(a.text, L.note), undone: false },
        },
      );
    }
    case 'unkeepItem': {
      const k = conv.kept.find((x) => x.id === a.keptId);
      if (!k) return conv;
      const items = { ...conv.brief.keep.items };
      // What the brief said before (the person's own 'bring' or 'in-place') comes back.
      if (k.itemId && items[k.itemId] === 'in-place') {
        if (k.prior) items[k.itemId] = k.prior;
        else delete items[k.itemId];
      }
      const next: Conversation = {
        ...conv,
        brief: { ...conv.brief, keep: { ...conv.brief.keep, items } },
        kept: conv.kept.filter((x) => x.id !== k.id),
        keptGone: [...conv.keptGone, { ...k, until: a.at }].slice(-MAX_KEPT),
        turns: conv.turns.map((t) =>
          t.kind === 'event' && t.event.type === 'kept' && t.event.keptId === k.id
            ? { ...t, event: { ...t.event, undone: true } }
            : t,
        ),
      };
      return push(next, {
        kind: 'event',
        id: a.id,
        at: a.at,
        event: { type: 'note', text: cut(a.text, L.note) },
      });
    }
    case 'tipSeen':
      return conv.tips.includes(a.tip) ? conv : { ...conv, tips: [...conv.tips, a.tip] };
  }
}

/** Two kept proposal pieces at the same place. */
const keptSame = (a: Kept, b: Kept) =>
  !a.itemId &&
  !b.itemId &&
  a.assetId === b.assetId &&
  Math.hypot(a.pose.x - b.pose.x, a.pose.y - b.pose.y) < 0.05;

/** The house rules that stand (not deleted). */
export const liveRules = (conv: Conversation): Rule[] => conv.rules.filter((r) => !r.deleted);

/** The rules list with one added, the oldest deleted ones going first past the cap. */
function withRule(rules: Rule[], rule: Rule): Rule[] {
  const all = [...rules.filter((r) => r.id !== rule.id), rule];
  const over = all.length - MAX_RULE_RECORDS;
  if (over <= 0) return all;
  const drop = new Set(
    all
      .filter((r) => r.deleted)
      .slice(0, over)
      .map((r) => r.id),
  );
  return all.filter((r) => !drop.has(r.id));
}

/** The designer turn with an offer, and the offer. */
function offerOf(conv: Conversation, turnId: string) {
  const t = findTurn(conv, turnId, 'designer');
  return t?.talk?.offer ? { t, offer: t.talk.offer } : null;
}

const setOffer = (conv: Conversation, t: TurnOf<'designer'>, offer: RuleOffer): Conversation =>
  t.talk ? replaceTurn(conv, { ...t, talk: { ...t.talk, offer } }) : conv;

/**
 * House rules (slice 3a tech §7): an offer kept, kept just this once, swapped for the rule it
 * contradicts, or declined; a rule renamed, its number changed, deleted or put back. Each one
 * that doesn't fit the state is a no-op (a second Keep, a twenty-first rule).
 */
function ruleAction(
  conv: Conversation,
  a: Extract<
    TalkAction,
    {
      type:
        | 'ruleKeep'
        | 'ruleOnce'
        | 'ruleReplace'
        | 'ruleKeepYours'
        | 'ruleReopen'
        | 'ruleEdit'
        | 'ruleDelete'
        | 'ruleRestore';
    }
  >,
): Conversation {
  const live = liveRules(conv);
  switch (a.type) {
    case 'ruleKeep': {
      const o = offerOf(conv, a.turnId);
      if (!o || o.offer.state !== 'open' || !o.offer.vet.ok) return conv;
      const n = a.n === undefined ? o.offer.rule.n : a.n === null ? null : roundN(a.n);
      const rule: Rule = { ...o.offer.rule, n, at: a.at, deleted: false };
      let rules = conv.rules;
      const raises = o.offer.vet.raises;
      const raised = raises && live.find((r) => r.id === raises.ruleId);
      if (raised) {
        // A wider clear width on a way a rule keeps clear already: that rule is raised.
        rules = rules.map((r) => (r.id === raised.id ? { ...r, n: n ?? raises.to } : r));
      } else {
        if (live.length >= MAX_RULES || live.some((r) => r.id === rule.id)) return conv;
        rules = withRule(rules, rule);
      }
      let next = setOffer({ ...conv, rules }, o.t, { ...o.offer, rule, state: 'kept' });
      // A Decision made a rule leaves Decisions (UX §3.8).
      const from = conv.decisions.find((d) => !d.deleted && d.rule?.id === rule.id);
      if (from) {
        next = {
          ...next,
          decisions: next.decisions.map((d) => (d.id === from.id ? { ...d, deleted: true } : d)),
        };
        next = push(next, {
          kind: 'event',
          id: a.id,
          at: a.at,
          event: {
            type: 'rule',
            rule: cut(rule.name, 80),
            text: 'Moved to Your rules.',
            ruleId: rule.id,
          },
        });
      }
      return next;
    }
    case 'ruleOnce': {
      const o = offerOf(conv, a.turnId);
      if (!o || o.offer.state !== 'open') return conv;
      const text = o.offer.rule.name.slice(0, DECISION_CHARS);
      const had = conv.decisions.some((d) => !d.deleted && d.rule?.id === o.offer.rule.id);
      let next = setOffer(conv, o.t, { ...o.offer, state: 'once' });
      if (!had) {
        next = talk(next, {
          type: 'decisionAdd',
          id: a.id,
          at: a.at,
          kind: 'wish',
          text,
          from: o.offer.rule.from.version,
        });
        next = {
          ...next,
          decisions: next.decisions.map((d) => (d.id === a.id ? { ...d, rule: o.offer.rule } : d)),
        };
      }
      return next;
    }
    case 'ruleReplace': {
      const o = offerOf(conv, a.turnId);
      const old = o?.offer.vet.with ? live.find((r) => r.id === o.offer.vet.with) : null;
      if (!o || !old || o.offer.state !== 'refused' || o.offer.vet.why !== 'conflict') return conv;
      const rule: Rule = { ...o.offer.rule, at: a.at, deleted: false };
      const rules = withRule(
        conv.rules.map((r) => (r.id === old.id ? { ...r, deleted: true } : r)),
        rule,
      );
      return setOffer({ ...conv, rules }, o.t, { ...o.offer, rule, state: 'replaced' });
    }
    case 'ruleKeepYours': {
      const o = offerOf(conv, a.turnId);
      if (!o || o.offer.state !== 'refused') return conv;
      return setOffer(conv, o.t, { ...o.offer, state: 'kept-yours' });
    }
    case 'ruleReopen': {
      const d = conv.decisions.find((x) => x.id === a.decisionId && !x.deleted);
      if (!d?.rule) return conv;
      const id = d.rule.id;
      const t = conv.turns.find(
        (x): x is TurnOf<'designer'> => x.kind === 'designer' && x.talk?.offer?.rule.id === id,
      );
      if (!t?.talk?.offer) return conv;
      return setOffer(conv, t, {
        ...t.talk.offer,
        vet: a.vet,
        state: a.vet.ok ? 'open' : 'refused',
      });
    }
    case 'ruleEdit': {
      const r = live.find((x) => x.id === a.ruleId);
      if (!r) return conv;
      const name = a.name === undefined ? r.name : a.name.replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!name) return conv;
      const n = a.n === undefined ? r.n : a.n === null ? null : roundN(a.n);
      if (name === r.name && n === r.n) return conv;
      return { ...conv, rules: conv.rules.map((x) => (x.id === r.id ? { ...x, name, n } : x)) };
    }
    case 'ruleDelete':
    case 'ruleRestore': {
      const r = conv.rules.find((x) => x.id === a.ruleId);
      if (!r || r.deleted === (a.type === 'ruleDelete')) return conv;
      if (a.type === 'ruleRestore' && live.length >= MAX_RULES) return conv;
      return {
        ...conv,
        rules: conv.rules.map((x) =>
          x.id === r.id ? { ...x, deleted: a.type === 'ruleDelete' } : x,
        ),
      };
    }
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
      offer: null,
      look: false,
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
      // A wish is told to the designer, never checked: the line says so (criterion 40).
      const head = d.kind === 'wish' ? 'Noted in Decisions, not checked' : 'Noted in Decisions';
      noted.push({ kind: 'decision', text: cut(`${head}: ${d.text}`, 300), ref: id });
    }
  }
  // A rule offered that the vocabulary can't hold, or the app couldn't read: noted, not checked.
  const unfit =
    r.memory.unfit ??
    (a.offer && !a.offer.vet.ok && a.offer.vet.why === 'unfit' ? a.offer.rule.name : null);
  const offer = a.offer && !(a.offer.vet.why === 'unfit') ? a.offer : null;
  const ruleLines: string[] = [];
  if (unfit) {
    const id = take();
    const before = next.decisions.length;
    next = talk(next, { type: 'decisionAdd', id, at: a.at, kind: 'wish', text: unfit, from: null });
    if (next.decisions.length > before)
      noted.push({
        kind: 'decision',
        text: cut(`Noted in Decisions, not checked: ${unfit}`, 300),
        ref: id,
      });
    ruleLines.push('I couldn’t turn this into a check, so it’s noted, not checked.');
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
  // Make this a rule from a Decision: the Decision carries the rule offered, so keeping it
  // moves it to Your rules.
  if (t.ruleAsk && offer?.vet.ok) {
    const from = t.ruleAsk.decisionId;
    next = {
      ...next,
      decisions: next.decisions.map((d) => (d.id === from ? { ...d, rule: offer.rule } : d)),
    };
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
      ...(a.appLine ? { appLine: cut(a.appLine, 300) } : {}),
      offer: offer
        ? { rule: offer.rule, vet: offer.vet, state: offer.vet.ok ? 'open' : 'refused' }
        : null,
      look: false,
    },
  };
  const appLines: Turn[] = [...a.lines.slice(0, 3), ...ruleLines].map((text) => ({
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
    owns: 'how much you own',
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
