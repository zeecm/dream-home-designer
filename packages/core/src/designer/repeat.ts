import type { RunReport } from './report';
import { hash, stableJson } from './util';

/**
 * No paying again for the same failures (spec docs/specs/designer-listens.md §5, PR C): when the
 * newest versions of a scope fail the same way, the card says what's blocking it, and a paid run
 * asked again on the same inputs (nothing they depend on changed, the plan addresses nothing new)
 * always asks first, saying it will likely fail the same way. Pure: the web gathers what the
 * versions failed (their run reports) and what they were asked on (`dependsKey`).
 */

/**
 * A report's failure signatures (principle|code|room|role, `checkSig`): what "the same failure"
 * is across runs, whatever the new item ids. Already-in-plan and waived checks are never in a
 * report's failures, so they never count.
 */
export const failureSigs = (rep: Pick<RunReport, 'failures'>): Set<string> =>
  new Set(rep.failures.flatMap((f) => f.sig.split(' ').filter(Boolean)));

/**
 * Whether `newer` fails on the same things as `older`: every failure of the older is in the
 * newer (the newer may have more), and the older failed at all.
 */
export function sameFailures(
  older: Pick<RunReport, 'failures'>,
  newer: Pick<RunReport, 'failures'>,
): boolean {
  const a = failureSigs(older);
  if (!a.size) return false;
  const b = failureSigs(newer);
  for (const s of a) if (!b.has(s)) return false;
  return true;
}

/**
 * What a version depends on, as §5 lists it: the brief and What I know (who sleeps where, the
 * strict setting and quality included), the Decisions that stand (and the pieces left out), the
 * house rules, the kept pieces, the plan it starts from and the plan as it is (hand edits and
 * accepts). The same inputs give the same key; any change gives another.
 */
export interface DependsOn {
  brief: unknown;
  decisions: readonly { id: string; kind: string; text: string }[];
  declined: readonly { room: string; role: string }[];
  rules: readonly unknown[];
  kept: readonly unknown[];
  /** Fingerprints of the levels it starts from and is placed on (before, after). */
  levels: readonly (string | null)[];
  /** The storage meter's setting, and anything else the run reads. */
  extra?: unknown;
}

export function dependsKey(d: DependsOn): string {
  return `d1:${hash(
    stableJson({
      ...d,
      decisions: [...d.decisions]
        .map((x) => ({ id: x.id, kind: x.kind, text: x.text }))
        .sort((p, q) => (p.id < q.id ? -1 : 1)),
      declined: [...d.declined].map((x) => `${x.room}|${x.role}`).sort(),
    }),
  )}`;
}

/** A version of the scope, newest last, as `repeatOf` reads it. */
export interface RepeatVersion {
  title: string;
  report: Pick<RunReport, 'failures'>;
  /** Its `dependsKey` when it was asked for (absent: an older build's, so a change is assumed). */
  depends?: string | undefined;
  /** Accepted anyway since (a waiver is a change, §5). */
  waived?: boolean;
  /** The signatures its plan said it fixed (`addresses`), if any. */
  addressed?: readonly string[];
}

export interface RepeatFound {
  /** The versions that failed the same way, oldest first (two at least). */
  titles: string[];
  /** The newest's failures, one line each as the person reads them. */
  failures: string[];
  count: number;
  /** The newest's signatures. */
  sigs: string[];
}

/**
 * The run of versions, newest back, that failed on the same things: null unless the newest two
 * did. "V6 to V8" when three in a row.
 */
export function repeatRun(versions: readonly RepeatVersion[]): RepeatFound | null {
  const last = versions[versions.length - 1];
  const prev = versions[versions.length - 2];
  if (!last || !prev || !sameFailures(prev.report, last.report)) return null;
  let first = versions.length - 2;
  while (first > 0) {
    const older = versions[first - 1];
    const next = versions[first];
    if (!older || !next || !sameFailures(older.report, next.report)) break;
    first--;
  }
  const f = (last.report as RunReport).failures;
  return {
    titles: versions.slice(first).map((v) => v.title),
    failures: f.map((x) => x.says),
    count: f.length,
    sigs: [...failureSigs(last.report)],
  };
}

/**
 * Whether a paid run asked now will likely come back the same way (§5): the newest two versions
 * of the scope failed the same way, nothing the newest depends on changed since (`now`, and no
 * waiver on it), and the plan addresses none of its failures or the same ones the newest's plan
 * did (by signature: the lead's "the set of F and L ids", read by what they name). Only ever adds
 * an ask: null means the usual rules decide.
 */
export function repeatAhead(
  versions: readonly RepeatVersion[],
  now: string,
  plan: { addressed?: readonly string[] } = {},
): RepeatFound | null {
  const run = repeatRun(versions);
  const last = versions[versions.length - 1];
  if (!run || !last) return null;
  if (!last.depends || last.depends !== now || last.waived) return null;
  const asked = new Set((plan.addressed ?? []).flatMap((s) => s.split(' ')).filter(Boolean));
  if (asked.size) {
    const before = new Set((last.addressed ?? []).flatMap((s) => s.split(' ')).filter(Boolean));
    const same = asked.size === before.size && [...asked].every((s) => before.has(s));
    if (!same) return null;
  }
  return run;
}

/** "V7 and V8", "V6 to V8". */
export const versionsWords = (titles: readonly string[]) =>
  titles.length <= 2 ? titles.join(' and ') : `${titles[0]} to ${titles[titles.length - 1]}`;

const things = (n: number) => (n === 1 ? 'thing' : `${n} things`);
const problems = (n: number) => (n === 1 ? 'problem' : `${n} problems`);

/** The card's block heading (UX "What's blocking this"): "V7 and V8 failed on the same 3 things". */
export const blockingHead = (titles: readonly string[], n: number) =>
  `${versionsWords(titles)} failed on the same ${things(n)}`;

/**
 * The repeat cost card's sentence (UX "The cost cards"), in full the first time for a set of
 * failures, then one line.
 */
export function repeatWords(r: Pick<RepeatFound, 'titles' | 'count'>, again: boolean): string {
  const n = r.count;
  if (again)
    return `Likely the same ${problems(n)} again (${r.titles[0]} to ${r.titles[r.titles.length - 1]}).`;
  return `This will likely come back with the same ${problems(n)}: ${versionsWords(r.titles)} did, and nothing they depend on has changed.`;
}

/** The strict card's heading when its failures are left: "Couldn't make everything pass within US$0.60". */
export const notMetHead = (figure: string | null) =>
  `Couldn’t make everything pass${figure ? ` within ${figure}` : ''}`;

/**
 * Fix every check first, failures left (UX review 2): "within US$x" only when the fix-ups or
 * the figure were used up; otherwise why it stopped, with what it spent of the figure ("The fix
 * round made no progress, so it stopped (US$0.13 of up to US$2.94)."), never a figure that
 * reads as spent.
 */
export function notMet(o: {
  figure: string | null;
  spent: string | null;
  usedUp: boolean;
  noProgress: boolean;
}): { head: string; why: string | null } {
  if (o.usedUp) return { head: notMetHead(o.figure), why: null };
  const of = o.spent && o.figure ? ` (${o.spent} of up to ${o.figure})` : '';
  return {
    head: notMetHead(null),
    why: o.noProgress
      ? `The fix round made no progress, so it stopped${of}.`
      : of
        ? `It stopped${of}.`
        : null,
  };
}

/** One sentence of `notMet` (the log's line): "couldn't make everything pass. The fix round …". */
export const notMetText = (n: ReturnType<typeof notMet>) =>
  `${n.head.charAt(0).toLowerCase()}${n.head.slice(1)}.${n.why ? ` ${n.why}` : ''}`;
