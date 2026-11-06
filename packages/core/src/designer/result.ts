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
import { SHELTER_ROOM } from '../structural';
import { type Suggestion, roomKind, suggestPoints } from '../suggest';
import { walkwayReport } from '../walkway';
import { type AliasMap, resolveAlias } from './aliases';
import { fixedSize, priorityOf, resolveAsset } from './catalogue';
import { WET } from './locks';
import { type Want, addToIndex, nameOf, placePiece, spaceIndex } from './place';
import type { Concept, DesignInput, DesignItem, RoomUse, SpaceDesign, SpaceStatus } from './schema';
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
  cost: CostEstimate;
  points: Suggestion[];
  budget: 'within' | 'over' | 'unknown';
}

export interface DesignOptions {
  rates?: Rates;
  site?: Site;
  /** The project's own furniture models. */
  models?: Project['models'];
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
  const key = [
    design.id,
    levelFingerprint(baseLevel),
    levelFingerprint(beforeLevel),
    hash(stableJson(design)),
    hash(stableJson(opts)),
  ].join('|');
  const hit = memo.get(key);
  if (hit) return hit;
  const out = freeze(work(baseLevel, beforeLevel, design, opts), true);
  memo.set(key, out);
  if (memo.size > 8) memo.delete(memo.keys().next().value as string);
  return out;
}

function work(
  baseLevel: Level,
  beforeLevel: Level,
  design: DesignInput,
  opts: DesignOptions,
): DesignResult {
  const { brief, aliases, concept } = design;
  const repaired: Note[] = [];
  const dropped: Note[] = [];
  const notes: Note[] = (concept?.notes ?? []).map((text) => ({ text }));
  const start = settled(baseLevel);
  const before = settled(beforeLevel);

  // 1. Walls.
  const walls = applyDesignWalls(
    start,
    before,
    concept?.walls ?? [],
    brief.walls,
    aliases,
    design.id,
  );
  const lvl: Level = structuredClone(walls.level);
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
    floorRoom(id, r.floor);
    paintRoom(id, r.paint);
  }
  for (const b of concept?.bathrooms ?? []) {
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

    const faces = facesOf(named, s.rooms, geom);
    const longest = (f: Face) => Math.max(0, ...clearStretches(f, 0, 1).map(([a, b]) => b - a));
    const byLength = [...faces].sort((p, q) => longest(q) - longest(p));
    const wants = answer.items
      .map((a) => resolveWant(a, { s, key, faces, byLength }))
      .filter((w): w is Want & { priority: number } => !!w)
      .sort((p, q) => p.priority - q.priority || (p.ref < q.ref ? -1 : p.ref > q.ref ? 1 : 0));
    // The sink and the hob stay where they are unless the answer puts new ones in.
    const replaces = new Set(wants.map((w) => w.kind.id).filter((id) => WET_PIECES.has(id)));

    // Clear the space, but for what the brief keeps where it is (and the sink and hob).
    const takenOut: Item[] = [];
    for (const it of Object.values(lvl.items)) {
      if (!inRooms(s.rooms, centreOf(it))) continue;
      if (brief.keep.items[it.id] === 'in-place') continue;
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
    for (const want of wants) {
      const out = placePiece(ix, want);
      repaired.push(...out.repaired.map((n) => ({ ...n, space: s.key })));
      dropped.push(...out.dropped.map((n) => ({ ...n, space: s.key })));
      const item = out.item;
      if (!item) continue;
      // Wherever repair moved it, a sink or a hob stands wholly in the kitchen's wet area.
      if (WET_PIECES.has(want.kind.id) && !inset(itemFootprint(item, want.kind)).every(inKitchen)) {
        ix.placed = ix.placed.filter((p) => p.id !== item.id);
        dropped.push({ text: wetText(want.kind.id), ref: want.ref, space: s.key });
        continue;
      }
      lvl.items[item.id] = item;
      rs.items.push(item.id);
      placedKinds.add(want.kind.id);
      if (want.brought) placedBrought.add(item.id);
      else placedNew.add(item.id);
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
    for (const f of answer.faces) {
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
    ctx: { s: Space; key: string; faces: Face[]; byLength: Face[] },
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
    if (a.wall && !face) {
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
    if (!face && !free && !k.againstWall && !k.carpentry) {
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
      faces: free ? [] : ctx.byLength,
      along: a.along,
      at: free ? a.at : null,
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
  const walk = walkwayReport(level);
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
    cost,
    points,
    budget,
  };
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
