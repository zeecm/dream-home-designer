import type { Level } from '../../schema';
import {
  DEFAULT_STORAGE,
  type Meter,
  type People,
  STORAGE_MEASURES,
  type StorageMeasure,
  type StorageReport,
  type StorageSetting,
  householdFromBeds,
  meter,
  storageReport,
} from '../../storage';
import { SHELTER_ROOM } from '../../structural';
import { type Person, type Role, sleepingPlan } from '../principles';
import type { DesignResult } from '../result';
import type { DesignBrief } from '../schema';
import type { Space } from '../spaces';
import { bedroomsOf } from '../talk/firstMeeting';
import type { Lens, LensLine, LensReport, Steer } from './lens';

/**
 * The storage lens (tech 3b §4): the storage meter, measured for the designer's household.
 * Each version is scored on the meter with a card line and what it adds against the plan;
 * room steps are told what each space should hold (data); and the solver keeps storage pieces
 * in a room that is short of them (weights only: they are left out last, kept at full width
 * where they fit, and stood against a wall). Advice, never a check: it doesn't gate.
 */

/** The household the lens measures for, and where it came from. */
export interface StorageHousehold {
  setting: StorageSetting;
  /** The storage meter's own household (the person set it there), or who sleeps where. */
  from: 'meter' | 'brief';
}

const headcount = (p: People) => p.adults + p.children;

/**
 * Whether the person set the storage meter's household (people in a room, or others living
 * here). How much they own is not part of it: that one value is shared with the designer's
 * "How much do you own?", so setting either never turns the household over to the meter.
 */
export const householdEdited = (s: StorageSetting) =>
  Object.keys(s.people).length > 0 || headcount(s.others) > 0;

const peopleIn = (ps: Person[]): People => ({
  adults: ps.filter((p) => p.kind !== 'child').length,
  children: ps.filter((p) => p.kind === 'child').length,
});

/**
 * The meter's setting for a level as the lens reads it. The storage meter's own household wins
 * when the person set it; else each bedroom holds who the brief says sleeps there (assumed as
 * the checks assume when it doesn't say), and anyone with no room lives here too. How much they
 * own is the brief's answer when it gives one, else the meter's.
 */
export function storageSettingFor(
  level: Level,
  brief: DesignBrief,
  setting: StorageSetting = DEFAULT_STORAGE,
): StorageHousehold {
  const amount = brief.owns ?? setting.amount;
  if (householdEdited(setting)) return { setting: { ...setting, amount }, from: 'meter' };
  const rooms = bedroomsOf(level, brief).filter((r) => !SHELTER_ROOM.test(r.name));
  const plan = sleepingPlan(brief, rooms, (id) => !!level.rooms[id]);
  // Every bedroom and every room with a bed is said, so a bed drawn never adds someone.
  const people: Record<string, People> = {};
  for (const r of rooms) people[r.id] = { adults: 0, children: 0 };
  for (const id of Object.keys(householdFromBeds(level))) people[id] ??= { adults: 0, children: 0 };
  const placed = new Set<string>();
  for (const [id, ps] of plan.rooms) {
    people[id] = peopleIn(ps);
    for (const p of ps) placed.add(p.key);
  }
  const helper: Person[] =
    brief.household.helper && !placed.has('helper')
      ? [{ key: 'helper', kind: 'helper', name: 'Helper', detail: null }]
      : [];
  const others = peopleIn([...plan.unplaced, ...plan.gone, ...helper]);
  return {
    setting: { people, others, amount, shelter: setting.shelter },
    from: 'brief',
  };
}

// --- words ---------------------------------------------------------------------------------

const UNIT: Record<StorageMeasure, string> = {
  clothes: 'm',
  shoes: 'pairs',
  kitchen: 'm',
  other: 'm³',
};
const WORD: Record<StorageMeasure, string> = {
  clothes: 'clothes',
  shoes: 'shoes',
  kitchen: 'kitchen',
  other: 'everything else',
};
/** What a measure adds reads as: "+1.2 m hanging", "+15 pairs", "+2.4 m of kitchen". */
const ADDS: Record<StorageMeasure, string> = {
  clothes: 'm hanging',
  shoes: 'pairs',
  kitchen: 'm of kitchen',
  other: 'm³ of cupboards',
};

/** As the lens shows it: pairs whole, the rest to 0.1. */
const rounded = (m: StorageMeasure, v: number) =>
  m === 'shoes' ? Math.round(v + 1e-9) : Math.round(v * 10 + 1e-9) / 10;
const num = (m: StorageMeasure, v: number) =>
  m === 'shoes' ? String(rounded(m, v)) : rounded(m, v).toFixed(1);

const andList = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/** "2 adults and 1 child". */
export function peopleWords(p: People): string {
  const parts: string[] = [];
  if (p.adults) parts.push(`${p.adults} ${p.adults === 1 ? 'adult' : 'adults'}`);
  if (p.children) parts.push(`${p.children} ${p.children === 1 ? 'child' : 'children'}`);
  return andList(parts) || 'nobody';
}

/** How far under its target a meter is, as shown (0: met, or nothing to compare with). */
function shortBy(m: StorageMeasure, meter: Meter | undefined): number {
  if (!meter?.target) return 0;
  return Math.max(0, rounded(m, meter.target) - rounded(m, meter.have));
}

/** "clothes 7.2 of 9.0 m, short 1.8 m". */
function figure(m: StorageMeasure, meter: Meter): string {
  const t = meter.target ?? 0;
  const gap = shortBy(m, meter);
  const unit = UNIT[m];
  return `${WORD[m]} ${num(m, meter.have)} of ${num(m, t)} ${unit}${gap > 0 ? `, short ${num(m, gap)} ${unit}` : ''}`;
}

/** "+1.2 m hanging · +15 pairs"; null when the version adds or takes away nothing. */
function deltaText(
  was: StorageReport,
  now: StorageReport,
  measures: StorageMeasure[],
): string | null {
  const parts: string[] = [];
  for (const m of measures) {
    const d = rounded(m, now.home[m].have) - rounded(m, was.home[m].have);
    if (Math.abs(d) < 1e-6) continue;
    parts.push(`${d > 0 ? '+' : '−'}${num(m, Math.abs(d))} ${ADDS[m]}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

/**
 * The measures a version is about: clothes for the bedrooms it designs, kitchen for a kitchen,
 * shoes and everything else for a living room (and everything else for a study or the rest).
 * All four when it designs nothing yet, or the whole flat.
 */
function measuresFor(result: DesignResult, now: StorageReport): StorageMeasure[] {
  const designed = result.spaces.filter((s) => s.storedKey && s.status !== 'missing');
  if (!designed.length) return [...STORAGE_MEASURES];
  const sleeps = new Set(now.rooms.filter((r) => r.sleeps).map((r) => r.roomId));
  const out = new Set<StorageMeasure>();
  for (const s of designed) {
    if (s.rooms.some((id) => sleeps.has(id)) || s.kinds.includes('bedroom')) out.add('clothes');
    if (s.kinds.includes('kitchen')) out.add('kitchen');
    if (s.kinds.includes('living')) {
      out.add('shoes');
      out.add('other');
    }
    if (s.kinds.some((k) => k === 'study' || k === 'other')) out.add('other');
  }
  return STORAGE_MEASURES.filter((m) => out.has(m));
}

/**
 * The card's line: what is short with its figures, what is met, and what the version adds.
 * "clothes 7.2 of 9.0 m, short 1.8 m · shoes and kitchen met · +1.2 m hanging".
 */
export function storageLine(
  was: StorageReport,
  now: StorageReport,
  measures: StorageMeasure[],
  /** The clothes of the rooms a version designs (else the home's). */
  clothes?: Meter,
): { line: string | null; short: boolean; delta: string | null } {
  const of = (m: StorageMeasure) => (m === 'clothes' && clothes ? clothes : now.home[m]);
  const counted = measures.filter((m) => (of(m).target ?? 0) > 0);
  const short = counted.filter((m) => shortBy(m, of(m)) > 0);
  const met = counted.filter((m) => !short.includes(m));
  const delta = deltaText(was, now, measures);
  const parts = [
    ...short.map((m) => figure(m, of(m))),
    ...(met.length ? [`${andList(met.map((m) => WORD[m]))} met`] : []),
    ...(delta ? [delta] : []),
  ];
  return { line: parts.length ? parts.join(' · ') : null, short: short.length > 0, delta };
}

const CLOTHES_ROLES: Role[] = ['wardrobe', 'drawers'];
const ROLES: Partial<Record<StorageMeasure, Role[]>> = {
  clothes: CLOTHES_ROLES,
  shoes: ['shoe-cabinet'],
  other: ['shelf'],
};

/** How far short a meter is, 0–1 of its target (0: enough, or nothing to compare with). */
const shortfall = (meter: Meter | undefined) =>
  meter?.target && meter.status !== 'enough' ? Math.min(1, (meter.gap ?? 0) / meter.target) : 0;

const ratio = (meter: Meter | undefined) =>
  meter?.target ? Math.min(1, meter.have / meter.target) : null;

export const storageLens: Lens = {
  id: 'storage',
  report({ result, start, brief, opts }): LensReport {
    const after = storageSettingFor(result.level, brief, opts.storage);
    const before = storageSettingFor(start, brief, opts.storage);
    const now = storageReport(result.level, after.setting);
    const was = storageReport(start, before.setting);
    const measures = measuresFor(result, now);
    const designed = new Set(
      result.spaces.filter((s) => s.storedKey && s.status !== 'missing').flatMap((s) => s.rooms),
    );
    // A room proposal's clothes are its own bedrooms', for who sleeps there; the other measures
    // are the home's (shoes by the door, the kitchen's cupboards).
    const mine = now.rooms.filter((r) => designed.has(r.roomId) && r.clothes?.target);
    const clothes = mine.length
      ? meter(
          mine.reduce((t, r) => t + (r.clothes?.have ?? 0), 0),
          mine.reduce((t, r) => t + (r.clothes?.target ?? 0), 0),
          mine.reduce((t, r) => t + (r.clothes?.pieces ?? 0), 0),
        )
      : undefined;
    const { line, short, delta } = storageLine(was, now, measures, clothes);
    const lines: LensLine[] = [];
    const rooms: Record<string, number> = {};
    for (const r of now.rooms) {
      if (!r.clothes?.target) continue;
      rooms[r.roomId] = ratio(r.clothes) ?? 1;
      if (designed.size && !designed.has(r.roomId)) continue;
      const gap = shortBy('clothes', r.clothes);
      lines.push({
        text: `${r.name}, for ${peopleWords(r.people)}: ${figure('clothes', r.clothes)}`,
        roomId: r.roomId,
        tone: gap > 0 ? 'short' : 'ok',
      });
    }
    lines.push({
      text: `Measured for ${peopleWords(now.people)}, ${after.from === 'meter' ? 'as set in the storage meter' : 'from who sleeps where'}; ${now.amount === 'typical' ? 'a typical amount of things' : now.amount === 'few' ? 'few things' : 'lots of things'}.`,
      tone: 'note',
    });
    const scores = STORAGE_MEASURES.map((m) => ratio(now.home[m])).filter(
      (v): v is number => v !== null,
    );
    const home: Record<string, string> = {};
    for (const m of measures) {
      const meter = now.home[m];
      if (!meter.target) continue;
      home[m] =
        shortBy(m, meter) > 0
          ? `${num(m, meter.have)} of ${num(m, meter.target)} ${UNIT[m]}`
          : 'met';
    }
    return {
      id: 'storage',
      title: 'Storage',
      line,
      tone: short ? 'short' : 'ok',
      lines,
      score: {
        overall: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 1,
        rooms,
      },
      delta,
      facts: { for: peopleWords(now.people), from: after.from, amount: now.amount, home },
    };
  },
  steer({ level, space, brief, opts }): Steer | null {
    const { setting } = storageSettingFor(level, brief, opts.storage);
    const rep = storageReport(level, setting);
    const weight = new Map<Role, number>();
    const add = (roles: Role[] | undefined, w: number) => {
      if (w <= 0) return;
      for (const r of roles ?? []) weight.set(r, Math.max(weight.get(r) ?? 0, w));
    };
    for (const r of rep.rooms) {
      if (space.rooms.includes(r.roomId)) add(ROLES.clothes, shortfall(r.clothes));
    }
    add(ROLES.shoes, shortfall(rep.home.shoes));
    add(ROLES.other, shortfall(rep.home.other));
    if (!weight.size) return null;
    const roles = [...weight.keys()].sort();
    // Two places: a steer's weights go into a solve's memo key, so they're rounded.
    return {
      protect: roles,
      prefer: roles.map((role) => ({
        role,
        weight: Math.round((weight.get(role) as number) * 100) / 100,
      })),
    };
  },
};

/**
 * What a room step is told the space should hold, from the meter (data): each of its rooms'
 * clothes for who sleeps there, and the home's shoes (a living room), kitchen (a kitchen) and
 * everything else, against what the plan holds now. Empty when there is nothing to hold.
 */
export function storageBlock(
  level: Level,
  space: Space,
  brief: DesignBrief,
  setting: StorageSetting | undefined,
  alias: (id: string) => string,
): string {
  const { setting: s } = storageSettingFor(level, brief, setting);
  const rep = storageReport(level, s);
  const need = (m: StorageMeasure, meter: Meter | undefined) =>
    meter?.target
      ? { need: rounded(m, meter.target), now: rounded(m, meter.have), unit: UNIT[m] }
      : null;
  const rooms = rep.rooms
    .filter((r) => space.rooms.includes(r.roomId) && r.clothes?.target)
    .map((r) => ({ room: alias(r.roomId), clothes: need('clothes', r.clothes) }));
  const home: Partial<Record<StorageMeasure, ReturnType<typeof need>>> = {};
  const kinds = new Set(space.kinds);
  if (kinds.has('living')) home.shoes = need('shoes', rep.home.shoes);
  if (kinds.has('kitchen')) home.kitchen = need('kitchen', rep.home.kitchen);
  if (kinds.has('living') || kinds.has('study') || kinds.has('other')) {
    home.other = need('other', rep.home.other);
  }
  for (const m of STORAGE_MEASURES) if (!home[m]) delete home[m];
  if (!rooms.length && !Object.keys(home).length) return '';
  const data = { for: peopleWords(rep.people), rooms, home };
  return `Storage the household needs, from the app's storage meter (data; clothes in metres of wardrobe front, "home" for the whole flat): ${JSON.stringify(data)}
Where "now" is under "need", plan wardrobes, shoe cabinets or shelves that fit, after what the room must have.
`;
}
