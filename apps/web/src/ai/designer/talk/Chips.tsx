import type { Pointer } from '@dhd/core';
import { useRef } from 'react';
import { lightPointer, pointerGone, removePointer, showPointer, usePointerUi } from './pointers';
import { useTalk } from './useTalk';

/**
 * Pointer chips (slice 3a §1.2, §1.3): in the composer, each with its own × (44 px on touch);
 * in a sent message, without. The label is a button that lights its target; a target gone since
 * reads "(gone)" and shows where it was.
 */

const GLYPH: Record<Pointer['kind'], string> = {
  item: 'M2.5 4.5h9v5h-9z',
  opening: 'M3 12V2h8v10',
  point: 'M7 3v4m-3 0h6',
  wall: 'M2 7h10',
  room: 'M2 2h10v10H2z',
  spot: 'M7 12s-4-3.6-4-6.5a4 4 0 0 1 8 0C11 8.4 7 12 7 12z',
};

function Glyph({ kind }: { kind: Pointer['kind'] }) {
  return (
    <svg className="talk-mark talk-chip-glyph" viewBox="0 0 14 14" aria-hidden="true">
      <path d={GLYPH[kind]} />
    </svg>
  );
}

const name = (p: Pointer) => p.label.split(' · ').join(', ');

/** One chip: the label lights or shows its target; × (in the composer) takes it off. */
function Chip({ p, removable, last }: { p: Pointer; removable: boolean; last?: boolean }) {
  // Proposals read so "(gone)" follows a version deleted.
  useTalk((s) => s.proposals);
  const gone = pointerGone(p);
  const ring = usePointerUi((s) => s.ring === p.id);
  const full = `${p.label}${gone ? ' (gone)' : ''}`;
  return (
    <li className={`talk-pchip${gone ? ' gone' : ''}${ring ? ' ring' : ''}`} title={`${full}. ${p.where}`}>
      <button
        type="button"
        className="talk-pchip-label"
        aria-label={gone ? `${name(p)}, gone. Show where it was` : `Show ${name(p)} on the plan`}
        onMouseEnter={() => lightPointer(p)}
        onMouseLeave={() => lightPointer(null)}
        onFocus={() => lightPointer(p)}
        onBlur={() => lightPointer(null)}
        onClick={() => showPointer(p)}
        onKeyDown={(e) => {
          if (!removable) return;
          const li = e.currentTarget.closest('li');
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            const to = e.key === 'ArrowRight' ? li?.nextElementSibling : li?.previousElementSibling;
            to?.querySelector<HTMLButtonElement>('.talk-pchip-label')?.focus();
            e.preventDefault();
          }
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            const next =
              li?.nextElementSibling?.querySelector<HTMLButtonElement>('.talk-pchip-label') ??
              document.querySelector<HTMLTextAreaElement>('#talk-text');
            void removePointer(p.id);
            requestAnimationFrame(() => next?.focus());
          }
        }}
      >
        <Glyph kind={p.kind} />
        <span className="talk-pchip-text">{p.label}</span>
        {gone && <span className="talk-pchip-gone"> (gone)</span>}
      </button>
      {removable && (
        <button
          type="button"
          className="talk-pchip-x"
          data-last-chip={last ? '' : undefined}
          aria-label={`Remove ${p.label.split(' · ')[0]} from your message`}
          onClick={() => {
            lightPointer(null);
            void removePointer(p.id);
            requestAnimationFrame(() =>
              document.querySelector<HTMLTextAreaElement>('#talk-text')?.focus(),
            );
          }}
        >
          ×
        </button>
      )}
    </li>
  );
}

/** The composer's chips ("Pointing at"), or a sent message's. */
export function PointerChips({
  pointers,
  removable,
}: {
  pointers: readonly Pointer[];
  removable: boolean;
}) {
  const list = useRef<HTMLUListElement>(null);
  if (!pointers.length) return null;
  return (
    <ul
      ref={list}
      className={`talk-pchips${removable ? ' talk-pchips-draft' : ''}`}
      aria-label="Pointing at"
    >
      {pointers.map((p, i) => (
        <Chip key={p.id} p={p} removable={removable} last={i === pointers.length - 1} />
      ))}
    </ul>
  );
}
