import { footprintPolygon, wallFootprints } from './footprints';
import { furnitureKind, furnitureLayer, itemFootprint } from './furniture';
import { doorLeaves, planGeometry } from './plan';
import { type Item, type Level, type Vec2, isBoundary } from './schema';

/**
 * Clearances: room in front of a piece to use it (open a wardrobe, pull out a drawer, sit
 * at a desk), beside a bed to get in, a door's swing kept clear, pieces not overlapping or
 * pushed into walls. Advice only: nothing here blocks an edit. Metres.
 */
export interface ClearanceRule {
  /** Which side needs room: in front (+y), each long side, or one long side at least. */
  side: 'front' | 'sides' | 'either-side';
  need: number;
  /** What needs the room, for a sentence: "Wardrobe doors". */
  what: string;
}

/** Common practice (Neufert; NKBA for kitchens; BS 6465-2 for bathrooms). */
export const CLEARANCE_RULES: Record<string, ClearanceRule> = {
  wardrobe: { side: 'front', need: 0.6, what: 'Wardrobe doors' },
  'chest-of-drawers': { side: 'front', need: 0.75, what: 'Drawers' },
  'shelf-with-drawers': { side: 'front', need: 0.75, what: 'Drawers' },
  desk: { side: 'front', need: 0.8, what: 'A desk chair' },
  'metal-desk': { side: 'front', need: 0.8, what: 'A desk chair' },
  fridge: { side: 'front', need: 0.9, what: 'The fridge door' },
  'kitchen-base': { side: 'front', need: 0.9, what: 'Cabinet doors' },
  'kitchen-sink': { side: 'front', need: 0.9, what: 'Standing at the sink' },
  'kitchen-hob': { side: 'front', need: 0.9, what: 'Standing at the hob' },
  washer: { side: 'front', need: 0.7, what: 'The washer door' },
  toilet: { side: 'front', need: 0.6, what: 'The toilet' },
  vanity: { side: 'front', need: 0.7, what: 'The basin' },
  'bed-queen': { side: 'sides', need: 0.6, what: 'Getting into bed' },
  'bed-king': { side: 'sides', need: 0.6, what: 'Getting into bed' },
  'bed-single': { side: 'either-side', need: 0.6, what: 'Getting into bed' },
  'bed-super-single': { side: 'either-side', need: 0.6, what: 'Getting into bed' },
};

export type ClearanceIssue =
  | {
      kind: 'zone';
      itemId: string;
      side: 'front' | 'left' | 'right';
      what: string;
      need: number;
      /** The room there is: to the nearest wall or piece in the way. */
      have: number;
      /** The room needed, as an area off that side. */
      zone: Vec2[];
    }
  | { kind: 'door'; itemId: string; openingId: string; sweep: Vec2[][] }
  | { kind: 'overlap'; itemId: string; otherId: string; depth: number }
  | { kind: 'wall'; itemId: string; depth: number };

/** Pieces that sit under a table or desk, and the tables and desks they sit under. */
const SEAT = /dining-chair|stool|plastic-chair/;
const TABLE = /table|desk|dining-\d/;
const isKitchen = (id: string) => id.startsWith('kitchen-');

/** Pieces that stand on the floor and get in the way (not rugs, people or lamps above). */
function blocks(item: Item): boolean {
  const kind = furnitureKind(item.assetId);
  if (!kind || kind.walkThrough || kind.category === 'People') return false;
  return furnitureLayer(kind) === 'floor';
}

// --- convex polygon helpers -------------------------------------------------------------

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const boxes = new WeakMap<readonly Vec2[], Box>();
/** A polygon's bounding box (kept per polygon). */
function box(poly: readonly Vec2[]): Box {
  let b = boxes.get(poly);
  if (!b) {
    b = {
      x0: Number.POSITIVE_INFINITY,
      y0: Number.POSITIVE_INFINITY,
      x1: Number.NEGATIVE_INFINITY,
      y1: Number.NEGATIVE_INFINITY,
    };
    for (const p of poly) {
      b.x0 = Math.min(b.x0, p.x);
      b.y0 = Math.min(b.y0, p.y);
      b.x1 = Math.max(b.x1, p.x);
      b.y1 = Math.max(b.y1, p.y);
    }
    boxes.set(poly, b);
  }
  return b;
}
/** Whether two polygons' boxes meet (a quick no before the exact test). */
const near = (p: readonly Vec2[], q: readonly Vec2[], pad = 0) => {
  const a = box(p);
  const b = box(q);
  return a.x0 <= b.x1 + pad && b.x0 <= a.x1 + pad && a.y0 <= b.y1 + pad && b.y0 <= a.y1 + pad;
};

const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;

function axes(poly: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as Vec2;
    const q = poly[(i + 1) % poly.length] as Vec2;
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len > 1e-9) out.push({ x: -(q.y - p.y) / len, y: (q.x - p.x) / len });
  }
  return out;
}

/** How far two convex polygons overlap (the least push to part them); 0 when apart. */
export function overlapDepth(p: readonly Vec2[], q: readonly Vec2[]): number {
  if (!near(p, q)) return 0;
  let least = Number.POSITIVE_INFINITY;
  for (const n of [...axes(p), ...axes(q)]) {
    let p0 = Number.POSITIVE_INFINITY;
    let p1 = Number.NEGATIVE_INFINITY;
    let q0 = Number.POSITIVE_INFINITY;
    let q1 = Number.NEGATIVE_INFINITY;
    for (const v of p) {
      const d = dot(v, n);
      p0 = Math.min(p0, d);
      p1 = Math.max(p1, d);
    }
    for (const v of q) {
      const d = dot(v, n);
      q0 = Math.min(q0, d);
      q1 = Math.max(q1, d);
    }
    const o = Math.min(p1, q1) - Math.max(p0, q0);
    if (o <= 0) return 0;
    least = Math.min(least, o);
  }
  return Number.isFinite(least) ? least : 0;
}

/** `poly` clipped to the half-plane where `f(v) >= 0` (f linear). */
function clipHalf(poly: Vec2[], f: (v: Vec2) => number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Vec2;
    const b = poly[(i + 1) % poly.length] as Vec2;
    const fa = f(a);
    const fb = f(b);
    if (fa >= 0) out.push(a);
    if (fa >= 0 !== fb >= 0) {
      const t = fa / (fa - fb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

function convexHull(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: Vec2, a: Vec2, b: Vec2) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2] as Vec2, lower[lower.length - 1] as Vec2, p) <= 0
    )
      lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (const p of [...pts].reverse()) {
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2] as Vec2, upper[upper.length - 1] as Vec2, p) <= 0
    )
      upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// --- the checks -------------------------------------------------------------------------

/** One side of a piece: its two corners (left to right, looking out) and outward normal. */
interface Side {
  a: Vec2;
  b: Vec2;
  n: Vec2;
  width: number;
}

/** Footprint corners: back-left, back-right, front-right, front-left (itemFootprint). */
function sideOf(fp: Vec2[], side: 'front' | 'left' | 'right'): Side {
  const [bl, br, fr, fl] = fp as [Vec2, Vec2, Vec2, Vec2];
  const [a, b, inner] =
    side === 'front' ? [fr, fl, br] : side === 'left' ? [fl, bl, fr] : [br, fr, bl];
  const width = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  // Outward: away from the opposite side.
  const d = { x: (b.x - a.x) / width, y: (b.y - a.y) / width };
  let n = { x: -d.y, y: d.x };
  if (dot({ x: inner.x - a.x, y: inner.y - a.y }, n) > 0) n = { x: -n.x, y: -n.y };
  return { a, b, n, width };
}

/** The area `need` deep off a side. */
function zoneOf(s: Side, need: number): Vec2[] {
  const off = (p: Vec2) => ({ x: p.x + s.n.x * need, y: p.y + s.n.y * need });
  return [s.a, s.b, off(s.b), off(s.a)];
}

/** The room off a side, up to `need`: how far the nearest obstacle is, in the side's width. */
function roomOff(s: Side, need: number, obstacles: Vec2[][]): number {
  const d = { x: (s.b.x - s.a.x) / s.width, y: (s.b.y - s.a.y) / s.width };
  const u = (p: Vec2) => (p.x - s.a.x) * d.x + (p.y - s.a.y) * d.y;
  const v = (p: Vec2) => (p.x - s.a.x) * s.n.x + (p.y - s.a.y) * s.n.y;
  // A wall or piece only touching the side's ends (a corner) isn't in front of it.
  const e = 0.01;
  let have = need;
  const zone = zoneOf(s, need);
  for (const poly of obstacles) {
    if (!near(zone, poly)) continue;
    let c = clipHalf(poly, (p) => u(p) - e);
    c = clipHalf(c, (p) => s.width - e - u(p));
    c = clipHalf(c, (p) => v(p) + 0.005);
    c = clipHalf(c, (p) => need - v(p));
    for (const p of c) have = Math.min(have, Math.max(0, v(p)));
  }
  return have;
}

/** The areas a piece needs kept clear by its rule (full depth), to show while it's handled. */
export function clearanceZones(item: Item): { side: 'front' | 'left' | 'right'; zone: Vec2[] }[] {
  const rule = CLEARANCE_RULES[item.assetId];
  if (!rule) return [];
  const fp = itemFootprint(item);
  const sides: ('front' | 'left' | 'right')[] =
    rule.side === 'front' ? ['front'] : ['left', 'right'];
  return sides.map((side) => ({ side, zone: zoneOf(sideOf(fp, side), rule.need) }));
}

/** The area each leaf of a door sweeps from shut to open (one polygon per leaf). */
export function doorSweep(
  level: Level,
  openingId: string,
  frames = planGeometry(level).frames,
): Vec2[][] {
  const o = level.openings[openingId];
  if (!o || o.kind !== 'door') return [];
  const f = frames[o.wallId];
  if (!f) return [];
  const steps = 8;
  const leaves: Vec2[][] = [];
  for (let i = 0; i <= steps; i++) {
    doorLeaves(f, o, i / steps).forEach((l, k) => {
      if (!leaves[k]) leaves[k] = [];
      leaves[k].push(l.a, l.b);
    });
  }
  return leaves.map(convexHull).filter((h) => h.length >= 3);
}

/**
 * Every clearance problem on a level: short room in front of (or beside) a piece, a door
 * whose swing a piece is in, pieces overlapping, a piece pushed into a wall. Pieces that don't
 * stand on the floor (lamps, wall cabinets, ceiling lights), rugs and people are left out.
 */
export function clearanceIssues(level: Level): ClearanceIssue[] {
  const out: ClearanceIssue[] = [];
  const items = Object.values(level.items).filter(blocks);
  const fps = new Map(items.map((it) => [it.id, itemFootprint(it)]));
  const fw = wallFootprints(level);
  const walls = Object.values(fw.walls)
    .filter((w) => {
      const wall = level.walls[w.wallId];
      return !!wall && !isBoundary(wall);
    })
    .map(footprintPolygon);
  const geom = planGeometry(level, fw);
  const solid = geom.pieces.map((p) => p.polygon);

  // Kitchen cabinets joined into one run (straight, L or U): one counter, not in each
  // other's way. Runs apart (a galley's two sides) still are.
  const run = new Map<string, string>();
  const find = (id: string): string => {
    const up = run.get(id) ?? id;
    if (up === id) return id;
    const root = find(up);
    run.set(id, root);
    return root;
  };
  const kitchen = items.filter((it) => isKitchen(it.assetId));
  for (let i = 0; i < kitchen.length; i++) {
    for (let j = i + 1; j < kitchen.length; j++) {
      const a = kitchen[i] as Item;
      const b = kitchen[j] as Item;
      if (overlapDepth(grow(fps.get(a.id) as Vec2[], 0.02), fps.get(b.id) as Vec2[]) > 0) {
        run.set(find(a.id), find(b.id));
      }
    }
  }

  for (const it of items) {
    const fp = fps.get(it.id) as Vec2[];
    const rule = CLEARANCE_RULES[it.assetId];
    if (rule) {
      // In the way: walls (doorways too, to be safe), and pieces on the floor, but not a seat
      // in front of a desk, nor a cabinet of its own kitchen run.
      const others = items
        .filter((o) => {
          if (o.id === it.id) return false;
          if (TABLE.test(it.assetId) && SEAT.test(o.assetId)) return false;
          if (isKitchen(it.assetId) && isKitchen(o.assetId)) return find(it.id) !== find(o.id);
          return true;
        })
        .map((o) => fps.get(o.id) as Vec2[]);
      const obstacles = [...walls, ...fw.hubs.map((h) => h.polygon), ...others];
      const check = (side: 'front' | 'left' | 'right') => {
        const s = sideOf(fp, side);
        return { side, have: roomOff(s, rule.need, obstacles), zone: zoneOf(s, rule.need) };
      };
      const sides = rule.side === 'front' ? [check('front')] : [check('left'), check('right')];
      const short = sides.filter((s) => s.have < rule.need - 0.005);
      // One good side is enough for a single bed (the other may be against a wall).
      const report = rule.side === 'either-side' && short.length < sides.length ? [] : short;
      for (const s of report) {
        out.push({
          kind: 'zone',
          itemId: it.id,
          side: s.side,
          what: rule.what,
          need: rule.need,
          have: s.have,
          zone: s.zone,
        });
      }
    }
    // Pushed into a wall (more than a centimetre).
    const into = Math.max(0, ...solid.map((w) => overlapDepth(fp, w)));
    if (into > 0.01) out.push({ kind: 'wall', itemId: it.id, depth: into });
  }

  // A door's swing with a piece in it.
  for (const o of Object.values(level.openings)) {
    if (o.kind !== 'door') continue;
    const sweep = doorSweep(level, o.id, geom.frames);
    for (const it of items) {
      const fp = fps.get(it.id) as Vec2[];
      if (sweep.some((s) => overlapDepth(fp, s) > 0.005)) {
        out.push({ kind: 'door', itemId: it.id, openingId: o.id, sweep });
      }
    }
  }

  // Pieces overlapping (a chair tucked under a table or desk is meant to).
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i] as Item;
      const b = items[j] as Item;
      const tucked =
        (SEAT.test(a.assetId) && TABLE.test(b.assetId)) ||
        (SEAT.test(b.assetId) && TABLE.test(a.assetId));
      if (tucked) continue;
      const depth = overlapDepth(fps.get(a.id) as Vec2[], fps.get(b.id) as Vec2[]);
      if (depth > 0.02) {
        out.push({ kind: 'overlap', itemId: a.id, otherId: b.id, depth });
        out.push({ kind: 'overlap', itemId: b.id, otherId: a.id, depth });
      }
    }
  }
  return out;
}

/** A convex polygon pushed out by `by` from its centre (enough to test touching). */
function grow(poly: Vec2[], by: number): Vec2[] {
  const c = poly.reduce((s, p) => ({ x: s.x + p.x / poly.length, y: s.y + p.y / poly.length }), {
    x: 0,
    y: 0,
  });
  return poly.map((p) => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / len) * by * Math.SQRT2, y: p.y + (dy / len) * by * Math.SQRT2 };
  });
}
