import { roomsBeside } from './designer/spaces';
import { openPlan } from './sceneFacts';
import { type Level, isGlass } from './schema';

/** Below this much daylight (0 to 1, `daylight`) the lamps go on whatever the room. */
export const LAMPS_DAYLIGHT = 0.35;

/**
 * Whether daylight reaches room `roomId` straight from outside: a window, a glazed door, an
 * open doorway or a glass wall between it and no room. Its open-plan neighbours (rooms joined
 * by a boundary, no wall) count too, as the light crosses into them.
 */
export function roomHasDaylight(level: Level, roomId: string): boolean {
  const space = new Set(openPlan(level, roomId));
  const outsideOf = (wallId: string) => {
    const [a, b] = roomsBeside(level, wallId);
    return (a !== null && space.has(a) && b === null) || (b !== null && space.has(b) && a === null);
  };
  for (const o of Object.values(level.openings)) {
    const lets = o.kind === 'window' || o.kind === 'passage' || (o.kind === 'door' && !!o.glazed);
    if (lets && outsideOf(o.wallId)) return true;
  }
  for (const w of Object.values(level.walls)) {
    if (isGlass(w) && outsideOf(w.id)) return true;
  }
  return false;
}

/**
 * The exact render's lamps, left on Auto: on when it's dark (`light` below LAMPS_DAYLIGHT), or
 * when the camera stands in a room daylight doesn't reach; otherwise off. A camera in no room
 * (an orbit view from outside, over the cut-away walls) has the sky's light.
 */
export function lampsAuto(level: Level, cameraRoomId: string | null, light: number): boolean {
  if (light < LAMPS_DAYLIGHT) return true;
  return (
    cameraRoomId !== null && !!level.rooms[cameraRoomId] && !roomHasDaylight(level, cameraRoomId)
  );
}
