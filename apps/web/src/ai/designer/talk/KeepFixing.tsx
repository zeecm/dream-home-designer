import { type Proposal, atMostOf } from '@dhd/core';
import { useEffect, useRef, useState } from 'react';
import { useResultsTickN } from '../results';
import { usd } from '../spend';
import { keepFixing, keepFixingPrice } from './propose';

/**
 * Keep fixing (spec docs/specs/designer-listens.md §3, B2): offered in the lead of a card whose
 * run used up its fix-ups with failures left (never after a round that made no progress). Its
 * button names the most it may cost; pressing it opens its own cost card, which always asks: a
 * fix-only run on the same option, its stored answers kept, only fix rounds sent while each makes
 * progress, bound to the figure the card shows.
 */
export function KeepFixing({
  proposal,
  letter,
  rooms,
  disabled,
}: {
  proposal: Proposal;
  letter: string;
  /** The rooms it sends back, by name. */
  rooms: readonly string[];
  disabled: boolean;
}) {
  useResultsTickN();
  const { est, pending } = keepFixingPrice(proposal, letter);
  const [asking, setAsking] = useState(false);
  /** Priced higher since the card was shown: the new figure, asked again. */
  const [dearer, setDearer] = useState<number | null>(null);
  const [going, setGoing] = useState(false);
  const head = useRef<HTMLParagraphElement>(null);
  const priced = est ? atMostOf(est) : null;
  const most = dearer ?? priced;
  useEffect(() => {
    // Its first sentence gets focus (never a spend button), as a cost card's heading does.
    if (asking) head.current?.focus();
  }, [asking]);
  if (!pending && most === null) return null;
  const names =
    rooms.length <= 1
      ? (rooms[0] ?? 'the rooms')
      : `${rooms.slice(0, -1).join(', ')} and ${rooms[rooms.length - 1]}`;
  const n = est?.fixes ?? 0;
  const label = most === null ? 'Keep fixing · …' : `Keep fixing · at most ${usd(most)}`;
  if (!asking) {
    return (
      <button
        type="button"
        className="btn btn-small talk-keep-fixing"
        data-keep-fixing=""
        data-spends=""
        disabled={disabled || most === null}
        onClick={() => setAsking(true)}
      >
        {label}
      </button>
    );
  }
  const go = async () => {
    if (most === null) return;
    setGoing(true);
    try {
      const out = await keepFixing(proposal, letter, most);
      if (typeof out === 'object') setDearer(out.dearer);
      else if (out === 'started') setAsking(false);
    } finally {
      setGoing(false);
    }
  };
  return (
    <section
      className="talk-confirm talk-keep-fixing-card"
      data-keep-fixing-card=""
      aria-label="Keep fixing"
    >
      <p ref={head} tabIndex={-1}>
        {dearer !== null ? 'The price has gone up since. ' : ''}
        Keep fixing {names}: up to {n} more fix-up{n === 1 ? '' : 's'}, each sent only while the
        last made progress.
        {est?.usd ? ` About ${usd(est.usd.typical)}, at most ${usd(most ?? 0)}.` : ''}
      </p>
      <div className="button-row">
        <button
          type="button"
          className="btn btn-small btn-primary"
          data-spends=""
          disabled={disabled || going || most === null}
          onClick={() => void go()}
        >
          {label}
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={going}
          onClick={() => {
            setAsking(false);
            setDearer(null);
          }}
        >
          Not now
        </button>
      </div>
    </section>
  );
}
