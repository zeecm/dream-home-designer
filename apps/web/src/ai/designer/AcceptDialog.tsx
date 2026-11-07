import {
  BATHROOMS,
  type Design,
  type Item,
  type Part,
  type ResultCheck,
  allowedParts,
  aspectOf,
  dependsOnWalls,
  renovationChanges,
  roomIdAt,
  roomsBeside,
} from '@dhd/core';

/** Whether a piece is already in the renovation where the version puts it. */
const sameItem = (a: Item, b: Item | undefined) =>
  !!b &&
  a.assetId === b.assetId &&
  Math.abs(a.position.x - b.position.x) < 0.01 &&
  Math.abs(a.position.z - b.position.z) < 0.01 &&
  Math.abs(a.rotationY - b.rotationY) < 1e-3;
import { useEffect, useMemo, useRef, useState } from 'react';
import { useProject } from '../../store';
import { changeText, placeText } from '../../ui/Renovation';
import { icons } from '../../ui/icons';
import { failingParts } from './parts';
import { baseOf, changeFrom, onPlanNow, planChanged, resultFor } from './plan';
import { acceptVersion, designOpts, useDesigner, waiveChecks } from './state';
import { humanize, keepTogether } from './words';

/**
 * Put a version into the renovation: the walls (all or nothing), then per space its
 * furniture, built-ins, paint and floor, and electrical points. One undo step. A part with a
 * hard check it fails starts unticked, marked "Doesn't pass"; ticking it asks "Accept
 * anyway?" and records a waiver. A part failing an HDB rule can't be ticked.
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
  const designs = useDesigner((st) => st.designs);
  // On After as it is, keeping what was changed by hand since the last accept (never undone
  // here without a word: those parts are kept, and said so below).
  const from = useMemo(() => changeFrom(d, designs, project), [d, designs, project]);
  const r = useMemo(() => {
    const v = onPlanNow(d, designs, project);
    return resultFor(project, { ...v, base: { ...v.base, variant: 'after' } }, designOpts(project));
  }, [project, d, designs]);
  const rows = useMemo(() => {
    if (!r || !now) return null;
    const changes = renovationChanges(now, r.level).filter(
      (c) => c.kind === 'hack' || c.kind === 'build' || c.kind === 'opening',
    );
    const spaces = r.spaces
      .filter((s) => s.items.length || s.status === 'done' || s.status === 'copied')
      .map((s) => {
        // Only what isn't in the renovation already (a version accepted before counts nothing).
        const items = s.items
          .map((id) => r.level.items[id])
          .filter((it): it is Item => !!it && !sameItem(it, now.items[it.id]));
        const rooms = new Set(s.rooms);
        const finishes =
          s.rooms.some((id) => r.level.rooms[id]?.floorMaterial !== now.rooms[id]?.floorMaterial) ||
          Object.values(r.level.walls).some((w) => {
            const was = now.walls[w.id];
            const [left, right] = roomsBeside(r.level, w.id);
            return (
              (!!left && rooms.has(left) && w.materialLeft !== was?.materialLeft) ||
              (!!right && rooms.has(right) && w.materialRight !== was?.materialRight)
            );
          });
        const counts: Record<Aspect, number> = {
          furniture: items.filter((it) => aspectOf(it) === 'furniture').length,
          'built-ins': items.filter((it) => aspectOf(it) === 'built-ins').length,
          finishes: finishes ? 1 : 0,
          electrical: Object.values(r.level.points ?? {}).filter((p) => {
            if (now.points?.[p.id]) return false;
            const room = p.at
              ? roomIdAt(r.level, p.at)
              : p.wall
                ? roomsBeside(r.level, p.wall.wallId)[p.wall.side === 'left' ? 0 : 1]
                : null;
            return !!room && rooms.has(room);
          }).length,
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
  const [asking, setAsking] = useState<string | null>(null);
  // Accepted anyway in this dialog: held here, saved only when the accept goes through.
  const [anyway, setAnyway] = useState<Set<string>>(new Set());
  // The hard checks the version caused that fail (not waived before), by the part they belong to.
  const failing = useMemo(
    () => (r ? failingParts(r, new Set((d.waivers ?? []).map((w) => w.key))) : new Map()),
    [r, d],
  );
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
  const on = ticked ?? new Set(all.map(key).filter((k) => !failing.has(k)));
  const hdb = (k: string) => !!failing.get(k)?.hdb;
  const failsOf = (k: string) => (failing.get(k)?.checks ?? []) as ResultCheck[];
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
    else if (failing.has(k) && !anyway.has(k)) {
      // Not without saying so: Accept anyway (never for an HDB rule).
      if (!hdb(k)) setAsking(k);
      return;
    } else next.add(k);
    setTicked(next);
  };
  const acceptAnyway = (k: string) => {
    setAsking(null);
    setAnyway(new Set([...anyway, k]));
    setTicked(new Set([...on, k]));
  };
  const words = (t: string) => keepTogether(humanize(t, d.aliases, r.level, d.baseLevel));
  /** What leaving a part out leaves out, in words. */
  const leaves = (k: string) => {
    if (k === 'walls')
      return `Leaves out all ${plural(rows.changes.length, 'change')} to walls and doors.`;
    const [space, aspect] = k.split('|') as [string, Aspect];
    const x = rows.spaces.find((y) => y.s.key === space);
    if (!x) return null;
    const n = x.counts[aspect];
    const what = aspect === 'built-ins' ? 'built-in' : aspect === 'furniture' ? 'piece' : null;
    return what ? `Leaves out all ${plural(n, what)} in ${x.s.name}.` : null;
  };
  const why = (k: string) => {
    const cs = failsOf(k);
    if (!cs.length) return null;
    if (anyway.has(k)) {
      return (
        <span className="field-hint accept-why advise">
          Accepting anyway: {plural(cs.length, 'problem')}
        </span>
      );
    }
    return (
      <span className="field-hint accept-why negative">
        {hdb(k) ? 'HDB rule, can’t be accepted: ' : 'Doesn’t pass: '}
        {words(cs[0]?.text ?? '')}
        {cs.length > 1 ? ` (and ${cs.length - 1} more)` : ''}
        {!on.has(k) && leaves(k) ? <span className="accept-leaves"> {leaves(k)}</span> : null}
        {hdb(k) ? <span className="accept-leaves"> Change something to fix it.</span> : null}
      </span>
    );
  };
  const askRow = (k: string) =>
    asking === k ? (
      <div className="notice-warning accept-anyway" role="alertdialog" aria-label="Accept anyway?">
        <p>Accept anyway? {plural(failsOf(k).length, 'problem')}:</p>
        <ul className="accept-anyway-list">
          {failsOf(k).map((c) => (
            <li key={c.key}>{words(c.text)}</li>
          ))}
        </ul>
        <div className="button-row">
          <button type="button" className="btn btn-small" onClick={() => setAsking(null)}>
            Keep it out
          </button>
          <button type="button" className="btn btn-small" onClick={() => acceptAnyway(k)}>
            Accept anyway
          </button>
        </div>
      </div>
    ) : null;
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
        {from.held.length > 0 && from.accepted && (
          <p className="field-hint accept-held">
            Kept as you changed them since you accepted V{from.accepted.n}:{' '}
            {from.held.map((l) => l.label).join(', ')}. Change something can redo them.
          </p>
        )}
        {rows.changes.length > 0 && (
          <label className="check-row accept-walls">
            <input
              type="checkbox"
              checked={walls}
              disabled={!walls && hdb('walls')}
              onChange={() => toggle('walls')}
            />
            <span>
              <strong>Walls and doors</strong>
              <span className="field-hint">
                {' '}
                {plural(rows.changes.length, 'change')} to walls and doors
                {r.structural.length ? ' (structural changes included)' : ''}
              </span>
              {why('walls')}
            </span>
          </label>
        )}
        {askRow('walls')}
        {rows.changes.length > 0 && (
          <ul className="accept-changes">
            {rows.changes.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: changes have no ids
              <li key={i}>
                {placeText(c)}: {changeText(c)}
              </li>
            ))}
          </ul>
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
                      disabled={!exists || blocked || (!on.has(k) && hdb(k))}
                      checked={exists && on.has(k) && ok.has(k)}
                      onChange={() => toggle(k)}
                    />
                    <span>
                      {NAMES[a]}
                      {a !== 'finishes' && <span className="muted num"> ({x.counts[a]})</span>}
                      {blocked && (
                        <span className="field-hint accept-why">Needs the walls from V{d.n}</span>
                      )}
                      {exists && why(k)}
                    </span>
                  </label>
                );
              })}
            </div>
            {(Object.keys(NAMES) as Aspect[]).map((a) => (
              <div key={a}>{askRow(`${x.s.key}|${a}`)}</div>
            ))}
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
          One undo step.
          {rows.byHand > 0 ? ' Pieces you placed yourself stay unless you tick above.' : ''}
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
              // What was accepted anyway is saved with the accept, never before it.
              const waived = allowed.flatMap((p) =>
                anyway.has(key(p)) ? failsOf(key(p)).filter((c) => c.waivable) : [],
              );
              void (waived.length ? waiveChecks(d, waived) : Promise.resolve(d))
                .then((saved) => acceptVersion(saved, allowed, removeHand))
                .then((done) => done && close());
            }}
          >
            Accept {plural(count, 'change')}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
