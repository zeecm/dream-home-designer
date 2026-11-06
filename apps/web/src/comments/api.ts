import { type CommentAnchor, type CommentSetting, CommentsDoc } from '@dhd/core';
import type { Role } from '../backend';
import { authHeaders } from '../keys';
import { authorKey } from './author';

/**
 * The comments API (apps/api internal/httpapi/comments.go). Every write answers with the
 * whole document, so the client just replaces its copy. Rights come from the X-Role header
 * and the document's setting, never from the body, so a 304 can't carry stale rights.
 */

const url = (id: string, rest = '') => `/api/projects/${encodeURIComponent(id)}/comments${rest}`;

/** A refused or failed request, with the API's code when it sent one. */
export class CommentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Copy for the codes the server sends (the server's own text is used otherwise). */
export const ERROR_COPY: Record<string, string> = {
  comments_off: 'The owner has closed comments on this plan.',
  comments_edit_only: 'Only people with the edit link can comment on this plan.',
  not_yours: 'You can only delete your own comments.',
  thread_full: 'This thread has 50 replies. Start a new comment.',
  comments_full:
    'This plan has 300 comments, the most it can hold. The owner can delete resolved ones.',
  comment_rate: 'You’re commenting very fast. Wait a minute and try again.',
  comment_daily: 'That’s a lot of comments for one day. Try again tomorrow.',
  gone: 'That comment was deleted.',
  busy: 'Comments are busy. Try again in a moment.',
  comments_too_big:
    'This plan’s comments have reached their size limit. The owner can delete resolved ones.',
  network: 'Couldn’t post. Check your connection and try again.',
};

export const errorText = (e: unknown): string =>
  e instanceof CommentError
    ? (ERROR_COPY[e.code] ?? e.message)
    : (ERROR_COPY.network ?? 'Something went wrong.');

export interface Fetched {
  doc: CommentsDoc;
  role: Role | null;
  etag: string | null;
}

const readRole = (res: Response): Role | null => {
  const r = res.headers.get('X-Role');
  return r === 'owner' || r === 'editor' || r === 'viewer' || r === 'open' ? r : null;
};

async function fail(res: Response): Promise<never> {
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    // Go's mux answers an unknown route with a plain-text 404: an API from before comments.
    throw new CommentError(res.status, res.status === 404 ? 'unsupported' : 'http', res.statusText);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  throw new CommentError(res.status, body.code ?? 'http', body.error ?? res.statusText);
}

async function answer(res: Response): Promise<Fetched> {
  if (!res.ok) return fail(res);
  return {
    doc: CommentsDoc.parse(await res.json()),
    role: readRole(res),
    etag: res.headers.get('ETag'),
  };
}

/** The comments; `null` for a 304 against `etag` (with the role it carried). */
export async function fetchComments(
  id: string,
  etag: string | null,
  signal?: AbortSignal,
): Promise<Fetched | { notModified: true; role: Role | null }> {
  const headers: Record<string, string> = { ...authHeaders(id), 'X-Comment-Author': authorKey() };
  if (etag) headers['If-None-Match'] = etag;
  const res = await fetch(url(id), { headers, cache: 'no-store', ...(signal ? { signal } : {}) });
  if (res.status === 304) return { notModified: true, role: readRole(res) };
  return answer(res);
}

async function write(id: string, method: string, rest: string, body?: unknown): Promise<Fetched> {
  let res: Response;
  try {
    res = await fetch(url(id, rest), {
      method,
      headers: {
        ...authHeaders(id),
        'X-Comment-Author': authorKey(),
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new CommentError(0, 'network', ERROR_COPY.network ?? '');
  }
  return answer(res);
}

export const api = {
  addThread: (
    id: string,
    b: { id: string; messageId: string; anchor: CommentAnchor; name: string; text: string },
  ) => write(id, 'POST', '', b),
  reply: (id: string, thread: string, b: { id: string; name: string; text: string }) =>
    write(id, 'POST', `/${encodeURIComponent(thread)}/replies`, b),
  resolve: (id: string, thread: string, resolved: boolean, name: string) =>
    write(
      id,
      'PATCH',
      `/${encodeURIComponent(thread)}`,
      resolved ? { resolved, name } : { resolved },
    ),
  deleteThread: (id: string, thread: string) =>
    write(id, 'DELETE', `/${encodeURIComponent(thread)}`),
  deleteReply: (id: string, thread: string, msg: string) =>
    write(id, 'DELETE', `/${encodeURIComponent(thread)}/replies/${encodeURIComponent(msg)}`),
  deleteResolved: (id: string) => write(id, 'DELETE', '?resolved=true'),
  setSetting: (id: string, setting: CommentSetting) => write(id, 'PATCH', '', { setting }),
};
