import {
  CLEARANCE_RULES,
  type ClearanceIssue,
  DINING_CHAIRS,
  DINING_TABLES,
  type Item,
  type Level,
  type PlanGeometry,
  type Vec2,
  type WalkwayReport,
  type WalkwayTo,
  chairsOf,
  clearanceIssues,
  clearanceZones,
  entranceDoor,
  furnitureKind,
  issueItem,
  itemFootprint,
  planGeometry,
  pointInPolygon,
  roomShapes,
  variantLevels,
} from '@dhd/core';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { useWayShown, wayIsOwn } from '../delivery/delivery';
import { type Selection, useEditor } from '../editor';
import { roomLabelBoxes } from '../plan/layers';
import type { Size, View } from '../plan/view';
import { useLevel, useProject } from '../store';
import { formatLength } from '../units';
import { pointerHeld, startWalkways, useWalkways } from './walkways';

const KEY = 'dhd-clearance';

/** Whether clearance checks show (on unless switched off; remembered in this browser). */
export const useClearanceOn = create<{
  on: boolean;
  set: (on: boolean) => void;
  /** The piece or door Show next last went to (the selection goes when plan details show). */
  shown: string | null;
}>((set) => {
  let on = true;
  try {
    on = window.localStorage.getItem(KEY) !== 'off';
  } catch {
    // Storage blocked: on, for this visit.
  }
  return {
    on,
    shown: null,
    set: (v) => {
      try {
        window.localStorage.setItem(KEY, v ? 'on' : 'off');
      } catch {
        // Not remembered; still switched for this visit.
      }
      set({ on: v });
    },
  };
});

// Kept per level object: the plan, the Inspector and the count share one run.
const cache = new WeakMap<Level, ClearanceIssue[]>();
export function issuesOf(level: Level): ClearanceIssue[] {
  let out = cache.get(level);
  if (!out) {
    out = clearanceIssues(level);
    cache.set(level, out);
  }
  return out;
}

/** The last walkway check of the level shown (null while switched off or not yet run). */
export function useWalkwayReport(): WalkwayReport | null {
  const on = useClearanceOn((s) => s.on);
  useEffect(() => startWalkways(on), [on]);
  const report = useWalkways((s) => s.report);
  const of = useWalkways((s) => s.level);
  const ofVariant = useWalkways((s) => s.variant);
  const level = useLevel();
  const variant = useEditor((s) => s.variant);
  // Only the version and level shown (Before's pinches never draw on After while it catches up).
  return on && level && of?.id === level.id && ofVariant === variant ? report : null;
}

/**
 * The clearance problems on the level shown (none while switched off): the quick ones of
 * this very frame, and the walkways of the last check (pieces since removed left out).
 */
export function useClearanceIssues(): ClearanceIssue[] {
  const on = useClearanceOn((s) => s.on);
  const level = useLevel();
  const report = useWalkwayReport();
  return useMemo(() => {
    if (!on || !level) return [];
    const quick = issuesOf(level);
    const ways = (report?.issues ?? []).filter((i) => level.items[i.itemId]);
    return ways.length ? [...quick, ...ways] : quick;
  }, [on, level, report]);
}

const name = (level: Level, itemId: string) =>
  furnitureKind(level.items[itemId]?.assetId ?? '')?.name ?? 'piece';

/** Kept by the walls, corners, openings and rooms: a drag of furniture changes none of them. */
interface Fixed {
  vertices: object;
  openings: object;
  rooms: object;
  geom: PlanGeometry;
  names: Map<string, string>;
}
const fixedCache = new WeakMap<object, Fixed>();
function fixedOf(level: Level): Fixed {
  const hit = fixedCache.get(level.walls);
  if (
    hit &&
    hit.vertices === level.vertices &&
    hit.openings === level.openings &&
    hit.rooms === level.rooms
  ) {
    return hit;
  }
  const f: Fixed = {
    vertices: level.vertices,
    openings: level.openings,
    rooms: level.rooms,
    geom: planGeometry(level),
    names: new Map(),
  };
  fixedCache.set(level.walls, f);
  return f;
}
const geomOf = (level: Level) => fixedOf(level).geom;

/** The room at a point, if any. */
function roomAt(level: Level, p: Vec2) {
  const shapes = roomShapes(level);
  return Object.values(level.rooms).find((r) => {
    const s = shapes.get(r.id);
    return !!s && pointInPolygon(p, s.outer) && !s.holes.some((h) => pointInPolygon(p, h));
  });
}

/**
 * A door named by the room it leads into: of the two rooms it joins, the smaller (a bedroom
 * off the living room, a bathroom off a bedroom); the main door to the outside. Else by the
 * room its leaves sweep.
 */
function doorName(level: Level, sweep: Vec2[][], openingId?: string): string {
  if (!openingId) return doorNameOf(level, sweep);
  const names = fixedOf(level).names;
  let n = names.get(openingId);
  if (n === undefined) {
    n = doorNameOf(level, sweep, openingId);
    names.set(openingId, n);
  }
  return n;
}

function doorNameOf(level: Level, sweep: Vec2[][], openingId?: string): string {
  const o = openingId ? geomOf(level).openings.find((g) => g.opening.id === openingId) : undefined;
  if (o) {
    const f = o.frame;
    const u = (o.span[0] + o.span[1]) / 2;
    const side = (k: number) =>
      roomAt(level, {
        x: f.a.x + f.d.x * u + f.n.x * (f.half + 0.1) * k,
        y: f.a.y + f.d.y * u + f.n.y * (f.half + 0.1) * k,
      });
    const rooms = [side(1), side(-1)];
    if (rooms.some((r) => !r)) return 'the main door';
    const [a, b] = rooms as [NonNullable<(typeof rooms)[0]>, NonNullable<(typeof rooms)[0]>];
    if (a.id !== b.id) {
      const shapes = roomShapes(level);
      const area = (id: string) => {
        const s = shapes.get(id)?.outer ?? [];
        let t = 0;
        for (let i = 0; i < s.length; i++) {
          const p = s[i] as Vec2;
          const q = s[(i + 1) % s.length] as Vec2;
          t += p.x * q.y - q.x * p.y;
        }
        return Math.abs(t) / 2;
      };
      return `the ${(area(a.id) <= area(b.id) ? a : b).name} door`;
    }
  }
  const pts = sweep.flat();
  const c = {
    x: pts.reduce((t, p) => t + p.x, 0) / (pts.length || 1),
    y: pts.reduce((t, p) => t + p.y, 0) / (pts.length || 1),
  };
  const shapes = roomShapes(level);
  const room = Object.values(level.rooms).find((r) => {
    const s = shapes.get(r.id);
    return !!s && pointInPolygon(c, s.outer);
  });
  return room ? `the ${room.name} door` : 'a door';
}

/** "A", "A and B", "A, B and C". */
const listed = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;

/** Where a walkway goes, in words: a room's name, or "the bed's left side". */
function placeName(level: Level, to: WalkwayTo): string {
  if (to.roomId) return level.rooms[to.roomId]?.name ?? 'a room';
  const side = `the bed’s ${to.side ?? 'left'} side`;
  const beds = Object.values(level.items).filter((it) => {
    const rule = CLEARANCE_RULES[it.assetId];
    return !!rule && rule.side !== 'front';
  });
  const bed = to.bedId ? level.items[to.bedId] : undefined;
  if (beds.length < 2 || !bed) return side;
  const room = roomAt(level, { x: bed.position.x, y: bed.position.z });
  return room ? `${side} in ${room.name}` : side;
}

/** What a piece's hinged front is called, for a door that hits it. */
const frontWord = (assetId: string) =>
  assetId === 'fridge' || assetId === 'washer'
    ? 'door'
    : assetId === 'chest-of-drawers' || assetId === 'shelf-with-drawers'
      ? 'drawers'
      : 'doors';

/** Problems with one piece, in words. */
export function issueText(level: Level, issue: ClearanceIssue, all: ClearanceIssue[]): string {
  switch (issue.kind) {
    case 'zone': {
      if (issue.side === 'front') {
        return `${issue.what} ${formatLength(issue.need)} in front; ${formatLength(issue.have)} here.`;
      }
      if (issue.side === 'back') {
        return `${issue.what} ${formatLength(issue.need)} from the table; ${formatLength(issue.have)} here.`;
      }
      // A bed: both sides in one line.
      const sides = all.filter(
        (i): i is Extract<ClearanceIssue, { kind: 'zone' }> =>
          i.kind === 'zone' &&
          i.itemId === issue.itemId &&
          (i.side === 'left' || i.side === 'right'),
      );
      const part = (s: 'left' | 'right') => {
        const z = sides.find((x) => x.side === s);
        return z ? `${formatLength(z.have)} ${s}` : null;
      };
      return `Needs ${formatLength(issue.need)} beside the bed; ${[part('left'), part('right')]
        .filter(Boolean)
        .join(', ')}.`;
    }
    case 'door': {
      const d = doorName(level, issue.sweep, issue.openingId);
      return d === 'a door' ? 'Blocks a door’s swing.' : `Blocks ${d}.`;
    }
    case 'door-front':
      return `Its ${frontWord(level.items[issue.itemId]?.assetId ?? '')} hit ${doorName(level, issue.sweep, issue.openingId)} when both are open.`;
    case 'doors': {
      const other = all.find((i) => i.kind === 'doors' && i.openingId === issue.otherId);
      const d =
        other?.kind === 'doors' ? doorName(level, other.sweep, other.openingId) : 'another door';
      return `Hits ${d} when both are open.`;
    }
    case 'walkway': {
      const places = listed(issue.to.map((t) => placeName(level, t)));
      if (issue.have <= 0) return `Closes the way to ${places}.`;
      const need = issue.capped
        ? `${formatLength(issue.need)} needed, the corridor’s own width`
        : issue.route === 'circulation' && issue.need >= 0.9 - 1e-9
          ? `a walkway needs ${formatLength(issue.need)}`
          : `${formatLength(issue.need)} needed`;
      return `Narrows the way to ${places} to ${formatLength(issue.have)}; ${need}.`;
    }
    case 'overlap':
      return `Overlaps the ${name(level, issue.otherId).toLowerCase()}.`;
    case 'wall':
      return `Goes ${formatLength(issue.depth)} into a wall.`;
  }
}

/** Worst first: in the way of something, then closing or narrowing a way, then short room. */
function rank(i: ClearanceIssue): number {
  switch (i.kind) {
    case 'overlap':
      return 0;
    case 'wall':
      return 1;
    case 'walkway':
      return i.have <= 0 ? 2 : 5;
    case 'door':
      return 3;
    case 'door-front':
    case 'doors':
      return 4;
    case 'zone':
      return 6;
  }
}

/** One line per problem with a piece, worst first (a bed's two sides in one). */
export function itemIssueLines(level: Level, itemId: string, all: ClearanceIssue[]): string[] {
  const mine = all.filter((i) => issueItem(i) === itemId).sort((p, q) => rank(p) - rank(q));
  const lines: string[] = [];
  let bed = false;
  for (const i of mine) {
    if (i.kind === 'zone' && (i.side === 'left' || i.side === 'right')) {
      if (bed) continue;
      bed = true;
    }
    const t = issueText(level, i, all);
    if (!lines.includes(t)) lines.push(t);
  }
  return lines;
}

/** A door's clashes, in words: other doors, and pieces' doors its leaves hit. */
export function doorIssueLines(level: Level, openingId: string, all: ClearanceIssue[]): string[] {
  const lines: string[] = [];
  for (const i of all) {
    let t: string | null = null;
    if (i.kind === 'doors' && i.openingId === openingId) t = issueText(level, i, all);
    if (i.kind === 'door-front' && i.openingId === openingId) {
      const it = level.items[i.itemId];
      t = `Hits the ${name(level, i.itemId).toLowerCase()} ${frontWord(it?.assetId ?? '')} when both are open.`;
    }
    if (t && !lines.includes(t)) lines.push(t);
  }
  return lines;
}

/** Whether a piece has anything for its Clearances section to say "room to use it" about. */
export function hasClearanceRule(level: Level, itemId: string): boolean {
  const it = level.items[itemId];
  if (!it) return false;
  if (CLEARANCE_RULES[it.assetId] || DINING_TABLES.has(it.assetId)) return true;
  return DINING_CHAIRS.has(it.assetId) && clearanceZones(it, level).length > 0;
}

/** The pieces with a problem, in a steady order (for Show next). */
export function itemsWithIssues(all: ClearanceIssue[]): string[] {
  return [...new Set(all.map(issueItem).filter((id): id is string => !!id))].sort();
}

/** The doors that hit another door, in a steady order (Show next goes to them after pieces). */
export function doorsWithIssues(all: ClearanceIssue[]): string[] {
  const ids = all.flatMap((i) =>
    i.kind === 'doors' || i.kind === 'door-front' ? [i.openingId] : [],
  );
  return [...new Set(ids)].sort();
}

/** The plan details' walkway line, and whether it is a warning. */
export function walkwayLine(
  level: Level,
  report: WalkwayReport,
  otherLevels: Level[],
): { text: string; warn: boolean } {
  if (report.status === 'no-main-door') {
    // An upper floor: the way in is on another level.
    if (otherLevels.some((l) => entranceDoor(l))) {
      return { text: 'Walkways are checked on the level with the main door.', warn: false };
    }
    return { text: 'Add the main door to check walkways.', warn: false };
  }
  const short = report.routes
    .filter((r) => !r.ok)
    .sort((p, q) => p.have - q.have || q.need - p.need);
  if (!short.length) {
    return { text: 'Walkways: room to walk from the main door to every room.', warn: false };
  }
  const parts: string[] = [];
  for (const r of short) {
    const where = placeName(level, r.to);
    const part = `${where} (${r.have <= 0 ? 'closed' : formatLength(r.have).replace(' ', '\u00a0')})`;
    if (!parts.includes(part)) parts.push(part);
  }
  const more = parts.length - 3;
  return {
    text: `Walkways: tight to ${parts.slice(0, 3).join(', ')}${more > 0 ? `, and ${more} more.` : '.'}`,
    warn: true,
  };
}

/** The first problem of the selected piece for the live region, said when it settles. */
export function useClearanceAnnouncement(level: Level, selection: Selection | null): string {
  const issues = useClearanceIssues();
  const released = useWalkways((s) => s.released);
  const id = selection?.kind === 'item' ? selection.id : null;
  const lines = useMemo(() => (id ? itemIssueLines(level, id, issues) : []), [id, level, issues]);
  const first = lines[0] ?? null;
  const more = lines.length - 1;
  const [text, setText] = useState('');
  const said = useRef<{ id: string | null; first: string | null; released: number }>({
    id: null,
    first: null,
    released,
  });
  useEffect(() => {
    const sentence = (f: string | null) =>
      f ? `. ${f}${more > 0 ? ` ${more} more in the Inspector.` : ''}` : '';
    const prev = said.current;
    // A new selection: its description says its first problem straight away.
    if (prev.id !== id) {
      said.current = { id, first, released };
      setText(sentence(first));
      return;
    }
    if (pointerHeld()) return;
    const settle = () => {
      if (said.current.first === first) return;
      const had = said.current.first;
      said.current = { id, first, released };
      setText(first ? sentence(first) : had ? '. No clearance problems.' : '');
    };
    // Dropped: once the walkways are checked. Nudged: 500 ms after the last key.
    if (released !== prev.released) {
      said.current = { ...said.current, released };
      settle();
      return;
    }
    const t = setTimeout(settle, 500);
    return () => clearTimeout(t);
  }, [id, first, more, released]);
  return text;
}

const pts = (ps: Vec2[]) => ps.map((p) => `${p.x},${p.y}`).join(' ');

/** A label on the plan: its text, the point it hangs off and the way it goes from there. */
interface LabelSpec {
  key: string;
  text: string;
  /**
   * Where it may go, best first: a point and the unit direction from it to the label, its
   * near edge `gap` px out (10 unless given).
   */
  spots: { at: Vec2; n: Vec2; gap?: number }[];
  have: number;
  need: number;
}

const shortLabel = (have: number, need: number) =>
  `${have <= 0 ? 'Closed' : have.toFixed(2)} / ${formatLength(need)}`;

/** A zone's label, off the middle of its far edge (zone: side a, b, then b and a pushed out). */
function zoneLabel(key: string, zone: Vec2[], have: number, need: number): LabelSpec | null {
  const [a, , b2, a2] = zone as [Vec2, Vec2, Vec2, Vec2];
  if (!a || !a2 || !b2) return null;
  const len = Math.hypot(a2.x - a.x, a2.y - a.y) || 1;
  const n = { x: (a2.x - a.x) / len, y: (a2.y - a.y) / len };
  const wl = Math.hypot(b2.x - a2.x, b2.y - a2.y) || 1;
  const d = { x: (b2.x - a2.x) / wl, y: (b2.y - a2.y) / wl };
  const mid = { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 };
  return {
    key,
    text: shortLabel(have, need),
    have,
    need,
    // Off the far edge; further out, past a turn handle; else beside either far corner.
    spots: [
      { at: mid, n },
      { at: mid, n, gap: 34 },
      { at: b2, n: d },
      { at: a2, n: { x: -d.x, y: -d.y } },
    ],
  };
}

/**
 * A pinch's label: square to its bar off the middle (above or to the right first, then the
 * other side), else beyond either end of the bar.
 */
function pinchLabel(key: string, pinch: [Vec2, Vec2], have: number, need: number): LabelSpec {
  const [p, q] = pinch;
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  let n = { x: -(q.y - p.y) / len, y: (q.x - p.x) / len };
  if (n.y > 0.3 || (Math.abs(n.y) <= 0.3 && n.x < 0)) n = { x: -n.x, y: -n.y };
  const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  const d = { x: (q.x - p.x) / len, y: (q.y - p.y) / len };
  return {
    key,
    text: shortLabel(have, need),
    have,
    need,
    spots: [
      { at: mid, n },
      { at: mid, n: { x: -n.x, y: -n.y } },
      { at: q, n: d },
      { at: p, n: { x: -d.x, y: -d.y } },
      { at: mid, n, gap: 30 },
      { at: mid, n: { x: -n.x, y: -n.y }, gap: 30 },
    ],
  };
}

/** Width of a chip's text at 11 px, 600, tabular figures (about 5.3 px a character, measured). */
const textWidth = (s: string) => s.length * 5.6;

interface PlacedLabel {
  key: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Labels in plan units at this zoom: each chip 10 px off its point, skipped where it would
 * cover one already placed or leave the visible plan.
 */
function placeLabels(
  specs: LabelSpec[],
  zoom: number,
  visible: { x0: number; y0: number; x1: number; y1: number },
  avoid: { at: Vec2; half: Vec2 }[],
  handles: { at: Vec2; half: Vec2 }[],
) {
  const px = 1 / zoom;
  const out: PlacedLabel[] = [];
  // The selected piece's handles, then room names: kept clear of where a spot allows it, else
  // covered as little as can be (a handle over the text worst).
  const covers = (b: PlacedLabel, boxes: { at: Vec2; half: Vec2 }[]) =>
    boxes.reduce((t, a) => {
      const ox = Math.min(b.x + b.w, a.at.x + a.half.x) - Math.max(b.x, a.at.x - a.half.x);
      const oy = Math.min(b.y + b.h, a.at.y + a.half.y) - Math.max(b.y, a.at.y - a.half.y);
      return t + (ox > 0 && oy > 0 ? ox * oy : 0);
    }, 0);
  const fits = (b: PlacedLabel) =>
    b.x >= visible.x0 &&
    b.y >= visible.y0 &&
    b.x + b.w <= visible.x1 &&
    b.y + b.h <= visible.y1 &&
    !out.some((o) => b.x < o.x + o.w && o.x < b.x + b.w && b.y < o.y + o.h && o.y < b.y + b.h);
  for (const s of specs) {
    const w = (textWidth(s.text) + 8) * px;
    const h = 16 * px;
    const place = ({ at, n, gap: g }: { at: Vec2; n: Vec2; gap?: number }): PlacedLabel => {
      const gap = (g ?? 10) * px;
      // Anchored as the wall tags are: by its near side, centred across.
      const x =
        Math.abs(n.x) > 0.7 ? (n.x > 0 ? at.x + gap : at.x - gap - w) : at.x + n.x * gap - w / 2;
      const y =
        Math.abs(n.x) > 0.7 ? at.y + n.y * gap - h / 2 : n.y > 0 ? at.y + gap : at.y - gap - h;
      return { key: s.key, text: s.text, x, y, w, h };
    };
    let best: { b: PlacedLabel; c: number } | null = null;
    for (const b of s.spots.map(place)) {
      if (!fits(b)) continue;
      const c = 100 * covers(b, handles) + covers(b, avoid);
      if (!best || c < best.c) best = { b, c };
      if (c === 0) break;
    }
    if (best) out.push(best.b);
  }
  return out;
}

/**
 * Where a selected piece's handles are drawn (plan units at this zoom): a box round each
 * corner handle, the turn handle 30 px in front and its stem (as plan/tools.tsx draws them).
 */
function handleBoxes(it: Item, zoom: number): { at: Vec2; half: Vec2 }[] {
  const px = 1 / zoom;
  const box = (at: Vec2, h: number) => ({ at, half: { x: h * px, y: h * px } });
  const fp = itemFootprint(it);
  const out = fp.map((c) => box(c, 9));
  const [, , fr, fl] = fp as [Vec2, Vec2, Vec2, Vec2];
  const mid = { x: (fr.x + fl.x) / 2, y: (fr.y + fl.y) / 2 };
  const c = { x: it.position.x, y: it.position.z };
  const len = Math.hypot(mid.x - c.x, mid.y - c.y) || 1;
  const u = { x: (mid.x - c.x) / len, y: (mid.y - c.y) / len };
  const ahead = (t: number) => ({ x: mid.x + u.x * t * px, y: mid.y + u.y * t * px });
  out.push(box(ahead(30), 11));
  for (const t of [6, 14, 22]) out.push(box(ahead(t), 4));
  return out;
}

/**
 * Over the plan (world units): problems tinted red (room short in front of a piece or behind
 * a chair, a door's swing with a piece in it, doors hitting each other or a piece's doors,
 * pieces overlapping or in a wall), every walkway's narrowest point as a red bar with its
 * width, the selected piece's own room shown faintly when there's enough, its short zones
 * labelled and its narrowed way dashed. Left out of pictures.
 */
export const ClearanceLayer = memo(function ClearanceLayer({
  level,
  geom,
  view,
  size,
}: {
  level: Level;
  geom: PlanGeometry;
  view: View;
  size: Size;
}) {
  const issues = useClearanceIssues();
  const selection = useEditor((s) => s.selection);
  const selected = selection?.kind === 'item' ? level.items[selection.id] : undefined;
  const wayAsked = useWayShown((s) => (selected ? s.ids.has(selected.id) : false));
  // The selected piece, and a dining table's chairs with it.
  const mine = useMemo(() => {
    if (!selected) return new Set<string>();
    const ids = new Set([selected.id]);
    if (DINING_TABLES.has(selected.assetId)) {
      for (const c of chairsOf(level, selected.id)) ids.add(c);
    }
    return ids;
  }, [selected, level]);
  const fine = useMemo(() => {
    const out: { key: string; zone: Vec2[] }[] = [];
    for (const id of mine) {
      const it = level.items[id];
      if (!it) continue;
      const short = new Set(
        issues
          .filter((i) => i.kind === 'zone' && i.itemId === id)
          .map((i) => (i.kind === 'zone' ? i.side : '')),
      );
      for (const z of clearanceZones(it, level)) {
        if (!short.has(z.side)) out.push({ key: `${id}-${z.side}`, zone: z.zone });
      }
    }
    return out;
  }, [mine, level, issues]);
  // Pinch bars, once each however many pieces they're on.
  const pinches = useMemo(() => {
    const seen = new Map<string, Extract<ClearanceIssue, { kind: 'walkway' }>>();
    for (const i of issues) {
      if (i.kind !== 'walkway') continue;
      const k = i.pinch
        .map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`)
        .sort()
        .join('|');
      if (!seen.has(k)) seen.set(k, i);
    }
    return [...seen.entries()].map(([key, i]) => ({ key, i }));
  }, [issues]);
  // Labels: the selected piece's zones, then its pinches, then the others, worst first.
  const specs = useMemo(() => {
    const out: LabelSpec[] = [];
    for (const i of issues) {
      if (i.kind === 'zone' && mine.has(i.itemId)) {
        const l = zoneLabel(`z-${i.itemId}-${i.side}`, i.zone, i.have, i.need);
        if (l) out.push(l);
      }
    }
    const ownPinch = (key: string) =>
      issues.some(
        (i) =>
          i.kind === 'walkway' &&
          mine.has(i.itemId) &&
          i.pinch
            .map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`)
            .sort()
            .join('|') === key,
      );
    const sorted = [...pinches].sort(
      (p, q) =>
        Number(ownPinch(q.key)) - Number(ownPinch(p.key)) ||
        q.i.need - q.i.have - (p.i.need - p.i.have),
    );
    for (const { key, i } of sorted) {
      const mid = { x: (i.pinch[0].x + i.pinch[1].x) / 2, y: (i.pinch[0].y + i.pinch[1].y) / 2 };
      // The same shortfall as a zone label close by (a wardrobe's front and the way past it):
      // one chip says it.
      const twin = out.some(
        (z) =>
          z.key.startsWith('z-') &&
          Math.abs(z.have - i.have) <= 0.02 &&
          Math.abs(z.need - i.need) < 1e-6 &&
          Math.hypot((z.spots[0]?.at.x ?? 0) - mid.x, (z.spots[0]?.at.y ?? 0) - mid.y) < 1.5,
      );
      if (!twin) out.push(pinchLabel(`p-${key}`, i.pinch, i.have, i.need));
    }
    return out;
  }, [issues, mine, pinches]);
  const visible = {
    x0: view.cx - size.width / 2 / view.zoom,
    y0: view.cy - size.height / 2 / view.zoom,
    x1: view.cx + size.width / 2 / view.zoom,
    y1: view.cy + size.height / 2 / view.zoom,
  };
  const names = roomLabelBoxes(level, geom, view.zoom);
  const handles = selected ? handleBoxes(selected, view.zoom) : [];
  const labels = placeLabels(specs, view.zoom, visible, names, handles);
  // The selected piece's narrowed way, unless its way in (Show the way) is drawn.
  const route = useMemo(() => {
    if (!selected) return null;
    const w = issues.find((i) => i.kind === 'walkway' && i.itemId === selected.id);
    return w?.kind === 'walkway' && w.path.length > 1 ? w.path : null;
  }, [issues, selected]);
  const wayShown = !!selected && (wayAsked || wayIsOwn(level, selected.id));
  if (!issues.length && !fine.length) return null;
  const px = 1 / view.zoom;
  const drawn = new Set<string>();
  return (
    <g className="clearance" pointerEvents="none" data-export="skip">
      {fine.map((z) => (
        <polygon key={`fine-${z.key}`} className="clearance-fine" points={pts(z.zone)} />
      ))}
      {issues.map((i, k) => {
        const key = `${i.kind}-${issueItem(i) ?? ''}-${k}`;
        if (i.kind === 'zone') {
          return <polygon key={key} className="clearance-short" points={pts(i.zone)} />;
        }
        if (i.kind === 'door' || i.kind === 'doors' || i.kind === 'door-front') {
          // A door's sweep once, however many problems it's in.
          const sweep = drawn.has(i.openingId) ? [] : i.sweep;
          drawn.add(i.openingId);
          return (
            <g key={key}>
              {sweep.map((s, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a door's leaves, in order
                <polygon key={j} className="clearance-short" points={pts(s)} />
              ))}
              {i.kind === 'door-front' && (
                <polygon className="clearance-short" points={pts(i.zone)} />
              )}
            </g>
          );
        }
        if (i.kind === 'walkway') return null;
        const it = level.items[i.itemId];
        return it ? (
          <polygon key={key} className="clearance-clash" points={pts(itemFootprint(it))} />
        ) : null;
      })}
      {route && !wayShown && (
        <g className="clearance-route" data-testid="clearance-route">
          <polyline points={pts(route)} />
          {[route[0], route.at(-1)].map((p, j) =>
            p ? <circle key={j === 0 ? 'from' : 'to'} cx={p.x} cy={p.y} r={3 * px} /> : null,
          )}
        </g>
      )}
      {pinches.map(({ key, i }) => {
        const [p, q] = i.pinch;
        const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
        const t = { x: (-(q.y - p.y) / len) * 4 * px, y: ((q.x - p.x) / len) * 4 * px };
        return (
          <g key={key} className="clearance-pinch">
            <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} />
            {[p, q].map((e, j) => (
              <line
                key={j === 0 ? 'a' : 'b'}
                x1={e.x - t.x}
                y1={e.y - t.y}
                x2={e.x + t.x}
                y2={e.y + t.y}
              />
            ))}
          </g>
        );
      })}
      {labels.map((l) => (
        <g key={l.key} className="clearance-chip">
          <rect x={l.x} y={l.y} width={l.w} height={l.h} rx={4 * px} />
          <text
            className="num"
            x={l.x + l.w / 2}
            y={l.y + l.h / 2 + 4 * px}
            textAnchor="middle"
            fontSize={11 * px}
          >
            {l.text}
          </text>
        </g>
      ))}
    </g>
  );
});

/** The live region's addition for the selected piece: its first problem, once it settles. */
export function ClearanceAnnouncement({
  level,
  selection,
}: { level: Level; selection: Selection | null }) {
  const text = useClearanceAnnouncement(level, selection);
  return text ? <>{text}</> : null;
}

/** The other levels of the project, as shown (for the upper-floor walkway line). */
export function useOtherLevels(level: Level | undefined): Level[] {
  const project = useProject();
  const variant = useEditor((s) => s.variant);
  return useMemo(
    () =>
      project ? variantLevels(project, variant).filter((l) => !level || l.id !== level.id) : [],
    [project, variant, level],
  );
}
