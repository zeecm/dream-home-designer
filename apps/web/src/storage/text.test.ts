import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_STORAGE,
  type Level,
  type StorageSetting,
  TYPICAL_RATES,
  furnishedSample,
  furnitureKind,
  newItem,
  sampleFlatProject,
  storageReport,
} from '@dhd/core';
import { describe, expect, it } from 'vitest';
import {
  aside,
  clothesLines,
  copyText,
  emptyText,
  figures,
  householdLine,
  meterValueText,
  pieceLine,
  statusWord,
  summaryLine,
} from './text';

/** The furnished sample the e2e suite opens: written from core's fixture. */
const FILE = fileURLToPath(new URL('../../e2e/furnished.dreamhome.json', import.meta.url));
const furnishedProject = () => ({
  ...sampleFlatProject('prj_furnished'),
  name: 'Furnished sample',
  levels: [furnishedSample()],
});

const setting = (patch: Partial<StorageSetting> = {}): StorageSetting => ({
  ...structuredClone(DEFAULT_STORAGE),
  ...patch,
});
const room = (r: ReturnType<typeof storageReport>, name: string) =>
  r.rooms.find((x) => x.name === name) as ReturnType<typeof storageReport>['rooms'][number];

describe('the storage meter’s words', () => {
  it('the e2e file is the furnished sample', () => {
    // UPDATE_FIXTURES=1 pnpm --filter @dhd/web test writes it afresh (then format it).
    if (process.env.UPDATE_FIXTURES) writeFileSync(FILE, JSON.stringify(furnishedProject()));
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(furnishedProject());
  });

  it('the furnished sample: the summary, the household and the four meters', () => {
    const r = storageReport(furnishedSample(), setting());
    expect(summaryLine(r, 9)).toBe('Clothes, shoes, kitchen and everything else could use more.');
    expect(summaryLine(null, 0)).toBe('Draw rooms first.');
    expect(householdLine(r)).toBe('3 people: 1 in Bedroom, 2 in Main bedroom');
    expect(figures('clothes', r.home.clothes)).toBe('1.20 of 3.00 m (4 of 10 ft)');
    expect(statusWord('clothes', r.home.clothes)).toEqual({
      text: 'Needs 1.80 m more',
      warn: true,
    });
    expect(figures('kitchen', r.home.kitchen)).toBe('4.8 of 12.0 m');
    expect(figures('other', r.home.other)).toBe('3.7 of 8 m³');
    // Nothing drawn: no status, the empty line instead.
    expect(statusWord('shoes', r.home.shoes)).toBeNull();
    expect(emptyText('shoes', r.home.shoes)).toBe(
      'No shoe cabinet drawn · about 28 pairs is usual',
    );
    expect(meterValueText('clothes', r.home.clothes)).toBe(
      '1.20 of 3.00 m (4 of 10 ft), needs 1.80 m more',
    );
  });

  it('room lines: short and priced, no wardrobe, enough for the home, nobody sleeps here', () => {
    const r = storageReport(furnishedSample(), setting());
    expect(clothesLines(r, room(r, 'Main bedroom'), TYPICAL_RATES)).toEqual({
      line: 'Main bedroom, 2 adults: 1.20 m of wardrobe; about 2.00 m is usual.',
      more: 'Needs about 0.80 m more: a 3 ft run, about $600–1,050 built in.',
      warn: true,
    });
    expect(clothesLines(r, room(r, 'Bedroom'), TYPICAL_RATES)?.line).toBe(
      'Bedroom, 1 adult: no wardrobe; about 1.00 m is usual.',
    );
    // Two more wardrobes in the living room: the home has enough.
    const l = furnishedSample();
    const add = (id: string, x: number): Level['items'][string] => ({
      ...newItem(id, furnitureKind('wardrobe') as never, { x, y: 1.85 }, 0, 2.6),
    });
    const more: Level = {
      ...l,
      items: { ...l.items, w1: add('w1', 7.4), w2: add('w2', 9.0) },
    };
    const r2 = storageReport(more, setting());
    expect(clothesLines(r2, room(r2, 'Main bedroom'), TYPICAL_RATES)?.more).toBe(
      'Enough for the whole home: 2.40 m more stands in Living and dining.',
    );
    expect(clothesLines(r2, room(r2, 'Living and dining'), TYPICAL_RATES)).toEqual({
      line: 'Nobody sleeps here: 2.40 m, counted for the home.',
    });
    expect(aside('clothes', r2.home.clothes)).toBe('+0.60 m spare');
  });

  it('a piece’s line in its details', () => {
    const l = furnishedSample();
    const r = storageReport(l, setting());
    const p = (assetId: string) =>
      r.rooms.flatMap((x) => x.pieces).find((x) => l.items[x.itemId]?.assetId === assetId);
    expect(pieceLine(p('wardrobe') as never)).toBe('Storage: 1.20 m of wardrobe (4 ft)');
    expect(pieceLine(p('kitchen-hob') as never)).toBe('Storage: 1.60 m of shelf and drawer front');
    expect(pieceLine(p('tv-console') as never)).toBe('Storage: 0.4 m³');
  });

  it('the summary to copy', () => {
    const l = furnishedSample();
    const text = copyText(l, storageReport(l, setting()), TYPICAL_RATES, 'Typical');
    expect(text.split('\n').slice(0, 7)).toEqual([
      'Storage for 3 people (Typical)',
      'Who lives here: 1 in Bedroom, 2 in Main bedroom',
      '',
      'Clothes: 1.20 of 3.00 m (4 of 10 ft). Needs 1.80 m more',
      'Shoes: No shoe cabinet drawn · about 28 pairs is usual',
      'Kitchen: 4.8 of 12.0 m of shelves and drawers (2.8 m of cabinets). Needs 7.2 m more',
      'Everything else: 3.7 of 8 m³. Needs 4.3 m³ more',
    ]);
    expect(text).toContain('Main bedroom, 2 adults: 1.20 m of wardrobe; about 2.00 m is usual.');
    expect(text).toContain('Kitchen: Base cabinet 1.2 m of fronts');
    expect(text.trim().endsWith('Count your own clothes and shoes if you can.')).toBe(true);
  });
});
