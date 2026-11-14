import {
  type Change,
  type Design,
  type DesignResult,
  type HistoryEntry,
  type Level,
  type ResultCheck,
  TALK_LIMITS,
  type TurnOf,
  acceptChanges,
  allowedChanges,
  cut,
  designLevels,
  levelFingerprint,
  mergeChanges,
  partsOf,
  subsetReport,
} from '@dhd/core';
import { useRates } from '../../../cost/estimate';
import { useEditor } from '../../../editor';
import { useStore } from '../../../store';
import { loadDesigns, useDesigner } from '../state';
import { designStore } from '../storage';
import {
  type CardModel,
  cardChanges,
  cardResultNow,
  nowOf,
  precheckOn,
  putBackMoves,
} from './cards';
import { appDecisions, isAppChange } from './free';
import { focusInLog } from './scroll';
import { talkStore } from './talkStore';
import { lineTitle } from './titles';
import {
  act,
  actProposal,
  designLevelId,
  levelGone,
  levelGoneText,
  newId,
  nowIso,
  say,
  useTalk,
} from './useTalk';

/**
 * Accept selected (UX §7.4): the ticked changes go into the renovation through one Command,
 * one undo step. The first accept from a proposal makes its version (numbered as the
 * proposal); later ones update it. The app line that follows offers Undo while that accept is
 * the latest step in the plan's history, and Redo once undone, kept in step with the
 * toolbar's Undo, Redo and Ctrl+Z.
 */

/** The history step each accept line made (by event id): not kept across a reload. */
const steps = new Map<string, HistoryEntry['patches']>();

/** Whether the line's accept is the latest undo step, or the next redo step. */
export function lineState(eventId: string): 'undo' | 'redo' | null {
  const ref = steps.get(eventId);
  if (!ref) return null;
  const h = useStore.getState().editor.history;
  if (h.past.at(-1)?.patches === ref) return 'undo';
  if (h.future[0]?.patches === ref) return 'redo';
  return null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What accepting the ticked changes would leave failing, worked out now on the plan as it is
 * (never from a check still pending): the hard checks those changes cause together, less the
 * ones accepted anyway (`waived`), and whether any is an HDB rule (never accepted).
 */
export function precheckAccept(
  card: CardModel,
  ticked: string[],
  waived: readonly string[],
  r: DesignResult | null,
): { failing: ResultCheck[]; hdb: boolean; missing: boolean } {
  return precheckOn(
    useStore.getState().editor.doc,
    card,
    ticked,
    waived,
    r,
    useRates.getState().rates,
  );
}

/**
 * Why a card can't be accepted on account of its level: the conversation's has gone from the
 * plan, or the card designs another level than the one this conversation merges into.
 */
export function levelRefusal(card: CardModel): string | null {
  if (levelGone()) return levelGoneText();
  if (card.levelId !== designLevelId()) {
    const project = useStore.getState().editor.doc;
    const name = designLevels(project, card.levelId)?.before.name ?? 'another level';
    return `${card.title} designs ${name}, not the level this conversation designs, so nothing was accepted.`;
  }
  return null;
}

/** Why nothing was accepted when the card couldn't be checked on the plan as it is. */
export const NOT_CHECKED =
  'Couldn’t check these changes on your plan as it is, so nothing was accepted. Try again.';

/**
 * Accept selected's question first (the button): the ticked changes checked on the plan as it
 * is, waited for, never read from a check still pending; refused, with a line, when there is
 * no result to check them with.
 */
export async function precheckNow(
  card: CardModel,
  ticked: string[],
  waived: readonly string[],
): Promise<{ failing: ResultCheck[]; hdb: boolean } | null> {
  const refused = levelRefusal(card);
  if (refused) {
    await nothing(refused);
    return null;
  }
  const r = await cardResultNow(useStore.getState().editor.doc, card).catch(() => null);
  const pre = precheckAccept(card, ticked, waived, r);
  if (pre.missing) {
    await nothing(NOT_CHECKED);
    return null;
  }
  return pre;
}

/**
 * Accepts the ticked changes of a card; the id of the app line it added, or null. `waive` are
 * the checks the person accepted anyway: only those the accepted changes cause are kept (a
 * waiver never outlives its tick). It refuses when the changes would fail a check not
 * waived, or an HDB rule at all.
 */
export async function acceptCard(
  card: CardModel,
  ticked: string[],
  waive: { key: string; text: string }[],
): Promise<string | null> {
  // One accept of a card at a time: a double click never accepts twice.
  if (accepting.has(card.key)) return null;
  accepting.add(card.key);
  try {
    return await acceptOnce(card, ticked, waive);
  } finally {
    accepting.delete(card.key);
  }
}

const accepting = new Set<string>();
const CHANGED = 'The plan changed since; check the card again.';

/** Why nothing was accepted, as an app line (never silent). */
const nothing = async (text: string) => {
  await act({ type: 'event', id: newId('turn'), at: nowIso(), event: { type: 'note', text } });
  return null;
};

async function acceptOnce(
  card: CardModel,
  ticked: string[],
  waive: { key: string; text: string }[],
): Promise<string | null> {
  const refused = levelRefusal(card);
  if (refused) return nothing(refused);
  const project = useStore.getState().editor.doc;
  const b = nowOf(project, card.levelId);
  const r = await cardResultNow(project, card);
  if (!b || !r) return nothing(CHANGED);
  const changes = cardChanges(project, card, r);
  let ok = allowedChanges(changes, ticked);
  if (!ok.length) return nothing(CHANGED);
  // Never twice: rows another tab (or an earlier click) already put in, as the record has them.
  if (card.proposal && card.option) {
    const pid = card.proposal.id;
    const letter = card.option.letter;
    const stored = (await (await talkStore()).proposals(project.id)).find((x) => x.id === pid);
    const already = new Set(
      (stored?.options.find((o) => o.letter === letter)?.accepted ?? [])
        .filter((a) => !a.out)
        .map((a) => a.id),
    );
    ok = ok.filter((c) => !already.has(c.id));
  }
  if (!ok.length) return nothing('Already accepted in another tab.');
  const ids = ok.map((c) => c.id);
  // The waivers the accepted changes need: their own checks, or what they fail together.
  const pre = precheckAccept(card, ids, [], r);
  if (pre.missing) return nothing(NOT_CHECKED);
  const needed = new Set([...ok.flatMap((c) => c.checks), ...pre.failing.map((c) => c.key)]);
  const waiving = waive.filter(
    (w, i, all) => needed.has(w.key) && all.findIndex((x) => x.key === w.key) === i,
  );
  const unwaived = pre.failing.filter((c) => !waiving.some((w) => w.key === c.key));
  if (pre.hdb || unwaived.length) return nothing(CHANGED);
  const prior = structuredClone(b.now);
  // The plan's history waits while a version is previewed: back to the plan first. Edits go to
  // the renovation, so its guards (the household shelter) apply to the accept.
  useEditor.getState().setPreview(null);
  useDesigner.setState({ previewing: false });
  useEditor.getState().setVariant('after');
  const was = useStore.getState().editor;
  const label = `Use design V${card.n}`;
  useStore.getState().dispatch(acceptChanges(b.before.id, r.level, changes, ids, { label }));
  const now = useStore.getState().editor;
  const eventId = newId('turn');
  if (now === was) {
    const why = useStore.getState().toast?.text ?? 'nothing changed';
    await act({
      type: 'event',
      id: eventId,
      at: nowIso(),
      event: { type: 'note', text: `Couldn’t accept: ${why}` },
    });
    return null;
  }
  const step = now.history.past.at(-1);
  if (step) steps.set(eventId, step.patches);
  useStore.setState({ toast: null });
  const after = designLevels(now.doc, card.levelId)?.after;
  const at = nowIso();
  const waivers = [...card.waivers, ...waiving.map((w) => ({ ...w, at }))].filter(
    (w, i, all) => all.findIndex((x) => x.key === w.key) === i,
  );
  const rows = ok.map((c) => ({
    id: c.id,
    text: cut(c.text, TALK_LIMITS.row),
    group: c.group,
    groupName: cut(c.groupName, TALK_LIMITS.label),
    event: eventId,
    out: false,
  }));
  const left = changes.filter((c) => !ids.includes(c.id));
  const total = card.accepted.filter((a) => !a.out).length + changes.length;
  const n = (after ? await keepVersion(card, changes, ids, after, prior, waivers) : null) ?? card.n;
  if (card.proposal && card.option) {
    const letter = card.option.letter;
    await actProposal(card.proposal.id, (p) =>
      p
        ? {
            ...p,
            options: p.options.map((o) =>
              o.letter === letter
                ? {
                    ...o,
                    accepted: [...o.accepted, ...rows],
                    // What was left out stays out: nothing is ticked again for you.
                    ticks: [],
                    waivers,
                    version: o.version ?? o.designId,
                  }
                : o,
            ),
          }
        : p,
    );
  }
  // V4, or V4B for an alternative: what the lines and decisions call it.
  const title = lineTitle({
    n,
    letter: card.option?.letter ?? 'A',
    proposalId: card.proposal?.id ?? '',
  });
  // What was left out is a rejection the designer remembers (spec: Remembers), one line a time.
  // A piece the app placed itself and left out is its own Decision, recorded here at Accept
  // (never on untick), so the free fix doesn't offer it again for that room.
  const theirs = left.filter((c) => !isAppChange(c, r));
  for (const d of appDecisions(left, r)) {
    await act({
      type: 'decisionAdd',
      id: newId('dec'),
      at,
      kind: 'rejected',
      text: cut(d.text, 160),
      from: title,
      ...(d.free ? { free: d.free } : {}),
    });
  }
  if (theirs.length) {
    const names = theirs.map((c) => c.name);
    const shown = names.slice(0, 3).join(', ');
    const more = names.length > 3 ? ` and ${names.length - 3} more` : '';
    await act({
      type: 'decisionAdd',
      id: newId('dec'),
      at,
      kind: 'rejected',
      text: cut(`Left out of ${title}: ${shown}${more}`, 160),
      from: title,
    });
  }
  for (const w of waiving) {
    await act({
      type: 'decisionAdd',
      id: newId('dec'),
      at,
      kind: 'waiver',
      text: cut(`Waived: ${w.text}`, 160),
      from: title,
    });
  }
  await act({
    type: 'accepted',
    id: eventId,
    at,
    proposalId: card.proposal?.id ?? card.design?.id ?? card.key,
    n,
    letter: card.option?.letter ?? 'A',
    changes: ids,
    total,
    left: left.map((c) => cut(c.name, TALK_LIMITS.left)).slice(0, 20),
  });
  say(`Accepted ${plural(ids.length, 'change')} from ${title}. Undo is available.`);
  return eventId;
}

/** The version the accept makes (the first from a proposal) or brings up to date. */
async function keepVersion(
  card: CardModel,
  changes: Change[],
  ids: string[],
  after: Level,
  prior: Level,
  waivers: Design['waivers'],
): Promise<number | null> {
  const s = await designStore();
  let n: number | null = null;
  const projectId = useStore.getState().editor.doc.id;
  const parts = partsOf(changes, ids);
  const accepted = {
    at: nowIso(),
    parts: [...(card.design?.accepted?.parts ?? []), ...parts].filter(
      (p, i, all) => all.findIndex((q) => JSON.stringify(q) === JSON.stringify(p)) === i,
    ),
    level: structuredClone(after),
    prior,
  };
  if (card.design) {
    n = card.design.n;
    await s.put({ ...card.design, waivers, accepted });
  } else if (card.proposal && card.option) {
    const o = card.option;
    const mine = await s.list(projectId);
    const had = mine.find((d) => d.id === o.designId);
    if (had) {
      n = had.n;
      await s.put({ ...had, waivers, accepted });
    } else {
      const base =
        (await (await talkStore()).getLevel(projectId, o.base.fingerprint)) ??
        structuredClone(prior);
      const made = await s.create(
        {
          id: o.designId,
          projectId,
          levelId: card.levelId,
          name: cut(o.concept?.name ?? card.label, 80),
          parent: null,
          createdAt: card.at,
          base: { variant: o.base.variant, fingerprint: levelFingerprint(base) },
          baseLevel: base,
          brief: o.brief,
          // The kept pieces it was made with go with the version (read as they were).
          ...(o.kept ? { kept: [...o.kept] } : {}),
          request: {
            scope: card.proposal.scope.all
              ? { kind: 'all' }
              : {
                  kind: 'space',
                  space: card.proposal.scope.spaces[0] ?? '',
                  aspects: ['furniture', 'built-ins', 'finishes'],
                },
            feedback: card.words.slice(0, 2000),
            locks: o.locks,
          },
          aliases: o.aliases,
          concept: o.concept,
          spaces: o.spaces,
          usage: o.usage,
          waivers,
          from: {
            conversationId: card.proposal.conversationId,
            proposalId: card.proposal.id,
            letter: o.letter,
          },
          accepted,
        },
        card.n,
      );
      // The number it took (another tab may have taken this one meanwhile).
      n = made.design.n;
      if (made.pruned) {
        await act({
          type: 'event',
          id: newId('turn'),
          at: nowIso(),
          event: {
            type: 'note',
            text: `The oldest ${made.pruned === 1 ? 'version was' : `${made.pruned} versions were`} removed: a plan keeps 20 versions.`,
          },
        });
      }
    }
  }
  await loadDesigns(projectId);
  return n;
}

/** Marks a line's rows out of (or back in) the renovation, on its proposal. */
async function markRows(ev: TurnOf<'event'>, out: boolean) {
  if (ev.event.type !== 'accepted') return;
  const pid = ev.event.proposalId;
  if (!useTalk.getState().proposals.some((p) => p.id === pid)) return;
  await actProposal(pid, (p) =>
    p
      ? {
          ...p,
          options: p.options.map((o) => {
            const mine = o.accepted.filter((a) => a.event === ev.id).map((a) => a.id);
            if (!mine.length) return o;
            // Undone, the subset that was accepted is ticked again (N5); redone, it is in.
            const ticks = out
              ? [...new Set([...(o.ticks ?? []), ...mine])]
              : (o.ticks ?? []).filter((id) => !mine.includes(id));
            return {
              ...o,
              ticks,
              accepted: o.accepted.map((a) => (a.event === ev.id ? { ...a, out } : a)),
            };
          }),
        }
      : p,
  );
}

/** Undo on the line (the same as the toolbar's, for that step). */
export function undoLine(eventId: string) {
  if (lineState(eventId) !== 'undo') return;
  useEditor.getState().setPreview(null);
  useDesigner.setState({ previewing: false });
  useStore.getState().undo();
  // Focus goes to the line's Redo once it shows (never to the page).
  focusWhenThere(`[data-redo-line="${eventId}"]`);
}
export function redoLine(eventId: string) {
  if (lineState(eventId) !== 'redo') return;
  useEditor.getState().setPreview(null);
  useDesigner.setState({ previewing: false });
  useStore.getState().redo();
  focusWhenThere(`[data-undo-line="${eventId}"]`);
}

/** Focuses what `selector` finds as soon as it is drawn (a few frames at most). */
function focusWhenThere(selector: string, tries = 20) {
  const el = document.querySelector<HTMLElement>(selector);
  if (el) focusInLog(el);
  else if (tries > 0) requestAnimationFrame(() => focusWhenThere(selector, tries - 1));
}

/**
 * Put it back (criterion 28): its history step, the accept lines it took out (each then reads
 * "Undone", its rows out of the renovation, so the cards offer them again) and the versions it
 * took out (no longer "Accepted"), kept as they were for its Undo. In this tab only, as the
 * history is.
 */
interface PutBack {
  patches: HistoryEntry['patches'];
  lines: string[];
  versions: Map<string, Design['accepted']>;
  /** Whether what it took out is out now (the step is in the plan). */
  out: boolean;
}
const putBacks: PutBack[] = [];

/** Takes the accepts out of the cards, lines and versions after a Put it back just done. */
export async function rememberPutBack() {
  const step = useStore.getState().editor.history.past.at(-1);
  const conv = useTalk.getState().conv;
  if (!step || !conv) return;
  const lines = conv.turns.flatMap((t) =>
    t.kind === 'event' && t.event.type === 'accepted' && !t.event.undone ? [t.id] : [],
  );
  const versions = new Map(
    useDesigner
      .getState()
      .designs.filter((d) => d.accepted)
      .map((d) => [d.id, d.accepted] as const),
  );
  // Applied by the sync, one change at a time with the accept lines' own.
  putBacks.push({ patches: step.patches, lines, versions, out: false });
  await syncLines();
}

async function applyPutBack(pb: PutBack, out: boolean) {
  pb.out = out;
  for (const id of pb.lines) {
    const t = useTalk.getState().conv?.turns.find((x) => x.id === id);
    if (t?.kind !== 'event' || t.event.type !== 'accepted') continue;
    await act({ type: out ? 'undone' : 'redone', eventId: id });
    await markRows(t, out);
  }
  const projectId = useStore.getState().editor.doc.id;
  const s = await designStore();
  const mine = await s.list(projectId);
  for (const [id, accepted] of pb.versions) {
    const d = mine.find((x) => x.id === id);
    if (d) await s.put({ ...d, accepted: out ? null : accepted });
  }
  await loadDesigns(projectId);
  say(
    out
      ? 'Your plan is back as it was before the designer.'
      : 'The designer’s changes are back in your renovation.',
  );
}

/** What an undone version had accepted, for its Redo (this tab only, as the history is). */
const undoneVersions = new Map<string, Design['accepted']>();

/**
 * A version follows its accept lines (QA R3): once every line of it is undone it is no longer
 * "Accepted" (in Versions, for the next request's hand edits), and a Redo makes it so again.
 */
async function followVersion(
  e: { proposalId: string; letter: string },
  out: boolean,
): Promise<void> {
  const p = useTalk.getState().proposals.find((x) => x.id === e.proposalId);
  const o = p?.options.find((x) => x.letter === e.letter);
  const id = o ? (o.version ?? o.designId) : e.proposalId;
  const stillIn = (useTalk.getState().conv?.turns ?? []).some(
    (t) =>
      t.kind === 'event' &&
      t.event.type === 'accepted' &&
      t.event.proposalId === e.proposalId &&
      t.event.letter === e.letter &&
      !t.event.undone,
  );
  const projectId = useStore.getState().editor.doc.id;
  const s = await designStore();
  const d = (await s.list(projectId)).find((x) => x.id === id);
  if (!d) return;
  if (out && !stillIn && d.accepted) {
    undoneVersions.set(id, d.accepted);
    await s.put({ ...d, accepted: null });
  } else if (!out && !d.accepted && undoneVersions.has(id)) {
    await s.put({ ...d, accepted: undoneVersions.get(id) ?? null });
    undoneVersions.delete(id);
  } else return;
  await loadDesigns(projectId);
}

/** A Put it back undone (or redone) by the toolbar or Ctrl+Z: what it took out follows. */
async function syncPutBacks() {
  const moves = putBackMoves(putBacks, useStore.getState().editor.history);
  // A step trimmed from the history moved nowhere: what it took out stays as it is.
  for (const pb of moves.gone) putBacks.splice(putBacks.indexOf(pb), 1);
  for (const { item, out } of moves.apply) await applyPutBack(item, out);
}

// The toolbar's Undo and Redo (and Ctrl+Z) move a line's accept too: the line follows. A
// change that arrives while the lines are being brought up to date runs the sync again.
let syncing = false;
let dirty = false;
async function syncLines() {
  if (syncing) {
    dirty = true;
    return;
  }
  syncing = true;
  try {
    do {
      dirty = false;
      await syncPutBacks();
      for (const t of useTalk.getState().conv?.turns ?? []) {
        if (t.kind !== 'event' || t.event.type !== 'accepted') continue;
        const st = lineState(t.id);
        if (st === 'redo' && !t.event.undone) {
          await act({ type: 'undone', eventId: t.id });
          await markRows(t, true);
          await followVersion(t.event, true);
          say(`Undone: the changes from ${lineTitle(t.event)} are out of your renovation.`);
        } else if (st === 'undo' && t.event.undone) {
          await act({ type: 'redone', eventId: t.id });
          await markRows(t, false);
          await followVersion(t.event, false);
          say(`Redone: the changes from ${lineTitle(t.event)} are back in your renovation.`);
        }
      }
    } while (dirty);
  } finally {
    syncing = false;
  }
}
useStore.subscribe((st, prev) => {
  if (st.editor.history !== prev.editor.history) void syncLines();
});
