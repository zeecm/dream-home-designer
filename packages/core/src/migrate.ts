import { ZodError } from 'zod';
import { AFTER_SUFFIX } from './levels';
import { type Level, type Project, SCHEMA_VERSION, parseProject } from './schema';
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
  // 3 adds the optional Wall.side; every version-2 wall stays centred on its line.
  2: (doc) => doc,
  // 4 adds the optional Project.site; without one, north is up and the sun is Singapore's.
  3: (doc) => doc,
  // 5 adds the optional Project.renovation (the "after" of a before/after pair).
  4: (doc) => doc,
  // 6 adds the optional Project.models (furniture models uploaded to the project).
  5: (doc) => doc,
  // 7 adds the optional Wall.build and Wall.glassAbove, and Opening.style, panels, glazed and
  // stack: every version-6 wall is solid, every door a swing door.
  6: (doc) => doc,
  // 8 lets a custom model be a piece by size: an optional hash, and shape, material and
  // diagonal. Every version-7 model has a hash.
  7: (doc) => doc,
  // 9 adds Level.points (electrical points), empty by default.
  8: (doc) => doc,
  // 10 adds the optional Site.lift; a version-9 site has no lift checked.
  9: (doc) => doc,
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
  const repair = (l: Level) => {
    const r = repairLevel(l);
    fixes.push(...r.fixes);
    return r.level;
  };
  const levels = project.levels.map(repair);
  // Every renovation level needs its own id, apart from the plan's, or edits meant for the
  // "after" would land on the "before".
  const taken = new Set(levels.map((l) => l.id));
  const renovation = project.renovation && {
    levels: project.renovation.levels.map((l) => {
      const r = repair(l);
      if (!taken.has(r.id) && r.id.endsWith(AFTER_SUFFIX)) {
        taken.add(r.id);
        return r;
      }
      let id = `${r.id.replace(/~after$/, '')}${AFTER_SUFFIX}`;
      for (let n = 2; taken.has(id); n++) id = `${r.id}${AFTER_SUFFIX}${n}`;
      taken.add(id);
      fixes.push(`Renovation level ${r.id} renamed to ${id}`);
      return { ...r, id };
    }),
  };
  return {
    project: fixes.length ? { ...project, levels, ...(renovation ? { renovation } : {}) } : project,
    fixes,
  };
}

/**
 * Why a file couldn't be opened, in a sentence for a person (not zod's JSON): a newer
 * version, not JSON at all, lift sizes that can't be, or the first part that isn't valid.
 */
export function loadErrorText(e: unknown): string {
  if (e instanceof NewerSchemaError) return e.message;
  if (e instanceof SyntaxError) return 'That file isn’t a Dream Home project (it isn’t JSON).';
  if (e instanceof ZodError) {
    const lift = e.issues.find((i) => i.path[0] === 'site' && i.path[1] === 'lift');
    if (lift) {
      const field = lift.path.slice(2).join(' ');
      const why =
        lift.code === 'custom'
          ? 'the door is wider or taller than the car'
          : lift.code === 'too_small'
            ? `${field} under ${Number(lift.minimum).toFixed(2)} m`
            : lift.code === 'too_big'
              ? `${field} over ${Number(lift.maximum).toFixed(2)} m`
              : `${field || 'the lift'}: ${lift.message.toLowerCase()}`;
      return `That file’s lift sizes aren’t valid (${why}).`;
    }
    const first = e.issues[0];
    const where = first?.path.length ? `${first.path.join(' › ')}: ` : '';
    return `That file isn’t a Dream Home project, or it is damaged (${where}${first?.message.toLowerCase() ?? 'not valid'}).`;
  }
  return `That file isn’t a Dream Home project: ${(e as Error)?.message ?? String(e)}`;
}
