import {
  type Change,
  type Design,
  type HistoryEntry,
  type Level,
  type ResultCheck,
  TALK_LIMITS,
  type TurnOf,
  acceptChanges,
  allowedChanges,
  cut,
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
import { type CardModel, cardChanges, cardResult, nowOf } from './cards';
import { focusInLog } from './scroll';
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

/**
 * What accepting the ticked changes would leave failing, worked out now on the plan as it is
 * (never from a check still pending): the hard checks those changes cause together, less the
 * ones accepted anyway (`waived`), and whether any is an HDB rule (never accepted).
 */
export function precheckAccept(
  card: CardModel,
  ticked: string[],
  waived: readonly string[],
): { failing: ResultCheck[]; hdb: boolean } {
  const project = useStore.getState().editor.doc;
  const b = nowOf(project);
  const r = cardResult(project, card);
  if (!b || !r) return { failing: [], hdb: false };
  const changes = cardChanges(project, card, r);
  const merged = mergeChanges(b.now, r.level, changes, ticked);
  const rep = subsetReport(b.now, b.before, r, merged, card.input.brief, {
    rates: useRates.getState().rates,
    waived: [...card.waivers.map((w) => w.key), ...waived],
    renovation: !!project.renovation,
  });
  return { failing: rep.failing, hdb: rep.failing.some((c) => !c.waivable) };
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
  const project = useStore.getState().editor.doc;
  const b = nowOf(project);
  const r = cardResult(project, card);
  if (!b || !r) return null;
  const changes = cardChanges(project, card, r);
  let ok = allowedChanges(changes, ticked);
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
  if (!ok.length) return null;
  const ids = ok.map((c) => c.id);
  // The waivers the accepted changes need: their own checks, or what they fail together.
  const pre = precheckAccept(card, ids, []);
  const needed = new Set([...ok.flatMap((c) => c.checks), ...pre.failing.map((c) => c.key)]);
  const waiving = waive.filter(
    (w, i, all) => needed.has(w.key) && all.findIndex((x) => x.key === w.key) === i,
  );
  const unwaived = pre.failing.filter((c) => !waiving.some((w) => w.key === c.key));
  if (pre.hdb || unwaived.length) return null;
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
  const after = now.doc.renovation?.levels[0];
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
  // What was left out is a rejection the designer remembers (spec: Remembers), one line a time.
  if (left.length) {
    const names = left.map((c) => c.name);
    const shown = names.slice(0, 3).join(', ');
    const more = names.length > 3 ? ` and ${names.length - 3} more` : '';
    await act({
      type: 'decisionAdd',
      id: newId('dec'),
      at,
      kind: 'rejected',
      text: cut(`Left out of V${n}: ${shown}${more}`, 160),
      from: `V${n}`,
    });
  }
  for (const w of waiving) {
    await act({
      type: 'decisionAdd',
      id: newId('dec'),
      at,
      kind: 'waiver',
      text: cut(`Waived: ${w.text}`, 160),
      from: `V${n}`,
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
  say(`Accepted ${plural(ids.length, 'change')} from V${n}. Undo is available.`);
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
          levelId: useStore.getState().editor.doc.levels[0]?.id ?? '',
          name: cut(o.concept?.name ?? card.label, 80),
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
      for (const t of useTalk.getState().conv?.turns ?? []) {
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
    } while (dirty);
  } finally {
    syncing = false;
  }
}
useStore.subscribe((st, prev) => {
  if (st.editor.history !== prev.editor.history) void syncLines();
});
