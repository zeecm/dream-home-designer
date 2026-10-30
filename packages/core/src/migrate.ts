import { type Project, SCHEMA_VERSION, parseProject } from './schema';
import { repairLevel } from './topology';

/** Thrown for a document written by a newer version of the app than this one. */
export class NewerSchemaError extends Error {
  constructor(readonly found: number) {
    super(
      `This plan was saved by a newer version of Dream Home (format ${found}). Reload the page to update.`,
    );
  }
}

/**
 * Upgrades a stored document to SCHEMA_VERSION, one step at a time. Add an entry for each
 * bump: MIGRATIONS[n] turns a version-n document into version n + 1.
 */
const MIGRATIONS: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>> = {
  // 2 adds the optional Wall.kind ('boundary'); every version-1 wall is a wall as it was.
  1: (doc) => doc,
};

export function migrate(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  let doc = input as Record<string, unknown>;
  let v = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : SCHEMA_VERSION;
  if (v > SCHEMA_VERSION) throw new NewerSchemaError(v);
  while (v < SCHEMA_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`no migration from format ${v}`);
    doc = { ...step(doc), schemaVersion: v + 1 };
    v += 1;
  }
  return doc;
}

/**
 * Everything a loaded document goes through: migrate, validate, then drop references
 * that would break drawing (from old, imported or hand-edited files).
 */
export function loadProject(input: unknown): { project: Project; fixes: string[] } {
  const project = parseProject(migrate(input));
  const fixes: string[] = [];
  const levels = project.levels.map((l) => {
    const r = repairLevel(l);
    fixes.push(...r.fixes);
    return r.level;
  });
  return { project: fixes.length ? { ...project, levels } : project, fixes };
}
