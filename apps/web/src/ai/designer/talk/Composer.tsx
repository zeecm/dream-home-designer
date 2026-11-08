import {
  DRAFT_CHARS,
  type ScopeRef,
  type TalkEstimate,
  meetingOver,
  pendingReply,
  talkAsks,
} from '@dhd/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAi } from '../../credentials';
import { capUsd, spent, tokens, usd, useSpend } from '../spend';
import { useDesigner } from '../state';
import { designerCannotUse } from '../stream';
import { pressScope, scopePrice, stopTalkRun } from './propose';
import { scrollInLog } from './scroll';
import { timed, useSettledProject } from './settle';
import { useThreshold } from './threshold';
import { sendMessage, sendPrice, stopReply } from './turn';
import { act, newId, nowIso, talkLevel, typedNow, useBusy, useTalk } from './useTalk';

/**
 * The composer (UX §5.4): quick replies, the textarea (kept per plan across closes and
 * reloads), and Send, priced ("Send · about US$0.03"), which becomes Stop while a reply or a
 * design runs. Enter sends on a computer (Shift+Enter is a new line); on touch Return is a new
 * line and the button sends; Ctrl or Cmd+Enter sends everywhere. The words also go with a
 * scope button pressed instead. The hint says the guarantee: "Asks before anything over
 * US$0.25", or why Send can't go.
 */

const coarse = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;

/** The newest proposal's card and scope. */
function useNewest(): { key: string; scope: ScopeRef } | null {
  const id = useTalk((s) => {
    const turns = s.conv?.turns ?? [];
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t?.kind === 'proposal') return t.proposalId;
    }
    return null;
  });
  const p = useTalk((s) => s.proposals.find((x) => x.id === id));
  return useMemo(() => (p ? { key: `${p.id}:A`, scope: p.scope } : null), [p]);
}

export function Composer({ onFocus, onBlur }: { onFocus?: () => void; onBlur?: () => void }) {
  const conv = useTalk((s) => s.conv);
  const running = useTalk((s) => !!s.live);
  const replying = useTalk((s) => !!s.reply);
  const ai = useAi();
  const level = useThreshold();
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  );
  const [flash, setFlash] = useState(false);
  const [est, setEst] = useState<TalkEstimate | null>(null);
  const [text, setText] = useState(conv?.draft ?? '');
  const newest = useNewest();
  const project = useSettledProject();
  const { prices } = useSpend();
  const busy = useBusy();
  // biome-ignore lint/correctness/useExhaustiveDependencies: on what the price reads
  const price = useMemo(
    () => (newest ? timed(() => scopePrice(newest.scope)) : null),
    [newest, project, prices],
  );
  const area = useRef<HTMLTextAreaElement>(null);
  const saved = conv?.draft ?? '';
  // The stored draft wins when it changes underneath (another tab), unless this composer is
  // being written in: what is typed here is never replaced.
  const last = useRef(saved);
  useEffect(() => {
    if (saved === last.current) return;
    last.current = saved;
    if (document.activeElement !== area.current) setText(saved);
  }, [saved]);
  // Emptied when what was typed went with a design or a message.
  const cleared = useTalk((s) => s.cleared);
  useEffect(() => {
    if (!cleared) return;
    last.current = '';
    setText('');
  }, [cleared]);
  // Filled from elsewhere: a designer's question's chip, Edit on a message not answered.
  const filled = useTalk((s) => s.fill);
  useEffect(() => {
    if (!filled) return;
    setText((t) => (filled.replace || !t.trim() ? filled.text : `${t.trim()} ${filled.text}`));
    requestAnimationFrame(() => {
      const el = area.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
  }, [filled]);
  useEffect(() => {
    const on = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, []);
  // Send's figure, 300 ms after typing stops (it builds the request, which is cheap).
  // biome-ignore lint/correctness/useExhaustiveDependencies: on what the price reads
  useEffect(() => {
    const t = setTimeout(() => setEst(timed(() => sendPrice(text))), 300);
    return () => clearTimeout(t);
  }, [text, conv?.rev, project, prices, ai]);
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
  const lvl = talkLevel();
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
  const chips: { label: string; act: () => void; spends?: boolean }[] = first
    ? [
        {
          label: 'Just design it',
          act: () => {
            if (lvl)
              void act({
                type: 'justDesign',
                at: nowIso(),
                ids: [newId('turn'), newId('turn')],
                level: lvl,
              });
          },
        },
        { label: 'Fill in a form instead', act: () => useTalk.setState({ formOpen: true }) },
      ]
    : proposed && newest
      ? [
          ...(price
            ? ['Cheaper', 'More storage'].map((s) => ({
                label: `${s}${price.usd ? ` · about ${usd(price.usd.typical)}` : ''}`,
                spends: true,
                act: () => void pressScope(newest.scope, `${typedNow()} ${s}.`.trim()),
              }))
            : []),
          {
            label: 'Why this layout?',
            act: () => {
              useTalk.setState({ why: newest.key });
              requestAnimationFrame(() =>
                scrollInLog(
                  document.querySelector(`[data-card="${CSS.escape(newest.key)}"]`),
                  'start',
                ),
              );
            },
          },
          ...left.map((name) => ({
            label: `I left out ${name} because…`,
            act: () => fill(`I left out ${name} because `),
          })),
        ].slice(0, 6)
      : [];
  const elsewhere = !!pendingReply(conv) && !replying;
  const cant = ai ? designerCannotUse(ai) : null;
  const cap = capUsd();
  const passes = !!est && talkAsks(est, spent().usd, cap);
  const why = !ai
    ? 'Add your AI key to send messages.'
    : cant
      ? cant
      : !online
        ? 'You’re offline. Your message is kept.'
        : elsewhere
          ? 'Another tab is waiting for a reply.'
          : passes && cap !== null
            ? `This would pass your ${usd(cap)} limit for this tab.`
            : null;
  const send = () => {
    if (why || replying || running) return;
    if (!text.trim()) {
      setFlash(true);
      setTimeout(() => setFlash(false), 1600);
      return;
    }
    void sendMessage(text);
  };
  const hint =
    text.length >= 1800
      ? `${text.length.toLocaleString('en-US')} of ${DRAFT_CHARS.toLocaleString('en-US')}`
      : flash
        ? 'Write a message first'
        : replying || running
          ? 'Wait for the reply, or Stop'
          : (why ?? (typeof level === 'number' ? `Asks before anything over ${usd(level)}` : ''));
  const sendLabel = est?.usd
    ? `Send · about ${usd(est.usd.typical)}`
    : est
      ? `Send · about ${tokens(est.tokens.typical)} tokens`
      : 'Send';
  return (
    <form
      className="talk-composer"
      aria-label="Message the designer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {chips.length > 0 && (
        <div className="chip-row chip-scroll talk-quick">
          {chips.map((c) => (
            <button
              key={c.label}
              type="button"
              className="chip"
              disabled={c.spends && busy}
              {...(c.spends ? { 'data-spends': '' } : {})}
              onClick={c.act}
            >
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
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
          // Ctrl or Cmd+Enter sends everywhere; Enter alone on a computer (Shift: a new line).
          if (e.metaKey || e.ctrlKey || (!e.shiftKey && !coarse())) {
            e.preventDefault();
            send();
          }
        }}
        onFocus={onFocus}
        onBlur={onBlur}
      />
      <div className="talk-send-row">
        <span
          id="talk-hint"
          className={why ? 'field-hint talk-why' : 'field-hint'}
          aria-live="polite"
        >
          {hint}
          {!ai && (
            <>
              {' '}
              <button
                type="button"
                className="link-btn"
                onClick={() => useTalk.setState({ settings: 'key' })}
              >
                AI settings
              </button>
            </>
          )}
        </span>
        {replying || running ? (
          <button
            type="button"
            key="stop"
            className="btn btn-primary talk-stop"
            title="Stop (Esc)"
            onClick={() => (replying ? stopReply() : stopTalkRun())}
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            key="send"
            className="btn btn-primary talk-send"
            data-spends=""
            aria-describedby="talk-hint"
            disabled={!!why}
          >
            {sendLabel}
          </button>
        )}
      </div>
    </form>
  );
}
