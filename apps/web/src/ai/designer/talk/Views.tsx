import {
  type Design,
  FACT_LABELS,
  QUESTION_KEYS,
  type QuestionKey,
  factText,
  optionTitle,
  peopleOf,
} from '@dhd/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../../store';
import { failingChecks } from '../parts';
import { readResult, useResultsTickN } from '../results';
import { designOpts, useDesigner } from '../state';
import { FactEditor } from './Facts';
import { Mark } from './Mark';
import { MakeRule } from './Rules';
import { cardVerdict, nowOf, versionKey } from './cards';
import { bringBackDesign, copyConversation, downloadConversation, startOver } from './iterate';
import { timed, useSettledProject } from './settle';
import { versionTitle } from './titles';
import { act, newId, nowIso, talkLevel, useBusy, useTalk } from './useTalk';

/**
 * The menu's views, inside the column with "‹ Conversation" back (UX §11): What I know about
 * you (the brief as plain facts, each changed with its question's own widget, assumptions
 * marked) and Decisions.
 */

export function Back({ title }: { title: string }) {
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => head.current?.focus({ preventScroll: true }), []);
  return (
    <div className="talk-view-head">
      <button
        type="button"
        className="link-btn talk-back"
        onClick={() => {
          useTalk.setState({ view: 'log', knowAt: null });
          requestAnimationFrame(() =>
            document.querySelector<HTMLButtonElement>('.talk-menu-btn')?.focus(),
          );
        }}
      >
        ‹ Conversation
      </button>
      <h3 ref={head} tabIndex={-1} className="talk-view-title">
        {title}
      </h3>
    </div>
  );
}

export function WhatIKnow() {
  const conv = useTalk((s) => s.conv);
  const at = useTalk((s) => s.knowAt);
  const [editing, setEditing] = useState<QuestionKey | null>(at);
  const level = talkLevel();
  if (!conv || !level) return null;
  const b = conv.brief;
  const keys = QUESTION_KEYS.filter(
    (k) =>
      (k !== 'mobility' || b.household.elders.length > 0) &&
      // Who sleeps where, whenever someone sleeps here: with no bedroom, it asks which rooms
      // they sleep in (N1).
      (k !== 'sleeping' || peopleOf(b).some((p) => p.kind !== 'helper')),
  );
  const save = (k: QuestionKey, brief: typeof b) => {
    void act({ type: 'editFact', key: k, brief, at: nowIso(), id: newId('turn'), level });
    setEditing(null);
  };
  return (
    <section className="talk-view" aria-label="What I know about you">
      <Back title="What I know about you" />
      <dl className="talk-facts">
        {keys.map((k) => {
          // How much they own is never asked in the first meeting: Typical until it is said.
          const assumed = conv.assumed.includes(k) || (k === 'owns' && b.owns === undefined);
          return (
            <div key={k} className="talk-fact" data-fact={k}>
              <dt>{FACT_LABELS[k]}</dt>
              <dd>
                {editing === k ? (
                  <FactEditor
                    k={k}
                    brief={b}
                    level={level}
                    doneLabel="Save"
                    autoFocus
                    onDone={(update) => save(k, update(useTalk.getState().conv?.brief ?? b))}
                  />
                ) : (
                  <>
                    <span>{factText(k, b, level)}</span>
                    {assumed && (
                      <span className="talk-assumed">
                        <span className="muted">Assumed.</span> Is this right?{' '}
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() =>
                            k === 'owns'
                              ? save(k, { ...b, owns: b.owns ?? 'typical' })
                              : void act({ type: 'confirmFact', key: k })
                          }
                        >
                          Yes
                        </button>
                      </span>
                    )}
                    <button type="button" className="link-btn" onClick={() => setEditing(k)}>
                      Change
                    </button>
                  </>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      <p>
        <button
          type="button"
          className="link-btn"
          onClick={() => useTalk.setState({ formOpen: true })}
        >
          Fill in the form instead
        </button>
      </p>
    </section>
  );
}

export function Decisions() {
  const conv = useTalk((s) => s.conv);
  const [text, setText] = useState('');
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  useEffect(() => {
    if (!gone) return;
    const t = setTimeout(() => setGone(null), 5000);
    return () => clearTimeout(t);
  }, [gone]);
  if (!conv) return null;
  const list = conv.decisions
    .filter((d) => !d.deleted)
    .slice()
    .reverse();
  return (
    <section className="talk-view" aria-label="Decisions">
      <Back title="Decisions" />
      <p className="muted">
        Rules are checked on every proposal. Decisions are told to the designer, not checked.
      </p>
      <form
        className="talk-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          void act({
            type: 'decisionAdd',
            id: newId('dec'),
            at: nowIso(),
            kind: 'wish',
            text,
            from: null,
          });
          setText('');
        }}
      >
        <label className="field">
          <span className="field-label">Something to keep, avoid or have</span>
          <input
            className="input"
            maxLength={160}
            value={text}
            placeholder="Keep the shoe cabinet by the door"
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn-small" disabled={!text.trim()}>
          Add
        </button>
      </form>
      {gone && (
        <output className="talk-app-line">
          <span className="talk-app-icon">
            <Mark kind="check" />
          </span>
          <span className="talk-app-text">
            Deleted.{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                void act({ type: 'decisionRestore', id: gone });
                setGone(null);
              }}
            >
              Undo
            </button>
          </span>
        </output>
      )}
      {list.length === 0 ? (
        <p className="muted">
          Nothing decided yet. What you leave out of a proposal, accept anyway or add here is kept,
          and the designer goes by it.
        </p>
      ) : (
        <ul className="talk-decisions">
          {list.map((d) => (
            <li key={d.id}>
              {edit?.id === d.id ? (
                <form
                  className="talk-add"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act({ type: 'decisionEdit', id: d.id, text: edit.text });
                    setEdit(null);
                  }}
                >
                  <input
                    className="input"
                    maxLength={160}
                    aria-label="Decision"
                    value={edit.text}
                    // biome-ignore lint/a11y/noAutofocus: opened to edit it
                    autoFocus
                    onChange={(e) => setEdit({ id: d.id, text: e.target.value })}
                  />
                  <button type="submit" className="btn btn-small">
                    Save
                  </button>
                </form>
              ) : (
                <>
                  <span>
                    {d.text}
                    <span className="muted">
                      {' '}
                      ({d.from ? `${d.from}, ` : ''}
                      {new Date(d.at).toLocaleDateString('en-SG', {
                        day: 'numeric',
                        month: 'short',
                      })}
                      )
                    </span>
                  </span>
                  <span className="talk-decision-actions">
                    <MakeRule d={d} />
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => setEdit({ id: d.id, text: d.text })}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => {
                        void act({ type: 'decisionDelete', id: d.id });
                        setGone(d.id);
                      }}
                    >
                      Delete
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Versions (UX §11): every version of the plan, newest first (V1, V4, V7: the gaps are ideas
 * not taken; alternatives as V4A, V4B), each with its verdict on the plan as it is now and
 * Show and Bring this back, both free.
 */
export function Versions() {
  const conv = useTalk((s) => s.conv);
  const proposals = useTalk((s) => s.proposals);
  const designs = useDesigner((s) => s.designs);
  const busy = useBusy();
  const list = [...designs].sort((a, b) => b.n - a.n || b.createdAt.localeCompare(a.createdAt));
  // On a plan of several levels, the level each version designs (as the card heads say).
  const levels = useStore((s) => s.editor.doc.levels);
  const levelOf = (d: Design) =>
    levels.length > 1 ? (levels.find((l) => l.id === d.levelId)?.name ?? '') : '';
  if (!conv) return null;
  return (
    <section className="talk-view" aria-label="Versions">
      <Back title="Versions" />
      {list.length === 0 ? (
        <p className="muted">
          No versions yet. A proposal becomes a version when you accept some of it.
        </p>
      ) : (
        <ul className="talk-versions">
          {list.map((d) => {
            const title = versionTitle(d);
            const levelName = levelOf(d);
            return (
              <li key={d.id} className="talk-version" data-version={title}>
                <span className="talk-version-text">
                  <span className="talk-version-title">
                    {title} · {d.concept?.name ?? d.name}
                    {levelName ? ` · ${levelName}` : ''}
                  </span>
                  <VersionVerdict d={d} />
                </span>
                <span className="talk-decision-actions">
                  <button
                    type="button"
                    className="link-btn"
                    aria-label={`Show ${title} on the plan`}
                    onClick={() => {
                      useTalk.setState({ view: 'log', shown: versionKey(d, conv.id) });
                      useDesigner.setState({ previewing: true });
                    }}
                  >
                    Show
                  </button>
                  <button
                    type="button"
                    className="link-btn"
                    disabled={busy}
                    aria-label={`Bring ${title} back`}
                    onClick={() => void bringBackDesign(d)}
                  >
                    Bring this back
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="field-hint">
        Only what you accept becomes a version; a plan keeps 20. Ideas you didn’t take stay in the
        conversation.
      </p>
    </section>
  );
}

/** A version's verdict on the plan as it is now (pending while the worker checks it). */
function VersionVerdict({ d }: { d: Design }) {
  const project = useSettledProject();
  const tick = useResultsTickN();
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again as results land
  const v = useMemo(() => {
    const b = nowOf(project, d.levelId);
    if (!b) return null;
    const r = timed(() =>
      readResult(b.now, b.before, d, designOpts(project, d.levelId, d.createdAt)),
    );
    if (!r) return { text: 'Checking…', tone: 'pending' };
    const f = failingChecks(r, d);
    return cardVerdict(
      f.open,
      [],
      f.waived.map((c) => c.key),
    );
  }, [project, d, tick]);
  if (!v) return null;
  return (
    <span className="talk-version-verdict">
      {d.accepted ? 'Accepted · ' : ''}
      <span className={v.tone === 'fail' ? 'negative' : 'muted'}>{v.text}</span>
    </span>
  );
}

/**
 * Start over (UX §8.6): a real dialog, as it removes things. Neither main button is focused for
 * you; Copy this conversation first is offered.
 */
export function StartOverDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [keep, setKeep] = useState(true);
  const [going, setGoing] = useState(false);
  const busy = useBusy();
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    // Focus on the dialog itself: neither Cancel nor Start over is chosen for you.
    el?.focus();
  }, []);
  const close = () => ref.current?.close();
  return (
    <dialog
      ref={ref}
      className="dialog dialog-confirm talk-restart"
      aria-labelledby="restart-h"
      aria-describedby="restart-d"
      tabIndex={-1}
      onClose={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="dialog-head">
        <h2 id="restart-h">Start a new conversation?</h2>
      </div>
      <div className="confirm-body">
        <p id="restart-d">
          Your versions stay, under Earlier designs. The designer forgets this conversation’s
          messages and decisions, and the ideas you didn’t accept go with them.
        </p>
        <p id="restart-r" className="field-hint">
          Keeping what I know about you keeps your rules too; untick it and they go.
        </p>
        <label className="check-row">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          Keep what I know about you
        </label>
        {busy && <p className="field-hint">Stop the designer first: it is still working.</p>}
      </div>
      <footer className="dialog-foot">
        <span className="talk-restart-keep">
          Keep a copy first:{' '}
          <button type="button" className="link-btn" onClick={() => void copyConversation()}>
            Copy as text
          </button>{' '}
          ·{' '}
          <button type="button" className="link-btn" onClick={() => void downloadConversation()}>
            Download conversation
          </button>
        </span>
        <span className="button-row">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={going || busy}
            onClick={() => {
              setGoing(true);
              void startOver(keep).then((ok) => {
                setGoing(false);
                if (ok) close();
              });
            }}
          >
            Start over
          </button>
        </span>
      </footer>
    </dialog>
  );
}
