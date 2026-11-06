import { z } from 'zod';
import { Vec2 } from './schema';

/**
 * Comments on the plan: the zod mirror of the API's comments document (Go package
 * apps/api/internal/comments), checked against its fixture `testdata/comments.json`.
 * Comments are their own API resource, never part of the project document or its undo.
 */

/** Limits the server enforces (runes, after trimming). */
export const COMMENT_MAX_TEXT = 1000;
export const COMMENT_MAX_NAME = 40;
export const COMMENT_MAX_LABEL = 80;
export const COMMENT_MAX_THREAD_MESSAGES = 50;
export const COMMENT_MAX_MESSAGES = 300;

/** Who may comment besides the owner: anyone with a link, the edit link only, or no one. */
export const CommentSetting = z.enum(['all', 'edit', 'off']);
export type CommentSetting = z.infer<typeof CommentSetting>;

/** The poster's role when they posted, stamped by the server. */
export const CommentRole = z.enum(['owner', 'editor', 'viewer', 'open']);
export type CommentRole = z.infer<typeof CommentRole>;

/**
 * What a pin is attached to. `item.rel` is the offset in the item's own frame; `wall.t`
 * runs from vertex a (0) to b (1) and `off` is the distance across it.
 */
export const CommentTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('item'), id: z.string(), rel: Vec2 }),
  z.object({ kind: z.literal('wall'), id: z.string(), t: z.number(), off: z.number() }),
  z.object({ kind: z.literal('opening'), id: z.string() }),
  z.object({ kind: z.literal('point'), id: z.string() }),
  z.object({ kind: z.literal('room'), id: z.string() }),
]);
export type CommentTarget = z.infer<typeof CommentTarget>;

export const CommentVariant = z.enum(['before', 'after']);
export type CommentVariant = z.infer<typeof CommentVariant>;

export const CommentAnchor = z.object({
  /** The base level's id (never the `~after` copy's). */
  levelId: z.string(),
  variant: CommentVariant,
  /** Where it was placed, in metres: the fallback position when the target is gone. */
  at: Vec2,
  /** No target: a plain spot on the plan. */
  target: CommentTarget.optional(),
  /** Made when placed, e.g. "Fridge" or "Wall · Kitchen / Living". */
  label: z.string(),
});
export type CommentAnchor = z.infer<typeof CommentAnchor>;

export const CommentMessage = z.object({
  id: z.string(),
  name: z.string(),
  role: CommentRole,
  text: z.string(),
  /** The server's clock, ISO 8601 in UTC. */
  at: z.string().datetime(),
  /** Posted from this browser (its author key). */
  mine: z.boolean(),
});
export type CommentMessage = z.infer<typeof CommentMessage>;

export const CommentThread = z.object({
  id: z.string(),
  anchor: CommentAnchor,
  resolved: z.object({ name: z.string(), at: z.string().datetime() }).nullable(),
  /** The first message is the comment itself; the rest are replies. */
  messages: z.array(CommentMessage).min(1),
});
export type CommentThread = z.infer<typeof CommentThread>;

/** GET /projects/{id}/comments, and every comment write's response. */
export const CommentsDoc = z.object({
  version: z.number().int().nonnegative(),
  setting: CommentSetting,
  /** In creation order. */
  threads: z.array(CommentThread),
});
export type CommentsDoc = z.infer<typeof CommentsDoc>;

/** The document of a project nobody has commented on yet. */
export const EMPTY_COMMENTS: CommentsDoc = { version: 0, setting: 'all', threads: [] };
