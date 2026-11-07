import type { Level } from '../../schema';
import type { DesignBrief } from '../schema';
import {
  GREETING_NEXT,
  assume,
  factText,
  formKnows,
  formSummary,
  greeting as greetingText,
  nextQuestions,
} from './firstMeeting';
import {
  type Conversation,
  DECISION_CHARS,
  DRAFT_CHARS,
  type Decision,
  TALK_LIMITS as L,
  MAX_DECISIONS,
  MAX_TURNS,
  type QuestionKey,
  type ScopeRef,
  TALK_RECORD_VERSION,
  type TalkEvent,
  type Turn,
  type TurnOf,
  cut,
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
  | { type: 'decisionDelete'; id: string }
  | { type: 'decisionRestore'; id: string };

/** A new conversation: the greeting and the first questions (or, after a form, the offer). */
export function newConversation(a: Extract<TalkAction, { type: 'start' }>): Conversation {
  const known = a.form ? formKnows(a.brief) : [];
  const conv: Conversation = {
    projectId: a.projectId,
    id: a.id,
    recordVersion: TALK_RECORD_VERSION,
    rev: 0,
    startedAt: a.at,
    levelId: a.levelId,
    start: { at: a.at, beforeFp: a.beforeFp, afterFp: a.afterFp },
    brief: a.brief,
    assumed: [],
    known,
    nextN: a.nextN,
    decisions: [],
    turns: [],
    draft: '',
  };
  const date = a.form ? dayOf(a.form.at) : '';
  const greet: Turn = {
    kind: 'designer',
    id: a.ids[0],
    at: a.at,
    text: cut(greetingText(a.level), L.designer),
    lines: [],
    after: cut(
      a.form
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
  const out = new Set<QuestionKey>(conv.known);
  for (const t of conv.turns) {
    if (t.kind !== 'app-question') continue;
    for (const k of t.keys) if (t.done[k]) out.add(k);
  }
  for (const k of conv.assumed) out.add(k);
  return out;
}

/** Whether the first meeting is over: no question waits and the offer has been made. */
export const meetingOver = (conv: Conversation) => conv.turns.some((t) => t.kind === 'scope');

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
  return { ...conv, turns: all.length > MAX_TURNS ? all.slice(all.length - MAX_TURNS) : all };
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
        for (const k of t.keys) if (!d[k]) d[k] = { state: 'assumed' as const, words: 'Assumed' };
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
        { kind: 'person', id: a.ids[0], at: a.at, text: personText(a.scope, a.words) },
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
  cut(words.trim() ? words : `Design ${scope.all ? 'the whole flat' : scope.label}`, L.person);

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
