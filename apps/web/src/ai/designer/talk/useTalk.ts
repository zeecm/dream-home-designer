import {
  type Conversation,
  type DesignBrief,
  type Proposal,
  type QuestionKey,
  type TalkAction,
  defaultBrief,
  levelFingerprint,
  talk,
} from '@dhd/core';
import { create } from 'zustand';
import { useStore } from '../../../store';
import type { RunState } from '../run';
import { getBrief, loadDesigns, putBrief, useDesigner } from '../state';
import { onOtherTab, talkStore } from './talkStore';

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
}

export type TalkView = 'log' | 'know' | 'decisions';

interface TalkState {
  projectId: string | null;
  conv: Conversation | null;
  proposals: Proposal[];
  memory: boolean;
  view: TalkView;
  /** What I know opened at this fact. */
  knowAt: QuestionKey | null;
  /** The card on the plan (`proposalId:A`, or `d:designId` for an earlier design). */
  shown: string | null;
  /** A change row opened (its reason shown), and the one hovered or focused. */
  open: { card: string; change: string } | null;
  hover: { card: string; change: string } | null;
  live: LiveRun | null;
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
  view: 'log',
  knowAt: null,
  shown: null,
  open: null,
  hover: null,
  live: null,
  said: '',
  formOpen: false,
  note: null,
  settings: null,
  typed: null,
  cleared: 0,
  why: null,
}));

/** What the person has typed, now. */
export const typedNow = () => useTalk.getState().typed ?? useTalk.getState().conv?.draft ?? '';
/** What was typed went with a design: the composer and its draft empty. */
export async function clearTyped() {
  useTalk.setState((s) => ({ typed: '', cleared: s.cleared + 1 }));
  await act({ type: 'draft', text: '' });
}

let seq = 0;
/** An id for a turn, a proposal or an event: random, and ordered within this tab. */
export const newId = (prefix: string) =>
  `${prefix}_${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2))
    .replace(/-/g, '')
    .slice(0, 10)}${(seq++).toString(36)}`;
export const nowIso = () => new Date().toISOString();

const doc = () => useStore.getState().editor.doc;
/** The level the conversation designs: After when there is a renovation, else the flat. */
export const talkLevel = () => {
  const d = doc();
  return d.renovation?.levels[0] ?? d.levels[0];
};

export const say = (text: string) => useTalk.setState({ said: text });

/** Loads the open plan's conversation and proposals (none yet: null). */
export async function loadTalk(projectId = doc().id) {
  const s = await talkStore();
  const [conv, proposals] = await Promise.all([s.get(projectId), s.proposals(projectId)]);
  if (doc().id !== projectId) return;
  useTalk.setState((st) => ({
    projectId,
    conv,
    proposals,
    memory: s.memory,
    ...(st.projectId !== projectId
      ? { view: 'log' as const, shown: null, open: null, hover: null, note: null }
      : {}),
  }));
}

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
  }
  return out;
}

/** Writes a proposal (as `fn` makes it from the stored one) and mirrors it. */
export async function actProposal(
  id: string,
  fn: (p: Proposal | null) => Proposal | null,
): Promise<Proposal | null> {
  const projectId = doc().id;
  const s = await talkStore();
  let p: Proposal | null;
  try {
    p = await s.applyProposal(projectId, id, fn);
  } catch {
    p = fn(useTalk.getState().proposals.find((x) => x.id === id) ?? null);
    useTalk.setState({ note: UNSAVED });
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
  const before = project.levels[0];
  const level = talkLevel();
  if (!before || !level) return null;
  const s = await talkStore();
  // One this build can't read is kept aside (never overwritten), and the log says so.
  const aside = await s.setAside(project.id).catch(() => false);
  // The plan's versions first: the next number follows them.
  await loadDesigns(project.id);
  const form = await getBrief(project.id);
  const brief: DesignBrief = {
    ...(form ?? defaultBrief()),
    start: project.renovation ? 'after' : 'before',
  };
  const designs = useDesigner.getState().designs;
  const beforeFp = await s.putLevel(project.id, before);
  const after = project.renovation?.levels[0];
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
  useTalk.getState().live?.ctrl.abort();
  useTalk.setState({
    projectId: null,
    conv: null,
    proposals: [],
    live: null,
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
    void loadTalk(projectId).then(() => {
      useTalk.setState({ note: 'Updated with messages from another tab.' });
      setTimeout(() => {
        if (useTalk.getState().note === 'Updated with messages from another tab.') {
          useTalk.setState({ note: null });
        }
      }, 6000);
    });
  }
});
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    const st = useTalk.getState();
    if (st.projectId && !st.live) void loadTalk(st.projectId);
  });
}
