import { z } from 'zod';
import { ELEC_KINDS, pointPosition, pointRoom } from './electrical';
import { furnitureKind } from './furniture';
import { labelPoint, pointInPolygon } from './geometry';
import { AFTER_SUFFIX, variantLevels } from './levels';
import { roomShapes } from './rooms';
import { type Level, type Project, Vec2, wallFaces } from './schema';

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
  /**
   * Random, from the first comment: a plan deleted and made again with the same id starts
   * at version 0 again under another epoch.
   */
  epoch: z.string().optional(),
  setting: CommentSetting,
  /** In creation order. */
  threads: z.array(CommentThread),
});
export type CommentsDoc = z.infer<typeof CommentsDoc>;

/** The document of a project nobody has commented on yet. */
export const EMPTY_COMMENTS: CommentsDoc = { version: 0, setting: 'all', threads: [] };

// ------------------------------------------------------------------------- anchors

/** What a tap hit on the plan (the Select tool's hit), or nothing. */
export type CommentHit = { kind: string; id: string } | null;

const OPENING_NAMES = { door: 'Door', window: 'Window', passage: 'Opening' } as const;

/**
 * A label as the server keeps it: control and format characters dropped (the zero-width
 * joiner of emoji stays), at most COMMENT_MAX_LABEL characters (code points, as the server
 * counts them).
 */
export function commentLabel(s: string): string {
  const clean = s.replace(/[\p{Cc}\u2028\u2029]|(?!\u200d)\p{Cf}/gu, '').trim();
  const chars = Array.from(clean);
  const out =
    chars.length > COMMENT_MAX_LABEL ? `${chars.slice(0, COMMENT_MAX_LABEL - 1).join('')}…` : clean;
  return out || 'Spot on the plan';
}

const clip = commentLabel;

/** The room a point is in (outside its holes), if any. */
function roomAt(level: Level, p: Vec2) {
  const shapes = roomShapes(level);
  return Object.values(level.rooms).find((r) => {
    const s = shapes.get(r.id);
    return !!s && pointInPolygon(p, s.outer) && !s.holes.some((h) => pointInPolygon(p, h));
  });
}

interface WallLine {
  a: Vec2;
  d: Vec2;
  /** Left of a→b: d turned +90°. */
  n: Vec2;
  length: number;
}

function wallLine(level: Level, id: string): WallLine | null {
  const w = level.walls[id];
  const a = w && level.vertices[w.a];
  const b = w && level.vertices[w.b];
  if (!a || !b) return null;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < 1e-9) return null;
  const d = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  return { a: { x: a.x, y: a.y }, d, n: { x: -d.y, y: d.x }, length };
}

const along = (l: WallLine, u: number, off: number): Vec2 => ({
  x: l.a.x + l.d.x * u + l.n.x * off,
  y: l.a.y + l.d.y * u + l.n.y * off,
});

/** The rooms either side of a wall at distance `u` along it, e.g. Kitchen and Living. */
function wallRooms(level: Level, id: string, l: WallLine, u: number): string[] {
  const w = level.walls[id];
  if (!w) return [];
  const faces = wallFaces(w);
  const names: string[] = [];
  for (const off of [faces.left + 0.05, -(faces.right + 0.05)]) {
    const r = roomAt(level, along(l, u, off));
    if (r && !names.includes(r.name)) names.push(r.name);
  }
  return names;
}

/**
 * What a comment placed at `at` attaches to, from what the tap hit: the topmost item, an
 * electrical point, an opening, a wall, a room, else a plain spot. A tap on nothing in
 * particular inside a room attaches to the room. The label is made now and kept.
 */
export function anchorFor(
  level: Level,
  at: Vec2,
  hit: CommentHit,
): Pick<CommentAnchor, 'at' | 'target' | 'label'> {
  const spot = { x: at.x, y: at.y };
  if (hit?.kind === 'item') {
    const it = level.items[hit.id];
    if (it) {
      const dx = at.x - it.position.x;
      const dy = at.y - it.position.z;
      const c = Math.cos(it.rotationY);
      const s = Math.sin(it.rotationY);
      // The inverse of the footprint's turn: local x is (c, s), local y (-s, c).
      const rel = { x: dx * c + dy * s, y: -dx * s + dy * c };
      return {
        at: spot,
        target: { kind: 'item', id: it.id, rel },
        label: clip(furnitureKind(it.assetId)?.name ?? 'Furniture'),
      };
    }
  }
  if (hit?.kind === 'point') {
    const p = level.points[hit.id];
    if (p) {
      const room = pointRoom(level, p);
      const name = ELEC_KINDS[p.kind].short;
      const roomName = room ? level.rooms[room]?.name : undefined;
      return {
        at: spot,
        target: { kind: 'point', id: p.id },
        label: clip(roomName ? `${name} · ${roomName}` : name),
      };
    }
  }
  if (hit?.kind === 'opening') {
    const o = level.openings[hit.id];
    const l = o && wallLine(level, o.wallId);
    if (o && l) {
      const rooms = wallRooms(level, o.wallId, l, o.t * l.length);
      const name = OPENING_NAMES[o.kind];
      return {
        at: spot,
        target: { kind: 'opening', id: o.id },
        label: clip(rooms.length ? `${name} · ${rooms.join(' / ')}` : name),
      };
    }
  }
  if (hit?.kind === 'wall') {
    const l = wallLine(level, hit.id);
    if (l) {
      const rx = at.x - l.a.x;
      const ry = at.y - l.a.y;
      const u = Math.min(l.length, Math.max(0, rx * l.d.x + ry * l.d.y));
      const off = rx * l.n.x + ry * l.n.y;
      const rooms = wallRooms(level, hit.id, l, u);
      const name = level.walls[hit.id]?.kind === 'boundary' ? 'Room edge' : 'Wall';
      return {
        at: spot,
        target: { kind: 'wall', id: hit.id, t: u / l.length, off },
        label: clip(rooms.length ? `${name} · ${rooms.join(' / ')}` : name),
      };
    }
  }
  const room = (hit?.kind === 'room' && level.rooms[hit.id]) || roomAt(level, at);
  if (room) return { at: spot, target: { kind: 'room', id: room.id }, label: clip(room.name) };
  return { at: spot, label: 'Spot on the plan' };
}

/** Why a pin can't sit on what it was attached to. */
export type AnchorGone = 'removed' | 'removed-in-renovation' | 'no-renovation' | 'no-level';

export interface AnchorPlace {
  /** Where the pin draws, in plan metres. */
  at: Vec2;
  state: 'on' | 'gone';
  reason?: AnchorGone;
}

const GONE_THING: Record<CommentTarget['kind'], string> = {
  item: 'piece',
  wall: 'wall',
  opening: 'opening',
  point: 'point',
  room: 'room',
};

/** Copy for a pin whose target is gone. */
export function goneText(reason: AnchorGone, anchor: CommentAnchor): string {
  const t = anchor.target;
  switch (reason) {
    case 'removed':
      if (t?.kind === 'room') return 'This room is no longer on the plan.';
      return t?.kind === 'item'
        ? `The ${anchor.label.toLowerCase()} was removed. The pin stays where it was.`
        : `This ${t ? GONE_THING[t.kind] : 'spot'} was removed. The pin stays where it was.`;
    case 'removed-in-renovation':
      return t?.kind === 'wall'
        ? 'This wall is hacked in the renovation.'
        : `This ${t ? GONE_THING[t.kind] : 'spot'} is removed in the renovation.`;
    case 'no-renovation':
      return 'The renovation was deleted.';
    case 'no-level':
      return 'This floor is no longer on the plan.';
  }
}

const itemAt = (level: Level, id: string, rel: Vec2): Vec2 | null => {
  const it = level.items[id];
  if (!it) return null;
  const c = Math.cos(it.rotationY);
  const s = Math.sin(it.rotationY);
  return { x: it.position.x + rel.x * c - rel.y * s, y: it.position.z + rel.x * s + rel.y * c };
};

/** Where the target is on a level now, or null if the level doesn't have it. */
function targetAt(level: Level, anchor: CommentAnchor): Vec2 | null {
  const t = anchor.target;
  if (!t) return { x: anchor.at.x, y: anchor.at.y };
  switch (t.kind) {
    case 'item':
      return itemAt(level, t.id, t.rel);
    case 'wall': {
      const l = wallLine(level, t.id);
      const w = level.walls[t.id];
      if (!l || !w) return null;
      const faces = wallFaces(w);
      const off = Math.min(faces.left, Math.max(-faces.right, t.off));
      return along(l, Math.min(1, Math.max(0, t.t)) * l.length, off);
    }
    case 'opening': {
      const o = level.openings[t.id];
      const l = o && wallLine(level, o.wallId);
      return o && l ? along(l, o.t * l.length, 0) : null;
    }
    case 'point': {
      const p = level.points[t.id];
      return (p && pointPosition(level, p)?.at) ?? null;
    }
    case 'room': {
      const s = roomShapes(level).get(t.id);
      if (!s) return null;
      const inside =
        pointInPolygon(anchor.at, s.outer) && !s.holes.some((h) => pointInPolygon(anchor.at, h));
      return inside ? { x: anchor.at.x, y: anchor.at.y } : labelPoint(s.outer);
    }
  }
}

/**
 * Where a pin draws on the project as it is now: on its target (following a piece that
 * moved or turned, a wall that grew), or where it was placed when the target is gone.
 */
export function anchorPosition(
  project: Pick<Project, 'levels' | 'renovation'>,
  anchor: CommentAnchor,
): AnchorPlace {
  const fallback = { x: anchor.at.x, y: anchor.at.y };
  if (anchor.variant === 'after' && !project.renovation) {
    return { at: fallback, state: 'gone', reason: 'no-renovation' };
  }
  const level = variantLevels(project, anchor.variant).find(
    (l) => l.id === anchor.levelId || l.id === `${anchor.levelId}${AFTER_SUFFIX}`,
  );
  if (!level) return { at: fallback, state: 'gone', reason: 'no-level' };
  const at = targetAt(level, anchor);
  if (at) return { at, state: 'on' };
  // Gone from the renovation but still in the flat as it is: hacked, not deleted.
  const before = project.levels.find((l) => l.id === anchor.levelId);
  const inBefore = anchor.variant === 'after' && !!before && targetAt(before, anchor) !== null;
  return { at: fallback, state: 'gone', reason: inBefore ? 'removed-in-renovation' : 'removed' };
}

// ------------------------------------------------------------------------- lists

/** When this browser last looked: at everything (the panel) and at single threads (ms). */
export interface CommentsSeen {
  all: number;
  threads: Record<string, number>;
}

export interface ThreadItem {
  thread: CommentThread;
  /** The last message's time (ms). */
  lastAt: number;
  /** A message by someone else is newer than when this browser last looked. */
  unread: boolean;
}

const ms = (iso: string) => Date.parse(iso);

/**
 * The comments as the panel lists them: open threads, last activity first; resolved ones,
 * most recently resolved first. Your own messages are never unread.
 */
export function threadsView(
  doc: CommentsDoc,
  seen: CommentsSeen,
): { open: ThreadItem[]; resolved: ThreadItem[]; unread: number } {
  const items = doc.threads.map((thread): ThreadItem => {
    const since = Math.max(seen.all, seen.threads[thread.id] ?? 0);
    const lastAt = Math.max(...thread.messages.map((m) => ms(m.at)));
    const unread = thread.messages.some((m) => !m.mine && ms(m.at) > since);
    return { thread, lastAt, unread };
  });
  const open = items.filter((i) => !i.thread.resolved).sort((a, b) => b.lastAt - a.lastAt);
  const resolvedAt = (i: ThreadItem) => (i.thread.resolved ? ms(i.thread.resolved.at) : 0);
  const resolved = items
    .filter((i) => !!i.thread.resolved)
    .sort((a, b) => resolvedAt(b) - resolvedAt(a));
  return { open, resolved, unread: open.filter((i) => i.unread).length };
}

/**
 * The open comments as plain text, for a chat or the ID's quotation meeting: one block per
 * thread, its place (and Before or After, when there is a renovation), then "Name: text".
 */
export function commentsText(doc: CommentsDoc, renovation: boolean): string {
  return doc.threads
    .filter((t) => !t.resolved)
    .map((t) => {
      const variant = t.anchor.variant === 'after' ? 'After' : 'Before';
      const head = renovation ? `${t.anchor.label} (${variant})` : t.anchor.label;
      return [head, ...t.messages.map((m) => `${m.name}: ${m.text}`)].join('\n');
    })
    .join('\n\n');
}
