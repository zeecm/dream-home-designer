import {
  type Change,
  type Design,
  type HistoryEntry,
  type Level,
  type TurnOf,
  acceptChanges,
  allowedChanges,
  levelFingerprint,
  partsOf,
} from '@dhd/core';
import { useEditor } from '../../../editor';
import { useStore } from '../../../store';
import { loadDesigns, useDesigner } from '../state';
import { designStore } from '../storage';
import { type CardModel, cardChanges, cardResult, nowOf } from './cards';
import { talkStore } from './talkStore';
import { act, actProposal, newId, nowIso, say, useTalk } from './useTalk';

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

/** Accepts the ticked changes of a card; the id of the app line it added, or null. */
export async function acceptCard(
  card: CardModel,
  ticked: string[],
  waive: { key: string; text: string }[],
): Promise<string | null> {
  const project = useStore.getState().editor.doc;
  const b = nowOf(project);
  const r = cardResult(project, card);
  if (!b || !r) return null;
  const changes = cardChanges(project, card, r);
  const ok = allowedChanges(changes, ticked);
  if (!ok.length) return null;
  const ids = ok.map((c) => c.id);
  const prior = structuredClone(b.now);
  // The plan's history waits while a version is previewed: back to the plan first.
  useEditor.getState().setPreview(null);
  useDesigner.setState({ previewing: false });
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
  useEditor.getState().setVariant('after');
  useStore.setState({ toast: null });
  const after = now.doc.renovation?.levels[0];
  const at = nowIso();
  const waivers = [...card.waivers, ...waive.map((w) => ({ ...w, at }))].filter(
    (w, i, all) => all.findIndex((x) => x.key === w.key) === i,
  );
  const rows = ok.map((c) => ({
    id: c.id,
    text: c.text,
    group: c.group,
    groupName: c.groupName,
    event: eventId,
    out: false,
  }));
  const left = changes.filter((c) => !ids.includes(c.id));
  const total = card.accepted.filter((a) => !a.out).length + changes.length;
  if (after) await keepVersion(card, changes, ids, after, prior, waivers);
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
                    ticks: null,
                    waivers,
                    version: o.version ?? o.designId,
                  }
                : o,
            ),
          }
        : p,
    );
  }
  for (const w of waive) {
    await act({
      type: 'decisionAdd',
      id: newId('dec'),
      at,
      kind: 'waiver',
      text: `Waived: ${w.text}`.slice(0, 160),
      from: `V${card.n}`,
    });
  }
  await act({
    type: 'accepted',
    id: eventId,
    at,
    proposalId: card.proposal?.id ?? card.design?.id ?? card.key,
    n: card.n,
    letter: card.option?.letter ?? 'A',
    changes: ids,
    total,
    left: left.map((c) => c.name).slice(0, 20),
  });
  say(`Accepted ${plural(ids.length, 'change')} from V${card.n}. Undo is available.`);
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
) {
  const s = await designStore();
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
    await s.put({ ...card.design, waivers, accepted });
  } else if (card.proposal && card.option) {
    const o = card.option;
    const mine = await s.list(projectId);
    const had = mine.find((d) => d.id === o.designId);
    if (had) {
      await s.put({ ...had, waivers, accepted });
    } else {
      const base =
        (await (await talkStore()).getLevel(projectId, o.base.fingerprint)) ??
        structuredClone(prior);
      const made = await s.create(
        {
          id: o.designId,
          projectId,
          levelId: useStore.getState().editor.doc.levels[0]?.id ?? '',
          name: o.concept?.name ?? card.label,
          parent: null,
          createdAt: card.at,
          base: { variant: o.base.variant, fingerprint: levelFingerprint(base) },
          baseLevel: base,
          brief: o.brief,
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
          options: p.options.map((o) => ({
            ...o,
            accepted: o.accepted.map((a) => (a.event === ev.id ? { ...a, out } : a)),
          })),
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
}
export function redoLine(eventId: string) {
  if (lineState(eventId) !== 'redo') return;
  useEditor.getState().setPreview(null);
  useDesigner.setState({ previewing: false });
  useStore.getState().redo();
}

// The toolbar's Undo and Redo (and Ctrl+Z) move a line's accept too: the line follows.
let syncing = false;
useStore.subscribe((s, prev) => {
  if (s.editor.history === prev.editor.history || syncing) return;
  const conv = useTalk.getState().conv;
  if (!conv) return;
  syncing = true;
  void (async () => {
    try {
      for (const t of conv.turns) {
        if (t.kind !== 'event' || t.event.type !== 'accepted') continue;
        const st = lineState(t.id);
        if (st === 'redo' && !t.event.undone) {
          await act({ type: 'undone', eventId: t.id });
          await markRows(t, true);
          say(`Undone: the changes from V${t.event.n} are out of your renovation.`);
        } else if (st === 'undo' && t.event.undone) {
          await act({ type: 'redone', eventId: t.id });
          await markRows(t, false);
          say(`Redone: the changes from V${t.event.n} are back in your renovation.`);
        }
      }
    } finally {
      syncing = false;
    }
  })();
});
