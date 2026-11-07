import { isDraft } from 'immer';
import { z } from 'zod';
import { type Rates, carpentryPrice } from './cost';
import { type FurnitureKind, type StorageClass, furnitureKind, itemSize } from './furniture';
import { pointInPolygon, signedArea } from './geometry';
import { type RoomShape, roomShapes } from './rooms';
import type { Item, Level, Vec2 } from './schema';
import { SHELTER_ROOM } from './structural';
import { type RoomKind, roomKind } from './suggest';

/**
 * The storage meter: what the pieces drawn hold (clothes, shoes, kitchen things, everything
 * else), compared room by room with what a household like this one usually needs. Measured
 * as owners buy and carpenters quote (wardrobe width, shoe shelves, cabinet fronts, cupboard
 * volume), never what's inside a wardrobe. Advice only. Spec: docs/specs/storage-meter.md.
 */

export type StorageMeasure = 'clothes' | 'shoes' | 'kitchen' | 'other';
export const STORAGE_MEASURES: StorageMeasure[] = ['clothes', 'shoes', 'kitchen', 'other'];
export type StorageAmount = 'few' | 'typical' | 'lots';

// The unverified numbers, one place each (spec: "Constants").
/** Shelf width per pair of shoes: the middle of a wardrobe maker's 0.18–0.25 m. */
export const PAIR_WIDTH = 0.22;
/** Shoe shelves' pitch and the plinth under the first (PM). */
export const SHOE_PITCH = 0.18;
export const SHOE_PLINTH = 0.1;
/** Shallower than this, hangers can't hang across: half the width counts. */
export const HANG_MIN_DEPTH = 0.5;
/** Lower than this, a wardrobe is a cupboard (Everything else). */
export const WARDROBE_MIN_HEIGHT = 1.5;
/** A wardrobe taller than `TOP_CABINET_OVER` has top cabinets from this height up. */
export const TOP_CABINET_FROM = 2.1;
export const TOP_CABINET_OVER = 2.2;
/** A kitchen cabinet's shelf or drawer level, and the one the sink takes from a base run. */
export const KITCHEN_LEVEL = 0.35;
export const SINK_LEVEL = 0.8;
/** A shelter or store room: racks on half the floor, 2 m high (PM). */
export const ROOM_STORE_PER_M2 = 1;
/** A shortfall smaller than this isn't priced (a foot run's minimum would overstate it). */
export const PRICE_FROM = 0.15;
/** A bed this wide or wider sleeps two. */
export const DOUBLE_BED = 1.35;
/** A full-height cupboard, 0.6 m deep and 2.4 m tall: m³ per metre of it. */
export const CUPBOARD_PER_M = 0.6 * 2.4;
/** How many of each a room or "also living here" can hold, in the steppers. */
export const MAX_PEOPLE = 6;

/** Store rooms in older flats ("Store", "Storage room", "Storeroom"). */
export const STORE_ROOM = /\bstor(e|age)\b|storeroom/i;

const EPS = 1e-9;

/** Per adult, per child, the household and by people (1, 2, 3–4, 5+): the targets table. */
export const STORAGE_TARGETS: Record<
  StorageAmount,
  {
    adult: { clothes: number; shoes: number };
    child: { clothes: number; shoes: number };
    homeShoes: number;
    kitchen: { base: number; perPerson: number };
    other: [number, number, number, number];
  }
> = {
  few: {
    adult: { clothes: 0.6, shoes: 5 },
    child: { clothes: 0.45, shoes: 3 },
    homeShoes: 4,
    kitchen: { base: 4, perPerson: 1.5 },
    other: [2, 3, 4, 5],
  },
  typical: {
    adult: { clothes: 1, shoes: 8 },
    child: { clothes: 0.6, shoes: 5 },
    homeShoes: 4,
    kitchen: { base: 6, perPerson: 2 },
    other: [4, 6, 8, 10],
  },
  lots: {
    adult: { clothes: 1.8, shoes: 15 },
    child: { clothes: 0.9, shoes: 8 },
    homeShoes: 6,
    kitchen: { base: 8, perPerson: 2.5 },
    other: [5, 8, 10, 12],
  },
};

export interface People {
  adults: number;
  children: number;
}

const NOBODY: People = { adults: 0, children: 0 };
const headcount = (p: People) => p.adults + p.children;

// --- the household (per browser in slice 1) ------------------------------------------------

const count = z
  .number()
  .finite()
  .catch(0)
  .transform((n) => Math.min(MAX_PEOPLE, Math.max(0, Math.round(n))));
const PeopleSchema = z.object({ adults: count, children: count });

/** Who lives here and how much they own, as kept per browser and project. */
export const StorageSetting = z.object({
  /** By room id; a room not here takes its people from its beds. */
  people: z.record(z.string(), PeopleSchema).catch({}),
  /** Also living here, without a bed drawn. */
  others: PeopleSchema.catch({ adults: 0, children: 0 }),
  amount: z.enum(['few', 'typical', 'lots']).catch('typical'),
  /** Count the household shelter as storage. */
  shelter: z.boolean().catch(true),
});
export type StorageSetting = z.infer<typeof StorageSetting>;

export const DEFAULT_STORAGE: StorageSetting = {
  people: {},
  others: { adults: 0, children: 0 },
  amount: 'typical',
  shelter: true,
};

/** A stored setting, read leniently: counts clamped to 0–6, junk replaced by the default. */
export function parseStorageSetting(raw: string | null | undefined): StorageSetting {
  if (!raw) return structuredClone(DEFAULT_STORAGE);
  try {
    const r = StorageSetting.safeParse(JSON.parse(raw));
    return r.success ? r.data : structuredClone(DEFAULT_STORAGE);
  } catch {
    return structuredClone(DEFAULT_STORAGE);
  }
}

/**
 * The household's people with one room's set (null: back to its beds). A room matched to the flat
 * as it is (`alias`, from `matchRooms`) is kept under that room's id, so the flat as it is reads
 * it too, and any entry under its own id goes. With `known` (every room id in the project, both
 * versions), entries for rooms gone are dropped.
 */
export function withRoomPeople(
  all: Record<string, People>,
  roomId: string,
  people: People | null,
  alias?: ReadonlyMap<string, string>,
  known?: ReadonlySet<string>,
): Record<string, People> {
  const key = alias?.get(roomId) ?? roomId;
  const out: Record<string, People> = {};
  for (const [id, p] of Object.entries(all)) {
    if (id === roomId || id === key) continue;
    if (known && !known.has(id)) continue;
    out[id] = { ...p };
  }
  if (people) out[key] = { ...people };
  return out;
}

/** Whether a setting is the default (nothing worth keeping). */
export const isDefaultStorage = (s: StorageSetting) =>
  Object.keys(s.people).length === 0 &&
  headcount(s.others) === 0 &&
  s.amount === 'typical' &&
  s.shelter;

// --- one piece -----------------------------------------------------------------------------

/** What a piece's room is, as far as storage goes. */
export interface RoomCtx {
  kind: RoomKind;
  /** Someone sleeps here: a bedroom, or a room with a bed or people (a studio). */
  sleeps: boolean;
}

export interface PieceStorage {
  itemId: string;
  /** Metres of wardrobe front. */
  clothes: number;
  /** Pairs. */
  shoes: number;
  /** Metres of shelf and drawer front. */
  kitchen: number;
  /** m³. */
  other: number;
  /** The part of `other` in a wardrobe's top cabinets. */
  top: number;
  /** Metres of kitchen cabinet (its width), when it counts as kitchen. */
  cabinets: number;
  /** A tall cabinet in a kitchen, counted as a pantry. */
  pantry?: boolean;
  /** A base run less the sink's level (no sink cabinet on the level). */
  sink?: boolean;
}

/** An uploaded model (a .glb of the person's own): we can't tell what it holds. */
export const isUploadedModel = (kind: FurnitureKind) =>
  !!kind.model?.startsWith('sha256:') && !kind.shape;

/** A bed of any kind: the catalogue's, My furniture's, slice 1b's storage beds. */
export const isBed = (kind: FurnitureKind) => kind.comesFlat === 'bed' || kind.shape === 'bed';

/** How a kind stores, for a piece of this size in this room (My furniture's cabinet by size). */
function classOf(
  kind: FurnitureKind,
  size: { w: number; d: number; h: number },
  ctx: RoomCtx,
): StorageClass | null {
  if (kind.storage) return kind.storage;
  if (kind.shape === 'cabinet') {
    const wardrobe =
      size.h >= WARDROBE_MIN_HEIGHT - EPS && size.d >= HANG_MIN_DEPTH - EPS && ctx.sleeps;
    return wardrobe ? 'hanging' : 'volume';
  }
  return null;
}

/** Shelf or drawer levels in a cabinet `h` high (at least one). */
const levels = (h: number) => Math.max(1, Math.round(h / KITCHEN_LEVEL + EPS));

/**
 * A piece's storage, by its kind and actual size, in a room like `ctx`; null for a piece that
 * holds nothing we count (a bed, a sofa, a desk, an uploaded model).
 */
export function storageOf(item: Item, ctx: RoomCtx): PieceStorage | null {
  const kind = furnitureKind(item.assetId);
  if (!kind || isUploadedModel(kind)) return null;
  const size = itemSize(item, kind);
  const c = classOf(kind, size, ctx);
  if (!c) return null;
  const { w, d, h } = size;
  const out: PieceStorage = {
    itemId: item.id,
    clothes: 0,
    shoes: 0,
    kitchen: 0,
    other: 0,
    top: 0,
    cabinets: 0,
  };
  switch (c) {
    case 'hanging':
      if (h < WARDROBE_MIN_HEIGHT - EPS) {
        out.other = w * d * h;
        break;
      }
      out.clothes = d < HANG_MIN_DEPTH - EPS ? w / 2 : w;
      if (h > TOP_CABINET_OVER + EPS) out.top = out.other = w * d * (h - TOP_CABINET_FROM);
      break;
    case 'folded':
      out.clothes = w / 2;
      break;
    case 'shoes':
      // A tall built-in in a kitchen is a pantry; a free-standing one there still holds shoes.
      if (kind.carpentry && ctx.kind === 'kitchen') {
        out.kitchen = w * Math.max(1, Math.round((h - SHOE_PLINTH) / KITCHEN_LEVEL + EPS));
        out.cabinets = w;
        out.pantry = true;
        break;
      }
      out.shoes =
        Math.floor(w / PAIR_WIDTH + EPS) *
        Math.max(0, Math.floor((h - SHOE_PLINTH) / SHOE_PITCH + EPS));
      break;
    case 'base':
    case 'base-run':
      out.kitchen = w * 2;
      out.cabinets = w;
      break;
    case 'sink':
      out.kitchen = w;
      out.cabinets = w;
      break;
    case 'wall':
      out.kitchen = w * levels(h);
      out.cabinets = w;
      break;
    case 'volume':
      out.other = w * d * h;
      break;
  }
  return out;
}

// --- rooms, cached while only the furniture changes ----------------------------------------

interface Locator {
  walls: Level['walls'];
  vertices: Level['vertices'];
  /** Room ids with a shape, sorted (the first that holds a point wins). */
  ids: string[];
  shapes: Map<string, RoomShape>;
  area: Map<string, number>;
  /** Each item's room, by the item object (Immer keeps it while the item is untouched). */
  itemRoom: WeakMap<Item, string | null>;
}

const locators = new WeakMap<object, Locator>();

const frozen = (level: Level) =>
  !isDraft(level) &&
  Object.isFrozen(level.rooms) &&
  Object.isFrozen(level.walls) &&
  Object.isFrozen(level.vertices);

/**
 * The level's room shapes and each item's room, kept on the identity of its walls, corners
 * and rooms: a drag makes a new level every move but shares those, so tracing the rooms
 * again (the costly part) waits for a change to the walls.
 */
function locator(level: Level): Locator {
  const hit = locators.get(level.rooms);
  if (hit && hit.walls === level.walls && hit.vertices === level.vertices) return hit;
  const shapes = roomShapes(level);
  const ids = [...shapes.keys()].filter((id) => level.rooms[id]).sort();
  const area = new Map<string, number>();
  for (const id of ids) {
    const s = shapes.get(id) as RoomShape;
    area.set(
      id,
      Math.abs(signedArea(s.outer)) - s.holes.reduce((t, h) => t + Math.abs(signedArea(h)), 0),
    );
  }
  const loc: Locator = {
    walls: level.walls,
    vertices: level.vertices,
    ids,
    shapes,
    area,
    itemRoom: new WeakMap(),
  };
  if (frozen(level)) locators.set(level.rooms, loc);
  return loc;
}

function roomOfPoint(loc: Locator, p: Vec2): string | null {
  for (const id of loc.ids) {
    const s = loc.shapes.get(id) as RoomShape;
    if (pointInPolygon(p, s.outer) && !s.holes.some((h) => pointInPolygon(p, h))) return id;
  }
  return null;
}

/**
 * The room a piece stands in: the one holding its footprint's centre; if that's in a wall or
 * a doorway, the room just in front of it. Null: in no room.
 */
export function storageRoomOf(level: Level, item: Item): string | null {
  return roomOfItem(locator(level), item);
}

function roomOfItem(loc: Locator, item: Item): string | null {
  const cached = loc.itemRoom.get(item);
  if (cached !== undefined) return cached;
  const c = { x: item.position.x, y: item.position.z };
  let room = roomOfPoint(loc, c);
  if (!room) {
    const k = itemSize(item).d / 2 + 0.1;
    const front = { x: -Math.sin(item.rotationY), y: Math.cos(item.rotationY) };
    room = roomOfPoint(loc, { x: c.x + front.x * k, y: c.y + front.y * k });
  }
  if (Object.isFrozen(item)) loc.itemRoom.set(item, room);
  return room;
}

/**
 * Who sleeps where, guessed from the beds: a bed 1.35 m wide or wider (queen, king, a wide
 * one of your own) is two adults, a narrower one one. By room id; rooms with no bed are absent.
 */
export function householdFromBeds(level: Level): Record<string, People> {
  return bedsOf(level, locator(level));
}

function bedsOf(level: Level, loc: Locator): Record<string, People> {
  const out: Record<string, People> = {};
  for (const it of Object.values(level.items)) {
    const kind = furnitureKind(it.assetId);
    if (!kind || !isBed(kind)) continue;
    const room = roomOfItem(loc, it);
    if (!room) continue;
    const p = out[room] ?? { adults: 0, children: 0 };
    out[room] = p;
    p.adults += itemSize(it, kind).w >= DOUBLE_BED - EPS ? 2 : 1;
  }
  return out;
}

// --- targets -------------------------------------------------------------------------------

/** What a household of these people usually needs, by measure (zero people: all zero). */
export function storageTargets(
  people: People,
  amount: StorageAmount,
): Record<StorageMeasure, number> {
  const n = headcount(people);
  if (n === 0) return { clothes: 0, shoes: 0, kitchen: 0, other: 0 };
  const t = STORAGE_TARGETS[amount];
  return {
    clothes: clothesTarget(people, amount),
    shoes: people.adults * t.adult.shoes + people.children * t.child.shoes + t.homeShoes,
    kitchen: t.kitchen.base + t.kitchen.perPerson * n,
    other: t.other[n >= 5 ? 3 : n >= 3 ? 2 : n - 1] as number,
  };
}

/** A room's (or the home's) clothes target for these people. */
export function clothesTarget(people: People, amount: StorageAmount): number {
  const t = STORAGE_TARGETS[amount];
  return people.adults * t.adult.clothes + people.children * t.child.clothes;
}

export type StorageStatus = 'enough' | 'nearly' | 'short' | 'none';

export interface Meter {
  have: number;
  /** Absent with nobody to compare with. */
  target?: number;
  /** Enough at 100%, nearly at 80%, short below; `none`: nothing drawn. */
  status?: StorageStatus;
  /** How much more the target asks for (zero when enough). */
  gap?: number;
}

/** Status from have and target, with a little tolerance (1.2 × 1.5 is 1.7999…). */
export function meterStatus(have: number, target: number): Exclude<StorageStatus, 'none'> {
  const r = have / target;
  return r >= 1 - 1e-6 ? 'enough' : r >= 0.8 - 1e-6 ? 'nearly' : 'short';
}

export function meter(have: number, target?: number): Meter {
  if (target === undefined || !(target > 0)) return { have };
  return {
    have,
    target,
    status: have <= EPS ? 'none' : meterStatus(have, target),
    gap: Math.max(0, target - have),
  };
}

/**
 * What a clothes shortfall costs as built-in wardrobe (foot runs at the wardrobe rate); null
 * under `PRICE_FROM`.
 */
export function shortfallPrice(
  shortfall: number,
  rates: Rates,
): { feet: number; low: number; high: number } | null {
  return shortfall >= PRICE_FROM - EPS ? carpentryPrice('wardrobe', shortfall, rates) : null;
}

/** About how wide a full-height cupboard would hold `m3`, to the half metre (at least 0.5). */
export const cupboardFor = (m3: number) =>
  Math.max(0.5, Math.round(m3 / CUPBOARD_PER_M / 0.5) * 0.5);

// --- the report ----------------------------------------------------------------------------

export interface StorageRoom {
  roomId: string;
  name: string;
  kind: RoomKind;
  people: People;
  /** Its people come from its beds (not edited). */
  fromBeds: boolean;
  sleeps: boolean;
  pieces: PieceStorage[];
  /** What it holds, by measure (its pieces and, for a shelter or store, the room itself). */
  totals: Record<StorageMeasure, number>;
  /** For a room with people: its clothes against theirs. */
  clothes?: Meter;
  /** The household shelter or a store room, with its volume (zero if not counted). */
  store?: { kind: 'shelter' | 'store'; volume: number; counted: boolean };
}

export interface StorageReport {
  /** Everyone: by room (beds or edited) and also living here. */
  people: People;
  amount: StorageAmount;
  home: Record<StorageMeasure, Meter>;
  /** Metres of kitchen cabinet across the home (a run's width, not its fronts). */
  cabinets: number;
  /** Rooms in card order: bedrooms, kitchens, living rooms, shelter and store, the rest. */
  rooms: StorageRoom[];
  /** Pieces in no room: the home's totals only. */
  outside: PieceStorage[];
  /** Pieces we can't measure (uploaded models), by item. */
  notCounted: { itemId: string; name: string }[];
  /** The room to put the kitchen chip on: the kitchen with the most front. */
  kitchenRoomId?: string;
  /** Clothes standing where nobody sleeps (and in no room: null), most first. */
  spareClothes: { roomId: string | null; clothes: number }[];
}

const ORDER: Partial<Record<RoomKind, number>> = { kitchen: 1, living: 2 };

const sum = (ps: PieceStorage[], m: StorageMeasure | 'cabinets') =>
  ps.reduce((t, p) => t + p[m], 0);

/**
 * The meter for a level and household. `alias` maps a room id to another to read edited people
 * from (in the renovation: its room in the flat as it is, from `matchRooms`). Same level and
 * household, same report, in the same order.
 */
export function storageReport(
  level: Level,
  setting: StorageSetting,
  alias?: ReadonlyMap<string, string>,
): StorageReport {
  const loc = locator(level);
  const beds = bedsOf(level, loc);
  const rooms = new Map<string, StorageRoom>();
  for (const id of loc.ids) {
    const r = level.rooms[id];
    if (!r) continue;
    const other = alias?.get(id);
    const edited = setting.people[id] ?? (other ? setting.people[other] : undefined);
    const people = edited ? { ...edited } : (beds[id] ?? { ...NOBODY });
    const kind = roomKind(r.name);
    rooms.set(id, {
      roomId: id,
      name: r.name,
      kind,
      people,
      fromBeds: !edited,
      // A bedroom, a room with a bed (a study with a sofa bed), or one whose people were edited:
      // stepped down to nobody, it keeps its steppers and its card.
      sleeps:
        kind === 'bedroom' ||
        headcount(beds[id] ?? NOBODY) > 0 ||
        headcount(people) > 0 ||
        edited !== undefined,
      pieces: [],
      totals: { clothes: 0, shoes: 0, kitchen: 0, other: 0 },
    });
  }

  const outside: PieceStorage[] = [];
  const notCounted: StorageReport['notCounted'] = [];
  const all: PieceStorage[] = [];
  let sinks = 0;
  const items = Object.values(level.items).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const it of items) {
    const kind = furnitureKind(it.assetId);
    if (!kind || isUploadedModel(kind)) {
      notCounted.push({ itemId: it.id, name: kind?.name ?? it.assetId });
      continue;
    }
    if (kind.storage === 'sink') sinks++;
    const roomId = roomOfItem(loc, it);
    const room = roomId ? rooms.get(roomId) : undefined;
    const ps = storageOf(it, room ?? { kind: 'other', sleeps: false });
    if (!ps) continue;
    all.push(ps);
    (room ? room.pieces : outside).push(ps);
  }
  // A base run holds the sink when there's no sink cabinet: one level less, once per level,
  // from the widest run.
  if (sinks === 0) {
    let widest: PieceStorage | undefined;
    for (const p of all) {
      const k = furnitureKind(level.items[p.itemId]?.assetId ?? '');
      if (k?.storage !== 'base-run') continue;
      if (!widest || p.cabinets > widest.cabinets + EPS) widest = p;
    }
    if (widest) {
      widest.kitchen = Math.max(0, widest.kitchen - SINK_LEVEL);
      widest.sink = true;
    }
  }

  const people = { ...setting.others };
  for (const r of rooms.values()) {
    people.adults += r.people.adults;
    people.children += r.people.children;
    for (const m of STORAGE_MEASURES) r.totals[m] = sum(r.pieces, m);
    const shelter = SHELTER_ROOM.test(r.name);
    if (shelter || STORE_ROOM.test(r.name)) {
      const counted = !shelter || setting.shelter;
      const volume = counted ? (loc.area.get(r.roomId) ?? 0) * ROOM_STORE_PER_M2 : 0;
      r.store = { kind: shelter ? 'shelter' : 'store', volume, counted };
      r.totals.other += volume;
    }
    if (headcount(r.people) > 0) {
      r.clothes = meter(r.totals.clothes, clothesTarget(r.people, setting.amount));
    }
  }

  const targets = headcount(people) > 0 ? storageTargets(people, setting.amount) : null;
  const have = (m: StorageMeasure) =>
    sum(outside, m) + [...rooms.values()].reduce((t, r) => t + r.totals[m], 0);
  const home = Object.fromEntries(
    STORAGE_MEASURES.map((m) => [m, meter(have(m), targets?.[m])]),
  ) as Record<StorageMeasure, Meter>;

  const group = (r: StorageRoom) =>
    r.sleeps ? 0 : r.store ? 3 : (ORDER[r.kind] ?? (r.kind === 'none' ? 5 : 4));
  const listed = [...rooms.values()]
    .filter((r) => r.sleeps || r.pieces.length > 0 || r.store)
    .sort(
      (a, b) =>
        group(a) - group(b) ||
        a.name.localeCompare(b.name) ||
        (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0),
    );

  const byFront = (rs: StorageRoom[]) =>
    rs.filter((r) => r.totals.kitchen > EPS).sort((a, b) => b.totals.kitchen - a.totals.kitchen);
  const kitchenRoom =
    byFront(listed.filter((r) => r.kind === 'kitchen'))[0] ?? byFront(listed)[0] ?? undefined;

  const spareClothes: StorageReport['spareClothes'] = listed
    .filter((r) => headcount(r.people) === 0 && r.totals.clothes > EPS)
    .map((r) => ({ roomId: r.roomId as string | null, clothes: r.totals.clothes }));
  const out = sum(outside, 'clothes');
  if (out > EPS) spareClothes.push({ roomId: null, clothes: out });
  spareClothes.sort((a, b) => b.clothes - a.clothes);

  return {
    people,
    amount: setting.amount,
    home,
    cabinets: sum(all, 'cabinets'),
    rooms: listed,
    outside,
    notCounted,
    ...(kitchenRoom ? { kitchenRoomId: kitchenRoom.roomId } : {}),
    spareClothes,
  };
}

/** A piece's entry in the report (with the level's sink rule), if it counts. */
export function pieceIn(report: StorageReport, itemId: string): PieceStorage | undefined {
  for (const r of report.rooms) {
    const p = r.pieces.find((x) => x.itemId === itemId);
    if (p) return p;
  }
  return report.outside.find((x) => x.itemId === itemId);
}

/**
 * What the renovation adds to each of its rooms, by measure: After's room against the room it
 * matches in the flat as it is (`match`, After id to Before id), or all of it for a new room.
 */
export function storageGain(
  before: StorageReport,
  after: StorageReport,
  match: ReadonlyMap<string, string>,
): Map<string, Record<StorageMeasure, number>> {
  const was = new Map(before.rooms.map((r) => [r.roomId, r.totals]));
  const out = new Map<string, Record<StorageMeasure, number>>();
  for (const r of after.rooms) {
    const b = was.get(match.get(r.roomId) ?? '');
    out.set(
      r.roomId,
      Object.fromEntries(STORAGE_MEASURES.map((m) => [m, r.totals[m] - (b?.[m] ?? 0)])) as Record<
        StorageMeasure,
        number
      >,
    );
  }
  return out;
}

/** Rounded as shown: fronts to 0.05 m, volume to 0.1 m³, pairs whole. */
export function storageRound(m: StorageMeasure, v: number): number {
  if (m === 'shoes') return Math.round(v + EPS);
  const step = m === 'other' ? 0.1 : 0.05;
  return Math.round(v / step + EPS) * step;
}
