import { DRAFT_CHARS, meetingOver } from '@dhd/core';
import { useEffect, useRef, useState } from 'react';
import { stopTalkRun } from './propose';
import { act, newId, nowIso, talkLevel, useTalk } from './useTalk';

/**
 * The composer (UX §5.4): quick replies that fill it, the textarea (kept per plan across
 * closes and reloads), and Stop while a design runs. What is typed here goes with the next
 * design asked for, as the household's words; the free-form reply comes in the next slice.
 */

const AFTER = ['Cheaper', 'More storage', 'Next room', 'Why this layout?'];

export function Composer({ onFocus, onBlur }: { onFocus?: () => void; onBlur?: () => void }) {
  const conv = useTalk((s) => s.conv);
  const running = useTalk((s) => !!s.live);
  const [text, setText] = useState(conv?.draft ?? '');
  const area = useRef<HTMLTextAreaElement>(null);
  const saved = conv?.draft ?? '';
  // The stored draft wins when it changes underneath (a proposal took it, another tab).
  const last = useRef(saved);
  useEffect(() => {
    if (saved !== last.current) {
      last.current = saved;
      setText(saved);
    }
  }, [saved]);
  // Emptied when what was typed went with a design.
  const cleared = useTalk((s) => s.cleared);
  useEffect(() => {
    if (!cleared) return;
    last.current = '';
    setText('');
  }, [cleared]);
  // Kept 300 ms after typing stops (and known at once to a priced button).
  useEffect(() => {
    useTalk.setState({ typed: text });
    if (text === last.current) return;
    const t = setTimeout(() => {
      last.current = text;
      void act({ type: 'draft', text });
    }, 300);
    return () => clearTimeout(t);
  }, [text]);
  // Grows from one line to six.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on the text
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [text]);
  if (!conv) return null;
  const level = talkLevel();
  const first = !meetingOver(conv);
  const proposed = conv.turns.some((t) => t.kind === 'proposal');
  const lastAccept = [...conv.turns]
    .reverse()
    .find((t) => t.kind === 'event' && t.event.type === 'accepted' && !t.event.undone);
  const left =
    lastAccept?.kind === 'event' && lastAccept.event.type === 'accepted'
      ? lastAccept.event.left.slice(0, 2)
      : [];
  const fill = (s: string) => {
    const next = text.trim() ? `${text.trim()} ${s}` : s;
    setText(next.slice(0, DRAFT_CHARS));
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next.length, next.length);
    });
  };
  const chips: { label: string; act: () => void }[] = first
    ? [
        {
          label: 'Just design it',
          act: () => {
            if (level)
              void act({
                type: 'justDesign',
                at: nowIso(),
                ids: [newId('turn'), newId('turn')],
                level,
              });
          },
        },
        { label: 'Fill in a form instead', act: () => useTalk.setState({ formOpen: true }) },
      ]
    : proposed
      ? [
          ...AFTER.map((s) => ({ label: s, act: () => fill(`${s}.`) })),
          ...left.map((name) => ({
            label: `I left out ${name} because…`,
            act: () => fill(`I left out ${name} because `),
          })),
        ].slice(0, 6)
      : [];
  return (
    <form
      className="talk-composer"
      aria-label="Message the designer"
      onSubmit={(e) => e.preventDefault()}
    >
      {chips.length > 0 && (
        <div className="chip-row chip-scroll talk-quick">
          {chips.map((c) => (
            <button key={c.label} type="button" className="chip" onClick={c.act}>
              {c.label}
            </button>
          ))}
        </div>
      )}
      <label className="visually-hidden" htmlFor="talk-text">
        Message the designer
      </label>
      <textarea
        id="talk-text"
        ref={area}
        className="input talk-textarea"
        rows={1}
        maxLength={DRAFT_CHARS}
        placeholder="Message the designer"
        aria-describedby="talk-hint"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
      />
      <div className="talk-send-row">
        <span id="talk-hint" className="field-hint">
          {text.length >= 1800
            ? `${text.length.toLocaleString('en-US')} of ${DRAFT_CHARS.toLocaleString('en-US')}`
            : 'Your words go with the next design you ask for.'}
        </span>
        {running && (
          <button
            type="button"
            className="btn btn-primary talk-stop"
            title="Stop (Esc)"
            onClick={stopTalkRun}
          >
            Stop
          </button>
        )}
      </div>
    </form>
  );
}
