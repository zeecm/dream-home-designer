import { entranceDoor } from '../delivery';
import { furnitureKind, itemSize } from '../furniture';
import { planGeometry } from '../plan';
import { roomArea, roomShapes } from '../rooms';
import type { Level } from '../schema';
import { aspectOf } from './accept';
import { type AliasMap, aliasOf, resolveAlias } from './aliases';
import { categoriesFor } from './catalogue';
import { roomNeeds } from './checks';
import { type ContextInput, designContext } from './describe';
import { compass } from './describe';
import { heldAspects, lockCovers } from './handEdits';
import { OUTPUT } from './prices';
import {
  AGAINST,
  type Concept,
  DOOR_STYLES,
  LIMITS,
  type Lock,
  OP_KINDS,
  PALETTE_USES,
  RoomUse,
  type SpaceDesign,
  ZONES,
} from './schema';
import { type Space, facesOf, roomIdAt, roomsBeside } from './spaces';
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
- Furnishing a room, say what each piece is for and how it relates to the others (against a wall, what it faces, what it goes beside); the app works out the exact place, keeping walkways and the room to use each piece clear, and sends back anything that fails its checks.

Design rules:
- Every bedroom keeps a window, and a bed for each person who sleeps there (a couple: one bed at least 1.52 m wide, or two singles). The living room seats the household; the dining table has a place for each of them (up to 6).
- New doors are at least 0.85 m wide where an elder uses a frame or wheelchair, else at least 0.75 m (bathrooms 0.65 m). Keep walkways at least 0.9 m clear from the main door to every room's door, and 0.6 m beside beds. A sofa faces into the room (the TV 1.8–4 m away), never a wall.
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

/** One space's answer's JSON schema (version 2: pieces by intent). */
export const SPACE_SCHEMA = obj({
  v: { type: 'integer', enum: [2] },
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
      against: { type: 'string', enum: [...AGAINST] },
      faces: nullable(str),
      near: nullable(str),
      zone: nullable({ type: 'string', enum: [...ZONES] }),
    }),
  ),
  faces: arr(obj({ wall: str, finish: str })),
  notes: arr(str),
  summary: str,
});

export interface StepOptions {
  /** The person's words, for an iteration. */
  feedback?: string;
  /** Parts that stay as they are. */
  locks?: Lock[];
}

/** What a fix round sends back: the app's own lines for the checks the answer failed. */
export interface FixRequest {
  round: number;
  /** Each failure, with the piece's ref when it is about one. */
  failures: { ref: string | null; text: string }[];
  /** Where the app placed each piece, in words (`placedWords`). */
  placed?: string[];
}

/**
 * Where the app placed a space's pieces, one line each: the wall it backs onto, or its spot,
 * and which way it faces. So a fix round can say "move the sofa to W12", knowing where it is.
 */
export function placedWords(
  level: Level,
  space: Space,
  refs: Record<string, string>,
  aliases: AliasMap,
  north = 0,
): string[] {
  const of = aliasOf(aliases);
  const faces = facesOf(level, space.rooms);
  const out: string[] = [];
  for (const [id, ref] of Object.entries(refs).sort(([, a], [, b]) => (a < b ? -1 : 1))) {
    const it = level.items[id];
    const kind = it && furnitureKind(it.assetId);
    if (!it || !kind || kind.ceiling) continue;
    const r = roomIdAt(level, { x: it.position.x, y: it.position.z });
    if (!r || !space.rooms.includes(r)) continue;
    const f = { x: -Math.sin(it.rotationY), y: Math.cos(it.rotationY) };
    const sz = itemSize(it, kind);
    // Its back's middle: on a face if it lies on the face's line, within its run.
    const back = { x: it.position.x - (f.x * sz.d) / 2, y: it.position.z - (f.y * sz.d) / 2 };
    const wall = faces.find((fc) => {
      const fr = fc.frame;
      const u = (back.x - fr.a.x) * fr.d.x + (back.y - fr.a.y) * fr.d.y;
      const v = ((back.x - fr.a.x) * fr.n.x + (back.y - fr.a.y) * fr.n.y) * fc.side;
      return Math.abs(v - fr.half) < 0.08 && u >= fc.u0 - 0.05 && u <= fc.u1 + 0.05;
    });
    const where = wall
      ? `against ${of.get(wall.wallId) ?? wall.wallId}`
      : `free at (${r2(it.position.x)}, ${r2(it.position.z)})`;
    out.push(`${ref} (${clean(kind.name, 40)}): ${where}, facing ${compass(f, north)}`);
  }
  return out;
}

const fixBlock = (fix: FixRequest | undefined) =>
  fix?.failures.length
    ? `\n## Fix round ${fix.round}: the app placed your answer above and these checks fail (its words, as data)\n${fix.failures
        .map(
          (f) =>
            `- ${f.ref ? `[${JSON.stringify(clean(f.ref, 12))}] ` : ''}${JSON.stringify(clean(f.text, 200))}`,
        )
        .join(
          '\n',
        )}\n${fix.placed?.length ? `Where the app placed your pieces (data):\n${fix.placed.map((l) => `- ${JSON.stringify(clean(l, 120))}`).join('\n')}\n` : ''}Answer again for the whole space so that they pass: move, turn, swap or drop the pieces named (a smaller piece, another wall), keep what works, and say in notes what you couldn't fix and why.\n`
    : '';

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
  opts: StepOptions & {
    concept?: Concept | null;
    previous?: SpaceDesign | null;
    fix?: FixRequest;
  } = {},
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
    const beyond = roomsBeside(level, f.wallId)[f.side === 1 ? 1 : 0];
    return {
      wall: a(f.wallId),
      a: p ? pt(p) : null,
      b: q ? pt(q) : null,
      towards: a(f.roomId),
      // Which way a piece backed onto it looks, and what is behind the wall.
      looks: compass({ x: f.frame.n.x * f.side, y: f.frame.n.y * f.side }, ctx.site?.north ?? 0),
      behind: beyond ? a(beyond) : 'outside',
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
  // The ways people walk through it: the main door and every doorway of its rooms.
  const main = entranceDoor(level, geom);
  const doorways = [
    ...new Set(
      faces.flatMap((f) => f.openings.filter((o) => o.kind !== 'window').map((o) => o.id)),
    ),
  ];
  const ways = doorways.length
    ? `Walkways (the app keeps them clear, 0.9 m): ${main && doorways.includes(a(main)) ? `in from the main door ${a(main)}, ` : ''}to and from ${doorways.join(', ')}.\n`
    : '';
  const uses = Object.fromEntries(
    (opts.concept?.rooms ?? []).flatMap((r) => {
      const id = resolveAlias(aliases, r.room);
      return id ? [[id, r.use]] : [];
    }),
  );
  const needs = roomNeeds(level, space.rooms, { brief: ctx.brief, uses });
  const intent = opts.concept?.rooms
    .filter((r) => space.rooms.includes(resolveAlias(aliases, r.room) ?? ''))
    .map((r) => `${r.name} (${r.use}): ${r.intent}`)
    .join('; ');
  const tail = `
## Your task: furnish ${JSON.stringify(clean(space.name, 40))}
Its rooms (data): ${JSON.stringify(rooms)}
Its wall faces, "face" and openings "along" in metres from each wall's end "a" (data): ${JSON.stringify(faces)}
Pieces of the household's here (data; "bring" ones you may place again with keep = their id, "in-place" ones stay where they are): ${JSON.stringify(pieces)}
${intent ? `What the layout intends here: ${JSON.stringify(clean(intent, 600))}\n` : ''}${needs.length ? `What it must have (the app checks): ${JSON.stringify(needs)}\n` : ''}${ways}Choose from these catalogue categories and ids: ${categoriesFor(space.kinds).join(', ')}, and the household's own pieces.
- v: 2.
- items: up to ${LIMITS.items} pieces. "ref" is your own short label (bed1). Say what each piece is for; the app places it:
  - "against": "wall", "window-wall" (a wall with a window, e.g. a desk), "not-door-wall", or "free" (away from the walls: a dining table, a coffee table, a rug, a floating sofa).
  - "faces": another piece's ref (a sofa faces "tv1", a TV the sofa, a chair its table), "room", "window", "door", or null.
  - "near": the ref of the piece it goes with (bedside tables by "bed1", chairs at "table1", a coffee table by "sofa1"), or null.
  - "zone": the part of the space it belongs to (${ZONES.join(', ')}), or null.
  - "wall" (one of the walls above) and "along" (metres from its end "a"), or "at" and "rotation", are only your preference: null if you have none.
  Sizes null to take the catalogue's; beds come in their sizes; built-ins are made to measure (width).
- faces: feature walls, a wall id above with a finish id; other walls take the room's paint.
- notes: up to ${LIMITS.roomNotes}, e.g. if what they ask needs a change to the walls.
- summary: one line (at most ${LIMITS.spaceSummary} characters), what this layout does for them, in the household's own words.${
    opts.previous
      ? `\n\nThe answer they are changing (as data):\n${JSON.stringify(opts.previous)}\n`
      : ''
  }${feedbackBlock(opts)}${locksBlock((opts.locks ?? []).filter((l) => l.space === '*' || lockCovers(l, space.rooms)))}${fixBlock(opts.fix)}`;
  return {
    step: space.key,
    kind: 'room',
    system: SYSTEM_PROMPT,
    prefix: designContext(ctx),
    shared: conceptBlock(opts.concept ?? null),
    tail,
    schema: SPACE_SCHEMA,
    maxTokens: OUTPUT[quality].room.max,
    // Room steps think as much as the layout: a low budget left out beds (owner, 7 Nov).
    effort: quality === 'thorough' ? 'high' : 'medium',
  };
}

/** Every step of a whole-flat run on `level` as it is: for estimating before anything runs. */
export function runPrompts(ctx: ContextInput, spaces: Space[], aliases: AliasMap): StepPrompt[] {
  return [layoutStep(ctx), ...spaces.map((s) => roomStep(ctx, s, ctx.base, aliases))];
}
