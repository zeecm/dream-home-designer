import { produce } from 'immer';
import { addOpening, deleteOpening, deleteWall, drawWall, updateWall } from '../commands';
import { doorGraph, doorSearch, entranceDoor } from '../delivery';
import type { Command } from '../history';
import { planGeometry } from '../plan';
import { renovationBreaches } from '../renovation';
import { type Level, type Opening, type Project, type Vec2, isBoundary } from '../schema';
import { segmentIntersection } from '../snap';
import { SHELTER_ROOM, sidesOf, wallStatuses } from '../structural';
import { roomKind } from '../suggest';
import { type AliasMap, resolveAlias } from './aliases';
import { WET, type WallLock, designLocks } from './locks';
import type { DesignBrief, DesignOp } from './schema';
import { roomIdAt } from './spaces';
import { seededId, settled } from './util';

/** Something the designer wanted, or did, in words; with what it is about. */
export interface Note {
  text: string;
  /** The piece's own label in the answer ("bed1"). */
  ref?: string;
  space?: string;
  itemId?: string;
  wallId?: string;
  openingId?: string;
  roomId?: string;
}

export const LOCK_TEXT: Record<WallLock, string> = {
  shelter: 'household shelter walls can’t be changed. HDB doesn’t allow it.',
  outside: 'outside walls stay.',
  wet: 'bathroom walls stay (wet area).',
  structural: 'a structural wall. Tick “Also suggest structural changes” in the brief to allow it.',
  likely:
    'probably a structural wall (it is thick). Tick “Also suggest structural changes” in the brief to allow it.',
};
export const KEEP_TEXT = 'Change any wall: you asked to keep all walls.';
const WINDOWS_STAY = 'windows stay.';

/** New partitions: 100 mm, on the plan's axes within 2°, ends within 0.15 m of a wall. */
export const NEW_WALL = { thickness: 0.1, skew: (2 * Math.PI) / 180, snap: 0.15, min: 0.3 };
/** New doors at least this wide (a bathroom's 0.65 m). */
export const MIN_DOOR = 0.75;
export const MIN_BATH_DOOR = 0.65;
/** A new wall's end stays this far from any opening in the wall it meets. */
export const OPENING_CLEAR = 0.1;

export interface WallsResult {
  level: Level;
  /** Ops left out, each with why. */
  refused: Note[];
  /** Ops used, each in words; structural ones end "(structural)". */
  applied: Note[];
  /** The structural walls changed (allowed by the brief), by id. */
  structural: string[];
}

class Refused extends Error {}

const fmt = (p: Vec2) => `(${p.x.toFixed(2)}, ${p.y.toFixed(2)})`;

/**
 * The concept's wall changes applied to `base` (the level designed on) with the app's own
 * commands, op by op. `before` (the flat as it is) decides what is structural. Locked walls,
 * windows and the main door are refused with the reason; under `walls: 'keep'` every op is.
 * New walls and doors get ids seeded by `seed`, so the same answer always makes the same
 * level. Last, belt and braces: if the result changes the shelter at all, none of it is used.
 */
export function applyDesignWalls(
  base: Level,
  before: Level,
  ops: DesignOp[],
  walls: DesignBrief['walls'],
  aliases: AliasMap,
  seed: string,
): WallsResult {
  const start = settled(base);
  if (walls === 'keep') {
    return {
      level: start,
      refused: ops.map(() => ({ text: KEEP_TEXT })),
      applied: [],
      structural: [],
    };
  }
  const locks = designLocks(before, start);
  const statuses = wallStatuses(before);
  const mainDoors = [entranceDoor(before), entranceDoor(start)].filter(
    (x): x is string => !!x && !!start.openings[x],
  );
  // Windows and the main door stay exactly where they are, whatever an op does to their wall.
  const fixed = [
    ...Object.values(start.openings)
      .filter((o) => o.kind === 'window')
      .map((o) => o.id),
    ...mainDoors,
  ].map((id) => ({ id, span: openingSpanOnPlan(start, id) }));
  const between = (wallId: string) => {
    const names = sidesOf(start, wallId).map((s) => s ?? 'outside');
    return `the wall between ${names.join(' and ')}`;
  };
  const described = ops.map((o) =>
    describe(o, start, resolveAlias(aliases, o.wall), resolveAlias(aliases, o.opening), between),
  );
  const about = (o: DesignOp) => {
    const wallId = resolveAlias(aliases, o.wall);
    const openingId = resolveAlias(aliases, o.opening);
    return { ...(wallId ? { wallId } : {}), ...(openingId ? { openingId } : {}) };
  };

  /** The ops in order, but for those in `skip`; each refused op left out with why. */
  const run = (skip: Set<number>) => {
    let lvl: Level = start;
    const applied: { i: number; note: Note }[] = [];
    const refused: { i: number; note: Note }[] = [];
    const structural: string[] = [];
    const apply = (cmd: Command) => {
      const doc = { levels: [lvl] } as unknown as Project;
      lvl = produce(doc, (d) => cmd.recipe(d))?.levels[0] ?? lvl;
    };
    ops.forEach((o, i) => {
      if (skip.has(i)) return;
      const wallId = resolveAlias(aliases, o.wall);
      const openingId = resolveAlias(aliases, o.opening);
      const what = described[i] as string;
      const was = lvl;
      const touched: string[] = [];
      /** A wall the op may change: there, and not locked (structural only if the brief allows). */
      const changeable = (id: string | null, alias: string | null): string => {
        const w = id ? lvl.walls[id] : undefined;
        if (!id || !w) throw new Refused(`there’s no wall “${alias ?? ''}” on the plan.`);
        const lock = locks.get(id);
        if (lock === 'structural' || lock === 'likely') {
          if (walls !== 'structural') throw new Refused(LOCK_TEXT[lock]);
          touched.push(id);
        } else if (lock) throw new Refused(LOCK_TEXT[lock]);
        return id;
      };
      try {
        if (o.op === 'remove_wall' || o.op === 'half_wall' || o.op === 'glass_wall') {
          const id = changeable(wallId, o.wall);
          const w = lvl.walls[id]!;
          if (o.op === 'remove_wall') apply(deleteWall(lvl.id, id, lvl));
          else if (isBoundary(w)) throw new Refused('a room boundary isn’t a wall.');
          else if (o.op === 'glass_wall') {
            apply(
              updateWall(lvl.id, id, { build: 'glass', thickness: Math.min(w.thickness, 0.08) }),
            );
          } else {
            const h = Math.min(lvl.ceilingHeight - 0.1, Math.max(0.6, o.height ?? 1));
            apply(updateWall(lvl.id, id, { height: h }));
          }
        } else if (o.op === 'add_door') {
          const id = changeable(wallId, o.wall);
          apply(addOpening(lvl.id, newDoor(lvl, id, o)).command);
        } else if (o.op === 'remove_opening') {
          const op = openingId ? lvl.openings[openingId] : undefined;
          if (!op || !openingId) {
            throw new Refused(`there’s no door or window “${o.opening ?? ''}” on the plan.`);
          }
          if (op.kind === 'window') throw new Refused(WINDOWS_STAY);
          if (mainDoors.includes(openingId)) throw new Refused('the main door stays.');
          changeable(op.wallId, o.opening);
          apply(deleteOpening(lvl.id, openingId));
        } else if (o.op === 'add_wall') {
          const { ends, onto } = newWallEnds(lvl, o);
          // Tying into a wall is work on it: never the shelter's, a structural one only if allowed.
          for (const id of onto) {
            const lock = locks.get(id);
            if (lock === 'shelter') throw new Refused(LOCK_TEXT.shelter);
            // An outside wall can be structural too: its status decides.
            const status = statuses.get(id) ?? lock;
            if (status === 'structural' || status === 'likely') {
              if (walls !== 'structural') throw new Refused(LOCK_TEXT[status]);
              touched.push(id);
            }
          }
          const [a, b] = ends;
          apply(
            drawWall(lvl, { point: a }, { point: b }, { thickness: NEW_WALL.thickness }).command,
          );
        }
        const moved = fixed.some(({ id, span }) => !sameSpan(span, openingSpanOnPlan(lvl, id)));
        if (moved) throw new Refused('it would move a window or the main door.');
        for (const id of touched) if (!structural.includes(id)) structural.push(id);
        const text = touched.length ? `${what} (structural)` : what;
        applied.push({ i, note: { text, ...about(o) } });
      } catch (e) {
        lvl = was;
        const why = e instanceof Refused ? e.message : 'the plan’s own commands refused it.';
        refused.push({ i, note: { text: `${what}: ${why}`, ...about(o) } });
      }
    });
    return { lvl, applied, refused, structural };
  };

  // No room may be cut off from the main door. An op that does (a door closed up, a wall that
  // leaves part of a room with no way in) is left out, unless a later op opens a way again.
  const shut = new Set(unreachableRooms(start));
  const cut = (l: Level) => unreachableRooms(l).filter((id) => !shut.has(id));
  const skip = new Set<number>();
  const cutBy = new Map<number, string[]>();
  let r = run(skip);
  for (let guard = 0; guard < ops.length && cut(r.lvl).length; guard++) {
    const lvl = r.lvl;
    const rooms = cut(lvl).map((id) => lvl.rooms[id]?.name ?? 'a room');
    const order = r.applied.map((a) => a.i).reverse();
    const one = order.find((i) => !cut(run(new Set([...skip, i])).lvl).length);
    const drop = one ?? order[0];
    if (drop === undefined) break;
    skip.add(drop);
    cutBy.set(drop, rooms);
    r = run(skip);
  }
  const refused = [
    ...r.refused,
    ...[...cutBy].map(([i, rooms]) => ({
      i,
      note: {
        text: `${described[i]}: it would leave ${[...new Set(rooms)].join(' and ')} with no way in.`,
        ...about(ops[i] as DesignOp),
      },
    })),
  ]
    .sort((p, q) => p.i - q.i)
    .map((x) => x.note);
  const applied = r.applied.map((a) => a.note);
  const structural = [...r.structural];

  const level = canonicalIds(start, r.lvl, seed);
  // Belt and braces: whatever slipped past the locks, the shelter never changes, and nor does
  // a structural wall unless the brief allows it.
  const was = renovationBreaches(before, start);
  const now = renovationBreaches(before, level);
  const shelter = [...now.shelter].some((id) => !was.shelter.has(id));
  const newStructural = [...now.structural].filter((id) => !was.structural.has(id));
  if (shelter || (walls !== 'structural' && newStructural.length)) {
    const why = shelter ? 'it would change the shelter' : 'it would change a structural wall';
    for (const a of applied) refused.push({ ...a, text: `${a.text}: ${why}.` });
    return { level: start, refused, applied: [], structural: [] };
  }
  for (const id of newStructural) if (!structural.includes(id)) structural.push(id);
  return { level, refused, applied, structural };
}

/** Where an opening is on the plan: its two ends, along its wall. */
export function openingSpanOnPlan(level: Level, id: string): [Vec2, Vec2] | null {
  const o = level.openings[id];
  const w = o && level.walls[o.wallId];
  const a = w && level.vertices[w.a];
  const b = w && level.vertices[w.b];
  if (!o || !a || !b) return null;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const c = { x: a.x + (b.x - a.x) * o.t, y: a.y + (b.y - a.y) * o.t };
  const h = o.width / 2;
  return [
    { x: c.x - d.x * h, y: c.y - d.y * h },
    { x: c.x + d.x * h, y: c.y + d.y * h },
  ];
}

function sameSpan(p: [Vec2, Vec2] | null, q: [Vec2, Vec2] | null): boolean {
  if (!p || !q) return p === q;
  const near = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y) < 0.001;
  return (near(p[0], q[0]) && near(p[1], q[1])) || (near(p[0], q[1]) && near(p[1], q[0]));
}

/**
 * Rooms of `level` with no way in from the main door (through its doors, passages and room
 * boundaries), leaving out the shelter, ledges and outdoor rooms. Empty without a main door.
 */
export function unreachableRooms(level: Level): string[] {
  const geom = planGeometry(level);
  const main = entranceDoor(level, geom);
  if (!main) return [];
  const graph = doorGraph(level, geom);
  const door = graph.doors.find((d) => d.o.id === main);
  const inside = door?.sides.find((s) => s !== null);
  if (!inside) return [];
  const reached = doorSearch(graph, inside);
  return Object.values(level.rooms)
    .filter((r) => roomKind(r.name) !== 'none' && !reached.has(r.id))
    .map((r) => r.id)
    .sort();
}

/** An op in words, by the rooms either side of its wall. */
function describe(
  o: DesignOp,
  level: Level,
  wallId: string | null,
  openingId: string | null,
  between: (id: string) => string,
): string {
  const where = wallId && level.walls[wallId] ? between(wallId) : `wall ${o.wall ?? '?'}`;
  switch (o.op) {
    case 'remove_wall':
      return `Hack ${where}`;
    case 'half_wall':
      return `Cut down ${where} to a half wall`;
    case 'glass_wall':
      return `Make ${where} a glass partition`;
    case 'add_door':
      return `Add a door to ${where}`;
    case 'add_wall':
      return o.a && o.b ? `Build a wall from ${fmt(o.a)} to ${fmt(o.b)}` : 'Build a wall';
    case 'remove_opening': {
      const op = openingId ? level.openings[openingId] : undefined;
      if (!op) return `Close up opening ${o.opening ?? '?'}`;
      const rooms = sidesOf(level, op.wallId, op.t);
      if (op.kind === 'window') {
        return `Close up the window in ${rooms.find((s) => s) ?? 'the flat'}`;
      }
      return `Close up the ${op.kind === 'door' ? 'door' : 'opening'} between ${rooms
        .map((s) => s ?? 'outside')
        .join(' and ')}`;
    }
  }
}

/** A new door on a wall: at least 0.75 m (0.65 m into a bathroom), clamped to the wall. */
function newDoor(level: Level, wallId: string, o: DesignOp): Omit<Opening, 'id'> {
  const w = level.walls[wallId]!;
  const a = level.vertices[w.a]!;
  const b = level.vertices[w.b]!;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const bath = sidesOf(level, wallId).some((s) => s && WET.test(s));
  const min = bath ? MIN_BATH_DOOR : MIN_DOOR;
  const width = Math.min(Math.max(o.width ?? 0.9, min), len - 0.1);
  if (width < min) throw new Refused('the wall is too short for a door.');
  const half = width / 2 / len;
  const t = Math.min(1 - half, Math.max(half, o.t ?? 0.5));
  const [u0, u1] = [t * len - width / 2, t * len + width / 2];
  for (const x of Object.values(level.openings)) {
    if (x.wallId !== wallId) continue;
    const [v0, v1] = [x.t * len - x.width / 2, x.t * len + x.width / 2];
    if (u0 < v1 + 0.05 && v0 < u1 + 0.05) throw new Refused('there is an opening there already.');
  }
  return {
    wallId,
    kind: 'door',
    t,
    width,
    height: 2.1,
    sill: 0,
    swing: 'leftIn',
    ...(o.style && o.style !== 'swing' ? { style: o.style } : {}),
  };
}

/**
 * A new wall's ends: straightened onto the plan's axes (within 2°), each end moved onto the
 * wall it meets (within 0.15 m). It mustn't cross a wall, nor run through the shelter or a
 * bathroom.
 */
function newWallEnds(level: Level, o: DesignOp): { ends: [Vec2, Vec2]; onto: string[] } {
  if (!o.a || !o.b) throw new Refused('it has no ends.');
  let a = { ...o.a };
  let b = { ...o.b };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const angle = Math.atan2(Math.abs(dy), Math.abs(dx));
  if (angle <= NEW_WALL.skew) {
    const y = (a.y + b.y) / 2;
    a = { x: a.x, y };
    b = { x: b.x, y };
  } else if (Math.PI / 2 - angle <= NEW_WALL.skew) {
    const x = (a.x + b.x) / 2;
    a = { x, y: a.y };
    b = { x, y: b.y };
  } else throw new Refused('new walls run along the plan’s axes.');
  const walls = Object.values(level.walls).flatMap((w) => {
    const p = level.vertices[w.a];
    const q = level.vertices[w.b];
    return p && q ? [{ w, p, q }] : [];
  });
  const snap = (end: Vec2, other: Vec2): Vec2 => {
    const len = Math.hypot(end.x - other.x, end.y - other.y) || 1;
    const d = { x: (end.x - other.x) / len, y: (end.y - other.y) / len };
    // Along the new wall's own line, to where it meets a wall.
    const far = { x: end.x + d.x * NEW_WALL.snap, y: end.y + d.y * NEW_WALL.snap };
    const near = { x: end.x - d.x * NEW_WALL.snap, y: end.y - d.y * NEW_WALL.snap };
    let best: { at: Vec2; dist: number; wallId: string; u: number } | null = null;
    for (const { w, p, q } of walls) {
      const x = segmentIntersection(near, far, p, q);
      if (!x) continue;
      const dist = Math.hypot(x.point.x - end.x, x.point.y - end.y);
      const u = x.u * Math.hypot(q.x - p.x, q.y - p.y);
      if (!best || dist < best.dist) best = { at: x.point, dist, wallId: w.id, u };
    }
    if (!best) throw new Refused('its ends must meet existing walls.');
    // Never onto a door or window (nor just beside one): the wall would split it.
    const hit = best;
    const wall = level.walls[hit.wallId];
    const p = wall && level.vertices[wall.a];
    const q = wall && level.vertices[wall.b];
    const wlen = p && q ? Math.hypot(q.x - p.x, q.y - p.y) : 0;
    for (const op of Object.values(level.openings)) {
      if (op.wallId !== hit.wallId) continue;
      const c = op.t * wlen;
      if (hit.u > c - op.width / 2 - OPENING_CLEAR && hit.u < c + op.width / 2 + OPENING_CLEAR) {
        throw new Refused(
          `its end would land on a ${op.kind === 'window' ? 'window' : 'doorway'}.`,
        );
      }
    }
    onto.push(hit.wallId);
    return hit.at;
  };
  const onto: string[] = [];
  const sa = snap(a, b);
  const sb = snap(b, a);
  const len = Math.hypot(sb.x - sa.x, sb.y - sa.y);
  if (len < NEW_WALL.min) throw new Refused('it is too short.');
  for (const { w, p, q } of walls) {
    if (isBoundary(w)) continue;
    const x = segmentIntersection(sa, sb, p, q);
    if (x && x.t * len > 0.02 && (1 - x.t) * len > 0.02) {
      throw new Refused('it would cross another wall.');
    }
  }
  for (let i = 1; i < 10; i++) {
    const at = { x: sa.x + ((sb.x - sa.x) * i) / 10, y: sa.y + ((sb.y - sa.y) * i) / 10 };
    const id = roomIdAt(level, at);
    const name = id ? (level.rooms[id]?.name ?? '') : '';
    if (SHELTER_ROOM.test(name)) throw new Refused('it would stand in the household shelter.');
    if (WET.test(name)) throw new Refused('it would stand in a bathroom (wet area).');
  }
  return { ends: [sa, sb], onto };
}

/**
 * `level` with every element `base` doesn't have renamed to an id seeded by `seed` and where
 * it is, so the same design on the same plan makes the same ids whatever the order of things.
 */
export function canonicalIds(base: Level, level: Level, seed: string): Level {
  const k = (p: Vec2) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
  const used = new Set([
    ...Object.keys(level.vertices),
    ...Object.keys(level.walls),
    ...Object.keys(level.openings),
    ...Object.keys(level.rooms),
  ]);
  const name = (prefix: string, key: string) => {
    let id = seededId(prefix, seed, key);
    for (let n = 2; used.has(id); n++) id = seededId(prefix, seed, key, n);
    used.add(id);
    return id;
  };
  const vmap = new Map<string, string>();
  const fresh = <T extends { id: string }>(r: Record<string, T>, old: Record<string, unknown>) =>
    Object.values(r).filter((x) => !(x.id in old));
  for (const v of fresh(level.vertices, base.vertices).sort((p, q) => (k(p) < k(q) ? -1 : 1))) {
    vmap.set(v.id, name('v', k(v)));
  }
  const vid = (id: string) => vmap.get(id) ?? id;
  const vkey = (id: string) => {
    const v = level.vertices[id];
    return v ? k(v) : id;
  };
  const wmap = new Map<string, string>();
  const wkey = (w: { a: string; b: string }) => [vkey(w.a), vkey(w.b)].sort().join('/');
  for (const w of fresh(level.walls, base.walls).sort((p, q) => (wkey(p) < wkey(q) ? -1 : 1))) {
    wmap.set(w.id, name('w', wkey(w)));
  }
  const wid = (id: string) => wmap.get(id) ?? id;
  const omap = new Map<string, string>();
  const okey = (o: Opening) =>
    `${wkey(level.walls[o.wallId] ?? { a: '', b: '' })}@${o.t.toFixed(3)}`;
  for (const o of fresh(level.openings, base.openings).sort((p, q) =>
    okey(p) < okey(q) ? -1 : 1,
  )) {
    omap.set(o.id, name('op', okey(o)));
  }
  const rmap = new Map<string, string>();
  const rkey = (loop: string[]) => loop.map(vkey).sort().join('/');
  for (const r of fresh(level.rooms, base.rooms).sort((p, q) =>
    rkey(p.loop) < rkey(q.loop) ? -1 : 1,
  )) {
    rmap.set(r.id, name('rm', rkey(r.loop)));
  }
  const remap = <T>(r: Record<string, T>, f: (x: T) => T & { id: string }) =>
    Object.fromEntries(
      Object.values(r).map((x) => {
        const y = f(x);
        return [y.id, y];
      }),
    );
  return settled({
    ...level,
    vertices: remap(level.vertices, (v) => ({ ...v, id: vid(v.id) })),
    walls: remap(level.walls, (w) => ({ ...w, id: wid(w.id), a: vid(w.a), b: vid(w.b) })),
    openings: remap(level.openings, (o) => ({
      ...o,
      id: omap.get(o.id) ?? o.id,
      wallId: wid(o.wallId),
    })),
    rooms: remap(level.rooms, (r) => ({ ...r, id: rmap.get(r.id) ?? r.id, loop: r.loop.map(vid) })),
    points: remap(level.points ?? {}, (p) =>
      p.wall ? { ...p, wall: { ...p.wall, wallId: wid(p.wall.wallId) } } : p,
    ),
  });
}
