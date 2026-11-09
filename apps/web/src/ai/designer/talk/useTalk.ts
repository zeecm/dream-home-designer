import {
  type Conversation,
  type DesignBrief,
  type Proposal,
  type QuestionKey,
  type TalkAction,
  defaultBrief,
  designLevels,
  levelFingerprint,
  liveRules,
  talk,
} from '@dhd/core';
import { create } from 'zustand';
import { meterSetting, setMeterAmount, useStorage } from '../../../storage/store';
import { shownLevelId, useStore } from '../../../store';
import type { RunState } from '../run';
import {
  getBrief,
  loadDesigns,
  putBrief,
  setHouseKept,
  setHouseRules,
  useDesigner,
} from '../state';
import { onOtherTab, talkStore, talkStoreReady } from './talkStore';
import type { TimeLeft } from './timeLeft';
import type { WakeState } from './wakeLock';

/**
 * The open plan's conversation as the panel sees it: the record (mirrored from `dhd-talk`
 * after every write), its proposals, what the panel shows, and the design run going on. The
 * record changes only at turn boundaries (an answer, a proposal's room saved, an accept),
 * never per token.
 */

export interface LiveRun {
  proposalId: string;
  letter: string;
  state: RunState;
  ctrl: AbortController;
  /** Waiting at the tab's limit, or at the figure the run was priced at: answer to go on. */
  paused: ((go: boolean) => void) | null;
  pausedBy: 'tab' | 'approved' | null;
  /** About how much more finishing would take (US$). */
  remaining: number | null;
  /** The most it was priced at (US$), bound by the button pressed. */
  approved: number | null;
  /** About how long it has left (worked out again as each step ends). */
  left?: TimeLeft | null;
  /** Whether the screen is kept on while it runs. */
  wake?: WakeState | null;
  /** Stops it for good (marked stopped, then aborted): Stop, or another plan opened. */
  stop?: () => void;
}

/**
 * A run that stopped when the page closed (or was away too long), as its card shows it until
 * it carries on or is kept as it is (docs/specs/locked-phone-runs.md, part 1).
 */
export type ResumeView =
  | { kind: 'other-tab' }
  | { kind: 'carrying-on' }
  | { kind: 'offline'; done: number; total: number | null }
  | {
      kind: 'ask';
      /** The plan has changed since it stopped. */
      changed: boolean;
      /** What carrying on may cost at most (US$), as its button shows it; null: not priced. */
      figure: number | null;
      /** Still being priced. */
      pending: boolean;
      done: number;
      total: number | null;
      /** A different model is set now than it was started with. */
      model: { now: string; was: string } | null;
      /** No key now: Carry on opens AI settings. */
      noKey: boolean;
      /**
       * Why it stopped: the page closed (or was away too long), a step was cut off again and
       * again, or it reached what it was priced at or the tab's limit.
       */
      why: 'closed' | 'resent' | 'approved' | 'tab';
    };

/** A talk call on its way (ephemeral: never written per token). */
export interface LiveReply {
  /** The person's turn it answers. */
  turnId: string;
  /** What it has said so far, and its kind once known. */
  say: string;
  kind: 'reply' | 'question' | 'concern' | 'plan' | null;
  /** The model's latest thinking line; a wait (rate limit, dropped connection). */
  thinking: string;
  wait: { seconds: number; attempt: number; net?: boolean; server?: boolean } | null;
  ctrl: AbortController;
}

export type TalkView = 'log' | 'know' | 'decisions' | 'versions' | 'rules';

interface TalkState {
  projectId: string | null;
  conv: Conversation | null;
  proposals: Proposal[];
  memory: boolean;
  /** Waiting for the saved conversation (a slow IndexedDB open). */
  opening: boolean;
  /** The saved conversation was written by a newer version of the app: read-only here. */
  newer: boolean;
  view: TalkView;
  /** What I know opened at this fact. */
  knowAt: QuestionKey | null;
  /** The card on the plan (`proposalId:A`, or `d:designId` for an earlier design). */
  shown: string | null;
  /** A change row opened (its reason shown), and the one hovered or focused. */
  open: { card: string; change: string } | null;
  hover: { card: string; change: string } | null;
  live: LiveRun | null;
  /** Runs interrupted, by card key, as their cards show them. */
  resume: Record<string, ResumeView>;
  /** The designer replying to a message. */
  reply: LiveReply | null;
  /** The polite live region's words. */
  said: string;
  /** v1's form, as "Fill in a form instead". */
  formOpen: boolean;
  /** A note shown once at the top (memory only, couldn't save). */
  note: string | null;
  /** The composer's text as typed (its draft is kept 300 ms later). */
  typed: string | null;
  /** Bumped when what was typed went with a design: the composer empties. */
  cleared: number;
  /** Words put into the composer from elsewhere (a question's chip, Edit). */
  fill: { text: string; replace: boolean; n: number } | null;
  /** "Why this layout?": every reason of this card shown. */
  why: string | null;
  /** AI settings open over the panel, and where. */
  settings: null | 'key' | 'prices' | 'spending';
}

export const useTalk = create<TalkState>(() => ({
  projectId: null,
  conv: null,
  proposals: [],
  memory: false,
  opening: false,
  newer: false,
  view: 'log',
  knowAt: null,
  shown: null,
  open: null,
  hover: null,
  live: null,
  resume: {},
  reply: null,
  said: '',
  formOpen: false,
  note: null,
  settings: null,
  typed: null,
  cleared: 0,
  fill: null,
  why: null,
}));

/** A priced press must wait: a design runs or starts, or a reply streams in. */
export const useBusy = (): boolean => {
  const run = useDesigner((s) => s.starting || !!s.run);
  const replying = useTalk((s) => !!s.reply);
  return run || replying;
};

/** What the person has typed, now. */
export const typedNow = () => useTalk.getState().typed ?? useTalk.getState().conv?.draft ?? '';
/** What was typed went with a design: the composer and its draft empty. */
export async function clearTyped() {
  useTalk.setState((s) => ({ typed: '', cleared: s.cleared + 1 }));
  await act({ type: 'draft', text: '' });
}

/** Puts words into the composer (after what is there, or in its place) and focuses it. */
export const fillComposer = (text: string, replace = false) =>
  useTalk.setState((s) => ({ fill: { text, replace, n: (s.fill?.n ?? 0) + 1 } }));

let seq = 0;
/** An id for a turn, a proposal or an event: random, and ordered within this tab. */
export const newId = (prefix: string) =>
  `${prefix}_${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2))
    .replace(/-/g, '')
    .slice(0, 10)}${(seq++).toString(36)}`;
export const nowIso = () => new Date().toISOString();

const doc = () => useStore.getState().editor.doc;

/**
 * The level the conversation designs (a home of several levels is designed a level at a time):
 * its own, set from the level shown when it started; before one starts, the level shown. It
 * never moves to another level: if its own has gone from the plan, the conversation is read
 * only (`levelGone`) until Start over.
 */
export const designLevelId = (): string => useTalk.getState().conv?.levelId ?? shownLevelId() ?? '';

/** The conversation's level is no longer in the plan: nothing is placed, accepted or run. */
export const levelGone = (): boolean => {
  const id = useTalk.getState().conv?.levelId;
  return !!id && !designLevels(doc(), id);
};

/** `levelGone`, re-rendering as the plan or the conversation changes. */
export const useLevelGone = (): boolean => {
  const id = useTalk((s) => s.conv?.levelId);
  const levels = useStore((s) => s.editor.doc.levels);
  return !!id && !levels.some((l) => l.id === id);
};

/** What says the conversation is read only (its level gone), naming the level to start on. */
export const levelGoneText = () => {
  const shown = shownLevelId();
  const name = (shown && designLevels(doc(), shown)?.before.name) || 'the level shown';
  return `This conversation’s level is no longer in the plan. Start over to design ${name}.`;
};

/** That level as the designer works on it: its renovation when there is one, else as it is. */
export const talkLevel = () => {
  const l = designLevels(doc(), designLevelId());
  return l ? (l.after ?? l.before) : undefined;
};

/** The level it designs, as it is and in the renovation. */
export const talkLevels = () => designLevels(doc(), designLevelId());

export const say = (text: string) => useTalk.setState({ said: text });

/** The conversation's live house rules on a level (none on another level). */
export const rulesOn = (levelId: string) => {
  const c = useTalk.getState().conv;
  return c && c.levelId === levelId ? liveRules(c).filter((r) => r.levelId === levelId) : [];
};
setHouseRules(rulesOn);
setHouseKept((levelId) => {
  const c = useTalk.getState().conv;
  // Those let go too: a version made while one was kept is still placed with it (keptBefore).
  return c && c.levelId === levelId
    ? [...c.keptGone, ...c.kept].filter((k) => k.levelId === levelId)
    : [];
});

/** A key that changes when the live rules do (a card re-reads its result then). */
export const useRulesKey = (levelId: string) =>
  useTalk((s) =>
    s.conv && s.conv.levelId === levelId
      ? s.conv.rules
          .filter((r) => !r.deleted && r.levelId === levelId)
          .map((r) => `${r.id}:${r.n}:${r.name}`)
          .concat(s.conv.kept.map((k) => `k:${k.id}`))
          .join('|')
      : '',
  );

const OTHER_TAB = 'Updated with messages from another tab.';
/** Says once, for a few seconds, that another tab's messages came in. */
function otherTabNote() {
  useTalk.setState({ note: OTHER_TAB });
  setTimeout(() => {
    if (useTalk.getState().note === OTHER_TAB) useTalk.setState({ note: null });
  }, 6000);
}

/** Loads the open plan's conversation and proposals (none yet: null). */
export async function loadTalk(projectId = doc().id, fromOtherTab = false) {
  if (!talkStoreReady()) useTalk.setState({ opening: true });
  const s = await talkStore();
  useTalk.setState({ opening: false });
  const [conv, proposals] = await Promise.all([s.get(projectId), s.proposals(projectId)]);
  if (doc().id !== projectId) return;
  const was = useTalk.getState();
  // Turns this tab didn't write: another tab's (N7).
  if (
    fromOtherTab &&
    was.projectId === projectId &&
    was.conv &&
    conv &&
    conv.rev !== was.conv.rev &&
    conv.turns.length > was.conv.turns.length
  )
    otherTabNote();
  useTalk.setState((st) => ({
    projectId,
    conv,
    proposals,
    memory: s.memory,
    ...(st.projectId !== projectId
      ? { view: 'log' as const, shown: null, open: null, hover: null, note: null, newer: false }
      : {}),
  }));
  ownsFromMeter();
}

/**
 * How much they own is one value with the storage meter's own setting (tech 3b §4.1): set on
 * the meter (here or before the conversation was opened), it becomes What I know's fact, said
 * in the log as any change is; answered here, the meter takes it (`act`). Free: no request.
 */
function ownsFromMeter() {
  const { conv, projectId, newer } = useTalk.getState();
  if (!conv || newer || !projectId || projectId !== doc().id) return;
  const amount = meterSetting(projectId).amount;
  const owns = conv.brief.owns;
  if (owns === amount || (owns === undefined && amount === 'typical')) return;
  const level = talkLevel();
  if (!level) return;
  void act({
    type: 'editFact',
    key: 'owns',
    brief: { ...conv.brief, owns: amount },
    at: nowIso(),
    id: newId('turn'),
    level,
  });
}
useStorage.subscribe((s, p) => {
  if (s.setting.amount !== p.setting.amount && s.projectId === useTalk.getState().projectId) {
    ownsFromMeter();
  }
});

let briefWritten = '';
/** What I know goes back to the plan's brief too (v1's form opens with it). */
function keepBrief(projectId: string, b: DesignBrief) {
  const text = JSON.stringify(b);
  if (text === briefWritten) return;
  briefWritten = text;
  void putBrief(projectId, b);
}

const UNSAVED =
  'Couldn’t save the conversation in this browser; it’s kept until you close the tab.';
export const SET_ASIDE =
  'The conversation kept for this plan couldn’t be read, so it was set aside and a new one started.';

/** Applies an action to the conversation as stored (one transaction), and mirrors it. */
export async function act(action: TalkAction): Promise<Conversation | null> {
  const projectId = doc().id;
  const ownsWas = useTalk.getState().conv?.brief.owns;
  const s = await talkStore();
  let out: Conversation | null = null;
  try {
    out = await s.apply(projectId, (c) => {
      if (!c && action.type !== 'start') return null;
      const next = talk(c as Conversation, action);
      return next === c ? null : next;
    });
  } catch {
    // Kept in this tab: the change shows, and the note says it isn't saved.
    const mine = useTalk.getState().conv;
    const next = mine || action.type === 'start' ? talk(mine as Conversation, action) : null;
    useTalk.setState({ note: UNSAVED, ...(next ? { conv: next, projectId } : {}) });
    return next;
  }
  if (doc().id === projectId && out) {
    useTalk.setState({ conv: out, projectId });
    keepBrief(projectId, out.brief);
    // "How much do you own?" answered or changed by this action: the storage meter reads the
    // same (an action that didn't change it never writes the meter back).
    const owns = out.brief.owns;
    if (owns && owns !== ownsWas && owns !== meterSetting(projectId).amount) {
      setMeterAmount(projectId, owns);
    }
  }
  return out;
}

/** Writes a proposal (as `fn` makes it from the stored one) and mirrors it. */
export async function actProposal(
  id: string,
  fn: (p: Proposal | null) => Proposal | null,
  /** The plan it belongs to: the open one unless said (a run's end, after another opened). */
  projectId = doc().id,
): Promise<Proposal | null> {
  const s = await talkStore();
  let p: Proposal | null;
  try {
    p = await s.applyProposal(projectId, id, fn);
  } catch {
    const mine = doc().id === projectId;
    p = fn(mine ? (useTalk.getState().proposals.find((x) => x.id === id) ?? null) : null);
    if (mine) useTalk.setState({ note: UNSAVED });
  }
  if (p && doc().id === projectId) {
    useTalk.setState((st) => {
      const has = st.proposals.some((x) => x.id === p.id);
      const proposals = has
        ? st.proposals.map((x) => (x.id === p.id ? p : x))
        : [...st.proposals, p].sort((a, b) => a.n - b.n);
      return { proposals };
    });
  }
  return p;
}

/**
 * The conversation, started if there is none: the greeting and the first question (a form
 * filled in before for this plan is kept and said once).
 */
export async function ensureConversation(): Promise<Conversation | null> {
  const project = doc();
  if (useTalk.getState().projectId !== project.id) await loadTalk(project.id);
  const have = useTalk.getState().conv;
  if (have) return have;
  // The level shown: the one this conversation will design.
  const levels = talkLevels();
  const level = talkLevel();
  if (!levels || !level) return null;
  const { before, after } = levels;
  const s = await talkStore();
  // One set aside before that this build can read now goes back first (nothing is lost).
  if (await s.restore(project.id).catch(() => false)) {
    await loadTalk(project.id);
    const back = useTalk.getState().conv;
    if (back) return back;
  }
  // One this build can't read is kept aside (never overwritten), and the log says so; one a
  // newer build wrote stays as it is, and this tab only says to reload.
  const found = await s.setAside(project.id).catch(() => 'none' as const);
  if (found === 'newer') {
    useTalk.setState({ newer: true });
    return null;
  }
  const aside = found === 'aside';
  // The plan's versions first: the next number follows them.
  await loadDesigns(project.id);
  const form = await getBrief(project.id);
  const brief: DesignBrief = {
    ...(form ?? defaultBrief()),
    start: after ? 'after' : 'before',
  };
  const designs = useDesigner.getState().designs;
  const beforeFp = await s.putLevel(project.id, before);
  const afterFp = after ? await s.putLevel(project.id, after) : null;
  const started = await act({
    type: 'start',
    id: newId('conv'),
    at: nowIso(),
    projectId: project.id,
    levelId: before.id,
    brief,
    beforeFp,
    afterFp: afterFp ?? (after ? levelFingerprint(after) : null),
    nextN: Math.max(0, ...designs.map((d) => d.n)) + 1,
    level,
    form: form ? { at: nowIso() } : null,
    ids: [newId('turn'), newId('turn')],
  });
  if (!aside) return started;
  return act({
    type: 'event',
    id: newId('turn'),
    at: nowIso(),
    event: { type: 'note', text: SET_ASIDE },
  });
}

// Another plan: its own conversation.
useStore.subscribe((s, prev) => {
  if (s.editor.doc.id === prev.editor.doc.id) return;
  // Leaving the plan stops its run for good: it is never carried on later.
  const live = useTalk.getState().live;
  if (live?.stop) live.stop();
  else live?.ctrl.abort();
  useTalk.getState().reply?.ctrl.abort();
  useTalk.setState({
    projectId: null,
    conv: null,
    proposals: [],
    live: null,
    resume: {},
    shown: null,
    open: null,
    hover: null,
    view: 'log',
    note: null,
  });
  if (s.role !== 'viewer' && useDesigner.getState().panel) void loadTalk(s.editor.doc.id);
});

// Another tab wrote this plan's conversation: read it again.
onOtherTab((projectId) => {
  if (projectId === useTalk.getState().projectId && !useTalk.getState().live) {
    void loadTalk(projectId, true);
  }
});
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    const st = useTalk.getState();
    if (st.projectId && !st.live && !st.reply) void loadTalk(st.projectId, true);
  });
}
