import type { Design, DesignProblem, DesignResult, ResultCheck } from '@dhd/core';
import { showPoint, showRoom } from './focus';
import { humanize, problemRoom } from './words';

/**
 * A version's checks, in the app's words (spec docs/specs/ai-designer-v2.md, "Hard and soft"):
 * whether it passes every hard check it caused, what it fixed before you saw it, what doesn't
 * pass (and what you accepted anyway), what was already in your plan, and the advice that
 * never blocks it. Never written by the model.
 */

/** The checks a version caused that fail, waived or not. */
export function failingChecks(r: DesignResult, d: Pick<Design, 'waivers'>) {
  const waived = new Set((d.waivers ?? []).map((w) => w.key));
  const caused = r.checks.filter((c) => c.hard && !c.already);
  return {
    open: caused.filter((c) => !waived.has(c.key)),
    waived: caused.filter((c) => waived.has(c.key)),
    already: r.checks.filter((c) => c.hard && c.already),
  };
}

/** The checks' line on a version: "Passes all checks" or "2 don't pass". */
export function checksLine(r: DesignResult, d: Pick<Design, 'waivers'>): string {
  const { open } = failingChecks(r, d);
  if (!open.length) return 'Passes all checks';
  return `${open.length} ${open.length === 1 ? 'doesn’t' : 'don’t'} pass`;
}

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
}: {
  c: ResultCheck | DesignProblem;
  r: DesignResult;
  d: Design;
  note?: string;
}) {
  const p = 'key' in c ? asProblem(c) : c;
  const it = p.itemId ? r.level.items[p.itemId] : undefined;
  const room = problemRoom(p, r.level);
  return (
    <li>
      <span>
        {room ? <strong>{room}: </strong> : null}
        {humanize(p.text, d.aliases, r.level, d.baseLevel)}
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

export function ChecksView({ d, r }: { d: Design; r: DesignResult }) {
  const { open, waived, already } = failingChecks(r, d);
  const fixed = fixedCount(d);
  const advice = adviceOf(r);
  const id = `checks-${d.id}`;
  return (
    <section className="designer-checks" aria-labelledby={id}>
      <h4 id={id} className="section-title">
        Checks
      </h4>
      <p className={open.length ? 'designer-checks-line negative' : 'designer-checks-line'}>
        <span aria-hidden="true">{open.length ? '✕' : '✓'}</span> {checksLine(r, d)}
        {waived.length > 0 && <span className="muted"> · {waived.length} accepted anyway</span>}
      </p>
      {fixed > 0 && (
        <p className="field-hint">
          Checked and fixed {fixed} {fixed === 1 ? 'problem' : 'problems'} before showing you this.
        </p>
      )}
      {open.length + waived.length > 0 && (
        <ul className="designer-problems designer-failing">
          {open.map((c) => (
            <Row key={c.key} c={c} r={r} d={d} />
          ))}
          {waived.map((c) => (
            <Row key={c.key} c={c} r={r} d={d} note="(accepted anyway)" />
          ))}
        </ul>
      )}
      {open.length > 0 && (
        <p className="field-hint">
          These parts are left unticked in Accept; Change something can ask the designer again.
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
