import {
  type BringSource,
  type Design,
  type Level,
  broughtBack,
  conversationExport,
  conversationText,
  copiedLine,
  costEstimate,
  defaultBrief,
  levelFingerprint,
  optionTitle,
  putPlanBack,
} from '@dhd/core';
import { useRates } from '../../../cost/estimate';
import { useEditor } from '../../../editor';
import { useStore } from '../../../store';
import { useDesigner } from '../state';
import { type CardModel, nowOf } from './cards';
import { talkStore } from './talkStore';
import { act, actProposal, loadTalk, newId, nowIso, say, talkLevel, useTalk } from './useTalk';

/**
 * Going back and keeping a copy (slice 2, PR 3): Bring this back, My plan before the designer
 * with Put it back, Copy as text, Download conversation and Start over. All free: none of them
 * sends a request.
 */

const doc = () => useStore.getState().editor.doc;
const toast = (text: string) => useStore.setState({ toast: { text, at: Date.now() } });

/** What a card or a version is called where it is brought back from ("V2", "V4B"). */
const titleOf = (src: BringSource) =>
  src.kind === 'option'
    ? optionTitle(src.proposal.n, src.option.letter, src.proposal.options.length)
    : `V${src.design.n}`;

/**
 * Bring this back (criterion 27): the old option or version made again as V(n+1), with no
 * request, checked on today's plan and rules, and shown on the plan.
 */
export async function bringBack(src: BringSource): Promise<string | null> {
  const conv = useTalk.getState().conv;
  const project = doc();
  const b = nowOf(project);
  if (!conv || !b) return null;
  const fp = await (await talkStore()).putLevel(project.id, b.now);
  const proposalId = newId('prop');
  const turnId = newId('turn');
  const p = broughtBack(src, {
    id: proposalId,
    designId: newId('dsn'),
    n: conv.nextN,
    at: nowIso(),
    turnId,
    conversationId: conv.id,
    brief: conv.brief,
    base: { variant: project.renovation ? 'after' : 'before', fingerprint: fp },
  });
  await actProposal(proposalId, () => p);
  const from = titleOf(src);
  await act({
    type: 'bringBack',
    at: nowIso(),
    ids: { event: newId('turn'), turn: turnId },
    proposalId,
    from,
  });
  useTalk.setState({ view: 'log', shown: `${proposalId}:A`, open: null, why: null });
  useDesigner.setState({ previewing: true });
  say(`Brought back ${from} as V${p.n}, checked on your plan as it is now.`);
  return proposalId;
}

/** Bring this back from a card in the conversation (a proposal's option, or an earlier design). */
export function bringBackCard(card: CardModel) {
  if (card.proposal && card.option)
    return bringBack({ kind: 'option', proposal: card.proposal, option: card.option });
  if (card.design) return bringBack({ kind: 'design', design: card.design });
  return Promise.resolve(null);
}

export const bringBackDesign = (design: Design) => bringBack({ kind: 'design', design });

// --------------------------------------------------------------- My plan before the designer

/** The level the conversation started on (After then, else the flat), from `dhd-talk`. */
export async function startLevel(): Promise<Level | null> {
  const conv = useTalk.getState().conv;
  if (!conv) return null;
  return (await talkStore()).getLevel(doc().id, conv.start.afterFp ?? conv.start.beforeFp);
}

/** "5 Nov" for the start of the conversation. */
export const startDay = () => {
  const at = useTalk.getState().conv?.start.at;
  return at
    ? new Date(at).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    : '';
};

/**
 * My plan before the designer (criterion 28): the plan as it was when the conversation started,
 * on the stage, in a preview (nothing changes until Put it back).
 */
export async function showStart() {
  const level = await startLevel();
  const before = doc().levels[0];
  if (!level || !before) {
    toast('The plan from before the designer isn’t kept in this browser.');
    return;
  }
  useTalk.setState({ shown: null, view: 'log' });
  useDesigner.setState({ previewing: false });
  useEditor.getState().setPreview({
    level,
    before,
    label: 'Before the designer',
    side: 'version',
    start: { day: startDay() },
  });
}

/** Whether the flat as it is (Before) has changed since the conversation started. */
export function flatMoved(): boolean {
  const conv = useTalk.getState().conv;
  const before = doc().levels[0];
  if (!conv || !before) return false;
  return conv.start.beforeFp !== levelFingerprint(before);
}

/**
 * Put it back: the renovation as it was when the conversation started (none, if there was
 * none), as one undo step; the app line offers Undo through the toolbar's history.
 */
export async function putItBack(): Promise<boolean> {
  const conv = useTalk.getState().conv;
  const before = doc().levels[0];
  if (!conv || !before) return false;
  const after = conv.start.afterFp
    ? await (await talkStore()).getLevel(doc().id, conv.start.afterFp)
    : null;
  if (conv.start.afterFp && !after) return false;
  useEditor.getState().setPreview(null);
  const was = useStore.getState().editor;
  useStore.getState().dispatch(putPlanBack(before.id, after));
  if (useStore.getState().editor === was) {
    toast('Your plan is already as it was before the designer.');
    return false;
  }
  if (after) useEditor.getState().setVariant('after');
  await act({
    type: 'event',
    id: newId('turn'),
    at: nowIso(),
    event: {
      type: 'note',
      text: `You put your plan back as it was on ${startDay()}. Undo brings the designer’s changes back.`,
    },
  });
  say('Your plan is back as it was before the designer. Undo is available.');
  return true;
}

// ------------------------------------------------------------------- Copy as text, Download

/** The renovation's cost, as the cost lens says it ("about S$31–38k"), or null without one. */
function costWords(): string | null {
  const project = doc();
  const before = project.levels[0];
  const after = project.renovation?.levels[0];
  if (!before || !after) return null;
  const c = costEstimate(before, after, useRates.getState().rates);
  const k = (v: number) => Math.round(v / 1000);
  return c.high > 0 ? `about S$${k(c.low)}–${k(c.high)}k` : null;
}

/** Copy as text (UX §11): the decisions, What I know, accepted changes and notes for the ID. */
export async function copyConversation() {
  const { conv, proposals } = useTalk.getState();
  const level = talkLevel();
  if (!conv || !level) return;
  const r = conversationText(conv, proposals, level, { cost: costWords(), title: doc().name });
  try {
    await navigator.clipboard.writeText(r.text);
    toast(copiedLine(r));
  } catch {
    toast('Couldn’t copy: this browser didn’t allow it.');
  }
}

/** Download conversation: the records as a `.json` file the person keeps (no key, no prices). */
export async function downloadConversation() {
  const { conv, proposals } = useTalk.getState();
  if (!conv) return;
  const s = await talkStore();
  const projectId = doc().id;
  const fps = new Set([
    conv.start.beforeFp,
    ...(conv.start.afterFp ? [conv.start.afterFp] : []),
    ...proposals.flatMap((p) => p.options.map((o) => o.base.fingerprint)),
  ]);
  const levels: Record<string, Level> = {};
  for (const fp of fps) {
    const l = await s.getLevel(projectId, fp);
    if (l) levels[fp] = l;
  }
  const file = conversationExport(conv, proposals, levels, nowIso());
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const name = (doc().name || 'plan').replace(/[^\w.-]+/g, '-').slice(0, 60);
  a.download = `${name}-designer-conversation.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------- Start over

/**
 * Start over (UX §8.6): a new conversation in this one's place. The numbering goes on, the
 * versions stay (under Earlier designs), What I know is kept if ticked; this conversation's
 * messages, decisions and proposals go.
 */
export async function startOver(keep: boolean): Promise<boolean> {
  const { conv, live, reply } = useTalk.getState();
  const project = doc();
  const before = project.levels[0];
  const level = talkLevel();
  if (!conv || !before || !level || live || reply) return false;
  const s = await talkStore();
  const beforeFp = await s.putLevel(project.id, before);
  const after = project.renovation?.levels[0];
  const afterFp = after ? await s.putLevel(project.id, after) : null;
  const fresh = await act({
    type: 'restart',
    fromId: conv.id,
    id: newId('conv'),
    at: nowIso(),
    keep,
    brief: { ...defaultBrief(), start: project.renovation ? 'after' : 'before' },
    beforeFp,
    afterFp,
    level,
    ids: [newId('turn'), newId('turn')],
  });
  if (!fresh || fresh.id === conv.id) return false;
  await s.removeProposals(project.id, fresh.id).catch(() => {});
  useEditor.getState().setPreview(null);
  useDesigner.setState({ previewing: false });
  useTalk.setState({ view: 'log', shown: null, open: null, hover: null, why: null });
  await loadTalk(project.id);
  say('Started a new conversation. Your versions are under Earlier designs.');
  return true;
}
