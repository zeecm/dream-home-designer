import {
  AFTER_SUFFIX,
  type AnchorPlace,
  type CommentAnchor,
  anchorPosition,
  threadsView,
} from '@dhd/core';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type Tool, useEditor } from '../editor';
import { type Size, type View, panBy, worldToScreen } from '../plan/view';
import { useLevel, useProject, useStore } from '../store';
import { useComments } from './store';
import { Composer, ThreadCard, useSheets } from './ui';

interface Pin {
  key: string;
  threadId: string | null;
  anchor: CommentAnchor;
  place: AnchorPlace;
  initial: string;
  replies: number;
  label: string;
  state: 'open' | 'resolved' | 'posting' | 'draft';
  unread: boolean;
}

/** The last jump handled (across remounts: a plan view mounting later mustn't redo it). */
let lastJump = { token: 0, at: 0 };
const projectNow = () => useStore.getState().editor.doc;

const initialOf = (name: string) => Array.from(name.trim())[0]?.toUpperCase() ?? '?';

/** The popover's width and its gap from the pin (screen px). */
const POP_W = 340;
const POP_GAP = 18;

function describePin(p: Pin): string {
  if (p.state === 'draft') return `New comment on ${p.anchor.label}`;
  if (p.state === 'posting') return `Posting a comment on ${p.anchor.label}`;
  const replies = p.replies === 1 ? ', 1 reply' : p.replies ? `, ${p.replies} replies` : '';
  return `${p.label}${replies}${p.state === 'resolved' ? ', resolved' : ''}${p.unread ? ', unread' : ''}`;
}

/**
 * Comment pins over the plan (HTML above the SVG: the same size at any zoom, never in the
 * plan PNG), and the composer or thread next to the open one: a popover on a desktop, a
 * sheet on a phone.
 */
export function CommentsOnPlan({ view, size, tool }: { view: View; size: Size; tool: Tool }) {
  const project = useProject();
  const level = useLevel();
  const variant = useEditor((s) => s.variant);
  const fitRequested = useEditor((s) => s.fitRequested);
  const doc = useComments((s) => s.doc);
  const seen = useComments((s) => s.seen);
  const pending = useComments((s) => s.pending);
  const draft = useComments((s) => s.draft);
  const openId = useComments((s) => s.openThread);
  const showResolved = useComments((s) => s.showResolved);
  const shown = useComments((s) => s.pinsShown);
  const jumpToken = useComments((s) => s.jumpToken);
  const sheets = useSheets();
  const box = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(0);

  const baseLevel = level?.id.endsWith(AFTER_SUFFIX)
    ? level.id.slice(0, -AFTER_SUFFIX.length)
    : level?.id;
  const here = (a: CommentAnchor) => a.variant === variant && a.levelId === baseLevel;

  const pins: Pin[] = [];
  if (doc) {
    const unread = new Map(
      [...threadsView(doc, seen).open].map((i) => [i.thread.id, i.unread] as const),
    );
    for (const t of doc.threads) {
      const isOpen = t.id === openId;
      if (!here(t.anchor) || (!shown && !isOpen) || (t.resolved && !showResolved && !isOpen)) {
        continue;
      }
      const first = t.messages[0];
      pins.push({
        key: t.id,
        threadId: t.id,
        anchor: t.anchor,
        place: anchorPosition(project, t.anchor),
        initial: initialOf(first?.name ?? ''),
        replies: t.messages.length - 1,
        label: `Comment by ${first?.name ?? 'someone'} on ${t.anchor.label}`,
        state: t.resolved ? 'resolved' : 'open',
        unread: unread.get(t.id) ?? false,
      });
    }
  }
  for (const p of pending) {
    if (!here(p.anchor)) continue;
    pins.push({
      key: p.id,
      threadId: null,
      anchor: p.anchor,
      place: anchorPosition(project, p.anchor),
      initial: initialOf(p.name),
      replies: 0,
      label: '',
      state: 'posting',
      unread: false,
    });
  }
  const posting = pending.length > 0;
  if (draft && here(draft.anchor) && !posting) {
    pins.push({
      key: 'draft',
      threadId: null,
      anchor: draft.anchor,
      place: anchorPosition(project, draft.anchor),
      initial: initialOf(useComments.getState().name || '+'),
      replies: 0,
      label: '',
      state: 'draft',
      unread: false,
    });
  }
  // Newest on top: later pins draw later; the open one above all.
  pins.sort((a, b) => Number(a.threadId === openId) - Number(b.threadId === openId));

  const thread = doc?.threads.find((t) => t.id === openId && here(t.anchor)) ?? null;
  const active = draft && here(draft.anchor) ? draft.anchor : thread?.anchor;
  const activeAt = active ? worldToScreen(view, size, anchorPosition(project, active).at) : null;

  const close = () => {
    const c = useComments.getState();
    const back = c.returnFocus;
    if (c.draft) c.cancelDraft();
    c.open(null);
    back?.focus?.({ preventScroll: true });
  };

  // A jump from the panel or a link: centre the pin once the plan has fitted.
  // The pane may still be settling (from 3D, a panel opening): for a moment after a jump,
  // a resize centres it again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a jump, or a resize just after one
  useEffect(() => {
    if (!jumpToken || fitRequested || !thread || size.width === 0) return;
    const fresh = jumpToken !== lastJump.token;
    if (!fresh && Date.now() - lastJump.at > 1000) return;
    if (fresh) lastJump = { token: jumpToken, at: Date.now() };
    const anchor = thread.anchor;
    // After the canvas's own effects in this render: its fit, which hasn't yet seen a view
    // set here, would put the whole plan back.
    const frame = requestAnimationFrame(() => {
      const at = anchorPosition(projectNow(), anchor).at;
      const ed = useEditor.getState();
      const v = ed.view ?? view;
      // A zoom where a room fits: at least 40 px a metre.
      ed.setView({ cx: at.x, cy: at.y, zoom: Math.max(v.zoom, 40) }, true);
    });
    return () => cancelAnimationFrame(frame);
  }, [jumpToken, fitRequested, thread?.id, size.width, size.height]);

  // The card's height: a popover moves up to fit it; on a phone, the plan moves so the pin
  // sits in the strip above the sheet.
  useLayoutEffect(() => {
    const el = card.current;
    if (el) setCardH(sheets ? el.getBoundingClientRect().height : el.scrollHeight);
  });
  const panned = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opened card
  useEffect(() => {
    const key = active ? (openId ?? 'draft') : null;
    if (!sheets || !activeAt || !key || !box.current || cardH === 0) {
      if (!key) panned.current = null;
      return;
    }
    if (panned.current === key) return;
    panned.current = key;
    const top = box.current.getBoundingClientRect().top;
    const strip = window.innerHeight - cardH - top;
    if (strip <= 80) return;
    const want = Math.max(48, strip / 2);
    if (activeAt.y > 40 && activeAt.y < strip - 40) return;
    const ed = useEditor.getState();
    ed.setView(panBy(ed.view ?? view, 0, want - activeAt.y), true);
  }, [sheets, cardH, active, openId]);

  // Escape closes the thread wherever focus is (a button that went with a reply leaves it on
  // the page), unless a dialog or a field elsewhere has it.
  useEffect(() => {
    if (!thread || draft) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]'))
        return;
      const t = e.target as Element | null;
      if (
        t &&
        t !== document.body &&
        !card.current?.contains(t) &&
        t.closest('input, textarea, select, .menu')
      )
        return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  // A click away from the thread closes it (a draft only closes by Cancel or Escape).
  useEffect(() => {
    if (!thread || draft || sheets) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (card.current?.contains(t) || t?.closest?.('.comment-pin, .comments-panel, .menu')) return;
      useComments.getState().open(null);
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [thread, draft, sheets]);

  const drawing = tool === 'wall' || tool === 'room';
  const pos = (p: AnchorPlace) => worldToScreen(view, size, p.at);

  let popStyle: React.CSSProperties | undefined;
  if (activeAt && !sheets) {
    const right = activeAt.x + POP_GAP + POP_W <= size.width - 8;
    const left = right ? activeAt.x + POP_GAP : Math.max(8, activeAt.x - POP_GAP - POP_W);
    const top = Math.max(8, Math.min(activeAt.y - 40, size.height - 8 - (cardH || 320)));
    popStyle = { left, top, maxHeight: size.height - top - 8 };
  }

  const cardBody =
    draft && active === draft.anchor ? (
      <Composer onClose={close} />
    ) : thread ? (
      <ThreadCard thread={thread} onClose={close} />
    ) : null;

  return (
    <div ref={box} className="comment-pins" data-export="skip" aria-label="Comments on the plan">
      {pins.map((p) => {
        const s = pos(p.place);
        if (s.x < -40 || s.y < -40 || s.x > size.width + 40 || s.y > size.height + 40) return null;
        const cls = [
          'comment-pin',
          `comment-pin-${p.state}`,
          p.place.state === 'gone' ? 'comment-pin-gone' : '',
          p.threadId && p.threadId === openId ? 'comment-pin-active' : '',
        ]
          .filter(Boolean)
          .join(' ');
        const inner = (
          <>
            <svg className="comment-pin-shape" viewBox="0 0 28 34" aria-hidden="true">
              <path d="M6 1h16a5 5 0 0 1 5 5v12a5 5 0 0 1-5 5h-4.5L14 32.5 10.5 23H6a5 5 0 0 1-5-5V6a5 5 0 0 1 5-5Z" />
            </svg>
            <span className="comment-pin-initial" aria-hidden="true">
              {p.initial}
            </span>
            {p.replies > 0 && (
              <span className="comment-pin-count num" aria-hidden="true">
                {p.replies}
              </span>
            )}
            {p.unread && <span className="comment-pin-dot" aria-hidden="true" />}
          </>
        );
        if (!p.threadId) {
          return (
            <span
              key={p.key}
              className={cls}
              style={{ left: s.x, top: s.y }}
              role="img"
              aria-label={describePin(p)}
            >
              {inner}
            </span>
          );
        }
        const id = p.threadId;
        return (
          <button
            key={p.key}
            type="button"
            className={cls}
            style={{ left: s.x, top: s.y, pointerEvents: drawing ? 'none' : undefined }}
            aria-label={describePin(p)}
            aria-expanded={id === openId}
            data-thread={id}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              useComments.setState({ returnFocus: e.currentTarget });
              useComments.getState().cancelDraft();
              useComments.getState().open(id === openId ? null : id);
            }}
          >
            {inner}
          </button>
        );
      })}
      {cardBody &&
        (sheets ? (
          createPortal(<Sheet cardRef={card}>{cardBody}</Sheet>, document.body)
        ) : (
          <div
            ref={card}
            className="comment-popover"
            style={popStyle}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !e.defaultPrevented) {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
          >
            {cardBody}
          </div>
        ))}
    </div>
  );
}

/**
 * A phone's sheet: full width, above the keyboard (its bottom follows the visual viewport)
 * and at most the viewport less 160 px high, so the pin stays in sight above it.
 */
function Sheet({
  children,
  cardRef,
}: {
  children: React.ReactNode;
  cardRef: React.RefObject<HTMLDivElement>;
}) {
  const [box, setBox] = useState<{ bottom: number; max: number }>(() => measure());
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setBox(measure());
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return (
    <div
      ref={cardRef}
      className="comment-sheet"
      style={{ bottom: box.bottom, maxHeight: box.max }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault();
          const c = useComments.getState();
          if (c.draft) c.cancelDraft();
          c.open(null);
        }
      }}
    >
      {children}
    </div>
  );
}

function measure() {
  const vv = window.visualViewport;
  const h = vv?.height ?? window.innerHeight;
  const bottom = vv ? Math.max(0, window.innerHeight - (vv.offsetTop + vv.height)) : 0;
  return { bottom, max: Math.max(220, h - 160) };
}
