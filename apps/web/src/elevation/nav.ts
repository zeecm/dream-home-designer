import {
  type FaceRef,
  type Level,
  type RoomFace,
  faceAt,
  faceRef,
  itemFace,
  otherSide,
  resolveFace,
  roomFaces,
  stepFace,
  steppableFaces,
} from '@dhd/core';
import type { Selection } from '../editor';

/**
 * Finding faces for the wall view: which face a selection opens, stepping round a room and
 * seeing a wall from the other side. Pure: the editor keeps the ref, nothing is saved.
 */

/** The faces of a wall that look into a room: left, then right, with each one's room. */
export function wallSides(level: Level, wallId: string): RoomFace[] {
  return [faceAt(level, wallId, 'left'), faceAt(level, wallId, 'right')].filter(
    (f): f is RoomFace => !!f,
  );
}

/** Of a wall's sides, the one looking into `preferRoom` if it does, else the first. */
function pickSide(level: Level, wallId: string, preferRoom: string | null): RoomFace | null {
  const sides = wallSides(level, wallId);
  return sides.find((f) => f.roomId === preferRoom) ?? sides[0] ?? null;
}

/** A room's first face stepping stops at (A, as a rule). */
export function roomStart(level: Level, roomId: string): RoomFace | null {
  const faces = roomFaces(level, roomId);
  return steppableFaces(faces)[0] ?? faces[0] ?? null;
}

/**
 * The face a selection opens: a wall's side (towards `preferRoom`, the room last looked at,
 * if it faces it), a room's face A, the face a point is on, an opening's wall, or the wall a
 * piece stands against. Null when there is none (an outside wall, a piece in the room).
 */
export function faceForSelection(
  level: Level,
  sel: Selection | null,
  preferRoom: string | null = null,
): RoomFace | null {
  if (!sel) return null;
  switch (sel.kind) {
    case 'wall':
      return pickSide(level, sel.id, preferRoom);
    case 'room':
      return roomStart(level, sel.id);
    case 'point': {
      const w = level.points?.[sel.id]?.wall;
      return w ? faceAt(level, w.wallId, w.side) : null;
    }
    case 'opening': {
      const o = level.openings[sel.id];
      return o ? pickSide(level, o.wallId, preferRoom) : null;
    }
    case 'item':
      return itemFace(level, sel.id);
    default:
      return null;
  }
}

/** The ref of the face `by` steps round the room from `ref` (skipping tiny empty returns). */
export function stepRef(level: Level, ref: FaceRef, by: 1 | -1): FaceRef | null {
  const face = resolveFace(level, ref);
  if (!face) return null;
  return faceRef(stepFace(roomFaces(level, face.roomId), face, by));
}

/** The same wall seen from the room on its other side, or null if none faces it. */
export function flipRef(level: Level, ref: FaceRef): FaceRef | null {
  const face = resolveFace(level, ref);
  const other = face && otherSide(level, face);
  return other ? faceRef(other) : null;
}

/** "C of 4": the face's place among those stepping stops at. */
export function facePlace(level: Level, face: RoomFace): { at: number; of: number } {
  const list = steppableFaces(roomFaces(level, face.roomId));
  const i = list.findIndex((f) => f.index === face.index);
  return { at: i + 1, of: list.length };
}

/** The file name a saved picture of a face gets: "Main bedroom – C bed wall.png". */
export function imageName(roomName: string, face: Pick<RoomFace, 'letter' | 'label'>): string {
  const what = face.label ? `${face.letter} ${face.label}` : `Wall ${face.letter}`;
  return `${roomName} – ${what}.png`.replace(/[\\/:*?"<>|]+/g, ' ');
}
