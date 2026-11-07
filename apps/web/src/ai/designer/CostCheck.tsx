import { type DesignBrief, PRICES_AS_OF, type RunEstimate, priceOf } from '@dhd/core';
import { useEffect, useRef, useState } from 'react';
import { Segmented } from '../../ui/fields';
import { type AiSettings, PROVIDERS } from '../credentials';
import { LARGE_INPUT, MAX_STEP_INPUT } from './plan';
import { tokens, usd, useSpend } from './spend';
import { useDesigner } from './state';
import { designerCannotUse } from './stream';

/**
 * The cost check before a run: about how much, at most how much, against what this tab has
 * spent and its limit, and what is sent. The button that spends is never focused for you.
 */

/** The tab's meter: spent so far, this run (typical), and its range to the high figure. */
export function SpendMeter({
  run,
  high,
  thin = false,
}: {
  run: number;
  high: number;
  thin?: boolean;
}) {
  const { spend, cap } = useSpend();
  const scale = Math.max(cap ?? 0, spend.usd + high, 0.01);
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / scale) * 100))}%`;
  return (
    <div className="spend-meter">
      <div className={thin ? 'spend-bar spend-bar-thin' : 'spend-bar'} aria-hidden="true">
        <span className="spend-spent" style={{ width: pct(spend.usd) }} />
        <span className="spend-run" style={{ left: pct(spend.usd), width: pct(run) }} />
        <span
          className="spend-high"
          style={{ left: pct(spend.usd + run), width: pct(Math.max(0, high - run)) }}
        />
        {cap !== null && <span className="spend-cap" style={{ left: pct(cap) }} />}
      </div>
      <div className="spend-labels">
        <span>{usd(spend.usd)} spent this tab</span>
        <span>{cap === null ? 'No limit' : `Limit ${usd(cap)}`}</span>
      </div>
    </div>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface CostCheckProps {
  ai: AiSettings;
  est: RunEstimate;
  quality: DesignBrief['quality'];
  onQuality?: (q: DesignBrief['quality']) => void;
  /** What the requests are, in words: "one for the layout and style, then one for each of 4 rooms". */
  what: string;
  /** The verb on the button: "Design my flat", "Make V3"; and past the limit, "Design anyway". */
  action: string;
  anyway: string;
  onBack: () => void;
  backLabel?: string;
  onStart: () => void;
  onEditPrices: () => void;
}

export function CostCheck(p: CostCheckProps) {
  const { spend, cap, prices } = useSpend();
  const heading = useRef<HTMLHeadingElement>(null);
  // Focus goes to the heading (never to the button that spends).
  useEffect(() => heading.current?.focus(), []);
  const price = priceOf(p.ai.model, prices);
  const typical = p.est.usd?.typical ?? null;
  const high = p.est.usd?.high ?? null;
  const over = cap !== null && high !== null && spend.usd + high > cap;
  const tooBig = p.est.steps.some((s) => s.input > MAX_STEP_INPUT);
  const unsupported = designerCannotUse(p.ai);
  // Pressed once: it waits while the run starts (a double click starts one run).
  const [pressed, setPressed] = useState(false);
  const busy = useDesigner((s) => s.starting || !!s.run) || pressed;
  const provider = PROVIDERS[p.ai.provider];
  const label =
    typical === null ? p.action : `${over ? p.anyway : p.action} · about ${usd(typical)}`;
  return (
    <>
      <div className="dialog-body cost-check">
        <h3 ref={heading} tabIndex={-1} className="cost-head">
          This uses a lot of AI tokens
        </h3>
        {typical !== null && high !== null ? (
          <>
            <p className="cost-figure num">About {usd(typical)}</p>
            <p className="cost-sub num">
              {tokens(p.est.tokens.typical)} tokens · at most {usd(high)}
            </p>
            {(p.est.usd?.fix ?? 0) > 0 && (
              <p className="cost-sub num">
                If the app sends a room back to fix what fails its checks, up to{' '}
                {usd(p.est.usd?.fix ?? 0)} more.
              </p>
            )}
            <SpendMeter run={typical} high={high} />
          </>
        ) : (
          <>
            <p className="cost-figure num">About {tokens(p.est.tokens.typical)} tokens</p>
            <p className="cost-sub">
              We don’t have prices for “{p.ai.model}”. Enter them in AI settings to see the cost.
              Your limit can’t be checked without prices.
            </p>
          </>
        )}
        {over && (
          <p className="notice-warning">
            This would take you past your {usd(cap ?? 0)} limit for this tab.
          </p>
        )}
        <p>
          {plural(p.est.requests, 'request')} to {provider.short} ({p.ai.model}), billed to your
          key: {p.what}. Your provider bills your account for them, not us.
        </p>
        {p.onQuality && (
          <div className="field">
            <span className="field-label">Quality</span>
            <Segmented
              label="Quality"
              fill
              value={p.quality}
              onChange={p.onQuality}
              options={[
                { value: 'thorough', label: 'Thorough' },
                { value: 'quick', label: 'Quicker and cheaper' },
              ]}
            />
          </div>
        )}
        {p.est.input > LARGE_INPUT && (
          <p className="field-hint">This plan is large, so each step sends more.</p>
        )}
        {unsupported && (
          <p className="notice-warning">
            {unsupported}{' '}
            <button type="button" className="link-btn" onClick={p.onEditPrices}>
              AI settings
            </button>
          </p>
        )}
        {tooBig && (
          <p className="notice-warning">
            This plan is too large to design in one go. Design a few rooms at a time (Change
            something ▸ a room).
          </p>
        )}
        <details className="cost-details">
          <summary>What’s sent</summary>
          <p>
            Sent from this browser to {provider.short}: your plan’s walls, rooms and furniture, and
            this brief. Not your plan image or the plan’s name.
          </p>
        </details>
        <p className="field-hint">
          {price
            ? `Prices are ${price.checked ? 'list prices' : 'list prices (check your provider)'} for this model as of ${monthName(PRICES_AS_OF)}, not your bill. Your provider’s dashboard shows what you’re charged. `
            : ''}
          <button type="button" className="link-btn" onClick={p.onEditPrices}>
            Edit prices
          </button>
        </p>
      </div>
      <footer className="dialog-foot">
        <div className="button-row">
          <button type="button" className="btn" onClick={p.onBack}>
            {p.backLabel ?? 'Back'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={tooBig || !!unsupported || busy}
            onClick={() => {
              if (busy) return;
              setPressed(true);
              p.onStart();
            }}
            data-spends=""
          >
            {label}
          </button>
        </div>
      </footer>
    </>
  );
}

function monthName(asOf: string): string {
  const [y, m] = asOf.split('-').map(Number);
  if (!y || !m) return asOf;
  return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'short', year: 'numeric' });
}
