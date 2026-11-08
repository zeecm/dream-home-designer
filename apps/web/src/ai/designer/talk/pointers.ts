import {
  type Change,
  type Kept,
  type Level,
  MAX_POINTERS,
  type Pointer,
  type Project,
  type Vec2,
  entranceDoor,
  furnitureKind,
  keptHolds,
  pieceName,
  pointName,
  pointPosition,
  roomIdAt,
  roomsBeside,
  whereOf,
} from '@dhd/core';
import { create } from 'zustand';
import { useEditor } from '../../../editor';
import { useStore } from '../../../store';
import { useDesigner } from '../state';
import { act, designLevelId, newId, nowIso, say, talkLevel, useTalk } from './useTalk';
import { useProposalView } from './view';

/**
 * Pointing at the plan (slice 3a §1, tech §6.1): a chip for a piece, a door or window, a point,
 * a wall, a room or a spot, made on the version the plan shows or on your plan. Its words are
 * worked out once, when it is made; whether its target is still there is looked up on show.
 */

export type TargetKind = Pointer['kind'];
export interface Target {
  kind: TargetKind;
  /** The target's id (none for a spot). */
  id: string | null;
  /** A spot, or where the target is. */
  at: Vec2;
}

const doc = () => useStore.getState().editor.doc;
const cap = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/** The level the plan shows now: the version previewed, else the level designed. */
export function shownLevel(): { level: Level; version: Pointer['version'] } | null {
  const pv = useEditor.getState().preview;
  const view = useProposalView.getState();
  if (pv && pv.side === 'version' && !pv.start) {
    const [proposalId, letter] = view.card?.split(':') ?? [];
    if (proposalId && letter && !proposalId.startsWith('d'))
      return {
        // What the plan shows (the version, with what is ticked): its ids are what is hit.
        level: pv.level,
        version: { kind: 'option', proposalId, letter, title: pv.label.slice(0, 8) },
      };
    // A version from the list (d:) or none from the conversation: not something to point at
    // (never "your plan", which isn't what is shown).
    return null;
  }
  const level = talkLevel();
  return level ? { level, version: { kind: 'plan' } } : null;
}

/**
 * The level that has a target: the one shown, else the version's own result or the plan (a
 * piece drawn from the card's result while the merged level catches up).
 */
export function levelWith(level: Level, t: Target): Level {
  const id = t.id;
  if ((t.kind !== 'item' && t.kind !== 'point') || !id) return level;
  const has = (l: Level | null | undefined) =>
    !!l && (t.kind === 'item' ? !!l.items[id] : !!l.points?.[id]);
  if (has(level)) return level;
  const target = useProposalView.getState().target;
  if (target && has(target)) return target;
  const plan = talkLevel();
  return plan && has(plan) ? plan : level;
}

const centreOf = (level: Level, t: Target): Vec2 => {
  if (t.kind === 'item' && t.id) {
    const it = level.items[t.id];
    if (it) return { x: it.position.x, y: it.position.z };
  }
  if (t.kind === 'point' && t.id) {
    // A wall point (a socket, an aircon isolator) is where it is on its wall's face.
    const p = level.points?.[t.id];
    const at = p ? pointPosition(level, p)?.at : null;
    if (at) return { ...at };
  }
  return t.at;
};

/** A room's name. */
const roomName = (level: Level, id: string | null) => (id ? (level.rooms[id]?.name ?? null) : null);

/** The change of the version on the plan that a piece is in, if any. */
const changeOf = (changes: Change[], id: string) =>
  changes.find((c) => c.items.target.includes(id) || c.items.now.includes(id)) ?? null;

/** Its state in the version shown ("added in V4"), or on your plan. */
function stateOf(t: Target, title: string | null): string {
  if (!title) return 'in your plan';
  const view = useProposalView.getState();
  if (t.kind !== 'item' || !t.id) return `in ${title}`;
  const c = changeOf(view.changes, t.id);
  if (!c) return `in your plan, not changed in ${title}`;
  const verb =
    c.verb === 'add'
      ? 'added'
      : c.verb === 'remove'
        ? 'removed'
        : c.verb === 'move'
          ? 'moved'
          : c.verb === 'turn'
            ? 'turned'
            : c.verb === 'swap'
              ? 'swapped'
              : 'changed';
  return `${verb} in ${title}`;
}

/** The words for a target: its chip label, room and where it is. */
export function describe(
  level: Level,
  t: Target,
): { label: string; room: string | null; where: string } {
  const at = centreOf(level, t);
  const roomId = t.kind === 'room' ? t.id : roomIdAt(level, at);
  const room = roomName(level, roomId);
  switch (t.kind) {
    case 'item': {
      const it = t.id ? level.items[t.id] : undefined;
      return {
        label: `${cap(pieceName(it))}${room ? ` · ${room}` : ''}`,
        room,
        where: it ? whereOf(level, it) : '',
      };
    }
    case 'opening': {
      const o = t.id ? level.openings[t.id] : undefined;
      const main = !!t.id && t.id === entranceDoor(level);
      const sides = o
        ? roomsBeside(level, o.wallId)
            .map((r) => roomName(level, r))
            .filter((r): r is string => !!r)
        : [];
      const label = main
        ? 'Main door'
        : `${o?.kind === 'window' ? 'Window' : 'Door'}${sides[0] ? ` · ${sides[0]}` : ''}`;
      return {
        label,
        room: sides[0] ?? null,
        where: sides.length > 1 ? `between ${sides.join(' and ')}` : '',
      };
    }
    case 'wall': {
      const sides = t.id
        ? roomsBeside(level, t.id)
            .map((r) => roomName(level, r))
            .filter((r): r is string => !!r)
        : [];
      return {
        label: `Wall · ${sides.length ? sides.join(' / ') : 'outside'}`,
        room: sides[0] ?? null,
        where: '',
      };
    }
    case 'point': {
      const p = t.id ? level.points?.[t.id] : undefined;
      const what = p ? cap(pointName(p)) : 'Point';
      return { label: `${what}${room ? ` · ${room}` : ''}`, room, where: '' };
    }
    case 'room':
      return { label: room ?? 'Room', room, where: '' };
    case 'spot': {
      // Described by what is nearest: "a spot in Living and dining, 1.2 m from the sofa".
      let near: { name: string; d: number } | null = null;
      for (const it of Object.values(level.items)) {
        const k = furnitureKind(it.assetId);
        if (!k || k.ceiling) continue;
        const d = Math.hypot(it.position.x - at.x, it.position.z - at.y);
        if (roomIdAt(level, { x: it.position.x, y: it.position.z }) !== roomId) continue;
        if (!near || d < near.d) near = { name: pieceName(it), d };
      }
      return {
        label: `Here · ${room ?? 'the plan'}`,
        room,
        where: `a spot in ${room ?? 'the plan'}${near ? `, ${near.d.toFixed(1)} m from the ${near.name}` : ''}`,
      };
    }
  }
}

/** A pointer at a target on what the plan shows now. */
export function makePointer(t: Target): Pointer | null {
  const shown = shownLevel();
  if (!shown) return null;
  const { version } = shown;
  const level = levelWith(shown.level, t);
  const words = describe(level, t);
  const levels = doc().levels;
  const levelId = designLevelId();
  const levelName = levels.length > 1 ? (levels.find((l) => l.id === levelId)?.name ?? null) : null;
  const title = version.kind === 'option' ? version.title : null;
  const label = `${words.label}${levelName ? ` · ${levelName}` : ''}${title ? ` · ${title}` : ''}`;
  return {
    id: newId('ptr'),
    kind: t.kind,
    targetId: t.id,
    at: centreOf(level, t),
    levelId,
    // Cut to the record's limits, so a long room or level name never makes it unreadable.
    levelName: levelName?.slice(0, 60) ?? null,
    version,
    // Cut with "…" when longer than the record holds.
    label: label.length > 80 ? `${label.slice(0, 79)}…` : label,
    room: words.room?.slice(0, 80) ?? null,
    where: words.where.slice(0, 120),
    state: stateOf(t, title).slice(0, 80),
  };
}

/** The composer's hint and the chip rung for a second, said by adding (UX §1.2). */
export const usePointerUi = create<{ hint: string | null; ring: string | null }>(() => ({
  hint: null,
  ring: null,
}));
let hintTimer: ReturnType<typeof setTimeout> | null = null;
function hint(text: string, ms = 4000) {
  if (hintTimer) clearTimeout(hintTimer);
  usePointerUi.setState({ hint: text });
  hintTimer = setTimeout(() => usePointerUi.setState({ hint: null }), ms);
}

const sameTarget = (a: Pointer, b: Pointer) =>
  a.kind === b.kind &&
  a.targetId === b.targetId &&
  (a.kind !== 'spot' || (a.at.x === b.at.x && a.at.y === b.at.y)) &&
  JSON.stringify(a.version) === JSON.stringify(b.version);

/** The name a hint uses ("the sofa", "Here"). */
const shortName = (p: Pointer) => p.label.split(' · ')[0] ?? p.label;

/**
 * Adds a chip to the composer: a second of the same target rings the one there, a sixth is
 * refused with the reason; the live region says what happened. Returns whether it was added.
 */
export async function addPointer(p: Pointer): Promise<boolean> {
  const conv = useTalk.getState().conv;
  if (!conv) return false;
  const same = conv.draftPointers.find((x) => sameTarget(x, p));
  if (same) {
    usePointerUi.setState({ ring: same.id });
    setTimeout(() => usePointerUi.setState({ ring: null }), 1000);
    hint('Already in your message.');
    return false;
  }
  if (conv.draftPointers.length >= MAX_POINTERS) {
    // The hint is a live region, so it is read once (no say()).
    hint(`Up to ${MAX_POINTERS} at a time. Remove one to add ${shortName(p)}.`);
    return false;
  }
  const next = await act({ type: 'pointerAdd', pointer: p });
  const n = next?.draftPointers.length ?? 0;
  say(
    p.kind === 'spot'
      ? `Here, in ${p.room ?? 'the plan'}, added to your message.`
      : `${shortName(p)} added to your message, ${n} of ${MAX_POINTERS}.`,
  );
  return true;
}

/** A second long-press near a Here pin moves it (within 1 m, same room), else adds one. */
export async function addSpot(p: Pointer): Promise<boolean> {
  const conv = useTalk.getState().conv;
  const near = conv?.draftPointers.find(
    (x) =>
      x.kind === 'spot' &&
      x.room === p.room &&
      Math.hypot(x.at.x - p.at.x, x.at.y - p.at.y) < 1 &&
      JSON.stringify(x.version) === JSON.stringify(p.version),
  );
  if (near) await act({ type: 'pointerRemove', id: near.id });
  return addPointer(p);
}

/** A chip taken off by its ×: what the last refusal said no longer holds. */
export const removePointer = (id: string) => {
  if (hintTimer) clearTimeout(hintTimer);
  usePointerUi.setState({ hint: null });
  return act({ type: 'pointerRemove', id });
};

/** Whether a pointer's target is still there (UX §1.3: "(gone)"; never stored). */
export function pointerGone(p: Pointer, project: Project = doc()): boolean {
  if (p.version.kind === 'option') {
    const v = p.version;
    const pr = useTalk.getState().proposals.find((x) => x.id === v.proposalId);
    return !pr?.options.some((o) => o.letter === v.letter);
  }
  if (p.kind === 'spot' || !p.targetId) return false;
  const level = project.levels.find((l) => l.id === p.levelId);
  const after = project.renovation?.levels.find((l) => l.id === p.levelId);
  const has = (l: Level | undefined) => {
    if (!l || !p.targetId) return false;
    switch (p.kind) {
      case 'item':
        return !!l.items[p.targetId];
      case 'opening':
        return !!l.openings[p.targetId];
      case 'wall':
        return !!l.walls[p.targetId];
      case 'room':
        return !!l.rooms[p.targetId];
      case 'point':
        return !!l.points?.[p.targetId];
      default:
        return true;
    }
  };
  return !has(after) && !has(level);
}

/** What the plan lights: a pointer's target (or where it was), for a moment. */
export const usePointing = create<{ pointer: Pointer | null; gone: boolean; until: number }>(
  () => ({ pointer: null, gone: false, until: 0 }),
);
let litTimer: ReturnType<typeof setTimeout> | null = null;
/** Lights a pointer's target (hover: until let go; a tap or click: 2 s). */
export function lightPointer(p: Pointer | null, ms = 0) {
  if (litTimer) clearTimeout(litTimer);
  usePointing.setState({
    pointer: p,
    gone: p ? pointerGone(p) : false,
    until: ms ? Date.now() + ms : 0,
  });
  if (p && ms) litTimer = setTimeout(() => usePointing.setState({ pointer: null }), ms);
}

/**
 * Shows a pointer: its version goes on the plan if it isn't (free), then its target is lit;
 * a gone one shows "Was here" (UX §1.3).
 */
export function showPointer(p: Pointer) {
  if (p.version.kind === 'option' && !pointerGone(p)) {
    const key = `${p.version.proposalId}:${p.version.letter}`;
    // Back on the plan, as its card's Show on plan does (also after Back to my plan, when
    // it is still the card shown but the plan isn't showing it).
    if (useTalk.getState().shown !== key) useTalk.setState({ shown: key });
    if (!useDesigner.getState().previewing) useDesigner.setState({ previewing: true });
  }
  lightPointer(p, 2000);
}

/** A kept piece from a target (Keep this): a plan piece by id, a version's by kind and pose. */
export function keptFrom(t: Target): Kept | null {
  const shown = shownLevel();
  if (!shown || t.kind !== 'item' || !t.id) return null;
  const it = levelWith(shown.level, t).items[t.id];
  if (!it) return null;
  const inPlan = !!talkLevel()?.items[t.id];
  return {
    id: newId('kept'),
    itemId: inPlan ? it.id : null,
    assetId: it.assetId,
    pose: { x: it.position.x, y: it.position.z, rot: it.rotationY },
    scale: { ...it.scale },
    from: shown.version.kind === 'option' ? shown.version.title : 'plan',
    levelId: designLevelId(),
    at: nowIso(),
  };
}

/** Keep this: the piece kept, with its app line (Undo while it is the newest). */
export async function keepTarget(t: Target): Promise<boolean> {
  const k = keptFrom(t);
  const shown = shownLevel();
  if (!k || !shown) return false;
  const name = pieceName(levelWith(shown.level, t).items[t.id ?? '']);
  const text =
    k.from === 'plan'
      ? `Kept: the ${name} where it is. Later ideas leave it there.`
      : `Kept: the ${name} where it is in ${k.from}. Later ideas leave it there.`;
  const next = await act({ type: 'keepItem', kept: k, id: newId('turn'), at: nowIso(), text });
  // Refused (already kept, or 30 kept): nothing is said as if it were.
  const done = !!next?.kept.some((x) => x.id === k.id);
  if (done) say(text);
  return done;
}

/** Let the designer move it: the kept piece let go, said in the log. */
export async function unkeep(k: Kept) {
  const kind = furnitureKind(k.assetId);
  const text = `You let the designer move the ${kind ? pieceName({ assetId: k.assetId }) : 'piece'} again.`;
  await act({ type: 'unkeepItem', keptId: k.id, id: newId('turn'), at: nowIso(), text });
  say(text);
}

/** The kept piece a target is, if any. */
export function keptOf(t: Target): Kept | null {
  const conv = useTalk.getState().conv;
  const shown = shownLevel();
  if (!conv || !shown || t.kind !== 'item' || !t.id) return null;
  const it = levelWith(shown.level, t).items[t.id];
  if (!it) return null;
  return conv.kept.find((k) => (k.itemId ? k.itemId === it.id : keptHolds(k, it))) ?? null;
}
