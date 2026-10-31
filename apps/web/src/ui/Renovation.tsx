import {
  type ChangePlace,
  type RenovationChange,
  type RenovationDiff,
  endRenovation,
  renovationChanges,
  renovationDiff,
  startRenovation,
} from '@dhd/core';
import { useMemo, useState } from 'react';
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

/** The renovation's changes, room by room, or null without one. */
function useRenovationChanges(diff: RenovationDiff | null): RenovationChange[] | null {
  const doc = useProject();
  const before = doc.levels[0];
  const after = doc.renovation?.levels[0];
  return useMemo(
    () => (before && after && diff ? renovationChanges(before, after, diff) : null),
    [before, after, diff],
  );
}

/** Where a change is, in words: "Kitchen", "Kitchen, outside wall", "Between A and B". */
export function placeText(p: ChangePlace): string {
  const [one, two, ...more] = p.rooms;
  if (!one) return 'Outside';
  if (!two) return p.outside ? `${one}, outside wall` : one;
  return more.length ? `Between ${p.rooms.join(', ')}` : `Between ${one} and ${two}`;
}

const OPENING_NAMES = { door: 'door', window: 'window', passage: 'opening' } as const;

const cap = (w: string) => `${w[0]?.toUpperCase() ?? ''}${w.slice(1)}`;
const an = (w: string) => `${/^[aeiou]/.test(w) ? 'an' : 'a'} ${w}`;

/** What a change is, in words. */
export function changeText(c: RenovationChange): string {
  switch (c.kind) {
    case 'hack':
      return `Hack ${formatLength(c.length)} of wall`;
    case 'build':
      return `Build ${formatLength(c.length)} of wall`;
    case 'opening': {
      const what = OPENING_NAMES[c.opening];
      const What = cap(what);
      if (c.change === 'added') return `New ${what}, ${formatLength(c.width)} wide`;
      if (c.change === 'removed') return `Close up the ${what} (${formatLength(c.width)} wide)`;
      if (c.change === 'with-wall') return `${What} goes with the wall`;
      const b = c.before ?? {};
      const parts: string[] = [];
      if (b.width !== undefined)
        parts.push(
          `${c.width > b.width ? 'widened' : 'narrowed'} from ${formatLength(b.width)} to ${formatLength(c.width)}`,
        );
      if (b.height !== undefined && c.height !== undefined)
        parts.push(
          `made ${c.height > b.height ? 'taller' : 'shorter'}, ${formatLength(b.height)} to ${formatLength(c.height)}`,
        );
      if (b.sill !== undefined && c.sill !== undefined)
        parts.push(`sill ${c.sill > b.sill ? 'raised' : 'lowered'} to ${formatLength(c.sill)}`);
      if (c.moved) parts.push('moved');
      const head = b.opening ? `${cap(OPENING_NAMES[b.opening])} made ${an(what)}` : What;
      return parts.length ? `${head}${b.opening ? ',' : ''} ${parts.join(', ')}` : head;
    }
    case 'rename':
      return `Renamed (was ${c.from})`;
    case 'floor':
      return `Floor from ${c.from} to ${c.to}`;
    case 'area':
      return `Floor area ${formatArea(c.before)} to ${formatArea(c.after)}`;
    case 'room':
      return c.change === 'added'
        ? `New room, ${formatArea(c.area)}`
        : `No longer a room of its own (was ${formatArea(c.area)})`;
  }
}

/** Changes grouped by place, in order (renovationChanges sorts them by place). */
function byPlace(changes: RenovationChange[]): { place: string; items: string[] }[] {
  const out: { place: string; items: string[] }[] = [];
  for (const c of changes) {
    const place = placeText(c);
    const last = out[out.length - 1];
    if (last?.place === place) last.items.push(changeText(c));
    else out.push({ place, items: [changeText(c)] });
  }
  return out;
}

/** The renovation's changes as plain text, a line per place, to send to a contractor. */
export function changesAsText(changes: RenovationChange[]): string {
  return byPlace(changes)
    .map((g) => `${g.place}: ${g.items.join('; ')}`)
    .join('\n');
}

/** The changes, room by room, with a button to copy them as text. */
function ChangeList({ changes }: { changes: RenovationChange[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  if (changes.length === 0) return null;
  const copy = async () => {
    const text = changesAsText(changes);
    let done = false;
    try {
      await navigator.clipboard.writeText(text);
      done = true;
    } catch {
      // No clipboard API here (an insecure page, say): the old way, through a selection.
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      done = document.execCommand('copy');
      area.remove();
    }
    setCopied(done ? 'Copied' : "Couldn't copy");
    setTimeout(() => setCopied(null), done ? 1500 : 4000);
  };
  return (
    <div className="reno-changes">
      <span className="reno-changes-head">
        <h4 className="section-title">Changes, room by room</h4>
        <button type="button" className="btn btn-small" onClick={() => void copy()}>
          {copied ?? 'Copy list'}
        </button>
      </span>
      <ul>
        {byPlace(changes).map((g) => (
          <li key={g.place}>
            <span className="reno-place">{g.place}</span>
            <ul>
              {g.items.map((t, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a place's changes have no ids
                <li key={i}>{t}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One line for the bar: what's hacked and what's built. */
export function diffLine(d: RenovationDiff): string {
  const parts: string[] = [];
  if (d.demolishedLength > 0) parts.push(`${formatLength(d.demolishedLength)} of wall hacked`);
  if (d.builtLength > 0) parts.push(`${formatLength(d.builtLength)} built`);
  const doors = openingsText(d);
  if (doors) parts.push(doors);
  return parts.length ? parts.join(' · ') : 'No changes yet';
}

/**
 * "1 opening changed, 1 added", or '' for none: doors, windows and plain openings, where one
 * moved or resized (the same one in both versions) is changed, not added and removed.
 */
function openingsText(d: RenovationDiff): string {
  const changed = d.openingsAdded.filter((id) => d.openingsRemoved.includes(id)).length;
  const added = d.openingsAdded.length - changed;
  const removed = d.openingsRemoved.length - changed;
  const parts = [
    changed && `${changed} changed`,
    added && `${added} added`,
    removed && `${removed} removed`,
  ].filter(Boolean);
  if (!parts.length) return '';
  const n = changed || added || removed;
  return `${n === 1 ? 'Opening' : 'Openings'}: ${parts.join(', ')}`;
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
        onChange={(v) => {
          // An Undo offered for the other version would undo out of sight.
          useStore.setState({ toast: null });
          setVariant(v);
        }}
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
  const changes = useRenovationChanges(diff);
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
          <dt>Doors, windows, openings</dt>
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
      {changes && <ChangeList changes={changes} />}
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
