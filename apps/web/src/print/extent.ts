import {
  type Bounds,
  type Level,
  type Project,
  type RenovationDiff,
  type Variant,
  planExtent,
  planGeometry,
  renovationDiff,
  variantLevels,
} from '@dhd/core';

/** The level a contractor's sheet prints, the flat as it is, and, for After, what changes. */
export function sheetLevels(
  project: Project,
  variant: Variant,
): { level: Level; before: Level; diff: RenovationDiff | null } | null {
  const v = project.renovation ? variant : 'before';
  const level = variantLevels(project, v)[0];
  const before = project.levels[0];
  if (!level || !before) return null;
  return { level, before, diff: v === 'after' ? renovationDiff(before, level) : null };
}

/**
 * What the sheet's drawing covers, in plan metres: the walls, boundary lines and door swings
 * of the version printed and, in After, the walls it hacks. The sheet's scale comes from it.
 */
export function sheetExtent(project: Project, variant: Variant): Bounds | null {
  const s = sheetLevels(project, variant);
  if (!s) return null;
  return planExtent(planGeometry(s.level), hackedPoints(s.diff));
}

/** The corners of the walls a renovation hacks. */
export const hackedPoints = (diff: RenovationDiff | null) =>
  diff ? diff.demolished.flatMap((s) => s.polygon) : [];
