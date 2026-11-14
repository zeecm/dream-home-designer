import {
  type PlanAddress,
  type RunReport,
  addressedIn,
  fixSummary,
  leadLine,
  roundLines,
} from '@dhd/core';
import { keepTogether } from '../words';
import { Mark } from './Mark';

/**
 * How a version was checked, at the top of its card (spec docs/specs/designer-listens.md, UX
 * "The lead", states A and B): the fix rounds' outcome and the card's own count in one line,
 * then each failure named in the person's words with its measured cause, at most three before
 * "and n more"; the rounds room by room under "How it was checked". The app's voice: facts,
 * no apology, no fill. Every failure counted is named (a missing bed has no row to carry it).
 */

/** Failures shown before "and n more". */
const FIRST = 3;

/** A line without its full stop, to run on after a colon. */
export const bare = (s: string) => s.trim().replace(/[.;:]+$/, '');

export function CheckLead({ cardKey, report }: { cardKey: string; report: RunReport }) {
  const failing = report.failures.length;
  const head = leadLine(report.rooms, failing);
  const rounds = roundLines(report.rooms);
  if (!head && !failing) return null;
  const id = `lead-${cardKey}`;
  const shown = report.failures.slice(0, FIRST);
  const more = report.failures.slice(FIRST);
  const all = report.failures;
  const item = (f: RunReport['failures'][number]) => {
    // Failures with one cause (both of a couple without a bed) say it once, under the last.
    const next = all[all.indexOf(f) + 1];
    const cause = f.cause && next?.cause !== f.cause ? f.cause : null;
    return (
      <li key={f.key} className="talk-check-fail">
        <span className="talk-app-icon talk-warn-mark">
          <Mark kind="warn" />
        </span>
        <span className="talk-app-text">
          <span className="talk-check-text">{keepTogether(f.says)}</span>
          {cause && <span className="talk-check-cause">{keepTogether(cause)}</span>}
        </span>
      </li>
    );
  };
  return (
    <section className="talk-check-lead" aria-labelledby={id} data-lead="">
      <p id={id} className={failing ? 'talk-check-head' : 'talk-check-head talk-check-pass'}>
        {!failing && (
          <span className="talk-check-mark">
            <Mark kind="check" />
          </span>
        )}
        {head ?? (failing ? `${failing} ${failing === 1 ? 'doesn’t' : 'don’t'} pass:` : '')}
      </p>
      {failing > 0 && <ul className="talk-check-fails">{shown.map(item)}</ul>}
      {more.length > 0 && (
        <details className="talk-already talk-check-more">
          <summary>and {more.length} more</summary>
          <ul className="talk-check-fails">{more.map(item)}</ul>
        </details>
      )}
      {rounds.length > 0 && (
        <details className="talk-already talk-check-how">
          <summary>How it was checked</summary>
          <ul>
            {rounds.map((l) => (
              <li key={l}>{keepTogether(l)}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** Whether a card has a lead to show (so its Checks row says "listed above"). */
export const hasLead = (report: RunReport) =>
  report.failures.length > 0 || fixSummary(report.rooms).sent > 0;

/**
 * What this design set out to fix (its plan's `addresses`), each with how it came out on this
 * version's own report: a check when nothing of that failure is left, else a warn mark and
 * "Still doesn't pass". Shown only when the plan said.
 */
export function SetOutToFix({
  addresses,
  report,
}: {
  addresses: readonly PlanAddress[];
  report: RunReport;
}) {
  if (!addresses.length) return null;
  const rows = addressedIn(addresses, report);
  return (
    <section className="talk-set-out" aria-label="What this design set out to fix">
      <h4 className="talk-set-out-head">What this design set out to fix</h4>
      <ul>
        {rows.map((a, i) => (
          <li key={a.says} className="talk-app-line">
            <span className={a.done ? 'talk-app-icon' : 'talk-app-icon talk-warn-mark'}>
              <Mark kind={a.done ? 'check' : 'warn'} />
            </span>
            <span className="talk-app-text">
              <span>
                {keepTogether(`${bare(a.says)}: ${bare(a.change)}`)}
                {a.done
                  ? ''
                  : addresses[i]?.id.startsWith('L')
                    ? '. Still left out'
                    : '. Still doesn’t pass'}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
