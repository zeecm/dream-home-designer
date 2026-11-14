import {
  type PlanAddress,
  type RunReport,
  addressedIn,
  fixSummary,
  leadParts,
  roundLines,
} from '@dhd/core';
import type { ReactNode } from 'react';
import { keepTogether } from '../words';
import { Mark } from './Mark';
import { useTalk } from './useTalk';

/**
 * How a version was checked, at the top of its card (spec docs/specs/designer-listens.md, UX
 * "The lead", states A and B): the fix rounds' outcome, then the card's own count (the one part
 * set heavier), then each failure named in the person's words with its measured cause, at most
 * three before "and n more"; the rounds room by room under "How it was checked". The app's
 * voice: facts, no apology, no fill. Every failure counted is named (a missing bed has no row to
 * carry it); a line the report merged (the couple, four chairs) counts as one.
 */

/** Failures shown before "and n more". */
const FIRST = 3;

/** A line without its full stop, to run on after a colon. */
export const bare = (s: string) => s.trim().replace(/[.;:]+$/, '');

/** Lines of what the app did itself shown in the lead before "How it was checked". */
const DID = 2;

/** A vetting line about who sleeps where ends with the way to change it. */
const SLEEPS = /To make it a study, change who sleeps where\.$/;

export function CheckLead({
  cardKey,
  report,
  did = [],
  missed = [],
  action = null,
}: {
  cardKey: string;
  report: RunReport;
  /** What the app did itself, free: pieces it placed, rooms it kept a bedroom, walls it kept. */
  did?: readonly string[];
  /** Missing essentials it couldn't place, with why. */
  missed?: readonly string[];
  /** The free fix's button, when a dry run would place something. */
  action?: ReactNode;
}) {
  const failing = report.failures.length;
  const { fix, count } = leadParts(report.rooms, failing);
  // A tick only beside a headline that came out well: never beside "Sent back… no better" (or
  // cut off, refused…), though the plan passes now (the free fix placed the bed: QA).
  const f = fixSummary(report.rooms);
  const badly =
    f.noBetter || f.cutOff || f.failed || f.refused || f.error || f.unknown || f.stopped;
  const passMark = !failing && (f.fixed > 0 || !badly);
  const rounds = roundLines(report.rooms);
  if (!fix && !count && !did.length && !missed.length && !action) return null;
  const id = `lead-${cardKey}`;
  const shown = report.failures.slice(0, FIRST);
  const more = report.failures.slice(FIRST);
  const didShown = did.slice(0, DID);
  const didMore = did.slice(DID);
  // With no headline (nothing failed, no fix rounds), the first line the app says names it.
  const headless = !fix && !count;
  const item = (f: RunReport['failures'][number]) => (
    <li key={f.id} className="talk-check-fail">
      <span className="talk-app-icon talk-warn-mark">
        <Mark kind="warn" />
      </span>
      <span className="talk-app-text">
        <span className="talk-check-text">{keepTogether(f.says)}</span>
        {f.cause && <span className="talk-check-cause">{keepTogether(f.cause)}</span>}
      </span>
    </li>
  );
  const line = (l: string, kind: 'check' | 'warn', first: boolean) => (
    <li
      key={l}
      className="talk-app-line talk-check-did"
      data-app-line={kind === 'check' ? 'did' : 'missed'}
      {...(headless && first ? { id } : {})}
    >
      <span className={kind === 'warn' ? 'talk-app-icon talk-warn-mark' : 'talk-app-icon'}>
        <Mark kind={kind} />
      </span>
      <span className="talk-app-text">
        <span>
          {keepTogether(SLEEPS.test(l) ? l.replace(SLEEPS, '') : l)}
          {SLEEPS.test(l) && (
            <button
              type="button"
              className="link-plain talk-check-link"
              onClick={() => useTalk.setState({ view: 'know', knowAt: 'sleeping' })}
            >
              Who sleeps where ›
            </button>
          )}
        </span>
      </span>
    </li>
  );
  return (
    <section className="talk-check-lead" aria-labelledby={id} data-lead="">
      {!headless && (
        <p id={id} className={passMark ? 'talk-check-head talk-check-pass' : 'talk-check-head'}>
          {passMark && (
            <span className="talk-check-mark">
              <Mark kind="check" />
            </span>
          )}
          <span>
            {fix}
            {fix && count ? ' ' : ''}
            {count && <strong className="talk-check-count">{count}</strong>}
          </span>
        </p>
      )}
      {failing > 0 && <ul className="talk-check-fails">{shown.map(item)}</ul>}
      {more.length > 0 && (
        <details className="talk-already talk-check-more">
          <summary>and {more.length} more</summary>
          <ul className="talk-check-fails">{more.map(item)}</ul>
        </details>
      )}
      {missed.length + didShown.length > 0 && (
        <ul className="talk-check-fails talk-check-app">
          {missed.map((l, i) => line(l, 'warn', i === 0 && !didShown.length))}
          {didShown.map((l, i) => line(l, 'check', i === 0))}
        </ul>
      )}
      {rounds.length + didMore.length > 0 && (
        <details className="talk-already talk-check-how">
          <summary>How it was checked</summary>
          <ul>
            {rounds.map((l) => (
              <li key={l}>{keepTogether(l)}</li>
            ))}
            {didMore.map((l) => (
              <li key={l}>{keepTogether(l)}</li>
            ))}
          </ul>
        </details>
      )}
      {action}
    </section>
  );
}

/** Whether a card has a lead to show (so its Checks row says "listed above"). */
export const hasLead = (report: RunReport) =>
  report.failures.length > 0 || fixSummary(report.rooms).sent > 0;

/**
 * What this design set out to fix (its plan's `addresses`), each with how it came out on this
 * version's own report, the outcome first: "Fixed: …", "Still doesn't pass: …", "Still left
 * out: …", then what the plan said it would do. Shown only when the plan said.
 */
export function SetOutToFix({
  addresses,
  report,
}: {
  addresses: readonly PlanAddress[];
  report: RunReport;
}) {
  if (!addresses.length) return null;
  // A piece left out and the failure it causes may both be named: one row for the two, done
  // only when both are (the failure's warning never hidden behind the piece's tick).
  const rows: ReturnType<typeof addressedIn> = [];
  for (const a of addressedIn(addresses, report)) {
    const same = rows.find((b) => b.says === a.says);
    if (!same) rows.push({ ...a });
    else {
      same.done &&= a.done;
      same.left &&= a.left;
    }
  }
  return (
    <section className="talk-set-out" aria-label="What this design set out to fix">
      <h4 className="talk-set-out-head">What this design set out to fix</h4>
      <ul>
        {rows.map((a) => (
          <li key={a.says} className="talk-app-line">
            <span className={a.done ? 'talk-app-icon' : 'talk-app-icon talk-warn-mark'}>
              <Mark kind={a.done ? 'check' : 'warn'} />
            </span>
            <span className="talk-app-text">
              <span>
                {a.done ? 'Fixed' : a.left ? 'Still left out' : 'Still doesn’t pass'}:{' '}
                {keepTogether(`${bare(a.says)}. The plan: ${bare(a.change)}.`)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
