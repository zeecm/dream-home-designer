import { newId } from './ids';
import { type Level, type Project, SCHEMA_VERSION } from './schema';

export function emptyLevel(id = 'lvl_ground'): Level {
  return {
    id,
    name: 'Ground',
    elevation: 0,
    ceilingHeight: 2.6,
    vertices: {},
    walls: {},
    openings: {},
    rooms: {},
    items: {},
    lights: {},
  };
}

/** A blank single-level project, ready to trace. */
export function blankProject(name = 'Untitled plan', id = newId('prj')): Project {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    version: 0,
    name,
    units: 'm',
    underlay: null,
    levels: [emptyLevel()],
  };
}
