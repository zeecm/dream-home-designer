import { z } from 'zod';
import { depthOff, largestSquare, sideAt, squareAt } from './ageing-zones';
import { CLEARANCE_RULES, fixedParts, ruleSide } from './clearance';
import { type Side, box, nearestOnPolygon, overlapDepth, sideOf, zoneOf } from './convex';
import { accessClearWidth } from './delivery';
import { ELEC_KINDS, latchEnd, pointPosition } from './electrical';
import { itemFootprint, itemSize } from './furniture';
import { Buffers, type Grid, Search, cellAt, cellCentre, distanceField, widestWays } from './grid';
import { framePoint } from './plan';
import { roomShapes } from './rooms';
import { type Item, type Level, type Vec2, isBoundary } from './schema';
import { type RoomKind, roomKind } from './suggest';
import {
  type Bare,
  type FurnishedPass,
  OUTSIDE,
  type Throat,
  type WalkwayReport,
  type WayMeasure,
  closedBarOf,
  furnishedPass,
  measureWay,
  narrowingPieces,
  passPiece,
  standingPieces,
} from './walkway';

/**
 * The ageing parents check: doors, the way through, room to turn, their bathroom and switch
 * heights for an older person with a walking aid or a wheelchair, against Singapore's Code on
 * Accessibility (2025, chapter 7 for homes) and good practice. Advice only, like clearance
 * checks. It reuses the walkway raster and widest-way search (walkway.ts) and measures the
 * narrow places exactly on the polygons (ageing-zones.ts). Metres.
 * Spec: docs/specs/ageing-parents.md, slice 1.
 */
export type AgeingProfile = 'walking' | 'wheelchair';

export interface AgeingChoice {
  profile: AgeingProfile;
  bedroomId?: string;
  bathroomId?: string;
}

export type AgeingGroup = 'in' | 'around' | 'bedroom' | 'bathroom' | 'points';
export const AGEING_GROUPS: AgeingGroup[] = ['in', 'around', 'bedroom', 'bathroom', 'points'];

export type AgeingKind =
  | 'door-width'
  | 'entrance-space'
  | 'latch-side'
  | 'door-space'
  | 'door-in'
  | 'route'
  | 'turn'
  | 'bed'
  | 'wc-front'
  | 'wc-side'
  | 'wc-way'
  | 'reach';

const KIND_ORDER: AgeingKind[] = [
  'door-width',
  'entrance-space',
  'latch-side',
  'door-space',
  'door-in',
  'route',
  'wc-front',
  'wc-side',
  'wc-way',
  'turn',
  'bed',
  'reach',
];

export interface AgeingIssue {
  /** Stable while the plan doesn't change shape: for Show next and the live region. */
  key: string;
  group: AgeingGroup;
  level: 'needed' | 'recommended';
  kind: AgeingKind;
  need: number;
  /**
   * What there is: a clear width, a depth, a square's side (`door-space`, wheelchair
   * `wc-front`), a circle's diameter (`turn`); 0 for a closed way.
   */
  have: number;
  /** The pieces in the way (none: the flat's own walls). */
  itemIds: string[];
  openingId?: string;
  /** The room it is about: a door leads into it; a turn, toilet or bed is in it. */
  roomId?: string;
  /** All the rooms of a turning space (joined by room boundaries). */
  roomIds?: string[];
  pointIds?: string[];
  /** The flat's own walls are what's short: nothing to move. */
  flat?: boolean;
  /** A route: the rooms beyond the narrow place. */
  to?: string[];
  /** A door's clear width (door-space), and the smaller door width that would do instead. */
  clear?: number;
  alt?: { clear: number; need: number };
  draw: { circle?: { c: Vec2; r: number }; poly?: Vec2[]; bar?: [Vec2, Vec2] };
}

/** A turning space checked, fine or short, and where its best circle is. */
export interface AgeingTurn {
  key: string;
  roomIds: string[];
  c: Vec2;
  have: number;
  ok: boolean;
}

export type AgeingNote = 'no-main-door' | 'add-toilet' | 'name-bathroom';

export interface AgeingReport {
  profile: AgeingProfile;
  status: 'ok' | 'no-main-door' | 'issues';
  /** The main door the routes start from. */
  start: string | null;
  /** Their bedroom and bathroom (chosen, or the bathroom found for them). */
  bedroom?: string;
  bathroom?: string;
  bathroomAuto: boolean;
  /** Before a bedroom is chosen: each bedroom with what choosing it would add. */
  bedrooms: { roomId: string; count: number }[];
  /** Every bedroom that can be chosen (their bedroom, by core's rule). */
  bedroomIds: string[];
  bathrooms: string[];
  issues: AgeingIssue[];
  /** The checks run in each group and found fine ("Also checked"). */
  passed: { group: AgeingGroup; kind: AgeingKind }[];
  notes: AgeingNote[];
  /** Every turning space checked (the plan draws the fine ones when their room is selected). */
  turns: AgeingTurn[];
  /** Their bathroom's toilet zones, to draw when the bathroom is selected. */
  toilet?: { roomId: string; front: Vec2[]; side: Vec2[] };
}

/** The rule sizes (COA 2025; M4(2) for the walking aid's doors, not re-checked). */
export const AGEING_NEEDS = {
  wheelchair: {
    mainDoor: 0.85,
    door: 0.8,
    route: 0.9,
    bathRoute: 1.0,
    bed: 1.0,
    turn: 1.5,
    wcFront: 1.0,
    wcSide: 0.45,
    wcWay: 1.0,
  },
  walking: {
    mainDoor: 0.75,
    door: 0.75,
    route: 0.9,
    bathRoute: 0.9,
    bed: 0.75,
    turn: 0,
    wcFront: 0.6,
    wcSide: 0.45,
    wcWay: 0,
  },
} as const;

/** The space inside the main door (COA 2025 7.2.2 (a), Fig. 66). */
export const ENTRANCE = { width: 1.25, depth: 1.5, slide: 0.3 } as const;
/** Beside the handle edge of an in-swinging main door. */
export const LATCH = { width: 0.45, depth: 1.5 } as const;
/** Switches and sockets: their centre between these (COA 2025 7.4.1); in front kept clear. */
export const POINT_REACH = { low: 0.45, high: 1.2, front: 0.15 } as const;
const SLACK = 0.005;
/** How deep the space in front of the toilet and basin the way in the bathroom goes to. */
const WAY_TO = 0.3;
const MIN_ROOM = 1.0;

/**
 * COA 2025 Table 7: the clear square needed outside a door on the way, by its clear width
 * (to the millimetre): 0.90 and wider 1.00; 0.85 up to 0.90, 1.10; 0.80 up to 0.85, 1.20.
 * Narrower: none (the door itself fails).
 */
export function table7(clear: number): number | null {
  const mm = Math.round(clear * 1000);
  if (mm >= 900) return 1.0;
  if (mm >= 850) return 1.1;
  if (mm >= 800) return 1.2;
  return null;
}

/** A pinch's key: its ends to the millimetre, in order. */
export const pinchKey = (p: readonly [Vec2, Vec2]) =>
  p
    .map((q) => `${q.x.toFixed(3)},${q.y.toFixed(3)}`)
    .sort()
    .join('|');

// ---------------------------------------------------------------------------------------------

interface RoomInfo {
  id: string;
  idx: number;
  name: string;
  kind: RoomKind;
  area: number;
}

/** A door on a route: its throat and the side the route comes from (+1: the wall's +n side). */
interface DoorOn {
  t: number;
  from: 1 | -1;
}

interface RouteFact {
  need: number;
  issues: AgeingIssue[];
  doors: DoorOn[];
  /** The bare way's cells, for the way in the bathroom. */
  last: DoorOn | null;
}

interface BathFact {
  issues: AgeingIssue[];
  noToilet: boolean;
  checked: AgeingKind[];
  toilet?: { roomId: string; front: Vec2[]; side: Vec2[] };
}

/** Everything that doesn't depend on which bedroom and bathroom are theirs. */
interface Facts {
  profile: AgeingProfile;
  start: string | null;
  rooms: RoomInfo[];
  bedrooms: string[];
  bathrooms: string[];
  /** Living rooms and kitchens. */
  common: string[];
  main: AgeingIssue[];
  mainChecked: AgeingKind[];
  routes: Map<string, RouteFact>;
  doors: Map<string, AgeingIssue[]>;
  /** Each door on a route (by throat and side): the room it leads into, and if it has a door. */
  doorInto: Map<string, { into: string | undefined; door: boolean }>;
  turns: Map<string, { turn: AgeingTurn; issue: AgeingIssue | null }>;
  turnOf: Map<string, string>;
  baths: Map<string, BathFact>;
  beds: Map<string, AgeingIssue | null>;
  reach: AgeingIssue | null;
  reachChecked: boolean;
  autoBath: Map<string, string | null>;
}

const factCache = new WeakMap<Level, Partial<Record<AgeingProfile, Facts>>>();
const turnBuffers = new Buffers();

const BED = (it: Item) => {
  const r = CLEARANCE_RULES[it.assetId];
  return !!r && r.side !== 'front';
};

/** The groups of rooms open to each other across room boundaries (not doors or passages). */
const groupCache = new WeakMap<Bare, Int32Array>();
function roomGroups(bare: Bare): Int32Array {
  const hit = groupCache.get(bare);
  if (hit) return hit;
  const { g, room, solid, throatOf, rooms } = bare;
  const up = new Int32Array(rooms.length).map((_, i) => i);
  const find = (from: number): number => {
    let i = from;
    while (up[i] !== i) {
      up[i] = up[up[i] as number] as number;
      i = up[i] as number;
    }
    return i;
  };
  for (let k = 0; k < g.n; k++) {
    if (solid[k] || (throatOf[k] as number) >= 0) continue;
    const r = room[k] as number;
    if (r < 0) continue;
    for (const m of [k + 1, k + g.nx]) {
      if (m >= g.n || solid[m] || (throatOf[m] as number) >= 0) continue;
      const q = room[m] as number;
      if (q >= 0 && q !== r) {
        const a = find(r);
        const b = find(q);
        if (a !== b) up[a] = b;
      }
    }
  }
  const out = new Int32Array(rooms.length).map((_, i) => find(i));
  groupCache.set(bare, out);
  return out;
}

/** The work of the check that doesn't depend on the choice, for one profile. */
export function ageingFacts(level: Level, profile: AgeingProfile): Facts {
  const hit = factCache.get(level)?.[profile];
  if (hit) return hit;
  // One furnished pass, read only within this call (its arrays are shared buffers).
  const pass = furnishedPass(level);
  const facts = buildFacts(level, profile, pass);
  if (Object.isFrozen(level)) {
    factCache.set(level, { ...(factCache.get(level) ?? {}), [profile]: facts });
  }
  return facts;
}

function buildFacts(level: Level, profile: AgeingProfile, pass: FurnishedPass): Facts {
  const N = AGEING_NEEDS[profile];
  const wheel = profile === 'wheelchair';
  const bare = pass.bare;
  const { g, room, throats, throatOf } = bare;
  const shapes = roomShapes(level);
  const rooms: RoomInfo[] = bare.rooms.map((r, idx) => {
    const name = level.rooms[r.id]?.name ?? '';
    return { id: r.id, idx, name, kind: roomKind(name), area: r.area };
  });
  const big = (r: RoomInfo) => r.area >= MIN_ROOM;
  const idxOf = new Map(rooms.map((r) => [r.id, r.idx]));
  const roomAtPoint = (p: Vec2) => {
    const k = cellAt(g, p);
    return k >= 0 ? (room[k] as number) : -1;
  };
  const pieceRoom = (it: Item) => roomAtPoint({ x: it.position.x, y: it.position.z });

  let bedrooms = rooms.filter((r) => r.kind === 'bedroom' && big(r)).map((r) => r.id);
  if (!bedrooms.length) {
    // A studio: the room the bed is in.
    const withBed = new Set(pass.pieces.filter(BED).map(pieceRoom));
    bedrooms = rooms.filter((r) => withBed.has(r.idx) && big(r)).map((r) => r.id);
  }
  const bathrooms = rooms.filter((r) => r.kind === 'bathroom' && big(r)).map((r) => r.id);
  const common = rooms
    .filter((r) => (r.kind === 'living' || r.kind === 'kitchen') && big(r))
    .map((r) => r.id);

  // Obstacles measured exactly: walls (doorways closed), hubs, columns, the pieces.
  const fixed = fixedParts(level);
  const holes = [...shapes.values()].flatMap((s) => s.holes);
  const nFixed = fixed.walls.length + holes.length;
  const obstacles = [...fixed.walls, ...holes, ...pass.fps];
  const pieceAt = (i: number) => (i >= nFixed ? (pass.pieces[i - nFixed]?.id ?? null) : null);
  const without = (id: string) => obstacles.filter((_, i) => pieceAt(i) !== id);
  const withoutIdx = (id: string) => obstacles.map((_, i) => i).filter((i) => pieceAt(i) !== id);
  const piecesIn = (poly: Vec2[], skip?: string) =>
    pass.pieces
      .filter((it, i) => it.id !== skip && overlapDepth(poly, pass.fps[i] as Vec2[]) > 0.005)
      .map((it) => it.id)
      .sort();

  /** How deep the rooms go off a side before the raster says outside the flat. */
  const outside = (s: Side, need: number) => {
    const z = zoneOf(s, need);
    const xs = z.map((p) => p.x);
    const ys = z.map((p) => p.y);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - g.x0) / g.c));
    const i1 = Math.min(g.nx - 1, Math.floor((Math.max(...xs) - g.x0) / g.c));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - g.y0) / g.c));
    const j1 = Math.min(g.ny - 1, Math.floor((Math.max(...ys) - g.y0) / g.c));
    const d = { x: (s.b.x - s.a.x) / s.width, y: (s.b.y - s.a.y) / s.width };
    let have = need;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * g.nx + i;
        if (bare.owner[k] !== OUTSIDE) continue;
        const p = cellCentre(g, k);
        const u = (p.x - s.a.x) * d.x + (p.y - s.a.y) * d.y;
        const v = (p.x - s.a.x) * s.n.x + (p.y - s.a.y) * s.n.y;
        if (u < 0 || u > s.width || v < 0 || v > need) continue;
        have = Math.min(have, Math.max(0, v - g.c / 2));
      }
    }
    return have;
  };

  const doorBar = (t: Throat): [Vec2, Vec2] => [framePoint(t.f, t.u0, 0), framePoint(t.f, t.u1, 0)];
  const roomIdOf = (idx: number) => (idx >= 0 ? rooms[idx]?.id : undefined);

  // --- the main door -----------------------------------------------------------------------
  const start = bare.start;
  const startT = start ? throats.findIndex((t) => t.openingId === start) : -1;
  const main: AgeingIssue[] = [];
  const mainChecked: AgeingKind[] = [];
  const mainT = startT >= 0 ? throats[startT] : undefined;
  const mainO = start ? level.openings[start] : undefined;
  if (mainT && mainO) {
    const inside: 1 | -1 = (mainT.rooms[0] ?? -1) >= 0 ? 1 : -1;
    const into = roomIdOf(mainT.rooms[inside === 1 ? 0 : 1] ?? -1);
    const f = mainT.f;
    const nIn = { x: f.n.x * inside, y: f.n.y * inside };
    const clear = accessClearWidth(mainO);
    mainChecked.push('door-width');
    if (clear < N.mainDoor - 1e-9) {
      main.push({
        key: `door-width:${start}`,
        group: 'in',
        level: 'needed',
        kind: 'door-width',
        need: N.mainDoor,
        have: clear,
        itemIds: [],
        openingId: start ?? undefined,
        roomId: into,
        draw: { bar: doorBar(mainT) },
      });
    }
    const latch = latchEnd(mainO);
    if (wheel) {
      mainChecked.push('entrance-space');
      const um = (mainT.u0 + mainT.u1) / 2;
      const c = framePoint(f, um, inside);
      const dir = latch === undefined ? 0 : latch === 1 ? 1 : -1;
      const slides = Array.from({ length: 7 }, (_, i) => (i / 6) * ENTRANCE.slide);
      const all = dir === 0 ? [...slides, ...slides.slice(1).map((t) => -t)] : slides;
      let best = { have: -1, side: sideAt(c, f.d, nIn, ENTRANCE.width) };
      for (const t of all) {
        const at = { x: c.x + f.d.x * t * (dir || 1), y: c.y + f.d.y * t * (dir || 1) };
        const side = sideAt(at, f.d, nIn, ENTRANCE.width);
        const h = Math.min(
          depthOff(side, ENTRANCE.depth, obstacles).have,
          outside(side, ENTRANCE.depth),
        );
        if (h > best.have + 1e-9) best = { have: h, side };
      }
      if (best.have < ENTRANCE.depth - SLACK) {
        const poly = zoneOf(best.side, ENTRANCE.depth);
        main.push({
          key: `entrance:${start}`,
          group: 'in',
          level: 'needed',
          kind: 'entrance-space',
          need: ENTRANCE.depth,
          have: round(best.have),
          itemIds: piecesIn(poly),
          openingId: start ?? undefined,
          roomId: into,
          draw: { poly },
        });
      }
    }
    // Beside the handle of a door that swings in (one swinging out is pulled from the
    // corridor, which isn't drawn).
    const swingSide = (mainO.swing ?? 'leftIn').endsWith('In') ? 1 : -1;
    if (mainO.kind === 'door' && (mainO.style ?? 'swing') === 'swing' && swingSide === inside) {
      mainChecked.push('latch-side');
      const uj = latch === 1 ? mainT.u1 : mainT.u0;
      const away = latch === 1 ? f.d : { x: -f.d.x, y: -f.d.y };
      const a = framePoint(f, uj, inside);
      // As deep as the space in front of the door goes (a short hall is the entrance
      // space's line, not this one's).
      const front = depthOff(
        sideAt(framePoint(f, (mainT.u0 + mainT.u1) / 2, inside), f.d, nIn, mainT.u1 - mainT.u0),
        LATCH.depth,
        obstacles,
      ).have;
      const deep = Math.max(0.1, Math.min(LATCH.depth, front - 0.02));
      const side: Side = {
        a,
        b: { x: a.x + nIn.x * deep, y: a.y + nIn.y * deep },
        n: away,
        width: deep,
      };
      const r = depthOff(side, LATCH.width, obstacles);
      if (r.have < LATCH.width - SLACK) {
        const by = pieceAt(r.by);
        main.push({
          key: `latch:${start}`,
          group: 'in',
          level: 'needed',
          kind: 'latch-side',
          need: LATCH.width,
          have: round(r.have),
          itemIds: by ? [by] : [],
          openingId: start ?? undefined,
          roomId: into,
          ...(by ? {} : { flat: true }),
          draw: { poly: zoneOf(side, LATCH.width) },
        });
      }
    }
  }

  // --- doors on the way ----------------------------------------------------------------------
  const doorFacts = new Map<string, AgeingIssue[]>();
  const doorInto = new Map<string, { into: string | undefined; door: boolean }>();
  const doorIssues = (d: DoorOn): AgeingIssue[] => {
    const t = throats[d.t] as Throat;
    const key = `${d.t}|${d.from}`;
    const known = doorFacts.get(key);
    if (known) return known;
    const out: AgeingIssue[] = [];
    const o = level.openings[t.openingId];
    const into = roomIdOf(t.rooms[d.from === 1 ? 1 : 0] ?? -1);
    if (o) {
      const clear = accessClearWidth(o);
      if (clear < N.door - 1e-9) {
        out.push({
          key: `door-width:${o.id}`,
          group: 'around',
          level: 'needed',
          kind: 'door-width',
          need: N.door,
          have: clear,
          itemIds: [],
          openingId: o.id,
          roomId: into,
          draw: { bar: doorBar(t) },
        });
      } else if (wheel && o.kind === 'door') {
        const need = table7(clear) ?? 1.2;
        const f = t.f;
        const c = framePoint(f, (t.u0 + t.u1) / 2, d.from);
        const n = { x: f.n.x * d.from, y: f.n.y * d.from };
        const sq = largestSquare(c, f.d, n, obstacles, need, [0], outside);
        if (sq.have < need - SLACK) {
          const poly = squareAt(c, f.d, n, need);
          // The smallest wider door the space here would do for.
          const alt =
            sq.have >= 1.1 - SLACK
              ? { clear: 0.85, need: 1.1 }
              : sq.have >= 1.0 - SLACK
                ? { clear: 0.9, need: 1.0 }
                : undefined;
          out.push({
            key: `door-space:${o.id}`,
            group: 'around',
            level: 'needed',
            kind: 'door-space',
            need,
            have: sq.have,
            itemIds: piecesIn(poly),
            openingId: o.id,
            roomId: into,
            clear,
            ...(alt && alt.clear > clear ? { alt } : {}),
            draw: { poly },
          });
        }
      }
    }
    doorFacts.set(key, out);
    doorInto.set(key, { into, door: o?.kind === 'door' });
    return out;
  };

  /** The doors a bare way goes through (not the main door), with the side it comes from. */
  const doorsOn = (cells: number[]): DoorOn[] => {
    const out: DoorOn[] = [];
    let prev = -1;
    let inT = -1;
    for (const k of cells) {
      const t = throatOf[k] as number;
      if (t >= 0 && t !== inT) {
        inT = t;
        if (t === startT) continue;
        const th = throats[t] as Throat;
        const p = cellCentre(g, prev >= 0 ? prev : k);
        const v = (p.x - th.f.a.x) * th.f.n.x + (p.y - th.f.a.y) * th.f.n.y;
        if (!out.some((x) => x.t === t)) out.push({ t, from: v >= 0 ? 1 : -1 });
      }
      if (t < 0) {
        inT = -1;
        prev = k;
      }
    }
    return out;
  };

  // --- routes ----------------------------------------------------------------------------------
  const routes = new Map<string, RouteFact>();
  const routeFact = (r: RoomInfo, need: number): RouteFact | null => {
    const bareCell = bare.first[r.idx] as number;
    if (!start || bareCell < 0) return null;
    const barePath = bare.search.path(bareCell);
    const bareKey = `${r.idx}|${need}`;
    const bareMeasures = bareMeasureCache.get(bare) ?? new Map<string, WayMeasure>();
    bareMeasureCache.set(bare, bareMeasures);
    const bm = bareMeasures.get(bareKey) ?? measureWay(pass, barePath, need, true);
    bareMeasures.set(bareKey, bm);
    const issues: AgeingIssue[] = [];
    const cm = Math.round(need * 100);
    const bareShort = bm.exact && bm.have < bm.need - SLACK && !bm.inThroat;
    if (bareShort && bm.pinch) {
      issues.push({
        key: `route:walls:${pinchKey(bm.pinch)}`,
        group: 'around',
        level: 'needed',
        kind: 'route',
        need: bm.need,
        have: round(Math.max(0, bm.have)),
        itemIds: [],
        flat: true,
        to: [r.id],
        draw: { bar: bm.pinch },
      });
    }
    const bareHave = bm.exact ? bm.have : Number.POSITIVE_INFINITY;
    const cell = pass.first[r.idx] as number;
    if (cell < 0) {
      const standing = standingPieces(pass, barePath);
      const blamed = standing.length ? standing : narrowingPieces(pass, barePath, need);
      issues.push({
        key: `route-closed:${[...blamed].sort().join(',')}:${cm}`,
        group: 'around',
        level: 'needed',
        kind: 'route',
        need,
        have: 0,
        itemIds: [...blamed].sort(),
        to: [r.id],
        draw: { bar: closedBarOf(pass, barePath) },
      });
    } else {
      const path = pass.search.path(cell);
      const m = measureWay(pass, path, need);
      if (m.have < m.need - SLACK && m.have < bareHave - 0.02 && m.pinch) {
        let blamed = m.by.map((i) => passPiece(pass, i)).filter((id): id is string => !!id);
        if (!blamed.length) blamed = narrowingPieces(pass, barePath, need);
        if (blamed.length) {
          blamed = [...new Set(blamed)].sort();
          issues.push({
            key: `route:${blamed.join(',')}:${cm}`,
            group: 'around',
            level: 'needed',
            kind: 'route',
            need: m.need,
            have: round(Math.max(0, m.have)),
            itemIds: blamed,
            to: [r.id],
            draw: { bar: m.pinch },
          });
        }
      }
    }
    const doors = doorsOn(barePath);
    const lastDoor = doors.at(-1);
    const last =
      lastDoor && (throats[lastDoor.t]?.rooms[lastDoor.from === 1 ? 1 : 0] ?? -1) === r.idx
        ? lastDoor
        : null;
    return { need, issues, doors, last };
  };
  const targets = new Set([...common, ...bedrooms, ...bathrooms]);
  for (const r of rooms) {
    if (!targets.has(r.id)) continue;
    const needs = new Set<number>([N.route]);
    if (bathrooms.includes(r.id)) needs.add(N.bathRoute);
    for (const need of needs) {
      const f = routeFact(r, need);
      if (f) routes.set(`${r.id}|${need}`, f);
    }
  }
  for (const f of routes.values()) for (const d of f.doors) doorIssues(d);
  const doors = doorFacts;

  // --- room to turn (wheelchair) -------------------------------------------------------------
  const turns = new Map<string, { turn: AgeingTurn; issue: AgeingIssue | null }>();
  const turnOf = new Map<string, string>();
  if (wheel) {
    const groups = roomGroups(bare);
    const wanted = new Set([...bedrooms, ...bathrooms, ...common]);
    const byGroup = new Map<number, number[]>();
    for (const r of rooms) {
      const gi = groups[r.idx] as number;
      byGroup.set(gi, [...(byGroup.get(gi) ?? []), r.idx]);
    }
    for (const [, members] of byGroup) {
      const ids = members.map((i) => rooms[i]?.id as string);
      if (!ids.some((id) => wanted.has(id))) continue;
      const set = new Set(members);
      const key = `turn:${[...ids].sort().join(',')}`;
      const t = turnCached(level, pass, set, key, fixed.walls, holes);
      if (!t) continue;
      const ok = t.have >= N.turn - SLACK;
      const roomIds = [...ids].sort();
      const turn: AgeingTurn = { key, roomIds, c: t.c, have: t.have, ok };
      // The room the circle is in names it.
      const inIdx = roomAtPoint(t.c);
      const named =
        inIdx >= 0 && set.has(inIdx) ? (rooms[inIdx]?.id as string) : (ids[0] as string);
      const issue: AgeingIssue | null = ok
        ? null
        : {
            key,
            group: 'around',
            level: 'recommended',
            kind: 'turn',
            need: N.turn,
            have: t.have,
            itemIds: t.blamed,
            roomId: named,
            roomIds,
            ...(t.blamed.length ? {} : { flat: true }),
            draw: { circle: { c: t.c, r: t.have / 2 } },
          };
      turns.set(key, { turn, issue });
      for (const id of ids) turnOf.set(id, key);
    }
  }

  // --- bathrooms -------------------------------------------------------------------------------
  const baths = new Map<string, BathFact>();
  for (const id of bathrooms) {
    const r = rooms[idxOf.get(id) as number] as RoomInfo;
    const issues: AgeingIssue[] = [];
    const checked: AgeingKind[] = [];
    // Its door: as the way in comes, else any into it from elsewhere.
    const viaRoute = routes.get(`${id}|${N.bathRoute}`)?.last;
    let door: DoorOn | null = viaRoute ?? null;
    if (!door) {
      const ti = throats
        .map((t, i) => ({ t, i }))
        .filter(
          ({ t }) => t.rooms.includes(r.idx) && !(t.rooms[0] === r.idx && t.rooms[1] === r.idx),
        )
        .sort((p, q) => (p.t.openingId < q.t.openingId ? -1 : 1))[0];
      if (ti) door = { t: ti.i, from: ti.t.rooms[0] === r.idx ? -1 : 1 };
    }
    const dt = door ? (throats[door.t] as Throat) : undefined;
    const dop = dt ? level.openings[dt.openingId] : undefined;
    if (dt && dop && dop.kind === 'door') {
      checked.push('door-in');
      const style = dop.style ?? 'swing';
      const swingSide = (dop.swing ?? 'leftIn').endsWith('In') ? 1 : -1;
      const bathSide = dt.rooms[0] === r.idx ? 1 : -1;
      if ((style === 'swing' || style === 'double') && swingSide === bathSide) {
        issues.push({
          key: `door-in:${dop.id}`,
          group: 'bathroom',
          level: 'recommended',
          kind: 'door-in',
          need: 0,
          have: 0,
          itemIds: [],
          openingId: dop.id,
          roomId: id,
          draw: { bar: doorBar(dt) },
        });
      }
    }
    const doorAt = dt ? framePoint(dt.f, (dt.u0 + dt.u1) / 2, 0) : null;
    const nearest = (asset: string) =>
      pass.pieces
        .filter((it) => it.assetId === asset && pieceRoom(it) === r.idx)
        .sort((p, q) => {
          if (!doorAt) return p.id < q.id ? -1 : 1;
          const dp = Math.hypot(p.position.x - doorAt.x, p.position.z - doorAt.y);
          const dq = Math.hypot(q.position.x - doorAt.x, q.position.z - doorAt.y);
          return dp - dq || (p.id < q.id ? -1 : 1);
        })[0];
    const toilet = nearest('toilet');
    const basin = nearest('vanity');
    let zones: BathFact['toilet'];
    if (toilet) {
      const fp = itemFootprint(toilet);
      const obs = without(toilet.id);
      const front = sideOf(fp, 'front');
      const mid = { x: (front.a.x + front.b.x) / 2, y: (front.a.y + front.b.y) / 2 };
      const along = {
        x: (front.b.x - front.a.x) / front.width,
        y: (front.b.y - front.a.y) / front.width,
      };
      // In front: a 1.00 m square to pull up beside it (wheelchair), else 0.60 m deep.
      checked.push('wc-front');
      let frontPoly: Vec2[];
      if (wheel) {
        const sq = largestSquare(
          mid,
          along,
          front.n,
          obs,
          N.wcFront,
          [0, 0.025, -0.025, 0.05, -0.05],
        );
        frontPoly = squareAt(sq.at, along, front.n, N.wcFront);
        if (sq.have < N.wcFront - SLACK) {
          issues.push({
            key: `wc-front:${toilet.id}`,
            group: 'bathroom',
            level: 'needed',
            kind: 'wc-front',
            need: N.wcFront,
            have: sq.have,
            itemIds: piecesIn(frontPoly, toilet.id),
            roomId: id,
            draw: { poly: frontPoly },
          });
        }
      } else {
        const r0 = depthOff(front, N.wcFront, obs, -0.005);
        frontPoly = zoneOf(front, N.wcFront);
        if (r0.have < N.wcFront - SLACK) {
          issues.push({
            key: `wc-front:${toilet.id}`,
            group: 'bathroom',
            level: 'recommended',
            kind: 'wc-front',
            need: N.wcFront,
            have: round(r0.have),
            itemIds: piecesIn(frontPoly, toilet.id),
            roomId: id,
            draw: { poly: frontPoly },
          });
        }
      }
      // Beside it: from its centre line, along its depth, on the better side.
      checked.push('wc-side');
      const [bl, br, fr, fl] = fp as [Vec2, Vec2, Vec2, Vec2];
      const back = { x: (bl.x + br.x) / 2, y: (bl.y + br.y) / 2 };
      const fore = { x: (fl.x + fr.x) / 2, y: (fl.y + fr.y) / 2 };
      const depth = Math.hypot(fore.x - back.x, fore.y - back.y) || 1;
      const sideFor = (to: Vec2): Side => {
        const len = Math.hypot(to.x - br.x, to.y - br.y) || 1;
        return {
          a: back,
          b: fore,
          n: { x: (to.x - br.x) / len, y: (to.y - br.y) / len },
          width: depth,
        };
      };
      const left = sideFor(bl);
      const right: Side = { ...left, n: { x: -left.n.x, y: -left.n.y } };
      const idxs = withoutIdx(toilet.id);
      const measureSide = (s: Side) => {
        const res = depthOff(s, N.wcSide, obs, 0.005);
        return { s, have: res.have, by: res.by >= 0 ? pieceAt(idxs[res.by] as number) : null };
      };
      const sides = [measureSide(left), measureSide(right)];
      const better = sides[0] && sides[1] && sides[1].have > sides[0].have ? sides[1] : sides[0];
      const sidePoly = zoneOf((better as { s: Side }).s, N.wcSide);
      if (better && better.have < N.wcSide - SLACK) {
        issues.push({
          key: `wc-side:${toilet.id}`,
          group: 'bathroom',
          level: wheel ? 'needed' : 'recommended',
          kind: 'wc-side',
          need: N.wcSide,
          have: round(better.have),
          itemIds: better.by ? [better.by] : [],
          roomId: id,
          ...(better.by ? {} : { flat: true }),
          draw: { poly: sidePoly },
        });
      }
      zones = { roomId: id, front: frontPoly, side: sidePoly };
      // From the door to the toilet and the basin: 1.00 m (wheelchair).
      if (wheel && dt) {
        checked.push('wc-way');
        // To the space just in front of each (the way there, not the space itself).
        const way = wayIn(pass, dt, r.idx, [
          zoneOf(front, WAY_TO),
          ...(basin ? [zoneOf(sideOf(itemFootprint(basin), 'front'), WAY_TO)] : []),
        ]);
        if (way && way.have < way.need - SLACK) {
          let blamed = way.by;
          blamed = [...new Set(blamed)].sort();
          issues.push({
            key: `wc-way:${id}`,
            group: 'bathroom',
            level: 'needed',
            kind: 'wc-way',
            need: N.wcWay,
            have: round(Math.max(0, way.have)),
            itemIds: blamed,
            roomId: id,
            ...(blamed.length ? {} : { flat: true }),
            draw: way.pinch ? { bar: way.pinch } : {},
          });
        }
      }
    }
    baths.set(id, { issues, noToilet: !toilet, checked, ...(zones ? { toilet: zones } : {}) });
  }

  // --- beds ------------------------------------------------------------------------------------
  const beds = new Map<string, AgeingIssue | null>();
  for (const id of bedrooms) {
    const idx = idxOf.get(id) as number;
    const bed = pass.pieces
      .filter((it) => BED(it) && pieceRoom(it) === idx)
      .sort((p, q) => {
        const a = itemSize(p);
        const b = itemSize(q);
        return b.w * b.d - a.w * a.d || (p.id < q.id ? -1 : 1);
      })[0];
    if (!bed) continue;
    const fp = itemFootprint(bed);
    const obs = without(bed.id);
    const idxs = withoutIdx(bed.id);
    const sides = (['left', 'right'] as const).map((side) => {
      const s = ruleSide(fp, side);
      const r = depthOff(s, N.bed, obs, -0.005);
      return { s, have: r.have, by: r.by >= 0 ? pieceAt(idxs[r.by] as number) : null };
    });
    const best = sides.reduce((p, q) => (q.have > p.have ? q : p));
    if (best.have >= N.bed - SLACK) {
      beds.set(id, null);
      continue;
    }
    const poly = zoneOf(best.s, N.bed);
    beds.set(id, {
      key: `bed:${bed.id}`,
      group: 'bedroom',
      level: 'recommended',
      kind: 'bed',
      need: N.bed,
      have: round(best.have),
      itemIds: [bed.id, ...(best.by && best.by !== bed.id ? [best.by] : [])],
      roomId: id,
      draw: { poly },
    });
  }

  // --- switches and sockets ----------------------------------------------------------------
  const low: string[] = [];
  const high: string[] = [];
  let reachChecked = false;
  for (const p of Object.values(level.points ?? {}).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (p.kind !== 'switch' && p.kind !== 'socket-single' && p.kind !== 'socket-double') continue;
    const pos = pointPosition(level, p);
    if (!pos?.normal || !pos.dir) continue;
    const ri = roomAtPoint({
      x: pos.at.x + pos.normal.x * 0.05,
      y: pos.at.y + pos.normal.y * 0.05,
    });
    if (ri >= 0 && rooms[ri]?.kind === 'kitchen') continue;
    // Behind a piece standing close in front of it: not readily reached, not checked.
    const half = ELEC_KINDS[p.kind].plate.w / 2;
    const at = (u: number, v: number) => ({
      x: pos.at.x + (pos.dir as Vec2).x * u + (pos.normal as Vec2).x * v,
      y: pos.at.y + (pos.dir as Vec2).y * u + (pos.normal as Vec2).y * v,
    });
    const front = [
      at(-half, 0.005),
      at(half, 0.005),
      at(half, POINT_REACH.front),
      at(-half, POINT_REACH.front),
    ];
    if (pass.fps.some((fp) => overlapDepth(front, fp) > 1e-4)) continue;
    reachChecked = true;
    if (pos.height < POINT_REACH.low - 1e-6) low.push(p.id);
    else if (pos.height > POINT_REACH.high + 1e-6) high.push(p.id);
  }
  const ptIds = [...low, ...high];
  const first = ptIds[0] ? level.points?.[ptIds[0]] : undefined;
  const reach: AgeingIssue | null = first
    ? {
        key: 'reach',
        group: 'points',
        level: 'needed',
        kind: 'reach',
        need: low.length ? POINT_REACH.low : POINT_REACH.high,
        have: first.wall?.height ?? 0,
        itemIds: [],
        pointIds: ptIds,
        draw: {},
      }
    : null;

  // --- their bathroom, found from where they sleep -------------------------------------------
  const autoBath = new Map<string, string | null>();
  const bathIdx = new Set(bathrooms.map((id) => idxOf.get(id) as number));
  const nearestBath = (seeds: number[], skip?: number): string | null => {
    if (!bathIdx.size) return null;
    const seen = new Uint8Array(g.n);
    const queue = seeds.filter((k) => !bare.solid[k]);
    for (const k of queue) seen[k] = 1;
    for (let h = 0; h < queue.length; h++) {
      const k = queue[h] as number;
      const r = room[k] as number;
      if (bathIdx.has(r) && r !== skip) return rooms[r]?.id ?? null;
      const i = k % g.nx;
      for (const m of [i > 0 ? k - 1 : -1, i < g.nx - 1 ? k + 1 : -1, k - g.nx, k + g.nx]) {
        if (m < 0 || m >= g.n || seen[m] || bare.solid[m]) continue;
        seen[m] = 1;
        queue.push(m);
      }
    }
    return null;
  };
  const byName = [...bathrooms].sort((a, b) => {
    const na = level.rooms[a]?.name ?? '';
    const nb = level.rooms[b]?.name ?? '';
    return na.localeCompare(nb) || (a < b ? -1 : 1);
  });
  autoBath.set('', bare.startCells.length ? nearestBath(bare.startCells) : (byName[0] ?? null));
  for (const id of bedrooms) {
    const idx = idxOf.get(id) as number;
    const own = throats.filter((t) => t.rooms.includes(idx) && t.rooms.some((q) => q !== idx));
    // A bathroom opening off the bedroom is theirs.
    const ensuite = own
      .map((t) => t.rooms.find((q) => q !== idx) ?? -1)
      .filter((q) => bathIdx.has(q))
      .map((q) => rooms[q]?.id as string)
      .sort()[0];
    if (ensuite) {
      autoBath.set(id, ensuite);
      continue;
    }
    const seeds = own.flatMap((t) => t.cells);
    autoBath.set(id, seeds.length ? nearestBath(seeds) : (autoBath.get('') ?? null));
  }

  return {
    profile,
    start,
    rooms,
    bedrooms,
    bathrooms,
    common,
    main,
    mainChecked,
    routes,
    doors,
    doorInto,
    turns,
    turnOf,
    baths,
    beds,
    reach,
    reachChecked,
    autoBath,
  };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** The bare plan's measures of each way (they don't change while furniture moves). */
const bareMeasureCache = new WeakMap<Bare, Map<string, WayMeasure>>();

/**
 * Turning spaces kept by the pieces near them: a drag in the living room doesn't redo the
 * bathroom's. Per bare plan, cleared when it grows large.
 */
const turnCache = new WeakMap<Bare, Map<string, ReturnType<typeof turnIn>>>();
function turnCached(
  level: Level,
  pass: FurnishedPass,
  group: Set<number>,
  key: string,
  walls: Vec2[][],
  holes: Vec2[][],
): ReturnType<typeof turnIn> {
  const bare = pass.bare;
  // The group's extent, a margin over, and the pieces reaching into it.
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const r of group) {
    const shape = roomShapes(level).get(bare.rooms[r]?.id ?? '');
    for (const p of shape?.outer ?? []) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
  }
  const sig: string[] = [];
  pass.fps.forEach((fp, i) => {
    const b = box(fp);
    if (b.x1 < x0 - 0.1 || b.x0 > x1 + 0.1 || b.y1 < y0 - 0.1 || b.y0 > y1 + 0.1) return;
    sig.push(
      `${pass.pieces[i]?.id}:${fp.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`).join(';')}`,
    );
  });
  const k = `${key}|${sig.join('|')}`;
  let m = turnCache.get(bare);
  if (!m) {
    m = new Map();
    turnCache.set(bare, m);
  }
  if (m.has(k)) return m.get(k) ?? null;
  if (m.size > 200) m.clear();
  const t = turnIn(level, pass, group, walls, holes);
  m.set(k, t);
  return t;
}

/**
 * The largest circle clear of every obstacle in a group of rooms: on a raster of only those
 * rooms (so it never bulges out through a doorway), then refined on the polygons (walls with
 * their doorways closed, columns, the pieces) to about a millimetre.
 */
function turnIn(
  level: Level,
  pass: FurnishedPass,
  group: Set<number>,
  walls: Vec2[][],
  holes: Vec2[][],
): { c: Vec2; have: number; blamed: string[] } | null {
  const bare = pass.bare;
  const { g, room } = bare;
  let i0 = g.nx;
  let i1 = -1;
  let j0 = g.ny;
  let j1 = -1;
  for (let k = 0; k < g.n; k++) {
    if (!group.has(room[k] as number)) continue;
    const i = k % g.nx;
    const j = Math.floor(k / g.nx);
    if (i < i0) i0 = i;
    if (i > i1) i1 = i;
    if (j < j0) j0 = j;
    if (j > j1) j1 = j;
  }
  if (i1 < 0) return null;
  i0 -= 1;
  j0 -= 1;
  const nx = i1 - i0 + 2;
  const ny = j1 - j0 + 2;
  const sub: Grid = { c: g.c, nx, ny, x0: g.x0 + i0 * g.c, y0: g.y0 + j0 * g.c, n: nx * ny };
  const solid = new Uint8Array(sub.n);
  const inGroup = (i: number, j: number) => {
    if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return false;
    const k = j * g.nx + i;
    return group.has(room[k] as number) && !pass.solid[k];
  };
  for (let sj = 0; sj < ny; sj++) {
    for (let si = 0; si < nx; si++) {
      if (!inGroup(i0 + si, j0 + sj)) solid[sj * nx + si] = 1;
    }
  }
  distanceField(sub, solid, turnBuffers);
  // The few best cells, apart from each other.
  const d2 = turnBuffers.d2;
  let max = -1;
  for (let k = 0; k < sub.n; k++) if (!solid[k] && (d2[k] as number) > max) max = d2[k] as number;
  // No free floor at all (filled with furniture): the circle is drawn at the room's middle.
  if (max < 0) {
    return { c: { x: sub.x0 + (nx * g.c) / 2, y: sub.y0 + (ny * g.c) / 2 }, have: 0, blamed: [] };
  }
  // Only cells near the best are candidates (sorting a whole living room is slow).
  const floor = Math.max(0, Math.sqrt(max) - 2) ** 2;
  const order: number[] = [];
  for (let k = 0; k < sub.n; k++) if (!solid[k] && (d2[k] as number) >= floor) order.push(k);
  order.sort((p, q) => (d2[q] as number) - (d2[p] as number) || p - q);
  // The best few cells (within two cells of the best), apart from each other.
  const top = Math.sqrt(d2[order[0] as number] as number) * g.c;
  const picks: { p: Vec2; r: number }[] = [];
  for (const k of order) {
    const r = Math.sqrt(d2[k] as number) * g.c;
    if (r < top - 2 * g.c) break;
    const p = cellCentre(sub, k);
    if (picks.some((q) => Math.hypot(q.p.x - p.x, q.p.y - p.y) < 0.3)) continue;
    picks.push({ p, r });
    if (picks.length >= 3) break;
  }

  // Exact: walls and hubs (doorways closed), columns, every blocking piece, and room
  // boundaries out of the group (to rooms not open to it, or to outside).
  const bx0 = sub.x0;
  const by0 = sub.y0;
  const bx1 = sub.x0 + nx * g.c;
  const by1 = sub.y0 + ny * g.c;
  const nearBox = (poly: Vec2[]) =>
    poly.some((p) => p.x >= bx0 - 2 && p.x <= bx1 + 2 && p.y >= by0 - 2 && p.y <= by1 + 2);
  const edges: Vec2[][] = [];
  const roomAt = (p: Vec2) => {
    const k = cellAt(g, p);
    return k >= 0 ? (room[k] as number) : -1;
  };
  for (const w of Object.values(level.walls)) {
    if (!isBoundary(w)) continue;
    const a = level.vertices[w.a];
    const b = level.vertices[w.b];
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    const s1 = roomAt({ x: m.x + n.x * 0.06, y: m.y + n.y * 0.06 });
    const s2 = roomAt({ x: m.x - n.x * 0.06, y: m.y - n.y * 0.06 });
    if (group.has(s1) && group.has(s2)) continue;
    if (!group.has(s1) && !group.has(s2)) continue;
    edges.push([
      { x: a.x, y: a.y },
      { x: b.x, y: b.y },
    ]);
  }
  const fixedPolys = [...walls, ...holes, ...edges].filter(nearBox);
  const pieceIdx = pass.fps.map((_, i) => i).filter((i) => nearBox(pass.fps[i] as Vec2[]));
  const all = [...fixedPolys, ...pieceIdx.map((i) => pass.fps[i] as Vec2[])];
  let local: Vec2[][] = all;
  const clearAt = (p: Vec2): number => {
    const k = cellAt(g, p);
    if (k < 0 || !group.has(room[k] as number)) return -1;
    let d = Number.POSITIVE_INFINITY;
    for (const poly of local) d = Math.min(d, nearestOnPolygon(p, poly).d);
    return d;
  };
  let best = { c: (picks[0] as { p: Vec2 }).p, d: -1 };
  const h = Math.SQRT1_2;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [h, h],
    [-h, h],
    [h, -h],
    [-h, -h],
  ] as const;
  for (const pick of picks) {
    // Only what is near enough to matter (the search moves a few centimetres).
    const reach = pick.r + 0.3;
    local = all.filter((poly) => {
      const bx = box(poly);
      const dx = Math.max(bx.x0 - pick.p.x, 0, pick.p.x - bx.x1);
      const dy = Math.max(bx.y0 - pick.p.y, 0, pick.p.y - bx.y1);
      return dx * dx + dy * dy <= reach * reach;
    });
    let p = pick.p;
    let d = clearAt(p);
    // Pattern search: the best of eight steps, halving the step when none is better.
    let step = g.c / 2;
    for (let it = 0; it < 80 && step > 0.0008; it++) {
      let next = p;
      let dn = d;
      for (const [dx, dy] of dirs) {
        const q = { x: p.x + dx * step, y: p.y + dy * step };
        const dq = clearAt(q);
        if (dq > dn + 1e-7) {
          next = q;
          dn = dq;
        }
      }
      if (next === p) step /= 2;
      else {
        p = next;
        d = dn;
      }
    }
    if (d > best.d) best = { c: p, d };
  }
  if (best.d < 0) return { c: best.c, have: 0, blamed: [] };
  const blamed = pieceIdx
    .map((i) => ({ i, d: nearestOnPolygon(best.c, pass.fps[i] as Vec2[]).d }))
    .filter((x) => x.d <= best.d + 0.02)
    .sort((p, q) => p.d - q.d)
    .slice(0, 2)
    .map((x) => pass.pieces[x.i]?.id as string);
  return { c: best.c, have: round(2 * best.d), blamed };
}

/**
 * The widest way inside a bathroom from its door to each target area (the toilet's front
 * square, the basin's front), each measured up to where it reaches the area: the narrowest.
 */
function wayIn(
  pass: FurnishedPass,
  door: Throat,
  roomIdx: number,
  targets: Vec2[][],
): { have: number; need: number; pinch: [Vec2, Vec2] | null; by: string[] } | null {
  const { g, room } = pass.bare;
  const seeds = door.cells.filter((k) => room[k] === roomIdx && (pass.width[k] as number) >= 0);
  if (!seeds.length) return null;
  const s = waySearch;
  widestWays(g, pass.width, seeds, null, s, { wide: 1.5, step: 0.01, room, only: roomIdx });
  let worst: { have: number; need: number; pinch: [Vec2, Vec2] | null; by: string[] } | null = null;
  for (const poly of targets) {
    const cells: number[] = [];
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - g.x0) / g.c));
    const i1 = Math.min(g.nx - 1, Math.floor((Math.max(...xs) - g.x0) / g.c));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - g.y0) / g.c));
    const j1 = Math.min(g.ny - 1, Math.floor((Math.max(...ys) - g.y0) / g.c));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * g.nx + i;
        if (room[k] !== roomIdx || (pass.width[k] as number) < 0) continue;
        if (insideConvex(cellCentre(g, k), poly)) cells.push(k);
      }
    }
    const inZone = new Set(cells);
    let best = -1;
    let bw = -1;
    for (const k of cells) {
      const w = s.width(k);
      if (w > bw) {
        bw = w;
        best = k;
      }
    }
    let r: { have: number; need: number; pinch: [Vec2, Vec2] | null; by: string[] };
    if (best < 0) {
      r = { have: 0, need: 1.0, pinch: null, by: [] };
    } else {
      const path = s.path(best);
      const cut = path.findIndex((k) => inZone.has(k));
      const way = path.slice(0, cut < 0 ? path.length : cut + 1);
      const m = measureWay(pass, way, 1.0);
      const by = m.by.map((i) => passPiece(pass, i)).filter((id): id is string => !!id);
      r = { have: m.have, need: m.need, pinch: m.pinch, by };
    }
    if (!worst || r.have - r.need < worst.have - worst.need) worst = r;
  }
  return worst;
}
const waySearch = new Search(0);

function insideConvex(p: Vec2, poly: readonly Vec2[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Vec2;
    const b = poly[(i + 1) % poly.length] as Vec2;
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(c) < 1e-12) continue;
    const s = c > 0 ? 1 : -1;
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

// --- the report --------------------------------------------------------------------------------

const reportCache = new WeakMap<Facts, Map<string, AgeingReport>>();

/**
 * The ageing check for a level and the person's choice: the issues by group (getting in,
 * getting around, their bedroom, their bathroom, switches and sockets), worst first; what was
 * checked and is fine; and, before a bedroom is chosen, each bedroom with what it would add.
 */
export function ageingReport(level: Level, choice: AgeingChoice): AgeingReport {
  const facts = ageingFacts(level, choice.profile);
  const ck = `${choice.bedroomId ?? ''}|${choice.bathroomId ?? ''}`;
  let byChoice = reportCache.get(facts);
  const hit = byChoice?.get(ck);
  if (hit) return hit;
  // Chosen, or the only one there is.
  const bedroom =
    choice.bedroomId && facts.bedrooms.includes(choice.bedroomId)
      ? choice.bedroomId
      : facts.bedrooms.length === 1
        ? facts.bedrooms[0]
        : undefined;
  const r = compose(facts, choice, bedroom);
  // Each bedroom's count, as if chosen.
  if (!bedroom) {
    r.bedrooms = facts.bedrooms.map((id) => ({
      roomId: id,
      count: compose(facts, { ...choice, bedroomId: id }, id).issues.filter(
        (i) => i.group === 'bedroom',
      ).length,
    }));
  }
  if (!byChoice) {
    byChoice = new Map();
    reportCache.set(facts, byChoice);
  }
  byChoice.set(ck, r);
  return r;
}

function compose(facts: Facts, choice: AgeingChoice, bedroom: string | undefined): AgeingReport {
  const N = AGEING_NEEDS[facts.profile];
  const wheel = facts.profile === 'wheelchair';
  const chosenBath =
    choice.bathroomId && facts.bathrooms.includes(choice.bathroomId)
      ? choice.bathroomId
      : undefined;
  const bathroom = chosenBath ?? facts.autoBath.get(bedroom ?? '') ?? undefined;
  const issues: AgeingIssue[] = [];
  const checked = new Map<AgeingGroup, Set<AgeingKind>>();
  const check = (g: AgeingGroup, k: AgeingKind) => {
    const s = checked.get(g) ?? new Set();
    s.add(k);
    checked.set(g, s);
  };
  const isBedroom = (id: string | undefined) => !!id && facts.bedrooms.includes(id);
  /** Unchosen bedrooms: their own lines are counted, not listed. */
  const hidden = (id: string | undefined) => !bedroom && isBedroom(id) && id !== bathroom;
  const groupOf = (into: string | undefined): AgeingGroup | null => {
    if (into && into === bathroom) return 'bathroom';
    if (into && into === bedroom) return 'bedroom';
    if (hidden(into)) return null;
    return 'around';
  };

  // Getting in.
  for (const k of facts.mainChecked) check('in', k);
  issues.push(...facts.main);

  // The rooms they go to, and the way to each.
  const targets = [
    ...facts.common,
    ...facts.bathrooms,
    ...(bedroom ? [bedroom] : facts.bedrooms),
  ].filter((id, i, all) => all.indexOf(id) === i);
  const routeIssues = new Map<string, AgeingIssue>();
  const doorSeen = new Map<string, AgeingIssue[]>();
  const bathDoors = new Set<string>();
  for (const id of targets) {
    const need = id === bathroom ? N.bathRoute : N.route;
    const f = facts.routes.get(`${id}|${need}`);
    if (!f) continue;
    const g = groupOf(id);
    if (g) check(g, 'route');
    for (const i of f.issues) {
      const k = i.key;
      const was = routeIssues.get(k);
      if (!was) routeIssues.set(k, { ...i, to: [id] });
      else {
        const to = [...new Set([...(was.to ?? []), id])];
        routeIssues.set(k, {
          ...(i.need > was.need || (i.need === was.need && i.have < was.have) ? i : was),
          to,
        });
      }
    }
    for (const d of f.doors) {
      const key = `${d.t}`;
      if (id === bathroom) bathDoors.add(key);
      if (!doorSeen.has(key)) {
        doorSeen.set(key, facts.doors.get(`${d.t}|${d.from}`) ?? []);
        const meta = facts.doorInto.get(`${d.t}|${d.from}`);
        const g = groupOf(meta?.into) ?? (id === bathroom ? 'around' : null);
        if (g) {
          check(g, 'door-width');
          if (wheel && meta?.door) check(g, 'door-space');
        }
      }
    }
  }
  for (const [key, list] of doorSeen) {
    for (const i of list) {
      // The door into their bathroom or bedroom is theirs; doors on the way to their
      // bathroom are part of getting around even through an unchosen bedroom.
      let g = groupOf(i.roomId);
      if (!g && bathDoors.has(key)) g = 'around';
      if (!g) continue;
      issues.push({ ...i, group: g });
    }
  }
  for (const i of routeIssues.values()) {
    const to = i.to ?? [];
    const g: AgeingGroup | null =
      to.length && to.every((t) => t === bathroom)
        ? 'bathroom'
        : to.length && to.every((t) => t === bedroom)
          ? 'bedroom'
          : to.length && to.every((t) => hidden(t))
            ? null
            : 'around';
    if (g) issues.push({ ...i, group: g });
  }

  // Room to turn.
  const turns: AgeingTurn[] = [];
  if (wheel) {
    const keys = new Set<string>();
    for (const id of [
      ...facts.common,
      ...(bedroom ? [bedroom] : []),
      ...(bathroom ? [bathroom] : []),
    ]) {
      const k = facts.turnOf.get(id);
      if (k) keys.add(k);
    }
    for (const k of [...keys].sort()) {
      const t = facts.turns.get(k);
      if (!t) continue;
      turns.push(t.turn);
      const g: AgeingGroup =
        bathroom && t.turn.roomIds.includes(bathroom)
          ? 'bathroom'
          : bedroom && t.turn.roomIds.includes(bedroom)
            ? 'bedroom'
            : 'around';
      check(g, 'turn');
      if (t.issue) issues.push({ ...t.issue, group: g });
    }
  }

  // Their bedroom: the bed.
  if (bedroom && facts.beds.has(bedroom)) {
    check('bedroom', 'bed');
    const b = facts.beds.get(bedroom);
    if (b) issues.push(b);
  }

  // Their bathroom.
  const notes: AgeingReport['notes'] = [];
  if (!facts.start) notes.push('no-main-door');
  let toilet: AgeingReport['toilet'];
  if (!facts.bathrooms.length) notes.push('name-bathroom');
  else if (bathroom) {
    const b = facts.baths.get(bathroom);
    if (b) {
      for (const k of b.checked) check('bathroom', k);
      issues.push(...b.issues);
      if (b.noToilet) notes.push('add-toilet');
      toilet = b.toilet;
    }
  }

  // Switches and sockets.
  if (facts.reachChecked) check('points', 'reach');
  if (facts.reach) issues.push(facts.reach);

  // In order: by group, needed first, then by kind and shortfall.
  const gi = (g: AgeingGroup) => AGEING_GROUPS.indexOf(g);
  issues.sort(
    (p, q) =>
      gi(p.group) - gi(q.group) ||
      Number(p.level === 'recommended') - Number(q.level === 'recommended') ||
      KIND_ORDER.indexOf(p.kind) - KIND_ORDER.indexOf(q.kind) ||
      q.need - q.have - (p.need - p.have) ||
      (p.key < q.key ? -1 : p.key > q.key ? 1 : 0),
  );
  const passed: AgeingReport['passed'] = [];
  for (const g of AGEING_GROUPS) {
    for (const k of KIND_ORDER) {
      if (!checked.get(g)?.has(k)) continue;
      if (issues.some((i) => i.group === g && i.kind === k)) continue;
      passed.push({ group: g, kind: k });
    }
  }
  return {
    profile: facts.profile,
    status: !facts.start ? 'no-main-door' : issues.length ? 'issues' : 'ok',
    start: facts.start,
    ...(bedroom ? { bedroom } : {}),
    ...(bathroom ? { bathroom } : {}),
    bathroomAuto: !chosenBath,
    bedrooms: [],
    bedroomIds: facts.bedrooms,
    bathrooms: facts.bathrooms,
    issues,
    passed,
    notes,
    turns,
    ...(toilet ? { toilet } : {}),
  };
}

/**
 * The walkway pinches the ageing check draws itself (the same pieces on the way to the same
 * rooms): `${itemId}|${pinchKey}` of each walkway issue to leave undrawn.
 */
export function ageingSupersedes(walk: WalkwayReport, age: AgeingReport): Set<string> {
  const out = new Set<string>();
  const mine = age.issues.filter((i) => i.kind === 'route' && !i.flat && i.itemIds.length);
  for (const w of walk.issues) {
    if (w.route !== 'circulation') continue;
    const rooms = new Set(w.to.map((t) => t.roomId));
    if (mine.some((i) => i.itemIds.includes(w.itemId) && (i.to ?? []).some((t) => rooms.has(t)))) {
      out.add(`${w.itemId}|${pinchKey(w.pinch)}`);
    }
  }
  return out;
}

/**
 * What a browser remembers of the check for a project (slice 1 keeps it per browser, not in
 * the project): the profile (off by default), the rooms chosen, the flat type for EASE.
 */
export const AgeingSetting = z.object({
  // Field by field: one unreadable value drops only itself.
  profile: z.enum(['off', 'walking', 'wheelchair']).catch('off'),
  bedroomId: z.string().optional().catch(undefined),
  bathroomId: z.string().optional().catch(undefined),
  flatType: z.enum(['1-3', '4', '5', 'exec', 'none']).optional().catch(undefined),
});
export type AgeingSetting = z.infer<typeof AgeingSetting>;

/** A stored setting, or Off for anything missing or unreadable. */
export function parseAgeingSetting(raw: string | null | undefined): AgeingSetting {
  if (!raw) return { profile: 'off' };
  try {
    const r = AgeingSetting.safeParse(JSON.parse(raw));
    return r.success ? r.data : { profile: 'off' };
  } catch {
    return { profile: 'off' };
  }
}
