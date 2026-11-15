import { furnitureKind } from '../../furniture';
import { pieceWords } from '../talk/probe';
import { sentences } from '../talk/reply';
import type { LookAnswer, LookFinding } from './findings';
import type { LookClear, LookFacts } from './prompt';

/**
 * The second look's words checked against its own facts (issue #75): two claims, said of what the
 * facts measured otherwise, are taken out, clause by clause (a sentence's parts between
 * semicolons, "but" and "however"). Narrow and deterministic, as the claims filter is; never a
 * reading of the text. A claim after a negation ("no clear way round the bed") or a suggestion
 * ("move it so there is room on both sides") is no claim, and stays.
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

/** Before a claim, a word that says it isn't so ("no", "isn't", "without"). */
const NEGATION = /(?:\b(?:no|not|without|lacks?|lacking|never|nor|hardly|barely)\b|n['’]t\b)/i;
/** Before a claim, a word that makes it a suggestion ("so there is", "would", "move … to"). */
const SUGGESTION =
  /\b(?:so\s+(?:that|there)|to\s+(?:give|make|leave|free|open|get|allow)|would|could|should|might|if|once|until|move\b[^.;!?]*\bto)\b/i;
/** A clause's end: a semicolon (and "however"), "but", or "however,". */
const CLAUSE = /(\s*;\s*(?:however,?\s+)?|,?\s+but\s+|,?\s*\bhowever,\s*)/i;

const ALIAS = /\b[A-Z]{1,3}\d{1,4}\b/g;

/** Whether `re` finds a claim in the clause: said as so, not denied nor suggested. */
const claims = (clause: string, re: RegExp) => {
  const m = re.exec(clause);
  if (!m) return false;
  const before = clause.slice(0, m.index);
  return !NEGATION.test(before) && !SUGGESTION.test(before);
};

/** A piece's kind as it is called: its full name ("coffee table"), and its head word ("table"). */
const kindWords = (assetId: string) => {
  const k = furnitureKind(assetId);
  // "Dining table, 4 seats" is said "4-seat dining table", or "dining table".
  const full = k ? pieceWords(k.name).toLowerCase() : assetId.replace(/-/g, ' ');
  const name = full.replace(/^\d+-seat\s+/, '');
  return { names: [...new Set([full, name])], head: name.split(/\s+/).at(-1) ?? name };
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
  if (ALL_ROUND.some((re) => claims(clause, re))) {
    // The pieces it is said of: named by id or aimed at; else called by their kind's full name in
    // those rooms ("the coffee table"), else by its head word ("the bed").
    const here = facts.pieces.filter((p) => inRooms(p.room));
    const byName = here.filter((p) => kindWords(p.kind).names.some((n) => mentions(clause, n)));
    const byKind = byName.length
      ? byName
      : here.filter((p) => mentions(clause, kindWords(p.kind).head));
    const subjects = [
      ...facts.pieces.filter((p) => named.has(p.id) || p.id === about.piece),
      ...byKind,
    ];
    if (subjects.some((p) => p.clear?.some(shortSide))) return true;
  }
  if (claims(clause, ROOMY)) {
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
    // Clauses at even places, the words between them (kept as written) at odd ones.
    const bits = s.slice(0, s.length - end.length).split(CLAUSE);
    let gone = 0;
    let body = '';
    let dropped = false;
    for (let i = 0; i < bits.length; i += 2) {
      const clause = bits[i] as string;
      if (clause.trim() && contradicted(clause, about, facts)) {
        gone++;
        dropped = true;
        continue;
      }
      if (!clause.trim()) continue;
      // After a clause taken out, the next is joined plainly: its "but" answered that one.
      body += body ? (dropped ? '; ' : (bits[i - 1] ?? '; ')) : '';
      body += clause;
      dropped = false;
    }
    if (!gone) {
      kept.push(s);
      continue;
    }
    removed += gone;
    if (!body.trim()) continue;
    body = body.trim();
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
 * A second look's answer with what its facts contradict taken out: a note (a "consider" with no
 * suggestion) whose line empties goes, a summary that empties is null. A fix, or a finding with a
 * suggestion, is never lost to it: emptied, it keeps its line (a P1–P4 fix is acted on in the
 * app's words, and only where a check agrees: `actOnLook`).
 */
export function lookClaims(
  answer: LookAnswer,
  facts: LookFacts,
): { value: LookAnswer; removed: number } {
  let removed = 0;
  const findings: LookFinding[] = [];
  for (const f of answer.findings) {
    const r = factClaims(f.line, aboutOf(f, facts), facts);
    if (!r.text && (f.severity === 'fix' || f.suggest)) {
      findings.push(f);
      continue;
    }
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
