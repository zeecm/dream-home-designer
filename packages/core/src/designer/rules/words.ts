import { blocks } from '../../clearance';
import { entranceDoor } from '../../delivery';
import { type FurnitureKind, furnitureKind, itemSize } from '../../furniture';
import type { Item, Level } from '../../schema';
import { nameOf } from '../place';
import { type Role, roleOf } from '../principles';
import type { RoomUse } from '../schema';
import { roomsBeside } from '../spaces';
import {
  type Rule,
  type RuleCategory,
  type RuleSubject,
  type RuleTarget,
  ruleNumber,
} from './schema';

/**
 * A rule in the app's words (UX §3.2): built from the rule object, with names resolved on the
 * plan, never from the model's prose, so what the person agrees to is what is checked.
 */

const CATEGORY_WORDS: Record<RuleCategory, string> = {
  tall: 'tall pieces',
  storage: 'storage',
  seating: 'seats',
  beds: 'beds',
  tables: 'tables',
  lighting: 'lights',
  plants: 'plants',
};
const USE_WORDS: Record<RoomUse, string> = {
  master: 'the main bedroom',
  bedroom: 'any bedroom',
  kids: 'the children’s room',
  parents: 'the parents’ room',
  guest: 'the guest room',
  study: 'the study',
  'walk-in': 'the walk-in wardrobe',
  living: 'the living room',
  dining: 'the dining area',
  kitchen: 'the kitchen',
  store: 'the store',
};

const STORAGE: ReadonlySet<Role> = new Set([
  'wardrobe',
  'drawers',
  'shelf',
  'shoe-cabinet',
  'tv-console',
  'console',
]);
const SEATING: ReadonlySet<Role> = new Set([
  'sofa',
  'armchair',
  'dining-chair',
  'desk-chair',
  'stool',
]);
const TABLES: ReadonlySet<Role> = new Set([
  'dining-table',
  'coffee-table',
  'side-table',
  'desk',
  'bedside',
]);

/** Whether a piece is one the subject is about (a catalogue id, a role, a category, or it). */
export function subjectMatches(subject: RuleSubject, it: Item, kind?: FurnitureKind): boolean {
  const k = kind ?? furnitureKind(it.assetId);
  if (!k) return false;
  switch (subject.kind) {
    case 'any':
      return blocks(it);
    case 'item':
      return it.id === subject.itemId;
    case 'kind':
      return it.assetId === subject.kindId || roleOf(k) === subject.kindId;
    case 'category': {
      const role = roleOf(k);
      switch (subject.category) {
        case 'tall':
          return blocks(it) && itemSize(it, k).h >= 1.5;
        case 'storage':
          return STORAGE.has(role) || k.category === 'Storage' || !!k.carpentry;
        case 'seating':
          return SEATING.has(role);
        case 'beds':
          return role === 'bed';
        case 'tables':
          return TABLES.has(role);
        case 'lighting':
          return role === 'light';
        case 'plants':
          return /plant|ficus|monstera|fern/i.test(k.id);
      }
    }
  }
}

/** Whether a kind (a catalogue id or a role) is one of a category (for conflicts). */
export function kindInCategory(kindId: string, category: RuleCategory): boolean {
  const k = furnitureKind(kindId);
  const role = (k ? roleOf(k) : kindId) as Role;
  switch (category) {
    case 'tall':
      return k ? k.size.h >= 1.5 && !k.walkThrough : role === 'wardrobe' || role === 'shelf';
    case 'storage':
      return STORAGE.has(role) || k?.category === 'Storage' || !!k?.carpentry;
    case 'seating':
      return SEATING.has(role);
    case 'beds':
      return role === 'bed';
    case 'tables':
      return TABLES.has(role);
    case 'lighting':
      return role === 'light';
    case 'plants':
      return /plant|ficus|monstera|fern/i.test(kindId);
  }
}

const roleWords = (role: string) => role.replace(/-/g, ' ');

/** A kind in words ("the sofa", "sofas" when there may be several). */
export function kindWords(kindId: string, plural = false): string {
  const k = furnitureKind(kindId);
  const name = k ? nameOf(k) : roleWords(kindId);
  return plural ? `${name}s` : `the ${name}`;
}

/** What a rule is about, in words. */
export function subjectWords(subject: RuleSubject, level: Level, start = false): string {
  let s: string;
  switch (subject.kind) {
    case 'any':
      s = 'nothing';
      break;
    case 'category':
      s = CATEGORY_WORDS[subject.category];
      break;
    case 'kind':
      s = kindWords(subject.kindId);
      break;
    case 'item': {
      const it = level.items[subject.itemId];
      const k = it ? furnitureKind(it.assetId) : undefined;
      s = k ? `this ${nameOf(k)}, in your plan` : 'a piece no longer in your plan';
      break;
    }
  }
  return start ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : s;
}

const roomName = (level: Level, id: string) => level.rooms[id]?.name ?? 'a room no longer there';

/** A door or window in words: "the main door", "Bath/WC 1’s door", "the window in Bedroom". */
export function openingWords(level: Level, openingId: string): string {
  const o = level.openings[openingId];
  if (!o) return 'a door no longer there';
  if (openingId === entranceDoor(level)) return 'the main door';
  const rooms = roomsBeside(level, o.wallId).filter((r): r is string => !!r);
  const names = rooms.map((r) => roomName(level, r));
  if (o.kind === 'window') return names[0] ? `the window in ${names[0]}` : 'the window';
  // A door is said by the room it closes (the bathroom's, not the living room's).
  const pick = names.find((n) => /bath|wc|toilet|bed|study|store|shelter/i.test(n)) ?? names[0];
  return pick ? `${pick}’s door` : 'the door';
}

/** Rooms in a list: "Main bedroom and Bedroom", "A, B and C". */
export function listWords(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Where a rule is about, in words. */
export function targetWords(target: RuleTarget, level: Level): string {
  switch (target.kind) {
    case 'room':
      return roomName(level, target.roomId);
    case 'roomUse':
      return USE_WORDS[target.use];
    case 'wall': {
      const rooms = roomsBeside(level, target.wallId)
        .filter((r): r is string => !!r)
        .map((r) => roomName(level, r));
      return rooms.length === 2
        ? `the wall between ${rooms[0]} and ${rooms[1]}`
        : rooms[0]
          ? `the wall of ${rooms[0]}`
          : 'a wall';
    }
    case 'opening':
      return openingWords(level, target.openingId);
    case 'ownDoor':
      return 'their room’s door';
    case 'window':
      return 'the window';
    case 'kind':
      return kindWords(target.kindId);
    case 'route':
      return `the way from the main door to ${listWords(target.to.map((r) => roomName(level, r)))}`;
    case 'spot':
      return `the spot (${target.r.toFixed(2)} m round)`;
  }
}

const m = (n: number) => `${n.toFixed(2)} m`;

/** The app's sentence for what a rule checks (UX §3.2's table). */
export function ruleSentence(rule: Rule, level: Level): string {
  const n = ruleNumber(rule);
  const target = targetWords(rule.target, level);
  const subject = subjectWords(rule.subject, level, true);
  switch (rule.relation) {
    case 'notIn':
      return rule.subject.kind === 'any'
        ? `Nothing in ${target}${rule.target.kind === 'route' && n ? `, with ${m(n)} clear` : ''}`
        : `No ${subjectWords(rule.subject, level)} in ${target}`;
    case 'in':
      return `${subject} in ${target}`;
    case 'faces':
      return `${subject} faces ${target}`;
    case 'notFaces':
      return `${subject} doesn’t face ${target}`;
    case 'within':
      return `${subject} within ${m(n ?? 0)} of ${target}`;
    case 'atLeast':
      return `${subject} at least ${m(n ?? 0)} from ${target}`;
    case 'against':
      return `${subject} against ${target}`;
    case 'keepClear':
      return rule.target.kind === 'route'
        ? `Keep ${m(n ?? 0)} clear ${target.replace(/^the way /, '')}`
        : `Keep ${n ? `${m(n)} ` : ''}clear ${rule.target.kind === 'opening' ? `in front of ${target}` : target}`;
  }
}
