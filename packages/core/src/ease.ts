import { roomShapes } from './rooms';
import type { Level } from './schema';
import { roomKind } from './suggest';

/**
 * HDB's EASE programme (Enhancement for Active Seniors): what it fits that the ageing check
 * finds this plan needs, and the owner's share by flat type. Prices from EASE 2026 (HDB,
 * Annex C to the 2026 Home Improvement Programme release), in cents. Spec:
 * docs/specs/ageing-parents.md (EASE panel).
 */
export type FlatType = '1-3' | '4' | '5' | 'exec' | 'none';

export const FLAT_TYPES: { value: FlatType; label: string }[] = [
  { value: '1-3', label: '1, 2 or 3-room' },
  { value: '4', label: '4-room' },
  { value: '5', label: '5-room' },
  { value: 'exec', label: 'Executive' },
  { value: 'none', label: 'Not an HDB flat' },
];

export type EaseItemId =
  | 'grab-bars-first'
  | 'grab-bars-second'
  | 'slip-resistant'
  | 'lower-kerb'
  | 'widen-entrance'
  | 'widen-and-lower'
  | 'shower-seat'
  | 'handrail'
  | 'ramp-single'
  | 'ramp-portable'
  | 'rocker-switches';

/** Why an item is listed: always, or because of something in this plan. */
export type EaseWhen = 'always' | 'second-bathroom' | 'door' | 'kerb' | 'door-and-kerb' | 'step';

export interface EaseItem {
  id: EaseItemId;
  /** EASE 2026's serial number. */
  sn: string;
  name: string;
  /** The owner's share, in cents: 1, 2 or 3-room; 4-room; 5-room; Executive. */
  cents: [number, number, number, number];
  when: EaseWhen;
}

export const EASE_ITEMS: readonly EaseItem[] = [
  {
    id: 'grab-bars-first',
    sn: '1',
    name: 'Grab bars, first toilet (8 or 10 bars)',
    cents: [2615, 3920, 5230, 6540],
    when: 'always',
  },
  {
    id: 'grab-bars-second',
    sn: '1',
    name: 'Grab bars, second toilet (6 bars)',
    cents: [1525, 2285, 3050, 3815],
    when: 'second-bathroom',
  },
  {
    id: 'slip-resistant',
    sn: '2',
    name: 'Slip-resistant floor treatment, up to 2 toilets',
    cents: [2395, 3595, 4795, 5995],
    when: 'always',
  },
  {
    id: 'lower-kerb',
    sn: '3 i',
    name: 'Lower the toilet entrance kerb',
    cents: [4795, 7190, 9590, 11990],
    when: 'kerb',
  },
  {
    id: 'widen-entrance',
    sn: '3 ii',
    name: 'Widen the toilet entrance',
    cents: [6540, 9810, 13080, 16350],
    when: 'door',
  },
  {
    id: 'widen-and-lower',
    sn: '3 i + ii',
    name: 'Widen the toilet entrance and lower its kerb',
    cents: [7735, 11605, 15475, 19345],
    when: 'door-and-kerb',
  },
  {
    id: 'shower-seat',
    sn: '4',
    name: 'Wall-mounted foldable shower seat',
    cents: [1525, 2285, 3050, 3815],
    when: 'always',
  },
  {
    id: 'handrail',
    sn: '5',
    name: 'Handrail at a main entrance with steps',
    cents: [3160, 4740, 6320, 7900],
    when: 'step',
  },
  {
    id: 'ramp-single',
    sn: '6 a',
    name: 'Single-step ramp',
    cents: [1415, 2125, 2830, 3540],
    when: 'step',
  },
  {
    id: 'ramp-portable',
    sn: '6 b',
    name: 'Portable ramp',
    cents: [3815, 5720, 7630, 9535],
    when: 'step',
  },
  {
    id: 'rocker-switches',
    sn: '8',
    name: 'Rocker switches (large, easy-press switches), set of 12',
    cents: [1360, 2040, 2725, 3405],
    when: 'always',
  },
];

/** Who EASE is for. Not checked on HDB's own page (it gave a 404 on 7 Nov 2026). */
export const EASE_ELIGIBILITY =
  'HDB pays up to 95% for Singapore Citizen households with someone 65 or over, or 60 to 64 who needs help with daily activities. Apply through the Home Improvement Programme (HIP) if your block is due, or directly on HDB’s e-Service. Prices: HDB, 2026; check HDB for today’s.';

export const EASE_URL =
  'https://www.hdb.gov.sg/cs/infoweb/residential/living-in-an-hdb-flat/for-our-seniors/ease';

export const EASE_NOT_HDB = 'EASE is for HDB flats. The checks above apply to any home.';

/** The flat type a plan suggests, from its bedrooms: 2 or fewer, 3, 4 or more. */
export function defaultFlatType(level: Level): FlatType {
  const shapes = roomShapes(level);
  const bedrooms = Object.values(level.rooms).filter(
    (r) => shapes.has(r.id) && roomKind(r.name) === 'bedroom',
  ).length;
  return bedrooms <= 2 ? '1-3' : bedrooms === 3 ? '4' : '5';
}

/** What the plan shows, for which items apply. */
export interface EaseFacts {
  bathrooms: number;
  /** Their bathroom's door fails the door checks (width or the space in front). */
  doorFails: boolean;
  /** Slice 2: a kerb over 25 mm at their bathroom door; a step at the main door or on a route. */
  kerb?: boolean;
  step?: boolean;
}

const TYPE_INDEX: Record<Exclude<FlatType, 'none'>, 0 | 1 | 2 | 3> = {
  '1-3': 0,
  '4': 1,
  '5': 2,
  exec: 3,
};

/** The items that apply to this plan, with the owner's share for the flat type (none: not HDB). */
export function easeItems(
  type: FlatType,
  facts: EaseFacts,
): { item: EaseItem; cents: number; because: EaseWhen }[] {
  if (type === 'none') return [];
  const i = TYPE_INDEX[type];
  // No bathroom drawn: nothing here for the toilet's items to be about.
  const toilet: EaseItemId[] = [
    'grab-bars-first',
    'grab-bars-second',
    'slip-resistant',
    'shower-seat',
  ];
  const shown = (w: EaseWhen): boolean => {
    switch (w) {
      case 'always':
        return true;
      case 'second-bathroom':
        return facts.bathrooms >= 2;
      case 'door':
        return facts.doorFails && !facts.kerb;
      case 'kerb':
        return !!facts.kerb && !facts.doorFails;
      case 'door-and-kerb':
        return facts.doorFails && !!facts.kerb;
      case 'step':
        return !!facts.step;
    }
  };
  return EASE_ITEMS.filter(
    (it) => shown(it.when) && !(facts.bathrooms === 0 && toilet.includes(it.id)),
  ).map((item) => ({
    item,
    cents: item.cents[i],
    because: item.when,
  }));
}

/** "$39.20". */
export const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
