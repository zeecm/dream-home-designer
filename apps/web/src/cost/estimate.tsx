import {
  type CostEstimate,
  type CostGroup,
  type CostLine,
  ELEC_KINDS,
  ELEC_KIND_ORDER,
  type Item,
  type Level,
  type Project,
  type Rate,
  type Rates,
  TYPICAL_RATES,
  carpentryCost,
  itemSize,
  projectEstimate,
} from '@dhd/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { useProject, useStore } from '../store';
import { icons } from '../ui/icons';
import { formatLength } from '../units';
import {
  DISCLAIMER,
  byLevel,
  estimateText,
  fromFileText,
  levelsHint,
  qtyText,
  range,
  unpricedText,
} from './text';

export { DISCLAIMER, estimateText, money, range } from './text';

const KEY = 'dhd-rates';

type Loose = Record<string, unknown>;
const isRate = (v: unknown): v is Rate => {
  const r = v as Rate | null;
  return (
    !!r &&
    typeof r === 'object' &&
    Number.isFinite(r.low) &&
    Number.isFinite(r.high) &&
    r.low >= 0 &&
    r.high >= r.low
  );
};
const isRateLike = (v: unknown) => !!v && typeof v === 'object' && 'low' in (v as object);

/**
 * `over` laid on `base`, keeping only what is valid there: a rate with two numbers (low not
 * above high), a switch that is true or false, a group of rates (doors, floors, carpentry)
 * rate by rate. Anything else keeps the typical value.
 */
function merge(base: Rates, over: unknown): Rates {
  if (!over || typeof over !== 'object') return base;
  const out: Loose = { ...base };
  for (const [k, b] of Object.entries(base as unknown as Loose)) {
    const v = (over as Loose)[k];
    if (v === undefined) continue;
    if (typeof b === 'boolean') {
      if (typeof v === 'boolean') out[k] = v;
    } else if (isRateLike(b)) {
      if (isRate(v)) out[k] = v;
    } else if (b && typeof b === 'object' && v && typeof v === 'object') {
      const group: Loose = { ...(b as Loose) };
      for (const g of Object.keys(group)) if (isRate((v as Loose)[g])) group[g] = (v as Loose)[g];
      out[k] = group;
    }
  }
  return out as unknown as Rates;
}

/** What differs from the typical rates (so new typical rates still reach someone who edited one). */
function diff(rates: Rates): Loose {
  const out: Loose = {};
  for (const [k, b] of Object.entries(TYPICAL_RATES as unknown as Loose)) {
    const v = (rates as unknown as Loose)[k];
    if (JSON.stringify(v) !== JSON.stringify(b)) out[k] = v;
  }
  return out;
}

/** Rates as the person set them in this browser, over the typical ones. */
function loadRates(): Rates {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return merge(TYPICAL_RATES, JSON.parse(raw));
  } catch {
    // Unreadable or blocked: the typical rates.
  }
  return TYPICAL_RATES;
}

export const useRates = create<{
  rates: Rates;
  set: (rates: Rates) => void;
  reset: () => void;
}>((set) => ({
  rates: loadRates(),
  set: (rates) => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(diff(rates)));
    } catch {
      // Not remembered; used for this visit.
    }
    set({ rates });
  },
  reset: () => {
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      // Nothing to forget.
    }
    set({ rates: TYPICAL_RATES });
  },
}));

// One estimate for the summary and the dialog alike: the last one, while nothing changed.
let last: {
  levels: Level[];
  renovation: Project['renovation'];
  rates: Rates;
  est: CostEstimate;
} | null = null;

/** The estimate for every level, each with its renovation if there is one. */
export function useEstimate(): CostEstimate | null {
  // Immer keeps these the same objects through edits that don't touch them.
  const levels = useStore((s) => s.editor.doc.levels);
  const renovation = useStore((s) => s.editor.doc.renovation);
  const rates = useRates((s) => s.rates);
  return useMemo(() => {
    if (!levels.length) return null;
    if (last && last.levels === levels && last.renovation === renovation && last.rates === rates)
      return last.est;
    const est = projectEstimate({ levels, renovation }, rates);
    last = { levels, renovation, rates, est };
    return est;
  }, [levels, renovation, rates]);
}

const GROUPS: CostGroup[] = [
  'Building',
  'Doors and windows',
  'Floors',
  'Painting',
  'Carpentry',
  'Electrical',
  'Contingency',
];

/** A built-in piece in the details panel: its width, foot runs and price. */
export function CarpentryLine({ item }: { item: Item }) {
  const rates = useRates((s) => s.rates);
  const c = carpentryCost(item, rates);
  if (!c) return null;
  return (
    <p className="field-hint carpentry-line">
      Built-in: {formatLength(itemSize(item).w)} · {c.feet} ft run · about {range(c.low, c.high)}
    </p>
  );
}

/** In the plan details: the estimate's range, and a way into it. */
export function CostSummary() {
  const est = useEstimate();
  const [open, setOpen] = useState(false);
  if (!est) return null;
  return (
    <>
      <div className="field cost-summary">
        <span className="field-label">Cost estimate</span>
        {est.lines.length ? (
          <p className="cost-total">
            about <strong>{range(est.low, est.high)}</strong>
          </p>
        ) : (
          <p className="field-hint">Nothing to price yet.</p>
        )}
        {!est.renovation && (
          <p className="field-hint">Start a renovation to price hacking, walls and floors.</p>
        )}
        {levelsHint(est) && <p className="field-hint">{levelsHint(est)}</p>}
        {unpricedText(est) && <p className="field-hint">{unpricedText(est)}</p>}
        <button type="button" className="btn btn-small" onClick={() => setOpen(true)}>
          See estimate
        </button>
      </div>
      {open && <EstimateDialog onClose={() => setOpen(false)} />}
    </>
  );
}

const RATE_ROWS: {
  label: string;
  get: (r: Rates) => Rate;
  put: (r: Rates, v: Rate) => Rates;
  unit: string;
}[] = [
  ...(
    [
      ['hack', 'Hack wall', 'm'],
      ['newWall', 'New wall', 'm'],
      ['halfWall', 'Half wall', 'm'],
      ['glass', 'Glass partition', 'm'],
      ['glassAbove', 'Fixed glass above', 'm'],
      ['cutOpening', 'Cut an opening', 'each'],
      ['closeOpening', 'Close up an opening', 'each'],
      ['debris', 'Debris disposal', 'lot'],
      ['window', 'Window', 'each'],
      ['glassLeaves', 'Glass leaves', 'each'],
      ['paint', 'Painting', 'm²'],
      ['countertop', 'Countertop', 'ft run'],
      ['elecRemove', 'Take out an electrical point', 'each'],
      ['trunking', 'Aircon trunking', 'm'],
    ] as const
  ).map(([k, label, unit]) => ({
    label,
    unit,
    get: (r: Rates) => r[k],
    put: (r: Rates, v: Rate) => ({ ...r, [k]: v }),
  })),
  ...(
    [
      ['swing', 'Swing door'],
      ['double', 'Double door'],
      ['sliding', 'Sliding door'],
      ['pocket', 'Pocket door'],
      ['bifold', 'Bi-fold door'],
      ['folding', 'Folding partition'],
    ] as const
  ).map(([k, label]) => ({
    label,
    unit: 'each',
    get: (r: Rates) => r.door[k],
    put: (r: Rates, v: Rate) => ({ ...r, door: { ...r.door, [k]: v } }),
  })),
  ...(
    [
      ['vinyl', 'Vinyl floor'],
      ['timber', 'Timber floor'],
      ['tile', 'Tile floor'],
      ['marble', 'Marble floor'],
      ['concrete', 'Polished concrete'],
      ['carpet', 'Carpet'],
    ] as const
  ).map(([k, label]) => ({
    label,
    unit: 'm²',
    get: (r: Rates) => r.floor[k],
    put: (r: Rates, v: Rate) => ({ ...r, floor: { ...r.floor, [k]: v } }),
  })),
  ...(
    [
      ['wardrobe', 'Wardrobe'],
      ['tall', 'Tall cabinet'],
      ['low', 'Low cabinet'],
      ['base', 'Kitchen base cabinets'],
      ['wall', 'Kitchen wall cabinets'],
    ] as const
  ).map(([k, label]) => ({
    label,
    unit: 'ft run',
    get: (r: Rates) => r.carpentry[k],
    put: (r: Rates, v: Rate) => ({ ...r, carpentry: { ...r.carpentry, [k]: v } }),
  })),
  // Electrical points, new and moved (a compressor comes with the aircon).
  ...ELEC_KIND_ORDER.filter((k) => k !== 'compressor').flatMap((k) => [
    {
      label: `${ELEC_KINDS[k].name}, new`,
      unit: 'each',
      get: (r: Rates) => r.elecNew[k],
      put: (r: Rates, v: Rate) => ({ ...r, elecNew: { ...r.elecNew, [k]: v } }),
    },
    {
      label: `${ELEC_KINDS[k].name}, relocate`,
      unit: 'each',
      get: (r: Rates) => r.elecMove[k],
      put: (r: Rates, v: Rate) => ({ ...r, elecMove: { ...r.elecMove, [k]: v } }),
    },
  ]),
];

/** One rate: low and high, swapped if the low is the higher. */
function RateRow({ row }: { row: (typeof RATE_ROWS)[number] }) {
  const { rates, set } = useRates();
  const v = row.get(rates);
  // Bumped when an entry is refused, so the fields show the rate again.
  const [tries, setTries] = useState(0);
  const num = (t: string) => (t.trim() === '' ? Number.NaN : Number(t.replace(/[,\s$]/g, '')));
  const commit = (low: number, high: number) => {
    const ok = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1_000_000;
    if (!ok(low) || !ok(high)) {
      setTries((n) => n + 1);
      return;
    }
    set(row.put(rates, low <= high ? { low, high } : { low: high, high: low }));
  };
  return (
    <div className="rate-row">
      <span className="rate-label">
        {row.label}{' '}
        <span className="muted">
          {row.unit === 'each' ? 'each' : row.unit === 'lot' ? 'per job' : `per ${row.unit}`}
        </span>
      </span>
      <input
        className="input"
        inputMode="decimal"
        aria-label={`${row.label}, low`}
        defaultValue={v.low}
        key={`l${v.low}-${tries}`}
        onBlur={(e) => commit(num(e.target.value), v.high)}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <input
        className="input"
        inputMode="decimal"
        aria-label={`${row.label}, high`}
        defaultValue={v.high}
        key={`h${v.high}-${tries}`}
        onBlur={(e) => commit(v.low, num(e.target.value))}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    </div>
  );
}

/** The estimate, line by line in groups, its rates, and Copy and Print. */
export function EstimateDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const est = useEstimate();
  const project = useProject();
  const name = project.name;
  const { rates, set, reset } = useRates();
  const [copied, setCopied] = useState('');
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const close = () => ref.current?.close();
  if (!est) return null;
  const levels = byLevel(est);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(estimateText(est, name));
      setCopied('Copied');
    } catch {
      setCopied('Couldn’t copy');
    }
    setTimeout(() => setCopied(''), 2000);
  };
  const print = () => {
    // A page of its own: only the estimate, dated.
    const w = window.open('', '_blank');
    if (!w) return;
    const esc = (t: string) =>
      t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
    w.document.title = `Cost estimate: ${name}`;
    w.document.body.innerHTML = `<pre style="font: 13px/1.5 system-ui, sans-serif; white-space: pre-wrap">${esc(estimateText(est, name))}</pre>`;
    w.addEventListener('afterprint', () => w.close());
    w.print();
  };
  const toggle = (k: 'painting' | 'debrisOn' | 'contingency', label: string) => (
    <label className="check-row">
      <input
        type="checkbox"
        checked={rates[k]}
        onChange={(e) => set({ ...rates, [k]: e.target.checked })}
      />
      <span>{label}</span>
    </label>
  );
  return (
    <dialog
      ref={ref}
      className="dialog estimate-dialog"
      aria-labelledby="estimate-h"
      tabIndex={-1}
      onClose={(e) => e.target === e.currentTarget && onClose()}
    >
      <header className="dialog-head">
        <h2 id="estimate-h">Cost estimate</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
          {icons.close}
        </button>
      </header>
      <div className="dialog-body">
        {unpricedText(est) && <p className="dialog-note notice-warning">{unpricedText(est)}</p>}
        <p className="dialog-note">{DISCLAIMER}</p>
        {!est.renovation && (
          <p className="dialog-note">
            {est.lines.some((l) => l.group === 'Electrical')
              ? 'Start a renovation to price hacking, walls and floors, and only the electrical points that change: until then, every point is priced as new.'
              : 'Start a renovation to price hacking, walls and floors.'}
          </p>
        )}
        {fromFileText(est, project.levels[0]?.id) && (
          <p className="dialog-note">{fromFileText(est, project.levels[0]?.id)}</p>
        )}
        <div className="estimate">
          {levels.length > 0 && (
            <section className="estimate-group estimate-by-level" aria-label="By level">
              <h3 className="estimate-group-head">
                <span>By level</span>
              </h3>
              <ul className="estimate-lines">
                {levels.map((r) => (
                  <li key={r.id} className="estimate-line estimate-sub">
                    <span className="estimate-item">{r.name}</span>
                    <span className="num estimate-cost">{range(r.low, r.high)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {GROUPS.map((g) => {
            const lines = est.lines.filter((l) => l.group === g);
            if (!lines.length) return null;
            const low = lines.reduce((t, l) => t + l.low, 0);
            const high = lines.reduce((t, l) => t + l.high, 0);
            return (
              <section key={g} className="estimate-group" aria-label={g}>
                <h3 className="estimate-group-head">
                  <span>{g}</span>
                  <span className="num">{range(low, high)}</span>
                </h3>
                <ul className="estimate-lines">
                  {lines.map((l, i) => (
                    <li
                      // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, rebuilt whole
                      key={i}
                      className={`estimate-line${l.place ? ' has-place' : qtyText(l) ? '' : ' bare'}`}
                      data-level={l.levelId}
                    >
                      <span className="estimate-item">
                        <span className="estimate-label">{l.label}</span>
                        {l.place && <span className="muted estimate-place">{l.place}</span>}
                      </span>
                      <span className="num estimate-qty">{qtyText(l)}</span>
                      <span className="num estimate-cost">{range(l.low, l.high)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          <p className="estimate-total">
            <span>Total</span>
            <strong className="num">about {range(est.low, est.high)}</strong>
          </p>
        </div>
        <details className="estimate-rates">
          <summary>Rates (S$, low and high)</summary>
          <div className="rate-toggles">
            {toggle('painting', 'Repaint every room')}
            {toggle('debrisOn', 'Debris disposal when hacking')}
            {toggle('contingency', 'Add 10% contingency')}
          </div>
          <div className="rate-row rate-head" aria-hidden="true">
            <span />
            <span>Low</span>
            <span>High</span>
          </div>
          {RATE_ROWS.map((row) => (
            <RateRow key={row.label} row={row} />
          ))}
          <button type="button" className="btn btn-small" onClick={reset}>
            Reset to typical
          </button>
        </details>
      </div>
      <footer className="dialog-foot">
        <p className="field-hint" aria-live="polite">
          {copied}
        </p>
        <div className="button-row">
          <button type="button" className="btn btn-primary" onClick={() => void copy()}>
            Copy
          </button>
          <button type="button" className="btn" onClick={print}>
            Print
          </button>
        </div>
      </footer>
    </dialog>
  );
}
