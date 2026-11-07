import { furnitureKind, newItem } from '../furniture';
import type { Level, Project } from '../schema';
import { hdb4RoomLevel, hdb4RoomProject } from './hdb4room';

/** Every id in a level with `_up` added, so a second level's ids differ from the first's. */
function renamed(level: Level): Level {
  const json = JSON.stringify(level).replace(
    /"((?:v\d+)|(?:(?:w|op|rm)_[a-z0-9_]+))"/g,
    (_, id: string) => `"${id}_up"`,
  );
  return JSON.parse(json) as Level;
}

/**
 * A home on two levels (a maisonette), for the estimate across levels: the reference 4-room
 * plan as "Ground" with a built-in wardrobe in the master bedroom, and again as "Upper", 2.8 m
 * above, with one in bedroom 2. No renovation. The e2e suite opens it as a file
 * (apps/web/e2e/two-levels.dreamhome.json, written from this).
 */
export function twoLevelProject(id = 'prj_two_levels'): Project {
  const ward = furnitureKind('built-in-wardrobe');
  if (!ward) throw new Error('no built-in wardrobe');
  const ground: Level = {
    ...hdb4RoomLevel(),
    items: { it_wardrobe: newItem('it_wardrobe', ward, { x: 9, y: 8.1 }, Math.PI, 2.6) },
  };
  const upper: Level = {
    ...renamed(hdb4RoomLevel()),
    id: 'lvl_upper',
    name: 'Upper',
    elevation: 2.8,
    items: { it_wardrobe_up: newItem('it_wardrobe_up', ward, { x: 6, y: 8.1 }, Math.PI, 2.6) },
  };
  return { ...hdb4RoomProject(id), name: 'Maisonette (two levels)', levels: [ground, upper] };
}

/** projectEstimate(twoLevelProject()) at the typical rates (core and e2e tests check it). */
export const TWO_LEVELS_TOTAL = { low: 5200, high: 8700 };
