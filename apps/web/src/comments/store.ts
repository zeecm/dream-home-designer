import {
  type CommentAnchor,
  type CommentSetting,
  type CommentThread,
  type CommentsDoc,
  type CommentsSeen,
  threadsView,
} from '@dhd/core';
import { create } from 'zustand';
import type { Role } from '../backend';
import { useStore } from '../store';
import { track } from '../telemetry';
import { CommentError, type Fetched, api, errorText, fetchComments } from './api';
import {
  commentName,
  pinsShownSaved,
  readSeen,
  savePinsShown,
  setCommentName,
  writeSeen,
} from './author';
import { type Poller, createPoller } from './poll';

/**
 * Comments live beside the plan, never in its document or undo: their own store, fed by
 * polling and by each write's answer (the whole document).
 */

export type CommentsStatus = 'off' | 'loading' | 'ready' | 'error' | 'unsupported';

/** A comment being posted: shown on the plan as "Posting…" until the server answers. */
export interface PendingPost {
  id: string;
  messageId: string;
  anchor: CommentAnchor;
  name: string;
  text: string;
}

/**
 * The composer: a new comment at an anchor. Its ids are made with it, so a retry after a
 * lost answer is the same post (the server takes it once), not a second thread.
 */
export interface Draft {
  anchor: CommentAnchor;
  id: string;
  messageId: string;
}

interface CommentsState {
  projectId: string | null;
  status: CommentsStatus;
  doc: CommentsDoc | null;
  etag: string | null;
  /** The caller's role, as the comments API last said. */
  role: Role | null;
  pending: PendingPost[];
  seen: CommentsSeen;
  panelOpen: boolean;
  /** The thread shown in the popover (or the sheet). */
  openThread: string | null;
  /** A thread shown inside the panel, because its pin can't be shown on the plan. */
  panelThread: string | null;
  draft: Draft | null;
  /** Show resolved threads' pins (grey). */
  showResolved: boolean;
  /** The plan details' "Comments" switch. */
  pinsShown: boolean;
  /** Bumped to make the canvas centre the open thread's pin. */
  jumpToken: number;
  /** For the polite live region: new comments and each action. */
  announcement: string;
  /** Where focus goes back to when the popover closes. */
  returnFocus: HTMLElement | null;
  /** The name this browser comments as ("" until the first post). */
  name: string;
  setName: (name: string) => void;

  attach: (projectId: string | null, remote: boolean) => void;
  /** Fetches (with If-None-Match unless `fresh`); the poller passes its abort signal. */
  refresh: (fresh?: boolean, signal?: AbortSignal) => Promise<void>;
  setPanel: (open: boolean) => void;
  open: (threadId: string | null, opts?: { jump?: boolean }) => void;
  startDraft: (anchor: CommentAnchor) => void;
  /** New ids for the draft: its text changed, so it is another post. */
  renewDraft: () => void;
  cancelDraft: () => void;
  post: (text: string, name: string) => Promise<void>;
  /** `messageId` is the caller's, kept across retries of the same reply. */
  reply: (threadId: string, text: string, name: string, messageId: string) => Promise<void>;
  resolve: (threadId: string, resolved: boolean) => Promise<void>;
  deleteThread: (threadId: string) => Promise<void>;
  deleteReply: (threadId: string, messageId: string) => Promise<void>;
  deleteResolved: () => Promise<void>;
  setSetting: (s: CommentSetting) => Promise<void>;
  setShowResolved: (on: boolean) => void;
  setPinsShown: (on: boolean) => void;
  announce: (text: string) => void;
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
export function commentId(prefix: 't' | 'm'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${[...bytes].map((b) => ALPHABET[b % 36]).join('')}`;
}

/** Whether a role may post, reply and resolve under the owner's setting. */
export function canComment(role: Role | null, setting: CommentSetting): boolean {
  if (!role) return false;
  if (role === 'owner') return true;
  if (setting === 'off') return false;
  if (setting === 'edit') return role !== 'viewer';
  return true;
}

/** Why a role can't comment, in the words the panel shows. */
export function noCommentReason(role: Role | null, setting: CommentSetting): string | null {
  if (canComment(role, setting)) return null;
  return setting === 'off'
    ? 'The owner has closed comments on this plan.'
    : 'Only people with the edit link can comment on this plan.';
}

/** The comment (or reply) is already deleted. */
const isGone = (e: unknown) => e instanceof CommentError && e.status === 404 && e.code === 'gone';

let poller: Poller | null = null;
let detach: (() => void) | null = null;
/** Bumped as each write's answer lands: a poll that started before one is out of date. */
let writes = 0;

export const useComments = create<CommentsState>((set, get) => {
  /** Takes a document the server sent, unless it is older than the one held. */
  const accept = (f: Fetched) => {
    const s = get();
    // An older answer (a poll overtaken by a write) is dropped; another epoch is a plan
    // made again under the same id, whose versions start afresh. A document without an
    // epoch (no comments yet) never replaces one that has had comments.
    if (s.doc?.epoch && !f.doc.epoch) return;
    if (s.doc && f.doc.epoch === s.doc.epoch && f.doc.version < s.doc.version) return;
    // New messages are told apart by their ids: the first comment comes with a new epoch.
    const before = s.doc;
    set({
      doc: f.doc,
      etag: f.etag,
      role: f.role ?? s.role,
      status: 'ready',
    });
    if (before) announceNew(before, f.doc);
  };

  const announceNew = (before: CommentsDoc, after: CommentsDoc) => {
    const known = new Set(before.threads.flatMap((t) => t.messages.map((m) => m.id)));
    for (const t of after.threads) {
      const m = t.messages.find((x) => !x.mine && !known.has(x.id));
      if (m) {
        get().announce(`New comment from ${m.name} on ${t.anchor.label}`);
        return;
      }
    }
  };

  const markSeen = (threadId?: string) => {
    const s = get();
    if (!s.projectId) return;
    const now = Date.now();
    const seen: CommentsSeen = threadId
      ? { all: s.seen.all, threads: { ...s.seen.threads, [threadId]: now } }
      : { all: now, threads: {} };
    writeSeen(s.projectId, seen);
    set({ seen });
  };

  /** Runs a write; its answer replaces the document. A 403 refetches without a tag. */
  const run = async (fn: (id: string) => Promise<Fetched>, done?: string) => {
    const id = get().projectId;
    if (!id) return;
    try {
      const answer = await fn(id);
      writes++;
      // Another plan opened meanwhile: this answer is not its comments.
      if (get().projectId !== id) return;
      accept(answer);
      if (done) get().announce(done);
    } catch (e) {
      if (e instanceof CommentError && e.status === 403) void get().refresh(true);
      throw e;
    }
  };

  return {
    projectId: null,
    status: 'off',
    doc: null,
    etag: null,
    role: null,
    pending: [],
    seen: { all: 0, threads: {} },
    panelOpen: false,
    openThread: null,
    panelThread: null,
    draft: null,
    showResolved: false,
    pinsShown: pinsShownSaved(),
    jumpToken: 0,
    announcement: '',
    returnFocus: null,
    name: typeof window === 'undefined' ? '' : commentName(),
    setName: (name) => {
      setCommentName(name);
      set({ name: name.trim() });
    },

    attach: (projectId, remote) => {
      const s = get();
      if (s.projectId === projectId && (s.status !== 'off') === remote) return;
      poller?.stop();
      detach?.();
      poller = null;
      detach = null;
      set({
        projectId,
        status: projectId && remote ? 'loading' : 'off',
        doc: null,
        etag: null,
        role: null,
        pending: [],
        openThread: null,
        panelThread: null,
        draft: null,
        seen: projectId ? readSeen(projectId) : { all: 0, threads: {} },
      });
      if (!projectId || !remote || typeof window === 'undefined') return;
      const p = createPoller({
        fetch: async (signal) => {
          try {
            await get().refresh(false, signal);
            return get().status !== 'error';
          } catch {
            return false;
          }
        },
        active: () => get().panelOpen || !!get().openThread,
        visible: () => document.visibilityState !== 'hidden',
      });
      poller = p;
      const onVisible = () => p.visibility();
      const onFocus = () => p.poke();
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('focus', onFocus);
      detach = () => {
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('focus', onFocus);
      };
      p.poke();
    },

    refresh: async (fresh = false, signal?: AbortSignal) => {
      const id = get().projectId;
      if (!id || get().status === 'off' || get().status === 'unsupported') return;
      const started = writes;
      try {
        const res = await fetchComments(id, fresh ? null : get().etag, signal);
        // A write answered meanwhile: its document is newer than this one.
        if (get().projectId !== id || writes !== started) return;
        if ('notModified' in res) {
          if (res.role && res.role !== get().role) set({ role: res.role });
          if (get().status !== 'ready') set({ status: 'ready' });
          return;
        }
        accept(res);
      } catch (e) {
        if (signal?.aborted || get().projectId !== id) return;
        if (e instanceof CommentError && e.code === 'unsupported') {
          set({ status: 'unsupported' });
          poller?.stop();
          return;
        }
        // Keep what's shown; only a first load that fails shows the error.
        if (!get().doc) set({ status: 'error' });
        throw e;
      }
    },

    setPanel: (panelOpen) => {
      set({ panelOpen });
      if (panelOpen) {
        markSeen();
        poller?.poke();
      } else poller?.reschedule();
    },

    open: (openThread, opts) => {
      if (openThread) markSeen(openThread);
      set((s) => ({
        openThread,
        draft: openThread ? null : s.draft,
        jumpToken: opts?.jump ? s.jumpToken + 1 : s.jumpToken,
      }));
      poller?.reschedule();
    },

    startDraft: (anchor) =>
      set({
        draft: { anchor, id: commentId('t'), messageId: commentId('m') },
        openThread: null,
      }),
    renewDraft: () =>
      set((s) =>
        s.draft ? { draft: { ...s.draft, id: commentId('t'), messageId: commentId('m') } } : {},
      ),
    cancelDraft: () => set({ draft: null }),

    post: async (text, name) => {
      const s = get();
      const draft = s.draft;
      if (!draft || !s.projectId) return;
      const p: PendingPost = {
        id: draft.id,
        messageId: draft.messageId,
        anchor: draft.anchor,
        name,
        text,
      };
      set({ pending: [...s.pending.filter((x) => x.id !== p.id), p] });
      try {
        await run(
          (id) =>
            api.addThread(id, { id: p.id, messageId: p.messageId, anchor: p.anchor, name, text }),
          'Comment posted.',
        );
        track('comment');
        set({ draft: null, openThread: null });
      } finally {
        set((st) => ({ pending: st.pending.filter((x) => x.id !== p.id) }));
      }
    },

    reply: async (threadId, text, name, messageId) => {
      await run((id) => api.reply(id, threadId, { id: messageId, name, text }), 'Reply posted.');
      track('comment');
      markSeen(threadId);
    },

    resolve: async (threadId, resolved) => {
      const name = get().name || 'Someone';
      await run(
        (id) => api.resolve(id, threadId, resolved, name),
        resolved ? 'Resolved.' : 'Reopened.',
      );
    },

    deleteThread: async (threadId) => {
      try {
        await run((id) => api.deleteThread(id, threadId), 'Comment deleted.');
      } catch (e) {
        // Already gone: what was wanted (not any 404: a plan that's gone is an error).
        if (!isGone(e)) throw e;
        void get().refresh(true);
      }
      if (get().openThread === threadId) set({ openThread: null });
    },

    deleteReply: async (threadId, messageId) => {
      try {
        await run((id) => api.deleteReply(id, threadId, messageId), 'Reply deleted.');
      } catch (e) {
        if (!isGone(e)) throw e;
        void get().refresh(true);
      }
    },

    deleteResolved: () => run((id) => api.deleteResolved(id), 'Resolved comments deleted.'),
    setSetting: (setting) => run((id) => api.setSetting(id, setting)),
    setShowResolved: (showResolved) => set({ showResolved }),
    setPinsShown: (pinsShown) => {
      savePinsShown(pinsShown);
      set({ pinsShown });
    },
    announce: (text) =>
      // The same words twice in a row still announce: a zero-width change between them.
      set((s) => ({ announcement: s.announcement === text ? `${text}​` : text })),
  };
});

/** The thread with this id, if the comments hold it. */
export const findThread = (doc: CommentsDoc | null, id: string | null): CommentThread | null =>
  (id && doc?.threads.find((t) => t.id === id)) || null;

/** Counts for the top bar: open threads and how many are new. */
export function useCommentCounts(): { open: number; unread: number } {
  return useComments((s) => {
    if (!s.doc) return ZERO;
    const v = threadsView(s.doc, s.seen);
    const key = `${v.open.length}:${v.unread}`;
    const prev = countsCache.get(s);
    if (prev?.key === key) return prev.value;
    const value = { open: v.open.length, unread: v.unread };
    countsCache.set(s, { key, value });
    return value;
  });
}

const ZERO = { open: 0, unread: 0 };
const countsCache = new WeakMap<object, { key: string; value: { open: number; unread: number } }>();

export { errorText };

/** The role comments go by: the comments API's answer, else the plan's. */
export function useCommentRole(): Role | null {
  const planRole = useStore((s) => s.role);
  return useComments((s) => s.role) ?? planRole;
}

/** The same outside React. */
export const commentRole = (): Role | null =>
  useComments.getState().role ?? useStore.getState().role;

/** Whether this browser may comment on the open plan now, outside React. */
export function mayComment(): boolean {
  const c = useComments.getState();
  return c.status === 'ready' && !!c.doc && canComment(commentRole(), c.doc.setting);
}

/** Whether this browser may comment on the open plan now (comments loaded, rights held). */
export function useCanComment(): boolean {
  const role = useCommentRole();
  return useComments((s) => s.status === 'ready' && !!s.doc && canComment(role, s.doc.setting));
}
