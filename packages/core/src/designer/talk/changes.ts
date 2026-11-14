import { type Draft, current, isDraft } from 'immer';
import { type CostEstimate, type Rates, TYPICAL_RATES, costEstimate } from '../../cost';
import { furnitureKind, itemSize } from '../../furniture';
import type { Command } from '../../history';
import { AFTER_SUFFIX, draftLevel } from '../../levels';
import type { Item, Level, Vec2 } from '../../schema';
import { applyLevel } from '../../topology';
import { finishRooms, takeWalls, wallPointAt } from '../accept';
import { dependsOnWalls } from '../accept';
import { designChecks } from '../checks';
import { WET } from '../locks';
import { nameOf } from '../place';
import { RELATIONS, type Role, roleOf } from '../principles';
import type { DesignResult, ResultCheck } from '../result';
import type { Kept } from '../rules/kept';
import type { Rule } from '../rules/schema';
import type { DesignBrief, DesignInput, DesignItem } from '../schema';
import { BATHROOMS } from '../schema';
import { roomIdAt, roomsBeside, spacesOf } from '../spaces';
import { levelFingerprint, settled, stableJson } from '../util';

/**
 * A proposal as changes the household can tick one by one (UX §6.3): what it adds, moves,
 * turns, swaps or removes in each space, its paint and floors, its electrical points, and its
 * walls and doors (one change in this slice). Each change is said in the app's words, with
 * where it goes in words the person knows (never coordinates) and the designer's reason.
 * Accepting some of them merges just those into the plan as it is now.
 */

export type ChangeVerb =
  | 'add'
  | 'move'
  | 'turn'
  | 'swap'
  | 'remove'
  | 'walls'
  | 'rename'
  | 'finish'
  | 'electrical';

export interface Change {
  /** Stable for an option: `walls`, `add:id`, `remove:id`, `move:id`, `swap:from>to`, … */
  id: string;
  /** `walls`, or the space's key (rows group under it, walls first, then in plan order). */
  group: string;
  groupName: string;
  verb: ChangeVerb;
  /** The app's sentence: "Add a 3-seat sofa against the Bedroom wall, facing the TV". */
  text: string;
  /** The designer's reason, as stored with the answer. */
  why: string | null;
  /** Pieces it takes out of the plan as it is, and puts in from the proposal (by id). */
  items: { now: string[]; target: string[] };
  /** The walls change's own lines ("Hack the wall between Kitchen and Dry kitchen"). */
  rows: string[];
  /** Its space's outline or doors change with the walls: it can't go in without them. */
  needsWalls: boolean;
  /** Keys of the hard checks the proposal fails because of it. */
  checks: string[];
  /** False when one of its checks is an HDB rule (never accepted anyway). */
  waivable: boolean;
  /** What it is about, for "Left out: the sofa, the armchair". */
  name: string;
}

const MOVE_EPS = 0.01;
const TURN_EPS = 1e-3;
/** A removed and an added piece of the same kind this close are the same piece turned. */
const SAME_SPOT = 0.05;

const centre = (it: Item): Vec2 => ({ x: it.position.x, y: it.position.z });
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const angleDiff = (a: number, b: number) => {
  const d = Math.abs(((a - b) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return Math.min(d, 2 * Math.PI - d);
};
const article = (s: string) => (/^[aeiou]/i.test(s) && !/^(one|uni|use)/i.test(s) ? 'an' : 'a');
/** A piece's name in a sentence: "dining table, 4 seats" reads "dining table (4 seats)". */
export const pieceName = (it: Pick<Item, 'assetId'> | undefined) => {
  const k = it ? furnitureKind(it.assetId) : undefined;
  if (!k) return 'piece';
  const n = nameOf(k);
  const [head, ...rest] = n.split(', ');
  const name = rest.length ? `${head} (${rest.join(', ')})` : n;
  return name.replace(/^tv\b/i, 'TV');
};
const roleOfIt = (it: Item | undefined) => roleOf(it ? furnitureKind(it.assetId) : undefined);

/** Roles that belong to another piece and are said with it ("a dining table, with 4 chairs"). */
const BELONGS: Partial<Record<Role, Role[]>> = {
  'dining-chair': RELATIONS['dining-chair']?.belongs?.of ?? ['dining-table', 'desk'],
  'desk-chair': RELATIONS['desk-chair']?.belongs?.of ?? ['desk'],
  bedside: RELATIONS.bedside?.near?.of ?? ['bed'],
};
const childWords: Partial<Record<Role, [string, string]>> = {
  'dining-chair': ['chair', 'chairs'],
  'desk-chair': ['chair', 'chairs'],
  bedside: ['bedside table', 'bedside tables'],
};

/** Distance from a point to a wall's line segment. */
function toWall(level: Level, wallId: string, p: Vec2): number {
  const w = level.walls[wallId];
  const a = w && level.vertices[w.a];
  const b = w && level.vertices[w.b];
  if (!w || !a || !b) return Number.POSITIVE_INFINITY;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)) - w.thickness / 2;
}

/**
 * Where a piece is, in words: "by the window", "against the Bedroom wall", "against the
 * outside wall"; '' when it stands free (the sentence says what it is near instead).
 */
export function whereOf(level: Level, it: Item): string {
  const kind = furnitureKind(it.assetId);
  const room = roomIdAt(level, centre(it));
  // Lights and rugs aren't against anything.
  if (!kind || !room || kind.ceiling || kind.walkThrough || kind.category === 'Lighting') return '';
  const size = itemSize(it, kind);
  const reach = Math.min(size.w, size.d) / 2 + 0.25;
  let best: { id: string; d: number } | null = null;
  for (const w of Object.values(level.walls)) {
    if (w.kind === 'boundary') continue;
    if (!roomsBeside(level, w.id).includes(room)) continue;
    const d = toWall(level, w.id, centre(it));
    if (d <= reach && (!best || d < best.d)) best = { id: w.id, d };
  }
  if (!best) return '';
  const window = Object.values(level.openings).some(
    (o) => o.wallId === best.id && o.kind === 'window',
  );
  if (window) return 'by the window';
  const [l, r] = roomsBeside(level, best.id);
  const beyond = l === room ? r : l;
  const name = beyond ? level.rooms[beyond]?.name : null;
  return name ? `against the wall by ${name}` : 'against the outside wall';
}

/** The answer's item for a placed piece, by its ref, in the space's answer. */
function answerItem(
  design: Pick<DesignInput, 'spaces'>,
  r: DesignResult,
  itemId: string,
  storedKey: string | null,
): DesignItem | null {
  const ref = r.refs[itemId];
  if (!ref || !storedKey) return null;
  return design.spaces[storedKey]?.design?.items.find((i) => i.ref === ref) ?? null;
}

/** "facing the TV", from the answer's `faces` (another piece's ref, or the window, the door). */
function facing(
  design: Pick<DesignInput, 'spaces'>,
  r: DesignResult,
  item: DesignItem | null,
  storedKey: string | null,
): string {
  const f = item?.faces?.trim();
  if (!f || f === 'room') return '';
  if (f === 'window' || f === 'door') return `facing the ${f}`;
  const other = storedKey ? design.spaces[storedKey]?.design?.items.find((i) => i.ref === f) : null;
  if (!other || !furnitureKind(other.assetId)) return '';
  const name = pieceName(other);
  return `facing the ${name}`;
}

const wallsDiffer = (now: Level, target: Level) => {
  const key = (l: Level) =>
    JSON.stringify([
      Object.keys(l.walls).sort(),
      Object.values(l.walls)
        .map((w) => `${w.id}:${w.a}:${w.b}:${w.build ?? ''}:${w.height ?? ''}`)
        .sort(),
      Object.values(l.openings)
        .map((o) => `${o.id}:${o.wallId}:${o.kind}:${o.width}:${o.t.toFixed(3)}:${o.style ?? ''}`)
        .sort(),
    ]);
  return key(now) !== key(target);
};

/**
 * The changes from `now` (After as it is, or the flat with no renovation) to the proposal's
 * result `r` (worked out on `now`), in the order the card lists them: walls first, then each
 * designed space in plan order. Pieces that didn't change aren't listed. Chairs and bedside
 * tables are said with their table or bed.
 */
export function changeSet(
  now: Level,
  r: DesignResult,
  design: Pick<DesignInput, 'spaces'>,
): Change[] {
  const target = r.level;
  const out: Change[] = [];
  const hard = r.checks.filter((c) => c.hard && !c.already);
  const walls = wallsDiffer(now, target);
  const renamed = Object.values(target.rooms).filter((t) => {
    const n = now.rooms[t.id];
    return n && n.name !== t.name;
  });
  if (walls) {
    // One change in this slice (the walls go in together), said by what it does.
    const rows = r.applied.map((n) => n.text);
    const cs = hard.filter((c) => c.part && !('space' in c.part));
    const one = rows.length === 1 ? rows[0] : null;
    out.push({
      id: 'walls',
      group: 'walls',
      groupName: 'Walls and doors',
      verb: 'walls',
      text:
        one ??
        (rows.length
          ? `${rows.length} changes to walls and doors`
          : 'Change the walls and doors as drawn'),
      why: null,
      items: { now: [], target: [] },
      rows: one ? [] : rows,
      needsWalls: false,
      checks: cs.map((c) => c.key),
      waivable: cs.every((c) => c.waivable),
      name: one ? `the ${one[0]?.toLowerCase()}${one.slice(1)}` : 'the walls and doors',
    });
  }
  // A room the proposal names anew: a row each, taken or left on its own.
  for (const t of renamed) {
    const was = now.rooms[t.id]?.name ?? 'a room';
    out.push({
      id: `rename:${t.id}`,
      group: 'names',
      groupName: 'Room names',
      verb: 'rename',
      text: `Call ${was} “${t.name}”`,
      why: null,
      items: { now: [], target: [] },
      rows: [],
      needsWalls: false,
      checks: [],
      waivable: true,
      name: `the name “${t.name}”`,
    });
  }
  const designed = r.spaces.filter((s) => s.storedKey && ['done', 'copied'].includes(s.status));
  /** The space a piece of `now` is in: by where it stands on the proposal's plan. */
  const spaceOfNow = (it: Item) => {
    const p = centre(it);
    const room = roomIdAt(target, p) ?? roomIdAt(now, p);
    return designed.find((s) => !!room && s.rooms.includes(room)) ?? null;
  };
  const spaceOfTarget = (it: Item) => {
    const room = roomIdAt(target, centre(it));
    return designed.find((s) => !!room && s.rooms.includes(room)) ?? null;
  };
  for (const s of designed) {
    const needsWalls = walls && dependsOnWalls(now, target, s);
    const mine: Change[] = [];
    const before = Object.values(now.items).filter((it) => spaceOfNow(it)?.key === s.key);
    const after = Object.values(target.items).filter((it) => spaceOfTarget(it)?.key === s.key);
    const afterIds = new Set(after.map((it) => it.id));
    const beforeIds = new Set(before.map((it) => it.id));
    const removed = before.filter((it) => !afterIds.has(it.id) && !target.items[it.id]);
    const added = after.filter((it) => !beforeIds.has(it.id) && !now.items[it.id]);
    const why = (id: string) => answerItem(design, r, id, s.storedKey)?.why?.trim() || null;
    const facesOf = (id: string) =>
      facing(design, r, answerItem(design, r, id, s.storedKey), s.storedKey);
    /** A free-standing piece by what it goes with: "in front of the sofa", "by the bed". */
    const nearOf = (id: string) => {
      const ref = answerItem(design, r, id, s.storedKey)?.near?.trim();
      const other = ref
        ? design.spaces[s.storedKey ?? '']?.design?.items.find((i) => i.ref === ref)
        : null;
      if (!other || !furnitureKind(other.assetId)) return '';
      const it = target.items[id];
      return `${roleOfIt(it) === 'coffee-table' ? 'in front of' : 'by'} the ${pieceName(other)}`;
    };
    const make = (
      verb: ChangeVerb,
      id: string,
      text: string,
      items: { now: string[]; target: string[] },
      reason: string | null,
      name: string,
    ): Change => ({
      id,
      group: s.key,
      groupName: s.name,
      verb,
      text,
      why: reason,
      items,
      rows: [],
      needsWalls,
      checks: [],
      waivable: true,
      name,
    });
    // The same piece, moved or turned.
    for (const it of after) {
      const was = now.items[it.id];
      if (!was) continue;
      const moved = dist(centre(was), centre(it)) > MOVE_EPS;
      const turned = angleDiff(was.rotationY, it.rotationY) > TURN_EPS;
      if (!moved && !turned) continue;
      const name = pieceName(it);
      const where = whereOf(target, it);
      const face = facesOf(it.id);
      mine.push(
        make(
          moved ? 'move' : 'turn',
          `${moved ? 'move' : 'turn'}:${it.id}`,
          moved
            ? `Move the ${name}${where ? ` ${where.replace(/^against/, 'to')}` : ''}${face ? `, ${face}` : ''}`
            : `Turn the ${name}${face ? ` to face ${face.slice('facing '.length)}` : ''}`,
          { now: [it.id], target: [it.id] },
          why(it.id),
          `the ${name}`,
        ),
      );
    }
    // A piece taken out and one of the same kind put in: moved (or turned), else swapped.
    const pool = [...added];
    const left: Item[] = [];
    for (const old of removed) {
      const same = pool
        .filter((a) => a.assetId === old.assetId)
        .sort((p, q) => dist(centre(old), centre(p)) - dist(centre(old), centre(q)))[0];
      const like =
        same ??
        pool
          .filter((a) => roleOfIt(a) === roleOfIt(old) && roleOfIt(old) !== 'other')
          .sort((p, q) => dist(centre(old), centre(p)) - dist(centre(old), centre(q)))[0];
      if (!like) {
        left.push(old);
        continue;
      }
      pool.splice(pool.indexOf(like), 1);
      const name = pieceName(like);
      const ids = { now: [old.id], target: [like.id] };
      // The same piece where it already is, facing the same way (0 and 2π alike): no change.
      // A room proposed again after a full accept puts every piece back where it is.
      if (
        same &&
        dist(centre(old), centre(like)) <= MOVE_EPS &&
        angleDiff(old.rotationY, like.rotationY) <= TURN_EPS
      )
        continue;
      if (same) {
        const turn =
          dist(centre(old), centre(like)) <= SAME_SPOT &&
          angleDiff(old.rotationY, like.rotationY) > TURN_EPS;
        const where = whereOf(target, like);
        const face = facesOf(like.id);
        mine.push(
          make(
            turn ? 'turn' : 'move',
            `${turn ? 'turn' : 'move'}:${old.id}>${like.id}`,
            turn
              ? `Turn the ${name}${face ? ` to face ${face.slice('facing '.length)}` : ''}`
              : `Move the ${name}${where ? ` ${where.replace(/^against/, 'to')}` : ''}${face ? `, ${face}` : ''}`,
            ids,
            why(like.id),
            `the ${name}`,
          ),
        );
      } else {
        const was = pieceName(old);
        mine.push(
          make(
            'swap',
            `swap:${old.id}>${like.id}`,
            `Swap the ${was} for ${article(name)} ${name}`,
            ids,
            why(like.id),
            `the ${name}`,
          ),
        );
      }
    }
    for (const it of pool) {
      const name = pieceName(it);
      const where = whereOf(target, it);
      const face = facesOf(it.id);
      const tail = [where || nearOf(it.id), face].filter(Boolean).join(', ');
      mine.push(
        make(
          'add',
          `add:${it.id}`,
          `Add ${article(name)} ${name}${tail ? ` ${tail}` : ''}`,
          { now: [], target: [it.id] },
          why(it.id),
          `the ${name}`,
        ),
      );
    }
    for (const it of left) {
      const name = pieceName(it);
      const where = whereOf(now, it);
      mine.push(
        make(
          'remove',
          `remove:${it.id}`,
          `Remove the ${name}${where ? ` ${where}` : ''}`,
          { now: [it.id], target: [] },
          null,
          `the ${name}`,
        ),
      );
    }
    out.push(...stableOrder(foldBelongs(mine, now, target, r.refs), now, target));

    // Paint and floors.
    const rooms = new Set(s.rooms);
    const floors = s.rooms.some(
      (id) => target.rooms[id]?.floorMaterial !== (now.rooms[id]?.floorMaterial ?? undefined),
    );
    const paint = Object.values(target.walls).some((w) => {
      const n = now.walls[w.id];
      const [l, rr] = roomsBeside(target, w.id);
      return (
        (!!l && rooms.has(l) && w.materialLeft !== (n?.materialLeft ?? 'paint-white')) ||
        (!!rr && rooms.has(rr) && w.materialRight !== (n?.materialRight ?? 'paint-white'))
      );
    });
    if (floors || paint) {
      const what = floors && paint ? 'New paint and floors' : floors ? 'New floors' : 'New paint';
      out.push({
        ...make(
          'finish',
          `finish:${s.key}`,
          `${what} in ${s.name}`,
          { now: [], target: [] },
          null,
          `the ${what.toLowerCase().replace(/^new /, '')} in ${s.name}`,
        ),
      });
    }
    // Electrical points.
    const points = Object.values(target.points ?? {}).filter((p) => {
      if (now.points?.[p.id]) return false;
      const at = p.at ?? wallPointAt(target, p.wall);
      const room = at ? roomIdAt(target, at) : null;
      return !!room && rooms.has(room);
    });
    if (points.length) {
      out.push(
        make(
          'electrical',
          `elec:${s.key}`,
          `Add ${points.length} electrical ${points.length === 1 ? 'point' : 'points'} in ${s.name}`,
          { now: [], target: [] },
          null,
          `the electrical points in ${s.name}`,
        ),
      );
    }
  }
  // The bathrooms' tiles and paint (a whole-flat proposal's).
  const wet = Object.values(target.rooms)
    .filter((x) => WET.test(x.name))
    .map((x) => x.id);
  const wetSet = new Set(wet);
  const wetChanged =
    wet.some((id) => target.rooms[id]?.floorMaterial !== now.rooms[id]?.floorMaterial) ||
    Object.values(target.walls).some((w) => {
      const n = now.walls[w.id];
      const [l, rr] = roomsBeside(target, w.id);
      return (
        (!!l && wetSet.has(l) && w.materialLeft !== (n?.materialLeft ?? 'paint-white')) ||
        (!!rr && wetSet.has(rr) && w.materialRight !== (n?.materialRight ?? 'paint-white'))
      );
    });
  if (wetChanged && wet.length) {
    out.push({
      id: `finish:${BATHROOMS}`,
      group: BATHROOMS,
      groupName: 'Bathrooms',
      verb: 'finish',
      text: 'New tiles and paint in the bathrooms',
      why: null,
      items: { now: [], target: [] },
      rows: [],
      needsWalls: false,
      checks: [],
      waivable: true,
      name: 'the bathroom tiles',
    });
  }
  // The checks each change causes.
  const byItem = new Map<string, Change>();
  for (const c of out) for (const id of [...c.items.target, ...c.items.now]) byItem.set(id, c);
  for (const c of hard) {
    const ch = c.itemId ? byItem.get(c.itemId) : undefined;
    if (!ch) continue;
    if (!ch.checks.includes(c.key)) ch.checks.push(c.key);
    if (!c.waivable) ch.waivable = false;
  }
  return out;
}

/** Big furniture first, then storage, the rest, lighting; a steady order run to run. */
function stableOrder(changes: Change[], now: Level, target: Level): Change[] {
  const rank = (c: Change) => {
    const id = c.items.target[0] ?? c.items.now[0];
    const it = id ? (target.items[id] ?? now.items[id]) : undefined;
    const kind = it ? furnitureKind(it.assetId) : undefined;
    if (!kind) return 5;
    if (kind.category === 'Lighting' || kind.ceiling) return 4;
    if (kind.carpentry || /storage|wardrobe|cabinet|shelf/i.test(`${kind.category} ${kind.name}`))
      return 2;
    const r = roleOfIt(it);
    if (['bed', 'sofa', 'dining-table', 'desk', 'tv', 'tv-console'].includes(r)) return 1;
    return 3;
  };
  return [...changes].sort((a, b) => rank(a) - rank(b) || a.text.localeCompare(b.text));
}

/** Chairs into their table, bedside tables into their bed: one row each. */
function foldBelongs(
  changes: Change[],
  now: Level,
  target: Level,
  refs: Record<string, string> = {},
): Change[] {
  const itemOf = (c: Change) => {
    const id = c.items.target[0] ?? c.items.now[0];
    return id ? (target.items[id] ?? now.items[id]) : undefined;
  };
  /** A row whose piece the app placed itself (its ref starts `app:`). */
  const appOwned = (c: Change) => {
    const id = c.items.target[0];
    return !!id && !!refs[id]?.startsWith('app:');
  };
  // Taken out together, or put in (added, moved, swapped) together.
  const family = (v: ChangeVerb) => (v === 'remove' ? 'out' : 'in');
  const parents = new Map<Change, Change[]>();
  const children = new Set<Change>();
  for (const c of changes) {
    const it = itemOf(c);
    const of = BELONGS[roleOfIt(it)];
    if (!it || !of || c.items.target.length + c.items.now.length > 2) continue;
    const p = changes
      .filter(
        (x) =>
          x !== c &&
          family(x.verb) === family(c.verb) &&
          of.includes(roleOfIt(itemOf(x))) &&
          // The app's own pieces and the designer's are never one row: unticking the app's
          // bed must not take the designer's bedside table with it.
          appOwned(x) === appOwned(c),
      )
      .map((x) => ({ x, d: dist(centre(it), centre(itemOf(x) as Item)) }))
      .filter((o) => o.d < 2.5)
      .sort((p, q) => p.d - q.d)[0]?.x;
    if (!p) continue;
    parents.set(p, [...(parents.get(p) ?? []), c]);
    children.add(c);
  }
  return changes
    .filter((c) => !children.has(c))
    .map((c) => {
      const kids = parents.get(c);
      if (!kids?.length) return c;
      const role = roleOfIt(itemOf(kids[0] as Change));
      const [one, many] = childWords[role] ?? ['piece', 'pieces'];
      const n = kids.length;
      return {
        ...c,
        text: `${c.text}, with ${n === 1 ? `${article(one)} ${one}` : `${n} ${many}`}`,
        items: {
          now: [...c.items.now, ...kids.flatMap((k) => k.items.now)],
          target: [...c.items.target, ...kids.flatMap((k) => k.items.target)],
        },
      };
    });
}

/** The changes ticked first: every one that causes no hard check (failing ones wait). */
export const defaultTicks = (changes: Change[]): string[] =>
  changes.filter((c) => !c.checks.length).map((c) => c.id);

/** The pieces the rows ticked first put in (`subsetReport`'s `firstIn`). */
export const firstTickedPieces = (changes: readonly Change[]): Set<string> =>
  new Set(changes.filter((c) => !c.checks.length).flatMap((c) => c.items.target));

/**
 * The ids that can go in together: a change that needs the walls is left out without them.
 */
export function allowedChanges(changes: Change[], ids: readonly string[]): Change[] {
  const set = new Set(ids);
  const walls = set.has('walls');
  return changes.filter((c) => set.has(c.id) && (walls || !c.needsWalls));
}

/**
 * `now` with the ticked changes taken from `target` (the proposal's result on `now`): the
 * walls and doors, pieces put in and taken out, paint and floors, electrical points.
 * Accepting every change gives the same plan as accepting every part (`mergeDesign`).
 */
export function mergeChanges(
  now: Level,
  target: Level,
  changes: Change[],
  ids: readonly string[],
): Level {
  const ok = allowedChanges(changes, ids);
  const out: Level = structuredClone(now);
  if (ok.some((c) => c.verb === 'walls')) {
    takeWalls(out, now, target);
    // The walls bring the rooms; their names only as the rename rows say.
    for (const c of changes) {
      if (c.verb !== 'rename' || ok.includes(c)) continue;
      const id = c.id.slice('rename:'.length);
      const room = out.rooms[id];
      const was = now.rooms[id];
      if (room && was) room.name = was.name;
    }
  }
  for (const c of ok) {
    if (c.verb !== 'rename') continue;
    const id = c.id.slice('rename:'.length);
    const room = out.rooms[id];
    const name = target.rooms[id]?.name;
    if (room && name) room.name = name;
  }
  for (const c of ok) {
    for (const id of c.items.now) delete out.items[id];
    for (const id of c.items.target) {
      const it = target.items[id];
      if (it) out.items[id] = structuredClone(it);
    }
  }
  for (const c of ok) {
    if (c.verb === 'finish') {
      const rooms =
        c.group === BATHROOMS
          ? Object.values(target.rooms)
              .filter((x) => WET.test(x.name))
              .map((x) => x.id)
          : c.group.split('+');
      finishRooms(out, target, rooms);
    }
    if (c.verb === 'electrical') {
      const rooms = new Set(c.group.split('+'));
      out.points ??= {};
      for (const p of Object.values(target.points ?? {})) {
        if (out.points[p.id]) continue;
        const at = p.at ?? wallPointAt(target, p.wall);
        const room = at ? roomIdAt(target, at) : null;
        if (room && rooms.has(room) && (!p.wall || out.walls[p.wall.wallId])) {
          out.points[p.id] = structuredClone(p);
        }
      }
    }
  }
  return out;
}

/** The parts a set of accepted changes amounts to, for the version's record. */
export function partsOf(changes: Change[], ids: readonly string[]) {
  const ok = allowedChanges(changes, ids);
  const parts: (
    | { aspect: 'walls' }
    | { space: string; aspect: 'furniture' | 'built-ins' | 'finishes' | 'electrical' }
  )[] = [];
  const seen = new Set<string>();
  const add = (p: (typeof parts)[number]) => {
    const k = 'space' in p ? `${p.space}|${p.aspect}` : 'walls';
    if (seen.has(k)) return;
    seen.add(k);
    parts.push(p);
  };
  for (const c of ok) {
    if (c.verb === 'walls' || c.verb === 'rename') add({ aspect: 'walls' });
    else if (c.verb === 'finish') add({ space: c.group, aspect: 'finishes' });
    else if (c.verb === 'electrical') add({ space: c.group, aspect: 'electrical' });
    else {
      add({ space: c.group, aspect: 'furniture' });
      add({ space: c.group, aspect: 'built-ins' });
    }
  }
  return parts;
}

export interface SubsetReport {
  /** Hard checks the ticked changes cause (not in the plan before), not waived. */
  failing: ResultCheck[];
  /** Of those, accepted anyway. */
  waived: ResultCheck[];
  cost: CostEstimate;
  /** The renovation's middle figure with these changes, less without them (S$). */
  delta: number;
  budget: 'within' | 'over' | 'unknown';
}

/**
 * What accepting just the ticked changes gives (UX §7.1): the hard checks that plan fails
 * that `now` didn't, and its cost against the flat as it is and the brief's budget.
 */
export function subsetReport(
  now: Level,
  before: Level,
  r: DesignResult,
  merged: Level,
  brief: DesignBrief,
  opts: {
    rates?: Rates;
    waived?: readonly string[];
    renovation?: boolean;
    /** The house rules the card was checked against (slice 3a). */
    rules?: readonly Rule[];
    /** The pieces kept where they are (slice 3a). */
    kept?: readonly Kept[];
    /**
     * The proposal's pieces the card ticks first (`defaultTicks`' rows), by item id: a must-have
     * one of them meets, unticked by the person, fails the ticks (see above).
     */
    firstIn?: ReadonlySet<string>;
  } = {},
): SubsetReport {
  const rules = {
    ...(opts.rules?.length ? { rules: opts.rules } : {}),
    ...(opts.kept?.length ? { kept: opts.kept } : {}),
  };
  const rates = opts.rates ?? TYPICAL_RATES;
  const baseKeys = new Set(
    designChecks(settled(now), { brief, uses: r.uses, ...rules })
      .filter((c) => c.hard)
      .map((c) => c.key),
  );
  const unchanged = (id: string) => {
    const a = merged.items[id];
    const b = now.items[id];
    return (
      !!a &&
      !!b &&
      a.assetId === b.assetId &&
      dist(centre(a), centre(b)) < 1e-3 &&
      angleDiff(a.rotationY, b.rotationY) < TURN_EPS
    );
  };
  const waived = new Set(opts.waived ?? []);
  // A must-have the version meets (a bed for the couple, the seats) that the ticked changes
  // leave unmet fails them, even when the plan as it is failed it too: unticking the bed leaves
  // them with no bed, and that is said and asked about at Accept. Judged on the plan the ticks
  // make (a bed of their own, or a kept one, meets it), and only when the person's own unticking
  // made the gap: a piece the version places for it (a bed, a sofa, the table, a desk, in that
  // room) that the card ticks first (`opts.firstIn`) and the person took out. A row unticked
  // from the first (it fails a check of its own) is already shown failing. Without `firstIn`,
  // none of this is asked.
  const firstIn = opts.firstIn;
  const versionFails = new Set(r.checks.filter((c) => c.hard).map((c) => c.key));
  const NEED: Record<string, Role[]> = {
    bed: ['bed'],
    seats: ['sofa', 'armchair'],
    dining: ['dining-table', 'dining-chair', 'stool'],
    desks: ['desk'],
  };
  const spaceRooms = (roomId: string) =>
    spacesOf(r.level).find((s) => s.rooms.includes(roomId))?.rooms ?? [roomId];
  const essentialLeft = (c: { key: string; itemId?: string; roomId?: string }) => {
    const [principle, code] = c.key.split('|');
    const roles = principle === 'P1' && code ? NEED[code] : undefined;
    if (!firstIn || c.itemId || !roles || !c.roomId || versionFails.has(c.key)) return false;
    const rooms = spaceRooms(c.roomId);
    return Object.values(r.level.items).some((it) => {
      if (merged.items[it.id] || !firstIn.has(it.id)) return false;
      if (!roles.includes(roleOf(furnitureKind(it.assetId)))) return false;
      const room = roomIdAt(r.level, centre(it));
      return (
        !!room && (code === 'bed' || code === 'desks' ? room === c.roomId : rooms.includes(room))
      );
    });
  };
  const caused = designChecks(settled(merged), { brief, uses: r.uses, ...rules })
    .filter((c) => c.hard)
    .filter(
      (c) => essentialLeft(c) || !(baseKeys.has(c.key) && (c.itemId ? unchanged(c.itemId) : true)),
    )
    .map((c): ResultCheck => ({ ...c, already: false, part: null }));
  const cost = costEstimate(before, merged, rates);
  const was =
    opts.renovation === false
      ? costEstimate(before, before, rates)
      : costEstimate(before, now, rates);
  const mid = (c: CostEstimate) => (c.low + c.high) / 2;
  const budget = !brief.budget ? 'unknown' : cost.low > brief.budget.high ? 'over' : 'within';
  return {
    failing: caused.filter((c) => !waived.has(c.key)),
    waived: caused.filter((c) => waived.has(c.key)),
    cost,
    delta: Math.round((mid(cost) - mid(was)) / 100) * 100,
    budget,
  };
}

/**
 * Accepting some of a designer's proposed changes (the ticked ones of `changes`, by id) into
 * the renovation of level `levelId` (the flat as it is), starting one if there is none: one
 * undo step. `target` is the proposal's result, worked out on After as it is now (or the flat
 * with no renovation), so only the ticked changes move from it into the plan.
 */
export function acceptChanges(
  levelId: string,
  target: Level,
  changes: Change[],
  ids: readonly string[],
  opts: { label?: string } = {},
): Command {
  return {
    label: opts.label ?? 'Use design',
    recipe: (d) => {
      if (!d.renovation) {
        const levels = d.levels.map((l) => ({
          ...structuredClone(current(l)),
          id: `${l.id}${AFTER_SUFFIX}`,
        }));
        d.renovation = { levels };
      }
      const after = draftLevel(d, `${levelId}${AFTER_SUFFIX}`);
      const now = (isDraft(after) ? current(after) : after) as Level;
      applyLevel(after, mergeChanges(now, target, changes, ids), { items: true });
    },
  };
}

/**
 * "Put it back": the renovation of level `levelId` as it was when the conversation started
 * (`level`, After then), or, when there was none, that level unchanged in it; the renovation
 * goes once no level of it is changed (another level's own changes stay). One undo step.
 */
export function putPlanBack(levelId: string, level: Level | null): Command {
  /** `after` made `next` (its id kept): everything the plan draws of it, its lights too. */
  const putBack = (after: Draft<Level>, next: Level) => {
    applyLevel(after, { ...next, id: after.id }, { items: true });
    after.lights = structuredClone(next.lights ?? {});
  };
  /** A level's whole content, without its id (the renovation's copy has another). */
  const content = (l: Level) => stableJson({ ...l, id: null });
  return {
    label: 'Put the plan back',
    recipe: (d) => {
      if (!level) {
        if (!d.renovation) return;
        const before = d.levels.find((l) => l.id === levelId);
        const after = d.renovation.levels.find((l) => l.id === `${levelId}${AFTER_SUFFIX}`);
        if (before && after) putBack(after, structuredClone(current(before)));
        const changed = d.renovation.levels.some((a) => {
          const b = d.levels.find((l) => `${l.id}${AFTER_SUFFIX}` === a.id);
          return !b || content(current(a)) !== content(current(b));
        });
        if (!changed) delete d.renovation;
        return;
      }
      if (!d.renovation) {
        d.renovation = {
          levels: d.levels.map((l) => ({
            ...structuredClone(current(l)),
            id: `${l.id}${AFTER_SUFFIX}`,
          })),
        };
      }
      putBack(draftLevel(d, `${levelId}${AFTER_SUFFIX}`), level);
    },
  };
}
