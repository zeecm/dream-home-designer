import { type Design, type DesignResult, type Level, renovationChanges } from '@dhd/core';
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useProject } from '../../store';
import { Segmented } from '../../ui/fields';
import { MiniLayout, sharedBox } from '../MiniLayout';
import { ordered, togglePick } from './compare';
import { baseOf, resultFor } from './plan';
import { closeCompare, designOpts, previewFrom, useDesigner } from './state';
import { humanize, problemRoom } from './words';

/**
 * Compare, over the stage: the flat as it is, then two versions, each drawn at one shared
 * scale (rooms tinted by their floor, pieces in outline), with its style, renovation cost,
 * wall changes and problems. Picking a column's plan previews it. On a phone, one column at a
 * time: Before / V1 / V2 above it, or a swipe across it.
 */

const k = (v: number) => `${Math.round(v / 1000)}k`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Problems listed under a column; the rest are counted. */
const SHOWN_PROBLEMS = 3;

interface Column {
  key: string;
  title: string;
  name: string;
  level: Level;
  design: Design | null;
  result: DesignResult | null;
  changes: number;
}

export function DesignerCompare() {
  const st = useDesigner(
    useShallow((s) => ({ comparing: s.comparing, designs: s.designs, selected: s.selected })),
  );
  if (!st.comparing) return null;
  return <CompareView picks={st.comparing} designs={st.designs} />;
}

function CompareView({ picks, designs }: { picks: string[]; designs: Design[] }) {
  const project = useProject();
  const before = project.levels[0];
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = ordered(designs, picks).join();
  const columns = useMemo<Column[]>(() => {
    if (!before) return [];
    const out: Column[] = [
      {
        key: 'before',
        title: 'Before',
        name: 'The flat as it is',
        level: before,
        design: null,
        result: null,
        changes: 0,
      },
    ];
    for (const id of shown ? shown.split(',') : []) {
      const d = designs.find((x) => x.id === id);
      const r = d ? resultFor(project, d, designOpts(project)) : null;
      if (!d || !r) continue;
      const base = baseOf(project, d.base.variant)?.base;
      const changes = base
        ? renovationChanges(base, r.level).filter(
            (c) => c.kind === 'hack' || c.kind === 'build' || c.kind === 'opening',
          ).length
        : 0;
      out.push({
        key: d.id,
        title: `V${d.n}`,
        name: d.concept?.name ?? d.name,
        level: r.level,
        design: d,
        result: r,
        changes,
      });
    }
    return out;
  }, [project, before, designs, shown]);
  const box = useMemo(() => sharedBox(columns.map((c) => c.level)), [columns]);
  // The phone's one column; the last version picked to start with.
  const [on, setOn] = useState<string>(columns[columns.length - 1]?.key ?? 'before');
  const current = columns.some((c) => c.key === on) ? on : (columns[0]?.key ?? 'before');
  const step = (by: number) => {
    const i = columns.findIndex((c) => c.key === current);
    const next = columns[Math.min(columns.length - 1, Math.max(0, i + by))];
    if (next) setOn(next.key);
  };

  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  // Esc closes it (before Esc leaves the preview under it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]'))
        return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // A sideways swipe moves between the columns (a phone shows one at a time).
  const swipe = useRef<{ x: number; y: number } | null>(null);

  if (!before) return null;
  return (
    <section className="designer-compare" aria-labelledby="compare-h">
      <header className="compare-head">
        <h2 id="compare-h" ref={heading} tabIndex={-1}>
          Compare
        </h2>
        {designs.length > 2 && (
          <fieldset className="compare-picks" aria-label="Versions to compare">
            {[...designs]
              .sort((a, b) => a.n - b.n)
              .map((d) => (
                <label key={d.id} className="check-row">
                  <input
                    type="checkbox"
                    checked={picks.includes(d.id)}
                    onChange={() => useDesigner.setState({ comparing: togglePick(picks, d.id) })}
                  />
                  <span>V{d.n}</span>
                </label>
              ))}
          </fieldset>
        )}
        <button type="button" className="btn compare-done" onClick={close}>
          Done
        </button>
      </header>
      <div className="compare-switch">
        <Segmented
          label="Column"
          fill
          value={current}
          onChange={setOn}
          options={columns.map((c) => ({ value: c.key, label: c.title, title: c.name }))}
        />
      </div>
      <div
        className="compare-cols"
        style={{ '--n': columns.length } as CSSProperties}
        onPointerDown={(e) => {
          if (e.pointerType !== 'mouse') swipe.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          const s = swipe.current;
          swipe.current = null;
          if (!s) return;
          const dx = e.clientX - s.x;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(e.clientY - s.y) * 1.5) {
            step(dx < 0 ? 1 : -1);
          }
        }}
        onPointerCancel={() => {
          swipe.current = null;
        }}
      >
        {columns.map((c) => (
          <CompareColumn
            key={c.key}
            c={c}
            before={before}
            box={box}
            on={c.key === current}
            budgetHigh={c.design?.brief.budget?.high ?? null}
          />
        ))}
      </div>
    </section>
  );
}

function close() {
  closeCompare();
  requestAnimationFrame(() =>
    document.querySelector<HTMLButtonElement>('[data-compare-open]')?.focus(),
  );
}

function CompareColumn({
  c,
  before,
  box,
  on,
  budgetHigh,
}: {
  c: Column;
  before: Level;
  box: ReturnType<typeof sharedBox>;
  on: boolean;
  budgetHigh: number | null;
}) {
  const r = c.result;
  const d = c.design;
  const hId = `compare-${c.key}-h`;
  const dash = <span className="muted">–</span>;
  return (
    <section className={on ? 'compare-col compare-col-on' : 'compare-col'} aria-labelledby={hId}>
      <h3 id={hId} className="compare-col-title">
        <span>{c.title}</span> <span className="compare-col-name">{c.name}</span>
      </h3>
      <button
        type="button"
        className="compare-plan"
        aria-label={d ? `Preview ${c.title} on the plan` : 'Show the flat as it is on the plan'}
        onClick={() => previewFrom(d ? d.id : null)}
      >
        <MiniLayout
          before={before}
          level={c.level}
          box={box}
          furnished
          className="mini-layout compare-mini"
        />
        <span className="compare-plan-hint" aria-hidden="true">
          {d ? 'Preview' : 'Show'}
        </span>
      </button>
      <dl className="compare-facts">
        <div>
          <dt>Style</dt>
          <dd>
            {d?.concept ? (
              <>
                <span className="compare-swatches" aria-hidden="true">
                  {d.concept.style.palette.map((p) => (
                    <span
                      key={`${p.hex}${p.use}`}
                      className="swatch"
                      style={{ background: p.hex }}
                    />
                  ))}
                </span>
                {d.concept.style.name}
              </>
            ) : d ? (
              dash
            ) : (
              'As it is'
            )}
          </dd>
        </div>
        <div>
          <dt>Renovation</dt>
          <dd className={r?.budget === 'over' ? 'num negative' : 'num'}>
            {r ? (
              <>
                S${k(r.cost.low)}–{k(r.cost.high)}
                {r.budget === 'over' && budgetHigh !== null && (
                  <span className="compare-sub">over your S${k(budgetHigh)}</span>
                )}
                {r.budget === 'within' && <span className="compare-sub">within your budget</span>}
              </>
            ) : (
              dash
            )}
          </dd>
        </div>
        <div>
          <dt>Wall changes</dt>
          <dd className="num">{r ? c.changes : dash}</dd>
        </div>
        <div>
          <dt>Problems</dt>
          <dd className="num">{r ? r.problems.length : dash}</dd>
        </div>
      </dl>
      {r && d && r.problems.length > 0 && (
        <ul className="compare-problems" aria-label={`${c.title}: problems`}>
          {r.problems.slice(0, SHOWN_PROBLEMS).map((p, i) => {
            const room = problemRoom(p, r.level);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: problems have no ids
              <li key={i}>
                {room ? <strong>{room}: </strong> : null}
                {humanize(p.text, d.aliases, r.level, d.baseLevel)}
              </li>
            );
          })}
          {r.problems.length > SHOWN_PROBLEMS && (
            <li className="muted">
              and {plural(r.problems.length - SHOWN_PROBLEMS, 'more problem')} on its card
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
