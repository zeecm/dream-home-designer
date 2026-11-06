import {
  type Delivery,
  type DoorOnTheWay,
  type Level,
  type Lift,
  type LiftFit,
  type LiftPose,
  worstDoor,
} from '@dhd/core';
import { formatLength } from '../units';

/** The way in, in words (kept apart from the app's state, so it can be tested alone). */

/** A door's name: the main door (the first on the way), or by the room it leads into. */
const doorName = (level: Level, d: DoorOnTheWay, main?: string) =>
  d.openingId === 'lift'
    ? 'the lift door'
    : d.openingId === main || !d.into
      ? 'the main door'
      : `the ${level.rooms[d.into]?.name ?? 'room'} door`;

/** A length that doesn't break between its number and its unit. */
export const nb = (t: string) => t.replace(' ', '\u00a0');
const len = (m: number) => nb(formatLength(m));

/** A lift's numbers: "Door 0.90 × 2.00 m · car 1.10 wide × 1.40 deep × 2.30 m high". */
export const liftNumbers = (l: Lift) =>
  `Door ${l.door.width.toFixed(2)} × ${len(l.door.height)} · car ${l.car.width.toFixed(2)} wide × ${l.car.depth.toFixed(2)} deep × ${len(l.car.height)} high`;

/** Why it doesn't go in the lift, in a sentence. */
function liftVerdict(lift: Lift, f: LiftFit): string {
  if (f.fails === 'door') {
    return `Too big for the lift door: ${len(lift.door.width)} wide; it needs ${len(f.need ?? 0)} on its side.`;
  }
  if (f.standUp) {
    // What the family measured: the door's height and the car's side, not the limit worked out.
    const u = f.standUp;
    return `Too long to stand up in the lift: at ${len(u.need)} long, it can’t be turned upright through a ${len(u.door)} high door into a ${len(u.room)} ${u.side === 'depth' ? 'deep' : 'wide'} car.`;
  }
  const c = lift.car;
  return `Doesn’t fit in the lift (${c.width.toFixed(2)} × ${len(c.depth)}, ${len(c.height)} high), even on end or tilted.`;
}

const POSE: Record<LiftPose, string> = {
  upright: 'as it stands',
  back: 'on its back',
  end: 'stood on end',
  tilted: 'tilted',
};

/** How it goes in the lift (null when it doesn't). */
export function liftLine(f: LiftFit): string | null {
  if (f.fit === 'too-big' || !f.how) return null;
  if (f.fit === 'fits') return `Lift: fits ${POSE[f.how]}.`;
  // At an angle in the car there's no slack to count on: nothing to say how much.
  const mm = Math.round(f.spare * 1000);
  return `Lift: just fits, ${POSE[f.how]}${mm > 0 ? ` (${mm} mm to spare)` : ''}.`;
}

/** The verdict in a sentence: the lift's, if it doesn't go in the lift, else the doors'. */
export function deliveryText(level: Level, r: Delivery, lift?: Lift | null): string {
  switch (r.status) {
    case 'no-room':
      return 'Put it in a room to check the way in.';
    case 'no-door':
      return 'Add the main door first.';
    case 'unreachable':
      return 'There’s no way in to this room through the doors drawn.';
    default: {
      if (lift && r.lift?.fit === 'too-big') return liftVerdict(lift, r.lift);
      // The doors of the flat; the lift has its own line.
      const doors = r.doors.filter((d) => d.openingId !== 'lift');
      const w = worstDoor(doors);
      const status = w?.fit ?? 'fits';
      if (!w) return 'Fits through every door on the way in.';
      const where = doorName(level, w, r.from);
      if (status === 'fits' || status === 'tight') {
        // The door it's tightest through (the worst), else the narrowest.
        const narrowest =
          status === 'tight' ? w : doors.reduce((p, q) => (q.clear < p.clear ? q : p));
        const head =
          status === 'tight'
            ? 'Just fits through every door on the way in'
            : 'Fits through every door on the way in';
        const tilted = narrowest.tilted ? ' (tilted on its diagonal)' : '';
        const other = doors.find((d) => d.tilted && d !== narrowest);
        const also = other
          ? ` Tilted on its diagonal through ${doorName(level, other, r.from)}.`
          : '';
        return `${head}. Narrowest: ${doorName(level, narrowest, r.from)}, ${len(narrowest.clear)}${tilted}.${also}`;
      }
      if (status === 'hinges') {
        return `Fits through ${where} with the door off its hinges (${nb(formatLength(w.clear))} clear with it on).`;
      }
      if (w.turn) {
        return `Can’t turn through ${where} from the ${nb(formatLength(w.turn.space))} space in front.`;
      }
      return `Too big for ${where}: ${nb(formatLength(w.clear))} wide; it needs ${nb(formatLength(w.need ?? 0))} on its side.`;
    }
  }
}

/** A bed's verdict, softened: the check treats it as a rigid box, which a mattress isn't. */
export const asRigid = (verdict: string) =>
  `Checked as a rigid box, ${verdict.charAt(0).toLowerCase()}${verdict.slice(1)}`;

/** The lift's line under the verdict: how it goes in, or why there's nothing to say. */
export function liftStatus(lift: Lift | null | undefined, f: LiftFit | undefined): string | null {
  if (lift === undefined) return 'Lift: not checked.';
  if (lift === null) return 'No lift on the way in.';
  if (!f) return null;
  if (f.fit === 'too-big') {
    return lift.preset === 'measured'
      ? 'Ask the shop whether it comes apart.'
      : 'Ask the shop whether it comes apart, or measure your lift: these sizes are typical.';
  }
  return liftLine(f);
}
