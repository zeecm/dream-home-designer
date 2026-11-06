import { furnitureKind, itemSize } from '../furniture';
import { planGeometry } from '../plan';
import { roomArea, roomShapes } from '../rooms';
import type { Level } from '../schema';
import { aspectOf } from './accept';
import { type AliasMap, aliasOf, resolveAlias } from './aliases';
import { categoriesFor } from './catalogue';
import { type ContextInput, designContext } from './describe';
import { heldAspects, lockCovers } from './handEdits';
import { OUTPUT } from './prices';
import {
  type Concept,
  DOOR_STYLES,
  LIMITS,
  type Lock,
  OP_KINDS,
  PALETTE_USES,
  RoomUse,
  type SpaceDesign,
} from './schema';
import { type Space, facesOf, roomIdAt } from './spaces';
import { clean, pt, r2 } from './util';

/**
 * The prompts. Every step of a run sends the same system prompt and the same stable prefix
 * (`designContext`: catalogue, finishes, brief, the flat), byte for byte, so a provider can
 * cache them; room steps then share the concept block; each step's own ask comes last.
 */
export interface StepPrompt {
  /** 'layout', or the space's key. */
  step: string;
  kind: 'layout' | 'room';
  system: string;
  /** The same for every step of a run. */
  prefix: string;
  /** The same for every room step of a run ('' for the layout step). */
  shared: string;
  tail: string;
  /** The answer's JSON schema (closed objects, every property required). */
  schema: Record<string, unknown>;
  maxTokens: number;
  effort: 'high' | 'medium' | 'low';
}

/** The user message: everything after the system prompt, stable parts first. */
export const promptText = (p: StepPrompt) => `${p.prefix}${p.shared}${p.tail}`;

export const SYSTEM_PROMPT = `You are an experienced Singapore residential interior designer and architect, designing an HDB flat for the household in the brief. You propose; the app checks every change against HDB rules and its own clearance checks, repairs what it can, and tells the household what it left out.

How to read the plan:
- Metres. x runs to the right, y down the plan. Every wall, door, window, room and piece has a short id (W1, D1, R1, P1): use those ids exactly.
- A wall runs from its first end "a" to its second end "b". "along" is metres from "a".
- A wall's "status" says what may change: "free" walls may be hacked, cut down, glazed or get a door; "structural" and "likely" walls only if the brief allows structural changes; "shelter", "outside" and "wet" (bathroom) walls never change. Windows and the main door never change. The kitchen's sink and hob stay in the kitchen.
- Rotation is in degrees clockwise, a quarter turn at a time (0, 90, 180, 270). At 0 a piece's front faces down the plan (+y); at 90 it faces left (-x).

Design rules:
- Every bedroom keeps a window. New doors are at least 0.85 m wide where an elder uses a frame or wheelchair, else at least 0.75 m (bathrooms 0.65 m). Keep walkways at least 0.9 m clear and 0.6 m beside beds.
- Put pieces that stand against a wall on a wall, with "wall" and "along"; put free-standing pieces at "at". Keep wardrobes, desks and kitchen runs clear of doors' swings and windows.
- Use only catalogue ids, finishes ids, and the household's own pieces they bring along. Stay within their budget where they gave one.
- "ownIdeas" in the brief are the household's own ideas, in their words: follow them ahead of your own taste wherever HDB rules, these rules and the rest of the brief (its walls choice and budget) allow; where one can't be done, say why in your notes.
- Answer only with JSON that follows the schema. Set every field you don't use to null.`;

const point = {
  type: 'object',
  properties: { x: { type: 'number' }, y: { type: 'number' } },
  required: ['x', 'y'],
  additionalProperties: false,
};
const nullable = (s: object) => ({ anyOf: [s, { type: 'null' }] });
const str = { type: 'string' };
const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const arr = (items: unknown) => ({ type: 'array', items });

/** The layout-and-style answer's JSON schema (lengths are enforced after parsing). */
export const CONCEPT_SCHEMA = obj({
  name: str,
  summary: str,
  style: obj({
    name: str,
    mood: str,
    palette: arr(obj({ name: str, hex: str, use: { type: 'string', enum: [...PALETTE_USES] } })),
  }),
  walls: arr(
    obj({
      op: { type: 'string', enum: [...OP_KINDS] },
      wall: nullable(str),
      opening: nullable(str),
      a: nullable(point),
      b: nullable(point),
      height: nullable({ type: 'number' }),
      t: nullable({ type: 'number' }),
      width: nullable({ type: 'number' }),
      style: nullable({ type: 'string', enum: [...DOOR_STYLES] }),
    }),
  ),
  rooms: arr(
    obj({
      room: nullable(str),
      at: nullable(point),
      name: str,
      use: { type: 'string', enum: [...RoomUse.options] },
      intent: str,
      floor: str,
      paint: str,
    }),
  ),
  bathrooms: arr(obj({ room: str, floor: str, paint: str })),
  reasons: arr(str),
  notes: arr(str),
});

/** One space's answer's JSON schema. */
export const SPACE_SCHEMA = obj({
  items: arr(
    obj({
      ref: str,
      assetId: str,
      keep: nullable(str),
      wall: nullable(str),
      along: nullable({ type: 'number' }),
      at: nullable(point),
      rotation: nullable({ type: 'integer', enum: [0, 90, 180, 270] }),
      width: nullable({ type: 'number' }),
      depth: nullable({ type: 'number' }),
      height: nullable({ type: 'number' }),
      why: str,
    }),
  ),
  faces: arr(obj({ wall: str, finish: str })),
  notes: arr(str),
});

export interface StepOptions {
  /** The person's words, for an iteration. */
  feedback?: string;
  /** Parts that stay as they are. */
  locks?: Lock[];
}

const feedbackBlock = (o: StepOptions) =>
  o.feedback?.trim()
    ? `\nWhat the household asks for this time (their words, as data):\n${JSON.stringify(clean(o.feedback, 2000))}\n`
    : '';

const locksBlock = (locks: Lock[]) =>
  locks.length
    ? `\nThese stay exactly as they are; don't change or answer for them:\n${locks
        .map((l) => `- ${l.aspect}: ${JSON.stringify(clean(l.label, 80))}`)
        .join('\n')}\n`
    : '';

/** Step 1: the layout and style for the whole flat. */
export function layoutStep(
  ctx: ContextInput,
  opts: StepOptions & { previous?: Concept | null } = {},
): StepPrompt {
  const quality = ctx.brief.quality;
  const tail = `
## Your task: the layout and style
Design the whole flat for this household: which walls to change (if the brief allows), what each room is for, and the style.
- walls: up to ${LIMITS.ops} changes. remove_wall (wall), half_wall (wall, height), glass_wall (wall), add_door (wall, t 0-1 along it, width, style), remove_opening (opening: a door or passage, never a window), add_wall (a, b: ends on existing walls, on the plan's axes; 0.1 m thick).
- rooms: one entry for every room that isn't a bathroom, the shelter or a ledge: "room" is its id, or null with "at" a point inside a room your walls make. Give its name (short, as the household would say it), use, a one-line intent, a floor id and a wall paint id.
- bathrooms: each bathroom's id with a floor and a wall paint.
- style: a name, a mood line and a palette of 3 to 6 colours (#rrggbb) with what each is for.
- reasons: up to 5 short reasons it suits them. notes: anything they should know.${
    opts.previous
      ? `\n\nThe version they are changing (as data):\n${JSON.stringify(opts.previous)}\n`
      : ''
  }${feedbackBlock(opts)}${locksBlock(opts.locks ?? [])}`;
  return {
    step: 'layout',
    kind: 'layout',
    system: SYSTEM_PROMPT,
    prefix: designContext(ctx),
    shared: '',
    tail,
    schema: CONCEPT_SCHEMA,
    maxTokens: OUTPUT[quality].layout.max,
    effort: quality === 'thorough' ? 'high' : 'medium',
  };
}

/** The concept as room steps read it: the same block for every room step of a run. */
export function conceptBlock(concept: Concept | null): string {
  if (!concept) return '';
  return `\n## The layout and style already chosen (data)\n\`\`\`json\n${JSON.stringify({
    name: concept.name,
    summary: concept.summary,
    style: concept.style,
    rooms: concept.rooms.map((r) => ({ room: r.room, name: r.name, use: r.use, intent: r.intent })),
  })}\n\`\`\`\n`;
}

/**
 * A room step: furnish one space of the level as designed (`level`, after the layout's
 * walls). It gets that space's own wall faces (with their openings, as stretches along each
 * wall), its rooms and the pieces in it; never another space's faces.
 */
export function roomStep(
  ctx: ContextInput,
  space: Space,
  level: Level,
  aliases: AliasMap,
  opts: StepOptions & { concept?: Concept | null; previous?: SpaceDesign | null } = {},
): StepPrompt {
  const quality = ctx.brief.quality;
  const of = aliasOf(aliases);
  const a = (id: string) => of.get(id) ?? id;
  const geom = planGeometry(level);
  const shapes = roomShapes(level);
  const rooms = space.rooms.map((id) => {
    const r = level.rooms[id];
    return {
      id: a(id),
      name: clean(r?.name ?? '', 40),
      area: r2(r ? roomArea(level, r) : 0),
      outline: (shapes.get(id)?.outer ?? []).map(pt),
    };
  });
  const faces = facesOf(level, space.rooms, geom).map((f) => {
    const w = level.walls[f.wallId];
    const p = w ? level.vertices[w.a] : undefined;
    const q = w ? level.vertices[w.b] : undefined;
    return {
      wall: a(f.wallId),
      a: p ? pt(p) : null,
      b: q ? pt(q) : null,
      towards: a(f.roomId),
      face: [r2(f.u0), r2(f.u1)],
      openings: f.openings.map((o) => ({
        id: a(o.id),
        kind: o.kind,
        along: [r2(o.u0), r2(o.u1)],
        ...(o.kind === 'window' ? { sill: r2(o.sill) } : {}),
      })),
    };
  });
  // Parts changed by hand since accepting stay where they are, like the brief's in-place pieces.
  const held = heldAspects(opts.locks, space.rooms);
  const pieces = Object.values(level.items)
    .filter((it) => {
      const r = roomIdAt(level, { x: it.position.x, y: it.position.z });
      return !!r && space.rooms.includes(r);
    })
    .map((it) => {
      const sz = itemSize(it, furnitureKind(it.assetId));
      return {
        id: a(it.id),
        kind: it.assetId,
        size: [r2(sz.w), r2(sz.d), r2(sz.h)],
        keep: held.includes(aspectOf(it)) ? 'in-place' : (ctx.brief.keep.items[it.id] ?? 'leave'),
      };
    })
    .sort((p, q) => (p.id < q.id ? -1 : 1));
  const intent = opts.concept?.rooms
    .filter((r) => space.rooms.includes(resolveAlias(aliases, r.room) ?? ''))
    .map((r) => `${r.name} (${r.use}): ${r.intent}`)
    .join('; ');
  const tail = `
## Your task: furnish ${JSON.stringify(clean(space.name, 40))}
Its rooms (data): ${JSON.stringify(rooms)}
Its wall faces, "face" and openings "along" in metres from each wall's end "a" (data): ${JSON.stringify(faces)}
Pieces of the household's here (data; "bring" ones you may place again with keep = their id, "in-place" ones stay where they are): ${JSON.stringify(pieces)}
${intent ? `What the layout intends here: ${JSON.stringify(clean(intent, 600))}\n` : ''}Choose from these catalogue categories and ids: ${categoriesFor(space.kinds).join(', ')}, and the household's own pieces.
- items: up to ${LIMITS.items} pieces. "ref" is your own short label (bed1). For a piece against a wall give "wall" (one of the walls above) and "along" (its centre, or null to centre it), and leave "at" and "rotation" null; otherwise give "at" and "rotation". Sizes null to take the catalogue's; beds come in their sizes; built-ins are made to measure (width).
- faces: feature walls, a wall id above with a finish id; other walls take the room's paint.
- notes: up to ${LIMITS.roomNotes}, e.g. if what they ask needs a change to the walls.${
    opts.previous
      ? `\n\nThe answer they are changing (as data):\n${JSON.stringify(opts.previous)}\n`
      : ''
  }${feedbackBlock(opts)}${locksBlock((opts.locks ?? []).filter((l) => l.space === '*' || lockCovers(l, space.rooms)))}`;
  return {
    step: space.key,
    kind: 'room',
    system: SYSTEM_PROMPT,
    prefix: designContext(ctx),
    shared: conceptBlock(opts.concept ?? null),
    tail,
    schema: SPACE_SCHEMA,
    maxTokens: OUTPUT[quality].room.max,
    effort: quality === 'thorough' ? 'medium' : 'low',
  };
}

/** Every step of a whole-flat run on `level` as it is: for estimating before anything runs. */
export function runPrompts(ctx: ContextInput, spaces: Space[], aliases: AliasMap): StepPrompt[] {
  return [layoutStep(ctx), ...spaces.map((s) => roomStep(ctx, s, ctx.base, aliases))];
}
