import { type Side, overlapDepth, polygonGap, roomOff, sideOf } from '../convex';
import { type FurnitureKind, furnitureKind, itemFootprint, itemSize } from '../furniture';
import { pointInPolygon } from '../geometry';
import type { Item, Vec2 } from '../schema';
import { priorityOf } from './catalogue';
import {
  BUILT_IN_MIN,
  type OnFace,
  type Shape,
  type SpaceIndex,
  type Want,
  addToIndex,
  blocking,
  fixedHitOf,
  hitsOf,
  inRooms,
  itemAt,
  keepOutHit,
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
  /** Poses it may try before it stops looking ahead and going back (BUDGET by default). */
  budget?: number;
  /** Whether smaller pieces may be swapped in (the first solve of a space, not a re-solve). */
  swaps?: boolean;
  /** A swap's solve: stop as soon as the dining group can't keep the way (it will be refused). */
  abortTight?: boolean;
}

export interface SolveOutcome {
  items: Item[];
  repaired: Note[];
  dropped: Note[];
  /** Poses tried. */
  tries: number;
  /** Pieces placed short of the room they need (each fails a hard check). */
  soft: number;
  /** Pieces placed breaking one of their relationships (P2: a sofa turned from its TV). */
  broken: number;
  /** Smaller pieces swapped in: a re-solve of the space keeps them (applySwap). */
  swap?: Swap;
  /** How many swaps were tried (0: none needed, or none could help). */
  swapsTried?: number;
  /** Stopped early (abortTight): the dining group couldn't keep the way. */
  aborted?: boolean;
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
  /** Stands in the room another piece needs to be used (it spoils that piece too). */
  intrudes: boolean;
  /** Breaks none of its relationships. */
  related: boolean;
  /** Short of the room needed to walk between them at all (P2 apart, hard). */
  tight: boolean;
  /** The dining group standing on a way through the flat. */
  way: boolean;
}

/**
 * A set of placements' cost, worst first: what the room can't do without left out, pieces
 * short of room, anything else left out (both by priority), -score.
 */
type Cost = [number, number, number, number];

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
/**
 * Poses a solve may try before it stops looking ahead and going back, and keeps the best
 * found so far: a count, not a clock, so the same answer always places the same. The sample's
 * spaces take 200–8,500.
 */
export const BUDGET = 12_000;
/**
 * The swaps' own budget, apart from the first solve's: each swap looks ahead and goes back
 * within SWAP_EACH, and swaps stop once SWAP_BUDGET is spent (at least the first one or two
 * get tried, however crowded the room).
 */
const SWAP_BUDGET = 10_000;
const SWAP_EACH = 5000;
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

/**
 * Footprints of the solver's items, worked out once per item: a pose is scored, checked and
 * looked ahead from many times. Items made here are never changed after.
 */
const fpMemo = new WeakMap<Item, { kind: FurnitureKind | undefined; fp: Vec2[] }>();
function fpOf(item: Item, kind = furnitureKind(item.assetId)): Vec2[] {
  const m = fpMemo.get(item);
  if (m && m.kind === kind) return m.fp;
  const fp = itemFootprint(item, kind);
  if (!m) fpMemo.set(item, { kind, fp });
  return fp;
}

/**
 * A pose of a piece, made once per space and kept for every solve of it (the first, its swaps,
 * the walkway re-solves): the item, and what the walls, doors and windows do to it.
 */
interface Pose {
  item: Item;
  fp: Vec2[];
  on?: OnFace;
  /** Blocked by what is fixed, whatever ways are kept clear (worked out when first tried). */
  base?: boolean;
  /** The ways kept clear it was last checked against, and whether it stands on one. */
  koFor?: Shape[];
  ko?: boolean;
  /** Its key among a piece's candidates (two poses this close are the same place). */
  seen?: string;
  /** What its score takes from the room alone (score), worked out when first needed. */
  room?: PoseRoom;
}

/**
 * The parts of a pose's score that depend on the room alone (its walls, doorways, windows and
 * ways, its zones), not on the pieces placed: each the same however often the pose is scored.
 * The room off a side is the nearer of the walls' and the pieces' (roomOff takes the nearest
 * obstacle), so the walls' part is kept and the pieces' worked out each time.
 */
interface PoseRoom {
  narrow?: boolean;
  /** The designer's wall: what it adds (null: not on it). */
  onFace?: number | null;
  /** The designer's spot: what it takes off. */
  fromAt?: number;
  inZone?: boolean;
  /** Behind it: the room to a wall (backs.gap + 0.3 deep), and to a wall within backs.free. */
  backGap?: number;
  backFree?: number;
  /** A bed's left and right: the room to a wall. */
  bedSides?: [number, number];
  window?: boolean;
  onWay?: boolean;
  /** Ahead of it: the room to a wall (3.5 m deep). */
  ahead?: number;
  /** A dining table's front, left, right and back: the room to a wall (1.0 m deep). */
  sides?: [number, number, number, number];
  /** How far its centre is from the nearest doorway (9 at most: the dining table's). */
  door9?: number;
  door?: number;
}

/** A piece's poses (by its intent, in one space), as candidates() lists them. */
interface PoseCache {
  /** On each face, by the centre's distance along it. */
  wall: Map<Face, Map<number, Pose>>;
  /** A dining table end-on to each face, by the same. */
  turned: Map<Face, Map<number, Pose>>;
  /** Round an anchor at its pose (null: outside the rooms), by the anchor's role. */
  near: WeakMap<Item, Map<Role | undefined, (Pose | null)[]>>;
  /** In its zone. */
  zone?: Pose[];
  /** Each face's stretches clear of openings, for the piece's height. */
  stretches: Map<Face, [number, number][]>;
}
/** Per space (its index), per piece (its intent). */
const poseCaches = new WeakMap<SpaceIndex, WeakMap<Intent, PoseCache>>();
function poseCacheOf(ix: SpaceIndex, t: Intent): PoseCache {
  let per = poseCaches.get(ix);
  if (!per) {
    per = new WeakMap();
    poseCaches.set(ix, per);
  }
  let c = per.get(t);
  if (!c) {
    c = { wall: new Map(), turned: new Map(), near: new WeakMap(), stretches: new Map() };
    per.set(t, c);
  }
  return c;
}
/** A pose made: the item, its footprint remembered. */
function poseOf(item: Item, kind: FurnitureKind, on?: OnFace): Pose {
  const fp = itemFootprint(item, kind);
  fpMemo.set(item, { kind, fp });
  return on ? { item, fp, on } : { item, fp };
}

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
  // the flat: smaller pieces are tried (on a space's first solve only).
  const bad = (items: Item[]) => tightIn(input, items, mark) || diningOnWay(input, items);
  if (input.swaps === false) return first;
  const lost = essentialDrops(first, input.intents, new Set());
  const seats = seatsShort(input, first.items, mark, input.intents);
  const wasBad = bad(first.items);
  // Swaps are tried only where they could help: the way between the groups not kept, the
  // household short of places or seats, or something the room needs left out.
  if (!wasBad && !seats && !lost.size) return first;
  // The swaps' own budget, so a crowded room's long first solve never leaves none for them.
  let spent = 0;
  let tries = first.tries;
  let tried = 0;
  for (const swap of swapsFor(input)) {
    // At least two swaps are tried, however long each takes; then until the budget is spent.
    if (tried >= 2 && spent >= SWAP_BUDGET) break;
    tried++;
    input.ix.placed.length = mark;
    const out = solveOnce({
      ...input,
      intents: swap.intents,
      budget: Math.min(SWAP_EACH, SWAP_BUDGET - spent),
      abortTight: true,
    });
    spent += out.tries;
    tries += out.tries;
    out.tries = tries;
    if (out.aborted) continue;
    const outLost = essentialDrops(out, swap.intents, swap.spare);
    const outSeats = seatsShort(input, out.items, mark, swap.intents);
    // Taken only if it keeps the way, is no worse otherwise (nothing more the room needs left
    // out, no more pieces short of room or turned from what they go with, seats and places at
    // the table as before) and mends something: the way, a seat or place, a piece left out.
    if (
      bad(out.items) ||
      [...outLost].some((ref) => !lost.has(ref)) ||
      out.soft > first.soft ||
      out.broken > first.broken ||
      outSeats > seats ||
      !(wasBad || outSeats < seats || outLost.size < lost.size)
    ) {
      continue;
    }
    return { ...applySwap(out, swap), swapsTried: tried };
  }
  // Nothing smaller helps: the first solve stands, and its checks fail.
  first.tries = tries;
  first.swapsTried = tried;
  input.ix.placed.length = mark;
  const kinds = new Map(input.intents.map((t) => [t.want.id, t.want.kind]));
  for (const item of first.items) {
    const kind = kinds.get(item.id) ?? furnitureKind(item.assetId);
    if (kind) addToIndex(input.ix, item, kind, fpOf(item, kind));
  }
  return first;
}

/**
 * A solve with a swap's lines said, and the extendable table's spare chairs that found no
 * room waiting by the wall (not left out). For a space's re-solves too.
 */
export function applySwap(out: SolveOutcome, swap: Swap): SolveOutcome {
  const waiting = out.dropped.filter((n) => n.ref && swap.spare.has(n.ref));
  const notes = [...swap.notes];
  const n = swap.spare.size;
  if (n) {
    notes.push({
      text: `${n === 1 ? 'One chair waits' : `${n} chairs wait`} by the wall until the table is pulled out.`,
      ref: [...swap.spare][0] as string,
    });
  }
  return {
    ...out,
    dropped: out.dropped.filter((n) => !waiting.includes(n)),
    repaired: [...notes, ...out.repaired],
    swap,
  };
}

/**
 * How many of P1's seat checks a solve fails for the household: places at the dining table
 * (chairs at it, an extendable table with four counted at six) and seats on sofas and chairs.
 */
function seatsShort(input: SolveInput, items: Item[], mark: number, intents: Intent[]): number {
  const household = input.household ?? 0;
  if (!household) return 0;
  const kinds = new Map(intents.map((t) => [t.want.id, t.want]));
  const pieces = [
    ...input.ix.placed
      .slice(0, mark)
      .map((p) => ({ kind: furnitureKind(p.assetId), fp: p.fp, w: 0 })),
    ...items.map((it) => {
      const want = kinds.get(it.id);
      return {
        kind: want?.kind ?? furnitureKind(it.assetId),
        fp: fpOf(it),
        w: want?.w ?? 0,
      };
    }),
  ].filter((p): p is { kind: NonNullable<typeof p.kind>; fp: Vec2[]; w: number } => !!p.kind);
  const role = (p: (typeof pieces)[number]) => roleOf(p.kind);
  const chairs = pieces.filter((p) => role(p) === 'dining-chair');
  let places = 0;
  let tables = 0;
  for (const t of pieces.filter((p) => role(p) === 'dining-table')) {
    tables++;
    const at = chairs.filter((c) => polygonGap(c.fp, t.fp).d <= 0.3).length;
    const most = placesOf(t.kind);
    places +=
      t.kind.id === 'dining-bench-2' || t.kind.id === 'bistro-set'
        ? most
        : t.kind.id === 'dining-extendable' && at >= 4
          ? most
          : Math.min(most, at);
  }
  const seats = pieces
    .filter((p) => role(p) === 'sofa' || role(p) === 'armchair')
    .reduce((n, p) => n + seatsOf(p.kind, p.w || p.kind.size.w), 0);
  return (
    (tables && places < Math.min(household, 6) ? 1 : 0) + (seats < Math.min(household, 3) ? 1 : 0)
  );
}

/** Whether a dining group stands short of 0.60 m from the lounge (pieces solved and fixed). */
function tightIn(input: SolveInput, items: Item[], mark: number): boolean {
  const fixed = input.ix.placed.slice(0, mark).map((p) => ({ assetId: p.assetId, fp: p.fp }));
  const all = [...fixed, ...items.map((it) => ({ assetId: it.assetId, fp: fpOf(it) }))].map(
    (p) => ({ ...p, role: roleOf(furnitureKind(p.assetId)) }),
  );
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
    const fp = fpOf(it, kind);
    const fb = boxOf(fp);
    return (input.ways ?? []).some(
      (x) =>
        !(x.box.x1 < fb.x0 || fb.x1 < x.box.x0 || x.box.y1 < fb.y0 || fb.y1 < x.box.y0) &&
        overlapDepth(fp, x.poly) > 0.02,
    );
  });
}

/**
 * Pieces a room can't do without that a solve left out (by ref): a swap may not add one.
 * `spare`: an extendable table's extra chairs, which may wait by the wall.
 */
function essentialDrops(o: SolveOutcome, intents: Intent[], spare: Set<string>): Set<string> {
  const kinds = new Map(intents.map((t) => [t.want.ref, t.want.kind]));
  return new Set(
    o.dropped.flatMap((n) => {
      const k = n.ref ? kinds.get(n.ref) : undefined;
      return k && n.ref && !spare.has(n.ref) && ESSENTIAL.has(roleOf(k)) ? [n.ref] : [];
    }),
  );
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

export interface Swap {
  intents: Intent[];
  notes: Note[];
  /** Chairs that may wait by the wall (an extendable table's beyond four). */
  spare: Set<string>;
}

/** Smaller pieces to try, in order: the table first, then the sofa, then both. */
function swapsFor(input: SolveInput): Swap[] {
  const { intents } = input;
  const household = input.household ?? 0;
  const role = (t: Intent) => roleOf(t.want.kind);
  const table = intents.find((t) => role(t) === 'dining-table' && relationOf(t.want.kind)?.apart);
  // Any sofa longer than a 2-seat (a 3-seat, a chesterfield) may give way to one.
  const sofa = intents.find(
    (t) => role(t) === 'sofa' && t.want.kind.id !== 'sofa-2' && t.want.w > 1.6,
  );
  const chairsOf = (t: Intent) =>
    intents.filter(
      (c) => role(c) === 'dining-chair' && (c.near === t.want.ref || c.faces === t.want.ref),
    );
  const note = (t: Intent, text: string): Note => ({ text, ref: t.want.ref, itemId: t.want.id });
  const tables: Swap[] = [];
  if (table) {
    const places = placesOf(table.want.kind, table.want.w, table.want.d);
    const chairs = chairsOf(table);
    /**
     * The table as another kind: chairs beyond `keepChairs` aren't placed round it; with
     * `spare` they wait by the wall (said in a line, still the household's chairs).
     */
    const replace = (id: string, keepChairs: number, text: string, spare = false) => {
      const t2 = swapped(table, id);
      if (!t2) return;
      const extra = new Set(chairs.slice(keepChairs).map((c) => c.want.ref));
      tables.push({
        intents: intents.filter((x) => !extra.has(x.want.ref)).map((x) => (x === table ? t2 : x)),
        notes: [note(table, text)],
        spare: spare ? extra : new Set(),
      });
    };
    const name = table.want.kind.name.replace(/^Dining table/, 'dining table');
    // For two, the wall-side table with a bench first: the smallest, the likeliest to fit
    // (the swaps share one budget).
    if (household <= 2 && table.want.kind.id !== 'dining-bench-2') {
      replace(
        'dining-bench-2',
        0,
        `Swapped the ${name} for a wall-side table with a bench for two to keep 0.60 m to the sofa.`,
      );
    }
    if (places >= 6) {
      // Every chair is kept: four round it, the rest wait by the wall till it is pulled out.
      replace(
        'dining-extendable',
        4,
        `Swapped the ${name} for an extendable table to keep 0.60 m to the sofa: it fits 4, and 6 with the table pulled out.`,
        true,
      );
    } else if (table.want.kind.id !== 'pedestal-table-round' && household > 2) {
      // (For two, the bench table is smaller every way: the round table isn't tried.)
      replace(
        'pedestal-table-round',
        4,
        `Swapped the ${name} for a round table for four to keep 0.60 m to the sofa.`,
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
            note(
              sofa,
              `Swapped the ${sofa.want.kind.name.replace(/^(\d)/, '$1').replace(/^([A-Z])/, (c) => c.toLowerCase())} for a 2-seat to keep 0.60 m to the dining table.`,
            ),
          ],
          spare: new Set(),
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
        spare: t.spare,
      });
    }
  }
  return [...tables, ...sofas, ...both];
}

function solveOnce(input: SolveInput): SolveOutcome {
  const budget = input.budget ?? BUDGET;
  const { ix, faces, intents } = input;
  const repaired: Note[] = [];
  const dropped: Note[] = [];
  let tries = 0;
  const byRef = new Map(intents.map((t) => [t.want.ref, t]));
  const roles = new Map(intents.map((t) => [t.want.ref, roleOf(t.want.kind)]));
  const solids = ix.solid.map((x) => x.poly);
  /** Set false by `score` when a pose breaks one of the piece's relationships. */
  let related = true;
  /**
   * Whether walls, doors, windows or the ways kept clear block a pose: the same however often
   * it's tried, so worked out once (what is fixed once per space, the ways once per set kept).
   */
  const fixedBlocks = (p: Pose, kind: FurnitureKind): boolean => {
    p.base ??= fixedHitOf(ix, p.item, kind, p.on, p.fp, []) !== null;
    if (p.base) return true;
    const ko = ix.keepOut;
    if (!ko.length) return false;
    if (p.koFor !== ko) {
      p.koFor = ko;
      p.ko = keepOutHit(ko, kind, p.fp);
    }
    return !!p.ko;
  };

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
    if (!chairs) return fpOf(item, t.want.kind);
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
      const fp = relationOf(t.want.kind)?.apart ? groupOf(t, item) : fpOf(item, t.want.kind);
      for (const [ref, q] of placed) {
        if (!mine.from.includes(roles.get(ref) as Role)) continue;
        short = Math.max(short, mine.gap - polygonGap(fp, fpOf(q)).d);
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
      fp ??= fpOf(item, t.want.kind);
      const other = relationOf(qt.want.kind)?.apart ? groupAt(qt, q) : fpOf(q);
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
    const cache = poseCacheOf(ix, t);
    /** What a pose runs into: what is fixed (remembered), then the pieces placed. */
    const add = (p: Pose, narrowed = false, wish = 0) => {
      tries++;
      if (fixedBlocks(p, k)) return;
      const item = p.item;
      const hs = hitsOf(ix, item, k, p.on, true, p.fp);
      if (blocking(hs)) return;
      p.seen ??= `${item.position.x.toFixed(2)}|${item.position.z.toFixed(2)}|${item.rotationY.toFixed(2)}|${item.scale.x.toFixed(2)}`;
      const key = p.seen;
      if (seen.has(key)) return;
      seen.add(key);
      const soft = hs.length > 0;
      // Short of room to use it, or away from what it goes with, only for what the room can't
      // do without: anything else is left out rather than spoil the room or fail a check.
      const essential = ESSENTIAL.has(roleOf(k));
      if (soft && !essential) return;
      related = true;
      const s = score(t, p, soft, anchor, anchorRole, placed, wish !== 0 || !onWall);
      if (!related && !essential) return;
      // Short of the way between dining and lounge: the less short the better. The dining
      // group kept apart by standing on a way through the flat doesn't count as apart.
      const sh = shortOf(t, item, placed);
      const short = Math.max(0, sh.short);
      const way = sh.dining && !k.walkThrough && onWay(p.fp);
      out.push({
        item,
        soft,
        narrowed,
        short,
        apart: short > EPS || way,
        tight: short > sh.slack + EPS,
        related,
        intrudes: hs.some((h) => h.kind === 'in-zone'),
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
        let stretches = cache.stretches.get(face);
        if (!stretches) {
          stretches = clearStretches(face, bottom, top);
          cache.stretches.set(face, stretches);
        }
        let onIt = cache.wall.get(face);
        if (!onIt) {
          onIt = new Map();
          cache.wall.set(face, onIt);
        }
        let turnedOn = cache.turned.get(face);
        if (!turnedOn) {
          turnedOn = new Map();
          cache.turned.set(face, turnedOn);
        }
        for (const [s0, s1] of stretches) {
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
            // The same u on a face is the same pose (stretches don't overlap).
            let pose = onIt.get(u);
            if (!pose) {
              const at = onFace(face, u, w.d);
              const item = itemAt(w, at.at, at.rotation, width);
              pose = poseOf(item, k, { face, u0: u - width / 2, u1: u + width / 2, bottom, top });
              onIt.set(u, pose);
            }
            add(pose, narrowed, t.against === 'free' && !wallOnly ? -0.5 : 0);
            // A dining table may stand end-on to the wall too, its chairs along both sides.
            if (endOn && !narrowed) {
              let turned = turnedOn.get(u);
              if (!turned) {
                const end = onFace(face, u, w.w);
                turned = poseOf(itemAt(w, end.at, end.rotation + Math.PI / 2, w.w), k);
                turnedOn.set(u, turned);
              }
              add(turned, false, -0.5);
            }
          }
        }
      }
    }

    if (!onWall || facesTv || (t.against === 'free' && !wallOnly) || (!out.length && !wallOnly)) {
      // Free-standing; a little less wished for when the designer asked for a wall.
      const wish = t.against !== 'free' ? -1 : 0;
      // Round its anchor: the same poses whenever the anchor stands here.
      let byRole = anchor ? cache.near.get(anchor) : undefined;
      if (anchor && !byRole) {
        byRole = new Map();
        cache.near.set(anchor, byRole);
      }
      let nearPoses = byRole?.get(anchorRole);
      const poses: { at: Vec2; r: number }[] = [];
      if (anchor && !nearPoses) {
        const a = centre(anchor);
        const af = fwd(anchor.rotationY);
        const afp = fpOf(anchor);
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
      if (anchor && !nearPoses) {
        nearPoses = poses.map((p) =>
          inRooms(ix, p.at) ? poseOf(itemAt(w, p.at, p.r, w.w), k) : null,
        );
        byRole?.set(anchorRole, nearPoses);
      }
      const zonePoses = (): { at: Vec2; r: number }[] => {
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
        return out;
      };
      const tryPoses = (list: (Pose | null)[]) => {
        for (const p of list) if (p) add(p, false, wish);
      };
      // The zone's poses (they don't depend on what is placed): made once per space.
      const tryZone = () => {
        cache.zone ??= zonePoses().map((p) => poseOf(itemAt(w, p.at, p.r, w.w), k));
        for (const p of cache.zone) add(p, false, wish);
      };
      const n = nearPoses?.length ?? 0;
      if (n && anchor && nearPoses) tryPoses(nearPoses);
      else tryZone();
      // Nothing by its anchor: anywhere in its zone.
      if (!out.length && n && anchor && !rel?.belongs) tryZone();
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
    if (deps.length && out.length > 1 && tries < budget) {
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
    addToIndex(ix, c.item, t.want.kind, fpOf(c.item, t.want.kind));
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
      addToIndex(ix, best.item, d.want.kind, fpOf(best.item, d.want.kind));
      trial.set(d.want.ref, best.item);
    }
    ix.placed.length = mark;
    return total * 0.6;
  }

  /** Higher is better: relationships, room to use it, the ways people walk, the designer's wishes. */
  function score(
    t: Intent,
    p: Pose,
    soft: boolean,
    anchor: Item | undefined,
    anchorRole: Role | undefined,
    placed: Map<string, Item>,
    free = false,
  ): number {
    const w = t.want;
    const item = p.item;
    const at = centre(item);
    const r = item.rotationY;
    const rel = relationOf(w.kind);
    const role = roleOf(w.kind);
    const fp = p.fp;
    p.room ??= {};
    const room = p.room;
    let s = soft ? -6 : 0;
    // Made to a narrower width than asked: only if nothing full-width fits.
    room.narrow ??= Math.abs(itemSize(item, w.kind).w - w.w) > 0.01;
    if (room.narrow) s -= 1.5;
    // The designer's wishes: their wall, along it, or their spot.
    if (w.face) {
      if (room.onFace === undefined) {
        const fr = w.face.frame;
        const u = (at.x - fr.a.x) * fr.d.x + (at.y - fr.a.y) * fr.d.y;
        const v = ((at.x - fr.a.x) * fr.n.x + (at.y - fr.a.y) * fr.n.y) * w.face.side;
        const on = u >= w.face.u0 - 1e-6 && u <= w.face.u1 + 1e-6;
        room.onFace =
          on && v > 0 && v < w.d + fr.half + 0.05
            ? 1.5 - (w.along === null ? 0 : Math.min(1, Math.abs(u - w.along) * 0.3))
            : null;
      }
      if (room.onFace !== null) s += room.onFace;
    }
    if (w.at) {
      room.fromAt ??= Math.min(2, Math.hypot(at.x - w.at.x, at.y - w.at.y) * 0.4);
      s -= room.fromAt;
    }
    if (t.zone) {
      room.inZone ??= input.zoneArea(t.zone).some((z) => pointInPolygon(at, z));
      if (room.inZone) s += 2;
    }
    // Its relationships (P2), as the checks will judge them.
    if (rel?.backs) {
      const back = backSide(fp);
      room.backGap ??= roomOff(back, rel.backs.gap + 0.3, solids);
      const gap = room.backGap;
      if (gap > rel.backs.gap + 1e-6) {
        let behind = 0;
        if (rel.backs.free) {
          room.backFree ??= roomOff(back, rel.backs.free, solids);
          const others = [...placed.values()].map((q) => fpOf(q));
          behind = Math.min(room.backFree, roomOff(back, rel.backs.free, others));
        }
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
      const dist = polygonGap([mid, mid, mid], fpOf(anchor)).d;
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
          polygonGap(fpOf(q), fpOf(anchor)).d < 0.4,
      );
      const same = seats.filter((q) => sideOf2(centre(q)) === mine).length;
      const opp = seats.filter((q) => sideOf2(centre(q)) === opposite[mine]).length;
      if (same > opp) s -= 1.5 * (same - opp);
    }
    // A bed's long side against a wall, or a proper way beside it: not a gap pillows fall into.
    if (role === 'bed') {
      room.bedSides ??= [
        roomOff(sideOf(fp, 'left'), 0.35, solids),
        roomOff(sideOf(fp, 'right'), 0.35, solids),
      ];
      for (const g of room.bedSides) if (g > 0.03 && g < 0.3) s -= 2;
    }
    if (anchor && rel?.before) {
      const gap = roomOff(sideOf(fpOf(anchor), 'front'), rel.before.max + 1, [fp]);
      if (gap < rel.before.min - 0.005 || gap > rel.before.max + 0.005) {
        s -= 8;
        related = false;
      }
      // Centred on what it serves, unless giving way.
      s -= Math.abs(dotAcross(anchor, at)) * 3;
    }
    if (anchor && (rel?.near || rel?.belongs)) {
      const d = polygonGap(fp, fpOf(anchor)).d;
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
      s -= Math.min(6, polygonGap(fp, fpOf(anchor)).d);
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
      room.window ??= ix.windows.some(
        (z) => offAngle(at, r, polyCentre(z.poly)) < 50 && distTo(at, z.poly) < 3,
      );
      if (room.window) s += 2;
    }
    // Off the ways people walk, where it can be: a free piece standing on one costs.
    if (free && !w.kind.walkThrough && input.ways?.length) {
      room.onWay ??= onWay(fp);
      if (room.onWay) s -= 2.5;
    }
    // A TV or a sofa with no TV wants room in front of it.
    if (role === 'tv' || role === 'tv-console' || (role === 'sofa' && !anchor)) {
      room.ahead ??= roomOff(sideOf(fp, 'front'), 3.5, solids);
      s += Math.min(room.ahead, 3.5) * 0.6;
    }
    // A dining table with room on each side for its chairs to be pulled out, off the doorways.
    if (role === 'dining-table') {
      const sides = [sideOf(fp, 'front'), sideOf(fp, 'left'), sideOf(fp, 'right'), backSide(fp)];
      room.sides ??= sides.map((sd) => roomOff(sd, 1.0, solids)) as PoseRoom['sides'];
      // The pieces near enough to matter (roomOff passes over the rest).
      const fb = boxOf(fp);
      const pieces: Vec2[][] = [];
      for (const q of ix.placed) {
        const b = q.box;
        if (b.x1 < fb.x0 - 1.001 || fb.x1 + 1.001 < b.x0) continue;
        if (b.y1 < fb.y0 - 1.001 || fb.y1 + 1.001 < b.y0) continue;
        pieces.push(q.fp);
      }
      for (let n = 0; n < 4; n++) {
        const walls = (room.sides as number[])[n] as number;
        const have = pieces.length
          ? Math.min(walls, roomOff(sides[n] as Side, 1.0, pieces))
          : walls;
        s += Math.min(have, 1.0) * 0.8;
      }
      room.door9 ??= Math.min(9, ...ix.doorways.map((x) => distTo(at, x.poly)));
      const d = room.door9;
      if (d < 1.4) s -= (1.4 - d) * 2;
    }
    // Beds and desks away from the door.
    if ((role === 'bed' || role === 'desk') && ix.doorways.length) {
      room.door ??= Math.min(...ix.doorways.map((x) => distTo(at, x.poly)));
      s += Math.min(room.door, 2) * 0.3;
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
      addToIndex(ix, c.item, t.want.kind, fpOf(c.item, t.want.kind));
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
    const front = sideOf(fpOf(item, t.want.kind), 'front');
    const tvFront = sideOf(fpOf(tv), 'front');
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
   * How good the placements up to `i` are, worst first: a piece the room can't do without
   * left out (an essential piece short of room beats leaving it out, as ESSENTIAL says), then
   * pieces short of the room they need (each fails a hard check), then anything else left
   * out (by priority), then the score.
   */
  const costOf = (i: number): Cost => {
    let lost = 0;
    let soft = 0;
    let drops = 0;
    let score = 0;
    for (let j = 0; j <= i; j++) {
      const c = chosen[j];
      const t = order[j] as Intent;
      if (!c) {
        if (ESSENTIAL.has(roleOf(t.want.kind))) lost += weight(t);
        else drops += weight(t);
      } else {
        if (c.soft) soft++;
        // Squeezed into the room another piece needs, it spoils that piece too: worse than
        // leaving it out. A bed short of room is nearly no bed. So three singles squeezed in
        // don't beat two that pass and the bunk-bed hint for the third.
        if (c.intrudes) lost += 1.1 * weight(t);
        else if (c.soft && roleOf(t.want.kind) === 'bed') lost += 0.9 * weight(t);
        score += c.score;
      }
    }
    return [lost, soft, drops, -score];
  };
  /** Strictly better: the first difference decides; scores within 1e-6 are a tie (not better). */
  const better = (p: Cost, q: Cost) => {
    for (let k = 0; k < 3; k++) if (p[k] !== q[k]) return (p[k] as number) < (q[k] as number);
    return (p[3] as number) < (q[3] as number) - 1e-6;
  };
  /** Puts back a whole set of placements from `j` on. */
  const restore = (j: number, list: (Candidate | null)[]) => {
    undoTo(j);
    list.forEach((c, n) => put(j + n, c));
  };

  let aborted = false;
  /** The pieces in the index before this solve (fixed: kept where they are). */
  const fixedCount = ix.placed.length;
  /**
   * A swap whose dining and lounge pieces, all placed, can't keep the way between them (or
   * the dining stands on a way through the flat) is refused whatever comes after: the rest
   * (cabinets, lamps) isn't placed. Checked once, when the last of them is placed.
   */
  const lastGroup = order.reduce(
    (last, t, i) =>
      apartRows.get(t.want.ref) || lounge.has(roles.get(t.want.ref) as Role) ? i : last,
    -1,
  );
  const doomed = (): boolean => {
    const items = [...placed.values()];
    return tightIn(input, items, fixedCount) || diningOnWay(input, items);
  };
  for (let i = 0; i < order.length; i++) {
    if (input.abortTight && i > 0 && i - 1 === lastGroup && doomed()) {
      aborted = true;
      break;
    }
    const t = order[i] as Intent;
    const cs = candidates(t, placed);
    const first = cs[0] ?? null;
    put(i, first);
    // Nowhere for it, or only short of room: try its anchor and the two pieces before it
    // elsewhere, the pieces after them placed again, and keep the whole set only if it is
    // better. A more important piece is never left out to place a less important one.
    if ((first && !first.soft) || tries >= budget) continue;
    let best = { cost: costOf(i), list: chosen.slice(0, i + 1), changed: false };
    const anchorIdx = order.findIndex((o) => o.want.ref === anchorOf.get(t.want.ref));
    const backs = [...new Set([anchorIdx, i - 1, i - 2].filter((j) => j >= 0 && j < i))];
    for (const j of backs) {
      if (tries >= budget) break;
      const was = chosen.slice(j, i + 1);
      undoTo(j);
      const alts = alternatives(candidates(order[j] as Intent, placed, true));
      for (const alt of alts) {
        if (tries >= budget) break;
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

  if (input.abortTight && !aborted && lastGroup === order.length - 1 && doomed()) aborted = true;
  const items: Item[] = [];
  if (aborted) return { items, repaired, dropped, tries, soft: 0, broken: 0, aborted };
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
  return {
    items,
    repaired,
    dropped,
    tries,
    soft: chosen.filter((c) => c?.soft).length,
    broken: chosen.filter((c) => c && !c.related).length,
  };
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
  const fp = fpOf(table);
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
