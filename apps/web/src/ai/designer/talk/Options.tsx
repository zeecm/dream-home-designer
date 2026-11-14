import type { Proposal } from '@dhd/core';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useResultsTickN } from '../results';
import { useDesigner } from '../state';
import { Mark } from './Mark';
import { ProposalCard } from './ProposalCard';
import { type CardModel, cardChanges, cardResult, cardRunReport } from './cards';
import { timed, useSettledProject } from './settle';
import type { LiveRun } from './useTalk';
import { useTalk } from './useTalk';

/**
 * A proposal in the log (UX §6.4): one card, and over its body a segmented A / B / C when it
 * has alternatives. Switching is free and instant: the plan (if the card is on it), the rows,
 * the checks and the cost all follow; each option keeps its own ticks.
 */
export const ProposalTurn = memo(function ProposalTurn({
  proposal,
  cards,
  newest,
  live,
}: {
  proposal: Proposal;
  cards: CardModel[];
  newest: boolean;
  live: LiveRun | null;
}) {
  const last = cards[cards.length - 1];
  // The option on the plan, if it is this proposal's; else the newest one added.
  const onPlan = useTalk((s) =>
    s.shown?.startsWith(`${proposal.id}:`) ? s.shown.slice(proposal.id.length + 1) : null,
  );
  const [letter, setLetter] = useState(onPlan ?? last?.option?.letter ?? 'A');
  useEffect(() => {
    if (onPlan) setLetter(onPlan);
  }, [onPlan]);
  const count = cards.length;
  const was = useRef(count);
  useEffect(() => {
    if (count > was.current && last?.option) setLetter(last.option.letter);
    was.current = count;
  }, [count, last]);
  const card = cards.find((c) => c.option?.letter === letter) ?? last;
  if (!card) return null;
  const pick = (l: string, focus = false) => {
    setLetter(l);
    // On the plan, the plan switches with it.
    if (useTalk.getState().shown?.startsWith(`${proposal.id}:`)) {
      useTalk.setState({ shown: `${proposal.id}:${l}`, open: null });
      useDesigner.setState({ previewing: true });
    }
    if (focus)
      requestAnimationFrame(() =>
        document.querySelector<HTMLButtonElement>(`#tab-${proposal.id}-${l}`)?.focus(),
      );
  };
  const letters: string[] = cards.map((c) => c.option?.letter ?? 'A');
  const step = (dir: 1 | -1, focus = false) => {
    const i = letters.indexOf(letter);
    const next = letters[(i + dir + letters.length) % letters.length];
    if (next && next !== letter) pick(next, focus);
  };
  const tabs =
    count > 1 ? (
      <Tabs proposal={proposal} cards={cards} letter={letter} onPick={pick} onStep={step} />
    ) : undefined;
  return (
    <ProposalCard
      key={card.key}
      card={card}
      newest={newest}
      live={live && live.letter === card.option?.letter ? live : null}
      tabs={tabs}
      {...(count > 1 ? { onSwipe: (dir: 1 | -1) => step(dir) } : {})}
    />
  );
});

function Tabs({
  proposal,
  cards,
  letter,
  onPick,
  onStep,
}: {
  proposal: Proposal;
  cards: CardModel[];
  letter: string;
  onPick: (l: string, focus?: boolean) => void;
  onStep: (dir: 1 | -1, focus?: boolean) => void;
}) {
  return (
    <div
      className="talk-options"
      role="tablist"
      aria-label={`V${proposal.n}: ideas`}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          onStep(e.key === 'ArrowRight' ? 1 : -1, true);
        } else if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          const l = (e.key === 'Home' ? cards[0] : cards[cards.length - 1])?.option?.letter;
          if (l) onPick(l, true);
        }
      }}
    >
      {cards.map((c) => (
        <Tab
          key={c.key}
          card={c}
          selected={c.option?.letter === letter}
          panel={`panel-${(cards.find((x) => x.option?.letter === letter) ?? c).key}`}
          onPick={onPick}
        />
      ))}
    </div>
  );
}

/** One segment: its letter, the designer's name for it, and whether it passes. */
function Tab({
  card,
  selected,
  panel,
  onPick,
}: {
  card: CardModel;
  selected: boolean;
  panel: string;
  onPick: (l: string) => void;
}) {
  const project = useSettledProject();
  const tick = useResultsTickN();
  const l = card.option?.letter ?? 'A';
  const p = card.proposal;
  // Its own checks (worked out once per plan; pending while the worker has it).
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again as results land
  const verdict = useMemo(() => {
    if (card.status === 'running') return 'running' as const;
    if (card.status === 'failed') return 'failed' as const;
    const r = timed(() => cardResult(project, card));
    if (!r) return null;
    // The card's own one list (its scope), as its Checks row counts it.
    const changes = cardChanges(project, card, r);
    return cardRunReport(card, r, changes).failures.length ? ('fail' as const) : 'pass';
  }, [project, card, tick]);
  const name = card.option?.name ?? `Idea ${l}`;
  const said =
    verdict === 'fail'
      ? ', doesn’t pass'
      : verdict === 'pass'
        ? ', passes all checks'
        : verdict === 'running'
          ? ', being designed'
          : verdict === 'failed'
            ? ', didn’t work'
            : '';
  return (
    <button
      type="button"
      role="tab"
      id={p ? `tab-${p.id}-${l}` : undefined}
      aria-selected={selected}
      aria-controls={panel}
      aria-label={`${l}: ${name}${said}`}
      tabIndex={selected ? 0 : -1}
      className={selected ? 'talk-option on' : 'talk-option'}
      onClick={() => onPick(l)}
    >
      <span className="talk-option-letter">{l}</span>
      <span className="talk-option-name">{name}</span>
      {verdict === 'pass' && (
        <span className="talk-option-mark positive" aria-hidden="true">
          <Mark kind="check" />
        </span>
      )}
      {(verdict === 'fail' || verdict === 'failed') && (
        <span className="talk-option-mark negative" aria-hidden="true">
          <Mark kind="warn" />
        </span>
      )}
      {verdict === 'running' && (
        <span className="talk-option-mark" aria-hidden="true">
          <Mark kind="dot" />
        </span>
      )}
    </button>
  );
}
