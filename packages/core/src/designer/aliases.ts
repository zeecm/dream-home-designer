import { placeLabel } from '../geometry';
import { roomShapes } from '../rooms';
import type { Level, Vec2 } from '../schema';

/**
 * Short names for a level's elements in the prompts: walls W1…, openings D1…, rooms R1…,
 * pieces P1…, numbered top to bottom then left to right. Short names cost fewer tokens than
 * ids and a model copies them more reliably. A design keeps its map, alias to id; elements
 * the design's own walls make are added to it (W31…) so its room steps can name them.
 */
export type AliasMap = Record<string, string>;

const key = (p: Vec2) => [Math.round(p.y * 100), Math.round(p.x * 100)] as const;
const byPlace = (p: readonly [number, number], q: readonly [number, number]) =>
  p[0] - q[0] || p[1] - q[1];

interface Entry {
  prefix: 'W' | 'D' | 'R' | 'P';
  id: string;
  at: Vec2;
  tie: string;
}

function entries(level: Level): Entry[] {
  const out: Entry[] = [];
  const mid = (a?: Vec2, b?: Vec2) => (a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null);
  for (const w of Object.values(level.walls)) {
    const m = mid(level.vertices[w.a], level.vertices[w.b]);
    if (m) out.push({ prefix: 'W', id: w.id, at: m, tie: w.id });
  }
  for (const o of Object.values(level.openings)) {
    const w = level.walls[o.wallId];
    const a = w && level.vertices[w.a];
    const b = w && level.vertices[w.b];
    if (!a || !b) continue;
    out.push({
      prefix: 'D',
      id: o.id,
      at: { x: a.x + (b.x - a.x) * o.t, y: a.y + (b.y - a.y) * o.t },
      tie: o.id,
    });
  }
  const shapes = roomShapes(level);
  for (const r of Object.values(level.rooms)) {
    const s = shapes.get(r.id);
    if (!s || s.outer.length < 3) continue;
    out.push({
      prefix: 'R',
      id: r.id,
      at: placeLabel(s.outer, { x: 0.05, y: 0.05 }, [], s.holes),
      tie: r.id,
    });
  }
  for (const it of Object.values(level.items)) {
    out.push({ prefix: 'P', id: it.id, at: { x: it.position.x, y: it.position.z }, tie: it.id });
  }
  return out;
}

/**
 * `map` with an alias for every element of `level` it doesn't name yet, numbered on from the
 * highest of each kind. Without `map`, a fresh map for `level`. Never renames an element.
 */
export function aliasesFor(level: Level, map: AliasMap = {}): AliasMap {
  const out: AliasMap = { ...map };
  const named = new Set(Object.values(out));
  const next: Record<Entry['prefix'], number> = { W: 0, D: 0, R: 0, P: 0 };
  for (const a of Object.keys(out)) {
    const m = /^([WDRP])(\d+)$/.exec(a);
    if (m) {
      const p = m[1] as Entry['prefix'];
      next[p] = Math.max(next[p], Number(m[2]));
    }
  }
  const fresh = entries(level)
    .filter((e) => !named.has(e.id))
    .sort(
      (p, q) =>
        p.prefix.localeCompare(q.prefix) ||
        byPlace(key(p.at), key(q.at)) ||
        (p.tie < q.tie ? -1 : p.tie > q.tie ? 1 : 0),
    );
  for (const e of fresh) {
    next[e.prefix] += 1;
    out[`${e.prefix}${next[e.prefix]}`] = e.id;
  }
  return out;
}

/** The id an alias stands for ("w3" and " W3 " too), if the map has it. */
export function resolveAlias(map: AliasMap, alias: string | null | undefined): string | null {
  if (!alias) return null;
  return map[alias.trim().toUpperCase()] ?? null;
}

/** Id to alias, for writing prompts and notes. */
export function aliasOf(map: AliasMap): Map<string, string> {
  return new Map(Object.entries(map).map(([a, id]) => [id, a]));
}
