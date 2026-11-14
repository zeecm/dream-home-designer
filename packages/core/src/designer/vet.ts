import { placeLabel } from '../geometry';
import { roomShapes } from '../rooms';
import type { Level, Vec2 } from '../schema';
import { type AliasMap, resolveAlias } from './aliases';
import { BEDROOM_USES, peopleOf } from './principles';
import type { Concept, DesignBrief, RoomUse } from './schema';
import { roomIdAt, roomsBeside, spacesOf } from './spaces';
import { personLabel } from './talk/firstMeeting';
import { applyDesignWalls } from './walls';

/**
 * Room vetting (spec docs/specs/designer-listens.md §4, lead decisions "Vetting: the runner
 * rewrites the concept as data"): run on a layout answer after it is read and before any room
 * is sent, free. A room where someone sleeps stays a bedroom: a use that isn't a sleeping one
 * goes back, and a name that doesn't read as a bedroom ("Living & Study") goes back to the
 * room's own. A wall taken out that would join it to a living, dining or kitchen room (no wall
 * between them any more) is refused, newest first, until none does; two bedrooms joined into a
 * bigger one stand. Entries that land in one room are made one, the sleeping use winning. Pure;
 * bounded by the concept's ops (each a walls pass of the level, no furniture).
 *
 * Not in `designResult`: that would change old and accepted versions. The concept is rewritten
 * as stored data, and the lines go on the option (`appLines`), in the person's words.
 */

export interface VetResult {
  concept: Concept;
  /** The app's lines, in the household's words: what was kept, and why. */
  lines: string[];
  /** The wall ids whose removal was refused. */
  refused: string[];
}

/** Rooms for living, dining or cooking (by the brief's use, else by name). */
const LIVING_USES = new Set<string>(['living', 'dining', 'kitchen']);
const LIVING_NAME = /living|dining|kitchen|lounge|family|pantry/i;
/** A name that still reads as a bedroom ("Main bedroom & study"), never one for living in. */
const BED_NAME = /bed|master|guest|nursery|sleep/i;

const andList = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

export function readsAsBedroom(name: string): boolean {
  return BED_NAME.test(name) && !LIVING_NAME.test(name);
}

/** A name for another use: living, cooking, work or storage ("Living & Study", "Study"). */
const OTHER_NAME = /living|dining|kitchen|lounge|family|pantry|study|office|store|walk-in|gym/i;
const readsAsOther = (name: string) => OTHER_NAME.test(name) && !readsAsBedroom(name);

/** A point well inside each room of `level` (where it is found again after the walls change). */
function probes(level: Level): Map<string, Vec2> {
  const out = new Map<string, Vec2>();
  for (const [id, s] of roomShapes(level)) {
    const p = placeLabel(s.outer, { x: 0.05, y: 0.05 }, [], s.holes);
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) out.set(id, p);
  }
  return out;
}

export function vetConcept(
  concept: Concept,
  base: Level,
  before: Level,
  brief: DesignBrief,
  aliases: AliasMap,
  seed: string,
): VetResult {
  const lines: string[] = [];
  const at = probes(base);
  const people = peopleOf(brief);
  const sleepers = (roomId: string) =>
    (brief.sleeping?.[roomId] ?? []).flatMap((k) => {
      const p = people.find((x) => x.key === k);
      return p ? [p] : [];
    });
  const sleeping = Object.keys(brief.sleeping ?? {}).filter(
    (id) => base.rooms[id] && sleepers(id).length && at.has(id),
  );
  if (!sleeping.length) return { concept, lines, refused: [] };
  const who = (ids: string[]) =>
    andList([...new Set(ids.flatMap((id) => sleepers(id).map((p) => personLabel(p, brief))))]);
  const sleep = (n: number) => (n === 1 ? 'sleeps' : 'sleep');
  const living = Object.values(base.rooms)
    .filter((r) => {
      if (!at.has(r.id) || sleeping.includes(r.id)) return false;
      const use = brief.rooms[r.id]?.use;
      if (use && use !== 'keep' && use !== 'designer') return LIVING_USES.has(use);
      return LIVING_NAME.test(r.name);
    })
    .map((r) => r.id);
  const wordFor = (id: string) => {
    const name = base.rooms[id]?.name ?? '';
    return /kitchen|pantry/i.test(name) && !/living|dining/i.test(name)
      ? 'the kitchen'
      : /dining/i.test(name) && !/living/i.test(name)
        ? 'the dining room'
        : 'the living room';
  };

  const sleepingNamed = (name: string) =>
    sleeping.some((id) => base.rooms[id]?.name === name) || BED_NAME.test(name);

  const wallsOf = (skip: Set<number>) =>
    applyDesignWalls(
      base,
      before,
      concept.walls.filter((_, i) => !skip.has(i)),
      brief.walls,
      aliases,
      seed,
    ).level;
  /** The living rooms each sleeping room shares a space with, on a level after the walls. */
  const joins = (level: Level): { bed: string; to: string }[] => {
    const spaces = spacesOf(level);
    const spaceAt = (id: string) => {
      const p = at.get(id);
      const room = p ? roomIdAt(level, p) : null;
      return room ? (spaces.find((s) => s.rooms.includes(room))?.key ?? room) : null;
    };
    const out: { bed: string; to: string }[] = [];
    for (const bed of sleeping) {
      const s = spaceAt(bed);
      if (!s) continue;
      for (const to of living) if (spaceAt(to) === s) out.push({ bed, to });
    }
    return out;
  };

  // 1. Walls: refuse removals that join a sleeping room to a living one, newest first; those
  // with a living room on one side before any other (so two bedrooms joined still stand).
  const skip = new Set<number>();
  let level = wallsOf(skip);
  let joined = joins(level);
  const removals = concept.walls
    .map((op, i) => ({ op, i, wallId: resolveAlias(aliases, op.wall) }))
    .filter((x) => x.op.op === 'remove_wall' && x.wallId && base.walls[x.wallId])
    .reverse();
  const besideLiving = (wallId: string) =>
    roomsBeside(base, wallId).some((r) => !!r && living.includes(r));
  const order = [
    ...removals.filter((x) => besideLiving(x.wallId as string)),
    ...removals.filter((x) => !besideLiving(x.wallId as string)),
  ];
  const refusedFor: { wallId: string; joined: { bed: string; to: string }[] }[] = [];
  for (const x of order) {
    if (!joined.length) break;
    skip.add(x.i);
    refusedFor.push({ wallId: x.wallId as string, joined });
    level = wallsOf(skip);
    joined = joins(level);
  }
  if (refusedFor.length) {
    // One phrase a pair of rooms ("the walls between Bedroom and Living and dining").
    const pairs = new Map<string, number>();
    for (const x of refusedFor) {
      const names = roomsBeside(base, x.wallId)
        .map((id) => (id ? (base.rooms[id]?.name ?? 'a room') : 'outside'))
        .sort((a, b) => (sleepingNamed(a) ? -1 : sleepingNamed(b) ? 1 : a.localeCompare(b)));
      const k = names.join(' and ');
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
    const phrases = [...pairs].map(([k, n]) => `the ${n > 1 ? 'walls' : 'wall'} between ${k}`);
    const many = refusedFor.length > 1;
    const first = refusedFor[0] as (typeof refusedFor)[number];
    const beds = [...new Set(first.joined.map((j) => j.bed))];
    const rank = (id: string) => {
      const w = wordFor(id);
      return w === 'the living room' ? 0 : w === 'the dining room' ? 1 : 2;
    };
    const to = [...first.joined].sort((a, b) => rank(a.to) - rank(b.to))[0]?.to ?? '';
    const n = new Set(beds.flatMap((id) => sleepers(id).map((p) => p.key))).size;
    lines.push(
      `Kept ${andList(phrases)}: taking ${many ? 'them' : 'it'} out would join the room ${who(beds)} ${sleep(n)} in to ${wordFor(to)}.`,
    );
  }
  const walls = concept.walls.filter((_, i) => !skip.has(i));

  // 2. Names and uses, on the level as the walls now leave it.
  const roomOf = (r: Concept['rooms'][number]) =>
    [(r.room && resolveAlias(aliases, r.room)) || (r.at ? roomIdAt(level, r.at) : null)].find(
      (id) => !!id && !!level.rooms[id],
    ) ?? null;
  /** The sleeping rooms of the flat as it is now inside room `id` after the walls. */
  const bedsIn = (id: string) =>
    sleeping.filter((s) => {
      const p = at.get(s);
      return s === id || (!!p && roomIdAt(level, p) === id);
    });
  const rooms = concept.rooms.map((r) => ({ ...r }));
  // Entries that land in one room: one name and use, the sleeping use first.
  const byRoom = new Map<string, number[]>();
  rooms.forEach((r, i) => {
    const id = roomOf(r);
    if (id) byRoom.set(id, [...(byRoom.get(id) ?? []), i]);
  });
  for (const [id, idx] of byRoom) {
    if (idx.length < 2) continue;
    const entries = idx.map((i) => rooms[i] as (typeof rooms)[number]);
    const beds = bedsIn(id).length > 0;
    const win =
      entries.find((e) => BEDROOM_USES.has(e.use) && (!beds || readsAsBedroom(e.name))) ??
      entries.find((e) => BEDROOM_USES.has(e.use)) ??
      (entries[0] as (typeof rooms)[number]);
    const names = [...new Set(entries.map((e) => e.name))];
    for (const e of entries) {
      e.name = win.name;
      e.use = win.use;
    }
    if (names.length > 1) {
      lines.push(
        `${andList(names.map((n) => `“${n}”`))} are one room after the wall changes: it’s ${win.name}.`,
      );
    }
  }
  const said = new Set<string>();
  for (const r of rooms) {
    const id = roomOf(r);
    if (!id) continue;
    const beds = bedsIn(id);
    if (!beds.length) continue;
    const own = beds.find((b) => b === id) ?? (beds[0] as string);
    const was = base.rooms[own]?.name ?? 'This room';
    const prior = brief.rooms[own]?.use;
    const fallback: RoomUse =
      prior && BEDROOM_USES.has(prior as RoomUse)
        ? (prior as RoomUse)
        : /master|main/i.test(was) ||
            beds.flatMap(sleepers).filter((p) => p.kind === 'adult').length >= 2
          ? 'master'
          : 'bedroom';
    const useBack = !BEDROOM_USES.has(r.use);
    // A name for another use goes back ("Living & Study"); one of their own ("Mdm Lim’s room")
    // stays, unless its use went back too and it doesn't read as a bedroom.
    const nameBack = readsAsOther(r.name) || (useBack && !readsAsBedroom(r.name));
    if (!useBack && !nameBack) continue;
    if (useBack) r.use = fallback;
    if (nameBack) r.name = was;
    if (said.has(id)) continue;
    said.add(id);
    const n = new Set(beds.flatMap((b) => sleepers(b).map((p) => p.key))).size;
    lines.push(
      `${r.name} stays a bedroom: ${who(beds)} ${sleep(n)} there. To make it a study, change who sleeps where.`,
    );
  }
  const changed =
    walls.length !== concept.walls.length ||
    rooms.some((r, i) => r.name !== concept.rooms[i]?.name || r.use !== concept.rooms[i]?.use);
  return {
    concept: changed ? { ...concept, walls, rooms } : concept,
    lines,
    refused: refusedFor.map((x) => x.wallId),
  };
}
