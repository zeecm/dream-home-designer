import type { Design, DesignProblem, DesignResult, ResultCheck } from '@dhd/core';
import { showPoint, showRoom } from './focus';
import { checksLine, failingChecks, isUnplaced } from './parts';
import { humanize, keepTogether, problemRoom } from './words';

/**
 * A version's checks, in the app's words (spec docs/specs/ai-designer-v2.md, "Hard and soft"):
 * whether it passes every hard check it caused, what it fixed before you saw it, what doesn't
 * pass (and what you accepted anyway), what was already in your plan, and the advice that
 * never blocks it. Never written by the model.
 */
export { checksLine, checksShort, failingChecks } from './parts';

/** Fix rounds a version took, and what they fixed. */
export function fixedCount(d: Design): number {
  return Object.values(d.spaces).reduce((t, s) => t + (s.fixed ?? 0), 0);
}

const asProblem = (c: ResultCheck): DesignProblem => ({
  kind: 'clearance',
  text: c.text,
  ...(c.itemId ? { itemId: c.itemId } : {}),
  ...(c.roomId ? { roomId: c.roomId } : {}),
  ...(c.openingId ? { openingId: c.openingId } : {}),
});

/** Problems that are advice only (the hard ones are checks). */
export function adviceOf(r: DesignResult) {
  const soft = r.checks.filter((c) => !c.hard && !c.already);
  const problems = r.problems.filter(
    (p) => p.kind !== 'clearance' && p.kind !== 'walkway' && p.kind !== 'window',
  );
  return [...problems, ...soft.map(asProblem)];
}

function Row({
  c,
  r,
  d,
  note,
  waived = false,
}: {
  c: ResultCheck | DesignProblem;
  r: DesignResult;
  d: Design;
  note?: string;
  /** Accepted anyway: amber, not red. */
  waived?: boolean;
}) {
  const p = 'key' in c ? asProblem(c) : c;
  const it = p.itemId ? r.level.items[p.itemId] : undefined;
  const text = keepTogether(humanize(p.text, d.aliases, r.level, d.baseLevel));
  const room = problemRoom(p, r.level);
  return (
    <li {...(waived ? { className: 'designer-waived' } : {})}>
      <span>
        {/* The room once: not when the line names it already. */}
        {room && !text.includes(room) ? <strong>{room}: </strong> : null}
        {text}
        {note ? <span className="designer-check-note"> {note}</span> : null}
      </span>
      {(it || p.roomId) && (
        <button
          type="button"
          className="link-btn"
          onClick={() =>
            it
              ? showPoint({ x: it.position.x, y: it.position.z })
              : p.roomId && showRoom(r.level, [p.roomId])
          }
        >
          Show
        </button>
      )}
    </li>
  );
}

export function ChecksView({
  d,
  r,
  pending = new Set(),
}: {
  d: Design;
  r: DesignResult;
  /** Rooms still being designed or fixed: their checks wait. */
  pending?: Set<string>;
}) {
  const { open, waived, already } = failingChecks(r, d, pending);
  const line = checksLine(r, d, pending);
  const fixed = fixedCount(d);
  const advice = adviceOf(r);
  const assumed = r.checks.find((c) => c.key === 'P1|assumed');
  const waiting = r.spaces.filter((s) => s.rooms.some((id) => pending.has(id)));
  const id = `checks-${d.id}`;
  const hdb = open.some((c) => !c.waivable);
  return (
    <section className="designer-checks" aria-labelledby={id}>
      <h4 id={id} className="section-title">
        Checks
      </h4>
      <p className={`designer-checks-line designer-checks-${line.tone}`}>
        <span aria-hidden="true">
          {line.tone === 'pass' ? '✓' : line.tone === 'waived' ? '!' : '✕'}
        </span>{' '}
        {line.text}
        {line.tone === 'fail' && waived.length > 0 && (
          <span className="muted"> · {waived.length} accepted anyway</span>
        )}
      </p>
      {waiting.length > 0 && (
        <p className="field-hint">
          Checking {waiting.map((s) => s.name).join(', ')}… its results come when it’s done.
        </p>
      )}
      {assumed && <p className="field-hint">{assumed.text}</p>}
      {fixed > 0 && (
        <p className="field-hint">
          Checked and fixed {fixed} {fixed === 1 ? 'problem' : 'problems'} before showing you this.
        </p>
      )}
      {open.length + waived.length > 0 && (
        <ul className="designer-problems designer-failing">
          {open.map((c) => (
            <Row
              key={c.key}
              c={c}
              r={r}
              d={d}
              {...(isUnplaced(c)
                ? { note: '(this flat can’t give everyone a bed as it is)' }
                : !c.waivable
                  ? { note: '(HDB rule)' }
                  : {})}
            />
          ))}
          {waived.map((c) => (
            <Row key={c.key} c={c} r={r} d={d} note="(accepted anyway)" waived />
          ))}
        </ul>
      )}
      {open.length > 0 && (
        <p className="field-hint">
          We’ve left these out of Accept. To fix them, use Change something
          {hdb ? '; an HDB rule can’t be accepted anyway' : ''}.
        </p>
      )}
      {already.length > 0 && (
        <details>
          <summary>Already in your plan ({already.length})</summary>
          <ul className="designer-problems">
            {already.map((c) => (
              <Row key={c.key} c={c} r={r} d={d} />
            ))}
          </ul>
        </details>
      )}
      {advice.length > 0 && (
        <details>
          <summary>Advice ({advice.length})</summary>
          <ul className="designer-problems">
            {advice.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: advice lines have no ids
              <Row key={i} c={p} r={r} d={d} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
