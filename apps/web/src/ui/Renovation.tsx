import { type RenovationDiff, endRenovation, renovationDiff, startRenovation } from '@dhd/core';
import { useMemo } from 'react';
import { useEditor } from '../editor';
import { pts } from '../plan/layers';
import { useProject, useStore } from '../store';
import { formatArea, formatLength } from '../units';
import { Segmented } from './fields';

/** What the renovation changes on the first level, or null without one. */
export function useRenovationDiff(): RenovationDiff | null {
  const doc = useProject();
  const before = doc.levels[0];
  const after = doc.renovation?.levels[0];
  return useMemo(() => (before && after ? renovationDiff(before, after) : null), [before, after]);
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One line for the bar: what's hacked and what's built. */
export function diffLine(d: RenovationDiff): string {
  const parts: string[] = [];
  if (d.demolishedLength > 0) parts.push(`${formatLength(d.demolishedLength)} of wall hacked`);
  if (d.builtLength > 0) parts.push(`${formatLength(d.builtLength)} built`);
  const doors = openingsText(d);
  if (doors) parts.push(doors);
  return parts.length ? parts.join(' · ') : 'No changes yet';
}

/** "1 door or window added, 2 removed", or '' for none (a moved one is both). */
function openingsText(d: RenovationDiff): string {
  const added = d.openingsAdded.length;
  const removed = d.openingsRemoved.length;
  if (!added && !removed) return '';
  const what = (n: number) => count(n, 'door or window', 'doors or windows');
  if (added && removed) return `${what(added)} added, ${removed} removed`;
  return added ? `${what(added)} added` : `${what(removed)} removed`;
}

/**
 * Over the stage while a plan has a renovation: which version is shown, and what changes.
 * Edits go to the version shown.
 */
export function RenovationBar() {
  const has = useProject().renovation !== undefined;
  const variant = useEditor((s) => s.variant);
  const setVariant = useEditor((s) => s.setVariant);
  const diff = useRenovationDiff();
  if (!has || !diff) return null;
  return (
    <div className="reno-bar">
      <Segmented
        label="Version"
        value={variant}
        onChange={setVariant}
        options={[
          { value: 'before', label: 'Before', title: 'The flat as it is' },
          { value: 'after', label: 'After', title: 'The flat as renovated' },
        ]}
      />
      <span className="reno-summary">
        <span className="reno-key reno-key-hack" aria-hidden="true" />
        <span className="reno-key reno-key-new" aria-hidden="true" />
        <span className="reno-summary-text">
          {/* Edits go to the version shown; say which, so a fix to the trace isn't a surprise. */}
          <span className="reno-editing">
            {variant === 'before' ? 'Editing the flat as it is. ' : 'Editing the renovation. '}
          </span>
          {diffLine(diff)}
        </span>
      </span>
    </div>
  );
}

/**
 * The hacking plan, over the walls (in plan units, inside the view transform): wall to be hacked crossed out in red, and new wall in
 * the accent colour. Before shows what goes and where new wall will stand; after shows
 * what went and what's new.
 */
export function RenovationMarks() {
  const variant = useEditor((s) => s.variant);
  const diff = useRenovationDiff();
  if (!diff) return null;
  const after = variant === 'after';
  return (
    <g className={`reno-marks ${after ? 'reno-after' : 'reno-before'}`} pointerEvents="none">
      <defs>
        <pattern
          id="reno-hatch"
          width={0.12}
          height={0.12}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1={0} y1={0} x2={0} y2={0.12} className="reno-hatch-line" />
        </pattern>
      </defs>
      {diff.demolished.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stretches have no id of their own
        <g key={`d${i}`}>
          {/* A pale ground under the hatch, so it shows over the black of a wall. */}
          <polygon className="reno-hack-ground" points={pts(s.polygon)} />
          <polygon className="reno-hack" points={pts(s.polygon)} />
        </g>
      ))}
      {diff.built.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stretches have no id of their own
        <polygon key={`b${i}`} className="reno-new" points={pts(s.polygon)} />
      ))}
    </g>
  );
}

/** In the plan details: start a renovation, or see what it changes and finish it. */
export function RenovationSection() {
  const dispatch = useStore((s) => s.dispatch);
  const setVariant = useEditor((s) => s.setVariant);
  const diff = useRenovationDiff();
  if (!diff) {
    return (
      <section className="reno-section" aria-labelledby="reno-h">
        <h3 id="reno-h" className="section-title">
          Renovation
        </h3>
        <p className="field-hint">
          Keeps this plan as the flat is today, and starts a copy to change: hack walls, build new
          ones, refurnish. Switch between before and after any time.
        </p>
        <button
          type="button"
          className="btn"
          onClick={() => {
            dispatch(startRenovation());
            setVariant('after');
          }}
        >
          Plan a renovation
        </button>
      </section>
    );
  }
  const change = diff.areaAfter - diff.areaBefore;
  return (
    <section className="reno-section" aria-labelledby="reno-h">
      <h3 id="reno-h" className="section-title">
        Renovation
      </h3>
      <dl className="reno-facts">
        <div>
          <dt>
            <span className="reno-key reno-key-hack" aria-hidden="true" />
            Wall hacked
          </dt>
          <dd className="num">{formatLength(diff.demolishedLength)}</dd>
        </div>
        <div>
          <dt>
            <span className="reno-key reno-key-new" aria-hidden="true" />
            New wall
          </dt>
          <dd className="num">{formatLength(diff.builtLength)}</dd>
        </div>
        <div>
          <dt>Doors and windows</dt>
          <dd>{openingsText(diff) || 'No change'}</dd>
        </div>
        <div>
          <dt>Floor area</dt>
          <dd className="num">
            {formatArea(diff.areaAfter)}
            {Math.abs(change) >= 0.05 && (
              <span className="muted">
                {' '}
                ({change > 0 ? '+' : '−'}
                {formatArea(Math.abs(change))})
              </span>
            )}
          </dd>
        </div>
      </dl>
      <p className="field-hint">
        Edits go to the version shown above the plan. Moving a wall counts as hacking it and
        building it anew. Once the work is done, make the renovation the plan; either step can be
        undone.
      </p>
      <span className="button-row">
        <button
          type="button"
          className="btn btn-small"
          onClick={() => {
            dispatch(endRenovation('after'));
            setVariant('before');
          }}
        >
          Make it the plan
        </button>
        <button
          type="button"
          className="btn btn-small btn-danger"
          onClick={() => {
            dispatch(endRenovation('before'));
            setVariant('before');
          }}
        >
          Discard the renovation
        </button>
      </span>
    </section>
  );
}
