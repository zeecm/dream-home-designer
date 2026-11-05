import {
  type CostEstimate,
  type CostGroup,
  type CostLine,
  type Item,
  type Rate,
  type Rates,
  TYPICAL_RATES,
  carpentryCost,
  costEstimate,
} from '@dhd/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { useProject, useStore } from '../store';
import { icons } from '../ui/icons';
import { formatLength } from '../units';

const KEY = 'dhd-rates';

export const DISCLAIMER =
  'A rough guide from typical Singapore prices (2025–2026), not a quote. Prices vary with materials, contractor and site. Get itemised quotes from HDB-registered contractors.';

/** Rates as the person set them in this browser, over the typical ones. */
function loadRates(): Rates {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return merge(TYPICAL_RATES, JSON.parse(raw) as Partial<Rates>);
  } catch {
    // Unreadable or blocked: the typical rates.
  }
  return TYPICAL_RATES;
}

/** `over` laid over `base`, a level deep (doors, floors, carpentry are records of rates). */
function merge(base: Rates, over: Partial<Rates>): Rates {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    const b = (base as unknown as Record<string, unknown>)[k];
    if (b && typeof b === 'object' && !('low' in b) && v && typeof v === 'object') {
      out[k] = { ...b, ...(v as object) };
    } else if (b !== undefined) out[k] = v;
  }
  return out as unknown as Rates;
}

export const useRates = create<{
  rates: Rates;
  set: (rates: Rates) => void;
  reset: () => void;
}>((set) => ({
  rates: loadRates(),
  set: (rates) => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(rates));
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

/** The estimate for the first level: its renovation if there is one. */
export function useEstimate(): CostEstimate | null {
  const doc = useStore((s) => s.editor.doc);
  const rates = useRates((s) => s.rates);
  return useMemo(() => {
    const before = doc.levels[0];
    if (!before) return null;
    const after = doc.renovation?.levels.find((l) => l.id.startsWith(before.id));
    return costEstimate(before, after, rates);
  }, [doc, rates]);
}

export const money = (v: number) => `$${Math.round(v).toLocaleString('en-SG')}`;
export const range = (low: number, high: number) =>
  low === high ? money(low) : `${money(low)}–${money(high).slice(1)}`;

const GROUPS: CostGroup[] = [
  'Building',
  'Doors and windows',
  'Floors',
  'Painting',
  'Carpentry',
  'Contingency',
];

const qtyText = (l: CostLine) =>
  l.unit === 'each' || l.unit === 'lot'
    ? `${l.qty}`
    : `${l.unit === 'ft run' ? l.qty : l.qty.toFixed(l.unit === 'm' ? 2 : 1)} ${l.unit}`;

/** The estimate as plain text: lines, total and disclaimer (for Copy and Print). */
export function estimateText(est: CostEstimate, name: string): string {
  const rows = est.lines.map(
    (l) => `${l.label}${l.place ? ` · ${l.place}` : ''} · ${qtyText(l)} · ${range(l.low, l.high)}`,
  );
  return [
    `Cost estimate: ${name} (${new Date().toLocaleDateString('en-SG')})`,
    '',
    ...rows,
    '',
    `Total: about ${range(est.low, est.high)}`,
    '',
    DISCLAIMER,
  ].join('\n');
}

/** A built-in piece in the details panel: its width, foot runs and price. */
export function CarpentryLine({ item }: { item: Item }) {
  const rates = useRates((s) => s.rates);
  const c = carpentryCost(item, rates);
  if (!c) return null;
  const w = c.feet * 0.3048;
  return (
    <p className="field-hint carpentry-line">
      Built-in: {formatLength(w)} · {c.feet} ft run · about {range(c.low, c.high)}
    </p>
  );
}

/** In the plan details: the estimate's range, and a way into it. */
export function CostSummary() {
  const est = useEstimate();
  const [open, setOpen] = useState(false);
  if (!est || !est.lines.length) return null;
  return (
    <div className="field cost-summary">
      <span className="field-label">Cost estimate</span>
      <p className="cost-total">
        about <strong>{range(est.low, est.high)}</strong>
      </p>
      {!est.renovation && (
        <p className="field-hint">Start a renovation to price hacking, walls and floors.</p>
      )}
      <button type="button" className="btn btn-small" onClick={() => setOpen(true)}>
        See estimate
      </button>
      {open && <EstimateDialog onClose={() => setOpen(false)} />}
    </div>
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
];

/** One rate: low and high, swapped if the low is the higher. */
function RateRow({ row }: { row: (typeof RATE_ROWS)[number] }) {
  const { rates, set } = useRates();
  const v = row.get(rates);
  const commit = (low: number, high: number) => {
    if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high < 0) return;
    set(row.put(rates, low <= high ? { low, high } : { low: high, high: low }));
  };
  return (
    <div className="rate-row">
      <span className="rate-label">
        {row.label} <span className="muted">per {row.unit}</span>
      </span>
      <input
        className="input"
        inputMode="decimal"
        aria-label={`${row.label}, low`}
        defaultValue={v.low}
        key={`l${v.low}`}
        onBlur={(e) => commit(Number(e.target.value), v.high)}
      />
      <input
        className="input"
        inputMode="decimal"
        aria-label={`${row.label}, high`}
        defaultValue={v.high}
        key={`h${v.high}`}
        onBlur={(e) => commit(v.low, Number(e.target.value))}
      />
    </div>
  );
}

/** The estimate, line by line in groups, its rates, and Copy and Print. */
export function EstimateDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const est = useEstimate();
  const name = useProject().name;
  const { rates, set, reset } = useRates();
  const [copied, setCopied] = useState('');
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const close = () => ref.current?.close();
  if (!est) return null;
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
    const w = window.open('', '_blank', 'noopener=no');
    if (!w) return;
    const esc = (t: string) =>
      t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
    w.document.title = `Cost estimate: ${name}`;
    w.document.body.innerHTML = `<pre style="font: 13px/1.5 system-ui, sans-serif; white-space: pre-wrap">${esc(estimateText(est, name))}</pre>`;
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
        <p className="dialog-note">{DISCLAIMER}</p>
        {!est.renovation && (
          <p className="dialog-note">Start a renovation to price hacking, walls and floors.</p>
        )}
        <div className="estimate">
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
                    // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, rebuilt whole
                    <li key={i} className="estimate-line">
                      <span className="estimate-item">
                        {l.label}
                        {l.place && <span className="muted"> · {l.place}</span>}
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
