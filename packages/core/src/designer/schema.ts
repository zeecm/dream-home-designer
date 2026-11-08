import { z } from 'zod';
import type { Bounds } from '../geometry';
import { Level } from '../schema';
import { clean } from './util';

/**
 * The AI designer's data: the brief a household fills in, the two answers a model gives
 * (the layout and style for the whole flat, then one per space), and the versions kept in
 * this browser. Answers are checked here, after the provider's own schema check: numbers
 * must be finite and on the plan, enums are matched in any case, over-long text is cut and
 * over-long lists are truncated, each with a note. A piece or an operation that doesn't
 * parse is left out on its own, never the whole answer.
 */

export const RoomUse = z.enum([
  'master',
  'bedroom',
  'kids',
  'parents',
  'guest',
  'study',
  'walk-in',
  'living',
  'dining',
  'kitchen',
  'store',
]);
export type RoomUse = z.infer<typeof RoomUse>;

export const StyleId = z.enum([
  'scandinavian',
  'japandi',
  'warm-modern',
  'minimalist',
  'industrial',
  'luxe',
  'heritage',
]);
export type StyleId = z.infer<typeof StyleId>;

export const STYLE_NAMES: Record<StyleId, string> = {
  scandinavian: 'Scandinavian',
  japandi: 'Japandi',
  'warm-modern': 'Warm modern',
  minimalist: 'Modern minimalist',
  industrial: 'Industrial',
  luxe: 'Modern luxe',
  heritage: 'Heritage (rosewood and Peranakan accents)',
};

export const Child = z.enum(['baby', 'preschool', 'primary', 'teen']);
export const Elder = z.enum(['walks', 'stick', 'frame', 'wheelchair']);
export type Elder = z.infer<typeof Elder>;

/** What the household tells the designer. Remembered per project in this browser. */
export const DesignBrief = z.object({
  household: z.object({
    adults: z.number().int().min(0).max(12),
    children: z.array(Child).max(12),
    elders: z.array(Elder).max(6),
    helper: z.boolean(),
    pets: z.string().max(200),
    text: z.string().max(1000),
  }),
  lifestyle: z.object({
    wfh: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    cooking: z.enum(['light', 'daily', 'heavy']),
    guests: z.boolean(),
  }),
  wishes: z.array(z.string().max(200)).max(20),
  style: z.union([StyleId, z.literal('designer')]),
  colours: z.string().max(300),
  /** Their own ideas for the design, in their words (absent in briefs saved before). */
  ideas: z.string().max(2000).default(''),
  /** S$, the renovation (hacking, carpentry, floors, paint, electrical). Null: not sure. */
  budget: z.object({ low: z.number().min(0), high: z.number().min(0) }).nullable(),
  walls: z.enum(['keep', 'allowed', 'structural']),
  /** Pieces in the flat by id: brought along, or kept where they are; absent: left out. */
  keep: z.object({ items: z.record(z.enum(['bring', 'in-place'])), text: z.string().max(1000) }),
  /** By room id of the starting level. */
  rooms: z.record(
    z.object({
      use: z.union([RoomUse, z.literal('keep'), z.literal('designer')]),
      wish: z.string().max(200),
    }),
  ),
  /**
   * Who sleeps where: room id of the starting level to the people sleeping there (person
   * keys, `peopleOf`). Empty: not said (the checks assume, and say so). Absent in briefs
   * saved before.
   */
  sleeping: z.record(z.array(z.string().max(20)).max(12)).default({}),
  /** What to call each person (by person key), for the checks' lines. */
  names: z.record(z.string().max(40)).default({}),
  electrical: z.boolean(),
  start: z.enum(['after', 'before']),
  quality: z.enum(['thorough', 'quick']),
});
export type DesignBrief = z.infer<typeof DesignBrief>;

export const defaultBrief = (): DesignBrief => ({
  household: { adults: 2, children: [], elders: [], helper: false, pets: '', text: '' },
  lifestyle: { wfh: 0, cooking: 'daily', guests: false },
  wishes: [],
  style: 'designer',
  colours: '',
  ideas: '',
  budget: null,
  walls: 'allowed',
  keep: { items: {}, text: '' },
  rooms: {},
  sleeping: {},
  names: {},
  electrical: true,
  start: 'after',
  quality: 'thorough',
});

// ------------------------------------------------------------------------------- limits

/** How long each answer's texts and lists may be. */
export const LIMITS = {
  name: 40,
  summary: 300,
  mood: 300,
  reason: 160,
  reasons: 5,
  notes: 5,
  roomNotes: 3,
  note: 200,
  intent: 160,
  palette: 6,
  ops: 20,
  items: 40,
  faces: 30,
  ref: 12,
  why: 120,
  id: 40,
  spaceSummary: 160,
} as const;

/** Enum fields matched in any case (a model may answer "Remove_Wall" or "SWING"). */
const ENUM_KEYS = new Set(['op', 'style', 'use', 'against', 'zone']);

/** Enum values lower-cased (and trimmed) wherever their key appears. */
function lowerEnums(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.map(lowerEnums);
  if (raw && typeof raw === 'object') {
    return Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [
        k,
        typeof v === 'string' && ENUM_KEYS.has(k) ? v.trim().toLowerCase() : lowerEnums(v),
      ]),
    );
  }
  return raw;
}

/** Where notes about cut text and truncated lists collect while one answer is parsed. */
interface Ctx {
  notes: Set<string>;
  bounds: Bounds | null;
}

const CUT_NOTE = 'Some of the designer’s text was too long and has been cut.';

const text = (ctx: Ctx, max: number) =>
  z.string().transform((s) => {
    if (s.trim().length > max) ctx.notes.add(CUT_NOTE);
    return clean(s, max);
  });

const finite = z.number().finite();

/** A point on the plan: finite, and no more than a metre outside the plan's bounds. */
const point = (ctx: Ctx) =>
  z
    .object({ x: finite, y: finite })
    .refine(
      (p) =>
        !ctx.bounds ||
        (p.x >= ctx.bounds.min.x - 1 &&
          p.x <= ctx.bounds.max.x + 1 &&
          p.y >= ctx.bounds.min.y - 1 &&
          p.y <= ctx.bounds.max.y + 1),
      { message: 'off the plan' },
    );

/**
 * A list read item by item: entries that don't parse are left out (each counted in a note
 * naming `what`), and entries past `max` are truncated with a note.
 */
function list<T extends z.ZodTypeAny>(
  ctx: Ctx,
  item: T,
  max: number,
  what: string,
  min = 0,
): z.ZodType<z.output<T>[], z.ZodTypeDef, unknown> {
  return z.array(z.unknown()).transform((xs, rc) => {
    const out: z.output<T>[] = [];
    let bad = 0;
    for (const x of xs) {
      const r = item.safeParse(x);
      if (r.success) out.push(r.data);
      else bad++;
    }
    if (bad) {
      ctx.notes.add(
        `${bad} of the designer’s ${what} couldn’t be used (missing or impossible values).`,
      );
    }
    if (out.length > max) {
      ctx.notes.add(
        `The designer suggested more ${what} than we place; the first ${max} are shown.`,
      );
    }
    if (out.length < min) {
      rc.addIssue({ code: z.ZodIssueCode.custom, message: `fewer than ${min} ${what}` });
    }
    return out.slice(0, max);
  });
}

const alias = (ctx: Ctx) => text(ctx, LIMITS.id);

// --------------------------------------------------------------------- layout and style

export const OP_KINDS = [
  'remove_wall',
  'add_wall',
  'half_wall',
  'glass_wall',
  'add_door',
  'remove_opening',
] as const;
export const DOOR_STYLES = ['swing', 'double', 'sliding', 'pocket', 'bifold', 'folding'] as const;
export const PALETTE_USES = ['walls', 'feature', 'wood', 'accent', 'floor'] as const;

const conceptSchemas = (ctx: Ctx) => {
  const Op = z.object({
    op: z.enum(OP_KINDS),
    /** A wall's alias (W3). */
    wall: alias(ctx).nullable(),
    /** An opening's alias (D2). */
    opening: alias(ctx).nullable(),
    a: point(ctx).nullable(),
    b: point(ctx).nullable(),
    height: finite.positive().max(4).nullable(),
    t: finite.min(0).max(1).nullable(),
    width: finite.positive().max(5).nullable(),
    style: z.enum(DOOR_STYLES).nullable(),
  });
  const Swatch = z.object({
    name: text(ctx, LIMITS.name),
    hex: z
      .string()
      .transform((s) => s.trim().toLowerCase())
      .pipe(z.string().regex(/^#[0-9a-f]{6}$/)),
    use: z.enum(PALETTE_USES),
  });
  const ConceptRoom = z.object({
    /** An existing room's alias (R2); null for a room the walls make. */
    room: alias(ctx).nullable(),
    /** A point inside a room the walls make (after them). */
    at: point(ctx).nullable(),
    name: text(ctx, LIMITS.name),
    use: RoomUse,
    intent: text(ctx, LIMITS.intent),
    floor: text(ctx, LIMITS.id),
    paint: text(ctx, LIMITS.id),
  });
  const Bathroom = z.object({
    room: alias(ctx),
    floor: text(ctx, LIMITS.id),
    paint: text(ctx, LIMITS.id),
  });
  const Concept = z.object({
    name: text(ctx, LIMITS.name),
    summary: text(ctx, LIMITS.summary),
    style: z.object({
      name: text(ctx, LIMITS.name),
      mood: text(ctx, LIMITS.mood),
      palette: list(ctx, Swatch, LIMITS.palette, 'colours'),
    }),
    walls: list(ctx, Op, LIMITS.ops, 'wall changes'),
    rooms: list(ctx, ConceptRoom, 30, 'rooms'),
    bathrooms: list(ctx, Bathroom, 10, 'bathrooms'),
    reasons: list(ctx, text(ctx, LIMITS.reason), LIMITS.reasons, 'reasons'),
    notes: list(ctx, text(ctx, LIMITS.note), LIMITS.notes, 'notes'),
  });
  return { Op, Concept };
};

const storeCtx: Ctx = { notes: new Set(), bounds: null };
const stored = conceptSchemas(storeCtx);
/** The layout-and-style answer, as kept (already cut to its limits). */
export const Concept = stored.Concept;
export type Concept = z.output<typeof Concept>;
export type DesignOp = z.output<typeof stored.Op>;
export type ConceptRoom = Concept['rooms'][number];

// ------------------------------------------------------------------------------ a space

/**
 * Where a piece stands, by intent (answers of version 2): against a wall (any, the one with
 * a window, or one without a door), or free-standing.
 */
export const AGAINST = ['wall', 'window-wall', 'not-door-wall', 'free'] as const;
/** The part of a room a piece belongs to. */
export const ZONES = ['sleep', 'lounge', 'dine', 'work', 'entry', 'cook', 'store'] as const;
export type Zone = (typeof ZONES)[number];
/** What a piece faces besides another piece of the answer (by its ref). */
export const FACES = ['room', 'window', 'door'] as const;

const spaceSchemas = (ctx: Ctx) => {
  const Item = z.object({
    ref: text(ctx, LIMITS.ref),
    assetId: text(ctx, 80),
    /** A piece of the flat's (its alias, P3) the brief brings along. */
    keep: alias(ctx).nullable(),
    /** A wall of the space (W4) it backs onto. */
    wall: alias(ctx).nullable(),
    /** Metres from the wall's start (its first end) to the piece's centre; null: centred. */
    along: finite.min(-1).max(40).nullable(),
    /** Its centre, when it stands free. */
    at: point(ctx).nullable(),
    /** Degrees clockwise, a quarter turn at a time; 0: its front faces down the plan (+y). */
    rotation: finite
      .transform((v) => ((Math.round(v) % 360) + 360) % 360)
      .pipe(z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]))
      .nullable(),
    width: finite.positive().max(10).nullable(),
    depth: finite.positive().max(10).nullable(),
    height: finite.positive().max(4).nullable(),
    why: text(ctx, LIMITS.why),
    // Version 2: intent. "wall", "along", "at" and "rotation" are then only preferences.
    against: z.enum(AGAINST).nullable().optional(),
    /** Another piece's ref, or 'room', 'window', 'door'. */
    faces: text(ctx, LIMITS.ref).nullable().optional(),
    /** Another piece's ref it goes beside (a bedside table by its bed, chairs at a table). */
    near: text(ctx, LIMITS.ref).nullable().optional(),
    zone: z.enum(ZONES).nullable().optional(),
  });
  const Face = z.object({ wall: alias(ctx), finish: text(ctx, LIMITS.id) });
  const SpaceDesign = z.object({
    /** 2: pieces by intent, placed by the solver; absent: by position (the first answers). */
    v: z
      .unknown()
      .transform((x) => (Number(x) === 2 ? (2 as const) : undefined))
      .optional(),
    items: list(ctx, Item, LIMITS.items, 'pieces'),
    faces: list(ctx, Face, LIMITS.faces, 'wall finishes'),
    notes: list(ctx, text(ctx, LIMITS.note), LIMITS.roomNotes, 'notes'),
    /** One line on what the layout does, in the household's words (absent in older answers). */
    summary: text(ctx, LIMITS.spaceSummary).default(''),
  });
  return { Item, SpaceDesign };
};

const storedSpace = spaceSchemas(storeCtx);
/** One space's answer, as kept. */
export const SpaceDesign = storedSpace.SpaceDesign;
export type SpaceDesign = z.output<typeof SpaceDesign>;
export type DesignItem = SpaceDesign['items'][number];

export type ParseResult<T> = { ok: true; value: T; notes: string[] } | { ok: false; error: string };

function parseWith<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, ctx: Ctx, raw: unknown) {
  const r = schema.safeParse(lowerEnums(raw));
  if (!r.success) {
    const first = r.error.issues[0];
    return {
      ok: false as const,
      error: `${first?.path.join('.') || 'answer'}: ${first?.message ?? 'not readable'}`,
    };
  }
  return { ok: true as const, value: r.data, notes: [...ctx.notes] };
}

/** A model's layout-and-style answer, checked; `bounds` is the plan's (points ±1 m). */
export function parseConcept(raw: unknown, bounds: Bounds | null): ParseResult<Concept> {
  const ctx: Ctx = { notes: new Set(), bounds };
  return parseWith(conceptSchemas(ctx).Concept, ctx, raw);
}

/** A model's answer for one space, checked; `bounds` is the plan's (points ±1 m). */
export function parseSpaceDesign(raw: unknown, bounds: Bounds | null): ParseResult<SpaceDesign> {
  const ctx: Ctx = { notes: new Set(), bounds };
  return parseWith(spaceSchemas(ctx).SpaceDesign, ctx, raw);
}

// ------------------------------------------------------------------------------ versions

export const Provider = z.enum(['anthropic', 'openai', 'gemini']);
export type Provider = z.infer<typeof Provider>;

/** One request's tokens, as billed: input here excludes what was read from or written to cache. */
export const Usage = z.object({
  step: z.string(),
  provider: Provider,
  model: z.string(),
  /** Prompt tokens at the input rate. */
  input: z.number().int().min(0),
  /** Prompt tokens read from the provider's cache. */
  cachedInput: z.number().int().min(0),
  /** Prompt tokens written to the cache (Claude). */
  cacheWrite: z.number().int().min(0),
  /** Every token billed at the output rate, thinking included. */
  output: z.number().int().min(0),
  /** Of `output`, the thinking, when the provider says. */
  reasoning: z.number().int().min(0).nullable(),
  /** Counted from characters: the request was cut off before its usage arrived. */
  estimated: z.boolean(),
  usd: z.number().min(0).nullable(),
  ms: z.number().min(0),
});
export type Usage = z.infer<typeof Usage>;

export const Aspect = z.enum(['walls', 'furniture', 'built-ins', 'finishes']);
export type Aspect = z.infer<typeof Aspect>;

/** Rooms of the designed level joined by room boundaries, by their sorted ids ("rm_a+rm_b"). */
export type SpaceKey = string;

export const Scope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('aspects'), aspects: z.array(Aspect) }),
  z.object({ kind: z.literal('space'), space: z.string(), aspects: z.array(Aspect) }),
]);
export type Scope = z.infer<typeof Scope>;

export const Lock = z.object({
  space: z.string(),
  aspect: Aspect,
  by: z.enum(['person', 'hand-edit']),
  label: z.string(),
});
export type Lock = z.infer<typeof Lock>;

/** The pseudo-space bathrooms' finishes are accepted under (they get no furniture). */
export const BATHROOMS = 'bathrooms';

export const Part = z.union([
  z.object({ aspect: z.literal('walls') }),
  z.object({
    space: z.string(),
    aspect: z.enum(['furniture', 'built-ins', 'finishes', 'electrical']),
  }),
]);
export type Part = z.infer<typeof Part>;

export const SpaceStatus = z.enum(['done', 'failed', 'cancelled', 'skipped', 'locked', 'copied']);
export type SpaceStatus = z.infer<typeof SpaceStatus>;

/** A version, kept in this browser (never in the project). */
export const Design = z.object({
  id: z.string(),
  projectId: z.string(),
  levelId: z.string(),
  n: z.number().int().positive(),
  name: z.string().max(80),
  parent: z.string().nullable(),
  createdAt: z.string(),
  base: z.object({ variant: z.enum(['before', 'after']), fingerprint: z.string() }),
  /** The level it was designed on, for checking it again and finding hand edits. */
  baseLevel: Level,
  brief: DesignBrief,
  request: z.object({ scope: Scope, feedback: z.string().max(2000), locks: z.array(Lock) }),
  /** The short names the prompts used (W1, D1, R1, P1) and the ids they stand for. */
  aliases: z.record(z.string()),
  concept: Concept.nullable(),
  spaces: z.record(
    z.object({
      name: z.string(),
      status: SpaceStatus,
      design: SpaceDesign.optional(),
      error: z.string().optional(),
      /** Fix rounds its answer took (sent back with the checks it failed), and what they fixed. */
      fixes: z.number().int().min(0).optional(),
      fixed: z.number().int().min(0).optional(),
    }),
  ),
  usage: z.array(Usage),
  /**
   * Checks the person chose to accept anyway (by check key), with the line they were shown.
   * Never an HDB rule. Absent in versions kept before.
   */
  waivers: z.array(z.object({ key: z.string(), text: z.string(), at: z.string() })).default([]),
  /** The conversation's proposal it was accepted from (absent: made by v1's form). */
  from: z
    .object({ conversationId: z.string(), proposalId: z.string(), letter: z.string().max(1) })
    .optional(),
  /**
   * After as accepted (`level`), and as it was just before (`prior`: what the accept itself
   * changed is the difference; records from before it was kept have none).
   */
  accepted: z
    .object({ at: z.string(), parts: z.array(Part), level: Level, prior: Level.optional() })
    .nullable(),
});
export type Design = z.infer<typeof Design>;

/**
 * What `designResult` needs of a version. Its request's `hand-edit` locks keep those parts as
 * the plan has them (see `heldAspects`).
 */
export type DesignInput = Pick<Design, 'id' | 'brief' | 'aliases' | 'concept' | 'spaces'> & {
  request?: Pick<Design['request'], 'locks'>;
};
