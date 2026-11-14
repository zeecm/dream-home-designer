import {
  type Proposal,
  type ProposalOption,
  type Repeat,
  type RepeatVersion,
  type ScopeRef,
  dependsKey,
  levelFingerprint,
  optionTitle,
  repeatAhead,
  repeatRun,
} from '@dhd/core';
import { meterSetting } from '../../../storage/store';
import { useStore } from '../../../store';
import { houseKeptFor } from '../state';
import { type CardModel, cardReportNow, declinedPieces, optionCard } from './cards';
import { designLevelId, rulesOn, talkLevels, useTalk } from './useTalk';

/**
 * No paying again for the same failures (spec docs/specs/designer-listens.md §5, PR C), in the
 * web: what a version is asked on (`dependsNow`, kept on the option), the newest versions of a
 * scope with their run reports, and whether a paid run asked now will likely fail the same way.
 * Free: the reports are the cards' own, from the worker.
 */

/** What a run asked now depends on (§5's list), as a key kept on the option it makes. */
export function dependsNow(): string {
  const conv = useTalk.getState().conv;
  const levels = talkLevels();
  const levelId = designLevelId();
  return dependsKey({
    brief: conv?.brief ?? null,
    decisions: (conv?.decisions ?? []).filter((d) => !d.deleted),
    declined: declinedPieces(),
    rules: rulesOn(levelId),
    kept: houseKeptFor(levelId, 'new'),
    levels: [
      levels ? levelFingerprint(levels.before) : null,
      levels?.after ? levelFingerprint(levels.after) : null,
    ],
    extra: { meter: meterSetting(useStore.getState().editor.doc.id), levelId },
  });
}

/** Two scopes ask for the same rooms (the whole flat, or the same spaces). */
export const sameScope = (a: ScopeRef, b: ScopeRef) =>
  a.all || b.all
    ? a.all === b.all && !!a.walls === !!b.walls
    : [...a.spaces].sort().join(',') === [...b.spaces].sort().join(',');

/** A proposal's newest option (Another idea's B and C come after A). */
export const newestOption = (p: Proposal): ProposalOption | undefined =>
  [...p.options].sort((a, b) => (a.madeAt ?? p.at).localeCompare(b.madeAt ?? p.at)).at(-1);

/** The newest checked versions of a scope, oldest first, each with its card and run report. */
export async function scopeVersions(
  scope: ScopeRef,
  last = 6,
): Promise<(RepeatVersion & { card: CardModel; option: ProposalOption; proposal: Proposal })[]> {
  const project = useStore.getState().editor.doc;
  const ps = useTalk
    .getState()
    .proposals.filter((p) => sameScope(p.scope, scope))
    .sort((a, b) => a.n - b.n)
    .slice(-last);
  const out: (RepeatVersion & { card: CardModel; option: ProposalOption; proposal: Proposal })[] =
    [];
  for (const p of ps) {
    const o = newestOption(p);
    if (!o || o.status !== 'checked') continue;
    const card = optionCard(p, o, designLevelId());
    const got = await cardReportNow(project, card).catch(() => null);
    if (!got) continue;
    out.push({
      title: optionTitle(p.n, o.letter, p.options.length),
      report: got.report,
      depends: o.depends,
      waived: o.waivers.length > 0,
      addressed: (o.addresses ?? []).map((a) => a.sig),
      card,
      option: o,
      proposal: p,
    });
  }
  return out;
}

/**
 * Whether a paid run for `scope` asked now will likely come back with the same failures (§5),
 * as the cost card keeps it: null when it won't, or when that can't be told (then the usual
 * rules decide: it only ever adds an ask).
 */
export async function repeatFor(
  scope: ScopeRef,
  addressed: readonly string[],
): Promise<Repeat | null> {
  const vs = await scopeVersions(scope).catch(() => []);
  const found = repeatAhead(vs, dependsNow(), { addressed });
  const last = vs.at(-1);
  if (!found || !last) return null;
  // Said in full once for a set of failures; the next card for the same is one line.
  const key = [...found.sigs].sort().join(' ');
  const said = (useTalk.getState().conv?.turns ?? []).some(
    (t) => t.kind === 'cost-ask' && !!t.repeat && [...t.repeat.sigs].sort().join(' ') === key,
  );
  return {
    titles: found.titles.slice(-12).map((t) => t.slice(0, 12)),
    failures: found.failures.slice(0, 8).map((f) => f.slice(0, 300)),
    count: found.count,
    card: { proposalId: last.proposal.id, letter: last.option.letter },
    again: said,
    sigs: found.sigs.slice(0, 40).map((s) => s.slice(0, 300)),
  };
}

/**
 * The card's "What's blocking this" (UX state C): the newest card of its scope whose versions
 * before it failed the same way. Null for any other card.
 */
export async function blockingFor(card: CardModel): Promise<{ titles: string[] } | null> {
  const p = card.proposal;
  if (!p || !card.option) return null;
  const vs = await scopeVersions(p.scope).catch(() => []);
  const last = vs.at(-1);
  if (!last || last.proposal.id !== p.id || last.option.letter !== card.option.letter) return null;
  const run = repeatRun(vs);
  return run ? { titles: run.titles } : null;
}
