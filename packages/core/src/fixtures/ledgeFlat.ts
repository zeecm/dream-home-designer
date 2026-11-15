import type { Level, Opening, Wall } from '../schema';

/**
 * A small flat whose floor has open edges (#72): a bedroom, a living room open along part of
 * its south side to a balcony, and the balcony drawn with room boundaries only (a ledge with
 * no walls). The living room's south boundary is one line, d to e: the balcony lies beyond its
 * east 3 m and nothing beyond its west 2 m, so it is the floor's edge along part of it only.
 * The balcony's other three sides are the floor's edge.
 *
 *   y=0   a -------- b -------------------- c
 *         | Bedroom  |  Living              |
 *   y=3.6 g -------- f                      |
 *   y=4.4            e ------- p ---------- d
 *                              | Balcony    |
 *   y=5.6                      s ---------- r
 *         x=0       3.4       5.4          8.4
 */
const pts: Record<string, [number, number]> = {
  a: [0, 0],
  b: [3.4, 0],
  c: [8.4, 0],
  d: [8.4, 4.4],
  e: [3.4, 4.4],
  f: [3.4, 3.6],
  g: [0, 3.6],
  p: [5.4, 4.4],
  r: [8.4, 5.6],
  s: [5.4, 5.6],
};

const EXT = 0.2;
const INT = 0.1;
const wallDefs: [string, string, string, number, boolean?][] = [
  ['w_top_bed', 'a', 'b', EXT],
  ['w_top_living', 'b', 'c', EXT],
  ['w_east', 'c', 'd', EXT],
  // One boundary line, the balcony beyond its east part only (not split at p).
  ['w_living_south', 'd', 'e', 0, true],
  ['w_living_west', 'e', 'f', EXT],
  ['w_bed_living', 'f', 'b', INT],
  ['w_bed_south', 'f', 'g', EXT],
  ['w_bed_west', 'g', 'a', EXT],
  // The balcony: room boundaries only.
  ['w_balcony_east', 'd', 'r', 0, true],
  ['w_balcony_south', 'r', 's', 0, true],
  ['w_balcony_west', 's', 'p', 0, true],
];

const openings: Opening[] = [
  {
    id: 'op_main',
    wallId: 'w_top_living',
    kind: 'door',
    t: 0.8,
    width: 1.0,
    height: 2.1,
    sill: 0,
    swing: 'leftIn',
  },
  {
    id: 'op_bed',
    wallId: 'w_bed_living',
    kind: 'door',
    t: 0.25,
    width: 0.9,
    height: 2.1,
    sill: 0,
    swing: 'leftIn',
  },
  {
    id: 'op_win_bed',
    wallId: 'w_bed_west',
    kind: 'window',
    t: 0.5,
    width: 1.4,
    height: 1.2,
    sill: 0.9,
  },
  {
    id: 'op_win_living',
    wallId: 'w_top_living',
    kind: 'window',
    t: 0.35,
    width: 1.6,
    height: 1.2,
    sill: 0.9,
  },
];

export function ledgeFlatLevel(): Level {
  const walls: Record<string, Wall> = {};
  for (const [id, a, b, thickness, boundary] of wallDefs) {
    walls[id] = {
      id,
      a,
      b,
      thickness: boundary ? 0.1 : thickness,
      materialLeft: 'paint-white',
      materialRight: 'paint-white',
      ...(boundary ? { kind: 'boundary' as const } : {}),
    };
  }
  const room = (id: string, name: string, loop: string[], floorMaterial: string) => ({
    id,
    name,
    loop,
    floorMaterial,
    ceilingMaterial: 'paint-white',
  });
  return {
    id: 'lvl_ground',
    name: 'Ground',
    elevation: 0,
    ceilingHeight: 2.6,
    vertices: Object.fromEntries(Object.entries(pts).map(([id, [x, y]]) => [id, { id, x, y }])),
    walls,
    openings: Object.fromEntries(openings.map((o) => [o.id, o])),
    rooms: {
      rm_bedroom: room('rm_bedroom', 'Bedroom', ['a', 'b', 'f', 'g'], 'wood-oak'),
      rm_living: room('rm_living', 'Living', ['b', 'c', 'd', 'e', 'f'], 'wood-oak'),
      rm_balcony: room('rm_balcony', 'Balcony', ['p', 'd', 'r', 's'], 'tile-grey'),
    },
    items: {},
    lights: {},
    points: {},
  };
}
