import {
  type DesignProblem,
  type DesignResult,
  type Level,
  type Note,
  furnitureKind,
  roomIdAt,
  roomsBeside,
} from '@dhd/core';

/**
 * The designer's notes and problems in the household's words: which room each is about, no
 * internal ids (W12, P99), grouped by room, each said once.
 */

const roomName = (level: Level, id: string | null | undefined) =>
  (id && level.rooms[id]?.name) || null;

/** A wall in words: "a wall in the Kitchen", "the wall between Kitchen and Living". */
function wallWords(level: Level, wallId: string): string {
  const [l, r] = roomsBeside(level, wallId).map((id) => roomName(level, id));
  if (l && r && l !== r) return `the wall between ${l} and ${r}`;
  const one = l ?? r;
  return one ? `a wall in the ${one}` : 'an outside wall';
}

/**
 * `text` with any alias the prompts used (W3, D2, R1, P4) put in words, from what it stands
 * for on `level` (or `base`, the plan it was designed on). A line naming something that
 * isn't there at all is said again whole ("the designer named a wall that isn't on the plan").
 */
export function humanize(
  text: string,
  aliases: Record<string, string>,
  level: Level,
  base?: Level,
): string {
  return humanizeOnly(text, aliases, level, base);
}

/**
 * A line that doesn't break inside a measurement or a hyphenated name: "0.35\u00a0m",
 * "3\u2011seat".
 */
export const keepTogether = (s: string) =>
  s.replace(/(\d) (m|mm|cm|°)\b/g, '$1\u00a0$2').replace(/(\w)-(\w)/g, '$1\u2011$2');

function humanizeOnly(
  text: string,
  aliases: Record<string, string>,
  level: Level,
  base?: Level,
): string {
  let unknown: string | null = null;
  const out = text.replace(/\b([WDRP])(\d{1,3})\b/g, (whole, kind: string, n: string) => {
    const id = aliases[`${kind}${n}`];
    const on = (l: Level | undefined) => {
      if (!id || !l) return null;
      if (kind === 'W' && l.walls[id]) return wallWords(l, id);
      if (kind === 'R' && l.rooms[id]) return `the ${l.rooms[id]?.name}`;
      if (kind === 'D' && l.openings[id]) {
        const o = l.openings[id];
        const what =
          o?.kind === 'window' ? 'a window' : o?.kind === 'door' ? 'a door' : 'an opening';
        return o ? `${what} in ${wallWords(l, o.wallId)}` : what;
      }
      if (kind === 'P' && l.items[id]) {
        const name = furnitureKind(l.items[id]?.assetId ?? '')?.name;
        return name ? `your ${name.toLowerCase()}` : 'your piece';
      }
      return null;
    };
    const words = on(level) ?? on(base);
    if (!words) unknown ??= kind;
    return words ?? whole;
  });
  // A name the designer made up: the line as a whole, in words, rather than "a wall a wall".
  return unknown ? (UNKNOWN[unknown] ?? out) : out;
}

/** What a line about something not on the plan says instead. */
const UNKNOWN: Record<string, string> = {
  W: 'One wall change was left out: the designer named a wall that isn’t on the plan.',
  D: 'One change was left out: the designer named a door or opening that isn’t on the plan.',
  R: 'One room was left out: the designer named a room that isn’t on the plan.',
  P: 'One piece was left out: the designer named a piece of yours that isn’t in the flat.',
};

/** The room a problem is in, by name, if it says. */
export function problemRoom(p: DesignProblem, level: Level): string | null {
  if (p.roomId) return roomName(level, p.roomId);
  const it = p.itemId ? level.items[p.itemId] : undefined;
  if (it) return roomName(level, roomIdAt(level, { x: it.position.x, y: it.position.z }));
  const o = p.openingId ? level.openings[p.openingId] : undefined;
  if (o)
    return (
      roomsBeside(level, o.wallId)
        .map((id) => roomName(level, id))
        .find((n) => !!n) ?? null
    );
  return null;
}

/** A note's room (or space), by name. */
function noteRoom(n: Note, r: DesignResult): string | null {
  if (n.space) {
    const s = r.spaces.find((x) => x.key === n.space);
    if (s) return s.name;
  }
  if (n.roomId) return roomName(r.level, n.roomId);
  if (n.wallId) {
    const names = roomsBeside(r.level, n.wallId).map((id) => roomName(r.level, id));
    return names.find((x) => !!x) ?? null;
  }
  return null;
}

/** Notes grouped by room ("Whole flat" first for those about no room), each said once. */
export function byRoom(
  notes: Note[],
  r: DesignResult,
  aliases: Record<string, string>,
  base?: Level,
): { room: string; lines: string[] }[] {
  const groups = new Map<string, Set<string>>();
  for (const n of notes) {
    const room = noteRoom(n, r) ?? 'Whole flat';
    const line = humanize(n.text, aliases, r.level, base);
    let g = groups.get(room);
    if (!g) {
      g = new Set();
      groups.set(room, g);
    }
    g.add(line);
  }
  return [...groups]
    .sort(([a], [b]) => (a === 'Whole flat' ? -1 : b === 'Whole flat' ? 1 : a.localeCompare(b)))
    .map(([room, lines]) => ({ room, lines: [...lines] }));
}

/** Fixed for you, without the pieces that were left out in the end (they weren't fixed). */
export function fixedNotes(r: DesignResult): Note[] {
  const gone = new Set(r.dropped.filter((n) => n.ref).map((n) => `${n.space ?? ''}|${n.ref}`));
  return r.repaired.filter((n) => !n.ref || !gone.has(`${n.space ?? ''}|${n.ref}`));
}
