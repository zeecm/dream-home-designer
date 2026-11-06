import {
  BATHROOMS,
  type Design,
  type Part,
  allowedParts,
  aspectOf,
  dependsOnWalls,
  renovationChanges,
} from '@dhd/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useProject } from '../../store';
import { icons } from '../../ui/icons';
import { baseOf, planChanged, resultFor } from './plan';
import { acceptVersion, designOpts } from './state';

/**
 * Put a version into the renovation: the walls (all or nothing), then per space its
 * furniture, built-ins, paint and floor, and electrical points. One undo step.
 */

type Aspect = 'furniture' | 'built-ins' | 'finishes' | 'electrical';
const NAMES: Record<Aspect, string> = {
  furniture: 'Furniture',
  'built-ins': 'Built-ins',
  finishes: 'Paint and floor',
  electrical: 'Electrical points',
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const key = (p: Part) => ('space' in p ? `${p.space}|${p.aspect}` : 'walls');

export function AcceptDialog({ design: d, onClose }: { design: Design; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const project = useProject();
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);
  const close = () => ref.current?.close();
  const now = baseOf(project, 'after')?.base;
  const r = useMemo(
    () => resultFor(project, { ...d, base: { ...d.base, variant: 'after' } }, designOpts(project)),
    [project, d],
  );
  const rows = useMemo(() => {
    if (!r || !now) return null;
    const changes = renovationChanges(now, r.level).filter(
      (c) => c.kind === 'hack' || c.kind === 'build' || c.kind === 'opening',
    );
    const spaces = r.spaces
      .filter((s) => s.items.length || s.status === 'done' || s.status === 'copied')
      .map((s) => {
        const items = s.items.map((id) => r.level.items[id]).filter((it) => !!it);
        const counts: Record<Aspect, number> = {
          furniture: items.filter((it) => aspectOf(it) === 'furniture').length,
          'built-ins': items.filter((it) => aspectOf(it) === 'built-ins').length,
          finishes: 1,
          electrical: r.points.filter((p) => s.rooms.includes(p.roomId)).length,
        };
        return { s, counts, needsWalls: dependsOnWalls(now, r.level, s) };
      });
    // Placed by hand since the version was made: kept unless asked.
    const byHand = Object.values(now.items).filter(
      (it) => !d.baseLevel.items[it.id] && !r.level.items[it.id],
    ).length;
    return { changes, spaces, byHand };
  }, [r, now, d]);
  const [ticked, setTicked] = useState<Set<string> | null>(null);
  const [removeHand, setRemoveHand] = useState(false);
  if (!r || !now || !rows) return null;
  const all: Part[] = [
    ...(rows.changes.length ? [{ aspect: 'walls' } as Part] : []),
    ...rows.spaces.flatMap((x) =>
      (Object.keys(NAMES) as Aspect[])
        .filter((a) => x.counts[a] > 0 && (a !== 'electrical' || d.brief.electrical))
        .map((aspect) => ({ space: x.s.key, aspect }) as Part),
    ),
    ...(d.concept?.bathrooms.length ? [{ space: BATHROOMS, aspect: 'finishes' } as Part] : []),
  ];
  const on = ticked ?? new Set(all.map(key));
  const chosen = all.filter((p) => on.has(key(p)));
  const allowed = allowedParts(now, r.level, chosen);
  const ok = new Set(allowed.map(key));
  const walls = on.has('walls');
  const count = allowed.reduce((t, p) => {
    if (!('space' in p)) return t + rows.changes.length;
    if (p.space === BATHROOMS) return t + 1;
    const x = rows.spaces.find((y) => y.s.key === p.space);
    return t + (x ? x.counts[p.aspect as Aspect] : 0);
  }, 0);
  const toggle = (k: string) => {
    const next = new Set(on);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setTicked(next);
  };
  const changed = planChanged(project, d);

  return (
    <dialog
      ref={ref}
      className="dialog accept-dialog"
      aria-labelledby="accept-h"
      onClose={(e) => e.target === e.currentTarget && onClose()}
    >
      <header className="dialog-head">
        <h2 id="accept-h">Put V{d.n} into your renovation</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
          {icons.close}
        </button>
      </header>
      <div className="dialog-body accept-body">
        {changed && (
          <p className="notice-warning">
            Your plan has changed since V{d.n} was made. It has been checked again on the plan as it
            is now.
          </p>
        )}
        {rows.changes.length > 0 && (
          <label className="check-row accept-walls">
            <input type="checkbox" checked={walls} onChange={() => toggle('walls')} />
            <span>
              <strong>Walls and doors</strong>
              <span className="field-hint">
                {' '}
                {plural(rows.changes.length, 'change')} to walls and doors
                {r.structural.length ? ' (structural changes included)' : ''}
              </span>
            </span>
          </label>
        )}
        {rows.spaces.map((x) => (
          <fieldset key={x.s.key} className="accept-space">
            <legend>{x.s.name}</legend>
            <div className="accept-grid">
              {(Object.keys(NAMES) as Aspect[]).map((a) => {
                const k = `${x.s.key}|${a}`;
                const exists = all.some((p) => key(p) === k);
                const blocked = exists && x.needsWalls && !walls;
                return (
                  <label key={a} className={exists ? 'check-row' : 'check-row accept-none'}>
                    <input
                      type="checkbox"
                      disabled={!exists || blocked}
                      checked={exists && on.has(k) && ok.has(k)}
                      onChange={() => toggle(k)}
                    />
                    <span>
                      {NAMES[a]}
                      {a !== 'finishes' && <span className="muted num"> ({x.counts[a]})</span>}
                      {blocked && (
                        <span className="field-hint accept-why">Needs the walls from V{d.n}</span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
        {d.concept?.bathrooms.length ? (
          <label className="check-row">
            <input
              type="checkbox"
              checked={on.has(`${BATHROOMS}|finishes`)}
              onChange={() => toggle(`${BATHROOMS}|finishes`)}
            />
            <span>Bathrooms: paint and floor</span>
          </label>
        ) : null}
        {rows.byHand > 0 && (
          <label className="check-row">
            <input
              type="checkbox"
              checked={removeHand}
              onChange={(e) => setRemoveHand(e.target.checked)}
            />
            <span>Also remove the {plural(rows.byHand, 'piece')} you placed yourself</span>
          </label>
        )}
        <p className="field-hint">
          One undo step. Pieces you placed yourself stay unless you tick above.
        </p>
      </div>
      <footer className="dialog-foot">
        <div className="button-row">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={count === 0}
            onClick={() => {
              void acceptVersion(d, allowed, removeHand).then((done) => done && close());
            }}
          >
            Accept {plural(count, 'change')}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
