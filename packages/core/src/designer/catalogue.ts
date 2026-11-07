import { FURNITURE, type FurnitureKind, customKind, furnitureKind } from '../furniture';
import type { Project } from '../schema';
import type { RoomKind } from '../suggest';
import { clean } from './util';

/**
 * The catalogue as the designer sees it, and the ids a model answers with mapped back to it.
 * The whole catalogue goes in every prompt's stable prefix (so the prefix is byte-identical
 * across a run's steps and the provider can cache it); each room step's own ask then names
 * the categories that suit that room.
 */

/** Never placed by the designer: figures for scale. */
const NEVER = new Set(['People']);

/** Beds come in their sizes: choose the kind, not a scale. */
export const fixedSize = (k: FurnitureKind) => k.id.startsWith('bed-') || k.shape === 'bed';

const size = (k: FurnitureKind) =>
  `${k.size.w.toFixed(2)}x${k.size.d.toFixed(2)}x${k.size.h.toFixed(2)}`;

function line(k: FurnitureKind): string {
  const flags = [
    k.againstWall ? 'wall' : '',
    k.carpentry ? 'built-in' : '',
    k.ceiling ? 'ceiling' : '',
    fixedSize(k) ? 'fixed-size' : '',
  ].filter(Boolean);
  return [k.id, clean(k.name, 40), k.category, size(k), flags.join(' ')].join('|').trimEnd();
}

/** The catalogue, one kind a line: id|name|category|w x d x h (m)|flags. Then the person's own. */
export function catalogueText(models: Project['models'] = {}): string {
  const builtin = FURNITURE.filter((k) => !NEVER.has(k.category)).map(line);
  const own = Object.values(models ?? {})
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((m) => line(customKind(m)));
  return [
    'id|name|category|w x d x h (m)|flags',
    ...builtin,
    ...(own.length
      ? ['Their own furniture (place these by their id when they suit):', ...own]
      : []),
  ].join('\n');
}

/** The categories (and built-ins) that suit a space, by the kinds of its rooms. */
export function categoriesFor(kinds: RoomKind[]): string[] {
  const out = new Set<string>();
  for (const k of kinds) {
    if (k === 'bedroom') {
      for (const c of ['Bedroom', 'Storage', 'Lighting', 'Decor', 'built-in-wardrobe']) out.add(c);
    } else if (k === 'living') {
      for (const c of [
        'Living',
        'Dining',
        'Storage',
        'Lighting',
        'Decor',
        'built-in-tv-console',
        'built-in-shoe-cabinet',
      ])
        out.add(c);
    } else if (k === 'kitchen') {
      for (const c of ['Kitchen', 'Dining', 'built-in-kitchen-base', 'built-in-kitchen-wall'])
        out.add(c);
    } else if (k === 'study') {
      for (const c of ['desk', 'metal-desk', 'Storage', 'Lighting']) out.add(c);
    } else {
      for (const c of ['Bedroom', 'Living', 'Dining', 'Kitchen', 'Storage', 'Lighting', 'Decor'])
        out.add(c);
      for (const c of ['built-in-wardrobe', 'built-in-shoe-cabinet', 'built-in-tv-console'])
        out.add(c);
    }
  }
  return [...out];
}

const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[\s_]+/g, '-');

/**
 * The catalogue kind a model's `assetId` names: the id exactly, then normalised (case,
 * spaces and underscores), then the person's own models (`mdl_…`) from the project. No
 * guessing beyond that: an unknown id is left out and listed.
 */
export function resolveAsset(raw: string, models: Project['models'] = {}): FurnitureKind | null {
  const own = (id: string | undefined) => {
    const m = id ? models?.[id] : undefined;
    return m ? (furnitureKind(m.id) ?? customKind(m)) : undefined;
  };
  const lower = raw.trim().toLowerCase();
  const found =
    BUILT_IN.get(raw) ??
    own(raw) ??
    BUILT_IN.get(norm(raw)) ??
    own(Object.keys(models ?? {}).find((id) => id.toLowerCase() === lower));
  return found && !NEVER.has(found.category) ? found : null;
}

const BUILT_IN = new Map(FURNITURE.map((k) => [k.id, k]));

/**
 * Which pieces go first when they compete for room: beds (a bedroom is for sleeping, and a
 * bed can't be narrowed), kitchen runs and built-ins, wardrobes and storage, sofas and
 * tables, desks, chairs and side tables, lamps and decor.
 */
export function priorityOf(k: FurnitureKind): number {
  const id = k.id;
  if (k.category === 'Lighting' || k.category === 'Decor') return 6;
  if (id.startsWith('bed-') || k.shape === 'bed') return 0;
  if (k.carpentry || id.startsWith('kitchen-') || id === 'fridge' || id === 'washer') return 1;
  if (/chair|stool|side-table|ottoman|bedside|nightstand/.test(id)) return 5;
  if (/desk/.test(id)) return 4;
  if (/wardrobe|drawers|cabinet|shelf|shelves|bookcase|bookshelf/.test(id)) return 2;
  if (k.category === 'Storage') return 2;
  return 3;
}
