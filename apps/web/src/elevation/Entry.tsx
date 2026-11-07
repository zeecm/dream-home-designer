import { type Level, type RoomFace, resolveFace } from '@dhd/core';
import { roomFaces } from '@dhd/core';
import { type Selection, useEditor } from '../editor';
import { useStore } from '../store';
import { faceForSelection, roomStart, wallSides } from './nav';
import { lastRoomLooked, openFace } from './open';

/**
 * The ways into the wall view from the Inspector: a wall's sides (named by the room each looks
 * into), a room's walls, and the wall a point, door, window or piece is on. Shown only where
 * there is a room-facing wall to see.
 */

/**
 * On a view link the Inspector's fields are locked, buttons too: the way in is drawn outside
 * them instead (`force`), and not again inside.
 */
function useLocked(force?: boolean): boolean {
  const viewer = useStore((s) => s.role === 'viewer');
  return viewer && !force;
}

/** Whether this face is the one the wall view shows now (its way in is then hidden). */
function useIsOpen(level: Level): (f: RoomFace) => boolean {
  const ref = useEditor((s) => s.elevation?.ref);
  const open = ref ? resolveFace(level, ref) : null;
  return (f) => !!open && open.roomId === f.roomId && open.index === f.index;
}

const entryKey = (f: RoomFace) => `${f.roomId}:${f.index}`;

/** "See it straight on" for a wall: a button per side that looks into a room. */
export function WallViewEntry({
  level,
  wallId,
  force,
}: { level: Level; wallId: string; force?: boolean }) {
  const isOpen = useIsOpen(level);
  const sides = wallSides(level, wallId).filter((f) => !isOpen(f));
  if (useLocked(force) || sides.length === 0) return null;
  return (
    <div className="field elev-entry">
      <span className="field-label" id={`see-${wallId}`}>
        See it straight on
      </span>
      <span className="button-row" aria-labelledby={`see-${wallId}`}>
        {sides.map((f) => (
          <button
            key={`${f.roomId}:${f.index}`}
            type="button"
            className="btn btn-small"
            title="See it straight on (L)"
            data-wall-entry={entryKey(f)}
            onClick={(e) => openFace(level, f, e.currentTarget)}
          >
            {level.rooms[f.roomId]?.name ?? 'Room'} side
          </button>
        ))}
      </span>
    </div>
  );
}

/** "See its walls" for a room: opens at its face A. */
export function RoomViewEntry({
  level,
  roomId,
  force,
}: { level: Level; roomId: string; force?: boolean }) {
  const face = roomStart(level, roomId);
  const isOpen = useIsOpen(level);
  if (useLocked(force) || !face) return null;
  // The room's walls are being stepped round already.
  if (roomFacesOpen(level, roomId, isOpen)) return null;
  return (
    <div className="field elev-entry">
      <button
        type="button"
        className="btn"
        title="See its walls straight on (L)"
        data-wall-entry={`room:${roomId}`}
        onClick={(e) => openFace(level, face, e.currentTarget)}
      >
        See its walls
      </button>
    </div>
  );
}

/** "See on its wall" for a point, opening or piece on or against a wall. */
export function ThingViewEntry({
  level,
  selection,
  force,
}: { level: Level; selection: Selection; force?: boolean }) {
  // An opening's wall: the side towards the room last looked at.
  const face = faceForSelection(level, selection, lastRoomLooked());
  const isOpen = useIsOpen(level);
  if (useLocked(force) || !face || isOpen(face)) return null;
  return (
    <button
      type="button"
      className="btn elev-entry"
      title="See it on its wall, straight on (L)"
      data-wall-entry={`thing:${selection.id}`}
      onClick={(e) => openFace(level, face, e.currentTarget)}
    >
      See on its wall
    </button>
  );
}

/** For a view link (whose Inspector fields are locked): the selection's way in, on its own. */
export function ViewerWallEntry({ level, selection }: { level: Level; selection: Selection }) {
  if (selection.kind === 'wall') return <WallViewEntry level={level} wallId={selection.id} force />;
  if (selection.kind === 'room') return <RoomViewEntry level={level} roomId={selection.id} force />;
  return <ThingViewEntry level={level} selection={selection} force />;
}

/** Whether the wall view is open on one of the room's faces. */
function roomFacesOpen(level: Level, roomId: string, isOpen: (f: RoomFace) => boolean): boolean {
  return roomFaces(level, roomId).some(isOpen);
}
