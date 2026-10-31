import type { Draft, Patch } from 'immer';
import type { Level, Project } from './schema';

/** Before or after a renovation: which of a project's two versions of the flat. */
export type Variant = 'before' | 'after';

/** Added to a level's id for its copy in the renovation, so ids stay unique per project. */
export const AFTER_SUFFIX = '~after';

type HasLevels<L> = { levels: L[]; renovation?: { levels: L[] } | undefined };

/** The level with this id, in the plan as it is or in its renovation. */
export function findLevel<L extends { id: string }>(p: HasLevels<L>, id: string): L | undefined {
  return p.levels.find((l) => l.id === id) ?? p.renovation?.levels.find((l) => l.id === id);
}

/** In a recipe: the level with this id, wherever it is; throws if there's none. */
export function draftLevel(d: Draft<Project>, id: string): Draft<Level> {
  const l = findLevel<Draft<Level>>(d, id);
  if (!l) throw new Error(`level ${id} not found`);
  return l;
}

/** The levels a view shows: the renovation's when asked for and there is one. */
export function variantLevels(p: Pick<Project, 'levels' | 'renovation'>, v: Variant): Level[] {
  return v === 'after' && p.renovation ? p.renovation.levels : p.levels;
}

/**
 * Which version of the flat a history step's patches change: 'after' for the renovation
 * (or starting or ending one), 'before' for the plan's own levels, null for neither (the
 * name, the site, the plan image).
 */
export function touchedVariant(patches: readonly Patch[]): Variant | null {
  // Starting or ending a renovation shows it; an edit to the flat as it is, carried over to
  // the renovation too, is the flat's.
  if (patches.some((p) => p.path[0] === 'renovation' && p.path.length === 1)) return 'after';
  if (patches.some((p) => p.path[0] === 'levels')) return 'before';
  if (patches.some((p) => p.path[0] === 'renovation')) return 'after';
  return null;
}
