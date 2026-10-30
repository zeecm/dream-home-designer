import {
  type Command,
  type Level,
  type Vec2,
  isBoundary,
  moveVertex,
  placeLabel,
  pointInPolygon,
  roomArea,
  roomShape,
  roomShapes,
  updateOpening,
  wallLine,
} from '@dhd/core';
import type { Selection } from '../editor';
import { formatArea, formatLength } from '../units';

const KIND_ORDER: Selection['kind'][] = ['room', 'wall', 'opening', 'vertex'];

/** Where an object sits on the plan, for ordering and for scrolling it into view. */
export function objectPoint(level: Level, sel: Selection): Vec2 | null {
  switch (sel.kind) {
    case 'vertex': {
      const v = level.vertices[sel.id];
      return v ? { x: v.x, y: v.y } : null;
    }
    case 'wall': {
      const w = level.walls[sel.id];
      if (!w) return null;
      const l = wallLine(level, w);
      return { x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 };
    }
    case 'opening': {
      const o = level.openings[sel.id];
      const w = o && level.walls[o.wallId];
      if (!o || !w) return null;
      const l = wallLine(level, w);
      return { x: l.a.x + (l.b.x - l.a.x) * o.t, y: l.a.y + (l.b.y - l.a.y) * o.t };
    }
    case 'room': {
      const r = level.rooms[sel.id];
      const shape = r && roomShape(level, r);
      return shape && shape.outer.length >= 3
        ? placeLabel(shape.outer, { x: 0, y: 0 }, [], shape.holes)
        : null;
    }
  }
}

/**
 * Every selectable object in Tab order: rooms, walls, openings, then corners; each kind in
 * reading order (top to bottom, then left to right, in 0.5 m bands).
 */
export function planObjects(level: Level): Selection[] {
  const all: Selection[] = [
    ...Object.keys(level.rooms).map((id) => ({ kind: 'room' as const, id })),
    ...Object.keys(level.walls).map((id) => ({ kind: 'wall' as const, id })),
    ...Object.keys(level.openings).map((id) => ({ kind: 'opening' as const, id })),
    ...Object.keys(level.vertices).map((id) => ({ kind: 'vertex' as const, id })),
  ];
  const keyed = all.map((s) => ({ s, p: objectPoint(level, s) ?? { x: 0, y: 0 } }));
  keyed.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.s.kind) - KIND_ORDER.indexOf(b.s.kind) ||
      Math.round(a.p.y * 2) - Math.round(b.p.y * 2) ||
      a.p.x - b.p.x ||
      (a.s.id < b.s.id ? -1 : 1),
  );
  return keyed.map((k) => k.s);
}

/** The next object after `current` (or before it, with `back`); null past either end. */
export function cycle(
  objects: Selection[],
  current: Selection | null,
  back: boolean,
): Selection | null {
  if (objects.length === 0) return null;
  const i = current ? objects.findIndex((o) => o.kind === current.kind && o.id === current.id) : -1;
  if (i < 0) return (back ? objects[objects.length - 1] : objects[0]) ?? null;
  return objects[back ? i - 1 : i + 1] ?? null;
}

/** The names of the rooms on either side of a wall (one for an outer wall). */
export function roomsBeside(level: Level, wallId: string): string[] {
  const w = level.walls[wallId];
  if (!w) return [];
  const l = wallLine(level, w);
  if (l.length < 1e-9) return [];
  const mid = { x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 };
  const n = { x: -(l.b.y - l.a.y) / l.length, y: (l.b.x - l.a.x) / l.length };
  const off = w.thickness / 2 + 0.05;
  const shapes = roomShapes(level);
  const names: string[] = [];
  for (const k of [1, -1]) {
    const p = { x: mid.x + n.x * off * k, y: mid.y + n.y * off * k };
    const room = Object.values(level.rooms).find((r) => {
      const s = shapes.get(r.id);
      return s && pointInPolygon(p, s.outer) && !s.holes.some((h) => pointInPolygon(p, h));
    });
    if (room && !names.includes(room.name)) names.push(room.name);
  }
  return names;
}

/** A short spoken description of the selection. */
export function describe(level: Level, sel: Selection | null): string {
  if (!sel) return '';
  switch (sel.kind) {
    case 'room': {
      const r = level.rooms[sel.id];
      return r ? `${r.name}, ${formatArea(roomArea(level, r))}` : '';
    }
    case 'wall': {
      const w = level.walls[sel.id];
      if (!w) return '';
      const what = isBoundary(w) ? 'Room boundary' : 'Wall';
      const rooms = roomsBeside(level, sel.id);
      const where = rooms.length ? ` between ${rooms.join(' and ')}` : '';
      return `${what}${where}, ${formatLength(wallLine(level, w).length)} long`;
    }
    case 'opening': {
      const o = level.openings[sel.id];
      if (!o) return '';
      const kind = o.kind === 'passage' ? 'Opening' : o.kind === 'door' ? 'Door' : 'Window';
      return `${kind}, ${formatLength(o.width)} wide`;
    }
    case 'vertex': {
      const n = Object.values(level.walls).filter((w) => w.a === sel.id || w.b === sel.id).length;
      return `Corner, ${n === 1 ? '1 wall' : `${n} walls`}`;
    }
  }
}

/**
 * Commands that move the selection by `delta` metres: corners and walls move freely; doors and
 * windows slide along their wall by the part of `delta` that runs along it.
 */
export function nudge(level: Level, sel: Selection, delta: Vec2): Command[] {
  const move = (id: string) => {
    const v = level.vertices[id];
    return v ? [moveVertex(level.id, id, { x: v.x + delta.x, y: v.y + delta.y })] : [];
  };
  switch (sel.kind) {
    case 'vertex':
      return move(sel.id);
    case 'wall': {
      const w = level.walls[sel.id];
      return w ? [...move(w.a), ...move(w.b)] : [];
    }
    case 'opening': {
      const o = level.openings[sel.id];
      const w = o && level.walls[o.wallId];
      if (!o || !w) return [];
      const l = wallLine(level, w);
      if (l.length < 1e-9) return [];
      const along = (delta.x * (l.b.x - l.a.x) + delta.y * (l.b.y - l.a.y)) / l.length;
      if (Math.abs(along) < 1e-9) return [];
      const t = Math.min(1, Math.max(0, o.t + along / l.length));
      return [updateOpening(level.id, sel.id, { t })];
    }
    case 'room':
      return [];
  }
}

/** The corners a nudge moved, to settle (merge or split) afterwards. */
export function movedVertices(level: Level, sel: Selection): string[] {
  if (sel.kind === 'vertex') return [sel.id];
  if (sel.kind === 'wall') {
    const w = level.walls[sel.id];
    return w ? [w.a, w.b] : [];
  }
  return [];
}
