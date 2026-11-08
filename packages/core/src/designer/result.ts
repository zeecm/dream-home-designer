import { freeze } from 'immer';
import { type ClearanceIssue, clearanceIssues } from '../clearance';
import { type CostEstimate, type Rates, TYPICAL_RATES, costEstimate } from '../cost';
import { type Delivery, deliverable, deliveryCheck, entranceDoor, partsNote } from '../delivery';
import { FLOOR_FINISHES, PAINTS, WALLPAPERS, customPaint } from '../finishes';
import { type FurnitureKind, furnitureKind, itemFootprint, itemSize } from '../furniture';
import { placeLabel, pointInPolygon } from '../geometry';
import { planGeometry } from '../plan';
import { roomShapes } from '../rooms';
import { ElecPoint } from '../schema';
import type { Item, Level, Project, Site, Vec2 } from '../schema';
import type { StorageSetting } from '../storage';
import { SHELTER_ROOM } from '../structural';
import { type Suggestion, roomKind, suggestPoints } from '../suggest';
import { type WalkwayReport, walkwayReport } from '../walkway';
import { aspectOf } from './accept';
import { type AliasMap, resolveAlias } from './aliases';
import { fixedSize, priorityOf, resolveAsset } from './catalogue';
import { type CheckOptions, type DesignCheck, designChecks } from './checks';
import { usesOf } from './checks';
import { BED_ACCESS } from './checks';
import { bathroomsHeld, heldAspects, wallsHeld } from './handEdits';
import { type LensId, type Steer, steerFor, steerOnly } from './lenses';
import { WET } from './locks';
import {
  type SpaceIndex,
  type Want,
  addToIndex,
  keepOutOf,
  nameOf,
  placePiece,
  shape,
  spaceIndex,
} from './place';
import { ACCESS, type ProgrammeUse, peopleOf, roleOf } from './principles';
import { acceptResolve, piecesNoWorse } from './resolve';
import { ruleKeepOuts } from './rules/check';
import { type Kept, placeKept } from './rules/kept';
import type { Rule } from './rules/schema';
import type { Concept, DesignInput, DesignItem, RoomUse, SpaceDesign, SpaceStatus } from './schema';
import type { Zone } from './schema';
import { type Intent, type SolveOutcome, applySwap, solveSpace, storageLost } from './solve';
import {
  type Face,
  type Space,
  clearStretches,
  facesOf,
  roomIdAt,
  roomsBeside,
  spacesOf,
} from './spaces';
import { hash, levelFingerprint, rotationOf, seededId, settled, stableJson } from './util';
import { type Note, applyDesignWalls } from './walls';

/**
 * A version placed on the plan as it is now: its walls applied (and checked), rooms named,
 * each space furnished and repaired, finishes and electrical points added, then the whole
 * level checked (clearances, walkways, delivery, windows, doors for elders) and priced.
 * Worked out afresh every time it is shown or accepted, never stored, so a version made on
 * an older plan is checked again on the current one. Pure: the same inputs (in any record
 * order) give the same level, with ids seeded by the version's id.
 */
export interface DesignProblem {
  kind: 'clearance' | 'walkway' | 'delivery' | 'window' | 'door-width' | 'structural' | 'budget';
  text: string;
  /** The clearance or walkway issue, for the app's own wording and drawing. */
  issue?: ClearanceIssue;
  delivery?: Delivery;
  itemId?: string;
  roomId?: string;
  openingId?: string;
}

/** A check on the version's level: caused by it, or already in the plan it was made on. */
export interface ResultCheck extends DesignCheck {
  /** In the plan before, and not touched by the version: never blocks it. */
  already: boolean;
  /** The part of the version it belongs to, for Accept (null: the whole plan's). */
  part: { space: string; aspect: 'furniture' | 'built-ins' } | { aspect: 'walls' } | null;
}

export interface ResultSpace extends Space {
  /** How its step went; 'missing' when the version has no answer for it. */
  status: SpaceStatus | 'missing';
  /** The key its answer is stored under in the version (it can differ on a changed plan). */
  storedKey: string | null;
  /** The pieces placed in it. */
  items: string[];
  use: RoomUse | null;
  intent: string;
}

export interface DesignResult {
  level: Level;
  spaces: ResultSpace[];
  /** Room uses, by room id of `level`. */
  uses: Record<string, RoomUse>;
  /** Wall changes used, and those left out with why. */
  applied: Note[];
  refused: Note[];
  /** Fixed for you: pieces moved, narrowed, turned. */
  repaired: Note[];
  /** Pieces left out, and finishes that couldn't be used. */
  dropped: Note[];
  /** The designer's own notes, and notes on cut text. */
  notes: Note[];
  /** Structural walls the version changes (the brief allowed it). */
  structural: string[];
  problems: DesignProblem[];
  /** The design checks (P1–P4 and HDB rules), each caused by the version or already there. */
  checks: ResultCheck[];
  /** No hard check the version caused fails (waivers aside). */
  passes: boolean;
  /** The answer's ref of each piece placed (by item id), to name it to the designer. */
  refs: Record<string, string>;
  /**
   * Walkway re-solves tried: the space, its hard checks before and after, and whether it was
   * taken (only ever when strictly better).
   */
  resolves: { space: string; before: number; after: number; taken: boolean }[];
  /** Smaller pieces tried in a space (right-sizing): how many swaps, and whether one was taken. */
  swaps: { space: string; tried: number; taken: boolean }[];
  cost: CostEstimate;
  points: Suggestion[];
  budget: 'within' | 'over' | 'unknown';
}

export interface DesignOptions {
  rates?: Rates;
  site?: Site;
  /** The project's own furniture models. */
  models?: Project['models'];
  /** false: pieces are left where first placed, not moved off the walkways (for tests). */
  walkways?: boolean;
  /**
   * The storage meter's own setting (per browser and project), which the storage lens reads
   * with the brief (`storageSettingFor`). Absent: the meter's default.
   */
  storage?: StorageSetting;
  /** The lenses switched on (DEFAULT_LENSES when absent): they score and steer, never gate. */
  lenses?: LensId[];
  /**
   * The household's house rules for the version's level (slice 3a): checked as hard R checks,
   * and kept out of by the walkway re-solve. In the key, so a rule edit re-checks at no cost.
   */
  rules?: readonly Rule[];
  /**
   * Pieces kept where they are (slice 3a): a proposal's are placed again, before anything
   * else, and every one is checked (K). In the key, as the rules are.
   */
  kept?: readonly Kept[];
}

const BEDROOM_USES = new Set<RoomUse>(['master', 'bedroom', 'kids', 'parents', 'guest']);
const ELDER_NEED = { frame: 0.85, wheelchair: 0.85, stick: 0.8 } as const;

/** A wall finish the app has: a paint, a wallpaper or a mixed paint (`paint-#rrggbb`). */
export function isWallFinish(id: string): boolean {
  return (
    PAINTS.some((p) => p.id === id) ||
    WALLPAPERS.some((p) => p.id === id) ||
    /^paint-#[0-9a-f]{6}$/.test(id)
  );
}
export const isFloorFinish = (id: string) => FLOOR_FINISHES.some((f) => f.id === id);

/** The finish to use for an answer's wall finish: it, else the palette's wall colour, else white. */
export function wallFinishOf(
  raw: string,
  concept: Concept | null,
): { id: string; note: string | null } {
  const id = raw.trim().toLowerCase();
  if (isWallFinish(id)) return { id, note: null };
  if (/^#[0-9a-f]{6}$/.test(id)) return { id: customPaint(id), note: null };
  const walls = concept?.style.palette.find((p) => p.use === 'walls');
  const use = walls ? customPaint(walls.hex) : 'paint-white';
  const named = walls ? `${walls.name} (${walls.hex})` : 'white';
  return { id: use, note: `“${raw}” isn’t a paint we have, so the walls are ${named}.` };
}

const centreOf = (it: Item): Vec2 => ({ x: it.position.x, y: it.position.z });

/** Pieces of the kitchen's wet area: plumbing and gas stay where they are. */
const WET_PIECES = new Set(['kitchen-sink', 'kitchen-hob']);
const wetText = (id: string) =>
  `${id === 'kitchen-sink' ? 'Sink cabinet: the sink' : 'Hob cabinet: the hob'} stays in the kitchen’s wet area.`;

/** A footprint pulled 1 cm in, so corners on a room's edge read as inside it. */
const inset = (fp: Vec2[]): Vec2[] => {
  const c = fp.reduce((p, q) => ({ x: p.x + q.x / fp.length, y: p.y + q.y / fp.length }), {
    x: 0,
    y: 0,
  });
  return fp.map((p) => {
    const d = Math.hypot(p.x - c.x, p.y - c.y) || 1;
    const k = Math.min(0.01, d / 2) / d;
    return { x: p.x + (c.x - p.x) * k, y: p.y + (c.y - p.y) * k };
  });
};

/** A point well inside a room. */
function roomLabel(level: Level, roomId: string): Vec2 {
  const s = roomShapes(level).get(roomId);
  return s
    ? placeLabel(s.outer, { x: 0.05, y: 0.05 }, [], s.holes)
    : { x: Number.NaN, y: Number.NaN };
}

const memo = new Map<string, DesignResult>();

/** What a result is kept by: the same version on the same plans, with the same options. */
export const designResultKey = (
  baseLevel: Level,
  beforeLevel: Level,
  design: DesignInput,
  opts: DesignOptions = {},
): string =>
  [
    design.id,
    levelFingerprint(baseLevel),
    levelFingerprint(beforeLevel),
    hash(stableJson(design)),
    hash(stableJson(opts)),
  ].join('|');

/**
 * The result, kept per version and plan: the same version on the same plan (the preview, the
 * Accept dialog, Compare) is worked out once. Frozen: treat it as read-only.
 */
export function designResult(
  baseLevel: Level,
  beforeLevel: Level,
  design: DesignInput,
  opts: DesignOptions = {},
): DesignResult {
  const key = designResultKey(baseLevel, beforeLevel, design, opts);
  const hit = memo.get(key);
  if (hit) return hit;
  const out = freeze(work(baseLevel, beforeLevel, design, opts), true);
  memo.set(key, out);
  if (memo.size > 16) memo.delete(memo.keys().next().value as string);
  return out;
}

function work(
  baseLevel: Level,
  beforeLevel: Level,
  design: DesignInput,
  opts: DesignOptions,
): DesignResult {
  const { brief, aliases, concept } = design;
  const rulesOpt = {
    ...(opts.rules?.length ? { rules: opts.rules } : {}),
    ...(opts.kept?.length ? { kept: opts.kept } : {}),
  };
  // What the house rules change in a space's outcome (only the fields the checks read, so a
  // rename keeps the cache): the steered solve is kept only if no rule check gets worse, and a
  // settled outcome comes from the rules' keep-outs. The plain first solve doesn't read them.
  const ruleKey = opts.rules?.length
    ? stableJson(opts.rules.map((r) => [r.id, r.subject, r.relation, r.target, r.n]))
    : null;
  /** A settled outcome's key: its first solve's, and the rules whose keep-outs it followed. */
  const settledKeyOf = (first: string) => (ruleKey ? hash(stableJson([first, ruleKey])) : first);
  const repaired: Note[] = [];
  const dropped: Note[] = [];
  const notes: Note[] = (concept?.notes ?? []).map((text) => ({ text }));
  const start = settled(baseLevel);
  const before = settled(beforeLevel);
  // Parts the person changed by hand since accepting stay as the plan has them.
  const locks = design.request?.locks;
  const held = (rooms: readonly string[]) => heldAspects(locks, rooms);

  // 1. Walls (none, if the person changed the walls by hand since accepting).
  const walls = applyDesignWalls(
    start,
    before,
    wallsHeld(locks) ? [] : (concept?.walls ?? []),
    brief.walls,
    aliases,
    design.id,
  );
  const lvl: Level = structuredClone(walls.level);
  // Kept pieces stand where they were kept, before anything is placed, and are never cleared.
  const keptIds = placeKept(lvl, opts.kept ?? []);
  const geomLevel = walls.level;
  const geom = planGeometry(geomLevel);
  const sides = new Map(Object.keys(lvl.walls).map((id) => [id, roomsBeside(geomLevel, id)]));
  const refused = [...walls.refused];

  // 2. Rooms: names and uses, floors, and each room's paint.
  const uses: Record<string, RoomUse> = {};
  const intents: Record<string, string> = {};
  const paintRoom = (roomId: string, raw: string) => {
    const f = wallFinishOf(raw, concept);
    if (f.note) dropped.push({ text: f.note, roomId });
    for (const [wallId, [l, r]] of sides) {
      const w = lvl.walls[wallId];
      if (!w || w.kind === 'boundary') continue;
      if (l === roomId) w.materialLeft = f.id;
      if (r === roomId) w.materialRight = f.id;
    }
  };
  const floorRoom = (roomId: string, raw: string) => {
    const room = lvl.rooms[roomId];
    if (!room) return;
    const id = raw.trim().toLowerCase();
    if (isFloorFinish(id)) room.floorMaterial = id;
    else
      dropped.push({ text: `“${raw}” isn’t a floor we have; ${room.name}’s floor stays.`, roomId });
  };
  for (const r of concept?.rooms ?? []) {
    const id =
      (r.room && resolveAlias(aliases, r.room)) || (r.at ? roomIdAt(geomLevel, r.at) : null);
    const room = id ? lvl.rooms[id] : undefined;
    if (!id || !room) {
      refused.push({
        text: `Name a room “${r.name}”: there’s no room there after the wall changes.`,
      });
      continue;
    }
    if (SHELTER_ROOM.test(room.name)) {
      refused.push({
        text: `Use the ${room.name} as “${r.name}”: the household shelter stays the shelter.`,
        roomId: id,
      });
      continue;
    }
    if (WET.test(room.name) || roomKind(room.name) === 'none') {
      refused.push({ text: `Use the ${room.name} as “${r.name}”: it stays as it is.`, roomId: id });
      continue;
    }
    const as = roomKind(r.name);
    if (SHELTER_ROOM.test(r.name) || as === 'bathroom' || as === 'none') {
      refused.push({
        text: `Name the ${room.name} “${r.name}”: that is a name for a shelter, a bathroom or a ledge.`,
        roomId: id,
      });
      continue;
    }
    const keep = brief.rooms[id]?.use === 'keep';
    if (!keep) {
      room.name = r.name;
      uses[id] = r.use;
    }
    intents[id] = r.intent;
    if (held([id]).includes('finishes')) continue;
    floorRoom(id, r.floor);
    paintRoom(id, r.paint);
  }
  // Bathrooms' paint and floors, unless the person changed them by hand since accepting.
  for (const b of bathroomsHeld(locks) ? [] : (concept?.bathrooms ?? [])) {
    const id = resolveAlias(aliases, b.room);
    const room = id ? lvl.rooms[id] : undefined;
    if (!id || !room || !WET.test(room.name)) continue;
    floorRoom(id, b.floor);
    paintRoom(id, b.paint);
  }

  // 3. Spaces, and which stored answer each takes.
  const named = settled(lvl);
  const spaces = spacesOf(named);
  const stored = Object.entries(design.spaces);
  const taken = new Set<string>();
  const storedFor = (s: Space): string | null => {
    if (design.spaces[s.key] && !taken.has(s.key)) return s.key;
    let best: { key: string; n: number } | null = null;
    for (const [key] of stored) {
      if (taken.has(key)) continue;
      const n = key.split('+').filter((id) => s.rooms.includes(id)).length;
      if (n && (!best || n > best.n)) best = { key, n };
    }
    return best?.key ?? null;
  };
  const shapes = roomShapes(named);
  const inRooms = (rooms: string[], p: Vec2) =>
    rooms.some((id) => {
      const s = shapes.get(id);
      return !!s && pointInPolygon(p, s.outer) && !s.holes.some((h) => pointInPolygon(p, h));
    });

  // The kitchens of the flat as it is: where a sink and a hob may stand.
  const kitchens = Object.values(before.rooms)
    .filter((r) => roomKind(r.name) === 'kitchen' && !/dry/i.test(r.name))
    .flatMap((r) => {
      const s = roomShapes(before).get(r.id);
      return s ? [s.outer] : [];
    });
  const inKitchen = (p: Vec2) => kitchens.some((k) => pointInPolygon(p, k));

  const resultSpaces: ResultSpace[] = [];
  const refs: Record<string, string> = {};
  const swaps: DesignResult['swaps'] = [];
  /** Each furnished space's index and pieces, to move a piece off a walkway after. */
  const runs: Run[] = [];
  let geomKey: string | null = null;
  /** The ways through the bare plan (for the solver to keep free). */
  let bareWays: ReturnType<typeof keepOutOf> | null = null;
  const placedNew = new Set<string>();
  const usedIds = new Set<string>();
  const placedBrought = new Set<string>();
  for (const s of spaces) {
    const key = storedFor(s);
    if (key) taken.add(key);
    const entry = key ? design.spaces[key] : undefined;
    const answer: SpaceDesign | undefined =
      entry && ['done', 'copied', 'locked'].includes(entry.status) ? entry.design : undefined;
    const main = s.main;
    const rs: ResultSpace = {
      ...s,
      name: named.rooms[main]?.name ?? s.name,
      status: entry?.status ?? 'missing',
      storedKey: key,
      items: [],
      use: uses[main] ?? null,
      intent: intents[main] ?? '',
    };
    resultSpaces.push(rs);
    if (!answer || !key) continue;
    notes.push(...answer.notes.map((text) => ({ text, space: s.key })));
    const keepAs = held(s.rooms);

    const faces = facesOf(named, s.rooms, geom);
    const longest = (f: Face) => Math.max(0, ...clearStretches(f, 0, 1).map(([a, b]) => b - a));
    const byLength = [...faces].sort((p, q) => longest(q) - longest(p));
    const v2 = answer.v === 2;
    const wants = answer.items
      .map((a) => resolveWant(a, { s, key, faces, byLength, v2 }))
      .filter((w): w is Want & { priority: number } => !!w)
      // What is held stays as the plan has it: the answer's pieces of that part aren't placed.
      .filter((w) => !keepAs.includes(w.kind.carpentry ? 'built-ins' : 'furniture'))
      .sort((p, q) => p.priority - q.priority || (p.ref < q.ref ? -1 : p.ref > q.ref ? 1 : 0));
    // The sink and the hob stay where they are unless the answer puts new ones in.
    const replaces = new Set(wants.map((w) => w.kind.id).filter((id) => WET_PIECES.has(id)));

    // Clear the space, but for what the brief keeps where it is (and the sink and hob).
    const takenOut: Item[] = [];
    for (const it of Object.values(lvl.items)) {
      if (!inRooms(s.rooms, centreOf(it))) continue;
      if (brief.keep.items[it.id] === 'in-place' || keptIds.has(it.id)) continue;
      if (keepAs.includes(aspectOf(it))) continue;
      if (WET_PIECES.has(it.assetId)) {
        if (!replaces.has(it.assetId)) continue;
        takenOut.push(it);
      }
      delete lvl.items[it.id];
    }
    const ix = spaceIndex(named, geom, s.rooms);
    for (const it of Object.values(lvl.items)) {
      const kind = furnitureKind(it.assetId);
      if (kind && inRooms(s.rooms, centreOf(it))) addToIndex(ix, it, kind);
    }

    const placedKinds = new Set<string>();
    /** Takes a placed piece into the level (a sink or a hob only in the kitchen's wet area). */
    const take = (want: Want, item: Item) => {
      if (WET_PIECES.has(want.kind.id) && !inset(itemFootprint(item, want.kind)).every(inKitchen)) {
        ix.placed = ix.placed.filter((p) => p.id !== item.id);
        dropped.push({ text: wetText(want.kind.id), ref: want.ref, space: s.key });
        return;
      }
      lvl.items[item.id] = item;
      rs.items.push(item.id);
      refs[item.id] = want.ref;
      placedKinds.add(want.kind.id);
      if (want.brought) placedBrought.add(item.id);
      else placedNew.add(item.id);
    };
    if (v2) {
      // By intent: the solver places the space's pieces together.
      const byRef = new Map(answer.items.map((a) => [a.ref, a]));
      const intents: Intent[] = wants.map((w) => {
        const a = byRef.get(w.ref);
        const wall = !!w.kind.againstWall || !!w.kind.carpentry;
        return {
          want: w,
          against: a?.against ?? (wall ? 'wall' : 'free'),
          faces: a?.faces ?? null,
          near: a?.near ?? null,
          zone: a?.zone ?? null,
        };
      });
      const zoneArea = zoneAreaOf(named, s.rooms, uses, brief);
      // Solved spaces are kept by what they depend on: the version, the answer, the plan's
      // walls, the pieces that stay in the space, and what is being kept clear.
      geomKey ??= hash(
        stableJson([named.vertices, named.walls, named.openings, named.rooms, named.ceilingHeight]),
      );
      // The ways through the bare plan, worked out once for the same walls and doors.
      bareWays ??=
        waysMemo.get(geomKey) ??
        remember(
          waysMemo,
          geomKey,
          walkwayReport({ ...named, items: {} })
            .routes.filter((r) => r.route === 'circulation')
            .flatMap((r) => keepOutOf(r.path, null, r.need)),
        );
      const ways = bareWays;
      const base = ix.placed.length;
      const wantOf = new Map(wants.map((w) => [w.id, w]));
      let firstKey = '';
      /** What the first solve swapped in (smaller pieces), kept by re-solves. */
      let firstSwap: SolveOutcome['swap'];
      const fixedKey = ix.placed.map(
        (p) => `${p.id}:${p.fp.map((q) => q.x.toFixed(3) + q.y.toFixed(3)).join()}`,
      );
      // What the lenses ask of the solver here (a short bedroom keeps its wardrobe): weights
      // only, from the level as this space is about to be furnished, and only for the roles
      // the answer has (a space with none solves as it would with no lens).
      const steer = steerOnly(
        steerFor({ level: { ...named, items: lvl.items }, space: s, brief, opts }),
        new Set(intents.map((t) => roleOf(t.want.kind))),
      );
      /** The space's failing hard checks on a level, the space alone furnished (and `extra`). */
      const hardOf = (l: Level, extra: Item[] = []) =>
        spaceHardKeys(
          l,
          (it) => inRooms(s.rooms, centreOf(it)),
          { brief, uses, ...rulesOpt },
          extra,
        );
      /** Whether the first solve took the lenses' weights: its walkway re-solves keep them. */
      let firstSteered = false;
      const solveWith = (
        keepOut: SpaceIndex['keepOut'],
        keepOutFor?: Set<string>,
        noWorseThan?: PieceCounts,
      ) => {
        ix.placed.length = base;
        // The weights a solve takes: the first solve's look at them, and its re-solves keep
        // them only if it took them.
        const st = keepOut.length ? (firstSteered ? steer : null) : steer;
        const keyOf = (with_: Steer | null) =>
          hash(
            stableJson([
              design.id,
              s.key,
              answer,
              geomKey,
              fixedKey,
              s.rooms.map((id) => uses[id] ?? null),
              brief.rooms,
              keepOut.map((k) => k.poly),
              [...(keepOutFor ?? [])].sort(),
              opts.walkways !== false,
              noWorseThan ?? null,
              with_,
              // A steered outcome is chosen against the rules' hard checks.
              with_ ? ruleKey : null,
            ]),
          );
        const memoKey = keyOf(st);
        // A space moved off a walkway before is placed as it ended up.
        const hit =
          (keepOut.length ? undefined : settledMemo.get(settledKeyOf(memoKey))) ??
          solveMemo.get(memoKey);
        if (!keepOut.length) firstKey = memoKey;
        if (hit && !keepOut.length) {
          firstSwap = hit.swap;
          firstSteered = steeredSolves.has(hit);
          if (hit.swapsTried)
            swaps.push({ space: s.key, tried: hit.swapsTried, taken: !!hit.swap });
        }
        if (hit) {
          for (const item of hit.items) {
            const w = wantOf.get(item.id);
            // A piece swapped for a smaller one is indexed as the kind it became.
            if (w) addToIndex(ix, item, furnitureKind(item.assetId) ?? w.kind);
          }
          return hit;
        }
        ix.keepOut = keepOut;
        const solveBy = (st: Steer | null) =>
          solveSpace({
            ix,
            faces,
            // A re-solve keeps what the first solve swapped in.
            intents: (keepOut.length && firstSwap?.intents) || intents,
            zoneArea,
            ways,
            household: peopleOf(brief).filter((p) => p.kind !== 'helper').length,
            // A walkway re-solve looks less far, and keeps the pieces the first solve chose.
            ...(keepOut.length ? { budget: RESOLVE_BUDGET, swaps: false } : {}),
            ...(keepOutFor ? { keepOutFor } : {}),
            // It stops once it can only end worse in pieces than the solve it would replace.
            ...(keepOut.length && noWorseThan
              ? { noWorseThan: { ...noWorseThan, spare: firstSwap?.spare } }
              : {}),
            ...(st ? { steer: st } : {}),
          });
        let solved: SolveOutcome;
        if (keepOut.length || !steer) solved = solveBy(st);
        else {
          // The first solve as it always was (kept under its own key, as with no lens). Only
          // if it lost storage the lenses protect (a protected piece left out, a preferred one
          // made narrower) is the space solved again with their weights, and that solve is
          // kept only if it is no worse: no more pieces left out, short of room or turned
          // (piecesNoWorse), and no hard check failing that the first passes.
          const plainKey = keyOf(null);
          let plain = solveMemo.get(plainKey);
          if (!plain) {
            plain = solveBy(null);
            solveMemo.set(plainKey, plain);
            if (solveMemo.size > 48) solveMemo.delete(solveMemo.keys().next().value as string);
          }
          solved = plain;
          if (storageLost(plain, intents, steer)) {
            ix.placed.length = base;
            const steered = solveBy(steer);
            if (!samePoses(plain, steered) && piecesNoWorse(countsOf(plain), countsOf(steered))) {
              const was = hardOf({ ...named, items: lvl.items }, plain.items);
              const now = hardOf({ ...named, items: lvl.items }, steered.items);
              if (![...now].some((k) => !was.has(k))) {
                solved = steered;
                steeredSolves.add(steered);
                firstSteered = true;
              }
            }
          }
          ix.placed.length = base;
          for (const item of solved.items) {
            const w = wantOf.get(item.id);
            if (w) addToIndex(ix, item, furnitureKind(item.assetId) ?? w.kind);
          }
        }
        ix.keepOut = [];
        const out = keepOut.length && firstSwap ? applySwap(solved, firstSwap) : solved;
        if (!keepOut.length) {
          firstSwap = out.swap;
          if (out.swapsTried)
            swaps.push({ space: s.key, tried: out.swapsTried, taken: !!out.swap });
        }
        solveMemo.set(memoKey, out);
        if (solveMemo.size > 48) solveMemo.delete(solveMemo.keys().next().value as string);
        return out;
      };
      const out = solveWith([]);
      const taken: string[] = [];
      const apply = (o: SolveOutcome) => {
        for (const item of o.items) {
          const want = wantOf.get(item.id);
          if (!want) continue;
          take(want, item);
          if (lvl.items[item.id] === item) taken.push(item.id);
        }
      };
      const unapply = () => {
        for (const id of taken.splice(0)) {
          delete lvl.items[id];
          delete refs[id];
          placedNew.delete(id);
          placedBrought.delete(id);
          rs.items = rs.items.filter((x) => x !== id);
        }
      };
      apply(out);
      const free = new Set(
        intents.filter((t) => t.against === 'free' && !t.want.kind.carpentry).map((t) => t.want.id),
      );
      runs.push({
        ix,
        wants,
        key: s.key,
        solveWith,
        free,
        outcome: out,
        apply,
        unapply,
        settle: (o) => {
          // A settled outcome keeps its first solve's weights for later walkway re-solves.
          if (firstSteered) steeredSolves.add(o);
          settledMemo.set(settledKeyOf(firstKey), o);
          if (settledMemo.size > 48) settledMemo.delete(settledMemo.keys().next().value as string);
        },
        // The hard checks with only this space furnished (the rest of the plan as it is).
        spaceHard: (l: Level) => hardOf(l),
      });
    } else {
      runs.push({ ix, wants, key: s.key });
      for (const want of wants) {
        const out = placePiece(ix, want);
        repaired.push(...out.repaired.map((n) => ({ ...n, space: s.key })));
        dropped.push(...out.dropped.map((n) => ({ ...n, space: s.key })));
        if (out.item) take(want, out.item);
      }
    }
    for (const it of takenOut) {
      if (placedKinds.has(it.assetId)) continue;
      lvl.items[it.id] = it;
      const what = it.assetId === 'kitchen-sink' ? 'sink' : 'hob';
      repaired.push({
        text: `Kept the ${what} where it is: the new one didn’t fit.`,
        space: s.key,
        itemId: it.id,
      });
    }

    // Feature walls: a finish on the face towards this space only.
    for (const f of keepAs.includes('finishes') ? [] : answer.faces) {
      const wallId = resolveAlias(aliases, f.wall);
      const w = wallId ? lvl.walls[wallId] : undefined;
      const towards = faces.filter((x) => x.wallId === wallId);
      if (!w || !towards.length) {
        dropped.push({ text: `Finish on ${f.wall}: it isn’t a wall of ${rs.name}.`, space: s.key });
        continue;
      }
      const fin = wallFinishOf(f.finish, concept);
      if (fin.note) dropped.push({ text: fin.note, space: s.key, wallId: w.id });
      for (const x of towards) {
        if (x.side === 1) w.materialLeft = fin.id;
        else w.materialRight = fin.id;
      }
    }
  }

  /** One answer's piece, resolved to a kind, a size and a place; null (and a note) if it can't be. */
  function resolveWant(
    a: DesignItem,
    ctx: { s: Space; key: string; faces: Face[]; byLength: Face[]; v2: boolean },
  ): (Want & { priority: number }) | null {
    const leftOut = (text: string) => {
      dropped.push({ text, ref: a.ref, space: ctx.s.key });
      return null;
    };
    let brought: Item | null = null;
    let kind: FurnitureKind | null;
    if (a.keep) {
      const id = resolveAlias(aliases, a.keep);
      const it = id ? start.items[id] : undefined;
      if (!id || !it) return leftOut(`“${a.ref}”: there’s no piece “${a.keep}” in the flat.`);
      const how = brief.keep.items[id];
      kind = furnitureKind(it.assetId) ?? null;
      const what = kind ? nameOf(kind) : 'piece';
      if (how === 'in-place') return leftOut(`Your ${what} stays where it is, as the brief says.`);
      if (how !== 'bring') return leftOut(`Your ${what}: the brief leaves it out.`);
      brought = it;
    } else {
      kind = resolveAsset(a.assetId, opts.models);
    }
    if (!kind) return leftOut(`“${a.assetId}” (${a.ref}): not in the catalogue.`);
    if (kind.category === 'Bathroom') {
      return leftOut(`The ${nameOf(kind)}: bathrooms keep their fittings.`);
    }
    const k = kind;
    const clamp = (v: number | null, base: number) =>
      v === null ? base : Math.min(base * 1.6, Math.max(base * 0.6, v));
    let w: number;
    let d: number;
    let h: number;
    if (brought) {
      const sz = itemSize(brought, k);
      [w, d, h] = [sz.w, sz.d, sz.h];
    } else if (fixedSize(k)) {
      [w, d, h] = [k.size.w, k.size.d, k.size.h];
    } else if (k.carpentry) {
      w = Math.max(0.3, a.width ?? k.size.w);
      d = clamp(a.depth, k.size.d);
      h = clamp(a.height, k.size.h);
    } else {
      [w, d, h] = [clamp(a.width, k.size.w), clamp(a.depth, k.size.d), clamp(a.height, k.size.h)];
    }
    const wallId = resolveAlias(aliases, a.wall);
    let face = wallId ? (ctx.faces.find((f) => f.wallId === wallId) ?? null) : null;
    if (a.wall && !face && !ctx.v2) {
      if (!k.againstWall && !k.carpentry && a.at === null) {
        return leftOut(`The ${nameOf(k)}: ${a.wall} isn’t a wall of ${ctx.s.name}.`);
      }
      repaired.push({
        text: `The ${nameOf(k)} was put on another wall: ${a.wall} isn’t a wall of ${ctx.s.name}.`,
        ref: a.ref,
        space: ctx.s.key,
      });
      face = null;
    }
    const free = !face && a.at !== null;
    if (!face && !free && !k.againstWall && !k.carpentry && !ctx.v2) {
      return leftOut(`The ${nameOf(k)}: the designer didn’t say where it goes.`);
    }
    // The sink and the hob stay in the kitchen's wet area.
    if (k.id === 'kitchen-sink' || k.id === 'kitchen-hob') {
      const p = face
        ? {
            x: face.frame.a.x + face.frame.d.x * ((face.u0 + face.u1) / 2),
            y: face.frame.a.y + face.frame.d.y * ((face.u0 + face.u1) / 2),
          }
        : a.at;
      const probe =
        face && p
          ? {
              x: p.x + face.frame.n.x * face.side * (face.frame.half + 0.3),
              y: p.y + face.frame.n.y * face.side * (face.frame.half + 0.3),
            }
          : p;
      // Placed on whichever wall fits: the space must be the kitchen itself.
      const inSpace = !probe && ctx.s.rooms.some((id) => inKitchen(roomLabel(named, id)));
      if (!(probe ? inKitchen(probe) : inSpace)) {
        return leftOut(wetText(k.id));
      }
    }
    if (brought && placedBrought.has(brought.id)) {
      return leftOut(`Your ${nameOf(k)} is placed once already; left out here.`);
    }
    let id = brought?.id ?? seededId('it', design.id, ctx.key, a.ref);
    if (!brought) {
      for (let n = 2; usedIds.has(id); n++) id = seededId('it', design.id, ctx.key, a.ref, n);
      usedIds.add(id);
    }
    return {
      id,
      ref: a.ref,
      kind: k,
      w,
      d,
      h,
      face,
      faces: free && !ctx.v2 ? [] : ctx.byLength,
      along: a.along,
      at: free || ctx.v2 ? a.at : null,
      rotation: rotationOf(a.rotation ?? 0),
      ceiling: lvl.ceilingHeight,
      brought,
      priority: priorityOf(k),
    };
  }

  // Pieces the brief brings that no space placed: said, not lost silently.
  for (const [id, how] of Object.entries(brief.keep.items).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const it = start.items[id];
    if (how !== 'bring' || !it || lvl.items[id]) continue;
    const kind = furnitureKind(it.assetId);
    dropped.push({
      text: `Your ${kind ? nameOf(kind) : 'piece'} isn’t in the design: the designer didn’t place it.`,
      itemId: id,
    });
  }

  // Walkways, once every space is furnished: a piece the version placed that narrows the way
  // from the main door (or to a bed) is moved off it where it can be, else left for the
  // checks to say.
  const resolves: DesignResult['resolves'] = [];
  const walked =
    opts.walkways === false
      ? null
      : keepWalkwaysClear(lvl, runs, repaired, resolves, {
          rules: opts.rules ?? [],
          usesOf: (id) => usesOf(lvl, id, { brief, uses }),
          hard: (l, walk) =>
            new Set(
              designChecks(l, { brief, uses, ...rulesOpt, ...(walk ? { walk } : {}) })
                .filter((c) => c.hard)
                .map((c) => c.key),
            ),
        });
  // The notes of each space solved by intent, as finally placed.
  for (const run of runs) {
    if (!run.outcome) continue;
    repaired.push(...run.outcome.repaired.map((n) => ({ ...n, space: run.key })));
    dropped.push(...run.outcome.dropped.map((n) => ({ ...n, space: run.key })));
  }

  // 4. Electrical points, worked out locally on the designed level.
  let points: Suggestion[] = [];
  if (brief.electrical) {
    const furnished = settled(lvl);
    points = suggestPoints(furnished, { statusOf: before }).points;
    lvl.points ??= {};
    for (const p of points) {
      const id = seededId('pt', design.id, p.key);
      lvl.points[id] = ElecPoint.parse({ ...p.point, id });
    }
  }
  const level = settled(lvl);

  // 5. The whole level's checks.
  const problems: DesignProblem[] = [];
  const hard = new Set(['overlap', 'wall', 'door', 'doors', 'door-front']);
  const issues = clearanceIssues(level);
  const seenPair = new Set<string>();
  const clearance = issues.filter((i) => {
    if (i.kind !== 'overlap') return true;
    const k = [i.itemId, i.otherId].sort().join('|');
    if (seenPair.has(k)) return false;
    seenPair.add(k);
    return true;
  });
  const issueText = (i: ClearanceIssue): string => {
    const piece = (id: string) => {
      const it = level.items[id];
      const kind = it && furnitureKind(it.assetId);
      return kind ? `The ${nameOf(kind)}` : 'A piece';
    };
    switch (i.kind) {
      case 'zone':
        return `${i.what} ${i.need.toFixed(2)} m; there is ${i.have.toFixed(2)} m.`;
      case 'overlap':
        return `${piece(i.itemId)} overlaps ${piece(i.otherId).toLowerCase()}.`;
      case 'wall':
        return `${piece(i.itemId)} goes into a wall.`;
      case 'door':
        return `${piece(i.itemId)} is in a door’s swing.`;
      case 'door-front':
        return `A door hits ${piece(i.itemId).toLowerCase()}’s doors.`;
      case 'doors':
        return 'Two doors hit each other.';
      case 'walkway':
        return `The way through narrows to ${i.have.toFixed(2)} m; it needs ${i.need.toFixed(2)} m.`;
    }
  };
  for (const i of clearance.filter((x) => hard.has(x.kind))) {
    problems.push({
      kind: 'clearance',
      text: issueText(i),
      issue: i,
      ...('itemId' in i ? { itemId: i.itemId } : {}),
    });
  }
  // The walkways as last checked (electrical points don't change them).
  const walk = walked ?? walkwayReport(level);
  if (walk.status === 'no-main-door') {
    problems.push({ kind: 'walkway', text: 'Add the main door to check walkways and deliveries.' });
  }
  for (const i of walk.issues) {
    problems.push({ kind: 'walkway', text: issueText(i), issue: i, itemId: i.itemId });
  }
  const from = entranceDoor(level);
  if (from) {
    const checked = new Map<string, Delivery>();
    for (const id of [...placedNew].sort()) {
      const it = level.items[id];
      if (!it || !deliverable(it.assetId)) continue;
      const sz = itemSize(it);
      const room = roomIdAt(level, centreOf(it));
      const k = `${it.assetId}|${sz.w.toFixed(2)}|${sz.d.toFixed(2)}|${sz.h.toFixed(2)}|${room}`;
      const d =
        checked.get(k) ??
        deliveryCheck(level, id, { from, ...(opts.site?.lift ? { lift: opts.site.lift } : {}) });
      checked.set(k, d);
      if (d.status === 'unreachable') {
        const kind = furnitureKind(it.assetId);
        const where = room ? (level.rooms[room]?.name ?? 'its room') : 'its room';
        problems.push({
          kind: 'delivery',
          delivery: d,
          itemId: id,
          text: `The ${kind ? nameOf(kind) : 'piece'} can’t be carried into ${where}: there’s no way in from the main door.`,
        });
      } else if (d.status === 'too-big' || d.status === 'hinges') {
        const kind = furnitureKind(it.assetId);
        const where = room ? (level.rooms[room]?.name ?? 'its room') : 'its room';
        const what = `The ${kind ? nameOf(kind) : 'piece'}`;
        const rigid = partsNote(d);
        problems.push({
          kind: 'delivery',
          delivery: d,
          itemId: id,
          text: `${
            d.status === 'too-big'
              ? `${what} won’t get into ${where}: it is too big for a door on the way.`
              : `${what} gets into ${where} only with a door taken off its hinges.`
          }${rigid ? ` ${rigid}` : ''}`,
        });
      }
    }
  }
  const windowsOf = new Set<string>();
  for (const o of Object.values(level.openings)) {
    if (o.kind !== 'window') continue;
    for (const r of roomsBeside(level, o.wallId)) if (r) windowsOf.add(r);
  }
  for (const r of Object.values(level.rooms)) {
    const use = uses[r.id];
    const bedroom = use ? BEDROOM_USES.has(use) : roomKind(r.name) === 'bedroom';
    if (bedroom && !windowsOf.has(r.id)) {
      problems.push({
        kind: 'window',
        roomId: r.id,
        text: `${r.name} has no window. A bedroom needs one for light and air.`,
      });
    }
  }
  problems.push(...elderDoors(level, uses, brief.household.elders, brief.rooms));
  // Room to use a piece (a wardrobe's doors, beside a bed): advice, as on the plan.
  for (const i of clearance.filter((x) => x.kind === 'zone')) {
    problems.push({ kind: 'clearance', text: issueText(i), issue: i, itemId: i.itemId });
  }
  if (walls.structural.length) {
    const n = walls.structural.length;
    problems.push({
      kind: 'structural',
      text: `${n === 1 ? 'A change touches a structural wall' : `${n} changes touch structural walls`}: it needs HDB approval and a professional engineer.`,
    });
  }

  // The design checks, and which of them the plan already had before this version.
  const designedRooms = new Set(
    resultSpaces.filter((s) => s.storedKey && s.status !== 'missing').flatMap((s) => s.rooms),
  );
  const baseKeys = baseChecks(start, brief, uses, opts.rules, opts.kept);
  // A piece the version copied (an earlier version's room, placed again) has a new id but the
  // plan's pose: it is the plan's piece, its checks keyed as the plan's.
  const poseKey = (it: {
    assetId: string;
    position: { x: number; z: number };
    rotationY: number;
  }) =>
    `${it.assetId}|${it.position.x.toFixed(3)}|${it.position.z.toFixed(3)}|${it.rotationY.toFixed(3)}`;
  const startByPose = new Map(Object.values(start.items).map((it) => [poseKey(it), it.id]));
  const twinOf = (id: string): string => {
    if (start.items[id]) return id;
    const a = level.items[id];
    return (a && startByPose.get(poseKey(a))) ?? id;
  };
  const unchanged = (id: string) => {
    const a = level.items[id];
    const b = start.items[twinOf(id)];
    return (
      !!a &&
      !!b &&
      a.assetId === b.assetId &&
      Math.abs(a.position.x - b.position.x) < 1e-3 &&
      Math.abs(a.position.z - b.position.z) < 1e-3 &&
      Math.abs(a.rotationY - b.rotationY) < 1e-3
    );
  };
  const spaceKeyOf = (roomId: string | null) =>
    roomId ? (resultSpaces.find((s) => s.rooms.includes(roomId))?.key ?? null) : null;
  const checks: ResultCheck[] = designChecks(level, {
    brief,
    uses,
    clearance: issues,
    walk,
    ...rulesOpt,
  }).map((c) => {
    // In the plan before and not the version's doing: a piece it didn't touch, a room it
    // didn't furnish, or what furnishing can't change (a window, the bedroom count).
    // Someone with nowhere to sleep is always the version's to answer for.
    // A proposal's kept piece (no plan id) is never in the plan before: always the version's.
    const already =
      !c.key.startsWith('P1|unplaced') &&
      !(c.key.startsWith('K|') && !c.itemId) &&
      baseKeys.has(c.itemId ? swapSegment(c.key, c.itemId, twinOf(c.itemId)) : c.key) &&
      (c.itemId
        ? unchanged(c.itemId)
        : c.roomId
          ? !designedRooms.has(c.roomId) || !!c.unfixable
          : true);
    const it = c.itemId ? level.items[c.itemId] : undefined;
    let part: ResultCheck['part'] = null;
    if (it) {
      const key = spaceKeyOf(roomIdAt(level, centreOf(it)));
      const aspect = aspectOf(it);
      if (key && (aspect === 'furniture' || aspect === 'built-ins')) part = { space: key, aspect };
    } else if (c.key.startsWith('P1|window')) {
      part = { aspect: 'walls' };
    }
    // A missing piece (a bed, a seat) is the room's: the pieces that are there stay ticked.
    return { ...c, already, part };
  });
  const passes = !checks.some((c) => c.hard && !c.already);

  // 6. Cost, against the brief's budget.
  const cost = costEstimate(before, level, opts.rates ?? TYPICAL_RATES);
  const budget = !brief.budget ? 'unknown' : cost.low > brief.budget.high ? 'over' : 'within';
  if (budget === 'over' && brief.budget) {
    const over = Math.round((cost.low - brief.budget.high) / 100) * 100;
    problems.push({
      kind: 'budget',
      text: `About S$${over.toLocaleString('en-SG')} over your top figure. Try “Cheaper”.`,
    });
  }

  return {
    level,
    spaces: resultSpaces,
    uses,
    applied: walls.applied,
    refused,
    repaired,
    dropped,
    notes,
    structural: walls.structural,
    problems,
    checks,
    passes,
    refs,
    resolves,
    swaps,
    cost,
    points,
    budget,
  };
}

/** Where each zone of a space is: the outlines of its rooms of that use (all of them for none). */
function zoneAreaOf(
  level: Level,
  rooms: string[],
  uses: Record<string, RoomUse>,
  brief: DesignInput['brief'],
): (z: Zone | null) => Vec2[][] {
  const shapes = roomShapes(level);
  const all = rooms.flatMap((id) => {
    const sh = shapes.get(id);
    return sh ? [sh.outer] : [];
  });
  const of = new Map<Zone, Vec2[][]>();
  for (const id of rooms) {
    const sh = shapes.get(id);
    if (!sh) continue;
    const name = level.rooms[id]?.name ?? '';
    const us = usesOf(level, id, { brief, uses });
    const zones = new Set<Zone>(['store']);
    if (us.some((u) => BEDROOM_USES.has(u as RoomUse))) zones.add('sleep');
    if (us.includes('living')) zones.add('lounge');
    if (us.includes('dining') || /dry kitchen|dining/i.test(name)) zones.add('dine');
    if (us.includes('study')) zones.add('work');
    if (us.includes('kitchen')) zones.add('cook');
    for (const z of zones) of.set(z, [...(of.get(z) ?? []), sh.outer]);
  }
  return (z) => (z ? (of.get(z) ?? all) : all);
}

const solveMemo = new Map<string, SolveOutcome>();
/** Poses a walkway re-solve may try before it stops looking ahead and going back. */
const RESOLVE_BUDGET = 3000;
/** The bare plan's ways by its walls, doors and rooms (geomKey). */
const waysMemo = new Map<string, ReturnType<typeof keepOutOf>>();
const WAYS_KEEP = 8;

/** Keeps a value in a small memo, the oldest going first. */
function remember<T>(memo: Map<string, T>, key: string, value: T): T {
  if (memo.size >= WAYS_KEEP) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  memo.set(key, value);
  return value;
}
const settledMemo = new Map<string, SolveOutcome>();

/** What the walkway step knows of the house rules, and every hard check's key on a level. */
interface House {
  rules: readonly Rule[];
  usesOf: (roomId: string) => ProgrammeUse[];
  /** The hard checks' keys (the design checks with the rules, as `spaceHard` counts them). */
  hard: (level: Level, walk?: WalkwayReport) => Set<string>;
}

/** The hard failures on a level the walkway step can change: walkways, clearances. */
function hardCount(level: Level, walk?: WalkwayReport): number {
  const w = (walk ?? walkwayReport({ ...level, items: { ...level.items } })).issues.filter(
    (i) => i.route !== 'bed' || i.have < BED_ACCESS - 0.005,
  ).length;
  const c = clearanceIssues(level).filter((i) => {
    if (i.kind === 'zone') {
      const it = level.items[i.itemId];
      const need = (it && ACCESS[it.assetId]?.hard) ?? i.need;
      return i.have < need - 0.005;
    }
    return (
      i.kind === 'overlap' || i.kind === 'wall' || i.kind === 'door' || i.kind === 'door-front'
    );
  }).length;
  return w + c;
}

/** A check's key with one `|`-delimited segment (a piece's id) swapped for another. */
export const swapSegment = (key: string, from: string, to: string) =>
  key
    .split('|')
    .map((part) => (part === from ? to : part))
    .join('|');

const baseMemo = new WeakMap<Level, Map<string, Set<string>>>();

/** The checks' keys on the plan a version was made on (kept per plan and brief). */
function baseChecks(
  start: Level,
  brief: DesignInput['brief'],
  uses: Record<string, RoomUse>,
  rules?: readonly Rule[],
  kept?: readonly Kept[],
): Set<string> {
  const k = stableJson([brief, uses, rules ?? [], kept ?? []]);
  const per = baseMemo.get(start) ?? new Map<string, Set<string>>();
  baseMemo.set(start, per);
  const hit = per.get(k);
  if (hit) return hit;
  // The version's room uses, so the same failure has the same key on both.
  const keys = new Set(
    designChecks(start, {
      brief,
      uses,
      ...(rules?.length ? { rules } : {}),
      ...(kept?.length ? { kept } : {}),
    }).map((c) => c.key),
  );
  per.set(k, keys);
  if (per.size > 4) per.delete(per.keys().next().value as string);
  return keys;
}

/** Pieces left out, short of room and turned from what they go with (piecesNoWorse). */
type PieceCounts = { dropped: number; soft: number; broken: number };
/** First solves that took the lenses' weights (their re-solves keep them). */
const steeredSolves = new WeakSet<SolveOutcome>();

/**
 * A space's failing hard checks (their keys) on `level` with only the space furnished: its own
 * pieces (`inSpace`) and `extra`, the rest of the plan as it is. One place, so whatever checks
 * the space (house rules too) is threaded through once.
 */
function spaceHardKeys(
  level: Level,
  inSpace: (it: Item) => boolean,
  opts: CheckOptions,
  extra: Item[] = [],
): Set<string> {
  const items: Record<string, Item> = {};
  for (const [id, it] of Object.entries(level.items)) if (inSpace(it)) items[id] = it;
  for (const it of extra) items[it.id] = it;
  return new Set(
    designChecks({ ...level, items }, opts)
      .filter((c) => c.hard)
      .map((c) => c.key),
  );
}

/** Two solves that place the same pieces in the same places. */
const samePoses = (a: SolveOutcome, b: SolveOutcome) =>
  a.items.length === b.items.length &&
  a.items.every((it, i) => {
    const o = b.items[i];
    return (
      !!o &&
      o.id === it.id &&
      o.assetId === it.assetId &&
      Math.abs(o.position.x - it.position.x) < 1e-6 &&
      Math.abs(o.position.z - it.position.z) < 1e-6 &&
      Math.abs(o.rotationY - it.rotationY) < 1e-6 &&
      Math.abs(o.scale.x - it.scale.x) < 1e-6
    );
  });
const countsOf = (o: SolveOutcome): PieceCounts => ({
  dropped: o.dropped.length,
  soft: o.soft,
  broken: o.broken,
});

/** How many times the walkways are checked again after moving pieces off them. */
const WALK_ROUNDS = 3;

/**
 * Moves pieces the version placed off the walkways they narrow: each blamed piece is placed
 * again (on any wall, or near where it was) keeping out of the way around the narrow point.
 * One that can't be is left where it was. Mutates `lvl`.
 */
/** A furnished space: its index and pieces, and (by intent) how to solve it again. */
interface Run {
  key: string;
  ix: SpaceIndex;
  wants: Want[];
  /**
   * Solves the space again keeping out of `keepOut`; with `noWorseThan`, it stops (aborted) once
   * it can only end with more pieces left out, short of room or turned than that.
   */
  solveWith?: (
    keepOut: SpaceIndex['keepOut'],
    keepOutFor?: Set<string>,
    noWorseThan?: PieceCounts,
  ) => SolveOutcome;
  /** By id: pieces that stand free (moved off a walkway before the wall pieces). */
  free?: Set<string>;
  /** The solve in the level now, and how to put a solve in or take it out. */
  outcome?: SolveOutcome;
  apply?: (o: SolveOutcome) => void;
  unapply?: () => void;
  /** Remembers a re-solve taken, so the same space is placed so next time at once. */
  settle?: (o: SolveOutcome) => void;
  /** The space's hard checks (their keys) on a level, the space alone furnished. */
  spaceHard?: (l: Level) => Set<string>;
}

function keepWalkwaysClear(
  lvl: Level,
  runs: Run[],
  repaired: Note[],
  resolves: DesignResult['resolves'],
  house: House,
): WalkwayReport | null {
  const moved = new Set<string>();
  const kept = new Map<Run, SpaceIndex['keepOut']>();
  const keptFor = new Map<Run, Set<string>>();
  /** Spaces whose re-solve was no better: not tried again. */
  const rejected = new Set<Run>();
  for (let round = 0; round < WALK_ROUNDS; round++) {
    const report = walkwayReport({ ...lvl, items: { ...lvl.items } });
    // Hard ones only: 0.50 m to a bed side is enough to get in.
    const blamed = report.issues.filter(
      (i) =>
        (i.route !== 'bed' || i.have < BED_ACCESS - 0.005) &&
        (!moved.has(i.itemId) ||
          runs.some((r) => r.solveWith && r.wants.some((w) => w.id === i.itemId))),
    );
    // House rules that keep pieces out of somewhere (nothing in the way, keep a spot clear):
    // their failing pieces are kept out of it the same way (slice 3a §3.4).
    const ruled = house.rules.length
      ? ruleKeepOuts(house.rules, {
          // A fresh object: the walkway passes are cached per level.
          level: { ...lvl, items: { ...lvl.items } },
          usesOf: house.usesOf,
        }).filter(
          (k) =>
            !moved.has(k.itemId) ||
            runs.some((r) => r.solveWith && r.wants.some((w) => w.id === k.itemId)),
        )
      : [];
    if (!blamed.length && !ruled.length) return report;
    let changed = false;
    /** The hard checks' keys on the level as it is this round (for a rule move). */
    let roundHard: Set<string> | null = null;
    // Spaces placed by intent are solved again, keeping out of every way they narrowed.
    const again = new Set<Run>();
    // Of the pieces narrowing one way, those standing free move; the wall pieces only if none do.
    const byPinch = new Map<string, typeof blamed>();
    for (const issue of blamed) {
      const k = JSON.stringify(issue.pinch);
      byPinch.set(k, [...(byPinch.get(k) ?? []), issue]);
    }
    for (const group of byPinch.values()) {
      const run = runs.find(
        (r) => r.solveWith && group.some((i) => r.wants.some((w) => w.id === i.itemId)),
      );
      if (!run || rejected.has(run)) continue;
      const ids = group.map((i) => i.itemId).filter((id) => run.wants.some((w) => w.id === id));
      const free = ids.filter((id) => run.free?.has(id));
      const issue = group[0] as (typeof group)[number];
      for (const id of ids) moved.add(id);
      kept.set(run, [...(kept.get(run) ?? []), ...keepOutOf(issue.path, issue.pinch, issue.need)]);
      keptFor.set(run, new Set([...(keptFor.get(run) ?? []), ...(free.length ? free : ids)]));
      again.add(run);
    }
    for (const k of ruled) {
      const run = runs.find((r) => r.solveWith && r.wants.some((w) => w.id === k.itemId));
      if (!run || rejected.has(run)) continue;
      moved.add(k.itemId);
      kept.set(run, [...(kept.get(run) ?? []), ...k.polys.map(shape)]);
      keptFor.set(run, new Set([...(keptFor.get(run) ?? []), k.itemId]));
      again.add(run);
    }
    for (const run of again) {
      const was = run.outcome;
      // Taken whole, and only if strictly better and no worse in any way (acceptResolve).
      const pieces = (o: SolveOutcome): PieceCounts => ({
        dropped: o.dropped.length,
        soft: o.soft,
        broken: o.broken,
      });
      // A re-solve that can only end worse in pieces stops early (aborted): refused as it would be.
      const out = run.solveWith?.(kept.get(run) ?? [], keptFor.get(run), was && pieces(was));
      if (!out || !was || !run.apply || !run.unapply) continue;
      if (out.aborted || !piecesNoWorse(pieces(was), pieces(out)) || !run.spaceHard) {
        rejected.add(run);
        continue;
      }
      const before = {
        keys: run.spaceHard(lvl),
        plan: changed ? hardCount(lvl) : hardCount(lvl, report),
        ...pieces(was),
      };
      run.unapply();
      run.apply(out);
      const after = { keys: run.spaceHard(lvl), plan: hardCount(lvl), ...pieces(out) };
      const better = acceptResolve(before, after);
      resolves.push({
        space: run.key,
        before: before.keys.size,
        after: after.keys.size,
        taken: better,
      });
      if (better) {
        run.outcome = out;
        run.settle?.(out);
        changed = true;
      } else {
        run.unapply();
        run.apply(was);
        rejected.add(run);
      }
    }
    for (const issue of blamed) {
      const run = runs.find((r) => !r.solveWith && r.wants.some((w) => w.id === issue.itemId));
      const want = run?.wants.find((w) => w.id === issue.itemId);
      const was = lvl.items[issue.itemId];
      if (!run || !want || !was) continue;
      moved.add(issue.itemId);
      const ix = run.ix;
      const placed = ix.placed;
      ix.placed = placed.filter((p) => p.id !== issue.itemId);
      ix.keepOut = keepOutOf(issue.path, issue.pinch, issue.need);
      const out = placePiece(ix, want);
      ix.keepOut = [];
      if (!out.item) {
        ix.placed = placed;
        continue;
      }
      lvl.items[out.item.id] = out.item;
      changed = true;
      repaired.push({
        text: `Moved the ${nameOf(want.kind)} out of the way through: it left ${issue.have.toFixed(2)} m where ${issue.need.toFixed(2)} m is needed.`,
        ref: want.ref,
        itemId: out.item.id,
        space: run.key,
      });
    }
    for (const k of ruled) {
      const run = runs.find((r) => !r.solveWith && r.wants.some((w) => w.id === k.itemId));
      const want = run?.wants.find((w) => w.id === k.itemId);
      if (!run || !want || !lvl.items[k.itemId] || moved.has(k.itemId)) continue;
      moved.add(k.itemId);
      const ix = run.ix;
      const placed = ix.placed;
      ix.placed = placed.filter((p) => p.id !== k.itemId);
      ix.keepOut = k.polys.map(shape);
      const out = placePiece(ix, want);
      ix.keepOut = [];
      if (!out.item) {
        ix.placed = placed;
        continue;
      }
      // Taken only if the rule now holds for it and no hard check is added, the design checks
      // included (as acceptResolve). The level before is worked out once a round.
      const copy = (l: Level) => ({ ...l, items: { ...l.items } });
      roundHard ??= house.hard(copy(lvl), changed ? undefined : report);
      const before = roundHard;
      const was = lvl.items[k.itemId];
      lvl.items[out.item.id] = out.item;
      const after = house.hard(copy(lvl));
      if (after.has(k.key) || [...after].some((x) => !before.has(x))) {
        if (was) lvl.items[k.itemId] = was;
        ix.placed = placed;
        continue;
      }
      roundHard = after;
      changed = true;
      repaired.push({
        text: `Moved the ${nameOf(want.kind)} to keep your rule “${k.ruleName}”.`,
        ref: want.ref,
        itemId: out.item.id,
        space: run.key,
      });
    }
    if (!changed) return report;
  }
  return null;
}

/**
 * Doors too narrow for an elder: to their room (a 'parents' room) and to the bathroom nearest
 * it. A walking frame or a wheelchair needs 0.85 m; a stick, 0.80 m.
 */
function elderDoors(
  level: Level,
  uses: Record<string, RoomUse>,
  elders: DesignInput['brief']['household']['elders'],
  briefRooms: DesignInput['brief']['rooms'],
): DesignProblem[] {
  const need = Math.max(
    0,
    ...elders.map((e) => (e === 'walks' ? 0 : ELDER_NEED[e as keyof typeof ELDER_NEED])),
  );
  if (!need) return [];
  const aid = elders.some((e) => e === 'frame' || e === 'wheelchair')
    ? 'a walking frame or wheelchair'
    : 'someone with a stick';
  const theirs = Object.keys(level.rooms).filter(
    (id) => uses[id] === 'parents' || briefRooms[id]?.use === 'parents',
  );
  const doorsOf = (roomId: string) =>
    Object.values(level.openings).filter(
      (o) => o.kind === 'door' && roomsBeside(level, o.wallId).includes(roomId),
    );
  const shapes = roomShapes(level);
  const mid = (id: string) => {
    const s = shapes.get(id);
    const n = s?.outer.length ?? 1;
    return (s?.outer ?? []).reduce((p, q) => ({ x: p.x + q.x / n, y: p.y + q.y / n }), {
      x: 0,
      y: 0,
    });
  };
  const out: DesignProblem[] = [];
  const check = (roomId: string) => {
    const name = level.rooms[roomId]?.name ?? 'the room';
    for (const o of doorsOf(roomId)) {
      if (o.width < need - 1e-6) {
        out.push({
          kind: 'door-width',
          roomId,
          openingId: o.id,
          text: `The door to ${name} is ${o.width.toFixed(2)} m; ${need.toFixed(2)} m lets ${aid} through.`,
        });
      }
    }
  };
  const baths = Object.values(level.rooms).filter((r) => WET.test(r.name));
  for (const id of theirs) {
    check(id);
    const m = mid(id);
    const bath = baths
      .map((b) => ({ b, d: Math.hypot(mid(b.id).x - m.x, mid(b.id).y - m.y) }))
      .sort((p, q) => p.d - q.d)[0]?.b;
    if (bath) check(bath.id);
  }
  return out;
}
