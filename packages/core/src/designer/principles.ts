import { type FurnitureKind, furnitureKind } from '../furniture';
import type { Item } from '../schema';
import type { DesignBrief, RoomUse } from './schema';

/**
 * The four layout principles, written once as data (spec: docs/specs/ai-designer-v2.md,
 * "Encoded once"). The checks (checks.ts) and the solver (solve.ts) read these tables; a new
 * piece or room type is covered by a row here, not by new code.
 *
 * - P1, function per room: what each room use must have, should have and must not have,
 *   sized to the household (`PROGRAMMES`, `peopleOf`, `sleepingPlan`).
 * - P2, relationships between pieces: what each kind backs onto, faces, sits near or belongs
 *   to (`RELATIONS`, by `roleOf`).
 * - P3, circulation: the walkways from the main door to every room and to each bed side,
 *   and door swings, kept clear (`CIRCULATION`).
 * - P4, fit and access: no overlaps, nothing into walls, the room in front of a piece to use
 *   it, windows kept clear (`FIT`; the zones are clearance.ts's rules).
 */

/** What a catalogue kind is for, in the principles' words. */
export type Role =
  | 'bed'
  | 'bedside'
  | 'wardrobe'
  | 'drawers'
  | 'desk'
  | 'sofa'
  | 'armchair'
  | 'coffee-table'
  | 'side-table'
  | 'tv'
  | 'tv-console'
  | 'rug'
  | 'dining-table'
  | 'dining-chair'
  | 'stool'
  | 'kitchen'
  | 'fridge'
  | 'washer'
  | 'shoe-cabinet'
  | 'shelf'
  | 'console'
  | 'screen'
  | 'bathroom'
  | 'light'
  | 'decor'
  | 'other';

const ROLE_OF: Record<string, Role> = {
  'bed-single': 'bed',
  'bed-super-single': 'bed',
  'bed-queen': 'bed',
  'bed-king': 'bed',
  bedside: 'bedside',
  'nightstand-painted': 'bedside',
  wardrobe: 'wardrobe',
  'built-in-wardrobe': 'wardrobe',
  'chest-of-drawers': 'drawers',
  desk: 'desk',
  'metal-desk': 'desk',
  'sofa-3': 'sofa',
  'chesterfield-sofa': 'sofa',
  'leather-sofa-rolled': 'sofa',
  'chinese-bench': 'sofa',
  armchair: 'armchair',
  'armchair-wood-leather': 'armchair',
  'lounge-chair': 'armchair',
  'chinese-armchair': 'armchair',
  'coffee-table': 'coffee-table',
  'coffee-table-wood-stone': 'coffee-table',
  'coffee-table-marble': 'coffee-table',
  'chinese-tea-table': 'coffee-table',
  'side-table-two-tier': 'side-table',
  'coffee-table-industrial': 'side-table',
  'side-table-tall': 'side-table',
  'ottoman-leather': 'side-table',
  'chinese-stool': 'stool',
  tv: 'tv',
  'tv-console': 'tv-console',
  'tv-console-slatted': 'tv-console',
  'built-in-tv-console': 'tv-console',
  rug: 'rug',
  'dining-4': 'dining-table',
  'dining-6': 'dining-table',
  'wooden-table': 'dining-table',
  'pedestal-table-round': 'dining-table',
  'bistro-set': 'dining-table',
  'dining-chair': 'dining-chair',
  'dining-chair-upholstered': 'dining-chair',
  'plastic-chair': 'dining-chair',
  'counter-stool': 'stool',
  'bar-stool-backed': 'stool',
  'folding-stool': 'stool',
  'kitchen-base': 'kitchen',
  'kitchen-sink': 'kitchen',
  'kitchen-hob': 'kitchen',
  'kitchen-wall': 'kitchen',
  'built-in-kitchen-base': 'kitchen',
  'built-in-kitchen-wall': 'kitchen',
  fridge: 'fridge',
  washer: 'washer',
  'shoe-cabinet': 'shoe-cabinet',
  'built-in-shoe-cabinet': 'shoe-cabinet',
  bookshelf: 'shelf',
  'shelf-with-drawers': 'shelf',
  'cube-bookcase': 'shelf',
  'steel-shelves': 'shelf',
  'steel-shelves-narrow': 'shelf',
  'chinese-cabinet': 'shelf',
  'chinese-console': 'console',
  'folding-screen': 'screen',
  toilet: 'bathroom',
  vanity: 'bathroom',
};

/** A kind's role: its catalogue row, else its shape (the person's own pieces), else its category. */
export function roleOf(kind: FurnitureKind | undefined | null): Role {
  if (!kind) return 'other';
  const own = ROLE_OF[kind.id];
  if (own) return own;
  if (kind.category === 'Lighting') return 'light';
  if (kind.category === 'Decor') return 'decor';
  if (kind.category === 'Bathroom') return 'bathroom';
  switch (kind.shape) {
    case 'bed':
      return 'bed';
    case 'sofa':
      return 'sofa';
    case 'cabinet':
      return 'shelf';
    case 'table':
      return kind.category === 'Dining' ? 'dining-table' : 'side-table';
    default:
      return 'other';
  }
}

export const roleOfItem = (it: Item, kind = furnitureKind(it.assetId)): Role => roleOf(kind);

// ------------------------------------------------------------------- P2: relationships

/**
 * One kind's relationships. Distances in metres, angles in degrees.
 * - backs: its back on a wall (a gap of at most `gap`), or `free` clear behind it instead; with
 *   `window`, the wall must have a window.
 * - faces: its forward line within `angle` of a piece of `focus`, its front `min`–`max` from
 *   it, nothing taller than `over` between; with no such piece in the space, `clear` in front.
 * - near: within `within` of a piece of `of` (by its head end, with `head`).
 * - belongs: within `within` of a piece of `of`, facing it within `angle`.
 * - before: its nearest edge `min`–`max` from the front of a piece of `of`.
 */
export interface Relation {
  backs?: { gap: number; free?: number; window?: boolean };
  faces?: { focus: Role[]; angle: number; min: number; max: number; over: number; clear: number };
  near?: { of: Role[]; within: number; head?: boolean };
  belongs?: { of: Role[]; within: number; angle: number };
  before?: { of: Role[]; min: number; max: number };
}

/** Each role's relationships (spec table P2). A new kind needs only its row. */
export const RELATIONS: Partial<Record<Role, Relation>> = {
  sofa: {
    faces: { focus: ['tv'], angle: 20, min: 1.8, max: 4.0, over: 1.0, clear: 1.2 },
    backs: { gap: 0.05, free: 0.9 },
  },
  armchair: {
    faces: {
      focus: ['tv', 'coffee-table', 'sofa'],
      angle: 50,
      min: 0.3,
      max: 4.0,
      over: 1.0,
      clear: 0.6,
    },
  },
  tv: {
    backs: { gap: 0.05 },
    faces: { focus: ['sofa'], angle: 30, min: 0, max: 6, over: 9, clear: 0 },
  },
  'tv-console': { backs: { gap: 0.05 } },
  bed: { backs: { gap: 0.05 } },
  wardrobe: { backs: { gap: 0.05 } },
  drawers: { backs: { gap: 0.05 } },
  shelf: { backs: { gap: 0.05 } },
  'shoe-cabinet': { backs: { gap: 0.05 } },
  kitchen: { backs: { gap: 0.05 } },
  fridge: { backs: { gap: 0.1 } },
  washer: { backs: { gap: 0.1 } },
  console: { backs: { gap: 0.05 } },
  'dining-chair': { belongs: { of: ['dining-table', 'desk'], within: 0.3, angle: 45 } },
  desk: { backs: { gap: 0.05, free: 0.8 } },
  bedside: { near: { of: ['bed'], within: 0.15, head: true } },
  'coffee-table': { before: { of: ['sofa'], min: 0.35, max: 0.5 } },
};

/** The relationships of a kind: its own row (`extra`, by kind id, for a new kind) or its role's. */
export function relationOf(
  kind: FurnitureKind,
  extra: Record<string, Relation> = {},
): Relation | undefined {
  return extra[kind.id] ?? RELATIONS[roleOf(kind)];
}

// ------------------------------------------------------------------- P3 and P4: numbers

export const CIRCULATION = {
  /** From the main door to every room. */
  walkway: 0.9,
  /** From a bedroom's door to each usable bed side. */
  bedWay: 0.6,
  /** A corridor (a room this narrow, or named so) keeps everything this shallow. */
  corridorWidth: 1.4,
  corridorDepth: 0.35,
} as const;

export const FIT = {
  /** Overlap allowed between two pieces (a snap's rounding). */
  overlap: 0.02,
  /** Under a window: lower than its sill by this. */
  sill: 0.02,
} as const;

// ----------------------------------------------------------- P1: function per room

export type ProgrammeUse = RoomUse | 'corridor' | 'shelter';

/** What a room use asks of the pieces in it (each implemented once in checks.ts). */
export type Need =
  | 'beds'
  | 'window'
  | 'seats'
  | 'dining'
  | 'desks'
  | 'clothes'
  | 'bedside'
  | 'focus'
  | 'shallow'
  | 'no-bed';

export interface Programme {
  must: Need[];
  should: Need[];
  mustNot: Role[];
}

const BEDROOM: Programme = {
  must: ['beds', 'window'],
  should: ['clothes', 'bedside'],
  mustNot: ['kitchen', 'fridge', 'dining-table'],
};

/** Each room use's programme (spec table P1). */
export const PROGRAMMES: Record<ProgrammeUse, Programme> = {
  master: BEDROOM,
  bedroom: BEDROOM,
  kids: BEDROOM,
  parents: BEDROOM,
  guest: BEDROOM,
  living: { must: ['seats'], should: ['focus'], mustNot: ['bed'] },
  dining: { must: ['dining'], should: [], mustNot: [] },
  study: { must: ['desks'], should: [], mustNot: [] },
  kitchen: { must: [], should: [], mustNot: ['bed', 'sofa'] },
  'walk-in': { must: [], should: [], mustNot: [] },
  store: { must: [], should: [], mustNot: [] },
  corridor: { must: ['shallow'], should: [], mustNot: [] },
  shelter: { must: ['no-bed'], should: [], mustNot: [] },
};

export const BEDROOM_USES = new Set<RoomUse>(['master', 'bedroom', 'kids', 'parents', 'guest']);

/** Seats a piece gives: a sofa one per 0.6 m, a chair one. */
export function seatsOf(kind: FurnitureKind, width = kind.size.w): number {
  const role = roleOf(kind);
  if (role === 'sofa') return Math.max(2, Math.floor(width / 0.6 + 0.01));
  if (role === 'armchair') return 1;
  return 0;
}

/** Places at a dining table. */
export function placesOf(kind: FurnitureKind, width = kind.size.w, depth = kind.size.d): number {
  if (roleOf(kind) !== 'dining-table') return 0;
  if (kind.id === 'bistro-set') return 2;
  const long = Math.max(width, depth);
  return long >= 1.75 ? 6 : 4;
}

/** A bed for two: at least a queen's width. */
export const isDouble = (width: number) => width >= 1.52 - 0.01;

// ------------------------------------------------------------------ the household

export type PersonKind = 'adult' | 'child' | 'elder' | 'helper';

export interface Person {
  /** 'adult-1', 'child-2', 'elder-1', 'helper'. */
  key: string;
  kind: PersonKind;
  /** Their name if the brief gives one, else "Adult 1", "Child 2". */
  name: string;
  /** A child's age band, an elder's mobility. */
  detail: string | null;
}

/** The household as people, in the brief's order. */
export function peopleOf(brief: DesignBrief): Person[] {
  const h = brief.household;
  const names = brief.names ?? {};
  const out: Person[] = [];
  const add = (key: string, kind: PersonKind, label: string, detail: string | null) =>
    out.push({ key, kind, name: names[key]?.trim() || label, detail });
  for (let i = 1; i <= h.adults; i++) add(`adult-${i}`, 'adult', `Adult ${i}`, null);
  h.children.forEach((c, i) => add(`child-${i + 1}`, 'child', `Child ${i + 1}`, c));
  h.elders.forEach((e, i) => add(`elder-${i + 1}`, 'elder', `Elder ${i + 1}`, e));
  if (h.helper) add('helper', 'helper', 'Helper', null);
  return out;
}

export interface SleepingPlan {
  /** People by room id. */
  rooms: Map<string, Person[]>;
  /** Not said in the brief: the checks assumed it. */
  assumed: boolean;
  /** People with no room (said, or more people than bedrooms). */
  unplaced: Person[];
}

/**
 * Who sleeps where: as the brief says, else assumed. Assumed: two adults in the largest
 * bedroom, then one person to each other bedroom, largest first (elders, then children, then
 * other adults); a helper only where the brief says. A bedroom with no one gets one bed.
 */
export function sleepingPlan(
  brief: DesignBrief,
  bedrooms: { id: string; area: number }[],
): SleepingPlan {
  const people = peopleOf(brief);
  const byKey = new Map(people.map((p) => [p.key, p]));
  const said = Object.entries(brief.sleeping ?? {}).filter(([, ps]) => ps.length);
  const rooms = new Map<string, Person[]>();
  if (said.length) {
    const placed = new Set<string>();
    for (const [roomId, keys] of said) {
      const ps = keys.flatMap((k) => {
        const p = byKey.get(k);
        if (!p || placed.has(k)) return [];
        placed.add(k);
        return [p];
      });
      if (ps.length) rooms.set(roomId, ps);
    }
    const unplaced = people.filter((p) => !placed.has(p.key) && p.kind !== 'helper');
    return { rooms, assumed: false, unplaced };
  }
  const order = [...bedrooms].sort((p, q) => q.area - p.area || (p.id < q.id ? -1 : 1));
  const adults = people.filter((p) => p.kind === 'adult');
  const queue = [
    ...people.filter((p) => p.kind === 'elder'),
    ...people.filter((p) => p.kind === 'child'),
  ];
  const [first, ...rest] = order;
  if (first) {
    const couple = adults.slice(0, Math.min(2, adults.length));
    queue.push(...adults.slice(couple.length));
    if (couple.length) rooms.set(first.id, couple);
    else if (queue.length) rooms.set(first.id, [queue.shift() as Person]);
  } else {
    queue.push(...adults);
  }
  for (const r of rest) {
    const p = queue.shift();
    if (p) rooms.set(r.id, [p]);
  }
  return { rooms, assumed: true, unplaced: queue };
}
