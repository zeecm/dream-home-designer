import { describe, expect, it } from 'vitest';
import { EASE_ITEMS, defaultFlatType, dollars, easeItems } from './ease';
import { sampleFlatProject } from './fixtures/sampleFlat';
import type { Level } from './schema';

describe('EASE', () => {
  it('26. the flat type follows the bedrooms; the sample (2 bedrooms) is 1, 2 or 3-room', () => {
    const lvl = sampleFlatProject('prj_t').levels[0] as Level;
    expect(defaultFlatType(lvl)).toBe('1-3');
    const rooms = Object.values(lvl.rooms);
    const named = (n: number) => {
      const extra = rooms.filter((r) => /bath|kitchen/i.test(r.name)).slice(0, n);
      return {
        ...lvl,
        rooms: Object.fromEntries(
          rooms.map((r) => [
            r.id,
            extra.includes(r) ? { ...r, name: `Bedroom ${extra.indexOf(r) + 3}` } : r,
          ]),
        ),
      };
    };
    expect(defaultFlatType(named(1))).toBe('4');
    expect(defaultFlatType(named(2))).toBe('5');
    expect(defaultFlatType(named(3))).toBe('5');
  });

  it('26. the prices for each type, and what shows when', () => {
    const always = easeItems('4', { bathrooms: 1, doorFails: false });
    expect(always.map((i) => i.item.id)).toEqual([
      'grab-bars-first',
      'slip-resistant',
      'shower-seat',
      'rocker-switches',
    ]);
    expect(always.map((i) => dollars(i.cents))).toEqual(['$39.20', '$35.95', '$22.85', '$20.40']);
    const two = easeItems('exec', { bathrooms: 2, doorFails: true });
    expect(two.map((i) => [i.item.id, dollars(i.cents)])).toEqual([
      ['grab-bars-first', '$65.40'],
      ['grab-bars-second', '$38.15'],
      ['slip-resistant', '$59.95'],
      ['widen-entrance', '$163.50'],
      ['shower-seat', '$38.15'],
      ['rocker-switches', '$34.05'],
    ]);
    const small = easeItems('1-3', { bathrooms: 2, doorFails: true });
    expect(small.find((i) => i.item.id === 'widen-entrance')?.cents).toBe(6540);
    expect(easeItems('5', { bathrooms: 1, doorFails: false })[0]?.cents).toBe(5230);
    // Slice 2's kerbs and steps aren't known yet.
    expect(
      easeItems('4', { bathrooms: 1, doorFails: true, kerb: true }).map((i) => i.item.id),
    ).toContain('widen-and-lower');
    expect(easeItems('none', { bathrooms: 2, doorFails: true })).toEqual([]);
    // No bathroom drawn: none of the toilet's items.
    expect(easeItems('4', { bathrooms: 0, doorFails: false }).map((i) => i.item.id)).toEqual([
      'rocker-switches',
    ]);
    for (const it of EASE_ITEMS) expect(it.cents.every((c) => Number.isInteger(c))).toBe(true);
  });
});
