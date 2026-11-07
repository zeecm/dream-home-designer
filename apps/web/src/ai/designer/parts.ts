import { type Design, type DesignResult, type ResultCheck, roomIdAt } from '@dhd/core';

/**
 * A version's checks sorted out for the card and for Accept (spec docs/specs/ai-designer-v2.md,
 * "When a check fails"): what fails and isn't waived, what was accepted anyway, what was
 * already in the plan, and which part of the version each failure leaves out. Pure, so it is
 * tested on its own.
 */

/** Someone with nowhere to sleep: never folded away, shown first. */
export const isUnplaced = (c: ResultCheck) => c.key.startsWith('P1|unplaced');

/** The room a check is about (its own, or its piece's). */
export function checkRoom(r: DesignResult, c: ResultCheck): string | null {
  if (c.roomId) return c.roomId;
  const it = c.itemId ? r.level.items[c.itemId] : undefined;
  return it ? roomIdAt(r.level, { x: it.position.x, y: it.position.z }) : null;
}

/** Checks in a steady order: people with no bed first, then by room name, then by line. */
export function sortChecks(r: DesignResult, cs: ResultCheck[]): ResultCheck[] {
  const name = (c: ResultCheck) => {
    const id = checkRoom(r, c);
    return id ? (r.level.rooms[id]?.name ?? '') : '';
  };
  return [...cs].sort(
    (p, q) =>
      Number(isUnplaced(q)) - Number(isUnplaced(p)) ||
      name(p).localeCompare(name(q)) ||
      p.text.localeCompare(q.text) ||
      (p.key < q.key ? -1 : 1),
  );
}

/**
 * The hard checks a version caused that fail (unless `waivers` accepts them), those accepted
 * anyway, and those already in the plan. Checks in `pending` rooms (still being designed or
 * fixed) are left out until they are done.
 */
export function failingChecks(
  r: DesignResult,
  d: Pick<Design, 'waivers'>,
  pending: Set<string> = new Set(),
) {
  const waived = new Set((d.waivers ?? []).map((w) => w.key));
  const shown = (c: ResultCheck) => {
    const room = checkRoom(r, c);
    return !room || !pending.has(room);
  };
  const caused = r.checks.filter((c) => c.hard && !c.already && shown(c));
  return {
    open: sortChecks(
      r,
      caused.filter((c) => !waived.has(c.key)),
    ),
    // Accepted anyway stays so once accepted, when the plan has it and it reads as "already".
    waived: sortChecks(
      r,
      r.checks.filter((c) => c.hard && waived.has(c.key) && shown(c)),
    ),
    already: sortChecks(
      r,
      r.checks.filter((c) => c.hard && c.already && !waived.has(c.key)),
    ),
  };
}
