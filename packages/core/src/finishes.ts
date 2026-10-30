/**
 * Floor finishes and wall paints: the ids a room's floorMaterial and a wall side's material
 * hold, with the colour the plan and the 3D view show. Phase 3's PBR textures can replace
 * the colours later without changing any id saved in a project.
 */
export interface Finish {
  id: string;
  name: string;
  color: string;
  roughness: number;
}

export const FLOOR_FINISHES: Finish[] = [
  { id: 'wood-oak', name: 'Oak', color: '#c49a6c', roughness: 0.7 },
  { id: 'wood-walnut', name: 'Walnut', color: '#7a5233', roughness: 0.65 },
  { id: 'vinyl-ash', name: 'Ash vinyl', color: '#cdb99c', roughness: 0.6 },
  { id: 'tile-grey', name: 'Grey tile', color: '#b8b8b4', roughness: 0.4 },
  { id: 'tile-white', name: 'White tile', color: '#e7e4de', roughness: 0.35 },
  { id: 'marble', name: 'Marble', color: '#e9e6e0', roughness: 0.2 },
  { id: 'concrete', name: 'Polished concrete', color: '#a7a6a2', roughness: 0.5 },
  { id: 'carpet-grey', name: 'Grey carpet', color: '#8c8f93', roughness: 1 },
  { id: 'paint-white', name: 'Plain', color: '#f2efe9', roughness: 0.9 },
];

export const PAINTS: Finish[] = [
  { id: 'paint-white', name: 'White', color: '#f2efe9', roughness: 0.9 },
  { id: 'paint-warm', name: 'Warm white', color: '#efe4d2', roughness: 0.9 },
  { id: 'paint-grey', name: 'Pale grey', color: '#d3d4d2', roughness: 0.9 },
  { id: 'paint-sage', name: 'Sage', color: '#bccab3', roughness: 0.9 },
  { id: 'paint-sky', name: 'Sky', color: '#c6d7e4', roughness: 0.9 },
  { id: 'paint-blush', name: 'Blush', color: '#e9cfc6', roughness: 0.9 },
  { id: 'paint-sand', name: 'Sand', color: '#dfcfb0', roughness: 0.9 },
  { id: 'paint-charcoal', name: 'Charcoal', color: '#4b4e52', roughness: 0.85 },
];

const all = new Map([...PAINTS, ...FLOOR_FINISHES].map((f) => [f.id, f]));

/** A finish by id, for floors, ceilings and wall sides. */
export const finish = (id: string): Finish | undefined => all.get(id);
