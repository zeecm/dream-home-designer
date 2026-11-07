import { z } from 'zod';
import { roomShapes } from '../rooms';
import { Level, SCHEMA_VERSION } from '../schema';
import { pointInPolygon } from '../geometry';
import { type DesignCheck, designChecks } from './checks';
import type { Relation } from './principles';
import { DesignBrief } from './schema';

/**
 * Case files: what "This is wrong" saves when the designer gets something wrong, small enough
 * to paste into an issue. A case dropped into `packages/core/src/fixtures/designer/cases/` is
 * a test with no code (cases.test.ts): the app's checks must flag the bad layout on the piece
 * or room pointed at, or the case is marked `known` with why. It holds the plan before and as
 * proposed, the brief, what the person said and pointed at, and the checks' lines; never a
 * key, prices, the plan image or who wrote a comment.
 */
export const CASE_KIND = 'dhd-designer-case';
/** The checks' version a case was made with (bump when a principle changes its lines). */
export const CASE_APP = 'designer-checks-1';
/** A case file stays under this, to paste into an issue. */
export const CASE_MAX_BYTES = 200_000;

export const WRONG = ['missing', 'facing', 'in-the-way', 'doesnt-fit', 'odd', 'other'] as const;
export type Wrong = (typeof WRONG)[number];
export const WRONG_TEXT: Record<Wrong, string> = {
  missing: 'Missing something',
  facing: 'Facing the wrong way',
  'in-the-way': 'In the way',
  'doesnt-fit': 'Doesn’t fit',
  odd: 'Ugly or odd',
  other: 'Other',
};

export const CaseFile = z.object({
  kind: z.literal(CASE_KIND),
  v: z.literal(1),
  title: z.string().max(120),
  what: z.enum(WRONG),
  words: z.string().max(1000),
  /** What the person pointed at (a piece or a room of `proposal`), if anything. */
  pointer: z.object({ itemId: z.string().optional(), roomId: z.string().optional() }).nullable(),
  brief: DesignBrief,
  /** The level the version was made on, and as it proposed it. */
  before: Level,
  proposal: Level,
  /** The checks as they were when the case was made (keys and lines). */
  checks: z.array(z.object({ key: z.string(), text: z.string(), hard: z.boolean() })),
  /** The person's own rules for this home (slice 3), as words. */
  rules: z.array(z.string().max(200)).default([]),
  app: z.string(),
  schemaVersion: z.number().int(),
  /** The provider and model that made the version, if known. */
  model: z.string().nullable(),
  /** No check flags it yet: why, so the suite still passes until a principle covers it. */
  known: z.string().optional(),
});
export type CaseFile = z.infer<typeof CaseFile>;

export interface CaseInput {
  title: string;
  what: Wrong;
  words: string;
  pointer: CaseFile['pointer'];
  brief: DesignBrief;
  before: Level;
  proposal: Level;
  checks: Pick<DesignCheck, 'key' | 'text' | 'hard'>[];
  rules?: string[];
  model?: string | null;
}

/** A level as a case keeps it: the plan only (the image and comments are the project's). */
const plain = (level: Level): Level => Level.parse(structuredClone(level));

/** The case file for what the person says is wrong. */
export function designerCase(input: CaseInput): CaseFile {
  return CaseFile.parse({
    kind: CASE_KIND,
    v: 1,
    title: input.title.slice(0, 120),
    what: input.what,
    words: input.words.slice(0, 1000),
    pointer: input.pointer,
    brief: input.brief,
    before: plain(input.before),
    proposal: plain(input.proposal),
    checks: input.checks.map(({ key, text, hard }) => ({ key, text, hard })),
    rules: input.rules ?? [],
    app: CASE_APP,
    schemaVersion: SCHEMA_VERSION,
    model: input.model ?? null,
  });
}

/** The case as text to copy or save (2-space JSON). */
export const caseText = (c: CaseFile) => `${JSON.stringify(c, null, 1)}\n`;

/**
 * Whether today's checks flag a case's bad layout where the person pointed: hard checks on
 * the piece, on the room (or on a piece in it). With no pointer, any hard check the proposal
 * has that the plan before didn't.
 */
export function checkCase(
  c: CaseFile,
  relations?: Record<string, Relation>,
): { flagged: DesignCheck[]; ok: boolean } {
  const checks = designChecks(c.proposal, { brief: c.brief, ...(relations ? { relations } : {}) });
  const before = new Set(designChecks(c.before, { brief: c.brief }).map((x) => x.key));
  const p = c.pointer;
  const shape = p?.roomId ? roomShapes(c.proposal).get(p.roomId) : undefined;
  const inRoom = (itemId: string | undefined) => {
    const it = itemId ? c.proposal.items[itemId] : undefined;
    return !!it && !!shape && pointInPolygon({ x: it.position.x, y: it.position.z }, shape.outer);
  };
  const flagged = checks.filter(
    (x) =>
      x.hard &&
      (p?.itemId
        ? x.itemId === p.itemId
        : p?.roomId
          ? x.roomId === p.roomId || inRoom(x.itemId)
          : !before.has(x.key)),
  );
  return { flagged, ok: flagged.length > 0 };
}
