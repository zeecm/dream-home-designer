import { furnitureKind } from '../../furniture';
import { sentences } from '../talk/reply';
import type { LookAnswer, LookFinding } from './findings';
import type { LookClear, LookFacts } from './prompt';

/**
 * The second look's words checked against its own facts (issue #75): two claims, said of what the
 * facts measured otherwise, are taken out, clause by clause (a sentence's parts between
 * semicolons). Narrow and deterministic, as the claims filter is; never a reading of the text.
 * - A clear way or room all round a piece (or room on both sides) when the facts measured a side
 *   of it short ("the bed has a clear way round it" for a bed against a wall).
 * - A room that "reads well", is "spacious" or the like, when the designer's own pieces didn't
 *   fit in it ("leftOut" with `didntFit`).
 */

/** A side with less room than it needs (the clearance check's 5 mm slack). */
export const shortSide = (c: LookClear) => c.have < c.need - 0.005;

/** A clear way, room or access all round a piece, or on both sides of it. */
const ALL_ROUND = [
  /\b(?:clear|free|easy|open|good|plenty\s+of|enough)\s+(?:way|path|walk(?:way)?|access|room|space|passage)\s+(?:all\s+(?:the\s+way\s+)?)?(?:a)?round\b/i,
  /\b(?:room|space|clearance|access)\s+all\s+(?:the\s+way\s+)?(?:a)?round\b/i,
  /\b(?:walk|get|move|step)\s+(?:all\s+(?:the\s+way\s+)?)?(?:a)?round\s+(?:it|them|the\b)/i,
  /\b(?:(?:get|got|getting)\s+in(?:to)?|access(?:ible)?|reach(?:ed|able)?|room|space|clearance|way\s+in)\b[^.;!?]{0,24}?\b(?:from|on)\s+(?:both|either|each|all)\s+sides?\b/i,
];

/** A room said to read well, or to be roomy. */
const ROOMY =
  /\b(?:reads?\s+well|works?\s+well|spacious|roomy|airy|uncluttered|uncrowded|generous|not\s+(?:crowded|cramped|cluttered)|plenty\s+of\s+(?:room|space)|room\s+to\s+breathe|feels?\s+(?:open|big|large))\b/i;

const ALIAS = /\b[A-Z]{1,3}\d{1,4}\b/g;

/** The word a piece is called by ("bed" for a queen bed, "wardrobe" for a built-in one). */
const headWord = (assetId: string) => {
  const name = furnitureKind(assetId)?.name.toLowerCase() ?? assetId.replace(/-/g, ' ');
  return name.split(/\s+/).at(-1) ?? name;
};
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text: string, words: string) =>
  new RegExp(`\\b${literal(words)}(?:e?s)?\\b`, 'i').test(text);

/** What a line is about: the rooms (aliases) it is said of, and a piece it is aimed at. */
interface About {
  rooms: string[] | 'all';
  piece: string | null;
}

/** Whether the facts contradict a clause said of `about`. */
function contradicted(clause: string, about: About, facts: LookFacts): boolean {
  const named = new Set(clause.match(ALIAS) ?? []);
  // The rooms it names (by id or name), else the ones the line is about.
  const roomsNamed = facts.rooms
    .filter((r) => named.has(r.id) || mentions(clause, r.name))
    .map((r) => r.id);
  const rooms = roomsNamed.length ? roomsNamed : about.rooms;
  const inRooms = (room: string | null) => rooms === 'all' || (!!room && rooms.includes(room));
  if (ALL_ROUND.some((re) => re.test(clause))) {
    // The pieces it is said of: named by id, aimed at, or called by their kind in those rooms.
    const subjects = facts.pieces.filter(
      (p) =>
        named.has(p.id) ||
        p.id === about.piece ||
        (inRooms(p.room) && mentions(clause, headWord(p.kind))),
    );
    if (subjects.some((p) => p.clear?.some(shortSide))) return true;
  }
  if (ROOMY.test(clause)) {
    const crowded = (facts.leftOut ?? []).filter((l) => l.didntFit);
    if (crowded.some((l) => l.rooms.some((r) => rooms === 'all' || rooms.includes(r)))) return true;
  }
  return false;
}

/** A text with each clause the facts contradict taken out, and how many went. */
export function factClaims(
  text: string,
  about: About,
  facts: LookFacts,
): { text: string; removed: number } {
  let removed = 0;
  const kept: string[] = [];
  for (const s of sentences(text)) {
    if (s.startsWith('\n')) {
      kept.push(s);
      continue;
    }
    const end = /[.!?]+["”’)]*\s*$/.exec(s)?.[0] ?? '';
    const parts = s.slice(0, s.length - end.length).split(/\s*;\s*/);
    const ok = parts.filter((p) => !p.trim() || !contradicted(p, about, facts));
    const gone = parts.length - ok.length;
    if (!gone) {
      kept.push(s);
      continue;
    }
    removed += gone;
    const body = ok.filter((p) => p.trim()).join('; ');
    if (!body) continue;
    const ws = /\s*$/.exec(end)?.[0] ?? '';
    kept.push(`${body.charAt(0).toUpperCase()}${body.slice(1)}${end.trim() || '.'}${ws || ' '}`);
  }
  return { text: removed ? kept.join('').trim() : text, removed };
}

/** The room a finding is said of: its room, its piece's room, else every room it looks at. */
function aboutOf(f: LookFinding, facts: LookFacts): About {
  const { kind, id } = f.target;
  if (kind === 'room') return { rooms: [id], piece: null };
  if (kind === 'piece') {
    const room = facts.pieces.find((p) => p.id === id)?.room;
    return { rooms: room ? [room] : 'all', piece: id };
  }
  return { rooms: 'all', piece: null };
}

/**
 * A second look's answer with what its facts contradict taken out: a finding whose line empties
 * goes (as the claims filter's would), a summary that empties is null.
 */
export function lookClaims(
  answer: LookAnswer,
  facts: LookFacts,
): { value: LookAnswer; removed: number } {
  let removed = 0;
  const findings: LookFinding[] = [];
  for (const f of answer.findings) {
    const r = factClaims(f.line, aboutOf(f, facts), facts);
    removed += r.removed;
    if (r.text) findings.push(r.removed ? { ...f, line: r.text } : f);
  }
  let summary = answer.summary;
  if (summary) {
    const r = factClaims(summary, { rooms: 'all', piece: null }, facts);
    removed += r.removed;
    summary = r.text || null;
  }
  return { value: removed ? { findings, summary } : answer, removed };
}
