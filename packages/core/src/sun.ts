import { DEFAULT_SITE, type Project, type Site, type Vec2, type Vec3 } from './schema';

/** Where the sun is: degrees above the horizon, and compass bearing (0 north, 90 east). */
export interface SunPosition {
  altitude: number;
  azimuth: number;
}

const RAD = Math.PI / 180;

export function siteOf(project: Pick<Project, 'site'>): Site {
  return project.site ?? DEFAULT_SITE;
}

/** Day of the year, 1 on 1 January, for a date (its local calendar day). */
export function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getFullYear(), 0, 1);
  const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((day - start) / 86_400_000) + 1;
}

/**
 * The sun as seen from `site` on day `day` at clock time `hour` (0–24, the site's own
 * time zone). NOAA's low-precision formulas: good to a fraction of a degree, which is
 * plenty for light through a window.
 */
export function sunPosition(site: Site, day: number, hour: number): SunPosition {
  const g = ((2 * Math.PI) / 365) * (day - 1 + (hour - 12) / 24);
  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) -
      0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) -
      0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  // True solar time, in minutes; the hour angle is 0 at solar noon, + in the afternoon.
  const solar = hour * 60 + eqTime + 4 * site.longitude - 60 * site.utcOffset;
  const ha = (solar / 4 - 180) * RAD;
  const lat = site.latitude * RAD;
  const sinAlt = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  // Measured from south, + to the west; turned to a compass bearing from north.
  const fromSouth = Math.atan2(
    Math.sin(ha),
    Math.cos(ha) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat),
  );
  const azimuth = (fromSouth / RAD + 180 + 360) % 360;
  return { altitude: altitude / RAD, azimuth };
}

/** The plan direction (a unit vector) of compass bearing `bearing` (degrees from north). */
export function compassToPlan(site: Site, bearing: number): Vec2 {
  const a = bearing * RAD + site.north;
  // Plan up is -y, and clockwise on screen turns it toward +x.
  return { x: Math.sin(a), y: -Math.cos(a) };
}

/** A unit vector in world space (x, y up, z = plan y) pointing at the sun. */
export function sunDirection(site: Site, sun: SunPosition): Vec3 {
  const flat = compassToPlan(site, sun.azimuth);
  const alt = sun.altitude * RAD;
  return { x: Math.cos(alt) * flat.x, y: Math.sin(alt), z: Math.cos(alt) * flat.y };
}

/**
 * How much daylight there is, 0 (night) to 1 (sun well up), easing through dawn and dusk:
 * civil twilight starts at 6° below the horizon.
 */
export function daylight(sun: SunPosition): number {
  const t = Math.max(0, Math.min(1, (sun.altitude + 6) / 21));
  return t * t * (3 - 2 * t);
}
