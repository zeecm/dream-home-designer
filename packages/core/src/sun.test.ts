import { describe, expect, it } from 'vitest';
import { DEFAULT_SITE } from './schema';
import { compassToPlan, dayOfYear, daylight, sunDirection, sunPosition } from './sun';

const SG = DEFAULT_SITE;
const MARCH_20 = 79;
const JUNE_21 = 172;
const DEC_21 = 355;

describe('sunPosition', () => {
  it('is nearly overhead at solar noon on the equinox in Singapore (about 1:10 pm)', () => {
    const noon = sunPosition(SG, MARCH_20, 13 + 10 / 60);
    expect(noon.altitude).toBeGreaterThan(87);
  });

  it('rises in the east around 7 am and sets in the west around 7:15 pm', () => {
    const morning = sunPosition(SG, MARCH_20, 9);
    expect(morning.azimuth).toBeGreaterThan(85);
    expect(morning.azimuth).toBeLessThan(95);
    expect(sunPosition(SG, MARCH_20, 6.5).altitude).toBeLessThan(0);
    expect(sunPosition(SG, MARCH_20, 7.5).altitude).toBeGreaterThan(0);
    const evening = sunPosition(SG, MARCH_20, 17);
    expect(evening.azimuth).toBeGreaterThan(265);
    expect(evening.azimuth).toBeLessThan(275);
    expect(sunPosition(SG, MARCH_20, 19.5).altitude).toBeLessThan(0);
  });

  it('stands north of Singapore at noon in June and south in December', () => {
    const june = sunPosition(SG, JUNE_21, 13.1);
    expect(Math.min(june.azimuth, 360 - june.azimuth)).toBeLessThan(10);
    expect(june.altitude).toBeCloseTo(90 - (23.44 - 1.35), 0);
    const dec = sunPosition(SG, DEC_21, 12.9);
    expect(Math.abs(dec.azimuth - 180)).toBeLessThan(10);
  });

  it('is below the horizon at midnight', () => {
    expect(sunPosition(SG, JUNE_21, 0).altitude).toBeLessThan(-60);
  });

  it('follows latitude: London at noon in June is about 62° up, due south', () => {
    const london = { north: 0, latitude: 51.5, longitude: 0, utcOffset: 1 };
    const s = sunPosition(london, JUNE_21, 13);
    expect(s.altitude).toBeCloseTo(62, 0);
    expect(Math.abs(s.azimuth - 180)).toBeLessThan(5);
  });
});

describe('compassToPlan', () => {
  it('puts north up the plan (-y) and east to the right when north is 0', () => {
    const n = compassToPlan(SG, 0);
    expect(n.x).toBeCloseTo(0);
    expect(n.y).toBeCloseTo(-1);
    const e = compassToPlan(SG, 90);
    expect(e.x).toBeCloseTo(1);
    expect(e.y).toBeCloseTo(0);
  });

  it('turns with the site: north pointing to the plan right puts east down it', () => {
    const site = { ...SG, north: Math.PI / 2 };
    expect(compassToPlan(site, 0).x).toBeCloseTo(1);
    expect(compassToPlan(site, 90).y).toBeCloseTo(1);
  });
});

describe('sunDirection', () => {
  it('points up and toward the sun in world space (z is plan y)', () => {
    const d = sunDirection(SG, { altitude: 30, azimuth: 90 });
    expect(d.y).toBeCloseTo(0.5);
    expect(d.x).toBeCloseTo(Math.cos(Math.PI / 6));
    expect(d.z).toBeCloseTo(0);
    expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1);
  });
});

describe('daylight and dayOfYear', () => {
  it('is 0 at night, 1 by day, and in between at dusk', () => {
    expect(daylight({ altitude: -20, azimuth: 0 })).toBe(0);
    expect(daylight({ altitude: 40, azimuth: 0 })).toBe(1);
    const dusk = daylight({ altitude: 0, azimuth: 270 });
    expect(dusk).toBeGreaterThan(0);
    expect(dusk).toBeLessThan(1);
  });

  it('counts days from 1 January', () => {
    expect(dayOfYear(new Date(2026, 0, 1))).toBe(1);
    expect(dayOfYear(new Date(2026, 2, 20))).toBe(MARCH_20);
    expect(dayOfYear(new Date(2026, 11, 31))).toBe(365);
  });
});
