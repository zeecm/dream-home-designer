import { PRICES, PRICES_AS_OF, type Price, priceOf } from '@dhd/core';
import { useEffect, useRef, useState } from 'react';
import { CAPS, hasOverride, resetSpend, setCap, setPrice, tokens, usd, useSpend } from './spend';

/**
 * In AI settings: the tab's limit and what it has spent, and the prices used for the model
 * in use (US$ per million tokens), which the person can set to their own.
 */
export function SpendSettings({ model, focus }: { model: string; focus?: boolean }) {
  const { spend, cap, prices } = useSpend();
  const price = priceOf(model, prices);
  const listed = priceOf(model, PRICES);
  const ref = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    if (!focus) return;
    ref.current?.scrollIntoView({ block: 'start' });
    ref.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [focus]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const field = (k: 'input' | 'cachedInput' | 'output', label: string) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        className="input num"
        inputMode="decimal"
        value={draft[k] ?? (price ? String(price[k]) : '')}
        onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
        onBlur={() => {
          const v = Number(draft[k]);
          if (!Number.isFinite(v) || v < 0 || draft[k] === undefined) return;
          const base: Price = price ?? {
            input: 0,
            cachedInput: 0,
            cacheWrite: null,
            output: 0,
            checked: false,
          };
          setPrice(model, { ...base, [k]: v });
          setDraft((d) => {
            const { [k]: _, ...rest } = d;
            return rest;
          });
        }}
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
      <p className="field-hint">
        The designer warns before a run that could pass the limit, and pauses at it. Renders aren’t
        counted.
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
              : 'No list price for this model: enter its prices to see costs. '}
          {hasOverride(model) && (
            <button type="button" className="link-btn" onClick={() => setPrice(model, null)}>
              Reset to list prices
            </button>
          )}
        </p>
      </fieldset>
    </div>
  );
}
