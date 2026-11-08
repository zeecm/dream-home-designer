import { FACT_LABELS, QUESTION_KEYS, type QuestionKey, factText, peopleOf } from '@dhd/core';
import { useEffect, useRef, useState } from 'react';
import { FactEditor } from './Facts';
import { Mark } from './Mark';
import { act, newId, nowIso, talkLevel, useTalk } from './useTalk';

/**
 * The menu's views, inside the column with "‹ Conversation" back (UX §11): What I know about
 * you (the brief as plain facts, each changed with its question's own widget, assumptions
 * marked) and Decisions.
 */

function Back({ title }: { title: string }) {
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
          const assumed = conv.assumed.includes(k);
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
                          onClick={() => void act({ type: 'confirmFact', key: k })}
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
