import {
  type PlanAddress,
  type RunReport,
  addressedIn,
  fixSummary,
  leadParts,
  leftOutWords,
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

/**
 * The lead's frame (UX states C and D): "What's blocking this" when the newest versions of the
 * scope failed the same way ("V7 and V8 failed on the same 3 things"), or Fix every check first
 * not met ("Couldn't make everything pass within US$0.60", with "Same failures as V7." when it
 * repeats too). One frame a card, D before C.
 */
export interface LeadFrame {
  kind: 'blocking' | 'strict';
  heading: string;
  /** D only: "Same failures as V7." */
  same?: string | null;
}

/**
 * Change what I asked (UX C and D, the repeat cost card): a text button that focuses the
 * composer, its placeholder saying what to type. On a phone the composer's focus folds the sheet
 * to peek with the keyboard, as it always does.
 */
export function ChangeAsked() {
  return (
    <button
      type="button"
      className="link-btn talk-change-asked"
      data-change-asked=""
      onClick={() => {
        useTalk.setState({ changeAsk: true, view: 'log' });
        requestAnimationFrame(() => document.querySelector<HTMLElement>('#talk-text')?.focus());
      }}
    >
      Change what I asked
    </button>
  );
}

/** Who sleeps where, for a failure no furnishing can fix (more people than bedrooms). */
const SLEEPING_CODES = new Set(['unplaced', 'sleeping']);

export function CheckLead({
  cardKey,
  report,
  did = [],
  missed = [],
  action = null,
  frame = null,
}: {
  cardKey: string;
  report: RunReport;
  /** What the app did itself, free: pieces it placed, rooms it kept a bedroom, walls it kept. */
  did?: readonly string[];
  /** Missing essentials it couldn't place, with why. */
  missed?: readonly string[];
  /** The free fix's button, when a dry run would place something. */
  action?: ReactNode;
  /** States C and D: the frame and its heading. */
  frame?: LeadFrame | null;
}) {
  const failing = report.failures.length;
  const { fix, count } = leadParts(report.rooms, failing);
  // The designer's own pieces the app left out (they didn't fit): said in one line with the app's
  // neutral mark, the reason a tap away. A piece whose loss fails a check is said with that
  // failure instead, so the line never warns, and the headline's tick follows the checks (UX B2).
  const out = leftOutWords(report);
  // A tick only beside a headline that came out well: never beside "Sent back… no better" (or
  // cut off, refused…), though the plan passes now (the free fix placed the bed: QA).
  const f = fixSummary(report.rooms);
  const badly =
    f.noBetter ||
    f.cutOff ||
    f.failed ||
    f.refused ||
    f.error ||
    f.unknown ||
    f.stopped ||
    f.away ||
    f.keepAway;
  const passMark = !failing && (f.fixed > 0 || f.kept > 0 || !badly);
  const rounds = roundLines(report.rooms);
  if (!fix && !count && !did.length && !missed.length && !action && !out) return null;
  const id = `lead-${cardKey}`;
  const shown = report.failures.slice(0, FIRST);
  const more = report.failures.slice(FIRST);
  const didShown = did.slice(0, DID);
  const didMore = did.slice(DID);
  // With no headline (nothing failed, no fix rounds), the first line the app says names it.
  const headless = !fix && !count;
  const leftLine = out && (
    <li
      className="talk-app-line talk-check-did"
      data-app-line="left-out"
      {...(headless ? { id } : {})}
    >
      <span className="talk-app-icon">
        <Mark kind="dot" />
      </span>
      <span className="talk-app-text">
        <details className="talk-already talk-check-left">
          <summary>{keepTogether(out.line)}</summary>
          <ul>
            {out.reasons.map((l) => (
              <li key={l}>{keepTogether(l)}</li>
            ))}
          </ul>
        </details>
      </span>
    </li>
  );
  const item = (f: RunReport['failures'][number]) => {
    // No furnishing fixes it (more people than bedrooms, a bedroom with no window): said so,
    // with the way forward where it is who sleeps where (UX "Can't be fixed by furnishing").
    const code = f.key.split('|')[1] ?? '';
    const unfurnishable = f.unfixable && !f.cause;
    return (
      <li key={f.id} className="talk-check-fail">
        <span className="talk-app-icon talk-warn-mark">
          <Mark kind="warn" />
        </span>
        <span className="talk-app-text">
          <span className="talk-check-text">{keepTogether(f.says)}</span>
          {f.cause && <span className="talk-check-cause">{keepTogether(f.cause)}</span>}
          {unfurnishable && (
            <span className="talk-check-cause" data-unfurnishable="">
              Can’t be fixed by furnishing.
              {SLEEPING_CODES.has(code) && (
                <button
                  type="button"
                  className="link-plain talk-check-link"
                  onClick={() => useTalk.setState({ view: 'know', knowAt: 'sleeping' })}
                >
                  Who sleeps where ›
                </button>
              )}
            </span>
          )}
        </span>
      </li>
    );
  };
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
  if (frame) {
    // C and D: the frame leads with its heading (the section's name); the fix rounds' outcome
    // under it in grey, then the count (D) and every failure, then the ways forward.
    return (
      <section
        className="talk-check-lead talk-check-frame"
        aria-labelledby={id}
        data-lead=""
        data-frame={frame.kind}
      >
        <p id={id} className="talk-check-head talk-check-frame-head">
          {frame.heading}
        </p>
        {fix && <p className="talk-check-did talk-check-frame-fix">{fix}</p>}
        {frame.kind === 'strict' && count && (
          <p className="talk-check-head">
            <strong className="talk-check-count">{count}</strong>
          </p>
        )}
        <ul className="talk-check-fails">{shown.map(item)}</ul>
        {more.length > 0 && (
          <details className="talk-already talk-check-more">
            <summary>and {more.length} more</summary>
            <ul className="talk-check-fails">{more.map(item)}</ul>
          </details>
        )}
        {frame.same && <p className="talk-check-did">{frame.same}</p>}
        {missed.length + didShown.length > 0 || leftLine ? (
          <ul className="talk-check-fails talk-check-app">
            {leftLine}
            {missed.map((l) => line(l, 'warn', false))}
            {didShown.map((l) => line(l, 'check', false))}
          </ul>
        ) : null}
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
        <div className="talk-check-ways">
          {action}
          <ChangeAsked />
        </div>
      </section>
    );
  }
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
      {missed.length + didShown.length > 0 || leftLine ? (
        <ul className="talk-check-fails talk-check-app">
          {leftLine}
          {missed.map((l, i) => line(l, 'warn', i === 0 && !didShown.length && !leftLine))}
          {didShown.map((l, i) => line(l, 'check', i === 0 && !leftLine && !missed.length))}
        </ul>
      ) : null}
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
  report.failures.length > 0 || fixSummary(report.rooms).sent > 0 || !!leftOutWords(report);

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
