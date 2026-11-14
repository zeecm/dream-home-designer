import { furnitureKind } from '../furniture';
import { type AliasMap, aliasOf } from './aliases';
import { type Role, peopleOf, roleOf } from './principles';
import type { DesignResult, ResultCheck } from './result';
import type { DesignBrief, DesignInput, FixRound } from './schema';
import { roomIdAt } from './spaces';
import { personLabel } from './talk/firstMeeting';
import { pieceWords } from './talk/probe';
import { clean } from './util';
import type { DropCode, Note } from './walls';

/**
 * A version's run report (spec docs/specs/designer-listens.md §1): built once, deterministically,
 * from its result and its stored fix rounds, and the one source for everything that says how it
 * was checked. The talk call's On the table (F and L lines), a fix round's prompt (L lines), the
 * card's lead, its Checks row, the On the table bar, the folded line and the announcement.
 *
 * F lines are the hard checks the version causes (not already in the plan, not accepted
 * anyway), one line per failure as the person reads it: the same check on four dining chairs is
 * one line ("4 dining chairs aren’t at a table"), and the household's people left without a bed
 * in one room for one reason are one line ("You and Partner have no bed in Main bedroom"). A
 * line counts as one, everywhere. They are ordered by how much they matter: people without a
 * bedroom or a bed first, then HDB rules, seats and dining, then the rest. L lines are the pieces
 * the answer asked for that the app left out, each with a to-fix hint picked by its reason's
 * code. Lines for the model carry the plan's short ids (R2, P7) and the answer's refs; what the
 * person reads never does, and names people as What I know does.
 */

/** At most this many F and L lines go to a model, each at most LINE_MAX characters. */
export const REPORT_MAX = 8;
export const LINE_MAX = 300;

export interface ReportFailure {
  /** F1, F2, … */
  id: string;
  /** The first check's key, and every check the line stands for. */
  key: string;
  keys: string[];
  /**
   * principle|code|room|role of each check, space-separated: the same failure across runs
   * (item ids are new each run).
   */
  sig: string;
  /** The app's own words (several checks: merged, "Adult 1 and Adult 2 have no bed …"). */
  text: string;
  /** The same, as the person reads it (their names, never "Adult 1"). */
  says: string;
  /** How many checks the line stands for. */
  count: number;
  roomId: string | null;
  room: string | null;
  /** The pieces: the answer's ref for a piece it placed, else the short id (a kept or plan piece). */
  pieces: string[];
  assetId: string | null;
  waivable: boolean;
  unfixable: boolean;
  /** Why, for the person: a measured cause (from a piece left out), or how often it was tried. */
  cause: string | null;
  /** The piece left out that causes it (its L id), when there is one. */
  causedBy: string | null;
}

export interface ReportLeftOut {
  /** L1, L2, … */
  id: string;
  ref: string;
  assetId: string | null;
  /** The space it was asked for (its key and name). */
  space: string | null;
  room: string | null;
  text: string;
  code: DropCode | null;
  /** What to do about it, for the model (with the plan's ids). */
  hint: string;
  /** The measured cause, for the person (no ids), when there is one. */
  cause: string | null;
  /** In the person's words: "The queen bed in Main bedroom was left out". */
  says: string;
  role: Role;
  /** The failure it causes (its F id), when it causes a counted one. */
  causes: string | null;
}

export interface ReportRoom {
  key: string;
  name: string;
  /** Fix requests sent for it, and the problems they fixed (the room tried alone). */
  fixes: number;
  fixed: number;
  rounds: FixRound[];
}

export interface RunReport {
  failures: ReportFailure[];
  leftOut: ReportLeftOut[];
  rooms: ReportRoom[];
}

export interface ReportOptions {
  /** The short ids the reader knows (the talk's map, or the version's). */
  aliases?: AliasMap;
  /** Checks accepted anyway (by key): not failures. */
  waived?: readonly string[];
  /** Only these checks count (the card's scope); every caused one when absent. */
  inScope?: (c: ResultCheck) => boolean;
  /** Only these spaces' left-out pieces (by key); every space's when absent. */
  spaces?: readonly string[];
}

/** The room a check is about: its own, or its piece's. */
export function checkRoomOf(r: DesignResult, c: { roomId?: string; itemId?: string }) {
  if (c.roomId) return c.roomId;
  const it = c.itemId ? r.level.items[c.itemId] : undefined;
  return it ? roomIdAt(r.level, { x: it.position.x, y: it.position.z }) : null;
}

/**
 * A check's failure signature, principle|code|room|role: the same failure across runs and
 * answers (item ids are new each run). B's progress rule, the free fixes and C's repeats use it.
 */
export function checkSig(r: DesignResult, c: ResultCheck): string {
  const parts = c.key.split('|');
  const it = c.itemId ? r.level.items[c.itemId] : undefined;
  const role = it ? roleOf(furnitureKind(it.assetId)) : (parts[3] ?? '');
  return `${c.principle}|${parts[1] ?? ''}|${checkRoomOf(r, c) ?? ''}|${role}`;
}

/** The roles a programme check's missing piece would have (a bed for "has no bed"). */
const NEEDS: Record<string, Role[]> = {
  bed: ['bed'],
  seats: ['sofa', 'armchair'],
  dining: ['dining-table', 'dining-chair'],
  desks: ['desk'],
};

/** How much a failure matters, first first: nobody left without a bed behind a dining chair. */
function severity(key: string): number {
  const [principle, code] = key.split('|');
  if (principle === 'P1' && code === 'unplaced') return 0;
  if (principle === 'P1' && code === 'bed') return 1;
  if (principle === 'HDB') return 2;
  if (principle === 'P1' && code === 'seats') return 3;
  if (principle === 'P1' && code === 'dining') return 4;
  if (principle === 'P1' && code === 'desks') return 5;
  if (principle === 'P1') return 6;
  if (principle === 'R') return 7;
  if (principle === 'K') return 8;
  if (principle === 'P3') return 9;
  if (principle === 'P4') return 10;
  if (principle === 'P2') return 11;
  return 12;
}

/** The household's names in the app's words: "You have no bed", never "Adult 1 has no bed". */
export function peopleWords(text: string, brief: DesignBrief): string {
  let out = text;
  for (const p of peopleOf(brief)) {
    const label = personLabel(p, brief);
    if (label === p.name) continue;
    out = out.replace(new RegExp(`\\b${p.name}\\b`, 'g'), label);
  }
  return out.replace(/\bYou has\b/g, 'You have').replace(/\bYou is\b/g, 'You are');
}

const andList = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/**
 * Lines about people that differ only in who ("Adult 1 has no bed in Main bedroom.", "Adult 2
 * has …") as one: "Adult 1 and Adult 2 have no bed in Main bedroom." Null when they don't.
 */
function mergePeople(texts: string[]): string | null {
  const parts = texts.map((t) => /^(.+?) (?:has|have) (.*)$/.exec(t));
  const tail = parts[0]?.[2];
  if (!tail || parts.some((m) => !m || m[2] !== tail)) return null;
  return `${andList(parts.map((m) => m?.[1] ?? ''))} have ${tail}`;
}

const VERB_PLURAL: Record<string, string> = {
  'isn’t': 'aren’t',
  is: 'are',
  has: 'have',
  'doesn’t': 'don’t',
  faces: 'face',
  goes: 'go',
  overlaps: 'overlap',
  needs: 'need',
  sits: 'sit',
  blocks: 'block',
  narrows: 'narrow',
};
const pluralNoun = (w: string) =>
  /(s|x|ch|sh)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`;

/**
 * The same line said of n pieces: "The dining chair isn’t at a table." → "4 dining chairs
 * aren’t at a table." A line it can't read that way keeps its words and says how many.
 */
export function manyOf(text: string, n: number): string {
  if (n < 2) return text;
  const words = text.split(' ');
  const at = words.findIndex((w, i) => i > 1 && w in VERB_PLURAL);
  if (words[0] !== 'The' || at < 0) return `${text.replace(/[.\s]+$/, '')} (${n} pieces).`;
  const noun = words.slice(1, at);
  const last = noun.pop() as string;
  const verb = VERB_PLURAL[words[at] as string] as string;
  return [`${n}`, ...noun, pluralNoun(last), verb, ...words.slice(at + 1)].join(' ');
}

const m2 = (v: number) => `${v.toFixed(2)} m`;
const an = (w: string) => (/^[aeiou8]|^11-|^18-/i.test(w) ? `an ${w}` : `a ${w}`);

/** The to-fix hint for a piece left out, for the model (its reason's code says which). */
function hintFor(n: Note, ref: string, assetId: string | null, room: string): string {
  switch (n.code) {
    case 'keep-missing':
      return `${n.keep ?? 'That piece'} isn’t in the plan this design starts from. Place a new ${assetId ? `\`${assetId}\`` : 'piece from the catalogue'} with keep: null, or keep a piece listed in The flat now.`;
    case 'keep-brief':
    case 'keep-in-place':
      return 'The brief says this piece stays where it is (or goes). Don’t place it; place a new one if the room needs it.';
    case 'keep-held':
      return 'That piece stays where it is (in another room, kept by the household, or moved by hand). Don’t keep it here; place a new one if this room needs it.';
    case 'duplicate':
      return `That piece is placed once already. Keep it only once; place a new one for ${ref} if the room needs another.`;
    case 'no-wall':
      if (n.need !== undefined && n.longest !== undefined && n.longest + 0.005 < n.need) {
        return `Needs ${m2(n.need)} of wall; the longest free run in ${room} is ${m2(n.longest)}. Use a smaller piece, another room, or free-standing.`;
      }
      return n.need !== undefined
        ? `Needs ${m2(n.need)} of wall; the walls long enough for it are taken by your other pieces. Put it on the longest wall before them, or leave out a piece the room needs less.`
        : `No wall in ${room} had room for it. Use a smaller piece, another wall, or free-standing.`;
    case 'no-place':
    case 'outside':
      return `It had no spot inside ${room}. Give it \`against\`, or put it in another room.`;
    case 'wet':
    case 'bathroom':
    case 'not-catalogue':
      return 'As the app says; pick from the catalogue.';
    default:
      return `Place ${ref} again, or a smaller piece.`;
  }
}

/** The measured cause for the person (no ids), when the reason has numbers or a plain why. */
function causeFor(n: Note, name: string, room: string): string | null {
  switch (n.code) {
    case 'no-wall':
      if (n.need !== undefined && n.longest !== undefined && n.longest + 0.005 < n.need) {
        return `The ${name} needs ${m2(n.need)} of wall; the longest free wall in ${room} is ${m2(n.longest)}.`;
      }
      return `The walls in ${room} that could take the ${name} are taken by other pieces.`;
    case 'keep-missing':
      return `The designer’s answer used ${an(name)} that isn’t in your plan, so the app left it out.`;
    case 'keep-brief':
    case 'keep-in-place':
    case 'keep-held':
      return `The designer’s answer used a ${name} that stays where it is, so the app left it out here.`;
    case 'no-place':
    case 'outside':
      return `The designer’s answer gave the ${name} no place in ${room}.`;
    default:
      return null;
  }
}

/** The kind's name as said ("queen bed", "4-seat dining table"), for the person. */
const kindName = (assetId: string | null) => {
  const k = assetId ? furnitureKind(assetId) : null;
  return k ? pieceWords(k.name).toLowerCase() : 'piece';
};

/** What `mergeLines` groups: a check's key and words, its room and its cause. */
export interface Mergeable {
  key: string;
  /** The app's words. */
  text: string;
  /** The person's words. */
  says: string;
  roomId: string | null;
  cause?: string | null;
}

/**
 * Failures as the person reads them, one line each, ordered by severity (the run report's lines,
 * and Accept's question): people of one room, one check and one cause together ("You and
 * Partner have no bed in Main bedroom"); the same words on several pieces of one room together
 * ("4 dining chairs aren't at a table").
 */
export function mergeLines<T extends Mergeable>(
  items: readonly T[],
  roomName: (t: T) => string | null = () => null,
): { first: T; g: T[]; says: string; text: string }[] {
  const groups = new Map<string, T[]>();
  const codeOf = (t: T) => t.key.split('|').slice(0, 2).join('|');
  const isPeople = (t: T) => /^P1\|(bed|unplaced)$/.test(codeOf(t));
  for (const t of items) {
    const k = isPeople(t)
      ? `${codeOf(t)}|${t.roomId ?? ''}|${t.cause ?? ''}|${t.says.replace(/^.+? (has|have) /, '')}`
      : `${codeOf(t)}|${t.roomId ?? ''}|${t.says}`;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const merged = [...groups.values()].map((g) => {
    const first = g[0] as T;
    const n = g.length;
    const words = (f: (t: T) => string) =>
      n < 2
        ? f(first)
        : isPeople(first)
          ? (mergePeople(g.map(f)) ?? f(first))
          : manyOf(f(first), n);
    return { first, g, says: words((t) => t.says), text: words((t) => t.text) };
  });
  return merged.sort(
    (p, q) =>
      severity(p.first.key) - severity(q.first.key) ||
      (roomName(p.first) ?? '').localeCompare(roomName(q.first) ?? '') ||
      p.says.localeCompare(q.says) ||
      (p.first.key < q.first.key ? -1 : 1),
  );
}

interface One {
  c: ResultCheck;
  roomId: string | null;
  room: string | null;
  says: string;
  piece: string | null;
  assetId: string | null;
  sig: string;
  code: string;
  cause: string | null;
  causedBy: string | null;
}

export function runReport(
  r: DesignResult,
  input: Pick<DesignInput, 'spaces' | 'brief'>,
  opts: ReportOptions = {},
): RunReport {
  const short = aliasOf(opts.aliases ?? {});
  const waived = new Set(opts.waived ?? []);
  const inScope = opts.inScope ?? (() => true);
  const roomName = (id: string | null) => (id ? (r.level.rooms[id]?.name ?? null) : null);
  const spaceOf = (key: string | undefined) => r.spaces.find((s) => s.key === key);

  // Left out: the answer's pieces, each with its catalogue id from the stored answer.
  const leftOut: ReportLeftOut[] = [];
  for (const n of r.dropped) {
    if (!n.ref) continue;
    if (opts.spaces && (!n.space || !opts.spaces.includes(n.space))) continue;
    const s = spaceOf(n.space);
    const stored = s?.storedKey ? input.spaces[s.storedKey]?.design : undefined;
    const item = stored?.items.find((a) => a.ref === n.ref);
    const assetId = item?.assetId || null;
    const kind = assetId ? furnitureKind(assetId) : null;
    const room = s?.name ?? null;
    const roomRef = s ? (short.get(s.main) ?? s.name) : 'the room';
    const name = kindName(assetId);
    leftOut.push({
      id: `L${leftOut.length + 1}`,
      ref: n.ref,
      assetId,
      space: n.space ?? null,
      room,
      text: n.text,
      code: n.code ?? null,
      hint: hintFor(n, n.ref, assetId, roomRef),
      cause: causeFor(n, name, room ?? 'the room'),
      says: `${kind ? `The ${name}` : 'A piece not in the catalogue'} in ${room ?? 'the room'} was left out`,
      role: roleOf(kind),
      causes: null,
    });
  }

  const rooms: ReportRoom[] = r.spaces.flatMap((s) => {
    const e = s.storedKey ? input.spaces[s.storedKey] : undefined;
    if (!e || (opts.spaces && !opts.spaces.includes(s.key))) return [];
    return [
      {
        key: s.key,
        name: s.name,
        fixes: e.fixes ?? 0,
        fixed: e.fixed ?? 0,
        rounds: e.rounds ?? [],
      },
    ];
  });

  // Failing: caused by the version, in scope, not accepted anyway. (What a set of ticks fails
  // together is the card's own line, not the version's count.)
  const ones: One[] = [];
  for (const c of r.checks.filter((c) => c.hard && !c.already && inScope(c))) {
    if (waived.has(c.key)) continue;
    const roomId = checkRoomOf(r, c);
    const it = c.itemId ? r.level.items[c.itemId] : undefined;
    const ref = c.itemId ? r.refs[c.itemId] : undefined;
    const parts = c.key.split('|');
    const code = parts[1] ?? '';
    // A missing piece's cause: the piece of its kind the app left out in that room's space.
    const need = !it ? NEEDS[code] : undefined;
    const space = roomId ? r.spaces.find((s) => s.rooms.includes(roomId)) : undefined;
    const why = need
      ? leftOut.find((l) => l.space === space?.key && need.includes(l.role) && l.cause)
      : undefined;
    const tries = space ? rooms.find((x) => x.key === space.key) : undefined;
    const answers =
      1 +
      (tries?.rounds.filter((x) => x.outcome === 'fixed' || x.outcome === 'no-better').length ?? 0);
    ones.push({
      c,
      roomId,
      room: roomName(roomId),
      says: peopleWords(c.text, input.brief),
      piece: c.itemId ? (ref ?? short.get(c.itemId) ?? null) : null,
      assetId: it?.assetId ?? null,
      sig: checkSig(r, c),
      code,
      cause:
        why?.cause ??
        (need && answers > 1 ? `The designer’s answers left it out (${answers} tries).` : null),
      causedBy: why?.id ?? null,
    });
  }

  const merged = mergeLines(
    ones.map((o) => ({ ...o, key: o.c.key, text: o.c.text })),
    (o) => o.room,
  );
  const failures = merged.map(({ first, g, says, text }, i): ReportFailure => {
    const id = `F${i + 1}`;
    const l = leftOut.find((x) => x.id === first.causedBy);
    if (l && !l.causes) l.causes = id;
    return {
      id,
      key: first.key,
      keys: g.map((o) => o.key),
      sig: [...new Set(g.map((o) => o.sig))].join(' '),
      text,
      says,
      count: g.length,
      roomId: first.roomId,
      room: first.room,
      pieces: g.flatMap((o) => (o.piece ? [o.piece] : [])),
      assetId: first.assetId,
      waivable: g.every((o) => o.c.waivable),
      unfixable: g.every((o) => !!o.c.unfixable),
      cause: first.cause,
      causedBy: first.causedBy,
    };
  });
  return { failures, leftOut, rooms };
}

// ---------------------------------------------------------------------------- for the model

/** F lines for a model: the room, the pieces (ref or short id, catalogue id) and the app's words. */
export function failureLines(rep: RunReport, aliases: AliasMap = {}): string[] {
  const short = aliasOf(aliases);
  return rep.failures.slice(0, REPORT_MAX).map((f) => {
    const room = f.roomId ? `${f.room ?? 'a room'} (${short.get(f.roomId) ?? f.roomId})` : null;
    const pieces = f.pieces.length
      ? `${f.pieces.join(', ')}${f.assetId ? ` (${f.assetId})` : ''}`
      : null;
    return clean(
      `${f.id} doesn’t pass${room ? ` · ${room}` : ''}${pieces ? ` · ${pieces}` : ''}: ${f.text}`,
      LINE_MAX,
    );
  });
}

/** L lines for a model: the ref, the catalogue id, the reason in the app's words, and the hint. */
export function leftOutLines(rep: RunReport): string[] {
  return rep.leftOut
    .slice(0, REPORT_MAX)
    .map((l) =>
      clean(
        `${l.id} left out · ${l.room ?? 'a room'} · ${l.ref}${l.assetId ? ` (${l.assetId})` : ''}: ${l.text} To fix: ${l.hint}`,
        LINE_MAX,
      ),
    );
}

/**
 * What a plan's `addresses` may name, each in the words the card showed: a left-out piece that
 * causes a counted failure is named by that failure ("You and Partner have no bed …").
 */
export function tableEntries(rep: RunReport): { id: string; sig: string; says: string }[] {
  const byId = new Map(rep.failures.map((f) => [f.id, f]));
  return [
    ...rep.failures.slice(0, REPORT_MAX).map((f) => ({ id: f.id, sig: f.sig, says: f.says })),
    ...rep.leftOut.slice(0, REPORT_MAX).map((l) => {
      // Named by the failure it causes, and fixed only when that failure is gone too.
      const f = l.causes ? byId.get(l.causes) : undefined;
      return {
        id: l.id,
        sig: f ? `${leftSig(l)} ${f.sig}` : leftSig(l),
        says: f?.says || l.says,
      };
    }),
  ];
}

// ---------------------------------------------------------------------------- for the person

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dont = (n: number) => `${n} ${n === 1 ? 'doesn’t' : 'don’t'} pass`;
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** How a version's fix rounds went, in short: what the card's lead and announcement say. */
export interface FixSummary {
  /** Problems the rounds fixed (each room tried alone). */
  fixed: number;
  /** Fix requests sent, and the rooms they were for. */
  sent: number;
  rooms: number;
  cutOff: boolean;
  failed: boolean;
  refused: boolean;
  error: boolean;
  noBetter: boolean;
  /** Rooms kept by a build before rounds were stored: sent back, and nothing fixed. */
  unknown: boolean;
  /** A room still failing was not sent again: the run's fix-ups were used up. */
  usedUp: boolean;
}

export function fixSummary(rooms: readonly ReportRoom[]): FixSummary {
  const f: FixSummary = {
    fixed: 0,
    sent: 0,
    rooms: 0,
    cutOff: false,
    failed: false,
    refused: false,
    error: false,
    noBetter: false,
    unknown: false,
    usedUp: false,
  };
  for (const room of rooms) {
    if (!room.rounds.length) {
      // Kept by a build before rounds were stored: its counts only, and no claim of why.
      f.sent += room.fixes;
      f.fixed += room.fixed;
      if (room.fixes) f.rooms++;
      if (room.fixes && !room.fixed) f.unknown = true;
      continue;
    }
    let sentHere = false;
    for (const x of room.rounds) {
      if (x.outcome === 'no-fixups') {
        f.usedUp = true;
        continue;
      }
      f.sent++;
      sentHere = true;
      if (x.outcome === 'fixed') f.fixed += Math.max(0, x.before - x.after);
      if (x.outcome === 'cut-off') f.cutOff = true;
      if (x.outcome === 'failed') f.failed = true;
      if (x.outcome === 'refused') f.refused = true;
      if (x.outcome === 'error') f.error = true;
      if (x.outcome === 'no-better') f.noBetter = true;
    }
    if (sentHere) f.rooms++;
  }
  return f;
}

/** The fix rounds' sentence: what was sent back, and how it came out (null: none were). */
function fixSentence(f: FixSummary): string | null {
  if (f.fixed > 0) return `Checked and fixed ${plural(f.fixed, 'problem')} before showing you.`;
  if (!f.sent) return null;
  const many = f.rooms > 1;
  const sent = many
    ? `Sent ${f.rooms} rooms back to be fixed`
    : `Sent back to be fixed ${times(f.sent)}`;
  const first = many ? 'the first designs are shown' : 'the first design is shown';
  if (f.cutOff) {
    return many
      ? `${sent}, but the answers were cut off at the length limit and weren’t used.`
      : `${sent}, but the answer was cut off at the length limit and wasn’t used.`;
  }
  if (f.failed) {
    return `${sent}, but no readable answer came, so ${first}.`;
  }
  if (f.refused) return `${sent}, but the model declined, so ${first}.`;
  if (f.error) return `${sent}, but the request didn’t go through, so ${first}.`;
  if (f.noBetter) {
    return many
      ? `${sent}. ${f.rooms === 2 ? 'Neither answer was' : 'None of the answers was'} better, so ${first}.`
      : f.sent > 1
        ? `${sent}. The last answer was no better, so the earlier one is shown.`
        : `${sent}. The answer was no better, so ${first}.`;
  }
  // From a record kept before the rounds were: only that nothing was fixed.
  return `${sent}; nothing was fixed, so ${first}.`;
}

/**
 * The lead's two parts (UX "The lead"): the fix rounds' outcome, then the card's own count.
 * "Fixed n" counts from the rounds; "still don't pass" is the whole version's verdict, so the
 * two never have to add up. Each null when there is nothing to say.
 */
export function leadParts(
  rooms: readonly ReportRoom[],
  failing: number,
): { fix: string | null; count: string | null } {
  const f = fixSummary(rooms);
  const parts: string[] = [];
  const said = fixSentence(f);
  if (said) parts.push(said);
  if (failing > 0 && f.usedUp) {
    parts.push(
      f.sent
        ? `This design used the ${plural(f.sent, 'fix-up')} it was priced for.`
        : 'This design had no fix-ups left to send it back.',
    );
  }
  const still = f.sent > 0 || f.usedUp ? ' still' : '';
  return {
    fix: parts.length ? parts.join(' ') : null,
    count: failing > 0 ? `${failing}${still} ${failing === 1 ? 'doesn’t' : 'don’t'} pass:` : null,
  };
}

/** The lead's headline as one line. Null when there is nothing to say. */
export function leadLine(rooms: readonly ReportRoom[], failing: number): string | null {
  const p = leadParts(rooms, failing);
  const line = [p.fix, p.count].filter(Boolean).join(' ');
  return line || null;
}

/** Each room's rounds, for "How it was checked": "Main bedroom · fix round 1: 3 → 1 problem". */
export function roundLines(rooms: readonly ReportRoom[]): string[] {
  return rooms.flatMap((room) => {
    if (!room.rounds.length) {
      return room.fixes
        ? [
            `${room.name} · ${plural(room.fixes, 'fix round')}: ${room.fixed ? `fixed ${plural(room.fixed, 'problem')}` : 'nothing fixed, not used'}`,
          ]
        : [];
    }
    let k = 0;
    const parts = room.rounds.map((x) => {
      if (x.outcome === 'no-fixups') return 'not sent again: the run’s fix-ups were used up';
      k++;
      switch (x.outcome) {
        case 'fixed':
          return `fix round ${k}: ${x.before} → ${plural(x.after, 'problem')}`;
        case 'no-better':
          return `fix round ${k}: no better, not used`;
        case 'cut-off':
          return `fix round ${k}: cut off at the length limit, not used`;
        case 'refused':
          return `fix round ${k}: the model declined it, not used`;
        case 'error':
          return `fix round ${k}: the request didn’t go through, not used`;
        default:
          return `fix round ${k}: no readable answer, not used`;
      }
    });
    return [`${room.name} · ${parts.join(' · ')}`];
  });
}

/** "You and Partner have no bed in Main bedroom, and 2 more" (the first failure, then the rest). */
export function firstAndMore(rep: RunReport): string {
  const [first, ...rest] = rep.failures;
  if (!first) return '';
  // Its first clause: up to ": " or a sentence's end (never a decimal point: "0.85 m").
  const head = first.says.replace(/: .*$/, '').replace(/\.(\s+[A-Z].*)?$/, '');
  return rest.length ? `${head}, and ${rest.length} more` : head;
}

/** The announcement at a run's end (one, through the polite region), from the one list. */
export function readyLine(title: string, rep: RunReport, cost: string | null): string {
  const n = rep.failures.length;
  const f = fixSummary(rep.rooms);
  const tail = cost ? ` Cost ${cost}.` : '';
  if (!n) {
    return `${title} is ready. Passes all checks${f.fixed ? `; the app fixed ${plural(f.fixed, 'problem')} first` : ''}.${tail}`;
  }
  return `${title} is ready. ${dont(n)}: ${firstAndMore(rep)}.${tail}`;
}

/** The app's line in place of a reply the claims filter emptied: "V8: 3 don't pass. …". */
export function reportLine(title: string, rep: RunReport): string {
  const n = rep.failures.length;
  return n ? `${title}: ${dont(n)}. ${firstAndMore(rep)}.` : `${title}: passes all checks.`;
}

/**
 * The talk call's verdict for "Since your last reply": "2 don't pass, 2 pieces left out", and
 * how many are listed when there are more than On the table sends.
 */
export function verdictWords(rep: RunReport): string {
  const n = rep.failures.length;
  const l = rep.leftOut.length;
  if (!n && !l) return 'passes';
  const listed = (k: number) => (k > REPORT_MAX ? ` (${REPORT_MAX} listed)` : '');
  return [
    n ? `${dont(n)}${listed(n)}` : 'passes',
    ...(l ? [`${plural(l, 'piece')} left out${listed(l)}`] : []),
  ].join(', ');
}

/** A left-out piece across runs: its space and catalogue id (refs are each answer's own). */
export const leftSig = (l: Pick<ReportLeftOut, 'space' | 'assetId' | 'ref'>) =>
  `L|${l.space ?? ''}|${l.assetId ?? l.ref}`;

/**
 * What a design set out to fix (its plan's `addresses`), each checked against its own report:
 * done when no failure (or left-out piece) of the same signature is left.
 */
export function addressedIn(
  addresses: readonly { id: string; sig: string; says: string; change: string }[],
  rep: RunReport,
): { says: string; change: string; done: boolean; left: boolean }[] {
  const failing = new Set(rep.failures.flatMap((f) => f.sig.split(' ')));
  const out = new Set(rep.leftOut.map(leftSig));
  // Each signature it carries: a piece left out (L|…) or a failure's member; done when none is
  // left (a piece left out named by the failure it caused carries both).
  const remains = (sig: string) => (sig.startsWith('L|') ? out.has(sig) : failing.has(sig));
  return addresses.map((a) => ({
    says: a.says,
    change: a.change,
    left: a.id.startsWith('L'),
    done: !a.sig.split(' ').some(remains),
  }));
}
