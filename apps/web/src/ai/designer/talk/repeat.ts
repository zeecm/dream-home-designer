import {
  type Proposal,
  type ProposalOption,
  type Repeat,
  type RepeatVersion,
  type ScopeRef,
  dependsKey,
  levelFingerprint,
  notMet,
  optionTitle,
  repeatAhead,
  repeatRun,
  sameFailures,
} from '@dhd/core';
import { meterSetting } from '../../../storage/store';
import { useStore } from '../../../store';
import { aiSettings } from '../../credentials';
import { usd } from '../spend';
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
    // The model too: another model may well not fail the same way (money review nit).
    extra: {
      meter: meterSetting(useStore.getState().editor.doc.id),
      levelId,
      model: aiSettings() ? [aiSettings()?.provider, aiSettings()?.model] : null,
    },
  });
}

/**
 * How a strict version stopped with failures left (UX review 2): its fix-ups used up (a room's
 * last round `no-fixups`), or a round no better, and what it spent of its figure.
 */
export function notMetOf(o: ProposalOption) {
  const last = Object.values(o.spaces).map((s) => s.rounds?.at(-1)?.outcome);
  const spent = o.usage.reduce((t, u) => t + (u.usd ?? 0), 0);
  return notMet({
    figure: typeof o.approved === 'number' ? usd(o.approved) : null,
    spent: o.usage.length ? usd(spent) : null,
    usedUp: last.includes('no-fixups'),
    noProgress: last.includes('no-better'),
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

type ScopeVersion = RepeatVersion & {
  card: CardModel;
  option: ProposalOption;
  proposal: Proposal;
};

/** The checked versions of a scope (each proposal's newest option), oldest first, unworked. */
function scopeOptions(scope: ScopeRef, last: number) {
  return useTalk
    .getState()
    .proposals.filter((p) => sameScope(p.scope, scope))
    .sort((a, b) => a.n - b.n)
    .flatMap((p) => {
      const o = newestOption(p);
      return o && o.status === 'checked' ? [{ p, o }] : [];
    })
    .slice(-last);
}

/**
 * The run of versions, newest back, worked out lazily (each report from the worker, free): the
 * newest, then the one before, then further back only while each failed the same way. Oldest
 * first; empty when the newest two don't repeat (so a press waits for two reports at most
 * before it knows).
 */
async function repeatedVersions(
  opts: readonly { p: Proposal; o: ProposalOption }[],
): Promise<ScopeVersion[]> {
  const project = useStore.getState().editor.doc;
  const work = async ({ p, o }: { p: Proposal; o: ProposalOption }) => {
    const card = optionCard(p, o, designLevelId());
    const got = await cardReportNow(project, card).catch(() => null);
    return got
      ? {
          title: optionTitle(p.n, o.letter, p.options.length),
          report: got.report,
          depends: o.depends,
          waived: o.waivers.length > 0,
          addressed: (o.addresses ?? []).map((a) => a.sig),
          card,
          option: o,
          proposal: p,
        }
      : null;
  };
  const out: ScopeVersion[] = [];
  for (let i = opts.length - 1; i >= 0; i--) {
    const at = opts[i];
    const v = at ? await work(at) : null;
    if (!v) break;
    const next = out[0];
    if (next ? !sameFailures(v.report, next.report) : !v.report.failures.length) break;
    out.unshift(v);
  }
  return out.length >= 2 ? out : [];
}

/**
 * Whether a paid run for `scope` asked now will likely come back with the same failures (§5),
 * as the cost card keeps it: null when it won't, or when that can't be told (then the usual
 * rules decide: it only ever adds an ask). The cheap tests first (the newest's key, a waiver),
 * so a press with anything changed works out no report at all.
 */
export async function repeatFor(
  scope: ScopeRef,
  addressed: readonly string[],
): Promise<Repeat | null> {
  const opts = scopeOptions(scope, 6);
  const newest = opts.at(-1)?.o;
  const now = dependsNow();
  if (opts.length < 2 || !newest?.depends || newest.depends !== now || newest.waivers.length)
    return null;
  const vs = await repeatedVersions(opts).catch(() => []);
  const found = repeatAhead(vs, now, { addressed });
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
 * before it failed the same way (`same`: the same failures, the newest maybe more). With fewer
 * (a subset), `same` is false: said "Also failed in V1 and V2.", never "the same" (UX review
 * 3), and no blocking frame. Null for any other card.
 */
export async function blockingFor(
  card: CardModel,
): Promise<{ titles: string[]; same: boolean } | null> {
  const p = card.proposal;
  if (!p || !card.option) return null;
  const opts = scopeOptions(p.scope, 6);
  const last = opts.at(-1);
  if (!last || opts.length < 2 || last.p.id !== p.id || last.o.letter !== card.option.letter)
    return null;
  const run = repeatRun(await repeatedVersions(opts).catch(() => []));
  if (run) return { titles: run.titles, same: true };
  // Fewer failures than the version before, every one of them in it: also failed there.
  const two = opts.slice(-2);
  const project = useStore.getState().editor.doc;
  const reps = await Promise.all(
    two.map(({ p: q, o }) =>
      cardReportNow(project, optionCard(q, o, designLevelId())).catch(() => null),
    ),
  );
  const [older, newer] = reps;
  const a = two[0];
  if (!older || !newer || !a || !sameFailures(newer.report, older.report)) return null;
  return {
    titles: [optionTitle(a.p.n, a.o.letter, a.p.options.length), card.title],
    same: false,
  };
}
