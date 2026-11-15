import { doorClashes, doorFrontIssues } from './clearance-doors';
import {
  type Side,
  convexHull,
  dot,
  growRect,
  nearestOnEdge,
  overlapDepth,
  polygonGap,
  roomOff,
  shorten,
  sideOf,
  zoneOf,
} from './convex';
import { footprintPolygon, wallFootprints } from './footprints';
import { furnitureKind, furnitureLayer, itemFootprint, itemSize } from './furniture';
import { pointInPolygon } from './geometry';
import { DOOR_LEAF_THICKNESS, doorLeaves, planGeometry } from './plan';
import { roomShapes } from './rooms';
import { type Item, type Level, type Vec2, isBoundary } from './schema';

/**
 * The area `need` deep off a side, as far as the room goes: up to the nearest of `bounds`
 * (walls and the floor's edge), never through a wall into the next room or out of the flat.
 * No depth when the side is against a wall. What a zone issue draws, so the plan shows what
 * the check measured.
 */
export function zoneUpTo(s: Side, need: number, bounds: Vec2[][]): Vec2[] {
  return zoneOf(s, roomOff(s, need, bounds));
}

/** How deep a zone (`zoneOf`: a side's two corners, then each pushed out) reaches. */
export function zoneDepth(zone: readonly Vec2[]): number {
  const [a, , , d] = zone;
  return a && d ? Math.hypot(d.x - a.x, d.y - a.y) : 0;
}

export { overlapDepth } from './convex';

/**
 * Clearances: room in front of a piece to use it (open a wardrobe, pull out a drawer, sit
 * at a desk or a dining table), beside a bed to get in, a door's swing kept clear, doors not
 * hitting each other or a piece's own doors, pieces not overlapping or pushed into walls.
 * Walkways through the flat are in walkway.ts. Advice only: nothing here blocks an edit.
 * Metres.
 */
export interface ClearanceRule {
  /** Which side needs room: in front (+y), each long side, or one long side at least. */
  side: 'front' | 'sides' | 'either-side';
  need: number;
  /** What needs the room, with its verb, for a sentence: "Wardrobe doors need". */
  what: string;
}

/** Common practice (Neufert; NKBA for kitchens; BS 6465-2 for bathrooms). */
export const CLEARANCE_RULES: Record<string, ClearanceRule> = {
  wardrobe: { side: 'front', need: 0.6, what: 'Wardrobe doors need' },
  'built-in-wardrobe': { side: 'front', need: 0.6, what: 'Wardrobe doors need' },
  'built-in-shoe-cabinet': { side: 'front', need: 0.6, what: 'Cabinet doors need' },
  'built-in-kitchen-base': { side: 'front', need: 0.9, what: 'Cabinet doors need' },
  'chest-of-drawers': { side: 'front', need: 0.75, what: 'Drawers need' },
  'shelf-with-drawers': { side: 'front', need: 0.75, what: 'Drawers need' },
  desk: { side: 'front', need: 0.8, what: 'A desk chair needs' },
  'metal-desk': { side: 'front', need: 0.8, what: 'A desk chair needs' },
  fridge: { side: 'front', need: 0.9, what: 'The fridge door needs' },
  'kitchen-base': { side: 'front', need: 0.9, what: 'Cabinet doors need' },
  'kitchen-sink': { side: 'front', need: 0.9, what: 'Standing at the sink needs' },
  'kitchen-hob': { side: 'front', need: 0.9, what: 'Standing at the hob needs' },
  washer: { side: 'front', need: 0.7, what: 'The washer door needs' },
  toilet: { side: 'front', need: 0.6, what: 'The toilet needs' },
  vanity: { side: 'front', need: 0.7, what: 'The basin needs' },
  'bed-queen': { side: 'sides', need: 0.6, what: 'Getting into bed needs' },
  'bed-king': { side: 'sides', need: 0.6, what: 'Getting into bed needs' },
  'bed-single': { side: 'either-side', need: 0.6, what: 'Getting into bed needs' },
  'bed-bunk': { side: 'either-side', need: 0.6, what: 'Getting into bed needs' },
  'bed-super-single': { side: 'either-side', need: 0.6, what: 'Getting into bed needs' },
};

/** Dining tables a chair is pulled out from, and the chairs (Neufert: 750 mm to stand up). */
export const DINING_TABLES = new Set([
  'dining-4',
  'dining-6',
  'dining-extendable',
  'wooden-table',
  'pedestal-table-round',
]);
export const DINING_CHAIRS = new Set(['dining-chair', 'dining-chair-upholstered', 'plastic-chair']);
export const PULL_BACK = 0.75;
const PULL_WHAT = 'Pulling out the chair needs';
/** A chair this close to a table (or tucked under it) is one of its chairs. */
const CHAIR_REACH = 0.3;

/** Where a walkway goes: a room, or one long side of a bed. */
export interface WalkwayTo {
  roomId?: string;
  bedId?: string;
  side?: 'left' | 'right';
}

export type ClearanceIssue =
  | {
      kind: 'zone';
      itemId: string;
      /** Off the front, a long side (beds), or behind a dining chair (pulling it out). */
      side: 'front' | 'left' | 'right' | 'back';
      what: string;
      need: number;
      /** The room there is: to the nearest wall or piece in the way. */
      have: number;
      /**
       * The room needed, as an area off that side, as far as the room goes: cut at the
       * nearest wall or the floor's edge (`zoneUpTo`), so never through a wall. No depth when
       * the side is against one (a bed's side on a wall).
       */
      zone: Vec2[];
      /** Out from that side, away from the piece (a unit vector), even when `zone` has no depth. */
      out: Vec2;
    }
  | { kind: 'door'; itemId: string; openingId: string; sweep: Vec2[][] }
  | { kind: 'overlap'; itemId: string; otherId: string; depth: number }
  | { kind: 'wall'; itemId: string; depth: number }
  | {
      /** A piece narrowing (or closing) the way from the main door to rooms or bed sides. */
      kind: 'walkway';
      itemId: string;
      route: 'circulation' | 'bed';
      /** Every room or bed side beyond the pinch. */
      to: WalkwayTo[];
      need: number;
      /** The narrowest clear width on the widest way; 0 when the way is closed. */
      have: number;
      /** The need is the flat's own width there (narrower than the rule's). */
      capped: boolean;
      /** Across the narrowest point, from one obstacle to the other. */
      pinch: [Vec2, Vec2];
      /** From the start through the pinch to the target, at most 60 points. */
      path: Vec2[];
    }
  /** Two doors whose leaves hit each other when both are open (one issue per door). */
  | { kind: 'doors'; openingId: string; otherId: string; sweep: Vec2[][] }
  /** A door whose leaves hit a piece's hinged front (its reach, `zone`). */
  | { kind: 'door-front'; itemId: string; openingId: string; zone: Vec2[]; sweep: Vec2[][] };

/** The piece an issue is about; null for a door clash (it's about two doors). */
export const issueItem = (i: ClearanceIssue): string | null => ('itemId' in i ? i.itemId : null);

/** Pieces that sit under a table or desk, and the tables and desks they sit under. */
const SEAT = /dining-chair|desk-chair|stool|plastic-chair/;
const TABLE = /table|desk|dining-(\d|extendable|bench)/;
/** Pieces of a kitchen run: cabinets, and the fridge and washer that stand in line with them. */
const isKitchen = (id: string) =>
  id.startsWith('kitchen-') || id === 'built-in-kitchen-base' || id === 'fridge' || id === 'washer';

/** How much of a bed's side is the head end, where a bedside table goes. */
const HEAD_END = 0.55;

/**
 * Pieces joined into runs: each touching (within 2 cm of) the next, as kitchen cabinets make
 * one counter, straight, L or U. The run a piece is in, by a piece of it (the same for all).
 */
export function touchingRuns(
  items: readonly Item[],
  fps: ReadonlyMap<string, Vec2[]> = new Map(items.map((it) => [it.id, itemFootprint(it)])),
): (id: string) => string {
  const run = new Map<string, string>();
  const find = (id: string): string => {
    const up = run.get(id) ?? id;
    if (up === id) return id;
    const root = find(up);
    run.set(id, root);
    return root;
  };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i] as Item;
      const b = items[j] as Item;
      const fa = fps.get(a.id) ?? itemFootprint(a);
      const fb = fps.get(b.id) ?? itemFootprint(b);
      if (overlapDepth(growRect(fa, 0.02), fb) > 0) {
        const ra = find(a.id);
        const rb = find(b.id);
        if (ra !== rb) run.set(ra, rb);
      }
    }
  }
  return find;
}

/** Pieces that stand on the floor and get in the way (not rugs, people or lamps above). */
export function blocks(item: Item): boolean {
  const kind = furnitureKind(item.assetId);
  if (!kind || kind.walkThrough || kind.category === 'People') return false;
  return furnitureLayer(kind) === 'floor';
}

/** A side of a piece as the rule sees it: a bed's long side from the foot to the bedside table. */
export function ruleSide(fp: Vec2[], side: 'front' | 'left' | 'right'): Side {
  const s = sideOf(fp, side);
  return side !== 'front' && s.width > HEAD_END + 0.3 ? shorten(s, s.width - HEAD_END) : s;
}

/** The dining table a chair belongs to: the nearest within reach, or none. */
function tableOf(chair: Item, level: Level): Item | undefined {
  if (!DINING_CHAIRS.has(chair.assetId)) return undefined;
  const fp = itemFootprint(chair);
  let best: Item | undefined;
  let bestD = CHAIR_REACH;
  for (const t of Object.values(level.items)) {
    if (!DINING_TABLES.has(t.assetId)) continue;
    const d = polygonGap(fp, itemFootprint(t)).d;
    if (d <= bestD) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

/** The chairs of a dining table (for its details and to draw their zones with it). */
export function chairsOf(level: Level, tableId: string): string[] {
  return Object.values(level.items)
    .filter((c) => tableOf(c, level)?.id === tableId)
    .map((c) => c.id);
}

/**
 * The side a chair is pulled out over: from the table's edge nearest the chair, through the
 * chair's centre (so a chair turned a little still works), as wide as the chair.
 */
function pullSide(chair: Item, table: Item): Side {
  const c = { x: chair.position.x, y: chair.position.z };
  const tfp = itemFootprint(table);
  const e = nearestOnEdge(c, tfp);
  let n = { x: c.x - e.at.x, y: c.y - e.at.y };
  const len = Math.hypot(n.x, n.y);
  if (pointInPolygon(c, tfp) || len < 1e-6) {
    // Tucked right under: straight out from that edge.
    const p = tfp[e.edge] as Vec2;
    const q = tfp[(e.edge + 1) % tfp.length] as Vec2;
    const el = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    n = { x: (q.y - p.y) / el, y: -(q.x - p.x) / el };
    const t = { x: table.position.x, y: table.position.z };
    if (dot(n, { x: e.at.x - t.x, y: e.at.y - t.y }) < 0) n = { x: -n.x, y: -n.y };
  } else {
    n = { x: n.x / len, y: n.y / len };
  }
  const half = itemSize(chair).w / 2;
  const across = { x: -n.y, y: n.x };
  return {
    a: { x: e.at.x - across.x * half, y: e.at.y - across.y * half },
    b: { x: e.at.x + across.x * half, y: e.at.y + across.y * half },
    n,
    width: half * 2,
  };
}

/**
 * The areas a piece needs kept clear by its rule, to show while it's handled: full depth, or
 * with `level` as far as the room goes (cut at walls and the floor's edge, as the checks
 * measure). A dining chair's is behind it, from its table; `level` finds the table.
 */
export function clearanceZones(
  item: Item,
  level?: Level,
): { side: 'front' | 'left' | 'right' | 'back'; zone: Vec2[] }[] {
  const fixed = level && fixedParts(level);
  const table = level && tableOf(item, level);
  if (table) {
    const bounds = fixed ? [...fixed.solid, ...fixed.edges] : [];
    return [{ side: 'back', zone: zoneUpTo(pullSide(item, table), PULL_BACK, bounds) }];
  }
  const rule = CLEARANCE_RULES[item.assetId];
  if (!rule) return [];
  const fp = itemFootprint(item);
  const sides: ('front' | 'left' | 'right')[] =
    rule.side === 'front' ? ['front'] : ['left', 'right'];
  const bounds = fixed ? [...fixed.walls, ...fixed.edges] : [];
  return sides.map((side) => ({ side, zone: zoneUpTo(sideOf(fp, side), rule.need, bounds) }));
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
      // As thick as a leaf, so one that only slides (a barn door) still covers an area.
      const len = Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y) || 1;
      const h = DOOR_LEAF_THICKNESS / 2;
      const nx = (-(l.b.y - l.a.y) / len) * h;
      const ny = ((l.b.x - l.a.x) / len) * h;
      for (const p of [l.a, l.b]) {
        leaves[k].push({ x: p.x + nx, y: p.y + ny }, { x: p.x - nx, y: p.y - ny });
      }
    });
  }
  return leaves.map(convexHull).filter((h) => h.length >= 3);
}

/**
 * A bed's long sides that walkways check: those with room to get in (a side slice 1 finds
 * short isn't checked again), and of a single bed only the better one. Each with the area
 * beside it, from the foot to the bedside table.
 */
export function bedSides(
  level: Level,
  item: Item,
  /**
   * The level's pieces that `blocks`, in its order, and their footprints, when the caller
   * has them (the walkways, for every bed): the same obstacles, worked out once.
   */
  standing?: { pieces: readonly Item[]; fps: readonly Vec2[][] },
): { side: 'left' | 'right'; zone: Vec2[] }[] {
  const rule = CLEARANCE_RULES[item.assetId];
  if (!rule || rule.side === 'front' || !blocks(item)) return [];
  const fp = itemFootprint(item);
  const { walls, edges } = fixedParts(level);
  const others = standing
    ? standing.fps.filter((_, i) => standing.pieces[i]?.id !== item.id)
    : Object.values(level.items)
        .filter((o) => o.id !== item.id && blocks(o))
        .map((o) => itemFootprint(o));
  const obstacles = [...walls, ...edges, ...others];
  const sides = (['left', 'right'] as const).map((side) => {
    const s = ruleSide(fp, side);
    return { side, have: roomOff(s, rule.need, obstacles), zone: zoneOf(s, rule.need) };
  });
  const ok = sides.filter((s) => s.have >= rule.need - 0.005);
  if (rule.side === 'sides') return ok.map(({ side, zone }) => ({ side, zone }));
  const best = ok.reduce<(typeof ok)[number] | null>(
    (p, q) => (!p || q.have > p.have ? q : p),
    null,
  );
  return best ? [{ side: best.side, zone: best.zone }] : [];
}

/**
 * Every clearance problem on a level that is quick to find (cheap enough for every frame of
 * a drag): short room in front of (or beside) a piece or behind a dining chair, a door whose
 * swing a piece is in, doors hitting each other or a piece's doors, pieces overlapping, a
 * piece pushed into a wall. Pieces that don't stand on the floor (lamps, wall cabinets,
 * ceiling lights), rugs and people are left out. Walkways: `walkwayReport`.
 */
export function clearanceIssues(level: Level): ClearanceIssue[] {
  const out: ClearanceIssue[] = [];
  const items = Object.values(level.items).filter(blocks);
  const fps = new Map(items.map((it) => [it.id, itemFootprint(it)]));
  const { walls, solid, edges, sweeps, clashes } = fixedParts(level);
  // Where the room off a side ends whatever stands there: a wall (a doorway too, to be safe)
  // or the floor's edge. A zone is never measured, nor drawn, past one.
  const bounds = [...walls, ...edges];
  const pullBounds = [...solid, ...edges];

  // Kitchen cabinets joined into one run (straight, L or U): one counter, not in each
  // other's way. Runs apart (a galley's two sides) still are.
  const find = touchingRuns(
    items.filter((it) => isKitchen(it.assetId)),
    fps,
  );
  const tables = items.filter((it) => DINING_TABLES.has(it.assetId));

  for (const it of items) {
    const fp = fps.get(it.id) as Vec2[];
    const rule = CLEARANCE_RULES[it.assetId];
    if (rule) {
      // In the way, up to the walls: pieces on the floor, but not a seat in front of a desk,
      // nor a cabinet of its own kitchen run.
      const others = items
        .filter((o) => {
          if (o.id === it.id) return false;
          if (TABLE.test(it.assetId) && SEAT.test(o.assetId)) return false;
          if (isKitchen(it.assetId) && isKitchen(o.assetId) && find(it.id) === find(o.id)) {
            return Math.cos(o.rotationY - it.rotationY) < -0.5;
          }
          return true;
        })
        .map((o) => fps.get(o.id) as Vec2[]);
      // Not a piece of its own kitchen run, unless it faces this one across the kitchen
      // (a U's arms): an L's other leg or the next cabinet along is one counter.
      const check = (side: 'front' | 'left' | 'right') => {
        const s = ruleSide(fp, side);
        // As far as the room goes, then the pieces within that.
        const reach = roomOff(s, rule.need, bounds);
        return { side, have: roomOff(s, reach, others), zone: zoneOf(s, reach), out: s.n };
      };
      const sides = rule.side === 'front' ? [check('front')] : [check('left'), check('right')];
      const short = sides.filter((s) => s.have < rule.need - 0.005);
      // One good side is enough for a single bed (the other may be against a wall); short
      // both sides, the better one is the one to fix.
      const report =
        rule.side !== 'either-side'
          ? short
          : short.length < sides.length
            ? []
            : [short.reduce((p, q) => (q.have > p.have ? q : p))];
      for (const s of report) {
        out.push({
          kind: 'zone',
          itemId: it.id,
          side: s.side,
          what: rule.what,
          need: rule.need,
          have: s.have,
          zone: s.zone,
          out: s.out,
        });
      }
    }
    // A dining chair: room behind it to pull it out and sit, from its table's edge. In the
    // way: solid walls and the floor's edge, then pieces on the floor, not this chair nor its
    // table (a chair of another table behind it is).
    if (DINING_CHAIRS.has(it.assetId) && tables.length) {
      const table = tableOf(it, level);
      if (table && fps.has(table.id)) {
        const s = pullSide(it, table);
        const others = items
          .filter((o) => o.id !== it.id && o.id !== table.id)
          .map((o) => fps.get(o.id) as Vec2[]);
        const reach = roomOff(s, PULL_BACK, pullBounds);
        const have = roomOff(s, reach, others);
        if (have < PULL_BACK - 0.005) {
          out.push({
            kind: 'zone',
            itemId: it.id,
            side: 'back',
            what: PULL_WHAT,
            need: PULL_BACK,
            have,
            zone: zoneOf(s, reach),
            out: s.n,
          });
        }
      }
    }
    // Pushed into a wall (more than a centimetre).
    const into = Math.max(0, ...solid.map((w) => overlapDepth(fp, w)));
    if (into > 0.01) out.push({ kind: 'wall', itemId: it.id, depth: into });
  }

  // A door's swing with a piece in it.
  const inSwing = new Set<string>();
  for (const [openingId, sweep] of sweeps) {
    for (const it of items) {
      const fp = fps.get(it.id) as Vec2[];
      if (sweep.some((s) => overlapDepth(fp, s) > 0.005)) {
        out.push({ kind: 'door', itemId: it.id, openingId, sweep });
        inSwing.add(`${it.id}|${openingId}`);
      }
    }
  }
  // A door hitting a piece's own doors (a wardrobe's, the fridge's), and doors each other.
  // Rooms looked up only when a front and a swing meet (it's a drag's every frame).
  let shapes: ReturnType<typeof roomShapes> | null = null;
  const roomAt = (p: Vec2) => {
    shapes ??= roomShapes(level);
    for (const [id, sh] of shapes) {
      if (pointInPolygon(p, sh.outer) && !sh.holes.some((h) => pointInPolygon(p, h))) return id;
    }
    return null;
  };
  out.push(...doorFrontIssues(items, fps, sweeps, inSwing, roomAt), ...clashes);

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
      // A few centimetres is a snap's rounding, not a clash.
      if (depth > 0.04) {
        out.push({ kind: 'overlap', itemId: a.id, otherId: b.id, depth });
        out.push({ kind: 'overlap', itemId: b.id, otherId: a.id, depth });
      }
    }
  }
  return out;
}

/** The level's walls and doors as the clearance checks see them (kept while furniture moves). */
export type Fixed = {
  /** Every wall's outline (openings count as wall) and the hubs; not room boundaries. */
  walls: Vec2[][];
  solid: Vec2[][];
  /**
   * The floor's open edges: room boundaries with a room on one side only (a ledge or a
   * hole drawn without walls), as thin strips. The room off a side ends there as at a wall;
   * a boundary between two rooms (an open kitchen) is open floor.
   */
  edges: Vec2[][];
  sweeps: [string, Vec2[][]][];
  clashes: Extract<ClearanceIssue, { kind: 'doors' }>[];
};
// Walls and doors don't change while furniture moves: kept by the walls, corners, openings and
// rooms (Immer keeps those objects while only items change).
const fixedCache = new WeakMap<
  object,
  { vertices: object; openings: object; rooms: object; fixed: Fixed }
>();

/** How far past a room boundary to look for a room on its other side. */
const PROBE = 0.05;
/** Half the width of a floor edge's strip. */
const EDGE_HALF = 0.001;

/** The floor's open edges (`Fixed.edges`). */
export function floorEdges(level: Level): Vec2[][] {
  const bounded = Object.values(level.walls).filter(isBoundary);
  if (!bounded.length) return [];
  const shapes = [...roomShapes(level).values()];
  const onFloor = (p: Vec2) =>
    shapes.some((s) => pointInPolygon(p, s.outer) && !s.holes.some((h) => pointInPolygon(p, h)));
  const out: Vec2[][] = [];
  for (const w of bounded) {
    const a = level.vertices[w.a];
    const b = level.vertices[w.b];
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const left = onFloor({ x: mid.x + n.x * PROBE, y: mid.y + n.y * PROBE });
    const right = onFloor({ x: mid.x - n.x * PROBE, y: mid.y - n.y * PROBE });
    // Floor on one side only: the edge of the flat (or of a hole in a room).
    if (left === right) continue;
    const h = { x: n.x * EDGE_HALF, y: n.y * EDGE_HALF };
    out.push([
      { x: a.x - h.x, y: a.y - h.y },
      { x: b.x - h.x, y: b.y - h.y },
      { x: b.x + h.x, y: b.y + h.y },
      { x: a.x + h.x, y: a.y + h.y },
    ]);
  }
  return out;
}

export function fixedParts(level: Level): Fixed {
  const hit = fixedCache.get(level.walls);
  if (
    hit &&
    hit.vertices === level.vertices &&
    hit.openings === level.openings &&
    hit.rooms === level.rooms
  ) {
    return hit.fixed;
  }
  const fw = wallFootprints(level);
  const hubs = fw.hubs.map((h) => h.polygon);
  const walls = [
    ...Object.values(fw.walls)
      .filter((w) => {
        const wall = level.walls[w.wallId];
        return !!wall && !isBoundary(wall);
      })
      .map(footprintPolygon),
    ...hubs,
  ];
  const geom = planGeometry(level, fw);
  // Solid wall, and windows (a piece can't stand in one); a doorway's door check covers it.
  const solid = [
    ...geom.pieces.map((p) => p.polygon),
    ...hubs,
    ...geom.openings.filter((o) => o.kind === 'window').map((o) => o.polygon),
  ];
  const sweeps: [string, Vec2[][]][] = Object.values(level.openings)
    .filter((o) => o.kind === 'door')
    .map((o): [string, Vec2[][]] => [o.id, doorSweep(level, o.id, geom.frames)])
    .filter(([, sw]) => sw.length > 0);
  // Door against door depends only on walls and doors.
  const fixed = { walls, solid, edges: floorEdges(level), sweeps, clashes: doorClashes(sweeps) };
  if (Object.isFrozen(level.walls)) {
    fixedCache.set(level.walls, {
      vertices: level.vertices,
      openings: level.openings,
      rooms: level.rooms,
      fixed,
    });
  }
  return fixed;
}
