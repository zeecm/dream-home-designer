import { overlapDepth, polygonGap, roomOff, sideOf } from '../convex';
import { furnitureKind, itemFootprint, itemSize } from '../furniture';
import { pointInPolygon } from '../geometry';
import type { Item, Vec2 } from '../schema';
import { priorityOf } from './catalogue';
import {
  BUILT_IN_MIN,
  type Hit,
  type Shape,
  type SpaceIndex,
  type Want,
  addToIndex,
  blocking,
  hitsOf,
  inRooms,
  itemAt,
  nameOf,
  onFace,
  vertical,
} from './place';
import { type Relation, type Role, placesOf, relationOf, roleOf, seatsOf } from './principles';
import type { Zone } from './schema';
import { type Face, clearStretches } from './spaces';
import type { Note } from './walls';

/**
 * The solver: a space's pieces placed from what the designer intends (answers of version 2),
 * not from coordinates. Each piece says what it stands against, what it faces and what it
 * goes with; the catalogue's relationship rows (principles.ts) fill in what it leaves out.
 * Pieces go most constrained first, every anchor before the pieces that go with it. For
 * each, candidate poses are listed on every wall face and around its anchor or in its zone;
 * those that run into anything are dropped and the rest scored: its relationships (P2),
 * room to use it (P4), the ways people walk (P3), the designer's preferences, and whether
 * the pieces that go with it still fit (a TV where a sofa can face it, a table its chairs
 * can be pulled out from). A piece with nowhere to go makes the solver try its anchor and the
 * pieces before it elsewhere before it is left out. Deterministic.
 */
export interface Intent {
  want: Want;
  against: 'wall' | 'window-wall' | 'not-door-wall' | 'free';
  /** Another piece's ref, or 'room', 'window', 'door'. */
  faces: string | null;
  /** The ref of the piece it goes with. */
  near: string | null;
  zone: Zone | null;
}

export interface SolveInput {
  ix: SpaceIndex;
  /** The space's wall faces. */
  faces: Face[];
  intents: Intent[];
  /** Where a zone is: outlines to look for free places in (the whole space for none). */
  zoneArea: (z: Zone | null) => Vec2[][];
  /** The ways people walk through the bare plan, as wide as they need: kept free if it can be. */
  ways?: Shape[];
  /** The pieces (by id) the index's keep-out applies to (all of them when absent). */
  keepOutFor?: Set<string>;
  /** The household (helpers aside): a smaller piece is swapped in only if it still seats them. */
  household?: number;
}

export interface SolveOutcome {
  items: Item[];
  repaired: Note[];
  dropped: Note[];
  /** Poses tried. */
  tries: number;
}

interface Candidate {
  item: Item;
  score: number;
  soft: boolean;
  narrowed: boolean;
  /** How far short of the way kept between the dining and the lounge groups (0: clear). */
  short: number;
  /** Short of that way, or the dining group standing on a way through the flat. */
  apart: boolean;
  /** Short of the room needed to walk between them at all (P2 apart, hard). */
  tight: boolean;
  /** The dining group standing on a way through the flat. */
  way: boolean;
}

/** A set of placements' cost, worst first: short of room, left out, -score. */
type Cost = [number, number, number];

/** What a room can't do without: placed short of room rather than left out. */
export const ESSENTIAL = new Set<Role>([
  'bed',
  'sofa',
  'dining-table',
  'dining-chair',
  'desk',
  'kitchen',
  'fridge',
  'washer',
  'tv',
]);

/** How many of the best candidates a piece keeps (for going back). */
const KEEP = 16;
/** How many of a piece's best candidates are tried with the pieces that go with it. */
const LOOK = 6;
/** Going back: how many other places each piece tried. */
const ALTS = 8;
const GRID = 0.25;
const ALONG = 0.2;
/** How far a dining chair reaches past its table's edge, tucked in. */
const CHAIR_REACH = 0.4;
/** Short of a way by less than this counts as clear. */
const EPS = 0.005;
const deg = (r: number) => (r * 180) / Math.PI;
const fwd = (r: number): Vec2 => ({ x: -Math.sin(r), y: Math.cos(r) });
/** The rotation that faces direction v. */
const facing = (v: Vec2) => Math.atan2(-v.x, v.y);
const centre = (it: Item): Vec2 => ({ x: it.position.x, y: it.position.z });

/** The angle (degrees) between a pose's forward line and the way to a point. */
function offAngle(at: Vec2, r: number, to: Vec2): number {
  const f = fwd(r);
  const v = { x: to.x - at.x, y: to.y - at.y };
  const len = Math.hypot(v.x, v.y) || 1;
  return deg(Math.acos(Math.max(-1, Math.min(1, (f.x * v.x + f.y * v.y) / len))));
}

/** The roles a piece's relationship row goes with. */
function anchorRoles(rel: Relation | undefined): Role[] {
  if (!rel) return [];
  return [
    ...(rel.before?.of ?? []),
    ...(rel.belongs?.of ?? []),
    ...(rel.near?.of ?? []),
    ...(rel.faces?.focus ?? []),
  ];
}

/** Two poses unlike each other: turned differently, or more than 0.6 m apart. */
const apartPose = (o: { item: Item }, c: { item: Item }, by = 0.6) =>
  Math.abs(o.item.rotationY - c.item.rotationY) > 0.1 ||
  Math.hypot(o.item.position.x - c.item.position.x, o.item.position.z - c.item.position.z) > by;

/** Whether a piece must back onto a wall (it has no free-standing form). */
function wallOnlyOf(t: Intent): boolean {
  const k = t.want.kind;
  const rel = relationOf(k);
  return !!k.carpentry || (!!rel?.backs && rel.backs.free === undefined) || roleOf(k) === 'bed';
}

/**
 * A space solved, right-sizing where the dining and the lounge can't keep 0.60 m between them
 * (P2 apart, hard): smaller pieces of the same use are tried in turn, as a designer would in a
 * small living room (a round table for four, a wall-side table with a bench for two, an
 * extendable table for six, a 2-seat sofa where the household still has seats), each swap
 * said in a line. Only if none keeps the way is the first solve kept, failing the check.
 */
export function solveSpace(input: SolveInput): SolveOutcome {
  const mark = input.ix.placed.length;
  const first = solveOnce(input);
  // Short of the way between the groups, or the dining group left standing on a way through
  // the flat: smaller pieces are tried.
  const bad = (items: Item[]) => tightIn(input, items, mark) || diningOnWay(input, items);
  if (!bad(first.items)) return first;
  for (const swap of swapsFor(input)) {
    input.ix.placed.length = mark;
    const out = solveOnce({ ...input, intents: swap.intents });
    out.tries += first.tries;
    if (
      !bad(out.items) &&
      essentialDrops(out, swap.intents) <= essentialDrops(first, input.intents)
    ) {
      out.repaired.unshift(...swap.notes);
      return out;
    }
  }
  // Nothing smaller keeps the way: the first solve stands, and the check fails.
  input.ix.placed.length = mark;
  const kinds = new Map(input.intents.map((t) => [t.want.id, t.want.kind]));
  for (const item of first.items) {
    const kind = kinds.get(item.id) ?? furnitureKind(item.assetId);
    if (kind) addToIndex(input.ix, item, kind);
  }
  return first;
}

/** Whether a dining group stands short of 0.60 m from the lounge (pieces solved and fixed). */
function tightIn(input: SolveInput, items: Item[], mark: number): boolean {
  const fixed = input.ix.placed.slice(0, mark).map((p) => ({ assetId: p.assetId, fp: p.fp }));
  const all = [
    ...fixed,
    ...items.map((it) => ({ assetId: it.assetId, fp: itemFootprint(it) })),
  ].map((p) => ({ ...p, role: roleOf(furnitureKind(p.assetId)) }));
  for (const t of all) {
    const kind = furnitureKind(t.assetId);
    const ap = kind ? relationOf(kind)?.apart : undefined;
    if (!ap || t.role !== 'dining-table') continue;
    const group = [
      t.fp,
      ...all
        .filter((c) => c.role === 'dining-chair' && polygonGap(c.fp, t.fp).d < 0.4)
        .map((c) => c.fp),
    ];
    for (const q of all) {
      if (!ap.from.includes(q.role)) continue;
      if (Math.min(...group.map((g) => polygonGap(g, q.fp).d)) < ap.hard - EPS) return true;
    }
  }
  return false;
}

/** Whether a dining table (one kept apart from the lounge) stands on a way through the flat. */
function diningOnWay(input: SolveInput, items: Item[]): boolean {
  if (!input.ways?.length) return false;
  return items.some((it) => {
    const kind = furnitureKind(it.assetId);
    if (!kind || !relationOf(kind)?.apart) return false;
    const fp = itemFootprint(it, kind);
    const fb = boxOf(fp);
    return (input.ways ?? []).some(
      (x) =>
        !(x.box.x1 < fb.x0 || fb.x1 < x.box.x0 || x.box.y1 < fb.y0 || fb.y1 < x.box.y0) &&
        overlapDepth(fp, x.poly) > 0.02,
    );
  });
}

/** Pieces a room can't do without that a solve left out. */
function essentialDrops(o: SolveOutcome, intents: Intent[]): number {
  const kinds = new Map(intents.map((t) => [t.want.ref, t.want.kind]));
  return o.dropped.filter((n) => {
    const k = n.ref ? kinds.get(n.ref) : undefined;
    return !!k && ESSENTIAL.has(roleOf(k));
  }).length;
}

/** The same piece as another kind of the catalogue, at that kind's size. */
function swapped(t: Intent, id: string): Intent | null {
  const kind = furnitureKind(id);
  if (!kind) return null;
  return {
    ...t,
    want: {
      ...t.want,
      kind,
      w: kind.size.w,
      d: kind.size.d,
      h: kind.size.h,
      face: null,
      along: null,
    },
    // A table with its bench goes against a wall.
    against: id === 'dining-bench-2' ? 'wall' : t.against,
  };
}

interface Swap {
  intents: Intent[];
  notes: Note[];
}

/** Smaller pieces to try, in order: the table first, then the sofa, then both. */
function swapsFor(input: SolveInput): Swap[] {
  const { intents } = input;
  const household = input.household ?? 0;
  const role = (t: Intent) => roleOf(t.want.kind);
  const table = intents.find((t) => role(t) === 'dining-table' && relationOf(t.want.kind)?.apart);
  const sofa = intents.find((t) => role(t) === 'sofa' && t.want.kind.id === 'sofa-3');
  const chairsOf = (t: Intent) =>
    intents.filter(
      (c) => role(c) === 'dining-chair' && (c.near === t.want.ref || c.faces === t.want.ref),
    );
  const note = (t: Intent, text: string): Note => ({ text, ref: t.want.ref, itemId: t.want.id });
  const tables: Swap[] = [];
  if (table) {
    const places = placesOf(table.want.kind, table.want.w, table.want.d);
    const chairs = chairsOf(table);
    const replace = (id: string, keepChairs: number, text: string) => {
      const t2 = swapped(table, id);
      if (!t2) return;
      const drop = new Set(chairs.slice(keepChairs).map((c) => c.want.ref));
      tables.push({
        intents: intents.filter((x) => !drop.has(x.want.ref)).map((x) => (x === table ? t2 : x)),
        notes: [note(table, text)],
      });
    };
    const name = table.want.kind.name.replace(/^Dining table/, 'dining table');
    if (places >= 6) {
      replace(
        'dining-extendable',
        4,
        `Swapped the ${name} for an extendable table to keep 0.60 m to the sofa: it fits 4, and 6 with the table pulled out.`,
      );
    } else if (table.want.kind.id !== 'pedestal-table-round') {
      replace(
        'pedestal-table-round',
        4,
        `Swapped the ${name} for a round table for four to keep 0.60 m to the sofa.`,
      );
    }
    if (household <= 2 && table.want.kind.id !== 'dining-bench-2') {
      replace(
        'dining-bench-2',
        0,
        `Swapped the ${name} for a wall-side table with a bench for two to keep 0.60 m to the sofa.`,
      );
    }
  }
  const sofas: Swap[] = [];
  if (sofa) {
    // Only where the household still has seats: armchairs and the 2-seat sofa.
    const other = intents
      .filter((t) => t !== sofa && (role(t) === 'sofa' || role(t) === 'armchair'))
      .reduce((n, t) => n + seatsOf(t.want.kind, t.want.w), 0);
    const two = furnitureKind('sofa-2');
    if (two && other + seatsOf(two) >= Math.min(household, 3)) {
      const s2 = swapped(sofa, 'sofa-2');
      if (s2) {
        sofas.push({
          intents: intents.map((x) => (x === sofa ? s2 : x)),
          notes: [
            note(sofa, 'Swapped the 3-seat sofa for a 2-seat to keep 0.60 m to the dining table.'),
          ],
        });
      }
    }
  }
  const both: Swap[] = [];
  const s2 = sofas[0];
  if (s2 && sofa) {
    for (const t of tables) {
      const s2i = s2.intents.find((x) => x.want.ref === sofa.want.ref) as Intent;
      both.push({
        intents: t.intents.map((x) => (x.want.ref === sofa.want.ref ? s2i : x)),
        notes: [...t.notes, ...s2.notes],
      });
    }
  }
  return [...tables, ...sofas, ...both];
}

function solveOnce(input: SolveInput): SolveOutcome {
  const { ix, faces, intents } = input;
  const repaired: Note[] = [];
  const dropped: Note[] = [];
  let tries = 0;
  const byRef = new Map(intents.map((t) => [t.want.ref, t]));
  const roles = new Map(intents.map((t) => [t.want.ref, roleOf(t.want.kind)]));
  const solids = ix.solid.map((x) => x.poly);
  /** Set false by `score` when a pose breaks one of the piece's relationships. */
  let related = true;
  /** Each free piece's poses in its zone (they don't depend on what is placed). */
  const zoneMemo = new Map<string, { at: Vec2; r: number }[]>();

  // Each piece's anchor: the ref it names (faces or near), else the first piece of a role its
  // row goes with (a sofa the TV, chairs their table, a bedside table its bed).
  const anchorOf = new Map<string, string>();
  for (const t of intents) {
    const named = [t.near, t.faces].find((r) => !!r && byRef.has(r) && r !== t.want.ref);
    if (named) {
      anchorOf.set(t.want.ref, named);
      continue;
    }
    for (const role of anchorRoles(relationOf(t.want.kind))) {
      const by = intents.find((o) => o !== t && roles.get(o.want.ref) === role);
      if (by) {
        anchorOf.set(t.want.ref, by.want.ref);
        break;
      }
    }
  }
  // A TV faces the sofa, but the sofa is placed to face the TV: the TV goes first. Any other
  // loop is broken where it comes back.
  for (const t of intents) {
    const seen = new Set<string>();
    let ref: string | undefined = t.want.ref;
    while (ref && !seen.has(ref)) {
      seen.add(ref);
      ref = anchorOf.get(ref);
    }
    if (ref && ref === t.want.ref) {
      const a = anchorOf.get(ref) as string;
      const r1 = roles.get(ref);
      if (r1 === 'tv' || r1 === 'tv-console' || roles.get(a) !== 'tv') anchorOf.delete(ref);
      else anchorOf.delete(a);
    }
  }
  const dependents = new Map<string, Intent[]>();
  for (const t of intents) {
    const a = anchorOf.get(t.want.ref);
    if (a) dependents.set(a, [...(dependents.get(a) ?? []), t]);
  }

  /**
   * A dining table's group as it will stand: the table and the reach of its chairs, along its
   * long sides (and its ends when more chairs come than the long sides seat).
   */
  const groupOf = (t: Intent, item: Item): Vec2[] => {
    const chairs = (dependents.get(t.want.ref) ?? []).filter(
      (d) => roles.get(d.want.ref) === 'dining-chair',
    ).length;
    const { w, d } = itemSize(item, t.want.kind);
    if (!chairs) return itemFootprint(item, t.want.kind);
    const per = Math.max(1, Math.min(3, Math.floor(Math.max(w, d) / 0.58)));
    const ends = chairs > 2 * per;
    const gw = w + (w >= d ? (ends ? 2 * CHAIR_REACH : 0) : 2 * CHAIR_REACH);
    const gd = d + (w >= d ? 2 * CHAIR_REACH : ends ? 2 * CHAIR_REACH : 0);
    const c = Math.cos(item.rotationY);
    const sn = Math.sin(item.rotationY);
    return [
      [-gw / 2, -gd / 2],
      [gw / 2, -gd / 2],
      [gw / 2, gd / 2],
      [-gw / 2, gd / 2],
    ].map(([x, y]) => ({
      x: item.position.x + (x as number) * c - (y as number) * sn,
      y: item.position.z + (x as number) * sn + (y as number) * c,
    }));
  };
  /** The `apart` row that keeps a piece's group (the dining table's, for a chair at it). */
  const apartOf = (t: Intent): Relation['apart'] => {
    const own = relationOf(t.want.kind)?.apart;
    if (own) return own;
    const a = anchorOf.get(t.want.ref);
    const at = a ? byRef.get(a) : undefined;
    return roles.get(t.want.ref) === 'dining-chair' && at
      ? relationOf(at.want.kind)?.apart
      : undefined;
  };
  /**
   * How far a pose is short of the way kept between the dining group and the lounge group
   * (P2 apart, 0.9 m): a dining table (with its chairs' reach) or a chair against the lounge
   * pieces placed, a lounge piece against the dining groups placed. 0: clear.
   */
  const apartRows = new Map(intents.map((t) => [t.want.ref, apartOf(t)]));
  /** The roles some dining group keeps apart from (the lounge's). */
  const lounge = new Set<Role>([...apartRows.values()].flatMap((a) => (a ? a.from : [])));
  /** A placed dining table's group, worked out once per pose. */
  const groupMemo = new WeakMap<Item, Vec2[]>();
  const groupAt = (t: Intent, item: Item) => {
    let g = groupMemo.get(item);
    if (!g) {
      g = groupOf(t, item);
      groupMemo.set(item, g);
    }
    return g;
  };
  const shortOf = (
    t: Intent,
    item: Item,
    placed: Map<string, Item>,
  ): { short: number; slack: number; dining: boolean } => {
    const role = roles.get(t.want.ref) as Role;
    let short = 0;
    const mine = apartRows.get(t.want.ref);
    if (!mine && !lounge.has(role)) return { short: 0, slack: 0, dining: false };
    if (mine) {
      const fp = relationOf(t.want.kind)?.apart
        ? groupOf(t, item)
        : itemFootprint(item, t.want.kind);
      for (const [ref, q] of placed) {
        if (!mine.from.includes(roles.get(ref) as Role)) continue;
        short = Math.max(short, mine.gap - polygonGap(fp, itemFootprint(q)).d);
      }
      return { short, slack: mine.gap - mine.hard, dining: true };
    }
    let slack = 0;
    let fp: Vec2[] | null = null;
    for (const [ref, q] of placed) {
      const qt = byRef.get(ref);
      if (!qt) continue;
      const theirs = apartRows.get(ref);
      if (!theirs?.from.includes(role)) continue;
      fp ??= itemFootprint(item, t.want.kind);
      const other = relationOf(qt.want.kind)?.apart ? groupAt(qt, q) : itemFootprint(q);
      short = Math.max(short, theirs.gap - polygonGap(fp, other).d);
      slack = theirs.gap - theirs.hard;
    }
    return { short, slack, dining: false };
  };
  /** Whether a footprint stands on one of the ways through the flat. */
  const onWay = (fp: Vec2[]): boolean => {
    if (!input.ways?.length) return false;
    const fb = boxOf(fp);
    return input.ways.some(
      (x) =>
        !(x.box.x1 < fb.x0 || fb.x1 < x.box.x0 || x.box.y1 < fb.y0 || fb.y1 < x.box.y0) &&
        overlapDepth(fp, x.poly) > 0.02,
    );
  };

  /**
   * A piece's turn: its catalogue priority, but the lounge (sofa, TV, coffee table) and then
   * the dining table go before cabinets and shelves, so the two groups get the floor first
   * and the way between them is kept.
   */
  const rankOf = (t: Intent): number => {
    const role = roles.get(t.want.ref) as Role;
    const p = priorityOf(t.want.kind);
    if (p < 2) return p;
    // The dining table and its chairs together, before cabinets take the floor round it.
    if (apartRows.get(t.want.ref)) return role === 'dining-chair' ? 1.96 : 1.95;
    // The sofa and the TV, the dining table, then what goes with the sofa (its coffee table,
    // armchairs), which can give way a little to keep the way between.
    if (role === 'sofa' || role === 'tv' || role === 'tv-console') return 1.9;
    if (lounge.has(role)) return 1.97;
    return p;
  };
  // Order: by priority, an anchor before what goes with it; then the most constrained first
  // (fewest places in the empty space), then the largest.
  const room = new Map(intents.map((t) => [t.want.ref, roomFor(t)]));
  const sorted = [...intents].sort(
    (p, q) =>
      rankOf(p) - rankOf(q) ||
      (room.get(p.want.ref) ?? 0) - (room.get(q.want.ref) ?? 0) ||
      q.want.w * q.want.d - p.want.w * p.want.d ||
      (p.want.ref < q.want.ref ? -1 : p.want.ref > q.want.ref ? 1 : 0),
  );
  const order: Intent[] = [];
  const queued = new Set<string>();
  const visit = (t: Intent) => {
    if (queued.has(t.want.ref)) return;
    queued.add(t.want.ref);
    const a = anchorOf.get(t.want.ref);
    const at = a ? byRef.get(a) : undefined;
    if (at) visit(at);
    order.push(t);
  };
  for (const t of sorted) visit(t);

  /** Roughly how many places a piece has in the empty space: the walls long enough for it. */
  function roomFor(t: Intent): number {
    if (t.against === 'free' && !wallOnlyOf(t)) return 1000;
    const { bottom, top } = vertical(t.want);
    return faces.reduce(
      (n, f) =>
        n +
        clearStretches(f, bottom, top).reduce(
          (m, [s0, s1]) => m + Math.max(0, Math.floor((s1 - s0 - t.want.w) / ALONG) + 1),
          0,
        ),
      0,
    );
  }

  /** The candidates for a piece, given what is placed (by ref), best first. */
  function candidates(t: Intent, placed: Map<string, Item>, all = false): Candidate[] {
    const w = t.want;
    const k = w.kind;
    const rel = relationOf(k);
    const anchorRef = anchorOf.get(w.ref);
    const anchor = anchorRef ? placed.get(anchorRef) : undefined;
    const anchorRole = anchorRef ? roles.get(anchorRef) : undefined;
    const wallOnly = wallOnlyOf(t);
    const endOn = roles.get(w.ref) === 'dining-table' && t.against === 'free';
    // Facing a TV: along its line as well as on a wall (a floating sofa).
    const facesTv = !!anchor && !!rel?.faces && anchorRole === 'tv';
    // A seat facing the TV is tried against a wall too, whatever the designer said.
    // A free piece with nothing to go with is tried against the walls too (an armchair in a
    // corner the floor grid steps over).
    const onWall =
      t.against !== 'free' ||
      wallOnly ||
      (facesTv && !!rel?.backs) ||
      (!anchorRef && !k.walkThrough);
    const out: Candidate[] = [];
    const seen = new Set<string>();
    const keepOut = ix.keepOut;
    if (input.keepOutFor && !input.keepOutFor.has(w.id)) ix.keepOut = [];
    const add = (item: Item, hs: Hit[], narrowed = false, wish = 0) => {
      tries++;
      if (blocking(hs)) return;
      const key = `${item.position.x.toFixed(2)}|${item.position.z.toFixed(2)}|${item.rotationY.toFixed(2)}|${item.scale.x.toFixed(2)}`;
      if (seen.has(key)) return;
      seen.add(key);
      const soft = hs.length > 0;
      // Short of room to use it, or away from what it goes with, only for what the room can't
      // do without: anything else is left out rather than spoil the room or fail a check.
      const essential = ESSENTIAL.has(roleOf(k));
      if (soft && !essential) return;
      related = true;
      const s = score(t, item, soft, anchor, anchorRole, placed, wish !== 0 || !onWall);
      if (!related && !essential) return;
      // Short of the way between dining and lounge: the less short the better. The dining
      // group kept apart by standing on a way through the flat doesn't count as apart.
      const sh = shortOf(t, item, placed);
      const short = Math.max(0, sh.short);
      const way = sh.dining && !k.walkThrough && onWay(itemFootprint(item, k));
      out.push({
        item,
        soft,
        narrowed,
        short,
        apart: short > EPS || way,
        tight: short > sh.slack + EPS,
        way,
        score: wish + s - (short > EPS ? 3 + short * 4 : 0),
      });
    };

    if (onWall) {
      const { bottom, top } = vertical(w);
      const list = faces.filter((f) => {
        if (t.against === 'window-wall') return f.openings.some((o) => o.kind === 'window');
        if (t.against === 'not-door-wall') return !f.openings.some((o) => o.kind !== 'window');
        return true;
      });
      for (const face of list.length ? list : faces) {
        for (const [s0, s1] of clearStretches(face, bottom, top)) {
          const len = s1 - s0;
          let width = w.w;
          let narrowed = false;
          if (len < width - 1e-6) {
            if (!k.carpentry || len < Math.max(BUILT_IN_MIN, width * 0.5)) continue;
            width = len;
            narrowed = true;
          }
          const us = new Set<number>();
          const lo = s0 + width / 2;
          const hi = s1 - width / 2;
          us.add(lo);
          us.add(hi);
          us.add((lo + hi) / 2);
          for (let u = lo; u <= hi + 1e-9; u += ALONG) us.add(u);
          if (w.face === face && w.along !== null) us.add(Math.min(hi, Math.max(lo, w.along)));
          // Beside what is already on this wall (a bedside table by the bed's head), or under
          // it (a console under the TV).
          for (const p of placed.values()) {
            const c = centre(p);
            const fr = face.frame;
            const u = (c.x - fr.a.x) * fr.d.x + (c.y - fr.a.y) * fr.d.y;
            const v = ((c.x - fr.a.x) * fr.n.x + (c.y - fr.a.y) * fr.n.y) * face.side;
            if (v < 0 || v > 1.2) continue;
            const pw = itemSize(p).w;
            for (const s of [-1, 0, 1]) {
              const at = u + s * (pw / 2 + width / 2 + 0.01);
              if (at >= lo - 1e-9 && at <= hi + 1e-9) us.add(at);
            }
          }
          for (const u of [...us].sort((a, b) => a - b)) {
            const pose = onFace(face, u, w.d);
            const item = itemAt(w, pose.at, pose.rotation, width);
            add(
              item,
              hitsOf(ix, item, k, { face, u0: u - width / 2, u1: u + width / 2, bottom, top }),
              narrowed,
              t.against === 'free' && !wallOnly ? -0.5 : 0,
            );
            // A dining table may stand end-on to the wall too, its chairs along both sides.
            if (endOn && !narrowed) {
              const end = onFace(face, u, w.w);
              const turned = itemAt(w, end.at, end.rotation + Math.PI / 2, w.w);
              add(turned, hitsOf(ix, turned, k), false, -0.5);
            }
          }
        }
      }
    }

    if (!onWall || facesTv || (t.against === 'free' && !wallOnly) || (!out.length && !wallOnly)) {
      // Free-standing; a little less wished for when the designer asked for a wall.
      const wish = t.against !== 'free' ? -1 : 0;
      const poses: { at: Vec2; r: number }[] = [];
      if (anchor) {
        const a = centre(anchor);
        const af = fwd(anchor.rotationY);
        const afp = itemFootprint(anchor);
        const front = sideOf(afp, 'front');
        const fm = { x: (front.a.x + front.b.x) / 2, y: (front.a.y + front.b.y) / 2 };
        const across = { x: -af.y, y: af.x };
        if (facesTv && rel?.faces) {
          // Facing the TV, square to its line: 2.0–3.6 m from its front.
          for (let d = rel.faces.min + 0.2; d <= Math.min(rel.faces.max, 3.6) + 1e-9; d += 0.2) {
            for (const off of [0, 0.3, -0.3]) {
              const at = {
                x: fm.x + af.x * (d + w.d / 2) + across.x * off,
                y: fm.y + af.y * (d + w.d / 2) + across.y * off,
              };
              poses.push({ at, r: anchor.rotationY + Math.PI });
            }
          }
        } else if (rel?.before) {
          // In front of the sofa, in reach: centred, or a little to one side.
          for (const off of [0, -0.1, 0.1, -0.2, 0.2]) {
            for (const gap of [0.42, 0.38, 0.47]) {
              poses.push({
                at: {
                  x: fm.x + af.x * (gap + w.d / 2) + across.x * off,
                  y: fm.y + af.y * (gap + w.d / 2) + across.y * off,
                },
                r: anchor.rotationY,
              });
            }
          }
        } else if (rel?.belongs) {
          poses.push(...chairSlots(anchor, w.d));
        } else if (rel?.faces) {
          // An armchair at the side of what it faces, square to it.
          const s = Math.max(...afp.map((p) => Math.hypot(p.x - a.x, p.y - a.y)));
          for (let i = 0; i < 8; i++) {
            const ang = (i * Math.PI) / 4 + anchor.rotationY;
            const dir = { x: Math.cos(ang), y: Math.sin(ang) };
            const at = {
              x: a.x + dir.x * (s + w.d / 2 + 0.3),
              y: a.y + dir.y * (s + w.d / 2 + 0.3),
            };
            poses.push({ at, r: facing({ x: a.x - at.x, y: a.y - at.y }) });
          }
        } else if (k.walkThrough) {
          // A rug under the group it goes with: centred, else nudged to stay in the room.
          for (const [dx, dy] of [
            [0, 0],
            [0.15, 0],
            [-0.15, 0],
            [0, 0.15],
            [0, -0.15],
            [0.3, 0],
            [-0.3, 0],
            [0.15, 0.15],
            [-0.15, 0.15],
            [0.15, -0.15],
            [-0.15, -0.15],
          ] as const) {
            poses.push({
              at: {
                x: a.x + across.x * dx + af.x * dy,
                y: a.y + across.y * dx + af.y * dy,
              },
              r: anchor.rotationY,
            });
          }
        } else {
          // Beside it: at each corner, a little off.
          for (const p of afp) {
            const v = { x: p.x - a.x, y: p.y - a.y };
            const len = Math.hypot(v.x, v.y) || 1;
            const at = {
              x: p.x + (v.x / len) * (w.d / 2 + 0.1),
              y: p.y + (v.y / len) * (w.d / 2 + 0.1),
            };
            poses.push({ at, r: anchor.rotationY });
          }
        }
      }
      const zonePoses = (): { at: Vec2; r: number }[] => {
        // The same for a piece however often it is tried (going back, looking ahead).
        const was = zoneMemo.get(w.ref);
        if (was) return was;
        const out: { at: Vec2; r: number }[] = [];
        // In its zone (or near where the designer would have it).
        const turns = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
        const rs = rel?.faces ? turns : turns.slice(0, 2);
        if (w.at) for (const r of [w.rotation, ...rs]) out.push({ at: w.at, r });
        for (const poly of input.zoneArea(t.zone)) {
          const b = boxOf(poly);
          for (let x = b.x0 + GRID / 2; x < b.x1; x += GRID) {
            for (let y = b.y0 + GRID / 2; y < b.y1; y += GRID) {
              const at = { x, y };
              if (!pointInPolygon(at, poly) || !inRooms(ix, at)) continue;
              for (const r of rs) out.push({ at, r });
            }
          }
        }
        zoneMemo.set(w.ref, out);
        return out;
      };
      const tryPoses = (list: { at: Vec2; r: number }[], checked = false) => {
        for (const p of list) {
          if (!checked && !inRooms(ix, p.at)) continue;
          const item = itemAt(w, p.at, p.r, w.w);
          add(item, hitsOf(ix, item, k), false, wish);
        }
      };
      if (poses.length && anchor) tryPoses(poses);
      else tryPoses(zonePoses(), true);
      // Nothing by its anchor: anywhere in its zone.
      if (!out.length && poses.length && anchor && !rel?.belongs) tryPoses(zonePoses(), true);
    }
    ix.keepOut = keepOut;
    // The way between the dining and the lounge groups is kept wherever any clear pose keeps
    // it: the poses short of it are dropped (advice only when none keeps it).
    const drop = (bad: (c: Candidate) => boolean) => {
      if (!out.some(bad) || !out.some((c) => !c.soft && !bad(c))) return;
      for (let n = out.length - 1; n >= 0; n--) if (bad(out[n] as Candidate)) out.splice(n, 1);
    };
    drop((c) => c.apart);
    // Short of 0.9 m everywhere: 0.6 m at least, off the ways, where any pose has it.
    drop((c) => c.tight);
    drop((c) => c.way);
    out.sort((p, q) => q.score - p.score);
    // Going back looks at every clear place, not just the best few.
    if (all) return out;
    const best = out.slice(0, KEEP);
    // The pieces that go with it must still fit: try the best few with them.
    const deps = dependents.get(w.ref) ?? [];
    if (deps.length && out.length > 1) {
      // The best few, unlike each other (another wall, or apart), with what goes with them.
      const looked: Candidate[] = [];
      for (const c of out) {
        if (looked.length >= LOOK) break;
        if (looked.every((o) => apartPose(o, c))) looked.push(c);
      }
      for (const c of looked) c.score += lookAhead(t, c, deps, placed);
      const rest = best.filter((c) => !looked.includes(c));
      return [...looked, ...rest].sort((p, q) => q.score - p.score).slice(0, KEEP);
    }
    return best;
  }

  /** How well the pieces that go with a piece fit around it at a candidate pose. */
  function lookAhead(t: Intent, c: Candidate, deps: Intent[], placed: Map<string, Item>): number {
    const mark = ix.placed.length;
    const trial = new Map(placed);
    addToIndex(ix, c.item, t.want.kind);
    trial.set(t.want.ref, c.item);
    let total = 0;
    for (const d of deps) {
      const saved = dependents.get(d.want.ref);
      // One level deep: their own followers aren't looked at here.
      dependents.delete(d.want.ref);
      const best = candidates(d, trial)[0];
      if (saved) dependents.set(d.want.ref, saved);
      if (!best) {
        total -= 8;
        continue;
      }
      total += Math.min(best.score, 4) - (best.soft ? 2 : 0);
      addToIndex(ix, best.item, d.want.kind);
      trial.set(d.want.ref, best.item);
    }
    ix.placed.length = mark;
    return total * 0.6;
  }

  /** Higher is better: relationships, room to use it, the ways people walk, the designer's wishes. */
  function score(
    t: Intent,
    item: Item,
    soft: boolean,
    anchor: Item | undefined,
    anchorRole: Role | undefined,
    placed: Map<string, Item>,
    free = false,
  ): number {
    const w = t.want;
    const at = centre(item);
    const r = item.rotationY;
    const rel = relationOf(w.kind);
    const role = roleOf(w.kind);
    const fp = itemFootprint(item, w.kind);
    let s = soft ? -6 : 0;
    // Made to a narrower width than asked: only if nothing full-width fits.
    if (Math.abs(itemSize(item, w.kind).w - w.w) > 0.01) s -= 1.5;
    // The designer's wishes: their wall, along it, or their spot.
    if (w.face) {
      const fr = w.face.frame;
      const u = (at.x - fr.a.x) * fr.d.x + (at.y - fr.a.y) * fr.d.y;
      const v = ((at.x - fr.a.x) * fr.n.x + (at.y - fr.a.y) * fr.n.y) * w.face.side;
      const on = u >= w.face.u0 - 1e-6 && u <= w.face.u1 + 1e-6;
      if (on && v > 0 && v < w.d + fr.half + 0.05) {
        s += 1.5 - (w.along === null ? 0 : Math.min(1, Math.abs(u - w.along) * 0.3));
      }
    }
    if (w.at) s -= Math.min(2, Math.hypot(at.x - w.at.x, at.y - w.at.y) * 0.4);
    if (t.zone && input.zoneArea(t.zone).some((p) => pointInPolygon(at, p))) s += 2;
    // Its relationships (P2), as the checks will judge them.
    if (rel?.backs) {
      const back = backSide(fp);
      const gap = roomOff(back, rel.backs.gap + 0.3, solids);
      if (gap > rel.backs.gap + 1e-6) {
        const others = [...placed.values()].map((p) => itemFootprint(p));
        const behind = rel.backs.free ? roomOff(back, rel.backs.free, [...solids, ...others]) : 0;
        // Floating is allowed with room behind, but a wall is better in a small room.
        if (!rel.backs.free || behind < rel.backs.free - 0.005) {
          s -= 8;
          related = false;
        } else s -= 2;
      }
    }
    if (anchor && rel?.faces && rel.faces.focus.includes(anchorRole as Role)) {
      const f = rel.faces;
      const off = offAngle(at, r, centre(anchor));
      if (off > f.angle) {
        s -= 8 + (off - f.angle) * 0.1;
        related = false;
      }
      s -= off * 0.02;
      const front = sideOf(fp, 'front');
      const mid = { x: (front.a.x + front.b.x) / 2, y: (front.a.y + front.b.y) / 2 };
      const dist = polygonGap([mid, mid, mid], itemFootprint(anchor)).d;
      if (dist < f.min || dist > f.max) {
        s -= 8;
        related = false;
      } else s -= Math.abs(dist - (f.min + f.max) / 2.6) * 0.3;
    }
    // A seat faces a sofa from in front of it, never its arm.
    if (anchor && anchorRole === 'sofa' && rel?.faces) {
      if (dotTo(anchor, at) <= itemSize(anchor).d / 2) {
        s -= 8;
        related = false;
      }
    }
    // Chairs evenly round their table: a side with more than its opposite costs.
    if (anchor && role === 'dining-chair') {
      const sideOf2 = (p: Vec2) => {
        const c = Math.cos(-anchor.rotationY);
        const sn = Math.sin(-anchor.rotationY);
        const dx = p.x - anchor.position.x;
        const dy = p.y - anchor.position.z;
        const lx = dx * c - dy * sn;
        const ly = dx * sn + dy * c;
        const { w: aw, d: ad } = itemSize(anchor);
        return Math.abs(lx) / aw > Math.abs(ly) / ad
          ? lx > 0
            ? 'x+'
            : 'x-'
          : ly > 0
            ? 'y+'
            : 'y-';
      };
      const opposite: Record<string, string> = { 'x+': 'x-', 'x-': 'x+', 'y+': 'y-', 'y-': 'y+' };
      const mine = sideOf2(at);
      const seats = [...placed.values()].filter(
        (q) =>
          roleOf(furnitureKind(q.assetId)) === 'dining-chair' &&
          polygonGap(itemFootprint(q), itemFootprint(anchor)).d < 0.4,
      );
      const same = seats.filter((q) => sideOf2(centre(q)) === mine).length;
      const opp = seats.filter((q) => sideOf2(centre(q)) === opposite[mine]).length;
      if (same > opp) s -= 1.5 * (same - opp);
    }
    // A bed's long side against a wall, or a proper way beside it: not a gap pillows fall into.
    if (role === 'bed') {
      for (const side of ['left', 'right'] as const) {
        const g = roomOff(sideOf(fp, side), 0.35, solids);
        if (g > 0.03 && g < 0.3) s -= 2;
      }
    }
    if (anchor && rel?.before) {
      const gap = roomOff(sideOf(itemFootprint(anchor), 'front'), rel.before.max + 1, [fp]);
      if (gap < rel.before.min - 0.005 || gap > rel.before.max + 0.005) {
        s -= 8;
        related = false;
      }
      // Centred on what it serves, unless giving way.
      s -= Math.abs(dotAcross(anchor, at)) * 3;
    }
    if (anchor && (rel?.near || rel?.belongs)) {
      const d = polygonGap(fp, itemFootprint(anchor)).d;
      const within = rel.near?.within ?? rel.belongs?.within ?? 0.3;
      if (d > within) {
        s -= 4 + d;
        related = false;
      }
      if (rel.near?.head && dotTo(anchor, at) >= 0) {
        s -= 4;
        related = false;
      }
    } else if (anchor && !rel?.faces && !rel?.before) {
      // With the piece the designer said it goes with (a console under its TV).
      s -= Math.min(6, polygonGap(fp, itemFootprint(anchor)).d);
    }
    // What it goes with may face it too (the TV the sofa).
    const arel = anchor ? relationOf(furnitureKind(anchor.assetId) ?? w.kind) : undefined;
    if (anchor && arel?.faces?.focus.includes(role)) {
      if (offAngle(centre(anchor), anchor.rotationY, at) > arel.faces.angle) {
        s -= 8;
        related = false;
      }
    }
    if (t.faces === 'window') {
      const win = ix.windows.find(
        (z) => offAngle(at, r, polyCentre(z.poly)) < 50 && distTo(at, z.poly) < 3,
      );
      if (win) s += 2;
    }
    const fb = boxOf(fp);
    const near = (x: { box: { x0: number; y0: number; x1: number; y1: number } }) =>
      !(x.box.x1 < fb.x0 || fb.x1 < x.box.x0 || x.box.y1 < fb.y0 || fb.y1 < x.box.y0);
    // Off the ways people walk, where it can be: a free piece standing on one costs.
    if (free && !w.kind.walkThrough && input.ways?.length) {
      if (input.ways.some((x) => near(x) && overlapDepth(fp, x.poly) > 0.02)) s -= 2.5;
    }
    // A TV or a sofa with no TV wants room in front of it.
    if (role === 'tv' || role === 'tv-console' || (role === 'sofa' && !anchor)) {
      const ahead = roomOff(sideOf(fp, 'front'), 3.5, solids);
      s += Math.min(ahead, 3.5) * 0.6;
    }
    // A dining table with room on each side for its chairs to be pulled out, off the doorways.
    if (role === 'dining-table') {
      const obstacles = [...solids, ...ix.placed.map((p) => p.fp)];
      for (const side of ['front', 'left', 'right'] as const) {
        s += Math.min(roomOff(sideOf(fp, side), 1.0, obstacles), 1.0) * 0.8;
      }
      s += Math.min(roomOff(backSide(fp), 1.0, obstacles), 1.0) * 0.8;
      const d = Math.min(9, ...ix.doorways.map((x) => distTo(at, x.poly)));
      if (d < 1.4) s -= (1.4 - d) * 2;
    }
    // Beds and desks away from the door.
    if ((role === 'bed' || role === 'desk') && ix.doorways.length) {
      const d = Math.min(...ix.doorways.map((x) => distTo(at, x.poly)));
      s += Math.min(d, 2) * 0.3;
    }
    return s;
  }

  // Greedy, going back when a piece has nowhere to go.
  const placed = new Map<string, Item>();
  const chosen: (Candidate | null)[] = order.map(() => null);
  const marks: number[] = [];
  const put = (i: number, c: Candidate | null) => {
    marks[i] = ix.placed.length;
    chosen[i] = c;
    const t = order[i] as Intent;
    if (c) {
      addToIndex(ix, c.item, t.want.kind);
      placed.set(t.want.ref, c.item);
      viewOf(t, c.item, placed);
    }
  };
  /** A seat facing the TV keeps the floor between them for watching (its coffee table aside). */
  function viewOf(t: Intent, item: Item, placed: Map<string, Item>) {
    const a = anchorOf.get(t.want.ref);
    const tv = a && roles.get(a) === 'tv' ? placed.get(a) : undefined;
    const last = ix.placed[ix.placed.length - 1];
    if (!tv || !relationOf(t.want.kind)?.faces || !last || last.id !== item.id) return;
    const front = sideOf(itemFootprint(item, t.want.kind), 'front');
    const tvFront = sideOf(itemFootprint(tv), 'front');
    const mid = { x: (tvFront.a.x + tvFront.b.x) / 2, y: (tvFront.a.y + tvFront.b.y) / 2 };
    const reach = (mid.x - front.a.x) * front.n.x + (mid.y - front.a.y) * front.n.y;
    if (reach <= 0.3) return;
    const off = (p: Vec2) => ({ x: p.x + front.n.x * reach, y: p.y + front.n.y * reach });
    last.zones.push([front.a, front.b, off(front.b), off(front.a)]);
    last.view = true;
  }
  const undoTo = (i: number) => {
    ix.placed.length = marks[i] ?? ix.placed.length;
    for (let j = i; j < order.length; j++) {
      placed.delete((order[j] as Intent).want.ref);
      chosen[j] = null;
    }
  };
  /** Other places for a piece, clear of trouble and unlike its first and each other. */
  const alternatives = (cs: Candidate[]): Candidate[] => {
    const out: Candidate[] = [];
    const first = cs[0];
    for (const c of cs.slice(1)) {
      if (c.soft) continue;
      if (first && !apartPose(first, c, 0.3)) continue;
      if (out.every((o) => apartPose(o, c, 0.3))) out.push(c);
      if (out.length >= ALTS) break;
    }
    return out;
  };
  /** A piece's weight when it is left out: a bed counts for more than any number of lamps. */
  const weight = (t: Intent) => 10 ** (6 - Math.min(6, priorityOf(t.want.kind)));
  /**
   * How good the placements up to `i` are, worst first: pieces short of the room they need
   * (they fail a hard check), then what is left out (by priority), then the score.
   */
  const costOf = (i: number): Cost => {
    let soft = 0;
    let drops = 0;
    let score = 0;
    for (let j = 0; j <= i; j++) {
      const c = chosen[j];
      if (!c) drops += weight(order[j] as Intent);
      else {
        if (c.soft) soft++;
        score += c.score;
      }
    }
    return [soft, drops, -score];
  };
  const better = (p: Cost, q: Cost) =>
    p[0] < q[0] || (p[0] === q[0] && (p[1] < q[1] || (p[1] === q[1] && p[2] < q[2] - 1e-6)));
  /** Puts back a whole set of placements from `j` on. */
  const restore = (j: number, list: (Candidate | null)[]) => {
    undoTo(j);
    list.forEach((c, n) => put(j + n, c));
  };

  for (let i = 0; i < order.length; i++) {
    const t = order[i] as Intent;
    const cs = candidates(t, placed);
    const first = cs[0] ?? null;
    put(i, first);
    // Nowhere for it, or only short of room: try its anchor and the two pieces before it
    // elsewhere, the pieces after them placed again, and keep the whole set only if it is
    // better. A more important piece is never left out to place a less important one.
    if (first && !first.soft) continue;
    let best = { cost: costOf(i), list: chosen.slice(0, i + 1), changed: false };
    const anchorIdx = order.findIndex((o) => o.want.ref === anchorOf.get(t.want.ref));
    const backs = [...new Set([anchorIdx, i - 1, i - 2].filter((j) => j >= 0 && j < i))];
    for (const j of backs) {
      const was = chosen.slice(j, i + 1);
      undoTo(j);
      const alts = alternatives(candidates(order[j] as Intent, placed, true));
      for (const alt of alts) {
        put(j, alt);
        for (let m = j + 1; m <= i; m++) put(m, candidates(order[m] as Intent, placed)[0] ?? null);
        const dropsMore = was.some(
          (c, n) =>
            !!c &&
            !chosen[j + n] &&
            priorityOf((order[j + n] as Intent).want.kind) < priorityOf(t.want.kind),
        );
        const cost = costOf(i);
        if (!dropsMore && better(cost, best.cost)) {
          best = { cost, list: chosen.slice(0, i + 1), changed: true };
        }
        undoTo(j);
      }
      restore(j, was);
    }
    if (best.changed) restore(0, best.list);
  }

  const items: Item[] = [];
  order.forEach((t, i) => {
    const c = chosen[i];
    const name = nameOf(t.want.kind);
    const note = (text: string) => ({ text, ref: t.want.ref, itemId: t.want.id });
    if (!c) {
      dropped.push(
        note(
          t.want.brought
            ? `Your ${t.want.w.toFixed(2)} m ${name} doesn’t fit here: no wall or spot in the room has room for it.`
            : `Left out the ${name}: no wall or spot in the room has room for it.`,
        ),
      );
      return;
    }
    if (c.narrowed) {
      const width = t.want.kind.size.w * c.item.scale.x;
      repaired.push(note(`Made the ${name} ${width.toFixed(2)} m to fit the wall.`));
    }
    if (c.soft) {
      repaired.push(
        note(`The ${name} is short of the room it needs: nowhere in the room has more.`),
      );
    }
    items.push(c.item);
  });
  return { items, repaired, dropped, tries };
}

/** How far a point is ahead of a piece's middle (towards its front). */
function dotTo(it: Item, p: Vec2): number {
  const f = fwd(it.rotationY);
  return (p.x - it.position.x) * f.x + (p.y - it.position.z) * f.y;
}

/** How far a point is to one side of a piece's middle (across its forward line). */
function dotAcross(it: Item, p: Vec2): number {
  const f = fwd(it.rotationY);
  return (p.x - it.position.x) * -f.y + (p.y - it.position.z) * f.x;
}

/** Where chairs go round a table: along its long sides, then at its ends, facing it. */
function chairSlots(table: Item, depth: number): { at: Vec2; r: number }[] {
  const fp = itemFootprint(table);
  const [bl, br, fr, fl] = fp as [Vec2, Vec2, Vec2, Vec2];
  const sides: [Vec2, Vec2][] = [
    [bl, br],
    [fr, fl],
    [br, fr],
    [fl, bl],
  ];
  const len = (s: [Vec2, Vec2]) => Math.hypot(s[1].x - s[0].x, s[1].y - s[0].y);
  const c = centre(table);
  const longFirst = len(sides[0] as [Vec2, Vec2]) >= len(sides[2] as [Vec2, Vec2]);
  const long = (longFirst ? [sides[0], sides[1]] : [sides[2], sides[3]]) as [Vec2, Vec2][];
  const short = (longFirst ? [sides[2], sides[3]] : [sides[0], sides[1]]) as [Vec2, Vec2][];
  const along = (s: [Vec2, Vec2], n: number) => {
    const out: { at: Vec2; r: number }[] = [];
    const L = len(s);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const p = { x: s[0].x + (s[1].x - s[0].x) * t, y: s[0].y + (s[1].y - s[0].y) * t };
      const v = { x: p.x - c.x, y: p.y - c.y };
      const nx = -(s[1].y - s[0].y) / L;
      const ny = (s[1].x - s[0].x) / L;
      const k = nx * v.x + ny * v.y > 0 ? 1 : -1;
      // Out from the edge, the chair a little tucked under.
      const off = depth / 2 - 0.15;
      out.push({
        at: { x: p.x + nx * k * off, y: p.y + ny * k * off },
        r: facing({ x: -nx * k, y: -ny * k }),
      });
    }
    return out;
  };
  const per = Math.max(1, Math.min(3, Math.floor(len(long[0] as [Vec2, Vec2]) / 0.58)));
  const a = along(long[0] as [Vec2, Vec2], per);
  const b = along(long[1] as [Vec2, Vec2], per);
  // Alternate sides, so four chairs at a table for six sit two a side.
  const out: { at: Vec2; r: number }[] = [];
  for (let i = 0; i < per; i++) {
    if (a[i]) out.push(a[i] as { at: Vec2; r: number });
    if (b[i]) out.push(b[i] as { at: Vec2; r: number });
  }
  for (const s of short) out.push(...along(s, 1));
  return out;
}

/** A footprint's back side, facing out behind. */
function backSide(fp: Vec2[]) {
  const [bl, br, , fl] = fp as [Vec2, Vec2, Vec2, Vec2];
  const width = Math.hypot(bl.x - br.x, bl.y - br.y) || 1;
  const depth = Math.hypot(fl.x - bl.x, fl.y - bl.y) || 1;
  return { a: br, b: bl, n: { x: (bl.x - fl.x) / depth, y: (bl.y - fl.y) / depth }, width };
}

function boxOf(poly: Vec2[]) {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const p of poly) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

function polyCentre(p: Vec2[]): Vec2 {
  return p.reduce((a, q) => ({ x: a.x + q.x / p.length, y: a.y + q.y / p.length }), {
    x: 0,
    y: 0,
  });
}

function distTo(p: Vec2, poly: Vec2[]): number {
  if (pointInPolygon(p, poly)) return 0;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Vec2;
    const b = poly[(i + 1) % poly.length] as Vec2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}
