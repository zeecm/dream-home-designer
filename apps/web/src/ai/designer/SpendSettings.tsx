import { PRICES, PRICES_AS_OF, type Price, priceOf } from '@dhd/core';
import { THRESHOLDS, type Threshold } from '@dhd/core';
import { type MutableRefObject, useEffect, useRef, useState } from 'react';
import {
  CAPS,
  hasOverride,
  priceInput,
  resetSpend,
  setCap,
  setPrice,
  tokens,
  usd,
  useSpend,
} from './spend';
import { setThreshold, useThreshold } from './talk/threshold';

/**
 * In AI settings: the tab's limit and what it has spent, and the prices used for the model
 * in use (US$ per million tokens), which the person can set to their own.
 */
export function SpendSettings({
  model,
  focus,
  commitRef,
}: {
  model: string;
  focus?: boolean;
  /** Set to a function that saves any prices typed (true), or shows why it can't (false). */
  commitRef?: MutableRefObject<(() => boolean) | null>;
}) {
  const { spend, cap, prices } = useSpend();
  const ask = useThreshold();
  const price = priceOf(model, prices);
  const listed = priceOf(model, PRICES);
  const ref = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    if (!focus) return;
    // After the dialog has opened (its own effect runs after this one).
    const f = requestAnimationFrame(() => {
      ref.current?.scrollIntoView({ block: 'start' });
      ref.current?.querySelector<HTMLInputElement>('input')?.focus();
    });
    return () => cancelAnimationFrame(f);
  }, [focus]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [hint, setHint] = useState('');
  const KEYS = ['input', 'cachedInput', 'output'] as const;
  const text = (k: (typeof KEYS)[number]) => draft[k] ?? (price ? String(price[k]) : '');
  /** Saves the three prices once each is filled in with a number; never a part of them. */
  const commit = (): boolean => {
    if (!Object.keys(draft).length) return true;
    const input = priceInput(text('input'));
    const cachedInput = priceInput(text('cachedInput'));
    const output = priceInput(text('output'));
    if (input === null || cachedInput === null || output === null) {
      setHint('Enter all three prices, in US$ per million tokens, to use them.');
      return false;
    }
    const saved = setPrice(model, {
      input,
      cachedInput,
      cacheWrite: price?.cacheWrite ?? null,
      output,
      checked: false,
    });
    if (!saved) {
      setHint('Input and output prices must be more than 0.');
      return false;
    }
    setDraft({});
    setHint('');
    return true;
  };
  if (commitRef) commitRef.current = commit;
  const field = (k: (typeof KEYS)[number], label: string) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        className="input num"
        inputMode="decimal"
        value={text(k)}
        onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
        onBlur={() => commit()}
      />
    </label>
  );
  return (
    <div className="spend-settings">
      <h3 className="section-title">Spending on AI in this tab</h3>
      <div className="field-row">
        <label className="field">
          <span className="field-label">Limit for this tab</span>
          <select
            className="input"
            value={cap === null ? 'none' : String(cap)}
            onChange={(e) => setCap(e.target.value === 'none' ? null : Number(e.target.value))}
          >
            {CAPS.map((c) => (
              <option key={String(c)} value={c === null ? 'none' : String(c)}>
                {c === null ? 'No limit' : usd(c)}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span className="field-label">Spent this tab</span>
          <span className="spend-now">
            <span className="num">{usd(spend.usd)}</span>
            <span className="muted num"> · {tokens(spend.tokens)} tokens</span>{' '}
            <button type="button" className="link-btn" onClick={resetSpend}>
              Reset
            </button>
          </span>
        </div>
      </div>
      <label className="field">
        <span className="field-label">Ask me before a reply that may cost more than</span>
        <select
          className="input"
          value={String(ask)}
          onChange={(e) => {
            const v = e.target.value;
            setThreshold(v === 'always' || v === 'never' ? v : (Number(v) as Threshold));
          }}
        >
          {THRESHOLDS.map((t) => (
            <option key={String(t)} value={String(t)}>
              {t === 'always' ? 'Always ask' : t === 'never' ? 'Never ask' : usd(t)}
            </option>
          ))}
        </select>
      </label>
      <p className="field-hint">
        The designer warns before a run that could pass the limit, and pauses at it. A button that
        shows its price asks again only for the tab’s first design, one that may cost US$0.50 or
        more, or one past the limit. The per-reply figure is used once you can message the designer.
        Renders aren’t counted.
      </p>
      <fieldset ref={ref} className="price-table" id="ai-prices">
        <legend className="field-label">Prices per million tokens for {model} (US$)</legend>
        <div className="field-row field-row-3">
          {field('input', 'Input')}
          {field('cachedInput', 'Cached input')}
          {field('output', 'Output')}
        </div>
        <p className="field-hint">
          {hasOverride(model)
            ? 'Your own prices. '
            : listed
              ? `List prices as of ${PRICES_AS_OF}${listed.checked ? '' : ': check your provider'}. `
              : 'No list price for this model, so the designer won’t use it: enter its prices to use it. '}
          {hasOverride(model) && (
            <button type="button" className="link-btn" onClick={() => setPrice(model, null)}>
              Reset to list prices
            </button>
          )}
        </p>
        {hint && (
          <p className="field-hint error-text" role="alert">
            {hint}
          </p>
        )}
      </fieldset>
    </div>
  );
}
