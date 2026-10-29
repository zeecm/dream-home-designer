import { type Level, type Opening, type Project, SCHEMA_VERSION, type Wall } from '../schema';

/**
 * Reference plan: a simplified 4-room HDB-style flat, about 93 m².
 * Living | Kitchen across the front, three bedrooms across the back.
 *
 *   y=0   v0 ------ v1 ----------------- v2
 *         | Living  |      Kitchen        |
 *   y=4.5 v8 -- v11 - v9 ------ v10 ---- v3
 *         | Bed 3 |  Bed 2      | Master  |
 *   y=8.5 v7 ---- v6 --------- v5 ------ v4
 *         x=0    3.5   5        7        11
 */
const pts: Record<string, [number, number]> = {
  v0: [0, 0],
  v1: [5, 0],
  v2: [11, 0],
  v3: [11, 4.5],
  v4: [11, 8.5],
  v5: [7, 8.5],
  v6: [3.5, 8.5],
  v7: [0, 8.5],
  v8: [0, 4.5],
  v9: [5, 4.5],
  v10: [7, 4.5],
  v11: [3.5, 4.5],
};

const EXT = 0.2;
const INT = 0.1;
const wallDefs: [string, string, string, number][] = [
  ['w_front_l', 'v0', 'v1', EXT],
  ['w_front_r', 'v1', 'v2', EXT],
  ['w_right_f', 'v2', 'v3', EXT],
  ['w_right_b', 'v3', 'v4', EXT],
  ['w_back_r', 'v4', 'v5', EXT],
  ['w_back_m', 'v5', 'v6', EXT],
  ['w_back_l', 'v6', 'v7', EXT],
  ['w_left_b', 'v7', 'v8', EXT],
  ['w_left_f', 'v8', 'v0', EXT],
  ['w_mid_1', 'v8', 'v11', INT],
  ['w_mid_2', 'v11', 'v9', INT],
  ['w_mid_3', 'v9', 'v10', INT],
  ['w_mid_4', 'v10', 'v3', INT],
  ['w_living_kitchen', 'v1', 'v9', INT],
  ['w_bed3_bed2', 'v11', 'v6', INT],
  ['w_bed2_master', 'v10', 'v5', INT],
];

const door = (id: string, wallId: string, t: number, width = 0.9): Opening => ({
  id,
  wallId,
  kind: 'door',
  t,
  width,
  height: 2.1,
  sill: 0,
  swing: 'leftIn',
});
const window_ = (id: string, wallId: string, t: number, width: number): Opening => ({
  id,
  wallId,
  kind: 'window',
  t,
  width,
  height: 1.2,
  sill: 0.9,
});

const openings: Opening[] = [
  door('op_main', 'w_front_l', 0.25, 1.0),
  { id: 'op_kitchen', wallId: 'w_living_kitchen', kind: 'passage', t: 0.5, width: 1.6, height: 2.1, sill: 0 },
  door('op_bed3', 'w_mid_1', 0.7),
  door('op_bed2', 'w_mid_2', 0.5),
  door('op_master', 'w_mid_3', 0.5),
  window_('op_win_living', 'w_left_f', 0.5, 2.0),
  window_('op_win_kitchen', 'w_front_r', 0.6, 1.8),
  window_('op_win_bed3', 'w_back_l', 0.5, 1.4),
  window_('op_win_bed2', 'w_back_m', 0.5, 1.6),
  window_('op_win_master', 'w_back_r', 0.5, 2.0),
];

export function hdb4RoomLevel(): Level {
  const walls: Record<string, Wall> = {};
  for (const [id, a, b, thickness] of wallDefs) {
    walls[id] = { id, a, b, thickness, materialLeft: 'paint-white', materialRight: 'paint-white' };
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
      rm_living: room('rm_living', 'Living', ['v0', 'v1', 'v9', 'v11', 'v8'], 'wood-oak'),
      rm_kitchen: room('rm_kitchen', 'Kitchen', ['v1', 'v2', 'v3', 'v10', 'v9'], 'tile-grey'),
      rm_bed3: room('rm_bed3', 'Bedroom 3', ['v8', 'v11', 'v6', 'v7'], 'wood-oak'),
      rm_bed2: room('rm_bed2', 'Bedroom 2', ['v11', 'v9', 'v10', 'v5', 'v6'], 'wood-oak'),
      rm_master: room('rm_master', 'Master bedroom', ['v10', 'v3', 'v4', 'v5'], 'wood-walnut'),
    },
    items: {},
    lights: {},
  };
}

export function hdb4RoomProject(id = 'prj_demo'): Project {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    version: 0,
    name: '4-room HDB (reference)',
    units: 'm',
    underlay: null,
    levels: [hdb4RoomLevel()],
  };
}
