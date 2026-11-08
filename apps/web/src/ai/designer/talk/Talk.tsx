import { type TurnOf, cut } from '@dhd/core';
import { useMemo } from 'react';
import { useAi } from '../../credentials';
import { tokens, usd, useSpend } from '../spend';
import { useDesigner } from '../state';
import { Mark } from './Mark';
import { TurnCost } from './ProposalCard';
import { planRequest, pressPlan, pressPrice } from './propose';
import { timed, useSettledProject } from './settle';
import { answerChip, chipLabel, editTurn, retryPrice, retryTurn } from './turn';
import { act, newId, nowIso, useBusy, useTalk } from './useTalk';

/**
 * The talk turns in the log (UX §6.1, §6.2, §6.5, §9, §10): a message's state under its bubble
 * (Not answered · Try again · Edit), the reply streaming in, and a reply's own parts: the
 * designer's questions with their chips, a pushback with the app's measured lines and its one
 * priced alternative, and what the reply noted (Decisions, What I know, notes for the ID),
 * each with Edit. The designer's words are plain text: never Markdown, never a link.
 */

/** Under a message: why it wasn't answered, and the ways on. */
export function SentState({ t }: { t: TurnOf<'person'> }) {
  const replying = useTalk((s) => !!s.reply);
  const ai = useAi();
  const { prices } = useSpend();
  const state = t.reply?.state;
  const off = state === 'failed' || state === 'cut';
  // biome-ignore lint/correctness/useExhaustiveDependencies: on what the price reads
  const est = useMemo(
    () => (off && ai ? timed(() => retryPrice(t.id)) : null),
    [off, ai, prices, t.id],
  );
  if (!off) return null;
  // A reply stopped by the person was answered as far as it went: only Try again.
  const stopped = state === 'cut' && !t.reply?.error;
  return (
    <div className="talk-sent-state">
      {t.reply?.error && <p className="field-hint talk-error">{t.reply.error}</p>}
      <p className="field-hint">
        {stopped ? 'Cut off' : 'Not answered'} ·{' '}
        <button
          type="button"
          className="link-btn"
          data-spends=""
          disabled={replying || !ai}
          onClick={() => void retryTurn(t.id)}
        >
          Try again
          {est?.usd
            ? ` · about ${usd(est.usd.typical)}`
            : est
              ? ` · about ${tokens(est.tokens.typical)} tokens`
              : ''}
        </button>
        {!stopped && (
          <>
            {' · '}
            <button type="button" className="link-btn" onClick={() => void editTurn(t.id)}>
              Edit
            </button>
          </>
        )}
      </p>
    </div>
  );
}

/** The reply on its way: Thinking…, its thinking line or a wait, then its words as they come. */
export function Streaming({ named }: { named: boolean }) {
  const r = useTalk((s) => s.reply);
  if (!r) return null;
  const status = r.wait
    ? r.wait.net
      ? `Connection dropped; trying again in ${r.wait.seconds} s (${r.wait.attempt} of 2)`
      : r.wait.server
        ? `The provider had a problem; trying again in ${r.wait.seconds} s (1 of 1)`
        : `The provider is busy; trying again in ${r.wait.seconds} s (${r.wait.attempt} of 2)`
    : r.say
      ? null
      : r.thinking
        ? r.thinking
        : 'Thinking…';
  return (
    <article className="talk-turn talk-designer talk-streaming" aria-live="off" aria-busy="true">
      <h3 className={named ? 'talk-name' : 'visually-hidden'}>
        Designer
        <span className="visually-hidden"> is replying</span>
      </h3>
      {r.say && <p className="talk-text">{r.say}</p>}
      {status && (
        <p className="field-hint talk-status" aria-hidden={!r.wait}>
          {status}
        </p>
      )}
    </article>
  );
}

/** A reply's own parts, under its text. */
export function ReplyParts({ t }: { t: TurnOf<'designer'> }) {
  const k = t.talk;
  if (!k) return null;
  return (
    <>
      {k.cut && (
        <p className="field-hint talk-cut">
          {k.cut === 'stopped' ? 'Stopped' : 'Cut off'} · the text so far is kept
        </p>
      )}
      {k.questions.length > 0 && <Asked t={t} />}
      {k.confirms.some((c) => c.answer === null) && (
        <div className="talk-question">
          {k.confirms.map((c, i) =>
            c.answer === null ? (
              <section key={c.ask} className="talk-q" aria-label={c.ask}>
                <h4 className="talk-q-label">{c.ask}</h4>
                <p className="field-hint">Only you can widen what the designer may do.</p>
                <div className="button-row">
                  {(['Yes', 'No'] as const).map((w) => (
                    <button
                      key={w}
                      type="button"
                      className="chip"
                      onClick={() =>
                        void act({
                          type: 'talkConfirm',
                          turnId: t.id,
                          index: i,
                          yes: w === 'Yes',
                          id: newId('turn'),
                          at: nowIso(),
                        })
                      }
                    >
                      {w}
                    </button>
                  ))}
                </div>
              </section>
            ) : null,
          )}
        </div>
      )}
      {k.concern && <Concern t={t} />}
      {k.noted.length > 0 && (
        <ul className="talk-noted">
          {k.noted.map((n) => (
            <li key={`${n.kind}:${n.text}`} className="talk-app-line">
              <span className="talk-app-icon">
                <Mark kind="check" />
              </span>
              <span className="talk-app-text">
                <span>{n.text}</span>
                {n.kind !== 'note' && (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() =>
                      useTalk.setState(
                        n.kind === 'decision'
                          ? { view: 'decisions' }
                          : { view: 'know', knowAt: null },
                      )
                    }
                  >
                    Edit
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {k.usage.length > 0 && (
        <p className="talk-meta">
          <TurnCost usage={k.usage} />
        </p>
      )}
    </>
  );
}

/** The designer's questions: chips (free for a What I know fact, else into the composer). */
function Asked({ t }: { t: TurnOf<'designer'> }) {
  const k = t.talk;
  if (!k) return null;
  return (
    <div className="talk-question">
      {k.questions.map((q, i) => {
        const done = k.answered[i];
        return (
          <section key={q.text} className="talk-q" aria-label={q.text}>
            <h4 className="talk-q-label">{q.text}</h4>
            {done !== undefined ? (
              <p className="talk-bubble">{done}</p>
            ) : q.choices.length ? (
              // biome-ignore lint/a11y/useSemanticElements: a row of chips named by its question
              <div className="chip-row" role="group" aria-label={q.text}>
                {q.choices.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="chip"
                    onClick={() => void answerChip(t, i, c)}
                  >
                    {chipLabel(q, c)}
                  </button>
                ))}
              </div>
            ) : (
              <p className="field-hint">Answer below.</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** A pushback: the app's own lines, and the one alternative as a priced button. */
function Concern({ t }: { t: TurnOf<'designer'> }) {
  const c = t.talk?.concern;
  const conv = useTalk((s) => s.conv);
  const busy = useBusy();
  const project = useSettledProject();
  const { prices } = useSpend();
  const said = useMemo(() => {
    const p = conv?.turns.find((x) => x.id === t.talk?.replyTo);
    return p?.kind === 'person' ? p.text : '';
  }, [conv, t.talk?.replyTo]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on what the price reads
  const est = useMemo(
    () =>
      c?.alt
        ? timed(() => pressPrice(planRequest(c.alt as NonNullable<typeof c.alt>, said)))
        : null,
    [c?.alt, said, project, prices],
  );
  if (!c) return null;
  return (
    <>
      {c.lines.map((l) => (
        <p key={l} className="talk-app-line talk-concern">
          <span className="talk-app-icon">
            <Mark kind="warn" />
          </span>
          <span className="talk-app-text">
            <span>{l}</span>
          </span>
        </p>
      ))}
      {c.alt && !c.hdb && est && (
        <button
          type="button"
          className="btn talk-alt"
          data-spends=""
          disabled={busy}
          onClick={() => c.alt && void pressPlan(c.alt, said)}
        >
          {cut(`Show me ${c.alt.title.charAt(0).toLowerCase()}${c.alt.title.slice(1)}`, 80)}
          {est.usd ? ` · about ${usd(est.usd.typical)}` : ''}
        </button>
      )}
    </>
  );
}
