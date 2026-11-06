import {
  COMMENT_MAX_NAME,
  COMMENT_MAX_TEXT,
  type CommentMessage,
  type CommentSetting,
  type CommentThread,
  anchorPosition,
  commentsText,
  goneText,
  threadsView,
} from '@dhd/core';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useEditor } from '../editor';
import { shareLink } from '../keys';
import { useProject, useStore } from '../store';
import { Segmented } from '../ui/fields';
import { icons } from '../ui/icons';
import { shownViewNow } from '../ui/oneView';
import { type CommentAction, CommentError, errorText } from './api';
import {
  canComment,
  commentId,
  findThread,
  noCommentReason,
  useCanComment,
  useCommentCounts,
  useCommentRole,
  useComments,
} from './store';
import { relativeTime } from './time';

// ------------------------------------------------------------------------- shared bits

/** Re-renders every minute, so "5 min ago" keeps up. */
export function useNow(ms = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Phones (and short landscape phones) get sheets instead of popovers and side panels. */
const SHEET_QUERY = '(max-width: 720px), (pointer: coarse) and (max-height: 500px)';
export function useSheets(): boolean {
  const [on, setOn] = useState(() => window.matchMedia?.(SHEET_QUERY).matches ?? false);
  useEffect(() => {
    const m = window.matchMedia?.(SHEET_QUERY);
    if (!m) return;
    const change = () => setOn(m.matches);
    m.addEventListener('change', change);
    return () => m.removeEventListener('change', change);
  }, []);
  return on;
}

const ROLE_BADGE: Partial<Record<CommentMessage['role'], string>> = {
  owner: 'Owner',
  editor: 'Edit link',
};

function Time({ iso, now }: { iso: string; now: number }) {
  return (
    <time className="comment-time" dateTime={iso} title={new Date(iso).toLocaleString()}>
      {relativeTime(iso, now)}
    </time>
  );
}

/** A link that opens the plan view-only at this comment. */
export function threadLink(projectId: string, threadId: string): string {
  const url = new URL(shareLink(projectId));
  url.searchParams.set('c', threadId);
  return url.toString();
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Opens a thread on the plan: its variant, the plan view, the pin centred. */
export function jumpTo(t: CommentThread) {
  const project = useStore.getState().editor.doc;
  const place = anchorPosition(project, t.anchor);
  const c = useComments.getState();
  if (place.reason === 'no-renovation' || place.reason === 'no-level') {
    // No pin to show: the thread opens in the panel.
    c.setPanel(true);
    useComments.setState({ panelThread: t.id });
    c.open(null);
    return;
  }
  const ed = useEditor.getState();
  if (ed.walking) ed.stopWalk();
  ed.setVariant(t.anchor.variant);
  if (shownViewNow() === '3d') ed.setViewMode('plan');
  if (window.matchMedia?.(SHEET_QUERY).matches) c.setPanel(false);
  c.open(t.id, { jump: true });
}

/** "Your name", asked for once, before the first post. */
function NameField({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  id: string;
}) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        Your name
      </label>
      <input
        id={id}
        className="input comment-input"
        value={value}
        maxLength={COMMENT_MAX_NAME}
        placeholder="e.g. Mum, Wei Ling"
        autoComplete="nickname"
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="field-hint">Everyone with the link sees this name.</span>
    </div>
  );
}

/** A comment's text field with its counter past 900 characters. */
function TextField({
  id,
  label,
  value,
  onChange,
  onSubmit,
  placeholder,
  readOnly,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder: string;
  readOnly?: boolean;
}) {
  const n = Array.from(value.trim()).length;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="input comment-text"
        rows={3}
        value={value}
        placeholder={placeholder}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      {n > 900 && (
        <span className={`field-hint num${n > COMMENT_MAX_TEXT ? ' error-text' : ''}`}>
          {n} / {COMMENT_MAX_TEXT}
        </span>
      )}
    </div>
  );
}

const tooLong = (text: string) => Array.from(text.trim()).length > COMMENT_MAX_TEXT;

/** Inline "Delete this …? [Delete] [Keep]". */
function Confirm({
  question,
  action = 'Delete',
  onYes,
  onNo,
}: {
  question: string;
  action?: string;
  onYes: () => void;
  onNo: () => void;
}) {
  // Focus on Keep: a stray Enter keeps what was there.
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => keep.current?.focus(), []);
  return (
    <div className="comment-confirm">
      <span>{question}</span>
      <span className="button-row">
        <button type="button" className="btn btn-small btn-danger" onClick={onYes}>
          {action}
        </button>
        <button ref={keep} type="button" className="btn btn-small" onClick={onNo}>
          Keep
        </button>
      </span>
    </div>
  );
}

// ------------------------------------------------------------------------- composer

/** A new comment: its place, the name (until saved), the text, Post and Cancel. */
export function Composer({ onClose }: { onClose: () => void }) {
  const draft = useComments((s) => s.draft);
  const savedName = useComments((s) => s.name);
  const [name, setName] = useState(savedName);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [copied, setCopied] = useState(false);
  const id = useId();
  // The right to comment can go while typing (the owner closed comments): the text stays,
  // to copy, and the composer says why it can't post.
  const may = useCanComment();
  const role = useCommentRole();
  const setting = useComments((s) => s.doc?.setting ?? 'all');
  if (!draft) return null;
  const refused = locked || !may;
  const askName = !savedName;
  const ready =
    !busy && !refused && text.trim() !== '' && !tooLong(text) && (!askName || name.trim() !== '');

  const post = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const who = (askName ? name : savedName).trim();
    try {
      await useComments.getState().post(text.trim(), who);
      useComments.getState().setName(who);
      useStore.setState({ toast: { text: 'Comment posted.', at: Date.now(), undo: false } });
      onClose();
    } catch (e) {
      setError(errorText(e));
      if (e instanceof CommentError && e.status === 403) setLocked(true);
      setBusy(false);
    }
  };
  const cancel = () => {
    if (text.trim() && !discarding) setDiscarding(true);
    else {
      useComments.getState().cancelDraft();
      onClose();
    }
  };

  return (
    <form
      className="comment-card"
      data-comment-compose
      aria-labelledby={`${id}-h`}
      onSubmit={(e) => {
        e.preventDefault();
        void post();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cancel();
        }
      }}
    >
      <h2 id={`${id}-h`} className="comment-card-title">
        New comment · {draft.anchor.label}
      </h2>
      {askName && <NameField id={`${id}-name`} value={name} onChange={setName} />}
      <TextField
        id={`${id}-text`}
        label="Comment"
        value={text}
        onChange={(v) => {
          setText(v);
          setDiscarding(false);
          // Other words are another post: a retry of the same words keeps its ids.
          if (error) useComments.getState().renewDraft();
        }}
        onSubmit={() => void post()}
        placeholder="What do you think?"
        readOnly={refused}
      />
      {(error || !may) && (
        <p className="field-hint error-text" role="alert">
          {error ?? noCommentReason(role, setting)}
        </p>
      )}
      {refused && text.trim() && (
        <button
          type="button"
          className="link-btn comment-copy"
          onClick={() =>
            void copy(text.trim()).then((ok) => {
              if (!ok) return;
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? 'Copied' : 'Copy text'}
        </button>
      )}
      {discarding ? (
        <Confirm
          question="Discard this comment?"
          action="Discard"
          onYes={() => {
            useComments.getState().cancelDraft();
            onClose();
          }}
          onNo={() => setDiscarding(false)}
        />
      ) : (
        <div className="button-row comment-actions">
          <button type="button" className="btn" onClick={cancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!ready}>
            {busy ? 'Posting…' : 'Post'}
          </button>
        </div>
      )}
    </form>
  );
}

// ------------------------------------------------------------------------- thread

function MessageRow({
  m,
  first,
  canDelete,
  onDelete,
  now,
}: {
  m: CommentMessage;
  first: boolean;
  canDelete: boolean;
  onDelete: () => void;
  now: number;
}) {
  const [confirming, setConfirming] = useState(false);
  const badge = ROLE_BADGE[m.role];
  return (
    <li className="comment-message">
      <p className="comment-meta">
        <span className="comment-name">
          {m.name}
          {m.mine && <span className="comment-you"> (you)</span>}
        </span>
        {badge && <span className="pill pill-neutral comment-badge">{badge}</span>}
        <Time iso={m.at} now={now} />
        {!first && canDelete && !confirming && (
          <button
            type="button"
            className="link-btn comment-delete"
            onClick={() => setConfirming(true)}
          >
            Delete
          </button>
        )}
      </p>
      <p className="comment-body">{m.text}</p>
      {confirming && (
        <Confirm
          question="Delete this reply?"
          onYes={() => {
            setConfirming(false);
            onDelete();
          }}
          onNo={() => setConfirming(false)}
        />
      )}
    </li>
  );
}

/** A thread: its place, messages, a reply field, Resolve or Reopen, and More. */
export function ThreadCard({
  thread,
  onClose,
  inPanel,
}: {
  thread: CommentThread;
  onClose: () => void;
  inPanel?: boolean;
}) {
  const project = useProject();
  const projectId = project.id;
  const role = useCommentRole();
  const setting = useComments((s) => s.doc?.setting ?? 'all');
  const savedName = useComments((s) => s.name);
  const may = canComment(role, setting);
  const owner = role === 'owner';
  const [name, setName] = useState(savedName);
  const [reply, setReplyText] = useState('');
  // The reply's id, kept across retries of the same words (the server takes it once); a
  // new one after it posts or when the words change.
  const [replyId, setReplyId] = useState(() => commentId('m'));
  const setReply = (v: string) => {
    setReplyText(v);
    setReplyId(commentId('m'));
  };
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const now = useNow();
  const id = useId();
  // The heading takes focus when a thread opens, so a screen reader starts at its place.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on another thread
  useEffect(() => heading.current?.focus({ preventScroll: true }), [thread.id]);

  const place = anchorPosition(project, thread.anchor);
  const askName = !savedName;
  const allMine = thread.messages.every((m) => m.mine);
  const canDeleteThread = owner || allMine;
  const act = async (fn: () => Promise<void>, action: CommentAction = 'post') => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e, action));
    } finally {
      setBusy(false);
    }
  };
  const sendReply = () => {
    if (busy || !reply.trim() || tooLong(reply) || (askName && !name.trim())) return;
    const who = (askName ? name : savedName).trim();
    void act(async () => {
      await useComments.getState().reply(thread.id, reply.trim(), who, replyId);
      useComments.getState().setName(who);
      setReply('');
      // The Reply button goes with the text: keep focus in the field, not on the page.
      document.getElementById(`${id}-reply`)?.focus();
    });
  };
  const resolve = (on: boolean) =>
    void act(async () => {
      await useComments.getState().resolve(thread.id, on);
      if (on) {
        onClose();
        useStore.setState({
          toast: {
            text: 'Resolved.',
            at: Date.now(),
            undo: false,
            action: {
              label: 'Reopen',
              run: () =>
                void useComments
                  .getState()
                  .resolve(thread.id, false)
                  .catch(() => {}),
            },
          },
        });
      }
    }, 'save');

  return (
    <section className="comment-card" aria-labelledby={`${id}-h`}>
      <header className="comment-card-head">
        <h2 id={`${id}-h`} ref={heading} tabIndex={-1} className="comment-card-title">
          {thread.anchor.label}
        </h2>
        {project.renovation && (
          <span className="pill pill-neutral">
            {thread.anchor.variant === 'after' ? 'After' : 'Before'}
          </span>
        )}
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          {icons.close}
        </button>
      </header>
      {place.reason && <p className="comment-gone">{goneText(place.reason, thread.anchor)}</p>}
      <ul className="comment-messages">
        {thread.messages.map((m, i) => (
          <MessageRow
            key={m.id}
            m={m}
            first={i === 0}
            now={now}
            canDelete={owner || m.mine}
            onDelete={() =>
              void act(() => useComments.getState().deleteReply(thread.id, m.id), 'delete')
            }
          />
        ))}
      </ul>
      {thread.resolved && (
        <p className="comment-resolved">
          Resolved by {thread.resolved.name} · <Time iso={thread.resolved.at} now={now} />
        </p>
      )}
      {may && !thread.resolved && (
        <form
          className="comment-reply"
          onSubmit={(e) => {
            e.preventDefault();
            sendReply();
          }}
        >
          {askName && <NameField id={`${id}-name`} value={name} onChange={setName} />}
          <TextField
            id={`${id}-reply`}
            label="Reply"
            value={reply}
            onChange={setReply}
            onSubmit={sendReply}
            placeholder="Reply"
          />
          {reply.trim() && (
            <div className="button-row">
              <button
                type="submit"
                className="btn btn-primary btn-small"
                disabled={busy || tooLong(reply) || (askName && !name.trim())}
              >
                Reply
              </button>
            </div>
          )}
        </form>
      )}
      {!may && <p className="note">{noCommentReason(role, setting)}</p>}
      {error && (
        <p className="field-hint error-text" role="alert">
          {error}
        </p>
      )}
      {confirming ? (
        <Confirm
          question="Delete this comment?"
          onYes={() => {
            setConfirming(false);
            void act(async () => {
              await useComments.getState().deleteThread(thread.id);
              onClose();
              // The thread is gone: focus goes to the Comments button, not the page.
              document.querySelector<HTMLElement>('.comments-btn')?.focus();
            }, 'delete');
          }}
          onNo={() => setConfirming(false)}
        />
      ) : (
        <div className="comment-footer">
          {may && (
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              onClick={() => resolve(!thread.resolved)}
            >
              {thread.resolved ? 'Reopen' : 'Resolve'}
            </button>
          )}
          <div className="menu-anchor">
            <button
              type="button"
              className="icon-btn"
              aria-label="More"
              aria-expanded={menu}
              onClick={() => setMenu((o) => !o)}
            >
              {icons.more}
            </button>
            {menu && (
              <div className={`menu ${inPanel ? 'menu-right' : 'menu-up'}`}>
                <button
                  type="button"
                  onClick={() => {
                    setMenu(false);
                    void copy(threadLink(projectId, thread.id)).then(
                      (ok) =>
                        ok &&
                        useStore.setState({
                          toast: { text: 'Link copied.', at: Date.now(), undo: false },
                        }),
                    );
                  }}
                >
                  Copy link
                </button>
                {canDeleteThread && (
                  <button
                    type="button"
                    className="error-text"
                    onClick={() => {
                      setMenu(false);
                      setConfirming(true);
                    }}
                  >
                    Delete comment…
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------- panel

type Filter = 'open' | 'resolved';

function ThreadRow({
  item,
  renovation,
  now,
}: {
  item: { thread: CommentThread; unread: boolean };
  renovation: boolean;
  now: number;
}) {
  const t = item.thread;
  const first = t.messages[0];
  const replies = t.messages.length - 1;
  return (
    <li>
      <button type="button" className="comment-row" onClick={() => jumpTo(t)}>
        <span className="comment-row-head">
          <span className="comment-row-label">{t.anchor.label}</span>
          {renovation && (
            <span className="pill pill-neutral">
              {t.anchor.variant === 'after' ? 'After' : 'Before'}
            </span>
          )}
          {item.unread && <span className="unread-dot" role="img" aria-label="new" />}
        </span>
        {first && (
          <>
            <span className="comment-row-meta">
              {first.name} · {relativeTime(first.at, now)}
            </span>
            <span className="comment-row-text">{first.text}</span>
          </>
        )}
        {replies > 0 && (
          <span className="comment-row-meta">
            {replies === 1 ? '1 reply' : `${replies} replies`}
          </span>
        )}
      </button>
    </li>
  );
}

/** The comments panel: open and resolved threads, and who is commenting. */
export function CommentsPanel() {
  const project = useProject();
  const status = useComments((s) => s.status);
  const doc = useComments((s) => s.doc);
  const seen = useComments((s) => s.seen);
  const panelThread = useComments((s) => s.panelThread);
  const showResolved = useComments((s) => s.showResolved);
  const name = useComments((s) => s.name);
  const role = useCommentRole();
  const may = useCanComment();
  const sheet = useSheets();
  const [filter, setFilter] = useState<Filter>('open');
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<number | null>(null);
  const moved = useRef(false);
  const [dragDy, setDragDy] = useState(0);
  const [menu, setMenu] = useState(false);
  const close = () => {
    const c = useComments.getState();
    c.setPanel(false);
    useComments.setState({ panelThread: null });
    document.querySelector<HTMLElement>('.comments-btn')?.focus();
  };
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('.panel-title')?.focus({ preventScroll: true });
  }, []);

  const view = doc ? threadsView(doc, seen) : null;
  const items = view ? (filter === 'open' ? view.open : view.resolved) : [];
  const inPanel = findThread(doc, panelThread);
  const renovation = !!project.renovation;
  const resolvedCount = view?.resolved.length ?? 0;

  let body: ReactNode;
  if (status === 'off') {
    body = <p className="note">Comments need the plan saved on the server.</p>;
  } else if (status === 'unsupported') {
    body = <p className="note">This server doesn’t keep comments yet.</p>;
  } else if (status === 'loading' && !doc) {
    body = <p className="note">Loading comments…</p>;
  } else if (status === 'error' && !doc) {
    body = (
      <p className="note">
        Couldn’t load comments.{' '}
        <button
          type="button"
          className="link-btn"
          onClick={() =>
            void useComments
              .getState()
              .refresh(true)
              .catch(() => {})
          }
        >
          Try again
        </button>
      </p>
    );
  } else if (inPanel) {
    body = (
      <ThreadCard
        thread={inPanel}
        inPanel
        onClose={() => useComments.setState({ panelThread: null })}
      />
    );
  } else if (view) {
    body = (
      <>
        {!may && <p className="note">{noCommentReason(role, doc?.setting ?? 'all')}</p>}
        <Segmented<Filter>
          label="Show"
          fill
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'open', label: `Open ${view.open.length}` },
            { value: 'resolved', label: `Resolved ${resolvedCount}` },
          ]}
        />
        {filter === 'resolved' && resolvedCount > 0 && (
          <label className="check-row">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => useComments.getState().setShowResolved(e.target.checked)}
            />
            <span>Show resolved on the plan</span>
          </label>
        )}
        {items.length === 0 ? (
          <p className="note">
            {filter === 'open'
              ? doc?.threads.length
                ? 'No open comments.'
                : 'No comments yet. Choose Comment, then tap the plan to ask the family about a spot, a wall or a piece of furniture.'
              : 'No resolved comments.'}
          </p>
        ) : (
          <ul className="comment-rows">
            {items.map((i) => (
              <ThreadRow key={i.thread.id} item={i} renovation={renovation} now={now} />
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <aside
      ref={panel}
      className={`panel comments-panel${sheet ? ' comments-sheet' : ''}${full ? ' comments-sheet-full' : ''}`}
      style={
        sheet && dragDy
          ? { height: `calc(${full ? '100dvh - 48px' : '50dvh'} - ${dragDy}px)` }
          : undefined
      }
      aria-label="Comments"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault();
          close();
        }
      }}
    >
      {sheet && (
        <button
          type="button"
          className="sheet-handle"
          aria-label={full ? 'Make the comments smaller' : 'Make the comments full height'}
          onClick={() => {
            if (!moved.current) setFull((f) => !f);
            moved.current = false;
          }}
          onPointerDown={(e) => {
            drag.current = e.clientY;
            moved.current = false;
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          // The sheet follows the finger, and settles at half, full or closed on release.
          onPointerMove={(e) => {
            if (drag.current === null) return;
            const dy = e.clientY - drag.current;
            if (Math.abs(dy) > 4) moved.current = true;
            setDragDy(dy);
          }}
          onPointerUp={(e) => {
            const from = drag.current;
            drag.current = null;
            setDragDy(0);
            if (from === null) return;
            const dy = e.clientY - from;
            if (dy < -30) setFull(true);
            else if (dy > 30) {
              if (full) setFull(false);
              else close();
            }
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragDy(0);
          }}
        />
      )}
      <div className="inspector-head">
        <h2 className="panel-title" tabIndex={-1}>
          Comments
        </h2>
        <button type="button" className="icon-btn" aria-label="Close comments" onClick={close}>
          {icons.close}
        </button>
      </div>
      <div className="comments-panel-body">{body}</div>
      {doc && !inPanel && (
        // One row, so the list keeps the room: who is commenting, and the rest in a menu.
        <footer className="comments-panel-foot">
          {renaming ? (
            <form
              className="copy-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (!draftName.trim()) return;
                useComments.getState().setName(draftName);
                setRenaming(false);
              }}
            >
              <input
                className="input"
                aria-label="Your name"
                value={draftName}
                maxLength={COMMENT_MAX_NAME}
                // biome-ignore lint/a11y/noAutofocus: opened by Change, to type in
                autoFocus
                onChange={(e) => setDraftName(e.target.value)}
              />
              <button type="submit" className="btn btn-small">
                Save
              </button>
            </form>
          ) : confirming ? (
            <Confirm
              question={`Delete ${resolvedCount} resolved ${resolvedCount === 1 ? 'comment' : 'comments'}? This can’t be undone.`}
              onYes={() => {
                setConfirming(false);
                setError(null);
                useComments
                  .getState()
                  .deleteResolved()
                  .catch((e) => setError(errorText(e, 'delete')));
              }}
              onNo={() => setConfirming(false)}
            />
          ) : (
            <div className="comments-foot-row">
              <p className="comment-as">
                {may && name && (
                  <>
                    Commenting as {name} ·{' '}
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => {
                        setDraftName(name);
                        setRenaming(true);
                      }}
                    >
                      Change
                    </button>
                  </>
                )}
                {copied && <span className="comment-copied">Copied</span>}
              </p>
              <div className="menu-anchor">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="More comment actions"
                  aria-expanded={menu}
                  onClick={() => setMenu((o) => !o)}
                >
                  {icons.more}
                </button>
                {menu && (
                  <div className="menu menu-up">
                    <button
                      type="button"
                      disabled={(view?.open.length ?? 0) === 0}
                      onClick={() => {
                        setMenu(false);
                        void copy(commentsText(doc, renovation)).then((ok) => {
                          if (!ok) return;
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1500);
                        });
                      }}
                    >
                      Copy open comments
                    </button>
                    {role === 'owner' && resolvedCount > 0 && (
                      <button
                        type="button"
                        className="error-text"
                        onClick={() => {
                          setMenu(false);
                          setConfirming(true);
                        }}
                      >
                        Delete resolved comments…
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
          {error && (
            <p className="field-hint error-text" role="alert">
              {error}
            </p>
          )}
        </footer>
      )}
    </aside>
  );
}

// ------------------------------------------------------------------------- top bar

/** "Comments" in the top bar, with the open count and a dot for new ones. */
export function CommentsButton() {
  const status = useComments((s) => s.status);
  const open = useComments((s) => s.panelOpen);
  const local = useStore((s) => s.backend?.kind === 'local');
  const { open: count, unread } = useCommentCounts();
  if (status === 'unsupported') return null;
  const off = local || status === 'off';
  const label = off ? 'Comments' : `Comments, ${count} open${unread ? `, ${unread} new` : ''}`;
  return (
    <button
      type="button"
      className="btn btn-small comments-btn"
      aria-label={label}
      aria-pressed={open}
      aria-disabled={off || undefined}
      title={off ? 'Comments need the plan saved on the server.' : undefined}
      onClick={() => {
        if (off) return;
        useComments.getState().setPanel(!open);
      }}
    >
      <span className="comments-btn-icon">{icons.comment}</span>
      <span className="comments-btn-label">Comments</span>
      {!off && count > 0 && <span className="comments-count num">{count}</span>}
      {!off && unread > 0 && <span className="unread-dot" aria-hidden="true" />}
    </button>
  );
}

// ------------------------------------------------------------------------- share menu

/** The owner's "Who can comment", in the share menu. */
export function WhoCanComment() {
  const setting = useComments((s) => s.doc?.setting);
  const [error, setError] = useState<string | null>(null);
  if (!setting) return null;
  return (
    <div className="field">
      <span className="field-label">Who can comment</span>
      <Segmented<CommentSetting>
        label="Who can comment"
        fill
        value={setting}
        onChange={(v) => {
          setError(null);
          useComments
            .getState()
            .setSetting(v)
            .catch((e) => setError(errorText(e, 'save')));
        }}
        options={[
          { value: 'all', label: 'Anyone with a link' },
          { value: 'edit', label: 'Edit link only' },
          { value: 'off', label: 'No one' },
        ]}
      />
      <p className="note">
        Everyone with a link can still read comments. You can moderate them only in this browser,
        where you own the plan.
      </p>
      {error && <p className="field-hint error-text">{error}</p>}
    </div>
  );
}

// ------------------------------------------------------------------------- plan details

/** The plan details' switch for the pins on the plan. */
export function CommentPinsSwitch() {
  const on = useComments((s) => s.pinsShown);
  const status = useComments((s) => s.status);
  const any = useComments((s) => (s.doc?.threads.length ?? 0) > 0);
  if (status !== 'ready' || !any) return null;
  return (
    <label className="check-row">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => useComments.getState().setPinsShown(e.target.checked)}
      />
      <span>Comments on the plan</span>
    </label>
  );
}

// ------------------------------------------------------------------------- app wiring

/** The one polite live region for comments: new ones, and each action. */
export function CommentsLive() {
  const text = useComments((s) => s.announcement);
  return (
    <div className="visually-hidden" aria-live="polite" data-testid="comments-live">
      {text}
    </div>
  );
}

/**
 * Starts comments for the open plan (on the server only), and follows a `?c=<thread>` link
 * once they have loaded.
 */
/** What a thread id in a link may look like. */
const THREAD_ID = /^[a-z0-9_~-]{1,64}$/;

export function useCommentsLink() {
  const id = useProject().id;
  const remote = useStore((s) => s.backend?.kind === 'remote');
  const opened = useStore(
    (s) => s.sync.kind === 'saved' || s.sync.kind === 'dirty' || s.sync.kind === 'saving',
  );
  useEffect(() => {
    if (opened) useComments.getState().attach(id, remote);
  }, [id, remote, opened]);

  const status = useComments((s) => s.status);
  // Only once comments started for this plan (before that, "off" says nothing).
  const attached = useComments((s) => s.projectId === id);
  useEffect(() => {
    const url = new URL(window.location.href);
    const c = url.searchParams.get('c');
    if (!c || url.searchParams.get('p') !== id) return;
    if (!attached || status === 'loading' || status === 'error') return;
    url.searchParams.delete('c');
    window.history.replaceState(null, '', url);
    // Only comments that loaded can say a comment is gone: a plan kept in this browser, or a
    // server without comments, has nothing to say about it.
    if (status !== 'ready' || !THREAD_ID.test(c)) return;
    const t = findThread(useComments.getState().doc, c);
    if (!t) {
      useStore.setState({ notice: 'That comment was deleted.' });
      return;
    }
    jumpTo(t);
  }, [status, id, attached]);
}
