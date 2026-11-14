import { furnitureKind } from '../furniture';
import { type AliasMap, aliasOf } from './aliases';
import { type Role, peopleOf, roleOf } from './principles';
import type { DesignResult, ResultCheck } from './result';
import type { DesignBrief, DesignInput, FixRound } from './schema';
import { roomIdAt } from './spaces';
import { personLabel } from './talk/firstMeeting';
import { clean } from './util';
import type { DropCode, Note } from './walls';

/**
 * A version's run report (spec docs/specs/designer-listens.md §1): built once, deterministically,
 * from its result and its stored fix rounds, and the one source for everything that says how it
 * was checked. The talk call's On the table (F and L lines), a fix round's prompt (L lines), the
 * card's lead, its Checks row, the On the table bar, the folded line and the announcement.
 *
 * F lines are the hard checks the version causes (not already in the plan, not accepted
 * anyway); L lines are the pieces the answer asked for that the app left out, each with a to-fix
 * hint picked by its reason's code. Lines for the model carry the plan's short ids (R2, P7) and
 * the answer's refs; what the person reads never does, and names people as What I know does.
 */

/** At most this many F and L lines go to a model, each at most LINE_MAX characters. */
export const REPORT_MAX = 8;
export const LINE_MAX = 300;

export interface ReportFailure {
  /** F1, F2, … */
  id: string;
  key: string;
  /** principle|code|room|role: the same failure across runs (item ids are new each run). */
  sig: string;
  /** The app's own words. */
  text: string;
  /** The same, as the person reads it (their names, never "Adult 1"). */
  says: string;
  roomId: string | null;
  room: string | null;
  /** The piece: the answer's ref for a piece it placed, else its short id (a kept or plan piece). */
  piece: string | null;
  assetId: string | null;
  waivable: boolean;
  unfixable: boolean;
  /** Why, for the person: a measured cause (from a piece left out), or how often it was tried. */
  cause: string | null;
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
  /** Checks the ticked changes fail together, counted too (the card's subset). */
  extra?: readonly ResultCheck[];
  /** Only these spaces' left-out pieces (by key); every space's when absent. */
  spaces?: readonly string[];
}

/** The room a check is about: its own, or its piece's. */
export function checkRoomOf(r: DesignResult, c: { roomId?: string; itemId?: string }) {
  if (c.roomId) return c.roomId;
  const it = c.itemId ? r.level.items[c.itemId] : undefined;
  return it ? roomIdAt(r.level, { x: it.position.x, y: it.position.z }) : null;
}

const isUnplaced = (c: ResultCheck) => c.key.startsWith('P1|unplaced');

/** The roles a programme check's missing piece would have (a bed for "has no bed"). */
const NEEDS: Record<string, Role[]> = {
  bed: ['bed'],
  seats: ['sofa', 'armchair'],
  dining: ['dining-table', 'dining-chair'],
  desks: ['desk'],
};

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

const m2 = (v: number) => `${v.toFixed(2)} m`;

/** The to-fix hint for a piece left out, for the model (its reason's code says which). */
function hintFor(n: Note, ref: string, assetId: string | null, room: string): string {
  switch (n.code) {
    case 'keep-missing':
      return `${n.text.match(/“([^”]+)” in the flat/)?.[1] ?? 'That piece'} isn’t in the plan this design starts from. Place a new ${assetId ? `\`${assetId}\`` : 'piece from the catalogue'} with keep: null, or keep a piece listed in The flat now.`;
    case 'keep-brief':
    case 'keep-in-place':
      return 'The brief says this piece stays where it is (or goes). Don’t place it; place a new one if the room needs it.';
    case 'no-wall':
      if (n.need !== undefined && n.longest !== undefined && n.longest + 0.005 < n.need) {
        return `Needs ${m2(n.need)} of wall; the longest free run in ${room} is ${m2(n.longest)}. Use a smaller piece, another room, or free-standing.`;
      }
      return n.need !== undefined
        ? `Needs ${m2(n.need)} of wall; the walls long enough went to other pieces. Give it the longest wall first, or leave out a piece the room needs less.`
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
      return `The walls in ${room} long enough for the ${name} went to other pieces.`;
    case 'keep-missing':
      return `The designer kept a ${name} that isn’t in your plan, so it was left out.`;
    case 'keep-brief':
    case 'keep-in-place':
      return `Your ${name} stays as the brief says, so the designer’s was left out.`;
    case 'no-place':
    case 'outside':
      return `The designer’s answer gave the ${name} no place in ${room}.`;
    default:
      return null;
  }
}

/** The kind's own name ("queen bed"), lower case, for the person. */
const kindName = (assetId: string | null) => {
  const k = assetId ? furnitureKind(assetId) : null;
  return k ? k.name.toLowerCase() : 'piece';
};

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
      says: `${assetId && furnitureKind(assetId) ? `The ${name}` : 'A piece not in the catalogue'} in ${room ?? 'the room'} was left out`,
      role: roleOf(assetId ? furnitureKind(assetId) : null),
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

  // Failing: caused, not waived, in scope; and what the ticked changes fail together.
  const seen = new Set<string>();
  const checks: ResultCheck[] = [];
  for (const c of [
    ...r.checks.filter((c) => c.hard && !c.already && inScope(c)),
    ...(opts.extra ?? []),
  ]) {
    if (waived.has(c.key) || seen.has(c.key)) continue;
    seen.add(c.key);
    checks.push(c);
  }
  checks.sort(
    (p, q) =>
      Number(isUnplaced(q)) - Number(isUnplaced(p)) ||
      (roomName(checkRoomOf(r, p)) ?? '').localeCompare(roomName(checkRoomOf(r, q)) ?? '') ||
      p.text.localeCompare(q.text) ||
      (p.key < q.key ? -1 : 1),
  );
  const failures = checks.map((c, i): ReportFailure => {
    const roomId = checkRoomOf(r, c);
    const it = c.itemId ? r.level.items[c.itemId] : undefined;
    const ref = c.itemId ? r.refs[c.itemId] : undefined;
    const piece = c.itemId ? (ref ?? short.get(c.itemId) ?? null) : null;
    const parts = c.key.split('|');
    const code = parts[1] ?? '';
    const role = it ? roleOf(furnitureKind(it.assetId)) : (parts[3] ?? '');
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
    return {
      id: `F${i + 1}`,
      key: c.key,
      sig: `${c.principle}|${code}|${roomId ?? ''}|${role}`,
      text: c.text,
      says: peopleWords(c.text, input.brief),
      roomId,
      room: roomName(roomId),
      piece,
      assetId: it?.assetId ?? null,
      waivable: c.waivable,
      unfixable: !!c.unfixable,
      cause:
        why?.cause ??
        (need && answers > 1 ? `The designer’s answers left it out (${answers} tries).` : null),
    };
  });
  return { failures, leftOut, rooms };
}

// ---------------------------------------------------------------------------- for the model

/** F lines for a model: the room, the piece (ref or short id, catalogue id) and the app's words. */
export function failureLines(rep: RunReport, aliases: AliasMap = {}): string[] {
  const short = aliasOf(aliases);
  return rep.failures.slice(0, REPORT_MAX).map((f) => {
    const room = f.roomId ? `${f.room ?? 'a room'} (${short.get(f.roomId) ?? f.roomId})` : null;
    const piece = f.piece ? `${f.piece}${f.assetId ? ` (${f.assetId})` : ''}` : null;
    return clean(
      `${f.id} doesn’t pass${room ? ` · ${room}` : ''}${piece ? ` · ${piece}` : ''}: ${f.text}`,
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

// ---------------------------------------------------------------------------- for the person

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dont = (n: number) => `${n} ${n === 1 ? 'doesn’t' : 'don’t'} pass`;

/** How a version's fix rounds went, in short: what the card's lead and announcement say. */
export interface FixSummary {
  /** Problems the rounds fixed (each room tried alone). */
  fixed: number;
  /** Fix requests sent. */
  sent: number;
  cutOff: boolean;
  failed: boolean;
  noBetter: boolean;
  /** A room still failing was not sent again: the run's fix-ups were used up. */
  usedUp: boolean;
}

export function fixSummary(rooms: readonly ReportRoom[]): FixSummary {
  let fixed = 0;
  let sent = 0;
  let cutOff = false;
  let failed = false;
  let noBetter = false;
  let usedUp = false;
  for (const room of rooms) {
    if (!room.rounds.length) {
      // Kept by a build before rounds were stored: its counts only.
      sent += room.fixes;
      fixed += room.fixed;
      if (room.fixes && !room.fixed) noBetter = true;
      continue;
    }
    for (const x of room.rounds) {
      if (x.outcome === 'no-fixups') usedUp = true;
      else sent++;
      if (x.outcome === 'fixed') fixed += Math.max(0, x.before - x.after);
      if (x.outcome === 'cut-off') cutOff = true;
      if (x.outcome === 'failed') failed = true;
      if (x.outcome === 'no-better') noBetter = true;
    }
  }
  return { fixed, sent, cutOff, failed, noBetter, usedUp };
}

/**
 * The lead's headline (UX "The lead"): the fix rounds' outcome, then the card's own count.
 * "Fixed n" counts from the rounds; "still don't pass" is the whole version's verdict, so the
 * two never have to add up. Null when there is nothing to say (no rounds, nothing failing).
 */
export function leadLine(rooms: readonly ReportRoom[], failing: number): string | null {
  const f = fixSummary(rooms);
  const parts: string[] = [];
  if (f.fixed > 0)
    parts.push(`Checked and fixed ${plural(f.fixed, 'problem')} before showing you.`);
  else if (f.cutOff) {
    parts.push(
      'Sent back to be fixed, but the answer was cut off at the length limit and wasn’t used.',
    );
  } else if (f.failed) {
    parts.push('Sent back to be fixed, but no readable answer came, so it wasn’t used.');
  } else if (f.noBetter) {
    parts.push(
      f.sent > 1
        ? `Sent back to be fixed ${f.sent} times. The last answer was no better, so the earlier one is shown.`
        : 'Sent back to be fixed once. The answer was no better, so the first one is shown.',
    );
  }
  if (failing > 0) {
    if (f.usedUp) {
      parts.push(
        f.sent
          ? `This design used the ${plural(f.sent, 'fix-up')} it was priced for.`
          : 'This design had no fix-ups left to send it back.',
      );
    }
    const still = f.sent > 0 || f.usedUp ? ' still' : '';
    parts.push(`${failing}${still} ${failing === 1 ? 'doesn’t' : 'don’t'} pass:`);
  }
  return parts.length ? parts.join(' ') : null;
}

/** Each room's rounds, for "How it was checked": "Main bedroom · fix round 1: 3 → 1 problem". */
export function roundLines(rooms: readonly ReportRoom[]): string[] {
  return rooms.flatMap((room) => {
    if (!room.rounds.length) {
      return room.fixes
        ? [
            `${room.name} · ${plural(room.fixes, 'fix round')}: ${room.fixed ? `fixed ${plural(room.fixed, 'problem')}` : 'no better, not used'}`,
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
          return `fix round ${k}: no better (${x.before} → ${x.after}), not used`;
        case 'cut-off':
          return `fix round ${k}: cut off at the length limit, not used`;
        default:
          return `fix round ${k}: no readable answer, not used`;
      }
    });
    return [`${room.name} · ${parts.join(' · ')}`];
  });
}

/** "You have no bed in Main bedroom, and 2 more" (the first failure, then how many more). */
export function firstAndMore(rep: RunReport): string {
  const [first, ...rest] = rep.failures;
  if (!first) return '';
  const head = first.says.replace(/[.:].*$/, '');
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

/** The talk call's verdict for "Since your last reply": "designed; 2 don't pass, 2 pieces left out". */
export function verdictWords(rep: RunReport): string {
  const n = rep.failures.length;
  const l = rep.leftOut.length;
  if (!n && !l) return 'passes';
  return [n ? dont(n) : 'passes', ...(l ? [`${plural(l, 'piece')} left out`] : [])].join(', ');
}

/** A left-out piece across runs: its space and role (refs are the answer's own). */
export const leftSig = (l: Pick<ReportLeftOut, 'space' | 'role' | 'ref'>) =>
  `L|${l.space ?? ''}|${l.role === 'other' ? l.ref : l.role}`;

/**
 * What a design set out to fix (its plan's `addresses`), each checked against its own report:
 * done when no failure (or left-out piece) of the same signature is left.
 */
export function addressedIn(
  addresses: readonly { id: string; sig: string; says: string; change: string }[],
  rep: RunReport,
): { says: string; change: string; done: boolean }[] {
  return addresses.map((a) => ({
    says: a.says,
    change: a.change,
    done: a.id.startsWith('L')
      ? !rep.leftOut.some((l) => leftSig(l) === a.sig)
      : !rep.failures.some((f) => f.sig === a.sig),
  }));
}
