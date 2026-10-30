import type { Draft } from 'immer';
import { clampOpeningT } from './geometry';
import type { Command } from './history';
import { newId } from './ids';
import { draftLevel } from './levels';
import { syncRooms } from './rooms';
import { type Level, type Vec2, isBoundary } from './schema';
import { projectOnSegment, segmentIntersection } from './snap';

type Mut = Level | Draft<Level>;

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const ON = 1e-4;

/** How close to a wall's end a point must be to count as that end (5 cm, or half the wall). */
export function endCapture(thickness: number): number {
  return Math.max(0.05, thickness / 2);
}

/**
 * In a level being edited: splits a wall at a corner that already exists on it. The wall
 * keeps its id from a to the corner; `newWallId` runs on to the old b. Openings move to
 * the part holding their centre; room loops along the wall gain the corner.
 */
export function splitWallAt(l: Mut, wallId: string, vertexId: string, newWallId: string): void {
  const w = l.walls[wallId];
  const a = w && l.vertices[w.a];
  const b = w && l.vertices[w.b];
  const v = l.vertices[vertexId];
  if (!w || !a || !b || !v) throw new Error(`cannot split wall ${wallId}`);
  const length = dist(a, b);
  // Snapping keeps drawn walls off openings (`snapPoint` moves a point inside one to its
  // jamb). A split that still lands inside one keeps the opening on the part holding its
  // centre; moving the corner here instead would bend every wall that meets it.
  const us = projectOnSegment(v, a, b).t * length;
  const oldA = w.a;
  const oldB = w.b;
  l.walls[newWallId] = { ...w, id: newWallId, a: vertexId, b: oldB };
  w.b = vertexId;
  for (const o of Object.values(l.openings)) {
    if (o.wallId !== wallId) continue;
    const u = o.t * length;
    if (u <= us) {
      o.t = clampOpeningT(us, o.width, u / us);
    } else {
      o.wallId = newWallId;
      o.t = clampOpeningT(length - us, o.width, (u - us) / (length - us));
    }
  }
  for (const room of Object.values(l.rooms)) {
    const n = room.loop.length;
    for (let i = 0; i < n; i++) {
      const p = room.loop[i];
      const q = room.loop[(i + 1) % n];
      if ((p === oldA && q === oldB) || (p === oldB && q === oldA)) {
        room.loop.splice(i + 1, 0, vertexId);
        break;
      }
    }
  }
}

/** Keeps every opening on its wall: re-centres it, and narrows it if the wall got shorter. */
export function reclampOpenings(l: Mut): void {
  for (const o of Object.values(l.openings)) {
    const w = l.walls[o.wallId];
    const a = w && l.vertices[w.a];
    const b = w && l.vertices[w.b];
    if (!a || !b) continue;
    const length = dist(a, b);
    if (o.width > length) o.width = Math.max(0.05, length);
    const t = clampOpeningT(length, o.width, o.t);
    if (t !== o.t) o.t = t;
  }
}

const sameEnds = (p: { a: string; b: string }, q: { a: string; b: string }) =>
  (p.a === q.a && p.b === q.b) || (p.a === q.b && p.b === q.a);

/** Walls before boundaries, so where two coincide the wall is the one kept. */
const wallsFirst = <W extends { kind?: string }>(walls: W[]) =>
  [...walls].sort((p, q) => (p.kind === 'boundary' ? 1 : 0) - (q.kind === 'boundary' ? 1 : 0));

/**
 * Re-points every wall from `from` to `into`, dropping walls that collapse or duplicate.
 * Of two that coincide, a wall outlives a boundary, and a dropped wall's openings move to
 * the one kept.
 */
export function mergeVertex(l: Mut, from: string, into: string): void {
  if (from === into) return;
  for (const w of Object.values(l.walls)) {
    if (w.a === from) w.a = into;
    if (w.b === from) w.b = into;
  }
  const kept: { id: string; a: string; b: string }[] = [];
  for (const w of wallsFirst(Object.values(l.walls))) {
    const twin = kept.find((k) => sameEnds(k, w));
    if (w.a === w.b || twin) {
      delete l.walls[w.id];
      for (const o of Object.values(l.openings)) {
        if (o.wallId !== w.id) continue;
        if (twin && !isBoundary(l.walls[twin.id] ?? {})) {
          o.wallId = twin.id;
          if (twin.a !== w.a) o.t = 1 - o.t; // the twin runs the other way
        } else {
          delete l.openings[o.id];
        }
      }
    } else {
      kept.push(w);
    }
  }
  for (const room of Object.values(l.rooms)) {
    const loop = room.loop.map((id) => (id === from ? into : id));
    room.loop = loop.filter((id, i) => id !== loop[(i + 1) % loop.length]);
  }
  delete l.vertices[from];
}

/** Copies `next`'s records onto the draft, touching only what differs (small patches). */
function applyLevel(d: Draft<Level>, next: Level): void {
  for (const key of ['vertices', 'walls', 'openings', 'rooms'] as const) {
    const cur = d[key] as Record<string, unknown>;
    const want = next[key] as Record<string, unknown>;
    for (const id of Object.keys(cur)) if (!(id in want)) delete cur[id];
    for (const [id, value] of Object.entries(want)) {
      if (JSON.stringify(cur[id]) !== JSON.stringify(value)) cur[id] = structuredClone(value);
    }
  }
}

/**
 * Makes the wall graph consistent after a corner was moved (dragged or typed): a corner
 * dropped on another merges with it (walls that collapse or duplicate go), a corner
 * dropped on a wall splits it, walls at the corner that now cross other walls are split
 * where they cross, openings are kept on their walls and rooms are re-detected.
 *
 * Planned against `level` with ids generated here; the recipe only applies the result.
 */
export function settleVertex(level: Level, vertexId: string): Command {
  const l = structuredClone(level) as Level;
  let vid = vertexId;
  const v = l.vertices[vid];
  if (v) {
    const twin = Object.values(l.vertices).find((u) => u.id !== vid && dist(u, v) < ON);
    if (twin) {
      mergeVertex(l, vid, twin.id);
      vid = twin.id;
    }
    const at = l.vertices[vid] as Vec2;
    const incident = (w: { a: string; b: string }) => w.a === vid || w.b === vid;
    const host = Object.values(l.walls).find((w) => {
      const a = l.vertices[w.a];
      const b = l.vertices[w.b];
      if (incident(w) || !a || !b) return false;
      const pr = projectOnSegment(at, a, b);
      return pr.distance < ON && pr.t > 0 && pr.t < 1;
    });
    if (host) splitWallAt(l, host.id, vid, newId('w'));

    // Split walls at this corner where they now cross other walls, until none do.
    for (let guard = 0; guard < 64; guard++) {
      let crossing: { e: string; w: string; p: Vec2 } | null = null;
      for (const e of Object.values(l.walls)) {
        if (!incident(e)) continue;
        const ea = l.vertices[e.a] as Vec2;
        const eb = l.vertices[e.b] as Vec2;
        for (const w of Object.values(l.walls)) {
          if (w.id === e.id || [w.a, w.b].some((x) => x === e.a || x === e.b)) continue;
          const wa = l.vertices[w.a];
          const wb = l.vertices[w.b];
          if (!wa || !wb) continue;
          const x = segmentIntersection(ea, eb, wa, wb);
          if (!x) continue;
          const el = dist(ea, eb);
          const wl = dist(wa, wb);
          if (x.t * el < ON || (1 - x.t) * el < ON || x.u * wl < ON || (1 - x.u) * wl < ON)
            continue;
          crossing = { e: e.id, w: w.id, p: x.point };
          break;
        }
        if (crossing) break;
      }
      if (!crossing) break;
      const p = newId('v');
      l.vertices[p] = { id: p, x: crossing.p.x, y: crossing.p.y };
      splitWallAt(l, crossing.w, p, newId('w'));
      splitWallAt(l, crossing.e, p, newId('w'));
    }
  }
  reclampOpenings(l);
  syncRooms(l);
  return {
    label: 'Move corner',
    recipe: (d) => {
      applyLevel(draftLevel(d, level.id), l);
    },
  };
}

/**
 * Drops references that would break drawing: walls whose corners are missing, collapsed
 * or duplicated, openings on missing walls, and rooms whose loops lost a corner. Returns
 * the level unchanged (same object) when there is nothing to fix.
 */
export function repairLevel(level: Level): { level: Level; fixes: string[] } {
  const fixes: string[] = [];
  const l = structuredClone(level) as Level;
  const kept: { a: string; b: string }[] = [];
  for (const w of wallsFirst(Object.values(l.walls))) {
    const a = l.vertices[w.a];
    const b = l.vertices[w.b];
    if (!a || !b || w.a === w.b || dist(a, b) < 1e-9 || kept.some((k) => sameEnds(k, w))) {
      delete l.walls[w.id];
      fixes.push(`removed broken wall ${w.id}`);
    } else {
      kept.push(w);
    }
  }
  for (const o of Object.values(l.openings)) {
    if (!l.walls[o.wallId]) {
      delete l.openings[o.id];
      fixes.push(`removed opening ${o.id} on a missing wall`);
    }
  }
  for (const r of Object.values(l.rooms)) {
    if (new Set(r.loop).size < 3 || r.loop.some((id) => !l.vertices[id])) {
      delete l.rooms[r.id];
      fixes.push(`removed room ${r.id} with a missing corner`);
    }
  }
  return fixes.length ? { level: l, fixes } : { level, fixes };
}
