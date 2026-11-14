import { furnitureKind } from '../furniture';
import type { Level } from '../schema';
import { type Person, type Role, peopleOf, roleOf, seatsOf } from './principles';
import { checkSig } from './report';
import { piecesNoWorse } from './resolve';
import { type DesignOptions, type DesignResult, type ResultCheck, designResult } from './result';
import type { DesignInput, DesignItem, SpaceDesign } from './schema';
import { roomIdAt } from './spaces';
import { personLabel } from './talk/firstMeeting';
import { pieceWords } from './talk/probe';

/**
 * Free fixes (spec docs/specs/designer-listens.md §3, lead decisions "Free fixes: a post-pass on
 * the answer"): when a P1 must-have check fails (someone without a bed, seats under the
 * household's need, no dining table, no desk for someone working from home), the app adds the
 * missing catalogue piece to the answer itself, as an ordinary answer item whose ref starts
 * `app:`, and places the version again with `designResult` (the solver's usual budgets). The
 * new answer is kept only if strictly fewer hard checks fail, no new failure signature appears
 * (house rules, kept pieces and HDB rules included), and no piece is left out, short of room or
 * moved that wasn't before (`piecesNoWorse`; an extra such as a bedside table may make room).
 * At most two tries a space: every missing essential together, then the one that matters most
 * alone (beds first). Pure, and deterministic: it reads only the failing
 * checks, never the brief alone, so it never invents a requirement the checks don't have.
 * `solveSpace` and `designResult` are untouched, so a version where nothing fails is placed
 * exactly as before.
 */

/** The ref prefix of the app's own pieces. A model's ref never has it (`parseSpaceDesign`). */
export const APP_REF = 'app:';
export const isAppRef = (ref: string | null | undefined): boolean =>
  !!ref && ref.startsWith(APP_REF);

/** The checks a free fix answers: P1's must-haves, by code. */
const ORDER = ['bed', 'seats', 'dining', 'desks'];
const ESSENTIAL = new Set(ORDER);

/** A piece the app added, and the check it is for. */
export interface FreeAdd {
  /** The stored answer's key (the space). */
  space: string;
  ref: string;
  assetId: string;
  roomId: string;
  role: Role;
  /** The check key it answers. */
  key: string;
}

/** A missing essential the app couldn't place, in the person's words (with numbers). */
export interface FreeMiss {
  space: string;
  roomId: string;
  key: string;
  assetId: string;
  role: Role;
  text: string;
}

export interface FreeOutcome {
  /** The version's answers with the kept additions (the input's own object when none). */
  spaces: DesignInput['spaces'];
  added: FreeAdd[];
  missed: FreeMiss[];
  /** Placings tried (each a `designResult`). */
  tries: number;
}

export interface FreeOptions {
  /** Only these spaces (by result or stored key); every designed space when absent. */
  spaces?: readonly string[];
  /** Pieces the person left out before (by room and role): never offered again. */
  declined?: readonly { room: string; role: string }[];
}

/** What a free fix is judged by: the version's failing hard checks and its pieces. */
interface Side {
  keys: Set<string>;
  sigs: Set<string>;
  dropped: number;
  soft: number;
  broken: number;
}

/**
 * Extras a room can do without (as the benchmark counts them): a bedside table with no room by
 * a new bed's head, a lamp, a rug. One of these may make room for a missing essential; any other
 * piece left out, moved or narrowed is worse.
 */
const EXTRAS = new Set<Role>(['bedside', 'side-table', 'light', 'decor', 'rug', 'coffee-table']);

function sideOf(r: DesignResult, design: DesignInput): Side {
  const hard = r.checks.filter((c) => c.hard && !c.already);
  const answerItem = (n: { ref?: string; space?: string }) => {
    const s = r.spaces.find((x) => x.key === n.space);
    const items = (s?.storedKey && design.spaces[s.storedKey]?.design?.items) || [];
    return items.find((i) => i.ref === n.ref);
  };
  const counts = (n: { ref?: string; space?: string }) => {
    if (!n.ref) return true;
    const a = answerItem(n);
    // A piece kept by its alias always counts, and so does the app's own.
    if (!a || a.keep || isAppRef(n.ref)) return true;
    return !EXTRAS.has(roleOf(furnitureKind(a.assetId)));
  };
  return {
    keys: new Set(hard.map((c) => c.key)),
    sigs: new Set(hard.map((c) => checkSig(r, c))),
    // Pieces left out that matter (the app's own included: one it can't place is no fix).
    dropped: r.dropped.filter((n) => !!n.ref && counts(n)).length,
    // The answer's own pieces moved, narrowed or turned to fit.
    soft: r.repaired.filter((n) => !isAppRef(n.ref) && counts(n)).length,
    broken: hard.filter((c) => c.principle === 'P2').length,
  };
}

/** Kept only if strictly better and no worse in any way (acceptResolve's rule, by signature). */
export function freeBetter(before: Side, after: Side): boolean {
  return (
    piecesNoWorse(before, after) &&
    [...after.sigs].every((s) => before.sigs.has(s)) &&
    after.keys.size < before.keys.size
  );
}

const BLANK: Omit<DesignItem, 'ref' | 'assetId' | 'why'> = {
  keep: null,
  wall: null,
  along: null,
  at: null,
  rotation: null,
  width: null,
  depth: null,
  height: null,
  against: null,
  faces: null,
  near: null,
  zone: null,
};

const andList = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/** What the household calls a person ("You", "Partner", "Sophie"). */
function labelOf(p: Person, brief: DesignInput['brief']): string {
  return personLabel(p, brief);
}
interface Want {
  item: DesignItem;
  roomId: string;
  key: string;
  role: Role;
}

/** The pieces a failing must-have check needs, as answer items (refs made unique by `ref`). */
function essentialsFor(
  c: ResultCheck,
  r: DesignResult,
  rooms: readonly string[],
  answer: SpaceDesign,
  brief: DesignInput['brief'],
  ref: (stem: string) => string,
): Want[] {
  const roomId = c.roomId as string;
  const parts = c.key.split('|');
  const code = parts[1];
  const people = peopleOf(brief);
  const household = people.filter((p) => p.kind !== 'helper').length;
  const inSpace = Object.values(r.level.items).filter((it) => {
    const id = roomIdAt(r.level, { x: it.position.x, y: it.position.z });
    return !!id && rooms.includes(id);
  });
  const kinds = inSpace.map((it) => ({ it, kind: furnitureKind(it.assetId) }));
  const byRole = (role: Role) => kinds.filter((k) => roleOf(k.kind) === role);
  const refOfRole = (role: Role) =>
    answer.items.find((a) => roleOf(furnitureKind(a.assetId)) === role)?.ref ?? null;
  const tv = refOfRole('tv');
  const make = (assetId: string, stem: string, extra: Partial<DesignItem>, why: string): Want => {
    const item: DesignItem = { ...BLANK, ref: ref(stem), assetId, why, ...extra };
    return { item, roomId, key: c.key, role: roleOf(furnitureKind(assetId)) };
  };
  switch (code) {
    case 'bed': {
      const who = parts[3] ?? '';
      const p = people.find((x) => x.key === who);
      const assetId =
        !p || p.kind === 'adult' || p.kind === 'helper' ? 'bed-super-single' : 'bed-single';
      const name = p ? labelOf(p, brief) : null;
      return [
        make(
          assetId,
          'bed',
          { against: 'wall', zone: 'sleep' },
          name ? `A bed for ${name}: nobody had one.` : 'A bed: the room had none.',
        ),
      ];
    }
    case 'seats': {
      const want = Math.min(household, 3);
      const seats = kinds.reduce(
        (t, k) => t + (k.kind ? seatsOf(k.kind, k.it.scale.x * k.kind.size.w) : 0),
        0,
      );
      const short = want - seats;
      if (short <= 0) return [];
      const why = `Seats for the household: ${want} needed, ${seats} placed.`;
      if (short === 1 && byRole('sofa').length) {
        return [
          make(
            'armchair',
            'chair',
            { against: 'free', zone: 'lounge', faces: tv, near: refOfRole('sofa') },
            why,
          ),
        ];
      }
      return [make('sofa-3', 'sofa', { against: 'wall', zone: 'lounge', faces: tv }, why)];
    }
    case 'dining': {
      const want = Math.min(household, 6);
      const tables = byRole('dining-table');
      const chairs = byRole('dining-chair').length + byRole('stool').length;
      const out: Want[] = [];
      let table = refOfRole('dining-table');
      if (!tables.length) {
        const t = make(
          want > 4 ? 'dining-6' : 'dining-4',
          'table',
          { against: 'free', zone: 'dine' },
          `A dining table for the household of ${household}.`,
        );
        out.push(t);
        table = t.item.ref;
      }
      for (let i = chairs; i < want; i++) {
        out.push(
          make(
            'dining-chair',
            'chair',
            { against: 'free', zone: 'dine', near: table, faces: table },
            'A chair at the dining table.',
          ),
        );
      }
      return out;
    }
    case 'desks': {
      const want = Math.max(1, brief.lifestyle.wfh);
      const desks = byRole('desk').length;
      const out: Want[] = [];
      for (let i = desks; i < want; i++) {
        const d = make(
          'desk',
          'desk',
          { against: 'wall', zone: 'work' },
          'A desk for working from home.',
        );
        out.push(
          d,
          make(
            'desk-chair',
            'dchair',
            { against: 'free', zone: 'work', near: d.item.ref, faces: d.item.ref },
            'A chair at the desk.',
          ),
        );
      }
      return out;
    }
    default:
      return [];
  }
}

/** One queen bed for a couple without one in the same room, in place of two single beds. */
function coupleBeds(wants: Want[], brief: DesignInput['brief']): Want[] {
  const people = peopleOf(brief);
  const out: Want[] = [];
  const done = new Set<Want>();
  for (const w of wants) {
    if (done.has(w) || w.role !== 'bed') continue;
    const adults = wants.filter(
      (x) =>
        x.role === 'bed' &&
        x.roomId === w.roomId &&
        !done.has(x) &&
        people.find((p) => p.key === x.key.split('|')[3])?.kind === 'adult',
    );
    if (adults.length < 2) continue;
    const [a, b] = adults as [Want, Want];
    done.add(a);
    done.add(b);
    const names = [a, b].map((x) => {
      const p = people.find((q) => q.key === x.key.split('|')[3]);
      return p ? labelOf(p, brief) : '';
    });
    out.push({
      ...a,
      item: {
        ...a.item,
        assetId: 'bed-queen',
        why: `A bed for ${andList(names)}: nobody had one.`,
      },
    });
  }
  return [...out, ...wants.filter((w) => !done.has(w))];
}

/** The piece's name as said ("queen bed", "3-seat sofa"). */
export const freeName = (assetId: string): string => {
  const k = furnitureKind(assetId);
  return k ? pieceWords(k.name).toLowerCase() : 'piece';
};

const m2 = (v: number) => `${v.toFixed(2)} m`;
const an = (w: string) => (/^[aeiou8]/i.test(w) ? `an ${w}` : `a ${w}`);

/** Why a piece couldn't be placed, in the person's words, from the try that left it out. */
function missText(
  r: DesignResult,
  was: ReadonlySet<string>,
  w: Want,
  space: string,
  room: string,
): string {
  const name = freeName(w.item.assetId);
  const note = r.dropped.find((n) => n.ref === w.item.ref && n.space === space);
  if (note?.code === 'no-wall' && note.need !== undefined && note.longest !== undefined) {
    return `No ${name} fits in ${room}: the longest free wall is ${m2(note.longest)}, and ${an(name)} needs ${m2(note.need)}.`;
  }
  if (note?.code === 'no-wall') {
    return `No ${name} fits in ${room}: the walls long enough for it are taken by other pieces.`;
  }
  if (note) return `No ${name} fits in ${room}: it had no place clear of the other pieces.`;
  // Placed, but at a cost: how many other checks it would fail, and the first in the app's words.
  const worse = r.checks.filter((c) => c.hard && !c.already && !was.has(c.key));
  const first = worse[0]?.text.replace(/\.$/, '');
  return worse.length
    ? `${an(name)[0]?.toUpperCase()}${an(name).slice(1)} fits in ${room} only with ${worse.length === 1 ? 'another check' : `${worse.length} other checks`} failing (${first ?? ''}), so the app didn’t place one.`
    : `${an(name)[0]?.toUpperCase()}${an(name).slice(1)} in ${room} would leave other pieces out, so the app didn’t place one.`;
}

/**
 * The free fixes for a version on `base`: each designed space whose must-have checks fail gets
 * the missing pieces, kept only when they make it strictly better. Spaces in turn, each from
 * what the spaces before it kept.
 */
export function freeEssentials(
  base: Level,
  before: Level,
  design: DesignInput,
  opts: DesignOptions = {},
  o: FreeOptions = {},
): FreeOutcome {
  let current = design;
  let r = designResult(base, before, current, opts);
  const added: FreeAdd[] = [];
  const missed: FreeMiss[] = [];
  let tries = 0;
  const declined = new Set((o.declined ?? []).map((d) => `${d.room}|${d.role}`));
  for (const s of r.spaces) {
    const key = s.storedKey;
    if (!key || s.status !== 'done') continue;
    if (o.spaces && !o.spaces.includes(s.key) && !o.spaces.includes(key)) continue;
    const answer = current.spaces[key]?.design;
    // Only answers by intent: the solver places the pieces (a first answer by position can't).
    if (!answer || answer.v !== 2) continue;
    const failing = r.checks.filter((c) => {
      const code = c.key.split('|')[1] ?? '';
      return (
        c.hard &&
        !c.already &&
        !c.unfixable &&
        c.principle === 'P1' &&
        ESSENTIAL.has(code) &&
        !!c.roomId &&
        s.rooms.includes(c.roomId)
      );
    });
    if (!failing.length) continue;
    // A role the app already placed for here and couldn't keep isn't added twice.
    const appRoles = new Set(
      answer.items
        .filter((a) => isAppRef(a.ref))
        .map((a) => roleOf(furnitureKind(a.assetId)) as string),
    );
    const used = new Set(answer.items.map((a) => a.ref));
    const ref = (stem: string) => {
      let n = 1;
      let out = `${APP_REF}${stem}`;
      while (used.has(out)) out = `${APP_REF}${stem}${++n}`;
      used.add(out);
      return out;
    };
    const wants = coupleBeds(
      failing.flatMap((c) => essentialsFor(c, r, s.rooms, answer, current.brief, ref)),
      current.brief,
    ).filter((w) => !declined.has(`${w.roomId}|${w.role}`) && !appRoles.has(w.role));
    if (!wants.length) continue;
    // Two tries at most: every missing essential together, then the one that matters most
    // alone (beds, then seats, a dining table, desks) with what goes with it.
    const codeOf = (w: Want) => w.key.split('|')[1] ?? '';
    const first = ORDER.find((c) => wants.some((w) => codeOf(w) === c));
    const alone = wants.filter((w) => codeOf(w) === first);
    const sets = alone.length < wants.length ? [wants, alone] : [wants];
    const was = sideOf(r, current);
    let kept: { wants: Want[]; r: DesignResult; design: DesignInput } | null = null;
    let lastTry: DesignResult | null = null;
    for (const set of sets) {
      const next: DesignInput = {
        ...current,
        spaces: {
          ...current.spaces,
          [key]: {
            ...(current.spaces[key] as DesignInput['spaces'][string]),
            design: { ...answer, items: [...answer.items, ...set.map((w) => w.item)] },
          },
        },
      };
      tries++;
      const rn = designResult(base, before, next, opts);
      lastTry ??= rn;
      if (freeBetter(was, sideOf(rn, next))) {
        kept = { wants: set, r: rn, design: next };
        break;
      }
    }
    const room = (id: string) => r.level.rooms[id]?.name ?? s.name;
    if (kept) {
      current = kept.design;
      r = kept.r;
      for (const w of kept.wants) {
        added.push({
          space: key,
          ref: w.item.ref,
          assetId: w.item.assetId,
          roomId: w.roomId,
          role: w.role,
          key: w.key,
        });
      }
    }
    // What wasn't placed: said with why, from the first try (every piece together).
    for (const w of wants) {
      if (kept?.wants.includes(w)) continue;
      // A chair at the app's own table or desk goes with it: said once, with it.
      if (isAppRef(w.item.near)) continue;
      missed.push({
        space: key,
        roomId: w.roomId,
        key: w.key,
        assetId: w.item.assetId,
        role: w.role,
        text: missText(lastTry ?? r, was.keys, w, key, room(w.roomId)),
      });
    }
  }
  return { spaces: current.spaces, added, missed, tries };
}
