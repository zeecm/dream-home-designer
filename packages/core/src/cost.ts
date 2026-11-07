import { ELEC_KINDS, electricalChanges, pointName, pointRoom, trunkingMetres } from './electrical';
import { finish } from './finishes';
import { furnitureKind, itemSize } from './furniture';
import { pointInPolygon } from './geometry';
import { AFTER_SUFFIX } from './levels';
import type { DoorStyle } from './plan';
import { type RenovationChange, renovationChanges, wallBefore } from './renovation';
import { roomArea, roomShape } from './rooms';
import type { ElecKind, ElecPoint, Item, Level, Project } from './schema';
import { SHELTER_ROOM } from './structural';

/**
 * A rough renovation estimate from typical Singapore prices (2025–2026): what the
 * renovation changes (walls hacked and built, doors and windows, floors), repainting, and
 * built-in carpentry by the foot run. Not a quote. Rates are low–high in S$; the person can
 * change them. Spec: docs/specs/carpentry-cost.md.
 */
export interface Rate {
  low: number;
  high: number;
}

export type FloorKind = 'vinyl' | 'timber' | 'tile' | 'marble' | 'concrete' | 'carpet';
export type Carpentry = 'wardrobe' | 'tall' | 'low' | 'base' | 'wall';

export interface Rates {
  hack: Rate;
  debris: Rate;
  newWall: Rate;
  halfWall: Rate;
  glass: Rate;
  glassAbove: Rate;
  cutOpening: Rate;
  closeOpening: Rate;
  door: Record<DoorStyle, Rate>;
  glassLeaves: Rate;
  window: Rate;
  floor: Record<FloorKind, Rate>;
  paint: Rate;
  carpentry: Record<Carpentry, Rate>;
  countertop: Rate;
  /** Electrical points: a new one, one moved, one taken out; aircon trunking per metre. */
  elecNew: Record<ElecKind, Rate>;
  elecMove: Record<ElecKind, Rate>;
  elecRemove: Rate;
  trunking: Rate;
  painting: boolean;
  debrisOn: boolean;
  contingency: boolean;
}

const r = (low: number, high: number): Rate => ({ low, high });

/** Typical rates (see the spec for sources; the rest is common practice). */
export const TYPICAL_RATES: Rates = {
  hack: r(130, 200),
  debris: r(400, 800),
  newWall: r(250, 400),
  halfWall: r(150, 300),
  glass: r(700, 1200),
  glassAbove: r(350, 600),
  cutOpening: r(300, 600),
  closeOpening: r(250, 500),
  door: {
    swing: r(400, 700),
    double: r(700, 1200),
    sliding: r(600, 1200),
    pocket: r(1000, 1800),
    bifold: r(900, 1600),
    folding: r(1500, 3000),
  },
  glassLeaves: r(300, 600),
  window: r(600, 1200),
  floor: {
    vinyl: r(45, 85),
    timber: r(110, 220),
    tile: r(90, 160),
    marble: r(215, 375),
    concrete: r(110, 200),
    carpet: r(40, 90),
  },
  paint: r(4.5, 7),
  carpentry: {
    wardrobe: r(200, 350),
    tall: r(180, 300),
    low: r(100, 200),
    base: r(110, 180),
    wall: r(90, 150),
  },
  countertop: r(75, 180),
  elecNew: {
    'socket-double': r(80, 150),
    'socket-single': r(65, 120),
    switch: r(40, 80),
    light: r(50, 100),
    fan: r(70, 120),
    data: r(80, 150),
    tv: r(80, 150),
    aircon: r(150, 250),
    compressor: r(0, 0),
    'water-heater': r(120, 200),
    cooker: r(150, 250),
    doorbell: r(60, 120),
  },
  elecMove: {
    'socket-double': r(60, 120),
    'socket-single': r(60, 120),
    switch: r(40, 70),
    light: r(40, 80),
    fan: r(40, 80),
    data: r(60, 110),
    tv: r(60, 110),
    aircon: r(150, 250),
    compressor: r(0, 0),
    'water-heater': r(80, 150),
    cooker: r(100, 180),
    doorbell: r(40, 80),
  },
  elecRemove: r(20, 40),
  trunking: r(30, 50),
  painting: true,
  debrisOn: true,
  contingency: true,
};

export type CostGroup =
  | 'Building'
  | 'Doors and windows'
  | 'Floors'
  | 'Painting'
  | 'Carpentry'
  | 'Electrical'
  | 'Contingency';

export interface CostLine {
  group: CostGroup;
  label: string;
  /** Where: the rooms either side, or the room. */
  place: string;
  qty: number;
  unit: 'm' | 'm²' | 'ft run' | 'each' | 'lot';
  low: number;
  high: number;
  /** An electrical point line: the kind it counts. */
  point?: ElecKind;
  /**
   * The level the line is on, and its name as the estimate shows it (never blank, unique):
   * none for what belongs to the whole home (debris, contingency).
   */
  levelId?: string;
  levelName?: string;
}

/** A level's part of the estimate: the sum of its lines. */
export interface LevelCost {
  id: string;
  name: string;
  low: number;
  high: number;
}

export interface CostEstimate {
  lines: CostLine[];
  low: number;
  high: number;
  /** Whether a renovation was priced (without one, only painting and carpentry). */
  renovation: boolean;
  /** Each level priced, in the project's order, with the sum of its lines. */
  levels: LevelCost[];
  /** Levels left out, by name: a renovation with no plan for them. */
  unpriced: string[];
}

/** A carpenter's foot run: the width in feet, to the nearest foot, at least one. */
export const footRun = (width: number) => Math.max(1, Math.round(width / 0.3048));

const to10 = (v: number) => Math.round(v / 10) * 10;
const to100 = (v: number) => Math.round(v / 100) * 100;

/** Rooms not painted (outdoors), and rooms tiled to the ceiling (painted overhead only). */
const OUTDOOR = /ledge|balcony|outside|yard|planter/i;
const TILED = /bath|\bwc\b|toilet|shower|kitchen/i;

/** A floor finish's kind for pricing, from its id. */
function floorKind(id: string): FloorKind | null {
  if (id.startsWith('wood')) return 'timber';
  if (id.startsWith('vinyl')) return 'vinyl';
  if (id.startsWith('tile')) return 'tile';
  if (id === 'marble') return 'marble';
  if (id === 'concrete') return 'concrete';
  if (id.startsWith('carpet')) return 'carpet';
  return null;
}

const placeOf = (c: { rooms: string[]; outside: boolean }) => {
  const rooms = [...new Set(c.rooms)].join(' / ');
  return c.outside ? (rooms ? `${rooms}, outside wall` : 'Outside wall') : rooms || 'Flat';
};

function line(
  group: CostGroup,
  label: string,
  place: string,
  qty: number,
  unit: CostLine['unit'],
  rate: Rate,
): CostLine {
  return { group, label, place, qty, unit, low: to10(qty * rate.low), high: to10(qty * rate.high) };
}

const DOOR_NAMES: Record<DoorStyle, string> = {
  swing: 'Swing door',
  double: 'Double door',
  sliding: 'Sliding door',
  pocket: 'Pocket door',
  bifold: 'Bi-fold door',
  folding: 'Folding partition',
};

/** A built-in piece's carpentry kind, if it is one. */
export function carpentryOf(item: Item): Carpentry | undefined {
  return furnitureKind(item.assetId)?.carpentry;
}

/** A built-in piece priced: its foot runs and low–high cost (with the countertop, for a base run). */
export function carpentryCost(
  item: Item,
  rates: Rates,
): { feet: number; low: number; high: number } | null {
  const c = carpentryOf(item);
  if (!c) return null;
  const feet = footRun(itemSize(item).w);
  const rate = rates.carpentry[c];
  const top = c === 'base' ? rates.countertop : { low: 0, high: 0 };
  return {
    feet,
    low: to10(feet * (rate.low + top.low)),
    high: to10(feet * (rate.high + top.high)),
  };
}

const CARPENTRY_NAMES: Record<Carpentry, string> = {
  wardrobe: 'Wardrobe',
  tall: 'Tall cabinet',
  low: 'Low cabinet',
  base: 'Kitchen base cabinets',
  wall: 'Kitchen wall cabinets',
};

/** The room an item stands in, by name. */
function roomOfItem(level: Level, item: Item): string {
  const p = { x: item.position.x, y: item.position.z };
  const room = Object.values(level.rooms).find((r) => {
    const sh = roomShape(level, r);
    return pointInPolygon(p, sh.outer) && !sh.holes.some((h) => pointInPolygon(p, h));
  });
  return room?.name ?? 'Flat';
}

/** One level's lines by kind, without debris and contingency (which are the whole home's). */
export interface LevelParts {
  /** What the renovation changes: building, doors and windows, floors. */
  changes: CostLine[];
  painting: CostLine[];
  carpentry: CostLine[];
  electrical: CostLine[];
}

/**
 * A level's lines: for it as it is (`before`) and its renovation (`after`), or, with no
 * renovation, painting and the carpentry drawn.
 */
export function levelParts(before: Level, after: Level | undefined, rates: Rates): LevelParts {
  const changes: CostLine[] = [];
  const shown = after ?? before;
  if (after) {
    const all = renovationChanges(before, after);
    // A wall cut down to a half wall is hacked above; what's left isn't built anew.
    const hacked = all.filter((c) => c.kind === 'hack');
    const cutDown = (c: RenovationChange) =>
      c.kind === 'build' &&
      (c.what === 'half' || c.what === 'half-glass') &&
      hacked.some(
        (h) =>
          h.kind === 'hack' && placeOf(h) === placeOf(c) && Math.abs(h.length - c.length) < 0.05,
      );
    for (const c of all) {
      const priced = changeLines(c, before, after, rates);
      changes.push(...(cutDown(c) ? priced.filter((l) => l.label !== 'Half wall') : priced));
    }
  }

  // Repainting every room: walls (perimeter × ceiling) and ceiling.
  const painting: CostLine[] = [];
  if (rates.painting) {
    const rooms = Object.values(shown.rooms).sort((a, b) => a.name.localeCompare(b.name));
    for (const room of rooms) {
      // Not outdoors, nor the shelter (its walls stay as built); tiled rooms: the ceiling.
      if (OUTDOOR.test(room.name) || SHELTER_ROOM.test(room.name)) continue;
      const tiled = TILED.test(room.name);
      const outer = roomShape(shown, room).outer;
      let perimeter = 0;
      for (let i = 0; i < outer.length; i++) {
        const a = outer[i];
        const b = outer[(i + 1) % outer.length];
        if (a && b) perimeter += Math.hypot(b.x - a.x, b.y - a.y);
      }
      const height = room.ceilingHeight ?? shown.ceilingHeight;
      const walls = tiled ? 0 : perimeter * height;
      const area = Math.round((walls + roomArea(shown, room)) * 10) / 10;
      const what = tiled ? 'Repaint ceiling' : 'Repaint walls and ceiling';
      if (area > 0) painting.push(line('Painting', what, room.name, area, 'm²', rates.paint));
    }
  }

  // Built-ins: new or resized in the renovation; with none, all of them. A carpenter
  // measures a run, not its modules: widths add up per room and kind, then round to feet.
  const carpentry: CostLine[] = [];
  const runs = new Map<string, { kind: Carpentry; label: string; where: string; width: number }>();
  for (const it of Object.values(shown.items)) {
    const c = carpentryOf(it);
    if (!c) continue;
    if (after) {
      const was = before.items[it.id];
      if (was && was.assetId === it.assetId && Math.abs(itemSize(was).w - itemSize(it).w) < 0.005)
        continue;
    }
    const where = roomOfItem(shown, it);
    // Kitchen modules make one run; other pieces go by their own name.
    const label =
      c === 'base' || c === 'wall'
        ? CARPENTRY_NAMES[c]
        : (furnitureKind(it.assetId)?.name ?? CARPENTRY_NAMES[c]);
    const k = `${where}|${c}|${label}`;
    const run = runs.get(k) ?? { kind: c, label, where, width: 0 };
    run.width += itemSize(it).w;
    runs.set(k, run);
  }
  for (const { kind, label, where, width } of runs.values()) {
    const feet = footRun(width);
    carpentry.push(line('Carpentry', label, where, feet, 'ft run', rates.carpentry[kind]));
    if (kind === 'base')
      carpentry.push(line('Carpentry', 'Countertop', where, feet, 'ft run', rates.countertop));
  }

  return { changes, painting, carpentry, electrical: electricalLines(before, after, rates) };
}

/** A level priced: its id, the name the estimate shows, and its lines. */
interface PricedLevel {
  id: string;
  name: string;
  parts: LevelParts;
}

/**
 * Every level's lines put together in the order one level has them: the renovation's
 * changes, debris once for the home, then painting, carpentry and electrical, each level by
 * level, then contingency over everything. In a home of two or more levels (`many`, priced
 * or not) a line's place starts with its level's name ("Upper · Bedroom", or just "Upper" for
 * a line in no room).
 */
function assemble(
  priced: PricedLevel[],
  rates: Rates,
  renovation: boolean,
  unpriced: string[],
  many: boolean,
): CostEstimate {
  const tagged = (p: PricedLevel, key: keyof LevelParts) =>
    p.parts[key].map((l): CostLine => {
      const place = !many
        ? l.place
        : !l.place || l.place === 'Flat'
          ? p.name
          : `${p.name} · ${l.place}`;
      return { ...l, place, levelId: p.id, levelName: p.name };
    });
  const lines: CostLine[] = priced.flatMap((p) => tagged(p, 'changes'));
  if (rates.debrisOn && lines.some((l) => /^(Hack|Cut|Widen)/.test(l.label))) {
    // The whole home's, in a home of levels; "Flat" as ever for one.
    const place = many ? 'Whole home' : 'Flat';
    lines.push(line('Building', 'Debris disposal', place, 1, 'lot', rates.debris));
  }
  for (const key of ['painting', 'carpentry', 'electrical'] as const) {
    lines.push(...priced.flatMap((p) => tagged(p, key)));
  }
  const sum = (ls: CostLine[], k: 'low' | 'high') => ls.reduce((t, l) => t + l[k], 0);
  if (rates.contingency && lines.length) {
    lines.push({
      group: 'Contingency',
      label: 'Contingency (10%)',
      place: '',
      qty: 1,
      unit: 'lot',
      low: to10(sum(lines, 'low') * 0.1),
      high: to10(sum(lines, 'high') * 0.1),
    });
  }
  const levels = priced.map((p) => {
    const own = lines.filter((l) => l.levelId === p.id);
    return { id: p.id, name: p.name, low: sum(own, 'low'), high: sum(own, 'high') };
  });
  return {
    lines,
    low: to100(sum(lines, 'low')),
    high: to100(sum(lines, 'high')),
    renovation,
    levels,
    unpriced,
  };
}

/**
 * Each level's name as an estimate shows it, every one different: a name only one level has
 * stays; a blank one is "Level n", and one two levels share gets its number ("Level 1",
 * "Level 2"), counting on from n while that is taken.
 */
export function levelNames(levels: readonly Pick<Level, 'name'>[]): string[] {
  const names = levels.map((l) => l.name.trim());
  const once = (n: string) => !!n && names.filter((m) => m === n).length === 1;
  // The names that stay as they are, so a made-up one never takes one of them.
  const taken = new Set(names.filter(once));
  return names.map((n, i) => {
    if (once(n)) return n;
    const base = n || 'Level';
    let k = i + 1;
    while (taken.has(`${base} ${k}`)) k++;
    const name = `${base} ${k}`;
    taken.add(name);
    return name;
  });
}

/**
 * The estimate for one level: as it is (`before`) and its renovation (`after`), or, with no
 * renovation, painting and the carpentry drawn.
 */
export function costEstimate(before: Level, after: Level | undefined, rates: Rates): CostEstimate {
  const [name = ''] = levelNames([before]);
  const parts = levelParts(before, after, rates);
  return assemble([{ id: before.id, name, parts }], rates, !!after, [], false);
}

/**
 * The estimate for the whole home: every level, with its renovation copy (its id and
 * AFTER_SUFFIX). With a renovation, a level that has no copy isn't priced: it is listed in
 * `unpriced`. For one level, the same as `costEstimate`.
 */
export function projectEstimate(
  project: Pick<Project, 'levels' | 'renovation'>,
  rates: Rates,
): CostEstimate {
  const names = levelNames(project.levels);
  const priced: PricedLevel[] = [];
  const unpriced: string[] = [];
  project.levels.forEach((before, i) => {
    const name = names[i] ?? before.name;
    const after = project.renovation?.levels.find((l) => l.id === `${before.id}${AFTER_SUFFIX}`);
    if (project.renovation && !after) unpriced.push(name);
    else priced.push({ id: before.id, name, parts: levelParts(before, after, rates) });
  });
  return assemble(priced, rates, !!project.renovation, unpriced, project.levels.length > 1);
}

/** One change of the renovation, priced (nothing for the household shelter: not allowed). */
function changeLines(c: RenovationChange, before: Level, after: Level, rates: Rates): CostLine[] {
  if (c.guard === 'shelter') return [];
  const place = placeOf(c);
  const tag = c.guard === 'structural' ? ' (structural)' : '';
  const len = Math.round(('length' in c ? c.length : 0) * 100) / 100;
  switch (c.kind) {
    case 'hack':
      return [line('Building', `Hack wall${tag}`, place, len, 'm', rates.hack)];
    case 'build':
      if (c.what === 'glass')
        return [line('Building', 'Glass partition', place, len, 'm', rates.glass)];
      if (c.what === 'half')
        return [line('Building', 'Half wall', place, len, 'm', rates.halfWall)];
      if (c.what === 'half-glass') {
        return [
          line('Building', 'Half wall', place, len, 'm', rates.halfWall),
          line('Building', 'Fixed glass above', place, len, 'm', rates.glassAbove),
        ];
      }
      return [line('Building', 'New wall', place, len, 'm', rates.newWall)];
    case 'opening': {
      if (c.change === 'with-wall') return [];
      const D = 'Doors and windows';
      const closeUp = () =>
        line(
          D,
          `Close up ${c.opening === 'window' ? 'a window' : `a ${c.opening}`}${tag}`,
          place,
          1,
          'each',
          rates.closeOpening,
        );
      if (c.change === 'removed') return [closeUp()];
      const o = after.openings[c.id];
      if (!o) return [];
      const out: CostLine[] = [];
      const b = c.change === 'changed' ? (c.before ?? {}) : {};
      const moved = c.change === 'changed' && !!c.moved;
      const bigger =
        (b.width !== undefined && c.width > b.width + 0.004) ||
        (b.height !== undefined && (c.height ?? 0) > b.height + 0.004);
      // A hole in a wall that was there: cut new, moved (and the old one closed) or made bigger.
      const inOldWall = !!wallBefore(before, after, c.id);
      if (c.change === 'added' && inOldWall)
        out.push(line(D, `Cut an opening${tag}`, place, 1, 'each', rates.cutOpening));
      if (moved) {
        out.push(line(D, `Cut an opening${tag}`, place, 1, 'each', rates.cutOpening), closeUp());
      } else if (bigger) {
        out.push(line(D, `Widen the opening${tag}`, place, 1, 'each', rates.cutOpening));
      }
      // A new door or window: new, a new kind, restyled, moved or resized.
      const changed =
        c.change === 'added' ||
        b.opening !== undefined ||
        b.style !== undefined ||
        b.glazed !== undefined ||
        b.width !== undefined ||
        b.height !== undefined ||
        b.sill !== undefined ||
        moved;
      if (o.kind === 'door' && changed) {
        const style = (o.style ?? 'swing') as DoorStyle;
        out.push(line(D, DOOR_NAMES[style], place, 1, 'each', rates.door[style]));
        if (o.glazed) out.push(line(D, 'Glass leaves', place, 1, 'each', rates.glassLeaves));
      } else if (o.kind === 'window' && changed) {
        out.push(line(D, 'Window', place, 1, 'each', rates.window));
      }
      return out;
    }
    case 'floor': {
      const room = after.rooms[c.roomId];
      const kind = room ? floorKind(room.floorMaterial) : null;
      if (!room || !kind) return [];
      const area = Math.round(roomArea(after, room) * 10) / 10;
      return [
        line(
          'Floors',
          `${finish(room.floorMaterial)?.name ?? 'New'} floor`,
          place,
          area,
          'm²',
          rates.floor[kind],
        ),
      ];
    }
    default:
      return [];
  }
}

/**
 * Electrical points priced: with a renovation, what it changes (new, relocated, taken out;
 * a changed kind is new), else every point as new. An aircon point adds its trunking by the
 * metre; a compressor comes in the aircon package. Lines group by what, where and change.
 */
export function electricalLines(before: Level, after: Level | undefined, rates: Rates): CostLine[] {
  const shown = after ?? before;
  const groups = new Map<string, CostLine>();
  const add = (p: ElecPoint, level: Level, change: 'new' | 'relocate' | 'removal') => {
    if (p.kind === 'compressor') return;
    const rate =
      change === 'new'
        ? rates.elecNew[p.kind]
        : change === 'relocate'
          ? rates.elecMove[p.kind]
          : rates.elecRemove;
    const label = `${pointName(p)}, ${change}`;
    const place = pointRoom(level, p) ?? 'Outside';
    const key = `${label}|${place}`;
    const was = groups.get(key);
    const qty = (was?.qty ?? 0) + 1;
    groups.set(key, { ...line('Electrical', label, place, qty, 'each', rate), point: p.kind });
  };
  const trunking: CostLine[] = [];
  const addTrunking = (p: ElecPoint, level: Level) => {
    const m = trunkingMetres(level, p);
    if (m <= 0) return;
    const place = pointRoom(level, p) ?? 'Outside';
    trunking.push(line('Electrical', 'Aircon trunking', place, m, 'm', rates.trunking));
  };
  const points = Object.values(shown.points ?? {});
  if (!after) {
    for (const p of points) {
      add(p, shown, 'new');
      if (p.kind === 'aircon') addTrunking(p, shown);
    }
  } else {
    const ch = electricalChanges(before, after);
    for (const p of ch.removed) add(p, before, 'removal');
    for (const p of points) {
      const s = ch.status.get(p.id);
      if (s) add(p, after, s === 'new' ? 'new' : 'relocate');
      const was = before.points?.[p.id];
      const rerouted =
        !!was && JSON.stringify(trunkingOf(before, was)) !== JSON.stringify(trunkingOf(after, p));
      if (p.kind === 'aircon' && (s || rerouted)) addTrunking(p, after);
    }
  }
  const order = (l: CostLine) =>
    ['new', 'relocate', 'removal'].findIndex((c) => l.label.endsWith(c));
  return [
    ...[...groups.values()].sort(
      (a, b) =>
        order(a) - order(b) ||
        ELEC_ORDER.indexOf(a.point as ElecKind) - ELEC_ORDER.indexOf(b.point as ElecKind) ||
        a.place.localeCompare(b.place),
    ),
    ...trunking,
  ];
}

const ELEC_ORDER = Object.keys(ELEC_KINDS) as ElecKind[];

/** An aircon unit's trunking, rounded, to compare two versions. */
const trunkingOf = (level: Level, p: ElecPoint) =>
  p.kind === 'aircon' ? trunkingMetres(level, p) : 0;
