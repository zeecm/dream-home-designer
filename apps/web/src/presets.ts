import type { OpeningKind } from '@dhd/core';

export interface Preset {
  value: number;
  label: string;
  note?: string;
}

/** Common HDB clear widths, in metres. */
export const OPENING_PRESETS: Record<OpeningKind, Preset[]> = {
  door: [
    { value: 0.7, label: '700 mm', note: 'bathroom' },
    { value: 0.8, label: '800 mm', note: 'bedroom' },
    { value: 0.9, label: '900 mm', note: 'main door' },
  ],
  window: [
    { value: 0.6, label: '600 mm' },
    { value: 1.2, label: '1200 mm' },
    { value: 1.8, label: '1800 mm' },
  ],
  passage: [
    { value: 0.9, label: '900 mm' },
    { value: 1.2, label: '1200 mm' },
    { value: 1.8, label: '1800 mm' },
  ],
};

export const DEFAULT_OPENING_WIDTH: Record<OpeningKind, number> = {
  door: 0.9,
  window: 1.2,
  passage: 0.9,
};

export const THICKNESS_PRESETS: Preset[] = [
  { value: 0.1, label: '100 mm', note: 'inside walls' },
  { value: 0.15, label: '150 mm' },
  { value: 0.2, label: '200 mm', note: 'outer walls' },
  { value: 0, label: 'Boundary', note: 'no wall' },
];

/** Room names people trace most, offered while renaming. */
export const ROOM_NAMES = [
  'Living',
  'Dining',
  'Kitchen',
  'Master bedroom',
  'Bedroom',
  'Bathroom',
  'Master bathroom',
  'Household shelter',
  'Service yard',
  'Study',
  'Store',
  'Balcony',
  'Foyer',
];
