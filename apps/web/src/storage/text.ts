import {
  type Level,
  type Meter,
  type People,
  type PieceStorage,
  type Rates,
  type StorageMeasure,
  type StorageReport,
  type StorageRoom,
  cupboardFor,
  furnitureKind,
  shortfallPrice,
  storageRound,
} from '@dhd/core';
import { range } from '../cost/text';

/**
 * The storage meter's words: plain, in sizes owners already use (metres and foot runs, pairs),
 * never "short" or red: it's advice. Wording from the UX design (docs/specs/storage-meter.md).
 */

export const MEASURE_LABEL: Record<StorageMeasure, string> = {
  clothes: 'Clothes',
  shoes: 'Shoes',
  kitchen: 'Kitchen',
  other: 'Everything else',
};

/** What to add when nothing is drawn: the words and the catalogue piece the link arms. */
export const ADD_PIECE: Record<StorageMeasure, { what: string; kindId: string }> = {
  clothes: { what: 'wardrobe', kindId: 'wardrobe' },
  shoes: { what: 'shoe cabinet', kindId: 'shoe-cabinet' },
  kitchen: { what: 'kitchen cabinet', kindId: 'kitchen-base' },
  other: { what: 'bookshelf', kindId: 'bookshelf' },
};

const FT = 0.3048;
const feet = (m: number) => Math.round(m / FT);

/** A number of a measure as shown: "1.20 m", "15 pairs", "4.8 m", "3.7 m³". */
export function amount(m: StorageMeasure, v: number, unit = true): string {
  const r = storageRound(m, v);
  switch (m) {
    case 'clothes':
      return `${r.toFixed(2)}${unit ? ' m' : ''}`;
    case 'shoes':
      return unit ? `${r} ${r === 1 ? 'pair' : 'pairs'}` : `${r}`;
    case 'kitchen':
      return `${r.toFixed(1)}${unit ? ' m' : ''}`;
    case 'other':
      return `${r.toFixed(1)}${unit ? ' m³' : ''}`;
  }
}

/** A target, rounded as a target reads ("8 m³", "12.0 m"). */
const target = (m: StorageMeasure, v: number) =>
  m === 'other' ? `${Math.round(v * 10) / 10} m³` : amount(m, v);

/** "1.20 of 3.00 m (4 of 10 ft)", "15 of 28 pairs", "4.8 of 12.0 m", "3.7 of 8 m³". */
export function figures(m: StorageMeasure, meter: Meter): string {
  if (meter.target === undefined) {
    return m === 'clothes'
      ? `${amount(m, meter.have)} (${feet(meter.have)} ft)`
      : amount(m, meter.have);
  }
  const t = meter.target;
  switch (m) {
    case 'clothes':
      return `${amount(m, meter.have, false)} of ${amount(m, t)} (${feet(meter.have)} of ${feet(t)} ft)`;
    case 'shoes':
      return `${amount(m, meter.have, false)} of ${amount(m, t)}`;
    case 'kitchen':
      return `${amount(m, meter.have, false)} of ${amount(m, t)}`;
    case 'other':
      return `${amount(m, meter.have, false)} of ${target(m, t)}`;
  }
}

/** How much more: "0.80 m", "13 more pairs" reads "13 pairs". */
const gapText = (m: StorageMeasure, gap: number) => amount(m, gap);

/**
 * The status word: Enough, Nearly, or "Needs 0.80 m more" (the only one in amber). None with
 * nobody to compare with or nothing drawn.
 */
export function statusWord(
  m: StorageMeasure,
  meter: Meter,
): { text: string; warn: boolean } | null {
  switch (meter.status) {
    case 'enough':
      return { text: 'Enough', warn: false };
    case 'nearly':
      return { text: 'Nearly', warn: false };
    case 'short':
      return { text: `Needs ${gapText(m, meter.gap ?? 0)} more`, warn: true };
    default:
      return null;
  }
}

/** The line under the bar: spare, or how far off usual for Nearly. */
export function aside(m: StorageMeasure, meter: Meter): string | null {
  if (meter.target === undefined) return null;
  const spare = meter.have - meter.target;
  if (meter.status === 'enough' && storageRound(m, spare) > 0) {
    return `+${amount(m, spare)} spare`;
  }
  if (meter.status === 'nearly') return `${gapText(m, meter.gap ?? 0)} more is usual`;
  return null;
}

/** Nothing of a measure drawn: "No wardrobe drawn · about 3.00 m is usual". */
export function emptyText(m: StorageMeasure, meter: Meter): string {
  const usual = meter.target === undefined ? '' : ` · about ${target(m, meter.target)} is usual`;
  return `No ${ADD_PIECE[m].what} drawn${usual}`;
}

/** The kitchen's fronts against its run: "(2.8 m of cabinets)". */
export const cabinetsText = (report: StorageReport) =>
  `${amount('kitchen', report.home.kitchen.have)} of shelves and drawers (${amount('kitchen', report.cabinets)} of cabinets)`;

/** Everything else's gap as a cupboard: "about 3 m of full-height cupboard". */
export function cupboardText(meter: Meter): string | null {
  if (meter.status !== 'short' && meter.status !== 'none') return null;
  const w = cupboardFor(meter.gap ?? 0);
  return `About ${w % 1 ? w.toFixed(1) : w} m of full-height cupboard would hold it.`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 adults", "1 adult and 1 child", "nobody". */
export function peopleText(p: People): string {
  const parts = [
    p.adults ? plural(p.adults, 'adult', 'adults') : '',
    p.children ? plural(p.children, 'child', 'children') : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' and ') : 'nobody';
}

const count = (p: People) => p.adults + p.children;

/** "3 people: 2 in Main bedroom, 1 in Bedroom" (and "1 more without a bed"). */
export function householdLine(report: StorageReport): string {
  const n = count(report.people);
  if (!n) return 'Nobody yet';
  const rooms = report.rooms.filter((r) => count(r.people) > 0);
  const where = rooms.map((r) => `${count(r.people)} in ${r.name}`);
  const without = n - rooms.reduce((t, r) => t + count(r.people), 0);
  if (without > 0) where.push(`${without} without a bed`);
  return `${plural(n, 'person', 'people')}: ${where.join(', ')}`;
}

const listed = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/** The plan details' one line. */
export function summaryLine(report: StorageReport | null, rooms: number): string {
  if (!rooms || !report) return 'Draw rooms first.';
  if (!count(report.people)) {
    const c = report.home.clothes.have;
    return c > 0
      ? `You have ${amount('clothes', c)} of wardrobe. Add who lives here to compare.`
      : 'Add who lives here to compare.';
  }
  const more = (['clothes', 'shoes', 'kitchen', 'other'] as const).filter(
    (m) => report.home[m].status !== 'enough',
  );
  if (!more.length) return `Enough for ${plural(count(report.people), 'person', 'people')}.`;
  const words = more.map((m, i) => (i === 0 ? MEASURE_LABEL[m] : MEASURE_LABEL[m].toLowerCase()));
  return `${listed(words)} could use more.`;
}

/** The meter's words for a screen reader (the bar's aria-valuetext). */
export function meterValueText(m: StorageMeasure, meter: Meter): string {
  if (meter.status === 'none') return emptyText(m, meter);
  const s = statusWord(m, meter);
  return `${figures(m, meter)}${s ? `, ${s.text.toLowerCase()}` : ''}`;
}

const roomName = (report: StorageReport, id: string | null) =>
  id ? (report.rooms.find((r) => r.roomId === id)?.name ?? 'another room') : 'no room';

/**
 * A bedroom's clothes line: "Main bedroom, 2 adults: 1.20 m of wardrobe; about 2.00 m is usual."
 * then what more would take, priced, or why it's fine anyway. Null for a room with no clothes and
 * nobody.
 */
export function clothesLines(
  report: StorageReport,
  room: StorageRoom,
  rates: Rates,
  /** Starts with the room and its people (off on the room's own card, which says them). */
  named = true,
): { line: string; more?: string; warn?: boolean } | null {
  const c = room.clothes;
  if (!c || c.target === undefined) {
    return room.totals.clothes > 0
      ? {
          line: `Nobody sleeps here: ${amount('clothes', room.totals.clothes)}, counted for the home.`,
        }
      : null;
  }
  const have = c.have > 0 ? `${amount('clothes', c.have)} of wardrobe` : 'no wardrobe';
  const usual = `${have}; about ${amount('clothes', c.target)} is usual.`;
  const line = named
    ? `${room.name}, ${peopleText(room.people)}: ${usual}`
    : `${usual.slice(0, 1).toUpperCase()}${usual.slice(1)}`;
  if (c.status === 'enough') return { line, more: 'Enough.' };
  const gap = c.gap ?? 0;
  if (report.home.clothes.status === 'enough') {
    const spare = report.spareClothes[0];
    return {
      line,
      more: spare
        ? `Enough for the whole home: ${amount('clothes', spare.clothes)} more stands ${spare.roomId ? `in ${roomName(report, spare.roomId)}` : 'outside the rooms'}.`
        : 'Enough for the whole home.',
    };
  }
  const price = shortfallPrice(gap, rates);
  return {
    line,
    more: price
      ? `Needs about ${amount('clothes', gap)} more: a ${price.feet} ft run, about ${range(price.low, price.high)} built in.`
      : `Needs about ${amount('clothes', gap)} more.`,
    warn: c.status === 'short' || c.status === 'none',
  };
}

const nameOf = (level: Level, itemId: string) => {
  const it = level.items[itemId];
  return (it && furnitureKind(it.assetId)?.name) || 'Piece';
};

/** A piece's share on its room's card: "1.80 m · top cabinets 0.5 m³", "15 pairs". */
export function pieceShare(p: PieceStorage): string {
  if (p.clothes > 0) {
    return p.top > 0
      ? `${amount('clothes', p.clothes)} · top cabinets ${amount('other', p.top)}`
      : amount('clothes', p.clothes);
  }
  if (p.kitchen > 0 || p.cabinets > 0) return `${amount('kitchen', p.kitchen)} of fronts`;
  if (p.other > 0) return amount('other', p.other);
  return amount('shoes', p.shoes);
}

/** A piece's line in its details: "Storage: 1.80 m of wardrobe (6 ft) and 0.5 m³ of top cabinets". */
export function pieceLine(p: PieceStorage): string {
  if (p.clothes > 0) {
    const wardrobe = `${amount('clothes', p.clothes)} of wardrobe (${Math.max(1, feet(p.clothes))} ft)`;
    return p.top > 0
      ? `Storage: ${wardrobe} and ${amount('other', p.top)} of top cabinets`
      : `Storage: ${wardrobe}`;
  }
  if (p.pantry) return `Storage: ${amount('clothes', p.kitchen)} of shelf front (a pantry)`;
  if (p.cabinets > 0) {
    return `Storage: ${amount('clothes', p.kitchen)} of shelf and drawer front${p.sink ? ' (one level less for the sink)' : ''}`;
  }
  if (p.other > 0) return `Storage: ${amount('other', p.other)}`;
  return p.shoes > 0
    ? `Storage: about ${amount('shoes', p.shoes)} of shoes`
    : 'Storage: 0 pairs of shoes (too narrow)';
}

export const NOT_COUNTED = 'Not counted as storage.';

export const INTRO =
  'Do you have room for everything? We add up wardrobes, shoe cabinets, kitchen cabinets and cupboards, and compare them with what a household like yours usually needs. We guessed who lives here from the beds; change it below.';

export const AMOUNT_HINT =
  'Typical is what most Singapore families own. Choose Lots if your wardrobe is full today.';

export const HDB_NOTE =
  'Most HDB flats have little room for bulky things. Wardrobe top cabinets, a storage bed or the shelter help.';

export const SHELTER_NOTE =
  'The shelter is counted as storage: keep it clear enough to use in an emergency, with no fixings in its walls.';

export const KITCHEN_NOTE =
  'For reference, US kitchen guidance asks for about 35 m in a small kitchen.';

export const DISCLAIMER =
  'A rough guide from UK and Australian housing standards, a wardrobe maker’s guide and Singapore practice. No Singapore rule sets storage. Count your own clothes and shoes if you can.';

/** A plain-text summary for a chat: the household, the four meters, the rooms, the disclaimer. */
export function copyText(
  level: Level,
  report: StorageReport,
  rates: Rates,
  amountName: string,
): string {
  const out: string[] = [];
  const n = count(report.people);
  out.push(n ? `Storage for ${plural(n, 'person', 'people')} (${amountName})` : 'Storage');
  if (n) out.push(`Who lives here: ${householdLine(report).replace(/^[^:]*: /, '')}`);
  out.push('');
  for (const m of ['clothes', 'shoes', 'kitchen', 'other'] as const) {
    const meter = report.home[m];
    const s = statusWord(m, meter);
    const what =
      meter.status === 'none'
        ? emptyText(m, meter)
        : m === 'kitchen'
          ? `${figures(m, meter)} of shelves and drawers (${amount('kitchen', report.cabinets)} of cabinets)`
          : figures(m, meter);
    out.push(`${MEASURE_LABEL[m]}: ${what}${s ? `. ${s.text}` : ''}`);
  }
  const rooms = report.rooms
    .map((r) => {
      const c = clothesLines(report, r, rates);
      if (c) return [c.line, c.more].filter(Boolean).join(' ');
      if (!r.pieces.length && !r.store) return '';
      const pieces = r.pieces.map((p) => `${nameOf(level, p.itemId)} ${pieceShare(p)}`);
      if (r.store?.counted) pieces.push(`the room itself ${amount('other', r.store.volume)}`);
      return pieces.length ? `${r.name}: ${pieces.join(', ')}.` : '';
    })
    .filter(Boolean);
  if (rooms.length) out.push('', ...rooms);
  out.push('', DISCLAIMER);
  return out.join('\n');
}
