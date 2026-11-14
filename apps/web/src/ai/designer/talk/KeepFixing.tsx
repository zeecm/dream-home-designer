import { type Proposal, atMostOf } from '@dhd/core';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
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

/**
 * The card whose Keep fixing cost card is open: on a phone the sheet goes to full height and
 * its buttons scroll into view, as a cost card's do (Conversation).
 */
export const useKeepAsk = create(() => ({ card: null as string | null }));

export function KeepFixing({
  cardKey,
  proposal,
  letter,
  rooms,
  disabled,
}: {
  cardKey: string;
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
  const button = useRef<HTMLButtonElement>(null);
  /** Closed with Not now or Escape: focus goes back to the button that opened it. */
  const back = useRef(false);
  const priced = est ? atMostOf(est) : null;
  const most = dearer ?? priced;
  useEffect(() => {
    // Its first sentence gets focus (never a spend button), as a cost card's heading does.
    if (asking) head.current?.focus();
    else if (back.current) {
      back.current = false;
      button.current?.focus();
    }
    useKeepAsk.setState((s) =>
      asking ? { card: cardKey } : s.card === cardKey ? { card: null } : s,
    );
  }, [asking, cardKey]);
  useEffect(
    () => () => {
      if (useKeepAsk.getState().card === cardKey) useKeepAsk.setState({ card: null });
    },
    [cardKey],
  );
  if (!pending && most === null) return null;
  const names =
    rooms.length <= 1
      ? (rooms[0] ?? 'the rooms')
      : `${rooms.slice(0, -1).join(', ')} and ${rooms[rooms.length - 1]}`;
  const n = est?.fixes ?? 0;
  const label = most === null ? 'Keep fixing · …' : `Keep fixing · at most ${usd(most)}`;
  const close = () => {
    back.current = true;
    setAsking(false);
    setDearer(null);
  };
  if (!asking) {
    return (
      <button
        ref={button}
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
      else if (out === 'started') {
        // As a run starting: focus on the card's heading, where its progress shows.
        requestAnimationFrame(() => {
          const h = document.getElementById(`card-${cardKey}`);
          if (!h) return;
          if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
          h.focus({ preventScroll: false });
        });
      }
    } finally {
      setGoing(false);
    }
  };
  return (
    <section
      className="talk-confirm talk-keep-fixing-card"
      data-keep-fixing-card=""
      aria-label="Keep fixing"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !going) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <p ref={head} tabIndex={-1}>
        {dearer !== null ? 'The price has gone up since. ' : ''}
        Keep fixing {names} takes
        {est?.usd ? ` about ${usd(est.usd.typical)} (at most ${usd(most ?? 0)}, ` : ' ('}
        up to {n} more fix-up{n === 1 ? '' : 's'}, only while each one helps). Go ahead?
      </p>
      <div className="button-row" data-keep-fixing-buttons="">
        <button
          type="button"
          className="btn btn-small btn-primary"
          data-spends=""
          disabled={disabled || going || most === null}
          onClick={() => void go()}
        >
          {label}
        </button>
        <button type="button" className="btn btn-small" disabled={going} onClick={close}>
          Not now
        </button>
      </div>
    </section>
  );
}
